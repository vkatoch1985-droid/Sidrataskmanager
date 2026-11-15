/* =====================================================================
 *  Sidra Project Board — outgoing messages (WhatsApp.gs)
 * ---------------------------------------------------------------------
 *  Every email and WhatsApp message is written to the MessageLog tab
 *  with its status, so the administrator can see what was sent,
 *  delivered or failed (and why).
 *
 *  WhatsApp providers:
 *    meta    — Meta WhatsApp Cloud API (template messages)
 *    generic — any provider with a simple "POST JSON with a bearer token" API
 *
 *  Nothing in this file may throw into the request that triggered it:
 *  a failed message is logged, never allowed to block saving a task.
 * ===================================================================== */

const WA_API_VERSION = 'v23.0';
const WA_MAX_ATTEMPTS = 3;
const WA_STATUS_RANK = { queued: 0, failed: 1, sent: 2, delivered: 3, read: 4 };

/** Message templates submitted to the provider for approval. {{1}} = first name, {{2}} = the message. */
const WA_TEMPLATES = [
  { name: 'task_assigned', text: 'Hello {{1}}, a task has been assigned to you on the Sidra Project Board: {{2}}. Please open the board for details.', example: ['Sara', 'TSK-00012 · Call the clinic, due 2026-01-15'] },
  { name: 'task_updated', text: 'Hello {{1}}, there is an update on the Sidra Project Board: {{2}}. Please open the board for details.', example: ['Sara', 'TSK-00012 · Call the clinic — Stage: Under Design → Build'] },
  { name: 'task_reminder', text: 'Hello {{1}}, this is a reminder from the Sidra Project Board: {{2}}. Please open the board and update your tasks.', example: ['Sara', '2 tasks need attention — 1 overdue, 1 due soon'] },
  { name: 'admin_report', text: 'Hello {{1}}, here is your Sidra Project Board report: {{2}}. The full report has been sent to your email.', example: ['Admin', 'Daily report — 24 tasks, 3 completed, 2 overdue'] }
];

/** Which template carries which notification type. */
function waTemplateFor_(type) {
  if (['ASSIGNED', 'REASSIGNED', 'SUBTASK'].indexOf(type) >= 0) return 'task_assigned';
  if (['NOT_STARTED', 'DUE_SOON', 'OVERDUE', 'REMINDER'].indexOf(type) >= 0) return 'task_reminder';
  return 'task_updated';
}

/* ---------- log ---------- */

function logMessage_(o) {
  const tbl = tableHead_('MessageLog');
  const now = nowIso_();
  const rec = {
    MessageID: 'MSG-' + Date.now().toString(36).toUpperCase() + '-' + Utilities.getUuid().slice(0, 6).toUpperCase(),
    CreatedAt: now, Recipient: lc_(o.recipient), RecipientName: o.name || '', Channel: o.channel, Kind: o.kind || 'notification',
    EntityID: o.entityId || '', Summary: String(o.summary || '').slice(0, 300), Status: o.status || 'queued',
    ProviderMessageID: o.providerId || '', Error: String(o.error || '').slice(0, 300), Attempts: o.attempts || 0,
    UpdatedAt: now, Payload: o.payload ? JSON.stringify(o.payload).slice(0, 4000) : ''
  };
  appendRows_(tbl, [rec]);
  rec._tbl = tbl;
  return rec;
}

function updateMessage_(rec, tbl) {
  rec.UpdatedAt = nowIso_();
  rec.Error = String(rec.Error || '').slice(0, 300);
  writeRow_(tbl || rec._tbl, rec);
}

/* ---------- email ---------- */

function emailShell_(s, firstName, innerHtml, link, linkText) {
  return '<div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;color:#1F1410">' +
    '<div style="background:#7A1E00;color:#fff;padding:14px 18px;border-radius:8px 8px 0 0;font-weight:bold">' + htmlEsc_(s.ORG_NAME || '') + ' · ' + htmlEsc_(s.APP_NAME || '') + '</div>' +
    '<div style="border:1px solid #EADFD8;border-top:0;padding:18px;border-radius:0 0 8px 8px">' +
    '<p style="margin:0 0 10px">Hi ' + htmlEsc_(firstName) + ',</p>' + innerHtml +
    (link ? '<p style="margin:18px 0 0"><a href="' + htmlEsc_(link) + '" style="display:inline-block;background:#F25C05;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;font-weight:bold">' + htmlEsc_(linkText || 'Open the board') + '</a></p>' : '') +
    '<p style="color:#7A6A62;font-size:12px;margin-top:18px">This is an automatic message from the ' + htmlEsc_(s.APP_NAME || 'board') + '. Please do not reply.</p></div></div>';
}

