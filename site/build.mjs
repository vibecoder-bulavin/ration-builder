// Збирає public/index.html з data/*.json і site/template.html. Запускається на Vercel при кожному деплої.
//   node site/build.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f), 'utf8'));
const products = read('products.json');
const recipes = read('recipes.json');
const pb = read('prices.json');
const P = Object.fromEntries(products.map((p) => [p.id, p]));
const DENS = { sunflower_oil: 0.92 };
const grams = (pid, q) => (P[pid].unit === 'pcs' ? q * P[pid].pieceG : q * (DENS[pid] || 1));

const data = {
  date: pb.date,
  products: Object.fromEntries(products.map((p) => [p.id, {
    name: p.name_ua, unit: p.unit || 'g', pack: p.pack ?? null, packName: p.packName ?? null,
    pantry: !!p.pantry, group: p.group, dept: p.dept || 'dry',
  }])),
  prices: pb.prices,
  cities: Object.entries(pb.cities),
  storeNames: pb.storeNames,
  recipes: recipes.map((r) => {
    let kcal = 0, prot = 0;
    for (const [pid, q] of Object.entries(r.ing)) { const g = grams(pid, q); kcal += P[pid].kcal * g / 100; prot += P[pid].p * g / 100; }
    return { id: r.id, meal: r.meal, ing: r.ing, kcal: Math.round(kcal), p: +prot.toFixed(1), t: r.time || 30, b: !!r.batch };
  }),
  names: Object.fromEntries(recipes.map((r) => [r.id, r.name_ua])),
};
let analytics = {};
try { analytics = JSON.parse(fs.readFileSync(path.join(ROOT, 'site', 'analytics.json'), 'utf8')); } catch {}
if (process.env.POSTHOG_KEY) analytics.posthogKey = process.env.POSTHOG_KEY;
const html = fs.readFileSync(path.join(ROOT, 'site', 'template.html'), 'utf8').replace('__DATA__', () => JSON.stringify(data)).replace('__ANALYTICS__', () => JSON.stringify(analytics));
fs.mkdirSync(path.join(ROOT, 'public'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'public', 'index.html'), html);
console.log(`public/index.html: ${html.length} байт, ${products.length} продуктів, ${recipes.length} рецептів, ціни на ${pb.date}`);

// ===== Болгарія: /bg (ціни з відкритих даних КЗП, kolkostruva.bg) =====
// Продуктів, яких немає в кошику КЗП, оцінюємо: київська медіана × співвідношення цін BG/UA по продуктах, що є в обох.
const bgFile = path.join(ROOT, 'data', 'bg', 'prices.json');
if (fs.existsSync(bgFile)) {
  const bg = JSON.parse(fs.readFileSync(bgFile, 'utf8'));
  const bm = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'bg', 'matches.json'), 'utf8'));
  const NO_BG = new Set(['ryazhenka', 'syrnyky_frozen', 'vareniki_cottage', 'crepes_meat', 'dumplings_potato']);   // суто українські напівфабрикати
  const med = (a) => { const s = [...a].sort((x, y) => x - y), k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
  const ua = (pid) => { const v = Object.values(pb.prices.kiev || {}).map((s) => s[pid]).filter((x) => x != null); return v.length ? med(v) : null; };
  const bgv = (pid) => { const v = Object.values(bg.prices).flatMap((c) => Object.values(c).map((s) => s[pid])).filter((x) => x != null); return v.length ? med(v) : null; };
  const ratios = products.map((p) => [bgv(p.id), ua(p.id)]).filter(([a, b]) => a && b).map(([a, b]) => a / b);
  const k = med(ratios);
  const est = products.filter((p) => !NO_BG.has(p.id) && bgv(p.id) == null && ua(p.id) != null).map((p) => p.id);
  const prices = JSON.parse(JSON.stringify(bg.prices));
  for (const c in prices) for (const s in prices[c]) for (const pid of est) prices[c][s][pid] = +(ua(pid) * k).toFixed(3);
  const titles = {}; for (const c in bm.matches) for (const s in bm.matches[c]) for (const pid in bm.matches[c][s]) ((titles[c] ??= {})[s] ??= {})[pid] = bm.matches[c][s][pid].title;
  // Фасовки беремо з болгарських товарів, що потрапили в збіг (найчастіша по магазинах)
  const bgProducts = JSON.parse(JSON.stringify(data.products));
  for (const pr of products) {
    const packs = Object.values(bm.matches).flatMap((c) => Object.values(c).map((s) => s[pr.id]?.pack)).filter(Boolean);
    if (!packs.length) continue;
    const cnt = {}; packs.forEach((x) => { cnt[x] = (cnt[x] || 0) + 1; }); const top = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0][0];
    const n = parseFloat(top); bgProducts[pr.id].pack = top === 'на вагу' || !n ? null : n;
    if (!bgProducts[pr.id].pack) bgProducts[pr.id].packName = null;
  }
  const bgData = { ...data, products: bgProducts, date: bg.date, prices, cities: Object.entries(bg.cities).filter(([c]) => prices[c]), storeNames: { ...bg.storeNames, _est: 'Будь-який магазин · ціни орієнтовні' }, geo: 'bg', cur: '€', k, est, titles };
  const bgHtml = fs.readFileSync(path.join(ROOT, 'site', 'template.html'), 'utf8')
    .replace(/грн/g, '€').replace(/"ration-/g, '"ration-bg-')
    .replace('<title>Раціон під бюджет</title>', '<title>Раціон під бюджет · Болгарія</title>')
    .replace('<h1>Раціон під бюджет</h1>', '<h1>Раціон під бюджет · Болгарія</h1>')
    .replace('step="50" value="2500"', 'step="5" value="100"')
    .replace('__DATA__', () => JSON.stringify(bgData)).replace('__ANALYTICS__', () => '{}');
  fs.mkdirSync(path.join(ROOT, 'public', 'bg'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'public', 'bg', 'index.html'), bgHtml);
  console.log(`public/bg/index.html: ${bgHtml.length} байт, ціни на ${bg.date}, коеф. BG/UA ${k.toFixed(4)}, оцінено ${est.length} продуктів`);
}
