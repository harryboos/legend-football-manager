const {teamMetrics} = require('./lineup');
const {formationSlots} = require('./rules');
const {positionForSlot, positionFamiliarity} = require('./players');

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-v4-flash';
const DEFAULT_BATCH_SIZE = 2;
const MATCH_ATTRIBUTE_KEYS = [
  'finishing', 'passing', 'dribbling', 'firstTouch', 'tackling', 'marking', 'heading',
  'vision', 'decisions', 'offBall', 'positioning', 'workRate', 'composure',
  'pace', 'stamina', 'strength', 'reflexes', 'handling', 'oneOnOnes', 'aerialReach'
];

function lineupFacts(game, team) {
  const slots = new Map(formationSlots(game, team.formation, team.customFormation).map(slot => [slot.id, slot]));
  return (team.assignments || []).map(assignment => {
    const player = game.players.find(candidate => candidate.id === assignment.playerId);
    const slot = slots.get(assignment.slotId);
    return {
      id: player.id,
      name: player.name,
      slot: assignment.slotId,
      positions: player.positions,
      positionFamiliarity: player.positionFamiliarity,
      assignedPosition: positionForSlot(slot),
      assignedFamiliarity: positionFamiliarity(player, slot),
      heightCm: player.heightCm,
      weightKg: player.weightKg,
      overall: player.rating,
      inRole: assignment.inRole,
      outRole: assignment.outRole,
      attributes: Object.fromEntries(MATCH_ATTRIBUTE_KEYS.map(key => [key, player.attributes[key]]))
    };
  });
}

function benchFacts(game, team) {
  const starters = new Set((team.assignments || []).map(assignment => assignment.playerId));
  return (team.squad || []).filter(id => !starters.has(id)).map(id => {
    const player = game.players.find(candidate => candidate.id === id);
    return {
      id: player.id,
      name: player.name,
      positions: player.positions,
      positionFamiliarity: player.positionFamiliarity,
      heightCm: player.heightCm,
      weightKg: player.weightKg,
      overall: player.rating,
      attributes: Object.fromEntries(['pace', 'stamina', 'passing', 'finishing', 'tackling', 'decisions', 'composure'].map(key => [key, player.attributes[key]]))
    };
  });
}

function teamFacts(game, team) {
  const metrics = teamMetrics(game, team);
  return {
    id: team.id,
    name: team.name,
    managerStyle: team.managerStyle || '自定义',
    formation: team.formation,
    shape: formationSlots(game, team.formation, team.customFormation),
    mentality: team.mentality,
    metrics: Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, Number(value.toFixed(2))])),
    lineup: lineupFacts(game, team),
    bench: benchFacts(game, team)
  };
}

function roundFacts(game, round) {
  return {
    league: game.name,
    round: round.number,
    fixtures: round.games.map(fixture => ({
      home: teamFacts(game, game.teams.find(team => team.id === fixture.home)),
      away: teamFacts(game, game.teams.find(team => team.id === fixture.away))
    }))
  };
}

function systemPrompt() {
  return [
    '你是足球经理游戏的比赛模拟引擎，必须根据双方经理风格、首发、位置适配、球员属性、职责、阵型、心态和球队指标决定赛果。',
    '必须考虑每名球员的 heightCm、weightKg、assignedPosition 和 assignedFamiliarity：身高体重影响制空、对抗和灵活性；位置熟练度低必须显著降低该球员表现和评分，例如前腰客串中后卫不能按原有总评正常发挥。',
    '保持足球比分和事件数量真实，强队更可能获胜但允许合理冷门。不得使用输入之外的球员。',
    '每场必须提供全部22名首发及所有登场替补的评分，以及4至9个非进球关键事件；关键事件应包含浪费绝佳机会、关键传球和关键扑救等真实比赛节点。',
    '每队安排1至3次合理换人。换人事件 type=substitution，playerId 是被换下球员，relatedPlayerId 是替补登场球员，替补必须来自该队 bench。',
    '每场提供 teamStats.home 与 teamStats.away，字段为 possession、shots、shotsOnTarget、bigChances、corners、fouls、passAccuracy，数据必须与比分和战报一致。',
    'playerRatings 中每名出场球员还必须提供整数 shots、passes、passesCompleted、yellowCards、redCards；成功传球不得超过传球数，个人合计应与球队射门及传球成功率一致。',
    '进球事件的主客队数量必须与最终比分完全一致。所有事件按分钟升序，分钟范围1至90。',
    '球员评分范围4.0至10.0，保留一位小数；playerOfMatch 应优先选择评分最高的参赛球员。',
    '只输出合法 json 对象，不要 Markdown，不要解释。JSON 格式示例：',
    '{"matches":[{"homeId":"t1","awayId":"t2","homeGoals":2,"awayGoals":1,"headline":"主队险胜","summary":"70至160字战报","tacticalNote":"30至90字战术观察","teamStats":{"home":{"possession":54,"shots":14,"shotsOnTarget":6,"bigChances":4,"corners":5,"fouls":11,"passAccuracy":87},"away":{"possession":46,"shots":9,"shotsOnTarget":3,"bigChances":2,"corners":3,"fouls":13,"passAccuracy":82}},"events":[{"minute":12,"type":"key_save","teamId":"t1","playerId":"p1","relatedPlayerId":"p2","description":"门将封出近距离射门"},{"minute":35,"type":"goal","teamId":"t1","playerId":"p3","relatedPlayerId":"p4","description":"接关键传球后低射破门"},{"minute":51,"type":"big_chance_missed","teamId":"t2","playerId":"p5","description":"单刀射门偏出"},{"minute":66,"type":"substitution","teamId":"t1","playerId":"p6","relatedPlayerId":"p12","description":"换上速度更快的边锋"}],"playerRatings":[{"playerId":"p1","teamId":"t1","rating":7.8,"note":"完成关键扑救","shots":0,"passes":38,"passesCompleted":34,"yellowCards":0,"redCards":0}],"playerOfMatch":"p3"}]}',
    'type 只能是 goal、big_chance_missed、key_pass、key_save、substitution。description 和 note 使用简洁中文。'
  ].join('\n');
}

