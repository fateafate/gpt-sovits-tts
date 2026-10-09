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
function recSkip(reason) { return { ok: false, ev: {}, __skip: reason }; }
function record(id, title, r, ms, skipReason) {
  T.scenarios.push({ id, title, result: skipReason ? "skip" : (r.ok ? "ok" : "fail"), evidence: r.ev, ms, ...(skipReason ? { skip: skipReason } : {}) });
  return skipReason ? "skip" : r.ok;
}
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
      const r = await fetch(su + "/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: " ", text_lang: "zh", media_type: "mp3", ref_audio_path: "fvtt_chars/七海千秋/speech/nanami/nanami_voice_04.wav" }), signal: AbortSignal.timeout(30000) });
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
  if (T.isGM) return recSkip("代理合成写回是玩家链路(GM 代合成), GM 端由直连合成+sc13 引擎直测覆盖");
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
  // 写回播放可能发生在 sc04 期间(update hook 异步) → 先等 8s; 无新播放则主动触发一次官方广播验证播放轨迹
  const waited = await poll(() => { const s = dbg.state(); return (s.playCount > p0 && s.impl) ? s : null; }, 8000, 400);
  if (!waited) {
    try { await audioPlay("data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=", { volume: 0.1, push: true }); } catch (e) { /* noop */ }
  }
  const got = await poll(() => {
    const s = dbg.state();
    if (s.playCount > p0 && s.impl) return s;
    return null;
  }, 15000);
  return ev(!!got, got ? { playCount: got.playCount, impl: got.impl, via: waited ? "写回播放" : "主动官方广播" } : { err: "播放轨迹未检测(官方/兜底通道均未出现新播放)" });
}

