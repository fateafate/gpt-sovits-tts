/**
 * gpt-sovits-tts — Foundry VTT 模块主入口
 * 功能: 聊天发送/打字停顿自动朗读 (GPT-SoVITS 本地合成 / 浏览器系统语音)
 *       麦克风听写(浏览器 Web Speech / 服务端 /asr) 直接发送或插入输入框
 *       消息重听按钮、状态指示灯、/ttssay 等命令、game.gptSoVitsTTS 宏 API
 */
import { PlaybackQueue, audioPlay, webSpeechSpeak, gptSovitsSynth, gptSovitsStatus } from "./tts-engine.js";
import { BrowserSTT, ServerSTT } from "./stt-engine.js";
import { VoiceManager, loadVoiceProfile, saveVoiceProfile, currentVoice, makeDraggable, getStylePrompt, setStylePrompt } from "./voice-manager.js";
import { prepareTextForLang, localizeNumbers } from "./text-lib.js";

// 暴露给 voice-manager(语音设置面板) 调用的全局函数(函数声明 hoisted, 顶层挂载即可)
window.fetchModelsFromServer = fetchModelsFromServer;
window.fetchAndRefreshModels = fetchAndRefreshModels;

const MODULE = "gpt-sovits-tts";
const CHAT_STYLES = (typeof CONST !== "undefined" && (CONST.CHAT_MESSAGE_STYLES || CONST.CHAT_MESSAGE_TYPES)) || {};

/* ============ 设置定义 ============ */
// TTS 服务地址: 默认自动指向"当前 Foundry 所在主机"的 9881 端口
// (GM 在 0.0.0.0 启动服务后, 玩家浏览器连 GM 的地址即自动可用, 无需手填 IP)
const autoServerUrl = () => {
  const host = (typeof location !== "undefined" && location.hostname) ? location.hostname : "127.0.0.1";
  return `http://${host}:9881`;
};

const SETTINGS = [
  ["enabled",       { type: Boolean, scope: "client", default: true,            name: "settings.enabled.name",       hint: "settings.enabled.hint" }],
  ["engine",        { type: String,  scope: "client", default: "gptsovits",      choices: { gptsovits: "GPT-SoVITS", webspeech: "Web Speech" }, name: "settings.engine.name", hint: "settings.engine.hint" }],
  ["serverUrl",     { type: String,  scope: "client", default: autoServerUrl(), name: "settings.serverUrl.name", hint: "settings.serverUrl.hint" }],
  ["triggerMode",   { type: String,  scope: "client", default: "both",           choices: { send: "settings.triggerMode.send", typing: "settings.triggerMode.typing", both: "settings.triggerMode.both", manual: "settings.triggerMode.manual" }, name: "settings.triggerMode.name", hint: "settings.triggerMode.hint" }],
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
  ["speedFactor",   { type: Number,  scope: "client", default: 1.0,              range: { min: 0.5, max: 2.0, step: 0.05 }, name: "settings.speedFactor.name", hint: "settings.speedFactor.hint" }],
  ["volume",        { type: Number,  scope: "client", default: 1.0,              range: { min: 0, max: 1, step: 0.05 }, name: "settings.volume.name", hint: "settings.volume.hint" }],
  ["queueMode",     { type: String,  scope: "client", default: "queue",          choices: { queue: "settings.queueMode.queue", interrupt: "settings.queueMode.interrupt" }, name: "settings.queueMode.name", hint: "settings.queueMode.hint" }],
  ["typingDebounce",{ type: Number,  scope: "client", default: 1200,             name: "settings.typingDebounce.name", hint: "settings.typingDebounce.hint" }],
  ["showReplay",    { type: Boolean, scope: "client", default: true,            name: "settings.showReplay.name",     hint: "settings.showReplay.hint" }],
  ["showStatus",    { type: Boolean, scope: "client", default: true,            name: "settings.showStatus.name",     hint: "settings.showStatus.hint" }],
  ["commands",      { type: Boolean, scope: "client", default: true,            name: "settings.commands.name",       hint: "settings.commands.hint" }],
  ["sttEnabled",    { type: Boolean, scope: "client", default: true,            name: "settings.sttEnabled.name",     hint: "settings.sttEnabled.hint" }],
  ["sttEngine",     { type: String,  scope: "client", default: "browser",        choices: { browser: "settings.sttEngine.browser", server: "settings.sttEngine.server" }, name: "settings.sttEngine.name", hint: "settings.sttEngine.hint" }],
  ["sttLang",       { type: String,  scope: "client", default: "auto",           choices: { auto: "settings.textLang.auto", zh: "zh", ja: "ja", en: "en" }, name: "settings.sttLang.name", hint: "settings.sttLang.hint" }],
  ["sttAutoSend",   { type: Boolean, scope: "client", default: true,            name: "settings.sttAutoSend.name",   hint: "settings.sttAutoSend.hint" }],
  ["sttAutoSpeak",  { type: Boolean, scope: "client", default: false,           name: "settings.sttAutoSpeak.name",  hint: "settings.sttAutoSpeak.hint" }],
  ["emotionSpeed",  { type: Boolean, scope: "client", default: true,            name: "settings.emotionSpeed.name",  hint: "settings.emotionSpeed.hint" }],
  ["translate",     { type: Boolean, scope: "client", default: true,            name: "settings.translate.name",      hint: "settings.translate.hint" }],
  ["sttDevice",     { type: String,  scope: "client", default: "",               name: "settings.sttDevice.name",      hint: "settings.sttDevice.hint", choices: () => ttsDeviceChoices() }],
  ["hudTheme",      { type: String,  scope: "client", default: "dark",           choices: { dark: "settings.hudTheme.dark", pink: "settings.hudTheme.pink" }, name: "settings.hudTheme.name", hint: "settings.hudTheme.hint" }],
  ["llmEnabled",    { type: Boolean, scope: "client", default: false,           name: "settings.llmEnabled.name",  hint: "settings.llmEnabled.hint" }],
  ["llmBaseUrl",    { type: String,  scope: "client", default: "https://api.openai.com/v1", name: "settings.llmBaseUrl.name", hint: "settings.llmBaseUrl.hint" }],
  ["llmKey",        { type: String,  scope: "client", default: "",               name: "settings.llmKey.name",      hint: "settings.llmKey.hint" }],
  ["llmModel",      { type: String,  scope: "client", default: "gpt-4o-mini",    choices: () => llmModelChoices(), name: "settings.llmModel.name",    hint: "settings.llmModel.hint" }],
  ["llmPolish",     { type: Boolean, scope: "client", default: false,            name: "settings.llmPolish.name",   hint: "settings.llmPolish.hint" }],
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

// LLM 模型下拉: 服务端拉取的可用模型(设置 llmModels 缓存) + 常用预设; 未拉取时也有预设可选
const LLM_PRESET_MODELS = ["gpt-4o-mini", "gpt-4o", "deepseek-chat", "deepseek-reasoner", "qwen-plus", "qwen-turbo", "glm-4-flash", "kimi-latest"];
function llmModelChoices() {
  const out = {};
  let cached = [];
  try { cached = Array.isArray(game.settings.get(MODULE, "llmModels")) ? game.settings.get(MODULE, "llmModels") : []; } catch (e) { /* noop */ }
  [...LLM_PRESET_MODELS, ...cached].forEach(m => { if (m) out[m] = m; });
  return out;
}

// 朗读风格提示词 → 合成参数(无 LLM 兜底): 严肃→慢 / 激动→快 / 不中断→整段连贯合成
function styleKeywordParams(style, textLen) {
  const s = String(style || "");
  const out = { speed: 0, split: "", frag: 0, fast: false };
  if (/严肃|认真|正式|威严|庄重|沉重|冷静|沉着/.test(s)) out.speed = 0.92;
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

/* ============ 状态 ============ */
const queue = new PlaybackQueue({});
let statusInfo = { ok: null, data: null };
let lastTypedSpoken = { text: "", ts: 0 };
let typingTimer = null;
let dictation = null;
let lastErrorNotify = 0;
const voicedIds = new Set();
const recentBroadcastIds = new Set();   // 自己最近广播的 messageId(socket 回环去重; 用集合避免连发时单值被覆盖导致旧广播重复播)
const pendingTts = new Map();      // messageId → 定时器(非作者等广播音频的兜底)
const playedIds = new Set();       // 已播放广播音频的 messageId(防兜底二次读)
const audioCache = new Map();      // messageId → {url, mime}: 已合成/已广播的同一段音频(重播复用)
let preloadAudio = null;           // {text, lang, url, dataUrl}: 预加载时预合成的当前输入音频(再点直接播出)

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

/** 播放诊断: 把"实际播放了什么"上报服务端落盘(排查播放固定同一段) */
function diagPlay(src, messageId, text) {
  try {
    const cfg = getCfg();
    fetch(`${cfg.serverUrl}/diag`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ src: String(src || "").slice(0, 20), messageId: String(messageId || "").slice(0, 16), text: String(text || "").slice(0, 60) }), signal: AbortSignal.timeout(4000) }).catch(() => { });
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
      fetch(`${getCfg().serverUrl}/selftest/transfer-arrive`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: p.id, from: game.user.name }), signal: AbortSignal.timeout(8000) }).catch(() => { /* noop */ });
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
        queue.enqueue({ play: () => audioPlay(u, { volume: getCfg().volume }) });
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
  queue.enqueue({ play: () => audioPlay(url, { volume: getCfg().volume }) });
}

