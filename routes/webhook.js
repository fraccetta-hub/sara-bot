const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { getTenantConfig, getStock, decrementStock, getServices, getOffers, getBusinessClosures, getBusinessHours, getRestaurantZones, getRestaurantTables, getUpcomingReservations, invalidateStock, invalidateServices, invalidateClosures, invalidateOffers, invalidateBusinessHours } = require('../services/stock');
const { sendMessage, sendImage, notifyMerchant } = require('../services/whatsapp');
const { chat, formatPrice } = require('../services/claude');
const { downloadAndStore, uploadImageBuffer } = require('../services/storage');
const { haversineKm, geocode, calcDeliveryFee } = require('../services/geo');
const { check: rateCheck, blockMessage } = require('../services/ratelimit');
const { fetchMedia } = require('../services/media');
const { transcribeAudio } = require('../services/transcribe');
const catalog = require('../services/catalog');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// GET /webhook — Meta token verification
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log('[webhook] Verification successful');
    return res.status(200).send(challenge);
  }
  res.status(403).send('Forbidden');
});

// POST /webhook — incoming WhatsApp messages
const META_APP_SECRET = process.env.META_APP_SECRET;

// Verify the payload really comes from Meta (HMAC-SHA256 over the raw body).
// Skips only if no app secret is configured (keeps local/dev working).
function validMetaSignature(req) {
  if (!META_APP_SECRET) return true;
  const sig = req.get('x-hub-signature-256') || '';
  const expected = 'sha256=' + crypto.createHmac('sha256', META_APP_SECRET).update(req.rawBody || Buffer.alloc(0)).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.post('/', (req, res) => {
  if (!validMetaSignature(req)) {
    console.warn('[webhook] rejected: invalid X-Hub-Signature-256');
    return res.sendStatus(401);
  }
  res.status(200).send('OK');
  processIncoming(req.body).catch(err => console.error('[webhook] Unhandled error:', err));
});

async function processIncoming(body) {
  if (body.object !== 'whatsapp_business_account') return;

  const entry = body.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const message = value?.messages?.[0];

  if (!message) return;

  const senderPhone = message.from;
  const phoneNumberId = value.metadata.phone_number_id;
  const messageType = message.type;
  // WhatsApp sends the contact's display name in the payload — use it as fallback
  const waProfileName = value.contacts?.[0]?.profile?.name || null;


  // Truncate excessively long messages to prevent prompt injection payloads and high API costs
  const MAX_MSG_LENGTH = 2000;
  const rawText = messageType === 'text' ? message.text.body.trim() : null;
  const messageText = rawText && rawText.length > MAX_MSG_LENGTH
    ? rawText.slice(0, MAX_MSG_LENGTH) + ' [mensaje truncado]'
    : rawText;

  // 1. Identify tenant
  const tenant = await getTenantConfig(phoneNumberId);
  if (!tenant) {
    console.error(`[webhook] No tenant for phone_number_id=${phoneNumberId}`);
    return;
  }

  const token = tenant.whatsapp_token || process.env.WHATSAPP_TOKEN;

  // 2. Kill switch — inactive or expired plan
  if (!tenant.active) {
    await sendMessage(senderPhone, 'Servicio momentáneamente no disponible. Disculpe las molestias 🙏', phoneNumberId, token);
    return;
  }
  if (tenant.plan_expires && new Date(tenant.plan_expires) < new Date()) {
    await sendMessage(senderPhone, 'Servicio momentáneamente no disponible. Disculpe las molestias 🙏', phoneNumberId, token);
    return;
  }

  // 3. Route: merchant or customer?
  const isMerchant = tenant.merchant_phone && senderPhone === tenant.merchant_phone;

  if (isMerchant) {
    // ── Merchant rate limiting ─────────────────────────────────────────────
    const mrlType = messageType === 'image' ? 'image' : messageType === 'audio' ? 'audio' : 'text';
    const mrl = rateCheck(tenant.id, senderPhone, mrlType, 'merchant');
    if (!mrl.allowed) {
      const mlang = merchantLang.get(tenant.id) || 'es';
      if (mrl.notify) await sendMessage(senderPhone, blockMessage(mrl.reason, 'merchant', mlang), phoneNumberId, token);
      return;
    }
    if (messageType === 'image') {
      const imgPending = await merchantPending.get(tenant.id);
      if (imgPending?.action === 'photo_await_image') {
        await executePendingPhoto(tenant, message, imgPending, phoneNumberId, token);
      } else {
        await handleMerchantImage(tenant, message, phoneNumberId, token);
      }
    } else if (messageType === 'text') {
      await handleMerchantMessage(tenant, messageText, phoneNumberId, token);
    }
    // Ignore merchant audio/location/etc.
    return;
  }

  // ── Customer rate limiting ───────────────────────────────────────────────────
  const rlType = messageType === 'image' ? 'image' : messageType === 'audio' ? 'audio' : 'text';
  const rl = rateCheck(tenant.id, senderPhone, rlType, 'customer');
  if (!rl.allowed) {
    if (rl.notify) {
      await sendMessage(senderPhone, blockMessage(rl.reason, 'customer'), phoneNumberId, token);
    }
    return;
  }

  // ── Prompt injection — block and log ────────────────────────────────────────
  if (messageText) {
    const injectionPatterns = /ignore.*instruct|system\s*:|prompt\s*:|jailbreak|act as|modo desarrollador|developer mode|sin restricciones|unrestricted|ignore previous|olvida.*instruc|ignora.*instruc|you are now|sei ora|ahora eres|tu es maintenant|du bist jetzt|você agora é/i;
    if (injectionPatterns.test(messageText)) {
      console.warn(`[security] Prompt injection blocked from ${senderPhone} on tenant ${tenant.id}: "${messageText.slice(0, 100)}"`);
      return; // Drop silently — no feedback to attacker
    }
  }

  // ── Route by message type ────────────────────────────────────────────────────
  if (messageType === 'text') {
    await handleCustomerMessage(tenant, senderPhone, messageText, null, null, waProfileName, phoneNumberId, token);

  } else if (messageType === 'location') {
    const loc = message.location;
    await handleCustomerMessage(tenant, senderPhone, null, { lat: loc.latitude, lng: loc.longitude }, null, waProfileName, phoneNumberId, token);

  } else if (messageType === 'image') {
    const mediaId = message.image?.id;
    const caption = message.image?.caption?.trim() || null;
    if (!mediaId) return;
    try {
      const { buffer, mimeType } = await fetchMedia(mediaId, token);

      // ── Payment proof detection ──────────────────────────────────────────────
      // If this customer has a pending order OR placed an order in the last 24h,
      // treat the image as a payment proof — don't pass to Claude.
      const { data: convRow } = await supabase
        .from('conversations')
        .select('last_pending_order_id, updated_at')
        .eq('tenant_id', tenant.id)
        .eq('customer_phone', senderPhone)
        .maybeSingle();

      const hasPendingOrder = !!convRow?.last_pending_order_id;

      // Check for a confirmed order in the last 24h (customer paid after confirmation)
      let hasRecentOrder = false;
      if (!hasPendingOrder) {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const { data: recentOrder } = await supabase
          .from('orders')
          .select('id')
          .eq('tenant_id', tenant.id)
          .eq('customer_phone', senderPhone)
          .gte('created_at', since)
          .limit(1)
          .maybeSingle();
        hasRecentOrder = !!recentOrder;
      }

      // Caption explicitly mentions payment → always treat as proof
      const captionIsPayment = caption &&
        /pago|pagu[eé]|comprobante|transferencia|transf\b|recibo|voucher|pagado|pix|yape|culqi/i.test(caption);

      if (hasPendingOrder || hasRecentOrder || captionIsPayment) {
        await handlePaymentProof(tenant, senderPhone, buffer, mimeType, phoneNumberId, token);
      } else {
        // No order context — pass image to Claude normally (product inquiry, etc.)
        const imageData = { base64: buffer.toString('base64'), mimeType };
        await handleCustomerMessage(tenant, senderPhone, caption, null, imageData, waProfileName, phoneNumberId, token);
      }
    } catch (e) {
      console.error('[webhook] Image download error:', e.message);
      await sendMessage(senderPhone,
        'No pude procesar la imagen 😕 ¿Podés describirme lo que buscás con palabras?',
        phoneNumberId, token);
    }

  } else if (messageType === 'audio') {
    const mediaId = message.audio?.id;
    if (!mediaId) return;
    try {
      const { buffer, mimeType } = await fetchMedia(mediaId, token);
      const transcription = await transcribeAudio(buffer, mimeType);
      if (!transcription) {
        await sendMessage(senderPhone,
          'Non ho capito l\'audio 😕 / No entendí el audio 😕 / Didn\'t catch that 😕\n¿Podés escribir? / Can you write? / Puoi scrivere?',
          phoneNumberId, token);
        return;
      }
      console.log(`[webhook] Audio transcribed (len=${transcription.length})`);
      const audioInjectionPatterns = /ignore.*instruct|system\s*:|prompt\s*:|jailbreak|act as|ignore previous|you are now|sei ora|ahora eres|sin restricciones|unrestricted/i;
      if (audioInjectionPatterns.test(transcription)) {
        console.warn(`[security] Injection attempt via audio from ${senderPhone} on tenant ${tenant.id}`);
        return;
      }
      await handleCustomerMessage(tenant, senderPhone, transcription, null, null, waProfileName, phoneNumberId, token);
    } catch (e) {
      console.error('[webhook] Audio transcription error:', e.message);
      await sendMessage(senderPhone,
        'Non riesco a elaborare l\'audio 😕 / No pude procesar el audio 😕 / Couldn\'t process the audio 😕\nPuoi scrivere? / ¿Podés escribir? / Can you write?',
        phoneNumberId, token);
    }

  } else {
    // Unsupported type (video, sticker, document, reaction, etc.)
    await sendMessage(senderPhone,
      'Por el momento solo puedo leer texto, fotos y audios 😊 ¿En qué te puedo ayudar?',
      phoneNumberId, token);
  }
}

// ─── Merchant NL bot ─────────────────────────────────────────────────────────

const Anthropic = require('@anthropic-ai/sdk');
const merchantPendingCache  = new Map();  // L1: in-memory
const merchantLang          = new Map();  // tenantId → last detected language (for notifications)
const broadcastInProgress   = new Set(); // prevent concurrent broadcast per tenant

// Periodic cleanup — drop stale language entries every 7 days
setInterval(() => { merchantLang.clear(); }, 7 * 86_400_000);

// Pending state persisted in tenants.merchant_pending_json (L2: DB)
// L1 is always checked first — DB only on cache miss (after server restart)
const merchantPending = {
  async get(tenantId) {
    if (merchantPendingCache.has(tenantId)) return merchantPendingCache.get(tenantId);
    const { data } = await supabase.from('tenants').select('merchant_pending_json').eq('id', tenantId).maybeSingle();
    const val = data?.merchant_pending_json || null;
    if (val) {
      if (val.expiresAt && Date.now() > val.expiresAt) {
        // Expired — clear from DB silently
        supabase.from('tenants').update({ merchant_pending_json: null }).eq('id', tenantId).then(() => {});
        return null;
      }
      merchantPendingCache.set(tenantId, val);
    }
    return val;
  },
  set(tenantId, val) {
    merchantPendingCache.set(tenantId, val);
    supabase.from('tenants').update({ merchant_pending_json: val }).eq('id', tenantId).then(() => {});
  },
  delete(tenantId) {
    merchantPendingCache.delete(tenantId);
    supabase.from('tenants').update({ merchant_pending_json: null }).eq('id', tenantId).then(() => {});
  },
};

// Multi-language response templates
const MT = {
  orders_none:       { es:()=>`📋 No hay pedidos pendientes.`, it:()=>`📋 Nessun ordine in attesa.`, en:()=>`📋 No pending orders.`, fr:()=>`📋 Aucune commande en attente.`, de:()=>`📋 Keine ausstehenden Bestellungen.`, pt:()=>`📋 Nenhum pedido pendente.` },
  order_status_upd:  { es:(id,s)=>`✅ Pedido #${id} → *${s}*.`, it:(id,s)=>`✅ Ordine #${id} → *${s}*.`, en:(id,s)=>`✅ Order #${id} → *${s}*.`, fr:(id,s)=>`✅ Commande #${id} → *${s}*.`, de:(id,s)=>`✅ Bestellung #${id} → *${s}*.`, pt:(id,s)=>`✅ Pedido #${id} → *${s}*.` },
  order_not_found:   { es:()=>`⚠️ No encontré ese pedido.`, it:()=>`⚠️ Ordine non trovato.`, en:()=>`⚠️ Order not found.`, fr:()=>`⚠️ Commande introuvable.`, de:()=>`⚠️ Bestellung nicht gefunden.`, pt:()=>`⚠️ Pedido não encontrado.` },
  block_missing:     { es:()=>`Necesito saber el rango de tiempo a bloquear. ¿Desde cuándo hasta cuándo?`, it:()=>`Ho bisogno del periodo da bloccare. Da quando a quando?`, en:()=>`I need the time range to block. From when to when?`, fr:()=>`J'ai besoin de la plage horaire. De quand à quand?`, de:()=>`Ich brauche den Zeitraum. Von wann bis wann?`, pt:()=>`Preciso do período a bloquear. De quando até quando?` },
  appt_list_header: { es:(n)=>`📅 *${n} próximas citas:*`, it:(n)=>`📅 *${n} prossimi appuntamenti:*`, en:(n)=>`📅 *${n} upcoming appointments:*`, fr:(n)=>`📅 *${n} prochains rendez-vous:*`, de:(n)=>`📅 *${n} bevorstehende Termine:*`, pt:(n)=>`📅 *${n} próximas consultas:*` },
  appt_none:        { es:()=>`📅 No hay citas próximas.`, it:()=>`📅 Nessun appuntamento in programma.`, en:()=>`📅 No upcoming appointments.`, fr:()=>`📅 Aucun rendez-vous à venir.`, de:()=>`📅 Keine bevorstehenden Termine.`, pt:()=>`📅 Nenhuma consulta próxima.` },
  appt_added:       { es:(n,s,t)=>`✅ Cita agregada:\n👤 ${n}\n💼 ${s}\n🕐 ${t}`, it:(n,s,t)=>`✅ Appuntamento aggiunto:\n👤 ${n}\n💼 ${s}\n🕐 ${t}`, en:(n,s,t)=>`✅ Appointment added:\n👤 ${n}\n💼 ${s}\n🕐 ${t}`, fr:(n,s,t)=>`✅ Rendez-vous ajouté:\n👤 ${n}\n💼 ${s}\n🕐 ${t}`, de:(n,s,t)=>`✅ Termin hinzugefügt:\n👤 ${n}\n💼 ${s}\n🕐 ${t}`, pt:(n,s,t)=>`✅ Consulta adicionada:\n👤 ${n}\n💼 ${s}\n🕐 ${t}` },
  appt_cancelled:   { es:(n,t)=>`❌ Cita de ${n} el ${t} cancelada.`, it:(n,t)=>`❌ Appuntamento di ${n} del ${t} annullato.`, en:(n,t)=>`❌ Appointment for ${n} on ${t} cancelled.`, fr:(n,t)=>`❌ Rendez-vous de ${n} le ${t} annulé.`, de:(n,t)=>`❌ Termin von ${n} am ${t} abgesagt.`, pt:(n,t)=>`❌ Consulta de ${n} em ${t} cancelada.` },
  appt_rescheduled: { es:(n,t)=>`✅ Cita de ${n} movida a ${t}.`, it:(n,t)=>`✅ Appuntamento di ${n} spostato a ${t}.`, en:(n,t)=>`✅ Appointment for ${n} moved to ${t}.`, fr:(n,t)=>`✅ Rendez-vous de ${n} déplacé à ${t}.`, de:(n,t)=>`✅ Termin von ${n} verschoben auf ${t}.`, pt:(n,t)=>`✅ Consulta de ${n} movida para ${t}.` },
  appt_not_found:   { es:()=>`⚠️ No encontré esa cita.`, it:()=>`⚠️ Appuntamento non trovato.`, en:()=>`⚠️ Appointment not found.`, fr:()=>`⚠️ Rendez-vous introuvable.`, de:()=>`⚠️ Termin nicht gefunden.`, pt:()=>`⚠️ Consulta não encontrada.` },
  block_added:      { es:(s,e)=>`🔒 Bloqueo agregado:\nDe ${s}\nHasta ${e}`, it:(s,e)=>`🔒 Blocco aggiunto:\nDa ${s}\nA ${e}`, en:(s,e)=>`🔒 Block added:\nFrom ${s}\nTo ${e}`, fr:(s,e)=>`🔒 Blocage ajouté:\nDe ${s}\nÀ ${e}`, de:(s,e)=>`🔒 Sperre hinzugefügt:\nVon ${s}\nBis ${e}`, pt:(s,e)=>`🔒 Bloqueio adicionado:\nDe ${s}\nAté ${e}` },
  block_removed:    { es:()=>`✅ Bloqueo eliminado.`, it:()=>`✅ Blocco rimosso.`, en:()=>`✅ Block removed.`, fr:()=>`✅ Blocage supprimé.`, de:()=>`✅ Sperre entfernt.`, pt:()=>`✅ Bloqueio removido.` },
  block_not_found:  { es:()=>`⚠️ No encontré ese bloqueo.`, it:()=>`⚠️ Blocco non trovato.`, en:()=>`⚠️ Block not found.`, fr:()=>`⚠️ Blocage introuvable.`, de:()=>`⚠️ Sperre nicht gefunden.`, pt:()=>`⚠️ Bloqueio não encontrado.` },
  closure_missing:  { es:()=>`Necesito fecha de inicio y fin del cierre. Ej: "vacaciones del 1 al 20 de agosto"`, it:()=>`Ho bisogno di data inizio e fine chiusura. Es: "ferie dal 1 al 20 agosto"`, en:()=>`I need start and end date of the closure. E.g. "holidays Aug 1-20"`, fr:()=>`J'ai besoin des dates de début et fin. Ex: "vacances du 1 au 20 août"`, de:()=>`Ich brauche Anfangs- und Enddatum. Z.B. "Urlaub 1.-20. August"`, pt:()=>`Preciso da data de início e fim. Ex: "férias de 1 a 20 de agosto"` },
  closure_added:    { es:(s,e,l)=>`🏖️ Cierre registrado${l}:\n📅 ${s} → ${e}`, it:(s,e,l)=>`🏖️ Chiusura registrata${l}:\n📅 ${s} → ${e}`, en:(s,e,l)=>`🏖️ Closure saved${l}:\n📅 ${s} → ${e}`, fr:(s,e,l)=>`🏖️ Fermeture enregistrée${l}:\n📅 ${s} → ${e}`, de:(s,e,l)=>`🏖️ Schließung gespeichert${l}:\n📅 ${s} → ${e}`, pt:(s,e,l)=>`🏖️ Encerramento registrado${l}:\n📅 ${s} → ${e}` },
  closure_removed:  { es:(l)=>`✅ Cierre eliminado: ${l}`, it:(l)=>`✅ Chiusura eliminata: ${l}`, en:(l)=>`✅ Closure removed: ${l}`, fr:(l)=>`✅ Fermeture supprimée: ${l}`, de:(l)=>`✅ Schließung entfernt: ${l}`, pt:(l)=>`✅ Encerramento removido: ${l}` },
  closure_not_found:{ es:()=>`⚠️ No encontré ese cierre.`, it:()=>`⚠️ Chiusura non trovata.`, en:()=>`⚠️ Closure not found.`, fr:()=>`⚠️ Fermeture introuvable.`, de:()=>`⚠️ Schließung nicht gefunden.`, pt:()=>`⚠️ Encerramento não encontrado.` },
  offer_missing:    { es:()=>`Necesito: nombre de la oferta, tipo de descuento (% o monto fijo), valor y alcance (todos los productos, categoría, producto específico...).`, it:()=>`Ho bisogno di: nome offerta, tipo sconto (% o fisso), valore e ambito (tutti i prodotti, categoria, prodotto specifico...).`, en:()=>`I need: offer name, discount type (% or fixed), value, and scope (all products, category, specific product...).`, fr:()=>`J'ai besoin du nom, type de remise (% ou fixe), valeur et portée (tous les produits, catégorie, produit...).`, de:()=>`Ich brauche: Name, Rabatttyp (% oder fest), Wert und Bereich (alle Produkte, Kategorie, Produkt...).`, pt:()=>`Preciso de: nome da oferta, tipo de desconto (% ou fixo), valor e âmbito (todos os produtos, categoria, produto...).` },
  offer_added:      { es:(l,d,s,dt)=>`🏷️ Oferta creada: *${l}* — ${d} de descuento${s}${dt}`, it:(l,d,s,dt)=>`🏷️ Offerta creata: *${l}* — ${d} di sconto${s}${dt}`, en:(l,d,s,dt)=>`🏷️ Offer created: *${l}* — ${d} off${s}${dt}`, fr:(l,d,s,dt)=>`🏷️ Offre créée: *${l}* — ${d} de remise${s}${dt}`, de:(l,d,s,dt)=>`🏷️ Angebot erstellt: *${l}* — ${d} Rabatt${s}${dt}`, pt:(l,d,s,dt)=>`🏷️ Oferta criada: *${l}* — ${d} de desconto${s}${dt}` },
  offer_removed:    { es:(l)=>`✅ Oferta "${l}" eliminada.`, it:(l)=>`✅ Offerta "${l}" eliminata.`, en:(l)=>`✅ Offer "${l}" removed.`, fr:(l)=>`✅ Offre "${l}" supprimée.`, de:(l)=>`✅ Angebot "${l}" entfernt.`, pt:(l)=>`✅ Oferta "${l}" removida.` },
  offer_not_found:  { es:()=>`⚠️ No encontré esa oferta.`, it:()=>`⚠️ Offerta non trovata.`, en:()=>`⚠️ Offer not found.`, fr:()=>`⚠️ Offre introuvable.`, de:()=>`⚠️ Angebot nicht gefunden.`, pt:()=>`⚠️ Oferta não encontrada.` },
  svc_list_header:  { es:(n)=>`💼 *${n} servicios:*`, it:(n)=>`💼 *${n} servizi:*`, en:(n)=>`💼 *${n} services:*`, fr:(n)=>`💼 *${n} services:*`, de:(n)=>`💼 *${n} Dienstleistungen:*`, pt:(n)=>`💼 *${n} serviços:*` },
  svc_none:         { es:()=>`💼 No tenés servicios cargados.`, it:()=>`💼 Nessun servizio configurato.`, en:()=>`💼 No services configured.`, fr:()=>`💼 Aucun service configuré.`, de:()=>`💼 Keine Dienstleistungen konfiguriert.`, pt:()=>`💼 Nenhum serviço configurado.` },
  svc_added:        { es:n=>`✅ Servicio *${n}* agregado.`, it:n=>`✅ Servizio *${n}* aggiunto.`, en:n=>`✅ Service *${n}* added.`, fr:n=>`✅ Service *${n}* ajouté.`, de:n=>`✅ Dienstleistung *${n}* hinzugefügt.`, pt:n=>`✅ Serviço *${n}* adicionado.` },
  svc_updated:      { es:n=>`✅ Servicio *${n}* actualizado.`, it:n=>`✅ Servizio *${n}* aggiornato.`, en:n=>`✅ Service *${n}* updated.`, fr:n=>`✅ Service *${n}* mis à jour.`, de:n=>`✅ Dienstleistung *${n}* aktualisiert.`, pt:n=>`✅ Serviço *${n}* atualizado.` },
  svc_not_found:    { es:q=>`⚠️ No encontré el servicio "${q}".`, it:q=>`⚠️ Servizio "${q}" non trovato.`, en:q=>`⚠️ Service "${q}" not found.`, fr:q=>`⚠️ Service "${q}" introuvable.`, de:q=>`⚠️ Dienstleistung "${q}" nicht gefunden.`, pt:q=>`⚠️ Serviço "${q}" não encontrado.` },
  stock_set:        { es:(n,q)=>`✅ *${n}*\nStock: ${q} unidades.`, it:(n,q)=>`✅ *${n}*\nStock: ${q} unità.`, en:(n,q)=>`✅ *${n}*\nStock: ${q} units.`, fr:(n,q)=>`✅ *${n}*\nStock: ${q} unités.`, de:(n,q)=>`✅ *${n}*\nBestand: ${q} Einheiten.`, pt:(n,q)=>`✅ *${n}*\nEstoque: ${q} unidades.` },
  stock_added:      { es:(n,d,t)=>`✅ *${n}*\n+${d} agregadas → ${t} en total.`, it:(n,d,t)=>`✅ *${n}*\n+${d} aggiunte → ${t} in totale.`, en:(n,d,t)=>`✅ *${n}*\n+${d} added → ${t} total.`, fr:(n,d,t)=>`✅ *${n}*\n+${d} ajoutées → ${t} au total.`, de:(n,d,t)=>`✅ *${n}*\n+${d} hinzugefügt → ${t} gesamt.`, pt:(n,d,t)=>`✅ *${n}*\n+${d} adicionadas → ${t} no total.` },
  stock_removed:    { es:(n,d,t)=>`✅ *${n}*\n-${d} descontadas → ${t} en total.`, it:(n,d,t)=>`✅ *${n}*\n-${d} rimosse → ${t} in totale.`, en:(n,d,t)=>`✅ *${n}*\n-${d} removed → ${t} total.`, fr:(n,d,t)=>`✅ *${n}*\n-${d} retirées → ${t} au total.`, de:(n,d,t)=>`✅ *${n}*\n-${d} entfernt → ${t} gesamt.`, pt:(n,d,t)=>`✅ *${n}*\n-${d} removidas → ${t} no total.` },
  price_updated:    { es:(n,p,c)=>`✅ *${n}*\nPrecio: ${formatPrice(p,c)}.`, it:(n,p,c)=>`✅ *${n}*\nPrezzo: ${formatPrice(p,c)}.`, en:(n,p,c)=>`✅ *${n}*\nPrice: ${formatPrice(p,c)}.`, fr:(n,p,c)=>`✅ *${n}*\nPrix: ${formatPrice(p,c)}.`, de:(n,p,c)=>`✅ *${n}*\nPreis: ${formatPrice(p,c)}.`, pt:(n,p,c)=>`✅ *${n}*\nPreço: ${formatPrice(p,c)}.` },
  unavailable:      { es:n=>`🔴 *${n}* marcado como agotado.`, it:n=>`🔴 *${n}* segnato come esaurito.`, en:n=>`🔴 *${n}* marked as out of stock.`, fr:n=>`🔴 *${n}* marqué comme épuisé.`, de:n=>`🔴 *${n}* als ausverkauft markiert.`, pt:n=>`🔴 *${n}* marcado como esgotado.` },
  available:        { es:n=>`✅ *${n}* marcado como disponible.`, it:n=>`✅ *${n}* segnato come disponibile.`, en:n=>`✅ *${n}* marked as available.`, fr:n=>`✅ *${n}* marqué comme disponible.`, de:n=>`✅ *${n}* als verfügbar markiert.`, pt:n=>`✅ *${n}* marcado como disponível.` },
  product_added:    { es:n=>`✅ Producto *${n}* agregado.`, it:n=>`✅ Prodotto *${n}* aggiunto.`, en:n=>`✅ Product *${n}* added.`, fr:n=>`✅ Produit *${n}* ajouté.`, de:n=>`✅ Produkt *${n}* hinzugefügt.`, pt:n=>`✅ Produto *${n}* adicionado.` },
  customer_named:   { es:(ph,nm)=>`✅ +${ph} guardado como *${nm}*.`, it:(ph,nm)=>`✅ +${ph} salvato come *${nm}*.`, en:(ph,nm)=>`✅ +${ph} saved as *${nm}*.`, fr:(ph,nm)=>`✅ +${ph} enregistré comme *${nm}*.`, de:(ph,nm)=>`✅ +${ph} gespeichert als *${nm}*.`, pt:(ph,nm)=>`✅ +${ph} salvo como *${nm}*.` },
  not_found:        { es:q=>`⚠️ No encontré ningún producto para "${q}".`, it:q=>`⚠️ Nessun prodotto trovato per "${q}".`, en:q=>`⚠️ No product found for "${q}".`, fr:q=>`⚠️ Aucun produit pour "${q}".`, de:q=>`⚠️ Kein Produkt für "${q}" gefunden.`, pt:q=>`⚠️ Nenhum produto para "${q}".` },
  confirm_one:      { es:n=>`¿Te referís a *${n}*?`, it:n=>`Intendi *${n}*?`, en:n=>`Do you mean *${n}*?`, fr:n=>`Vous voulez dire *${n}*?`, de:n=>`Meinen Sie *${n}*?`, pt:n=>`Você quer dizer *${n}*?` },
  confirm_many:     { es:l=>`Encontré varios:\n${l}\n¿Cuál de estos? Respondé con el número.`, it:l=>`Ho trovato più prodotti:\n${l}\nQuale di questi? Rispondi con il numero.`, en:l=>`Found multiple:\n${l}\nWhich one? Reply with the number.`, fr:l=>`Plusieurs trouvés:\n${l}\nLequel? Répondez avec le numéro.`, de:l=>`Mehrere gefunden:\n${l}\nWelches? Antworte mit der Nummer.`, pt:l=>`Vários encontrados:\n${l}\nQual deles? Responda com o número.` },
  canceled:         { es:()=>`Operación cancelada.`, it:()=>`Operazione annullata.`, en:()=>`Canceled.`, fr:()=>`Annulé.`, de:()=>`Abgebrochen.`, pt:()=>`Cancelado.` },
  no_pending_order: { es:()=>`⚠️ No hay ningún pedido pendiente.`, it:()=>`⚠️ Nessun ordine in attesa.`, en:()=>`⚠️ No pending order.`, fr:()=>`⚠️ Aucune commande en attente.`, de:()=>`⚠️ Keine ausstehende Bestellung.`, pt:()=>`⚠️ Nenhum pedido pendente.` },
  no_active_conv:   { es:()=>`⚠️ No hay ningún pedido activo para tomar el chat.`, it:()=>`⚠️ Nessuna chat attiva da prendere.`, en:()=>`⚠️ No active chat to take over.`, fr:()=>`⚠️ Aucun chat actif.`, de:()=>`⚠️ Kein aktiver Chat zum Übernehmen.`, pt:()=>`⚠️ Nenhum chat ativo.` },
  no_takeover:      { es:()=>`⚠️ No hay ningún chat en modo takeover activo.`, it:()=>`⚠️ Nessuna chat in modalità takeover.`, en:()=>`⚠️ No active takeover chat.`, fr:()=>`⚠️ Aucun chat en prise en charge.`, de:()=>`⚠️ Kein aktiver Takeover-Chat.`, pt:()=>`⚠️ Nenhum chat em takeover.` },
  catalog_empty:    { es:()=>`📦 No tenés productos cargados todavía.`, it:()=>`📦 Nessun prodotto nel catalogo.`, en:()=>`📦 No products loaded yet.`, fr:()=>`📦 Aucun produit chargé.`, de:()=>`📦 Noch keine Produkte geladen.`, pt:()=>`📦 Nenhum produto carregado ainda.` },
  unknown:          { es:()=>`No entendí. Podés pedirme:\n• ver catálogo\n• actualizar/agregar/quitar stock\n• cambiar precio\n• marcar agotado o disponible\n• agregar producto\n• confirmar/cancelar pedido\n• tomar/terminar chat`, it:()=>`Non ho capito. Puoi chiedermi:\n• vedere il catalogo\n• aggiornare/aggiungere/togliere stock\n• cambiare prezzo\n• segnare esaurito o disponibile\n• aggiungere prodotto\n• confermare/annullare ordine\n• prendere/terminare chat`, en:()=>`Didn't understand. You can ask:\n• view catalog\n• update/add/remove stock\n• change price\n• mark unavailable or available\n• add product\n• confirm/cancel order\n• take/end chat`, fr:()=>`Pas compris. Vous pouvez demander:\n• voir le catalogue\n• mettre à jour/ajouter/retirer du stock\n• changer le prix\n• marquer épuisé ou disponible\n• ajouter un produit\n• confirmer/annuler commande\n• prendre/terminer chat`, de:()=>`Nicht verstanden. Sie können:\n• Katalog anzeigen\n• Bestand aktualisieren/hinzufügen/entfernen\n• Preis ändern\n• Als ausverkauft/verfügbar markieren\n• Produkt hinzufügen\n• Bestellung bestätigen/stornieren\n• Chat übernehmen/beenden`, pt:()=>`Não entendi. Pode pedir:\n• ver catálogo\n• atualizar/adicionar/remover estoque\n• mudar preço\n• marcar esgotado ou disponível\n• adicionar produto\n• confirmar/cancelar pedido\n• assumir/terminar chat` },
  // Customer-facing order status push notifications (sent to buyer's phone)
  cust_status_preparing: { es:id=>`🍳 ¡Tu pedido *#${id}* está siendo preparado! Te avisamos cuando esté en camino.`, it:id=>`🍳 Il tuo ordine *#${id}* è in preparazione! Ti avvisiamo quando parte.`, en:id=>`🍳 Your order *#${id}* is being prepared! We'll let you know when it's on its way.`, fr:id=>`🍳 Votre commande *#${id}* est en cours de préparation! Nous vous préviendrons quand elle sera en route.`, de:id=>`🍳 Deine Bestellung *#${id}* wird vorbereitet! Wir benachrichtigen dich wenn sie unterwegs ist.`, pt:id=>`🍳 Seu pedido *#${id}* está sendo preparado! Avisaremos quando sair.` },
  cust_status_delivering: { es:id=>`🚚 ¡Tu pedido *#${id}* está en camino! En breve llegará a tu dirección.`, it:id=>`🚚 Il tuo ordine *#${id}* è in consegna! Arriverà presto.`, en:id=>`🚚 Your order *#${id}* is on its way! It'll arrive at your address shortly.`, fr:id=>`🚚 Votre commande *#${id}* est en route! Elle arrivera bientôt.`, de:id=>`🚚 Deine Bestellung *#${id}* ist unterwegs! Sie kommt bald an.`, pt:id=>`🚚 Seu pedido *#${id}* saiu para entrega! Chegará em breve.` },
  cust_status_delivered:  { es:id=>`✅ ¡Tu pedido *#${id}* fue entregado! Gracias por tu compra 🙏`, it:id=>`✅ Il tuo ordine *#${id}* è stato consegnato! Grazie per il tuo acquisto 🙏`, en:id=>`✅ Your order *#${id}* has been delivered! Thank you for your purchase 🙏`, fr:id=>`✅ Votre commande *#${id}* a été livrée! Merci pour votre achat 🙏`, de:id=>`✅ Deine Bestellung *#${id}* wurde geliefert! Danke für deinen Einkauf 🙏`, pt:id=>`✅ Seu pedido *#${id}* foi entregue! Obrigado pela sua compra 🙏` },
};

function mt(lang, key, ...args) {
  const l = MT[key]?.[lang] ? lang : 'es';
  return MT[key][l](...args);
}

async function notifyCustomerOrderStatus(order, status, phoneNumberId, token, tenant = null) {
  const custNotifyKey = `cust_status_${status}`;
  if (!MT[custNotifyKey] || !order.customer_phone) return;
  const shortId = order.id.substring(0, 8).toUpperCase();
  const msg = MT[custNotifyKey].es(shortId);
  await sendMessage(order.customer_phone, msg, phoneNumberId, token).catch(() => {});
  if (status === 'delivered' && tenant?.google_review_url) {
    const reviewMsg = `¿Cómo fue tu experiencia? Si te gustó, nos ayudás mucho con una reseña 🙏\n${tenant.google_review_url}`;
    await sendMessage(order.customer_phone, reviewMsg, phoneNumberId, token).catch(() => {});
  }
}

async function parseMerchantIntent(messageText, products, services, tenant) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const catalog = products.length
    ? products.map(p => `• ${p.name} (stock: ${p.stock_qty ?? 'N/A'}, price: ${p.price_guarani})`).join('\n')
    : 'empty';
  const svcList = services && services.length
    ? services.map(s => `• ${s.name} (${s.duration_min ?? '?'}min, price: ${s.price_guarani})`).join('\n')
    : 'empty';
  const today = new Date().toISOString();

  // Build capability context so AI only offers valid actions for this account type
  const caps = [];
  if (tenant?.products_enabled)     caps.push('products/stock/catalog/offers');
  if (tenant?.services_enabled)     caps.push('services');
  if (tenant?.appointments_enabled && !tenant?.restaurant_enabled) caps.push('appointments');
  if (tenant?.restaurant_enabled)   caps.push('restaurant reservations/tables');
  caps.push('orders', 'chat-takeover', 'analytics/stats');

  const resp = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    system: `You parse merchant WhatsApp messages. Return ONLY valid JSON, no explanation.
Today: ${today}
This merchant's active modules: ${caps.join(', ')}.

Actions:
update_stock, set_stock, set_price, mark_unavailable, mark_available, add_product, get_catalog,
photo_update,
get_orders, confirm_order, cancel_order, update_order_status, chat_takeover, name_customer,
get_appointments, add_appointment, cancel_appointment, reschedule_appointment,
block_time, unblock_time,
create_closure, delete_closure,
create_offer, delete_offer,
get_services, update_service, add_service, delete_service,
get_reservations, block_tables, book_table, cancel_reservation, confirm_reservation,
get_stats,
delete_product,
broadcast,
update_customer, delete_customer,
set_hours,
greeting, unknown.

Use "greeting" for salutations (ciao, hola, hello, hi, buongiorno, bonjour, etc.) or small talk with no business intent.
Use "unknown" only when you cannot identify any of the above actions.

JSON schema: {"action":"...","product_query":null,"service_query":null,"params":{},"language":"es|it|en|fr|de|pt"}

params by action:
update_stock: {"delta": N} positive=add, negative=remove ("vendute 10", "leva 10", "arrivate 50")
set_stock: {"qty": N} absolute value
set_price: {"price": N}
add_product: {"name":"...","category":"...","price":0,"stock":0,"description":null}
name_customer: {"phone":"...","name":"..."}
get_orders: {"status_filter": "active|all|pending", "customer_query": null} — active=in progress, pending=awaiting confirmation
update_order_status: {"customer_query":null,"status":"preparing|delivering|delivered"}
chat_takeover: {"customer_query":"..."} partial name or phone, null if not specified
get_appointments: {"from":"ISO","to":"ISO","customer_query":null} — default from=today, to=+7days
add_appointment: {"customer_name":"...","customer_phone":null,"service_query":null,"start_at":"ISO or null","duration_override":null}
cancel_appointment: {"customer_query":"...","start_at":"ISO or null"}
reschedule_appointment: {"customer_query":"...","current_start":"ISO or null","new_start":"ISO"}
block_time: {"start_at":"ISO","end_at":"ISO","reason":null}
unblock_time: {"start_at":"ISO or null","reason_query":null}
create_closure: {"start_date":"YYYY-MM-DD","end_date":"YYYY-MM-DD","label":"..."}
delete_closure: {"label_query":"...","start_date":"YYYY-MM-DD or null"}
create_offer: {"label":"...","discount_type":"percent|fixed","discount_value":N,"scope":"all_products|category|product|all_services|service_category|service","scope_target":null,"valid_from":"YYYY-MM-DD or null","valid_to":"YYYY-MM-DD or null"}
delete_offer: {"label_query":"..."}
update_service: {"updates":{"price_guarani":null,"duration_min":null,"is_available":null,"name":null,"category":null,"description":null}}
add_service: {"name":"...","category":null,"price":0,"duration_min":null,"price_type":"fixed"}
get_reservations: {"from":"ISO","to":"ISO","customer_query":null} — default from=today, to=+7days. Use when merchant asks "prenotazioni di oggi/domani/settimana", "chi viene stasera", "reservas"
block_tables: {"num_tables":N,"table_capacity":null,"zone_preference":null,"date":"YYYY-MM-DD or null","time":"HH:MM or null","notes":null} — internal block, NO customer name. Use when merchant says "blocca tavoli", "occupa tavolo", "metti occupato". Merchant authority, no validation.
book_table: {"customer_name":"...","customer_phone":null,"party_size":N,"date":"YYYY-MM-DD or null","time":"HH:MM or null","zone_preference":null,"notes":null,"num_tables":1,"table_capacity":null} — customer reservation. Use when merchant says "prenota", "aggiungi prenotazione", "reserva para X". Customer name is the key field.
cancel_reservation: {"customer_query":"...","date":"YYYY-MM-DD or null"}
confirm_reservation: {"customer_query":"...","date":"YYYY-MM-DD or null"} — confirm a pending_merchant reservation
get_stats: {"period":"today|week|month|all","metric":"orders|revenue|customers|all"} — analytics. Use for: "quanti ordini", "fatturato settimana", "clienti nuovi", "report"
delete_product: {} — delete product entirely (product_query identifies it). Use: "elimina prodotto X", "cancella X dal catalogo"
photo_update: {} — merchant wants to add or update product photos. product_query identifies the product. Use: "foto per X", "aggiungi foto a X", "cambia immagine di X", "photo for X", "foto de X", "imagen de X", "actualizar foto", "photo du produit X", "Bild für X"
delete_service: {} — delete service entirely (service_query identifies it). Use: "elimina servizio X"
broadcast: {"message":"...","days_active":30} — send message to all active customers. message required, days_active optional (default 30 = customers active in last 30 days). Use: "manda messaggio a tutti", "broadcast", "invia a tutti i clienti"
update_customer: {"customer_query":"...","email":null,"address":null,"name":null} — update customer info. customer_query required (name or phone). At least one of email/address/name required.
delete_customer: {"customer_query":"..."} — delete customer record. customer_query required.
set_hours: {"day":"monday|tuesday|wednesday|thursday|friday|saturday|sunday|all","open_time":"HH:MM or null","close_time":"HH:MM or null","is_closed":false,"open_time_2":null,"close_time_2":null} — update business hours for one or all days. Use: "lunedì apriamo alle 9", "domenica siamo chiusi", "orario di apertura", "cambia orari"

Resolve relative dates using today's ISO above. "domani alle 15" → correct ISO. "questa settimana" → from=Monday ISO, to=Sunday ISO.`,
    messages: [{ role: 'user', content: `Products:\n${catalog}\n\nServices:\n${svcList}\n\nMessage: ${messageText}` }],
  });
  try {
    const raw = resp.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    return JSON.parse(raw);
  } catch {
    return { action: 'unknown', product_query: null, service_query: null, params: {}, language: 'es' };
  }
}

