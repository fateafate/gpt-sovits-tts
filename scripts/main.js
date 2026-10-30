/**
 * gpt-sovits-tts — Foundry VTT 模块主入口
 * 功能: 聊天发送/打字停顿自动朗读 (GPT-SoVITS 本地合成 / 浏览器系统语音)
 *       麦克风听写(浏览器 Web Speech / 服务端 /asr) 直接发送或插入输入框
 *       消息重听按钮、状态指示灯、/ttssay 等命令、game.gptSoVitsTTS 宏 API
 */
import { PlaybackQueue, audioPlay, webSpeechSpeak, gptSovitsSynth, gptSovitsStatus, synthEdge, svcRequest, installModuleSocket, moduleEmit, normPlayKey, hasPlayedSrc, markPlayedSrc, bytesToB64Async, importCharPackChunked } from "./tts-engine.js";
import { installRunnerAssignUI } from "./voice-runner.js";
import { installGmProxy } from "./gm-proxy.js";
import { installTTSTests } from "./tests.js";
import { BrowserSTT, ServerSTT } from "./stt-engine.js";
import { VoiceManager, loadVoiceProfile, saveVoiceProfile, currentVoice, makeDraggable, getStylePrompt, setStylePrompt } from "./voice-manager.js";
import { prepareTextForLang, localizeNumbers, setTranslator } from "./text-lib.js";

// 暴露给 voice-manager(语音设置面板) 调用的全局函数(函数声明 hoisted, 顶层挂载即可)
window.fetchModelsFromServer = fetchModelsFromServer;
window.fetchAndRefreshModels = fetchAndRefreshModels;

const MODULE = "gpt-sovits-tts";
// 1.6.103 代码版本号: Foundry 的 game.modules.get(id).version 读的是"载入世界时的清单缓存",
//   改了 manifest 不刷新会一直显示旧版本(用户多次看到 1.6.96 而实际代码已是新版) → 报告里同时打印两者, 便于确认真的在跑新代码
const MOD_VERSION = "1.6.153";
const CHAT_STYLES = (typeof CONST !== "undefined" && (CONST.CHAT_MESSAGE_STYLES || CONST.CHAT_MESSAGE_TYPES)) || {};

/* ============ 设置定义 ============ */
// TTS 服务地址: 默认自动指向"当前 Foundry 所在主机"的 9881 端口
// (GM 在 0.0.0.0 启动服务后, 玩家浏览器连 GM 的地址即自动可用, 无需手填 IP)
const autoServerUrl = () => {
  // 1.6.122 自动识别: 如果本机 127.0.0.1:9881 探到了引擎(玩家被分配为"语音生成者"的典型情况),
  //   就优先用本机引擎; 否则用 Foundry 所在主机(原行为)。
  //   以前玩家一律连 `Foundry主机:9881` → 即使他本机装了引擎也用不上, 分配了也无法出声。
  try { if (window.__fvttTTSAutoBase) return window.__fvttTTSAutoBase; } catch (e) { /* noop */ }
  const host = (typeof location !== "undefined" && location.hostname) ? location.hostname : "127.0.0.1";
  return `http://${host}:9881`;
};

const SETTINGS = [
  ["enabled",       { type: Boolean, scope: "client", default: true,            name: "settings.enabled.name",       hint: "settings.enabled.hint" }],
  ["allowStressTest",{ type: Boolean, scope: "client", default: true,           name: "settings.allowStressTest.name", hint: "settings.allowStressTest.hint" }],
  ["engine",        { type: String,  scope: "client", default: "gptsovits",      choices: { gptsovits: "GPT-SoVITS", webspeech: "Web Speech" }, name: "settings.engine.name", hint: "settings.engine.hint" }],
  ["serverUrl",     { type: String,  scope: "client", default: autoServerUrl(), name: "settings.serverUrl.name", hint: "settings.serverUrl.hint" }],
  ["voiceServerUrl",{ type: String,  scope: "world",  default: "",                name: "settings.voiceServerUrl.name", hint: "settings.voiceServerUrl.hint" }],
  ["voiceRunnerMap",{ type: String,  scope: "world",  default: "",  restricted: true, name: "settings.voiceRunnerMap.name", hint: "settings.voiceRunnerMap.hint" }],
  ["triggerMode",   { type: String,  scope: "client", default: "both",           choices: { send: "settings.triggerMode.send", typing: "settings.triggerMode.typing", both: "settings.triggerMode.both", manual: "settings.triggerMode.manual" }, name: "settings.triggerMode.name", hint: "settings.triggerMode.hint" }],
  // 1.6.139 用户要求: 只让"本模块发送框发出的内容"朗读 —— 打字停顿预读改为独立开关, 默认关
  ["typingRead",    { type: Boolean, scope: "client", default: false,            name: "settings.typingRead.name", hint: "settings.typingRead.hint" }],
  ["speakSelf",     { type: Boolean, scope: "client", default: true,            name: "settings.speakSelf.name",      hint: "settings.speakSelf.hint" }],
  ["speakOthers",   { type: Boolean, scope: "client", default: true,            name: "settings.speakOthers.name",    hint: "settings.speakOthers.hint" }],
  ["voiceFilter",   { type: String,  scope: "client", default: "all",            choices: { all: "settings.voiceFilter.all", gm: "settings.voiceFilter.gm", players: "settings.voiceFilter.players" }, name: "settings.voiceFilter.name", hint: "settings.voiceFilter.hint" }],
  ["skipOoc",       { type: Boolean, scope: "client", default: true,            name: "settings.skipOoc.name",        hint: "settings.skipOoc.hint" }],
  ["skipWhispers",  { type: Boolean, scope: "client", default: false,           name: "settings.skipWhispers.name",   hint: "settings.skipWhispers.hint" }],
  ["skipRolls",     { type: Boolean, scope: "client", default: true,            name: "settings.skipRolls.name",      hint: "settings.skipRolls.hint" }],
  ["skipRich",      { type: Boolean, scope: "client", default: true,            name: "settings.skipRich.name",       hint: "settings.skipRich.hint" }],
  ["minLength",     { type: Number,  scope: "client", default: 1,                name: "settings.minLength.name",      hint: "settings.minLength.hint" }],
  ["maxLength",     { type: Number,  scope: "client", default: 200,              name: "settings.maxLength.name",      hint: "settings.maxLength.hint" }],
  ["textLang",      { type: String,  scope: "client", default: "auto",           choices: { auto: "settings.textLang.auto", zh: "zh", ja: "ja", en: "en", ko: "ko", yue: "yue" }, name: "settings.textLang.name", hint: "settings.textLang.hint" }],
  // 1.6.111 「0 = 自动」: 语速/音量默认 0, 由朗读提示词/AI/引擎决定(用户要求: 默认全交给 AI)
  ["speedFactor",   { type: Number,  scope: "client", default: 0,                range: { min: 0, max: 2.0, step: 0.05 }, name: "settings.speedFactor.name", hint: "settings.speedFactor.hint" }],
  // 1.6.132 提示词强度默认 0 = 交给 AI 自己定(情绪/立绘由 AI 决定, 语速停顿不锁); >0 才手动指定提示词影响强度
  ["styleStrength", { type: Number,  scope: "client", default: 0,                range: { min: 0, max: 100, step: 5 },    name: "settings.styleStrength.name", hint: "settings.styleStrength.hint" }],
  // 1.6.152 对齐 Shinsekai 的质量旋钮(默认 32/关 = 与之前完全一致, 不影响现有听感)
  ["sampleSteps",   { type: Number,  scope: "client", default: 32,               range: { min: 4, max: 48, step: 4 },    name: "settings.sampleSteps.name", hint: "settings.sampleSteps.hint" }],
  ["superSampling", { type: Boolean, scope: "client", default: false,            name: "settings.superSampling.name", hint: "settings.superSampling.hint" }],
  // 1.6.134 自动预加载: 打字停顿后自动把当前句子预合成好(发送零等待); 打字即读模式下直接复用预读音频, 零额外合成
  ["autoPreload",   { type: Boolean, scope: "client", default: true,             name: "settings.autoPreload.name",       hint: "settings.autoPreload.hint" }],
  // 1.6.65 情绪效果强度(严格对齐 Shinsekai): 默认 0 = 完全不做 DSP 变调, 情绪差异靠"情绪参考音频"; 调高只加轻微语速/音量, 不变调
  ["emotionFxStrength", { type: Number, scope: "client", default: 0, range: { min: 0, max: 100, step: 5 }, name: "settings.emotionFxStrength.name", hint: "settings.emotionFxStrength.hint" }],
  ["volume",        { type: Number,  scope: "client", default: 0,                range: { min: 0, max: 1, step: 0.05 }, name: "settings.volume.name", hint: "settings.volume.hint" }],   // 1.6.111 0 = 自动(引擎默认响度)
  ["queueMode",     { type: String,  scope: "client", default: "queue",          choices: { queue: "settings.queueMode.queue", interrupt: "settings.queueMode.interrupt" }, name: "settings.queueMode.name", hint: "settings.queueMode.hint" }],
  ["typingDebounce",{ type: Number,  scope: "client", default: 1200,             name: "settings.typingDebounce.name", hint: "settings.typingDebounce.hint" }],
  ["showReplay",    { type: Boolean, scope: "client", default: true,            name: "settings.showReplay.name",     hint: "settings.showReplay.hint" }],
  ["showStatus",    { type: Boolean, scope: "client", default: true,            name: "settings.showStatus.name",     hint: "settings.showStatus.hint" }],
  // 1.6.148 发布版: 开发者测试按钮默认隐藏(玩家误点 28 场景压力自测会跑很久/压引擎); 需要时到设置打开
  ["devTools",      { type: Boolean, scope: "client", default: false,           name: "settings.devTools.name",       hint: "settings.devTools.hint" }],
  ["commands",      { type: Boolean, scope: "client", default: true,            name: "settings.commands.name",       hint: "settings.commands.hint" }],
  ["sttEnabled",    { type: Boolean, scope: "client", default: true,            name: "settings.sttEnabled.name",     hint: "settings.sttEnabled.hint" }],
  ["sttEngine",     { type: String,  scope: "client", default: "browser",        choices: { browser: "settings.sttEngine.browser", server: "settings.sttEngine.server" }, name: "settings.sttEngine.name", hint: "settings.sttEngine.hint" }],
  ["sttLang",       { type: String,  scope: "client", default: "auto",           choices: { auto: "settings.textLang.auto", zh: "zh", ja: "ja", en: "en" }, name: "settings.sttLang.name", hint: "settings.sttLang.hint" }],
  ["sttAutoSend",   { type: Boolean, scope: "client", default: true,            name: "settings.sttAutoSend.name",   hint: "settings.sttAutoSend.hint" }],
  ["sttAutoSpeak",  { type: Boolean, scope: "client", default: false,           name: "settings.sttAutoSpeak.name",  hint: "settings.sttAutoSpeak.hint" }],
  ["emotionSpeed",  { type: Boolean, scope: "client", default: true,            name: "settings.emotionSpeed.name",  hint: "settings.emotionSpeed.hint" }],
  // 1.6.97 语气提示已并入"朗读提示词"(每角色/每位玩家独立), 不再有世界级 gmPrompt 设置项
  ["translate",     { type: Boolean, scope: "client", default: false,           name: "settings.translate.name",      hint: "settings.translate.hint" }],
  ["sttDevice",     { type: String,  scope: "client", default: "",               name: "settings.sttDevice.name",      hint: "settings.sttDevice.hint", choices: () => ttsDeviceChoices() }],
  ["hudTheme",      { type: String,  scope: "client", default: "dark",           choices: { dark: "settings.hudTheme.dark", pink: "settings.hudTheme.pink" }, name: "settings.hudTheme.name", hint: "settings.hudTheme.hint" }],
  ["gmMute",        { type: Boolean, scope: "world", default: false, restricted: true, name: "settings.gmMute.name", hint: "settings.gmMute.hint" }],
  ["maxConcurrentModels", { type: Number, scope: "world", default: 4, restricted: true, range: { min: 1, max: 20, step: 1 }, name: "settings.maxConcurrentModels.name", hint: "settings.maxConcurrentModels.hint" }],   // 1.6.128 默认 10→4: 多角色冷启动易把 16GB 显存挤爆(实测测试中引擎反复掉线)
  ["llmEnabled",    { type: Boolean, scope: "client", default: false,           name: "settings.llmEnabled.name",  hint: "settings.llmEnabled.hint" }],
  ["llmBaseUrl",    { type: String,  scope: "client", default: "https://api.openai.com/v1", name: "settings.llmBaseUrl.name", hint: "settings.llmBaseUrl.hint" }],
  ["llmKey",        { type: String,  scope: "client", default: "",               name: "settings.llmKey.name",      hint: "settings.llmKey.hint" }],
  ["llmModel",      { type: String,  scope: "client", default: "gpt-4o-mini",    choices: () => llmModelChoices(), name: "settings.llmModel.name",    hint: "settings.llmModel.hint" }],
  ["aiSharedBase",  { type: String, scope: "world", default: "", restricted: true, name: "settings.aiSharedBase.name", hint: "settings.aiSharedBase.hint" }],
  ["aiSharedKey",   { type: String, scope: "world", default: "", restricted: true, name: "settings.aiSharedKey.name", hint: "settings.aiSharedKey.hint" }],
  ["aiSharedModel", { type: String, scope: "world", default: "", restricted: true, name: "settings.aiSharedModel.name", hint: "settings.aiSharedModel.hint" }],
  ["aiSharedModels", { type: String, scope: "world", default: "", restricted: true, name: "settings.aiSharedModels.name", hint: "settings.aiSharedModels.hint" }],
  ["llmPolish",     { type: Boolean, scope: "client", default: true,             name: "settings.llmPolish.name",   hint: "settings.llmPolish.hint" }],
  ["llmMergePolish", { type: Boolean, scope: "client", default: true,          name: "settings.llmMergePolish.name", hint: "settings.llmMergePolish.hint" }],
  ["llmModels",     { type: Array,   scope: "client", default: [],                name: "settings.llmModels.name",   hint: "settings.llmModels.hint" }],
  ["aiPickAvatar",  { type: Boolean, scope: "client", default: true,              name: "settings.aiPickAvatar.name",  hint: "settings.aiPickAvatar.hint" }],
  ["voiceRunner",   { type: String,  scope: "client", default: "gm",             choices: () => runnerChoices(), name: "settings.voiceRunner.name",   hint: "settings.voiceRunner.hint" }],
  ["portraitMode",  { type: String,  scope: "client", default: "both",           choices: { message: "settings.portraitMode.message", indicator: "settings.portraitMode.indicator", both: "settings.portraitMode.both", none: "settings.portraitMode.none" }, name: "settings.portraitMode.name", hint: "settings.portraitMode.hint" }],
  ["portraitSize",  { type: String,  scope: "client", default: "medium",         choices: { small: "settings.portraitSize.small", medium: "settings.portraitSize.medium", large: "settings.portraitSize.large", xl: "settings.portraitSize.xl" }, name: "settings.portraitSize.name", hint: "settings.portraitSize.hint" }],
  ["voiceAssignments", { type: Object, scope: "world", default: {},              name: "settings.voiceAssignments.name", hint: "settings.voiceAssignments.hint" }],
  ["voiceProfile",  { type: Object,  scope: "client", default: {},              name: "settings.voiceProfile.name",  hint: "settings.voiceProfile.hint" }]
];

const _llmStyleCache = new Map();   // LLM 风格参数缓存(同角色+风格提示 10 分钟复用, 降噪/提速)
const _synthCache = new Map();      // 合成音频缓存(同文本+角色+语气+语速+语言 → 复用, cap 40 条 LRU)

/* 权限守卫: Foundry 玩家默认无权 update ChatMessage(否则服务端报 "lacks permission" 且写回不生效)。
   只有 GM 才可写回 audioData/audioUrl; 音频经广播/内嵌已到各端, 非 GM 跳过写回不丢声音。 */
function _canWrite() {
  try { return !!(game && game.user && game.user.isGM); } catch (e) { return false; }
}
function safeMsgWrite(msg, update) {
  try {
    if (!msg || !_canWrite() || !update || typeof msg.update !== "function") return;
    // 1.6.114 本地立即生效: 以前只调 update()(异步), 紧随其后的 `{...message.flags[MODULE]}` 会读到旧值 →
    //   同一句里"情绪 / 立绘 / 参考音"的多次写回互相覆盖(实测报告出现"情绪槽=voice_09 但立绘是 voice_04 的图")
    try {
      const f = update && update.flags && update.flags[MODULE];
      if (f && msg.flags && msg.flags[MODULE]) Object.assign(msg.flags[MODULE], f);
    } catch (e2) { /* noop */ }
    msg.update(update).catch(() => { /* noop */ });
  } catch (e) { /* noop */ }
}

// LLM 模型下拉: 服务端拉取的可用模型(设置 llmModels 缓存) + 常用预设; 未拉取时也有预设可选
const LLM_PRESET_MODELS = ["gpt-4o-mini", "gpt-4o", "deepseek-chat", "deepseek-reasoner", "qwen-plus", "qwen-turbo", "glm-4-flash", "kimi-latest"];
function llmModelChoices() {
  const out = {};
  let cached = [];
  try { cached = Array.isArray(game.settings.get(MODULE, "llmModels")) ? game.settings.get(MODULE, "llmModels") : []; } catch (e) { /* noop */ }
  [...LLM_PRESET_MODELS, ...cached].forEach(m => { if (m) out[m] = m; });
  return out;
}


// 1.6.117 token 统计(估算, 用于量化瘦身效果): CJK≈1 字 1 token, 其他≈4 字符 1 token
function _tokEstimate(str) {
  const t = String(str || "");
  let cjk = 0, other = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c >= 0x3000 && c <= 0x9fff) cjk++;
    else if (c >= 0xff00 && c <= 0xffef) cjk++;
    else other++;
  }
  return Math.ceil(cjk + other / 4);
}
function aiTokenRecord(kind, inTok, outTok) {
  try {
    const st = (window.__fvttTTSTokenStats = window.__fvttTTSTokenStats || { calls: 0, inTok: 0, outTok: 0, byKind: {} });
    st.calls += 1; st.inTok += (inTok | 0); st.outTok += (outTok | 0);
    const k = (st.byKind[kind] = st.byKind[kind] || { calls: 0, in: 0, out: 0 });
    k.calls += 1; k.in += (inTok | 0); k.out += (outTok | 0);
    try { console.info("[gpt-sovits-tts] AI token(" + kind + ") ≈ 输入 " + (inTok | 0) + " · 输出 " + (outTok | 0) + " ｜ 累计 输入 " + st.inTok + " · 输出 " + st.outTok); } catch (e2) { /* noop */ }
  } catch (e) { /* noop */ }
}

// 朗读提示词强度(1.6.53): 角色档案优先, 全局设置兜底; 0~100
function styleStrengthOf(role) {
  try {
    const vpS = loadVoiceProfile();
    const cs = (vpS && vpS.chars && vpS.chars[role || ""]) || null;
    if (cs && typeof cs.styleStrength === "number") return Math.max(0, Math.min(100, cs.styleStrength));
  } catch (e) { /* noop */ }
  try { const v = getCfg().styleStrength; if (typeof v === "number") return Math.max(0, Math.min(100, v)); } catch (e) { /* noop */ }
  return 50;
}

// 1.6.112 情绪占比规范化(单一来源): speak / AI 预加载 / 玩家代理合成 / 最终测试 共用
//   规则: 本次带了情绪参考音, 而占比 <=0(或未设) → 按 1.0 使用(引擎在 mix<=0 时会直接丢弃 aux, 声音就变回默认)
//   1.6.111 起「0 = 自动」: 不填就是让 AI 选中的情绪参考音直接生效
function normalizeEmotionMix(ov) {
  try {
    if (!ov) return ov;
    const hasAux = Array.isArray(ov.auxRefAudioPaths) && ov.auxRefAudioPaths.length > 0;
    // 1.6.116 修正语义(用户反馈音质崩): 「情绪语音 = 在基础语音之上追加的参考」, 不是取代!
    //   0.5 = 基础音(主参考) + 情绪音(附加参考) 融合 → 保留角色原音色, 只叠加情绪色彩(Shinsekai 的做法)
    //   1.0 = 情绪音当唯一参考 → 音色完全变成那条情绪片段(短样本还要拼接, 音质会明显变差) → 只应由用户手动拉满
    if (hasAux && !(typeof ov.emotionMix === "number" && ov.emotionMix > 0)) ov.emotionMix = 0.5;
  } catch (e) { /* noop */ }
  return ov;
}
// 1.6.53 角色立绘编号表(Shinsekai式): emotion_tags 行 → [{index,label}]
// 1.6.117 起默认不再发给 AI(省 200~400 token/次): 立绘由「选中的情绪槽自带图」决定;
//   只有角色没有情绪槽立绘(老角色包)时才回退用它。改这块前先看 docs/修改报告.md 1.6.117。, 行号/标注编号=立绘索引(1-based), 交给 AI 按语气情绪选
function buildSpriteList(c) {
  try {
    const tags = String((c && c.emotion_tags) || "").trim();
    const sprites = (c && Array.isArray(c.sprites)) ? c.sprites : [];
    if (!tags || !sprites.length) return [];
    const out = [];
    const lines = tags.split(/\r?\n/).filter(l => l.trim());
    for (let i = 0; i < lines.length && out.length < 40; i++) {
      const line = lines[i].trim();
      let idx = i + 1;
      const m = line.match(/(?:立绘|sprite)\s*(\d+)/i);
      if (m) idx = parseInt(m[1], 10);
      if (idx < 1 || idx > sprites.length) continue;   // 编号越界跳过(防错位)
      const label = line.replace(/^(?:立绘|sprite)\s*\d+\s*[:：]\s*/i, "").trim() || "";
      out.push({ index: idx, label });
    }
    return out;
  } catch (e) { return []; }
}
// 朗读风格提示词 → 合成参数(无 LLM 兜底): 严肃→慢 / 激动→快 / 不中断→整段连贯合成
function styleKeywordParams(style, textLen) {
  const s = String(style || "");
  const out = { speed: 0, split: "", frag: 0, fast: false };
  if (/愤怒|生气|发怒|恼火|火大|暴怒|怒火|严厉|呵斥/.test(s)) out.speed = 1.15;
  else if (/严肃|认真|正式|威严|庄重|沉重|冷静|沉着/.test(s)) out.speed = 0.92;
  else if (/急促|激动|兴奋|紧张|高亢|有力|热血/.test(s)) out.speed = 1.12;
  else if (/舒缓|温柔|轻柔|慵懒|软|慢/.test(s)) out.speed = 0.9;
  if (/不中断|连贯|一气呵成|不要停|顺畅/.test(s)) {
    out.fast = true;                       // 切分意图明确 → 不再用 LLM 覆盖
    out.split = textLen > 60 ? "cut2" : "cut0";   // cut0=整段一次最连贯(不切); 长文本防崩少切分
    out.frag = 0.08;
  } else if (/停顿|断句|一字一顿|缓慢|拖/.test(s)) {
    out.split = "cut2";
    out.frag = 0.6;
  }
  return out;
}

// 按语气槽中文标签推断语速(区分度增强: 愤怒快/困倦慢...; 不用英文 key — 实际语气 key 是 voice_00/custom_N)
function inferEmotionSpeed(label) {
  const s = String(label || "");
  if (/愤怒|怒吼|大喊|吼|生气|威压|凛然|激动/.test(s)) return 1.15;
  if (/惊讶|惊喜|吃惊/.test(s)) return 1.1;
  if (/开心|高兴|兴奋|笑|愉快/.test(s)) return 1.05;
  if (/悲伤|悲痛|哭泣|哭|忧虑|难过|失落/.test(s)) return 0.9;
  if (/害羞|脸红|腼腆|娇羞/.test(s)) return 0.95;
  if (/困|眠|疲惫|打哈欠|累/.test(s)) return 0.85;
  if (/严肃|冷静|平静|温柔|认真|从容|忧/.test(s)) return 1.0;
  return 0;   // 未命中 → 不调整
}

/* ============ 状态 (1.6.138: window 共享单例) ============ */
// 模块被重复求值(热重载/重复挂载)时本文件会执行两份: 若各自持一套 playedIds/voicedIds/pendingTts/preloadAudio/lastTypedSpoken/typingTimer,
// 同一消息就会被两份实例各处理一遍 → "朗读两遍、发送两遍、发送后再补读一遍"。全部容器挂 window 单例 → 跨实例去重恢复。
const __st = (window.__fvttTTSState = window.__fvttTTSState || {});
const queue = new PlaybackQueue({});
let statusInfo = { ok: null, data: null };
let lastTypedSpoken = __st.lastTypedSpoken || (__st.lastTypedSpoken = { text: "", ts: 0 });   // 打字停顿预读记录(对象共享, 只原地改字段)
let lastErrorNotify = 0;
const voicedIds = __st.voicedIds || (__st.voicedIds = new Set());
const recentBroadcastIds = __st.recentBroadcastIds || (__st.recentBroadcastIds = new Set());   // 自己最近广播的 messageId(socket 回环去重; 用集合避免连发时单值被覆盖导致旧广播重复播)
const pendingTts = __st.pendingTts || (__st.pendingTts = new Map());      // messageId → 定时器(非作者等广播音频的兜底)
const playedIds = __st.playedIds || (__st.playedIds = new Set());       // 已播放广播音频的 messageId(防兜底二次读)
const audioCache = __st.audioCache || (__st.audioCache = new Map());      // messageId → {url, mime}: 已合成/已广播的同一段音频(重播复用)
// 以下可变状态统一放 window(共享): typingTimer/preloadAudio/dictation/submitLocked/sendPopEl

function cacheAudio(messageId, url, mime) {
  try {
    if (!messageId || !url) return;
    audioCache.set(messageId, { url, mime: mime || "audio/mpeg" });
    // 最多缓存 60 条, 超量删最旧
    while (audioCache.size > 60) {
      const first = audioCache.keys().next();
      if (first.done) break;
      audioCache.delete(first.value);
    }
  } catch (e) { /* noop */ }
}

/** 预加载音频的"声音签名": 角色+语气+语言+语速; 任一变化 → 预合成音频作废, 需重新合成 */
function makeWatchKey() {
  try {
    const p = loadVoiceProfile();
    const c = getCfg();
    return JSON.stringify({ role: p.current || "", emotion: p.emotion || "", lang: c.textLang || "auto", speed: c.speedFactor || 1 });
  } catch (e) { return ""; }
}

/** 1.6.129 预加载命中判定: 预合成时若 AI 润色生效, 存进 preloadAudio.text 的是"润色稿",
 *  而用户输入框里仍是原文 → 原先用 text 比较永不相等 → 按钮显示"✓ 已预加载"但再点不发送
 *  (最终测试 L 段暴露: 预加载 ✓ 但 预加载→发送 消息✗)。
 *  srcText = 预合成时的输入原文; 匹配一律以它为准, text 只作展示与兜底。
 *  1.6.134 修"润色生效时发送不走预加载": 发送时 maybeSpeak 拿到的 speakText 可能是 AI 润色稿,
 *  也可能仍是原文(没润色/润色被安全校验拒绝) → 两种都必须能命中, 否则润色生效就白重新合成一遍。 */
function preloadHit(t) {
  try {
    if (!window.__fvttTTSPreloadAudio || !window.__fvttTTSPreloadAudio.url) return false;
    const want = String(t || "").replace(/\s+/g, " ").trim();
    if (!want) return false;
    const keyA = String(window.__fvttTTSPreloadAudio.srcText || "").replace(/\s+/g, " ").trim();
    const keyB = String(window.__fvttTTSPreloadAudio.text || "").replace(/\s+/g, " ").trim();
    return (keyA === want || keyB === want) && window.__fvttTTSPreloadAudio.watchKey === makeWatchKey();
  } catch (e) { return false; }
}

/** 播放诊断: 把"实际播放了什么"上报服务端落盘(排查播放固定同一段) */
function diagPlay(src, messageId, text) {
  try {
    const cfg = getCfg();
    svcRequest(cfg.serverUrl, "POST", "/diag", { src: String(src || "").slice(0, 20), messageId: String(messageId || "").slice(0, 16), text: String(text || "").slice(0, 60) }, { timeoutMs: 4000 }).catch(() => { });
  } catch (e) { /* noop */ }
}

/* Foundry socket: 全员播放发言者合成好的同一段音频 */
function handleSocketTts(p) {
  if (!p) return;
  // 收包诊断: 任意客户端收到模块广播都计数(pl 页面 F12 看 window.__fvttTTSSockRecv, 低压自检会上报)
  try {
    window.__fvttTTSSockRecv = (window.__fvttTTSSockRecv || 0) + 1;
    window.__fvttTTSSockLast = { type: String(p.type), ts: Date.now() };
  } catch (e) { /* noop */ }
  if (p.type === "selftest-ping") {
    // 自检跨页面广播探测: 任意页面收到 ping 立即回 pong(即使没在跑自检) — 供其他页面测"广播能否传到我这"
    try { game.socket.emit(MODULE, { type: "selftest-pong", from: game.user.name, origTs: p.origTs }); } catch (e) { /* noop */ }
    return;
  }
  if (p.type === "selftest-transfer") {
    // 传输测试: 收到广播 → 立即 HTTP 回写服务端(证明广播真实到达本页; 不依赖 pl→GM 的 socket 回程)
    try {
      svcRequest(getCfg().serverUrl, "POST", "/selftest/transfer-arrive", { id: p.id, from: game.user.name }, { timeoutMs: 8000 }).catch(() => { /* noop */ });
    } catch (e) { /* noop */ }
    return;
  }
  if (p.type === "speedtest-batch") {
    // 🚄 批量速度测试(玩家侧): 收到广播立即 HTTP 拉取计时 → 写 pl 报告段 + socket 回执(测真实传输速度)
    const tArr = Date.now() - (p.ts || Date.now());
    try {
      if (p.audioUrl) {
        const tF = Date.now();
        fetch(p.audioUrl, { signal: AbortSignal.timeout(15000) }).then(r => { if (!r.ok) throw new Error("f" + r.status); return r.arrayBuffer(); }).then(() => {
          const fetchMs = Date.now() - tF;
          try {
            window.__fvttTTSAcks = window.__fvttTTSAcks || [];
            window.__fvttTTSAcks.push({ batch: p.batch, seg: p.seg, arriveMs: tArr, fetchMs });
          } catch (e) { /* noop */ }
          try {
            const u = getCfg().serverUrl.replace(/\/+$/, "");
            svcRequest(u, "POST", "/speedtest/report", { user: (game.user && game.user.name) || "pl", ts: Date.now(), role: "player", batch: p.batch, seg: p.seg, arriveMs: tArr, fetchMs, canDirect: window.__fvttTTSCanDirect === true }).catch(() => { /* noop */ });
          } catch (e) { /* noop */ }
          try { game.socket.emit(MODULE, { type: "speedtest-ack", batch: p.batch, seg: p.seg, from: game.user.name, fetchMs }); } catch (e) { /* noop */ }
        }).catch(() => { /* 拉取失败不回执 */ });
      }
    } catch (e) { /* noop */ }
    return;
  }
  if (p.type === "speedtest-ack") {
    // 🚄 GM 侧: 收集玩家回执(统计本批到达数/传输耗时; pl 经 Foundry socket 回执, 无 Mixed Content 问题)
    try {
      window.__fvttTTSAcks = window.__fvttTTSAcks || [];
      window.__fvttTTSAcks.push({ batch: p.batch, seg: p.seg, from: p.from, arriveMs: p.arriveMs ?? -1, fetchMs: p.fetchMs ?? -1, played: p.played === true, bytes: p.bytes || 0, skewMs: p.skewMs ?? 0 });
    } catch (e) { /* noop */ }
    return;
  }
  if (p.type === "tts-service") {
    // 语音运行者服务声明(某玩家电脑跑着 TTS 服务) → 记入运行者列表, 设置面板可选
    if (p.url) {
      runnerList.set(p.url, { by: String(p.by || "玩家").slice(0, 20), url: p.url, gm: !!(p.gm), ts: Date.now() });
      while (runnerList.size > 10) { const k = runnerList.keys().next(); if (!k.done) runnerList.delete(k.value); }
    }
    return;
  }
  if (p.type !== "tts" || (!p.audio && !p.audioUrl)) return;
  // 自检语音传递测试: 收到带 selftest- 前缀 messageId 的真实音频广播 → 立即回执 ack(证明实际到达并进入播放流程)
  if (p.audioUrl && String(p.messageId || "").startsWith("selftest-")) {
    try { game.socket.emit(MODULE, { type: "selftest-audio-ack", messageId: p.messageId, from: game.user.name }); } catch (e) { /* noop */ }
  }
  if (p.messageId && recentBroadcastIds.has(p.messageId)) { recentBroadcastIds.delete(p.messageId); return; }  // 自己的广播, 已本地播放
  // 无论兜底定时器是否存在都要清掉, 并标记已播放(时序竞争: 音频先到时不让 45s 兜底再读)
  if (p.messageId && playedIds.has(p.messageId)) return;   // flags/本地已播过该消息 → 跳过(防广播再播一次)
  if (p.messageId) {
    if (pendingTts.has(p.messageId)) { clearTimeout(pendingTts.get(p.messageId)); pendingTts.delete(p.messageId); }
    playedIds.add(p.messageId);
    setTimeout(() => { playedIds.delete(p.messageId); }, 30000);
  }
  const mime = p.mediaType === "mp3" ? "audio/mpeg" : "audio/wav";
  if (p.audioUrl) {
    // URL 拉流(Shinsekai 式文件传输): 服务端已存文件, 直接 HTTP 拉取播放(无 socket 1MB 包限制, 局域网直连快)
    fetch(p.audioUrl, { signal: AbortSignal.timeout(15000) })
      .then(r => { if (!r.ok) throw new Error("audio fetch " + r.status); return r.blob(); })
      .then(b => {
        const u = URL.createObjectURL(new Blob([b], { type: mime }));
        if (p.messageId) cacheAudio(p.messageId, u, mime);   // 缓存同一段(重播复用)
        diagPlay("broadcast", p.messageId, "url");
        queue.enqueue({ play: () => audioPlay(u, { volume: playVolume(), push: false }) });
      })
      .catch(() => { /* URL 拉取失败(罕见): 玩家 15s 兜底会本地重合成 */ });
    return;
  }
  // ArrayBuffer 二进制广播(快) → Blob 播放; 兼容旧 base64 string
  let url;
  try {
    if (p.audio && typeof p.audio === "object" && (p.audio instanceof ArrayBuffer || (p.audio.buffer && p.audio.buffer instanceof ArrayBuffer))) {
      const arr = p.audio instanceof ArrayBuffer ? p.audio : p.audio.buffer;
      url = URL.createObjectURL(new Blob([arr], { type: mime }));
    } else {
      url = `data:${mime};base64,${p.audio}`;
    }
  } catch (e) { url = `data:${mime};base64,${p.audio}`; }
  if (p.messageId) cacheAudio(p.messageId, url, mime);   // 缓存同一段(重播复用, 不再重新合成)
  diagPlay("broadcast", p.messageId, "");
  queue.enqueue({ play: () => audioPlay(url, { volume: playVolume(), push: false }) });
}

/* ============ 本地化(内置中文兜底, 语言包不生效时也始终显示中文) ============ */
let zhDict = null;
async function ensureZhDict() {
  if (zhDict) return zhDict;
  try {
    const resp = await fetch(`modules/${MODULE}/languages/cn.json`, { signal: AbortSignal.timeout(5000) });
    const json = await resp.json();
    zhDict = json && typeof json === "object" ? json : {};
  } catch (e) { zhDict = {}; }
  return zhDict;
}
const _L = (key, def) => {
  const k = `${MODULE}.${key}`;
  try {
    const v = game.i18n.localize(k);
    if (v !== k) return v;
  } catch (e) { /* noop */ }
  if (zhDict) {
    try {
      const v = foundry.utils.getProperty(zhDict, key);
      if (typeof v === "string") return v;
    } catch (e) { /* noop */ }
  }
  return def ?? key;
};

/* ============ 设置辅助 ============ */
function registerSettings() {
  for (const [key, s] of SETTINGS) {
    const opts = {
      name: _L(s.name, key),
      hint: _L(s.hint, ""),
      scope: s.scope || "client",
      config: true,
      type: s.type,
      default: s.default
    };
    if (s.choices) {
      opts.choices = {};
      for (const [k, v] of Object.entries(s.choices)) opts.choices[k] = _L(v, v);
    }
    if (s.range) opts.range = s.range;
    game.settings.register(MODULE, key, opts);
  }
}

function getCfg() {
  const c = {};
  for (const [key] of SETTINGS) {
    try { c[key] = game.settings.get(MODULE, key); } catch (e) { /* noop */ }
  }
  // 旧值迁移: 任何指向旧 9880 端口的地址都改为 auto(自动解析到当前主机:9881)
  try {
    if (typeof c.serverUrl === "string" && c.serverUrl.includes(":9880")) c.serverUrl = "auto";
  } catch (e) { /* noop */ }
  // 1.6.76 统一分配来源(按配置决定压力给哪台电脑): 👥"语音生成者分配"(voiceRunnerMap: 说话者=生成者)
  //   优先于旧的 voiceRunner/voiceAssignments。生成者账号 → 从 runnerList(各引擎机 60s 心跳)取地址;
  //   找不到(离线) → 回落后续逻辑(默认引擎机/auto), 保证不断声。
  let _vmApplied = false;
  try {
    const _rawVM = String(game.settings.get(MODULE, "voiceRunnerMap") || "");
    if (_rawVM.trim()) {
      const _myName = (game.user && game.user.name) || "";
      for (const _ln of _rawVM.split(/\r?\n/)) {
        const _i = _ln.indexOf("=");
        if (_i < 0) continue;
        const _who = _ln.slice(0, _i).trim();
        const _by = _ln.slice(_i + 1).trim();
        if (!_who || _who !== _myName) continue;
        if (!_by) { _vmApplied = true; break; }                                   // 显式留空 = 默认引擎机(不改写地址)
        if (_by === _myName) { c.serverUrl = "auto"; _vmApplied = true; break; }   // 指定给自己 → 用本机服务
        let _found = "";
        try { runnerList.forEach((v, u) => { if (!_found && v && String(v.by || "") === _by) _found = u; }); } catch (e) { /* noop */ }
        if (_found) { c.serverUrl = _found; _vmApplied = true; }                   // 用被指定电脑广播的地址
        break;
      }
    }
  } catch (e) { /* noop */ }
  // 语音运行者解析: GM 分配表优先(主持人在设置里给每个 pl 分配电脑; 默认主持人电脑)
  //  → 非 GM 客户端动态用被分配机器广播的服务地址(找不到则保持 auto=本机)
  try {
    if (_vmApplied) throw new Error("__vm_applied__");   // 1.6.76 已被"语音生成者分配"接管 → 跳过旧设置覆盖
    let runner = c.voiceRunner || "gm";
    try {
      let assign = game.settings.get(MODULE, "voiceAssignments");
      // 防御: 设置曾被错误存成字符串("[object Object]") → 按空分配表处理
      if (!assign || typeof assign !== "object" || Array.isArray(assign)) assign = {};
      const myName = game.user && game.user.name;
      if (myName && assign[myName]) runner = String(assign[myName]);
    } catch (e) { /* noop */ }
    c.voiceRunner = runner;
    if (runner === "gm") {
      if (game.user && !game.user.isGM && typeof runnerList !== "undefined") {
        let gmU = null;
        runnerList.forEach((v, u) => { if (v && v.gm && !gmU) gmU = u; });
        if (gmU) c.serverUrl = gmU;
      }
    } else if (runner && runner !== "auto" && runner !== "self" && typeof runner === "string" && runner.includes(":")) {
      c.serverUrl = runner;   // 被分配的具体服务地址(服务声明 URL)
    }
  // GM 一键分发的 AI 配置(共享优先): GM 在语音面板"一键分发给所有玩家"后, 全员(含 GM)使用共享 base/key/model
  try {
    const shBase = game.settings.get(MODULE, "aiSharedBase") || "";
    const shKey = game.settings.get(MODULE, "aiSharedKey") || "";
    const shModel = game.settings.get(MODULE, "aiSharedModel") || "";
    // 1.6.84 共享配置只覆盖"非 GM"(分发给玩家用); GM 自己的本机配置优先 —
    //   否则 GM 在语音设置里改了 base/key 会被共享值覆盖, 表现为"改了不生效 / 无法保存/无法改变地址"
    const _isGmNow = !!(game.user && game.user.isGM);
    if (shBase && !_isGmNow) c.llmBaseUrl = shBase;
    if (shKey && !_isGmNow) c.llmKey = shKey;
    // 模型不强制覆盖: 每个玩家可各自选不同模型(支持多模型同时运行)。仅当玩家本地无模型缓存时, 用共享列表填充下拉
    const shModels = String(game.settings.get(MODULE, "aiSharedModels") || "").split(",").map(s => s.trim()).filter(Boolean);
    if (shModels.length && (!c.llmModels || !c.llmModels.length)) c.llmModels = shModels;
    if (shBase || shKey || shModel) c.llmEnabled = true;   // 一键分发即代表启用 AI(pl 无需自己开开关); 收回后回退各自本地
    c.aiShared = !!(shBase || shKey || shModel);
  } catch (e) { /* noop */ }
  } catch (e) { /* noop */ }
  // 1.6.97 语气提示并入"朗读提示词"(每角色/每玩家独立): 不再使用世界级 gmPrompt 注入, 避免 GM 统一覆盖;
  //   判语气/润色已通过 style(=朗读提示词) 传入, 立绘也改用 styleEmotionKey(朗读提示词) 同步。
  c.gmPrompt = "";
  return c;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function notifyOnce(msg, type = "error") {
  const now = Date.now();
  if (type === "error" && now - lastErrorNotify < 10000) return;
  lastErrorNotify = now;
  try { ui.notifications[type](msg); } catch (e) { console.warn("[gpt-sovits-tts]", msg); }
}

/* ============ 文本处理 ============ */
function detectLang(text, defaultLang = "zh") {
  if (/[\u3040-\u30ff]/.test(text) && !/[\u4e00-\u9fff]/.test(text)) return "ja";
  if (/[\u4e00-\u9fff]/.test(text)) return "zh";
  if (/[\uac00-\ud7af]/.test(text)) return "ko";
  // 纯数字/符号/无字母文本(如 "12345"): 没有语言特征, 按配置默认(中文读法/日语读法)而不是英语
  if (!/[A-Za-z]/.test(String(text))) return defaultLang;
  return "en";
}

function extractText(message) {
  let content = String(message.content || "");
  const style = message.style ?? message.type;
  if (style === CHAT_STYLES.EMOTE && message.flavor) content = content || message.flavor;
  const div = document.createElement("div");
  div.innerHTML = content;
  let text = div.textContent || "";
  if (style === CHAT_STYLES.EMOTE) {
    const alias = message.speaker?.alias;
    if (alias && text.startsWith(alias)) text = text.slice(alias.length);
  }
  return text.replace(/\s+/g, " ").trim();
}

function safeGetFlag(message, key) {
  try { return message.getFlag(MODULE, key); } catch (e) { return undefined; }
}

// 1.6.118 合成兜底(模块级, 可被最终测试直接调用):
//   参考音被引擎拒绝(400/时长不合格) → 去掉 aux 重试一次 → 本句退化为默认音色, 但不会整句没声
async function synthSafe(runner, txt, lang, opts) {
  try {
    return await runner(txt, lang, opts);
  } catch (e1) {
    const _m = String((e1 && e1.message) || e1);
    const _ov = opts && opts.ov;
    if (!(_ov && Array.isArray(_ov.auxRefAudioPaths) && _ov.auxRefAudioPaths.length)) throw e1;
    if (!/参考音|400|Bad Request|3~10/i.test(_m)) throw e1;
    try { console.warn("[gpt-sovits-tts] 情绪参考音被引擎拒绝(时长/格式), 本句自动退化为默认参考音:", _m.slice(0, 120)); } catch (e2) { /* noop */ }
    const _ov2 = { ..._ov };
    delete _ov2.auxRefAudioPaths;
    delete _ov2.emotionMix;
    const r = await runner(txt, lang, { ...opts, ov: _ov2, emotionFallback: true });
    try { window.__fvttTTSEmotionFallbackUsed = (Number(window.__fvttTTSEmotionFallbackUsed || 0) + 1); } catch (e3) { /* noop */ }
    return r;
  }
}

/* ============ 核心: 朗读 ============ */
async function speak(text, { lang = null, sender = "", refAudioPath = null, promptText = null, promptLang = null, speed = null, volume = null, auxRefAudioPaths = null, emotionMix = null, emotion = null, broadcast = false, messageId = "", skipAiEmotion = false, role = null, aiDirect = false, silentLocal = false, isTypingPreview = false } = {}) {
  const cfg = getCfg();
  try { window.__fvttTTSLastSpeakAt = Date.now(); } catch (e) { /* noop */ }   // 1.6.126 埋点: 验证打字朗读/预加载真的走到 speak
  if (!cfg.enabled) return false;
  // 调试: 记录每次朗读调用(来源/语言), 排查"日语+中文重复读"
  try { console.debug("[gpt-sovits-tts] speak call", { text: String(text).slice(0, 40), lang, broadcast, messageId, from: (new Error().stack || "").split("\n")[2] || "" }); } catch (e) { /* noop */ }
  let t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (t.length > cfg.maxLength) t = t.slice(0, cfg.maxLength);
  const pv0 = currentVoice();   // 提前: 语言决策需要角色语音语言
  const L = lang || cfg.textLang || "auto";
  // 语言解析(对标成品软件 Shinsekai): textLang=auto → 目标语言用"角色语音语言"(七海/阿尔托莉雅=ja),
  // 文本是其他语言(含中文夹英文)时在下方 prepareTextForLang 整段翻译成该语言再合成, 避免中英混排乱读
  let finalLang0;
  if (L === "auto") {
    const voiceLang = String((pv0 && pv0.promptLang) || "").trim().toLowerCase();
    finalLang0 = (voiceLang && voiceLang !== "auto") ? voiceLang : detectLang(t, cfg.textLang !== "auto" ? cfg.textLang : "zh");
  } else {
    finalLang0 = L;
  }
  // 朗读语种: 翻译(可选) + 数字本地化; 翻译失败时语言回退为源语言, 不把原文交给目标语引擎乱读
  let finalLang = finalLang0;
  let finalText = t;
  try {
    // 1.6.88 语言为 auto 时永不翻译(引擎会按文本语言自动识别) —— 避免中文台词被免费翻译 API 拖去翻译成角色语言后 429
    const _trNeed = !!(cfg.translate && String(finalLang0 || "auto").toLowerCase() !== "auto");
    const r = await prepareTextForLang(t, finalLang0, { translate: _trNeed });
    finalText = r.text;
    if (_trNeed && r.lang && r.lang !== finalLang0) {
      finalLang = r.lang;
      // 1.6.88 翻译失败/限流改为静默降级(不再每次弹通知刷屏), 仅调试输出
      try { console.debug("[gpt-sovits-tts] 翻译未成功(可能限流), 已按原文语言朗读: " + r.lang); } catch (e2) { /* noop */ }
    }
  } catch (e) { /* 保留原文 */ }
  // 台词括号剥离(照搬成品软件 remove_parentheses): （动作描写）(笑) *叹气* 不朗读, 只读正文
  finalText = stripStageDirections(finalText);

  // 语音管理器 per-角色 覆盖(参考音频/提示文本/提示语言/语速/音量)
  // 显式参数(语气槽试听等)优先, 其次 profile 覆盖
  const prof0 = loadVoiceProfile();
  const pv = pv0;
  // 多引擎并行: 角色 tts_provider 决定合成引擎 — gpt-sovits(本地高音质) / edge(服务器转发微软在线, 低负载) / web(edge 优先)
  const _prov = String((pv && pv.ttsProvider) || "gpt-sovits");
  const _synthIt = async (txt, tlang, { spdIn, ov, blobOnly, role }) => {
    if (_prov === "edge" || _prov === "web") {
      return synthEdge(txt, tlang, { serverUrl: cfg.serverUrl, speedFactor: spdIn, asBlob: blobOnly });
    }
    return gptSovitsSynth(txt, tlang, { serverUrl: cfg.serverUrl, speedFactor: spdIn, overrides: ov, mediaType: "mp3", asBlob: blobOnly, role });
  };
  // 参考路径规范化: 旧档案可能只存了 "speech/xx.wav", 补成 fvtt_chars/<角色>/speech/xx.wav(任意客户端可解析)
  const fixRef = (r) => (r && !String(r).startsWith("fvtt_chars/") && !String(r).startsWith("http")) ? `fvtt_chars/${prof0.current || ""}/${r}` : r;
  // 1.6.111 「0 = 自动」: 朗读音量/语速/情绪占比/情感参数调制 默认 0, 由 AI/朗读提示词/引擎决定
  let spd = (Number(cfg.speedFactor) > 0) ? Number(cfg.speedFactor) : 1.0;   // 0=自动: 先取 1.0, 后面由提示词/AI 决定
  let vol = (Number(cfg.volume) > 0) ? Number(cfg.volume) : 1.0;             // 0=自动: 用引擎默认响度(不额外衰减)
  let overrides = null;
  const explicit = (refAudioPath || promptText || promptLang || speed || volume || auxRefAudioPaths || typeof emotionMix === "number");
  if (explicit) {
    overrides = {};
    if (refAudioPath) overrides.refAudioPath = fixRef(refAudioPath);
    if (promptText) overrides.promptText = promptText;
    if (promptLang) overrides.promptLang = promptLang;
    if (auxRefAudioPaths) overrides.auxRefAudioPaths = auxRefAudioPaths.map(fixRef);
    if (typeof emotionMix === "number") overrides.emotionMix = emotionMix;
    if (emotion) overrides.emotion = String(emotion);   // 1.6.119 保留情绪名(诊断/引擎旁路都看得到)
    if (speed > 0) spd = speed;      // 0 = 自动(不强制语速)
    if (volume > 0) vol = volume;    // 0 = 自动
  } else if (pv) {
    if (pv.speed > 0) spd = pv.speed;
    else if (cfg.emotionSpeed && pv.emotion) {
      // 情感参数调制: 按语气标签推断情绪速度(愤怒快/困倦慢/悲伤缓...), 语速按调制度从 1.0 插值
      const slotC = findEmotionSlot(pv.emotion, prof0.current);
      const emoSpd = inferEmotionSpeed(slotC && slotC.label);
      if (emoSpd) {
        // 1.6.111 调制度 0 = 自动 → 按 1.0 全额使用"AI/情绪推断的语速"(以前 0 会被当成"不调制", 等于没效果)
        const modAmt = (typeof pv.emotionMod === "number" && pv.emotionMod > 0) ? pv.emotionMod : 1.0;
        spd = 1.0 + (emoSpd - 1.0) * modAmt;
      }
    }
    if (pv.volume > 0) vol = pv.volume;   // 0 = 自动
    if (pv.ref || pv.promptText || pv.promptLang || pv.auxRef) {
      overrides = {};
      if (pv.ref) overrides.refAudioPath = fixRef(pv.ref);
      if (pv.promptText) overrides.promptText = pv.promptText;
      if (pv.promptLang) overrides.promptLang = pv.promptLang;
      if (pv.auxRef) overrides.auxRefAudioPaths = [fixRef(pv.auxRef)];
      if (typeof pv.emotionMix === "number") overrides.emotionMix = pv.emotionMix;
    }
  }
  // 1.6.152 质量旋钮(对齐 Shinsekai): 默认 32 / 关 = 与之前完全一致; 只有用户改过才下发
  try {
    const _ss = Number(cfg.sampleSteps);
    const _sup = cfg.superSampling === true;
    if ((Number.isFinite(_ss) && _ss !== 32) || _sup) {
      overrides = overrides || {};
      if (Number.isFinite(_ss) && _ss !== 32) overrides.sampleSteps = Math.max(4, Math.min(48, Math.round(_ss)));
      if (_sup) overrides.superSampling = true;
    }
  } catch (e) { /* noop */ }
  // 情绪(1.6.24): LLM 根据台词+角色提示词判情绪(优先, 声音调制+立绘分组) > 显式选择 > 规则判定; 失败降级不阻塞
  // 1.6.118 P0: skipAiEmotion 以前只是参数、从未被检查 → 模块发送框的消息在 maybeSpeak 已判过语气,
  //   这里又调一次 /llm(真实使用每条消息 2 次 AI, token 翻倍)。现在真正生效。
  if (pv && !pv.auxRef && !skipAiEmotion) {
    let _emoDet = null;
    let _aiE = null;
    let _stSrc = "";
    // 1.6.47 朗读风格优先作语气判定参考(对标 Shinsekai: 风格给AI决定这句话的语气; 无LLM时先按风格词映射)
    try { _stSrc = getStylePrompt(prof0.current || "") || String((pv && pv.stylePrompt) || ((prof0.chars && prof0.chars[(prof0.current || "")]) || {}).stylePrompt || "").trim(); } catch (e) { /* noop */ }
    // 1.6.56 判定顺序: AI > 文本规则优先 > 提示词基调兜底(否则提示词"愤怒"会把开心句也判成愤怒)
    if (!_emoDet) { try { _aiE = await aiJudgeEmotionNow(finalText, prof0.current || ""); if (_aiE) _emoDet = _aiE; } catch (e) { /* noop */ } }
    if (!_emoDet) _emoDet = detectEmotion(finalText, pv);
    // 1.6.71 修 bug: detectEmotion 对中性文本返回字符串 "neutral"(非空) → 旧写法 `if (!_emoDet)` 永远进不来,
    //   提示词基调兜底彻底失效(实测: 提示词"愤怒"但判定=neutral)。改为把 neutral 也视为"未判定"
    if (!_emoDet || _emoDet === "neutral") { try { const _stE = styleEmotionKey(_stSrc); if (_stE) _emoDet = _stE; } catch (e) { /* noop */ } }
    if (_emoDet && _emoDet !== "neutral") { overrides = overrides || {}; overrides.emotion = _emoDet; }
    if (window.__fvttTTSSpriteDiag) {
      try { console.warn("[gpt-sovits-tts][语气判定] 文本=" + String(finalText || "").slice(0, 24) + " | 提示词=" + String(_stSrc || "-").slice(0, 20) + " | AI=" + (_aiE || "无(未配LLM或降级)") + " | 规则=" + ((_emoDet || "") || "无") + " | 调制=" + ((_emoDet && _emoDet !== "neutral") ? "开(" + _emoDet + ")" : "关(neutral)") + " | 槽音频=" + (pv.auxRef ? "有(不调制)" : "无")); } catch (e) { /* noop */ }
    }
  }

  // ---- 朗读风格提示词(音频栏输入, 如"更严肃认真、中间不要中断"): 应用到合成参数 ----
  try {
    const profC = (prof0.chars && prof0.chars[(prof0.current || "")]) || {};
    const stylePrompt = getStylePrompt(prof0.current || "") || String((pv && pv.stylePrompt) || profC.stylePrompt || "").trim();
    if (stylePrompt) {
      overrides = overrides || {};
      const _stP = (() => {
        let v = styleStrengthOf(prof0.current || "") / 100;   // 1.6.53 提示词强度 0~1
        // 1.6.99 AI 直出模式: 强度=0 时由 AI(及其风格翻译)自己决定语速/停顿, 不锁回原速
        try { if (v <= 0 && aiDirect === true) v = 1.0; } catch (e) { /* noop */ }
        return v;
      })();
      const kw = styleKeywordParams(stylePrompt, finalText.length);
      if (kw.speed) spd = 1.0 + (kw.speed - 1.0) * _stP;   // 强度 0 → 语速不变; 100 → 完全按提示词语速
      if (kw.split && _stP >= 0.25) overrides.textSplitMethod = kw.split;   // 强度过低不切分
      if (kw.frag) overrides.fragmentInterval = kw.frag * _stP;
      // 已配置 LLM 且关键词未明确切分意图 → 让 LLM 更精确地把风格翻译成参数(失败回落关键词)
      // 1.6.105 强度=0 时跳过(结果最后要乘 _stP=0, 等于白花一次 LLM 往返; 用户常把强度放 0 却因此变慢)
      if (cfg.llmEnabled && cfg.llmKey && !kw.fast && _stP > 0.01) {
        const styleKey = `role=${prof0.current || ""}|style=${stylePrompt}`;
        let llmStyleHit = null;
        try { llmStyleHit = _llmStyleCache.get(styleKey) || null; } catch (e) { /* noop */ }
        if (!llmStyleHit) {
          try {
            const qcC = (quickChars && quickChars.chars || []).find(x => x.name === (prof0.current || ""));
            const r = await svcRequest(cfg.serverUrl, "POST", "/llm/style", { base: cfg.llmBaseUrl || "https://api.openai.com/v1", key: cfg.llmKey, model: cfg.llmModel || "gpt-4o-mini", text: String(finalText).slice(0, 200), style: stylePrompt, role: prof0.current || "", setting: String((qcC && qcC.setting) || "").slice(0, 200), gm_prompt: (cfg.gmPrompt || "") }, { timeoutMs: 60000 });
            try { const _uj = r && typeof r.jsonSafe === "function" ? (r.jsonSafe() || {}) : {}; aiTokenRecord("style", Number((_uj && _uj.usage && _uj.usage.prompt_tokens) || 0) || (_tokEstimate(stylePrompt) + 260), Number((_uj && _uj.usage && _uj.usage.completion_tokens) || 0) || 8); } catch (e2) { /* noop */ }
            const j = await r.json().catch(() => ({}));
            if (r.ok && j.ok) {
              llmStyleHit = { speed_factor: j.speed_factor, split: j.split };
              try { _llmStyleCache.set(styleKey, llmStyleHit); setTimeout(() => { try { _llmStyleCache.delete(styleKey); } catch (e) { /* noop */ } }, 600000); } catch (e) { /* noop */ }
            }
          } catch (e) { /* 回落关键词结果 */ }
        }
        if (llmStyleHit) {
          if (typeof llmStyleHit.speed_factor === "number") spd = 1.0 + (llmStyleHit.speed_factor - 1.0) * _stP;   // 1.6.53 LLM 翻译的语速同样按强度插值
          if (llmStyleHit.split && llmStyleHit.split !== "cut5") {
            overrides.textSplitMethod = (llmStyleHit.split === "cut0" && finalText.length > 60) ? "cut2" : llmStyleHit.split;   // 长文本防崩
          }
        }
      }
    }
  } catch (e) { /* 保底 */ }

  // 1.6.115/1.6.118 合成兜底: 若引擎因"参考音时长不合格(3~10s)"等 400 拒绝, 自动去掉情绪参考音重试一次
  //   (情绪样本太短的角色仍能有声音; 只是这一句退回默认音色, 不再整句失败)
  //   1.6.118 抽到模块作用域 synthSafe(...) → 最终测试可以直接实测这条降级路径
  const _synthSafe = (txt2, lang2, opts2) => synthSafe((t2, l2, o2) => _synthIt(t2, l2, o2), txt2, lang2, opts2);

  // ---- 1.6.109 「情绪占比 0」陷阱: 情绪槽音频就是这句话的语气本身 ----
  //   以前 profile/flags 里若存着 emotionMix=0(情绪占比滑到 0%), 引擎按"纯默认"把 aux 丢掉 →
  //   引擎日志里能看到 aux 有值但 mix=0, 用户听到的就是"和朗读提示词完全无关的声音"。
  //   现在: 有情绪参考音而占比 <=0(或未设) → 按 1.0 用它(Shinsekai 语义: 该情绪的参考音就是这段话的参考音)。
  try {
    const _hadAux = !!(overrides && Array.isArray(overrides.auxRefAudioPaths) && overrides.auxRefAudioPaths.length);
    normalizeEmotionMix(overrides);
    if (_hadAux && overrides.emotionMix > 0 && _hadAux) { try { console.debug("[gpt-sovits-tts] 情绪参考音存在但情绪占比<=0 → 按 1.0 使用参考音(否则语气会被引擎丢弃)"); } catch (e2) { /* noop */ } }
  } catch (e) { /* noop */ }
  // 1.6.109 把"这次真正送给引擎的语气参数"暴露出来: 最终测试/诊断据此判断
  //   「AI 选中的语气到底有没有送到引擎」(以前日志里 aux 有值但 mix=0 → 引擎丢弃, 用户听到"没变化")
  try {
    window.__fvttTTSLastSynthParams = {
      src: "speak",
      emotion: String((overrides && overrides.emotion) || ""),
      aux: ((overrides && overrides.auxRefAudioPaths) || []).slice(0, 2),
      mix: (overrides && typeof overrides.emotionMix === "number") ? overrides.emotionMix : null,
      spd: spd,
      ref: String((overrides && overrides.refAudioPath) || ""),
    };
  } catch (e) { /* noop */ }

  let item = null;
  if (cfg.engine === "gptsovits") {
    try {
      // 调试: 确认最终合成文本与语言
      try { console.debug("[gpt-sovits-tts] synth", { finalLang, finalText: String(finalText).slice(0, 50) }); } catch (e) { /* noop */ }
      if (broadcast) {
        // 发言者本地合成 → 广播音频给全员 → 所有人播放同一段(同一个声音)
        // 合成缓存: 同文本+角色+语气+语速+语言 → 复用(重复台词零等待)
        const ck = `${finalText}|${finalLang}|${makeWatchKey()}`;
        let cc = null;
        try { cc = _synthCache.get(ck) || null; } catch (e) { /* noop */ }
        let blob = null;
        let audioUrl = "";
        if (cc && cc.blob) {
          blob = cc.blob; audioUrl = cc.audioUrl || "";
          diagPlay("cache", messageId, finalText);
        } else {
          const res = await _synthSafe(finalText, finalLang, { spdIn: spd, ov: overrides, blobOnly: true, role: role || prof0.current });
          // 1.6.78 归属回执: 直连=本机自己合成(与代理路径的 by 对应), 供设置面板/分配器/最终测试显示压力归属
          try { window.__fvttTTSLastSynthBy = (game.user && game.user.name) || "本机"; } catch (e) { /* noop */ }
          blob = res.blob; audioUrl = res.audioUrl || "";
          try {
            _synthCache.set(ck, { blob, audioUrl });
            while (_synthCache.size > 40) { const k0 = _synthCache.keys().next(); if (!k0.done) _synthCache.delete(k0.value); }
          } catch (e) { /* noop */ }
        }
        diagPlay("synth", messageId, finalText);
        // 播放源: ① 优先 Foundry 静态文件 /modules/...(官方内部通道 AudioHelper.push 即时广播, 各端几乎同时经同一
        // 内置通道播放, 消除消息同步延迟) ② 否则内嵌 data URI(DB 兜底, 广播不可达时 pl 收 update 后经同一音频系统播放)
        let playSrc = "";
        try {
          if (blob && blob.size > 0 && blob.size <= 300000) {
            playSrc = "data:audio/mpeg;base64," + (await blobToBase64(blob));
          }
        } catch (e) { /* noop */ }
        const modPath = _modulePath(audioUrl);
        let cleanupObj = null;
        // 🔉 播放源 = Foundry 官方内部通道: 官方静态文件相对路径(/modules/...) + push:true →
        // AudioHelper.play 本地经官方 Sound 播放 + Foundry socket 广播 playAudio(相对 src) →
        // 其他客户端收到广播后各自解析自己的 origin(同一 FVTT 静态可加载)经官方通道播放 —
        // 这就是"走 FVTT 内部语音"(官方 playAudio 广播), 不是模块外置播放; 不依赖 flags 写回/update hook。
        let url4 = modPath || "";
        if (!url4 && blob && blob.size > 0) {
          try { const o = URL.createObjectURL(blob); if (o) { url4 = o; cleanupObj = o; } } catch (e) { /* fallthrough */ }
        }
        if (!url4 && playSrc) url4 = playSrc;
        const _registerPlayed = () => {
          try {
            if (messageId) {
              playedIds.add(messageId);
              setTimeout(() => { try { playedIds.delete(messageId); } catch (e) { /* noop */ } }, 30000);
            }
          } catch (e) { /* noop */ }
        };
        // 🔊 单通道(1.6.5): 不再走官方 AudioHelper push 广播 — 官方通道在他端由 Foundry 并发播放,
        // 不受本模块串行队列约束, 多条消息同时到达就"一起响"(重叠混乱)。
        // 改为 flags 写回单通道: 他端经 updateChatMessage 统一走模块 queue(串行, 一条播完下一条)。
        // 全员同声保留(写回同步全员), 只是本机内部不再重叠。sc20/26 测试自触发广播, 不受影响。
        // 1.6.132 silentLocal: 作者刚在"打字停顿朗读"里预读过同一句 → 发送时不再本地重播
        //   (他人没听过预读, 照常经 flags 写回收听一遍; 作者标记 playedIds 防 updateChatMessage 再播)
        if (silentLocal) {
          _registerPlayed();
          item = { play: () => { try { console.debug("[gpt-sovits-tts] 打字已预读同一句 → 发送不重复本地播放"); } catch (e) { /* noop */ } }, cleanup: () => { try { if (cleanupObj) URL.revokeObjectURL(cleanupObj); } catch (e) { /* noop */ } } };
        } else {
          item = { play: () => audioPlay(url4, { volume: vol, push: false, onStart: _registerPlayed }), cleanup: () => { try { if (cleanupObj) URL.revokeObjectURL(cleanupObj); } catch (e) { /* noop */ } } };
        }
        if (messageId) {
          recentBroadcastIds.add(messageId);
          if (recentBroadcastIds.size > 12) {   // 只记最近 12 条, 防无限增长
            const it = recentBroadcastIds.values().next();
            if (!it.done) recentBroadcastIds.delete(it.value);
          }
          // 关键: 把音频写回消息 flags → 聊天文档同步(数据库级, 可靠) → 其他客户端(pl)收到 update 立即播放,
          // 不依赖 socket 广播(该通道在部分环境下不可达)。audioData 内嵌**不依赖 audioUrl**(服务端没落盘/未返回
          // 文件头时 audioUrl 为空, 但 blob 一定在) — 只要有 blob 就内嵌, pl 端拿到即播, 根治"玩家听不到"。
          try {
            const _msg = (game.messages && game.messages.get(messageId)) || null;
            // 统一组装 flags(无论 GM/玩家): audioData(≤300KB 内嵌, 不依赖落盘) + audioUrl(相对路径, 各端从自身 origin 拉)
            const _upd = {};
            if (blob && blob.size > 0 && blob.size <= 300000) {
              const _b64 = await blobToBase64(blob);
              if (_b64 && _b64.length < 400000) _upd.audioData = "data:audio/mpeg;base64," + _b64;
            }
            if (audioUrl) _upd.audioUrl = audioUrl.startsWith("http") ? new URL(audioUrl).pathname : audioUrl;
            // 角色上下文写进 flags: 他端 15s 兜底/重播缓存 miss 用**作者的声音**重新合成,
            // 不再用各端本端模型(根治"几个玩家几遍 / 玩家角色+GM模型两个不同语音")
            try {
              const _pvCtx = pv0 || currentVoice();
              if (_pvCtx) {
                if (_pvCtx.name) _upd.role = _pvCtx.name;
                if (_pvCtx.ref) _upd.ref = _pvCtx.ref;
                if (_pvCtx.promptText) _upd.promptText = _pvCtx.promptText;
                if (_pvCtx.promptLang) _upd.promptLang = _pvCtx.promptLang;
                if (_pvCtx.auxRef) _upd.auxRef = _pvCtx.auxRef;
                // 1.6.109 写回"实际生效"的占比(overrides 里可能已被纠正成 1.0): 否则重播/他端还会按 0 丢掉语气
                const _effMix = (overrides && typeof overrides.emotionMix === "number") ? overrides.emotionMix : _pvCtx.emotionMix;
                if (typeof _effMix === "number") _upd.emotionMix = _effMix;
                if (_pvCtx.emotion) _upd.emotion = normalizeEmotionKey(_pvCtx.emotion);   // 1.6.30 标准化(槽 key→joy/sad/...), 他端兜底合成调制才认
              }
            } catch (e) { /* noop */ }
            if (!Object.keys(_upd).length) { /* 无可用数据 */ }
            else if (_canWrite() && _msg) {
              // GM: 本端直接写回(数据库同步广播全员)
              const _fu = {};
              if (_upd.audioData) _fu["flags.gpt-sovits-tts.audioData"] = _upd.audioData;
              if (_upd.audioUrl) _fu["flags.gpt-sovits-tts.audioUrl"] = _upd.audioUrl;
              _msg.update(_fu).catch(() => { /* noop */ });
            } else {
              // 玩家无写回权限 → GM 端代写(v13 module 事件中继到 GM 客户端, GM 本端 update 广播全员 — 根治"只有发言人听到")
              try {
                moduleEmit("tts-metadata", Object.assign({ messageId, __proxyTs: Date.now() }, _upd), { timeoutMs: 15000 }).catch(() => { /* noop */ });
              } catch (e) { /* noop */ }
            }
          } catch (e) { /* noop */ }
        }
        try {
          const b64 = await blobToBase64(blob);
          // 缓存同一段音频(重播复用同一段, 不再重新合成)
          cacheAudio(messageId, `data:${"audio/mpeg"};base64,${b64}`, "audio/mpeg");
          // 🔊 单通道: 播放统一走 Foundry 内置语音通道 — audioPlay 本地播 + 官方 playAudio 事件广播
          // (socket.io 不回自己, 无自环; 全员几乎同时听到)。聊天 flags.audioData(Foundry 内置聊天数据通道)
          // 是广播不可达时的同通道兜底(pl 端收到消息后走同一 AudioHelper 播放)。不再自定义 socket 广播。
        } catch (e) { /* 广播兜底: 仅本地播放 */ }
      } else {
        const res = await _synthSafe(finalText, finalLang, { spdIn: spd, ov: overrides, blobOnly: false, role: role || prof0.current });
        // 1.6.134 打字预读捕获: 预读播放的这段音频直接存成预加载缓存(发送零等待, 零额外合成/LLM)
        if (isTypingPreview) {
          try {
            window.__fvttTTSLastTypingPreview = { srcText: stripStageDirections(String(text || "")), text: finalText, lang: finalLang || "auto", blob: res.blob || null, dataUri: res.dataUri || "", url: res.url || "", audioUrl: res.audioUrl || "" };
          } catch (e) { /* noop */ }
        }
        // 官方文件路径优先(相对 /modules/... + push 广播全家官方通道); 无落盘才 blob/dataURI
        const mpx = (() => { try { return _modulePath(res.audioUrl || ""); } catch (e) { return ""; } })();
        const url = mpx || res.dataUri || res.url;
        item = { play: () => audioPlay(url, { volume: vol, push: !!mpx }), cleanup: () => { try { if (!mpx && !res.dataUri && res.url) URL.revokeObjectURL(res.url); } catch (e) { /* noop */ } } };
      }
    } catch (err) {
      console.error("[gpt-sovits-tts] 合成失败:", err);
      setStatus(false);
      // 玩家端: socket 代理偶发超时/服务排队 → 代码曾退直连(本机没服务必挂) → 误报 Load failed。
      // 修复: 玩家一律不本地合成, 失败自动转交 GM/服务器代理(message 带 synthRequest, GM 合成写回,
      // 玩家经 updateChatMessage 收到官方通道播放) — 任何拓扑都有真声, 不再误报。
      if (!(game.user && game.user.isGM)) {
        try {
          const aliasU = (game.user && game.user.name) || "玩家";
          const reqFlags = {
            synthRequest: { text: finalText, lang: finalLang, role: prof0.current || "", speed: Number(spd) || 0, provider: _prov },
            role: prof0.current || ((pv && pv.name) || ""),
          };
          if (overrides) {
            if (overrides.refAudioPath) reqFlags.ref = overrides.refAudioPath;
            if (overrides.promptText) reqFlags.promptText = overrides.promptText;
            if (overrides.promptLang) reqFlags.promptLang = overrides.promptLang;
            if (overrides.auxRefAudioPaths && overrides.auxRefAudioPaths.length) reqFlags.auxRef = overrides.auxRefAudioPaths[0];
            if (typeof overrides.emotionMix === "number") reqFlags.emotionMix = overrides.emotionMix;
          }
          await ChatMessage.create({ content: "🔊 <em>请 GM/服务器合成语音…</em>", speaker: { alias: aliasU }, flags: { [MODULE]: reqFlags } });
          notifyOnce(_L("errors.gmProxy", "本机未直连 TTS，已转交 GM/服务器合成，稍后自动播放"), "info");
          return true;
        } catch (e) { /* 落到普通错误提示 */ }
      }
      // 连接类错误(服务重启/启动窗口)与真实合成错误分开提示
      const em = String((err && err.message) || err || "");
      const isConn = em.includes("Failed to fetch") || (em.includes("fetch") && !em.includes("TTS 服务返回"));
      const detail = em.length > 220 ? em.slice(0, 220) + "…" : em;
      notifyOnce(isConn
        ? _L("errors.synthStart", "TTS 服务未连接（可能正在启动/重启，约 1-2 分钟后自动恢复）") + (em && !em.includes("Failed to fetch") ? "：" + detail : "")
        : _L("errors.synth", "语音合成失败") + "：" + detail);
      return false;
    }
    setStatus(true);
  } else {
    item = { play: () => webSpeechSpeak(finalText, { lang: finalLang, rate: spd, volume: vol }) };
  }

  if (cfg.queueMode === "interrupt") queue.interrupt(item);
  else queue.enqueue(item);
  return true;
}

/** 台词括号剥离(照搬成品软件 remove_parentheses): 动作描写不朗读, 只读正文 */
function stripStageDirections(text) {
  return String(text || "")
    .replace(/（[^（）]*）/g, "")
    .replace(/\([^()]*\)/g, "")
    .replace(/\*[\s\S]*?\*/g, "")
    .trim();
}

/** 读取最近聊天上下文(去掉 OOC/系统消息, 拼"谁: 说了什么"), 供 LLM 判断语气/润色(对标成品软件: 基于对话流) */
function getChatContext(maxN = 8, maxLen = 900) {
  try {
    const msgs = game.messages ? game.messages.contents : [];
    if (!msgs || !msgs.length) return "";
    const ooc = (typeof CONST !== "undefined" && CONST.CHAT_MESSAGE_STYLES) ? CONST.CHAT_MESSAGE_STYLES.OOC : "OOC";
    const recent = msgs.filter(m => {
      if (!m) return false;
      try {
        const st = m.style || "";
        if (st === ooc) return false;
      } catch (e) { /* noop */ }
      return !!m.content;
    }).slice(-maxN);
    const lines = recent.map(m => {
      try {
        const sp = m.speaker || {};
        const who = sp.alias || (m.author && m.author.name) || "?";
        const raw = String(m.content || "");
        // 去掉里边的模块 flags 注入/HTML, 截断每行
        const txt = raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 140);
        if (!txt) return "";
        return who + ": " + txt;
      } catch (e) { return ""; }
    }).filter(l => l.length > 3);
    if (!lines.length) return "";
    let s = lines.join("\n");
    if (s.length > maxLen) s = s.slice(-maxLen);
    return s;
  } catch (e) { return ""; }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(",")[1] || "");
    fr.onerror = () => reject(new Error("FileReader failed"));
    fr.readAsDataURL(blob);
  });
}

/* ---------- 麦克风设备选择(配置设定) ---------- */
let ttsDeviceCache = null;
async function refreshTtsDevices() {
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    const devs = await navigator.mediaDevices.enumerateDevices();
    ttsDeviceCache = devs.filter(d => d.kind === "audioinput").map(d => ({
      id: d.deviceId,
      label: d.label || `麦克风 ${d.deviceId.slice(0, 10)}`
    }));
  } catch (e) { /* noop */ }
}
function ttsDeviceChoices() {
  const out = { "": _L("settings.sttDevice.default", "系统默认(浏览器默认)") };
  if (ttsDeviceCache) ttsDeviceCache.forEach(d => { out[d.id] = d.label; });
  return out;
}

/* ===== 语音运行者: 谁在跑 TTS 服务(每客户端独立选; 跑服务的机器会广播"服务声明") ===== */
const runnerList = new Map();   // url → {by, url, ts, gm}: 收到的服务声明(其他玩家的电脑跑着 9881)
// 1.6.78 供 UI(语音设置/语音生成者分配器)读取"引擎机清单"(各端 60s 心跳声明) → 让"按配置指定压力给哪台电脑"看得见
try {
  window.__fvttTTSGetRunners = () => {
    const a = [];
    try {
      runnerList.forEach((v, url) => {
        a.push({ url: String(url), by: String((v && v.by) || ""), gm: !!(v && v.gm), ts: Number((v && v.ts) || 0), ageMs: Date.now() - Number((v && v.ts) || 0) });
      });
    } catch (e) { /* noop */ }
    return a;
  };
} catch (e) { /* noop */ }
function runnerChoices() {
  const out = {};
  // 主持人电脑: 有 GM 服务声明就用其地址, 否则"自动"(运行时 getCfg 动态解析 GM 地址/本机)
  let gmUrl = null;
  runnerList.forEach((v, url) => { if (v && v.gm && !gmUrl) gmUrl = url; });
  out.gm = gmUrl ? `${_L("settings.voiceRunner.gm", "主持人电脑")}（${gmUrl}）` : _L("settings.voiceRunner.gmAuto", "主持人电脑（自动）");
  out.self = _L("settings.voiceRunner.self", "自己（本机服务）");
  const mine = getCfg().serverUrl;
  runnerList.forEach((v, url) => {
    if (v && v.url && !v.gm) out[v.url] = `${v.by || "玩家"}（${v.url}）`;
  });
  if (mine && mine !== "auto" && !out[mine]) out[mine] = `${_L("settings.voiceRunner.current", "当前地址")}（${mine}）`;
  return out;
}
// 本机跑着 TTS 服务(serverUrl 指向本机且 /status 可达) → 定期广播服务声明, 全员可选"语音由这台电脑跑"
async function announceTtsService() {
  try {
    const cfg = getCfg();
    // 代理模式(https 远程/跨网/9881 不可达→CanDirect=false): 本端不探测/不广播, 服务声明只由引擎可达端(CanDirect=true)发 —
    // 否则玩家端周期性对不可达 serverUrl 发挂起探测, 占用浏览器连接池拖慢页面加载(HTTP/1.1 每域 6 连接被占)
    if (window.__fvttTTSCanDirect === false) return;
    let url = (cfg.serverUrl && cfg.serverUrl !== "auto") ? cfg.serverUrl : null;
    if (!url) {
      // auto: 本机可能跑着 9881 服务(默认主持人场景) → 探测本机; https 页面直连 http 必被拦, 直接跳过声明
      if (typeof location !== "undefined" && location.protocol === "https:") return;
      url = "http://127.0.0.1:9881";
      const probe = await fetch(`${url}/status`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
      if (!probe || !probe.ok) return;
    }
    const s = await fetch(`${url}/status`, { signal: AbortSignal.timeout(4000) }).catch(() => null);
    if (!s || !s.ok) return;
    let pubUrl = url;
    try {
      const st = await s.json().catch(() => ({}));
      // auto/回环地址 → 用服务端检测的局域网 IP 对外广播(玩家才能连上)
      if (st && st.lan_ip && /^(auto|http:\/\/127\.0\.0\.1|http:\/\/localhost)/.test(pubUrl)) {
        const port = (() => { try { return new URL(pubUrl === "auto" ? "http://x" : pubUrl).port || 9881; } catch (e) { return 9881; } })();
        pubUrl = `http://${st.lan_ip}:${port}`;
      }
    } catch (e) { /* noop */ }
    if (game.socket && typeof game.socket.emit === "function") {
      const pr = game.socket.emit(MODULE, { type: "tts-service", url: pubUrl, by: game.user ? game.user.name : "玩家", gm: !!(game.user && game.user.isGM), ts: Date.now() });
      if (pr && typeof pr.catch === "function") pr.catch(() => {});
    }
  } catch (e) { /* 本机没跑服务, 不广播 */ }
}

/* ---------- HUD 主题(黑白款 / 粉色系) ---------- */
function applyHudTheme() {
  try {
    const pink = getCfg().hudTheme === "pink";
    document.body.classList.toggle("fvtt-tts-pink", pink);
  } catch (e) { /* noop */ }
}

// 立绘大小: 消息内插图尺寸(档位: 小90 / 中140默认 / 大280 / 特大420=3倍) — CSS 变量全局生效, 历史/新消息都立即跟随
const PORTRAIT_SIZES = { small: 90, medium: 140, large: 280, xl: 420 };
const PORTRAIT_HEADER_SIZES = { small: 24, medium: 36, large: 72, xl: 108 };   // header 玩家头像(约默认的 1/4, 特大=3倍)
function applyPortraitSize() {
  try {
    const v = getCfg().portraitSize || "medium";
    const px = PORTRAIT_SIZES[v] || 140;
    const hp = PORTRAIT_HEADER_SIZES[v] || 36;
    document.body.style.setProperty("--fvtt-tts-portrait-size", px + "px");
    document.body.style.setProperty("--fvtt-tts-header-avatar-size", hp + "px");
  } catch (e) { /* noop */ }
}

function stopSpeaking() { queue.stop(); }
// 1.6.111 「朗读音量 0 = 自动」: 设置里 0 表示"不额外衰减(引擎默认响度)", 绝不能当静音传给播放器,
//   否则默认值 0 会让所有语音被静音。所有播放点统一走这里。
function playVolume() {
  try { const v = Number(getCfg().volume); return (v > 0 && v <= 1) ? v : 1; } catch (e) { return 1; }
}
// GM 全局静音: world 设置(restricted, 仅 GM 可改) → 所有客户端 updateSetting 同步 → 静音时停播+禁播
const isGmMuted = () => {
  try {
    // "GM 全局静音" 仅作用于 GM 本机: 玩家端永不继承 GM 静音设置
    // (否则 GM 开静音/自检临时静音残留 → 全员 audioPlay 跳过 → 玩家端永远"未检测到播放")
    if (!game.user || !game.user.isGM) return false;
    return game.settings.get(MODULE, "gmMute") === true;
  } catch (e) { return false; }
};
const syncMuteFlag = () => { try { window.__fvttTTSMutedFlag = isGmMuted(); } catch (e) { /* noop */ } };

function evaluateMessage(message) {
  const cfg = getCfg();
  if (!cfg.enabled) return null;
  const flag = safeGetFlag(message, "speak");
  if (flag === false) return null;

  const isSelf = !!message.isAuthor;
  if (!isSelf && cfg.triggerMode === "manual") return null;

  const rawContent = String(message.content || "");
  const style = message.style ?? message.type;
  if (style === CHAT_STYLES.SYSTEM) return null;
  if (style === CHAT_STYLES.OOC && cfg.skipOoc) return null;
  // 1.6.39 跳过模组机制消息: D&D 短休/长休(type=rest, 无掷骰时rolls为空, skipRolls拦不住) — 不再读"谁执行了短休"
  if (style === "rest" || /(短休|长休|short rest|long rest)/i.test(rawContent)) return null;
  // 1.6.85 跳过 D&D 物品/法术/系统描述卡(如"神莓术""蛮力药水""魔法物品"的说明文本) — 这些不是角色说的话, 不该朗读
  try {
    const _fl0 = message.flags || {};
    const _d5 = _fl0.dnd5e || {};
    const _isItemStyle = (style === "item" || style === "spell" || style === "usage");
    const _hasItemFlag = !!(_d5.itemData || _d5.item || _d5.use || _d5.itemUses || _d5.itemUse);
    const _isItemHtml = /item-card|spell-card|dnd5e__item|dnd5e\.item|card-header[^>]*(spell|item)|item-summary|spell-summary|item-description|spell-description/i.test(rawContent);
    if (_isItemStyle || _hasItemFlag || _isItemHtml) return null;
  } catch (e) { /* noop */ }
  // 1.6.87 跳过模块自身生成的报告/诊断文本(把自检/测试报告贴到聊天框时不应被朗读/翻译)
  try {
    if (/^\s*\[(引擎机自检|最终测试|AI测试|AI提示词测试报告|使用测试报告|gpt-sovits-tts)/.test(rawContent)) return null;
  } catch (e) { /* noop */ }
  const isWhisper = (Array.isArray(message.whisper) && message.whisper.length > 0) || style === "whisper";
  if (isWhisper && cfg.skipWhispers) return null;

  if (cfg.skipRich && rawContent.includes("<") && style !== CHAT_STYLES.EMOTE) return null;
  if (cfg.skipRolls && (message.isRoll || (message.rolls && message.rolls.length) || message.roll)) return null;
  if (!message.isContentVisible) return null;

  const author = message.author;
  const isGmAuthor = !!(author && author.isGM);
  if (cfg.voiceFilter === "gm" && !isGmAuthor) return null;
  if (cfg.voiceFilter === "players" && isGmAuthor) return null;
  if (isSelf && !cfg.speakSelf && flag !== true) return null;
  if (!isSelf && !cfg.speakOthers && flag !== true) return null;

  let text = extractText(message);
  if (!text || text.length < cfg.minLength) return null;
  if (text.length > cfg.maxLength) text = text.slice(0, cfg.maxLength);
  return { text, lang: cfg.textLang, isSelf, speakerName: message.speaker?.alias || message.author?.name || "" };
}

/** 1.6.132 防重复朗读: 这句刚被打字停顿朗读预读过吗(30s 内、文本一致)?
 *   typing 预读只发生在作者本机, 发送时作者若不跳过本地播放就会"预读一遍+发送一遍"=听两遍;
 *   他人没听过预读, 所以只跳过作者本地播放, flags 写回/广播照常。 */
function _wasTypingPreviewed(txt) {
  try {
    const t = String(txt || "").replace(/\s+/g, " ").trim();
    if (!t) return false;
    const lt = lastTypedSpoken;
    if (!lt || !lt.text || !lt.ts) return false;
    if (Date.now() - lt.ts > 30000) return false;
    return String(lt.text).replace(/\s+/g, " ").trim() === String(t).replace(/\s+/g, " ").trim();   // 1.6.138 两侧都归一化(消息内容带尾随空白时不再误判为"没预读过")
  } catch (e) { return false; }
}

async function maybeSpeak(message) {  const cfg = getCfg();
  if (!cfg.enabled) return;
  // 1.6.42 朗读白名单: 只有通过本模块发送框发出的文字(fromModSend标记)才朗读;
  // 其他模组消息/普通聊天框直发/系统与机制消息一律不出声(打字停顿朗读不经过此判定, 属本模块显式朗读)
  try {
    const flMs = message && message.flags && message.flags[MODULE];
    if (!(flMs && flMs.fromModSend)) return;
  } catch (e) { return; }
  // 1.6.58 测试入口探针(区分"hook未触发/白名单拦截" vs "判定块异常"): 判定探针在下方, 此探针证明进入了 maybeSpeak
  if (window.__fvttTTSAiLineDiag) {
    try { (window.__fvttTTSAiLineEnterList = window.__fvttTTSAiLineEnterList || []).push({ mid: (message && message.id) || "", ts: Date.now() }); } catch (e) { /* noop */ }
  }
  if (message.id && voicedIds.has(message.id)) return;
  const decision = evaluateMessage(message);
  if (!decision) return;
  if (message.id) { voicedIds.add(message.id); setTimeout(() => voicedIds.delete(message.id), 60000); }
  // 音色: 消息 flags 携带的说话者上下文(全员一致) > 本地 profile/服务端激活角色
  let overrides = null;
  let flLang = null;
  let fl = null;   // 提升到函数作用域(原在 try 内 const, 下方 AI 块访问会 ReferenceError)
  try {
    fl = message.flags && message.flags[MODULE];
    if (fl) {
      if (fl.spriteTest) return;   // 🎭 立绘测试消息(1.6.38): 不朗读(仅测立绘切换)
      if (fl.speedTest) return;   // 🚄 速度测试消息: 不朗读(仅测传输)
      if (fl.speedTestAck) return;   // 🚄 速度测试回执消息: 不朗读
      if (fl.speedTestPing || fl.speedTestPingAck) return;   // 🫀 心跳消息: 不朗读(防 🫀 被当语音合成)
      if (fl.selfTest) return;   // 🔬 玩家自测消息: 不朗读(由 GM 代理合成写回其自身 flags, 玩家端经 updateChatMessage 播放)
      if (fl.playerSelfTestResult) return;   // 🔬 玩家自测结果回执: 不朗读(仅展示)
      if (fl.lang) flLang = fl.lang;   // 作者最终朗读语种(全员一致, 防"日语+中文"混读)
      if (fl.ref || fl.promptText || fl.auxRef) {
        overrides = {};
        if (fl.ref) overrides.refAudioPath = fl.ref;
        if (fl.promptText) overrides.promptText = fl.promptText;
        if (fl.promptLang) overrides.promptLang = fl.promptLang;
        if (fl.auxRef) overrides.auxRefAudioPaths = [fl.auxRef];
        if (typeof fl.emotionMix === "number") overrides.emotionMix = fl.emotionMix;
        if (fl.speed) overrides.speed = fl.speed;
      }
    }
  } catch (e) { /* noop */ }
  // 朗读文本: 优先上次 AI 润色结果(重播一致); 否则用原文
  let speakText = (fl && fl.polishText) || decision.text;
  // AI 语气调配(对标成品软件):
  //  - 未选语气(默认) → AI 自主判断语气(只选情绪槽, 不改台词)
  //  - 已选语气 → 不重判情绪; 情绪槽音频已随 flags 应用
  // 🎙 语气→声音切换(对标 Shinsekai): LLM可用→AI判情绪(不改台词); LLM未配/失败/超时→规则+风格判定;
  //    无论哪条路, 命中情绪槽(有参考音)就换该槽参考音频合成 → 不同情绪真正切换声音; 无槽才走 DSP 调制兜底
  try {
    const flA = fl || null;
    const roleN = (flA && flA.role) || "";
    if (!(flA && flA.emotion)) {
      // 未选语气(默认) → 自动判定语气
      let _emo = "";
      if (cfg.llmEnabled && cfg.llmKey && window.__fvttTTSLlmBroken !== true) {
        try {
          const _tJ0 = Date.now();   // 1.6.105 AI 判语气耗时(排查"生成特别慢": 看是 AI 慢还是合成慢)
          // 1.6.117 零 token 快路径: 朗读提示词已经能确定语气(styleEmotionKey 命中) 且不需要 AI 润色 →
          //   语气/立绘都能本地决定(情绪槽 + slot.avatar), 这次完全不用调 AI
          const _styleEmo0 = (() => { try { return styleEmotionKey(String(getStylePrompt(roleN) || "")); } catch (e) { return ""; } })();
          const _needAi = !(_styleEmo0 && !cfg.llmPolish);
          const _ctx = (String(decision.text || "").length <= 24) ? getChatContext(2, 120) : "";   // 1.6.117 上下文只发最近 2 行(短句才发)
          const res = _needAi
            ? await judgeAndPolishByLLM(decision.text, roleN, !!cfg.llmPolish, _ctx)
            : { ok: false, emotion: "", reason: "skip-by-style" };
          try { window.__fvttTTSJudgeMs = Date.now() - _tJ0; } catch (e) { /* noop */ }
          try { console.debug("[gpt-sovits-tts] AI 判语气+" + (cfg.llmPolish ? "润色" : "无润色") + " 耗时 " + ((Date.now() - _tJ0) / 1000).toFixed(1) + "s" + (res && res.ok ? "" : "（失败，降级规则判定）")); } catch (e) { /* noop */ }
          if (res.ok && res.emotion) _emo = String(res.emotion);
          // 1.6.98 朗读提示词(语气提示)里的情绪优先: 主持人/玩家明确指定语气时, 语音与立绘都以它为准
          //   (此前 AI 判出 voice_19=严肃不满 会走 neutral 立绘, 看起来"提示词没效果")
          // 1.6.105 关键修复: styleEmotionKey 返回英文枚举(angry), 必须再解析成该角色的具体情绪槽(voice_03),
          //   否则下面的 findEmotionSlot("angry") 找不到槽 → 不换情绪参考音 → 听感"与提示词无关"
          try {
            const _stE3 = styleEmotionKey(String(getStylePrompt(roleN) || ""));
            if (_stE3) {
              _emo = _stE3;
              const _sl3 = findEmotionSlot(_stE3, roleN);
              if (_sl3 && _sl3.key) _emo = _sl3.key;
            }
          } catch (e0) { /* noop */ }
          // 1.6.52 朗读提示词交给AI(Shinsekai式): AI按角色人设+朗读提示词润色台词朗读; 聊天记录保持原文, flags记polishText(重播一致)
          if (res.ok && res.polish && cfg.llmPolish) {
            const _polOk = polishIsSafe(decision.text, res.polish);   // 1.6.63 双保险: 校验通过才用润色文本播出
            if (_polOk) {
              speakText = res.polish;
              try {
                if (message && message.flags && message.flags[MODULE]) {
                  const _nfP = { ...(message.flags[MODULE]) };
                  _nfP.polishText = res.polish;
                  safeMsgWrite(message, { flags: { [MODULE]: _nfP } });
                }
              } catch (e) { /* noop */ }
            } else {
              try { console.debug("[gpt-sovits-tts] AI 润色被安全校验拒绝(改动过大), 使用原台词播出"); } catch (e) { /* noop */ }
            }
          }
          // 1.6.53 AI 选立绘(Shinsekai式): 使用者手动选立绘(selSprite)永远优先, AI 不覆盖
          if (res.ok && res.sprite && !(flA && flA.selSprite)) {
            try {
              const _cc2 = (quickChars && quickChars.chars || []).find(x => x.name === roleN);
              const _sp2 = (_cc2 && _cc2.sprites && _cc2.sprites[res.sprite - 1]) || "";
              if (_sp2 && message && message.flags && message.flags[MODULE]) {
                const _nfS = { ...(message.flags[MODULE]) };
                _nfS.aiSprite = _sp2;
                safeMsgWrite(message, { flags: { [MODULE]: _nfS } });
              }
            } catch (e) { /* noop */ }
          }
          if (res.reason && res.reason !== "no-llm" && res.reason !== "no-slots" && res.reason !== "llm-broken") console.debug(`[gpt-sovits-tts] AI 判断未应用: ${res.reason}`);
          // 1.6.105 标记"本句语气/立绘已由 assess 判过" → 下面的 AI 选立绘 hook 直接跳过,
          //   不再为同一条消息重复调一次 LLM(以前每题 2~3 次 AI 往返, 是"生成特别慢"的主因之一)
          if (res.ok) {
            try {
              if (message && message.flags && message.flags[MODULE]) {
                const _nfD = { ...(message.flags[MODULE]) };
                _nfD.aiDecided = true;
                safeMsgWrite(message, { flags: { [MODULE]: _nfD } });
              }
            } catch (e) { /* noop */ }
          }
        } catch (e) { /* noop */ }
      }
      if (!_emo) {
        // 1.6.56 文本情绪优先, 提示词基调兜底; 1.6.71 修 neutral 短路: 文本判为 neutral 时同样要用提示词基调
        try {
          const _stP = getStylePrompt(roleN) || "";
          const _de = detectEmotion(decision.text, null);
          _emo = (_de && _de !== "neutral") ? _de : (styleEmotionKey(_stP) || _de || "");
        } catch (e) { try { _emo = detectEmotion(decision.text, null) || ""; } catch (e2) { _emo = ""; } }
      }
      // 1.6.60 探针提到情绪槽处理之前: _emo 一确定就采集(neutral/空也采集), 槽处理异常不再吞探针(句1/5"已进hook判定未产"根因)
      if (window.__fvttTTSAiLineDiag) {
        try { (window.__fvttTTSAiLineDiagList = window.__fvttTTSAiLineDiagList || []).push({ mid: (message && message.id) || "", ts: Date.now(), text: String(decision.text || "").slice(0, 30), emo: String(_emo || ""), src: (cfg.llmEnabled && cfg.llmKey && window.__fvttTTSLlmBroken !== true) ? "AI" : "规则/风格", strength: styleStrengthOf(roleN), manual: !!(flA && flA.selSprite) }); } catch (e) { /* noop */ }
      }
      if (_emo && _emo !== "neutral") {
        // 1.6.51 无论有没有情绪槽参考音, emotion 都传给引擎 → 引擎 EMOTION_FX(变调/变速/增益) 让"没有参考音频也有不同声音"
        overrides = overrides || {};
        overrides.emotion = _emo;
        const slot = findEmotionSlot(_emo, roleN);
        if (slot && slot.ref_audio_path) {
          overrides.auxRefAudioPaths = [`fvtt_chars/${roleN}/${slot.ref_audio_path}`];   // 主参考为基础 + 情绪参考叠加
          if (slot.prompt_text) overrides.promptText = slot.prompt_text;
          if (slot.prompt_lang) overrides.promptLang = slot.prompt_lang;
          // 1.6.109 占比<=0 视为"未设置"(以前 0 会让引擎丢掉情绪参考音 → 听起来跟提示词无关)
          if (!(typeof overrides.emotionMix === "number" && overrides.emotionMix > 0)) overrides.emotionMix = 0.5;   // 1.6.116 基础音+情绪音叠加(不是取代)
          console.debug(`[gpt-sovits-tts] 自动语气朗读: ${_emo}${(cfg.llmEnabled && cfg.llmKey && window.__fvttTTSLlmBroken !== true) ? "(AI)" : "(规则/风格)"} 台词保持原文`);   // 1.6.50 降级路径同样换情绪参考音
          // 1.6.109 立绘跟"选中的情绪槽"走(对标 Shinsekai: 立绘 N ↔ 情绪 N ↔ 参考音 N 是同一条线)
          //   以前这里只换声音, 立绘由另一套"语义分桶"决定 → 会出现"害羞的声音 + 中性的立绘"这种错配
          try {
            if (!(flA && flA.selSprite) && message && message.flags && message.flags[MODULE]) {
              const _ccS = (quickChars && quickChars.chars || []).find(x => x.name === roleN);
              const _ordS = Math.max(0, ((_ccS && _ccS.emotions) || []).findIndex(e => e && e.key === slot.key));
              const _spS = String(slot.avatar || ((_ccS && _ccS.sprites && _ccS.sprites[_ordS]) || ""));
              if (_spS) {
                const _nfSp = { ...(message.flags[MODULE]) };
                _nfSp.aiSprite = _spS;
                _nfSp.slotAvatar = String(slot.avatar || "");
                safeMsgWrite(message, { flags: { [MODULE]: _nfSp } });
              }
            }
          } catch (e2) { /* noop */ }
          // 记录语气到消息 flags → 重播缓存 miss 时用同一语气重新合成(声音与第一次一致)
          try {
            if (message && message.flags && message.flags[MODULE]) {
              const _nf = { ...(message.flags[MODULE]) };
              _nf.emotion = slot.key || _emo;
              _nf.auxRef = `fvtt_chars/${roleN}/${slot.ref_audio_path}`;
              if (slot.prompt_text) _nf.promptText = slot.prompt_text;
              safeMsgWrite(message, { flags: { [MODULE]: _nf } });
            }
          } catch (e) { /* noop */ }
        }
      }
    } else if (flA && flA.emotion) {
      // 已选语气 → 不再重判情绪; 情绪占比不足时补足到 0.75(更明显), 用户手动调高则尊重
      const curMix = (typeof flA.emotionMix === "number") ? flA.emotionMix : 0;
      if (curMix < 0.75) {
        overrides = overrides || {};
        if (typeof overrides.emotionMix !== "number") overrides.emotionMix = 0.5;   // 1.6.116 基础音+情绪音叠加
      }
      // 1.6.109 手动选了语气槽时同理: 占比 0 会让引擎丢掉这条参考音(声音又变回默认)
      if (overrides && Array.isArray(overrides.auxRefAudioPaths) && overrides.auxRefAudioPaths.length
          && !(typeof overrides.emotionMix === "number" && overrides.emotionMix > 0)) overrides.emotionMix = 0.5;
      // 1.6.116 手动选语气槽时, 立绘也要跟这个槽走(以前只换声音, 立绘由另一套语义分桶决定 → 错配)
      try {
        const _slM = findEmotionSlot(String(flA.emotion || ""), roleN);
        if (_slM && !(flA && flA.selSprite) && message && message.flags && message.flags[MODULE]) {
          const _ccM = (quickChars && quickChars.chars || []).find(x => x.name === roleN);
          const _ordM = Math.max(0, ((_ccM && _ccM.emotions) || []).findIndex(e => e && e.key === _slM.key));
          const _spM = String(_slM.avatar || ((_ccM && _ccM.sprites && _ccM.sprites[_ordM]) || ""));
          if (_spM) {
            const _nfM = { ...(message.flags[MODULE]) };
            _nfM.aiSprite = _spM;
            _nfM.slotAvatar = String(_slM.avatar || "");
            safeMsgWrite(message, { flags: { [MODULE]: _nfM } });
          }
        }
      } catch (e2) { /* noop */ }
      console.debug(`[gpt-sovits-tts] 已选语气 ${flA.emotion} (台词保持原文)`);
    }
  } catch (e) { /* AI 失败沿用原设置 */ }
  // ⚠ 1.6.103 修 1.6.99 引入的致命 bug: 这里在 try 块外, 只能引用函数作用域的 fl;
  //   原先写 flA(只在上面 try 块内 const 声明) → ReferenceError → 整个 maybeSpeak 中断 →
  //   「不合成 → 没有 audioUrl → 立绘关卡判定"未朗读"→ 不插立绘」= 用户看到的"只有语音/没有立绘"。
  const opts = { lang: flLang || decision.lang, sender: decision.speakerName, ...(overrides || {}), aiDirect: !!(fl && fl.aiDirect) };
  // 1.6.132 防"打字预读+发送=作者听两遍": 同一句刚被打字停顿朗读预读过(30s 内) →
  //   发送时作者不再本地重播(他人没听过预读, 照常经 flags 写回收听一遍)
  const _heardTyping = _wasTypingPreviewed(String((message && message.content) || ""));
  // 预加载音频命中: 输入与预合成文本一致 且 角色/语气/语言/语速未变 → 作者直接播预合成音频并广播(跳过 AI 判断/重新合成, 零等待)
  // 切了角色或语气 → 签名不匹配 → 回落下方正常合成(重新按当前角色/语气合成, 绝不播旧声音)
  if (preloadHit(stripStageDirections(speakText)) && window.__fvttTTSPreloadAudio && window.__fvttTTSPreloadAudio.url) {
    if (decision.isSelf) {
      // 代理模式(pl 在 HTTPS/跨网/9881 不可达环境): 预合成音频路径写回 flags → 全员从 Foundry 30000 拉同一段
      try {
        if (message.id && window.__fvttTTSPreloadAudio.audioUrl) {
          const _relP = String(window.__fvttTTSPreloadAudio.audioUrl).startsWith("http") ? new URL(window.__fvttTTSPreloadAudio.audioUrl).pathname : window.__fvttTTSPreloadAudio.audioUrl;
          const _updP = { "flags.gpt-sovits-tts.audioUrl": _relP };
          try { if (window.__fvttTTSPreloadAudio.dataUrl && window.__fvttTTSPreloadAudio.dataUrl.length < 400000) _updP["flags.gpt-sovits-tts.audioData"] = window.__fvttTTSPreloadAudio.dataUrl; } catch (e) { /* noop */ }
          safeMsgWrite(message, _updP);
        }
      } catch (e) { /* noop */ }
      if (window.__fvttTTSCanDirect === true) {
        if (message.id) { playedIds.add(message.id); setTimeout(() => { try { playedIds.delete(message.id); } catch (e) { /* noop */ } }, 30000); }   // 本地预载已播(防 flags 写回再播)
        const _mpu = (() => { try { return _modulePath(window.__fvttTTSPreloadAudio.audioUrl || ""); } catch (e) { return ""; } })();
        // 1.6.132: 这句刚被"打字停顿朗读"预读过 → 预加载命中也不再本地重播(作者只听预读那一次)
        if (!_heardTyping) {
          queue.enqueue({ play: () => audioPlay(_mpu || window.__fvttTTSPreloadAudio.dataUrl || window.__fvttTTSPreloadAudio.url, { volume: playVolume(), push: !!_mpu }) });
        } else {
          try { console.debug("[gpt-sovits-tts] 打字已预读同一句 → 预加载命中不重复本地播放"); } catch (e) { /* noop */ }
        }
      } else {
        // 代理模式: 本机没直连引擎, 预载音频已在 flags 写回(等 pl 端 hook 从 30000 拉), 不重复发声
        try { if (message.id) pendingTts.set(message.id, { text: speakText, ts: Date.now() }); } catch (e) { /* noop */ }
      }
      // 立即广播预合成音频(全员同声; socket 不通时 pl 仍可从 flags 拿到)
      try {
        if (message.id && window.__fvttTTSPreloadAudio.audioUrl) {
          const _relP = String(window.__fvttTTSPreloadAudio.audioUrl).startsWith("http") ? new URL(window.__fvttTTSPreloadAudio.audioUrl).pathname : window.__fvttTTSPreloadAudio.audioUrl;
          const _updP = { "flags.gpt-sovits-tts.audioUrl": _relP };
          try { if (window.__fvttTTSPreloadAudio.dataUrl && window.__fvttTTSPreloadAudio.dataUrl.length < 400000) _updP["flags.gpt-sovits-tts.audioData"] = window.__fvttTTSPreloadAudio.dataUrl; } catch (e) { /* noop */ }
          safeMsgWrite(message, _updP);
        }
      } catch (e) { /* noop */ }
      // 🔊 单通道: 预载本地播放 audioPlay 已自动触发官方 playAudio 事件广播(见 audioPlay);
      // 不再自定义 socket 广播(播放统一走 Foundry 内置语音通道)。
      try { window.__fvttTTSLastSynthParams = { src: "preload" }; } catch (e) { /* noop */ }
      console.debug("[gpt-sovits-tts] 预加载音频直接播出 (零等待)");
      return;
    }
    // 非作者(无预加载缓存): 走下方正常流程(等广播/兜底)
  }
  if (decision.isSelf) {
    // 作者: 本地合成 + socket 广播 → 全员播放同一段音频(同一个声音)
    if (window.__fvttTTSCanDirect === false) {
      // 代理模式(统一): 本机连不到 9881(HTTPS 穿透/跨网/9831 不可达/低配服务器) → 不直连合成,
      // 由 GM 端 createChatMessage hook 收到本消息的 flags.synthRequest 后代为合成, 写回 flags.audioUrl → 全员(含自己)从 Foundry 30000 拉取播放
      try {
        const mid = message.id || "";
        if (mid) pendingTts.set(mid, { text: speakText, ts: Date.now() });
        setTimeout(() => { try { if (pendingTts.has(mid)) pendingTts.delete(mid); } catch (e) { /* noop */ } }, 30000);
      } catch (e) { /* noop */ }
      return;
    }
    // 1.6.132 防重复: 同一句刚被打字停顿朗读预读过(30s 内) → 发送时作者本地不重播(他人照常听)
    if (_heardTyping) { try { window.__fvttTTSLastSkipLocal = (window.__fvttTTSLastSkipLocal || 0) + 1; } catch (e) { /* noop */ } }
    try { await speak(speakText, { ...opts, skipAiEmotion: true, broadcast: true, messageId: message.id || "", silentLocal: _heardTyping }); }
    catch (e) { console.warn("[gpt-sovits-tts] 朗读异常(已忽略):", e); }
  } else if (window.__fvttTTSCanDirect === false) {
    // 代理模式(非作者): 不设 15s 兜底合成(9881 不可达), 登记 pending — flags.audioUrl 同步到达即播放(updateChatMessage hook), 没到则静默等 GM
    try {
      const mid = message.id || "";
      if (mid && !playedIds.has(mid)) pendingTts.set(mid, -1);   // -1 哨兵: 仅登记, 播放/超时清理
    } catch (e) { /* noop */ }
  } else if (game.socket && typeof game.socket.on === "function") {
    // 其他客户端: 等发言者的广播音频; 兜底超时后本地合成(广播通道故障时)
    const mid = message.id || "";
    // ⚠️ 代理模式玩家消息(flags.synthRequest): GM 端 createChatMessage hook 正在代合成并写回(玩家角色) →
    // 绝不本端模型兜底(否则"玩家角色合成一遍 + GM 当前模型合成一遍" = 两个不同语音); 只登记 pending 等写回播放
    if (fl && fl.synthRequest) {
      try {
        if (mid && !playedIds.has(mid)) pendingTts.set(mid, -1);   // -1 哨兵: 仅登记, 播放/超时清理
      } catch (e) { /* noop */ }
      return;
    }
    pendingTts.set(mid, setTimeout(() => {
      pendingTts.delete(mid);
      if (mid && playedIds.has(mid)) return;   // 广播音频已播放过, 不再兜底
      // 作者已写回音频(flags.audioUrl/audioData 存在 → update hook 会播/已播) → 不再兜底合成 —
      // 根治"作者一遍 + 他端兜底一遍 = 两个语音/几遍"(兜底仅在作者 15s 内完全没产出音频时)
      try {
        const mNow = mid ? game.messages.get(mid) : null;
        const fNow = (mNow && mNow.flags && mNow.flags[MODULE]) || {};
        if (fNow.audioUrl || fNow.audioData) {
          try { playedIds.add(mid); setTimeout(() => { try { playedIds.delete(mid); } catch (e2) { /* noop */ } }, 30000); } catch (e2) { /* noop */ }
          return;
        }
      } catch (e) { /* noop */ }
      // 兜底合成用**消息 flags 的作者角色/参考音频**(speak role 参数 + overrides 已带 fl.ref 等),
      // 绝不用本端当前模型 — 两个不同语音的根治
      speak(speakText, { ...opts, skipAiEmotion: true, broadcast: false, role: (fl && fl.role) || null });
    }, 15000));
  } else {
    speak(speakText, { ...opts, skipAiEmotion: true, broadcast: false });
  }
}

/* ============ 状态灯 ============ */
let _statusRetryT = null;

/** 1.6.130 引擎健康探针(轻量: /health 秒回, 不做重活)。
 *  返回值:
 *    { state: "up",       busy, ttsBusyS }  引擎在线(可能正在合成)
 *    { state: "busy" }                      端口在、也在回答, 只是 /status 恰好慢(合成中)
 *    { state: "refused" }                   连接被拒 = 进程没起来(等看门狗拉起)
 *    { state: "hung" }                      连上了但一直不回 = 进程在但卡死(需要重启)
 *    { state: "unknown" }                   其他(旧版引擎没有 /health)
 *  判定"卡死"的关键是耗时: 连接被拒是"立刻失败", 卡死会一直等到超时。 */
async function probeEngineHealth(serverUrl, timeoutMs = 2500) {
  const base = String(serverUrl || "").replace(/\/+$/, "");
  if (!base) return { state: "unknown" };
  const t0 = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
  try {
    const ac = (typeof AbortController !== "undefined") ? new AbortController() : null;
    const tid = setTimeout(() => { try { if (ac) ac.abort(); } catch (e) { /* noop */ } }, timeoutMs);
    let resp;
    try {
      resp = await fetch(base + "/health", { signal: ac ? ac.signal : undefined, cache: "no-store" });
    } finally { clearTimeout(tid); }
    const ms = ((typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now()) - t0;
    if (resp && resp.ok) {
      let j = {};
      try { j = await resp.json(); } catch (e) { /* noop */ }
      return { state: "up", busy: Number(j.busy || 0), ttsBusyS: Number(j.tts_busy_s || 0), ms, apiVersion: String(j.api_version || ""), stuckLimitS: Number(j.stuck_limit_s || 0) };
    }
    if (resp && (resp.status === 404 || resp.status === 405)) return { state: "unknown", ms };   // 旧引擎没有 /health
    return { state: "hung", ms, status: resp && resp.status };
  } catch (e) {
    const ms = ((typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now()) - t0;
    const msg = String((e && e.message) || e || "");
    // abort = 到点还没回 → 连上了但不响应(卡死); TypeError/Failed to fetch 且很快失败 → 进程没起来
    const aborted = /abort/i.test(msg);
    if (aborted) return { state: "hung", ms, reason: "timeout" };
    if (ms < (timeoutMs * 0.6)) return { state: "refused", ms, reason: msg };
    return { state: "unknown", ms, reason: msg };
  }
}

/* ---------- 1.6.136 模型池预热(仿 Shinsekai: 服务启动即预载模型, 首句零等待) ---------- */
let _warmPoolTs = {};
/** 后台请求引擎把该角色模型预加载进常驻池: 重启后/切角后的第一句语音就不用现场加载(省 30s~几分钟).
 *  只影响"请求里的角色≠引擎默认角色"的首次合成(那是唯一慢在模型加载的地方). 成功才节流(2分钟/角色). */
async function warmModelPool(role) {
  try {
    if (!role) return;
    if (game.user && !game.user.isGM && window.__fvttTTSCanDirect !== true) return;   // 代理模式: GM 端会预热, 非GM不重复打
    const now = Date.now();
    if (_warmPoolTs[role] && now - _warmPoolTs[role] < 120000) return;
    const srv = String(getCfg().serverUrl || "http://127.0.0.1:9881").replace(/\/+$/, "");
    if (!srv) return;
    const fd = await fetch(srv + "/characters/preload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ names: [role], max_workers: 2 }),
    }).catch(() => null);
    if (!fd || !fd.ok) return;                                  // 引擎未起/网络失败: 不节流, 下次触发再试
    _warmPoolTs[role] = now;
    try { const j = await fd.json().catch(() => null); if (j && j.loaded) console.debug("[gpt-sovits-tts] 模型池预热完成: " + role + " → " + JSON.stringify(j.loaded)); } catch (e) { /* noop */ }
  } catch (e) { /* noop */ }
}

async function checkStatus(force = false) {
  const cfg = getCfg();
  if (!cfg.enabled && !force) return;
  if (cfg.engine !== "gptsovits") { setStatus(null); return; }
  if (window.__fvttTTSCanDirect === false) {
    // 代理模式(HTTPS 穿透/跨网/9881 不可达/低配服务器): 不走直连探测 — 显示"GM 代理"(绿色), 绝不显示误导性"无法连接"
    setStatus(true, { mode: "proxy", message: "GM 代理合成" });
    clearTimeout(_statusRetryT);
    return;
  }
  if (window.__fvttTTSCanDirect === undefined) {
    // 可达性探测尚未完成(页面刚加载): 不显示"未连接", 稍后随探测结果刷新
    clearTimeout(_statusRetryT);
    _statusRetryT = setTimeout(() => checkStatus(false), 2500);
    return;
  }
  const r = await gptSovitsStatus(cfg.serverUrl).catch(() => ({ ok: false, data: null }));
  // 1.6.107 引擎离线/恢复提示(只提醒一次 + 告诉怎么自动启动): 以前引擎没开时只会在控制台刷
  //   "直连TTS失败(重试3次仍败): .../config"，用户不知道该开引擎
  // 1.6.130 区分三种情况(用户被"引擎未启动"误导过: 其实引擎在跑, 只是卡死不响应):
  //   连接被拒 = 真没启动(看门狗会在 Foundry 起来后自动拉起, 约 1~2 分钟)
  //   连上但不回 = 进程在但卡死(引擎会自愈退出 + 看门狗重启, 约 1~2 分钟)
  //   /health 说 busy = 正在合成, 不算故障, 不打扰
  try {
    const _wasDown = window.__fvttTTSEngineDown === true;
    if (!r.ok) {
      // 先探 /health: 排除"只是 /status 慢"和"卡死 vs 未启动"
      const _h = await probeEngineHealth(cfg.serverUrl).catch(() => ({ state: "unknown" }));
      if (_h.state === "up") {
        // 引擎活着(/status 可能刚好在合成高峰超时) → 不算故障
        window.__fvttTTSEngineDown = false;
        window.__fvttTTSEngineDownWarned = false;
        if (_wasDown) { try { ui.notifications.info("TTS 引擎已就绪 ✓ 可以正常朗读了"); } catch (e2) { /* noop */ } }
        try { warmModelPool(String((loadVoiceProfile().current) || (quickChars && quickChars.active) || "")); } catch (e2) { /* noop */ }   // 1.6.136 引擎恢复即预热当前角色
      } else {
        window.__fvttTTSEngineDown = true;
        if (!_wasDown && window.__fvttTTSEngineDownWarned !== true) {
          window.__fvttTTSEngineDownWarned = true;
          const _url = cfg.serverUrl;
          const _tip = (_h.state === "hung")
            ? ("TTS 引擎无响应(" + _url + ")：进程还在但卡住了。引擎会自己退出、看门狗随后自动重启它（约 1~2 分钟，期间不用管）；急用可双击 engine\\停止引擎.bat 再双击 engine\\启动引擎(无窗口).vbs")
            : ("TTS 引擎未启动(" + _url + ")：装了 engine\\安装看门狗自启.bat 时，它会在 Foundry 起来后自动静默启动引擎（约 1~2 分钟）；没有就双击 engine\\启动引擎(无窗口).vbs");
          try { ui.notifications.warn(_tip, { permanent: false }); } catch (e2) { /* noop */ }
        }
      }
    } else if (_wasDown) {
      window.__fvttTTSEngineDown = false;
      window.__fvttTTSEngineDownWarned = false;   // 1.6.130: 恢复后重置, 再掉线还会提醒一次
      try { ui.notifications.info("TTS 引擎已就绪 ✓ 可以正常朗读了"); } catch (e2) { /* noop */ }
    }
  } catch (e) { /* noop */ }
  setStatus(r.ok, r.data);
  if (r.ok) { try { warmModelPool(String((loadVoiceProfile().current) || (quickChars && quickChars.active) || "")); } catch (e) { /* noop */ } }   // 1.6.136 在线即预热当前角色(节流2分钟)
  // 服务不可用(启动/重启窗口 ~1-2 分钟)时快速重试, 恢复后状态灯自动回绿
  // 1.6.107 5s→15s: 引擎没启动时不要每 5 秒发一次请求(控制台/网络都清爽)
  if (!r.ok && !force) {
    clearTimeout(_statusRetryT);
    _statusRetryT = setTimeout(() => checkStatus(false), 30000);   // 1.6.128 15s→30s: 引擎长时间离线时少刷控制台
  }
}

function setStatus(ok, data) {
  statusInfo = { ok, data };
  updateStatusUI();
}

function statusTitle() {
  const cfg = getCfg();
  if (cfg.engine !== "gptsovits") return _L("status.web", "引擎: 浏览器系统语音");
  if (statusInfo.ok) {
    if (statusInfo.data && statusInfo.data.mode === "proxy") return _L("status.proxy", "TTS · GM 代理合成");
    const c = statusInfo.data?.character;
    const name = c?.name || statusInfo.data?.version || "";
    return `${_L("status.ok", "TTS 服务在线")} · ${name}`;
  }
  if (statusInfo.ok === false) return `${_L("status.fail", "TTS 服务离线")} · ${cfg.serverUrl}\n${_L("status.failHint", "启动方式: 运行一次 engine\\安装看门狗自启.bat(无窗口, Foundry 一起来自动拉起引擎); 临时可双击 engine\\启动引擎(无窗口).vbs")}`;
  return _L("status.checking", "检查 TTS 服务…");
}

/* ============ UI ============ */
function buildUI() {
  // 悬浮小工具条: fixed 挂 body, 可拖动, 不依赖聊天面板布局(不挤/不裁/不弹走)
  let bar = document.getElementById("fvtt-tts-floatbar");
  if (bar && document.body.contains(bar)) return;
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "fvtt-tts-floatbar";
    bar.className = "fvtt-tts-floatbar";
    bar.title = _L("ui.floatTip", "拖动可移动位置");
    bar.innerHTML = `
      <span class="fvtt-tts-status" title="${_L("status.checking", "检查 TTS 服务…")}"></span>
      <select class="fvtt-tts-lang" title="${_L("ui.langTip", "朗读输出语种（也是自动翻译目标语言）")}"></select>
      <select class="fvtt-tts-char"></select>
      <select class="fvtt-tts-emotion"></select>
      <button type="button" class="fvtt-tts-voice" title="${_L("ui.voiceMgr", "语音设置（角色/语气/模型/语速）")}"><i class="fa-solid fa-sliders"></i></button>
      <button type="button" class="fvtt-tts-mic" title="${_L("ui.mic", "语音听写(点击开始/停止)")}"><i class="fa-solid fa-microphone"></i></button>
      <button type="button" class="fvtt-tts-selftest" title="${_L("ui.selfTest", "全面测试(28场景: 合成/转发/播放/并发/压力; GM 跑综合套件, 玩家跑玩家套件)")}"><i class="fa-solid fa-stethoscope"></i></button>
      <button type="button" class="fvtt-tts-gmtest" style="display:none" title="GM 综合测试(26+)场景: 引擎直测/多角色·多语气并发/压力连发/坏参/广播阻断/全员延迟)"><i class="fa-solid fa-flask"></i></button>
      <button type="button" class="fvtt-tts-send" title="${_L("ui.send", "发送到聊天框（选语气并自动朗读）")}"><i class="fa-solid fa-paper-plane"></i></button>`;
    document.body.appendChild(bar);
    // 🔬 测试按钮: 玩家/GM 各自套件(1.5.0); GM 另有专属综合测试按钮
    const stBtn = bar.querySelector(".fvtt-tts-selftest");
    if (stBtn) {
      stBtn.addEventListener("click", (ev) => { ev.stopPropagation(); try { if (window.__fvttTTSTests) window.__fvttTTSTests.runAuto(); } catch (e) { console.error(e); } });
    }
    const gmBtn = bar.querySelector(".fvtt-tts-gmtest");
    if (gmBtn) {
      try { if (game.user && game.user.isGM) { gmBtn.style.display = ""; } } catch (e) { /* noop */ }
      gmBtn.addEventListener("click", (ev) => { ev.stopPropagation(); try { if (window.__fvttTTSTests) window.__fvttTTSTests.runGmSuite(); } catch (e) { console.error(e); } });
    }
    // 1.6.148 开发者测试按钮默认隐藏(devTools=关); 需要时在设置里打开
    const stDot = bar.querySelector(".fvtt-tts-status");
    if (stDot) stDot.addEventListener("click", (ev) => { ev.stopPropagation(); try { checkStatus(true); } catch (e) { /* noop */ } });
    try { applyDevButtons(); } catch (e) { /* noop */ }
  }
  try { updateStatusUI(); } catch (e) { /* noop */ }
  // 语种选择(朗读输出语言 = 自动翻译目标): 中/日/英/韩/粤 + 自动
  const langSel = bar.querySelector(".fvtt-tts-lang");
  if (langSel) {
    langSel.innerHTML = `<option value="auto">${_L("settings.textLang.auto", "自动")}</option><option value="zh">${_L("settings.textLang.zh", "中文")}</option><option value="ja">${_L("settings.textLang.ja", "日语")}</option><option value="en">${_L("settings.textLang.en", "英语")}</option><option value="ko">${_L("settings.textLang.ko", "韩语")}</option><option value="yue">${_L("settings.textLang.yue", "粤语")}</option>`;
    langSel.value = getCfg().textLang || "auto";
    langSel.addEventListener("change", () => {
      const v = langSel.value || "auto";
      game.settings.set(MODULE, "textLang", v).then(() => {
        notifyOnce(_L("ui.langSet", `朗读语种: ${v}`), "info");
      }).catch(() => {});
    });
  }
  // 拖动(整条可拖; 位置持久化, 刷新后保持)
  try { makeDraggable(bar, bar, { persistKey: "fvtt-tts-floatbar-pos" }); } catch (e) { /* noop */ }
  // GM 全局静音已从快捷栏移除, 仅在语音设置面板提供(world 设置 gmMute, restricted, 仅 GM 可改)
  // 角色/情绪下拉(数据由 renderQuickUI 填充)
  const charSel = bar.querySelector(".fvtt-tts-char");
  const emoSel = bar.querySelector(".fvtt-tts-emotion");
  // 限速强制刷新角色数据(服务端可能更新过槽/标签; 8s 内不重复拉)
  let _qcLastForce = 0;
  const refreshQuickCharsSoon = async () => {
    const now = Date.now();
    if (now - _qcLastForce < 8000) return;
    _qcLastForce = now;
    try { await loadQuickChars({ force: true }); } catch (e) { /* noop */ }
    try { renderQuickUI(); renderSendPopEmotions(); } catch (e) { /* noop */ }
  };
  charSel.addEventListener("change", async () => {
    const name = charSel.value;
    if (!name) return;
    await refreshQuickCharsSoon();   // 先拉最新角色数据再切换
    const prof = loadVoiceProfile();
    prof.current = name;
    if (!prof.chars) prof.chars = {};
    if (!prof.chars[name]) prof.chars[name] = { name, avatar: "", emotion: "", ref: "", promptText: "", promptLang: "", speed: 0, volume: 0 };
    prof.chars[name].emotion = "";
    prof.emotion = "";   // 切换角色重置语气(渲染读顶层 prof.emotion, 不同步会导致下拉/网格残留旧角色语气)
    // 默认用该角色主参考(朗读时无需服务端激活)
    const c = (quickChars && quickChars.chars || []).find(x => x.name === name);
    prof.chars[name].ref = c && c.ref_audio_path ? `fvtt_chars/${name}/${c.ref_audio_path}` : "";
    prof.chars[name].promptText = (c && c.prompt_text) || "";
    prof.chars[name].promptLang = (c && c.prompt_lang) || "";
    await saveVoiceProfile(prof);
    // 只有本机是"语音运行者"(自己跑服务)才同步服务端激活角色 — 其他人选角色纯本地(听广播, 互不联动)
    const cfgV = getCfg();
    if (!cfgV.voiceRunner || cfgV.voiceRunner === "self") {
      try {
        const r = await svcRequest(cfgV.serverUrl, "POST", "/characters/switch", { name });
        await r.json;
      } catch (e) { /* 服务不可达时仅本地生效 */ }
    }
    renderQuickUI();
    try { warmModelPool(name); } catch (e) { /* noop */ }   // 1.6.136 切角即后台预加载该角色模型(首句零等待, 不再卡顿等加载)
  });
  emoSel.addEventListener("change", async () => {
    const prof = loadVoiceProfile();
    const name = prof.current || "";
    await applyEmotion(emoSel.value, name);
    renderQuickUI();
    refreshQuickCharsSoon();   // 数据可能旧, 拉完重绘(下次选项即最新)
  });
  // 按钮
  bar.querySelector(".fvtt-tts-voice").addEventListener("click", (ev) => { ev.stopPropagation(); VoiceManager.open(); });
  bar.querySelector(".fvtt-tts-mic").addEventListener("click", (ev) => { ev.stopPropagation(); toggleDictation(); });
  bar.querySelector(".fvtt-tts-send").addEventListener("click", (ev) => { ev.stopPropagation(); openSendPop(); });
  updateMicUI();
  renderQuickUI();
}

function findChatTextarea() {
  let ta = document.getElementById("chat-message")
    || document.querySelector("#chat-form textarea")
    || document.querySelector("textarea[name='message']");
  if (!ta && game && game.webbrowsers) {
    // 分离窗口(浮动聊天面板): 到其它浏览器窗口里找
    try {
      const wins = game.webbrowsers.browsers || [];
      for (const w of wins) {
        const d = w && w.window && w.window.document;
        if (!d) continue;
        ta = d.getElementById("chat-message") || d.querySelector("textarea[name='message']");
        if (ta) break;
      }
    } catch (e) { /* noop */ }
  }
  return ta;
}

function submitChatInput() {
  try {
    let ta = findChatTextarea();
    if (!ta) {
      // 面板可能还在渲染: 延迟 300ms 重试一次
      setTimeout(() => {
        const ta2 = findChatTextarea();
        if (!ta2) { notifyOnce(_L("ui.sendFail", "找不到聊天输入框"), "warn"); return; }
        doSubmitChat(ta2);
      }, 300);
      return;
    }
    doSubmitChat(ta);
  } catch (e) { console.error("[gpt-sovits-tts] 发送失败:", e); }
}

// 防重复提交(AI 判断慢时连点会出多个语音) → window 共享(双实例也拦得住)

async function doSubmitChat(ta, opts = {}) {
  const _sr = (window.__fvttTTSLastSubmitResult = { ok: false, reason: "", ts: Date.now() });
  const v = String(ta.value || "").trim();
  if (!v) { _sr.reason = "empty"; notifyOnce(_L("ui.sendEmpty", "输入框为空"), "info"); return _sr; }
  if (v.startsWith("/")) {
    // 命令行必须走 Foundry 自带回车解析(避免手动创建破坏命令语义)
    _sr.reason = "command";
    notifyOnce(_L("ui.cmdHint", "命令(以/开头的行)请直接按回车发送"), "info");
    return _sr;
  }
  if (window.__fvttTTSSubmitLock) { _sr.reason = "locked"; notifyOnce(_L("ui.sending", "正在发送…"), "info"); return _sr; }
  // 1.6.150 防双发: 同句 1.2 秒内重复提交才忽略(以前 4 秒, 连发两次「……」都会被静默吞掉);
  //   而且会给出轻提示(不再只写控制台), 用户能看懂"为什么没发出去"。
  const _sLast = window.__fvttTTSLastSent || null;
  if (_sLast && Math.abs(Date.now() - _sLast.ts) < 1200 && _sLast.text === v) {
    _sr.reason = "dup-1.2s";
    notifyOnce(_L("ui.dupSend", "同一句刚发过，已忽略重复提交"), "info");
    return _sr;
  }
  window.__fvttTTSSubmitLock = true;
  try {
    // 手动创建消息: 不触发表单默认提交(避免浏览器刷新/崩溃), 仍走 createChatMessage → 全员同声朗读
    // 发送已与 AI 调配解耦: 消息立即发送上屏; AI 判断+润色在朗读环节(maybeSpeak)异步完成, 聊天不再被 LLM 阻塞
    const prof1 = loadVoiceProfile();
    const cur1 = (prof1.chars && prof1.chars[prof1.current]) || null;
    // 兜底: 当前角色主参考为空时(老档案/未设置)从角色数据补齐, 避免朗读串成服务端默认角色
    let refV = (cur1 && cur1.ref) || "";
    let pT = (cur1 && cur1.promptText) || "";
    let pL = (cur1 && cur1.promptLang) || "";
    if (!refV && quickChars && Array.isArray(quickChars.chars)) {
      const cC = quickChars.chars.find(x => x.name === (prof1.current || ""));
      if (cC && cC.ref_audio_path) {
        refV = `fvtt_chars/${prof1.current}/${cC.ref_audio_path}`;
        if (!pT) pT = cC.prompt_text || "";
        if (!pL) pL = cC.prompt_lang || "ja";
      }
    }
    const data = {
      content: v,
      speaker: ChatMessage.getSpeaker(),
      flags: { [MODULE]: {
        role: prof1.current || "",
        emotion: (cur1 && cur1.emotion) || "",
        ref: refV,
        auxRef: (cur1 && cur1.auxRef) || "",
        promptText: pT,
        promptLang: pL,
        emotionMix: (cur1 && typeof cur1.emotionMix === "number") ? cur1.emotionMix : 0,   // 1.6.111 0=自动
        emotionMod: (cur1 && typeof cur1.emotionMod === "number") ? cur1.emotionMod : 0,
        polish: (cur1 && cur1.polishText) || "",
        speed: (cur1 && cur1.speed) || 0,
        lang: getCfg().textLang || "auto",
        fromModSend: true,   // 1.6.42 朗读白名单标记: 只有通过本模块发送框发出的文字才朗读
        // 1.6.99 AI 直出标记: 强度=0 时让 AI 自己决定语速/停顿
        ...(opts && opts.aiDirect ? { aiDirect: true } : {}),
        // 代理模式(本机连不到 9881): 附上合成请求 → GM 端 createChatMessage hook 代为合成并写回 flags.audioUrl → 全员播放
        ...(window.__fvttTTSCanDirect === false ? { synthRequest: { text: v, lang: getCfg().textLang || "auto", role: prof1.current || "", emotion: (cur1 && cur1.emotion) || "", speed: (cur1 && cur1.speed) || 0, provider: String((cur1 && cur1.ttsProvider) || "gpt-sovits") } } : {})
      } }
    };
    if (CONST.CHAT_MESSAGE_STYLES) data.style = CONST.CHAT_MESSAGE_STYLES.IC;
    else data.type = CONST.CHAT_MESSAGE_TYPES.IC;
    try {
      const _msg = await ChatMessage.create(data);
      _sr.ok = true; _sr.reason = "created"; _sr.id = (_msg && _msg.id) || "";
      // 1.6.150 只在真正发送成功后记录(以前创建失败也会占位 4 秒, 重试被误判为重复)
      try { window.__fvttTTSLastSent = { text: v, ts: Date.now() }; } catch (e) { /* noop */ }
      try { ta.value = ""; ta.focus(); } catch (e) { /* noop */ }
      refreshPreloadBtn();   // 1.6.102 发送后输入框已清空 → 预加载按钮立即回到"AI 预加载"(不再一直显示已加载)
      // 1.6.134 发送即消费: 清掉本次预加载缓存, 按钮真正复位; 下一句由"自动预加载"在停顿时重新预合成
      try { if (window.__fvttTTSPreloadAudio) { try { if (window.__fvttTTSPreloadAudio.url) URL.revokeObjectURL(window.__fvttTTSPreloadAudio.url); } catch (e) { /* noop */ } window.__fvttTTSPreloadAudio = null; } } catch (e) { /* noop */ }
    } catch (err) {
      _sr.reason = "create-error:" + String((err && err.message) || err).slice(0, 120);
      console.error("[gpt-sovits-tts] 消息创建失败:", err);
      notifyOnce(_L("ui.sendFail", "发送失败"), "warn");
    }
  } finally {
    window.__fvttTTSSubmitLock = false;
  }
  return _sr;
}

/* ---------- 发送并朗读面板: 语气选择 + 调配设定 ---------- */

/** 应用语气(情绪槽)到当前语音档案, 供工具条下拉/发送面板共用
 *  用户要求: 在默认(主参考)基础上添加情绪, 而不是只有情绪音频作参考.
 *  实现: 主参考为基础音色(永不丢弃) + 情绪槽音频作 aux 参考叠加情绪特征(多参考融合). */
async function applyEmotion(emotion, name) {
  try {
    const prof = loadVoiceProfile();
    const charName = name || prof.current || (quickChars && quickChars.active) || "";
    if (!charName) return false;
    prof.current = charName;
    prof.chars = prof.chars || {};
    if (!prof.chars[charName]) prof.chars[charName] = { name: charName, avatar: "", emotion: "", ref: "", auxRef: "", promptText: "", promptLang: "", speed: 0, volume: 0 };
    const cur = prof.chars[charName];
    cur.emotion = emotion || "";
    prof.emotion = emotion || "";   // 顶层同步(渲染读 prof.emotion, 高亮才随点击变化)
    if (typeof cur.emotionMix !== "number") cur.emotionMix = 0;   // 0 = 自动(选了带参考音的槽时按 0.5 = 基础音+情绪叠加)
    if (typeof cur.emotionMod !== "number") cur.emotionMod = 0;   // 0 = 自动: 按 AI/情绪决定语速
    const c = (quickChars && quickChars.chars || []).find(x => x.name === charName);
    const slot = c && c.emotions.find(s => s.key === emotion);
    const mainRef = c && c.ref_audio_path ? `fvtt_chars/${charName}/${c.ref_audio_path}` : "";
    const mainPrompt = (c && c.prompt_text) || "";
    const mainLang = (c && c.prompt_lang) || "ja";
    // 主参考为基础(角色音色不变)
    cur.ref = mainRef;
    cur.promptText = mainPrompt;
    cur.promptLang = mainLang;
    if (slot && slot.ref_audio_path) {
      // 情绪音频作 aux 参考, 在主参考音色上叠加情绪特征
      cur.auxRef = `fvtt_chars/${charName}/${slot.ref_audio_path}`;
      if (slot.prompt_text) { cur.promptText = slot.prompt_text; cur.promptLang = slot.prompt_lang || mainLang; }
      // 1.6.109 选中语气槽 = 明确要用这条情绪参考音; 若占比是 0(以前滑到 0%) 引擎会把它丢掉 → 纠正成 1.0
      if (!(typeof cur.emotionMix === "number" && cur.emotionMix > 0)) cur.emotionMix = 0.5;
    } else {
      cur.auxRef = "";
    }
    await saveVoiceProfile(prof);
    renderQuickUI();
    try { warmModelPool(charName); } catch (e) { /* noop */ }   // 1.6.136 切角/选语气即后台预热该角色(重启后首句零等待)
    return true;
  } catch (e) { console.error("[gpt-sovits-tts] 应用语气失败:", e); return false; }
}

function sendPopCurrentChars() {
  return (quickChars && quickChars.chars) || [];
}

// 1.6.102 预加载按钮状态复核(修"预加载发送之后按钮还显示 ✓已预加载 / 已加载完"):
//   发送成功后 textarea 是程序清空的(.value=""), 不会触发 input 事件 → 旧逻辑只在"打字"时才重置按钮,
//   于是一整局都停在"已预加载"。现在改成: 任何"打开面板/打字/发送完成"时都按
//   「当前输入文字 + 声音签名(角色/语气/语言/语速)」重新算一次显示状态。
function refreshPreloadBtn() {
  try {
    const pop = window.__fvttTTSSendPopEl;
    if (!pop) return;
    const pb = pop.querySelector(".fvtt-tts-sendpop-preload");
    if (!pb) return;
    if (pb.classList.contains("loading")) return;   // 合成中不打扰进度显示
    const ta = findChatTextarea();
    const t = (ta && String(ta.value || "").trim()) ? stripStageDirections(String(ta.value || "").trim()) : "";
    const ok = preloadHit(t);
    if (ok) {
      pb.textContent = _L("ui.preloadedBtn", "✓ 已预加载");
      pb.title = _L("ui.preloadedSendTip", "音频已就绪，再点直接播出");
      pb.classList.add("done");
    } else {
      pb.classList.remove("done");
      pb.textContent = _L("ui.sendPopPreload", "AI 预加载");
      pb.title = _L("ui.preloadHint", "预热 AI 并预合成当前这句话；再点一下直接发送(零等待)");
    }
  } catch (e) { /* noop */ }
}

function buildSendPop() {
  if (window.__fvttTTSSendPopEl && document.body.contains(window.__fvttTTSSendPopEl)) return window.__fvttTTSSendPopEl;
  const pop = document.createElement("div");
  pop.className = "fvtt-tts-sendpop";
  pop.innerHTML = `
    <div class="fvtt-tts-vm-head fvtt-tts-sendpop-head">
      <i class="fa-solid fa-paper-plane"></i> ${_L("ui.sendPopTitle", "发送并朗读")}
      <span class="fvtt-tts-sendpop-close" title="${_L("ui.close", "关闭")}">✕</span>
    </div>
    <div class="fvtt-tts-sendpop-body">
      <div class="fvtt-tts-sendpop-sec">${_L("ui.sendPopEmo", "语气")}</div>
      <div class="fvtt-tts-sendpop-emogrid"></div>
      <div class="fvtt-tts-sendpop-sec">${_L("ui.sendPopTune", "调配")}</div>
      <!-- 1.6.111 这四项默认 0 = 自动: 不填就由 AI/朗读提示词/引擎自己决定 -->
      <div class="fvtt-tts-sendpop-tune">
        <label class="fvtt-tts-sendpop-tuneline"><span title="${_L("ui.volumeTip", "0 = 自动（引擎默认响度）；调大/调小才手动指定")}">${_L("ui.volume", "朗读音量")} <b class="fvtt-tts-sendpop-volval">自动</b></span><input type="range" class="fvtt-tts-sendpop-vol" min="0" max="1" step="0.05" value="0"></label>
        <label class="fvtt-tts-sendpop-tuneline"><span title="${_L("ui.speedTip", "0 = 自动（交给朗读提示词与 AI 决定语速）")}">${_L("ui.speed", "语速")} <b class="fvtt-tts-sendpop-spdval">自动</b></span><input type="range" class="fvtt-tts-sendpop-speed" min="0" max="1.5" step="0.05" value="0"></label>
        <label class="fvtt-tts-sendpop-tuneline"><span title="${_L("ui.emotionMixTip", "0 = 自动：基础音作主参考 + 情绪音作附加参考叠加（保留角色音色）；100% = 情绪音单独作参考（音色会变，短样本可能不自然）")}">${_L("ui.emotionMix", "情绪占比")} <b class="fvtt-tts-sendpop-mixval">自动</b></span><input type="range" class="fvtt-tts-sendpop-mix" min="0" max="100" step="5" value="0"></label>
        <label class="fvtt-tts-sendpop-tuneline"><span title="${_L("ui.emotionModTip", "0 = 自动（按 AI 判断的情绪决定语速快慢）；>0 才手动指定调制强度")}">${_L("ui.emotionMod", "情感参数调制")} <b class="fvtt-tts-sendpop-modval">自动</b></span><input type="range" class="fvtt-tts-sendpop-mod" min="0" max="100" step="5" value="0"></label>
<label class="fvtt-tts-sendpop-tuneline"><span title="${_L("ui.styleTip", "朗读提示词：如“更严肃认真、中间不要中断”。会翻译成语速/停顿等合成参数，角色独立记得。")}">${_L("ui.stylePrompt", "朗读提示词")}</span><input type="text" class="fvtt-tts-sendpop-style" placeholder="${_L("ui.stylePh", "如：更严肃认真，中间不要中断")}" maxlength="120"></label>
        <div class="fvtt-tts-sendpop-tuneline"><span title="${_L("ui.styleStrTip", "提示词强度：0%=交给 AI 自动，100%=完全按提示词")}">${_L("ui.styleStr", "强度")}</span><input type="range" class="fvtt-tts-sendpop-stylestr" min="0" max="100" step="5" value="0"><b class="fvtt-tts-sendpop-stylestrval">0%</b></div>
      </div>
      <div class="fvtt-tts-sendpop-actions">
        <button type="button" class="fvtt-tts-sendpop-preload">🚀 ${_L("ui.sendPopPreload", "AI 预加载")}</button>
        <button type="button" class="fvtt-tts-sendpop-direct">🎯 ${_L("ui.sendPopDirect", "AI 直出")}</button>
        <button type="button" class="fvtt-tts-sendpop-openvm">${_L("ui.sendPopFull", "完整语音设置…")}</button>
      </div>
      <div class="fvtt-tts-sendpop-foot">
        <button type="button" class="fvtt-tts-sendpop-cancel">${_L("ui.cancel", "取消")}</button>
        <button type="button" class="fvtt-tts-sendpop-fire">${_L("ui.sendPopSend", "立即发送(用当前)")}</button>
      </div>
    </div>`;
  document.body.appendChild(pop);

  // 关闭
  pop.querySelector(".fvtt-tts-sendpop-close").addEventListener("click", closeSendPop);
  pop.querySelector(".fvtt-tts-sendpop-cancel").addEventListener("click", closeSendPop);
  // 完整语音设置
  pop.querySelector(".fvtt-tts-sendpop-openvm").addEventListener("click", () => { closeSendPop(); VoiceManager.open(); });
  // 🎯 AI 直出: 预加载后点一下 → 立即发送(聊天零等待); AI 语气+润色由朗读环节后台判断(声音带语气晚到)
  pop.querySelector(".fvtt-tts-sendpop-direct").addEventListener("click", () => {
    const ta = findChatTextarea();
    const txt = ta ? String(ta.value || "").trim() : "";
    if (!txt) { ui.notifications.warn(_L("ui.aiNeedText", "先在聊天输入框写点内容")); return; }
    const cfgD = getCfg();
    if (!cfgD.llmEnabled || !cfgD.llmKey) {
      ui.notifications.warn(_L("ui.aiNoKey", "未配置 AI：请到语音设置填 API 密钥并开启 LLM，或先点预加载"));
      return;
    }
    // 直出 = 提交即发送; 朗读环节自动 AI 判断+润色(选了手动语气则用所选); 1.6.99 强度=0 时由 AI 决定语速
    closeSendPop();
    doSubmitChat(ta, { aiDirect: true });
  });
  // 🚀 AI 预加载: 预热 LLM + 预合成当前输入文本的音频; 
  //   done + 文字一致 → 再点直接发送(播出预合成同一段, 零等待)
  //   done + 文字已改 → 直接重合成当前文字再发送(继承进度: LLM 已热, 不再重复预热)
  //   loading(预加载进行中) → 再点直接发送(继承进度, 不等待; 朗读走正常合成)
  pop.querySelector(".fvtt-tts-sendpop-preload").addEventListener("click", async () => {
    const btnP2 = pop.querySelector(".fvtt-tts-sendpop-preload");
    const ta = findChatTextarea();
    const tnow = (ta && String(ta.value || "").trim()) ? stripStageDirections(String(ta.value || "").trim()) : "";
    if (!tnow) { ui.notifications.warn(_L("ui.aiNeedText", "先在聊天输入框写点内容")); return; }
    // 预加载进行中点击 → 继承进度直接发送(不等预加载完成; 朗读走正常合成, 服务端 LLM 已热的部分照用)
    if (btnP2.classList.contains("loading")) {
      closeSendPop();
      doSubmitChat(ta);
      return;
    }
    // done + 文字一致 且 角色/语气/语言未变 → 直接发送并播出预合成的同一段音频(零等待)
    if (btnP2.classList.contains("done") && preloadHit(tnow)) {
      closeSendPop();
      doSubmitChat(ta);
      return;
    }
    // 1.6.142 修: 预合并**不需要** LLM —— 之前"未配置 AI"直接 return, 导致没配 LLM 的机器
    //   点 🚀 永远不预合成(最终测试 L 段 80s 超时)。现在照常预合成(规则/手动语气), LLM 仅作可选润色/判语气。
    // done + 文字已改 → 继承进度: 不重复预热 LLM, 直接按当前文字预合成再发送
    // idle → 完整预加载(预热 LLM + 合成当前文字)
    const wasDone = btnP2.classList.contains("done");
    const alreadyWarm = !!window.__aiPreloaded || !!window.__fvttTTSPreloadAudio;
    const oldP2 = btnP2.textContent;
    btnP2.textContent = "⏳ " + (alreadyWarm ? _L("ui.preloadingNow", "合成中…") : _L("ui.preloadingNow", "预加载中…"));
    btnP2.classList.add("loading");
    btnP2.disabled = false;   // 预加载中可点击 → 直接发送(继承进度)
    try {
      if (!alreadyWarm) {
        const r = (typeof window.preloadAI === "function") ? await window.preloadAI() : null;
        if (!r || !r.ok) {
          // LLM 预热失败(API 未配/不通/502) → 不阻塞预合成: LLM 只是语气判断辅助,
          // 降级按默认/手动语气预合成(合成走 GM 代理→引擎, 与 LLM 无关; 根治"非本地玩家预加载失败 http0")
          if (window.__fvttTTSAiWarned !== true) {
            try { console.warn("[gpt-sovits-tts] AI 预热失败(降级, 按当前语气预合成): " + ((r && r.message) || "unknown")); } catch (e) { /* noop */ }
            window.__fvttTTSAiWarned = true;   // 1.6.23: 只提示一次, 不再每次打字刷控制台
          }
          window.__aiPreloaded = false;
        }
      }
      // 预合成当前输入(手动按钮与自动预加载共用 synthPreloadCore, 与发送同款 AI 语气/润色/占比)
      const rPP = await synthPreloadCore(tnow);
      if (!rPP || !rPP.ok) throw new Error((rPP && rPP.message) || "preload fail");
      btnP2.textContent = _L("ui.preloadedBtn", "✓ 已预加载");
      btnP2.title = _L("ui.preloadedSendTip", "音频已就绪，再点直接播出");
      btnP2.classList.remove("loading");
      btnP2.classList.add("done");
      try { if (!wasDone) notifyPreloadDone(tnow); } catch (e) { /* noop */ }   // 1.6.134 完成立即告知(wasDone=直接发送, 不提示"已预加载")
      // 合成完成只标记 done, 等待用户点击发送(不再自动发送; 再点即直接播出同一段零等待音频)
      // 1.6.129: wasDone = 上一轮已预加载过、这次因为文字/角色/语气变了而重合成 → 按"再点即发送"的承诺直接发送,
      //   否则用户点了没反应(最终测试 L 段"预加载→发送 消息✗"就是落在这条路径上)。
      if (wasDone) {
        try { closeSendPop(); } catch (e) { /* noop */ }
        await doSubmitChat(ta);
      }
    } catch (e) {
      btnP2.textContent = oldP2;
      btnP2.classList.remove("loading");
      ui.notifications.warn(_L("ui.preloadFail", "预加载失败") + ": " + ((e && e.message) || "unknown"));
    }
  });
  // 恢复预加载状态(1.6.102 改为统一复核): 已预合成的音频(文字一致且角色/语气/语言未变)按钮直接显示 done, 再点即发送; 文字/签名变了 → 回到未预加载
  const preBtn = pop.querySelector(".fvtt-tts-sendpop-preload");
  if (preBtn) refreshPreloadBtn();
  // 音量/语速(实时写设置) — 1.6.111: 0 = 自动(显示"自动", 交给 AI/提示词/引擎)
  const vol = pop.querySelector(".fvtt-tts-sendpop-vol");
  const spd = pop.querySelector(".fvtt-tts-sendpop-speed");
  const volVal = pop.querySelector(".fvtt-tts-sendpop-volval");
  const spdVal = pop.querySelector(".fvtt-tts-sendpop-spdval");
  const cfg0 = getCfg();
  const _fmtAuto = (v, isPct) => (Number(v) > 0 ? (isPct ? Math.round(Number(v) * 100) + "%" : Number(v).toFixed(2)) : "自动");
  vol.value = String(Number(cfg0.volume) > 0 ? Number(cfg0.volume) : 0);
  spd.value = String(Number(cfg0.speedFactor) > 0 ? Number(cfg0.speedFactor) : 0);
  if (volVal) volVal.textContent = _fmtAuto(vol.value, false);
  if (spdVal) spdVal.textContent = _fmtAuto(spd.value, false);
  vol.addEventListener("input", () => { if (volVal) volVal.textContent = _fmtAuto(vol.value, false); game.settings.set(MODULE, "volume", parseFloat(vol.value)).catch(() => {}); });
  spd.addEventListener("input", () => { if (spdVal) spdVal.textContent = _fmtAuto(spd.value, false); game.settings.set(MODULE, "speedFactor", parseFloat(spd.value)).catch(() => {}); });
  // 情绪占比 / 情感参数调制 → 保存到当前角色档案; 0 = 自动
  const saveMix = () => {
    const prof = loadVoiceProfile();
    const charName = prof.current || "";
    if (!charName) return;
    prof.chars = prof.chars || {};
    const cur = prof.chars[charName] || (prof.chars[charName] = { name: charName });
    cur.emotionMix = parseFloat(pop.querySelector(".fvtt-tts-sendpop-mix").value) / 100;
    cur.emotionMod = parseFloat(pop.querySelector(".fvtt-tts-sendpop-mod").value) / 100;
    try { saveVoiceProfile(prof); } catch (e) { /* noop */ }
    const _mk = pop.querySelector(".fvtt-tts-sendpop-mixval");
    const _md = pop.querySelector(".fvtt-tts-sendpop-modval");
    if (_mk) _mk.textContent = (parseFloat(pop.querySelector(".fvtt-tts-sendpop-mix").value) > 0 ? pop.querySelector(".fvtt-tts-sendpop-mix").value + "%" : "自动");
    if (_md) _md.textContent = (parseFloat(pop.querySelector(".fvtt-tts-sendpop-mod").value) > 0 ? pop.querySelector(".fvtt-tts-sendpop-mod").value + "%" : "自动");
  };
  pop.querySelector(".fvtt-tts-sendpop-mix").addEventListener("input", saveMix);
  pop.querySelector(".fvtt-tts-sendpop-mod").addEventListener("input", saveMix);
  // 朗读风格提示词 → 每角色独立记住
  const styleIn = pop.querySelector(".fvtt-tts-sendpop-style");
  if (styleIn) {
    const profS = loadVoiceProfile();
    const curS = (profS.chars && profS.chars[profS.current || ""]) || null;
    styleIn.value = getStylePrompt(profS.current || "") || (curS && curS.stylePrompt) || "";
    styleIn.addEventListener("input", () => {
      const cn = (loadVoiceProfile().current) || "";
      if (!cn) return;
      setStylePrompt(cn, styleIn.value || "");   // per-user 隔离: GM/玩家互不共享
      const prof = loadVoiceProfile();
      prof.chars = prof.chars || {};
      const c = prof.chars[cn] || (prof.chars[cn] = { name: cn });
      c.stylePrompt = String(styleIn.value || "").slice(0, 120);   // 双写兼容
      try { saveVoiceProfile(prof); } catch (e) { /* noop */ }
    });
    // 1.6.53 提示词强度滑块 → 每角色独立记住
    const styleStrIn = pop.querySelector(".fvtt-tts-sendpop-stylestr");
    const styleStrVal = pop.querySelector(".fvtt-tts-sendpop-stylestrval");
    if (styleStrIn && styleStrVal) {
      const _ss = styleStrengthOf(profS.current || "");
      styleStrIn.value = String(_ss);
      styleStrVal.textContent = _ss + "%";
      styleStrIn.addEventListener("input", () => {
        const cn = (loadVoiceProfile().current) || "";
        styleStrVal.textContent = styleStrIn.value + "%";
        if (!cn) return;
        const prof = loadVoiceProfile();
        prof.chars = prof.chars || {};
        const c = prof.chars[cn] || (prof.chars[cn] = { name: cn });
        c.styleStrength = parseInt(styleStrIn.value, 10) || 0;   // 1.6.132 默认 0(交给 AI), 不再是 50
        try { saveVoiceProfile(prof); } catch (e) { /* noop */ }
      });
    }
  }
  // 语气网格点击 → 只应用语气(不发送不关闭, 选完自行决定发送方式)
  pop.querySelector(".fvtt-tts-sendpop-emogrid").addEventListener("click", async (ev) => {
    const b = ev.target.closest(".fvtt-tts-sendpop-emo");
    if (!b) return;
    const emo = b.dataset.key || "";
    const label = emo ? b.textContent.trim() : _L("ui.emotionNone", "默认");
    const okE = await applyEmotion(emo);
    renderSendPopEmotions();
    console.debug("[gpt-sovits-tts] 选择语气:", emo || "(默认)", "应用结果:", okE);
  });
  // 立即发送(用当前)
  pop.querySelector(".fvtt-tts-sendpop-fire").addEventListener("click", () => {
    const ta = findChatTextarea();
    closeSendPop();
    if (ta) doSubmitChat(ta);
  });
  // 拖动(复用 voice-manager 的 makeDraggable)
  try { makeDraggable(pop, pop.querySelector(".fvtt-tts-sendpop-head")); } catch (e) { /* noop */ }
  // 点击面板外关闭
  document.addEventListener("mousedown", function onDoc(ev) {
    if (ev.target.closest && !ev.target.closest(".fvtt-tts-sendpop") && !ev.target.closest(".fvtt-tts-send")) {
      closeSendPop();
      document.removeEventListener("mousedown", onDoc);
    }
  });

  window.__fvttTTSSendPopEl = pop;
  return pop;
}

/* ---------- LLM 语气判断(可选): 有密钥时 AI 自动判断语气, 无密钥手动选择 ---------- */
async function judgeEmotionByLLM(text, charName, context) {
  const cfg = getCfg();
  if (window.__fvttTTSLlmBroken === true) return { ok: false, emotion: "", reason: "llm-broken" };
  if (!cfg.llmEnabled || !cfg.llmKey) return { ok: false, emotion: "", reason: "no-llm" };
  try {
    // 确保角色/情绪槽数据已加载(no-slots 修复: quickChars 未加载/过期时先拉取)
    if (!quickChars) { try { await loadQuickChars(); } catch (e) { /* noop */ } }
    const c = (quickChars && quickChars.chars || []).find(x => x.name === charName);
    let slots = (c && c.emotions) || [];
    if (!slots.length) {
      // 兜底: 实时向服务端要角色(缓存可能过期或未刷新) — 走统一数据源(直连/快照自动)
      try {
        await loadQuickChars({ force: true });
        const c2 = (quickChars && quickChars.chars || []).find(x => x.name === charName);
        slots = (c2 && c2.emotions) || [];
      } catch (e) { /* noop */ }
    }
    if (!slots.length) return { ok: false, emotion: "", reason: "no-slots" };
    const r = await svcRequest(cfg.serverUrl, "POST", "/llm", {
        base: cfg.llmBaseUrl || "https://api.openai.com/v1",
        key: cfg.llmKey,
        model: cfg.llmModel || "gpt-4o-mini",
        text: String(text || ""),
        context: context || "",
        emotions: slots.map(s => ({ key: s.key, label: s.label })),
        gm_prompt: (cfg.gmPrompt || ""),   // 1.6.89 主持人提示词(世界设定/朗读规则)
      }, { timeoutMs: 70000, retries: 0, quiet: true });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) {
      // LLM 服务不可用(502/404/网络) → 记具体原因并禁用后续 LLM 调用; 修好 base/key 后每 60s 自动重探恢复
      if (r.status >= 400) { markLlmBroken((j && j.message) || ("http " + r.status)); }
      return { ok: false, emotion: "", reason: (j && j.message) || ("http " + r.status) };
    }
    return { ok: true, emotion: (j && j.emotion) || "" };
  } catch (e) {
    markLlmBroken(String((e && e.message) || e));
    return { ok: false, emotion: "", reason: String(e && e.message || e) };
  }
}

/** 拉取可用模型 → 写入缓存 → 设置页里"LLM 模型"下拉立即自动出现可选模型 */
async function fetchAndRefreshModels(force = false) {
  let base = "", key = "";
  try { base = game.settings.get(MODULE, "llmBaseUrl") || ""; key = game.settings.get(MODULE, "llmKey") || ""; } catch (e) { /* noop */ }
  if (!key || !base) return false;
  if (!force) {
    try { const cached = game.settings.get(MODULE, "llmModels") || []; if (Array.isArray(cached) && cached.length) return true; } catch (e) { /* noop */ }
  }
  const j = await fetchModelsFromServer(base, key);
  if (!j.ok) { ui.notifications.warn(_L("ui.aiFetchFail", "获取模型失败") + "：" + (j.message || "unknown")); return false; }
  const models = j.models || [];
  if (!models.length) { ui.notifications.warn(_L("ui.aiNoModels", "该服务未返回可用模型")); return false; }
  try { await game.settings.set(MODULE, "llmModels", models); } catch (e) { /* noop */ }
  // 当前模型不在列表时自动选第一个
  let cur = "";
  try { cur = game.settings.get(MODULE, "llmModel") || ""; } catch (e) { /* noop */ }
  if (!cur || !models.includes(cur)) { try { await game.settings.set(MODULE, "llmModel", models[0]); } catch (e) { /* noop */ } }
  ui.notifications.info(_L("ui.aiGot", "获取到模型") + " " + models.length + " 个：" + models.slice(0, 5).join(", "));
  // 设置页正开着 → 只更新"LLM 模型"下拉的选项(不重渲染整页, 避免丢失用户未保存的输入)
  refreshSettingsModelSelect();
  return true;
}

/** 动态刷新设置页里的 LLM 模型下拉选项(预览/输入后立即可见, 无需重开设置页) */
function refreshSettingsModelSelect() {
  try {
    const w = ui.windows.find(x => x instanceof SettingsConfig);
    if (!w || !w.element || !w.element[0]) return;
    const sel = w.element[0].querySelector('select[name="gpt-sovits-tts.llmModel"]');
    if (!sel) return;
    let models = [];
    try { models = game.settings.get(MODULE, "llmModels") || []; } catch (e) { /* noop */ }
    if (!Array.isArray(models)) models = [];
    const cur = sel.value || "";
    // 1.6.67 服务商"检测到的模型"排在最前(应当使用对方提供的名称); 模块预设只作兜底排在后面
    const list = [...new Set([...models, ...LLM_PRESET_MODELS])];
    sel.innerHTML = (list.map(m => `<option value="${esc(m)}" ${m === cur ? "selected" : ""}>${esc(m)}</option>`).join("")) || `<option value="">-</option>`;
  } catch (e) { /* noop */ }
}

/** 调服务端 /llm/models 拉取模型列表 */
async function fetchModelsFromServer(base, key) {
  const cfg = getCfg();
  // 1.6.61 引擎不在时不反复重试刷屏(3次×ERR_CONNECTION_REFUSED): 单次尝试 + 15s 超时
  const r = await svcRequest(cfg.serverUrl, "POST", "/llm/models", { base, key }, { timeoutMs: 15000, retries: 0 });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) return { ok: false, message: (j && j.message) || ("http " + r.status) };
  return { ok: true, models: (j.models) || [] };
}

/** 预加载 AI: 提前跑一次 LLM 小请求, 让连接/鉴权/模型热起来, 减少后续首次调用延迟(润色/判断会更快) */
window.preloadAI = async function preloadAI() {
  const cfg = getCfg();
  if (window.__fvttTTSLlmBroken === true) return { ok: false, message: "llm-broken" };
  if (!cfg.llmEnabled || !cfg.llmKey) return { ok: false, message: "未配置 AI（先填密钥并开启）" };
  try {
    const t0 = performance.now();
    const r = await svcRequest(cfg.serverUrl, "POST", "/llm", {
        base: cfg.llmBaseUrl || "https://api.openai.com/v1",
        key: cfg.llmKey,
        model: cfg.llmModel || "gpt-4o-mini",
        text: "你好，很高兴见到你。",
        emotions: [{ key: "calm", label: "平静" }, { key: "happy", label: "开心" }],
      }, { timeoutMs: 60000 });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) { if (r.status >= 400) { markLlmBroken((j && j.message) || ("http " + r.status)); } return { ok: false, message: (j && j.message) || ("http " + r.status) }; }
    window.__aiPreloaded = true;   // 共享预热状态(语音设置面板/发送面板都不再重复预热)
    return { ok: true, ms: Math.round(performance.now() - t0), emotion: (j.emotion) || "" };
  } catch (e) {
    return { ok: false, message: (e && e.message) || "err" };
  }
};

/** 1.6.63 AI 润色安全校验: 不允许"随意改变/减少"台词 — 只接受"加语气词/标点"级别的润色。
 *  规则: ①去标点空白后长度比下限 0.95(变短=丢内容, 拒绝) 上限 1.15(短句放宽 1.4~1.6, 允许加语气词)
 *        ②原句里的数字串必须全部保留 ③长句原字符覆盖率 ≥ 90%(防改写/缩写) */
function polishIsSafe(orig, polished) {
  try {
    const o = String(orig || ""), p = String(polished || "");
    if (!p.trim()) return false;
    if (o.trim() === p.trim()) return true;
    const norm = (s) => String(s).replace(/[\s，。！？、；：""''《》〈〉()（）\[\]【】…—～~·\-.,!?;:'"]+/g, "");
    const on = norm(o), pn = norm(p);
    if (!on || !pn) return false;
    const ratio = pn.length / on.length;
    const maxR = on.length <= 4 ? 1.6 : (on.length <= 8 ? 1.4 : 1.15);
    if (ratio < 0.95 || ratio > maxR) return false;
    const nums = o.match(/\d+(?:\.\d+)?/g) || [];
    for (let i = 0; i < nums.length; i++) { if (p.indexOf(nums[i]) < 0) return false; }
    if (on.length >= 6) {
      const seen = new Set(pn);
      let hit = 0;
      for (const ch of on) { if (seen.has(ch)) hit++; }
      if (hit / on.length < 0.9) return false;
    }
    return true;
  } catch (e) { return false; }
}

/** AI 台词润色(可选, 复刻成品软件"语气更多样"): 按情绪微调台词表达, 不改变原意 */
async function polishTextByLLM(text, emotion, emotionLabel, context) {
  const cfg = getCfg();
  if (window.__fvttTTSLlmBroken === true) return { ok: false, text: "" };
  if (!cfg.llmEnabled || !cfg.llmKey || !cfg.llmPolish) return { ok: false, text: "" };
  try {
    const r = await svcRequest(cfg.serverUrl, "POST", "/llm/polish", {
        base: cfg.llmBaseUrl || "https://api.openai.com/v1",
        key: cfg.llmKey,
        model: cfg.llmModel || "gpt-4o-mini",
        text: String(text || ""),
        context: context || "",
        emotion: String(emotion || ""),
        emotion_label: String(emotionLabel || emotion || ""),
        gm_prompt: (cfg.gmPrompt || ""),   // 1.6.89 主持人提示词(润色时同样遵守世界设定)
      }, { timeoutMs: 70000, retries: 0, quiet: true });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok || !j.text) {
      if (r.status >= 400) { markLlmBroken((j && j.message) || ("http " + r.status)); }
      return { ok: false, text: "" };
    }
    const out = String(j.text).trim();
    // 1.6.63 安全校验: 润色若改动/删减过大 → 丢弃(宁可用原台词, 也不播被改过的内容)
    if (!out) return { ok: false, text: "" };
    if (!polishIsSafe(text, out)) {
      try { console.debug("[gpt-sovits-tts] AI 润色被安全校验拒绝(改动过大), 使用原台词"); } catch (e) { /* noop */ }
      return { ok: false, text: "" };
    }
    return { ok: true, text: out };
  } catch (e) {
    markLlmBroken(String((e && e.message) || e));
    return { ok: false, text: "" };
  }
}

/** 1.6.59 LLM 健康管理(模块级): 失败记原因(__fvttTTSLlmErr) + 禁用时每 60s 自动重探, 修好 base/key 后自动恢复(无需刷新) */
function markLlmBroken(err) {
  try { window.__fvttTTSLlmBroken = true; window.__fvttTTSLlmErr = String(err || "LLM 请求失败"); } catch (e) { /* noop */ }
}
function maskKey(k) {
  try {
    const s = String(k || "");
    if (!s) return "(未填)";
    return s.length <= 8 ? (s.slice(0, 3) + "…") : (s.slice(0, 4) + "…" + s.slice(-4));
  } catch (e) { return "(?)"; }
}
async function probeLLMOnce() {
  try {
    const c0 = getCfg();
    if (!c0.llmEnabled || !c0.llmKey) return { ok: false, reason: "未配置 llmEnabled/llmKey" };
    // 1.6.122 引擎不在线时压根不用探测(否则开局满屏 ERR_CONNECTION_REFUSED, 且每次重启还会重试)
    if (window.__fvttTTSEngineDown === true) return { ok: false, reason: "引擎未启动" };
    const r = await svcRequest(c0.serverUrl, "POST", "/llm", {
      base: c0.llmBaseUrl || "https://api.openai.com/v1", key: c0.llmKey, model: c0.llmModel || "gpt-4o-mini",
      text: "ping", emotions: [{ key: "calm", label: "平静" }],
    }, { timeoutMs: 20000, retries: 1, quiet: true });   // 1.6.62 探测 20s 超时+1次重试; 1.6.122 quiet: 失败只 debug 不刷红字
    const j = (r && typeof r.json === "function") ? await r.json().catch(() => ({})) : {};
    if (r && r.ok && j && j.ok && j.emotion) {
      try { window.__fvttTTSLlmBroken = false; window.__fvttTTSLlmErr = ""; } catch (e) { /* noop */ }
      return { ok: true };
    }
    markLlmBroken((j && j.message) || (r && ("http " + r.status)) || "未知错误");
    return { ok: false, reason: window.__fvttTTSLlmErr };
  } catch (e) {
    markLlmBroken(String((e && e.message) || e));
    return { ok: false, reason: window.__fvttTTSLlmErr };
  }
}
/** 1.6.67 指定模型的可用性探测: /models 列出 ≠ 真能调用(中转站常见), 用一次极短 chat 实测该模型
 *  1.6.104 传输层失败(超时/断连/"http 0", 常见于引擎正忙或外部 LLM 首字慢) → 自动重试一次(更长时间),
 *          避免把"瞬时抖动"误判成"模型不可用"(实测报告里出现过 同一模型 先 ✗ http 0 后 ✓) */
window.probeModelUsable = async function probeModelUsable(model, opts) {
  const _o = opts || {};
  const _t1 = Number(_o.timeoutMs) || 20000;
  const _retry = _o.retry !== false;
  const _one = async (timeoutMs) => {
    const cfg = getCfg();
    if (!cfg.llmBaseUrl || !cfg.llmKey) return { ok: false, reason: "未配置 base/key", fatal: true };
    try {
      const r = await svcRequest(cfg.serverUrl, "POST", "/llm", {
        base: cfg.llmBaseUrl || "https://api.openai.com/v1",
        key: cfg.llmKey,
        model: String(model || ""),
        text: "ping",
        emotions: [{ key: "calm", label: "平静" }],
      }, { timeoutMs, retries: 0 });
      const j = (r && typeof r.json === "function") ? await r.json().catch(() => ({})) : {};
      if (r && r.ok && j && j.ok) return { ok: true, emotion: String(j.emotion || "") };
      const st = (r && r.status) || 0;
      const msg = String((j && j.message) || "");
      return { ok: false, reason: msg || (st ? ("http " + st) : "请求没拿到响应(超时/网络中断)"), transport: !st && !msg };
    } catch (e) { return { ok: false, reason: String((e && e.message) || e), transport: true }; }
  };
  const a = await _one(_t1);
  if (a.ok || a.fatal) return a;
  // key/base 明确错误(401/404 等) → 不重试, 直接报
  if (!_retry || !a.transport || /401|403|invalid api key|unauthorized|model_not_found|does not exist|非 JSON/i.test(String(a.reason || ""))) return a;
  try { await new Promise(r => setTimeout(r, 1500)); } catch (e) { /* noop */ }
  const b = await _one(45000);
  if (b.ok) return { ok: true, emotion: b.emotion, retried: true };
  return { ok: false, reason: String(b.reason || a.reason || "unknown") + "（已重试一次仍失败）" };
};

function armLlmReProbe() {
  try {
    if (window.__fvttTTSLlmReProbeArmed === true) return;
    window.__fvttTTSLlmReProbeArmed = true;
    let _normTicks = 0;
    setInterval(() => {
      try {
        if (window.__fvttTTSLlmBroken === true) {
          probeLLMOnce().then(res => {
            if (res && res.ok) { try { if (ui && ui.notifications) ui.notifications.info("LLM 已恢复：AI 判语气/润色/选立绘重新启用"); } catch (e) { /* noop */ } }
          });
        } else if ((++_normTicks % 10) === 0) {
          probeLLMOnce();   // 正常中每 10 分钟探一次, 中途掉线也自动标 broken
        }
      } catch (e) { /* noop */ }
    }, 60000);
  } catch (e) { /* noop */ }
}

/** 判断+润色合并(可选开关 llmMergePolish): 一次 LLM 调用返回 {emotion, polish}.
 *  关闭时退回分开两次调用(judgeEmotionByLLM + polishTextByLLM). */
// 1.6.105 判定结果短缓存(角色+台词+提示词 相同 → 直接复用): 同一句话重发/测试重复句不再等 AI
const _assessCache = new Map();
async function judgeAndPolishByLLM(text, charName, wantPolish, context) {
  const cfg = getCfg();
  if (window.__fvttTTSLlmBroken === true) return { ok: false, emotion: "", reason: "llm-broken" };
  const _ck = String(charName || "") + "|" + String(text || "") + "|" + String((typeof getStylePrompt === "function" ? getStylePrompt(charName || "") : "") || "") + "|" + (wantPolish ? "p" : "-");
  try {
    const _hit = _assessCache.get(_ck);
    if (_hit && (Date.now() - _hit.ts) < 1800000) {   // 1.6.117 5 → 30 分钟内复用(重复台词零 token)
      try { console.debug("[gpt-sovits-tts] 复用 5 分钟内的 AI 判定结果(同角色+同台词+同提示词)"); } catch (e) { /* noop */ }
      return { ..._hit.res, cached: true };
    }
  } catch (e) { /* noop */ }
  try {
    // 1.6.105 成功结果写入短缓存(同角色+同台词+同提示词 5 分钟内直接复用)
    const _save = (r) => {
      try {
        if (r && r.ok) {
          _assessCache.set(_ck, { ts: Date.now(), res: r });
          while (_assessCache.size > 40) { const k0 = _assessCache.keys().next().value; _assessCache.delete(k0); }
        }
      } catch (e) { /* noop */ }
      return r;
    };
    // 先确保情绪槽数据(与 judgeEmotionByLLM 相同的保护)
    if (!quickChars) { try { await loadQuickChars(); } catch (e) { /* noop */ } }
    const c = (quickChars && quickChars.chars || []).find(x => x.name === charName);
    let slots = (c && c.emotions) || [];
    if (!slots.length) {
      try {
        await loadQuickChars({ force: true });
        const c2 = (quickChars && quickChars.chars || []).find(x => x.name === charName);
        slots = (c2 && c2.emotions) || [];
      } catch (e) { /* noop */ }
    }
    if (!slots.length) return { ok: false, emotion: "", reason: "no-slots" };
    const emotionsList = slots.map(s => ({ key: s.key || s.id || "", label: s.label || "" })).filter(e => e.key);
    if (!emotionsList.length) return { ok: false, emotion: "", reason: "no-slots" };
    if (cfg.llmMergePolish) {
      // 合并: 一次调用同时给情绪 + 润色稿
      try {
        const _slotAvail = ((c && c.emotions) || []).some(e => e && e.avatar);
        const _needSpriteList = !_slotAvail;   // 有情绪槽立绘就不必再发立绘表
        const r = await svcRequest(cfg.serverUrl, "POST", "/llm/assess", {
            base: cfg.llmBaseUrl || "https://api.openai.com/v1",
            key: cfg.llmKey,
            model: cfg.llmModel || "gpt-4o-mini",
            text: String(text || ""),
            context: context || "",
            emotions: emotionsList,
            role: charName || "",
            // 1.6.117 token 瘦身: 角色设定只发前 200 字(整段人设对判语气边际收益极低)
            setting: String((c && c.setting) || "").slice(0, 200),
            // 1.6.117 立绘改由"情绪槽自带的图"决定(slot.avatar), 不再让 AI 从 20+ 张里挑 → 省 200~400 token/次;
            //   仅当角色没有情绪槽立绘时才回退成"发立绘表让 AI 选"(老角色兼容)
            sprites: _needSpriteList ? buildSpriteList(c) : [],
            // 1.6.121 润色是"重要消耗", 不因模型类型而关闭; 省 token 靠减少调用次数与提示词约束
            style: (typeof getStylePrompt === "function" ? (getStylePrompt(charName || "") || "") : ""),   // 1.6.52 朗读提示词交给AI: 判语气+润色都参考它(Shinsekai式)
            gm_prompt: (cfg.gmPrompt || ""),   // 1.6.89 主持人提示词(世界设定/朗读规则, 判语气+润色+选立绘全部遵守)
            polish: !!wantPolish,
          }, { timeoutMs: 70000, retries: 0, quiet: true });
        const j = await r.json().catch(() => ({}));
        if (r.ok && j.ok && j.emotion) {
          // 1.6.63 润色安全校验: 改动/删减过大 → 只取语气, 台词保持原文播出
          let _pol = String(j.polish || "").trim();
          if (_pol && !polishIsSafe(text, _pol)) {
            try { console.debug("[gpt-sovits-tts] AI 润色被安全校验拒绝(改动过大), 使用原台词"); } catch (e) { /* noop */ }
            try { window.__fvttTTSPolishRejected = (Number(window.__fvttTTSPolishRejected || 0) + 1); } catch (e) { /* noop */ }
            _pol = "";
          }
          // 1.6.121 推理型模型(思考文字占预算)只记录次数, 不关闭润色
          try {
            if (j && j.reasoning_only === true) {
              window.__fvttTTSPolishUnsupported = false;
              window.__fvttTTSReasoningHeavy = (Number(window.__fvttTTSReasoningHeavy || 0) + 1);
              try { console.debug("[gpt-sovits-tts] 本句答案来自模型思考通道(该模型偏推理型)；润色保持开启。若长期拿不到润色, 建议换非推理模型(如 deepseek-chat / gpt-4o-mini)。"); } catch (e2) { /* noop */ }
            }
          } catch (e2) { /* noop */ }
          try {
            const _u = j && j.usage || {};
            const _in = Number(_u.prompt_tokens || _u.input_tokens || 0) || (_tokEstimate(String(text || "")) + 320);
            const _out = Number(_u.completion_tokens || _u.output_tokens || 0) || _tokEstimate(String(_pol || j.emotion || ""));
            aiTokenRecord("assess", _in, _out);
          } catch (e2) { /* noop */ }
          return _save({ ok: true, emotion: String(j.emotion), polish: _pol });
        }
        // 合并调用失败: LLM 服务不可用(>=400) → 记原因并禁用(根治每句 502 刷屏), 不再回退分开调用
        if (r.status >= 400) { markLlmBroken((j && j.message) || ("http " + r.status)); return { ok: false, emotion: "", reason: (j && j.message) || ("http " + r.status) }; }
        // 1.6.105 引擎侧 AI 失败(超时/网络/上游 5xx, 返回 200+ok:false) → **不再回退分开调用**:
        //   以前一次超时会连锁成 判语气+润色 两次额外调用(每句最多 15s×3), 这就是"生成特别慢"的主因。
        //   现在直接返回失败 → 语气走"朗读提示词/文本规则", 一句只等一次超时。
        const _why = String((j && j.message) || "assess-failed");
        try { console.debug("[gpt-sovits-tts] 合并语气判断失败, 直接降级规则判定(不再补两次调用):", _why.slice(0, 120)); } catch (e) { /* noop */ }
        return { ok: false, emotion: "", reason: _why.slice(0, 160) };
      } catch (e) {
        // 1.6.105 超时/断连不再 markLlmBroken(那是瞬时故障, 标 broken 会让后续整场都没有 AI 语气),
        //   也不再回退分开调用 → 只损失这一句的 AI 语气, 由朗读提示词/文本规则兜底
        try { console.debug("[gpt-sovits-tts] 合并语气判断超时/异常, 本句降级规则判定:", (e && e.message) || e); } catch (e2) { /* noop */ }
        return { ok: false, emotion: "", reason: String((e && e.message) || e).slice(0, 160) };
      }
    }
    // 分开: 判断 + 润色两次调用
    const j1 = await judgeEmotionByLLM(String(text || ""), charName, context || "");
    if (!j1.ok) return j1;
    let polish = "";
    if (wantPolish && cfg.llmPolish) {
      const label = j1.emotionLabel || "";
      const p = await polishTextByLLM(String(text || ""), j1.emotion, label, context || "");
      polish = p.ok ? p.text : "";
    }
    return _save({ ok: true, emotion: j1.emotion, polish });
  } catch (e) {
    return { ok: false, emotion: "", reason: "err" };
  }
}

/** 按情绪 key 找当前角色的情绪槽(含绑定音频/提示文本) */
function findEmotionSlot(emotionKey, charName) {
  const name = charName || (loadVoiceProfile().current) || "";
  const c = (quickChars && quickChars.chars || []).find(x => x.name === name);
  const slots = (c && c.emotions) || [];
  if (!emotionKey) return null;
  const _k = String(emotionKey);
  const exact = slots.find(s => s.key === _k)
    || slots.find(s => s.label === _k)
    || slots.find(s => s.label && s.label.includes(_k));
  if (exact) return exact;
  // 1.6.105 语义匹配: 朗读提示词/AI 给的是英文枚举(angry/calm/joy…), 而槽的 key 是 voice_03、label 是中文("生气，鼓起脸颊")
  //   → 以前这里匹配不到 → 不换情绪参考音、不改语调 → 用户看到"语气和朗读提示词无关"。现在按情绪语义兜底匹配。
  try {
    const want = normalizeEmotionKey(_k);
    if (want) {
      const hit = slots.find(s => {
        try { return normalizeEmotionKey(String((s && s.label) || (s && s.key) || "")) === want; } catch (e) { return false; }
      });
      if (hit) return hit;
    }
  } catch (e) { /* noop */ }
  return null;
}

function renderSendPopEmotions() {
  if (!window.__fvttTTSSendPopEl || !document.body.contains(window.__fvttTTSSendPopEl)) return;
  const prof = loadVoiceProfile();
  const charName = prof.current || "";
  const c = sendPopCurrentChars().find(x => x.name === charName);
  const slots = (c && c.emotions) || [];
  const grid = window.__fvttTTSSendPopEl.querySelector(".fvtt-tts-sendpop-emogrid");
  if (!grid) return;
  const curEmo = prof.emotion || "";
  grid.innerHTML = `<button type="button" class="fvtt-tts-sendpop-emo ${curEmo ? "" : "on"}" data-key="">${_L("ui.emotionNone", "默认")}</button>`
    + slots.map(s => `<button type="button" class="fvtt-tts-sendpop-emo ${s.key === curEmo ? "on" : ""} ${s.bound ? "" : "off"}" data-key="${esc(s.key)}" title="${s.bound ? esc(s.label) : esc(s.label) + "（未绑定参考音）"}">${esc(s.label)}</button>`).join("");
  // 恢复情绪占比/参数调制滑块值
  const prof2 = loadVoiceProfile();
  const cur2 = (prof2.chars && prof2.chars[prof2.current]) || {};
  const mix = window.__fvttTTSSendPopEl.querySelector(".fvtt-tts-sendpop-mix");
  const mod = window.__fvttTTSSendPopEl.querySelector(".fvtt-tts-sendpop-mod");
  // 1.6.111 这两项也是 0 = 自动(AI 决定), 未设置就显示"自动"而不是 50%
  if (mix) {
    mix.value = String(Math.round(((typeof cur2.emotionMix === "number" && cur2.emotionMix > 0) ? cur2.emotionMix : 0) * 100));
    const _mk = window.__fvttTTSSendPopEl.querySelector(".fvtt-tts-sendpop-mixval");
    if (_mk) _mk.textContent = Number(mix.value) > 0 ? mix.value + "%" : "自动";
  }
  if (mod) {
    mod.value = String(Math.round(((typeof cur2.emotionMod === "number" && cur2.emotionMod > 0) ? cur2.emotionMod : 0) * 100));
    const _md = window.__fvttTTSSendPopEl.querySelector(".fvtt-tts-sendpop-modval");
    if (_md) _md.textContent = Number(mod.value) > 0 ? mod.value + "%" : "自动";
  }
}

function openSendPop() {
  const pop = buildSendPop();
  pop.style.display = "block";
  // 定位: 优先发送按钮附近; 无则屏幕右上
  const btn = document.querySelector(".fvtt-tts-bar .fvtt-tts-send");
  if (btn) {
    const r = btn.getBoundingClientRect();
    const pw = pop.offsetWidth || 260, ph = pop.offsetHeight || 340;
    let x = Math.min(r.left, window.innerWidth - pw - 8);
    let y = Math.min(r.bottom + 6, window.innerHeight - ph - 8);
    pop.style.left = `${Math.max(8, x)}px`;
    pop.style.top = `${Math.max(8, y)}px`;
  } else {
    pop.style.left = "auto";
    pop.style.right = "16px";
    pop.style.top = "64px";
  }
  // 填充数据
  renderSendPopEmotions();
  // 打开面板总是拉最新角色/情绪(服务端可能已更新槽/标签), 拉完重绘语气网格
  loadQuickChars({ force: true }).then(() => { try { renderSendPopEmotions(); } catch (e) { /* noop */ } }).catch(() => { /* noop */ });
  refreshPreloadBtn();   // 1.6.102 每次打开面板都按当前输入重算"已预加载/空闲"(修发送后一直显示已加载)
  // 1.6.106 每次打开面板刷新「朗读提示词 / 强度」: 面板只构建一次, 以前切了角色后这两项显示的是旧角色的值
  try {
    const _si = pop.querySelector(".fvtt-tts-sendpop-style");
    const _ss = pop.querySelector(".fvtt-tts-sendpop-stylestr");
    const _sv = pop.querySelector(".fvtt-tts-sendpop-stylestrval");
    const _cn2 = (loadVoiceProfile().current) || "";
    if (_si) _si.value = (typeof getStylePrompt === "function" ? (getStylePrompt(_cn2) || "") : "");
    if (_ss) { const v = styleStrengthOf(_cn2); _ss.value = String(v); if (_sv) _sv.textContent = v + "%"; }
  } catch (e) { /* noop */ }
  const ta = findChatTextarea();
  const fire = pop.querySelector(".fvtt-tts-sendpop-fire");
  if (fire) fire.disabled = !(ta && String(ta.value || "").trim());
  // 1.6.31: 聊天输入文本变化 → 预加载按钮 done 态即时清除(文字与已预合成音频不一致时不再一直显示"已预加载")
  if (ta && ta.dataset.fvttPreloadWatch !== "1") {
    ta.dataset.fvttPreloadWatch = "1";
    ta.addEventListener("input", () => {
      refreshPreloadBtn();   // 1.6.102 统一复核(打字 → 文字变化 → 按钮回到"AI 预加载")
    });
  }
}

function closeSendPop() {
  if (window.__fvttTTSSendPopEl && document.body.contains(window.__fvttTTSSendPopEl)) { window.__fvttTTSSendPopEl.style.display = "none"; }
}

/* 快捷角色/情绪切换: 数据与渲染 */
let quickChars = null;   // /characters 缓存
let _charsSnapCheckT = 0;   // 快照 ts 对比节流(30s 一次)
const QC_STORE_KEY = "fvtt-tts-quickchars-v2";   // v2: 角色缓存带 avatar 立绘字段(旧 v1 缓存自动弃用重拉)

function readQuickCharsCache() {
  // 服务暂不可用时的角色兜底缓存(上次成功结果), 避免"无角色"
  try {
    const s = localStorage.getItem(QC_STORE_KEY);
    if (s) { const j = JSON.parse(s); return (j && Array.isArray(j.chars) && j.chars.length) ? j : null; }
  } catch (e) { /* noop */ }
  return null;
}
let _qcRetry = null;
function _scheduleQCRetry() {
  // fetch 失败后 4 秒自动重试, 服务恢复后角色自动回来
  if (_qcRetry) return;
  _qcRetry = setTimeout(() => {
    _qcRetry = null;
    loadQuickChars({ force: true }).then(() => {
      renderQuickUI();
      try { renderSendPopEmotions(); } catch (e) { /* noop */ }
    });
  }, 4000);
}

async function loadQuickChars({ force = false } = {}) {
  if (!force && quickChars && Array.isArray(quickChars.chars) && quickChars.chars.length) {
    // 代理端: 每 30s 对比一次快照 ts — GM 导入新角色/改角色后自动同步(无需刷新页面)
    try {
      if (window.__fvttTTSCanDirect === false && (!_charsSnapCheckT || (Date.now() - _charsSnapCheckT) > 30000)) {
        _charsSnapCheckT = Date.now();
        const rr = await fetch(`${window.location.origin}/modules/gpt-sovits-tts/engine/audio_export/chars_meta.json`, { signal: AbortSignal.timeout(6000) });
        if (rr.ok) {
          const jj = await rr.json().catch(() => null);
          const curTs = (quickChars && quickChars._snapTs) || 0;
          if (jj && jj.ts && jj.ts !== curTs && Array.isArray(jj.chars)) {
            quickChars = { ok: true, chars: jj.chars, active: "", _src: "snapshot", _snapTs: jj.ts };
            try { refreshQuickUI(); } catch (e) { /* noop */ }
          }
        }
      }
    } catch (e) { /* noop */ }
    return quickChars;
  }
  const snapUrl = `${window.location.origin}/modules/gpt-sovits-tts/engine/audio_export/chars_meta.json`;
  tryDirect: try { } catch (e) { }   // (占位避免误解析; 下面两个函数定义)
  const tryDirect = async () => {
    try {
      const r = await svcRequest(getCfg().serverUrl, "GET", "/characters", null, { retries: 0, timeoutMs: 6000, quiet: true });   // 1.6.122 开局探测不重试(失败有快照/缓存兜底)
      const rj = r.jsonSafe ? r.jsonSafe() : (r.json || {});
      if (r.ok && Array.isArray(rj.chars) && rj.chars.length) {
        quickChars = rj;
        try { localStorage.setItem(QC_STORE_KEY, JSON.stringify(rj)); } catch (e) { /* noop */ }
        return true;
      }
    } catch (e) { /* noop */ }
    return false;
  };
  const trySnap = async () => {
    // 30000 静态快照(不写本地缓存, 避免污染直连端的完整角色数据)
    try {
      const r = await fetch(snapUrl, { signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const j = await r.json();
        if (j && Array.isArray(j.chars) && j.chars.length) {
          quickChars = { ok: true, chars: j.chars, active: "", _src: "snapshot", _snapTs: j.ts || 0 };
          return true;
        }
      }
    } catch (e) { /* noop */ }
    return false;
  };
  // 通用数据源顺序: 直连端(9881 可达/本机/局域网) 9881 优先拿完整数据; 代理端(HTTPS 穿透/跨网/9881 不可达/低配服务器) FVTT 30000 快照优先 — 任何环境都能拿到角色
  const canD = window.__fvttTTSCanDirect !== false;
  let okD = canD ? await tryDirect() : false;
  let okS = okD ? true : await trySnap();
  if (!okD && !okS && canD) okS = await trySnap();
  if (!okD && !okS && !canD) okD = await tryDirect();
  if (!(quickChars && Array.isArray(quickChars.chars) && quickChars.chars.length)) {
    quickChars = readQuickCharsCache();
    _scheduleQCRetry();
  }
  try { window.__fvttTTSQuickChars = quickChars; } catch (e) { /* noop */ }   // 供测试套件(角色/情绪槽上下文)
  return quickChars;
}

function renderQuickUI() {
  const bar = document.getElementById("fvtt-tts-floatbar") || document.querySelector(".fvtt-tts-bar");
  if (!bar) return;
  const charSel = bar.querySelector(".fvtt-tts-char");
  const emoSel = bar.querySelector(".fvtt-tts-emotion");
  if (!charSel || !emoSel) return;
  const chars = (quickChars && quickChars.chars) || [];
  const activeName = (quickChars && quickChars.active) || "";
  const prof = loadVoiceProfile();
  const curName = prof.current || activeName || (chars[0] && chars[0].name) || "";
  // 角色下拉
  const curOpt = charSel.value;
  charSel.innerHTML = chars.map(c => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join("") || `<option value="">${_L("ui.noChar", "无角色")}</option>`;
  if (chars.some(c => c.name === curOpt)) charSel.value = curOpt;
  else if (chars.some(c => c.name === curName)) charSel.value = curName;
  // 情绪下拉(当前选中角色)
  const actChar = chars.find(c => c.name === charSel.value) || chars.find(c => c.name === activeName) || null;
  const slots = (actChar && actChar.emotions) || [];
  const curEmo = prof.emotion || "";
  emoSel.innerHTML = `<option value="">${_L("ui.emotionNone", "默认")}</option>` + slots.map(s => `<option value="${esc(s.key)}">${esc(s.label)}${s.bound ? "✓" : ""}</option>`).join("");
  if (slots.some(s => s.key === curEmo)) emoSel.value = curEmo;
  else emoSel.value = "";   // 新角色无此语气 → 回默认, 不残留旧选择
}

async function refreshQuickUI() {
  await loadQuickChars();
  renderQuickUI();
}

function updateStatusUI() {
  // 1.6.143 修复: 悬浮条重构后状态灯元素丢失(旧选择器 .fvtt-tts-bar 已不存在) → 状态灯从未显示, showStatus 设置无效
  const st = document.querySelector("#fvtt-tts-floatbar .fvtt-tts-status") || document.querySelector(".fvtt-tts-bar .fvtt-tts-status");
  if (!st) return;
  const cfg = getCfg();
  // showStatus=关 → 隐藏状态灯(只隐藏小灯, 不隐藏工具条)
  try { st.style.display = cfg.showStatus === false ? "none" : ""; } catch (e) { /* noop */ }
  st.classList.toggle("ok", cfg.engine === "gptsovits" && statusInfo.ok === true);
  st.classList.toggle("fail", cfg.engine === "gptsovits" && statusInfo.ok === false);
  st.classList.toggle("unknown", cfg.engine !== "gptsovits" || statusInfo.ok === null);
  st.title = statusTitle();
  st.innerHTML = cfg.engine === "gptsovits" ? '<i class="fa-solid fa-volume-high"></i>' : '<i class="fa-solid fa-language"></i>';
}

/** 1.6.148 开发者测试按钮显隐: devTools=关(默认) → 悬浮条的 🔬全面测试 / 🧪GM综合测试 隐藏。
 *  目的: 玩家不会误点 28 场景压力自测(会长时间压引擎); 作者需要时到设置打开, 控制台入口始终可用。 */
function applyDevButtons() {
  try {
    const on = getCfg().devTools === true;
    const bar = document.getElementById("fvtt-tts-floatbar");
    if (!bar) return;
    const st = bar.querySelector(".fvtt-tts-selftest");
    if (st) st.style.display = on ? "" : "none";
    const gm = bar.querySelector(".fvtt-tts-gmtest");
    if (gm) gm.style.display = (on && game.user && game.user.isGM) ? "" : "none";
  } catch (e) { /* noop */ }
}

function updateMicUI() {  const mic = document.querySelector("#fvtt-tts-floatbar .fvtt-tts-mic");
  if (!mic) return;
  const active = !!(window.__fvttTTSDictation && window.__fvttTTSDictation.active);
  mic.classList.toggle("active", active);
  mic.title = active ? _L("ui.micStop", "正在听写…点击停止") : _L("ui.mic", "语音听写(点击开始/停止)");
  mic.innerHTML = active ? '<i class="fa-solid fa-microphone-lines"></i>' : '<i class="fa-solid fa-microphone"></i>';
  updateCharIndicator();   // 角色指示物(悬浮条/输入框立绘)随角色/设置刷新
}

/* ============ 打字即读 ============ */
/** 1.6.134 预加载完成提示(节流): 同一句 60s 内只提示一次; 发送面板没开时也能立刻知道"已就绪" */
let lastPreloadNotified = { text: "", ts: 0 };
function notifyPreloadDone(text) {
  try {
    const now = Date.now();
    if (text && text === lastPreloadNotified.text && now - lastPreloadNotified.ts < 60000) return;
    lastPreloadNotified = { text: text || "", ts: now };
    ui.notifications.info(_L("ui.preloadDoneToast", "✓ 已预加载，发送即零等待"));
  } catch (e) { /* noop */ }
}

/** 1.6.134 把"预读/预合成"得到的音频收进 preloadAudio(自动预加载核心, 与手动按钮共用) */
async function adoptPreload(pv, rawText) {
  try {
    if (!pv) return false;
    const _src = stripStageDirections(String(rawText || ""));
    let _url = pv.url || "";
    let _dataUrl = pv.dataUri || "";
    if (pv.blob) {
      try { const o = URL.createObjectURL(pv.blob); if (o) _url = o; } catch (e) { /* noop */ }
      if (!_dataUrl) { try { _dataUrl = "data:audio/mpeg;base64," + (await blobToBase64(pv.blob)); } catch (e) { /* noop */ } }
    }
    if (!_url && _dataUrl) _url = _dataUrl;
    if (!_url) return false;
    // 1.6.134 兜底: 只有 blob:objectURL 而没有 dataUrl 时, 拉一次转成 dataUrl —
    //   预加载命中后 flags 写回靠 audioUrl/dataUrl 让其他端听到(纯 objectURL 只在作者本机有效)
    if (!_dataUrl && /^blob:/.test(_url)) {
      try {
        const _fb = await fetch(_url);
        if (_fb && _fb.ok) { const _bb = await _fb.blob(); if (_bb && _bb.size > 0) _dataUrl = "data:audio/mpeg;base64," + (await blobToBase64(_bb)); }
      } catch (e) { /* noop */ }
    }
    if (window.__fvttTTSPreloadAudio && window.__fvttTTSPreloadAudio.url) { try { URL.revokeObjectURL(window.__fvttTTSPreloadAudio.url); } catch (e) { /* noop */ } }
    window.__fvttTTSPreloadAudio = { text: pv.text || _src, srcText: _src, lang: pv.lang || "auto", url: _url, audioUrl: pv.audioUrl || "", dataUrl: _dataUrl, mime: "audio/mpeg", ts: Date.now(), watchKey: makeWatchKey() };
    return true;
  } catch (e) { return false; }
}

/** 1.6.134 预加载合成核心(手动按钮 / 自动预加载共用):
 *  与发送完全同款: 手动语气槽 > AI 判语气(+安全校验后的润色稿) > 规则; 产出存进 preloadAudio */
async function synthPreloadCore(stripT) {
  try {
    if (!stripT) return { ok: false, message: "empty" };
    const cfgP2 = getCfg();
    if (cfgP2.engine !== "gptsovits") return { ok: false, message: "engine" };
    let stripP = stripT;
    const profP = loadVoiceProfile();
    const roleP = profP.current || "";
    const emoP = profP.emotion || "";
    const overridesP = {};
    let aiEmoP = "";
    if (emoP) {
      const slotP = findEmotionSlot(emoP, roleP);
      if (slotP) {
        if (slotP.ref_audio_path) overridesP.auxRefAudioPaths = [`fvtt_chars/${roleP}/${slotP.ref_audio_path}`];
        if (slotP.prompt_text) overridesP.promptText = slotP.prompt_text;
        if (slotP.prompt_lang) overridesP.promptLang = slotP.prompt_lang;
      }
    } else if (cfgP2.llmEnabled && cfgP2.llmKey && window.__fvttTTSLlmBroken !== true) {
      try {
        const resP = await judgeAndPolishByLLM(stripP, roleP, !!cfgP2.llmPolish, "");
        if (resP.ok && resP.emotion) {
          // 1.6.134 与发送同款安全校验: 润色改动过大被拒 → 预加载也播原文(否则"预加载原文 vs 发送润色稿"匹配不上)
          if (resP.polish && cfgP2.llmPolish) {
            try { if (polishIsSafe(stripP, resP.polish)) stripP = resP.polish; } catch (e) { /* noop */ }
          }
          const slotP = findEmotionSlot(resP.emotion, roleP);
          if (slotP) {
            if (slotP.ref_audio_path) overridesP.auxRefAudioPaths = [`fvtt_chars/${roleP}/${slotP.ref_audio_path}`];
            if (slotP.prompt_text) overridesP.promptText = slotP.prompt_text;
            if (slotP.prompt_lang) overridesP.promptLang = slotP.prompt_lang;
            aiEmoP = resP.emotion;
          }
        }
      } catch (e) { /* AI 失败沿用手动/默认 */ }
    }
    const curP = (profP.chars && profP.chars[roleP]) || {};
    if (typeof curP.emotionMix === "number") overridesP.emotionMix = curP.emotionMix;
    else if (aiEmoP && !(typeof overridesP.emotionMix === "number" && overridesP.emotionMix > 0)) overridesP.emotionMix = 0.5;   // 1.6.116 预加载同样: 基础音+情绪叠加
    try { normalizeEmotionMix(overridesP); } catch (e) { /* noop */ }
    // 1.6.99 AI 直出/预加载: 强度=0 时用提示词关键词语速(AI/提示词自己决定), 不再锁原速
    let _spdP = Number(cfgP2.speedFactor) || 1;
    try {
      const _stP2 = styleStrengthOf(roleP) / 100;
      if (_stP2 <= 0) {
        const _kw2 = styleKeywordParams(getStylePrompt(roleP) || "", stripP.length);
        if (_kw2.speed) _spdP = _kw2.speed;
      }
    } catch (e) { /* noop */ }
    // 1.6.152 预加载与发送必须同参数(否则"预加载→发送"会因采样参数不同而听感不一致)
    try {
      const _ssP = Number(cfgP2.sampleSteps);
      if (Number.isFinite(_ssP) && _ssP !== 32) overridesP.sampleSteps = Math.max(4, Math.min(48, Math.round(_ssP)));
      if (cfgP2.superSampling === true) overridesP.superSampling = true;
    } catch (e) { /* noop */ }
    const { blob, audioUrl } = await gptSovitsSynth(stripP, cfgP2.textLang || "auto", { serverUrl: cfgP2.serverUrl, speedFactor: _spdP, overrides: Object.keys(overridesP).length ? overridesP : null, mediaType: "mp3", asBlob: true, role: roleP, skipDirect: window.__fvttTTSCanDirect !== true });
    if (!blob) return { ok: false, message: "no-blob" };
    const objUrl = URL.createObjectURL(blob);
    const b64 = await blobToBase64(blob);
    if (window.__fvttTTSPreloadAudio && window.__fvttTTSPreloadAudio.url) { try { URL.revokeObjectURL(window.__fvttTTSPreloadAudio.url); } catch (e) { /* noop */ } }
    window.__fvttTTSPreloadAudio = { text: stripP, srcText: stripT, lang: cfgP2.textLang || "auto", url: objUrl, audioUrl: audioUrl || "", dataUrl: `data:audio/mpeg;base64,${b64}`, mime: "audio/mpeg", ts: Date.now(), watchKey: makeWatchKey() };
    return { ok: true };
  } catch (e) { return { ok: false, message: String((e && e.message) || e) }; }
}

/** 1.6.134 纯发送模式: 打字停顿后静默预合成当前句子(不播放), 发送时直接播同一段(零等待) */
async function silentPreload(rawText) {
  try {
    const stripT = stripStageDirections(String(rawText || ""));
    if (!stripT) return { ok: false };
    const r = await synthPreloadCore(stripT);
    if (r && r.ok && window.__fvttTTSPreloadAudio && window.__fvttTTSPreloadAudio.url) {
      // 合成期间用户改了文字/已发送 → 预加载作废(不存过期的)
      try {
        const el = document.getElementById("chat-message") || findChatTextarea();
        const now = (el && el.value) ? stripStageDirections(el.value) : "";
        if (now && now !== stripT) return { ok: false, stale: true };
      } catch (e) { /* noop */ }
      return { ok: true };
    }
    return r || { ok: false };
  } catch (e) { return { ok: false }; }
}

function attachTyping() {
  const cfg = getCfg();
  // 1.6.139 用户要求: 只有"本模块指定方式"才朗读 —— 打字停顿预读独立开关 typingRead(默认关),
  //   不再由 triggerMode 决定(triggerMode 只保留 send/manual 对"他人消息自动朗读"的语义)。
  const _typingOn0 = (cfg.typingRead === true);
  const _autoOn0 = (cfg.autoPreload !== false && cfg.engine === "gptsovits");   // 静默预合成(不发声)仍可用
  if (!_typingOn0 && !_autoOn0 && !cfg.commands) return;
  // 1.6.129: 输入框兜底用 findChatTextarea()(v13 分离窗口/不同版本 DOM 结构差异), 不再只认 #chat-message
  const ta = document.getElementById("chat-message") || findChatTextarea();
  if (!ta || ta.dataset.fvttTtsAttached) return;
  ta.dataset.fvttTtsAttached = "1";
  ta.addEventListener("input", () => {
    const c = getCfg();
    const _typingOn = (c.typingRead === true);
    // 1.6.134 自动预加载: 即使不开"打字即读", 停顿时也静默预合成 → 发送零等待(只合成不发声)
    const _autoOn = (c.autoPreload !== false && c.engine === "gptsovits");
    if (!_typingOn && !_autoOn) return;
    clearTimeout(window.__fvttTTSTypingTimer);
    window.__fvttTTSTypingTimer = setTimeout(async () => {
      const el = document.getElementById("chat-message") || findChatTextarea();
      if (!el) return;
      const text = el.value.replace(/\s+/g, " ").trim();
      if (!text || text.startsWith("/")) return;
      if (text.length < c.minLength) return;
      if (_typingOn) {
        if (text === lastTypedSpoken.text && Date.now() - lastTypedSpoken.ts < 30000) return;
        lastTypedSpoken.text = text; lastTypedSpoken.ts = Date.now();
        speak(text, { isTypingPreview: true }).then(async (ok) => {
          // 预读失败(合成异常) → 撤销记录, 发送时该句仍会正常播放(不能因为"预读过"就吞掉发送的语音)
          if (ok === false) { lastTypedSpoken.text = ""; lastTypedSpoken.ts = 0; return; }
          try {
            // 1.6.134 顺手把预读播放的这段音频存成预加载 → 发送零等待(零额外合成/LLM)
            const pv = window.__fvttTTSLastTypingPreview;
            if (pv && (pv.blob || pv.dataUri || pv.audioUrl)) {
              const hadOk = await adoptPreload(pv, text);
              try { refreshPreloadBtn(); } catch (e) { /* noop */ }
              if (hadOk) notifyPreloadDone(text);   // 1.6.134 完成立即告知(按钮没开面板也看得到)
            }
          } catch (e) { /* noop */ }
        }).catch(() => { lastTypedSpoken.text = ""; lastTypedSpoken.ts = 0; });
      } else if (_autoOn) {
        // 纯发送模式: 停顿时静默预合成(不播放) → 发送直接播同一段, 零等待
        const stripT = stripStageDirections(text);
        if (!preloadHit(stripT)) {
          const r = await silentPreload(text);
          try { if (r && r.ok) { refreshPreloadBtn(); notifyPreloadDone(stripT); } } catch (e) { /* noop */ }
        }
      }
    }, c.typingDebounce);
  });
  ta.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) cancelTypingDebounce();
  });
}

function cancelTypingDebounce() {
  clearTimeout(window.__fvttTTSTypingTimer);
  window.__fvttTTSTypingTimer = null;
}

/* ============ 听写 ============ */
function mapSttLang(lang) {
  const m = { auto: "auto", zh: "zh-CN", ja: "ja-JP", en: "en-US" };
  return m[lang] || "auto";
}

function toggleDictation() {
  const cfg = getCfg();
  if (!cfg.sttEnabled) { notifyOnce(_L("errors.sttDisabled", "听写功能未启用"), "info"); return; }
  if (window.__fvttTTSDictation && window.__fvttTTSDictation.active) { window.__fvttTTSDictation.stop(); window.__fvttTTSDictation = null; updateMicUI(); return; }
  refreshTtsDevices();  // 刷新设备缓存(拿到设备名, 供配置设定下拉显示)
  if (window.__fvttTTSDictation && window.__fvttTTSDictation.active) { window.__fvttTTSDictation.stop(); window.__fvttTTSDictation = null; updateMicUI(); return; }
  const engine = cfg.sttEngine;
  const lang = cfg.sttLang === "auto" ? detectLang(document.getElementById("chat-message")?.value || "") : cfg.sttLang;
  const devId = cfg.sttDevice || "";
  const onResult = (text) => handleDictated(text);
  const onError = (err) => {
    console.warn("[gpt-sovits-tts] 听写错误:", err);
    const e = String(err || "").toLowerCase();
    if (e.includes("no-speech") || e.includes("no_speech")) {
      notifyOnce(_L("errors.sttNoSpeech", "浏览器没识别到声音：请检查 ①听写语言是否和说话语言一致 ②系统默认麦克风是不是你要用的 ③靠近麦克风说话；建议改用“服务端听写”（更稳定，且支持选麦克风）"), "info");
    } else if (e.includes("not-allowed") || e.includes("permission")) {
      notifyOnce(_L("errors.sttDenied", "麦克风权限被拒绝：请在浏览器地址栏允许麦克风后重试"), "info");
    } else {
      notifyOnce(_L("errors.stt", `听写出错: ${err}`));
    }
    updateMicUI();
  };
  const onState = () => updateMicUI();

  if (engine === "browser") {
    if (!BrowserSTT.supported()) {
      notifyOnce(_L("errors.sttBrowser", "当前浏览器不支持语音识别(请用 Chrome/Edge)，可在设置中改用“服务端听写”"));
      return;
    }
    if (devId) notifyOnce(_L("errors.sttBrowserDevice", "浏览器听写使用系统默认麦克风；要指定麦克风请把听写引擎改为“服务端”"), "info");
    window.__fvttTTSDictation = BrowserSTT.start({ lang: mapSttLang(lang), onResult, onError, onState });
  } else {
    if (!ServerSTT.supported()) { notifyOnce(_L("errors.sttServer", "当前浏览器无法使用麦克风录音")); return; }
    window.__fvttTTSDictation = ServerSTT.start({ serverUrl: cfg.serverUrl, lang, deviceId: devId, onResult, onError, onState });
  }
  updateMicUI();
}

async function handleDictated(text) {
  if (!text) return;
  const cfg = getCfg();
  window.__fvttTTSDictation = null;
  updateMicUI();
  if (!cfg.sttAutoSend) {
    const ta = document.getElementById("chat-message");
    if (ta) {
      ta.value = ta.value ? `${ta.value} ${text}` : text;
      ta.focus();
      ta.dispatchEvent(new Event("input"));
    }
    return;
  }
  // 直接发送为聊天消息; sttAutoSpeak 决定是否朗读(通过 flags.speak 交给消息hook处理)
  try {
    const hasStyles = !!CONST.CHAT_MESSAGE_STYLES;
    const data = {
      content: text,
      speaker: ChatMessage.getSpeaker(),
      flags: { [MODULE]: { speak: !!cfg.sttAutoSpeak } }
    };
    if (hasStyles) data.style = CONST.CHAT_MESSAGE_STYLES.IC;
    else data.type = CONST.CHAT_MESSAGE_TYPES.IC;
    await ChatMessage.create(data);
  } catch (err) {
    console.error("[gpt-sovits-tts] 听写消息发送失败:", err);
    notifyOnce(_L("errors.sttSend", "听写消息发送失败"));
  }
}

/* ============ 命令 ============ */
function handleCommand(chatLog, message, chatData) {
  const cfg = getCfg();
  if (!cfg.commands) return undefined;
  const m = String(message || "").trim();
  const match = m.match(/^\/(ttssay|ttsstop|ttstest|ttsrec|ttshelp)(?:\s+([\s\S]*))?$/i);
  if (!match) return undefined;
  // 1.6.138 双实例防护: 同一命令事件会被两份实例的 chatMessage hook 各收一次 → 只让第一份执行(3s 窗口)
  if (window.__fvttTTSCmdLast === m) { return false; }
  window.__fvttTTSCmdLast = m;
  setTimeout(() => { try { if (window.__fvttTTSCmdLast === m) window.__fvttTTSCmdLast = ""; } catch (e) { /* noop */ } }, 3000);
  const [, cmd, rest] = match;
  switch (cmd.toLowerCase()) {
    case "ttssay":
      if (rest && rest.trim()) speak(rest.trim());
      break;
    case "ttsstop":
      stopSpeaking();
      break;
    case "ttstest":
      speak(_L("ui.testPhrase", "你好，我是七海千秋。测试成功！"));
      break;
    case "ttsrec":
      toggleDictation();
      break;
    case "ttshelp":
      ui.notifications.info(_L("cmd.help", "/ttssay 文本 - 朗读文本\n/ttsstop - 停止朗读\n/ttstest - 试听\n/ttsrec - 开/关听写"));
      break;
    default:
      break;
  }
  return false; // 不把命令本身发进聊天
}

/* ============ 重听按钮 ============ */
function addReplayButton(message, html) {
  const cfg = getCfg();
  if (!cfg.showReplay) return;
  const li = (html && html[0]) ? html[0] : html;
  if (!li || !li.querySelector || !li.querySelectorAll) return;
  if (li.querySelector(".fvtt-tts-replay")) return;
  const text = extractText(message);
  if (!text || text.length < cfg.minLength) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "fvtt-tts-replay";
  btn.title = _L("ui.replay", "朗读本条消息");
  btn.innerHTML = '<i class="fa-solid fa-volume-high"></i>';
  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    // 优先播放第一次的同一段音频(缓存), 无缓存才重新合成
    const cached = audioCache.get(message.id || "");
    if (cached && cached.url) {
      queue.enqueue({ play: () => audioPlay(cached.url, { volume: playVolume(), push: false }) });
      return;
    }
    // 缓存 miss(被挤出/跨会话): 用消息 flags 里的原音色上下文重新合成,
    // 并跳过 LLM 重新判断语气 → 声音与第一次朗读一致(而不是当前角色/新语气)
    const fl = (message.flags && message.flags[MODULE]) || {};
    const rp = {
      lang: fl.lang || cfg.textLang,
      sender: (message.speaker && message.speaker.alias) || "",
      skipAiEmotion: true,
    };
    if (fl.ref || fl.promptText || fl.promptLang || fl.auxRef) {
      if (fl.ref) rp.refAudioPath = fl.ref;
      if (fl.promptText) rp.promptText = fl.promptText;
      if (fl.promptLang) rp.promptLang = fl.promptLang;
      if (fl.auxRef) rp.auxRefAudioPaths = [fl.auxRef];
      if (typeof fl.emotionMix === "number") rp.emotionMix = fl.emotionMix;
      if (fl.speed) rp.speed = fl.speed;
    }
    speak(text, rp);
  });
  const meta = li.querySelector(".message-metadata");
  if (meta) meta.appendChild(btn);
  else {
    const header = li.querySelector(".message-header");
    if (header) header.appendChild(btn);
    else li.appendChild(btn);
  }
}

/* ============ 内置自检: 一键跑全部测试 → 报告写入服务端 selftest_report.json(作者直接读文件排查) ============ */
window.__fvttTTSPatch = "official-v2";   // 版本指纹: 自检报告显示它, 判断页面是否加载了最新 JS
async function runSelfTest() {
  const out = { at: new Date().toISOString(), env: {}, settings: {}, hud: {}, portrait: {}, net: {}, voice: {}, audio: {} };
  try {
    out.env = {
      ua: (navigator.userAgent || "").slice(0, 200),
      foundry: String((typeof game !== "undefined" && (game.version || (game.data && game.data.version))) || ""),
      system: (typeof game !== "undefined" && game.system && game.system.id) || "",
      user: (typeof game !== "undefined" && game.user && game.user.name) || "",
      isGM: !!(typeof game !== "undefined" && game.user && game.user.isGM),
      href: String((location && location.href) || "").slice(0, 80),
      patch: String(window.__fvttTTSPatch || ""),
      canDirect: (() => { try { return window.__fvttTTSCanDirect === true ? "direct" : (window.__fvttTTSCanDirect === false ? "proxy(gm)" : "probe-pending"); } catch (e) { return "err"; } })(),
      moduleVersion: (() => { try { return (game.modules.get(MODULE) || {}).version || ""; } catch (e) { return ""; } })(),
      socketConnected: !!(typeof game !== "undefined" && game.socket && game.socket.connected),
      sockRecv: (() => { try { return window.__fvttTTSSockRecv || 0; } catch (e) { return -1; } })(),   // 本页已收到的模块广播数(pl 端 >0 = 广播确实到达)
      sockLastType: (() => { try { return String(window.__fvttTTSSockLast && window.__fvttTTSSockLast.type); } catch (e) { return ""; } })(),
    };
  } catch (e) { out.env.err = String(e); }
  try {
    const cfg = getCfg();
    out.settings = {
      hudTheme: cfg.hudTheme || "",
      portraitMode: cfg.portraitMode || "",
      voiceRunner: cfg.voiceRunner || "",
      serverUrl: cfg.serverUrl || "",
      enabled: !!cfg.enabled,
      aiPickAvatar: !!cfg.aiPickAvatar,
      llmEnabled: !!cfg.llmEnabled,
      llmKey: !!(cfg.llmKey || game.settings.get(MODULE, "llmKey")),
      llmModel: String(game.settings.get(MODULE, "llmModel") || "").slice(0, 40),
      llmBaseUrl: String(game.settings.get(MODULE, "llmBaseUrl") || "").slice(0, 60),
      showReplay: !!cfg.showReplay,
      minLength: cfg.minLength || 0,
      translate: !!cfg.translate,
      emotionSpeed: !!cfg.emotionSpeed,
      sttEngine: cfg.sttEngine || "",
      voiceAssignments: (() => { try { const a = game.settings.get(MODULE, "voiceAssignments"); if (a && typeof a === "object" && !Array.isArray(a)) { const s = JSON.stringify(a); if (!s || s === "[object Object]" || s.startsWith('"[object Object]"')) return "bad-object"; return s.slice(0, 200); } if (!a || a === "" || String(a) === "[object Object]") return "empty"; return "bad-type:" + String(a).slice(0, 40); } catch (e) { return "err"; } })(),
    };
  } catch (e) { out.settings.err = String(e); }
  try {
    const fb = document.querySelector("#fvtt-tts-floatbar");
    const bgOf = (el) => { if (!el) return "no-floatbar"; try { return (typeof $ === "function" && $(el).css) ? $(el).css("background-color") : getComputedStyle(el).backgroundColor; } catch (e) { return "err:" + String(e).slice(0, 40); } };
    out.hud = {
      bodyPinkClass: document.body.classList.contains("fvtt-tts-pink"),
      floatbarExists: !!fb,
      floatbarBg: bgOf(fb),
      pinkFloatbarBg: (document.body.classList.contains("fvtt-tts-pink") && fb) ? bgOf(fb) : "not-pink-body",
      // 立绘大小链路实测: 设置值 → body CSS 变量 → 实际消息立绘 maxWidth → header 头像 maxWidth
      portraitSize: (() => {
        try {
          const cs = getComputedStyle(document.body);
          const av = document.querySelector(".fvtt-tts-emotion-avatar");
          const hd = document.querySelector(".message-header img[data-fvtt-orig-src], .message-sender img[data-fvtt-orig-src]");
          return {
            setting: String(getCfg().portraitSize || ""),
            cssVar: (cs.getPropertyValue("--fvtt-tts-portrait-size") || "").trim(),
            headerVar: (cs.getPropertyValue("--fvtt-tts-header-avatar-size") || "").trim(),
            imgMaxW: av ? getComputedStyle(av).maxWidth : "no-avatar",
            headerMaxW: hd ? getComputedStyle(hd).maxWidth : "no-header-avatar",
          };
        } catch (e) { return { err: String(e).slice(0, 80) }; }
      })(),
      // GM 全局静音检测: 按钮存在 + 当前静音状态 + 播放标志(静音时 audioPlay 统一跳过)
      gmMute: (() => {
        try {
          return {
            setting: (() => { try { return game.settings.get(MODULE, "gmMute") === true; } catch (e) { return "err"; } })(),
            muteBtnExists: !!document.querySelector("#fvtt-tts-floatbar .fvtt-tts-mute"),
            playFlagMuted: window.__fvttTTSMutedFlag === true,
          };
        } catch (e) { return { err: String(e).slice(0, 80) }; }
      })(),
    };
  } catch (e) { out.hud.err = String(e); }
  try {
    let qc = null;
    try {
      const raw = localStorage.getItem("fvtt-tts-quickchars-v2") || localStorage.getItem("fvtt-tts-quickchars");
      if (raw) qc = JSON.parse(raw);
    } catch (e) { /* noop */ }
    out.portrait = {
      quickcharsKey: localStorage.getItem("fvtt-tts-quickchars-v2") ? "v2" : (localStorage.getItem("fvtt-tts-quickchars") ? "v1" : "none"),
      quickcharsTotal: (qc && qc.chars) ? qc.chars.length : -1,
      quickcharsRoles: (qc && qc.chars || []).map(c => ({ name: c.name, avatar: c.avatar ? "有" : "无", emo: (c.emotions || []).length })).slice(0, 12),
      msgContentNodes: document.querySelectorAll(".message-content").length,
      cssEmotionAvatarOnPage: document.querySelectorAll(".fvtt-tts-emotion-avatar").length,
      sampleMessageClass: (() => { const m = document.querySelector(".message"); return m ? String(m.className).slice(0, 80) : "none"; })(),
    };
    try {
      const resp = await svcRequest(getCfg().serverUrl, "GET", "/characters");
      const jd = (resp.jsonSafe ? resp.jsonSafe() : (resp.json || {})) || {};
      const firstAv = (jd.chars || []).find(c => c.avatar);
      out.portrait.charactersEndpoint = { ok: resp.ok, total: (jd.chars || []).length };
      if (firstAv) {
        const abs = `${location.origin}/${String(firstAv.avatar).replace(/^\.?\//, "")}`;
        let probe = "no-fetch";
        try {
          const pr = await fetch(abs, { method: "HEAD", signal: AbortSignal.timeout(6000) });
          probe = String(pr.status);
        } catch (e) { probe = "err:" + String(e).slice(0, 60); }
        out.portrait.avatarProbe = { rel: firstAv.avatar, abs, status: probe };
      }
      // 角色快照(30000 静态): pl/HTTPS 环境的数据源 — 检测快照是否生成且可达
      try {
        const sr = await fetch(`${location.origin}/modules/gpt-sovits-tts/engine/audio_export/chars_meta.json`, { signal: AbortSignal.timeout(6000) });
        const sj = await sr.json().catch(() => null);
        out.portrait.charsMetaSnapshot = { ok: sr.ok, count: (sj && Array.isArray(sj.chars)) ? sj.chars.length : -1, ts: (sj && sj.ts) || 0 };
      } catch (e) { out.portrait.charsMetaSnapshot = { err: String(e).slice(0, 60) }; }
    } catch (e) { out.portrait.charactersEndpoint = { err: String(e).slice(0, 80) }; }
    // 手动触发 applyEmotionAvatar(取最后一条消息) → 直接暴露"为什么没插图"(异常/无 flags/无 avatar/插入失败)
    try {
      const msgs = (game.messages && game.messages.contents) || [];
      const m = msgs[msgs.length - 1];
      if (m) {
        const el = m.element || (document.querySelector(".message"));
        const before = document.querySelectorAll(".fvtt-tts-emotion-avatar").length;
        const hdrOf = (e2) => { try { const h = e2 && (e2.querySelector(".message-header img") || e2.querySelector(".message-header .avatar") || e2.querySelector(".message-sender img")); return h ? (h.getAttribute("src") || "").slice(-60) : "no-header-img"; } catch (e3) { return "err"; } };
        const hdrBefore = hdrOf(el);
        let err = "";
        try { if (el) applyEmotionAvatar(m, el); } catch (e) { err = String(e).slice(0, 150); }
        const after = document.querySelectorAll(".fvtt-tts-emotion-avatar").length;
        const hdrAfter = hdrOf(el);
        const mf = (m.flags && m.flags[MODULE]) || null;
        out.portrait.manualApply = {
          before, after, err,
          hasFlags: !!mf,
          flagRole: (mf && mf.role) || "",
          hasEl: !!el,
          msgText: String(m.content || "").slice(0, 30),
          headerBefore: hdrBefore, headerAfter: hdrAfter, headerChanged: hdrBefore !== hdrAfter,
        };
      } else {
        out.portrait.manualApply = { err: "no messages" };
      }
    } catch (e) { out.portrait.manualApply = { err: String(e).slice(0, 150) }; }
    // 立绘随语气测试: 中文 label → findEmotionSlot 命中槽(新增强) + 槽立绘存在性
    out.portrait.emotionPortraitTest = (() => {
      try {
        const role = (loadVoiceProfile().current) || "";
        const c = (quickChars && quickChars.chars || []).find(x => x.name === role);
        const slots = (c && c.emotions) || [];
        const withAv = slots.filter(s => s.avatar);
        const probes = withAv.slice(0, 3).map(s => {
          const lbl = (s.label || "");
          return {
            key: s.key,
            label: lbl.slice(0, 18),
            avatar: s.avatar ? "有" : "无",
            labelMatch: !!(lbl && findEmotionSlot(lbl, role)),
            subMatch: !!(lbl && lbl.length > 1 && findEmotionSlot(lbl.slice(0, 2), role)),
          };
        });
        return { role, slotTotal: slots.length, slotWithAvatar: withAv.length, probes };
      } catch (e) { return { err: String(e).slice(0, 100) }; }
    })();
  } catch (e) { out.portrait.err = String(e); }
  try {
    out.net = {};
    try {
      const r = await svcRequest(getCfg().serverUrl, "GET", "/status");
      const j = r.jsonSafe ? r.jsonSafe() : (r.json || {});
      out.net.status = { ok: r.ok, char: (j.character && j.character.name) || "", device: j.device || "" };
    } catch (e) { out.net.status = { err: String(e).slice(0, 60) }; }
    try {
      const t0 = Date.now();
      const r = await svcRequest(getCfg().serverUrl, "POST", "/tts", { text: "测试", text_lang: "zh", media_type: "mp3", speed_factor: 1.0 }, { binary: true, timeoutMs: 60000 });
      out.net.ttsMin = { ok: r.ok, size: (r.blob && r.blob.size) || "?", ms: Date.now() - t0 };
    } catch (e) { out.net.ttsMin = { err: String(e).slice(0, 60) }; }
    // 生成/传输耗时分段: 阶段1=服务端合成+回传(genMs) → 阶段2=音频 URL 纯传输(xferMs)
    let _stAudioUrl = "";   // 供真实语音广播测试复用(不再重复合成)
    try {
      const t0 = Date.now();
      const r1 = await svcRequest(getCfg().serverUrl, "POST", "/tts", { text: "传输测试", text_lang: "zh", media_type: "mp3", speed_factor: 1.0 }, { binary: true, timeoutMs: 60000 });
      const t1 = Date.now();
      const url = r1.audioUrl || "";   // 服务端音频 URL(代理已回传, 优先 Foundry 静态路径)
      _stAudioUrl = url;
      const t2 = t1;   // 代理模式音频随响应返回, 无独立 json 阶段
      let t3 = t2, t4 = t2, size = 0;
      if (url) {
        const t3a = Date.now();
        const fullUrl = /^https?:\/\//i.test(url) ? url : (url.startsWith("/modules/") || url.startsWith("/data/")) ? new URL(url, window.location.origin).href : `${getCfg().serverUrl}${url}`;   // 相对路径按来源拼: /modules=Foundry 端口, /audio=TTS 服务
        const r2 = await fetch(fullUrl, { signal: AbortSignal.timeout(20000) });
        const buf = await r2.arrayBuffer();
        t4 = Date.now(); t3 = t3a; size = buf.byteLength;
      }
      out.net.ttsTiming = {
        genMs: t1 - t0, jsonMs: t2 - t1,
        xferMs: url ? (t4 - t3) : -1, size, urlMode: !!url, totalMs: t4 - t0,
      };
    } catch (e) { out.net.ttsTiming = { err: String(e).slice(0, 80) }; }
    // Edge-TTS 在线引擎探测(多引擎并行): 短文本真合成 → 报告可用性/耗时/音频路径(需服务器能访问微软在线服务)
    try {
      const et0 = Date.now();
      const er = await synthEdge("在线引擎自检", "zh", { serverUrl: cfg.serverUrl, speedFactor: 1.0, asBlob: true });
      out.net.edgeProbe = { ok: !!(er && er.audioUrl), ms: Date.now() - et0, audioUrl: (er && er.audioUrl) || "", size: (er && er.blob && er.blob.size) || 0, note: "失败多为服务器无外网/edge-tts 未安装; 本页为代理模式时 fetch 被拦属预期" };
    } catch (e) { out.net.edgeProbe = { err: String(e).slice(0, 80) }; }
    // 跨页面广播测试: 本页发 ping → 其他页面(标签/玩家)常驻监听回 pong → 统计到达 + 往返耗时
    out.net.broadcast = await new Promise((resolve) => {
      try {
        const pongs = [];
        const started = Date.now();
        const onMsg = (data) => {
          try {
            if (data && data.type === "selftest-pong") pongs.push({ from: String(data.from || "?"), rttMs: Date.now() - (data.origTs || started) });
          } catch (e) { /* noop */ }
        };
        try { game.socket.on(MODULE, onMsg); } catch (e) { /* noop */ }
        let sent = false;
        try { game.socket.emit(MODULE, { type: "selftest-ping", origTs: started, from: game.user.name }); sent = true; } catch (e) { /* noop */ }
        setTimeout(() => {
          try { game.socket.off(MODULE, onMsg); } catch (e) { /* noop */ }
          resolve({ sent, pongCount: pongs.length, peers: pongs.map(p => p.from), rttMs: pongs.map(p => p.rttMs), waitMs: Date.now() - started });
        }, 2500);
      } catch (e) { resolve({ err: String(e).slice(0, 80) }); }
    });
    // 真实语音传递测试: 广播刚合成的音频(selftest- 前缀 messageId) → 其他页面收到即回执 ack(并实际进入播放流程) → 统计到达/耗时
    if (_stAudioUrl) {
      out.net.audioBroadcast = await new Promise((resolve) => {
        try {
          const bmid = "selftest-" + Date.now() + "-" + Math.floor(Math.random() * 1000);
          const acks = [];
          const tsSend = Date.now();
          const onAck = (data) => {
            try {
              if (data && data.type === "selftest-audio-ack" && data.messageId === bmid) acks.push({ from: String(data.from || "?"), rttMs: Date.now() - tsSend });
            } catch (e) { /* noop */ }
          };
          try { game.socket.on(MODULE, onAck); } catch (e) { /* noop */ }
          let sent = false;
          try {
            game.socket.emit(MODULE, { type: "tts", messageId: bmid, audioUrl: _stAudioUrl, mediaType: "mp3", sender: game.user.name, lang: "zh", ts: tsSend, selftest: true });
            sent = true;
          } catch (e) { /* noop */ }
          setTimeout(() => {
            try { game.socket.off(MODULE, onAck); } catch (e) { /* noop */ }
            resolve({ sent, ackCount: acks.length, peers: acks.map(a => a.from), ackRttMs: acks.map(a => a.rttMs), waitMs: Date.now() - tsSend });
          }, 3000);
        } catch (e) { resolve({ err: String(e).slice(0, 80) }); }
      });
    } else {
      out.net.audioBroadcast = { err: "no-audio-url" };
    }
    out.net.runnerList = (() => { const a = []; try { runnerList.forEach((v, u) => a.push(u + "#" + (v.by || ""))); } catch (e) { /* noop */ } return a; })();
    // 传输测试(服务端中介确认广播到达): 其他页面(pl)收到即 HTTP 回写 — 与 ping/pong 回程对照, 可区分"广播没到"vs"回程丢"
    out.net.transfer = await runTransferTest();
  } catch (e) { out.net.err = String(e); }
  try {
    const vp = loadVoiceProfile();
    out.voice = { current: vp.current || "", chars: Object.keys(vp.chars || {}).length };
  } catch (e) { out.voice.err = String(e); }
  // 音频/输入链路: 自动播放策略状态 + STT 设备 + 聊天发送函数 + 模块 CSS 关键类加载
  try {
    let ctxState = "no-ctx";
    try {
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      ctxState = ac.state;
      try { ac.close(); } catch (e) { /* noop */ }
    } catch (e) { ctxState = "err:" + String(e).slice(0, 30); }
    const cssHas = (sel) => {   // 查样式表规则(元素未创建时也能判定 CSS 是否真的加载)
      try {
        for (const sh of document.styleSheets) {
          let rules = null;
          try { rules = sh.cssRules || sh.rules || []; } catch (e) { continue; }
          for (const r of rules) { if (r && r.selectorText && r.selectorText.includes(sel)) return true; }
        }
        return false;
      } catch (e) { return "err"; }
    };
    out.audio = {
      audioCtxState: ctxState,   // suspended=需用户交互解锁(点击自检按钮本身已解锁), running=可自动播放
      sttDevices: (() => { try { return (ttsDevices || []).map(d => d.label).slice(0, 5); } catch (e) { return []; } })(),
      sendFn: typeof doSubmitChat === "function" ? "ok" : "missing",
      cssFloatbar: cssHas("#fvtt-tts-floatbar"),
      cssSendpop: cssHas(".fvtt-tts-sendpop"),
      cssIndicator: cssHas(".fvtt-tts-char-indicator"),
      cssEmoAvatar: cssHas(".fvtt-tts-emotion-avatar"),
    };
  } catch (e) { out.audio.err = String(e); }
  let resText = "no-response";
  try {
    const r = await svcRequest(getCfg().serverUrl, "POST", "/selftest", out, { timeoutMs: 15000 });
    const jd = (r.jsonSafe ? r.jsonSafe() : (r.json || {})) || {};
    resText = (jd && jd.file) || ("HTTP " + r.status);
  } catch (e) { resText = "err:" + String(e).slice(0, 50); }
  try { ui.notifications.info(`自检完成\n${resText}`); } catch (e) { /* noop */ }
  try { console.log("[gpt-sovits-tts] 自检报告:", JSON.stringify(out, null, 2)); } catch (e) { /* noop */ }
  return out;
}

/* ============ 传输测试: 广播真实到达确认(服务端中介) — GM 发 selftest-transfer, 其他页面(pl)收到后 HTTP 回写服务端, 与 ping/pong 回程对照 ============ */
async function runTransferTest() {
  const url = getCfg().serverUrl;
  const id = "tr-" + Date.now() + "-" + Math.floor(Math.random() * 999);
  const out = { id, sent: false, arrivalCount: 0, arrivals: [], err: "" };
  try {
    const r0 = await svcRequest(url, "POST", "/selftest/transfer-start", { id }, { timeoutMs: 8000 });
    if (!r0.ok) throw new Error("start " + r0.status);
  } catch (e) { out.err = "start:" + String(e).slice(0, 50); return out; }
  try { game.socket.emit(MODULE, { type: "selftest-transfer", id, ts: Date.now() }); out.sent = true; } catch (e) { out.err = "emit:" + String(e).slice(0, 50); }
  await new Promise(r => setTimeout(r, 3000));
  try {
    const r1 = await svcRequest(url, "GET", "/selftest/transfer-result?id=" + encodeURIComponent(id), undefined, { timeoutMs: 8000 });
    const j = (r1.jsonSafe ? r1.jsonSafe() : (r1.json || {})) || {};
    out.arrivals = (j && j.arrivals) || [];
    out.arrivalCount = out.arrivals.length;
  } catch (e) { out.err = "result:" + String(e).slice(0, 50); }
  return out;
}

/* ============ 高压测试: 客户端压力(浏览器) — 适配低配服务器(引擎不可压, 压力全在玩家端) — 结果并入 selftest_stress.json ============ */
async function runStressTest() {
  const url = getCfg().serverUrl;
  const out = {
    at: new Date().toISOString(), mode: "stress",
    env: { patch: String(window.__fvttTTSPatch || ""), canDirect: (() => { try { return window.__fvttTTSCanDirect === true ? "direct" : (window.__fvttTTSCanDirect === false ? "proxy(gm)" : "probe-pending"); } catch (e) { return "err"; } })(), user: (typeof game !== "undefined" && game.user && game.user.name) || "" },
    stress: {},
  };
  const synthOne = async (text, ms = 90000) => {
    try {
      const t0 = Date.now();
      const r = await svcRequest(url, "POST", "/tts", { text, text_lang: "zh", media_type: "mp3", speed_factor: 1.0 }, { binary: true, timeoutMs: ms });
      let audioUrl = r.audioUrl || "";
      try { if (audioUrl && !/^https?:\/\//i.test(audioUrl)) audioUrl = (audioUrl.startsWith("/modules/") || audioUrl.startsWith("/data/")) ? new URL(audioUrl, window.location.origin).href : new URL(audioUrl, url).href; } catch (e) { /* noop */ }
      const buf = r.ok && r.blob ? r.blob : null;
      return { ok: r.ok, status: r.status || 0, ms: Date.now() - t0, size: buf ? buf.size : 0, audioUrl };
    } catch (e) { return { ok: false, err: String(e).slice(0, 40) }; }
  };
  // ===== 客户端压力(全部压在浏览器): 只合成 1 段素材, 其余场景全在客户端执行 — 适配低配服务器(引擎不可压) =====
  // 素材: 合成 1 段短音频(唯一一次请求服务端, 供播放类测试复用)
  let lastAv = "";
  try {
    const t0 = Date.now();
    const r = await synthOne("压力测试", 60000);
    if (r.ok && r.audioUrl) lastAv = r.audioUrl;
    out.stress.material = { ok: !!r.ok, status: r.status || 0, synthMs: r.ms, size: r.size, err: r.err || "" };
  } catch (e) { out.stress.material = { err: String(e).slice(0, 80) }; }
  // 1) 客户端: 并发播放(6 段同播同一音频, 低音量 0.3 — 测浏览器音频解码/多 Audio 实例)
  try {
    if (!lastAv) throw new Error("no material");
    const reps = 6;
    const t0 = Date.now();
    let ok = 0;
    const jobs = [];
    for (let i = 0; i < reps; i++) jobs.push(audioPlay(lastAv, { volume: 0.3 }).then(() => { ok++; }).catch(() => { /* noop */ }));
    await Promise.all(jobs);
    out.stress.playConcurrent = { sent: reps, ok, ms: Date.now() - t0 };
  } catch (e) { out.stress.playConcurrent = { err: String(e).slice(0, 80) }; }
  // 2) 客户端: 队列洪泛(50 个瞬时任务入队, 测队列管理与排空)
  try {
    const t0 = Date.now();
    const N = 50;
    let done = 0;
    for (let i = 0; i < N; i++) queue.enqueue({ play: () => { done++; return Promise.resolve(); } });
    await new Promise(r => setTimeout(r, 300));
    out.stress.queueFlood = { sent: N, done, ms: Date.now() - t0 };
  } catch (e) { out.stress.queueFlood = { err: String(e).slice(0, 80) }; }
  // 3) 客户端: 千立绘渲染(临时容器 1000 张头像 img, 不污染聊天 — 测 DOM 插入+图片解码)
  try {
    const t0 = Date.now();
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;left:-99999px;top:0;width:320px;";
    document.body.appendChild(host);
    let avatarSrc = "";
    try { const a = document.querySelector(".fvtt-tts-emotion-avatar img, .message-header img"); if (a) avatarSrc = a.getAttribute("src") || ""; } catch (e) { /* noop */ }
    const N = 1000;
    let loaded = 0, failed = 0;
    for (let i = 0; i < N; i++) {
      const img = document.createElement("img");
      img.style.cssText = "width:90px;height:90px;display:inline-block;";
      img.onload = () => { loaded++; };
      img.onerror = () => { failed++; };
      if (avatarSrc) img.src = avatarSrc;
      host.appendChild(img);
    }
    await new Promise(r => setTimeout(r, avatarSrc ? 3000 : 100));
    try { document.body.removeChild(host); } catch (e) { /* noop */ }
    out.stress.portraitRender = { sent: N, loaded: avatarSrc ? loaded : "no-src", failed: avatarSrc ? failed : 0, ms: Date.now() - t0 };
  } catch (e) { out.stress.portraitRender = { err: String(e).slice(0, 80) }; }
  // 4) 客户端: 并发拉流(20 个并发 fetch Foundry 静态文件 — 测浏览器连接池/HTTP 并发)
  try {
    const t0 = Date.now();
    let target = "/modules/gpt-sovits-tts/module.json";
    try { const a = document.querySelector(".fvtt-tts-emotion-avatar img, .message-header img"); if (a) target = a.getAttribute("src") || target; } catch (e) { /* noop */ }
    const full = new URL(target, window.location.origin).href;
    const res = await Promise.all(Array.from({ length: 20 }, () => fetch(full, { signal: AbortSignal.timeout(15000) }).then(r => r.ok).catch(() => false)));
    out.stress.netConcurrent = { sent: 20, ok: res.filter(Boolean).length, ms: Date.now() - t0 };
  } catch (e) { out.stress.netConcurrent = { err: String(e).slice(0, 80) }; }
  // 5) 客户端: 内存观察(performance.memory, Chrome; 创建 50 个 1MB blob 后对比 usedJSHeapSize)
  try {
    const mem = () => { try { return (performance.memory && performance.memory.usedJSHeapSize) ? Math.round(performance.memory.usedJSHeapSize / 1048576) : -1; } catch (e) { return -1; } };
    const before = mem();
    const blobs = [];
    for (let i = 0; i < 50; i++) blobs.push(new Blob([new Uint8Array(1024 * 1024)], { type: "application/octet-stream" }));
    const after = mem();
    blobs.length = 0;
    out.stress.memoryWatch = { beforeMB: before, after50x1MB: after, deltaMB: (before >= 0 && after >= 0) ? after - before : "n/a" };
  } catch (e) { out.stress.memoryWatch = { err: String(e).slice(0, 80) }; }
  // 6) 客户端: DOM 操作(快速插入/移除 500 节点计时)
  try {
    const t0 = Date.now();
    const host = document.createElement("div");
    document.body.appendChild(host);
    for (let i = 0; i < 500; i++) { const n = document.createElement("span"); n.textContent = "x"; host.appendChild(n); }
    host.innerHTML = "";
    try { document.body.removeChild(host); } catch (e) { /* noop */ }
    out.stress.domOps = { nodes: 500, ms: Date.now() - t0 };
  } catch (e) { out.stress.domOps = { err: String(e).slice(0, 80) }; }
  // 在线玩家检测: 高压要测"给其他 pl 传输语音" — 先看有几个非 GM 玩家在线(active), 广播风暴的 ack 里按名字识别哪些是 pl
  try {
    const users = (game.users && game.users.contents) || [];
    const activeP = users.filter(u => !u.isGM && u.active);
    out.stress.plOnline = { count: activeP.length, names: activeP.map(u => u.name) };
  } catch (e) { out.stress.plOnline = { err: String(e).slice(0, 60) }; }
  // 4.5) 快速 ping(1.5s): 区分"接收页在线但 ack 逻辑旧"与"没加载最新 JS" — ping 有回执而风暴 0 = ack 问题; ping 也 0 = 接收页需刷新
  try {
    out.stress.pingQuick = await new Promise((resolve) => {
      const pongs = [];
      const started = Date.now();
      const onP = (d) => { try { if (d && d.type === "selftest-pong") pongs.push(String(d.from || "?")); } catch (e) { /* noop */ } };
      try { game.socket.on(MODULE, onP); } catch (e) { /* noop */ }
      let sent = false;
      try { game.socket.emit(MODULE, { type: "selftest-ping", origTs: started, from: game.user.name }); sent = true; } catch (e) { /* noop */ }
      setTimeout(() => { try { game.socket.off(MODULE, onP); } catch (e) { /* noop */ } resolve({ sent, pongCount: pongs.length, peers: pongs }); }, 1500);
    });
  } catch (e) { out.stress.pingQuick = { err: String(e).slice(0, 60) }; }
  // 传输测试(服务端中介: pl 收到广播即 HTTP 回写) — 与 pingQuick 对照: transfer 有到达而 pong 0 = pl→GM socket 回程问题; 两者都 0 = 广播没到 pl
  try { out.stress.transfer = await runTransferTest(); } catch (e) { out.stress.transfer = { err: String(e).slice(0, 60) }; }
  // 4) 广播风暴(连续 10 条真实音频广播 → 全员广播, pl 页面常驻回执 → 验证"语音传输到其他 pl")
  try {
    out.stress.broadcastStorm = await new Promise((resolve) => {
      const acks = [];
      const started = Date.now();
      const onAck = (d) => { try { if (d && d.type === "selftest-audio-ack") acks.push({ from: String(d.from || "?"), rttMs: Date.now() - (d.origTs || started) }); } catch (e) { /* noop */ } };
      try { game.socket.on(MODULE, onAck); } catch (e) { /* noop */ }
      let sent = 0;
      if (lastAv) {
        try {
          for (let i = 0; i < 10; i++) {
            game.socket.emit(MODULE, { type: "tts", messageId: "selftest-storm-" + Date.now() + "-" + i, audioUrl: lastAv, mediaType: "mp3", sender: game.user.name, lang: "zh", ts: Date.now() });
            sent++;
          }
        } catch (e) { /* noop */ }
      }
      setTimeout(() => {
        try { game.socket.off(MODULE, onAck); } catch (e) { /* noop */ }
        resolve({ sent, ackCount: acks.length, peers: [...new Set(acks.map(a => a.from))], rttMs: [...new Set(acks.map(a => a.rttMs))], waitMs: Date.now() - started, note: "全员广播 — ack 里的名字即收到语音的页面(含 pl)" });
      }, 3000);
    });
  } catch (e) { out.stress.broadcastStorm = { err: String(e).slice(0, 80) }; }
  // 5) 批量立绘渲染(全部历史消息重插 → 计时)
  try {
    const t0 = Date.now();
    let applied = 0;
    if (game.messages && game.messages.contents) {
      game.messages.contents.forEach(m => {
        try {
          const el = m.element || (m.id && document.querySelector(`.message[data-message-id="${m.id}"]`));
          if (el) { applyEmotionAvatar(m, el); applied++; }
        } catch (e) { /* noop */ }
      });
    }
    out.stress.portraitBulk = { applied, ms: Date.now() - t0 };
  } catch (e) { out.stress.portraitBulk = { err: String(e).slice(0, 80) }; }
  // 6) 缓存规模(高压直连 /tts 不经 speak 缓存 — 0 属正常, 供参考)
  try { out.stress.cache = { synthCacheSize: _synthCache ? _synthCache.size : -1, audioCacheSize: audioCache ? audioCache.size : -1, note: "高压直连 /tts 不经 speak 缓存 — 0 属正常" }; } catch (e) { out.stress.cache = {}; }
  // 7) LLM 链路(带真实 key 调一次 pick-role, 测 AI 可用性 — 失败不中断)
  try {
    const _key = (() => { try { return game.settings.get(MODULE, "llmKey") || ""; } catch (e) { return ""; } })();
    const _base = (() => { try { return game.settings.get(MODULE, "llmBaseUrl") || ""; } catch (e) { return ""; } })();
    const _model = (() => { try { return game.settings.get(MODULE, "llmModel") || ""; } catch (e) { return ""; } })();
    const t0 = Date.now();
    const r = await svcRequest(url, "POST", "/llm/pick-role", { base: _base, key: _key, model: _model, text: "这是一段测试台词", roles: ["七海千秋", "阿尔托莉雅·潘德拉贡"] }, { timeoutMs: 20000 });
    const j = (r.jsonSafe ? r.jsonSafe() : (r.json || {})) || {};
    out.stress.llm = { ok: r.ok, status: r.status || 0, hasKey: !!_key, model: _model || "(空→默认gpt-4o-mini)", role: (j && j.role) || "", ms: Date.now() - t0, note: _model ? "" : "llmModel 设置为空 → 服务端用默认 gpt-4o-mini; 若该模型在服务商不可用会 502, 请在设置里填真实模型名" };
  } catch (e) { out.stress.llm = { err: String(e).slice(0, 60) }; }
  // 8) 系统层(不可手动确认的全进自检): hook 活性 / AI 共享生效 / 代理链路端到端实测 / 消息 flags 结构
  out.sys = {};
  try {
    out.sys.hooks = Object.assign({}, window.__fvttTTSHooks || {});
  } catch (e) { out.sys.hooksErr = String(e).slice(0, 60); }
  try {
    out.sys.aiShared = {
      worldBaseSet: !!(game.settings.get(MODULE, "aiSharedBase")),
      worldKeySet: !!(game.settings.get(MODULE, "aiSharedKey")),
      worldModelSet: !!(game.settings.get(MODULE, "aiSharedModel")),
      effectiveShared: getCfg().aiShared === true,   // 共享值确实覆盖本地
      effectiveBase: String(getCfg().llmBaseUrl || "").slice(0, 50),
      effectiveModel: String(getCfg().llmModel || "").slice(0, 40),
      effectiveKeySet: !!(getCfg().llmKey),
      effectiveEnabled: getCfg().llmEnabled === true,   // 一键分发后共享存在 → 自动启用(pl 端 AI 生效的关键)
    };
  } catch (e) { out.sys.aiSharedErr = String(e).slice(0, 60); }
  try {
    // 多模型池状态: 服务端同时常驻的角色模型数(默认10/上限20) — GM 在 模块设置 里改, 客户端自检确认同步
    const cfgX2 = getCfg();
    const pr = await svcRequest(cfgX2.serverUrl, "GET", "/config").catch(() => null);
    const pj = (pr && (pr.jsonSafe ? pr.jsonSafe() : (pr.json || {}))) || {};
    out.sys.pool = { ok: !!(pr && pr.ok), max: (pj && pj.max_concurrent_models) || -1, setting: Number(getCfg().maxConcurrentModels) || -1 };
  } catch (e) { out.sys.pool = { err: String(e).slice(0, 60) }; }
  try {
    // 代理链路端到端实测(不依赖真实消息/事件): 构造假消息(当前角色参数) → 走 GM 代理执行核心(真合成+写回校验)
    const cur = currentVoice() || {};
    const fakeMsg = {
      id: "selftest-proxy-" + Date.now(),
      flags: { [MODULE]: { synthRequest: { text: "代理链路自检", lang: "zh", speed: 1.0 }, ref: cur.ref || "", promptText: cur.promptText || "", promptLang: cur.promptLang || "", auxRef: cur.auxRef || "", emotionMix: cur.emotionMix } },
      update: async () => ({ ok: true }),
    };
    out.sys.proxyProbe = await _proxySynthFor(fakeMsg);
  } catch (e) { out.sys.proxyProbe = { err: String(e).slice(0, 80) }; }
  try {
    // 最近一条带模块 flags 的消息结构(确认朗读上下文 flags.synthRequest/audioUrl 是否真正随消息同步)
    const msgs = (game.messages && game.messages.contents) || [];
    let found = null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const fl = msgs[i].flags && msgs[i].flags[MODULE];
      if (fl && (fl.role || fl.synthRequest || fl.audioUrl)) { found = { id: msgs[i].id, author: (msgs[i].author && msgs[i].author.name) || "", role: fl.role || "", hasSynthRequest: !!fl.synthRequest, hasAudioUrl: !!fl.audioUrl, synthResult: fl.synthResult || "" }; break; }
    }
    out.sys.lastMsgFlags = found || { none: true };
  } catch (e) { out.sys.lastMsgFlagsErr = String(e).slice(0, 60); }
  let resText = "no-response";
  try {
    const r = await svcRequest(url, "POST", "/selftest", out, { timeoutMs: 15000 });
    const jd = (r.jsonSafe ? r.jsonSafe() : (r.json || {})) || {};
    resText = (jd && jd.file) || ("HTTP " + r.status);
  } catch (e) { resText = "err:" + String(e).slice(0, 50); }
  try { ui.notifications.info(`高压测试完成\n${resText}`); } catch (e) { /* noop */ }
  try { console.log("[gpt-sovits-tts] 高压测试报告:", JSON.stringify(out, null, 2)); } catch (e) { /* noop */ }
  return out;
}

/* ============ 🔬 玩家自测(仅玩家端可点: 验证本机能否收到并官方通道播放 GM 语音) ============ */
async function runPlayerSelfTest() {
  const steps = [];
  const pass = (k, v, ok) => { steps.push({ k, v, ok: ok !== false }); };
  try {
    const patch = (() => { try { return window.__fvttTTSPatch || ""; } catch (e) { return ""; } })();
    pass("模块加载", "patch=" + (patch || "?"), !!patch);
    const conn = !!(game && game.ready && game.user && game.user.id);
    pass("Foundry 连接", conn ? "已连接" : "未连接", conn);
    if (!conn) { finishSelfTest(steps); return; }
    // GM 端分支: GM 自己就是代理, 直接"本地合成→官方通道播放"自测(等同试听), 不走代理消息
    if (game.user && game.user.isGM) {
      let ok2 = false;
      try { ok2 = await speak("语音合成与播放测试正常。", { lang: "zh", skipAiEmotion: true }); } catch (e) { /* noop */ console.error(e); }
      // 轮询等播放真正发生(合成+队列可能数秒, 固定 1s 常误判"未检测到"): 最长 20s; 每轮记录轨迹供报告文件分析
      let impl = "", playErr = "", playTrace = [];
      const _ahOk = !!((typeof foundry !== "undefined") && foundry.audio && foundry.audio.AudioHelper && typeof foundry.audio.AudioHelper.play === "function");
      const _t0 = Date.now();
      while (Date.now() - _t0 < 20000) {
        try {
          const c0 = window.__fvttTTSCnt || {};
          impl = window.__fvttTTSPlayImpl || (c0.official > (c0.native || 0) ? "official" : (c0.native || 0) > 0 ? "native" : "");
          playErr = window.__fvttTTSPlayErr || "";
          playTrace.push({ t: Date.now() - _t0, impl, o: c0.official || 0, n: c0.native || 0, err: (playErr || "").slice(0, 80) });
          if (impl) break;
        } catch (e) { /* noop */ }
        await new Promise(r => setTimeout(r, 400));
      }
      pass("合成播出", ok2 ? "成功 ✓" : "失败", !!ok2);
      pass("播放通道", impl === "official" ? "官方界面通道 ✓" : impl ? ("走" + impl + (playErr ? "·" + playErr : "")) : "未检测到播放", impl === "official");
      pass("通道细节", "AH=" + (_ahOk ? "有" : "无") + " 检测" + playTrace.length + "次 " + JSON.stringify(playTrace.slice(0, 8)), true);
      pass("说明", "GM 端本地直连自测" + (playErr ? " · 官方失败原因: " + playErr : ""), true);
      finishSelfTest(steps); return;
    }
    let gmOnline = false, gmName = "";
    try { game.users.forEach(u => { if (u && u.isGM) { gmName = u.name || ""; if (!u.isObserver && u.active) gmOnline = true; } }); } catch (e) { /* noop */ }
    pass("GM 在线", gmName ? (gmOnline ? "在线(" + gmName + ")" : "GM存在但非活动") : "无GM在线", gmOnline);
    // ① 真实发声链路: 与"玩家真实说话"完全同路径 — Player2 端 gptSovitsSynth(直连/代理)合成 →
    // 成功则本机 audioPlay(官方通道) 验证本机真能发声; 失败(422/被拒)自测即失败, 不再假阳性。
    // 代理模式(https 页面/跨网/无本地引擎, CanDirect=false): 玩家本就不合成(发声=GM 代合成→广播),
    // 跳过本地合成, 由下方"请求已发送/音频写回/播放通道"验证真实收听链路(用户核心诉求)。
    const _canD = window.__fvttTTSCanDirect === true;
    let localImpl = "", localErr = "", localBlob = null;
    if (_canD) {
      try {
      const prof = loadVoiceProfile();
      const cur = currentVoice();
      const o = {};
      try {
        if (cur && cur.ref) o.refAudioPath = cur.ref;
        if (cur && cur.promptText) o.promptText = cur.promptText;
        if (cur && cur.promptLang) o.promptLang = cur.promptLang;
        if (cur && cur.auxRef) o.auxRefAudioPaths = [cur.auxRef];
        if (cur && typeof cur.emotionMix === "number") o.emotionMix = cur.emotionMix;
      } catch (e) { /* noop */ }
      const lres = await gptSovitsSynth("玩家自测，语音合成与播放正常。", "zh", { serverUrl: getCfg().serverUrl, role: (prof && prof.current) || "", overrides: o, mediaType: "mp3", asBlob: true });
      if (lres && lres.blob && lres.blob.size > 0) {
        localBlob = lres.blob;
        pass("本地合成", "成功 ✓ (" + Math.round((lres.blob.size || 0) / 1024) + "KB)", true);
        try { await audioPlay(URL.createObjectURL(lres.blob), { volume: playVolume(), push: false }); } catch (e) { localErr = String((e && e.message) || e).slice(0, 60); }
      } else {
        const _e = String((lres && (lres.err || lres.error)) || "无音频(合成被拒?)").slice(0, 60);
        pass("本地合成", "失败: " + _e, false);
      }
    } catch (e) { pass("本地合成", "失败: " + String((e && e.message) || e).slice(0, 60), false); }
    } else {
      pass("本地合成", "代理模式跳过(https/跨网/无本地引擎): 发声走 GM 代合成→广播, 下方验证收听链路", true);
    }
    // ② 广播链路: 发真实合成请求消息 → GM 代理代合成并写回 flags → 验证"全员同声"通道
    let role = "";
    try { const p = loadVoiceProfile(); role = (p && p.current) || ""; } catch (e) { /* noop */ }
    const sentAt = Date.now();
    let msgId = "";
    try {
      const m = await ChatMessage.create({ content: "🔬 玩家自测", speaker: { alias: (game.user && game.user.name) || "玩家" }, flags: { [MODULE]: { synthRequest: { text: "玩家自测，语音合成与播放正常。", lang: "zh", provider: "gpt-sovits" }, role: role || "", selfTest: { ts: sentAt } } } });
      msgId = (m && m.id) ? m.id : "";
      pass("请求已发送", "等待 GM/服务器合成", !!msgId);
    } catch (e) { pass("请求发送失败", String(e).slice(0, 60), false); try { ui.notifications.error("🔬 玩家自测: 请求发送失败"); } catch (e2) { /* noop */ } return; }
    // 轮询自己的消息 flags 是否被 GM 代理写回音频
    let audioUrl = "", audioData = "", arriveAt = 0, deadline = sentAt + 30000;
    while (Date.now() < deadline) {
      try {
        const m = game.messages.get(msgId);
        const f = (m && m.flags && m.flags[MODULE]) || {};
        if (f.audioData || f.audioUrl) { audioUrl = f.audioUrl || ""; audioData = f.audioData || ""; arriveAt = Date.now(); break; }
      } catch (e) { /* noop */ }
      await new Promise(r => setTimeout(r, 300));
    }
    if (audioUrl || audioData) {
      pass("音频写回", "(发送到收到 " + (arriveAt - sentAt) + "ms) " + (audioData ? "内嵌" : "URL"), true);
    } else {
      pass("音频写回", "超时未收到(代理不通/合成排队/无GM代理)", false);
    }
    await new Promise(r => setTimeout(r, 1500));
    // 播放通道: 本地合成播放(真实发声链路)已优先验证; 广播写回音频也试播(验证写回可用) —
    // 自测消息 author=自己被动播放路径 isSelf 跳过, 故主动 audioPlay; impl 优先取本地链路值
    let impl = localImpl || "", playErr = localErr || "", playTrace = [];
    const _tPlay0 = Date.now();
    if (audioData || audioUrl) {
      let playSrc = audioData || "";
      if (!playSrc && audioUrl) {
        try {
          playSrc = /^https?:\/\//i.test(audioUrl) ? audioUrl
            : (audioUrl.startsWith("/modules/") || audioUrl.startsWith("/data/")) ? new URL(audioUrl, window.location.origin).href
            : getCfg().serverUrl.replace(/\/+$/, "") + audioUrl;
        } catch (e) { playSrc = audioUrl; }
      }
      try { await audioPlay(playSrc, { volume: playVolume(), push: false }); } catch (e) { playErr = String((e && e.message) || e).slice(0, 80); }
    } else {
      playErr = "无音频可播(写回失败)";
    }
    const tEnd2 = Date.now() + 15000;
    while (Date.now() < tEnd2) {
      try {
        const c0 = window.__fvttTTSCnt || {};
        impl = window.__fvttTTSPlayImpl || (c0.official > (c0.native || 0) ? "official" : (c0.native || 0) > 0 ? "native" : "");
        playErr = window.__fvttTTSPlayErr || playErr;
        playTrace.push({ t: Date.now() - _tPlay0, impl, o: c0.official || 0, n: c0.native || 0, err: (playErr || "").slice(0, 80) });
        if (impl) break;
      } catch (e) { /* noop */ }
      await new Promise(r => setTimeout(r, 400));
    }
    pass("静音标志", (() => { try { return window.__fvttTTSMutedFlag === true ? "静音中(残留gmMute会致播放全跳过)" : "未静音"; } catch (e) { return "?"; } })(), true);
    pass("播放通道", impl === "official" ? "官方界面通道 ✓" : impl ? ("走" + impl + (playErr ? "·" + playErr : "")) : "未检测到播放" + (playErr ? "·" + playErr : ""), impl === "official");
    pass("播放轨迹", (playErr ? "err:" + playErr + " " : "") + "检测" + playTrace.length + "次 " + JSON.stringify(playTrace.slice(0, 10)), true);
    pass("总耗时", ((Date.now() - sentAt) / 1000).toFixed(1) + "s(发送→播放)", !!audioUrl || !!audioData);
    finishSelfTest(steps);
  } catch (e) {
    console.error("[gpt-sovits-tts][自测] 异常:", e);
    finishSelfTest(steps);
  }
}
function finishSelfTest(steps) {
  try {
    const okN = steps.filter(s => s.ok).length, tot = steps.length;
    // 失败步骤带细节值(如"播放通道=走native·<err>"), 通知/聊天里直接可见, 不用翻 console
    const fails = steps.filter(s => !s.ok).map(s => s.k + (s.v ? "=" + String(s.v).slice(0, 80) : ""));
    const head = (okN === tot) ? "玩家自测通过 ✅" : ("自测 " + okN + "/" + tot + (fails.length ? "（失败: " + fails.join("、") + "）" : ""));
    try { ui.notifications.info("🔬 " + head); } catch (e) { /* noop */ }
    try { window.__gptSovits = window.__gptSovits || {}; window.__gptSovits.playerSelfTestResult = { ts: Date.now(), steps, ok: okN === tot }; console.log("[gpt-sovits-tts][自测]", head, steps); } catch (e) { /* noop */ }
    // 🔊 落盘 + 回执: 尽力写服务端玩家报告(serverUrl 可达时; frp/MixedContent 静默失败) + 聊天回执(可靠, GM 可看到)
    const uName = (() => { try { return (game.user && game.user.name) || "player"; } catch (e) { return "player"; } })();
    const payload = { ts: Date.now(), user: uName, role: "player", kind: "playerSelfTest", ok: okN === tot, pass: okN, total: tot, fail: fails, steps };
    try {
      svcRequest(getCfg().serverUrl, "POST", "/speedtest/report", payload).catch(() => { /* 代理不可达 → 走聊天回执 */ });
    } catch (e) { /* noop */ }
    // 可靠落盘: GM 端代 POST 引擎 /speedtest/report → 引擎写 FVTT 主机 server/player_selftest_<user>.json(v13 module 事件中继)
    try {
      moduleEmit("tts-report", { report: payload }, { timeoutMs: 15000 }).catch(() => { /* noop */ });
    } catch (e) { /* noop */ }
    try {
      const mark = okN === tot ? "✅" : "⚠️";
      ChatMessage.create({ content: `${mark} 🔬 ${uName} 玩家自测：${okN}/${tot}${fails.length ? " · 失败: " + fails.join("、") : ""}`, speaker: { alias: uName }, flags: { [MODULE]: { playerSelfTestResult: { from: uName, ts: Date.now(), ok: okN === tot, pass: okN, total: tot, fails, steps } } } });
    } catch (e) { /* noop */ }
  } catch (e) { /* noop */ }
}

/* ============ 🚄 批量速度测试(分批: 合成/传输/加载 + 压满显卡峰值性能) ============ */
async function runSpeedTest() {
  const cfg = getCfg();
  // 精简模式(默认): 去掉已稳定/冗长的纯能力长测(长度梯度/语速/格式/连续长跑/API往返), 专注本轮问题项；
  // 控制台 window.__fvttTTSTestFull = true 后整跑全部测段
  const fullMode = (typeof window.__fvttTTSTestFull === "boolean") ? window.__fvttTTSTestFull : false;
  const out = { ts: Date.now(), user: (game.user && game.user.name) || "gm", canDirect: window.__fvttTTSCanDirect, patch: window.__fvttTTSPatch || "", fullMode, batches: {}, bugs: {}, conclusions: [] };
  // 播放实现计数器清零(本次测程内 GM 端各走 官方界面通道 / 原生音频 多少次)
  try { window.__fvttTTSCnt = { official: 0, native: 0 }; window.__fvttTTSPlayImpl = ""; } catch (e) { /* noop */ }
  // 报告在线玩家(判断 pl 是否真的在场参与传输测试)
  try { out.onlinePlayers = (game.users || []).filter(u => u.active && !u.isSelf).map(u => u.name || "?"); } catch (e) { out.onlinePlayers = []; }
  const base = String(cfg.serverUrl || "http://127.0.0.1:9880").replace(/\/+$/, "");
  const api = (path, body) => svcRequest(base, "POST", path, body || {}).then(r => (r.jsonSafe ? r.jsonSafe() : (r.json || {}))).catch(() => ({}));
  const getJ = (path) => svcRequest(base, "GET", path).then(r => (r.jsonSafe ? r.jsonSafe() : (r.json || {}))).catch(() => ({}));
  // I1a 心跳探测(确认 pl 端通道活性, 决定传输段预期; pl 无响应=未硬刷新/离线)
  try {
    window.__fvttTTSPingAck = false;
    try {
      await ChatMessage.create({ content: "🫀", speaker: { alias: "速度测试心跳" }, flags: { [MODULE]: { speedTestPing: { ts: Date.now() } } } });
    } catch (e) { /* noop */ }
    await new Promise(r => setTimeout(r, 4000));
    out.batches.i1 = { plPing: window.__fvttTTSPingAck, plOnline: out.onlinePlayers || [] };
    out.conclusions.push(`I1 pl 活性: 心跳 ${window.__fvttTTSPingAck ? "✓ pl 通道通" : "✗ pl 无响应(请硬刷新 pl / 检查是否离线)"}${(out.onlinePlayers || []).length ? `, 在线: ${out.onlinePlayers.join(",")}` : ", 无 pl 在线"}`);
  } catch (e) { out.batches.i1 = { err: String(e).slice(0, 80) }; }
  let poolChar = "";
  // A1 模型/池加载速度 + 显卡状态(首用非激活角色触发池加载, 测加载耗时与显存占用)
  try {
    const st0 = await getJ("/status");
    out.gpuBefore = { freeGb: (st0.hw && st0.hw.gpu_mem_free_gb), totalGb: (st0.hw && st0.hw.gpu_mem_total_gb) };
    const g0 = await getJ("/speedtest/gpu");
    out.gpuUtilBefore = g0.util;
    try {
      const cd = (quickChars && quickChars.chars) || [];
      const act = (st0.character && st0.character.name) || "";
      const c = cd.find(x => x.name && x.name !== act) || cd[0];
      poolChar = (c && c.name) || "";
    } catch (e) { /* noop */ }
    const t0 = Date.now();
    const r1 = await gptSovitsSynth("加载速度测试", "zh", { serverUrl: cfg.serverUrl, speedFactor: 1.0, mediaType: "mp3", asBlob: true, role: poolChar });
    const loadMs = Date.now() - t0;
    out.batches.a1 = { poolChar, loadMs, ok: !!(r1 && r1.audioUrl) };
    const st1 = await getJ("/status");
    out.poolAfter = st1.pool;
    const g1 = await getJ("/speedtest/gpu");
    out.gpuUtilAfter = g1.util;
    out.gpuAfter = { freeGb: (st1.hw && st1.hw.gpu_mem_free_gb) };
    out.conclusions.push(`A1 加载: 角色[${poolChar}] ${loadMs}ms${loadMs > 3000 ? "(首次池加载, 之后秒回)" : "(池命中)"}, GPU 利用率 ${g1.util === null ? "无nvidia-smi" : g1.util + "%"}, 显存空闲 ${out.gpuAfter.freeGb}GB`);
  } catch (e) { out.batches.a1 = { err: String(e).slice(0, 80) }; }
  // A2 批量合成峰值(8 段短文本连续全压 + 2 段长文本真正压满 GPU, 每段记录合成耗时/字节)
  try {
    const segs = ["显卡满载测试一", "第二段连续合成", "第三段", "第四段测试", "第五段", "第六段", "第七段", "最后一段"];
    const times = [];
    for (const s of segs) {
      const t0 = Date.now();
      const r = await gptSovitsSynth(s, "zh", { serverUrl: cfg.serverUrl, speedFactor: 1.0, mediaType: "mp3", asBlob: true, role: poolChar });
      times.push({ ms: Date.now() - t0, bytes: (r && r.blob && r.blob.size) || 0 });
    }
    // 长文本(约 180 字 × 2 段): 合成时间长 → GPU 持续忙碌, 测满载峰值
    const longSegs = ["长文本压显卡性能测试正式开始，这一段会持续合成较长时间，用于观察显卡在满负载下的处理速度，多句话连续拼接，考验模型的长文本推理能力，句子越长计算量越大，显卡利用率应该明显上升，这样就能对比出短文本与长文本的真实速度差距，帮助判断这台机器的显卡在语音合成上的实际峰值性能表现如何。", "第二段长文本继续压测显卡性能，继续拼接多句台词，让推理引擎保持持续工作状态，观察平均耗时与显存占用变化，长文本的逐句切分与拼接本身也有额外开销，正好可以一起测量出来，作为批量速度测试的长文对照样本。"];
    const longTimes = [];
    for (const s of longSegs) {
      const t0 = Date.now();
      const r = await gptSovitsSynth(s, "zh", { serverUrl: cfg.serverUrl, speedFactor: 1.0, mediaType: "mp3", asBlob: true, role: poolChar });
      longTimes.push({ ms: Date.now() - t0, bytes: (r && r.blob && r.blob.size) || 0 });
    }
    const gm = await getJ("/speedtest/gpu");
    const sum = times.reduce((a, b) => a + b.ms, 0);
    const lSum = longTimes.reduce((a, b) => a + b.ms, 0);
    out.batches.a2 = { segs: times, longSegs: longTimes, avgMs: Math.round(sum / times.length), minMs: Math.min(...times.map(t => t.ms)), maxMs: Math.max(...times.map(t => t.ms)), longAvgMs: Math.round(lSum / longTimes.length), longMaxMs: Math.max(...longTimes.map(t => t.ms)), gpuUtilDuring: gm.util };
    out.conclusions.push(`A2 批量合成: 短文 ${times.length} 段平均 ${out.batches.a2.avgMs}ms/段(峰值 ${out.batches.a2.maxMs}ms); 长文 ${longTimes.length} 段平均 ${out.batches.a2.longAvgMs}ms/段(峰值 ${out.batches.a2.longMaxMs}ms); 期间 GPU 利用率 ${gm.util === null ? "无nvidia-smi" : gm.util + "%"}`);
  } catch (e) { out.batches.a2 = { err: String(e).slice(0, 80) }; }
  // B 端到端(5 批 × 2 段): 走真实 speak 路径 — GM 像实际说话一样(创建聊天消息 → speak 合成 → flags 内嵌
  // → data URI 播放 + playAudio 广播 → pl 端通用 hook 真实播放 + 回执)。与实际使用 100% 同一代码(测试=实际)。
  try {
    window.__fvttTTSAcks = [];
    const batches = [];
    for (let bi = 1; bi <= 5; bi++) {
      const b0 = Date.now();
      for (let si = 0; si < 2; si++) {
        const txt = (bi >= 4) ? "长文传输带宽测试，这一段用长文本测试大文件在玩家与主持人之间的传输速度，多句台词连续拼接，音频文件体积更大，用于对比小文件与大文件的真实带宽表现，句子越长传输数据越多，可以更清楚地看出隧道环境下的传输瓶颈，帮助判断音频码率与压缩策略是否合适，作为传输测试的大文件对照样本。" : `传输批次${bi}段${si + 1}`;
        let cm0 = null;
        try {
          cm0 = await ChatMessage.create({
            content: `[🚄真实说话 批次${bi} 段${si + 1}${bi >= 4 ? "(长文)" : ""}] ${txt}`,
            speaker: { alias: "速度测试" },
            flags: { [MODULE]: { speedTest: { batch: bi, seg: si, ts: Date.now() } } }
          });
        } catch (e) { cm0 = null; }
        const tS = Date.now();
        try {
          // 真实 speak(与 GM 说话同一函数: 合成 + data URI 播放 + flags 内嵌写回 + playAudio 广播)
          // 情绪交替(偶数段带 0.5 语气混合, 贴合实际语气变化; 跳 LLM 情绪判定保合成路径纯测试)
          const emo = (si % 2 === 1) ? 0.5 : null;
          const spk = await speak(txt, { messageId: (cm0 && cm0.id) || "", broadcast: true, skipAiEmotion: true, emotionMix: emo });
          // 双保险: 确保 audioData 已写回消息(pl 端收到即播; speak 内部已写, 此处补验防同步竞态)
          try {
            if (cm0 && cm0.id) {
              const cmF = (cm0.flags && cm0.flags[MODULE]) || {};
              if (!cmF.audioData) {
                const ckF = `${txt}|${"zh"}|${makeWatchKey()}`;
                const ccF = _synthCache.get(ckF) || null;
                if (ccF && ccF.blob && ccF.blob.size > 0 && ccF.blob.size <= 300000) {
                  const bF = await blobToBase64(ccF.blob);
                  if (bF && bF.length < 400000 && _canWrite()) cm0.update({ "flags.gpt-sovits-tts.audioData": "data:audio/mpeg;base64," + bF }).catch(() => { /* noop */ });
                }
              }
            }
          } catch (e) { /* noop */ }
          out.batches[`b${bi}s${si}`] = { realPath: "speak", emotionMix: emo, synthMs: Date.now() - tS, ok: !!spk, gmPlayed: !!spk, createdMs: cm0 ? Date.now() - b0 : null };
        } catch (e) { out.batches[`b${bi}s${si}`] = { realPath: "speak", err: String(e).slice(0, 80) }; }
      }
      await new Promise(res => setTimeout(res, bi >= 4 ? 8000 : 6000));   // 等本批 pl 真实路径回执(pl 端延迟回执 6s; 长文批大内嵌 DB 同步慢, 再多等)
      const acks = (window.__fvttTTSAcks || []).filter(a => a.batch === bi);
      batches.push({ batch: bi, totalMs: Date.now() - b0, ackCount: acks.length, ackFetchMs: acks.map(a => a.fetchMs) });
    }
    out.batches.b = batches;
    const totalAck = batches.reduce((a, b) => a + b.ackCount, 0);
    out.conclusions.push(`B 端到端(真实 speak 路径): 5 批 10 段(短文×6+长文×4), pl 回执 ${totalAck}/10; 与实际说话同一代码(合成/内嵌/广播/播放)`);
  } catch (e) { out.batches.b = { err: String(e).slice(0, 80) }; }
  // P 代理端到端(玩家说话路径): GM 构造玩家消息(synthRequest) → 走 _proxySynthFor 同一函数
  // (合成 + flags audioData 写回) → pl 端 updateChatMessage 真实播放 + 延迟回执 —
  // 与实际 pl 发消息被 GM 代理完全一致(同函数/同写回/同播放 hook)
  try {
    const pText = "玩家代理路径测试：这句由主持人代理合成后全员听到。";
    const tP = Date.now();
    const pMsg = await ChatMessage.create({
      content: `[🚄玩家说话] ${pText}`,
      speaker: { alias: "Player2" },
      flags: { [MODULE]: { synthRequest: { text: pText, lang: "zh", provider: "gpt-sovits" }, role: "五条悟", speedTest: { proxy: true, batch: 6, seg: 0, ts: Date.now() } } }
    });
    const res = await _proxySynthFor(pMsg);
    out.proxy = { realPath: "proxy", proxyMs: (res && res.ms) || (Date.now() - tP), ok: !!(res && res.ok), flagsWritten: !!(res && res.flagsWritten), err: (res && res.err) || "" };
    out.conclusions.push(`P 代理端到端(玩家说话路径): 代理合成+写回 ${out.proxy.proxyMs}ms${out.proxy.ok ? " ✓" : " ✗"} (flags 写回 ${out.proxy.flagsWritten ? "✓" : "✗"})`);
  } catch (e) { out.proxy = { realPath: "proxy", err: String(e).slice(0, 80) }; }
  // D 多角度扩展(加载/并发/引擎/配置同步)
  // D6 池上限配置同步(GM 改上限 → 服务端 /config 生效 → 恢复)
  try {
    const st0c = await getJ("/status");
    const origMax = (st0c.pool && st0c.pool.max) || 10;
    const want = Math.max(1, Math.min(3, origMax));
    await api("/config", { max_concurrent_models: want });
    const stC = await getJ("/status");
    const newMax = (stC.pool && stC.pool.max) || null;
    await api("/config", { max_concurrent_models: origMax });
    const stR = await getJ("/status");
    const restMax = (stR.pool && stR.pool.max) || null;
    out.batches.d6 = { origMax, setTo: want, syncedMax: newMax, restoredMax: restMax, ok: newMax === want && restMax === origMax };
    out.conclusions.push(`D6 池上限同步: ${origMax}→${want} 生效=${newMax} 恢复=${restMax}${out.batches.d6.ok ? " ✓" : " ✗"}`);
  } catch (e) { out.batches.d6 = { err: String(e).slice(0, 80) }; }
  // D5 并发合成排队(3 并发: 单 worker 串行 → 排队延迟)
  try {
    const t0 = Date.now();
    const rs = await Promise.all([
      gptSovitsSynth("并发测试第一条", "zh", { serverUrl: cfg.serverUrl, speedFactor: 1.0, mediaType: "mp3", asBlob: true, role: poolChar }),
      gptSovitsSynth("并发测试第二条", "zh", { serverUrl: cfg.serverUrl, speedFactor: 1.0, mediaType: "mp3", asBlob: true, role: poolChar }),
      gptSovitsSynth("并发测试第三条", "zh", { serverUrl: cfg.serverUrl, speedFactor: 1.0, mediaType: "mp3", asBlob: true, role: poolChar })
    ]);
    const allMs = Date.now() - t0;
    const oneMs = (out.batches.a2 && out.batches.a2.avgMs) || 900;
    out.batches.d5 = { concurrent: 3, allMs, oneSeqMs: oneMs, queueOverheadMs: Math.max(0, allMs - oneMs), allOk: rs.every(r => !!(r && r.audioUrl)) };
    out.conclusions.push(`D5 并发排队: 3 并发总 ${allMs}ms(单段约 ${oneMs}ms, 排队开销 ${Math.max(0, allMs - oneMs)}ms)${out.batches.d5.allOk ? " 全部成功" : " 有失败"}`);
  } catch (e) { out.batches.d5 = { err: String(e).slice(0, 80) }; }
  // D1 多角色池加载对比(依次 3 角色 → 验证多模型并行 + 显存占用)
  try {
    const cd = (quickChars && quickChars.chars) || [];
    const st0d = await getJ("/status");
    const act = (st0d.character && st0d.character.name) || "";
    const others = cd.filter(x => x.name && x.name !== act).slice(0, 3);
    const loads = [];
    for (const c of others) {
      const t0 = Date.now();
      const r = await gptSovitsSynth("多角色加载测试", "zh", { serverUrl: cfg.serverUrl, speedFactor: 1.0, mediaType: "mp3", asBlob: true, role: c.name });
      loads.push({ role: c.name, ms: Date.now() - t0, ok: !!(r && r.audioUrl) });
    }
    const st1d = await getJ("/status");
    out.batches.d1 = { loads, poolAfter: st1d.pool, gpuFreeGb: (st1d.hw && st1d.hw.gpu_mem_free_gb) };
    out.conclusions.push(`D1 多角色加载: [${loads.map(l => l.role + ":" + l.ms + "ms").join(", ")}], 池 ${st1d.pool.size}/${st1d.pool.max}, 显存空闲 ${out.batches.d1.gpuFreeGb}GB`);
  } catch (e) { out.batches.d1 = { err: String(e).slice(0, 80) }; }
  // D2 引擎切换对比(gpt-sovits vs edge vs web 同文本)
  if (fullMode) try {
    const outE = {};
    const t0 = Date.now();
    const rg = await gptSovitsSynth("引擎切换对比测试", "zh", { serverUrl: cfg.serverUrl, speedFactor: 1.0, mediaType: "mp3", asBlob: true, role: poolChar });
    outE.gpt = { ms: Date.now() - t0, bytes: (rg && rg.blob && rg.blob.size) || 0, ok: !!(rg && rg.audioUrl) };
    try {
      const te = Date.now();
      const re = await synthEdge("引擎切换对比测试", "zh", { serverUrl: cfg.serverUrl, speedFactor: 1.0, asBlob: true });
      outE.edge = { ms: Date.now() - te, ok: !!(re && (re.ok || re.audioUrl)), bytes: (re && re.blob && re.blob.size) || 0 };
    } catch (e) { outE.edge = { err: String(e).slice(0, 60) }; }
    try {
      const tw = Date.now();
      const okw = await webSpeechSpeak("引擎切换对比测试", { lang: "zh-CN", rate: 1.0, volume: 0.5 });
      outE.web = { ms: Date.now() - tw, ok: !!okw, note: "浏览器本地 TTS, 不占服务端" };
    } catch (e) { outE.web = { err: String(e).slice(0, 60) }; }
    out.batches.d2 = outE;
    out.conclusions.push(`D2 引擎对比: gpt=${outE.gpt && outE.gpt.ms}ms/${outE.gpt && outE.gpt.bytes}B; edge=${outE.edge && (outE.edge.ms || outE.edge.err || "-")}ms; web=${outE.web && (outE.web.ms || outE.web.err || "-")}ms(浏览器本地)`);
  } catch (e) { out.batches.d2 = { err: String(e).slice(0, 80) }; }
  // C bug 回归(本轮修的)
  // C1 纯数字逐位: 12345 → 服务端转一二三四五(合成成功即路径可用, 请求日志可核 text)
  try {
    const t0 = Date.now();
    const r = await gptSovitsSynth("12345", "zh", { serverUrl: cfg.serverUrl, speedFactor: 1.0, mediaType: "mp3", asBlob: true });
    out.bugs.digit = { ok: !!(r && r.audioUrl), ms: Date.now() - t0, note: "服务端已转为一二三四五(tts-requests.log text 字段可核)" };
  } catch (e) { out.bugs.digit = { err: String(e).slice(0, 80) }; }
  // C2 多模型池状态
  try { const st2 = await getJ("/status"); out.bugs.pool = st2.pool; } catch (e) { out.bugs.pool = { err: String(e).slice(0, 80) }; }
  // C3 全局静音抑制: 静音时播放应被 audioPlay 提前跳过(计数不增); try/finally 保证恢复设置, 防残留全员静音
  try {
    const before = window.__fvttTTSPlayCount || 0;
    const wasMute = !!game.settings.get(MODULE, "gmMute");
    try {
      if (game.user && game.user.isGM) { await game.settings.set(MODULE, "gmMute", true); await new Promise(r => setTimeout(r, 700)); }
      const t0 = Date.now();
      try { await audioPlay("data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0AAAAAKcGxheXRlcg==", { volume: 0 }); } catch (e) { /* noop */ }
      await new Promise(r => setTimeout(r, 600));
      const delta = (window.__fvttTTSPlayCount || 0) - before;
      out.bugs.mute = { ok: delta === 0, delta, note: "静音时 audioPlay 提前跳过(新增播放应 0)" };
      out.conclusions.push(`C3 全局静音: ${delta === 0 ? "抑制生效" : "异常(新增播放 " + delta + ")"}`);
    } finally {
      if (game.user && game.user.isGM) { await game.settings.set(MODULE, "gmMute", wasMute); await new Promise(r => setTimeout(r, 700)); }
    }
  } catch (e) { out.bugs.mute = { err: String(e).slice(0, 80) }; }
  // C4 播放计数/去重回归: 记录本页累计播放计数(重复播放修复后每消息只播一次, 计数供对照)
  try { out.bugs.playCount = { total: window.__fvttTTSPlayCount || 0, note: "重复播放修复: speak/预载/flags/广播四条路径统一 playedIds 去重(每消息一次)" }; } catch (e) { out.bugs.playCount = { err: String(e).slice(0, 60) }; }
  // E 语种切换(中/日/英)
  // E1 多语种合成矩阵(同结构文本)
  try {
    const e1s = [
      { lang: "zh", txt: "今天的天气真不错呢" },
      { lang: "ja", txt: "今日の天気は本当にいいですね" },
      { lang: "en", txt: "The weather is really nice today" }
    ];
    const e1 = [];
    for (const s of e1s) {
      const t0 = Date.now();
      try {
        const r = await gptSovitsSynth(s.txt, s.lang, { serverUrl: cfg.serverUrl, speedFactor: 1.0, mediaType: "mp3", asBlob: true, role: poolChar });
        e1.push({ lang: s.lang, ok: !!(r && r.audioUrl), ms: Date.now() - t0, bytes: (r && r.blob && r.blob.size) || 0 });
      } catch (e) { e1.push({ lang: s.lang, ok: false, err: String(e).slice(0, 50) }); }
    }
    out.batches.e1 = e1;
    out.conclusions.push(`E1 语种矩阵: ` + e1.map(x => `${x.lang}=${x.ok ? x.ms + "ms/" + Math.round(x.bytes / 1024) + "KB" : "失败"}`).join(" "));
  } catch (e) { out.batches.e1 = { err: String(e).slice(0, 80) }; }
  // E2 语种混合(中英日一句, auto 自动识别)
  try {
    const t0 = Date.now();
    const r = await gptSovitsSynth("天气真不错，日本語のテストです，This is a mixed test", "auto", { serverUrl: cfg.serverUrl, speedFactor: 1.0, mediaType: "mp3", asBlob: true, role: poolChar });
    out.batches.e2 = { ok: !!(r && r.audioUrl), ms: Date.now() - t0, bytes: (r && r.blob && r.blob.size) || 0 };
    out.conclusions.push(`E2 混合语种(auto): ${out.batches.e2.ok ? out.batches.e2.ms + "ms/" + Math.round(out.batches.e2.bytes / 1024) + "KB" : "失败"}`);
  } catch (e) { out.batches.e2 = { err: String(e).slice(0, 80) }; }
  // E3 数字跨语种: zh 转逐位 / en ja 保持数值读法(服务端只转中文语境)
  try {
    const e3 = [];
    for (const lang of ["zh", "en", "ja"]) {
      const t0 = Date.now();
      const r = await gptSovitsSynth("12345", lang, { serverUrl: cfg.serverUrl, speedFactor: 1.0, mediaType: "mp3", asBlob: true, role: poolChar });
      e3.push({ lang, ok: !!(r && r.audioUrl), ms: Date.now() - t0, note: lang === "zh" ? "服务端转一二三四五" : "保持数值读法" });
    }
    out.batches.e3 = e3;
    out.conclusions.push(`E3 数字跨语种: ` + e3.map(x => `${x.lang}=${x.ok ? x.ms + "ms" : "✗"}`).join(" "));
  } catch (e) { out.batches.e3 = { err: String(e).slice(0, 80) }; }
  // E4 长文×语种(压 GPU: 日语/英语长文)
  try {
    const e4s = [
      { lang: "ja", txt: "日本語の長文テストを続けます、複数の文を繋げて、より長い時間かけて推論能力を確認します、この部分は日本語の音声合成の長文性能を検証するために使います、文を重ねるほど処理時間が伸びるはずです。" },
      { lang: "en", txt: "This is a longer English text for testing long text synthesis performance, multiple sentences joined together to keep the GPU busy for a longer period, verifying how the engine handles extended English content, the longer the text the longer the processing time." }
    ];
    const e4 = [];
    for (const s of e4s) {
      const t0 = Date.now();
      const r = await gptSovitsSynth(s.txt, s.lang, { serverUrl: cfg.serverUrl, speedFactor: 1.0, mediaType: "mp3", asBlob: true, role: poolChar });
      e4.push({ lang: s.lang, ok: !!(r && r.audioUrl), ms: Date.now() - t0, bytes: (r && r.blob && r.blob.size) || 0 });
    }
    out.batches.e4 = e4;
    out.conclusions.push(`E4 长文×语种: ` + e4.map(x => `${x.lang}=${x.ok ? x.ms + "ms/" + Math.round(x.bytes / 1024) + "KB" : "✗"}`).join(" "));
  } catch (e) { out.batches.e4 = { err: String(e).slice(0, 80) }; }
  // F 语气/情绪
  // F1 情绪合成矩阵(同文本不同 emotionMix)
  try {
    const emos = [
      { name: "中性", mix: null },
      { name: "开心", mix: 0.3 },
      { name: "悲伤", mix: 0.6 },
      { name: "生气", mix: 0.9 }
    ];
    const f1 = [];
    for (const em of emos) {
      const ov = {};
      if (em.mix !== null) ov.emotionMix = em.mix;
      const t0 = Date.now();
      const r = await gptSovitsSynth("今天真是个好日子啊", "zh", { serverUrl: cfg.serverUrl, speedFactor: 1.0, mediaType: "mp3", asBlob: true, role: poolChar, overrides: ov });
      f1.push({ emo: em.name, mix: em.mix, ok: !!(r && r.audioUrl), ms: Date.now() - t0, bytes: (r && r.blob && r.blob.size) || 0 });
    }
    out.batches.f1 = f1;
    out.conclusions.push(`F1 情绪矩阵: ` + f1.map(x => `${x.emo}(${x.mix})=${x.ok ? x.ms + "ms/" + Math.round(x.bytes / 1024) + "KB" : "✗"}`).join(" "));
  } catch (e) { out.batches.f1 = { err: String(e).slice(0, 80) }; }
  // F2 语气词/感叹(是否自然处理符号与语气词)
  try {
    const t0 = Date.now();
    const r = await gptSovitsSynth("哇！今天真的太棒了吧～？嗯…好吧，那就这样啦！", "zh", { serverUrl: cfg.serverUrl, speedFactor: 1.0, mediaType: "mp3", asBlob: true, role: poolChar });
    out.batches.f2 = { ok: !!(r && r.audioUrl), ms: Date.now() - t0, bytes: (r && r.blob && r.blob.size) || 0 };
    out.conclusions.push(`F2 语气词/感叹: ${out.batches.f2.ok ? out.batches.f2.ms + "ms/" + Math.round(out.batches.f2.bytes / 1024) + "KB" : "✗"}`);
  } catch (e) { out.batches.f2 = { err: String(e).slice(0, 80) }; }
  // G 语音模型切换
  // G1 多角色连续切换(取 5 角色池扩容: 每角色加载/命中耗时 + 池显存)
  try {
    const cd = (quickChars && quickChars.chars) || [];
    const g1s = cd.filter(x => x.name).slice(0, 5);
    const g1 = [];
    for (const c of g1s) {
      const t0 = Date.now();
      const r = await gptSovitsSynth("模型切换测试", "zh", { serverUrl: cfg.serverUrl, speedFactor: 1.0, mediaType: "mp3", asBlob: true, role: c.name });
      g1.push({ role: c.name, ok: !!(r && r.audioUrl), ms: Date.now() - t0 });
    }
    const stG = await getJ("/status");
    out.batches.g1 = { roles: g1, poolAfter: stG.pool, gpuFreeGb: (stG.hw && stG.hw.gpu_mem_free_gb) };
    out.conclusions.push(`G1 多角色切换: [${g1.map(x => x.role + "=" + (x.ok ? x.ms + "ms" : "✗")).join(", ")}], 池 ${stG.pool.size}/${stG.pool.max} 显存空闲${out.batches.g1.gpuFreeGb}GB`);
  } catch (e) { out.batches.g1 = { err: String(e).slice(0, 80) }; }
  // G2 角色往返切换(A→B→A: 复用 vs 重载)
  try {
    const cd = (quickChars && quickChars.chars) || [];
    const rA = cd.filter(x => x.name)[0];
    const rB = cd.filter(x => x.name && x.name !== (rA && rA.name))[0];
    if (rA && rB) {
      const g2 = [];
      for (const role of [rA.name, rB.name, rA.name]) {
        const t0 = Date.now();
        const r = await gptSovitsSynth("往返切换测试", "zh", { serverUrl: cfg.serverUrl, speedFactor: 1.0, mediaType: "mp3", asBlob: true, role });
        g2.push({ role, ms: Date.now() - t0, ok: !!(r && r.audioUrl) });
      }
      out.batches.g2 = g2;
      out.conclusions.push(`G2 往返切换: ` + g2.map(x => `${x.role}:${x.ms}ms`).join(" ") + `${g2[2].ms < 3000 ? " ✓(末段池命中复用)" : " (末段重载)"}`);
    } else { out.batches.g2 = { err: "角色不足" }; }
  } catch (e) { out.batches.g2 = { err: String(e).slice(0, 80) }; }
  // G3 参考音频切换(同一模型不同 ref 音色 → 耗时/音频变化)
  if (fullMode) try {
    const cd = (quickChars && quickChars.chars) || [];
    const cur = cd.find(x => x.name === poolChar) || cd[0];
    const other = cd.find(x => x.name && x.name !== (cur && cur.name));
    const g3 = [];
    if (cur) {
      const t0 = Date.now();
      const r = await gptSovitsSynth("参考音频切换测试", "zh", { serverUrl: cfg.serverUrl, speedFactor: 1.0, mediaType: "mp3", asBlob: true, role: cur.name });
      g3.push({ ref: "默认ref", ok: !!(r && r.audioUrl), ms: Date.now() - t0, bytes: (r && r.blob && r.blob.size) || 0 });
    }
    if (other && other.ref) {
      const t0 = Date.now();
      const r = await gptSovitsSynth("参考音频切换测试", "zh", { serverUrl: cfg.serverUrl, speedFactor: 1.0, mediaType: "mp3", asBlob: true, role: cur ? cur.name : "", overrides: { refAudioPath: other.ref } });
      g3.push({ ref: other.name + "的ref", ok: !!(r && r.audioUrl), ms: Date.now() - t0, bytes: (r && r.blob && r.blob.size) || 0 });
    }
    out.batches.g3 = g3;
    out.conclusions.push(`G3 参考音频切换: ` + g3.map(x => `${x.ref}=${x.ok ? x.ms + "ms/" + Math.round(x.bytes / 1024) + "KB" : "✗"}`).join(" "));
  } catch (e) { out.batches.g3 = { err: String(e).slice(0, 80) }; }
  // G4 引擎×语种矩阵(gpt/edge/web × zh/ja/en)
  if (fullMode) try {
    const texts = { zh: "今天是美好的日子", ja: "今日は素晴らしい日です", en: "Today is a wonderful day" };
    const g4 = [];
    for (const lang of ["zh", "ja", "en"]) {
      try {
        const t0 = Date.now();
        const r = await gptSovitsSynth(texts[lang], lang, { serverUrl: cfg.serverUrl, speedFactor: 1.0, mediaType: "mp3", asBlob: true, role: poolChar });
        g4.push({ engine: "gpt", lang, ok: !!(r && r.audioUrl), ms: Date.now() - t0 });
      } catch (e) { g4.push({ engine: "gpt", lang, ok: false, err: String(e).slice(0, 40) }); }
      try {
        const t0 = Date.now();
        const re = await synthEdge(texts[lang], lang, { serverUrl: cfg.serverUrl, speedFactor: 1.0, asBlob: true });
        g4.push({ engine: "edge", lang, ok: !!(re && (re.ok || re.audioUrl)), ms: Date.now() - t0 });
      } catch (e) { g4.push({ engine: "edge", lang, ok: false, err: String(e).slice(0, 40) }); }
      try {
        const t0 = Date.now();
        const okw = await webSpeechSpeak(texts[lang], { lang: lang === "zh" ? "zh-CN" : lang === "ja" ? "ja-JP" : "en-US", rate: 1.0, volume: 0.3 });
        g4.push({ engine: "web", lang, ok: !!okw, ms: Date.now() - t0 });
      } catch (e) { g4.push({ engine: "web", lang, ok: false, err: String(e).slice(0, 40) }); }
    }
    out.batches.g4 = g4;
    out.conclusions.push(`G4 引擎×语种: ` + g4.map(x => `${x.engine}-${x.lang}=${x.ok ? x.ms + "ms" : "✗"}`).join(" "));
  } catch (e) { out.batches.g4 = { err: String(e).slice(0, 80) }; }
  // H 文本与参数
  // H1 文本长度梯度(10/50/100/200/400 字: 耗时曲线)
  if (fullMode) try {
    const lens = [10, 50, 100, 200, 400];
    const h1 = [];
    for (const n of lens) {
      const txt = ("这是长度梯度测试文本，用于观察合成耗时随文本长度的变化趋势，句子不断累加。").repeat(14).slice(0, n);
      const t0 = Date.now();
      const r = await gptSovitsSynth(txt, "zh", { serverUrl: cfg.serverUrl, speedFactor: 1.0, mediaType: "mp3", asBlob: true, role: poolChar });
      h1.push({ len: n, ok: !!(r && r.audioUrl), ms: Date.now() - t0, bytes: (r && r.blob && r.blob.size) || 0 });
    }
    out.batches.h1 = h1;
    out.conclusions.push(`H1 长度梯度: ` + h1.map(x => `${x.len}字=${x.ok ? x.ms + "ms" : "✗"}`).join(" "));
  } catch (e) { out.batches.h1 = { err: String(e).slice(0, 80) }; }
  // H2 语速梯度(0.8/1.0/1.2/1.5: 音频大小/耗时)
  if (fullMode) try {
    const speeds = [0.8, 1.0, 1.2, 1.5];
    const h2 = [];
    for (const sp of speeds) {
      const t0 = Date.now();
      const r = await gptSovitsSynth("语速梯度测试文本", "zh", { serverUrl: cfg.serverUrl, speedFactor: sp, mediaType: "mp3", asBlob: true, role: poolChar });
      h2.push({ speed: sp, ok: !!(r && r.audioUrl), ms: Date.now() - t0, bytes: (r && r.blob && r.blob.size) || 0 });
    }
    out.batches.h2 = h2;
    out.conclusions.push(`H2 语速梯度: ` + h2.map(x => `${x.speed}=${x.ok ? x.ms + "ms/" + Math.round(x.bytes / 1024) + "KB" : "✗"}`).join(" "));
  } catch (e) { out.batches.h2 = { err: String(e).slice(0, 80) }; }
  // H3 格式对比(mp3/wav: 大小与合成差异)
  if (fullMode) try {
    const h3 = [];
    for (const fmt of ["mp3", "wav"]) {
      const t0 = Date.now();
      const r = await gptSovitsSynth("格式对比测试文本", "zh", { serverUrl: cfg.serverUrl, speedFactor: 1.0, mediaType: fmt, asBlob: true, role: poolChar });
      h3.push({ fmt, ok: !!(r && r.audioUrl), ms: Date.now() - t0, bytes: (r && r.blob && r.blob.size) || 0 });
    }
    out.batches.h3 = h3;
    out.conclusions.push(`H3 格式对比: ` + h3.map(x => `${x.fmt}=${x.ok ? x.ms + "ms/" + Math.round(x.bytes / 1024) + "KB" : "✗"}`).join(" "));
  } catch (e) { out.batches.h3 = { err: String(e).slice(0, 80) }; }
  // I 稳定性
  // I2 连续长跑(20 段短文本: 速度漂移 + 显存泄漏检测)
  if (fullMode) try {
    const g0 = await getJ("/status");
    const mem0 = (g0.hw && g0.hw.gpu_mem_free_gb);
    const times = [];
    for (let i = 0; i < 20; i++) {
      const t0 = Date.now();
      const r = await gptSovitsSynth(`连续长跑第${i + 1}段`, "zh", { serverUrl: cfg.serverUrl, speedFactor: 1.0, mediaType: "mp3", asBlob: true, role: poolChar });
      if (r && r.audioUrl) times.push(Date.now() - t0);
    }
    const g1 = await getJ("/status");
    const mem1 = (g1.hw && g1.hw.gpu_mem_free_gb);
    const avgAll = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
    const avgFirst5 = Math.round(times.slice(0, 5).reduce((a, b) => a + b, 0) / 5);
    const avgLast5 = Math.round(times.slice(-5).reduce((a, b) => a + b, 0) / 5);
    out.batches.i2 = { count: times.length, avgAllMs: avgAll, avgFirst5Ms: avgFirst5, avgLast5Ms: avgLast5, driftMs: avgLast5 - avgFirst5, memFreeBefore: mem0, memFreeAfter: mem1 };
    out.conclusions.push(`I2 连续长跑: 20 段均值 ${avgAll}ms, 前5 ${avgFirst5}→后5 ${avgLast5}(漂移${avgLast5 - avgFirst5}ms), 显存 ${mem0}→${mem1}GB${(mem1 !== null && mem0 !== null && mem1 < mem0 - 0.3) ? " ⚠显存下降(疑似泄漏)" : ""}`);
  } catch (e) { out.batches.i2 = { err: String(e).slice(0, 80) }; }
  // I3 服务端 API 往返延迟采样(/status 5 次 RTT)
  if (fullMode) try {
    const rtts = [];
    for (let i = 0; i < 5; i++) {
      const t0 = Date.now();
      try { await getJ("/status"); rtts.push(Date.now() - t0); } catch (e) { rtts.push(-1); }
    }
    out.batches.i3 = { rtts, avgMs: Math.round(rtts.filter(x => x >= 0).reduce((a, b) => a + b, 0) / Math.max(1, rtts.filter(x => x >= 0).length)) };
    out.conclusions.push(`I3 API 往返: /status RTT 均值 ${out.batches.i3.avgMs}ms(5 次)`);
  } catch (e) { out.batches.i3 = { err: String(e).slice(0, 80) }; }
  // S1 合成缓存命中(问题项: 服务器合成长尾/重复合成): 同文本连发两次 /tts,
  // 读 X-Fvtt-Cache 头判定二次是否命中(走 socket 代理, https 页面也可测)。
  try {
    const cacheText = "语音合成缓存验证，同样的句子再合一次。" + (Date.now() % 90000 + 10000);
    const mk = () => ({ text: cacheText, text_lang: "zh", speed_factor: 1.0, streaming_mode: false, media_type: "mp3", allow_short_ref: true });
    const doT = async () => {
      const t0 = Date.now();
      const r = await svcRequest(getCfg().serverUrl, "POST", "/tts", mk(), { timeoutMs: 90000 });
      return { ok: r.ok, ms: Date.now() - t0, cache: r.cache || "miss", url: r.audioUrl || "" };
    };
    const r1 = await doT();
    const r2 = await doT();
    // 命中判定: 缓存命中会复用同一段 audio url(必同); 头亦可读 X-Fvtt-Cache(已暴露给跨源)
    const sameUrl = !!(r1.url && r2.url && r1.url === r2.url && r1.ok && r2.ok);
    const hit = sameUrl || (r1.ok && r2.ok && r2.cache === "hit");
    out.batches.s1 = { firstMs: r1.ms, secondMs: r2.ms, c1: r1.cache, c2: r2.cache, sameUrl, cacheHit: hit };
    out.conclusions.push(`S1 合成缓存: 首次 ${r1.ms}ms(${r1.cache}) → 二次 ${r2.ms}ms(${r2.cache})${hit ? " ✓命中(缓存生效, 重复台词秒回)" : " (未命中)"}`);
  } catch (e) { out.batches.s1 = { err: String(e).slice(0, 80) }; }
  // pl 回执明细并入 GM 报告(pl 经 Foundry socket 回执, GM 提交时合并 → 一次读全)
  try { out.plAcks = window.__fvttTTSAcks || []; } catch (e) { out.plAcks = []; }
  // 双端播放验证汇总: GM 端/pl 端各播放了多少段(每段一次, 验证双方都能正常听到且不重复)
  try {
    const gmPlayed = Object.keys(out.batches).filter(k => /^b\d+s\d+$/.test(k) && out.batches[k].gmPlayed === true).length;
    const plPlayed = (out.plAcks || []).filter(a => a.played === true).length;
    out.playback = { gmPlayed, plPlayed, expect: 10 };
    out.conclusions.push(`双端播放验证: GM ${gmPlayed}/10 段, pl ${plPlayed}/10 段(每段一次不重复; 未播段 = 静音跳过或播放失败)`);
  } catch (e) { /* noop */ }
  // 🔊 官方内部通道 vs DB 兜底 使用统计(问题项: 确认"官方即时主链"是否命中; 只有官方命中才是真·即时且不重复)
  try {
    const byVia = { official: 0, db: 0, url: 0 };
    ((out.plAcks || [])).forEach(a => { const v = a.via || (a.fetchMs >= 0 ? "url" : "db"); if (byVia[v] != null) byVia[v]++; else byVia.db++; });
    out.channelUsage = byVia;
    out.conclusions.push(`通道统计: 官方内部通道=${byVia.official} 段 | DB 内嵌=${byVia.db} | 拉取=${byVia.url}${byVia.official ? " (官方即时=pgm/pl 主链, DB 仅兜底, 不重复)" : " (官方未命中, pl 走DB兜底; 仍能听到, 但非即时官方 — 请确认 frp 证书受信)"}`);
  } catch (e) { /* noop */ }
  // 🖼️ 立绘注入验证(问题项: 远程端立绘由相对路径404 → 绝对 Foundry 静态地址)
  try {
    const avEl = document.querySelector(".fvtt-tts-emotion-avatar");
    const avSrc = avEl ? String(avEl.getAttribute("src") || "") : "";
    out.portrait = { injectedOnPage: document.querySelectorAll(".fvtt-tts-emotion-avatar").length, urlMode: avSrc ? (/^https?:\/\//i.test(avSrc) ? "absolute" : "relative") : "no-avatar" };
    out.conclusions.push(`立绘注入: 页面 ${out.portrait.injectedOnPage} 张, URL=${out.portrait.urlMode}${out.portrait.urlMode === "absolute" ? " (绝对地址, 远程端可显示)" : ""}`);
  } catch (e) { /* noop */ }
  // 🔊 播放实现探针(问题项: 实际走 FVTT 官方界面通道还是原生 Audio): GM 端计数 + pl 回执 impl 逐段标注
  try {
    const cnt = { official: 0, native: 0 };
    try { const c0 = window.__fvttTTSCnt || {}; cnt.official = c0.official || 0; cnt.native = c0.native || 0; } catch (e) { /* noop */ }
    const plImpl = {};
    try { ((out.plAcks || [])).forEach(a => { const k = a.impl || "?"; plImpl[k] = (plImpl[k] || 0) + 1; }); } catch (e) { /* noop */ }
    out.channelProbe = { gm: cnt, playerImpl: plImpl };
    out.conclusions.push(`播放通道实测: GM 官方界面通道=${cnt.official} 次, 原生Audio=${cnt.native} 次; pl 回执 impl=${JSON.stringify(plImpl)}${(plImpl.official || 0) > (plImpl.native || 0) ? " (玩家端走官方界面通道)" : (plImpl.native || 0) > 0 ? " (玩家端部分走了原生Audio兜底)" : ""}`);
  } catch (e) { /* noop */ }
  // 提交报告(GM 汇总)
  out.done = true;
  try { const pr = await api("/speedtest/report", out); out.posted = pr; } catch (e) { out.postErr = String(e).slice(0, 80); }
  try { console.log("[gpt-sovits-tts] 速度测试报告:", JSON.stringify(out, null, 2)); } catch (e) { /* noop */ }
  if (ui && ui.notifications) {
    try { ui.notifications.info("🚄 速度测试完成，报告已写入 server/speed_report.json" + (out.posted ? `（${out.posted.file}）` : "")); } catch (e) { /* noop */ }
  }
  return out;
}

/* ============ 宏 API ============ */
function setupAPI() {
  game.gptSoVitsTTS = {
    speak: (text, opts) => speak(text, opts || {}),
    stop: () => stopSpeaking(),
    isSpeaking: () => queue.busy,
    setEnabled: (b) => game.settings.set(MODULE, "enabled", !!b),
    get enabled() { return getCfg().enabled; },
    status: () => statusInfo,
    checkStatus: () => checkStatus(true),
    dictate: () => toggleDictation(),
    isDictating: () => !!(window.__fvttTTSDictation && window.__fvttTTSDictation.active),
    openVoiceManager: () => VoiceManager.open(),
    // 内置自检: 一键跑全部测试 → 报告写入服务端 selftest_report.json
    // 1.5.0 全面测试套件(28场景, 含并发/压力/异常/多角色多语气) — 取代旧测试
    runSelfTest: () => { try { return (window.__fvttTTSTests && window.__fvttTTSTests.runAuto()) || Promise.resolve(); } catch (e) { return Promise.resolve(); } },
    runStressTest: () => { try { return (window.__fvttTTSTests && window.__fvttTTSTests.runGmSuite()) || Promise.resolve(); } catch (e) { return Promise.resolve(); } },
    runSpeedTest: () => { try { return (window.__fvttTTSTests && window.__fvttTTSTests.runGmSuite()) || Promise.resolve(); } catch (e) { return Promise.resolve(); } },
    runPlayerSelfTest: () => { try { return (window.__fvttTTSTests && window.__fvttTTSTests.runPlayerSuite()) || Promise.resolve(); } catch (e) { return Promise.resolve(); } },
    runTests: (which) => { try { const t = window.__fvttTTSTests; if (!t) return Promise.resolve(); return which === "gm" ? t.runGmSuite() : which === "player" ? t.runPlayerSuite() : t.runAuto(); } catch (e) { return Promise.resolve(); } },
    // 语音运行者服务声明列表(供语音管理器 GM 分配面板使用)
    getRunners: () => {
      const out = [];
      try { runnerList.forEach((v, u) => out.push({ url: u, by: String(v && v.by || "玩家"), gm: !!(v && v.gm) })); } catch (e) { /* noop */ }
      return out;
    },
    queue
  };
  game.fvtttts = game.gptSoVitsTTS;
  console.log("[gpt-sovits-tts] 就绪。可用: game.gptSoVitsTTS.speak(text) / .stop() / .dictate() / .status()");
}

/* ============ Hooks ============ */
Hooks.once("init", async () => {
  await ensureZhDict(); // 先加载中文兜底词典, 再注册设置(保证设置界面始终中文)
  registerSettings();
  installRunnerAssignUI(); // 语音生成者分配器: 设置项 → "打开分配器, 列出全部账号"(仅 GM 可分配)
});

Hooks.once("ready", () => {
  setupAPI();
  // 1.6.132 强度默认 50→0(交给 AI 自己调): 只迁移"仍是旧默认 50、从未手动改过"的客户端设置;
  //   手动调过(≠50)的保持原样。每个浏览器 profile 只迁一次。
  try {
    if (Number(game.settings.get(MODULE, "styleStrength")) === 50 && window.localStorage.getItem("fvtt-tts-mig132-style0") !== "1") {
      game.settings.set(MODULE, "styleStrength", 0).catch(() => { /* noop */ });
      window.localStorage.setItem("fvtt-tts-mig132-style0", "1");
      try { console.debug("[gpt-sovits-tts] 强度默认 50→0(交给 AI 自动), 已迁移本客户端"); } catch (e) { /* noop */ }
    }
  } catch (e) { /* noop */ }
  // Foundry v13 socket: 模块 socket 中继(module.<id>) — 各端匹配响应 + GM 端执行代理(合成/代写/报告落盘)
  try { installModuleSocket(); } catch (e) { /* noop */ }
  try { installGmProxy(); } catch (e) { /* noop */ }
  // 🔬 1.5.0 场景化全面测试套件(取代旧测试按钮): 玩家套件(28场景玩家视角) + GM 综合套件(28场景全员视角)
  setTimeout(() => {   // 1.6.47 测试套件延后注册(打开世界首屏更顺, 不阻塞 ready)
    try {
      installTTSTests({
        getCfg, speak, blobToBase64, stripStageDirections, findEmotionSlot,
        loadVoiceProfile, currentVoice, cacheAudio, _modulePath, loadQuickChars,
      });
    } catch (e) { console.error("[gpt-sovits-tts] tests install failed:", e); }
  }, 800);
  // 1.6.122 引擎地址自动识别(必须在其它探测之前): 本机有引擎 → 用本机; 否则沿用 Foundry 主机
  (async () => {
    try {
      const _u = String(getCfg().serverUrl || "");
      if (_u && _u !== "auto") return;   // 用户手填了地址 → 绝对尊重
      const _probe = await fetch("http://127.0.0.1:9881/status", { signal: AbortSignal.timeout(2500) }).catch(() => null);
      if (_probe && _probe.ok === true) {
        window.__fvttTTSAutoBase = "http://127.0.0.1:9881";
        try { console.debug("[gpt-sovits-tts] 检测到本机引擎(127.0.0.1:9881) → 自动使用本机合成"); } catch (e2) { /* noop */ }
        try { checkStatus(true); } catch (e2) { /* noop */ }
      }
    } catch (e) { /* noop */ }
  })();

  // 1.6.98 注入 AI 翻译器: 有 LLM 时优先用 AI 翻译(与判语气同一把 key, 无免费 API 的 429 限流, 质量更高); 失败才退化 MyMemory
  try {
    setTranslator(async (text, from, to) => {
      try {
        const c0 = getCfg();
        if (!c0.llmEnabled || !c0.llmKey || window.__fvttTTSLlmBroken === true) return null;
        const r = await svcRequest(c0.serverUrl, "POST", "/llm/translate", {
          base: c0.llmBaseUrl || "https://api.openai.com/v1", key: c0.llmKey,
          model: c0.llmModel || "gpt-4o-mini", text: String(text || "").slice(0, 2000),
          to: String(to || "ja"), gm_prompt: "",
        }, { timeoutMs: 20000, retries: 0 });
        const j = (r && typeof r.json === "function") ? await r.json().catch(() => ({})) : {};
        if (r && r.ok && j && j.ok && j.text) return String(j.text);
      } catch (e) { /* fallthrough */ }
      return null;
    });
  } catch (e) { /* noop */ }
  // 🤖 LLM 健康预探测(1.6.59): 失败记录原因并每 60s 自动重探, 修好 base/key 自动恢复(见模块级 probeLLMOnce/armLlmReProbe)
  setTimeout(() => {
    try {
      const c0 = getCfg();
      if (!c0.llmEnabled || !c0.llmKey) return;
      probeLLMOnce().then(res => { armLlmReProbe(); if (res && res.ok) console.debug("[gpt-sovits-tts] LLM 探测通过, AI 链路可用"); });
    } catch (e) { /* noop */ }
  }, 3000);
  // 🔊 Foundry playAudio 广播监听(记录已播 src): 与 audioData DB 兜底去重(双通道合一, 防重复播放);
    // 官方内部通道(fileURL)+DB 内嵌(dataURI) src 不同, 额外登记"官方即时已播"文件 URL 集(10s)供 DB 兜底判定是否跳过
    try {
      const regPlaySrc = (s) => {
        try {
          if (s) {
            window.__fvttTTSPlayedSrcs = window.__fvttTTSPlayedSrcs || new Set();
            window.__fvttTTSPlayedSrcs.add(String(s));
            setTimeout(() => { try { window.__fvttTTSPlayedSrcs.delete(String(s)); } catch (e) { /* noop */ } }, 30000);
          }
        } catch (e) { /* noop */ }
      };
      const regOfficial = (s) => {
        try {
          const c = _modulePath(s);   // canonical 相对路径(/modules/...), 与官方广播 src 一致
          if (c) {
            window.__fvttTTSOfficialSrcs = window.__fvttTTSOfficialSrcs || new Set();
            window.__fvttTTSOfficialSrcs.add(c);
            setTimeout(() => { try { window.__fvttTTSOfficialSrcs.delete(c); } catch (e) { /* noop */ } }, 10000);
          }
        } catch (e) { /* noop */ }
      };
      const _onPlay = (d) => { const s = (d && d.src) || (typeof d === "string" ? d : ""); try { regPlaySrc(s); regOfficial(s); } catch (e) { /* noop */ } };
      Hooks.on("playAudio", _onPlay);
      Hooks.on("playSound", _onPlay);
    } catch (e) { /* noop */ }
  // 拖放入 chat 拦截(1.6.8): 大文件拖入聊天触发 FVTT 原生上传会卡爆网页(上传中/完成后);
  // 角色包(.char/.zip)拖入 → 转模块导入(任意大小, 引擎机直连不卡); 其他 ≥20MB → 拦截并提示; 小文件放行(正常上传)
  try {
    const _importCharDrop = async (file) => {
      try {
        showImportProgress("正在导入角色包", 0.01);
        // 分片导入(≤12MB 单次, 大包分片 10MB/片 — 不再单次发送几百MB body, 不丢 FVTT 连接)
        const r = await importCharPackChunked(getCfg().serverUrl, file, {
          onProgress: (p) => { try { showImportProgress("正在导入角色包", p); } catch (e) { /* noop */ } },
        });
        hideImportProgress();
        if (r.ok) { notifyOnce("角色包导入成功: " + (r.name || ""), "info"); try { refreshQuickUI(); updateCharIndicator(); } catch (e) { /* noop */ } }
        else notifyOnce("导入失败: " + (r.message || ""), "error");
      } catch (e) { hideImportProgress(); notifyOnce("导入失败: " + String((e && e.message) || e).slice(0, 120), "error"); }
    };
    const _dropFile = (e) => {
      try {
        const dt = e && e.dataTransfer;
        if (!dt || !dt.files || !dt.files.length) return;
        const tgt = e.target;
        // 仅聊天区域(兼容 v11-13 各布局): 聊天日志/聊天输入框/chat 页签; 其他区域(场景/世界/面板)不拦
        const inChat = tgt && tgt.closest && (tgt.closest("#chat-log") || tgt.closest(".chat-log") || tgt.closest("#chat") || tgt.closest(".chat-sidebar") || tgt.closest("#chat-form") || tgt.closest("#chat-controls") || tgt.closest("textarea") || tgt.closest('[data-tab="chat"]'));
        if (!inChat) return;
        const f = dt.files[0];
        const sizeMB = (f.size || 0) / 1048576;
        const ext = String(f.name || "").split(".").pop().toLowerCase();
        if (ext === "char" || ext === "zip") {
          e.preventDefault(); e.stopPropagation();
          _importCharDrop(f);
          return;
        }
        if (sizeMB >= 20) {
          e.preventDefault(); e.stopPropagation();
          notifyOnce(`文件过大(${Math.round(sizeMB)}MB): 聊天上传不支持大文件(会卡), 请缩小后重试或放入世界数据目录`, "error");
        }
      } catch (e2) { /* noop */ }
    };
    window.addEventListener("drop", _dropFile, true);    // window 捕获(最外层, 先于 Foundry 任何 drop 处理, 防吞事件)
    window.addEventListener("drop", _dropFile, false);   // 冒泡兜底(捕获被 Foundry 吞时仍可触发)
  } catch (e) { /* noop */ }
  // 1.6.22: 移除聊天框"导入角色包"📦按钮(用户要求) — 导入走拖放/附件检测/语音管理器; 保留 window 引用供附件检测复用, 并清理旧版可能已插入的按钮
  try {
    try { window.__fvttTTSImportCharDrop = _importCharDrop; } catch (e) { /* noop */ }
  } catch (e) { /* noop */ }
  try { document.querySelectorAll(".fvtt-tts-import-char-btn").forEach(b => { try { b.remove(); } catch (e) { /* noop */ } }); } catch (e) { /* noop */ }
  buildUI();
  attachTyping();
  checkStatus();
  refreshTtsDevices();
  applyHudTheme();
  applyPortraitSize();
  // 清理历史坏值: 语音分配表曾被错误存成字符串("[object Object]") → 写回干净空对象, 防止后续保存继续传染
  try {
    const _av = game.settings.get(MODULE, "voiceAssignments");
    let _avBad = false;
    try {
      if (_av && (typeof _av !== "object" || Array.isArray(_av))) _avBad = true;
      else if (_av && typeof _av === "object") {
        const _s = JSON.stringify(_av);
        if (!_s || _s === "[object Object]" || _s.startsWith('"[object Object]"')) _avBad = true;   // String 包装对象/双重序列化也判坏
      }
    } catch (e) { _avBad = true; }
    if (_avBad) game.settings.set(MODULE, "voiceAssignments", {}).catch(() => { /* noop */ });
  } catch (e) { /* noop */ }
  setInterval(() => checkStatus(false), 30000);
  refreshQuickUI();
  updateCharIndicator();
  setInterval(() => { refreshQuickUI(); }, 30000);
  // socket: 接收发言者广播的 TTS 音频(全员同声)
  if (game.socket && typeof game.socket.on === "function") { (window.__fvttTTSHooks = window.__fvttTTSHooks || {}).socketOn = true; game.socket.on(MODULE, handleSocketTts); }
  // 监听 Foundry 官方 playAudio 广播(任意端 AudioHelper.play push=true 触发): 记录 src →
  // update/create hook 收到 flags 写回时跳过(根治"官方广播 + flags 写回"双播; 官方广播经内置监听播放, 本模块只记录去重不重复播)
  if (game.socket && typeof game.socket.on === "function") {
    game.socket.on("playAudio", (data) => {
      try {
        const k = normPlayKey((data && data.src) || "");
        if (!k) return;
        window.__fvttTTSPlayedSrcs = window.__fvttTTSPlayedSrcs || new Set();
        window.__fvttTTSPlayedSrcs.add(k);
        setTimeout(() => { try { window.__fvttTTSPlayedSrcs.delete(k); } catch (e) { /* noop */ } }, 30000);
      } catch (e) { /* noop */ }
    });
  }
  // 语音运行者服务声明: 本机跑服务则定期广播(玩家中途加入也能看到)
  setTimeout(() => { announceTtsService(); }, 6000);
  setInterval(() => { announceTtsService(); }, 60000);
  // 统一可达性探测(通用架构): serverUrl /status 3s 超时 → 决定"直连合成"还是"GM 代理合成" —
  // 本机/局域网(pl 配置了地址) → 直连; HTTPS 穿透/跨网/9881 不可达/低配服务器 → 代理(全程走 FVTT 30000)
  setTimeout(() => {
    (async () => {
      try {
        const ac = new AbortController(); const _t = setTimeout(() => ac.abort(), 3000);
        let direct = false;
        // https 页面(远程 GM/玩家)直连 http 引擎必被 Mixed Content 阻止 → 直接判定代理模式, 不发起注定失败的请求(免刷屏)
        const _su = String(getCfg().serverUrl || "").trim();
        if (typeof location !== "undefined" && location.protocol === "https:" && !/^https:\/\//i.test(_su)) {
          direct = false;
        } else {
          try {
            const r = await fetch(`${getCfg().serverUrl.replace(/\/+$/, "")}/status`, { signal: ac.signal });
            direct = (r.ok === true);
          } catch (e) { direct = false; }
        }
        clearTimeout(_t);
        window.__fvttTTSCanDirect = direct;
        try { console.debug("[gpt-sovits-tts] 可达性探测: " + (direct ? "直连合成" : "GM 代理合成(走 FVTT 30000)")); } catch (e) { /* noop */ }
        try { checkStatus(true); } catch (e) { /* noop */ }   // 探测完成后刷新状态灯(代理模式立即转绿, 不再显示"未连接")
        // 启动同步"同时运行上限"(GM 专属): Foundry 设置值 → 服务端模型池(裁剪/扩容)
        // 1.6.107 引擎没起来时不要再打这个请求(以前会触发 3 次重试并在控制台刷"直连TTS失败")
        try {
          if (game.user && game.user.isGM && getCfg().maxConcurrentModels && direct !== false) {
            svcRequest(getCfg().serverUrl, "POST", "/config", { max_concurrent_models: Number(getCfg().maxConcurrentModels) || 10 }, { retries: 0, timeoutMs: 5000 }).catch(() => { /* noop */ });
          }
        } catch (e) { /* noop */ }
      } catch (e) { window.__fvttTTSCanDirect = false; }
    })();
  }, 2000);
});

// HUD 主题设置保存后立即生效; 语音运行者选择 = 切换本机服务地址
Hooks.on("updateSetting", (setting, data) => {
  try {
    if (setting && setting.key) {
      if (setting.key === `${MODULE}.hudTheme`) applyHudTheme();
      if (setting.key === `${MODULE}.portraitSize`) applyPortraitSize();
      if (setting.key === `${MODULE}.showStatus`) try { updateStatusUI(); } catch (e) { /* noop */ }
      if (setting.key === `${MODULE}.devTools`) try { applyDevButtons(); } catch (e) { /* noop */ }
      if (setting.key === `${MODULE}.gmMute`) {
        // GM 全局静音: 开启瞬间停掉所有正在播放/排队的语音(GM 与所有 pl 客户端同时响应)
        try { if (setting.value) stopSpeaking(); } catch (e) { /* noop */ }
        try { if (window.__fvttTTSMuteUpdater) window.__fvttTTSMuteUpdater(); } catch (e) { /* noop */ }
      }
      if (setting.key === `${MODULE}.portraitMode`) { try { updateCharIndicator(); refreshAllPortraits(); } catch (e) { /* noop */ } }
      if (setting.key === `${MODULE}.voiceRunner`) {
        const v = setting.value || "gm";
        // gm/self 都靠运行时动态解析(auto); 其他值 = 某个服务声明地址(直接采用)
        const target = (v === "gm" || v === "self") ? "auto" : v;
        game.settings.set(MODULE, "serverUrl", target).catch(() => {});
      }
    }
  } catch (e) { /* noop */ }
});

// 渲染完成后(延迟)再布局/绑事件, 避免渲染中途插 DOM 把工具条弹走
const _deferUI = () => setTimeout(() => { try { buildUI(); attachTyping(); } catch (e) { /* noop */ } }, 0);
Hooks.on("renderChatInput", (app, elements, options) => _deferUI());   // v13
Hooks.on("renderChatLog", (app, html, options) => _deferUI());        // v11/12 兼容
Hooks.on("renderSidebarTab", (app, html, options) => _deferUI());     // 聊天面板重渲染后重建

// 立绘轮换(1.6.19): 同角色说话换不同立绘(无情绪标签时近似"AI 在立绘中自选"); 情绪变化时开新轮次
let _spriteRotKeys = null;
function getSpriteRotation(name, emotion) {
  try {
    if (!_spriteRotKeys) _spriteRotKeys = new Map();
    const key = String(name || "") + "|" + String(emotion || "");
    const v = _spriteRotKeys.get(key) || 0;
    _spriteRotKeys.set(key, v + 1);
    return v;
  } catch (e) { return 0; }
}

// 情绪→立绘候选(1.6.27): ①角色 emotion_tags 标注匹配(对标 Shinsekai: "立绘 3：（巫女服）开心") → ②文件名情绪词 → ③6 情绪分段兜底
// 返回候选索引数组(组内轮换不串段)
function spriteBucketForEmotion(sprites, emotion, emotionTags) {
  try {
    const n = Array.isArray(sprites) ? sprites.length : 0;
    if (n <= 1) return [0];
    const emo = String(emotion || "").toLowerCase();
    const et = String(emotionTags || "");
    if (et.trim()) {
      const lines = et.split(/\n+/).map(l => l.trim()).filter(l => /(立绘|sprite|spr)\s*\d+/i.test(l));
      const hits = [];
      const etw = emoTagWords(emo);
      lines.forEach(ln => {
        // 1.6.46 辅助/承接标注行(接立绘N/配合立绘N一起用)不作为独立候选 — 否则 fear 落到"接立绘31"这类图, 看着像随机
        if (/接立绘|接sprite|配合|一起用|连着|承接/.test(ln)) return;
        const m = ln.match(/(立绘|sprite|spr)\s*(\d+)/i);   // 1.6.46 兼容"立绘 N"与"sprite NN"(七海千秋 21 行是 sprite 格式, 此前全失效落分段兜底)
        if (!m) return;
        const idx = (parseInt(m[2], 10) || 1) - 1;
        if (idx < 0 || idx >= n) return;
        if (etw.some(w => ln.toLowerCase().includes(w))) hits.push(idx);
      });
      if (hits.length) return hits;
    }
    const kw = {
      angry: ["angry", "anger", "rage", "mad", "怒", "气", "咆哮"],
      joy: ["joy", "happy", "laugh", "smile", "笑", "开心", "高兴", "喜", "欢"],
      sad: ["sad", "cry", "crying", "tear", "泪", "哭", "伤心", "悲", "难过", "泣"],
      surprised: ["surprised", "shock", "wow", "惊", "惊讶", "震惊"],
      fear: ["fear", "scared", "afraid", "horror", "怕", "恐惧"],
      shy: ["害羞", "脸红", "羞", "shy"],   // 1.6.109
      calm: ["calm", "serene", "gentle", "平静", "温柔", "娴静"],
      neutral: ["neutral", "normal", "平静", "普通"]
    };
    const wants = kw[emo] || [];
    if (wants.length) {
      const hits = [];
      sprites.forEach((s, i) => {
        const f = String(s || "").toLowerCase();
        if (wants.some(w => f.includes(w))) hits.push(i);
      });
      if (hits.length) return hits;
    }
    // 纯数字编号 → 6 情绪分段兜底(索引均分)
    const gmap = { joy: 1, happy: 1, sad: 2, angry: 3, surprised: 4, fear: 5, calm: 0 };
    const g = gmap[emo] !== undefined ? gmap[emo] : 0;
    const per = Math.max(1, Math.floor(n / 6));
    const list = [];
    for (let i = g * per; i < Math.min((g + 1) * per, n); i++) list.push(i);
    return list.length ? list : [0];
  } catch (e) { return [0]; }
}

// 情绪 → emotion_tags 中文关键词(1.6.27, 对标 Shinsekai 标注文本; 1.6.46 按七海/丛雨标注词补全, 减少落分段兜底)
function emoTagWords(emo) {
  const em = String(emo || "").toLowerCase();
  if (em === "joy" || em === "happy") return ["开心", "高兴", "大笑", "眯眼笑", "笑", "有兴趣", "兴奋", "元气", "微笑", "温柔", "激动", "喘气", "害羞", "脸红"];
  if (em === "sad") return ["难过", "伤心", "哭", "泪", "悲", "沮丧", "没干劲", "失落", "不满", "自闭", "担忧"];
  if (em === "angry") return ["生气", "怒", "训斥", "厌恶", "恶心", "敌意", "防守", "生闷气", "骂", "警告", "阻止", "制止", "埋怨", "嘟嘴", "冷漠", "鼓起脸颊"];
  if (em === "surprised") return ["震惊", "惊讶", "惊", "愣", "疑惑", "好奇", "歪头"];
  if (em === "fear") return ["害怕", "恐惧", "怕", "惊吓", "颤抖", "冷汗", "毛骨悚然", "发抖", "不安", "担心"];
  if (em === "shy") return ["害羞", "脸红", "羞", "含羞", "害臊", "羞答答"];   // 1.6.109
  if (em === "calm") return ["平静", "温柔", "娴静", "说话", "闭眼", "吐槽", "看着你", "想事情", "反问", "调侃", "指点", "引导", "陈述", "解释", "指向", "果断", "仔细", "眺望", "沉思", "中性"];
  return ["平静", "说话", "看着你", "闭眼", "中性"];
}

// 情绪键标准化(1.6.30): 语气槽 key/label(中文"开心/愤怒"或 custom_x) → 标准枚举(joy/sad/...)
// 修"手动选了语气槽但立绘/声音调制不变" — 此前槽 key 原样传入, 情绪词表/调制表都认不出
function normalizeEmotionKey(key) {
  const k = String(key || "").toLowerCase();
  if (/(开心|高兴|喜悦|大笑|微笑|好笑|兴奋|欢乐|joy|happy|laugh|smile|欢)/.test(k)) return "joy";
  if (/(哭|难过|伤心|悲伤|泪|泣|沮丧|sad|cry|crying)/.test(k)) return "sad";
  if (/(怒|生气|狂暴|气愤|恼|可恶|angry|rage|mad)/.test(k)) return "angry";
  if (/(惊|愣|surprised|shock|wow)/.test(k)) return "surprised";
  if (/(怕|恐惧|fear|scared|horror|害怕|哆嗦)/.test(k)) return "fear";
  if (/(害羞|羞涩|娇羞|含羞|害臊|脸红|shy)/.test(k)) return "shy";   // 1.6.109: 情绪槽匹配也要认"害羞，脸红"
  if (/(平静|温柔|calm|neutral|正常|冷|无语)/.test(k)) return "neutral";
  return k || "neutral";
}

// 情绪规则判定(1.6.20): 无 LLM 依赖 — 台词关键词/标点 → 情绪key(引擎后处理调制近似语气); 显式选择的语气优先
function detectEmotion(text, cur) {
  try {
    const e = (cur && cur.emotion) || "";
    if (e) {
      // 手动语气(语气槽)优先: 标准化成 joy/sad/angry/... 再返回(1.6.30: 不再原样吐槽 key)
      const ne = normalizeEmotionKey(e);
      if (ne && ne !== "neutral") return ne;
    }
    const t = String(text || "");
    if (/(哈哈|嘻嘻|嘿嘿|好耶|太棒|开心|高兴|万岁|太好了|快乐|耶|笑|嘿嘿|妙啊)/.test(t)) return "joy";
    if (/(呜呜|呜咽|哭|伤心|难过|悲伤|泪|好想|舍不得|呜|唉|叹气)/.test(t)) return "sad";
    if (/[！!]/.test(t)) {
      if (/(怒|气死|可恶|混蛋|住口|闭嘴|滚|杀|讨厌|烦|气|骂|找死)/.test(t)) return "angry";
      if (/(没想到|怎么会|什么|惊|啊|哇|咦)/.test(t)) return "surprised";
    }
    if (/(害怕|怕|恐惧|救命|颤|鬼|吓)/.test(t)) return "fear";
    // 1.6.59 日/英语常见情绪词(无AI时非中文文本也能规则判定; 中文优先规则在前, 兜底提示词基调在后)
    if (/(えっ|ええ|まじ|うそ|嘘|ほんと|本当|信じられない|マジ)/.test(t)) return "surprised";
    if (/(うわ|すごい|やった|嬉しい|楽しい|最高|わーい|わあ|いいね|ラッキー)/.test(t)) return "joy";
    if (/(悲しい|辛い|泣き|涙|さようなら|嫌だ|寂しい)/.test(t)) return "sad";
    if (/(ふざける|クソ|ムカ|うざい|怒って|怒る)/.test(t)) return "angry";
    if (/(怖い|助けて|恐ろしい|やばい|怖く)/.test(t)) return "fear";
    if (/(what|wow|really|no way|unbelievable|oh my|are you serious|seriously)/i.test(t)) return "surprised";
    if (/(haha|awesome|great|yay|love|happy|nice|cool|amazing|wonderful|fantastic|best)/i.test(t)) return "joy";
    if (/(so sad|why|sad|cry|hurt|miss you|goodbye|lonely|sorry|farewell)/i.test(t)) return "sad";
    if (/(damn|hate|angry|shut up|stupid|jerk|idiot|bullshit)/i.test(t)) return "angry";
    if (/(help|scared|afraid|monster|nightmare|terrified|horrible)/i.test(t)) return "fear";
    return "neutral";
  } catch (e) { return "neutral"; }
}

// 朗读风格 → 情绪枚举(1.6.47, 对标 Shinsekai: 风格是给AI决定"这句话语气"的参考; 无LLM时先按风格词映射情绪, 再规则/AI兜底)
function styleEmotionKey(style) {
  try {
    const s = String(style || "");
    if (!s.trim()) return "";
    const _stMap = [
      [/严肃|认真|正式|威严|庄重|稳重|庄严|沉着|冷静/, "calm"],
      [/激动|兴奋|紧张|热血|高亢|有力|燃|热/, "joy"],
      [/生气|愤怒|恼火|怒|气愤/, "angry"],
      [/害怕|恐惧|恐慌/, "fear"],
      [/惊讶|吃惊|震惊/, "surprised"],
      [/难过|悲伤|哭/, "sad"],
      [/害羞|羞涩|娇羞|含羞|害臊|脸红|羞答答/, "shy"],   // 1.6.109 七海/多数角色都有"害羞，脸红"槽, 以前提示词写"害羞"完全不生效
      [/疑惑|困惑|不解|纳闷/, "surprised"],
      [/温柔|轻柔|舒缓|慵懒|软|温和|平静|优美|甜/, "joy"],
    ];
    for (let i = 0; i < _stMap.length; i++) { if (_stMap[i][0].test(s)) return _stMap[i][1]; }
    return "";
  } catch (e) { return ""; }
}

// AI 语气判定(1.6.24): LLM 根据台词+角色提示词判情绪(驱动声音调制+立绘分组); 未配/失败/超时降级规则; 同批说话复用一次调用
let _aiEmoPro = null;
// 1.6.54 提示词/AI/立绘三合一测试: ①强度插值表 ②4条真实消息走完整朗读链(AI判语气+润色+选立绘) ③手动选立绘优先验证
window.runAIPromptTest = async function runAIPromptTest() {
  const MOD = MODULE;
  const rows = [];
  let cn = "";
  try { cn = (loadVoiceProfile().current) || ""; } catch (e) { /* noop */ }
  if (!cn) { ui.notifications.warn("请先选择角色再测"); return null; }
  let verTxt = "?";
  try { verTxt = game.modules.get(MOD) ? game.modules.get(MOD).version : "?"; } catch (e) { /* noop */ }
  const cfg = getCfg();
  const style = (typeof getStylePrompt === "function" ? (getStylePrompt(cn) || "") : "") || "";
  // 1.6.59 LLM 诊断: 处于禁用时先主动重探一次(用户可能刚改好 base/key), 成功本轮即恢复 AI 链路
  if (cfg.llmEnabled && cfg.llmKey && window.__fvttTTSLlmBroken === true) {
    try { await probeLLMOnce(); } catch (e) { /* noop */ }
  }
  const llmOk = !!(cfg.llmEnabled && cfg.llmKey) && window.__fvttTTSLlmBroken !== true;
  let _llmDiag = "";   // 1.6.59 LLM 诊断行(失败具体原因, 便于用户自查 base/key/model)
  if (!cfg.llmEnabled || !cfg.llmKey) {
    _llmDiag = "未配置: 需开\"AI\"开关并填 key(模块设置)";
  } else if (llmOk) {
    _llmDiag = "可用✓";
  } else {
    _llmDiag = "禁用(最近失败: " + String(window.__fvttTTSLlmErr || "?").slice(0, 140) + ")";
  }
  _llmDiag += " | base=" + String(cfg.llmBaseUrl || "https://api.openai.com/v1").slice(0, 42) + " | model=" + (cfg.llmModel || "gpt-4o-mini") + " | key=" + maskKey(cfg.llmKey);
  rows.push("LLM诊断: " + _llmDiag + " | AI=" + (llmOk ? "可用(本测试走AI链)" : "不可用(将走规则降级)"));
  rows.push("角色=" + cn + " | 朗读提示词=" + (style || "⚠未填(提示词不生效)") + " | 版本=" + verTxt + (verTxt === "1.6.69" ? " (JS=1.6.69✓)" : " ⚠ 清单缓存显示" + verTxt + "≠1.6.69: GM → 设置 → 游戏系统 → 重载世界一次"));

  // ① 提示词强度插值表(0/25/50/100%) — 1.6.69 未填时明确标注"不生效"(此前用示例词"严肃认真"算表, 会让人误以为提示词生效了)
  if (!style) rows.push("[强度表] ⚠ 朗读提示词未填 → 提示词完全不生效(语速固定 spd=1.00, 不做切分/停顿); 到 语音设置→当前角色→朗读提示词 填写");
  const _kw0 = styleKeywordParams(style || "", 20);
  const _ssRows = [];
  [0, 25, 50, 100].forEach(pct => {
    const _r = pct / 100;
    const _spd = _kw0.speed ? (1 + (_kw0.speed - 1) * _r) : 1.0;
    _ssRows.push(pct + "%→" + (_spd === 1.0 ? "spd=1.00" : "spd=" + _spd.toFixed(2)));
  });
  rows.push("[强度表] 关键词" + (_kw0.speed ? ("命中语速=" + _kw0.speed) : "未命中语速") + ": " + _ssRows.join(" | ") + (_kw0.split ? " | 切分: <25%不启用" : ""));

  // ② 真实发送 5 条(多语种×多语气×双模型, 走完整朗读链): 最后一条模拟使用者手动选立绘 → 验证 AI 不覆盖
  // 丛雨=Murasame(愤怒提示词→愤怒基调); 七海千秋=nanami(模型切换); 语种 zh/ja/en 混测
  const scenes = [
    { label: "句1", role: "丛雨", lang: "zh", text: "今天的事情，就交给我吧。我会认真处理的。", strength: 100, manual: false },   // 期望: 文本neutral→提示词愤怒→angry(愤怒变声)
    { label: "句2", role: "丛雨", lang: "zh", text: "哈哈，太棒啦！我们一起去吧～！", strength: 100, manual: false },                    // 期望: 文本优先→joy(不被愤怒覆盖)
    { label: "句3", role: "丛雨", lang: "ja", text: "えっ？！本当ですか？！信じられない……", strength: 50, manual: false },               // ja 惊讶
    { label: "句4", role: "七海千秋", lang: "en", text: "Oh no… why did it have to end like this…", strength: 100, manual: false },       // 切七海模型 en 悲伤
    { label: "句5", role: "七海千秋", lang: "zh", text: "嗯…那就这样吧。", strength: 0, manual: true },                                    // 七海 zh 平静 + 手动立绘优先
  ];
  const _origRole = (() => { try { return (loadVoiceProfile().current) || ""; } catch (e) { return ""; } })();
  const manualSpriteOf = (r) => {
    try {
      const cc = (quickChars && quickChars.chars || []).find(x => x.name === r);
      if (cc && cc.sprites && cc.sprites[0]) return cc.sprites[0];
    } catch (e) { /* noop */ }
    return "";
  };
  const _origStre = (() => { try { const vp = loadVoiceProfile(); const cc = (vp.chars && vp.chars[cn]) || null; return (cc && typeof cc.styleStrength === "number") ? cc.styleStrength : (typeof cfg.styleStrength === "number" ? cfg.styleStrength : 0); } catch (e) { return 0; } })();
  window.__fvttTTSAiLineDiag = true;
  window.__fvttTTSAiLineDiagList = [];
  window.__fvttTTSAiLineEnterList = [];
  try {
    for (let i = 0; i < scenes.length; i++) {
      const sc = scenes[i];
      try {
        const profT = loadVoiceProfile();
        profT.current = sc.role;   // 临时切到场景角色(多模型测试: 引擎按 role 换模型)
        profT.chars = profT.chars || {};
        const cT = profT.chars[sc.role] || (profT.chars[sc.role] = { name: sc.role });
        cT.styleStrength = sc.strength;   // 临时设置本条强度
        saveVoiceProfile(profT);
      } catch (e) { /* noop */ }
      const flT = { fromModSend: true, role: sc.role, lang: sc.lang };
      if (sc.manual) { const _ms = manualSpriteOf(sc.role); if (_ms) flT.selSprite = _ms; }   // 模拟使用者在立绘库点选
      let msg = null;
      try { msg = await ChatMessage.create({ content: sc.text, speaker: { alias: sc.role }, flags: { [MOD]: flT } }); }
      catch (e) { rows.push("[" + sc.label + "] 发送失败: " + String((e && e.message) || e).slice(0, 60)); continue; }
      // 1.6.57/58 按消息id等本句探针(最长35s): 先等入口探针(证明进入maybeSpeak), 再等判定探针
      let waited = 0;
      while (waited < 150 && !(window.__fvttTTSAiLineEnterList || []).some(p => p && p.mid === msg.id)) { await new Promise(r => setTimeout(r, 200)); waited++; }
      const _entered = !!(window.__fvttTTSAiLineEnterList || []).some(p => p && p.mid === msg.id);
      waited = 0;
      while (waited < 175 && !(window.__fvttTTSAiLineDiagList || []).some(p => p && p.mid === msg.id)) { await new Promise(r => setTimeout(r, 200)); waited++; }
      let aud = "";
      waited = 0;
      while (waited < 100) {
        try {
          const m2 = game.messages.get(msg.id);
          const f2 = m2 && m2.flags && m2.flags[MOD];
          if (f2 && (f2.audioUrl || f2.audioData)) { aud = "✓"; break; }
        } catch (e) { /* noop */ }
        await new Promise(r => setTimeout(r, 200)); waited++;
      }
      const _probe = (window.__fvttTTSAiLineDiagList || []).find(p => p && p.mid === msg.id) || {};
      const _fNow = (() => { try { const m3 = game.messages.get(msg.id); return (m3 && m3.flags && m3.flags[MOD]) || {}; } catch (e) { return {}; } })();
      const _avNow = _fNow.avatar || _fNow.selSprite || _fNow.aiSprite || "";
      const _hasProbe = !!(_probe && _probe.mid);
      rows.push("[" + sc.label + " " + sc.role + "/" + sc.lang + "/强度" + sc.strength + "%] 「" + sc.text.slice(0, 16) + "…」 → " + (_hasProbe ? ("判定=" + (_probe.src || "—") + " 情绪=" + (_probe.emo || "无(neutral)")) : ("未探到(" + (_entered ? "已进hook判定未产" : "hook未触发") + ")")) + " | 润色=" + ((_fNow.polishText || _probe.polish) ? "✓" : "—") + " | 立绘=" + (_avNow ? ("#→" + String(_avNow).slice(-22)) : (sc.manual ? "未覆盖(手动优先✓)" : "无")) + " | 合成=" + (aud || "等待超时"));
    }
  } finally {
    try {
      const profR = loadVoiceProfile();
      profR.current = _origRole;   // 恢复原角色
      profR.chars = profR.chars || {};
      const cR = profR.chars[cn] || (profR.chars[cn] = { name: cn });
      cR.styleStrength = _origStre;
      saveVoiceProfile(profR);
    } catch (e) { /* noop */ }
    window.__fvttTTSAiLineDiag = false;
    window.__fvttTTSAiLineDiagList = [];
    window.__fvttTTSAiLineEnterList = [];
  }
  // ③ 报告落盘 + 展示
  const reportTxt = "[AI提示词测试报告] " + new Date().toLocaleString("zh-CN") + " | 角色=" + cn + " | 版本=" + verTxt + "\n" + rows.join("\n");
  console.warn("[gpt-sovits-tts][AI测试]\n" + reportTxt);
  try { await svcRequest(cfg.serverUrl || "http://127.0.0.1:9881", "POST", "/diag", { type: "ai-lines-report", report: reportTxt }, { retries: 0 }); } catch (e) { /* noop */ }
  ui.notifications.info("AI测试完成: " + rows.length + " 行报告(控制台/服务器日志)");
  return rows;
};

/** 1.6.64 音频头部包络分析(浏览器 WebAudio 解码真实音频): 用于验证"开头几个字是否听得见" */
async function analyzeAudioHead(url) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || !url) return null;
    const resp = await fetch(url, { cache: "no-store" });
    if (!resp.ok) return null;
    const buf = await resp.arrayBuffer();
    const ctx = new AC();
    const ab = await new Promise((res, rej) => {
      let p = null;
      try { p = ctx.decodeAudioData(buf, res, rej); } catch (e) { rej(e); }
      if (p && typeof p.then === "function") p.then(res, rej);
    });
    if (!ab) { try { ctx.close(); } catch (e) { /* noop */ } return null; }
    const ch = ab.getChannelData(0), sr = ab.sampleRate, N = ch.length;
    const rms = (s, e) => {
      const i0 = Math.floor(s * sr), i1 = Math.min(Math.floor(e * sr), N);
      if (i1 <= i0) return 0;
      let sum = 0;
      for (let i = i0; i < i1; i++) sum += ch[i] * ch[i];
      return Math.sqrt(sum / (i1 - i0));
    };
    let silent = -1;
    const step = Math.max(1, Math.floor(sr * 0.01));
    const lim = Math.min(N, Math.floor(sr * 1.5));
    for (let i = 0; i < lim; i += step) { if (rms(i / sr, (i + step) / sr) > 0.01) { silent = i / sr; break; } }
    const out = { dur: ab.duration, sr: sr, rms20: rms(0, 0.02), rms50: rms(0.02, 0.05), rms100: rms(0.05, 0.1), silentHead: silent };
    try { ctx.close(); } catch (e) { /* noop */ }
    return out;
  } catch (e) { return null; }
}

/** 1.6.72 解码音频为 PCM(供情绪声线对比用) */
async function decodeAudioToData(url) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || !url) return null;
    const resp = await fetch(url, { cache: "no-store" });
    if (!resp.ok) return null;
    const buf = await resp.arrayBuffer();
    const ctx = new AC();
    const ab = await new Promise((res, rej) => {
      let p = null;
      try { p = ctx.decodeAudioData(buf, res, rej); } catch (e) { rej(e); }
      if (p && typeof p.then === "function") p.then(res, rej);
    });
    try { if (ctx.close) { /* 1.6.73 先取数据再关 context(关闭后 getChannelData 可能失效 → 之前波形相关返回 -1) */ } } catch (e) { /* noop */ }
    if (!ab) { try { ctx.close(); } catch (e) { /* noop */ } return null; }
    // 复制一份数据(Float32Array.from), 避免 AudioBuffer 释放后视图失效
    const _ch = Float32Array.from(ab.getChannelData(0));
    const _out = { ch: _ch, sr: ab.sampleRate, dur: ab.duration };
    try { ctx.close(); } catch (e) { /* noop */ }
    return _out;
  } catch (e) { return null; }
}

/** 1.6.73 降采样(算 F0 用, 降复杂度) */
function downsampleCh(ch, sr, target) {
  try {
    const step = Math.max(1, Math.round(sr / (target || 8000)));
    if (step === 1) return { ch: ch, sr: sr };
    const n = Math.floor(ch.length / step);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = ch[i * step];
    return { ch: out, sr: sr / step };
  } catch (e) { return { ch: ch, sr: sr }; }
}

/** 1.6.73 基频(F0)中位数估计(自相关): 声线/音高差异的直接指标 —— 用于判断"两个情绪是否真的换了声线" */
function f0MedianOf(ch, sr, fmin, fmax) {
  try {
    fmin = fmin || 60; fmax = fmax || 400;
    const ds = downsampleCh(ch, sr, 8000);
    const c = ds.ch, s = ds.sr;
    const win = Math.floor(s * 0.035), hop = Math.floor(s * 0.02);
    const lo = Math.max(2, Math.floor(s / fmax)), hi = Math.floor(s / fmin);
    const f0s = [];
    let frames = 0;
    for (let i = 0; i + win < c.length; i += hop) {
      if ((frames++ % 4) !== 0) continue;   // 每 4 帧取 1, 降复杂度
      let e = 0, m = 0;
      for (let j = i; j < i + win; j++) { e += c[j] * c[j]; m += c[j]; }
      if (Math.sqrt(e / win) < 0.02) continue;
      m /= win;
      let best = -1, bestV = -Infinity;
      for (let k = lo; k < hi; k++) {
        let acc = 0;
        for (let j = 0; j + k < win; j++) acc += (c[i + j] - m) * (c[i + j + k] - m);
        if (acc > bestV) { bestV = acc; best = k; }
      }
      if (best > 0) f0s.push(s / best);
    }
    if (!f0s.length) return 0;
    f0s.sort((a, b) => a - b);
    return f0s[Math.floor(f0s.length / 2)];
  } catch (e) { return 0; }
}

/** 1.6.72 两段波形相关系数(1=几乎相同, 越低差异越大): 用于判断"两个情绪是否真的换声线" */
function waveCorr(x, y) {
  try {
    const n = Math.min(x.length, y.length);
    if (n < 2000) return -1;
    let sx = 0, sy = 0;
    for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; }
    const mx = sx / n, my = sy / n;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) { const a = x[i] - mx, b = y[i] - my; num += a * b; dx += a * a; dy += b * b; }
    if (dx <= 0 || dy <= 0) return -1;
    return num / Math.sqrt(dx * dy);
  } catch (e) { return -1; }
}

// 1.6.80 引擎机自检(部署专用 TTS 机时一键排查): CUDA/显存 · 模型齐全 · 参考音合规 · ffmpeg · 角色包 · 磁盘
window.runEngineSelfCheck = async function runEngineSelfCheck(opts) {
  const cfg = getCfg();
  const out = { ok: false, items: [], text: "" };
  try {
    const r = await svcRequest(cfg.serverUrl, "GET", "/selfcheck", null, { timeoutMs: 20000, retries: 0 });
    const j = (r && typeof r.json === "function") ? await r.json().catch(() => ({})) : {};
    out.items = (j && j.items) || [];
    out.ok = !!(j && j.ok);
    const lines = ["[引擎机自检] 地址=" + String(cfg.serverUrl || "") + " | 结论=" + (out.ok ? "全部通过 ✓" : ("存在问题: " + ((j && j.failed) || []).join("、")))];
    for (const it of out.items) lines.push((it.ok ? "✓ " : "✗ ") + it.name + ": " + it.detail);
    out.text = lines.join("\n");
    try { console.warn("[gpt-sovits-tts]" + out.text); } catch (e) { /* noop */ }
    try { if (!(opts && opts.silent === true)) ui.notifications[out.ok ? "info" : "warn"](out.text.split("\n")[0]); } catch (e) { /* noop */ }
    try { await svcRequest(cfg.serverUrl, "POST", "/diag", { type: "engine-selfcheck", report: out.text }, { timeoutMs: 10000, retries: 0 }); } catch (e) { /* noop */ }
  } catch (e) {
    out.text = "[引擎机自检] 失败: " + String((e && e.message) || e).slice(0, 140) + "（引擎未启动或不可达）";
    try { console.warn("[gpt-sovits-tts]" + out.text); } catch (e2) { /* noop */ }
    try { if (!(opts && opts.silent === true)) ui.notifications.error("引擎自检失败: 引擎未启动或不可达"); } catch (e2) { /* noop */ }
  }
  return out;
};

// 1.6.64 最终测试: 一键跑全链路 → 自动生成报告文件(engine/final_test_report.md), 可直接发给作者查看
//  覆盖: 引擎连通 / LLM 诊断 / 提示词强度插值 / 合成播放 / 句首音量(实测音频包络) / 立绘切换 /
//        多语种×多语气×双模型 / AI 判语气+润色+选立绘 / 手动选立绘优先
// 1.6.144 最终测试 v9（发布验收）: 删掉历年反复通过、已无信息量的旧项;
//   只保留"当前仍可能坏"的路径, 并加严断言(音频字节 + 真实播放次数 + 界面元素存在 + 设置项可读)。
// 1.6.153 最终测试 v10（精简验收）: 删掉已连续多轮通过、信息量低的项(界面/设置/文案/看门狗/打包/并发健康/第三条场景),
//   只保留"坏了用户立刻能感知"的链路: 核心朗读(2 条) / 发送框 / 预览防双播 / 预加载 / 白名单 / 防双发 / 静默预加载 / AI。
window.runFinalTest = async function runFinalTest() {
  const MOD = MODULE;
  const L = [];
  const push = (s) => { try { L.push(String(s)); } catch (e) { /* noop */ } };
  const t0 = Date.now();
  let cn = ""; try { cn = (loadVoiceProfile().current) || ""; } catch (e) { /* noop */ }
  if (!cn) { ui.notifications.warn("请先选择角色再测"); return null; }
  let verTxt = "?"; try { verTxt = game.modules.get(MOD) ? game.modules.get(MOD).version : "?"; } catch (e) { /* noop */ }
  let opName = ""; try { opName = (game.user && game.user.name) || ""; } catch (e) { /* noop */ }
  const cfg = getCfg();
  const fails = [];
  const _secMs = {}; let _secT = Date.now();
  const _mark = (k) => { try { const n = Date.now(); _secMs[k] = Math.round((n - _secT) / 1000); _secT = n; } catch (e) { /* noop */ } };
  const _note = (s) => { try { ui.notifications.info(s); } catch (e) { /* noop */ } };
  const _sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const _testIds = [];
  const _profSnap = (() => { try { return JSON.stringify(loadVoiceProfile()); } catch (e) { return ""; } })();
  const _origStyle = (() => { try { return getStylePrompt(cn) || ""; } catch (e) { return ""; } })();
  const _chkRows = [];
  const _chk = (name, ok, detail) => { _chkRows.push({ name: String(name), ok: !!ok, detail: String(detail || "") }); if (!ok) fails.push(String(name)); return !!ok; };
  const _plays = () => { try { return Number(window.__fvttTTSPlayCount || 0); } catch (e) { return 0; } };
  const _playsSince = (t0s) => { try { return (window.__fvttTTSPlayLog || []).filter(x => x && x.ts >= t0s).length; } catch (e) { return 0; } };
  const _settle = async (stableMs = 1200, maxMs = 25000) => {
    try {
      const t0s = Date.now();
      let last = _plays(), stable = 0;
      while (Date.now() - t0s < maxMs) {
        await _sleep(250);
        const p = _plays();
        if (p === last) stable += 250; else { stable = 0; last = p; }
        if (stable >= stableMs) {
          let _lastTs = 0;
          try { const lg = window.__fvttTTSPlayLog || []; if (lg.length) _lastTs = Number(lg[lg.length - 1].ts) || 0; } catch (e) { /* noop */ }
          if (!_lastTs || Date.now() - _lastTs > 1500) return;
        }
      }
    } catch (e) { /* noop */ }
  };
  const _aiOn = !!(cfg.llmEnabled && cfg.llmKey) && window.__fvttTTSLlmBroken !== true;
  const _stat = async () => {
    try {
      const r = await svcRequest(cfg.serverUrl, "GET", "/llm/stats", null, { timeoutMs: 8000, retries: 0, quiet: true });
      const j = (r && typeof r.json === "function") ? await r.json().catch(() => ({})) : {};
      return (j && j.stats) || null;
    } catch (e) { return null; }
  };
  const _sendLine = async (text, extra, waitMs) => {
    let _curEmo = "";
    try { const _c = (loadVoiceProfile().chars || {})[cn] || {}; _curEmo = String(_c.emotion || ""); } catch (e) { /* noop */ }
    const fl = Object.assign({
      fromModSend: true, role: cn, lang: "zh",
      emotion: _curEmo ? normalizeEmotionKey(_curEmo) : "",
      speed: 0, emotionMix: 0, emotionMod: 0,
    }, extra || {});
    let msg = null;
    const _t = Date.now();
    try { msg = await ChatMessage.create({ content: text, speaker: { alias: cn }, flags: { [MOD]: fl } }); }
    catch (e) { return { id: "", audio: false, bytes: 0, error: String((e && e.message) || e) }; }
    if (msg && msg.id) _testIds.push(msg.id);
    let w = 0, audio = false;
    while (w < Math.max(10, Math.round((waitMs || 40000) / 200))) {
      try {
        const mm = game.messages.get(msg.id);
        const f = mm && mm.flags && mm.flags[MOD];
        if (f && (f.audioUrl || f.audioData)) { audio = true; break; }
      } catch (e) { /* noop */ }
      await _sleep(200); w++;
    }
    const fNow = (() => { try { const m2 = game.messages.get(msg.id); return (m2 && m2.flags && m2.flags[MOD]) || {}; } catch (e) { return {}; } })();
    const _bytes = (() => {
      try {
        const d = String(fNow.audioData || "");
        if (d) return Math.round(d.length * 0.75);
        return String(fNow.audioUrl || "") ? 4096 : 0;
      } catch (e) { return 0; }
    })();
    return { id: msg && msg.id, audio: audio, bytes: _bytes, flags: fNow, ms: Date.now() - _t };
  };

  push("# GPT-SoVITS TTS 最终测试报告（v10 精简验收）");
  push("");
  push("- 时间: " + new Date().toLocaleString("zh-CN") + " | 执行者: " + opName + " | 角色: " + cn);
  push("- 版本断言: 代码=" + MOD_VERSION + " | 清单缓存=" + verTxt + (String(verTxt) === String(MOD_VERSION) ? " ✓ 一致" : "（缓存落后可忽略）"));
  push("- v10 只测「坏了用户立刻能感知」的链路: 核心朗读 2 条(字节/播放次数/参考音/立绘) · 发送框 · 预览→发送防双播 · 预加载→发送 · 白名单负向 · 防双发 · 静默预加载 · AI(配了才跑)");
  push("- 已删除(多轮通过、信息量低): 界面/设置/文案自检 · 看门狗 · 打包完整性 · 并发健康 · 第三条场景");
  push("");

  // ============ 0 引擎前置 ============
  _mark("引擎前置");
  let engOk = false, engDetail = "";
  try {
    const rs = await svcRequest(cfg.serverUrl, "GET", "/status", null, { timeoutMs: 8000, retries: 0, quiet: true });
    const sj = (rs && typeof rs.json === "function") ? await rs.json().catch(() => ({})) : {};
    engOk = !!(rs && rs.ok && sj && sj.ok);
    engDetail = engOk ? ("服务=" + String(sj.service || "") + " device=" + String(sj.device || "") + " 角色=" + String((sj.character && sj.character.name) || "?")) : String((sj && sj.message) || "无响应");
  } catch (e) { engDetail = String((e && e.message) || e); }
  if (!engOk) {
    const _h0 = await probeEngineHealth(cfg.serverUrl).catch(() => ({ state: "unknown" }));
    push("## 引擎不可用 → 测试中止");
    push("");
    push("- 判定: " + (_h0.state === "refused" ? "连接被拒 = 引擎进程没在跑" : (_h0.state === "hung" ? "端口在听但 HTTP 不响应 = 引擎卡死" : "无法判定（引擎地址/网络）")));
    push("- /status: " + engDetail);
    const md0 = L.join("\n");
    try { console.warn("[gpt-sovits-tts][最终测试]\n" + md0); } catch (e) { /* noop */ }
    return { markdown: md0, saved: "", fails: ["引擎未启动"] };
  }
  let apiV = "";
  try { const h = await probeEngineHealth(cfg.serverUrl, 4000).catch(() => ({})); apiV = String((h && h.apiVersion) || ""); } catch (e) { /* noop */ }
  push("## 环境");
  push("- 引擎连通 ✓ " + engDetail + " | api=" + (apiV || "?") + " | LLM=" + (_aiOn ? "已配置" : "未配置") + " | 立绘=" + cfg.portraitMode);
  push("");

  // ============ 1 核心朗读（2 条）============
  _note("① 核心朗读 2 条…");
  _mark("核心朗读");
  push("## 一、核心朗读（2 条）");
  push("");
  const _slotKeyOf = (re) => { try { const c = (quickChars && quickChars.chars || []).find(x => x.name === cn); const s = ((c && c.emotions) || []).find(e => re.test(String(e && e.label))); return (s && s.key) || ""; } catch (e) { return ""; } };
  const _angryKey = _slotKeyOf(/生气/);
  const _shyKey = _slotKeyOf(/害羞/);
  const _styleEmo = _shyKey ? "害羞羞涩的语气" : (_angryKey ? "用愤怒、压着火气的语气说话" : "");
  const _scenes = [
    { label: "①带情绪", style: _styleEmo, strength: 50, text: "今天的事情，就交给我吧。我会认真处理的。", manualSlot: _angryKey || "", wantEmo: true },
    { label: "②中性句", style: "", strength: 50, text: "我们下午三点在大厅集合。", wantEmo: false },
  ];
  let _lastMsgId = "";
  try {
    for (const sc of _scenes) {
      try {
        setStylePrompt(cn, sc.style || "");
        const profT = loadVoiceProfile();
        profT.current = cn; profT.chars = profT.chars || {};
        const cT = profT.chars[cn] || (profT.chars[cn] = { name: cn });
        cT.styleStrength = sc.strength;
        if (!sc.manualSlot) { cT.emotion = ""; cT.auxRef = ""; }
        saveVoiceProfile(profT);
      } catch (e) { /* noop */ }
      if (sc.manualSlot) { try { await applyEmotion(sc.manualSlot, cn); } catch (e) { /* noop */ } }
      const _cv = (() => { try { return currentVoice() || {}; } catch (e) { return {}; } })();
      await _settle();
      const _tPlay = Date.now();
      const r = await _sendLine(sc.text, {
        emotion: _cv.emotion ? normalizeEmotionKey(_cv.emotion) : "",
        ref: String(_cv.ref || ""), auxRef: String(_cv.auxRef || ""),
        promptText: String(_cv.promptText || ""), promptLang: String(_cv.promptLang || ""),
      }, 45000);
      await _sleep(900);
      const _dPlays = _playsSince(_tPlay);
      if (r.id) _lastMsgId = r.id;
      const f = r.flags || {};
      const _sp = window.__fvttTTSLastSynthParams || {};
      const slot = (() => { try { return findEmotionSlot(String(f.emotion || ""), cn); } catch (e) { return null; } })();
      const av = String(f.aiSprite || f.avatar || f.selSprite || "");
      const slotAv = String((slot && slot.avatar) || "");
      push("- **" + sc.label + "** → 槽=" + String(f.emotion || "无") + " | 合成=" + (r.audio ? "✓" : "✗") + " 字节=" + (r.bytes > 0 ? r.bytes + "B" : "?")
        + " 参考音=" + ((_sp.aux && _sp.aux.length) ? "✓" : "无") + " 占比=" + (_sp.mix == null ? "?" : _sp.mix) + " | 播放=" + _dPlays + " 次 | 立绘=" + (av ? String(av).slice(-20) : "无"));
      _chk(sc.label + " 合成", r.audio);
      _chk(sc.label + " 音频字节>1KB", r.bytes > 1000, r.bytes + "B");
      _chk(sc.label + " 本机播放恰 1 次", _dPlays === 1, "plays=" + _dPlays);
      if (sc.wantEmo) {
        if (slot && slot.ref_audio_path) {
          _chk(sc.label + " 情绪参考音已送达", !!(_sp.aux && _sp.aux.length));
          _chk(sc.label + " 情绪占比>0", !!(_sp.mix > 0), String(_sp.mix));
          if (slotAv) _chk(sc.label + " 立绘=情绪槽图", av === slotAv, (av || "无") + " vs " + slotAv);
        } else push("- · 角色无可用情绪槽 → 情绪参考音断言跳过");
      } else {
        if (_aiOn) {
          const _hasSlot = !!(slot && slot.ref_audio_path);
          _chk(sc.label + " 参考音与判定一致", _hasSlot ? !!(_sp.aux && _sp.aux.length) : !(_sp.aux && _sp.aux.length), "slot=" + (slot ? slot.key : "无"));
        } else {
          _chk(sc.label + " 中性句无情绪参考音", !(_sp.aux && _sp.aux.length));
        }
      }
    }
  } finally {
    try { if (_profSnap) saveVoiceProfile(JSON.parse(_profSnap)); } catch (e) { /* noop */ }
    try { setStylePrompt(cn, _origStyle); } catch (e) { /* noop */ }
  }
  push("");

  // ============ 2 真实交互 ============
  push("## 二、真实交互");
  push("");
  _mark("交互");
  const _ta = findChatTextarea();
  if (!_ta) { push("- 跳过（找不到聊天输入框）"); fails.push("找不到输入框"); }

  // A 发送框
  if (_ta) {
    try {
      const _idsB = new Set((((game.messages && game.messages.contents) || []).map(m => m.id)));
      await _settle();
      const _tPlay = Date.now();
      _ta.value = "发送框路径测试：这条应发出并被读一次。";
      const r1 = await doSubmitChat(_ta, { aiDirect: true });
      let msg = null;
      if (r1 && r1.ok && r1.id) { try { msg = game.messages.get(r1.id) || null; } catch (e) { /* noop */ } }
      if (!msg) { for (let i = 0; i < 40 && !msg; i++) { await _sleep(200); const arr = (game.messages && game.messages.contents) || []; const nw = arr.filter(m => !_idsB.has(m.id)); if (nw.length) msg = nw[nw.length - 1]; } }
      if (msg && msg.id) _testIds.push(msg.id);
      let aud = false;
      for (let i = 0; i < 120 && !aud; i++) { try { const mm = game.messages.get(msg && msg.id); const f = mm && mm.flags && mm.flags[MOD]; if (f && (f.audioUrl || f.audioData)) aud = true; } catch (e) { /* noop */ } if (!aud) await _sleep(200); }
      await _sleep(700);
      const _d = _playsSince(_tPlay);
      const _f = (() => { try { const mm = game.messages.get(msg && msg.id); return (mm && mm.flags && mm.flags[MOD]) || {}; } catch (e) { return {}; } })();
      push("- **发送框**: 消息=" + (msg ? "✓" : "✗") + " 音频=" + (aud ? "✓" : "✗") + " 标记=" + (_f.fromModSend ? "✓" : "—") + " 播放=" + _d + " 次");
      _chk("发送框 建立消息", !!msg);
      _chk("发送框 音频写回", aud);
      _chk("发送框 带 fromModSend", !!_f.fromModSend);
      _chk("发送框 播放恰 1 次", _d === 1, "plays=" + _d);
      try { if (_ta.value) _ta.value = ""; } catch (e) { /* noop */ }
    } catch (e) { push("- 发送框异常: " + String((e && e.message) || e).slice(0, 70)); fails.push("发送框异常"); }
  }

  // B 预览 → 发送 防双播
  if (_ta) {
    const _oldTR = getCfg().typingRead === true;
    try {
      await game.settings.set(MOD, "typingRead", true);
      try { attachTyping(); } catch (e) { /* noop */ }
      await _settle();
      const _tPlay = Date.now();
      _ta.value = "预览防双播测试：这句话只应被读一次。";
      _ta.dispatchEvent(new Event("input", { bubbles: true }));
      let previewed = false;
      for (let i = 0; i < 100; i++) { await _sleep(200); if (_playsSince(_tPlay) > 0) { previewed = true; break; } }
      const _dPrev = _playsSince(_tPlay);
      const r2 = await doSubmitChat(_ta);
      await _sleep(1000);
      const _dSend = _playsSince(_tPlay) - _dPrev;
      const _tot = _playsSince(_tPlay);
      push("- **预览→发送 防双播**: 预读=" + (previewed ? "✓" : "✗") + " 发送后新增=" + _dSend + " 总计=" + _tot + "（期望 1）");
      _chk("预览 触发朗读", previewed);
      _chk("预览→发送 只播一次", _tot === 1, "total=" + _tot);
      if (r2 && r2.id) _testIds.push(r2.id);
      try { if (_ta.value) _ta.value = ""; } catch (e) { /* noop */ }
    } catch (e) { push("- 预览防双播异常: " + String((e && e.message) || e).slice(0, 70)); fails.push("预览防双播异常"); }
    finally { try { await game.settings.set(MOD, "typingRead", _oldTR); } catch (e) { /* noop */ } }
  }

  // C 预加载 → 发送
  if (_ta) {
    try {
      _ta.value = "预加载路径测试：先预合成再发送。";
      let pop = null; try { pop = buildSendPop(); } catch (e) { /* noop */ }
      const btn = pop && pop.querySelector(".fvtt-tts-sendpop-preload");
      if (!btn) push("- 预加载: 跳过（面板未就绪）");
      else {
        await _settle();
        const _tPlay = Date.now();
        btn.click();
        let w = 0;
        while (w < 200 && !btn.classList.contains("done")) { await _sleep(250); w++; }
        const done = btn.classList.contains("done");
        const pa = window.__fvttTTSPreloadAudio || null;
        push("- **预加载**: " + (done ? "✓ " + (w * 0.25).toFixed(1) + "s" : "✗ 超时") + " 缓存=" + ((pa && pa.url) ? "✓" : "✗"));
        _chk("预加载 完成", done);
        _chk("预加载 缓存就绪", !!(pa && pa.url));
        if (done) {
          const _idsB = new Set((((game.messages && game.messages.contents) || []).map(m => m.id)));
          btn.click();
          let msg = null;
          for (let i = 0; i < 120 && !msg; i++) { await _sleep(200); const arr = (game.messages && game.messages.contents) || []; const nw = arr.filter(m => !_idsB.has(m.id)); if (nw.length) msg = nw[nw.length - 1]; }
          if (msg && msg.id) _testIds.push(msg.id);
          let aud = false;
          for (let i = 0; i < 80 && !aud; i++) { try { const mm = game.messages.get(msg && msg.id); const f = mm && mm.flags && mm.flags[MOD]; if (f && (f.audioUrl || f.audioData)) aud = true; } catch (e) { /* noop */ } if (!aud) await _sleep(200); }
          await _sleep(700);
          const _d = _playsSince(_tPlay);
          const _paAfter = window.__fvttTTSPreloadAudio;
          push("- 预加载→发送: 消息=" + (msg ? "✓" : "✗") + " 音频=" + (aud ? "✓" : "✗") + " 播放=" + _d + " 次 | 缓存消费=" + (_paAfter ? "✗" : "✓") + " 按钮复位=" + (btn.classList.contains("done") ? "✗" : "✓"));
          _chk("预加载→发送 建立消息", !!msg);
          _chk("预加载→发送 音频写回", aud);
          _chk("预加载→发送 播放恰 1 次", _d === 1, "plays=" + _d);
          _chk("预加载→发送 缓存已消费", !_paAfter);
          _chk("预加载→发送 按钮已复位", !btn.classList.contains("done"));
          try { if (_ta.value) _ta.value = ""; } catch (e) { /* noop */ }
        }
      }
    } catch (e) { push("- 预加载异常: " + String((e && e.message) || e).slice(0, 70)); fails.push("预加载异常"); }
  }

  // D 白名单负向
  try {
    await _settle();
    const _tPlay = Date.now();
    let m = null;
    try { m = await ChatMessage.create({ content: "白名单负向测试：没有 fromModSend，不应被朗读。", speaker: { alias: cn }, flags: { [MOD]: { role: cn, lang: "zh" } } }); } catch (e) { /* noop */ }
    if (m && m.id) _testIds.push(m.id);
    let leak = false;
    for (let i = 0; i < 40; i++) { try { const mm = game.messages.get(m && m.id); const f = (mm && mm.flags && mm.flags[MOD]) || {}; if (f.audioUrl || f.audioData) { leak = true; break; } } catch (e) { /* noop */ } await _sleep(200); }
    const _d = _playsSince(_tPlay);
    push("- **白名单(负向)**: 音频=" + (leak ? "✗ 泄漏" : "✓ 无") + " 播放=" + _d + "（期望 0）");
    _chk("白名单 非模块消息无音频", !leak);
    _chk("白名单 非模块消息不播放", _d === 0, "plays=" + _d);
  } catch (e) { push("- 白名单异常: " + String((e && e.message) || e).slice(0, 60)); fails.push("白名单异常"); }

  // E 防双发
  if (_ta) {
    try {
      _ta.value = "防双发测试：同一句连点两次只应发出一条。";
      const _idsB = new Set((((game.messages && game.messages.contents) || []).map(m => m.id)));
      await Promise.allSettled([doSubmitChat(_ta), doSubmitChat(_ta)]);
      await _sleep(1500);
      const added = (((game.messages && game.messages.contents) || []).filter(m => !_idsB.has(m.id)));
      added.forEach(m => { try { _testIds.push(m.id); } catch (e) { /* noop */ } });
      try { const mid = added[0] && added[0].id; for (let i = 0; i < 120; i++) { const mm = game.messages.get(mid); const f = (mm && mm.flags && mm.flags[MOD]) || {}; if (f.audioUrl || f.audioData) break; await _sleep(200); } await _sleep(1000); } catch (e) { /* noop */ }
      push("- **防双发**: 连调 2 次 → 新增 " + added.length + " 条");
      _chk("防双发 只新增 1 条", added.length === 1, "added=" + added.length);
      try { if (_ta.value) _ta.value = ""; } catch (e) { /* noop */ }
    } catch (e) { push("- 防双发异常: " + String((e && e.message) || e).slice(0, 60)); fails.push("防双发异常"); }
  }

  // F 静默自动预加载
  if (_ta) {
    try {
      const _c = getCfg();
      if (_c.autoPreload === false || _c.engine !== "gptsovits") push("- 静默预加载: 跳过（自动预加载关/非 GPT-SoVITS）");
      else {
        const _oldTR = _c.typingRead === true;
        try { await game.settings.set(MOD, "typingRead", false); } catch (e) { /* noop */ }
        try { attachTyping(); } catch (e) { /* noop */ }
        await _settle();
        const _tPlay = Date.now();
        const _pa0 = window.__fvttTTSPreloadAudio;
        _ta.value = "静默预加载测试：应被预合成但完全不发声。";
        _ta.dispatchEvent(new Event("input", { bubbles: true }));
        let got = false;
        for (let i = 0; i < 120; i++) { await _sleep(250); if (window.__fvttTTSPreloadAudio && window.__fvttTTSPreloadAudio !== _pa0 && window.__fvttTTSPreloadAudio.url) { got = true; break; } }
        const _d = _playsSince(_tPlay);
        push("- **静默预加载**: 预合成=" + (got ? "✓" : "✗") + " 发声=" + (_d === 0 ? "✓ 无声" : "✗ " + _d + " 次"));
        _chk("静默预加载 缓存就绪", got);
        _chk("静默预加载 不发声", _d === 0, "plays=" + _d);
        try { _ta.value = ""; } catch (e) { /* noop */ }
        try { await game.settings.set(MOD, "typingRead", _oldTR); } catch (e) { /* noop */ }
      }
    } catch (e) { push("- 静默预加载异常: " + String((e && e.message) || e).slice(0, 60)); fails.push("静默预加载异常"); }
  }
  push("");

  // ============ 3 AI（有条件）============
  push("## 三、AI 路径" + (_aiOn ? "" : "（未配置 LLM → 跳过）"));
  push("");
  if (!_aiOn) {
    push("- 未配置 LLM：AI 判语气/润色/翻译 跳过（规则兜底已由核心朗读覆盖）。");
  } else {
    try {
      const s0 = await _stat(); const c0 = Number((s0 && s0.calls) || 0);
      await _settle();
      const _tPlay = Date.now();
      const ra = await _sendLine("AI 路径测试：今天真是让人意外的一天。", {}, 45000);
      await _sleep(900);
      const s1 = await _stat(); const d = Number((s1 && s1.calls) || 0) - c0;
      const fa = ra.flags || {};
      const pol = String(fa.polishText || "").trim();
      const _d = _playsSince(_tPlay);
      push("- **AI 判语气/润色**: 调用=" + Math.max(0, d) + " 次 | 槽=" + String(fa.emotion || "无") + " | 润色=" + (pol ? ("✓ " + pol.length + " 字") : "—") + " | 播放=" + _d);
      _chk("AI 判语气 至少调用 1 次", d >= 1, "calls=" + d);
      _chk("AI 路径 合成", ra.audio);
      _chk("AI 路径 播放恰 1 次", _d === 1, "plays=" + _d);
      if (cfg.llmPolish) _chk("AI 润色 已写回", !!pol);
      const rt = await svcRequest(cfg.serverUrl, "POST", "/llm/translate", { base: cfg.llmBaseUrl || "https://api.openai.com/v1", key: cfg.llmKey, model: cfg.llmModel || "gpt-4o-mini", text: "今天天气很好，我们出去散步吧。", to: "ja", gm_prompt: "" }, { timeoutMs: 30000, retries: 0, quiet: true });
      const jt = (rt && typeof rt.json === "function") ? await rt.json().catch(() => ({})) : {};
      const tt = String((jt && jt.text) || "");
      push("- **AI 翻译**: " + (tt ? ("✓ " + tt.slice(0, 22)) : "✗ " + String((jt && jt.message) || "").slice(0, 50)));
      _chk("AI 翻译端点", !!tt);
    } catch (e) { push("- AI 路径异常: " + String((e && e.message) || e).slice(0, 80)); fails.push("AI路径异常"); }
  }
  push("");

  // ============ 4 结论 ============
  _mark("结论");
  push("## 四、结论");
  const _badAll = _chkRows.filter(x => !x.ok);
  push("- 测试脚本: v10(代码版本 " + MOD_VERSION + ") | 耗时: " + Math.round((Date.now() - t0) / 1000) + "s | 断言 " + _chkRows.length + " 项");
  push("- 断言明细: " + (_badAll.length ? ("✗ " + _badAll.length + " 项失败") : "全部 ✓"));
  _badAll.forEach(x => push("  ✗ " + x.name + (x.detail ? ("（" + x.detail + "）") : "")));
  push("- 关键项: " + (fails.length ? ("⚠ 存在问题 → " + fails.join("、")) : "全部通过 ✓"));
  try { const _secTxt = Object.keys(_secMs).map(k => k + " " + _secMs[k] + "s").join(" · "); if (_secTxt) push("- 耗时明细: " + _secTxt); } catch (e) { /* noop */ }
  push("");
  if (_testIds.length && window.__fvttTTSKeepTestMsgs !== true) {
    let del = 0;
    for (const mid of _testIds) { try { const m = game.messages.get(mid); if (m && typeof m.delete === "function") { await m.delete(); del++; } } catch (e) { /* noop */ } }
    push("- 已清理测试消息: " + del + "/" + _testIds.length + " 条");
  }
  push("- 报告文件: engine\\final_test_report.md");
  const md = L.join("\n");
  try { console.warn("[gpt-sovits-tts][最终测试]\n" + md); } catch (e) { /* noop */ }
  let saved = "";
  try {
    const r = await svcRequest(cfg.serverUrl, "POST", "/diag", { type: "final-test", report: md }, { timeoutMs: 20000, retries: 0, quiet: true });
    const j = (r && typeof r.json === "function") ? await r.json().catch(() => ({})) : {};
    saved = (j && j.saved) || "";
  } catch (e) { /* noop */ }
  try { ui.notifications.info("最终测试完成(" + Math.round((Date.now() - t0) / 1000) + "s)。报告: " + (saved || "engine\\final_test_report.md")); } catch (e) { /* noop */ }
  return { markdown: md, saved: saved, fails: fails };
};

function aiJudgeEmotionNow(text, role) {
  if (window.__fvttTTSLlmBroken === true) return null;   // 1.6.51 LLM 不可达: 直接返回(不再等 4s 超时)
  const _key = String(text || "") + "|" + String(role || "");
  if (_aiEmoPro && _aiEmoPro.key === _key) return _aiEmoPro.p;
  const _p = (async () => {
    try {
      const cfg = getCfg();
      if (!cfg.llmEnabled || !cfg.llmKey) return null;
      const prof = loadVoiceProfile();
      const qcC = (quickChars && quickChars.chars || []).find(x => x.name === (role || prof.current || ""));
      let emos = ((qcC && qcC.emotions) || []).map(e => ({ key: e.key, label: e.label }));
      if (!emos.length) emos = [{key:"neutral",label:"平静"},{key:"joy",label:"喜悦"},{key:"sad",label:"悲伤"},{key:"angry",label:"愤怒"},{key:"surprised",label:"惊讶"},{key:"fear",label:"恐惧"}];
      const r = await svcRequest(cfg.serverUrl, "POST", "/llm", {
        base: cfg.llmBaseUrl || "https://api.openai.com/v1", key: cfg.llmKey, model: cfg.llmModel || "gpt-4o-mini",
        text: String(text || "").slice(0, 1200), role: role || prof.current || "", setting: (qcC && qcC.setting) || "", emotions: emos,
        style: getStylePrompt(role || prof.current || "") || "",   // 1.6.47 朗读风格作LLM判语气参考(Shinsekai式: 风格=给AI决定这句子语气)
        gm_prompt: (cfg.gmPrompt || ""),   // 1.6.89 主持人提示词(世界设定/朗读规则)
      }, { timeoutMs: 10000, retries: 0 });   // 1.6.87 判语气超时 4s→10s: DeepSeek 等外部 LLM 首字常需 3~6s, 4s 会一直超时降级; 仍不重试, 失败照旧降级规则
      const j = r.jsonSafe ? r.jsonSafe() : (r.json || {});
      if (j && j.ok && j.emotion) return String(j.emotion);
    } catch (e) { /* noop */ }
    return null;
  })();
  _aiEmoPro = { key: _key, p: _p };
  return _p;
}

Hooks.on("chatMessage", (chatLog, message, chatData) => {
    (window.__fvttTTSHooks = window.__fvttTTSHooks || {}).chatMessage = true;
    handleCommand(chatLog, message, chatData);
    // 携带说话者当前音色上下文到消息 flags → 全员用同一 ref 合成, 听到同一个声音
    try {
      const prof0 = loadVoiceProfile();
      const cur = currentVoice();
      const fl = {
        role: prof0.current || "",
        emotion: normalizeEmotionKey((cur && cur.emotion) || ""),   // 1.6.30 标准化枚举: 他端立绘分组/兜底声音调制都能认
        ttsProvider: String((cur && cur.ttsProvider) || ""),
        // 立绘路径随消息同步(跨端一致): 手动选立绘(立绘库) > 情绪分组+组内轮换 > 语气槽立绘 — 1.6.34
        selSprite: ((() => { try { const _pn = (prof0 && prof0.current) || ""; return (prof0 && prof0.chars && prof0.chars[_pn] && prof0.chars[_pn].selSprite) || ""; } catch (e) { return ""; } })()),
        avatar: (() => { try {
          const prof0n = (prof0 && prof0.current) || "";
          // 1.6.29 手动选立绘(立绘库)最高优先: 语音跟语气槽/情绪, 立绘跟这里
          const _selSp = (prof0 && prof0.chars && prof0.chars[prof0n] && prof0.chars[prof0n].selSprite) || "";
          // 1.6.36 手动选立绘也记录判定(测试报告不丢: 手动覆盖, 未测自动切换)
          if (_selSp && window.__fvttTTSSpriteDiag) {
            try {
              (window.__fvttTTSSpriteDiagList = window.__fvttTTSSpriteDiagList || []).push({ ts: Date.now(), role: prof0n, text: String(message.content || "").slice(0, 30), emo: "手动", etLines: 0, cands: 0, av: _selSp, manual: true });
              console.warn("[gpt-sovits-tts][立绘判定] 角色=" + prof0n + " 文本=" + String(message.content || "").slice(0, 24) + " | 手动选立绘=" + _selSp + "（覆盖自动切换）");
            } catch (e) { /* noop */ }
          }
          if (_selSp) return _selSp;
          const cD = (quickChars && quickChars.chars || []).find(x => x.name === prof0n);
          if (cD && Array.isArray(cD.sprites) && cD.sprites.length >= 1) {
            // 1.6.71 立绘情绪: 文本规则 → 提示词基调兜底(neutral 也兜底), 与朗读判定保持一致
            // 1.6.97 朗读提示词(每角色/每玩家独立)优先作语气→立绘同步(替代原世界级语气提示)
            let _emoS = "";
            try {
              const _stPTxt = String(getStylePrompt(prof0n) || "");
              if (_stPTxt) _emoS = styleEmotionKey(_stPTxt) || "";
            } catch (e0) { /* noop */ }
            if (!_emoS) _emoS = String(detectEmotion(String(message.content || chatData.content || ""), cur || null) || "neutral");
            if (!_emoS || _emoS === "neutral") {
              try { const _stE2 = styleEmotionKey(getStylePrompt(prof0n) || ""); if (_stE2) _emoS = _stE2; } catch (e) { /* noop */ }
            }
            const _emoList = spriteBucketForEmotion(cD.sprites, _emoS, cD.emotion_tags);
            const _rot = getSpriteRotation(prof0n + "|" + _emoS, _emoS);
            const _av = cD.sprites[_emoList[_rot % _emoList.length]];
            // 1.6.33 立绘判定诊断(立绘测试按钮自动开启, 测完自动关; 用于定位"立绘为什么不换")
            if (window.__fvttTTSSpriteDiag) {
              try {
                // 1.6.35: 判定结果收集进全局列表 → 立绘测试按钮生成报告发服务器(作者直接读文件)
                const _diagRow = { ts: Date.now(), role: prof0n, text: String(message.content || "").slice(0, 30), emo: _emoS, etLines: String(cD.emotion_tags || "").split(/\n+/).length, cands: _emoList.length, av: _av };
                (window.__fvttTTSSpriteDiagList = window.__fvttTTSSpriteDiagList || []).push(_diagRow);
                console.warn("[gpt-sovits-tts][立绘判定] 角色=" + prof0n + " 文本=" + _diagRow.text + " | 情绪=" + _emoS + " | 标注行数=" + _diagRow.etLines + " | 候选数=" + _diagRow.cands + " | 选中=" + _av);
              } catch (e) { /* noop */ }
            }
            return _av;
          }
          return (cD && cD.avatar) || (cur && cur.avatar) || "";
        } catch (e) { return ""; } })(),
        slotAvatar: (() => { try { const _pn2 = (prof0 && prof0.current) || ""; const _selSp2 = (prof0 && prof0.chars && prof0.chars[_pn2] && prof0.chars[_pn2].selSprite) || ""; return _selSp2 ? "" : ((findEmotionSlot((cur && cur.emotion) || "", _pn2) || {}).avatar || ""); } catch (e) { return ""; } })(),   // 1.6.34 手动选立绘时语气槽立绘让位
        ref: (cur && cur.ref) || "",
        auxRef: (cur && cur.auxRef) || "",
        promptText: (cur && cur.promptText) || "",
        promptLang: (cur && cur.promptLang) || "",
        emotionMix: (cur && typeof cur.emotionMix === "number") ? cur.emotionMix : 0,   // 1.6.111 0=自动
        emotionMod: (cur && typeof cur.emotionMod === "number") ? cur.emotionMod : 0,
        speed: (cur && cur.speed) || 0,
        lang: cfg.textLang || "auto",
      };
      chatData.flags = chatData.flags || {};
      chatData.flags[MODULE] = fl;
    } catch (e) { /* noop */ }
  });

Hooks.on("createChatMessage", (message, options, userId) => { (window.__fvttTTSHooks = window.__fvttTTSHooks || {}).createChat = true;
  // 🫀 心跳: pl 端响应(GM 确认通道活性); 任何人收到回执置 PingAck
  try {
    const flP = message && message.flags && message.flags[MODULE];
    if (flP && flP.speedTestPing && message.author && !message.author.isSelf) {
      try { ChatMessage.create({ content: "🫀", speaker: { alias: "心跳回执" }, flags: { [MODULE]: { speedTestPingAck: { from: game.user.name, ts: Date.now() } } } }); } catch (e) { /* noop */ }
    }
    if (flP && flP.speedTestPingAck) { try { window.__fvttTTSPingAck = true; } catch (e) { /* noop */ } }
  } catch (e) { /* noop */ }
  // 🚄 回执消息(GM/其他端): 聊天文档同步回执 → 收集进 GM 报告(可靠通道, frp HTTPS 下 socket/9881 均不可达)
  try {
    const flA = message && message.flags && message.flags[MODULE];
    if (flA && flA.speedTestAck && message.author && !message.author.isSelf) {
      try {
        window.__fvttTTSAcks = window.__fvttTTSAcks || [];
        window.__fvttTTSAcks.push({ batch: flA.speedTestAck.batch, seg: flA.speedTestAck.seg, from: flA.speedTestAck.from || message.author.name, arriveMs: flA.speedTestAck.arriveMs ?? -1, fetchMs: flA.speedTestAck.fetchMs ?? -1, played: flA.speedTestAck.played === true, bytes: flA.speedTestAck.bytes || 0, skewMs: flA.speedTestAck.skewMs ?? 0, via: flA.speedTestAck.via || "", impl: flA.speedTestAck.impl || "", err: flA.speedTestAck.err || "" });
      } catch (e) { /* noop */ }
    }
  } catch (e) { /* noop */ }
  // 🔊 普通消息音频内嵌已带(发送方本地合成/代理写回): 收到即播(Foundry 内部通道, push:false 防广播环;
  // playAudio 广播(socket 即时)已播时由 audioPlay 的 playedSrcs 去重跳过 → 双通道合一)
  try {
    const flD = message && message.flags && message.flags[MODULE];
    if (flD && flD.audioData && typeof flD.audioData === "string" && flD.audioData.length > 20 && message.author && !message.author.isSelf) {
      // 测试=实际: 速度测试消息也走同一通用播放路径(不特殊跳过); 仅回执/心跳消息无音频不播
      if (!(flD.speedTestAck || flD.speedTestPing || flD.speedTestPingAck)) {
        if (message.id && !playedIds.has(message.id)) {
          playedIds.add(message.id);
          setTimeout(() => { try { playedIds.delete(message.id); } catch (e) { /* noop */ } }, 30000);
          try { cacheAudio(message.id, flD.audioData, "audio/mpeg"); } catch (e) { /* noop */ }
          queue.enqueue({ play: () => audioPlay(flD.audioData, { volume: playVolume(), push: false }) });
        }
      }
    }
  } catch (e) { /* noop */ }
  // 🎭 立绘判定补算: createChatMessage 阶段(1.6.40+1.6.45)
  //    chatMessage hook 对 ChatMessage.create 不触发(模块发送框/立绘测试消息都没走聊天框提交, fl.avatar 不会写),
  //    1.6.45 起所有"通过本模块发送框发出"(fromModSend)的消息都在这补算立绘并写回 flags,
  //    渲染层才有 fl.avatar(话语不同→不同情绪→不同立绘)。角色取 fl.role(消息携带), 不用本机当前角色(否则GM端会算错角色立绘)
  try {
    const flV = message && message.flags && message.flags[MODULE];
    if (flV && (flV.fromModSend || flV.spriteTest || window.__fvttTTSSpriteDiag)) {
      const profV = loadVoiceProfile();
      const curV = currentVoice();
      const profVn = flV.role || ((profV && profV.current) || "");
      const _selSpV = (profV && profV.chars && profV.chars[profVn] && profV.chars[profVn].selSprite) || "";
      const cDV = (quickChars && quickChars.chars || []).find(x => x.name === profVn);
      // 1.6.71 立绘情绪: 文本规则 → 提示词基调兜底(neutral 也兜底)
      let _emoSV = String(detectEmotion(String(message.content || ""), flV.emotion ? null : curV) || "neutral");
      if (!_emoSV || _emoSV === "neutral") {
        try { const _stEV = styleEmotionKey(getStylePrompt(profVn) || ""); if (_stEV) _emoSV = _stEV; } catch (e) { /* noop */ }
      }
      const _emoListV = _selSpV ? [_selSpV] : spriteBucketForEmotion((cDV && cDV.sprites) || [], _emoSV, (cDV && cDV.emotion_tags) || "");
      const _rotV = getSpriteRotation(profVn + "|" + _emoSV, _emoSV);
      // 1.6.41 spriteBucketForEmotion 返回的是索引数组, 必须再经 sprites[索引] 取真实立绘路径(否则渲染 404 audio_export/<数字>)
      let _avV = "";
      if (_selSpV) { _avV = _selSpV; }
      else if (cDV && cDV.sprites && _emoListV && _emoListV.length) {
        const _idxV = _emoListV[_rotV % _emoListV.length];
        _avV = cDV.sprites[_idxV] || "";
      }
      if (window.__fvttTTSSpriteDiag) {
        try {
          (window.__fvttTTSSpriteDiagList = window.__fvttTTSSpriteDiagList || []).push({ ts: Date.now(), role: profVn, text: String(message.content || "").slice(0, 30), emo: _selSpV ? "手动" : _emoSV, etLines: (cDV ? String(cDV.emotion_tags || "").split(/\n+/).length : 0), cands: _emoListV.length, av: _avV, manual: !!_selSpV });
          console.warn("[gpt-sovits-tts][立绘判定] 角色=" + profVn + " 文本=" + String(message.content || "").slice(0, 24) + " | 情绪=" + (_selSpV ? "手动" : _emoSV) + " | 候选数=" + _emoListV.length + " | 选中=" + _avV);
        } catch (e) { /* noop */ }
      }
      if (_avV && flV.avatar !== _avV) {
        try { message.flags[MODULE] = message.flags[MODULE] || {}; message.flags[MODULE].avatar = _avV; message.flags[MODULE].selSprite = _selSpV || ""; } catch (e) { /* noop */ }
        try { message.update({ [`flags.${MODULE}.avatar`]: _avV, [`flags.${MODULE}.selSprite`]: _selSpV || "" }); } catch (e) { /* noop */ }
      }
    }
  } catch (e) { /* noop */ }
  // 🚄 传输测试(玩家侧): 收到测试消息立即拉取音频计时 → 回执(聊天消息可靠通道) + 直接写 pl 报告段(直连可达时)
  try {
    const flS = message && message.flags && message.flags[MODULE];
    if (flS && flS.speedTest && message.author && !message.author.isSelf) {
      const rel = flS.audioUrl || "";
      const useData = (flS.audioData && typeof flS.audioData === "string") ? flS.audioData : "";
      const msgTs = message.timestamp ? Date.parse(message.timestamp) : 0;   // Foundry 服务端时间戳(时钟一致)
      const skewMs = msgTs ? msgTs - Date.now() : 0;   // pl 时钟相对服务端偏移(负=快)
      const arriveMs = Math.max(0, Date.now() - (msgTs || flS.speedTest.ts || Date.now()));
      // 回执 helper(聊天消息 DB 同步必达 GM + socket + 直连写 pl 报告)
      const pushAck = async (fetchMs, played, bytes, err, via) => {
        const viaS = via || "";
        const implS = (() => { try { return window.__fvttTTSPlayImpl || ""; } catch (e) { return ""; } })();   // 本端实际播放实现: official=官方界面通道 / native=原生Audio
        try { window.__fvttTTSAcks = window.__fvttTTSAcks || []; window.__fvttTTSAcks.push({ batch: flS.speedTest.batch, seg: flS.speedTest.seg, arriveMs, fetchMs, played, bytes, err: err || "", skewMs, via: viaS, impl: implS }); } catch (e) { /* noop */ }
        try { if (ui && ui.notifications) ui.notifications.info(`🚄 已参与速度测试(批次${flS.speedTest.batch}段${flS.speedTest.seg}) 到达${arriveMs}ms ${fetchMs === -2 ? "内嵌即时" : "拉取" + fetchMs + "ms"} ${Math.round(bytes / 1024)}KB 播放${played ? "✓" : "跳过"}${viaS ? "·" + viaS : ""}${implS ? "·" + implS : ""}${err ? "·" + err : ""}`); } catch (e) { /* noop */ }
        try { await ChatMessage.create({ content: "⏱", speaker: { alias: "速度测试回执" }, flags: { [MODULE]: { speedTestAck: { batch: flS.speedTest.batch, seg: flS.speedTest.seg, from: game.user.name, arriveMs, fetchMs, played, bytes, skewMs, via: viaS, impl: implS, err: String(err || "").slice(0, 60), ts: Date.now() } } } }); } catch (e) { /* noop */ }
        try { game.socket.emit(MODULE, { type: "speedtest-ack", batch: flS.speedTest.batch, seg: flS.speedTest.seg, from: game.user.name, arriveMs, fetchMs, played, bytes, skewMs, via: viaS, impl: implS, err: String(err || "").slice(0, 60) }); } catch (e) { /* noop */ }
        try { svcRequest(getCfg().serverUrl, "POST", "/speedtest/report", { user: (game.user && game.user.name) || "pl", ts: Date.now(), role: "player", batch: flS.speedTest.batch, seg: flS.speedTest.seg, arriveMs, fetchMs, played, bytes, skewMs, via: viaS, impl: implS, err: String(err || "").slice(0, 60), canDirect: window.__fvttTTSCanDirect === true }).catch(() => { /* 代理不可达已由聊天回执通道兜底 */ }); } catch (e) { /* noop */ }
      };
      // 写回前到达(speak/代理合成的 audioData 尚未同步到本端 — create 先于写回): 轮询等写回,
      // 直到 audioData/audioUrl 真到(覆盖慢合成, 如 26s 长段)才回执真实播放结果; 45s 上限防卡死
      if (!useData && !rel) {
        (async () => {
          let fetchMs2 = -2;
          let bytes2 = 0;
          let err2 = "";
          const tStart = Date.now();
          const tryRead = async () => {
            const mm = game.messages.get(message.id);
            const flNow = (mm && mm.flags && mm.flags[MODULE]) || {};
            const d2 = (flNow.audioData && typeof flNow.audioData === "string") ? flNow.audioData : "";
            const r2 = flNow.audioUrl || "";
            if (!d2 && !r2) return null;
            if (d2) {
              bytes2 = Math.floor(((d2.length - (d2.indexOf(",") + 1)) * 3) / 4) || 0;
              let played2 = playedIds.has(message.id);
              try { if (window.__fvttTTSPlayedSrcs && window.__fvttTTSPlayedSrcs.has(d2)) played2 = true; } catch (e) { /* noop */ }
              // 判定该段实际走了哪条通道: 官方内部通道(fileURL 已即时播) 还是 DB 内嵌兜底
              let via2 = "db";
              try {
                const rel3 = flNow.audioUrl || "";
                const c3 = rel3 ? _modulePath(rel3) : "";
                if (c3 && window.__fvttTTSOfficialSrcs && window.__fvttTTSOfficialSrcs.has(c3)) via2 = "official";
              } catch (e) { /* noop */ }
              if (!played2 && window.__fvttTTSMutedFlag !== true && typeof audioPlay === "function") {
                try { playedIds.add(message.id); setTimeout(() => { try { playedIds.delete(message.id); } catch (e) { /* noop */ } }, 30000); await audioPlay(d2, { volume: 0.5, push: false }); played2 = true; } catch (e) { err2 = "pl-play:" + String(e && e.message || e).slice(0, 40); }
              } else played2 = true;   // updateChatMessage/广播已真实播放
              await pushAck(fetchMs2, played2, bytes2, err2, via2);
              return true;
            }
            // audioUrl 兜底拉取(fetch 转 data URI 播放; 远程证书问题如实回执)
            const full2 = /^https?:\/\//i.test(r2) ? r2
              : (r2.startsWith("/modules/") || r2.startsWith("/data/")) ? new URL(r2, window.location.origin).href
              : `${getCfg().serverUrl.replace(/\/+$/, "")}${r2}`;
            try {
              const tF2 = Date.now();
              const resp = await fetch(full2, { signal: AbortSignal.timeout(15000) });
              const buf = await resp.arrayBuffer();
              fetchMs2 = Date.now() - tF2; bytes2 = (buf && buf.byteLength) || 0;
              let played2 = playedIds.has(message.id);
              if (!played2 && window.__fvttTTSMutedFlag !== true && typeof audioPlay === "function") {
                try { playedIds.add(message.id); setTimeout(() => { try { playedIds.delete(message.id); } catch (e) { /* noop */ } }, 30000); await audioPlay(full2, { volume: 0.5, push: false }); played2 = true; } catch (e) { err2 = "pl-play:" + String(e && e.message || e).slice(0, 40); }
              } else played2 = true;
              await pushAck(fetchMs2, played2, bytes2, err2, "url");
              return true;
            } catch (e) { await pushAck(fetchMs2, false, 0, "fetch:" + String(e && e.message || e).slice(0, 40), "url"); return true; }
          };
          let done = false;
          while (!done && Date.now() - tStart < 45000) {
            try { const r = await tryRead(); if (r) done = true; } catch (e) { /* noop */ }
            if (!done) await new Promise(res => setTimeout(res, 500));
          }
          if (!done) await pushAck(fetchMs2, playedIds.has(message.id), 0, "timeout-45s");
        })();
        return;   // 写回前到达: 轮询等写回后回执(不再固定延时, 慢合成也能对齐)
      }
      // 🔊 播放与实际说话同一路径: 通用 audioData 播放(createChatMessage/updateChatMessage)或
      // playAudio 广播(GM 端 push)已安排; 本分支仅: ① 检测通用路径是否已播(playedIds 登记)
      // ② 未播时兜底补播(同一 audioPlay, push:false 防环) ③ 计时回执
      (async () => {
        let played = playedIds.has(message.id);   // 通用路径已登记 = 播放已安排(测试=实际)
        let fetchMs = -2;   // 内嵌即时(默认; fetch 兜底时记录实际)
        let bytes = 0;
        if (useData) {
          bytes = Math.floor(((useData.length - (useData.indexOf(",") + 1)) * 3) / 4) || 0;   // base64 估字节
          if (!played && window.__fvttTTSMutedFlag !== true && typeof audioPlay === "function") {
            try {
              playedIds.add(message.id);
              setTimeout(() => { try { playedIds.delete(message.id); } catch (e) { /* noop */ } }, 30000);
              await audioPlay(useData, { volume: 0.5, push: false });
              played = true;
            } catch (e) { /* 播放失败不阻塞回执 */ }
          }
        } else if (rel) {
          const full = /^https?:\/\//i.test(rel) ? rel
            : (rel.startsWith("/modules/") || rel.startsWith("/data/")) ? new URL(rel, window.location.origin).href
            : `${getCfg().serverUrl.replace(/\/+$/, "")}${rel}`;
          const tF = Date.now();
          try {
            const resp = await fetch(full, { signal: AbortSignal.timeout(15000) });
            const buf = await resp.arrayBuffer();
            fetchMs = Date.now() - tF;
            bytes = (buf && buf.byteLength) || 0;
            if (!played && window.__fvttTTSMutedFlag !== true && typeof audioPlay === "function") {
              try {
                playedIds.add(message.id);
                setTimeout(() => { try { playedIds.delete(message.id); } catch (e) { /* noop */ } }, 30000);
                await audioPlay(full, { volume: 0.5, push: false });
                played = true;
              } catch (e) { /* 播放失败不阻塞回执 */ }
            }
          } catch (e) { try { if (ui && ui.notifications) ui.notifications.warn("🚄 速度测试拉取失败(批次" + flS.speedTest.batch + ")"); } catch (e2) { /* noop */ } }
        }
        await pushAck(fetchMs, played, bytes, "", useData ? "db" : "url");
      })();
    }
  } catch (e) { /* noop */ }
  // ⚠ 1.6.103 这里必须 catch: 朗读链路里任何未捕获异常都会让"合成 + 写回 + 立绘"整条断掉,
  //   而 hook 里的 Promise 拒绝只会在控制台留一行红字, 表现为"没声音/没立绘"却看不出原因(1.6.99 的 flA 就是这么炸的)。
  // 1.6.105 耗时日志: 一句消息从"进入朗读"到"音频写回/播放"的总耗时 + 其中 AI 判语气占多少(排查"特别慢")
  const _tMsg0 = Date.now();
  try {
    maybeSpeak(message).then(() => {
      try {
        const _tot = Date.now() - _tMsg0;
        const _ai = Number(window.__fvttTTSJudgeMs) || 0;
        window.__fvttTTSLastTiming = { totalMs: _tot, judgeMs: _ai, at: Date.now() };
        console.info("[gpt-sovits-tts] 本句耗时 " + (_tot / 1000).toFixed(1) + "s（AI 判语气 " + (_ai / 1000).toFixed(1) + "s，其余≈合成/写回/播放）");
      } catch (e2) { /* noop */ }
    }).catch(e => reportSpeakCrash(e));
  } catch (e) { reportSpeakCrash(e); }
  try { maybePickAvatarRole(message); } catch (e) { /* noop */ }
});

// 朗读链路异常上报: 每会话提示一次 + 控制台完整堆栈(含"这是模块 bug, 请把这段发给作者")
function reportSpeakCrash(e) {
  try {
    const msg = String((e && (e.stack || e.message)) || e);
    if (window.__fvttTTSCrashSilent !== true) console.error("[gpt-sovits-tts] 朗读链路异常(本次消息不会出声/不会有立绘):\n" + msg);   // 1.6.125 自检探针时静默
    try { (window.__fvttTTSCrashList = window.__fvttTTSCrashList || []).push({ ts: Date.now(), msg: msg.slice(0, 500) }); } catch (e2) { /* noop */ }
    if (window.__fvttTTSCrashNotified !== true) {
      window.__fvttTTSCrashNotified = true;
      try { ui.notifications.error("语音朗读出错(模块 bug): " + msg.split("\n")[0].slice(0, 110) + " —— 详情见 F12 控制台"); } catch (e2) { /* noop */ }
    }
  } catch (e2) { /* noop */ }
}

// GM 代理合成(统一通道, 覆盖 HTTPS 穿透/跨网/9881 不可达/低配服务器): 核心逻辑提取为 _proxySynthFor —
// createChatMessage hook 与自检(端到端实测)共用, 保证"代理能否合成+写回"可直接从自检报告确认
async function _proxySynthFor(message) {
  const fl2 = (message && message.flags && message.flags[MODULE]) || {};
  const req = fl2.synthRequest || {};
  if (!req.text) return { ok: false, err: "no-synth-request" };
  // 已有音频(作者端预加载写回/其他端已代合成) → 跳过代合成, 防双写/双语音(相同声音两个文件 → 全员播两遍)
  if (fl2.audioUrl || fl2.audioData) return { ok: true, skipped: "audio-exists" };
  try {
    const cfg = getCfg();
    const lang = String(req.lang || "zh") || "zh";
    // 音色: 用消息 flags 携带的完整角色参数合成(参考音频/提示词/情绪占比) — 代理合成与原作者同音色, 全员听到同一个声音
    const o = {};
    if (fl2.ref) o.refAudioPath = fl2.ref;
    if (fl2.promptText) o.promptText = fl2.promptText;
    if (fl2.promptLang) o.promptLang = fl2.promptLang;
    if (fl2.auxRef) o.auxRefAudioPaths = [fl2.auxRef];
    if (typeof fl2.emotionMix === "number") o.emotionMix = fl2.emotionMix;
    if (fl2.emotion) o.emotion = fl2.emotion;   // 1.6.20 情绪后处理(作者端判好的情绪 → 代理合成同语气)
    // 1.6.109/1.6.112 玩家端代理合成同样规范化占比(单一来源): 否则只有 GM 听到语气
    normalizeEmotionMix(o);
    // 1.6.152 代理合成同样使用引擎机(本端)的质量旋钮, 才能与"本机自己说话"听感一致
    try {
      const _ssG = Number(cfg.sampleSteps);
      if (Number.isFinite(_ssG) && _ssG !== 32) o.sampleSteps = Math.max(4, Math.min(48, Math.round(_ssG)));
      if (cfg.superSampling === true) o.superSampling = true;
    } catch (e) { /* noop */ }
    const t0 = Date.now();
    const _pprov = String(fl2.ttsProvider || req.provider || "gpt-sovits");
    let res;
    if (_pprov === "edge" || _pprov === "web") {
      // 多引擎: edge/web 角色 → 服务器转发微软在线合成(低负载); 不依赖本地 GPT-SoVITS 模型
      res = await synthEdge(String(req.text), lang, { serverUrl: cfg.serverUrl, speedFactor: Number(req.speed) || 1.0, asBlob: true });
    } else {
      res = await gptSovitsSynth(String(req.text), lang, { serverUrl: cfg.serverUrl, speedFactor: Number(req.speed) || 1.0, overrides: o, mediaType: "mp3", asBlob: true, role: String(fl2.role || "") });
    }
    const audioUrl = res.audioUrl || "";
    const out = { ok: !!audioUrl, ms: Date.now() - t0, audioUrl: audioUrl || "", text: String(req.text).slice(0, 40) };
    // 写回前竞态复查: 合成期间作者端已写回音频(预加载) → 放弃本次写回, 防止双音频双播放
    try {
      const _mN = (message && typeof message.getFlag === "function") ? await message.getFlag(MODULE, "audioUrl").catch(() => null) : null;
      const _mD = (message && typeof message.getFlag === "function") ? await message.getFlag(MODULE, "audioData").catch(() => null) : null;
      if (_mN || _mD) return { ok: true, skipped: "audio-exists-race", ms: Date.now() - t0 };
    } catch (e) { /* noop */ }
    if (audioUrl && message && message.id && typeof message.update === "function") {
      const rel = audioUrl.startsWith("http") ? new URL(audioUrl).pathname : audioUrl;
      const upd = { "flags.gpt-sovits-tts.audioUrl": rel, "flags.gpt-sovits-tts.synthResult": "ok" };
      // 🔊 音频内嵌(Foundry 内部通道): 全员收到消息即播, 零二次拉取
      try {
        if (res.blob && res.blob.size > 0 && res.blob.size <= 120000) {
          const _b64 = await blobToBase64(res.blob);
          if (_b64 && _b64.length < 400000) upd["flags.gpt-sovits-tts.audioData"] = "data:audio/mpeg;base64," + _b64;
        }
      } catch (e) { /* noop */ }
      try { await message.update(upd); out.flagsWritten = true; } catch (e) { out.flagsWritten = false; }
    }
    return out;
  } catch (e) { return { ok: false, err: String(e).slice(0, 80), ms: 0 }; }
}
Hooks.on("createChatMessage", (message) => {
  try {
    if (!message || !message.flags) return;
    const fl = message.flags[MODULE];
    if (!fl || !fl.synthRequest) return;
    if (!game.user || game.user.isGM !== true) return;            // 仅 GM 端执行代理
    if (message.author && message.author.id === game.user.id) return;   // 自己的消息(GM 直连合成, 不走代理)
    (window.__fvttTTSHooks = window.__fvttTTSHooks || {}).createChatProxy = true;
    (async () => {
      const res = await _proxySynthFor(message);
      if (!res.ok && !res.flagsWritten && message.id && typeof message.update === "function") {
        try { await message.update({ "flags.gpt-sovits-tts.synthResult": "fail:" + String(res.err || "proxy-fail").slice(0, 60) }); } catch (e2) { /* noop */ }
      }
    })();
  } catch (e) { /* noop */ }
});

// 填完 LLM API 网址/密钥保存后, 自动拉取可用模型 → 设置页里模型下拉自动出现可选项
Hooks.on("updateSetting", (setting, data, options, userId) => {
  (window.__fvttTTSHooks = window.__fvttTTSHooks || {}).updateSetting = true;
  // 1.6.149 修: v13 的 updateSetting 传的是 Setting 文档(有 .key/.value), 旧写法当字符串比较 → 两条功能静默失效。
  //   兼容两种签名: 文档对象 或 (key, value) 字符串旧版。
  const _k = (setting && setting.key) ? String(setting.key) : (typeof setting === "string" ? setting : "");
  const _nv = (setting && typeof setting === "object" && "value" in setting) ? setting.value
    : (data && typeof data === "object" && "value" in data ? data.value : data);
  // GM 改"同时运行上限" → 立即同步服务端模型池(裁剪/扩容), 仅 GM 生效(pl 只读)
  if (_k === `${MODULE}.maxConcurrentModels`) {
    try {
      if (game.user && game.user.isGM) {
        svcRequest(getCfg().serverUrl, "POST", "/config", { max_concurrent_models: Number(_nv) || 10 }).catch(() => { /* noop */ });
      }
    } catch (e) { /* noop */ }
  }
  if (_k !== `${MODULE}.llmKey` && _k !== `${MODULE}.llmBaseUrl`) return;
  setTimeout(() => { fetchAndRefreshModels(true).catch(() => {}); }, 300);
});
// 打开设置页: 给"API 地址/密钥"输入框挂实时监听 → 输入过程中即自动检测模型并更新下方"LLM 模型"下拉
Hooks.on("renderSettingsConfig", (app, html) => {
  setTimeout(() => {
    try {
      const root = (html && html[0]) ? html[0] : html;
      let timer = null;
      ["llmBaseUrl", "llmKey"].forEach(k => {
        // name 后缀匹配(兼容 Foundry 不同版本的表单命名)
        const inp = root.querySelector(`input[name$=".${k}"]`);
        if (!inp) return;
        let st = null;
        if (inp.parentElement) {
          st = inp.parentElement.querySelector(".fvtt-tts-ai-settings-status");
          if (!st) {
            st = document.createElement("span");
            st.className = "fvtt-tts-ai-settings-status";
            st.style.cssText = "margin-left:8px;color:#9c9;font-size:11px;white-space:nowrap;";
            inp.parentElement.appendChild(st);
          }
        }
        const run = () => {
          clearTimeout(timer);
          timer = setTimeout(async () => {
            try {
              if (st) st.textContent = "⚡ 检测中…";
              const ok = await fetchAndRefreshModels(true);
              if (st) st.textContent = ok ? "✓ 模型已更新" : "✗ 检测失败";
            } catch (e) { if (st) st.textContent = "✗ 检测失败"; }
          }, 700);
        };
        inp.addEventListener("input", run);
        inp.addEventListener("change", run);
      });
      // 打开设置页且已启用 LLM → 刷新一次模型缓存
      const en = !!game.settings.get(MODULE, "llmEnabled");
      const key = game.settings.get(MODULE, "llmKey") || "";
      if (en && key) fetchAndRefreshModels(false).catch(() => {});
    } catch (e) { /* noop */ }
  }, 400);
});

// v13 起 renderChatMessage 废弃, 改用 renderChatMessageHTML(传 HTMLElement); v11/12 用旧 hook
// 注意: game.version 在 v13 是字符串("13.351"), 不能 typeof number 判断
const _fv = typeof game.version === "number" ? game.version : (parseInt(String(game.version || "0"), 10) || 0);
// 导入进度条(1.6.16): 全局悬浮进度条 — 进度 + 百分比 + 预计剩余时间(线性外推 + EMA 平滑, 防抖动)
let _impProg = null, _impProgStart = 0, _impProgEma = -1, _impFirst = true;
function _ensureImportBar() {
  if (_impProg && document.body.contains(_impProg)) return _impProg;
  const box = document.createElement("div");
  box.style.cssText = "position:fixed;right:16px;bottom:56px;z-index:99999;width:270px;background:rgba(20,20,24,.93);border:1px solid rgba(255,255,255,.16);border-radius:8px;padding:8px 10px;font:12px/1.4 system-ui,sans-serif;color:#eee;box-shadow:0 2px 10px rgba(0,0,0,.45);display:none;";
  box.innerHTML = '<div style="display:flex;justify-content:space-between;margin-bottom:5px;"><span class="lbl">导入中…</span><span class="pct">0%</span></div><div style="height:8px;border-radius:4px;background:rgba(255,255,255,.15);overflow:hidden;"><div class="bar" style="height:100%;width:0%;background:#7aa2f7;border-radius:4px;transition:width .18s;"></div></div><div class="eta" style="margin-top:4px;color:#9aa;font-size:11px;">预计剩余: --</div>';
  document.body.appendChild(box);
  _impProg = box;
  return box;
}
function showImportProgress(label, p) {
  try {
    const box = _ensureImportBar();
    box.style.display = "block";
    const now = Date.now();
    // 每次导入(隐藏后重新显示)都重新计时 — 否则 _impProgStart 残留 0(模块加载时刻) → "现在-0"溢出成天文数字
    if (_impFirst) { _impProgStart = now; _impProgEma = -1; _impFirst = false; }
    const pct = Math.max(0, Math.min(1, p));
    box.querySelector(".lbl").textContent = label || "导入中…";
    box.querySelector(".pct").textContent = Math.round(pct * 100) + "%";
    box.querySelector(".bar").style.width = (pct * 100) + "%";
    const el = now - _impProgStart;
    if (el > 1000 && pct > 0.03) {
      const est = el * (1 - pct) / pct;
      _impProgEma = _impProgEma < 0 ? est : _impProgEma * 0.7 + est * 0.3;
      let sec = Math.max(0, Math.round(_impProgEma / 1000));
      if (sec > 6 * 3600) box.querySelector(".eta").textContent = "预计剩余: 尚久(可能卡在传输)";
      else box.querySelector(".eta").textContent = "预计剩余: " + (sec >= 60 ? Math.floor(sec / 60) + " 分 " + (sec % 60) + " 秒" : sec + " 秒");
    } else {
      box.querySelector(".eta").textContent = "预计剩余: --";
    }
  } catch (e) { /* noop */ }
}
function hideImportProgress() {
  try { if (_impProg) _impProg.style.display = "none"; } catch (e) { /* noop */ }
  _impFirst = true;   // 下次导入重新计时
}
try { window.__fvttTTSSetImportProgress = showImportProgress; window.__fvttTTSHideImportProgress = hideImportProgress; } catch (e) { /* noop */ }

// 聊天附件角色包检测(1.6.15): 消息 content 带 .char 附件链接(FVTT"选择文档"上传的角色包) → fetch 后分片自动导入。
// create/update/render 全路径调用(防"选择文档上传"走 create 不被 update 检测到)。同附件只导一次。
function _detectCharAttachment(message) {
  try {
    const _content = String((message && message.content) || (message && message.data && message.data.content) || "");
    const _charM = _content.match(/[^"'<>\\\s]+\.char(\?[^\s"'<>\\]*)?/i);
    if (!_charM) return;
    const _url = _charM[0];
    window.__fvttTTSCharImportSet = window.__fvttTTSCharImportSet || new Set();
    if (window.__fvttTTSCharImportSet.has(_url)) return;
    window.__fvttTTSCharImportSet.add(_url);
    (async () => {
      try {
        notifyOnce("检测到角色包附件, 自动导入中…", "info");
        const resp = await fetch(_url);
        if (!resp.ok) { notifyOnce("角色包下载失败: " + resp.status, "error"); return; }
        const ab = await resp.arrayBuffer();
        if (ab.byteLength > 512 * 1024 * 1024) { notifyOnce("角色包过大(>512MB), 请用语音管理器导入按钮", "error"); return; }
        const f = new File([ab], _url.split("/").pop().split("?")[0] || "import.char", { type: "application/octet-stream" });
        const _fn = window.__fvttTTSImportCharDrop;
        if (typeof _fn === "function") await _fn(f);
        else notifyOnce("导入器未就绪, 请稍后或使用语音管理器导入", "error");
      } catch (e) { try { notifyOnce("角色包自动导入失败: " + String((e && e.message) || e).slice(0, 120), "error"); } catch (e2) { /* noop */ } }
    })();
  } catch (e) { /* noop */ }
}

// 立绘插入: 立即插 + 250ms 延迟补插(等 Foundry/系统后续渲染完成后重插, 防止图被渲染流程冲掉)
// 自检 manualApply 已证明: 对"已挂载的消息元素"调用必然成功, 所以补插必须用 message.element(挂载后)
function _applyAvatarWithRetry(message, html) {
  _detectCharAttachment(message);
  addReplayButton(message, html);
  applyEmotionAvatar(message, html);
  setTimeout(() => {
    try {
      const el2 = (message && message.element) || (message && document.querySelector(`.message[data-message-id="${message.id}"]`));
      if (el2) applyEmotionAvatar(message, el2);
    } catch (e) { /* noop */ }
  }, 250);
}
if (_fv >= 13) {
  Hooks.on("renderChatMessageHTML", (message, html) => { (window.__fvttTTSHooks = window.__fvttTTSHooks || {}).renderChat = true; _applyAvatarWithRetry(message, html); });
} else {
  Hooks.on("renderChatMessage", (message, html) => { (window.__fvttTTSHooks = window.__fvttTTSHooks || {}).renderChat = true; _applyAvatarWithRetry(message, html); });
}
// 聊天同步播放(主通道, 替代依赖 socket 广播): 发送方合成后把音频 Foundry 路径写回消息 flags,
// 聊天文档同步是数据库级(可靠) → 其他客户端(pl)收到 update 立即播放 — socket 广播不通/延迟时不再等 15s 兜底
// 新消息(create)也检测附件角色包 — "选择文档"上传的消息走 create 不触发 update, 1.6.15 全路径覆盖
Hooks.on("createChatMessage", (message) => { try { _detectCharAttachment(message); } catch (e) { /* noop */ } });
// AI 选立绘(1.6.24): 异步 LLM 按台词+角色提示词判情绪 → 按情绪分组重算立绘写回消息(跨端一致) + 本端即时重插;
// LLM 慢/失败则保留发送时的规则立绘(不阻塞聊天)
Hooks.on("createChatMessage", (message) => {
  try {
    const _fl = (message && message.flags && message.flags[MODULE]) || {};
    const _roleN = _fl.role || "";
    if (!_roleN || !message || !message.content) return;
    // 1.6.105/1.6.114 本句语气+立绘由"朗读链路(assess)"统一决定, 这里不再重复调 LLM:
    //   ① 模块发送框(fromModSend)的消息一定走 assess → 直接跳过(AI 判定结果由 assess 写回)
    //   ② 其他来源的消息若已带 aiDecided 标记也跳过
    //   以前 aiDecided 是异步写的, 这个 hook 在 create 时读到的是 false → 每条消息仍会多调一次 /llm(实测 6 条场景共 19 次调用)
    if (_fl.fromModSend || _fl.aiDecided) { try { console.debug("[gpt-sovits-tts] 语气/立绘已由朗读链路判定, 跳过重复 AI 调用" + (_fl.fromModSend ? "(模块发送)" : "(aiDecided)")); } catch (e) { /* noop */ } return; }
    (async () => {
      try {
        const _e = await aiJudgeEmotionNow(String(message.content), _roleN);
        if (!_e) return;
        // 1.6.29 手动选立绘(立绘库)优先, AI 不覆盖
        const profAi = loadVoiceProfile();
        if (profAi && profAi.chars && profAi.chars[_roleN] && profAi.chars[_roleN].selSprite) return;
        const cD = (quickChars && quickChars.chars || []).find(x => x.name === _roleN);
        if (!cD || !Array.isArray(cD.sprites) || !cD.sprites.length) return;
        // 1.6.96 AI 返回的可能是情绪槽 key(voice_03) — 立绘匹配需要的是中文标签(生气) → 先转成标签
        let _eLabel = String(_e || "");
        try {
          const _hitSlot = ((cD.emotions || []).find(s => s && (String(s.key) === String(_e) || String(s.label) === String(_e))));
          if (_hitSlot) _eLabel = String(_hitSlot.label || _hitSlot.key || _e);
        } catch (e2) { /* noop */ }
        // 1.6.98 立绘匹配用的是英文情绪枚举(emoTagWords 只认 joy/sad/angry...) → 把中文标签归一化
        try { _eLabel = normalizeEmotionKey(_eLabel); } catch (e2) { /* noop */ }
        // 1.6.98 朗读提示词(语气提示)的情绪优先, 保证"立绘与朗读提示词同步"
        try {
          const _stE4 = styleEmotionKey(String(getStylePrompt(_roleN) || ""));
          if (_stE4) _eLabel = _stE4;
        } catch (e2) { /* noop */ }
        const _emoList = spriteBucketForEmotion(cD.sprites, _eLabel, cD.emotion_tags);
        const _rot = getSpriteRotation(_roleN + "|" + _eLabel + "|ai", _eLabel);
        if (!Array.isArray(_emoList) || !_emoList.length) return;
        const _av = cD.sprites[_emoList[_rot % _emoList.length]];
        if (!_av) return;
        // 1.6.101 写回改为点路径 + 只写本次字段: 原先用 create 时的 _fl 快照整体覆盖 flags,
        //   与 speak() 稍后写回的 audioUrl/audioData 竞争, 可能把音频写回冲掉(表现为"有声音但没立绘")
        const _upd = {};
        _upd[`flags.${MODULE}.emotion`] = _e;
        _upd[`flags.${MODULE}.avatar`] = _av;
        _upd[`flags.${MODULE}.aiSprite`] = _av;
        await message.update(_upd).catch(() => {});
        try { if (message.element) applyEmotionAvatar(message, message.element); } catch (e2) { /* noop */ }
      } catch (e) { /* noop */ }
    })();
  } catch (e) { /* noop */ }
});
Hooks.on("updateChatMessage", (message, changed) => {
  try {
    (window.__fvttTTSHooks = window.__fvttTTSHooks || {}).updateChat = true;
    if (!message || !changed) return;
    // 聊天附件角色包检测(create/update/render 全路径, 1.6.15): 消息带 .char 附件链接 → 自动分片导入
    _detectCharAttachment(message);
    const flags = (message.flags && message.flags[MODULE]) || {};
    const hasUrl = (changed["flags.gpt-sovits-tts.audioUrl"] != null)
      || (changed["flags.gpt-sovits-tts.audioData"] != null)
      || (changed.flags && changed.flags[MODULE] && (changed.flags[MODULE].audioUrl != null || changed.flags[MODULE].audioData != null))
      || flags.audioUrl
      || flags.audioData;
    // ⚠️ 2026-10-09 修复: hasUrl(消息带音频) 绝不能当"本机已播"跳过 —— 否则 GM 合成写回 audioData 后
    // 他端 update hook 永远跳过, 其他设备听不到任何语音("其他设备完全没声音"根因)。hasUrl=true 时继续走下方播放。
    if (!message.id) return;
    if (!hasUrl) return;
    // (原: 作者是自己→跳过) 改为: 仅当本机真的已播过(playedIds)才跳过 —
    // 同账号多连接(其他设备登录同一 GM)时 author.isSelf 对所有连接都为 true, 会造成"只有本机有声";
    // 去重改由 playedIds(本机已播登记) + audioPlay 同 src 去重(__fvttTTSPlayedSrcs) 双重保证: 本机不重复, 他端不漏播
    if (flags.speedTestAck) return;   // 回执消息无音频; 速度测试消息不跳过(测试=实际, 走同一播放路径, create 时已登记 playedIds 防重复)
    if (playedIds.has(message.id)) return;   // socket 广播/本地已播过则不重复
    // 官方 playAudio 广播已播(src 规范化键命中) → 跳过 — 根治"官方广播(1.3.9 push) + flags 写回"双播:
    // GM 说话 → 全员官方广播播一次 + flags 写回 → 本端 update hook 又来一次 → 此处拦截第二次
    try {
      const _plk = (() => {
        try {
          if (flags.audioUrl) return normPlayKey(flags.audioUrl);
          if (flags.audioData && typeof flags.audioData === "string") return normPlayKey(flags.audioData);
          return "";
        } catch (e) { return ""; }
      })();
      if (_plk && hasPlayedSrc(_plk)) {
        try { playedIds.add(message.id); setTimeout(() => { try { playedIds.delete(message.id); } catch (e) { /* noop */ } }, 30000); } catch (e) { /* noop */ }
        return;
      }
    } catch (e) { /* noop */ }
    playedIds.add(message.id);   // 先登记(防 flags 再次 update 的 fetch 竞态重复); 拉取失败再放行重试
    setTimeout(() => { try { playedIds.delete(message.id); } catch (e) { /* noop */ } }, 30000);
    // 🔊 统一走 FVTT 内部(界面)语音通道: 消息带 Foundry 静态路径(audioUrl, 相对 /modules/...) → 官方 AudioHelper 播放
    // (与 GM 官方广播同 src → audioPlay 同 src 自动去重, 不会重复; 本端官方界面通道、无 400ms 等待);
    // 仅当无文件路径(纯 dataURI)时才原生 Audio 兜底。
    if (flags.audioData || flags.audioUrl) {
      try { if (pendingTts.has(message.id)) pendingTts.delete(message.id); } catch (e) { /* noop */ }
      // 立绘跟随朗读: 写回完成(有音频) → 补插立绘(渲染时无音频未插; 同消息只插一次, 幂等)
      try { if (message && message.element) applyEmotionAvatar(message, message.element); } catch (e) { /* noop */ }
      const reluc = (flags.audioUrl && typeof flags.audioUrl === "string") ? (() => {
        // 官方 Sound 需要可加载 URL: 用本端自己的 origin 解析成绝对 URL(同源必达), 保证 Sound 真能加载播放
        const _rp = _modulePath(flags.audioUrl);
        if (!_rp) return "";
        try { return new URL(_rp, window.location.origin).href; } catch (e) { return _rp; }
      })() : "";
      if (reluc) {
        try { if (message.id) cacheAudio(message.id, reluc, "audio/mpeg"); } catch (e) { /* noop */ }
        try { queue.enqueue({ play: () => audioPlay(reluc, { volume: playVolume(), push: false }) }); return; } catch (e) { /* noop */ }
      }
      if (flags.audioData && typeof flags.audioData === "string" && flags.audioData.length > 20) {
        try { if (message.id) cacheAudio(message.id, flags.audioData, "audio/mpeg"); } catch (e) { /* noop */ }
        try { queue.enqueue({ play: () => audioPlay(flags.audioData, { volume: playVolume(), push: false }) }); } catch (e) { /* noop */ }
      }
      return;
    }
    const rel = flags.audioUrl || "";
    if (!rel) return;
    const full = /^https?:\/\//i.test(rel) ? rel
      : (rel.startsWith("/modules/") || rel.startsWith("/data/")) ? new URL(rel, window.location.origin).href
      : `${getCfg().serverUrl.replace(/\/+$/, "")}${rel}`;
    fetch(full, { signal: AbortSignal.timeout(15000) })
      .then(r => { if (!r.ok) throw new Error("audio fetch " + r.status); return r.blob(); })
      .then(b => {
        // 兜底拉取也转 data URI 再播(跨端有效, 与内嵌通道一致走 Foundry 界面音频系统)
        b.arrayBuffer().then((ab) => {
          const bytes = new Uint8Array(ab);
          let bin = "";
          for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
          const u = "data:audio/mpeg;base64," + btoa(bin);
          if (message.id) cacheAudio(message.id, u, "audio/mpeg");
          playedIds.add(message.id);
          setTimeout(() => { try { playedIds.delete(message.id); } catch (e) { /* noop */ } }, 30000);
          try { if (pendingTts.has(message.id)) pendingTts.delete(message.id); } catch (e) { /* noop */ }   // 清 pending(代理哨兵/15s 兜底): flags 已送达即播放, 不再重复
          queue.enqueue({ play: () => audioPlay(u, { volume: playVolume(), push: false }) });
        }).catch(() => { try { playedIds.delete(message.id); } catch (e) { /* noop */ } });
      })
      .catch(() => { try { playedIds.delete(message.id); } catch (e) { /* noop */ } /* 拉取失败: 放行(15s 兜底(直连模式)或等待 GM(代理模式)) */ });
  } catch (e) { /* noop */ }
});
// 页面就绪后: 给已加载的历史消息全量补插立绘(历史消息渲染时若立绘被冲掉/或渲染不触发 hook, 这里一次性补齐)
setTimeout(() => {
  try {
    if (game.messages && game.messages.contents) {
      game.messages.contents.forEach((m) => {
        try {
          const el3 = m.element || (m.id && document.querySelector(`.message[data-message-id="${m.id}"]`));
          if (el3) applyEmotionAvatar(m, el3);
        } catch (e) { /* noop */ }
      });
    }
  } catch (e) { /* noop */ }
}, 1500);

// 角色指示物: 悬浮条角色下拉旁显示当前绑定角色的立绘小图标(随角色切换)
// 注意: 只做悬浮条内的内联插入(flex 子项), 绝不修改任何宿主的 position/布局 —
//       之前对 #fvtt-tts-floatbar 和 #chat-form 设 style.position 覆盖了 fixed 定位,
//       导致悬浮窗消失/聊天框消失/整个界面被挤动平移.
function updateCharIndicator() {
  try {
    const cfgI = getCfg();
    const on = (cfgI.portraitMode === "indicator" || cfgI.portraitMode === "both");
    const name = (() => {
      try {
        const pf = loadVoiceProfile();
        return (pf && pf.current) || (quickChars && quickChars.active) || "";
      } catch (e) { return ""; }
    })();
    let av = "";
    try {
      const c = (name && quickChars && quickChars.chars || []).find(x => x.name === name);
      if (c) {
        av = c.avatar || ((c.emotions || []).find(e => e && e.avatar) || {}).avatar || "";
      }
      if (!av && name) {
        const vp = loadVoiceProfile();
        const pv = vp.chars && vp.chars[name];
        if (pv && pv.avatar) av = pv.avatar;
      }
    } catch (e) { /* noop */ }
    const bar = document.getElementById("fvtt-tts-floatbar");
    if (!bar) return;
    let im = bar.querySelector(".fvtt-tts-char-indicator");
    if (on && av) {
      if (!im) {
        im = document.createElement("img");
        im.className = "fvtt-tts-char-indicator";
        im.alt = "";
        const charSel = bar.querySelector(".fvtt-tts-char");
        if (charSel && charSel.parentNode) charSel.parentNode.insertBefore(im, charSel);
        else bar.appendChild(im);
      }
      im.src = av;
      im.title = name || "";
      im.style.display = "";
    } else if (im) {
      im.style.display = "none";
    }
  } catch (e) { /* noop */ }
}

// 立绘展示方式设置切换 → 全量刷新已渲染消息(消息内插图显/隐 + header 头像恢复/重换), 让设置立即实际改变展示
function refreshAllPortraits() {
  try {
    const cfgR = getCfg();
    const showMsg = (cfgR.portraitMode === "message" || cfgR.portraitMode === "both");
    Array.from(document.querySelectorAll(".fvtt-tts-emotion-avatar")).forEach(img => { try { img.remove(); } catch (e) { /* noop */ } });
    if (!showMsg) {
      // 切到"仅指示物/都不显示": 恢复消息 header 的原始玩家头像
      document.querySelectorAll(".message-header img[data-fvtt-orig-src], .message-sender img[data-fvtt-orig-src], .message img[data-fvtt-orig-src]").forEach(h => {
        try { h.setAttribute("src", h.dataset.fvttOrigSrc); h.removeAttribute("data-fvtt-orig-src"); } catch (e) { /* noop */ }
      });
      return;
    }
    // message/both: 历史消息全部补插(幂等 — 已有图跳过)
    if (game.messages && game.messages.contents) {
      game.messages.contents.forEach(m => {
        try {
          const el = m.element || (m.id && document.querySelector(`.message[data-message-id="${m.id}"]`));
          if (el) applyEmotionAvatar(m, el);
        } catch (e) { /* noop */ }
      });
    }
  } catch (e) { /* noop */ }
}

// 立绘路径统一成绝对 URL(跨端生效): 服务端角色素材导出到模块静态目录 engine/audio_export/,
// 相对路径(如 fvtt_chars/<角色>/xx.png)远程端按页面 origin 会 404 → 统一加 /modules/gpt-sovits-tts/engine/audio_export/ 前缀,
// 经 Foundry 30000 同源(HTTPS frp)必达; http(s)/模块/data 路径原样。
function toAvatarUrl(av) {
  try {
    if (!av) return "";
    let s = String(av).trim();
    if (/^https?:\/\//i.test(s)) return s;
    if (s.startsWith("/")) return new URL(s, window.location.origin).href;
    s = s.replace(/^[.\\/]+/, "");
    // 已是模块相对路径(modules/、systems/、data/ 等 Foundry 公开目录, 可能无前导 "/") → 直接 / 拼 origin
    if (/^(modules|systems|packs|data)\//i.test(s)) return new URL("/" + s, window.location.origin).href;
    // 其余相对路径 → 模块角色素材导出目录(engine/audio_export/)
    return new URL("/modules/gpt-sovits-tts/engine/audio_export/" + s, window.location.origin).href;
  } catch (e) { return av; }
}

// 取 Foundry 模块静态相对路径(官方内部通道用): 输入可为绝对 http / 相对 /modules/ / 无斜杠 modules/,
// 一律归一成相对路径 "/modules/gpt-sovits-tts/..." — 广播时各端按自己 origin 解析(避免 127.0.0.1 localhost 陷阱)
function _modulePath(au) {
  try {
    const s = String(au || "").trim();
    if (s.startsWith("/modules/")) return s;
    if (s.startsWith("modules/")) return "/" + s;
    if (/^https?:\/\//i.test(s)) {
      const p = new URL(s).pathname;
      return p.startsWith("/modules/") ? p : "";
    }
    return "";
  } catch (e) { return ""; }
}

// 1.6.147 元素解包: Foundry 不同版本/调用点可能传 原生元素 / jQuery 对象 / 带 [0] 的包装 →
//   以前只认 typeof querySelector === "function", 于是 jQuery 会走到"无消息元素"分支 → 整条消息不插立绘。
function _asChatEl(v) {
  try {
    if (!v) return null;
    if (typeof v.querySelector === "function" && typeof v.querySelectorAll === "function") return v;
    if (v[0] && typeof v[0].querySelector === "function") return v[0];
    if (v.jquery && v[0]) return v[0];
  } catch (e) { /* noop */ }
  return null;
}

// 情绪→立绘 / 角色立绘: 消息带角色时, 在内容前显示该角色的立绘(语气槽立绘优先); 无角色不显示
function applyEmotionAvatar(message, html) {
  // 1.6.101 诊断: 记录"为什么没插立绘"(F12 执行 await fvttTTSDiag() 可看到; 全流程 catch 静默是排查黑洞)
  const _why = (r) => {
    try {
      const lst = (window.__fvttTTSSpriteWhy = window.__fvttTTSSpriteWhy || []);
      lst.push({ ts: Date.now(), mid: (message && message.id) || "", reason: String(r) });
      while (lst.length > 20) lst.shift();
      if (window.__fvttTTSSpriteVerbose || window.__fvttTTSSpriteDiag) console.warn("[gpt-sovits-tts][立绘] 未插入: " + r);
    } catch (e) { /* noop */ }
    return undefined;
  };
  try {
    const cfgM = getCfg();
    // 立绘展示方式: 仅指示物/都不显示 → 消息内不插图
    if (cfgM.portraitMode !== "message" && cfgM.portraitMode !== "both") return _why("展示方式=" + cfgM.portraitMode + "(需 message/both)");
    const fl = message && message.flags ? (message.flags[MODULE] || null) : null;
    let el = _asChatEl(html);
    if (!el && message) el = _asChatEl(message.element);
    if (!el) return _why("无消息元素");
    // 立绘跟随朗读(1.6.6): 只有"实际合成/播放了语音"的消息才插立绘 — 纯文本/旁白/动作消息不插。
    // 判定: 消息 flags 已带音频(写回完成) 或 本端已播过该消息(playedIds / 已播 src)。
    // 新消息合成前渲染 → 无音频不插; 写回后 updateChatMessage 播放路径补插。
    // 1.6.132 立绘先行: 本模块发送框发出的消息(fromModSend)必然朗读 → 渲染时立即插"当前已判定的立绘",
    //   不等合成(合成约 1.5~2s)。立绘随后随 flags 写回(AI 最终情绪/槽立绘)自动细化, 同消息只插一次幂等。
    const hasAudio = !!(fl && (fl.audioData || fl.audioUrl || fl.selSprite || fl.spriteTest)) || !!(fl && fl.fromModSend);   // 1.6.34 手动选立绘/立绘测试消息即使未朗读也插立绘
    const playedHere = (() => {
      try {
        if (message && message.id && playedIds.has(message.id)) return true;
        if (fl && (fl.audioUrl || fl.audioData)) {
          const k = fl.audioUrl ? normPlayKey(fl.audioUrl) : normPlayKey(fl.audioData);
          if (k && window.__fvttTTSPlayedSrcs && window.__fvttTTSPlayedSrcs.has(k)) return true;
        }
        return false;
      } catch (e) { return false; }
    })();
    if (!hasAudio && !playedHere) return _why("未朗读(无音频flags且本机未播)");
    // 消息无角色 flags(AI 选角色失败/旧消息/直接内置框发送) → 用当前绑定角色兜底,
    // 保证"开启插图"一定有图可显(玩家端各自显示自己绑定的角色立绘)
    let role = (fl && fl.role) || "";
    if (!role) {
      try {
        const vpF = loadVoiceProfile();
        role = (vpF && vpF.current) || "";
      } catch (e) { /* noop */ }
    }
    // quickChars 未就绪(缓存 v2 首次拉取竞态) → 拉取后再重试(否则这次渲染没有立绘)
    if (role && (!quickChars || !quickChars.chars || !quickChars.chars.length)) {
      loadQuickChars({ force: true }).then(() => {
        try { applyEmotionAvatar(message, html); } catch (e) { /* noop */ }
      }).catch(() => { /* noop */ });
      return;
    }
    const c = (role && quickChars && quickChars.chars || []).find(x => x.name === role);
    const slot = (fl && fl.emotion) ? findEmotionSlot(fl.emotion, role) : null;   // key/label 均可匹配 → 立绘随语气
    let av = (fl && (fl.selSprite || fl.aiSprite || fl.slotAvatar || fl.avatar)) || (slot && slot.avatar) || (c && c.avatar) || "";   // 手动选立绘 > AI 选立绘(1.6.53) > 消息自带(跨端) > 语气槽立绘
    if (!av && c) {
      // 兜底: 取该角色第一张有图的语气槽立绘
      try {
        const fi = (c.emotions || []).find(e => e && e.avatar);
        if (fi && fi.avatar) av = fi.avatar;
      } catch (e) { /* noop */ }
    }   // 语气立绘 → 角色立绘
    if (!av && role) {
      // 角色缓存无头像: 用语音档案里的角色头像兜底
      try {
        const vp = loadVoiceProfile();
        const pv = vp.chars && vp.chars[role];
        if (pv && pv.avatar) av = pv.avatar;
      } catch (e) { /* noop */ }
    }
    // 1.6.101 最后兜底: 角色有立绘库但情绪槽/角色头像都没写 → 直接用立绘库第一张
    //   (此前这种情况整条消息"只有语音没有立绘", 且没有任何提示, 用户无法判断是配置问题还是 bug)
    if (!av && c && Array.isArray(c.sprites) && c.sprites.length) av = c.sprites[0];
    if (!av) return _why("角色无任何立绘 role=" + (role || "(空)") + " 命中角色=" + (c ? "是" : "否") + " 立绘数=" + ((c && c.sprites && c.sprites.length) || 0));   // 角色都没有立绘 → 不显示
    // 1.6.101 候选链 + 加载失败自动换下一张: 消息里固化的路径可能是旧目录/别的机器的绝对地址(404),
    //   此前只写一个 src, 404 就整条消息"没有立绘/头像"且毫无提示; 现在逐级回退到语气槽立绘/角色头像/立绘库
    const _cands = [];
    const _pushC = (v) => { const s2 = String(v || "").trim(); if (s2 && _cands.indexOf(s2) < 0) _cands.push(s2); };
    _pushC(av);
    try {
      if (fl) { _pushC(fl.selSprite); _pushC(fl.aiSprite); _pushC(fl.avatar); _pushC(fl.slotAvatar); }
      if (slot && slot.avatar) _pushC(slot.avatar);
      if (c) {
        try { const _fe = (c.emotions || []).find(e => e && e.avatar); if (_fe) _pushC(_fe.avatar); } catch (e) { /* noop */ }
        _pushC(c.avatar);
        if (Array.isArray(c.sprites) && c.sprites.length) _pushC(c.sprites[0]);
      }
    } catch (e) { /* noop */ }
    const body = el.querySelector(".message-content") || el;
    // 同一消息只插一次
    if (body.querySelector(".fvtt-tts-emotion-avatar")) return;
    const img = document.createElement("img");
    let _ci = 0;
    img.src = toAvatarUrl(_cands[_ci] || av);
    img.onerror = () => {
      // 当前候选加载失败 → 换下一个; 全部失败 → 移除并记录原因(不再静默"什么都没有")
      _ci++;
      if (_ci < _cands.length) { img.src = toAvatarUrl(_cands[_ci]); return; }
      try { img.remove(); } catch (e) { /* noop */ }
      _why("立绘全部加载失败(" + _cands.length + "个候选) 首个=" + String(av).slice(-60));
    };
    img.className = "fvtt-tts-emotion-avatar";
    img.alt = role || "";
    img.title = role || "";
    img.loading = "lazy";   // 长列表不阻塞渲染
    img.decoding = "async";
    if (body.firstChild) body.insertBefore(img, body.firstChild);
    else body.appendChild(img);
    // 消息 header 的"玩家头像"也随语气换(发送消息时玩家形象随语气变化)— 没有语气槽时用角色立绘
    try {
      const hdr = el.querySelector(".message-header") || el.querySelector(".message-sender");
      const himg = hdr && (hdr.querySelector("img") || hdr.querySelector(".avatar"));
      if (himg && av) {
        try {
          if (!himg.dataset.fvttOrigSrc) himg.dataset.fvttOrigSrc = himg.getAttribute("src") || "";   // 记住原始玩家头像(切"都不显示"时可恢复)
          const _avAbs = img.getAttribute("src") || toAvatarUrl(av);   // 1.6.101 用最终生效(含回退后)的那张, 避免头部头像 404
          if (himg.getAttribute("src") !== _avAbs) himg.setAttribute("src", _avAbs);
        } catch (e) { /* noop */ }
      }
    } catch (e) { /* noop */ }
  } catch (e) { /* noop */ }
}

// 1.6.101 立绘/头像诊断(作者排查用, 不改变任何行为): 在浏览器 F12 控制台执行
//   await fvttTTSDiag()      → 打印模块版本/展示方式/角色数据/最近消息的 flags 与 DOM/未插原因
//   结果同时写入剪贴板, 直接粘贴给作者即可定位"为什么没有立绘"
window.fvttTTSDiag = async function fvttTTSDiag(n = 6) {
  const L = [];
  const P = (s) => { L.push(String(s)); };
  try {
    const cfgD = getCfg();
    const mod = game.modules.get(MODULE);
    const mv = (mod && (mod.version || (mod._source && mod._source.version) || (mod.data && mod.data.version))) || "?";
    P("=== gpt-sovits-tts 立绘诊断 ===");
    P("模块版本=" + mv + " | 代码版本=" + MOD_VERSION + " | Foundry=" + String(game.version || (game.release && game.release.version) || "?") + " | 用户=" + (game.user && game.user.name) + "(GM=" + !!(game.user && game.user.isGM) + ")");
    P("钩子已注册=" + JSON.stringify(window.__fvttTTSHooks || {}) + " | 可直连引擎=" + String(window.__fvttTTSCanDirect));
    P("展示方式 portraitMode=" + cfgD.portraitMode + " | 立绘尺寸=" + cfgD.portraitSize + " | 引擎=" + cfgD.serverUrl + (window.__fvttTTSAutoBase ? "（已自动识别为本机引擎）" : "") + " | AI=" + (cfgD.llmEnabled ? "开" : "关") + (cfgD.llmKey ? "" : "(无key)"));
    let qc = quickChars;
    if (!qc || !Array.isArray(qc.chars) || !qc.chars.length) {
      try { qc = await loadQuickChars({ force: true }); } catch (e) { /* noop */ }
    }
    const chars = (qc && qc.chars) || [];
    P("角色数据: 来源=" + String((qc && qc._src) || "direct") + " | 角色数=" + chars.length);
    chars.slice(0, 8).forEach(c => {
      const et = String(c.emotion_tags || "").split(/\n+/).filter(l => /(立绘|sprite)/i.test(l)).length;
      P("  · " + c.name + " | 立绘库=" + ((c.sprites || []).length) + " | 角色头像=" + (c.avatar || "(空)") + " | 情绪槽=" + ((c.emotions || []).length) + " | 标注行=" + et);
    });
    try {
      const cs = getComputedStyle(document.body);
      P("CSS 尺寸变量: 消息立绘=" + (cs.getPropertyValue("--fvtt-tts-portrait-size") || "(空)") + " 头部头像=" + (cs.getPropertyValue("--fvtt-tts-header-avatar-size") || "(空)"));
    } catch (e) { /* noop */ }
    try { P("本机当前角色=" + (loadVoiceProfile().current || "(未选)")); } catch (e) { /* noop */ }
    // 1.6.120 润色能力(推理模型会自动关闭)
    try { P("AI 润色: " + (getCfg().llmPolish ? "开启" : "关闭") + (Number(window.__fvttTTSReasoningHeavy || 0) > 0 ? ("（本会话有 " + window.__fvttTTSReasoningHeavy + " 次答案来自思考通道：模型偏推理型，建议换 deepseek-chat / gpt-4o-mini 以更省）") : "")); } catch (e) { /* noop */ }
    // 1.6.118 情绪参考音体检: 多少槽短于 3 秒(短样本靠引擎重复拼接兜底, 音质不如原生 3~10 秒)
    try {
      const _rf = await svcRequest(getCfg().serverUrl, "GET", "/refs?role=" + encodeURIComponent(cn || ""), null, { timeoutMs: 12000, retries: 0 });
      const _rj = (_rf && typeof _rf.json === "function") ? await _rf.json().catch(() => ({})) : {};
      const _rc = (_rj && _rj.chars && _rj.chars[0]) || null;
      if (_rc && Array.isArray(_rc.slots)) {
        const _short = _rc.slots.filter(x => x && typeof x.seconds === "number" && x.seconds < 3);
        const _lens = _rc.slots.map(x => Number(x && x.seconds) || 0).filter(x => x > 0);
        P("情绪参考音: 共 " + _rc.slots.length + " 槽，短于 3 秒 " + _short.length + " 个（最长 " + (Math.max.apply(null, _lens.concat([0]))).toFixed(1) + "s，最短 " + (Math.min.apply(null, _lens.concat([99]))).toFixed(2) + "s）");
        if (_short.length) P("  短样本: " + _short.slice(0, 6).map(x => (x.key || "") + " " + (x.label || "").slice(0, 8) + " " + x.seconds + "s").join(" ｜ ") + (_short.length > 6 ? " …" : ""));
      }
    } catch (e) { /* noop */ }
    // 1.6.117 AI token 消耗(量化省了多少)
    try {
      const _tk = window.__fvttTTSTokenStats || null;
      if (_tk && _tk.calls) {
        const _bk = Object.keys(_tk.byKind || {}).map(k => k + " " + _tk.byKind[k].calls + "次/" + _tk.byKind[k].in + "in").join(" · ");
        P("AI token 累计: 调用 " + _tk.calls + " 次 · 输入 ≈" + _tk.inTok + " · 输出 ≈" + _tk.outTok + (_bk ? (" ｜ " + _bk) : ""));
      }
    } catch (e) { /* noop */ }
    // 1.6.105 最近一次朗读耗时(标出"慢"到底慢在 AI 还是合成)
    try {
      const _tm = window.__fvttTTSLastTiming;
      if (_tm && _tm.at) P("最近一句耗时: 总计 " + (_tm.totalMs / 1000).toFixed(1) + "s（其中 AI 判语气 " + (_tm.judgeMs / 1000).toFixed(1) + "s）@" + new Date(_tm.at).toLocaleTimeString("zh-CN"));
    } catch (e) { /* noop */ }
    try {
      const _cr = window.__fvttTTSCrashList || [];
      if (_cr.length) P("朗读链路异常记录: " + _cr.slice(-2).map(x => String(x.msg).split("\n")[0]).join(" ｜ "));
    } catch (e) { /* noop */ }
    const msgs = Array.from(game.messages.contents).slice(-Math.max(1, n));
    P("--- 最近 " + msgs.length + " 条消息 ---");
    msgs.forEach(m => {
      const f = (m.flags && m.flags[MODULE]) || {};
      let domHas = "未渲染", src = "", w = -1;
      try {
        const el = document.querySelector('.message[data-message-id="' + m.id + '"]');
        if (el) {
          const im = el.querySelector(".fvtt-tts-emotion-avatar");
          domHas = im ? "有" : "无";
          if (im) { src = im.getAttribute("src") || ""; w = im.naturalWidth || 0; }
        }
      } catch (e) { /* noop */ }
      P("· " + String(m.content || "").replace(/\s+/g, " ").slice(0, 18)
        + " | role=" + (f.role || "-") + " emo=" + (f.emotion || "-")
        + " av=" + (f.avatar || "-") + " sel=" + (f.selSprite || "-") + " ai=" + (f.aiSprite || "-")
        + " 音频=" + (f.audioData ? "内嵌" : (f.audioUrl ? "url" : "无")) + " 模块发送=" + (f.fromModSend ? "是" : "否")
        + " | DOM立绘=" + domHas + (src ? " src=" + src.slice(-52) + " 加载宽=" + w : ""));
    });
    const why = (window.__fvttTTSSpriteWhy || []).slice(-10);
    P("--- 未插立绘原因(最近 " + why.length + " 条) ---");
    why.forEach(r => P("· " + r.reason + " | mid=" + (r.mid || "-")));
    const dl = (window.__fvttTTSSpriteDiagList || []).slice(-8);
    if (dl.length) {
      P("--- 立绘判定(最近) ---");
      dl.forEach(r => P("· 角色=" + r.role + " 情绪=" + r.emo + " 候选=" + r.cands + " 选中=" + r.av));
    }
    P("=== 结束(结果已尝试复制到剪贴板) ===");
  } catch (e) { P("诊断异常: " + String((e && e.message) || e)); }
  const txt = L.join("\n");
  try { console.log("%c" + txt, "font-family:monospace"); } catch (e) { try { console.log(txt); } catch (e2) { /* noop */ } }
  try { if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(txt); } catch (e) { /* noop */ }
  return txt;
};

// 无角色(默认音色)消息: AI 从角色列表选最像说话者的角色 → 更新 flags → 立绘随角色显示
async function maybePickAvatarRole(message) {
  // 1.6.43 立绘测试消息不触发AI自动选角(纯测试, 无LLM时不再刷屏"AI自动选角失败")
  try { const flA2 = message && message.flags && message.flags[MODULE]; if (flA2 && flA2.spriteTest) return; } catch (e) { /* noop */ }
  try {
    // LLM 失败降级: 一次失败(API 不通/404/超时)后本会话禁用, 避免每消息反复调失败刷屏
    if (window.__fvttTTSPickRoleBroken === true) return;
    if (!message || !message.flags || !message.flags[MODULE]) return;
    const fl = message.flags[MODULE];
    if (fl.role) return;                       // 已带角色
    const cfg = getCfg();
    if (!cfg.aiPickAvatar || !cfg.llmEnabled || !cfg.llmKey) return;
    const names = sendPopCurrentChars().map(x => x.name).filter(Boolean);
    if (!names.length) return;
    const text = String(message.content || (message.data && message.data.content) || "").slice(0, 500);
    const r = await svcRequest(cfg.serverUrl, "POST", "/llm/pick-role", { text, roles: names, base: cfg.llmBaseUrl || "https://api.openai.com/v1", key: cfg.llmKey, model: cfg.llmModel || "gpt-4o-mini" }, { timeoutMs: 60000 });
    const j = (r.jsonSafe ? r.jsonSafe() : (r.json || {})) || {};
    if (r.ok && j.ok && j.role && names.includes(j.role)) {
      safeMsgWrite(message, { flags: { [MODULE]: { ...fl, role: j.role, aiPicked: true } } });
    } else {
      // 失败降级(网络/LLM服务异常): 本会话不再尝试(用户可重进会话恢复)
      try { window.__fvttTTSPickRoleBroken = true; console.warn("[gpt-sovits-tts] AI 自动选角失败, 本会话停用(可在设置检查 LLM API 地址/密钥)"); } catch (e) { /* noop */ }
    }
  } catch (e) { try { window.__fvttTTSPickRoleBroken = true; } catch (e2) { /* noop */ } }
}

Hooks.on("chatInput", (event, inputOptions) => {
  if (event && event.key === "Enter" && !event.shiftKey) cancelTypingDebounce();
});

/* 兼容旧版聊天输入框(部分系统/主题) */
window.addEventListener("load", () => { attachTyping(); });
