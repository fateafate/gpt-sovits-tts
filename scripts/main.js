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
  ["allowStressTest",{ type: Boolean, scope: "client", default: true,           name: "settings.allowStressTest.name", hint: "settings.allowStressTest.hint" }],
  ["engine",        { type: String,  scope: "client", default: "gptsovits",      choices: { gptsovits: "GPT-SoVITS", webspeech: "Web Speech" }, name: "settings.engine.name", hint: "settings.engine.hint" }],
  ["serverUrl",     { type: String,  scope: "client", default: autoServerUrl(), name: "settings.serverUrl.name", hint: "settings.serverUrl.hint" }],
  ["voiceServerUrl",{ type: String,  scope: "world",  default: "",                name: "settings.voiceServerUrl.name", hint: "settings.voiceServerUrl.hint" }],
  ["voiceRunnerMap",{ type: String,  scope: "world",  default: "",  restricted: true, name: "settings.voiceRunnerMap.name", hint: "settings.voiceRunnerMap.hint" }],
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
  ["gmMute",        { type: Boolean, scope: "world", default: false, restricted: true, name: "settings.gmMute.name", hint: "settings.gmMute.hint" }],
  ["maxConcurrentModels", { type: Number, scope: "world", default: 10, restricted: true, range: { min: 1, max: 20, step: 1 }, name: "settings.maxConcurrentModels.name", hint: "settings.maxConcurrentModels.hint" }],
  ["llmEnabled",    { type: Boolean, scope: "client", default: false,           name: "settings.llmEnabled.name",  hint: "settings.llmEnabled.hint" }],
  ["llmBaseUrl",    { type: String,  scope: "client", default: "https://api.openai.com/v1", name: "settings.llmBaseUrl.name", hint: "settings.llmBaseUrl.hint" }],
  ["llmKey",        { type: String,  scope: "client", default: "",               name: "settings.llmKey.name",      hint: "settings.llmKey.hint" }],
  ["llmModel",      { type: String,  scope: "client", default: "gpt-4o-mini",    choices: () => llmModelChoices(), name: "settings.llmModel.name",    hint: "settings.llmModel.hint" }],
  ["aiSharedBase",  { type: String, scope: "world", default: "", restricted: true, name: "settings.aiSharedBase.name", hint: "settings.aiSharedBase.hint" }],
  ["aiSharedKey",   { type: String, scope: "world", default: "", restricted: true, name: "settings.aiSharedKey.name", hint: "settings.aiSharedKey.hint" }],
  ["aiSharedModel", { type: String, scope: "world", default: "", restricted: true, name: "settings.aiSharedModel.name", hint: "settings.aiSharedModel.hint" }],
  ["aiSharedModels", { type: String, scope: "world", default: "", restricted: true, name: "settings.aiSharedModels.name", hint: "settings.aiSharedModels.hint" }],
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

/* 权限守卫: Foundry 玩家默认无权 update ChatMessage(否则服务端报 "lacks permission" 且写回不生效)。
   只有 GM 才可写回 audioData/audioUrl; 音频经广播/内嵌已到各端, 非 GM 跳过写回不丢声音。 */