/* ============ 本地化(内置中文兜底, 语言包不生效时也始终显示中文) ============ */
let zhDict = null;
async function ensureZhDict() {
  if (zhDict) return zhDict;
  try {
    const resp = await fetch(`modules/${MODULE}/languages/cn.json`);
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
  // 语音运行者解析: GM 分配表优先(主持人在设置里给每个 pl 分配电脑; 默认主持人电脑)
  //  → 非 GM 客户端动态用被分配机器广播的服务地址(找不到则保持 auto=本机)
  try {
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
  } catch (e) { /* noop */ }
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

/* ============ 核心: 朗读 ============ */
async function speak(text, { lang = null, sender = "", refAudioPath = null, promptText = null, promptLang = null, speed = null, volume = null, auxRefAudioPaths = null, emotionMix = null, broadcast = false, messageId = "", skipAiEmotion = false } = {}) {
  const cfg = getCfg();
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
    const r = await prepareTextForLang(t, finalLang0, { translate: cfg.translate });
    finalText = r.text;
    if (cfg.translate && r.lang && r.lang !== finalLang0) {
      finalLang = r.lang;
      notifyOnce(_L("errors.transFallback", `翻译失败，已按原文语言朗读`), "info");
    }
  } catch (e) { /* 保留原文 */ }
  // 台词括号剥离(照搬成品软件 remove_parentheses): （动作描写）(笑) *叹气* 不朗读, 只读正文
  finalText = stripStageDirections(finalText);

  // 语音管理器 per-角色 覆盖(参考音频/提示文本/提示语言/语速/音量)
  // 显式参数(语气槽试听等)优先, 其次 profile 覆盖
  const prof0 = loadVoiceProfile();
  const pv = pv0;
  // 参考路径规范化: 旧档案可能只存了 "speech/xx.wav", 补成 fvtt_chars/<角色>/speech/xx.wav(任意客户端可解析)
  const fixRef = (r) => (r && !String(r).startsWith("fvtt_chars/") && !String(r).startsWith("http")) ? `fvtt_chars/${prof0.current || ""}/${r}` : r;
  let spd = cfg.speedFactor;
  let vol = cfg.volume;
  let overrides = null;
  const explicit = (refAudioPath || promptText || promptLang || speed || volume || auxRefAudioPaths || typeof emotionMix === "number");
  if (explicit) {
    overrides = {};
    if (refAudioPath) overrides.refAudioPath = fixRef(refAudioPath);
    if (promptText) overrides.promptText = promptText;
    if (promptLang) overrides.promptLang = promptLang;
    if (auxRefAudioPaths) overrides.auxRefAudioPaths = auxRefAudioPaths.map(fixRef);
    if (typeof emotionMix === "number") overrides.emotionMix = emotionMix;
    if (speed) spd = speed;
    if (volume) vol = volume;
  } else if (pv) {
    if (pv.speed) spd = pv.speed;
    else if (cfg.emotionSpeed && pv.emotion) {
      // 情感参数调制: 按语气标签推断情绪速度(愤怒快/困倦慢/悲伤缓...), 语速按调制度从 1.0 插值
      const slotC = findEmotionSlot(pv.emotion, prof0.current);
      const emoSpd = inferEmotionSpeed(slotC && slotC.label);
      if (emoSpd) {
        const modAmt = (typeof pv.emotionMod === "number") ? pv.emotionMod : 0.5;
        spd = 1.0 + (emoSpd - 1.0) * modAmt;
        if (pv.emotionMix === 0) spd = 1.0;   // 占比 0 = 纯默认, 不调制
      }
    }
    if (pv.volume) vol = pv.volume;
    if (pv.ref || pv.promptText || pv.promptLang || pv.auxRef) {
      overrides = {};
      if (pv.ref) overrides.refAudioPath = fixRef(pv.ref);
      if (pv.promptText) overrides.promptText = pv.promptText;
      if (pv.promptLang) overrides.promptLang = pv.promptLang;
      if (pv.auxRef) overrides.auxRefAudioPaths = [fixRef(pv.auxRef)];
      if (typeof pv.emotionMix === "number") overrides.emotionMix = pv.emotionMix;
    }
  }

  // ---- 朗读风格提示词(音频栏输入, 如"更严肃认真、中间不要中断"): 应用到合成参数 ----
  try {
    const profC = (prof0.chars && prof0.chars[(prof0.current || "")]) || {};
    const stylePrompt = getStylePrompt(prof0.current || "") || String((pv && pv.stylePrompt) || profC.stylePrompt || "").trim();
    if (stylePrompt) {
      overrides = overrides || {};
      const kw = styleKeywordParams(stylePrompt, finalText.length);
      if (kw.speed) spd = kw.speed;
      if (kw.split) overrides.textSplitMethod = kw.split;
      if (kw.frag) overrides.fragmentInterval = kw.frag;
      // 已配置 LLM 且关键词未明确切分意图 → 让 LLM 更精确地把风格翻译成参数(失败回落关键词)
      if (cfg.llmEnabled && cfg.llmKey && !kw.fast) {
        const styleKey = `role=${prof0.current || ""}|style=${stylePrompt}`;
        let llmStyleHit = null;
        try { llmStyleHit = _llmStyleCache.get(styleKey) || null; } catch (e) { /* noop */ }
        if (!llmStyleHit) {
          try {
            const qcC = (quickChars && quickChars.chars || []).find(x => x.name === (prof0.current || ""));
            const r = await fetch(`${cfg.serverUrl}/llm/style`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ base: cfg.llmBaseUrl || "https://api.openai.com/v1", key: cfg.llmKey, model: cfg.llmModel || "gpt-4o-mini", text: finalText, style: stylePrompt, role: prof0.current || "", setting: (qcC && qcC.setting) || "" }),
              signal: AbortSignal.timeout(60000),
            });
            const j = await r.json().catch(() => ({}));
            if (r.ok && j.ok) {
              llmStyleHit = { speed_factor: j.speed_factor, split: j.split };
              try { _llmStyleCache.set(styleKey, llmStyleHit); setTimeout(() => { try { _llmStyleCache.delete(styleKey); } catch (e) { /* noop */ } }, 600000); } catch (e) { /* noop */ }
            }
          } catch (e) { /* 回落关键词结果 */ }
        }
        if (llmStyleHit) {
          if (typeof llmStyleHit.speed_factor === "number") spd = llmStyleHit.speed_factor;
          if (llmStyleHit.split && llmStyleHit.split !== "cut5") {
            overrides.textSplitMethod = (llmStyleHit.split === "cut0" && finalText.length > 60) ? "cut2" : llmStyleHit.split;   // 长文本防崩
          }
        }
      }
    }
  } catch (e) { /* 保底 */ }

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
          const res = await gptSovitsSynth(finalText, finalLang, { serverUrl: cfg.serverUrl, speedFactor: spd, overrides, mediaType: "mp3", asBlob: true });
          blob = res.blob; audioUrl = res.audioUrl || "";
          try {
            _synthCache.set(ck, { blob, audioUrl });
            while (_synthCache.size > 40) { const k0 = _synthCache.keys().next(); if (!k0.done) _synthCache.delete(k0.value); }
          } catch (e) { /* noop */ }
        }
        diagPlay("synth", messageId, finalText);
        const objUrl = URL.createObjectURL(blob);
        item = { play: () => audioPlay(objUrl, { volume: vol }), cleanup: () => URL.revokeObjectURL(objUrl) };
        if (messageId) {
          recentBroadcastIds.add(messageId);
          if (recentBroadcastIds.size > 12) {   // 只记最近 12 条, 防无限增长
            const it = recentBroadcastIds.values().next();
            if (!it.done) recentBroadcastIds.delete(it.value);
          }
          // 关键: 把音频 Foundry 路径写回消息 flags → 聊天文档同步(数据库级, 可靠) → 其他客户端(pl)收到 update 立即播放,
          // 不依赖 socket 广播(该通道在部分环境下不可达); 存相对路径, 接收端按来源自己拼(避免 localhost 陷阱)
          if (audioUrl) {
            try {
              const _rel = audioUrl.startsWith("http") ? new URL(audioUrl).pathname : audioUrl;
              const _msg = (game.messages && game.messages.get(messageId)) || null;
              if (_msg && typeof _msg.update === "function") {
                _msg.update({ "flags.gpt-sovits-tts.audioUrl": _rel }).catch(() => { /* noop */ });
              }
            } catch (e) { /* noop */ }
          }
        }
        try {
          const b64 = await blobToBase64(blob);
          // 缓存同一段音频(重播复用同一段, 不再重新合成)
          cacheAudio(messageId, `data:${"audio/mpeg"};base64,${b64}`, "audio/mpeg");
          // 智能广播: 无其他在线玩家(GM 单机)时跳过 socket — Foundry v13 单标签页会让
          // 自己的广播自环并等待 ack, 产生 "message channel closed" 噪音; 本地照常播放不受影响.
          const hasOthers = game.users && game.users.some(u => u.active && !u.isSelf);
          diagPlay("emit-check", messageId, hasOthers ? "hasOthers" : "solo");   // 诊断: 广播判定(无其他在线则不发)
          if (hasOthers && game.socket && typeof game.socket.emit === "function") {
            // emit 返回 promise(v10+): 不 await 但必须捕获 rejection, 否则报 unhandled rejection
            try {
              if (audioUrl) {
                // URL 拉流(Shinsekai 式文件传输): 无 socket 1MB 包上限, 局域网 HTTP 直连快
                const full = `${cfg.serverUrl.replace(/\/+$/, "")}${audioUrl}`;
                const pr = game.socket.emit(MODULE, { type: "tts", messageId, audioUrl: full, mediaType: "mp3", sender, lang: finalLang, ts: Date.now() });
                diagPlay("emit", messageId, "url:" + String(finalText).slice(0, 30));
                if (pr && typeof pr.catch === "function") pr.catch((e) => { console.warn("[gpt-sovits-tts] 广播失败(其他玩家可能听不到, 会走兜底重读):", e); });
              } else {
                // ArrayBuffer 二进制传输: 省 base64 编码/解码 + 33% 体积 → 传输更快
                const buf = await blob.arrayBuffer();
                const pr = game.socket.emit(MODULE, { type: "tts", messageId, audio: buf, mediaType: "mp3", sender, lang: finalLang, ts: Date.now() });
                diagPlay("emit", messageId, finalText);   // 诊断: 广播已发出
                if (pr && typeof pr.catch === "function") pr.catch((e) => { console.warn("[gpt-sovits-tts] 广播失败(其他玩家可能听不到, 会走兜底重读):", e); });
              }
            } catch (e) { /* noop */ }
          }
        } catch (e) { /* socket 不可用时仅本地播放 */ }
      } else {
        const res = await gptSovitsSynth(finalText, finalLang, { serverUrl: cfg.serverUrl, speedFactor: spd, overrides });
        const url = res.url;
        item = { play: () => audioPlay(url, { volume: vol }), cleanup: () => URL.revokeObjectURL(url) };
      }
    } catch (err) {
      console.error("[gpt-sovits-tts] 合成失败:", err);
      setStatus(false);
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
        const tp = m.type || 0;
        if (typeof CONST !== "undefined" && tp === CONST.CHAT_MESSAGE_TYPES.OOC) return false;
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
    let url = (cfg.serverUrl && cfg.serverUrl !== "auto") ? cfg.serverUrl : null;
    if (!url) {
      // auto: 本机可能跑着 9881 服务(默认主持人场景) → 探测本机
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
  // v12+ 悄悄话: 不再用 CONST.CHAT_MESSAGE_STYLES.WHISPER(已废弃), 直接看 message.whisper 收件人数组
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

async function maybeSpeak(message) {
  const cfg = getCfg();
  if (!cfg.enabled) return;
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
  // 朗读永远用用户发送的原文(不覆盖成 AI 回复/润色文本)
  let speakText = decision.text;
  // AI 语气调配(对标成品软件):
  //  - 未选语气(默认) → AI 自主判断语气(只选情绪槽, 不改台词)
  //  - 已选语气 → 不重判情绪; 情绪槽音频已随 flags 应用
  if (cfg.llmEnabled && cfg.llmKey) {
    try {
      const flA = fl || null;
      const roleN = (flA && flA.role) || "";
      if (!(flA && flA.emotion)) {
        // 默认 → AI 自主判断语气(不改文字)
        const res = await judgeAndPolishByLLM(decision.text, roleN, false, getChatContext());
        if (res.ok && res.emotion) {
          const slot = findEmotionSlot(res.emotion, roleN);
          if (slot) {
            overrides = overrides || {};
            if (slot.ref_audio_path) overrides.auxRefAudioPaths = [`fvtt_chars/${roleN}/${slot.ref_audio_path}`]; // 主参考为基础 + 情绪叠加
            if (slot.prompt_text) overrides.promptText = slot.prompt_text;
            if (slot.prompt_lang) overrides.promptLang = slot.prompt_lang;
            if (typeof overrides.emotionMix !== "number") overrides.emotionMix = 0.75;  // 对标成品: 情绪要明显可辨
            console.debug(`[gpt-sovits-tts] AI 自动语气朗读: ${res.emotion} (台词保持原文)`);
            // 记录 AI 语气到消息 flags → 重播缓存 miss 时用同一语气重新合成(声音与第一次一致, 不再重新判断)
            try {
              if (message && message.flags && message.flags[MODULE]) {
                const _nf = { ...(message.flags[MODULE]) };
                _nf.emotion = (slot && slot.key) || res.emotion;   // 规范存槽 key(applyEmotionAvatar/朗读都按 key 匹配)
                if (slot.ref_audio_path) _nf.auxRef = `fvtt_chars/${roleN}/${slot.ref_audio_path}`;
                if (slot.prompt_text) _nf.promptText = slot.prompt_text;
                message.update({ flags: { [MODULE]: _nf } }).catch(() => { });
              }
            } catch (e) { /* noop */ }
          }
        } else if (res.reason && res.reason !== "no-llm" && res.reason !== "no-slots") {
          console.debug(`[gpt-sovits-tts] AI 判断未应用: ${res.reason}`);
        }
      } else if (flA && flA.emotion) {
        // 已选语气 → 不再润色台词; 该语气情绪占比不足时补足到 0.75(让其更明显), 用户手动调高则尊重
        const curMix = (typeof flA.emotionMix === "number") ? flA.emotionMix : 0;
        if (curMix < 0.75) {
          overrides = overrides || {};
          if (typeof overrides.emotionMix !== "number") overrides.emotionMix = 0.75;
        }
        console.debug(`[gpt-sovits-tts] 已选语气 ${flA.emotion} (台词保持原文)`);
      }
    } catch (e) { /* AI 失败沿用原设置 */ }
  }
  const opts = { lang: flLang || decision.lang, sender: decision.speakerName, ...(overrides || {}) };
  // 预加载音频命中: 输入与预合成文本一致 且 角色/语气/语言/语速未变 → 作者直接播预合成音频并广播(跳过 AI 判断/重新合成, 零等待)
  // 切了角色或语气 → 签名不匹配 → 回落下方正常合成(重新按当前角色/语气合成, 绝不播旧声音)
  if (preloadAudio && preloadAudio.url && stripStageDirections(speakText) === preloadAudio.text && preloadAudio.watchKey === makeWatchKey()) {
    if (decision.isSelf) {
      const dUrl = preloadAudio.dataUrl || "";
      diagPlay("preload", message.id, speakText);
      if (message.id) cacheAudio(message.id, dUrl, "audio/mpeg");   // 重播复用同一段
      queue.enqueue({ play: () => audioPlay(preloadAudio.url, { volume: getCfg().volume }) });
      // 预合成音频路径也写回消息 flags(相对路径) → pl 端聊天同步即可拉到同一段, 不依赖 socket 广播
      if (message.id && preloadAudio.audioUrl) {
        try {
          const _relP = String(preloadAudio.audioUrl).startsWith("http") ? new URL(preloadAudio.audioUrl).pathname : preloadAudio.audioUrl;
          message.update({ "flags.gpt-sovits-tts.audioUrl": _relP }).catch(() => { /* noop */ });
        } catch (e) { /* noop */ }
      }
      const hasOthers = game.users && game.users.some(u => u.active && !u.isSelf);
      if (hasOthers && game.socket && typeof game.socket.emit === "function") {
        try {
          if (preloadAudio.audioUrl) {
            // URL 拉流(服务端已存文件): 无 socket 大小限制, 局域网直连快
            const full = `${getCfg().serverUrl.replace(/\/+$/, "")}${preloadAudio.audioUrl}`;
            const pr = game.socket.emit(MODULE, { type: "tts", messageId: message.id || "", audioUrl: full, mediaType: "mp3", sender: decision.speakerName, lang: preloadAudio.lang || "", ts: Date.now() });
            if (pr && typeof pr.catch === "function") pr.catch((e) => console.warn("[gpt-sovits-tts] 广播失败:", e));
          } else if (dUrl) {
            const b64 = dUrl.includes("base64,") ? dUrl.split("base64,")[1] : "";
            const pr = game.socket.emit(MODULE, { type: "tts", messageId: message.id || "", audio: b64, mediaType: "mp3", sender: decision.speakerName, lang: preloadAudio.lang || "", ts: Date.now() });
            if (pr && typeof pr.catch === "function") pr.catch((e) => console.warn("[gpt-sovits-tts] 广播失败:", e));
          }
        } catch (e) { /* noop */ }
      }
      console.debug("[gpt-sovits-tts] 预加载音频直接播出 (零等待)");
      return;
    }
    // 非作者(无预加载缓存): 走下方正常流程(等广播/兜底)
  }
  if (decision.isSelf) {
    // 作者: 本地合成 + socket 广播 → 全员播放同一段音频(同一个声音)
    try { await speak(speakText, { ...opts, broadcast: true, messageId: message.id || "" }); }
    catch (e) { console.warn("[gpt-sovits-tts] 朗读异常(已忽略):", e); }
  } else if (game.socket && typeof game.socket.on === "function") {
    // 其他客户端: 等发言者的广播音频; 兜底超时后本地合成(广播通道故障时)
    const mid = message.id || "";
    pendingTts.set(mid, setTimeout(() => {
      pendingTts.delete(mid);
      if (mid && playedIds.has(mid)) return;   // 广播音频已播放过, 不再兜底
      speak(speakText, { ...opts, broadcast: false });
    }, 15000));
  } else {
    speak(speakText, { ...opts, broadcast: false });
  }
}

/* ============ 状态灯 ============ */
let _statusRetryT = null;
async function checkStatus(force = false) {
  const cfg = getCfg();
  if (!cfg.enabled && !force) return;
  if (cfg.engine !== "gptsovits") { setStatus(null); return; }
  const r = await gptSovitsStatus(cfg.serverUrl).catch(() => ({ ok: false, data: null }));
  setStatus(r.ok, r.data);
  // 服务不可用(启动/重启窗口 ~1-2 分钟)时 5 秒快速重试, 恢复后状态灯自动回绿
  if (!r.ok && !force) {
    clearTimeout(_statusRetryT);
    _statusRetryT = setTimeout(() => checkStatus(false), 5000);
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
    const c = statusInfo.data?.character;
    const name = c?.name || statusInfo.data?.version || "";
    return `${_L("status.ok", "TTS 服务在线")} · ${name}`;
  }
  if (statusInfo.ok === false) return `${_L("status.fail", "TTS 服务离线")} · ${cfg.serverUrl}\n${_L("status.failHint", "点击试听; 未启动请运行 server/start-tts-server.bat")}`;
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
      <select class="fvtt-tts-lang" title="${_L("ui.langTip", "朗读输出语种（也是自动翻译目标语言）")}"></select>
      <select class="fvtt-tts-char"></select>
      <select class="fvtt-tts-emotion"></select>
      <button type="button" class="fvtt-tts-voice" title="${_L("ui.voiceMgr", "语音设置（角色/语气/模型/语速）")}"><i class="fa-solid fa-sliders"></i></button>
      <button type="button" class="fvtt-tts-mic" title="${_L("ui.mic", "语音听写(点击开始/停止)")}"><i class="fa-solid fa-microphone"></i></button>
      <button type="button" class="fvtt-tts-send" title="${_L("ui.send", "发送到聊天框（选语气并自动朗读）")}"><i class="fa-solid fa-paper-plane"></i></button>`;
    document.body.appendChild(bar);
  }
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
        const r = await fetch(`${cfgV.serverUrl}/characters/switch`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
        await r.json();
      } catch (e) { /* 服务不可达时仅本地生效 */ }
    }
    renderQuickUI();
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

let submitLocked = false;   // 防重复提交(AI 判断慢时连点会出多个语音)

async function doSubmitChat(ta) {
  const v = String(ta.value || "").trim();
  if (!v) { notifyOnce(_L("ui.sendEmpty", "输入框为空"), "info"); return; }
  if (v.startsWith("/")) {
    // 命令行必须走 Foundry 自带回车解析(避免手动创建破坏命令语义)
    notifyOnce(_L("ui.cmdHint", "命令(以/开头的行)请直接按回车发送"), "info");
    return;
  }
  if (submitLocked) { notifyOnce(_L("ui.sending", "正在发送…"), "info"); return; }
  submitLocked = true;
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
        emotionMix: (cur1 && typeof cur1.emotionMix === "number") ? cur1.emotionMix : 0.5,
        emotionMod: (cur1 && typeof cur1.emotionMod === "number") ? cur1.emotionMod : 0.5,
        polish: (cur1 && cur1.polishText) || "",
        speed: (cur1 && cur1.speed) || 0,
        lang: getCfg().textLang || "auto"
      } }
    };
    if (CONST.CHAT_MESSAGE_STYLES) data.style = CONST.CHAT_MESSAGE_STYLES.IC;
    else data.type = CONST.CHAT_MESSAGE_TYPES.IC;
    try {
      await ChatMessage.create(data);
      try { ta.value = ""; ta.focus(); } catch (e) { /* noop */ }
    } catch (err) {
      console.error("[gpt-sovits-tts] 消息创建失败:", err);
      notifyOnce(_L("ui.sendFail", "发送失败"), "warn");
    }
  } finally {
    submitLocked = false;
  }
}

/* ---------- 发送并朗读面板: 语气选择 + 调配设定 ---------- */
let sendPopEl = null;

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
    if (typeof cur.emotionMix !== "number") cur.emotionMix = 0.5;   // 情绪占比: 0纯默认 ~ 1全情绪
    if (typeof cur.emotionMod !== "number") cur.emotionMod = 0.5;   // 情感参数调制: 语速等参数强度
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
    } else {
      cur.auxRef = "";
    }
    await saveVoiceProfile(prof);
    renderQuickUI();
    return true;
  } catch (e) { console.error("[gpt-sovits-tts] 应用语气失败:", e); return false; }
}

function sendPopCurrentChars() {
  return (quickChars && quickChars.chars) || [];
}

function buildSendPop() {
  if (sendPopEl && document.body.contains(sendPopEl)) return sendPopEl;
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
      <div class="fvtt-tts-sendpop-tune">
        <label class="fvtt-tts-sendpop-tuneline"><span>${_L("ui.volume", "朗读音量")}</span><input type="range" class="fvtt-tts-sendpop-vol" min="0" max="1" step="0.05" value="0.8"></label>
        <label class="fvtt-tts-sendpop-tuneline"><span>${_L("ui.speed", "语速")}</span><input type="range" class="fvtt-tts-sendpop-speed" min="0.5" max="1.5" step="0.05" value="1"></label>
        <label class="fvtt-tts-sendpop-tuneline"><span title="${_L("ui.emotionMixTip", "0% 纯默认主参考；100% 情绪音频作唯一参考；中间主参考+情绪融合")}">${_L("ui.emotionMix", "情绪占比")} <b class="fvtt-tts-sendpop-mixval">50%</b></span><input type="range" class="fvtt-tts-sendpop-mix" min="0" max="100" step="5" value="50"></label>
        <label class="fvtt-tts-sendpop-tuneline"><span title="${_L("ui.emotionModTip", "用语速等参数调制情感：0% 不调制；100% 完全按情绪语速(开心快/悲伤慢)")}">${_L("ui.emotionMod", "情感参数调制")} <b class="fvtt-tts-sendpop-modval">50%</b></span><input type="range" class="fvtt-tts-sendpop-mod" min="0" max="100" step="5" value="50"></label>
<label class="fvtt-tts-sendpop-tuneline"><span title="${_L("ui.styleTip", "朗读风格提示词：如“更严肃认真、中间不要中断”。会翻译成语速/停顿等合成参数，角色独立记得。")}">${_L("ui.stylePrompt", "朗读风格")}</span><input type="text" class="fvtt-tts-sendpop-style" placeholder="${_L("ui.stylePh", "如：更严肃认真，中间不要中断")}" maxlength="120"></label>
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
    // 直出 = 提交即发送; 朗读环节自动 AI 判断+润色(选了手动语气则用所选)
    closeSendPop();
    doSubmitChat(ta);
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
    if (btnP2.classList.contains("done") && preloadAudio && preloadAudio.text === tnow && preloadAudio.watchKey === makeWatchKey()) {
      closeSendPop();
      doSubmitChat(ta);
      return;
    }
    const cfgP2 = getCfg();
    if (!cfgP2.llmEnabled || !cfgP2.llmKey) {
      ui.notifications.warn(_L("ui.aiNoKey", "未配置 AI：请到语音设置填 API 密钥并开启 LLM"));
      return;
    }
    // done + 文字已改 → 继承进度: 不重复预热 LLM, 直接按当前文字预合成再发送
    // idle → 完整预加载(预热 LLM + 合成当前文字)
    const wasDone = btnP2.classList.contains("done");
    const alreadyWarm = !!window.__aiPreloaded || !!preloadAudio;
    const oldP2 = btnP2.textContent;
    btnP2.textContent = "⏳ " + (alreadyWarm ? _L("ui.preloadingNow", "合成中…") : _L("ui.preloadingNow", "预加载中…"));
    btnP2.classList.add("loading");
    btnP2.disabled = false;   // 预加载中可点击 → 直接发送(继承进度)
    try {
      if (!alreadyWarm) {
        const r = (typeof window.preloadAI === "function") ? await window.preloadAI() : null;
        if (!r || !r.ok) {
          btnP2.textContent = oldP2;
          btnP2.classList.remove("loading");
          ui.notifications.warn(_L("ui.preloadFail", "预加载失败") + ": " + ((r && r.message) || "unknown"));
          return;
        }
      }
      // 按当前角色/语气/情绪占比预合成这段输入文本(与发送时的声音完全一致)
      const stripP = tnow;
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
      } else if (cfgP2.llmEnabled && cfgP2.llmKey) {
        // 无手动语气 → 与发送时一致: AI 判断语气(不改台词), 预合成音频带 AI 语气, 避免"预加载默认 vs 发送 AI 语气"听感不一
        try {
          const resP = await judgeAndPolishByLLM(stripP, roleP, false, "");
          if (resP.ok && resP.emotion) {
            const slotP = findEmotionSlot(resP.emotion, roleP);
            if (slotP) {
              if (slotP.ref_audio_path) overridesP.auxRefAudioPaths = [`fvtt_chars/${roleP}/${slotP.ref_audio_path}`];
              if (slotP.prompt_text) overridesP.promptText = slotP.prompt_text;
              if (slotP.prompt_lang) overridesP.promptLang = slotP.prompt_lang;
              aiEmoP = resP.emotion;
            }
          }
        } catch (e) { /* AI 失败沿用默认 */ }
      }
      const curP = (profP.chars && profP.chars[roleP]) || {};
      if (typeof curP.emotionMix === "number") overridesP.emotionMix = curP.emotionMix;
      else if (aiEmoP) overridesP.emotionMix = 0.75;   // AI 判断语气 → 与发送时情绪占比一致
      const { blob, audioUrl } = await gptSovitsSynth(stripP, cfgP2.textLang || "auto", { serverUrl: cfgP2.serverUrl, speedFactor: cfgP2.speedFactor || 1, overrides: Object.keys(overridesP).length ? overridesP : null, mediaType: "mp3", asBlob: true });
      const objUrl = URL.createObjectURL(blob);
      const b64 = await blobToBase64(blob);
      if (preloadAudio && preloadAudio.url) { try { URL.revokeObjectURL(preloadAudio.url); } catch (e) { /* noop */ } }
      preloadAudio = { text: stripP, lang: cfgP2.textLang || "auto", url: objUrl, audioUrl: audioUrl || "", dataUrl: `data:audio/mpeg;base64,${b64}`, mime: "audio/mpeg", ts: Date.now(), watchKey: makeWatchKey() };
      btnP2.textContent = _L("ui.preloadedBtn", "✓ 已预加载");
      btnP2.title = _L("ui.preloadedSendTip", "音频已就绪，再点直接播出");
      btnP2.classList.remove("loading");
      btnP2.classList.add("done");
      // 用户是"done + 文字已改"点进来的 → 合成完立即发送(继承进度, 不再等第二次点击)
      if (wasDone) {
        closeSendPop();
        doSubmitChat(findChatTextarea());
        return;
      }
    } catch (e) {
      btnP2.textContent = oldP2;
      btnP2.classList.remove("loading");
      ui.notifications.warn(_L("ui.preloadFail", "预加载失败") + ": " + ((e && e.message) || "unknown"));
    }
  });
  // 恢复预加载状态: 已预合成的音频(角色/语气/语言未变)按钮直接显示 done, 再点即发送; 签名变了 → 回到未预加载
  const preBtn = pop.querySelector(".fvtt-tts-sendpop-preload");
  if (preBtn && preloadAudio && preloadAudio.url && preloadAudio.watchKey === makeWatchKey()) {
    preBtn.textContent = _L("ui.preloadedBtn", "✓ 已预加载");
    preBtn.title = _L("ui.preloadedSendTip", "音频已就绪，再点直接播出");
    preBtn.classList.add("done");
  }
  // 音量/语速(实时写设置)
  const vol = pop.querySelector(".fvtt-tts-sendpop-vol");
  const spd = pop.querySelector(".fvtt-tts-sendpop-speed");
  const cfg0 = getCfg();
  vol.value = String(cfg0.volume || 0);
  spd.value = String(cfg0.speedFactor || 1);
  vol.addEventListener("input", () => game.settings.set(MODULE, "volume", parseFloat(vol.value)).catch(() => {}));
  spd.addEventListener("input", () => game.settings.set(MODULE, "speedFactor", parseFloat(spd.value)).catch(() => {}));
  // 情绪占比 / 情感参数调制 → 保存到当前角色档案
  const saveMix = () => {
    const prof = loadVoiceProfile();
    const charName = prof.current || "";
    if (!charName) return;
    prof.chars = prof.chars || {};
    const cur = prof.chars[charName] || (prof.chars[charName] = { name: charName });
    cur.emotionMix = parseFloat(pop.querySelector(".fvtt-tts-sendpop-mix").value) / 100;
    cur.emotionMod = parseFloat(pop.querySelector(".fvtt-tts-sendpop-mod").value) / 100;
    try { saveVoiceProfile(prof); } catch (e) { /* noop */ }
    pop.querySelector(".fvtt-tts-sendpop-mixval").textContent = pop.querySelector(".fvtt-tts-sendpop-mix").value + "%";
    pop.querySelector(".fvtt-tts-sendpop-modval").textContent = pop.querySelector(".fvtt-tts-sendpop-mod").value + "%";
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

  sendPopEl = pop;
  return pop;
}

/* ---------- LLM 语气判断(可选): 有密钥时 AI 自动判断语气, 无密钥手动选择 ---------- */
async function judgeEmotionByLLM(text, charName, context) {
  const cfg = getCfg();
  if (!cfg.llmEnabled || !cfg.llmKey) return { ok: false, emotion: "", reason: "no-llm" };
  try {
    // 确保角色/情绪槽数据已加载(no-slots 修复: quickChars 未加载/过期时先拉取)
    if (!quickChars) { try { await loadQuickChars(); } catch (e) { /* noop */ } }
    const c = (quickChars && quickChars.chars || []).find(x => x.name === charName);
    let slots = (c && c.emotions) || [];
    if (!slots.length) {
      // 兜底: 实时向服务端要角色(缓存可能过期或未刷新)
      try {
        const cfgS = getCfg();
        const r = await fetch(`${cfgS.serverUrl}/characters`, { signal: AbortSignal.timeout(15000) });
        const j = await r.json().catch(() => ({}));
        if (j && j.ok && Array.isArray(j.chars)) {
          quickChars = j;
          const c2 = j.chars.find(x => x.name === charName);
          slots = (c2 && c2.emotions) || [];
        }
      } catch (e) { /* noop */ }
    }
    if (!slots.length) return { ok: false, emotion: "", reason: "no-slots" };
    const r = await fetch(`${cfg.serverUrl}/llm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        base: cfg.llmBaseUrl || "https://api.openai.com/v1",
        key: cfg.llmKey,
        model: cfg.llmModel || "gpt-4o-mini",
        text: String(text || ""),
        context: context || "",
        emotions: slots.map(s => ({ key: s.key, label: s.label })),
      }),
      signal: AbortSignal.timeout(70000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) return { ok: false, emotion: "", reason: (j && j.message) || ("http " + r.status) };
    return { ok: true, emotion: (j && j.emotion) || "" };
  } catch (e) {
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
    const list = [...new Set([...LLM_PRESET_MODELS, ...models])];
    sel.innerHTML = (list.map(m => `<option value="${esc(m)}" ${m === cur ? "selected" : ""}>${esc(m)}</option>`).join("")) || `<option value="">-</option>`;
  } catch (e) { /* noop */ }
}

