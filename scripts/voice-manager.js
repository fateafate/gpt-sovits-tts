/**
 * gpt-sovits-tts — 语音管理器（第四轮：角色构建器）
 * 角色列表/切换/新建向导（基础模型 | 模型库 | 导入 .char）、10 个固定语气槽
 * （每槽绑定一段音频，自动转写台词）、复制/导出/删除角色、头像、语速/音量。
 * 实现为自定义浮动面板(不依赖特定 Application 基类, 兼容 Foundry v11-13)。
 */
import { gptSovitsStatus, svcRequest } from "./tts-engine.js";
import { openRunnerAssign } from "./voice-runner.js";

const MODULE = "gpt-sovits-tts";

// LLM 模型常用预设(未检测时下拉也有内容; 检测后以服务实际模型为准)
const VM_LLM_PRESET = ["deepseek-chat", "deepseek-reasoner", "deepseek-v4-flash", "gpt-4o-mini", "gpt-4o", "qwen-plus", "qwen-turbo", "glm-4-flash", "kimi-latest"];

/* ============ 配置文件: 按用户隔离的语音档案 ============
 * voiceProfile 是 client 设置(同一浏览器所有用户共享); 悬浮窗/发送面板状态
 * (当前角色/语气/语速/音量等)必须每人独立 → 存 localStorage 键含 game.user.id;
 * 无 per-user 数据时回退读取旧 settings(首次迁移), 写时双写兼容. */
function _vpKey() {
  try { return `fvtt-tts-voiceprofile-${(game.user && game.user.id) || "default"}`; } catch (e) { return "fvtt-tts-voiceprofile-default"; }
}

export function loadVoiceProfile() {
  try {
    const s = localStorage.getItem(_vpKey());
    if (s) {
      const j = JSON.parse(s);
      if (j && typeof j === "object") return j;   // 有 per-user 键就用它(即使空), 不回落共享 settings
    }
  } catch (e) { /* noop */ }
  try { return game.settings.get(MODULE, "voiceProfile") || {}; }   // 旧数据兜底(首次迁移)
  catch (e) { return {}; }
}

export function saveVoiceProfile(prof) {
  try { localStorage.setItem(_vpKey(), JSON.stringify(prof || {})); } catch (e) { /* noop */ }
  return game.settings.set(MODULE, "voiceProfile", prof || {});   // 双写兼容(旧读取路径)
}

export function currentVoice() {
  const prof = loadVoiceProfile();
  const name = prof.current || "";
  const v = (prof.chars && prof.chars[name]) || null;
  // 多引擎并行: 角色 tts_provider(来自服务端角色数据/快照) — speak/代理合成按此路由引擎
  if (v && typeof v.ttsProvider === "undefined") { try { v.ttsProvider = _providerByChar[name] || "gpt-sovits"; } catch (e) { v.ttsProvider = "gpt-sovits"; } }
  return v;
}

let _providerByChar = {};   // 角色名 → 引擎(来自 /characters 或 30000 快照)

export function defaultProfileFromChars(chars) {
  const prof = { current: "", chars: {} };
  const first = chars && chars[0];
  if (!first) return prof;
  const name = first.name || "角色";
  prof.current = name;
  prof.chars[name] = { name, avatar: "", emotion: "", ref: "", auxRef: "", promptText: "", promptLang: "", speed: 0, volume: 0 };
  return prof;
}

/* ============ 朗读风格提示词: 按用户隔离(voiceProfile 是 client 共享设置, GM/玩家同浏览器会互相覆盖) ============ */
function _styleKey() {
  try { return `fvtt-tts-styleprompt-${(game.user && game.user.id) || "default"}`; } catch (e) { return "fvtt-tts-styleprompt-default"; }
}

export function getStylePrompt(role) {
  try {
    const j = JSON.parse(localStorage.getItem(_styleKey()) || "{}");
    return String(j[role || ""] || "").slice(0, 120);
  } catch (e) { return ""; }
}

export function setStylePrompt(role, val) {
  try {
    const key = _styleKey();
    let j = {};
    try { j = JSON.parse(localStorage.getItem(key) || "{}"); } catch (e) { j = {}; }
    j[role || ""] = String(val || "").slice(0, 120);
    localStorage.setItem(key, JSON.stringify(j));
  } catch (e) { /* noop */ }
}

/* ============ 通用可拖动面板 ============ */
export function makeDraggable(el, handle, opts = {}) {
  if (!el || !handle || el.dataset.draggable === "1") return;
  el.dataset.draggable = "1";
  const persistKey = opts.persistKey || "";
  // 恢复已保存位置(悬浮条等)
  if (persistKey) {
    try {
      const saved = JSON.parse(localStorage.getItem(persistKey) || "null");
      if (saved && typeof saved.left === "number" && typeof saved.top === "number") {
        el.style.left = `${saved.left}px`;
        el.style.top = `${saved.top}px`;
        el.style.right = "auto";
        el.style.bottom = "auto";
        el.style.transform = "none";
      }
    } catch (e) { /* noop */ }
  }
  let armed = false, dragging = false, sx = 0, sy = 0, ox = 0, oy = 0, id = 0;
  const startDrag = (e) => {
    if (e.button !== 0) return;
    // 只在真正的表单控件上不拖; 按钮/空白都可拖动(点击按钮照常触发, 移动阈值区分)
    if (e.target && e.target.closest && e.target.closest("select, input, textarea, a, option")) return;
    armed = true; dragging = false; id = (id + 1) | 0;
    sx = e.clientX; sy = e.clientY;
  };
  handle.addEventListener("mousedown", startDrag);
  document.addEventListener("mousemove", (e) => {
    if (!armed) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (!dragging && Math.hypot(dx, dy) < 5) return;   // 移动阈值: 点击按钮不触发拖拽
    if (!dragging) {
      dragging = true;
      const r = el.getBoundingClientRect();
      ox = r.left; oy = r.top;
      // 从 translate 居中 / right-bottom 定位切换到 left/top, 拖拽不弹回、不拉伸
      el.style.transform = "none";
      el.style.right = "auto";
      el.style.bottom = "auto";
      el.classList.add("fvtt-tts-dragging");
      try { e.preventDefault(); } catch (err) { /* noop */ }
    }
    const bw = el.offsetWidth || 60, bh = el.offsetHeight || 30;
    const maxX = Math.max(0, window.innerWidth - bw);
    const maxY = Math.max(0, window.innerHeight - bh);
    const nx = Math.min(Math.max(0, ox + dx), maxX);   // 不能拖出屏幕(右/下也钳制)
    const ny = Math.min(Math.max(0, oy + dy), maxY);
    el.style.left = `${nx}px`;
    el.style.top = `${ny}px`;
  });
  document.addEventListener("mouseup", () => {
    if (!armed) return;
    armed = false;
    if (!dragging) return;
    dragging = false;
    el.classList.remove("fvtt-tts-dragging");
    if (persistKey) {
      try {
        localStorage.setItem(persistKey, JSON.stringify({ left: parseFloat(el.style.left) || 0, top: parseFloat(el.style.top) || 0 }));
      } catch (err) { /* noop */ }
    }
  });
  document.addEventListener("mouseleave", () => { armed = false; dragging = false; el.classList.remove("fvtt-tts-dragging"); });
}

/* ============ 面板 ============ */
export class VoiceManager {
  static _instance = null;

  static open() {
    if (!VoiceManager._instance) VoiceManager._instance = new VoiceManager();
    VoiceManager._instance.render();
    // 兜底: 已启用 LLM + 已填密钥但还没拉取过模型 → 打开面板时自动拉取(设置页模型下拉自动出现)
    setTimeout(() => {
      try {
        if (typeof window.fetchAndRefreshModels !== "function") return;
        const en = !!game.settings.get("gpt-sovits-tts", "llmEnabled");
        const key = game.settings.get("gpt-sovits-tts", "llmKey") || "";
        if (en && key) window.fetchAndRefreshModels(false).catch(() => {});
      } catch (e) { /* noop */ }
    }, 600);
    return VoiceManager._instance;
  }

  constructor() {
    this.el = null;
    this.charsData = null;    // /characters
    this.voicesData = null;   // /voices
    this.status = null;
    this.busy = false;
    this.view = "main";       // main | editor
    this.editName = "";       // editor 目标角色
    this.editMode = "edit";   // edit | new
  }

  /* ---------- 数据 ---------- */
  get base() {
    const cfg = getCfgSafe();
    return (cfg.serverUrl || "http://127.0.0.1:9880").replace(/\/+$/, "");
  }

  // 服务端请求封装: socket 代理优先(https 页面/跨机场景 Mixed Content 根治) → 直连回退;
  // 返回伪 Response({ ok, status, json(), text(), headers, blob? }) 兼容现有调用形态。
  _svc(method, path, body, opts = {}) {
    return svcRequest(this.base, method, path, body, opts).then(r => ({
      ok: r.ok,
      status: r.status || 0,
      blob: r.blob || null,
      json: () => Promise.resolve(r.jsonSafe ? r.jsonSafe() : (r.json || {})),
      jsonSafe: () => r.jsonSafe ? r.jsonSafe() : (r.json || {}),
      text: () => Promise.resolve(JSON.stringify((r.jsonSafe ? r.jsonSafe() : (r.json || {})) || {})),
      headers: { get: () => null }
    }));
  }

