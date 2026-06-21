// In-memory sliding-window rate limiter — resets on server restart (acceptable for Render)
// Protects against runaway customers and bots burning tokens.

const LIMITS = {
  customer: {
    total: { hour: 50,  day: 150 },
    image: { hour: 8,   day: 20  },
    audio: { hour: 10,  day: 25  },
  },
  merchant: {
    total: { hour: 120, day: 400 },
    image: { hour: 30,  day: 80  },
    audio: { hour: 30,  day: 80  },
  },
};

// key: `tenantId:phone`  →  { hourSlot, daySlot, hourCounts, dayCounts }
const store = new Map();

function slots() {
  const now = Date.now();
  return {
    hourSlot: Math.floor(now / 3_600_000),
    daySlot:  Math.floor(now / 86_400_000),
  };
}

function record(key) {
  const { hourSlot, daySlot } = slots();
  let r = store.get(key);

  const newHour = !r || r.hourSlot !== hourSlot;
  const newDay  = !r || r.daySlot  !== daySlot;

  if (newHour) {
    r = {
      hourSlot, daySlot,
      hourCounts: {},
      dayCounts: newDay ? {} : (r?.dayCounts || {}),
    };
    store.set(key, r);
  }
  return r;
}

/**
 * Check and increment counter for one message.
 * type: 'text' | 'image' | 'audio'
 * role: 'customer' | 'merchant'
 * Returns { allowed: boolean, notify: boolean, reason?: string }
 * notify: true only on the first blocked message — send the warning once, then go silent.
 */
function check(tenantId, phone, type, role = 'customer') {
  const key = `${tenantId}:${phone}`;
  const r   = record(key);
  const lim = LIMITS[role] || LIMITS.customer;

  r.hourCounts[type]    = (r.hourCounts[type]    || 0) + 1;
  r.hourCounts.total    = (r.hourCounts.total    || 0) + 1;
  r.dayCounts[type]     = (r.dayCounts[type]     || 0) + 1;
  r.dayCounts.total     = (r.dayCounts.total     || 0) + 1;

  let reason = null;
  if      (r.hourCounts.total > lim.total.hour)                   reason = 'hour_total';
  else if (r.dayCounts.total  > lim.total.day)                    reason = 'day_total';
  else if (type === 'image' && r.hourCounts.image > lim.image.hour) reason = 'hour_image';
  else if (type === 'audio' && r.hourCounts.audio > lim.audio.hour) reason = 'hour_audio';

  if (!reason) return { allowed: true };

  const alreadyNotified = r.notified?.[reason];
  if (!alreadyNotified) {
    r.notified = r.notified || {};
    r.notified[reason] = true;
  }
  return { allowed: false, notify: !alreadyNotified, reason };
}

const CUSTOMER_MESSAGES = {
  hour_total: '⏳ Recibí muchos mensajes en poco tiempo. Esperá unos minutos y volvé a escribirme 😊',
  day_total:  '⏳ Llegamos al límite de mensajes por hoy. Escribime mañana o llamanos directamente 📞',
  hour_image: '📸 Enviaste muchas fotos seguidas. Esperá un momento antes de mandar otra.',
  hour_audio: '🎤 Enviaste muchos audios seguidos. Esperá un momento antes de mandar otro.',
};

const MERCHANT_MESSAGES = {
  es: { hour_total: '⏳ Demasiados mensajes en poco tiempo. Esperá unos minutos.', day_total: '⏳ Límite diario alcanzado. Continuá mañana.', hour_image: '📸 Demasiadas fotos seguidas. Esperá un momento.', hour_audio: '🎤 Demasiados audios seguidos. Esperá un momento.' },
  it: { hour_total: '⏳ Troppi messaggi in poco tempo. Aspetta qualche minuto.', day_total: '⏳ Limite giornaliero raggiunto. Riprendi domani.', hour_image: '📸 Troppe foto di fila. Aspetta un momento.', hour_audio: '🎤 Troppi audio di fila. Aspetta un momento.' },
  en: { hour_total: '⏳ Too many messages in a short time. Wait a few minutes.', day_total: '⏳ Daily limit reached. Continue tomorrow.', hour_image: '📸 Too many photos in a row. Wait a moment.', hour_audio: '🎤 Too many audios in a row. Wait a moment.' },
  fr: { hour_total: '⏳ Trop de messages en peu de temps. Attendez quelques minutes.', day_total: '⏳ Limite journalière atteinte. Continuez demain.', hour_image: '📸 Trop de photos d\'affilée. Attendez un moment.', hour_audio: '🎤 Trop d\'audios d\'affilée. Attendez un moment.' },
  de: { hour_total: '⏳ Zu viele Nachrichten in kurzer Zeit. Warte ein paar Minuten.', day_total: '⏳ Tageslimit erreicht. Fahre morgen fort.', hour_image: '📸 Zu viele Fotos hintereinander. Warte einen Moment.', hour_audio: '🎤 Zu viele Audios hintereinander. Warte einen Moment.' },
  pt: { hour_total: '⏳ Muitas mensagens em pouco tempo. Aguarde alguns minutos.', day_total: '⏳ Limite diário atingido. Continue amanhã.', hour_image: '📸 Muitas fotos seguidas. Aguarde um momento.', hour_audio: '🎤 Muitos áudios seguidos. Aguarde um momento.' },
};

function blockMessage(reason, role = 'customer', lang = 'es') {
  if (role === 'merchant') {
    const msgs = MERCHANT_MESSAGES[lang] || MERCHANT_MESSAGES.es;
    return msgs[reason] || msgs.hour_total;
  }
  return CUSTOMER_MESSAGES[reason] || '⏳ Demasiados mensajes. Por favor esperá un momento.';
}

// Clean up old entries periodically to avoid unbounded memory growth
setInterval(() => {
  const { daySlot } = slots();
  for (const [key, r] of store) {
    if (r.daySlot < daySlot - 1) store.delete(key);
  }
}, 3_600_000); // every hour

module.exports = { check, blockMessage };
