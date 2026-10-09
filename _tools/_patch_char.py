# -*- coding: utf-8 -*-
"""补丁: 把源包 .char 的 sprites+emotion_tags+setting 合并写回 fvtt_chars/丛雨/character.yaml(保留模型字段)."""
import sys, os
sys.stdout.reconfigure(encoding="utf-8")
import yaml, zipfile

src = r"H:\mod2\语音合成\语音模型\丛雨.char"
target = r"H:\mod2\Data\modules\gpt-sovits-tts\engine\fvtt_chars\丛雨\character.yaml"
z = zipfile.ZipFile(src)
yaml_name = [n for n in z.namelist() if n.replace("\\", "/").endswith("character.yaml")][0]
cfg = yaml.safe_load(z.read(yaml_name).decode("utf-8"))
cfg = cfg[0] if isinstance(cfg, list) and cfg else cfg
with open(target, "r", encoding="utf-8") as f:
    cur = yaml.safe_load(f) or {}
cur = cur[0] if isinstance(cur, list) and cur else cur
for k in ("sprites", "emotion_tags", "character_setting", "color", "sprite_prefix", "sprite_scale"):
    if cfg.get(k) is not None:
        cur[k] = cfg[k]
with open(target, "w", encoding="utf-8") as f:
    yaml.safe_dump(cur, f, allow_unicode=True, sort_keys=False)
print("PATCHED:", target)
print("keys:", sorted(cur.keys()))
print("sprites:", len(cur.get("sprites") or []))
print("emotion_tags lines:", len(str(cur.get("emotion_tags", "") or "").splitlines()))
