function createSchedule(teamIds) {
  if (teamIds.length < 2 || teamIds.length % 2 !== 0) throw new Error('联赛球队数量必须是大于 1 的偶数');
  const rotation = [...teamIds];
  const firstLeg = [];

  for (let round = 0; round < rotation.length - 1; round++) {
    const games = [];
    for (let index = 0; index < rotation.length / 2; index++) {
      let home = rotation[index];
      let away = rotation[rotation.length - 1 - index];
      const shouldSwap = index === 0 ? round % 2 === 1 : index % 2 === 1;
      if (shouldSwap) [home, away] = [away, home];
      games.push({home, away});
    }
    firstLeg.push(games);
    rotation.splice(1, 0, rotation.pop());
  }

  const secondLeg = firstLeg.map(games => games.map(game => ({home: game.away, away: game.home})));
  return [...firstLeg, ...secondLeg].map((games, index) => ({number: index + 1, played: false, games}));
}

function rebalanceRemainingSchedule(rounds, currentRound, teamIds) {
  const ordered = rounds.slice(0, currentRound);
  const remaining = rounds.slice(currentRound);
  const homeCounts = Object.fromEntries(teamIds.map(id => [id, 0]));
  ordered.forEach(round => round.games.forEach(fixture => { homeCounts[fixture.home]++; }));

  while (remaining.length) {
    const roundNumber = ordered.length + 1;
    const targetHomes = roundNumber / 2;
    let bestIndex = 0;
    let bestScore = Infinity;

    for (let index = 0; index < remaining.length; index++) {
      const homes = new Set(remaining[index].games.map(fixture => fixture.home));
      const differences = teamIds.map(id => Math.abs(homeCounts[id] + (homes.has(id) ? 1 : 0) - targetHomes));
      const score = Math.max(...differences) * 1000 + differences.reduce((sum, difference) => sum + difference * difference, 0);
      if (score < bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }

    const [round] = remaining.splice(bestIndex, 1);
    ordered.push(round);
    round.games.forEach(fixture => { homeCounts[fixture.home]++; });
  }

  return ordered.map((round, index) => ({...round, number: index + 1}));
}

module.exports = {createSchedule, rebalanceRemainingSchedule};
