const express  = require('express');
const router   = express.Router();
const Stripe   = require('stripe');
const jwt      = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const stripe   = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'sara-bot-secret-change-me';

const PRICE_IDS = {
  starter: process.env.STRIPE_PRICE_STARTER,
  pro:     process.env.STRIPE_PRICE_PRO,
};

// ── POST /billing/create-checkout ─────────────────────────────────────────────
// Body: { tenantId, plan, email }
// Returns: { url } — Stripe Checkout URL to redirect the user to
router.post('/create-checkout', async (req, res) => {
  try {
    const { tenantId, plan, email } = req.body;
    if (!tenantId || !plan || !email) {
      return res.status(400).json({ error: 'tenantId, plan y email son obligatorios.' });
    }

    const priceId = PRICE_IDS[plan];
    if (!priceId) {
      return res.status(400).json({ error: `Plan inválido: ${plan}` });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: email,
      subscription_data: {
        trial_period_days: 7,
        metadata: { tenantId, plan },
      },
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.APP_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.APP_URL}/register/index.html?cancelled=1`,
      metadata: { tenantId, plan },
      // Allow card saving for future charges
      payment_method_collection: 'always',
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('[billing] create-checkout:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /billing/webhook ─────────────────────────────────────────────────────
// Stripe sends signed events here. Must use raw body (no JSON parsing).
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body, sig, process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('[billing] webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const obj = event.data.object;

  try {
    switch (event.type) {
      // Subscription created (trialing) or updated (active after trial, or payment issues)
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const tenantId = obj.metadata?.tenantId;
        if (!tenantId) break;

        const isLive = ['active', 'trialing'].includes(obj.status);
        await supabase.from('tenants').update({
          stripe_customer_id:         obj.customer,
          stripe_subscription_id:     obj.id,
          stripe_subscription_status: obj.status,
          plan_status:                isLive ? 'active' : 'suspended',
          plan_expires: obj.current_period_end
            ? new Date(obj.current_period_end * 1000).toISOString()
            : null,
        }).eq('id', tenantId);

        console.log(`[billing] subscription ${obj.status} → tenant ${tenantId}`);
        break;
      }

      // Subscription cancelled (either by user or after failed payment retries)
      case 'customer.subscription.deleted': {
        const tenantId = obj.metadata?.tenantId;
        if (!tenantId) break;
        await supabase.from('tenants').update({
          stripe_subscription_status: 'cancelled',
          plan_status: 'suspended',
          active: false,
        }).eq('id', tenantId);
        console.log(`[billing] subscription cancelled → tenant ${tenantId}`);
        break;
      }

      // Payment failed (e.g. card declined after trial)
      case 'invoice.payment_failed': {
        const customerId = obj.customer;
        const { data: tenant } = await supabase
          .from('tenants').select('id, name, merchant_phone')
          .eq('stripe_customer_id', customerId).maybeSingle();
        if (tenant) {
          console.warn(`[billing] payment failed → tenant ${tenant.id} (${tenant.name})`);
          // Could send WhatsApp notification here in the future
        }
        break;
      }
    }
  } catch (err) {
    console.error('[billing] webhook handler error:', err.message);
    // Still return 200 so Stripe doesn't retry
  }

  res.json({ received: true });
});

// ── GET /billing/success ──────────────────────────────────────────────────────
// Stripe redirects here after successful checkout. Activates tenant + shows credentials.
router.get('/success', async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.redirect('/register/index.html');

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ['subscription'],
    });

    const tenantId = session.metadata?.tenantId;
    if (!tenantId) return res.redirect('/register/index.html?error=1');

    // Activate the tenant
    await supabase.from('tenants').update({
      stripe_customer_id:         session.customer,
      stripe_subscription_id:     session.subscription?.id,
      stripe_subscription_status: session.subscription?.status || 'trialing',
      plan_status: 'active',
      active: true,
    }).eq('id', tenantId);

    // Fetch credentials
    const { data: tenant } = await supabase
      .from('tenants')
      .select('name, login_slug, temp_password, plan_expires, plan')
      .eq('id', tenantId).single();

    if (!tenant) return res.redirect('/register/index.html?error=1');

    const trialEnd = tenant.plan_expires
      ? new Date(tenant.plan_expires).toLocaleDateString('es', {
          day: 'numeric', month: 'long', year: 'numeric',
        })
      : '7 días';

    // Issue JWT now that payment is confirmed
    const token = jwt.sign(
      { tenantId, name: tenant.name },
      JWT_SECRET,
      { expiresIn: '90d' }
    );

    res.send(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>¡Cuenta activada! — Sara Bot</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>
  body { background: linear-gradient(135deg,#f0fdf4 0%,#ecfdf5 50%,#f0f9ff 100%); }
  @keyframes fadeIn { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:none} }
  .fade-in { animation: fadeIn .4s ease; }
</style>
</head>
<body class="min-h-screen flex items-center justify-center p-4">
<div class="max-w-md w-full fade-in">
  <div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-8">

    <div class="text-center mb-6">
      <div class="text-5xl mb-4">🎉</div>
      <h1 class="text-xl font-bold text-gray-800 mb-2">¡Tu cuenta está lista!</h1>
      <p class="text-sm text-gray-500">Guardá estos datos — los necesitarás para entrar al panel.</p>
    </div>

    <!-- Credentials -->
    <div class="bg-green-50 border border-green-200 rounded-xl p-4 mb-4">
      <p class="text-xs font-semibold text-green-800 mb-3 uppercase tracking-wide">Tus credenciales de acceso</p>
      <div class="space-y-2">
        <div class="flex items-center justify-between">
          <span class="text-xs text-gray-500">Usuario (email)</span>
          <span class="text-sm font-mono font-bold text-gray-800">${h(tenant.login_slug)}</span>
        </div>
        <div class="flex items-center justify-between">
          <span class="text-xs text-gray-500">Contraseña temporal</span>
          <span class="text-sm font-mono font-bold text-gray-800 select-all">${h(tenant.temp_password || '(ver email)')}</span>
        </div>
      </div>
    </div>

    <!-- Trial info -->
    <div class="bg-blue-50 border border-blue-100 rounded-xl p-4 mb-5">
      <p class="text-xs font-semibold text-blue-800 mb-1">🎁 Período de prueba gratuito activo</p>
      <p class="text-xs text-blue-700 leading-relaxed">
        Tu tarjeta <strong>no se cobra hasta el ${h(trialEnd)}</strong>.
        Si cancelás antes de esa fecha desde el panel → sin cargo. Después, el plan se renueva automáticamente cada mes.
      </p>
    </div>

    <!-- Steps -->
    <div class="space-y-3 mb-6">
      <div class="flex items-start gap-3">
        <div class="w-6 h-6 rounded-full bg-green-500 text-white text-xs flex items-center justify-center font-bold flex-shrink-0 mt-0.5">1</div>
        <div>
          <p class="text-sm font-medium text-gray-800">Entrá al panel con tus credenciales</p>
          <p class="text-xs text-gray-500">Usá el email y contraseña de arriba para iniciar sesión.</p>
        </div>
      </div>
      <div class="flex items-start gap-3">
        <div class="w-6 h-6 rounded-full bg-green-500 text-white text-xs flex items-center justify-center font-bold flex-shrink-0 mt-0.5">2</div>
        <div>
          <p class="text-sm font-medium text-gray-800">Conectá tu WhatsApp Business</p>
          <p class="text-xs text-gray-500">El asistente de configuración te guía paso a paso.</p>
        </div>
      </div>
      <div class="flex items-start gap-3">
        <div class="w-6 h-6 rounded-full bg-green-500 text-white text-xs flex items-center justify-center font-bold flex-shrink-0 mt-0.5">3</div>
        <div>
          <p class="text-sm font-medium text-gray-800">Sara empieza a atender</p>
          <p class="text-xs text-gray-500">Tus clientes escriben a tu número y Sara responde 24/7.</p>
        </div>
      </div>
    </div>

    <button onclick="goPanel()" class="block w-full py-3 bg-green-500 hover:bg-green-600 text-white font-semibold rounded-xl text-center transition text-sm cursor-pointer">
      Ir al panel de administración →
    </button>
    <p class="text-xs text-gray-400 text-center mt-3">Podés cambiar tu contraseña desde Configuración → Seguridad.</p>
  </div>
</div>
<script>
  // Save token to localStorage so admin panel auto-logs in
  localStorage.setItem('sara_token', ${JSON.stringify(token)});
  function goPanel() { window.location.href = '/admin/index.html'; }
</script>
</body>
</html>`);
  } catch (err) {
    console.error('[billing] success error:', err.message);
    res.redirect('/register/index.html?error=1');
  }
});

