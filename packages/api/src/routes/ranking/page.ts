import type { RankingData, RankingEntry } from "./data.js";

export interface Ranked extends RankingEntry {
  rank: number;
  score: number;
}

export const SCORE_FORMULA =
  "score = 10 x merged PRs + 5 x issues closed + 20 x log10(lines added + removed); line counts include generated files and lockfiles";

export function scoreOf(e: RankingEntry): number {
  const lines = Math.max(1, e.linesAdded + e.linesRemoved);
  return Math.round((e.mergedPrs * 10 + e.issuesClosed * 5 + 20 * Math.log10(lines)) * 10) / 10;
}

export function rankEntries(data: RankingData): Ranked[] {
  return data.entries
    .map((e) => ({ ...e, score: scoreOf(e), rank: 0 }))
    .sort((a, b) => b.score - a.score || a.login.localeCompare(b.login))
    .map((e, i) => ({ ...e, rank: i + 1 }));
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const MEDAL = ["", "1st", "2nd", "3rd"];
const place = (n: number): string => MEDAL[n] ?? `${n}th`;
const METRICS: { key: "mergedPrs" | "issuesClosed" | "linesAdded" | "linesRemoved"; label: string }[] = [
  { key: "mergedPrs", label: "Merged PRs" },
  { key: "issuesClosed", label: "Issues closed" },
  { key: "linesAdded", label: "Lines added" },
  { key: "linesRemoved", label: "Lines removed" },
];

function card(e: Ranked, max: Record<string, number>, repo: string): string {
  const bars = METRICS.map((m) => {
    const v = e[m.key];
    const pct = max[m.key] ? Math.round((v / max[m.key]!) * 100) : 0;
    return `<div class="m"><span>${m.label}</span><b data-n="${v}">${v}</b><div class="bar" role="img" aria-label="${m.label}: ${v}, ${pct}% of the best"><i style="--w:${pct / 100}"></i></div></div>`;
  }).join("");
  return `<article class="card r${e.rank}" style="--i:${e.rank}" aria-label="${place(e.rank)} place: ${esc(e.login)}">
<div class="inner"><div class="place">${place(e.rank)}</div>
<h2><a href="https://github.com/${esc(e.login)}" rel="noopener">@${esc(e.login)}</a></h2>
<div class="score"><b data-n="${e.score}" data-d="1">${e.score}</b><small>points</small></div>
${bars}
<p class="fact">Biggest PR: <a href="https://github.com/${esc(repo)}/pull/${e.biggestPr.number}" rel="noopener">#${e.biggestPr.number}</a> ${esc(e.biggestPr.title)} (${e.biggestPr.lines.toLocaleString("en-US")} lines)</p>
<p class="fact">Merging from ${esc(e.firstMerge.slice(0, 16).replace("T", " "))} to ${esc(e.lastMerge.slice(0, 16).replace("T", " "))} UTC</p></div></article>`;
}

const CSS = `*{box-sizing:border-box}html{color-scheme:dark}body{margin:0;min-height:100vh;background:radial-gradient(ellipse at 50% -10%,#2a1b5e,#0b0b18 60%);color:#eef0ff;font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;overflow-x:hidden}
canvas{position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:5}
main{max-width:1100px;margin:0 auto;padding:40px 20px 60px;position:relative}
header{text-align:center;margin-bottom:36px}
h1{position:relative;display:inline-block;overflow:hidden;font-size:clamp(2rem,6vw,3.6rem);margin:0;background:linear-gradient(90deg,#7cf,#c8f,#fa8);-webkit-background-clip:text;background-clip:text;color:transparent}
h1::after{content:"";position:absolute;inset:0;background:linear-gradient(100deg,transparent 40%,rgba(255,255,255,.55) 50%,transparent 60%);transform:translateX(-100%);animation:sh 6s ease-in-out infinite;mix-blend-mode:overlay}
@keyframes sh{60%,100%{transform:translateX(100%)}}
header p{color:#b9bde0;margin:.4rem 0}
.podium{display:grid;grid-template-columns:1fr 1.1fr 1fr;gap:20px;align-items:end;perspective:900px}
.r1{order:2}.r2{order:1}.r3{order:3}
.card{position:relative;border-radius:20px;padding:2px;background:linear-gradient(135deg,var(--c1),var(--c2));opacity:0;transform:translateY(40px);animation:in .8s cubic-bezier(.2,.8,.2,1) forwards;animation-delay:calc((4 - var(--i)) * .25s + .2s);will-change:transform}
.card::before{content:"";position:absolute;inset:0;border-radius:20px;background:inherit;filter:blur(22px);opacity:.45;z-index:-1}
.r1{--c1:#ffd34d;--c2:#ff7ac6;min-height:520px}.r2{--c1:#cfd8e8;--c2:#6b8cff;min-height:470px}.r3{--c1:#e59a5a;--c2:#d1456b;min-height:430px}
@keyframes in{to{opacity:1;transform:none}}
.inner{transition:transform .15s;will-change:transform;height:100%;min-height:inherit;border-radius:18px;background:#12122a;padding:20px}
.place{font-weight:800;letter-spacing:.15em;text-transform:uppercase;color:var(--c1)}
h2{margin:.2rem 0 0;font-size:1.5rem}a{color:#9cf}
.score{margin:.4rem 0 1rem}.score b{font-size:3rem;line-height:1;font-variant-numeric:tabular-nums}.score small{margin-left:.4rem;color:#b9bde0}
.m{display:grid;grid-template-columns:1fr auto;margin-bottom:10px;font-size:.9rem}.m span{color:#b9bde0}.m b{font-variant-numeric:tabular-nums}
.bar{grid-column:1/3;height:8px;border-radius:4px;background:#25254a;overflow:hidden;margin-top:3px}
.bar i{display:block;height:100%;width:100%;transform-origin:left;transform:scaleX(0);background:linear-gradient(90deg,var(--c1),var(--c2));animation:bar 1.2s cubic-bezier(.2,.8,.2,1) forwards;animation-delay:1.2s}
@keyframes bar{to{transform:scaleX(var(--w))}}
.fact{font-size:.82rem;color:#b9bde0;margin:.6rem 0 0}
.formula{margin:36px auto 0;max-width:760px;text-align:center;color:#b9bde0;font-size:.9rem}code{background:#1c1c3a;padding:2px 8px;border-radius:6px;color:#eef0ff}
@media(max-width:800px){.podium{grid-template-columns:1fr}.r1{order:1}.r2{order:2}.r3{order:3}.card{min-height:0!important}}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}.card{opacity:1;transform:none}.bar i{transform:scaleX(var(--w))}}`;

const JS = `(()=>{var R=matchMedia("(prefers-reduced-motion: reduce)").matches;
var nums=document.querySelectorAll("[data-n]");
if(!R){nums.forEach(function(el){var t=+el.dataset.n,d=el.dataset.d?1:0,s=performance.now()+900;el.textContent=(0).toFixed(d);
(function f(n){var p=Math.min(1,Math.max(0,(n-s)/1400)),e=1-Math.pow(1-p,3);el.textContent=(t*e).toLocaleString("en-US",{minimumFractionDigits:d,maximumFractionDigits:d});if(p<1)requestAnimationFrame(f)})(s)})}
document.querySelectorAll(".card").forEach(function(c){var raf=0,i=c.firstElementChild;
c.addEventListener("pointermove",function(ev){if(R||raf)return;raf=requestAnimationFrame(function(){raf=0;var r=c.getBoundingClientRect(),x=(ev.clientX-r.left)/r.width-.5,y=(ev.clientY-r.top)/r.height-.5;i.style.transform="rotateY("+(x*10).toFixed(1)+"deg) rotateX("+(-y*10).toFixed(1)+"deg)"})});
c.addEventListener("pointerleave",function(){i.style.transform=""})});
if(R)return;
var cv=document.getElementById("fx"),g=cv.getContext("2d"),P=[],MAX=160,run=false,W=0,H=0,dpr=Math.min(devicePixelRatio||1,2);
function size(){W=innerWidth;H=innerHeight;cv.width=W*dpr;cv.height=H*dpr;g.setTransform(dpr,0,0,dpr,0,0)}
size();addEventListener("resize",size);
var col=["#ffd34d","#ff7ac6","#7cf","#c8f","#fa8"];
function burst(){for(var i=0;i<MAX;i++){var a=Math.random()*Math.PI*2,v=4+Math.random()*9;P.push({x:W/2,y:H*.35,vx:Math.cos(a)*v,vy:Math.sin(a)*v-5,s:3+Math.random()*4,l:1,c:col[i%5]})}if(!run){run=true;requestAnimationFrame(tick)}}
function tick(){if(document.hidden){run=false;P.length=0;g.clearRect(0,0,W,H);return}
g.clearRect(0,0,W,H);for(var i=P.length-1;i>=0;i--){var p=P[i];p.vy+=.25;p.vx*=.99;p.x+=p.vx;p.y+=p.vy;p.l-=.011;if(p.l<=0){P.splice(i,1);continue}g.globalAlpha=p.l;g.fillStyle=p.c;g.fillRect(p.x,p.y,p.s,p.s)}
g.globalAlpha=1;if(P.length)requestAnimationFrame(tick);else{run=false;g.clearRect(0,0,W,H)}}
setTimeout(function(){if(!document.hidden)burst()},1800);
document.querySelector(".r1")?.addEventListener("click",burst);
})();`;

export function renderPage(data: RankingData): string {
  const ranked = rankEntries(data);
  const max: Record<string, number> = {};
  for (const m of METRICS) max[m.key] = Math.max(0, ...ranked.map((e) => e[m.key]));
  const json = JSON.stringify({ ...data, ranking: ranked }).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Autopilot ranking</title><meta name="description" content="Which autopilot built the most of this project?">
<style>${CSS}</style></head><body>
<canvas id="fx" aria-hidden="true"></canvas>
<main><header><h1>Autopilot ranking</h1>
<p>Three autopilots built this project. Who shipped the most?</p>
<p><small>Snapshot of ${esc(data.repo)} taken ${esc(data.generatedAt.slice(0, 16).replace("T", " "))} UTC</small></p></header>
<section class="podium" aria-label="Podium">
${ranked.map((e) => card(e, max, data.repo)).join("\n")}
</section>
<p class="formula">How the score works: <code>${esc(SCORE_FORMULA)}</code></p>
</main>
<script id="ranking-data" type="application/json">${json}</script>
<script>${JS}</script></body></html>`;
}
