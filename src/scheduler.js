const cron = require('node-cron');

const _tasks = new Map();

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
    // fetch_interval_override (non-null) takes priority over the global default
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
}

module.exports = { startScheduler };
