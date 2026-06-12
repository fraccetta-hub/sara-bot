const Anthropic = require('@anthropic-ai/sdk');
const { isDeliveryDisabledToday, describeDelivery } = require('./geo');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MAX_HISTORY = 20;

function buildSystemPrompt(tenant, stock, convState = {}) {
  const botName = tenant.bot_name || 'Sara';
  const personality = tenant.bot_personality || 'cálida, profesional y entusiasta';

  const catalog = stock.length
    ? stock.map(p =>
        `• ${p.name} [${p.category}] — ${p.price_guarani.toLocaleString('es-PY')} Gs` +
        (p.stock_qty > 0 ? ` (${p.stock_qty} disponibles)` : ' (AGOTADO)') +
        (p.description ? ` — ${p.description}` : '') +
        (p.image_url ? ' [tiene foto]' : '')
      ).join('\n')
    : '(Catálogo vacío — consultá con el local)';

  const paymentBlock = tenant.payment_instructions
    ? `\nINFORMACIÓN DE PAGO:\n${tenant.payment_instructions}`
    : '';

  // ── Delivery block ──────────────────────────────────────────────────────────
  let deliveryBlock = '';
  if (tenant.delivery_enabled) {
    const info = describeDelivery(tenant);
    const disabledToday = isDeliveryDisabledToday(tenant);
    const min = tenant.delivery_min_order || 0;
    const feeCalc = convState.delivery_fee_calc;
    const choice = convState.delivery_choice;

    deliveryBlock = `
ENTREGAS:
- El local ${disabledToday ? '⚠️ HOY NO HACE ENVÍOS (día deshabilitado)' : 'hace envíos a domicilio'}.
- Tarifa: ${info.tarifa}.
${min > 0 ? `- Monto mínimo para envío: ${min.toLocaleString('es-PY')} Gs.` : ''}
${feeCalc != null ? `- Costo de envío YA CALCULADO: ${feeCalc.toLocaleString('es-PY')} Gs. Incluilo en el total al confirmar.` : ''}
${choice === 'retiro' ? '- El cliente eligió RETIRO EN LOCAL. No cobrar envío.' : ''}
${choice === 'envio' && feeCalc == null ? '- El cliente eligió ENVÍO. Pedile la dirección o que comparta su ubicación por WhatsApp.' : ''}

REGLAS DE ENTREGA (solo cuando el cliente quiera confirmar un pedido):
D1. Si hoy no hay envíos: informá amablemente y ofrecé solo retiro en local.
D2. Si el total del pedido es menor al mínimo (${min.toLocaleString('es-PY')} Gs): decile cuánto le falta y preguntá si quiere agregar algo. NO procedas con el pedido todavía.
D3. Si no hay restricciones y el cliente no eligió aún: preguntá "¿Retirás en el local o querés envío a domicilio?" y marcá con <DELIVERY_CHOICE:retiro> o <DELIVERY_CHOICE:envio>.
D4. Si eligió envío y no hay dirección aún: pedile la dirección exacta o que comparta su ubicación de WhatsApp. Cuando el cliente escriba una dirección usá: <DELIVERY_ADDRESS:dirección completa>.
D5. Una vez calculado el envío (el sistema te lo informa), confirmá el total incluyendo el costo de envío antes de generar el <ORDER>.`;
  }

  return `Eres ${botName}, la asistente de ${tenant.name}. Tu personalidad: ${personality}.
IMPORTANTE: Siempre respondés en el MISMO IDIOMA que usa el cliente. Si escribe en español, respondés en español rioplatense. Si escribe en inglés, respondés en inglés. Si escribe en portugués, respondés en portugués. Adaptate automáticamente. Nunca decís que sos un bot.

CATÁLOGO ACTUAL:
${catalog}
${paymentBlock}
${deliveryBlock}

REGLAS:
1. Solo ofrecés productos con stock disponible (>0 unidades).
1b. NUNCA inventes restricciones o limitaciones que no están en el catálogo. Si un producto existe y tiene stock, se puede vender. No digas "solo vendemos en pack", "no vendemos por unidad", ni ninguna limitación inventada.
1c. Si el cliente pide algo y no lo encontrás en el catálogo, buscá bien antes de decir que no lo tenés.
2. Cuando el cliente quiera pedir, confirmá productos y cantidades.
3. Una vez que el cliente CONFIRME EXPLÍCITAMENTE el pedido y la entrega esté resuelta (retiro o envío con tarifa confirmada), respondé de forma natural Y agregá al final:
<ORDER>{"items":[{"name":"NOMBRE_EXACTO_DEL_PRODUCTO","qty":1,"price_guarani":0}],"total_guarani":0,"delivery_fee":0}</ORDER>
4. Completá el JSON con los datos reales. En delivery_fee poné el costo de envío (0 si retira en local).
5. Después de confirmar un pedido, incluí las instrucciones de pago en tu respuesta (si están disponibles).
6. Si el cliente pregunta por un producto que tiene foto: <SHOW_IMAGE:NOMBRE_EXACTO_DEL_PRODUCTO>
7. Si el cliente menciona su nombre por primera vez: <CUSTOMER_NAME:NOMBRE_DEL_CLIENTE>
8. Si el cliente no confirma o solo pregunta, NO incluyas el bloque <ORDER>.
9. Sé breve, cálido, y usá emojis con moderación.
10. Si el cliente envía una imagen o mensaje que no tiene ninguna relación con los productos o servicios del local, respondé ÚNICAMENTE con: <OFF_TOPIC> No procesás contenido que no esté relacionado con el negocio.`;
}

