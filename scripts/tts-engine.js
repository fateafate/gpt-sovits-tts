/**
 * gpt-sovits-tts — TTS 引擎层
 * 提供: 播放队列(排队/打断)、音频播放、GPT-SoVITS 请求、浏览器 WebSpeech 合成
 */

/* ---------- 播放队列 ---------- */
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
export function audioPlay(src, { volume = 1, onStart = null } = {}) {
  const vol = Math.min(1, Math.max(0, Number(volume) || 0));
  return new Promise((resolve) => {
    let settled = false;
    let iv = null;
    const done = () => {
      if (settled) return;
      settled = true;
      if (iv) { clearInterval(iv); iv = null; }
      resolve();
    };
    const nativeFallback = () => {
      // 兜底: 原生 Audio(支持 data: URI / blob URL, 一定可播)
      const audio = new Audio(src);
      audio.volume = vol;
      let settledN = false;
      let ivN = null;
      const doneN = () => { if (settledN) return; settledN = true; if (ivN) { clearInterval(ivN); ivN = null; } resolve(); };
      audio.addEventListener("ended", doneN);
      audio.addEventListener("error", doneN);
      try { audio.play().then(() => { try { if (onStart) onStart(); } catch (e) { /* noop */ } }).catch(doneN); } catch (e) { doneN(); }
      ivN = setTimeout(doneN, 60000);
    };
    if (!/^(blob:|data:)/.test(String(src || "")) && game && game.audio && typeof game.audio.play === "function") {
      // Foundry 音频通道: 不指定 channel, 走普通音频播放(跟随主音量), 不受"界面音效"开关限制
      try {
        game.audio.play(src, { volume: vol, autoplay: true, loop: false })
          .then((helper) => {
            try { if (onStart) onStart(); } catch (e) { /* noop */ }
            if (helper && typeof helper.isPlaying === "function") {
              iv = setInterval(() => {
                try { if (!helper.isPlaying) done(); } catch (e) { done(); }
              }, 250);
              setTimeout(done, 90000);   // 兜底: 90s 后放行队列
            } else {
              // 无 isPlaying 接口: 按常见语音长度放行(最长语音约 30s 足够)
              setTimeout(done, 30000);
            }
          })
          .catch(nativeFallback);   // Foundry 播放失败(data URI 等) → 原生兜底, 不静默
        return;
      } catch (e) { /* fallthrough */ }
    }
    nativeFallback();
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
export async function gptSovitsSynth(text, lang, { serverUrl, speedFactor = 1, overrides = null, mediaType = "wav", asBlob = false } = {}) {
  const base = String(serverUrl || "http://127.0.0.1:9880").replace(/\/+$/, "");
  const payload = {
    text: String(text),
    text_lang: lang,
    speed_factor: speedFactor,
    streaming_mode: false,
    media_type: mediaType,
    allow_short_ref: true   // 允许 <3s 参考音频(语气样本等), 服务端自动静音补足
  };
  if (overrides) {
    if (overrides.refAudioPath) payload.ref_audio_path = overrides.refAudioPath;
    if (overrides.promptText) payload.prompt_text = overrides.promptText;
    if (overrides.promptLang) payload.prompt_lang = overrides.promptLang;
    if (overrides.auxRefAudioPaths && overrides.auxRefAudioPaths.length) payload.aux_ref_audio_paths = overrides.auxRefAudioPaths; // 主参考基础上叠加情绪特征
    if (typeof overrides.emotionMix === "number") payload.emotion_mix = overrides.emotionMix; // 情绪占比: 0纯默认 ~ 1全情绪
    if (overrides.textSplitMethod) payload.text_split_method = overrides.textSplitMethod;   // 切分方式(风格提示词: 连贯不中断→no/少切分)
    if (typeof overrides.fragmentInterval === "number") payload.fragment_interval = overrides.fragmentInterval; // 句间间隔(连贯→更小)
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  try {
    const resp = await fetch(base + "/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal
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
    clearTimeout(timer);
  }
}

/** 探测服务端状态 */
export async function gptSovitsStatus(serverUrl) {
  const base = String(serverUrl || "http://127.0.0.1:9880").replace(/\/+$/, "");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
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
