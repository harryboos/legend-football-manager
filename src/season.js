const YELLOW_CARD_THRESHOLD = 5;
const RED_CARD_SUSPENSION = 1;

function defaultStatus() {
  return {yellowCards: 0, suspensionMatches: 0, injuryMatches: 0, injury: null};
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

function statusMap(game) {
  if (!game.playerStatuses || typeof game.playerStatuses !== 'object' || Array.isArray(game.playerStatuses)) {
    game.playerStatuses = {};
  }
  return game.playerStatuses;
}

function ensurePlayerStatuses(game) {
  for (const player of game.players || []) statusFor(game, player.id);
  return statusMap(game);
}

function statusFor(game, playerId) {
  const statuses = statusMap(game);
  let status = Object.hasOwn(statuses, playerId) ? statuses[playerId] : null;
  if (!status || typeof status !== 'object' || Array.isArray(status)) {
    status = defaultStatus();
    Object.defineProperty(statuses, playerId, {value: status, writable: true, enumerable: true, configurable: true});
  }
  // Normalize only the requested player and retain references held by round settlement.
  status.yellowCards = nonNegativeInteger(status.yellowCards);
  status.suspensionMatches = nonNegativeInteger(status.suspensionMatches);
  status.injuryMatches = nonNegativeInteger(status.injuryMatches);
  status.injury = status.injuryMatches && status.injury ? String(status.injury).slice(0, 40) : null;
  return status;
}

function availabilityFor(game, playerId) {
  const status = statusFor(game, playerId);
  if (status.injuryMatches > 0) return {available: false, type: 'injured', label: `伤病 · 预计 ${status.injuryMatches} 轮后恢复`};
  if (status.suspensionMatches > 0) return {available: false, type: 'suspended', label: `停赛 · 剩余 ${status.suspensionMatches} 场`};
  return {available: true, type: 'available', label: '可出场'};
}

function isPlayerAvailable(game, playerId) {
  return availabilityFor(game, playerId).available;
}

function stableValue(text) {
  let value = 2166136261;
  for (const char of String(text)) {
    value ^= char.charCodeAt(0);
    value = Math.imul(value, 16777619);
  }
  return (value >>> 0) / 4294967295;
}

function injuryDetails(matches) {
  if (matches <= 1) return '轻微撞伤';
  if (matches <= 3) return '肌肉拉伤';
  if (matches <= 5) return '脚踝扭伤';
  return '腿筋伤势';
}

function generatedInjuryEvents(game, result) {
  if ((result.report.events || []).some(event => event.type === 'injury')) return [];
  const participants = (result.report.playerStats || []).filter(item => item.minutes >= 20);
  if (!participants.length) return [];
  const base = `${game.seed}:${result.round}:${result.home}:${result.away}:injury`;
  const count = stableValue(base) < 0.1 ? 1 : 0;
  const events = [];
  for (let index = 0; index < count; index++) {
    const playerIndex = Math.floor(stableValue(`${base}:player:${index}`) * participants.length);
    const participant = participants[Math.min(playerIndex, participants.length - 1)];
    const recoveryMatches = 1 + Math.floor(stableValue(`${base}:duration:${index}`) * 6);
    const injury = injuryDetails(recoveryMatches);
    events.push({
      minute: 25 + Math.floor(stableValue(`${base}:minute:${index}`) * 61),
      type: 'injury',
      teamId: participant.teamId,
      playerId: participant.playerId,
      injury,
      recoveryMatches,
      description: `${injury}，预计缺席 ${recoveryMatches} 场比赛`,
      generated: true
    });
  }
  return events;
}

function applyInjuryMinutes(result) {
  const stats = new Map((result.report?.playerStats || []).map(item => [item.playerId, item]));
  const entries = new Map((result.report?.events || []).filter(event => event.type === 'substitution')
    .map(event => [event.relatedPlayerId, event.minute]));
  for (const event of result.report?.events || []) {
    if (event.type !== 'injury') continue;
    const item = stats.get(event.playerId);
    if (!item) continue;
    const minutes = item.started
      ? event.minute
      : Math.max(0, event.minute - (entries.get(event.playerId) || event.minute));
    item.minutes = Math.min(item.minutes, minutes);
  }
}

function applyDiscipline(status, item) {
  const yellowCards = status.yellowCards + nonNegativeInteger(item.yellowCards);
  status.yellowCards = yellowCards % YELLOW_CARD_THRESHOLD;
  status.suspensionMatches += Math.floor(yellowCards / YELLOW_CARD_THRESHOLD)
    + nonNegativeInteger(item.redCards) * RED_CARD_SUSPENSION;
}

function settleRoundStatuses(game, results, unavailableBeforeRound) {
  ensurePlayerStatuses(game);
  for (const [playerId, previous] of Object.entries(unavailableBeforeRound || {})) {
    const status = statusFor(game, playerId);
    if (previous.suspensionMatches > 0) status.suspensionMatches = Math.max(0, status.suspensionMatches - 1);
    if (previous.injuryMatches > 0) status.injuryMatches = Math.max(0, status.injuryMatches - 1);
    if (!status.injuryMatches) status.injury = null;
  }

  for (const result of results) {
    const generated = generatedInjuryEvents(game, result);
    if (generated.length) result.report.events = [...(result.report.events || []), ...generated].sort((left, right) => left.minute - right.minute);
    applyInjuryMinutes(result);
    for (const item of result.report.playerStats || []) {
      const status = statusFor(game, item.playerId);
      applyDiscipline(status, item);
    }
    for (const event of result.report.events || []) {
      if (event.type !== 'injury') continue;
      const status = statusFor(game, event.playerId);
      const recoveryMatches = Math.max(1, Math.min(8, Math.round(Number(event.recoveryMatches) || 1)));
      if (recoveryMatches >= status.injuryMatches) {
        status.injuryMatches = recoveryMatches;
        status.injury = String(event.injury || injuryDetails(recoveryMatches)).slice(0, 40);
      }
    }
  }
}

function snapshotUnavailable(game) {
  ensurePlayerStatuses(game);
  return Object.fromEntries(Object.entries(game.playerStatuses).map(([playerId, status]) => [playerId, {
    suspensionMatches: status.suspensionMatches,
    injuryMatches: status.injuryMatches
  }]));
}

function rebuildPlayerStatuses(game) {
  game.playerStatuses = {};
  ensurePlayerStatuses(game);
  const byRound = new Map();
  for (const result of game.results || []) {
    if (!byRound.has(result.round)) byRound.set(result.round, []);
    byRound.get(result.round).push(result);
  }
  for (const results of [...byRound.entries()].sort((left, right) => left[0] - right[0]).map(entry => entry[1])) {
    for (const status of Object.values(game.playerStatuses)) {
      status.suspensionMatches = Math.max(0, status.suspensionMatches - 1);
      status.injuryMatches = Math.max(0, status.injuryMatches - 1);
      if (!status.injuryMatches) status.injury = null;
    }
    for (const result of results) {
      for (const item of result.report?.playerStats || []) {
        const status = statusFor(game, item.playerId);
        applyDiscipline(status, item);
      }
      for (const event of result.report?.events || []) {
        if (event.type !== 'injury' || !event.playerId) continue;
        const status = statusFor(game, event.playerId);
        const recoveryMatches = Math.max(1, Math.min(8, Math.round(Number(event.recoveryMatches) || 1)));
        if (recoveryMatches >= status.injuryMatches) {
          status.injuryMatches = recoveryMatches;
          status.injury = String(event.injury || injuryDetails(recoveryMatches)).slice(0, 40);
        }
      }
    }
  }
  return game.playerStatuses;
}

function emptyPlayerStats(playerId, teamId) {
  return {
    playerId, teamId, appearances: 0, starts: 0, minutes: 0, goals: 0, assists: 0,
    shots: 0, passes: 0, passesCompleted: 0, keyPasses: 0, bigChancesMissed: 0,
    saves: 0, yellowCards: 0, redCards: 0, playerOfMatch: 0, ratingTotal: 0, ratingCount: 0
  };
}

function buildSeasonStats(game) {
  const teamByPlayer = new Map(game.teams.flatMap(team => team.squad.map(playerId => [playerId, team.id])));
  const players = new Map((game.players || []).filter(player => teamByPlayer.has(player.id))
    .map(player => [player.id, emptyPlayerStats(player.id, teamByPlayer.get(player.id))]));
  const teams = new Map(game.teams.map(team => [team.id, {
    teamId: team.id, matches: 0, possessionTotal: 0, shots: 0, shotsOnTarget: 0,
    bigChances: 0, corners: 0, fouls: 0, passAccuracyTotal: 0
  }]));

  for (const result of game.results || []) {
    const ratings = new Map((result.report?.playerRatings || []).map(item => [item.playerId, item.rating]));
    for (const item of result.report?.playerStats || []) {
      const row = players.get(item.playerId) || emptyPlayerStats(item.playerId, item.teamId);
      players.set(item.playerId, row);
      row.appearances++;
      if (item.started) row.starts++;
      for (const key of ['minutes', 'goals', 'assists', 'shots', 'passes', 'passesCompleted', 'keyPasses', 'bigChancesMissed', 'saves', 'yellowCards', 'redCards']) {
        row[key] += Math.max(0, Number(item[key]) || 0);
      }
      if (ratings.has(item.playerId)) {
        row.ratingTotal += Number(ratings.get(item.playerId)) || 0;
        row.ratingCount++;
      }
      if (result.report?.playerOfMatch === item.playerId) row.playerOfMatch++;
    }
    for (const [side, teamId] of [['home', result.home], ['away', result.away]]) {
      const row = teams.get(teamId);
      const stats = result.report?.teamStats?.[side];
      if (!row || !stats) continue;
      row.matches++;
      row.possessionTotal += Number(stats.possession) || 0;
      row.shots += Number(stats.shots) || 0;
      row.shotsOnTarget += Number(stats.shotsOnTarget) || 0;
      row.bigChances += Number(stats.bigChances) || 0;
      row.corners += Number(stats.corners) || 0;
      row.fouls += Number(stats.fouls) || 0;
      row.passAccuracyTotal += Number(stats.passAccuracy) || 0;
    }
  }

  const playerStats = [...players.values()].map(row => ({
    ...row,
    averageRating: row.ratingCount ? Number((row.ratingTotal / row.ratingCount).toFixed(2)) : 0,
    passAccuracy: row.passes ? Math.round(row.passesCompleted / row.passes * 100) : 0,
    status: {...statusFor(game, row.playerId), ...availabilityFor(game, row.playerId)}
  })).sort((left, right) => right.goals - left.goals || right.averageRating - left.averageRating);
  const teamStats = [...teams.values()].map(row => ({
    ...row,
    averagePossession: row.matches ? Number((row.possessionTotal / row.matches).toFixed(1)) : 0,
    averagePassAccuracy: row.matches ? Number((row.passAccuracyTotal / row.matches).toFixed(1)) : 0
  }));
  return {playerStats, teamStats};
}

module.exports = {
  RED_CARD_SUSPENSION,
  YELLOW_CARD_THRESHOLD,
  availabilityFor,
  buildSeasonStats,
  ensurePlayerStatuses,
  isPlayerAvailable,
  rebuildPlayerStatuses,
  settleRoundStatuses,
  snapshotUnavailable,
  statusFor
};
