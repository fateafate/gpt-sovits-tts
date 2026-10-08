// ============================================================
// gpt-sovits-tts — Foundry 服务端脚本(v13: scripts 在 Node 端执行)
// 服务端合成代理: 任意客户端(GM 本地/远程、玩家)经 Foundry socket 把合成请求
// 转发到服务器本机 9881 — 与浏览器拓扑无关, 无 Mixed Content / 证书 / 本地 vs 远程差异。
// 注册 socket: "gpt-sovits-tts.tts-proxy" (v13 register API)
// ============================================================
const MODULE_ID = "gpt-sovits-tts";
const SERVER_TTS = "http://127.0.0.1:9881";

// Node 文件系统(v13 scripts 在 Node 端) — 供"音频落盘到 FVTT 主机模块目录"(市场级: 引擎机≠FVTT 机时,
// 各端从 FVTT 主机同源拉取同一音频文件; 否则文件在引擎机, FVTT 主机 404 → 玩家听不到)。
const _fs = (() => { try { return require("fs"); } catch (e) { return null; } })();
const _pathM = (() => { try { return require("path"); } catch (e) { return null; } })();
function writeAudioExport(fname, buf) {
  try {
    if (_fs && _pathM) {
      const mod = game.modules.get(MODULE_ID);
      const dir = (mod && mod.path) ? _pathM.join(mod.path, "engine", "audio_export") : null;
      if (dir) { _fs.mkdirSync(dir, { recursive: true }); _fs.writeFileSync(_pathM.join(dir, fname), buf); return true; }
    }
    if (game.fs && typeof game.fs.writeFile === "function") {
      game.fs.writeFile(`modules/${MODULE_ID}/engine/audio_export/${fname}`, buf);
      return true;
    }
  } catch (e) { /* noop */ }
  return false;
}
// 服务端代写 flags(玩家 speak 合成成功但无权限写回时, 由 Foundry 服务端写 ChatMessage → 文档更新广播全员 →
// 各端 updateChatMessage 官方通道播放。服务端恒有写入权, 与 GM 在线与否无关 — 根治"只有发言人听到")。
async function ttsMetaHandler(data) {
  const d = data || {};
  const msgId = String(d.messageId || "");
  if (!msgId) return { ok: false, err: "no messageId" };
  try {
    const msg = game.messages.get(msgId);
    if (!msg) return { ok: false, err: "msg not found" };
    const upd = {};
    if (d.audioData && String(d.audioData).length > 20 && String(d.audioData).length < 400000) upd["flags." + MODULE_ID + ".audioData"] = String(d.audioData);
    if (d.audioUrl && typeof d.audioUrl === "string" && d.audioUrl) upd["flags." + MODULE_ID + ".audioUrl"] = String(d.audioUrl);
    if (!Object.keys(upd).length) return { ok: false, err: "empty flags" };
    await msg.update(upd);
    return { ok: true };
  } catch (e) {
    return { ok: false, err: String((e && e.message) || e).slice(0, 200) };
  }
}

// 代理转发目标(语音运行者 = 谁生成语音, 与 Foundry 所在机器解耦 — 市场级: 多人用别的电脑跑 FVTT, 引擎只装一台机器):
//  ① 世界设置 voiceRunnerMap(GM 指定"谁的语音由哪个玩家(pl)的电脑生成", 服务端自动取该玩家在线 IP:9881) — 压力分摊到各 pl 电脑
//  ② 世界设置 voiceServerUrl(引擎机器可达地址) — 未分配用户的默认引擎机
//  ③ 默认 Foundry 主机本机 9881(引擎与 Foundry 同机的开箱场景)
// 仅接受 http/https(防 SSRF); 浏览器永不直连引擎 — 全部经这里服务端转发(无 Mixed Content/证书/跨机差异)。
// "由谁生成"= 指定某位玩家 → 服务端查该玩家当前连接 IP(Foundry users.connections) → http://<ip>:9881
function voiceRunnerFor(d) {
  const uname = String((d && d.user) || "").trim();
  if (!uname) return "";
  let map = "";
  try { map = String(game.settings.get(MODULE_ID, "voiceRunnerMap") || ""); } catch (e) { return ""; }
  for (const ln of String(map).split(/\r?\n/)) {
    const eq = ln.indexOf("=");
    if (eq < 0) continue;
    if (String(ln.slice(0, eq)).trim() === uname) {
      const who = String(ln.slice(eq + 1)).trim();
      if (!who) return "";
      try {
        const u = (game.users && (game.users.find(x => x.name === who) || game.users.get(who))) || null;
        const conn = (u && Array.isArray(u.connections) && u.connections[0]) || null;
        const ip = String((conn && conn.address) || "").trim();
        if (/^[\d.:]+$/.test(ip) && ip.includes(".")) return `http://${ip}:9881`;
      } catch (e) { /* noop */ }
      return "";
    }
  }
  return "";
}
function ttsBase(d) {
  const byUser = voiceRunnerFor(d);
  let fromSetting = "";
  try { fromSetting = String(game.settings.get(MODULE_ID, "voiceServerUrl") || "").trim(); } catch (e) { /* 设置未注册/读不到 */ }
  const raw = byUser || fromSetting || SERVER_TTS;
  if (/^https?:\/\/[^/\s]+/i.test(raw)) return raw.replace(/\/+$/, "");
  return SERVER_TTS;
}

