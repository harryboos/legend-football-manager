const {REPORT_VERSION, snapshotLineup} = require('./report');
const {autoLineup} = require('./lineup');
const {matchPlanFor} = require('./ai-manager');
const {availabilityFor, isPlayerAvailable, settleRoundStatuses, snapshotUnavailable} = require('./season');

const EVENT_TYPES = new Set(['goal', 'big_chance_missed', 'key_pass', 'key_save', 'substitution', 'injury', 'tactical_change']);

function requiredText(value, field, maximumLength) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`AI 比赛数据缺少 ${field}`);
  return text.slice(0, maximumLength);
}

function score(value, field) {
  if (!Number.isInteger(value) || value < 0 || value > 8) throw new Error(`${field}必须是 0 至 8 的整数`);
  return value;
}

function fixtureKey(home, away) {
  return `${home}:${away}`;
}

function invalidateCachedFixture(game, roundNumber, fixture) {
  const cache = game.aiSimulationCache?.[String(roundNumber)];
  if (cache) delete cache[fixtureKey(fixture.home, fixture.away)];
}

function snapshotBench(game, team) {
  const starters = new Set((team.assignments || []).map(assignment => assignment.playerId));
  return (team.squad || []).filter(playerId => !starters.has(playerId) && isPlayerAvailable(game, playerId)).map(playerId => ({playerId, slotId: 'SUB'}));
}

function participantMap(home, away, lineups, benches) {
  return new Map([
    ...lineups.home.map(entry => [entry.playerId, home.id]),
    ...lineups.away.map(entry => [entry.playerId, away.id]),
    ...benches.home.map(entry => [entry.playerId, home.id]),
    ...benches.away.map(entry => [entry.playerId, away.id])
  ]);
}

function eventDescription(type) {
  return {
    goal: '把握机会完成破门',
    big_chance_missed: '面对绝佳机会未能完成破门',
    key_pass: '送出穿透防线的关键传球',
    key_save: '门将完成一次关键扑救',
    substitution: '球队完成换人调整',
    injury: '球员因伤无法继续坚持',
    tactical_change: '主教练根据场上局势调整了战术'
  }[type];
}

