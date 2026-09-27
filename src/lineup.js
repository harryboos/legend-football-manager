const {PLAYERS, positionFit, roleScore} = require('./players');
const {CUSTOM_FORMATION, formationSlots, normalizeCustomFormation, rulesFor} = require('./rules');
const {profileForTeam, roleBias} = require('./ai-manager');
const {availabilityFor, isPlayerAvailable} = require('./season');

function bestRole(player, roles, group, profile, phase) {
  let best;
  for (const role of roles) {
    const score = roleScore(player, role, group) + roleBias(profile, role, phase);
    if (!best || score > best.score || (score === best.score && role.localeCompare(best.role, 'zh-CN') < 0)) {
      best = {role, score};
    }
  }
  return best;
}

function lineupOption(player, slot, inRole, outRole) {
  const fit = positionFit(player, slot);
  return {
    score: fit * 36 + inRole.score * 0.85 + outRole.score * 0.65 + player.rating / 12,
    assignment: {slotId: slot.id, playerId: player.id, inRole: inRole.role, outRole: outRole.role}
  };
}

function optimalAssignments(game, team, slots, players) {
  const rules = rulesFor(game);
  const profile = team.controller === 'AI' ? profileForTeam(team) : null;
  const playerById = new Map(players.map(player => [player.id, player]));
  let states = Array(1 << slots.length).fill(null);
  states[0] = {score: 0, previous: null};

  for (const playerId of team.squad) {
    const player = playerById.get(playerId);
    if (!player || !isPlayerAvailable(game, playerId)) continue;
    const rolesByGroup = new Map();
    const options = slots.map(slot => {
      if (!rolesByGroup.has(slot.group)) {
        rolesByGroup.set(slot.group, [
          bestRole(player, rules.inRoles[slot.group], slot.group, profile, 'in'),
          bestRole(player, rules.outRoles[slot.group], slot.group, profile, 'out')
        ]);
      }
      return lineupOption(player, slot, ...rolesByGroup.get(slot.group));
    });
    const next = states.slice();
    for (let mask = 0; mask < states.length; mask++) {
      const state = states[mask];
      if (!state) continue;
      for (let slotIndex = 0; slotIndex < slots.length; slotIndex++) {
        const bit = 1 << slotIndex;
        if (mask & bit) continue;
        const score = state.score + options[slotIndex].score;
        const nextMask = mask | bit;
        if (!next[nextMask] || score > next[nextMask].score) {
          // Retain only winning paths; reconstruct the lineup once after all players.
          next[nextMask] = {score, previous: state, assignment: options[slotIndex].assignment};
        }
      }
    }
    states = next;
  }

  const assignments = [];
  for (let state = states[states.length - 1]; state?.assignment; state = state.previous) {
    assignments.push(state.assignment);
  }
  return assignments.reverse();
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
    || assignments.some(assignment => !assignment || typeof assignment !== 'object')
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
  const playerById = new Map(game.players.map(player => [player.id, player]));
  const slotById = new Map(formationSlots(game, team.formation, team.customFormation).map(slot => [slot.id, slot]));
  let attack = 0;
  let defense = 0;
  let control = 0;
  let energy = 0;
  let keeper = 10;
  let fit = 0;
  let outfield = 0;

  for (const assignment of team.assignments) {
    const player = playerById.get(assignment.playerId);
    const slot = slotById.get(assignment.slotId);
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
