// Pre-commit guard: a single JS syntax error in these browser-served files blanks
// the whole admin UI (a dup `const`, an unescaped apostrophe, etc.). Validate the
// files that have caused white pages before — i18n tables and the inline scripts
// of the HTML panels. Exits non-zero (blocking the commit) on the first error.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
let errors = 0;

function check(label, code) {
  try { new Function(code); }
  catch (e) { console.error(`✗ ${label}: ${e.message}`); errors++; }
}

// Plain JS files loaded as classic <script> (object/const tables).
const jsFiles = ['public/admin/i18n.js', 'public/register/i18n.js'];
for (const rel of jsFiles) {
  const p = path.join(root, rel);
  if (fs.existsSync(p)) check(rel, fs.readFileSync(p, 'utf8'));
}

// Inline <script> blocks inside the HTML panels.
const htmlFiles = ['public/admin/index.html', 'public/register/index.html', 'public/superadmin/index.html'];
for (const rel of htmlFiles) {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) continue;
  const html = fs.readFileSync(p, 'utf8');
  const re = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi;
  let m, i = 0;
  while ((m = re.exec(html))) {
    i++;
    const body = m[1].trim();
    if (!body) continue; // <script src="..."></script>
    check(`${rel} (inline script #${i})`, body);
  }
}

if (errors) {
  console.error(`\npre-commit: ${errors} JS syntax error(s) — commit blocked. Fix them or use --no-verify to override.`);
  process.exit(1);
}
console.log('pre-commit: UI syntax OK');
