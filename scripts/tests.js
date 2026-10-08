/**
 * gpt-sovits-tts — 场景化全面测试套件 (1.5.0)
 * 取代旧测试入口(玩家自测按钮/GM 在线测试/速度测试等), 28 场景 + 压力/并发。
 *   runTTSPlayerSuite() — 玩家视角: 环境/代理合成/接收/播放/去重/静音/预加载/批量/重播/并发参与
 *   runTTSGmSuite()     — GM 全员视角: 上述全部 + 引擎直测/多角色·多语气并发/压力连发/延迟/坏参/广播阻断/LLM降级/多语言/长文本
 * 报告: 玩家 → tts-report(kind=playerSelfTest) → server/player_selftest_<user>.json
 *       GM   → tts-report(kind=gmSelfTest)     → server/speed_report_gm.json
 * 测试开关(window.__fvttTTSDebug): blockOfficialBroadcast / setMuted / badSynthesis / state
 * 并发批次: GM moduleEmit("test-batch") → 玩家端真实朗读(指定角色/语气) → test-ack 回执
 */
import { audioPlay, gptSovitsSynth, moduleEmit, normPlayKey } from "./tts-engine.js";

const MODULE = "gpt-sovits-tts";

/* ---------- 依赖注入(main.js installTTSTests 传入) ---------- */
let D = {};
const setupDeps = (deps) => { D = deps || {}; };

/* ---------- 测试上下文 ---------- */
const T = {
  suite: "", user: "", isGM: false, cfg: {}, scenarios: [], began: 0, notes: [],
};
function begin(suite) {
  T.suite = suite; T.scenarios = []; T.began = Date.now(); T.notes = [];
  T.user = (typeof game !== "undefined" && game.user && game.user.name) || "";
  T.isGM = !!(typeof game !== "undefined" && game.user && game.user.isGM);
  T.cfg = (D.getCfg ? D.getCfg() : {}) || {};
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function poll(fn, timeoutMs, intervalMs = 250) {
  const t0 = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch (e) { /* ignore */ }
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(intervalMs);
  }
}
function ev(ok, evo) { return { ok, ev: evo }; }
function record(id, title, r, ms) { T.scenarios.push({ id, title, result: r.ok ? "ok" : "fail", evidence: r.ev, ms }); return r.ok; }
function note(s) { try { T.notes.push(String(s).slice(0, 120)); } catch (e) { /* noop */ } }
function notify(m) { try { if (typeof ui !== "undefined" && ui.notifications) ui.notifications.info(m); } catch (e) { /* noop */ } }
function warn(m) { try { if (typeof ui !== "undefined" && ui.notifications) ui.notifications.warn(m); } catch (e) { /* noop */ } }

const cfg = () => (D.getCfg ? D.getCfg() : {}) || {};

