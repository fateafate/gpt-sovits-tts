"""
# WebAPI文档 (fvtt_api.py — GPT-SoVITS API for Foundry VTT TTS module)

本文件是 GPT-SoVITS 官方 `api_v2.py` 的改版（MIT License 允许复制修改，见原项目
https://github.com/RVC-Boss/GPT-SoVITS ）。相对原版新增:

1. CORS 中间件(允许浏览器里运行的 Foundry VTT 直接调用本接口)
2. `--char <角色包character.yaml>`: 启动时自动加载角色包(GPT权重+SoVITS权重+参考音频+提示文本),
   之后调用 `/tts` 时无需再传 ref_audio_path / prompt_text / prompt_lang, 直接传 text 即可
3. `--gpt/--sovits/--ref/--prompt-text/--prompt-lang/--device/--no-half`: 手动指定模型/参数
4. `GET /status`: 返回服务状态(供 Foundry 模块显示连接状态)
5. `GET /characters`: 返回已加载的角色信息

` python fvtt_api.py -a 0.0.0.0 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml --char "chars/七海千秋/character.yaml" `

## 执行参数:
    `-a` - `绑定地址, 默认"127.0.0.1"(仅本机); 想让其他人也能访问请填 0.0.0.0`
    `-p` - `绑定端口, 默认9880`
    `-c` - `TTS配置文件路径, 默认"GPT_SoVITS/configs/tts_infer.yaml"`
    `--char` - `角色包 character.yaml 路径(可选), 启动后自动加载该角色`
    `--gpt` / `--sovits` - 手动指定 GPT/SoVITS 权重路径(可选, 与 --char 二选一或覆盖)
    `--ref` - 参考音频 wav 路径(可选)
    `--prompt-text` / `--prompt-lang` - 参考音频的提示文本和语言(可选)
    `--device` - `cuda|cpu|auto(默认 auto: 有显卡用cuda, 否则cpu)`
    `--no-half` - 强制关闭半精度(内存紧张时使用)

## 调用:

### 推理

endpoint: `/tts`
GET:
```
http://127.0.0.1:9880/tts?text=先帝创业未半而中道崩殂，今天下三分，益州疲弊，此诚危急存亡之秋也。&text_lang=zh&ref_audio_path=archive_jingyuan_1.wav&prompt_lang=zh&prompt_text=我是「罗浮」云骑将军景元。不必拘谨，「将军」只是一时的身份，你称呼我景元便可&text_split_method=cut5&batch_size=1&media_type=wav&streaming_mode=true
```

POST:
```json
{
    "text": "",                   # str.(required) text to be synthesized
    "text_lang: "",               # str.(required) language of the text to be synthesized
    "ref_audio_path": "",         # str.(required) reference audio path
    "aux_ref_audio_paths": [],    # list.(optional) auxiliary reference audio paths for multi-speaker tone fusion
    "prompt_text": "",            # str.(optional) prompt text for the reference audio
    "prompt_lang": "",            # str.(required) language of the prompt text for the reference audio
    "top_k": 15,                  # int. top k sampling
    "top_p": 1,                   # float. top p sampling
    "temperature": 1,             # float. temperature for sampling
    "text_split_method": "cut5",  # str. text split method, see text_segmentation_method.py for details.
    "batch_size": 1,              # int. batch size for inference
    "batch_threshold": 0.75,      # float. threshold for batch splitting.
    "split_bucket": True,         # bool. whether to split the batch into multiple buckets.
    "speed_factor":1.0,           # float. control the speed of the synthesized audio.
    "fragment_interval":0.3,      # float. to control the interval of the audio fragment.
    "seed": -1,                   # int. random seed for reproducibility.
    "parallel_infer": True,       # bool. whether to use parallel inference.
    "repetition_penalty": 1.35,   # float. repetition penalty for T2S model.
    "sample_steps": 32,           # int. number of sampling steps for VITS model V3.
    "super_sampling": False,      # bool. whether to use super-sampling for audio when using VITS model V3.
    "streaming_mode": False,      # bool or int. return audio chunk by chunk.T he available options are: 0,1,2,3 or True/False (0/False: Disabled | 1/True: Best Quality, Slowest response speed (old version streaming_mode) | 2: Medium Quality, Slow response speed | 3: Lower Quality, Faster response speed )
    "overlap_length": 2,          # int. overlap length of semantic tokens for streaming mode.
    "min_chunk_length": 16,       # int. The minimum chunk length of semantic tokens for streaming mode. (affects audio chunk size)
}
```

RESP:
成功: 直接返回 wav 音频流， http code 200
失败: 返回包含错误信息的 json, http code 400

### 命令控制

endpoint: `/control`

command:
"restart": 重新运行
"exit": 结束运行

GET:
```
http://127.0.0.1:9880/control?command=restart
```
POST:
```json
{
    "command": "restart"
}
```

RESP: 无


### 切换GPT模型

endpoint: `/set_gpt_weights`

GET:
```
http://127.0.0.1:9880/set_gpt_weights?weights_path=GPT_SoVITS/pretrained_models/s1bert25hz-2kh-longer-epoch=68e-step=50232.ckpt
```
RESP:
成功: 返回"success", http code 200
失败: 返回包含错误信息的 json, http code 400


### 切换Sovits模型

endpoint: `/set_sovits_weights`

GET:
```
http://127.0.0.1:9880/set_sovits_weights?weights_path=GPT_SoVITS/pretrained_models/s2G488k.pth
```

RESP:
成功: 返回"success", http code 200
失败: 返回包含错误信息的 json, http code 400

"""

import os
import sys
# 控制台/stdout 一律 UTF-8 容错(Windows 默认 GBK 会因 emoji 等非 BMP 字符崩溃: 'gbk' codec can't encode)
try:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
import shutil
import re
import time
import traceback
from typing import Generator, Union

now_dir = os.getcwd()
sys.path.append(now_dir)
sys.path.append("%s/GPT_SoVITS" % (now_dir))

import argparse
import subprocess
import wave
import signal
import json
import urllib.request
import numpy as np
import soundfile as sf
from fastapi import FastAPI, Response, Request
from fastapi.responses import StreamingResponse, JSONResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
from io import BytesIO
import uuid
from tools.i18n.i18n import I18nAuto
from GPT_SoVITS.TTS_infer_pack.TTS import TTS, TTS_Config
from GPT_SoVITS.TTS_infer_pack.text_segmentation_method import get_method_names as get_cut_method_names
from pydantic import BaseModel
import threading
from collections import OrderedDict

# print(sys.path)
i18n = I18nAuto()
cut_method_names = get_cut_method_names()

parser = argparse.ArgumentParser(description="GPT-SoVITS api (FVTT edition)")
parser.add_argument("-c", "--tts_config", type=str, default="GPT_SoVITS/configs/tts_infer.yaml", help="tts_infer路径")
parser.add_argument("-a", "--bind_addr", type=str, default="0.0.0.0", help="默认 0.0.0.0 以便局域网内玩家也能访问; 只本机用填 127.0.0.1")
parser.add_argument("-p", "--port", type=int, default="9881", help="default: 9881")
parser.add_argument("--char", type=str, default=None, help="角色包 character.yaml 路径, 启动时自动加载(推荐用法)")
parser.add_argument("--gpt", type=str, default=None, help="手动指定 GPT 权重 ckpt 路径(可选)")
parser.add_argument("--sovits", type=str, default=None, help="手动指定 SoVITS 权重 pth 路径(可选)")
parser.add_argument("--ref", type=str, default=None, help="手动指定参考音频 wav 路径(可选)")
parser.add_argument("--prompt-text", type=str, default=None, help="参考音频的提示文本(可选)")
parser.add_argument("--prompt-lang", type=str, default=None, help="提示文本语言, 如 ja/zh/en(可选)")
parser.add_argument("--device", type=str, default="auto", choices=["auto", "cuda", "cpu"], help="TTS 推理设备(默认auto: 有显卡用cuda)")
parser.add_argument("--no-half", action="store_true", help="关闭半精度(显存紧张时使用)")
parser.add_argument("--asr-engine", type=str, default="auto", choices=["auto", "funasr", "whisper", "off"], help="本地听写引擎: auto=中文用funasr, 其余用whisper; off=关闭")
parser.add_argument("--asr-device", type=str, default="cpu", choices=["cpu", "cuda", "auto"], help="听写用设备(默认cpu, 避免与TTS抢显存)")
parser.add_argument("--asr-whisper-size", type=str, default="small", help="whisper 模型大小(首次使用需联网下载一次)")
parser.add_argument("--asr-whisper-dir", type=str, default=None, help="whisper 模型目录(可选, 已有模型时避免下载)")
args = parser.parse_args()
config_path = args.tts_config
port = args.port
host = args.bind_addr
argv = sys.argv

if config_path in [None, ""]:
    config_path = "GPT-SoVITS/configs/tts_infer.yaml"

import torch as _torch
import yaml as _yaml

# 国内/受限网络常无法访问 HuggingFace, 这里强制离线加载本地 BERT/HuBERT 权重,
# 避免 BertModel.from_pretrained 联网超时卡死(不影响听写时按需联网下载 whisper 模型)
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

tts_config = TTS_Config(config_path)

# ---------------- 硬件自检(本 mod 会分发给各种配置的电脑, 必须自动适配) ----------------
def _ram_gb():
    """可用/总内存 GB (Windows 用 GlobalMemoryStatusEx, 其余用 sysconf)."""
    try:
        if sys.platform == "win32":
            import ctypes
            class _MS(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_uint32), ("dwMemoryLoad", ctypes.c_uint32),
                            ("ullTotalPhys", ctypes.c_uint64), ("ullAvailPhys", ctypes.c_uint64),
                            ("ullTotalPageFile", ctypes.c_uint64), ("ullAvailPageFile", ctypes.c_uint64),
                            ("ullTotalVirtual", ctypes.c_uint64), ("ullAvailVirtual", ctypes.c_uint64),
                            ("ullAvailExtendedVirtual", ctypes.c_uint64)]
            m = _MS(); m.dwLength = ctypes.sizeof(_MS)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
            return round(m.ullTotalPhys / (1024 ** 3), 1), round(m.ullAvailPhys / (1024 ** 3), 1)
        if hasattr(os, "sysconf"):
            _p = os.sysconf("SC_PHYS_PAGES"); _pv = os.sysconf("SC_PAGE_SIZE")
            if _p > 0 and _pv > 0:
                return round(_p * _pv / (1024 ** 3), 1), -1
    except Exception:
        pass
    return 0, 0

HW_INFO = {
    "cpu_count": os.cpu_count() or 1,
    "system": (sys.platform or ""),
    "cuda": bool(_torch.cuda.is_available()),
    "gpu_name": "",
    "gpu_mem_total_gb": 0.0,
    "gpu_mem_free_gb": 0.0,
}
try:
    HW_INFO["ram_total_gb"], HW_INFO["ram_free_gb"] = _ram_gb()
except Exception:
    HW_INFO["ram_total_gb"], HW_INFO["ram_free_gb"] = 0, 0
if HW_INFO["cuda"]:
    try:
        HW_INFO["gpu_name"] = _torch.cuda.get_device_name(0)
        _pr = _torch.cuda.get_device_properties(0)
        HW_INFO["gpu_mem_total_gb"] = round(_pr.total_memory / (1024 ** 3), 1)
        HW_INFO["gpu_mem_free_gb"] = round(_torch.cuda.mem_get_info(0)[0] / (1024 ** 3), 1)
    except Exception:
        pass

# ---- 推理设备自动决策: cuda(显存够) / cpu(无显卡或显存不足), 并设置 CPU 线程数 ----
_want_cuda = (args.device in ("auto", "cuda")) and HW_INFO["cuda"]
if _want_cuda:
    _free_gb = HW_INFO.get("gpu_mem_free_gb") or 0
    if _free_gb and _free_gb < 3.0:
        print("[硬件自适应] 显存仅剩 %.1fGB (<3GB), 自动降级 CPU 推理, 避免 CUDA OOM" % _free_gb)
        _want_cuda = False
if _want_cuda:
    tts_config.device = _torch.device("cuda")
    if args.no_half:
        tts_config.is_half = False
    else:
        tts_config.is_half = True   # fp16: 显存减半 + 更快
else:
    tts_config.device = _torch.device("cpu")
    tts_config.is_half = False
    _n = max(2, min(8, HW_INFO["cpu_count"]))
    try:
        _torch.set_num_threads(_n)
    except Exception:
        pass
    print("[硬件自适应] CPU 推理: %d 线程 (多线程并行逐句合成已启用)" % _n)
print("[硬件自检] 系统=%s CPU=%d核 内存=%.1f/%.1fGB CUDA=%s %s 显存=%.1f/%.1fGB 推理设备=%s is_half=%s" % (
    HW_INFO["system"], HW_INFO["cpu_count"], HW_INFO.get("ram_free_gb", 0), HW_INFO.get("ram_total_gb", 0),
    HW_INFO["cuda"], HW_INFO["gpu_name"], HW_INFO.get("gpu_mem_free_gb", 0), HW_INFO.get("gpu_mem_total_gb", 0),
    str(tts_config.device), bool(getattr(tts_config, "is_half", False))))
print(tts_config)
tts_pipeline = TTS(tts_config)

# ---------------- FVTT 扩展: 角色包自动加载 ----------------
CHAR_CONFIG = None

# 10 个固定语气槽(第四轮: 角色构建器)
EMOTION_SLOTS = [
    ("calm", "平静"), ("happy", "开心"), ("relaxed", "轻松"), ("angry", "愤怒"),
    ("sad", "悲伤"), ("surprised", "惊讶"), ("shy", "害羞"), ("serious", "严肃"),
    ("gentle", "温柔"), ("sleepy", "困倦"),
]
EMOTION_SLOT_KEYS = [k for k, _ in EMOTION_SLOTS]

# 旧角色包(sprites/emotion_tags)标签 -> 10 槽 关键词映射
_SLOT_KEYWORDS = {
    "calm": ["中性", "平静", "眨眼", "歪头", "沈思", "沉思", "轻微好奇", "好奇", "張望", "眺望"],
    "happy": ["开心", "微笑", "兴奋", "激动", "喘气", "赞叹"],
    "relaxed": ["轻松", "悠闲", "感叹"],
    "angry": ["生气", "愤怒", "警告", "禁止", "制止", "鼓起脸颊", "不满", "抱怨", "冷漠"],
    "sad": ["难过", "悲伤", "沮丧", "失望", "自閉", "自闭", "委屈"],
    "surprised": ["惊讶", "震惊", "惊吓", "惊"],
    "shy": ["害羞", "脸红"],
    "serious": ["严肃", "认真", "皱眉", "担心", "细心查看"],
    "gentle": ["温柔", "亲切", "指点", "引导", "解说", "解释", "指向"],
    "sleepy": ["困倦", "疲劳", "疲惫", "打瞌睡", "打哈欠", "流口水", "筋疲力尽", "打盹"],
}


def _map_old_label(label):
    """把旧角色包的样本标签映射到 10 个语气槽, 未命中归 calm."""
    label = str(label or "")
    for key, words in _SLOT_KEYWORDS.items():
        for w in words:
            if w in label:
                return key
    return "calm"


# 角色目录/模型库(load_character 写回元数据时需要, 故提前定义)
_CHARS_ROOT = os.path.join(os.getcwd(), "fvtt_chars")
_MODEL_LIB = os.path.join(os.getcwd(), "fvtt_chars", "models")


def save_char_yaml(name, cfg):
    """写角色元数据回 character.yaml(UTF-8)."""
    name = os.path.basename(str(name))
    d = os.path.join(_CHARS_ROOT, name)
    os.makedirs(d, exist_ok=True)
    y = os.path.join(d, "character.yaml")
    with open(y, "w", encoding="utf-8") as f:
        _yaml.safe_dump(cfg, f, allow_unicode=True, sort_keys=False)
    return y


def _resolve_rel(base_dir, path):
    """把角色包里的相对路径(可能带斜杠/反斜杠/data前缀)解析成服务器上的真实路径."""
    if not path:
        return None
    p = str(path).replace("\\", "/").strip()
    while p.startswith("./"):
        p = p[2:]
    if p.startswith("/"):
        p = p.lstrip("/")
    if p.startswith("data/"):
        p = p[len("data/"):]
    cand = os.path.join(base_dir, p)
    return cand if os.path.exists(cand) else None


def _clean_tts_text(text):
    """台词括号剥离(照搬成品软件 remove_parentheses): （动作描写）(笑) *叹气* 等不朗读,
       只读正文; 聊天记录原文保留不受影响.
       随后应用角色发音映射(对标成品软件 replace_names): 专有名词按语音语言写法替换,
       中文名/英文名在日语(或其他)引擎里按读音写法朗读, 避免乱读/丢字."""
    if not text:
        return text
    t = re.sub(r"（[^（）]*）", "", text)   # 中文括号
    t = re.sub(r"\([^()]*\)", "", t)         # 英文括号
    t = re.sub(r"\*.*?\*", "", t, flags=re.DOTALL)  # *斜体注记*
    pm = {}
    if isinstance(CHAR_CONFIG, dict):
        pm = CHAR_CONFIG.get("pronunciation_map") or {}
    for k, v in pm.items():
        if k and v:
            t = t.replace(str(k), str(v))
    return t.strip()


def _split_sentences(text):
    """长文本按句末标点切句(中文/日文/英文通用), 用于逐句合成提升朗读质量. 返回非空句子列表."""
    text = (text or "").strip()
    if not text:
        return [text]
    parts = re.split(r"(?<=[。！？；!?;…])", text)
    sents = [p.strip() for p in parts if p.strip()]
    # 过短碎片(<4 字)并入前句, 避免碎句影响断句质量
    merged = []
    for s in sents:
        if merged and len(s) < 4:
            merged[-1] = merged[-1] + s
        else:
            merged.append(s)
    return merged or [text]


def _fade_edges(arr, sr, fade_ms=18):
    """首尾线性淡入淡出, 消除片段硬切产生的咔嗒/爆音."""
    arr = np.asarray(arr, dtype=np.float32)
    n = int(sr * fade_ms / 1000)
    if len(arr) <= n * 2 + 2:
        return arr
    ramp = np.linspace(0.0, 1.0, n, dtype=np.float32)
    arr[:n] *= ramp
    arr[-n:] *= ramp[::-1]
    return arr


def _trim_lead_silence_arr(arr, sr, max_trim_s=1.2, thresh=0.015):
    """裁剪合成音频开头的弱音/静音段(修复"前几个字被吞"):
    实测 GPT-SoVITS 合成开头常有 300~400ms 接近静音(RMS≈0.0002, 整体 0.23),
    前几个字埋在静音里 → 听感"吞音"。裁到第一个能量≥thresh 的 20ms 窗,
    并保留 20ms 缓冲(不硬切第一音素)。增益对静音无效, 必须裁剪。
    注意: 与参考音频裁剪(_trim_lead_silence)不同, 这是数组版本, 作用于合成结果。"""
    arr = np.asarray(arr, dtype=np.float32)
    n = len(arr)
    max_trim = int(sr * max_trim_s)
    if n <= max_trim * 2:
        return arr   # 太短(几乎全是开头)不裁, 防误伤
    win = max(1, int(sr * 0.02))
    i = 0
    while i < min(n, max_trim):
        seg = arr[i:i + win]
        rms = float(np.sqrt(np.mean(seg ** 2))) if len(seg) else 0.0
        if rms >= thresh:
            break
        i += win
    if 0 < i < n:
        keep = max(0, i - win)   # 回退一个窗作为缓冲(保留首个音素的起始)
        return arr[keep:]
    return arr


