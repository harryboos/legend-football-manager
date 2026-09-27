const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

function element() {
  const classes = new Set();
  const listeners = new Map();
  return {
    value: '', textContent: '', innerHTML: '', disabled: false, style: {},
    classList: {
      add: value => classes.add(value),
      remove: value => classes.delete(value),
      contains: value => classes.has(value),
      toggle(value, force) {
        if (force ?? !classes.has(value)) classes.add(value);
        else classes.delete(value);
      }
    },
    focus() {},
    querySelector: () => element(),
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: (name, callback) => {
      if (listeners.get(name) === callback) listeners.delete(name);
    },
    listeners
  };
}
function response(payload, status = 200) {
  return {ok: status >= 200 && status < 300, status, json: async () => payload};
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}
async function flush() {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}
async function browser() {
  const elements = new Map();
  const timers = new Map();
  const listeners = new Map();
  const stored = new Map();
  let nextTimer = 0;
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
    querySelectorAll: () => [],
    addEventListener: (name, callback) => listeners.set(name, callback)
  };
  const context = vm.createContext({
    document, URLSearchParams, AbortController,
    location: {search: '', reload() {}},
    localStorage: {
      getItem: key => stored.get(key) || null,
      setItem: (key, value) => stored.set(key, value),
      removeItem: key => stored.delete(key)
    },
    fetch: async () => response({configured: false}),
    setTimeout(callback) {
      const id = ++nextTimer;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: id => timers.delete(id)
  });
  const run = code => vm.runInContext(code, context);
  run(appSource);
  await flush();
  return {
    context, run, elements, timers, listeners, document, stored,
    async tick(id) {
      const callback = timers.get(id);
      assert.ok(callback, 'expected a scheduled timer');
      timers.delete(id);
      callback();
      await flush();
    }
  };
}

test('前端 API 保留并发版本和非 JSON 错误状态，支持中止信号', async () => {
  const page = await browser();
  const calls = [];
  page.context.fetch = async (url, options) => {
    calls.push({url, options});
    return response({ok: true});
  };
  page.run("G = {id: 'ABC123', revision: 7}");
  await page.run("api('/games/ABC123/lineup', 'POST', {teamId: 't1'})");
  assert.equal(calls[0].options.headers['x-game-version'], '7');
  assert.equal(calls[0].options.body, '{"teamId":"t1"}');
  page.run("pendingJoinCode = 'DEF456'; pendingJoinRevision = 3");
  await page.run("api('/games/DEF456/join', 'POST', {})");
  assert.equal(calls[1].options.headers['x-game-version'], '3');
  const controller = new AbortController();
  page.context.signal = controller.signal;
  await page.run("api('/games/ABC123', 'GET', undefined, {signal})");
  assert.equal(calls[2].options.signal, controller.signal);
  assert.equal(calls[2].options.body, undefined);

  page.context.fetch = async () => ({ok: false, status: 409, json: async () => { throw new SyntaxError('Unexpected token <'); }});
  await assert.rejects(page.run("api('/games/ABC123')"), error => error.status === 409 && error.message.includes('409'));
  page.context.fetch = async () => response(null, 503);
  await assert.rejects(page.run("api('/games/ABC123')"), error => error.status === 503 && error.message.includes('503'));
});

test('模拟轮询串行执行，最终响应之后到达的旧进度不会覆盖比赛结果', async () => {
  const page = await browser();
  const action = deferred();
  const polls = [];
  page.run("G = {id: 'ABC123', revision: 1}; render = () => {}; tab = 'fixtures'");
  page.context.fetch = (url, options) => {
    if (options.method === 'POST') return action.promise;
    const pending = deferred();
    polls.push({...pending, signal: options.signal});
    return pending.promise;
  };
  const request = page.run("act('/play-round')");
  await page.tick(page.run('progressTimer'));
  assert.equal(polls.length, 1);
  assert.equal(page.timers.size, 0, 'a slow poll must not schedule overlapping requests');
  polls[0].resolve(response({id: 'ABC123', revision: 1, simulation: {status: 'running', completedMatches: 2}}));
  await flush();
  assert.equal(page.run('G.simulation.completedMatches'), 2);
  assert.equal(page.timers.size, 1);
  await page.tick(page.run('progressTimer'));
  assert.equal(polls.length, 2);
  action.resolve(response({id: 'ABC123', revision: 2, currentRound: 1}));
  await request;
  assert.equal(polls[1].signal.aborted, true);
  polls[1].resolve(response({id: 'ABC123', revision: 1, simulation: {status: 'running', completedMatches: 5}}));
  await flush();
  assert.equal(page.run('G.revision'), 2);
  assert.equal(page.run('G.currentRound'), 1);
  assert.equal(page.run('G.simulation'), undefined);
  assert.equal(page.run('busy'), false);
  assert.equal(page.timers.size, 0);
});

