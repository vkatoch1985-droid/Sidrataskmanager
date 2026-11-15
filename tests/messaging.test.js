'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { bootEnv } = require('./sim');

function world(opts) {
  opts = opts || {};
  const b = bootEnv();
  const env = b.env, A = b.adminToken;
  const vals = { WA_ENABLED: 'TRUE', WA_PROVIDER: 'meta', WA_PHONE_ID: '1111', WA_BUSINESS_ID: '2222' };
  if (!opts.noKey) vals.WA_API_KEY = 'abcd1234wxyz';
  const r = env.call('saveSettings', { values: vals }, A);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  const m1 = b.addMember('m1@x.com', 'Mona One', opts.noMobile ? '' : '971500000011');
  let n = 0;
  env.setFetchHandler((url) => /\/messages$/.test(url) ? { code: 200, body: JSON.stringify({ messages: [{ id: 'wamid.' + (++n) }] }) } : { code: 200, body: '{}' });
  const assign = () => env.call('saveTask', { patch: { Title: 'Visit patient', AssignedTo: 'm1@x.com' } }, A);
  const log = () => env.sheet('MessageLog');
  return { b, env, A, m1, assign, log };
}

test('assigning a task logs one email and one WhatsApp message for the assignee', () => {
  const w = world();
  const r = w.assign();
  assert.ok(r.ok, JSON.stringify(r.error));
  const rows = w.log().filter((x) => x.Recipient === 'm1@x.com' && x.EntityID === r.data.task.TaskID);
  assert.deepStrictEqual(rows.map((x) => x.Channel).sort(), ['email', 'whatsapp']);
  assert.strictEqual(w.env.mail.length, 1);
  assert.strictEqual(w.env.mail[0].to, 'm1@x.com');
});

test('WhatsApp send goes to Meta with the template and is logged as sent', () => {
  const w = world();
  w.assign();
  const f = w.env.fetches.find((x) => /\/messages$/.test(x.url));
  assert.ok(f, 'no fetch');
  assert.match(f.url, /graph\.facebook\.com\/v[\d.]+\/1111\/messages$/);
  assert.strictEqual(f.opts.headers.Authorization, 'Bearer abcd1234wxyz');
  const body = JSON.parse(f.opts.payload);
  assert.strictEqual(body.messaging_product, 'whatsapp');
  assert.strictEqual(body.to, '971500000011');
  assert.strictEqual(body.type, 'template');
  assert.strictEqual(body.template.name, 'task_assigned');
  assert.strictEqual(body.template.components[0].parameters.length, 2);
  const row = w.log().find((x) => x.Channel === 'whatsapp');
  assert.strictEqual(row.Status, 'sent');
  assert.strictEqual(row.ProviderMessageID, 'wamid.1');
});

test('missing API key: logged as failed with a reason, task still saves', () => {
  const w = world({ noKey: true });
  const r = w.assign();
  assert.ok(r.ok);
  const row = w.log().find((x) => x.Channel === 'whatsapp');
  assert.strictEqual(row.Status, 'failed');
  assert.match(row.Error, /API key/i);
  assert.strictEqual(w.env.fetches.length, 0);
});

test('member without a mobile number: failed with "No WhatsApp number"', () => {
  const w = world({ noMobile: true });
  assert.ok(w.assign().ok);
  assert.match(w.log().find((x) => x.Channel === 'whatsapp').Error, /No WhatsApp number/);
});

test('provider error or network failure never fails the task save', () => {
  const w = world();
  w.env.setFetchHandler(() => ({ code: 400, body: JSON.stringify({ error: { message: 'Template name does not exist', code: 132001 } }) }));
  assert.ok(w.assign().ok);
  assert.match(w.log().find((x) => x.Channel === 'whatsapp').Error, /Template name does not exist/);
  w.env.setFetchHandler(() => ({ throw: 'DNS error' }));
  assert.ok(w.env.call('saveTask', { patch: { Title: 'Second task', AssignedTo: 'm1@x.com' } }, w.A).ok);
  w.env.mailFails = true;
  assert.ok(w.env.call('saveTask', { patch: { Title: 'Third task', AssignedTo: 'm1@x.com' } }, w.A).ok);
  assert.ok(w.log().some((x) => x.Channel === 'email' && x.Status === 'failed'));
});

test('WhatsApp switched off: nothing is fetched', () => {
  const w = world();
  w.env.call('saveSettings', { values: { WA_ENABLED: 'FALSE' } }, w.A);
  w.assign();
  assert.strictEqual(w.env.fetches.length, 0);
});

