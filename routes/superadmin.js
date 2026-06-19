const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const { getTenantStorageUsage } = require('../services/storage');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 6 } });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const JWT_SECRET       = process.env.ADMIN_JWT_SECRET;
const SUPER_JWT_SECRET = process.env.SUPERADMIN_JWT_SECRET;

// ─── Auth middleware ──────────────────────────────────────────────────────────

function requireSuper(req, res, next) {
  const token = req.cookies?.sara_super_token;
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try {
    req.admin = jwt.verify(token, SUPER_JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

// ─── POST /superadmin/login ───────────────────────────────────────────────────

router.post('/login', async (req, res) => {
  const { password } = req.body;
  const masterHash = process.env.SUPERADMIN_PASSWORD_HASH;

  if (!masterHash) {
    // First run — accept env SUPERADMIN_PASSWORD and save hash hint
    if (password !== process.env.SUPERADMIN_PASSWORD)
      return res.status(401).json({ error: 'Contraseña incorrecta' });
  } else {
    const ok = await bcrypt.compare(password, masterHash);
    if (!ok) return res.status(401).json({ error: 'Contraseña incorrecta' });
  }

  const token = jwt.sign({ role: 'superadmin' }, SUPER_JWT_SECRET, { expiresIn: '8h' });
  res.cookie('sara_super_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 8 * 60 * 60 * 1000,
  });
  res.json({ ok: true });
});

// ─── GET /superadmin/me ───────────────────────────────────────────────────────
router.get('/me', requireSuper, (req, res) => res.json({ ok: true }));

// ─── POST /superadmin/logout ──────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  res.clearCookie('sara_super_token', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict' });
  res.json({ ok: true });
});

// ─── GET /superadmin/stats ────────────────────────────────────────────────────

router.get('/stats', requireSuper, async (req, res) => {
  const [tenantsRes, ordersRes] = await Promise.all([
    supabase.from('tenants').select('id, active'),
    supabase.from('orders').select('id, status, created_at'),
  ]);

  const tenants = tenantsRes.data || [];
  const orders  = ordersRes.data  || [];
  const today   = new Date().toISOString().slice(0, 10);

  res.json({
    totalTenants:  tenants.length,
    activeTenants: tenants.filter(t => t.active).length,
    totalOrders:   orders.length,
    todayOrders:   orders.filter(o => o.created_at?.slice(0, 10) === today).length,
    pendingOrders: orders.filter(o => o.status === 'pending').length,
  });
});

// ─── GET /superadmin/tenants ──────────────────────────────────────────────────

router.get('/tenants', requireSuper, async (req, res) => {
  const { data: tenants, error } = await supabase
    .from('tenants')
    .select('id, name, active, plan_expires, phone_number_id, bot_name, merchant_phone, created_at, whatsapp_token_refresh_error, whatsapp_token, email, country, login_slug')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  const { data: orderCounts } = await supabase
    .from('orders')
    .select('tenant_id, status');

  const countMap = {};
  for (const o of orderCounts || []) {
    if (!countMap[o.tenant_id]) countMap[o.tenant_id] = { total: 0, pending: 0 };
    countMap[o.tenant_id].total++;
    if (o.status === 'pending') countMap[o.tenant_id].pending++;
  }

  const result = tenants.map(t => ({
    ...t,
    whatsapp_token: undefined,
    meta_connected: !!t.whatsapp_token,
    totalOrders:    countMap[t.id]?.total   || 0,
    pendingOrders:  countMap[t.id]?.pending || 0,
  }));

  res.json(result);
});

// ─── GET /superadmin/tenants/:id ──────────────────────────────────────────────

router.get('/tenants/:id', requireSuper, async (req, res) => {
  const { data, error } = await supabase
    .from('tenants')
    .select('id, name, bot_name, login_slug, email, country, merchant_phone, phone_number_id, bot_phone_number, active, plan_expires, plan_currency, plan_price, whatsapp_token, whatsapp_token_refresh_error, products_enabled, services_enabled, appointments_enabled, restaurant_enabled, created_at, deactivated_at')
    .eq('id', req.params.id)
    .single();
  if (error) return res.status(404).json({ error: `Tenant no encontrado: ${error.message}` });
  res.json({ ...data, whatsapp_token: undefined, meta_connected: !!data.whatsapp_token });
});

