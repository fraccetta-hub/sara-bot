// In-memory sliding-window rate limiter — resets on server restart (acceptable for Render)
// Protects against runaway customers and bots burning tokens.

const LIMITS = {
  total: { hour: 50,  day: 150 },
  image: { hour: 8,   day: 20  },
  audio: { hour: 10,  day: 25  },
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
 * Returns { allowed: boolean, notify: boolean, reason?: string }
 * notify: true only on the first blocked message — send the warning once, then go silent.
 */
function check(tenantId, phone, type) {
  const key = `${tenantId}:${phone}`;
  const r   = record(key);

  r.hourCounts[type]    = (r.hourCounts[type]    || 0) + 1;
  r.hourCounts.total    = (r.hourCounts.total    || 0) + 1;
  r.dayCounts[type]     = (r.dayCounts[type]     || 0) + 1;
  r.dayCounts.total     = (r.dayCounts.total     || 0) + 1;

  let reason = null;
  if      (r.hourCounts.total > LIMITS.total.hour)                  reason = 'hour_total';
  else if (r.dayCounts.total  > LIMITS.total.day)                   reason = 'day_total';
  else if (type === 'image' && r.hourCounts.image > LIMITS.image.hour) reason = 'hour_image';
  else if (type === 'audio' && r.hourCounts.audio > LIMITS.audio.hour) reason = 'hour_audio';

  if (!reason) return { allowed: true };

  // Send the warning only once per block window (first hit = notify, subsequent = silent drop)
  const notifyKey = `${key}:notified:${reason}`;
  const alreadyNotified = r.notified?.[reason];
  if (!alreadyNotified) {
    r.notified = r.notified || {};
    r.notified[reason] = true;
  }
  return { allowed: false, notify: !alreadyNotified, reason };
}

const MESSAGES = {
  hour_total: '⏳ Recibí muchos mensajes en poco tiempo. Esperá unos minutos y volvé a escribirme 😊',
  day_total:  '⏳ Llegamos al límite de mensajes por hoy. Escribime mañana o llamanos directamente 📞',
  hour_image: '📸 Enviaste muchas fotos seguidas. Esperá un momento antes de mandar otra.',
  hour_audio: '🎤 Enviaste muchos audios seguidos. Esperá un momento antes de mandar otro.',
};

function blockMessage(reason) {
  return MESSAGES[reason] || '⏳ Demasiados mensajes. Por favor esperá un momento.';
}

// Clean up old entries periodically to avoid unbounded memory growth
setInterval(() => {
  const { daySlot } = slots();
  for (const [key, r] of store) {
    if (r.daySlot < daySlot - 1) store.delete(key);
  }
}, 3_600_000); // every hour

module.exports = { check, blockMessage };
