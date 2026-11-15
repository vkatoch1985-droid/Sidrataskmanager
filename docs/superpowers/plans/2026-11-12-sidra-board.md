# Sidra Home Healthcare Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing Healthcare Initiatives Board into a Sidra Home Healthcare board with password login, member-only visibility, Initiatives and Projects pages, and WhatsApp and email notifications, reminders and reports.

**Architecture:** Static frontend (GitHub Pages) calls a Google Apps Script web app that stores everything in one Google Sheet. Existing board logic stays in `Code.gs`; new concerns live in `Auth.gs`, `WhatsApp.gs` and `Reports.gs`, which share Apps Script's single global scope. Every outgoing message is recorded in a `MessageLog` tab.

**Tech Stack:** Google Apps Script (V8), Google Sheets, vanilla JS/HTML/CSS with no build step, Node (built-in `node:test`, `node:vm`) for tests only.

**Spec:** `docs/superpowers/specs/2026-11-12-sidra-board-design.md`

**Source to copy from:** `/home/claude/zip_extract/` (frontend) and `/mnt/user-data/uploads/202cf4a9-Code.gs` (backend). Output goes to `/home/claude/sidra-board/`.

## Global Constraints

- Roles are exactly `Admin` and `Member`.
- Task stages and initiative stages are exactly `Under Design`, `Build`, `Parked`, `Completed`.
- Password minimum length 8. Hash = SHA-256 applied 10,000 rounds over salt + password. Hash and salt never leave the server.
- Lockout: 5 consecutive wrong passwords, 15 minutes.
- Login failure message is identical for unknown email and wrong password: `Email or password is incorrect.`
- `WA_API_KEY` is never returned to the browser; only `{ set: boolean, last4: string }`.
- Mobile numbers are stored as digits only, international format, 8 to 15 digits.
- A failed email or WhatsApp send never fails the request that triggered it.
- Default time zone `Asia/Dubai`. Session maximum 6 hours.
- No Justlife name, email, logo, spreadsheet ID or URL remains anywhere in the output.
- No frameworks and no build step in the frontend.

## Review Focus

1. Member calls `getTask`, `addComment`, `saveTask` or `getActivity` with the ID of a task they cannot see: must get NOT_FOUND, never data.
2. WhatsApp enabled but API key, sender ID or recipient mobile missing: message logged `failed` with a readable reason, task still saves.
3. Admin changes their own email while logged in: session keeps working and old email can no longer log in.
4. Sheet already contains `Live` / `Done` stages or `Manager` / `Viewer` roles from the old board: setup migrates them and nothing throws.
5. Reminder trigger runs twice in one day: members get one reminder, not two.

---

### Task 1: Project scaffold, branding strip and test simulator

**Files:**
- Create: `Code.gs` (copied, then edited), `appsscript.json`, `config.js`, `.nojekyll`
- Create: `tests/sim.js`, `tests/backend.test.js`

**Interfaces:**
- Produces: `tests/sim.js` exports `createEnv()` returning `{ call(action, payload, token), run(fnName, ...args), sheet(name) -> array of row objects, mail: [], fetches: [], setFetchHandler(fn), advance(ms) }`. It loads every `*.gs` in the project root into one `vm` context with fakes for `SpreadsheetApp`, `CacheService`, `PropertiesService`, `LockService`, `Utilities` (`getUuid`, `formatDate`, `computeDigest`, `base64Encode`, `DigestAlgorithm`, `Charset`), `MailApp`, `UrlFetchApp`, `ScriptApp`, `Session`, `ContentService`.
- Produces: setup function renamed `setupBoard()`.

- [ ] **Step 1:** Copy `Code.gs` and remove: `verifyIdToken_`, the `idToken`/`testEmail` branches of `login_`, `TEAM_ROSTER`, `seedTeam_`, `REMOVED_ACCOUNTS`, `isPlaceholderEmail_`, `TRACKER_28OCT`, `importHealthcareTracker`, `runBulkUpload`, `setMyTeam_` route, settings `AUTH_MODE`, `GOOGLE_CLIENT_ID`, `ALLOWED_DOMAINS`, `AUTO_PROVISION`, `DEFAULT_ROLE`. Set `CONFIG.SPREADSHEET_ID = ''`, `APP_VERSION = '2.0.0'`, `APP_NAME = 'Sidra Project Board'`, `ORG_NAME = 'Sidra Home Healthcare'`, `BOARD_URL = ''`, `DEPARTMENTS = 'Nursing, Operations'`, `CATEGORIES = 'Clinical, Operations, Marketing, Others'`, `FORUMS = 'Weekly Review'`.
- [ ] **Step 2:** Write `tests/sim.js`.
- [ ] **Step 3:** Write test `setup creates all tabs`: after `env.run('setupBoard')`, `env.sheet('Tasks')`, `Users`, `Settings`, `MessageLog` exist (MessageLog arrives in Task 5; assert the first three now). Write test `no Justlife text remains`: `grep -ri justlife` over project root (excluding `docs/`) finds nothing.
- [ ] **Step 4:** Run `node --test tests/` and expect PASS.

