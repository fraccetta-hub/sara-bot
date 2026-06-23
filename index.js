require('dotenv').config();

// ── Fail fast if required secrets are missing ─────────────────────────────────
const REQUIRED_ENV = [
  'ADMIN_JWT_SECRET',
  'SUPERADMIN_JWT_SECRET',
  'STRIPE_SECRET_KEY',
  'SUPABASE_URL',
  'SUPABASE_KEY',
  'ANTHROPIC_API_KEY',
];
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k]);
if (missingEnv.length) {
  console.error('FATAL: missing required env vars:', missingEnv.join(', '));
  process.exit(1);
}

const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const webhookRoutes      = require('./routes/webhook');
const adminRoutes        = require('./routes/admin');
const superadminRoutes   = require('./routes/superadmin');
const { router: telegramRouter } = require('./routes/telegram');
const paymentsRouter  = require('./routes/payments');
const registerRouter  = require('./routes/register');
const billingRouter   = require('./routes/billing');
const { setupCronJobs } = require('./services/cron');

const app = express();
const PORT = process.env.PORT || 3000;

// Behind Render's proxy: trust exactly 1 hop so req.ip is the real client IP
// (rate limiters key per-IP, Secure cookies detect HTTPS). NOT `true` — that
// would let clients spoof X-Forwarded-For to bypass rate limits.
app.set('trust proxy', 1);

// ── Admin HTML with injected env vars (before static middleware) ──────────────
const adminHtmlPath = path.join(__dirname, 'public', 'admin', 'index.html');
function serveAdminHtml(req, res) {
  let html = fs.readFileSync(adminHtmlPath, 'utf8');
  html = html.replace('%%META_APP_ID%%',    process.env.META_APP_ID    || '');
  html = html.replace('%%META_CONFIG_ID%%', process.env.META_CONFIG_ID || '');
  res.type('html').send(html);
}
app.get('/admin',            serveAdminHtml);
app.get('/admin/index.html', serveAdminHtml);

// ── Security headers ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

app.use(cookieParser());

// ── Stripe webhook needs raw body — must be registered BEFORE express.json() ──
app.use('/billing/webhook', express.raw({ type: 'application/json' }));

// ── Limit JSON body size to prevent payload attacks ───────────────────────────
// Keep the raw body so the WhatsApp webhook can verify Meta's X-Hub-Signature-256.
app.use(express.json({ limit: '512kb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/images', express.static(path.join(__dirname, 'images')));

app.use('/webhook',          webhookRoutes);
app.use('/admin',            adminRoutes);
app.use('/superadmin',       superadminRoutes);
app.use('/telegram-webhook', telegramRouter);
app.use('/payments',         paymentsRouter);
app.use('/register',         registerRouter);
app.use('/billing',          billingRouter);

// Serve admin panel at /admin
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html')));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Legal pages
app.get('/legal/terms',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'legal', 'terms.html')));
app.get('/legal/privacy',    (req, res) => res.sendFile(path.join(__dirname, 'public', 'legal', 'privacy.html')));
app.get('/legal/disclaimer', (req, res) => res.sendFile(path.join(__dirname, 'public', 'legal', 'disclaimer.html')));
app.get('/legal/dpa',        (req, res) => res.sendFile(path.join(__dirname, 'public', 'legal', 'dpa.html')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'landingpage', 'index.html')));

// ── Global error handler — log server-side, never leak stack traces to clients ─
app.use((err, req, res, next) => {
  console.error('[express] Unhandled error:', err.stack || err.message);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: 'Error interno del servidor', errorCode: 'server_error' });
});

// Keep the process alive on stray async errors instead of crashing the webhook
// server; each request is isolated and already wrapped in try/catch.
process.on('unhandledRejection', (reason) => {
  console.error('[process] Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[process] Uncaught exception:', err.stack || err.message);
});

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

// ─── Cron: auto-delete support messages older than 90 days ───────────────────
(function scheduleSupportCleanup() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  async function cleanOldSupportMessages() {
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const { error, count } = await supabase
      .from('support_messages')
      .delete({ count: 'exact' })
      .lt('created_at', cutoff);
    if (error) console.error('[cleanup] support_messages error:', error.message);
    else if (count > 0) console.log(`[cleanup] Deleted ${count} support messages older than 90 days`);
  }
  setTimeout(cleanOldSupportMessages, 10000);
  setInterval(cleanOldSupportMessages, 24 * 60 * 60 * 1000);
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
          // Permanent System User tokens can't be exchanged but are still valid.
          // Verify real validity before flagging an error.
          const dbgUrl = `https://graph.facebook.com/v19.0/debug_token` +
            `?input_token=${tenant.whatsapp_token}&access_token=${APP_ID}|${APP_SECRET}`;
          const dbg = await fetch(dbgUrl).then(r => r.json());
          if (dbg.data?.is_valid) {
            await supabase.from('tenants')
              .update({ whatsapp_token_refresh_error: null })
              .eq('id', tenant.id);
            console.log(`[token-renewal] ${tenant.name}: token valid (permanent, not exchangeable)`);
          } else {
            const errMsg = dbg.data?.error?.message || data.error?.message || 'unknown';
            await supabase.from('tenants')
              .update({ whatsapp_token_refresh_error: errMsg })
              .eq('id', tenant.id);
            console.error(`[token-renewal] Failed for ${tenant.name}: ${errMsg}`);
          }
        }
      } catch (e) {
        console.error(`[token-renewal] Error for ${tenant.name}: ${e.message}`);
      }
    }
  }

  setTimeout(renewTokens, 15000);
  setInterval(renewTokens, 24 * 60 * 60 * 1000);
})();

// ─── Cron: anonymize order PII older than 5 years (legal retention) ─────────
// Keeps financial data (amounts, items); removes customer_phone only.
(function scheduleOrderAnonymization() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  async function anonymizeOldOrders() {
    const cutoff = new Date(Date.now() - 5 * 365 * 24 * 60 * 60 * 1000).toISOString();
    const { error } = await supabase
      .from('orders')
      .update({ customer_phone: '[deleted]' })
      .lt('created_at', cutoff)
      .neq('customer_phone', '[deleted]');
    if (error) console.error('[cleanup] order anonymization error:', error.message);
  }
  setTimeout(anonymizeOldOrders, 25000);
  setInterval(anonymizeOldOrders, 24 * 60 * 60 * 1000);
})();

// ─── Cron: appointment reminders + abandoned cart nudge ──────────────────────
setupCronJobs();

module.exports = app;
