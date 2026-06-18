const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { getTenantConfig, getStock, decrementStock, getServices } = require('../services/stock');
const { sendMessage, sendImage, notifyMerchant } = require('../services/whatsapp');
const { chat } = require('../services/claude');
const { downloadAndStore, uploadImageBuffer } = require('../services/storage');
const { haversineKm, geocode, calcDeliveryFee } = require('../services/geo');
const { check: rateCheck, blockMessage } = require('../services/ratelimit');
const { fetchMedia } = require('../services/media');
const { transcribeAudio } = require('../services/transcribe');

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
router.post('/', (req, res) => {
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
    if (messageType === 'image') {
      await handleMerchantImage(tenant, message, phoneNumberId, token);
    } else if (messageType === 'text') {
      await handleMerchantMessage(tenant, messageText, phoneNumberId, token);
    }
    // Ignore merchant audio/location/etc.
    return;
  }

  // ── Customer rate limiting ───────────────────────────────────────────────────
  const rlType = messageType === 'image' ? 'image' : messageType === 'audio' ? 'audio' : 'text';
  const rl = rateCheck(tenant.id, senderPhone, rlType);
  if (!rl.allowed) {
    if (rl.notify) {
      await sendMessage(senderPhone, blockMessage(rl.reason), phoneNumberId, token);
    }
    return;
  }

  // ── Log potential prompt injection attempts (don't block — no feedback to attacker) ─────
  if (messageText) {
    const injectionPatterns = /ignore.*instruct|system\s*:|prompt\s*:|jailbreak|act as|modo desarrollador|developer mode|sin restricciones|unrestricted|ignore previous|olvida.*instruc|ignora.*instruc/i;
    if (injectionPatterns.test(messageText)) {
      console.warn(`[security] Possible prompt injection attempt from ${senderPhone} on tenant ${tenant.id}: "${messageText.slice(0, 100)}"`);
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
          'No entendí bien el audio 😕 ¿Podés escribirme lo que necesitás?',
          phoneNumberId, token);
        return;
      }
      console.log(`[webhook] Audio transcribed (${senderPhone}): "${transcription}"`);
      await handleCustomerMessage(tenant, senderPhone, transcription, null, null, waProfileName, phoneNumberId, token);
    } catch (e) {
      console.error('[webhook] Audio transcription error:', e.message);
      await sendMessage(senderPhone,
        'No pude procesar el audio 😕 ¿Podés escribirme tu consulta?',
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
const merchantPending = new Map(); // tenantId → pending confirmation state

// Multi-language response templates
const MT = {
  stock_set:        { es:(n,q)=>`✅ *${n}*\nStock: ${q} unidades.`, it:(n,q)=>`✅ *${n}*\nStock: ${q} unità.`, en:(n,q)=>`✅ *${n}*\nStock: ${q} units.`, fr:(n,q)=>`✅ *${n}*\nStock: ${q} unités.`, de:(n,q)=>`✅ *${n}*\nBestand: ${q} Einheiten.`, pt:(n,q)=>`✅ *${n}*\nEstoque: ${q} unidades.` },
  stock_added:      { es:(n,d,t)=>`✅ *${n}*\n+${d} agregadas → ${t} en total.`, it:(n,d,t)=>`✅ *${n}*\n+${d} aggiunte → ${t} in totale.`, en:(n,d,t)=>`✅ *${n}*\n+${d} added → ${t} total.`, fr:(n,d,t)=>`✅ *${n}*\n+${d} ajoutées → ${t} au total.`, de:(n,d,t)=>`✅ *${n}*\n+${d} hinzugefügt → ${t} gesamt.`, pt:(n,d,t)=>`✅ *${n}*\n+${d} adicionadas → ${t} no total.` },
  stock_removed:    { es:(n,d,t)=>`✅ *${n}*\n-${d} descontadas → ${t} en total.`, it:(n,d,t)=>`✅ *${n}*\n-${d} rimosse → ${t} in totale.`, en:(n,d,t)=>`✅ *${n}*\n-${d} removed → ${t} total.`, fr:(n,d,t)=>`✅ *${n}*\n-${d} retirées → ${t} au total.`, de:(n,d,t)=>`✅ *${n}*\n-${d} entfernt → ${t} gesamt.`, pt:(n,d,t)=>`✅ *${n}*\n-${d} removidas → ${t} no total.` },
  price_updated:    { es:(n,p)=>`✅ *${n}*\nPrecio: ${p.toLocaleString()} Gs.`, it:(n,p)=>`✅ *${n}*\nPrezzo: ${p.toLocaleString()} Gs.`, en:(n,p)=>`✅ *${n}*\nPrice: ${p.toLocaleString()} Gs.`, fr:(n,p)=>`✅ *${n}*\nPrix: ${p.toLocaleString()} Gs.`, de:(n,p)=>`✅ *${n}*\nPreis: ${p.toLocaleString()} Gs.`, pt:(n,p)=>`✅ *${n}*\nPreço: ${p.toLocaleString()} Gs.` },
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
};

function mt(lang, key, ...args) {
  const l = MT[key]?.[lang] ? lang : 'es';
  return MT[key][l](...args);
}

async function parseMerchantIntent(messageText, products) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const catalog = products.length
    ? products.map(p => `• ${p.name} (stock: ${p.stock_qty ?? 'N/A'}, price: ${p.price_guarani})`).join('\n')
    : 'empty';
  const resp = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    system: `You parse merchant WhatsApp messages. Return ONLY valid JSON, no explanation.
Actions: update_stock (delta ±), set_stock (absolute), set_price, mark_unavailable, mark_available, add_product, get_catalog, confirm_order, cancel_order, chat_takeover, name_customer, unknown.
JSON schema: {"action":"...","product_query":null,"params":{},"language":"es|it|en|fr|de|pt"}
params.update_stock: {"delta": N} — positive=add ("ho ricevuto 50 rose", "arrivate 50", "+50"), negative=remove ("vendute 10", "leva 10", "meno 10", "sold 10")
params.set_stock: {"qty": N} — absolute ("il nuovo stock è 50", "stock = 50 rose")
params.set_price: {"price": N}
params.add_product: {"name":"...","category":"...","price":0,"stock":0,"description":null}
params.name_customer: {"phone":"...","name":"..."}
params.chat_takeover: {"customer_query":"..."} — name or partial phone the merchant mentions ("parla con Giuseppe", "talk to the one ending in 335", "chatta con Mario"). If no specific customer mentioned, customer_query=null.
Detect language from the message (iso 639-1).`,
    messages: [{ role: 'user', content: `Catalog:\n${catalog}\n\nMessage: ${messageText}` }],
  });
  try {
    return JSON.parse(resp.content[0].text.trim());
  } catch {
    return { action: 'unknown', product_query: null, params: {}, language: 'es' };
  }
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