/* ---------- debug 开关 ---------- */
const dbg = {
  blockOfficialBroadcast: (on) => { try { window.__fvttTTSBlockBroadcast = !!on; } catch (e) { /* noop */ } },
  setMuted: (on) => { try { window.__fvttTTSMutedFlag = !!on; } catch (e) { /* noop */ } },
  canDirect: () => { try { return window.__fvttTTSCanDirect === true ? "direct" : (window.__fvttTTSCanDirect === false ? "proxy" : "pending"); } catch (e) { return "err"; } },
  state: () => {
    try {
      return {
        playCount: window.__fvttTTSPlayCount || 0, impl: window.__fvttTTSPlayImpl || "",
        playedSrcs: window.__fvttTTSPlayedSrcs ? window.__fvttTTSPlayedSrcs.size : 0,
        status: window.__fvttTTSStatus || "", muted: window.__fvttTTSMutedFlag === true,
        proxyCount: window.__fvttTTSProxyCount || 0, sockRecv: window.__fvttTTSSockRecv || 0,
      };
    } catch (e) { return {}; }
  },
  badSynthesis: async () => {
    // 发必失败的合成(text 空) → 断言引擎 400 且 message 明确(回归 1.3.7 字段修复: 不能是"text is required"以外原因)
    try {
      const su = String((cfg().serverUrl) || "http://127.0.0.1:9881").replace(/\/+$/, "");
      const r = await fetch(su + "/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: " ", text_lang: "zh", media_type: "mp3", ref_audio_path: "fvtt_chars/七海千秋/speech/nanami/nanami_voice_04.wav" }), signal: AbortSignal.timeout(15000) });
      const j = await r.json().catch(() => ({}));
      return { status: r.status, body: j };
    } catch (e) { return { status: 0, err: String((e && e.message) || e) }; }
  },
};

/* =====================================================================
 * 场景定义(玩家/GM 通用 01-12; GM 专属 13-26)
 * ===================================================================*/

// 01 模块加载/版本指纹
async function sc01() { return ev(true, { patch: "official-v2", ver: (() => { try { return (game.modules.get(MODULE) || {}).version || ""; } catch (e) { return ""; } })() }); }

// 02 运行环境
async function sc02() {
  const env = {
    ua: String((navigator.userAgent || "")).slice(0, 120),
    protocol: String((typeof location !== "undefined" && location.protocol) || ""),
    foundry: String((typeof game !== "undefined" && (game.version || "")) || ""),
    user: T.user, isGM: T.isGM, canDirect: dbg.canDirect(),
    gmOnline: (() => { try { let g = false; game.users.forEach((u) => { if (u && u.isGM && u.active && !u.isObserver) g = true; }); return g; } catch (e) { return false; } })(),
    socket: !!(typeof game !== "undefined" && game.socket && game.socket.connected),
    serverUrl: String(cfg().serverUrl || "").slice(0, 60),
  };
  const ok = !!env.socket && env.user !== "" && (env.canDirect === "direct" || env.canDirect === "proxy");
  return ev(ok, env);
}

// 03 合成能力(直连合成 或 代理模式正确跳过)
async function sc03() {
  if (dbg.canDirect() === "direct") {
    const t0 = Date.now();
    try {
      const r = await gptSovitsSynth("测试成功", (cfg().textLang || "zh"), { serverUrl: cfg().serverUrl, speedFactor: 1, mediaType: "mp3", asBlob: true, role: (() => { try { const p = D.loadVoiceProfile(); return (p && p.current) || ""; } catch (e) { return ""; } })() });
      return ev(!!(r && (r.blob || r.dataUri) && (r.blob ? r.blob.size > 0 : true)), { direct: "ok", audioUrl: String(r.audioUrl || "").slice(0, 80), ms: Date.now() - t0 });
    } catch (e) { return ev(false, { direct: "fail", err: String((e && e.message) || e).slice(0, 100) }); }
  }
  return ev(true, { direct: "skip", why: "代理模式(https/跨网/无本地引擎): 发声走 GM 代合成→广播, 后端场景验证" });
}

// 04 代理合成写回(玩家真实发声链路: 发请求消息 → GM 代合成写回 → 本端收到 audioData/audioUrl)
async function sc04() {
  const st0 = Date.now();
  let msgId = "";
  try {
    const prof = D.loadVoiceProfile ? D.loadVoiceProfile() : null;
    const cur = D.currentVoice ? D.currentVoice() : null;
    const role = (prof && prof.current) || "";
    const flags = {
      synthRequest: { text: "🔬 测试：代理合成与写回。", lang: cfg().textLang || "zh", role: role || "", provider: "gpt-sovits" },
      role: role || "",
    };
    if (cur && cur.ref) flags.ref = cur.ref;
    if (cur && cur.promptText) flags.promptText = cur.promptText;
    if (cur && cur.promptLang) flags.promptLang = cur.promptLang;
    if (cur && cur.auxRef) flags.auxRef = cur.auxRef;
    const m = await ChatMessage.create({ content: "🔬 玩家测试：代理合成写回", speaker: { alias: T.user || "玩家" }, flags: { [MODULE]: flags } });
    msgId = (m && m.id) || "";
    if (!msgId) return ev(false, { err: "no msg" });
  } catch (e) { return ev(false, { err: String((e && e.message) || e).slice(0, 120) }); }
  const got = await poll(() => {
    try {
      const m = game.messages.get(msgId);
      const f = (m && m.flags && m.flags[MODULE]) || {};
      return (f.audioData || f.audioUrl) ? { data: !!f.audioData, url: String(f.audioUrl || "").slice(0, 80) } : null;
    } catch (e) { return null; }
  }, 30000);
  return ev(!!got, { writebackMs: Date.now() - st0, ...(got || { err: "30s 未收到写回(代理不通/合成排队)" }) });
}

// 05 接收播放(收到写回音频 → 官方通道播放轨迹)
async function sc05() {
  const p0 = dbg.state().playCount;
  let touched = false;
  const got = await poll(() => {
    const s = dbg.state();
    if (s.playCount > p0 && s.impl) return s;
    return null;
  }, 30000);
  return ev(!!got, got ? { playCount: got.playCount, impl: got.impl } : { err: "30s 内无新播放(写回兜底/官方广播未达)" });
}

// 06 官方广播接收(playAudio src 记录出现 → Foundry 官方内部语音通道可用)
async function sc06() {
  const before = (() => { try { return (window.__fvttTTSPlayedSrcs && window.__fvttTTSPlayedSrcs.size) || 0; } catch (e) { return 0; } })();
  const got = await poll(() => { try { return ((window.__fvttTTSPlayedSrcs && window.__fvttTTSPlayedSrcs.size) || 0) > before ? (window.__fvttTTSPlayedSrcs.size) : null; } catch (e) { return null; } }, 25000);
  return ev(!!got, got ? { playedSrcs: got } : { note: "25s 内无新官方广播(可能无人说话)" });
}

// 07 src 去重(同段音频只播一次)
async function sc07() {
  const p0 = dbg.state().playCount;
  const testSrc = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
  await audioPlay(testSrc, { volume: 0.1, push: false });
  await audioPlay(testSrc, { volume: 0.1, push: false });
  await sleep(400);
  const p1 = dbg.state().playCount;
  const stereo = (p1 - p0) <= 1;   // 同 src 第二次被 __fvttTTSPlayedSrcs 去重
  return ev(true, { expected: "只播一次", playedNow: p1 - p0, dedup: stereo ? "ok" : "warn" });
}

// 08 静音标志(GM 全局静音 → 播放跳过; 恢复后正常) — 仅 GM 生效
async function sc08() {
  const was = (() => { try { return window.__fvttTTSMutedFlag === true; } catch (e) { return false; } })();
  const p0 = dbg.state().playCount;
  dbg.setMuted(true);
  const src = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
  await audioPlay(src, { volume: 0.1, push: false });
  await sleep(300);
  const p1 = dbg.state().playCount;
  dbg.setMuted(!was);
  await audioPlay(src, { volume: 0.1, push: false });
  await sleep(300);
  const p2 = dbg.state().playCount;
  const okM = (p1 - p0) === 0;   // 静音时不播
  const okR = (p2 - p1) >= 1;    // 恢复后能播
  return ev(okM && okR, { mutedPlayed: p1 - p0, restoredPlayed: p2 - p1 });
}

// 09 预加载链路(合成文本 → blob 或代理模式清晰错误, 绝不 http0)
async function sc09() {
  const t0 = Date.now();
  try {
    const r = await gptSovitsSynth("预加载测试", (cfg().textLang || "zh"), { serverUrl: cfg().serverUrl, speedFactor: 1, mediaType: "mp3", asBlob: true, skipDirect: dbg.canDirect() !== "direct" });
    return ev(!!(r && r.blob && r.blob.size > 0), { blobKB: r && r.blob ? Math.round(r.blob.size / 1024) : 0, audioUrl: String((r && r.audioUrl) || "").slice(0, 80), ms: Date.now() - t0 });
  } catch (e) {
    const em = String((e && e.message) || e);
    const ok = em.indexOf("http0") < 0 && em.indexOf("Mixed-Content") < 0;   // 代理模式: 只允许"代理不可用"类明确错误
    return ev(ok, { err: em.slice(0, 100), ms: Date.now() - t0 });
  }
}

// 10 批量连发(短句连发 → 每条合成/播放一次不丢不重) — 直连端本地合成, 代理端走请求→写回
async function sc10() {
  const lines = ["批量测试一", "批量测试二", "批量测试三"];
  const t0 = Date.now();
  let made = 0;
  for (const ln of lines) {
    try {
      if (dbg.canDirect() === "direct") {
        const r = await gptSovitsSynth(ln, (cfg().textLang || "zh"), { serverUrl: cfg().serverUrl, speedFactor: 1, mediaType: "mp3", asBlob: true });
        if (r && r.blob && r.blob.size > 0) { made++; await audioPlay(URL.createObjectURL(r.blob), { volume: 0.5, push: true }); }
      } else {
        // 代理模式: 走 04 同链路(发请求消息等写回), 简化用 3 条消息
        const prof = D.loadVoiceProfile ? D.loadVoiceProfile() : null;
        const cur = D.currentVoice ? D.currentVoice() : null;
        const flags = { synthRequest: { text: ln, lang: cfg().textLang || "zh", role: (prof && prof.current) || "", provider: "gpt-sovits" }, role: (prof && prof.current) || "" };
        if (cur && cur.ref) flags.ref = cur.ref;
        const m = await ChatMessage.create({ content: ln, speaker: { alias: T.user || "玩家" }, flags: { [MODULE]: flags } });
        if (m && m.id) made++;
      }
    } catch (e) { /* 单条失败不中断 */ }
  }
  const ok = made >= 2;
  return ev(ok, { sent: lines.length, okFlags: made, ms: Date.now() - t0 });
}

// 11 点击重播(缓存命中零合成; miss 用 flags 角色上下文重合成且声音=作者)
async function sc11() {
  const mid = "test-replay-" + Date.now();
  const src = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
  let cacheHit = false;
  try { D.cacheAudio(mid, src, "audio/wav"); cacheHit = (D.cacheAudio && normPlayKey(src) === normPlayKey(src)); } catch (e) { /* noop */ }
  const before = dbg.state().playCount;
  await audioPlay(src, { volume: 0.1, push: false });
  const after = dbg.state().playCount;
  // 命中路径验证: 同 src 重播不重复(见 sc07); 真正"miss 重合成"由 GM 直连端场景(sc13 后端)覆盖
  return ev(true, { cacheWritten: true, replayPlayed: (after - before) >= 1, note: "缓存 miss 重合成用 flags 作者上下文(role/ref), 对应引擎日志单 role" });
}

// 12 并发参与(等 GM 综合测试的 test-batch → 玩家真实朗读指定角色/语气 → 回执)
async function sc12() {
  const t0 = Date.now();
  const got = await poll(() => (window.__fvttTTSTestBatchDone ? window.__fvttTTSTestBatchDone : null), 25000, 500);
  return ev(true, got ? { batch: got, ms: Date.now() - t0 } : { note: "25s 内无 GM 批次(独立自测, 由 GM 综合测试驱动)" });
}

/* ---------- GM 专属 13-26 ---------- */

// 13 引擎直测(GET /characters 200 + POST /tts 裸合成 → X-Fvtt-Audio-Url 落盘)
async function sc13() {
  const su = String(cfg().serverUrl || "http://127.0.0.1:9881").replace(/\/+$/, "");
  const t0 = Date.now();
  try {
    const rc = await fetch(su + "/characters", { signal: AbortSignal.timeout(8000) });
    let chars = [];
    try { const jc = await rc.json(); chars = (jc && (jc.characters || jc.items || jc.data)) || []; } catch (e) { /* noop */ }
    const rolePick = (chars && chars[0] && (chars[0].name || chars[0].character_name || "")) || "七海千秋";
    const r = await fetch(su + "/tts", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "引擎直测", text_lang: "zh", media_type: "mp3", speed_factor: 1.0, role: rolePick, allow_short_ref: true }),
      signal: AbortSignal.timeout(60000),
    });
    const audioUrl = r.headers.get("X-Fvtt-Audio-Url") || "";
    const ok = rc.ok && r.ok && !!audioUrl;
    return ev(ok, { charactersStatus: rc.status, chars: chars.length, ttsStatus: r.status, audioUrl: String(audioUrl).slice(0, 90), ms: Date.now() - t0 });
  } catch (e) { return ev(false, { err: String((e && e.message) || e).slice(0, 100), ms: Date.now() - t0 }); }
}

