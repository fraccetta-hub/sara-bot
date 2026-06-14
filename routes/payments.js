/**
 * Payment routes — MercadoPago integration
 *
 * Env vars required:
 *   MP_ACCESS_TOKEN          — default / fallback account
 *   MP_ACCESS_TOKEN_AR       — Argentina (ARS)
 *   MP_ACCESS_TOKEN_BR       — Brazil (BRL)
 *   MP_ACCESS_TOKEN_MX       — Mexico (MXN)
 *   MP_ACCESS_TOKEN_CL       — Chile (CLP)
 *   MP_ACCESS_TOKEN_CO       — Colombia (COP)
 *   MP_ACCESS_TOKEN_UY       — Uruguay (UYU)
 *   MP_ACCESS_TOKEN_PE       — Peru (PEN)
 *   APP_URL                  — e.g. https://candidatelens.com
 *
 * Optional per-plan pricing (defaults: 29/59 USD):
 *   MP_PRICE_STARTER, MP_PRICE_PRO
 */

const express = require('express');
const router  = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { MercadoPagoConfig, Payment } = require('mercadopago');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Currency → env var name mapping
const CURRENCY_TOKEN_MAP = {
  ARS: 'MP_ACCESS_TOKEN_AR',
  BRL: 'MP_ACCESS_TOKEN_BR',
  MXN: 'MP_ACCESS_TOKEN_MX',
  CLP: 'MP_ACCESS_TOKEN_CL',
  COP: 'MP_ACCESS_TOKEN_CO',
  UYU: 'MP_ACCESS_TOKEN_UY',
  PEN: 'MP_ACCESS_TOKEN_PE',
  PYG: 'MP_ACCESS_TOKEN_PY',
  USD: 'MP_ACCESS_TOKEN',
};

function getTokenForCurrency(currency) {
  const envKey = CURRENCY_TOKEN_MAP[currency] || 'MP_ACCESS_TOKEN';
  return process.env[envKey] || process.env.MP_ACCESS_TOKEN || null;
}

function getAllTokens() {
  return [...new Set(
    ['MP_ACCESS_TOKEN', ...Object.values(CURRENCY_TOKEN_MAP)].map(k => process.env[k]).filter(Boolean)
  )];
}

// POST /payments/mp/webhook — IPN notification from MercadoPago
router.post('/mp/webhook', async (req, res) => {
  res.sendStatus(200); // always ack immediately

  const { type, data } = req.body;
  if (type !== 'payment' || !data?.id) return;

  // Try each configured token until we can fetch the payment
  for (const token of getAllTokens()) {
    try {
      const client  = new MercadoPagoConfig({ accessToken: token });
      const payment = new Payment(client);
      const pmt     = await payment.get({ id: String(data.id) });
      if (!pmt?.id) continue;

      const { status, external_reference: tenantId } = pmt;
      if (status !== 'approved' || !tenantId) return;

      // Extend plan by 30 days from today (or from current expiry if still future)
      const { data: tenant } = await supabase.from('tenants')
        .select('plan_expires').eq('id', tenantId).single();

      const base     = tenant?.plan_expires && new Date(tenant.plan_expires) > new Date()
        ? new Date(tenant.plan_expires)
        : new Date();
      const newExpiry = new Date(base.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

      await supabase.from('tenants')
        .update({ plan_expires: newExpiry, active: true })
        .eq('id', tenantId);

      console.log(`[payments] ✅ Plan extended for ${tenantId} → ${newExpiry.slice(0,10)}`);
      return;
    } catch(e) { /* try next token */ }
  }
});

module.exports = router;
