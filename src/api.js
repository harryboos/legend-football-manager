const fs = require('fs');
const path = require('path');
const game = require('./game');
const {SESSION_MAX_AGE_MS, createAuthService} = require('./auth');
const {SITE_GATE_COOKIE, SITE_GATE_MAX_AGE_MS} = require('./site-gate');
const {
  claimLegacyHost,
  createHostOwnership,
  ensureAccess,
  issueTeamOwnership,
  sessionForUser
} = require('./access');

const CONTENT_TYPES = {'.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8'};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const SESSION_COOKIE = 'lfm_session';

function sendJson(response, status, data, headers = {}) {
  response.writeHead(status, {'content-type': 'application/json; charset=utf-8', ...headers});
  response.end(JSON.stringify(data));
}

async function readJsonBody(request, maximumBytes = 1_000_000) {
  let source = '';
  for await (const chunk of request) {
    source += chunk;
    if (Buffer.byteLength(source) > maximumBytes) throw new HttpError(413, '请求内容过大');
  }
  if (!source) return {};
  try {
    return JSON.parse(source);
  } catch {
    throw new HttpError(400, '请求 JSON 格式无效');
  }
}

function limitedText(value, fallback, maximumLength) {
  const text = String(value || '').trim();
  return (text || fallback).slice(0, maximumLength);
}

function requestHeader(request, name) {
  const value = request.headers?.[name];
  return Array.isArray(value) ? value[0] : String(value || '');
}

function clientIdentifier(request) {
  return requestHeader(request, 'x-forwarded-for').split(',')[0].trim() || request.socket?.remoteAddress || 'unknown';
}