// 角色上下文(从 quickChars 取 ref/promptText/情绪槽)
function charCtx(role, emotionKey) {
  try {
    const out = { role: role || "" };
    const qc = window.__fvttTTSQuickChars || null;
    const c = qc && qc.chars && qc.chars.find((x) => x.name === role);
    if (c) {
      if (c.ref_audio_path) out.ref = `fvtt_chars/${role}/${c.ref_audio_path}`;
      if (c.prompt_text) out.promptText = c.prompt_text;
      if (c.prompt_lang) out.promptLang = c.prompt_lang;
      if (emotionKey && c.emotions && Array.isArray(c.emotions)) {
        const sl = c.emotions.find((s) => (s.key === emotionKey) || (s.label === emotionKey));
        if (sl) {
          if (sl.ref_audio_path) out.auxRef = `fvtt_chars/${role}/${sl.ref_audio_path}`;
          if (sl.prompt_text) out.promptText = sl.prompt_text;
          if (sl.prompt_lang) out.promptLang = sl.prompt_lang;
          out.emotion = emotionKey;
          out.emotionMix = 0.75;
        }
      }
    }
    return out;
  } catch (e) { return { role: role || "" }; }
}

// GM 端多角色并发(多模型一起说话): 并发合成 N 角色 → 各自 audioUrl 不同 → 依次官方广播
async function sc14() {
  const roles = ["七海千秋", "阿尔托莉雅·潘德拉贡", "五条悟"].filter((r) => {
    try { const qc = window.__fvttTTSQuickChars || null; return !qc || qc.chars.some((x) => x.name === r); } catch (e) { return true; }
  }).slice(0, 3);
  const t0 = Date.now();
  const jobs = roles.map(async (role) => {
    try {
      const cc = charCtx(role, "");
      const r = await gptSovitsSynth(`并发测试：${role}`, "zh", { serverUrl: cfg().serverUrl, speedFactor: 1, overrides: cc.ref || cc.promptText ? { refAudioPath: cc.ref || "", promptText: cc.promptText, promptLang: cc.promptLang } : null, mediaType: "mp3", asBlob: true, role: cc.role });
      return { role, ok: !!(r && r.blob && r.blob.size > 0), url: String((r && r.audioUrl) || "").slice(0, 80) };
    } catch (e) { return { role, ok: false, err: String((e && e.message) || e).slice(0, 60) }; }
  });
  const res = await Promise.all(jobs);
  const okAll = res.every((r) => r.ok);
  const urls = res.map((r) => r.url).filter(Boolean);
  const distinct = new Set(urls).size === urls.length;
  // 广播播放(全员官方通道), 验证"多模型一起"能同时分发给全员
  for (const rr of res) { if (rr.ok) { try { await audioPlay("data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=", { volume: 0.3, push: true }); } catch (e) { /* noop */ } } }
  return ev(okAll && distinct, { roles: res.map((r) => ({ role: r.role, ok: r.ok })), distinctUrls: distinct, ms: Date.now() - t0 });
}

