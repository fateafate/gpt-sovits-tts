// 批量转写角色 speech 样本 → speech_library.json (台词库)
// 用法: node transcribe_library.js <角色名> [并发数]
const fs = require("fs");
const path = require("path");
const role = process.argv[2] || "七海千秋";
const concurrency = parseInt(process.argv[3] || "4", 10);
const root = path.resolve(__dirname, "..", "engine", "fvtt_chars", role);
const speechDir = path.join(root, "speech", "nanami");
const base = "http://127.0.0.1:9880";

(async () => {
  if (!fs.existsSync(speechDir)) { console.error("speech dir missing:", speechDir); process.exit(1); }
  const files = fs.readdirSync(speechDir).filter(f => /^nanami_voice_\d+\.wav$/.test(f)).sort();
  console.log(`[transcribe] ${files.length} samples for ${role}`);
  const out = [];
  const queue = [...files];
  let done = 0;
  async function worker() {
    while (queue.length) {
      const f = queue.shift();
      const buf = fs.readFileSync(path.join(speechDir, f));
      let rec = { file: f, size: buf.length, text: "", lang: "ja", ok: false };
      try {
        const r = await fetch(base + "/asr?lang=ja", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: new Uint8Array(buf), signal: AbortSignal.timeout(180000) });
        const j = await r.json();
        if (r.ok && j.ok) { rec.text = (j.text || "").trim(); rec.lang = j.lang || "ja"; rec.ok = !!rec.text; }
        else rec.err = j.message || ("HTTP " + r.status);
      } catch (e) { rec.err = e.message; }
      out.push(rec);
      done++;
      console.log(`[${done}/${files.length}] ${f} => ${JSON.stringify(rec.text.slice(0, 50))}${rec.err ? "  ERR:" + rec.err : ""}`);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  fs.writeFileSync(path.join(root, "speech_library.json"), JSON.stringify(out, null, 1), "utf8");
  const ok = out.filter(o => o.ok).length;
  console.log(`DONE ${ok}/${out.length}  → speech_library.json`);
})().catch(e => { console.error("FAIL", e); process.exit(1); });
