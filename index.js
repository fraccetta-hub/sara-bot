require('dotenv').config();
const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const webhookRoutes      = require('./routes/webhook');
const adminRoutes        = require('./routes/admin');
const superadminRoutes   = require('./routes/superadmin');
const { router: telegramRouter, notifyTokenError } = require('./routes/telegram');
const paymentsRouter = require('./routes/payments');

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
app.use('/payments',         paymentsRouter);

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

// ─── Cron: auto-renew WhatsApp tokens expiring within 15 days ────────────────
(function scheduleTokenRenewal() {
  const supabase   = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const APP_ID     = process.env.META_APP_ID;
  const APP_SECRET = process.env.META_APP_SECRET;

  async function renewTokens() {
    if (!APP_ID || !APP_SECRET) return;
    const soon = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString();
    const { data: tenants } = await supabase
      .from('tenants')
      .select('id, name, whatsapp_token')
      .not('whatsapp_token', 'is', null)
      .or(`whatsapp_token_expires_at.is.null,whatsapp_token_expires_at.lt.${soon}`);

    for (const tenant of tenants || []) {
      try {
        const url  = `https://graph.facebook.com/v19.0/oauth/access_token` +
          `?grant_type=fb_exchange_token&client_id=${APP_ID}&client_secret=${APP_SECRET}` +
          `&fb_exchange_token=${tenant.whatsapp_token}`;
        const data = await fetch(url).then(r => r.json());
        if (data.access_token) {
          const expiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
          await supabase.from('tenants')
            .update({ whatsapp_token: data.access_token, whatsapp_token_expires_at: expiresAt, whatsapp_token_refresh_error: null })
            .eq('id', tenant.id);
          console.log(`[token-renewal] Renewed for ${tenant.name}`);
        } else {
          const errMsg = data.error?.message || 'unknown';
          await supabase.from('tenants')
            .update({ whatsapp_token_refresh_error: errMsg })
            .eq('id', tenant.id);
          console.error(`[token-renewal] Failed for ${tenant.name}: ${errMsg}`);
          await notifyTokenError(tenant.name, tenant.id, errMsg);
        }
      } catch (e) {
        console.error(`[token-renewal] Error for ${tenant.name}: ${e.message}`);
      }
    }
  }

  setTimeout(renewTokens, 15000);
  setInterval(renewTokens, 24 * 60 * 60 * 1000);
})();

module.exports = app;