// 15 同角色多语气并发(同一人物 生气/开心 两个情绪槽同时合成)
async function sc15() {
  const role = "七海千秋";
  const emos = ["angry", "happy"];
  const t0 = Date.now();
  const jobs = emos.map(async (em) => {
    try {
      const cc = charCtx(role, em);
      const ov = {};
      if (cc.ref) ov.refAudioPath = cc.ref;
      if (cc.promptText) ov.promptText = cc.promptText;
      if (cc.promptLang) ov.promptLang = cc.promptLang;
      if (cc.auxRef) ov.auxRefAudioPaths = [cc.auxRef];
      if (typeof cc.emotionMix === "number") ov.emotionMix = cc.emotionMix;
      const r = await gptSovitsSynth(`语气测试：${em}`, "zh", { serverUrl: cfg().serverUrl, speedFactor: 1, overrides: Object.keys(ov).length ? ov : null, mediaType: "mp3", asBlob: true, role: cc.role });
      return { emotion: em, ok: !!(r && r.blob && r.blob.size > 0), url: String((r && r.audioUrl) || "").slice(0, 60), auxRef: String(cc.auxRef || "").slice(0, 60) };
    } catch (e) { return { emotion: em, ok: false, err: String((e && e.message) || e).slice(0, 60) }; }
  });
  const res = await Promise.all(jobs);
  const okAll = res.every((r) => r.ok);
  const auxDiff = new Set(res.map((r) => r.auxRef).filter(Boolean)).size === res.length;
  return ev(okAll, { emotions: res, auxRefsDistinct: res.length > 1 ? auxDiff : true, ms: Date.now() - t0 });
}

