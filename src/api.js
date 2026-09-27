const fs = require('fs');
const path = require('path');
const {pipeline} = require('stream/promises');
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
  response.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers});
  response.end(JSON.stringify(data));
}

async function readJsonBody(request, maximumBytes = 1_000_000) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maximumBytes) throw new HttpError(413, '请求内容过大');
    chunks.push(buffer);
  }
  if (!bytes) return {};
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
  } catch {
    throw new HttpError(400, '请求 JSON 格式无效');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, '请求 JSON 必须是对象');
  return body;
}

function limitedText(value, fallback, maximumLength) {
  const text = String(value || '').trim();
  return (text || fallback).slice(0, maximumLength);
}

function requestHeader(request, name) {
  const value = request.headers?.[name];
  return Array.isArray(value) ? value[0] : String(value || '');
}

function clientIdentifier(request, trustProxy) {
  const forwarded = trustProxy && requestHeader(request, 'x-forwarded-for').split(',')[0].trim();
  return forwarded || request.socket?.remoteAddress || 'unknown';
}

function cookieValue(request, name) {
  const source = requestHeader(request, 'cookie');
  const item = source.split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`));
  try {
    return item ? decodeURIComponent(item.slice(name.length + 1)) : '';
  } catch {
    return '';
  }
}

function httpOnlyCookie(request, name, value, maximumAgeSeconds, trustProxy) {
  const forwarded = trustProxy && requestHeader(request, 'x-forwarded-proto').split(',')[0].trim();
  const secure = forwarded === 'https' || Boolean(request.socket?.encrypted);
  return `${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maximumAgeSeconds}${secure ? '; Secure' : ''}`;
}

function sessionCookie(request, token, maximumAgeSeconds, trustProxy) {
  return httpOnlyCookie(request, SESSION_COOKIE, token, maximumAgeSeconds, trustProxy);
}

function authenticatedAccount(auth, request) {
  return auth.session(cookieValue(request, SESSION_COOKIE))?.user || null;
}

async function handleAuthApi(auth, request, response, pathname, trustProxy) {
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
    sendJson(response, 200, {loggedOut: true}, {'set-cookie': sessionCookie(request, '', 0, trustProxy)});
    return true;
  }
  if (!['login', 'register'].includes(action)) throw new HttpError(404, '接口不存在');
  if (request.method !== 'POST') throw new HttpError(405, '此接口仅支持 POST');
  const body = await readJsonBody(request);
  let result;
  try {
    const operation = action === 'register' ? (auth.registerAsync || auth.register) : (auth.loginAsync || auth.login);
    result = await operation.call(auth, body.username, body.password);
  } catch (error) {
    const status = error.status || (action === 'login' && error.message === '用户名或密码错误' ? 401 : (error.message === '用户名已经存在' ? 409 : 400));
    throw new HttpError(status, error.message);
  }
  sendJson(response, action === 'register' ? 201 : 200, {user: result.user}, {
    'set-cookie': sessionCookie(request, result.token, Math.floor(SESSION_MAX_AGE_MS / 1000), trustProxy)
  });
  return true;
}

async function handleSiteGateApi(siteGate, request, response, pathname, trustProxy) {
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
  const identifier = clientIdentifier(request, trustProxy);
  const retryBeforeAttempt = siteGate.retryAfterSeconds(identifier);
  if (retryBeforeAttempt) throw new HttpError(429, `尝试次数过多，请在 ${retryBeforeAttempt} 秒后重试`);
  if (!siteGate.verifyAccessKey(body.accessKey, identifier)) {
    const retryAfterFailure = siteGate.retryAfterSeconds(identifier);
    if (retryAfterFailure) throw new HttpError(429, `尝试次数过多，请在 ${retryAfterFailure} 秒后重试`);
    throw new HttpError(401, '朋友访问密钥错误');
  }
  sendJson(response, 200, {unlocked: true}, {
    'set-cookie': httpOnlyCookie(request, SITE_GATE_COOKIE, siteGate.accessToken, Math.floor(SITE_GATE_MAX_AGE_MS / 1000), trustProxy)
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

function snapshotGame(current) {
  const {players, ...state} = current;
  return {...structuredClone(state), players};
}

function restoreGame(current, snapshot) {
  for (const key of Object.keys(current)) delete current[key];
  Object.assign(current, snapshot);
}

function createApiHandler({games, save, matchService = {available: false, model: 'deepseek-v4-flash'}}) {
  const activeSimulations = new Set();
  const publicStates = new WeakMap();
  const persist = () => {
    try {
      save(games);
    } catch {
      throw new HttpError(500, '存档保存失败，请稍后重试');
    }
  };
  const presentedGame = (current, account) => {
    let cached = publicStates.get(current);
    if (!cached || cached.revision !== current.revision) {
      cached = {revision: current.revision, state: game.publicGame(current)};
      publicStates.set(current, cached);
    }
    return {
      ...cached.state,
      simulation: current.simulation,
      capabilities: {
        aiMatchEngine: Boolean(matchService.available),
        matchModel: matchService.model
      },
      access: {
        legacyClaimRequired: !ensureAccess(current).hostUserId
      },
      session: sessionForUser(current, account?.id)
    };
  };

  async function simulate(current, account, response, allRounds) {
    const session = requireSession(current, account);
    if (session.role !== 'host') throw new HttpError(403, '只有房主可以模拟比赛');
    if (current.phase !== 'season') throw new HttpError(400, '赛季尚未开始或已经结束');
    if (!matchService.available) throw new HttpError(400, '请先配置 DEEPSEEK_API_KEY 后再模拟比赛');
    const mode = allRounds ? 'season' : 'round';
    activeSimulations.add(current.id);
    try {
      do {
        const snapshot = snapshotGame(current);
        current.simulation = {status: 'running', mode, round: current.currentRound + 1, completedMatches: 0, totalMatches: current.rounds[current.currentRound]?.games.length || 0};
        await game.playRound(current, matchService);
        current.revision++;
        if (!allRounds || current.phase !== 'season') delete current.simulation;
        try {
          persist();
        } catch (error) {
          restoreGame(current, snapshot);
          publicStates.delete(current);
          throw error;
        }
      } while (allRounds && current.phase === 'season');
      sendJson(response, 200, presentedGame(current, account));
    } catch (error) {
      current.simulation = {status: 'error', mode, round: current.currentRound + 1, error: error.message};
      publicStates.delete(current);
      if (error.status === 500) throw error;
      persist();
      throw new HttpError(502, `${allRounds ? 'AI 整季模拟中断，已保存完成轮次' : 'AI 比赛模拟失败，本轮未推进'}：${error.message}`);
    } finally {
      activeSimulations.delete(current.id);
    }
  }

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
      try {
        persist();
      } catch (error) {
        delete games[created.id];
        throw error;
      }
      sendJson(response, 201, presentedGame(created, account));
      return true;
    }

    if (parts.length < 3 || parts.length > 4) throw new HttpError(404, '接口不存在');
    // Read the entire body before checking the live room and its revision.
    // Another request can modify or delete the room while this stream is arriving.
    const body = ['POST', 'DELETE'].includes(request.method) ? await readJsonBody(request) : {};
    const current = Object.hasOwn(games, parts[2]) ? games[parts[2]] : null;
    if (!current) throw new HttpError(404, '房间不存在');

    if (parts.length === 3) {
      if (request.method === 'GET') {
        sendJson(response, 200, presentedGame(current, account));
        return true;
      }
      if (request.method === 'DELETE') {
        const session = requireSession(current, account);
        if (session.role !== 'host') throw new HttpError(403, '只有房主可以删除房间');
        if (activeSimulations.has(current.id)) throw new HttpError(409, '本房间正在模拟比赛，请等待当前任务完成');
        assertRevision(request, current);
        if (String(body.confirmCode || '').trim().toUpperCase() !== current.id) throw new HttpError(400, '房间码确认不匹配');
        delete games[current.id];
        try {
          persist();
        } catch (error) {
          games[current.id] = current;
          throw error;
        }
        sendJson(response, 200, {deleted: true, id: current.id});
        return true;
      }
      throw new HttpError(405, '此接口仅支持 GET 或 DELETE');
    }

    if (request.method !== 'POST') throw new HttpError(405, '相关操作仅支持 POST');
    const action = parts[3];

    if (activeSimulations.has(current.id)) throw new HttpError(409, '本房间正在模拟比赛，请等待当前任务完成');
    assertRevision(request, current);
    if (action === 'play-round' || action === 'play-all') {
      await simulate(current, account, response, action === 'play-all');
      return true;
    }

    const snapshot = snapshotGame(current);
    try {
      if (action === 'claim-host') {
        try {
          claimLegacyHost(current, body.confirmCode, account.id);
        } catch (error) {
          throw new HttpError(400, error.message);
        }
      } else if (action === 'join') {
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
      } else {
        throw new HttpError(404, '接口不存在');
      }

      current.revision++;
      persist();
    } catch (error) {
      restoreGame(current, snapshot);
      publicStates.delete(current);
      throw error;
    }
    sendJson(response, 200, presentedGame(current, account));
    return true;
  };
}

async function serveStatic(request, response, pathname, publicDirectory) {
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
  let stats;
  try {
    stats = await fs.promises.stat(file);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EINVAL'].includes(error.code) || error.code === 'ERR_INVALID_ARG_VALUE') throw new HttpError(404, '文件不存在');
    throw new HttpError(500, '文件读取失败');
  }
  if (!stats.isFile()) throw new HttpError(404, '文件不存在');
  const etag = `W/"${stats.size.toString(16)}-${stats.mtimeMs.toString(16)}"`;
  const headers = {
    'content-type': CONTENT_TYPES[path.extname(file)] || 'application/octet-stream',
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    etag
  };
  if (requestHeader(request, 'if-none-match').split(',').some(value => value.trim() === etag || value.trim() === '*')) {
    response.writeHead(304, headers);
    return response.end();
  }
  response.writeHead(200, {...headers, 'content-length': stats.size});
  if (request.method === 'HEAD') return response.end();
  await pipeline(fs.createReadStream(file), response);
}

function createRequestHandler({games, save, publicDirectory, matchService, auth = createAuthService(), siteGate = null, trustProxy = false}) {
  const handleApi = createApiHandler({games, save, matchService});
  return async function requestHandler(request, response) {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        if (await handleSiteGateApi(siteGate, request, response, url.pathname, trustProxy)) return;
        if (siteGate && !siteGate.configured) throw new HttpError(503, '管理员尚未配置 SITE_ACCESS_KEY，网站暂时不可进入');
        if (siteGate && !siteGate.verifyToken(cookieValue(request, SITE_GATE_COOKIE))) throw new HttpError(403, '请先输入朋友访问密钥');
        if (await handleAuthApi(auth, request, response, url.pathname, trustProxy)) return;
        const account = authenticatedAccount(auth, request);
        if (!account) throw new HttpError(401, '请先登录后再访问联赛');
        const handled = await handleApi(request, response, url.pathname, account);
        if (!handled) throw new HttpError(404, '接口不存在');
        return;
      }
      await serveStatic(request, response, url.pathname, publicDirectory);
    } catch (error) {
      if (response.headersSent || response.destroyed) {
        response.destroy?.();
        return;
      }
      const status = error.status || 400;
      sendJson(response, status, {error: error.message || '请求失败'});
    }
  };
}

module.exports = {createApiHandler, createRequestHandler, readJsonBody, HttpError};
