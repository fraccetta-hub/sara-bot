/**
 * Telegram webhook — receives superadmin replies and routes them to the right merchant.
 *
 * Setup:
 *  1. Create a bot via @BotFather → get TELEGRAM_BOT_TOKEN
 *  2. Start the bot and send /start → get your chat_id (use @userinfobot)
 *  3. Set TELEGRAM_SUPERADMIN_CHAT_ID to that number
 *  4. Register webhook: https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://sarabot.pro/telegram-webhook
 */

const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const BOT_TOKEN      = process.env.TELEGRAM_BOT_TOKEN;
const SUPERADMIN_CHAT = process.env.TELEGRAM_SUPERADMIN_CHAT_ID; // numeric string

// ── Send a message to Telegram ────────────────────────────────────────────────
async function tgSend(chatId, text, replyMarkup = null) {
  if (!BOT_TOKEN) return null;
  const body = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (replyMarkup) body.reply_markup = replyMarkup;
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return data.ok ? data.result.message_id : null;
  } catch (e) {
    console.error('[telegram] sendMessage error:', e.message);
    return null;
  }
}

// ── Notify superadmin of a new merchant support message ───────────────────────
async function notifySuperadmin(tenantName, tenantId, content) {
  if (!BOT_TOKEN || !SUPERADMIN_CHAT) return;
  const text = `💬 <b>${tenantName}</b> necesita ayuda:\n\n"${content}"\n\n<i>Respondé a este mensaje para contestarle directamente.</i>\n[TID:${tenantId}]`;
  const msgId = await tgSend(SUPERADMIN_CHAT, text);
  return msgId;
}

// ── POST /telegram-webhook ────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  res.sendStatus(200); // always ack immediately

  const update = req.body;
  const msg = update?.message;
  if (!msg) return;

  const fromId   = String(msg.from?.id);
  const chatId   = String(msg.chat?.id);
  const text     = msg.text?.trim();

  // Only process messages from the superadmin chat
  if (chatId !== String(SUPERADMIN_CHAT) && fromId !== String(SUPERADMIN_CHAT)) return;
  if (!text) return;

  // Extract tenant_id from the replied-to message
  let tenantId = null;

  if (msg.reply_to_message?.text) {
    const match = msg.reply_to_message.text.match(/\[TID:([a-f0-9-]{36})\]/);
    if (match) tenantId = match[1];
  }

  // Also support manual command: /reply <tenantId> <message>
  if (!tenantId && text.startsWith('/reply ')) {
    const parts = text.slice(7).split(' ');
    tenantId = parts[0];
    // reconstruct message without the command prefix
  }

  if (!tenantId) {
    // Unknown message — show help
    await tgSend(chatId, '⚠️ Para responder a un merchant, usá la función <b>Responder</b> de Telegram sobre el mensaje de notificación.\n\nO escribí: <code>/reply &lt;tenant_id&gt; tu mensaje</code>');
    return;
  }

  // Determine the actual reply content
  let replyContent = text;
  if (text.startsWith('/reply ')) {
    replyContent = text.slice(7).split(' ').slice(1).join(' ').trim();
  }
  if (!replyContent) return;

  // Verify tenant exists
  const { data: tenant } = await supabase.from('tenants').select('id, name').eq('id', tenantId).single();
  if (!tenant) {
    await tgSend(chatId, `❌ Merchant ID no encontrado: ${tenantId}`);
    return;
  }

  // Save reply to support_messages
  const { error } = await supabase.from('support_messages').insert({
    tenant_id: tenantId,
    role: 'support',
    content: replyContent,
  });

  if (error) {
    console.error('[telegram] Error saving support reply:', error.message);
    await tgSend(chatId, `❌ Error al guardar la respuesta: ${error.message}`);
    return;
  }

  await tgSend(chatId, `✅ Respuesta enviada a <b>${tenant.name}</b>`);
  console.log(`[telegram] Support reply sent to tenant ${tenantId}: "${replyContent}"`);
});

module.exports = { router, notifySuperadmin };
