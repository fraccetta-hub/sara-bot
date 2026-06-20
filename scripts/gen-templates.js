// Generates the two import templates served by GET /admin/catalog-template:
//   public/catalog_template.xlsx  (shop/products tenants)
//   public/menu_template.xlsx     (restaurant tenants)
// English field headers; one instruction sheet in EN ("Instructions") and one
// in ES ("Instrucciones"). Run: node scripts/gen-templates.js
const ExcelJS = require('exceljs');
const path = require('path');

const HEADER_FILL = 'FF16A34A';   // green-600
const HEADER_FONT = 'FFFFFFFF';

function styleHeader(ws, ncols) {
  const row = ws.getRow(1);
  row.font = { bold: true, color: { argb: HEADER_FONT }, size: 12 };
  row.height = 22;
  for (let c = 1; c <= ncols; c++) {
    const cell = row.getCell(c);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } } };
  }
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ncols } };
}

// Yes/No dropdown on the "available" column for data rows
function availableDropdown(ws, colLetter, lastRow = 500) {
  for (let r = 2; r <= lastRow; r++) {
    ws.getCell(`${colLetter}${r}`).dataValidation = {
      type: 'list', allowBlank: true, formulae: ['"Yes,No"'],
    };
  }
}

function writeInstructions(ws, lines) {
  ws.columns = [{ width: 100 }];
  lines.forEach((ln, i) => {
    const cell = ws.getCell(`A${i + 1}`);
    cell.value = ln.text;
    cell.alignment = { wrapText: true, vertical: 'top' };
    if (ln.h) cell.font = { bold: true, size: ln.h === 1 ? 14 : 12, color: { argb: 'FF16A34A' } };
    else cell.font = { size: 11, color: { argb: 'FF374151' } };
  });
}

// ── CATALOG (shop) ──────────────────────────────────────────────────────────
async function buildCatalog() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Catalog');
  ws.columns = [
    { header: 'name',        key: 'name',        width: 28 },
    { header: 'category',    key: 'category',    width: 18 },
    { header: 'description', key: 'description',  width: 42 },
    { header: 'price',       key: 'price',       width: 12 },
    { header: 'stock',       key: 'stock',       width: 10 },
    { header: 'available',   key: 'available',   width: 12 },
  ];
  ws.addRows([
    { name: 'Red Roses Bouquet',     category: 'Bouquets',     description: 'Dozen of fresh red roses',        price: 90000,  stock: 15, available: 'Yes' },
    { name: 'Sunflower Arrangement', category: 'Arrangements', description: 'Bright sunflowers in a glass vase', price: 75000,  stock: 8,  available: 'Yes' },
    { name: 'Orchid Pot',            category: 'Plants',       description: 'Purple phalaenopsis orchid',       price: 120000, stock: 5,  available: 'No'  },
  ]);
  styleHeader(ws, 6);
  availableDropdown(ws, 'F');

  writeInstructions(wb.addWorksheet('Instructions'), INSTRUCTIONS_EN_CATALOG);
  writeInstructions(wb.addWorksheet('Instrucciones'), INSTRUCTIONS_ES_CATALOG);

  await wb.xlsx.writeFile(path.join(__dirname, '../public/catalog_template.xlsx'));
  console.log('wrote public/catalog_template.xlsx');
}

// ── MENU (restaurant) ───────────────────────────────────────────────────────
async function buildMenu() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Menu');
  ws.columns = [
    { header: 'name',        key: 'name',        width: 28 },
    { header: 'category',    key: 'category',    width: 18 },
    { header: 'description', key: 'description',  width: 42 },
    { header: 'allergens',   key: 'allergens',   width: 26 },
    { header: 'price',       key: 'price',       width: 12 },
    { header: 'available',   key: 'available',   width: 12 },
  ];
  ws.addRows([
    { name: 'Milanesa Napolitana', category: 'Main dishes', description: 'Breaded beef with ham, cheese and tomato sauce', allergens: 'Gluten, Dairy, Egg',  price: 45000, available: 'Yes' },
    { name: 'Caesar Salad',        category: 'Starters',    description: 'Romaine, croutons, parmesan, caesar dressing',    allergens: 'Gluten, Dairy, Fish', price: 30000, available: 'Yes' },
    { name: 'Tiramisu',            category: 'Desserts',    description: 'Classic Italian coffee dessert',                  allergens: 'Gluten, Dairy, Egg',  price: 25000, available: 'Yes' },
  ]);
  styleHeader(ws, 6);
  availableDropdown(ws, 'F');

  writeInstructions(wb.addWorksheet('Instructions'), INSTRUCTIONS_EN_MENU);
  writeInstructions(wb.addWorksheet('Instrucciones'), INSTRUCTIONS_ES_MENU);

  await wb.xlsx.writeFile(path.join(__dirname, '../public/menu_template.xlsx'));
  console.log('wrote public/menu_template.xlsx');
}