def _to_float_audio(arr):
    """音频统一转 float32(-1..1): 引擎可能返回 int16 PCM(满幅 32768 域),
    trim/lift/boost 的阈值都是 float 域, 不归一化会导致单位不匹配、处理永不触发."""
    arr = np.asarray(arr)
    if arr.dtype.kind == "i":
        arr = arr.astype(np.float32) / 32768.0
    return arr.astype(np.float32)


def _lift_weak_head(arr, sr, lift_s=1.5, floor=0.06, max_gain=30.0):
    """开头弱音段软提升(修复"前几个字轻到听不见"):
    引擎开头常是 1 秒级的能量渐弱爬坡(0.001→正常), 纯裁剪会硬切字音,
    增益把开头 lift_s 秒内能量低于 floor 的 20ms 窗按比例抬到 floor(上限 max_gain 防噪声放大),
    让渐弱起音达到可听水平; 之后 _limit_peak 兜底防削波."""
    arr = _to_float_audio(arr).copy()
    win = max(1, int(sr * 0.02))
    nwin = int(lift_s * sr / win)
    for k in range(min(nwin, len(arr) // win)):
        seg = arr[k * win:(k + 1) * win]
        rms = float(np.sqrt(np.mean(seg ** 2))) if len(seg) else 0.0
        if 0.0 < rms < floor:
            g = floor / rms
            if g > max_gain:
                g = max_gain
            arr[k * win:(k + 1) * win] *= g
    return arr


def _boost_head(arr, sr, ms=80, start_gain=1.4):
    """头部增益补偿(合成语音开头起音偏弱): 前 ms 毫秒从 start_gain 线性回落到 1.0.
    先经 _trim_lead_silence_arr 裁掉开头静音后, 开头几个字仍可能起音不足,
    这里温和抬升(+25%)改善听感, 不产生爆音; _limit_peak 再兜底防削波."""
    arr = np.asarray(arr, dtype=np.float32)
    n = int(sr * ms / 1000)
    if len(arr) <= n + 2:
        return arr
    ramp = np.linspace(start_gain, 1.0, n, dtype=np.float32)
    arr[:n] *= ramp
    return arr


def _trim_lead_silence(path, max_trim_s=0.35, thresh=0.005):
    """裁剪参考音频开头静音(情绪样本通常开头起音弱 → 合成开头跟着弱):
    裁掉开头振幅≤thresh 的静音段(最多 max_trim_s 秒), 让参考段开头直接有语音能量."""
    if not path or not os.path.isfile(path):
        return path
    try:
        data, sr = sf.read(path)
        if data is None or len(data) == 0:
            return path
        mono = np.mean(data, axis=1) if data.ndim > 1 else data
        max_trim = int(sr * max_trim_s)
        idx = 0
        n = len(mono)
        while idx < n and idx < max_trim and abs(float(mono[idx])) <= thresh:
            idx += 1
        if idx <= 0 or idx >= n:
            return path
        trimmed = data[idx:]
        tmp_dir = os.path.join(os.getcwd(), "fvtt_chars", "tmp_ref")
        os.makedirs(tmp_dir, exist_ok=True)
        out = os.path.join(tmp_dir, "%s.trimlead.wav" % os.path.basename(path))
        sf.write(out, trimmed, sr)
        return out
    except Exception as e:
        print("参考音频开头裁剪失败, 原样使用: %s" % e)
        return path


def _safe_concat(chunks, sr, gap_ms=130):
    """逐句拼接防爆音(借鉴成品软件"逐段独立播放"的听感):
       每段首尾微淡入淡出(非硬切), 段间留静音间隔, 全部转 float32 防数值溢出."""
    out = []
    for i, c in enumerate(chunks):
        c = _fade_edges(c, sr, 18)
        out.append(c)
        if i < len(chunks) - 1:
            nz = max(1, int(sr * gap_ms / 1000))
            out.append(np.zeros(nz, dtype=np.float32))
    return np.concatenate(out) if out else np.zeros(1, dtype=np.float32)


def _limit_peak(arr, max_peak=0.92):
    """整体峰值限制(防削波爆音): 峰值超限时等比缩放, 保持响度均衡."""
    arr = np.asarray(arr, dtype=np.float32)
    if len(arr) == 0:
        return arr
    peak = float(np.max(np.abs(arr)))
    if peak > max_peak:
        arr = arr * (max_peak / peak)
    return arr


def _wav_to_mp3(wav_bytes, bitrate="64k"):
    """wav 字节 → mp3 字节(内置 ffmpeg), 失败返回 None. 64k 对语音足够清晰, 广播 base64 更小更快."""
    try:
        ffmpeg = None
        if getattr(sys, "executable", None):
            cand = os.path.join(os.path.dirname(sys.executable), "ffmpeg.exe")
            if os.path.isfile(cand):
                ffmpeg = cand
        if not ffmpeg:
            for cand in ("ffmpeg", "ffmpeg.exe"):
                if shutil.which(cand):
                    ffmpeg = cand
                    break
        if not ffmpeg:
            return None
        p = subprocess.run([ffmpeg, "-y", "-i", "pipe:0", "-f", "mp3", "-b:a", bitrate, "-vn", "pipe:1"],
                           input=wav_bytes, capture_output=True, timeout=180)
        return p.stdout if (p.returncode == 0 and p.stdout) else None
    except Exception:
        return None


# 音频缓存目录: 合成音频落盘供全员 URL 拉流播放(Shinsekai 式文件传输, 无 socket 包大小限制)
_AUDIO_CACHE = os.path.join(os.getcwd(), "audio_cache")

# 合成缓存: 同文本+同角色(参考/提示词/模型)+同参数 → 命中直接返回同一份音频(毫秒级), 消除"重复台词/两端同请求"的重复合成
_SYNTH_CACHE = {}
_SYNTH_CACHE_MAX = 64


def _synth_cache_key(req):
    """计算合成缓存键(影响听感的参数全进键; streaming/非mp3wav 不缓存)."""
    try:
        if not isinstance(req, dict) or not req.get("text"):
            return None
        if req.get("streaming_mode") in (True, 1, 2, 3):
            return None
        mm = str(req.get("media_type") or "wav")
        if mm not in ("mp3", "wav"):
            return None
        sub = {
            "text": str(req.get("text") or ""),
            "text_lang": str(req.get("text_lang") or "auto"),
            "ref": str(req.get("ref_audio_path") or ""),
            "aux": sorted([str(x) for x in (req.get("aux_ref_audio_paths") or [])]),
            "prompt_text": str(req.get("prompt_text") or ""),
            "prompt_lang": str(req.get("prompt_lang") or ""),
            "speed": float(req.get("speed_factor") or 1.0),
            "media": mm,
            "split": str(req.get("text_split_method") or ""),
            "frag": float(req.get("fragment_interval") or 0.3),
            "seed": -1 if int(req.get("seed") or -1) == -1 else int(req.get("seed") or -1),
            "gpt": os.path.basename(str((CHAR_CONFIG or {}).get("gpt_model_path") or "")),
            "svc": os.path.basename(str((CHAR_CONFIG or {}).get("sovits_model_path") or "")),
        }
        import hashlib as _hashlib
        import json as _json
        return _hashlib.sha256(_json.dumps(sub, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()
    except Exception:
        return None


def _respond_with_file(audio_bytes, media_type, req=None):
    """把合成音频存到缓存目录并返回带 X-Audio-Url 响应头的响应(客户端可广播 URL 让全员 HTTP 拉流).
    同参数请求命中合成缓存时直接复用同一份音频(不重复合成, 毫秒返回)."""
    try:
        ext = "mp3" if str(media_type) == "audio/mpeg" else "wav"
        _ck = _synth_cache_key(req)
        if _ck and _ck in _SYNTH_CACHE:
            _hit = _SYNTH_CACHE[_ck]
            # 文件可能已被 2h 懒清理删掉 → 命中时重写(同字节, 快)后返回
            try:
                _p0 = os.path.join(_AUDIO_CACHE, _hit["fn"])
                with open(_p0, "wb") as _f:
                    _f.write(audio_bytes)
                _xd0 = os.path.join(os.path.dirname(__file__), "..", "engine", "audio_export")
                os.makedirs(_xd0, exist_ok=True)
                with open(os.path.join(_xd0, _hit["fn"]), "wb") as _f:
                    _f.write(audio_bytes)
            except Exception:
                pass
            _h = {"X-Audio-Url": "/audio/%s" % _hit["fn"], "X-Fvtt-Audio-Url": _hit["url"], "X-Fvtt-Cache": "hit"}
            return Response(audio_bytes, media_type=media_type, headers=_h)
        _fn = "%s.%s" % (uuid.uuid4().hex, ext)
        _p = os.path.join(_AUDIO_CACHE, _fn)
        with open(_p, "wb") as _f:
            _f.write(audio_bytes)
        # 懒清理: 每次合成顺手清掉超过 2 小时的缓存音频(防磁盘堆积)
        try:
            _now = time.time()
            for _old in os.listdir(_AUDIO_CACHE):
                try:
                    _op = os.path.join(_AUDIO_CACHE, _old)
                    if _now - os.path.getmtime(_op) > 7200:
                        os.remove(_op)
                except Exception:
                    pass
        except Exception:
            pass
        # Foundry 静态导出: 同一音频再写一份到模块目录 → 玩家端直接走 Foundry 端口(/modules/...)拉流,
        # 不依赖 9881 端口对局域网开放 — 响应头 X-Fvtt-Audio-Url 提供该路径(客户端优先用它)
        _fvtt_url = ""
        try:
            _xd = os.path.join(os.path.dirname(__file__), "..", "engine", "audio_export")
            os.makedirs(_xd, exist_ok=True)
            with open(os.path.join(_xd, _fn), "wb") as _f:
                _f.write(audio_bytes)
            _fvtt_url = "/modules/gpt-sovits-tts/engine/audio_export/%s" % _fn
            # 同样懒清理旧导出(2h)
            _now2 = time.time()
            for _old in os.listdir(_xd):
                try:
                    _op2 = os.path.join(_xd, _old)
                    if _now2 - os.path.getmtime(_op2) > 7200:
                        os.remove(_op2)
                except Exception:
                    pass
        except Exception:
            _fvtt_url = ""
        if _ck:
            _SYNTH_CACHE[_ck] = {"fn": _fn, "url": _fvtt_url, "bytes": audio_bytes, "ts": time.time()}
            if len(_SYNTH_CACHE) > _SYNTH_CACHE_MAX:
                _oldest = min(_SYNTH_CACHE.items(), key=lambda kv: kv[1]["ts"])[0]
                _SYNTH_CACHE.pop(_oldest, None)
        _h = {"X-Audio-Url": "/audio/%s" % _fn}
        if _fvtt_url:
            _h["X-Fvtt-Audio-Url"] = _fvtt_url
        if _ck:
            _h["X-Fvtt-Cache"] = "miss"
        return Response(audio_bytes, media_type=media_type, headers=_h)
    except Exception:
        return Response(audio_bytes, media_type=media_type)


def _resolve_ref(path):
    """把客户端传来的参考音频/模型路径解析为服务器真实路径(先角色包目录, 再 cwd)."""
    if not path:
        return path
    p = str(path).replace("\\", "/")
    if os.path.isabs(p) and os.path.exists(p):
        return p
    cands = []
    if CHAR_CONFIG and CHAR_CONFIG.get("source_dir"):
        cands.append(os.path.join(CHAR_CONFIG["source_dir"], p))
    cands.append(os.path.join(os.getcwd(), p))
    for c in cands:
        if os.path.exists(c):
            return c
    return str(path)


def _prepare_ref(ref_audio_path, allow_short=False):
    """参考音频不足 3 秒时静音补足到 3 秒(引擎要求 3~10s, 语气样本通常较短).

    仅 allow_short=True 时启用; 正常长度的参考音频原样返回. 补足文件缓存到 fvtt_chars/tmp_ref/.
    """
    if not allow_short or not ref_audio_path or not os.path.isfile(ref_audio_path):
        return ref_audio_path
    try:
        data, sr = sf.read(ref_audio_path)
        if data is None or (len(data) / sr) >= 3.0:
            return ref_audio_path
        need = int(sr * 3.0) - len(data)
        if need <= 0:
            return ref_audio_path
        pad = np.zeros((need, data.shape[1]) if data.ndim > 1 else need, dtype=data.dtype)
        padded = np.concatenate([data, pad])
        tmp_dir = os.path.join(os.getcwd(), "fvtt_chars", "tmp_ref")
        os.makedirs(tmp_dir, exist_ok=True)
        out = os.path.join(tmp_dir, "%s.pad3.wav" % os.path.basename(ref_audio_path))
        sf.write(out, padded, sr)
        return out
    except Exception as e:
        print("参考音频补足失败, 按原样使用: %s" % e)
        return ref_audio_path


def load_character(char_yaml_path):
    """加载 Shinsekai/GPT-SoVITS 角色包(character.yaml): GPT权重+SoVITS权重+参考音频+提示文本."""
    global CHAR_CONFIG
    base_dir = os.path.dirname(os.path.abspath(char_yaml_path))
    with open(char_yaml_path, "r", encoding="utf-8") as f:
        raw = _yaml.safe_load(f) or {}
    cfg = raw[0] if isinstance(raw, list) and raw else raw
    if not isinstance(cfg, dict):
        raise ValueError("character.yaml 格式不正确(应为 dict 或 list[dict])")

    def _char_path(p):
        """角色包路径解析: 先角色目录, 再 cwd(基础模型/跨角色引用)."""
        r = _resolve_rel(base_dir, p)
        if r:
            return r
        return _resolve_ref(p)

    gpt = args.gpt or _char_path(cfg.get("gpt_model_path", ""))
    sovits = args.sovits or _char_path(cfg.get("sovits_model_path", ""))
    ref = args.ref or _char_path(cfg.get("refer_audio_path", ""))

    # 兜底: 扫描 models 目录(角色包 yaml 里路径可能被 \n 破坏)
    models_dir = os.path.join(base_dir, "models")
    if os.path.isdir(models_dir):
        for fn in sorted(os.listdir(models_dir)):
            low = fn.lower()
            fp = os.path.join(models_dir, fn)
            if not gpt and low.endswith(".ckpt"):
                gpt = fp
            if not sovits and low.endswith(".pth"):
                sovits = fp
            if not ref and low.endswith((".wav", ".mp3", ".flac", ".ogg", ".aac")):
                ref = fp

    if not gpt or not os.path.isfile(gpt):
        raise FileNotFoundError("找不到 GPT 权重(.ckpt): %s" % char_yaml_path)
    if not sovits or not os.path.isfile(sovits):
        raise FileNotFoundError("找不到 SoVITS 权重(.pth): %s" % char_yaml_path)
    if not ref or not os.path.isfile(ref):
        raise FileNotFoundError("找不到参考音频: %s" % char_yaml_path)

    prompt_text = args.prompt_text if args.prompt_text is not None else cfg.get("prompt_text", "")
    prompt_lang = args.prompt_lang or cfg.get("prompt_lang", None) or "ja"

    print("=" * 60)
    print("加载角色: %s" % cfg.get("name", os.path.basename(base_dir)))
    print("  GPT    : %s" % gpt)
    print("  SoVITS : %s" % sovits)
    print("  Ref    : %s" % ref)
    print("  Prompt : [%s] %s" % (prompt_lang, prompt_text))
    print("=" * 60)
    # 权重与当前激活角色相同则跳过重载(避免 CUDA 上下文反复初始化/显存膨胀导致崩溃)
    _cur = CHAR_CONFIG if isinstance(CHAR_CONFIG, dict) else None
    _same = bool(_cur
                 and os.path.abspath(str(_cur.get("gpt_model_path", ""))) == os.path.abspath(gpt)
                 and os.path.abspath(str(_cur.get("sovits_model_path", ""))) == os.path.abspath(sovits))
    if _same:
        print("音色模型未变化, 跳过权重重载(仅重设参考音频/提示文本)")
    else:
        import gc as _gc
        try:
            import torch as _torch
            _torch.cuda.empty_cache()
        except Exception:
            pass
        _gc.collect()
        tts_pipeline.init_t2s_weights(gpt)
        tts_pipeline.init_vits_weights(sovits)
    tts_pipeline.set_ref_audio(ref)

    # 语气槽: 新 schema(emotions map/list) 优先; 旧 schema(sprites/emotion_tags) 自动映射到 10 槽
    def _slot_ref_rel(path):
        rel = os.path.relpath(path, os.getcwd()).replace("\\", "/")
        return rel

    emotions_slots = []
    raw_emotions = cfg.get("emotions")
    if isinstance(raw_emotions, dict):
        # 新 schema: emotions: {calm: {label, ref, prompt, lang}}
        for key, val in raw_emotions.items():
            if isinstance(val, dict):
                vp = _resolve_rel(base_dir, val.get("ref", ""))
                emotions_slots.append({
                    "key": str(key), "label": val.get("label", ""),
                    "ref_audio_path": _slot_ref_rel(vp) if vp and os.path.isfile(vp) else "",
                    "prompt_text": val.get("prompt", "") or "", "prompt_lang": val.get("lang", "") or "",
                    "avatar": val.get("avatar", "") or "",
                })
    elif isinstance(raw_emotions, list):
        # 新 schema 列表: [{key, label, ref, prompt, lang}]
        for it in raw_emotions:
            if not isinstance(it, dict):
                continue
            vp = _resolve_rel(base_dir, it.get("ref", ""))
            emotions_slots.append({
                "key": str(it.get("key", "")), "label": it.get("label", ""),
                "ref_audio_path": _slot_ref_rel(vp) if vp and os.path.isfile(vp) else "",
                "prompt_text": it.get("prompt", "") or "", "prompt_lang": it.get("lang", "") or "",
                "avatar": it.get("avatar", "") or "",
            })
    else:
        # 旧 schema: sprites + emotion_tags -> 关键词映射到 10 槽(每槽取第一段匹配样本)
        try:
            tags = {}
            for line in str(cfg.get("emotion_tags", "") or "").splitlines():
                m = re.match(r"^\s*sprite\s+(\d+)\s*[:：]\s*(.+)$", line.strip())
                if m:
                    tags[int(m.group(1))] = m.group(2).strip()
            sprites = cfg.get("sprites") or []
            for i, sp in enumerate(sprites):
                vp = _resolve_rel(base_dir, sp.get("voice_path", "")) if isinstance(sp, dict) else None
                if not vp or not os.path.isfile(vp):
                    continue
                label = tags.get(i + 1, "语气 %d" % (i + 1))
                emotions_slots.append({
                    "key": _map_old_label(label), "label": label,
                    "ref_audio_path": _slot_ref_rel(vp), "prompt_text": "", "prompt_lang": "",
                })
        except Exception as e:
            print("解析旧语气样本失败(不影响使用): %s" % e)
            emotions_slots = []

    # 归一化: 按 10 槽固定顺序, 重复槽只保留第一段
    slot_map = {}
    for it in emotions_slots:
        if it["key"] in EMOTION_SLOT_KEYS and it["key"] not in slot_map and it.get("ref_audio_path"):
            slot_map[it["key"]] = it
    emotions_final = []
    for key, label in EMOTION_SLOTS:
        it = slot_map.get(key)
        emotions_final.append({
            "key": key, "label": it["label"] if it else label,
            "ref_audio_path": it["ref_audio_path"] if it else "",
            "prompt_text": it["prompt_text"] if it else "",
            "prompt_lang": it["prompt_lang"] if it else "",
            "avatar": it["avatar"] if it and it.get("avatar") else "",
        })

    # 模型清单(角色包 models/ 目录, 供语音管理器切换)
    models_list = {"gpt": [], "sovits": []}
    if os.path.isdir(models_dir):
        for fn in sorted(os.listdir(models_dir)):
            low = fn.lower()
            if low.endswith(".ckpt") or low.endswith(".safetensors"):
                models_list["gpt"].append(fn)
            elif low.endswith(".pth"):
                models_list["sovits"].append(fn)

    # 已导入的参考音频(engine/fvtt_chars/imports/)
    imports = []
    imports_dir = os.path.join(os.getcwd(), "fvtt_chars", "imports")
    if os.path.isdir(imports_dir):
        for fn in sorted(os.listdir(imports_dir)):
            if fn.lower().endswith((".wav", ".mp3", ".flac", ".ogg", ".aac", ".m4a", ".webm")):
                imports.append({"name": fn, "ref_audio_path": "fvtt_chars/imports/" + fn})

    CHAR_CONFIG = {
        "name": cfg.get("name", ""),
        "gpt_model_path": gpt,
        "sovits_model_path": sovits,
        "ref_audio_path": ref,
        "prompt_text": prompt_text,
        "prompt_lang": prompt_lang,
        "default_text_lang": "auto",
        "source_dir": base_dir,
        "source_yaml": os.path.abspath(char_yaml_path),
        "emotions": emotions_final,
        "models_list": models_list,
        "imports": imports,
        "pronunciation_map": cfg.get("pronunciation_map", {}) or {},
        "character_setting": str(cfg.get("character_setting", "") or "")[:1500],
    }
    print("角色加载完成 OK (语气槽 %d/10, 可用GPT模型 %d, SoVITS模型 %d, 导入参考音频 %d)" % (
        len([e for e in emotions_final if e["ref_audio_path"]]), len(models_list["gpt"]), len(models_list["sovits"]), len(imports)))

    # 旧角色包升级: yaml 无 emotions 且有旧样本时, 把映射结果写回 character.yaml(10 槽持久化)
    if not raw_emotions and emotions_final:
        try:
            write_cfg = {
                "name": cfg.get("name", os.path.basename(base_dir)),
                "gpt_model_path": os.path.relpath(gpt, base_dir).replace("\\", "/"),
                "sovits_model_path": os.path.relpath(sovits, base_dir).replace("\\", "/"),
                "refer_audio_path": os.path.relpath(ref, base_dir).replace("\\", "/"),
                "prompt_text": prompt_text,
                "prompt_lang": prompt_lang,
                "emotions": {},
            }
            for it in emotions_final:
                if not it.get("ref_audio_path"):
                    continue
                abs_ref = it["ref_audio_path"] if os.path.isabs(it["ref_audio_path"]) else os.path.join(os.getcwd(), it["ref_audio_path"])
                rel = os.path.relpath(abs_ref, base_dir).replace("\\", "/")
                write_cfg["emotions"][it["key"]] = {"ref": rel, "prompt": it.get("prompt_text", ""), "lang": it.get("prompt_lang", ""), "avatar": it.get("avatar", "")}
            save_char_yaml(write_cfg["name"], write_cfg)
            print("旧角色包已升级为 10 语气槽 schema 并写回 character.yaml")
        except Exception as e:
            print("写回角色元数据失败(不影响使用): %s" % e)


if args.char:
    load_character(args.char)

# ---------------- 启动预热(冷启动优化) ----------------
# 首次推理要做 CUDA 上下文初始化/kernel 编译, 常耗时几分钟; 后台先跑一次短合成,
# 让第一条真实消息也只需正常推理时间.
import threading as _th
def _warmup_infer():
    try:
        if not isinstance(CHAR_CONFIG, dict) or not CHAR_CONFIG.get("ref_audio_path"):
            return
        _wr = {
            "text": "你好，很高兴见到你。",
            "text_lang": "zh",
            "ref_audio_path": CHAR_CONFIG["ref_audio_path"],
            "prompt_text": CHAR_CONFIG.get("prompt_text", ""),
            "prompt_lang": CHAR_CONFIG.get("prompt_lang", "zh"),
            "media_type": "wav",
            "streaming_mode": False,
            "batch_size": 1,
            "text_split_method": "cut5",
            "speed_factor": 1.0,
        }
        _g = tts_pipeline.run(_wr)
        _ = next(_g)
        print("[warmup] 推理预热完成, CUDA 已就绪(后续请求直接快速响应)")
    except Exception as e:
        print("[warmup] 预热跳过: %s" % e)
_th.Thread(target=_warmup_infer, daemon=True).start()

# ---------------- 角色管理辅助(第四轮: 角色构建器) ----------------
def list_installed_chars():
    """扫描 fvtt_chars/ 下含 character.yaml 的目录 -> 已安装角色清单."""
    chars = []
    if not os.path.isdir(_CHARS_ROOT):
        return chars
    for name in sorted(os.listdir(_CHARS_ROOT)):
        d = os.path.join(_CHARS_ROOT, name)
        y = os.path.join(d, "character.yaml")
        if os.path.isdir(d) and os.path.isfile(y):
            chars.append({"name": name})
    return chars


def read_char_yaml(name):
    """读角色元数据(绝对路径字段保留; 相对路径直接返回字符串)."""
    name = os.path.basename(str(name))
    y = os.path.join(_CHARS_ROOT, name, "character.yaml")
    if not os.path.isfile(y):
        return None
    try:
        with open(y, "r", encoding="utf-8") as f:
            raw = _yaml.safe_load(f) or {}
        cfg = raw[0] if isinstance(raw, list) and raw else raw
        return cfg if isinstance(cfg, dict) else None
    except Exception as e:
        print("读取角色元数据失败 %s: %s" % (name, e))
        return None


def resolve_in_char(name, rel_path):
    """角色目录内相对路径 -> 绝对路径(不存在返回 None)."""
    if not rel_path:
        return None
    p = str(rel_path).replace("\\", "/")
    if os.path.isabs(p) and os.path.exists(p):
        return p
    cand = os.path.join(_CHARS_ROOT, os.path.basename(name), p)
    return cand if os.path.exists(cand) else None


def scan_model_library():
    """模型库扫描: fvtt_chars/models/ 下的 .ckpt/.safetensors(GPT) 与 .pth(SoVITS)."""
    lib = {"gpt": [], "sovits": []}
    if os.path.isdir(_MODEL_LIB):
        for fn in sorted(os.listdir(_MODEL_LIB)):
            low = fn.lower()
            if low.endswith((".ckpt", ".safetensors")):
                lib["gpt"].append(fn)
            elif low.endswith(".pth"):
                lib["sovits"].append(fn)
    return lib


def base_model_pair():
    """基础音色模型对(引擎自带, 零样本克隆用): GPT=s1v3.ckpt, SoVITS=s2G488k.pth."""
    root = os.getcwd()
    gpt = os.path.join(root, "GPT_SoVITS", "pretrained_models", "s1v3.ckpt")
    sovits = os.path.join(root, "GPT_SoVITS", "pretrained_models", "s2G488k.pth")
    if not os.path.isfile(gpt):
        gpt = ""
    if not os.path.isfile(sovits):
        sovits = ""
    return {"gpt": os.path.basename(gpt) if gpt else "", "sovits": os.path.basename(sovits) if sovits else "",
            "gpt_path": gpt, "sovits_path": sovits, "available": bool(gpt and sovits)}


def _pool_char_path(base_dir, p):
    """角色包路径解析(模块级): 先角色目录, 再 cwd/全局(基础模型/跨角色引用)."""
    r = _resolve_rel(base_dir, p)
    if r:
        return r
    return _resolve_ref(p)


def activate_character(name):
    """切换并热加载指定角色(权重+主参考+提示), 成功返回 None, 失败返回错误字符串.
    优先权重热换(Shinsekai 式, 秒级: 只换 GPT/SoVITS 权重+参考, 不重建推理管线);
    换权重不可用时回退全量 load_character."""
    global CHAR_CONFIG
    name = os.path.basename(str(name))
    y = os.path.join(_CHARS_ROOT, name, "character.yaml")
    if not os.path.isfile(y):
        return "角色 %s 不存在" % name
    try:
        hot_ok = False
        try:
            import yaml as _yaml
            with open(y, "r", encoding="utf-8") as _f:
                cfg = _yaml.safe_load(_f) or {}
            base = os.path.dirname(os.path.abspath(y))
            gpt = args.gpt or _pool_char_path(base, cfg.get("gpt_model_path", ""))
            sovits = args.sovits or _pool_char_path(base, cfg.get("sovits_model_path", ""))
            ref_raw = cfg.get("refer_audio_path", "") or ""
            ref_abs = _pool_char_path(base, ref_raw) if ref_raw else ""
            if gpt and sovits and os.path.isfile(gpt) and os.path.isfile(sovits) and ref_abs and os.path.isfile(ref_abs):
                tts_pipeline.init_t2s_weights(gpt)
                tts_pipeline.init_vits_weights(sovits)
                tts_pipeline.set_ref_audio(ref_abs)
                # 更新内存角色元数据(合成默认参考/提示/语气槽/别名映射/人设)
                CHAR_CONFIG = CHAR_CONFIG or {}
                CHAR_CONFIG["name"] = str(cfg.get("name", "") or name)
                CHAR_CONFIG["gpt_model_path"] = gpt
                CHAR_CONFIG["sovits_model_path"] = sovits
                CHAR_CONFIG["ref_audio_path"] = ref_raw.replace("\\", "/")
                CHAR_CONFIG["prompt_text"] = str(cfg.get("prompt_text", "") or "")
                CHAR_CONFIG["prompt_lang"] = str(cfg.get("prompt_lang", "") or "")
                CHAR_CONFIG["default_text_lang"] = "auto"
                CHAR_CONFIG["source_dir"] = base
                CHAR_CONFIG["source_yaml"] = os.path.abspath(y)
                CHAR_CONFIG["emotions"] = emotion_slot_state(cfg)
                CHAR_CONFIG["pronunciation_map"] = cfg.get("pronunciation_map", {}) or {}
                CHAR_CONFIG["character_setting"] = str(cfg.get("character_setting", "") or "")[:1500]
                args.char = y
                hot_ok = True
                print("角色切换成功(权重热换): %s" % name)
        except Exception as e:
            print("权重热换不可用(%s), 回退全量加载" % e)
            hot_ok = False
        if not hot_ok:
            old = args.char
            args.char = y  # load_character 依赖 args.char
            load_character(y)
            args.char = old
            print("角色切换成功(全量加载): %s" % name)
        return None
    except Exception as e:
        print("切换角色失败 %s: %s" % (name, e))
        return "切换角色失败: %s" % e


# ---------------- 多模型并行池: 多个角色模型同时常驻, 说话按角色路由(Shinsekai 式) ----------------
# 上限默认 10(可 1~20, GM 在 Foundry 设置里改 → 同步 /config): 每个常驻角色一套独立 GPT/SoVITS 权重,
# 首次说话加载(10~60s), 之后即用; 池满按 LRU 淘汰最久未用角色释放显存/内存
MAX_MODEL_POOL = 10
_POOL_LOCK = threading.Lock()
TTS_POOL = OrderedDict()   # 角色名 -> {"tts": TTS 实例, "at": 最近使用时间戳}


def _pool_config_path():
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "engine", "config.json")


def _vram_based_pool_max():
    """按显存估算可常驻模型数(每实例 ~2.5GB + 共享文本模型基础), clamp 2..8 — 多模型并行不顶掉的前提是显存放得下."""
    try:
        import torch
        if torch.cuda.is_available():
            tot_mb = int(torch.cuda.get_device_properties(0).total_memory) // (1024 * 1024)
            est = max(2, min(8, tot_mb // 2560))
            print("[模型池] 显存 %dMB → 估算可常驻并行上限 %d" % (tot_mb, est))
            return est
    except Exception:
        pass
    return 3


def load_pool_config():
    global MAX_MODEL_POOL
    try:
        _p = _pool_config_path()
        if os.path.isfile(_p):
            with open(_p, "r", encoding="utf-8") as _f:
                j = json.load(_f)
            v = int(j.get("max_concurrent_models", 0) or 0)
            _est = _vram_based_pool_max()
            if v > 0:
                # 配置上限受显存承载约束(防 OOM): 取 min(配置, 显存估算)
                MAX_MODEL_POOL = max(1, min(v, _est))
                print("[模型池] 同时运行上限: %d (配置=%d, 显存承载=%d, 取较小防OOM)" % (MAX_MODEL_POOL, v, _est))
            else:
                MAX_MODEL_POOL = _est
                print("[模型池] 同时运行上限(配置缺省→显存估算): %d" % MAX_MODEL_POOL)
        else:
            MAX_MODEL_POOL = _vram_based_pool_max()
            print("[模型池] 同时运行上限(config.json 不存在→显存估算): %d" % MAX_MODEL_POOL)
    except Exception:
        MAX_MODEL_POOL = _vram_based_pool_max()


def save_pool_config(v):
    try:
        _p = _pool_config_path()
        os.makedirs(os.path.dirname(_p), exist_ok=True)
        with open(_p, "w", encoding="utf-8") as _f:
            json.dump({"max_concurrent_models": int(v)}, _f, ensure_ascii=False)
        return True
    except Exception:
        return False


def _pool_evict_lru():
    while len(TTS_POOL) > MAX_MODEL_POOL:
        try:
            _k, _v = TTS_POOL.popitem(last=False)
            print("[模型池] 超出上限(%d), 淘汰最久未用: %s (常驻 %d)" % (MAX_MODEL_POOL, _k, len(TTS_POOL)))
            del _v
        except Exception:
            break


def _pool_dbg(msg):
    """池调试直录(独立文件, 不受 tts-server.log 占用/编码影响)."""
    try:
        with open(os.path.join(os.path.dirname(__file__), "pool-debug.log"), "a", encoding="utf-8") as _df:
            _df.write("%s %s\n" % (time.strftime("%H:%M:%S"), msg))
    except Exception:
        pass


def _pool_get(name):
    """按角色取常驻 TTS 实例(LRU): 命中即用; 未命中加载该角色权重(首次较慢, 之后常驻); 池满淘汰最久未用.
    激活角色(GM 主角色)直接用热换的 tts_pipeline, 不重复占资源; 权重缺失回退激活角色."""
    global tts_pipeline, MAX_MODEL_POOL
    name = os.path.basename(str(name or ""))
    if not name:
        return tts_pipeline
    try:
        if CHAR_CONFIG and name == CHAR_CONFIG.get("name"):
            return tts_pipeline
    except Exception:
        pass
    with _POOL_LOCK:
        hit = TTS_POOL.get(name)
        if hit is not None:
            TTS_POOL.move_to_end(name)
            hit["at"] = time.time()
            return hit["tts"]
        if len(TTS_POOL) >= MAX_MODEL_POOL:
            _pool_evict_lru()
    try:
        y = os.path.join(_CHARS_ROOT, name, "character.yaml")
        if not os.path.isfile(y):
            return tts_pipeline
        import yaml as _yaml
        with open(y, "r", encoding="utf-8") as _f:
            cfg = _yaml.safe_load(_f) or {}
        cfg = cfg[0] if isinstance(cfg, list) and cfg else cfg
        if not isinstance(cfg, dict):
            return tts_pipeline
        gpt = _pool_char_path(os.path.dirname(os.path.abspath(y)), cfg.get("gpt_model_path", ""))
        sovits = _pool_char_path(os.path.dirname(os.path.abspath(y)), cfg.get("sovits_model_path", ""))
        ref_raw = str(cfg.get("refer_audio_path", "") or "")
        ref_abs = _pool_char_path(os.path.dirname(os.path.abspath(y)), ref_raw) if ref_raw else ""
        if not (gpt and sovits and os.path.isfile(gpt) and os.path.isfile(sovits) and ref_abs and os.path.isfile(ref_abs)):
            print("[模型池] %s 权重不完整, 回退激活角色" % name)
            return tts_pipeline
        print("[模型池] 加载角色模型(首次较慢, 之后常驻即用): %s (常驻 %d→%d/%d)" % (name, len(TTS_POOL), len(TTS_POOL) + 1, MAX_MODEL_POOL))
        _pool_dbg("LOAD %s yaml=%s gpt=%s sovits=%s ref=%s" % (name, y, gpt, sovits, ref_abs))
        inst = TTS(tts_config)
        _pool_dbg("TTS-INST %s OK" % name)
        inst.init_t2s_weights(gpt)
        _pool_dbg("GPT-W %s OK" % name)
        inst.init_vits_weights(sovits)
        _pool_dbg("SOVITS-W %s OK" % name)
        inst.set_ref_audio(ref_abs)
        _pool_dbg("REF %s OK" % name)
        with _POOL_LOCK:
            while len(TTS_POOL) >= MAX_MODEL_POOL:
                _pool_evict_lru()
            TTS_POOL[name] = {"tts": inst, "at": time.time()}
        print("[模型池] 就绪: %s (常驻 %d/%d)" % (name, len(TTS_POOL), MAX_MODEL_POOL))
        _pool_dbg("POOLED %s size=%d max=%d" % (name, len(TTS_POOL), MAX_MODEL_POOL))
        return inst
    except Exception as e:
        print("[模型池] 加载 %s 失败: %s → 回退激活角色" % (name, e))
        _pool_dbg("FAIL %s: %s" % (name, e))
        return tts_pipeline


def emotion_slot_state(cfg):
    """从角色元数据生成槽状态(供 /characters /客户端).
    不再有固定 10 槽: 情绪槽 = 角色 yaml 里定义的全部槽(角色自带音频导入的自定义情绪,
    如七海千秋/阿尔托莉雅/五条悟的角色包自带情绪)."""
    slots = []
    raw = cfg.get("emotions") if isinstance(cfg, dict) else None
    by_key = {}
    if isinstance(raw, dict):
        for k, v in raw.items():
            if isinstance(v, dict):
                by_key[str(k)] = v
    elif isinstance(raw, list):
        for it in raw:
            if isinstance(it, dict):
                by_key[str(it.get("key", ""))] = it
    default_labels = dict(EMOTION_SLOTS)
    for k, it in by_key.items():
        if not isinstance(it, dict):
            continue
        ref = it.get("ref", "") or ""
        resolved = resolve_in_char(cfg.get("name", ""), ref) if cfg else None
        label = it.get("label", "") or default_labels.get(k, "") or k
        slots.append({
            "key": k, "label": label,
            "bound": bool(ref) and bool(resolved),
            "ref_audio_path": ref,
            "prompt_text": it.get("prompt", "") or "",
            "prompt_lang": it.get("lang", "") or "",
            "avatar": it.get("avatar", "") or "",
        })
    return slots


APP = FastAPI()
APP.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Audio-Url", "X-Fvtt-Audio-Url", "X-Fvtt-Cache"],   # 浏览器 fetch 跨源才能读到音频 URL/缓存 响应头(否则自检拿不到缓存命中判定)
)


class TTS_Request(BaseModel):
    text: str = None
    text_lang: str = None
    role: str = None          # 多模型池: 指定角色名 → 服务端用该角色常驻模型合成(不再是激活角色音色)
    character_name: str = None
    ref_audio_path: str = None
    aux_ref_audio_paths: list = None
    prompt_lang: str = None
    prompt_text: str = ""
    top_k: int = 15
    top_p: float = 1
    temperature: float = 1
    text_split_method: str = "cut5"
    batch_size: int = 1
    batch_threshold: float = 0.75
    split_bucket: bool = True
    speed_factor: float = 1.0
    fragment_interval: float = 0.3
    seed: int = -1
    media_type: str = "wav"
    streaming_mode: Union[bool, int] = False
    allow_short_ref: bool = False
    parallel_infer: bool = True
    repetition_penalty: float = 1.35
    sample_steps: int = 32
    super_sampling: bool = False
    overlap_length: int = 2
    min_chunk_length: int = 16


def pack_ogg(io_buffer: BytesIO, data: np.ndarray, rate: int):
    # Author: AkagawaTsurunaki
    # Issue:
    #   Stack overflow probabilistically occurs
    #   when the function `sf_writef_short` of `libsndfile_64bit.dll` is called
    #   using the Python library `soundfile`
    # Note:
    #   This is an issue related to `libsndfile`, not this project itself.
    #   It happens when you generate a large audio tensor (about 499804 frames in my PC)
    #   and try to convert it to an ogg file.
    # Related:
    #   https://github.com/RVC-Boss/GPT-SoVITS/issues/1199
    #   https://github.com/libsndfile/libsndfile/issues/1023
    #   https://github.com/bastibe/python-soundfile/issues/396
    # Suggestion:
    #   Or split the whole audio data into smaller audio segment to avoid stack overflow?

    def handle_pack_ogg():
        with sf.SoundFile(io_buffer, mode="w", samplerate=rate, channels=1, format="ogg") as audio_file:
            audio_file.write(data)



    # See: https://docs.python.org/3/library/threading.html
    # The stack size of this thread is at least 32768
    # If stack overflow error still occurs, just modify the `stack_size`.
    # stack_size = n * 4096, where n should be a positive integer.
    # Here we chose n = 4096.
    stack_size = 4096 * 4096
    try:
        threading.stack_size(stack_size)
        pack_ogg_thread = threading.Thread(target=handle_pack_ogg)
        pack_ogg_thread.start()
        pack_ogg_thread.join()
    except RuntimeError as e:
        # If changing the thread stack size is unsupported, a RuntimeError is raised.
        print("RuntimeError: {}".format(e))
        print("Changing the thread stack size is unsupported.")
    except ValueError as e:
        # If the specified stack size is invalid, a ValueError is raised and the stack size is unmodified.
        print("ValueError: {}".format(e))
        print("The specified stack size is invalid.")

    return io_buffer


def pack_raw(io_buffer: BytesIO, data: np.ndarray, rate: int):
    io_buffer.write(data.tobytes())
    return io_buffer


def pack_wav(io_buffer: BytesIO, data: np.ndarray, rate: int):
    io_buffer = BytesIO()
    sf.write(io_buffer, data, rate, format="wav")
    return io_buffer


def pack_aac(io_buffer: BytesIO, data: np.ndarray, rate: int):
    process = subprocess.Popen(
        [
            "ffmpeg",
            "-f",
            "s16le",  # 输入16位有符号小端整数PCM
            "-ar",
            str(rate),  # 设置采样率
            "-ac",
            "1",  # 单声道
            "-i",
            "pipe:0",  # 从管道读取输入
            "-c:a",
            "aac",  # 音频编码器为AAC
            "-b:a",
            "192k",  # 比特率
            "-vn",  # 不包含视频
            "-f",
            "adts",  # 输出AAC数据流格式
            "pipe:1",  # 将输出写入管道
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    out, _ = process.communicate(input=data.tobytes())
    io_buffer.write(out)
    return io_buffer


def pack_audio(io_buffer: BytesIO, data: np.ndarray, rate: int, media_type: str):
    if media_type == "ogg":
        io_buffer = pack_ogg(io_buffer, data, rate)
    elif media_type == "aac":
        io_buffer = pack_aac(io_buffer, data, rate)
    elif media_type == "wav":
        io_buffer = pack_wav(io_buffer, data, rate)
    else:
        io_buffer = pack_raw(io_buffer, data, rate)
    io_buffer.seek(0)
    return io_buffer


# from https://huggingface.co/spaces/coqui/voice-chat-with-mistral/blob/main/app.py
def wave_header_chunk(frame_input=b"", channels=1, sample_width=2, sample_rate=32000):
    # This will create a wave header then append the frame input
    # It should be first on a streaming wav file
    # Other frames better should not have it (else you will hear some artifacts each chunk start)
    wav_buf = BytesIO()
    with wave.open(wav_buf, "wb") as vfout:
        vfout.setnchannels(channels)
        vfout.setsampwidth(sample_width)
        vfout.setframerate(sample_rate)
        vfout.writeframes(frame_input)

    wav_buf.seek(0)
    return wav_buf.read()


def handle_control(command: str):
    if command == "restart":
        os.execl(sys.executable, sys.executable, *argv)
    elif command == "exit":
        os.kill(os.getpid(), signal.SIGTERM)
        exit(0)


def check_params(req: dict):
    text: str = req.get("text", "")
    text_lang: str = req.get("text_lang", "")
    ref_audio_path: str = req.get("ref_audio_path", "")
    streaming_mode: bool = req.get("streaming_mode", False)
    media_type: str = req.get("media_type", "wav")
    prompt_lang: str = req.get("prompt_lang", "")
    text_split_method: str = req.get("text_split_method", "cut5")

    if ref_audio_path in [None, ""]:
        return JSONResponse(status_code=400, content={"message": "ref_audio_path is required"})
    if text in [None, ""]:
        return JSONResponse(status_code=400, content={"message": "text is required"})
    if text_lang in [None, ""]:
        return JSONResponse(status_code=400, content={"message": "text_lang is required"})
    elif text_lang.lower() not in tts_config.languages:
        return JSONResponse(
            status_code=400,
            content={"message": f"text_lang: {text_lang} is not supported in version {tts_config.version}"},
        )
    if prompt_lang in [None, ""]:
        return JSONResponse(status_code=400, content={"message": "prompt_lang is required"})
    elif prompt_lang.lower() not in tts_config.languages:
        return JSONResponse(
            status_code=400,
            content={"message": f"prompt_lang: {prompt_lang} is not supported in version {tts_config.version}"},
        )
    if media_type not in ["wav", "raw", "ogg", "aac"]:
        return JSONResponse(status_code=400, content={"message": f"media_type: {media_type} is not supported"})
    # elif media_type == "ogg" and not streaming_mode:
    #     return JSONResponse(status_code=400, content={"message": "ogg format is not supported in non-streaming mode"})

    if text_split_method not in cut_method_names:
        return JSONResponse(
            status_code=400, content={"message": f"text_split_method:{text_split_method} is not supported"}
        )

    return None


async def tts_handle(req: dict):
    """
    Text to speech handler.

    Args:
        req (dict):
            {
                "text": "",                   # str.(required) text to be synthesized
                "text_lang: "",               # str.(required) language of the text to be synthesized
                "ref_audio_path": "",         # str.(required) reference audio path
                "aux_ref_audio_paths": [],    # list.(optional) auxiliary reference audio paths for multi-speaker tone fusion
                "prompt_text": "",            # str.(optional) prompt text for the reference audio
                "prompt_lang": "",            # str.(required) language of the prompt text for the reference audio
                "top_k": 15,                  # int. top k sampling
                "top_p": 1,                   # float. top p sampling
                "temperature": 1,             # float. temperature for sampling
                "text_split_method": "cut5",  # str. text split method, see text_segmentation_method.py for details.
                "batch_size": 1,              # int. batch size for inference
                "batch_threshold": 0.75,      # float. threshold for batch splitting.
                "split_bucket": True,         # bool. whether to split the batch into multiple buckets.
                "speed_factor":1.0,           # float. control the speed of the synthesized audio.
                "fragment_interval":0.3,      # float. to control the interval of the audio fragment.
                "seed": -1,                   # int. random seed for reproducibility.
                "parallel_infer": True,       # bool. whether to use parallel inference.
                "repetition_penalty": 1.35,   # float. repetition penalty for T2S model.
                "sample_steps": 32,           # int. number of sampling steps for VITS model V3.
                "super_sampling": False,      # bool. whether to use super-sampling for audio when using VITS model V3.
                "streaming_mode": False,      # bool or int. return audio chunk by chunk.T he available options are: 0,1,2,3 or True/False (0/False: Disabled | 1/True: Best Quality, Slowest response speed (old version streaming_mode) | 2: Medium Quality, Slow response speed | 3: Lower Quality, Faster response speed )
                "overlap_length": 2,          # int. overlap length of semantic tokens for streaming mode.
                "min_chunk_length": 16,       # int. The minimum chunk length of semantic tokens for streaming mode. (affects audio chunk size)
            }
    returns:
        StreamingResponse: audio stream response.
    """

    # 纯数字输入 → 逐位读(12345 → 一二三四五, 手机号/验证码/编号逐位更自然; 仅中文语境)
    try:
        _t0 = str(req.get("text") or "")
        _l0 = str(req.get("text_lang") or "auto")
        if (_l0.startswith("zh") or _l0 == "auto") and _t0.strip() and re.fullmatch(r"\d+", _t0.strip()):
            _CN = "零一二三四五六七八九"
            req["text"] = "".join(_CN[int(ch)] for ch in _t0.strip())
    except Exception:
        pass
    # 多模型并行池: 请求带角色名 → 用该角色的常驻模型实例(权重已加载) + 该角色自己的默认参考/提示;
    # 无角色/激活角色(GM 主角色) → 走热换的 tts_pipeline(CHAR_CONFIG 补齐)
    _role = str(req.get("role") or req.get("character_name") or "").strip()
    _pipe = None
    if _role:
        _pipe = _pool_get(_role)
        if _pipe is not tts_pipeline:
            try:
                _yc = os.path.join(_CHARS_ROOT, _role, "character.yaml")
                if os.path.isfile(_yc):
                    import yaml as _y2
                    with open(_yc, "r", encoding="utf-8") as _f2:
                        _rcfg = _y2.safe_load(_f2) or {}
                    _rcfg = _rcfg[0] if isinstance(_rcfg, list) and _rcfg else _rcfg
                    if isinstance(_rcfg, dict):
                        if not req.get("ref_audio_path"): req["ref_audio_path"] = _pool_char_path(os.path.dirname(_yc), str(_rcfg.get("refer_audio_path", "") or "")) or ""
                        if not req.get("prompt_text"): req["prompt_text"] = str(_rcfg.get("prompt_text", "") or "")
                        if not req.get("prompt_lang"): req["prompt_lang"] = str(_rcfg.get("prompt_lang", "") or "")
            except Exception:
                pass
    else:
        _pipe = tts_pipeline
    # FVTT 扩展: 角色包已加载时, 自动补齐 ref_audio_path / prompt_text / prompt_lang / text_lang
    if _pipe is tts_pipeline and CHAR_CONFIG:
        if not req.get("ref_audio_path"):
            req["ref_audio_path"] = CHAR_CONFIG["ref_audio_path"]
        if not req.get("prompt_text"):
            req["prompt_text"] = CHAR_CONFIG["prompt_text"]
        if not req.get("prompt_lang"):
            req["prompt_lang"] = CHAR_CONFIG["prompt_lang"]
        if not req.get("text_lang"):
            req["text_lang"] = CHAR_CONFIG.get("default_text_lang", "auto")
    # 诊断: 合成请求落盘(每次 /tts 实际收到的文字/语言/辅助参考), 排查"不同输入合成同一段"
    try:
        with open(os.path.join(os.path.dirname(__file__), "tts-requests.log"), "a", encoding="utf-8") as _lf:
            _lf.write("[%s] [tts] text=%r lang=%s role=%r aux=%s\n" % (
                time.strftime("%H:%M:%S"), str(req.get("text") or "")[:60], req.get("text_lang"), req.get("role"), str(req.get("aux_ref_audio_paths") or [])[:140]))
    except Exception:
        pass
    # 客户端可传参考音频(如语气样本/导入片段), 解析为服务器真实路径; 短样本(<3s)静音补足
    req["ref_audio_path"] = _resolve_ref(req.get("ref_audio_path"))
    req["ref_audio_path"] = _prepare_ref(req.get("ref_audio_path"), req.get("allow_short_ref", False))

    # 多参考融合: aux 情绪参考(在主参考基础上叠加情绪特征); 情绪样本通常<3s, 一律补足
    # 情绪占比 emotion_mix: 0=纯默认(去 aux) / 1=全情绪(情绪音频作主参考) / 中间=主参考+aux 融合
    _emotion_mix = req.get("emotion_mix")
    try:
        _emotion_mix = float(_emotion_mix) if _emotion_mix is not None else 0.5
    except (TypeError, ValueError):
        _emotion_mix = 0.5
    _emotion_mix = max(0.0, min(1.0, _emotion_mix))
    req["emotion_mix"] = _emotion_mix
    _aux = req.get("aux_ref_audio_paths") or []
    if _aux:
        _resolved = []
        for _ap in _aux:
            _ap = _resolve_ref(_ap)
            if _ap:
                _ap = _prepare_ref(_ap, True)
                if _ap:
                    _ap = _trim_lead_silence(_ap)   # 情绪样本开头起音弱 → 裁静音, 合成开头不弱
                if _ap and _ap not in _resolved:
                    _resolved.append(_ap)
        if _emotion_mix >= 1.0:
            req["ref_audio_path"] = _resolved[0]      # 全情绪: 情绪音频作唯一参考
            req["aux_ref_audio_paths"] = []
        elif _emotion_mix <= 0.0:
            req["aux_ref_audio_paths"] = []           # 纯默认: 不用情绪音频
        else:
            req["aux_ref_audio_paths"] = _resolved    # 中间: 主参考+aux 融合

    streaming_mode = req.get("streaming_mode", False)
    return_fragment = req.get("return_fragment", False)
    media_type = req.get("media_type", "wav")
    want_mp3 = False
    if str(media_type).lower() == "mp3":
        want_mp3 = True
        media_type = "wav"
        req["media_type"] = "wav"   # 引擎/check_params 不支持 mp3: 内部用 wav, 响应前再转码

    # 硬件自适应 batch_size(引擎 batch 并行, =Shinsekai 参数): 显存 >=14GB→6, >=8→3, >=4→2, 否则 1
    # 长文本按 cut 切出多段时并行推理(多段同时合成), 而不是逐句串行 → 2~4 倍提速
    try:
        _bs = int(req.get("batch_size", 0) or 0)
    except Exception:
        _bs = 0
    if _bs <= 1:
        _vram = float(HW_INFO.get("gpu_mem_total_gb", 0) or 0)
        _bs = 6 if _vram >= 14 else (3 if _vram >= 8 else (2 if _vram >= 4 else 1))
    req["batch_size"] = _bs

    check_res = check_params(req)
    if check_res is not None:
        return check_res
    
    if streaming_mode == 0:
        streaming_mode = False
        return_fragment = False
        fixed_length_chunk = False
    elif streaming_mode == 1:
        streaming_mode = False
        return_fragment = True
        fixed_length_chunk = False
    elif streaming_mode == 2:
        streaming_mode = True
        return_fragment = False
        fixed_length_chunk = False
    elif streaming_mode == 3:
        streaming_mode = True
        return_fragment = False
        fixed_length_chunk = True

    else:
        return JSONResponse(status_code=400, content={"message": f"the value of streaming_mode must be 0, 1, 2, 3(int) or true/false(bool)"})

    req["streaming_mode"] = streaming_mode
    req["return_fragment"] = return_fragment
    req["fixed_length_chunk"] = fixed_length_chunk

    print(f"{streaming_mode} {return_fragment} {fixed_length_chunk}")

    streaming_mode = streaming_mode or return_fragment


    try:
        tts_generator = _pipe.run(req)

        if streaming_mode:

            def streaming_generator(tts_generator: Generator, media_type: str):
                if_frist_chunk = True
                for sr, chunk in tts_generator:
                    if if_frist_chunk and media_type == "wav":
                        yield wave_header_chunk(sample_rate=sr)
                        media_type = "raw"
                        if_frist_chunk = False
                    yield pack_audio(BytesIO(), chunk, sr, media_type).getvalue()

            # _media_type = f"audio/{media_type}" if not (streaming_mode and media_type in ["wav", "raw"]) else f"audio/x-{media_type}"
            return StreamingResponse(
                streaming_generator(
                    tts_generator,
                    media_type,
                ),
                media_type=f"audio/{media_type}",
            )

        else:
            # 文本清洗(括号动作描写剥离) + 引擎内部切分(cut5) + 硬件自适应 batch 并行
            # (=Shinsekai 同款参数: 多段同时推理, 而不是逐句串行 → 长文本 2~4 倍提速)
            _text_raw = _clean_tts_text(req.get("text") or "")
            req["text"] = _text_raw
            sr, audio_data = next(tts_generator)   # 引擎内部按切分+batch 并行合成, 返回整段
            audio_data = _limit_peak(_boost_head(_lift_weak_head(_trim_lead_silence_arr(_to_float_audio(audio_data), sr), sr), sr))   # 归一化 → 裁纯静音 → 弱起软提升 → 头部增益 → 防削波
            audio_data = pack_audio(BytesIO(), audio_data, sr, media_type).getvalue()
            if want_mp3:
                mp3_bytes = _wav_to_mp3(audio_data)
                if mp3_bytes:
                    return _respond_with_file(mp3_bytes, "audio/mpeg", req)
            return _respond_with_file(audio_data, f"audio/{media_type}", req)
    except Exception as e:
        # 失败落盘(400 详情): 排查并发/多角色窗口下玩家端合成失败 — 引擎侧确认收到请求及具体原因
        try:
            with open(os.path.join(os.path.dirname(__file__), "tts-requests.log"), "a", encoding="utf-8") as _lf:
                _lf.write("[%s] [tts-FAIL] http400 role=%r ref=%r aux=%s err=%r\n" % (
                    time.strftime("%H:%M:%S"), req.get("role"), req.get("ref_audio_path"), str(req.get("aux_ref_audio_paths") or [])[:140], str(e)[:300]))
        except Exception:
            pass
        return JSONResponse(status_code=400, content={"message": "tts failed", "Exception": str(e)})


@APP.get("/control")
async def control(command: str = None):
    if command is None:
        return JSONResponse(status_code=400, content={"message": "command is required"})
    handle_control(command)


_SWITCHING = False   # 角色模型切换中(tts 拒绝, 防用错模型合成)
_TTS_BUSY = 0        # 正在合成的请求数(switch 等待其归零, 防合成中换模型错角色)


@APP.get("/tts")
async def tts_get_endpoint(
    text: str = None,
    text_lang: str = None,
    ref_audio_path: str = None,
    aux_ref_audio_paths: list = None,
    prompt_lang: str = None,
    prompt_text: str = "",
    top_k: int = 15,
    top_p: float = 1,
    temperature: float = 1,
    text_split_method: str = "cut5",
    batch_size: int = 1,
    batch_threshold: float = 0.75,
    split_bucket: bool = True,
    speed_factor: float = 1.0,
    fragment_interval: float = 0.3,
    seed: int = -1,
    media_type: str = "wav",
    parallel_infer: bool = True,
    repetition_penalty: float = 1.35,
    sample_steps: int = 32,
    super_sampling: bool = False,
    streaming_mode: Union[bool, int] = False,
    overlap_length: int = 2,
    min_chunk_length: int = 16,
    allow_short_ref: bool = False,
):
    # FVTT 扩展: 角色包已加载时, 自动补齐缺失参数(避免 text_lang 为 None 时崩溃)
    if CHAR_CONFIG:
        if not text_lang:
            text_lang = CHAR_CONFIG.get("default_text_lang", "auto")
        if not ref_audio_path:
            ref_audio_path = CHAR_CONFIG["ref_audio_path"]
        if not prompt_lang:
            prompt_lang = CHAR_CONFIG["prompt_lang"]
        if not prompt_text:
            prompt_text = CHAR_CONFIG["prompt_text"]
    ref_audio_path = _resolve_ref(ref_audio_path)
    ref_audio_path = _prepare_ref(ref_audio_path, allow_short_ref)
    if not text_lang:
        text_lang = "auto"
    req = {
        "text": text,
        "text_lang": text_lang.lower(),
        "ref_audio_path": ref_audio_path,
        "aux_ref_audio_paths": aux_ref_audio_paths,
        "prompt_text": prompt_text,
        "prompt_lang": prompt_lang.lower(),
        "top_k": top_k,
        "top_p": top_p,
        "temperature": temperature,
        "text_split_method": text_split_method,
        "batch_size": int(batch_size),
        "batch_threshold": float(batch_threshold),
        "speed_factor": float(speed_factor),
        "split_bucket": split_bucket,
        "fragment_interval": fragment_interval,
        "seed": seed,
        "media_type": media_type,
        "streaming_mode": streaming_mode,
        "parallel_infer": parallel_infer,
        "repetition_penalty": float(repetition_penalty),
        "sample_steps": int(sample_steps),
        "super_sampling": super_sampling,
        "overlap_length": int(overlap_length),
        "min_chunk_length": int(min_chunk_length),
    }
    return await _tts_guard(req)


@APP.post("/tts")
async def tts_post_endpoint(request: TTS_Request):
    req = request.dict()
    return await _tts_guard(req)


async def _tts_guard(req):
    """tts 互斥: 模型切换中拒绝; 合成期间计数(switch 等待其结束, 防合成中换模型导致错角色声音)."""
    global _SWITCHING, _TTS_BUSY
    if _SWITCHING:
        return JSONResponse(status_code=503, content={"ok": False, "message": "角色模型切换中，请稍候重试"})
    _TTS_BUSY += 1
    try:
        return await tts_handle(req)
    finally:
        _TTS_BUSY -= 1


# Edge-TTS 在线合成(多引擎并行): 低配服务器/免部署角色用 — 服务器通过 edge_tts 库转发微软在线音色,
# 负载极低(只做转发), 音频同样导出 Foundry 静态路径(X-Fvtt-Audio-Url)供全员同源拉流; voice 可覆盖默认音色
EDGE_VOICES = {
    "auto": "zh-CN-XiaoxiaoNeural",
    "zh": "zh-CN-XiaoxiaoNeural",
    "zh-CN": "zh-CN-XiaoxiaoNeural",
    "ja": "ja-JP-NanamiNeural",
    "en": "en-US-AriaNeural",
    "ko": "ko-KR-SunHiNeural",
    "yue": "zh-HK-HiuMaanNeural",
}


@APP.post("/tts/edge")
async def tts_edge_endpoint(request: Request):
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"ok": False, "message": "bad json"})
    text = str(body.get("text") or "").strip()
    if not text:
        return JSONResponse(status_code=400, content={"ok": False, "message": "text required"})
    lang = str(body.get("lang") or "zh")
    voice = str(body.get("voice") or EDGE_VOICES.get(lang) or EDGE_VOICES["zh"])
    try:
        import edge_tts
    except Exception as e:
        return JSONResponse(status_code=500, content={"ok": False, "message": "edge-tts 未安装: %s" % str(e)})
    try:
        rate = "+0%"
        try:
            spd = float(body.get("speed") or 0)
            rate = "%+d%%" % max(-50, min(150, int(spd * 20)))
        except Exception:
            pass
        com = edge_tts.Communicate(text=text, voice=voice, rate=rate)
        chunks = []
        async for c in com.stream():
            if c.get("type") == "audio":
                chunks.append(c["data"])
        mp3 = b"".join(chunks)
        if not mp3:
            return JSONResponse(status_code=500, content={"ok": False, "message": "edge-tts 无音频返回(服务器无法访问微软服务?)"})
        return _respond_with_file(mp3, "audio/mpeg", req=None)
    except Exception as e:
        return JSONResponse(status_code=500, content={"ok": False, "message": "edge-tts 合成失败: %s" % str(e)})


@APP.get("/set_refer_audio")
async def set_refer_aduio(refer_audio_path: str = None):
    try:
        tts_pipeline.set_ref_audio(refer_audio_path)
    except Exception as e:
        return JSONResponse(status_code=400, content={"message": "set refer audio failed", "Exception": str(e)})
    return JSONResponse(status_code=200, content={"message": "success"})


# @APP.post("/set_refer_audio")
# async def set_refer_aduio_post(audio_file: UploadFile = File(...)):
#     try:
#         # 检查文件类型，确保是音频文件
#         if not audio_file.content_type.startswith("audio/"):
#             return JSONResponse(status_code=400, content={"message": "file type is not supported"})

#         os.makedirs("uploaded_audio", exist_ok=True)
#         save_path = os.path.join("uploaded_audio", audio_file.filename)
#         # 保存音频文件到服务器上的一个目录
#         with open(save_path , "wb") as buffer:
#             buffer.write(await audio_file.read())

#         tts_pipeline.set_ref_audio(save_path)
#     except Exception as e:
#         return JSONResponse(status_code=400, content={"message": f"set refer audio failed", "Exception": str(e)})
#     return JSONResponse(status_code=200, content={"message": "success"})


@APP.get("/set_gpt_weights")
async def set_gpt_weights(weights_path: str = None):
    try:
        if weights_path in ["", None]:
            return JSONResponse(status_code=400, content={"message": "gpt weight path is required"})
        tts_pipeline.init_t2s_weights(_resolve_ref(weights_path))
    except Exception as e:
        return JSONResponse(status_code=400, content={"message": "change gpt weight failed", "Exception": str(e)})

    return JSONResponse(status_code=200, content={"message": "success"})


@APP.get("/set_sovits_weights")
async def set_sovits_weights(weights_path: str = None):
    try:
        if weights_path in ["", None]:
            return JSONResponse(status_code=400, content={"message": "sovits weight path is required"})
        tts_pipeline.init_vits_weights(_resolve_ref(weights_path))
    except Exception as e:
        return JSONResponse(status_code=400, content={"message": "change sovits weight failed", "Exception": str(e)})
    return JSONResponse(status_code=200, content={"message": "success"})


# ---------------- FVTT 扩展: 状态 / 角色查询 ----------------
@APP.get("/")
async def root():
    return {"ok": True, "service": "GPT-SoVITS (fvtt_api.py)", "docs": "/docs", "status": "/status"}


@APP.get("/audio/{fname}")
async def audio_file(fname: str):
    """缓存音频拉流(URL 广播用): 玩家直接 HTTP 拉取合成好的音频, 不走 socket(无大小限制, 局域网直连快)."""
    fname = os.path.basename(str(fname))
    p = os.path.join(_AUDIO_CACHE, fname)
    if not os.path.isfile(p):
        return JSONResponse(status_code=404, content={"ok": False, "message": "audio not found"})
    return FileResponse(p, media_type="audio/mpeg" if str(fname).lower().endswith(".mp3") else "audio/wav")


@APP.get("/status")
async def status():
    char = None
    if CHAR_CONFIG:
        char = dict(CHAR_CONFIG)
        for k in ("gpt_model_path", "sovits_model_path", "ref_audio_path"):
            if char.get(k):
                char[k] = os.path.basename(str(char[k]))
    lan_ip = ""
    try:
        import socket as _sock
        _s = _sock.socket(_sock.AF_INET, _sock.SOCK_DGRAM)
        _s.connect(("8.8.8.8", 80))   # UDP 不真发包, 仅取本机对外网卡 IP
        lan_ip = _s.getsockname()[0]
        _s.close()
    except Exception:
        pass
    return {
        "ok": True,
        "service": "GPT-SoVITS (fvtt_api.py)",
        "version": getattr(tts_config, "version", None),
        "device": str(getattr(tts_config, "device", "")),
        "is_half": bool(getattr(tts_config, "is_half", False)),
        "languages": getattr(tts_config, "languages", []),
        "hw": dict(HW_INFO),
        "lan_ip": lan_ip,
        "synth_cache": {"size": len(_SYNTH_CACHE), "max": _SYNTH_CACHE_MAX},
        "character": char,
        "pool": {"size": len(TTS_POOL), "max": MAX_MODEL_POOL, "active": list(TTS_POOL.keys())},
    }


@APP.get("/config")
async def config_get():
    return {"ok": True, "max_concurrent_models": MAX_MODEL_POOL}


@APP.post("/config")
async def config_post(request: Request):
    """GM 在 Foundry 设置里改"同时运行上限" → 客户端同步到这里(立即裁剪/扩容模型池)."""
    global MAX_MODEL_POOL
    try:
        body = await request.json()
        v = int(body.get("max_concurrent_models", MAX_MODEL_POOL))
    except Exception:
        return JSONResponse(status_code=400, content={"ok": False, "message": "bad json"})
    MAX_MODEL_POOL = max(1, min(20, v))
    if MAX_MODEL_POOL < len(TTS_POOL):
        with _POOL_LOCK:
            _pool_evict_lru()
    save_pool_config(MAX_MODEL_POOL)
    return {"ok": True, "max_concurrent_models": MAX_MODEL_POOL, "pool_size": len(TTS_POOL)}


@APP.get("/characters")
async def characters():
    """角色清单: 所有已安装角色 + 当前激活角色 + 每个角色的 10 语气槽."""
    installed = list_installed_chars()
    active = CHAR_CONFIG.get("name") if CHAR_CONFIG else None
    chars = []
    for ch in installed:
        name = ch["name"]
        cfg = read_char_yaml(name)
        if not cfg:
            continue
        gpt = cfg.get("gpt_model_path", "")
        sovits = cfg.get("sovits_model_path", "")
        ref = cfg.get("refer_audio_path", "")
        chars.append({
            "name": name,
            "gpt_model_path": os.path.basename(str(gpt)) if gpt else "",
            "sovits_model_path": os.path.basename(str(sovits)) if sovits else "",
            "ref_audio_path": str(ref).replace("\\", "/") if ref else "",   # 角色目录内相对(客户端拼 fvtt_chars/<角色>/ 全路径)
            "prompt_text": cfg.get("prompt_text", ""),
            "prompt_lang": cfg.get("prompt_lang", ""),
            "setting": str(cfg.get("character_setting", "") or "")[:1500],
            "avatar": str(cfg.get("avatar", "") or ""),
            "provider": str(cfg.get("tts_provider") or "gpt-sovits"),   # 多引擎并行: gpt-sovits / edge / web
            "emotions": emotion_slot_state(cfg),
        })
    # 激活角色附带细节(权重路径/模型清单等)
    detail = None
    if CHAR_CONFIG:
        detail = {}
        for k in ("name", "prompt_text", "prompt_lang", "default_text_lang", "emotions", "models_list", "source_dir"):
            detail[k] = CHAR_CONFIG.get(k)
        for k in ("gpt_model_path", "sovits_model_path", "ref_audio_path"):
            if CHAR_CONFIG.get(k):
                detail[k] = os.path.basename(str(CHAR_CONFIG[k]))
        imports = []
        imports_dir = os.path.join(os.getcwd(), "fvtt_chars", "imports")
        if os.path.isdir(imports_dir):
            for fn in sorted(os.listdir(imports_dir)):
                if fn.lower().endswith((".wav", ".mp3", ".flac", ".ogg", ".aac", ".m4a", ".webm")):
                    imports.append({"name": fn, "ref_audio_path": "fvtt_chars/imports/" + fn})
        detail["imports"] = imports
        # 把模型清单/导入音频也注入到 chars 中激活角色的那一项(客户端直接用)
        for item in chars:
            if item["name"] == active:
                item["models_list"] = detail.get("models_list", {"gpt": [], "sovits": []})
                item["imports"] = detail.get("imports", [])
    # 角色快照导出(通用架构): 每次角色清单读取时刷新 → 客户端优先从 FVTT 30000 静态拉取, 不依赖 9881 可达
    try:
        _write_chars_snapshot(chars)
    except Exception:
        pass
    return {"ok": True, "chars": chars, "active": active, "detail": detail}


def _write_chars_snapshot(chars):
    """角色清单快照(通用架构): 只留客户端 UI/立绘所需字段, 导出到模块目录 engine/audio_export/chars_meta.json,
    经 Foundry 30000 静态路径(/modules/gpt-sovits-tts/engine/audio_export/chars_meta.json)分发给所有客户端 —
    pl 在 HTTPS 穿透/跨网/9881 不可达/低配服务器环境下也能拿到角色与立绘路径(立绘保持相对路径, 客户端拼 location.origin)"""
    try:
        _xd = os.path.join(os.path.dirname(__file__), "..", "engine", "audio_export")
        os.makedirs(_xd, exist_ok=True)
        sparsed = []
        for c in (chars or []):
            emos = c.get("emotions") or []
            sparsed.append({
                "name": c.get("name", ""),
                "avatar": c.get("avatar", ""),
                "provider": c.get("provider", "gpt-sovits"),
                "prompt_lang": c.get("prompt_lang", ""),
                "setting": c.get("setting", ""),
                "emotions": [{
                    "key": e.get("key", ""), "label": e.get("label", ""),
                    "avatar": e.get("avatar", ""), "ref": e.get("ref", ""),
                } for e in emos] if isinstance(emos, list) else [],
            })
        body_txt = json.dumps(sparsed, ensure_ascii=False)
        _tp = os.path.join(_xd, "chars_meta.json")
        with open(_tp, "w", encoding="utf-8") as _f:
            _f.write('{"ts": %d, "count": %d, "chars": %s}' % (int(time.time()), len(sparsed), body_txt))
    except Exception:
        pass


@APP.get("/voices")
async def voices():
    """模型库: GPT/SoVITS 清单 + 基础音色模型对 + 已安装角色."""
    lib = scan_model_library()
    base = base_model_pair()
    return {
        "ok": True,
        "gpt": lib["gpt"],
        "sovits": lib["sovits"],
        "base_model": base,
        "model_lib_dir": "fvtt_chars/models/",
        "chars": [c["name"] for c in list_installed_chars()],
        "active": CHAR_CONFIG.get("name") if CHAR_CONFIG else None,
    }


@APP.post("/characters/switch")
async def characters_switch(request: Request):
    """切换当前激活角色(热加载权重+主参考+提示). 与 /tts 互斥: 先等正在合成的请求结束(最多 30s),
    切换期间拒绝新合成请求(503), 防止多人不同角色时用错模型/合成中换模型."""
    global _SWITCHING
    body = await request.json()
    name = str(body.get("name", "")).strip()
    if not name:
        return JSONResponse(status_code=400, content={"ok": False, "message": "name is required"})
    for _ in range(60):   # 等待当前合成完成(每次 0.5s, 最长 30s)
        if _TTS_BUSY <= 0:
            break
        await asyncio.sleep(0.5)
    _SWITCHING = True
    try:
        err = activate_character(name)
        if err:
            return JSONResponse(status_code=400, content={"ok": False, "message": err})
        return {"ok": True, "active": CHAR_CONFIG.get("name") if CHAR_CONFIG else name}
    finally:
        _SWITCHING = False


@APP.post("/characters/preload")
async def characters_preload(request: Request):
    """并行预加载多个角色模型进常驻池(多模型并行, 不互相顶掉): 此后这些角色合成即用, 无首次加载等待.
    body: {"names": ["角色A", ...], "max_workers": 3}
    → {"ok": True, "loaded": [...], "failed": {name: err}, "pool_size": n, "max": 池上限, "pool_active": [...]}"""
    try:
        body = await request.json()
    except Exception:
        body = {}
    names = [str(n).strip() for n in (body.get("names") or []) if str(n).strip()]
    if not names:
        return {"ok": False, "err": "names empty"}
    from concurrent.futures import ThreadPoolExecutor
    mw = max(1, min(4, int(body.get("max_workers") or 3)))
    print("[模型池] 并行预加载 %d 个角色(max_workers=%d): %s" % (len(names), mw, names))

    def _do(nm):
        try:
            # 激活角色(GM 主角色)走热换 tts_pipeline, 本就立即可用, 不算失败
            if CHAR_CONFIG and str(CHAR_CONFIG.get("name") or "") == nm:
                return (nm, "active")
            p = _pool_get(nm)
            return (nm, "ok" if p is not tts_pipeline else "fallback")
        except Exception as e:
            return (nm, "err:" + str(e)[:160])

    loaded, failed = [], {}
    with ThreadPoolExecutor(max_workers=mw) as ex:
        for nm, st in ex.map(_do, names):
            if st == "ok" or st == "active":
                loaded.append(nm)
            elif st.startswith("err"):
                failed[nm] = st[4:]
            else:
                failed[nm] = "权重不完整/回退激活角色"
    print("[模型池] 预加载完成: ok=%s failed=%s (常驻 %d/%d)" % (loaded, failed, len(TTS_POOL), MAX_MODEL_POOL))
    return {"ok": True, "loaded": loaded, "failed": failed,
            "pool_size": len(TTS_POOL), "max": MAX_MODEL_POOL,
            "pool_active": list(TTS_POOL.keys())}


@APP.post("/characters/update")
async def characters_update(request: Request):
    """更新角色元数据: 主参考/提示文本/10 语气槽(换音频/清空/改台词)."""
    body = await request.json()
    name = str(body.get("name", "")).strip()
    if not name:
        return JSONResponse(status_code=400, content={"ok": False, "message": "name is required"})
    cfg = read_char_yaml(name)
    if not cfg:
        return JSONResponse(status_code=400, content={"ok": False, "message": "角色 %s 不存在" % name})
    # 可更新主参考与提示
    if "refer_audio_path" in body and body["refer_audio_path"]:
        cfg["refer_audio_path"] = body["refer_audio_path"]
    if "prompt_text" in body:
        cfg["prompt_text"] = body["prompt_text"]
    if "prompt_lang" in body:
        cfg["prompt_lang"] = body["prompt_lang"]
    # 多引擎并行: 角色引擎选择(gpt-sovits 本地高音质 / edge 服务器转发微软在线 / web edge优先)
    if "tts_provider" in body:
        _pv = str(body["tts_provider"] or "gpt-sovits").strip()
        if _pv in ("gpt-sovits", "edge", "web"):
            cfg["tts_provider"] = _pv
    # 语气槽更新: emotions: {key: {ref, prompt, lang}} (ref 为空字符串 = 清空绑定)
    slots_new = body.get("emotions")
    if isinstance(slots_new, dict):
        raw = cfg.get("emotions")
        by_key = {}
        if isinstance(raw, dict):
            by_key.update(raw)
        elif isinstance(raw, list):
            for it in raw:
                if isinstance(it, dict):
                    by_key[str(it.get("key", ""))] = it
        for key, val in slots_new.items():
            if key not in EMOTION_SLOT_KEYS:
                continue
            if val is None:
                by_key.pop(key, None)
                continue
            entry = by_key.get(key) or {}
            if "ref" in val:
                entry["ref"] = val["ref"] or ""
            if "prompt" in val:
                entry["prompt"] = val["prompt"] or ""
            if "lang" in val:
                entry["lang"] = val["lang"] or ""
            by_key[key] = entry
        cfg["emotions"] = by_key
    save_char_yaml(name, cfg)
    # 若更新的是当前激活角色, 立即重载(权重不变, 只换参考/提示; 语气槽无需重载权重)
    if CHAR_CONFIG and CHAR_CONFIG.get("name") == name:
        try:
            load_character(os.path.join(os.getcwd(), "fvtt_chars", name, "character.yaml"))
        except Exception as e:
            print("重载角色失败(仍已保存): %s" % e)
    return {"ok": True, "name": name}


@APP.post("/characters/create")
async def characters_create(request: Request):
    """新建角色: name + 音色模型来源 + 主参考音频 + 提示; 创建后立即切换激活."""
    body = await request.json()
    name = str(body.get("name", "")).strip() or ("角色%d" % int(time.time()) % 1000)
    use_base = bool(body.get("use_base_model"))
    gpt_file = str(body.get("gpt_file", "") or "").strip()
    sovits_file = str(body.get("sovits_file", "") or "").strip()
    ref_path = str(body.get("ref_audio_path", "") or "").strip()
    prompt_text = str(body.get("prompt_text", "") or "")
    prompt_lang = str(body.get("prompt_lang", "") or "auto")

    d = os.path.join(_CHARS_ROOT, name)
    if os.path.isdir(d) and os.path.isfile(os.path.join(d, "character.yaml")):
        return JSONResponse(status_code=400, content={"ok": False, "message": "角色 %s 已存在" % name})
    try:
        import shutil as _sh
        os.makedirs(os.path.join(d, "models"), exist_ok=True)
        os.makedirs(os.path.join(d, "speech"), exist_ok=True)
        base = base_model_pair()
        if use_base and base["available"]:
            gpt_abs, sovits_abs = base["gpt_path"], base["sovits_path"]
            gpt_file, sovits_file = base["gpt"], base["sovits"]
        else:
            gpt_abs = _resolve_ref(os.path.join(_MODEL_LIB, gpt_file)) if gpt_file else ""
            sovits_abs = _resolve_ref(os.path.join(_MODEL_LIB, sovits_file)) if sovits_file else ""
            # 模型库权重复制进角色目录(角色自包含, 导出 .char 带权重)
            if gpt_abs and os.path.isfile(gpt_abs):
                _sh.copyfile(gpt_abs, os.path.join(d, "models", os.path.basename(gpt_abs)))
                gpt_abs = os.path.join(d, "models", os.path.basename(gpt_abs))
            if sovits_abs and os.path.isfile(sovits_abs):
                _sh.copyfile(sovits_abs, os.path.join(d, "models", os.path.basename(sovits_abs)))
                sovits_abs = os.path.join(d, "models", os.path.basename(sovits_abs))
        if not gpt_abs or not os.path.isfile(gpt_abs):
            return JSONResponse(status_code=400, content={"ok": False, "message": "GPT 权重无效: %s" % gpt_file})
        if not sovits_abs or not os.path.isfile(sovits_abs):
            return JSONResponse(status_code=400, content={"ok": False, "message": "SoVITS 权重无效: %s" % sovits_file})
        if not ref_path:
            return JSONResponse(status_code=400, content={"ok": False, "message": "需要主参考音频(ref_audio_path)"})
        ref_abs = resolve_in_char(name, ref_path) or _resolve_ref(ref_path)
        if not ref_abs or not os.path.isfile(ref_abs):
            return JSONResponse(status_code=400, content={"ok": False, "message": "主参考音频不存在: %s" % ref_path})
        # 主参考音频拷入角色 speech/ 目录(角色自包含, 转发不丢文件)
        if os.path.abspath(ref_abs).startswith(os.path.abspath(d) + os.sep):
            ref_rel = os.path.relpath(ref_abs, d).replace("\\", "/")
        else:
            fname = "ref_%s%s" % (time.strftime("%Y%m%d_%H%M%S"), os.path.splitext(ref_abs)[1].lower() or ".wav")
            _sh.copyfile(ref_abs, os.path.join(d, "speech", fname))
            ref_rel = "speech/" + fname
    except Exception as e:
        return JSONResponse(status_code=400, content={"ok": False, "message": "创建角色失败: %s" % e})

    cfg = {
        "name": name,
        "gpt_model_path": "models/%s" % os.path.basename(gpt_file) if gpt_file else "models/%s" % os.path.basename(gpt_abs),
        "sovits_model_path": "models/%s" % os.path.basename(sovits_file) if sovits_file else "models/%s" % os.path.basename(sovits_abs),
        "refer_audio_path": ref_rel,
        "prompt_text": prompt_text,
        "prompt_lang": prompt_lang,
        "emotions": {},  # 10 槽随后通过 update 绑定
    }
    # 基础模型: 引用引擎 pretrained 路径(cwd 相对)
    if use_base:
        cfg["gpt_model_path"] = "GPT_SoVITS/pretrained_models/%s" % os.path.basename(gpt_abs)
        cfg["sovits_model_path"] = "GPT_SoVITS/pretrained_models/%s" % os.path.basename(sovits_abs)
    save_char_yaml(name, cfg)
    err = activate_character(name)
    if err:
        return JSONResponse(status_code=400, content={"ok": False, "message": "角色已创建但切换失败: %s" % err})
    return {"ok": True, "name": name}


def _import_char_zip(data: bytes):
    """共用: 校验 zip + 解压到 fvtt_chars/<name> + 激活; 返回 (name, err)。"""
    import io
    import zipfile as _zipfile
    try:
        zf = _zipfile.ZipFile(io.BytesIO(data))
    except Exception as e:
        return None, "不是有效的 .char 压缩包: %s" % e
    d = None
    try:
        yaml_names = [n for n in zf.namelist() if n.replace("\\", "/").endswith("character.yaml")]
        if not yaml_names:
            return None, "包内没有 character.yaml"
        raw = _yaml.safe_load(zf.read(yaml_names[0]).decode("utf-8", errors="replace")) or {}
        cfg = raw[0] if isinstance(raw, list) and raw else raw
        name = os.path.basename(str(cfg.get("name", ""))).strip() or "导入角色"
        name = "".join(c for c in name if c not in '\\/:*?"<>|')
        d = os.path.join(_CHARS_ROOT, name)
        # 已存在检查: 绝不因"已存在"误删磁盘上的角色目录
        if os.path.isdir(d) and os.path.isfile(os.path.join(d, "character.yaml")):
            return None, "角色 %s 已存在, 请先删除或改名" % name
        if os.path.isdir(d):
            shutil_rm(d)   # 残留空壳(无 character.yaml 的上次失败遗留)直接清理
        os.makedirs(d, exist_ok=True)
        for n in zf.namelist():
            if n.endswith("/"):
                continue
            rel = n.replace("\\", "/")
            if rel.startswith("data/"):      # 兼容带 data/ 前缀的角色包
                rel = rel[len("data/"):]
            safe = os.path.normpath(rel)
            if safe.startswith("..") or os.path.isabs(safe):
                continue
            dst = os.path.join(d, safe)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            with open(dst, "wb") as f:
                f.write(zf.read(n))
    except Exception as e:
        try:
            if d:
                shutil_rm(d)
        except Exception:
            pass
        return None, "解压失败: %s" % e
    finally:
        try:
            zf.close()
        except Exception:
            pass
    err = activate_character(name)
    if err:
        return None, "已导入但切换失败: %s" % err
    return name, None


@APP.post("/characters/import")
async def characters_import(request: Request):
    """上传 .char(zip) -> 解压到 fvtt_chars/<name> -> 语气映射 -> 切换激活(单次, 小包)."""
    data = await request.body()
    if not data:
        return JSONResponse(status_code=400, content={"ok": False, "message": "empty body"})
    if data.strip() in (b"null", b"", b"{}"):   # 防御: 旧客户端超限时曾发 "null"/空 → 明确提示而不是误导成"不是压缩包"
        return JSONResponse(status_code=400, content={"ok": False, "message": "未收到文件内容(角色包可能过大或读取失败), 请重新选择后导入"})
    name, err = _import_char_zip(data)
    if err:
        return JSONResponse(status_code=400, content={"ok": False, "message": err})
    return {"ok": True, "name": name, "message": "角色包导入成功"}


# ---- 角色包分片上传(超大包: 客户端分片发送, 引擎边收边落盘, 单次大 body/内存峰值消除) ----
_IMPORT_SESSIONS = {}


@APP.post("/characters/import-session")
async def import_session(request: Request):
    body = await request.json()
    size = int(body.get("size") or 0)
    if size <= 0 or size > 8 * 1024 * 1024 * 1024:
        return JSONResponse(status_code=400, content={"ok": False, "message": "size 无效(0~8GB)"})
    target = str(body.get("target") or "/characters/import")
    ctype = str(body.get("contentType") or "application/octet-stream")
    sid = uuid.uuid4().hex[:16]
    tmp = os.path.join(os.getcwd(), "fvtt_chars", ".tmp_imports")
    os.makedirs(tmp, exist_ok=True)
    path = os.path.join(tmp, "%s.zip" % sid)
    _IMPORT_SESSIONS[sid] = {"path": path, "total": size, "received": 0, "ts": time.time(), "target": target, "ctype": ctype}
    return {"ok": True, "session": sid}


@APP.post("/characters/import-chunk")
async def import_chunk(request: Request, session: str = ""):
    s = _IMPORT_SESSIONS.get(session)
    if not s:
        return JSONResponse(status_code=400, content={"ok": False, "message": "上传会话不存在或已过期"})
    data = await request.body()
    if not data:
        return JSONResponse(status_code=400, content={"ok": False, "message": "empty chunk"})
    with open(s["path"], "ab") as f:
        f.write(data)
    s["received"] += len(data)
    if s["received"] > s["total"] + 64 * 1024 * 1024:
        return JSONResponse(status_code=400, content={"ok": False, "message": "超出声明大小"})
    return {"ok": True, "received": s["received"], "total": s["total"]}


@APP.post("/characters/import-finish")
async def import_finish(request: Request, session: str = ""):
    s = _IMPORT_SESSIONS.pop(session, None)
    if not s:
        return JSONResponse(status_code=400, content={"ok": False, "message": "上传会话不存在"})
    if s["received"] < s["total"]:
        return JSONResponse(status_code=400, content={"ok": False, "message": "分片不完整(%d/%d), 请重试" % (s["received"], s["total"])})
    try:
        with open(s["path"], "rb") as f:
            data = f.read()
    except Exception as e:
        return JSONResponse(status_code=400, content={"ok": False, "message": "读取临时文件失败: %s" % e})
    finally:
        try:
            os.remove(s["path"])
        except Exception:
            pass
    # 按目标分发: 参考音频 → 落盘 imports/; 角色包 → zip 导入
    if s.get("target") == "/ref-import":
        ref_rel, fname, err = _import_ref_audio(data, s.get("ctype") or "application/octet-stream")
        if err:
            return JSONResponse(status_code=400, content={"ok": False, "message": err})
        return {"ok": True, "name": fname, "ref_audio_path": ref_rel, "message": "参考音频导入成功"}
    name, err = _import_char_zip(data)
    if err:
        return JSONResponse(status_code=400, content={"ok": False, "message": err})
    return {"ok": True, "name": name, "message": "角色包导入成功"}


@APP.post("/characters/import-abort")
async def import_abort(request: Request, session: str = ""):
    s = _IMPORT_SESSIONS.pop(session, None)
    if s:
        try:
            os.remove(s["path"])
        except Exception:
            pass
    return {"ok": True}


@APP.post("/characters/duplicate")
async def characters_duplicate(request: Request):
    """复制现有角色为新角色(含权重/音频/语气槽), 并切换激活."""
    body = await request.json()
    name = str(body.get("name", "")).strip()
    new_name = str(body.get("new_name", "")).strip()
    if not name or not new_name:
        return JSONResponse(status_code=400, content={"ok": False, "message": "name 与 new_name 必填"})
    src = os.path.join(_CHARS_ROOT, name)
    dst = os.path.join(_CHARS_ROOT, new_name)
    if not os.path.isdir(src):
        return JSONResponse(status_code=400, content={"ok": False, "message": "角色 %s 不存在" % name})
    if os.path.isdir(dst):
        return JSONResponse(status_code=400, content={"ok": False, "message": "角色 %s 已存在" % new_name})
    try:
        _copytree(src, dst)
        cfg = read_char_yaml(new_name)
        if cfg:
            cfg["name"] = new_name
            save_char_yaml(new_name, cfg)
    except Exception as e:
        shutil_rm(dst)
        return JSONResponse(status_code=400, content={"ok": False, "message": "复制失败: %s" % e})
    err = activate_character(new_name)
    if err:
        return JSONResponse(status_code=400, content={"ok": False, "message": "已复制但切换失败: %s" % err})
    return {"ok": True, "name": new_name}


@APP.get("/characters/export")
async def characters_export(name: str = None):
    """导出角色为 .char(zip) 下载."""
    import io
    import zipfile as _zipfile
    if not name:
        return JSONResponse(status_code=400, content={"ok": False, "message": "name is required"})
    d = os.path.join(_CHARS_ROOT, os.path.basename(name))
    if not os.path.isdir(d):
        return JSONResponse(status_code=400, content={"ok": False, "message": "角色 %s 不存在" % name})
    buf = io.BytesIO()
    with _zipfile.ZipFile(buf, "w", _zipfile.ZIP_STORED) as zf:
        for root, _dirs, files in os.walk(d):
            for fn in files:
                fp = os.path.join(root, fn)
                rel = os.path.relpath(fp, d).replace("\\", "/")
                zf.write(fp, "data/" + rel)
    buf.seek(0)
    fname = "%s.char" % name
    from urllib.parse import quote
    return StreamingResponse(
        buf, media_type="application/zip",
        headers={"Content-Disposition": "attachment; filename=character.char; filename*=UTF-8''%s" % quote(fname)},
    )


@APP.post("/characters/delete")
async def characters_delete(request: Request):
    """删除角色(含目录/权重/音频). 删除激活角色时清空激活状态."""
    global CHAR_CONFIG
    body = await request.json()
    name = str(body.get("name", "")).strip()
    if not name:
        return JSONResponse(status_code=400, content={"ok": False, "message": "name is required"})
    d = os.path.join(_CHARS_ROOT, os.path.basename(name))
    if not os.path.isdir(d):
        return JSONResponse(status_code=400, content={"ok": False, "message": "角色 %s 不存在" % name})
    shutil_rm(d)
    if CHAR_CONFIG and CHAR_CONFIG.get("name") == name:
        CHAR_CONFIG = None
    return {"ok": True, "name": name}


def shutil_rm(path):
    import shutil as _sh
    try:
        if os.path.isdir(path):
            _sh.rmtree(path, ignore_errors=True)
        elif os.path.exists(path):
            os.remove(path)
    except Exception as e:
        print("清理失败 %s: %s" % (path, e))


def _copytree(src, dst):
    import shutil as _sh
    _sh.copytree(src, dst, dirs_exist_ok=True)


def _import_ref_audio(data: bytes, ctype: str, role: str = None, slot: str = None):
    """共用: 参考音频落盘; 返回 (ref_rel, fname, err)。"""
    ext_map = {
        "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav",
        "audio/mpeg": "mp3", "audio/mp3": "mp3",
        "audio/flac": "flac", "audio/x-flac": "flac",
        "audio/ogg": "ogg", "audio/opus": "ogg",
        "audio/aac": "aac", "audio/x-aac": "aac",
        "audio/mp4": "m4a", "audio/x-m4a": "m4a",
        "audio/webm": "webm",
    }
    ext = ext_map.get(ctype.split(";")[0].strip().lower(), "")
    if not ext:
        return None, None, "不支持的音频格式: %s" % ctype
    ts = time.strftime("%Y%m%d_%H%M%S")
    try:
        if role:
            role = os.path.basename(str(role))
            d = os.path.join(_CHARS_ROOT, role)
            if not os.path.isdir(d):
                return None, None, "角色 %s 不存在" % role
            speech_dir = os.path.join(d, "speech")
            os.makedirs(speech_dir, exist_ok=True)
            fname = "%s_%s.%s" % (slot if slot in EMOTION_SLOT_KEYS else "ref", ts, ext)
            path = os.path.join(speech_dir, fname)
            ref_rel = "speech/" + fname
        else:
            imports_dir = os.path.join(os.getcwd(), "fvtt_chars", "imports")
            os.makedirs(imports_dir, exist_ok=True)
            fname = "ref_%s.%s" % (ts, ext)
            path = os.path.join(imports_dir, fname)
            ref_rel = "fvtt_chars/imports/" + fname
        with open(path, "wb") as f:
            f.write(data)
        if role and slot and slot in EMOTION_SLOT_KEYS:
            cfg = read_char_yaml(role)
            if cfg:
                raw = cfg.get("emotions")
                by_key = raw if isinstance(raw, dict) else {}
                entry = by_key.get(slot) or {}
                entry["ref"] = ref_rel
                if "prompt" not in entry:
                    entry["prompt"] = ""
                if "lang" not in entry:
                    entry["lang"] = ""
                by_key[slot] = entry
                cfg["emotions"] = by_key
                save_char_yaml(role, cfg)
    except Exception as e:
        return None, None, "保存失败: %s" % e
    return ref_rel, fname, None


@APP.post("/ref-import")
async def ref_import(request: Request, role: str = None, slot: str = None):
    """导入参考音频(原始字节, 单次; 大音频客户端走分片 → import-finish 分发到此落盘逻辑).

    role+slot 提供: 落盘到角色 speech/ 目录并自动绑定到该语气槽(返回角色目录内相对路径);
    否则: 存到通用 fvtt_chars/imports/.
    """
    data = await request.body()
    if not data:
        return JSONResponse(status_code=400, content={"ok": False, "message": "empty body"})
    if data.strip() in (b"null", b"", b"{}"):
        return JSONResponse(status_code=400, content={"ok": False, "message": "未收到文件内容(音频读取失败), 请重新选择"})
    ctype = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
    if len(data) > 200 * 1024 * 1024:
        return JSONResponse(status_code=400, content={"ok": False, "message": "音频文件过大(>200MB)"})
    ref_rel, fname, err = _import_ref_audio(data, ctype, role, slot)
    if err:
        return JSONResponse(status_code=400, content={"ok": False, "message": err})
    return {"ok": True, "name": fname, "ref_audio_path": ref_rel, "size": len(data), "content_type": ctype, "role": role, "slot": slot}


# ---------------- FVTT 扩展: 本地听写 (/asr) ----------------
# 后端: funasr(中文, 模型随 GPT-SoVITS 自带, 离线) / faster-whisper(中英日韩粤, 首次需联网下载一次模型)
_ASR_ENGINE = None
_ASR_MODEL = None


def _pick_asr_engine(lang: str):
    """按语言选择听写引擎. 中文优先 funasr(离线模型已存在), 其他用 faster-whisper."""
    global _ASR_ENGINE, _ASR_MODEL
    is_zh = str(lang).lower().startswith("zh")
    if args.asr_engine == "auto" or (args.asr_engine == "funasr" and is_zh) or (args.asr_engine == "whisper" and not is_zh):
        if args.asr_engine != "auto" and args.asr_engine == "funasr" and not is_zh:
            return None  # 明确指定 funasr 时只处理中文
        if args.asr_engine != "auto" and args.asr_engine == "whisper" and is_zh:
            pass  # 明确指定 whisper 也用于中文
    if is_zh and args.asr_engine in ("auto", "funasr"):
        if _ASR_ENGINE != "funasr":
            try:
                from funasr import AutoModel
                base = os.path.join(os.getcwd(), "tools", "asr", "models")
                model_dir = None
                vad_dir = None
                punc_dir = None
                for d in sorted(os.listdir(base)):
                    if d.startswith("speech_paraformer-large_asr_nat-zh"):
                        model_dir = os.path.join(base, d)
                    elif d.startswith("speech_fsmn_vad_zh"):
                        vad_dir = os.path.join(base, d)
                    elif d.startswith("punc_ct-transformer_zh"):
                        punc_dir = os.path.join(base, d)
                if not model_dir:
                    raise FileNotFoundError("funasr 中文模型不存在: tools/asr/models/speech_paraformer-large...")
                device = "cuda" if (args.asr_device == "auto" and _torch.cuda.is_available()) or args.asr_device == "cuda" else "cpu"
                _ASR_MODEL = AutoModel(
                    model=model_dir,
                    vad_model=vad_dir,
                    punc_model=punc_dir,
                    device=device,
                    disable_update=True,
                    disable_pbar=True,
                )
                _ASR_ENGINE = "funasr"
                print("ASR engine: funasr (device=%s)" % device)
            except Exception as e:
                print("funasr 初始化失败: %s" % e)
                _ASR_ENGINE = "failed-funasr"
        return _ASR_ENGINE if _ASR_ENGINE == "funasr" else None

    if args.asr_engine in ("auto", "whisper"):
        if _ASR_ENGINE != "whisper":
            try:
                from faster_whisper import WhisperModel
                # whisper 首次使用需从 HuggingFace 下载模型, 这里放行联网
                os.environ.pop("HF_HUB_OFFLINE", None)
                os.environ.pop("TRANSFORMERS_OFFLINE", None)
                use_cuda = _torch.cuda.is_available() and args.asr_device != "cpu"
                device = "cuda" if use_cuda else "cpu"
                compute = "float16" if use_cuda else "int8"
                _ASR_MODEL = WhisperModel(
                    args.asr_whisper_size,
                    device=device,
                    compute_type=compute,
                    download_root=args.asr_whisper_dir,
                )
                _ASR_ENGINE = "whisper"
                print("ASR engine: faster-whisper (%s, %s, %s)" % (args.asr_whisper_size, device, compute))
            except Exception as e:
                print("faster-whisper 初始化失败: %s" % e)
                _ASR_ENGINE = "failed-whisper"
        return _ASR_ENGINE if _ASR_ENGINE == "whisper" else None
    return None


def _convert_to_wav_16k(src_path, dst_path):
    """用随附 ffmpeg 把任意音频转成 16k 单声道 wav, 供听写模型使用."""
    ffmpeg = os.path.join(os.getcwd(), "runtime", "ffmpeg.exe")
    if not os.path.isfile(ffmpeg):
        ffmpeg = "ffmpeg"
    subprocess.run(
        [ffmpeg, "-y", "-i", src_path, "-ar", "16000", "-ac", "1", dst_path],
        check=True, capture_output=True,
    )


@APP.post("/asr")
async def asr_endpoint(request: Request):
    """听写: POST 原始音频字节(webm/ogg/wav 均可); query: lang=zh|ja|en|auto"""
    lang = str(request.query_params.get("lang", "auto")).lower()
    if args.asr_engine == "off":
        return JSONResponse(status_code=400, content={"message": "asr is disabled on this server"})
    try:
        data = await request.body()
        if not data:
            return JSONResponse(status_code=400, content={"message": "no audio data"})
        workdir = os.environ.get("FVTT_ASR_WORKDIR") or os.path.join(os.getcwd(), "output", "fvtt_asr")
        os.makedirs(workdir, exist_ok=True)
        src = os.path.join(workdir, "in.bin")
        wav = os.path.join(workdir, "in.wav")
        with open(src, "wb") as f:
            f.write(data)
        _convert_to_wav_16k(src, wav)

        wlang = "zh" if lang in ("auto", "zh") or lang.startswith("zh") else ("ja" if lang.startswith("ja") else ("en" if lang.startswith("en") else "zh"))
        engine = _pick_asr_engine(wlang)
        text = ""
        if engine == "funasr":
            result = _ASR_MODEL.generate(input=wav, language="zh", batch_size_s=60)
            if result:
                text = result[0].get("text", "") or ""
        elif engine == "whisper":
            wl = "zh" if wlang == "zh" else ("ja" if wlang == "ja" else ("en" if wlang == "en" else None))
            segments, _info = _ASR_MODEL.transcribe(wav, language=wl, vad_filter=False)
            text = "".join(s.text for s in segments).strip()
        else:
            return JSONResponse(status_code=500, content={"message": "no asr engine available (funasr/whisper), check server log"})
        return {"ok": True, "text": text, "lang": wlang, "engine": engine}
    except Exception as e:
        traceback.print_exc()
        return JSONResponse(status_code=500, content={"message": "asr failed", "Exception": str(e)})


# ============ 语音样本库(供"直接选择语气样本"使用) ============
def _speech_library(role):
    """角色目录内所有 wav/mp3 等参考样本 + 转写台词(speech_library.json)."""
    d = os.path.join(_CHARS_ROOT, role)
    if not os.path.isdir(d):
        return None
    lib = []
    texts = {}
    lib_path = os.path.join(d, "speech_library.json")
    if os.path.isfile(lib_path):
        try:
            for it in json.load(open(lib_path, encoding="utf-8")):
                texts[it.get("file", "")] = (it.get("text", "") or "", it.get("lang", "") or "")
        except Exception:
            pass
    for base, _dirs, files in os.walk(os.path.join(d, "speech")):
        for fn in sorted(files):
            if fn.lower().endswith((".wav", ".mp3", ".flac", ".ogg", ".aac", ".m4a", ".webm")):
                rel = os.path.relpath(os.path.join(base, fn), d).replace("\\", "/")
                t, lg = texts.get(fn, ("", ""))
                lib.append({"file": rel, "size": os.path.getsize(os.path.join(base, fn)), "text": t, "lang": lg})
    return lib


@APP.get("/samples")
async def samples(role: str = None):
    """语音样本库: ?role=<角色名> 返回该角色全部参考音频与台词."""
    role = os.path.basename(str(role or ""))
    if not role:
        return JSONResponse(status_code=400, content={"ok": False, "message": "需要 role 参数"})
    lib = _speech_library(role)
    if lib is None:
        return JSONResponse(status_code=404, content={"ok": False, "message": "角色 %s 不存在" % role})
    return {"ok": True, "role": role, "samples": lib}


@APP.get("/samples/audio")
async def samples_audio(role: str = None, file: str = None):
    """试听样本: /samples/audio?role=<角色>&file=<speech/...>"""
    role = os.path.basename(str(role or ""))
    file = str(file or "")
    d = os.path.join(_CHARS_ROOT, role)
    if not os.path.isdir(d) or not file:
        return JSONResponse(status_code=404, content={"ok": False, "message": "not found"})
    full = os.path.normpath(os.path.join(d, file))
    if not full.startswith(os.path.normpath(d)) or not file.lower().endswith((".wav", ".mp3", ".flac", ".ogg", ".aac", ".m4a", ".webm")):
        return JSONResponse(status_code=403, content={"ok": False, "message": "forbidden"})
    if not os.path.isfile(full):
        return JSONResponse(status_code=404, content={"ok": False, "message": "file missing"})
    ctype = "audio/wav"
    if file.lower().endswith(".mp3"): ctype = "audio/mpeg"
    elif file.lower().endswith(".flac"): ctype = "audio/flac"
    elif file.lower().endswith(".ogg"): ctype = "audio/ogg"
    elif file.lower().endswith(".aac"): ctype = "audio/aac"
    elif file.lower().endswith(".m4a"): ctype = "audio/mp4"
    elif file.lower().endswith(".webm"): ctype = "audio/webm"
    return FileResponse(full, media_type=ctype)


@APP.post("/characters/bind-slot")
async def bind_slot(request: Request):
    """把样本库某段音频绑定到角色的语气槽: {name, key, file(speech/...), prompt?, lang?}"""
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"ok": False, "message": "json body required"})
    role = os.path.basename(str(body.get("name", "") or ""))
    key = str(body.get("key", "") or "").strip()[:100]
    file = str(body.get("file", "") or "")
    if not key or "/" in key or "\\" in key or key in (".", ".."):
        return JSONResponse(status_code=400, content={"ok": False, "message": "无效的语气 key: %s" % key})
    d = os.path.join(_CHARS_ROOT, role)
    if not os.path.isdir(d):
        return JSONResponse(status_code=400, content={"ok": False, "message": "角色 %s 不存在" % role})
    if file:
        # 绑定音频: 必须存在且合法; 只存头像(avatar)时 file 可空
        full = os.path.normpath(os.path.join(d, file))
        if not full.startswith(os.path.normpath(d)) or not file.lower().endswith((".wav", ".mp3", ".flac", ".ogg", ".aac", ".m4a", ".webm")):
            return JSONResponse(status_code=400, content={"ok": False, "message": "无效的样本路径: %s" % file})
        if not os.path.isfile(full):
            return JSONResponse(status_code=400, content={"ok": False, "message": "样本文件不存在: %s" % file})
    cfg = read_char_yaml(role)
    if not cfg:
        return JSONResponse(status_code=400, content={"ok": False, "message": "读取角色配置失败"})
    by_key = cfg.get("emotions") if isinstance(cfg.get("emotions"), dict) else {}
    entry = dict(by_key.get(key) or {})
    if file:
        entry["ref"] = file
    if body.get("label") is not None:
        entry["label"] = str(body.get("label") or "")   # 自定义槽显示名(默认 key 无 label 时回退默认中文)
    if body.get("prompt") is not None:
        entry["prompt"] = str(body.get("prompt") or "")
    if body.get("lang") is not None:
        entry["lang"] = str(body.get("lang") or "")
    if body.get("avatar") is not None:
        entry["avatar"] = str(body.get("avatar") or "")
    by_key[key] = entry
    cfg["emotions"] = by_key
    save_char_yaml(role, cfg)
    return {"ok": True, "name": role, "key": key, "ref_audio_path": file, "avatar": entry.get("avatar", "")}


# ---------------- LLM 代理: 可选 AI 语气判断(OpenAI 兼容 API; 未配置不影响模块) ----------------
@APP.post("/llm")
async def llm_endpoint(request: Request):
    """{base?, key, model?, text, emotions:[{key,label}]} → {ok, emotion, raw?}"""
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"ok": False, "message": "json body required"})
    base = str(body.get("base") or "").strip() or "https://api.openai.com/v1"
    key = str(body.get("key") or "").strip()
    model = str(body.get("model") or "").strip() or "gpt-4o-mini"
    text = str(body.get("text") or "")[:2000]
    context = str(body.get("context") or "").strip()[:2000]
    emotions = body.get("emotions") or []
    if not key:
        return JSONResponse(status_code=400, content={"ok": False, "message": "api key 未配置, 请在模块设置里填写后使用"})
    if not text:
        return JSONResponse(status_code=400, content={"ok": False, "message": "text required"})
    emo_map = {str(e.get("key", "")): str(e.get("label", e.get("key", ""))) for e in emotions if isinstance(e, dict)}
    if not emo_map:
        emo_map = {"calm": "平静", "happy": "开心", "relaxed": "放松", "angry": "生气", "sad": "悲伤",
                   "surprised": "惊讶", "shy": "害羞", "serious": "严肃", "gentle": "温柔", "sleepy": "困倦"}
    option_lines = "\n".join("- %s (%s)" % (k, v) for k, v in emo_map.items())
    sys_prompt = (
        "你是语气分析助手。根据说话内容(及其所在对话上下文)判断说话者的语气, 从下面选项里选最贴切的一个。"
        "只输出那个选项的英文 key 本身, 不要任何其他字符。判断时优先依据台词本身, 上下文只作辅助理解语境。\n选项:\n%s" % option_lines
    )
    user_content = text[:1500]
    if context:
        user_content = "最近对话上下文:\n%s\n\n---\n需要判断语气的台词: %s" % (context, text[:1500])
    url = base.rstrip("/") + "/chat/completions"
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": sys_prompt},
            {"role": "user", "content": user_content},
        ],
        "temperature": 0.2,
        "max_tokens": 512,   # 推理模型(如 deepseek-v4-flash)会先输出大量推理 token, 太小会把正式答案截断成空
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": "Bearer %s" % key},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        return JSONResponse(status_code=200, content={"ok": False, "message": "LLM 请求失败(无AI语气, 语音不受影响): %s" % e})
    try:
        msg = (data.get("choices") or [{}])[0].get("message", {}) or {}
        content = str(msg.get("content") or "").strip()
        if not content:
            # 推理模型兜底: 从推理文字中提取情绪 key(如 "所以是happy")
            content = str(msg.get("reasoning_content") or "")
    except Exception:
        content = ""
    emo = str(content).strip().lower()
    if emo not in emo_map:
        # 容错: 匹配包含关系(如输出 "happy 开心" 提取 key)
        for k in emo_map:
            if k in emo:
                emo = k
                break
        else:
            emo = ""
    return {"ok": True, "emotion": emo, "raw": str(content).strip()[:80]}