### Task 2: Stage merge and role reduction

**Files:** Modify `Code.gs`; Test `tests/backend.test.js`

**Interfaces:**
- Produces: `TASK_STAGES = ['Under Design','Build','Parked','Completed']`, `INITIATIVE_STAGES` identical, `ROLES = ['Admin','Member']`, `STAGE_TO_STATUS = {'Under Design':'Not Started', Build:'In Progress', Parked:'Not Started', Completed:'Completed'}`, `STAGE_PROGRESS = {Parked:0,'Under Design':25, Build:60, Completed:100}`, `migrateLegacy_()` called from `setupBoard()`.

- [ ] **Step 1:** Tests: saving a task with `Stage:'Completed'` yields `Status:'Completed'`, `Progress:100` and a `CompletedDate`; a sheet row with `Stage:'Live'` or `'Done'` becomes `'Completed'` after `setupBoard`; a user row with `Role:'Manager'` or `'Viewer'` becomes `'Member'`; `saveTask` with `Stage:'Live'` is rejected with VALIDATION.
- [ ] **Step 2:** Run, expect FAIL.
- [ ] **Step 3:** Implement. Replace `isManager_(ctx)` with `isAdmin_(ctx)` (`ctx.role === 'Admin'`) at every call site; remove Manager/Viewer branches; `STAGE_CAPS` default `Build=8, Under Design=8`.
- [ ] **Step 4:** Run, expect PASS.

### Task 3: Password authentication

**Files:** Create `Auth.gs`; Modify `Code.gs` (`SCHEMA.Users`, routes, `publicUser_`, `saveUser_`, `ensureAdmin_`); Test `tests/auth.test.js`

**Interfaces:**
- Produces: `hashPassword_(password, salt) -> hex string`; `newSalt_() -> string`; `login_({email, password}) -> {token, expiresAt, user, mustChangePassword}`; routes `changePassword {current, next}`, `updateMyAccount {email?, name?, mobile?, currentPassword}` (admin only for email), `resetPassword {email, password}` (admin only); `saveUser` accepts `patch.Mobile` and `password` (required when creating); `normMobile_(v) -> digits or throws VALIDATION`.
- Users columns added: `Mobile`, `PasswordHash`, `PasswordSalt`, `MustChangePassword` (bool), `FailedLogins` (num), `LockedUntil` (ts).
- `ensureAdmin_()` creates `admin@sidra.local` with a 12-character random password when no active Admin exists and returns a report line containing the password.
- While `MustChangePassword` is true, every route except `changePassword` and `logout` returns error code `PASSWORD_CHANGE_REQUIRED`.

- [ ] **Step 1:** Tests: setup report contains the temp password and it logs in; wrong password and unknown email both return `Email or password is incorrect.`; 5 wrong attempts then the right password returns `LOCKED`; after `env.advance(15*60*1000 + 1000)` login works; `bootstrap` before changing temp password returns `PASSWORD_CHANGE_REQUIRED`; `changePassword` with 7 characters is VALIDATION; member cannot call `resetPassword` or `saveUser` (FORBIDDEN); admin creates member with mobile `+971 50 123 4567` and it is stored `971501234567`; `bootstrap` output for any user contains no `PasswordHash` or `PasswordSalt` anywhere (`JSON.stringify` search); admin `updateMyAccount` with new email: same token still works, old email cannot log in (Review Focus 3).
- [ ] **Step 2:** Run, expect FAIL.
- [ ] **Step 3:** Implement `Auth.gs`.
- [ ] **Step 4:** Run, expect PASS.

### Task 4: Member visibility

**Files:** Modify `Code.gs` (`bootstrap_`, `getTask_`, `getActivity_`, `addComment_`, `saveTask_`, `publicUser_`); Test `tests/visibility.test.js`

