/* One-off: add the animation studio to each catalogue entry.
   MAL returns studios on the bulk ranking endpoint, so this is eight requests
   rather than one per title. Fold into build-catalogue.mjs after running once. */
import { readFileSync, writeFileSync } from 'node:fs';

const MAL = readFileSync('.mal-client-id', 'utf8').trim();
const c = JSON.parse(readFileSync('anime.json', 'utf8'));
const byId = new Map(c.anime.map(a => [a.i, a]));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const studioNames = c.studios ?? [];
const studioId = (n) => { let i = studioNames.indexOf(n); if (i === -1) { studioNames.push(n); i = studioNames.length - 1; } return i; };

let tagged = 0;
for (let offset = 0; offset < 8000; offset += 500) {
  const res = await fetch(
    `https://api.myanimelist.net/v2/anime/ranking?ranking_type=all&limit=500&offset=${offset}&fields=id,studios`,
    { headers: { 'X-MAL-CLIENT-ID': MAL } });
  if (!res.ok) { console.log(`  ${res.status} at ${offset}`); await sleep(2000); continue; }
  const j = await res.json();
  for (const { node } of j.data) {
    const e = byId.get(node.id);
    if (!e) continue;
    const names = (node.studios ?? []).map(s => s.name).filter(Boolean);
    if (names.length) { e.su = names.map(studioId); tagged++; }
  }
  console.log(`  offset ${offset} -> ${tagged} tagged`);
  await sleep(700);
}

c.studios = studioNames;
writeFileSync('anime.json', JSON.stringify(c));
console.log(`\n${tagged}/${c.anime.length} have a studio, ${studioNames.length} distinct.`);
const counts = {};
for (const a of c.anime) for (const i of a.su ?? []) counts[studioNames[i]] = (counts[studioNames[i]] ?? 0) + 1;
console.log('most prolific: ' + Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([n,v])=>`${n} (${v})`).join(', '));