function validatedEvents(rawEvents, participants, resultScore, lineups, benches, aiTeamIds) {
  const events = (Array.isArray(rawEvents) ? rawEvents : []).flatMap((event, index) => {
    if (!EVENT_TYPES.has(event.type)) return [];
    if (event.type === 'tactical_change') {
      if (![resultScore.homeId, resultScore.awayId].includes(event.teamId)) return [];
      const parsedMinute = Math.round(Number(event.minute));
      return [{
        minute: Number.isFinite(parsedMinute) ? Math.max(1, Math.min(90, parsedMinute)) : 60,
        type: event.type,
        teamId: event.teamId,
        description: String(event.description || '').trim().slice(0, 100) || eventDescription(event.type)
      }];
    }
    const expectedTeam = participants.get(event.playerId);
    if (!expectedTeam || expectedTeam !== event.teamId) return [];
    if (event.type === 'substitution' && (!event.relatedPlayerId || participants.get(event.relatedPlayerId) !== event.teamId)) return [];
    const parsedMinute = Math.round(Number(event.minute));
    const minute = Number.isFinite(parsedMinute) ? Math.max(1, Math.min(90, parsedMinute)) : Math.min(90, 8 + index * 7);
    return [{
      minute,
      type: event.type,
      teamId: event.teamId,
      playerId: event.playerId,
      ...(event.relatedPlayerId && participants.has(event.relatedPlayerId) ? {relatedPlayerId: event.relatedPlayerId} : {}),
      ...(event.type === 'injury' ? {
        injury: String(event.injury || '比赛中受伤').slice(0, 40),
        recoveryMatches: statistic(event.recoveryMatches, 1, 1, 8)
      } : {}),
      description: String(event.description || '').trim().slice(0, 100) || eventDescription(event.type)
    }];
  });
  const sideForTeam = teamId => teamId === resultScore.homeId ? 'home' : 'away';
  const starterPlayers = teamId => lineups[sideForTeam(teamId)].map(entry => entry.playerId);
  const benchPlayers = teamId => benches[sideForTeam(teamId)].map(entry => entry.playerId);
  const playerAt = (players, index) => {
    const resolved = index < 0 ? Math.max(0, players.length + index) : Math.min(index, players.length - 1);
    return players[resolved];
  };
  const generatedEvent = (type, teamId, playerId, minute, relatedPlayerId) => ({
    minute,
    type,
    teamId,
    playerId,
    ...(relatedPlayerId ? {relatedPlayerId} : {}),
    description: eventDescription(type),
    generated: true
  });
  const substitutions = [];
  for (const teamId of [resultScore.homeId, resultScore.awayId]) {
    const starters = new Set(starterPlayers(teamId));
    const bench = new Set(benchPlayers(teamId));
    const usedOut = new Set();
    const usedIn = new Set();
    const valid = events.filter(event => event.type === 'substitution' && event.teamId === teamId)
      .sort((left, right) => left.minute - right.minute)
      .filter(event => {
        if (!starters.has(event.playerId) || !bench.has(event.relatedPlayerId)
          || usedOut.has(event.playerId) || usedIn.has(event.relatedPlayerId)) return false;
        usedOut.add(event.playerId);
        usedIn.add(event.relatedPlayerId);
        return true;
      })
      .slice(0, 3);
    substitutions.push(...valid.map(event => ({...event, minute: Math.min(89, event.minute)})));
    if (!valid.length && bench.size) {
      substitutions.push(generatedEvent('substitution', teamId, playerAt([...starters], -1), teamId === resultScore.homeId ? 64 : 69, playerAt([...bench], 0)));
    }
  }
  const tacticalChanges = events.filter(event => event.type === 'tactical_change').slice(0, 4);
  for (const teamId of aiTeamIds || []) {
    if (!tacticalChanges.some(event => event.teamId === teamId)) {
      tacticalChanges.push({
        minute: teamId === resultScore.homeId ? 58 : 64,
        type: 'tactical_change',
        teamId,
        description: resultScore.homeGoals === resultScore.awayGoals
          ? '调整压迫和推进方式，尝试打破场上平衡'
          : '根据比分变化重新分配攻守投入',
        generated: true
      });
    }
  }
  const entryMinute = new Map([
    ...lineups.home.map(entry => [entry.playerId, 1]),
    ...lineups.away.map(entry => [entry.playerId, 1]),
    ...substitutions.map(event => [event.relatedPlayerId, event.minute])
  ]);
  const exitMinute = new Map(substitutions.map(event => [event.playerId, event.minute]));
  const activeAt = (playerId, minute) => entryMinute.has(playerId)
    && minute >= entryMinute.get(playerId)
    && minute <= (exitMinute.get(playerId) || 90);
  const goals = [];
  for (const [teamId, expected] of [[resultScore.homeId, resultScore.homeGoals], [resultScore.awayId, resultScore.awayGoals]]) {
    const teamGoals = events.filter(event => event.type === 'goal' && event.teamId === teamId && activeAt(event.playerId, event.minute)).sort((left, right) => left.minute - right.minute).slice(0, expected);
    while (teamGoals.length < expected) {
      const number = teamGoals.length;
      const minute = 10 + Math.floor((number + 1) * 75 / (expected + 1));
      teamGoals.push(generatedEvent('goal', teamId, playerAt(starterPlayers(teamId), -1 - number % 3), minute));
    }
    goals.push(...teamGoals);
  }

  let highlights = events.filter(event => !['goal', 'substitution', 'tactical_change'].includes(event.type) && activeAt(event.playerId, event.minute)).sort((left, right) => left.minute - right.minute);
  const required = [
    ['key_pass', resultScore.homeId, -4, 16],
    ['big_chance_missed', resultScore.awayId, -1, 34],
    ['key_save', resultScore.homeId, 0, 57]
  ];
  for (const [type, teamId, playerIndex, minute] of required) {
    if (!highlights.some(event => event.type === type)) highlights.push(generatedEvent(type, teamId, playerAt(starterPlayers(teamId), playerIndex), minute));
  }
  if (highlights.length < 4) highlights.push(generatedEvent('key_save', resultScore.awayId, playerAt(starterPlayers(resultScore.awayId), 0), 76));
  if (highlights.length > 9) {
    const selected = ['big_chance_missed', 'key_pass', 'key_save'].map(type => highlights.find(event => event.type === type));
    highlights = [...selected, ...highlights.filter(event => !selected.includes(event))].slice(0, 9);
  }

  return [...goals, ...highlights, ...substitutions, ...tacticalChanges]
    .map(event => event.type === 'substitution' || !event.relatedPlayerId || activeAt(event.relatedPlayerId, event.minute)
      ? event
      : Object.fromEntries(Object.entries(event).filter(([key]) => key !== 'relatedPlayerId')))
    .sort((left, right) => left.minute - right.minute);
}

