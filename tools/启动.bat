@echo off
chcp 65001 >nul
setlocal
title 小鲸鱼 · 运行中（别关这个窗口）

rem ═══════════════════════════════════════════════════════════
rem  启动 qq-bridge
rem  这个窗口【要一直开着】✗ 关了就等于她下线了
rem ═══════════════════════════════════════════════════════════

cd /d "%~dp0"

echo.
echo  ╔══════════════════════════════════════════════════════╗
echo  ║                  小鲸鱼 · 启动中                     ║
echo  ╚══════════════════════════════════════════════════════╝
echo.

rem ── 检查前置 ─────────────────────────────────────────────
if not exist "config.json" (
    echo  ╳ 没有 config.json
    echo    先跑一次 安装.bat
    pause
    exit /b 1
)

echo  检查前置服务...
echo.

rem SnowLuma（3000 端口）
powershell -NoProfile -Command ^
  "if ((Test-NetConnection 127.0.0.1 -Port 3000 -WarningAction SilentlyContinue).TcpTestSucceeded) { Write-Host '    OK   SnowLuma（QQ 连接）' } else { Write-Host '    XX   SnowLuma 没在跑'; Write-Host '         去双击它的 launcher.bat，扫码登录'; exit 1 }"
if errorlevel 1 (
    echo.
    pause
    exit /b 1
)

rem DeepSeek Harness（43129 端口）
powershell -NoProfile -Command ^
  "if ((Test-NetConnection 127.0.0.1 -Port 43129 -WarningAction SilentlyContinue).TcpTestSucceeded) { Write-Host '    OK   DeepSeek Harness（大脑）' } else { Write-Host '    ??   DeepSeek Harness 好像没开'; Write-Host '         如果她不理你，八成是这个原因' }"

echo.
echo  ══════════════════════════════════════════════════════
echo   正在启动。下面会刷很多行字，那是正常的。
echo.
echo   ★ 这个窗口不要关 ★
echo   最小化它，去 QQ 里跟她说话就行
echo.
echo   想让她下线：直接关掉这个窗口
echo  ══════════════════════════════════════════════════════
echo.

node src\bridge.js

echo.
echo  她下线了。
echo.
pause
endlocal
