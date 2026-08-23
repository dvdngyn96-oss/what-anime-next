/* POST /api/vote
 *
 * Two shapes, one table:
 *   { voter, anime, liked }            a thumb on the card
 *   { voter, votes: [{ anime, score }] } a MyAnimeList import, chunked
 *
 * Every write updates two rows: the person's own vote in `votes`, and the
 * running aggregate for that title in `ratings`. The aggregate is what makes
 * reads cheap, and keeping it correct here is the price of that.
 *
 * There is no account and there never will be one, so a vote is identified by
 * a random id the browser keeps in local storage. That is enough to stop
 * double-counting an honest visitor and stop nobody at all determined — which
 * is the accepted trade, and the reason the numbers should be presented as
 * soft rather than as survey data.
 */
import { json, bad, animeId, voterId, MAX_BATCH } from './_shared.js';

/** Which aggregate column a vote lands in. The names are chosen here from a
 *  fixed set, never taken from the request, so they cannot become injection. */
function column(vote) {
  if (vote.liked === 1) return 'up';
  if (vote.liked === 0) return 'down';
  if (vote.score >= 1 && vote.score <= 10) return `s${vote.score}`;
  return null;
}

/* One entry point that dispatches, rather than a method-specific export plus a
 * catch-all. Exporting both leaves it ambiguous which Pages will prefer, and
 * the answer to that is not worth depending on.
 *
 * The catch-all earns its place: Pages routes a method only if something
 * handles it, so an unrouted GET here would fall through to the static handler
 * and answer 200 with the SPA's index.html. A JSON endpoint replying with a
 * web page is the kind of thing that reads as healthy to a monitor and
 * baffling to a person. */
export function onRequest(context) {
  if (context.request.method === 'POST') return record(context);
  return bad('This endpoint takes POST.', 405);
}

async function record({ request, env }) {
  if (!env.VOTES) return bad('Voting is not available right now.', 503);

  let body;
  try {
    body = await request.json();
  } catch {
    return bad('Expected JSON.');
  }

  const voter = voterId(body?.voter);
  if (!voter) return bad('Missing or malformed voter id.');

  // Normalise both shapes into one list.
  const incoming = Array.isArray(body.votes)
    ? body.votes.map((v) => ({ anime: animeId(v?.anime), score: Number(v?.score), liked: null, source: 'import' }))
    : [{ anime: animeId(body.anime), score: null, liked: body.liked === true ? 1 : body.liked === false ? 0 : null, source: 'thumb' }];

  if (!incoming.length) return bad('Nothing to record.');
  if (incoming.length > MAX_BATCH) return bad(`At most ${MAX_BATCH} votes per request.`);

  const votes = incoming.filter((v) => v.anime !== null && column(v) !== null);
  if (!votes.length) return bad('No usable votes.');

  const now = Math.floor(Date.now() / 1000);
  const ids = votes.map((v) => v.anime);

  let existing = new Map();
  try {
    const placeholders = ids.map(() => '?').join(',');
    const found = await env.VOTES
      .prepare(`SELECT anime, score, liked FROM votes WHERE voter = ? AND anime IN (${placeholders})`)
      .bind(voter, ...ids)
      .all();
    existing = new Map((found.results || []).map((r) => [r.anime, r]));
  } catch {
    return bad('Could not record that just now.', 503);
  }

  const statements = [];
  let changed = 0;

  for (const vote of votes) {
    const to = column(vote);
    const was = existing.get(vote.anime);
    const from = was ? column({ score: was.score, liked: was.liked }) : null;
    if (from === to) continue;              // same answer as last time; nothing to do
    changed += 1;

    statements.push(env.VOTES
      .prepare(`INSERT INTO votes (voter, anime, score, liked, source, updated)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(voter, anime) DO UPDATE SET
                  score = excluded.score, liked = excluded.liked,
                  source = excluded.source, updated = excluded.updated`)
      .bind(voter, vote.anime, vote.score ?? null, vote.liked ?? null, vote.source, now));

    // Move the aggregate: out of the old bucket, into the new one. Both halves
    // ride in the same batch as the vote itself, so a failure cannot leave the
    // count disagreeing with the rows behind it.
    if (from) {
      statements.push(env.VOTES
        .prepare(`UPDATE ratings SET ${from} = MAX(${from} - 1, 0), updated = ? WHERE anime = ?`)
        .bind(now, vote.anime));
    }
    statements.push(env.VOTES
      .prepare(`INSERT INTO ratings (anime, ${to}, updated) VALUES (?, 1, ?)
                ON CONFLICT(anime) DO UPDATE SET ${to} = ${to} + 1, updated = excluded.updated`)
      .bind(vote.anime, now));
  }

  if (!statements.length) return json({ recorded: 0, unchanged: votes.length });

  try {
    await env.VOTES.batch(statements);
  } catch {
    return bad('Could not record that just now.', 503);
  }

  return json({ recorded: changed, unchanged: votes.length - changed });
}