**Interfaces:**
- Produces: `canSeeTask_(ctx, task) -> boolean` (Admin true; else assignee, collaborator, creator, or owner of a subtask); `visibleTasks_(ctx, rows)`; `requireVisible_(ctx, task)` throwing NOT_FOUND.
- `publicUser_(u, forAdmin)` includes `Mobile` only when `forAdmin`. Members receive `Email`, `Name`, `Department`, `Active` only.

- [ ] **Step 1:** Tests with admin A, members M1, M2 and four tasks (assigned to M1; M1 collaborator; M1 owns a subtask on a task assigned to M2; unrelated): M1 `bootstrap` returns exactly the first three; `commentStats`, `recentComments`, `activity`, `initiatives`, `projects` contain nothing tied only to the fourth; `getTask`, `addComment`, `saveTask`, `getActivity{entityId}` on the fourth return NOT_FOUND (Review Focus 1); M1 can tick their own subtask on the third; M1's `users` list has no `Mobile`; admin sees all four and `Mobile`; member `settings` contains no `WA_*` or `ADMIN_MOBILE` keys.
- [ ] **Step 2:** Run, expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, expect PASS.

### Task 5: Message log and channel fan-out

**Files:** Create `WhatsApp.gs`; Modify `Code.gs` (`SCHEMA.MessageLog`, `notify_`, `emailNotifications_`, settings, `saveSettings_`, `publicSettings_`, `doGet`/`doPost`); Test `tests/messaging.test.js`

**Interfaces:**
- Produces: `logMessage_({recipient, channel, kind, entityId, summary, status, providerId, error}) -> MessageID`; `sendEmail_(user, subject, html, text, kind, entityId)`; `sendWhatsApp_(user, template, params, text, kind, entityId)`; `deliver_(recipientEmails, kind, entityId, subject, text, template, params)` calling both; `retryFailedWhatsApp()` (trigger, max 3 attempts); `handleWebhook_(query, body)`; routes `getMessageLog {channel?, status?, recipient?, limit?}`, `submitTemplates`, `templateStatus`, `sendTestMessage` (all admin only).
- Settings added: `WA_ENABLED`, `WA_PROVIDER` (`meta` or `generic`), `WA_API_KEY`, `WA_PHONE_ID`, `WA_BUSINESS_ID`, `WA_GENERIC_URL`, `WA_LANG` (`en`), `ADMIN_MOBILE`, `WEBHOOK_TOKEN` (generated by setup), `REMINDERS_ENABLED`, `REPORT_DAILY`, `REPORT_WEEKLY`, `REPORT_MONTHLY`.
- Templates: `task_assigned`, `task_updated`, `task_reminder`, `admin_report`, each with body parameters `{{1}}` name and `{{2}}` text.
- Meta endpoints and payload shapes: confirm against Meta's current Cloud API documentation before coding this task; record the API version used in a constant `WA_API_VERSION`.
- `notify_` additionally fires for stage, due-date and priority changes by someone other than the assignee (type `UPDATED`).

- [ ] **Step 1:** Tests: assigning a task writes one `email` and one `whatsapp` row to `MessageLog` for the assignee; with fetch handler returning a provider message ID the WhatsApp row is `sent` with `ProviderMessageID`; with no API key the row is `failed`, `Error` mentions the key, and `saveTask` still returns ok (Review Focus 2); member without mobile gives `failed` with `No WhatsApp number`; webhook POST with correct token and a `delivered` status updates the row, wrong token changes nothing; `retryFailedWhatsApp` retries a failed row and stops after `Attempts = 3`; `saveSettings` with `WA_API_KEY:'abcd1234wxyz'` then `bootstrap` (admin) shows `{set:true,last4:'wxyz'}` and the full key appears nowhere in the response; member cannot call `getMessageLog`.
- [ ] **Step 2:** Run, expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, expect PASS.

### Task 6: Reminders and reports

**Files:** Create `Reports.gs`; Modify `Code.gs` (remove `runDeadlineScan`, update `ensureTrigger_`); Test `tests/reports.test.js`

