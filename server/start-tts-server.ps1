# =============================================================================
#  start-tts-server.ps1 — GPT-SoVITS (FVTT edition) 自包含一键启动脚本
#  模块已内置完整引擎(engine/)与角色包(server/chars/*.char)，无需任何外部依赖。
#  复制整个 gpt-sovits-tts 文件夹到任意电脑的 Data\modules\ 即可使用全部功能。
#  流程: 定位内置引擎 -> 解压角色包到 engine\fvtt_chars\<name> -> 启动 fvtt_api.py
#  用法:
#    powershell -ExecutionPolicy Bypass -File .\start-tts-server.ps1
#    或直接双击 start-tts-server.bat
#  可选参数:
#    -Port 9880        -BindAddr 0.0.0.0
#    -SoVitsRoot <外部GPT-SoVITS目录>  (高级: 用自己的引擎替换内置)
#    -CharPack <外部.char路径>         (高级: 用自己的角色包)
#    -ExtraArgs "--asr-engine funasr"
# =============================================================================
param(
    [string]$SoVitsRoot = "",
    [string]$CharPack = "",
    [int]$Port = 9881,
    [string]$BindAddr = "0.0.0.0",
    [string]$ExtraArgs = "",
    [switch]$NoRestart = $false
)
$ErrorActionPreference = "Stop"
$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$moduleRoot = Split-Path -Parent $scriptPath

Write-Host "`n==== GPT-SoVITS (FVTT edition) 启动器 ====" -ForegroundColor Cyan

# ---------- 1. 定位引擎 ----------
$engine = ""
if ($SoVitsRoot) {
    if (Test-Path (Join-Path $SoVitsRoot "GPT_SoVITS\configs\tts_infer.yaml")) { $engine = (Resolve-Path $SoVitsRoot).ProviderPath }
    else { Write-Host "[错误] 指定的 -SoVitsRoot 无效(未找到 GPT_SoVITS\configs\tts_infer.yaml)" -ForegroundColor Red; exit 1 }
} else {
    $builtin = Join-Path $moduleRoot "engine"
    if (Test-Path (Join-Path $builtin "GPT_SoVITS\configs\tts_infer.yaml")) { $engine = (Resolve-Path $builtin).ProviderPath }
}
if (-not $engine) {
    Write-Host "[错误] 未找到内置引擎 engine\ (请确认完整的 gpt-sovits-tts 文件夹已复制到位)" -ForegroundColor Red
    exit 1
}
Write-Host ("[1/4] 引擎目录: " + $engine) -ForegroundColor Green

