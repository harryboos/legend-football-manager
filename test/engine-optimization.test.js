const test = require('node:test');
const assert = require('node:assert/strict');
const {createGame} = require('../src/game');
const {autoLineup, setLineup} = require('../src/lineup');
const {aiChoice} = require('../src/draft');
const {positionFit, roleScore} = require('../src/players');
const {formationSlots} = require('../src/rules');
const {
  statusFor, ensurePlayerStatuses, settleRoundStatuses, snapshotUnavailable, rebuildPlayerStatuses
} = require('../src/season');

test('读取单个球员状态不扫描其他球员，并保留现有状态引用', () => {
  const game = {players: [{id: 'p1'}, {id: 'p2'}], playerStatuses: {
    p1: {yellowCards: '2.4', suspensionMatches: -1, injuryMatches: 2, injury: '拉伤'}
  }};
  Object.defineProperty(game.playerStatuses, 'p2', {get() { throw new Error('不应读取其他球员'); }, configurable: true});
  const status = statusFor(game, 'p1');
  assert.deepEqual(status, {yellowCards: 2, suspensionMatches: 0, injuryMatches: 2, injury: '拉伤'});
  assert.equal(statusFor(game, 'p1'), status);
  delete game.playerStatuses.p2;
  ensurePlayerStatuses(game);
  statusFor(game, 'p2').yellowCards = 3;
  status.yellowCards++;
  assert.equal(statusFor(game, 'p1').yellowCards, 3);
  assert.equal(statusFor(game, 'p2').yellowCards, 3);
});

test('非有限状态和红黄牌数据不会产生无限停赛或阻塞结算', () => {
  const game = {players: [{id: 'p1'}], playerStatuses: {
    p1: {yellowCards: Infinity, suspensionMatches: NaN, injuryMatches: -Infinity, injury: '旧伤'}
  }};
  assert.deepEqual(statusFor(game, 'p1'), {yellowCards: 0, suspensionMatches: 0, injuryMatches: 0, injury: null});
  settleRoundStatuses(game, [{report: {events: [], playerStats: [
    {playerId: 'p1', yellowCards: Infinity, redCards: Infinity}
  ]}}], {});
  assert.equal(statusFor(game, 'p1').suspensionMatches, 0);
});

test('现有伤病事件只保留一次，并按替补上场时刻计算出场分钟', () => {
  const game = {seed: 2, players: [{id: 'p1'}, {id: 'p2'}]};
  const injury = {type: 'injury', minute: 70, playerId: 'p2', teamId: 't1', injury: '腿筋拉伤', recoveryMatches: 3};
  const result = {round: 1, home: 't1', away: 't2', report: {
    events: [{type: 'substitution', minute: 60, playerId: 'p1', relatedPlayerId: 'p2'}, injury],
    playerStats: [{playerId: 'p2', teamId: 't1', started: false, minutes: 30}]
  }};
  settleRoundStatuses(game, [result], snapshotUnavailable(game));
  assert.deepEqual(result.report.events.filter(event => event.type === 'injury'), [injury]);
  assert.equal(result.report.playerStats[0].minutes, 10);
  assert.equal(statusFor(game, 'p2').injuryMatches, 3);
});

test('自动生成的伤病沿用固定种子的分钟和恢复轮数', () => {
  const game = {seed: 2, players: [{id: 'p1'}]};
  const result = {round: 1, home: 't1', away: 't2', report: {
    events: [], playerStats: [{playerId: 'p1', teamId: 't1', started: true, minutes: 90}]
  }};
  settleRoundStatuses(game, [result], {});
  assert.equal(result.report.events.length, 1);
  assert.equal(result.report.events[0].minute, 76);
  assert.equal(result.report.events[0].recoveryMatches, 3);
  assert.equal(result.report.playerStats[0].minutes, 76);
});

test('实时轮次结算与历史重建的伤病和累计停赛一致', () => {
  const game = {seed: 1, players: [{id: 'p1'}, {id: 'p2'}, {id: 'p3'}], results: []};
  const rounds = [
    {round: 1, report: {events: [{type: 'injury', playerId: 'p2', minute: 45, recoveryMatches: 3, injury: '拉伤'}],
      playerStats: [{playerId: 'p1', yellowCards: 4}, {playerId: 'p3', redCards: 1}]}},
    {round: 2, report: {events: [], playerStats: [{playerId: 'p1', yellowCards: 1}]}},
    {round: 3, report: {events: [], playerStats: [{playerId: 'p3', yellowCards: 1}]}}
  ];
  for (const result of rounds) {
    settleRoundStatuses(game, [result], snapshotUnavailable(game));
    game.results.push(result);
    const replay = structuredClone(game);
    assert.deepEqual(rebuildPlayerStatuses(replay), game.playerStatuses);
  }
  assert.equal(statusFor(game, 'p1').yellowCards, 0);
  assert.equal(statusFor(game, 'p1').suspensionMatches, 0);
  assert.equal(statusFor(game, 'p2').injuryMatches, 1);
});

