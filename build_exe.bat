@echo off
REM ============================================================================
REM  Kinlink build script ( build_exe.bat )
REM  Build a single onefile EXE: dist\繫族.exe
REM
REM  Pipeline: create venv -> pip install deps -> pyinstaller 繫族.spec -> verify
REM  Root hygiene: no __pycache__ (PYTHONDONTWRITEBYTECODE), PyInstaller work
REM  files go under build_venv\pyi-build so the project root stays readable.
set "PYTHONDONTWRITEBYTECODE=1"
REM
REM  NOTE: comments are English on purpose. Windows console default codepage
REM  (cp950 on Traditional-Chinese systems) corrupts Chinese in .bat bodies,
REM  so nothing Chinese may run before the "chcp 65001" below. Even after it,
REM  on zh-TW (and other double-byte) Windows cmd MIS-READS a line that follows
REM  a line ENDING in a Chinese character, and runs fragments of it as commands.
REM  So Chinese help text for a person (wrong Python version, ...) is kept in
REM  release\build-help-*.txt and printed with "type"; tests\test_g9 checks the
REM  rule. The produced EXE name is still 繫族.exe (defined inside 繫族.spec,
REM  which is UTF-8 and safe).
REM ============================================================================

setlocal enabledelayedexpansion
REM  Force UTF-8 console: this file is UTF-8 and references Chinese paths
REM  (繫族.spec, dist\繫族.exe, ...). On a stock zh-TW Windows the
REM  console is cp950 and those names arrive mangled, so the build fails
REM  minutes in with a confusing error. 65001 keeps them intact.
chcp 65001 >nul
cd /d "%~dp0"
REM  Tests print Chinese; their output goes to log files (see 2.5), so make
REM  Python write UTF-8 there instead of cp950 (cp950 cannot encode every char).
set "PYTHONIOENCODING=utf-8"
set "PYTHONUTF8=1"

echo [繫族 build] working dir: %CD%

REM --- 1) build_venv: reuse it only if its Python is supported ----------------
REM  pyinstaller==6.10.0 needs Python < 3.14; pythonnet 3.1.0 / clr_loader 0.3.1
REM  need >= 3.10. A bare "py -3" picks the NEWEST Python (3.14 on a fresh PC)
REM  and pip then fails at "installing pyinstaller" (health check release-7).
REM  It must also be 64-bit x64 (sysconfig platform win-amd64): a 32-bit or
REM  ARM64 Python builds an exe that make_zip still names "win-x64".
if exist "build_venv\Scripts\python.exe" goto :check_venv

REM  Pick a supported Python: ask the py launcher what is INSTALLED (py -0p)
REM  instead of trying "py -3.13": the new Python install manager may offer to
REM  download a missing version, which would hang here with output hidden.
REM  3.12 first (the version the release builds are verified with).
REM  Only 64-bit entries count: new launcher lists them as "-V:3.12" (32-bit /
REM  ARM64 are "-V:3.12-32" / "-V:3.12-arm64"), the old one as "-3.12-64".
REM  Run "py -0p" once on its own first ("call": still returns here if py is a
REM  .bat): when the command on the LEFT of a pipe cannot be run, cmd aborts
REM  the whole batch on the spot (exit 255, no message), so a PC without the py
REM  launcher would never reach the fallback below. ("where py" is not enough:
REM  it also finds a py.bat in the current folder, which cmd will not run when
REM  NoDefaultCurrentDirectoryInExePath is set.) "<nul": with its output hidden
REM  here, a first-run question from the launcher must not wait for a key.
REM >>> pick-python  (tests\test_g9_build_onboarding.py runs this block alone)
set "PYEXE="
call py -0p >nul 2>nul <nul
if not errorlevel 1 (
    for %%V in (3.12 3.13 3.11 3.10) do (
        if not defined PYEXE (
            py -0p 2>nul <nul | findstr /l /c:"-V:%%V " /c:"-V:%%V-64 " /c:" -%%V-64" >nul 2>nul && set "PYEXE=py -%%V"
        )
    )
)
REM  "call python": the python on PATH may be a .bat shim (pyenv-win). Without
REM  "call" cmd hands control to that .bat and never comes back: this script
REM  would end right here with exit code 0 and no message at all.
if not defined PYEXE (
    call python -c "import sys, sysconfig; sys.exit(0 if (3, 10) <= sys.version_info[:2] <= (3, 13) and sysconfig.get_platform() == 'win-amd64' else 1)" >nul 2>nul && set "PYEXE=python"
)
REM <<< pick-python
if not defined PYEXE goto :no_python
echo [繫族 build] python launcher: !PYEXE!
echo [繫族 build] creating venv build_venv ...
call !PYEXE! -m venv build_venv
if errorlevel 1 goto :build_failed
goto :venv_ready