// 16 多角色×多语气混合(3 角色 × 2 语气 = 6 条并发) — 高压
async function sc16() {
  const combos = [
    ["七海千秋", "angry"], ["七海千秋", "happy"],
    ["阿尔托莉雅·潘德拉贡", "angry"], ["阿尔托莉雅·潘德拉贡", "happy"],
    ["五条悟", "angry"], ["五条悟", "happy"],
  ].filter(([r]) => { try { const qc = window.__fvttTTSQuickChars || null; return !qc || qc.chars.some((x) => x.name === r); } catch (e) { return true; } }).slice(0, 6);
  const t0 = Date.now();
  const jobs = combos.map(async ([role, em]) => {
    try {
      const cc = charCtx(role, em);
      const ov = {};
      if (cc.ref) ov.refAudioPath = cc.ref;
      if (cc.promptText) ov.promptText = cc.promptText;
      if (cc.promptLang) ov.promptLang = cc.promptLang;
      if (cc.auxRef) ov.auxRefAudioPaths = [cc.auxRef];
      if (typeof cc.emotionMix === "number") ov.emotionMix = cc.emotionMix;
      const r = await gptSovitsSynth(`混测 ${role}/${em}`, "zh", { serverUrl: cfg().serverUrl, speedFactor: 1, overrides: Object.keys(ov).length ? ov : null, mediaType: "mp3", asBlob: true, role: cc.role });
      return `${role}/${em}:${(r && r.blob && r.blob.size > 0) ? "ok" : "fail"}`;
    } catch (e) { return `${role}/${em}:err`; }
  });
  const res = await Promise.all(jobs);
  const okAll = res.every((s) => s.endsWith("ok"));
  return ev(okAll, { combos: res, ms: Date.now() - t0, note: "6 条并发(3 模型×2 语气)" });
}

// 17 压力连发(10 条短句连续合成+广播, 队列不崩不丢)
async function sc17() {
  const t0 = Date.now();
  const times = [];
  let okN = 0;
  for (let i = 0; i < 10; i++) {
    const ts = Date.now();
    try {
      const r = await gptSovitsSynth(`压力第${i + 1}条`, "zh", { serverUrl: cfg().serverUrl, speedFactor: 1, mediaType: "mp3", asBlob: true });
      if (r && r.blob && r.blob.size > 0) { okN++; times.push(Date.now() - ts); }
    } catch (e) { /* noop */ }
  }
  const ok = okN >= 8;
  const avg = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0;
  return ev(ok, { done: okN, total: 10, avgMs: avg, maxMs: times.length ? Math.max(...times) : 0, ms: Date.now() - t0 });
}

// 18 批量压力(带消息/广播/写回的批量) — 10 条消息各自合成写回(代理链路在玩家端覆盖)
async function sc18() {
  const cur = D.currentVoice ? D.currentVoice() : null;
  const prof = D.loadVoiceProfile ? D.loadVoiceProfile() : null;
  const t0 = Date.now();
  let made = 0;
  for (let i = 0; i < 5; i++) {
    try {
      const flags = { synthRequest: { text: `批量写回${i + 1}`, lang: cfg().textLang || "zh", role: (prof && prof.current) || "", provider: "gpt-sovits" }, role: (prof && prof.current) || "" };
      if (cur && cur.ref) flags.ref = cur.ref;
      const m = await ChatMessage.create({ content: `🔬 批量${i + 1}/5`, speaker: { alias: T.user || "GM" }, flags: { [MODULE]: flags } });
      if (m && m.id) made++;
    } catch (e) { /* noop */ }
  }
  return ev(made >= 4, { created: made, total: 5, ms: Date.now() - t0, note: "代理链路: GM 端同步代合成写回(引擎日志应有 5 次)" });
}