/** 调服务端 /llm/models 拉取模型列表 */
async function fetchModelsFromServer(base, key) {
  const cfg = getCfg();
  const r = await fetch(`${cfg.serverUrl}/llm/models`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ base, key }),
    signal: AbortSignal.timeout(40000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) return { ok: false, message: (j && j.message) || ("http " + r.status) };
  return { ok: true, models: (j.models) || [] };
}

/** 预加载 AI: 提前跑一次 LLM 小请求, 让连接/鉴权/模型热起来, 减少后续首次调用延迟(润色/判断会更快) */
window.preloadAI = async function preloadAI() {
  const cfg = getCfg();
  if (!cfg.llmEnabled || !cfg.llmKey) return { ok: false, message: "未配置 AI（先填密钥并开启）" };
  try {
    const t0 = performance.now();
    const r = await fetch(`${cfg.serverUrl}/llm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        base: cfg.llmBaseUrl || "https://api.openai.com/v1",
        key: cfg.llmKey,
        model: cfg.llmModel || "gpt-4o-mini",
        text: "你好，很高兴见到你。",
        emotions: [{ key: "calm", label: "平静" }, { key: "happy", label: "开心" }],
      }),
      signal: AbortSignal.timeout(60000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) return { ok: false, message: (j && j.message) || ("http " + r.status) };
    window.__aiPreloaded = true;   // 共享预热状态(语音设置面板/发送面板都不再重复预热)
    return { ok: true, ms: Math.round(performance.now() - t0), emotion: (j.emotion) || "" };
  } catch (e) {
    return { ok: false, message: (e && e.message) || "err" };
  }
};

/** AI 台词润色(可选, 复刻成品软件"语气更多样"): 按情绪微调台词表达, 不改变原意 */
async function polishTextByLLM(text, emotion, emotionLabel, context) {
  const cfg = getCfg();
  if (!cfg.llmEnabled || !cfg.llmKey || !cfg.llmPolish) return { ok: false, text: "" };
  try {
    const r = await fetch(`${cfg.serverUrl}/llm/polish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        base: cfg.llmBaseUrl || "https://api.openai.com/v1",
        key: cfg.llmKey,
        model: cfg.llmModel || "gpt-4o-mini",
        text: String(text || ""),
        context: context || "",
        emotion: String(emotion || ""),
        emotion_label: String(emotionLabel || emotion || ""),
      }),
      signal: AbortSignal.timeout(70000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok || !j.text) return { ok: false, text: "" };
    const out = String(j.text).trim();
    return out ? { ok: true, text: out } : { ok: false, text: "" };
  } catch (e) {
    return { ok: false, text: "" };
  }
}

