/**
 * gpt-sovits-tts — TTS 引擎层
 * 提供: 播放队列(排队/打断)、音频播放、GPT-SoVITS 请求、浏览器 WebSpeech 合成
 */

/* ---------- 播放队列 ---------- */

/** src 规范化键: 跨路径形态(相对/绝对/data URI)统一 → 用于跨通道去重(官方广播 + flags 写回双播根治) */
export function normPlayKey(s) {
  try {
    const t = String(s || "").trim();
    if (!t) return "";
    if (/^data:/i.test(t)) { return "data:" + t.slice(0, 48); }        // data URI: 前 48 字符签名(同段音频同签名)
    if (/^https?:\/\//i.test(t)) { try { return new URL(t).pathname; } catch (e) { return t; } }
    if (t.startsWith("/")) return t;
    return "/" + t;
  } catch (e) { return ""; }
}

/** 登记"本端已播放" src(规范化键, 30s 过期), 供各播放路径去重 */
export function markPlayedSrc(src) {
  try {
    const k = normPlayKey(src);
    if (!k) return;
    window.__fvttTTSPlayedSrcs = window.__fvttTTSPlayedSrcs || new Set();
    window.__fvttTTSPlayedSrcs.add(k);
    setTimeout(() => { try { window.__fvttTTSPlayedSrcs.delete(k); } catch (e) { /* noop */ } }, 30000);
  } catch (e) { /* noop */ }
}

/** 本端是否已播过该 src(规范化键匹配) */
export function hasPlayedSrc(src) {
  try {
    const k = normPlayKey(src);
    if (!k) return false;
    return !!(window.__fvttTTSPlayedSrcs && window.__fvttTTSPlayedSrcs.has(k));
  } catch (e) { return false; }
}

/** 分块异步 base64(大文件上传防 UI 冻结/内存峰值): 每块 8MB 转码, 每 32MB 让出一次事件循环。
 *  同步 btoa 几百 MB 字符串会直接冻结/崩溃浏览器标签(拖入超大角色包/导入大包时)。 */
export async function bytesToB64Async(bytes) {
  const CH = 8 * 1024 * 1024;
  let out = "";
  for (let i = 0; i < bytes.length; i += CH) {
    const end = Math.min(i + CH, bytes.length);
    let bin = "";
    for (let j = i; j < end; j += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(j, Math.min(j + 0x8000, end)));
    out += btoa(bin);
    if (i % (CH * 4) === 0) await new Promise((r) => setTimeout(r, 0));
  }
  return out;
}

/** 按文件名扩展名推断音频 content-type(浏览器 file.type 为空/octet-stream 时, 分片导入用) */
function _extToCtype(name) {
  const m = { wav: "audio/wav", mp3: "audio/mpeg", flac: "audio/flac", ogg: "audio/ogg", opus: "audio/ogg", aac: "audio/aac", m4a: "audio/mp4", webm: "audio/webm" };
  const e = String(name || "").split(".").pop().toLowerCase();
  return m[e] || "application/octet-stream";
}

/** 角色包导入(自动分片, 1.6.12): ≤12MB 单次原路径; 大包分片(每片 10MB, 边转边发不保留全量 b64,
 *  引擎边收边落盘, 消除单次几百 MB body 与内存峰值 → 不再丢 FVTT 连接)。
 *  返回 {ok, name, message}; onProgress(0~1) 可选。 */
export async function importCharPackChunked(base, file, { target = "/characters/import", onProgress } = {}) {
  const CH = 10 * 1024 * 1024;
  const ab = await file.arrayBuffer();
  const bytes = new Uint8Array(ab);
  const total = bytes.length;
  const ctype = file.type || _extToCtype(file.name || "");
  if (total <= 12 * 1024 * 1024) {
    const b64 = await bytesToB64Async(bytes);
    if (onProgress) { try { onProgress(1); } catch (e) { /* noop */ } }
    const r = await svcRequest(base, "POST", target, null, { b64Body: b64, contentType: ctype, timeoutMs: 300000 });
    const j = (r.jsonSafe ? r.jsonSafe() : (r.json || {})) || {};
    return { ok: !!(r.ok && j.ok), status: r.status || 0, ...j };
  }
  const st = await svcRequest(base, "POST", "/characters/import-session", { size: total, name: file.name || "import.zip", target, contentType: ctype }, { timeoutMs: 60000 });
  const sj = (st.jsonSafe ? st.jsonSafe() : (st.json || {})) || {};
  if (!st.ok || !sj.ok || !sj.session) return { ok: false, name: "", message: "无法创建上传会话: " + (sj.message || String(st.status || "")) };
  const sid = sj.session;
  let sent = 0;
  while (sent < total) {
    const end = Math.min(sent + CH, total);
    const chunk = bytes.subarray(sent, end);
    let bin = ""; const C2 = 0x8000;
    for (let k = 0; k < chunk.length; k += C2) bin += String.fromCharCode.apply(null, chunk.subarray(k, Math.min(k + C2, chunk.length)));
    const cb64 = btoa(bin);
    const r = await svcRequest(base, "POST", "/characters/import-chunk?session=" + sid, null, { b64Body: cb64, contentType: "application/octet-stream", timeoutMs: 180000 });
    if (!r.ok) {
      try { await svcRequest(base, "POST", "/characters/import-abort?session=" + sid, { session: sid }, { timeoutMs: 30000 }); } catch (e) { /* noop */ }
      const cj = (r.jsonSafe ? r.jsonSafe() : (r.json || {})) || {};
      return { ok: false, name: "", message: "分片上传失败(第" + Math.round(sent / CH + 1) + "片): " + (cj.message || String(r.status || "")) };
    }
    sent = end;
    if (onProgress) { try { onProgress(Math.min(0.9, sent / total)); } catch (e) { /* noop */ } }
    await new Promise((r2) => setTimeout(r2, 0));
  }
  const fr = await svcRequest(base, "POST", "/characters/import-finish?session=" + sid, { session: sid }, { timeoutMs: 300000 });
  const fj = (fr.jsonSafe ? fr.jsonSafe() : (fr.json || {})) || {};
  if (!fr.ok || !fj.ok) return { ok: false, name: "", message: "合并导入失败: " + (fj.message || String(fr.status || "")) };
  if (onProgress) { try { onProgress(1); } catch (e) { /* noop */ } }
  return { ok: true, status: fr.status || 0, ...fj };
}

export class PlaybackQueue {
  constructor({ onState = null } = {}) {
    this.items = [];
    this.current = null;
    this.playing = false;
    this._id = 0;
    this.onState = onState;
  }

  get busy() {
    return this.playing || this.items.length > 0;
  }

  enqueue(item) {
    item._id = ++this._id;
    this.items.push(item);
    this._process();
    this._emit();
  }

  /** 打断模式: 清空队列并立即播放新条目 */
  interrupt(item) {
    this.stop();
    this.enqueue(item);
  }

  stop() {
    this.items.length = 0;
    if (this.current) {
      try { this.current.abort && this.current.abort(); } catch (e) { /* noop */ }
      this.current = null;
    }
    if (this.onState) this.onState(false);
  }

  _emit() {
    if (this.onState) this.onState(this.busy);
  }

  async _process() {
    if (this.playing) return;
    this.playing = true;
    while (this.items.length) {
      const item = this.items.shift();
      this.current = item;
      try {
        await item.play();
      } catch (err) {
        console.error("[gpt-sovits-tts] 播放出错:", err);
      } finally {
        this.current = null;
        if (item.cleanup) {
          try { item.cleanup(); } catch (e) { /* noop */ }
        }
      }
    }
    this.playing = false;
    this._emit();
  }
}

/* ---------- 普通音频播放(返回 Promise, 播完或失败即 resolve) ----------
 * 优先走 Foundry 音频通道(game.audio.play, 不绑 interface 通道 → 不受"界面音效"开关影响, 玩家一定听得到);
 * Foundry 播放失败(data URI 等)或环境缺失时退回原生 Audio。 */
export function audioPlay(src, { volume = 1, onStart = null, push = true } = {}) {
  // 去重: 本端已播过的 src(规范化键, 覆盖官方广播/本地播放/flags 兜底各通道) → 跳过(根治双播)
  try {
    if (hasPlayedSrc(src)) return Promise.resolve();
  } catch (e) { /* noop */ }
  // GM 全局静音: main.js 维护 window.__fvttTTSMutedFlag — 静音时所有播放路径(本地/广播/重听/预加载/flags)统一跳过(返回已解决 Promise)
  try { if (window.__fvttTTSMutedFlag === true) return Promise.resolve(); } catch (e) { /* noop */ }
  // 播放计数(速度测试/重复播放回归用): 每次真实播放 +1(静音时不计)
  try { window.__fvttTTSPlayCount = (window.__fvttTTSPlayCount || 0) + 1; } catch (e) { /* noop */ }
  // 记录本端已播 src(规范化键, 防 audioData 兜底/官方广播后 flags 写回重复; 30s 过期)
  markPlayedSrc(src);
  const vol = Math.min(1, Math.max(0, Number(volume) || 0));
  // 单通道原则: 播放统一走 Foundry 内置语音通道(AudioHelper) — 本地播放 + push(默认 true) 时
  // Foundry 官方 socket 广播 playAudio → 所有客户端几乎同时经同一通道播放("主持人听到时玩家也能听到")。
  // 仅当 src 超大(>~700KB data URI, 超 socket 1MB 包)或 HTTP URL(pl 端 frp 证书不可信)时强制不广播,
  // pl 端仍经聊天 flags.audioData(Foundry 内置聊天数据通道)在收到消息后走同一 AudioHelper 播放。
  try {
    const _s = String(src || "");
    if (push && ((_s.startsWith("data:") && _s.length > 700000) || /^https?:\/\//i.test(_s))) push = false;
    // 🔬 测试开关(1.5.0): 广播阻断模拟 — 强制不 push(验证 flags 写回兜底通道)
    if (push && window.__fvttTTSBlockBroadcast === true) push = false;
  } catch (e) { /* noop */ }
  return new Promise((resolve) => {
    let settled = false;
    let iv = null;
    const done = () => {
      if (settled) return;
      settled = true;
      if (iv) { clearInterval(iv); iv = null; }
      resolve();
    };
    const srcs = String(src || "");
    const volS = Math.max(0, Math.min(1, vol));
    // 原生 Audio(Audio 元素, 无自动播放策略约束下可用) — data URI / blob URL 一定可播, 且无 Foundry Sound 加载失败/证书问题
    const nativePlay = () => {
      try {
        try { window.__fvttTTSPlayImpl = "native"; window.__fvttTTSCnt = window.__fvttTTSCnt || { official: 0, native: 0 }; window.__fvttTTSCnt.native++; } catch (e) { /* noop */ }
        const audio = new Audio(srcs);
        if (!audio) { done(); return; }
        audio.volume = volS;
        let settledN = false;
        let ivN = null;
        const doneN = () => { if (settledN) return; settledN = true; if (ivN) { clearInterval(ivN); ivN = null; } done(); };
        audio.addEventListener("ended", doneN);
        audio.addEventListener("error", doneN);
        try { audio.play().then(() => { try { if (onStart) onStart(); } catch (e) { /* noop */ } }).catch(doneN); } catch (e) { doneN(); }
        ivN = setTimeout(doneN, 60000);
      } catch (e) { done(); }
    };
    // 播放实现: 一律先走 Foundry 官方界面通道(AudioHelper, channel:"interface") —
    // ① 音量跟随"界面音量"滑块(interface GainNode 实时级联, 含正在播放的) ② Sound 支持 data: URI 与同源 URL
    // 官方不可用/加载失败才退回原生 Audio(至少有声, 兜底不丢声音)。
    try {
      const AH = (typeof foundry !== "undefined" && foundry.audio && foundry.audio.AudioHelper)
        || (typeof AudioHelper !== "undefined" ? AudioHelper : null);
      if (AH && typeof AH.play === "function") {
        try { window.__fvttTTSPlayImpl = "official"; window.__fvttTTSCnt = window.__fvttTTSCnt || { official: 0, native: 0 }; window.__fvttTTSCnt.official++; } catch (e) { /* noop */ }
        const opts = { src: srcs, volume: volS, autoplay: true, loop: false, channel: "interface" };
        const ret = AH.play(opts, !!push);
        if (ret && typeof ret.then === "function") {
          ret.then(
            () => { try { window.__fvttTTSPlayImpl = "official"; window.__fvttTTSPlayErr = ""; } catch (e) { /* noop */ } try { if (onStart) onStart(); } catch (e) { /* noop */ } setTimeout(done, 1500); },
            (reason) => { try { window.__fvttTTSCnt.native++; window.__fvttTTSPlayImpl = "native"; window.__fvttTTSPlayErr = String((reason && reason.message) || reason || "official-fail").slice(0, 200); } catch (e) { /* noop */ } nativePlay(); }
          );
          return;
        }
        try { if (onStart) onStart(); } catch (e) { /* noop */ }
        setTimeout(done, 1500);
        return;
      }
    } catch (e) { /* fallthrough */ }
    nativePlay();
  });
}

/* ---------- 浏览器系统语音 (WebSpeech) ---------- */
export function webSpeechSpeak(text, { lang = "zh", rate = 1, volume = 1 } = {}) {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window)) { resolve(); return; }
    const u = new SpeechSynthesisUtterance(String(text));
    u.lang = webSpeechLang(lang);
    u.rate = Math.min(2, Math.max(0.5, Number(rate) || 1));
    u.volume = Math.min(1, Math.max(0, Number(volume) || 1));
    u.pitch = 1;
    const voice = pickVoice(u.lang);
    if (voice) u.voice = voice;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    u.onend = done;
    u.onerror = done;
    speechSynthesis.speak(u);
  });
}