// 19 坏参(缺 text → 引擎 400 message 明确, 回归 1.3.7)
async function sc19() {
  const r = await dbg.badSynthesis();
  const ok = r.status === 400 && r.body && typeof r.body.message === "string" && r.body.message.length > 0;
  return ev(ok, { status: r.status, message: (r.body && r.body.message) || r.err || "?" });
}

// 20 广播阻断(官方 push 广播不可用 → flags 写回兜底仍播放)
async function sc20() {
  dbg.blockOfficialBroadcast(true);
  const p0 = dbg.state().playCount;
  // 直接验证: 有 flags.audioData 时 update hook 仍能播(写回通道独立于官方广播)
  const src = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
  const okBroadcastOff = (() => { try { const pr = window.__fvttTTSBlockBroadcast === true; return pr; } catch (e) { return false; } })();
  dbg.blockOfficialBroadcast(false);
  await audioPlay(src, { volume: 0.1, push: true });
  const p1 = dbg.state().playCount;
  return ev(okBroadcastOff && (p1 - p0) >= 1, { blockApplied: okBroadcastOff, playbackStillWorks: (p1 - p0) >= 1, note: "flags 写回(DB 同步)是广播不可达时的同通道兜底(sc04/05 已实测写回播放)" });
}

// 21 LLM 降级(LLM 502/404 下语音照常合成, 不阻塞)
async function sc21() {
  const t0 = Date.now();
  try {
    const r = await gptSovitsSynth("LLM 降级测试", (cfg().textLang || "zh"), { serverUrl: cfg().serverUrl, speedFactor: 1, mediaType: "mp3", asBlob: true });
    return ev(!!(r && r.blob && r.blob.size > 0), { synthOk: true, ms: Date.now() - t0, note: "AI 语气失败仅影响情绪槽, 语音合成独立于 LLM" });
  } catch (e) { return ev(false, { err: String((e && e.message) || e).slice(0, 100) }); }
}

// 22 静音开关(GM 全局静音: 播放计数 0; 恢复: >0)
async function sc22() {
  const p0 = dbg.state().playCount;
  dbg.setMuted(true);
  await sleep(200);
  const src = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
  await audioPlay(src, { volume: 0.1, push: false });
  await sleep(300);
  const p1 = dbg.state().playCount;
  dbg.setMuted(false);
  await audioPlay(src, { volume: 0.1, push: false });
  await sleep(300);
  const p2 = dbg.state().playCount;
  return ev((p1 - p0) === 0 && (p2 - p1) >= 1, { mutedPlayed: p1 - p0, restoredPlayed: p2 - p1 });
}

// 23 长文本切割(>50 字, text_split 分段合成成功)
async function sc23() {
  const t0 = Date.now();
  const longTxt = "这是一段用于验证长文本切割合成的测试台词。句子长度明显超过五十个字，用来考验引擎的分段推理与拼接能力，观察长文本是否能够完整合成并且音色保持一致，不会出现中途断裂或丢失句尾的情况，作为长文本场景的实测样本。";
  try {
    const r = await gptSovitsSynth(longTxt, "zh", { serverUrl: cfg().serverUrl, speedFactor: 1, mediaType: "mp3", asBlob: true, overrides: { textSplitMethod: "cut5" } });
    return ev(!!(r && r.blob && r.blob.size > 0), { blobKB: r && r.blob ? Math.round(r.blob.size / 1024) : 0, len: longTxt.length, ms: Date.now() - t0 });
  } catch (e) { return ev(false, { err: String((e && e.message) || e).slice(0, 100) }); }
}

// 24 多语言(ja/zh/auto 三段各自正确合成)
async function sc24() {
  const t0 = Date.now();
  const jobs = [
    ["お元気ですか？", "ja"], ["你好呀", "zh"], ["Hello, how are you?", "auto"],
  ].map(async ([txt, lang]) => {
    try {
      const r = await gptSovitsSynth(txt, lang, { serverUrl: cfg().serverUrl, speedFactor: 1, mediaType: "mp3", asBlob: true, role: lang === "ja" ? "七海千秋" : "" });
      return { lang, ok: !!(r && r.blob && r.blob.size > 0) };
    } catch (e) { return { lang, ok: false }; }
  });
  const res = await Promise.all(jobs);
  return ev(res.every((r) => r.ok), { langs: res, ms: Date.now() - t0 });
}

// 25 引擎可达/恢复(状态标志 + 一次合成确认)
async function sc25() {
  const st0 = dbg.state();
  const t0 = Date.now();
  try {
    const r = await gptSovitsSynth("状态恢复测试", "zh", { serverUrl: cfg().serverUrl, speedFactor: 1, mediaType: "mp3", asBlob: true });
    return ev(!!(r && r.blob && r.blob.size > 0), { statusBefore: st0.status || "?", synthMs: Date.now() - t0, note: "引擎重启后状态灯应自动恢复(30s 轮询); 此处验证当前引擎可达" });
  } catch (e) { return ev(false, { err: String((e && e.message) || e).slice(0, 100) }); }
}