async function executeMerchantAction(tenant, action, product, params, lang, phoneNumberId, token) {
  if (action === 'update_stock') {
    const delta = params.delta || 0;
    const newQty = Math.max(0, (product.stock_qty || 0) + delta);
    await supabase.from('products').update({ stock_qty: newQty, is_available: newQty > 0 }).eq('id', product.id);
    const key = delta > 0 ? 'stock_added' : 'stock_removed';
    await sendMessage(tenant.merchant_phone, mt(lang, key, product.name, Math.abs(delta), newQty), phoneNumberId, token);
    return;
  }
  if (action === 'set_stock') {
    const qty = params.qty ?? 0;
    await supabase.from('products').update({ stock_qty: qty, is_available: qty > 0 }).eq('id', product.id);
    await sendMessage(tenant.merchant_phone, mt(lang, 'stock_set', product.name, qty), phoneNumberId, token);
    return;
  }
  if (action === 'set_price') {
    const price = params.price || 0;
    await supabase.from('products').update({ price_guarani: price }).eq('id', product.id);
    await sendMessage(tenant.merchant_phone, mt(lang, 'price_updated', product.name, price), phoneNumberId, token);
    return;
  }
  if (action === 'mark_unavailable') {
    await supabase.from('products').update({ is_available: false, stock_qty: 0 }).eq('id', product.id);
    await sendMessage(tenant.merchant_phone, mt(lang, 'unavailable', product.name), phoneNumberId, token);
    return;
  }
  if (action === 'mark_available') {
    const qty = product.stock_qty || 1;
    await supabase.from('products').update({ is_available: true, stock_qty: qty }).eq('id', product.id);
    await sendMessage(tenant.merchant_phone, mt(lang, 'available', product.name), phoneNumberId, token);
    return;
  }
}

