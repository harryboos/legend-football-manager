const {groupForPosition, positionFit} = require('./players');
const {formationSlots, rulesFor} = require('./rules');

const GROUPS = ['GK', 'FB', 'CB', 'DM', 'CM', 'AM', 'W', 'ST'];

const ARCHETYPES = {
  control: {
    attributes: ['passing', 'firstTouch', 'vision', 'decisions', 'composure'],
    inRoleBias: ['组织', '出球', '节拍', '内收'],
    outRoleBias: ['协防', '封锁', '回撤'],
    formations: ['4-3-3 DM', '4-3-3', '4-3-3 AM', '4-1-2-1-2', '4-1-4-1']
  },
  press: {
    attributes: ['workRate', 'stamina', 'aggression', 'pace', 'tackling'],
    inRoleBias: ['进攻', '突前', '影子', '前压'],
    outRoleBias: ['压迫', '逼抢', '前压'],
    formations: ['4-2-3-1', '4-3-3 DM', '4-2-2-2', '4-2-4', '3-4-3']
  },
  width: {
    attributes: ['crossing', 'pace', 'dribbling', 'stamina', 'offBall'],
    inRoleBias: ['边锋', '边后卫', '宽位', '站桩'],
    outRoleBias: ['回防', '压迫边卫'],
    formations: ['4-4-2', '4-1-4-1', '3-4-3', '5-4-1', '4-2-4']
  },
  counter: {
    attributes: ['pace', 'acceleration', 'offBall', 'finishing', 'decisions'],
    inRoleBias: ['突前', '穿插', '宽位', '拖后'],
    outRoleBias: ['封堵', '收缩', '协防'],
    formations: ['5-3-2', '3-5-2', '5-2-3', '4-3-1-2', '3-4-1-2']
  },
  defensive: {
    attributes: ['tackling', 'marking', 'positioning', 'strength', 'heading'],
    inRoleBias: ['拖后', '防守', '站桩'],
    outRoleBias: ['盯人', '协防', '屏障', '收缩'],
    formations: ['5-3-2', '5-4-1', '5-2-3', '4-1-4-1', '3-5-2']
  },
  fluid: {
    attributes: ['workRate', 'passing', 'firstTouch', 'offBall', 'stamina'],
    inRoleBias: ['全能', '自由', '回撤', '肋部'],
    outRoleBias: ['高位', '回撤', '积极'],
    formations: ['3-4-2-1', '3-4-1-2', '3-2-4-1', '4-3-3 AM', '4-1-2-1-2']
  }
};

const FORMATION_PLANS = {
  '4-3-3 DM': {GK: 2, FB: 3, CB: 3, DM: 2, CM: 3, AM: 0, W: 3, ST: 2},
  '4-2-3-1': {GK: 2, FB: 3, CB: 3, DM: 3, CM: 1, AM: 2, W: 2, ST: 2},
  '4-4-2': {GK: 2, FB: 3, CB: 3, DM: 1, CM: 3, AM: 0, W: 3, ST: 3},
  '3-4-2-1': {GK: 2, FB: 3, CB: 4, DM: 1, CM: 2, AM: 3, W: 1, ST: 2},
  '4-1-4-1': {GK: 2, FB: 3, CB: 3, DM: 2, CM: 3, AM: 1, W: 3, ST: 1},
  '4-3-1-2': {GK: 2, FB: 3, CB: 3, DM: 1, CM: 3, AM: 2, W: 1, ST: 3},
  '4-2-2-2': {GK: 2, FB: 3, CB: 3, DM: 3, CM: 1, AM: 3, W: 0, ST: 3},
  '3-5-2': {GK: 2, FB: 3, CB: 4, DM: 2, CM: 3, AM: 1, W: 0, ST: 3},
  '5-2-3': {GK: 2, FB: 3, CB: 4, DM: 1, CM: 2, AM: 1, W: 3, ST: 2},
  '3-4-3': {GK: 2, FB: 3, CB: 4, DM: 1, CM: 2, AM: 1, W: 3, ST: 2},
  '5-3-2': {GK: 2, FB: 3, CB: 4, DM: 2, CM: 3, AM: 0, W: 1, ST: 3},
  '4-3-3 AM': {GK: 2, FB: 3, CB: 3, DM: 1, CM: 3, AM: 2, W: 3, ST: 1},
  '4-3-3': {GK: 2, FB: 3, CB: 3, DM: 1, CM: 4, AM: 0, W: 3, ST: 2},
  '4-1-2-1-2': {GK: 2, FB: 3, CB: 3, DM: 2, CM: 3, AM: 2, W: 0, ST: 3},
  '4-2-4': {GK: 2, FB: 3, CB: 3, DM: 3, CM: 1, AM: 0, W: 3, ST: 3},
  '3-4-1-2': {GK: 2, FB: 3, CB: 4, DM: 1, CM: 3, AM: 2, W: 0, ST: 3},
  '3-2-4-1': {GK: 2, FB: 1, CB: 4, DM: 3, CM: 1, AM: 3, W: 2, ST: 2},
  '5-4-1': {GK: 2, FB: 3, CB: 4, DM: 1, CM: 3, AM: 0, W: 3, ST: 2}
};