// ─── POST /superadmin/tenants — create new tenant ─────────────────────────────

router.post('/tenants', requireSuper, async (req, res) => {
  const {
    name, login_slug, phone_number_id, bot_name, bot_personality,
    merchant_phone, payment_instructions,
    location_lat, location_lng,
    delivery_base_fee, delivery_per_km
  } = req.body;

  if (!name || !phone_number_id)
    return res.status(400).json({ error: 'Nombre y phone_number_id son obligatorios' });

  // Default admin password hash for new tenants
  const admin_password_hash = await bcrypt.hash('sara1234', 10);

  const { data, error } = await supabase
    .from('tenants')
    .insert({
      name, phone_number_id,
      login_slug:           login_slug        || null,
      bot_name:             bot_name          || 'Sara',
      bot_personality:      bot_personality   || 'cálida, profesional y entusiasta',
      merchant_phone:       merchant_phone    || null,
      payment_instructions: payment_instructions || null,
      location_lat:         location_lat      || null,
      location_lng:         location_lng      || null,
      delivery_base_fee:    delivery_base_fee || 5000,
      delivery_per_km:      delivery_per_km   || 1000,
      admin_password_hash,
      active: true
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// ─── PUT /superadmin/tenants/:id — update tenant ──────────────────────────────

router.put('/tenants/:id', requireSuper, async (req, res) => {
  const allowed = [
    'name','login_slug','phone_number_id','bot_name','bot_personality',
    'merchant_phone','payment_instructions','active',
    'plan_expires','plan_currency','plan_price',
    'delivery_base_fee','delivery_per_km',
    'location_lat','location_lng',
    'products_enabled','services_enabled','appointments_enabled','restaurant_enabled'
  ];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  const { data, error } = await supabase
    .from('tenants').update(updates)
    .eq('id', req.params.id)
    .select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── PATCH /superadmin/tenants/:id/toggle — attiva/disattiva ─────────────────

router.patch('/tenants/:id/toggle', requireSuper, async (req, res) => {
  const { data: tenant } = await supabase
    .from('tenants').select('active, name, merchant_phone, phone_number_id').eq('id', req.params.id).single();
  if (!tenant) return res.status(404).json({ error: 'Tenant no encontrado' });

  const newActive = !tenant.active;
  const toggleUpdate = { active: newActive };
  if (!newActive) toggleUpdate.deactivated_at = new Date().toISOString();
  else            toggleUpdate.deactivated_at = null;
  const { data, error } = await supabase
    .from('tenants').update(toggleUpdate)
    .eq('id', req.params.id).select('id, name, active').single();

  if (error) return res.status(500).json({ error: error.message });

  // Notify merchant via WhatsApp when deactivated or reactivated
  if (tenant.merchant_phone) {
    const { sendMessage } = require('../services/whatsapp');
    const token = process.env.WHATSAPP_TOKEN;
    const phoneNumberId = tenant.phone_number_id;
    const msg = newActive
      ? `✅ *${tenant.name}* — Tu cuenta ha sido *reactivada*. Ya podés recibir pedidos nuevamente.`
      : `⚠️ *${tenant.name}* — Tu cuenta ha sido *suspendida temporalmente*. Contactá a soporte para más información.`;
    sendMessage(tenant.merchant_phone, msg, phoneNumberId, token).catch(() => {});
  }

  res.json(data);
});

// ─── POST /superadmin/tenants/:id/impersonate ─────────────────────────────────
// Genera un token JWT merchant valido per entrare nel pannello del commerciante

router.post('/tenants/:id/impersonate', requireSuper, async (req, res) => {
  const { data: tenant } = await supabase
    .from('tenants').select('id, name, bot_name').eq('id', req.params.id).single();
  if (!tenant) return res.status(404).json({ error: 'Tenant no encontrado' });

  const token = jwt.sign(
    { tenantId: tenant.id, tenantName: tenant.name, botName: tenant.bot_name, impersonated: true },
    JWT_SECRET,
    { expiresIn: '2h' }
  );
  res.cookie('sara_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 2 * 60 * 60 * 1000,
  });
  res.json({ tenantName: tenant.name });
});

// ─── GET /superadmin/tenants/:id/products ────────────────────────────────────

router.get('/tenants/:id/products', requireSuper, async (req, res) => {
  const { data, error } = await supabase
    .from('products').select('*')
    .eq('tenant_id', req.params.id).order('category');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── GET /superadmin/tenants/:id/storage ────────────────────────────────────

router.get('/tenants/:id/storage', requireSuper, async (req, res) => {
  try {
    const bytes = await getTenantStorageUsage(req.params.id);
    res.json({ bytes, mb: (bytes / 1024 / 1024).toFixed(2) });
  } catch {
    res.json({ bytes: 0, mb: '0.00' });
  }
});

// ─── POST /superadmin/tenants/:id/reset-password ─────────────────────────────

router.post('/tenants/:id/reset-password', requireSuper, async (req, res) => {
  const hash = await bcrypt.hash('sara1234', 10);
  await supabase.from('tenants').update({ admin_password_hash: hash }).eq('id', req.params.id);
  res.json({ ok: true, message: 'Contraseña reseteada a sara1234' });
});

// ─── POST /superadmin/tenants/:id/import-from-images ─────────────────────────
// Accepts up to 6 images, sends them to Claude Vision, returns extracted products

router.post('/tenants/:id/import-from-images', requireSuper, upload.array('images', 6), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No se enviaron imágenes' });
  }

  // Build vision message content
  const content = [];

  content.push({
    type: 'text',
    text: `Analizá estas ${req.files.length} imágenes de un catálogo de negocios (menú, lista de precios, catálogo de WhatsApp Business, etc.).

Extraé TODOS los productos o servicios que puedas ver, con:
- name: nombre del producto/servicio (obligatorio)
- category: categoría (si hay, sino inferí una razonable)
- price_guarani: precio en guaraníes como número entero (si hay moneda diferente, convertí aproximadamente; si no hay precio pon 0)
- description: descripción breve si hay (sino dejar vacío)

Respondé ÚNICAMENTE con un JSON válido, sin texto adicional, en este formato:
{"products":[{"name":"...","category":"...","price_guarani":0,"description":"..."}]}`
  });

  for (const file of req.files) {
    const b64 = file.buffer.toString('base64');
    const mime = file.mimetype || 'image/jpeg';
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: mime, data: b64 }
    });
  }

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      messages: [{ role: 'user', content }]
    });

    const text = response.content[0].text.trim();

    // Extract JSON even if Claude adds extra text
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Respuesta inesperada de la IA');

    const parsed = JSON.parse(jsonMatch[0]);
    res.json({ products: parsed.products || [] });
  } catch (e) {
    console.error('AI import error:', e.message);
    res.status(500).json({ error: 'Error al procesar las imágenes: ' + e.message });
  }
});