// ─── Merchant message handler ─────────────────────────────────────────────────

async function handleMerchantMessage(tenant, messageText, phoneNumberId, token) {
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
  const pending = merchantPending.get(tenant.id);
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
          if (byName.length === 1) { merchantPending.delete(tenant.id); await executeMerchantAction(tenant, pending.action, byName[0], pending.params, pending.lang, phoneNumberId, token); return; }
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

      // Not a recognizable confirmation — clear pending and treat as new command
      merchantPending.delete(tenant.id);
    }
  }

  // ── NL intent parsing ─────────────────────────────────────────────────────
  const { data: products } = await supabase
    .from('products')
    .select('id, name, stock_qty, price_guarani, is_available')
    .eq('tenant_id', tenant.id);

  const allProducts = products || [];
  const intent = await parseMerchantIntent(messageText, allProducts);
  const lang = intent.language || 'es';

  // ── Catalog ───────────────────────────────────────────────────────────────
  if (intent.action === 'get_catalog') {
    if (!allProducts.length) {
      await sendMessage(tenant.merchant_phone, mt(lang, 'catalog_empty'), phoneNumberId, token);
      return;
    }
    const lines = allProducts.map(p => {
      const estado = !p.is_available ? '🔴' : p.stock_qty === 0 ? '🔴' : `🟢 ${p.stock_qty}`;
      return `• *${p.name}* — ${p.price_guarani.toLocaleString()} Gs — ${estado}`;
    });
    await sendMessage(tenant.merchant_phone, `📦 *${allProducts.length} productos:*\n\n${lines.join('\n')}`, phoneNumberId, token);
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

  if (intent.action === 'confirm_order' || intent.action === 'cancel_order') {
    const { data: conv } = await supabase
      .from('conversations').select('*').eq('tenant_id', tenant.id)
      .not('last_pending_order_id', 'is', null)
      .order('updated_at', { ascending: false }).limit(1).maybeSingle();
    if (!conv?.last_pending_order_id) {
      await sendMessage(tenant.merchant_phone, mt(lang, 'no_pending_order'), phoneNumberId, token);
      return;
    }
    if (intent.action === 'confirm_order') { await confirmOrder(tenant, conv, phoneNumberId, token); return; }
    if (intent.action === 'cancel_order')  { await cancelOrder(tenant, conv, phoneNumberId, token); return; }
  }

  // ── Add product ───────────────────────────────────────────────────────────
  if (intent.action === 'add_product') {
    const { name, category, price, stock, description } = intent.params;
    if (!name) { await sendMessage(tenant.merchant_phone, mt(lang, 'unknown'), phoneNumberId, token); return; }
    await supabase.from('products').insert({
      tenant_id: tenant.id,
      name, category: category || 'General',
      price_guarani: price || 0,
      stock_qty: stock || 0,
      description: description || null,
      is_available: (stock || 0) > 0,
    });
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

  // ── Unknown ───────────────────────────────────────────────────────────────
  if (intent.action === 'unknown') {
    await sendMessage(tenant.merchant_phone, mt(lang, 'unknown'), phoneNumberId, token);
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

// ─── Merchant image handler ───────────────────────────────────────────────────

async function handleMerchantImage(tenant, message, phoneNumberId, token) {
  const mediaId = message.image?.id;
  const caption = message.image?.caption?.trim() || null;

  if (!mediaId) return;

  // If no caption → ask which product
  if (!caption) {
    await sendMessage(
      tenant.merchant_phone,
      '📸 ¡Foto recibida! Reenviala con el *nombre del producto* como caption (texto de la foto) para que la pueda asociar.\n\nEjemplo: enviá la foto con el texto "Ramo de Rosas Rojas"',
      phoneNumberId,
      token
    );
    return;
  }

  await sendMessage(tenant.merchant_phone, `⏳ Subiendo foto para "${caption}"...`, phoneNumberId, token);

  try {
    const allP = await getProductsForTenant(tenant.id);
    const matches = findProductsFuzzy(allP, caption);
    const product = matches[0] || null;
    if (!product) {
      await sendMessage(
        tenant.merchant_phone,
        `⚠️ No encontré el producto: "${caption}". Verificá el nombre en el catálogo.`,
        phoneNumberId,
        token
      );
      return;
    }

    // Download from Meta and upload to Supabase Storage
    const whatsappToken = tenant.whatsapp_token || process.env.WHATSAPP_TOKEN;
    const publicUrl = await downloadAndStore(mediaId, whatsappToken, product.name, tenant.id);

    // Save URL to product
    await supabase.from('products').update({ image_url: publicUrl }).eq('id', product.id);

    await sendMessage(
      tenant.merchant_phone,
      `✅ ¡Foto guardada para *${product.name}*!\nAhora Sara la enviará automáticamente cuando los clientes pregunten por este producto.`,
      phoneNumberId,
      token
    );
    console.log(`[storage] Image uploaded for product "${product.name}": ${publicUrl}`);

  } catch (err) {
    console.error('[storage] Image upload error:', err.message);
    await sendMessage(
      tenant.merchant_phone,
      `❌ Error al subir la foto. Intentá de nuevo en un momento.`,
      phoneNumberId,
      token
    );
  }
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
  const [stock, services] = await Promise.all([
    getStock(tenant.id),
    getServices(tenant.id),
  ]);

  // ── Load appointment slots for next 14 days (if feature enabled AND relevant) ─
  // Skip the 3 extra queries + large prompt block when the conversation has no
  // sign of being about booking — avoids wasting AI tokens on unrelated chats.
  const APPOINTMENT_KEYWORDS = /reserv|agend|turno|turnos|cita|citas|disponibil|horari|appointment|booking|schedule|atendimento|prenota|appuntamento|hora libre|hora disponible/i;
  const mightBeAboutAppointments = tenant.appointments_enabled && (
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
      const busy = [...(existingRes.data || []), ...(blocksRes.data || [])];
      const slotDur = apptServices[0]?.duration_min || 30;

      const byDate = {};
      for (let i = 0; i < 14; i++) {
        const d = new Date(today); d.setDate(d.getDate() + i);
        const dateStr = d.toISOString().slice(0, 10);
        const bh = bhMap[d.getDay()];
        if (!bh || bh.is_closed) { byDate[dateStr] = []; continue; }

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
          return !busy.some(b => new Date(b.start_at).getTime() < sE && new Date(b.end_at).getTime() > sS);
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
    const systemNote = `[SISTEMA] El cliente compartió su ubicación (${distKm.toFixed(1)} km del local). Costo de envío calculado: ${fee.toLocaleString('es-PY')} Gs. Confirmá el total incluyendo el envío.`;
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
      `📍 ¡Ubicación recibida! Estás a ${distKm.toFixed(1)} km del local.\n` +
      `🚚 Costo de envío: *${fee.toLocaleString('es-PY')} Gs*\n\nConfirmamos tu pedido con este costo de envío incluido.`,
      phoneNumberId, token);
    return;
  }

  // ── Normal text message → Claude ───────────────────────────────────────────
  const { reply, order, imageProductName, customerName,
          deliveryChoice, deliveryAddress, offTopic, updatedHistory,
          appointmentRequest } = await chat({
    tenant, stock, services, history,
    userMessage: messageText,
    convState,
    imageData: imageData || null,
    appointmentSlots,
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
          content: `[SISTEMA] Dirección geocodificada: ${distKm.toFixed(1)} km del local. Costo de envío: ${fee.toLocaleString('es-PY')} Gs. Confirmá el total con el cliente.`
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
      await notifyMerchant(tenant.merchant_phone, orderWithId, customerPhone, phoneNumberId, token);

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

  // ── Send product image ──────────────────────────────────────────────────────
  if (imageProductName) {
    const product = stock.find(p =>
      p.name.toLowerCase() === imageProductName.toLowerCase() && p.image_url
    );
    if (product?.image_url) {
      await sendImage(customerPhone, product.image_url, product.name, phoneNumberId, token);
    }
  }

  await sendMessage(customerPhone, reply, phoneNumberId, token);
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
  await sendMessage(customerPhone, `En este momento te atiendo yo directamente 👋 ¿En qué te ayudo?`, phoneNumberId, token);
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