/** Sends one email and logs it. Never throws. Returns the log record. */
function sendEmail_(user, subject, innerHtml, text, kind, entityId, link) {
  let rec = null;
  try {
    const s = settings_();
    if (!truthy_(s.EMAIL_ENABLED)) return null; // switched off: nothing to send, nothing to log
    const to = lc_(user.Email);
    rec = logMessage_({ recipient: to, name: user.Name, channel: 'email', kind: kind, entityId: entityId, summary: subject });
    let problem = '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) || /\.local$/.test(to)) problem = 'No real email address for this user';
    else if (typeof MailApp.getRemainingDailyQuota === 'function' && MailApp.getRemainingDailyQuota() < 1) problem = 'Google daily email limit reached';
    if (problem) { rec.Status = 'failed'; rec.Error = problem; updateMessage_(rec); return rec; }
    const first = String(user.Name || '').split(' ')[0] || 'there';
    rec.Attempts = 1;
    MailApp.sendEmail({ to: to, subject: subject, htmlBody: emailShell_(s, first, innerHtml, link), body: text + (link ? '\n\n' + link : ''), name: s.APP_NAME || 'Project Board' });
    rec.Status = 'sent';
    updateMessage_(rec);
  } catch (e) {
    console.warn('Email not sent: ' + e.message);
    try { if (rec) { rec.Status = 'failed'; rec.Error = e.message; updateMessage_(rec); } } catch (x) { /* ignore */ }
  }
  return rec;
}

/* ---------- WhatsApp ---------- */

/** Template parameters may not contain line breaks, tabs or long runs of spaces. */
function waParam_(v, max) {
  const s = String(v === undefined || v === null ? '' : v).replace(/[\r\n\t]+/g, ' · ').replace(/\s{2,}/g, ' ').trim();
  return (s.length > (max || 700) ? s.slice(0, (max || 700) - 1) + '…' : s) || '-';
}

/** Queues, sends and logs one WhatsApp message. Never throws. Returns the log record. */
function sendWhatsApp_(user, template, params, text, kind, entityId) {
  let rec = null;
  try {
    const s = settings_();
    if (!truthy_(s.WA_ENABLED)) return null; // switched off: nothing to send, nothing to log
    const to = String(user.Mobile || '');
    rec = logMessage_({
      recipient: user.Email, name: user.Name, channel: 'whatsapp', kind: kind, entityId: entityId, summary: text,
      payload: { to: to, template: template, params: (params || []).map(function (p) { return waParam_(p); }), text: String(text || '').slice(0, 1500) }
    });
    waAttempt_(rec, rec._tbl);
  } catch (e) {
    console.warn('WhatsApp not sent: ' + e.message);
    try { if (rec) { rec.Status = 'failed'; rec.Error = e.message; updateMessage_(rec); } } catch (x) { /* ignore */ }
  }
  return rec;
}

/** One send attempt for a logged WhatsApp message. Updates the row; never throws. */
function waAttempt_(rec, tbl) {
  let res;
  try {
    const s = settings_();
    const pl = JSON.parse(rec.Payload || '{}');
    rec.Attempts = (Number(rec.Attempts) || 0) + 1;
    if (!pl.to) res = { ok: false, error: 'No WhatsApp number for this user' };
    else if (!s.WA_API_KEY) res = { ok: false, error: 'WhatsApp API key is not set in Settings' };
    else res = String(s.WA_PROVIDER || 'meta').toLowerCase() === 'generic' ? waSendGeneric_(s, pl) : waSendMeta_(s, pl);
  } catch (e) {
    res = { ok: false, error: e.message };
  }
  rec.Status = res.ok ? 'sent' : 'failed';
  rec.ProviderMessageID = res.ok ? (res.id || '') : (rec.ProviderMessageID || '');
  rec.Error = res.ok ? '' : res.error;
  updateMessage_(rec, tbl);
  return res.ok;
}

