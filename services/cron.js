const { createClient } = require('@supabase/supabase-js');
const { sendMessage, sendImage } = require('./whatsapp');

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

async function sendOneBroadcast(phone, message, imageUrl, phoneNumberId, token) {
  if (imageUrl) {
    try {
      await sendImage(phone, imageUrl, message, phoneNumberId, token);
      return 'photo';
    } catch (err) {
      const code = err.response?.data?.error?.code;
      if (code === 131047) {
        await sendMessage(phone, message + '\n📸 ' + imageUrl, phoneNumberId, token);
        return 'text';
      }
      throw err;
    }
  }
  await sendMessage(phone, message, phoneNumberId, token);
  return 'text';
}

async function runScheduledBroadcasts() {
  const now = new Date().toISOString();
  const { data: due } = await supabase
    .from('scheduled_broadcasts')
    .select('*')
    .eq('status', 'pending')
    .lte('scheduled_at', now)
    .limit(10);

  for (const bc of due || []) {
    // Optimistic lock: only one worker picks this up
    const { data: locked } = await supabase
      .from('scheduled_broadcasts')
      .update({ status: 'running' })
      .eq('id', bc.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle();
    if (!locked) continue;

    try {
      const { data: tenant } = await supabase
        .from('tenants')
        .select('phone_number_id, whatsapp_token, merchant_phone, lang')
        .eq('id', bc.tenant_id)
        .eq('is_active', true)
        .maybeSingle();
      if (!tenant?.phone_number_id) throw new Error('tenant not found or inactive');

      const broadcastToken = tenant.whatsapp_token || process.env.WHATSAPP_TOKEN;
      const { phone_number_id: phoneNumberId } = tenant;

      const since = new Date(Date.now() - bc.days_active * 86400000).toISOString();
      const { data: convs } = await supabase
        .from('conversations')
        .select('customer_phone')
        .eq('tenant_id', bc.tenant_id)
        .gte('updated_at', since);
      const phones = [...new Set((convs || []).map(c => c.customer_phone))];

      let photoSent = 0, textSent = 0, failed = 0;
      for (const phone of phones) {
        try {
          const result = await sendOneBroadcast(phone, bc.message, bc.image_url, phoneNumberId, broadcastToken);
          if (result === 'photo') photoSent++; else textSent++;
        } catch { failed++; }
        await new Promise(r => setTimeout(r, 200));
      }

      const report = { total: phones.length, photo_sent: photoSent, text_sent: textSent, failed };
      await supabase.from('scheduled_broadcasts').update({
        status: 'done', sent_at: new Date().toISOString(), report,
      }).eq('id', bc.id);

      if (tenant.merchant_phone) {
        const lang = tenant.lang || 'es';
        const DONE = {
          es: `✅ Broadcast enviado: ${photoSent} foto + ${textSent} solo texto${failed ? ` + ${failed} fallidos` : ''} (total ${phones.length}).`,
          it: `✅ Broadcast inviato: ${photoSent} foto + ${textSent} solo testo${failed ? ` + ${failed} falliti` : ''} (totale ${phones.length}).`,
          en: `✅ Broadcast sent: ${photoSent} photo + ${textSent} text-only${failed ? ` + ${failed} failed` : ''} (total ${phones.length}).`,
          fr: `✅ Broadcast envoyé : ${photoSent} photo + ${textSent} texte seul${failed ? ` + ${failed} échoués` : ''} (total ${phones.length}).`,
          de: `✅ Broadcast gesendet: ${photoSent} Foto + ${textSent} nur Text${failed ? ` + ${failed} fehlgeschlagen` : ''} (gesamt ${phones.length}).`,
          pt: `✅ Broadcast enviado: ${photoSent} foto + ${textSent} só texto${failed ? ` + ${failed} falhas` : ''} (total ${phones.length}).`,
        };
        sendMessage(tenant.merchant_phone, DONE[lang] || DONE.es, phoneNumberId, broadcastToken).catch(() => {});
      }
      console.log(`[broadcast] done ${bc.id}: photo=${photoSent} text=${textSent} failed=${failed}`);
    } catch (err) {
      await supabase.from('scheduled_broadcasts').update({
        status: 'failed', error: err.message, sent_at: new Date().toISOString(),
      }).eq('id', bc.id);
      console.error(`[broadcast] failed ${bc.id}:`, err.message);
    }
  }
}

function setupCronJobs() {
  const HOUR = 60 * 60 * 1000;
  const MIN  = 60 * 1000;
  // 30s delay so DB connection settles before first run
  setTimeout(() => {
    runAppointmentReminders();
    runAbandonedCartNudge();
    runScheduledBroadcasts().catch(() => {});
  }, 30000);
  setInterval(runAppointmentReminders, HOUR);
  setInterval(runAbandonedCartNudge, HOUR);
  setInterval(() => runScheduledBroadcasts().catch(() => {}), MIN);
}

module.exports = { setupCronJobs };