**Interfaces:**
- Consumes: `deliver_`, `sendEmail_`, `sendWhatsApp_`, `logMessage_` from Task 5.
- Produces: `runMemberReminders()` (08:00 daily); `runDailyReport()` (18:00 daily); `runWeeklyReport()` (Monday 08:00); `runMonthlyReport()` (day 1, 08:00); `buildReport_(period, fromYmd, toYmd) -> {totals:{byStage, completed, overdue, notStarted, dueNext7}, members:[{email,name,open,overdue,completed}], projects:[{id,name,status,progress,open,overdue}], html, text}`; route `sendReportNow {period}` (admin only); route `getReport {period}` returning the same object for the dashboard.
- Reminder dedupe key in `PropertiesService`: `REM:<email>:<yyyy-MM-dd>`.

- [ ] **Step 1:** Tests: with fixed tasks (one overdue, one due tomorrow not started, one due tomorrow in Build, one Parked overdue, one Completed) `runMemberReminders` sends each owner one message listing the first three and not the Parked or Completed ones; running it twice the same day sends nothing new (Review Focus 5); `buildReport_('daily', …)` totals match hand-counted values; `sendReportNow` as admin logs one email and one WhatsApp row of kind `manual`; as member FORBIDDEN; `REPORT_DAILY = FALSE` makes `runDailyReport` send nothing; `setupBoard` installs triggers for all five handlers plus `retryFailedWhatsApp` exactly once when run twice.
- [ ] **Step 2:** Run, expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, expect PASS.

### Task 7: Frontend login pages and Sidra theme

**Files:** Create `index.html`, `member.html`, `style.css`, `app.js` (copied then edited), `logo.png` (rendered from the supplied PDF)

**Interfaces:**
- Consumes: `login`, `changePassword`, `config` actions.
- Theme tokens in `:root`: `--brand-900:#7A1E00`, `--brand-700:#AD2600`, `--accent-500:#F25C05`, `--accent-300:#FFB400`, `--danger:#E3120B`, gradient `linear-gradient(90deg,#FFB400,#F25C05,#E3120B)`.

- [ ] **Step 1:** Remove Google Identity code, JSONP transport, `askTeam`, test-email login and Manager/Viewer UI from `app.js`. Add email and password form, forced change-password screen, and "Change password" in the user menu.
- [ ] **Step 2:** `member.html` is the same shell with heading `Team member sign in` and a link to the admin page; `index.html` heading `Admin sign in` with a link to the member page. Both load `app.js`.
- [ ] **Step 3:** Apply theme tokens across `style.css`; replace logo and all visible names.
- [ ] **Step 4:** Verify: serve the folder with a local stub API built on `tests/sim.js`, open both pages in a browser, log in as admin and as member, and confirm the forced password change appears.

### Task 8: Frontend screens

**Files:** Modify `index.html`, `member.html`, `app.js`, `style.css`

**Interfaces:**
- Consumes: `getMessageLog`, `getReport`, `sendReportNow`, `submitTemplates`, `templateStatus`, `sendTestMessage`, `saveSettings`, `saveUser`, `resetPassword`, `updateMyAccount`.

- [ ] **Step 1:** Sidebar Workspace order: Meeting board, My tasks, Kanban board, Initiatives, Projects, Overview. Route Initiatives and Projects to the existing `renderInitiatives` / `renderProjects`.
- [ ] **Step 2:** Kanban columns from `TASK_STAGES` (four columns); update every stage list, colour map and label in `app.js`.
- [ ] **Step 3:** Overview (admin): "Project status" table and "Reminders and messages" panel (today's sent / delivered / failed counts, filterable log, "Send complete report now" with period choice).
- [ ] **Step 4:** Settings (admin): "WhatsApp and reports" section (provider, API key field showing only last four, sender ID, business ID, admin mobile, switches, webhook URL to copy, submit templates, template status, send test); user form with mobile and password; admin account section.
- [ ] **Step 5:** Hide admin-only controls for members.
- [ ] **Step 6:** Verify in a browser against the stub API: every sidebar page renders for admin and member with no console errors; dragging a kanban card changes its stage.

### Task 9: README and package

**Files:** Create `README.md`; produce `sidra-board.zip`

- [ ] **Step 1:** README covers: create the sheet and script, paste the four `.gs` files, run `setupBoard`, note the temporary admin password, deploy as web app (execute as me, anyone), set `config.js`, publish to GitHub Pages, first login, add members, WhatsApp setup (key, IDs, webhook URL, template approval, test message), report schedule, email quota.
- [ ] **Step 2:** Run `node --test tests/` and expect all PASS; run the Justlife grep and expect no matches.
- [ ] **Step 3:** Zip the project (excluding `docs/` and `tests/` from the upload set, included in a separate folder) and send it.
