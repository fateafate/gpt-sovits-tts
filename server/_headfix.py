# -*- coding: utf-8 -*-
"""1.6.63 音频头部修复(句首静音/弱起): 独立模块, 便于单元验证(engine/_probe_head.py 直接引用同一实现)。

背景(实测): 合成音频开头常有 200~300ms 接近静音, 听感"开头几个字被吞/听不到"。
- 旧实现 _trim_lead_silence_arr 有 `if n <= sr*2.4: return arr` 的早退 → 1.2~2.4 秒的短句(聊天最常见长度)
  完全不裁剪, 于是 2.12s 句开头 295ms 静音原样播出(实测 audio_export/*.mp3: 2.12s→静音0.295s, 2.45s→仅0.038s)。
- 本模块: ① 按比例限幅裁剪(短句也裁) ② 末端"语音起点对齐"清理(裁剪 + 弱起提升), 两条都只在确有改善时生效。
"""
import numpy as np


def _to_float_audio(arr):
    """统一转 float32(-1..1): 引擎可能返回 int16 PCM(满幅 32768 域)。"""
    a = np.asarray(arr)
    if a.dtype.kind == "i":
        a = a.astype(np.float32) / 32768.0
    return a.astype(np.float32)


def _limit_peak(arr, max_peak=0.92):
    a = np.asarray(arr, dtype=np.float32)
    if a.size == 0:
        return a
    peak = float(np.max(np.abs(a)))
    if peak > max_peak:
        a = a * (max_peak / peak)
    return a


def trim_lead_silence_arr(arr, sr, max_trim_s=1.2, thresh=0.015):
    """裁剪合成音频开头的静音/弱音段。1.6.63: 去掉"短音频不裁"早退(旧 n <= sr*2.4 直接返回);
    改为最多裁 min(1.2s, 时长40%), 且保证剩余 >= 120ms; 极短音频(<120ms)才跳过。"""
    a = np.asarray(arr, dtype=np.float32)
    n = len(a)
    sr = int(sr or 24000) or 24000
    if n <= int(sr * 0.12):
        return a
    dur = n / float(sr)
    max_trim = int(sr * min(max_trim_s, max(0.0, dur * 0.40)))
    max_trim = min(max_trim, max(0, n - int(sr * 0.12)))
    if max_trim <= 0:
        return a
    win = max(1, int(sr * 0.02))
    i = 0
    while i < max_trim:
        seg = a[i:i + win]
        rms = float(np.sqrt(np.mean(seg ** 2))) if len(seg) else 0.0
        if rms >= thresh:
            break
        i += win
    if 0 < i < n:
        keep = max(0, i - win)   # 回退一窗作缓冲, 不硬切首音素
        if n - keep >= int(sr * 0.05):
            return a[keep:]
    return a


def clean_head_final(arr, sr, start_thresh=0.03, pad_s=0.03, floor=0.09, max_trim_s=0.7, max_gain=20.0):
    """1.6.63 输出末端头部清理(兜底保障"开头几个字听得见"):
    ① 找第一个能量 >= start_thresh 的 20ms 窗作为语音起点, 从"起点前 pad_s"处截断(去掉开头静音);
    ② 把开头 1.0s 内仍低于 floor 的 20ms 窗软提升到 floor(上限 max_gain, 防放大底噪);
    ③ 防削波。仅在确有改善(裁掉 >= 60ms 或有提升)时返回新数组, 否则原样返回。"""
    a = _to_float_audio(arr).copy()
    n = len(a)
    sr = int(sr or 24000) or 24000
    if n < int(sr * 0.15):
        return a
    win = max(1, int(sr * 0.02))
    dur = n / float(sr)
    maxw = int(min(max_trim_s, dur * 0.5) * sr / win)
    start = -1
    for k in range(max(0, maxw)):
        seg = a[k * win:(k + 1) * win]
        if len(seg) and float(np.sqrt(np.mean(seg ** 2))) >= start_thresh:
            start = k * win
            break
    if start > 0:
        keep = max(0, start - int(sr * pad_s))
        if keep >= int(sr * 0.06) and (n - keep) >= int(sr * 0.15):
            a = a[keep:]
            n = len(a)
    # 弱起提升(开头 1 秒内)
    nwin = int(min(1.0, n / float(sr)) * sr / win)
    for k in range(max(0, nwin)):
        seg = a[k * win:(k + 1) * win]
        r = float(np.sqrt(np.mean(seg ** 2))) if len(seg) else 0.0
        if 0.0 < r < floor:
            a[k * win:(k + 1) * win] *= min(floor / r, max_gain)
    return _limit_peak(a)
