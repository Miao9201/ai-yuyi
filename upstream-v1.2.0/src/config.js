/**
 * 运行时配置
 *
 * 环境变量优先，其次是 data/config.json，最后是默认值。
 * 这样既能临时用环境变量覆盖，也能让不熟命令行的场景直接改文件。
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CFG_PATH = path.join(ROOT, 'data', 'config.json');

const DEFAULTS = {
  /** 只响应这些微信用户 id；空数组 = 谁发都响应（不推荐） */
  allowedUsers: [],

  /** dsh 配置文件里默认的 agent 预设 */
  agentPreset: 'standard',

  /** 单个任务超时（毫秒） */
  taskTimeoutMs: 180_000,

  /** 同一用户连续发消息时的排队上限，超过就丢弃（防止刷屏拖垮机器） */
  maxQueuePerUser: 3,

  // ── chat 模式（--mode=chat，直连 API 的轻量通道） ──────────────────────

  /** chat 模式调用的模型名 */
  chatModel: 'deepseek-v4-flash',

  /** chat 模式的接口基址（OpenAI 兼容） */
  chatBaseUrl: 'https://api.deepseek.com',

  /** chat 模式的温度。聊天场景偏高更活泼，1.0-1.5 之间比较自然 */
  chatTemperature: 1.3,

  /** 是否发送"正在输入"状态 */
  sendTyping: true,

  /**
   * 是否在开始处理时先回一句"收到，正在处理…"。
   * 关掉后只有"正在输入"提示，界面更干净；
   * 但长任务（>10 秒）用户可能不确定消息是否收到。
   */
  showQueuedNotice: false,

  /** 默认人设名（personas/ 下的文件名，不含 .md）；空串表示不套人设 */
  defaultPersona: '',

  // ── 输出形态 ──────────────────────────────────────────────────────────

  /**
   * 括号动作描述的清理策略：
   *   'action' 只删明显是动作/神态的括号（默认）
   *   'all'    删掉所有括号内容
   *   'keep'   原样保留
   */
  stripActions: 'action',

  /** 是否把长回复拆成几条短消息，模拟真人连续发 */
  bubbleSplit: true,

  /** 一次回复最多拆成几条 */
  maxBubbles: 3,

  /** 拆成多条时，每条之间停顿多久（毫秒），再随机浮动 ±40% */
  bubbleGapMs: 900,

  /**
   * 回复多长才值得拆。设 0 表示只要有分段就拆（粘人模式用）。
   * 默认 40：太短的一律不拆，避免"好的呀"被切成三段。
   */
  shortReplyThreshold: 40,

  /**
   * 把相邻两条合并成一条的概率。
   * 模型稳定输出 2-3 段，不干预的话用户会觉得"每次都三条，好机器"。
   * 设一个非零值让条数在 1-4 之间浮动，内容不会丢，只是少发一个气泡。
   * 0 = 关闭该行为。
   */
  bubbleMergeChance: 0.28,

  /**
   * 一条回复"至少带一个颜文字"的概率。
   * 人设里写了比例但实测执行不稳（只有 24%），这里是代码兜底。
   * 2026-10-20 用户要求"表情变化更明显"：0.65 → 0.9（几乎每条都带）。
   */
  kaomojiChance: 0.9,

  /** 一条回复"至少带一个 emoji"的概率（和颜文字可以同时命中，但不会重复补同类） */
  emojiChance: 0.6,

  /**
   * 是否允许自动联网搜索。
   * 开着时：说到「最新/今天/天气/新闻/搜一下」这类话会自动搜一次再回答。
   * 关掉时：只能用 /搜 关键词 手动触发。
   * 注意每次搜索要跑一个完整模型轮次，约 5 秒 + 额外 token。
   */
  autoSearch: true,

  /**
   * 搜索通道：
   *  'anysearch'（默认）—— 独立搜索 API，直接返回结果，快且便宜，不跑模型轮次
   *  'deepseek'          —— 复用 DeepSeek 原生 web_search（Anthropic 兼容端点，贵且慢）
   * 换引擎不影响「什么时候搜、搜几次」那些规则。
   */
  searchProvider: 'anysearch',

  /** AnySearch 接口地址 */
  anysearchBaseUrl: 'https://api.anysearch.com',

  /**
   * AnySearch API Key。
   * 留空时会依次找环境变量 ANYSEARCH_API_KEY、~/.dsh/.credentials.yaml 里的同名项。
   * 分享这份程序时这个键保持空着，别把 key 写进来。
   */
  anysearchApiKey: '',

  /** AnySearch 每次取回几条结果（1-10） */
  searchMaxResults: 5,

  /** 主通道失败时是否自动回退到另一条通道 */
  searchFallback: true,

  /** 回退通道的超时（毫秒）。DeepSeek 通道要跑模型轮次，所以给得更宽 */
  searchFallbackTimeoutMs: 90000,

  /** 每次搜索最多使用几次服务端 web_search */
  searchMaxUses: 3,

  /** 搜索超时（毫秒） */
  searchTimeoutMs: 60000,

  /**
   * 搜索预算：每小时最多搜几次。0 = 不限制。
   * 一次搜索约 4000 tokens 输入 + 4.8 秒延迟，不设闸的话她会每句话都搜。
   * 超预算时静默跳过搜索，正常聊天。
   */
  searchHourlyLimit: 6,

  /** 搜索预算：每天最多搜几次。0 = 不限制 */
  searchDailyLimit: 30,

  // ── 省 token 的两个旋钮 ────────────────────────────────────────────────

  /**
   * 最近几轮对话保留原文，更早的压成一行摘要。
   * 调大更连贯但更贵；3 轮是实测的性价比点。
   */
  historyRecentTurns: 3,

  /** 更早的每一轮压成摘要时保留多少字 */
  historyOlderChars: 40,

  /**
   * 是否启用 Obsidian 知识库检索（RAG）。
   * 开启后每句话都会在 vaulePath 指向的库里检索相关笔记片段，
   * 分数过线才注入提示词。
   */
  ragEnabled: true,

  /** Obsidian 库根目录（就是含 .obsidian 或 MOC.md 的那一层） */
  vaultPath: '',

  /**
   * 知识库检索（RAG）注入的最低相关度分数，低于这个分就不注入。
   * 宁可不给背景资料，也不要塞一堆不相关笔记把回复带歪。
   */
  ragMinScore: 0.35,

  /** 每次最多注入几段知识库片段 */
  ragTopK: 3,

  /**
   * 画像事实卡要用到哪几篇笔记（相对库根）。
   * 问到「你知道我什么」这类自指问题时，直接把这些笔记压成事实卡注入，
   * 不走 BM25 —— 因为画像笔记的标题（设备/技术栈/数字足迹）
   * 和用户的问法几乎没有共同字面词，检索基本必然落空。
   */
  profileNotes: [
    '00-第二大脑\\01-画像\\用户画像-自动采集.md',
    '00-第二大脑\\03-行为\\兴趣图谱.md',
    '00-第二大脑\\🧠 第二大脑.md'
  ],

  /** 画像事实卡的最大字符数（约 1200 字符 ≈ 780 tokens，只在自指问题时注入） */
  profileMaxChars: 1200,

  // ── 场景延续（让对话围绕"一件事"，而不是每句都重新开局） ──────────

  /**
   * 是否启用"场景状态"。
   * 开启后会维护一份当前话题（data/scenes/），回复和主动消息都先读它，
   * 优先顺着这件事往下说。关掉就退回原来的"只看最近几轮"。
   */
  sceneEnabled: true,

  /** 场景多久没动静就算过期（分钟）。过期后下一条消息会开一个新场景 */
  sceneTtlMinutes: 180,

  /**
   * 每轮固定注入的画像事实卡字符数（分层注入的第一层）。
   * 0 = 不注入。约 360 字符 ≈ 250 tokens，换来"她一直知道你是什么人"。
   * 只在自指提问时才注入完整卡（profileMaxChars）。
   */
  sceneProfileChars: 360,

  /**
   * 分层注入的第二层：他最近在弄的笔记标题（0 = 关闭）。
   * 画像回答"他是个什么人"，这一层回答"他这阵子在忙哪件事"。
   * 只取标题、不取正文，5 条约 120 字符，成本可以忽略。
   */
  sceneRecentTopics: 5,

  /** 上一条里"最近"的时间窗（天）。默认 2 天：旧兴趣点不该一直往外冒。 */
  recentTopicDays: 2,

  /**
   * 遗忘机制。
   * 场景记的是"这一件事"，遗忘管的是"旧话题该不该还活着"：
   *   · 话题只在 topicTtlHours 内才算"还在聊"，超了就当她忘了；
   *   · 他说"别老提这个"，相关关键词进黑名单 topicBanHours，期间不再主动提。
   */
  forgetEnabled: true,

  /** 话题保鲜期（小时）：超过就当她忘了，不再主动拿出来说 */
  topicTtlHours: 48,

  /** 黑名单时长（小时）：他说过不想再提的话题，多久之内不许主动提 */
  topicBanHours: 168,

  /**
   * 拿不准"是不是同一个话题"时，是否让模型判一次。
   * 'auto' = 只在中间地带、且限频内才调（默认，成本可控）
   * false  = 完全用本地规则，零额外调用
   */
  sceneAnalyzeModel: 'auto',

  /** sceneAnalyzeModel='auto' 时，每小时最多调几次判题模型 */
  sceneAnalyzeMaxPerHour: 6,

  // ── 情绪系统（emotion.js）──────────────────────────────────────────────
  //
  // 目标：有底色、会累会开心会闹脾气，但"稳定"——不能每句话换一张脸。
  // 规则决定什么会让她有情绪，随机只决定"这一刻换不换脸"，且受驻留时间约束。

  /** 是否启用情绪系统。关掉就回到"永远温柔"的固定语气 */
  emotionEnabled: true,

  /**
   * 没人拱火时，情绪自然漂移的概率（每次满足驻留时间后才掷）。
   * 0.10 ≈ 每 10 次对话节奏变一次，太低像木头，太高像人格分裂。
   */
  emotionDriftChance: 0.10,

  /**
   * 顶嘴 / 有不同意见的基础概率。
   * 0.16 ≈ 每 6 轮里有一轮不顺着来，加上场景加成和冷却，实际观感更稀疏。
   */
  defianceChance: 0.16,

  /** 两次顶嘴之间至少隔几轮（防止连着顶，那会变成吵架） */
  defianceMinGapTurns: 2,

  /** 表情包目录；空串则用项目下 stickers/ */
  stickerDir: '',

  /** 是否允许人设在回复里用 [sticker:xxx] 触发表情包 */
  allowStickers: true,

  /**
   * 模型没打表情包标记时，代码按概率兜底补一张（中间档的骰子）。
   * 2026-10-20 两次上调：0.18 → 0.7 → 0.85（配合 1~2 轮闸门约八成半）。
   * 实际节奏 = 最少隔 stickerMinTurns 轮、最多隔 stickerMaxTurns 轮，
   * 中间那些轮按本概率掷骰子；到上限则 100% 补一张（见 index.js 频率闸门）。
   * 发一张图要真上传 50-800 KB，太高会拖慢回复、显得敷衍，别超过 0.85。
   */
  stickerChance: 0.85,

  /** 两次表情包之间最少隔几轮（1 = 允许连着发） */
  stickerMinTurns: 1,

  /** 距上次表情包达到几轮就必须补一张（上限） */
  stickerMaxTurns: 2,

  // ── 识图（主用 DeepSeek 多模态，豆包降为备用）────────────────────────────
  //
  // 2026-10-19：deepseek-v4-flash 已支持图片输入，所以默认用聊天那把 Key 识图，
  // 少一套 Key、少一条故障线。豆包配置全部保留，只当备用（主用失败时才顶上）。

  /** 是否启用收图识图 */
  visionEnabled: true,

  /** 主用哪家：'deepseek'（默认，与聊天同一把 Key）| 'doubao'（手动切回方舟） */
  visionProvider: 'deepseek',

  /** 主用 DeepSeek 时的模型；空则跟随 chatModel */
  visionModelDeepseek: 'deepseek-v4-flash',

  /** 主用失败时是否自动切豆包备用（需配 visionApiKey 或 ARK_API_KEY） */
  visionFallback: true,

  /** DeepSeek 识图专用 Key；空则用聊天那把 / 环境变量 DEEPSEEK_API_KEY */
  visionDeepseekApiKey: '',

  /** 火山方舟 API Key（备用通道）；空则回退 process.env.ARK_API_KEY */
  visionApiKey: '',

  /** 方舟 OpenAI 兼容地址（末尾不要带 /chat/completions） */
  visionBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',

  /** 备用视觉模型：seed-2-0-mini 快且便宜（实测 1.4s / ~60 tokens）；要更强可换 doubao-seed-1-6-vision-250815 */
  visionModel: 'doubao-seed-2-0-mini-260428',

  /** 一次消息最多看几张图（图多费钱，默认 1） */
  visionMaxImages: 1,

  /** 识图超时（毫秒） */
  visionTimeoutMs: 45000,

  /** 同类失败冷却分钟数：欠费/Key 错这类，修好之前别每张图都撞一次 */
  visionCooldownMinutes: 30,

  /** 让视觉模型"先思考再回答"：看图为描述任务是浪费（实测 reasoning 262→0 tokens、3.4s→1.4s），默认关 */
  visionThinking: 'disabled',

  // ── 生图（Agnes Image 2.5 Flash）────────────────────────────────────────
  //
  // 2026-10-20 接入。和识图是两条独立通道：识图用 DeepSeek 的多模态，
  // 生图用 Agnes（另一个厂商、另一把 Key），任何一边挂了都不影响另一边。
  //
  // 域名坑：官方文档写 api.agnes-ai.cn，但实测那把 Key 在该域名下一律
  // 返回 401「无效的令牌」，换成 apihub.agnes-ai.cn 才通。默认用 apihub。

  /** 是否允许她画图（关掉后他说"画一张"她只会口头答应） */
  imageGenEnabled: true,

  /** Agnes API Key；空则回退环境变量 AGNES_API_KEY。分享前必须清空 */
  imageGenApiKey: '',

  /** 生图接口地址（末尾不要带 /v1/...） */
  imageGenBaseUrl: 'https://apihub.agnes-ai.cn',

  /** 模型：agnes-image-2.5-flash（另有 2.1 / 2.0 可选） */
  imageGenModel: 'agnes-image-2.5-flash',

  /** 尺寸档位：1K / 2K / 3K / 4K */
  imageGenSize: '1K',

  /** 宽高比：1:1、3:4、4:3、16:9、9:16、2:3、3:2、21:9（微信里 1:1 最合适） */
  imageGenRatio: '1:1',

  /** 统一的画面风格后缀；留空则只按他说的画 */
  imageGenStyle: '清新可爱的插画风格，线条干净，配色柔和，构图简洁',

  /** 是否在提示词里禁止画文字（中文出图最容易糊在字上，默认禁） */
  imageGenNoText: true,

  /** 单张出图超时（毫秒）；实测 1K 约 9 秒 */
  imageGenTimeoutMs: 180000,

  /** 预算：每小时 / 每天最多画几张（防止一句话连画十张烧额度） */
  imageGenMaxPerHour: 5,
  imageGenMaxPerDay: 20,

  // ── 语境自发生图（她自己决定"这时候给你看张图"）───────────────────────

  /**
   * 和上面的点播式生图是两套闸门：
   *   - 点播（/画、"帮我画"）是他要的，可以松一点（每小时 5 张）
   *   - 自发是她自己想发，必须更紧，否则会变成"刷图机器人"
   */
  autoImageEnabled: true,
  /** 每轮回复的基础概率（还会乘情绪权重、语境触发加权） */
  autoImageChance: 0.08,
  /** 两次自发图之间至少隔几轮 —— 这是最硬的闸门，防"连着三条都在发图" */
  autoImageMinGapTurns: 8,
  autoImageMaxPerHour: 1,
  autoImageMaxPerDay: 4,
  /** 主动消息里带图的基础概率（比回复更低：主动本来就是低频） */
  autoImageProactiveChance: 0.05,

  // ── 主动消息 ──────────────────────────────────────────────────────────

  /**
   * 是否允许 bot 主动发消息。
   * 注意：iLink 官方要求 context_token 来自用户消息，主动发送没有官方保证。
   * 默认关闭，自行评估风险后再打开。
   */
  proactive: false,

  /** 主动消息间隔范围（分钟），实际取区间内随机值 */
  proactiveMinMinutes: 45,
  proactiveMaxMinutes: 150,

  /**
   * AI 自己"随机开一个新话题"的最短间隔（分钟，默认 180 = 3 小时）。
   *
   * 这是把"随机说话"的时间线拉长的那个旋钮，和上面的消息间隔是两回事：
   *   冷却未到 → 只能接着说当前场景（补充细节/说后续/就这件事问一句）
   *   冷却到了 → 才有资格抽一个全新的话题
   * 用户自己想换话题不受这个限制，随时可以。
   */
  proactiveNewTopicMinutes: 180,

  /** 主动消息"接着当前场景"时的最大轮数，超过就认为这件事聊干了，允许换题 */
  sceneMaxTurns: 12,

  /**
   * 调度器轮询周期（秒）。
   * 之前是"睡完一个 gap 才醒"，精度全丢；改成短周期轮询 + 每用户独立冷却。
   */
  proactiveTickSeconds: 15,

  /** 用户静默多久之后才主动搭话（分钟），避免打断正在聊的天 */
  proactiveIdleMinutes: 20,

  /**
   * 沉默满这么多分钟就触发「连发」（默认 5）。
   * 与 proactiveBurstAfter（按次数）是两条独立的触发路径，先到先触发。
   */
  proactiveBurstAfterIdleMinutes: 5,

  /** 连发条数的下界 */
  proactiveBurstMinCount: 3,

  /** 连发条数的上界（实际在 min~max 之间随机） */
  proactiveBurstMaxCount: 5,

  /**
   * 主动消息里"带一个问题"的概率。
   * 0.35 ≈ 每三条里有一条会顺口问一句具体的后续（问后来怎样、为什么）。
   * 注意是"具体"的问题，不是"在干嘛"。
   */
  proactiveQuestionChance: 0.35,

  // ── 忙碌 / 离开模式 ────────────────────────────────────────────────────

  /**
   * 用户说「我在忙」「我要去上班」「先不聊了」这类话时，切进忙碌模式：
   * 主动消息节奏从「每 1-3 分钟一条 + 沉默 5 分钟连发 3-5 条」
   * 降成「每 25 分钟发 2-3 条」，内容切成不打扰型，并且不再提问。
   *
   * 进入靠模型在回复里输出的 [BUSY] 标记（成本 0 额外调用），
   * 退出靠 [FREE] 标记，也可以用 /忙 /闲 手动切换。
   * 状态落盘在 data/busy-state.json，重启不丢。
   */
  busyModeEnabled: true,

  /** 忙碌模式下两次主动消息的间隔（分钟） */
  busyIntervalMinutes: 25,

  /** 忙碌模式每次发几条（在这个区间随机） */
  busyMinCount: 2,
  busyMaxCount: 3,

  /** 忙碌模式连发之间的间隔（毫秒）。比普通连发慢一点，显得不急 */
  busyBurstGapMs: 1500,

  /**
   * 忙碌模式发送前是否尝试"续期"（getconfig + 一闪而过的输入状态）。
   * iLink 没有官方续期接口，这只是个试探；结果会记进 data/window-probe.jsonl，
   * 攒几天就能反推出发送窗口到底多长。
   */
  busyKeepAlive: true,

  /** 超过这个时间（分钟）就不再主动发，视为上下文已失效 */
  proactiveContextTtlMinutes: 360,
  proactiveRetrySeconds: 60,
  proactiveMaxFailStreak: 3,

  /** 连发了几次都没回音后，开始升级为一次连发多条 */
  proactiveBurstAfter: 3,

  /** 升级时一次连发几条 */
  proactiveBurstCount: 5,

  /** 连发时每条之间的间隔（毫秒） */
  proactiveBurstGapMs: 2500,

  /** 普通档一批发几条：以 1-3 条为主，偶尔来一波 2-6 条 */
  proactiveCountShortMin: 1,
  proactiveCountShortMax: 3,
  proactiveCountLongChance: 0.2,
  proactiveCountLongMin: 2,
  proactiveCountLongMax: 6,

  /** 生活线：她自己那条"正在过着的日子"（配角、剧情、有始有终） */
  lifeEnabled: true,
  lifeArcChance: 0.45,
  lifeContinueChance: 0.85,
  lifeConflictChance: 0.35,
  lifeArcCooldownMinutes: 90,

  /** 主动消息的内容：让模型按人设自然生成，还是用固定句子 */
  proactiveCompose: 'model',

  /** proactiveCompose='fixed' 时使用的句子池 */
  proactiveLines: [
    '哥哥在忙吗？',
    '有点想你了。',
    '今天还好吗？'
  ],

  /**
   * 上报给微信服务端的自我标识（UA 风格，如 "WxBridge/1.0.0"）。
   * 仅供服务端做日志归因与监控，不影响鉴权或路由。
   */
  botAgent: 'WxBridge/1.0.0',

  /** 任务工作目录（相对项目根，或绝对路径） */
  workdir: ''
};

