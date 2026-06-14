const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const { uploadImageBuffer } = require('../services/storage');
const { sendMessage, sendImage } = require('../services/whatsapp');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const uploadCatalog = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 6 } });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 },    // 3 MB max (coerente con Supabase Storage)
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Solo se permiten imágenes'));
  }
});

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'sara-bot-secret-change-me';

// ─── Auth middleware ──────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
  try {
    req.tenant = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

// ─── Smart rate limiting (progressive delays, no hard lockout) ────────────────
// Tracks failed attempts per IP: { ip -> { count, nextAllowedAt } }
const loginAttempts = new Map();

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
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  }

  if (!tenant.active) return res.status(403).json({ error: 'Cuenta suspendida. Contactá a soporte.' });

  // Verify password
  let ok = false;
  if (!tenant.admin_password_hash) {
    ok = (password === 'sara1234');
    if (ok) {
      const hash = await bcrypt.hash(password, 10);
      await supabase.from('tenants').update({ admin_password_hash: hash }).eq('id', tenant.id);
    }
  } else {
    ok = await bcrypt.compare(password, tenant.admin_password_hash);
  }

  if (!ok) {
    attempt.count++;
    attempt.lastAttempt = now;
    attempt.nextAllowedAt = now + getLoginDelay(attempt.count);
    loginAttempts.set(ip, attempt);
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  }

  // Success — clear failed attempts for this IP
  loginAttempts.delete(ip);

  const token = jwt.sign(
    { tenantId: tenant.id, tenantName: tenant.name, botName: tenant.bot_name },
    JWT_SECRET,
    { expiresIn: '12h' }
  );

  const needsSetup = !tenant.phone_number_id;
  res.json({ token, tenantName: tenant.name, botName: tenant.bot_name, needsSetup });
});

// ─── GET /admin/settings ─────────────────────────────────────────────────────

router.get('/settings', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('tenants')
    .select(`bot_name, bot_personality, merchant_phone, payment_instructions, custom_instructions,
             products_enabled, services_enabled, appointments_enabled,
             delivery_enabled, location_address, location_lat, location_lng,
             delivery_type, delivery_base_fee, delivery_zone_km,
             delivery_zone_outer_fee, delivery_per_km,
             delivery_min_order, delivery_disabled_dates`)
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
    'delivery_min_order','delivery_disabled_dates'
  ];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  const { error } = await supabase
    .from('tenants').update(updates).eq('id', req.tenant.tenantId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ─── POST /admin/change-password ─────────────────────────────────────────────

router.post('/change-password', requireAuth, async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6)
    return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
  const hash = await bcrypt.hash(newPassword, 10);
  await supabase.from('tenants').update({ admin_password_hash: hash }).eq('id', req.tenant.tenantId);
  res.json({ ok: true });
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
  const { name, category, price_guarani, stock_qty, description, image_url, sku } = req.body;
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
  const { name, category, price_guarani, stock_qty, description, image_url, is_available, sku } = req.body;

  const updates = {};
  if (name          !== undefined) updates.name          = name;
  if (category      !== undefined) updates.category      = category;
  if (price_guarani !== undefined) updates.price_guarani = price_guarani;
  if (description   !== undefined) updates.description   = description;
  if (image_url     !== undefined) updates.image_url     = image_url;
  if (sku           !== undefined) updates.sku           = sku || null;
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
    .select('customer_phone, customer_name, updated_at')
    .eq('tenant_id', req.tenant.tenantId)
    .order('updated_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
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

    // 5. Save to tenant
    const { error: dbErr } = await supabase.from('tenants')
      .update({ phone_number_id: phoneNumberId, whatsapp_token: accessToken })
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

  const { error } = await supabase.from('tenants')
    .update({ phone_number_id, whatsapp_token: access_token })
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

    // Parse CSV
    const lines = csv.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) return res.status(400).json({ error: 'El Sheet está vacío o tiene solo encabezados' });

    // Normalize header names
    const normalize = s => s.toLowerCase().trim()
      .replace(/[áà]/g,'a').replace(/[éè]/g,'e').replace(/[íì]/g,'i')
      .replace(/[óò]/g,'o').replace(/[úù]/g,'u').replace(/\s+/g,'_');

    const headers = parseCSVLine(lines[0]).map(normalize);

    const COL = {
      name:        headers.findIndex(h => ['nombre','name','producto','servicio'].includes(h)),
      category:    headers.findIndex(h => ['categoria','category'].includes(h)),
      description: headers.findIndex(h => ['descripcion','description','descripción'].includes(h)),
      price:       headers.findIndex(h => ['precio_gs','precio','price','price_gs','precio_guarani','precio_guaraní'].includes(h)),
      price_type:  headers.findIndex(h => ['tipo','type','price_type','tipo_precio'].includes(h)),
      duration:    headers.findIndex(h => ['duracion_min','duration_min','duracion','duracion_minutos'].includes(h)),
      stock:       headers.findIndex(h => ['stock','stock_qty','cantidad'].includes(h)),
      image_url:   headers.findIndex(h => ['imagen_url','image_url','imagen','image','foto','foto_url'].includes(h)),
      available:   headers.findIndex(h => ['disponible','available','activo','active'].includes(h)),
    };

    if (COL.name === -1)  return res.status(400).json({ error: 'No se encontró columna "nombre". Verificá el template.' });
    if (COL.price === -1) return res.status(400).json({ error: 'No se encontró columna "precio_gs". Verificá el template.' });

    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const cells = parseCSVLine(lines[i]);
      const name  = cells[COL.name]?.trim();
      if (!name) continue; // skip empty rows

      const priceRaw = cells[COL.price]?.replace(/[^\d]/g, '') || '0';
      const price    = parseInt(priceRaw) || 0;
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
        stock_qty:   COL.stock    >= 0 ? (parseInt(cells[COL.stock])    || 0)    : 0,
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

// ─── POST /admin/import-confirm — bulk insert products (append + deduplicate) ──
router.post('/import-confirm', requireAuth, async (req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows) || !rows.length)
    return res.status(400).json({ error: 'Sin datos para importar' });

  try {
    // Fetch existing product names to avoid duplicates (exact match)
    const { data: existing } = await supabase
      .from('products').select('name').eq('tenant_id', req.tenant.tenantId);
    const existingNames = new Set((existing || []).map(p => p.name.trim().toLowerCase()));

    const toInsert = rows
      .filter(r => r.name && !existingNames.has(String(r.name).trim().toLowerCase()))
      .map(r => ({
        tenant_id:     req.tenant.tenantId,
        name:          String(r.name).trim(),
        category:      r.category     || null,
        description:   r.description  || null,
        price_guarani: r.price_guarani || 0,
        price_type:    r.price_type    || 'fixed',
        duration_min:  r.duration_min  || null,
        stock_qty:     r.stock_qty     ?? 99,
        image_url:     r.image_url     || null,
        is_available:  r.is_available  ?? true,
      }));

    const skipped = rows.length - toInsert.length;
    if (toInsert.length > 0) {
      const { error } = await supabase.from('products').insert(toInsert);
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

  const content = [{
    type: 'text',
    text: `Analizá estas ${req.files.length} imágenes de un catálogo de negocios (menú, lista de precios, catálogo de WhatsApp Business, etc.).

Extraé TODOS los productos o servicios que puedas ver, con:
- name: nombre del producto/servicio (obligatorio)
- category: categoría (si hay, sino inferí una razonable)
- price_guarani: precio como número entero (si no hay precio pon 0)
- description: descripción breve si hay (sino dejar vacío)

Respondé ÚNICAMENTE con un JSON válido, sin texto adicional, en este formato:
{"products":[{"name":"...","category":"...","price_guarani":0,"description":"..."}]}`
  }];

  for (const file of req.files) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: file.mimetype || 'image/jpeg', data: file.buffer.toString('base64') }
    });
  }

  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
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

