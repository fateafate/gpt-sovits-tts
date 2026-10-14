/* ============================================================================
 * scripts/gm-proxy.js — Foundry v13 "模块级服务端职责"的 GM 端执行器
 *
 * Foundry v13 没有服务端脚本机制(socket-server.js 约定已移除, 实测 socket:true
 * 仅启用 "module.<id>" 事件由服务器中继到其他客户端)。因此原本服务端承担的
 * 合成代理 / 代写 flags / 自测报告落盘, 改为: 玩家端 moduleEmit 请求 → GM 端
 * 客户端执行(本机直连引擎) → 回传结果。GM 是引擎机(本模块场景), 天然可达。
 *
 * module.json 需 "socket": true(启用 module 事件中继)。
 * main.js 在 ready 后调用 installGmProxy() 注册 GM 端监听。
 * ============================================================================ */
const MOD = "gpt-sovits-tts";

function _base() {
  try {
    const s = String(game.settings.get(MOD, "voiceServerUrl") || "").trim();
    if (/^https?:\/\//i.test(s)) return s.replace(/\/+$/, "");
  } catch (e) { /* noop */ }
  return "http://127.0.0.1:9881";
}

function _b64ToArr(b64) {
  const bin = atob(String(b64));
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

/** GM 端执行合成/通用请求(直连引擎, 本机无 Mixed Content) */
async function gmTtsProxy(d) {
  try {
    const method = String(d.method || "POST").toUpperCase();
    const path = String(d.path || "/tts");
    const hasB64 = (typeof d.b64Body === "string" && d.b64Body);
    // 请求体字段标准化(兼容各端 payload 命名): lang→text_lang / speedFactor→speed_factor / mediaType→media_type;
    // 裸合成参数({text,...} 无 method/path/json 包装)兜底: 直接用 d 本身;
    // null/undefined 体 → 空对象(避免 JSON "null" 触发引擎 422)
    let jbody = null;
    try {
      const j0 = (d.json && typeof d.json === "object" && !Array.isArray(d.json)) ? d.json
        : (d.text !== undefined ? d : {});
      const j = Object.assign({}, j0);
      if (j.lang !== undefined && j.text_lang === undefined) { j.text_lang = j.lang; delete j.lang; }
      if (j.speedFactor !== undefined && j.speed_factor === undefined) { j.speed_factor = j.speedFactor; delete j.speedFactor; }
      if (j.mediaType !== undefined && j.media_type === undefined) { j.media_type = j.mediaType; delete j.mediaType; }
      jbody = JSON.stringify(j);
    } catch (e) { jbody = "{}"; }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.min(Number(d.timeoutMs) || 120000, 120000));
    try {
      const resp = await fetch(_base() + path, {
        method,
        headers: hasB64 ? { "Content-Type": String(d.contentType || "application/octet-stream") } : { "Content-Type": "application/json" },
        body: hasB64 ? _b64ToArr(d.b64Body) : (method !== "GET") ? jbody : undefined,
        signal: ctrl.signal
      });
      if (d.binary) {
        const ab = await resp.arrayBuffer();
        let b64 = "";
        try {
          const arr = new Uint8Array(ab);
          let s = "";
          for (let i = 0; i < arr.length; i += 32768) s += String.fromCharCode.apply(null, arr.subarray(i, i + 32768));
          b64 = btoa(s);
        } catch (e) { /* noop */ }
        return {
          ok: resp.ok,
          status: resp.status,
          b64,
          mime: String(resp.headers.get("content-type") || "application/octet-stream").split(";")[0].trim(),
          audioUrl: String(resp.headers.get("X-Fvtt-Audio-Url") || resp.headers.get("X-Audio-Url") || "").trim()
        };
      }
      const text = await resp.text();
      if (!resp.ok && resp.status >= 400) {
        // 合成路径(/tts)失败是核心问题, 打 warn 附请求体; /llm/* 等辅助功能失败静默(避免每消息刷屏)
        try {
          if (path.indexOf("/llm") !== 0) {
            console.warn("[gm-proxy] " + path + " → " + resp.status + ": " + text.slice(0, 400) + " | reqBody=" + String(jbody || "").slice(0, 300));
          }
        } catch (e) { /* noop */ }
      }
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
    } finally { clearTimeout(timer); }
  } catch (e) {
    return { ok: false, status: 0, err: String((e && e.message) || e || "gm-proxy error").slice(0, 200) };
  }
}

/** GM 端代写 flags(玩家 speak 合成成功但无写回权限时) */
async function gmTtsMeta(d) {
  const msgId = String((d && d.messageId) || "");
  if (!msgId) return;
  try {
    const msg = game.messages.get(msgId);
    if (!msg) return;
    const upd = {};
    if (d.audioData && String(d.audioData).length > 20 && String(d.audioData).length < 400000) upd["flags." + MOD + ".audioData"] = String(d.audioData);
    if (d.audioUrl && typeof d.audioUrl === "string" && d.audioUrl) upd["flags." + MOD + ".audioUrl"] = String(d.audioUrl);
    if (Object.keys(upd).length) await msg.update(upd);
  } catch (e) { /* noop */ }
}

/** GM 端把自测报告 POST 引擎 /speedtest/report → 引擎写 FVTT 主机 server/player_selftest_<user>.json */
async function gmTtsReport(d) {
  try {
    const rep = (d && d.report) || {};
    await fetch(_base() + "/speedtest/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rep),
      signal: AbortSignal.timeout(15000)
    }).catch(() => { /* noop */ });
  } catch (e) { /* noop */ }
}

