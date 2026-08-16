const crypto = require('crypto');
const {PLAYERS, ATTRIBUTE_LABELS, POSITION_LABELS, positionFit, roleScore} = require('./players');
const {CUSTOM_FORMATION, createRuleSnapshot, rulesFor, formationSlots, normalizeCustomFormation} = require('./rules');
const {createSchedule, rebalanceRemainingSchedule} = require('./schedule');
const {availablePlayers, currentDraftTeam, aiChoice, draftPick, runAiDraft} = require('./draft');
const {autoLineup, setLineup} = require('./lineup');
const {playRound, leagueTable} = require('./match');
const {ensureGameReports} = require('./report');

const TEAM_NAMES = ['北京龙', '上海星港', '广州雄狮', '深圳鹏城', '成都凤凰', '重庆山城', '武汉江豚', '杭州钱潮', '南京金陵', '苏州园林', '天津海河', '青岛海风', '大连浪潮', '济南泰山', '西安长安', '郑州中原', '长沙湘军', '厦门鹭岛', '昆明云岭', '沈阳铁骑'];

function randomUint32() {
  return crypto.randomBytes(4).readUInt32LE(0) || 1;
}

function seedFromText(text) {
  let value = 2166136261;
  for (const char of String(text)) {
    value ^= char.charCodeAt(0);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0 || 1;
}

function createGame(name, host, options = {}) {
  const rules = options.rules || createRuleSnapshot();
  if (rules.teamCount !== TEAM_NAMES.length) throw new Error(`当前球队名称数量固定为 ${TEAM_NAMES.length}`);
  if (PLAYERS.length < rules.teamCount * rules.squadSize) throw new Error('球员数量不足以完成选秀');
  const formation = Object.keys(rules.formations)[0];
  const teams = TEAM_NAMES.map((teamName, index) => ({
    id: `t${index + 1}`,
    name: teamName,
    controller: 'AI',
    manager: '电脑经理',
    squad: [],
    starters: [],
    assignments: [],
    formation,
    mentality: '平衡'
  }));
  const hostTeam = options.hostTeamId ? teams.find(team => team.id === options.hostTeamId) : teams[0];
  if (!hostTeam) throw new Error('所选开局球队不存在');
  hostTeam.controller = 'human';
  hostTeam.manager = host || '房主';
  const seed = options.seed >>> 0 || randomUint32();

  return {
    schemaVersion: 2,
    playerLibraryVersion: 2,
    id: options.id || crypto.randomBytes(4).toString('hex').slice(0, 6).toUpperCase(),
    name: name || '传奇经理联赛',
    phase: 'lobby',
    createdAt: new Date().toISOString(),
    rules,
    seed,
    rngState: seed,
    scheduleVersion: 2,
    teams,
    players: PLAYERS,
    draft: {order: teams.map(team => team.id), pick: 0, complete: false},
    rounds: createSchedule(teams.map(team => team.id)),
    currentRound: 0,
    results: [],
    scorers: {},
    reportVersion: 1
  };
}

function migrateGame(game) {
  const shouldRefreshLineups = game.playerLibraryVersion !== 2;
  game.schemaVersion = 2;
  game.playerLibraryVersion = 2;
  game.rules = game.rules || createRuleSnapshot();
  const rules = rulesFor(game);
  game.players = PLAYERS;
  game.seed = game.seed >>> 0 || seedFromText(game.id);
  game.rngState = game.rngState >>> 0 || game.seed;
  game.results = Array.isArray(game.results) ? game.results : [];
  game.scorers = game.scorers || {};
  game.currentRound = Number.isInteger(game.currentRound) ? game.currentRound : 0;
  game.draft = game.draft || {order: game.teams.map(team => team.id), pick: 0, complete: false};

  const canSafelyReplaceSchedule = game.currentRound === 0 && game.results.length === 0;
  if (!Array.isArray(game.rounds) || !game.rounds.length || (game.scheduleVersion !== 2 && canSafelyReplaceSchedule)) {
    game.rounds = createSchedule(game.teams.map(team => team.id));
    game.scheduleVersion = 2;
  } else if (game.scheduleVersion !== 2) {
    game.rounds = rebalanceRemainingSchedule(game.rounds, game.currentRound, game.teams.map(team => team.id));
    game.scheduleVersion = 2;
  }

  const fallbackFormation = Object.keys(rules.formations)[0];
  game.teams.forEach(team => {
    if (team.formation === CUSTOM_FORMATION) {
      try {
        team.customFormation = normalizeCustomFormation(team.customFormation, rules.starters);
      } catch {
        team.formation = fallbackFormation;
        delete team.customFormation;
      }
    } else if (!rules.formations[team.formation]) team.formation = fallbackFormation;
    team.mentality = rules.mentalities.includes(team.mentality) ? team.mentality : '平衡';
    team.squad = Array.isArray(team.squad) ? team.squad.filter(id => PLAYERS.some(player => player.id === id)) : [];
  });

  if (['season', 'finished'].includes(game.phase) && game.teams.some(team => team.squad.length < rules.squadSize)) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const team of game.teams) {
        if (team.squad.length >= rules.squadSize) continue;
        const player = aiChoice(game, team);
        if (player) {
          team.squad.push(player.id);
          changed = true;
        }
      }
    }
  }

  game.teams.forEach(team => {
    if (team.squad.length >= rules.starters && (shouldRefreshLineups || !Array.isArray(team.assignments) || team.assignments.length !== rules.starters)) {
      autoLineup(game, team, game.players);
    }
  });
  ensureGameReports(game);
  return game;
}

function publicGame(game) {
  migrateGame(game);
  const rules = rulesFor(game);
  const {rules: storedRules, rngState, ...state} = game;
  const topScorers = Object.entries(game.scorers)
    .map(([id, goals]) => {
      const player = game.players.find(candidate => candidate.id === id);
      return player ? {...player, goals} : null;
    })
    .filter(Boolean)
    .sort((left, right) => right.goals - left.goals)
    .slice(0, 20);

  return {
    ...state,
    availablePlayers: availablePlayers(game),
    currentDraftTeam: currentDraftTeam(game),
    table: leagueTable(game),
    topScorers,
    config: {
      squadSize: rules.squadSize,
      starters: rules.starters,
      formations: Object.fromEntries(Object.keys(rules.formations).map(formation => [formation, formationSlots(game, formation)])),
      customFormationName: CUSTOM_FORMATION,
      inRoles: rules.inRoles,
      outRoles: rules.outRoles,
      mentalities: rules.mentalities,
      attributeLabels: ATTRIBUTE_LABELS,
      positionLabels: POSITION_LABELS
    }
  };
}

module.exports = {
  createGame,
  migrateGame,
  publicGame,
  draftPick,
  runAiDraft,
  playRound,
  autoLineup,
  setLineup,
  positionFit,
  roleScore,
  createSchedule,
  rebalanceRemainingSchedule,
  rulesFor,
  normalizeCustomFormation,
  PLAYERS
};
