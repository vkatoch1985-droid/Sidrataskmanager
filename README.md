# Sidra Project Board

Task, initiative and project board for **Sidra Home Healthcare**.
Website on GitHub Pages · backend in Google Apps Script · data in one Google Sheet.

```
Browser (GitHub Pages)  ──POST──▶  Apps Script web app  ──▶  Google Sheet
 index.html  (admin sign in)        Code.gs      board logic         Tasks, Users, MessageLog, …
 member.html (member sign in)       Auth.gs      passwords, accounts
 app.js / style.css / config.js     WhatsApp.gs  email + WhatsApp sending and delivery status
                                    Reports.gs   reminders and admin reports
```

## What it does

- **Sign in with email and password.** No Google sign-in. Admins use `index.html`, members use `member.html`.
- **Two roles.** The admin sees everything. A member sees only tasks assigned to them, tasks they collaborate on, tasks where they own a subtask, and tasks they created.
- **Pages:** Meeting board, My tasks, Kanban board, Initiatives, Projects, Overview.
- **Stages:** Under Design → Build → Parked → Completed (Kanban columns, task stage and initiative stage).
- **Admin Overview:** status and current stage of every project and initiative, plus a log of every email and WhatsApp message with its status.
- **Notifications** to members by in-app bell, email and WhatsApp when a task is assigned or updated.
- **Automatic reminders** to members every morning for tasks that are overdue, due soon, or not started with the deadline near.
- **Reports** to the admin by email and WhatsApp: daily, weekly, monthly, and "Send complete report now".

## Set up (about 20 minutes)

### 1. Google Sheet and script

1. Create a new Google Sheet. Name it anything.
2. In the sheet: **Extensions ▸ Apps Script**.
3. Delete the sample code. Create four script files named `Code`, `Auth`, `WhatsApp` and `Reports`, and paste the contents of `Code.gs`, `Auth.gs`, `WhatsApp.gs` and `Reports.gs` into them.
4. Optional: **Project Settings ▸ Show "appsscript.json"**, then paste `appsscript.json`.
5. Select the function **`setupBoard`** and click **Run**. Approve the permissions Google asks for.
6. Open **Execution log**. Find the line:
   `administrator admin@sidra.local created. Temporary password: …`
   **Copy that password now.** It is shown only this once.

`setupBoard` creates every tab, the settings, the first admin and the timers. It is safe to run again; it never deletes data.

### 2. Deploy the web app

1. **Deploy ▸ New deployment ▸ Web app**.
2. Execute as: **Me**. Who has access: **Anyone**.
3. Click **Deploy** and copy the **Web app URL** (it ends with `/exec`).

Each time you change the script later: **Deploy ▸ Manage deployments ▸ Edit ▸ Version: New version ▸ Deploy**.

### 3. Website

1. Open `config.js` and paste the web app URL into `API_URL`.
2. Upload these files to a GitHub repository: `index.html`, `member.html`, `app.js`, `style.css`, `config.js`, `logo.png`, `logo-mark.png`, `.nojekyll`.
3. Repository **Settings ▸ Pages ▸ Deploy from a branch ▸ main / root**.
4. Your addresses:
   - Admin: `https://<user>.github.io/<repo>/`
   - Members: `https://<user>.github.io/<repo>/member.html`

### 4. First sign in

1. Open the admin address. Sign in with `admin@sidra.local` and the temporary password.
2. Choose your own password when asked.
3. **Settings ▸ My profile ▸ Update my details**: set your real email and your WhatsApp number. Reports go to these.
4. **Settings ▸ Configuration**: paste the website address into **Board link** so messages contain a working link.

### 5. Add members

**Settings ▸ Members & passwords ▸ Add member**: name, email, WhatsApp number and a starting password.
Give the member their email, starting password and the member address. They choose their own password at first sign in.

- Forgotten password: **Reset password** in the same table.
- Five wrong passwords lock an account for 15 minutes.
- Admin locked out: in Apps Script run **`resetAdminPassword`** and read the new temporary password in the execution log.

## WhatsApp

**Settings ▸ WhatsApp & reports.**

### With Meta WhatsApp Cloud API

You need a Meta Business account with WhatsApp set up (developers.facebook.com ▸ your app ▸ WhatsApp).

1. Paste the **access token** into *API key*, the **Phone number ID** into *Sender*, and the **WhatsApp Business Account ID**. Use a permanent (system user) token; the temporary token Meta shows on the setup page expires in a day.
2. Set *Send WhatsApp messages* to **On** and click **Save**.
3. Click **Submit for approval**. This sends four message templates to Meta. Click **Check status** until they show **Approved**. Until then WhatsApp messages fail (and are logged as failed); emails still go out.
4. In Meta ▸ WhatsApp ▸ Configuration ▸ Webhook, paste the **Delivery-status webhook** address and the **Verify token** shown on the settings page, and subscribe to **messages**. This is what turns "Sent" into "Delivered" in the log.
5. Click **Send me a test message**.

The API key is saved in the `Settings` tab of your sheet. The website never displays it again; it only shows the last four characters. Anyone who can open the sheet can read the key, so share the sheet only with people you trust.

### With another provider

Choose **Other provider (generic)** and enter the provider's URL. The board sends:

```
POST <your URL>
Authorization: Bearer <API key>
{ "to": "971501234567", "message": "text…", "template": "task_assigned", "params": ["Sara", "text…"] }
```

Providers that expect a different format need a small change in `waSendGeneric_` in `WhatsApp.gs`.

### Status meanings

| Status | Meaning |
|---|---|
| Sent | The provider accepted the message. Email always stops here: email has no delivery receipt. |
| Delivered / Read | The provider confirmed it through the webhook (WhatsApp only). |
| Failed | Not sent. The reason is shown. Failed WhatsApp messages are retried every 15 minutes, up to 3 attempts. |

## Schedule

All times are in the time zone from **Settings ▸ Configuration** (default Asia/Dubai). Google runs timers within the hour, not on the minute.

| When | What |
|---|---|
| Daily, about 08:00 | Reminder to each member with overdue / due-soon / not-started tasks |
| Daily, about 18:00 | Daily report to admins |
| Monday, about 08:00 | Weekly report (previous 7 days) |
| 1st of the month, about 08:00 | Monthly report (previous month) |
| Every 15 minutes | Retry failed WhatsApp messages |

Each one can be switched off in **Settings ▸ WhatsApp & reports**. If you change the time zone later, open Apps Script ▸ **Triggers**, delete the five triggers, and run `setupBoard` again so they are recreated in the new zone.

## Limits to know

- **Email** is sent from the Google account that deployed the script. Google allows about 100 recipients a day on a free account and about 1,500 on Google Workspace. When the limit is reached, emails are logged as failed.
- **WhatsApp** messages cost money per message with most providers. By default only assignments, updates, mentions, issues and notes are sent; comments and replies stay in the app. Change this under *Notifications also sent by email and WhatsApp*.
- The address `admin@sidra.local` is not a real mailbox. Change it to a real email to receive reports.

## Tests and local preview (optional, needs Node.js 20+)

```
node --test tests/*.test.js      # 68 backend tests against a simulator of Google's services
node tests/devserver.js          # preview at http://localhost:8765 with sample data
```

Preview logins: `admin@sidra.local` / `AdminPass1`, member `m1@x.com` / `MemberPass2`.
The `tests/` and `docs/` folders are not needed on GitHub Pages.
