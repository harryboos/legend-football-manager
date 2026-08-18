const crypto = require('crypto');

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function ensureAccess(game) {
  if (!game.access || typeof game.access !== 'object') {
    game.access = {
      version: 1,
      legacyClaimRequired: true,
      hostTeamId: game.teams.find(team => team.controller === 'human')?.id || game.teams[0]?.id,
      hostTokenHash: null,
      teamTokenHashes: {}
    };
  }
  game.access.teamTokenHashes = game.access.teamTokenHashes || {};
  return game.access;
}

function createHostAccess(game, hostTeamId) {
  const token = newToken();
  game.access = {
    version: 1,
    legacyClaimRequired: false,
    hostTeamId,
    hostTokenHash: tokenHash(token),
    teamTokenHashes: {[hostTeamId]: tokenHash(token)}
  };
  return {token, role: 'host', teamId: hostTeamId};
}

function issueTeamAccess(game, teamId) {
  const access = ensureAccess(game);
  const token = newToken();
  access.teamTokenHashes[teamId] = tokenHash(token);
  return {token, role: 'manager', teamId};
}

function sessionForToken(game, token) {
  const access = ensureAccess(game);
  if (!token) return null;
  const hash = tokenHash(token);
  if (access.hostTokenHash && hash === access.hostTokenHash) return {role: 'host', teamId: access.hostTeamId};
  const teamId = Object.keys(access.teamTokenHashes).find(id => access.teamTokenHashes[id] === hash);
  return teamId ? {role: 'manager', teamId} : null;
}

function claimLegacyHost(game, confirmCode) {
  const access = ensureAccess(game);
  if (!access.legacyClaimRequired) throw new Error('该房间已经完成权限升级');
  if (String(confirmCode || '').trim().toUpperCase() !== game.id) throw new Error('房间码确认不匹配');
  return createHostAccess(game, access.hostTeamId);
}

module.exports = {claimLegacyHost, createHostAccess, ensureAccess, issueTeamAccess, sessionForToken};