test('自动排阵保持已知种子的首发、位置和职责顺序', () => {
  const game = createGame('排阵回归', '玩家', {seed: 7788});
  const team = game.teams[0];
  team.squad = game.players.slice(0, 18).map(player => player.id);
  autoLineup(game, team, game.players);
  assert.deepEqual(team.assignments.map(({slotId, playerId, inRole, outRole}) => [slotId, playerId, inRole, outRole]), [
    ['GK', 'p6', '门线门将', '门线保护'],
    ['LWB', 'p3', '组织型边后卫', '防守边卫'],
    ['LCB', 'p1', '前压中卫', '前压中卫'],
    ['CB', 'p4', '前压中卫', '前压中卫'],
    ['RCB', 'p5', '前压中卫', '前压中卫'],
    ['RWB', 'p7', '边后卫', '压迫边卫'],
    ['LM', 'p2', '边锋', '高位逼抢'],
    ['LCM', 'p8', '中场组织核心', '高位逼抢'],
    ['RCM', 'p10', '肋部中场', '高位逼抢'],
    ['RM', 'p12', '宽位前锋', '高位逼抢'],
    ['ST', 'p9', '穿插前锋', '封堵出球']
  ]);
});

test('自动排阵得到全局最高评分，并跳过伤停球员', () => {
  const game = createGame('最优阵容', '玩家', {seed: 7788});
  const team = game.teams[0];
  game.rules.starters = 3;
  game.rules.formations = {测试: [['GK', '门将', 'GK'], ['LST', '左前锋', 'ST'], ['RST', '右前锋', 'ST']]};
  team.formation = '测试';
  const selected = ['贝利', '罗纳尔多', '盖德·穆勒', '雅辛', '诺伊尔'].map(name => game.players.find(player => player.name === name));
  assert.ok(selected.every(Boolean));
  team.squad = selected.map(player => player.id);
  statusFor(game, selected[0].id).injuryMatches = 2;
  const available = selected.slice(1);
  const slots = formationSlots(game, team.formation);
  const score = (player, slot) => positionFit(player, slot) * 36 + player.rating / 12
    + Math.max(...game.rules.inRoles[slot.group].map(role => roleScore(player, role, slot.group))) * 0.85
    + Math.max(...game.rules.outRoles[slot.group].map(role => roleScore(player, role, slot.group))) * 0.65;
  let maximum = -Infinity;
  for (const first of available) for (const second of available) for (const third of available) {
    if (new Set([first, second, third]).size === 3) {
      maximum = Math.max(maximum, score(first, slots[0]) + score(second, slots[1]) + score(third, slots[2]));
    }
  }
  autoLineup(game, team, game.players);
  assert.equal(new Set(team.starters).size, 3);
  assert.ok(!team.starters.includes(selected[0].id));
  const actual = team.assignments.reduce((total, assignment, index) => total
    + score(game.players.find(player => player.id === assignment.playerId), slots[index]), 0);
  assert.ok(Math.abs(actual - maximum) < 1e-10);
});

test('自动排阵同分时保留队内顺序且每位球员只使用一次', () => {
  const game = createGame('同分排阵', '玩家', {seed: 1});
  game.players = Array.from({length: 4}, (_, index) => ({...game.players[0], id: `equal${index}`}));
  game.rules.starters = 3;
  game.rules.formations = {测试: [['A', '前锋一', 'ST'], ['B', '前锋二', 'ST'], ['C', '前锋三', 'ST']]};
  const team = game.teams[0];
  team.formation = '测试';
  team.squad = game.players.map(player => player.id);
  autoLineup(game, team, game.players);
  assert.deepEqual(team.starters, ['equal0', 'equal1', 'equal2']);
});

test('AI 连续选秀会重新计算球队需要，并保持既有确定性选人顺序', () => {
  const game = createGame('选秀回归', '玩家', {seed: 7788});
  const team = game.teams[0];
  const picks = [];
  for (let index = 0; index < game.rules.squadSize; index++) {
    const player = aiChoice(game, team);
    picks.push(player.id);
    team.squad.push(player.id);
  }
  assert.deepEqual(picks, ['p55', 'p318', 'p1', 'p28', 'p161', 'p125', 'p319', 'p265', 'p25',
    'p56', 'p104', 'p164', 'p234', 'p2', 'p26', 'p141', 'p103', 'p67']);
});

test('无效的阵容条目返回阵容校验错误', () => {
  const game = createGame('阵容校验', '玩家', {seed: 1});
  const team = game.teams[0];
  assert.throws(() => setLineup(game, team, team.formation, team.mentality, Array(11).fill(null)), /请选择|请为/);
});
