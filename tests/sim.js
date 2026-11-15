// Minimal in-memory stand-in for the Google Apps Script services used by the board.
// Used only by the tests: node --test tests/
'use strict';
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');

function chainable(target) {
  // Any unknown method (formatting calls) is a no-op that returns the same object.
  return new Proxy(target, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k === 'symbol') return undefined;
      return () => chainable(t);
    }
  });
}

class Sheet {
  constructor(name) { this.name = name; this.v = []; this.maxRows = 1000; this.maxCols = 26; this.filter = null; }
  getName() { return this.name; }
  getLastRow() { for (let i = this.v.length - 1; i >= 0; i--) if ((this.v[i] || []).some((x) => x !== '' && x != null)) return i + 1; return 0; }
  getLastColumn() { let m = 0; this.v.forEach((r) => { for (let j = r.length - 1; j >= 0; j--) if (r[j] !== '' && r[j] != null) { m = Math.max(m, j + 1); break; } }); return m; }
  getMaxRows() { return Math.max(this.maxRows, this.v.length); }
  getMaxColumns() { return this.maxCols; }
  insertColumnsAfter(c, n) { this.maxCols += n; }
  getFilter() { return this.filter; }
  deleteRow(r) { this.v.splice(r - 1, 1); }
  clear() { this.v = []; return this; }
  getRange(r, c, nr, nc) {
    nr = nr || 1; nc = nc || 1;
    const sh = this;
    return chainable({
      getValues() {
        const out = [];
        for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) { const x = (sh.v[r - 1 + i] || [])[c - 1 + j]; row.push(x === undefined || x === null ? '' : x); } out.push(row); }
        return out;
      },
      setValues(vals) {
        for (let i = 0; i < nr; i++) { const row = sh.v[r - 1 + i] || (sh.v[r - 1 + i] = []); for (let j = 0; j < nc; j++) row[c - 1 + j] = vals[i][j]; }
        for (let i = 0; i < sh.v.length; i++) if (!sh.v[i]) sh.v[i] = [];
        return this;
      },
      setValue(x) { return this.setValues([[x]]); },
      createFilter() { sh.filter = {}; return sh.filter; }
    });
  }
}

