/**
 * gpt-sovits-tts — 听写引擎层 (语音→文字)
 * 浏览器引擎: Web Speech API (Chrome/Edge)
 * 服务端引擎: MediaRecorder 录音 -> POST /asr (funasr / faster-whisper)
 */

const SR = () => window.SpeechRecognition || window.webkitSpeechRecognition;

export const BrowserSTT = {
  supported() {
    return !!SR();
  },
  /**
   * @returns 会话对象 { stop() }
   */
  start({ lang = "zh-CN", onResult, onError, onState } = {}) {
    const R = SR();
    const rec = new R();
    rec.lang = lang;
    rec.continuous = false;
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    let retries = 0;
    let willRetry = false;
    let finalEnded = false;

    rec.onresult = (ev) => {
      let text = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        if (res.isFinal) text += res[0].transcript;
      }
      if (text && onResult) onResult(text.trim());
    };
    rec.onerror = (ev) => {
      const err = ev.error || "error";
      // no-speech: 常见于第一次没抓到声/设备切换, 自动重试最多 2 次
      if ((err === "no-speech" || err === "no-speech-message") && retries < 2) {
        retries++;
        willRetry = true;
        try { rec.start(); } catch (e) { willRetry = false; if (onError) onError(err); }
        return;
      }
      willRetry = false;
      if (onError) onError(err);
    };
    rec.onend = () => {
      if (willRetry) return;   // 重试中, 不算结束
      finalEnded = true;
      if (onState) onState(false);
    };

    try { rec.start(); if (onState) onState(true); } catch (e) { if (onError) onError("start_failed"); }

    return {
      active: true,
      stop() {
        try { rec.stop(); } catch (e) { /* noop */ }
        this.active = false;
      }
    };
  }
};

export const ServerSTT = {
  supported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  },
  /**
   * @returns 会话对象 { stop() }
   */
  start({ serverUrl, lang = "zh", deviceId = "", onResult, onError, onState } = {}) {
    const base = String(serverUrl || "http://127.0.0.1:9880").replace(/\/+$/, "");
    let recorder = null;
    let stream = null;
    let stopped = false;

    const finalize = async (blob, mime) => {
      if (onState) onState(false);
      try {
        const resp = await fetch(`${base}/asr?lang=${encodeURIComponent(lang)}`, {
          method: "POST",
          headers: { "Content-Type": mime || "audio/webm" },
          body: blob,
          signal: AbortSignal.timeout(60000)
        });
        if (!resp.ok) {
          let d = "";
          try { d = (await resp.text()).slice(0, 300); } catch (e) { /* noop */ }
          throw new Error(`ASR 服务返回 ${resp.status}: ${d}`);
        }
        const data = await resp.json();
        if (data.ok && data.text) onResult && onResult(data.text);
        else onError && onError(data.message || "empty");
      } catch (e) {
        onError && onError(String(e.message || e));
      } finally {
        if (stream) stream.getTracks().forEach(t => t.stop());
      }
    };

    const session = {
      active: true,
      stop() {
        this.active = false;
        if (recorder && recorder.state !== "inactive") {
          recorder.stop(); // onstop 触发 finalize
        } else {
          stopped = true;
          if (stream) stream.getTracks().forEach(t => t.stop());
        }
      }
    };

    const audioCfg = deviceId ? { audio: { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true } } : { audio: true };
    navigator.mediaDevices.getUserMedia(audioCfg).then((s) => {
      if (session.active === false) { s.getTracks().forEach(t => t.stop()); return; }
      stream = s;
      const mime = MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm" : (MediaRecorder.isTypeSupported("audio/mp4") ? "audio/mp4" : "");
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks = [];
      recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
      recorder.onstop = () => {
        if (stopped) { if (stream) stream.getTracks().forEach(t => t.stop()); return; }
        const blob = new Blob(chunks, { type: mime || "audio/webm" });
        finalize(blob, mime || "audio/webm");
      };
      recorder.onerror = (ev) => { onError && onError(String(ev.error || "recorder_error")); };
      recorder.start();
      if (onState) onState(true);
    }).catch((e) => {
      onError && onError(String(e && e.message || e));
      if (onState) onState(false);
    });

    return session;
  }
};
