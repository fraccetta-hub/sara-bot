const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const TTL = 45 * 1000; // 45s
const cache = new Map();

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > TTL) { cache.delete(key); return null; }
  return entry.value;
}

function cacheSet(key, value) {
  cache.set(key, { value, ts: Date.now() });
}

async function getTenantConfig(phoneNumberId) {
  const key = `tenant:${phoneNumberId}`;
  const hit = cacheGet(key);
  if (hit) return hit;

  const { data, error } = await supabase
    .from('tenants')
    .select('*')
    .eq('phone_number_id', phoneNumberId)
    .maybeSingle();

  if (error) { console.error('getTenantConfig error:', error.message); return null; }
  if (data) cacheSet(key, data);
  return data;
}

async function getStock(tenantId) {
  const key = `stock:${tenantId}`;
  const hit = cacheGet(key);
  if (hit) return hit;

  const { data, error } = await supabase
    .from('products')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('is_available', true)
    .order('category');

  if (error) { console.error('getStock error:', error.message); return []; }
  const result = data || [];
  cacheSet(key, result);
  return result;
}

async function decrementStock(tenantId, items) {
  for (const item of items) {
    const { data: product, error } = await supabase
      .from('products')
      .select('id, stock_qty')
      .eq('tenant_id', tenantId)
      .ilike('name', item.name)
      .single();

    if (error || !product) {
      console.error(`Product not found for decrement: ${item.name}`);
      continue;
    }

    const newQty = Math.max(0, product.stock_qty - item.qty);

    await supabase
      .from('products')
      .update({ stock_qty: newQty, is_available: newQty > 0 })
      .eq('id', product.id);
  }
  // Invalidate stock cache so next message sees updated quantities
  cache.delete(`stock:${tenantId}`);
}

async function getServices(tenantId) {
  const key = `services:${tenantId}`;
  const hit = cacheGet(key);
  if (hit) return hit;

  const { data, error } = await supabase
    .from('services')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('is_available', true)
    .order('category');

  if (error) { console.error('getServices error:', error.message); return []; }
  const result = data || [];
  cacheSet(key, result);
  return result;
}

async function getBusinessHours(tenantId) {
  const key = `bh:${tenantId}`;
  const hit = cacheGet(key);
  if (hit) return hit;

  const { data, error } = await supabase
    .from('business_hours').select('*').eq('tenant_id', tenantId);

  if (error) { console.error('getBusinessHours error:', error.message); return []; }
  const result = data || [];
  cacheSet(key, result);
  return result;
}

async function getOffers(tenantId) {
  const key = `offers:${tenantId}`;
  const hit = cacheGet(key);
  if (hit) return hit;

  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('offers')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .or(`valid_to.is.null,valid_to.gte.${today}`)
    .order('created_at');

  if (error) { console.error('getOffers error:', error.message); return []; }
  const result = data || [];
  cacheSet(key, result);
  return result;
}

async function getBusinessClosures(tenantId) {
  const key = `closures:${tenantId}`;
  const hit = cacheGet(key);
  if (hit) return hit;

  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('business_closures')
    .select('*')
    .eq('tenant_id', tenantId)
    .gte('end_date', today)
    .order('start_date');

  if (error) { console.error('getBusinessClosures error:', error.message); return []; }
  const result = data || [];
  cacheSet(key, result);
  return result;
}

async function getRestaurantZones(tenantId) {
  const key = `rzones:${tenantId}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const { data, error } = await supabase
    .from('restaurant_zones').select('*').eq('tenant_id', tenantId).order('sort_order').order('id');
  if (error) { console.error('getRestaurantZones error:', error.message); return []; }
  const result = data || [];
  cacheSet(key, result);
  return result;
}

async function getRestaurantTables(tenantId) {
  const key = `rtables:${tenantId}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const { data, error } = await supabase
    .from('restaurant_tables').select('*, restaurant_zones(name)').eq('tenant_id', tenantId).eq('is_active', true).order('zone_id').order('capacity');
  if (error) { console.error('getRestaurantTables error:', error.message); return []; }
  const result = data || [];
  cacheSet(key, result);
  return result;
}

async function getUpcomingReservations(tenantId, days = 7) {
  const from = new Date().toISOString();
  const to   = new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();
  const { data, error } = await supabase
    .from('reservations')
    .select('id, customer_name, customer_phone, party_size, reserved_at, duration_min, status, notes, zone_id, table_id, restaurant_zones(name), restaurant_tables(label, capacity)')
    .eq('tenant_id', tenantId)
    .not('status', 'in', '("cancelled","done","no_show")')
    .gte('reserved_at', from)
    .lte('reserved_at', to)
    .order('reserved_at');
  if (error) { console.error('getUpcomingReservations error:', error.message); return []; }
  return data || [];
}

function invalidateBusinessHours(tenantId) { cache.delete(`bh:${tenantId}`); }
function invalidateStock(tenantId) { cache.delete(`stock:${tenantId}`); }
function invalidateServices(tenantId) { cache.delete(`services:${tenantId}`); }
function invalidateTenant(phoneNumberId) { cache.delete(`tenant:${phoneNumberId}`); }
function invalidateClosures(tenantId) { cache.delete(`closures:${tenantId}`); }
function invalidateOffers(tenantId) { cache.delete(`offers:${tenantId}`); }
function invalidateRestaurant(tenantId) { cache.delete(`rzones:${tenantId}`); cache.delete(`rtables:${tenantId}`); }

module.exports = { getTenantConfig, getStock, decrementStock, getServices, getOffers, getBusinessClosures, getBusinessHours, getRestaurantZones, getRestaurantTables, getUpcomingReservations, invalidateStock, invalidateServices, invalidateTenant, invalidateClosures, invalidateOffers, invalidateBusinessHours, invalidateRestaurant };