function createEnv() {
  let offset = 0;
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(RealDate.now() + offset); }
    static now() { return RealDate.now() + offset; }
  }

  const sheets = {};
  const order = [];
  const ss = {
    getName: () => 'Test Sheet',
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => { sheets[n] = chainable(new Sheet(n)); order.push(n); return sheets[n]; },
    getSheets: () => order.map((n) => sheets[n]),
    copy: () => ({ getId: () => 'copy' })
  };

  const cache = {};
  const cacheApi = {
    get(k) { const e = cache[k]; if (!e) return null; if (e.exp < FakeDate.now()) { delete cache[k]; return null; } return e.v; },
    put(k, v, sec) { cache[k] = { v: String(v), exp: FakeDate.now() + (sec || 600) * 1000 }; },
    remove(k) { delete cache[k]; },
    getAll(keys) { const o = {}; keys.forEach((k) => { const v = cacheApi.get(k); if (v !== null) o[k] = v; }); return o; }
  };
  const props = {};
  const propsApi = {
    getProperty: (k) => (k in props ? props[k] : null),
    setProperty: (k, v) => { props[k] = String(v); },
    deleteProperty: (k) => { delete props[k]; },
    getProperties: () => Object.assign({}, props)
  };

  const triggers = [];
  function triggerBuilder(fn) {
    const t = { fn, spec: {} };
    const b = new Proxy({}, {
      get(_, k) {
        if (k === 'create') return () => { triggers.push(t); return t; };
        return (x) => { t.spec[k] = x === undefined ? true : x; return b; };
      }
    });
    return b;
  }

  const env = { mail: [], fetches: [], mailQuota: 100, triggers, props };
  let fetchHandler = () => ({ code: 200, body: '{}' });

  function tzParts(d, tz) {
    const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' });
    const o = {}; f.formatToParts(d).forEach((p) => { o[p.type] = p.value; });
    if (o.hour === '24') o.hour = '00';
    return o;
  }

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Date: FakeDate,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, openById: () => ss, getUi: () => { throw new Error('no ui'); } },
    CacheService: { getScriptCache: () => cacheApi },
    PropertiesService: { getScriptProperties: () => propsApi },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    Session: { getEffectiveUser: () => ({ getEmail: () => '' }), getScriptTimeZone: () => 'Asia/Dubai' },
    ContentService: {
      MimeType: { JSON: 'json', JAVASCRIPT: 'js', TEXT: 'text' },
      createTextOutput: (t) => ({ text: t, mime: 'text', setMimeType(m) { this.mime = m; return this; }, getContent() { return this.text; } })
    },
    MailApp: {
      getRemainingDailyQuota: () => env.mailQuota,
      sendEmail(o) { if (env.mailFails) throw new Error('Mail service down'); env.mail.push(o); env.mailQuota--; }
    },
    UrlFetchApp: {
      fetch(url, opts) {
        const rec = { url, opts: opts || {} };
        env.fetches.push(rec);
        const r = fetchHandler(url, opts || {}) || { code: 200, body: '{}' };
        if (r.throw) throw new Error(r.throw);
        return { getResponseCode: () => r.code, getContentText: () => r.body };
      }
    },
    ScriptApp: {
      WeekDay: { MONDAY: 'MONDAY' },
      getProjectTriggers: () => triggers.map((t) => ({ getHandlerFunction: () => t.fn, _t: t })),
      newTrigger: (fn) => triggerBuilder(fn),
      deleteTrigger: (h) => { const i = triggers.indexOf(h._t); if (i >= 0) triggers.splice(i, 1); },
      getService: () => ({ getUrl: () => 'https://script.example/exec' })
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      getUuid: () => crypto.randomUUID(),
      computeDigest: (alg, s) => Array.from(crypto.createHash('sha256').update(String(s), 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b)),
      base64Encode: (x) => Buffer.from(typeof x === 'string' ? x : x.map((b) => (b + 256) % 256)).toString('base64'),
      formatDate(d, tz, fmt) {
        const p = tzParts(d, tz);
        return fmt.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day).replace('HH', p.hour).replace('mm', p.minute).replace('EEE', p.weekday);
      }
    }
  };
  const ctx = vm.createContext(sandbox);
  const files = fs.readdirSync(ROOT).filter((f) => f.endsWith('.gs')).sort();
  files.forEach((f) => vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f }));

  env.run = (name, ...args) => vm.runInContext(name, ctx)(...args);
  env.eval = (src) => vm.runInContext(src, ctx);
  env.call = (action, payload, token) => JSON.parse(JSON.stringify(env.run('handleRequest_', { action, payload: payload || {}, token })));
  env.get = (params) => env.run('doGet', { parameter: params || {} });
  env.post = (params, body) => env.run('doPost', { parameter: params || {}, postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } });
  env.sheet = (name) => {
    const sh = sheets[name]; if (!sh) return null;
    const head = (sh.v[0] || []).map(String);
    return sh.v.slice(1).filter((r) => r && r.some((x) => x !== '' && x != null)).map((r) => { const o = {}; head.forEach((h, i) => { if (h) o[h] = r[i] === undefined ? '' : r[i]; }); return o; });
  };
  env.rawSheet = (name) => sheets[name];
  env.setCell = (name, key, keyVal, col, val) => {
    const sh = sheets[name]; const head = sh.v[0].map(String);
    const r = sh.v.findIndex((row, i) => i > 0 && String(row[head.indexOf(key)]) === String(keyVal));
    sh.v[r][head.indexOf(col)] = val;
  };
  env.setFetchHandler = (fn) => { fetchHandler = fn; };
  env.advance = (ms) => { offset += ms; };
  env.files = files;
  return env;
}

/** Sets up a board and returns { env, adminToken, tempPassword }. Admin password is changed to 'AdminPass1'. */
function bootEnv() {
  const env = createEnv();
  const report = env.run('setupBoard');
  const m = /temporary password:\s*(\S+)/i.exec(report) || [];
  const out = { env, report, tempPassword: m[1] };
  if (m[1]) {
    const r = env.call('login', { email: 'admin@sidra.local', password: m[1] });
    if (r.ok) {
      env.call('changePassword', { current: m[1], next: 'AdminPass1' }, r.data.token);
      out.adminToken = r.data.token;
    }
  }
  out.addMember = (email, name, mobile) => {
    const r = env.call('saveUser', { email, password: 'MemberPass1', patch: { Name: name, Role: 'Member', Mobile: mobile === undefined ? '971500000001' : mobile } }, out.adminToken);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const l = env.call('login', { email, password: 'MemberPass1' });
    env.call('changePassword', { current: 'MemberPass1', next: 'MemberPass2' }, l.data.token);
    return l.data.token;
  };
  return out;
}

module.exports = { createEnv, bootEnv, ROOT };
