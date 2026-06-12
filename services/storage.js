const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const BUCKET = 'product-images';

/**
 * Upload a Buffer to Supabase Storage inside a tenant-scoped folder.
 * Path: product-images/{tenantId}/{timestamp}-{filename}
 * Returns the public URL.
 */
async function uploadImageBuffer(buffer, filename, mimeType = 'image/jpeg', tenantId = 'shared') {
  const safeName = filename
    .toLowerCase()
    .replace(/[^a-z0-9.\-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);

  const path = `${tenantId}/${Date.now()}-${safeName}`;

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, buffer, { contentType: mimeType, upsert: false });

  if (error) throw new Error(`Storage upload failed: ${error.message}`);

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

/**
 * Download a WhatsApp media file from Meta and upload to Supabase Storage.
 * Files are stored under product-images/{tenantId}/
 * Returns the public URL.
 */
async function downloadAndStore(mediaId, whatsappToken, productName, tenantId) {
  // Step 1: Get the temporary download URL from Meta
  const infoRes = await axios.get(
    `https://graph.facebook.com/v19.0/${mediaId}`,
    { headers: { Authorization: `Bearer ${whatsappToken}` } }
  );
  const { url: metaUrl, mime_type } = infoRes.data;

  // Step 2: Download the actual image bytes
  const imgRes = await axios.get(metaUrl, {
    headers: { Authorization: `Bearer ${whatsappToken}` },
    responseType: 'arraybuffer'
  });

  // Step 3: Clean filename from product name
  const ext      = mime_type === 'image/png' ? 'png' : 'jpg';
  const safeName = productName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 40);

  return uploadImageBuffer(Buffer.from(imgRes.data), `${safeName}.${ext}`, mime_type, tenantId);
}

/**
 * Get total storage used by a tenant (in bytes).
 * Useful for superadmin panel.
 */
async function getTenantStorageUsage(tenantId) {
  const { data, error } = await supabase.storage.from(BUCKET).list(tenantId);
  if (error || !data) return 0;
  return data.reduce((sum, file) => sum + (file.metadata?.size || 0), 0);
}

module.exports = { uploadImageBuffer, downloadAndStore, getTenantStorageUsage };