@APP.post("/llm/models")
async def llm_models_endpoint(request: Request):
    """{base?, key} → {ok, models:[...]} 获取 OpenAI 兼容服务的可用模型列表"""
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"ok": False, "message": "json body required"})
    base = str(body.get("base") or "").strip() or "https://api.openai.com/v1"
    key = str(body.get("key") or "").strip()
    if not key:
        return JSONResponse(status_code=400, content={"ok": False, "message": "api key 未配置, 请在模块设置里填写后使用"})
    url = base.rstrip("/") + "/models"
    req = urllib.request.Request(url, headers={"Authorization": "Bearer %s" % key}, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        return JSONResponse(status_code=200, content={"ok": False, "message": "获取模型列表失败: %s" % e})
    models = []
    for m in data.get("data") or []:
        mid = str(m.get("id") or "").strip()
        if mid and mid not in models:
            models.append(mid)
    if not models:
        return JSONResponse(status_code=200, content={"ok": False, "message": "该服务未返回可用模型列表"})
    return {"ok": True, "models": models}


@APP.post("/llm/polish")
async def llm_polish_endpoint(request: Request):
    """{base?, key, model?, text, emotion, emotion_label?} → {ok, text}
    台词润色: 保持原意, 按情绪微调表达(语气词/口语化), 复刻成品软件"语气更多样"."""
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"ok": False, "message": "json body required"})
    base = str(body.get("base") or "").strip() or "https://api.openai.com/v1"
    key = str(body.get("key") or "").strip()
    model = str(body.get("model") or "").strip() or "gpt-4o-mini"
    text = str(body.get("text") or "").strip()[:2000]
    context = str(body.get("context") or "").strip()[:2000]
    emotion = str(body.get("emotion") or "").strip()
    emotion_label = str(body.get("emotion_label") or emotion or "").strip()
    if not key:
        return JSONResponse(status_code=400, content={"ok": False, "message": "api key 未配置, 请在模块设置里填写后使用"})
    if not text:
        return JSONResponse(status_code=400, content={"ok": False, "message": "text required"})
    sys_prompt = (
        "你是台词润色助手。用户给你一句台词, 你需要把它润色成更能表达[%s]情绪的版本。"
        "要求: 1) 保持原意和人物说话习惯, 不改变事实内容; "
        "2) 通过添加语气词、口语化表达、停顿或感叹, 让语气更自然、更有情绪表现力; "
        "3) 不添加原文没有的新内容/新信息, 不要解释, 不要加引号; "
        "4) 只输出润色后的台词本身(一句或几句话), 简体中文优先。" % (emotion_label or "自然")
    )
    user_content = text[:1200]
    if context:
        user_content = "最近对话上下文:\n%s\n\n---\n需要润色的台词: %s" % (context, text[:1200])
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": sys_prompt},
            {"role": "user", "content": user_content},
        ],
        "temperature": 0.7,
        "max_tokens": 512,
    }
    url = base.rstrip("/") + "/chat/completions"
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": "Bearer %s" % key},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        return JSONResponse(status_code=200, content={"ok": False, "message": "LLM 请求失败(无AI语气, 语音不受影响): %s" % e})
    try:
        msg = (data.get("choices") or [{}])[0].get("message", {}) or {}
        content = str(msg.get("content") or "").strip()
        if not content:
            content = str(msg.get("reasoning_content") or "")
    except Exception:
        content = ""
    if not content:
        return JSONResponse(status_code=200, content={"ok": False, "message": "润色结果为空"})
    return {"ok": True, "text": content[:2000]}