// ─── POST /superadmin/tenants/:id/import-confirm ─────────────────────────────
// Saves AI-extracted products to the tenant's catalog

router.post('/tenants/:id/import-confirm', requireSuper, async (req, res) => {
  const { rows, mode } = req.body;
  const tenantId = req.params.id;

  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'No hay filas para importar' });
  }

  // Validate tenant exists
  const { data: tenant } = await supabase.from('tenants').select('id').eq('id', tenantId).single();
  if (!tenant) return res.status(404).json({ error: 'Tenant no encontrado' });

  if (mode === 'replace') {
    await supabase.from('products').delete().eq('tenant_id', tenantId);
  }

  const toInsert = rows
    .filter(r => r.name && String(r.name).trim())
    .map(r => ({
      tenant_id: tenantId,
      name: String(r.name).trim(),
      category: String(r.category || 'General').trim(),
      price_guarani: parseInt(r.price_guarani) || 0,
      description: String(r.description || '').trim() || null,
      stock_qty: 99,
      is_available: true,
    }));

  const { error } = await supabase.from('products').insert(toInsert);
  if (error) return res.status(500).json({ error: error.message });

  res.json({ ok: true, count: toInsert.length });
});

// ─── GET /superadmin/analytics ───────────────────────────────────────────────

router.get('/analytics', requireSuper, async (req, res) => {
  const [tenantsRes, ordersRes] = await Promise.all([
    supabase.from('tenants').select('id, name, active, plan_expires, plan_currency, plan_price, created_at, deactivated_at'),
    supabase.from('orders').select('id, tenant_id, status, created_at'),
  ]);

  const tenants = tenantsRes.data || [];
  const orders  = ordersRes.data  || [];
  const now     = new Date();

  const stats = { total: 0, active: 0, inactive: 0, overdue: 0, metaPending: 0 };
  const overdueList = [];
  const mrrByCurrency = {};

  for (const t of tenants) {
    stats.total++;
    const expired = t.active && t.plan_expires && new Date(t.plan_expires) < now;
    if (!t.active) {
      stats.inactive++;
    } else if (expired) {
      stats.overdue++;
      overdueList.push({ id: t.id, name: t.name, plan_expires: t.plan_expires });
    } else if (!t.whatsapp_token) {
      stats.metaPending++;
    } else {
      stats.active++;
      if (t.plan_price > 0) {
        const cur = t.plan_currency || 'USD';
        mrrByCurrency[cur] = (mrrByCurrency[cur] || 0) + Number(t.plan_price);
      }
    }
  }

  // Build last-6-months keys
  const monthKeys = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthKeys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }

  const regByMonth    = Object.fromEntries(monthKeys.map(k => [k, 0]));
  const ordersByMonth = Object.fromEntries(monthKeys.map(k => [k, 0]));
  const churnByMonth  = Object.fromEntries(monthKeys.map(k => [k, 0]));

  for (const t of tenants) {
    const k = t.created_at?.slice(0, 7);
    if (k && regByMonth[k] !== undefined) regByMonth[k]++;
    if (t.deactivated_at) {
      const ck = t.deactivated_at.slice(0, 7);
      if (churnByMonth[ck] !== undefined) churnByMonth[ck]++;
    }
  }
  for (const o of orders) {
    const k = o.created_at?.slice(0, 7);
    if (k && ordersByMonth[k] !== undefined) ordersByMonth[k]++;
  }

  const orderStats = {
    total:     orders.length,
    today:     orders.filter(o => o.created_at?.slice(0, 10) === now.toISOString().slice(0, 10)).length,
    pending:   orders.filter(o => o.status === 'pending').length,
    delivered: orders.filter(o => o.status === 'delivered').length,
    cancelled: orders.filter(o => o.status === 'cancelled').length,
  };

  res.json({
    stats,
    orderStats,
    overdueList,
    mrrByCurrency,
    regByMonth:    monthKeys.map(k => ({ month: k, count: regByMonth[k] })),
    ordersByMonth: monthKeys.map(k => ({ month: k, count: ordersByMonth[k] })),
    churnByMonth:  monthKeys.map(k => ({ month: k, count: churnByMonth[k] })),
  });
});

