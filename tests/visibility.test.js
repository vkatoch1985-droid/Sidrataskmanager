'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { bootEnv } = require('./sim');

function world() {
  const b = bootEnv();
  const env = b.env, A = b.adminToken;
  const m1 = b.addMember('m1@x.com', 'Mona One', '971500000011');
  const m2 = b.addMember('m2@x.com', 'Mark Two', '971500000022');
  const ini = env.call('saveInitiative', { patch: { Name: 'Secret initiative', Owner: 'admin@sidra.local' } }, A).data.initiative.InitiativeID;
  const ini2 = env.call('saveInitiative', { patch: { Name: 'Shared initiative', Owner: 'admin@sidra.local' } }, A).data.initiative.InitiativeID;
  const prj = env.call('saveProject', { patch: { Name: 'Secret project', Owner: 'admin@sidra.local', InitiativeID: ini } }, A).data.project.ProjectID;
  const mk = (patch) => { const r = env.call('saveTask', { patch }, A); if (!r.ok) throw new Error(JSON.stringify(r.error)); return r.data.task; };
  const t1 = mk({ Title: 'Assigned to m1', AssignedTo: 'm1@x.com', InitiativeID: ini2 });
  const t2 = mk({ Title: 'M1 collaborates', AssignedTo: 'm2@x.com', Collaborators: 'm1@x.com' });
  const t3 = mk({ Title: 'M1 owns a subtask', AssignedTo: 'm2@x.com', Subtasks: '[ ] Call clinic | m1@x.com\n[ ] Other bit | m2@x.com' });
  const t4 = mk({ Title: 'Unrelated secret', AssignedTo: 'm2@x.com', InitiativeID: ini, ProjectID: prj });
  env.call('addComment', { taskId: t4.TaskID, body: 'Top secret comment' }, A);
  return { b, env, A, m1, m2, t1, t2, t3, t4, ini, ini2, prj };
}

test('member bootstrap contains only their tasks', () => {
  const w = world();
  const d = w.env.call('bootstrap', {}, w.m1).data;
  assert.deepStrictEqual(d.tasks.map((t) => t.TaskID).sort(), [w.t1.TaskID, w.t2.TaskID, w.t3.TaskID].sort());
});

test('nothing about a hidden task leaks through bootstrap side lists', () => {
  const w = world();
  const d = w.env.call('bootstrap', {}, w.m1).data;
  const txt = JSON.stringify(d);
  assert.ok(txt.indexOf(w.t4.TaskID) < 0, 'hidden task id leaked');
  assert.ok(txt.indexOf('Unrelated secret') < 0);
  assert.ok(txt.indexOf('Top secret comment') < 0);
  assert.ok(txt.indexOf('Secret initiative') < 0);
  assert.ok(txt.indexOf('Secret project') < 0);
  assert.ok(d.initiatives.some((i) => i.InitiativeID === w.ini2));
});

test('member gets NOT_FOUND on a hidden task for read, comment, edit and activity', () => {
  const w = world();
  const id = w.t4.TaskID;
  assert.strictEqual(w.env.call('getTask', { id }, w.m1).error.code, 'NOT_FOUND');
  assert.strictEqual(w.env.call('addComment', { taskId: id, body: 'hi' }, w.m1).error.code, 'NOT_FOUND');
  assert.strictEqual(w.env.call('saveTask', { id, patch: { Title: 'Hacked title' } }, w.m1).error.code, 'NOT_FOUND');
  assert.strictEqual(w.env.call('duplicateTask', { id }, w.m1).error.code, 'NOT_FOUND');
  assert.strictEqual(w.env.call('archiveTask', { id }, w.m1).error.code, 'NOT_FOUND');
  const act = w.env.call('getActivity', { entityId: id }, w.m1);
  assert.ok(!act.ok || act.data.activity.length === 0);
  const all = w.env.call('getActivity', {}, w.m1);
  assert.ok(JSON.stringify(all).indexOf(id) < 0);
});