/** 判断+润色合并(可选开关 llmMergePolish): 一次 LLM 调用返回 {emotion, polish}.
 *  关闭时退回分开两次调用(judgeEmotionByLLM + polishTextByLLM). */
async function judgeAndPolishByLLM(text, charName, wantPolish, context) {
  const cfg = getCfg();
  try {
    // 先确保情绪槽数据(与 judgeEmotionByLLM 相同的保护)
    if (!quickChars) { try { await loadQuickChars(); } catch (e) { /* noop */ } }
    const c = (quickChars && quickChars.chars || []).find(x => x.name === charName);
    let slots = (c && c.emotions) || [];
    if (!slots.length) {
      try {
        const r = await fetch(`${cfg.serverUrl}/characters`, { signal: AbortSignal.timeout(15000) });
        const j = await r.json().catch(() => ({}));
        if (j && j.ok && Array.isArray(j.chars)) {
          quickChars = j;
          const c2 = j.chars.find(x => x.name === charName);
          slots = (c2 && c2.emotions) || [];
        }
      } catch (e) { /* noop */ }
    }
    if (!slots.length) return { ok: false, emotion: "", reason: "no-slots" };
    const emotionsList = slots.map(s => ({ key: s.key || s.id || "", label: s.label || "" })).filter(e => e.key);
    if (!emotionsList.length) return { ok: false, emotion: "", reason: "no-slots" };
    if (cfg.llmMergePolish) {
      // 合并: 一次调用同时给情绪 + 润色稿
      try {
        const r = await fetch(`${cfg.serverUrl}/llm/assess`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            base: cfg.llmBaseUrl || "https://api.openai.com/v1",
            key: cfg.llmKey,
            model: cfg.llmModel || "gpt-4o-mini",
            text: String(text || ""),
            context: context || "",
            emotions: emotionsList,
            role: charName || "",
            setting: (c && c.setting) || "",
            polish: !!wantPolish,
          }),
          signal: AbortSignal.timeout(70000),
        });
        const j = await r.json().catch(() => ({}));
        if (r.ok && j.ok && j.emotion) {
          return { ok: true, emotion: String(j.emotion), polish: String(j.polish || "").trim() };
        }
        // 合并调用失败/结果为空 → 回退分开调用(保证情绪判断不丢失)
        console.debug("[gpt-sovits-tts] 合并语气判断失败, 回退分开调用:", (j && j.message) || ("http " + r.status));
      } catch (e) {
        console.debug("[gpt-sovits-tts] 合并语气判断异常, 回退分开调用:", e && e.message);
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
    return { ok: true, emotion: j1.emotion, polish };
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
  return slots.find(s => s.key === emotionKey)                    // 槽 key(voice_00)
    || slots.find(s => s.label === emotionKey)                    // 中文 label 精确("生气")
    || slots.find(s => s.label && emotionKey && s.label.includes(emotionKey))   // AI 返回的子串/变体
    || null;
}

