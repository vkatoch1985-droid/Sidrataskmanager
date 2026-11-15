// Local preview: serves the website and answers API calls with the in-memory simulator.
// node tests/devserver.js  →  http://localhost:8765/  (admin@sidra.local / AdminPass1, m1@x.com / MemberPass2)
'use strict';
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const { bootEnv, ROOT } = require('./sim');
const b = bootEnv(); const env = b.env, A = b.adminToken;
env.call('saveSettings', { values: { WA_ENABLED: 'TRUE', WA_PHONE_ID: '1111', WA_BUSINESS_ID: '2222', WA_API_KEY: 'abcd1234wxyz', BOARD_URL: 'http://localhost:8765/' } }, A);
env.call('updateMyAccount', { name: 'Aisha Admin', mobile: '971509999999', currentPassword: 'AdminPass1' }, A);
b.addMember('m1@x.com', 'Mona Rahman', '971500000011'); b.addMember('m2@x.com', 'Omar Khalid', '');
let n = 0;
env.setFetchHandler((url) => /messages$/.test(url) ? (++n % 3 ? { code: 200, body: '{"messages":[{"id":"wamid.' + n + '"}]}' } : { code: 400, body: '{"error":{"message":"Template not approved yet","code":132001}}' }) : /message_templates/.test(url) ? { code: 200, body: '{"data":[{"name":"task_assigned","status":"APPROVED"},{"name":"task_reminder","status":"PENDING"}],"status":"PENDING"}' } : { code: 200, body: '{}' });
const today = env.run('today_'); const d = (k) => env.run('addDays_', today, k);
const ini = env.call('saveInitiative', { patch: { Name: 'Home nursing expansion', Owner: 'admin@sidra.local', Stage: 'Build', TargetDate: d(60) } }, A).data.initiative.InitiativeID;
const prj = env.call('saveProject', { patch: { Name: 'Al Ain branch launch', Owner: 'admin@sidra.local', Status: 'Active', InitiativeID: ini, TargetDate: d(40) } }, A).data.project.ProjectID;
env.call('saveProject', { patch: { Name: 'Patient app pilot', Owner: 'm1@x.com', Status: 'Planning' } }, A);
[['Hire two nurses', 'm1@x.com', 'Build', -3], ['Order medical kits', 'm1@x.com', 'Under Design', 1], ['Train care team', 'm2@x.com', 'Build', 5], ['Sign clinic lease', 'm2@x.com', 'Completed', -1], ['Website update', '', 'Parked', 20]]
  .forEach((x, i) => env.call('saveTask', { patch: { Title: x[0], AssignedTo: x[1], Stage: x[2], StartDate: d(-10), DueDate: d(x[3]), InitiativeID: ini, ProjectID: i < 4 ? prj : '', Subtasks: i === 2 ? '[ ] Prepare slides | m1@x.com' : '' } }, A));
env.run('runMemberReminders');
const token = env.sheet('Settings').find((x) => x.Key === 'WEBHOOK_TOKEN').Value;
env.post({ wh: token }, { entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.1', status: 'delivered' }] } }] }] });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
http.createServer((req, res) => {
  if (req.method === 'POST') {
    let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => { let out; try { out = env.run('handleRequest_', JSON.parse(body)); } catch (e) { out = { ok: false, error: { code: 'SERVER_ERROR', message: e.message } }; } res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(out)); });
    return;
  }
  let f = req.url.split('?')[0]; if (f === '/') f = '/index.html';
  if (f === '/config.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end("window.BOARD_CONFIG={API_URL:'/api'};"); }
  const full = path.join(ROOT, path.normalize(f));
  if (!full.startsWith(ROOT) || !fs.existsSync(full)) { res.statusCode = 404; return res.end('not found'); }
  res.setHeader('Content-Type', types[path.extname(full)] || 'application/octet-stream'); res.end(fs.readFileSync(full));
}).listen(8765, () => console.log('http://localhost:8765/'));