function waFetch_(url, key, method, body) {
  const opts = { method: method, muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + key } };
  if (body) { opts.contentType = 'application/json'; opts.payload = JSON.stringify(body); }
  const resp = UrlFetchApp.fetch(url, opts);
  const code = resp.getResponseCode();
  let data = {};
  try { data = JSON.parse(resp.getContentText() || '{}'); } catch (e) { data = {}; }
  return { code: code, data: data || {} };
}

function waErrorText_(r) {
  const e = r.data && r.data.error;
  if (e) return (e.error_user_msg || e.message || 'Provider error') + (e.code ? ' (code ' + e.code + ')' : '');
  return 'Provider returned HTTP ' + r.code;
}

function waSendMeta_(s, pl) {
  if (!s.WA_PHONE_ID) return { ok: false, error: 'WhatsApp sender (Phone number ID) is not set in Settings' };
  const r = waFetch_('https://graph.facebook.com/' + WA_API_VERSION + '/' + encodeURIComponent(s.WA_PHONE_ID) + '/messages', s.WA_API_KEY, 'post', {
    messaging_product: 'whatsapp', to: pl.to, type: 'template',
    template: {
      name: pl.template, language: { code: s.WA_LANG || 'en' },
      components: [{ type: 'body', parameters: (pl.params || []).map(function (p) { return { type: 'text', text: p }; }) }]
    }
  });
  const id = r.data && r.data.messages && r.data.messages[0] && r.data.messages[0].id;
  if (r.code >= 200 && r.code < 300 && id) return { ok: true, id: id };
  return { ok: false, error: r.data && r.data.error ? waErrorText_(r) : (r.code >= 200 && r.code < 300 ? 'Provider did not return a message ID' : waErrorText_(r)) };
}