export function webSpeechLang(lang) {
  const map = {
    zh: "zh-CN", ja: "ja-JP", en: "en-US", ko: "ko-KR", yue: "zh-HK", auto: "zh-CN"
  };
  return map[lang] || lang || "zh-CN";
}

function pickVoice(lang) {
  try {
    const voices = window.speechSynthesis ? speechSynthesis.getVoices() : [];
    if (!voices.length) return null;
    const prefix = lang.split("-")[0];
    return voices.find(v => v.lang && v.lang.startsWith(prefix))
      || voices.find(v => v.lang && v.lang.toLowerCase() === lang.toLowerCase())
      || null;
  } catch (e) { return null; }
}

/* ---------- GPT-SoVITS 服务端合成 ---------- */
// 返回 { url(blob URL), audioUrl(服务端缓存文件相对路径, 空=无), blob(仅 asBlob=true 时) }
/* ---------- module 事件(GM 委托, Foundry v13 官方 socket:true 中继) ----------
 * v13 无服务端脚本(socket-server.js 约定已移除)。module.json "socket": true →
 * 服务器把 "module.gpt-sovits-tts" 事件中继到其他客户端(不含发送者)。
 * 玩家端用 moduleEmit 发起(附 __rid), GM 端(gm-proxy.js)执行后 emit 回传 __type 响应,
 * 各端按 __rid 匹配 resolve; 无响应 → 超时 resolve null → 调用方退回直连。 */
