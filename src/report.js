const {formationSlots} = require('./rules');

const REPORT_VERSION = 1;

function stableRandom(text) {
  let value = 2166136261;
  for (const char of String(text)) {
    value ^= char.charCodeAt(0);
    value = Math.imul(value, 16777619);
  }
  return (value >>> 0) / 4294967295;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function snapshotLineup(team) {
  if (Array.isArray(team.assignments) && team.assignments.length) {
    return team.assignments.map(assignment => ({
      playerId: assignment.playerId,
      slotId: assignment.slotId
    }));
  }
  return (team.starters || []).map((playerId, index) => ({playerId, slotId: `首发${index + 1}`}));
}

function ensureLineups(game, result) {
  const home = game.teams.find(team => team.id === result.home);
  const away = game.teams.find(team => team.id === result.away);
  const lineups = result.lineups && typeof result.lineups === 'object' ? result.lineups : {};
  if (!Array.isArray(lineups.home) || !lineups.home.length) lineups.home = home ? snapshotLineup(home) : [];
  if (!Array.isArray(lineups.away) || !lineups.away.length) lineups.away = away ? snapshotLineup(away) : [];
  result.lineups = lineups;
  return lineups;
}

function scorerEvents(game, result) {
  return (result.scorers || []).map((scorer, index) => {
    const minute = Number.isInteger(scorer.minute)
      ? clamp(scorer.minute, 1, 90)
      : 3 + Math.floor(stableRandom(`${game.seed}:${result.round}:${result.home}:${result.away}:goal:${index}`) * 87);
    scorer.minute = minute;
    return {minute, type: 'goal', teamId: scorer.team, playerId: scorer.player};
  }).sort((left, right) => left.minute - right.minute);
}

function slotGroup(game, team, slotId) {
  const slot = formationSlots(game, team.formation, team.customFormation).find(candidate => candidate.id === slotId);
  if (slot) return slot.group;
  if (slotId === 'GK') return 'GK';
  if (/CB/.test(slotId)) return 'CB';
  if (/LB|RB|WB/.test(slotId)) return 'FB';
  if (/DM/.test(slotId)) return 'DM';
  if (/CM/.test(slotId)) return 'CM';
  if (/AM/.test(slotId)) return 'AM';
  if (/W/.test(slotId)) return 'W';
  return 'ST';
}

function goalsByPlayer(result) {
  const totals = {};
  for (const scorer of result.scorers || []) totals[scorer.player] = (totals[scorer.player] || 0) + 1;
  return totals;
}

function rateLineup(game, result, team, lineup, side, scorerTotals) {
  const teamGoals = side === 'home' ? result.homeGoals : result.awayGoals;
  const conceded = side === 'home' ? result.awayGoals : result.homeGoals;
  const outcome = teamGoals > conceded ? 0.45 : teamGoals === conceded ? 0.05 : -0.4;

  return lineup.map(entry => {
    const player = game.players.find(candidate => candidate.id === entry.playerId);
    if (!player) return null;
    const group = slotGroup(game, team, entry.slotId);
    const goals = scorerTotals[player.id] || 0;
    const jitter = (stableRandom(`${game.seed}:${result.round}:${result.home}:${result.away}:${player.id}`) - 0.5) * 0.7;
    let rating = 6.15 + outcome + (player.rating - 80) * 0.018 + jitter + goals * 0.78;
    rating += Math.min(0.3, teamGoals * 0.06) - Math.min(0.45, conceded * 0.09);
    if (group === 'GK') rating += conceded === 0 ? 0.65 : -Math.max(0, conceded - 2) * 0.13;
    if (['CB', 'FB', 'DM'].includes(group)) rating += conceded === 0 ? 0.35 : -Math.max(0, conceded - 1) * 0.06;
    if (['AM', 'W', 'ST'].includes(group) && teamGoals >= 3) rating += 0.12;
    return {
      playerId: player.id,
      teamId: team.id,
      slotId: entry.slotId,
      rating: Number(clamp(rating, 4.5, 9.8).toFixed(1))
    };
  }).filter(Boolean);
}

function localNarrative(game, result, ratings) {
  const home = game.teams.find(team => team.id === result.home);
  const away = game.teams.find(team => team.id === result.away);
  const winner = result.homeGoals > result.awayGoals ? home : result.awayGoals > result.homeGoals ? away : null;
  const loser = winner?.id === home?.id ? away : home;
  const margin = Math.abs(result.homeGoals - result.awayGoals);
  const best = [...ratings].sort((left, right) => right.rating - left.rating || left.playerId.localeCompare(right.playerId))[0];
  const bestPlayer = game.players.find(player => player.id === best?.playerId);
  const scorers = [...new Set((result.scorers || []).map(item => game.players.find(player => player.id === item.player)?.name).filter(Boolean))];
  let headline;
  let summary;

  if (!winner && result.homeGoals === 0) {
    headline = `${home.name}与${away.name}互交白卷`;
    summary = `${home.name}主场与${away.name}战成 0-0。双方防线保持专注，比赛始终未能出现进球。`;
  } else if (!winner) {
    headline = `${home.name}与${away.name}握手言和`;
    summary = `${home.name}与${away.name}以 ${result.homeGoals}-${result.awayGoals} 战平。${scorers.length ? `${scorers.join('、')}先后取得进球，` : ''}两队最终各取一分。`;
  } else if (margin >= 3) {
    headline = `${winner.name}大胜${loser.name}`;
    summary = `${winner.name}以 ${Math.max(result.homeGoals, result.awayGoals)}-${Math.min(result.homeGoals, result.awayGoals)} 击败${loser.name}。${scorers.length ? `${scorers.join('、')}完成破门，` : ''}胜方在关键机会的把握上明显更胜一筹。`;
  } else {
    headline = `${winner.name}${margin === 1 ? '险胜' : '力克'}${loser.name}`;
    summary = `${winner.name}以 ${Math.max(result.homeGoals, result.awayGoals)}-${Math.min(result.homeGoals, result.awayGoals)} 战胜${loser.name}。${scorers.length ? `${scorers.join('、')}登上进球榜，` : ''}比赛悬念保持到了最后阶段。`;
  }

  if (bestPlayer) summary += ` ${bestPlayer.name}获评全场最佳（${best.rating}分）。`;
  const tacticalNote = `${home.name}采用 ${home.formation}（${home.mentality}），${away.name}采用 ${away.formation}（${away.mentality}）。`;
  return {headline, summary, tacticalNote, playerOfMatch: best?.playerId || null};
}

function hasCompleteReport(result, expectedRatings) {
  const report = result.report;
  return report?.version === REPORT_VERSION
    && typeof report.headline === 'string'
    && typeof report.summary === 'string'
    && Array.isArray(report.events)
    && Array.isArray(report.playerRatings)
    && report.playerRatings.length >= expectedRatings
    && report.playerRatings.every(item => item.playerId && Number.isFinite(item.rating));
}

function ensureReportStats(result) {
  const report = result.report;
  if (!report) return;
  if (!report.teamStats) {
    report.teamStats = {
      home: {possession: 50, shots: Math.max(result.homeGoals + 4, 6), shotsOnTarget: Math.max(result.homeGoals + 1, 2), bigChances: result.homeGoals + 1, corners: 4, fouls: 10, passAccuracy: 82},
      away: {possession: 50, shots: Math.max(result.awayGoals + 4, 6), shotsOnTarget: Math.max(result.awayGoals + 1, 2), bigChances: result.awayGoals + 1, corners: 4, fouls: 10, passAccuracy: 82}
    };
  }
  if (!Array.isArray(report.playerStats)) {
    const playerStats = (report.playerRatings || []).map(rating => ({
      playerId: rating.playerId,
      teamId: rating.teamId,
      started: rating.slotId !== 'SUB',
      minutes: rating.slotId === 'SUB' ? 0 : 90,
      goals: report.events.filter(event => event.type === 'goal' && event.playerId === rating.playerId).length,
      assists: report.events.filter(event => event.type === 'goal' && event.relatedPlayerId === rating.playerId).length,
      keyPasses: report.events.filter(event => event.type === 'key_pass' && event.playerId === rating.playerId).length,
      bigChancesMissed: report.events.filter(event => event.type === 'big_chance_missed' && event.playerId === rating.playerId).length,
      saves: report.events.filter(event => event.type === 'key_save' && event.playerId === rating.playerId).length
    }));
    const byPlayer = new Map(playerStats.map(item => [item.playerId, item]));
    for (const event of report.events.filter(item => item.type === 'substitution')) {
      const outgoing = byPlayer.get(event.playerId);
      const incoming = byPlayer.get(event.relatedPlayerId);
      if (outgoing) outgoing.minutes = Math.min(outgoing.minutes, event.minute);
      if (incoming) incoming.minutes = Math.max(incoming.minutes, 90 - event.minute);
    }
    report.playerStats = playerStats;
  }
  for (const item of report.playerStats) {
    const minimumShots = (Number(item.goals) || 0) + (Number(item.bigChancesMissed) || 0);
    item.shots = Math.max(minimumShots, Number.isFinite(Number(item.shots)) ? Math.round(Number(item.shots)) : minimumShots);
    item.passes = Math.max(0, Number.isFinite(Number(item.passes)) ? Math.round(Number(item.passes)) : 0);
    item.passesCompleted = clamp(Number.isFinite(Number(item.passesCompleted)) ? Math.round(Number(item.passesCompleted)) : 0, 0, item.passes);
    item.yellowCards = clamp(Number.isFinite(Number(item.yellowCards)) ? Math.round(Number(item.yellowCards)) : 0, 0, 2);
    item.redCards = clamp(Number.isFinite(Number(item.redCards)) ? Math.round(Number(item.redCards)) : 0, 0, 1);
  }
}

function ensureMatchReport(game, result) {
  const lineups = ensureLineups(game, result);
  const expectedRatings = lineups.home.length + lineups.away.length;
  if (hasCompleteReport(result, expectedRatings)) {
    ensureReportStats(result);
    return result.report;
  }

  const home = game.teams.find(team => team.id === result.home);
  const away = game.teams.find(team => team.id === result.away);
  if (!home || !away) return null;
  const scorerTotals = goalsByPlayer(result);
  const ratings = [
    ...rateLineup(game, result, home, lineups.home, 'home', scorerTotals),
    ...rateLineup(game, result, away, lineups.away, 'away', scorerTotals)
  ];
  const narrative = localNarrative(game, result, ratings);
  result.report = {
    version: REPORT_VERSION,
    source: 'simulation',
    headline: narrative.headline,
    summary: narrative.summary,
    tacticalNote: narrative.tacticalNote,
    events: scorerEvents(game, result),
    playerRatings: ratings,
    playerOfMatch: narrative.playerOfMatch
  };
  ensureReportStats(result);
  return result.report;
}

function ensureGameReports(game) {
  for (const result of game.results || []) ensureMatchReport(game, result);
  game.reportVersion = REPORT_VERSION;
  return game;
}

module.exports = {REPORT_VERSION, ensureMatchReport, ensureGameReports, snapshotLineup};
