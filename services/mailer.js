const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST,
  port:   parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const FROM = process.env.SMTP_FROM || 'Sara Bot <noreply@sarabot.ai>';

// ── Welcome email translations ─────────────────────────────────────────────────
const T = {
  es: {
    subject: '¡Bienvenido a Sara Bot! Tu cuenta está activa',
    greeting: name => `¡Hola, ${name}!`,
    body: `Tu cuenta de Sara Bot está activa y tu período de prueba de 7 días ha comenzado.<br><br>
Entrá al panel, conectá tu número de WhatsApp Business y Sara empezará a atender a tus clientes automáticamente.`,
    btn: 'Ir al panel →',
    trial: 'No se cobra nada por 7 días. Podés cancelar cuando quieras desde el panel.',
    footer: 'Si no creaste esta cuenta, ignorá este correo.',
  },
  en: {
    subject: 'Welcome to Sara Bot! Your account is active',
    greeting: name => `Hi, ${name}!`,
    body: `Your Sara Bot account is active and your 7-day free trial has started.<br><br>
Go to the panel, connect your WhatsApp Business number and Sara will start serving your customers automatically.`,
    btn: 'Go to panel →',
    trial: 'No charges for 7 days. You can cancel anytime from the panel.',
    footer: "If you didn't create this account, ignore this email.",
  },
  it: {
    subject: 'Benvenuto su Sara Bot! Il tuo account è attivo',
    greeting: name => `Ciao, ${name}!`,
    body: `Il tuo account Sara Bot è attivo e il periodo di prova gratuito di 7 giorni è iniziato.<br><br>
Accedi al pannello, collega il tuo numero WhatsApp Business e Sara inizierà a rispondere ai tuoi clienti automaticamente.`,
    btn: 'Vai al pannello →',
    trial: 'Nessun addebito per 7 giorni. Puoi cancellare in qualsiasi momento dal pannello.',
    footer: "Se non hai creato questo account, ignora questa email.",
  },
  de: {
    subject: 'Willkommen bei Sara Bot! Dein Konto ist aktiv',
    greeting: name => `Hallo, ${name}!`,
    body: `Dein Sara Bot-Konto ist aktiv und deine 7-tägige Testphase hat begonnen.<br><br>
Gehe zum Panel, verbinde deine WhatsApp Business-Nummer und Sara wird deine Kunden automatisch bedienen.`,
    btn: 'Zum Panel →',
    trial: 'Keine Kosten für 7 Tage. Du kannst jederzeit vom Panel aus kündigen.',
    footer: 'Wenn du dieses Konto nicht erstellt hast, ignoriere diese E-Mail.',
  },
  fr: {
    subject: 'Bienvenue sur Sara Bot ! Votre compte est actif',
    greeting: name => `Bonjour, ${name} !`,
    body: `Votre compte Sara Bot est actif et votre période d'essai gratuite de 7 jours a commencé.<br><br>
Connectez-vous au panneau, connectez votre numéro WhatsApp Business et Sara commencera à servir vos clients automatiquement.`,
    btn: 'Aller au panneau →',
    trial: 'Aucun frais pendant 7 jours. Vous pouvez annuler à tout moment depuis le panneau.',
    footer: "Si vous n'avez pas créé ce compte, ignorez cet e-mail.",
  },
  pt: {
    subject: 'Bem-vindo ao Sara Bot! Sua conta está ativa',
    greeting: name => `Olá, ${name}!`,
    body: `Sua conta Sara Bot está ativa e seu período de teste gratuito de 7 dias começou.<br><br>
Acesse o painel, conecte seu número do WhatsApp Business e Sara começará a atender seus clientes automaticamente.`,
    btn: 'Ir ao painel →',
    trial: 'Nenhuma cobrança por 7 dias. Você pode cancelar a qualquer momento pelo painel.',
    footer: 'Se você não criou esta conta, ignore este e-mail.',
  },
};

function buildHtml(t, businessName, panelUrl) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#f0fdf4;font-family:sans-serif;">
<div style="max-width:520px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.06);">
  <div style="background:#22c55e;padding:28px 32px;text-align:center;">
    <img src="https://sarabot.pro/images/logosarabot.webp" alt="Sara Bot" style="height:44px;">
  </div>
  <div style="padding:32px;">
    <p style="font-size:18px;font-weight:700;color:#111;margin:0 0 16px;">${t.greeting(businessName)}</p>
    <p style="color:#444;line-height:1.6;margin:0 0 24px;">${t.body}</p>
    <div style="text-align:center;margin-bottom:24px;">
      <a href="${panelUrl}" style="display:inline-block;background:#22c55e;color:#fff;font-weight:700;font-size:15px;padding:14px 32px;border-radius:12px;text-decoration:none;">${t.btn}</a>
    </div>
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:12px 16px;color:#15803d;font-size:13px;">
      🎁 ${t.trial}
    </div>
  </div>
  <div style="padding:16px 32px;border-top:1px solid #f0f0f0;text-align:center;">
    <p style="color:#9ca3af;font-size:11px;margin:0;">${t.footer}</p>
  </div>
</div>
</body>
</html>`;
}

async function sendWelcome({ email, businessName, lang = 'es' }) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) {
    console.warn('[mailer] SMTP not configured — skipping welcome email');
    return;
  }
  const t = T[lang] || T.es;
  const panelUrl = `${process.env.APP_URL}/admin/index.html`;
  try {
    await transporter.sendMail({
      from: FROM,
      to: email,
      subject: t.subject,
      html: buildHtml(t, businessName, panelUrl),
    });
    console.log(`[mailer] Welcome email sent to ${email}`);
  } catch (err) {
    console.error('[mailer] Failed to send welcome email:', err.message);
  }
}

module.exports = { sendWelcome };
