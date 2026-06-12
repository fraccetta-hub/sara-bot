const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');
const { getTenantStorageUsage } = require('../services/storage');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const JWT_SECRET       = process.env.ADMIN_JWT_SECRET    || 'sara-bot-secret-change-me';
const SUPER_JWT_SECRET = process.env.SUPERADMIN_JWT_SECRET || 'sara-super-secret-change-me';

// ─── Auth middleware ──────────────────────────────────────────────────────────

function requireSuper(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
  try {
    req.admin = jwt.verify(auth.slice(7), SUPER_JWT_SECRET);
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
  res.json({ token });
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
    .select('id, name, active, plan_expires, phone_number_id, bot_name, merchant_phone, created_at')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  // Enrich with order counts
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
    totalOrders:   countMap[t.id]?.total   || 0,
    pendingOrders: countMap[t.id]?.pending || 0,
  }));

  res.json(result);
});

// ─── GET /superadmin/tenants/:id ──────────────────────────────────────────────

router.get('/tenants/:id', requireSuper, async (req, res) => {
  const { data, error } = await supabase
    .from('tenants')
    .select('*')
    .eq('id', req.params.id)
    .single();
  if (error) return res.status(404).json({ error: 'Tenant no encontrado' });
  res.json(data);
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
    'plan_expires','delivery_base_fee','delivery_per_km',
    'location_lat','location_lng'
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
    .from('tenants').select('active').eq('id', req.params.id).single();
  if (!tenant) return res.status(404).json({ error: 'Tenant no encontrado' });

  const { data, error } = await supabase
    .from('tenants').update({ active: !tenant.active })
    .eq('id', req.params.id).select('id, name, active').single();

  if (error) return res.status(500).json({ error: error.message });
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
  res.json({ token, tenantName: tenant.name });
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

module.exports = router;
