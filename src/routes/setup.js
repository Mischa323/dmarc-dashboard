const express = require('express');
const bcrypt = require('bcryptjs');
const { isConfigured } = require('../config');
const { getDb } = require('../db');

const router = express.Router();

const LAYOUT = 'setup_layout';

// Redirect /setup → /setup/1
router.get('/setup', (req, res) => {
  res.redirect(isConfigured() ? '/' : '/setup/1');
});

// Step 1 — Welcome
router.get('/setup/1', (req, res) => {
  if (isConfigured()) return res.redirect('/');
  res.render('setup/step1', { layout: LAYOUT, step: 1 });
});

// Step 2 — Create local admin
router.get('/setup/2', (req, res) => {
  if (isConfigured()) return res.redirect('/');
  res.render('setup/step2', { layout: LAYOUT, step: 2, error: null });
});

router.post('/setup/2', async (req, res) => {
  if (isConfigured()) return res.redirect('/');
  const { username, password, confirmPassword } = req.body;

  const usernameClean = (username || '').trim();
  if (!usernameClean || usernameClean.length < 3) {
    return res.render('setup/step2', { layout: LAYOUT, step: 2, error: 'Username must be at least 3 characters.' });
  }
  if (!password || password.length < 8) {
    return res.render('setup/step2', { layout: LAYOUT, step: 2, error: 'Password must be at least 8 characters.' });
  }
  if (password !== confirmPassword) {
    return res.render('setup/step2', { layout: LAYOUT, step: 2, error: 'Passwords do not match.' });
  }

  try {
    const hash = await bcrypt.hash(password, 12);
    getDb().prepare("INSERT INTO local_users (username, password_hash, role) VALUES (?, ?, 'local_admin')").run(usernameClean, hash);
    res.redirect('/setup/3');
  } catch (err) {
    const msg = err.message.includes('UNIQUE') ? 'That username is already taken.' : err.message;
    res.render('setup/step2', { layout: LAYOUT, step: 2, error: msg });
  }
});

// Step 3 — Done
router.get('/setup/3', (req, res) => {
  if (!isConfigured()) return res.redirect('/setup/1');
  res.render('setup/step3', { layout: LAYOUT, step: 3 });
});

module.exports = router;
