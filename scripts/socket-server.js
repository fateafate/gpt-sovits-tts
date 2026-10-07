// ============================================================
// gpt-sovits-tts — Foundry 服务端脚本(v13: scripts 在 Node 端执行)
// 服务端合成代理: 任意客户端(GM 本地/远程、玩家)经 Foundry socket 把合成请求
// 转发到服务器本机 9881 — 与浏览器拓扑无关, 无 Mixed Content / 证书 / 本地 vs 远程差异。
// 注册 socket: "gpt-sovits-tts.tts-proxy" (v13 register API)
// ============================================================
const MODULE_ID = "gpt-sovits-tts";
const SERVER_TTS = "http://127.0.0.1:9881";

async function ttsProxyHandler(data) {
  const d = data || {};
  const engine = String(d.engine || "gpt");   // "gpt" | "edge"
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
    const resp = await fetch(SERVER_TTS + path, {
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
      game.socket.register(MODULE_ID, { "tts-proxy": ttsProxyHandler });
    } else if (typeof game.socket.on === "function") {
      // Foundry v12 兼容: 传统 socket 服务端收包(reply 回调)
      game.socket.on(`module.${MODULE_ID}`, async (data, reply) => {
        try {
          if (data && data.__proxyTs && data.__proxyType === "tts-proxy") {
            const r = await ttsProxyHandler(data);
            if (typeof reply === "function") reply(r);
          }
        } catch (e) { if (typeof reply === "function") reply({ ok: false, err: String(e).slice(0, 200) }); }
      });
    }
  } catch (e) { /* 服务端注册失败: 退化为直连合成 */ }
});