function responseContent(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('DeepSeek 未返回比赛数据');
  return content.trim();
}

function createDeepSeekMatchService(options = {}) {
  const apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY;
  const enabled = options.enabled ?? process.env.DEEPSEEK_MATCH_ENGINE !== 'false';
  const model = options.model || DEEPSEEK_MODEL;
  const endpoint = options.endpoint || DEEPSEEK_API_URL;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const batchSize = Math.max(1, Math.min(5, Number(options.batchSize) || DEFAULT_BATCH_SIZE));
  const timeoutMs = Number(options.timeoutMs) || 90_000;
  const available = Boolean(enabled && apiKey && fetchImpl);

  async function requestBatch(game, round, fixtures, batchNumber) {
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {'content-type': 'application/json', authorization: `Bearer ${apiKey}`},
        body: JSON.stringify({
          model,
          messages: [
            {role: 'system', content: systemPrompt()},
            {role: 'user', content: `这是第 ${round.number} 轮第 ${batchNumber} 批比赛。请模拟并返回 json：\n${JSON.stringify(roundFacts(game, {number: round.number, games: fixtures}))}`}
          ],
          thinking: {type: 'disabled'},
          response_format: {type: 'json_object'},
          max_tokens: 12_000,
          stream: false
        }),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      const timeout = /timeout|aborted/i.test(`${error.name} ${error.message}`);
      throw new Error(`第 ${batchNumber} 批 DeepSeek 请求${timeout ? `超过 ${Math.round(timeoutMs / 1000)} 秒` : '失败'}：${error.message}`);
    }
    if (!response.ok) {
      const details = String(await response.text()).trim().slice(0, 300);
      throw new Error(`第 ${batchNumber} 批 DeepSeek 请求失败（${response.status}）${details ? `：${details}` : ''}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(responseContent(await response.json()));
    } catch (error) {
      throw new Error(`第 ${batchNumber} 批 JSON 无法解析：${error.message}`);
    }
    if (!Array.isArray(parsed.matches)) throw new Error(`第 ${batchNumber} 批返回内容缺少 matches 数组`);
    if (parsed.matches.length !== fixtures.length) throw new Error(`第 ${batchNumber} 批应返回 ${fixtures.length} 场，实际返回 ${parsed.matches.length} 场`);
    return parsed.matches;
  }

  async function simulateRound(game, round) {
    if (!available) throw new Error('尚未配置 DEEPSEEK_API_KEY，无法使用 AI 比赛引擎');
    const batches = [];
    for (let index = 0; index < round.games.length; index += batchSize) batches.push(round.games.slice(index, index + batchSize));
    const settled = await Promise.allSettled(batches.map((fixtures, index) => requestBatch(game, round, fixtures, index + 1)));
    const failed = settled.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    return settled.flatMap(result => result.value);
  }

  return {available, model, batchSize, simulateRound};
}

module.exports = {DEEPSEEK_API_URL, DEEPSEEK_MODEL, DEFAULT_BATCH_SIZE, createDeepSeekMatchService, responseContent, roundFacts};
