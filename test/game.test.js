const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {Readable} = require('stream');
const cfg = require('../config');
const {
  createGame,
  draftPick,
  runAiDraft,
  playRound,
  publicGame,
  setLineup,
  normalizeCustomFormation,
  migrateGame,
  positionFit
} = require('../src/game');
const {groupForPosition} = require('../src/players');
const {createGameStore, persistentGame} = require('../src/storage');
const {createRequestHandler} = require('../src/api');
const {createDeepSeekMatchService, DEEPSEEK_API_URL, DEEPSEEK_MODEL} = require('../src/match-ai');

function completeDraft(game) {
  game.phase = 'draft';
  while (!game.draft.complete) {
    draftPick(game, 't1', publicGame(game).availablePlayers[0].id);
    runAiDraft(game);
  }
  return game;
}

function fakeMatch(game, fixture, round, index) {
  const home = game.teams.find(team => team.id === fixture.home);
  const away = game.teams.find(team => team.id === fixture.away);
  const homeGoals = (round.number + index) % 3;
  const awayGoals = (round.number + index) % 2;
  const homePlayers = home.assignments.map(assignment => assignment.playerId);
  const awayPlayers = away.assignments.map(assignment => assignment.playerId);
  const playerOfMatch = homePlayers[1];
  const events = [
    {minute: 6, type: 'key_pass', teamId: home.id, playerId: homePlayers[6], relatedPlayerId: homePlayers[9], description: '直塞撕开了客队防线'},
    {minute: 14, type: 'big_chance_missed', teamId: away.id, playerId: awayPlayers[10], description: '近距离射门稍稍偏出'},
    {minute: 22, type: 'key_save', teamId: home.id, playerId: homePlayers[0], relatedPlayerId: awayPlayers[9], description: '门将封出了势在必进的射门'},
    {minute: 27, type: 'key_save', teamId: away.id, playerId: awayPlayers[0], relatedPlayerId: homePlayers[10], description: '门将快速倒地完成关键扑救'},
    {minute: 31, type: 'key_pass', teamId: away.id, playerId: awayPlayers[6], relatedPlayerId: awayPlayers[10], description: '精准传球创造绝佳机会'}
  ];
  for (let goal = 0; goal < homeGoals; goal++) events.push({minute: 40 + goal * 18, type: 'goal', teamId: home.id, playerId: homePlayers[9 + goal % 2], description: '冷静完成破门'});
  for (let goal = 0; goal < awayGoals; goal++) events.push({minute: 52 + goal * 18, type: 'goal', teamId: away.id, playerId: awayPlayers[10], description: '抓住机会扳回一球'});
  const playerRatings = [home, away].flatMap(team => team.assignments.map((assignment, playerIndex) => ({
    playerId: assignment.playerId,
    teamId: team.id,
    rating: assignment.playerId === playerOfMatch ? 8.8 : Number((6.1 + (playerIndex % 5) * 0.2).toFixed(1)),
    note: assignment.playerId === playerOfMatch ? '掌控比赛并创造决定性机会' : '完成了本职工作',
    shots: playerIndex >= 8 ? 2 : 0,
    passes: 30 + playerIndex * 3,
    passesCompleted: 24 + playerIndex * 2,
    yellowCards: playerIndex === 5 ? 1 : 0,
    redCards: playerIndex === 10 ? 1 : 0
  })));
  return {
    homeId: home.id,
    awayId: away.id,
    homeGoals,
    awayGoals,
    headline: `${home.name}与${away.name}完成较量`,
    summary: `${home.name}与${away.name}围绕中场控制展开争夺，双方都创造出了有威胁的机会，最终比分由关键时刻的把握能力决定。`,
    tacticalNote: `${home.formation}与${away.formation}形成直接对照，双方职责设置影响了攻防转换。`,
    events: events.sort((left, right) => left.minute - right.minute),
    playerRatings,
    playerOfMatch
  };
}