function waSendGeneric_(s, pl) {
  if (!/^https:\/\//i.test(s.WA_GENERIC_URL || '')) return { ok: false, error: 'Provider URL is not set in Settings (must start with https://)' };
  const r = waFetch_(s.WA_GENERIC_URL, s.WA_API_KEY, 'post', { to: pl.to, message: pl.text, template: pl.template, params: pl.params });
  if (r.code >= 200 && r.code < 300) {
    const d = r.data || {};
    return { ok: true, id: String(d.id || d.message_id || d.messageId || (d.messages && d.messages[0] && d.messages[0].id) || '') };
  }
  return { ok: false, error: waErrorText_(r) };
}

/** Time-driven (every 15 minutes): retries failed WhatsApp messages from the last 24 hours, up to 3 attempts each. */
function retryFailedWhatsApp() {
  REQ = {};
  return withLock_(function () {
    if (!truthy_(settings_().WA_ENABLED)) return 0;
    const tbl = tableHead_('MessageLog');
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    let n = 0;
    readTail_('MessageLog', 500).forEach(function (r) {
      if (r.Channel !== 'whatsapp' || r.Status !== 'failed' || (Number(r.Attempts) || 0) >= WA_MAX_ATTEMPTS || r.CreatedAt < since) return;
      waAttempt_(r, tbl); n++;
    });
    return n;
  });
}

/* ---------- delivery webhook ---------- */

function webhookTokenOk_(token) {
  let want = '';
  try { want = String(settings_().WEBHOOK_TOKEN || ''); } catch (e) { return false; }
  return !!want && String(token || '') === want;
}

/** Applies provider status updates to the MessageLog. Never throws. */
function handleWebhook_(bodyText) {
  try {
    let body;
    try { body = JSON.parse(bodyText || '{}'); } catch (e) { return 0; }
    const updates = [];
    if (body && Array.isArray(body.entry)) {
      body.entry.forEach(function (en) {
        (Array.isArray(en && en.changes) ? en.changes : []).forEach(function (ch) {
          const v = (ch && ch.value) || {};
          (Array.isArray(v.statuses) ? v.statuses : []).forEach(function (st) {
            const er = Array.isArray(st.errors) && st.errors[0] ? st.errors[0] : null;
            updates.push({ id: String(st.id || ''), status: String(st.status || '').toLowerCase(), error: er ? (er.title || er.message || 'Failed') + (er.code ? ' (code ' + er.code + ')' : '') : '' });
          });
        });
      });
    } else if (body && (body.id || body.message_id) && body.status) {
      updates.push({ id: String(body.id || body.message_id), status: String(body.status).toLowerCase(), error: String(body.error || '') });
    }
    const good = updates.filter(function (u) { return u.id && WA_STATUS_RANK[u.status] !== undefined; });
    if (!good.length) return 0;
    REQ = {};
    return withLock_(function () {
      const tbl = tableHead_('MessageLog');
      const rows = readTail_('MessageLog', 2000);
      let n = 0;
      good.forEach(function (u) {
        const r = rows.find(function (x) { return x.ProviderMessageID === u.id; });
        if (!r) return;
        if (u.status === 'failed') { r.Status = 'failed'; r.Error = u.error || 'Delivery failed'; r.Attempts = WA_MAX_ATTEMPTS; }
        else if (WA_STATUS_RANK[u.status] > (WA_STATUS_RANK[r.Status] || 0)) { r.Status = u.status; r.Error = ''; }
        else return;
        updateMessage_(r, tbl); n++;
      });
      return n;
    });
  } catch (e) {
    console.warn('Webhook not processed: ' + e.message);
    return 0;
  }
}

/* ---------- notifications → email + WhatsApp ---------- */

/** Called by notify_() for every new in-app notification. Never throws. */
function deliverNotifications_(rows, type) {
  try {
    const s = settings_();
    const types = list_(s.NOTIFY_TYPES).map(function (x) { return x.toUpperCase(); });
    if (types.indexOf(type) < 0) return 0;
    const users = userMap_();
    const base = String(s.BOARD_URL || '').replace(/#.*$/, '');
    let n = 0;
    rows.forEach(function (row) {
      const u = users[lc_(row.Recipient)];
      if (!u || !u.Active) return;
      const link = base && row.EntityType === 'Task' ? base + '#/tasks?task=' + encodeURIComponent(row.EntityID) : base;
      const subject = '[' + (s.ORG_NAME || 'Board') + '] ' + (EMAIL_SUBJECTS[row.Type] || 'Notification') + ' — ' + row.EntityID;
      sendEmail_(u, subject, '<p style="margin:0;font-size:15px">' + htmlEsc_(row.Message) + '</p>', row.Message, 'notification', row.EntityID, link);
      sendWhatsApp_(u, waTemplateFor_(row.Type), [String(u.Name || '').split(' ')[0] || 'there', row.Message], row.Message + (link ? '\n' + link : ''), 'notification', row.EntityID);
      n++;
    });
    return n;
  } catch (e) {
    console.warn('Notifications not delivered: ' + e.message);
    return 0;
  }
}

/* ---------- administrator API ---------- */

function getMessageLog_(ctx, p) {
  requireRole_(ctx, ['Admin'], 'Only administrators can see the message log.');
  const limit = Math.min(500, Math.max(1, Number(p.limit) || 200));
  const all = readTail_('MessageLog', 2000);
  const today = today_();
  const counts = { email: { sent: 0, failed: 0 }, whatsapp: { sent: 0, delivered: 0, read: 0, failed: 0, queued: 0 } };
  all.forEach(function (r) {
    if (Utilities.formatDate(new Date(r.CreatedAt), tz_(), 'yyyy-MM-dd') !== today) return;
    const c = counts[r.Channel]; if (!c) return;
    if (r.Status === 'failed') c.failed++;
    else if (r.Channel === 'email') c.sent++;
    else { if (r.Status !== 'queued') c.sent++; if (r.Status === 'delivered' || r.Status === 'read') c.delivered++; if (r.Status === 'read') c.read++; if (r.Status === 'queued') c.queued++; }
  });
  const rows = all.filter(function (r) {
    return (!p.channel || r.Channel === p.channel) && (!p.status || r.Status === p.status) && (!p.recipient || lc_(r.Recipient) === lc_(p.recipient)) && (!p.kind || r.Kind === p.kind);
  }).reverse().slice(0, limit).map(function (r) { const o = pub_(r); delete o.Payload; return o; });
  return { rows: rows, today: counts, total: all.length };
}

function waAdminConfig_(needBusiness) {
  const s = settings_();
  if (String(s.WA_PROVIDER || 'meta').toLowerCase() !== 'meta') throw err_('VALIDATION', 'Template approval from the board works with the Meta WhatsApp Cloud API provider. With another provider, create the templates in that provider\'s dashboard.');
  if (!s.WA_API_KEY) throw err_('VALIDATION', 'Save the WhatsApp API key in Settings first.');
  if (needBusiness && !s.WA_BUSINESS_ID) throw err_('VALIDATION', 'Save the WhatsApp Business Account ID in Settings first.');
  return s;
}

/** Sends the board's message templates to Meta for approval. */
function submitTemplates_(ctx) {
  requireRole_(ctx, ['Admin'], 'Only administrators can submit templates.');
  const s = waAdminConfig_(true);
  const out = WA_TEMPLATES.map(function (t) {
    try {
      const r = waFetch_('https://graph.facebook.com/' + WA_API_VERSION + '/' + encodeURIComponent(s.WA_BUSINESS_ID) + '/message_templates', s.WA_API_KEY, 'post', {
        name: t.name, language: s.WA_LANG || 'en', category: 'UTILITY',
        components: [{ type: 'BODY', text: t.text, example: { body_text: [t.example] } }]
      });
      if (r.code >= 200 && r.code < 300) return { name: t.name, status: String(r.data.status || 'PENDING').toUpperCase(), text: t.text };
      return { name: t.name, status: 'ERROR', reason: waErrorText_(r), text: t.text };
    } catch (e) {
      return { name: t.name, status: 'ERROR', reason: e.message, text: t.text };
    }
  });
  logActivity_(ctx, 'Settings', 'WhatsApp', 'Templates submitted', out.map(function (x) { return x.name + ': ' + x.status; }).join('; '));
  return { templates: out };
}

/** Reads the approval status of the board's templates from Meta. */
function templateStatus_(ctx) {
  requireRole_(ctx, ['Admin'], 'Only administrators can see template status.');
  const s = waAdminConfig_(true);
  const r = waFetch_('https://graph.facebook.com/' + WA_API_VERSION + '/' + encodeURIComponent(s.WA_BUSINESS_ID) + '/message_templates?fields=name,status,rejected_reason,language&limit=200', s.WA_API_KEY, 'get');
  if (!(r.code >= 200 && r.code < 300)) throw err_('PROVIDER', 'WhatsApp provider said: ' + waErrorText_(r));
  const have = {};
  (Array.isArray(r.data.data) ? r.data.data : []).forEach(function (t) { have[t.name] = t; });
  return {
    templates: WA_TEMPLATES.map(function (t) {
      const h = have[t.name];
      return { name: t.name, text: t.text, status: h ? String(h.status || '').toUpperCase() : 'NOT_SUBMITTED', reason: h && h.rejected_reason && h.rejected_reason !== 'NONE' ? h.rejected_reason : '' };
    })
  };
}

/** Sends a test message to the administrator's own number and email. */
function sendTestMessage_(ctx) {
  requireRole_(ctx, ['Admin'], 'Only administrators can send a test message.');
  const s = settings_();
  const me = userMap_()[ctx.email];
  const u = { Email: me.Email, Name: me.Name, Mobile: me.Mobile || normMobileSafe_(s.ADMIN_MOBILE) };
  const text = 'Test message from the ' + (s.APP_NAME || 'board') + ' — sent ' + Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd HH:mm');
  const e = sendEmail_(u, '[' + (s.ORG_NAME || 'Board') + '] Test message', '<p style="margin:0">' + htmlEsc_(text) + '</p>', text, 'test', '', s.BOARD_URL);
  const w = truthy_(s.WA_ENABLED) ? sendWhatsApp_(u, 'task_reminder', [String(u.Name || '').split(' ')[0] || 'there', text], text, 'test', '') : null;
  const view = function (r, off) { return r ? { status: r.Status, error: r.Error } : { status: 'off', error: off }; };
  return { email: view(e, 'Email is switched off'), whatsapp: view(w, 'WhatsApp is switched off in Settings') };
}

function normMobileSafe_(v) { try { return normMobile_(v); } catch (e) { return ''; } }
