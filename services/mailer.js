const axios = require('axios');

const FROM_EMAIL = 'info@sarabot.pro';
const FROM_NAME  = 'Sara Bot';

async function sendMail({ to, subject, html }) {
  await axios.post(
    'https://api.brevo.com/v3/smtp/email',
    {
      sender:   { name: FROM_NAME, email: FROM_EMAIL },
      to:       [{ email: to }],
      subject,
      htmlContent: html,
    },
    {
      headers: {
        'api-key':      process.env.BREVO_API_KEY,
        'Content-Type': 'application/json',
      },
    }
  );
}

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
    noreply: 'Este mensaje es automático. Por favor, no respondas a este correo.',
  },
  en: {
    subject: 'Welcome to Sara Bot! Your account is active',
    greeting: name => `Hi, ${name}!`,
    body: `Your Sara Bot account is active and your 7-day free trial has started.<br><br>
Go to the panel, connect your WhatsApp Business number and Sara will start serving your customers automatically.`,
    btn: 'Go to panel →',
    trial: 'No charges for 7 days. You can cancel anytime from the panel.',
    footer: "If you didn't create this account, ignore this email.",
    noreply: 'This is an automated message. Please do not reply to this email.',
  },
  it: {
    subject: 'Benvenuto su Sara Bot! Il tuo account è attivo',
    greeting: name => `Ciao, ${name}!`,
    body: `Il tuo account Sara Bot è attivo e il periodo di prova gratuito di 7 giorni è iniziato.<br><br>
Accedi al pannello, collega il tuo numero WhatsApp Business e Sara inizierà a rispondere ai tuoi clienti automaticamente.`,
    btn: 'Vai al pannello →',
    trial: 'Nessun addebito per 7 giorni. Puoi cancellare in qualsiasi momento dal pannello.',
    footer: "Se non hai creato questo account, ignora questa email.",
    noreply: 'Questo messaggio è generato automaticamente. Non rispondere a questa email.',
  },
  de: {
    subject: 'Willkommen bei Sara Bot! Dein Konto ist aktiv',
    greeting: name => `Hallo, ${name}!`,
    body: `Dein Sara Bot-Konto ist aktiv und deine 7-tägige Testphase hat begonnen.<br><br>
Gehe zum Panel, verbinde deine WhatsApp Business-Nummer und Sara wird deine Kunden automatisch bedienen.`,
    btn: 'Zum Panel →',
    trial: 'Keine Kosten für 7 Tage. Du kannst jederzeit vom Panel aus kündigen.',
    footer: 'Wenn du dieses Konto nicht erstellt hast, ignoriere diese E-Mail.',
    noreply: 'Diese Nachricht wurde automatisch generiert. Bitte antworte nicht auf diese E-Mail.',
  },
  fr: {
    subject: 'Bienvenue sur Sara Bot ! Votre compte est actif',
    greeting: name => `Bonjour, ${name} !`,
    body: `Votre compte Sara Bot est actif et votre période d'essai gratuite de 7 jours a commencé.<br><br>
Connectez-vous au panneau, connectez votre numéro WhatsApp Business et Sara commencera à servir vos clients automatiquement.`,
    btn: 'Aller au panneau →',
    trial: 'Aucun frais pendant 7 jours. Vous pouvez annuler à tout moment depuis le panneau.',
    footer: "Si vous n'avez pas créé ce compte, ignorez cet e-mail.",
    noreply: "Ce message est généré automatiquement. Merci de ne pas répondre à cet e-mail.",
  },
  pt: {
    subject: 'Bem-vindo ao Sara Bot! Sua conta está ativa',
    greeting: name => `Olá, ${name}!`,
    body: `Sua conta Sara Bot está ativa e seu período de teste gratuito de 7 dias começou.<br><br>
Acesse o painel, conecte seu número do WhatsApp Business e Sara começará a atender seus clientes automaticamente.`,
    btn: 'Ir ao painel →',
    trial: 'Nenhuma cobrança por 7 dias. Você pode cancelar a qualquer momento pelo painel.',
    footer: 'Se você não criou esta conta, ignore este e-mail.',
    noreply: 'Esta mensagem é gerada automaticamente. Por favor, não responda a este e-mail.',
  },
};

