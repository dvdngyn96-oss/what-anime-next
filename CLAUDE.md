# whatanimeshouldiwatchnext

Type an anime you've already watched; get the next one **up the MyAnimeList
rankings** that shares its genres. A blank Google-style page, a search box, and
a card.

Static site. No build step, no server, no runtime API calls for the core loop.

---

## Current state

**Build 44.** `anime.json` holds **3,493 entries** (TV 2,679 · ONA 532 · OVA 282),
about 1.08 MB. 290 checks pass via `npm test`.

| Data | Coverage |
| --- | --- |
| Key-art colour | 3,266 |
| Banner image | 2,357 |
| Studio | 3,376 |
| AniList tags | 3,245 (93%) |
| Genres backfilled from AniList (`gs`) | 42 |
| No genres (matched on themes only) | 31 |

**Live at https://whatanimeshouldiwatchnext.com** on Cloudflare Pages, deploying
from `main` on GitHub (`dvdngyn96-oss/what-anime-next`). Every push redeploys
automatically, in about 40 seconds.

`what-anime-next.pages.dev` still serves the same site and is still where
Pages deploys land; the apex is the canonical address and is what every
absolute URL in the repo points at.

**Use the bare hostname.** Each deploy also gets a pinned URL like
`1da78362.what-anime-next.pages.dev`, which serves that build *forever* —
Cloudflare hands you one in the "Deployment URL" line after a build, and it
looks like the site's address. Chasing a stale build number on one of those
wasted a session's worth of confusion once already.

---

## Commands

```bash
npm run serve     # python -m http.server 8777
npm test          # 290 checks, jsdom against the real app.js and anime.json
npm run walks     # prints recommendation chains for 19 known anchors
npm run build     # full catalogue rebuild, ~60 min
```

One credential file, gitignored, **build-time only** — nothing ships in the
browser:

- `.mal-client-id` — MyAnimeList API, registered **non-commercial**

`.tmdb-key` is no longer read by anything as of build 40 and can be deleted.
AniList needs no key, for the build-time tag harvest or the runtime lookups.

**And that is the whole monetising constraint gone.** MyAnimeList's
non-commercial terms define it as "personal, educational, open source or
communal" and explicitly allow *"donations without any quotas"*, plus some
advertising. TMDB was the strict one — it counted "indirect monetization
through traffic generation" as commercial and said outright that donations
*"may be considered commercial"* — and it is no longer a dependency.

### After changing app.js or styles.css

Bump `BUILD` in `app.js` **and** the `?v=` markers in `index.html` together.
The build number renders in the footer. A stale cached script caused more
confusion in this project than any real bug — if a result looks wrong, check
the footer before investigating.

---

## How the recommendation works

The whole catalogue is on the client, so the walk is literal rather than
approximate: find your anime's row, step one position at a time toward rank #1,
return entries sharing its genres.

**Three things compete, and they rank in this order:**