function validatedRatings(rawRatings, participants, lineups, events) {
  if (!Array.isArray(rawRatings)) throw new Error('AI 比赛数据缺少 playerRatings');
  const starters = [...lineups.home, ...lineups.away];
  const substitutes = [...new Set(events.filter(event => event.type === 'substitution').map(event => event.relatedPlayerId))]
    .map(playerId => ({playerId, slotId: 'SUB'}));
  const expected = [...starters, ...substitutes];
  const byPlayer = new Map();
  for (const item of rawRatings) {
    if (byPlayer.has(item.playerId) || !expected.some(entry => entry.playerId === item.playerId)) continue;
    const expectedTeam = participants.get(item.playerId);
    if (!expectedTeam || item.teamId !== expectedTeam) continue;
    const rating = Number(item.rating);
    if (!Number.isFinite(rating)) continue;
    byPlayer.set(item.playerId, {
      playerId: item.playerId,
      teamId: item.teamId,
      rating: Number(Math.max(4, Math.min(10, rating)).toFixed(1)),
      note: String(item.note || '').trim().slice(0, 60) || '完成了本场职责要求'
    });
  }
  const missingStarter = starters.find(entry => !byPlayer.has(entry.playerId));
  if (missingStarter) throw new Error('球员评分必须完整包含双方22名首发');
  return expected.map(entry => ({
    ...(byPlayer.get(entry.playerId) || {
      playerId: entry.playerId,
      teamId: participants.get(entry.playerId),
      rating: 6.4,
      note: '替补登场后完成了战术任务'
    }),
    slotId: entry.slotId
  }));
}

function statistic(value, fallback, minimum, maximum) {
  const parsed = Math.round(Number(value));
  return Math.max(minimum, Math.min(maximum, Number.isFinite(parsed) ? parsed : fallback));
}

function validatedTeamStats(rawStats, events, resultScore) {
  const raw = rawStats && typeof rawStats === 'object' ? rawStats : {};
  const build = (side, teamId, goals, opponentId) => {
    const source = raw[side] || {};
    const missed = events.filter(event => event.teamId === teamId && event.type === 'big_chance_missed').length;
    const keyPasses = events.filter(event => event.teamId === teamId && event.type === 'key_pass').length;
    const opponentSaves = events.filter(event => event.teamId === opponentId && event.type === 'key_save').length;
    const minimumShots = goals + missed;
    const shots = statistic(source.shots, minimumShots + opponentSaves + 4, minimumShots, 35);
    const shotsOnTarget = statistic(source.shotsOnTarget, goals + opponentSaves, goals, shots);
    return {
      possession: statistic(source.possession, 50, 20, 80),
      shots,
      shotsOnTarget,
      bigChances: statistic(source.bigChances, goals + missed, goals, 15),
      corners: statistic(source.corners, 3 + keyPasses, 0, 18),
      fouls: statistic(source.fouls, 10, 0, 30),
      passAccuracy: statistic(source.passAccuracy, 82, 55, 96)
    };
  };
  const home = build('home', resultScore.homeId, resultScore.homeGoals, resultScore.awayId);
  const away = build('away', resultScore.awayId, resultScore.awayGoals, resultScore.homeId);
  const possessionTotal = home.possession + away.possession;
  home.possession = Math.round(home.possession / possessionTotal * 100);
  away.possession = 100 - home.possession;
  return {home, away};
}