function createFakeMatchService(transform) {
  return {
    available: true,
    model: DEEPSEEK_MODEL,
    async simulateRound(game, round) {
      const matches = round.games.map((fixture, index) => fakeMatch(game, fixture, round, index));
      return transform ? transform(matches) : matches;
    }
  };
}

function callHandler(handler, method, url, body) {
  const request = Readable.from(body ? [JSON.stringify(body)] : []);
  request.method = method;
  request.url = url;
  let status;
  let headers;
  let payload = '';
  const response = {
    writeHead(nextStatus, nextHeaders) {
      status = nextStatus;
      headers = nextHeaders;
    },
    end(chunk = '') {
      payload += chunk;
    }
  };
  return handler(request, response).then(() => ({status, headers, body: payload ? JSON.parse(payload) : null}));
}

test('生成20队、38轮且前半程主场数保持平衡', () => {
  const game = createGame('测试', '玩家', {seed: 1});
  assert.equal(game.teams.length, 20);
  assert.equal(game.rounds.length, 38);
  assert.ok(game.rounds.every(round => round.games.length === 10));
  const pair = game.rounds.flatMap(round => round.games).filter(fixture => [fixture.home, fixture.away].sort().join() === 't1,t2');
  assert.equal(pair.length, 2);
  assert.notEqual(pair[0].home, pair[1].home);
  const firstLegHomeCounts = game.teams.map(team => game.rounds.slice(0, 19).flatMap(round => round.games).filter(fixture => fixture.home === team.id).length);
  assert.ok(firstLegHomeCounts.every(count => count === 9 || count === 10));
});

test('房主创建联赛时可以选择任意开局球队', () => {
  const game = createGame('选队测试', '自定义经理', {hostTeamId: 't12', seed: 12});
  assert.equal(game.teams.find(team => team.id === 't12').controller, 'human');
  assert.equal(game.teams.find(team => team.id === 't12').manager, '自定义经理');
  assert.equal(game.teams.find(team => team.id === 't1').controller, 'AI');
  assert.throws(() => createGame('错误球队', '玩家', {hostTeamId: 't99'}), /球队不存在/);
});

test('球员库包含360名不重名真实球员且位置结构平衡', () => {
  const game = createGame('测试', '玩家');
  assert.equal(game.players.length, 360);
  assert.equal(new Set(game.players.map(player => player.name)).size, 360);
  assert.ok(game.players.every(player => !/^国际球员/.test(player.name)));
  const counts = {};
  game.players.forEach(player => {
    const group = groupForPosition(player.position);
    counts[group] = (counts[group] || 0) + 1;
  });
  assert.deepEqual(counts, {W: 40, ST: 46, CM: 50, DM: 36, CB: 60, GK: 42, AM: 26, FB: 60});
  const player = game.players[0];
  assert.ok(player.positions.length >= 1);
  assert.ok(game.players.every(candidate => candidate.heightCm >= 164 && candidate.heightCm <= 203));
  assert.ok(game.players.every(candidate => candidate.weightKg >= 58 && candidate.weightKg <= 102));
  assert.ok(game.players.every(candidate => candidate.positionFamiliarity[candidate.position] === 100));
  assert.ok(game.players.every(candidate => Object.keys(candidate.positionFamiliarity).length === 12));
  assert.equal(Object.keys(player.attributes).length, 26);
  assert.ok(Object.values(player.attributes).every(value => value >= 1 && value <= 20));
  assert.equal(Object.keys(player.categoryAverages).length, 4);
  const maradona = game.players.find(candidate => candidate.name === '马拉多纳');
  assert.equal(maradona.heightCm, 165);
  assert.equal(maradona.weightKg, 67);
  assert.equal(maradona.positionFamiliarity.AM, 100);
  assert.equal(maradona.positionFamiliarity.CB, 18);
  assert.equal(positionFit(maradona, {id: 'AM', group: 'AM'}), 1);
  assert.ok(positionFit(maradona, {id: 'CB', group: 'CB'}) < 0.4);
});

