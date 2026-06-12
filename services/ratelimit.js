// In-memory sliding-window rate limiter — resets on server restart (acceptable for Render)
// Protects against runaway customers and bots burning tokens.

const LIMITS = {
  total: { hour: 20,  day: 60  },
  image: { hour: 4,   day: 12  },
  audio: { hour: 4,   day: 12  },
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
 * Returns { allowed: boolean, reason?: string }
 */
function check(tenantId, phone, type) {
  const key = `${tenantId}:${phone}`;
  const r   = record(key);

  // Increment before checking (count-then-gate — simple and honest)
  r.hourCounts[type]    = (r.hourCounts[type]    || 0) + 1;
  r.hourCounts.total    = (r.hourCounts.total    || 0) + 1;
  r.dayCounts[type]     = (r.dayCounts[type]     || 0) + 1;
  r.dayCounts.total     = (r.dayCounts.total     || 0) + 1;

  if (r.hourCounts.total > LIMITS.total.hour)
    return { allowed: false, reason: 'hour_total' };
  if (r.dayCounts.total  > LIMITS.total.day)
    return { allowed: false, reason: 'day_total' };
  if (type === 'image' && r.hourCounts.image > LIMITS.image.hour)
    return { allowed: false, reason: 'hour_image' };
  if (type === 'audio' && r.hourCounts.audio > LIMITS.audio.hour)
    return { allowed: false, reason: 'hour_audio' };

  return { allowed: true };
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
