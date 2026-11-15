'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { bootEnv } = require('./sim');

function world() {
  const b = bootEnv();
  const env = b.env, A = b.adminToken;
  env.call('saveSettings', { values: { WA_ENABLED: 'TRUE', WA_PROVIDER: 'meta', WA_PHONE_ID: '1111', WA_BUSINESS_ID: '2222', WA_API_KEY: 'abcd1234wxyz', BOARD_URL: 'https://board.example/' } }, A);
  env.call('updateMyAccount', { mobile: '971509999999', currentPassword: 'AdminPass1' }, A);
  const m1 = b.addMember('m1@x.com', 'Mona One', '971500000011');
  const m2 = b.addMember('m2@x.com', 'Mark Two', '971500000022');
  env.setFetchHandler(() => ({ code: 200, body: '{"messages":[{"id":"wamid.x"}]}' }));
  const today = env.run('today_');
  const d = (n) => env.run('addDays_', today, n);
  const prj = env.call('saveProject', { patch: { Name: 'Clinic launch', Owner: 'admin@sidra.local', Status: 'Active' } }, A).data.project.ProjectID;
  const mk = (patch) => { const r = env.call('saveTask', { patch }, A); if (!r.ok) throw new Error(JSON.stringify(r.error)); return r.data.task; };
  const t = {
    overdue: mk({ Title: 'Overdue build task', AssignedTo: 'm1@x.com', Stage: 'Build', StartDate: d(-9), DueDate: d(-3), ProjectID: prj }),
    notStarted: mk({ Title: 'Not started soon', AssignedTo: 'm1@x.com', Stage: 'Under Design', DueDate: d(1), ProjectID: prj }),
    dueSoon: mk({ Title: 'Building due soon', AssignedTo: 'm1@x.com', Stage: 'Build', DueDate: d(1) }),
    parked: mk({ Title: 'Parked overdue', AssignedTo: 'm1@x.com', Stage: 'Parked', StartDate: d(-9), DueDate: d(-5) }),
    done: mk({ Title: 'Completed thing', AssignedTo: 'm1@x.com', Stage: 'Completed', DueDate: d(1) }),
    far: mk({ Title: 'Far away task', AssignedTo: 'm2@x.com', Stage: 'Under Design', DueDate: d(30) })
  };
  env.mail.length = 0; env.fetches.length = 0;
  const logFrom = env.sheet('MessageLog').length;
  const log = () => env.sheet('MessageLog').slice(logFrom);
  return { b, env, A, m1, m2, t, d, today, log, prj };
}

test('member reminders: one message per member listing open due tasks only', () => {
  const w = world();
  w.env.run('runMemberReminders');
  const rows = w.log().filter((x) => x.Kind === 'reminder');
  assert.deepStrictEqual(rows.map((x) => x.Recipient + ':' + x.Channel).sort(), ['m1@x.com:email', 'm1@x.com:whatsapp']);
  assert.strictEqual(w.env.mail.length, 1);
  const html = w.env.mail[0].htmlBody;
  assert.ok(html.indexOf('Overdue build task') >= 0);
  assert.ok(html.indexOf('Not started soon') >= 0);
  assert.ok(html.indexOf('Building due soon') >= 0);
  assert.ok(html.indexOf('Parked overdue') < 0);
  assert.ok(html.indexOf('Completed thing') < 0);
  const body = JSON.parse(w.env.fetches[0].opts.payload);
  assert.strictEqual(body.template.name, 'task_reminder');
  assert.strictEqual(body.to, '971500000011');
});

test('reminders run twice in one day send only once', () => {
  const w = world();
  w.env.run('runMemberReminders');
  const n = w.log().length;
  w.env.run('runMemberReminders');
  assert.strictEqual(w.log().length, n);
  w.env.advance(24 * 3600 * 1000);
  w.env.run('runMemberReminders');
  assert.ok(w.log().length > n);
});

test('reminders can be switched off', () => {
  const w = world();
  w.env.call('saveSettings', { values: { REMINDERS_ENABLED: 'FALSE' } }, w.A);
  w.env.run('runMemberReminders');
  assert.strictEqual(w.log().length, 0);
});

