require('dotenv').config();
const express = require('express');
const path = require('path');
const webhookRoutes      = require('./routes/webhook');
const adminRoutes        = require('./routes/admin');
const superadminRoutes   = require('./routes/superadmin');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Security headers ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

// ── Limit JSON body size to prevent payload attacks ───────────────────────────
app.use(express.json({ limit: '512kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/webhook',    webhookRoutes);
app.use('/admin',      adminRoutes);
app.use('/superadmin', superadminRoutes);

// Serve admin panel at /admin
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html')));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Legal pages
app.get('/legal/terms',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'legal', 'terms.html')));
app.get('/legal/privacy',    (req, res) => res.sendFile(path.join(__dirname, 'public', 'legal', 'privacy.html')));
app.get('/legal/disclaimer', (req, res) => res.sendFile(path.join(__dirname, 'public', 'legal', 'disclaimer.html')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'landingpage', 'index.html')));

app.listen(PORT, () => {
  console.log(`WhatsApp Bot server listening on port ${PORT}`);
});

module.exports = app;
