/**
 * Fills in genres for catalogue entries MyAnimeList left blank, using AniList.
 *
 *   node backfill-genres.mjs           # report only
 *   node backfill-genres.mjs --write   # apply
 *
 * MAL's genre data thins out badly for pre-1990 TV and for merchandise-driven
 * shows — 74 entries had none at all, and an entry with no genres can never be
 * matched, so the walk simply cannot reach it. Hyouge Mono (#704, 39 episodes)
 * was among them.
 *
 * Only ever fills where MAL supplied nothing. It never overrides MAL, and
 * `gs: 1` records that the genres came from AniList.
 *
 * build-catalogue.mjs does the same thing during its art pass, so a rebuild
 * needs no follow-up. This exists to fix an existing catalogue.
 *
 * Needs no credentials.
 */

import { readFileSync, writeFileSync, renameSync } from 'node:fs';

const FILE = new URL('./anime.json', import.meta.url);
const TMP = new URL('./anime.json.tmp', import.meta.url);
const WRITE = process.argv.includes('--write');

/* AniList genre -> MAL vocabulary. Kept identical to build-catalogue.mjs. */
const TO_MAL_GENRE = {
  Action: 'Action',
  Adventure: 'Adventure',
  Comedy: 'Comedy',
  Drama: 'Drama',
  Ecchi: 'Ecchi',
  Fantasy: 'Fantasy',
  Horror: 'Horror',
  Mystery: 'Mystery',
  Romance: 'Romance',
  'Sci-Fi': 'Sci-Fi',
  'Slice of Life': 'Slice of Life',
  Sports: 'Sports',
  Supernatural: 'Supernatural',
  Thriller: 'Suspense',
};

/* These four are MAL *themes*, not genres. Putting them in `g` would invent
 * genre values the bucketing logic has never seen. */
const TO_MAL_THEME = {
  'Mahou Shoujo': 'Mahou Shoujo',
  Mecha: 'Mecha',
  Music: 'Music',
  Psychological: 'Psychological',
};

const QUERY = `query ($ids: [Int]) {
  Page(page: 1, perPage: 50) {
    media(idMal_in: $ids, type: ANIME) { idMal genres }
  }
}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const catalogue = JSON.parse(readFileSync(FILE, 'utf8'));
const rows = catalogue.anime;
const names = catalogue.names;

const nameId = (name) => {
  let i = names.indexOf(name);
  if (i === -1) { names.push(name); i = names.length - 1; }
  return i;
};

const blank = rows.filter((r) => !r.g?.length);
console.log(`${rows.length} entries, ${blank.length} without genres\n`);
if (!blank.length) process.exit(0);

const byMal = new Map(blank.map((r) => [r.i, r]));
const found = new Map();

for (let i = 0; i < blank.length; i += 50) {
  const chunk = blank.slice(i, i + 50);
  const res = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query: QUERY, variables: { ids: chunk.map((r) => r.i) } }),
  });
  if (!res.ok) { console.error(`  HTTP ${res.status}`); break; }
  const json = await res.json();
  if (json.errors?.length) { console.error('  ' + json.errors[0].message); break; }
  for (const m of json.data.Page.media) found.set(m.idMal, m.genres ?? []);
  await sleep(2000);
}

let filled = 0;
let stillBlank = 0;
const unmapped = new Set();

for (const row of blank) {
  const anilistGenres = found.get(row.i) ?? [];
  const genres = [];
  const themes = new Set(row.th ?? []);

  for (const name of anilistGenres) {
    if (TO_MAL_GENRE[name]) { genres.push(nameId(TO_MAL_GENRE[name])); continue; }
    if (TO_MAL_THEME[name]) { themes.add(nameId(TO_MAL_THEME[name])); continue; }
    unmapped.add(name);
  }

  const label = (row.en || row.t).slice(0, 40);
  if (genres.length) {
    row.g = genres;
    row.gs = 1;
    if (themes.size) row.th = [...themes];
    filled++;
    console.log(`  #${String(row.r).padStart(4)}  ${label.padEnd(42)} ${genres.map((i) => names[i]).join(', ')}`);
  } else {
    stillBlank++;
    console.log(`  #${String(row.r).padStart(4)}  ${label.padEnd(42)} — nothing usable (${anilistGenres.join(', ') || 'none on AniList'})`);
  }
}

console.log(`\n${filled} filled, ${stillBlank} still without genres`);
if (unmapped.size) console.log(`unmapped AniList genres seen: ${[...unmapped].join(', ')}`);

if (!WRITE) { console.log('\nreport only — re-run with --write to apply'); process.exit(0); }

catalogue.names = names;
writeFileSync(TMP, JSON.stringify(catalogue));
renameSync(TMP, FILE);
console.log('\nwrote anime.json');
