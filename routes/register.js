const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const { getSectorPrompt, getCurrencyForCountry } = require('../services/sectorPrompts');

const supabase   = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const JWT_SECRET = process.env.ADMIN_JWT_SECRET;
const TRIAL_DAYS = 7;

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

router.post('/', async (req, res) => {
  const {
    business_name, sector, country, language,
    owner_name, email, phone, password,
    plan,          // 'starter' | 'pro'
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
        plan: existing.plan || 'starter',
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
    plan:                 plan || 'starter',
    plan_expires:         trialExpiry(),
    plan_currency:        currency,
    products_enabled:     true,
    services_enabled:     plan === 'pro',
    appointments_enabled: plan === 'pro',
  };

  const { data: tenant, error } = await supabase
    .from('tenants').insert(insertPayload).select().single();

  if (error) {
    console.error('[register]', error.message);
    return res.status(500).json({ error: 'Error al crear la cuenta. Intentá de nuevo.' });
  }

  // Return tenantId only — credentials shown AFTER Stripe payment is confirmed
  res.status(201).json({
    tenant_id: tenant.id,
    email,
    plan: plan || 'starter',
  });
});

// ── GET /register/check-email?email=... — check availability before submit ───

router.get('/check-email', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.json({ available: false });
  const { data } = await supabase
    .from('tenants').select('id').eq('login_slug', email).maybeSingle();
  res.json({ available: !data });
});

module.exports = router;
