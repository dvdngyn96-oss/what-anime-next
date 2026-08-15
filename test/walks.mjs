import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
const ROOT = 'C:/Users/David/Downloads/what-anime-next';
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
await walk('Steins;Gate','up',5);