test('进度刷新保留战术页未保存控件，版本冲突后刷新房间', async () => {
  const page = await browser();
  page.run("G = {id: 'ABC123', revision: 1}; tab = 'squad'; busy = true; let renderCount = 0; render = () => { renderCount++; }");
  page.context.fetch = async () => response({id: 'ABC123', revision: 1, simulation: {status: 'running'}});
  page.run("startProgressPolling('ABC123')");
  await page.tick(page.run('progressTimer'));
  assert.equal(page.run('renderCount'), 0);
  page.run('stopProgressPolling(); busy = false');
  page.context.fetch = async (url, options) => options.method === 'POST'
    ? response({error: '房间数据已经更新'}, 409)
    : response({id: 'ABC123', revision: 4});
  await page.run("act('/lineup', {})");
  assert.equal(page.run('G.revision'), 4);
  assert.equal(page.run('busy'), false);
  assert.equal(page.document.getElementById('toast').textContent, '房间数据已经更新');
});

test('重复创建房间只提交一次，禁用本地存储不会阻止进入房间', async () => {
  const page = await browser();
  const pending = deferred();
  let requests = 0;
  page.run('render = () => {}');
  page.context.localStorage = {getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); }};
  page.context.fetch = () => { requests++; return pending.promise; };
  const first = page.run('createGame()');
  await page.run('createGame()');
  assert.equal(requests, 1);
  pending.resolve(response({id: 'ABC123', revision: 0}));
  await first;
  assert.equal(page.run('G.id'), 'ABC123');
  assert.equal(page.run('entryBusy'), false);
  assert.equal(page.run('savedGameId()'), '');
  assert.equal(page.document.getElementById('app').classList.contains('hidden'), false);
});

test('球员与赛季查询随快照更新，选秀缓存保持排序且支持姓名规范化', async () => {
  const page = await browser();
  page.run(`G = {
    teams: [{id: 't1', name: '北京'}],
    players: [{id: 'p1', name: '旧名称'}],
    seasonPlayerStats: [{playerId: 'p1', goals: 1}],
    results: [{round: 1, home: 't1', homeGoals: 2}],
    availablePlayers: [
      {id: 'p2', name: 'Lionel Messi', rating: 99, positions: ['RW']},
      {id: 'p1', name: '罗纳尔多', rating: 98, positions: ['ST']}
    ]
  }`);
  assert.equal(page.run("player('p1').name"), '旧名称');
  assert.equal(page.run("seasonRow('p1').goals"), 1);
  assert.equal(page.run("matchResult(1, 't1').homeGoals"), 2);
  page.run("draftSearch = 'lionel·messi'");
  assert.equal(page.run("filteredDraftPlayers().map(player => player.id).join()"), 'p2');
  page.run("draftSearch = ''; draftFilter = 'ST'");
  assert.equal(page.run("filteredDraftPlayers().map(player => player.id).join()"), 'p1');
  page.run("G = {...G, players: [{id: 'p1', name: '新名称'}], seasonPlayerStats: [{playerId: 'p1', goals: 2}], availablePlayers: []}");
  assert.equal(page.run("player('p1').name"), '新名称');
  assert.equal(page.run("seasonRow('p1').goals"), 2);
  assert.equal(page.run('filteredDraftPlayers().length'), 0);
});

test('后发提示不会被前一次提示的定时器提前隐藏', async () => {
  const page = await browser();
  page.run("toast('第一条')");
  const previousTimer = page.run('toastTimer');
  page.run("toast('第二条')");
  assert.equal(page.timers.has(previousTimer), false);
  assert.equal(page.document.getElementById('toast').textContent, '第二条');
  assert.equal(page.document.getElementById('toast').classList.contains('show'), true);
  await page.tick(page.run('toastTimer'));
  assert.equal(page.document.getElementById('toast').classList.contains('show'), false);
});