const _moduleReqs = new Map();
export function moduleEmit(type, payload = {}, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    try {
      if (typeof game === "undefined" || !game || !game.socket || typeof game.socket.emit !== "function") { resolve(null); return; }
      const rid = "r" + Date.now() + "_" + Math.floor(Math.random() * 1e6);
      const timer = setTimeout(() => { try { _moduleReqs.delete(rid); } catch (e) { /* noop */ } resolve(null); }, timeoutMs);
      _moduleReqs.set(rid, { resolve, timer });
      game.socket.emit("module." + "gpt-sovits-tts", Object.assign({ __type: type, __rid: rid }, payload || {}));
    } catch (e) { resolve(null); }
  });
}
// 各端监听 module 事件: GM 端由 gm-proxy 处理请求; 本端匹配响应
export function installModuleSocket() {
  try {
    if (typeof game === "undefined" || !game || !game.socket || typeof game.socket.on !== "function") return;
    game.socket.on("module." + "gpt-sovits-tts", (data) => {
      try {
        if (!data || typeof data !== "object") return;
        if (typeof data.__type === "string" && data.__type.indexOf("-resp") > 0 && data.__rid) {
          const e = _moduleReqs.get(data.__rid);
          if (e) { clearTimeout(e.timer); _moduleReqs.delete(data.__rid); e.resolve(data.result || null); }
        }
      } catch (e) { /* noop */ }
    });
  } catch (e) { /* noop */ }
}