// Feature gate — returns localised error string if action not allowed, null if OK
function featureGate(tenant, action, lang) {
  const productActions  = new Set(['update_stock','set_stock','set_price','mark_unavailable','mark_available','add_product','get_catalog','photo_update']);
  const serviceActions  = new Set(['get_services','add_service','update_service']);
  const apptActions     = new Set(['get_appointments','add_appointment','cancel_appointment','reschedule_appointment','block_time','unblock_time']);
  const restaurantActions = new Set(['get_reservations','block_tables','book_table','cancel_reservation','confirm_reservation']);
  if (productActions.has(action) && !tenant.products_enabled) {
    const m = { es:'⚠️ El módulo de productos no está activado en tu plan.', it:'⚠️ Il modulo prodotti non è attivo nel tuo piano.', en:'⚠️ Product module is not enabled on your plan.', fr:'⚠️ Le module produits n\'est pas activé.', de:'⚠️ Produktmodul ist nicht aktiviert.', pt:'⚠️ O módulo de produtos não está ativo.' };
    return m[lang] || m.es;
  }
  if (serviceActions.has(action) && !tenant.services_enabled) {
    const m = { es:'⚠️ El módulo de servicios no está activado en tu plan.', it:'⚠️ Il modulo servizi non è attivo nel tuo piano.', en:'⚠️ Services module is not enabled on your plan.', fr:'⚠️ Le module services n\'est pas activé.', de:'⚠️ Dienstleistungsmodul ist nicht aktiviert.', pt:'⚠️ O módulo de serviços não está ativo.' };
    return m[lang] || m.es;
  }
  if (apptActions.has(action) && !tenant.appointments_enabled) {
    const m = { es:'⚠️ El módulo de citas no está activado en tu plan.', it:'⚠️ Il modulo appuntamenti non è attivo nel tuo piano.', en:'⚠️ Appointments module is not enabled on your plan.', fr:'⚠️ Le module rendez-vous n\'est pas activé.', de:'⚠️ Terminmodul ist nicht aktiviert.', pt:'⚠️ O módulo de agendamentos não está ativo.' };
    return m[lang] || m.es;
  }
  if (restaurantActions.has(action) && !tenant.restaurant_enabled) {
    const m = { es:'⚠️ El módulo de reservas de restaurante no está activado en tu plan.', it:'⚠️ Il modulo prenotazioni ristorante non è attivo nel tuo piano.', en:'⚠️ Restaurant reservations module is not enabled on your plan.', fr:'⚠️ Le module réservations restaurant n\'est pas activé.', de:'⚠️ Restaurantreservierungsmodul ist nicht aktiviert.', pt:'⚠️ O módulo de reservas de restaurante não está ativo.' };
    return m[lang] || m.es;
  }
  return null;
}

// Slot availability check — returns { available: true } or { available: false, reason, detail }
async function checkSlotAvailability(tenantId, startAt, endAt, capacity = 1) {
  const d = new Date(startAt);
  const dayOfWeek = d.getUTCDay();
  const startHHMM = d.toISOString().slice(11, 16);
  const endHHMM   = new Date(endAt).toISOString().slice(11, 16);
  const cap = Math.max(1, capacity || 1);

  const [bhRes, blocksRes, apptsRes] = await Promise.all([
    supabase.from('business_hours').select('open_time,close_time,is_closed').eq('tenant_id', tenantId).eq('day_of_week', dayOfWeek).maybeSingle(),
    supabase.from('appointment_blocks').select('start_at,end_at,reason').eq('tenant_id', tenantId).lt('start_at', endAt).gt('end_at', startAt).limit(1),
    supabase.from('appointments').select('customer_name,customer_phone,start_at,end_at,service_id').eq('tenant_id', tenantId).neq('status', 'cancelled').lt('start_at', endAt).gt('end_at', startAt),
  ]);

  const bh = bhRes.data;
  if (!bh || bh.is_closed) return { available: false, reason: 'closed_day' };
  if (startHHMM < bh.open_time || endHHMM > bh.close_time)
    return { available: false, reason: 'outside_hours', open: bh.open_time, close: bh.close_time };
  if (blocksRes.data?.length)
    return { available: false, reason: 'blocked', block: blocksRes.data[0] };
  // Slot is full only when overlapping appointments reach the tenant's parallel capacity
  if ((apptsRes.data?.length || 0) >= cap)
    return { available: false, reason: 'booked', appt: apptsRes.data[0] };
  return { available: true };
}

function slotConflictMessage(check, lang) {
  if (check.reason === 'closed_day') {
    const m = { es:'🔴 Ese día estamos cerrados.', it:'🔴 Quel giorno siamo chiusi.', en:'🔴 We are closed that day.', fr:'🔴 Ce jour-là nous sommes fermés.', de:'🔴 Dieser Tag ist geschlossen.', pt:'🔴 Esse dia estamos fechados.' };
    return m[lang] || m.es;
  }
  if (check.reason === 'outside_hours') {
    const m = { es:`⏰ Ese horario está fuera del horario de atención (${check.open}–${check.close}).`, it:`⏰ Quell'orario è fuori dall'orario di apertura (${check.open}–${check.close}).`, en:`⏰ That time is outside business hours (${check.open}–${check.close}).`, fr:`⏰ Cet horaire est en dehors des heures d'ouverture (${check.open}–${check.close}).`, de:`⏰ Diese Zeit liegt außerhalb der Öffnungszeiten (${check.open}–${check.close}).`, pt:`⏰ Esse horário está fora do horário de atendimento (${check.open}–${check.close}).` };
    return m[lang] || m.es;
  }
  if (check.reason === 'blocked') {
    const reason = check.block.reason ? ` (${check.block.reason})` : '';
    const m = { es:`🔒 Ese horario está bloqueado${reason}.`, it:`🔒 Quell'orario è bloccato${reason}.`, en:`🔒 That slot is blocked${reason}.`, fr:`🔒 Ce créneau est bloqué${reason}.`, de:`🔒 Dieser Slot ist gesperrt${reason}.`, pt:`🔒 Esse horário está bloqueado${reason}.` };
    return m[lang] || m.es;
  }
  if (check.reason === 'booked') {
    const a = check.appt;
    const who = a.customer_name || `+${a.customer_phone}`;
    const t = new Date(a.start_at).toLocaleString('es-PY', { hour:'2-digit', minute:'2-digit' });
    const dur = Math.round((new Date(a.end_at) - new Date(a.start_at)) / 60000);
    const m = { es:`📌 Ese slot ya está ocupado por *${who}* a las ${t} (${dur}min).`, it:`📌 Quello slot è già occupato da *${who}* alle ${t} (${dur}min).`, en:`📌 That slot is already booked by *${who}* at ${t} (${dur}min).`, fr:`📌 Ce créneau est déjà réservé par *${who}* à ${t} (${dur}min).`, de:`📌 Dieser Slot ist bereits von *${who}* um ${t} (${dur}min) gebucht.`, pt:`📌 Esse horário já está ocupado por *${who}* às ${t} (${dur}min).` };
    return m[lang] || m.es;
  }
  return null;
}

