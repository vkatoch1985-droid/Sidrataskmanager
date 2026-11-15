'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createEnv, bootEnv } = require('./sim');

test('setup prints a temporary admin password that logs in', () => {
  const env = createEnv();
  const report = env.run('setupBoard');
  const pw = /temporary password:\s*(\S+)/i.exec(report)[1];
  assert.ok(pw.length >= 12);
  const r = env.call('login', { email: 'admin@sidra.local', password: pw });
  assert.ok(r.ok);
  assert.strictEqual(r.data.mustChangePassword, true);
  assert.strictEqual(r.data.user.Role, 'Admin');
});

test('wrong password and unknown email give the same message', () => {
  const { env } = bootEnv();
  const a = env.call('login', { email: 'admin@sidra.local', password: 'nope-nope' });
  const b = env.call('login', { email: 'ghost@nowhere.com', password: 'nope-nope' });
  assert.strictEqual(a.ok, false);
  assert.strictEqual(a.error.message, 'Email or password is incorrect.');
  assert.strictEqual(b.error.message, a.error.message);
  assert.strictEqual(b.error.code, a.error.code);
});

test('five wrong passwords lock the account for 15 minutes', () => {
  const { env } = bootEnv();
  for (let i = 0; i < 5; i++) env.call('login', { email: 'admin@sidra.local', password: 'wrong-pass' });
  const locked = env.call('login', { email: 'admin@sidra.local', password: 'AdminPass1' });
  assert.strictEqual(locked.ok, false);
  assert.strictEqual(locked.error.code, 'LOCKED');
  env.advance(15 * 60 * 1000 + 1000);
  assert.ok(env.call('login', { email: 'admin@sidra.local', password: 'AdminPass1' }).ok);
});

test('a successful login resets the wrong-password counter', () => {
  const { env } = bootEnv();
  for (let i = 0; i < 4; i++) env.call('login', { email: 'admin@sidra.local', password: 'wrong-pass' });
  assert.ok(env.call('login', { email: 'admin@sidra.local', password: 'AdminPass1' }).ok);
  for (let i = 0; i < 4; i++) env.call('login', { email: 'admin@sidra.local', password: 'wrong-pass' });
  assert.ok(env.call('login', { email: 'admin@sidra.local', password: 'AdminPass1' }).ok);
});

test('temporary password must be changed before anything else works', () => {
  const env = createEnv();
  const pw = /temporary password:\s*(\S+)/i.exec(env.run('setupBoard'))[1];
  const tok = env.call('login', { email: 'admin@sidra.local', password: pw }).data.token;
  const b = env.call('bootstrap', {}, tok);
  assert.strictEqual(b.ok, false);
  assert.strictEqual(b.error.code, 'PASSWORD_CHANGE_REQUIRED');
  assert.strictEqual(env.call('changePassword', { current: pw, next: 'short77' }, tok).error.code, 'VALIDATION');
  assert.strictEqual(env.call('changePassword', { current: 'not-it', next: 'LongEnough1' }, tok).ok, false);
  assert.ok(env.call('changePassword', { current: pw, next: 'LongEnough1' }, tok).ok);
  assert.ok(env.call('bootstrap', {}, tok).ok);
  assert.strictEqual(env.call('login', { email: 'admin@sidra.local', password: pw }).ok, false);
});

test('admin creates a member; mobile is normalised; member must change password', () => {
  const { env, adminToken } = bootEnv();
  const r = env.call('saveUser', { email: 'Sara@Sidra.com', password: 'StartPass1', patch: { Name: 'Sara', Role: 'Member', Mobile: '+971 50 123 4567' } }, adminToken);
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.strictEqual(r.data.user.Mobile, '971501234567');
  const l = env.call('login', { email: 'sara@sidra.com', password: 'StartPass1' });
  assert.ok(l.ok);
  assert.strictEqual(l.data.mustChangePassword, true);
});

test('creating a member needs a password of at least 8 characters and a valid mobile', () => {
  const { env, adminToken } = bootEnv();
  assert.strictEqual(env.call('saveUser', { email: 'a@x.com', patch: { Name: 'A' } }, adminToken).ok, false);
  assert.strictEqual(env.call('saveUser', { email: 'a@x.com', password: 'short', patch: { Name: 'A' } }, adminToken).ok, false);
  assert.strictEqual(env.call('saveUser', { email: 'a@x.com', password: 'LongEnough1', patch: { Name: 'A', Mobile: '12ab' } }, adminToken).ok, false);
  assert.strictEqual(env.sheet('Users').length, 1);
});

