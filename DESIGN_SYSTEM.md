# Sara Bot — Design System (tema "v5", editoriale caldo)

_Definito 2026-06-20. Direzione approvata dopo 5 iterazioni di anteprima. Da applicare a TUTTO il sito (landing, pannelli, login, errori, superadmin, legali, email)._

> Questo file è la **fonte di verità** del nuovo look. Quando si restyla una superficie, si copiano questi token e regole. Niente valori inventati fuori da qui.

---

## 0. Principi

1. **Editoriale caldo, non "preset AI".** Crema invece di bianco sterile. Carattere tipografico vero (Outfit). Niente look generico Tailwind/Bootstrap.
2. **Firma da designer:** ombre piene offset colorate (no blur morbido), etichette sezione maiuscole, hero asimmetrico, accenti netti.
3. **Arrotondato ma non "pill ovunque".** Angoli morbidi (12–18px) su card/bottoni; pill SOLO per tab e badge.
4. **Niente emoji come icone UI** → line-icons (nel sito reale: SVG inline o icon-set tipo Tabler/Lucide). Emoji ammesse solo dentro i messaggi-chat di esempio (sono contenuto).
5. **Contrasto sempre ≥ 4.5:1** per testo normale. Verde brand puro NON va su testo (vedi §1).
6. **Non rompere i18n né JS.** Si tocca solo CSS/markup di presentazione: mai chiavi `data-i18n` / oggetti `TR`, mai `id`/classi usate dal polling o dagli handler.

---

## 1. Colori (token)

```css
:root{
  --ink:       #16271c;  /* testo principale / sfondi scuri (CTA, footer) */
  --green:     #2f9e3a;  /* brand operativo: icone, check, bottoni verdi, accenti */
  --green-d:   #1b7a28;  /* verde testo su chiaro (label, link, titoli verdi) — contrasto ok */
  --green-l:   #eaf6e4;  /* sfondo verde chiaro (sezioni, badge "ok") */
  --brand:     #41b72d;  /* VERDE REALE DEL LOGO — usare SOLO per il logo e micro-accenti decorativi, MAI per testo */
  --amber:     #e2622a;  /* accento caldo / CTA primaria */
  --amber-d:   #a3430f;  /* ambra testo su chiaro + ombra bottone primario */
  --amber-l:   #fcefe6;  /* sfondo ambra chiaro (badge "warning"/before) */
  --cream:     #fbf6ec;  /* sfondo pagina */
  --paper:     #fffdf8;  /* sfondo card */
  --muted:     #52605a;  /* testo secondario */
  --line:      #e7ddcb;  /* bordi hairline */
}
```

**Regole colore**
- Verde del logo `#41b72d` è lime brillante → bellissimo sul tile logo, **illeggibile come testo** su crema. Per testo/icone usare `--green` / `--green-d`.
- CTA primaria = **ambra** (`--amber`), non verde — risalta sul mare di verde e guida il click.
- Stati ordine (badge): mantenere i colori semantici esistenti (giallo=preparando, verde=listo, blu=in consegna, rosso=cancelado) ma con i toni della palette dove possibile.
- Sezione CTA / footer = sfondo `--ink`, testo `--cream`, accento verde chiaro `#7fe06a`.

---

## 2. Tipografia

- **Display/titoli:** `Outfit` (700/600). Geometrico moderno, caldo.
- **Corpo:** `Inter` (400/500/600).
- Google Fonts:
  ```html
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=Inter:wght@400;500;600&display=swap" rel="stylesheet"/>
  ```
- Titolo verde accento: usare `--green-d` (non `--green`) per contrasto.
- Hero: titolo grande (clamp ~2.8–3rem), seconda riga in **corsivo verde**.
- Etichette sezione ("EL PROBLEMA", "FUNCIONALIDADES"): 11px, uppercase, letter-spacing .16em, colore `--muted`. **Niente numeri di sezione** (01/02 rimossi). I numeri restano solo dove sono contenuto reale (es. step "Cómo funciona").

---

## 3. Componenti

### Bottoni
- **Primario:** bg `--amber`, testo bianco, `border-radius:12px`, ombra-spessore `box-shadow:0 4px 0 var(--amber-d)`; hover → `translateY(2px)` + ombra 2px (effetto "premuto").
- **Ghost/secondario:** bg `--paper`, bordo `--line`, hover bordo+testo verde.

### Card
- bg `--paper`, bordo `1px solid --line`, `border-radius:16–18px`.
- Card chiave (mockup hero, piano "popular", box settore): **ombra offset colorata leggera**, es. `box-shadow:8px 10px 0 rgba(47,158,58,.22)` (verde) o `rgba(226,98,42,.22)` (ambra).
- Card secondarie (feature, step): sfondo `--cream` piatto, niente ombra.

### Badge / Pill
- Pill SOLO per: tab settori, badge stato, "Más popular".
- Badge stato: testo nel tono scuro della stessa famiglia (es. ambra-d su ambra-l).
- "Más popular": piccola pill ambra, ancorata in alto alla card featured (bordo card `2px solid --amber`).

