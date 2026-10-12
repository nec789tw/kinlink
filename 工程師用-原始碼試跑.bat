@echo off
set "PYTHONDONTWRITEBYTECODE=1"
chcp 65001 >nul
cd /d "%~dp0"
rem ======================================================
rem  ⚠ 工程師專用：從「原始碼」啟動，讀寫的是【專案根目錄】的開發用 繫族.db
rem    ——不是您平常那份！總幹事請一律雙擊 dist\繫族.exe
rem    （正式資料在 dist\繫族.db）
rem ======================================================
rem  NOTE for editors: a line ending in a Chinese character must be followed by a pure-ASCII
rem  line, or cmd on zh-TW Windows misreads the next line (tests\test_b3_bat_dbcs.py checks it).
set "PYW=%LOCALAPPDATA%\Microsoft\WindowsApps\pythonw.exe"
if exist "%PYW%" (
  start "" "%PYW%" "app.py"
) else (
  start "" pythonw "app.py"
)