function renderSendPopEmotions() {
  if (!sendPopEl || !document.body.contains(sendPopEl)) return;
  const prof = loadVoiceProfile();
  const charName = prof.current || "";
  const c = sendPopCurrentChars().find(x => x.name === charName);
  const slots = (c && c.emotions) || [];
  const grid = sendPopEl.querySelector(".fvtt-tts-sendpop-emogrid");
  if (!grid) return;
  const curEmo = prof.emotion || "";
  grid.innerHTML = `<button type="button" class="fvtt-tts-sendpop-emo ${curEmo ? "" : "on"}" data-key="">${_L("ui.emotionNone", "默认")}</button>`
    + slots.map(s => `<button type="button" class="fvtt-tts-sendpop-emo ${s.key === curEmo ? "on" : ""} ${s.bound ? "" : "off"}" data-key="${esc(s.key)}" title="${s.bound ? esc(s.label) : esc(s.label) + "（未绑定参考音）"}">${esc(s.label)}</button>`).join("");
  // 恢复情绪占比/参数调制滑块值
  const prof2 = loadVoiceProfile();
  const cur2 = (prof2.chars && prof2.chars[prof2.current]) || {};
  const mix = sendPopEl.querySelector(".fvtt-tts-sendpop-mix");
  const mod = sendPopEl.querySelector(".fvtt-tts-sendpop-mod");
  if (mix) { mix.value = String(Math.round((typeof cur2.emotionMix === "number" ? cur2.emotionMix : 0.5) * 100)); sendPopEl.querySelector(".fvtt-tts-sendpop-mixval").textContent = mix.value + "%"; }
  if (mod) { mod.value = String(Math.round((typeof cur2.emotionMod === "number" ? cur2.emotionMod : 0.5) * 100)); sendPopEl.querySelector(".fvtt-tts-sendpop-modval").textContent = mod.value + "%"; }
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
  const ta = findChatTextarea();
  const fire = pop.querySelector(".fvtt-tts-sendpop-fire");
  if (fire) fire.disabled = !(ta && String(ta.value || "").trim());
}

