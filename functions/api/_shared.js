/* Shared bits for the two vote endpoints.
 *
 * These run on Cloudflare Pages Functions, which are billed as Workers: the
 * free allowance is 100,000 requests a day and — the part that actually
 * constrains the design — 10ms of CPU per request. A single indexed query is
 * nowhere near that; inserting several hundred rows from a MyAnimeList import
 * in one go could be, which is why the vote endpoint caps a batch and expects
 * the client to chunk.
 */

/** Where a score of this or higher counts as "would recommend".
 *
 * Deliberately applied at read time rather than stored, so it can move without
 * a migration. Starts at 7: MyAnimeList's community averages cluster around
 * there, so it reads as a genuine positive without being harsh. Raising it to
 * 8 is a one-line change and no data is lost either way. */
export const RECOMMEND_AT = 7;

/* A neutral band was tried here and reverted; see "5 and 6 were tried as
 * neutral, and the data said no" in CLAUDE.md. Excluding them read well in
 * principle and pushed 46% of the catalogue above 90%, which made the figure
 * useless. Nothing is excluded: 7 and above is a yes, everything else a no. */

/** Below this many votes a percentage is not shown at all.
 *
 * "100% would recommend" from a single vote is worse than no number — it looks
 * like data and isn't. The endpoint returns the counts regardless and lets the
 * page decide what to say, so this is the page's floor to enforce, not a
 * filter applied here. */
export const VOTE_FLOOR = 30;

/** Most titles one request may ask about. A result page shows a hero and a
 *  grid of twelve, so 40 leaves generous room without inviting a scan of the
 *  whole catalogue in one call. */
export const MAX_IDS = 40;

/** Most votes one import request may carry, so a bulk upload cannot blow the
 *  10ms CPU budget. The client chunks; this is the backstop. */
export const MAX_BATCH = 100;

export const json = (body, status = 200, headers = {}) => new Response(
  JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } }
);

export const bad = (message, status = 400) => json({ error: message }, status);

/** A MyAnimeList id, or null. Ids are positive integers and nothing else. */
export function animeId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n < 1e9 ? n : null;
}

/** A voter id is opaque to us — it is a random string the browser made up and
 *  keeps in local storage. We only care that it is sane in shape, so that a
 *  malformed or enormous one cannot become a storage problem. */
export function voterId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(value) ? value : null;
}

/** Turn one aggregate row into the numbers the card needs.
 *
 * Thumbs and imported scores are pooled into a single figure. Both are kept
 * apart in the row, so splitting them later needs no new data. */
export function tally(row) {
  if (!row) return { yes: 0, total: 0 };
  let yes = row.up || 0;
  let total = (row.up || 0) + (row.down || 0);
  for (let score = 1; score <= 10; score++) {
    const n = row[`s${score}`] || 0;
    total += n;
    if (score >= RECOMMEND_AT) yes += n;
  }
  return { yes, total };
}