/* ---------- 服务端合成代理(多设备根治): 任意端经 module 事件 → GM 端 → 引擎 ---------- */
export async function gptSovitsSocketProxy(payload, { engine = "gpt", timeoutMs = 150000, binary = false } = {}) {
  // module 事件请求 GM 端执行(玩家端; GM 端自己发起 → 广播不含自己收不到 → 短超时退直连, 本机引擎直接可达)
  // payload 两种形态统一: svcRequest 传 {method,path,json,...} 包装; gptSovitsSynth 传裸合成参数 → 包装成 POST /tts
  try {
    const hasWrap = !!(payload && payload.path);
    const req = hasWrap ? payload : Object.assign({}, { method: "POST", path: "/tts", json: payload });
    if (binary && !hasWrap) req.binary = true;   // 合成音频二进制经 base64 回传(gm-proxy binary 分支返回 b64)
    const gmSelf = !!(game && game.user && game.user.isGM);
    const r = await moduleEmit("tts-proxy", Object.assign({}, req, { engine, user: (() => { try { return (game.user && game.user.name) || ""; } catch (e) { return ""; } })() }, { timeoutMs: gmSelf ? 3000 : timeoutMs }), { timeoutMs: gmSelf ? 3000 : timeoutMs });
    if (r && typeof r === "object") return r;
  } catch (e) { /* fallthrough → 直连 */ }
  return null;
}

