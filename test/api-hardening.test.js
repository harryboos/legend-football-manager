const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {Readable, PassThrough, Writable} = require('node:stream');
const gameModule = require('../src/game');
const {createHostOwnership} = require('../src/access');
const {createRequestHandler, readJsonBody} = require('../src/api');
const {createSiteGate} = require('../src/site-gate');

const publicDirectory = path.join(__dirname, '..', 'public');
const auth = {session: token => token ? {user: {id: token, username: token}} : null};

function environment(options = {}) {
  const current = gameModule.createGame('接口回归', '房主', {id: 'API001', seed: 1});
  createHostOwnership(current, 't1', 'host');
  const games = {[current.id]: current};
  const handler = createRequestHandler({games, save() {}, publicDirectory, auth, ...options});
  return {current, games, handler};
}

async function call(handler, method, url, body, headers = {}, stream) {
  const request = stream || Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  Object.assign(request, {method, url, headers: {cookie: 'lfm_session=host', 'x-game-version': '0', ...headers}, socket: {remoteAddress: '127.0.0.1'}});
  const chunks = [];
  const response = new Writable({write(chunk, encoding, done) { chunks.push(chunk); done(); }});
  response.writeHead = (status, responseHeaders) => {
    response.status = status;
    response.headers = responseHeaders;
    response.headersSent = true;
  };
  await handler(request, response);
  const text = Buffer.concat(chunks).toString('utf8');
  return {status: response.status, headers: response.headers, body: response.headers?.['content-type']?.includes('application/json') && text ? JSON.parse(text) : text};
}

test('请求体按字节限流并正确拼接拆分的中文 UTF-8', async () => {
  const source = Buffer.from('{"name":"中国"}');
  assert.deepEqual(await readJsonBody(Readable.from([...source].map(byte => Buffer.from([byte])))), {name: '中国'});
  await assert.rejects(readJsonBody(Readable.from([source]), source.length - 1), {status: 413});
  for (const source of ['null', '[]', '1', '"text"', '{']) {
    await assert.rejects(readJsonBody(Readable.from([source])), {status: 400});
  }
});

test('畸形 Cookie 不导致服务错误；继承的对象属性不作为房间', async () => {
  const {handler} = environment();
  const malformed = await call(handler, 'GET', '/api/auth/session', undefined, {cookie: 'lfm_session=%E0%A4%A'});
  assert.equal(malformed.status, 401);
  for (const id of ['__proto__', 'constructor', 'toString']) {
    assert.equal((await call(handler, 'GET', `/api/games/${id}`)).status, 404);
  }
});

test('删除请求在请求体到达后重新检查房间版本', async () => {
  const {handler, current, games} = environment();
  const stream = new PassThrough();
  const pending = call(handler, 'DELETE', '/api/games/API001', undefined, {}, stream);
  await new Promise(resolve => setImmediate(resolve));
  current.revision++;
  stream.end(JSON.stringify({confirmCode: current.id}));
  assert.equal((await pending).status, 409);
  assert.equal(games.API001, current);
});

test('等待请求体的操作不能写入已经删除的房间', async () => {
  const {handler, current} = environment();
  const stream = new PassThrough();
  const pending = call(handler, 'POST', '/api/games/API001/start-draft', undefined, {}, stream);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await call(handler, 'DELETE', '/api/games/API001', {confirmCode: current.id})).status, 200);
  stream.end('{}');
  assert.equal((await pending).status, 404);
  assert.equal(current.phase, 'lobby');
});

test('存档失败时创建、删除和普通修改均回滚', async () => {
  const {handler, current, games} = environment({save() { throw new Error('disk full'); }});
  assert.equal((await call(handler, 'POST', '/api/games', {name: '不能创建'})).status, 500);
  assert.deepEqual(Object.keys(games), ['API001']);
  assert.equal((await call(handler, 'DELETE', '/api/games/API001', {confirmCode: current.id})).status, 500);
  assert.equal(games.API001, current);
  assert.equal((await call(handler, 'POST', '/api/games/API001/start-draft', {})).status, 500);
  assert.equal(current.phase, 'lobby');
  assert.equal(current.revision, 0);
  assert.equal(current.draft.pick, 0);
});

test('自动排阵的后续参数校验失败不会残留部分修改', async () => {
  const {handler, current} = environment();
  const previous = structuredClone(current.teams[0]);
  const formation = Object.keys(current.rules.formations).find(value => value !== previous.formation);
  const response = await call(handler, 'POST', '/api/games/API001/lineup', {teamId: 't1', auto: true, formation, mentality: '不存在'});
  assert.equal(response.status, 400);
  assert.deepEqual(current.teams[0], previous);
  assert.equal(current.revision, 0);
});

