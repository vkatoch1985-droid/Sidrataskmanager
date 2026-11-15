/* =====================================================================
 *  Sidra Project Board — reminders and reports (Reports.gs)
 * ---------------------------------------------------------------------
 *  Time triggers (installed by setupBoard, in the board's time zone):
 *    runMemberReminders   every day ~08:00   reminders to members
 *    runDailyReport       every day ~18:00   report to administrators
 *    runWeeklyReport      Monday ~08:00      report for the previous 7 days
 *    runMonthlyReport     1st of month ~08:00 report for the previous month
 *    retryFailedWhatsApp  every 15 minutes   (WhatsApp.gs)
 * ===================================================================== */

const REPORT_TITLES = { daily: 'Daily report', weekly: 'Weekly report', monthly: 'Monthly report' };

/* ---------- member reminders ---------- */

/** Open, dated, non-parked tasks that need this member's attention, grouped by urgency. */
function reminderItemsFor_(email, tasks, today, horizon) {
  const out = { overdue: [], notStarted: [], dueSoon: [] };
  tasks.forEach(function (t) {
    if (t.Archived || t.Status === 'Completed' || t.Status === 'Cancelled' || t.Stage === 'Parked' || !isYmd_(t.DueDate)) return;
    const mine = lc_(t.AssignedTo) === email || list_(t.Collaborators).map(lc_).indexOf(email) >= 0 ||
      parseSubtasks_(t.Subtasks).some(function (x) { return x.owner === email && !x.done; });
    if (!mine) return;
    if (t.DueDate < today) out.overdue.push(t);
    else if (t.DueDate <= horizon && t.Status === 'Not Started') out.notStarted.push(t);
    else if (t.DueDate <= horizon) out.dueSoon.push(t);
  });
  return out;
}

