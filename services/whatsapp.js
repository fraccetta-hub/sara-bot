const axios = require('axios');

const GRAPH_URL = 'https://graph.facebook.com/v19.0';

function headers(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function sendMessage(to, text, phoneNumberId, token) {
  await axios.post(
    `${GRAPH_URL}/${phoneNumberId}/messages`,
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body: text }
    },
    { headers: headers(token) }
  );
}

async function sendImage(to, imageUrl, caption, phoneNumberId, token) {
  await axios.post(
    `${GRAPH_URL}/${phoneNumberId}/messages`,
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'image',
      image: { link: imageUrl, caption: caption || '' }
    },
    { headers: headers(token) }
  );
}

// Notify merchant about a new order — plain text with action instructions
async function notifyMerchant(merchantPhone, order, customerPhone, phoneNumberId, token) {
  const itemsList = order.items
    .map(i => `  • ${i.name} x${i.qty} — ${i.price_guarani.toLocaleString('es-PY')} Gs`)
    .join('\n');

  const shortId = order.id ? order.id.substring(0, 8).toUpperCase() : '?';

  const text =
    `🛒 *Nuevo pedido #${shortId}*\n` +
    `👤 Cliente: +${customerPhone}\n\n` +
    `📦 *Productos:*\n${itemsList}\n\n` +
    `💰 Subtotal: ${order.total_guarani.toLocaleString('es-PY')} Gs\n` +
    `🚚 Envío: ${(order.delivery_fee || 0).toLocaleString('es-PY')} Gs\n` +
    `💵 *Total: ${(order.total_guarani + (order.delivery_fee || 0)).toLocaleString('es-PY')} Gs*\n\n` +
    `Respondé con:\n` +
    `✅ *CONFIRMAR* — aceptar el pedido\n` +
    `❌ *CANCELAR* — rechazar el pedido\n` +
    `💬 *CHAT* — tomar el chat con el cliente`;

  await sendMessage(merchantPhone, text, phoneNumberId, token);
}

module.exports = { sendMessage, sendImage, notifyMerchant };