function closeSendPop() {
  if (sendPopEl && document.body.contains(sendPopEl)) { sendPopEl.style.display = "none"; }
}

/* 快捷角色/情绪切换: 数据与渲染 */
let quickChars = null;   // /characters 缓存
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
  if (!force && quickChars && Array.isArray(quickChars.chars) && quickChars.chars.length) return quickChars;
  try {
    const r = await fetch(`${getCfg().serverUrl}/characters`, { signal: AbortSignal.timeout(15000) });
    if (r.ok) {
      quickChars = await r.json();
      try { localStorage.setItem(QC_STORE_KEY, JSON.stringify(quickChars)); } catch (e) { /* noop */ }
    } else {
      quickChars = readQuickCharsCache();
      _scheduleQCRetry();
    }
  } catch (e) {
    quickChars = readQuickCharsCache();
    _scheduleQCRetry();
  }
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
  const st = document.querySelector(".fvtt-tts-bar .fvtt-tts-status");
  if (!st) return;
  const cfg = getCfg();
  st.classList.toggle("ok", cfg.engine === "gptsovits" && statusInfo.ok === true);
  st.classList.toggle("fail", cfg.engine === "gptsovits" && statusInfo.ok === false);
  st.classList.toggle("unknown", cfg.engine !== "gptsovits" || statusInfo.ok === null);
  st.title = statusTitle();
  st.innerHTML = cfg.engine === "gptsovits" ? '<i class="fa-solid fa-volume-high"></i>' : '<i class="fa-solid fa-language"></i>';
}

function updateMicUI() {
  const mic = document.querySelector("#fvtt-tts-floatbar .fvtt-tts-mic");
  if (!mic) return;
  const active = !!(dictation && dictation.active);
  mic.classList.toggle("active", active);
  mic.title = active ? _L("ui.micStop", "正在听写…点击停止") : _L("ui.mic", "语音听写(点击开始/停止)");
  mic.innerHTML = active ? '<i class="fa-solid fa-microphone-lines"></i>' : '<i class="fa-solid fa-microphone"></i>';
  updateCharIndicator();   // 角色指示物(悬浮条/输入框立绘)随角色/设置刷新
}

/* ============ 打字即读 ============ */
function attachTyping() {
  const cfg = getCfg();
  if (!cfg.typingVoice && !cfg.commands) return;
  const ta = document.getElementById("chat-message");
  if (!ta || ta.dataset.fvttTtsAttached) return;
  ta.dataset.fvttTtsAttached = "1";
  ta.addEventListener("input", () => {
    const c = getCfg();
    if (!c.typingVoice || (c.triggerMode !== "typing" && c.triggerMode !== "both")) return;
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      const el = document.getElementById("chat-message");
      if (!el) return;
      const text = el.value.replace(/\s+/g, " ").trim();
      if (!text || text.startsWith("/")) return;
      if (text.length < c.minLength) return;
      if (text === lastTypedSpoken.text && Date.now() - lastTypedSpoken.ts < 30000) return;
      lastTypedSpoken = { text, ts: Date.now() };
      speak(text);
    }, c.typingDebounce);
  });
  ta.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) cancelTypingDebounce();
  });
}

