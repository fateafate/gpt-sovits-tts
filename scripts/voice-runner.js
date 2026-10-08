/**
 * gpt-sovits-tts — 语音生成者分配器 (Voice Runner Assignment)
 * GM 在 设置 → 语音生成者分配 点开: 列出全部账号, 每个账号一行"由谁生成"下拉。
 * 权限: 仅 GM 可打开/分配; 玩家不能自己调整(设置 restricted, 分配器内二次校验)。
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

export class VoiceRunnerAssignApp extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "fvtt-tts-runner-assign",
    window: { title: () => l("runAssign.title", "语音生成者分配（谁的语音由谁的电脑生成）"), resizable: true },
    position: { width: 760, height: 600 },
    classes: ["fvtt-tts-runner-assign"],
    template: "modules/gpt-sovits-tts/templates/voice-runner.html",
  };

  async _prepareContext() {
    // 权限: 仅 GM 可分配; 玩家看到只读提示
    const isGM = !!(game.user && game.user.isGM);
    const users = (game.users && game.users.contents) || [];
    const sorted = users.slice().sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
    const curMap = parseRunnerMap(await loadRunnerMap());
    if (!isGM) {
      const rows = sorted.map((u) => {
        const uname = String(u.name || "");
        const cur = curMap[uname] || "";
        return `<div class="rv-row"><span class="rv-name">${esc(uname)}</span><span class="rv-tag ${u.isGM ? "" : "pl"}">${u.isGM ? esc(l("runAssign.gm", "主持")) : esc(l("runAssign.pl", "玩家"))}</span><span class="rv-arrow">→</span><span class="rv-sel" style="flex:1;color:#8a8a8a">${cur ? esc(cur) : esc(l("runAssign.def", "(默认引擎机)"))}</span></div>`;
      }).join("");
      return { hint: l("runAssign.deny", "只有主持人可以修改语音生成者分配。当前分配如下："), rows, allDefault: "", allSelf: "", save: "" };
    }
    const rows = sorted.map((u) => {
      const uname = String(u.name || "");
      const cur = curMap[uname] || "";
      const opts = [`<option value="" ${cur ? "" : "selected"}>${esc(l("runAssign.def", "(默认引擎机)"))}</option>`]
        .concat(sorted.map((o) => `<option value="${esc(String(o.name || ""))}" ${cur === String(o.name || "") ? "selected" : ""}>${esc(String(o.name || ""))}</option>`))
        .join("");
      return `<div class="rv-row"><span class="rv-name" title="${esc(uname)}">${esc(uname)}</span><span class="rv-tag ${u.isGM ? "" : "pl"}">${u.isGM ? esc(l("runAssign.gm", "主持")) : esc(l("runAssign.pl", "玩家"))}</span><span class="rv-arrow">→</span><select class="rv-sel" data-user="${esc(uname)}">${opts}</select></div>`;
    }).join("");
    return {
      hint: l("runAssign.hint", "每个账号的语音由所选账号的电脑生成（被选中账号需开着 TTS 服务并与 FVTT 服务器互通，服务器会自动取该账号电脑的 IP）。不选 = 默认引擎机。所有账号（含主持人自己）都可分配，玩家不能自己调整。"),
      rows,
      allDefault: l("runAssign.allDefault", "全部恢复默认"),
      allSelf: l("runAssign.allSelf", "全部由自己生成"),
      save: l("runAssign.save", "保存分配"),
    };
  }

  async _onRender(context, options) {
    const el = this.element;
    if (!el) return;
    const save = el.querySelector(".rv-save");
    if (save) save.addEventListener("click", async () => {
      if (!(game.user && game.user.isGM)) { ui.notifications.error(l("runAssign.deny", "只有主持人可以分配")); return; }
      const lines = [];
      el.querySelectorAll(".rv-sel").forEach((sel) => {
        const u = sel.dataset.user, v = sel.value;
        if (u && v) lines.push(u + " = " + v);
      });
      try {
        await game.settings.set(MOD, "voiceRunnerMap", lines.join("\n"));
        ui.notifications.info(l("runAssign.saved", "已保存，下一句说话立即生效"));
        this.close();
      } catch (e) { ui.notifications.error(l("runAssign.saveFail", "保存失败") + ": " + String(e && e.message || e)); }
    });
    const d0 = el.querySelector(".rv-defaults");
    if (d0) d0.addEventListener("click", async () => {
      if (!(game.user && game.user.isGM)) return;
      el.querySelectorAll(".rv-sel").forEach((sel) => { sel.value = ""; });
    });
    const s1 = el.querySelector(".rv-self");
    if (s1) s1.addEventListener("click", async () => {
      if (!(game.user && game.user.isGM)) return;
      el.querySelectorAll(".rv-sel").forEach((sel) => { sel.value = sel.dataset.user; });
    });
  }
}

/** 注册设置面板替换: 设置项 → "打开分配器"按钮(仅 GM 的设置项, 玩家看不到也改不了) */
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
        row.querySelector(".form-fields").innerHTML =
          `<button type="button" class="fvtt-tts-runner-open" style="flex:1">${esc(l("runAssign.open", "打开语音生成者分配（列出全部账号）…"))}</button>`;
        const btn = row.querySelector(".fvtt-tts-runner-open");
        if (btn) btn.addEventListener("click", async () => {
          try {
            if (!(game.user && game.user.isGM)) { ui.notifications.error(l("runAssign.deny", "只有主持人可以分配")); return; }
            await new VoiceRunnerAssignApp().render(true);
          } catch (e) { console.error("[gpt-sovits-tts] 分配器打开失败", e); }
        });
        if (hint && hintText) hint.innerHTML = hintText;
      } catch (e) { /* noop */ }
    });
  } catch (e) { /* noop */ }
}