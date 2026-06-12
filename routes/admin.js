const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const { uploadImageBuffer } = require('../services/storage');

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

// ─── POST /admin/login ────────────────────────────────────────────────────────

router.post('/login', async (req, res) => {
  const { phone_number_id, password } = req.body;
  if (!phone_number_id || !password)
    return res.status(400).json({ error: 'Faltan datos' });

  const { data: tenant } = await supabase
    .from('tenants')
    .select('id, name, phone_number_id, admin_password_hash, bot_name')
    .eq('phone_number_id', phone_number_id)
    .maybeSingle();

  if (!tenant) return res.status(404).json({ error: 'Local no encontrado' });

  // First-time setup: if no password set yet, accept "sara1234" and save hash
  if (!tenant.admin_password_hash) {
    if (password !== 'sara1234')
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    const hash = await bcrypt.hash(password, 10);
    await supabase.from('tenants').update({ admin_password_hash: hash }).eq('id', tenant.id);
  } else {
    const ok = await bcrypt.compare(password, tenant.admin_password_hash);
    if (!ok) return res.status(401).json({ error: 'Contraseña incorrecta' });
  }

  const token = jwt.sign(
    { tenantId: tenant.id, tenantName: tenant.name, botName: tenant.bot_name },
    JWT_SECRET,
    { expiresIn: '12h' }
  );

  res.json({ token, tenantName: tenant.name, botName: tenant.bot_name });
});

// ─── GET /admin/settings ─────────────────────────────────────────────────────

router.get('/settings', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('tenants')
    .select('bot_name, bot_personality, merchant_phone, payment_instructions')
    .eq('id', req.tenant.tenantId)
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── PUT /admin/settings ──────────────────────────────────────────────────────

router.put('/settings', requireAuth, async (req, res) => {
  const { bot_name, bot_personality, merchant_phone, payment_instructions } = req.body;
  const updates = {};
  if (bot_name            !== undefined) updates.bot_name            = bot_name;
  if (bot_personality     !== undefined) updates.bot_personality     = bot_personality;
  if (merchant_phone      !== undefined) updates.merchant_phone      = merchant_phone;
  if (payment_instructions !== undefined) updates.payment_instructions = payment_instructions;

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
  const { name, category, price_guarani, stock_qty, description, image_url } = req.body;
  if (!name || !price_guarani)
    return res.status(400).json({ error: 'Nombre y precio son obligatorios' });

  const { data, error } = await supabase
    .from('products')
    .insert({
      tenant_id: req.tenant.tenantId,
      name, category, price_guarani, stock_qty: stock_qty || 0,
      description, image_url,
      is_available: (stock_qty || 0) > 0
    })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// ─── PUT /admin/products/:id ──────────────────────────────────────────────────

router.put('/products/:id', requireAuth, async (req, res) => {
  const { name, category, price_guarani, stock_qty, description, image_url, is_available } = req.body;

  const updates = {};
  if (name          !== undefined) updates.name          = name;
  if (category      !== undefined) updates.category      = category;
  if (price_guarani !== undefined) updates.price_guarani = price_guarani;
  if (description   !== undefined) updates.description   = description;
  if (image_url     !== undefined) updates.image_url     = image_url;
  if (stock_qty     !== undefined) {
    updates.stock_qty    = stock_qty;
    updates.is_available = stock_qty > 0;
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

module.exports = router;
