@echo off
chcp 65001 >nul
title GPT-SoVITS (FVTT edition) TTS 服务
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-tts-server.ps1" %*
pause
