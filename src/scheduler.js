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

  // Check every minute if any email report group is due
  _emailTask = cron.schedule('* * * * *', async () => {
    try {
      const { getDb } = require('./db');
      const db = getDb();
      const groups = db.prepare(
        "SELECT * FROM email_report_groups WHERE enabled = 1"
      ).all();
      if (!groups.length) return;

      const now = new Date();
      const nowUtc = now.toISOString();
      const todayDate = nowUtc.slice(0, 10);
      const nowTime = nowUtc.slice(11, 16);      // HH:MM
      const todayDow = now.getUTCDay();           // 0=Sun..6=Sat

      const { sendGroupReport } = require('./reportMailer');

      for (const group of groups) {
        const sendTime = group.send_time || '08:00';
        if (nowTime !== sendTime) continue;

        const schedule = group.schedule || 'weekly';

        if (schedule === 'daily' || schedule === 'both') {
          const lastDaily = (group.last_sent_daily || '').slice(0, 10);
          if (lastDaily !== todayDate) {
            try {
              const result = await sendGroupReport(group, db, 'daily');
              db.prepare(
                "UPDATE email_report_groups SET last_sent_daily = ? WHERE id = ?"
              ).run(nowUtc, group.id);
              if (!result.skipped) {
                console.log(`[email] "${group.name}" daily report sent to ${result.recipients} recipient(s)`);
              }
            } catch (err) {
              console.error(`[email] "${group.name}" daily failed: ${err.message}`);
            }
          }
        }

        if (schedule === 'weekly' || schedule === 'both') {
          const sendDay = group.send_day ?? 1;
          if (todayDow === sendDay) {
            const lastWeekly = (group.last_sent_weekly || '').slice(0, 10);
            if (lastWeekly !== todayDate) {
              try {
                const result = await sendGroupReport(group, db, 'weekly');
                db.prepare(
                  "UPDATE email_report_groups SET last_sent_weekly = ? WHERE id = ?"
                ).run(nowUtc, group.id);
                if (!result.skipped) {
                  console.log(`[email] "${group.name}" weekly report sent to ${result.recipients} recipient(s)`);
                }
              } catch (err) {
                console.error(`[email] "${group.name}" weekly failed: ${err.message}`);
              }
            }
          }
        }
      }
    } catch (err) {
      console.error(`[email scheduler] Error: ${err.message}`);
    }
  });
}

module.exports = { startScheduler };
