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

/**
 * D1 accepts at most this many bound parameters in one query.
 *
 * Build 56. Not a tidiness limit and not the CPU budget — exceeding it throws,
 * and the throw surfaces as a 503 that says nothing about the cause.
 */
export const D1_MAX_PARAMS = 100;

/**
 * Most votes one import request may carry.
 *
 * **`D1_MAX_PARAMS - 1`, and the missing one is the whole bug of build 56.**
 * Before recording anything, POST /api/vote looks up what this voter has
 * already said:
 *
 *     SELECT anime, score, liked FROM votes WHERE voter = ? AND anime IN (?, ?, ...)
 *
 * That binds **one parameter per vote plus one for the voter**. At the old
 * value of 100 the lookup asked for 101, D1 rejected it, and the endpoint
 * answered 503 "Could not record that just now."
 *
 * **Every list import failed on its first chunk**, because the client chunked
 * at exactly 100 to match this number — so the two constants agreed with each
 * other and were both wrong. The client stops rather than hammering a failing
 * endpoint, so nothing after chunk one was attempted either: no imported list
 * ever contributed a rating, for the eighteen builds between stage three
 * shipping and this being found.
 *
 * It hid because it is invisible at every size anyone tests by hand. A thumb
 * binds two parameters. The suite drives real SQLite, which allows far more.
 * Only a full chunk from a real import crosses the line, and it crosses it by
 * one.
 *
 * The CPU budget is a real constraint too and 99 is comfortably inside it —
 * this is now the tighter of the two limits, not a replacement for it.
 */
export const MAX_BATCH = D1_MAX_PARAMS - 1;

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
