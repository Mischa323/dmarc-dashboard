let _writeCount = 0;

function log(level, category, message) {
  const prefix = `[${category}]`;
  if (level === 'error') console.error(prefix, message);
  else if (level === 'warn') console.warn(prefix, message);
  else console.log(prefix, message);

  try {
    const { getDb } = require('./db');
    const db = getDb();
    db.prepare('INSERT INTO admin_logs (level, category, message) VALUES (?, ?, ?)').run(level, category, message);
    if (++_writeCount >= 100) {
      _writeCount = 0;
      db.prepare('DELETE FROM admin_logs WHERE id NOT IN (SELECT id FROM admin_logs ORDER BY id DESC LIMIT 1000)').run();
    }
  } catch { /* never throw */ }
}

module.exports = {
  info:  (category, message) => log('info',  category, message),
  warn:  (category, message) => log('warn',  category, message),
  error: (category, message) => log('error', category, message),
};