export async function gptSovitsSynth(text, lang, { serverUrl, speedFactor = 1, overrides = null, mediaType = "wav", asBlob = false, role = "", skipDirect = false } = {}) {
  const base = String(serverUrl || "http://127.0.0.1:9880").replace(/\/+$/, "");
  // socket 代理 payload: 直接用引擎 TTS_Request 字段名(text_lang/speed_factor/media_type), 避免未知字段被忽略→缺参
  const payload = {
    text: String(text),
    text_lang: lang,
    speed_factor: speedFactor,
    media_type: mediaType,
    role: String(role || ""),
    ...(overrides ? {
      ...(overrides.refAudioPath ? { ref_audio_path: overrides.refAudioPath } : {}),
      ...(overrides.promptText ? { prompt_text: overrides.promptText } : {}),
      ...(overrides.promptLang ? { prompt_lang: overrides.promptLang } : {}),
      ...(overrides.auxRefAudioPaths && overrides.auxRefAudioPaths.length ? { aux_ref_audio_paths: overrides.auxRefAudioPaths } : {}),
      ...(typeof overrides.emotionMix === "number" ? { emotion_mix: overrides.emotionMix } : {}),
      ...(overrides.emotion ? { emotion: overrides.emotion } : {}),
      ...(overrides.textSplitMethod ? { text_split_method: overrides.textSplitMethod } : {}),
      ...(typeof overrides.fragmentInterval === "number" ? { fragment_interval: overrides.fragmentInterval } : {})
    } : {})
  };
  // 服务端合成代理优先(socket 回传 base64): 任意端(远程 GM/玩家)都走服务器本机 9881, 无 Mixed Content/证书/拓扑差异;
  // 代理不可用(旧版 Foundry/服务未注册/超时)时退回直连(本地设备仍有声)
  let proxyFail = "";
  try {
    const pr = await gptSovitsSocketProxy(payload, { engine: "gpt", timeoutMs: 150000, binary: true });
    if (pr && pr.ok && (pr.b64 || pr.audioUrl)) {
      // binary 代理(1.6.2): gm-proxy binary 分支回传 base64 → data URI → Blob; audioUrl 兜底(同源 /modules/... 可直接 fetch)
      if (pr.b64) {
        const mime = mediaType === "mp3" ? "audio/mpeg" : "audio/wav";
        const dataUri = `data:${mime};base64,${pr.b64}`;
        if (asBlob) {
          try {
            const r2 = await fetch(dataUri);   // data URI → Blob(浏览器本地, 无网络)
            const blob = await r2.blob();
            return { blob, audioUrl: pr.audioUrl || "" };
          } catch (e) { /* fallthrough → 直接返回 data URI 形式的 URL */ }
          return { blob: null, audioUrl: pr.audioUrl || "", dataUri };
        }
        return { url: pr.audioUrl && !overrides ? pr.audioUrl : dataUri, audioUrl: pr.audioUrl || "", dataUri };
      }
      // audioUrl 兜底(旧 GM 端/无 b64 返回): 相对 /modules/... 或 /data/... 拼页面同源(https 玩家可 fetch), 其余原样
      const au = pr.audioUrl || "";
      const auAbs = au && !/^https?:\/\//i.test(au) ? ((au.startsWith("/modules/") || au.startsWith("/data/")) ? new URL(au, window.location.origin).href : au) : au;
      if (asBlob) {
        try {
          const r2 = await fetch(auAbs, { signal: AbortSignal.timeout(15000) });
          const blob = await r2.blob();
          return { blob, audioUrl: au };
        } catch (e) { return { blob: null, audioUrl: au, dataUri: "" }; }
      }
      return { url: auAbs, audioUrl: au, dataUri: "" };
    } else if (pr && !pr.ok) {
      // 引擎/转发返回失败(400/500/超时): 提取详情供上层报告定位(合成路径失败是核心问题, 不再吞成通用"代理不可用")
      try {
        proxyFail = String((pr.text || (pr.json && (pr.json.message || pr.json.Exception || pr.json.detail)) || "")).slice(0, 300) || ("status=" + String(pr.status || ""));
      } catch (e) { /* noop */ }
    }
  } catch (e) { /* 代理失败 → 直连 */ proxyFail = String((e && e.message) || e).slice(0, 300); }
  // 代理模式玩家(skipDirect=true): 代理失败直接报清晰错误, 不直连 — 直连必失败(https Mixed-Content / 本机无引擎 fetch status 0 → "http0")
  if (skipDirect) {
    const pErr = new Error("代理合成不可用(" + (proxyFail || "主机 TTS 代理未响应") + "), 请确认主机在线后重试");
    pErr.proxyUnavailable = true;
    throw pErr;
  }
  // https 页面(远程 GM/frp)直连 http://9881 必被 Mixed Content 阻止: 直接短路, 交给上层转交/报错, 不再发注定失败的请求
  if (typeof location !== "undefined" && location.protocol === "https:" && !/^https:\/\//i.test(base)) {
    const mcErr = new Error("Mixed-Content: https 页面不可直连 http TTS 服务, 请确保 socket 代理(tts-proxy)可用");
    mcErr.mixedContent = true;
    throw mcErr;
  }
  const ctrl2 = new AbortController();
  const timer2 = setTimeout(() => ctrl2.abort(), 120000);
  try {
    const serverPayload = {
      text: String(text),
      text_lang: lang,
      speed_factor: speedFactor,
      streaming_mode: false,
      media_type: mediaType,
      allow_short_ref: true
    };
    if (role) serverPayload.role = String(role);
    if (overrides) {
      if (overrides.refAudioPath) serverPayload.ref_audio_path = overrides.refAudioPath;
      if (overrides.promptText) serverPayload.prompt_text = overrides.promptText;
      if (overrides.promptLang) serverPayload.prompt_lang = overrides.promptLang;
      if (overrides.auxRefAudioPaths && overrides.auxRefAudioPaths.length) serverPayload.aux_ref_audio_paths = overrides.auxRefAudioPaths;
      if (typeof overrides.emotionMix === "number") serverPayload.emotion_mix = overrides.emotionMix;
      if (overrides.emotion) serverPayload.emotion = overrides.emotion;
      if (overrides.textSplitMethod) serverPayload.text_split_method = overrides.textSplitMethod;
      if (typeof overrides.fragmentInterval === "number") serverPayload.fragment_interval = overrides.fragmentInterval;
    }
    const resp = await fetch(base + "/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(serverPayload),
      signal: ctrl2.signal
    });
    if (!resp.ok) {
      let detail = "";
      try { detail = (await resp.text()).slice(0, 300); } catch (e) { /* noop */ }
      throw new Error(`TTS 服务返回 ${resp.status}: ${detail}`);
    }
    const blob = await resp.blob();
    let audioUrl = "";
    try { audioUrl = resp.headers.get("X-Fvtt-Audio-Url") || resp.headers.get("X-Audio-Url") || ""; } catch (e) { /* noop */ }
    // 服务端返回相对路径 → 拼完整 URL: /modules/... = Foundry 静态(拼页面 origin, pl 端必达); /audio/... = TTS 服务(拼 serverUrl)
    if (audioUrl && !/^https?:\/\//i.test(audioUrl)) {
      try {
        if (audioUrl.startsWith("/modules/") || audioUrl.startsWith("/data/")) audioUrl = new URL(audioUrl, window.location.origin).href;
        else audioUrl = new URL(audioUrl, serverUrl).href;
      } catch (e) { /* noop */ }
    }
    if (asBlob) return { blob, audioUrl };
    return { url: URL.createObjectURL(blob), audioUrl };
  } finally {
    clearTimeout(timer2);
  }
}