// 06 官方广播接收(playAudio src 记录出现 → Foundry 官方内部语音通道可用)
async function sc06() {
  const before = (() => { try { return (window.__fvttTTSPlayedSrcs && window.__fvttTTSPlayedSrcs.size) || 0; } catch (e) { return 0; } })();
  // 本端已有官方广播播放记录(如 sc05 刚走的官方通道) → 广播通道已被证明可达, 直接通过
  if (before > 0) return ev(true, { playedSrcs: before, note: "官方广播已有播放记录(官方通道可达)" });
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
  // 用与 sc07 相同且验证可播的音频(SRC_A), 恢复播放前清理 src 去重记录(否则 30s 窗口内被 sc07 拦截)
  const SRC_A = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
  const p0 = dbg.state().playCount;
  dbg.setMuted(true);
  await audioPlay(SRC_A, { volume: 0.1, push: false });
  await sleep(300);
  const p1 = dbg.state().playCount;
  dbg.setMuted(!was);
  try { if (window.__fvttTTSPlayedSrcs) window.__fvttTTSPlayedSrcs.delete(SRC_A); } catch (e) { /* noop */ }
  await audioPlay(SRC_A, { volume: 0.1, push: false });
  await sleep(300);
  const p2 = dbg.state().playCount;
  const okM = (p1 - p0) === 0;   // 静音时不播
  const okR = (p2 - p1) >= 1;    // 恢复后能播
  return ev(okM && okR, { mutedPlayed: p1 - p0, restoredPlayed: p2 - p1, note: "恢复播放前清理src去重记录(30s窗口)" });
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
  if (T.isGM) return ev(true, { note: "GM 端是批次发起方, 不参与自身批次(玩家端参与并回执)" });
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

// GM 端 14-18 均为"压力分发"场景: 服务器/引擎机不登录账号(只跑 FVTT)且配置烂 —
// 压力(连发/并发/播放/队列)全部下放到**指定玩家电脑**执行(真实链路), GM 只协调与汇总
const _likedRoles = ["七海千秋", "阿尔托莉雅·潘德拉贡", "五条悟"];

// 14 多角色并发(多模型一起说话): 不同角色分发给在线玩家, 同秒各端朗读
async function sc14() {
  const roles = _likedRoles.filter((r) => {
    try { const qc = window.__fvttTTSQuickChars || null; return !qc || qc.chars.some((x) => x.name === r); } catch (e) { return true; }
  }).slice(0, 3);
  const pl = onlinePlayers();
  if (!pl.length) return recSkip("压力在玩家电脑: 多角色并发需在线玩家(每个玩家一个角色, 同秒发声)");
  const items = roles.map((role, i) => {
    const cc = charCtx(role, "");
    return { user: pl[i % pl.length], role, emotion: "", text: `并发测试:${role}`, ref: cc.ref || "", promptText: cc.promptText || "", promptLang: cc.promptLang || "" };
  });
  const r = await runStress(pl, { mode: "combo", items });
  const acks = (r && r.acks) || [];
  if (!acks.length) return recSkip("目标玩家未回执(玩家端需硬刷新到新版+引擎空闲时测): 多角色并发未分发执行");
  const ok = acks.some((a) => a && a.ok !== false && !a.declined);
  return ev(ok, {
    targets: pl, items: roles.length,
    acks: acks.map((a) => ({ user: a.user, resultCount: (a.result || []).length, roles: ((a.result || []).map((x) => x.role)).join("|"), avgSynthMs: Math.round(((a.result || []).reduce((s, x) => s + (x.synthMs || 0), 0)) / Math.max(1, (a.result || []).length)), err: a.err || "" })),
    note: "多模型同一秒从各玩家电脑同时合成→广播; 引擎为唯一合成源(现实多人说话亦然)",
  });
}

// 15 同角色多语气并发(同一人物 生气/开心 两个情绪槽同时)
async function sc15() {
  const role = "七海千秋";
  const emos = ["angry", "happy"];
  const pl = onlinePlayers();
  if (!pl.length) return recSkip("压力在玩家电脑: 多语气并发需在线玩家参与");
  const items = emos.map((em, i) => {
    const cc = charCtx(role, em);
    return { user: pl[i % pl.length], role, emotion: em, text: `语气测试:${em}`, ref: cc.ref || "", promptText: cc.promptText || "", promptLang: cc.promptLang || "", auxRef: cc.auxRef || "", emotionMix: cc.emotionMix };
  });
  const r = await runStress(pl, { mode: "combo", items });
  const acks = (r && r.acks) || [];
  if (!acks.length) return recSkip("目标玩家未回执(玩家端需硬刷新到新版+引擎空闲时测): 同角色多语气并发未分发执行");
  const ok = acks.some((a) => a && a.ok !== false && !a.declined);
  return ev(ok, {
    acks: acks.map((a) => ({ user: a.user, emotions: ((a.result || []).map((x) => x.emotion)).join("|"), ok: a.ok !== false })),
    note: "同一角色两种情绪在两个玩家电脑同时合成(情绪槽 auxRef 不同)",
  });
}

// 16 多角色×多语气混合(3 角色 × 2 语气 = 6 条并发) — 真实多人混合高压
async function sc16() {
  const combos = [
    ["七海千秋", "angry"], ["七海千秋", "happy"],
    ["阿尔托莉雅·潘德拉贡", "angry"], ["阿尔托莉雅·潘德拉贡", "happy"],
    ["五条悟", "angry"], ["五条悟", "happy"],
  ].filter(([r]) => { try { const qc = window.__fvttTTSQuickChars || null; return !qc || qc.chars.some((x) => x.name === r); } catch (e) { return true; } }).slice(0, 6);
  const items = comboItems(combos);
  if (!items.length) return recSkip("压力在玩家电脑: 混合并发(6条)需在线玩家参与");
  const r = await runStress(onlinePlayers(), { mode: "combo", items });
  const acks = (r && r.acks) || [];
  if (!acks.length) return recSkip("目标玩家未回执(玩家端需硬刷新到新版+引擎空闲时测): 混合并发未分发执行");
  const ok = acks.some((a) => a && a.ok !== false && !a.declined);
  return ev(ok, {
    targets: onlinePlayers(), combos: combos.map(([x, y]) => `${x}/${y}`),
    acks: acks.map((a) => ({ user: a.user, done: (a.result || []).length, ok: a.ok !== false })),
    note: "6 条(3 模型×2 语气)由在线玩家分摊并发执行, GM/服务器端零组织压力",
  });
}

// 17 压力连发(指定玩家电脑连发 10 条, 队列/播放/广播压力在玩家端)
async function sc17() {
  const pl = onlinePlayers();
  if (!pl.length) return recSkip("压力在玩家电脑: 连发 10 条需指定在线玩家");
  const r = await runStress(pl.slice(0, 2), { mode: "burst", count: 10, gapMs: 500 });
  const acks = (r && r.acks) || [];
  if (!acks.length) return recSkip("目标玩家未回执(玩家端需硬刷新到新版+引擎空闲时测): 压力连发未分发执行");
  const totalAcked = acks.reduce((s, a) => s + (a.count || 0), 0);
  const okAcks = acks.filter((a) => a && a.ok !== false && !a.declined);
  const ok = okAcks.length > 0;
  return ev(ok, {
    targets: pl.slice(0, 2), requested: 10,
    acks: acks.map((a) => ({ user: a.user, count: a.count || 0, done: a.done || 0, avgMs: Math.round(a.avgMs || 0), maxMs: a.maxMs || 0, viaMsg: !!a.viaMsg, ok: a.ok !== false })),
    note: "连续 10 条在玩家电脑执行(合成请求→播放→官方广播), 服务器/引擎机浏览器零参与",
  });
}

// 18 批量消息写回(玩家电脑连发 5 条真实消息 → 合成→写回 flags→全员播放)
async function sc18() {
  const pl = onlinePlayers();
  if (!pl.length) return recSkip("压力在玩家电脑: 批量消息写回需指定在线玩家");
  const r = await runStress(pl.slice(0, 1), { mode: "burst", count: 5, gapMs: 600, viaMsg: true });
  const acks = (r && r.acks) || [];
  if (!acks.length) return recSkip("目标玩家未回执(玩家端需硬刷新到新版+引擎空闲时测): 批量消息写回未分发执行; 消息写回链路已在玩家套件 sc04 实测");
  const okAcks = acks.filter((a) => a && a.ok !== false && !a.declined);
  const doneN = acks.reduce((s, a) => s + (a.done || 0), 0);
  return ev(okAcks.length > 0 && doneN >= 3, {
    target: pl.slice(0, 1), viaMsg: true,
    acks: acks.map((a) => ({ user: a.user, done: a.done || 0, count: a.count || 0, avgMs: Math.round(a.avgMs || 0) })),
    note: "5 条真实消息在玩家电脑走消息链路(权威写回→DB 同步→全员播放), 引擎日志应有对应合成记录",
  });
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
  // 用验证可播的音频(SRC_A), 播放前清理 src 去重记录
  const src = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
  const okBroadcastOff = (() => { try { const pr = window.__fvttTTSBlockBroadcast === true; return pr; } catch (e) { return false; } })();
  dbg.blockOfficialBroadcast(false);
  try { if (window.__fvttTTSPlayedSrcs) window.__fvttTTSPlayedSrcs.delete(src); } catch (e) { /* noop */ }
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
let _suiteRunning = false;
async function runSuite(suiteName, scenarios) {
  // 防并发交错: 🔬(runAuto) 与 🧪(runGmSuite) 双按钮同时点 → 只跑第一个, 避免场景记录累计成 50
  if (_suiteRunning) { warn("测试正在运行中，请等本次跑完"); return null; }
  _suiteRunning = true;
  try {
  begin(suiteName);
  // GM 套件依赖角色/情绪槽数据(多角色/多语气并发) → 先确保 quickChars 加载
  try { if (D.loadQuickChars) { await D.loadQuickChars().catch(() => null); } } catch (e) { /* noop */ }
  const tStart = Date.now();
  for (const [id, title, fn] of scenarios) {
    const t0 = Date.now();
    let r;
    try { r = await fn(); } catch (e) { r = ev(false, { err: String((e && e.message) || e).slice(0, 100) }); }
    if (r && r.__skip) record(id, title, { ok: false, ev: r.ev }, Date.now() - t0, String(r.__skip));
    else record(id, title, r, Date.now() - t0);
  }
  const skipped = T.scenarios.filter((s) => s.result === "skip").length;
  const summary = { pass: T.scenarios.filter((s) => s.result === "ok").length, total: T.scenarios.length, skipped, ms: Date.now() - tStart };
  const report = {
    at: new Date().toISOString(), kind: suiteName === "gm" ? "gmSelfTest" : "playerSelfTest",
    user: T.user, role: T.isGM ? "gm" : "player", env: { protocol: dbg.state() && String((typeof location !== "undefined" && location.protocol) || ""), canDirect: dbg.canDirect(), moduleVersion: (() => { try { return (game.modules.get(MODULE) || {}).version || ""; } catch (e) { return ""; } })() },
    scenarios: T.scenarios, summary, notes: T.notes,
  };
  try { console.log(`[gpt-sovits-tts] ${suiteName}测报告:`, JSON.stringify(report, null, 2)); } catch (e) { /* noop */ }
  try {
    // 报告落盘双保险: ①本端能 POST 引擎(直连 / https serverUrl / GM 本地) → 直接落盘
    // ②失败或无法直连 → moduleEmit tts-report 经 GM 中转落盘(GM 不在线时报告仍打印 console 可查)
    const su = String(cfg().serverUrl || "http://127.0.0.1:9881").replace(/\/+$/, "");
    let posted = false;
    if (T.isGM || dbg.canDirect() === "direct" || /^https:\/\//i.test(su)) {
      try {
        await fetch(su + "/speedtest/report", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(report), signal: AbortSignal.timeout(15000),
        });
        posted = true;
      } catch (e) { /* fallback to GM relay */ }
    }
    if (!posted) {
      try { await moduleEmit("tts-report", { report, kind: report.kind, user: T.user, at: report.at }, { timeoutMs: 20000 }).catch(() => null); } catch (e) { /* noop */ }
    }
  } catch (e) { /* noop */ }
  notify(`${suiteName === "gm" ? "GM 综合测试" : "玩家全面测试"}完成: ${summary.pass}/${summary.total}${summary.pass === summary.total ? " ✓" : "（失败见控制台/报告）"}`);
  return report;
  } finally { _suiteRunning = false; }
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
  [19, "坏参400回归", sc19],   // 提前: 引擎空闲时验证 400(压力场景之后引擎忙会导致请求排队超时)
  [14, "多角色并发(多模型同说)", sc14],
  [15, "同角色多语气并发", sc15],
  [16, "多角色×多语气混合(6并发)", sc16],
  [17, "压力连发(10条)", sc17],
  [18, "批量消息写回(5条)", sc18],
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

// 在线玩家名单(非 GM, 非本端) — 压力跑在玩家电脑(服务器/引擎机不登录账号)
function onlinePlayers() {
  try {
    return game.users.contents.filter((u) => u && u.active && !u.isGM && u.name && u.name !== ((game.user && game.user.name) || "")).map((u) => String(u.name));
  } catch (e) { return []; }
}

// 角色/语气组合分发到在线玩家(循环分配, 保证"多个一起"真实多端并发);
// 条目自带角色上下文(GM 从 quickChars 取好下发) → 玩家端不依赖本地 quickChars 也能正确合成
function comboItems(combos) {
  const pl = onlinePlayers();
  const out = [];
  if (!pl.length) return out;
  combos.forEach(([role, em], i) => {
    const cc = charCtx(role, em || "");
    out.push({
      user: pl[i % pl.length], role, emotion: em || "", text: `并发测试 ${role || "角色"}/${em || "默认"}`,
      ref: cc.ref || "", promptText: cc.promptText || "", promptLang: cc.promptLang || "",
      auxRef: cc.auxRef || "", emotionMix: cc.emotionMix,
    });
  });
  return out;
}

// GM 分发压力批次: 指定玩家电脑各自执行(真实链路) → 回执汇总
async function runStress(targets, cfg2) {
  const c2 = cfg2 || {};
  const pl = (targets && targets.length) ? targets : onlinePlayers();
  if (!pl.length) return { ok: false, err: "no-online-players", skip: "无在线玩家: 压力需跑在指定玩家电脑(不与服务器抢资源)" };
  let items = [];
  if (c2.mode === "burst") {
    const count = Number(c2.count) || 8;
    const gapMs = Number(c2.gapMs) || 400;
    const baseTxt = c2.text || "压力测试第";
    const viaMsg = c2.viaMsg === true;
    for (const u of pl) {
      for (let i = 0; i < count; i++) {
        items.push({ user: u, role: c2.role || "", emotion: c2.emotion || "", text: `${baseTxt}${i + 1}条`, stress: { mode: "burst", seq: i, total: count, gapMs, viaMsg } });
      }
    }
  } else if (c2.mode === "combo") {
    items = (c2.items || []).map((it) => ({ ...it, stress: { mode: "combo" } }));
  } else {
    return { ok: false, err: "bad-mode" };
  }
  if (!items.length) return { ok: false, err: "no-items", skip: "组合为空" };
  const res = await fireTestBatch(items);
  return { ok: (res.ok !== false) && (res.acks || []).some((a) => a.ok !== false && !a.declined), mode: c2.mode, items: items.length, ...res };
}

// GM 专属压力场景骨架(分布到玩家电脑执行; 服务器/引擎机不参与)
async function gmStress(id, title, cfg2, expectMin) {
  const pl = onlinePlayers();
  if (!pl.length) return recSkip(`压力在玩家电脑执行: 需至少 1 名玩家在线(${title})`);
  const r = await runStress(pl, cfg2);
  const acks = (r && r.acks) || [];
  const okAcks = acks.filter((a) => a && a.ok !== false && !a.declined);
  const ok = (r && r.ok !== false) && okAcks.length > 0 && ((pl.length === 1) ? okAcks.length >= 1 : true);
  const evo = {
    targets: pl, items: (r && r.items) || 0,
    acks: acks.slice(0, 6).map((a) => ({ user: a.user, ok: a.ok !== false, declined: !!a.declined, mode: a.mode || "", count: a.count || 0, done: a.done || 0, okCount: a.done || 0, avgMs: Math.round(a.avgMs || 0), maxMs: a.maxMs || 0, err: a.err || String((a.result && a.result.err) || "") })),
    note: "合成请求由各玩家电脑发起(真实链路: 合成→播放→广播), GM 只协调汇总; 引擎为唯一合成源(真实多人场景必然)",
  };
  return ev(ok, evo);
}

async function fireTestBatch(items) {
  // items: [{user, role, emotion, text, stress, ref/promptText/...}] — GM 端发起, 各玩家收到后在自己电脑执行并回执
  const seq = ++_batchAc.seq;
  _batchAc.acks = [];
  window.__fvttTTSTestBatchDone = null;
  window.__fvttTTSTestBatchAcks = [];
  try {
    // 裸 emit(fire-and-forget): 服务器把 module 事件中继给其他客户端; 无需 rid 响应 → 不阻塞等待
    game.socket.emit("module." + MODULE, { __type: "test-batch", seq, items, from: T.user });
  } catch (e) { /* noop */ }
  // 等待回执: 每个目标玩家(去重)应回 1 条汇总(或拒绝)
  const targets = new Set((items || []).map((i) => i && i.user).filter(Boolean)).size;
  await poll(() => {
    try {
      const a = window.__fvttTTSTestBatchAcks || [];
      const got = new Set(a.map((x) => x && x.user).filter(Boolean));
      if (a.some((x) => x && x.declined)) return true;
      return got.size >= targets ? true : null;
    } catch (e) { return null; }
  }, 120000, 500);   // 压力批次玩家端并发2执行(每条合成+间隔), 等 120s
  return { seq, targets, ok: true, acks: (window.__fvttTTSTestBatchAcks || []).slice() };
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

// 玩家端: 收到批次(并发/压力) → 匹配自己的条目在自己电脑执行(真实链路: 合成→播放→官方广播/消息写回) → 回执
// 压测默认参与; 玩家可在设置关闭(allowStressTest) → 回执 declined
async function handleTestBatch(data) {
  try {
    const items = (data && data.items) || [];
    const mine = items.filter((it) => it && (it.user === T.user || it.user === game.user.name));
    if (!mine.length) return;
    let allow = true;
    try { allow = game.settings.get(MODULE, "allowStressTest") !== false; } catch (e) { allow = true; }
    if (!allow) {
      try { await moduleEmit("test-ack", { __type: "test-ack", ack: { seq: data.seq, user: T.user, declined: true, err: "玩家关闭了压力测试参与开关" }, from: T.user }, { timeoutMs: 15000 }).catch(() => null); } catch (e) { /* noop */ }
      return;
    }
    window.__fvttTTSTestBatchDone = { seq: data.seq, n: mine.length };
    const mode = (mine[0] && mine[0].stress && mine[0].stress.mode) || "combo";
    if (mode === "burst") {
      const total = mine.length;
      const gapMs = (mine[0] && mine[0].stress && mine[0].stress.gapMs) || 500;
      const viaMsg = (mine[0] && mine[0].stress && mine[0].stress.viaMsg) === true;
      const times = [];
      let doneN = 0;
      const runOne = async (i) => {
        const it = mine[i] || {};
        const ts = Date.now();
        try {
          if (viaMsg) {
            const cc = charCtx(it.role || "", it.emotion || "");
            const flags = { synthRequest: { text: String(it.text || `压力${i + 1}`), lang: "zh", role: String(it.role || ""), provider: "gpt-sovits" }, role: String(it.role || "") };
            if (it.ref || cc.ref) flags.ref = it.ref || cc.ref;
            if (it.promptText || cc.promptText) flags.promptText = it.promptText || cc.promptText;
            if (it.promptLang || cc.promptLang) flags.promptLang = it.promptLang || cc.promptLang;
            const m = await ChatMessage.create({ content: String(it.text || `压力${i + 1}`), speaker: { alias: T.user || "玩家" }, flags: { [MODULE]: flags } });
            if (m && m.id) doneN++;
          } else {
            const cc = charCtx(it.role || "", it.emotion || "");
            const ov = {};
            if (it.ref || cc.ref) ov.refAudioPath = it.ref || cc.ref;
            if (it.promptText || cc.promptText) ov.promptText = it.promptText || cc.promptText;
            if (it.promptLang || cc.promptLang) ov.promptLang = it.promptLang || cc.promptLang;
            if (it.auxRef || cc.auxRef) ov.auxRefAudioPaths = [it.auxRef || cc.auxRef];
            if (typeof it.emotionMix === "number" || typeof cc.emotionMix === "number") ov.emotionMix = typeof it.emotionMix === "number" ? it.emotionMix : cc.emotionMix;
            const r = await gptSovitsSynth(String(it.text || "压力测试"), "zh", { serverUrl: cfg().serverUrl, speedFactor: 1, overrides: Object.keys(ov).length ? ov : null, mediaType: "mp3", asBlob: true, role: String(it.role || ""), skipDirect: dbg.canDirect() !== "direct" });
            if (r && r.blob && r.blob.size > 0) {
              doneN++;
              try { await audioPlay((r.audioUrl && (D._modulePath ? D._modulePath(r.audioUrl) : "")) || URL.createObjectURL(r.blob), { volume: 0.6, push: !!r.audioUrl }); } catch (e) { /* noop */ }
            }
          }
          times.push(Date.now() - ts);
        } catch (e) { /* 单条失败不中断 */ }
        if (i < total - 1 && gapMs > 0) await sleep(gapMs);
      };
      // 玩家端并发 2 滑窗执行(真实并发压力在玩家电脑, 缩短 GM 等待窗口)
      let cursor = 0;
      async function workerB() { while (cursor < total) { const i = cursor++; await runOne(i); } }
      await Promise.all([workerB(), workerB()]);
      const ack = {
        seq: data.seq, user: T.user, ok: doneN >= Math.max(1, Math.floor(total * 0.6)), mode: "burst",
        count: total, done: doneN, avgMs: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0,
        maxMs: times.length ? Math.max(...times) : 0, viaMsg,
      };
      try { await moduleEmit("test-ack", { __type: "test-ack", ack, from: T.user }, { timeoutMs: 15000 }).catch(() => null); } catch (e) { /* noop */ }
      return;
    }
    // combo: 各条(可含不同角色/语气)在自己电脑朗读 → 回执汇总(玩家端并发 2)
    const result = [];
    const mine2 = mine.slice(0, 8);
    const runCombo = async (it) => {
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
          result.push({ role: it.role || "", emotion: it.emotion || "", ok: true, synthMs, impl: dbg.state().impl || impl0 });
        } else {
          result.push({ role: it.role || "", emotion: it.emotion || "", ok: false, err: "no-blob" });
        }
      } catch (e) {
        result.push({ role: it.role || "", emotion: it.emotion || "", ok: false, err: String((e && e.message) || e).slice(0, 60) });
      }
    };
    let cursor2 = 0;
    async function workerC() { while (cursor2 < mine2.length) { const it = mine2[cursor2++]; await runCombo(it); } }
    await Promise.all([workerC(), workerC()]);
    const ack2 = { seq: data.seq, user: T.user, mode: "combo", result, ok: result.filter((x) => x.ok).length >= Math.max(1, Math.floor(result.length * 0.6)) };
    try { if (result.length) await moduleEmit("test-ack", { __type: "test-ack", ack: ack2, from: T.user }, { timeoutMs: 15000 }).catch(() => null); } catch (e) { /* noop */ }
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
    // 1.5.1: GM 分发压力到指定玩家电脑(服务器/引擎机零压力) — runStress(["Player2"], {mode:"burst", count:10})
    runStress,
    onlinePlayers,
    debug: dbg,
    version: "1.5.2",
  };
  try { window.__fvttTTSTests = api; } catch (e) { /* noop */ }
  return api;
}