# Shinsekai 是怎么让 AI 参与语音合成的（源码实证）vs 我们

> 依据：`H:\mod2\语音合成\另一款成品软件\Shinsekai` 源码实读（2026-10-21）
> 核心文件：`core/handlers/tts_message_handler.py`、`core/handlers/ui_message_handler.py`

---

## 一、Shinsekai 的完整链路（一图看懂）

```
LLM 输出一个对话消息对象 LLMDialogMessage：
    name       角色名
    text       台词原文(speech)          ← AI 生成/决定的台词
    translate  翻译文本                  ← ★ AI 自己翻译（不靠外部翻译API）
    asset_id   立绘编号(1-based)         ← ★ AI 选的立绘
    effect     音效

        ↓  tts_message_handler.handle(msg)  （tts_message_handler.py:200-346）

① 选文本：if translate: speech_text = translate（去括号/替换人名）
   L205-213：translate 存在就直接用翻译文本朗读，否则用原文

② 解析立绘：sprite_id = int(asset_id) - 1
   L226-231：越界/缺失 → sprite_id = -1（保持上一张立绘、用默认参考音）

③ 预设音频优先（零合成、最快最自然）：
   L234-244：sprite 的 voice_type == "preset" → 直接播放该立绘上传的音频文件，跳过 TTS

④ 用立绘的参考音合成（核心）：
   L246-259：默认用 character.refer_audio_path
            若该立绘 voice_type == "reference"（或没类型但有 voice_text），
            且 voice_path + voice_text 都存在 → 用立绘的 voice_path 作为参考音、voice_text 作为提示文本
            （远端引擎时只允许 /kaggle/ 路径）

⑤ 语速：_speed = character_config.speech_speed   ← 固定角色常量（L286）

⑥ 合成：可分段（按标点切，≤15字/段）逐句合成 → 流式播放（L265-309）

⑦ 兜底：L342-346 用 voice_type == "fallback"/"preset" 的音频；都没有时按原逻辑
```

**一句话总结**：
> **AI 输出"说哪句 + 哪张立绘 + 翻译"，立绘上挂着"参考音频"，TTS 用它做零样本克隆 → 情绪/语气的差异全部由"选哪张立绘"决定，不用任何变调 DSP。**

---

## 二、立绘 → 参考音的三种挂载方式（voice_type）

| voice_type | 含义 | 引擎行为 | 效果 |
|---|---|---|---|
| `preset` | 该立绘**已有录好的音频** | **直接播放**，不合成 | 零延迟、最自然 |
| `reference`（或未标类型但有 voice_text）| 该立绘有**参考音频 + 对应文本** | 用 `voice_path` 当参考音做克隆合成 | 换声线/情绪 |
| `fallback` | 兜底音频 | 合成失败/无参考音时用 | 不断声 |

源码：`_read_sprite_voice_cfg()`（L34-50）读 yaml 里 `sprites[i].voice_type/voice_path/voice_text`；
`_sprite_voice_audio()`（L97-121）按 `allowed_types` 过滤。

**关键点**：情绪不是"标签"，而是**AI 选中的那张立绘所绑定的那段音频**——AI 选立绘 = 选音色。

---

## 三、AI 在链路里做的 4 件事（我们的对照）

| AI 的职责 | Shinsekai 做法 | 我们目前 | 差距 |
|---|---|---|---|
| ① 说哪句（台词） | AI 生成 `text`（角色扮演输出） | 玩家自己打字 → AI **润色**（polish） | 不同场景，我们更贴近"玩家发言" |
| ② **翻译** | **AI 输出 `translate` 字段，直接当朗读文本** | ❌ 用 **MyMemory 免费翻译 API** → **429 限流** | **★ 最大差距** |
| ③ 选立绘 | AI 输出 `asset_id`（1-based 编号） | ✓ 1.6.53 起 AI 输出 `sprite` 编号 → `flags.aiSprite` | 持平 |
| ④ 选音色 | 立绘绑 `voice_path` → 作参考音 | ✓ 情绪槽 `ref_audio_path`（等价机制） | 持平 |
| 音效 | `effect` 字段 | ❌ 无 | 可选 |

---

## 四、结论：三个可借鉴点（按价值排序）

### P0（强烈建议，直接解决你现在的 429 问题）
**让 AI 顺便做翻译（Shinsekai 的 `translate` 字段）**
- 我们的 `/llm/assess` 已经一次调用返回 `{emotion, polish, sprite}` → **再加一个 `translate`**
- 客户端朗读时优先用 `translate`（若目标语言≠文本语言），**完全不调用 MyMemory** → 429 问题根除
- 顺带：LLM 翻译质量远好于免费 API；且与判语气共用一次请求（零额外成本）

### P1（体验提升）
**立绘/情绪槽支持"预设音频直播"（preset）**
- 若某情绪槽配置了现成音频（不是参考音而是成品句子），直接播放，不走合成
- 适合固定台词/口头禅（如"嗯哼~"），零延迟且最自然

### P2（性能）
**按句分段合成 + 流式播放**（Shinsekai 的 `tts_split_enabled`）
- 长句按标点切 ≤15 字，逐段合成边出边播 → 首句延迟从"整句时长"降到"首段时长"

---

## 五、我们**不必照抄**的部分（我们已有更好的）
- **语速**：Shinsekai 固定角色常量；我们有"朗读提示词 + 强度滑块"可调 ✓
- **无 LLM 就报错**：Shinsekai 启动即要求 LLM；我们有**规则降级**（文本规则/提示词基调）✓
- **情绪槽**：我们支持任意标签（不必与立绘一一对应）；Shinsekai 必须立绘挂 voice ✓ 更灵活

---

## 六、附：源码定位

| 功能 | 文件:行 |
|---|---|
| 读立绘 voice 配置 | `core/handlers/tts_message_handler.py:34-50` |
| voice_type 过滤 | `core/handlers/tts_message_handler.py:97-121` |
| 用 translate 当朗读文本 | `core/handlers/tts_message_handler.py:205-213` |
| 立绘编号解析 | `core/handlers/tts_message_handler.py:226-231` |
| preset 直播 | `core/handlers/tts_message_handler.py:234-244` |
| 立绘参考音替换 | `core/handlers/tts_message_handler.py:246-259` |
| 固定语速 | `core/handlers/tts_message_handler.py:286` |
| 分段合成 | `core/handlers/tts_message_handler.py:265-309` |
| fallback 兜底 | `core/handlers/tts_message_handler.py:342-346` |
| AI 输出字段（sprite/speech/translate/effect）| `core/handlers/ui_message_handler.py:177-217` |