test('真人选择后AI自动选到下一位真人或选秀结束', () => {
  const game = createGame('测试', '玩家');
  game.phase = 'draft';
  draftPick(game, 't1', game.players[0].id);
  runAiDraft(game);
  assert.equal(game.draft.pick, 39);
  assert.equal(game.teams[0].squad.length, 1);
  assert.ok(game.teams.slice(1).every(team => team.squad.length === 2));
});

test('完整选秀生成18人阵容、11人职责且严重客串极少', () => {
  const game = completeDraft(createGame('测试', '玩家'));
  assert.ok(game.teams.every(team => team.squad.length === 18 && team.starters.length === 11 && team.assignments.length === 11));
  assert.ok(game.teams.every(team => team.assignments.every(assignment => assignment.inRole && assignment.outRole)));
  let poorFits = 0;
  for (const team of game.teams) {
    for (const assignment of team.assignments) {
      const slot = publicGame(game).config.formations[team.formation].find(candidate => candidate.id === assignment.slotId);
      const player = game.players.find(candidate => candidate.id === assignment.playerId);
      if (positionFit(player, slot) < 0.72) poorFits++;
    }
  }
  assert.ok(poorFits <= 5, `严重客串人数过多：${poorFits}`);
});

test('相同AI输出产生完全相同的赛季结果', async () => {
  const left = completeDraft(createGame('测试', '玩家', {seed: 20260815, id: 'LEFT01'}));
  const right = completeDraft(createGame('测试', '玩家', {seed: 20260815, id: 'RIGHT1'}));
  await playRound(left, createFakeMatchService());
  await playRound(right, createFakeMatchService());
  assert.deepEqual(left.results, right.results);
});

test('DeepSeek决定赛果并生成关键事件、换人和所有出场球员数据', async () => {
  const game = completeDraft(createGame('战报测试', '玩家', {seed: 88}));
  const results = await playRound(game, createFakeMatchService());
  assert.equal(results.length, 10);
  for (const result of results) {
    assert.ok(result.report.headline);
    assert.ok(result.report.summary);
    assert.equal(result.report.source, 'deepseek');
    assert.equal(result.report.model, 'deepseek-v4-flash');
    assert.equal(result.report.events.filter(event => event.type === 'goal').length, result.homeGoals + result.awayGoals);
    assert.ok(result.report.events.some(event => event.type === 'big_chance_missed'));
    assert.ok(result.report.events.some(event => event.type === 'key_pass'));
    assert.ok(result.report.events.some(event => event.type === 'key_save'));
    const substitutions = result.report.events.filter(event => event.type === 'substitution');
    assert.equal(substitutions.length, 2);
    assert.equal(result.report.playerRatings.length, 24);
    assert.equal(new Set(result.report.playerRatings.map(item => item.playerId)).size, 24);
    assert.ok(result.report.playerRatings.every(item => item.rating >= 4 && item.rating <= 10 && item.note));
    assert.ok(result.report.playerRatings.some(item => item.playerId === result.report.playerOfMatch));
    assert.equal(result.report.teamStats.home.possession + result.report.teamStats.away.possession, 100);
    assert.equal(result.report.playerStats.length, 24);
    for (const [side, teamId] of [['home', result.home], ['away', result.away]]) {
      const personal = result.report.playerStats.filter(item => item.teamId === teamId);
      assert.equal(personal.reduce((sum, item) => sum + item.shots, 0), result.report.teamStats[side].shots);
      const passes = personal.reduce((sum, item) => sum + item.passes, 0);
      const completed = personal.reduce((sum, item) => sum + item.passesCompleted, 0);
      assert.equal(Math.round(completed / passes * 100), result.report.teamStats[side].passAccuracy);
      assert.ok(personal.every(item => Number.isInteger(item.shots)
        && Number.isInteger(item.passes)
        && item.passesCompleted <= item.passes
        && item.yellowCards >= 0 && item.yellowCards <= 2
        && item.redCards >= 0 && item.redCards <= 1));
    }
    for (const substitution of substitutions) {
      const outgoing = result.report.playerStats.find(item => item.playerId === substitution.playerId);
      const incoming = result.report.playerStats.find(item => item.playerId === substitution.relatedPlayerId);
      assert.equal(outgoing.minutes, substitution.minute);
      assert.equal(incoming.minutes, 90 - substitution.minute);
      assert.equal(incoming.started, false);
    }
    assert.ok(result.report.events.every((event, index, events) => event.minute >= 1 && event.minute <= 90 && (!index || events[index - 1].minute <= event.minute)));
  }
});