/** Edge-TTS 在线合成(多引擎并行): 服务器转发微软在线音色, 负载极低 — 返回结构与 gptSovitsSynth 一致(blob + X-Fvtt 音频路径) */
export async function synthEdge(text, lang, { serverUrl, speedFactor = 1, voice = "", asBlob = false } = {}) {
  const base = String(serverUrl || "http://127.0.0.1:9881").replace(/\/+$/, "");
  // 服务端代理优先(Edge 也走服务器本机 9881, 远程端无 Mixed Content/证书问题)
  try {
    const pr = await gptSovitsSocketProxy({ text: String(text), lang, speedFactor, voice }, { engine: "edge", timeoutMs: 40000 });
    if (pr && pr.ok && pr.b64) {
      const dataUri = `data:audio/mpeg;base64,${pr.b64}`;
      if (asBlob) { try { const r2 = await fetch(dataUri); return { blob: await r2.blob(), audioUrl: pr.audioUrl || "" }; } catch (e) { /* fallthrough */ } }
      return { audioUrl: pr.audioUrl || "", url: dataUri, dataUri };
    }
  } catch (e) { /* 代理失败 → 直连 */ }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const resp = await fetch(base + "/tts/edge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: String(text), lang, speed: Number(speedFactor) || 0, voice: String(voice || "") }),
      signal: ctrl.signal
    });
    if (!resp.ok) {
      let detail = "";
      try { detail = (await resp.text()).slice(0, 300); } catch (e) { /* noop */ }
      throw new Error(`Edge-TTS 服务返回 ${resp.status}: ${detail}`);
    }
    const blob = await resp.blob();
    let audioUrl = "";
    try { audioUrl = resp.headers.get("X-Fvtt-Audio-Url") || resp.headers.get("X-Audio-Url") || ""; } catch (e) { /* noop */ }
    if (audioUrl && !/^https?:\/\//i.test(audioUrl)) {
      try {
        if (audioUrl.startsWith("/modules/") || audioUrl.startsWith("/data/")) audioUrl = new URL(audioUrl, window.location.origin).href;
        else audioUrl = new URL(audioUrl, serverUrl).href;
      } catch (e) { /* noop */ }
    }
    if (asBlob) return { blob, audioUrl };
    return { url: URL.createObjectURL(blob), audioUrl };
  } finally {
    clearTimeout(timer);
  }
}

