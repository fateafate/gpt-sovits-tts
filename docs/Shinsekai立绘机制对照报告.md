# 调研报告：Shinsekai（新世界）立绘灵活切换机制拆解与对照

> 对象：`H:\mod2\语音合成\另一款成品软件\Shinsekai`（本机安装的成品软件，Python 全量源码 + exe）
> 角色样本：`data/config/characters.yaml`（七海千秋，弹丸论破角色，21 张立绘 + 21 条情绪标注 + 21 条绑定语音）

---

## 一、Shinsekai 是什么（和我们同源）

- 完整成品：**TTS 合成 + LLM 对话 + 立绘演出 + ASR/图像** 一体的桌面 AI 互动软件（main.py / tts / llm / sprite / frontend_bridge…）
- 它的 TTS 参数体系（cut5 切分 / batch 并行 / 参考音频驱动）**正是我们模块引擎参数的参考来源**——可以说**它本来就是我们的"母版"之一**（弹丸论破角色也是同一批复刻对象）。

---

## 二、立绘"灵活切换"的机制（三环节）

### 环节 1：立绘配"情绪称呼"标注（人工/生成工具写的配置）

`characters.yaml` 里，每个角色 = `sprites[]`（立绘列表）+ `emotion_tags`（**每张立绘的情绪标注文本**）：

```yaml
- name: 七海千秋
  sprites:
  - path: data/sprite/nanami/..._01.webp
    voice_path: data/speech/nanami/nanami_voice_00.wav   # 每张立绘绑一条语音
    voice_type: fallback
  ...
  emotion_tags: |
    sprite 01: 中性，平静
    sprite 04: 生气，鼓起脸颊
    sprite 05: 开心，微笑，温柔
    sprite 16: 不满，难过，沮丧
    sprite 21: 害羞，脸红
```

- **每张立绘都有"称呼"**（情绪描述）——**不靠看图、不靠文件名**，是**文本标注**
- 立绘同时绑语音（`voice_path`）——**立绘即"情绪单元"**（选立绘 = 选情绪 + 选语音）

### 环节 2：把标注注入 LLM prompt

`llm/template_generator.py`（L434-438）：生成角色模板时把 `sprites` 数量 + `emotion_tags` **整体注入系统提示词**——LLM 看得到"每张立绘表示什么情绪"。

### 环节 3：LLM 回复直接输出"立绘 id + 情绪"→ 前端切换

- `llm/template_generator.py`（L376-379）：要求 LLM 的回复带结构化字段：**`sprite`（选哪张立绘）**、`speech`、`character_name` 等
- `llm/text_processor.py`（L24-26）：解析 LLM 回复开头的情绪标记：`(emotion: HAPPY)`（7 种枚举：NEUTRAL/HAPPY/ANGRY/SAD/SURPRISED/SLEEPY/RELAXED）
- `llm_manager.py`：解析 `sprite` 字段 → 前端展示对应立绘

**一句话**：**LLM 根据台词内容，从注入的标注表里直接挑一张立绘（输出 sprite id），前端切换**。情绪标记（emotion）同时驱动声音侧。

---

## 三、与我们的对照

| 环节 | Shinsekai | 我们（1.6.26） |
|---|---|---|
| 立绘情绪称呼标注（emotion_tags） | ✅ **配置层文本标注**（"sprite 05: 开心微笑"） | ❌ 无（纯数字文件名，只能分段猜） |
| 标注注入 LLM prompt | ✅ 模板注入 | ⚠️ 只有角色 setting 注入；无立绘标注 |
| LLM 输出选立绘 id | ✅ **回复带 sprite 字段直接选** | ❌ 只判情绪 → 分组近似（不精确） |
| 情绪枚举/标记 | ✅ 7 种 + `(emotion: HAPPY)` 回复标记 | ✅ 6 种判情绪 → DSP 调制（类似） |
| 立绘绑语音 | ✅ 每立绘一条语音 | ✅ 10 语气槽（相似且更强：可合成） |
| 前端切换 | ✅ 按 id 即时切 | ✅ 消息立绘 + 组内轮换 |
| 多端/游戏集成 | ❌ 单机桌面 | ✅ FVTT 多端同步/广播/角色包（强） |

**本质差距就一层：我们缺"立绘情绪称呼标注 → LLM 直接选立绘 id"**（Shinsekai 的立绘切换之所以"灵活"，完全靠这层人工/导入标注 + LLM 直选）。

---

## 四、落地建议（完全对标 Shinsekai）

| 步骤 | 做法 |
|---|---|
| **① 立绘标注配置** | 角色包/语音管理器增加"立绘情绪标注"：`sprite 01: 中性平静 …`（同款格式）。来源：你手动填 / VLM 一次打标（有视觉模型的 key 时自动生成）/ 暂缺则保留现有分段兜底 |
| **② LLM 直选立绘** | 引擎 LLM prompt 注入立绘标注表（同 Shinsekai）→ 回复直接输出 `sprite` id → 客户端用（跨端写回消息 flags） |
| **③ 情绪枚举对齐** | 加 SLEEPY/RELAXED 等，与 7 情绪模板一致（DSP 调制参数表扩展） |
| **④ 降级链** | LLM 直选 > 规则判情绪+分组 > 文件名情绪词 > 轮换（现有逐级保留） |

---

## 参考（源码证据）
- `Shinsekai/data/config/characters.yaml`（立绘+绑定语音+emotion_tags）
- `Shinsekai/llm/template_generator.py`（标注注入 prompt + sprite 输出字段 + r_sprite 需求）
- `Shinsekai/llm/text_processor.py`（`(emotion: HAPPY)` 标记解析）
- `Shinsekai/llm/tools/character_tools.py`（LLM 工具 get_character_info 返回「立绘id和对应的情绪标注」）
- `Shinsekai/core/sprite/selection.py`（立绘路径/索引解析）