test('AI数据校验失败时整轮不会推进或写入部分统计', async () => {
  const game = completeDraft(createGame('原子校验', '玩家', {seed: 91}));
  const invalidService = createFakeMatchService(matches => {
    matches[1].playerRatings.shift();
    return matches;
  });
  await assert.rejects(playRound(game, invalidService), /球员评分必须完整包含/);
  assert.equal(game.currentRound, 0);
  assert.equal(game.results.length, 0);
  assert.deepEqual(game.scorers, {});
});

test('AI关键事件不足时自动补齐且保持比分一致', async () => {
  const game = completeDraft(createGame('事件修复', '玩家', {seed: 94}));
  const service = createFakeMatchService(matches => {
    matches[0].events = [];
    return matches;
  });
  const [result] = await playRound(game, service);
  const highlights = result.report.events.filter(event => !['goal', 'substitution'].includes(event.type));
  assert.equal(result.report.events.filter(event => event.type === 'goal').length, result.homeGoals + result.awayGoals);
  assert.ok(highlights.length >= 4 && highlights.length <= 9);
  assert.ok(['big_chance_missed', 'key_pass', 'key_save'].every(type => highlights.some(event => event.type === type)));
  assert.ok(result.report.events.some(event => event.generated));
});

test('AI返回的多次合法换人会保留并生成准确出场时间', async () => {
  const game = completeDraft(createGame('换人测试', '玩家', {seed: 95}));
  const home = game.teams.find(team => team.id === game.rounds[0].games[0].home);
  const away = game.teams.find(team => team.id === game.rounds[0].games[0].away);
  const homeStarters = new Set(home.assignments.map(item => item.playerId));
  const awayStarters = new Set(away.assignments.map(item => item.playerId));
  const homeBench = home.squad.filter(id => !homeStarters.has(id));
  const awayBench = away.squad.filter(id => !awayStarters.has(id));
  const service = createFakeMatchService(matches => {
    const match = matches[0];
    const changes = [
      {minute: 58, teamId: home.id, playerId: home.assignments[9].playerId, relatedPlayerId: homeBench[0]},
      {minute: 73, teamId: home.id, playerId: home.assignments[10].playerId, relatedPlayerId: homeBench[1]},
      {minute: 67, teamId: away.id, playerId: away.assignments[9].playerId, relatedPlayerId: awayBench[0]}
    ];
    match.events.push(...changes.map(item => ({...item, type: 'substitution', description: '主动调整进攻方式'})));
    match.playerRatings.push(...changes.map((item, index) => ({
      playerId: item.relatedPlayerId,
      teamId: item.teamId,
      rating: 6.7 + index * 0.1,
      note: '替补登场带来活力'
    })));
    match.teamStats = {
      home: {possession: 57, shots: 15, shotsOnTarget: 7, bigChances: 4, corners: 6, fouls: 9, passAccuracy: 88},
      away: {possession: 43, shots: 8, shotsOnTarget: 3, bigChances: 2, corners: 2, fouls: 14, passAccuracy: 79}
    };
    return matches;
  });
  const [result] = await playRound(game, service);
  const substitutions = result.report.events.filter(event => event.type === 'substitution');
  assert.equal(substitutions.length, 3);
  assert.equal(result.report.playerRatings.length, 25);
  assert.deepEqual(result.report.teamStats.home, {possession: 57, shots: 15, shotsOnTarget: 7, bigChances: 4, corners: 6, fouls: 9, passAccuracy: 88});
  for (const event of substitutions) {
    const outgoing = result.report.playerStats.find(item => item.playerId === event.playerId);
    const incoming = result.report.playerStats.find(item => item.playerId === event.relatedPlayerId);
    assert.equal(outgoing.minutes, event.minute);
    assert.equal(incoming.minutes, 90 - event.minute);
  }
});

