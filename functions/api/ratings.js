/* GET /api/ratings?ids=1,2,3
 *
 * The hot path: every card view asks about the show on screen and the twelve
 * in the grid below it. One row read per title, from the pre-aggregated
 * `ratings` table — never a scan of `votes`. See schema.sql for why that
 * distinction is the whole cost story.
 *
 * Returns { "1": { yes, total }, ... }. Titles nobody has voted on are simply
 * absent rather than returned as zeroes, which keeps the response small when
 * most of the catalogue has no votes yet — which it will not, for a long time.
 */
import { json, bad, animeId, tally, MAX_IDS, VOTE_FLOOR, RECOMMEND_AT } from './_shared.js';

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const raw = (url.searchParams.get('ids') || '').split(',').filter(Boolean);

  if (!raw.length) return bad('Ask for at least one id.');
  if (raw.length > MAX_IDS) return bad(`At most ${MAX_IDS} ids per request.`);

  const ids = [...new Set(raw.map(animeId).filter((n) => n !== null))];
  if (!ids.length) return bad('No usable ids.');

  // No database bound yet, or it fell over: say so plainly and let the page
  // carry on without ratings. The site worked without them yesterday and must
  // keep working without them today — same rule as a failed synopsis fetch,
  // and the reason the card reserves its space rather than growing into it.
  if (!env.VOTES) return json({ ratings: {}, unavailable: true }, 200, cacheFor(60));

  let rows;
  try {
    const placeholders = ids.map(() => '?').join(',');
    const result = await env.VOTES
      .prepare(`SELECT * FROM ratings WHERE anime IN (${placeholders})`)
      .bind(...ids)
      .all();
    rows = result.results || [];
  } catch {
    return json({ ratings: {}, unavailable: true }, 200, cacheFor(30));
  }

  const ratings = {};
  for (const row of rows) {
    const { yes, total } = tally(row);
    if (total > 0) ratings[row.anime] = { yes, total };
  }

  /* Cached at the edge for five minutes. Ratings move slowly — a title needs
   * 30 votes before it shows a number at all — so a stale figure is harmless,
   * and most card views then never reach the database. This is what keeps the
   * read allowance comfortable rather than merely sufficient. */
  return json({ ratings, floor: VOTE_FLOOR, recommendAt: RECOMMEND_AT }, 200, cacheFor(300));
}

const cacheFor = (seconds) => ({
  'cache-control': `public, max-age=${seconds}, s-maxage=${seconds}`,
});
