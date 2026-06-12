// Audio transcription via Groq Whisper (free tier, multilingual, fast).
// Set GROQ_API_KEY in environment variables — get one free at console.groq.com

const FormData = require('form-data');
const axios = require('axios');

const EXT_MAP = {
  'audio/ogg':  'ogg',
  'audio/mp4':  'mp4',
  'audio/mpeg': 'mp3',
  'audio/webm': 'webm',
  'audio/wav':  'wav',
  'audio/aac':  'aac',
};

async function transcribeAudio(buffer, mimeType) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not set');

  const ext = EXT_MAP[mimeType] || 'ogg';

  const form = new FormData();
  form.append('file', buffer, { filename: `voice.${ext}`, contentType: mimeType });
  form.append('model', 'whisper-large-v3-turbo'); // best speed/accuracy, auto language detection
  form.append('response_format', 'text');          // returns plain string, not JSON

  const { data } = await axios.post(
    'https://api.groq.com/openai/v1/audio/transcriptions',
    form,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...form.getHeaders(),
      },
      timeout: 20_000,
    }
  );

  return typeof data === 'string' ? data.trim() : (data?.text?.trim() || '');
}

module.exports = { transcribeAudio };
