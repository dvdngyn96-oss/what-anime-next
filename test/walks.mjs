import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('..', import.meta.url)).slice(0, -1);
const html = readFileSync(`${ROOT}/index.html`,'utf8').replace(/<script src="app\.js[^"]*"><\/script>/, '');
const app  = readFileSync(`${ROOT}/app.js`,'utf8');
const real = JSON.parse(readFileSync(`${ROOT}/anime.json`,'utf8'));
const sleep = ms => new Promise(r=>setTimeout(r,ms));

const dom = new JSDOM(html,{runScripts:'dangerously',url:'https://example.com/',pretendToBeVisual:true});
const w = dom.window;
w.scrollTo=()=>{};
w.fetch=()=>Promise.resolve({ok:true,status:200,json:()=>Promise.resolve(real)});
w.eval(`${app}\nwindow.__peek=()=>state;`);
await sleep(500);

async function walk(title, dir='up', n=8) {
  w.document.getElementById('home-btn').dispatchEvent(new w.MouseEvent('click',{bubbles:true}));
  await sleep(60);
  const i=w.document.getElementById('search-input');
  i.value=title; i.dispatchEvent(new w.Event('input',{bubbles:true}));
  await sleep(400);
  w.document.querySelector('#suggestions .suggestion')?.dispatchEvent(new w.MouseEvent('mousedown',{bubbles:true}));
  await sleep(250);
  const body=w.document.getElementById('result-body');
  // direction persists between searches, so always set it explicitly
  const btn = body.querySelector('[data-action="direction"][data-value="'+dir+'"]');
  if (btn && btn.getAttribute('aria-pressed') !== 'true') {
    btn.dispatchEvent(new w.MouseEvent('click',{bubbles:true}));
    await sleep(200);
  }
  const src=JSON.parse(w.eval(`(()=>{const s=window.__peek();return JSON.stringify({t:s.source.title,r:s.source.rank})})()`));
  const out=[];
  for(let k=0;k<n;k++){
    const h=JSON.parse(w.eval(`(()=>{const s=window.__peek();const h=s.list[s.index];return h?JSON.stringify({t:h.title,r:h.rank,bt:h.matchBacktrack}):'null'})()`));
    if(!h) break;
    out.push(h);
    body.querySelector('.hero [data-action="shuffle"]')?.dispatchEvent(new w.MouseEvent('click',{bubbles:true}));
    await sleep(70);
  }
  console.log(`\n${src.t} (#${src.r}) — ${dir}`);
  console.log('   ' + out.map(a=>`#${a.r}${a.bt?'*':''} ${a.t.slice(0,26)}`).join('\n   '));
}

await walk('Fullmetal Alchemist: Brotherhood','down');
await walk('Ame to Kimi to','up',11);
await walk('Tokyo Ravens','up');
await walk('Sasaki to Pii-chan','up');
await walk('Toradora!','up');
/* Nine, not five. At five this anchor printed only as far as Evangelion, and
 * when four nearer matches were later inserted ahead of it the documented tail
 * — Shinsekai yori, Serial Experiments Lain, Texhnolyze, Inuyashiki — fell off
 * the end of the listing and read exactly like the regression this file exists
 * to catch. The chain was intact. A window too short to show the known-good
 * result is a baseline that lies. */
await walk('Steins;Gate','up',9);

/* Added for the affinity-window work. Chosen for shape, not for fame:
 *
 *   Yuru Camp and Haikyuu!! have a *single* genre, so their buckets are huge
 *   and every candidate is a full match — the most sensitive case for any
 *   change to how far a candidate may jump.
 *   Berserk and Cowboy Bebop are dense, high-rank, heavily tagged.
 *   Mushishi is episodic, which the completion axis is known to penalise.
 *   Hyouge Mono is a canary: its genres came from the AniList backfill.
 *   Gakkougurashi! mixes Horror with Slice of Life, an unusual pairing.
 */
await walk('Mushishi','down');
await walk('Cowboy Bebop','down');
await walk('Kenpuu Denki Berserk','down');
await walk('Chihayafuru','up');
await walk('Yuru Camp△','up');
await walk('Haikyuu!!','up');
await walk('Gakkougurashi!','up');
await walk('Hyouge Mono','up');

/* Added for the signature-theme work, and the reason they were added is the
 * point: not one of the fourteen anchors above is an isekai, so the walks
 * harness could not see the problem the "Open" section had been describing
 * for weeks. A baseline that cannot show the bug cannot show the fix either.
 *
 *   Konosuba is the documented case. Exactly *one* thing above it shares all
 *   three of its genres, 163 places away, and serving that single distant
 *   match drags the high-water mark to the top of the rankings — after which
 *   monotonicity defers every nearer isekai, including one 24 places away.
 *   Mushoku Tensei has four genres, one of them Ecchi, so full matches are
 *   nearly impossible and almost the whole chain is backtracks.
 *   Re:Zero is the control: it already reaches Mushoku Tensei first, on tag
 *   similarity alone, and must keep doing so.
 */
await walk('Kono Subarashii Sekai ni Shukufuku wo!','up',10);
await walk('Mushoku Tensei','up',10);
await walk('Re:Zero kara Hajimeru Isekai Seikatsu','up',10);

/* Added for the signature-theme *ordering* work. The promotion rule above only
 * fires when the top tier is sparse and distant, so these are the opposite
 * shape: tiers that are dense and close, where promotion is a no-op by design
 * and ordering is the only thing that can help.
 *
 *   GATE has 31 shows sharing all three of its genres within 100 places. Its
 *   isekai and military matches -- Drifters, which shares both, plus Overlord,
 *   Tate no Yuusha and Youjo Senki -- sit 195 to 251 places away, so proximity
 *   hands the slot to Slayers at 37 with no shared theme at all.
 *   Overlord is the anchor that surfaced the One Piece re-broadcast.
 */
await walk('Gate: Jieitai','up',10);
await walk('Overlord','up',10);
