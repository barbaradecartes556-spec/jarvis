@echo off
chcp 65001 >nul
cd /d "%~dp0"
start "" /b python server.py
timeout /t 2 >nul
start chrome http://localhost:8765 || start http://localhost:8765
echo J.A.R.V.I.S. 已启动：http://localhost:8765 ，用完关闭这个窗口即可。
pause >nul