test('AI指定的全场最佳不是最高分时自动校正', async () => {
  const game = completeDraft(createGame('最佳球员校正', '玩家', {seed: 93}));
  const service = createFakeMatchService(matches => {
    matches[0].playerOfMatch = matches[0].playerRatings.find(item => item.rating < 8)?.playerId;
    return matches;
  });
  const [result] = await playRound(game, service);
  const maximum = Math.max(...result.report.playerRatings.map(item => item.rating));
  const selected = result.report.playerRatings.find(item => item.playerId === result.report.playerOfMatch);
  assert.equal(selected.rating, maximum);
});

test('旧比赛自动补齐战报且不改变后续随机状态', async () => {
  const game = completeDraft(createGame('旧战报', '玩家', {seed: 89}));
  await playRound(game, createFakeMatchService());
  const result = game.results[0];
  delete result.report;
  delete result.lineups;
  result.scorers.forEach(scorer => { delete scorer.minute; });
  const rngState = game.rngState;
  migrateGame(game);
  assert.equal(game.rngState, rngState);
  assert.equal(result.report.playerRatings.length, 22);
  assert.equal(result.report.events.length, result.homeGoals + result.awayGoals);
  assert.ok(result.report.playerStats.every(item => Number.isInteger(item.shots)
    && item.passes === 0 && item.passesCompleted === 0
    && item.yellowCards === 0 && item.redCards === 0));
});

test('DeepSeek V4 Flash服务按两场一批并行调用JSON接口', async () => {
  const game = completeDraft(createGame('AI比赛', '玩家', {seed: 90}));
  const requests = [];
  const service = createDeepSeekMatchService({
    enabled: true,
    apiKey: 'test-key',
    fetchImpl: async (url, options) => {
      requests.push({url, options});
      return {
        ok: true,
        json: async () => ({
          choices: [{message: {content: JSON.stringify({matches: [{}, {}]})}}]
        })
      };
    }
  });
  const matches = await service.simulateRound(game, game.rounds[0]);
  assert.equal(requests.length, 5);
  assert.equal(matches.length, 10);
  for (const request of requests) {
    const body = JSON.parse(request.options.body);
    assert.equal(request.url, DEEPSEEK_API_URL);
    assert.equal(request.options.headers.authorization, 'Bearer test-key');
    assert.equal(body.model, 'deepseek-v4-flash');
    assert.equal(body.response_format.type, 'json_object');
    assert.equal(body.thinking.type, 'disabled');
    assert.equal(body.max_tokens, 12_000);
    assert.ok(body.messages[0].content.includes('浪费'));
    assert.ok(body.messages[0].content.includes('substitution'));
    assert.ok(body.messages[0].content.includes('teamStats'));
    assert.ok(body.messages[0].content.includes('passesCompleted'));
    assert.ok(body.messages[0].content.includes('yellowCards'));
    assert.ok(body.messages[0].content.includes('assignedFamiliarity'));
    assert.ok(body.messages[0].content.includes('身高体重'));
    assert.ok(body.messages[1].content.includes('"bench"'));
    assert.ok(body.messages[1].content.includes('"heightCm"'));
    assert.ok(body.messages[1].content.includes('"assignedFamiliarity"'));
  }
});

