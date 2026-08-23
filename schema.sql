-- whatanimeshouldiwatchnext — vote storage
--
-- Applied by hand once, from the Cloudflare dashboard or wrangler:
--   npx wrangler d1 execute wanx-votes --remote --file=./schema.sql
--
-- Two tables, and the split between them is the whole cost story. `votes`
-- holds one row per person per title and is only ever touched when somebody
-- actually votes. `ratings` holds one row per title and is what every card
-- view reads.
--
-- Computing a percentage by scanning `votes` at read time would cost one row
-- read per vote per card view — a title with 5,000 votes would cost 5,000
-- reads every time it appeared. D1's free allowance is 5 million reads a day,
-- so a few hundred visitors would exhaust it. Reading a single pre-aggregated
-- row instead costs 1. That is the difference between free forever and a bill.

-- The raw signal, never a derived verdict.
--
-- A thumb gives liked 1/0 and no score; a MyAnimeList import gives a score of
-- 1-10 and no thumb. Both are kept as they arrived, because "what counts as a
-- recommendation" is a judgement that will be retuned — it starts at 7 and up
-- — and a stored verdict could not be retuned without asking everyone again.
CREATE TABLE IF NOT EXISTS votes (
  voter    TEXT    NOT NULL,          -- random id from local storage, no account
  anime    INTEGER NOT NULL,          -- MyAnimeList id, matched against the catalogue
  score    INTEGER,                   -- 1-10 from an import, NULL for a thumb
  liked    INTEGER,                   -- 1/0 from a thumb, NULL for an import
  source   TEXT    NOT NULL,          -- 'thumb' | 'import'
  updated  INTEGER NOT NULL,          -- epoch seconds
  PRIMARY KEY (voter, anime)
);

CREATE INDEX IF NOT EXISTS votes_by_anime ON votes (anime);

-- The running aggregate. One row per title, read on every card view.
--
-- A full histogram rather than a yes/total pair, and the ten extra columns buy
-- something specific: any threshold can be computed from this row at read
-- time. Storing yes/total instead would bake "7 or higher" into the data, and
-- moving to 8 later would mean recomputing every title from `votes`. The read
-- costs exactly the same either way — one row.
CREATE TABLE IF NOT EXISTS ratings (
  anime    INTEGER PRIMARY KEY,
  s1       INTEGER NOT NULL DEFAULT 0,
  s2       INTEGER NOT NULL DEFAULT 0,
  s3       INTEGER NOT NULL DEFAULT 0,
  s4       INTEGER NOT NULL DEFAULT 0,
  s5       INTEGER NOT NULL DEFAULT 0,
  s6       INTEGER NOT NULL DEFAULT 0,
  s7       INTEGER NOT NULL DEFAULT 0,
  s8       INTEGER NOT NULL DEFAULT 0,
  s9       INTEGER NOT NULL DEFAULT 0,
  s10      INTEGER NOT NULL DEFAULT 0,
  up       INTEGER NOT NULL DEFAULT 0,   -- thumbs up
  down     INTEGER NOT NULL DEFAULT 0,   -- thumbs down
  updated  INTEGER NOT NULL DEFAULT 0
);