@APP.post("/diag")
async def diag_endpoint(request: Request):
    """{text?, src?, messageId?, ts?} → 客户端播放诊断落盘(排查"播放固定同一段")"""
    try:
        body = await request.json()
    except Exception:
        body = {}
    try:
        with open(os.path.join(os.path.dirname(__file__), "tts-requests.log"), "a", encoding="utf-8") as _lf:
            _lf.write("[%s] [play] src=%s mid=%s text=%r\n" % (
                time.strftime("%H:%M:%S"), str(body.get("src") or "")[:20], str(body.get("messageId") or "")[:16], str(body.get("text") or "")[:60]))
    except Exception:
        pass
    return {"ok": True}


@APP.post("/selftest")
async def selftest_endpoint(request: Request):
    """内置自检(诊断用): 聚合服务端状态 + 客户端上报 → 写 selftest_report.json
    客户端一键"自检"按钮会调用本端点; 报告文件供作者直接读取排查(不用来回截图/口述)."""
    client_payload = {}
    try:
        body = await request.json()
        if isinstance(body, dict):
            client_payload = body
    except Exception:
        pass
    st = {}
    try:
        hw = HW_INFO
        st["hardware"] = {
            "gpu_name": hw.get("gpu_name", ""),
            "gpu_mem_total_gb": hw.get("gpu_mem_total_gb"),
            "gpu_mem_free_gb": hw.get("gpu_mem_free_gb"),
            "device": str(hw.get("device", "")),
            "is_half": bool(getattr(tts_config, "is_half", False)),   # 与 /status 同一来源(错误读 HW_INFO.is_half 键不存在显示 false)
        }
    except Exception:
        st["hardware"] = {"err": "HW_INFO 不可用"}
    chars_out = []
    try:
        for ch in list_installed_chars():
            cfg = read_char_yaml(ch["name"])
            if not cfg:
                continue
            emos = emotion_slot_state(cfg) or []
            chars_out.append({
                "name": ch["name"],
                "avatar": str(cfg.get("avatar", "") or ""),
                "emotions": len(emos),
                "emo_with_avatar": sum(1 for e in emos if e.get("avatar")),
            })
    except Exception as e:
        chars_out = [{"err": str(e)}]
    st["characters"] = {
        "active": (CHAR_CONFIG.get("name") if isinstance(CHAR_CONFIG, dict) else None),
        "list": chars_out,
    }
    try:
        ad = _AUDIO_CACHE   # 与服务端实际缓存目录一致(os.getcwd()/audio_cache)
        st["audio_cache"] = {"dir": ad, "files": len(os.listdir(ad)) if os.path.isdir(ad) else -1}
    except Exception:
        st["audio_cache"] = {}
    try:
        du = shutil.disk_usage(os.getcwd())
        st["disk"] = {"free_gb": round(du.free / 1e9, 2)}
    except Exception:
        st["disk"] = {}
    st["server"] = {"pid": os.getpid(), "cwd": os.getcwd(), "python": sys.executable}
    try:
        _lf = os.path.join(os.path.dirname(__file__), "tts-requests.log")
        if os.path.isfile(_lf):
            with open(_lf, "r", encoding="utf-8", errors="replace") as f:
                st["recent_logs"] = f.readlines()[-15:]
    except Exception:
        st["recent_logs"] = []
    report = {
        "time": time.strftime("%Y-%m-%d %H:%M:%S"),
        "server": st,
        "client": client_payload,
    }
    # 高压测试单独落盘, 避免被低压自检覆盖(两份报告并存, 作者都读)
    if isinstance(client_payload, dict) and client_payload.get("mode") == "stress":
        out = os.path.join(os.path.dirname(__file__), "selftest_stress.json")
    else:
        out = os.path.join(os.path.dirname(__file__), "selftest_report.json")
    try:
        with open(out, "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
        return {"ok": True, "file": out}
    except Exception as e:
        return JSONResponse(status_code=500, content={"ok": False, "message": str(e)})


# ============ 传输测试: 服务端作中介确认"广播真实到达其他页面(pl)" — 不依赖 pl→GM 的 socket 回程 ============
_TRANSFERS = {}
_TRANSFER_LOCK = threading.Lock()


@APP.post("/selftest/transfer-start")
async def selftest_transfer_start(request: Request):
    """{id} → 开一个传输记录槽(pl 端收到广播后 HTTP 回写到达)"""
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"ok": False, "message": "json required"})
    tid = str(body.get("id") or "").strip()
    if not tid:
        return JSONResponse(status_code=400, content={"ok": False, "message": "id required"})
    with _TRANSFER_LOCK:
        _TRANSFERS[tid] = {"arrivals": [], "ts": time.time()}
        while len(_TRANSFERS) > 20:
            _TRANSFERS.pop(next(iter(_TRANSFERS)))
    return {"ok": True, "id": tid}