async function ttsProxyHandler(data) {
  const d = data || {};
  const engine = String(d.engine || "gpt");   // "gpt" | "edge" | "http"
  // ---- 通用 HTTP 转发(https 页面 Mixed Content 根治): /status /config /characters /voices 及操作全走这里 ----
  if (engine === "http") {
    const ctrl2 = new AbortController();
    const timer2 = setTimeout(() => ctrl2.abort(), Math.min(Number(d.timeoutMs) || 30000, 120000));
    try {
      const method = String(d.method || "GET").toUpperCase();
      const path = String(d.path || "/status");
      const hasB64Body = (typeof d.b64Body === "string" && d.b64Body);
      const resp = await fetch(ttsBase(d) + path, {
        method,
        headers: hasB64Body ? { "Content-Type": String(d.contentType || "application/octet-stream") } : { "Content-Type": "application/json" },
        body: hasB64Body
          ? Buffer.from(d.b64Body, "base64")
          : (method !== "GET" && d.json !== undefined) ? JSON.stringify(d.json) : undefined,
        signal: ctrl2.signal
      });
      if (d.binary) {
        const ab = await resp.arrayBuffer();
        return {
          ok: resp.ok,
          status: resp.status,
          b64: Buffer.from(ab).toString("base64"),
          mime: String(resp.headers.get("content-type") || "application/octet-stream").split(";")[0].trim(),
          audioUrl: String(resp.headers.get("X-Fvtt-Audio-Url") || resp.headers.get("X-Audio-Url") || "").trim()
        };
      }
      const text = await resp.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) { /* noop */ }
      return {
        ok: resp.ok,
        status: resp.status,
        json,
        text: text.slice(0, 2000),
        audioUrl: String(resp.headers.get("X-Fvtt-Audio-Url") || resp.headers.get("X-Audio-Url") || "").trim(),
        cache: String(resp.headers.get("X-Fvtt-Cache") || "miss").trim()
      };
    } catch (e) {
      return { ok: false, status: 0, err: String((e && e.message) || e || "proxy error").slice(0, 200) };
    } finally {
      clearTimeout(timer2);
    }
  }
  const payload = {};
  let path = "/tts";
  if (engine === "edge") {
    path = "/tts/edge";
    payload.text = String(d.text || "");
    payload.lang = String(d.lang || "auto");
    payload.speed = Number(d.speedFactor) || 0;
    payload.voice = String(d.voice || "");
  } else {
    payload.text = String(d.text || "");
    payload.text_lang = String(d.lang || "auto");
    payload.speed_factor = Number(d.speedFactor) || 1.0;
    payload.streaming_mode = false;
    payload.media_type = String(d.mediaType || "mp3");
    payload.allow_short_ref = true;
    if (d.role) payload.role = String(d.role);
    if (d.overrides) {
      const o = d.overrides;
      if (o.refAudioPath) payload.ref_audio_path = o.refAudioPath;
      if (o.promptText) payload.prompt_text = o.promptText;
      if (o.promptLang) payload.prompt_lang = o.promptLang;
      if (o.auxRefAudioPaths && o.auxRefAudioPaths.length) payload.aux_ref_audio_paths = o.auxRefAudioPaths;
      if (typeof o.emotionMix === "number") payload.emotion_mix = o.emotionMix;
      if (o.textSplitMethod) payload.text_split_method = o.textSplitMethod;
      if (typeof o.fragmentInterval === "number") payload.fragment_interval = o.fragmentInterval;
    }
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 300000);
  try {
    const t0 = Date.now();
    const resp = await fetch(ttsBase(d) + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });
    if (!resp.ok) {
      let detail = "";
      try { detail = (await resp.text()).slice(0, 300); } catch (e) { /* noop */ }
      return { ok: false, status: resp.status, err: `TTS 服务返回 ${resp.status}: ${detail}` };
    }
    const buf = await resp.arrayBuffer();
    let b64 = "";
    try { b64 = Buffer.from(buf).toString("base64"); } catch (e) { /* noop */ }
    let audioUrl = "";
    try { audioUrl = resp.headers.get("X-Fvtt-Audio-Url") || resp.headers.get("X-Audio-Url") || ""; } catch (e) { /* noop */ }
    // 音频落盘 FVTT 主机(引擎机≠FVTT 机时, 各端从 FVTT 主机同源拉同一文件; 覆盖缓存命中复用同一文件名)
    try {
      const m = String(audioUrl || "").match(/([^/\\]+\.(?:mp3|wav))$/i);
      if (m) writeAudioExport(m[1], buf);
    } catch (e) { /* noop */ }
    return { ok: true, b64, audioUrl, ms: Date.now() - t0, status: 200 };
  } catch (e) {
    const em = String((e && e.message) || e || "proxy error");
    const isConn = em.includes("fetch") && !em.includes("TTS 服务返回");
    return { ok: false, err: isConn ? "代理连接 9881 失败(服务未启动?)" : em.slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}

Hooks.once("init", () => {
  try {
    if (typeof game.socket.register === "function") {
      // Foundry v13 socket v2: 服务端注册, 客户端 emit("gpt-sovits-tts.tts-proxy", data) 拿返回值
      game.socket.register(MODULE_ID, { "tts-proxy": ttsProxyHandler, "tts-metadata": ttsMetaHandler });
    } else if (typeof game.socket.on === "function") {
      // Foundry v12 兼容: 传统 socket 服务端收包(reply 回调)
      game.socket.on(`module.${MODULE_ID}`, async (data, reply) => {
        try {
          if (data && data.__proxyTs && data.__proxyType === "tts-proxy") {
            const r = await ttsProxyHandler(data);
            if (typeof reply === "function") reply(r);
          } else if (data && data.__proxyTs && data.__proxyType === "tts-metadata") {
            const r = await ttsMetaHandler(data);
            if (typeof reply === "function") reply(r);
          }
        } catch (e) { if (typeof reply === "function") reply({ ok: false, err: String(e).slice(0, 200) }); }
      });
    }
  } catch (e) { /* 服务端注册失败: 退化为直连合成 */ }
});