function loadFile() {
  try {
    if (!existsSync(CFG_PATH)) return {};
    return JSON.parse(readFileSync(CFG_PATH, 'utf8'));
  } catch (e) {
    console.warn('[config] 读取 config.json 失败，使用默认值:', e.message);
    return {};
  }
}

/** 首次运行时生成一份带注释说明的样例配置 */
export function ensureConfigFile() {
  if (existsSync(CFG_PATH)) return;
  try {
    mkdirSync(path.dirname(CFG_PATH), { recursive: true });
    const sample = {
      _说明: [
        'allowedUsers：只响应白名单里的微信用户 id。留空则响应任何人。',
        '  你的 id 会在日志里以「来自=xxx@im.wechat」的形式出现，复制过来即可。',
        'taskTimeoutMs：单个 DSH 任务超时毫秒数。',
        'showQueuedNotice：是否先回一句"收到，正在处理…"。默认 false（只有"正在输入"提示）。',
        'defaultPersona：默认人设名，对应 personas/ 下的文件名（不含 .md），留空则不套人设。',
        'stripActions：括号动作清理。action=只删动作描述（默认）/ all=删所有括号 / keep=保留原样。',
        'bubbleSplit：是否把长回复拆成几条短消息像真人连续发。maxBubbles 是条数上限。',
        'bubbleGapMs：拆成多条时每条之间的停顿毫秒数（会随机浮动）。',
        'stickerChance / stickerMinTurns / stickerMaxTurns：表情包频率。间隔最少/最多几轮，中间轮按概率掷骰子（默认 0.85 / 1 / 2，约八成半回复带一张）。',
        'kaomojiChance / emojiChance：没发表情包时，补颜文字/emoji 的概率（默认 0.9 / 0.6）。',
        'proactive：是否允许主动发消息，默认 false。iLink 官方要求 context_token 来自用户消息，主动发没有官方保证，自行评估风险。',
        'proactiveMinMinutes / proactiveMaxMinutes：主动消息间隔范围（分钟，区间内取随机值）。',
        'proactiveIdleMinutes：用户静默多久后才主动搭话，避免打断正在聊的天。',
        'proactiveContextTtlMinutes：超过这个时间就不再主动发，视为上下文已失效（实测成功样本到过 28 分钟，别设太短）。',
        'proactiveRetrySeconds / proactiveMaxFailStreak：发送失败后隔几秒重试、连续失败几次才判定窗口关闭（默认 60 秒 / 3 次）。',
        'proactiveCompose：model=让模型按人设生成 / fixed=用 proactiveLines 里的固定句子。',
        'searchProvider：搜索通道，anysearch（默认，独立搜索 API，快且便宜）| deepseek（原生 web_search，慢且贵）。',
        'anysearchBaseUrl / searchMaxResults：AnySearch 接口地址 / 每次取回几条结果（1-10）。',
        'anysearchApiKey：AnySearch 的 Key。留空则依次找环境变量 ANYSEARCH_API_KEY、~/.dsh/.credentials.yaml；分享前保持空着。',
        'searchFallback / searchFallbackTimeoutMs：主通道失败是否自动回退另一条通道 / 回退通道超时毫秒。',
        'autoSearch / searchHourlyLimit / searchDailyLimit：换引擎后这些频率规则不变，仍按原样生效。',
        'sceneEnabled：是否维护"当前场景"。开启后她会围绕一件事往下聊，而不是每句都重新开局。',
        'sceneTtlMinutes：场景多久没动静算过期（默认 180 分钟）。',
        'sceneProfileChars：每轮固定注入的画像事实卡字符数（分层注入第一层，0=关闭）。',
        'sceneRecentTopics：每轮注入的"他最近在弄的笔记标题"条数（分层注入第二层，0=关闭）。',
        'recentTopicDays：上面那条里"最近"的时间窗（天）。默认 2 天，别调太大，否则旧兴趣点会反复冒出来。',
    'forgetEnabled：是否开启遗忘机制（旧话题过期 + "别再提"拉黑）。',
    'topicTtlHours：话题保鲜期（小时）。超过就当她忘了，不再主动提（默认 48）。',
    'topicBanHours：黑名单时长（小时）。他说"别老提这个"后，相关话题多久不许主动提（默认 168 = 7 天）。',
        'sceneAnalyzeModel：auto=拿不准时让模型判一次（限频）/ false=纯本地规则零额外调用。',
        'proactiveNewTopicMinutes：她"随机开新话题"的最短间隔（默认 180 分钟=3 小时）。',
        'sceneMaxTurns：同一场景最多顺着聊多少轮，聊干了才允许换题。',
        'emotionEnabled：是否启用情绪系统。开启后她会有底色（开心/疲惫/生气/委屈…），关掉则永远温柔。',
        'emotionDriftChance：没人拱火时情绪自然漂移的概率（默认 0.10，太高会像人格分裂）。',
        'defianceChance：顶嘴/有不同意见的基础概率（默认 0.16，生气和委屈时会自动加高）。',
        'defianceMinGapTurns：两次顶嘴之间至少隔几轮（默认 2，防止连着顶变成吵架）。',
        'botAgent：上报给微信服务端的自我标识，UA 风格，仅用于服务端日志归因。',
        'visionEnabled：是否接收并识别图片。默认主用 DeepSeek 自己的多模态（与聊天同一把 Key），豆包只当备用。',
        'visionProvider：主用哪家，deepseek（默认）| doubao。想切回方舟就改成 doubao，代码不用动。',
        'visionModelDeepseek：主用 DeepSeek 时的模型，默认 deepseek-v4-flash（已支持图片输入）；空则跟随 chatModel。',
        'visionFallback：主用失败时是否自动切豆包备用（需要配 visionApiKey 或环境变量 ARK_API_KEY），默认 true。',
        'visionDeepseekApiKey：DeepSeek 识图专用 Key，空则用聊天那把 / 环境变量 DEEPSEEK_API_KEY。',
        'visionApiKey：火山方舟 API Key（备用通道，不填则读环境变量 ARK_API_KEY）。分享给别人时记得删掉。',
        'visionModel：视觉模型 ID，默认 doubao-seed-2-0-mini-260428（快、便宜）；要更强可换 doubao-seed-1-6-vision-250815。',
        'visionMaxImages / visionTimeoutMs：一条消息最多看几张图 / 单次识图超时毫秒。',
        'visionCooldownMinutes：识图欠费、Key 错这类失败后的冷却分钟数（冷却期内直接回人话，不再请求）。',
        'visionThinking：disabled 时不让视觉模型先思考（看图描述没必要思考，省 token 又快）；enabled/auto 则放开。',
        'imageGenEnabled：是否允许画图。他说"画一张…"时，她会先把图画好发过去，再补一句话。',
        'imageGenApiKey：Agnes 生图 API Key（不填则读环境变量 AGNES_API_KEY）。分享给别人前必须清空。',
        'imageGenBaseUrl：生图接口地址。默认 https://apihub.agnes-ai.cn —— 文档写的是 api.agnes-ai.cn，但实测那个域名会 401。',
        'imageGenModel：默认 agnes-image-2.5-flash；也支持 agnes-image-2.1-flash / 2.0-flash。',
        'imageGenSize / imageGenRatio：尺寸档位（1K/2K/3K/4K）与宽高比（1:1、16:9、9:16…）。微信聊天建议 1K + 1:1。',
        'imageGenStyle：统一的风格后缀，拼在他的描述后面；留空则完全按他说的画。',
        'imageGenNoText：是否禁止画面里出现文字（默认 true，中文出图最容易糊在字上）。',
        'imageGenTimeoutMs：单张出图超时毫秒（实测 1K 约 9 秒）。',
        'imageGenMaxPerHour / imageGenMaxPerDay：每小时 / 每天最多画几张，超了就只口头答应，防烧额度。',
        'autoImageEnabled：是否允许她按语境自己发图（"我到家了"+一张窗外 / 生气了甩一张表情图）。',
        'autoImageChance：每轮回复自发一张的基础概率，还会乘情绪权重与语境触发（0.35 封顶）。',
        'autoImageMinGapTurns：两次自发图之间至少隔几轮，这是防刷屏最硬的闸门。',
        'autoImageMaxPerHour / autoImageMaxPerDay：自发图的小时 / 天上限（比点播更紧，默认 1/4）。',
        'autoImageProactiveChance：主动消息里带一张图的基础概率。',
        'workdir：DSH 任务的工作目录，留空则用本项目目录。'
      ],
      allowedUsers: [],
      agentPreset: 'standard',
      taskTimeoutMs: 180000,
      maxQueuePerUser: 3,
      sendTyping: true,
      showQueuedNotice: false,
      defaultPersona: '',
      stripActions: 'action',
      bubbleSplit: true,
      maxBubbles: 3,
      bubbleGapMs: 900,
      shortReplyThreshold: 40,
      stickerDir: '',
      allowStickers: true,
      stickerChance: 0.85,
      stickerMinTurns: 1,
      stickerMaxTurns: 2,
      kaomojiChance: 0.9,
      emojiChance: 0.6,
      proactive: false,
      proactiveMinMinutes: 45,
      proactiveMaxMinutes: 150,
      proactiveNewTopicMinutes: 180,
      sceneEnabled: true,
      sceneTtlMinutes: 180,
      sceneProfileChars: 360,
      sceneRecentTopics: 5,
      recentTopicDays: 2,
      forgetEnabled: true,
      topicTtlHours: 48,
      topicBanHours: 168,
      sceneAnalyzeModel: 'auto',
      sceneAnalyzeMaxPerHour: 6,
      emotionEnabled: true,
      emotionDriftChance: 0.1,
      defianceChance: 0.16,
      defianceMinGapTurns: 2,
      sceneMaxTurns: 12,
      proactiveIdleMinutes: 20,
      proactiveContextTtlMinutes: 360,
  proactiveRetrySeconds: 60,
  proactiveMaxFailStreak: 3,
      proactiveCompose: 'model',
      proactiveLines: ['哥哥在忙吗？', '有点想你了。'],
      searchProvider: 'anysearch',
      anysearchBaseUrl: 'https://api.anysearch.com',
      anysearchApiKey: '',
      searchMaxResults: 5,
      searchFallback: true,
      searchFallbackTimeoutMs: 90000,
      botAgent: 'WxBridge/1.0.0',
      visionEnabled: true,
      visionProvider: 'deepseek',
      visionModelDeepseek: 'deepseek-v4-flash',
      visionFallback: true,
      visionDeepseekApiKey: '',
      visionApiKey: '',
      visionBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      visionModel: 'doubao-seed-2-0-mini-260428',
      visionMaxImages: 1,
      visionTimeoutMs: 45000,
      visionCooldownMinutes: 30,
      visionThinking: 'disabled',
      imageGenEnabled: true,
      imageGenApiKey: '',
      imageGenBaseUrl: 'https://apihub.agnes-ai.cn',
      imageGenModel: 'agnes-image-2.5-flash',
      imageGenSize: '1K',
      imageGenRatio: '1:1',
      imageGenStyle: '清新可爱的插画风格，线条干净，配色柔和，构图简洁',
      imageGenNoText: true,
      imageGenTimeoutMs: 180000,
      imageGenMaxPerHour: 5,
      imageGenMaxPerDay: 20,
      autoImageEnabled: true,
      autoImageChance: 0.08,
      autoImageMinGapTurns: 8,
      autoImageMaxPerHour: 1,
      autoImageMaxPerDay: 4,
      autoImageProactiveChance: 0.05,
      workdir: ''
    };
    writeFileSync(CFG_PATH, JSON.stringify(sample, null, 2), 'utf8');
  } catch (e) {
    console.warn('[config] 无法创建样例配置:', e.message);
  }
}

