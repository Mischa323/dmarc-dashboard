const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');
const { isConfigured, getConfig } = require('./config');

const SETUP_PATHS = ['/setup'];
const AUTH_PATHS = ['/auth/'];  // includes /auth/2fa

function createApp() {
  const app = express();

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(expressLayouts);
  app.set('layout', 'layout');

  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  const httpMode = process.env.HTTP_MODE === '1';
  if (httpMode) app.set('trust proxy', 1);

  app.use(session({
    secret: getConfig().sessionSecret || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: { secure: !httpMode, httpOnly: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 }, // overridden per-login when "remember me" is set
  }));

  app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    res.locals.userType = req.session.userType || null;
    next();
  });

  app.use((req, res, next) => {
    const isPublic =
      SETUP_PATHS.some(p => req.path.startsWith(p)) ||
      AUTH_PATHS.some(p => req.path.startsWith(p));
    if (isPublic) return next();

    if (!isConfigured()) return res.redirect('/setup/1');
    if (!req.session.userId) {
      req.session.returnTo = req.originalUrl;
      return res.redirect('/auth/login');
    }
    next();
  });

  app.use('/', require('./routes/setup'));
  app.use('/', require('./routes/auth'));
  app.use('/admin', require('./routes/admin'));
  app.use('/', require('./routes/main'));
  app.use('/api', require('./routes/api'));

  return app;
}

module.exports = { createApp };