const PROFILE_DATA = [
  ['am01', '顾远', '传控组织', '4-3-3 DM', '平衡', 'control'],
  ['am02', '韩锋', '高位压迫', '4-2-3-1', '积极', 'press'],
  ['am03', '罗毅', '边路冲击', '4-4-2', '积极', 'width'],
  ['am04', '沈策', '半空间创造', '3-4-2-1', '平衡', 'fluid'],
  ['am05', '杜衡', '中场封锁', '4-1-4-1', '谨慎', 'defensive'],
  ['am06', '高岳', '窄路渗透', '4-3-1-2', '积极', 'control'],
  ['am07', '陈拓', '双十号压迫', '4-2-2-2', '进攻', 'press'],
  ['am08', '林川', '三中卫反击', '3-5-2', '平衡', 'counter'],
  ['am09', '周岩', '纵深保护', '5-2-3', '谨慎', 'defensive'],
  ['am10', '许哲', '全攻全守', '3-4-3', '进攻', 'fluid'],
  ['am11', '魏铮', '五后卫反击', '5-3-2', '谨慎', 'counter'],
  ['am12', '白启', '技术进攻', '4-3-3 AM', '进攻', 'control'],
  ['am13', '贺鸣', '节奏控制', '4-3-3 DM', '平衡', 'control'],
  ['am14', '唐锐', '快速转换', '4-2-3-1', '积极', 'counter'],
  ['am15', '蒋驰', '双锋制空', '4-4-2', '进攻', 'width'],
  ['am16', '梁盛', '弹性三后卫', '3-4-2-1', '积极', 'fluid'],
  ['am17', '苏哲', '阵地控制', '4-1-4-1', '平衡', 'control'],
  ['am18', '秦岳', '中路突击', '4-3-1-2', '进攻', 'counter'],
  ['am19', '陆骁', '翼卫推进', '3-5-2', '积极', 'width'],
  ['am20', '彭峻', '低位防反', '5-3-2', '谨慎', 'defensive']
];

const AI_MANAGER_PROFILES = PROFILE_DATA.map(([id, manager, style, formation, mentality, archetype]) => ({
  id,
  manager,
  style,
  formation,
  mentality,
  ...ARCHETYPES[archetype]
}));

function teamIndex(team) {
  const parsed = Number(String(team?.id || '').replace(/^t/, ''));
  return Number.isInteger(parsed) && parsed > 0 ? parsed - 1 : 0;
}

function seededValue(seed, key) {
  const text = `${Number(seed) >>> 0}:${key}`;
  let value = 2166136261;
  for (const char of text) {
    value ^= char.charCodeAt(0);
    value = Math.imul(value, 16777619);
  }
  return (value >>> 0) / 4294967295;
}

function profileForIndex(index, seed) {
  const profiles = seed
    ? [...AI_MANAGER_PROFILES].sort((left, right) => seededValue(seed, `manager:${left.id}`) - seededValue(seed, `manager:${right.id}`))
    : AI_MANAGER_PROFILES;
  return profiles[index % profiles.length];
}

function profileForTeam(team) {
  return AI_MANAGER_PROFILES.find(profile => profile.id === team?.aiProfile) || profileForIndex(teamIndex(team));
}

