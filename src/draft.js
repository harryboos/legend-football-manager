const {groupForPosition} = require('./players');
const {rulesFor} = require('./rules');
const {autoLineup} = require('./lineup');

function availablePlayers(game) {
  const used = new Set(game.teams.flatMap(team => team.squad));
  return game.players.filter(player => !used.has(player.id));
}

function currentDraftTeam(game) {
  if (game.draft.complete) return null;
  const rules = rulesFor(game);
  const round = Math.floor(game.draft.pick / game.teams.length);
  const index = game.draft.pick % game.teams.length;
  const reverse = rules.draftMode === 'snake' && round % 2 === 1;
  return game.draft.order[reverse ? game.teams.length - 1 - index : index];
}

function aiChoice(game, team) {
  const desired = {GK: 2, FB: 3, CB: 3, DM: 2, CM: 3, AM: 1, W: 2, ST: 2};
  const counts = {};
  team.squad
    .map(id => game.players.find(player => player.id === id))
    .filter(Boolean)
    .forEach(player => {
      const group = groupForPosition(player.position);
      counts[group] = (counts[group] || 0) + 1;
    });

  return availablePlayers(game).sort((left, right) => {
    const leftGroup = groupForPosition(left.position);
    const rightGroup = groupForPosition(right.position);
    const leftNeed = (desired[leftGroup] || 1) - (counts[leftGroup] || 0);
    const rightNeed = (desired[rightGroup] || 1) - (counts[rightGroup] || 0);
    return rightNeed - leftNeed || right.rating - left.rating;
  })[0];
}

function draftPick(game, teamId, playerId) {
  const rules = rulesFor(game);
  if (game.phase !== 'draft') throw new Error('当前不在选秀阶段');
  if (currentDraftTeam(game) !== teamId) throw new Error('还没轮到这支球队');
  const player = availablePlayers(game).find(candidate => candidate.id === playerId);
  if (!player) throw new Error('球员已被选择');
  const team = game.teams.find(candidate => candidate.id === teamId);
  if (!team) throw new Error('球队不存在');
  team.squad.push(playerId);
  game.draft.pick++;

  if (game.draft.pick >= game.teams.length * rules.squadSize) {
    game.draft.complete = true;
    game.phase = 'season';
    game.teams.forEach(candidate => autoLineup(game, candidate, game.players));
  }
}

function runAiDraft(game) {
  let guard = game.teams.length * rulesFor(game).squadSize + 1;
  while (game.phase === 'draft' && guard-- > 0) {
    const team = game.teams.find(candidate => candidate.id === currentDraftTeam(game));
    if (!team || team.controller === 'human') break;
    const player = aiChoice(game, team);
    if (!player) throw new Error('没有足够的球员完成选秀');
    draftPick(game, team.id, player.id);
  }
}

module.exports = {availablePlayers, currentDraftTeam, aiChoice, draftPick, runAiDraft};