  // 二进制上传(音频/角色包): File → base64 → socket 代理(https 下也可用); 响应为 JSON。
  async _svcFile(method, path, file, { timeoutMs = 300000 } = {}) {
    if (file && typeof file.arrayBuffer === "function") {
      try {
        const ab = await file.arrayBuffer();
        const bytes = new Uint8Array(ab);
        let bin = ""; const CH = 0x8000;
        for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CH, bytes.length)));
        const b64 = btoa(bin);
        if (b64.length <= 8 * 1024 * 1024) {
          const r = await svcRequest(this.base, method, path, null, { b64Body: b64, contentType: file.type || "application/octet-stream", timeoutMs });
          return { ok: r.ok, status: r.status || 0, json: () => Promise.resolve(r.jsonSafe ? r.jsonSafe() : (r.json || {})), jsonSafe: () => r.jsonSafe ? r.jsonSafe() : (r.json || {}), text: () => Promise.resolve(JSON.stringify((r.jsonSafe ? r.jsonSafe() : (r.json || {})) || {})), headers: { get: () => null } };
        }
      } catch (e) { /* 回退直连 */ }
    }
    return this._svc(method, path, null);
  }

  async refresh() {
    try {
      const r = await this._svc("GET", "/characters");
      this.charsData = r.ok ? await r.json() : { ok: false, chars: [], active: "" };
      try { (this.charsData.chars || []).forEach(c => { if (c && c.name) _providerByChar[c.name] = String(c.provider || "gpt-sovits"); }); } catch (e) { /* noop */ }
    } catch (e) { this.charsData = { ok: false, chars: [], active: "" }; }
    // 服务暂不可用时的角色兜底缓存(避免"未加载角色"): 用上次成功结果
    if (!this.charsData || !Array.isArray(this.charsData.chars) || !this.charsData.chars.length) {
      try {
        const s = localStorage.getItem("fvtt-tts-quickchars-v1");
        if (s) { const j = JSON.parse(s); if (j && Array.isArray(j.chars) && j.chars.length) { this.charsData = j; this.charsData.fromCache = true; } }
        try { (this.charsData.chars || []).forEach(c => { if (c && c.name) _providerByChar[c.name] = String(c.provider || "gpt-sovits"); }); } catch (e) { /* noop */ }
      } catch (e) { /* noop */ }
    }
    try {
      const r = await this._svc("GET", "/voices");
      this.voicesData = r.ok ? await r.json() : { ok: false, gpt: [], sovits: [], base_model: { available: false } };
    } catch (e) { this.voicesData = { ok: false, gpt: [], sovits: [], base_model: { available: false } }; }
    try {
      const s = await gptSovitsStatus(this.base);
      this.status = s.ok ? s.data : null;
    } catch (e) { this.status = null; }
  }

  // 服务端状态(如 refresh 内 false 的旧路径)走 _svc:
  async _statusSafe() {
    try {
      const r = await this._svc("GET", "/status");
      return r.ok ? r.jsonSafe() : null;
    } catch (e) { return null; }
  }

  get activeChar() {
    const chars = (this.charsData && this.charsData.chars) || [];
    const name = (this.charsData && this.charsData.active) || "";
    return chars.find(c => c.name === name) || null;
  }

  /* ---------- 渲染 ---------- */
  async render() {
    await this.refresh();
    const prof0 = loadVoiceProfile();
    const chars0 = (this.charsData && this.charsData.chars) || [];
    if (!prof0.current && chars0.length) saveVoiceProfile(defaultProfileFromChars(chars0));
    if (!this.el || !document.body.contains(this.el)) this._buildShell();
    this._renderBody();
  }

  _buildShell() {
    if (this.el) this.el.remove();
    this.el = document.createElement("div");
    this.el.className = "fvtt-tts-vm";
    this.el.innerHTML = `
      <header class="fvtt-tts-vm-head">
        <span class="fvtt-tts-vm-title">${t("vm.title", "语音设置")}</span>
        <button type="button" class="fvtt-tts-vm-close" title="${t("vm.close", "关闭")}">×</button>
      </header>
      <div class="fvtt-tts-vm-body"></div>
      <footer class="fvtt-tts-vm-foot">
        <button type="button" class="fvtt-tts-vm-back" style="display:none">${t("vm.back", "返回")}</button>
        <button type="button" class="fvtt-tts-vm-selftest" title="${t("vm.selfTestTitle", "一键跑全部测试并生成报告文件，供作者排查问题")}">🧪 ${t("vm.selfTest", "自检")}</button>
        <button type="button" class="fvtt-tts-vm-stress" title="${t("vm.stressTestTitle", "高压测试: 并发/长文本/广播风暴等压力场景")}">⚡ ${t("vm.stressTest", "高压")}</button>
        <button type="button" class="fvtt-tts-vm-speed" title="${t("vm.speedTestTitle", "批量速度测试: 分批次测合成/传输/加载速度, 并压满显卡验证峰值性能")}">🚄 ${t("vm.speedTest", "速度")}</button>
        <button type="button" class="fvtt-tts-vm-selftestP" title="${t("vm.selfTestPTitle", "玩家自测: 验证本机能否收到并官方播放 GM 语音(玩家端优先)")}">🔬 ${t("vm.selfTestP", "玩家自测")}</button>
        ${(game.user && game.user.isGM) ? `<button type="button" class="fvtt-tts-vm-runassign" title="${t("vm.runAssignTitle", "给每个账号指定语音由谁的电脑生成(仅主持人)")}">👥 ${t("vm.runAssign", "语音生成者分配")}</button>` : ""}
        <span class="fvtt-tts-vm-spacer" style="flex:1"></span>
        <button type="button" class="fvtt-tts-vm-test">${t("vm.test", "试听")}</button>
        <button type="button" class="fvtt-tts-vm-save">${t("vm.save", "保存")}</button>
      </footer>`;
    this.el.querySelector(".fvtt-tts-vm-close").addEventListener("click", () => this.close());
    this.el.querySelector(".fvtt-tts-vm-selftest").addEventListener("click", () => {
      try {
        const fn = game.gptSoVitsTTS && game.gptSoVitsTTS.runSelfTest;
        if (fn) fn();
        else if (ui && ui.notifications) ui.notifications.info("模块未就绪，稍后再试");
      } catch (e) { /* noop */ }
    });
    const runBtn = this.el.querySelector(".fvtt-tts-vm-runassign");
    if (runBtn) runBtn.addEventListener("click", () => {
      try {
        if (!(game.user && game.user.isGM)) return;
        openRunnerAssign();
      } catch (e) { console.error("[gpt-sovits-tts] 分配器入口异常:", e); }
    });
    this.el.querySelector(".fvtt-tts-vm-stress").addEventListener("click", () => {
      try {
        const fn = game.gptSoVitsTTS && game.gptSoVitsTTS.runStressTest;
        if (fn) fn();
        else if (ui && ui.notifications) ui.notifications.info("模块未就绪，稍后再试");
      } catch (e) { /* noop */ }
    });
    this.el.querySelector(".fvtt-tts-vm-speed").addEventListener("click", () => {
      try {
        const fn = game.gptSoVitsTTS && game.gptSoVitsTTS.runSpeedTest;
        if (fn) { ui.notifications.info("🚄 批量速度测试开始（含压满显卡/分批传输，约 1 分钟）"); fn(); }
        else if (ui && ui.notifications) ui.notifications.info("模块未就绪，稍后再试");
      } catch (e) { /* noop */ }
    });
    this.el.querySelector(".fvtt-tts-vm-selftestP").addEventListener("click", () => {
      try {
        const fn = game.gptSoVitsTTS && game.gptSoVitsTTS.runPlayerSelfTest;
        if (fn) { ui.notifications.info("🔬 玩家自测开始（播放测试音验证，几秒后出结果）"); fn(); }
        else if (ui && ui.notifications) ui.notifications.info("模块未就绪，稍后再试");
      } catch (e) { /* noop */ }
    });
    this.el.addEventListener("keydown", (ev) => { if (ev.key === "Escape") this.close(); });
    makeDraggable(this.el, this.el.querySelector(".fvtt-tts-vm-head"), { persistKey: "fvtt-tts-vm-pos" });
    document.body.appendChild(this.el);
  }

  _renderBody() {
    if (!this.el || !document.body.contains(this.el)) return;
    const body = this.el.querySelector(".fvtt-tts-vm-body");
    if (!body) return;
    if (this.view === "editor") return this._renderEditor(body);
    this._renderMain(body);
    this._wireFooter("main");
  }

  /* ============ 主面板 ============ */
  _renderMain(body) {
    const isGM = !!(game.user && game.user.isGM);
    const chars = (this.charsData && this.charsData.chars) || [];
    const active = this.activeChar;
    const prof = loadVoiceProfile();
    const curName = prof.current || (this.charsData && this.charsData.active) || (chars[0] && chars[0].name) || "";
    const p = (prof.chars && prof.chars[curName]) || null;
    const slots = active ? active.emotions : [];
    const _curActiveChar = (chars || []).find(c => c.name === curName) || null;
    const curProv = String((_curActiveChar && _curActiveChar.provider) || (p && p.ttsProvider) || "gpt-sovits");

    let html = "";
    // AI 接入 (LLM 语气判断, 可选): 直接在面板顶部填写网址+密钥, 输入完自动检测模型并填充下拉
    let aiBase = "", aiKeySet = false, aiEnabled = false, aiModel = "", aiModels = [], _cfgTextLang = "", _gmMute = false;
    try {
      // AI 接入区显示: GM 分发的世界共享配置优先(pl 只读, 面板如实反映共享生效状态)
      const _shB = game.settings.get("gpt-sovits-tts", "aiSharedBase") || "";
      const _shK = game.settings.get("gpt-sovits-tts", "aiSharedKey") || "";
      const _shM = game.settings.get("gpt-sovits-tts", "aiSharedModel") || "";
      aiBase = _shB || game.settings.get("gpt-sovits-tts", "llmBaseUrl") || "";
      aiKeySet = !!(_shK || game.settings.get("gpt-sovits-tts", "llmKey"));
      aiEnabled = !!(_shB || _shK || game.settings.get("gpt-sovits-tts", "llmEnabled"));
      aiModel = _shM || game.settings.get("gpt-sovits-tts", "llmModel") || "";
      aiModels = this._aiModels || [];
      _cfgTextLang = game.settings.get("gpt-sovits-tts", "textLang") || "auto";
      _gmMute = !!game.settings.get("gpt-sovits-tts", "gmMute");
    } catch (e) { /* noop */ }
    const aiOpts = (aiModels.length ? aiModels : VM_LLM_PRESET).map(m => `<option value="${esc(m)}" ${m === aiModel ? "selected" : ""}>${esc(m)}</option>`).join("");
    html += `<section class="fvtt-tts-vm-sec fvtt-tts-vm-sec-ai">
      <div class="fvtt-tts-vm-title2">${t("vm.aiTitle", "AI 接入 (LLM 语气判断)")} ${aiEnabled ? "✅" : "（未启用）"}</div>
      <div class="fvtt-tts-vm-hint">${t("vm.aiHint2", "在这里填写 API 网址与密钥，输入完自动检测可用模型；不填不影响朗读。")}</div>
      <label class="fvtt-tts-vm-row"><span>${t("vm.aiBase", "API 地址")}</span>
        <input class="fvtt-tts-vm-ai-base" value="${esc(aiBase)}" placeholder="https://api.deepseek.com/v1"></label>
      <label class="fvtt-tts-vm-row"><span>${t("vm.aiKey", "密钥")}</span>
        <input class="fvtt-tts-vm-ai-key" type="password" value="${esc(this._aiKeyShown && aiKeySet ? aiKey : "")}" placeholder="${aiKeySet ? t("vm.aiKeySaved", "已保存，直接输入即可更换") : "sk-..."}">
        ${aiKeySet ? `<button type="button" class="fvtt-tts-vm-btn vm-ai-keyview">${this._aiKeyShown ? "隐藏" : "显示"}</button>` : ""}</label>
      <label class="fvtt-tts-vm-row"><span>${t("vm.aiModel", "模型")}</span>
        <select class="fvtt-tts-vm-ai-model">${aiOpts}</select></label>
      <div class="fvtt-tts-vm-row">
        <button type="button" class="fvtt-tts-vm-btn vm-ai-detect">⚡ ${t("vm.aiDetect", "自动检测模型")}</button>
        <button type="button" class="fvtt-tts-vm-btn vm-ai-preload">🚀 ${t("vm.aiPreload", "预加载 AI")}</button>
        <button type="button" class="fvtt-tts-vm-btn vm-ai-save">💾 ${t("vm.aiSave", "保存 AI 配置")}</button>
      </div>
      <div class="fvtt-tts-vm-ai-status">${aiEnabled ? "" : t("vm.aiSaveHint", "填好后点保存开启")}</div>
      <div class="fvtt-tts-vm-row fvtt-tts-vm-ai-share">${
        (game.user && game.user.isGM)
          ? `<button type="button" class="fvtt-tts-vm-btn vm-ai-share-all">📤 ${t("vm.aiShareAll", "一键分发给所有玩家")}</button>
             <button type="button" class="fvtt-tts-vm-btn vm-ai-share-clear">🗑 ${t("vm.aiShareClear", "一键收回所有玩家配置")}</button>`
          : `<span class="fvtt-tts-vm-hint">${t("vm.aiSharedNote", "AI 配置由主持人提供（只读，无需填写）")}</span>`
      }</div></section>
    <section class="fvtt-tts-vm-sec">
      <div class="fvtt-tts-vm-title2">🔇 ${t("vm.gmMuteTitle", "全局静音")}</div>
      ${(() => { const _gmMuteState = _gmMute ? t("vm.gmMuteOn", "已静音") : t("vm.gmMuteOff", "正常");
        return (game.user && game.user.isGM)
        ? `<label class="fvtt-tts-vm-row"><span>${t("vm.gmMuteLabel", "全员静音（所有角色说话都不出声）")}</span>
             <input type="checkbox" class="fvtt-tts-vm-gm-mute" ${_gmMute ? "checked" : ""}></label>
           <div class="fvtt-tts-vm-hint">${t("vm.gmMuteHint", "打开后所有人立即听不到语音（聊天立绘不受影响），再点关闭恢复。")}</div>`
        : `<div class="fvtt-tts-vm-hint">${t("vm.gmMuteNote", "全局静音由主持人控制")}（${_gmMuteState}）</div>`;
      })()}
    </section>
    <section class="fvtt-tts-vm-sec">
      <div class="fvtt-tts-vm-title2">${t("vm.langTitle", "朗读语言 (自动翻译目标)")}</div>
      <label class="fvtt-tts-vm-row"><span>${t("vm.lang", "语言")}</span>
        <select class="fvtt-tts-vm-lang">
          <option value="auto" ${_cfgTextLang === "auto" ? "selected" : ""}>${t("settings.textLang.auto", "自动")}</option>
          <option value="zh" ${_cfgTextLang === "zh" ? "selected" : ""}>${t("settings.textLang.zh", "中文")}</option>
          <option value="ja" ${_cfgTextLang === "ja" ? "selected" : ""}>${t("settings.textLang.ja", "日语")}</option>
          <option value="en" ${_cfgTextLang === "en" ? "selected" : ""}>${t("settings.textLang.en", "英语")}</option>
          <option value="ko" ${_cfgTextLang === "ko" ? "selected" : ""}>${t("settings.textLang.ko", "韩语")}</option>
          <option value="yue" ${_cfgTextLang === "yue" ? "selected" : ""}>${t("settings.textLang.yue", "粤语")}</option>
        </select></label>
      <div class="fvtt-tts-vm-hint">${t("vm.langHint", "朗读输出语种；auto 按文本内容自动判断。")}</div>
    </section>`;
    if (!this.charsData || this.charsData.ok === false) {
      html += `<div class="fvtt-tts-vm-err">${t("vm.errServer", "无法连接 TTS 服务，请先启动 start-tts-server.bat")}</div>`;
    }
    // 角色选择
    const charOpts = chars.map(c => `<option value="${esc(c.name)}" ${c.name === curName ? "selected" : ""}>${esc(c.name)}</option>`).join("");
    html += `<section class="fvtt-tts-vm-sec">
      <div class="fvtt-tts-vm-row"><span>${t("vm.character", "当前角色")}</span>
        <select class="fvtt-tts-vm-char">${charOpts || `<option value="">${t("vm.noChar", "未加载角色")}</option>`}</select>
        ${isGM ? `<button type="button" class="fvtt-tts-vm-btn vm-switch">${t("vm.switchChar", "切换")}</button>` : ""}
      </div>
      <label class="fvtt-tts-vm-row">
        <span>${t("vm.provider", "语音引擎")}</span>
        <select class="fvtt-tts-vm-provider" ${isGM ? "" : "disabled"}>
          <option value="gpt-sovits" ${curProv === "gpt-sovits" ? "selected" : ""}>${t("vm.providerGpt", "GPT-SoVITS（本机高音质）")}</option>
          <option value="edge" ${curProv === "edge" ? "selected" : ""}>${t("vm.providerEdge", "Edge-TTS（在线，低负载）")}</option>
          <option value="web" ${curProv === "web" ? "selected" : ""}>${t("vm.providerWeb", "Web（Edge 优先，浏览器兜底）")}</option>
        </select>
        ${isGM ? "" : `<span class="fvtt-tts-vm-hint">（${t("vm.providerGmOnly", "由主持人修改")}）</span>`}
      </label>
      ${isGM ? `<div class="fvtt-tts-vm-row">
        <span>${t("vm.charActions", "角色操作")}</span>
        <button type="button" class="fvtt-tts-vm-btn vm-new">${t("vm.newChar", "＋ 新建角色")}</button>
        <button type="button" class="fvtt-tts-vm-btn vm-edit">${t("vm.editChar", "编辑角色")}</button>
        <button type="button" class="fvtt-tts-vm-btn vm-dup">${t("vm.dupChar", "复制")}</button>
        <button type="button" class="fvtt-tts-vm-btn vm-export">${t("vm.exportChar", "导出 .char")}</button>
        <button type="button" class="fvtt-tts-vm-btn vm-del">${t("vm.delChar", "删除")}</button>
      </div>` : ""}
      <label class="fvtt-tts-vm-row">
        <span>${t("vm.charName", "显示名称")}</span>
        <input class="fvtt-tts-vm-name" value="${esc(p ? p.name : "")}" placeholder="${t("vm.charNamePh", "留空用角色名")}">
      </label>
      <div class="fvtt-tts-vm-row">
        <span>${t("vm.avatar", "角色头像")}</span>
        <div class="fvtt-tts-vm-avrow">
          <img class="fvtt-tts-vm-av" src="${p && p.avatar ? p.avatar : ""}" alt="">
          <button type="button" class="fvtt-tts-vm-avpick">${t("vm.avatarPick", "选择图片")}</button>
        </div>
      </div></section>`;

    // 朗读语气(10 槽)
    const emoOpts = slots.map(e => `<option value="${esc(e.key)}" ${p && p.emotion === e.key ? "selected" : ""}>${esc(e.label)}${e.bound ? " ✓" : ""}</option>`).join("");
    html += `<section class="fvtt-tts-vm-sec">
      <label class="fvtt-tts-vm-row">
        <span>${t("vm.emotion", "朗读语气")}</span>
        <select class="fvtt-tts-vm-emotion">
          <option value="">${t("vm.emotionNone", "默认（主参考音色）")}</option>
          ${emoOpts}
        </select>
      </label>
      <div class="fvtt-tts-vm-hint">${t("vm.emotionHint", "语气槽在「编辑角色」里绑定音频；未绑定的语气用主参考音色。")}</div></section>`;

    // 音色模型(GM, 服务端全局)
    if (isGM && active) {
      const ml = (active && (active.models_list || (this.charsData && this.charsData.detail && this.charsData.detail.models_list))) || { gpt: [], sovits: [] };
      html += `<section class="fvtt-tts-vm-sec">
        <div class="fvtt-tts-vm-row"><span>${t("vm.models", "音色模型")}</span></div>
        <label class="fvtt-tts-vm-row"><span>GPT</span>
          <select class="fvtt-tts-vm-gpt">${ml.gpt.map(f => `<option>${esc(f)}</option>`).join("") || `<option value="">${t("vm.noModel", "无")}</option>`}</select>
        </label>
        <label class="fvtt-tts-vm-row"><span>SoVITS</span>
          <select class="fvtt-tts-vm-sovits">${ml.sovits.map(f => `<option>${esc(f)}</option>`).join("") || `<option value="">${t("vm.noModel", "无")}</option>`}</select>
        </label>
        <button type="button" class="fvtt-tts-vm-btn vm-switch-model">${t("vm.switch", "切换到所选模型")}</button>
      </section>`;
    }

    // 语速 / 音量
    const spd = p && p.speed ? p.speed : 1;
    const vol = p && p.volume ? p.volume : 1;
    html += `<section class="fvtt-tts-vm-sec">
      <label class="fvtt-tts-vm-row"><span>${t("vm.speed", "语速")}</span>
        <input class="fvtt-tts-vm-speed" data-field="speed" type="range" min="0.5" max="2" step="0.05" value="${spd}">
        <span class="fvtt-tts-vm-val" data-for="speed">${spd.toFixed(2)}</span>
      </label>
      <label class="fvtt-tts-vm-row"><span>${t("vm.volume", "音量")}</span>
        <input class="fvtt-tts-vm-vol" data-field="volume" type="range" min="0" max="1" step="0.05" value="${vol}">
        <span class="fvtt-tts-vm-val" data-for="volume">${vol.toFixed(2)}</span>
      </label>
      <label class="fvtt-tts-vm-row"><span title="${t("vm.styleTip", "朗读风格提示词：如“更严肃认真、中间不要中断”。会翻译成语速/停顿等合成参数，角色独立记得。")}">${t("vm.stylePrompt", "朗读风格")}</span>
        <input class="fvtt-tts-vm-style" type="text" maxlength="120" value="${esc(getStylePrompt(this.editName || (this.charsData && this.charsData.active) || "") || ((p && p.stylePrompt) || ""))}" placeholder="${t("vm.stylePh", "如：更严肃认真，中间不要中断")}">
      </label></section>`;

    const st = this.status;
    if (st) html += `<div class="fvtt-tts-vm-status">${t("vm.status", "服务状态")}: ${esc(st.character?.name || "")} · ${esc(st.device || "")} · ${t("vm.samples", "激活角色")} ${esc((this.charsData && this.charsData.active) || "")}</div>`;
    if (st && st.hw) {
      const h = st.hw;
      let hwTxt = (h.cuda && h.gpu_name) ? `${h.gpu_name} (cuda ${h.gpu_mem_total_gb || "?"}GB)` : `CPU ${h.cpu_count || "?"}核`;
      if (h.cuda && h.gpu_name && h.gpu_mem_free_gb != null && Number(h.gpu_mem_free_gb) < 3) hwTxt += " ⚠ 显存不足,已自动用CPU";
      html += `<div class="fvtt-tts-vm-status fvtt-tts-vm-hw">${t("vm.hw", "硬件")}: ${esc(hwTxt)} · ${esc(st.is_half ? "fp16" : "fp32")}</div>`;
    }

    // 语音分配(GM): 列出全部 pl 账号, 每个分配语音运行电脑(默认主持人电脑; 可给该玩家自己或某台服务机)
    if (isGM) {
      try {
        const assigns = safeAssignments();
        const users = game.users ? game.users.map(u => u.name).filter(Boolean) : [];
        const runners = (game.gptSoVitsTTS && game.gptSoVitsTTS.getRunners) ? (game.gptSoVitsTTS.getRunners() || []) : [];
        html += `<section class="fvtt-tts-vm-sec fvtt-tts-vm-sec-voice">
          <div class="fvtt-tts-vm-title2">${t("vm.voiceAssign", "语音分配（谁的语音由哪台电脑跑）")}</div>
          <div class="fvtt-tts-vm-hint">${t("vm.voiceAssignHint", "给每个玩家分配语音运行的电脑；默认全部由主持人电脑跑。玩家端自动跟随。")}</div>`;
        users.forEach(u => {
          const cur = assigns[u] || "gm";
          html += `<div class="fvtt-tts-vm-voice-row"><span class="fvtt-tts-vm-voice-name">${esc(u)}</span>
            <select class="fvtt-tts-vm-voice-sel" data-user="${esc(u)}">
              <option value="gm" ${cur === "gm" ? "selected" : ""}>${t("vm.voiceGm", "主持人电脑（默认）")}</option>
              <option value="self" ${cur === "self" ? "selected" : ""}>${t("vm.voiceSelf", "该玩家自己的电脑")}</option>
              ${runners.map(r => `<option value="${esc(r.url)}" ${cur === r.url ? "selected" : ""}>${esc(r.by || "玩家")}（${esc(r.url)}）</option>`).join("")}
            </select></div>`;
        });
        html += `</section>`;
      } catch (e) { /* noop */ }
    }

    body.innerHTML = html;
    this._bindMain(body, isGM, chars, active);
  }

  _bindMain(body, isGM, chars, active) {
    body.querySelectorAll(".fvtt-tts-vm-speed, .fvtt-tts-vm-vol").forEach(r => {
      r.addEventListener("input", () => {
        const v = parseFloat(r.value);
        const val = body.querySelector(`.fvtt-tts-vm-val[data-for="${r.dataset.field}"]`);
        if (val) val.textContent = v.toFixed(2);
      });
    });
    // 朗读风格提示词 → 当前角色独立记住
    const styleInp = body.querySelector(".fvtt-tts-vm-style");
    if (styleInp) {
      styleInp.addEventListener("input", () => {
        try {
          const cn = (loadVoiceProfile().current) || "";
          if (!cn) return;
          setStylePrompt(cn, styleInp.value || "");   // per-user 隔离
          const prof = loadVoiceProfile();
          prof.chars = prof.chars || {};
          const c = prof.chars[cn] || (prof.chars[cn] = { name: cn });
          c.stylePrompt = String(styleInp.value || "").slice(0, 120);
          saveVoiceProfile(prof);
        } catch (e) { /* noop */ }
      });
    }
    body.querySelector(".fvtt-tts-vm-avpick").addEventListener("click", () => this._pickAvatar());
    // 读取语音分配表(带类型防御: 设置曾被错误存成字符串时按空表处理, 防止坏值传播)
function safeAssignments() {
  try {
    const a = game.settings.get("gpt-sovits-tts", "voiceAssignments");
    if (a && typeof a === "object" && !Array.isArray(a)) return { ...a };
  } catch (e) { /* noop */ }
  return {};
}

// 语音分配(GM): 选区变化 → 保存 world 分配表(全员自动跟随)
    body.querySelectorAll(".fvtt-tts-vm-voice-sel").forEach(sel => {
      sel.addEventListener("change", () => {
        try {
          const assigns = safeAssignments();
          assigns[sel.dataset.user] = sel.value;
          game.settings.set("gpt-sovits-tts", "voiceAssignments", assigns).then(() => {
            try { ui.notifications.info(t("vm.voiceSaved", "语音分配已保存")); } catch (e) { /* noop */ }
          }).catch(() => {});
        } catch (e) { /* noop */ }
      });
    });
    // AI 接入: 输入网址/密钥自动检测模型 + 保存配置
    const aiBaseInp = body.querySelector(".fvtt-tts-vm-ai-base");
    const aiKeyInp = body.querySelector(".fvtt-tts-vm-ai-key");
    const aiModelSel = body.querySelector(".fvtt-tts-vm-ai-model");
    const aiStatus = body.querySelector(".fvtt-tts-vm-ai-status");
    const aiDetectBtn = body.querySelector(".vm-ai-detect");
    const aiSaveBtn = body.querySelector(".vm-ai-save");
    const aiKeyView = body.querySelector(".vm-ai-keyview");
    const aiDetect = async () => {
      if (!aiBaseInp || !aiKeyInp || !aiModelSel) return;
      const base = aiBaseInp.value.trim();
      const key = aiKeyInp.value.trim();
      if (!base || !key) { if (aiStatus) aiStatus.textContent = t("vm.aiNoKey2", "请先填写 API 地址和密钥"); return; }
      if (aiStatus) aiStatus.textContent = t("vm.aiDetecting", "检测中…");
      try {
        const j = (typeof window.fetchModelsFromServer === "function") ? await window.fetchModelsFromServer(base, key) : null;
        if (!j || !j.ok) { if (aiStatus) aiStatus.textContent = t("vm.aiDetectFail", "检测失败") + ": " + ((j && j.message) || "unknown"); return; }
        const models = j.models || [];
        if (!models.length) { if (aiStatus) aiStatus.textContent = t("vm.aiNoModels2", "该服务未返回可用模型"); return; }
        this._aiModels = models;
        aiModelSel.innerHTML = models.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join("");
        try { await game.settings.set("gpt-sovits-tts", "llmModels", models); await game.settings.set("gpt-sovits-tts", "llmModel", models[0]); } catch (e) { /* noop */ }
        if (aiStatus) aiStatus.textContent = "✓ " + t("vm.aiDetected", "检测到模型") + " " + models.length + " 个：" + models.slice(0, 5).join(", ");
      } catch (err) { if (aiStatus) aiStatus.textContent = t("vm.aiDetectFail", "检测失败") + ": " + (err.message || err); }
    };
    if (aiBaseInp) { aiBaseInp.addEventListener("change", aiDetect); aiBaseInp.addEventListener("blur", aiDetect); }
    if (aiKeyInp) { aiKeyInp.addEventListener("change", aiDetect); aiKeyInp.addEventListener("blur", aiDetect); }
    if (aiDetectBtn) aiDetectBtn.addEventListener("click", aiDetect);
    // 预加载 AI: 提前跑一次 LLM 小请求, 后续判断/润色更快; 已预热则不再重复跑
    const aiPreBtn = body.querySelector(".vm-ai-preload");
    if (aiPreBtn) aiPreBtn.addEventListener("click", async () => {
      if (window.__aiPreloaded) {
        if (aiStatus) aiStatus.textContent = "✓ " + t("vm.aiReady", "AI 已就绪！去聊天输入框 → 发送面板 → 🎯 AI 直出，不用再预热");
        return;
      }
      if (aiStatus) aiStatus.textContent = t("vm.aiPreloading", "预加载中…");
      try {
        const pr = (typeof window.preloadAI === "function") ? await window.preloadAI() : null;
        if (pr && pr.ok) {
          aiPreBtn.textContent = "✓ " + t("vm.aiPreloaded", "AI 已预加载");
          if (aiStatus) aiStatus.textContent = "✓ " + t("vm.aiPreloaded", "AI 已预热") + " (" + pr.ms + "ms" + (pr.emotion ? ", " + pr.emotion : "") + ")，再点不再重复预热";
        } else if (aiStatus) {
          aiStatus.textContent = t("vm.aiPreloadFail", "预加载失败") + ": " + ((pr && pr.message) || "unknown");
        }
      } catch (err) { if (aiStatus) aiStatus.textContent = t("vm.aiPreloadFail", "预加载失败") + ": " + ((err && err.message) || err); }
    });
    // GM 全局静音(语音设置内开关): 写 world 设置 → updateSetting hook 广播给全员, 立即静音/恢复
    const gmMuteChk = body.querySelector(".fvtt-tts-vm-gm-mute");
    if (gmMuteChk) gmMuteChk.addEventListener("change", () => {
      try {
        game.settings.set("gpt-sovits-tts", "gmMute", !!gmMuteChk.checked);
        ui.notifications.info(gmMuteChk.checked ? t("vm.gmMuteOn", "全局静音已开启") : t("vm.gmMuteOff", "全局静音已关闭"));
      } catch (e) { /* noop */ }
    });
    // GM 一键分发/收回 AI 配置(世界共享): 分发 = 把 GM 本地的 base/key/model 写入 world 设置 → 全员(含 pl)读取时共享优先
    const shareAll = body.querySelector(".vm-ai-share-all");
    if (shareAll) shareAll.addEventListener("click", async () => {
      try {
        await game.settings.set("gpt-sovits-tts", "aiSharedBase", game.settings.get("gpt-sovits-tts", "llmBaseUrl") || "");
        await game.settings.set("gpt-sovits-tts", "aiSharedKey", game.settings.get("gpt-sovits-tts", "llmKey") || "");
        await game.settings.set("gpt-sovits-tts", "aiSharedModel", game.settings.get("gpt-sovits-tts", "llmModel") || "");
        if (aiStatus) aiStatus.textContent = "✓ " + t("vm.aiSharedOk", "已分发给所有玩家(世界共享，玩家只读)");
      } catch (e) { if (aiStatus) aiStatus.textContent = "✗ " + String(e).slice(0, 60); }
    });
    const shareClear = body.querySelector(".vm-ai-share-clear");
    if (shareClear) shareClear.addEventListener("click", async () => {
      try {
        await game.settings.set("gpt-sovits-tts", "aiSharedBase", "");
        await game.settings.set("gpt-sovits-tts", "aiSharedKey", "");
        await game.settings.set("gpt-sovits-tts", "aiSharedModel", "");
        if (aiStatus) aiStatus.textContent = t("vm.aiSharedCleared", "已收回所有玩家的 AI 配置(玩家回退到各自本地设置)");
      } catch (e) { if (aiStatus) aiStatus.textContent = "✗ " + String(e).slice(0, 60); }
    });
    // 输入即自动检测(700ms 去抖): 输入网址/密钥停一下, 模型下拉自动填充
    let _aiDebT = null;
    const aiAutoDetect = () => { if (_aiDebT) clearTimeout(_aiDebT); _aiDebT = setTimeout(aiDetect, 700); };
    if (aiBaseInp) aiBaseInp.addEventListener("input", aiAutoDetect);
    if (aiKeyInp) aiKeyInp.addEventListener("input", aiAutoDetect);
    if (aiKeyView) aiKeyView.addEventListener("click", () => {
      this._aiKeyShown = !this._aiKeyShown;
      let k = ""; try { k = game.settings.get("gpt-sovits-tts", "llmKey") || ""; } catch (e) { /* noop */ }
      aiKeyInp.value = this._aiKeyShown ? k : "••••••••";
      aiKeyView.textContent = this._aiKeyShown ? "隐藏" : "显示";
    });
    if (aiSaveBtn) aiSaveBtn.addEventListener("click", async () => {
      try {
        await game.settings.set("gpt-sovits-tts", "llmBaseUrl", (aiBaseInp ? aiBaseInp.value.trim() : "") || "https://api.openai.com/v1");
        await game.settings.set("gpt-sovits-tts", "llmKey", aiKeyInp ? aiKeyInp.value.trim() : "");
        await game.settings.set("gpt-sovits-tts", "llmEnabled", true);
        await game.settings.set("gpt-sovits-tts", "llmModel", aiModelSel ? aiModelSel.value : "");
        if (aiStatus) aiStatus.textContent = "✓ " + t("vm.aiSaved", "AI 配置已保存并开启");
      } catch (err) { if (aiStatus) aiStatus.textContent = t("vm.aiSaveFail", "保存失败") + ": " + (err.message || err); }
    });
    if (aiModelSel) aiModelSel.addEventListener("change", () => {
      try { game.settings.set("gpt-sovits-tts", "llmModel", aiModelSel.value || ""); } catch (e) { /* noop */ }
    });
    // 朗读语言(自动翻译目标): 面板内直接切换
    const vmLang = body.querySelector(".fvtt-tts-vm-lang");
    if (vmLang) vmLang.addEventListener("change", () => {
      try { game.settings.set("gpt-sovits-tts", "textLang", vmLang.value || "auto"); } catch (e) { /* noop */ }
    });
    if (isGM) {
      const b = body.querySelector(".fvtt-tts-vm-char");
      // 角色下拉(全员): 换角色立即更新本地语音档案(当前角色/参考音频/提示词/引擎) —
      // pl 尤其关键: 发消息时 flags 携带完整音色参数 → GM 代理按所选角色合成(不再是 GM 默认声音), 立绘也随之正确
      if (b) b.addEventListener("change", () => {
        const nm = b.value;
        if (!nm) return;
        try {
          const prof = loadVoiceProfile();
          prof.current = nm;
          if (!prof.chars) prof.chars = {};
          if (!prof.chars[nm]) prof.chars[nm] = { name: nm, avatar: "", emotion: "", ref: "", auxRef: "", promptText: "", promptLang: "", speed: 0, volume: 0 };
          const cC = ((this.charsData && this.charsData.chars) || []).find(x => x.name === nm);
          prof.chars[nm].emotion = "";
          prof.chars[nm].ref = (cC && cC.ref_audio_path) ? `fvtt_chars/${nm}/${cC.ref_audio_path}` : "";
          prof.chars[nm].promptText = (cC && cC.prompt_text) || "";
          prof.chars[nm].promptLang = (cC && cC.prompt_lang) || "ja";
          prof.chars[nm].ttsProvider = (cC && cC.provider) || "gpt-sovits";
          saveVoiceProfile(prof);
          try { this.render(); } catch (e) { /* noop */ }
        } catch (e) { /* noop */ }
      });
      body.querySelector(".vm-switch").addEventListener("click", async () => {
        const name = b.value;
        if (!name) return;
        this._setBusy(true, t("vm.switchingChar", "切换角色…"));
        try {
          const r = await this._svc("POST", "/characters/switch", { name });
          const j = await r.json();
          if (!r.ok || !j.ok) throw new Error(j.message || "switch failed");
          const prof = loadVoiceProfile();
          prof.current = name;
          if (!prof.chars) prof.chars = {};
          if (!prof.chars[name]) prof.chars[name] = { name, avatar: "", emotion: "", ref: "", auxRef: "", promptText: "", promptLang: "", speed: 0, volume: 0 };
          // 写入该角色主参考(否则朗读走服务端默认角色=串声音)
          prof.chars[name].emotion = "";
          const cC = (this.charsData && this.charsData.chars || []).find(x => x.name === name);
          prof.chars[name].ref = cC && cC.ref_audio_path ? `fvtt_chars/${name}/${cC.ref_audio_path}` : "";
          prof.chars[name].promptText = (cC && cC.prompt_text) || "";
          prof.chars[name].promptLang = (cC && cC.prompt_lang) || "ja";
          await saveVoiceProfile(prof);
          ui.notifications.info(t("vm.switchedChar", "已切换角色") + "：" + name);
        } catch (err) { ui.notifications.error(t("vm.switchCharFail", "切换角色失败") + ": " + (err.message || err)); }
        finally { this._setBusy(false); this.render(); }
      });
      // 多引擎并行: 角色引擎下拉 → 存服务端角色 yaml(全员同角色用同一引擎)
      body.querySelector(".fvtt-tts-vm-provider").addEventListener("change", async () => {
        const nm = body.querySelector(".fvtt-tts-vm-char").value;
        const pv = body.querySelector(".fvtt-tts-vm-provider").value;
        if (!nm) return;
        try {
          const r = await this._svc("POST", "/characters/update", { name: nm, tts_provider: pv });
          const j = await r.json().catch(() => ({}));
          if (!r.ok || !j.ok) throw new Error((j && j.message) || "save failed");
          ui.notifications.info(t("vm.providerSaved", "语音引擎已保存，说话即生效"));
        } catch (err) { ui.notifications.error(t("vm.providerSaveFail", "保存引擎失败") + ": " + (err.message || err)); }
      });
      body.querySelector(".vm-new").addEventListener("click", () => { this.view = "editor"; this.editMode = "new"; this.editName = ""; this._renderBody(); });
      body.querySelector(".vm-edit").addEventListener("click", () => {
        const name = body.querySelector(".fvtt-tts-vm-char").value;
        if (!name) return;
        this.view = "editor"; this.editMode = "edit"; this.editName = name; this._renderBody();
      });
      body.querySelector(".vm-dup").addEventListener("click", () => this._duplicate(body));
      body.querySelector(".vm-export").addEventListener("click", () => this._export(body));
      body.querySelector(".vm-del").addEventListener("click", () => this._delete(body));
      const sw = body.querySelector(".vm-switch-model");
      if (sw) sw.addEventListener("click", () => this._switchModels(body));
    }
  }

  /* ============ 编辑面板（新建/编辑角色 + 10 语气槽） ============ */
  _renderEditor(body) {
    const isGM = !!(game.user && game.user.isGM);
    const newMode = this.editMode === "new";
    const name = this.editName;
    const chars = (this.charsData && this.charsData.chars) || [];
    const char = newMode ? null : chars.find(c => c.name === name) || null;
    const v = this.voicesData || { gpt: [], sovits: [], base_model: { available: false } };

    const back = this.el.querySelector(".fvtt-tts-vm-back");
    if (back) { back.style.display = ""; back.onclick = () => { this.view = "main"; this._renderBody(); }; }

    let html = "";
    if (!isGM) html += `<div class="fvtt-tts-vm-err">${t("vm.gmOnly", "仅 GM 可管理角色")}</div>`;
    if (newMode) {
      // ---- 新建向导 ----
      const gptOpts = v.gpt.map(f => `<option>${esc(f)}</option>`).join("");
      const sovOpts = v.sovits.map(f => `<option>${esc(f)}</option>`).join("");
      html += `<section class="fvtt-tts-vm-sec">
        <div class="fvtt-tts-vm-title2">${t("vm.newCharTitle", "新建角色")}</div>
        <label class="fvtt-tts-vm-row"><span>${t("vm.charName", "角色名称")}</span>
          <input class="vm-new-name" value="">
        </label>
        <div class="fvtt-tts-vm-row"><span>${t("vm.modelSrc", "音色模型来源")}</span>
          <label class="vm-radio"><input type="radio" name="vm-src" value="base" checked> ${t("vm.modelBase", "基础模型（引擎自带，配音频即用）")}</label>
          <label class="vm-radio"><input type="radio" name="vm-src" value="lib"> ${t("vm.modelLib", "模型库（自有权重）")}</label>
        </div>
        <div class="vm-src-lib" style="display:none">
          <label class="fvtt-tts-vm-row"><span>GPT(.ckpt)</span><select class="vm-new-gpt">${gptOpts || `<option value="">${t("vm.noModel", "无")}</option>`}</select></label>
          <label class="fvtt-tts-vm-row"><span>SoVITS(.pth)</span><select class="vm-new-sovits">${sovOpts || `<option value="">${t("vm.noModel", "无")}</option>`}</select></label>
          <div class="fvtt-tts-vm-hint">${t("vm.libHint", "把 .ckpt/.pth 放进引擎 fvtt_chars/models/ 目录后刷新")} — ${esc(v.model_lib_dir || "fvtt_chars/models/")}</div>
        </div>
        <div class="fvtt-tts-vm-row"><span>${t("vm.mainRef", "角色音频")}</span>
          <input class="vm-new-ref" type="file" accept="audio/*" multiple>
          <span class="vm-new-refname" style="color:var(--color-text-light-secondary,#999);font-size:11px"></span>
        </div>
        <div class="fvtt-tts-vm-hint">${t("vm.mainRefHint", "可一次选多段音频：第一段作主参考，其余自动绑定到语气槽（每槽一段，可建好后调整）")}</div>
        <label class="fvtt-tts-vm-row"><span>${t("vm.promptText", "提示文本")}</span>
          <input class="vm-new-prompt" value="">
        </label>
        <label class="fvtt-tts-vm-row"><span>${t("vm.promptLang", "提示语言")}</span>
          <select class="vm-new-promptlang">
            <option value="auto">${t("vm.langAuto", "自动")}</option>
            <option value="zh">中文</option><option value="ja">日本語</option>
            <option value="en">English</option><option value="ko">한국어</option>
          </select>
        </label>
        <div class="fvtt-tts-vm-row">
          <span></span>
          <button type="button" class="fvtt-tts-vm-btn vm-do-create">${t("vm.doCreate", "创建并启用")}</button>
          <button type="button" class="fvtt-tts-vm-btn vm-import-char">${t("vm.importChar", "导入 .char 角色包")}</button>
        </div>
        <input class="vm-import-file" type="file" accept=".char,application/zip" style="display:none">
        <div class="fvtt-tts-vm-hint">${t("vm.newHint", "基础模型 = 引擎自带音色 + 你的参考音频做克隆；模型库 = 自选权重。角色建好后在「编辑角色」里给 10 个语气槽各绑一段音频。")}</div>
      </section>`;
      body.innerHTML = html;
      // 来源切换
      body.querySelectorAll('input[name="vm-src"]').forEach(r => r.addEventListener("change", () => {
        body.querySelector(".vm-src-lib").style.display = body.querySelector('input[name="vm-src"]:checked').value === "lib" ? "" : "none";
      }));
      // 音频(可多选): 第一个作主参考, 其余暂存 → 创建成功后自动绑定额外槽
      let mainRefPath = "";
      this._pendingExtra = [];
      body.querySelector(".vm-new-ref").addEventListener("change", async (ev) => {
        const files = Array.from(ev.target.files || []);
        if (!files.length) return;
        const f0 = files[0];
        this._setBusy(true, t("vm.importing", "上传主参考音频…"));
        try {
          const r = await this._svcFile("POST", "/ref-import", f0);
          const j = await r.json();
          if (!r.ok || !j.ok) throw new Error(j.message || "upload failed");
          mainRefPath = j.ref_audio_path;
          this._pendingExtra = files.slice(1);
          const n = this._pendingExtra.length;
          body.querySelector(".vm-new-refname").textContent = j.ref_audio_path + (n ? `（另 ${n} 段将自动绑定到语气槽）` : "");
        } catch (err) { ui.notifications.error(t("vm.importFail", "参考音频导入失败") + ": " + (err.message || err)); }
        finally { this._setBusy(false); }
      });
      // 导入 .char
      body.querySelector(".vm-import-char").addEventListener("click", () => body.querySelector(".vm-import-file").click());
      body.querySelector(".vm-import-file").addEventListener("change", async (ev) => {
        const f = ev.target.files && ev.target.files[0];
        if (!f) return;
        this._setBusy(true, t("vm.importingChar", "导入角色包…"));
        try {
          const r = await this._svcFile("POST", "/characters/import", f);
          const j = await r.json();
          if (!r.ok || !j.ok) throw new Error(j.message || "import failed");
          const prof = loadVoiceProfile();
          prof.current = j.name;
          prof.chars = prof.chars || {};
          if (!prof.chars[j.name]) prof.chars[j.name] = { name: j.name, avatar: "", emotion: "", ref: "", auxRef: "", promptText: "", promptLang: "", speed: 0, volume: 0 };
          await saveVoiceProfile(prof);
          ui.notifications.info(t("vm.importedChar", "角色包导入成功") + "：" + j.name);
          this.view = "main"; this.editName = ""; this.render();
        } catch (err) { ui.notifications.error(t("vm.importCharFail", "导入角色包失败") + ": " + (err.message || err)); }
        finally { this._setBusy(false); }
      });
      // 创建
      body.querySelector(".vm-do-create").addEventListener("click", async () => {
        const cname = body.querySelector(".vm-new-name").value.trim();
        if (!cname) { ui.notifications.error(t("vm.needName", "请填写角色名称")); return; }
        if (!mainRefPath) { ui.notifications.error(t("vm.needRef", "请先上传主参考音频")); return; }
        const src = body.querySelector('input[name="vm-src"]:checked').value;
        const payload = {
          name: cname,
          use_base_model: src === "base",
          gpt_file: src === "lib" ? (body.querySelector(".vm-new-gpt").value || "") : "",
          sovits_file: src === "lib" ? (body.querySelector(".vm-new-sovits").value || "") : "",
          ref_audio_path: mainRefPath,
          prompt_text: body.querySelector(".vm-new-prompt").value.trim(),
          prompt_lang: body.querySelector(".vm-new-promptlang").value
        };
        this._setBusy(true, t("vm.creating", "创建角色…"));
        try {
          const r = await this._svc("POST", "/characters/create", payload);
          const j = await r.json();
          if (!r.ok || !j.ok) throw new Error(j.message || "create failed");
          // 自动把额外音频绑定到语气槽(开心→轻松→…→困倦 顺序, 每槽一段)
          const EXTRA_ORDER = ["happy", "relaxed", "angry", "sad", "surprised", "shy", "serious", "gentle", "sleepy"];
          const extras = this._pendingExtra || [];
          let bound = 0;
          if (extras.length) {
            this._setBusy(true, t("vm.bindingExtra", "创建完成，正在绑定语气音频…"));
            for (let i = 0; i < extras.length && i < EXTRA_ORDER.length; i++) {
              const f = extras[i], key = EXTRA_ORDER[i];
              try {
                const u = await this._svcFile("POST", "/ref-import?role=" + encodeURIComponent(j.name) + "&slot=" + encodeURIComponent(key), f);
                const uj = await u.json();
                if (!u.ok || !uj.ok) throw new Error(uj.message || "upload failed");
                let prompt = "", lang = "";
                try {
                  const a = await this._svcFile("POST", "/asr?lang=auto", f);
                  if (a.ok) { const aj = await a.json(); if (aj.ok && aj.text) { prompt = aj.text; lang = aj.lang || ""; } }
                } catch (e) { /* 转写失败可手填 */ }
                await this._svc("POST", "/characters/update", { name: j.name, emotions: { [key]: { prompt, lang } } });
                bound++;
              } catch (e) { /* 单段失败继续下一段 */ }
            }
          }
          const prof = loadVoiceProfile();
          prof.current = j.name;
          prof.chars = prof.chars || {};
          if (!prof.chars[j.name]) prof.chars[j.name] = { name: j.name, avatar: "", emotion: "", ref: "", auxRef: "", promptText: "", promptLang: "", speed: 0, volume: 0 };
          await saveVoiceProfile(prof);
          ui.notifications.info(t("vm.created", "角色已创建并启用") + "：" + j.name + (bound ? ` · ${t("vm.boundExtra", "已绑定语气")} ${bound} 段` : ""));
          this.editName = j.name; this.editMode = "edit"; this.render();
        } catch (err) { ui.notifications.error(t("vm.createFail", "创建角色失败") + ": " + (err.message || err)); }
        finally { this._setBusy(false); }
      });
      this._wireFooter("editor");
      return;
    }

    // ---- 编辑现有角色：10 语气槽网格 ----
    const slots = (char && char.emotions) || [];
    const refBase = (char && char.ref_audio_path) ? char.ref_audio_path : "";
    html += `<section class="fvtt-tts-vm-sec">
      <div class="fvtt-tts-vm-title2">${t("vm.editCharTitle", "编辑角色")}: ${esc(name)}</div>
      <div class="fvtt-tts-vm-row"><span>${t("vm.mainRef", "主参考音频")}</span><span class="vm-mainref">${esc(refBase)}</span></div>
    </section>`;
    html += `<section class="fvtt-tts-vm-sec">
      <div class="fvtt-tts-vm-title2">${t("vm.emotionSlots", "10 个语气槽")}</div>
      <div class="fvtt-tts-vm-hint">${t("vm.slotHint", "每槽绑定一段音频 = 该语气用对应音色说；未绑定用主参考。上传后自动转写台词（中文离线，其他语言可能需联网一次）。")}</div>
      ${slots.map(s => `
        <div class="fvtt-tts-vm-slot" data-key="${esc(s.key)}">
          <span class="vm-slot-label">${esc(s.label)}</span>
          <span class="vm-slot-state">${s.bound ? "✓ " + esc(s.ref_audio_path.replace(/^speech\//, "")) : t("vm.slotEmpty", "未绑定")}</span>
          <label class="vm-slot-file"><input type="file" accept="audio/*" style="display:none">${t("vm.slotUpload", "上传")}</label>
          <button type="button" class="fvtt-tts-vm-btn vm-slot-test">${t("vm.slotTest", "试听")}</button>
          <button type="button" class="fvtt-tts-vm-btn vm-slot-clear">${t("vm.slotClear", "清空")}</button>
          <input type="text" class="fvtt-tts-vm-slot-avatar" placeholder="${t("vm.slotAvatarPh", "情绪立绘图片地址(说话时头像随语气切换)")}" value="${esc(s.avatar || "")}">
        </div>`).join("") || `<div class="fvtt-tts-vm-err">${t("vm.noChar", "未加载角色")}</div>`}
      <div class="fvtt-tts-vm-addslot">
        <button type="button" class="fvtt-tts-vm-btn vm-slot-add">${t("vm.addSlot", "＋ 添加自定义语气")}</button>
        <input type="text" class="vm-slot-addinput" placeholder="${t("vm.addSlotPh", "语气名，如：不屑 / 哭泣")}" style="display:none">
        <button type="button" class="fvtt-tts-vm-btn vm-slot-addok" style="display:none">${t("vm.ok", "确定")}</button>
      </div>
    </section>`;
    // ---- 语音样本库: 角色自带样本直接选用 ----
    html += `<section class="fvtt-tts-vm-sec">
      <div class="fvtt-tts-vm-title2">${t("vm.samples", "语音样本库（内置样本）")}</div>
      <div class="fvtt-tts-vm-hint">${t("vm.samplesHint", "角色自带的参考语音，试听后直接绑到任意语气槽（自动带上转写台词）。")}</div>
      <div class="fvtt-tts-vm-samples" id="fvtt-tts-vm-samples"><div class="fvtt-tts-vm-hint">${t("vm.samplesLoading", "加载中…")}</div></div>
    </section>`;
    body.innerHTML = html;
    // 语音样本库(内置样本试听/绑定语气槽)
    this._loadSamples(name, body);
    // 槽上传/试听/清空
    body.querySelectorAll(".fvtt-tts-vm-slot").forEach(row => {
      const key = row.dataset.key;
      const fileInput = row.querySelector("input[type=file]");
      row.querySelector(".vm-slot-file").addEventListener("click", () => fileInput.click());
      fileInput.addEventListener("change", async (ev) => {
        const f = ev.target.files && ev.target.files[0];
        if (!f) return;
        this._setBusy(true, t("vm.slotUploading", "上传语气音频…"));
        try {
          const r = await this._svcFile("POST", "/ref-import?role=" + encodeURIComponent(name) + "&slot=" + encodeURIComponent(key), f);
          const j = await r.json();
          if (!r.ok || !j.ok) throw new Error(j.message || "upload failed");
          // 自动转写台词
          let prompt = "", lang = "";
          try {
            const a = await this._svcFile("POST", "/asr?lang=auto", f);
            if (a.ok) { const aj = await a.json(); if (aj.ok && aj.text) { prompt = aj.text; lang = aj.lang || ""; } }
          } catch (e) { /* 转写失败可手填 */ }
          const up = await this._svc("POST", "/characters/update", { name, emotions: { [key]: { prompt, lang } } });
          const uj = await up.json();
          if (!up.ok || !uj.ok) throw new Error(uj.message || "update failed");
          // 读音频时长(短样本情绪特征不足, 提示建议 3~10 秒)
          let dur = 0;
          try {
            const url = URL.createObjectURL(f);
            const au = new Audio();
            au.src = url;
            await new Promise(r => { au.addEventListener("loadedmetadata", r, { once: true }); au.addEventListener("error", r, { once: true }); });
            dur = au.duration || 0;
            URL.revokeObjectURL(url);
          } catch (e) { dur = 0; }
          const durNote = dur > 0 ? ` · ${dur.toFixed(1)}s` + (dur < 3 ? ` ⚠️${t("vm.refTooShort", "样本过短，情绪特征不足，建议 3~10 秒")}` : "") : "";
          ui.notifications.info(t("vm.slotUploaded", "语气音频已绑定") + durNote + (prompt ? ` · ${t("vm.transcribed", "已自动转写提示文本")}` : ""));
          this.render();
        } catch (err) { ui.notifications.error(t("vm.slotUploadFail", "语气音频绑定失败") + ": " + (err.message || err)); }
        finally { this._setBusy(false); }
      });
      row.querySelector(".vm-slot-test").addEventListener("click", async () => {
        const slot = slots.find(s => s.key === key);
        if (!slot || !slot.ref_audio_path) { ui.notifications.warn(t("vm.slotEmpty", "未绑定")); return; }
        row.querySelector(".vm-slot-test").addEventListener("click", async () => {
        const slot = slots.find(s => s.key === key);
        if (!slot || !slot.ref_audio_path) { ui.notifications.warn(t("vm.slotEmpty", "未绑定")); return; }
        // 合成试听: 情绪槽音频作 TTS 参考 + 台词合成(与朗读一致)
        try { await game.gptSoVitsTTS.speak(slot.prompt_text || "测试语气", { lang: slot.prompt_lang || "auto", refAudioPath: `fvtt_chars/${name}/${slot.ref_audio_path}`, promptText: slot.prompt_text, promptLang: slot.prompt_lang }); }
        catch (e) { /* speak 内提示 */ }
      });
      });
      row.querySelector(".vm-slot-clear").addEventListener("click", async () => {
        this._setBusy(true, t("vm.slotClearing", "清空语气…"));
        try {
          const r = await this._svc("POST", "/characters/update", { name, emotions: { [key]: { ref: "" } } });
          const j = await r.json();
          if (!r.ok || !j.ok) throw new Error(j.message || "clear failed");
          this.render();
        } catch (err) { ui.notifications.error(t("vm.slotClearFail", "清空失败") + ": " + (err.message || err)); }
        finally { this._setBusy(false); }
      });
      // 情绪立绘(说话时聊天头像随语气切换): 填图片地址(URL / modules/xxx.png)
      const avIn = row.querySelector(".fvtt-tts-vm-slot-avatar");
      if (avIn) avIn.addEventListener("change", async () => {
        const av = String(avIn.value || "").trim();
        try {
          const curChar = (this.charsData && this.charsData.chars || []).find(c => c.name === name);
          const slotNow = curChar && (curChar.emotions || []).find(s => s.key === key);
          const r = await this._svc("POST", "/characters/bind-slot", { name, key, file: (slotNow && slotNow.ref_audio_path) || "", avatar: av });
          const j = await r.json();
          if (!r.ok || !j.ok) throw new Error(j.message || "avatar save failed");
          ui.notifications.info(t("vm.slotAvatarSaved", "已保存情绪立绘"));
        } catch (err) { ui.notifications.warn(t("vm.slotAvatarFail", "保存立绘失败") + ": " + (err.message || err)); }
      });
    });
    // 添加自定义语气槽(每个角色独立情绪集, 如阿尔托莉雅/五条悟的自带情绪也这样加)
    const addBtn = body.querySelector(".vm-slot-add");
    const addIn = body.querySelector(".vm-slot-addinput");
    const addOk = body.querySelector(".vm-slot-addok");
    if (addBtn && addIn && addOk) {
      addBtn.addEventListener("click", () => { addIn.style.display = "inline-block"; addOk.style.display = "inline-block"; addIn.focus(); });
      addOk.addEventListener("click", async () => {
        const label = String(addIn.value || "").trim();
        if (!label) { ui.notifications.warn(t("vm.addSlotEmpty", "请输入语气名")); return; }
        this._setBusy(true, t("vm.slotAdding", "添加语气…"));
        try {
          const curChar = (this.charsData && this.charsData.chars || []).find(c => c.name === name);
          const keys = new Set((curChar && curChar.emotions || []).map(s => s.key));
          let n = 1; while (keys.has("custom_" + n)) n++;
          const r = await this._svc("POST", "/characters/bind-slot", { name, key: "custom_" + n, label, file: "", avatar: "" });
          const j = await r.json();
          if (!r.ok || !j.ok) throw new Error(j.message || "add failed");
          ui.notifications.info(t("vm.addSlotDone", "已添加自定义语气") + "：" + label);
          this.render();
        } catch (err) { ui.notifications.error(t("vm.addSlotFail", "添加失败") + ": " + (err.message || err)); }
        finally { this._setBusy(false); }
      });
    }
    this._wireFooter("editor");
  }

  /* ---------- 语音样本库(内置样本试听/绑定语气槽) ---------- */
  async _loadSamples(name, body) {
    const box = body.querySelector("#fvtt-tts-vm-samples");
    if (!box) return;
    try {
      const r = await this._svc("GET", "/samples?role=" + encodeURIComponent(name));
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.message || "load failed");
      const items = j.samples || [];
      if (!items.length) { box.innerHTML = `<div class="fvtt-tts-vm-err">${t("vm.samplesNone", "无可用样本")}</div>`; return; }
      const char = (this.charsData && this.charsData.chars || []).find(c => c.name === name);
      const slotOpts = (char && char.emotions || []).map(s => `<option value="${esc(s.key)}">${esc(s.label)}${s.bound ? "✓" : ""}</option>`).join("");
      box.innerHTML = items.map(it => `
        <div class="fvtt-tts-vm-sample" data-file="${esc(it.file)}">
          <button type="button" class="fvtt-tts-vm-btn vm-smp-play" title="${t("vm.samplesPlay", "试听")}">▶</button>
          <span class="vm-smp-file">${esc(it.file.replace(/^speech\/nanami\//, "speech/"))}</span>
          <span class="vm-smp-text">${esc(it.text || t("vm.samplesNoText", "（无台词）"))}</span>
          <select class="vm-smp-slot"><option value="">${t("vm.samplesBindTo", "绑定到…")}</option>${slotOpts}</select>
          <button type="button" class="fvtt-tts-vm-btn vm-smp-bind">${t("vm.samplesBind", "绑定")}</button>
        </div>`).join("");
      box.querySelectorAll(".fvtt-tts-vm-sample").forEach(row => {
        const file = row.dataset.file;
        row.querySelector(".vm-smp-play").addEventListener("click", async () => {
          try {
            const a = await this._svc("GET", "/samples/audio?role=" + encodeURIComponent(name) + "&file=" + encodeURIComponent(file), { binary: true });
            if (!a.ok || !a.blob) { ui.notifications.warn(t("vm.samplesPlayFail", "试听失败")); return; }
            const blob = a.blob;
            const url = URL.createObjectURL(blob);
            const au = new Audio(url);
            au.onended = () => URL.revokeObjectURL(url);
            au.play().catch(() => URL.revokeObjectURL(url));
          } catch (e) { ui.notifications.warn(t("vm.samplesPlayFail", "试听失败")); }
        });
        row.querySelector(".vm-smp-bind").addEventListener("click", async () => {
          const key = row.querySelector(".vm-smp-slot").value;
          if (!key) { ui.notifications.warn(t("vm.samplesPickSlot", "请先选择语气槽")); return; }
          const it = items.find(x => x.file === file);
          this._setBusy(true, t("vm.samplesBinding", "绑定样本…"));
          try {
            const r = await this._svc("POST", "/characters/bind-slot", { name, key, file, prompt: it ? it.text : "", lang: it ? it.lang : "" });
            const j = await r.json();
            if (!r.ok || !j.ok) throw new Error(j.message || "bind failed");
            ui.notifications.info(t("vm.samplesBound", "已绑定样本到语气槽"));
            this.render();
          } catch (err) { ui.notifications.error(t("vm.samplesBindFail", "绑定失败") + ": " + (err.message || err)); }
          finally { this._setBusy(false); }
        });
      });
    } catch (e) {
      box.innerHTML = `<div class="fvtt-tts-vm-err">${t("vm.samplesLoadFail", "样本加载失败")}: ${esc(e.message || e)}</div>`;
    }
  }

  /* ---------- 角色操作 ---------- */
  async _duplicate(body) {
    const name = body.querySelector(".fvtt-tts-vm-char").value;
    if (!name) return;
    const newName = await this._promptName(t("vm.dupName", "复制为"), name + "副本");
    if (!newName) return;
    this._setBusy(true, t("vm.duping", "复制角色…"));
    try {
      const r = await this._svc("POST", "/characters/duplicate", { name, new_name: newName });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.message || "duplicate failed");
      ui.notifications.info(t("vm.duped", "已复制角色") + "：" + newName);
      this.render();
    } catch (err) { ui.notifications.error(t("vm.dupFail", "复制失败") + ": " + (err.message || err)); }
    finally { this._setBusy(false); }
  }

  async _export(body) {
    const name = body.querySelector(".fvtt-tts-vm-char").value;
    if (!name) return;
    this._setBusy(true, t("vm.exporting", "导出角色…"));
    try {
      const r = await this._svc("GET", "/characters/export?name=" + encodeURIComponent(name), { binary: true });
      if (!r.ok || !r.blob) throw new Error(`HTTP ${r.status}`);
      const blob = r.blob;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${name}.char`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      ui.notifications.info(t("vm.exported", "已导出角色包") + "：" + name + ".char");
    } catch (err) { ui.notifications.error(t("vm.exportFail", "导出失败") + ": " + (err.message || err)); }
    finally { this._setBusy(false); }
  }

  async _delete(body) {
    const name = body.querySelector(".fvtt-tts-vm-char").value;
    if (!name) return;
    if (!window.confirm(t("vm.delConfirm", "确定删除角色") + " " + name + " ?")) return;
    this._setBusy(true, t("vm.deleting", "删除角色…"));
    try {
      const r = await this._svc("POST", "/characters/delete", { name });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.message || "delete failed");
      const prof = loadVoiceProfile();
      if (prof.chars) delete prof.chars[name];
      if (prof.current === name) prof.current = "";
      await saveVoiceProfile(prof);
      ui.notifications.info(t("vm.deleted", "已删除角色") + "：" + name);
      this.render();
    } catch (err) { ui.notifications.error(t("vm.delFail", "删除失败") + ": " + (err.message || err)); }
    finally { this._setBusy(false); }
  }

  async _switchModels(body) {
    const gpt = body.querySelector(".fvtt-tts-vm-gpt")?.value || "";
    const sovits = body.querySelector(".fvtt-tts-vm-sovits")?.value || "";
    if (!gpt && !sovits) { ui.notifications.warn(t("vm.needModel", "模型下拉为空，请把权重放进引擎 fvtt_chars/models/ 后刷新")); return; }
    this._setBusy(true, t("vm.switching", "切换音色模型…"));
    try {
      if (gpt) {
        const r = await this._svc("GET", "/set_gpt_weights?weights_path=" + encodeURIComponent("models/" + gpt));
        if (!r.ok) throw new Error(t("vm.gptFail", "GPT 模型切换失败") + " " + (await r.text()));
      }
      if (sovits) {
        const r = await this._svc("GET", "/set_sovits_weights?weights_path=" + encodeURIComponent("models/" + sovits));
        if (!r.ok) throw new Error(t("vm.sovitsFail", "SoVITS 模型切换失败") + " " + (await r.text()));
      }
      ui.notifications.info(t("vm.switched", "音色模型已切换") + `: ${gpt} / ${sovits}`);
      await this.refresh();
    } catch (err) { ui.notifications.error(String(err.message || err)); }
    finally { this._setBusy(false); }
  }

  _pickAvatar() {
    const FP = (typeof foundry !== "undefined" && foundry.applications && foundry.applications.apps && foundry.applications.apps.FilePicker && foundry.applications.apps.FilePicker.implementation) ? foundry.applications.apps.FilePicker.implementation : (typeof FilePicker !== "undefined" ? FilePicker : null);
    if (!FP) { ui.notifications.warn("FilePicker 不可用"); return; }
    const fp = new FP({ type: "imagevideo", callback: async (path) => {
      const prof = loadVoiceProfile();
      const name = prof.current || "";
      if (!prof.chars) prof.chars = {};
      if (!prof.chars[name]) prof.chars[name] = {};
      prof.chars[name].avatar = path;
      await saveVoiceProfile(prof);
      this._renderBody();
    }});
    fp.render(true);
  }

  _promptName(label, def) {
    return new Promise(res => {
      const v = window.prompt(label, def || "");
      res(v && v.trim() ? v.trim() : null);
    });
  }

  /* ---------- 保存当前档案 ---------- */
  _collect() {
    const body = this.el.querySelector(".fvtt-tts-vm-body");
    if (!body || this.view !== "main") return;
    const prof = loadVoiceProfile();
    const charSel = body.querySelector(".fvtt-tts-vm-char");
    const name = charSel ? charSel.value : prof.current;
    prof.current = name;
    prof.chars = prof.chars || {};
    const cur = prof.chars[name] || { name, avatar: "", emotion: "", ref: "", auxRef: "", promptText: "", promptLang: "", speed: 0, volume: 0 };
    cur.name = body.querySelector(".fvtt-tts-vm-name")?.value.trim() || name;
    cur.emotion = body.querySelector(".fvtt-tts-vm-emotion")?.value || "";
    // 用户要求: 在默认(主参考)基础上添加情绪 → 主参考为基础 + 情绪槽音频作 aux 叠加
    const active = this.activeChar;
    const slot = active ? active.emotions.find(e => e.key === cur.emotion) : null;
    const mainRef = active && active.ref_audio_path ? `fvtt_chars/${active.name}/${active.ref_audio_path}` : "";
    const mainPrompt = (active && active.prompt_text) || "";
    const mainLang = (active && active.prompt_lang) || "ja";
    cur.ref = mainRef;
    cur.promptText = mainPrompt;
    cur.promptLang = mainLang;
    if (slot && slot.ref_audio_path) {
      cur.auxRef = `fvtt_chars/${active.name}/${slot.ref_audio_path}`;
      if (slot.prompt_text) { cur.promptText = slot.prompt_text; cur.promptLang = slot.prompt_lang || mainLang; }
    } else {
      cur.auxRef = "";
    }
    const spd = parseFloat(body.querySelector(".fvtt-tts-vm-speed")?.value) || 0;
    const vol = parseFloat(body.querySelector(".fvtt-tts-vm-vol")?.value) || 0;
    cur.speed = spd === 1 ? 0 : spd;
    cur.volume = vol === 1 ? 0 : vol;
    prof.chars[name] = cur;
    this._prof = prof;
  }

  _save() {
    this._collect();
    if (!this._prof) return;
    try {
      saveVoiceProfile(this._prof);
      ui.notifications.info(t("vm.saved", "语音设置已保存"));
    } catch (e) {
      console.error("[gpt-sovits-tts] 保存失败", e);
      ui.notifications.error(t("vm.saveFail", "保存失败"));
    }
  }

  /* ---------- 底部按钮 ---------- */
  _wireFooter(view) {
    const back = this.el.querySelector(".fvtt-tts-vm-back");
    if (view === "main") { if (back) back.style.display = "none"; }
    else { if (back) back.style.display = ""; }
    const test = this.el.querySelector(".fvtt-tts-vm-test");
    const save = this.el.querySelector(".fvtt-tts-vm-save");
    test.onclick = async () => {
      if (this.view === "editor") { this._renderBody(); return; }
      this._collect();
      const phrase = t("ui.testPhrase", "你好，我是七海千秋。测试成功！");
      try { await game.gptSoVitsTTS.speak(phrase); } catch (e) { /* speak 内提示 */ }
    };
    save.onclick = () => { this._save(); this.close(); };
  }

  _setBusy(busy, label) {
    this.busy = busy;
    if (!this.el || !document.body.contains(this.el)) return;
    const save = this.el.querySelector(".fvtt-tts-vm-save");
    const test = this.el.querySelector(".fvtt-tts-vm-test");
    if (save) { save.disabled = busy; save.textContent = busy ? label : t("vm.save", "保存"); }
    if (test) test.disabled = busy;
  }

  close() {
    if (this.el) { this.el.remove(); this.el = null; }
    VoiceManager._instance = null;
  }
}

/* ============ 本地化与工具 ============ */
function getCfgSafe() {
  try { return { serverUrl: game.settings.get(MODULE, "serverUrl") }; }
  catch (e) { return { serverUrl: "http://127.0.0.1:9880" }; }
}

function t(key, def) {
  const k = `${MODULE}.${key}`;
  try {
    const v = game.i18n.localize(k);
    if (v !== k) return v;
  } catch (e) { /* noop */ }
  return def ?? key;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