function cookieValue(request, name) {
  const source = requestHeader(request, 'cookie');
  const item = source.split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`));
  return item ? decodeURIComponent(item.slice(name.length + 1)) : '';
}

function httpOnlyCookie(request, name, value, maximumAgeSeconds) {
  const forwarded = requestHeader(request, 'x-forwarded-proto').split(',')[0].trim();
  const secure = forwarded === 'https' || Boolean(request.socket?.encrypted);
  return `${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maximumAgeSeconds}${secure ? '; Secure' : ''}`;
}

function sessionCookie(request, token, maximumAgeSeconds) {
  return httpOnlyCookie(request, SESSION_COOKIE, token, maximumAgeSeconds);
}

function authenticatedAccount(auth, request) {
  return auth.session(cookieValue(request, SESSION_COOKIE))?.user || null;
}

async function handleAuthApi(auth, request, response, pathname) {
  if (!pathname.startsWith('/api/auth/')) return false;
  const action = pathname.slice('/api/auth/'.length);
  if (action === 'session') {
    if (request.method !== 'GET') throw new HttpError(405, '此接口仅支持 GET');
    const account = authenticatedAccount(auth, request);
    if (!account) throw new HttpError(401, '请先登录');
    sendJson(response, 200, {user: account});
    return true;
  }
  if (action === 'logout') {
    if (request.method !== 'POST') throw new HttpError(405, '此接口仅支持 POST');
    auth.logout(cookieValue(request, SESSION_COOKIE));
    sendJson(response, 200, {loggedOut: true}, {'set-cookie': sessionCookie(request, '', 0)});
    return true;
  }
  if (!['login', 'register'].includes(action)) throw new HttpError(404, '接口不存在');
  if (request.method !== 'POST') throw new HttpError(405, '此接口仅支持 POST');
  const body = await readJsonBody(request);
  let result;
  try {
    result = action === 'register' ? auth.register(body.username, body.password) : auth.login(body.username, body.password);
  } catch (error) {
    const status = action === 'login' && error.message === '用户名或密码错误' ? 401 : (error.message === '用户名已经存在' ? 409 : 400);
    throw new HttpError(status, error.message);
  }
  sendJson(response, action === 'register' ? 201 : 200, {user: result.user}, {
    'set-cookie': sessionCookie(request, result.token, Math.floor(SESSION_MAX_AGE_MS / 1000))
  });
  return true;
}

async function handleSiteGateApi(siteGate, request, response, pathname) {
  if (!pathname.startsWith('/api/gate/')) return false;
  const action = pathname.slice('/api/gate/'.length);
  if (action === 'status') {
    if (request.method !== 'GET') throw new HttpError(405, '此接口仅支持 GET');
    sendJson(response, 200, {
      configured: Boolean(siteGate?.configured),
      unlocked: Boolean(siteGate?.verifyToken(cookieValue(request, SITE_GATE_COOKIE)))
    });
    return true;
  }
  if (action !== 'unlock') throw new HttpError(404, '接口不存在');
  if (request.method !== 'POST') throw new HttpError(405, '此接口仅支持 POST');
  if (!siteGate?.configured) throw new HttpError(503, '管理员尚未配置 SITE_ACCESS_KEY，网站暂时不可进入');
  const body = await readJsonBody(request);
  const identifier = clientIdentifier(request);
  const retryBeforeAttempt = siteGate.retryAfterSeconds(identifier);
  if (retryBeforeAttempt) throw new HttpError(429, `尝试次数过多，请在 ${retryBeforeAttempt} 秒后重试`);
  if (!siteGate.verifyAccessKey(body.accessKey, identifier)) {
    const retryAfterFailure = siteGate.retryAfterSeconds(identifier);
    if (retryAfterFailure) throw new HttpError(429, `尝试次数过多，请在 ${retryAfterFailure} 秒后重试`);
    throw new HttpError(401, '朋友访问密钥错误');
  }
  sendJson(response, 200, {unlocked: true}, {
    'set-cookie': httpOnlyCookie(request, SITE_GATE_COOKIE, siteGate.accessToken, Math.floor(SITE_GATE_MAX_AGE_MS / 1000))
  });
  return true;
}

function assertRevision(request, current) {
  const supplied = Number(requestHeader(request, 'x-game-version'));
  if (!requestHeader(request, 'x-game-version')) throw new HttpError(428, '缺少房间版本，请刷新页面后重试');
  if (!Number.isInteger(supplied) || supplied !== current.revision) throw new HttpError(409, '房间数据已经更新，请刷新后重试');
}

function requireSession(current, account) {
  const session = sessionForUser(current, account?.id);
  if (!session) throw new HttpError(403, '当前账号没有此房间的操作权限，请加入或认领房间');
  return session;
}

function createApiHandler({games, save, matchService = {available: false, model: 'deepseek-v4-flash'}}) {
  const activeSimulations = new Set();
  const presentedGame = (current, account) => ({
    ...game.publicGame(current),
    capabilities: {
      aiMatchEngine: Boolean(matchService.available),
      matchModel: matchService.model
    },
    access: {
      legacyClaimRequired: !ensureAccess(current).hostUserId
    },
    session: sessionForUser(current, account?.id)
  });

  return async function handleApi(request, response, pathname, account) {
    const parts = pathname.split('/').filter(Boolean);
    if (parts[0] !== 'api' || parts[1] !== 'games') return false;

    if (parts.length === 2) {
      if (request.method !== 'POST') throw new HttpError(405, '此接口仅支持 POST');
      const body = await readJsonBody(request);
      let created;
      do {
        created = game.createGame(limitedText(body.name, '传奇经理联赛', 40), limitedText(body.host, '房主', 24), {hostTeamId: body.teamId});
      } while (games[created.id]);
      createHostOwnership(created, created.teams.find(team => team.controller === 'human').id, account.id);
      games[created.id] = created;
      save(games);
      sendJson(response, 201, presentedGame(created, account));
      return true;
    }

    if (parts.length < 3 || parts.length > 4) throw new HttpError(404, '接口不存在');
    const current = games[parts[2]];
    if (!current) throw new HttpError(404, '房间不存在');

    if (parts.length === 3) {
      if (request.method === 'GET') {
        sendJson(response, 200, presentedGame(current, account));
        return true;
      }
      if (request.method === 'DELETE') {
        const session = requireSession(current, account);
        if (session.role !== 'host') throw new HttpError(403, '只有房主可以删除房间');
        assertRevision(request, current);
        const body = await readJsonBody(request);
        if (String(body.confirmCode || '').trim().toUpperCase() !== current.id) throw new HttpError(400, '房间码确认不匹配');
        delete games[current.id];
        save(games);
        sendJson(response, 200, {deleted: true, id: current.id});
        return true;
      }
      throw new HttpError(405, '此接口仅支持 GET 或 DELETE');
    }

    if (request.method !== 'POST') throw new HttpError(405, '游戏操作仅支持 POST');
    const body = await readJsonBody(request);
    const action = parts[3];

    if (action === 'claim-host') {
      assertRevision(request, current);
      let session;
      try {
        session = claimLegacyHost(current, body.confirmCode, account.id);
      } catch (error) {
        throw new HttpError(400, error.message);
      }
      current.revision++;
      save(games);
      sendJson(response, 200, presentedGame(current, account));
      return true;
    }

    if (activeSimulations.has(current.id)) throw new HttpError(409, '本房间正在模拟比赛，请等待当前任务完成');
    assertRevision(request, current);
    if (action === 'join') {
      if (current.phase !== 'lobby') throw new HttpError(400, '联赛已经开始，无法加入');
      const team = current.teams.find(candidate => candidate.id === body.teamId && candidate.controller === 'AI')
        || (!body.teamId && current.teams.find(candidate => candidate.controller === 'AI'));
      if (!team) throw new HttpError(400, '所选球队不可用');
      try {
        issueTeamOwnership(current, team.id, account.id);
      } catch (error) {
        throw new HttpError(400, error.message);
      }
      team.controller = 'human';
      team.manager = limitedText(body.manager, '玩家', 24);
      team.managerStyle = '自定义';
    } else if (action === 'start-draft') {
      const session = requireSession(current, account);
      if (session.role !== 'host') throw new HttpError(403, '只有房主可以开始选秀');
      if (current.phase !== 'lobby') throw new HttpError(400, '选秀已经开始');
      current.phase = 'draft';
      game.runAiDraft(current);
    } else if (action === 'pick') {
      const session = requireSession(current, account);
      if (session.teamId !== body.teamId) throw new HttpError(403, '只能为自己控制的球队选人');
      game.draftPick(current, body.teamId, body.playerId);
      game.runAiDraft(current);
    } else if (action === 'lineup') {
      const session = requireSession(current, account);
      if (session.teamId !== body.teamId) throw new HttpError(403, '只能修改自己控制的球队');
      const team = current.teams.find(candidate => candidate.id === body.teamId);
      if (!team || team.controller !== 'human') throw new HttpError(400, '球队不存在或不由真人控制');
      const rules = game.rulesFor(current);
      if (body.auto) {
        if (body.formation) {
          if (body.formation === '自定义') {
            team.customFormation = game.normalizeCustomFormation(body.customFormation || team.customFormation, rules.starters);
          } else if (!rules.formations[body.formation]) throw new HttpError(400, '阵型不存在');
          team.formation = body.formation;
        }
        if (body.mentality) {
          if (!rules.mentalities.includes(body.mentality)) throw new HttpError(400, '比赛心态不存在');
          team.mentality = body.mentality;
        }
        game.autoLineup(current, team, current.players);
      } else {
        game.setLineup(current, team, body.formation, body.mentality, body.assignments, body.customFormation);
      }
    } else if (action === 'play-round') {
      const session = requireSession(current, account);
      if (session.role !== 'host') throw new HttpError(403, '只有房主可以模拟比赛');
      if (!matchService.available) throw new HttpError(400, '请先配置 DEEPSEEK_API_KEY 后再模拟比赛');
      activeSimulations.add(current.id);
      current.simulation = {status: 'running', mode: 'round', round: current.currentRound + 1, completedMatches: 0, totalMatches: current.rounds[current.currentRound]?.games.length || 0};
      try {
        await game.playRound(current, matchService);
        current.revision++;
        delete current.simulation;
        save(games);
        sendJson(response, 200, presentedGame(current, account));
        return true;
      } catch (error) {
        current.simulation = {status: 'error', mode: 'round', round: current.currentRound + 1, error: error.message};
        save(games);
        throw new HttpError(502, `AI 比赛模拟失败，本轮未推进：${error.message}`);
      } finally {
        activeSimulations.delete(current.id);
      }
    } else if (action === 'play-all') {
      const session = requireSession(current, account);
      if (session.role !== 'host') throw new HttpError(403, '只有房主可以模拟比赛');
      if (!matchService.available) throw new HttpError(400, '请先配置 DEEPSEEK_API_KEY 后再模拟比赛');
      activeSimulations.add(current.id);
      try {
        while (current.phase === 'season') {
          current.simulation = {status: 'running', mode: 'season', round: current.currentRound + 1, completedMatches: 0, totalMatches: current.rounds[current.currentRound]?.games.length || 0};
          await game.playRound(current, matchService);
          current.revision++;
          save(games);
        }
        delete current.simulation;
        save(games);
        sendJson(response, 200, presentedGame(current, account));
        return true;
      } catch (error) {
        current.simulation = {status: 'error', mode: 'season', round: current.currentRound + 1, error: error.message};
        save(games);
        throw new HttpError(502, `AI 整季模拟中断，已保存完成轮次：${error.message}`);
      } finally {
        activeSimulations.delete(current.id);
      }
    } else {
      throw new HttpError(404, '接口不存在');
    }

    current.revision++;
    save(games);
    sendJson(response, 200, presentedGame(current, account));
    return true;
  };
}

function serveStatic(request, response, pathname, publicDirectory) {
  if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, '静态资源仅支持 GET');
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, '路径格式无效');
  }
  const requested = decoded === '/' ? 'index.html' : decoded.slice(1);
  const file = path.resolve(publicDirectory, requested);
  const publicRoot = path.resolve(publicDirectory);
  if (file !== publicRoot && !file.startsWith(`${publicRoot}${path.sep}`)) throw new HttpError(404, '文件不存在');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new HttpError(404, '文件不存在');
  response.writeHead(200, {'content-type': CONTENT_TYPES[path.extname(file)] || 'application/octet-stream'});
  if (request.method === 'HEAD') return response.end();
  fs.createReadStream(file).pipe(response);
}

function createRequestHandler({games, save, publicDirectory, matchService, auth = createAuthService(), siteGate = null}) {
  const handleApi = createApiHandler({games, save, matchService});
  return async function requestHandler(request, response) {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        if (await handleSiteGateApi(siteGate, request, response, url.pathname)) return;
        if (siteGate && !siteGate.configured) throw new HttpError(503, '管理员尚未配置 SITE_ACCESS_KEY，网站暂时不可进入');
        if (siteGate && !siteGate.verifyToken(cookieValue(request, SITE_GATE_COOKIE))) throw new HttpError(403, '请先输入朋友访问密钥');
        if (await handleAuthApi(auth, request, response, url.pathname)) return;
        const account = authenticatedAccount(auth, request);
        if (!account) throw new HttpError(401, '请先登录后再进入游戏');
        const handled = await handleApi(request, response, url.pathname, account);
        if (!handled) throw new HttpError(404, '接口不存在');
        return;
      }
      serveStatic(request, response, url.pathname, publicDirectory);
    } catch (error) {
      const status = error.status || (error instanceof SyntaxError ? 400 : 400);
      sendJson(response, status, {error: error.message || '请求失败'});
    }
  };
}

module.exports = {createApiHandler, createRequestHandler, readJsonBody, HttpError};
