const { createClient } = require('@supabase/supabase-js');
const { sendMessage } = require('./whatsapp');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const APPT_REMINDER = {
  es: (name, time) => `📅 ¡Hola ${name}! Te recordamos tu cita mañana a las *${time}*. ¡Te esperamos!`,
  it: (name, time) => `📅 Ciao ${name}! Ti ricordiamo il tuo appuntamento domani alle *${time}*. Ti aspettiamo!`,
  en: (name, time) => `📅 Hi ${name}! Reminder: your appointment is tomorrow at *${time}*. See you then!`,
  fr: (name, time) => `📅 Bonjour ${name}! Rappel : votre rendez-vous est demain à *${time}*. À bientôt !`,
  de: (name, time) => `📅 Hallo ${name}! Erinnerung: Ihr Termin ist morgen um *${time}* Uhr. Wir freuen uns auf Sie!`,
  pt: (name, time) => `📅 Olá ${name}! Lembrete: sua consulta é amanhã às *${time}*. Até breve!`,
};

const CART_NUDGE = {
  es: () => `👋 ¡Hola! ¿Pudimos ayudarte con lo que buscabas? Seguimos por aquí si necesitás algo 😊`,
  it: () => `👋 Ciao! Siamo riusciti ad aiutarti con quello che cercavi? Siamo qui se hai bisogno 😊`,
  en: () => `👋 Hi there! Were we able to help you find what you were looking for? We're here if you need anything 😊`,
  fr: () => `👋 Bonjour ! Avons-nous pu vous aider ? Nous sommes disponibles si vous avez besoin de quelque chose 😊`,
  de: () => `👋 Hallo! Konnten wir Ihnen helfen? Wir sind für Sie da, wenn Sie etwas brauchen 😊`,
  pt: () => `👋 Olá! Conseguimos te ajudar com o que procurava? Estamos aqui se precisar de algo 😊`,
};

async function runAppointmentReminders() {
  const now  = Date.now();
  const from = new Date(now + 23 * 3600 * 1000).toISOString();
  const to   = new Date(now + 25 * 3600 * 1000).toISOString();

  const { data: appts, error } = await supabase
    .from('appointments')
    .select('id, tenant_id, customer_name, customer_phone, start_at')
    .gte('start_at', from)
    .lte('start_at', to)
    .neq('status', 'cancelled')
    .is('reminder_sent_at', null)
    .not('customer_phone', 'is', null);

  if (error) { console.error('[cron:reminder] query error:', error.message); return; }
  if (!appts?.length) return;

  const byTenant = {};
  for (const a of appts) (byTenant[a.tenant_id] = byTenant[a.tenant_id] || []).push(a);

  for (const [tenantId, tenantAppts] of Object.entries(byTenant)) {
    const { data: tenant } = await supabase
      .from('tenants')
      .select('phone_number_id, whatsapp_token, timezone')
      .eq('id', tenantId)
      .eq('is_active', true)
      .maybeSingle();

    if (!tenant?.whatsapp_token || !tenant?.phone_number_id) continue;

    const tz = tenant.timezone || 'America/Asuncion';

    for (const appt of tenantAppts) {
      try {
        const time = new Date(appt.start_at).toLocaleTimeString('es', {
          hour: '2-digit', minute: '2-digit', timeZone: tz,
        });
        const name = appt.customer_name || appt.customer_phone;
        // Default to 'es' — customer language not stored
        await sendMessage(appt.customer_phone, APPT_REMINDER.es(name, time), tenant.phone_number_id, tenant.whatsapp_token);
        await supabase.from('appointments').update({ reminder_sent_at: new Date().toISOString() }).eq('id', appt.id);
        console.log(`[cron:reminder] sent to ${appt.customer_phone} appt=${appt.id}`);
      } catch (e) {
        console.error(`[cron:reminder] failed appt=${appt.id}:`, e.message);
      }
    }
  }
}

async function runAbandonedCartNudge() {
  const now          = Date.now();
  const from         = new Date(now - 24 * 3600 * 1000).toISOString();
  const to           = new Date(now -  2 * 3600 * 1000).toISOString();
  const nudgeCooldown = new Date(now - 7 * 24 * 3600 * 1000).toISOString();

  const { data: convs, error } = await supabase
    .from('conversations')
    .select('id, tenant_id, customer_phone')
    .gte('updated_at', from)
    .lte('updated_at', to)
    .or(`last_nudge_at.is.null,last_nudge_at.lt.${nudgeCooldown}`);

  if (error) { console.error('[cron:nudge] query error:', error.message); return; }
  if (!convs?.length) return;

  const byTenant = {};
  for (const c of convs) (byTenant[c.tenant_id] = byTenant[c.tenant_id] || []).push(c);

  for (const [tenantId, tenantConvs] of Object.entries(byTenant)) {
    const { data: tenant } = await supabase
      .from('tenants')
      .select('phone_number_id, whatsapp_token, products_enabled')
      .eq('id', tenantId)
      .eq('is_active', true)
      .maybeSingle();

    if (!tenant?.whatsapp_token || !tenant?.phone_number_id) continue;
    if (!tenant.products_enabled) continue;

    const { data: recentOrders } = await supabase
      .from('orders')
      .select('customer_phone')
      .eq('tenant_id', tenantId)
      .gte('created_at', from)
      .neq('status', 'cancelled');

    const orderedPhones = new Set((recentOrders || []).map(o => o.customer_phone));

    for (const conv of tenantConvs) {
      if (orderedPhones.has(conv.customer_phone)) continue;
      try {
        await sendMessage(conv.customer_phone, CART_NUDGE.es(), tenant.phone_number_id, tenant.whatsapp_token);
        await supabase.from('conversations').update({ last_nudge_at: new Date().toISOString() }).eq('id', conv.id);
        console.log(`[cron:nudge] sent to ${conv.customer_phone} tenant=${tenantId}`);
        await new Promise(r => setTimeout(r, 500)); // avoid Meta rate limit
      } catch (e) {
        console.error(`[cron:nudge] failed conv=${conv.id}:`, e.message);
      }
    }
  }
}

function setupCronJobs() {
  const HOUR = 60 * 60 * 1000;
  // 30s delay so DB connection settles before first run
  setTimeout(() => {
    runAppointmentReminders();
    runAbandonedCartNudge();
  }, 30000);
  setInterval(runAppointmentReminders, HOUR);
  setInterval(runAbandonedCartNudge, HOUR);
}

module.exports = { setupCronJobs };