// Helper: parse a single CSV line respecting quoted fields
function parseCSVLine(line) {
  const result = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; continue; }
    if (c === ',' && !inQ) { result.push(cur); cur = ''; continue; }
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

  // Orari del locale quel giorno
  const { data: bh } = await supabase.from('business_hours').select('*')
    .eq('tenant_id', req.tenant.tenantId).eq('day_of_week', dayOfWeek).single();

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

  const busy = [...(existing || []), ...(blocks || [])];

  // Filtra slot occupati
  const freeSlots = allSlots.filter(slotStart => {
    const sStart = new Date(slotStart).getTime();
    const sEnd   = sStart + slotDuration * 60000;
    return !busy.some(b => {
      const bStart = new Date(b.start_at).getTime();
      const bEnd   = new Date(b.end_at).getTime();
      return sStart < bEnd && sEnd > bStart;
    });
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

// ─── POST /admin/support — merchant sends a support message ──────────────────
router.post('/support', requireAuth, async (req, res) => {
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'Mensaje vacío' });

  const { error } = await supabase.from('support_messages').insert({
    tenant_id: req.tenant.tenantId,
    role: 'merchant',
    content: content.trim(),
  });
  if (error) return res.status(500).json({ error: error.message });

  // Notify superadmin via Telegram
  try {
    const { data: tenant } = await supabase.from('tenants')
      .select('name').eq('id', req.tenant.tenantId).single();
    const { notifySuperadmin } = require('./telegram');
    await notifySuperadmin(tenant?.name || req.tenant.tenantId, req.tenant.tenantId, content.trim());
  } catch (e) {
    console.warn('[support] Telegram notify failed:', e.message);
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

  // Build CSV
  const escape = v => {
    if (v == null) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"` : s;
  };

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
  ].map(escape).join(','));

  const csv = [headers.join(','), ...rows].join('\r\n');
  const date = new Date().toISOString().slice(0,10);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="orders_${date}.csv"`);
  res.send('﻿' + csv); // BOM for Excel UTF-8 compatibility
});

// ─── DELETE /admin/account — delete all tenant data ───────────────────────────
router.delete('/account', requireAuth, async (req, res) => {
  const tenantId = req.tenant.tenantId;
  try {
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
    res.json({ ok: true });
  } catch (e) {
    console.error('[delete-account]', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