test('DeepSeek分批超时会指出失败批次', async () => {
  const game = completeDraft(createGame('超时测试', '玩家', {seed: 92}));
  let calls = 0;
  const service = createDeepSeekMatchService({
    enabled: true,
    apiKey: 'test-key',
    batchSize: 5,
    timeoutMs: 1_000,
    fetchImpl: async () => {
      calls++;
      if (calls === 1) {
        const error = new Error('The operation was aborted due to timeout');
        error.name = 'TimeoutError';
        throw error;
      }
      return {ok: true, json: async () => ({choices: [{message: {content: JSON.stringify({matches: [{}, {}, {}, {}, {}]})}}]})};
    }
  });
  await assert.rejects(service.simulateRound(game, game.rounds[0]), /第 1 批 DeepSeek 请求超过 1 秒/);
});

test('战术校验并完成动态轮数联赛', async () => {
  const game = completeDraft(createGame('测试', '玩家', {seed: 2}));
  const team = game.teams[0];
  setLineup(game, team, team.formation, '积极', team.assignments);
  assert.equal(team.mentality, '积极');
  while (game.phase === 'season') await playRound(game, createFakeMatchService());
  const state = publicGame(game);
  assert.equal(game.results.length, 380);
  assert.equal(state.table.reduce((sum, row) => sum + row.p, 0), 760);
  assert.equal(state.table[0].p, game.rounds.length);
  assert.ok(state.topScorers.length > 0);
});

test('自定义阵型可保存自由坐标并继续参与职责与比赛计算', async () => {
  const game = completeDraft(createGame('自由阵型', '玩家', {seed: 211}));
  const team = game.teams[0];
  const coordinates = [
    [50, 8], [12, 25], [34, 24], [66, 24], [88, 35],
    [28, 49], [52, 60], [82, 67], [18, 79], [48, 83], [70, 90]
  ].map(([x, y]) => ({x, y}));
  const slots = normalizeCustomFormation(coordinates, game.rules.starters);
  const previous = [...team.assignments];
  const assignments = slots.map((slot, index) => ({
    slotId: slot.id,
    playerId: previous[index].playerId,
    inRole: game.rules.inRoles[slot.group][0],
    outRole: game.rules.outRoles[slot.group][0]
  }));
  setLineup(game, team, '自定义', '进攻', assignments, coordinates);
  assert.equal(team.formation, '自定义');
  assert.equal(team.customFormation.length, 11);
  assert.equal(team.customFormation[0].group, 'GK');
  assert.ok(team.customFormation.some(slot => slot.group === 'W'));
  assert.ok(team.customFormation.every(slot => slot.x >= 6 && slot.x <= 94 && slot.y >= 8 && slot.y <= 92));
  assert.equal(publicGame(game).teams[0].customFormation[9].x, 48);
  await playRound(game, createFakeMatchService());
  assert.equal(game.currentRound, 1);
  await assert.rejects(async () => normalizeCustomFormation(coordinates.slice(0, 10), 11), /必须包含 11 个位置/);
});

test('规则按房间快照保存而不是引用全局配置', () => {
  const game = createGame('测试', '玩家');
  assert.equal(game.rules.homeAdvantage, cfg.HOME_ADVANTAGE);
  assert.notEqual(game.rules.formations, cfg.FORMATIONS);
  cfg.FORMATIONS.__probe = [];
  assert.equal(game.rules.formations.__probe, undefined);
  delete cfg.FORMATIONS.__probe;
});

test('旧版8人存档可迁移，未开始的旧赛程会升级', () => {
  const game = createGame('旧档', '玩家');
  game.phase = 'season';
  game.draft.complete = true;
  game.draft.pick = 160;
  delete game.rules;
  delete game.scheduleVersion;
  game.teams.forEach((team, index) => {
    team.squad = game.players.slice(index * 8, index * 8 + 8).map(player => player.id);
    team.formation = '1-2-1';
    delete team.assignments;
    team.starters = team.squad.slice(0, 5);
  });
  publicGame(game);
  assert.equal(game.schemaVersion, 2);
  assert.equal(game.scheduleVersion, 2);
  assert.ok(game.teams.every(team => team.squad.length === 18 && team.assignments.length === 11 && team.formation === '4-3-3 DM'));
});