test('subtask owners are reminded about their open subtask', () => {
  const w = world();
  w.env.call('saveTask', { patch: { Title: 'Shared visit', AssignedTo: 'm1@x.com', Stage: 'Build', DueDate: w.d(0), Subtasks: '[ ] Bring kit | m2@x.com' } }, w.A);
  w.env.mail.length = 0;
  w.env.run('runMemberReminders');
  const m = w.env.mail.find((x) => x.to === 'm2@x.com');
  assert.ok(m, 'm2 not reminded');
  assert.ok(m.htmlBody.indexOf('Shared visit') >= 0);
});

test('report totals match the data', () => {
  const w = world();
  const r = w.env.run('buildReport_', 'daily', w.today, w.today);
  assert.strictEqual(r.totals.total, 6);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.totals.byStage)), { 'Under Design': 2, Build: 2, Parked: 1, Completed: 1 });
  assert.strictEqual(r.totals.completed, 1);
  assert.strictEqual(r.totals.overdue, 1);
  assert.strictEqual(r.totals.notStarted, 2);
  assert.strictEqual(r.totals.dueNext7, 2);
  const m1 = r.members.find((x) => x.email === 'm1@x.com');
  assert.deepStrictEqual([m1.open, m1.overdue, m1.completed], [4, 1, 1]);
  const p = r.projects.find((x) => x.id === w.prj);
  assert.deepStrictEqual([p.open, p.overdue, p.total], [2, 1, 2]);
  assert.ok(r.html.indexOf('Mona One') > 0);
  assert.ok(r.text.length > 20 && r.text.length < 900);
});

test('send report now: admin gets one email and one WhatsApp, logged as manual', () => {
  const w = world();
  const r = w.env.call('sendReportNow', { period: 'daily' }, w.A);
  assert.ok(r.ok, JSON.stringify(r.error));
  const rows = w.log().filter((x) => x.Kind === 'manual');
  assert.deepStrictEqual(rows.map((x) => x.Channel).sort(), ['email', 'whatsapp']);
  assert.strictEqual(JSON.parse(w.env.fetches[0].opts.payload).to, '971509999999');
  assert.strictEqual(JSON.parse(w.env.fetches[0].opts.payload).template.name, 'admin_report');
  assert.strictEqual(w.env.call('sendReportNow', { period: 'daily' }, w.m1).error.code, 'FORBIDDEN');
  assert.strictEqual(w.env.call('getReport', { period: 'daily' }, w.m1).error.code, 'FORBIDDEN');
});

test('getReport returns the report for the dashboard', () => {
  const w = world();
  const r = w.env.call('getReport', { period: 'weekly' }, w.A);
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.strictEqual(r.data.totals.total, 6);
  assert.ok(Array.isArray(r.data.projects));
});

test('scheduled reports respect their switches', () => {
  const w = world();
  w.env.call('saveSettings', { values: { REPORT_DAILY: 'FALSE' } }, w.A);
  w.env.run('runDailyReport');
  assert.strictEqual(w.log().length, 0);
  w.env.run('runWeeklyReport');
  assert.deepStrictEqual(w.log().map((x) => x.Kind + ':' + x.Channel).sort(), ['weekly:email', 'weekly:whatsapp']);
  w.env.run('runMonthlyReport');
  assert.strictEqual(w.log().filter((x) => x.Kind === 'monthly').length, 2);
});

test('admin without a mobile falls back to ADMIN_MOBILE', () => {
  const w = world();
  w.env.call('updateMyAccount', { mobile: '', currentPassword: 'AdminPass1' }, w.A);
  w.env.call('saveSettings', { values: { ADMIN_MOBILE: '+971 52 777 8888' } }, w.A);
  w.env.run('runDailyReport');
  assert.strictEqual(JSON.parse(w.env.fetches[0].opts.payload).to, '971527778888');
});

test('setup installs each trigger exactly once', () => {
  const w = world();
  w.env.run('setupBoard');
  const fns = w.env.triggers.map((t) => t.fn).sort();
  assert.deepStrictEqual(fns, ['retryFailedWhatsApp', 'runDailyReport', 'runMemberReminders', 'runMonthlyReport', 'runWeeklyReport']);
});
