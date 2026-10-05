/**
 * gpt-sovits-tts — 朗读文本预处理
 * 语种选择: 目标语言不是 auto 时, 先整句翻译(可选), 再把数字/标记转为目标语读法,
 * 例如 12345 → 一万二千三百四十五(zh/ja) / twelve thousand three hundred forty-five(en)。
 */
const _digitZh = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
const _digitEn = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const _teens = ["ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const _tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** 非负整数 → 中文读法(万/亿分段), zh 与 ja 汉字读法同形 */
export function numToZh(n) {
  n = Math.floor(Number(n));
  if (!Number.isFinite(n) || n < 0) return String(n);
  if (n === 0) return "零";
  const groups = [];
  let g = 0;
  while (n > 0) {
    groups.push(n % 10000);
    n = Math.floor(n / 10000);
    g++;
  }
  const seg = (v) => {
    if (v === 0) return "";
    const parts = [];
    if (v >= 1000) { parts.push(_digitZh[Math.floor(v / 1000)] + "千"); v %= 1000; }
    if (v >= 100) { parts.push(_digitZh[Math.floor(v / 100)] + "百"); v %= 100; }
    if (v >= 10) {
      const t = Math.floor(v / 10);
      parts.push((t === 1 ? "一" : _digitZh[t]) + "十");
      v %= 10;
    }
    if (v > 0) parts.push(_digitZh[v]);
    return parts.join("");
  };
  const bigUnits = ["", "万", "亿", "万亿"];
  let out = "";
  for (let i = groups.length - 1; i >= 0; i--) {
    const s = seg(groups[i]);
    if (s) out += s + bigUnits[i];
    else if (out) out += "零"; // 中间空档补零(简化处理)
  }
  return out.replace(/零+(?=[万亿]|$)/g, "").replace(/零+/g, "零") || "零";
}

/** 非负整数 → 英文读法 */
export function numToEn(n) {
  n = Math.floor(Number(n));
  if (!Number.isFinite(n) || n < 0) return String(n);
  if (n === 0) return "zero";
  const under1000 = (v) => {
    let out = [];
    if (v >= 100) { out.push(_digitEn[Math.floor(v / 100)] + " hundred"); v %= 100; }
    if (v >= 20) { out.push(_tens[Math.floor(v / 10)]); v %= 10; if (v) out.push(_digitEn[v]); }
    else if (v >= 10) { out.push(_teens[v - 10]); v = 0; }
    else if (v > 0) out.push(_digitEn[v]);
    return out.join(" ");
  };
  const chunks = [];
  while (n >= 1000) { chunks.push(n % 1000); n = Math.floor(n / 1000); }
  chunks.push(n);
  const names = ["", " thousand", " million", " billion"];
  let out = [];
  for (let i = chunks.length - 1; i >= 0; i--) {
    if (chunks[i]) out.push(under1000(chunks[i]) + names[i]);
  }
  return out.join(", ") || "zero";
}

/** 文本里的数字 → 目标语读法 (保留小数/负号/百分比基础形式) */
export function localizeNumbers(text, lang) {
  if (!text) return text;
  const out = String(text).replace(/(\d+(?:\.\d+)?)/g, (m) => {
    const neg = m.startsWith("-");
    const body = neg ? m.slice(1) : m;
    const [int, frac] = body.split(".");
    const zh = lang === "zh" || lang === "ja";
    let rep = zh ? numToZh(parseInt(int, 10)) : numToEn(parseInt(int, 10));
    if (frac !== undefined) {
      const point = zh ? "点" : " point ";
      const digits = frac.split("").map(d => (zh ? _digitZh[Number(d)] : _digitEn[Number(d)])).join(zh ? "" : " ");
      rep += point + digits;
    }
    return (neg ? (zh ? "负" : "minus ") : "") + rep;
  });
  return out;
}

/* ---------- 整句翻译(可选): MyMemory 免费 API, 失败回退原文 ---------- */
const _transCache = new Map();
let _transBusy = new Map();

async function _mymemory(text, from, to) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${from}|${to}`;
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return null;
    const j = await r.json();
    const t = j && j.responseData && j.responseData.translatedText;
    return (typeof t === "string" && t.trim()) ? t.trim() : null;
  } catch (e) { return null; }
  finally { clearTimeout(timer); }
}

/**
 * 把文本准备成目标语朗读:
 *  - translate=true 且目标语明确: 先整句翻译; 翻译失败时语言回退为源语言(避免原文交给目标语引擎乱读)
 *  - 之后把残留的阿拉伯数字按"最终生效语言"转为读法
 * @returns {{ text: string, ok: boolean, lang: string }}  ok=是否成功翻译; lang=最终生效语言
 */
export async function prepareTextForLang(text, lang, { translate = false } = {}) {
  const src = String(text || "").trim();
  if (!src) return { text: src, ok: false, lang: lang || "auto" };
  const target = String(lang || "auto").toLowerCase();
  let body = src;
  let ok = false;
  let effective = target;
  if (translate && target !== "auto") {
    // 判断源语言特征
    const looksLike = /[\u4e00-\u9fff]/.test(src) ? "zh" : (/[\u3040-\u30ff]/.test(src) ? "ja" : (/[a-zA-Z]/.test(src) ? "en" : ""));
    if (looksLike && looksLike !== target) {
      const key = `${target}|${src}`;
      if (_transCache.has(key)) {
        const t = _transCache.get(key);
        if (t) { body = t; ok = true; }
        else effective = looksLike;
      } else {
        let p = _transBusy.get(key);
        if (!p) {
          p = _mymemory(src, looksLike, target).then(t => { _transCache.set(key, t || ""); return t; });
          _transBusy.set(key, p);
          p.finally(() => _transBusy.delete(key)).catch(() => {});
        }
        const t = await p;
        if (t) { body = t; ok = true; }
        else effective = looksLike;   // 翻译失败: 语言回退为源语言, 不把原文交给目标语引擎
      }
    }
  }
  // 数字本地化(按最终生效语言): 中文/英文转读法; 日语交给 GPT-SoVITS 引擎自带数字读法(更准)
  if (effective === "zh" || effective === "en") body = localizeNumbers(body, effective);
  return { text: body, ok, lang: effective };
}

/** 兼容别名 */
export function detectNumeralRead(text, lang) { return localizeNumbers(text, lang); }
