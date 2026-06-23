const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { rateLimit } = require('express-rate-limit');
const { getSectorPrompt, getCurrencyForCountry } = require('../services/sectorPrompts');
const { sendEmailVerification } = require('../services/mailer');

const supabase   = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const JWT_SECRET = process.env.ADMIN_JWT_SECRET;
const TRIAL_DAYS = 7;

// Throttle signup (mass fake accounts) and email lookup (address enumeration).
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiados intentos. Probá de nuevo en una hora.' },
});
const checkEmailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 30,
  standardHeaders: true, legacyHeaders: false,
  message: { available: false, error: 'Demasiadas consultas. Probá más tarde.' },
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugify(str) {
  return str.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function trialExpiry() {
  const d = new Date();
  d.setDate(d.getDate() + TRIAL_DAYS);
  return d.toISOString();
}

// ── POST /register — create new self-registered tenant ────────────────────────

router.post('/', signupLimiter, async (req, res) => {
  const {
    business_name, sector, country, language,
    owner_name, email, phone, password,
    plan,          // 'shop' | 'bookings' | 'restaurant' | 'pro'
  } = req.body;

  // ── Validation ──────────────────────────────────────────────────────────────
  if (!business_name || !email || !phone) {
    return res.status(400).json({ error: 'business_name, email y phone son obligatorios.' });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Email inválido.' });
  }

  // ── Check email uniqueness ──────────────────────────────────────────────────
  const { data: existing } = await supabase
    .from('tenants').select('id, plan_status, plan').eq('login_slug', email).maybeSingle();
  if (existing) {
    // Account abandoned at Stripe step — allow resuming checkout with updated password
    if (existing.plan_status === 'pending_payment') {
      if (password) {
        const newHash = await bcrypt.hash(password, 10);
        await supabase.from('tenants')
          .update({ admin_password_hash: newHash })
          .eq('id', existing.id);
      }
      return res.status(200).json({
        tenant_id: existing.id,
        email,
        plan: existing.plan || 'shop',
        resumed: true,
      });
    }
    return res.status(409).json({ error: 'Ya existe una cuenta con ese email. ¿Querés iniciar sesión?' });
  }

  // ── Sector prompt ───────────────────────────────────────────────────────────
  const { personality, instructions } = getSectorPrompt(sector || 'otro');
  const currency   = getCurrencyForCountry(country || '');
  const passHash   = await bcrypt.hash(password, 10);
  const baseSlug   = slugify(business_name);

  // Ensure unique login_slug if business name collides
  let login_slug = email; // use email as primary username — always unique

  // ── Insert tenant ───────────────────────────────────────────────────────────
  const insertPayload = {
    name:                 business_name,
    login_slug,
    email:                email.toLowerCase().trim(),
    country:              country || null,
    bot_name:             'Sara',
    bot_personality:      personality,
    custom_instructions:  `${instructions}\n\n${owner_name ? `Propietario: ${owner_name}` : ''}`.trim(),
    merchant_phone:       phone,
    admin_password_hash:  passHash,
    active:               false,      // activated after Stripe payment confirmed
    plan_status:          'pending_payment',
    plan:                 plan || 'shop',
    plan_expires:         trialExpiry(),
    plan_currency:        currency,
    products_enabled:     ['shop','pro','restaurant'].includes(plan),
    services_enabled:     ['bookings','pro'].includes(plan),
    appointments_enabled: ['bookings','pro','restaurant'].includes(plan),
    restaurant_enabled:   plan === 'restaurant',
  };

  const { data: tenant, error } = await supabase
    .from('tenants').insert(insertPayload).select().single();

  if (error) {
    console.error('[register]', error.message);
    return res.status(500).json({ error: 'Error al crear la cuenta. Intentá de nuevo.' });
  }

  // Send email verification (fire-and-forget — don't block registration on email failure)
  const verificationToken = crypto.randomBytes(32).toString('hex');
  supabase.from('tenants')
    .update({ email_verification_token: verificationToken })
    .eq('id', tenant.id)
    .then(() => {
      const verifyUrl = `${process.env.APP_URL}/register/verify-email?token=${verificationToken}`;
      sendEmailVerification({
        email:        email.toLowerCase().trim(),
        businessName: business_name,
        verifyUrl,
        lang:         language || 'es',
      }).catch(() => {});
    })
    .catch(() => {});

  // Return tenantId only — credentials shown AFTER Stripe payment is confirmed
  res.status(201).json({
    tenant_id: tenant.id,
    email,
    plan: plan || 'shop',
  });
});

// ── GET /register/verify-email?token=... — confirm email ownership ──────────

router.get('/verify-email', async (req, res) => {
  const { token } = req.query;
  const appUrl = process.env.APP_URL || '';
  if (!token) return res.redirect(`${appUrl}/admin/index.html?verified=invalid`);

  const { data: tenant } = await supabase
    .from('tenants')
    .select('id')
    .eq('email_verification_token', token)
    .maybeSingle();

  if (!tenant) return res.redirect(`${appUrl}/admin/index.html?verified=invalid`);

  await supabase.from('tenants').update({
    email_verified_at:        new Date().toISOString(),
    email_verification_token: null,
  }).eq('id', tenant.id);

  res.redirect(`${appUrl}/admin/index.html?verified=ok`);
});

// ── POST /register/resend-verification ───────────────────────────────────────

const resendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 5,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiados intentos. Probá en una hora.' },
});

router.post('/resend-verification', resendLimiter, async (req, res) => {
  const { email, lang = 'es' } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  const normalized = email.toLowerCase().trim();

  const { data: tenant } = await supabase
    .from('tenants')
    .select('id, name, email_verified_at')
    .or(`email.eq.${normalized},login_slug.eq.${normalized}`)
    .maybeSingle();

  // Silent success — don't leak account existence or already-verified status
  if (!tenant || tenant.email_verified_at) return res.json({ ok: true });

  const newToken = crypto.randomBytes(32).toString('hex');
  await supabase.from('tenants')
    .update({ email_verification_token: newToken })
    .eq('id', tenant.id);

  const verifyUrl = `${process.env.APP_URL}/register/verify-email?token=${newToken}`;
  await sendEmailVerification({ email: normalized, businessName: tenant.name, verifyUrl, lang }).catch(() => {});

  res.json({ ok: true });
});

// ── GET /register/check-email?email=... — check availability before submit ───

router.get('/check-email', checkEmailLimiter, async (req, res) => {
  const { email } = req.query;
  if (!email) return res.json({ available: false });
  const { data } = await supabase
    .from('tenants').select('id').eq('login_slug', email).maybeSingle();
  res.json({ available: !data });
});

module.exports = router;
