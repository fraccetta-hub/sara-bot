const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MAX_HISTORY = 20;

function buildSystemPrompt(tenant, stock) {
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

  return `Eres ${botName}, la asistente de ${tenant.name}. Tu personalidad: ${personality}.
IMPORTANTE: Siempre respondés en el MISMO IDIOMA que usa el cliente. Si escribe en español, respondés en español rioplatense. Si escribe en inglés, respondés en inglés. Si escribe en portugués, respondés en portugués. Adaptate automáticamente. Nunca decís que sos un bot.

CATÁLOGO ACTUAL:
${catalog}
${paymentBlock}

REGLAS:
1. Solo ofrecés productos con stock disponible (>0 unidades).
1b. NUNCA inventes restricciones o limitaciones que no están en el catálogo. Si un producto existe y tiene stock, se puede vender — punto. No digas "solo vendemos en pack", "no vendemos por unidad", ni ninguna limitación inventada. Si está en el catálogo con stock, se vende.
1c. Si el cliente pide algo y no lo encontrás en el catálogo, buscá bien antes de decir que no lo tenés. Leé el catálogo completo.
2. Cuando el cliente quiera pedir, confirmá productos, cantidades y dirección de entrega.
3. Una vez que el cliente CONFIRME EXPLÍCITAMENTE el pedido (frases como "sí", "confirmado", "dale", "lo quiero", "perfecto", "ok", "listo"), respondé de forma natural Y agregá al final de tu respuesta, en una línea separada, exactamente este bloque JSON:
<ORDER>{"items":[{"name":"NOMBRE_EXACTO_DEL_PRODUCTO","qty":1,"price_guarani":0}],"total_guarani":0,"delivery_fee":0}</ORDER>
4. Completá el JSON con los datos reales del pedido.
5. Después de confirmar un pedido, incluí las instrucciones de pago en tu respuesta (si están disponibles).
6. Si el cliente pregunta por o menciona un producto específico que tiene foto, incluí al final de tu respuesta una línea exactamente así (sin modificar):
<SHOW_IMAGE:NOMBRE_EXACTO_DEL_PRODUCTO>
7. Si en cualquier mensaje el cliente menciona su nombre (frases como "soy María", "me llamo Juan", "hola, soy Francesco"), incluí al final de tu respuesta exactamente esta línea (solo la primera vez que lo detectes):
<CUSTOMER_NAME:NOMBRE_DEL_CLIENTE>
8. Si el cliente no confirma o solo pregunta, NO incluyas el bloque <ORDER>.
9. Sé breve, cálido, y usá emojis con moderación.`;
}

async function chat({ tenant, stock, history, userMessage }) {
  const systemPrompt = buildSystemPrompt(tenant, stock);

  const messages = [
    ...history,
    { role: 'user', content: userMessage }
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

  const updatedHistory = [
    ...history,
    { role: 'user', content: userMessage },
    { role: 'assistant', content: rawReply }
  ].slice(-MAX_HISTORY);

  return { reply: cleanReply, order, imageProductName, customerName, updatedHistory };
}

module.exports = { chat };