test('webhook with the right token marks a message delivered; wrong token is ignored', () => {
  const w = world();
  w.assign();
  const token = w.env.sheet('Settings').find((x) => x.Key === 'WEBHOOK_TOKEN').Value;
  assert.ok(token.length >= 20);
  const body = { entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: 'wamid.1', status: 'delivered' }] } }] }] };
  w.env.post({ wh: 'wrong' }, body);
  assert.strictEqual(w.log().find((x) => x.Channel === 'whatsapp').Status, 'sent');
  w.env.post({ wh: token }, body);
  assert.strictEqual(w.log().find((x) => x.Channel === 'whatsapp').Status, 'delivered');
});

test('a late "sent" webhook does not downgrade a delivered message; failed records the reason', () => {
  const w = world();
  w.assign();
  const token = w.env.sheet('Settings').find((x) => x.Key === 'WEBHOOK_TOKEN').Value;
  const mk = (status, extra) => ({ entry: [{ changes: [{ field: 'messages', value: { statuses: [Object.assign({ id: 'wamid.1', status }, extra || {})] } }] }] });
  w.env.post({ wh: token }, mk('read'));
  w.env.post({ wh: token }, mk('sent'));
  assert.strictEqual(w.log().find((x) => x.Channel === 'whatsapp').Status, 'read');
  w.env.post({ wh: token }, mk('failed', { errors: [{ code: 131026, title: 'Message undeliverable' }] }));
  const row = w.log().find((x) => x.Channel === 'whatsapp');
  assert.strictEqual(row.Status, 'failed');
  assert.match(row.Error, /undeliverable/i);
});

test('webhook verification echoes the challenge only for the right token', () => {
  const w = world();
  const token = w.env.sheet('Settings').find((x) => x.Key === 'WEBHOOK_TOKEN').Value;
  assert.strictEqual(w.env.get({ 'hub.mode': 'subscribe', 'hub.verify_token': token, 'hub.challenge': '12345' }).text, '12345');
  assert.notStrictEqual(w.env.get({ 'hub.mode': 'subscribe', 'hub.verify_token': 'bad', 'hub.challenge': '12345' }).text, '12345');
});

test('malformed webhook bodies do not throw', () => {
  const w = world();
  const token = w.env.sheet('Settings').find((x) => x.Key === 'WEBHOOK_TOKEN').Value;
  w.env.post({ wh: token }, 'not json');
  w.env.post({ wh: token }, { entry: 'x' });
  w.env.post({ wh: token }, { entry: [{ changes: [{ value: {} }] }] });
});

test('failed WhatsApp messages are retried, at most 3 attempts', () => {
  const w = world();
  w.env.setFetchHandler(() => ({ code: 500, body: '{"error":{"message":"Server busy"}}' }));
  w.assign();
  assert.strictEqual(w.log().find((x) => x.Channel === 'whatsapp').Attempts, 1);
  w.env.run('retryFailedWhatsApp');
  w.env.run('retryFailedWhatsApp');
  assert.strictEqual(w.log().find((x) => x.Channel === 'whatsapp').Attempts, 3);
  const n = w.env.fetches.length;
  w.env.run('retryFailedWhatsApp');
  assert.strictEqual(w.env.fetches.length, n);
  assert.strictEqual(w.log().find((x) => x.Channel === 'whatsapp').Attempts, 3);
});

test('a retry that succeeds marks the message sent', () => {
  const w = world();
  w.env.setFetchHandler(() => ({ code: 500, body: '{}' }));
  w.assign();
  w.env.setFetchHandler(() => ({ code: 200, body: '{"messages":[{"id":"wamid.ok"}]}' }));
  w.env.run('retryFailedWhatsApp');
  const row = w.log().find((x) => x.Channel === 'whatsapp');
  assert.strictEqual(row.Status, 'sent');
  assert.strictEqual(row.ProviderMessageID, 'wamid.ok');
});

test('API key is write-only: admin sees only last four, member sees nothing', () => {
  const w = world();
  const a = w.env.call('bootstrap', {}, w.A);
  assert.deepStrictEqual(a.data.settings.WA_API_KEY, { set: true, last4: 'wxyz' });
  assert.ok(JSON.stringify(a).indexOf('abcd1234wxyz') < 0);
  const m = w.env.call('bootstrap', {}, w.m1);
  const txt = JSON.stringify(m);
  assert.ok(txt.indexOf('wxyz') < 0);
  Object.keys(m.data.settings).forEach((k) => assert.ok(!/^WA_|ADMIN_MOBILE|WEBHOOK/.test(k), k + ' leaked to member'));
  const saved = w.env.call('saveSettings', { values: { APP_NAME: 'Renamed' } }, w.A);
  assert.ok(JSON.stringify(saved).indexOf('abcd1234wxyz') < 0);
});

test('saving settings with a blank API key keeps the stored key', () => {
  const w = world();
  w.env.call('saveSettings', { values: { WA_API_KEY: '', WA_PHONE_ID: '3333' } }, w.A);
  assert.strictEqual(w.env.sheet('Settings').find((x) => x.Key === 'WA_API_KEY').Value, 'abcd1234wxyz');
});