test('members cannot manage users, reset passwords or change settings', () => {
  const b = bootEnv();
  const m = b.addMember('m1@x.com', 'M One');
  assert.strictEqual(b.env.call('saveUser', { email: 'z@x.com', password: 'LongEnough1', patch: { Name: 'Z' } }, m).error.code, 'FORBIDDEN');
  assert.strictEqual(b.env.call('resetPassword', { email: 'admin@sidra.local', password: 'Hacked1234' }, m).error.code, 'FORBIDDEN');
  assert.strictEqual(b.env.call('deleteUser', { email: 'admin@sidra.local' }, m).error.code, 'FORBIDDEN');
  assert.strictEqual(b.env.call('saveSettings', { values: { APP_NAME: 'x' } }, m).error.code, 'FORBIDDEN');
  assert.strictEqual(b.env.call('updateMyAccount', { email: 'new@x.com', currentPassword: 'MemberPass2' }, m).error.code, 'FORBIDDEN');
});

test('admin resets a member password; member is forced to change it', () => {
  const b = bootEnv();
  b.addMember('m1@x.com', 'M One');
  assert.ok(b.env.call('resetPassword', { email: 'm1@x.com', password: 'ResetPass9' }, b.adminToken).ok);
  assert.strictEqual(b.env.call('login', { email: 'm1@x.com', password: 'MemberPass2' }).ok, false);
  const l = b.env.call('login', { email: 'm1@x.com', password: 'ResetPass9' });
  assert.ok(l.ok);
  assert.strictEqual(l.data.mustChangePassword, true);
});

test('member changes own password and mobile', () => {
  const b = bootEnv();
  const m = b.addMember('m1@x.com', 'M One');
  assert.ok(b.env.call('changePassword', { current: 'MemberPass2', next: 'BrandNew88' }, m).ok);
  assert.ok(b.env.call('login', { email: 'm1@x.com', password: 'BrandNew88' }).ok);
  const r = b.env.call('updateMyAccount', { mobile: '00971 55 000 1111', currentPassword: 'BrandNew88' }, m);
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.strictEqual(r.data.user.Mobile, '971550001111');
});

test('password hashes and salts never reach the browser', () => {
  const b = bootEnv();
  const m = b.addMember('m1@x.com', 'M One');
  [b.adminToken, m].forEach((tok) => {
    const txt = JSON.stringify(b.env.call('bootstrap', {}, tok));
    assert.ok(!/PasswordHash|PasswordSalt/.test(txt));
    b.env.sheet('Users').forEach((u) => { assert.ok(u.PasswordHash.length > 20); assert.ok(txt.indexOf(u.PasswordHash) < 0); assert.ok(txt.indexOf(u.PasswordSalt) < 0); });
  });
});

test('passwords are not stored in plain text', () => {
  const b = bootEnv();
  assert.ok(JSON.stringify(b.env.sheet('Users')).indexOf('AdminPass1') < 0);
});

test('admin changes own email: session survives, old email stops working', () => {
  const b = bootEnv();
  const r = b.env.call('updateMyAccount', { email: 'Boss@Sidra.com', mobile: '971501112222', currentPassword: 'AdminPass1' }, b.adminToken);
  assert.ok(r.ok, JSON.stringify(r.error));
  const boot = b.env.call('bootstrap', {}, b.adminToken);
  assert.ok(boot.ok, JSON.stringify(boot.error));
  assert.strictEqual(boot.data.me.email, 'boss@sidra.com');
  assert.strictEqual(b.env.call('login', { email: 'admin@sidra.local', password: 'AdminPass1' }).ok, false);
  assert.ok(b.env.call('login', { email: 'boss@sidra.com', password: 'AdminPass1' }).ok);
});

test('updateMyAccount needs the current password', () => {
  const b = bootEnv();
  assert.strictEqual(b.env.call('updateMyAccount', { mobile: '971501112222', currentPassword: 'wrong' }, b.adminToken).ok, false);
});

test('deactivated user cannot sign in and existing session stops', () => {
  const b = bootEnv();
  const m = b.addMember('m1@x.com', 'M One');
  b.env.call('saveUser', { email: 'm1@x.com', patch: { Active: false } }, b.adminToken);
  assert.strictEqual(b.env.call('bootstrap', {}, m).ok, false);
  assert.strictEqual(b.env.call('login', { email: 'm1@x.com', password: 'MemberPass2' }).ok, false);
});

test('the last admin cannot be demoted or deactivated', () => {
  const b = bootEnv();
  assert.strictEqual(b.env.call('saveUser', { email: 'admin@sidra.local', patch: { Role: 'Member' } }, b.adminToken).ok, false);
  assert.strictEqual(b.env.call('saveUser', { email: 'admin@sidra.local', patch: { Active: false } }, b.adminToken).ok, false);
});

test('logout ends the session', () => {
  const b = bootEnv();
  b.env.call('logout', {}, b.adminToken);
  assert.strictEqual(b.env.call('bootstrap', {}, b.adminToken).ok, false);
});