function passBaseline(slotId, minutes) {
  const per90 = slotId === 'GK' ? 36
    : /CB|DM|CM/.test(slotId) ? 54
      : /LB|RB|WB/.test(slotId) ? 46
        : /AM/.test(slotId) ? 42
          : /LW|RW|W/.test(slotId) ? 34
            : /ST|CF/.test(slotId) ? 26
              : 30;
  return Math.max(1, Math.round(per90 * minutes / 90));
}

function shotPriority(slotId) {
  if (/ST|CF/.test(slotId)) return 0;
  if (/LW|RW|W|AM/.test(slotId)) return 1;
  if (/CM|DM/.test(slotId)) return 2;
  if (/LB|RB|WB/.test(slotId)) return 3;
  if (/CB/.test(slotId)) return 4;
  return 5;
}

function buildPlayerStats(events, ratings, lineups, rawRatings, teamStats, resultScore) {
  const starterIds = new Set([...lineups.home, ...lineups.away].map(entry => entry.playerId));
  const rawByPlayer = new Map((Array.isArray(rawRatings) ? rawRatings : []).filter(item => item && typeof item === 'object').map(item => [item.playerId, item]));
  const slots = new Map(ratings.map(item => [item.playerId, item.slotId]));
  const stats = new Map(ratings.map(item => [item.playerId, {
    playerId: item.playerId,
    teamId: item.teamId,
    started: starterIds.has(item.playerId),
    minutes: starterIds.has(item.playerId) ? 90 : 0,
    goals: 0,
    assists: 0,
    keyPasses: 0,
    bigChancesMissed: 0,
    saves: 0,
    shots: 0,
    passes: 0,
    passesCompleted: 0,
    yellowCards: 0,
    redCards: 0
  }]));
  for (const event of events) {
    const actor = stats.get(event.playerId);
    const related = stats.get(event.relatedPlayerId);
    if (event.type === 'substitution') {
      if (actor) actor.minutes = Math.min(actor.minutes, event.minute);
      if (related) related.minutes = Math.max(related.minutes, 90 - event.minute);
    } else if (event.type === 'goal') {
      if (actor) actor.goals++;
      if (related && related.teamId === event.teamId) related.assists++;
    } else if (event.type === 'key_pass' && actor) actor.keyPasses++;
    else if (event.type === 'big_chance_missed' && actor) actor.bigChancesMissed++;
    else if (event.type === 'key_save' && actor) actor.saves++;
  }
  for (const item of stats.values()) {
    const source = rawByPlayer.get(item.playerId) || {};
    const minimumShots = item.goals + item.bigChancesMissed;
    const maximumShots = Math.max(minimumShots, Math.ceil(item.minutes / 6));
    item.shots = statistic(source.shots, minimumShots, minimumShots, maximumShots);
    const fallbackPasses = passBaseline(slots.get(item.playerId) || 'SUB', item.minutes);
    const maximumPasses = Math.max(fallbackPasses, Math.ceil(item.minutes * 1.7));
    item.passes = statistic(source.passes, fallbackPasses, 0, maximumPasses);
    const side = item.teamId === resultScore.homeId ? 'home' : 'away';
    item.passesCompleted = statistic(source.passesCompleted, Math.round(item.passes * teamStats[side].passAccuracy / 100), 0, item.passes);
    item.yellowCards = statistic(source.yellowCards, 0, 0, 2);
    item.redCards = statistic(source.redCards, 0, 0, 1);
  }

  for (const [side, teamId] of [['home', resultScore.homeId], ['away', resultScore.awayId]]) {
    const players = [...stats.values()].filter(item => item.teamId === teamId)
      .sort((left, right) => shotPriority(slots.get(left.playerId) || 'SUB') - shotPriority(slots.get(right.playerId) || 'SUB'));
    let shotDifference = teamStats[side].shots - players.reduce((sum, item) => sum + item.shots, 0);
    while (shotDifference < 0) {
      const adjustable = [...players].reverse().find(item => item.shots > item.goals + item.bigChancesMissed);
      if (!adjustable) break;
      adjustable.shots--;
      shotDifference++;
    }
    for (let index = 0; shotDifference > 0; index++, shotDifference--) players[index % players.length].shots++;

    const totalPasses = players.reduce((sum, item) => sum + item.passes, 0);
    const targetCompleted = Math.round(totalPasses * teamStats[side].passAccuracy / 100);
    let passDifference = targetCompleted - players.reduce((sum, item) => sum + item.passesCompleted, 0);
    while (passDifference > 0) {
      const adjustable = players.find(item => item.passesCompleted < item.passes);
      if (!adjustable) break;
      adjustable.passesCompleted++;
      passDifference--;
    }
    while (passDifference < 0) {
      const adjustable = [...players].reverse().find(item => item.passesCompleted > 0);
      if (!adjustable) break;
      adjustable.passesCompleted--;
      passDifference++;
    }
  }
  return [...stats.values()];
}

