// Times buildMEI on the Mega Man 2 fixture (23 parts, ~128 bars).
import { loadFixtureScore, ScoreBuilder as SB } from './lib.mjs';
const score = await loadFixtureScore();
for (const opts of [{ grid: 2, simplify: true }, { grid: 2 }, { grid: 1, tuplets: 'off' }]) {
  SB.buildMEI(score, opts); // warm up
  const runs = 10, t0 = performance.now();
  let r;
  for (let i = 0; i < runs; i++) r = SB.buildMEI(score, opts);
  const ms = (performance.now() - t0) / runs;
  console.log(`${JSON.stringify(opts)} parts ${score.parts.length} measures ${r.measures} notes ` +
    `${score.parts.reduce((s, p) => s + p.notes.length, 0)} buildMEI ${ms.toFixed(1)} ms`);
}