1. **Match quality** — a full genre match below beats a weak one above. This is
   why Steins;Gate (#5) reaches Evangelion rather than Fullmetal Alchemist on
   the strength of "Drama" alone.
2. **Direction** — within a quality tier, exhaust everything higher before
   turning around. The Saint's Magic Power has 35 matches above it; pooling the
   leftovers globally once buried 9 of them behind 120 downward results.
3. **Monotonicity** — climb steadily; defer anything out of order.

This ordering was broken twice by changes that satisfied two of the three. The
implementation keeps each pass's clean run and its deferred entries together,
which is what makes all three hold at once. `walkRankings` in `app.js`.

### Genres decide, demographic and themes break ties

MAL merges genres, themes and demographics into one field; the builder splits
them. Matching happens on **genres**. Ordering then uses:

```
affinity = round(tagSimilarity × 6) + (same demographic ? 2 : 0)
```

where `tagSimilarity` is cosine similarity over AniList's weighted tags, and
entries without tags (8%) fall back to the old `shared themes` count.

### A rare theme is worth a genre

Genres are too broad to identify anything. Comedy is 1,276 shows, Fantasy 968 —
"shares Fantasy" says almost nothing. The identifying word is usually filed as
a *theme*, and themes only broke ties: Isekai is 161 shows and says a great
deal, but it could never decide a match.

**The damage was not that themes ranked too low. It was monotonicity.** Konosuba
is the case. Its genres are Adventure, Comedy and Fantasy, and walking up,
exactly *one* thing shares all three — Dungeon Meshi, 163 places away. Match
quality goes first, so the walk serves it; Dungeon Meshi sits near the top, so
the high-water mark jumps to position 34. The 2-of-3 tier then runs, holding 32
entries including three isekai — and the nearest, 24 places away, cannot beat
position 34, so every one of them is deferred out of sight. Seven results, not
one an isekai, exactly as reported.

This is why **reweighting the themes into `affinity` cannot fix it**, and that
is worth stating because it is the obvious fix. Affinity reorders a bucket.
Which candidates survive a pass is decided by the frontier, not by their order
within it — every ordering of that 2-of-3 tier still leaves all of it behind
position 34. A strong theme match has to enter the *top* tier to be reachable
at all.

So it does. A shared theme carried by **no more than 5% of the catalogue** is
worth one genre for bucketing. `promoteSignatures` in `app.js`, run after the
scan and before `preferLocally`.

**A share, not a count.** 5% of 3,493 entries is 174 shows: Isekai (161),
Military (148), Harem (144), Psychological (132), Space (114), Time Travel (50)
and rarer count; Martial Arts (207), Adult Cast (255), Mecha (270), Historical
(403) and School (658) stay tie-breakers. A fixed count of 200 looks identical
on this catalogue and is a trap — in a six-entry test fixture every theme is
under 200, so everything became a signature theme and five checks failed at
once. Rarity only means something relative to the corpus. Counted at load, so a
rebuild cannot leave it stale.

**Bounded by distance, and that bound is the whole safety argument.** The first
version was unbounded and re-created the Arslan Senki bug this file warns about
twice. Berserk has five genres, so exactly one entry shares them all — and
unbounded promotion let Arslan Senki (528 places away) and Grancrest Senki
(1,376) into that tier. The walk took them first, raced the frontier to the far
end of the rankings, and monotonicity deleted the dense tier of near
neighbours below. The same bug, produced by its own fix.

Two rules keep it honest, and `npm test` fails if either is removed:

- **A candidate may only join the tier above if it is no further from the
  source than that tier's nearest existing member.** Promotion can densify a
  sparse tier; it can never make one reach further.
- **An empty tier is never created.** With no natural member there is nothing
  to measure reach against, and a lone promoted entry ahead of a dense tier is
  the failure above. About one source in eleven is shaped this way.

The rule therefore fires only where the problem is — a top tier that is sparse
*and* distant, 7.2% of anchors — and is a no-op where it is already dense and
close. It only ever promotes, never demotes; it needs at least one genre
already shared, so it invents no new matches and leaves the genre-less tier in
`buckets[0]` alone; and it moves one tier, never two.

**The tier and the shared-genre count are no longer the same number.**
`matchGenres` carries the true count and is what the card's note reports, or it
would tell someone a show shares three genres when it shares two and an Isekai
tag.

Measured over the 17 known anchors: backtracks fell from 26 to 18. Konosuba
opens on two isekai. Cowboy Bebop's six backtracks became a clean run of Space
shows — Planetes, Kanata no Astra, Outlaw Star, Captain Herlock. Steins;Gate
keeps its whole documented chain and gains four nearer matches ahead of it,
one of them Link Click, 15 places away, sharing Time Travel.

**A better match earns a longer jump, measured in ranking positions.** Each
point of affinity buys extra distance over the nearest candidate;
`MAX_LOOKAHEAD` (30) bounds the scan for cost.

**How much distance depends on where the anchor sits, and that is build 34.**
It was a flat 30 positions, which is a small step at #5 and nothing at all at
#1508 — so GATE: Jieitai, whose isekai and military matches sit about 195
places away, recommended Slayers instead. The budget now runs from
`AFFINITY_REACH` (30) up to `REACH_CAP` (60), at `REACH_FRACTION` (0.30) of the
anchor's own position.

**Measuring distance as a ratio instead is the obvious fix and it is wrong.**
Tried first, because #393 to #5 and #1508 to #968 are both "about 150
positions" while being wildly different in kind. It fixes GATE and breaks the
other end: Fullmetal Alchemist: Brotherhood began recommending Arslan Senki
(#1594), Grancrest Senki (#3559) and an entry at #7831. A flat measure
under-reaches deep in the catalogue and a ratio over-reaches there — both are
wrong, in opposite directions, which is why the answer is a position measure
with a moving budget rather than a different measure.

60 is the mildest cap that works. At 50 GATE still leads with Slayers; at 60 it
leads with Drifters, which shares Isekai *and* Military. Of the 19 known
anchors 12 came out byte-identical, including every fragile one — FMA:B,
Steins;Gate, Berserk, Cowboy Bebop, Re:Zero, Konosuba, Mushoku Tensei,
Chihayafuru, Haikyuu, Mushishi, Gakkougurashi, Tokyo Ravens. Backtracks went
from 18 to 22. The one real loss is Toradora, which drops Chihayafuru and
Kodomo no Omocha; Sasaki to Pii-chan and Ame to Kimi to both improved. Sorting a
whole bucket by affinity instead let a distant match leapfrog everything nearer
— walking down from FMA:B, Arslan Senki (1,592 places away) jumped ahead of
Berserk (105 away). That one bug produced three separate symptoms before it was
traced.

**Positions, not bucket slots — this is the whole safety argument.** A bucket
holds only genre-sharing candidates, so ten bucket slots can span 1,500 ranking
places. Build 20 first bounded the jump by bucket index and immediately
reproduced the Arslan Senki bug: Arslan led FMA:B's chain and Berserk fell to a
backtrack. Distance has to be measured in the units proximity actually means.

### AniList tags, and why the score is rounded

MAL gives three flat genres and a couple of themes. AniList gives ~8 usable
community-voted tags with relevance weights — FMA:B is *Alchemy 90%, Military
90%, War 90%, Politics 80%* where MAL offers only "Military". Stored as `tg`,
one integer per tag (`tagIndex × 10 + weight`, weight 5-9), with names in their
own `tagNames` table so a tag refresh can never shift a genre's index.

Similarity is **cosine**, not raw overlap: popular shows carry three or four
times as many tags as obscure ones, so an unnormalised sum ranks by fame.

**The rounding is load-bearing, not cosmetic.** Under the old theme count most
candidates scored 0, so `preferLocally` was nearly a no-op and proximity
survived by stable sort. A continuous score gives everyone a distinct value, so
every window reorders — and monotonicity turns each reorder into a *deferral*,
because putting a distant match first stops the nearer ones advancing. Shipped
unrounded, Steins;Gate lost Evangelion, Shinsekai yori and Serial Experiments
Lain from its chain in one stroke. Rounding restores ties, and ties preserve
proximity.

Scaled by 6 because similarity runs about 0.1-0.6, landing on 1-4 — the range
the theme count occupied, which is what the window and the demographic bonus
were tuned against.

The gain is real: walking down from FMA:B now reaches Berserk (#109) and
Mo Dao Zu Shi (#195), both nearer and closer in kind than the old first result
at #385. Roughly half the known-anchor walk lines changed.

### Genres backfilled from AniList

**An entry with no genres can never be matched** — the walk skips it, so it is
invisible rather than merely unlikely. MAL's genre data thins out badly for
pre-1990 TV and merchandise-driven shows, and 74 entries had none at all.
Hyouge Mono (#704, 39 episodes, well regarded) was among them.

`backfill-genres.mjs` fills those from AniList, and the builder does the same
in its art pass. It **only ever fills where MAL supplied nothing** — it never
overrides MAL — and sets `gs: 1` to record the provenance. 42 filled.

Four AniList "genres" are MAL *themes* — Mahou Shoujo, Mecha, Music,
Psychological — so they go to `th`, not `g`. Putting them in `g` would invent
genre values the bucketing logic has never seen and let "Mecha" alone count as
a full genre match.

That mapping is why **31 entries still have no genres**: their only AniList
genre is one of those four. They are mostly idol franchises and 80s mecha.

### Genre-less entries match on themes, last

An entry with no genres can never share one, so those 31 were unreachable.
Rather than fabricate a genre for them, build 29 lets them match on a shared
**theme** instead — placed in `buckets[0]`, below every genre match in both
directions, so they surface only once real matches are exhausted.

Scoped to entries with *no* genres. Something that has genres and shares none
of yours is a miss, not a fallback; giving it a second route would change
matching for the whole catalogue rather than for 31 entries.

28 of the 31 have a theme and are now reachable. The remaining three — Psychic
Hero, Enter The Garden, Porte — have neither genre nor theme nor tag, and
nothing short of inventing data will reach them.

`matchNote` special-cases this tier: "widened to 0 of 3 genres (0%)" is true
and useless, so it says the entry has no genres on record and names the theme
that brought it in.

### The card is a constant height on purpose

Clicking "show me another" repeatedly is the main way this gets used, and it
only feels right if the buttons don't move. Seven things used to move them:

- **1,169 entries have no banner image**, so their cards were 150px shorter.
  The strip is now unconditional — filled with a gradient from the show's own
  key-art colour when there's no image. `hero-has-banner` is unconditional too,
  so the poster keeps its overlap and the geometry matches either way.
- **The synopsis arrives after render**, from AniList. `.synopsis` has a fixed
  five-line height, not a minimum, matching the 340-character cap applied
  upstream. Nothing reflows when the fetch lands.

- **The streaming row was absent** for the 374 entries with no TMDB match. It
  now always renders, saying "No listing found" — honest, and the same line
  either way. Since build 40 the listings arrive from AniList rather than the
  catalogue, so the row is a *reserved* 26px line rather than one that wraps
  freely — see "Where to watch" below.
- **The Trailer button was injected after the fetch**, shifting every button
  beside it sideways, and was missing entirely on the 11% with no trailer. The
  slot is always rendered, hidden via `.btn-reserved` until there is something
  to play. Hidden rather than removed when the video starts, too.

**The explanatory notes moved below the card.** `matchNote`, the outside-the-
catalogue warning and the axis-fallback warning are all conditional, and above
the card their appearing and disappearing moved the card and every button in
it — worst of the four, because a note shows up exactly when the result changed
in a way worth reading about. Under the card they explain what you were just
shown without ever moving it. A check asserts they never render above `.hero`.

Every conditional block in the card is now unconditional, and the conditional
ones outside it sit below. The "card keeps its shape" checks in
`test/suite.mjs` render a sparse entry and a rich one and assert both produce
the same skeleton — jsdom has no layout, so it guards the structure, which is
enough to catch a conditional render creeping back.

- **The title wrapped** on 14% of desktop cards and 31% of mobile ones. It now
  reserves two lines (three on mobile) and clamps beyond that — 1% of titles,
  the worst being 127 characters. The blank line under a short title reads as
  padding; a button that moves does not.

- **The genre row wrapped** on roughly 10% of desktop cards, and **the badge
  row** (hidden gem, currently airing) appears on about the same. Both now
  reserve their space: two chip rows on desktop, three on mobile, and one badge
  row always rendered even when empty.

The 10% figure understates how often you meet it. Cards cluster by kind, so a
chain of dark psychological shows all carry long genre lists — Texhnolyze has
eight chips against Kubikiri Cycle'''s four, and they turned up within five
clicks of each other. Frequency across the catalogue is the wrong measure;
frequency *along a walk* is what you feel.

**A failed synopsis fetch is never cached.** AniList rate-limits, and clicking
through quickly fires one request per card, so bursts produce failures. Caching
them stored "no synopsis" for the rest of the session, and because the block is
now a reserved five lines, that read as a broken card rather than as nothing.
Failures are left uncached so the next visit retries, the fetch waits 220ms so
a card you skim past costs no request at all, and an empty block says which
kind of empty it is — "Synopsis unavailable just now" against "No synopsis on
record".

The Trailer button sits **last** in the action row. Its slot is always rendered
to hold the row width, and reserved space at the front left a visible hole
before the first button; at the end it falls where the row already runs out.

Chips are clipped rather than capped at a count: a chip can be the shared theme
the note is explaining, and dropping it would remove the reason the result was
chosen.

### The format filter

Three chips — **TV / ONA / OVA** — in a third toggle row, each independently
on or off, defaulting to all on and remembered in `localStorage`.

It exists because ONA is the mixed bag: Cyberpunk: Edgerunners and Takopi's
Original Sin sit alongside a long tail of donghua that crowds the isekai range
around #4000-5000. A single "TV only" switch would have taken OVA with it, and
OVA holds Hellsing Ultimate and FLCL.

**It filters candidates, not anchors.** Whatever you searched for stays usable
as a starting point — refusing the show someone just typed would be baffling.
"Surprise me" does respect it, though, because being handed a donghua straight
after switching ONA off reads as the toggle being broken.

The last format on cannot be switched off; otherwise the card empties itself
with no way back but a reload.

### The year filter

Build 39. **One chip — "2010 or later"** — off by default and remembered in
`localStorage` under `wanx:modern`. 41% of the catalogue is older than 2010
(1,427 entries against 2,053), and bouncing off older art and pacing is a real
preference rather than a taste to be corrected.

The matcher side is the well-trodden part: it filters *candidates* exactly like
the format filter, so `npm run walks` comes out byte-identical apart from the
build-number line. **The risk was vertical space**, and that is where the work
went.

**It rides in the existing toggle row, and the DOM position is what makes that
true.** Three toggle rows on a 360px phone already pushed the card most of a
screen down once, and the fix for that was cutting reserved space from three
rows to two — a fourth row would have undone it. Measured in a real browser
rather than guessed:

| Where the chip sits | Toggle block at 360px |
| --- | --- |
| Appended at the end of `.controls` | 105px, three rows |
| Second, straight after the direction group | **68px, two rows** |

The direction toggle is 208px wide inside a 320px container, so 104px beside it
was going spare; the chip is 89px. The axis and format groups keep sharing the
line below. Checked with and without the chip at 360, 375, 414 and 1280px — the
block is **the same height either way at every one of them**. A check asserts
the chip is inside the second `.direction` group, because jsdom has no layout
and DOM order is the thing that actually produces the result.

That is also why the label is the full "2010 or later" rather than "2010+".
Once it fits, the clear wording is free.

**It filters candidates, not anchors** — the same rule as the format and
watched filters. "I watched this in 1998, what next" is exactly what the site
is for. "Surprise me" does respect it, because being handed a 1979 mecha right
after asking for 2010 or later reads as the toggle being broken.

**An entry with no year on record is kept.** 13 are in that state, and that is
a gap in MyAnimeList's data rather than an era anybody chose to exclude — the
same rule as an entry with no type surviving the format filter.

**On is the loud state here, which is the opposite of the format chips and is
deliberate.** Those default to on, so switching one *off* is the only choice
being expressed and the only thing that should draw the eye. This one defaults
to off, so switching it *on* is the choice — it takes the plain accent fill
that direction and axis use, and needs no new CSS at all.

**There is no "N shows were skipped" note, unlike the watched list.** The
counter exists and an emptied walk names the filter, but nothing appears under
an ordinary card. The watched list is invisible state built up over months, so
its effect has to be explained; the chip is on screen directly above the card
with its own state showing, and was just pressed. "684 shows released before
2010 were skipped" tells nobody anything — and 684 is the ordinary size of that
number, not an outlier. The format filter is visible in the same way and is
silent for the same reason.

**The chip alone cannot actually empty a walk**, which was worth checking
rather than assuming. Ten anchors come out empty with it on, and all ten have
no genres — and a genre-less *anchor* is already turned away earlier with its
own message, so none of them reach the walk. The realistic empty is the chip
plus a large watched list, and that branch names both: "877 already on your
watched list, 684 released before 2010."

Walking down from Cowboy Bebop with it on: Cyberpunk: Edgerunners, Pluto,
Psycho-Pass, Uchuu Senkan Yamato 2199, Kaijuu 8-gou — against Captain Herlock,
Space Cobra and Tenchi Muyou with it off.

### Both filters count what they actually removed

Build 39 fixed a bug the year chip made impossible to miss. `watchedSkipped`
and `yearSkipped` feed a sentence that says "shows that **matched**", so they
have to count matches — and they were being applied beside the format filter,
*before* the genre test. `collectTiers` walks the entire catalogue in each
direction, so the number reported was really the size of the filter itself.

Marking 40 sports shows watched made Cowboy Bebop — Action, Award Winning,
Sci-Fi — report "40 shows that matched are already on your watched list", when
it shares a genre with exactly three of them. The year chip said **1,426**,
which is the whole pre-2010 catalogue.

Both counted filters now sit *after* the match test. The format filter is
deliberately left where it was: it is uncounted and unreported, so its position
cannot mislead anyone, and leaving it early keeps the scan cheap.

**The first version of the check passed with the bug reinstated**, which is the
`empty-tier` lesson again. The test seeded the watched list *after* `makeDom`,
and `app.js` reads it into module scope on load — so the page ran on the
defaults and the check proved nothing. `makeDom` now takes `seedWatched` and
`seedModern` and sets them before the script boots. Both new guards were then
broken on purpose and watched to fail.

### Kids is demoted

`Kids` is the one demographic marking a different *audience* rather than a
different tone. Without demoting it, a 12-episode dark isekai recommends
Pokémon — 276 episodes, same three genres, 48 places away. Affected 54 anchors.

### And a 220-episode series is demoted against a 12-episode one

The Kids rule was half a fix and build 35 is the other half. **Length was never
looked at.** GATE: Jieitai is 12 episodes and its fifth result was Naruto at
220 — which shares all three of its genres and sits 283 places up, four behind
Juuni Kokuki, so it arrived in perfectly correct order. Nothing was
misbehaving; the code had no idea it was asking for a 220-episode commitment.
Pokémon is caught against a short isekai for being *Kids*. Naruto is Shounen,
so nothing caught it — and GATE has no demographic recorded at all, so that
tie-breaker could not fire either.

A candidate `LENGTH_MISMATCH` (6) times longer than the source drops one tier,
exactly like Kids, so it surfaces once closer-sized matches are exhausted.

**A ratio, never an episode count, and the threshold came from measurement.**
Every length ratio actually served across the 19 anchors was collected — 150
pairs. The legitimate ones stop at 5.8x and the questionable ones start at 7x:

| Ratio | Pair | |
| --- | --- | --- |
| 18.3x | GATE (12) → Naruto (220) | demote |
| 14.8x | Konosuba (10) → Hunter x Hunter (148) | demote |
| 11.8x | Overlord (13) → Dragon Ball (153) | demote |
| 8.7x | Ame to Kimi to (12) → Chi's Sweet Home (104) | demote |
| 7.0x | Tokyo Ravens (24) → InuYasha (167) | demote |
| 5.8x | Mushoku Tensei (11) → FMA:B (64) | keep |
| 4.0x | Haikyuu!! (25) → Slam Dunk (101) | keep |
| 3.1x | Steins;Gate (24) → Monster (74) | keep |

A clean gap, which is more than could be said for anything separating the
cases that defeated the affinity work — there the wanted jump was *larger*
than the forbidden one. Haikyuu!! legitimately reaches Slam Dunk, Hajime no
Ippo, Touch and Diamond no Ace, and a blunt episode count would have wrecked
that chain; its whole run tops out at 4.0x and comes out byte-identical.

**A missing episode count is estimated, not ignored, and skipping that step
broke the rule on its first run.** All 38 entries without a count are currently
airing — which covers One Piece and Meitantei Conan, the two longest things
here, *and* a series three episodes into its first season. Treated as unknown,
the rule demoted Dragon Ball at 153 episodes and One Piece, at more than a
thousand, walked into the slot it had just vacated. `lengthOf` now estimates
from run length once a show has been airing `LONG_RUNNING_YEARS` (5): a weekly
series broadcasting since 1999 has over a thousand episodes whatever the
catalogue says. Below five years it stays unknown and earns no penalty, the
same rule as a missing demographic.

Episode count still overstates shorts — Chi's Sweet Home is 104 episodes of
about three minutes — and there is no duration field to correct with.

15 of the 19 anchors came out byte-identical. The four that moved each lost
exactly one over-long entry: GATE drops Naruto, Overlord drops Dragon Ball
*and* One Piece, Konosuba drops Hunter x Hunter and One Piece, Tokyo Ravens
drops InuYasha. Backtracks went 22 to 25.

### Two ranking axes

**MAL rank** (default) and **Kept watching** (raw completion). Completion
correlates only 0.35 with MAL rank, so it measures something genuinely
different — but it skews short, and it *penalises episodic shows*: Mushishi is
MAL #87 and sits below a slice-of-life source on that axis. That's why MAL rank
is the default rather than the two being presented as equals.

The length-adjusted **residual** (the ±N on the card) is good for judging one
show but a poor *ranking* axis — par sits so low at the long end that franchise
serials float to the top. Ranking uses the raw figure deliberately.

### The walk climbs `rankPos`, not `rank`

**MyAnimeList gives the same rank to different titles** — 64 collisions inside
the top 8,000, confirmed in a single snapshot. Uniqueness is not ours to
enforce, and no rebuild will produce a tie-free catalogue.

So `positionOf()` returns `rankPos`, a 1-based ordinal over the rank-sorted
catalogue, mirroring `completionPos`. `rank` stays MAL's number and is what the
card shows. `renumberRanked()` rebuilds the ordinal, and `insertByScore()` must
call it after splicing a live AniList find in, or every position below the
insert is stale.

Build 16 made this change; every walk in `npm run walks` came out
byte-identical, so it is behaviour-preserving on the known anchors.

A tie looks like a sort bug when the test fails. It isn't — check for *equal*
ranks, not inverted ones. A strictly-decreasing check finds nothing.

---

## Catalogue rules

Only things you can start watching cold:

- **TV, OVA and ONA.** No films, specials or recaps.
- **No prequel, no parent story.** Anything with either is dropped.

**Recaps need their own title rule.** Excluding MAL's `special` media_type is
not enough — plenty of recaps are typed OVA or ONA and sail through. Chainsaw
Man Recap sat at #1207 through four builds. `looksLikeRecap` in
`build-catalogue.mjs` catches *recap, digest, compilation, soushuuhen* and
*special edition/anime/animation* anywhere in either title.

"Special" alone is unusable as a word match: **Special A** is a real 24-episode
TV series and **A Returner's Magic Should Be Special** a real 12-episode one.
It only signals a recap as a *trailing* word, and only on OVA/ONA. The single
TV compilation, Gundam IBO Tokubetsu-hen, is caught by "Special Edition" in its
English title instead. Build 19 pruned 23 entries this way.

`STANDS_ALONE_ANYWAY` in `build-catalogue.mjs` is a hand-curated allowlist,
**deliberately not a heuristic**. MAL's relation data cannot separate Hellsing
Ultimate (a retelling) from Hunter x Hunter: Greed Island (a continuation) —
both list a prequel and an alternative version. Three rules were tried and all
three failed.

**Thirteen were added at once in build 32, and they all share one shape.** A
popular series gets a prequel special or film *years later*, MAL records it as
a prequel, and the strict rule concludes you cannot start there. Re:Zero — MAL
rank 393 — was dropped over *Hyouketsu no Kizuna*, a 2019 special, three years
after it aired. Jujutsu Kaisen (#169) was dropped over *JJK 0*, a film made
after the series. Your Lie in April (#91) over its own recap.

They were found by scanning MAL's top 500 TV for entries missing from the
catalogue whose *only* prequel is titled as their own side story — that is, the
prequel's title starts with the show's. That scan is a **candidate generator,
not a rule**: it also flagged Mushoku Tensei II, which really does need season
one, so every entry still gets looked at by a human. Re-run it after a rebuild
if the catalogue feels like it is missing something obvious.

**The sweep went to rank 2,000 next, and found 29 more** — Macross, Digimon
Adventure, Saint Seiya, Slayers, Gundam: Suisei no Majo, Another, Guilty Crown
among them. Suisei no Majo is the *Pluto* case rather than the Re:Zero one: its
disqualifier is `parent_story: Kidou Senshi Gundam`, because MAL files every
Gundam under the 1979 original.

**Six were flagged and rejected, and four of those are the lesson.** Hayate no
Gotoku!!, Genshiken Nidaime, Gatchaman Crowds Insight and High School DxD Hero
are all sequels — and MAL does *not* list their earlier seasons as prequels, so
nothing in the relation data gives them away. Only knowing that `!!`,
*Nidaime*, *Insight* and *Hero* mean seasons two, two, two and four catches
them. That is the argument for this list staying hand-checked, restated with
better evidence than the Hellsing example.

**Adding entries this far down leaves `npm run walks` byte-identical**, because
all fourteen known anchors are top-ranked and never reach rank 955+. The walks
diff proves nothing here, so reachability was checked directly instead: for each
new entry, walk up from anchors just below it and confirm it appears. 29 of 29
did. Do that rather than trusting an unchanged diff.

**`full_story` is a third disqualifying relation, and it means the opposite of
what it sounds like.** It points *away* from an entry at the complete work, so
carrying it is MyAnimeList saying outright that this entry is a condensed
version of something else. 22 entries had it — Ghost in the Shell: SAC – The
Laughing Man, Sailor Moon Memorial, the Haikyuu!! Tokushuu recap — and not one
of them had a prequel or a parent story, so nothing else could see them.

**Do not also use `summary`, which points the other way.** It names the
condensation *of* this entry, so carrying it marks the full work. Ie Naki Ko
Remy, Lodoss-tou Senki: Eiyuu Kishi Den, SAO Alternative: Gun Gale Online and
The iDOLM@STER Cinderella Girls all carry it and are all real series. Treating
the two relations as equivalent would have deleted them; a check now asserts
they are still here.

**`RE_CUTS_AND_EXTRAS` is a hand-curated denylist** — the mirror of
`STANDS_ALONE_ANYWAY`, and hand-curated for the same reason. One Piece: Gyojin
Tou-hen is "One Piece Log: Fish-Man Island Saga", a 2024 re-broadcast
condensing the Fish-Man Island arc into 21 episodes, and MAL files it as
`alternative_version` — the same relation Trigun Stampede and the 2023 Rurouni
Kenshin carry, and those two are real standalone remakes that belong. Nothing
in the relation data separates them. Five entries: the One Piece re-broadcast,
Your Lie in April: Moments, a Steins;Gate IBM Watson promo, the Nichijou pilot
and a Gintama mobile-game collaboration.

**A title pattern is not the answer, and that was checked rather than assumed.**
`-hen` merely means "arc" and appears in Rurouni Kenshin: Tsuioku-hen, #72 and
one of the best-regarded OVAs here; "Saga" appears in Youjo Senki, Zombieland
Saga and Excel Saga. Both patterns would have taken real series with them —
the Special A mistake again.

**The sweep was then run over the whole catalogue**, not just the 125 entries
whose titles extend another entry's — that shape was a guess about where
re-cuts live, and guessing where to look is how the first 27 were found rather
than all of them. `full-scan.mjs` checks every entry for the relation and
checkpoints to `full-scan.jsonl` so an interrupted run resumes; both are
gitignored. All 3,505 entries, zero errors, **12 more found**: Initial D Battle
Stage, Yozakura Quartet: Hoshi no Umi, Gundam Wing: Operation Meteor, Love Hina
Final Selection, 30-pun de Wakaru! Love Live!, Tenjou Tenge: The Past Chapter,
Karneval OVA, Fate/stay night TV Reproduction, Mahou no Yousei Persia, Flag
Director's Edition, Honoo no Alpenrose and Pretty Rhythm: All Star Selection.

**343 entries carry `summary` and every one of them stays.** That is the
reassuring half of the sweep: the relation that points the other way is nearly
thirty times more common than the one that disqualifies, so reading the two as
equivalent would have gutted the catalogue.

**This was found by clicking through the live site**, not by the suite: an
Overlord chain reached the One Piece re-broadcast at its sixteenth result.
39 entries removed in total. `npm run walks` came out **byte-identical**, which
proves nothing — none of the seventeen anchors reached any of them — so it was
verified directly instead, by walking from Overlord and confirming the entry is
gone. Same reasoning as adding entries below rank 955.

The twelve from the full sweep were checked the same way and it mattered:
**11 of the 12 were reachable** before removal, walking up from sources placed
just below each one. A byte-identical walks diff would have said nothing about
any of them.

Each build prints well-regarded OVAs/ONAs it dropped, formatted as ready-to-paste
IDs. That list is a judgement call for the human, not something to automate.

To add one without a 60-minute rebuild: add the ID, then
`node add-one.mjs <mal-id>`.

---

## Shipped behaviour

### Link previews, crawlers and the preview image

`index.html` carries Open Graph and Twitter card tags, and they are
**deliberately static**. Every `/?id=N` URL serves the same document — the card
is built by `app.js` after the catalogue loads — so a scraper never sees a
per-anime title however specific the shared link was. Describing the site is
honest; templating a title nothing fills in is not.

Two mistakes here fail *silently*, which is why `npm test` asserts against them
rather than trusting a reading of the file:

- **A relative `og:image` yields no preview at all.** It resolves against the
  scraper's own host, so it 404s somewhere you never see. Absolute URL, always.
- **`og:image:width` / `:height` drifting from the actual file.** The checks
  read the real dimensions out of the PNG's IHDR chunk (bytes 16 and 20) and
  compare, so regenerating the image at another size fails the suite instead of
  shipping a mis-declared one.

`og.png` is 1200×630 — the 1.91:1 both scrapers want — and is generated by
**`make-og-image.html`**, which draws it on a canvas. There is no `sharp`, no
`canvas` package and no headless browser here, and X/Twitter will not render an
SVG `og:image`, so it had to become a real PNG somehow. Drawing it in a browser
adds no dependency and keeps the image *reproducible*: that file is the source,
so a palette change regenerates it rather than orphaning a mystery binary. Its
colours are copied from `styles.css` by hand — if the palette moves there, move
it there too.

**The background is a horizontal wash for compression reasons, not visual ones.**
The first version used a radial corner glow and came to 368 KB, which is absurd
for flat artwork. PNG predicts each pixel from its neighbours: a ramp along x
makes every row identical to the one above, and the Up filter flattens it to
zeros. A radial gradient is predicted by nothing, so all 756,000 pixels cost
bytes. Measured on this artwork:

| Background | Size |
| --- | --- |
| Radial glow | 364 KB |
| Diagonal ramp | 149 KB |
| Horizontal ramp | 89 KB |
| Flat white | 85 KB |

The tint costs 4 KB. The radial one cost 279.

**And it is painted a column at a time rather than with
`createLinearGradient`.** Canvas gradients are *dithered* — the browser scatters
per-pixel noise to hide banding — and that noise is exactly what defeats the row
predictor. Swapping the radial for a native linear gradient made the file
*bigger*, 364 KB to 407. Only exact integer columns give a ramp the filter can
flatten. Final size is 87 KB.

Don't reach for a radial glow, a soft shadow, or a blur here without measuring
first; all three are the same mistake.

**`robots.txt` does not block `app.js`, `styles.css` or `anime.json`.** Blocking
them would leave a crawler rendering an empty shell and judging the site on it,
which is worse than not being crawled. It does block the build scripts, the
test directory and `make-og-image.html` — Cloudflare serves the whole repo root,
so those are all publicly fetchable. They hold no secrets, but they are source,
not content.

**`sitemap.xml` lists one URL.** There are 3,493 results, but all of them serve
byte-identical HTML, so listing them would hand a crawler thousands of URLs with
the same markup — which is what duplicate content means. The root is the only
distinct document the site has.

### Where to watch

Build 40, and it replaced TMDB outright. The row itself is unchanged in shape
— that was the constraint, since `.watch` is part of the constant-height
design and a check asserts it renders either way. What fills it changed.

**TMDB failed more often than it worked.** It matched 3,149 titles but carried
US or Canadian listings for only 1,641, so **53% of cards said "No listing
found"**. It also cost a separate twenty-minute refresh pass whenever listings
went stale, a second credential, and 76 KB in every visitor's download.

**AniList carries the same thing on a request the card already makes.**
`externalLinks` has a `type: STREAMING` entry per service with a real URL, and
`fetchDetails` was already fetching the synopsis and trailer per card — so the
listings cost **no extra request at all**. Measured on an even 600-title
sample across the whole ranking range, not on famous titles:

| Source | Coverage |
| --- | --- |
| AniList `externalLinks` | **69.0%** |
| TMDB `wp` | 50.1% |

AniList picks up 124 titles TMDB missed and loses 12. "No listing found" falls
from about half of cards to 29%. The commonest services are Crunchyroll,
YouTube, Hulu, Netflix, Bilibili TV and Prime Video.

**It was verified before anything was designed around it.** The previous
session recorded this field as *unconfirmed*, because AniList was answering
`403 The AniList API has been temporarily disabled` at the time. The API is
back; the query was run against Frieren and returned six streaming links
before a line of code was written.

**A chip is now a link.** TMDB gave a provider *name*; AniList gives the URL
of the title on that service, so each chip goes straight there rather than
bouncing through a "check current" link to TMDB.

**The row had to become a reserved height, and that is the one real risk in
this change.** It used to be filled synchronously from the catalogue, so
`flex-wrap: wrap` was harmless. Now it fills a moment after the card renders,
and a row that grows when the request lands shoves every button below it —
exactly the jitter the card exists to avoid. It is `height: 26px`,
`flex-wrap: nowrap`, capped at `MAX_SERVICES` (4) and clipped past that. A
check reads the rule out of `styles.css`, because jsdom has no layout.

**Services are shown in AniList's own order**, not re-sorted to a favourites
list. Re-ranking them would be editorialising on no evidence, and the cap is
what actually decides which four appear.

**A failed lookup leaves `streams` undefined rather than empty**, so the next
visit asks again — the same rule as a failed synopsis fetch, a failed
catalogue fetch and a failed ratings fetch. "No listing found" is reserved for
the case where AniList answered and had none. Both states are checked.

**The region toggle went with it.** It existed only to choose between TMDB's
US and Canadian listings; AniList's links are not per-country, so there is
nothing left for it to pick. `wanx:region` is no longer written, and the
privacy page no longer lists a region among the things kept in your browser.

Gone with it: `tm` and `wp` on every entry, the `providers` table,
`watchUpdated`, `add-watch-providers.mjs`, the TMDB half of `add-one.mjs`, and
the `.tmdb-key` requirement. The catalogue dropped 76 KB, from 1.15 MB to
1.08 MB, and `npm run walks` came out byte-identical.

### The wordmark borrows the joke, not the brand

Build 43. The multicolour wordmark over a search box is a deliberate nod to a
certain search page, and it should stay that way — it says what this site is
before you read a word.

**But two of its six colours were that company's registered brand hexes
verbatim**: `#4285F4` and `#34A853`, in their exact order, over a centred
search box with two buttons under it. Each of those on its own is nothing; the
combination is the part that stops being a pastiche and starts being a copy.

**Copyright was never the risk and it is worth being clear why.** Colours are
not copyrightable and neither is a sequence of them — there is no original
expression in "blue, red, yellow, blue, green, red". The real question is
trademark, which is about whether anyone might infer an affiliation, and the
honest answer is that the practical risk was very low. It was changed because
the fix costs nothing, not because a letter was expected.

The blue moved to `#2f7fd6` and the green to `#1f9d55`. They read the same at
a glance, and both actually gained contrast on the light theme. **The yellow
and the red were already their own values** — `#f5b301` against `#FBBC05`, and
the site accent against `#EA4335` — so they stayed, and the red stays tied to
`--accent` so it tracks the rest of the site. A check asserts the two brand
hexes never come back, and a second one asserts all six letters still have a
colour, so the first cannot be satisfied by the palette quietly vanishing.

**The first version of that check passed for the wrong reason**, which is the
`empty-tier` lesson wearing new clothes. It built its pattern with
`new RegExp(\`color:\s*${h}\`)` inside a heredoc, the heredoc halved the
backslashes, and `\s` in a template literal is just `s` — so the pattern was
`color:s*#4285f4`, matched nothing, and reported a clean palette while the
brand hexes were still in the file. Both checks now do plain string work with
no escapes at all, and the guard was broken on purpose and watched to name the
offending hex. Comments are stripped first, because the stylesheet mentions
both old values in the note explaining why they moved.

**The yellow moved in build 44, and it is the one colour that cannot be the
same in both themes.** At `#f5b301` it scored **1.85:1** on white, failing even
the 3:1 large-text bar — but that same value is 9.59:1 on the dark theme and
looks right there, and darkening it far enough to pass on white would dull the
theme most people actually see.

So it became `--wordmark-yellow`: **`#c98000` on light (3.20:1)** and the
original `#f5b301` on dark (9.59:1), using the variable-override block the
stylesheet already had. Nothing else changed — the dark theme is byte for byte
what it was.

All six colours now sit between **3.20 and 4.10** on white, which is a tight
enough band that the wordmark reads as one palette rather than one letter
shouting. Three checks compute the ratios from the stylesheet rather than
trusting an eyeball, so a future palette tweak cannot quietly drop below the
bar; the light-theme one was broken on purpose and reported `1.85:1`.

### Saying nothing when there is nothing to say

Build 42, three small ones found by looking at the live pages rather than the
tests.

**The housekeeping links lost their underline**, keeping it on hover. They sit
directly beneath the two buttons the page exists for, and underlined in the
accent colour they were the third-loudest thing on the screen. The colour is
enough to say "clickable".

**"Remove my ratings" hid itself only after this.** Clear already had the rule
— hidden until the watched list has something in it — and the button that
reaches the server to withdraw something you contributed did not. A first-time
visitor was being offered the deletion of data they had never given, in the
accent colour, directly under the two buttons they were meant to press.

**"? episodes" read as broken data.** A missing count means the show is still
airing, which the cell immediately beside it already says. Every other unknown
on that row renders as an em-dash, so this one does now too. The estimate
`lengthOf` makes for the demotion rule is deliberately *not* shown — it is a
guess for ordering, not a fact about the show.

**The studio tooltip said "Animation studio".** The name is clipped at 15ch to
keep the stat row from wrapping, so the tooltip was the only place the full
name could survive — and it was spending itself repeating the label underneath.
It now carries the name.

### The watched list

Shows you have already seen, so they stop being recommended. This is **stage
one of the voting system**, and the only stage that needs no server at all.

It lives in your browser's local storage under `wanx:watched:v1` and nowhere
else. No account, no sign-up, no upload. A MyAnimeList export is read on your
own machine; the file never leaves it.

The honest cost of that: the list does not follow you to another device, and
clearing your browsing data clears it. Both are the price of not holding
anyone's data, and worth paying — accounts would mean storing other people's
email addresses and passwords, which is a legal and security responsibility
this project has no reason to take on.

**It filters candidates, not anchors** — the same rule as the format filter.
Searching something you have watched is *the normal way to use this site*: "I
watched this, what next". Refusing the show someone just typed would break the
one thing it is for.

**"Seen it too — drop it" is now permanent.** It used to last only for the
current chain, so a fresh search brought the show back. The button says you
have seen it, so it is taken at its word. "Show me another" is still there for
"not this one" — the two intents were always separate controls, and only one of
them was ever about having watched something.

**Plan-to-watch is deliberately excluded on import.** It is usually the largest
section of a MyAnimeList export, and you have not seen any of it — treating it
as watched would hide exactly the shows someone most wants recommended.
Completed, Watching, On-Hold and Dropped all count as seen.

MyAnimeList hands you a **`.xml.gz`**, so the importer sniffs the first two
bytes for the gzip marker (`1f 8b`) rather than trusting the file name, and
unzips it in the browser with `DecompressionStream`. A plain `.xml` works too.

**An emptied walk has to say which filter emptied it.** If the watched list
removed every candidate, the old message — "nothing shares these genres" — is
false, and reads as the matcher being broken. `watchedSkipped` counts what the
list removed so the message can name the real reason and point at Clear.

**And a walk that merely lost a few has to say so too.** That is the common
case, and the page was silent about it until build 36: the count existed and
was read in exactly one place, the branch that runs when the list emptied the
walk completely. Logged in, GATE: Jieitai returns Slayers — because Moonlit
Fantasy, Drifters, Berserk: Ougon Jidai-hen and Juuni Kokuki are all already
watched. That is correct, and with nothing on the card to explain it, it reads
as the matcher being broken. Found by the owner clicking through the live site,
and it cost a round of debugging the page could have answered in one line.

**Not "closer matches", which is what the working note first proposed.** Of
GATE's four skips only Moonlit Fantasy is nearer than the Slayers it served;
the other three are better matches that lost on distance. The honest claim is
that they matched and you have seen them, not that they were nearer — and the
wrong sentence would have shipped straight out of the note if the distances had
not been checked first.

It sits below the card with the other explanatory notes, and a check asserts
that placement rather than trusting it: a note appearing above moves the card
and every button in it, and this one appears exactly when the result changed in
a way worth reading about.

### When anime.json does not load

Everything on the page waits on one promise. Before build 31, a failed
catalogue fetch was **silent**: the landing page rendered perfectly — wordmark,
search box, both buttons — and then ignored everything you typed. "Surprise me"
sat on its spinner forever. Only a shared `/?id=N` link reported anything, and
only because `routeFromUrl` happened to have a try/catch.

Worse, `cataloguePromise` memoised the *rejection*, so a single dropped request
kept the session broken until a reload. That is the same mistake as caching a
failed synopsis fetch, one level up where it costs the whole page rather than
five lines of it. The memo now clears itself on failure, which is what makes
**Try again** possible at all.

Three failure shapes, and they read differently on purpose:

| What happened | What it says |
| --- | --- |
| Bad status | names the code — "the server returned 503" |
| Network gone | "Check your connection and try again" |
| Parse error | "came back damaged … a deploy may be in progress" |

The third is not hypothetical: a Pages deploy in flight serves `index.html` for
`anime.json`, which arrives as a JSON parse error rather than a bad status.
"Failed to fetch" is jargon to someone who just wanted a recommendation, so
nothing raw reaches the page.

**Typing reports the failure in the dropdown, not by replacing the view.** You
are mid-word in the search box; throwing the page away under your cursor to
report a failed background fetch is worse than the failure. The dice and a
shared link, which have already committed to the result view, get the full error
with a Try again button.

`#catalogue-notice` on the landing page is the one thing allowed to move layout
— it can push the credit line down. There is no card on that screen to keep
still, and at that point the page has nothing else to show.

`npm test` covers all of it, including that no path leaks an unhandled
rejection, which is the exact shape the original bug took. Run against build 30,
8 of the 11 checks fail.

### The recommend row

Build 37, and it is the visible half of stage two: what other people said, and
the ask, in one row between the streaming line and the buttons.

**One row holding both, not two rows.** The figure arrives from `/api/ratings`
after the card is already on screen and has four possible states — nothing, a
count, a percentage, and nothing again if the request fails. Two separate
blocks could each appear and shove the buttons; one reserved block cannot
disagree with itself. Fixed `height: 30px`, not a minimum, the same trick as
`.synopsis`. It is in the card-shape check alongside the banner, the streaming
row, the trailer slot and the synopsis.

**Inside the card, unlike the explanatory notes.** Those sit below `.hero`
because they are conditional and appear exactly when the result changed. This
one is unconditional, so it can live where it is relevant.

**The figure is quiet until it has something to say.** At zero votes it says
nothing at all — "no ratings yet" on every card of an empty database is noise,
and the ask sitting beside it already implies it. Between 1 and the floor it
reports the count ("3 ratings so far"), never a percentage. At or above the
floor it says "82% would recommend · 147 ratings". The floor comes from the
server so it can move without a deploy of the page.

**Voting is optimistic.** The buttons and the figure update on click and the
request goes out behind them: a rating is not worth making anyone wait for, and
losing one to a dropped connection matters less than a card that feels stuck.
The answer is kept in `wanx:myvotes:v1` so the buttons still show it on the way
back, and so clicking the same answer twice costs no request at all.

**Ratings are fetched for the next twenty as well as the one on screen.**
"Show me another" walks the list, so one request makes every later card instant
at no extra cost — and the edge cache means most of those requests never reach
the database.

**A failed request is never cached**, the same rule as a failed synopsis fetch
and a failed catalogue fetch. The row keeps its height and stays quiet, and the
next card retries rather than inheriting the failure. Checks cover all of it,
including that the buttons still work when ratings are unavailable — which is
the state every title is in until somebody rates it.

### Sharing an imported list

Build 38, and it is the part that decides whether any of the rest matters. The
floor is 30 ratings before a percentage appears, across 3,493 titles — that is
more than a hundred thousand ratings, and nobody is clicking thumbs a hundred
thousand times. One MyAnimeList export routinely carries several hundred scored
titles. Everything else in stage two is machinery waiting for this.

`parseExport` already walked every `<anime>` node reading the id and the
status. `<my_score>` was in the same node, ignored.

**Zero means "not rated", not "terrible."** MyAnimeList writes 0 for every
unscored entry. Counting those as 0/10 would drag every figure on the site
toward the floor while looking like genuine opinions. Only 1-10 is kept.

**Only titles in the catalogue are kept.** A real list is mostly films, sequels
and specials this site does not carry. Sending them wastes requests and — worse
— overstates what someone is being asked to contribute.

**The question is asked after the file is parsed, never before.** By then the
export has been read entirely on the visitor's own machine and nothing has been
sent, so the offer can name the real number. "312 scored titles" is checkable
against your own file in a way that "help improve recommendations" is not.

**Unticked, and asked again every time.** A remembered yes is a decision
somebody made once and then stopped being aware of, which is the thing consent
is meant to prevent.

**Declining costs nothing, and the wording says so.** The watched list is
already saved either way. A refusal that breaks something is not a refusal.

**What is not sent is stated at the same size as what is.** Shrinking that half
is how a consent box quietly becomes dishonest, so a check asserts both halves
are present.

Uploads chunk at 100. That is the client half of the server's `MAX_BATCH`, and
both exist for the free tier's 10ms CPU budget rather than for tidiness. A
whole list takes a few seconds, so it reports progress — a button that sits
there looking broken is worse than a slow one that says what it is doing. A
failure stops rather than hammering the endpoint, and says how much got
through, because that is more use than a bare failure.

### Taking it back

`DELETE /api/vote` removes everything one voter id has said. It exists because
the consent screen promises it, and that promise is what makes the rest of the
screen credible.

It works in bites of 100 and reports what is left, and the page keeps calling
until nothing is — the same CPU budget that forces the upload to chunk, from
the other end. The loop is bounded, so a server that kept claiming work
remained could not spin forever.

**It is a separate button from Clear.** Clearing the watched list is local and
instant; removing ratings reaches the server and withdraws something you
contributed. Rolling them into one would mean people tidying their list
silently withdrew their ratings too.

**Its limit is stated rather than hidden.** The only handle on a person's
ratings is the random id in their browser, so clearing browsing data makes them
genuinely unreachable — by them, by me, by anyone. That is what being properly
anonymous costs, and the privacy note says so in those words rather than
implying a recall that does not exist.

### The privacy note

`privacy.html`, linked from the credit line and from the consent screen. Plain
prose, the site's own stylesheet, no separate design to drift out of step.

It exists because **build 38 is the first time anything leaves the visitor's
machine.** Until now the whole story was "nothing is uploaded, no cookies,
nothing to consent to", and that was true — the analytics are cookieless and
the import was read locally and never sent. A page that collects nothing needs
no privacy note; the moment that changes, it does.

It is deliberately specific about the third parties, which is the part most
sites omit: the browser fetches posters from MyAnimeList's CDN and synopses
from AniList on every card, so those companies see visitor IPs. Trailer embeds
use `youtube-nocookie`. Saying so costs nothing and leaving it out would make
the rest less believable.

Checks assert the page covers what is stored, what is sent, how to take it
back, the limit of taking it back, who else sees an IP, and where to ask — and
that it stays crawlable, unlike every other file in the repo root, because a
page describing what is collected is no use if it cannot be found.

### The tip jar

Build 41. **Built but not launched**, the same shape as the vote backend was:
the code is in, and with `TIP_JAR_URL` empty *nothing renders at all*, so the
live page is byte for byte the page it was.

**Launching it is one line.** Paste the URL into `TIP_JAR_URL` in `app.js`,
bump the build, push. There is no other switch and nothing else to remember.
A check asserts the unlaunched state renders nothing, and it was broken on
purpose and watched to fail — with a URL set the credit line reads:

> Rankings from MyAnimeList · genres from AniList · Privacy · Buy me a
> coffee · build 41

**It sits in the credit line, which exists only on the landing view.** That
makes "the card cannot move to accommodate it" structural rather than a matter
of styling — there is no card on that screen. The cost is that somebody
arriving on a shared `/?id=N` link never sees it, which is the right trade:
this project has moved a card under somebody's cursor once too often already.

**The build marker stays last.** The link is inserted ahead of it, because the
footer build number is the first thing to check when a result looks wrong and
it should stay where it is looked for.

**Nobody needed to be asked.** MyAnimeList's API agreement defines
non-commercial as "personal, educational, open source or communal" and permits
*"donations without any quotas"*. TMDB was the one that counted donations as
possibly commercial, and it stopped being a dependency in build 40 — which is
what unblocked this, and why the two jobs were queued in that order.

**The Ko-fi page exists and is live**: `ko-fi.com/whatanimeshouldiwatchnext`,
set to CAD, paying out through Stripe, with "Get all of Ko-fi" **off** — that
toggle trades 5% of every tip for supporter-only posts and custom colours,
none of which this uses, and 0% on tips was the whole reason for choosing
Ko-fi. Stripe Radar is on the free Lite tier and Stripe Tax is off.

**So nothing is left to build or set up. What remains is a decision**, taken
deliberately and not yet taken: the owner asked to hold the launch rather than
ship it the moment it worked. Launching is pasting that URL into
`TIP_JAR_URL`, bumping the build, and pushing.

**Nothing is given in return for a tip, and that is deliberate.** The site is
identical whether or not you pay; there are no supporter-only posts and no
perks. That keeps a tip a gift rather than a sale, which is the distinction
deciding whether GST is a question at all — and is a second reason "Get all of
Ko-fi" stays off.

## The vote backend

**Built but not wired up.** The endpoints, the schema and the tests exist;
nothing in `app.js` calls them yet and no database is bound, so the site
behaves exactly as it did. That is deliberate — it is the skeleton, and it can
sit there harmlessly until the card work is done.

**Two manual steps, and neither can be done from the repo.** Until they happen
`/api/ratings` answers `{"ratings":{},"unavailable":true}` and `/api/vote`
refuses with 503, which is the designed resting state rather than a fault:

1. Create the database — `npx wrangler d1 create wanx-votes`, or the D1 page in
   the Cloudflare dashboard.
2. Bind it to the Pages project as **`VOTES`**: Workers & Pages → the project →
   Settings → Bindings → D1 database binding. The name in the code is
   `env.VOTES`, so the binding must be spelled exactly that.

Then apply the schema once:
`npx wrangler d1 execute wanx-votes --remote --file=./schema.sql`

### Two tables, and the split is the whole cost story

`votes` holds one row per person per title and is touched only when somebody
votes. `ratings` holds one row per title and is what every card view reads.

**Computing a percentage by scanning `votes` at read time would cost one row
read per vote, per card view.** A title with 5,000 votes would cost 5,000 reads
every time it appeared; D1's free allowance is 5 million reads a day, so a few
hundred visitors would exhaust it. Reading one pre-aggregated row costs 1. That
single choice is the difference between free forever and a bill, and a check
asserts the read path never says `FROM votes`.

The response is cached at the edge for five minutes on top of that, so most
card views never reach the database at all. Ratings move slowly — a title needs
30 votes before it shows a number — so a stale figure is harmless.

### The raw signal is stored, never the verdict

A thumb gives yes/no; an import gives a score of 1-10. Both are kept as they
arrived. `RECOMMEND_AT` (7) is applied at *read* time, so "what counts as a
recommendation" can be retuned with a one-line change — where a stored verdict
could only be retuned by asking everyone again.

The aggregate is a **histogram** (`s1`..`s10`, `up`, `down`) rather than a
yes/total pair for the same reason: any threshold is computable from that one
row, so moving to 8 needs no migration. The read costs the same either way.

Thumbs and imported scores **pool** into one figure, because far more titles
clear the 30-vote floor that way and that is the entire point of importing.
They stay separate in the row, so splitting them later needs no new data.

### What the free tier actually constrains

100,000 requests a day, and **10ms of CPU per request**. A single indexed query
is nowhere near it; inserting several hundred rows from an import in one go
could be. Hence `MAX_BATCH` (100) and `MAX_IDS` (40) — those caps are about the
CPU budget, not tidiness, and the client has to chunk a large import.

### `_routes.json` keeps the rest of the site static

`{"include": ["/api/*"]}`. Without it Pages puts a Function in front of every
request on the site, including `index.html` and the 1.18 MB catalogue. With it,
everything except `/api/` is served exactly as it was.

### An unrouted method falls through to the SPA

Pages routes a method only if something handles it. Without a HEAD handler,
`HEAD /api/ratings` answered **200 with `index.html`** — a web page, from a
JSON endpoint. Harmless for the site, which only ever sends GET, but anything
monitoring the endpoint would be told it was healthy by a page that knows
nothing about it. Found by calling the deployed endpoint rather than by reading
the code, which is the same way most real bugs here get found.

`/api/vote` has one `onRequest` that dispatches, rather than an `onRequestPost`
plus a catch-all: exporting both leaves it ambiguous which Pages prefers, and
that is not worth depending on.

### It has to degrade to today's site

Same rule as a failed catalogue fetch, one level down: if the database is
missing or falls over, `/api/ratings` returns 200 with `unavailable: true` and
the page carries on without ratings. The site worked without them yesterday and
must keep working without them today. A check asserts that path exists.

### Tested against real SQLite, not mocked

D1 is SQLite and Node ships SQLite, so `npm test` applies `schema.sql` verbatim
to an in-memory database and runs the exact upserts the endpoint issues — no
new dependency, `node:sqlite` is built in. That covers the case worth covering:
**changing your vote has to move the count out of the old bucket as well as
into the new one.** Missing that decrement is the classic aggregate bug, where
the total drifts upward and never comes back, and it is invisible until the
numbers are already wrong. A check compares the aggregate against a scan of the
raw votes and fails if they disagree.

Compiled with `npx wrangler pages functions build` and exercised with
`wrangler pages dev` before shipping, which is the same toolchain Cloudflare
runs — worth doing, because a Functions build failure fails the whole
deployment, and that would take the site down rather than just the endpoints.

## Maintenance

| Task | Cadence | Time |
| --- | --- | --- |
| `npm run build` | once a season | ~60 min |
| `node add-anilist-tags.mjs` | rarely — tags drift slowly | ~3 min |
| `node backfill-genres.mjs` | after a rebuild only if it reports blanks | ~10 s |

**A rebuild is one step now.** It used to be two: the builder carried no
provider data, so `add-watch-providers.mjs` had to run straight afterwards or
the site shipped with zero listings, and the catalogue was not release-ready
in between. Build 40 moved streaming to a page-view lookup, so a rebuild is
finished when the builder is, and that whole class of half-built catalogue is
gone.

AniList tags and genre backfill happen inside the builder's art pass, so a
rebuild carries them already — `add-anilist-tags.mjs` and `backfill-genres.mjs`
exist for fixing an existing catalogue without paying the 60 minutes.

**Long builds must run detached**, or a Claude Code crash takes them with it:

```bash
powershell -c "Start-Process node -ArgumentList 'build-catalogue.mjs','--depth','8000' -WorkingDirectory $PWD -RedirectStandardOutput 'rebuild.log' -WindowStyle Hidden"
```

The builder only writes at the very end, so an interrupted run loses progress
but never corrupts the existing catalogue.

---

## Open

**All three queued jobs are done**, builds 39 to 41. They are struck through
below with what shipped, because the reasoning behind each is still the record
of why it was done that way.

**What is left is nobody knowing the site exists**, which no amount of further
code supplies — and, for the tip jar, one account that has to be made by a
human.

~~**1. A year filter.**~~ Shipped in build 39 — see "The year filter" above.
One chip reading "2010 or later", riding in the existing toggle row at no
vertical cost, measured at 360, 375, 414 and 1280px. If 2000+ versus 2015+ is
ever wanted, that is a second chip, not a redesign.

~~**2. Drop TMDB as the streaming source.**~~ Shipped in build 40 — see
"Where to watch" above. AniList's `externalLinks` was confirmed working first
(the 403 had cleared), and it covers 69% against TMDB's 50% while costing no
extra request, since the card was already fetching the synopsis. The region
toggle, `tm`/`wp`, the `providers` table, `add-watch-providers.mjs` and the
`.tmdb-key` requirement all went with it.

~~**3. The tip jar.**~~ Built in build 41 and **deliberately not launched** —
see "The tip jar" below. One constant turns it on.

**Nothing is queued.** The three jobs that were here are done.

---

~~**Genres may be the wrong thing to match on.**~~ Fixed in build 33 for the
case that motivated it — see "A rare theme is worth a genre" above. Konosuba
now opens on Kage no Jitsuryokusha and Mushoku Tensei. **Two things are left
open, and neither is a reason to reopen the whole question.**

~~**The dense-tier half.**~~ Fixed in build 34 by scaling the affinity reach
with the anchor's position — see "A better match earns a longer jump" above.
GATE now opens Tsuki ga Michibiku, Drifters, Berserk: Ougon Jidai-hen, Juuni
Kokuki: five of its top six share Isekai or Military, against one before.

**The two fixes that did not work are kept below**, because both are the
obvious thing to try and both cost a day. Promotion only fires when the top tier is sparse and distant,
because that is the only time the frontier deletes the tier below. GATE:
Jieitai is the other shape — 31 shows share all three of its genres within 100
places, so nothing is promoted and proximity decides. Its first result *is* an
isekai (Tsuki ga Michibiku, 27 places up), but its second is Slayers at 37
with no shared theme, while Drifters — which shares Isekai *and* Military —
sits 195 away and loses on distance.

**Feeding signature themes into `affinity` does not fix this. Measured, not
guessed.** The idea is sound on paper: `preferLocally` already lets a better
match come forward `AFFINITY_REACH` positions per point, so a bonus per shared
signature theme should pull Drifters past Slayers. Three values were tried
against the 19 known anchors:

| Bonus | GATE fixed | Backtracks (18 at baseline) |
| --- | --- | --- |
| +1 | no | 20 |
| +2 | yes | 28 |
| +3 | yes | 29 |

**The value that fixes GATE is the value that breaks everything else, and the
two cannot be separated because the distances are the same size.** At +2,
Re:Zero shares Time Travel and Psychological with Steins;Gate, earning 120
positions of reach — enough to pull Steins;Gate (#5) to the second slot, which
drags the high-water mark to the very top of the rankings and defers
Evangelion, Madoka, Houseki no Kuni, Tian Guan Cifu, Berserk and Guimi Zhi Zhu
into the backtrack tail. Re:Zero's clean run of eight became a run of three. At
+3 the Arslan Senki bug returns outright: walking down from Berserk, Arslan
(#1594) leads over Wolf's Rain (#1204).

GATE's desired jump is about 158 positions. Berserk's forbidden one is about
138. No threshold divides them, so **this mechanism cannot tell them apart** —
which is the finding, and the reason not to retry it with a cleverer constant.

**Exempting a jumped candidate from the frontier was the third idea, and it
was tried and reverted too.** The reasoning was sound: in both failures above
the damage is not the reorder, it is that a jumped-forward candidate *advances
the high-water mark* and monotonicity then deletes everything behind it. So let
a candidate that came forward on affinity be shown without moving the mark.

**Exempting every reorder removes the climb altogether.** `preferLocally`
shuffles neighbours constantly over tiny affinity differences, so almost
nothing advanced the mark and almost nothing was filtered. Backtracks fell from
18 to 4, which looks like success and is monotonicity switching off — the
sawtooth simply moved out of the labelled tail and into the middle of the
chain, where nothing explains it. Ame to Kimi to went 2049, 1968, **2039**,
1900, **2001**; Chihayafuru lost Nana, Shigatsu wa Kimi no Uso and Rurouni
Kenshin and gained **Planetes**, a space drama.

**Restricting it to leaps over 100 positions is far better behaved** — only
three anchors moved, and Berserk's Fullmetal Alchemist stopped being
mislabelled a backtrack. Paired with the +2 theme bonus it even fixes GATE
properly, pulling Drifters in while *keeping* Slayers, Dragon Quest and
Claymore rather than deleting them.

**But it still costs more than it earns.** Overlord loses Log Horizon, its best
result. Re:Zero still loses Evangelion, Madoka, Houseki no Kuni and Tian Guan
Cifu — because the entry *after* the jump advances the mark instead. Toradora
loses three, Ame to Kimi to wanders. **The exemption stops the jumping entry
from deleting what it leapt over; it cannot stop the next one doing the same
thing.** It moves the problem one position down the chain rather than removing
it, which is why there is no fourth version of this idea worth writing.

Build 34 fixed GATE a different way — by scaling the reach with the anchor's
position — without touching monotonicity at all. That is the one that shipped.

**Mushoku Tensei is unchanged, and that is the rule working.** Its genres are
Adventure, Drama, Ecchi and Fantasy — four, one of them rare — so nothing above
it shares all four and its top tier is *empty*. Promotion never creates an
empty tier, so the rule correctly declines to fire. Fixing this anchor means
promoting into nothing, which is the Arslan Senki failure. Leave it.

**And the deeper reason it never opens on isekai is that it has nowhere to
go.** Mushoku Tensei is #309, and **1 of the 161 isekai in the catalogue ranks
above it** — Guimi Zhi Zhu, and that is the whole list. 2 of the 66
Reincarnation entries do. Walking *up* from one of the best-regarded isekai on
the site, there is nothing left of its own kind to find; "Ranked lower" is the
useful direction for an anchor near the top of its genre. Worth remembering
before treating a thin chain here as a bug.

**It also loses its best thematic match by a single position, which is worth
recording as the shape of the proximity/affinity tension.** Mo Dao Zu Shi is 33
away and shares three genres *and* Reincarnation. Berserk is 62 away, shares
three genres and no theme, and carries one more point of affinity. Jumping
ahead needed 29 positions of reach and the budget at Mushoku's rank is exactly
30, so Berserk went first by one position — and then advanced the high-water
mark past Mo Dao Zu Shi, dropping it into the backtrack tail. Nothing here is
misbehaving; the margin is simply one position wide.

**Rarity is a good proxy for "identifying", not a perfect one.** Tokyo Ravens
is a magic-school show; its top result moved from Rakudai Kishi no Cavalry
(3 genres + School) to Maou 2099 (2 genres + Urban Fantasy), because School is
658 shows and Urban Fantasy is 77. Rakudai is arguably the better match and is
still second. One anchor out of seventeen went slightly the wrong way while
the rest improved, so the trade was taken — but if a better signal than raw
frequency is ever wanted, this is the evidence for it.

The old evidence, kept because it is what the fix was measured against:
Konosuba — genres Adventure, Comedy, Fantasy; theme Isekai — walked up to
Dungeon Meshi, Berserk, Made in Abyss, One Piece, Hunter x Hunter and
Fullmetal Alchemist: Brotherhood. Not one isekai.

The cause is that **genres are far too broad to identify anything**, while the
identifying word is filed as a theme and only breaks ties:

| Decides matching (genre) | Count | Only breaks ties (theme) | Count |
| --- | --- | --- | --- |
| Comedy | 1,276 | School | 652 |
| Action | 1,080 | Mecha | 265 |
| Fantasy | 968 | Isekai | 159 |
| Adventure | 871 | Harem | 142 |
| Drama | 740 | Psychological | 132 |
| Sci-Fi | 679 | Time Travel | 50 |

"Shares Fantasy" says almost nothing — it is a thousand shows. "Shares Isekai"
says a great deal. Re:Zero does reach Mushoku Tensei first, but only because
AniList tags give them a high cosine similarity; affinity can *reorder* a
genre bucket, it cannot pull a strong theme match in from outside one.

**Do not just swap genres for themes**, which build 33 deliberately did not do.
31 entries have no genres and are already handled by a special tier; far more
have no themes, and the ordering rules — match quality, then direction, then
monotonicity — are tuned against genre-sized buckets. Changing what *decides*
matching is the highest-risk edit in this project, and the working notes exist
because "obvious" fixes here have made things measurably worse before. Capture
a walks baseline, change one thing, read the diff anchor by anchor.

~~**A very long series is still recommended to a very short one.**~~ Fixed in
build 35 — see "And a 220-episode series is demoted against a 12-episode one"
above. The original note is kept below because the measurement in it is what
the threshold was chosen against.

**The measurement it was chosen against**, kept because the threshold came
from it. GATE: Jieitai is 12 episodes, and its fifth result was
Naruto at 220. Nothing is misbehaving: Naruto shares all three of GATE's
genres, which is an exact match as far as the matcher is concerned, and it sits
283 places away — four behind Juuni Kokuki. It arrives in proper proximity
order in the top tier.

What the matcher never looks at is **length**. This is the same shape as the
case that justified demoting `Kids`: "a 12-episode dark isekai recommends
Pokémon — 276 episodes, same three genres, 48 places away". Pokémon is caught
because it is Kids; Naruto is Shounen, so nothing catches it. And GATE has no
demographic recorded at all, so that tie-breaker cannot fire either — by
design, a missing demographic is never a penalty.

Measured: 46% of short anchors (≤26 episodes, with genres) have a 100+ episode
*full* genre match within 300 places. Treat that as the ceiling on exposure,
not the rate of bad results — most are buried by affinity, and GATE's Naruto
still only surfaced fifth. The sharper number is that only **100 of 3,493
entries have 100+ episodes**, and being high-ranked and genre-broad they sit
near everything: Ginga Eiyuu Densetsu, Gintama, Hunter x Hunter and Naruto turn
up against Bocchi the Rock, Cyberpunk: Edgerunners and Violet Evergarden alike.

**The fix to try is a length-mismatch demotion built exactly like the Kids one**
— a tier down, so it surfaces once closer-sized matches are exhausted.

**It must be a ratio against the anchor, not an episode count**, because
sometimes a long series is exactly right: Haikyuu!! legitimately reaches Slam
Dunk, Hajime no Ippo, Touch and Diamond no Ace, and a blunt penalty would
wreck that chain. Haikyuu (25 ep) to Hajime no Ippo (75) is 3x; GATE (12) to
Naruto (220) is 18x. That gap is wide enough to separate them — wider than
anything separating the cases that defeated the affinity work above, which is
the reason to think this one is tractable.

~~**A tip jar — "buy me a coffee" or similar.**~~ Built in build 41, not
launched — see "The tip jar" above. The reasoning is kept below because the
registrations were read rather than assumed, and this file had them wrong in
both directions before.

**MyAnimeList is fine with it, explicitly.** The API agreement defines
non-commercial as "personal, educational, open source or communal" and says
such applications may accept *"donations without any quotas"*. It also allows
non-commercial apps *"some pay per click or pay per view advertising"* provided
it does not disrupt the experience and complies with law — so the old note here
was **too strict** about ads.

~~**TMDB is the one to be careful with.**~~ Moot since build 40: TMDB is no
longer a dependency. Kept because it is the reason this job sat behind the
streaming work, and because the terms are worth remembering if TMDB is ever
reached for again. Its licence "does not permit any commercial use", and
commercial explicitly covered advertising revenue and *"indirect monetization
through traffic generation"*:

> Even unpaid activities like donations or volunteer projects may be considered
> commercial if they generate revenue indirectly.

So a donate link was *not* obviously outside their definition, which is the
opposite of what this file once claimed — and their own guidance was to ask
them about the specific case, with commercial use needing "a separate written
agreement". Dropping the dependency was the cheaper answer than the email.

Practically it is one link in the footer next to the credit line. The card must
not move to accommodate it, so it belongs outside `.hero` with the other
explanatory notes.

~~**The voting system.**~~ All three stages shipped, builds 32 to 38: "have you
watched it" → "would you recommend it", a % recommend rating, and MyAnimeList
list import. It was the only part of the original idea needing a backend, and
it now has one.

- ~~**Stage 1: remember what you have watched.**~~ Shipped in build 32. Local
  only, no server. See "The watched list" above.
- ~~**Stage 2: the votes themselves.**~~ Anonymous — a random id in local storage,
  no accounts. Ratings need votes, not identities, and holding strangers'
  credentials is a responsibility this project should not take on. Cloudflare
  already hosts the site, so Pages Functions plus D1 keeps it on one platform.
  Shipped in builds 36 and 37 — see "The vote backend" and "The recommend row"
  above.
  **It cannot be made abuse-proof without accounts, and that is permanent.**
  Clearing local storage earns a fresh id. Rate limiting raises the cost, it
  does not close the door. The numbers should keep reading as soft rather than
  as survey data, and nothing should ever be built on top of them that assumes
  otherwise.
- ~~**Stage 3: imported lists feeding the ratings.**~~ Shipped in build 38 —
  see "Sharing an imported list" above. Roughly 105,000 ratings are needed for
  meaningful per-title percentages (30 across 3,493 titles), which is why the
  import matters: a few hundred uploads does what millions of pageviews would.
  **What is left is nobody knowing the site exists.** The machinery is done;
  the numbers now need people.

~~**A percentage needs a floor before it is shown.**~~ Shipped: `VOTE_FLOOR`
is 30, the server sends it so it can move without a deploy of the page, and
below it the card reports a bare count instead. "100% would recommend" from one
vote looks like data and is not.

**What is left is nobody knowing the site exists.** 30 ratings across 3,493
titles is over a hundred thousand ratings. The machinery is finished; the
numbers now need people, and no amount of further code supplies that.

~~**Tune `AFFINITY_REACH` against real taste.**~~ Judged good as shipped —
30 positions per affinity point, 2026-08-19, by reading the live chains rather
than the test output. There is no ground truth here, so that verdict *is* the
evidence. Don't re-tune it without a reason and a fresh read of the walks;
60 was the other defensible value if one is ever wanted.

~~**31 entries can never be recommended.**~~ Build 29 made 28 of them reachable
by matching on themes in a tier below every genre match. Three have no genre,
theme or tag at all — Psychic Hero, Enter The Garden, Porte — and stay
unreachable, which is the honest end state rather than a gap.

~~**Small phones unverified below 390px.**~~ Checked at 360px, found bad, then
fixed and re-checked good in build 30. Sub-390 is not an edge case: 360px is
the most common Android width and the 12/13 mini, 375px the whole iPhone SE
line.

Two things were wrong. The **source's chip row shared the `.genre-row` class**
with the card, so it inherited the reserved rows despite changing only when
you search — the reservation is now scoped to `.hero .genre-row`. And the
mobile reservations, sized against a 430px Pro Max, were far too generous:
three title lines plus three chip rows plus three toggle rows put the card most
of a screen down. Both are two now, which covers 95% of titles at that width.

A `max-width: 400px` block trims chrome rather than content - smaller toggle
chips so the axis and format rows can share a line, smaller action labels so
"Open on MyAnimeList" stops wrapping and making its button taller than its
neighbour.

---

## Settled

Kept short; the reasoning that still matters has moved into the sections above.

- **Commit identity** — commits are authored with the GitHub noreply address
  `318438975+dvdngyn96-oss@users.noreply.github.com`, and both GitHub email
  settings are on: *Keep my email addresses private* and *Block command line
  pushes that expose my email*. History was rewritten once to remove a personal
  address, and GitHub Support ran a server-side garbage collection so the old
  objects are gone rather than merely unreachable. **Do not set `user.email` in
  this repo to a personal address** — the push will be rejected, and that
  rejection is the safety net doing its job, not a fault to work around.
- **Domain** — `whatanimeshouldiwatchnext.com`, registered through Cloudflare
  Registrar and attached to the Pages project as a custom domain. It is the
  canonical address and what all ten absolute URLs in the repo point at.
  `what-anime-next.pages.dev` still serves the same site and is still where
  deploys land, so neither address breaks.
  - `www` is a **proxied** CNAME to the apex plus a Redirect Rule — the
    *dynamic* kind, `concat("https://whatanimeshouldiwatchnext.com",
    http.request.uri.path)` with preserve-query-string on. A static redirect
    would dump everyone on the home page and silently drop the `?id=` that
    makes a shared recommendation a recommendation.
  - **Always Use HTTPS** is on at the zone. Without it `http://www/` never
    reached the rule and returned 522: the apex handled port 80 because Pages
    set that up for the apex alone. Worst case is now two hops —
    `http://www/?id=…` upgrades to HTTPS, then redirects to the apex, 200.
  - **Web Analytics needs no per-hostname setup.** The beacon token identifies
    the site, and hostname is just a dimension, so the apex and `pages.dev`
    both report into the same dashboard — confirmed by both appearing in the
    URL breakdown. The site's *label* still reads `what-anime-next.pages.dev`
    and that is cosmetic. Never add a second site for a new hostname: that
    issues a fresh token, and the old one is already in `index.html`, so the
    new dashboard would sit empty while the site kept reporting elsewhere.
  - Moving the domain again means moving all ten references together; `SITE`
    in `test/suite.mjs` is one of them, which is what makes the other nine
    enforceable rather than something to remember. And Facebook needs a fresh
    scrape afterwards: a changed `og:url` is a new URL to them, not an update.
- **Deployment** — live on Cloudflare Pages, auto-deploying from `main`.
  Build settings: preset **None**, build command **empty**, output `/`. The
  build command matters — Cloudflare's Workers import flow prefills
  `npm run build`, which here is the 60-minute catalogue rebuild.
  Cloudflare serves the whole repo root, so `package.json`, the `.mjs` scripts
  and `test/` are publicly fetchable; no secrets in them. `/.mal-client-id`
  returns `index.html` (the SPA fallback), not the file — it is not in the repo.
- **Analytics** — Cloudflare Web Analytics, as a manual beacon in `index.html`
  rather than the Pages setting, so it is visible in the repo and survives the
  site moving off Pages. Cookieless: no cookies, no fingerprinting, nothing to
  put a consent banner in front of. The token is public by design and belongs
  in the repo. Automatic setup was never on offer anyway — it needs the
  hostname to be a zone on the account, and `pages.dev` is Cloudflare's domain,
  not ours.
- **AniList tags** — landed build 19, affinity only. Needed no second harvest.
- **Genre backfill** — 42 of 74 recovered from AniList.
- **Recaps** — 23 dropped; `looksLikeRecap` keeps them out of future builds.
- **43 unverified entries** — settled by the build-16 rebuild, now 0. That
  rebuild also dropped 24 entries whose relation lookups had failed open.
- **Small phone** — the guess was wrong: the toggles were fine, the key art was
  the problem. Fixed in build 17 by lifting the identity block above the art.
- **Desktop after the mobile rework** — checked at build 19 and unchanged:
  poster overlapping the banner, identity block beside it, actions in one row,
  three-column grid. `display: contents` stays inside the ≤620px breakpoint.

---

## Explain things plainly

The person who owns this project is not a deeply technical developer. Write for
that, in the chat *and* in this file.

- **Say what a thing does before naming it.** "A redirect rule, which sends
  anyone typing the www address over to the real one" beats "a dynamic redirect
  on `http.host`".
- **Spell out the consequence, not just the mechanism.** "PNG can't compress a
  radial gradient" means nothing on its own; "that glow was three quarters of
  the file size" does.
- **Jargon is fine once it has been explained once.** The goal is not to avoid
  technical words, it is to avoid unexplained ones. This file is full of them
  deliberately — every one gets defined where it first matters.
- **Give the recommendation, then the reasoning.** Not a survey of five options
  weighted equally. Say which one and why, and note what would change the answer.
- **When something cannot be done, say so in one sentence** and give the thing
  that can be done instead. Blocked tool calls, GitHub settings, purchases and
  anything needing a login all fall here.
- Screenshots are how bugs and dashboard confusion get reported here, and they
  work well. Assume the dashboard has been redesigned since training and check
  the actual state before giving directions through a UI.

## Working notes

- Verify against data rather than assuming. Several "obvious" fixes in this
  project made things measurably worse and were reverted — check known-good
  walks (`npm run walks`) *before* declaring a change good, not after.
- **Capture a walks baseline before touching the matcher, and diff.** For a
  change meant to preserve behaviour, byte-identical output is the proof. For a
  change meant to improve it, the diff is the only evidence there is — read it
  anchor by anchor. The tags work looked finished and was silently dropping
  Steins;Gate's three nearest matches; only the diff showed it.
- **Check the anchor list actually covers the thing being changed.** Not one of
  the fourteen anchors was an isekai, so the walks harness could not see the
  problem the Open section had been describing for weeks. Add the anchors
  first, as a separate step, and confirm the existing ones come out
  byte-identical — then the baseline contains the bug and the diff can show
  the fix.
- **A results window too short to reach the known-good result is a baseline
  that lies.** Steins;Gate printed five, and when four nearer matches were
  inserted ahead of it the documented tail — Shinsekai yori, Serial Experiments
  Lain, Texhnolyze, Inuyashiki — fell off the end and read exactly like the
  regression this project fears most. Nothing had been lost. Widened to nine.
- **Break a new guard on purpose and watch the check fail.** Both promotion
  guards were asserted against four anchors, and the empty-tier one passed with
  the guard deleted — none of those four could reach the case. Made in Abyss
  and Monster can, and now do.
- **Seed `localStorage` before the app script boots, not after.** `app.js`
  reads the watched list, the format filter and the year chip into module
  scope on load, so a test that sets them after `makeDom` runs on the
  defaults — and then passes whatever it was meant to catch. A check written
  this way passed with the bug it targeted reinstated. `makeDom` takes
  `seedWatched` and `seedModern` for exactly this.
- **Dry-run any rule that deletes entries.** The recap patterns matched two
  real series (Special A, A Returner's Magic Should Be Special) on the first
  draft. A report-only mode costs nothing and caught it.
- **Write-then-rename when a long job checkpoints.** A plain `writeFileSync`
  onto `anime.json` died mid-run with UNKNOWN (errno -4094) — Windows had it
  briefly locked. Renaming a temp file over it is atomic.
- The user finds real bugs by clicking through the live site. Screenshots have
  caught things the test suite structurally could not.
- `positionOf()` returns `rankPos` or `completionPos` depending on the active
  axis. Anything touching ordering must go through it, not `anime.rank`.
- Three things a change here can quietly break, in the order they bite:
  match quality, then direction, then monotonicity. A reorder that looks local
  becomes a *deletion* through the monotonicity rule, because a candidate that
  no longer advances gets deferred out of sight.