@APP.post("/selftest/transfer-arrive")
async def selftest_transfer_arrive(request: Request):
    """{id, from} → pl 端收到 selftest-transfer 广播后回写: 证明该页面确实收到了广播"""
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"ok": False, "message": "json required"})
    tid = str(body.get("id") or "").strip()
    fr = str(body.get("from") or "").strip()[:30]
    if not tid:
        return JSONResponse(status_code=400, content={"ok": False, "message": "id required"})
    with _TRANSFER_LOCK:
        st = _TRANSFERS.get(tid)
        if st is not None:
            if fr and fr not in st["arrivals"]:
                st["arrivals"].append(fr)
            return {"ok": True, "arrivals": st["arrivals"]}
    return JSONResponse(status_code=404, content={"ok": False, "message": "transfer id 不存在或已过期"})


@APP.get("/selftest/transfer-result")
async def selftest_transfer_result(request: Request):
    """?id= → 查询该次传输的到达名单"""
    tid = str(request.query_params.get("id") or "").strip()
    with _TRANSFER_LOCK:
        st = _TRANSFERS.get(tid)
        if st is not None:
            return {"ok": True, "id": tid, "arrivals": st["arrivals"], "age_s": int(time.time() - st.get("ts", 0))}
    return JSONResponse(status_code=404, content={"ok": False, "message": "transfer id 不存在或已过期"})