/** 探测服务端状态 */
export async function gptSovitsStatus(serverUrl) {
  const base = String(serverUrl || "http://127.0.0.1:9880").replace(/\/+$/, "");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const resp = await fetch(base + "/status", { signal: ctrl.signal });
    if (!resp.ok) return { ok: false };
    const data = await resp.json();
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e };
  } finally {
    clearTimeout(timer);
  }
}

/** 通用 TTS 服务请求(socket 代理优先 → 直连回退): https 页面(GM/玩家经 frp)Mixed Content 根治。
 *  base=serverUrl(可带协议), method=GET|POST, path="/characters" 等, bodyJSON 可选。
 *  返回 { ok, status, json, direct } — direct=false 表示走了 socket 代理, true 表示直连。 */
export async function svcRequest(base, method, path, bodyJSON, { timeoutMs = 30000, binary = false, b64Body = "", contentType = "" } = {}) {
  const b = String(base || "http://127.0.0.1:9881").replace(/\/+$/, "");
  // 1) socket 代理(服务端转发, 浏览器无 Mixed Content 问题; 二进制经 base64 传输)
  const pr = await gptSovitsSocketProxy({
    method: String(method || "GET").toUpperCase(),
    path: String(path),
    json: (b64Body ? null : (bodyJSON === undefined ? null : bodyJSON)),
    b64Body: b64Body || undefined,
    contentType: contentType || undefined,
    binary: binary ? true : undefined,
    timeoutMs
  }, { engine: "http", timeoutMs });
  if (pr && pr.ok && typeof pr.status === "number") {
    if (binary && pr.b64) {
      try {
        const bin = atob(pr.b64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        const blob = new Blob([arr], { type: pr.mime || "application/octet-stream" });
        return { ok: true, status: pr.status || 200, _json: null, blob, audioUrl: pr.audioUrl || "", cache: "miss", direct: false, json: () => Promise.resolve(null), jsonSafe: () => null, text: () => Promise.resolve("") };
      } catch (e) { return { ok: false, status: 0, error: e, direct: false, json: () => Promise.resolve(null), jsonSafe: () => null, text: () => Promise.resolve("") }; }
    }
    const _j0 = pr.json || null;
    return { ok: true, status: pr.status || 200, _json: _j0, audioUrl: pr.audioUrl || "", cache: pr.cache || "miss", direct: false, json: () => Promise.resolve(_j0), jsonSafe: () => _j0, text: () => Promise.resolve(JSON.stringify(_j0 || {})) };
  }
  // 2) 直连回退(仅 http 页面/本机场景可用; https 页面直接抛错由调用方处理)
  if (typeof location !== "undefined" && location.protocol === "https:" && !/^https:\/\//i.test(b)) {
    const mcErr = new Error("Mixed-Content: https 页面不可直连 http TTS(" + path + ")");
    mcErr.mixedContent = true;
    return { ok: false, status: 0, error: mcErr, direct: true, json: () => Promise.resolve(null), jsonSafe: () => null, text: () => Promise.resolve("") };
  }
  try {
    const hdrs = { "Content-Type": contentType || "application/json" };
    let reqBody = undefined;
    if (b64Body) {
      const bin = atob(b64Body);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      reqBody = arr;
    } else if (method !== "GET" && bodyJSON !== undefined) {
      reqBody = JSON.stringify(bodyJSON);
    }
    // 1.6.44 瞬时连接失败重试(ERR_CONNECTION_CLOSED/网络抖动): 最多3次, 间隔0.8s/2s, 3次仍败才 console 诊断
    let lastErr = null;
    for (let _try = 0; _try < 3; _try++) {
      if (_try > 0) { try { await new Promise(r => setTimeout(r, _try === 1 ? 800 : 2000)); } catch (e) { /* noop */ } }
      try {
        const r = await fetch(b + path, { method: String(method || "GET").toUpperCase(), headers: hdrs, body: reqBody, signal: AbortSignal.timeout(timeoutMs) });
        if (binary) {
          const blob = await r.blob();
          return { ok: r.ok, status: r.status, _json: null, blob, audioUrl: String(r.headers.get("X-Fvtt-Audio-Url") || r.headers.get("X-Audio-Url") || "").trim(), cache: "miss", direct: true, json: () => Promise.resolve(null), jsonSafe: () => null, text: () => Promise.resolve("") };
        }
        const txt = await r.text();
        let json = null;
        try { json = JSON.parse(txt); } catch (e) { /* noop */ }
        const _audioUrl = String(r.headers.get("X-Fvtt-Audio-Url") || r.headers.get("X-Audio-Url") || "").trim();
        const _cache = String(r.headers.get("X-Fvtt-Cache") || "miss").trim();
        return { ok: r.ok, status: r.status, _json: json, audioUrl: _audioUrl, cache: _cache, direct: true, json: () => Promise.resolve(json), jsonSafe: () => json, text: () => Promise.resolve(txt) };
      } catch (e) {
        lastErr = e;
        if (_try === 2) {
          try { console.warn("[gpt-sovits-tts] 直连TTS失败(重试3次仍败): " + (b + path) + " err=" + String((e && e.message) || e).slice(0, 120)); } catch (e2) { /* noop */ }
        }
      }
    }
    throw lastErr;
  } catch (e) {
    return { ok: false, status: 0, error: e, direct: true, json: () => Promise.resolve(null), jsonSafe: () => null, text: () => Promise.resolve("") };
  }
}
