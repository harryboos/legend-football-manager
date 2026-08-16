const {PLAYERS, positionFit, roleScore} = require('./players');
const {CUSTOM_FORMATION, formationSlots, normalizeCustomFormation, rulesFor} = require('./rules');

function defaultAssignment(game, slot, playerId) {
  const rules = rulesFor(game);
  return {
    slotId: slot.id,
    playerId,
    inRole: rules.inRoles[slot.group][0],
    outRole: rules.outRoles[slot.group][0]
  };
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
  const remaining = [...team.squad];
  const assignments = [];

  for (const slot of formationSlots(game, team.formation, team.customFormation)) {
    const best = remaining.sort((leftId, rightId) => {
      const left = players.find(player => player.id === leftId);
      const right = players.find(player => player.id === rightId);
      const leftScore = positionFit(left, slot) * 24 + roleScore(left, rules.inRoles[slot.group][0], slot.group) + left.rating / 20;
      const rightScore = positionFit(right, slot) * 24 + roleScore(right, rules.inRoles[slot.group][0], slot.group) + right.rating / 20;
      return rightScore - leftScore;
    })[0];
    if (best) {
      assignments.push(defaultAssignment(game, slot, best));
      remaining.splice(remaining.indexOf(best), 1);
    }
  }

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