# ---------------- 批量速度测试报告(GM/pl 各自落盘, 分批合成/传输/加载/显卡满载数据) ----------------
@APP.post("/speedtest/report")
async def speedtest_report(request: Request):
    """各方把测试结果分段写入 speed_report*.json(按 user 分文件, 作者读取汇总)."""
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"ok": False, "message": "bad json"})
    who = str(body.get("user") or "unknown")[:24].replace("\\", "_").replace("/", "_")
    kind = str(body.get("kind") or "")
    # 🔊 玩家自测结果用独立文件落盘(player_selftest_<user>.json), 绝不覆盖速度报告的 speed_report_*.json
    if kind == "playerSelfTest":
        _f = os.path.join(os.path.dirname(__file__), "player_selftest_%s.json" % who)
    else:
        _f = os.path.join(os.path.dirname(__file__), "speed_report.json" if who == "gm" else "speed_report_%s.json" % who)
    try:
        with open(_f, "w", encoding="utf-8") as f:
            json.dump(body, f, ensure_ascii=False, indent=2)
        return {"ok": True, "file": os.path.basename(_f), "bytes": os.path.getsize(_f)}
    except Exception as e:
        return JSONResponse(status_code=500, content={"ok": False, "message": str(e)})


@APP.get("/speedtest/gpu")
async def speedtest_gpu():
    """nvidia-smi 实时 GPU 利用率/显存(测显卡满载用; 无 nvidia-smi 返回 util=None)."""
    try:
        _r = subprocess.run(
            ["nvidia-smi", "--query-gpu=utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=8)
        _line = (_r.stdout or "").strip().splitlines()
        if _line:
            _p = _line[0].split(",")
            if len(_p) >= 3:
                return {"ok": True, "util": float(_p[0].strip()), "mem_used_gb": float(_p[1].strip()) / 1024.0, "mem_total_gb": float(_p[2].strip()) / 1024.0}
    except Exception:
        pass
    return {"ok": True, "util": None}


@APP.post("/llm/pick-role")
async def llm_pick_role_endpoint(request: Request):
    """{base?, key, model?, text, roles: [名字]} → {ok, role}
    无指定角色时, 让 LLM 从角色列表里选出最像这段台词说话者的角色(仅用于聊天立绘展示, 不改朗读音色)."""
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"ok": False, "message": "json body required"})
    base = str(body.get("base") or "").strip() or "https://api.openai.com/v1"
    key = str(body.get("key") or "").strip()
    model = str(body.get("model") or "").strip() or "gpt-4o-mini"
    text = str(body.get("text") or "")[:800]
    roles = body.get("roles") or []
    roles = [str(r).strip() for r in roles if str(r).strip()][:20]
    if not key:
        return JSONResponse(status_code=400, content={"ok": False, "message": "api key 未配置"})
    if not roles:
        return {"ok": False, "role": ""}
    sys_prompt = (
        "你是跑团主持人。给你一段聊天台词和可选角色名列表，判断这段台词最可能是由哪个角色说出的，"
        "只看说话人身份（语气/内容/自称/语境），不修改选角。只输出角色名本身，不要任何解释、标点或格式。"
    )
    user_content = "可选角色: %s\n台词: %s" % ("、".join(roles), text or "（只有动作或空白）")
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": sys_prompt},
            {"role": "user", "content": user_content},
        ],
        "temperature": 0.2,
        "max_tokens": 40,
    }
    url = base.rstrip("/") + "/chat/completions"
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": "Bearer %s" % key},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        return JSONResponse(status_code=200, content={"ok": False, "message": "LLM 请求失败(无AI语气, 语音不受影响): %s" % e})
    content = ""
    try:
        msg = (data.get("choices") or [{}])[0].get("message", {}) or {}
        content = str(msg.get("content") or "").strip()
    except Exception:
        content = ""
    # 模糊匹配: LLM 输出需落到可选名单里(允许带引号/多余空白)
    best = ""
    for rn in roles:
        if rn and (content == rn or rn in content or content in rn):
            best = rn
            break
    return {"ok": bool(best), "role": best}