test('取消阵型拖动只清理监听，不会把球员移到取消事件的坐标', async () => {
  const page = await browser();
  const node = element();
  let captured = false;
  node.setPointerCapture = () => { captured = true; };
  node.hasPointerCapture = () => captured;
  node.releasePointerCapture = () => { captured = false; };
  page.context.dragEvent = {currentTarget: node, pointerId: 1, preventDefault() {}};
  page.run("let moves = 0; moveFormationNode = () => { moves++; }; formationEditor = {}; startFormationDrag(dragEvent, 'C01')");
  node.listeners.get('pointermove')({pointerId: 2});
  assert.equal(page.run('moves'), 0);
  node.listeners.get('pointermove')({pointerId: 1});
  node.listeners.get('pointercancel')({pointerId: 1, clientX: 0, clientY: 0});
  assert.equal(page.run('moves'), 1);
  assert.equal(node.listeners.size, 0);
  assert.equal(captured, false);
  page.run('closeModal()');
  assert.equal(page.run('formationEditor'), null);
});

test('球队情报与积分榜将存档中的球员、球队及职责作为文字显示', async () => {
  const page = await browser();
  page.run(`G = {
    teams: [{id: 't1', name: '<img src=x onerror=alert(1)>', manager: '<管理员>', controller: 'human', formation: '4-4-2', mentality: '平衡', squad: ['p1'], starters: [], assignments: []}],
    players: [{id: 'p1', name: '<球员>', position: 'ST', positions: ['ST'], rating: 90}],
    config: {formations: {'4-4-2': []}, positionLabels: {ST: '<前锋>'}},
    table: [{name: '<球队>', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, gd: 0, pts: 0}],
    currentRound: 0
  }`);
  const card = page.run("scoutCard(team('t1'))");
  assert.ok(card.includes('&lt;球员&gt;'));
  assert.ok(card.includes('&lt;前锋&gt;'));
  assert.equal(card.includes('<img'), false);
  assert.ok(page.run('views.table()').includes('&lt;球队&gt;'));
});


test('真实房间在大厅、选秀和赛季阶段可渲染全部页面并重置自由阵型', async () => {
  const {createGame, runAiDraft, publicGame} = require('../src/game');
  const game = createGame('前端回归房间', '主教练', {seed: 619});
  const page = await browser();
  const verifyViews = () => {
    page.context.snapshot = {...publicGame(game), session: {teamId: 't1', role: 'host'}};
    page.run('G = snapshot');
    for (const view of ['lobby', 'draft', 'squad', 'clubs', 'fixtures', 'table', 'stats']) {
      const html = page.run(`views.${view}()`);
      assert.equal(typeof html, 'string');
      assert.ok(html.length > 0, `${view} should render`);
    }
  };
  verifyViews();
  game.phase = 'draft';
  verifyViews();
  game.teams.forEach(team => { team.controller = 'AI'; });
  runAiDraft(game);
  game.teams[0].controller = 'human';
  verifyViews();
  page.run("openFormationEditor('t1'); resetFormationEditor()");
  assert.equal(page.run('formationEditor.slots.length'), game.rules.starters);
  assert.equal(page.run('formationEditor.slots[0].group'), 'GK');
  page.run('closeModal()');
  assert.equal(page.run('formationEditor'), null);
});


test('模拟失败后获取最终状态，同版本错误与已完成轮次都会展示', async () => {
  const page = await browser();
  page.run("G = {id: 'ABC123', revision: 3, currentRound: 1, simulation: {status: 'running'}}; render = () => {}");
  let refreshes = 0;
  page.context.fetch = async (url, options) => {
    if (options.method === 'POST') return response({error: '比赛引擎暂时不可用'}, 502);
    refreshes++;
    return response({id: 'ABC123', revision: 3, currentRound: 2, simulation: {status: 'error', error: '比赛引擎暂时不可用'}});
  };
  await page.run("act('/play-all')");
  assert.equal(refreshes, 1);
  assert.equal(page.run('G.currentRound'), 2);
  assert.equal(page.run('G.simulation.status'), 'error');
  assert.equal(page.run('busy'), false);
  assert.equal(page.run('progressTimer'), null);
  assert.equal(page.document.getElementById('toast').textContent, '比赛引擎暂时不可用');
});
