$outDir = "H:\mod2\Data\modules\gpt-sovits-tts\_tools\cmp"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$text = "こんにちは、今日もよろしくお願いします。"
$mainRef = "D:\Shinsekai\data\models\nanami\nanami.aac_0001620800_0001747840.wav"
$mainPrompt = "でも、怪しい人の手がかりならある。"
$emoRef   = "D:\Shinsekai\data\speech\nanami\nanami_voice_04.wav"
$emoTmpl  = "やった！すごいね！"

function Invoke-Tts([string]$base, [string]$name, [string]$ref, [string]$prompt) {
  $body = @{ text = $text; text_lang = "ja"; ref_audio_path = $ref; prompt_lang = "ja"; prompt_text = $prompt; media_type = "wav"; streaming_mode = $false } | ConvertTo-Json
  $out = Join-Path $outDir $name
  try {
    Invoke-WebRequest -Uri "$base/tts" -Method Post -ContentType "application/json" -Body $body -OutFile $out -TimeoutSec 180 -UseBasicParsing
    $len = (Get-Item $out).Length
    Write-Output ("OK   {0,-22} {1} bytes" -f $name, $len)
  } catch {
    Write-Output ("FAIL {0,-22} {1}" -f $name, $_.Exception.Message)
  }
}

Write-Output "=== Shinsekai 9880 ==="
Invoke-Tts "http://127.0.0.1:9880" "A_shin_main.wav"      $mainRef $mainPrompt
Invoke-Tts "http://127.0.0.1:9880" "B_shin_happy_nowords.wav" $emoRef ""
Write-Output "=== 我们的 9881 ==="
Invoke-Tts "http://127.0.0.1:9881" "C_ours_happy_tmpl.wav" $emoRef $emoTmpl
Invoke-Tts "http://127.0.0.1:9881" "D_ours_main.wav"      $mainRef $mainPrompt
Write-Output "--- 输出目录: $outDir ---"
Get-ChildItem $outDir | Select-Object Name, Length | Format-Table -AutoSize