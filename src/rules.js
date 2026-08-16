const cfg = require('../config');

const CUSTOM_FORMATION = '自定义';
const CUSTOM_GROUPS = new Set(['GK', 'FB', 'CB', 'DM', 'CM', 'AM', 'W', 'ST']);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createRuleSnapshot() {
  return {
    version: 2,
    teamCount: cfg.TEAM_COUNT,
    squadSize: cfg.SQUAD_SIZE,
    starters: cfg.STARTERS,
    draftMode: cfg.DRAFT_MODE,
    homeAdvantage: cfg.HOME_ADVANTAGE,
    randomness: cfg.RANDOMNESS,
    formations: clone(cfg.FORMATIONS),
    inRoles: clone(cfg.IN_POSSESSION_ROLES),
    outRoles: clone(cfg.OUT_POSSESSION_ROLES),
    mentalities: [...cfg.MENTALITIES]
  };
}

function rulesFor(game) {
  return game.rules || createRuleSnapshot();
}

function customGroup(x, y) {
  const wide = x < 24 || x > 76;
  if (y <= 31) return wide ? 'FB' : 'CB';
  if (y <= 46) return wide ? 'FB' : 'DM';
  if (y <= 63) return wide ? 'W' : 'CM';
  if (y <= 79) return wide ? 'W' : 'AM';
  return wide ? 'W' : 'ST';
}

function customLabel(group, x) {
  const side = x < 42 ? '左' : x > 58 ? '右' : '';
  return {
    GK: '门将',
    FB: `${side}边后卫`,
    CB: `${side}中后卫`,
    DM: `${side}后腰`,
    CM: `${side}中场`,
    AM: `${side}前腰`,
    W: `${side}边锋`,
    ST: `${side}前锋`
  }[group];
}

function normalizeCustomFormation(slots, starters = 11) {
  if (!Array.isArray(slots) || slots.length !== starters) throw new Error(`自定义阵型必须包含 ${starters} 个位置`);
  return slots.map((slot, index) => {
    const rawX = Number(slot?.x);
    const rawY = Number(slot?.y);
    if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) throw new Error('自定义阵型坐标无效');
    const x = Math.round(Math.max(6, Math.min(94, rawX)));
    const y = index === 0 ? 8 : Math.round(Math.max(17, Math.min(92, rawY)));
    const group = index === 0 ? 'GK' : customGroup(x, y);
    if (!CUSTOM_GROUPS.has(group)) throw new Error('自定义阵型位置类型无效');
    return {
      id: `C${String(index + 1).padStart(2, '0')}`,
      label: customLabel(group, x),
      group,
      x,
      y
    };
  });
}

function formationSlots(game, formation, customFormation) {
  const rules = rulesFor(game);
  if (formation === CUSTOM_FORMATION) return normalizeCustomFormation(customFormation, rules.starters);
  const fallback = Object.keys(rules.formations)[0];
  return (rules.formations[formation] || rules.formations[fallback]).map(slot => ({
    id: slot[0],
    label: slot[1],
    group: slot[2]
  }));
}

module.exports = {CUSTOM_FORMATION, createRuleSnapshot, rulesFor, formationSlots, normalizeCustomFormation};