function buildHtml(t, businessName, panelUrl) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#f0fdf4;font-family:sans-serif;">
<div style="max-width:520px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.06);">
  <div style="background:#fff;padding:28px 32px;text-align:center;border-bottom:3px solid #22c55e;">
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
    <p style="color:#9ca3af;font-size:11px;margin:0 0 4px;">${t.footer}</p>
    <p style="color:#d1d5db;font-size:10px;margin:0 0 8px;">${t.noreply}</p>
    <p style="color:#d1d5db;font-size:10px;margin:0;">
      <a href="https://sarabot.pro/legal/terms" style="color:#d1d5db;">Terms</a> ·
      <a href="https://sarabot.pro/legal/privacy" style="color:#d1d5db;">Privacy</a> ·
      © 2026 Sara Bot
    </p>
  </div>
</div>
</body>
</html>`;
}

async function sendWelcome({ email, businessName, lang = 'es' }) {
  if (!process.env.BREVO_API_KEY) {
    console.warn('[mailer] BREVO_API_KEY not configured — skipping welcome email');
    return;
  }
  const t = T[lang] || T.es;
  const panelUrl = `${process.env.APP_URL}/admin/index.html`;
  try {
    await sendMail({ to: email, subject: t.subject, html: buildHtml(t, businessName, panelUrl) });
    console.log(`[mailer] Welcome email sent to ${email}`);
  } catch (err) {
    console.error('[mailer] Failed to send welcome email:', err.response?.data || err.message);
  }
}

// ── Password reset email translations ─────────────────────────────────────────
const TR = {
  es: {
    subject: 'Restablecer contraseña — Sara Bot',
    greeting: name => `Hola, ${name}`,
    body: 'Recibimos una solicitud para restablecer tu contraseña. Hacé clic en el botón para elegir una nueva.',
    btn: 'Restablecer contraseña →',
    expiry: 'El enlace expira en 1 hora.',
    ignore: 'Si no solicitaste esto, ignorá este correo. Tu contraseña no cambiará.',
    noreply: 'Este mensaje es automático. Por favor, no respondas a este correo.',
  },
  en: {
    subject: 'Reset your password — Sara Bot',
    greeting: name => `Hi, ${name}`,
    body: 'We received a request to reset your password. Click the button below to choose a new one.',
    btn: 'Reset password →',
    expiry: 'The link expires in 1 hour.',
    ignore: "If you didn't request this, ignore this email. Your password won't change.",
    noreply: 'This is an automated message. Please do not reply to this email.',
  },
  it: {
    subject: 'Reimposta la password — Sara Bot',
    greeting: name => `Ciao, ${name}`,
    body: 'Abbiamo ricevuto una richiesta di reimpostazione della password. Clicca il pulsante per sceglierne una nuova.',
    btn: 'Reimposta password →',
    expiry: 'Il link scade tra 1 ora.',
    ignore: 'Se non hai richiesto questo, ignora questa email. La tua password non cambierà.',
    noreply: 'Questo messaggio è generato automaticamente. Non rispondere a questa email.',
  },
  de: {
    subject: 'Passwort zurücksetzen — Sara Bot',
    greeting: name => `Hallo, ${name}`,
    body: 'Wir haben eine Anfrage zum Zurücksetzen deines Passworts erhalten. Klicke auf den Button, um ein neues zu wählen.',
    btn: 'Passwort zurücksetzen →',
    expiry: 'Der Link läuft in 1 Stunde ab.',
    ignore: 'Wenn du das nicht angefordert hast, ignoriere diese E-Mail. Dein Passwort wird nicht geändert.',
    noreply: 'Diese Nachricht wurde automatisch generiert. Bitte antworte nicht auf diese E-Mail.',
  },
  fr: {
    subject: 'Réinitialiser votre mot de passe — Sara Bot',
    greeting: name => `Bonjour, ${name}`,
    body: 'Nous avons reçu une demande de réinitialisation de votre mot de passe. Cliquez sur le bouton pour en choisir un nouveau.',
    btn: 'Réinitialiser le mot de passe →',
    expiry: 'Le lien expire dans 1 heure.',
    ignore: "Si vous n'avez pas fait cette demande, ignorez cet e-mail. Votre mot de passe ne changera pas.",
    noreply: "Ce message est généré automatiquement. Merci de ne pas répondre à cet e-mail.",
  },
  pt: {
    subject: 'Redefinir senha — Sara Bot',
    greeting: name => `Olá, ${name}`,
    body: 'Recebemos uma solicitação para redefinir sua senha. Clique no botão para escolher uma nova.',
    btn: 'Redefinir senha →',
    expiry: 'O link expira em 1 hora.',
    ignore: 'Se você não solicitou isso, ignore este e-mail. Sua senha não será alterada.',
    noreply: 'Esta mensagem é gerada automaticamente. Por favor, não responda a este e-mail.',
  },
};

function buildResetHtml(tr, businessName, resetUrl) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#f0fdf4;font-family:sans-serif;">
<div style="max-width:520px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.06);">
  <div style="background:#fff;padding:28px 32px;text-align:center;border-bottom:3px solid #22c55e;">
    <img src="https://sarabot.pro/images/logosarabot.webp" alt="Sara Bot" style="height:44px;">
  </div>
  <div style="padding:32px;">
    <p style="font-size:18px;font-weight:700;color:#111;margin:0 0 16px;">${tr.greeting(businessName)}</p>
    <p style="color:#444;line-height:1.6;margin:0 0 24px;">${tr.body}</p>
    <div style="text-align:center;margin-bottom:24px;">
      <a href="${resetUrl}" style="display:inline-block;background:#22c55e;color:#fff;font-weight:700;font-size:15px;padding:14px 32px;border-radius:12px;text-decoration:none;">${tr.btn}</a>
    </div>
    <p style="color:#9ca3af;font-size:13px;margin:0 0 8px;">⏱ ${tr.expiry}</p>
  </div>
  <div style="padding:16px 32px;border-top:1px solid #f0f0f0;text-align:center;">
    <p style="color:#9ca3af;font-size:11px;margin:0 0 4px;">${tr.ignore}</p>
    <p style="color:#d1d5db;font-size:10px;margin:0 0 8px;">${tr.noreply}</p>
    <p style="color:#d1d5db;font-size:10px;margin:0;">
      <a href="https://sarabot.pro/legal/terms" style="color:#d1d5db;">Terms</a> ·
      <a href="https://sarabot.pro/legal/privacy" style="color:#d1d5db;">Privacy</a> ·
      © 2026 Sara Bot
    </p>
  </div>
</div>
</body>
</html>`;
}