# ---------- 2. 定位并解压角色包 ----------
$charYaml = ""
if (-not $CharPack) {
    $chars = @(Get-ChildItem (Join-Path $scriptPath "chars") -Filter *.char -File -ErrorAction SilentlyContinue)
    if ($chars.Count -gt 0) { $CharPack = $chars[0].FullName }
}
if ($CharPack) {
    $CharPack = (Resolve-Path $CharPack).ProviderPath
    $name = [IO.Path]::GetFileNameWithoutExtension($CharPack)
    $charsRoot = Join-Path $engine "fvtt_chars"
    $packDir = Join-Path $charsRoot $name
    $charYaml = Join-Path $packDir "character.yaml"
    if ((Test-Path $charYaml) -and (Test-Path (Join-Path $packDir ".extracted"))) {
        Write-Host ("[2/4] 角色包已解压: " + $packDir) -ForegroundColor Green
    } else {
        Write-Host ("[2/4] 解压角色包: " + $CharPack) -ForegroundColor Yellow
        if (Test-Path $packDir) { Remove-Item -LiteralPath $packDir -Recurse -Force }
        New-Item -ItemType Directory -Path $packDir -Force | Out-Null
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [System.IO.Compression.ZipFile]::ExtractToDirectory($CharPack, $packDir)
        [IO.File]::WriteAllText((Join-Path $packDir ".extracted"), (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"))
        Write-Host ("      已解压到: " + $packDir) -ForegroundColor Green
    }
} else {
    Write-Host "[2/4] 未提供角色包(.char), 将以默认预设音色启动" -ForegroundColor Yellow
}

# ---------- 3. 定位 Python(内置引擎 runtime) ----------
$python = Join-Path $engine "runtime\python.exe"
if (-not (Test-Path $python)) { Write-Host "[错误] 未找到内置 Python: $python" -ForegroundColor Red; exit 1 }
Write-Host ("[3/4] Python: " + $python) -ForegroundColor Green

# ---------- 4. 无 NVIDIA GPU 时自动降级 CPU ----------
if (-not (Get-Command nvidia-smi -ErrorAction SilentlyContinue)) {
    Write-Host "[提示] 未检测到 NVIDIA GPU, 自动使用 CPU 模式(--device cpu --no-half, 合成速度较慢)" -ForegroundColor Yellow
    $ExtraArgs = "$ExtraArgs --device cpu --no-half"
}

# ---------- 5. 启动 ----------
$api = Join-Path $scriptPath "fvtt_api.py"
$pyArgs = @($api, "-a", $BindAddr, "-p", $Port, "-c", "GPT_SoVITS/configs/tts_infer.yaml")
if ($charYaml) { $pyArgs += @("--char", $charYaml) }
if ($ExtraArgs) { $pyArgs += $ExtraArgs -split " " }
Write-Host "[4/4] 启动: $python $($pyArgs -join ' ')" -ForegroundColor Green
Write-Host "`n首次启动需加载模型(约10~60秒), 看到 'Uvicorn running' 即就绪。`n" -ForegroundColor Yellow

Push-Location $engine
try {
    $env:PYTHONUNBUFFERED = "1"   # python 实时输出日志(可看到模型加载到哪一步)
    $maxRestart = 5
    $attempt = 0
    while ($true) {
        # 端口占用预检: 已有监听者(非本次拉起)则不再启动/重试, 避免 bind 10048 死循环
        $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
        if ($listener) {
            Write-Host ("`n[错误] 端口 {0} 已被占用(PID {1})。请先关闭占用该端口的进程再启动。" -f $Port, $listener.OwningProcess) -ForegroundColor Red
            Write-Host "        (也可能是另一个 TTS 服务实例仍在运行)" -ForegroundColor Yellow
            try { Read-Host "按回车退出" } catch { }
            break
        }
        $attempt++
        Write-Host ("`n[启动] 第 {0} 次启动服务..." -f $attempt) -ForegroundColor Green
        # 日志落盘(每次启动追加): 崩溃时可查看 tts-server.log 定位原因
        # 注意: python 的 stderr 行(INFO 等)在 $ErrorActionPreference=Stop 下会触发 NativeCommandError
        # 终止脚本, 这里临时改 Continue 再恢复
        $logFile = Join-Path $scriptPath "tts-server.log"
        $oldEA = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        & $python $pyArgs 2>&1 | Tee-Object -FilePath $logFile -Append
        $code = $LASTEXITCODE
        $ErrorActionPreference = $oldEA
        if ($code -eq 0 -or $NoRestart) {
            Write-Host ("`n[退出] 服务已停止(码 {0})" -f $code) -ForegroundColor Yellow
            try { Read-Host "按回车关闭窗口" } catch { }
            break
        }
        if ($attempt -gt $maxRestart) {
            Write-Host ("`n[错误] 服务连续崩溃 {0} 次, 停止自动重启(码 {1})。请查看上方日志。" -f $attempt, $code) -ForegroundColor Red
            try { Read-Host "按回车关闭窗口" } catch { }
            break
        }
        Write-Host ("`n[警告] 服务异常退出(码 {0}), 5 秒后自动重启(第 {1}/{2} 次)..." -f $code, $attempt, $maxRestart) -ForegroundColor Yellow
        Start-Sleep -Seconds 5
    }
} finally {
    Pop-Location }
