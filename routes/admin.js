const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const { uploadImageBuffer } = require('../services/storage');
const { sendMessage, sendImage } = require('../services/whatsapp');

const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { sendPasswordReset, sendAccountDeletion } = require('../services/mailer');
const { invalidateClosures, invalidateOffers, invalidateRestaurant } = require('../services/stock');
const { rateLimit } = require('express-rate-limit');

const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, try again in 1 hour.' },
});
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const uploadCatalog = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024, files: 6 } });
const uploadZip = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 },    // 3 MB max (coerente con Supabase Storage)
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Solo se permiten imágenes'));
  }
});

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const JWT_SECRET = process.env.ADMIN_JWT_SECRET;

// ─── Auth middleware ──────────────────────────────────────────────────────────

// Routes accessible even when account is suspended (so merchant can contact support / see status)
const ALWAYS_ALLOWED = ['/admin/support', '/admin/settings'];

async function requireAuth(req, res, next) {
  const token = req.cookies?.sara_token;
  if (!token) return res.status(401).json({ error: 'No autorizado', errorCode: 'unauthorized' });
  try {
    req.tenant = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Token inválido o expirado', errorCode: 'token_expired' });
  }

  // Always-allowed routes skip the active/expiry check
  if (ALWAYS_ALLOWED.some(p => req.originalUrl.startsWith(p))) return next();

  // Check active flag and plan expiry on every authenticated request
  const { data: tenant } = await supabase
    .from('tenants').select('active, plan_expires').eq('id', req.tenant.tenantId).single();

  if (!tenant || !tenant.active)
    return res.status(403).json({ error: 'Cuenta suspendida. Contactá a soporte.', suspended: true, errorCode: 'suspended' });

  if (tenant.plan_expires && new Date(tenant.plan_expires) < new Date())
    return res.status(403).json({ error: 'Plan vencido. Renovalo para continuar.', expired: true, errorCode: 'plan_expired' });

  next();
}

// ─── Smart rate limiting (progressive delays, no hard lockout) ────────────────
// Tracks failed attempts per IP: { ip -> { count, nextAllowedAt } }
const loginAttempts = new Map();

// ─── Support chat rate limiter — max 10 messages per minute per tenant ────────
const supportMsgCounts = new Map(); // tenantId -> { count, windowStart }

function checkSupportRateLimit(tenantId) {
  const now = Date.now();
  const entry = supportMsgCounts.get(tenantId);
  if (!entry || now - entry.windowStart > 60_000) {
    supportMsgCounts.set(tenantId, { count: 1, windowStart: now });
    return true;
  }
  entry.count++;
  return entry.count <= 10;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, e] of supportMsgCounts) {
    if (now - e.windowStart > 60_000) supportMsgCounts.delete(id);
  }
}, 60_000);

// Clean up old entries every 10 minutes to avoid memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of loginAttempts) {
    if (now - data.lastAttempt > 30 * 60 * 1000) loginAttempts.delete(ip);
  }
}, 10 * 60 * 1000);

function getLoginDelay(failCount) {
  // Progressive delays: never hard-locks, just slows down attackers
  if (failCount <= 2) return 0;
  if (failCount === 3) return 5_000;   // 5 s
  if (failCount === 4) return 15_000;  // 15 s
  if (failCount === 5) return 30_000;  // 30 s
  return 60_000;                       // 60 s max — never permanent
}

function getClientIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

// ─── POST /admin/login ────────────────────────────────────────────────────────

router.post('/login', async (req, res) => {
  const ip = getClientIp(req);
  const now = Date.now();
  const attempt = loginAttempts.get(ip) || { count: 0, nextAllowedAt: 0, lastAttempt: 0 };

  // Check if this IP must wait before next attempt
  if (now < attempt.nextAllowedAt) {
    const waitSec = Math.ceil((attempt.nextAllowedAt - now) / 1000);
    return res.status(429).json({
      error: `Demasiados intentos. Esperá ${waitSec} segundos.`,
      errorCode: 'rate_limit',
      retryAfter: waitSec
    });
  }

  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Faltan datos' });

  // Accept login by slug OR by phone_number_id (backward compat)
  const { data: tenant } = await supabase
    .from('tenants')
    .select('id, name, phone_number_id, admin_password_hash, bot_name, login_slug, active')
    .or(`login_slug.eq.${username},phone_number_id.eq.${username}`)
    .maybeSingle();

  if (!tenant) {
    // Track failure even for unknown users (prevents user enumeration + brute force)
    attempt.count++;
    attempt.lastAttempt = now;
    attempt.nextAllowedAt = now + getLoginDelay(attempt.count);
    loginAttempts.set(ip, attempt);
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos', errorCode: 'wrong_credentials' });
  }

  if (!tenant.active) return res.status(403).json({ error: 'Cuenta suspendida. Contactá a soporte.', errorCode: 'suspended' });

  // Verify password
  let ok = false;
  if (!tenant.admin_password_hash) {
    return res.status(403).json({ error: 'Contraseña no configurada. Contactá a soporte para activar tu cuenta.', errorCode: 'no_password' });
  } else {
    ok = await bcrypt.compare(password, tenant.admin_password_hash);
  }

  if (!ok) {
    attempt.count++;
    attempt.lastAttempt = now;
    attempt.nextAllowedAt = now + getLoginDelay(attempt.count);
    loginAttempts.set(ip, attempt);
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos', errorCode: 'wrong_credentials' });
  }

  // Success — clear failed attempts for this IP
  loginAttempts.delete(ip);

  const token = jwt.sign(
    { tenantId: tenant.id, tenantName: tenant.name, botName: tenant.bot_name },
    JWT_SECRET,
    { expiresIn: '12h' }
  );

  const needsSetup = !tenant.phone_number_id;
  res.cookie('sara_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 12 * 60 * 60 * 1000,
  });
  res.json({ tenantName: tenant.name, botName: tenant.bot_name, needsSetup });
});

// ─── GET /admin/me ────────────────────────────────────────────────────────────
router.get('/me', requireAuth, async (req, res) => {
  const { data: tenant } = await supabase
    .from('tenants').select('name, bot_name, phone_number_id').eq('id', req.tenant.tenantId).single();
  if (!tenant) return res.status(401).json({ error: 'Tenant not found' });
  res.json({ tenantName: tenant.name, botName: tenant.bot_name, needsSetup: !tenant.phone_number_id });
});

// ─── POST /admin/logout ───────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  res.clearCookie('sara_token', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict' });
  res.json({ ok: true });
});

// ─── POST /admin/forgot-password ─────────────────────────────────────────────

router.post('/forgot-password', forgotPasswordLimiter, async (req, res) => {
  const { email, lang = 'es' } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requerido' });

  const normalized = email.toLowerCase().trim();
  // Look up by email column first, then by login_slug for tenants created before email column existed
  let { data: tenant } = await supabase
    .from('tenants')
    .select('id, name, login_slug, email, active')
    .eq('email', normalized)
    .maybeSingle();
  if (!tenant) {
    ({ data: tenant } = await supabase
      .from('tenants')
      .select('id, name, login_slug, email, active')
      .eq('login_slug', normalized)
      .maybeSingle());
  }

  // Always respond OK to prevent user enumeration
  if (!tenant || !tenant.active) return res.json({ ok: true });

  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

  await supabase.from('tenants').update({
    password_reset_token: token,
    password_reset_expires: expires,
  }).eq('id', tenant.id);

  const resetUrl = `${process.env.APP_URL}/admin/index.html?reset=${token}`;
  const sendTo = tenant.email || tenant.login_slug;
  await sendPasswordReset({ email: sendTo, businessName: tenant.name, resetUrl, lang });

  res.json({ ok: true });
});

// ─── POST /admin/reset-password ──────────────────────────────────────────────

router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Datos incompletos' });
  if (password.length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres', errorCode: 'password_too_short' });

  const { data: tenant } = await supabase
    .from('tenants')
    .select('id, password_reset_token, password_reset_expires')
    .eq('password_reset_token', token)
    .maybeSingle();

  if (!tenant) return res.status(400).json({ error: 'Token inválido o expirado', errorCode: 'invalid_token' });
  if (new Date(tenant.password_reset_expires) < new Date())
    return res.status(400).json({ error: 'Token expirado. Solicitá un nuevo enlace.', errorCode: 'token_expired' });

  const hash = await bcrypt.hash(password, 10);
  await supabase.from('tenants').update({
    admin_password_hash: hash,
    password_reset_token: null,
    password_reset_expires: null,
  }).eq('id', tenant.id);

  res.json({ ok: true });
});

// ─── GET /admin/settings ─────────────────────────────────────────────────────

