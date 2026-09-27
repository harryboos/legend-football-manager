const {performance} = require('node:perf_hooks');
const {createGame} = require('../src/game');
const {autoLineup} = require('../src/lineup');
const {aiChoice} = require('../src/draft');
const {buildSeasonStats, statusFor} = require('../src/season');

const game = createGame('本地性能基准', '测试经理', {seed: 7788, id: 'BENCH1'});
for (const [index, team] of game.teams.entries()) {
  team.squad = game.players.slice(index * 18, index * 18 + 18).map(player => player.id);
}
const draftGame = createGame('选秀性能基准', '测试经理', {seed: 7788, id: 'BENCH2'});
draftGame.teams[0].squad = draftGame.players.slice(0, 12).map(player => player.id);

function benchmark(name, iterations, run) {
  for (let index = 0; index < 10; index++) run();
  const samples = [];
  for (let sample = 0; sample < 7; sample++) {
    const started = performance.now();
    for (let iteration = 0; iteration < iterations; iteration++) run();
    samples.push((performance.now() - started) / iterations);
  }
  samples.sort((left, right) => left - right);
  console.log(`${name.padEnd(27)} ${samples[3].toFixed(3).padStart(9)} ms`);
}

console.log(`Node ${process.version} · fixed seed 7788 · median of 7 samples (per operation)`);
benchmark('autoLineup / 20 teams', 3, () => {
  for (const team of game.teams) autoLineup(game, team, game.players);
});
benchmark('statusFor / 360 players', 100, () => {
  for (const player of game.players) statusFor(game, player.id);
});
benchmark('buildSeasonStats / 360', 30, () => buildSeasonStats(game));
benchmark('aiChoice / 12 drafted', 30, () => aiChoice(draftGame, draftGame.teams[0]));
