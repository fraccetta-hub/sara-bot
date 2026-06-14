require('dotenv').config();
const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const webhookRoutes      = require('./routes/webhook');
const adminRoutes        = require('./routes/admin');
const superadminRoutes   = require('./routes/superadmin');
const { router: telegramRouter } = require('./routes/telegram');

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

app.use('/webhook',          webhookRoutes);
app.use('/admin',            adminRoutes);
app.use('/superadmin',       superadminRoutes);
app.use('/telegram-webhook', telegramRouter);

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

// ─── Cron: auto-delete conversations older than 90 days ──────────────────────
// Runs once at startup and then every 24h
(function scheduleConversationCleanup() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

  async function cleanOldConversations() {
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const { error, count } = await supabase
      .from('conversations')
      .delete({ count: 'exact' })
      .lt('updated_at', cutoff);
    if (error) {
      console.error('[cleanup] Error deleting old conversations:', error.message);
    } else {
      if (count > 0) console.log(`[cleanup] Deleted ${count} conversations older than 90 days`);
    }
  }

  // Run at startup (after 5s to let server settle) and every 24h
  setTimeout(cleanOldConversations, 5000);
  setInterval(cleanOldConversations, 24 * 60 * 60 * 1000);
})();

module.exports = app;