function validatedMatch(game, fixture, round, raw, model) {
  const home = game.teams.find(team => team.id === fixture.home);
  const away = game.teams.find(team => team.id === fixture.away);
  if (!raw || raw.homeId !== home.id || raw.awayId !== away.id) throw new Error('AI 返回的对阵与当前赛程不一致');
  const homeGoals = score(raw.homeGoals, '主队进球');
  const awayGoals = score(raw.awayGoals, '客队进球');
  const lineups = {home: snapshotLineup(home), away: snapshotLineup(away)};
  const benches = {home: snapshotBench(game, home), away: snapshotBench(game, away)};
  const participants = participantMap(home, away, lineups, benches);
  if (participants.size !== lineups.home.length + lineups.away.length + benches.home.length + benches.away.length) throw new Error('双方比赛名单存在重复球员');
  const resultScore = {homeId: home.id, awayId: away.id, homeGoals, awayGoals};
  const aiTeamIds = new Set([home, away].filter(team => team.controller === 'AI').map(team => team.id));
  const events = validatedEvents(raw.events, participants, resultScore, lineups, benches, aiTeamIds);
  const playerRatings = validatedRatings(raw.playerRatings, participants, lineups, events);
  const bestRating = Math.max(...playerRatings.map(item => item.rating));
  const requestedBest = playerRatings.find(item => item.playerId === raw.playerOfMatch);
  const playerOfMatch = requestedBest?.rating === bestRating
    ? requestedBest.playerId
    : playerRatings.find(item => item.rating === bestRating).playerId;
  const teamStats = validatedTeamStats(raw.teamStats, events, resultScore);
  const playerStats = buildPlayerStats(events, playerRatings, lineups, raw.playerRatings, teamStats, resultScore);
  const scorers = events.filter(event => event.type === 'goal').map(event => ({
    team: event.teamId,
    player: event.playerId,
    minute: event.minute
  }));

  return {
    round,
    home: home.id,
    away: away.id,
    homeGoals,
    awayGoals,
    scorers,
    lineups,
    benches,
    tacticalPlans: {home: home.matchPlan || null, away: away.matchPlan || null},
    report: {
      version: REPORT_VERSION,
      source: 'deepseek',
      model,
      headline: requiredText(raw.headline, '战报标题', 50),
      summary: requiredText(raw.summary, '战报正文', 400),
      tacticalNote: requiredText(raw.tacticalNote, '战术观察', 220),
      events,
      playerRatings,
      playerOfMatch,
      teamStats,
      playerStats
    }
  };
}

function prepareRoundLineups(game, round) {
  const prepared = new Set();
  for (const fixture of round.games) {
    const home = game.teams.find(team => team.id === fixture.home);
    const away = game.teams.find(team => team.id === fixture.away);
    for (const [team, opponent] of [[home, away], [away, home]]) {
      if (prepared.has(team.id)) continue;
      if (team.controller === 'AI') {
        const plan = matchPlanFor(game, team, opponent, round.number);
        team.formation = plan.formation;
        team.mentality = plan.mentality;
        team.matchPlan = plan;
        autoLineup(game, team, game.players);
      } else if (!Array.isArray(team.assignments)
        || team.assignments.length !== 11
        || team.assignments.some(assignment => !isPlayerAvailable(game, assignment.playerId))) {
        autoLineup(game, team, game.players);
      }
      if (!Array.isArray(team.assignments) || team.assignments.length !== 11) throw new Error(`${team.name}没有足够的可出场球员组成首发`);
      const unavailable = team.assignments.find(assignment => !isPlayerAvailable(game, assignment.playerId));
      if (unavailable) throw new Error(`${team.name}首发包含${availabilityFor(game, unavailable.playerId).label}的球员`);
      prepared.add(team.id);
    }
  }
}