test('进行中的旧赛季保留已赛轮次并重新平衡剩余赛程', () => {
  const game = createGame('旧档', '玩家');
  const playedRound = JSON.parse(JSON.stringify(game.rounds[0]));
  const fixtureKeys = game.rounds.flatMap(round => round.games).map(fixture => `${fixture.home}-${fixture.away}`).sort();
  delete game.scheduleVersion;
  game.currentRound = 1;
  game.results.push({round: 1, home: 't1', away: 't2', homeGoals: 1, awayGoals: 0, scorers: []});
  migrateGame(game);
  assert.equal(game.scheduleVersion, 2);
  assert.deepEqual(game.rounds[0], playedRound);
  assert.deepEqual(game.rounds.flatMap(round => round.games).map(fixture => `${fixture.home}-${fixture.away}`).sort(), fixtureKeys);
  const firstLegHomeCounts = game.teams.map(team => game.rounds.slice(0, 19).flatMap(round => round.games).filter(fixture => fixture.home === team.id).length);
  assert.ok(firstLegHomeCounts.every(count => count === 9 || count === 10));
});

test('存档排除静态球员库并使用备份恢复', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lfm-store-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const file = path.join(directory, 'games.json');
  const store = createGameStore(file);
  const first = createGame('第一档', '玩家', {id: 'SAVE01'});
  const games = {[first.id]: first};
  assert.equal(persistentGame(first).players, undefined);
  store.save(games);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).SAVE01.players, undefined);
  games.SAVE02 = createGame('第二档', '玩家', {id: 'SAVE02'});
  store.save(games);
  fs.writeFileSync(file, '{损坏', 'utf8');
  const recovered = store.load();
  assert.ok(recovered.SAVE01);
  assert.equal(recovered.SAVE02, undefined);
  assert.equal(recovered.SAVE01.players.length, 360);
});

test('API严格区分GET查询与POST操作', async () => {
  const games = {};
  let saves = 0;
  const handler = createRequestHandler({games, save: () => { saves++; }, publicDirectory: path.join(__dirname, '..', 'public')});
  const created = await callHandler(handler, 'POST', '/api/games', {name: '接口测试', host: '房主'});
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.equal(saves, 1);
  const fetched = await callHandler(handler, 'GET', `/api/games/${id}`);
  assert.equal(fetched.status, 200);
  const illegalMutation = await callHandler(handler, 'GET', `/api/games/${id}/start-draft`);
  assert.equal(illegalMutation.status, 405);
  assert.equal(games[id].phase, 'lobby');
  const wrongNamespace = await callHandler(handler, 'GET', `/api/anything/${id}`);
  assert.equal(wrongNamespace.status, 404);
  const started = await callHandler(handler, 'POST', `/api/games/${id}/start-draft`, {});
  assert.equal(started.status, 200);
  assert.equal(games[id].phase, 'draft');
  assert.equal(saves, 2);
});

test('真人玩家可选择未被占用的球队加入房间', async () => {
  const games = {};
  const handler = createRequestHandler({games, save: () => {}, publicDirectory: path.join(__dirname, '..', 'public')});
  const created = await callHandler(handler, 'POST', '/api/games', {name: '选队房间', host: '房主', teamId: 't8'});
  const id = created.body.id;
  assert.equal(games[id].teams.find(team => team.id === 't8').controller, 'human');
  const joined = await callHandler(handler, 'POST', `/api/games/${id}/join`, {manager: '第二玩家', teamId: 't3'});
  assert.equal(joined.status, 200);
  assert.equal(games[id].teams.find(team => team.id === 't3').manager, '第二玩家');
  const occupied = await callHandler(handler, 'POST', `/api/games/${id}/join`, {manager: '第三玩家', teamId: 't3'});
  assert.equal(occupied.status, 400);
  assert.match(occupied.body.error, /不可用/);
});