async function sendPasswordReset({ email, businessName, resetUrl, lang = 'es' }) {
  if (!process.env.BREVO_API_KEY) {
    console.warn('[mailer] BREVO_API_KEY not configured — skipping password reset email');
    return;
  }
  const tr = TR[lang] || TR.es;
  try {
    await sendMail({ to: email, subject: tr.subject, html: buildResetHtml(tr, businessName, resetUrl) });
    console.log(`[mailer] Password reset email sent to ${email}`);
  } catch (err) {
    console.error('[mailer] Failed to send password reset email:', err.response?.data || err.message);
  }
}

// ── Account deletion confirmation email translations ───────────────────────────
const TD = {
  es: {
    subject: 'Confirmá la eliminación de tu cuenta — Sara Bot',
    greeting: name => `Hola, ${name}`,
    body: 'Recibimos una solicitud para eliminar permanentemente tu cuenta de Sara Bot. Si fuiste vos, hacé clic en el botón para confirmar. Se cancelará tu suscripción y se borrarán TODOS tus datos de forma irreversible.',
    btn: 'Confirmar eliminación de cuenta',
    expiry: 'El enlace expira en 1 hora.',
    ignore: 'Si no solicitaste esto, ignorá este correo. Tu cuenta NO se eliminará.',
    noreply: 'Este mensaje es automático. Por favor, no respondas a este correo.',
  },
  en: {
    subject: 'Confirm your account deletion — Sara Bot',
    greeting: name => `Hi, ${name}`,
    body: 'We received a request to permanently delete your Sara Bot account. If this was you, click the button to confirm. Your subscription will be cancelled and ALL your data will be erased irreversibly.',
    btn: 'Confirm account deletion',
    expiry: 'The link expires in 1 hour.',
    ignore: "If you didn't request this, ignore this email. Your account will NOT be deleted.",
    noreply: 'This is an automated message. Please do not reply to this email.',
  },
  it: {
    subject: "Conferma l'eliminazione del tuo account — Sara Bot",
    greeting: name => `Ciao, ${name}`,
    body: 'Abbiamo ricevuto una richiesta di eliminazione permanente del tuo account Sara Bot. Se sei stato tu, clicca il pulsante per confermare. Il tuo abbonamento sarà annullato e TUTTI i tuoi dati saranno cancellati in modo irreversibile.',
    btn: 'Conferma eliminazione account',
    expiry: 'Il link scade tra 1 ora.',
    ignore: 'Se non hai richiesto questo, ignora questa email. Il tuo account NON sarà eliminato.',
    noreply: 'Questo messaggio è generato automaticamente. Non rispondere a questa email.',
  },
  de: {
    subject: 'Bestätige die Löschung deines Kontos — Sara Bot',
    greeting: name => `Hallo, ${name}`,
    body: 'Wir haben eine Anfrage zur dauerhaften Löschung deines Sara Bot-Kontos erhalten. Wenn du das warst, klicke auf den Button zur Bestätigung. Dein Abonnement wird gekündigt und ALLE deine Daten werden unwiderruflich gelöscht.',
    btn: 'Kontolöschung bestätigen',
    expiry: 'Der Link läuft in 1 Stunde ab.',
    ignore: 'Wenn du das nicht angefordert hast, ignoriere diese E-Mail. Dein Konto wird NICHT gelöscht.',
    noreply: 'Diese Nachricht wurde automatisch generiert. Bitte antworte nicht auf diese E-Mail.',
  },
  fr: {
    subject: 'Confirmez la suppression de votre compte — Sara Bot',
    greeting: name => `Bonjour, ${name}`,
    body: 'Nous avons reçu une demande de suppression définitive de votre compte Sara Bot. Si c\'était vous, cliquez sur le bouton pour confirmer. Votre abonnement sera annulé et TOUTES vos données seront effacées de manière irréversible.',
    btn: 'Confirmer la suppression du compte',
    expiry: 'Le lien expire dans 1 heure.',
    ignore: "Si vous n'avez pas fait cette demande, ignorez cet e-mail. Votre compte ne sera PAS supprimé.",
    noreply: "Ce message est généré automatiquement. Merci de ne pas répondre à cet e-mail.",
  },
  pt: {
    subject: 'Confirme a exclusão da sua conta — Sara Bot',
    greeting: name => `Olá, ${name}`,
    body: 'Recebemos uma solicitação para excluir permanentemente sua conta Sara Bot. Se foi você, clique no botão para confirmar. Sua assinatura será cancelada e TODOS os seus dados serão apagados de forma irreversível.',
    btn: 'Confirmar exclusão da conta',
    expiry: 'O link expira em 1 hora.',
    ignore: 'Se você não solicitou isso, ignore este e-mail. Sua conta NÃO será excluída.',
    noreply: 'Esta mensagem é gerada automaticamente. Por favor, não responda a este e-mail.',
  },
};

