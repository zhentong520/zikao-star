@echo off
chcp 65001 >nul
title 自考星 - 本地服务
cd /d "%~dp0"

echo.
echo   ============================================
echo      自考星 正在启动...
echo   ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [错误] 未找到 Node.js
  echo   请先安装 Node.js 22 或更高版本：https://nodejs.org
  echo.
  pause
  exit /b 1
)

if not exist "data\zikao.db" (
  echo   首次运行，正在初始化本地数据库...
  node server\seed.js
  echo.
)

echo   数据库位置：%cd%\data\zikao.db
echo.
echo   启动后请在浏览器打开：
echo     http://localhost:5173
echo.
echo   手机使用（需同一 WiFi）：
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
  set IP=%%a
  set IP=%IP: =%
  echo     http://%IP%:5173
)

echo.
echo   iPhone：Safari 打开后 点分享 -> 添加到主屏幕
echo   Android：Chrome 菜单 -> 添加到主屏幕 / 安装应用
echo.
echo   关闭此窗口即停止服务
echo   ============================================
echo.

node server\index.js

pause