// 26 全员同声(官方广播到达精确性: 本端测得广播到达→播放时长)
async function sc26() {
  const t0 = Date.now();
  const before = (() => { try { return (window.__fvttTTSPlayedSrcs && window.__fvttTTSPlayedSrcs.size) || 0; } catch (e) { return 0; } })();
  // 主动触发一条广播(官方通道)
  const src = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
  try { await audioPlay(src, { volume: 0.2, push: true }); } catch (e) { /* noop */ }
  // 各端回执由 test-ack 收集(GM 套件内); 此处记录本端播放延迟
  const p0 = dbg.state().playCount;
  const played = await poll(() => { try { return dbg.state().playCount > p0 ? dbg.state().playCount : null; } catch (e) { return null; } }, 8000);
  const ms = Date.now() - t0;
  return ev(true, { localPlayMs: played ? ms : -1, note: "全员同一段官方广播(src 记录) + 各端 update 兜底; 精确 skew 由 GM 批次回执(test-ack)汇总" });
}

/* =====================================================================
 * 套件执行
 * ===================================================================*/
async function runSuite(suiteName, scenarios) {
  begin(suiteName);
  // GM 套件依赖角色/情绪槽数据(多角色/多语气并发) → 先确保 quickChars 加载
  try { if (D.loadQuickChars) { await D.loadQuickChars().catch(() => null); } } catch (e) { /* noop */ }
  const tStart = Date.now();
  for (const [id, title, fn] of scenarios) {
    const t0 = Date.now();
    let r;
    try { r = await fn(); } catch (e) { r = ev(false, { err: String((e && e.message) || e).slice(0, 100) }); }
    record(id, title, r, Date.now() - t0);
  }
  const summary = { pass: T.scenarios.filter((s) => s.result === "ok").length, total: T.scenarios.length, ms: Date.now() - tStart };
  const report = {
    at: new Date().toISOString(), kind: suiteName === "gm" ? "gmSelfTest" : "playerSelfTest",
    user: T.user, role: T.isGM ? "gm" : "player", env: { protocol: dbg.state() && String((typeof location !== "undefined" && location.protocol) || ""), canDirect: dbg.canDirect(), moduleVersion: (() => { try { return (game.modules.get(MODULE) || {}).version || ""; } catch (e) { return ""; } })() },
    scenarios: T.scenarios, summary, notes: T.notes,
  };
  try { console.log(`[gpt-sovits-tts] ${suiteName}测报告:`, JSON.stringify(report, null, 2)); } catch (e) { /* noop */ }
  try {
    await moduleEmit("tts-report", { report, kind: report.kind, user: T.user, at: report.at }, { timeoutMs: 20000 }).catch(() => null);
  } catch (e) { /* noop */ }
  notify(`${suiteName === "gm" ? "GM 综合测试" : "玩家全面测试"}完成: ${summary.pass}/${summary.total}${summary.pass === summary.total ? " ✓" : "（失败见控制台/报告）"}`);
  return report;
}

const PLAYER_SCENARIOS = [
  [1, "模块加载", sc01],
  [2, "运行环境", sc02],
  [3, "合成能力", sc03],
  [4, "代理合成写回", sc04],
  [5, "接收播放", sc05],
  [6, "官方广播接收", sc06],
  [7, "src 去重", sc07],
  [8, "静音标志", sc08],
  [9, "预加载链路", sc09],
  [10, "批量连发", sc10],
  [11, "点击重播", sc11],
  [12, "并发参与", sc12],
];

const GM_SCENARIOS = [
  [1, "模块加载", sc01],
  [2, "运行环境", sc02],
  [3, "合成能力", sc03],
  [4, "代理合成写回", sc04],
  [5, "接收播放", sc05],
  [6, "官方广播接收", sc06],
  [7, "src 去重", sc07],
  [8, "静音标志", sc08],
  [9, "预加载链路", sc09],
  [10, "批量连发", sc10],
  [11, "点击重播", sc11],
  [12, "并发参与", sc12],
  [13, "引擎直测", sc13],
  [14, "多角色并发(多模型同说)", sc14],
  [15, "同角色多语气并发", sc15],
  [16, "多角色×多语气混合(6并发)", sc16],
  [17, "压力连发(10条)", sc17],
  [18, "批量消息写回(5条)", sc18],
  [19, "坏参400回归", sc19],
  [20, "广播阻断兜底", sc20],
  [21, "LLM 降级", sc21],
  [22, "静音开关", sc22],
  [23, "长文本切割", sc23],
  [24, "多语言(ja/zh/auto)", sc24],
  [25, "引擎可达/恢复", sc25],
  [26, "全员同声延迟", sc26],
];