function buildDeleteHtml(td, businessName, confirmUrl) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#fef2f2;font-family:sans-serif;">
<div style="max-width:520px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.06);">
  <div style="background:#fff;padding:28px 32px;text-align:center;border-bottom:3px solid #22c55e;">
    <img src="https://sarabot.pro/images/logosarabot.webp" alt="Sara Bot" style="height:44px;">
  </div>
  <div style="padding:32px;">
    <p style="font-size:18px;font-weight:700;color:#111;margin:0 0 16px;">${td.greeting(businessName)}</p>
    <p style="color:#444;line-height:1.6;margin:0 0 24px;">${td.body}</p>
    <div style="text-align:center;margin-bottom:24px;">
      <a href="${confirmUrl}" style="display:inline-block;background:#ef4444;color:#fff;font-weight:700;font-size:15px;padding:14px 32px;border-radius:12px;text-decoration:none;">${td.btn}</a>
    </div>
    <p style="color:#9ca3af;font-size:13px;margin:0 0 8px;">⏱ ${td.expiry}</p>
  </div>
  <div style="padding:16px 32px;border-top:1px solid #f0f0f0;text-align:center;">
    <p style="color:#9ca3af;font-size:11px;margin:0 0 4px;">${td.ignore}</p>
    <p style="color:#d1d5db;font-size:10px;margin:0 0 8px;">${td.noreply}</p>
    <p style="color:#d1d5db;font-size:10px;margin:0;">
      <a href="https://sarabot.pro/legal/terms" style="color:#d1d5db;">Terms</a> ·
      <a href="https://sarabot.pro/legal/privacy" style="color:#d1d5db;">Privacy</a> ·
      © 2026 Sara Bot
    </p>
  </div>
</div>
</body>
</html>`;
}

async function sendAccountDeletion({ email, businessName, confirmUrl, lang = 'es' }) {
  if (!process.env.BREVO_API_KEY) {
    console.warn('[mailer] BREVO_API_KEY not configured — skipping account deletion email');
    return;
  }
  const td = TD[lang] || TD.es;
  try {
    await sendMail({ to: email, subject: td.subject, html: buildDeleteHtml(td, businessName, confirmUrl) });
    console.log(`[mailer] Account deletion email sent to ${email}`);
  } catch (err) {
    console.error('[mailer] Failed to send account deletion email:', err.response?.data || err.message);
  }
}

module.exports = { sendWelcome, sendPasswordReset, sendAccountDeletion };
