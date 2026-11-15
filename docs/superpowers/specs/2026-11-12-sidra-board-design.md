# Sidra Home Healthcare Board: design spec

Date: 2026-11-12
Status: awaiting review

## 1. Goal

Produce a new copy of the existing Healthcare Initiatives Board for Sidra Home Healthcare, with password login in place of Google sign-in, member-only task visibility, full Initiatives and Projects pages, and WhatsApp and email notifications, reminders and reports.

Success means: the admin can deploy it to a new Google Sheet and GitHub Pages site, log in, add members, and from then on members are notified and reminded automatically while the admin receives daily, weekly and monthly reports and can see the delivery status of every message.

## 2. Starting point

The existing project (frontend on GitHub Pages, backend in Google Apps Script, data in Google Sheets) is copied and extended. Existing task, comment, initiative, project, activity-log and in-app notification logic is kept.

Removed from the copy:
- Google sign-in (`verifyIdToken_`, `GOOGLE_CLIENT_ID`, `ALLOWED_DOMAINS`, `AUTO_PROVISION`, `AUTH_MODE`, first-name profile claiming).
- Justlife roster (`TEAM_ROSTER`, `seedTeam_`, `REMOVED_ACCOUNTS`), the 53-task tracker import (`TRACKER_28OCT`, `importHealthcareTracker`), the hard-coded spreadsheet ID, the Justlife logo and board URL.

## 3. Files

| File | Responsibility |
|---|---|
| `Code.gs` | Existing board logic: routing, tasks, comments, initiatives, projects, users, settings, data access, setup. |
| `Auth.gs` | Password login, hashing, lockout, change password, admin account creation, admin credential update. |
| `WhatsApp.gs` | Provider adapters, sending, template submission and status, delivery webhook, retry. |
| `Reports.gs` | Member reminders, admin daily/weekly/monthly reports, send-now, time triggers. |
| `index.html` | App shell and admin login. |
| `member.html` | Member login page; after login it loads the same app. |
| `app.js`, `style.css` | Frontend logic and Sidra theme. |
| `config.js` | Apps Script web-app URL only. |
| `logo.png` | Sidra logo, converted from the supplied PDF. |
| `README.md` | Deployment and setup steps. |

All `.gs` files share one global scope in Apps Script.

## 4. Login and accounts

- Roles: `Admin` and `Member`. Existing `Manager` and `Viewer` roles are removed from the UI; server permission checks treat only Admin as privileged.
- `Users` tab gains: `Mobile` (WhatsApp number, international format, digits only), `PasswordHash`, `PasswordSalt`, `MustChangePassword`, `FailedLogins`, `LockedUntil`.
- Hash: per-user random salt, SHA-256 applied repeatedly (10,000 rounds) over salt + password. Hash and salt never leave the server.
- Setup creates one admin (`admin@sidra.local` unless an admin exists) with a random temporary password printed once in the setup report. `MustChangePassword` forces a change at first login.
- Admin can change their own email, password and mobile number. Changing email reuses the existing `renameEmailNoLock_` so history follows.
- Admin creates a member with name, email, WhatsApp number, team and a starting password. Admin can reset a member's password. Members change their own password under their profile (current password required).
- Password rule: at least 8 characters.
- Lockout: 5 consecutive wrong passwords lock the account for 15 minutes.
- Login error text is the same for unknown email and wrong password.
- `index.html` accepts any account; `member.html` is a simpler branded page for members. Both call the same `login` action. Sessions stay in `CacheService` as today (max 6 hours).

## 5. Visibility

- Admin receives all tasks, initiatives, projects, users, activity and settings.
- A member receives only tasks where they are `AssignedTo`, in `Collaborators`, or the owner of at least one subtask. Initiatives and projects are limited to those linked to such tasks or where the member is owner or listed member. Comments, comment stats and activity are limited to visible tasks.
- Filtering happens in `bootstrap_`, `getTask_` and `getActivity_` on the server. `getTask_` on a task the member cannot see returns NOT_FOUND.
- Members receive other users' name and email only (for mentions and subtask owners); mobile numbers go only to the admin.
- Members may edit a visible task as today (assignee, collaborator or creator), and tick subtasks they own.

## 6. Screens