// In-memory read timestamps: tenantId -> ISO string (resets on redeploy, acceptable)
const supportReadAt = new Map();

// ─── POST /superadmin/support/:tenantId/read — mark conversation as read ──────
router.post('/support/:tenantId/read', requireSuper, (req, res) => {
  supportReadAt.set(req.params.tenantId, new Date().toISOString());
  res.json({ ok: true });
});

// ─── GET /superadmin/support — list all tenants with support messages ─────────
router.get('/support', requireSuper, async (req, res) => {
  // No PostgREST embed here: it requires a declared FK relationship between
  // support_messages and tenants, which isn't guaranteed in prod. Resolve names
  // with a separate query so the list never 500s on a missing relationship.
  const { data, error } = await supabase
    .from('support_messages')
    .select('id, tenant_id, role, content, created_at')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  // Group by tenant, include last message + unread count (merchant messages not replied to)
  const byTenant = {};
  for (const msg of (data || [])) {
    const tid = msg.tenant_id;
    if (!byTenant[tid]) {
      byTenant[tid] = {
        tenant_id: tid,
        tenant_name: tid,
        messages: [],
        unread: 0,
        last_at: null,
        last_message: null,
      };
    }
    byTenant[tid].messages.push(msg);
    if (!byTenant[tid].last_at) {
      byTenant[tid].last_at = msg.created_at;
      byTenant[tid].last_message = msg.content;
    }
  }

  const ids = Object.keys(byTenant);
  if (ids.length) {
    const { data: tens } = await supabase.from('tenants').select('id, name').in('id', ids);
    for (const tt of (tens || [])) if (byTenant[tt.id]) byTenant[tt.id].tenant_name = tt.name || tt.id;
  }

  // Count unread = merchant messages after the last support reply OR last read timestamp
  for (const t of Object.values(byTenant)) {
    t.messages.reverse(); // now ascending
    let lastSupportIdx = -1;
    t.messages.forEach((m, i) => { if (m.role === 'support') lastSupportIdx = i; });
    const readAt = supportReadAt.get(t.tenant_id);
    const afterSupport = t.messages.slice(lastSupportIdx + 1).filter(m => m.role === 'merchant');
    t.unread = readAt
      ? afterSupport.filter(m => new Date(m.created_at) > new Date(readAt)).length
      : afterSupport.length;
    delete t.messages;
  }

  const list = Object.values(byTenant).sort((a, b) => new Date(b.last_at) - new Date(a.last_at));
  res.json(list);
});

