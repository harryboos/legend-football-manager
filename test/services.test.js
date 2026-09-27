const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {createGame} = require('../src/game');
const {createGameStore} = require('../src/storage');
const {createAuthService} = require('../src/auth');
const {createSiteGate} = require('../src/site-gate');
const {createDeepSeekMatchService} = require('../src/match-ai');

function temporaryFile(t, name = 'games.json') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lfm-services-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  return path.join(directory, name);
}

function savedGame(name = '初始存档') {
  return {SAVE01: createGame(name, '玩家', {id: 'SAVE01', seed: 97})};
}

function matchResponse(body) {
  const facts = JSON.parse(JSON.parse(body).messages[1].content);
  const matches = facts.f.map(fixture => ({h: fixture.h.i, a: fixture.a.i, g: [0, 0], e: [], r: []}));
  return {ok: true, json: async () => ({choices: [{message: {content: JSON.stringify({matches})}}]})};
}

test('主存档缺失时仍然恢复备份', t => {
  const file = temporaryFile(t);
  const store = createGameStore(file);
  store.save(savedGame('有效备份'));
  store.save(savedGame('当前存档'));
  fs.unlinkSync(file);
  assert.equal(createGameStore(file).load().SAVE01.name, '有效备份');
});

test('合法 JSON 中的无效存档也回退备份，恢复后保存不会破坏备份', t => {
  const file = temporaryFile(t);
  const store = createGameStore(file);
  store.save(savedGame('已验证'));
  store.save(savedGame('下一版'));
  for (const invalid of [null, [], {SAVE01: {id: 'SAVE01', teams: []}}]) {
    fs.writeFileSync(file, JSON.stringify(invalid));
    const recoveredStore = createGameStore(file);
    const recovered = recoveredStore.load();
    assert.equal(recovered.SAVE01.name, '已验证');
    recoveredStore.save(recovered);
    assert.equal(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')).SAVE01.name, '已验证');
  }
});

test('主备均损坏时拒绝加载并保留原始文件', t => {
  const file = temporaryFile(t);
  fs.writeFileSync(file, 'null');
  fs.writeFileSync(`${file}.bak`, '[]');
  const store = createGameStore(file);
  assert.throws(() => store.load(), /存档与备份无法读取/);
  assert.throws(() => store.save(savedGame()), /存档与备份无法读取/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'null');
  assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), '[]');
});

test('替换存档失败保留主档及有效备份并清理临时文件', t => {
  const file = temporaryFile(t);
  const store = createGameStore(file);
  store.save(savedGame('第一版'));
  store.save(savedGame('第二版'));
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source, target) => {
    if (target === file) throw new Error('磁盘故障');
    return rename(source, target);
  });
  assert.throws(() => store.save(savedGame('第三版')), /磁盘故障/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).SAVE01.name, '第二版');
  assert.equal(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')).SAVE01.name, '第二版');
  assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['games.json', 'games.json.bak']);
});

test('序列化失败不会改动主备存档', t => {
  const file = temporaryFile(t);
  const store = createGameStore(file);
  store.save(savedGame());
  store.save(savedGame('第二版'));
  const primary = fs.readFileSync(file, 'utf8');
  const backup = fs.readFileSync(`${file}.bak`, 'utf8');
  const invalid = savedGame();
  invalid.SAVE01.circular = invalid;
  assert.throws(() => store.save(invalid), /circular/i);
  assert.equal(fs.readFileSync(file, 'utf8'), primary);
  assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), backup);
});

test('账号文件缺失或内容结构损坏时可恢复备份并继续登录', t => {
  const file = temporaryFile(t, 'auth.json');
  const auth = createAuthService({file});
  auth.register('persistent_user', 'password123');
  auth.login('persistent_user', 'password123');
  fs.unlinkSync(file);
  assert.equal(createAuthService({file}).login('persistent_user', 'password123').user.username, 'persistent_user');
  fs.writeFileSync(file, 'null');
  const recovered = createAuthService({file});
  assert.equal(recovered.login('persistent_user', 'password123').user.username, 'persistent_user');
  fs.writeFileSync(file, '[]');
  assert.equal(createAuthService({file}).login('persistent_user', 'password123').user.username, 'persistent_user');
});

test('注册、登录和退出在写入失败时回滚内存状态并标记服务器错误', () => {
  let failing = true;
  const auth = createAuthService({save: () => { if (failing) throw new Error('磁盘已满'); }});
  const isWriteError = error => error.status === 500 && /磁盘已满/.test(error.message);
  assert.throws(() => auth.register('rollback_user', 'password123'), isWriteError);
  assert.deepEqual(auth.state.users, {});
  assert.deepEqual(auth.state.sessions, {});
  failing = false;
  const account = auth.register('rollback_user', 'password123');
  const before = JSON.stringify(auth.state);
  failing = true;
  assert.throws(() => auth.login('rollback_user', 'password123'), isWriteError);
  assert.equal(JSON.stringify(auth.state), before);
  assert.throws(() => auth.logout(account.token), isWriteError);
  assert.equal(JSON.stringify(auth.state), before);
  assert.equal(auth.session(account.token).user.id, account.user.id);
});

