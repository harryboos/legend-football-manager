const {RAW_PLAYERS} = require('./player-data');

const ATTRIBUTE_LABELS = {
  technical: {finishing: '射门', passing: '传球', dribbling: '盘带', firstTouch: '停球', tackling: '抢断', marking: '盯人', heading: '头球', crossing: '传中'},
  mental: {vision: '视野', decisions: '决断', offBall: '无球跑动', positioning: '防守站位', workRate: '工作投入', composure: '镇定', aggression: '侵略性'},
  physical: {pace: '速度', acceleration: '爆发力', stamina: '耐力', strength: '强壮', agility: '灵活', jumping: '弹跳'},
  goalkeeping: {reflexes: '反应', handling: '手控球', oneOnOnes: '一对一', aerialReach: '制空', distribution: '开球'}
};

const POSITION_LABELS = {GK: '门将', LB: '左后卫', CB: '中后卫', RB: '右后卫', LWB: '左翼卫', RWB: '右翼卫', DM: '后腰', CM: '中场', AM: '前腰', LW: '左边锋', RW: '右边锋', ST: '中锋'};
const ALL_ATTRIBUTE_KEYS = Object.values(ATTRIBUTE_LABELS).flatMap(group => Object.keys(group));
const POSITION_KEYS = Object.keys(POSITION_LABELS);
const BODY_PROFILES = {
  GK: [191, 86], FB: [178, 72], CB: [188, 82], DM: [183, 78],
  CM: [180, 74], AM: [177, 72], W: [176, 70], ST: [185, 80]
};
const BODY_OVERRIDES = {
  梅西: [170, 72], C罗: [187, 83], 姆巴佩: [178, 75], 哈兰德: [195, 94],
  德布劳内: [181, 70], 罗德里: [191, 82], 贝林厄姆: [186, 75], 萨拉赫: [175, 71],
  维尼修斯: [176, 73], 凯恩: [188, 86], 亚马尔: [180, 72], 范戴克: [195, 92],
  阿利松: [193, 91], 库尔图瓦: [200, 96], 多纳鲁马: [196, 90], 贝利: [173, 70],
  马拉多纳: [165, 67], 罗纳尔多: [183, 82], 齐达内: [185, 80], 克鲁伊夫: [178, 74],
  贝肯鲍尔: [181, 75], 雅辛: [189, 82], 马尔蒂尼: [186, 85], 罗纳尔迪尼奥: [182, 80],
  哈维: [170, 68], 伊涅斯塔: [171, 68], 亨利: [188, 83], 布冯: [192, 92],
  卡西利亚斯: [182, 84], 诺伊尔: [193, 93]
};

function hash(text) {
  let value = 2166136261;
  for (const char of text) {
    value ^= char.charCodeAt(0);
    value = Math.imul(value, 16777619);
  }
  return (value >>> 0) / 4294967295;
}

function clamp(value) {
  return Math.max(1, Math.min(20, Math.round(value)));
}

function groupForPosition(position) {
  if (position === 'GK') return 'GK';
  if (['LB', 'RB', 'LWB', 'RWB'].includes(position)) return 'FB';
  if (position === 'CB') return 'CB';
  if (position === 'DM') return 'DM';
  if (position === 'CM') return 'CM';
  if (position === 'AM') return 'AM';
  if (['LW', 'RW'].includes(position)) return 'W';
  return 'ST';
}

function makeBodyProfile(name, positions) {
  const override = BODY_OVERRIDES[name];
  if (override) return {heightCm: override[0], weightKg: override[1]};
  const profile = BODY_PROFILES[groupForPosition(positions[0])] || BODY_PROFILES.CM;
  const heightCm = Math.max(164, Math.min(203, Math.round(profile[0] + (hash(`${name}:height`) - 0.5) * 10)));
  const weightKg = Math.max(58, Math.min(102, Math.round(profile[1] + (heightCm - profile[0]) * 0.65 + (hash(`${name}:weight`) - 0.5) * 6)));
  return {heightCm, weightKg};
}

function relatedFamiliarity(source, target) {
  if (source === target) return 100;
  if (source === 'GK' || target === 'GK') return 4;
  const sourceGroup = groupForPosition(source);
  const targetGroup = groupForPosition(target);
  if (sourceGroup === targetGroup) {
    if (sourceGroup === 'FB') {
      const sameSide = (source.startsWith('L') && target.startsWith('L')) || (source.startsWith('R') && target.startsWith('R'));
      return sameSide ? 88 : 55;
    }
    if (sourceGroup === 'W') return 72;
    return 86;
  }
  const transitions = {
    FB: {CB: 56, DM: 48, W: 55},
    CB: {FB: 56, DM: 62},
    DM: {CB: 62, FB: 48, CM: 84},
    CM: {DM: 84, AM: 82, W: 58},
    AM: {CM: 82, W: 76, ST: 68},
    W: {FB: 55, CM: 58, AM: 76, ST: 68},
    ST: {AM: 68, W: 68}
  };
  return transitions[sourceGroup]?.[targetGroup] || 18;
}

function makePositionFamiliarity(positions) {
  const goalkeeper = positions.includes('GK');
  const familiarity = Object.fromEntries(POSITION_KEYS.map(position => [position, position === 'GK' ? 3 : goalkeeper ? 4 : 18]));
  positions.forEach((source, index) => {
    const natural = Math.max(86, 100 - index * 8);
    familiarity[source] = Math.max(familiarity[source], natural);
    for (const target of POSITION_KEYS) {
      if (target === source) continue;
      const related = relatedFamiliarity(source, target) - index * 4;
      familiarity[target] = Math.max(familiarity[target], related);
    }
  });
  return familiarity;
}

