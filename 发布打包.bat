@echo off
chcp 936 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"
set "ROOT=%~dp0"
set "DIST=%ROOT%dist"
set "STAGE=%DIST%\_stage\gpt-sovits-tts"

for /f "usebackq delims=" %%v in (`powershell -NoProfile -Command "(Get-Content -Raw 'module.json' -Encoding UTF8 | ConvertFrom-Json).version"`) do set "VER=%%v"
if "!VER!"=="" set "VER=0.0.0"
set "VER=!VER: =!"

echo.
echo ============================================================
echo   发布打包（模块包）  版本: !VER!
echo ============================================================
echo   说明: 本脚本只打"模块包"（不含 engine\ 的 16GB 引擎）。
echo         给别人的引擎要用 engine\打包引擎给别人.bat 单独打。
echo.

if exist "%DIST%\_stage" rd /s /q "%DIST%\_stage"
mkdir "%STAGE%" 2>nul

echo [1/3] 复制模块文件 ...
copy /y "%ROOT%module.json" "%STAGE%\" >nul
copy /y "%ROOT%README.md" "%STAGE%\" >nul
copy /y "%ROOT%LICENSE" "%STAGE%\" >nul
copy /y "%ROOT%package.json" "%STAGE%\" >nul
robocopy "%ROOT%scripts" "%STAGE%\scripts" /E /NFL /NDL /NJH /NJS /NP >nul
robocopy "%ROOT%styles" "%STAGE%\styles" /E /NFL /NDL /NJH /NJS /NP >nul
robocopy "%ROOT%languages" "%STAGE%\languages" /E /NFL /NDL /NJH /NJS /NP >nul
robocopy "%ROOT%tools" "%STAGE%\tools" /E /NFL /NDL /NJH /NJS /NP >nul
robocopy "%ROOT%docs" "%STAGE%\docs" /E /NFL /NDL /NJH /NJS /NP >nul

echo [2/3] 打 zip ...
if exist "%DIST%\gpt-sovits-tts-!VER!.zip" del /q "%DIST%\gpt-sovits-tts-!VER!.zip"
powershell -NoProfile -Command "Compress-Archive -Path '%STAGE%' -DestinationPath ('%DIST%\gpt-sovits-tts-' + '!VER!' + '.zip') -Force" >nul
if not exist "%DIST%\gpt-sovits-tts-!VER!.zip" (
  echo [失败] 打包 zip 失败。
  pause
  exit /b 1
)

echo [3/3] 清理临时目录 ...
rd /s /q "%DIST%\_stage" 2>nul

echo.
echo ============================================================
echo  完成: %DIST%\gpt-sovits-tts-!VER!.zip
echo ------------------------------------------------------------
echo  发行清单（两份）:
echo    1) 模块包(本 zip)  -^>  解压到 ^<FoundryData^>\modules\gpt-sovits-tts\
echo    2) 引擎包          -^>  运行 engine\打包引擎给别人.bat, 解压到同目录的 engine\ 下
echo.
echo  对方第一次使用:
echo    - Foundry 刷新 / 重载世界
echo    - 双击 engine\安装看门狗自启.bat (以后引擎随 Foundry 自动静默启动)
echo    - 语音设置确认服务端地址 http://127.0.0.1:9881 后点 最终测试
echo.
echo  安全提醒: 不要把带 LLM 密钥的"世界数据"一起发出去(aiSharedKey 会随世界分发)。
echo ============================================================