// ── Instruction text ────────────────────────────────────────────────────────
const COMMON_EN = (kind, itemWord) => [
  { text: `How to import your ${kind}`, h: 1 },
  { text: '' },
  { text: `1. Fill in the "${kind === 'menu' ? 'Menu' : 'Catalog'}" sheet — one ${itemWord} per row, starting on row 2 (the example rows can be overwritten or deleted).`, h: 2 },
  { text: '2. Keep the header names in row 1 exactly as they are. Do not rename or reorder the columns.' },
  { text: '3. When finished, import it from the admin panel: Products → Import → CSV. You can paste the data, upload a .csv file, or link a public Google Sheet.' },
  { text: '' },
  { text: 'Columns', h: 2 },
  { text: 'name (required) — the name customers see and search for.' },
  { text: 'category — used to group items (e.g. Bouquets, Starters). Optional but recommended.' },
  { text: 'description — short text shown to customers. Optional.' },
];
const PRICE_EN = (kind) => ({ text: `price (required) — a number only, in your plan currency. Decimals allowed (e.g. 90000 or 4.99). Do not add currency symbols.` });
const AVAIL_EN = { text: 'available — "Yes" or "No". Leave blank to default to Yes. Items set to No stay in your list but are hidden from customers.' };
const PHOTO_EN = { text: 'Photos are NOT imported here. Export your catalog, rename each photo to match the item name, zip them and upload from Products → "ZIP images".' };
const DEDUP_EN = { text: 'Items whose name already exists are skipped (no duplicates are created).' };

const INSTRUCTIONS_EN_CATALOG = [
  ...COMMON_EN('catalog', 'product'),
  PRICE_EN('catalog'),
  { text: 'stock — quantity available, a whole number. Leave blank if you do not track stock.' },
  AVAIL_EN,
  { text: '' },
  { text: 'Notes', h: 2 },
  PHOTO_EN,
  DEDUP_EN,
];
const INSTRUCTIONS_EN_MENU = [
  ...COMMON_EN('menu', 'dish'),
  { text: 'allergens — comma-separated list (e.g. Gluten, Dairy, Egg). Optional but recommended.' },
  PRICE_EN('menu'),
  AVAIL_EN,
  { text: '' },
  { text: 'Notes', h: 2 },
  { text: 'Dishes do not use stock — every dish is always available unless you set "available" to No.' },
  PHOTO_EN,
  DEDUP_EN,
];

const COMMON_ES = (kind, itemWord, sheetName) => [
  { text: `Cómo importar tu ${kind === 'menu' ? 'menú' : 'catálogo'}`, h: 1 },
  { text: '' },
  { text: `1. Completá la hoja "${sheetName}" — un ${itemWord} por fila, desde la fila 2 (podés sobrescribir o borrar las filas de ejemplo).`, h: 2 },
  { text: '2. Mantené los nombres de la fila 1 (encabezados) exactamente como están. No los renombres ni cambies el orden de las columnas.' },
  { text: '3. Cuando termines, importalo desde el panel: Productos → Importar → CSV. Podés pegar los datos, subir un archivo .csv o enlazar un Google Sheet público.' },
  { text: '' },
  { text: 'Columnas', h: 2 },
  { text: 'name (obligatorio) — el nombre que ven y buscan los clientes.' },
  { text: 'category — agrupa los ítems (ej: Ramos, Entradas). Opcional pero recomendado.' },
  { text: 'description — texto corto que ven los clientes. Opcional.' },
];
const PRICE_ES = { text: 'price (obligatorio) — solo un número, en la moneda de tu plan. Se permiten decimales (ej: 90000 o 4.99). No agregues símbolos de moneda.' };
const AVAIL_ES = { text: 'available — "Yes" o "No". Dejala vacía para que sea Yes por defecto. Los ítems en No quedan en tu lista pero ocultos para los clientes.' };
const PHOTO_ES = { text: 'Las fotos NO se importan acá. Exportá tu catálogo, renombrá cada foto con el nombre del ítem, hacé un zip y subilo desde Productos → "Imágenes ZIP".' };
const DEDUP_ES = { text: 'Los ítems cuyo nombre ya existe se omiten (no se crean duplicados).' };

const INSTRUCTIONS_ES_CATALOG = [
  ...COMMON_ES('catalog', 'producto', 'Catalog'),
  PRICE_ES,
  { text: 'stock — cantidad disponible, número entero. Dejala vacía si no llevás control de stock.' },
  AVAIL_ES,
  { text: '' },
  { text: 'Notas', h: 2 },
  PHOTO_ES,
  DEDUP_ES,
];
const INSTRUCTIONS_ES_MENU = [
  ...COMMON_ES('menu', 'plato', 'Menu'),
  { text: 'allergens — lista separada por comas (ej: Gluten, Lácteos, Huevo). Opcional pero recomendado.' },
  PRICE_ES,
  AVAIL_ES,
  { text: '' },
  { text: 'Notas', h: 2 },
  { text: 'Los platos no usan stock — cada plato está siempre disponible salvo que pongas "available" en No.' },
  PHOTO_ES,
  DEDUP_ES,
];

(async () => {
  await buildCatalog();
  await buildMenu();
})();
