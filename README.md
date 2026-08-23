# whatanimeshouldiwatchnext

A blank, Google-style page. Type an anime you've already watched, and it walks
up the MyAnimeList rankings to the next one that shares its genres.

Static site — no build step, no server, no runtime API calls for the core loop.

**Live at <https://whatanimeshouldiwatchnext.com>**

## Run it

```bash
npm run serve
```

Then open <http://localhost:8777>. `npm test` runs the suite; `npm run walks`
prints recommendation chains for a set of known anchors, which is the check
that matters when anything about matching changes.

## What's in the catalogue

3,493 entries — 2,679 TV, 532 ONA, 282 OVA. Only things you can start watching
cold:

- **TV, ONA and OVA.** No films and no specials. OVA and ONA are in because
  excluding them loses genuine standalone works: Hellsing Ultimate, FLCL,
  Cyberpunk: Edgerunners, Takopi's Original Sin.
- **First seasons only** — anything with a prequel or a parent story is dropped.
- **No recaps.** MAL types plenty of them as OVA or ONA rather than `special`,
  so a title rule catches *recap, digest, compilation, soushuuhen* and
  *special edition*. Chainsaw Man Recap sat at #1207 for four builds.

So you never get handed a season 2, a recap, or part three of a film trilogy.
The builder scans the top 8,000 by MAL rank and keeps what survives.

A **TV / ONA / OVA filter** in the toggle row narrows what gets recommended —
ONA is the mixed bag, holding Edgerunners alongside a long tail of donghua.
It filters what you're offered, never what you can search from.

Sequels are detected from MAL's own `related_anime` data — if an entry has a
`prequel` relation, it's out. That's authoritative rather than guesswork, and it
catches the cases titles don't advertise. A title-pattern check (`2nd Season`,
`Part 2`, `R2`, trailing roman numerals) runs first as a cheap pre-filter and a
backstop for entries whose relation data can't be fetched.

## How it works

The site runs off `anime.json`, a local catalogue ordered by **MyAnimeList
rank**. Because the whole ranking sits on the client, the recommendation is
literal rather than approximate:

1. Find your anime's row in the ranking.
2. Step one position at a time toward rank #1.
3. Return the first entries that share its genres.

That's the actual "next one up the list" — not "something with a similar score".

Worked example — **Tokyo Ravens**, ranked #2658, genres Action / Fantasy /
Romance, themes School / Urban Fantasy:

| Rank | Climb | Title |
| --- | --- | --- |
| #2619 | +39 | Zero no Tsukaima F |
| #2599 | +59 | Rakudai Kishi no Cavalry |
| #2517 | +141 | Shakugan no Shana |

Search is local too, so autocomplete is instant — no API, no rate limits,
nothing that can go down.

### Genres decide, demographic and themes break ties

MAL's API merges genres, themes and demographics into one list. The builder
splits them. **Genres** (Action / Fantasy / Romance) decide whether something
matches at all — requiring every theme to line up too would be so strict that
nothing ever would.

**Demographic** (Shounen, Seinen, Shoujo, Josei, Kids) and **themes** (School,
Urban Fantasy, Isekai) then order the matches, via a single affinity score:

```
affinity = shared themes + (same demographic ? 2 : 0)
```

Demographic is weighted higher because Shounen versus Josei is a wider gap than
School versus Adult Cast. It only counts when **both** sides declare one — a
missing demographic scores zero, never a penalty. That matters: only 41% of the
catalogue has one, against 79% for themes. A source with no demographic behaves
exactly as it did before, falling back to rank order.

Matching themes and demographics are outlined on the result, so you can see why
it was chosen. The effect is substantial — for anchors that have a demographic,
it changes the top recommendation **52% of the time**:

| Anchor | Genres + themes | Adding demographic |
| --- | --- | --- |
| Hunter x Hunter *(Shounen)* | Berserk | **One Piece** |
| Rainbow *(Seinen)* | Attack on Titan | **Monster** |
| Slam Dunk *(Shounen)* | Uma Musume | **Hajime no Ippo** |
| Saiki Kusuo *(Shounen)* | Grand Blue | **Gintama** |
| Toradora! *(no demographic)* | Chihayafuru | Chihayafuru *(unchanged)* |

### Badges

**Hidden gem** — well rated, but comparatively few people have watched it.
Thresholds come from the catalogue's own distribution (bottom 40% by members,
top 40% by score) rather than fixed numbers, so it keeps working as rankings
shift. About 8% of entries qualify.

**Currently airing** — still going out, so there's more to come.

### Match quality beats direction

Walking up is the default, but a weak match upward is worse than a strong match
downward. The order of preference is:

1. every genre shared, in the direction you asked for
2. every genre shared, the other way
3. all but one, in the direction you asked for
4. all but one, the other way
5. any overlap, either way

