const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const GRAPH    = 'https://graph.facebook.com/v19.0';

// No fallback — wrong currency is worse than no sync
const CATALOG_CURRENCY = {
  PY: 'PYG', AR: 'ARS', BR: 'BRL', MX: 'MXN',
  CL: 'CLP', CO: 'COP', UY: 'UYU', PE: 'PEN', BO: 'BOB',
  EC: 'USD', US: 'USD', GT: 'GTQ', CR: 'CRC', DO: 'DOP',
  ES: 'EUR', DE: 'EUR', FR: 'EUR', IT: 'EUR', PT: 'EUR',
  NL: 'EUR', BE: 'EUR', AT: 'EUR', FI: 'EUR', IE: 'EUR',
  GB: 'GBP', CH: 'CHF', SE: 'SEK', NO: 'NOK', DK: 'DKK',
  PL: 'PLN', CZ: 'CZK', HU: 'HUF', RO: 'RON',
};

function currencyForTenant(tenant) {
  return CATALOG_CURRENCY[(tenant.country || '').toUpperCase()] || null;
}

function validateForCatalog(product) {
  const missing = [];
  if (!product.name?.trim())        missing.push('name');
  if (!product.description?.trim()) missing.push('description');
  if (!product.image_url)           missing.push('image_url');
  if (product.price_guarani == null) missing.push('price');
  return missing; // [] = valid
}

async function ensureCatalog(tenant) {
  if (!tenant.waba_id)      throw new Error('waba_id not set for this tenant');
  if (tenant.wa_catalog_id) return tenant.wa_catalog_id;

  const token = tenant.whatsapp_token;

  // 1. Resolve Facebook Business Manager ID from WABA
  const wabaRes  = await fetch(`${GRAPH}/${tenant.waba_id}?fields=business&access_token=${token}`);
  const wabaData = await wabaRes.json();
  if (wabaData.error) throw new Error('WABA lookup: ' + wabaData.error.message);
  const businessId = wabaData.business?.id;
  if (!businessId) throw new Error('Could not resolve business_id from WABA');

  // 2. Create catalog under the Business Manager
  const catRes = await fetch(`${GRAPH}/${businessId}/owned_product_catalogs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: tenant.name }),
  });
  const catData = await catRes.json();
  if (catData.error) throw new Error('Create catalog: ' + catData.error.message);
  const catalogId = catData.id;

  // 3. Enable catalog on WhatsApp phone number (best-effort)
  try {
    await fetch(`${GRAPH}/${tenant.phone_number_id}/whatsapp_commerce_settings`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ is_cart_enabled: true, is_catalog_visible: true, catalog_id: catalogId }),
    });
  } catch (_) {}

  // 4. Persist
  await supabase.from('tenants').update({ wa_catalog_id: catalogId }).eq('id', tenant.id);

  return catalogId;
}

function buildRequest(product, currency) {
  const data = {
    name:         product.name,
    description:  product.description || product.name,
    price:        product.price_guarani,
    currency,
    image_link:   product.image_url,
    availability: product.is_available ? 'in stock' : 'out of stock',
    condition:    'new',
  };
  if (product.additional_images?.length) {
    data.additional_image_link = product.additional_images.slice(0, 9);
  }
  return { method: 'UPDATE', retailer_id: product.id, data };
}

async function pushProduct(tenant, product) {
  if (!tenant.catalog_sync_enabled) return;

  const currency = currencyForTenant(tenant);
  if (!currency) {
    await supabase.from('products')
      .update({ wa_sync_error: 'tenant country/currency not set' }).eq('id', product.id);
    return;
  }

  const missing = validateForCatalog(product);
  if (missing.length) {
    await supabase.from('products')
      .update({ wa_sync_error: `missing: ${missing.join(', ')}` }).eq('id', product.id);
    return;
  }

  try {
    const catalogId = await ensureCatalog(tenant);
    const res  = await fetch(`${GRAPH}/${catalogId}/items_batch`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tenant.whatsapp_token}` },
      body: JSON.stringify({ allow_upsert: true, requests: [buildRequest(product, currency)] }),
    });
    const data = await res.json();
    if (data.error) {
      await supabase.from('products').update({ wa_sync_error: data.error.message }).eq('id', product.id);
    } else {
      await supabase.from('products')
        .update({ wa_retailer_id: product.id, wa_sync_error: null }).eq('id', product.id);
    }
  } catch (e) {
    await supabase.from('products').update({ wa_sync_error: e.message }).eq('id', product.id);
  }
}

async function pushAllProducts(tenant) {
  if (!tenant.catalog_sync_enabled) return { synced: 0, errors: [] };

  const currency = currencyForTenant(tenant);
  if (!currency) {
    return { synced: 0, errors: [{ product: 'all', error: 'tenant country/currency not set' }] };
  }

  const { data: products } = await supabase
    .from('products')
    .select('id, name, description, price_guarani, image_url, additional_images, is_available, sku')
    .eq('tenant_id', tenant.id);

  if (!products?.length) return { synced: 0, errors: [] };

  const valid = [], errors = [];
  for (const p of products) {
    const missing = validateForCatalog(p);
    if (missing.length) {
      errors.push({ product: p.name, error: `missing: ${missing.join(', ')}` });
      await supabase.from('products')
        .update({ wa_sync_error: `missing: ${missing.join(', ')}` }).eq('id', p.id);
    } else {
      valid.push(p);
    }
  }

  if (!valid.length) return { synced: 0, errors };

  let catalogId;
  try {
    catalogId = await ensureCatalog(tenant);
  } catch (e) {
    return { synced: 0, errors: [{ product: 'catalog', error: e.message }] };
  }

  const CHUNK   = 100; // Meta limit per batch request
  let   synced  = 0;

  for (let i = 0; i < valid.length; i += CHUNK) {
    const chunk = valid.slice(i, i + CHUNK);
    try {
      const res  = await fetch(`${GRAPH}/${catalogId}/items_batch`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tenant.whatsapp_token}` },
        body: JSON.stringify({
          allow_upsert: true,
          requests:     chunk.map(p => buildRequest(p, currency)),
        }),
      });
      const data = await res.json();
      if (data.error) {
        errors.push({ product: `batch ${i}–${i + chunk.length - 1}`, error: data.error.message });
      } else {
        for (const p of chunk) {
          await supabase.from('products')
            .update({ wa_retailer_id: p.id, wa_sync_error: null }).eq('id', p.id);
          synced++;
        }
      }
    } catch (e) {
      errors.push({ product: `batch ${i}–${i + chunk.length - 1}`, error: e.message });
    }
  }

  if (synced > 0) {
    await supabase.from('tenants')
      .update({ catalog_synced_at: new Date().toISOString() }).eq('id', tenant.id);
  }

  return { synced, errors };
}

async function removeProduct(tenant, retailerId) {
  if (!tenant.wa_catalog_id || !retailerId) return;
  try {
    await fetch(`${GRAPH}/${tenant.wa_catalog_id}/items_batch`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tenant.whatsapp_token}` },
      body: JSON.stringify({ requests: [{ method: 'DELETE', retailer_id: retailerId }] }),
    });
  } catch (_) {}
}

module.exports = { ensureCatalog, pushProduct, pushAllProducts, removeProduct, validateForCatalog };