function runMemberReminders() {
  REQ = {};
  return withLock_(function () {
    const s = settings_();
    if (!truthy_(s.REMINDERS_ENABLED)) return 0;
    const today = today_();
    const horizon = addDays_(today, Math.max(0, Number(s.DUE_SOON_DAYS) || 2));
    const tasks = readTable_('Tasks').rows;
    const props = PropertiesService.getScriptProperties();
    // Forget yesterday's "already reminded" marks.
    const all = props.getProperties();
    Object.keys(all).forEach(function (k) { if (k.indexOf('REM:') === 0 && k.slice(-10) !== today) props.deleteProperty(k); });
    const base = String(s.BOARD_URL || '').replace(/#.*$/, '');
    let sent = 0;
    users_().forEach(function (u) {
      if (!u.Active) return;
      const key = 'REM:' + u.Email + ':' + today;
      if (props.getProperty(key)) return;
      const it = reminderItemsFor_(u.Email, tasks, today, horizon);
      const n = it.overdue.length + it.notStarted.length + it.dueSoon.length;
      if (!n) return;
      props.setProperty(key, '1');
      const parts = [];
      if (it.overdue.length) parts.push(it.overdue.length + ' overdue');
      if (it.notStarted.length) parts.push(it.notStarted.length + ' not started and due soon');
      if (it.dueSoon.length) parts.push(it.dueSoon.length + ' due soon');
      const headline = n + ' task' + (n === 1 ? ' needs' : 's need') + ' your attention: ' + parts.join(', ') + '.';
      const names = it.overdue.concat(it.notStarted, it.dueSoon).slice(0, 4).map(function (t) { return t.TaskID + ' ' + excerpt_(t.Title, 40) + ' (due ' + t.DueDate + ')'; });
      const waText = headline + ' ' + names.join('; ') + (n > 4 ? '; and ' + (n - 4) + ' more' : '');
      const section = function (title, color, rows) {
        if (!rows.length) return '';
        return '<p style="margin:14px 0 6px;font-weight:bold;color:' + color + '">' + title + '</p><table style="border-collapse:collapse;width:100%;font-size:14px">' +
          rows.map(function (t) { return '<tr><td style="padding:6px 8px;border-bottom:1px solid #EADFD8;white-space:nowrap;color:#7A6A62">' + htmlEsc_(t.TaskID) + '</td><td style="padding:6px 8px;border-bottom:1px solid #EADFD8">' + htmlEsc_(t.Title) + '</td><td style="padding:6px 8px;border-bottom:1px solid #EADFD8;white-space:nowrap">' + htmlEsc_(t.Stage || t.Status) + '</td><td style="padding:6px 8px;border-bottom:1px solid #EADFD8;white-space:nowrap">due ' + htmlEsc_(t.DueDate) + '</td></tr>'; }).join('') + '</table>';
      };
      const html = '<p style="margin:0;font-size:15px">' + htmlEsc_(headline) + '</p>' +
        section('Overdue', '#C81E0A', it.overdue) + section('Not started — deadline near', '#B45309', it.notStarted) + section('Due soon', '#1F1410', it.dueSoon);
      const first = it.overdue.concat(it.notStarted, it.dueSoon)[0];
      notify_([u.Email], 'REMINDER', 'Task', first.TaskID, 'Reminder: ' + headline, '', 'REMINDER:' + today, { silent: true });
      sendEmail_(u, '[' + (s.ORG_NAME || 'Board') + '] Reminder: ' + n + ' task' + (n === 1 ? '' : 's') + ' need your attention', html, headline + '\n' + names.join('\n'), 'reminder', first.TaskID, base ? base + '#/my' : '');
      sendWhatsApp_(u, 'task_reminder', [String(u.Name || '').split(' ')[0] || 'there', waText], waText + (base ? '\n' + base + '#/my' : ''), 'reminder', first.TaskID);
      sent++;
    });
    if (sent) bumpRev_();
    return sent;
  });
}

/* ---------- reports ---------- */

function inRange_(ymd, from, to) { return !!ymd && ymd >= from && ymd <= to; }
function localDay_(iso) { return iso ? Utilities.formatDate(new Date(iso), tz_(), 'yyyy-MM-dd') : ''; }

/** Dates covered by a report. scheduled = called by the timer (looks back); otherwise up to today. */
function reportRange_(period, scheduled) {
  const today = today_();
  if (period === 'weekly') return scheduled ? { from: addDays_(today, -7), to: addDays_(today, -1) } : { from: addDays_(today, -6), to: today };
  if (period === 'monthly') {
    if (!scheduled) return { from: addDays_(today, -29), to: today };
    const end = addDays_(today.slice(0, 8) + '01', -1);
    return { from: end.slice(0, 8) + '01', to: end };
  }
  return { from: today, to: today };
}

function buildReport_(period, from, to) {
  const s = settings_();
  const today = today_();
  const tasks = readTable_('Tasks').rows.filter(function (t) { return !t.Archived; });
  const open = function (t) { return t.Status !== 'Completed' && t.Status !== 'Cancelled'; };
  const overdue = function (t) { return open(t) && t.Stage !== 'Parked' && isYmd_(t.DueDate) && t.DueDate < today; };
  const byStage = {};
  TASK_STAGES.forEach(function (st) { byStage[st] = 0; });
  tasks.forEach(function (t) { const st = t.Stage || STATUS_TO_STAGE[t.Status] || 'Under Design'; byStage[st] = (byStage[st] || 0) + 1; });
  const in7 = addDays_(today, 7);
  const totals = {
    total: tasks.length, byStage: byStage,
    created: tasks.filter(function (t) { return inRange_(localDay_(t.CreatedAt), from, to); }).length,
    completed: tasks.filter(function (t) { return t.Status === 'Completed' && inRange_(t.CompletedDate, from, to); }).length,
    overdue: tasks.filter(overdue).length,
    notStarted: tasks.filter(function (t) { return t.Status === 'Not Started' && t.Stage !== 'Parked'; }).length,
    dueNext7: tasks.filter(function (t) { return open(t) && t.Stage !== 'Parked' && isYmd_(t.DueDate) && t.DueDate >= today && t.DueDate <= in7; }).length,
    unassigned: tasks.filter(function (t) { return open(t) && !t.AssignedTo; }).length
  };
  const members = users_().filter(function (u) { return u.Active; }).map(function (u) {
    const mine = tasks.filter(function (t) { return lc_(t.AssignedTo) === u.Email; });
    return {
      email: u.Email, name: u.Name || u.Email, open: mine.filter(open).length, overdue: mine.filter(overdue).length,
      notStarted: mine.filter(function (t) { return t.Status === 'Not Started' && t.Stage !== 'Parked'; }).length,
      completed: mine.filter(function (t) { return t.Status === 'Completed' && inRange_(t.CompletedDate, from, to); }).length
    };
  }).filter(function (m) { return m.open || m.completed; }).sort(function (a, b) { return b.overdue - a.overdue || b.open - a.open; });
  const projects = readTable_('Projects').rows.filter(function (p) { return !p.Archived; }).map(function (p) {
    const mine = tasks.filter(function (t) { return t.ProjectID === p.ProjectID; });
    const done = mine.filter(function (t) { return t.Status === 'Completed'; }).length;
    const stageOf = !mine.length ? '—' : (done === mine.length ? 'Completed' : (mine.some(function (t) { return t.Stage === 'Build'; }) ? 'Build' : (mine.some(function (t) { return t.Stage === 'Under Design'; }) ? 'Under Design' : 'Parked')));
    return {
      id: p.ProjectID, name: p.Name, status: p.Status, owner: nameOf_(p.Owner), targetDate: p.TargetDate || '', stage: stageOf,
      total: mine.length, open: mine.filter(open).length, overdue: mine.filter(overdue).length,
      progress: mine.length ? Math.round(mine.reduce(function (a, t) { return a + (Number(t.Progress) || 0); }, 0) / mine.length) : 0
    };
  });
  const overdueList = tasks.filter(overdue).sort(function (a, b) { return a.DueDate < b.DueDate ? -1 : 1; }).slice(0, 25)
    .map(function (t) { return { id: t.TaskID, title: t.Title, owner: nameOf_(t.AssignedTo), due: t.DueDate, stage: t.Stage }; });
  const title = REPORT_TITLES[period] || 'Report';
  const range = from === to ? from : from + ' to ' + to;

  const text = title + ' (' + range + '): ' + totals.total + ' tasks — ' + totals.completed + ' completed, ' + byStage.Build + ' in build, ' +
    totals.notStarted + ' not started, ' + totals.overdue + ' overdue, ' + totals.dueNext7 + ' due in the next 7 days';

  const td = 'padding:7px 9px;border-bottom:1px solid #EADFD8;font-size:14px;';
  const th = 'padding:7px 9px;background:#FBEFE6;text-align:left;font-size:12px;color:#7A1E00;text-transform:uppercase;';
  const table = function (heads, rows) {
    return '<table style="border-collapse:collapse;width:100%;margin:6px 0 16px"><tr>' + heads.map(function (h) { return '<th style="' + th + '">' + h + '</th>'; }).join('') + '</tr>' +
      rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td style="' + td + '">' + htmlEsc_(c) + '</td>'; }).join('') + '</tr>'; }).join('') + '</table>';
  };
  const h3 = function (x) { return '<p style="margin:14px 0 2px;font-weight:bold;color:#7A1E00">' + x + '</p>'; };
  const html = '<p style="margin:0 0 8px;font-size:16px;font-weight:bold">' + htmlEsc_(title) + ' — ' + htmlEsc_(range) + '</p>' +
    h3('Summary') + table(['Measure', 'Count'], [
      ['All tasks', totals.total], ['Completed in this period', totals.completed], ['Created in this period', totals.created],
      ['Under Design', byStage['Under Design']], ['Build', byStage.Build], ['Parked', byStage.Parked], ['Completed (all time)', byStage.Completed],
      ['Not started', totals.notStarted], ['Overdue', totals.overdue], ['Due in the next 7 days', totals.dueNext7], ['Unassigned', totals.unassigned]
    ]) +
    h3('By member') + (members.length ? table(['Member', 'Open', 'Not started', 'Overdue', 'Completed in period'], members.map(function (m) { return [m.name, m.open, m.notStarted, m.overdue, m.completed]; })) : '<p>No member tasks yet.</p>') +
    h3('Projects') + (projects.length ? table(['Project', 'Stage', 'Status', 'Progress', 'Open', 'Overdue'], projects.map(function (p) { return [p.name, p.stage, p.status, p.progress + '%', p.open, p.overdue]; })) : '<p>No projects yet.</p>') +
    (overdueList.length ? h3('Overdue tasks') + table(['Task', 'Title', 'Owner', 'Due', 'Stage'], overdueList.map(function (t) { return [t.id, t.title, t.owner, t.due, t.stage]; })) : '');

  return { period: period, title: title, from: from, to: to, generatedAt: nowIso_(), totals: totals, members: members, projects: projects, overdueTasks: overdueList, html: html, text: text };
}

/** Sends a report to every active administrator by email and WhatsApp. kind = daily | weekly | monthly | manual. */
function sendReport_(period, kind, scheduled) {
  const s = settings_();
  const r = reportRange_(period, scheduled);
  const rep = buildReport_(period, r.from, r.to);
  const base = String(s.BOARD_URL || '').replace(/#.*$/, '');
  const fallback = normMobileSafe_(s.ADMIN_MOBILE);
  let n = 0;
  users_().filter(function (u) { return u.Active && u.Role === 'Admin'; }).forEach(function (u) {
    const to = { Email: u.Email, Name: u.Name, Mobile: u.Mobile || fallback };
    sendEmail_(to, '[' + (s.ORG_NAME || 'Board') + '] ' + rep.title + ' — ' + (rep.from === rep.to ? rep.from : rep.from + ' to ' + rep.to), rep.html, rep.text, kind, '', base ? base + '#/dashboard' : '');
    sendWhatsApp_(to, 'admin_report', [String(u.Name || '').split(' ')[0] || 'Admin', rep.text], rep.text + (base ? '\n' + base : ''), kind, '');
    n++;
  });
  return { report: rep, recipients: n };
}

function runScheduledReport_(period, switchKey) {
  REQ = {};
  return withLock_(function () {
    if (!truthy_(settings_()[switchKey])) return 0;
    return sendReport_(period, period, true).recipients;
  });
}
function runDailyReport() { return runScheduledReport_('daily', 'REPORT_DAILY'); }
function runWeeklyReport() { return runScheduledReport_('weekly', 'REPORT_WEEKLY'); }
function runMonthlyReport() { return runScheduledReport_('monthly', 'REPORT_MONTHLY'); }

function reportPeriod_(p) { return ['daily', 'weekly', 'monthly'].indexOf(String(p.period)) >= 0 ? String(p.period) : 'daily'; }

function sendReportNow_(ctx, p) {
  requireRole_(ctx, ['Admin'], 'Only administrators can send reports.');
  const period = reportPeriod_(p);
  return withLock_(function () {
    const r = sendReport_(period, 'manual', false);
    logActivity_(ctx, 'Settings', 'Report', 'Report sent', REPORT_TITLES[period] + ' sent to ' + r.recipients + ' administrator(s).');
    const rep = r.report; delete rep.html;
    return { sent: r.recipients, report: rep };
  });
}

function getReport_(ctx, p) {
  requireRole_(ctx, ['Admin'], 'Only administrators can see reports.');
  const period = reportPeriod_(p);
  const r = reportRange_(period, false);
  const rep = buildReport_(period, r.from, r.to);
  delete rep.html;
  return rep;
}

/* ---------- triggers ---------- */

function ensureTrigger_() {
  try {
    const tz = tz_();
    const want = {
      runMemberReminders: function (b) { return b.timeBased().everyDays(1).atHour(8).inTimezone(tz); },
      runDailyReport: function (b) { return b.timeBased().everyDays(1).atHour(18).inTimezone(tz); },
      runWeeklyReport: function (b) { return b.timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(8).inTimezone(tz); },
      runMonthlyReport: function (b) { return b.timeBased().onMonthDay(1).atHour(8).inTimezone(tz); },
      retryFailedWhatsApp: function (b) { return b.timeBased().everyMinutes(15); }
    };
    const out = [];
    const seen = {};
    ScriptApp.getProjectTriggers().forEach(function (t) {
      const fn = t.getHandlerFunction();
      const old = ['runDeadlineScan', 'runBulkUpload'].indexOf(fn) >= 0;
      if (old || (want[fn] && seen[fn])) { ScriptApp.deleteTrigger(t); out.push('removed ' + (old ? 'old ' : 'duplicate ') + fn); }
      else if (want[fn]) seen[fn] = true;
    });
    Object.keys(want).forEach(function (fn) {
      if (seen[fn]) return;
      want[fn](ScriptApp.newTrigger(fn)).create();
      out.push('installed ' + fn);
    });
    return '• Triggers: ' + (out.length ? out.join('; ') : 'already installed') + '.';
  } catch (e) {
    return '• Could not install the time triggers automatically (' + e.message + '). Add time-driven triggers for runMemberReminders, runDailyReport, runWeeklyReport, runMonthlyReport and retryFailedWhatsApp manually.';
  }
}
