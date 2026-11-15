/* =====================================================================
 *  Sidra Project Board — sign-in and accounts (Auth.gs)
 * ---------------------------------------------------------------------
 *  Email + password sign-in. Passwords are stored in the Users tab only
 *  as a salted, repeatedly hashed value ("rounds$hex"); the password
 *  itself is never written anywhere.
 * ===================================================================== */

const AUTH = {
  ROUNDS: 2000,        // SHA-256 rounds for new passwords (stored with the hash, so it can be raised later)
  MIN_LENGTH: 8,
  MAX_FAILS: 5,
  LOCK_MINUTES: 15,
  FIRST_ADMIN: 'admin@sidra.local',
  TEMP_PASSWORD: 'sidra@123',   // starting password for the first admin; the app forces a change at first sign-in
  BAD_LOGIN: 'Email or password is incorrect.'
};
/** Actions a user may call while they still have to choose a new password. */
const PASSWORD_CHANGE_ALLOWED = ['changePassword', 'logout'];

function sha256Hex_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}

function newSalt_() { return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''); }

/** Returns "rounds$hex". */
function hashPassword_(password, salt, rounds) {
  rounds = Math.max(1, Number(rounds) || AUTH.ROUNDS);
  let h = sha256Hex_(salt + ':' + String(password));
  for (let i = 0; i < rounds; i++) h = sha256Hex_(h + salt);
  return rounds + '$' + h;
}

