'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { execSync } = require('node:child_process');
const { createEnv, bootEnv, ROOT } = require('./sim');

test('setup creates all tabs', () => {
  const env = createEnv();
  env.run('setupBoard');
  ['Tasks', 'Initiatives', 'Projects', 'Users', 'Comments', 'ActivityLog', 'Notifications', 'Settings'].forEach((n) => assert.ok(env.sheet(n), n + ' missing'));
});

test('setup can run twice without duplicating settings or admins', () => {
  const env = createEnv();
  env.run('setupBoard');
  const n = env.sheet('Settings').length, u = env.sheet('Users').length;
  env.run('setupBoard');
  assert.strictEqual(env.sheet('Settings').length, n);
  assert.strictEqual(env.sheet('Users').length, u);
});

test('no Justlife text remains', () => {
  let out = '';
  try { out = execSync('grep -rIil justlife --exclude-dir=docs --exclude-dir=.git --exclude-dir=.superpowers --exclude-dir=tests . || true', { cwd: ROOT }).toString().trim(); } catch (e) { out = String(e); }
  assert.strictEqual(out, '');
});

/* ---------- Task 2: stages and roles ---------- */

test('Completed stage sets status, progress and completed date', () => {
  const { env, adminToken } = bootEnv();
  const r = env.call('saveTask', { patch: { Title: 'Finish audit', Stage: 'Completed' } }, adminToken);
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.strictEqual(r.data.task.Status, 'Completed');
  assert.strictEqual(r.data.task.Progress, 100);
  assert.match(r.data.task.CompletedDate, /^\d{4}-\d{2}-\d{2}$/);
});

test('Live stage is rejected', () => {
  const { env, adminToken } = bootEnv();
  const r = env.call('saveTask', { patch: { Title: 'Old stage task', Stage: 'Live' } }, adminToken);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'VALIDATION');
});

test('setup migrates legacy stages and roles', () => {
  const { env, adminToken } = bootEnv();
  const a = env.call('saveTask', { patch: { Title: 'Legacy live task', Stage: 'Build' } }, adminToken).data.task.TaskID;
  const b = env.call('saveTask', { patch: { Title: 'Legacy done task', Stage: 'Build' } }, adminToken).data.task.TaskID;
  const i = env.call('saveInitiative', { patch: { Name: 'Legacy initiative', Owner: 'admin@sidra.local' } }, adminToken).data.initiative.InitiativeID;
  env.call('saveUser', { email: 'old@x.com', password: 'MemberPass1', patch: { Name: 'Old', Role: 'Member' } }, adminToken);
  env.setCell('Tasks', 'TaskID', a, 'Stage', 'Live');
  env.setCell('Tasks', 'TaskID', b, 'Stage', 'Done');
  env.setCell('Initiatives', 'InitiativeID', i, 'Stage', 'Live');
  env.setCell('Users', 'Email', 'old@x.com', 'Role', 'Manager');
  env.run('setupBoard');
  const tasks = env.sheet('Tasks');
  assert.strictEqual(tasks.find((t) => t.TaskID === a).Stage, 'Completed');
  assert.strictEqual(tasks.find((t) => t.TaskID === a).Status, 'Completed');
  assert.strictEqual(tasks.find((t) => t.TaskID === b).Stage, 'Completed');
  assert.strictEqual(env.sheet('Initiatives').find((x) => x.InitiativeID === i).Stage, 'Completed');
  assert.strictEqual(env.sheet('Users').find((x) => x.Email === 'old@x.com').Role, 'Member');
});

test('roles are Admin and Member only', () => {
  const { env, adminToken } = bootEnv();
  const r = env.call('saveUser', { email: 'm@x.com', password: 'MemberPass1', patch: { Name: 'M', Role: 'Manager' } }, adminToken);
  assert.strictEqual(r.ok, false);
});
