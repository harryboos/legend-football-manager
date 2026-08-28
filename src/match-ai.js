const {teamMetrics} = require('./lineup');
const {formationSlots} = require('./rules');
const {positionForSlot, positionFamiliarity} = require('./players');
const {availabilityFor} = require('./season');

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-v4-flash';
const DEFAULT_BATCH_SIZE = 5;
const DEFAULT_MAX_TOKENS = 8_000;
const MATCH_ATTRIBUTE_KEYS = [
  'finishing', 'passing', 'dribbling', 'firstTouch', 'tackling', 'heading', 'vision',
  'decisions', 'offBall', 'positioning', 'workRate', 'composure', 'pace', 'stamina', 'strength'
];
const METRIC_KEYS = ['attack', 'defense', 'control', 'energy', 'keeper', 'fit'];
const TEAM_STAT_KEYS = ['possession', 'shots', 'shotsOnTarget', 'bigChances', 'corners', 'fouls', 'passAccuracy'];

function attributeVector(player) {
  const goalkeeping = ['reflexes', 'handling', 'oneOnOnes', 'aerialReach']
    .reduce((sum, key) => sum + (player.attributes[key] || 1), 0) / 4;
  return [...MATCH_ATTRIBUTE_KEYS.map(key => player.attributes[key]), Math.round(goalkeeping)];
}

function lineupFacts(game, team) {
  const slots = new Map(formationSlots(game, team.formation, team.customFormation).map(slot => [slot.id, slot]));
  return (team.assignments || []).map(assignment => {
    const player = game.players.find(candidate => candidate.id === assignment.playerId);
    const slot = slots.get(assignment.slotId);
    return [
      player.id, player.name, assignment.slotId, positionForSlot(slot), positionFamiliarity(player, slot),
      player.heightCm, player.weightKg, player.rating, assignment.inRole, assignment.outRole, attributeVector(player)
    ];
  });
}

function benchFacts(game, team) {
  const starters = new Set((team.assignments || []).map(assignment => assignment.playerId));
  return (team.squad || []).filter(id => !starters.has(id) && availabilityFor(game, id).available).map(id => {
    const player = game.players.find(candidate => candidate.id === id);
    return [player.id, player.name, player.positions, player.heightCm, player.weightKg, player.rating, attributeVector(player)];
  });
}

function teamFacts(game, team) {
  const metrics = teamMetrics(game, team);
  const plan = team.matchPlan
    ? [team.matchPlan.formation, team.matchPlan.mentality, team.matchPlan.style]
    : null;
  return {
    i: team.id,
    n: team.name,
    ai: team.controller === 'AI' ? 1 : 0,
    sty: team.managerStyle || '自定义',
    plan,
    f: team.formation,
    sh: formationSlots(game, team.formation, team.customFormation)
      .map(slot => [slot.id, slot.group, Math.round(Number(slot.x) || 50), Math.round(Number(slot.y) || 50)]),
    m: team.mentality,
    met: METRIC_KEYS.map(key => Number(metrics[key].toFixed(2))),
    l: lineupFacts(game, team),
    b: benchFacts(game, team)
  };
}

function roundFacts(game, round) {
  return {
    r: round.number,
    f: round.games.map(fixture => ({
      h: teamFacts(game, game.teams.find(team => team.id === fixture.home)),
      a: teamFacts(game, game.teams.find(team => team.id === fixture.away))
    }))
  };
}

function systemPrompt() {
  return [
    '你是足球比赛模拟引擎。依据阵型、心态、职责、球队指标与球员能力决定赛果，允许合理冷门，禁止使用输入外球员。',
    '输入采用短键：f=对阵；h/a=主/客队；ai=是否AI；sty=风格；plan=[赛前阵型,心态,风格]；sh=[位置ID,组,x,y]；met=[进攻,防守,控制,体能,门将,适配]。',
    '首发 l 每项=[球员ID,姓名,位置ID,实际位置,位置熟练度,身高cm,体重kg,总评,有球职责,无球职责,A]；替补 b=[球员ID,姓名,擅长位置,身高,体重,总评,A]。',
    'A 顺序=[射门,传球,盘带,停球,抢断,头球,视野,决断,无球,站位,投入,镇定,速度,耐力,强壮,门将]。身高体重影响制空/对抗/灵活；位置熟练度低必须明显降低表现和评分。',
    '只输出 JSON：{"matches":[M...]}。M={h:主队ID,a:客队ID,g:[主进球,客进球],hl:短标题,su:60至120字战报,tn:20至60字战术观察,ts:[主队数据,客队数据],e:[事件...],r:[评分...],pom:最佳球员ID}。',
    'ts 每队=[控球率,射门,射正,绝佳机会,角球,犯规,传球成功率]。r 每项=[球员ID,评分,黄牌数,红牌数,红牌分钟]；须含22名首发和所有登场替补，评分4.0至10.0，pom必须是最高分之一。个人射门和传球由服务端按球队数据生成，不要输出。',
    'e 每项=[分钟,type,球队ID,球员ID,相关球员ID,简短描述,伤情,恢复场次]；无值用null。type仅限goal,big_chance_missed,key_pass,key_save,substitution,injury,red_card,tactical_change。',
    '每场：进球事件数严格等于比分；另有4至7个关键事件并覆盖失机/关键传球/关键扑救；每队1至2次合理换人；AI队至少1次临场调整；可有0至1次伤病（恢复1至8场）。红牌必须有对应事件且罚下后不得参与后续事件。事件按1至90分钟升序。',
    '文字使用简洁中文。不要 Markdown、解释、字段全名、逐人评语或额外键。'
  ].join('\n');
}

