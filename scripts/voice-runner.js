/**
 * gpt-sovits-tts — 语音生成者分配器 (Voice Runner Assignment)
 * GM 打开: 列出全部账号(含未登录), 每行"由谁生成"下拉; 玩家只读。
 * 实现: 原生 DOM 浮层(不依赖 Foundry Application 框架, 任何版本必弹窗);
 *       账号列表经 FVTT 服务器通道 tts-users 获取(6s 超时回退在线列表)。
 * 存储: 世界设置 voiceRunnerMap(内部格式: 每行 "用户名 = 用户名"; 空=默认引擎机)。
 */
const MOD = "gpt-sovits-tts";
function l(key, def) {
  try { if (typeof window._L === "function") return window._L(key, def); } catch (e) { /* noop */ }
  return def;
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

export function parseRunnerMap(text) {
  const map = {};
  for (const ln of String(text || "").split(/\r?\n/)) {
    const eq = ln.indexOf("=");
    if (eq < 0) continue;
    const k = String(ln.slice(0, eq)).trim();
    const v = String(ln.slice(eq + 1)).trim();
    if (k) map[k] = v;
  }
  return map;
}
export async function loadRunnerMap() {
  try { return String(game.settings.get(MOD, "voiceRunnerMap") || ""); } catch (e) { return ""; }
}

/** 全量账号: 客户端 game.users 即全量账号集合(含离线用户文档, active 标记在线); v13 无服务端 socket 支持, 直读即可 */
export async function fetchAllUsers() {
  try {
    const us = ((game && game.users && game.users.contents) || []);
    if (!us.length) return [];
    return us.map(u => ({ name: String(u.name || ""), isGM: !!u.isGM, active: !!u.active }));
  } catch (e) { return []; }
}

let _raEl = null;
function closeRa() { try { if (_raEl) { _raEl.remove(); _raEl = null; } } catch (e) { _raEl = null; } }

/** 打开分配器(原生浮层, 必弹窗; 出错在窗口内/console/notify 三处可见) */
export function openRunnerAssign() {
  try {
    closeRa();
    const isGM = !!(game.user && game.user.isGM);
    const wrap = document.createElement("div");
    wrap.className = "fvtt-tts-ra";
    wrap.style.cssText = "position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center";
    wrap.innerHTML = `<div class="fvtt-tts-ra-box" style="background:#2a251f;border:1px solid #6a5f4f;border-radius:8px;width:780px;max-width:94vw;max-height:88vh;display:flex;flex-direction:column;box-shadow:0 10px 34px rgba(0,0,0,.65);overflow:hidden">
      <header style="display:flex;align-items:center;justify-content:space-between;padding:11px 15px;border-bottom:1px solid #4a443a;font-weight:700;font-size:14px;color:#e8dcc0">
        <span>${esc(l("runAssign.title", "语音生成者分配（谁的语音由谁的电脑生成）"))}</span>
        <button type="button" class="fvtt-tts-ra-x" style="background:none;border:none;color:#cbb;font-size:20px;cursor:pointer;line-height:1" title="${esc(l("runAssign.close", "关闭"))}">×</button>
      </header>
      <div class="fvtt-tts-ra-status" style="padding:10px 15px;color:#d8b46a;font-size:12px;line-height:1.5">${esc(l("runAssign.loading", "正在获取账号列表…"))}</div>
      <div class="fvtt-tts-ra-list" style="flex:1;overflow-y:auto;padding:6px 15px"></div>
      <footer style="display:flex;justify-content:flex-end;gap:8px;padding:10px 15px;border-top:1px solid #4a443a">
        ${isGM ? `<button type="button" class="fvtt-tts-ra-def" style="background:#3a342c;border:1px solid #5a5246;border-radius:4px;padding:5px 12px;color:#ddd;cursor:pointer">${esc(l("runAssign.allDefault", "全部恢复默认"))}</button>
        <button type="button" class="fvtt-tts-ra-self" style="background:#3a342c;border:1px solid #5a5246;border-radius:4px;padding:5px 12px;color:#ddd;cursor:pointer">${esc(l("runAssign.allSelf", "全部由自己生成"))}</button>
        <button type="button" class="fvtt-tts-ra-save" style="background:#7a5c30;border:1px solid #9a7c46;border-radius:4px;padding:5px 16px;color:#fff;cursor:pointer;font-weight:700">${esc(l("runAssign.save", "保存分配"))}</button>` : ""}
      </footer>
    </div>`;
    document.body.appendChild(wrap);
    _raEl = wrap;
    const box = wrap.querySelector(".fvtt-tts-ra-box");
    wrap.addEventListener("mousedown", (ev) => { if (ev.target === wrap) closeRa(); });
    const xBtn = box.querySelector(".fvtt-tts-ra-x");
    if (xBtn) xBtn.addEventListener("click", closeRa);
    const statusEl = box.querySelector(".fvtt-tts-ra-status");
    const listEl = box.querySelector(".fvtt-tts-ra-list");

    (async () => {
      try {
        const users = await fetchAllUsers();
        const sorted = users.slice().sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
        const curMap = parseRunnerMap(await loadRunnerMap());
        if (!sorted.length) {
          statusEl.textContent = l("runAssign.empty", "⚠ 没有拿到账号列表。请确认：① 已重启 FVTT 服务器；② 已硬刷新浏览器。");
          listEl.innerHTML = `<div style="color:#c96;padding:8px 0">${esc(l("runAssign.emptyShort", "账号列表为空（请重启 FVTT 并刷新页面）"))}</div>`;
          return;
        }
        if (!isGM) {
          statusEl.textContent = l("runAssign.deny", "只有主持人可以修改语音生成者分配。当前分配如下：");
        } else {
          statusEl.textContent = l("runAssign.hint2", "全部账号（含未登录玩家）都在这里，主持人直接给每个账号选「由谁的电脑生成」——没登录的账号也可以先安排（登录即生效）。被选中账号需开着 TTS 服务并与 FVTT 服务器互通，服务器自动取该账号电脑的 IP。玩家不能自己调整。");
        }
        const rows = sorted.map((u) => {
          const uname = String(u.name || "");
          const cur = curMap[uname] || "";
          const tag = `<span style="flex:0 0 46px;font-size:11px;padding:1px 6px;border-radius:8px;background:${u.isGM ? "#3a6ea5" : "#5a7a5a"};color:#fff;text-align:center">${u.isGM ? esc(l("runAssign.gm", "主持")) : esc(l("runAssign.pl", "玩家"))}</span>`;
          if (!isGM) {
            return `<div style="display:flex;align-items:center;gap:10px;padding:7px 4px;border-bottom:1px solid #3c372f">
              <span style="flex:0 0 180px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(uname)}</span>${tag}
              <span style="flex:1;color:#8a8a8a">${cur ? esc(cur) : esc(l("runAssign.def", "(默认引擎机)"))}</span></div>`;
          }
          const opts = [`<option value="" ${cur ? "" : "selected"}>${esc(l("runAssign.def", "(默认引擎机)"))}</option>`]
            .concat(sorted.map((o) => `<option value="${esc(String(o.name || ""))}" ${cur === String(o.name || "") ? "selected" : ""}>${esc(String(o.name || ""))}${o.active ? "" : esc(l("runAssign.offline", " (离线)"))}</option>`))
            .join("");
          return `<div style="display:flex;align-items:center;gap:10px;padding:7px 4px;border-bottom:1px solid #3c372f">
            <span style="flex:0 0 180px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(uname)}">${esc(uname)}</span>${tag}
            <span style="color:#8a8a8a">→</span>
            <select class="fvtt-tts-ra-sel" data-user="${esc(uname)}" style="flex:1;min-width:0">${opts}</select></div>`;
        }).join("");
        listEl.innerHTML = rows;
        if (!isGM) return;
        const save = box.querySelector(".fvtt-tts-ra-save");
        if (save) save.addEventListener("click", async () => {
          if (!(game.user && game.user.isGM)) { ui.notifications.error(l("runAssign.deny", "只有主持人可以分配")); return; }
          const lines = [];
          listEl.querySelectorAll("select.fvtt-tts-ra-sel").forEach((sel) => {
            const u = sel.dataset.user, v = sel.value;
            if (u && v) lines.push(u + " = " + v);
          });
          try {
            await game.settings.set(MOD, "voiceRunnerMap", lines.join("\n"));
            ui.notifications.info(l("runAssign.saved", "已保存，下一句说话立即生效"));
            closeRa();
          } catch (e) { ui.notifications.error(l("runAssign.saveFail", "保存失败") + ": " + String(e && e.message || e)); }
        });
        const def = box.querySelector(".fvtt-tts-ra-def");
        if (def) def.addEventListener("click", () => { listEl.querySelectorAll("select.fvtt-tts-ra-sel").forEach((s) => { s.value = ""; }); });
        const selfb = box.querySelector(".fvtt-tts-ra-self");
        if (selfb) selfb.addEventListener("click", () => { listEl.querySelectorAll("select.fvtt-tts-ra-sel").forEach((s) => { s.value = s.dataset.user; }); });
      } catch (e) {
        console.error("[gpt-sovits-tts] 分配器渲染失败:", e);
        statusEl.textContent = l("runAssign.initFail", "⚠ 分配器初始化失败：") + " " + String((e && e.message) || e);
        listEl.innerHTML = `<div style="color:#c96;padding:8px 0">⚠ ${esc(String((e && e.message) || e))}</div>`;
      }
    })();
  } catch (e) {
    console.error("[gpt-sovits-tts] 分配器打开失败:", e);
    if (typeof ui !== "undefined" && ui && ui.notifications) ui.notifications.error("[TTS] 分配器打开失败: " + String((e && e.message) || e));
  }
}

/** 注册设置面板替换: 设置项 → "打开分配器"按钮(仅 GM 的设置项可见) */
export function installRunnerAssignUI() {
  try {
    Hooks.on("renderSettingsConfig", (app, html) => {
      try {
        const root = html && html[0];
        if (!root || !(game.user && game.user.isGM)) return;
        const inp = root.querySelector('input[name="gpt-sovits-tts.voiceRunnerMap"], textarea[name="gpt-sovits-tts.voiceRunnerMap"]');
        if (!inp) return;
        const row = inp.closest(".form-group");
        if (!row) return;
        const hint = row.querySelector(".hint");
        const hintText = hint ? hint.innerHTML : "";
        const ff = row.querySelector(".form-fields");
        if (!ff) return;
        ff.innerHTML = `<button type="button" class="fvtt-tts-runner-open" style="flex:1">${esc(l("runAssign.open", "打开语音生成者分配（列出全部账号）…"))}</button>`;
        const btn = row.querySelector(".fvtt-tts-runner-open");
        if (btn) btn.addEventListener("click", () => {
          try {
            if (!(game.user && game.user.isGM)) { ui.notifications.error(l("runAssign.deny", "只有主持人可以分配")); return; }
            openRunnerAssign();
          } catch (e) { console.error("[gpt-sovits-tts] 分配器入口异常:", e); }
        });
        if (hint && hintText) hint.innerHTML = hintText;
      } catch (e) { /* noop */ }
    });
  } catch (e) { /* noop */ }
}