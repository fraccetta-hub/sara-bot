const express  = require('express');
const router   = express.Router();
const Stripe   = require('stripe');
const jwt      = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const { sendWelcome } = require('../services/mailer');

const stripe   = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const JWT_SECRET = process.env.ADMIN_JWT_SECRET;

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
        metadata: { tenantId, plan, lang: req.body.lang || 'es' },
      },
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.APP_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}&lang=${req.body.lang || 'es'}`,
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

        // Send welcome email only on first activation (trialing)
        if (event.type === 'customer.subscription.created' && obj.status === 'trialing') {
          const lang = obj.metadata?.lang || 'es';
          const { data: tenant } = await supabase
            .from('tenants').select('name, login_slug').eq('id', tenantId).single();
          if (tenant) {
            await sendWelcome({
              email:        tenant.login_slug,
              businessName: tenant.name,
              lang,
            });
          }
        }

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
  const { session_id, lang = 'es' } = req.query;
  if (!session_id) return res.redirect('/register/index.html');

  const T = {
    es: { title:'¡Tu cuenta está lista!', sub:'Guardá estos datos — los necesitarás para entrar al panel.', cred:'Tus credenciales de acceso', user:'Usuario (email)', pass:'Contraseña temporal', warn:'⚠️ Copiá la contraseña ahora — no la volverás a ver en esta página.', copy:'Copiar', copied:'¡Copiado!', trial:'🎁 Período de prueba gratuito activo', trial_text:'Tu tarjeta <strong>no se cobra hasta el {date}</strong>. Si cancelás antes desde el panel → sin cargo. Después se renueva automáticamente cada mes.', s1t:'Entrá al panel con tus credenciales', s1d:'Usá el email y contraseña de arriba para iniciar sesión.', s2t:'Conectá tu WhatsApp Business', s2d:'El asistente de configuración te guía paso a paso.', s3t:'Sara empieza a atender', s3d:'Tus clientes escriben a tu número y Sara responde 24/7.', btn:'Ir al panel de administración →', change:'Podés cambiar tu contraseña desde Configuración → Seguridad.' },
    en: { title:'Your account is ready!', sub:'Save these details — you\'ll need them to access the panel.', cred:'Your access credentials', user:'Username (email)', pass:'Temporary password', warn:'⚠️ Copy your password now — you won\'t see it again on this page.', copy:'Copy', copied:'Copied!', trial:'🎁 Free trial active', trial_text:'Your card <strong>won\'t be charged until {date}</strong>. Cancel before then from the panel → no charge. After that the plan renews automatically each month.', s1t:'Sign in with your credentials', s1d:'Use the email and password above to log in.', s2t:'Connect your WhatsApp Business', s2d:'The setup wizard guides you step by step.', s3t:'Sara starts answering', s3d:'Your customers write to your number and Sara replies 24/7.', btn:'Go to admin panel →', change:'You can change your password from Settings → Security.' },
    it: { title:'Il tuo account è pronto!', sub:'Salva questi dati — ti serviranno per accedere al pannello.', cred:'Le tue credenziali di accesso', user:'Utente (email)', pass:'Password temporanea', warn:'⚠️ Copia la password ora — non la vedrai più su questa pagina.', copy:'Copia', copied:'Copiato!', trial:'🎁 Periodo di prova gratuito attivo', trial_text:'La tua carta <strong>non verrà addebitata fino al {date}</strong>. Se cancelli prima dal pannello → nessun addebito. Dopo il piano si rinnova automaticamente ogni mese.', s1t:'Accedi con le tue credenziali', s1d:'Usa email e password qui sopra per accedere.', s2t:'Collega il tuo WhatsApp Business', s2d:'L\'assistente di configurazione ti guida passo dopo passo.', s3t:'Sara inizia a rispondere', s3d:'I tuoi clienti scrivono al tuo numero e Sara risponde 24/7.', btn:'Vai al pannello di amministrazione →', change:'Puoi cambiare la password da Impostazioni → Sicurezza.' },
    de: { title:'Dein Konto ist bereit!', sub:'Speichere diese Daten — du brauchst sie für den Zugang.', cred:'Deine Zugangsdaten', user:'Benutzername (E-Mail)', pass:'Temporäres Passwort', warn:'⚠️ Kopiere dein Passwort jetzt — du wirst es auf dieser Seite nicht mehr sehen.', copy:'Kopieren', copied:'Kopiert!', trial:'🎁 Kostenlose Testphase aktiv', trial_text:'Deine Karte <strong>wird erst ab {date} belastet</strong>. Vorher kündigen → keine Kosten. Danach verlängert sich der Plan automatisch jeden Monat.', s1t:'Mit deinen Zugangsdaten anmelden', s1d:'Verwende die obige E-Mail und das Passwort zum Anmelden.', s2t:'WhatsApp Business verbinden', s2d:'Der Setup-Assistent führt dich Schritt für Schritt.', s3t:'Sara fängt an zu antworten', s3d:'Deine Kunden schreiben an deine Nummer und Sara antwortet 24/7.', btn:'Zum Admin-Panel →', change:'Du kannst dein Passwort unter Einstellungen → Sicherheit ändern.' },
    fr: { title:'Votre compte est prêt !', sub:'Sauvegardez ces informations — vous en aurez besoin pour accéder au panneau.', cred:'Vos identifiants de connexion', user:'Identifiant (email)', pass:'Mot de passe temporaire', warn:'⚠️ Copiez votre mot de passe maintenant — vous ne le reverrez plus.', copy:'Copier', copied:'Copié !', trial:'🎁 Période d\'essai gratuite active', trial_text:'Votre carte <strong>ne sera pas débitée avant le {date}</strong>. Annulez avant depuis le panneau → aucun frais. Ensuite le plan se renouvelle automatiquement chaque mois.', s1t:'Connectez-vous avec vos identifiants', s1d:'Utilisez l\'email et le mot de passe ci-dessus.', s2t:'Connectez votre WhatsApp Business', s2d:'L\'assistant de configuration vous guide étape par étape.', s3t:'Sara commence à répondre', s3d:'Vos clients écrivent à votre numéro et Sara répond 24h/24.', btn:'Aller au panneau d\'administration →', change:'Vous pouvez changer votre mot de passe dans Paramètres → Sécurité.' },
    pt: { title:'Sua conta está pronta!', sub:'Salve esses dados — você vai precisar deles para acessar o painel.', cred:'Suas credenciais de acesso', user:'Usuário (email)', pass:'Senha temporária', warn:'⚠️ Copie a senha agora — você não a verá novamente nesta página.', copy:'Copiar', copied:'Copiado!', trial:'🎁 Período de teste gratuito ativo', trial_text:'Seu cartão <strong>não será cobrado até {date}</strong>. Cancele antes pelo painel → sem cobrança. Depois o plano renova automaticamente todo mês.', s1t:'Entre com suas credenciais', s1d:'Use o email e a senha acima para fazer login.', s2t:'Conecte seu WhatsApp Business', s2d:'O assistente de configuração te guia passo a passo.', s3t:'Sara começa a atender', s3d:'Seus clientes escrevem para seu número e Sara responde 24/7.', btn:'Ir para o painel de administração →', change:'Você pode alterar sua senha em Configurações → Segurança.' },
  };
  const t = T[lang] || T.es;

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

    const locale = lang === 'pt' ? 'pt-BR' : lang === 'de' ? 'de' : lang === 'fr' ? 'fr' : lang === 'it' ? 'it' : lang === 'en' ? 'en' : 'es';
    const trialEnd = tenant.plan_expires
      ? new Date(tenant.plan_expires).toLocaleDateString(locale, {
          day: 'numeric', month: 'long', year: 'numeric',
        })
      : '7 días';
    const trialText = t.trial_text.replace('{date}', trialEnd);

    // Issue JWT now that payment is confirmed
    const token = jwt.sign(
      { tenantId, name: tenant.name },
      JWT_SECRET,
      { expiresIn: '90d' }
    );
    res.cookie('sara_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 90 * 24 * 60 * 60 * 1000,
    });

    res.send(`<!DOCTYPE html>