async function chat({ tenant, stock, history, userMessage, convState, imageData }) {
  const systemPrompt = buildSystemPrompt(tenant, stock, convState || {});

  // Build user content — plain text or image+text for vision messages
  let userContent;
  if (imageData) {
    userContent = [
      {
        type: 'image',
        source: { type: 'base64', media_type: imageData.mimeType, data: imageData.base64 },
      },
      {
        type: 'text',
        text: userMessage || '[El cliente envió una foto. Analizá la imagen y relacionala con el catálogo disponible para sugerir el producto más parecido.]',
      },
    ];
  } else {
    userContent = userMessage;
  }

  const messages = [
    ...history,
    { role: 'user', content: userContent }
  ];

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: systemPrompt,
    messages
  });

  const rawReply = response.content[0].text;

  // Extract ORDER block
  let order = null;
  let cleanReply = rawReply;

  const orderMatch = rawReply.match(/<ORDER>([\s\S]*?)<\/ORDER>/);
  if (orderMatch) {
    try {
      order = JSON.parse(orderMatch[1].trim());
    } catch (e) {
      console.error('Failed to parse ORDER JSON:', e.message);
    }
    cleanReply = cleanReply.replace(/<ORDER>[\s\S]*?<\/ORDER>/, '').trim();
  }

  // Extract SHOW_IMAGE tag
  let imageProductName = null;
  const imageMatch = cleanReply.match(/<SHOW_IMAGE:(.+?)>/);
  if (imageMatch) {
    imageProductName = imageMatch[1].trim();
    cleanReply = cleanReply.replace(/<SHOW_IMAGE:.+?>/, '').trim();
  }

  // Extract CUSTOMER_NAME tag
  let customerName = null;
  const nameMatch = cleanReply.match(/<CUSTOMER_NAME:(.+?)>/);
  if (nameMatch) {
    customerName = nameMatch[1].trim();
    cleanReply = cleanReply.replace(/<CUSTOMER_NAME:.+?>/, '').trim();
  }

  // Extract DELIVERY_CHOICE tag
  let deliveryChoice = null;
  const choiceMatch = cleanReply.match(/<DELIVERY_CHOICE:(retiro|envio)>/i);
  if (choiceMatch) {
    deliveryChoice = choiceMatch[1].toLowerCase();
    cleanReply = cleanReply.replace(/<DELIVERY_CHOICE:(retiro|envio)>/i, '').trim();
  }

  // Extract OFF_TOPIC tag
  let offTopic = false;
  if (cleanReply.includes('<OFF_TOPIC>')) {
    offTopic = true;
    cleanReply = cleanReply.replace(/<OFF_TOPIC>\s*/g, '').trim();
  }

  // Extract DELIVERY_ADDRESS tag
  let deliveryAddress = null;
  const addrMatch = cleanReply.match(/<DELIVERY_ADDRESS:(.+?)>/);
  if (addrMatch) {
    deliveryAddress = addrMatch[1].trim();
    cleanReply = cleanReply.replace(/<DELIVERY_ADDRESS:.+?>/, '').trim();
  }

  // Store a text-only representation in history (avoids saving large base64 in Supabase)
  const historyEntry = imageData
    ? `[foto enviada por el cliente] ${userMessage || ''}`.trim()
    : userMessage;

  const updatedHistory = [
    ...history,
    { role: 'user', content: historyEntry },
    { role: 'assistant', content: rawReply }
  ].slice(-MAX_HISTORY);

  return { reply: cleanReply, order, imageProductName, customerName, deliveryChoice, deliveryAddress, offTopic, updatedHistory };
}

module.exports = { chat };
