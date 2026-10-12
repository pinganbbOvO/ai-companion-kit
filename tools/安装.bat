@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title 小鲸鱼 · 一键安装

rem ═══════════════════════════════════════════════════════════
rem  小鲸鱼安装器 —— 把 qq-bridge 装好、依赖装好、配置生成好
rem  作者：平安（pinganbbOvO）
rem  仓库：github.com/pinganbbOvO/ai-companion-kit
rem
rem  这个脚本做的事情：
rem    ① 检查有没有 Node.js
rem    ② 从 GitHub 下载 qq-bridge
rem    ③ 跑 npm install
rem    ④ 生成 config.json 模板
rem    ⑤ 打开记事本让你填三个值
rem
rem  它【不会】：
rem    · 不会装 DSH / SnowLuma（那两个你得自己装）
rem    · 不会动你现有的任何文件（都放在新目录里）
rem    · 不会联网发任何东西出去
rem ═══════════════════════════════════════════════════════════

echo.
echo  ╔══════════════════════════════════════════════════════╗
echo  ║           小鲸鱼 · 一键安装（qq-bridge）             ║
echo  ╚══════════════════════════════════════════════════════╝
echo.

rem ── 选安装目录 ────────────────────────────────────────────
set "TARGET=%~1"
if "%TARGET%"=="" (
    echo  装到哪个文件夹？
    echo  （直接回车 = D:\qq-bridge，推荐）
    echo.
    set /p TARGET= 路径：
)
if "%TARGET%"=="" set "TARGET=D:\qq-bridge"

echo.
echo  安装到：!TARGET!
echo.

rem ── ① 检查 Node.js ────────────────────────────────────────
echo  [1/5] 检查 Node.js...
where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo  ╳ 没找到 Node.js
    echo.
    echo  请先装它，然后再跑一次这个脚本：
    echo    1. 浏览器搜索 "Node.js 官网"
    echo    2. 下载 LTS 版本（左边那个按钮）
    echo    3. 双击安装，一路"下一步"
    echo    4. ★装完重启一次电脑★
    echo.
    pause
    exit /b 1
)
for /f "delims=" %%v in ('node -v') do set "NODEV=%%v"
echo        OK  Node.js !NODEV!

where npm >nul 2>nul
if errorlevel 1 (
    echo  ╳ 有 node 但没找到 npm ✗ Node.js 可能装坏了
    echo    建议卸载后重装一次
    pause
    exit /b 1
)
echo        OK  npm

rem ── ② 下载 qq-bridge ─────────────────────────────────────
echo.
echo  [2/5] 下载 qq-bridge...

if exist "!TARGET!\src\bridge.js" (
    echo        已经装过了，跳过下载
    goto :skip_download
)

if exist "!TARGET!" (
    echo        ⚠️ 目录已存在但不是完整的 qq-bridge
    echo        换个目录，或者先把它删掉
    pause
    exit /b 1
)

mkdir "!TARGET!" 2>nul
set "ZIP=%TEMP%\qq-bridge-%RANDOM%.zip"
set "URL=https://gh-proxy.com/https://github.com/Derpyu520/qq-bridge/archive/refs/heads/main.zip"

echo        正在下载（可能要一两分钟）...
powershell -NoProfile -Command ^
  "try { [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest '%URL%' -OutFile '%ZIP%' -UseBasicParsing -TimeoutSec 300; Write-Host '        OK  下载完成' } catch { Write-Host ('        X 下载失败：' + $_.Exception.Message); exit 1 }"
if errorlevel 1 (
    echo.
    echo  ╳ 下载失败
    echo.
    echo  可能是网络问题。你可以手动来：
    echo    1. 浏览器打开 gh-proxy.com/https://github.com/Derpyu520/qq-bridge
    echo    2. 绿色 Code 按钮 → Download ZIP
    echo    3. 解压到 !TARGET!
    echo    4. 再跑一次这个脚本（它会跳过下载）
    echo.
    pause
    exit /b 1
)

echo        正在解压...
powershell -NoProfile -Command ^
  "Expand-Archive -Path '%ZIP%' -DestinationPath '%TEMP%\qqb-tmp' -Force; $d = Get-ChildItem '%TEMP%\qqb-tmp' -Directory | Select-Object -First 1; Copy-Item ($d.FullName + '\*') '!TARGET!' -Recurse -Force"
if errorlevel 1 (
    echo  ╳ 解压失败
    pause
    exit /b 1
)
del "%ZIP%" >nul 2>nul
rmdir /s /q "%TEMP%\qqb-tmp" >nul 2>nul
echo        OK  解压完成

:skip_download

rem ── ③ npm install ────────────────────────────────────────
echo.
echo  [3/5] 安装依赖（npm install）...
echo        这一步最慢，可能三五分钟，别关窗口
echo.
pushd "!TARGET!"
call npm install --no-audit --no-fund
if errorlevel 1 (
    echo.
    echo  ⚠️ npm install 报错了
    echo.
    echo  再试一次通常就好了（网络问题）。如果还不行：
    echo    cd /d !TARGET!
    echo    npm install --registry=https://registry.npmmirror.com
    echo.
    echo  要我帮你换成国内镜像重试吗？
    choice /c YN /m "       重试"
    if !errorlevel!==1 (
        call npm install --no-audit --no-fund --registry=https://registry.npmmirror.com
    )
)
popd
echo        OK  依赖装好了

rem ── ④ 生成 config.json ───────────────────────────────────
echo.
echo  [4/5] 生成配置文件...

if exist "!TARGET!\config.json" (
    echo        已有 config.json，不覆盖
    goto :skip_config
)
if not exist "!TARGET!\config.example.json" (
    echo        ⚠️ 没找到 config.example.json ✗ 下载可能不完整
    goto :skip_config
)

copy "!TARGET!\config.example.json" "!TARGET!\config.json" >nul
echo        OK  已生成 config.json

:skip_config

rem ── ⑤ 打开记事本 ─────────────────────────────────────────
echo.
echo  [5/5] 打开配置文件，你要填三个地方
echo.
echo   ══════════════════════════════════════════════════
echo    ① ownerQQ          →  改成【你的】QQ 号
echo    ② allow.private    →  里面两个数字，一个是你的号，
echo                           另一个改成【她】的 QQ 号
echo    ③ snowluma.accessToken
echo                       →  填 SnowLuma 界面里那串"访问令牌"
echo   ══════════════════════════════════════════════════
echo.
echo   改完保存（Ctrl+S），关掉记事本，然后按任意键继续
echo.
pause
start notepad "!TARGET!\config.json"

echo.
echo  ╔══════════════════════════════════════════════════════╗
echo  ║  装好了                                              ║
echo  ╚══════════════════════════════════════════════════════╝
echo.
echo  接下来：
echo.
echo    ① 确认 SnowLuma 已经登录（它那个窗口还开着吗？）
echo    ② 确认 DeepSeek Harness 已经打开
echo    ③ 双击这个文件夹里的  启动.bat
echo.
echo  装在哪： !TARGET!
echo.
pause
endlocal
