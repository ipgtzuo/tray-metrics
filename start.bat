@echo off
rem 从 Electron 宿主应用启动时可能继承此变量，会导致 electron.exe 退化成纯 Node
set ELECTRON_RUN_AS_NODE=
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Electron is not installed. Please run: npm install
  pause
  exit /b 1
)
start "" "node_modules\electron\dist\electron.exe" .
