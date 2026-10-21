#!/usr/bin/env node
/**
 * 发布前自检（1.6.118）
 *   node tools/preflight.mjs
 * 检查: JS 语法 / Python 编译 / JSON 解析 / module.json 无 BOM / 版本一致性 / git 工作区
 * 退出码: 0 = 全部通过; 1 = 有失败项
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rows = [];
const add = (name, ok, detail = "") => rows.push({ name, ok, detail });
const rel = (p) => path.relative(ROOT, p) || ".";

// ① JS 语法
const scriptsDir = path.join(ROOT, "scripts");
for (const f of fs.readdirSync(scriptsDir).filter((x) => x.endsWith(".js"))) {
  const r = spawnSync(process.execPath, ["--check", path.join(scriptsDir, f)], { encoding: "utf8" });
  add("JS 语法 " + f, r.status === 0, r.status === 0 ? "" : (r.stderr || "").split("\n")[0].slice(0, 120));
}

// ② Python 编译（用引擎自带 runtime，没有就跳过）
const py = path.join(ROOT, "engine", "runtime", "python.exe");
const api = path.join(ROOT, "server", "fvtt_api.py");
if (fs.existsSync(py) && fs.existsSync(api)) {
  const r = spawnSync(py, ["-m", "py_compile", api], { encoding: "utf8" });
  add("Python 编译 server/fvtt_api.py", r.status === 0, r.status === 0 ? "" : (r.stderr || "").split("\n")[0].slice(0, 120));
} else {
  add("Python 编译（跳过：未找到 engine/runtime/python.exe 或 server/fvtt_api.py）", true, "skipped");
}

// ③ JSON 解析
for (const f of ["module.json", "languages/cn.json", "languages/en.json"]) {
  const p = path.join(ROOT, f);
  try {
    JSON.parse(fs.readFileSync(p, "utf8"));
    add("JSON " + f, true);
  } catch (e) {
    add("JSON " + f, false, String(e.message).slice(0, 120));
  }
}

// ④ module.json 无 BOM
try {
  const b = fs.readFileSync(path.join(ROOT, "module.json"));
  const hasBom = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
  add("module.json 无 BOM", !hasBom, hasBom ? "发现 BOM，Foundry 可能读不出模块" : "");
} catch (e) {
  add("module.json 无 BOM", false, String(e.message).slice(0, 120));
}

// ⑤ 版本一致性
try {
  const mj = JSON.parse(fs.readFileSync(path.join(ROOT, "module.json"), "utf8"));
  const main = fs.readFileSync(path.join(ROOT, "scripts", "main.js"), "utf8");
  const mv = /const MOD_VERSION = "([^"]+)"/.exec(main);
  const same = mj.version === (mv && mv[1]);
  add("版本一致 module.json=" + mj.version + " / MOD_VERSION=" + (mv ? mv[1] : "?"), same, same ? "" : "两处版本不一致，发布前必须同步");
} catch (e) {
  add("版本一致性", false, String(e.message).slice(0, 120));
}

// ⑥ 语言文件 key 对齐（cn vs en）
try {
  const flat = (o, pre = "", out = {}) => {
    for (const k of Object.keys(o)) {
      const v = o[k];
      const key = pre ? pre + "." + k : k;
      if (v && typeof v === "object" && !Array.isArray(v)) flat(v, key, out);
      else out[key] = v;
    }
    return out;
  };
  const cn = flat(JSON.parse(fs.readFileSync(path.join(ROOT, "languages", "cn.json"), "utf8")));
  const en = flat(JSON.parse(fs.readFileSync(path.join(ROOT, "languages", "en.json"), "utf8")));
  const miss = Object.keys(cn).filter((k) => !(k in en));
  add("语言 key 对齐（cn=" + Object.keys(cn).length + " / en=" + Object.keys(en).length + "）", miss.length === 0, miss.slice(0, 5).join(", "));
} catch (e) {
  add("语言 key 对齐", false, String(e.message).slice(0, 120));
}

// ⑦ git 工作区（干净才算可发布）
try {
  const r = spawnSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" });
  const dirty = (r.stdout || "").trim();
  add("git 工作区干净", !dirty, dirty ? dirty.split("\n").length + " 个未提交改动" : "");
} catch (e) {
  add("git 工作区干净", true, "git 不可用，已跳过");
}

// 输出
let fail = 0;
console.log("\n=== 发布前自检 ===\n");
for (const r of rows) {
  if (!r.ok) fail++;
  console.log((r.ok ? "  ✓ " : "  ✗ ") + r.name + (r.detail ? "  — " + r.detail : ""));
}
console.log("\n" + (fail === 0 ? "全部通过 ✓" : "有 " + fail + " 项失败 ✗") + "\n");
process.exit(fail === 0 ? 0 : 1);