:check_venv
"build_venv\Scripts\python.exe" -c "import sys, sysconfig; sys.exit(0 if (3, 10) <= sys.version_info[:2] <= (3, 13) and sysconfig.get_platform() == 'win-amd64' else 1)" >nul 2>nul
if errorlevel 1 goto :bad_venv
echo [繫族 build] reusing existing build_venv

:venv_ready
set "VENV_PY=build_venv\Scripts\python.exe"

REM --- 2) upgrade pip + install runtime deps + pyinstaller -----------------
REM  -c constraints.txt pins EVERY package (pythonnet, clr_loader, bottle,
REM  PyInstaller's own deps ...), not just the two in requirements.txt, so a
REM  rebuild on another PC bundles exactly the same code (release-7).
echo [繫族 build] upgrading pip ...
"%VENV_PY%" -m pip install --upgrade pip
if errorlevel 1 goto :build_failed

echo [繫族 build] installing requirements.txt (pinned by constraints.txt) ...
"%VENV_PY%" -m pip install -r requirements.txt -c constraints.txt
if errorlevel 1 goto :build_failed

echo [繫族 build] installing pyinstaller ...
"%VENV_PY%" -m pip install pyinstaller==6.10.0 -c constraints.txt
if errorlevel 1 goto :build_failed

REM --- 2.5) run ALL backend tests BEFORE packaging (fail-fast) --------------
REM  tests\*.py: stdlib-only, offline, temp DB. Any failure aborts the build.
REM  Deliberately a wildcard sweep, not a hand-kept list: a new tests\test_*.py
REM  is picked up automatically (a hand-kept list once let test_r3_lunar rot).
REM  The third pattern is an optional maintainer-only folder (tools\ is
REM  gitignored); a public clone does not have it, so it expands to nothing.
REM  tests\ itself is maintainer-only too (not in the public source since
REM  2026-10-12): every pattern is a wildcard so a public clone still builds,
REM  and the SKIP summary at the end says no test checked that build.
REM  Each test's output is also kept in build_venv\test-logs\: lines starting
REM  with "SKIP " (no node, no Edge, ...) are collected and listed again at the
REM  end, so nobody mistakes "skipped" for "verified".
REM  cmd has no "tee": TEE_PY runs one test unbuffered, shows its output in this
REM  window AS IT RUNS (a hung test still shows how far it got) and copies the
REM  same bytes to the log; its exit code is the test's.
REM >>> run-tests  (tests\test_l2_build_skip_summary.py runs this block alone)
set "TEST_LOGS=build_venv\test-logs"
set "SKIPPED=%TEST_LOGS%\skipped.txt"
set "TEE_PY=import subprocess as s, sys; p = s.Popen([sys.executable, '-u', sys.argv[1]], stdout=s.PIPE, stderr=s.STDOUT); f = open(sys.argv[2], 'wb'); [(sys.stdout.buffer.write(b), sys.stdout.flush(), f.write(b), f.flush()) for b in p.stdout]; f.close(); sys.exit(p.wait())"
if exist "%TEST_LOGS%" rmdir /s /q "%TEST_LOGS%"
mkdir "%TEST_LOGS%"
type nul > "%SKIPPED%"
if not exist "tests\" echo   tests\ is not in the public source - NO test checked this build.>> "%SKIPPED%"
for %%T in (tests\smoke*.py tests\test_*.py tools\內部測試\test_*.py) do (
    echo [繫族 build] running %%T ...
    "%VENV_PY%" -c "%TEE_PY%" "%%T" "%TEST_LOGS%\%%~nT.log"
    set "TEST_RC=!ERRORLEVEL!"
    findstr /b /l /c:"SKIP " "%TEST_LOGS%\%%~nT.log" >nul 2>nul && (
        echo   %%T>> "%SKIPPED%"
        findstr /b /l /c:"SKIP " "%TEST_LOGS%\%%~nT.log" >> "%SKIPPED%"
    )
    if not "!TEST_RC!"=="0" (
        echo [繫族 build] ERROR: %%T failed - packaging aborted.
        goto :build_failed
    )
)
REM <<< run-tests

REM --- 2.6) optional maintainer step: regenerate a docs page -----------------
REM  Runs only when the maintainer-only script exists (tools\ is gitignored,
REM  so a public clone skips this silently). Non-fatal: never blocks the exe.
if exist "tools\產生交接網頁.py" echo [繫族 build] regenerating maintainer docs page ...
if exist "tools\產生交接網頁.py" "%VENV_PY%" "tools\產生交接網頁.py" || echo [繫族 build] WARN: maintainer docs page not regenerated.

REM --- 3) clean previous output (avoid stale "fake success" EXE) -----------
echo [繫族 build] cleaning old build/ and dist/ ...
if exist "build" rmdir /s /q "build"
if exist "build_venv\pyi-build" rmdir /s /q "build_venv\pyi-build"
if exist "dist\繫族.exe" del /q "dist\繫族.exe"