function _canWrite() {
  try { return !!(game && game.user && game.user.isGM); } catch (e) { return false; }
}
function safeMsgWrite(msg, update) {
  try { if (msg && _canWrite() && update && typeof msg.update === "function") msg.update(update).catch(() => { /* noop */ }); } catch (e) { /* noop */ }
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
        queue.enqueue({ play: () => audioPlay(u, { volume: getCfg().volume, push: false }) });
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
  queue.enqueue({ play: () => audioPlay(url, { volume: getCfg().volume, push: false }) });
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
  // GM 一键分发的 AI 配置(共享优先): GM 在语音面板"一键分发给所有玩家"后, 全员(含 GM)使用共享 base/key/model
  try {
    const shBase = game.settings.get(MODULE, "aiSharedBase") || "";
    const shKey = game.settings.get(MODULE, "aiSharedKey") || "";
    const shModel = game.settings.get(MODULE, "aiSharedModel") || "";
    if (shBase) c.llmBaseUrl = shBase;
    if (shKey) c.llmKey = shKey;
    // 模型不强制覆盖: 每个玩家可各自选不同模型(支持多模型同时运行)。仅当玩家本地无模型缓存时, 用共享列表填充下拉
    const shModels = String(game.settings.get(MODULE, "aiSharedModels") || "").split(",").map(s => s.trim()).filter(Boolean);
    if (shModels.length && (!c.llmModels || !c.llmModels.length)) c.llmModels = shModels;
    if (shBase || shKey || shModel) c.llmEnabled = true;   // 一键分发即代表启用 AI(pl 无需自己开开关); 收回后回退各自本地
    c.aiShared = !!(shBase || shKey || shModel);
  } catch (e) { /* noop */ }
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
async function speak(text, { lang = null, sender = "", refAudioPath = null, promptText = null, promptLang = null, speed = null, volume = null, auxRefAudioPaths = null, emotionMix = null, broadcast = false, messageId = "", skipAiEmotion = false, role = null } = {}) {
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
  // 情绪(1.6.24): LLM 根据台词+角色提示词判情绪(优先, 声音调制+立绘分组) > 显式选择 > 规则判定; 失败降级不阻塞
  if (pv && !pv.auxRef) {
    let _emoDet = null;
    try { const _aiE = await aiJudgeEmotionNow(finalText, prof0.current || ""); if (_aiE) _emoDet = _aiE; } catch (e) { /* noop */ }
    if (!_emoDet) _emoDet = detectEmotion(finalText, pv);
    if (_emoDet && _emoDet !== "neutral") { overrides = overrides || {}; overrides.emotion = _emoDet; }
    if (window.__fvttTTSSpriteDiag) {
      try { console.warn("[gpt-sovits-tts][语气判定] 文本=" + String(finalText || "").slice(0, 24) + " | AI=" + (_aiE || "无(未配LLM)") + " | 规则=" + ((_emoDet || "") || "无") + " | 调制=" + ((_emoDet && _emoDet !== "neutral") ? "开(" + _emoDet + ")" : "关(neutral)") + " | 槽音频=" + (pv.auxRef ? "有(不调制)" : "无")); } catch (e) { /* noop */ }
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
            const r = await svcRequest(cfg.serverUrl, "POST", "/llm/style", { base: cfg.llmBaseUrl || "https://api.openai.com/v1", key: cfg.llmKey, model: cfg.llmModel || "gpt-4o-mini", text: finalText, style: stylePrompt, role: prof0.current || "", setting: (qcC && qcC.setting) || "" }, { timeoutMs: 60000 });
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
          const res = await _synthIt(finalText, finalLang, { spdIn: spd, ov: overrides, blobOnly: true, role: role || prof0.current });
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
        item = { play: () => audioPlay(url4, { volume: vol, push: false, onStart: _registerPlayed }), cleanup: () => { try { if (cleanupObj) URL.revokeObjectURL(cleanupObj); } catch (e) { /* noop */ } } };
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
                if (typeof _pvCtx.emotionMix === "number") _upd.emotionMix = _pvCtx.emotionMix;
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
        const res = await _synthIt(finalText, finalLang, { spdIn: spd, ov: overrides, blobOnly: false, role: role || prof0.current });
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
                safeMsgWrite(message, { flags: { [MODULE]: _nf } });
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
      // 代理模式(pl 在 HTTPS/跨网/9881 不可达环境): 预合成音频路径写回 flags → 全员从 Foundry 30000 拉同一段
      try {
        if (message.id && preloadAudio.audioUrl) {
          const _relP = String(preloadAudio.audioUrl).startsWith("http") ? new URL(preloadAudio.audioUrl).pathname : preloadAudio.audioUrl;
          const _updP = { "flags.gpt-sovits-tts.audioUrl": _relP };
          try { if (preloadAudio.dataUrl && preloadAudio.dataUrl.length < 400000) _updP["flags.gpt-sovits-tts.audioData"] = preloadAudio.dataUrl; } catch (e) { /* noop */ }
          safeMsgWrite(message, _updP);
        }
      } catch (e) { /* noop */ }
      if (window.__fvttTTSCanDirect === true) {
        if (message.id) { playedIds.add(message.id); setTimeout(() => { try { playedIds.delete(message.id); } catch (e) { /* noop */ } }, 30000); }   // 本地预载已播(防 flags 写回再播)
        // 官方文件路径优先 + push 广播(全员官方通道); 无落盘才 dataUrl 本端播
        const _mpu = (() => { try { return _modulePath(preloadAudio.audioUrl || ""); } catch (e) { return ""; } })();
        queue.enqueue({ play: () => audioPlay(_mpu || preloadAudio.dataUrl || preloadAudio.url, { volume: getCfg().volume, push: !!_mpu }) });
      } else {
        // 代理模式: 本机没直连引擎, 预载音频已在 flags 写回(等 pl 端 hook 从 30000 拉), 不重复发声
        try { if (message.id) pendingTts.set(message.id, { text: speakText, ts: Date.now() }); } catch (e) { /* noop */ }
      }
      // 立即广播预合成音频(全员同声; socket 不通时 pl 仍可从 flags 拿到)
      try {
        if (message.id && preloadAudio.audioUrl) {
          const _relP = String(preloadAudio.audioUrl).startsWith("http") ? new URL(preloadAudio.audioUrl).pathname : preloadAudio.audioUrl;
          const _updP = { "flags.gpt-sovits-tts.audioUrl": _relP };
          try { if (preloadAudio.dataUrl && preloadAudio.dataUrl.length < 400000) _updP["flags.gpt-sovits-tts.audioData"] = preloadAudio.dataUrl; } catch (e) { /* noop */ }
          safeMsgWrite(message, _updP);
        }
      } catch (e) { /* noop */ }
      // 🔊 单通道: 预载本地播放 audioPlay 已自动触发官方 playAudio 事件广播(见 audioPlay);
      // 不再自定义 socket 广播(播放统一走 Foundry 内置语音通道)。
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
    try { await speak(speakText, { ...opts, broadcast: true, messageId: message.id || "" }); }
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
      speak(speakText, { ...opts, broadcast: false, role: (fl && fl.role) || null });
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
    if (statusInfo.data && statusInfo.data.mode === "proxy") return _L("status.proxy", "TTS · GM 代理合成");
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
        lang: getCfg().textLang || "auto",
        // 代理模式(本机连不到 9881): 附上合成请求 → GM 端 createChatMessage hook 代为合成并写回 flags.audioUrl → 全员播放
        ...(window.__fvttTTSCanDirect === false ? { synthRequest: { text: v, lang: getCfg().textLang || "auto", role: prof1.current || "", emotion: (cur1 && cur1.emotion) || "", speed: (cur1 && cur1.speed) || 0, provider: String((cur1 && cur1.ttsProvider) || "gpt-sovits") } } : {})
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
<label class="fvtt-tts-sendpop-tuneline"><span title="${_L("ui.styleTip", "朗读提示词：如“更严肃认真、中间不要中断”。会翻译成语速/停顿等合成参数，角色独立记得。")}">${_L("ui.stylePrompt", "朗读提示词")}</span><input type="text" class="fvtt-tts-sendpop-style" placeholder="${_L("ui.stylePh", "如：更严肃认真，中间不要中断")}" maxlength="120"></label>
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
          // LLM 预热失败(API 未配/不通/502) → 不阻塞预合成: LLM 只是语气判断辅助,
          // 降级按默认/手动语气预合成(合成走 GM 代理→引擎, 与 LLM 无关; 根治"非本地玩家预加载失败 http0")
          if (window.__fvttTTSAiWarned !== true) {
            try { console.warn("[gpt-sovits-tts] AI 预热失败(降级, 按当前语气预合成): " + ((r && r.message) || "unknown")); } catch (e) { /* noop */ }
            window.__fvttTTSAiWarned = true;   // 1.6.23: 只提示一次, 不再每次打字刷控制台
          }
          window.__aiPreloaded = false;
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
      const { blob, audioUrl } = await gptSovitsSynth(stripP, cfgP2.textLang || "auto", { serverUrl: cfgP2.serverUrl, speedFactor: cfgP2.speedFactor || 1, overrides: Object.keys(overridesP).length ? overridesP : null, mediaType: "mp3", asBlob: true, role: roleP, skipDirect: window.__fvttTTSCanDirect !== true });
      const objUrl = URL.createObjectURL(blob);
      const b64 = await blobToBase64(blob);
      if (preloadAudio && preloadAudio.url) { try { URL.revokeObjectURL(preloadAudio.url); } catch (e) { /* noop */ } }
      preloadAudio = { text: stripP, lang: cfgP2.textLang || "auto", url: objUrl, audioUrl: audioUrl || "", dataUrl: `data:audio/mpeg;base64,${b64}`, mime: "audio/mpeg", ts: Date.now(), watchKey: makeWatchKey() };
      btnP2.textContent = _L("ui.preloadedBtn", "✓ 已预加载");
      btnP2.title = _L("ui.preloadedSendTip", "音频已就绪，再点直接播出");
      btnP2.classList.remove("loading");
      btnP2.classList.add("done");
      // 合成完成只标记 done, 等待用户点击发送(不再自动发送; 再点即直接播出同一段零等待音频)
    } catch (e) {
      btnP2.textContent = oldP2;
      btnP2.classList.remove("loading");
      ui.notifications.warn(_L("ui.preloadFail", "预加载失败") + ": " + ((e && e.message) || "unknown"));
    }
  });
  // 恢复预加载状态: 已预合成的音频(文字一致且角色/语气/语言未变)按钮直接显示 done, 再点即发送; 文字/签名变了 → 回到未预加载
  const preBtn = pop.querySelector(".fvtt-tts-sendpop-preload");
  const _ta0 = findChatTextarea();
  const _t0 = (_ta0 && String(_ta0.value || "").trim()) ? stripStageDirections(String(_ta0.value || "").trim()) : "";
  if (preBtn && preloadAudio && preloadAudio.url && preloadAudio.text === _t0 && preloadAudio.watchKey === makeWatchKey()) {
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
      }, { timeoutMs: 70000 });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) {
      // LLM 服务不可用(502/404/网络) → 本会话禁用后续 LLM 调用(根治每句 502 刷屏); 修好 base/key 后刷新页面恢复
      if (r.status >= 400) { try { window.__fvttTTSLlmBroken = true; } catch (e) { /* noop */ } }
      return { ok: false, emotion: "", reason: (j && j.message) || ("http " + r.status) };
    }
    return { ok: true, emotion: (j && j.emotion) || "" };
  } catch (e) {
    try { window.__fvttTTSLlmBroken = true; } catch (e2) { /* noop */ }
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
  const r = await svcRequest(cfg.serverUrl, "POST", "/llm/models", { base, key }, { timeoutMs: 40000 });
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
    if (!r.ok || !j.ok) { if (r.status >= 400) { try { window.__fvttTTSLlmBroken = true; } catch (e) { /* noop */ } } return { ok: false, message: (j && j.message) || ("http " + r.status) }; }
    window.__aiPreloaded = true;   // 共享预热状态(语音设置面板/发送面板都不再重复预热)
    return { ok: true, ms: Math.round(performance.now() - t0), emotion: (j.emotion) || "" };
  } catch (e) {
    return { ok: false, message: (e && e.message) || "err" };
  }
};

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
      }, { timeoutMs: 70000 });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok || !j.text) {
      if (r.status >= 400) { try { window.__fvttTTSLlmBroken = true; } catch (e) { /* noop */ } }
      return { ok: false, text: "" };
    }
    const out = String(j.text).trim();
    return out ? { ok: true, text: out } : { ok: false, text: "" };
  } catch (e) {
    try { window.__fvttTTSLlmBroken = true; } catch (e2) { /* noop */ }
    return { ok: false, text: "" };
  }
}

