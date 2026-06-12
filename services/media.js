// Download media files from Meta's WhatsApp Cloud API.
// Meta requires two steps: first get the download URL, then download the file.

const axios = require('axios');

async function fetchMedia(mediaId, token) {
  // Step 1: resolve download URL
  const { data: meta } = await axios.get(
    `https://graph.facebook.com/v19.0/${mediaId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!meta.url) throw new Error(`No URL for media ${mediaId}`);

  // Step 2: download binary
  const { data: buffer, headers } = await axios.get(meta.url, {
    responseType: 'arraybuffer',
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'SaraBot/1.0' },
    maxContentLength: 20 * 1024 * 1024, // 20 MB hard cap
  });

  const mimeType = headers['content-type']?.split(';')[0] || 'application/octet-stream';
  return { buffer: Buffer.from(buffer), mimeType };
}

module.exports = { fetchMedia };