export function loadConfig() {
  const file = loadFile();
  const cfg = { ...DEFAULTS, ...file };

  // 环境变量覆盖
  if (process.env.WX_ALLOWED_USERS) {
    cfg.allowedUsers = process.env.WX_ALLOWED_USERS.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (process.env.WX_TASK_TIMEOUT_MS) {
    const n = Number(process.env.WX_TASK_TIMEOUT_MS);
    if (Number.isFinite(n) && n > 0) cfg.taskTimeoutMs = n;
  }
  if (process.env.WX_WORKDIR) cfg.workdir = process.env.WX_WORKDIR;

  // 洗掉下划线开头的说明字段
  for (const k of Object.keys(cfg)) {
    if (k.startsWith('_')) delete cfg[k];
  }
  return cfg;
}

/**
 * 把改动写回 config.json。
 *
 * 保留原有的 `_说明` 字段，只覆盖传入的键 ——
 * 直接用 ConvertTo-Json 之类的方式整体重写会把说明丢掉，
 * 这个文件本身就是给人看和改的，说明有价值。
 */
export async function writeConfig(patch) {
  let current = {};
  try {
    if (existsSync(CFG_PATH)) current = JSON.parse(readFileSync(CFG_PATH, 'utf8'));
  } catch { current = {}; }

  const next = { ...current, ...patch };
  delete next.apiKey; // 密钥永不落盘

  try {
    mkdirSync(path.dirname(CFG_PATH), { recursive: true });
    writeFileSync(CFG_PATH, JSON.stringify(next, null, 2), 'utf8');
    return next;
  } catch (e) {
    console.warn('[config] 写入失败:', e.message);
    return current;
  }
}

export { CFG_PATH, ROOT };
