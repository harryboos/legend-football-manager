const {PLAYERS, positionFit, roleScore} = require('./players');
const {CUSTOM_FORMATION, formationSlots, normalizeCustomFormation, rulesFor} = require('./rules');
const {profileForTeam, roleBias} = require('./ai-manager');
const {availabilityFor, isPlayerAvailable} = require('./season');

function bestRole(player, roles, group, profile, phase) {
  return roles
    .map(role => ({role, score: roleScore(player, role, group) + roleBias(profile, role, phase)}))
    .sort((left, right) => right.score - left.score || left.role.localeCompare(right.role, 'zh-CN'))[0];
}

function lineupOption(game, player, slot, profile) {
  const rules = rulesFor(game);
  const inRole = bestRole(player, rules.inRoles[slot.group], slot.group, profile, 'in');
  const outRole = bestRole(player, rules.outRoles[slot.group], slot.group, profile, 'out');
  const fit = positionFit(player, slot);
  return {
    score: fit * 36 + inRole.score * 0.85 + outRole.score * 0.65 + player.rating / 12,
    assignment: {slotId: slot.id, playerId: player.id, inRole: inRole.role, outRole: outRole.role}
  };
}

function optimalAssignments(game, team, slots, players) {
  const profile = team.controller === 'AI' ? profileForTeam(team) : null;
  let states = Array(1 << slots.length).fill(null);
  states[0] = {score: 0, assignments: []};

  for (const playerId of team.squad.filter(playerId => isPlayerAvailable(game, playerId))) {
    const player = players.find(candidate => candidate.id === playerId);
    if (!player) continue;
    const options = slots.map(slot => lineupOption(game, player, slot, profile));
    const next = states.slice();
    for (let mask = 0; mask < states.length; mask++) {
      const state = states[mask];
      if (!state) continue;
      for (let slotIndex = 0; slotIndex < slots.length; slotIndex++) {
        const bit = 1 << slotIndex;
        if (mask & bit) continue;
        const candidate = {
          score: state.score + options[slotIndex].score,
          assignments: [...state.assignments, options[slotIndex].assignment]
        };
        const nextMask = mask | bit;
        if (!next[nextMask] || candidate.score > next[nextMask].score) next[nextMask] = candidate;
      }
    }
    states = next;
  }

  return states[states.length - 1]?.assignments || [];
}

function autoLineup(game, team, players = PLAYERS) {
  const rules = rulesFor(game);
  if (team.formation === CUSTOM_FORMATION) {
    try {
      team.customFormation = normalizeCustomFormation(team.customFormation, rules.starters);
    } catch {
      team.formation = Object.keys(rules.formations)[0];
      delete team.customFormation;
    }
  } else if (!rules.formations[team.formation]) team.formation = Object.keys(rules.formations)[0];
  const slots = formationSlots(game, team.formation, team.customFormation);
  const slotOrder = new Map(slots.map((slot, index) => [slot.id, index]));
  const assignments = optimalAssignments(game, team, slots, players)
    .sort((left, right) => slotOrder.get(left.slotId) - slotOrder.get(right.slotId));

  team.assignments = assignments;
  team.starters = assignments.map(assignment => assignment.playerId);
  team.mentality = rules.mentalities.includes(team.mentality) ? team.mentality : '平衡';
}

function setLineup(game, team, formation, mentality, assignments, customFormation) {
  const rules = rulesFor(game);
  if (formation && formation !== CUSTOM_FORMATION && !rules.formations[formation]) throw new Error('阵型不存在');
  if (mentality && !rules.mentalities.includes(mentality)) throw new Error('比赛心态不存在');
  const chosenFormation = formation || team.formation;
  const chosenCustomFormation = chosenFormation === CUSTOM_FORMATION
    ? normalizeCustomFormation(customFormation || team.customFormation, rules.starters)
    : null;
  const validSlots = formationSlots(game, chosenFormation, chosenCustomFormation);
  const slotMap = new Map(validSlots.map(slot => [slot.id, slot]));

  if (!Array.isArray(assignments)
    || assignments.length !== rules.starters
    || new Set(assignments.map(assignment => assignment.playerId)).size !== rules.starters
    || new Set(assignments.map(assignment => assignment.slotId)).size !== rules.starters) {
    throw new Error(`请为 ${rules.starters} 个位置各选择一名不同球员`);
  }

  for (const assignment of assignments) {
    const slot = slotMap.get(assignment.slotId);
    if (!slot || !team.squad.includes(assignment.playerId)) throw new Error('阵容位置或球员无效');
    const availability = availabilityFor(game, assignment.playerId);
    if (!availability.available) throw new Error(`${availability.label}的球员不能进入首发`);
    if (!rules.inRoles[slot.group].includes(assignment.inRole) || !rules.outRoles[slot.group].includes(assignment.outRole)) {
      throw new Error(`${slot.label}的职责无效`);
    }
  }

  team.formation = chosenFormation;
  if (chosenCustomFormation) team.customFormation = chosenCustomFormation;
  team.mentality = mentality || team.mentality || '平衡';
  team.assignments = assignments;
  team.starters = assignments.map(assignment => assignment.playerId);
}

function mentalityEffect(mentality) {
  return {谨慎: [-0.45, 0.55, -0.1], 平衡: [0, 0, 0], 积极: [0.35, -0.1, 0.2], 进攻: [0.75, -0.4, 0.3]}[mentality] || [0, 0, 0];
}

function teamMetrics(game, team) {
  const rules = rulesFor(game);
  if (!team.assignments || team.assignments.length !== rules.starters) autoLineup(game, team, game.players);
  let attack = 0;
  let defense = 0;
  let control = 0;
  let energy = 0;
  let keeper = 10;
  let fit = 0;
  let outfield = 0;

  for (const assignment of team.assignments) {
    const player = game.players.find(candidate => candidate.id === assignment.playerId);
    const slot = formationSlots(game, team.formation, team.customFormation).find(candidate => candidate.id === assignment.slotId);
    if (!player || !slot) continue;
    const playerFit = positionFit(player, slot);
    const inPossession = roleScore(player, assignment.inRole, slot.group) * playerFit;
    const outPossession = roleScore(player, assignment.outRole, slot.group) * playerFit;
    fit += playerFit;
    if (slot.group === 'GK') {
      keeper = (inPossession + outPossession) / 2;
      continue;
    }
    outfield++;
    control += (player.attributes.passing + player.attributes.firstTouch + player.attributes.decisions + player.attributes.vision) / 4 * playerFit;
    energy += (player.attributes.stamina + player.attributes.workRate + player.attributes.pace) / 3 * playerFit;
    attack += (inPossession + (player.attributes.finishing + player.attributes.offBall + player.attributes.dribbling) / 3) / 2;
    defense += (outPossession + (player.attributes.tackling + player.attributes.marking + player.attributes.positioning) / 3) / 2;
  }

  const divisor = Math.max(1, outfield);
  const effect = mentalityEffect(team.mentality);
  return {
    attack: attack / divisor + effect[0],
    defense: defense / divisor + effect[1],
    control: control / divisor + effect[2],
    energy: energy / divisor,
    keeper,
    fit: fit / rules.starters
  };
}

module.exports = {autoLineup, setLineup, teamMetrics};