test('member cannot edit or resolve comments on a hidden task', () => {
  const w = world();
  const cid = w.env.sheet('Comments')[0].CommentID;
  assert.strictEqual(w.env.call('editComment', { id: cid, body: 'x' }, w.m1).ok, false);
  assert.strictEqual(w.env.call('deleteComment', { id: cid }, w.m1).ok, false);
});

test('member can open a visible task and tick their own subtask', () => {
  const w = world();
  assert.ok(w.env.call('getTask', { id: w.t3.TaskID }, w.m1).ok);
  const r = w.env.call('saveTask', { id: w.t3.TaskID, patch: { Subtasks: '[x] Call clinic | m1@x.com\n[ ] Other bit | m2@x.com' } }, w.m1);
  assert.ok(r.ok, JSON.stringify(r.error));
  const bad = w.env.call('saveTask', { id: w.t3.TaskID, patch: { Subtasks: '[x] Call clinic | m1@x.com\n[x] Other bit | m2@x.com' } }, w.m1);
  assert.strictEqual(bad.ok, false);
});

test('member cannot make themselves see a task by linking a dependency', () => {
  const w = world();
  const r = w.env.call('saveTask', { id: w.t1.TaskID, patch: { DependsOn: w.t4.TaskID } }, w.m1);
  assert.strictEqual(r.ok, false);
  const d = w.env.call('getTask', { id: w.t1.TaskID }, w.m1).data;
  assert.ok(JSON.stringify(d).indexOf('Unrelated secret') < 0);
});

test('members see names but not mobile numbers or login details of others', () => {
  const w = world();
  const d = w.env.call('bootstrap', {}, w.m1).data;
  assert.ok(d.users.some((u) => u.Email === 'm2@x.com' && u.Name === 'Mark Two'));
  d.users.filter((u) => u.Email !== 'm1@x.com').forEach((u) => { assert.ok(!u.Mobile, 'mobile leaked'); assert.ok(!('LastLogin' in u) || !u.LastLogin); });
  assert.ok(JSON.stringify(d).indexOf('971500000022') < 0);
  assert.deepStrictEqual(d.presence, {});
});

test('admin sees everything including mobiles', () => {
  const w = world();
  const d = w.env.call('bootstrap', {}, w.A).data;
  assert.strictEqual(d.tasks.length, 4);
  assert.strictEqual(d.users.find((u) => u.Email === 'm2@x.com').Mobile, '971500000022');
});

test('member notifications are their own only', () => {
  const w = world();
  const d = w.env.call('bootstrap', {}, w.m1).data;
  assert.ok(d.notifications.length > 0);
  const d2 = w.env.call('bootstrap', {}, w.m2).data;
  assert.ok(d2.notifications.every((n) => JSON.stringify(n).indexOf('Assigned to m1') < 0));
});

test('members cannot import, delete tasks or create initiatives and projects', () => {
  const w = world();
  assert.strictEqual(w.env.call('importTasks', { rows: [{ Title: 'Imported one' }] }, w.m1).error.code, 'FORBIDDEN');
  assert.strictEqual(w.env.call('deleteTask', { id: w.t1.TaskID }, w.m1).error.code, 'FORBIDDEN');
  assert.strictEqual(w.env.call('saveInitiative', { patch: { Name: 'Mine', Owner: 'm1@x.com' } }, w.m1).error.code, 'FORBIDDEN');
  assert.strictEqual(w.env.call('saveProject', { patch: { Name: 'Mine', Owner: 'm1@x.com' } }, w.m1).error.code, 'FORBIDDEN');
});

test('member can create a task and then sees it', () => {
  const w = world();
  const r = w.env.call('saveTask', { patch: { Title: 'My own new task' } }, w.m1);
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.ok(w.env.call('bootstrap', {}, w.m1).data.tasks.some((t) => t.TaskID === r.data.task.TaskID));
  assert.ok(!w.env.call('bootstrap', {}, w.m2).data.tasks.some((t) => t.TaskID === r.data.task.TaskID));
});

test('member cannot attach a task to an initiative they cannot see', () => {
  const w = world();
  const r = w.env.call('saveTask', { patch: { Title: 'Sneaky link task', InitiativeID: w.ini } }, w.m1);
  assert.strictEqual(r.ok, false);
});
