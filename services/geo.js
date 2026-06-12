const https = require('https');

// ─── Haversine distance (km) ──────────────────────────────────────────────────

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Geocode text address → { lat, lng } via Nominatim ───────────────────────

async function geocode(address) {
  return new Promise(resolve => {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1`;
    const options = { headers: { 'User-Agent': 'SaraBot/1.0 sara-bot-delivery' } };
    https.get(url, options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const results = JSON.parse(data);
          if (!results.length) return resolve(null);
          resolve({ lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) });
        } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

// ─── Delivery fee calculation ─────────────────────────────────────────────────
// Returns fee in guaraníes, or null if delivery is not available for this distance

function calcDeliveryFee(tenant, distanceKm) {
  const base = tenant.delivery_base_fee || 0;
  switch (tenant.delivery_type || 'fixed') {
    case 'fixed':
      return base;
    case 'zone': {
      const zoneKm  = parseFloat(tenant.delivery_zone_km) || 5;
      const outerFee = parseInt(tenant.delivery_zone_outer_fee) || 0;
      if (distanceKm <= zoneKm) return base;
      return outerFee > 0 ? outerFee : null; // null = no delivery outside zone
    }
    case 'per_km':
      return base + Math.ceil(distanceKm) * (tenant.delivery_per_km || 0);
    default:
      return base;
  }
}

// ─── Check if delivery is disabled today ─────────────────────────────────────
// disabled_dates array can contain: 'YYYY-MM-DD' or day names ('domingo', etc.)

function isDeliveryDisabledToday(tenant) {
  const disabled = tenant.delivery_disabled_dates || [];
  if (!disabled.length) return false;
  const today     = new Date().toISOString().slice(0, 10);
  const dayNames  = ['domingo','lunes','martes','miercoles','jueves','viernes','sabado'];
  const todayDay  = dayNames[new Date().getDay()];
  return disabled.some(d => d === today || d.toLowerCase() === todayDay);
}

// ─── Describe delivery config in human-readable text (for Claude prompt) ──────

function describeDelivery(tenant) {
  if (!tenant.delivery_enabled) return null;

  const base = tenant.delivery_base_fee || 0;
  const fmt  = n => n.toLocaleString('es-PY') + ' Gs';

  let tarifa;
  switch (tenant.delivery_type || 'fixed') {
    case 'fixed':
      tarifa = `tarifa fija de ${fmt(base)}`;
      break;
    case 'zone': {
      const km    = tenant.delivery_zone_km || 5;
      const outer = tenant.delivery_zone_outer_fee || 0;
      tarifa = `${fmt(base)} dentro de ${km} km` +
        (outer > 0 ? `, ${fmt(outer)} fuera de ${km} km` : `, sin envío a más de ${km} km`);
      break;
    }
    case 'per_km':
      tarifa = `${fmt(base)} base + ${fmt(tenant.delivery_per_km || 0)} por km`;
      break;
    default:
      tarifa = `tarifa fija de ${fmt(base)}`;
  }

  const min = tenant.delivery_min_order || 0;
  return { tarifa, min };
}

module.exports = { haversineKm, geocode, calcDeliveryFee, isDeliveryDisabledToday, describeDelivery };