function teamStatsFromCompact(value) {
  return Object.fromEntries(TEAM_STAT_KEYS.map((key, index) => [key, value?.[index]]));
}

function decodeCompactMatch(raw, game, fixture) {
  if (raw && (raw.homeId || raw.playerRatings || raw.events)) return raw;
  const home = game.teams.find(team => team.id === fixture.home);
  const away = game.teams.find(team => team.id === fixture.away);
  const playerTeams = new Map([
    ...(home?.squad || []).map(playerId => [playerId, home.id]),
    ...(away?.squad || []).map(playerId => [playerId, away.id])
  ]);
  const events = (Array.isArray(raw?.e) ? raw.e : []).map(item => ({
    minute: item?.[0],
    type: item?.[1],
    teamId: item?.[2],
    ...(item?.[3] ? {playerId: item[3]} : {}),
    ...(item?.[4] ? {relatedPlayerId: item[4]} : {}),
    ...(item?.[5] ? {description: item[5]} : {}),
    ...(item?.[1] === 'injury' ? {injury: item?.[6], recoveryMatches: item?.[7]} : {})
  }));
  const playerRatings = (Array.isArray(raw?.r) ? raw.r : []).map(item => ({
    playerId: item?.[0],
    teamId: playerTeams.get(item?.[0]),
    rating: item?.[1],
    yellowCards: item?.[2],
    redCards: item?.[3],
    redCardMinute: item?.[4]
  }));
  return {
    homeId: raw?.h,
    awayId: raw?.a,
    homeGoals: raw?.g?.[0],
    awayGoals: raw?.g?.[1],
    headline: raw?.hl,
    summary: raw?.su,
    tacticalNote: raw?.tn,
    teamStats: {
      home: teamStatsFromCompact(raw?.ts?.[0]),
      away: teamStatsFromCompact(raw?.ts?.[1])
    },
    events,
    playerRatings,
    playerOfMatch: raw?.pom
  };
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
  const batchSize = Math.max(1, Math.min(5, Number(options.batchSize ?? process.env.DEEPSEEK_BATCH_SIZE) || DEFAULT_BATCH_SIZE));
  const timeoutMs = Number(options.timeoutMs) || 90_000;
  const maxRetries = Math.max(0, Math.min(4, Number.isInteger(options.maxRetries) ? options.maxRetries : 2));
  const retryDelayMs = Math.max(0, options.retryDelayMs === undefined ? 300 : Number(options.retryDelayMs) || 0);
  const maxTokens = Math.max(2_000, Math.min(12_000, Number(options.maxTokens ?? process.env.DEEPSEEK_MAX_TOKENS) || DEFAULT_MAX_TOKENS));
  const available = Boolean(enabled && apiKey && fetchImpl);

  async function requestBatchOnce(game, round, fixtures, batchNumber) {
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {'content-type': 'application/json', authorization: `Bearer ${apiKey}`},
        body: JSON.stringify({
          model,
          messages: [
            {role: 'system', content: systemPrompt()},
            {role: 'user', content: JSON.stringify({...roundFacts(game, {number: round.number, games: fixtures}), b: batchNumber})}
          ],
          thinking: {type: 'disabled'},
          response_format: {type: 'json_object'},
          max_tokens: maxTokens,
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
    return parsed.matches.map((match, index) => decodeCompactMatch(match, game, fixtures[index]));
  }

  async function requestBatch(game, round, fixtures, batchNumber) {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await requestBatchOnce(game, round, fixtures, batchNumber);
      } catch (error) {
        lastError = error;
        if (attempt < maxRetries && retryDelayMs) {
          await new Promise(resolve => setTimeout(resolve, retryDelayMs * 2 ** attempt));
        }
      }
    }
    throw new Error(`${lastError.message}（已尝试 ${maxRetries + 1} 次）`);
  }

  async function simulateRound(game, round) {
    if (!available) throw new Error('尚未配置 DEEPSEEK_API_KEY，无法使用 AI 比赛引擎');
    game.aiSimulationCache = game.aiSimulationCache && typeof game.aiSimulationCache === 'object' ? game.aiSimulationCache : {};
    const roundKey = String(round.number);
    const cache = game.aiSimulationCache[roundKey] && typeof game.aiSimulationCache[roundKey] === 'object'
      ? game.aiSimulationCache[roundKey]
      : (game.aiSimulationCache[roundKey] = {});
    const keyFor = fixture => `${fixture.home}:${fixture.away}`;
    const remaining = round.games.filter(fixture => !cache[keyFor(fixture)]);
    const batches = [];
    for (let index = 0; index < remaining.length; index += batchSize) batches.push(remaining.slice(index, index + batchSize));
    const settled = await Promise.allSettled(batches.map(async (fixtures, index) => {
      const matches = await requestBatch(game, round, fixtures, index + 1);
      matches.forEach((match, matchIndex) => { cache[keyFor(fixtures[matchIndex])] = match; });
      if (game.simulation) game.simulation.completedMatches = Object.keys(cache).length;
      return matches;
    }));
    const failed = settled.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    const missing = round.games.find(fixture => !cache[keyFor(fixture)]);
    if (missing) throw new Error(`AI 缓存缺少对阵 ${missing.home}:${missing.away}`);
    return round.games.map(fixture => cache[keyFor(fixture)]);
  }

  return {available, model, batchSize, maxRetries, maxTokens, simulateRound};
}

module.exports = {
  DEEPSEEK_API_URL,
  DEEPSEEK_MODEL,
  DEFAULT_BATCH_SIZE,
  DEFAULT_MAX_TOKENS,
  createDeepSeekMatchService,
  decodeCompactMatch,
  responseContent,
  roundFacts,
  systemPrompt
};