test('message log, templates and test message are admin only', () => {
  const w = world();
  ['getMessageLog', 'submitTemplates', 'templateStatus', 'sendTestMessage'].forEach((a) => assert.strictEqual(w.env.call(a, {}, w.m1).error.code, 'FORBIDDEN', a));
});

test('message log returns rows and today counts, filterable', () => {
  const w = world();
  w.assign();
  const r = w.env.call('getMessageLog', {}, w.A);
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.ok(r.data.rows.length >= 2);
  assert.strictEqual(r.data.today.whatsapp.sent, 1);
  assert.strictEqual(r.data.today.email.sent, 1);
  assert.ok(JSON.stringify(r).indexOf('abcd1234wxyz') < 0);
  const f = w.env.call('getMessageLog', { channel: 'whatsapp' }, w.A).data.rows;
  assert.ok(f.length && f.every((x) => x.Channel === 'whatsapp'));
});

test('submit templates posts each template to the business account', () => {
  const w = world();
  w.env.setFetchHandler((url) => ({ code: 200, body: JSON.stringify({ id: '9', status: 'PENDING' }) }));
  const r = w.env.call('submitTemplates', {}, w.A);
  assert.ok(r.ok, JSON.stringify(r.error));
  const posts = w.env.fetches.filter((x) => /\/2222\/message_templates$/.test(x.url));
  assert.strictEqual(posts.length, 4);
  const body = JSON.parse(posts[0].opts.payload);
  assert.strictEqual(body.category, 'UTILITY');
  assert.ok(body.components[0].text.indexOf('{{2}}') > 0);
  assert.strictEqual(r.data.templates.length, 4);
  assert.strictEqual(r.data.templates[0].status, 'PENDING');
});

test('template status reads statuses from the provider', () => {
  const w = world();
  w.env.setFetchHandler(() => ({ code: 200, body: JSON.stringify({ data: [{ name: 'task_assigned', status: 'APPROVED' }, { name: 'task_reminder', status: 'REJECTED', rejected_reason: 'INVALID_FORMAT' }] }) }));
  const t = w.env.call('templateStatus', {}, w.A).data.templates;
  assert.strictEqual(t.find((x) => x.name === 'task_assigned').status, 'APPROVED');
  assert.strictEqual(t.find((x) => x.name === 'task_reminder').status, 'REJECTED');
  assert.strictEqual(t.find((x) => x.name === 'admin_report').status, 'NOT_SUBMITTED');
});

test('changing stage or due date notifies the assignee as an update', () => {
  const w = world();
  const t = w.assign().data.task;
  const before = w.log().length;
  w.env.call('saveTask', { id: t.TaskID, patch: { Stage: 'Build', DueDate: '2030-01-05' } }, w.A);
  const rows = w.log().slice(before).filter((x) => x.Recipient === 'm1@x.com');
  assert.deepStrictEqual(rows.map((x) => x.Channel).sort(), ['email', 'whatsapp']);
  const f = w.env.fetches[w.env.fetches.length - 1];
  assert.strictEqual(JSON.parse(f.opts.payload).template.name, 'task_updated');
});

test('a member editing their own task does not message themselves', () => {
  const w = world();
  const t = w.assign().data.task;
  const before = w.log().length;
  w.env.call('saveTask', { id: t.TaskID, patch: { Stage: 'Build' } }, w.m1);
  assert.strictEqual(w.log().slice(before).filter((x) => x.Recipient === 'm1@x.com').length, 0);
});

test('generic provider posts to the configured URL', () => {
  const w = world();
  w.env.call('saveSettings', { values: { WA_PROVIDER: 'generic', WA_GENERIC_URL: 'https://api.example.com/send' } }, w.A);
  w.env.setFetchHandler(() => ({ code: 200, body: '{"id":"g-1"}' }));
  w.assign();
  const f = w.env.fetches[w.env.fetches.length - 1];
  assert.strictEqual(f.url, 'https://api.example.com/send');
  const body = JSON.parse(f.opts.payload);
  assert.strictEqual(body.to, '971500000011');
  assert.ok(body.message.indexOf('Visit patient') >= 0);
  assert.strictEqual(w.log().find((x) => x.Channel === 'whatsapp').ProviderMessageID, 'g-1');
});

test('template parameters contain no line breaks', () => {
  const w = world();
  w.env.call('saveTask', { patch: { Title: 'Line one', AssignedTo: 'm1@x.com', Subtasks: '[ ] a | m1@x.com\n[ ] b | m1@x.com' } }, w.A);
  w.env.fetches.filter((x) => /\/messages$/.test(x.url)).forEach((f) => JSON.parse(f.opts.payload).template.components[0].parameters.forEach((p) => assert.ok(!/[\n\t]/.test(p.text) && !/ {5,}/.test(p.text))));
});