function passwordMatches_(u, password) {
  const stored = String(u.PasswordHash || '');
  if (!stored || !u.PasswordSalt) return false;
  const rounds = Number(stored.split('$')[0]) || AUTH.ROUNDS;
  const got = hashPassword_(password, u.PasswordSalt, rounds);
  if (got.length !== stored.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ stored.charCodeAt(i);
  return diff === 0;
}

function checkNewPassword_(pw) {
  pw = String(pw === undefined || pw === null ? '' : pw);
  if (pw.length < AUTH.MIN_LENGTH) throw err_('VALIDATION', 'Password must be at least ' + AUTH.MIN_LENGTH + ' characters.', { fields: { password: 'At least ' + AUTH.MIN_LENGTH + ' characters.' } });
  if (pw.length > 200) throw err_('VALIDATION', 'Password is too long.', { fields: { password: 'Maximum 200 characters.' } });
  return pw;
}

function setPassword_(u, pw, mustChange) {
  u.PasswordSalt = newSalt_();
  u.PasswordHash = hashPassword_(checkNewPassword_(pw), u.PasswordSalt);
  u.MustChangePassword = !!mustChange;
  u.FailedLogins = 0;
  u.LockedUntil = '';
}

/** WhatsApp number → digits only, international format. '' is allowed (no number). */
function normMobile_(v) {
  let s = String(v === undefined || v === null ? '' : v).replace(/[\s\-().]/g, '');
  if (!s) return '';
  s = s.replace(/^\+/, '').replace(/^00/, '');
  if (!/^\d{8,15}$/.test(s)) throw err_('VALIDATION', 'Enter the WhatsApp number in international format, for example 971501234567.', { fields: { Mobile: 'International format, digits only (8–15 digits).' } });
  return s;
}

/* ---------- sign-in ---------- */

function login_(p) {
  const email = lc_(p.email);
  const password = String(p.password === undefined || p.password === null ? '' : p.password);
  if (!email || !password) throw err_('AUTH_INVALID', AUTH.BAD_LOGIN);
  const s = settings_();
  // The failure (if any) is returned, not thrown, so the counter is saved before the lock is released.
  const res = withLock_(function () {
    const users = readTable_('Users');
    const u = users.rows.find(function (r) { return lc_(r.Email) === email; });
    if (!u || !u.Active) {
      hashPassword_(password, 'no-such-user', AUTH.ROUNDS); // same work as a real check
      return { fail: err_('AUTH_INVALID', AUTH.BAD_LOGIN) };
    }
    const now = Date.now();
    if (u.LockedUntil && new Date(u.LockedUntil).getTime() > now) {
      const mins = Math.max(1, Math.ceil((new Date(u.LockedUntil).getTime() - now) / 60000));
      return { fail: err_('LOCKED', 'Too many wrong passwords. Try again in ' + mins + ' minute' + (mins === 1 ? '' : 's') + '.') };
    }
    if (!passwordMatches_(u, password)) {
      u.FailedLogins = (Number(u.FailedLogins) || 0) + 1;
      if (u.FailedLogins >= AUTH.MAX_FAILS) {
        u.FailedLogins = 0;
        u.LockedUntil = new Date(now + AUTH.LOCK_MINUTES * 60000).toISOString();
        logActivity_({ email: 'system', name: 'System' }, 'User', email, 'Account locked', AUTH.MAX_FAILS + ' wrong passwords; locked for ' + AUTH.LOCK_MINUTES + ' minutes.');
      }
      writeRow_(users, u);
      return { fail: err_('AUTH_INVALID', AUTH.BAD_LOGIN) };
    }
    const firstLogin = !u.LastLogin;
    u.FailedLogins = 0; u.LockedUntil = '';
    u.LastLogin = nowIso_(); u.LastSeen = u.LastLogin;
    writeRow_(users, u);
    const hours = Math.max(1, Math.min(6, Number(s.SESSION_HOURS) || 6));
    const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    const expiresAt = new Date(now + hours * 3600 * 1000).toISOString();
    CacheService.getScriptCache().put('sess:' + token, JSON.stringify({ email: email, exp: expiresAt }), hours * 3600);
    return { token: token, expiresAt: expiresAt, user: publicUser_(u, true), firstLogin: firstLogin, mustChangePassword: !!u.MustChangePassword };
  });
  if (res.fail) throw res.fail;
  return res;
}

function auth_(token, action) {
  if (!token) throw err_('AUTH_REQUIRED', 'Please sign in.');
  const raw = CacheService.getScriptCache().get('sess:' + token);
  if (!raw) throw err_('AUTH_EXPIRED', 'Your session has expired. Please sign in again.');
  const sess = JSON.parse(raw);
  const u = users_().find(function (r) { return lc_(r.Email) === sess.email; });
  if (!u || !u.Active) throw err_('UNAUTHORIZED', 'Your account is no longer authorised.');
  if (u.MustChangePassword && PASSWORD_CHANGE_ALLOWED.indexOf(action) < 0) {
    throw err_('PASSWORD_CHANGE_REQUIRED', 'Choose a new password before you continue.');
  }
  touchPresence_(u);
  return { email: lc_(u.Email), name: u.Name || u.Email, role: u.Role === 'Admin' ? 'Admin' : 'Member', token: token, exp: sess.exp };
}

/* ---------- own account ---------- */

function changePassword_(ctx, p) {
  const next = checkNewPassword_(p.next);
  return withLock_(function () {
    const users = readTable_('Users');
    const u = users.rows.find(function (r) { return lc_(r.Email) === ctx.email; });
    if (!u) throw err_('NOT_FOUND', 'Account not found.');
    if (!passwordMatches_(u, String(p.current || ''))) throw err_('VALIDATION', 'Your current password is not correct.', { fields: { current: 'Not correct.' } });
    if (String(p.current) === next) throw err_('VALIDATION', 'Choose a password that is different from the current one.', { fields: { password: 'Must be different.' } });
    setPassword_(u, next, false);
    writeRow_(users, u);
    logActivity_(ctx, 'User', ctx.email, 'Password changed', 'Changed own password.');
    REQ.users = null;
    return { changed: true, user: publicUser_(u, true) };
  });
}

/** Name and mobile for everyone; email for administrators only. Always needs the current password. */
function updateMyAccount_(ctx, p) {
  const wantEmail = p.email !== undefined && p.email !== null && lc_(p.email) !== ctx.email ? lc_(p.email) : '';
  if (wantEmail && ctx.role !== 'Admin') throw err_('FORBIDDEN', 'Only an administrator can change a sign-in email.');
  if (wantEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(wantEmail)) throw err_('VALIDATION', 'Enter a valid email address.', { fields: { email: 'Enter a valid email address.' } });
  return withLock_(function () {
    let users = readTable_('Users');
    let u = users.rows.find(function (r) { return lc_(r.Email) === ctx.email; });
    if (!u) throw err_('NOT_FOUND', 'Account not found.');
    if (!passwordMatches_(u, String(p.currentPassword || ''))) throw err_('VALIDATION', 'Your current password is not correct.', { fields: { currentPassword: 'Not correct.' } });
    const changed = [];
    if (p.name !== undefined) { const n = str_(p.name, 120, 'Name'); if (n && n !== u.Name) { u.Name = n; changed.push('name'); } }
    if (p.mobile !== undefined) { const m = normMobile_(p.mobile); if (m !== String(u.Mobile || '')) { u.Mobile = m; changed.push('mobile'); } }
    if (changed.length) writeRow_(users, u);
    let email = ctx.email;
    if (wantEmail) {
      renameEmailNoLock_(ctx.email, wantEmail);
      email = wantEmail;
      // Keep the current session alive under the new address.
      const ttl = Math.max(60, Math.round((new Date(ctx.exp).getTime() - Date.now()) / 1000));
      CacheService.getScriptCache().put('sess:' + ctx.token, JSON.stringify({ email: email, exp: ctx.exp }), ttl);
      changed.push('email');
      REQ = {};
      users = readTable_('Users');
      u = users.rows.find(function (r) { return lc_(r.Email) === email; });
    }
    if (changed.length) {
      logActivity_({ email: email, name: u.Name }, 'User', email, 'Account updated', 'Changed own ' + changed.join(', ') + '.');
      bumpRev_();
    }
    REQ.users = null;
    return { user: publicUser_(u, true), changed: changed };
  });
}

/* ---------- administrator: users ---------- */

function saveUser_(ctx, p) {
  requireRole_(ctx, ['Admin'], 'Only administrators can manage users.');
  const email = lc_(str_(p.email, 200, 'email'));
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw err_('VALIDATION', 'Enter a valid email address.', { fields: { Email: 'Enter a valid email address.' } });
  const patch = p.patch || {};
  return withLock_(function () {
    const tbl = readTable_('Users');
    let u = tbl.rows.find(function (r) { return lc_(r.Email) === email; });
    const isNew = !u;
    if (isNew) {
      u = blank_('Users');
      u.Email = email; u.Role = 'Member'; u.Active = true; u.CreatedAt = nowIso_();
      if (p.password === undefined || p.password === null || p.password === '') throw err_('VALIDATION', 'Set a starting password for the new member.', { fields: { password: 'Required for a new member.' } });
    }
    const before = JSON.parse(JSON.stringify(u));
    ['Name', 'Role', 'Department', 'Title', 'Active', 'Mobile'].forEach(function (f) { if (f in patch) u[f] = patch[f]; });
    u.Name = str_(u.Name, 120, 'Name') || email.split('@')[0];
    u.Department = str_(u.Department, 100, 'Department');
    u.Title = str_(u.Title, 100, 'Title');
    u.Mobile = normMobile_(u.Mobile);
    u.Active = truthy_(u.Active);
    if (ROLES.indexOf(u.Role) < 0) throw err_('VALIDATION', 'Choose Admin or Member.', { fields: { Role: 'Choose Admin or Member.' } });
    const otherAdmins = tbl.rows.filter(function (r) { return r.Role === 'Admin' && r.Active && lc_(r.Email) !== email; }).length;
    if (!isNew && before.Role === 'Admin' && before.Active && (u.Role !== 'Admin' || !u.Active) && otherAdmins === 0) {
      throw err_('VALIDATION', 'At least one active administrator is required.');
    }
    let pwSet = false;
    if (p.password !== undefined && p.password !== null && p.password !== '') { setPassword_(u, p.password, true); pwSet = true; }
    if (isNew) appendRows_(tbl, [u]); else writeRow_(tbl, u);
    const changes = isNew ? [] : diff_(before, u, ['Name', 'Role', 'Department', 'Title', 'Active', 'Mobile']);
    logActivity_(ctx, 'User', email, isNew ? 'User added' : 'User updated',
      isNew ? u.Name + ' added as ' + u.Role + '.' : (changes.map(function (c) { return c.field + ': ' + (c.from || '—') + ' → ' + (c.to || '—'); }).concat(pwSet ? ['password reset'] : []).join('; ') || 'No changes'));
    REQ.users = null;
    bumpRev_();
    return { user: publicUser_(u, true), created: isNew };
  });
}

function resetPassword_(ctx, p) {
  requireRole_(ctx, ['Admin'], 'Only administrators can reset passwords.');
  const email = lc_(p.email);
  const pw = checkNewPassword_(p.password);
  return withLock_(function () {
    const tbl = readTable_('Users');
    const u = tbl.rows.find(function (r) { return lc_(r.Email) === email; });
    if (!u) throw err_('NOT_FOUND', 'User not found.');
    setPassword_(u, pw, email !== ctx.email);
    writeRow_(tbl, u);
    logActivity_(ctx, 'User', email, 'Password reset', 'Password reset by ' + ctx.name + '.');
    REQ.users = null;
    return { reset: email };
  });
}

/* ---------- setup ---------- */

/** Creates the first administrator when the board has none. The temporary password is returned once, in the setup report. */
function ensureAdmin_() {
  const tbl = readTable_('Users');
  const noPw = tbl.rows.filter(function (r) { return r.Active && !r.PasswordHash && r.Role !== 'Admin'; }).length;
  const note = noPw ? ' ' + noPw + ' user(s) have no password yet — set one in the app: Settings ▸ Members ▸ Reset password.' : '';
  // An administrator only counts if they can actually sign in (a sheet from the older board has no passwords).
  if (tbl.rows.some(function (r) { return r.Role === 'Admin' && r.Active && r.PasswordHash; })) return '• Users: ' + tbl.rows.length + ' user(s); administrator present.' + note;
  const pw = AUTH.TEMP_PASSWORD;
  let u = tbl.rows.find(function (r) { return r.Role === 'Admin' && r.Active; }) || tbl.rows.find(function (r) { return lc_(r.Email) === AUTH.FIRST_ADMIN; });
  const isNew = !u;
  if (isNew) { u = blank_('Users'); u.Email = AUTH.FIRST_ADMIN; u.Name = 'Administrator'; u.CreatedAt = nowIso_(); }
  u.Role = 'Admin'; u.Active = true;
  setPassword_(u, pw, true);
  if (isNew) appendRows_(tbl, [u]); else writeRow_(tbl, u);
  REQ.users = null;
  return '• Users: administrator ' + lc_(u.Email) + ' ' + (isNew ? 'created' : 'given a password') + '. Temporary password: ' + pw + '  (shown only now — sign in and change it).' + note;
}

/**
 * Emergency only: run from the Apps Script editor if the administrator is locked out.
 * Gives the first active administrator a new temporary password and prints it in the execution log.
 */
function resetAdminPassword() {
  REQ = {};
  return withLock_(function () {
    const tbl = readTable_('Users');
    const u = tbl.rows.find(function (r) { return r.Role === 'Admin' && r.Active; });
    if (!u) return ensureAdmin_();
    const pw = AUTH.TEMP_PASSWORD;
    setPassword_(u, pw, true);
    writeRow_(tbl, u);
    const msg = 'Administrator ' + u.Email + ' — temporary password: ' + pw;
    console.log(msg);
    return msg;
  });
}
