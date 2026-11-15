'use strict';
// Regression tests for the findings of the final review.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createEnv, bootEnv, ROOT } = require('./sim');

test('a member who owns a project cannot link it to an initiative they cannot see', () => {
  const b = bootEnv(); const env = b.env, A = b.adminToken;
  const m = b.addMember('m1@x.com', 'Mona One');
  const hidden = env.call('saveInitiative', { patch: { Name: 'Hidden initiative', Owner: 'admin@sidra.local' } }, A).data.initiative.InitiativeID;
  const prj = env.call('saveProject', { patch: { Name: 'Mona project', Owner: 'm1@x.com' } }, A).data.project;
  const r = env.call('saveProject', { id: prj.ProjectID, version: prj.Version, patch: { InitiativeID: hidden } }, m);
  assert.strictEqual(r.ok, false);
  env.call('saveTask', { patch: { Title: 'Task in my project', ProjectID: prj.ProjectID } }, m);
  assert.ok(JSON.stringify(env.call('bootstrap', {}, m)).indexOf('Hidden initiative') < 0);
});

test('admin renaming their own email from the members table keeps the session', () => {
  const b = bootEnv(); const env = b.env, A = b.adminToken;
  const r = env.call('renameUser', { oldEmail: 'admin@sidra.local', newEmail: 'boss@sidra.com' }, A);
  assert.ok(r.ok, JSON.stringify(r.error));
  const s = env.call('saveUser', { email: 'boss@sidra.com', patch: { Title: 'Director' } }, A);
  assert.ok(s.ok, JSON.stringify(s.error));
  assert.strictEqual(env.call('bootstrap', {}, A).data.me.email, 'boss@sidra.com');
});

test('a sheet from the old board with an admin but no password still gets a usable admin', () => {
  const env = createEnv();
  env.run('setupBoard');
  ['PasswordHash', 'PasswordSalt'].forEach((c) => env.setCell('Users', 'Email', 'admin@sidra.local', c, ''));
  env.setCell('Users', 'Email', 'admin@sidra.local', 'Email', 'old.admin@company.com');
  const report = env.run('setupBoard');
  const m = /administrator (\S+) .*temporary password:\s*(\S+)/i.exec(report);
  assert.ok(m, 'no temporary password in: ' + report);
  assert.strictEqual(m[1], 'old.admin@company.com');
  assert.ok(env.call('login', { email: m[1], password: m[2] }).ok);
  assert.strictEqual(env.sheet('Users').length, 1);
});

test('members without a password are reported by setup', () => {
  const b = bootEnv();
  b.addMember('m1@x.com', 'Mona One');
  b.env.setCell('Users', 'Email', 'm1@x.com', 'PasswordHash', '');
  assert.match(b.env.run('setupBoard'), /1 user\(s\) have no password/);
});

test('sample data loads on a deployment where the script owner is not a board user', () => {
  const b = bootEnv();
  b.env.eval("Session.getEffectiveUser = function () { return { getEmail: function () { return 'owner@gmail.com'; } }; }");
  const out = b.env.run('loadSampleData');
  assert.match(String(out), /sample data/i);
  assert.ok(b.env.sheet('Tasks').length > 0);
});

test('the website has a project and an initiative field on the task form, and no old-board leftovers', () => {
  const js = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  assert.match(js, /name: 'ProjectID'/);
  assert.match(js, /name: 'InitiativeID'/);
  ['Nitish', 'Nazar', 'Mediclinic', 'Yana', 'Viewers cannot', 'Team Weekly', 'Live / Build'].forEach((w) => assert.ok(js.indexOf(w) < 0, 'leftover: ' + w));
});