// ── POST /billing/cancel ──────────────────────────────────────────────────────
// Called from admin panel to cancel subscription at period end (not immediately)
router.post('/cancel', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No autorizado.' });

  try {
    const decoded  = jwt.verify(authHeader.replace('Bearer ', ''), JWT_SECRET);
    const tenantId = decoded.tenantId;

    const { data: tenant } = await supabase
      .from('tenants').select('stripe_subscription_id').eq('id', tenantId).single();

    if (!tenant?.stripe_subscription_id) {
      return res.status(400).json({ error: 'No se encontró suscripción activa.' });
    }

    // cancel_at_period_end: user keeps access until end of current period
    await stripe.subscriptions.update(tenant.stripe_subscription_id, {
      cancel_at_period_end: true,
    });

    res.json({ ok: true, message: 'Suscripción cancelada. Mantenés acceso hasta el fin del período actual.' });
  } catch (err) {
    console.error('[billing] cancel:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /billing/reactivate ──────────────────────────────────────────────────
// Re-enable subscription if it was set to cancel_at_period_end but user changed mind
router.post('/reactivate', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No autorizado.' });

  try {
    const decoded  = jwt.verify(authHeader.replace('Bearer ', ''), JWT_SECRET);
    const tenantId = decoded.tenantId;

    const { data: tenant } = await supabase
      .from('tenants').select('stripe_subscription_id').eq('id', tenantId).single();

    if (!tenant?.stripe_subscription_id) {
      return res.status(400).json({ error: 'No se encontró suscripción.' });
    }

    await stripe.subscriptions.update(tenant.stripe_subscription_id, {
      cancel_at_period_end: false,
    });

    res.json({ ok: true, message: 'Suscripción reactivada.' });
  } catch (err) {
    console.error('[billing] reactivate:', err.message);
    res.status(500).json({ error: err.message });
  }
});

function h(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

module.exports = router;