async function playRound(game, matchService) {
  if (game.phase !== 'season') throw new Error('赛季尚未开始');
  if (!matchService?.available) throw new Error('DeepSeek V4 Flash 比赛引擎尚未配置');
  const round = game.rounds[game.currentRound];
  if (!round) throw new Error('赛季已经结束');
  const unavailableBeforeRound = snapshotUnavailable(game);
  prepareRoundLineups(game, round);
  const generated = await matchService.simulateRound(game, round);
  if (!Array.isArray(generated) || generated.length !== round.games.length) throw new Error(`AI 必须返回本轮全部 ${round.games.length} 场比赛`);
  const generatedByFixture = new Map();
  for (const [index, raw] of generated.entries()) {
    const key = fixtureKey(raw?.homeId, raw?.awayId);
    if (generatedByFixture.has(key)) {
      invalidateCachedFixture(game, round.number, round.games[index]);
      throw new Error('AI 返回了重复对阵');
    }
    generatedByFixture.set(key, raw);
  }
  const validKeys = new Set(round.games.map(fixture => fixtureKey(fixture.home, fixture.away)));
  if ([...generatedByFixture.keys()].some(key => !validKeys.has(key))) {
    generated.forEach((raw, index) => {
      if (!validKeys.has(fixtureKey(raw?.homeId, raw?.awayId))) invalidateCachedFixture(game, round.number, round.games[index]);
    });
    throw new Error('AI 返回了本轮之外的对阵');
  }
  const results = round.games.map(fixture => {
    try {
      return validatedMatch(
        game,
        fixture,
        round.number,
        generatedByFixture.get(fixtureKey(fixture.home, fixture.away)),
        matchService.model
      );
    } catch (error) {
      invalidateCachedFixture(game, round.number, fixture);
      const home = game.teams.find(team => team.id === fixture.home)?.name || fixture.home;
      const away = game.teams.find(team => team.id === fixture.away)?.name || fixture.away;
      throw new Error(`${home} vs ${away}：${error.message}`);
    }
  });
  settleRoundStatuses(game, results, unavailableBeforeRound);

  for (const result of results) {
    for (const scorer of result.scorers) game.scorers[scorer.player] = (game.scorers[scorer.player] || 0) + 1;
  }
  game.results.push(...results);
  round.played = true;
  game.currentRound++;
  if (game.currentRound >= game.rounds.length) game.phase = 'finished';
  if (game.aiSimulationCache) delete game.aiSimulationCache[String(round.number)];
  return results;
}

function leagueTable(game) {
  const rows = game.teams.map(team => ({teamId: team.id, name: team.name, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, gd: 0, pts: 0}));
  for (const result of game.results) {
    const home = rows.find(row => row.teamId === result.home);
    const away = rows.find(row => row.teamId === result.away);
    if (!home || !away) continue;
    home.p++;
    away.p++;
    home.gf += result.homeGoals;
    home.ga += result.awayGoals;
    away.gf += result.awayGoals;
    away.ga += result.homeGoals;
    if (result.homeGoals > result.awayGoals) {
      home.w++;
      home.pts += 3;
      away.l++;
    } else if (result.homeGoals < result.awayGoals) {
      away.w++;
      away.pts += 3;
      home.l++;
    } else {
      home.d++;
      away.d++;
      home.pts++;
      away.pts++;
    }
  }
  rows.forEach(row => { row.gd = row.gf - row.ga; });
  return rows.sort((left, right) => right.pts - left.pts || right.gd - left.gd || right.gf - left.gf || left.name.localeCompare(right.name));
}

module.exports = {EVENT_TYPES, playRound, validatedMatch, leagueTable};