// Parse missing fields from a follow-up message for add_appointment
async function parseMissingApptFields(reply, partial, services) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const today = new Date().toISOString();
  const svcList = services.length ? services.map(s => `• ${s.name} (${s.duration_min ?? '?'}min)`).join('\n') : 'empty';
  const resp = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 150,
    system: `Extract appointment fields from a follow-up reply. Today: ${today}
Return ONLY JSON: {"customer_name":null,"customer_phone":null,"service_query":null,"start_at":null,"duration_override":null}
Only fill fields that are present in the reply. Resolve relative dates to ISO.
Services available:\n${svcList}`,
    messages: [{ role: 'user', content: `Already known: ${JSON.stringify(partial)}\nReply: ${reply}` }],
  });
  try { return JSON.parse(resp.content[0].text.trim()); }
  catch { return {}; }
}

function missingApptFieldsMsg(params, lang) {
  const missing = [];
  if (!params.customer_name && !params.customer_phone) {
    const f = { es:'nombre del cliente', it:'nome del cliente', en:'customer name', fr:'nom du client', de:'Name des Kunden', pt:'nome do cliente' };
    missing.push(f[lang] || f.es);
  }
  if (!params.start_at) {
    const f = { es:'día y hora', it:'giorno e ora', en:'day and time', fr:'jour et heure', de:'Tag und Uhrzeit', pt:'dia e hora' };
    missing.push(f[lang] || f.es);
  }
  if (!params.service_query && !params.duration_override) {
    const f = { es:'servicio o duración (ej: 30 minutos)', it:'servizio o durata (es: 30 minuti)', en:'service or duration (e.g. 30 minutes)', fr:'service ou durée (ex: 30 minutes)', de:'Dienstleistung oder Dauer (z.B. 30 Minuten)', pt:'serviço ou duração (ex: 30 minutos)' };
    missing.push(f[lang] || f.es);
  }
  if (!missing.length) return null;
  const ask = { es:`Faltan estos datos:\n• ${missing.join('\n• ')}`, it:`Mancano questi dati:\n• ${missing.join('\n• ')}`, en:`Missing info:\n• ${missing.join('\n• ')}`, fr:`Informations manquantes:\n• ${missing.join('\n• ')}`, de:`Fehlende Angaben:\n• ${missing.join('\n• ')}`, pt:`Dados faltando:\n• ${missing.join('\n• ')}` };
  return ask[lang] || ask.es;
}

function missingTableFieldsMsg(params, lang, action) {
  const missing = [];
  const isBlock = action === 'block_tables';

  // block_tables: need date+time, capacity, zone — no customer name
  // book_table: need customer name, date+time, party size
  if (!isBlock && !params.customer_name) {
    const f = { es:'nombre del cliente', it:'nome del cliente', en:'customer name', fr:'nom du client', de:'Name des Gastes', pt:'nome do cliente' };
    missing.push(f[lang] || f.es);
  }
  if (!params.date) {
    const f = { es:'fecha y hora', it:'data e ora', en:'date and time', fr:'date et heure', de:'Datum und Uhrzeit', pt:'data e hora' };
    missing.push(f[lang] || f.es);
  }
  if (isBlock && !params.table_capacity) {
    const f = { es:'capacidad de las mesas (ej: "2 mesas de 4")', it:'capienza dei tavoli (es: "2 tavoli da 4")', en:'table capacity (e.g. "2 tables for 4")', fr:'capacité des tables (ex: "2 tables de 4")', de:'Tischkapazität (z.B. "2 Tische à 4")', pt:'capacidade das mesas (ex: "2 mesas de 4")' };
    missing.push(f[lang] || f.es);
  }
  if (isBlock && !params.zone_preference) {
    const f = { es:'zona (o "cualquier zona")', it:'zona (o "qualsiasi zona")', en:'zone (or "any zone")', fr:'zone (ou "n\'importe quelle zone")', de:'Zone (oder "beliebige Zone")', pt:'zona (ou "qualquer zona")' };
    missing.push(f[lang] || f.es);
  }
  if (!isBlock && !params.party_size) {
    const f = { es:'número de personas', it:'numero di persone', en:'number of guests', fr:'nombre de personnes', de:'Anzahl der Gäste', pt:'número de pessoas' };
    missing.push(f[lang] || f.es);
  }
  if (!missing.length) return null;
  const hdr = isBlock
    ? { es:'Faltan datos para bloquear:\n• ', it:'Mancano dati per bloccare:\n• ', en:'Missing info to block:\n• ', fr:'Données manquantes pour bloquer:\n• ', de:'Fehlende Angaben zum Sperren:\n• ', pt:'Dados faltando para bloquear:\n• ' }
    : { es:'Faltan datos para la reserva:\n• ', it:'Mancano dati per la prenotazione:\n• ', en:'Missing info for reservation:\n• ', fr:'Données manquantes pour la réservation:\n• ', de:'Fehlende Angaben für die Reservierung:\n• ', pt:'Dados faltando para a reserva:\n• ' };
  return (hdr[lang] || hdr.es) + missing.join('\n• ');
}

async function parseMissingTableFields(txt, existing, lang) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const today = new Date().toISOString();
  const resp = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 150,
    system: `Extract table booking fields from merchant reply. Return ONLY valid JSON.
Today: ${today}. Already known: ${JSON.stringify(existing)}.
Schema: {"date":"YYYY-MM-DD or null","time":"HH:MM or null","num_tables":N or null,"table_capacity":N or null,"zone_preference":"... or null","customer_name":"... or null","notes":"... or null"}
Only return fields mentioned in the reply. Null for unknown. Resolve relative dates.`,
    messages: [{ role: 'user', content: txt }],
  });
  try {
    const raw = resp.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    return JSON.parse(raw);
  } catch { return {}; }
}

function findProductsFuzzy(products, query) {
  if (!query) return [];
  const q = query.toLowerCase();
  const matches = products.filter(p => p.name.toLowerCase().includes(q) || q.includes(p.name.toLowerCase()));
  if (matches.length) return matches;
  // Fallback: any word overlap
  const words = q.split(/\s+/).filter(w => w.length > 2);
  return products.filter(p => words.some(w => p.name.toLowerCase().includes(w)));
}

async function notifyWaitlist(tenant, productName, phoneNumberId, token) {
  const { data: waiting } = await supabase.from('waitlist')
    .select('customer_phone')
    .eq('tenant_id', tenant.id)
    .ilike('product_name', productName);
  if (!waiting?.length) return;
  for (const { customer_phone } of waiting) {
    await sendMessage(customer_phone,
      `¡Buenas noticias! 🎉 *${productName}* volvió a estar disponible en ${tenant.name}. ¿Querés pedirlo?`,
      phoneNumberId, token
    );
  }
  await supabase.from('waitlist')
    .delete()
    .eq('tenant_id', tenant.id)
    .ilike('product_name', productName);
}

async function executeMerchantAction(tenant, action, product, params, lang, phoneNumberId, token) {
  if (action === 'update_stock') {
    const delta = params.delta || 0;
    const newQty = Math.max(0, (product.stock_qty || 0) + delta);
    await supabase.from('products').update({ stock_qty: newQty, is_available: newQty > 0 }).eq('id', product.id);
    invalidateStock(tenant.id);
    const key = delta > 0 ? 'stock_added' : 'stock_removed';
    await sendMessage(tenant.merchant_phone, mt(lang, key, product.name, Math.abs(delta), newQty), phoneNumberId, token);
    if (newQty > 0) notifyWaitlist(tenant, product.name, phoneNumberId, token).catch(e => console.error('[waitlist]', e.message));
    return;
  }
  if (action === 'set_stock') {
    const qty = params.qty ?? 0;
    await supabase.from('products').update({ stock_qty: qty, is_available: qty > 0 }).eq('id', product.id);
    invalidateStock(tenant.id);
    await sendMessage(tenant.merchant_phone, mt(lang, 'stock_set', product.name, qty), phoneNumberId, token);
    if (qty > 0) notifyWaitlist(tenant, product.name, phoneNumberId, token).catch(e => console.error('[waitlist]', e.message));
    return;
  }
  if (action === 'set_price') {
    const price = params.price || 0;
    await supabase.from('products').update({ price_guarani: price }).eq('id', product.id);
    invalidateStock(tenant.id);
    await sendMessage(tenant.merchant_phone, mt(lang, 'price_updated', product.name, price, currency), phoneNumberId, token);
    return;
  }
  if (action === 'mark_unavailable') {
    await supabase.from('products').update({ is_available: false, stock_qty: 0 }).eq('id', product.id);
    invalidateStock(tenant.id);
    await sendMessage(tenant.merchant_phone, mt(lang, 'unavailable', product.name), phoneNumberId, token);
    return;
  }
  if (action === 'mark_available') {
    const qty = product.stock_qty || 1;
    await supabase.from('products').update({ is_available: true, stock_qty: qty }).eq('id', product.id);
    invalidateStock(tenant.id);
    await sendMessage(tenant.merchant_phone, mt(lang, 'available', product.name), phoneNumberId, token);
    return;
  }
}

// ─── Merchant message handler ─────────────────────────────────────────────────