### Tab (settori, ecc.)
- Pill: attivo = bg `--green` testo bianco; inattivo = bg `--paper` bordo `--line` testo `--muted`.

### FAQ / accordion
- Card `--paper` arrotondata, `+ / –` ambra a destra. Una aperta per volta o multiple (mantieni comportamento attuale).

### Mockup "browser"
- Cornice card arrotondata + 3 pallini (ambra/giallo/verde) + ombra offset verde.

### Icone
- Line-icons coerenti (un solo set). Dimensioni fisse. Colore `--green` per icone funzione, `--muted` per neutre.

---

## 4. Logo

- Usare il file reale **`/images/logo.webp`** (fiore bianco 5 petali su tile verde `#41b72d`).
- Nav: logo + wordmark "sarabot" in Outfit.
- NON ricreare il fiore in SVG nel sito reale (era solo per le anteprime).

---

## 5. Applicazione per superficie

| Superficie | File | Note specifiche |
|-----------|------|-----------------|
| **Landing** | `landingpage/index.html` | Riscrivi blocco `<style>` + markup wrapper. Mantieni TUTTE le chiavi `data-i18n` e l'oggetto `TR` inline. Sezioni: nav, hero asimmetrico, mockup, before/after, features(8), settori(tab), cómo funciona(4 step), planes(4 affiancati), faq, cta scura, footer. |
| **Admin** | `public/admin/index.html` | Usa Tailwind CDN: aggiungi `tailwind.config` con i token come `theme.extend.colors`, oppure inserisci `:root` + classi custom. **Non toccare** il polling 3–15s né gli `id`. Login screen + pannello (tab catalogo/ordini/chat/clientes/turnos/plan) + modali. |
| **Admin i18n / errori** | `public/admin/i18n.js` | Solo testi — non si tocca per estetica. Gli errori (`errMsg`/`err.*`) restano; eventualmente restyle del *contenitore* toast/alert in `index.html`. |
| **Register** | `public/register/index.html` | Form multi-step. Stessi token. Mantieni `data-i18n` + flusso. |
| **Superadmin** | `public/superadmin/index.html` | Tab Clientes/Analytics/Promos/Soporte. I grafici SVG: ricolora con palette (verde/ambra). Badge stato tenant: tono palette. |
| **Legali** | `public/legal/*.html` (terms, privacy, disclaimer, dpa) | Layout testo lungo: applica font Outfit titoli + Inter corpo, crema, max-width leggibile (~70ch), `setLang` inline invariato. |
| **Email** | `services/mailer.js` | 5 builder HTML (welcome, reset, delete, username, phone). Vedi §6. |

---

## 6. Email — regole specifiche

Email = HTML inline, client-safe. **Non** usare Outfit (molti client non caricano web-font) → `font-family: 'Segoe UI', system-ui, -apple-system, Arial, sans-serif` con brand applicato via colore.

Sostituzioni nei 5 template di `mailer.js`:
- Sfondo body: `#f0fdf4` → `#fbf6ec` (crema). (Email delete resta tono allerta: `#fdf0ec`.)
- Bordo header `3px solid #22c55e` → `3px solid #2f9e3a`.
- Bottone primario `background:#22c55e` → **`#e2622a`** (ambra brand) tranne il bottone "elimina account" che resta rosso `#ef4444`.
- Box trial `#f0fdf4`/`#bbf7d0`/`#15803d` → `--green-l`/bordo `#c2e3c6`/testo `--green-d`.
- Logo resta `logosarabot.webp` (o passare a `logo.webp` se preferito).
- Mantieni tutte le traduzioni (T/TR/TD/TU/TP) intatte.

---

## 7. Checklist pre-consegna (per ogni superficie)

- [ ] Token colore presi SOLO da §1
- [ ] Outfit+Inter caricati (web) / system-font (email)
- [ ] Nessuna emoji come icona UI
- [ ] CTA primaria ambra con ombra-spessore
- [ ] Contrasto testo ≥ 4.5:1 (verde testo = `--green-d`, mai `--brand`)
- [ ] Logo = file reale `/images/logo.webp`
- [ ] `data-i18n` / `TR` / `id` / polling **intatti**
- [ ] Tutte le lingue ES/EN/IT/DE/FR(/PT) ancora funzionanti
- [ ] Responsive 375 / 768 / 1024 / 1440
- [ ] Focus states visibili (accessibilità)

---

## 8. Ordine di lavoro consigliato

1. Landing (massimo impatto, già prototipata in chat → v5).
2. Email (`mailer.js`, 5 builder — veloce, alto valore percepito).
3. Admin (login + pannello) — la superficie più usata dai merchant.
4. Register.
5. Superadmin.
6. Legali.

Procedere una superficie per volta, verificare in preview, poi commit + push + aggiornare HANDOFF.md.