function cancelTypingDebounce() {
  clearTimeout(typingTimer);
  typingTimer = null;
}

/* ============ 听写 ============ */
function mapSttLang(lang) {
  const m = { auto: "auto", zh: "zh-CN", ja: "ja-JP", en: "en-US" };
  return m[lang] || "auto";
}

function toggleDictation() {
  const cfg = getCfg();
  if (!cfg.sttEnabled) { notifyOnce(_L("errors.sttDisabled", "听写功能未启用"), "info"); return; }
  if (dictation && dictation.active) { dictation.stop(); dictation = null; updateMicUI(); return; }
  refreshTtsDevices();  // 刷新设备缓存(拿到设备名, 供配置设定下拉显示)
  if (dictation && dictation.active) { dictation.stop(); dictation = null; updateMicUI(); return; }
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
    dictation = BrowserSTT.start({ lang: mapSttLang(lang), onResult, onError, onState });
  } else {
    if (!ServerSTT.supported()) { notifyOnce(_L("errors.sttServer", "当前浏览器无法使用麦克风录音")); return; }
    dictation = ServerSTT.start({ serverUrl: cfg.serverUrl, lang, deviceId: devId, onResult, onError, onState });
  }
  updateMicUI();
}

async function handleDictated(text) {
  if (!text) return;
  const cfg = getCfg();
  dictation = null;
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
      queue.enqueue({ play: () => audioPlay(cached.url, { volume: getCfg().volume }) });
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
window.__fvttTTSPatch = "lipin-v2+selftest2";   // 版本指纹: 自检报告显示它, 判断页面是否加载了最新 JS
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
      const resp = await fetch(`${getCfg().serverUrl}/characters`, { signal: AbortSignal.timeout(10000) });
      const jd = await resp.json();
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
      const r = await fetch(`${getCfg().serverUrl}/status`, { signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      out.net.status = { ok: r.ok, char: (j.character && j.character.name) || "", device: j.device || "" };
    } catch (e) { out.net.status = { err: String(e).slice(0, 60) }; }
    try {
      const t0 = Date.now();
      const r = await fetch(`${getCfg().serverUrl}/tts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "测试", text_lang: "zh", media_type: "mp3", speed_factor: 1.0 }), signal: AbortSignal.timeout(60000) });
      out.net.ttsMin = { ok: r.ok, size: r.headers.get("content-length") || "?", ms: Date.now() - t0 };
    } catch (e) { out.net.ttsMin = { err: String(e).slice(0, 60) }; }
    // 生成/传输耗时分段: 阶段1=服务端合成+回传(genMs) → 阶段2=音频 URL 纯传输(xferMs)
    let _stAudioUrl = "";   // 供真实语音广播测试复用(不再重复合成)
    try {
      const t0 = Date.now();
      const r1 = await fetch(`${getCfg().serverUrl}/tts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "传输测试", text_lang: "zh", media_type: "mp3", speed_factor: 1.0 }), signal: AbortSignal.timeout(60000) });
      const t1 = Date.now();
      let jd = {};
      try { jd = await r1.json(); } catch (e) { /* noop */ }
      const t2 = Date.now();
      const url = r1.headers.get("X-Fvtt-Audio-Url") || r1.headers.get("X-Audio-Url") || jd.audioUrl || jd.url || "";   // 服务端音频 URL 在响应头, JSON 里没有(优先 Foundry 静态路径)
      _stAudioUrl = url;
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
    const r = await fetch(`${getCfg().serverUrl}/selftest`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(out), signal: AbortSignal.timeout(15000) });
    const jd = await r.json().catch(() => ({}));
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
    const r0 = await fetch(`${url}/selftest/transfer-start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }), signal: AbortSignal.timeout(8000) });
    if (!r0.ok) throw new Error("start " + r0.status);
  } catch (e) { out.err = "start:" + String(e).slice(0, 50); return out; }
  try { game.socket.emit(MODULE, { type: "selftest-transfer", id, ts: Date.now() }); out.sent = true; } catch (e) { out.err = "emit:" + String(e).slice(0, 50); }
  await new Promise(r => setTimeout(r, 3000));
  try {
    const r1 = await fetch(`${url}/selftest/transfer-result?id=${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(8000) });
    const j = await r1.json().catch(() => ({}));
    out.arrivals = (j && j.arrivals) || [];
    out.arrivalCount = out.arrivals.length;
  } catch (e) { out.err = "result:" + String(e).slice(0, 50); }
  return out;
}