REM --- 4) run PyInstaller against the spec ---------------------------------
REM  errorlevel check must come right after pyinstaller (echo. resets it).
echo [繫族 build] running PyInstaller (onefile, no console) ...
"%VENV_PY%" -m PyInstaller --noconfirm --clean --workpath "build_venv\pyi-build" "繫族.spec"
if errorlevel 1 goto :build_failed

REM --- 5) verify the artifact actually exists ------------------------------
if not exist "dist\繫族.exe" (
    echo [繫族 build] ERROR: dist\繫族.exe was not produced.
    goto :build_failed
)

REM --- 5.2) actually START the packaged exe once: 繫族.exe --selftest --------
REM  The tests above run from source, so a broken bundle (a data folder or a
REM  lazy import PyInstaller missed) used to pass and print BUILD SUCCESS
REM  (health check release-10). --selftest builds a throw-away database in
REM  %TEMP%, starts the local server, fetches the pages and a few APIs, opens
REM  no window, never touches dist\繫族.db, and exits 0 only if all passed.
REM  The exe has no console, so it writes its report to a file we print here.
REM  "start /wait" makes cmd wait for a no-console exe and returns its exit code.
REM >>> selftest  (tests\test_m4_selftest.py runs this block alone)
set "SELFTEST_LOG=%CD%\build_venv\selftest.log"
if exist "%SELFTEST_LOG%" del /q "%SELFTEST_LOG%"
echo [繫族 build] self-test: dist\繫族.exe --selftest ...
start "" /wait "dist\繫族.exe" --selftest "%SELFTEST_LOG%"
set "SELFTEST_RC=!ERRORLEVEL!"
if exist "%SELFTEST_LOG%" type "%SELFTEST_LOG%"
if not "!SELFTEST_RC!"=="0" (
    echo [繫族 build] ERROR: dist\繫族.exe --selftest failed, exit code !SELFTEST_RC! - do NOT ship this exe.
    goto :build_failed
)
REM <<< selftest

REM --- 5.5) release files: dist\kinlink-v<VERSION>-win-x64.zip and .exe -------
REM  Browsers / corporate networks often block a bare .exe download; a zip
REM  (exe + readme txt + LICENSE + THIRD-PARTY-NOTICES.txt) gets through.
REM  The same exe is also copied under an ASCII name: the in-app updater only
REM  picks a release asset ending in .exe, so a zip-only release never updates.
REM  Stdlib only, reproducible.
"%VENV_PY%" "release\make_zip.py" || echo [繫族 build] WARN: zip / release exe not produced.

echo.
echo ============================================================
echo  [繫族 build] BUILD SUCCESS
echo  Output : %CD%\dist\繫族.exe
echo  Upload BOTH files below to the GitHub Release:
echo    %CD%\dist\kinlink-v^<VERSION^>-win-x64.zip  (people download this by hand)
echo    %CD%\dist\kinlink-v^<VERSION^>-win-x64.exe  (the in-app updater needs this)
echo  Hint   : if Windows SmartScreen blocks it, right-click ^>
echo           Properties ^> Unblock (clears Mark-of-the-Web).
echo ============================================================
call :show_skipped
goto :done

REM  The Chinese help texts are UTF-8 .txt files printed with "type": Chinese
REM  "echo" lines here were mis-read by cmd (see NOTE at the top). The English
REM  line after "||" only shows if the .txt itself is missing.
:no_python
echo.
type "release\build-help-no-python.txt" 2>nul || echo [繫族 build] ERROR: no supported Python found - install 64-bit Python 3.12 from python.org, then run build_exe.bat again.
goto :build_failed

:bad_venv
echo.
type "release\build-help-bad-venv.txt" 2>nul || echo [繫族 build] ERROR: build_venv uses an unsupported Python - delete the build_venv folder, then run build_exe.bat again.
goto :build_failed

REM >>> show-skipped
:show_skipped
REM  Summary of skipped tests (L-2): printed on success AND failure.
if not defined SKIPPED goto :eof
if not exist "%SKIPPED%" goto :eof
for %%S in ("%SKIPPED%") do if %%~zS==0 (
    echo  Skipped tests: none - every test ran in full.
    goto :eof
)
echo  Tests SKIPPED in this build - these parts were NOT verified:
type "%SKIPPED%"
echo  Re-run them where node / Edge is available, or check those parts by hand.
goto :eof
REM <<< show-skipped

:build_failed
echo.
echo ============================================================
echo  [繫族 build] BUILD FAILED  (see messages above)
echo ============================================================
call :show_skipped
endlocal
exit /b 1

:done
endlocal
exit /b 0