test('模拟锁同样保护删除与房主认领，进度查询不会缓存旧进度', async t => {
  let release;
  t.mock.method(gameModule, 'playRound', async current => {
    current.simulation.completedMatches = 5;
    await new Promise(resolve => { release = resolve; });
    throw new Error('模拟测试失败');
  });
  const {handler, current} = environment({matchService: {available: true, model: 'test'}});
  current.phase = 'season';
  const pending = call(handler, 'POST', '/api/games/API001/play-round', {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await call(handler, 'DELETE', '/api/games/API001', {confirmCode: current.id})).status, 409);
  assert.equal((await call(handler, 'POST', '/api/games/API001/claim-host', {confirmCode: current.id})).status, 409);
  assert.equal((await call(handler, 'GET', '/api/games/API001')).body.simulation.completedMatches, 5);
  current.simulation.completedMatches = 8;
  assert.equal((await call(handler, 'GET', '/api/games/API001')).body.simulation.completedMatches, 8);
  release();
  assert.equal((await pending).status, 502);
  assert.equal((await call(handler, 'DELETE', '/api/games/API001', {confirmCode: current.id})).status, 200);
});

test('一轮模拟保存失败时回退轮次、比分和版本', async t => {
  t.mock.method(gameModule, 'playRound', async current => {
    current.results.push({round: 1});
    current.currentRound++;
    current.rounds[0].played = true;
  });
  const {handler, current} = environment({save() { throw new Error('disk full'); }, matchService: {available: true, model: 'test'}});
  current.phase = 'season';
  assert.equal((await call(handler, 'POST', '/api/games/API001/play-round', {})).status, 500);
  assert.equal(current.currentRound, 0);
  assert.equal(current.revision, 0);
  assert.deepEqual(current.results, []);
  assert.equal(current.rounds[0].played, false);
});

test('公开状态缓存保留各账号权限并随版本更新', async () => {
  const {handler} = environment();
  const host = await call(handler, 'GET', '/api/games/API001');
  const visitor = await call(handler, 'GET', '/api/games/API001', undefined, {cookie: 'lfm_session=visitor'});
  assert.equal(host.body.session.role, 'host');
  assert.equal(visitor.body.session, null);
  assert.equal(host.body.access.hostUserId, undefined);
  assert.equal(host.headers['cache-control'], 'no-store');
  const joined = await call(handler, 'POST', '/api/games/API001/join', {teamId: 't2'}, {cookie: 'lfm_session=visitor'});
  assert.equal(joined.status, 200);
  assert.equal(joined.body.revision, 1);
  const refreshed = await call(handler, 'GET', '/api/games/API001', undefined, {cookie: 'lfm_session=visitor'});
  assert.equal(refreshed.body.session.teamId, 't2');
  assert.equal(refreshed.body.teams[1].controller, 'human');
});

test('默认忽略伪造转发地址，无法通过改请求头绕过访问密钥限流', async () => {
  const {handler} = environment({siteGate: createSiteGate('correct-secret')});
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await call(handler, 'POST', '/api/gate/unlock', {accessKey: 'wrong'}, {'x-forwarded-for': `10.0.0.${attempt}`});
    assert.equal(response.status, attempt === 4 ? 429 : 401);
  }
  assert.equal((await call(handler, 'POST', '/api/gate/unlock', {accessKey: 'correct-secret'}, {'x-forwarded-for': '10.0.0.99'})).status, 429);
});

test('显式信任代理时识别 HTTPS 并生成 Secure Cookie', async () => {
  const {handler} = environment({siteGate: createSiteGate('correct-secret'), trustProxy: true});
  const response = await call(handler, 'POST', '/api/gate/unlock', {accessKey: 'correct-secret'}, {'x-forwarded-proto': 'https'});
  assert.equal(response.status, 200);
  assert.match(response.headers['set-cookie'], /; Secure/);
});

test('静态资源支持条件请求与 HEAD，拒绝越界路径', async () => {
  const {handler} = environment();
  const response = await call(handler, 'GET', '/app.js');
  assert.equal(response.status, 200);
  assert.ok(response.body.length > 0);
  assert.equal(Number(response.headers['content-length']), Buffer.byteLength(response.body));
  const head = await call(handler, 'HEAD', '/app.js');
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  const cached = await call(handler, 'GET', '/app.js', undefined, {'if-none-match': response.headers.etag});
  assert.equal(cached.status, 304);
  assert.equal(cached.body, '');
  assert.equal((await call(handler, 'GET', '/..%2fpackage.json')).status, 404);
  assert.equal((await call(handler, 'GET', '/missing.css')).status, 404);
});
