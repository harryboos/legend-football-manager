const fs = require('fs');
const path = require('path');
const game = require('./game');
const {claimLegacyHost, createHostAccess, ensureAccess, issueTeamAccess, sessionForToken} = require('./access');

const CONTENT_TYPES = {'.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8'};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(response, status, data) {
  response.writeHead(status, {'content-type': 'application/json; charset=utf-8'});
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

function assertRevision(request, current) {
  const supplied = Number(requestHeader(request, 'x-game-version'));
  if (!requestHeader(request, 'x-game-version')) throw new HttpError(428, '缺少房间版本，请刷新页面后重试');
  if (!Number.isInteger(supplied) || supplied !== current.revision) throw new HttpError(409, '房间数据已经更新，请刷新后重试');
}

function requireSession(current, token) {
  const session = sessionForToken(current, token);
  if (!session) throw new HttpError(401, '没有此房间的操作权限，请重新创建、加入或认领房间');
  return session;
}

function createApiHandler({games, save, matchService = {available: false, model: 'deepseek-v4-flash'}}) {
  const activeSimulations = new Set();
  const presentedGame = (current, token, issuedSession) => ({
    ...game.publicGame(current),
    capabilities: {
      aiMatchEngine: Boolean(matchService.available),
      matchModel: matchService.model
    },
    access: {legacyClaimRequired: Boolean(ensureAccess(current).legacyClaimRequired)},
    session: issuedSession || sessionForToken(current, token)
  });

  return async function handleApi(request, response, pathname) {
    const token = requestHeader(request, 'x-game-token');
    const parts = pathname.split('/').filter(Boolean);
    if (parts[0] !== 'api' || parts[1] !== 'games') return false;

    if (parts.length === 2) {
      if (request.method !== 'POST') throw new HttpError(405, '此接口仅支持 POST');
      const body = await readJsonBody(request);
      let created;
      do {
        created = game.createGame(limitedText(body.name, '传奇经理联赛', 40), limitedText(body.host, '房主', 24), {hostTeamId: body.teamId});
      } while (games[created.id]);
      const session = createHostAccess(created, created.teams.find(team => team.controller === 'human').id);
      games[created.id] = created;
      save(games);
      sendJson(response, 201, presentedGame(created, session.token, session));
      return true;
    }

    if (parts.length < 3 || parts.length > 4) throw new HttpError(404, '接口不存在');
    const current = games[parts[2]];
    if (!current) throw new HttpError(404, '房间不存在');

    if (parts.length === 3) {
      if (request.method === 'GET') {
        sendJson(response, 200, presentedGame(current, token));
        return true;
      }
      if (request.method === 'DELETE') {
        const session = requireSession(current, token);
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
        session = claimLegacyHost(current, body.confirmCode);
      } catch (error) {
        throw new HttpError(400, error.message);
      }
      current.revision++;
      save(games);
      sendJson(response, 200, presentedGame(current, session.token, session));
      return true;
    }

    if (activeSimulations.has(current.id)) throw new HttpError(409, '本房间正在模拟比赛，请等待当前任务完成');
    assertRevision(request, current);
    let issuedSession = null;

    if (action === 'join') {
      if (current.phase !== 'lobby') throw new HttpError(400, '联赛已经开始，无法加入');
      const team = current.teams.find(candidate => candidate.id === body.teamId && candidate.controller === 'AI')
        || (!body.teamId && current.teams.find(candidate => candidate.controller === 'AI'));
      if (!team) throw new HttpError(400, '所选球队不可用');
      team.controller = 'human';
      team.manager = limitedText(body.manager, '玩家', 24);
      team.managerStyle = '自定义';
      issuedSession = issueTeamAccess(current, team.id);
    } else if (action === 'start-draft') {
      const session = requireSession(current, token);
      if (session.role !== 'host') throw new HttpError(403, '只有房主可以开始选秀');
      if (current.phase !== 'lobby') throw new HttpError(400, '选秀已经开始');
      current.phase = 'draft';
      game.runAiDraft(current);
    } else if (action === 'pick') {
      const session = requireSession(current, token);
      if (session.teamId !== body.teamId) throw new HttpError(403, '只能为自己控制的球队选人');
      game.draftPick(current, body.teamId, body.playerId);
      game.runAiDraft(current);
    } else if (action === 'lineup') {
      const session = requireSession(current, token);
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
      const session = requireSession(current, token);
      if (session.role !== 'host') throw new HttpError(403, '只有房主可以模拟比赛');
      if (!matchService.available) throw new HttpError(400, '请先配置 DEEPSEEK_API_KEY 后再模拟比赛');
      activeSimulations.add(current.id);
      current.simulation = {status: 'running', mode: 'round', round: current.currentRound + 1, completedMatches: 0, totalMatches: current.rounds[current.currentRound]?.games.length || 0};
      try {
        await game.playRound(current, matchService);
        current.revision++;
        delete current.simulation;
        save(games);
        sendJson(response, 200, presentedGame(current, token));
        return true;
      } catch (error) {
        current.simulation = {status: 'error', mode: 'round', round: current.currentRound + 1, error: error.message};
        save(games);
        throw new HttpError(502, `AI 比赛模拟失败，本轮未推进：${error.message}`);
      } finally {
        activeSimulations.delete(current.id);
      }
    } else if (action === 'play-all') {
      const session = requireSession(current, token);
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
        sendJson(response, 200, presentedGame(current, token));
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
    sendJson(response, 200, presentedGame(current, issuedSession?.token || token, issuedSession));
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

function createRequestHandler({games, save, publicDirectory, matchService}) {
  const handleApi = createApiHandler({games, save, matchService});
  return async function requestHandler(request, response) {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        const handled = await handleApi(request, response, url.pathname);
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