// ─── GET /superadmin/support/:tenantId — full conversation ───────────────────
router.get('/support/:tenantId', requireSuper, async (req, res) => {
  const { data, error } = await supabase
    .from('support_messages')
    .select('id, role, content, created_at')
    .eq('tenant_id', req.params.tenantId)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ─── POST /superadmin/support/:tenantId — superadmin replies ─────────────────
router.post('/support/:tenantId', requireSuper, async (req, res) => {
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'Mensaje vacío' });

  const { error } = await supabase.from('support_messages').insert({
    tenant_id: req.params.tenantId,
    role: 'support',
    content: content.trim(),
  });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ─── GET /superadmin/promo-codes ─────────────────────────────────────────────

router.get('/promo-codes', requireSuper, async (req, res) => {
  // No embed: promo_redemptions(tenant_id) needs a declared FK that may be
  // absent in prod (manual table) → would 500. The UI uses uses_count, not the
  // redemption rows, so the embed is unnecessary.
  const { data, error } = await supabase
    .from('promo_codes')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ─── POST /superadmin/promo-codes ────────────────────────────────────────────

router.post('/promo-codes', requireSuper, async (req, res) => {
  const {
    code, description, discount_type, discount_value,
    months_free, max_uses, valid_for_currency, expires_at
  } = req.body;

  if (!code?.trim()) return res.status(400).json({ error: 'El código es obligatorio' });

  const { data, error } = await supabase
    .from('promo_codes')
    .insert({
      code:                code.trim().toUpperCase(),
      description:         description?.trim() || null,
      discount_type:       discount_type || 'percent',
      discount_value:      parseFloat(discount_value) || 0,
      months_free:         parseInt(months_free) || 0,
      max_uses:            max_uses ? parseInt(max_uses) : null,
      valid_for_currency:  valid_for_currency || null,
      expires_at:          expires_at || null,
    })
    .select()
    .single();

  if (error) return res.status(error.code === '23505' ? 409 : 500).json({ error: error.code === '23505' ? 'Código ya existe' : error.message });
  res.status(201).json(data);
});

// ─── PUT /superadmin/promo-codes/:id — edit ──────────────────────────────────

router.put('/promo-codes/:id', requireSuper, async (req, res) => {
  const {
    description, discount_type, discount_value,
    months_free, max_uses, valid_for_currency, expires_at
  } = req.body;

  const { data, error } = await supabase
    .from('promo_codes')
    .update({
      description:        description?.trim() || null,
      discount_type:      discount_type || 'percent',
      discount_value:     parseFloat(discount_value) || 0,
      months_free:        parseInt(months_free) || 0,
      max_uses:           max_uses ? parseInt(max_uses) : null,
      valid_for_currency: valid_for_currency || null,
      expires_at:         expires_at || null,
    })
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── DELETE /superadmin/promo-codes/:id ──────────────────────────────────────

router.delete('/promo-codes/:id', requireSuper, async (req, res) => {
  const { error } = await supabase
    .from('promo_codes')
    .delete()
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ─── PATCH /superadmin/promo-codes/:id — toggle active ───────────────────────

router.patch('/promo-codes/:id/toggle', requireSuper, async (req, res) => {
  const { data: current } = await supabase.from('promo_codes').select('active').eq('id', req.params.id).single();
  if (!current) return res.status(404).json({ error: 'Código no encontrado' });

  const { data, error } = await supabase
    .from('promo_codes').update({ active: !current.active })
    .eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
