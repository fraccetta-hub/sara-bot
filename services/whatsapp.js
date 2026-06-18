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

const ORDER_NOTIFY = {
  es: (id, phone, items, sub, ship, total) => `🛒 *Nuevo pedido #${id}*\n👤 +${phone}\n\n📦 *Productos:*\n${items}\n\n💰 Subtotal: ${sub} Gs\n🚚 Envío: ${ship} Gs\n💵 *Total: ${total} Gs*`,
  it: (id, phone, items, sub, ship, total) => `🛒 *Nuovo ordine #${id}*\n👤 +${phone}\n\n📦 *Prodotti:*\n${items}\n\n💰 Subtotale: ${sub} Gs\n🚚 Spedizione: ${ship} Gs\n💵 *Totale: ${total} Gs*`,
  en: (id, phone, items, sub, ship, total) => `🛒 *New order #${id}*\n👤 +${phone}\n\n📦 *Items:*\n${items}\n\n💰 Subtotal: ${sub} Gs\n🚚 Shipping: ${ship} Gs\n💵 *Total: ${total} Gs*`,
  fr: (id, phone, items, sub, ship, total) => `🛒 *Nouvelle commande #${id}*\n👤 +${phone}\n\n📦 *Produits:*\n${items}\n\n💰 Sous-total: ${sub} Gs\n🚚 Livraison: ${ship} Gs\n💵 *Total: ${total} Gs*`,
  de: (id, phone, items, sub, ship, total) => `🛒 *Neue Bestellung #${id}*\n👤 +${phone}\n\n📦 *Artikel:*\n${items}\n\n💰 Zwischensumme: ${sub} Gs\n🚚 Versand: ${ship} Gs\n💵 *Gesamt: ${total} Gs*`,
  pt: (id, phone, items, sub, ship, total) => `🛒 *Novo pedido #${id}*\n👤 +${phone}\n\n📦 *Produtos:*\n${items}\n\n💰 Subtotal: ${sub} Gs\n🚚 Entrega: ${ship} Gs\n💵 *Total: ${total} Gs*`,
};

async function notifyMerchant(merchantPhone, order, customerPhone, phoneNumberId, token, lang = 'es') {
  const itemsList = order.items
    .map(i => `  • ${i.name} x${i.qty} — ${i.price_guarani.toLocaleString('es-PY')} Gs`)
    .join('\n');
  const shortId = order.id ? order.id.substring(0, 8).toUpperCase() : '?';
  const sub   = order.total_guarani.toLocaleString('es-PY');
  const ship  = (order.delivery_fee || 0).toLocaleString('es-PY');
  const total = (order.total_guarani + (order.delivery_fee || 0)).toLocaleString('es-PY');
  const fn = ORDER_NOTIFY[lang] || ORDER_NOTIFY.es;
  await sendMessage(merchantPhone, fn(shortId, customerPhone, itemsList, sub, ship, total), phoneNumberId, token);
}

module.exports = { sendMessage, sendImage, notifyMerchant };
