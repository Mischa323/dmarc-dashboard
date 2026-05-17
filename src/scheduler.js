const cron = require('node-cron');

const _tasks = new Map();
let _emailTask = null;

function startScheduler() {
  for (const task of _tasks.values()) task.stop();
  _tasks.clear();

  let tenants, globalMinutes;
  try {
    const { getDb, getSetting } = require('./db');
    const db = getDb();
    tenants = db.prepare('SELECT * FROM sso_tenants WHERE enabled = 1').all();
    globalMinutes = Math.max(5, parseInt(getSetting(db, 'fetch_interval_minutes', '60')) || 60);
  } catch {
    return;
  }

  for (const tenant of tenants) {
    const minutes = Math.max(5, tenant.fetch_interval_override ?? globalMinutes);
    const expr = minutes < 60
      ? `*/${minutes} * * * *`
      : `0 */${Math.max(1, Math.round(minutes / 60))} * * *`;

    const task = cron.schedule(expr, async () => {
      try {
        const { fetchAndStore } = require('./fetcher');
        const count = await fetchAndStore(tenant);
        console.log(`[scheduler][${tenant.name}] Stored ${count} new report(s)`);
      } catch (err) {
        console.error(`[scheduler][${tenant.name}] Error: ${err.message}`);
      }
    });

    _tasks.set(tenant.id, task);
    const source = tenant.fetch_interval_override != null ? 'custom' : 'global';
    console.log(`[scheduler] "${tenant.name}" scheduled every ${minutes}m (${source})`);
  }

  _startEmailScheduler();
}

function _startEmailScheduler() {
  if (_emailTask) { _emailTask.stop(); _emailTask = null; }

  _emailTask = cron.schedule('* * * * *', async () => {
    try {
      const { getDb, getSetting } = require('./db');
      const db = getDb();

      const timezone = getSetting(db, 'mail_timezone', 'UTC');
      const now = new Date();
      const nowUtc = now.toISOString();

      // Current time and date in the configured timezone
      const nowTime   = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(now).replace(',', '').trim();
      const todayDate = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(now);
      const dayName   = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long' }).format(now);
      const DOW       = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
      const todayDow  = DOW[dayName] ?? 0;

      const { sendGroupReport } = require('./reportMailer');

      const dailyGroups = db.prepare("SELECT * FROM email_report_groups WHERE schedule IN ('daily','both')").all();
      for (const group of dailyGroups) {
        if (nowTime !== (group.send_time || '08:00')) continue;
        if ((group.last_sent_daily || '').slice(0, 10) === todayDate) continue;
        try {
          const result = await sendGroupReport(group, db, 'daily');
          db.prepare('UPDATE email_report_groups SET last_sent_daily = ? WHERE id = ?').run(nowUtc, group.id);
          if (!result.skipped) console.log(`[email] "${group.name}" daily sent to ${result.recipients} recipient(s)`);
          else console.log(`[email] "${group.name}" daily skipped: ${result.reason}`);
        } catch (err) {
          console.error(`[email] "${group.name}" daily failed: ${err.message}`);
        }
      }

      const weeklyGroups = db.prepare("SELECT * FROM email_report_groups WHERE schedule IN ('weekly','both')").all();
      for (const group of weeklyGroups) {
        if (todayDow !== (group.send_day ?? 1)) continue;
        if (nowTime !== (group.send_time || '08:00')) continue;
        if ((group.last_sent_weekly || '').slice(0, 10) === todayDate) continue;
        try {
          const result = await sendGroupReport(group, db, 'weekly');
          db.prepare('UPDATE email_report_groups SET last_sent_weekly = ? WHERE id = ?').run(nowUtc, group.id);
          if (!result.skipped) console.log(`[email] "${group.name}" weekly sent to ${result.recipients} recipient(s)`);
          else console.log(`[email] "${group.name}" weekly skipped: ${result.reason}`);
        } catch (err) {
          console.error(`[email] "${group.name}" weekly failed: ${err.message}`);
        }
      }

      // Daily retention purge (once per calendar day in configured timezone)
      const retentionDays = parseInt(getSetting(db, 'report_retention_days', '0')) || 0;
      if (retentionDays > 0) {
        const lastPurge = (getSetting(db, 'last_purge_date', '') || '').slice(0, 10);
        if (lastPurge !== todayDate) {
          const { purgeOldReports } = require('./db');
          const deleted = purgeOldReports(db, retentionDays);
          db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('last_purge_date', ?)").run(nowUtc);
          if (deleted > 0) console.log(`[purge] Deleted ${deleted} report(s) older than ${retentionDays} days`);
        }
      }

      const todayDom = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: timezone, day: 'numeric' }).format(now));
      const monthlyGroups = db.prepare("SELECT * FROM email_report_groups WHERE schedule = 'monthly'").all();
      for (const group of monthlyGroups) {
        if (todayDom !== (group.send_month_day || 1)) continue;
        if (nowTime !== (group.send_time || '08:00')) continue;
        if ((group.last_sent_weekly || '').slice(0, 7) === todayDate.slice(0, 7)) continue;
        try {
          const result = await sendGroupReport(group, db, 'monthly');
          db.prepare('UPDATE email_report_groups SET last_sent_weekly = ? WHERE id = ?').run(nowUtc, group.id);
          if (!result.skipped) console.log(`[email] "${group.name}" monthly sent to ${result.recipients} recipient(s)`);
          else console.log(`[email] "${group.name}" monthly skipped: ${result.reason}`);
        } catch (err) {
          console.error(`[email] "${group.name}" monthly failed: ${err.message}`);
        }
      }
    } catch (err) {
      console.error(`[email scheduler] Error: ${err.message}`);
    }
  });
}

module.exports = { startScheduler };