/** 判断+润色合并(可选开关 llmMergePolish): 一次 LLM 调用返回 {emotion, polish}.
 *  关闭时退回分开两次调用(judgeEmotionByLLM + polishTextByLLM). */
async function judgeAndPolishByLLM(text, charName, wantPolish, context) {
  const cfg = getCfg();
  if (window.__fvttTTSLlmBroken === true) return { ok: false, emotion: "", reason: "llm-broken" };
  try {
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
        const r = await svcRequest(cfg.serverUrl, "POST", "/llm/assess", {
            base: cfg.llmBaseUrl || "https://api.openai.com/v1",
            key: cfg.llmKey,
            model: cfg.llmModel || "gpt-4o-mini",
            text: String(text || ""),
            context: context || "",
            emotions: emotionsList,
            role: charName || "",
            setting: (c && c.setting) || "",
            polish: !!wantPolish,
          }, { timeoutMs: 70000 });
        const j = await r.json().catch(() => ({}));
        if (r.ok && j.ok && j.emotion) {
          return { ok: true, emotion: String(j.emotion), polish: String(j.polish || "").trim() };
        }
        // 合并调用失败: LLM 服务不可用(>=400) → 本会话禁用(根治每句 502 刷屏), 不再回退分开调用
        if (r.status >= 400) { try { window.__fvttTTSLlmBroken = true; } catch (e) { /* noop */ } return { ok: false, emotion: "", reason: (j && j.message) || ("http " + r.status) }; }
        // 结果为空/业务失败 → 回退分开调用(保证情绪判断不丢失)
        console.debug("[gpt-sovits-tts] 合并语气判断失败, 回退分开调用:", (j && j.message) || ("http " + r.status));
      } catch (e) {
        try { window.__fvttTTSLlmBroken = true; } catch (e2) { /* noop */ }
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
  // 1.6.31: 聊天输入文本变化 → 预加载按钮 done 态即时清除(文字与已预合成音频不一致时不再一直显示"已预加载")
  if (ta && ta.dataset.fvttPreloadWatch !== "1") {
    ta.dataset.fvttPreloadWatch = "1";
    ta.addEventListener("input", () => {
      try {
        const pop2 = buildSendPop();
        const pb = pop2.querySelector(".fvtt-tts-sendpop-preload");
        if (!pb) return;
        const tnow2 = String(ta.value || "").trim() ? stripStageDirections(String(ta.value || "").trim()) : "";
        if (pb.classList.contains("done") && (!preloadAudio || preloadAudio.text !== tnow2)) {
          pb.classList.remove("done");
          pb.textContent = _L("ui.sendPopPreload", "AI 预加载");
          pb.title = "";
        }
      } catch (e) { /* noop */ }
    });
  }
}

function closeSendPop() {
  if (sendPopEl && document.body.contains(sendPopEl)) { sendPopEl.style.display = "none"; }
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
      const r = await svcRequest(getCfg().serverUrl, "GET", "/characters");
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
      queue.enqueue({ play: () => audioPlay(cached.url, { volume: getCfg().volume, push: false }) });
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
        try { await audioPlay(URL.createObjectURL(lres.blob), { volume: getCfg().volume, push: false }); } catch (e) { localErr = String((e && e.message) || e).slice(0, 60); }
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
      try { await audioPlay(playSrc, { volume: getCfg().volume, push: false }); } catch (e) { playErr = String((e && e.message) || e).slice(0, 80); }
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
    isDictating: () => !!(dictation && dictation.active),
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
  // Foundry v13 socket: 模块 socket 中继(module.<id>) — 各端匹配响应 + GM 端执行代理(合成/代写/报告落盘)
  try { installModuleSocket(); } catch (e) { /* noop */ }
  try { installGmProxy(); } catch (e) { /* noop */ }
  // 🔬 1.5.0 场景化全面测试套件(取代旧测试按钮): 玩家套件(28场景玩家视角) + GM 综合套件(28场景全员视角)
  try {
    installTTSTests({
      getCfg, speak, blobToBase64, stripStageDirections, findEmotionSlot,
      loadVoiceProfile, currentVoice, cacheAudio, _modulePath, loadQuickChars,
    });
  } catch (e) { console.error("[gpt-sovits-tts] tests install failed:", e); }
  // 🤖 LLM 健康预探测: 配置了 AI 就发一次小请求, 失败(502/404/网络)→本会话禁用全部 LLM 调用
  // (根治每句 /llm 502 刷屏: GM 端 F12 看到的多条 502 来自"玩家发起→GM 转发→引擎 502" + 并发窗口;
  //  各端 8s 内先探一次并设标记, 之后 judgeAndPolishByLLM/预加载/选角全部跳过; 修好 base/key 后刷新恢复)
  setTimeout(() => {
    try {
      const c0 = getCfg();
      if (!c0.llmEnabled || !c0.llmKey) return;
      if (window.__fvttTTSLlmBroken === true) return;
      svcRequest(c0.serverUrl, "POST", "/llm", {
        base: c0.llmBaseUrl || "https://api.openai.com/v1", key: c0.llmKey, model: c0.llmModel || "gpt-4o-mini",
        text: "ping", emotions: [{ key: "calm", label: "平静" }],
      }, { timeoutMs: 5000 })
        .then((r) => { if (r && !r.ok) { try { window.__fvttTTSLlmBroken = true; } catch (e) { /* noop */ } } })
        .catch(() => { try { window.__fvttTTSLlmBroken = true; } catch (e) { /* noop */ } });
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
        try {
          if (game.user && game.user.isGM && getCfg().maxConcurrentModels) {
            svcRequest(getCfg().serverUrl, "POST", "/config", { max_concurrent_models: Number(getCfg().maxConcurrentModels) || 10 }).catch(() => { /* noop */ });
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
      const lines = et.split(/\n+/).map(l => l.trim()).filter(l => /立绘\s*\d+/.test(l));
      const hits = [];
      const etw = emoTagWords(emo);
      lines.forEach(ln => {
        const m = ln.match(/立绘\s*(\d+)/);
        if (!m) return;
        const idx = (parseInt(m[1], 10) || 1) - 1;
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

// 情绪 → emotion_tags 中文关键词(1.6.27, 对标 Shinsekai 标注文本)
function emoTagWords(emo) {
  const em = String(emo || "").toLowerCase();
  if (em === "joy" || em === "happy") return ["开心", "高兴", "大笑", "眯眼笑", "笑", "有兴趣", "兴奋", "元气"];
  if (em === "sad") return ["难过", "伤心", "哭", "泪", "悲", "沮丧", "没干劲", "失落"];
  if (em === "angry") return ["生气", "怒", "训斥", "厌恶", "恶心", "敌意", "防守", "生闷气", "骂"];
  if (em === "surprised") return ["震惊", "惊讶", "惊", "愣"];
  if (em === "fear") return ["害怕", "恐惧", "怕", "惊吓", "颤抖"];
  if (em === "calm") return ["平静", "温柔", "娴静", "说话", "闭眼", "吐槽", "看着你", "想事情", "反问", "调侃"];
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
    return "neutral";
  } catch (e) { return "neutral"; }
}

// AI 语气判定(1.6.24): LLM 根据台词+角色提示词判情绪(驱动声音调制+立绘分组); 未配/失败/超时降级规则; 同批说话复用一次调用
let _aiEmoPro = null;
function aiJudgeEmotionNow(text, role) {
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
      }, { timeoutMs: 6000 });
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
            const _emoS = String(detectEmotion(String(message.content || chatData.content || ""), cur || null) || "neutral");
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
        emotionMix: (cur && typeof cur.emotionMix === "number") ? cur.emotionMix : 0.5,
        emotionMod: (cur && typeof cur.emotionMod === "number") ? cur.emotionMod : 0.5,
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
          queue.enqueue({ play: () => audioPlay(flD.audioData, { volume: getCfg().volume, push: false }) });
        }
      }
    }
  } catch (e) { /* noop */ }
  // 🎭 立绘测试消息/诊断开启: createChatMessage 阶段补算立绘判定(1.6.40)
  //    chatMessage hook 对 ChatMessage.create 不触发(测试按钮消息没走发送框, fl.avatar 没写, 报告也空),
  //    这里补算并写回 flags, 渲染层才有 fl.avatar、报告才有判定行
  try {
    const flV = message && message.flags && message.flags[MODULE];
    if (flV && (flV.spriteTest || window.__fvttTTSSpriteDiag)) {
      const profV = loadVoiceProfile();
      const curV = currentVoice();
      const profVn = (profV && profV.current) || "";
      const _selSpV = (profV && profV.chars && profV.chars[profVn] && profV.chars[profVn].selSprite) || "";
      const cDV = (quickChars && quickChars.chars || []).find(x => x.name === profVn);
      const _emoSV = String(detectEmotion(String(message.content || ""), curV || null) || "neutral");
      const _emoListV = _selSpV ? [_selSpV] : spriteBucketForEmotion((cDV && cDV.sprites) || [], _emoSV, (cDV && cDV.emotion_tags) || "");
      const _rotV = getSpriteRotation(profVn + "|" + _emoSV, _emoSV);
      const _avV = (_emoListV && _emoListV.length) ? _emoListV[_rotV % _emoListV.length] : "";
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
  maybeSpeak(message); maybePickAvatarRole(message); });

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
Hooks.on("updateSetting", (key, value, options, userId) => {
  (window.__fvttTTSHooks = window.__fvttTTSHooks || {}).updateSetting = true;
  // GM 改"同时运行上限" → 立即同步服务端模型池(裁剪/扩容), 仅 GM 生效(pl 只读)
  if (key === `${MODULE}.maxConcurrentModels`) {
    try {
      if (game.user && game.user.isGM) {
        svcRequest(getCfg().serverUrl, "POST", "/config", { max_concurrent_models: Number(value) || 10 }).catch(() => { /* noop */ });
      }
    } catch (e) { /* noop */ }
  }
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
    (async () => {
      try {
        const _e = await aiJudgeEmotionNow(String(message.content), _roleN);
        if (!_e) return;
        // 1.6.29 手动选立绘(立绘库)优先, AI 不覆盖
        const profAi = loadVoiceProfile();
        if (profAi && profAi.chars && profAi.chars[_roleN] && profAi.chars[_roleN].selSprite) return;
        const cD = (quickChars && quickChars.chars || []).find(x => x.name === _roleN);
        if (!cD || !Array.isArray(cD.sprites) || !cD.sprites.length) return;
        const _emoList = spriteBucketForEmotion(cD.sprites, _e, cD.emotion_tags);
        const _rot = getSpriteRotation(_roleN + "|" + _e + "|ai", _e);
        const _av = cD.sprites[_emoList[_rot % _emoList.length]];
        await message.update({ flags: { [MODULE]: { ..._fl, emotion: _e, avatar: _av } } }).catch(() => {});
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
        try { queue.enqueue({ play: () => audioPlay(reluc, { volume: getCfg().volume, push: false }) }); return; } catch (e) { /* noop */ }
      }
      if (flags.audioData && typeof flags.audioData === "string" && flags.audioData.length > 20) {
        try { if (message.id) cacheAudio(message.id, flags.audioData, "audio/mpeg"); } catch (e) { /* noop */ }
        try { queue.enqueue({ play: () => audioPlay(flags.audioData, { volume: getCfg().volume, push: false }) }); } catch (e) { /* noop */ }
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
          queue.enqueue({ play: () => audioPlay(u, { volume: getCfg().volume, push: false }) });
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

// 情绪→立绘 / 角色立绘: 消息带角色时, 在内容前显示该角色的立绘(语气槽立绘优先); 无角色不显示
function applyEmotionAvatar(message, html) {
  try {
    const cfgM = getCfg();
    // 立绘展示方式: 仅指示物/都不显示 → 消息内不插图
    if (cfgM.portraitMode !== "message" && cfgM.portraitMode !== "both") return;
    const fl = message && message.flags ? (message.flags[MODULE] || null) : null;
    const el = html && (typeof html.querySelector === "function") ? html : null;
    if (!el) return;
    // 立绘跟随朗读(1.6.6): 只有"实际合成/播放了语音"的消息才插立绘 — 纯文本/旁白/动作消息不插。
    // 判定: 消息 flags 已带音频(写回完成) 或 本端已播过该消息(playedIds / 已播 src)。
    // 新消息合成前渲染 → 无音频不插; 写回后 updateChatMessage 播放路径补插。
    const hasAudio = !!(fl && (fl.audioData || fl.audioUrl || fl.selSprite || fl.spriteTest));   // 1.6.34 手动选立绘/立绘测试消息即使未朗读也插立绘
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
    if (!hasAudio && !playedHere) return;
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
    let av = (fl && (fl.selSprite || fl.slotAvatar || fl.avatar)) || (slot && slot.avatar) || (c && c.avatar) || "";   // 1.6.34 手动选立绘 > 消息自带(跨端) > 语气槽立绘
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
    img.src = toAvatarUrl(av);
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
          const _avAbs = toAvatarUrl(av);
          if (himg.getAttribute("src") !== _avAbs) himg.setAttribute("src", _avAbs);
        } catch (e) { /* noop */ }
      }
    } catch (e) { /* noop */ }
  } catch (e) { /* noop */ }
}

// 无角色(默认音色)消息: AI 从角色列表选最像说话者的角色 → 更新 flags → 立绘随角色显示
async function maybePickAvatarRole(message) {
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
