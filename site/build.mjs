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
    return { id: r.id, meal: r.meal, ing: r.ing, kcal: Math.round(kcal), p: +prot.toFixed(1) };
  }),
  names: Object.fromEntries(recipes.map((r) => [r.id, r.name_ua])),
};
const html = fs.readFileSync(path.join(ROOT, 'site', 'template.html'), 'utf8').replace('__DATA__', JSON.stringify(data));
fs.mkdirSync(path.join(ROOT, 'public'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'public', 'index.html'), html);
console.log(`public/index.html: ${html.length} байт, ${products.length} продуктів, ${recipes.length} рецептів, ціни на ${pb.date}`);
