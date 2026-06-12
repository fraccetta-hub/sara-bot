const axios = require('axios');

const ORS_BASE = 'https://api.openrouteservice.org';

// Requires ORS_API_KEY in .env — get a free key at openrouteservice.org
async function calculateDelivery(originCoords, destinationAddress) {
  const apiKey = process.env.ORS_API_KEY;

  if (!apiKey) {
    // Graceful fallback: flat rate when API key is not configured
    return { distance_km: null, fee_guarani: 10000, note: 'ORS_API_KEY not configured' };
  }

  // Geocode the destination address (scoped to Paraguay)
  const geoRes = await axios.get(`${ORS_BASE}/geocode/search`, {
    params: {
      api_key: apiKey,
      text: destinationAddress,
      'boundary.country': 'PY',
      size: 1
    }
  });

  const feature = geoRes.data.features?.[0];
  if (!feature) {
    return { distance_km: null, fee_guarani: 10000, note: 'Address not found' };
  }

  const [destLng, destLat] = feature.geometry.coordinates;

  // Request driving distance between origin and destination
  const routeRes = await axios.post(
    `${ORS_BASE}/v2/directions/driving-car`,
    {
      coordinates: [
        [originCoords.lng, originCoords.lat],
        [destLng, destLat]
      ]
    },
    {
      headers: {
        Authorization: apiKey,
        'Content-Type': 'application/json'
      }
    }
  );

  const distanceMeters = routeRes.data.routes?.[0]?.summary?.distance || 0;
  const distance_km = Math.round((distanceMeters / 1000) * 10) / 10;

  const baseFee = 5000;   // Gs base
  const perKm = 1000;     // Gs per km
  const fee_guarani = Math.round(baseFee + distance_km * perKm);

  return { distance_km, fee_guarani };
}

module.exports = { calculateDelivery };