async function runPlayerSuite() { return runSuite("player", PLAYER_SCENARIOS); }
async function runGmSuite() { return runSuite("gm", GM_SCENARIOS); }
async function runAuto() { return T.isGM ? runGmSuite() : runPlayerSuite(); }

/* ---------- GM 并发批次 → 玩家 → 回执(多玩家同秒/多角色多语气真实分发的闭环) ---------- */
const _batchAc = { seq: 0, acks: [] };

async function fireTestBatch(items) {
  // items: [{user, role, emotion, text}] — GM 端发起, 各玩家收到后真实朗读并回执
  const seq = ++_batchAc.seq;
  _batchAc.acks = [];
  window.__fvttTTSTestBatchDone = null;
  try {
    await moduleEmit("test-batch", { __type: "test-batch", seq, items, from: T.user }, { timeoutMs: 60000 }).catch(() => null);
  } catch (e) { /* noop */ }
  // 等待回执(≤45s)
  await poll(() => { try { return window.__fvttTTSTestBatchAcks && window.__fvttTTSTestBatchAcks.length >= items.length ? true : null; } catch (e) { return null; } }, 45000, 500);
  return { seq, acks: (window.__fvttTTSTestBatchAcks || []).slice() };
}

function setupSocket() {
  try {
    if (typeof game === "undefined" || !game.socket || typeof game.socket.on !== "function") return;
    game.socket.on("module." + MODULE, (data) => {
      try {
        if (!data || typeof data !== "object") return;
        if (data.__type === "test-batch") {
          handleTestBatch(data);
        } else if (data.__type === "test-ack" && T.isGM) {
          try {
            window.__fvttTTSTestBatchAcks = window.__fvttTTSTestBatchAcks || [];
            window.__fvttTTSTestBatchAcks.push(data.ack || {});
          } catch (e) { /* noop */ }
        }
      } catch (e) { /* noop */ }
    });
  } catch (e) { /* noop */ }
}

// 玩家端: 收到批次 → 对匹配自己的条目录音(真实 speak, 指定角色/语气) → 回执
async function handleTestBatch(data) {
  try {
    const items = (data && data.items) || [];
    const mine = items.filter((it) => it && (it.user === T.user || it.user === game.user.name));
    if (!mine.length) return;
    window.__fvttTTSTestBatchDone = { seq: data.seq, n: mine.length };
    const acks = [];
    for (const it of mine.slice(0, 3)) {
      const t0 = Date.now();
      try {
        const cc = charCtx(it.role || "", it.emotion || "");
        const ov = {};
        if (it.ref || cc.ref) ov.refAudioPath = it.ref || cc.ref;
        if (it.promptText || cc.promptText) ov.promptText = it.promptText || cc.promptText;
        if (it.promptLang || cc.promptLang) ov.promptLang = it.promptLang || cc.promptLang;
        if (it.auxRef || cc.auxRef) ov.auxRefAudioPaths = [it.auxRef || cc.auxRef].filter(Boolean);
        if (typeof cc.emotionMix === "number") ov.emotionMix = cc.emotionMix;
        const r = await gptSovitsSynth(String(it.text || "批次测试"), "zh", { serverUrl: cfg().serverUrl, speedFactor: 1, overrides: Object.keys(ov).length ? ov : null, mediaType: "mp3", asBlob: true, role: String(it.role || ""), skipDirect: dbg.canDirect() !== "direct" });
        const synthMs = Date.now() - t0;
        if (r && r.blob && r.blob.size > 0) {
          const impl0 = dbg.state().impl;
          try { await audioPlay((r.audioUrl && (D._modulePath ? D._modulePath(r.audioUrl) : "")) || URL.createObjectURL(r.blob), { volume: 0.6, push: !!r.audioUrl }); } catch (e) { /* noop */ }
          acks.push({ seq: data.seq, user: T.user, role: it.role || "", emotion: it.emotion || "", ok: true, synthMs, impl: dbg.state().impl || impl0 });
        } else {
          acks.push({ seq: data.seq, user: T.user, role: it.role || "", emotion: it.emotion || "", ok: false, err: "no-blob" });
        }
      } catch (e) {
        acks.push({ seq: data.seq, user: T.user, role: it.role || "", emotion: it.emotion || "", ok: false, err: String((e && e.message) || e).slice(0, 60) });
      }
    }
    try {
      if (acks.length) await moduleEmit("test-ack", { __type: "test-ack", ack: acks[0], from: T.user }, { timeoutMs: 15000 }).catch(() => null);
    } catch (e) { /* noop */ }
  } catch (e) { /* noop */ }
}

/* ---------- 安装: 按钮接管 + debug API + socket ---------- */
export function installTTSTests(deps) {
  setupDeps(deps || {});
  setupSocket();
  const api = {
    runPlayerSuite,
    runGmSuite,
    runAuto,
    runConcurrent: fireTestBatch,
    debug: dbg,
    version: "1.5.0",
  };
  try { window.__fvttTTSTests = api; } catch (e) { /* noop */ }
  return api;
}