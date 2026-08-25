/* One-off: insert a single title the allowlist now admits, without rebuilding. */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const ID = Number(process.argv[2]);
const MAL = readFileSync('.mal-client-id', 'utf8').trim();
const c = JSON.parse(readFileSync('anime.json', 'utf8'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

if (c.anime.some(a => a.i === ID)) { console.log('already present'); process.exit(0); }

const GENRE_IDS = new Set([1,2,5,46,28,4,8,9,49,10,26,47,12,14,7,22,24,36,30,37,41]);
const DEMOGRAPHIC_IDS = new Set([27,42,25,43,15]);
const TYPE = { tv:'TV', ova:'OVA', ona:'ONA' };

const nameId = (n) => { let i=c.names.indexOf(n); if(i===-1){c.names.push(n); i=c.names.length-1;} return i; };

const fields = 'id,title,alternative_titles,mean,rank,genres,status,num_episodes,media_type,start_season,num_list_users,main_picture,statistics';
const r = await fetch(`https://api.myanimelist.net/v2/anime/${ID}?fields=${fields}`, { headers:{'X-MAL-CLIENT-ID':MAL} });
const n = await r.json();
if (!n.title) { console.error('MAL lookup failed'); process.exit(1); }

const g=[], th=[], d=[];
for (const x of n.genres ?? []) {
  if (GENRE_IDS.has(x.id)) g.push(nameId(x.name));
  else if (DEMOGRAPHIC_IDS.has(x.id)) d.push(nameId(x.name));
  else th.push(nameId(x.name));
}
const s = n.statistics?.status;
const en = n.alternative_titles?.en;

const entry = {
  r: n.rank, i: n.id, t: n.title,
  ...(en && en !== n.title ? { en } : {}),
  s: n.mean ?? null,
  ty: TYPE[n.media_type] ?? n.media_type,
  st: { finished_airing:'fin', currently_airing:'air', not_yet_aired:'soon' }[n.status] ?? null,
  e: n.num_episodes || null,
  y: n.start_season?.year ?? null,
  m: n.num_list_users ?? null,
  im: /images\/anime\/(.+)$/.exec(n.main_picture?.medium || '')?.[1] ?? null,
  g, th, d,
  stats: s ? { w:+s.watching||0, c:+s.completed||0, h:+s.on_hold||0, d:+s.dropped||0, p:+s.plan_to_watch||0 } : null,
};

// art from AniList
await sleep(300);
const al = await fetch('https://graphql.anilist.co', {
  method:'POST', headers:{'Content-Type':'application/json'},
  body: JSON.stringify({ query:'query($id:Int){Media(idMal:$id,type:ANIME){coverImage{color} bannerImage}}', variables:{ id: ID } }),
}).then(r=>r.json()).catch(()=>null);
const col = al?.data?.Media?.coverImage?.color;
if (col) entry.cl = col.replace('#','');
const bn = /banner\/(.+)$/.exec(al?.data?.Media?.bannerImage || '')?.[1];
if (bn) entry.bn = bn;

c.anime.push(entry);
c.anime.sort((a,b)=>a.r-b.r);
c.count = c.anime.length;
writeFileSync('anime.json', JSON.stringify(c));

console.log(`added #${entry.r}  ${entry.ty}  ${entry.t}`);
console.log(`  genres: ${g.map(i=>c.names[i]).join(', ')||'—'}  themes: ${th.map(i=>c.names[i]).join(', ')||'—'}  demo: ${d.map(i=>c.names[i]).join(',')||'—'}`);
console.log(`  colour: ${entry.cl?'#'+entry.cl:'—'}  banner: ${entry.bn?'yes':'no'}`);
console.log(`  catalogue now ${c.count} entries`);

/* Regenerate the prerendered pages rather than printing a reminder to.
 * Adding an entry changes what the walk serves for its neighbours, so leaving
 * this out would ship a catalogue whose pages disagree with it — and "a step
 * you have to remember" is the exact footgun dropping TMDB removed from the
 * rebuild. It costs about 25 seconds. */
console.log('regenerating prerendered pages…');
execSync('node build-seo-pages.mjs', { stdio: 'inherit' });