test('删除房间必须使用DELETE并准确确认房间码', async () => {
  const games = {};
  let saves = 0;
  const handler = createRequestHandler({games, save: () => { saves++; }, publicDirectory: path.join(__dirname, '..', 'public')});
  const created = await callHandler(handler, 'POST', '/api/games', {name: '待删除房间', host: '房主'});
  const id = created.body.id;
  const wrongConfirmation = await callHandler(handler, 'DELETE', `/api/games/${id}`, {confirmCode: 'WRONG1'});
  assert.equal(wrongConfirmation.status, 400);
  assert.ok(games[id]);
  assert.equal(saves, 1);
  const deleted = await callHandler(handler, 'DELETE', `/api/games/${id}`, {confirmCode: id.toLowerCase()});
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body, {deleted: true, id});
  assert.equal(games[id], undefined);
  assert.equal(saves, 2);
});

test('未配置DeepSeek密钥时API拒绝模拟且不推进轮次', async () => {
  const game = completeDraft(createGame('缺少密钥', '玩家', {id: 'NOKEY1'}));
  const games = {[game.id]: game};
  let saves = 0;
  const handler = createRequestHandler({games, save: () => { saves++; }, publicDirectory: path.join(__dirname, '..', 'public')});
  const response = await callHandler(handler, 'POST', `/api/games/${game.id}/play-round`, {});
  assert.equal(response.status, 400);
  assert.match(response.body.error, /DEEPSEEK_API_KEY/);
  assert.equal(game.currentRound, 0);
  assert.equal(game.results.length, 0);
  assert.equal(saves, 0);
});

test('API可以完成选秀、自动排阵和整季模拟', async () => {
  const games = {};
  const handler = createRequestHandler({games, save: () => {}, publicDirectory: path.join(__dirname, '..', 'public'), matchService: createFakeMatchService()});
  const created = await callHandler(handler, 'POST', '/api/games', {name: '完整流程', host: '房主'});
  const id = created.body.id;
  await callHandler(handler, 'POST', `/api/games/${id}/start-draft`, {});

  while (!games[id].draft.complete) {
    const state = publicGame(games[id]);
    const picked = await callHandler(handler, 'POST', `/api/games/${id}/pick`, {
      teamId: state.currentDraftTeam,
      playerId: state.availablePlayers[0].id
    });
    assert.equal(picked.status, 200);
  }

  const customFormation = [
    [50, 8], [12, 25], [34, 24], [66, 24], [88, 25],
    [25, 49], [50, 55], [75, 49], [15, 78], [50, 86], [85, 78]
  ].map(([x, y]) => ({x, y}));
  const customLineup = await callHandler(handler, 'POST', `/api/games/${id}/lineup`, {
    teamId: 't1',
    auto: true,
    formation: '自定义',
    customFormation,
    mentality: '平衡'
  });
  assert.equal(customLineup.status, 200);
  assert.equal(games[id].teams[0].formation, '自定义');
  assert.equal(games[id].teams[0].customFormation.length, 11);

  const lineup = await callHandler(handler, 'POST', `/api/games/${id}/lineup`, {
    teamId: 't1',
    auto: true,
    formation: '4-4-2',
    mentality: '积极'
  });
  assert.equal(lineup.status, 200);
  assert.equal(games[id].teams[0].formation, '4-4-2');
  const round = await callHandler(handler, 'POST', `/api/games/${id}/play-round`, {});
  assert.equal(round.body.currentRound, 1);
  assert.equal(round.body.results[0].report.source, 'deepseek');
  assert.ok(round.body.results[0].report.events.some(event => event.type === 'key_save'));
  const finished = await callHandler(handler, 'POST', `/api/games/${id}/play-all`, {});
  assert.equal(finished.body.phase, 'finished');
  assert.equal(finished.body.results.length, 380);
});
