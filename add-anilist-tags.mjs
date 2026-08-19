/**
 * Adds AniList's weighted tags to the catalogue.
 *
 *   node add-anilist-tags.mjs           # fill in anything missing
 *   node add-anilist-tags.mjs --refresh # re-fetch tags for everything
 *
 * MyAnimeList gives each show three flat genres and a handful of themes.
 * AniList gives ~12 community-voted tags with a relevance percentage —
 * Fullmetal Alchemist: Brotherhood is "Alchemy 97%, Military 92%, War 90%,
 * Politics 84%" where MAL offers only "Military". That weighting is what makes
 * a useful similarity score possible.
 *
 * Kept separate from build-catalogue.mjs for the same reason the providers
 * pass is: it can be re-run on its own in a couple of minutes. The builder
 * also collects tags in its art pass, so a full rebuild does not need this —
 * it exists to retrofit an existing catalogue and to refresh a stale one.
 *
 * Needs no credentials. AniList's public GraphQL endpoint is unauthenticated.
 *
 * Storage: each tag packs into one integer, `index * 10 + weight`, where
 * weight is floor(rank/10) clamped to 5..9. Only tags at 50% or better are
 * kept, so the units digit is never 0 and the pair always decodes cleanly.
 * Names live in a `tagNames` table of their own rather than the shared `names`
 * array — g/th/d index into that one, and appending to it from a separate
 * script is how index drift starts.
 */

import { readFileSync, writeFileSync, renameSync } from 'node:fs';

const FILE = new URL('./anime.json', import.meta.url);
const TMP = new URL('./anime.json.tmp', import.meta.url);

/**
 * Write via a temp file and rename.
 *
 * A checkpoint straight onto anime.json died with UNKNOWN (errno -4094) mid-run
 * on Windows — the file was momentarily locked by another reader. Renaming over
 * it is atomic, so a lock costs a retry rather than a truncated catalogue.
 */
async function saveCatalogue(data) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      writeFileSync(TMP, JSON.stringify(data));
      renameSync(TMP, FILE);
      return true;
    } catch (err) {
      if (attempt === 4) { console.error(`  save failed: ${err.code}`); return false; }
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  return false;
}
const REFRESH = process.argv.includes('--refresh');

const PER_REQUEST = 50;
const GAP = 2000;            // ~30 req/min, inside AniList's limit
const MIN_RANK = 50;         // below this the tag is noise, not signal

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const QUERY = `query ($ids: [Int]) {
  Page(page: 1, perPage: ${PER_REQUEST}) {
    media(idMal_in: $ids, type: ANIME) {
      idMal
      tags { name rank isGeneralSpoiler isMediaSpoiler isAdult }
    }
  }
}`;

const catalogue = JSON.parse(readFileSync(FILE, 'utf8'));
const rows = catalogue.anime;

// Preserve any existing vocabulary so indices already written stay valid.
const tagNames = catalogue.tagNames ? [...catalogue.tagNames] : [];
const indexOfTag = new Map(tagNames.map((n, i) => [n, i]));

function tagIndex(name) {
  if (!indexOfTag.has(name)) {
    indexOfTag.set(name, tagNames.length);
    tagNames.push(name);
  }
  return indexOfTag.get(name);
}

const todo = REFRESH ? rows : rows.filter((r) => !r.tg);
console.log(`${rows.length} entries, ${todo.length} to fetch`);
if (!todo.length) { console.log('nothing to do'); process.exit(0); }

const byMal = new Map(rows.map((r) => [r.i, r]));
const chunks = [];
for (let i = 0; i < todo.length; i += PER_REQUEST) chunks.push(todo.slice(i, i + PER_REQUEST));

let matched = 0;
let tagged = 0;
let totalTags = 0;

for (const [n, chunk] of chunks.entries()) {
  for (let attempt = 0; attempt < 6; attempt++) {
    let res;
    try {
      res = await fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query: QUERY, variables: { ids: chunk.map((r) => r.i) } }),
      });
    } catch {
      await sleep(3000);
      continue;
    }

    if (res.status === 429) {
      await sleep((Number(res.headers.get('retry-after') || 60) + 1) * 1000);
      continue;
    }
    if (!res.ok) { await sleep(3000); continue; }

    const json = await res.json();
    if (json.errors?.length) { console.error('  ' + json.errors[0].message); await sleep(3000); continue; }

    for (const media of json?.data?.Page?.media ?? []) {
      const row = byMal.get(media.idMal);
      if (!row) continue;
      matched++;

      const kept = (media.tags ?? [])
        .filter((t) => !t.isGeneralSpoiler && !t.isMediaSpoiler && !t.isAdult && t.rank >= MIN_RANK)
        .sort((a, b) => b.rank - a.rank);

      if (!kept.length) continue;

      row.tg = kept.map((t) => tagIndex(t.name) * 10 + Math.min(9, Math.floor(t.rank / 10)));
      tagged++;
      totalTags += kept.length;
    }
    break;
  }

  if (n % 10 === 0 || n === chunks.length - 1) {
    console.log(`  batch ${n + 1}/${chunks.length} -> ${matched} matched, ${tagged} tagged`);
    // Checkpoint, so an interrupted run keeps what it has.
    await saveCatalogue({ ...catalogue, tagNames });
  }
  await sleep(GAP);
}

catalogue.tagNames = tagNames;
if (!await saveCatalogue(catalogue)) process.exit(1);

console.log(`\nDone. ${matched} matched on AniList, ${tagged} with usable tags.`);
console.log(`  ${tagNames.length} distinct tag names`);
console.log(`  ${(totalTags / (tagged || 1)).toFixed(1)} tags per tagged title`);
console.log(`  ${rows.filter((r) => !r.tg).length} entries still without tags`);
console.log(`  catalogue now ${Math.round(JSON.stringify(catalogue).length / 1024)} KB`);
