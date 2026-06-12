const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function getTenantConfig(phoneNumberId) {
  const { data, error } = await supabase
    .from('tenants')
    .select('*')
    .eq('phone_number_id', phoneNumberId)
    .single();

  if (error) {
    console.error('getTenantConfig error:', error.message);
    return null;
  }
  return data;
}

async function getStock(tenantId) {
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('is_available', true)
    .order('category');

  if (error) {
    console.error('getStock error:', error.message);
    return [];
  }
  return data || [];
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
      .update({
        stock_qty: newQty,
        is_available: newQty > 0
      })
      .eq('id', product.id);
  }
}

module.exports = { getTenantConfig, getStock, decrementStock };