async function handleMerchantMessage(tenant, messageText, phoneNumberId, token) {
  const currency = tenant.plan_currency || 'PYG';
  // ── Takeover forward (highest priority — merchant free-texts go to customer) ─
  const { data: activeConv } = await supabase
    .from('conversations')
    .select('id, last_pending_customer_phone, customer_name')
    .eq('tenant_id', tenant.id)
    .eq('takeover_active', true)
    .maybeSingle();

  if (activeConv?.last_pending_customer_phone) {
    if (messageText.trim().toUpperCase() === 'STOP') {
      await endTakeover(tenant, activeConv, phoneNumberId, token);
      return;
    }
    await sendMessage(activeConv.last_pending_customer_phone, messageText, phoneNumberId, token);
    console.log(`[takeover] merchant→customer: ${activeConv.last_pending_customer_phone}`);
    return;
  }

  // ── Pending confirmation check ────────────────────────────────────────────
  const pending = await merchantPending.get(tenant.id);
  if (pending) {
    if (Date.now() > pending.expiresAt) {
      merchantPending.delete(tenant.id);
    } else {
      const txt = messageText.trim();

      // Candidate selection by number
      if (pending.candidates) {
        const num = parseInt(txt);
        if (!isNaN(num) && num >= 1 && num <= pending.candidates.length) {
          const chosen = pending.candidates[num - 1];
          merchantPending.delete(tenant.id);
          if (pending.action === 'chat_takeover') {
            await activateTakeover(tenant, chosen, pending.lang, phoneNumberId, token);
          } else if (pending.action === 'cancel_appointment') {
            await supabase.from('appointments').update({ status: 'cancelled' }).eq('id', chosen.id);
            const dt = new Date(chosen.start_at).toLocaleString('es-PY', { weekday:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
            await sendMessage(tenant.merchant_phone, mt(pending.lang, 'appt_cancelled', chosen.customer_name || chosen.customer_phone, dt), phoneNumberId, token);
          } else if (pending.action === 'update_order_status') {
            await supabase.from('orders').update({ status: pending.params.status }).eq('id', chosen.id);
            await sendMessage(tenant.merchant_phone, mt(pending.lang, 'order_status_upd', chosen.id.substring(0,8).toUpperCase(), pending.params.status), phoneNumberId, token);
            await notifyCustomerOrderStatus(chosen, pending.params.status, phoneNumberId, token, tenant);
          } else if (pending.action === 'confirm_order') {
            await confirmOrder(tenant, chosen, phoneNumberId, token);
          } else if (pending.action === 'cancel_order') {
            await cancelOrder(tenant, chosen, phoneNumberId, token);
          } else if (pending.action === 'update_service') {
            await supabase.from('services').update(pending.params.updates).eq('id', chosen.id);
            invalidateServices(tenant.id);
            await sendMessage(tenant.merchant_phone, mt(pending.lang, 'svc_updated', chosen.name), phoneNumberId, token);
          } else if (pending.action === 'photo_update') {
            await askPhotoMode(tenant, chosen, pending.lang, phoneNumberId, token);
            return;
          } else if (pending.action === 'delete_product') {
            await supabase.from('products').delete().eq('id', chosen.id).eq('tenant_id', tenant.id);
            invalidateStock(tenant.id);
            const ok = { es:`🗑️ *${chosen.name}* eliminado.`, it:`🗑️ *${chosen.name}* eliminato.`, en:`🗑️ *${chosen.name}* deleted.`, fr:`🗑️ *${chosen.name}* supprimé.`, de:`🗑️ *${chosen.name}* gelöscht.`, pt:`🗑️ *${chosen.name}* eliminado.` };
            await sendMessage(tenant.merchant_phone, ok[pending.lang] || ok.es, phoneNumberId, token);
          } else if (pending.action === 'delete_service') {
            await supabase.from('services').delete().eq('id', chosen.id).eq('tenant_id', tenant.id);
            invalidateServices(tenant.id);
            const ok = { es:`🗑️ *${chosen.name}* eliminado.`, it:`🗑️ *${chosen.name}* eliminato.`, en:`🗑️ *${chosen.name}* deleted.`, fr:`🗑️ *${chosen.name}* supprimé.`, de:`🗑️ *${chosen.name}* gelöscht.`, pt:`🗑️ *${chosen.name}* eliminado.` };
            await sendMessage(tenant.merchant_phone, ok[pending.lang] || ok.es, phoneNumberId, token);
          } else if (pending.action === 'cancel_reservation') {
            await supabase.from('reservations').update({ status: 'cancelled' }).eq('id', chosen.id);
            const dt = new Date(chosen.reserved_at).toLocaleString('es', { weekday:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
            const ok = { es:`❌ Reserva de *${chosen.customer_name}* (${dt}) cancelada.`, it:`❌ Prenotazione di *${chosen.customer_name}* (${dt}) annullata.`, en:`❌ Reservation for *${chosen.customer_name}* (${dt}) cancelled.`, fr:`❌ Réservation de *${chosen.customer_name}* (${dt}) annulée.`, de:`❌ Reservierung von *${chosen.customer_name}* (${dt}) storniert.`, pt:`❌ Reserva de *${chosen.customer_name}* (${dt}) cancelada.` };
            await sendMessage(tenant.merchant_phone, ok[pending.lang] || ok.es, phoneNumberId, token);
          } else if (pending.action === 'confirm_reservation') {
            await supabase.from('reservations').update({ status: 'confirmed' }).eq('id', chosen.id);
            const dt = new Date(chosen.reserved_at).toLocaleString('es', { weekday:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
            const ok = { es:`✅ Reserva de *${chosen.customer_name}* (${dt}) confirmada.`, it:`✅ Prenotazione di *${chosen.customer_name}* (${dt}) confermata.`, en:`✅ Reservation for *${chosen.customer_name}* (${dt}) confirmed.`, fr:`✅ Réservation de *${chosen.customer_name}* (${dt}) confirmée.`, de:`✅ Reservierung von *${chosen.customer_name}* (${dt}) bestätigt.`, pt:`✅ Reserva de *${chosen.customer_name}* (${dt}) confirmada.` };
            await sendMessage(tenant.merchant_phone, ok[pending.lang] || ok.es, phoneNumberId, token);
          } else {
            await executeMerchantAction(tenant, pending.action, chosen, pending.params, pending.lang, phoneNumberId, token);
          }
          return;
        }
        // Try name/product match among candidates
        if (pending.action === 'chat_takeover') {
          const byName = (pending.candidates).filter(c => (c.customer_name || '').toLowerCase().includes(txt.toLowerCase()) || (c.customer_phone || '').includes(txt));
          if (byName.length === 1) { merchantPending.delete(tenant.id); await activateTakeover(tenant, byName[0], pending.lang, phoneNumberId, token); return; }
        } else {
          const byName = findProductsFuzzy(pending.candidates, txt);
          if (byName.length === 1) {
            merchantPending.delete(tenant.id);
            if (pending.action === 'photo_update') {
              await askPhotoMode(tenant, byName[0], pending.lang, phoneNumberId, token);
            } else {
              await executeMerchantAction(tenant, pending.action, byName[0], pending.params, pending.lang, phoneNumberId, token);
            }
            return;
          }
        }
      }

      // awaiting_fields flow (add_appointment incomplete)
      if (pending.type === 'awaiting_fields' && pending.action === 'add_appointment') {
        const extra = await parseMissingApptFields(txt, pending.params, pending.services || []);
        const merged = { ...pending.params };
        for (const [k, v] of Object.entries(extra)) { if (v != null) merged[k] = v; }
        const stillMissing = missingApptFieldsMsg(merged, pending.lang);
        if (stillMissing) {
          merchantPending.set(tenant.id, { ...pending, params: merged });
          await sendMessage(tenant.merchant_phone, stillMissing, phoneNumberId, token);
          return;
        }
        merchantPending.delete(tenant.id);
        await completeAddAppointment(tenant, merged, pending.services || [], pending.lang, phoneNumberId, token);
        return;
      }

      if (pending.type === 'awaiting_fields' && (pending.action === 'book_table' || pending.action === 'block_tables')) {
        const extra = await parseMissingTableFields(txt, pending.params, pending.lang);
        const merged = { ...pending.params };
        for (const [k, v] of Object.entries(extra)) { if (v != null) merged[k] = v; }
        const stillMissing = missingTableFieldsMsg(merged, pending.lang, pending.action);
        if (stillMissing) {
          merchantPending.set(tenant.id, { ...pending, params: merged });
          await sendMessage(tenant.merchant_phone, stillMissing, phoneNumberId, token);
          return;
        }
        merchantPending.delete(tenant.id);
        await completeBookTable(tenant, merged, pending.lang, phoneNumberId, token);
        return;
      }

      // Yes/no for delete_customer confirmation
      if (pending.action === 'delete_customer' && pending.target) {
        const lower = txt.toLowerCase();
        const yes = /^(yes|sì|si|oui|ja|ok|yep|sure|y|s|j|1|👍|✅|certo|claro|ouais|klar|confirm)/.test(lower);
        const no  = /^(no|nope|nein|non|cancel|nada|n|2|❌|👎|annulla|cancelar|pas ça)/.test(lower);
        if (yes) {
          const { target } = pending;
          merchantPending.delete(tenant.id);
          await supabase.from('conversations').delete().eq('tenant_id', tenant.id).eq('customer_phone', target.customer_phone);
          const label = target.customer_name || target.customer_phone;
          const ok = { es:`🗑️ Cliente *${label}* eliminado.`, it:`🗑️ Cliente *${label}* eliminato.`, en:`🗑️ Customer *${label}* deleted.`, fr:`🗑️ Client *${label}* supprimé.`, de:`🗑️ Kunde *${label}* gelöscht.`, pt:`🗑️ Cliente *${label}* eliminado.` };
          await sendMessage(tenant.merchant_phone, ok[pending.lang] || ok.es, phoneNumberId, token);
          return;
        }
        if (no) {
          merchantPending.delete(tenant.id);
          await sendMessage(tenant.merchant_phone, mt(pending.lang, 'canceled'), phoneNumberId, token);
          return;
        }
      }

      // Yes/no for delete_product / delete_service single-candidate confirmation
      const isDeleteConfirm = (pending.action === 'delete_product' || pending.action === 'delete_service') && pending.candidates?.length === 1;
      if (isDeleteConfirm) {
        const lower = txt.toLowerCase();
        const yes = /^(yes|sì|si|oui|ja|ok|yep|sure|y|s|j|1|👍|✅|certo|claro|ouais|klar|confirm)/.test(lower);
        const no  = /^(no|nope|nein|non|cancel|nada|n|2|❌|👎|annulla|cancelar|pas ça)/.test(lower);
        if (yes) {
          const target = pending.candidates[0];
          merchantPending.delete(tenant.id);
          if (pending.action === 'delete_product') {
            await supabase.from('products').delete().eq('id', target.id).eq('tenant_id', tenant.id);
            invalidateStock(tenant.id);
          } else {
            await supabase.from('services').delete().eq('id', target.id).eq('tenant_id', tenant.id);
            invalidateServices(tenant.id);
          }
          const ok = { es:`🗑️ *${target.name}* eliminado.`, it:`🗑️ *${target.name}* eliminato.`, en:`🗑️ *${target.name}* deleted.`, fr:`🗑️ *${target.name}* supprimé.`, de:`🗑️ *${target.name}* gelöscht.`, pt:`🗑️ *${target.name}* eliminado.` };
          await sendMessage(tenant.merchant_phone, ok[pending.lang] || ok.es, phoneNumberId, token);
          return;
        }
        if (no) {
          merchantPending.delete(tenant.id);
          await sendMessage(tenant.merchant_phone, mt(pending.lang, 'canceled'), phoneNumberId, token);
          return;
        }
      }

      // Yes/no for confirm_one flow
      if (pending.product) {
        const lower = txt.toLowerCase();
        const yes = /^(yes|sì|si|oui|ja|ok|yep|sure|correct|exacto|esatto|richtig|exact|y|s|j|1|👍|✅|certo|claro|bien|ouais|klar|genau|natürlich|c'est ça|именно)/.test(lower);
        const no  = /^(no|nope|nein|non|cancel|nada|n|2|❌|👎|wrong|sbagliato|faux|falsch|annulla|cancelar|nein|pas ça)/.test(lower);
        if (yes) {
          merchantPending.delete(tenant.id);
          await executeMerchantAction(tenant, pending.action, pending.product, pending.params, pending.lang, phoneNumberId, token);
          return;
        }
        if (no) {
          merchantPending.delete(tenant.id);
          await sendMessage(tenant.merchant_phone, mt(pending.lang, 'canceled'), phoneNumberId, token);
          return;
        }
      }

      // Photo mode choice
      if (pending.action === 'photo_mode_choose') {
        const lower = txt.toLowerCase();
        const isReplace = /^(1|replace|sostituisci|remplacer|ersetzen|substituir|foto principal|principal|main|principale|hauptfoto|hauptbild)/.test(lower);
        const isAdd     = /^(2|add|aggiungi|ajouter|hinzufügen|adicionar|extra|agrega|extra foto|foto extra|additional)/.test(lower);
        if (isReplace || isAdd) {
          const mode = isReplace ? 'replace_main' : 'add_extra';
          if (mode === 'add_extra' && pending.extraCount >= 9) {
            const limit = { es:`⚠️ *${pending.productName}* ya tiene 9 fotos extra (máximo). Eliminá alguna desde el panel primero.`, it:`⚠️ *${pending.productName}* ha già 9 foto extra (massimo). Rimuovine una dal pannello prima.`, en:`⚠️ *${pending.productName}* already has 9 extra photos (max). Remove one from the panel first.`, fr:`⚠️ *${pending.productName}* a déjà 9 photos extra (max). Supprimez-en une depuis le panneau.`, de:`⚠️ *${pending.productName}* hat bereits 9 Zusatzfotos (Max). Entferne eines im Panel zuerst.`, pt:`⚠️ *${pending.productName}* já tem 9 fotos extras (máx). Remova uma no painel antes.` };
            merchantPending.delete(tenant.id);
            await sendMessage(tenant.merchant_phone, limit[pending.lang] || limit.es, phoneNumberId, token);
            return;
          }
          merchantPending.set(tenant.id, { action: 'photo_await_image', productId: pending.productId, productName: pending.productName, mode, extraCount: pending.extraCount, lang: pending.lang, expiresAt: Date.now() + 10 * 60 * 1000 });
          const send = { es:`📸 Perfecto. Ahora enviá la foto para *${pending.productName}*.`, it:`📸 Perfetto. Adesso inviami la foto per *${pending.productName}*.`, en:`📸 Perfect. Now send the photo for *${pending.productName}*.`, fr:`📸 Parfait. Envoyez maintenant la photo pour *${pending.productName}*.`, de:`📸 Perfekt. Schick jetzt das Foto für *${pending.productName}*.`, pt:`📸 Perfeito. Agora envie a foto para *${pending.productName}*.` };
          await sendMessage(tenant.merchant_phone, send[pending.lang] || send.es, phoneNumberId, token);
          return;
        }
        // Unrecognised reply — resend the options
        await askPhotoModeFromPending(tenant, pending, phoneNumberId, token);
        return;
      }

      // photo_await_image but merchant sent text instead of photo
      if (pending.action === 'photo_await_image') {
        const nudge = { es:`📸 Esperando la foto para *${pending.productName}*. Por favor, enviá una imagen.`, it:`📸 Aspetto la foto per *${pending.productName}*. Per favore invia un'immagine.`, en:`📸 Waiting for the photo for *${pending.productName}*. Please send an image.`, fr:`📸 J'attends la photo pour *${pending.productName}*. Veuillez envoyer une image.`, de:`📸 Warte auf das Foto für *${pending.productName}*. Bitte sende ein Bild.`, pt:`📸 Aguardando a foto para *${pending.productName}*. Por favor, envie uma imagem.` };
        await sendMessage(tenant.merchant_phone, nudge[pending.lang] || nudge.es, phoneNumberId, token);
        return;
      }

      // Not a recognizable confirmation — clear pending and treat as new command
      merchantPending.delete(tenant.id);
    }
  }

  // ── NL intent parsing ─────────────────────────────────────────────────────
  const [{ data: products }, { data: services }] = await Promise.all([
    supabase.from('products').select('id, name, stock_qty, price_guarani, is_available').eq('tenant_id', tenant.id),
    supabase.from('services').select('id, name, category, price_guarani, duration_min, price_type, is_available, description').eq('tenant_id', tenant.id),
  ]);

  const allProducts = products || [];
  const allServices = services || [];
  const intent = await parseMerchantIntent(messageText, allProducts, allServices, tenant);
  const lang = intent.language || 'es';

  // Save detected language for outbound notifications (e.g. new order alerts)
  if (lang !== 'es') merchantLang.set(tenant.id, lang);

  // ── Feature gate ──────────────────────────────────────────────────────────
  const gateErr = featureGate(tenant, intent.action, lang);
  if (gateErr) { await sendMessage(tenant.merchant_phone, gateErr, phoneNumberId, token); return; }

  // ── Catalog ───────────────────────────────────────────────────────────────
  if (intent.action === 'get_catalog') {
    if (!allProducts.length) {
      await sendMessage(tenant.merchant_phone, mt(lang, 'catalog_empty'), phoneNumberId, token);
      return;
    }
    const lines = allProducts.map(p => {
      const estado = !p.is_available ? '🔴' : p.stock_qty === 0 ? '🔴' : `🟢 ${p.stock_qty}`;
      return `• *${p.name}* — ${formatPrice(p.price_guarani, currency)} — ${estado}`;
    });
    await sendMessage(tenant.merchant_phone, `📦 *${allProducts.length} productos:*\n\n${lines.join('\n')}`, phoneNumberId, token);
    return;
  }

  // ── Photo update intent ───────────────────────────────────────────────────
  if (intent.action === 'photo_update') {
    const q = intent.product_query;
    if (!q) {
      const ask = { es:'¿Para qué producto querés actualizar la foto? Indicá el nombre.', it:'Per quale prodotto vuoi aggiornare la foto? Indica il nome.', en:'Which product do you want to update the photo for? Please specify the name.', fr:'Pour quel produit souhaitez-vous mettre à jour la photo? Indiquez le nom.', de:'Für welches Produkt möchtest du das Foto aktualisieren? Bitte den Namen angeben.', pt:'Para qual produto você quer atualizar a foto? Indique o nome.' };
      await sendMessage(tenant.merchant_phone, ask[lang] || ask.es, phoneNumberId, token);
      return;
    }
    const matches = findProductsFuzzy(allProducts, q);
    if (!matches.length) {
      const nf = { es:`⚠️ No encontré ningún producto para "${q}".`, it:`⚠️ Nessun prodotto trovato per "${q}".`, en:`⚠️ No product found for "${q}".`, fr:`⚠️ Aucun produit trouvé pour "${q}".`, de:`⚠️ Kein Produkt gefunden für "${q}".`, pt:`⚠️ Nenhum produto encontrado para "${q}".` };
      await sendMessage(tenant.merchant_phone, nf[lang] || nf.es, phoneNumberId, token);
      return;
    }
    if (matches.length === 1) {
      await askPhotoMode(tenant, matches[0], lang, phoneNumberId, token);
      return;
    }
    // Multiple matches — ask which one
    const list = matches.slice(0, 5).map((p, i) => `${i + 1}. ${p.name}`).join('\n');
    const which = { es:`Encontré varios productos:\n${list}\n¿Para cuál? Respondé con el número.`, it:`Ho trovato più prodotti:\n${list}\nPer quale? Rispondi con il numero.`, en:`Found several products:\n${list}\nWhich one? Reply with the number.`, fr:`J'ai trouvé plusieurs produits:\n${list}\nLequel? Répondez avec le numéro.`, de:`Mehrere Produkte gefunden:\n${list}\nWelches? Antworte mit der Nummer.`, pt:`Encontrei vários produtos:\n${list}\nQual deles? Responda com o número.` };
    merchantPending.set(tenant.id, { action: 'photo_update', candidates: matches.slice(0, 5), lang, expiresAt: Date.now() + 5 * 60 * 1000 });
    await sendMessage(tenant.merchant_phone, which[lang] || which.es, phoneNumberId, token);
    return;
  }

  // ── Order actions ─────────────────────────────────────────────────────────
  if (intent.action === 'chat_takeover') {
    const customerQuery = intent.params?.customer_query || null;
    if (customerQuery) {
      // Find conversation matching name or partial phone
      const { data: convs } = await supabase
        .from('conversations')
        .select('id, customer_phone, customer_name, last_pending_customer_phone, updated_at')
        .eq('tenant_id', tenant.id)
        .order('updated_at', { ascending: false })
        .limit(50);
      const q = customerQuery.toLowerCase();
      const matches = (convs || []).filter(c => {
        const name = (c.customer_name || '').toLowerCase();
        const phone = c.customer_phone || '';
        return name.includes(q) || phone.includes(q) || q.split(/\s+/).some(w => name.includes(w));
      });
      if (matches.length === 0) {
        const MT_NO_CUSTOMER = { es:`⚠️ No encontré cliente para "${customerQuery}".`, it:`⚠️ Nessun cliente trovato per "${customerQuery}".`, en:`⚠️ No customer found for "${customerQuery}".`, fr:`⚠️ Aucun client pour "${customerQuery}".`, de:`⚠️ Kein Kunde für "${customerQuery}" gefunden.`, pt:`⚠️ Nenhum cliente para "${customerQuery}".` };
        await sendMessage(tenant.merchant_phone, MT_NO_CUSTOMER[lang] || MT_NO_CUSTOMER.es, phoneNumberId, token);
        return;
      }
      if (matches.length === 1) {
        await activateTakeover(tenant, matches[0], lang, phoneNumberId, token);
        return;
      }
      // Multiple — ask which one
      const list = matches.slice(0, 5).map((c, i) => `${i + 1}. ${c.customer_name || '?'} (+${c.customer_phone})`).join('\n');
      const MT_WHICH = { es:`Varios clientes encontrados:\n${list}\n¿Con cuál? Respondé con el número.`, it:`Più clienti trovati:\n${list}\nCon quale? Rispondi con il numero.`, en:`Multiple customers found:\n${list}\nWhich one? Reply with the number.`, fr:`Plusieurs clients trouvés:\n${list}\nLequel? Répondez avec le numéro.`, de:`Mehrere Kunden gefunden:\n${list}\nWelcher? Antworte mit der Nummer.`, pt:`Vários clientes encontrados:\n${list}\nQual deles? Responda com o número.` };
      merchantPending.set(tenant.id, { action: 'chat_takeover', candidates: matches.slice(0, 5), lang, expiresAt: Date.now() + 5 * 60 * 1000 });
      await sendMessage(tenant.merchant_phone, MT_WHICH[lang] || MT_WHICH.es, phoneNumberId, token);
      return;
    }
    // No specific customer — pick most recent with pending order
    const { data: conv } = await supabase
      .from('conversations').select('*').eq('tenant_id', tenant.id)
      .not('last_pending_order_id', 'is', null)
      .order('updated_at', { ascending: false }).limit(1).maybeSingle();
    if (!conv) { await sendMessage(tenant.merchant_phone, mt(lang, 'no_active_conv'), phoneNumberId, token); return; }
    await activateTakeover(tenant, conv, lang, phoneNumberId, token);
    return;
  }

  if (intent.action === 'get_orders') {
    const { data: orders } = await supabase
      .from('orders').select('id, customer_phone, items_json, total_guarani, delivery_fee, status, created_at')
      .eq('tenant_id', tenant.id).in('status', ['pending','confirmed','preparing','delivering'])
      .order('created_at', { ascending: false }).limit(10);
    if (!orders?.length) { await sendMessage(tenant.merchant_phone, mt(lang, 'orders_none'), phoneNumberId, token); return; }
    const STATUS_ICON = { pending:'🟡', confirmed:'✅', preparing:'🔧', delivering:'🚚', delivered:'✔️' };
    const lines = orders.map(o => {
      const id = o.id.substring(0,8).toUpperCase();
      const total = formatPrice(o.total_guarani + (o.delivery_fee||0), currency);
      const icon = STATUS_ICON[o.status] || '•';
      const phone = o.customer_phone;
      const names = (o.items_json||[]).map(i=>`${i.name} x${i.qty}`).join(', ');
      return `${icon} *#${id}* +${phone}\n   ${names} — ${total}`;
    });
    const HDR = { es:`📋 *Pedidos activos (${orders.length}):*`, it:`📋 *Ordini attivi (${orders.length}):*`, en:`📋 *Active orders (${orders.length}):*`, fr:`📋 *Commandes actives (${orders.length}):*`, de:`📋 *Aktive Bestellungen (${orders.length}):*`, pt:`📋 *Pedidos ativos (${orders.length}):*` };
    await sendMessage(tenant.merchant_phone, `${HDR[lang]||HDR.es}\n\n${lines.join('\n\n')}`, phoneNumberId, token);
    return;
  }

  if (intent.action === 'update_order_status') {
    const { customer_query, status } = intent.params || {};
    const validStatuses = ['preparing','delivering','delivered'];
    if (!status || !validStatuses.includes(status)) { await sendMessage(tenant.merchant_phone, mt(lang, 'unknown'), phoneNumberId, token); return; }
    let q = supabase.from('orders').select('id, customer_phone, status').eq('tenant_id', tenant.id).in('status', ['pending','confirmed','preparing','delivering']);
    if (customer_query) q = q.ilike('customer_phone', `%${customer_query}%`);
    const { data: orders } = await q.order('created_at', { ascending: false }).limit(5);
    if (!orders?.length) { await sendMessage(tenant.merchant_phone, mt(lang, 'order_not_found'), phoneNumberId, token); return; }
    if (orders.length === 1) {
      await supabase.from('orders').update({ status }).eq('id', orders[0].id);
      await sendMessage(tenant.merchant_phone, mt(lang, 'order_status_upd', orders[0].id.substring(0,8).toUpperCase(), status), phoneNumberId, token);
      await notifyCustomerOrderStatus(orders[0], status, phoneNumberId, token, tenant);
      return;
    }
    const list = orders.map((o,i) => `${i+1}. *#${o.id.substring(0,8).toUpperCase()}* +${o.customer_phone} (${o.status})`).join('\n');
    const WH = { es:`Varios pedidos:\n${list}\n¿Cuál marcar como ${status}?`, it:`Più ordini:\n${list}\nQuale segnare come ${status}?`, en:`Multiple orders:\n${list}\nWhich to mark as ${status}?`, fr:`Plusieurs commandes:\n${list}\nLaquelle marquer comme ${status}?`, de:`Mehrere Bestellungen:\n${list}\nWelche als ${status} markieren?`, pt:`Vários pedidos:\n${list}\nQual marcar como ${status}?` };
    merchantPending.set(tenant.id, { action: 'update_order_status', candidates: orders, params: { status }, lang, expiresAt: Date.now() + 5 * 60 * 1000 });
    await sendMessage(tenant.merchant_phone, WH[lang]||WH.es, phoneNumberId, token);
    return;
  }

  if (intent.action === 'confirm_order' || intent.action === 'cancel_order') {
    const { data: convs } = await supabase
      .from('conversations').select('*').eq('tenant_id', tenant.id)
      .not('last_pending_order_id', 'is', null)
      .order('updated_at', { ascending: false }).limit(5);
    if (!convs?.length) { await sendMessage(tenant.merchant_phone, mt(lang, 'no_pending_order'), phoneNumberId, token); return; }
    if (convs.length === 1) {
      if (intent.action === 'confirm_order') { await confirmOrder(tenant, convs[0], phoneNumberId, token); return; }
      await cancelOrder(tenant, convs[0], phoneNumberId, token); return;
    }
    // Multiple pending — list them
    const list = convs.map((c,i) => `${i+1}. +${c.last_pending_customer_phone||c.customer_phone}`).join('\n');
    const WH = { es:`Varios pedidos pendientes:\n${list}\n¿Cuál?`, it:`Più ordini in attesa:\n${list}\nQuale?`, en:`Multiple pending orders:\n${list}\nWhich one?`, fr:`Plusieurs commandes en attente:\n${list}\nLaquelle?`, de:`Mehrere ausstehende Bestellungen:\n${list}\nWelche?`, pt:`Vários pedidos pendentes:\n${list}\nQual?` };
    merchantPending.set(tenant.id, { action: intent.action, candidates: convs, lang, expiresAt: Date.now() + 5 * 60 * 1000 });
    await sendMessage(tenant.merchant_phone, WH[lang]||WH.es, phoneNumberId, token);
    return;
  }

  // ── Add product ───────────────────────────────────────────────────────────
  if (intent.action === 'add_product') {
    const { name, category, price, stock, description } = intent.params;
    if (!name) {
      const ask = { es:'¿Cómo se llama el producto que querés agregar?', it:'Come si chiama il prodotto che vuoi aggiungere?', en:'What is the name of the product you want to add?', fr:'Quel est le nom du produit à ajouter?', de:'Wie heißt das Produkt, das du hinzufügen möchtest?', pt:'Qual é o nome do produto que deseja adicionar?' };
      await sendMessage(tenant.merchant_phone, ask[lang] || ask.es, phoneNumberId, token); return;
    }
    await supabase.from('products').insert({
      tenant_id: tenant.id,
      name, category: category || 'General',
      price_guarani: price || 0,
      stock_qty: stock || 0,
      description: description || null,
      is_available: (stock || 0) > 0,
    });
    invalidateStock(tenant.id);
    await sendMessage(tenant.merchant_phone, mt(lang, 'product_added', name), phoneNumberId, token);
    return;
  }

  // ── Name customer ─────────────────────────────────────────────────────────
  if (intent.action === 'name_customer') {
    const { phone, name } = intent.params;
    if (!phone || !name) { await sendMessage(tenant.merchant_phone, mt(lang, 'unknown'), phoneNumberId, token); return; }
    await supabase.from('conversations').update({ customer_name: name }).eq('tenant_id', tenant.id).eq('customer_phone', phone);
    await sendMessage(tenant.merchant_phone, mt(lang, 'customer_named', phone, name), phoneNumberId, token);
    return;
  }

  // ── Appointments ──────────────────────────────────────────────────────────
  if (intent.action === 'get_appointments') {
    const from = intent.params?.from || new Date().toISOString();
    const to = intent.params?.to || new Date(Date.now() + 7 * 86400000).toISOString();
    let q = supabase.from('appointments').select('customer_name, customer_phone, start_at, end_at, status, notes')
      .eq('tenant_id', tenant.id).gte('start_at', from).lte('start_at', to).neq('status', 'cancelled').order('start_at');
    const { data: appts } = await q;
    if (!appts?.length) { await sendMessage(tenant.merchant_phone, mt(lang, 'appt_none'), phoneNumberId, token); return; }
    const lines = appts.map(a => {
      const dt = new Date(a.start_at).toLocaleString('es-PY', { weekday:'short', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
      return `📌 *${a.customer_name || a.customer_phone}* — ${dt}${a.notes ? `\n   📝 ${a.notes}` : ''}`;
    });
    await sendMessage(tenant.merchant_phone, `${mt(lang, 'appt_list_header', appts.length)}\n\n${lines.join('\n\n')}`, phoneNumberId, token);
    return;
  }

  if (intent.action === 'add_appointment') {
    const params = intent.params || {};
    const missing = missingApptFieldsMsg(params, lang);
    if (missing) {
      merchantPending.set(tenant.id, { type: 'awaiting_fields', action: 'add_appointment', params, services: allServices, lang, expiresAt: Date.now() + 10 * 60 * 1000 });
      await sendMessage(tenant.merchant_phone, missing, phoneNumberId, token);
      return;
    }
    await completeAddAppointment(tenant, params, allServices, lang, phoneNumberId, token);
    return;
  }

  if (intent.action === 'cancel_appointment') {
    const { customer_query, start_at } = intent.params || {};
    let q = supabase.from('appointments').select('id, customer_name, customer_phone, start_at').eq('tenant_id', tenant.id).neq('status', 'cancelled');
    if (start_at) q = q.gte('start_at', start_at).lte('start_at', new Date(new Date(start_at).getTime() + 3600000).toISOString());
    if (customer_query) q = q.ilike('customer_name', `%${customer_query}%`);
    const { data: appts } = await q.order('start_at').limit(5);
    if (!appts?.length) { await sendMessage(tenant.merchant_phone, mt(lang, 'appt_not_found'), phoneNumberId, token); return; }
    if (appts.length > 1) {
      const list = appts.map((a, i) => { const dt = new Date(a.start_at).toLocaleString('es-PY', { weekday:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }); return `${i+1}. *${a.customer_name || a.customer_phone}* — ${dt}`; }).join('\n');
      merchantPending.set(tenant.id, { action: 'cancel_appointment', candidates: appts, lang, expiresAt: Date.now() + 5 * 60 * 1000 });
      const MT_WHICH_APPT = { es:`Varias citas:\n${list}\n¿Cuál cancelar?`, it:`Più appuntamenti:\n${list}\nQuale annullare?`, en:`Multiple appointments:\n${list}\nWhich to cancel?`, fr:`Plusieurs rendez-vous:\n${list}\nLequel annuler?`, de:`Mehrere Termine:\n${list}\nWelchen stornieren?`, pt:`Várias consultas:\n${list}\nQual cancelar?` };
      await sendMessage(tenant.merchant_phone, MT_WHICH_APPT[lang] || MT_WHICH_APPT.es, phoneNumberId, token);
      return;
    }
    await supabase.from('appointments').update({ status: 'cancelled' }).eq('id', appts[0].id);
    const dt = new Date(appts[0].start_at).toLocaleString('es-PY', { weekday:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
    await sendMessage(tenant.merchant_phone, mt(lang, 'appt_cancelled', appts[0].customer_name || appts[0].customer_phone, dt), phoneNumberId, token);
    return;
  }

  if (intent.action === 'reschedule_appointment') {
    const { customer_query, current_start, new_start } = intent.params || {};
    if (!new_start) { await sendMessage(tenant.merchant_phone, mt(lang, 'unknown'), phoneNumberId, token); return; }
    let q = supabase.from('appointments').select('id, customer_name, customer_phone, start_at, end_at').eq('tenant_id', tenant.id).neq('status', 'cancelled');
    if (current_start) q = q.gte('start_at', current_start).lte('start_at', new Date(new Date(current_start).getTime() + 3600000).toISOString());
    if (customer_query) q = q.ilike('customer_name', `%${customer_query}%`);
    const { data: appts } = await q.order('start_at').limit(5);
    if (!appts?.length) { await sendMessage(tenant.merchant_phone, mt(lang, 'appt_not_found'), phoneNumberId, token); return; }
    const appt = appts[0];
    const durationMs = new Date(appt.end_at) - new Date(appt.start_at);
    const new_end = new Date(new Date(new_start).getTime() + durationMs).toISOString();
    const slotCheck = await checkSlotAvailability(tenant.id, new_start, new_end, tenant.appointment_capacity);
    if (!slotCheck.available) { await sendMessage(tenant.merchant_phone, slotConflictMessage(slotCheck, lang), phoneNumberId, token); return; }
    await supabase.from('appointments').update({ start_at: new_start, end_at: new_end }).eq('id', appt.id);
    const dt = new Date(new_start).toLocaleString('es-PY', { weekday:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
    await sendMessage(tenant.merchant_phone, mt(lang, 'appt_rescheduled', appt.customer_name || appt.customer_phone, dt), phoneNumberId, token);
    return;
  }

  if (intent.action === 'block_time') {
    const { start_at, reason } = intent.params || {};
    let { end_at } = intent.params || {};
    if (!start_at) { await sendMessage(tenant.merchant_phone, mt(lang, 'block_missing'), phoneNumberId, token); return; }
    // Default end_at to end of day if not specified
    if (!end_at) {
      const d = new Date(start_at); d.setHours(23, 59, 59, 0);
      end_at = d.toISOString();
    }
    await supabase.from('appointment_blocks').insert({ tenant_id: tenant.id, start_at, end_at, reason: reason || null });
    const s = new Date(start_at).toLocaleString('es-PY', { weekday:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
    const e = new Date(end_at).toLocaleString('es-PY', { weekday:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
    await sendMessage(tenant.merchant_phone, mt(lang, 'block_added', s, e), phoneNumberId, token);
    return;
  }

  if (intent.action === 'unblock_time') {
    const { start_at, reason_query } = intent.params || {};
    let q = supabase.from('appointment_blocks').select('id, start_at, end_at, reason').eq('tenant_id', tenant.id);
    if (start_at) q = q.gte('start_at', start_at).lte('start_at', new Date(new Date(start_at).getTime() + 86400000).toISOString());
    if (reason_query) q = q.ilike('reason', `%${reason_query}%`);
    const { data: blocks } = await q.order('start_at').limit(1);
    if (!blocks?.length) { await sendMessage(tenant.merchant_phone, mt(lang, 'block_not_found'), phoneNumberId, token); return; }
    await supabase.from('appointment_blocks').delete().eq('id', blocks[0].id);
    await sendMessage(tenant.merchant_phone, mt(lang, 'block_removed'), phoneNumberId, token);
    return;
  }

  if (intent.action === 'create_closure') {
    const { start_date, end_date, label } = intent.params || {};
    if (!start_date || !end_date) {
      await sendMessage(tenant.merchant_phone, mt(lang, 'closure_missing'), phoneNumberId, token);
      return;
    }
    await supabase.from('business_closures').insert({ tenant_id: tenant.id, start_date, end_date, label: label || null });
    invalidateClosures(tenant.id);
    const labelStr = label ? ` — ${label}` : '';
    await sendMessage(tenant.merchant_phone, mt(lang, 'closure_added', start_date, end_date, labelStr), phoneNumberId, token);
    return;
  }

  if (intent.action === 'delete_closure') {
    const { label_query, start_date } = intent.params || {};
    let q = supabase.from('business_closures').select('id,start_date,end_date,label').eq('tenant_id', tenant.id);
    if (start_date) q = q.lte('start_date', start_date).gte('end_date', start_date);
    if (label_query) q = q.ilike('label', `%${label_query}%`);
    const { data: found } = await q.order('start_date').limit(1);
    if (!found?.length) { await sendMessage(tenant.merchant_phone, mt(lang, 'closure_not_found'), phoneNumberId, token); return; }
    await supabase.from('business_closures').delete().eq('id', found[0].id);
    invalidateClosures(tenant.id);
    await sendMessage(tenant.merchant_phone, mt(lang, 'closure_removed', found[0].label || found[0].start_date), phoneNumberId, token);
    return;
  }

  if (intent.action === 'create_offer') {
    const { label, discount_type, discount_value, scope, scope_target, valid_from, valid_to } = intent.params || {};
    if (!label || !discount_type || discount_value == null || !scope) {
      await sendMessage(tenant.merchant_phone, mt(lang, 'offer_missing'), phoneNumberId, token);
      return;
    }
    await supabase.from('offers').insert({
      tenant_id: tenant.id, label, discount_type,
      discount_value: parseFloat(discount_value),
      scope, scope_target: scope_target || null,
      valid_from: valid_from || null, valid_to: valid_to || null,
      is_active: true,
    });
    invalidateOffers(tenant.id);
    const scopeStr = scope_target ? ` (${scope_target})` : '';
    const discStr = discount_type === 'percent' ? `${discount_value}%` : `${discount_value}`;
    const dateStr = valid_to ? ` → hasta ${valid_to}` : '';
    await sendMessage(tenant.merchant_phone, mt(lang, 'offer_added', label, discStr, scopeStr, dateStr), phoneNumberId, token);
    return;
  }

  if (intent.action === 'delete_offer') {
    const { label_query } = intent.params || {};
    let q = supabase.from('offers').select('id,label').eq('tenant_id', tenant.id);
    if (label_query) q = q.ilike('label', `%${label_query}%`);
    const { data: found } = await q.limit(1);
    if (!found?.length) { await sendMessage(tenant.merchant_phone, mt(lang, 'offer_not_found'), phoneNumberId, token); return; }
    await supabase.from('offers').delete().eq('id', found[0].id);
    invalidateOffers(tenant.id);
    await sendMessage(tenant.merchant_phone, mt(lang, 'offer_removed', found[0].label), phoneNumberId, token);
    return;
  }

  // ── Services ──────────────────────────────────────────────────────────────
  if (intent.action === 'get_services') {
    if (!allServices.length) { await sendMessage(tenant.merchant_phone, mt(lang, 'svc_none'), phoneNumberId, token); return; }
    const lines = allServices.map(s => {
      const price = s.price_type === 'hourly' ? `${formatPrice(s.price_guarani, currency)}/h` : formatPrice(s.price_guarani, currency);
      const dur = s.duration_min ? ` · ${s.duration_min}min` : '';
      const avail = s.is_available ? '🟢' : '🔴';
      return `${avail} *${s.name}*${s.category ? ` [${s.category}]` : ''} — ${price}${dur}`;
    });
    await sendMessage(tenant.merchant_phone, `${mt(lang, 'svc_list_header', allServices.length)}\n\n${lines.join('\n')}`, phoneNumberId, token);
    return;
  }

  if (intent.action === 'add_service') {
    const { name, category, price, duration_min, price_type } = intent.params || {};
    if (!name) { await sendMessage(tenant.merchant_phone, mt(lang, 'unknown'), phoneNumberId, token); return; }
    await supabase.from('services').insert({
      tenant_id: tenant.id,
      name, category: category || null,
      price_guarani: price || 0,
      duration_min: duration_min || null,
      price_type: price_type || 'fixed',
      is_available: true,
    });
    invalidateServices(tenant.id);
    await sendMessage(tenant.merchant_phone, mt(lang, 'svc_added', name), phoneNumberId, token);
    return;
  }

  if (intent.action === 'update_service') {
    const sQuery = intent.service_query;
    if (!sQuery) { await sendMessage(tenant.merchant_phone, mt(lang, 'unknown'), phoneNumberId, token); return; }
    const sMatches = allServices.filter(s => s.name.toLowerCase().includes(sQuery.toLowerCase()));
    if (!sMatches.length) { await sendMessage(tenant.merchant_phone, mt(lang, 'svc_not_found', sQuery), phoneNumberId, token); return; }
    const updates = {};
    const u = intent.params?.updates || {};
    for (const f of ['price_guarani','duration_min','is_available','name','category','description']) {
      if (u[f] != null) updates[f] = u[f];
    }
    if (!Object.keys(updates).length) { await sendMessage(tenant.merchant_phone, mt(lang, 'unknown'), phoneNumberId, token); return; }
    if (sMatches.length === 1) {
      await supabase.from('services').update(updates).eq('id', sMatches[0].id);
      invalidateServices(tenant.id);
      await sendMessage(tenant.merchant_phone, mt(lang, 'svc_updated', sMatches[0].name), phoneNumberId, token);
      return;
    }
    // Multiple — ask which
    const list = sMatches.slice(0, 5).map((s, i) => `${i+1}. *${s.name}*`).join('\n');
    merchantPending.set(tenant.id, { action: 'update_service', candidates: sMatches.slice(0, 5), params: { updates }, lang, expiresAt: Date.now() + 5 * 60 * 1000 });
    const MT_WHICH_SVC = { es:`Varios servicios:\n${list}\n¿Cuál actualizar?`, it:`Più servizi:\n${list}\nQuale aggiornare?`, en:`Multiple services:\n${list}\nWhich to update?`, fr:`Plusieurs services:\n${list}\nLequel mettre à jour?`, de:`Mehrere Dienste:\n${list}\nWelchen aktualisieren?`, pt:`Vários serviços:\n${list}\nQual atualizar?` };
    await sendMessage(tenant.merchant_phone, MT_WHICH_SVC[lang] || MT_WHICH_SVC.es, phoneNumberId, token);
    return;
  }

  // ── Restaurant reservations ───────────────────────────────────────────────
  if (intent.action === 'get_reservations') {
    const from = intent.params?.from || new Date().toISOString();
    const to   = intent.params?.to   || new Date(Date.now() + 7 * 86400000).toISOString();
    let q = supabase.from('reservations')
      .select('customer_name, customer_phone, party_size, reserved_at, status, notes, zone_id')
      .eq('tenant_id', tenant.id)
      .neq('status', 'cancelled')
      .gte('reserved_at', from)
      .lte('reserved_at', to)
      .order('reserved_at');
    if (intent.params?.customer_query) q = q.ilike('customer_name', `%${intent.params.customer_query}%`);
    const { data: res } = await q;
    if (!res?.length) {
      const none = { es:'📅 No hay reservas en ese período.', it:'📅 Nessuna prenotazione in quel periodo.', en:'📅 No reservations in that period.', fr:'📅 Aucune réservation sur cette période.', de:'📅 Keine Reservierungen in diesem Zeitraum.', pt:'📅 Nenhuma reserva nesse período.' };
      await sendMessage(tenant.merchant_phone, none[lang] || none.es, phoneNumberId, token); return;
    }
    const lines = res.map(r => {
      const dt = new Date(r.reserved_at).toLocaleString('es', { weekday:'short', day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' });
      const pending = r.status === 'pending_merchant' ? ' ⚠️' : '';
      return `• *${r.customer_name || r.customer_phone}* — ${r.party_size} pers. — ${dt}${pending}${r.notes ? `\n  📝 ${r.notes}` : ''}`;
    });
    const hdr = { es:`📋 *${res.length} reservas:*\n\n`, it:`📋 *${res.length} prenotazioni:*\n\n`, en:`📋 *${res.length} reservations:*\n\n`, fr:`📋 *${res.length} réservations:*\n\n`, de:`📋 *${res.length} Reservierungen:*\n\n`, pt:`📋 *${res.length} reservas:*\n\n` };
    await sendMessage(tenant.merchant_phone, (hdr[lang] || hdr.es) + lines.join('\n'), phoneNumberId, token);
    return;
  }

  if (intent.action === 'block_tables') {
    const params = intent.params || {};
    const missing = missingTableFieldsMsg(params, lang, 'block_tables');
    if (missing) {
      merchantPending.set(tenant.id, { type: 'awaiting_fields', action: 'block_tables', params, lang, expiresAt: Date.now() + 10 * 60 * 1000 });
      await sendMessage(tenant.merchant_phone, missing, phoneNumberId, token);
      return;
    }
    await completeBookTable(tenant, params, lang, phoneNumberId, token);
    return;
  }

  if (intent.action === 'book_table') {
    const params = intent.params || {};
    const missing = missingTableFieldsMsg(params, lang, 'book_table');
    if (missing) {
      merchantPending.set(tenant.id, { type: 'awaiting_fields', action: 'book_table', params, lang, expiresAt: Date.now() + 10 * 60 * 1000 });
      await sendMessage(tenant.merchant_phone, missing, phoneNumberId, token);
      return;
    }
    await completeBookTable(tenant, params, lang, phoneNumberId, token);
    return;
  }

  if (intent.action === 'cancel_reservation') {
    const { customer_query, date } = intent.params || {};
    let q = supabase.from('reservations').select('id, customer_name, reserved_at').eq('tenant_id', tenant.id).neq('status', 'cancelled');
    if (customer_query) q = q.ilike('customer_name', `%${customer_query}%`);
    if (date) q = q.gte('reserved_at', `${date}T00:00:00`).lte('reserved_at', `${date}T23:59:59`);
    const { data: matches } = await q.order('reserved_at').limit(10);
    if (!matches?.length) {
      const none = { es:'⚠️ No encontré esa reserva.', it:'⚠️ Prenotazione non trovata.', en:'⚠️ Reservation not found.', fr:'⚠️ Réservation introuvable.', de:'⚠️ Reservierung nicht gefunden.', pt:'⚠️ Reserva não encontrada.' };
      await sendMessage(tenant.merchant_phone, none[lang] || none.es, phoneNumberId, token); return;
    }
    if (matches.length === 1) {
      await supabase.from('reservations').update({ status: 'cancelled' }).eq('id', matches[0].id);
      const dt = new Date(matches[0].reserved_at).toLocaleString('es', { weekday:'short', day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' });
      const ok = { es:`❌ Reserva de *${matches[0].customer_name}* (${dt}) cancelada.`, it:`❌ Prenotazione di *${matches[0].customer_name}* (${dt}) annullata.`, en:`❌ Reservation for *${matches[0].customer_name}* (${dt}) cancelled.`, fr:`❌ Réservation de *${matches[0].customer_name}* (${dt}) annulée.`, de:`❌ Reservierung von *${matches[0].customer_name}* (${dt}) storniert.`, pt:`❌ Reserva de *${matches[0].customer_name}* (${dt}) cancelada.` };
      await sendMessage(tenant.merchant_phone, ok[lang] || ok.es, phoneNumberId, token); return;
    }
    const list = matches.slice(0,5).map((r,i) => { const dt = new Date(r.reserved_at).toLocaleString('es',{weekday:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}); return `${i+1}. *${r.customer_name}* — ${dt}`; }).join('\n');
    merchantPending.set(tenant.id, { action: 'cancel_reservation', candidates: matches.slice(0,5), lang, expiresAt: Date.now() + 5*60*1000 });
    const which = { es:`Varias reservas:\n${list}\n¿Cuál cancelar?`, it:`Più prenotazioni:\n${list}\nQuale annullare?`, en:`Multiple reservations:\n${list}\nWhich to cancel?`, fr:`Plusieurs réservations:\n${list}\nLaquelle annuler?`, de:`Mehrere Reservierungen:\n${list}\nWelche stornieren?`, pt:`Várias reservas:\n${list}\nQual cancelar?` };
    await sendMessage(tenant.merchant_phone, which[lang] || which.es, phoneNumberId, token);
    return;
  }

  if (intent.action === 'confirm_reservation') {
    const { customer_query, date } = intent.params || {};
    let q = supabase.from('reservations').select('id, customer_name, reserved_at').eq('tenant_id', tenant.id).eq('status', 'pending_merchant');
    if (customer_query) q = q.ilike('customer_name', `%${customer_query}%`);
    if (date) q = q.gte('reserved_at', `${date}T00:00:00`).lte('reserved_at', `${date}T23:59:59`);
    const { data: matches } = await q.order('reserved_at').limit(10);
    if (!matches?.length) {
      const none = { es:'⚠️ No hay reservas pendientes que confirmar.', it:'⚠️ Nessuna prenotazione in attesa da confermare.', en:'⚠️ No pending reservations to confirm.', fr:'⚠️ Aucune réservation en attente à confirmer.', de:'⚠️ Keine ausstehenden Reservierungen zu bestätigen.', pt:'⚠️ Nenhuma reserva pendente para confirmar.' };
      await sendMessage(tenant.merchant_phone, none[lang] || none.es, phoneNumberId, token); return;
    }
    if (matches.length === 1) {
      await supabase.from('reservations').update({ status: 'confirmed' }).eq('id', matches[0].id);
      const dt = new Date(matches[0].reserved_at).toLocaleString('es', { weekday:'short', day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' });
      const ok = { es:`✅ Reserva de *${matches[0].customer_name}* (${dt}) confirmada.`, it:`✅ Prenotazione di *${matches[0].customer_name}* (${dt}) confermata.`, en:`✅ Reservation for *${matches[0].customer_name}* (${dt}) confirmed.`, fr:`✅ Réservation de *${matches[0].customer_name}* (${dt}) confirmée.`, de:`✅ Reservierung von *${matches[0].customer_name}* (${dt}) bestätigt.`, pt:`✅ Reserva de *${matches[0].customer_name}* (${dt}) confirmada.` };
      await sendMessage(tenant.merchant_phone, ok[lang] || ok.es, phoneNumberId, token); return;
    }
    const list = matches.slice(0,5).map((r,i) => { const dt = new Date(r.reserved_at).toLocaleString('es',{weekday:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}); return `${i+1}. *${r.customer_name}* — ${dt}`; }).join('\n');
    merchantPending.set(tenant.id, { action: 'confirm_reservation', candidates: matches.slice(0,5), lang, expiresAt: Date.now() + 5*60*1000 });
    const which = { es:`Varias reservas pendientes:\n${list}\n¿Cuál confirmar?`, it:`Più prenotazioni in attesa:\n${list}\nQuale confermare?`, en:`Multiple pending reservations:\n${list}\nWhich to confirm?`, fr:`Plusieurs réservations en attente:\n${list}\nLaquelle confirmer?`, de:`Mehrere ausstehende Reservierungen:\n${list}\nWelche bestätigen?`, pt:`Várias reservas pendentes:\n${list}\nQual confirmar?` };
    await sendMessage(tenant.merchant_phone, which[lang] || which.es, phoneNumberId, token);
    return;
  }

  // ── Stats / Analytics ─────────────────────────────────────────────────────
  if (intent.action === 'get_stats') {
    const period = intent.params?.period || 'week';
    const metric = intent.params?.metric || 'all';
    const now = new Date();
    let fromDate;
    if (period === 'today') {
      fromDate = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    } else if (period === 'week') {
      const day = now.getDay() || 7;
      fromDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day + 1).toISOString();
    } else if (period === 'month') {
      fromDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    } else {
      fromDate = '2000-01-01T00:00:00Z';
    }

    const [{ data: ordersData }, { data: apptData }, { data: resData }] = await Promise.all([
      supabase.from('orders').select('id, total_guarani, customer_phone, status, created_at')
        .eq('tenant_id', tenant.id).gte('created_at', fromDate),
      tenant.appointments_enabled && !tenant.restaurant_enabled
        ? supabase.from('appointments').select('id, customer_phone, status, created_at').eq('tenant_id', tenant.id).gte('created_at', fromDate).neq('status', 'cancelled')
        : { data: null },
      tenant.restaurant_enabled
        ? supabase.from('reservations').select('id, party_size, status, reserved_at').eq('tenant_id', tenant.id).gte('reserved_at', fromDate).neq('status', 'cancelled')
        : { data: null },
    ]);

    const orders = ordersData || [];
    const currency = tenant.plan_currency || 'PYG';
    const totalRevenue = orders.reduce((s, o) => s + (o.total_guarani || 0), 0);
    const uniqueCustomers = new Set(orders.map(o => o.customer_phone)).size;
    const completedOrders = orders.filter(o => o.status === 'delivered').length;
    const activeOrders    = orders.filter(o => ['pending','confirmed','preparing','delivering'].includes(o.status)).length;

    const periodLabel = { today: { es:'hoy', it:'oggi', en:'today', fr:'aujourd\'hui', de:'heute', pt:'hoje' }, week: { es:'esta semana', it:'questa settimana', en:'this week', fr:'cette semaine', de:'diese Woche', pt:'esta semana' }, month: { es:'este mes', it:'questo mese', en:'this month', fr:'ce mois', de:'diesen Monat', pt:'este mês' }, all: { es:'total', it:'totale', en:'total', fr:'total', de:'gesamt', pt:'total' } };
    const plabel = (periodLabel[period] || periodLabel.week)[lang] || (periodLabel[period] || periodLabel.week).es;

    let lines = [`📊 *Estadísticas ${plabel}:*`];
    if (lang === 'it') lines = [`📊 *Statistiche ${plabel}:*`];
    else if (lang === 'en') lines = [`📊 *Stats ${plabel}:*`];
    else if (lang === 'fr') lines = [`📊 *Statistiques ${plabel}:*`];
    else if (lang === 'de') lines = [`📊 *Statistiken ${plabel}:*`];
    else if (lang === 'pt') lines = [`📊 *Estatísticas ${plabel}:*`];

    if (orders.length || metric === 'orders' || metric === 'all') {
      const lbl = { es:`🛒 Pedidos: *${orders.length}* (${completedOrders} entregados, ${activeOrders} activos)`, it:`🛒 Ordini: *${orders.length}* (${completedOrders} consegnati, ${activeOrders} attivi)`, en:`🛒 Orders: *${orders.length}* (${completedOrders} delivered, ${activeOrders} active)`, fr:`🛒 Commandes: *${orders.length}* (${completedOrders} livrées, ${activeOrders} actives)`, de:`🛒 Bestellungen: *${orders.length}* (${completedOrders} geliefert, ${activeOrders} aktiv)`, pt:`🛒 Pedidos: *${orders.length}* (${completedOrders} entregues, ${activeOrders} ativos)` };
      lines.push(lbl[lang] || lbl.es);
    }
    if ((metric === 'revenue' || metric === 'all') && orders.length) {
      const lbl = { es:`💰 Ingresos: *${formatPrice(totalRevenue, currency)}*`, it:`💰 Ricavi: *${formatPrice(totalRevenue, currency)}*`, en:`💰 Revenue: *${formatPrice(totalRevenue, currency)}*`, fr:`💰 Chiffre d'affaires: *${formatPrice(totalRevenue, currency)}*`, de:`💰 Einnahmen: *${formatPrice(totalRevenue, currency)}*`, pt:`💰 Receita: *${formatPrice(totalRevenue, currency)}*` };
      lines.push(lbl[lang] || lbl.es);
    }
    if (metric === 'customers' || metric === 'all') {
      const lbl = { es:`👥 Clientes únicos: *${uniqueCustomers}*`, it:`👥 Clienti unici: *${uniqueCustomers}*`, en:`👥 Unique customers: *${uniqueCustomers}*`, fr:`👥 Clients uniques: *${uniqueCustomers}*`, de:`👥 Einzigartige Kunden: *${uniqueCustomers}*`, pt:`👥 Clientes únicos: *${uniqueCustomers}*` };
      lines.push(lbl[lang] || lbl.es);
    }
    if (apptData?.length) {
      const lbl = { es:`📆 Citas: *${apptData.length}*`, it:`📆 Appuntamenti: *${apptData.length}*`, en:`📆 Appointments: *${apptData.length}*`, fr:`📆 Rendez-vous: *${apptData.length}*`, de:`📆 Termine: *${apptData.length}*`, pt:`📆 Agendamentos: *${apptData.length}*` };
      lines.push(lbl[lang] || lbl.es);
    }
    if (resData?.length) {
      const covers = resData.reduce((s, r) => s + (r.party_size || 0), 0);
      const lbl = { es:`🍽️ Reservas: *${resData.length}* (${covers} cubiertos)`, it:`🍽️ Prenotazioni: *${resData.length}* (${covers} coperti)`, en:`🍽️ Reservations: *${resData.length}* (${covers} covers)`, fr:`🍽️ Réservations: *${resData.length}* (${covers} couverts)`, de:`🍽️ Reservierungen: *${resData.length}* (${covers} Gedecke)`, pt:`🍽️ Reservas: *${resData.length}* (${covers} cobertos)` };
      lines.push(lbl[lang] || lbl.es);
    }
    await sendMessage(tenant.merchant_phone, lines.join('\n'), phoneNumberId, token);
    return;
  }

  // ── Delete product ────────────────────────────────────────────────────────
  if (intent.action === 'delete_product') {
    if (!intent.product_query) { await sendMessage(tenant.merchant_phone, mt(lang, 'unknown'), phoneNumberId, token); return; }
    const matches = findProductsFuzzy(allProducts, intent.product_query);
    if (!matches.length) {
      const none = { es:`⚠️ No encontré el producto "${intent.product_query}".`, it:`⚠️ Prodotto "${intent.product_query}" non trovato.`, en:`⚠️ Product "${intent.product_query}" not found.`, fr:`⚠️ Produit "${intent.product_query}" introuvable.`, de:`⚠️ Produkt "${intent.product_query}" nicht gefunden.`, pt:`⚠️ Produto "${intent.product_query}" não encontrado.` };
      await sendMessage(tenant.merchant_phone, none[lang] || none.es, phoneNumberId, token); return;
    }
    const dpCandidates = matches.slice(0, 5);
    merchantPending.set(tenant.id, { action: 'delete_product', candidates: dpCandidates, lang, expiresAt: Date.now() + 5*60*1000 });
    if (matches.length === 1) {
      const confirm = { es:`¿Seguro que querés eliminar *${matches[0].name}*? Respondé *sí* para confirmar.`, it:`Sicuro di voler eliminare *${matches[0].name}*? Rispondi *sì* per confermare.`, en:`Are you sure you want to delete *${matches[0].name}*? Reply *yes* to confirm.`, fr:`Voulez-vous vraiment supprimer *${matches[0].name}*? Répondez *oui* pour confirmer.`, de:`Möchtest du *${matches[0].name}* wirklich löschen? Antworte mit *ja* zum Bestätigen.`, pt:`Tem certeza que quer eliminar *${matches[0].name}*? Responda *sim* para confirmar.` };
      await sendMessage(tenant.merchant_phone, confirm[lang] || confirm.es, phoneNumberId, token); return;
    }
    const list = dpCandidates.map((p,i) => `${i+1}. *${p.name}*`).join('\n');
    const which = { es:`¿Cuál eliminar?\n${list}`, it:`Quale eliminare?\n${list}`, en:`Which to delete?\n${list}`, fr:`Lequel supprimer?\n${list}`, de:`Welches löschen?\n${list}`, pt:`Qual eliminar?\n${list}` };
    await sendMessage(tenant.merchant_phone, which[lang] || which.es, phoneNumberId, token);
    return;
  }

  // ── Delete service ────────────────────────────────────────────────────────
  if (intent.action === 'delete_service') {
    if (!intent.service_query) { await sendMessage(tenant.merchant_phone, mt(lang, 'unknown'), phoneNumberId, token); return; }
    const sMatches = allServices.filter(s => s.name.toLowerCase().includes(intent.service_query.toLowerCase()));
    if (!sMatches.length) {
      const none = { es:`⚠️ No encontré el servicio "${intent.service_query}".`, it:`⚠️ Servizio "${intent.service_query}" non trovato.`, en:`⚠️ Service "${intent.service_query}" not found.`, fr:`⚠️ Service "${intent.service_query}" introuvable.`, de:`⚠️ Dienst "${intent.service_query}" nicht gefunden.`, pt:`⚠️ Serviço "${intent.service_query}" não encontrado.` };
      await sendMessage(tenant.merchant_phone, none[lang] || none.es, phoneNumberId, token); return;
    }
    const dsCandidates = sMatches.slice(0, 5);
    merchantPending.set(tenant.id, { action: 'delete_service', candidates: dsCandidates, lang, expiresAt: Date.now() + 5*60*1000 });
    if (sMatches.length === 1) {
      const confirm = { es:`¿Seguro que querés eliminar *${sMatches[0].name}*? Respondé *sí* para confirmar.`, it:`Sicuro di voler eliminare *${sMatches[0].name}*? Rispondi *sì* per confermare.`, en:`Are you sure you want to delete *${sMatches[0].name}*? Reply *yes* to confirm.`, fr:`Voulez-vous vraiment supprimer *${sMatches[0].name}*? Répondez *oui* pour confirmer.`, de:`Möchtest du *${sMatches[0].name}* wirklich löschen? Antworte mit *ja* zum Bestätigen.`, pt:`Tem certeza que quer eliminar *${sMatches[0].name}*? Responda *sim* para confirmar.` };
      await sendMessage(tenant.merchant_phone, confirm[lang] || confirm.es, phoneNumberId, token); return;
    }
    const list = dsCandidates.map((s,i) => `${i+1}. *${s.name}*`).join('\n');
    const which = { es:`¿Cuál eliminar?\n${list}`, it:`Quale eliminare?\n${list}`, en:`Which to delete?\n${list}`, fr:`Lequel supprimer?\n${list}`, de:`Welchen löschen?\n${list}`, pt:`Qual eliminar?\n${list}` };
    await sendMessage(tenant.merchant_phone, which[lang] || which.es, phoneNumberId, token);
    return;
  }

  // ── Broadcast ─────────────────────────────────────────────────────────────
  if (intent.action === 'broadcast') {
    const { message, days_active = 30 } = intent.params || {};
    if (!message?.trim()) {
      const ask = { es:'¿Qué mensaje querés enviar a todos tus clientes?', it:'Quale messaggio vuoi inviare a tutti i tuoi clienti?', en:'What message do you want to send to all your customers?', fr:'Quel message voulez-vous envoyer à tous vos clients?', de:'Welche Nachricht möchtest du an alle Kunden senden?', pt:'Qual mensagem deseja enviar a todos os clientes?' };
      await sendMessage(tenant.merchant_phone, ask[lang] || ask.es, phoneNumberId, token); return;
    }
    if (message.trim().length > 1000) {
      const tooLong = { es:'⚠️ Mensaje demasiado largo (máx. 1000 caracteres).', it:'⚠️ Messaggio troppo lungo (max 1000 caratteri).', en:'⚠️ Message too long (max 1000 characters).', fr:'⚠️ Message trop long (max 1000 caractères).', de:'⚠️ Nachricht zu lang (max. 1000 Zeichen).', pt:'⚠️ Mensagem muito longa (máx. 1000 caracteres).' };
      await sendMessage(tenant.merchant_phone, tooLong[lang] || tooLong.es, phoneNumberId, token); return;
    }
    if (broadcastInProgress.has(tenant.id)) {
      const busy = { es:'⏳ Ya hay un broadcast en curso. Esperá que termine.', it:'⏳ Broadcast già in corso. Aspetta che finisca.', en:'⏳ A broadcast is already in progress. Wait for it to finish.', fr:'⏳ Un broadcast est déjà en cours. Attendez la fin.', de:'⏳ Ein Broadcast läuft bereits. Bitte warten.', pt:'⏳ Já existe um broadcast em andamento. Aguarde.' };
      await sendMessage(tenant.merchant_phone, busy[lang] || busy.es, phoneNumberId, token); return;
    }
    const since = new Date(Date.now() - days_active * 86400000).toISOString();
    const { data: convs } = await supabase.from('conversations').select('customer_phone').eq('tenant_id', tenant.id).gte('updated_at', since);
    const phones = [...new Set((convs || []).map(c => c.customer_phone))];
    if (!phones.length) {
      const none = { es:'⚠️ No hay clientes activos para enviar.', it:'⚠️ Nessun cliente attivo a cui inviare.', en:'⚠️ No active customers to send to.', fr:'⚠️ Aucun client actif.', de:'⚠️ Keine aktiven Kunden.', pt:'⚠️ Nenhum cliente ativo.' };
      await sendMessage(tenant.merchant_phone, none[lang] || none.es, phoneNumberId, token); return;
    }
    const sending = { es:`📣 Enviando a *${phones.length}* clientes...`, it:`📣 Invio a *${phones.length}* clienti...`, en:`📣 Sending to *${phones.length}* customers...`, fr:`📣 Envoi à *${phones.length}* clients...`, de:`📣 Sende an *${phones.length}* Kunden...`, pt:`📣 Enviando para *${phones.length}* clientes...` };
    await sendMessage(tenant.merchant_phone, sending[lang] || sending.es, phoneNumberId, token);
    broadcastInProgress.add(tenant.id);
    const broadcastToken = tenant.whatsapp_token || process.env.WHATSAPP_TOKEN;
    let sent = 0, failed = 0;
    try {
      for (const phone of phones) {
        try { await sendMessage(phone, message.trim(), phoneNumberId, broadcastToken); sent++; } catch { failed++; }
      }
    } finally {
      broadcastInProgress.delete(tenant.id);
    }
    const done = { es:`✅ Enviado a *${sent}* clientes${failed ? ` (${failed} fallidos)` : ''}.`, it:`✅ Inviato a *${sent}* clienti${failed ? ` (${failed} falliti)` : ''}.`, en:`✅ Sent to *${sent}* customers${failed ? ` (${failed} failed)` : ''}.`, fr:`✅ Envoyé à *${sent}* clients${failed ? ` (${failed} échoués)` : ''}.`, de:`✅ An *${sent}* Kunden gesendet${failed ? ` (${failed} fehlgeschlagen)` : ''}.`, pt:`✅ Enviado a *${sent}* clientes${failed ? ` (${failed} falhas)` : ''}.` };
    await sendMessage(tenant.merchant_phone, done[lang] || done.es, phoneNumberId, token);
    return;
  }

  // ── Update / delete customer ──────────────────────────────────────────────
  if (intent.action === 'update_customer') {
    const { customer_query, email, address, name } = intent.params || {};
    if (!customer_query) { await sendMessage(tenant.merchant_phone, mt(lang, 'unknown'), phoneNumberId, token); return; }
    const updates = {};
    if (name)    updates.customer_name    = name.trim();
    if (email)   updates.customer_email   = email.trim();
    if (address) updates.customer_address = address.trim();
    if (!Object.keys(updates).length) { await sendMessage(tenant.merchant_phone, mt(lang, 'unknown'), phoneNumberId, token); return; }
    const q = customer_query.toLowerCase();
    const { data: convs } = await supabase.from('conversations').select('id, customer_phone, customer_name').eq('tenant_id', tenant.id);
    const matches = (convs || []).filter(c => (c.customer_name || '').toLowerCase().includes(q) || (c.customer_phone || '').includes(q));
    if (!matches.length) {
      const none = { es:`⚠️ Cliente "${customer_query}" no encontrado.`, it:`⚠️ Cliente "${customer_query}" non trovato.`, en:`⚠️ Customer "${customer_query}" not found.`, fr:`⚠️ Client "${customer_query}" introuvable.`, de:`⚠️ Kunde "${customer_query}" nicht gefunden.`, pt:`⚠️ Cliente "${customer_query}" não encontrado.` };
      await sendMessage(tenant.merchant_phone, none[lang] || none.es, phoneNumberId, token); return;
    }
    const target = matches[0];
    await supabase.from('conversations').update(updates).eq('tenant_id', tenant.id).eq('customer_phone', target.customer_phone);
    const ok = { es:`✅ Cliente *${target.customer_name || target.customer_phone}* actualizado.`, it:`✅ Cliente *${target.customer_name || target.customer_phone}* aggiornato.`, en:`✅ Customer *${target.customer_name || target.customer_phone}* updated.`, fr:`✅ Client *${target.customer_name || target.customer_phone}* mis à jour.`, de:`✅ Kunde *${target.customer_name || target.customer_phone}* aktualisiert.`, pt:`✅ Cliente *${target.customer_name || target.customer_phone}* atualizado.` };
    await sendMessage(tenant.merchant_phone, ok[lang] || ok.es, phoneNumberId, token);
    return;
  }

  if (intent.action === 'delete_customer') {
    const { customer_query } = intent.params || {};
    if (!customer_query) { await sendMessage(tenant.merchant_phone, mt(lang, 'unknown'), phoneNumberId, token); return; }
    const q = customer_query.toLowerCase();
    const { data: convs } = await supabase.from('conversations').select('id, customer_phone, customer_name').eq('tenant_id', tenant.id);
    const matches = (convs || []).filter(c => (c.customer_name || '').toLowerCase().includes(q) || (c.customer_phone || '').includes(q));
    if (!matches.length) {
      const none = { es:`⚠️ Cliente "${customer_query}" no encontrado.`, it:`⚠️ Cliente "${customer_query}" non trovato.`, en:`⚠️ Customer "${customer_query}" not found.`, fr:`⚠️ Client "${customer_query}" introuvable.`, de:`⚠️ Kunde "${customer_query}" nicht gefunden.`, pt:`⚠️ Cliente "${customer_query}" não encontrado.` };
      await sendMessage(tenant.merchant_phone, none[lang] || none.es, phoneNumberId, token); return;
    }
    const target = matches[0];
    const label = target.customer_name || target.customer_phone;
    merchantPending.set(tenant.id, { action: 'delete_customer', target, lang, expiresAt: Date.now() + 5*60*1000 });
    const confirm = { es:`¿Seguro que querés eliminar al cliente *${label}*? Respondé *sí* para confirmar.`, it:`Sicuro di voler eliminare il cliente *${label}*? Rispondi *sì* per confermare.`, en:`Are you sure you want to delete customer *${label}*? Reply *yes* to confirm.`, fr:`Voulez-vous vraiment supprimer le client *${label}*? Répondez *oui* pour confirmer.`, de:`Möchtest du Kunde *${label}* wirklich löschen? Antworte mit *ja* zum Bestätigen.`, pt:`Tem certeza que quer eliminar o cliente *${label}*? Responda *sim* para confirmar.` };
    await sendMessage(tenant.merchant_phone, confirm[lang] || confirm.es, phoneNumberId, token);
    return;
  }

  // ── Set business hours ────────────────────────────────────────────────────
  if (intent.action === 'set_hours') {
    const { day, open_time, close_time, is_closed, open_time_2, close_time_2 } = intent.params || {};
    if (!day) { await sendMessage(tenant.merchant_phone, mt(lang, 'unknown'), phoneNumberId, token); return; }
    const dayMap = { monday:1, tuesday:2, wednesday:3, thursday:4, friday:5, saturday:6, sunday:0, lunes:1, martes:2, miercoles:3, miércoles:3, jueves:4, viernes:5, sabado:6, sábado:6, domingo:0, lunedì:1, martedì:2, mercoledì:3, giovedì:4, venerdì:5, sabato:6, domenica:0, lundi:1, mardi:2, mercredi:3, jeudi:4, vendredi:5, samedi:6, dimanche:0, montag:1, dienstag:2, mittwoch:3, donnerstag:4, freitag:5, samstag:6, sonntag:0 };
    const rows = [];
    if (day === 'all') {
      for (let d = 0; d <= 6; d++) rows.push({ tenant_id: tenant.id, day_of_week: d, open_time: is_closed ? null : (open_time || '09:00'), close_time: is_closed ? null : (close_time || '18:00'), open_time_2: is_closed ? null : (open_time_2 || null), close_time_2: is_closed ? null : (close_time_2 || null), is_closed: !!is_closed });
    } else {
      const dow = dayMap[day.toLowerCase()];
      if (dow === undefined) { await sendMessage(tenant.merchant_phone, mt(lang, 'unknown'), phoneNumberId, token); return; }
      rows.push({ tenant_id: tenant.id, day_of_week: dow, open_time: is_closed ? null : (open_time || '09:00'), close_time: is_closed ? null : (close_time || '18:00'), open_time_2: is_closed ? null : (open_time_2 || null), close_time_2: is_closed ? null : (close_time_2 || null), is_closed: !!is_closed });
    }
    await supabase.from('business_hours').upsert(rows, { onConflict: 'tenant_id,day_of_week' });
    invalidateBusinessHours(tenant.id);
    const label = is_closed
      ? { es:`🔴 ${day === 'all' ? 'Todos los días' : day}: cerrado.`, it:`🔴 ${day === 'all' ? 'Tutti i giorni' : day}: chiuso.`, en:`🔴 ${day === 'all' ? 'Every day' : day}: closed.`, fr:`🔴 ${day === 'all' ? 'Tous les jours' : day}: fermé.`, de:`🔴 ${day === 'all' ? 'Alle Tage' : day}: geschlossen.`, pt:`🔴 ${day === 'all' ? 'Todos os dias' : day}: fechado.` }
      : { es:`✅ ${day === 'all' ? 'Todos los días' : day}: ${open_time || '09:00'}–${close_time || '18:00'}${open_time_2 ? ` / ${open_time_2}–${close_time_2}` : ''}.`, it:`✅ ${day === 'all' ? 'Tutti i giorni' : day}: ${open_time || '09:00'}–${close_time || '18:00'}${open_time_2 ? ` / ${open_time_2}–${close_time_2}` : ''}.`, en:`✅ ${day === 'all' ? 'Every day' : day}: ${open_time || '09:00'}–${close_time || '18:00'}${open_time_2 ? ` / ${open_time_2}–${close_time_2}` : ''}.`, fr:`✅ ${day === 'all' ? 'Tous les jours' : day}: ${open_time || '09:00'}–${close_time || '18:00'}${open_time_2 ? ` / ${open_time_2}–${close_time_2}` : ''}.`, de:`✅ ${day === 'all' ? 'Alle Tage' : day}: ${open_time || '09:00'}–${close_time || '18:00'}${open_time_2 ? ` / ${open_time_2}–${close_time_2}` : ''}.`, pt:`✅ ${day === 'all' ? 'Todos os dias' : day}: ${open_time || '09:00'}–${close_time || '18:00'}${open_time_2 ? ` / ${open_time_2}–${close_time_2}` : ''}.` };
    await sendMessage(tenant.merchant_phone, label[lang] || label.es, phoneNumberId, token);
    return;
  }

  // ── Greeting ──────────────────────────────────────────────────────────────
  if (intent.action === 'greeting') {
    const greet = { es:'👋 ¡Hola! ¿En qué te puedo ayudar?', it:'👋 Ciao! Come posso aiutarti?', en:'👋 Hi! How can I help you?', fr:'👋 Bonjour! Comment puis-je vous aider?', de:'👋 Hallo! Wie kann ich helfen?', pt:'👋 Olá! Como posso ajudar?' };
    await sendMessage(tenant.merchant_phone, greet[lang] || greet.es, phoneNumberId, token);
    return;
  }

  // ── Unknown — show relevant help for this account type ───────────────────
  if (intent.action === 'unknown') {
    const lines = [];
    if (tenant.products_enabled)     lines.push({ es:'• ver/actualizar catálogo, stock, precios', it:'• vedere/aggiornare catalogo, stock, prezzi', en:'• view/update catalog, stock, prices', fr:'• voir/mettre à jour catalogue, stock, prix', de:'• Katalog, Bestand, Preise anzeigen/aktualisieren', pt:'• ver/atualizar catálogo, estoque, preços' });
    if (tenant.products_enabled)     lines.push({ es:'• agregar producto, marcar agotado/disponible', it:'• aggiungere prodotto, segnare esaurito/disponibile', en:'• add product, mark unavailable/available', fr:'• ajouter produit, marquer épuisé/disponible', de:'• Produkt hinzufügen, als ausverkauft/verfügbar markieren', pt:'• adicionar produto, marcar esgotado/disponível' });
    if (tenant.products_enabled)     lines.push({ es:'• crear/eliminar oferta o descuento', it:'• creare/eliminare offerta o sconto', en:'• create/delete offer or discount', fr:'• créer/supprimer offre ou remise', de:'• Angebot oder Rabatt erstellen/löschen', pt:'• criar/remover oferta ou desconto' });
    lines.push({ es:'• confirmar/cancelar/actualizar pedido', it:'• confermare/annullare/aggiornare ordine', en:'• confirm/cancel/update order', fr:'• confirmer/annuler/mettre à jour commande', de:'• Bestellung bestätigen/stornieren/aktualisieren', pt:'• confirmar/cancelar/atualizar pedido' });
    lines.push({ es:'• tomar/terminar chat con cliente', it:'• prendere/terminare chat con cliente', en:'• take over/end customer chat', fr:'• prendre/terminer chat client', de:'• Kundenchat übernehmen/beenden', pt:'• assumir/terminar chat do cliente' });
    lines.push({ es:'• estadísticas: pedidos, ingresos, clientes', it:'• statistiche: ordini, ricavi, clienti', en:'• stats: orders, revenue, customers', fr:'• statistiques: commandes, revenus, clients', de:'• Statistiken: Bestellungen, Einnahmen, Kunden', pt:'• estatísticas: pedidos, receita, clientes' });
    if (tenant.appointments_enabled && !tenant.restaurant_enabled) lines.push({ es:'• ver/agregar/cancelar citas, bloquear horario', it:'• vedere/aggiungere/annullare appuntamenti, bloccare orario', en:'• view/add/cancel appointments, block time', fr:'• voir/ajouter/annuler rendez-vous, bloquer horaire', de:'• Termine anzeigen/hinzufügen/absagen, Zeit sperren', pt:'• ver/adicionar/cancelar agendamentos, bloquear horário' });
    if (tenant.services_enabled)     lines.push({ es:'• ver/agregar/actualizar servicios', it:'• vedere/aggiungere/aggiornare servizi', en:'• view/add/update services', fr:'• voir/ajouter/mettre à jour services', de:'• Dienstleistungen anzeigen/hinzufügen/aktualisieren', pt:'• ver/adicionar/atualizar serviços' });
    if (tenant.restaurant_enabled)   lines.push({ es:'• ver/crear/cancelar/confirmar reservas de mesa', it:'• vedere/creare/annullare/confermare prenotazioni tavolo', en:'• view/create/cancel/confirm table reservations', fr:'• voir/créer/annuler/confirmer réservations table', de:'• Tischreservierungen anzeigen/erstellen/stornieren/bestätigen', pt:'• ver/criar/cancelar/confirmar reservas de mesa' });
    lines.push({ es:'• cerrar local (vacaciones, festivos)', it:'• chiudere il locale (ferie, festività)', en:'• close business (holidays, days off)', fr:'• fermer le commerce (vacances, jours fériés)', de:'• Geschäft schließen (Urlaub, Feiertage)', pt:'• fechar o negócio (férias, feriados)' });
    lines.push({ es:'• enviar mensaje a todos los clientes (broadcast)', it:'• inviare messaggio a tutti i clienti (broadcast)', en:'• send message to all customers (broadcast)', fr:'• envoyer message à tous les clients (broadcast)', de:'• Nachricht an alle Kunden senden (Broadcast)', pt:'• enviar mensagem a todos os clientes (broadcast)' });
    lines.push({ es:'• actualizar/eliminar cliente', it:'• aggiornare/eliminare cliente', en:'• update/delete customer', fr:'• mettre à jour/supprimer client', de:'• Kunde aktualisieren/löschen', pt:'• atualizar/eliminar cliente' });
    lines.push({ es:'• cambiar horarios de apertura', it:'• modificare orari di apertura', en:'• update business hours', fr:'• modifier les horaires d\'ouverture', de:'• Öffnungszeiten ändern', pt:'• alterar horários de funcionamento' });

    const hdr = { es:'No entendí. Puedo ayudarte con:\n', it:'Non ho capito. Posso aiutarti con:\n', en:'Didn\'t understand. I can help you with:\n', fr:'Pas compris. Je peux vous aider avec:\n', de:'Nicht verstanden. Ich kann helfen mit:\n', pt:'Não entendi. Posso ajudar com:\n' };
    const body = lines.map(l => l[lang] || l.es).join('\n');
    await sendMessage(tenant.merchant_phone, (hdr[lang] || hdr.es) + body, phoneNumberId, token);
    return;
  }

  // ── Product-dependent actions (stock/price/availability) ──────────────────
  if (!intent.product_query) {
    await sendMessage(tenant.merchant_phone, mt(lang, 'unknown'), phoneNumberId, token);
    return;
  }

  const matches = findProductsFuzzy(allProducts, intent.product_query);

  if (matches.length === 0) {
    await sendMessage(tenant.merchant_phone, mt(lang, 'not_found', intent.product_query), phoneNumberId, token);
    return;
  }

  if (matches.length === 1) {
    merchantPending.set(tenant.id, {
      action: intent.action,
      params: intent.params,
      product: matches[0],
      lang,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });
    await sendMessage(tenant.merchant_phone, mt(lang, 'confirm_one', matches[0].name), phoneNumberId, token);
    return;
  }

  // Multiple matches — list them
  const list = matches.slice(0, 5).map((p, i) => `${i + 1}. *${p.name}*`).join('\n');
  merchantPending.set(tenant.id, {
    action: intent.action,
    params: intent.params,
    candidates: matches.slice(0, 5),
    lang,
    expiresAt: Date.now() + 5 * 60 * 1000,
  });
  await sendMessage(tenant.merchant_phone, mt(lang, 'confirm_many', list), phoneNumberId, token);
}

// ─── Payment proof handler ────────────────────────────────────────────────────
// Called when a customer sends an image and has a pending or recent order.
// Uploads the image to storage, saves it in the chat, and notifies the merchant.

async function handlePaymentProof(tenant, customerPhone, buffer, mimeType, phoneNumberId, token) {
  const ext = mimeType === 'image/png' ? 'png' : 'jpg';
  let publicUrl = null;
  try {
    publicUrl = await uploadImageBuffer(
      buffer,
      `comprobante-${customerPhone}-${Date.now()}.${ext}`,
      mimeType,
      tenant.id
    );
  } catch (e) {
    console.error('[payment-proof] Upload error:', e.message);
  }

  // Acknowledge to customer immediately
  await sendMessage(
    customerPhone,
    '✅ ¡Comprobante recibido! El negocio lo revisará y te confirmará en breve. Gracias 😊',
    phoneNumberId,
    token
  );

  // Save in conversation history with image_url so it shows in admin chat panel
  const { data: convRow } = await supabase
    .from('conversations')
    .select('messages_json')
    .eq('tenant_id', tenant.id)
    .eq('customer_phone', customerPhone)
    .maybeSingle();

  const history = convRow?.messages_json || [];
  history.push({
    role: 'user',
    content: '📎 Comprobante de pago',
    image_url: publicUrl || null,
    is_payment_proof: true,
  });

  await supabase.from('conversations').upsert({
    tenant_id: tenant.id,
    customer_phone: customerPhone,
    messages_json: history,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'tenant_id,customer_phone' });

  // Forward image + alert to merchant WhatsApp
  if (tenant.merchant_phone && publicUrl) {
    try {
      // Send text alert first
      await sendMessage(
        tenant.merchant_phone,
        `💳 *Comprobante de pago recibido*\n👤 Cliente: +${customerPhone}\n\nEl cliente envió un comprobante. Verificá el pago y confirmá el pedido.`,
        phoneNumberId,
        token
      );
      // Then send the actual image
      await sendImage(
        tenant.merchant_phone,
        publicUrl,
        `Comprobante de +${customerPhone}`,
        phoneNumberId,
        token
      );
    } catch (e) {
      console.error('[payment-proof] Forward to merchant error:', e.message);
    }
  }

  console.log(`[payment-proof] Processed for tenant ${tenant.id}, customer ${customerPhone}, url: ${publicUrl}`);
}

// ─── Merchant photo flow helpers ─────────────────────────────────────────────

async function askPhotoMode(tenant, product, lang, phoneNumberId, token) {
  const { data: full } = await supabase.from('products')
    .select('additional_images, image_url')
    .eq('id', product.id).single();
  const hasMain    = !!(full?.image_url);
  const extraCount = full?.additional_images?.length || 0;

  await askPhotoModeFromPending(
    tenant,
    { action: 'photo_mode_choose', productId: product.id, productName: product.name, hasMain, extraCount, lang, expiresAt: Date.now() + 5 * 60 * 1000 },
    phoneNumberId, token,
  );
}

async function askPhotoModeFromPending(tenant, pending, phoneNumberId, token) {
  const { productName, hasMain, extraCount, lang } = pending;
  merchantPending.set(tenant.id, { ...pending, expiresAt: Date.now() + 5 * 60 * 1000 });

  // Build status summary line
  const statusParts = {
    es: `${hasMain ? '1 foto principal' : 'sin foto principal'}, ${extraCount} foto(s) extra`,
    it: `${hasMain ? '1 foto principale' : 'nessuna foto principale'}, ${extraCount} foto extra`,
    en: `${hasMain ? '1 main photo' : 'no main photo'}, ${extraCount} extra photo(s)`,
    fr: `${hasMain ? '1 photo principale' : 'pas de photo principale'}, ${extraCount} photo(s) extra`,
    de: `${hasMain ? '1 Hauptfoto' : 'kein Hauptfoto'}, ${extraCount} Zusatzfoto(s)`,
    pt: `${hasMain ? '1 foto principal' : 'sem foto principal'}, ${extraCount} foto(s) extra`,
  };
  const status = statusParts[lang] || statusParts.es;
  const msgs = {
    es: `📸 *${productName}* — actualmente: ${status}\n\n¿Qué hacemos?\n1️⃣ ${hasMain ? 'Reemplazar foto principal' : 'Agregar foto principal'}\n2️⃣ Agregar foto extra (${extraCount}/9)\n\nRespondé *1* o *2*.`,
    it: `📸 *${productName}* — attualmente: ${status}\n\nCosa facciamo?\n1️⃣ ${hasMain ? 'Sostituire la foto principale' : 'Aggiungere la foto principale'}\n2️⃣ Aggiungere foto extra (${extraCount}/9)\n\nRispondi *1* o *2*.`,
    en: `📸 *${productName}* — currently: ${status}\n\nWhat should we do?\n1️⃣ ${hasMain ? 'Replace main photo' : 'Add main photo'}\n2️⃣ Add extra photo (${extraCount}/9)\n\nReply *1* or *2*.`,
    fr: `📸 *${productName}* — actuellement: ${status}\n\nQue faire?\n1️⃣ ${hasMain ? 'Remplacer la photo principale' : 'Ajouter la photo principale'}\n2️⃣ Ajouter photo supplémentaire (${extraCount}/9)\n\nRépondez *1* ou *2*.`,
    de: `📸 *${productName}* — aktuell: ${status}\n\nWas tun?\n1️⃣ ${hasMain ? 'Hauptfoto ersetzen' : 'Hauptfoto hinzufügen'}\n2️⃣ Zusatzfoto hinzufügen (${extraCount}/9)\n\nAntworte *1* oder *2*.`,
    pt: `📸 *${productName}* — atualmente: ${status}\n\nO que fazer?\n1️⃣ ${hasMain ? 'Substituir foto principal' : 'Adicionar foto principal'}\n2️⃣ Adicionar foto extra (${extraCount}/9)\n\nResponda *1* ou *2*.`,
  };
  await sendMessage(tenant.merchant_phone, msgs[lang] || msgs.es, phoneNumberId, token);
}

async function executePendingPhoto(tenant, message, pending, phoneNumberId, token) {
  merchantPending.delete(tenant.id);
  const lang   = pending.lang || 'es';
  const mediaId = message.image?.id;
  if (!mediaId) {
    const err = { es:'❌ No se recibió imagen. Intentá de nuevo.', it:"❌ Nessuna immagine ricevuta. Riprova.", en:'❌ No image received. Please try again.', fr:"❌ Aucune image reçue. Réessayez.", de:'❌ Kein Bild erhalten. Bitte erneut versuchen.', pt:'❌ Nenhuma imagem recebida. Tente novamente.' };
    await sendMessage(tenant.merchant_phone, err[lang] || err.es, phoneNumberId, token);
    return;
  }
  const uploading = { es:`⏳ Subiendo foto para *${pending.productName}*...`, it:`⏳ Caricamento foto per *${pending.productName}*...`, en:`⏳ Uploading photo for *${pending.productName}*...`, fr:`⏳ Téléchargement de la photo pour *${pending.productName}*...`, de:`⏳ Foto wird hochgeladen für *${pending.productName}*...`, pt:`⏳ Enviando foto para *${pending.productName}*...` };
  await sendMessage(tenant.merchant_phone, uploading[lang] || uploading.es, phoneNumberId, token);
  try {
    const whatsappToken = tenant.whatsapp_token || process.env.WHATSAPP_TOKEN;
    const publicUrl = await downloadAndStore(mediaId, whatsappToken, pending.productName, tenant.id);
    if (pending.mode === 'add_extra') {
      const { data: full } = await supabase.from('products')
        .select('additional_images, name, description, price_guarani, image_url, is_available')
        .eq('id', pending.productId).single();
      const existing = full?.additional_images || [];
      const updated  = [...existing, publicUrl].slice(0, 9);
      await supabase.from('products').update({ additional_images: updated }).eq('id', pending.productId);
      catalog.pushProduct(tenant, { ...full, id: pending.productId, additional_images: updated }).catch(() => {});
      const ok = { es:`✅ Foto extra ${updated.length}/9 guardada para *${pending.productName}*!`, it:`✅ Foto extra ${updated.length}/9 salvata per *${pending.productName}*!`, en:`✅ Extra photo ${updated.length}/9 saved for *${pending.productName}*!`, fr:`✅ Photo extra ${updated.length}/9 enregistrée pour *${pending.productName}*!`, de:`✅ Zusatzfoto ${updated.length}/9 gespeichert für *${pending.productName}*!`, pt:`✅ Foto extra ${updated.length}/9 salva para *${pending.productName}*!` };
      await sendMessage(tenant.merchant_phone, ok[lang] || ok.es, phoneNumberId, token);
    } else {
      await supabase.from('products').update({ image_url: publicUrl }).eq('id', pending.productId);
      const ok = { es:`✅ Foto principal guardada para *${pending.productName}*! Sara la enviará automáticamente a los clientes.`, it:`✅ Foto principale salvata per *${pending.productName}*! Sara la invierà automaticamente ai clienti.`, en:`✅ Main photo saved for *${pending.productName}*! Sara will send it automatically to customers.`, fr:`✅ Photo principale enregistrée pour *${pending.productName}*! Sara l'enverra automatiquement.`, de:`✅ Hauptfoto gespeichert für *${pending.productName}*! Sara sendet es automatisch an Kunden.`, pt:`✅ Foto principal salva para *${pending.productName}*! Sara a enviará automaticamente.` };
      await sendMessage(tenant.merchant_phone, ok[lang] || ok.es, phoneNumberId, token);
    }
    console.log(`[storage] executePendingPhoto mode=${pending.mode} product="${pending.productName}" url=${publicUrl}`);
  } catch (err) {
    console.error('[storage] executePendingPhoto error:', err.message);
    const errMsg = { es:'❌ Error al subir la foto. Intentá de nuevo.', it:'❌ Errore nel caricamento. Riprova.', en:'❌ Error uploading photo. Please try again.', fr:'❌ Erreur lors du téléchargement. Réessayez.', de:'❌ Fehler beim Hochladen. Bitte erneut versuchen.', pt:'❌ Erro ao enviar foto. Tente novamente.' };
    await sendMessage(tenant.merchant_phone, errMsg[lang] || errMsg.es, phoneNumberId, token);
  }
}

// ─── Merchant image handler ───────────────────────────────────────────────────

async function handleMerchantImage(tenant, message, phoneNumberId, token) {
  const mediaId = message.image?.id;
  const caption = message.image?.caption?.trim() || null;
  const lang = merchantLang.get(tenant.id) || 'es';

  if (!mediaId) return;

  // Detect "foto extra" prefix (multilingual) — appends to additional_images instead of overwriting image_url
  const EXTRA_PREFIXES = ['foto extra ', 'extra foto ', 'extra photo ', 'additional photo ',
    'zusätzliches foto ', 'foto adicional ', 'photo supplémentaire ', 'foto adicional pt '];
  let isExtraPhoto = false;
  let cleanCaption = caption || '';
  if (cleanCaption) {
    for (const prefix of EXTRA_PREFIXES) {
      if (cleanCaption.toLowerCase().startsWith(prefix)) {
        isExtraPhoto = true;
        cleanCaption = cleanCaption.slice(prefix.length).trim();
        break;
      }
    }
  }

  // If no caption → ask which product (with extra-photo hint)
  if (!cleanCaption) {
    const msg = {
      es: '📸 ¡Foto recibida! Reenviala con el *nombre del producto* como caption.\n\nEjemplo: "Pizza Margherita"\n\n_Para agregar foto extra (además de la principal): "foto extra Pizza Margherita"_',
      it: '📸 Foto ricevuta! Rimandamela con il *nome del prodotto* come didascalia.\n\nEsempio: "Pizza Margherita"\n\n_Per aggiungere foto extra: "foto extra Pizza Margherita"_',
      en: '📸 Photo received! Resend it with the *product name* as caption.\n\nExample: "Margherita Pizza"\n\n_To add an extra photo: "extra photo Margherita Pizza"_',
      fr: '📸 Photo reçue! Renvoyez-la avec le *nom du produit* comme légende.\n\nExemple: "Pizza Margherita"\n\n_Pour ajouter une photo supplémentaire: "photo supplémentaire Pizza Margherita"_',
      de: '📸 Foto erhalten! Schick es erneut mit dem *Produktnamen* als Beschriftung.\n\nBeispiel: "Pizza Margherita"\n\n_Für ein zusätzliches Foto: "zusätzliches foto Pizza Margherita"_',
      pt: '📸 Foto recebida! Reenvie com o *nome do produto* como legenda.\n\nExemplo: "Pizza Margherita"\n\n_Para adicionar foto extra: "foto extra Pizza Margherita"_',
    };
    await sendMessage(tenant.merchant_phone, msg[lang] || msg.es, phoneNumberId, token);
    return;
  }

  const uploading = {
    es: `⏳ Subiendo ${isExtraPhoto ? 'foto extra' : 'foto'} para "${cleanCaption}"...`,
    it: `⏳ Caricamento ${isExtraPhoto ? 'foto extra' : 'foto'} per "${cleanCaption}"...`,
    en: `⏳ Uploading ${isExtraPhoto ? 'extra photo' : 'photo'} for "${cleanCaption}"...`,
    fr: `⏳ Téléchargement de la ${isExtraPhoto ? 'photo supplémentaire' : 'photo'} pour "${cleanCaption}"...`,
    de: `⏳ ${isExtraPhoto ? 'Zusätzliches Foto' : 'Foto'} wird hochgeladen für "${cleanCaption}"...`,
    pt: `⏳ Enviando ${isExtraPhoto ? 'foto extra' : 'foto'} para "${cleanCaption}"...`,
  };
  await sendMessage(tenant.merchant_phone, uploading[lang] || uploading.es, phoneNumberId, token);

  try {
    const allP = await getProductsForTenant(tenant.id);
    const matches = findProductsFuzzy(allP, cleanCaption);
    const product = matches[0] || null;
    if (!product) {
      const notFound = { es:`⚠️ No encontré el producto: "${cleanCaption}". Verificá el nombre en el catálogo.`, it:`⚠️ Prodotto non trovato: "${cleanCaption}". Verifica il nome nel catalogo.`, en:`⚠️ Product not found: "${cleanCaption}". Check the name in the catalog.`, fr:`⚠️ Produit introuvable: "${cleanCaption}". Vérifiez le nom dans le catalogue.`, de:`⚠️ Produkt nicht gefunden: "${cleanCaption}". Überprüfe den Namen im Katalog.`, pt:`⚠️ Produto não encontrado: "${cleanCaption}". Verifique o nome no catálogo.` };
      await sendMessage(tenant.merchant_phone, notFound[lang] || notFound.es, phoneNumberId, token);
      return;
    }

    // Download from Meta and upload to Supabase Storage
    const whatsappToken = tenant.whatsapp_token || process.env.WHATSAPP_TOKEN;
    const publicUrl = await downloadAndStore(mediaId, whatsappToken, product.name, tenant.id);

    if (isExtraPhoto) {
      // Append to additional_images (max 9)
      const { data: full } = await supabase.from('products')
        .select('additional_images, name, description, price_guarani, image_url, is_available')
        .eq('id', product.id).single();
      const existing = full?.additional_images || [];
      if (existing.length >= 9) {
        const limitMsg = { es:`⚠️ *${product.name}* ya tiene 9 fotos adicionales (límite). Eliminá alguna desde el panel para agregar más.`, it:`⚠️ *${product.name}* ha già 9 foto aggiuntive (limite). Rimuovine una dal pannello per aggiungerne altre.`, en:`⚠️ *${product.name}* already has 9 extra photos (limit). Remove one from the panel to add more.`, fr:`⚠️ *${product.name}* a déjà 9 photos supplémentaires (limite). Supprimez-en une depuis le panneau.`, de:`⚠️ *${product.name}* hat bereits 9 Zusatzfotos (Limit). Entferne eines im Panel, um weitere hinzuzufügen.`, pt:`⚠️ *${product.name}* já tem 9 fotos extras (limite). Remova uma no painel para adicionar mais.` };
        await sendMessage(tenant.merchant_phone, limitMsg[lang] || limitMsg.es, phoneNumberId, token);
        return;
      }
      const updated = [...existing, publicUrl];
      await supabase.from('products').update({ additional_images: updated }).eq('id', product.id);
      catalog.pushProduct(tenant, { ...full, id: product.id, additional_images: updated }).catch(() => {});
      const ok = { es:`✅ Foto extra ${updated.length}/9 guardada para *${product.name}*!`, it:`✅ Foto extra ${updated.length}/9 salvata per *${product.name}*!`, en:`✅ Extra photo ${updated.length}/9 saved for *${product.name}*!`, fr:`✅ Photo supplémentaire ${updated.length}/9 enregistrée pour *${product.name}*!`, de:`✅ Zusätzliches Foto ${updated.length}/9 gespeichert für *${product.name}*!`, pt:`✅ Foto extra ${updated.length}/9 salva para *${product.name}*!` };
      await sendMessage(tenant.merchant_phone, ok[lang] || ok.es, phoneNumberId, token);
    } else {
      // Overwrite main image_url (existing behavior)
      await supabase.from('products').update({ image_url: publicUrl }).eq('id', product.id);
      const ok = { es:`✅ ¡Foto guardada para *${product.name}*! Sara la enviará automáticamente a los clientes.`, it:`✅ Foto salvata per *${product.name}*! Sara la invierà automaticamente ai clienti.`, en:`✅ Photo saved for *${product.name}*! Sara will send it automatically to customers.`, fr:`✅ Photo enregistrée pour *${product.name}*! Sara l'enverra automatiquement aux clients.`, de:`✅ Foto gespeichert für *${product.name}*! Sara sendet sie automatisch an Kunden.`, pt:`✅ Foto salva para *${product.name}*! Sara a enviará automaticamente aos clientes.` };
      await sendMessage(tenant.merchant_phone, ok[lang] || ok.es, phoneNumberId, token);
    }
    console.log(`[storage] Image uploaded for product "${product.name}" (extra=${isExtraPhoto}): ${publicUrl}`);

  } catch (err) {
    console.error('[storage] Image upload error:', err.message);
    const errMsg = { es:`❌ Error al subir la foto. Intentá de nuevo.`, it:`❌ Errore nel caricamento della foto. Riprova.`, en:`❌ Error uploading photo. Please try again.`, fr:`❌ Erreur lors du téléchargement. Réessayez.`, de:`❌ Fehler beim Hochladen. Bitte erneut versuchen.`, pt:`❌ Erro ao enviar foto. Tente novamente.` };
    await sendMessage(tenant.merchant_phone, errMsg[lang] || errMsg.es, phoneNumberId, token);
  }
}

// ─── Restaurant table booking helper ─────────────────────────────────────────

async function completeBookTable(tenant, params, lang, phoneNumberId, token) {
  const { customer_name, customer_phone, party_size, date, time, zone_preference, notes, num_tables, table_capacity } = params;
  const reservedAt = new Date(`${date}T${time || '20:00'}:00`).toISOString();
  const dur = tenant.restaurant_slot_duration || 90;

  let zoneId = null;
  if (zone_preference) {
    const zones = await getRestaurantZones(tenant.id);
    const z = (zones || []).find(z => z.name.toLowerCase().includes(zone_preference.toLowerCase()));
    if (z) zoneId = z.id;
  }

  // Merchant authority — no capacity validation, block exactly what they asked
  const wantedTables = Math.max(1, parseInt(num_tables) || 1);
  let tableIds = [];
  let tq = supabase.from('restaurant_tables').select('id, capacity, zone_id').eq('tenant_id', tenant.id);
  if (zoneId) tq = tq.eq('zone_id', zoneId);
  if (table_capacity) tq = tq.eq('capacity', parseInt(table_capacity));
  const { data: allTables } = await tq.order('capacity');
  tableIds = (allTables || []).slice(0, wantedTables).map(t => t.id);
  if (!zoneId && allTables?.length) zoneId = allTables.find(t => t.zone_id)?.zone_id || null;

  const name = customer_name || { es:'Reserva interna', it:'Prenotazione interna', en:'Internal block', fr:'Blocage interne', de:'Interner Block', pt:'Reserva interna' }[lang] || 'Reserva interna';

  await supabase.from('reservations').insert({
    tenant_id: tenant.id, customer_name: name, customer_phone: customer_phone || null,
    party_size: party_size || (table_capacity * wantedTables) || 2,
    reserved_at: reservedAt, duration_min: dur,
    status: 'confirmed', zone_id: zoneId,
    table_id: tableIds[0] || null, table_ids: tableIds,
    notes: notes || null,
  });

  const dt = new Date(reservedAt).toLocaleString('es', { weekday:'short', day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' });
  const tWord = tableIds.length > 1
    ? { es:'mesas', it:'tavoli', en:'tables', fr:'tables', de:'Tische', pt:'mesas' }[lang] || 'tables'
    : { es:'mesa', it:'tavolo', en:'table', fr:'table', de:'Tisch', pt:'mesa' }[lang] || 'table';
  const tblNote = tableIds.length ? ` (${tableIds.length} ${tWord}${table_capacity ? ` x${table_capacity}` : ''})` : '';
  const zNote = zone_preference ? ` — ${zone_preference}` : '';
  const ok = {
    es: `✅ *${tableIds.length || wantedTables} ${tWord}* bloqueadas${zNote} el ${dt}${notes ? `\n📝 ${notes}` : ''}`,
    it: `✅ *${tableIds.length || wantedTables} ${tWord}* bloccati${zNote} — ${dt}${notes ? `\n📝 ${notes}` : ''}`,
    en: `✅ *${tableIds.length || wantedTables} ${tWord}* blocked${zNote} — ${dt}${notes ? `\n📝 ${notes}` : ''}`,
    fr: `✅ *${tableIds.length || wantedTables} ${tWord}* bloquées${zNote} — ${dt}${notes ? `\n📝 ${notes}` : ''}`,
    de: `✅ *${tableIds.length || wantedTables} ${tWord}* gesperrt${zNote} — ${dt}${notes ? `\n📝 ${notes}` : ''}`,
    pt: `✅ *${tableIds.length || wantedTables} ${tWord}* bloqueadas${zNote} — ${dt}${notes ? `\n📝 ${notes}` : ''}`,
  };
  await sendMessage(tenant.merchant_phone, ok[lang] || ok.es, phoneNumberId, token);
}

// ─── Appointment helper ───────────────────────────────────────────────────────

async function completeAddAppointment(tenant, params, services, lang, phoneNumberId, token) {
  const { customer_name, customer_phone, service_query, start_at, duration_override } = params;

  let service = null;
  if (service_query) {
    const q = service_query.toLowerCase();
    service = services.find(s => s.name.toLowerCase().includes(q)) || null;
  }

  const duration_min = duration_override || service?.duration_min || 60;
  const end_at = new Date(new Date(start_at).getTime() + duration_min * 60000).toISOString();

  const check = await checkSlotAvailability(tenant.id, start_at, end_at, tenant.appointment_capacity);
  if (!check.available) {
    await sendMessage(tenant.merchant_phone, slotConflictMessage(check, lang), phoneNumberId, token);
    return;
  }

  const { error } = await supabase.from('appointments').insert({
    tenant_id: tenant.id,
    customer_name: customer_name || 'Cliente',
    customer_phone: customer_phone || '',
    service_id: service?.id || null,
    start_at, end_at,
    status: 'confirmed',
    notes: null,
  });
  if (error) { await sendMessage(tenant.merchant_phone, `❌ ${error.message}`, phoneNumberId, token); return; }

  const dt = new Date(start_at).toLocaleString('es-PY', { weekday:'short', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
  await sendMessage(tenant.merchant_phone, mt(lang, 'appt_added', customer_name || 'Cliente', service?.name || `${duration_min}min`, dt), phoneNumberId, token);
}

// ─── Catalog helpers ──────────────────────────────────────────────────────────

async function getProductsForTenant(tenantId) {
  const { data } = await supabase
    .from('products')
    .select('id, name, stock_qty, price_guarani, is_available')
    .eq('tenant_id', tenantId);
  return data || [];
}

// ─── Customer message handler ─────────────────────────────────────────────────

async function handleCustomerMessage(tenant, customerPhone, messageText, locationMsg, imageData, waProfileName, phoneNumberId, token) {
  const currency = tenant.plan_currency || 'PYG';
  // Load conversation
  const { data: convRow } = await supabase
    .from('conversations')
    .select('*')
    .eq('tenant_id', tenant.id)
    .eq('customer_phone', customerPhone)
    .maybeSingle();

  // If in takeover mode, forward to merchant
  if (convRow?.takeover_active && tenant.merchant_phone) {
    const prefix = `💬 *Mensaje de +${customerPhone}:*\n`;
    const fwdText = messageText || '📍 [ubicación compartida]';
    await sendMessage(tenant.merchant_phone, prefix + fwdText, phoneNumberId, token);
    return;
  }

  // Sanitize history before sending to Anthropic.
  // Anthropic only accepts { role, content } — any extra field causes 'Extra inputs are not permitted'.
  // Known extra fields in our DB: source:'merchant', image_url (from takeover messages),
  // and old array content blocks (from image messages saved before the text-only fix).
  const rawHistory = convRow?.messages_json || [];
  const history = rawHistory
    .filter(msg => msg.role === 'user' || msg.role === 'assistant') // skip any malformed entries
    .map(msg => {
      let content = msg.content;
      // Flatten array content blocks to plain text
      if (Array.isArray(content)) {
        content = content
          .filter(b => b.type === 'text')
          .map(b => b.text)
          .join(' ')
          .trim() || '[mensaje con imagen]';
      }
      // Return ONLY role + content — strip source, image_url, and any other extra fields
      return { role: msg.role, content: typeof content === 'string' ? content : String(content) };
    });
  // ── Customer context: active order + past orders ────────────────────────────
  const [stock, services, closures, offers, businessHours, activeOrderRes, pastOrdersRes] = await Promise.all([
    getStock(tenant.id),
    getServices(tenant.id),
    getBusinessClosures(tenant.id),
    getOffers(tenant.id),
    getBusinessHours(tenant.id),
    supabase.from('orders')
      .select('id,status,items_json,total_guarani,created_at')
      .eq('tenant_id', tenant.id)
      .eq('customer_phone', customerPhone)
      .in('status', ['pending','confirmed','preparing','delivering'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase.from('orders')
      .select('items_json,created_at')
      .eq('tenant_id', tenant.id)
      .eq('customer_phone', customerPhone)
      .eq('status', 'delivered')
      .order('created_at', { ascending: false })
      .limit(3),
  ]);

  const customerContext = (activeOrderRes.data || pastOrdersRes.data?.length)
    ? { activeOrder: activeOrderRes.data || null, pastOrders: pastOrdersRes.data || [] }
    : null;

  // ── Load appointment slots for next 14 days (if feature enabled AND relevant) ─
  // Skip the 3 extra queries + large prompt block when the conversation has no
  // sign of being about booking — avoids wasting AI tokens on unrelated chats.
  const APPOINTMENT_KEYWORDS = /reserv|agend|turno|turnos|cita|citas|disponibil|horari|appointment|booking|schedule|atendimento|prenota|appuntamento|hora libre|hora disponible/i;
  // Restaurants use the reservation system (not appointments) even if appointments_enabled=true
  const mightBeAboutAppointments = tenant.appointments_enabled && !tenant.restaurant_enabled && (
    APPOINTMENT_KEYWORDS.test(messageText || '') ||
    history.slice(-4).some(m => APPOINTMENT_KEYWORDS.test(m.content))
  );

  let appointmentSlots = null;
  if (mightBeAboutAppointments) {
    try {
      const apptServices = services.filter(s => s.is_available && s.duration_min);
      const today = new Date();
      const rangeEnd = new Date(today); rangeEnd.setDate(rangeEnd.getDate() + 14);

      // 3 bulk queries instead of N-per-day
      const [bhRes, existingRes, blocksRes] = await Promise.all([
        supabase.from('business_hours').select('*').eq('tenant_id', tenant.id),
        supabase.from('appointments').select('start_at,end_at')
          .eq('tenant_id', tenant.id)
          .gte('start_at', today.toISOString())
          .lte('start_at', rangeEnd.toISOString())
          .neq('status', 'cancelled'),
        supabase.from('appointment_blocks').select('start_at,end_at')
          .eq('tenant_id', tenant.id)
          .gte('start_at', today.toISOString())
          .lte('start_at', rangeEnd.toISOString()),
      ]);

      const bhMap = {};
      for (const bh of bhRes.data || []) bhMap[bh.day_of_week] = bh;
      const appts  = existingRes.data || [];          // count vs capacity
      const blocks = blocksRes.data || [];            // always block
      const cap    = Math.max(1, tenant.appointment_capacity || 1);
      const slotDur = apptServices[0]?.duration_min || 30;

      const byDate = {};
      for (let i = 0; i < 14; i++) {
        const d = new Date(today); d.setDate(d.getDate() + i);
        const dateStr = d.toISOString().slice(0, 10);
        const bh = bhMap[d.getDay()];
        const inClosure = closures.some(c => dateStr >= c.start_date && dateStr <= c.end_date);
        if (!bh || bh.is_closed || inClosure) { byDate[dateStr] = []; continue; }

        const [oh, om] = bh.open_time.split(':').map(Number);
        const [ch, cm] = bh.close_time.split(':').map(Number);
        const openMin = oh * 60 + om, closeMin = ch * 60 + cm;
        const allSlots = [];
        for (let m = openMin; m + slotDur <= closeMin; m += slotDur) {
          const hh = String(Math.floor(m / 60)).padStart(2, '0');
          const mm = String(m % 60).padStart(2, '0');
          allSlots.push(`${dateStr}T${hh}:${mm}:00`);
        }
        byDate[dateStr] = allSlots.filter(slotStart => {
          const sS = new Date(slotStart).getTime(), sE = sS + slotDur * 60000;
          const overlaps = b => new Date(b.start_at).getTime() < sE && new Date(b.end_at).getTime() > sS;
          if (blocks.some(overlaps)) return false;                 // manual block closes the slot
          return appts.filter(overlaps).length < cap;              // free while under parallel capacity
        });
      }
      appointmentSlots = { byDate, servicesList: apptServices };
    } catch (e) {
      console.error('[webhook] Error loading appointment slots:', e.message);
    }
  }
  const convState  = {
    delivery_choice:   convRow?.delivery_choice   || null,
    delivery_fee_calc: convRow?.delivery_fee_calc  ?? null,
  };

  // ── Handle WhatsApp location message ───────────────────────────────────────
  if (locationMsg && tenant.delivery_enabled && tenant.location_lat && tenant.location_lng) {
    const distKm = haversineKm(
      parseFloat(tenant.location_lat), parseFloat(tenant.location_lng),
      locationMsg.lat, locationMsg.lng
    );
    const fee = calcDeliveryFee(tenant, distKm);

    if (fee === null) {
      // Outside delivery zone
      await sendMessage(customerPhone,
        `📍 Recibí tu ubicación. Lamentablemente estás fuera de nuestra zona de envíos (${distKm.toFixed(1)} km). ` +
        `¿Querés pasar a retirar al local? 🏪`,
        phoneNumberId, token);
      return;
    }

    // Save delivery state and inject into history
    const systemNote = `[SISTEMA] El cliente compartió su ubicación (${distKm.toFixed(1)} km del local). Costo de envío calculado: ${formatPrice(fee, currency)}. Confirmá el total incluyendo el envío.`;
    const updatedHistory = [...history, { role: 'user', content: systemNote }];

    await supabase.from('conversations').upsert({
      tenant_id: tenant.id,
      customer_phone: customerPhone,
      messages_json: updatedHistory,
      updated_at: new Date().toISOString(),
      delivery_choice: 'envio',
      delivery_lat: locationMsg.lat,
      delivery_lng: locationMsg.lng,
      delivery_fee_calc: fee,
    }, { onConflict: 'tenant_id,customer_phone' });

    await sendMessage(customerPhone,
      `📍 ${distKm.toFixed(1)} km — 🚚 ${formatPrice(fee, currency)}`,
      phoneNumberId, token);
    return;
  }

  // ── Load restaurant data (if enabled and message might be about reservation) ─
  let restaurantZones = null, restaurantTables = null, upcomingReservations = null;
  const RESERVATION_KEYWORDS = /reserv|tavolo|table|mesa|posto|book|prenotaz|prenot|coperti|posto|seat/i;
  const mightBeAboutReservation = tenant.restaurant_enabled && (
    RESERVATION_KEYWORDS.test(messageText || '') ||
    history.slice(-4).some(m => RESERVATION_KEYWORDS.test(m.content))
  );
  if (tenant.restaurant_enabled) {
    [restaurantZones, restaurantTables] = await Promise.all([
      getRestaurantZones(tenant.id),
      getRestaurantTables(tenant.id),
    ]);
    if (mightBeAboutReservation) {
      upcomingReservations = await getUpcomingReservations(tenant.id, 7);
    }
  }

  // ── Normal text message → Claude ───────────────────────────────────────────
  const isFirstMessage = history.length === 0;
  const { reply, order, imageProductName, extraImagesProductName, customerName,
          deliveryChoice, deliveryAddress, offTopic, updatedHistory,
          appointmentRequest, waitlistProduct, reservationRequest, sendMenu } = await chat({
    tenant, stock, services, history,
    userMessage: messageText,
    convState,
    imageData: imageData || null,
    appointmentSlots,
    customerContext,
    closures,
    offers,
    businessHours,
    isFirstMessage,
    customerNotes: convRow?.customer_notes || null,
    restaurantZones,
    restaurantTables,
    upcomingReservations,
  });

  if (offTopic) {
    await sendMessage(customerPhone,
      '🙈 El contenido recibido no está relacionado con nuestros productos o servicios. ¿Puedo ayudarte con alguna consulta o pedido?',
      phoneNumberId, token);
    return;
  }

  // ── Handle delivery choice tag ──────────────────────────────────────────────
  const convUpdates = {};
  if (deliveryChoice) convUpdates.delivery_choice = deliveryChoice;

  // ── Handle delivery address tag → geocode ──────────────────────────────────
  if (deliveryAddress && tenant.delivery_enabled && tenant.location_lat && tenant.location_lng) {
    const coords = await geocode(deliveryAddress);
    if (coords) {
      const distKm = haversineKm(
        parseFloat(tenant.location_lat), parseFloat(tenant.location_lng),
        coords.lat, coords.lng
      );
      const fee = calcDeliveryFee(tenant, distKm);

      if (fee === null) {
        // Out of zone — inject note for next turn
        updatedHistory.push({
          role: 'user',
          content: `[SISTEMA] La dirección "${deliveryAddress}" está fuera de la zona de envíos (${distKm.toFixed(1)} km). Informá al cliente y ofrecé retiro en local.`
        });
      } else {
        convUpdates.delivery_lat      = coords.lat;
        convUpdates.delivery_lng      = coords.lng;
        convUpdates.delivery_address_text = deliveryAddress;
        convUpdates.delivery_fee_calc = fee;
        updatedHistory.push({
          role: 'user',
          content: `[SISTEMA] Dirección geocodificada: ${distKm.toFixed(1)} km del local. Costo de envío: ${formatPrice(fee, currency)}. Confirmá el total con el cliente.`
        });
      }
    } else {
      updatedHistory.push({
        role: 'user',
        content: `[SISTEMA] No se pudo geocodificar la dirección. Pedile al cliente que sea más específico o que comparta su ubicación por WhatsApp.`
      });
    }
  }

  // ── Handle order ────────────────────────────────────────────────────────────
  let savedOrderId = null;
  if (order) {
    const deliveryFee = convRow?.delivery_fee_calc ?? order.delivery_fee ?? 0;
    await decrementStock(tenant.id, order.items);

    const { data: savedOrder } = await supabase
      .from('orders')
      .insert({
        tenant_id: tenant.id,
        customer_phone: customerPhone,
        items_json: order.items,
        total_guarani: order.total_guarani,
        delivery_fee: deliveryFee,
        status: 'pending'
      })
      .select('id')
      .single();

    savedOrderId = savedOrder?.id;

    if (tenant.merchant_phone && savedOrderId) {
      const orderWithId = { ...order, delivery_fee: deliveryFee, id: savedOrderId };
      await notifyMerchant(tenant.merchant_phone, orderWithId, customerPhone, phoneNumberId, token, merchantLang.get(tenant.id) || 'es');

      await supabase.from('conversations').upsert({
        tenant_id: tenant.id,
        customer_phone: customerPhone,
        messages_json: updatedHistory,
        updated_at: new Date().toISOString(),
        last_pending_order_id: savedOrderId,
        last_pending_customer_phone: customerPhone,
        delivery_choice: null,
        delivery_fee_calc: null,
        delivery_lat: null,
        delivery_lng: null,
        ...convUpdates
      }, { onConflict: 'tenant_id,customer_phone' });
    }
  }

  // ── Handle appointment booking ──────────────────────────────────────────────
  if (appointmentRequest && tenant.appointments_enabled) {
    try {
      const { service_name, start_at, customer_name: apptCustomerName } = appointmentRequest;

      // Find matching service
      const svc = services.find(s =>
        s.name.toLowerCase() === (service_name || '').toLowerCase() && s.is_available
      );
      const duration = svc?.duration_min || 30;
      const end_at   = new Date(new Date(start_at).getTime() + duration * 60000).toISOString();

      // Enforce business hours / blocks / capacity — Sara is told the valid slots
      // but this guard stops out-of-hours bookings from ever being saved.
      const slotCheck = await checkSlotAvailability(tenant.id, start_at, end_at, tenant.appointment_capacity);
      if (!slotCheck.available) {
        updatedHistory.push({
          role: 'user',
          content: `[SISTEMA] El turno solicitado (${start_at}) NO es válido (${slotCheck.reason}${slotCheck.open ? `, horario ${slotCheck.open}-${slotCheck.close}` : ''}) y NO se agendó. Decile al cliente en su idioma que ese horario no está disponible y ofrecé horarios dentro del horario de atención.`
        });
      } else {
        const { data: savedAppt } = await supabase.from('appointments').insert({
          tenant_id:            tenant.id,
          customer_phone:       customerPhone,
          customer_name:        apptCustomerName || customerName || waProfileName || null,
          service_id:           svc?.id || null,
          service_name:         service_name || null,
          service_duration_min: duration,
          start_at,
          end_at,
          status: 'pending',
        }).select('id').single();

        // Notify merchant
        if (tenant.merchant_phone && savedAppt) {
          const startFmt = new Date(start_at).toLocaleString('es', {
            weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit'
          });
          const msg = `📅 *Nuevo turno solicitado*\n` +
            `👤 Cliente: ${apptCustomerName || customerPhone}\n` +
            `📱 Teléfono: +${customerPhone}\n` +
            `🛠 Servicio: ${service_name || '—'}\n` +
            `🕐 Fecha/Hora: ${startFmt}\n` +
            `⏱ Duración: ${duration} min\n\n` +
            `Respondé CONFIRMAR o CANCELAR el turno desde el panel.`;
          await sendMessage(tenant.merchant_phone, msg, phoneNumberId, token);
        }
      }
    } catch (e) {
      console.error('[webhook] Error saving appointment:', e.message);
    }
  }

  // ── Persist conversation ────────────────────────────────────────────────────
  if (!savedOrderId) {
    const upsertData = {
      tenant_id: tenant.id,
      customer_phone: customerPhone,
      messages_json: updatedHistory,
      updated_at: new Date().toISOString(),
      ...convUpdates
    };
    // Priority: Claude-detected name > WhatsApp profile name > existing name
    const nameToSave = customerName || waProfileName || null;
    if (nameToSave && !convRow?.customer_name) upsertData.customer_name = nameToSave;
    await supabase.from('conversations').upsert(upsertData, { onConflict: 'tenant_id,customer_phone' });
  } else if (!convRow?.customer_name) {
    const nameToSave = customerName || waProfileName || null;
    if (nameToSave) {
      await supabase.from('conversations')
        .update({ customer_name: nameToSave })
        .eq('tenant_id', tenant.id).eq('customer_phone', customerPhone);
    }
  }

  // ── Handle waitlist signup ──────────────────────────────────────────────────
  if (waitlistProduct) {
    await supabase.from('waitlist').upsert({
      tenant_id: tenant.id,
      customer_phone: customerPhone,
      product_name: waitlistProduct,
      created_at: new Date().toISOString(),
    }, { onConflict: 'tenant_id,customer_phone,product_name' });
  }

  // ── Handle restaurant reservation ──────────────────────────────────────────
  if (reservationRequest && tenant.restaurant_enabled) {
    try {
      const { customer_name, party_size, date, time, zone_preference, notes, status: reqStatus } = reservationRequest;
      const reservedAt = new Date(`${date}T${time || '20:00'}:00`).toISOString();
      const isPending = reqStatus === 'pending_merchant';

      // Enforce reservation time: day must be open and time must fall within
      // business hours (slot 1 or optional slot 2 for split schedules).
      const resHHMM   = (time || '20:00').slice(0, 5);
      const resDow    = new Date(`${date}T00:00:00`).getDay();
      const bhRow     = (businessHours || []).find(h => h.day_of_week === resDow);
      const dayClosed = bhRow ? bhRow.is_closed : false;
      const inSlot1   = bhRow && !bhRow.is_closed && bhRow.open_time && bhRow.close_time
        && resHHMM >= String(bhRow.open_time).slice(0,5) && resHHMM <= String(bhRow.close_time).slice(0,5);
      const inSlot2   = bhRow && bhRow.open_time_2 && bhRow.close_time_2
        && resHHMM >= String(bhRow.open_time_2).slice(0,5) && resHHMM <= String(bhRow.close_time_2).slice(0,5);
      const inHours   = !bhRow || inSlot1 || inSlot2;
      const validTime = !dayClosed && inHours;

      if (!validTime) {
        updatedHistory.push({
          role: 'user',
          content: `[SISTEMA] La reserva solicitada (${date} ${resHHMM}) NO es válida (${dayClosed ? 'local cerrado ese día' : 'fuera del horario de apertura'}) y NO se guardó. Informá al cliente en su idioma y ofrecé un horario dentro de los horarios disponibles.`
        });
      } else {

      // Auto-assign smallest available table and BLOCK it for this slot.
      // Re-fetch reservations fresh (the cached list may be null/stale) so two
      // customers can't both grab the last table in the same time window.
      // Party too big for any single table → escalate to the merchant (join
      // tables) instead of rejecting, same as Sara's explicit pending_merchant.
      const hasTables = restaurantTables?.length > 0;
      const fitsParty = !hasTables || restaurantTables.some(t => t.capacity >= party_size);
      const escalate  = isPending || (hasTables && !fitsParty);
      let tableId = null, zoneId = null, full = false;

      if (!escalate && hasTables) {
        const dur      = tenant.restaurant_slot_duration || 90;
        const CLEAN_MS = 10 * 60000;
        const reqStart = new Date(reservedAt).getTime();
        const reqEnd   = reqStart + dur * 60000;
        const existingRes = await getUpcomingReservations(tenant.id, 90);
        const occupied = r => (Array.isArray(r.table_ids) && r.table_ids.length) ? r.table_ids : (r.table_id ? [r.table_id] : []);
        const overlaps = r => {
          const rStart = new Date(r.reserved_at).getTime();
          const rEnd   = rStart + (r.duration_min || dur) * 60000;
          return Math.min(reqEnd, rEnd) - Math.max(reqStart, rStart) > CLEAN_MS;
        };

        // Smallest free table big enough for the party.
        const fitting = restaurantTables
          .filter(t => t.capacity >= party_size && !existingRes.some(r => overlaps(r) && occupied(r).includes(t.id)))
          .sort((a, b) => a.capacity - b.capacity);

        if (fitting.length) { tableId = fitting[0].id; zoneId = fitting[0].zone_id; }
        else {
          // No single table big enough is free — check if smaller tables are free to combine
          const anyFree = restaurantTables.some(t => !existingRes.some(r => overlaps(r) && occupied(r).includes(t.id)));
          if (anyFree) escalate = true; // merchant can combine smaller tables
          else full = true;
        }
      }

      if (full) {
        updatedHistory.push({
          role: 'user',
          content: `[SISTEMA] No hay mesas disponibles para ${party_size} personas el ${date} a las ${resHHMM} (todas ocupadas en esa franja). La reserva NO se guardó. Informá al cliente en su idioma, pedí disculpas y ofrecé otro horario u otra fecha disponible. No confirmes la reserva.`
        });
      } else {

      // Match zone_preference to zone_id if not assigned via table
      if (!zoneId && zone_preference && restaurantZones?.length) {
        const z = restaurantZones.find(z => z.name.toLowerCase().includes(zone_preference.toLowerCase()));
        if (z) zoneId = z.id;
      }

      const finalStatus = escalate ? 'pending_merchant' : 'confirmed';
      await supabase.from('reservations').insert({
        tenant_id: tenant.id,
        table_id: tableId || null,
        table_ids: tableId ? [tableId] : [],
        zone_id: zoneId || null,
        customer_name: customer_name || convRow?.customer_name || customerPhone,
        customer_phone: customerPhone,
        party_size: party_size || 2,
        reserved_at: reservedAt,
        duration_min: dur,
        status: finalStatus,
        notes: notes || null,
      });

      // Large-group / pending reservations need the merchant to coordinate.
      if (escalate && tenant.merchant_phone) {
        const dt = new Date(reservedAt).toLocaleString('es', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
        await sendMessage(tenant.merchant_phone,
          `⚠️ *Reserva grupo grande — requiere tu atención*\n👤 ${customer_name || customerPhone} (+${customerPhone})\n👥 ${party_size} personas\n📅 ${dt}\n\nContactá al cliente para coordinar los lugares.`,
          phoneNumberId, token);
      }
      } // end full else
      } // end validTime else
    } catch (e) {
      console.error('[reservation] error:', e.message);
    }
  }

  // ── Send product image ──────────────────────────────────────────────────────
  if (imageProductName) {
    const product = stock.find(p =>
      p.name.toLowerCase() === imageProductName.toLowerCase() && p.image_url
    );
    if (product?.image_url) {
      await sendImage(customerPhone, product.image_url, product.name, phoneNumberId, token);
    }
  }

  // ── Send extra product images ───────────────────────────────────────────────
  if (extraImagesProductName) {
    const ep = stock.find(p => p.name.toLowerCase() === extraImagesProductName.toLowerCase());
    if (ep?.additional_images?.length) {
      const toSend = ep.additional_images.slice(0, 2);
      for (let i = 0; i < toSend.length; i++) {
        await sendImage(customerPhone, toSend[i], `${ep.name} (${i + 1}/${ep.additional_images.length})`, phoneNumberId, token);
      }
    }
  }

  await sendMessage(customerPhone, reply, phoneNumberId, token);

  // ── Send full menu (restaurant) ─────────────────────────────────────────────
  if (sendMenu) {
    const menuText = buildMenuText(stock, tenant);
    if (menuText) await sendMessage(customerPhone, menuText, phoneNumberId, token);
  }
}

// Build a formatted WhatsApp menu from the live product catalog (restaurant).
// stock already contains only available products, ordered by category.
function buildMenuText(stock, tenant) {
  if (!stock || !stock.length) return null;
  const currency = tenant.plan_currency || 'PYG';
  const groups = new Map();
  for (const p of stock) {
    const cat = p.category || 'Otros';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(p);
  }
  const lines = [`🍽️ *${tenant.name}*\n`];
  for (const [cat, items] of groups) {
    lines.push(`*${cat.toUpperCase()}*`);
    for (const p of items) {
      lines.push(`• *${p.name}* — ${formatPrice(p.price_guarani, currency)}`);
      if (p.description) lines.push(`  ${p.description}`);
      if (p.allergens)   lines.push(`  ⚠️ ${p.allergens}`);
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

// ─── Takeover helpers ─────────────────────────────────────────────────────────

async function activateTakeover(tenant, conv, lang, phoneNumberId, token) {
  await supabase
    .from('conversations')
    .update({ takeover_active: true, takeover_started_at: new Date().toISOString() })
    .eq('id', conv.id);

  const customerPhone = conv.last_pending_customer_phone || conv.customer_phone;
  const customerLabel = conv.customer_name ? `*${conv.customer_name}* (+${customerPhone})` : `+${customerPhone}`;

  const TAKEOVER_ON = {
    es: `🟢 Estás hablando con ${customerLabel}.\nTus mensajes van directo al cliente.\nEnviá *STOP* para devolver el chat a Sara.`,
    it: `🟢 Stai parlando con ${customerLabel}.\nI tuoi messaggi vanno direttamente al cliente.\nInvia *STOP* per restituire la chat a Sara.`,
    en: `🟢 You're now chatting with ${customerLabel}.\nYour messages go directly to the customer.\nSend *STOP* to hand back to Sara.`,
    fr: `🟢 Vous parlez maintenant avec ${customerLabel}.\nVos messages vont directement au client.\nEnvoyez *STOP* pour rendre le chat à Sara.`,
    de: `🟢 Sie chatten jetzt mit ${customerLabel}.\nIhre Nachrichten gehen direkt an den Kunden.\nSenden Sie *STOP* um den Chat an Sara zurückzugeben.`,
    pt: `🟢 Você está falando com ${customerLabel}.\nSuas mensagens vão direto ao cliente.\nEnvie *STOP* para devolver o chat a Sara.`,
  };

  await sendMessage(tenant.merchant_phone, TAKEOVER_ON[lang] || TAKEOVER_ON.es, phoneNumberId, token);
  console.log(`[takeover] activated: tenant=${tenant.name} customer=${customerPhone}`);
}

async function confirmOrder(tenant, conv, phoneNumberId, token) {
  await supabase
    .from('orders')
    .update({ status: 'confirmed' })
    .eq('id', conv.last_pending_order_id);

  await supabase
    .from('conversations')
    .update({ last_pending_order_id: null })
    .eq('id', conv.id);

  const customerPhone = conv.last_pending_customer_phone || conv.customer_phone;

  await sendMessage(
    tenant.merchant_phone,
    `✅ Pedido confirmado. El cliente será notificado.`,
    phoneNumberId,
    token
  );

  let customerMsg = `🎉 ¡Tu pedido fue confirmado! Estamos preparando todo para vos.`;
  if (tenant.payment_instructions) {
    customerMsg += `\n\n${tenant.payment_instructions}`;
  }
  await sendMessage(customerPhone, customerMsg, phoneNumberId, token);

  console.log(`[webhook] Order confirmed by merchant: ${conv.last_pending_order_id}`);
}

async function cancelOrder(tenant, conv, phoneNumberId, token) {
  await supabase
    .from('orders')
    .update({ status: 'cancelled' })
    .eq('id', conv.last_pending_order_id);

  await supabase
    .from('conversations')
    .update({ last_pending_order_id: null })
    .eq('id', conv.id);

  const customerPhone = conv.last_pending_customer_phone || conv.customer_phone;

  await sendMessage(
    tenant.merchant_phone,
    `❌ Pedido cancelado. El cliente será notificado.`,
    phoneNumberId,
    token
  );

  await sendMessage(
    customerPhone,
    `Lo sentimos, no pudimos procesar tu pedido en este momento 😔 Por favor contactanos nuevamente o llamanos directamente.`,
    phoneNumberId,
    token
  );

  console.log(`[webhook] Order cancelled by merchant: ${conv.last_pending_order_id}`);
}

async function endTakeover(tenant, conv, phoneNumberId, token) {
  await supabase
    .from('conversations')
    .update({ takeover_active: false, takeover_started_at: null })
    .eq('id', conv.id);

  const customerPhone = conv.last_pending_customer_phone || conv.customer_phone;

  await sendMessage(
    tenant.merchant_phone,
    `🤖 Sara retoma el chat con +${customerPhone}.`,
    phoneNumberId,
    token
  );

  await sendMessage(
    customerPhone,
    `¡Gracias por tu paciencia! 😊 Soy Sara, ¿en qué más puedo ayudarte?`,
    phoneNumberId,
    token
  );

  console.log(`[takeover] ended: tenant=${tenant.name} customer=${customerPhone}`);
}

module.exports = router;