/* ============ 高压测试: 并发/长文本/连续合成/广播风暴/批量立绘 — 结果并入 selftest_report.json(stress 段) ============ */
async function runStressTest() {
  const url = getCfg().serverUrl;
  const out = {
    at: new Date().toISOString(), mode: "stress",
    env: { patch: String(window.__fvttTTSPatch || ""), user: (typeof game !== "undefined" && game.user && game.user.name) || "" },
    stress: {},
  };
  const synthOne = async (text, ms = 90000) => {
    try {
      const t0 = Date.now();
      const r = await fetch(`${url}/tts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, text_lang: "zh", media_type: "mp3", speed_factor: 1.0 }), signal: AbortSignal.timeout(ms) });
      let audioUrl = "";
      try { audioUrl = r.headers.get("X-Audio-Url") || ""; if (audioUrl && !/^https?:\/\//i.test(audioUrl)) audioUrl = new URL(audioUrl, url).href; } catch (e) { /* noop */ }
      const buf = r.ok ? await r.arrayBuffer() : null;
      return { ok: r.ok, status: r.status, ms: Date.now() - t0, size: buf ? buf.byteLength : 0, audioUrl };
    } catch (e) { return { ok: false, err: String(e).slice(0, 40) }; }
  };
  // 1) 并发合成(uvicorn 单 worker → 引擎串行排队, 测稳定性/总耗时) — 8 路并发(更高压力)
  try {
    const texts = ["你好", "今天天气不错", "我们去公园散步吧", "测试并发压力", "这句话是第五段压力测试", "第六段文本也一起合成", "第七段继续压测", "第八段收尾"];
    const t0 = Date.now();
    const res = await Promise.all(texts.map(t => synthOne(t)));
    out.stress.concurrent = {
      sent: texts.length, ok: res.filter(r => r.ok).length, fail: res.filter(r => !r.ok).length,
      totalMs: Date.now() - t0, perMs: res.map(r => r.ms), sizes: res.map(r => r.size), errors: res.filter(r => !r.ok).map(r => r.err || r.status),
    };
  } catch (e) { out.stress.concurrent = { err: String(e).slice(0, 80) }; }
  // 2) 长文本(cut5 多段切分 + 硬件自适应 batch → 测长句稳定性) — 60 句约 1100 字
  let lastAv = "";
  try {
    const long = "这是我们的一段长文本压力测试，用来验证切分与批量合成是否稳定。".repeat(60);
    const t0 = Date.now();
    const r = await synthOne(long, 180000);
    if (r.audioUrl) lastAv = r.audioUrl;
    out.stress.longText = { ok: r.ok, status: r.status || 0, chars: long.length, synthMs: r.ms, size: r.size, err: r.err || "" };
  } catch (e) { out.stress.longText = { err: String(e).slice(0, 80) }; }
  // 3) 连续合成(快速连说 8 句, 模拟连续发言)
  try {
    const t0 = Date.now();
    const res = [];
    for (let i = 0; i < 8; i++) {
      const r = await synthOne("连续第" + (i + 1) + "句压力测试");
      if (r.audioUrl) lastAv = r.audioUrl;
      res.push(r);
    }
    out.stress.sequential = { sent: 8, ok: res.filter(r => r.ok).length, totalMs: Date.now() - t0, avgMs: Math.round((Date.now() - t0) / 8), perMs: res.map(r => r.ms) };
  } catch (e) { out.stress.sequential = { err: String(e).slice(0, 80) }; }
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
    const r = await fetch(`${url}/llm/pick-role`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ base: _base, key: _key, model: _model, text: "这是一段测试台词", roles: ["七海千秋", "阿尔托莉雅·潘德拉贡"] }), signal: AbortSignal.timeout(20000) });
    const j = await r.json().catch(() => ({}));
    out.stress.llm = { ok: r.ok, status: r.status || 0, hasKey: !!_key, model: _model || "(空→默认gpt-4o-mini)", role: (j && j.role) || "", ms: Date.now() - t0, note: _model ? "" : "llmModel 设置为空 → 服务端用默认 gpt-4o-mini; 若该模型在服务商不可用会 502, 请在设置里填真实模型名" };
  } catch (e) { out.stress.llm = { err: String(e).slice(0, 60) }; }
  let resText = "no-response";
  try {
    const r = await fetch(`${url}/selftest`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(out), signal: AbortSignal.timeout(15000) });
    const jd = await r.json().catch(() => ({}));
    resText = (jd && jd.file) || ("HTTP " + r.status);
  } catch (e) { resText = "err:" + String(e).slice(0, 50); }
  try { ui.notifications.info(`高压测试完成\n${resText}`); } catch (e) { /* noop */ }
  try { console.log("[gpt-sovits-tts] 高压测试报告:", JSON.stringify(out, null, 2)); } catch (e) { /* noop */ }
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
    isDictating: () => !!(dictation && dictation.active),
    openVoiceManager: () => VoiceManager.open(),
    // 内置自检: 一键跑全部测试 → 报告写入服务端 selftest_report.json
    runSelfTest: () => runSelfTest(),
    // 高压测试: 并发/长文本/连续合成/广播风暴/批量立绘 → 同样写入 selftest_report.json(stress 段)
    runStressTest: () => runStressTest(),
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
});

Hooks.once("ready", () => {
  setupAPI();
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
  if (game.socket && typeof game.socket.on === "function") game.socket.on(MODULE, handleSocketTts);
  // 语音运行者服务声明: 本机跑服务则定期广播(玩家中途加入也能看到)
  setTimeout(() => { announceTtsService(); }, 6000);
  setInterval(() => { announceTtsService(); }, 60000);
});

// HUD 主题设置保存后立即生效; 语音运行者选择 = 切换本机服务地址
Hooks.on("updateSetting", (setting, data) => {
  try {
    if (setting && setting.key) {
      if (setting.key === `${MODULE}.hudTheme`) applyHudTheme();
      if (setting.key === `${MODULE}.portraitSize`) applyPortraitSize();
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

Hooks.on("chatMessage", (chatLog, message, chatData) => {
    handleCommand(chatLog, message, chatData);
    // 携带说话者当前音色上下文到消息 flags → 全员用同一 ref 合成, 听到同一个声音
    try {
      const prof0 = loadVoiceProfile();
      const cur = currentVoice();
      const fl = {
        role: prof0.current || "",
        emotion: (cur && cur.emotion) || "",
        ref: (cur && cur.ref) || "",
        auxRef: (cur && cur.auxRef) || "",
        promptText: (cur && cur.promptText) || "",
        promptLang: (cur && cur.promptLang) || "",
        emotionMix: (cur && typeof cur.emotionMix === "number") ? cur.emotionMix : 0.5,
        emotionMod: (cur && typeof cur.emotionMod === "number") ? cur.emotionMod : 0.5,
        speed: (cur && cur.speed) || 0,
        lang: cfg.textLang || "auto",
      };
      chatData.flags = chatData.flags || {};
      chatData.flags[MODULE] = fl;
    } catch (e) { /* noop */ }
  });

Hooks.on("createChatMessage", (message, options, userId) => { maybeSpeak(message); maybePickAvatarRole(message); });

// 填完 LLM API 网址/密钥保存后, 自动拉取可用模型 → 设置页里模型下拉自动出现可选项
Hooks.on("updateSetting", (key, value, options, userId) => {
  if (key !== `${MODULE}.llmKey` && key !== `${MODULE}.llmBaseUrl`) return;
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
// 立绘插入: 立即插 + 250ms 延迟补插(等 Foundry/系统后续渲染完成后重插, 防止图被渲染流程冲掉)
// 自检 manualApply 已证明: 对"已挂载的消息元素"调用必然成功, 所以补插必须用 message.element(挂载后)
function _applyAvatarWithRetry(message, html) {
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
  Hooks.on("renderChatMessageHTML", (message, html) => { _applyAvatarWithRetry(message, html); });
} else {
  Hooks.on("renderChatMessage", (message, html) => { _applyAvatarWithRetry(message, html); });
}
// 聊天同步播放(主通道, 替代依赖 socket 广播): 发送方合成后把音频 Foundry 路径写回消息 flags,
// 聊天文档同步是数据库级(可靠) → 其他客户端(pl)收到 update 立即播放 — socket 广播不通/延迟时不再等 15s 兜底
Hooks.on("updateChatMessage", (message, changed) => {
  try {
    if (!message || !changed) return;
    const flags = (message.flags && message.flags[MODULE]) || {};
    const hasUrl = (changed["flags.gpt-sovits-tts.audioUrl"] != null)
      || (changed.flags && changed.flags[MODULE] && changed.flags[MODULE].audioUrl != null)
      || flags.audioUrl;
    if (!hasUrl || !message.id) return;
    if (message.author && message.author.isSelf) return;   // 作者本地已播
    if (playedIds.has(message.id)) return;   // socket 广播已播过则不重复
    const rel = flags.audioUrl || "";
    if (!rel) return;
    const full = /^https?:\/\//i.test(rel) ? rel
      : (rel.startsWith("/modules/") || rel.startsWith("/data/")) ? new URL(rel, window.location.origin).href
      : `${getCfg().serverUrl.replace(/\/+$/, "")}${rel}`;
    fetch(full, { signal: AbortSignal.timeout(15000) })
      .then(r => { if (!r.ok) throw new Error("audio fetch " + r.status); return r.blob(); })
      .then(b => {
        const u = URL.createObjectURL(new Blob([b], { type: "audio/mpeg" }));
        if (message.id) cacheAudio(message.id, u, "audio/mpeg");
        playedIds.add(message.id);
        setTimeout(() => { try { playedIds.delete(message.id); } catch (e) { /* noop */ } }, 30000);
        queue.enqueue({ play: () => audioPlay(u, { volume: getCfg().volume }) });
      })
      .catch(() => { /* 拉取失败: 15s 兜底会接管 */ });
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

// 情绪→立绘 / 角色立绘: 消息带角色时, 在内容前显示该角色的立绘(语气槽立绘优先); 无角色不显示
function applyEmotionAvatar(message, html) {
  try {
    const cfgM = getCfg();
    // 立绘展示方式: 仅指示物/都不显示 → 消息内不插图
    if (cfgM.portraitMode !== "message" && cfgM.portraitMode !== "both") return;
    const fl = message && message.flags ? (message.flags[MODULE] || null) : null;
    const el = html && (typeof html.querySelector === "function") ? html : null;
    if (!el) return;
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
    let av = (slot && slot.avatar) || (c && c.avatar) || "";
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
    if (!av) return;   // 角色都没有立绘 → 不显示
    const body = el.querySelector(".message-content") || el;
    // 同一消息只插一次
    if (body.querySelector(".fvtt-tts-emotion-avatar")) return;
    const img = document.createElement("img");
    img.src = av;
    img.className = "fvtt-tts-emotion-avatar";
    img.alt = role || "";
    img.title = role || "";
    if (body.firstChild) body.insertBefore(img, body.firstChild);
    else body.appendChild(img);
    // 消息 header 的"玩家头像"也随语气换(发送消息时玩家形象随语气变化)— 没有语气槽时用角色立绘
    try {
      const hdr = el.querySelector(".message-header") || el.querySelector(".message-sender");
      const himg = hdr && (hdr.querySelector("img") || hdr.querySelector(".avatar"));
      if (himg && av) {
        try {
          if (!himg.dataset.fvttOrigSrc) himg.dataset.fvttOrigSrc = himg.getAttribute("src") || "";   // 记住原始玩家头像(切"都不显示"时可恢复)
          if (himg.getAttribute("src") !== av) himg.setAttribute("src", av);
        } catch (e) { /* noop */ }
      }
    } catch (e) { /* noop */ }
  } catch (e) { /* noop */ }
}

// 无角色(默认音色)消息: AI 从角色列表选最像说话者的角色 → 更新 flags → 立绘随角色显示
async function maybePickAvatarRole(message) {
  try {
    if (!message || !message.flags || !message.flags[MODULE]) return;
    const fl = message.flags[MODULE];
    if (fl.role) return;                       // 已带角色
    const cfg = getCfg();
    if (!cfg.aiPickAvatar || !cfg.llmEnabled || !cfg.llmKey) return;
    const names = sendPopCurrentChars().map(x => x.name).filter(Boolean);
    if (!names.length) return;
    const text = String(message.content || (message.data && message.data.content) || "").slice(0, 500);
    const r = await fetch(`${cfg.serverUrl}/llm/pick-role`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, roles: names, base: cfg.llmBaseUrl || "https://api.openai.com/v1", key: cfg.llmKey, model: cfg.llmModel || "gpt-4o-mini" }),
      signal: AbortSignal.timeout(60000),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.ok && j.role && names.includes(j.role)) {
      await message.update({ flags: { [MODULE]: { ...fl, role: j.role, aiPicked: true } } });
    }
  } catch (e) { /* noop */ }
}

Hooks.on("chatInput", (event, inputOptions) => {
  if (event && event.key === "Enter" && !event.shiftKey) cancelTypingDebounce();
});

/* 兼容旧版聊天输入框(部分系统/主题) */
window.addEventListener("load", () => { attachTyping(); });