function positionForSlot(slot) {
  if (!slot) return null;
  const id = String(slot.id || '');
  if (slot.group === 'GK' || id === 'GK') return 'GK';
  if (slot.group === 'CB') return 'CB';
  if (slot.group === 'FB') return (Number(slot.x) || (id.startsWith('L') ? 25 : 75)) < 50 ? 'LB' : 'RB';
  if (slot.group === 'DM') return 'DM';
  if (slot.group === 'CM') return 'CM';
  if (slot.group === 'AM') return 'AM';
  if (slot.group === 'W') return (Number(slot.x) || (id.startsWith('L') ? 25 : 75)) < 50 ? 'LW' : 'RW';
  return 'ST';
}

function positionFamiliarity(player, slot) {
  const position = typeof slot === 'string' ? slot : positionForSlot(slot);
  return Number(player?.positionFamiliarity?.[position]) || 0;
}

function makeAttributes(name, rating, positions) {
  const base = 8 + (rating - 75) * 0.43;
  const attributes = {};
  for (const key of ALL_ATTRIBUTE_KEYS) attributes[key] = clamp(base + (hash(name + key) - 0.5) * 4);
  const boost = (keys, amount) => keys.forEach(key => { attributes[key] = clamp(attributes[key] + amount); });
  const groups = positions.map(groupForPosition);

  if (groups.includes('GK')) {
    Object.keys(ATTRIBUTE_LABELS.technical).forEach(key => { attributes[key] = clamp(attributes[key] - 5); });
    boost(Object.keys(ATTRIBUTE_LABELS.goalkeeping), 3);
    boost(['decisions', 'positioning', 'composure', 'agility', 'jumping'], 1);
  } else {
    Object.keys(ATTRIBUTE_LABELS.goalkeeping).forEach(key => { attributes[key] = clamp(2 + hash(key + name) * 3); });
    if (groups.some(group => ['FB', 'CB'].includes(group))) boost(['tackling', 'marking', 'positioning', 'heading', 'strength'], 2);
    if (groups.some(group => ['DM', 'CM', 'AM'].includes(group))) boost(['passing', 'firstTouch', 'vision', 'decisions', 'workRate'], 2);
    if (groups.some(group => ['W', 'ST'].includes(group))) boost(['finishing', 'dribbling', 'offBall', 'pace', 'acceleration'], 2);
    if (groups.some(group => ['FB', 'W'].includes(group))) boost(['crossing', 'pace', 'stamina'], 1);
  }
  return attributes;
}

function categoryAverages(attributes) {
  return Object.fromEntries(Object.entries(ATTRIBUTE_LABELS).map(([group, labels]) => {
    const keys = Object.keys(labels);
    return [group, Math.round(keys.reduce((sum, key) => sum + attributes[key], 0) / keys.length)];
  }));
}

const PLAYERS = RAW_PLAYERS.map(([name, era, positions, rating], index) => {
  const attributes = makeAttributes(name, rating, positions);
  const body = makeBodyProfile(name, positions);
  return {
    id: `p${index + 1}`,
    name,
    era,
    position: positions[0],
    positions,
    positionFamiliarity: makePositionFamiliarity(positions),
    ...body,
    rating,
    attributes,
    categoryAverages: categoryAverages(attributes)
  };
});

function positionFit(player, slot) {
  if (!player) return 0;
  return 0.25 + positionFamiliarity(player, slot) / 100 * 0.75;
}

function roleKeys(role, group) {
  if (group === 'GK') {
    if (role.includes('出球')) return ['distribution', 'passing', 'firstTouch', 'decisions', 'composure'];
    if (role.includes('自由') || role.includes('积极')) return ['oneOnOnes', 'pace', 'decisions', 'reflexes', 'distribution'];
    return ['reflexes', 'handling', 'oneOnOnes', 'aerialReach', 'positioning'];
  }
  if (/组织|节拍/.test(role)) return ['passing', 'vision', 'decisions', 'firstTouch', 'composure'];
  if (/站桩/.test(role)) return ['strength', 'heading', 'jumping', 'finishing', 'firstTouch'];
  if (/进攻|突前|影子|穿插|内切|宽位/.test(role)) return ['pace', 'acceleration', 'dribbling', 'offBall', 'finishing'];
  if (/压迫|高位|前压|逼抢/.test(role)) return ['workRate', 'stamina', 'aggression', 'tackling', 'pace'];
  if (/防守|屏障|盯人|协防|封锁|收缩|回防/.test(role)) return ['tackling', 'marking', 'positioning', 'decisions', 'strength'];
  if (/回撤|全能/.test(role)) return ['workRate', 'stamina', 'passing', 'firstTouch', 'offBall'];
  const defaults = {
    FB: ['tackling', 'crossing', 'pace', 'stamina', 'positioning'],
    CB: ['tackling', 'marking', 'heading', 'positioning', 'strength'],
    DM: ['tackling', 'positioning', 'passing', 'decisions', 'workRate'],
    CM: ['passing', 'vision', 'decisions', 'workRate', 'firstTouch'],
    AM: ['passing', 'vision', 'dribbling', 'offBall', 'firstTouch'],
    W: ['dribbling', 'pace', 'crossing', 'offBall', 'acceleration'],
    ST: ['finishing', 'offBall', 'composure', 'firstTouch', 'pace']
  };
  return defaults[group] || ['decisions', 'workRate', 'stamina'];
}

function roleScore(player, role, group) {
  const keys = roleKeys(role, group);
  return keys.reduce((sum, key) => sum + (player.attributes[key] || 1), 0) / keys.length;
}

module.exports = {PLAYERS, ATTRIBUTE_LABELS, POSITION_LABELS, groupForPosition, positionForSlot, positionFamiliarity, positionFit, roleScore};