router.get('/settings', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('tenants')
    .select(`name, login_slug, email, bot_name, bot_personality, merchant_phone, payment_instructions, custom_instructions,
             products_enabled, services_enabled, appointments_enabled,
             delivery_enabled, location_address, location_lat, location_lng,
             delivery_type, delivery_base_fee, delivery_zone_km,
             delivery_zone_outer_fee, delivery_per_km,
             delivery_min_order, delivery_disabled_dates,
             address, google_review_url,
             restaurant_enabled, restaurant_slot_duration, restaurant_meal_bands, appointment_capacity,
             sector, active, plan_expires, plan_currency, plan_price, phone_number_id, whatsapp_token_refresh_error,
             stripe_subscription_status, subscription_cancel_at_period_end`)
    .eq('id', req.tenant.tenantId)
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── PUT /admin/settings ──────────────────────────────────────────────────────

router.put('/settings', requireAuth, async (req, res) => {
  // products_enabled / services_enabled are admin-only (managed by superadmin)
  const allowed = [
    'bot_name','bot_personality','merchant_phone','payment_instructions','custom_instructions',
    'delivery_enabled','location_address','location_lat','location_lng',
    'delivery_type','delivery_base_fee','delivery_zone_km',
    'delivery_zone_outer_fee','delivery_per_km',
    'delivery_min_order','delivery_disabled_dates',
    'address','google_review_url','appointment_capacity'
  ];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (updates.appointment_capacity !== undefined)
    updates.appointment_capacity = Math.max(1, parseInt(updates.appointment_capacity) || 1);

  const { error } = await supabase
    .from('tenants').update(updates).eq('id', req.tenant.tenantId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ─── helpers ──────────────────────────────────────────────────────────────────

async function verifyCurrentPassword(tenantId, currentPassword) {
  const { data } = await supabase
    .from('tenants').select('admin_password_hash').eq('id', tenantId).single();
  if (!data?.admin_password_hash) return false;
  return bcrypt.compare(currentPassword, data.admin_password_hash);
}

// ─── POST /admin/change-password ─────────────────────────────────────────────

router.post('/change-password', requireAuth, async (req, res) => {
  const { newPassword, currentPassword } = req.body;
  if (!currentPassword)
    return res.status(400).json({ error: 'Se requiere la contraseña actual', errorCode: 'wrong_password' });
  const ok = await verifyCurrentPassword(req.tenant.tenantId, currentPassword);
  if (!ok) return res.status(403).json({ error: 'Contraseña actual incorrecta', errorCode: 'wrong_password' });
  if (!newPassword || newPassword.length < 6)
    return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres', errorCode: 'password_too_short' });
  const hash = await bcrypt.hash(newPassword, 10);
  await supabase.from('tenants').update({ admin_password_hash: hash }).eq('id', req.tenant.tenantId);
  res.json({ ok: true });
});

// ─── POST /admin/change-email ─────────────────────────────────────────────────

router.post('/change-email', requireAuth, async (req, res) => {
  const { email, currentPassword } = req.body;
  if (!currentPassword)
    return res.status(400).json({ error: 'Se requiere la contraseña actual', errorCode: 'wrong_password' });
  const ok = await verifyCurrentPassword(req.tenant.tenantId, currentPassword);
  if (!ok) return res.status(403).json({ error: 'Contraseña actual incorrecta', errorCode: 'wrong_password' });
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'Email inválido', errorCode: 'invalid_email' });
  const normalized = email.toLowerCase().trim();
  const { data: existing } = await supabase.from('tenants').select('id').eq('email', normalized).maybeSingle();
  if (existing && existing.id !== req.tenant.tenantId)
    return res.status(409).json({ error: 'Ese email ya está en uso', errorCode: 'email_taken' });
  await supabase.from('tenants').update({ email: normalized }).eq('id', req.tenant.tenantId);
  res.json({ ok: true });
});

// ─── POST /admin/change-username ──────────────────────────────────────────────

router.post('/change-username', requireAuth, async (req, res) => {
  const { username, currentPassword } = req.body;
  if (!currentPassword)
    return res.status(400).json({ error: 'Se requiere la contraseña actual', errorCode: 'wrong_password' });
  const ok = await verifyCurrentPassword(req.tenant.tenantId, currentPassword);
  if (!ok) return res.status(403).json({ error: 'Contraseña actual incorrecta', errorCode: 'wrong_password' });
  if (!username || username.length < 3)
    return res.status(400).json({ error: 'El usuario debe tener al menos 3 caracteres', errorCode: 'username_too_short' });
  if (!/^[a-z0-9_.-]+$/.test(username))
    return res.status(400).json({ error: 'Solo letras minúsculas, números, puntos, guiones y guión bajo', errorCode: 'username_invalid' });
  const { data: existing } = await supabase.from('tenants').select('id').or(`login_slug.eq.${username},phone_number_id.eq.${username}`).maybeSingle();
  if (existing && existing.id !== req.tenant.tenantId)
    return res.status(409).json({ error: 'Ese usuario ya está en uso', errorCode: 'username_taken' });
  await supabase.from('tenants').update({ login_slug: username }).eq('id', req.tenant.tenantId);
  res.json({ ok: true });
});

// ─── POST /admin/change-merchant-phone ────────────────────────────────────────

router.post('/change-merchant-phone', requireAuth, async (req, res) => {
  const { phone, currentPassword } = req.body;
  if (!currentPassword)
    return res.status(400).json({ error: 'Se requiere la contraseña actual', errorCode: 'wrong_password' });
  const ok = await verifyCurrentPassword(req.tenant.tenantId, currentPassword);
  if (!ok) return res.status(403).json({ error: 'Contraseña actual incorrecta', errorCode: 'wrong_password' });
  const cleaned = String(phone || '').replace(/\D/g, '');
  if (!cleaned) return res.status(400).json({ error: 'Número inválido', errorCode: 'invalid_phone' });
  await supabase.from('tenants').update({ merchant_phone: cleaned }).eq('id', req.tenant.tenantId);
  res.json({ ok: true });
});

// ─── GET /admin/catalog-template ─────────────────────────────────────────────
// Restaurant tenants get the menu template (dishes + allergens), everyone else
// gets the catalog template (products + stock).
router.get('/catalog-template', requireAuth, async (req, res) => {
  const path = require('path');
  const { data: t } = await supabase
    .from('tenants').select('restaurant_enabled').eq('id', req.tenant.tenantId).single();
  const isMenu = !!t?.restaurant_enabled;
  const file = path.join(__dirname, isMenu ? '../public/menu_template.xlsx' : '../public/catalog_template.xlsx');
  res.download(file, isMenu ? 'menu_template.xlsx' : 'catalog_template.xlsx');
});

// ─── GET /admin/products ──────────────────────────────────────────────────────

router.get('/products', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .eq('tenant_id', req.tenant.tenantId)
    .order('category')
    .order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── POST /admin/products ─────────────────────────────────────────────────────

router.post('/products', requireAuth, async (req, res) => {
  const { name, category, price_guarani, stock_qty, description, image_url, sku, allergens } = req.body;
  if (!name || !price_guarani)
    return res.status(400).json({ error: 'Nombre y precio son obligatorios' });

  // stock_qty === null means unlimited (always available)
  const unlimited = stock_qty === null || stock_qty === undefined;
  const { data, error } = await supabase
    .from('products')
    .insert({
      tenant_id: req.tenant.tenantId,
      name, category, price_guarani,
      stock_qty: unlimited ? null : (stock_qty || 0),
      description, image_url,
      allergens: allergens || null,
      sku: sku || null,
      is_available: unlimited ? true : (stock_qty || 0) > 0
    })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// ─── PUT /admin/products/:id ──────────────────────────────────────────────────

router.put('/products/:id', requireAuth, async (req, res) => {
  const { name, category, price_guarani, stock_qty, description, image_url, is_available, sku, allergens } = req.body;

  const updates = {};
  if (name          !== undefined) updates.name          = name;
  if (category      !== undefined) updates.category      = category;
  if (price_guarani !== undefined) updates.price_guarani = price_guarani;
  if (description   !== undefined) updates.description   = description;
  if (image_url     !== undefined) updates.image_url     = image_url;
  if (sku           !== undefined) updates.sku           = sku || null;
  if (allergens     !== undefined) updates.allergens     = allergens || null;
  if (stock_qty     !== undefined) {
    // null = unlimited stock (always available)
    updates.stock_qty    = stock_qty === null ? null : stock_qty;
    updates.is_available = stock_qty === null ? true : stock_qty > 0;
  }
  if (is_available  !== undefined) updates.is_available  = is_available;

  const { data, error } = await supabase
    .from('products')
    .update(updates)
    .eq('id', req.params.id)
    .eq('tenant_id', req.tenant.tenantId)   // security: tenant can only edit own products
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── POST /admin/products/:id/image — upload foto prodotto ───────────────────

router.post('/products/:id/image', requireAuth, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Ningún archivo recibido' });

  try {
    const publicUrl = await uploadImageBuffer(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype,
      req.tenant.tenantId       // ← cartella separata per tenant
    );

    const { data, error } = await supabase
      .from('products')
      .update({ image_url: publicUrl })
      .eq('id', req.params.id)
      .eq('tenant_id', req.tenant.tenantId)
      .select('id, name, image_url')
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /admin/products/:id ───────────────────────────────────────────────

router.delete('/products/:id', requireAuth, async (req, res) => {
  const { error } = await supabase
    .from('products')
    .delete()
    .eq('id', req.params.id)
    .eq('tenant_id', req.tenant.tenantId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ─── GET /admin/orders ────────────────────────────────────────────────────────

router.get('/orders', requireAuth, async (req, res) => {
  // Join with conversations to get customer_name
  const { data, error } = await supabase
    .from('orders')
    .select('*, conversations(customer_name)')
    .eq('tenant_id', req.tenant.tenantId)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return res.status(500).json({ error: error.message });

  // Flatten customer_name onto each order
  const orders = (data || []).map(o => ({
    ...o,
    customer_name: o.conversations?.customer_name || null,
    conversations: undefined
  }));
  res.json(orders);
});

// ─── GET /admin/customers ─────────────────────────────────────────────────────

router.get('/customers', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('conversations')
    .select('customer_phone, customer_name, customer_email, customer_address, updated_at')
    .eq('tenant_id', req.tenant.tenantId)
    .order('updated_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── POST /admin/customers — add customer manually ───────────────────────────

router.post('/customers', requireAuth, async (req, res) => {
  let { phone, name, email, address } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required', errorCode: 'missing_phone' });
  phone = String(phone).replace(/\D/g, '');
  if (!phone) return res.status(400).json({ error: 'invalid phone', errorCode: 'invalid_phone' });

  const { error } = await supabase
    .from('conversations')
    .upsert({
      tenant_id:     req.tenant.tenantId,
      customer_phone: phone,
      customer_name:    name?.trim()    || null,
      customer_email:   email?.trim()   || null,
      customer_address: address?.trim() || null,
      messages_json:    [],
      updated_at:       new Date().toISOString(),
    }, { onConflict: 'tenant_id,customer_phone', ignoreDuplicates: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ─── PUT /admin/customers/:phone/name ────────────────────────────────────────

router.put('/customers/:phone/name', requireAuth, async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Nombre requerido' });

  const { error } = await supabase
    .from('conversations')
    .update({ customer_name: name.trim() })
    .eq('tenant_id', req.tenant.tenantId)
    .eq('customer_phone', req.params.phone);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ─── PUT /admin/customers/:phone/info — update email + address ───────────────

router.put('/customers/:phone/info', requireAuth, async (req, res) => {
  const { email, address } = req.body;
  const { error } = await supabase
    .from('conversations')
    .update({
      customer_email:   email?.trim()   || null,
      customer_address: address?.trim() || null,
    })
    .eq('tenant_id', req.tenant.tenantId)
    .eq('customer_phone', req.params.phone);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ─── PUT /admin/orders/:id/status ─────────────────────────────────────────────

router.put('/orders/:id/status', requireAuth, async (req, res) => {
  const { status } = req.body;
  const validStatuses = ['pending','confirmed','preparing','delivering','delivered','cancelled'];
  if (!validStatuses.includes(status))
    return res.status(400).json({ error: 'Status no válido' });

  const { data, error } = await supabase
    .from('orders')
    .update({ status })
    .eq('id', req.params.id)
    .eq('tenant_id', req.tenant.tenantId)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── GET /admin/stats ─────────────────────────────────────────────────────────

router.get('/stats', requireAuth, async (req, res) => {
  const [ordersRes, productsRes] = await Promise.all([
    supabase.from('orders').select('total_guarani, status, created_at')
      .eq('tenant_id', req.tenant.tenantId),
    supabase.from('products').select('id, is_available')
      .eq('tenant_id', req.tenant.tenantId)
  ]);

  const orders   = ordersRes.data  || [];
  const products = productsRes.data || [];

  const today = new Date().toISOString().slice(0, 10);
  const todayOrders = orders.filter(o => o.created_at.slice(0, 10) === today);

  res.json({
    totalOrders:     orders.length,
    todayOrders:     todayOrders.length,
    todayRevenue:    todayOrders.filter(o => o.status !== 'cancelled').reduce((s, o) => s + o.total_guarani, 0),
    totalProducts:   products.length,
    activeProducts:  products.filter(p => p.is_available).length,
    pendingOrders:   orders.filter(o => o.status === 'pending').length,
  });
});

// ─── GET /admin/services ──────────────────────────────────────────────────────

router.get('/services', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('services').select('*')
    .eq('tenant_id', req.tenant.tenantId)
    .order('category').order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── POST /admin/services ─────────────────────────────────────────────────────

router.post('/services', requireAuth, async (req, res) => {
  const { name, category, description, price_type, price_guarani, duration_min, image_url } = req.body;
  if (!name || price_guarani == null)
    return res.status(400).json({ error: 'Nombre y precio son obligatorios' });
  const { data, error } = await supabase.from('services').insert({
    tenant_id: req.tenant.tenantId,
    name, category, description,
    price_type: price_type || 'fixed',
    price_guarani, duration_min: duration_min || null,
    image_url: image_url || null, is_available: true,
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// ─── PUT /admin/services/:id ──────────────────────────────────────────────────

router.put('/services/:id', requireAuth, async (req, res) => {
  const fields = ['name','category','description','price_type','price_guarani','duration_min','image_url','is_available'];
  const updates = {};
  for (const f of fields) if (req.body[f] !== undefined) updates[f] = req.body[f];
  const { data, error } = await supabase.from('services')
    .update(updates).eq('id', req.params.id).eq('tenant_id', req.tenant.tenantId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── POST /admin/services/:id/image ──────────────────────────────────────────

router.post('/services/:id/image', requireAuth, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Ningún archivo recibido' });
  try {
    const publicUrl = await uploadImageBuffer(req.file.buffer, req.file.originalname, req.file.mimetype, req.tenant.tenantId);
    const { data, error } = await supabase.from('services')
      .update({ image_url: publicUrl }).eq('id', req.params.id).eq('tenant_id', req.tenant.tenantId)
      .select('id, name, image_url').single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── DELETE /admin/services/:id ───────────────────────────────────────────────

router.delete('/services/:id', requireAuth, async (req, res) => {
  const { error } = await supabase.from('services')
    .delete().eq('id', req.params.id).eq('tenant_id', req.tenant.tenantId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ─── GET /admin/chats — conversation list with last message + pending order ────

router.get('/chats', requireAuth, async (req, res) => {
  const [convsRes, ordersRes] = await Promise.all([
    supabase.from('conversations')
      .select('customer_phone, customer_name, updated_at, messages_json, takeover_active')
      .eq('tenant_id', req.tenant.tenantId)
      .order('updated_at', { ascending: false }),
    supabase.from('orders')
      .select('customer_phone, id, total_guarani, items_json, delivery_fee, status')
      .eq('tenant_id', req.tenant.tenantId)
      .eq('status', 'pending'),
  ]);

  const pendingMap = {};
  for (const o of ordersRes.data || []) pendingMap[o.customer_phone] = o;

  const result = (convsRes.data || []).map(c => {
    const msgs = c.messages_json || [];
    const last = msgs[msgs.length - 1];
    let preview = '';
    if (last) {
      const raw = typeof last.content === 'string' ? last.content : '';
      const clean = raw.replace(/<[^>]+>/g, '').replace(/\[.*?\]/g, '').trim();
      preview = (last.source === 'merchant' ? '👤 ' : last.role === 'user' ? '' : '🤖 ') +
                clean.slice(0, 60);
    }
    return {
      customer_phone:  c.customer_phone,
      customer_name:   c.customer_name,
      updated_at:      c.updated_at,
      takeover_active: c.takeover_active,
      preview,
      pending_order:   pendingMap[c.customer_phone] || null,
    };
  });
  res.json(result);
});

// ─── GET /admin/chats/:phone — full conversation ───────────────────────────────

router.get('/chats/:phone', requireAuth, async (req, res) => {
  const [convRes, orderRes] = await Promise.all([
    supabase.from('conversations').select('*')
      .eq('tenant_id', req.tenant.tenantId)
      .eq('customer_phone', req.params.phone)
      .maybeSingle(),
    supabase.from('orders')
      .select('id, total_guarani, items_json, delivery_fee, status, created_at')
      .eq('tenant_id', req.tenant.tenantId)
      .eq('customer_phone', req.params.phone)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (!convRes.data) return res.status(404).json({ error: 'No encontrado' });
  res.json({ ...convRes.data, pending_order: orderRes.data || null });
});

// ─── POST /admin/chats/:phone/send — send text from merchant ──────────────────

router.post('/chats/:phone/send', requireAuth, async (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Texto requerido' });

  const { data: t } = await supabase.from('tenants')
    .select('phone_number_id, whatsapp_token').eq('id', req.tenant.tenantId).single();
  const token = t.whatsapp_token || process.env.WHATSAPP_TOKEN;

  await sendMessage(req.params.phone, text.trim(), t.phone_number_id, token);

  const { data: conv } = await supabase.from('conversations').select('messages_json')
    .eq('tenant_id', req.tenant.tenantId).eq('customer_phone', req.params.phone).maybeSingle();
  const msgs = [...(conv?.messages_json || []),
    { role: 'assistant', content: text.trim(), source: 'merchant' }];
  await supabase.from('conversations')
    .update({
      messages_json: msgs,
      updated_at: new Date().toISOString(),
      takeover_active: true,
      takeover_started_at: new Date().toISOString(),
      last_pending_customer_phone: req.params.phone,
    })
    .eq('tenant_id', req.tenant.tenantId).eq('customer_phone', req.params.phone);

  res.json({ ok: true });
});

// ─── PATCH /admin/chats/:phone/notes — save customer notes ───────────────────

router.patch('/chats/:phone/notes', requireAuth, async (req, res) => {
  const { notes } = req.body;
  if (notes === undefined) return res.status(400).json({ error: 'notes required' });
  await supabase.from('conversations')
    .update({ customer_notes: notes })
    .eq('tenant_id', req.tenant.tenantId)
    .eq('customer_phone', req.params.phone);
  res.json({ ok: true });
});

// ─── POST /admin/chats/:phone/resume — hand back to bot ───────────────────────

router.post('/chats/:phone/resume', requireAuth, async (req, res) => {
  await supabase.from('conversations')
    .update({ takeover_active: false, takeover_started_at: null })
    .eq('tenant_id', req.tenant.tenantId).eq('customer_phone', req.params.phone);
  res.json({ ok: true });
});

// ─── POST /admin/chats/:phone/send-image — send image (URL or upload) ─────────

router.post('/chats/:phone/send-image', requireAuth, upload.single('image'), async (req, res) => {
  const { data: t } = await supabase.from('tenants')
    .select('phone_number_id, whatsapp_token').eq('id', req.tenant.tenantId).single();
  const token = t.whatsapp_token || process.env.WHATSAPP_TOKEN;

  let imageUrl = req.body.url || null;
  if (req.file) {
    imageUrl = await uploadImageBuffer(
      req.file.buffer, req.file.originalname, req.file.mimetype, req.tenant.tenantId
    );
  }
  if (!imageUrl) return res.status(400).json({ error: 'Se requiere imagen' });

  const caption = req.body.caption?.trim() || '';
  await sendImage(req.params.phone, imageUrl, caption, t.phone_number_id, token);

  const { data: conv } = await supabase.from('conversations').select('messages_json')
    .eq('tenant_id', req.tenant.tenantId).eq('customer_phone', req.params.phone).maybeSingle();
  const msgs = [...(conv?.messages_json || []),
    { role: 'assistant', content: `[foto] ${caption}`.trim(), source: 'merchant', image_url: imageUrl }];
  await supabase.from('conversations')
    .update({ messages_json: msgs, updated_at: new Date().toISOString() })
    .eq('tenant_id', req.tenant.tenantId).eq('customer_phone', req.params.phone);

  res.json({ ok: true, url: imageUrl });
});

// ─── POST /admin/whatsapp-connect — exchange Meta Embedded Signup code ────────
router.post('/whatsapp-connect', requireAuth, async (req, res) => {
  const { code, phone_number_id, waba_id } = req.body;
  if (!code) return res.status(400).json({ error: 'Missing code' });

  const APP_ID     = process.env.META_APP_ID;
  const APP_SECRET = process.env.META_APP_SECRET;
  if (!APP_ID || !APP_SECRET)
    return res.status(500).json({ error: 'META_APP_ID / META_APP_SECRET not configured on server' });

  try {
    // 1. Exchange code for short-lived user token
    const tokenUrl = `https://graph.facebook.com/v19.0/oauth/access_token` +
      `?client_id=${APP_ID}&client_secret=${APP_SECRET}&code=${encodeURIComponent(code)}`;
    const tokenRes  = await fetch(tokenUrl);
    const tokenData = await tokenRes.json();
    if (tokenData.error) return res.status(400).json({ error: tokenData.error.message });

    // 2. Exchange for long-lived token (60 days)
    const longUrl = `https://graph.facebook.com/v19.0/oauth/access_token` +
      `?grant_type=fb_exchange_token&client_id=${APP_ID}&client_secret=${APP_SECRET}` +
      `&fb_exchange_token=${tokenData.access_token}`;
    const longRes  = await fetch(longUrl);
    const longData = await longRes.json();
    const accessToken = longData.access_token || tokenData.access_token;

    // 3. If phone_number_id not passed by client (from session_info), fetch it
    let phoneNumberId = phone_number_id;
    if (!phoneNumberId && waba_id) {
      const pnRes  = await fetch(
        `https://graph.facebook.com/v19.0/${waba_id}/phone_numbers?access_token=${accessToken}`
      );
      const pnData = await pnRes.json();
      phoneNumberId = pnData.data?.[0]?.id || null;
    }

    if (!phoneNumberId)
      return res.status(400).json({ error: 'No se pudo obtener el phone_number_id. Intentá de nuevo.' });

    // 4. Register webhook for this phone number
    try {
      await fetch(
        `https://graph.facebook.com/v19.0/${phoneNumberId}/subscribed_apps`,
        { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` } }
      );
    } catch (_) { /* non-fatal */ }

    // 5. Fetch display phone number
    let botPhoneNumber = null;
    try {
      const dpRes  = await fetch(`https://graph.facebook.com/v19.0/${phoneNumberId}?fields=display_phone_number&access_token=${accessToken}`);
      const dpData = await dpRes.json();
      botPhoneNumber = dpData.display_phone_number || null;
    } catch (_) { /* non-fatal */ }

    // 6. Save to tenant
    const tokenExpiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
    const { error: dbErr } = await supabase.from('tenants')
      .update({ phone_number_id: phoneNumberId, whatsapp_token: accessToken, whatsapp_token_expires_at: tokenExpiresAt, bot_phone_number: botPhoneNumber })
      .eq('id', req.tenant.tenantId);
    if (dbErr) return res.status(500).json({ error: dbErr.message });

    res.json({ ok: true, phone_number_id: phoneNumberId });
  } catch (e) {
    console.error('[whatsapp-connect]', e);
    res.status(500).json({ error: 'Error al conectar con Meta: ' + e.message });
  }
});

// ─── POST /admin/whatsapp-connect-manual — save credentials manually ──────────
router.post('/whatsapp-connect-manual', requireAuth, async (req, res) => {
  const { phone_number_id, access_token } = req.body;
  if (!phone_number_id || !access_token)
    return res.status(400).json({ error: 'phone_number_id y access_token son obligatorios' });

  // Validate token + phone_number_id against Meta API before saving
  let botPhoneNumber = null;
  try {
    const verifyRes = await fetch(
      `https://graph.facebook.com/v19.0/${phone_number_id}?fields=display_phone_number,verified_name&access_token=${access_token}`
    );
    const verifyData = await verifyRes.json();
    if (!verifyRes.ok || verifyData.error) {
      return res.status(400).json({ error: 'Token o Phone Number ID no válido', errorCode: 'invalid_meta_credentials' });
    }
    botPhoneNumber = verifyData.display_phone_number || null;
  } catch {
    return res.status(502).json({ error: 'No se pudo verificar el token con Meta', errorCode: 'meta_unreachable' });
  }

  const tokenExpiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();

  const { error } = await supabase.from('tenants')
    .update({ phone_number_id, whatsapp_token: access_token, whatsapp_token_expires_at: tokenExpiresAt, bot_phone_number: botPhoneNumber })
    .eq('id', req.tenant.tenantId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ─── POST /admin/import-preview — fetch & parse Google Sheet ─────────────────
router.post('/import-preview', requireAuth, async (req, res) => {
  const { url, csvText } = req.body;
  if (!url && !csvText) return res.status(400).json({ error: 'URL o CSV requerido' });

  try {
    let csv;
    if (csvText) {
      csv = csvText;
    } else {
      // Extract sheet ID and gid from various Google Sheets URL formats
      const idMatch  = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
      const gidMatch = url.match(/[?&]gid=(\d+)/);
      if (!idMatch) return res.status(400).json({ error: 'URL de Google Sheets inválida' });
      const sheetId = idMatch[1];
      const gid     = gidMatch?.[1] || '0';
      const csvUrl  = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
      const response = await fetch(csvUrl);
      if (!response.ok) {
        if (response.status === 403) return res.status(400).json({ error: 'El Sheet no es público. Compartilo como "Cualquiera con el enlace puede ver".' });
        return res.status(400).json({ error: `No se pudo acceder al Sheet (${response.status})` });
      }
      csv = await response.text();
    }

    // Parse CSV — strip BOM, honor a leading "sep=;" Excel directive, skip
    // "# ..." metadata lines, and auto-detect ";" vs "," delimiter (our exports
    // use ";", Google Sheets ",").
    const lines = csv.replace(/^﻿/, '').split('\n').map(l => l.trim()).filter(Boolean);
    let delim = ',';
    const sepMatch = lines[0]?.match(/^sep=(.)$/i);
    if (sepMatch) { delim = sepMatch[1]; lines.shift(); }
    while (lines.length && lines[0].startsWith('#')) lines.shift(); // drop metadata lines
    if (!sepMatch && (lines[0]?.split(';').length || 0) > (lines[0]?.split(',').length || 0)) delim = ';';
    if (lines.length < 2) return res.status(400).json({ error: 'El Sheet está vacío o tiene solo encabezados' });

    // Normalize header names
    const normalize = s => s.toLowerCase().trim()
      .replace(/[áà]/g,'a').replace(/[éè]/g,'e').replace(/[íì]/g,'i')
      .replace(/[óò]/g,'o').replace(/[úù]/g,'u').replace(/\s+/g,'_');

    const headers = parseCSVLine(lines[0], delim).map(normalize);

    const COL = {
      name:        headers.findIndex(h => ['nombre','name','producto','servicio'].includes(h)),
      category:    headers.findIndex(h => ['categoria','category'].includes(h)),
      description: headers.findIndex(h => ['descripcion','description','descripción'].includes(h)),
      price:       headers.findIndex(h => ['precio_gs','precio','price','price_gs','precio_guarani','precio_guaraní'].includes(h)),
      price_type:  headers.findIndex(h => ['tipo','type','price_type','tipo_precio'].includes(h)),
      duration:    headers.findIndex(h => ['duracion_min','duration_min','duracion','duracion_minutos'].includes(h)),
      stock:       headers.findIndex(h => ['stock','stock_qty','cantidad'].includes(h)),
      allergens:   headers.findIndex(h => ['allergens','alergenos','alérgenos','alergeni','allergeni'].includes(h)),
      image_url:   headers.findIndex(h => ['imagen_url','image_url','imagen','image','foto','foto_url'].includes(h)),
      available:   headers.findIndex(h => ['disponible','available','activo','active'].includes(h)),
    };

    if (COL.name === -1)  return res.status(400).json({ error: 'No se encontró columna "nombre". Verificá el template.' });
    if (COL.price === -1) return res.status(400).json({ error: 'No se encontró columna "precio_gs". Verificá el template.' });

    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const cells = parseCSVLine(lines[i], delim);
      const name  = cells[COL.name]?.trim();
      if (!name) continue; // skip empty rows

      const priceRaw = cells[COL.price]?.replace(/[^\d.,]/g, '').replace(',', '.') || '0';
      const price    = parseFloat(priceRaw) || 0;
      const typeRaw  = cells[COL.price_type]?.toLowerCase().trim() || 'fixed';
      const type     = typeRaw === 'hourly' || typeRaw === 'hora' || typeRaw === 'por_hora' ? 'hourly' : 'fixed';
      const avail    = cells[COL.available]?.toLowerCase().trim();
      const isAvail  = !avail || ['si','sí','yes','true','1','disponible'].includes(avail);

      rows.push({
        name,
        category:    cells[COL.category]?.trim()    || '',
        description: cells[COL.description]?.trim() || '',
        price_guarani: price,
        price_type:  type,
        duration_min: COL.duration >= 0 ? (parseInt(cells[COL.duration]) || null) : null,
        stock_qty:   COL.stock    >= 0 ? (parseInt(cells[COL.stock])    || 0)    : null,
        allergens:   COL.allergens >= 0 ? (cells[COL.allergens]?.trim() || null) : null,
        image_url:   COL.image_url >= 0 ? (cells[COL.image_url]?.trim() || null) : null,
        is_available: isAvail,
      });
    }

    if (!rows.length) return res.status(400).json({ error: 'No se encontraron filas con datos válidos' });
    res.json({ rows, total: rows.length });
  } catch (e) {
    console.error('[import-preview]', e);
    res.status(500).json({ error: 'Error al leer el Sheet: ' + e.message });
  }
});

// ─── POST /admin/import-confirm — bulk insert products/services (append + deduplicate) ──
router.post('/import-confirm', requireAuth, async (req, res) => {
  const { rows } = req.body;
  const target = req.body.target === 'services' ? 'services' : 'products';
  if (!Array.isArray(rows) || !rows.length)
    return res.status(400).json({ error: 'Sin datos para importar' });

  try {
    // Restaurant dishes don't track stock — force stock_qty null on insert.
    const { data: tn } = await supabase
      .from('tenants').select('restaurant_enabled').eq('id', req.tenant.tenantId).single();
    const isMenu = !!tn?.restaurant_enabled;

    // Fetch existing names to avoid duplicates (exact match)
    const { data: existing } = await supabase
      .from(target).select('name').eq('tenant_id', req.tenant.tenantId);
    const existingNames = new Set((existing || []).map(p => p.name.trim().toLowerCase()));

    const candidates = rows.filter(r => r.name && !existingNames.has(String(r.name).trim().toLowerCase()));

    const toInsert = target === 'services'
      ? candidates.map(r => ({
          tenant_id:     req.tenant.tenantId,
          name:          String(r.name).trim(),
          category:      r.category     || null,
          description:   r.description  || null,
          price_guarani: r.price_guarani || 0,
          price_type:    r.price_type    || 'fixed',
          duration_min:  r.duration_min  || null,
          image_url:     r.image_url     || null,
          is_available:  r.is_available  ?? true,
        }))
      : candidates.map(r => ({
          tenant_id:     req.tenant.tenantId,
          name:          String(r.name).trim(),
          category:      r.category     || null,
          description:   r.description  || null,
          price_guarani: r.price_guarani || 0,
          price_type:    r.price_type    || 'fixed',
          duration_min:  r.duration_min  || null,
          stock_qty:     isMenu ? null : (r.stock_qty ?? 99),
          allergens:     r.allergens     || null,
          image_url:     r.image_url     || null,
          is_available:  r.is_available  ?? true,
        }));

    const skipped = rows.length - toInsert.length;
    if (toInsert.length > 0) {
      const { error } = await supabase.from(target).insert(toInsert);
      if (error) return res.status(500).json({ error: error.message });
    }

    res.json({ ok: true, imported: toInsert.length, skipped });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /admin/import-from-images — AI catalog extraction ───────────────────
router.post('/import-from-images', requireAuth, uploadCatalog.array('images', 6), async (req, res) => {
  if (!req.files || req.files.length === 0)
    return res.status(400).json({ error: 'No se enviaron imágenes' });

  const { data: t } = await supabase.from('tenants')
    .select('plan_currency, restaurant_enabled').eq('id', req.tenant.tenantId).single();
  const currency = t?.plan_currency || 'USD';

  const promptText = t?.restaurant_enabled
    ? `Analizá estas ${req.files.length} imágenes del menú de un restaurante (carta de platos, lista de precios, etc.).

Extraé TODOS los platos y bebidas que puedas ver, con:
- name: nombre del plato/bebida (obligatorio)
- category: la SECCIÓN del menú a la que pertenece (Entradas, Primeros, Carnes, Pastas, Postres, Bebidas, etc.). Usá el encabezado de sección impreso en el menú; si no hay, inferí uno razonable.
- price_guarani: precio en ${currency} como número (puede tener decimales, ej: 4.99; si no hay precio pon 0)
- description: descripción del plato si la hay (ingredientes, corte de carne, cocción). Si no hay, dejá vacío.
- allergens: alérgenos si están indicados (gluten, lácteos, frutos secos, mariscos, huevo, etc.) como texto separado por comas. Si no se indican, dejá vacío.

Respondé ÚNICAMENTE con un JSON válido, sin texto adicional, en este formato:
{"products":[{"name":"...","category":"...","price_guarani":0,"description":"...","allergens":"..."}]}`
    : `Analizá estas ${req.files.length} imágenes de un catálogo de negocios (menú, lista de precios, catálogo de WhatsApp Business, etc.).

Extraé TODOS los productos o servicios que puedas ver, con:
- name: nombre del producto/servicio (obligatorio)
- category: categoría (si hay, sino inferí una razonable)
- price_guarani: precio en ${currency} como número (puede tener decimales, ej: 4.99; si no hay precio pon 0)
- description: descripción breve si hay (sino dejar vacío)

Respondé ÚNICAMENTE con un JSON válido, sin texto adicional, en este formato:
{"products":[{"name":"...","category":"...","price_guarani":0,"description":"..."}]}`;

  const content = [{ type: 'text', text: promptText }];

  for (const file of req.files) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: file.mimetype || 'image/jpeg', data: file.buffer.toString('base64') }
    });
  }

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      messages: [{ role: 'user', content }]
    });
    const text = response.content[0].text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Respuesta inesperada de la IA');
    const parsed = JSON.parse(jsonMatch[0]);
    res.json({ products: parsed.products || [] });
  } catch (e) {
    console.error('[import-from-images]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /admin/products/bulk-images — ZIP upload, fuzzy match filenames ────
function detectImageMime(buffer) {
  if (!buffer || buffer.length < 12) return null;
  // JPEG: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'image/jpeg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'image/png';
  // GIF: GIF8
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) return 'image/gif';
  // WebP: RIFF....WEBP
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return 'image/webp';
  return null;
}

function normalizeName(s) {
  return s.toLowerCase()
    .replace(/\.[^.]+$/, '')
    .replace(/[áàä]/g,'a').replace(/[éèë]/g,'e').replace(/[íìï]/g,'i')
    .replace(/[óòö]/g,'o').replace(/[úùü]/g,'u').replace(/ñ/g,'n')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function matchScore(filename, productName) {
  const a = normalizeName(filename);
  const b = normalizeName(productName);
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.9;
  const wa = a.split(' ').filter(w => w.length > 2);
  const wb = new Set(b.split(' ').filter(w => w.length > 2));
  if (!wa.length || !wb.size) return 0;
  const hits = wa.filter(w => wb.has(w)).length;
  return hits / Math.max(wa.length, wb.size);
}

const zipRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => req.tenant?.tenantId || req.ip,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many ZIP uploads, try again in 1 hour.' },
});

const MAX_ZIP_ENTRIES   = 300;
const MAX_ENTRY_BYTES   = 8 * 1024 * 1024;  // 8 MB uncompressed per image
const MAX_TOTAL_BYTES   = 200 * 1024 * 1024; // 200 MB total uncompressed

function handleZipUpload(req, res, next) {
  uploadZip.single('zipfile')(req, res, (err) => {
    if (err && err.code === 'LIMIT_FILE_SIZE')
      return res.status(413).json({ error: 'ZIP file exceeds 50 MB limit.' });
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}

router.post('/products/bulk-images', requireAuth, zipRateLimit, handleZipUpload, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No ZIP file received' });

  const ALLOWED_MIME = new Set(['image/jpeg','image/png','image/webp','image/gif']);
  const MIN_SCORE = 0.5;

  let zip;
  try {
    zip = new AdmZip(req.file.buffer);
  } catch {
    return res.status(400).json({ error: 'Invalid ZIP file' });
  }

  const allEntries = zip.getEntries().filter(e =>
    !e.isDirectory && !e.entryName.startsWith('__MACOSX') && !e.entryName.startsWith('.')
  );

  if (allEntries.length > MAX_ZIP_ENTRIES)
    return res.status(400).json({ error: `ZIP contains too many files (max ${MAX_ZIP_ENTRIES}).` });

  // ZIP bomb check: sum uncompressed sizes before extracting anything
  const totalUncompressed = allEntries.reduce((s, e) => s + (e.header.size || 0), 0);
  if (totalUncompressed > MAX_TOTAL_BYTES)
    return res.status(400).json({ error: 'ZIP uncompressed content exceeds 200 MB limit.' });

  const { data: products, error } = await supabase
    .from('products').select('id, name').eq('tenant_id', req.tenant.tenantId);
  if (error) return res.status(500).json({ error: error.message });
  if (!products?.length) return res.status(400).json({ error: 'No products found. Add products first.' });

  const entries = allEntries.filter(e => {
    const name = e.entryName.replace(/.*[\\/]/, '');
    return /\.(jpe?g|png|webp|gif)$/i.test(name);
  });

  const matched = [], unmatched = [];

  for (const entry of entries) {
    const filename = entry.entryName.replace(/.*[\\/]/, '');
    if ((entry.header.size || 0) > MAX_ENTRY_BYTES) {
      unmatched.push(filename + ' (exceeds 8 MB uncompressed)');
      continue;
    }
    const mime = filename.match(/\.png$/i) ? 'image/png'
               : filename.match(/\.webp$/i) ? 'image/webp'
               : filename.match(/\.gif$/i)  ? 'image/gif'
               : 'image/jpeg';

    let best = null, bestScore = 0;
    for (const p of products) {
      const s = matchScore(filename, p.name);
      if (s > bestScore) { bestScore = s; best = p; }
    }

    if (!best || bestScore < MIN_SCORE) { unmatched.push(filename); continue; }

    try {
      const buffer = entry.getData();
      const realMime = detectImageMime(buffer);
      if (!realMime) { unmatched.push(filename + ' (not a valid image)'); continue; }
      const imageUrl = await uploadImageBuffer(buffer, filename, realMime, req.tenant.tenantId);
      await supabase.from('products').update({ image_url: imageUrl }).eq('id', best.id);
      matched.push({ filename, productId: best.id, productName: best.name, score: Math.round(bestScore * 100) });
    } catch (e) {
      unmatched.push(filename + ' (upload error: ' + e.message + ')');
    }
  }

  res.json({ matched, unmatched });
});

// Helper: parse a single CSV line respecting quoted fields
function parseCSVLine(line, delim = ',') {
  const result = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; continue; }
    if (c === delim && !inQ) { result.push(cur); cur = ''; continue; }
    cur += c;
  }
  result.push(cur);
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// APPOINTMENTS
// ═══════════════════════════════════════════════════════════════════════════════

// ─── GET /admin/business-hours ───────────────────────────────────────────────
router.get('/business-hours', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('business_hours').select('*')
    .eq('tenant_id', req.tenant.tenantId)
    .order('day_of_week');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── PUT /admin/business-hours — upsert all 7 days at once ──────────────────
router.put('/business-hours', requireAuth, async (req, res) => {
  const days = req.body; // array of { day_of_week, open_time, close_time, is_closed }
  if (!Array.isArray(days)) return res.status(400).json({ error: 'Se esperaba un array' });
  const rows = days.map(d => ({
    tenant_id:   req.tenant.tenantId,
    day_of_week: d.day_of_week,
    open_time:   d.is_closed ? null : (d.open_time  || '09:00'),
    close_time:  d.is_closed ? null : (d.close_time || '18:00'),
    is_closed:   !!d.is_closed,
  }));
  const { error } = await supabase.from('business_hours')
    .upsert(rows, { onConflict: 'tenant_id,day_of_week' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ─── GET /admin/offers ────────────────────────────────────────────────────────
router.get('/offers', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('offers').select('*')
    .eq('tenant_id', req.tenant.tenantId).order('created_at');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/offers', requireAuth, async (req, res) => {
  const { label, discount_type, discount_value, scope, scope_target, valid_from, valid_to } = req.body;
  if (!label || !discount_type || discount_value == null || !scope)
    return res.status(400).json({ error: 'label, discount_type, discount_value, scope required' });
  if (!['percent','fixed'].includes(discount_type))
    return res.status(400).json({ error: 'discount_type must be percent or fixed' });
  if (!['all_products','category','product','all_services','service_category','service'].includes(scope))
    return res.status(400).json({ error: 'invalid scope' });
  const { data, error } = await supabase.from('offers').insert({
    tenant_id: req.tenant.tenantId, label, discount_type,
    discount_value: parseFloat(discount_value),
    scope, scope_target: scope_target || null,
    valid_from: valid_from || null, valid_to: valid_to || null,
    is_active: true,
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  invalidateOffers(req.tenant.tenantId);
  res.json(data);
});

router.delete('/offers/:id', requireAuth, async (req, res) => {
  const { error } = await supabase.from('offers').delete()
    .eq('id', req.params.id).eq('tenant_id', req.tenant.tenantId);
  if (error) return res.status(500).json({ error: error.message });
  invalidateOffers(req.tenant.tenantId);
  res.json({ ok: true });
});

// ─── GET /admin/business-closures ────────────────────────────────────────────
router.get('/business-closures', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('business_closures').select('*')
    .eq('tenant_id', req.tenant.tenantId)
    .order('start_date');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/business-closures', requireAuth, async (req, res) => {
  const { start_date, end_date, label } = req.body;
  if (!start_date || !end_date) return res.status(400).json({ error: 'start_date and end_date required' });
  if (end_date < start_date) return res.status(400).json({ error: 'end_date must be >= start_date' });
  const { data, error } = await supabase.from('business_closures').insert({
    tenant_id: req.tenant.tenantId, start_date, end_date, label: label || null,
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  invalidateClosures(req.tenant.tenantId);
  res.json(data);
});

router.delete('/business-closures/:id', requireAuth, async (req, res) => {
  const { error } = await supabase.from('business_closures')
    .delete().eq('id', req.params.id).eq('tenant_id', req.tenant.tenantId);
  if (error) return res.status(500).json({ error: error.message });
  invalidateClosures(req.tenant.tenantId);
  res.json({ ok: true });
});

// ─── GET /admin/appointments?from=ISO&to=ISO ─────────────────────────────────
router.get('/appointments', requireAuth, async (req, res) => {
  const { from, to } = req.query;
  let q = supabase.from('appointments').select('*')
    .eq('tenant_id', req.tenant.tenantId)
    .order('start_at');
  if (from) q = q.gte('start_at', from);
  if (to)   q = q.lte('start_at', to);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── POST /admin/appointments ────────────────────────────────────────────────
router.post('/appointments', requireAuth, async (req, res) => {
  const { customer_phone, customer_name, service_id, start_at, notes } = req.body;
  if (!start_at) return res.status(400).json({ error: 'start_at es obligatorio' });

  // Resolve service duration
  let service_name = null, service_duration_min = 30;
  if (service_id) {
    const { data: svc } = await supabase.from('services')
      .select('name, duration_min').eq('id', service_id).eq('tenant_id', req.tenant.tenantId).single();
    if (svc) { service_name = svc.name; service_duration_min = svc.duration_min || 30; }
  }

  const end_at = new Date(new Date(start_at).getTime() + service_duration_min * 60000).toISOString();

  const { data, error } = await supabase.from('appointments').insert({
    tenant_id: req.tenant.tenantId,
    customer_phone: customer_phone || '',
    customer_name: customer_name || null,
    service_id: service_id || null,
    service_name, service_duration_min,
    start_at, end_at,
    status: 'confirmed',
    notes: notes || null,
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// ─── PUT /admin/appointments/:id ─────────────────────────────────────────────
router.put('/appointments/:id', requireAuth, async (req, res) => {
  const allowed = ['customer_name','customer_phone','status','notes','start_at','end_at'];
  const updates = {};
  for (const f of allowed) if (req.body[f] !== undefined) updates[f] = req.body[f];
  const { data, error } = await supabase.from('appointments')
    .update(updates).eq('id', req.params.id).eq('tenant_id', req.tenant.tenantId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── DELETE /admin/appointments/:id ──────────────────────────────────────────
router.delete('/appointments/:id', requireAuth, async (req, res) => {
  await supabase.from('appointments')
    .delete().eq('id', req.params.id).eq('tenant_id', req.tenant.tenantId);
  res.json({ ok: true });
});

// ─── GET /admin/appointment-blocks?from=ISO&to=ISO ───────────────────────────
router.get('/appointment-blocks', requireAuth, async (req, res) => {
  const { from, to } = req.query;
  let q = supabase.from('appointment_blocks').select('*')
    .eq('tenant_id', req.tenant.tenantId).order('start_at');
  if (from) q = q.gte('start_at', from);
  if (to)   q = q.lte('start_at', to);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── POST /admin/appointment-blocks ──────────────────────────────────────────
router.post('/appointment-blocks', requireAuth, async (req, res) => {
  const { start_at, end_at, reason } = req.body;
  if (!start_at || !end_at) return res.status(400).json({ error: 'start_at y end_at son obligatorios' });
  const { data, error } = await supabase.from('appointment_blocks').insert({
    tenant_id: req.tenant.tenantId, start_at, end_at, reason: reason || null,
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// ─── DELETE /admin/appointment-blocks/:id ────────────────────────────────────
router.delete('/appointment-blocks/:id', requireAuth, async (req, res) => {
  await supabase.from('appointment_blocks')
    .delete().eq('id', req.params.id).eq('tenant_id', req.tenant.tenantId);
  res.json({ ok: true });
});

// ─── GET /admin/available-slots?date=YYYY-MM-DD&service_id=uuid ──────────────
// Calcola gli slot liberi per una data, usato dal bot e dal pannello
router.get('/available-slots', requireAuth, async (req, res) => {
  const { date, service_id, duration_min } = req.query;
  if (!date) return res.status(400).json({ error: 'date es obligatorio' });

  const dayOfWeek = new Date(date + 'T12:00:00Z').getUTCDay(); // 0=dom..6=sab

  // Orari del locale quel giorno + capacità parallela del tenant
  const [{ data: bh }, { data: tCfg }] = await Promise.all([
    supabase.from('business_hours').select('*')
      .eq('tenant_id', req.tenant.tenantId).eq('day_of_week', dayOfWeek).single(),
    supabase.from('tenants').select('appointment_capacity').eq('id', req.tenant.tenantId).single(),
  ]);
  const cap = Math.max(1, tCfg?.appointment_capacity || 1);

  if (!bh || bh.is_closed) return res.json({ slots: [], closed: true });

  // Durata servizio
  let slotDuration = parseInt(duration_min) || 30;
  if (service_id) {
    const { data: svc } = await supabase.from('services')
      .select('duration_min').eq('id', service_id).eq('tenant_id', req.tenant.tenantId).single();
    if (svc?.duration_min) slotDuration = svc.duration_min;
  }

  // Costruisci tutti gli slot nella giornata
  const [openH, openM]   = bh.open_time.split(':').map(Number);
  const [closeH, closeM] = bh.close_time.split(':').map(Number);
  const openMin  = openH * 60 + openM;
  const closeMin = closeH * 60 + closeM;

  const allSlots = [];
  for (let m = openMin; m + slotDuration <= closeMin; m += slotDuration) {
    const h = String(Math.floor(m / 60)).padStart(2, '0');
    const min = String(m % 60).padStart(2, '0');
    allSlots.push(`${date}T${h}:${min}:00`);
  }

  // Appuntamenti esistenti quel giorno
  const dayStart = `${date}T00:00:00`;
  const dayEnd   = `${date}T23:59:59`;
  const { data: existing } = await supabase.from('appointments').select('start_at, end_at')
    .eq('tenant_id', req.tenant.tenantId)
    .gte('start_at', dayStart).lte('start_at', dayEnd)
    .neq('status', 'cancelled');

  // Blocchi manuali quel giorno
  const { data: blocks } = await supabase.from('appointment_blocks').select('start_at, end_at')
    .eq('tenant_id', req.tenant.tenantId)
    .gte('start_at', dayStart).lte('start_at', dayEnd);

  // Blocks always close the slot; appointments only fill it once they reach capacity
  const overlaps = (b, sStart, sEnd) => {
    const bStart = new Date(b.start_at).getTime();
    const bEnd   = new Date(b.end_at).getTime();
    return sStart < bEnd && sEnd > bStart;
  };
  const freeSlots = allSlots.filter(slotStart => {
    const sStart = new Date(slotStart).getTime();
    const sEnd   = sStart + slotDuration * 60000;
    if ((blocks || []).some(b => overlaps(b, sStart, sEnd))) return false;
    return (existing || []).filter(b => overlaps(b, sStart, sEnd)).length < cap;
  });

  res.json({ slots: freeSlots, duration_min: slotDuration });
});

// ─── POST /admin/whatsapp-profile ─────────────────────────────────────────────
// Updates WhatsApp Business profile: photo and/or about text

router.post('/whatsapp-profile', requireAuth, upload.single('photo'), async (req, res) => {
  // Get tenant credentials
  const { data: tenant, error: tErr } = await supabase
    .from('tenants')
    .select('phone_number_id, whatsapp_token')
    .eq('id', req.tenant.tenantId)
    .single();

  if (tErr || !tenant) return res.status(500).json({ error: 'No se pudo obtener los datos del tenant' });

  const phoneNumberId = tenant.phone_number_id;
  const token = tenant.whatsapp_token || process.env.WHATSAPP_TOKEN;

  if (!phoneNumberId || !token) {
    return res.status(400).json({ error: 'El bot no tiene un número de WhatsApp conectado todavía.' });
  }

  const errors = [];

  // 1. Update "about" text if provided
  const about = req.body?.about?.trim();
  if (about) {
    try {
      const profileRes = await fetch(
        `https://graph.facebook.com/v19.0/${phoneNumberId}/whatsapp_business_profile`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            about,
          }),
        }
      );
      const profileData = await profileRes.json();
      if (!profileRes.ok) {
        errors.push(`About: ${profileData.error?.message || profileRes.statusText}`);
      }
    } catch (e) {
      errors.push('About: ' + e.message);
    }
  }

  // 2. Upload profile photo if provided
  if (req.file) {
    try {
      // Step 2a: Create an upload session
      const sessionRes = await fetch(
        `https://graph.facebook.com/v19.0/${phoneNumberId}/whatsapp_business_profile`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            profile_picture_url: null, // will be replaced by handle upload below
          }),
        }
      );

      // Use the Media Upload API instead
      // Step 2a: Upload media to get a handle
      const formData = new FormData();
      const blob = new Blob([req.file.buffer], { type: req.file.mimetype });
      formData.append('file', blob, req.file.originalname || 'profile.jpg');
      formData.append('type', req.file.mimetype);
      formData.append('messaging_product', 'whatsapp');

      const mediaRes = await fetch(
        `https://graph.facebook.com/v19.0/${phoneNumberId}/media`,
        {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` },
          body: formData,
        }
      );
      const mediaData = await mediaRes.json();

      if (!mediaRes.ok || !mediaData.id) {
        errors.push(`Foto (subida): ${mediaData.error?.message || 'No se pudo subir la imagen'}`);
      } else {
        // Step 2b: Set the profile picture using the media handle
        const picRes = await fetch(
          `https://graph.facebook.com/v19.0/${phoneNumberId}/whatsapp_business_profile`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              messaging_product: 'whatsapp',
              profile_picture_handle: mediaData.id,
            }),
          }
        );
        const picData = await picRes.json();
        if (!picRes.ok) {
          errors.push(`Foto (perfil): ${picData.error?.message || picRes.statusText}`);
        }
      }
    } catch (e) {
      errors.push('Foto: ' + e.message);
    }
  }

  if (errors.length) {
    return res.status(500).json({ error: errors.join(' | ') });
  }

  res.json({ ok: true });
});

// ─── GET /admin/support — fetch support conversation ─────────────────────────
router.get('/support', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('support_messages')
    .select('id, role, content, created_at')
    .eq('tenant_id', req.tenant.tenantId)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

const SUPPORT_SYSTEM_PROMPT = `You are Sara Bot's automated support assistant for merchants (business owners) using the Sara Bot admin panel.

STRICT RULES — never break these:
- NEVER reveal passwords, WhatsApp tokens, API keys, Stripe keys, or any credentials.
- NEVER share data about other merchants/tenants.
- NEVER invent features, tabs, buttons, or steps. If something is not in the KNOWLEDGE below, do not guess — say you're not certain and escalate.
- NEVER make promises about future features or timelines.
- Detect the merchant's language and always reply in that same language.

HOW TO ANSWER "how do I…" QUESTIONS (most important):
- Give the EXACT real path, step by step, using the on-screen labels in quotes.
- The top tabs are the same in every language thanks to their emoji — ALWAYS include the tab emoji so the merchant finds it regardless of language (e.g. "📦 Productos", "⚙️ Ajustes").
- Button labels below are the Spanish defaults; the panel may be shown in ES/EN/IT/DE/FR/PT, so quote the Spanish label and, if you're answering in another language, add the natural translation in parentheses.
- Be concrete and short: a numbered list of clicks beats a paragraph. Solve the merchant's ACTUAL problem; don't dump unrelated info.
- If you don't have the exact step, do NOT improvise a fake one — escalate.

ESCALATION: if you cannot resolve it (real bug, billing dispute, account action needing manual work, or anything not covered below), start your reply with the token [ESCALATE] on its own line, then answer normally. Don't escalate things the KNOWLEDGE already covers.

═══════════ PANEL KNOWLEDGE (current UI) ═══════════

TOP TABS (left→right): 💬 Chats · 📦 Productos (restaurants: 🍽️ Menú) · 🛠 Servicios · 🛒 Pedidos · 👥 Clientes · 📅 Turnos (restaurants: 📅 Reservas) · 🍽️ Restaurante (restaurant plan only) · ⚙️ Ajustes · 📊 Analytics · 💳 Plan · ❓ Ayuda · 💬 Soporte (this chat).
Which tabs are visible depends on the plan (some merchants don't have Servicios/Turnos/Restaurante).

WHAT SARA DOES: Sara is the AI that chats with the merchant's customers on WhatsApp 24/7 — answers about the catalog, takes orders, manages delivery, books appointments/table reservations, sends product photos and the menu. Sara only chats on WhatsApp; she does not make phone calls.

CONNECT WHATSAPP (required to go live): if not connected, a banner "Conectar ahora" appears (in 💬 Soporte and ⚙️ Ajustes). Click it to open the wizard. Two methods: Facebook login (Embedded Signup, recommended) or manual (Phone Number ID + permanent token from Meta Business). Until connected, most tabs are locked.

📦 PRODUCTOS (catalog):
- Add: 📦 Productos → green button "+ Nuevo producto" (top right) → fill "Nombre"*, "Categoría", "Precio"*, optional photo (tap the upload zone) → "Guardar".
- Edit a row: the ✏️ icon. Delete: the 🗑️ icon.
- Mark sold-out/available: click the status badge in the row.
- Stock: set a number, or check "Sin límite" for unlimited. Stock drops automatically when an order is confirmed.
- Import: "📥 Importar productos" → choose Google Sheets, CSV, or Photos (AI reads a price-list/menu photo) → review preview → "Confirmar". There's also "📦 Imágenes ZIP" to bulk-upload photos matched by filename, and "⬇ Exportar CSV".

🍽️ MENÚ (restaurant plan — same tab as Productos, relabeled):
- Add dish: "+ Nuevo ítem" → "Nombre", "Categoría" (the menu section, e.g. Entradas/Platos principales/Postres), "Precio", "Descripción", "Alérgenos". No stock field for dishes.
- Dishes are grouped by category. When a customer asks for the menu/carta, Sara sends it automatically, built live from this catalog — the merchant never sends a photo of the menu.

🛠 SERVICIOS (for appointment businesses): "+ Nuevo servicio" → name, category, price, "Duración" (minutes). Only services with a duration can be booked.

🛒 PEDIDOS: live list of orders. Filter buttons by status; "↻ Actualizar" to refresh; "⬇ Exportar CSV". Status flow: pendiente → confirmado → preparando → entregando → entregado / cancelado. Change status from the order card. Sara can also update status from the merchant's WhatsApp.

👥 CLIENTES: "+ Agregar" to add a customer, "⬇ Exportar CSV". Mass message (broadcast): at the bottom, pick a period, write the message, "📢 Enviar".

📅 TURNOS (appointments calendar): "+ Turno" to add one, "🚫 Agregar bloqueo" to block a slot (holidays/breaks). Set opening hours in the "🕐 Horarios del local" section → set days/times → "Guardar horarios". "Citas en paralelo por horario" = how many appointments fit the same time slot (1 for a single room, e.g. 3 if you have 3 chairs).

📅 RESERVAS (restaurant plan — replaces Turnos): day view of table reservations; pick a date; "+ Nueva reserva".

🍽️ RESTAURANTE (restaurant config, restaurant plan only): toggle to enable; "Duración de mesa (min)"; "Zonas / Salas" → "+ Agregar zona"; "Mesas" → "+ Agregar mesa" (use "Cantidad de mesas" to create many at once by capacity); "Franjas de servicio" → "+ Agregar franja" (e.g. Almuerzo 12:00–15:00, Cena 19:30–23:00) — Sara only accepts reservations inside these windows.

⚙️ AJUSTES: Sara's name & personality; payment instructions ("Información de pago"); business address & Google reviews link; delivery (enable, fee, days without delivery); "🏖️ Cierres y Vacaciones" (closure dates — Sara warns customers and pauses orders/appointments); account (change email / username); change password; delete account.

💳 PLAN: shows the current plan; redeem a promo code; cancel or reactivate the subscription. Billing is via Stripe, automatic monthly, with a 7-day free trial at signup. After canceling, access stays until the end of the paid period.

PASSWORD & ACCOUNT:
- Forgot password: on the login page click "¿Olvidaste tu contraseña?" → enter email → reset link arrives by email (expires in 1 hour).
- Change password: ⚙️ Ajustes → password section.
- Delete account: 💬 Soporte (or ⚙️ Ajustes) → "Eliminar cuenta" → confirm → a link is emailed to the registered address; opening it cancels Stripe and erases all data (link expires in 1h). This email step prevents an employee from deleting the owner's account.

WHATSAPP TROUBLESHOOTING:
- "Credenciales inválidas": wrong Phone Number ID or token — re-check in Meta Business.
- Use a permanent System User token (temporary tokens expire). Required permissions: whatsapp_business_messaging, whatsapp_business_management.
- Sara stopped replying: confirm the WhatsApp number is still active in Meta and the token is valid; if a token error banner shows in the panel, use "Reconectar".

SUPPORT CONTACT: for anything unresolved here, email support@sarabot.pro. This chat is monitored by the Sara Bot team.`;

// ─── POST /admin/support — merchant sends a support message ──────────────────
router.post('/support', requireAuth, async (req, res) => {
  if (!checkSupportRateLimit(req.tenant.tenantId))
    return res.status(429).json({ error: 'Demasiados mensajes. Esperá un momento.' });

  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'Mensaje vacío' });

  const { error } = await supabase.from('support_messages').insert({
    tenant_id: req.tenant.tenantId,
    role: 'merchant',
    content: content.trim(),
  });
  if (error) return res.status(500).json({ error: error.message });

  // Auto-reply via Claude Haiku
  try {
    const { data: recent } = await supabase
      .from('support_messages')
      .select('role, content')
      .eq('tenant_id', req.tenant.tenantId)
      .order('created_at', { ascending: false })
      .limit(20);

    const history = (recent || []).reverse();

    // Anthropic requires strictly alternating user/assistant roles starting with user.
    // merchant -> user; bot (assistant) + superadmin (support) -> assistant.
    const messages = [];
    for (const m of history) {
      const role = m.role === 'merchant' ? 'user' : 'assistant';
      const last = messages[messages.length - 1];
      if (last && last.role === role) last.content += '\n' + m.content;
      else messages.push({ role, content: m.content });
    }
    while (messages.length && messages[0].role === 'assistant') messages.shift();
    if (!messages.length) messages.push({ role: 'user', content: content.trim() });

    const aiRes = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      system: SUPPORT_SYSTEM_PROMPT,
      messages,
    });

    let reply = aiRes.content[0]?.text?.trim();
    const needsEscalation = reply?.startsWith('[ESCALATE]');
    if (needsEscalation) reply = reply.replace(/^\[ESCALATE\]\n?/, '').trim();

    if (reply) {
      await supabase.from('support_messages').insert({
        tenant_id: req.tenant.tenantId,
        role: 'assistant',
        content: reply,
      });
    }

    if (needsEscalation) {
      try {
        const { data: tenant } = await supabase.from('tenants')
          .select('name').eq('id', req.tenant.tenantId).single();
        const { notifySuperadmin } = require('./telegram');
        await notifySuperadmin(tenant?.name || req.tenant.tenantId, req.tenant.tenantId, `⚠️ ESCALATION richiesta\n\n${content.trim()}`);
      } catch (e) {
        console.warn('[support] Telegram escalation notify failed:', e.message);
      }
    }
  } catch (e) {
    console.error('[support] AI reply failed:', e.message);
  }

  res.json({ ok: true });
});

// ─── GET /admin/orders/export — CSV download of all orders ───────────────────
router.get('/orders/export', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('orders')
    .select('*, conversations(customer_name)')
    .eq('tenant_id', req.tenant.tenantId)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  const orders = (data || []).map(o => ({
    ...o,
    customer_name: o.conversations?.customer_name || '',
    conversations: undefined,
  }));

  const headers = ['id','created_at','status','customer_phone','customer_name','items','total_guarani','delivery_fee'];
  const rows = orders.map(o => [
    o.id,
    o.created_at ? new Date(o.created_at).toISOString().slice(0,19).replace('T',' ') : '',
    o.status,
    o.customer_phone,
    o.customer_name,
    Array.isArray(o.items_json)
      ? o.items_json.map(i => `${i.qty||1}x ${i.name}`).join(' | ')
      : '',
    o.total_guarani,
    o.delivery_fee || 0,
  ]);

  const date = new Date().toISOString().slice(0,10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="orders_${date}.csv"`);
  res.send(toCsv(headers, rows));
});

// ─── GET /admin/orders/new — check for orders newer than a timestamp ──────────
router.get('/orders/new', requireAuth, async (req, res) => {
  const since = req.query.since;
  if (!since) return res.json({ orders: [] });
  const { data } = await supabase
    .from('orders')
    .select('id, created_at, total_guarani, items_json, customer_phone, conversations(customer_name)')
    .eq('tenant_id', req.tenant.tenantId)
    .gt('created_at', since)
    .order('created_at', { ascending: false });
  const orders = (data || []).map(o => ({
    ...o,
    customer_name: o.conversations?.customer_name || '',
    conversations: undefined,
  }));
  res.json({ orders });
});

// Builds an Excel-friendly CSV: BOM + a "sep=;" directive (so Excel — incl.
// ES/IT locales whose list separator is ";" — splits into proper columns) and a
// "# sarabot.pro" metadata line. Both leading lines are skipped on re-import.
function toCsv(headers, rows) {
  const escape = v => {
    if (v == null) return '';
    const s = String(v);
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const date = new Date().toISOString().slice(0, 10);
  const meta = `# SaraBot — sarabot.pro — exported ${date}`;
  const body = [headers, ...rows].map(r => r.map(escape).join(';')).join('\r\n');
  return '﻿' + 'sep=;\r\n' + meta + '\r\n' + body;
}

// ─── GET /admin/products/export — CSV export of the catalog/menu ─────────────
// Columns mirror the downloadable template so the file round-trips on re-import.
router.get('/products/export', requireAuth, async (req, res) => {
  const { data: t } = await supabase
    .from('tenants').select('restaurant_enabled').eq('id', req.tenant.tenantId).single();
  const isMenu = !!t?.restaurant_enabled;

  const { data, error } = await supabase
    .from('products')
    .select('name, category, description, allergens, price_guarani, stock_qty, is_available')
    .eq('tenant_id', req.tenant.tenantId)
    .order('category', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });

  const headers = isMenu
    ? ['name','category','description','allergens','price','available']
    : ['name','category','description','price','stock','available'];
  const rows = (data || []).map(p => isMenu
    ? [p.name, p.category, p.description, p.allergens, p.price_guarani, p.is_available ? 'Yes' : 'No']
    : [p.name, p.category, p.description, p.price_guarani, p.stock_qty ?? '', p.is_available ? 'Yes' : 'No']);

  const date = new Date().toISOString().slice(0,10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${isMenu ? 'menu' : 'catalogo'}_${date}.csv"`);
  res.send(toCsv(headers, rows));
});

// ─── GET /admin/services/export — CSV export of all services ─────────────────
router.get('/services/export', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('services')
    .select('name, category, description, price_type, price_guarani, duration_min, is_available')
    .eq('tenant_id', req.tenant.tenantId)
    .order('category', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });

  const headers = ['name','category','description','price_type','price','duration_min','available'];
  const rows = (data || []).map(s => [
    s.name, s.category, s.description, s.price_type, s.price_guarani,
    s.duration_min ?? '', s.is_available ? 'Yes' : 'No',
  ]);

  const date = new Date().toISOString().slice(0,10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="servicios_${date}.csv"`);
  res.send(toCsv(headers, rows));
});

// ─── GET /admin/customers/export — CSV export of all customers ────────────────
router.get('/customers/export', requireAuth, async (req, res) => {
  const [convsRes, ordersRes] = await Promise.all([
    supabase.from('conversations')
      .select('customer_phone, customer_name, customer_email, customer_address, updated_at')
      .eq('tenant_id', req.tenant.tenantId),
    supabase.from('orders')
      .select('customer_phone, total_guarani, status, created_at')
      .eq('tenant_id', req.tenant.tenantId),
  ]);

  const convs  = convsRes.data  || [];
  const orders = ordersRes.data || [];

  const headers = ['telefono','nombre','email','direccion','total_pedidos','pedidos_completados','gasto_total','ultimo_contacto'];
  const rows = convs.map(c => {
    const cOrders = orders.filter(o => o.customer_phone === c.customer_phone);
    const completed = cOrders.filter(o => o.status === 'delivered').length;
    const spent = cOrders
      .filter(o => !['cancelled'].includes(o.status))
      .reduce((s, o) => s + (o.total_guarani || 0), 0);
    return [
      c.customer_phone, c.customer_name || '', c.customer_email || '', c.customer_address || '',
      cOrders.length, completed, spent,
      c.updated_at ? new Date(c.updated_at).toISOString().slice(0,19).replace('T',' ') : '',
    ];
  });

  const date = new Date().toISOString().slice(0,10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="clientes_${date}.csv"`);
  res.send(toCsv(headers, rows));
});

const broadcastRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 1,
  keyGenerator: (req) => req.tenant?.tenantId || req.ip,
  standardHeaders: true, legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ ok: false, errorCode: 'rate_limit' }),
});
const broadcastInProgress = new Set();

// ─── POST /admin/broadcast — send message to all recent customers ─────────────

router.post('/broadcast', requireAuth, broadcastRateLimit, async (req, res) => {
  const tenantId = req.tenant.tenantId;
  if (broadcastInProgress.has(tenantId))
    return res.status(429).json({ ok: false, errorCode: 'rate_limit' });

  const { message, days_active = 30 } = req.body;
  if (!message?.trim()) return res.status(400).json({ ok: false, errorCode: 'missing_message' });
  if (message.trim().length > 1000) return res.status(400).json({ ok: false, errorCode: 'message_too_long' });

  const { data: tenant } = await supabase
    .from('tenants')
    .select('whatsapp_token, phone_number_id')
    .eq('id', req.tenant.tenantId)
    .single();

  const broadcastToken = tenant?.whatsapp_token || process.env.WHATSAPP_TOKEN;
  if (!broadcastToken || !tenant?.phone_number_id)
    return res.status(400).json({ ok: false, errorCode: 'not_connected' });

  const since = new Date(Date.now() - days_active * 24 * 60 * 60 * 1000).toISOString();
  const { data: convs, error } = await supabase
    .from('conversations')
    .select('customer_phone')
    .eq('tenant_id', req.tenant.tenantId)
    .gte('updated_at', since);

  if (error) return res.status(500).json({ ok: false, error: error.message });

  const phones = [...new Set((convs || []).map(c => c.customer_phone))];
  res.json({ ok: true, count: phones.length });

  // Fire-and-forget: send at ~1 msg/s to avoid Meta rate limits
  broadcastInProgress.add(tenantId);
  const { sendMessage } = require('../services/whatsapp');
  const text = message.trim();
  try {
    for (const phone of phones) {
      await sendMessage(phone, text, tenant.phone_number_id, broadcastToken).catch(() => {});
      await new Promise(r => setTimeout(r, 1100));
    }
  } finally {
    broadcastInProgress.delete(tenantId);
  }
});

// ─── GET /admin/analytics — weekly/monthly stats ──────────────────────────────
router.get('/analytics', requireAuth, async (req, res) => {
  const period = req.query.period === 'month' ? 30 : 7;
  const since  = new Date(Date.now() - period * 24 * 60 * 60 * 1000).toISOString();

  const [ordersRes, convsRes] = await Promise.all([
    supabase.from('orders')
      .select('total_guarani, status, created_at, items_json, customer_phone')
      .eq('tenant_id', req.tenant.tenantId)
      .gte('created_at', since),
    supabase.from('conversations')
      .select('customer_phone, updated_at')
      .eq('tenant_id', req.tenant.tenantId)
      .gte('updated_at', since),
  ]);

  const orders = ordersRes.data || [];
  const convs  = convsRes.data  || [];

  // Orders by day
  const byDay = {};
  for (let i = 0; i < period; i++) {
    const d = new Date(Date.now() - (period - 1 - i) * 24 * 60 * 60 * 1000).toISOString().slice(0,10);
    byDay[d] = { date: d, orders: 0, revenue: 0 };
  }
  for (const o of orders) {
    const d = o.created_at.slice(0,10);
    if (byDay[d]) {
      byDay[d].orders++;
      if (o.status !== 'cancelled') byDay[d].revenue += (o.total_guarani || 0);
    }
  }

  // Top products
  const productCount = {};
  for (const o of orders) {
    for (const item of o.items_json || []) {
      productCount[item.name] = (productCount[item.name] || 0) + (item.qty || 1);
    }
  }
  const topProducts = Object.entries(productCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, qty]) => ({ name, qty }));

  const nonCancelled = orders.filter(o => o.status !== 'cancelled');
  const totalRevenue = nonCancelled.reduce((s, o) => s + (o.total_guarani || 0), 0);
  const uniqueCustomers = new Set(orders.map(o => o.customer_phone)).size;
  const activeConvs = new Set(convs.map(c => c.customer_phone)).size;

  res.json({
    period,
    days: Object.values(byDay),
    totalOrders:     orders.length,
    totalRevenue,
    avgOrderValue:   nonCancelled.length ? Math.round(totalRevenue / nonCancelled.length) : 0,
    cancelledOrders: orders.filter(o => o.status === 'cancelled').length,
    uniqueCustomers,
    activeConvs,
    topProducts,
  });
});

// ─── POST /admin/plan/checkout — create MercadoPago preference ───────────────
router.post('/plan/checkout', requireAuth, async (req, res) => {
  const { MercadoPagoConfig, Preference } = require('mercadopago');
  const { plan = 'pro' } = req.body;

  const { data: tenant } = await supabase.from('tenants')
    .select('id, name, plan_currency').eq('id', req.tenant.tenantId).single();

  const currency = tenant?.plan_currency || process.env.MP_CURRENCY || 'USD';
  const prices   = {
    starter: parseInt(process.env.MP_PRICE_STARTER) || 29,
    pro:     parseInt(process.env.MP_PRICE_PRO)     || 59,
  };
  const price = prices[plan] || prices.pro;

  const CURRENCY_TOKEN_MAP = {
    ARS:'MP_ACCESS_TOKEN_AR', BRL:'MP_ACCESS_TOKEN_BR', MXN:'MP_ACCESS_TOKEN_MX',
    CLP:'MP_ACCESS_TOKEN_CL', COP:'MP_ACCESS_TOKEN_CO', UYU:'MP_ACCESS_TOKEN_UY',
    PEN:'MP_ACCESS_TOKEN_PE', PYG:'MP_ACCESS_TOKEN_PY',
  };
  const token = process.env[CURRENCY_TOKEN_MAP[currency]] || process.env.MP_ACCESS_TOKEN;
  if (!token) return res.status(503).json({ error: 'payment_not_configured' });

  try {
    const client = new MercadoPagoConfig({ accessToken: token });
    const pref   = new Preference(client);
    const BASE   = process.env.APP_URL || 'https://sarabot.pro';
    const label  = plan === 'starter' ? 'Sara Bot Starter' : 'Sara Bot Pro';

    const result = await pref.create({ body: {
      items: [{ title: `${label} — 1 mes`, quantity: 1, unit_price: price, currency_id: currency }],
      external_reference: tenant.id,
      back_urls: {
        success: `${BASE}/admin/index.html?paid=ok&plan=${plan}`,
        failure: `${BASE}/admin/index.html?paid=fail`,
        pending: `${BASE}/admin/index.html?paid=pending`,
      },
      auto_return: 'approved',
      notification_url: `${BASE}/payments/mp/webhook`,
    }});
    res.json({ checkout_url: result.init_point });
  } catch(e) {
    console.error('[plan/checkout]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Account deletion is a two-step, email-confirmed flow so that an employee with
// panel access cannot wipe the owner's account: only whoever controls the
// registered email (the owner) can complete it via the link.
async function performAccountDeletion(tenantId) {
  const { data: tenantData } = await supabase
    .from('tenants').select('stripe_subscription_id').eq('id', tenantId).single();
  if (tenantData?.stripe_subscription_id) {
    const Stripe = require('stripe');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    try {
      await stripe.subscriptions.cancel(tenantData.stripe_subscription_id);
    } catch (stripeErr) {
      console.warn('[delete-account] stripe cancel failed:', stripeErr.message);
    }
  }
  // Delete in order to respect FK constraints
  await supabase.from('appointment_blocks').delete().eq('tenant_id', tenantId);
  await supabase.from('appointments').delete().eq('tenant_id', tenantId);
  await supabase.from('orders').delete().eq('tenant_id', tenantId);
  await supabase.from('conversations').delete().eq('tenant_id', tenantId);
  await supabase.from('products').delete().eq('tenant_id', tenantId);
  await supabase.from('services').delete().eq('tenant_id', tenantId);
  await supabase.from('business_hours').delete().eq('tenant_id', tenantId);
  const { error } = await supabase.from('tenants').delete().eq('id', tenantId);
  if (error) throw error;
}

// ─── POST /admin/account/request-deletion — email a confirmation link ─────────
router.post('/account/request-deletion', requireAuth, async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { lang = 'es' } = req.body;
  try {
    const { data: tenant } = await supabase
      .from('tenants').select('name, email, login_slug').eq('id', tenantId).single();

    const token   = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

    const { error: updErr } = await supabase.from('tenants').update({
      account_deletion_token: token,
      account_deletion_expires: expires,
    }).eq('id', tenantId);
    // If the token can't be stored, never send a link that won't work
    if (updErr) return res.status(500).json({ error: updErr.message });

    const confirmUrl = `${process.env.APP_URL}/admin/index.html?delete=${token}`;
    const sendTo = tenant.email || tenant.login_slug;
    await sendAccountDeletion({ email: sendTo, businessName: tenant.name, confirmUrl, lang });

    res.json({ ok: true, email: sendTo });
  } catch (e) {
    console.error('[request-deletion]', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /admin/account/confirm-deletion — token-authenticated final delete ──
router.post('/account/confirm-deletion', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token requerido', errorCode: 'invalid_token' });

  const { data: tenant } = await supabase
    .from('tenants')
    .select('id, account_deletion_token, account_deletion_expires')
    .eq('account_deletion_token', token)
    .maybeSingle();

  if (!tenant) return res.status(400).json({ error: 'Token inválido o expirado', errorCode: 'invalid_token' });
  if (new Date(tenant.account_deletion_expires) < new Date())
    return res.status(400).json({ error: 'Token expirado. Solicitá la eliminación de nuevo.', errorCode: 'token_expired' });

  try {
    await performAccountDeletion(tenant.id);
    res.json({ ok: true });
  } catch (e) {
    console.error('[confirm-deletion]', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /admin/redeem-promo ─────────────────────────────────────────────────

router.post('/redeem-promo', requireAuth, async (req, res) => {
  const { code } = req.body;
  if (!code?.trim()) return res.status(400).json({ error: 'Código vacío', errorCode: 'empty_code' });

  const normalized = code.trim().toUpperCase();

  const { data: promo } = await supabase
    .from('promo_codes')
    .select('*')
    .eq('code', normalized)
    .eq('active', true)
    .single();

  if (!promo) return res.status(404).json({ error: 'Código inválido o inactivo', errorCode: 'invalid_code' });
  if (promo.expires_at && new Date(promo.expires_at) < new Date())
    return res.status(400).json({ error: 'El código ha expirado', errorCode: 'code_expired' });
  if (promo.max_uses !== null && promo.uses_count >= promo.max_uses)
    return res.status(400).json({ error: 'El código ya alcanzó su límite de usos', errorCode: 'code_exhausted' });

  const { data: tenant } = await supabase
    .from('tenants')
    .select('id, plan_price, plan_currency, stripe_subscription_id')
    .eq('id', req.tenant.tenantId)
    .single();

  if (promo.valid_for_currency && promo.valid_for_currency !== tenant.plan_currency)
    return res.status(400).json({ error: `Código válido solo para plan ${promo.valid_for_currency}`, errorCode: 'code_wrong_plan' });

  const { data: existing } = await supabase
    .from('promo_redemptions')
    .select('id')
    .eq('promo_code_id', promo.id)
    .eq('tenant_id', tenant.id)
    .single();
  if (existing) return res.status(400).json({ error: 'Ya usaste este código', errorCode: 'code_already_used' });

  if (!tenant.stripe_subscription_id)
    return res.status(400).json({ error: 'Necesitás una suscripción activa para usar un código.', errorCode: 'no_subscription' });

  // Build the Stripe coupon. Discounts apply once (next invoice); free months
  // are a 100%-off coupon repeating for N months. Stripe billing is the source
  // of truth — we don't mutate plan_price/plan_expires here (the webhook syncs).
  let couponParams = null;
  let discountApplied = 0;
  let monthsAdded = 0;

  if (promo.months_free > 0) {
    couponParams = { percent_off: 100, duration: 'repeating', duration_in_months: promo.months_free, name: `Promo ${promo.code}` };
    monthsAdded = promo.months_free;
  } else if (promo.discount_value > 0) {
    if (promo.discount_type === 'percent') {
      couponParams = { percent_off: Math.min(100, promo.discount_value), duration: 'once', name: `Promo ${promo.code}` };
      discountApplied = parseFloat(((parseFloat(tenant.plan_price) || 0) * promo.discount_value / 100).toFixed(2));
    } else {
      couponParams = { amount_off: Math.round(promo.discount_value * 100), currency: (tenant.plan_currency || 'usd').toLowerCase(), duration: 'once', name: `Promo ${promo.code}` };
      discountApplied = Math.min(parseFloat(tenant.plan_price) || 0, parseFloat(promo.discount_value));
    }
  } else {
    return res.status(400).json({ error: 'El código no aplica ningún beneficio', errorCode: 'code_no_benefit' });
  }

  try {
    const Stripe = require('stripe');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const coupon = await stripe.coupons.create(couponParams);
    await stripe.subscriptions.update(tenant.stripe_subscription_id, { coupon: coupon.id });
  } catch (e) {
    console.error('[redeem-promo] stripe:', e.message);
    return res.status(502).json({ error: 'No se pudo aplicar el descuento en el cobro. Intentá de nuevo.', errorCode: 'stripe_failed' });
  }

  await Promise.all([
    supabase.from('promo_redemptions').insert({
      promo_code_id:    promo.id,
      tenant_id:        tenant.id,
      discount_applied: discountApplied || null,
      months_added:     monthsAdded || null,
    }),
    supabase.from('promo_codes').update({ uses_count: promo.uses_count + 1 }).eq('id', promo.id),
  ]);

  res.json({
    ok: true,
    description: promo.description,
    discountApplied,
    monthsAdded,
  });
});

// ─── Restaurant: zones ────────────────────────────────────────────────────────

router.get('/restaurant/zones', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('restaurant_zones')
    .select('*').eq('tenant_id', req.tenant.tenantId).order('sort_order').order('id');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

router.post('/restaurant/zones', requireAuth, async (req, res) => {
  const { name, notes } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Nombre requerido' });
  const { data, error } = await supabase.from('restaurant_zones')
    .insert({ tenant_id: req.tenant.tenantId, name: name.trim(), notes: notes?.trim() || null })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  invalidateRestaurant(req.tenant.tenantId);
  res.json(data);
});

router.put('/restaurant/zones/:id', requireAuth, async (req, res) => {
  const { name, notes, sort_order } = req.body;
  const updates = {};
  if (name?.trim()) updates.name = name.trim();
  if (notes !== undefined) updates.notes = notes?.trim() || null;
  if (sort_order !== undefined) updates.sort_order = Number(sort_order) || 0;
  const { error } = await supabase.from('restaurant_zones')
    .update(updates).eq('id', req.params.id).eq('tenant_id', req.tenant.tenantId);
  if (error) return res.status(500).json({ error: error.message });
  invalidateRestaurant(req.tenant.tenantId);
  res.json({ ok: true });
});

router.delete('/restaurant/zones/:id', requireAuth, async (req, res) => {
  const { error } = await supabase.from('restaurant_zones')
    .delete().eq('id', req.params.id).eq('tenant_id', req.tenant.tenantId);
  if (error) return res.status(500).json({ error: error.message });
  invalidateRestaurant(req.tenant.tenantId);
  res.json({ ok: true });
});

// ─── Restaurant: tables ───────────────────────────────────────────────────────

router.get('/restaurant/tables', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('restaurant_tables')
    .select('*, restaurant_zones(name)').eq('tenant_id', req.tenant.tenantId)
    .order('zone_id').order('capacity');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

router.post('/restaurant/tables', requireAuth, async (req, res) => {
  const { label, capacity, zone_id, quantity } = req.body;
  if (!capacity) return res.status(400).json({ error: 'Capacidad requerida' });
  const cap = parseInt(capacity);
  const zid = zone_id || null;
  const qty = Math.max(1, Math.min(parseInt(quantity) || 1, 200));

  // Single table with an explicit label → keep label as typed
  if (qty === 1 && label?.trim()) {
    const { data, error } = await supabase.from('restaurant_tables')
      .insert({ tenant_id: req.tenant.tenantId, label: label.trim(), capacity: cap, zone_id: zid })
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    invalidateRestaurant(req.tenant.tenantId);
    return res.json(data);
  }

  // Bulk create (or single without label) → auto-number labels continuing the prefix sequence
  const prefix = label?.trim() || 'Mesa';
  const { data: existing } = await supabase.from('restaurant_tables')
    .select('label').eq('tenant_id', req.tenant.tenantId);
  const re = new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+(\\d+)$');
  let maxN = 0;
  (existing || []).forEach(t => { const m = t.label?.match(re); if (m) maxN = Math.max(maxN, parseInt(m[1])); });
  const rows = Array.from({ length: qty }, (_, i) => ({
    tenant_id: req.tenant.tenantId, label: `${prefix} ${maxN + 1 + i}`, capacity: cap, zone_id: zid
  }));
  const { error } = await supabase.from('restaurant_tables').insert(rows);
  if (error) return res.status(500).json({ error: error.message });
  invalidateRestaurant(req.tenant.tenantId);
  res.json({ ok: true, created: qty });
});

router.put('/restaurant/tables/:id', requireAuth, async (req, res) => {
  const { label, capacity, zone_id, is_active } = req.body;
  const updates = {};
  if (label?.trim()) updates.label = label.trim();
  if (capacity) updates.capacity = parseInt(capacity);
  if (zone_id !== undefined) updates.zone_id = zone_id || null;
  if (is_active !== undefined) updates.is_active = Boolean(is_active);
  const { error } = await supabase.from('restaurant_tables')
    .update(updates).eq('id', req.params.id).eq('tenant_id', req.tenant.tenantId);
  if (error) return res.status(500).json({ error: error.message });
  invalidateRestaurant(req.tenant.tenantId);
  res.json({ ok: true });
});

router.delete('/restaurant/tables/:id', requireAuth, async (req, res) => {
  const { error } = await supabase.from('restaurant_tables')
    .delete().eq('id', req.params.id).eq('tenant_id', req.tenant.tenantId);
  if (error) return res.status(500).json({ error: error.message });
  invalidateRestaurant(req.tenant.tenantId);
  res.json({ ok: true });
});

// ─── Restaurant: reservations ─────────────────────────────────────────────────

router.get('/restaurant/reservations', requireAuth, async (req, res) => {
  const days = parseInt(req.query.days || '7');
  const from = req.query.from || new Date().toISOString().slice(0, 10);
  const to   = new Date(new Date(from).getTime() + days * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const { data, error } = await supabase.from('reservations')
    .select('*, restaurant_zones(name), restaurant_tables(label, capacity)')
    .eq('tenant_id', req.tenant.tenantId)
    .gte('reserved_at', from)
    .lte('reserved_at', to + 'T23:59:59')
    .order('reserved_at');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

router.post('/restaurant/reservations', requireAuth, async (req, res) => {
  const { customer_name, customer_phone, party_size, reserved_at, duration_min, zone_id, table_id, notes } = req.body;
  if (!customer_name?.trim() || !party_size || !reserved_at)
    return res.status(400).json({ error: 'Nombre, personas y fecha requeridos' });
  const { data, error } = await supabase.from('reservations')
    .insert({
      tenant_id: req.tenant.tenantId,
      customer_name: customer_name.trim(),
      customer_phone: customer_phone?.trim() || null,
      party_size: parseInt(party_size),
      reserved_at,
      duration_min: parseInt(duration_min || 90),
      zone_id: zone_id || null,
      table_id: table_id || null,
      notes: notes?.trim() || null,
      status: 'confirmed',
    }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.put('/restaurant/reservations/:id', requireAuth, async (req, res) => {
  const allowed = ['status', 'table_id', 'zone_id', 'notes', 'customer_name', 'customer_phone', 'party_size', 'reserved_at', 'duration_min'];
  const updates = {};
  for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nada para actualizar' });
  const { error } = await supabase.from('reservations')
    .update(updates).eq('id', req.params.id).eq('tenant_id', req.tenant.tenantId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

router.delete('/restaurant/reservations/:id', requireAuth, async (req, res) => {
  const { error } = await supabase.from('reservations')
    .update({ status: 'cancelled' }).eq('id', req.params.id).eq('tenant_id', req.tenant.tenantId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ─── GDPR: erase all personal data for a specific end customer ───────────────
router.delete('/customers/:phone', requireAuth, async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const phone = req.params.phone.replace(/\D/g, '');
  if (!phone) return res.status(400).json({ error: 'invalid phone', errorCode: 'invalid_phone' });

  await Promise.all([
    supabase.from('conversations').delete().eq('tenant_id', tenantId).eq('customer_phone', phone),
    supabase.from('orders').delete().eq('tenant_id', tenantId).eq('customer_phone', phone),
    supabase.from('waitlist').delete().eq('tenant_id', tenantId).eq('customer_phone', phone),
    supabase.from('appointments').delete().eq('tenant_id', tenantId).eq('customer_phone', phone),
    supabase.from('reservations').delete().eq('tenant_id', tenantId).eq('customer_phone', phone),
  ]);

  res.json({ ok: true });
});

// ─── Restaurant: settings (enable/disable + slot duration) ───────────────────

router.put('/restaurant/settings', requireAuth, async (req, res) => {
  const { restaurant_enabled, restaurant_slot_duration, restaurant_meal_bands } = req.body;
  const updates = {};
  if (restaurant_enabled !== undefined) updates.restaurant_enabled = Boolean(restaurant_enabled);
  if (restaurant_slot_duration) updates.restaurant_slot_duration = parseInt(restaurant_slot_duration);
  if (Array.isArray(restaurant_meal_bands)) {
    const bands = restaurant_meal_bands
      .filter(b => b && b.start && b.end)
      .map(b => ({ label: String(b.label || '').slice(0, 40), start: b.start, end: b.end }));

    // Each band must start before it ends and fit inside the opening hours of
    // every open day (so reservations within a band are always within hours).
    for (const b of bands) {
      if (b.start.slice(0,5) >= b.end.slice(0,5))
        return res.status(400).json({ error: `La franja "${b.label || ''}" tiene una hora de inicio posterior a la de fin.`, errorCode: 'band_invalid_range' });
    }
    const { data: bhRows } = await supabase
      .from('business_hours').select('day_of_week, open_time, close_time, is_closed')
      .eq('tenant_id', req.tenant.tenantId);
    const openDays = (bhRows || []).filter(h => !h.is_closed && h.open_time && h.close_time);
    for (const b of bands) {
      for (const d of openDays) {
        if (b.start.slice(0,5) < String(d.open_time).slice(0,5) || b.end.slice(0,5) > String(d.close_time).slice(0,5))
          return res.status(400).json({ error: `La franja "${b.label || ''}" (${b.start}–${b.end}) está fuera del horario de apertura (${String(d.open_time).slice(0,5)}–${String(d.close_time).slice(0,5)}).`, errorCode: 'band_outside_hours' });
      }
    }
    updates.restaurant_meal_bands = bands;
  }
  const { error } = await supabase.from('tenants').update(updates).eq('id', req.tenant.tenantId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

module.exports = router;