/** 1.6.75 读"语音生成者分配"(voiceRunnerMap, 世界设置): 该请求的作者被指定给哪个账号的电脑执行。
 *  返回 { name } 或 null(未指定 → 默认引擎机)。语义与分配器一致: 每行 "说话者账号 = 生成者账号"。 */
function runnerTargetFor(d) {
  try {
    const raw = String(game.settings.get(MOD, "voiceRunnerMap") || "");
    if (!raw.trim()) return null;
    const author = String((d && d.user) || "").trim();
    if (!author) return null;
    for (const ln of raw.split(/\r?\n/)) {
      const i = ln.indexOf("=");
      if (i < 0) continue;
      const k = ln.slice(0, i).trim();
      const v = ln.slice(i + 1).trim();
      if (k && k === author) return v ? { name: v } : null;
    }
    return null;
  } catch (e) { return null; }
}

/** 注册 module 事件监听: 合成执行者=按分配指定的电脑(未指定则引擎可达端); 写回/报告=GM 端; 任意端匹配响应 */
export function installGmProxy() {
  try {
    if (typeof game === "undefined" || !game || !game.socket || typeof game.socket.on !== "function") return;
    game.socket.on("module." + MOD, (data) => {
      try {
        if (!data || typeof data !== "object") return;
        const t = String(data.__type || "");
        // 合成代理(tts-proxy): 引擎可达端执行 — GM 或本端 CanDirect=true(引擎机挂任意账号) —
        // 根治"其他设备登录 GM(不在引擎机/服务器)": 引擎机客户端代合成(fetch 127.0.0.1:9881),
        // 远程 GM/玩家只需发起请求; 远程 GM(CanDirect=false)不执行(够不到引擎)
        if (t === "tts-proxy") {
          const canExec = !!(game.user) && (game.user.isGM === true || window.__fvttTTSCanDirect === true);
          if (!canExec) return;
          // 1.6.75 按分配定向(用户诉求: "根据配置决定压力给哪台电脑"):
          //   ① 指定给了别人且那人在线 → 我不抢(压力按其配置, 也避免多台引擎重复劳动)
          //   ② 指定给了别人但那人离线 → 我(=GM/引擎机)兜底执行, 保证不断声
          //   ③ 指定的就是自己 / 未指定 → 我执行
          try {
            const _want = runnerTargetFor(data);
            if (_want && _want.name) {
              const myName = String((game.user && game.user.name) || "");
              const tu = (game.users && typeof game.users.getName === "function") ? game.users.getName(_want.name) : null;
              const targetOnline = !!(tu && tu.active);
              if (_want.name !== myName && targetOnline) return;   // 让给被指定的那台电脑
            }
          } catch (e) { /* noop */ }
          gmTtsProxy(data).then((r) => {
            try {
              game.socket.emit("module." + MOD, {
                __type: "tts-proxy-resp", __rid: String(data.__rid || ""),
                result: Object.assign({}, r || {}, { by: String((game.user && game.user.name) || "") }),   // 1.6.75 告诉发起端"这次由谁的电脑合成"
              });
            } catch (e) { /* noop */ }
          }).catch(() => { /* noop */ });
          return;
        }
        // 写回/报告: 仅 GM(update 消息/写引擎报告需要 GM 权限)
        if (!game.user || !game.user.isGM) return;
        if (t === "tts-metadata") {
          gmTtsMeta(data).catch(() => { /* noop */ });
        } else if (t === "tts-report") {
          gmTtsReport(data).catch(() => { /* noop */ });
        }
      } catch (e) { /* noop */ }
    });
  } catch (e) { /* noop */ }
}
