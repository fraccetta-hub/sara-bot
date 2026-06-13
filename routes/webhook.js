const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { getTenantConfig, getStock, decrementStock, getServices } = require('../services/stock');
const { sendMessage, sendImage, notifyMerchant } = require('../services/whatsapp');
const { chat } = require('../services/claude');
const { downloadAndStore } = require('../services/storage');
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


  const messageText = messageType === 'text' ? message.text.body.trim() : null;

  // 1. Identify tenant
  const tenant = await getTenantConfig(phoneNumberId);
  if (!tenant) {
    console.error(`[webhook] No tenant for phone_number_id=${phoneNumberId}`);
    return;
  }

  const token = tenant.whatsapp_token || process.env.WHATSAPP_TOKEN;

  // 2. Kill switch
  if (!tenant.active) {
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
      const imageData = { base64: buffer.toString('base64'), mimeType };
      await handleCustomerMessage(tenant, senderPhone, caption, null, imageData, waProfileName, phoneNumberId, token);
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

// ─── Merchant message handler ────────────────────────────────────────────────

async function handleMerchantMessage(tenant, messageText, phoneNumberId, token) {
  const cmdUpper = messageText.toUpperCase().trim();
  const firstWord = cmdUpper.split(/\s+/)[0];

  // ── Catalog management commands ──────────────────────────────────────────

  if (firstWord === 'CATALOGO') {
    await cmdCatalogo(tenant, phoneNumberId, token);
    return;
  }

  if (firstWord === 'STOCK') {
    await cmdStock(tenant, messageText, phoneNumberId, token);
    return;
  }

  if (firstWord === 'PRECIO') {
    await cmdPrecio(tenant, messageText, phoneNumberId, token);
    return;
  }

  if (firstWord === 'AGOTADO') {
    await cmdAgotado(tenant, messageText, false, phoneNumberId, token);
    return;
  }

  if (firstWord === 'DISPONIBLE') {
    await cmdAgotado(tenant, messageText, true, phoneNumberId, token);
    return;
  }

  if (firstWord === 'NUEVO') {
    await cmdNuevo(tenant, messageText, phoneNumberId, token);
    return;
  }

  if (firstWord === 'NOMBRE') {
    await cmdNombre(tenant, messageText, phoneNumberId, token);
    return;
  }

  if (firstWord === 'AYUDA' || firstWord === 'HELP') {
    await sendMessage(tenant.merchant_phone, AYUDA_TEXT, phoneNumberId, token);
    return;
  }

  // ── Order management commands ─────────────────────────────────────────────

  // Look up the most recent pending-action conversation for this tenant
  const { data: conv } = await supabase
    .from('conversations')
    .select('*')
    .eq('tenant_id', tenant.id)
    .not('last_pending_order_id', 'is', null)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (cmdUpper === 'CHAT' || cmdUpper === '3') {
    if (!conv) {
      await sendMessage(tenant.merchant_phone, '⚠️ No hay ningún pedido activo para tomar el chat.', phoneNumberId, token);
      return;
    }
    await activateTakeover(tenant, conv, phoneNumberId, token);
    return;
  }

  if (cmdUpper === 'CONFIRMAR' || cmdUpper === '1') {
    if (!conv?.last_pending_order_id) {
      await sendMessage(tenant.merchant_phone, '⚠️ No hay ningún pedido pendiente para confirmar.', phoneNumberId, token);
      return;
    }
    await confirmOrder(tenant, conv, phoneNumberId, token);
    return;
  }

  if (cmdUpper === 'CANCELAR' || cmdUpper === '2') {
    if (!conv?.last_pending_order_id) {
      await sendMessage(tenant.merchant_phone, '⚠️ No hay ningún pedido pendiente para cancelar.', phoneNumberId, token);
      return;
    }
    await cancelOrder(tenant, conv, phoneNumberId, token);
    return;
  }

  if (cmdUpper === 'FIN' || cmdUpper === 'BOT') {
    const { data: activeConv } = await supabase
      .from('conversations')
      .select('*')
      .eq('tenant_id', tenant.id)
      .eq('takeover_active', true)
      .maybeSingle();

    if (!activeConv) {
      await sendMessage(tenant.merchant_phone, '⚠️ No hay ningún chat en modo takeover activo.', phoneNumberId, token);
      return;
    }
    await endTakeover(tenant, activeConv, phoneNumberId, token);
    return;
  }

  // ── Free-text in takeover mode — forward to customer ─────────────────────
  const { data: activeConv } = await supabase
    .from('conversations')
    .select('*')
    .eq('tenant_id', tenant.id)
    .eq('takeover_active', true)
    .maybeSingle();

  if (activeConv?.last_pending_customer_phone) {
    await sendMessage(activeConv.last_pending_customer_phone, messageText, phoneNumberId, token);
    console.log(`[takeover] merchant→customer: ${activeConv.last_pending_customer_phone}`);
  } else {
    await sendMessage(tenant.merchant_phone, AYUDA_TEXT, phoneNumberId, token);
  }
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
    // Find the product
    const product = await findProduct(tenant.id, caption);
    if (!product) {
      await sendMessage(
        tenant.merchant_phone,
        `⚠️ No encontré el producto: "${caption}"\nUsá *CATALOGO* para ver los nombres disponibles.`,
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

// ─── Catalog command helpers ──────────────────────────────────────────────────

const AYUDA_TEXT =
  `📋 *Comandos disponibles:*\n\n` +
  `*📦 Catálogo:*\n` +
  `• CATALOGO — ver todos los productos\n` +
  `• STOCK Nombre del producto 10 — actualizar stock\n` +
  `• PRECIO Nombre del producto 150000 — cambiar precio\n` +
  `• AGOTADO Nombre del producto — marcar sin stock\n` +
  `• DISPONIBLE Nombre del producto — reactivar producto\n` +
  `• NUEVO Nombre|Categoría|Precio|Stock|Descripción — agregar producto\n\n` +
  `*👤 Clientes:*\n` +
  `• NOMBRE +595981234567 Francesco — guardar nombre de un cliente\n\n` +
  `*🛒 Pedidos:*\n` +
  `• CONFIRMAR — aceptar pedido pendiente\n` +
  `• CANCELAR — rechazar pedido pendiente\n` +
  `• CHAT — tomar chat con el cliente\n` +
  `• FIN — devolver chat a Sara`;

async function cmdCatalogo(tenant, phoneNumberId, token) {
  const { data: products } = await supabase
    .from('products')
    .select('name, category, price_guarani, stock_qty, is_available')
    .eq('tenant_id', tenant.id)
    .order('category');

  if (!products?.length) {
    await sendMessage(tenant.merchant_phone, '📦 No tenés productos cargados todavía.', phoneNumberId, token);
    return;
  }

  const lines = products.map(p => {
    const estado = !p.is_available ? '🔴 AGOTADO' : p.stock_qty === 0 ? '🔴 Sin stock' : `🟢 Stock: ${p.stock_qty}`;
    return `• *${p.name}*\n  ${p.category} — ${p.price_guarani.toLocaleString('es-PY')} Gs — ${estado}`;
  });

  await sendMessage(
    tenant.merchant_phone,
    `📦 *Tu catálogo (${products.length} productos):*\n\n${lines.join('\n\n')}`,
    phoneNumberId,
    token
  );
}

async function cmdStock(tenant, messageText, phoneNumberId, token) {
  // Format: STOCK nombre del producto 10
  const match = messageText.match(/^STOCK\s+(.+?)\s+(\d+)$/i);
  if (!match) {
    await sendMessage(tenant.merchant_phone, '⚠️ Formato: *STOCK Nombre del producto 10*', phoneNumberId, token);
    return;
  }
  const [, nameRaw, qtyStr] = match;
  const qty = parseInt(qtyStr);
  const product = await findProduct(tenant.id, nameRaw);
  if (!product) {
    await sendMessage(tenant.merchant_phone, `⚠️ No encontré el producto: "${nameRaw}"\nUsá CATALOGO para ver los nombres exactos.`, phoneNumberId, token);
    return;
  }
  await supabase.from('products').update({ stock_qty: qty, is_available: qty > 0 }).eq('id', product.id);
  await sendMessage(tenant.merchant_phone, `✅ *${product.name}*\nStock actualizado a ${qty} unidades.`, phoneNumberId, token);
}

async function cmdPrecio(tenant, messageText, phoneNumberId, token) {
  // Format: PRECIO nombre del producto 150000
  const match = messageText.match(/^PRECIO\s+(.+?)\s+(\d+)$/i);
  if (!match) {
    await sendMessage(tenant.merchant_phone, '⚠️ Formato: *PRECIO Nombre del producto 150000*', phoneNumberId, token);
    return;
  }
  const [, nameRaw, priceStr] = match;
  const price = parseInt(priceStr);
  const product = await findProduct(tenant.id, nameRaw);
  if (!product) {
    await sendMessage(tenant.merchant_phone, `⚠️ No encontré el producto: "${nameRaw}"\nUsá CATALOGO para ver los nombres exactos.`, phoneNumberId, token);
    return;
  }
  await supabase.from('products').update({ price_guarani: price }).eq('id', product.id);
  await sendMessage(tenant.merchant_phone, `✅ *${product.name}*\nPrecio actualizado a ${price.toLocaleString('es-PY')} Gs.`, phoneNumberId, token);
}

async function cmdAgotado(tenant, messageText, disponible, phoneNumberId, token) {
  const prefix = disponible ? 'DISPONIBLE' : 'AGOTADO';
  const nameRaw = messageText.replace(new RegExp(`^${prefix}\\s+`, 'i'), '').trim();
  if (!nameRaw) {
    await sendMessage(tenant.merchant_phone, `⚠️ Formato: *${prefix} Nombre del producto*`, phoneNumberId, token);
    return;
  }
  const product = await findProduct(tenant.id, nameRaw);
  if (!product) {
    await sendMessage(tenant.merchant_phone, `⚠️ No encontré el producto: "${nameRaw}"\nUsá CATALOGO para ver los nombres exactos.`, phoneNumberId, token);
    return;
  }
  await supabase.from('products').update({
    is_available: disponible,
    stock_qty: disponible ? (product.stock_qty || 1) : 0
  }).eq('id', product.id);

  const icon = disponible ? '✅' : '🔴';
  const estado = disponible ? 'marcado como disponible' : 'marcado como agotado';
  await sendMessage(tenant.merchant_phone, `${icon} *${product.name}*\n${estado}.`, phoneNumberId, token);
}

async function cmdNuevo(tenant, messageText, phoneNumberId, token) {
  // Format: NUEVO Nombre|Categoría|Precio|Stock|Descripción
  const body = messageText.replace(/^NUEVO\s+/i, '').trim();
  const parts = body.split('|').map(s => s.trim());
  if (parts.length < 4) {
    await sendMessage(
      tenant.merchant_phone,
      '⚠️ Formato:\n*NUEVO Nombre|Categoría|Precio|Stock|Descripción*\n\nEjemplo:\nNUEVO Ramo de Girasoles|Ramos|120000|10|Girasoles frescos importados',
      phoneNumberId, token
    );
    return;
  }
  const [name, category, priceStr, stockStr, ...descParts] = parts;
  const price = parseInt(priceStr);
  const stock = parseInt(stockStr);
  const description = descParts.join('|') || null;

  if (isNaN(price) || isNaN(stock)) {
    await sendMessage(tenant.merchant_phone, '⚠️ Precio y stock deben ser números.', phoneNumberId, token);
    return;
  }

  await supabase.from('products').insert({
    tenant_id: tenant.id,
    name, category, price_guarani: price, stock_qty: stock,
    description, is_available: stock > 0
  });

  await sendMessage(
    tenant.merchant_phone,
    `✅ Producto agregado:\n*${name}*\nCategoría: ${category}\nPrecio: ${price.toLocaleString('es-PY')} Gs\nStock: ${stock}${description ? `\nDesc: ${description}` : ''}`,
    phoneNumberId, token
  );
}

async function cmdNombre(tenant, messageText, phoneNumberId, token) {
  // Format: NOMBRE +595981234567 Francesco  (or without +)
  const match = messageText.match(/^NOMBRE\s+\+?(\d+)\s+(.+)$/i);
  if (!match) {
    await sendMessage(tenant.merchant_phone,
      '⚠️ Formato: *NOMBRE +595981234567 Francesco*', phoneNumberId, token);
    return;
  }
  const [, phone, name] = match;
  const { error } = await supabase
    .from('conversations')
    .update({ customer_name: name.trim() })
    .eq('tenant_id', tenant.id)
    .eq('customer_phone', phone);

  if (error) {
    await sendMessage(tenant.merchant_phone,
      `⚠️ No encontré conversación con +${phone}.`, phoneNumberId, token);
    return;
  }
  await sendMessage(tenant.merchant_phone,
    `✅ Cliente +${phone} guardado como *${name.trim()}*.`, phoneNumberId, token);
}

// Fuzzy product lookup — case-insensitive partial match
async function findProduct(tenantId, nameQuery) {
  const { data: products } = await supabase
    .from('products')
    .select('id, name, stock_qty')
    .eq('tenant_id', tenantId)
    .ilike('name', `%${nameQuery}%`)
    .limit(1);
  return products?.[0] || null;
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

  const history    = convRow?.messages_json || [];
  const [stock, services] = await Promise.all([
    getStock(tenant.id),
    getServices(tenant.id),
  ]);

  // ── Load appointment slots for next 14 days (if feature enabled) ────────────
  let appointmentSlots = null;
  if (tenant.appointments_enabled) {
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

async function activateTakeover(tenant, conv, phoneNumberId, token) {
  await supabase
    .from('conversations')
    .update({ takeover_active: true, takeover_started_at: new Date().toISOString() })
    .eq('id', conv.id);

  const customerPhone = conv.last_pending_customer_phone || conv.customer_phone;

  await sendMessage(
    tenant.merchant_phone,
    `✅ Chat directo activado con +${customerPhone}.\nTus mensajes llegarán directamente al cliente.\nCuando termines, respondé *FIN* para devolver el chat a Sara.`,
    phoneNumberId,
    token
  );

  await sendMessage(
    customerPhone,
    `En este momento te atiendo yo directamente 👋 ¿En qué te ayudo?`,
    phoneNumberId,
    token
  );

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