function formationForProfile(profile, seed, teamId, rules) {
  const alternatives = (profile.formations || []).filter(formation => formation !== profile.formation);
  const weighted = [profile.formation, profile.formation, ...alternatives]
    .filter(formation => rules.formations[formation]);
  if (!weighted.length) return Object.keys(rules.formations)[0];
  const index = Math.floor(seededValue(seed, `formation:${teamId}:${profile.id}`) * weighted.length);
  return weighted[Math.min(index, weighted.length - 1)];
}

function squadPlanFor(game, team) {
  if (FORMATION_PLANS[team.formation]) return FORMATION_PLANS[team.formation];
  const rules = rulesFor(game);
  const slots = formationSlots(game, team.formation, team.customFormation);
  const counts = Object.fromEntries(GROUPS.map(group => [group, slots.filter(slot => slot.group === group).length]));
  counts.GK = Math.max(2, counts.GK);
  while (Object.values(counts).reduce((sum, value) => sum + value, 0) < rules.squadSize) {
    const group = GROUPS.filter(candidate => candidate !== 'GK').sort((left, right) => {
      const leftSlots = slots.filter(slot => slot.group === left).length;
      const rightSlots = slots.filter(slot => slot.group === right).length;
      return rightSlots / Math.max(1, counts[right]) - leftSlots / Math.max(1, counts[left]);
    })[0] || 'CM';
    counts[group]++;
  }
  return counts;
}

function stablePreference(game, team, player) {
  return seededValue(game.seed, `draft:${team.id}:${player.id}`);
}

function tacticalAttributeScore(player, profile) {
  const keys = profile.attributes || [];
  return keys.reduce((sum, key) => sum + (player.attributes[key] || 1), 0) / Math.max(1, keys.length) * 5;
}

function candidateDraftScore(game, team, player) {
  const rules = rulesFor(game);
  const profile = profileForTeam(team);
  const plan = squadPlanFor(game, team);
  const counts = Object.fromEntries(GROUPS.map(group => [group, 0]));
  for (const playerId of team.squad) {
    const selected = game.players.find(candidate => candidate.id === playerId);
    if (selected) counts[groupForPosition(selected.position)]++;
  }

  const group = groupForPosition(player.position);
  const target = plan[group] || 0;
  const deficit = target - counts[group];
  const progress = team.squad.length / Math.max(1, rules.squadSize - 1);
  const needScore = deficit > 0
    ? (8 + progress * 32) * Math.min(1.4, deficit / Math.max(1, target) + 0.55)
    : -(10 + progress * 42) * (1 + Math.max(0, counts[group] - target) * 0.3);

  const slots = formationSlots(game, team.formation, team.customFormation);
  const formationFit = Math.max(...slots.map(slot => positionFit(player, slot)), 0.25) * 100;
  const selectedPlayers = team.squad.map(id => game.players.find(candidate => candidate.id === id)).filter(Boolean);
  const uncoveredImprovement = Math.max(...slots.map(slot => {
    const currentFit = Math.max(...selectedPlayers.map(selected => positionFit(selected, slot)), 0.25);
    return Math.max(0, positionFit(player, slot) - currentFit);
  }), 0) * 18;
  const versatility = Object.values(player.positionFamiliarity || {}).filter(value => value >= 72).length;
  const samePosition = selectedPlayers.filter(selected => selected.position === player.position).length;

  return player.rating * 0.56
    + tacticalAttributeScore(player, profile) * 0.2
    + formationFit * 0.13
    + needScore
    + uncoveredImprovement
    + Math.min(5, versatility) * 0.7
    - Math.max(0, samePosition - 1) * (1.5 + progress * 2)
    + (stablePreference(game, team, player) - 0.5) * 2.5;
}

function roleBias(profile, role, phase) {
  const terms = phase === 'in' ? profile?.inRoleBias : profile?.outRoleBias;
  return (terms || []).reduce((bonus, term) => bonus + (role.includes(term) ? 0.9 : 0), 0);
}

module.exports = {
  AI_MANAGER_PROFILES,
  candidateDraftScore,
  formationForProfile,
  profileForIndex,
  profileForTeam,
  roleBias,
  squadPlanFor
};
