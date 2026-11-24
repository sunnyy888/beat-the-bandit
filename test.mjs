// Tests for the game's core logic. Run: node test.mjs
// Loads the <script id="core"> block straight out of index.html, so the tested code is the shipped code.
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const src = html.match(/<script id="core">([\s\S]*?)<\/script>/)[1];
const ctx = { module: { exports: {} } };
vm.runInNewContext(src, ctx);
const Core = ctx.module.exports;

let pass = 0, fail = 0;
function check(name, ok, detail = "") { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ": " + detail : ""}`); }
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;

// 1. seeded RNG is deterministic and in [0, 1)
{
  const a = Core.mulberry32(42), b = Core.mulberry32(42), xs = Array.from({ length: 1e5 }, a);
  check("rng deterministic", Array.from({ length: 1e5 }, b).every((x, i) => x === xs[i]));
  check("rng range and mean", xs.every(x => x >= 0 && x < 1) && Math.abs(mean(xs) - 0.5) < 0.005, `mean ${mean(xs).toFixed(4)}`);
}
// 2. Beta sampler matches the Beta(a, b) mean and variance
for (const [a, b] of [[2, 5], [1, 1], [30, 70], [0.5, 0.5]]) {
  const rng = Core.mulberry32(7), n = 200000, xs = Array.from({ length: n }, () => Core.beta(rng, a, b));
  const m = mean(xs), v = mean(xs.map(x => (x - m) ** 2));
  const mT = a / (a + b), vT = a * b / ((a + b) ** 2 * (a + b + 1));
  const seM = Math.sqrt(vT / n);
  check(`Beta(${a},${b}) sampler`, Math.abs(m - mT) < 4 * seM && Math.abs(v / vT - 1) < 0.03,
    `mean ${m.toFixed(4)} vs ${mT.toFixed(4)}, var ${v.toFixed(5)} vs ${vT.toFixed(5)}`);
}
// 3. Beta pdf integrates to 1 (midpoint rule) and matches known values
for (const [a, b] of [[1, 1], [3, 7], [2, 2], [12, 40]]) {
  const N = 20000; let s = 0; for (let i = 0; i < N; i++) s += Core.betaPdf((i + 0.5) / N, a, b) / N;
  check(`Beta(${a},${b}) pdf integrates to 1`, Math.abs(s - 1) < 1e-4, s.toFixed(6));
}
check("Beta(2,2) pdf at 0.5 = 1.5", Math.abs(Core.betaPdf(0.5, 2, 2) - 1.5) < 1e-9);
check("lgamma(5) = ln 24", Math.abs(Core.lgamma(5) - Math.log(24)) < 1e-10);
// 4. difficulty levels give the promised gaps
for (const [lvl, d] of Object.entries(Core.DIFFICULTY)) {
  const rng = Core.mulberry32(1); let ok = true;
  for (let i = 0; i < 2000; i++) {
    const r = Core.makeRates(rng, lvl), s = [...r].sort((x, y) => y - x);
    ok &&= r.every(x => x >= d.lo - 1e-9 && x <= d.hi + 1e-9) && s[0] - s[1] >= d.minGap - 1e-9 && s[0] - s[2] <= d.maxSpread + 1e-9;
  }
  check(`difficulty ${lvl}: 2,000 games within rules`, ok);
}
// 5. regret = sum (best - rate pulled) x pulls
{
  const p = Core.newPlayer(); p.pulls = [10, 60, 30];
  const r = Core.regret(p, [0.5, 0.65, 0.4]);
  check("regret by hand", Math.abs(r - (10 * 0.15 + 0 + 30 * 0.25)) < 1e-9, `${r.toFixed(2)} (hand 9.00)`);
  p.pulls = [0, 100, 0]; check("always-best regret is 0", Core.regret(p, [0.5, 0.65, 0.4]) === 0);
}
// 6. epsilon-greedy: tries each arm once, then explores eps of the time uniformly over all 3 arms
{
  const rng = Core.mulberry32(3), p = Core.newPlayer();
  check("eps-greedy tries arms 0,1,2 first", [0, 1, 2].every(i => { const a = Core.epsGreedyChoose(p, rng); p.pulls[a]++; return a === i; }));
  p.pulls = [10, 10, 10]; p.wins = [2, 8, 5];             // leader = arm 1
  const n = 200000, counts = [0, 0, 0];
  for (let i = 0; i < n; i++) counts[Core.epsGreedyChoose(p, rng, 0.1)]++;
  const other = (counts[0] + counts[2]) / n;               // expected 0.1 x 2/3
  check("eps-greedy non-leader share = eps x 2/3", Math.abs(other - 0.1 * 2 / 3) < 0.003, `${other.toFixed(4)} vs 0.0667`);
}
// 7. Thompson picks proportional to P(arm is best): with Beta(51,51) vs Beta(1,1)-like it explores; with lopsided data it exploits
{
  const rng = Core.mulberry32(5), p = Core.newPlayer();
  p.pulls = [200, 200, 200]; p.wins = [40, 140, 100];     // arm 1 clearly best
  let c1 = 0; for (let i = 0; i < 20000; i++) c1 += Core.thompsonChoose(p, rng) === 1;
  check("Thompson exploits a clear winner", c1 / 20000 > 0.99, `${(100 * c1 / 20000).toFixed(2)}% on best arm`);
}
// 8. strategy performance over 2,000 simulated games per difficulty (same machines, own luck)
for (const lvl of ["easy", "medium", "hard"]) {
  const rng = Core.mulberry32(11), R = { ts: [], eg: [], rand: [] };
  for (let g = 0; g < 2000; g++) {
    const rates = Core.makeRates(rng, lvl), ts = Core.newPlayer(), eg = Core.newPlayer(), rd = Core.newPlayer();
    for (let t = 0; t < 100; t++) {
      Core.pull(ts, Core.thompsonChoose(ts, rng), rates, rng);
      Core.pull(eg, Core.epsGreedyChoose(eg, rng), rates, rng);
      Core.pull(rd, Math.floor(rng() * 3), rates, rng);
    }
    if (ts.coins !== ts.wins.reduce((a, b) => a + b) || ts.history.length !== 100) throw new Error("bookkeeping");
    R.ts.push(Core.regret(ts, rates)); R.eg.push(Core.regret(eg, rates)); R.rand.push(Core.regret(rd, rates));
  }
  const [t, e, r] = [mean(R.ts), mean(R.eg), mean(R.rand)];
  const strict = lvl === "easy";             // on hard, 100 pulls barely separate rates within 6 points
  check(`${lvl}: Thompson and eps-greedy beat random`, strict ? t < 0.6 * r && e < 0.8 * r : t < r && e < r,
    `mean regret Thompson ${t.toFixed(2)}, eps-greedy ${e.toFixed(2)}, random ${r.toFixed(2)}`);
}
console.log(`\n${pass}/${pass + fail} PASS`);
process.exit(fail ? 1 : 0);