test('异步密码计算不调用同步 scrypt，重复用户名并发注册仅成功一次', async t => {
  t.mock.method(crypto, 'scryptSync', () => { throw new Error('不应阻塞事件循环'); });
  const auth = createAuthService();
  const results = await Promise.allSettled([
    auth.registerAsync('Concurrent_User', 'password123'),
    auth.registerAsync('concurrent_user', 'password123')
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(results.find(result => result.status === 'rejected').reason.message, /用户名已经存在/);
  assert.equal(Object.keys(auth.state.users).length, 1);
  assert.equal(Object.keys(auth.state.sessions).length, 1);
  const loggedIn = await auth.loginAsync('CONCURRENT_USER', 'password123');
  assert.ok(auth.session(loggedIn.token));
  await assert.rejects(auth.loginAsync('Concurrent_User', 'wrong-password'), /用户名或密码错误/);
});

test('创建新会话时删除已过期会话和不存在用户的会话', () => {
  const auth = createAuthService();
  const account = auth.register('session_user', 'password123');
  const oldHash = Object.keys(auth.state.sessions)[0];
  auth.state.sessions[oldHash].expiresAt = 0;
  auth.state.sessions['a'.repeat(64)] = {userId: 'removed-user', expiresAt: Date.now() + 1_000};
  auth.login('session_user', 'password123');
  assert.equal(auth.session(account.token), null);
  assert.equal(Object.keys(auth.state.sessions).length, 1);
});

test('访问密钥失败记录限制容量，过期后统一清理', t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const gate = createSiteGate('friends-key-2026');
  for (let index = 0; index < 10_000; index++) gate.verifyAccessKey('incorrect', `client-${index}`);
  assert.ok(gate.retryAfterSeconds('new-client') > 0);
  assert.equal(gate.verifyAccessKey('friends-key-2026', 'new-client'), false);
  now += 10 * 60 * 1_000 + 1;
  assert.equal(gate.retryAfterSeconds('new-client'), 0);
  assert.equal(gate.verifyAccessKey('friends-key-2026', 'new-client'), true);
});

test('非整数 AI 批量大小按整数处理且同轮并发请求共享一次生成', async () => {
  const game = createGame('合并请求', '玩家', {seed: 98});
  let calls = 0;
  const fixtureKeys = [];
  const service = createDeepSeekMatchService({
    enabled: true, apiKey: 'test-key', batchSize: 2.5,
    fetchImpl: async (url, {body}) => {
      calls++;
      const facts = JSON.parse(JSON.parse(body).messages[1].content);
      fixtureKeys.push(...facts.f.map(fixture => `${fixture.h.i}:${fixture.a.i}`));
      return matchResponse(body);
    }
  });
  const [first, second] = await Promise.all([service.simulateRound(game, game.rounds[0]), service.simulateRound(game, game.rounds[0])]);
  assert.equal(service.batchSize, 2);
  assert.equal(calls, 5);
  assert.equal(new Set(fixtureKeys).size, 10);
  assert.equal(fixtureKeys.length, 10);
  assert.deepEqual(first, second);
});

test('AI 响应体挂起也会超时，且失败后可重新请求', async () => {
  const game = createGame('响应体超时', '玩家', {seed: 99});
  const round = {...game.rounds[0], games: game.rounds[0].games.slice(0, 1)};
  let hanging = true;
  const signals = [];
  const service = createDeepSeekMatchService({
    enabled: true, apiKey: 'test-key', timeoutMs: 15, maxRetries: 0,
    fetchImpl: async (url, {body, signal}) => {
      signals.push(signal);
      return hanging ? {ok: true, json: () => new Promise(() => {})} : matchResponse(body);
    }
  });
  await assert.rejects(service.simulateRound(game, round), /请求超过/);
  assert.equal(signals[0].aborted, true);
  hanging = false;
  assert.equal((await service.simulateRound(game, round)).length, 1);
  assert.equal(signals.length, 2);
  assert.equal(signals[1].aborted, false);
});

test('AI 认证错误不重试，服务临时错误仍然重试', async () => {
  const game = createGame('重试策略', '玩家', {seed: 100});
  const round = {...game.rounds[0], games: game.rounds[0].games.slice(0, 1)};
  let calls = 0;
  const denied = createDeepSeekMatchService({
    enabled: true, apiKey: 'test-key', maxRetries: 3, retryDelayMs: 0,
    fetchImpl: async () => { calls++; return {ok: false, status: 401, text: async () => 'invalid key'}; }
  });
  await assert.rejects(denied.simulateRound(game, round), /401.*已尝试 1 次/);
  assert.equal(calls, 1);
  calls = 0;
  const retry = createDeepSeekMatchService({
    enabled: true, apiKey: 'test-key', maxRetries: 1, retryDelayMs: 0,
    fetchImpl: async (url, {body}) => {
      calls++;
      return calls === 1 ? {ok: false, status: 503, text: async () => 'busy'} : matchResponse(body);
    }
  });
  assert.equal((await retry.simulateRound(game, round)).length, 1);
  assert.equal(calls, 2);
});

test('AI 缓存随阵容输入失效且只重跑变化的对阵', async () => {
  const game = createGame('缓存校验', '玩家', {seed: 101});
  const requested = [];
  const service = createDeepSeekMatchService({
    enabled: true, apiKey: 'test-key',
    fetchImpl: async (url, {body}) => {
      requested.push(JSON.parse(JSON.parse(body).messages[1].content).f.map(fixture => `${fixture.h.i}:${fixture.a.i}`));
      return matchResponse(body);
    }
  });
  const round = game.rounds[0];
  await service.simulateRound(game, round);
  await service.simulateRound(game, round);
  assert.equal(requested.length, 2);
  const changed = round.games[0];
  const team = game.teams.find(team => team.id === changed.home);
  team.mentality = team.mentality === '进攻' ? '防守' : '进攻';
  await service.simulateRound(game, round);
  assert.equal(requested.length, 3);
  assert.deepEqual(requested[2], [`${changed.home}:${changed.away}`]);
  assert.equal(Object.keys(game.aiSimulationCache['1']).length, 10);
});