@APP.post("/llm/style")
async def llm_style_endpoint(request: Request):
    """{base?, key, model?, text, style, role?, setting?, emotions?} → {ok, speed_factor, split?}
    朗读风格提示词 → 合成参数: 把"更严肃认真、中间不要中断"这类自然语言翻译成 GPT-SoVITS 合成参数.
    split 取值: cut0(整段一次合成最连贯, 长文本慎用) / cut5 / cut2 / cut1 等; speed_factor: 0.7~1.5"""
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"ok": False, "message": "json body required"})
    base = str(body.get("base") or "").strip() or "https://api.openai.com/v1"
    key = str(body.get("key") or "").strip()
    model = str(body.get("model") or "").strip() or "gpt-4o-mini"
    text = str(body.get("text") or "")[:2000]
    style = str(body.get("style") or "").strip()[:300]
    if not key:
        return JSONResponse(status_code=400, content={"ok": False, "message": "api key 未配置"})
    if not style:
        return {"ok": True, "speed_factor": 1.0, "split": None}
    role_name = str(body.get("role") or "").strip()[:40]
    setting = str(body.get("setting") or "").strip()[:600]
    sys_prompt = (
        "你是语音合成参数设计助手。根据用户对朗读风格的描述，把需求翻译成 GPT-SoVITS 的合成参数。\n"
        "要点：\n"
        "1) speed_factor: 朗读语速倍率，范围 0.7~1.5（严肃/庄重/沉重→偏慢如0.9；急促/激动→偏快如1.15；正常→1.0）；\n"
        "2) split: 文本切分方式——\"cut0\"=整段一次合成最连贯(仅文本较短<60字时可用)；\"cut2\"=每2句切一次(中等停顿)；\"cut5\"=每5句切(默认)；\"cut1\"=每句切(句间停顿明显)；\n"
        "3) 根据\"中间不要中断/连贯/一气呵成\"这类要求选更连贯的切分；根据\"停顿/断句清楚\"选更碎的切分；\n"
        "4) 只输出一个 JSON 对象: {\"speed_factor\": 1.0, \"split\": \"cut5\"}，不要任何解释、不要 markdown。"
    )
    role_lines = ""
    if role_name or setting:
        role_lines = "角色: %s\n角色设定: %s\n" % (role_name or "未知", setting or "无")
    user_content = "台词: %s\n%s朗读风格要求: %s" % (text[:600], role_lines, style)
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": sys_prompt},
            {"role": "user", "content": user_content},
        ],
        "temperature": 0.2,
        "max_tokens": 256,
    }
    url = base.rstrip("/") + "/chat/completions"
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": "Bearer %s" % key},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        return JSONResponse(status_code=200, content={"ok": False, "message": "LLM 请求失败(无AI语气, 语音不受影响): %s" % e})
    content = ""
    try:
        msg = (data.get("choices") or [{}])[0].get("message", {}) or {}
        content = str(msg.get("content") or "").strip()
        if not content:
            content = str(msg.get("reasoning_content") or "")
    except Exception:
        content = ""
    content = re.sub(r"^```(?:json)?\s*", "", content, flags=re.IGNORECASE)
    content = re.sub(r"\s*```$", "", content, flags=re.IGNORECASE)
    speed = 1.0
    split = None
    m = re.search(r"\{.*\}", content, re.DOTALL)
    if m:
        try:
            parsed = json.loads(m.group(0))
            if isinstance(parsed, dict):
                try:
                    speed = float(parsed.get("speed_factor") or 1.0)
                except (TypeError, ValueError):
                    speed = 1.0
                split = str(parsed.get("split") or "").strip() or None
        except Exception:
            pass
    speed = max(0.7, min(1.5, speed))
    if split not in ("cut0", "cut1", "cut2", "cut3", "cut4", "cut5"):
        split = "cut5"
    return {"ok": True, "speed_factor": speed, "split": split}