Steins;Gate (#5) is the clearest case. Nothing above it shares Drama / Sci-Fi /
Suspense — only Fullmetal Alchemist and Frieren, on the strength of "Drama"
alone. Just below sit Evangelion, Shinsekai yori and Gankutsuou, sharing all
three. It walks down and says so.

### Everything anchors to your original pick

Results are always matched against the anime you searched for, never against
the last thing shown. Chaining off each result instead makes it drift — the
seventh suggestion ends up having nothing to do with where you started.

**Seen it too — drop it** removes an entry and re-runs against the same anchor,
so the attribution line never changes:

> Steins;Gate → Evangelion → Shinsekai yori → Gankutsuou →
> Serial Experiments Lain → Texhnolyze → Inuyashiki

**Start from this instead** is the explicit way to re-anchor. A fresh search
clears the dismissals; if everything nearby has been dismissed, it forgets
rather than dead-ending.

**Show me another** steps through the matches without dismissing anything.

### The climb never goes backwards

Criteria loosen as the walk runs out of matches — first the demographic, then
themes, then genres. Crucially, **loosening does not restart the walk**: it
carries on from where it got to. Offering something worse-ranked *and* a weaker
match than what you were just shown is worse on both counts, so it never does.

Himekishi wa Barbaroi no Yome (#5198, Adventure / Comedy / Fantasy, Shounen):

| Rank | Match |
| --- | --- |
| 5069 → 2768 | all 3 genres + Shounen |
| 2456 → 2229 | all 3 genres *(demographic ran out — climb continues)* |
| 5210 → … | walks down, having exhausted everything above |

Each loosening says what it dropped. The rank only ever moves backwards once,
when the climb is genuinely exhausted and the walk turns around — and that is
labelled too. The "others" grid shows peers of the entry on screen.

Entries the climb passed over aren't discarded: they're swept into one
continuous run at the end, so the list stays long without re-introducing a
sawtooth.

### Searching something outside the catalogue

If you've watched a film, an OVA or a season 3 and want to use it as your
starting point, search still works: it falls back to AniList (no key needed),
slots the result into the ranking by score, and saves it to `localStorage`.

Those live entries are **starting points only** — they've not been checked for
being a film or a sequel, so they're never offered as recommendations. What you
search is unrestricted; what you get back is always something you can start
cold.

### Match tiers

If nothing further up the list matches every genre, it relaxes and says so:

| Tier | Meaning |
| --- | --- |
| exact | shares every genre |
| close | shares all but one (only when the source has 3+ genres) |
| loose | shares at least one |

### Filtered out

- Sequels and specials from the same franchise (normalised title prefix)
- Recaps, digests and compilations, by title rule
- Films and anything MAL types as `special`

**Entries with no genres at all** used to be unreachable, since the walk
matches on genres and they have none to share. 43 were recovered by backfilling
from AniList — Hyouge Mono (#704) among them — and the remaining 31 now match
on a shared *theme* instead, in a tier below every genre match. Three have no
genre, theme or tag at all and stay unreachable.

### Better matches, from AniList tags

MAL gives three flat genres and a couple of themes. AniList gives around eight
community-voted tags with relevance weights — Fullmetal Alchemist: Brotherhood
is *Alchemy 90%, Military 90%, War 90%, Politics 80%* where MAL offers only
"Military".

Genres still decide whether something matches. Tags decide the order within a
tier, scored as cosine similarity — not raw overlap, because popular shows
carry three or four times as many tags as obscure ones and an unnormalised sum
would quietly rank by fame.

A better match earns a longer jump, measured in **ranking positions** rather
than list slots: each point of similarity buys 30 places of extra distance over
the nearest candidate. That bound is the whole safety argument. Without it a
title 1,592 places away outranks one 105 away, which is the premise of "the
next one along" thrown out entirely.

## Rebuilding the catalogue

```bash
npm run build                  # ~60 min
node add-watch-providers.mjs   # ~20 min — REQUIRED after every rebuild
```

The ranking scan itself is quick — 500 entries per request, sixteen calls. The
hour goes on the prequel check, which needs one request per series and is what
keeps season 2 out. Writes `anime.json` (~1.15 MB).

**It is a two-step job.** `build-catalogue.mjs` writes a catalogue with no TMDB
ids and no streaming data at all, because it has none to carry forward. Run
`add-watch-providers.mjs` straight after or the site ships with zero listings.
The two must never run at once — both rewrite `anime.json` in place.

AniList tags and the genre backfill happen inside the builder's art pass, so a
rebuild collects them already. `add-anilist-tags.mjs` and `backfill-genres.mjs`
exist to fix an existing catalogue without paying the hour.

Once a season is a good cadence. Nothing breaks if it's stale: new shows need
months of votes before they rank meaningfully, and existing entries drift only a
few positions.

### Credentials

Two files, both gitignored, both **build-time only** — the shipped site
contains no credentials:

- `.mal-client-id` — MyAnimeList, from <https://myanimelist.net/apiconfig>
  (App type: other, **non-commercial**)
- `.tmdb-key` — TMDB v3, registered for **personal use**, for streaming
  listings

AniList needs no key at all, for either the build-time tag harvest or the
runtime synopsis lookup.

Both registrations are non-commercial. TMDB's definition of commercial is
broader than "makes money" — deploying isn't the trigger, ads are.

## Other bits

- Results are deep-linkable: `?id=16011&dir=up`
- **Ranked higher / lower** walks the list in either direction
- **Show me another** steps through the matches
- **I've seen this one too** pivots onto the recommendation
- **Surprise me** picks a random anime from the catalogue
- Synopses are fetched lazily from AniList for the shown title only, after a
  short pause — so a card you skim past costs no request
- Titles are searchable in both romaji and English
- Light and dark themes follow the OS setting
- Streaming listings for the US and Canada, from TMDB
- The card is a **constant height** by design: every block holds its space
  whether or not it has content, so clicking "show me another" repeatedly never
  moves the buttons out from under the cursor