- Sidebar, Workspace group, in order: Meeting board, My tasks, Kanban board, Initiatives, Projects, Overview. Initiatives and Projects are visible to members but list only what they can see.
- Initiatives page: cards or table with stage, owner, target date and progress calculated from linked tasks; create, edit and archive (admin).
- Projects page: same pattern, with parent initiative and status.
- Admin "Project status" panel on Overview: every project with its stage, progress, open and overdue task counts.
- Kanban columns are task stages: Under Design, Build, Parked, Completed. Dragging a card changes its stage.
- Stage rename: task stage `Live` and `Done` merge into `Completed`. Stage list becomes Under Design, Build, Parked, Completed. Initiative stages become Under Design, Build, Parked, Completed. Setup migrates existing `Live` and `Done` values to `Completed`.
- Admin dashboard gains a "Reminders and messages" panel (section 8).
- Settings gains a "WhatsApp and reports" section (section 9), and Users gains the mobile and password fields.

## 7. Notifications

Every notification already passes through `notify_()`. After writing the in-app row it now also queues an email and a WhatsApp message for each recipient, subject to settings.

Events sent to members by all three channels: task assigned, reassigned, added as collaborator, subtask assigned, task updated by someone else (stage, due date or priority change), mention, issue, note, plus the reminders in section 8.

Email is sent with `MailApp` from the deploying Google account. Messages are skipped, and logged as failed with the reason, when the recipient has no email, the quota is exhausted, or email is switched off.

## 8. Message log, reminders and reports

New `MessageLog` tab: `MessageID`, `CreatedAt`, `Recipient`, `Channel` (email or whatsapp), `Kind` (notification, reminder, daily, weekly, monthly, manual, test), `EntityID`, `Summary`, `Status` (queued, sent, delivered, read, failed), `ProviderMessageID`, `Error`, `Attempts`, `UpdatedAt`.

- WhatsApp status moves to delivered or read when the provider's webhook reports it. Failed WhatsApp sends are retried by a 15-minute trigger, up to 3 attempts.
- The admin panel lists the log, newest first, with filters for channel, status and member, and counts of sent, delivered and failed for today.

Triggers (time zone from Settings, default Asia/Dubai):
- 08:00 daily, member reminders: tasks not started with a due date within `DUE_SOON_DAYS`, tasks due soon, and overdue tasks. One message per member listing their tasks. Parked and archived tasks are skipped.
- 18:00 daily, admin daily report.
- Monday 08:00, admin weekly report. 1st of month 08:00, admin monthly report.

Report content: totals by stage, completed in the period, overdue, not started, due in the next 7 days, a per-member line (open, overdue, completed), and project status. Email carries the full HTML table; WhatsApp carries a short text summary with a link to the board.

"Send complete report now" in the admin dashboard sends the same report immediately to the admin's email and WhatsApp.

## 9. WhatsApp

- Settings (admin only): `WA_PROVIDER`, `WA_API_KEY`, `WA_PHONE_ID` (sender), `WA_BUSINESS_ID`, `ADMIN_MOBILE`, `WA_ENABLED`, plus on/off switches for reminders and each report.
- Values are saved in the `Settings` tab. `WA_API_KEY` is write-only from the browser: the server returns only whether it is set and its last four characters.
- `sendWhatsApp_(to, templateName, params, fallbackText)` looks up the provider and calls its adapter. The first adapter is Meta WhatsApp Cloud API; a generic adapter (URL, token and JSON body template in Settings) covers other providers.
- Templates: `task_assigned`, `task_updated`, `task_reminder`, `admin_report`. The admin dashboard has "Submit templates for approval", which creates them through the provider, and shows each as pending, approved or rejected. "Send test message" sends to the admin's own number.
- Delivery webhook: the provider posts status updates to the web-app URL with a secret token in the query string (generated by setup, shown in Settings). Requests without the right token are ignored.
- Exact Meta endpoints and payloads are to be confirmed against Meta's current documentation during the build.

## 10. Error handling

- A failure in email or WhatsApp never blocks saving a task; it is recorded in `MessageLog`.
- Missing API key, missing mobile number, unapproved template and provider errors are logged with a readable reason.
- Existing optimistic-locking, validation and lock behaviour is unchanged.

## 11. Testing

- A Node test file runs the `.gs` files against a small in-memory simulator of the Apps Script services used (Spreadsheet, Cache, Properties, Lock, Utilities, MailApp, UrlFetchApp).
- Covered: setup, login success and failure, lockout, forced password change, member visibility (assigned, collaborator, subtask owner, none), admin-only actions refused for members, API key never returned, notification fan-out to the log, retry, webhook status update, reminder selection, report totals, stage migration.
- Frontend checked by loading both login pages and the main views in a browser against the simulator.

## 12. Out of scope

- Incoming WhatsApp replies.
- Self-service "forgot password" (admin resets instead).
- Per-member notification preferences.