<html lang="${h(lang)}">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${h(t.title)} — Sara Bot</title>
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
      <h1 class="text-xl font-bold text-gray-800 mb-2">${h(t.title)}</h1>
      <p class="text-sm text-gray-500">${h(t.sub)}</p>
    </div>
    <!-- Credentials -->
    <div class="bg-green-50 border border-green-200 rounded-xl p-4 mb-4">
      <p class="text-xs font-semibold text-green-800 mb-3 uppercase tracking-wide">${h(t.cred)}</p>
      <div class="flex items-center justify-between">
        <span class="text-xs text-gray-500">${h(t.user)}</span>
        <span class="text-sm font-mono font-bold text-gray-800">${h(tenant.login_slug)}</span>
      </div>
    </div>
    <!-- Trial info -->
    <div class="bg-blue-50 border border-blue-100 rounded-xl p-4 mb-5">
      <p class="text-xs font-semibold text-blue-800 mb-1">${h(t.trial)}</p>
      <p class="text-xs text-blue-700 leading-relaxed">${trialText}</p>
    </div>
    <!-- Steps -->
    <div class="space-y-3 mb-6">
      <div class="flex items-start gap-3">
        <div class="w-6 h-6 rounded-full bg-green-500 text-white text-xs flex items-center justify-center font-bold flex-shrink-0 mt-0.5">1</div>
        <div><p class="text-sm font-medium text-gray-800">${h(t.s1t)}</p><p class="text-xs text-gray-500">${h(t.s1d)}</p></div>
      </div>
      <div class="flex items-start gap-3">
        <div class="w-6 h-6 rounded-full bg-green-500 text-white text-xs flex items-center justify-center font-bold flex-shrink-0 mt-0.5">2</div>
        <div><p class="text-sm font-medium text-gray-800">${h(t.s2t)}</p><p class="text-xs text-gray-500">${h(t.s2d)}</p></div>
      </div>
      <div class="flex items-start gap-3">
        <div class="w-6 h-6 rounded-full bg-green-500 text-white text-xs flex items-center justify-center font-bold flex-shrink-0 mt-0.5">3</div>
        <div><p class="text-sm font-medium text-gray-800">${h(t.s3t)}</p><p class="text-xs text-gray-500">${h(t.s3d)}</p></div>
      </div>
    </div>
    <button onclick="goPanel()" class="block w-full py-3 bg-green-500 hover:bg-green-600 text-white font-semibold rounded-xl text-center transition text-sm cursor-pointer">
      ${h(t.btn)}
    </button>
    <p class="text-xs text-gray-400 text-center mt-3">${h(t.change)}</p>
  </div>
</div>
<script>
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
  const token = req.cookies?.sara_token;
  if (!token) return res.status(401).json({ error: 'No autorizado.' });

  try {
    const decoded  = jwt.verify(token, JWT_SECRET);
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
  const token = req.cookies?.sara_token;
  if (!token) return res.status(401).json({ error: 'No autorizado.' });

  try {
    const decoded  = jwt.verify(token, JWT_SECRET);
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
