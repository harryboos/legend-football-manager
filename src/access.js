function ensureAccess(game) {
  if (!game.access || typeof game.access !== 'object') {
    game.access = {
      version: 3,
      legacyClaimRequired: true,
      hostTeamId: game.teams.find(team => team.controller === 'human')?.id || game.teams[0]?.id,
      hostUserId: null,
      teamUserIds: {}
    };
  }
  game.access.hostTeamId = game.access.hostTeamId || game.teams.find(team => team.controller === 'human')?.id || game.teams[0]?.id;
  game.access.teamUserIds = game.access.teamUserIds || {};
  game.access.hostUserId = game.access.hostUserId || null;
  delete game.access.hostTokenHash;
  delete game.access.teamTokenHashes;
  delete game.access.passwordSalt;
  delete game.access.passwordHash;
  return game.access;
}

function createHostOwnership(game, hostTeamId, userId) {
  const access = ensureAccess(game);
  access.version = 3;
  access.legacyClaimRequired = false;
  access.hostTeamId = hostTeamId;
  access.hostUserId = userId;
  access.teamUserIds = {[hostTeamId]: userId};
  return {role: 'host', teamId: hostTeamId};
}

function issueTeamOwnership(game, teamId, userId) {
  const access = ensureAccess(game);
  const existing = sessionForUser(game, userId);
  if (existing) throw new Error('当前账号已经在此房间管理一支球队');
  if (access.teamUserIds[teamId]) throw new Error('所选球队已经被其他账号占用');
  access.version = 3;
  access.teamUserIds[teamId] = userId;
  return {role: 'manager', teamId};
}

function sessionForUser(game, userId) {
  const access = ensureAccess(game);
  if (!userId) return null;
  if (access.hostUserId === userId) return {role: 'host', teamId: access.hostTeamId};
  const teamId = Object.keys(access.teamUserIds).find(id => access.teamUserIds[id] === userId);
  return teamId ? {role: 'manager', teamId} : null;
}

function claimLegacyHost(game, confirmCode, userId) {
  const access = ensureAccess(game);
  if (access.hostUserId) throw new Error('该房间已经绑定房主账号');
  if (String(confirmCode || '').trim().toUpperCase() !== game.id) throw new Error('房间码确认不匹配');
  access.version = 3;
  access.legacyClaimRequired = false;
  access.hostUserId = userId;
  access.teamUserIds[access.hostTeamId] = userId;
  return {role: 'host', teamId: access.hostTeamId};
}

module.exports = {
  claimLegacyHost,
  createHostOwnership,
  ensureAccess,
  issueTeamOwnership,
  sessionForUser
};
