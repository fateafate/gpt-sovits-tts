// 朗读当前聊天输入框文字 —— 双击运行
const input = document.getElementById("chat-message");
const text = input ? input.value : "";
if (!text.trim()) {
  ui.notifications.info("输入框是空的");
} else {
  await game.gptSoVitsTTS.speak(text);
}