@APP.post("/llm/assess")
async def llm_assess_endpoint(request: Request):
    """{base?, key, model?, text, emotions:[{key,label}], polish?} → {ok, emotion, polish?, raw?}
    一次 LLM 调用同时判断语气 + 按情绪润色台词(可选). 推理模型输出 JSON."""
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"ok": False, "message": "json body required"})
    base = str(body.get("base") or "").strip() or "https://api.openai.com/v1"
    key = str(body.get("key") or "").strip()
    model = str(body.get("model") or "").strip() or "gpt-4o-mini"
    text = str(body.get("text") or "")[:2000]
    context = str(body.get("context") or "").strip()[:2000]
    emotions = body.get("emotions") or []
    want_polish = bool(body.get("polish"))
    if not key:
        return JSONResponse(status_code=400, content={"ok": False, "message": "api key 未配置, 请在模块设置里填写后使用"})
    if not text:
        return JSONResponse(status_code=400, content={"ok": False, "message": "text required"})
    emo_map = {str(e.get("key", "")): str(e.get("label", e.get("key", ""))) for e in emotions if isinstance(e, dict)}
    if not emo_map:
        emo_map = {"calm": "平静", "happy": "开心", "relaxed": "放松", "angry": "生气", "sad": "悲伤",
                   "surprised": "惊讶", "shy": "害羞", "serious": "严肃", "gentle": "温柔", "sleepy": "困倦"}
    # 对标成品软件(Shinsekai): 把角色人设/性格注入 LLM, 让它按角色性格判断语气/润色, 而不是泛泛而判
    role_name = str(body.get("role") or "").strip()[:40]
    setting = str(body.get("setting") or "").strip()[:800]
    role_lines = ""
    if role_name or setting:
        role_lines = "角色: %s\n角色设定: %s\n" % (role_name or "未知", setting or "无")
    option_lines = "\n".join("- %s (%s)" % (k, v) for k, v in emo_map.items())
    sys_prompt = (
        "你是语气分析+台词润色助手(%s)。任务：根据台词内容、角色性格及其所在对话上下文，判断说话者语气，并%s。\n"
        "%s"
        "该角色可用语气选项:\n%s\n"
        "要求：\n"
        "1) emotion 必须是上面选项里的英文 key 之一（优先贴合该角色性格与台词语气）；\n"
        "2) polish 保持原意、不改事实内容，通过语气词/口语化/感叹让表达更自然更有情绪表现力，简体中文；\n"
        "3) 判断语气时优先依据台词本身与角色性格，上下文(最近对话)只作辅助理解语境；\n"
        "4) 只输出一个 JSON 对象，格式: {\"emotion\": \"key\", \"polish\": \"润色后的台词\"}，不要任何解释、不要 markdown。" % (role_name or "声音助手", "按该语气把台词润色得更自然" if want_polish else "不润色, polish 填空字符串", role_lines, option_lines)
    )
    user_content = text[:1200]
    if context:
        user_content = "最近对话上下文:\n%s\n\n---\n需要判断语气(并润色)的台词: %s" % (context, text[:1200])
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": sys_prompt},
            {"role": "user", "content": user_content},
        ],
        "temperature": 0.3,
        "max_tokens": 512,
    }
    url = base.rstrip("/") + "/chat/completions"
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": "Bearer %s" % key},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        return JSONResponse(status_code=200, content={"ok": False, "message": "LLM 请求失败(无AI语气, 语音不受影响): %s" % e})
    content = ""
    emo = ""
    polish = ""
    try:
        msg = (data.get("choices") or [{}])[0].get("message", {}) or {}
        content = str(msg.get("content") or "").strip()
        if not content:
            content = str(msg.get("reasoning_content") or "")
    except Exception:
        content = ""
    # 容错: 剥离 markdown 代码块后尝试 JSON
    content = re.sub(r"^```(?:json)?\s*", "", content, flags=re.IGNORECASE)
    content = re.sub(r"\s*```$", "", content, flags=re.IGNORECASE)
    m = re.search(r"\{.*\}", content, re.DOTALL)
    if m:
        try:
            parsed = json.loads(m.group(0))
            if isinstance(parsed, dict):
                emo = str(parsed.get("emotion") or "").strip().lower()
                polish = str(parsed.get("polish") or "").strip()
        except Exception:
            parsed = None
    if not emo:
        # 容错: 未解析出 JSON 时, 从全文提取情绪 key
        for k in emo_map:
            if k in content.lower():
                emo = k
                break
    if not polish and content and want_polish:
        # 容错: 全文里去掉情绪 key 后的剩余文本作润色稿
        t = re.sub(r'["\{\}\[\]]', "", content)
        t = re.sub(r"\b(%s)\b" % "|".join(emo_map.keys()), "", t, flags=re.IGNORECASE).strip()
        t = re.sub(r"^\s*(emotion|polish)\s*[:：]", "", t, flags=re.IGNORECASE).strip()
        if len(t) > 1:
            polish = t[:2000]
    return {"ok": True, "emotion": emo, "polish": polish[:2000] if polish else "", "raw": content[:80]}


if __name__ == "__main__":
    try:
        if host == "None":  # 在调用时使用 -a None 参数，可以让api监听双栈
            host = None
        print("=" * 60)
        print("GPT-SoVITS (FVTT edition) listening on %s:%s" % (host, port))
        print("  /tts      文字合成语音   POST/GET  (角色包已加载时只传 text 即可)")
        print("  /asr      语音听写       POST raw audio bytes?lang=zh|ja|en")
        print("  /audio/   合成音频拉流(URL 广播播放)")
        print("  /status   状态查询")
        print("  /docs     API 文档")
        print("浏览器里 Foundry 模块请把 serverUrl 指向: http://<本机IP或127.0.0.1>:%s" % port)
        # 多模型并行池: 启动读取"同时运行上限"(engine/config.json, 默认 10, 最大 20 — GM 可在 Foundry 设置改)
        try:
            load_pool_config()
        except Exception:
            pass
        print("=" * 60)
        # 音频缓存目录: 启动清空旧文件
        try:
            os.makedirs(_AUDIO_CACHE, exist_ok=True)
            for _f in os.listdir(_AUDIO_CACHE):
                try:
                    os.remove(os.path.join(_AUDIO_CACHE, _f))
                except Exception:
                    pass
        except Exception:
            pass
        # 热身: 服务就绪后预合成一句短语音(最多重试 3 次), 把 BERT/模型首次初始化前置 → 之后朗读不再冷启动
        try:
            def _warmup_worker():
                for _i in range(3):
                    try:
                        _wreq = {
                            "text": "你好，很高兴见到你。", "text_lang": "zh",
                            "media_type": "wav", "text_split_method": "cut5",
                            "batch_size": 1, "streaming_mode": False,
                            "speed_factor": 1.0, "top_k": 15, "top_p": 1.0, "temperature": 0.1,
                            "repetition_penalty": 1.05, "sample_steps": 32,
                        }
                        if CHAR_CONFIG:
                            _wreq["ref_audio_path"] = CHAR_CONFIG.get("ref_audio_path") or ""
                            _wreq["prompt_text"] = CHAR_CONFIG.get("prompt_text") or ""
                            _wreq["prompt_lang"] = CHAR_CONFIG.get("prompt_lang") or ""
                        _wg = tts_pipeline.run(_wreq)
                        next(_wg)
                        print("热身预合成完成(首次朗读将不再冷启动)")
                        return
                    except Exception as _we:
                        time.sleep(20)
            _wt = threading.Thread(target=_warmup_worker, daemon=True)
            _wt.start()
        except Exception:
            pass
        uvicorn.run(app=APP, host=host, port=port, workers=1)
    except Exception:
        traceback.print_exc()
        os.kill(os.getpid(), signal.SIGTERM)
        exit(0)
