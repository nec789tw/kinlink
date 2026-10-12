# -*- mode: python ; coding: utf-8 -*-
#
# 繫族 (KinLink) ｜ PyInstaller 打包設定（onefile，單一 繫族.exe）
#
# 打包原則（參考既有可複用模式）：
#   * 進入點 app.py：起本機 http.server（只綁 127.0.0.1、帶隨機 token）後，
#     用 pywebview 開系統內建 WebView2 原生視窗，純載入本機網址。
#   * 不打包 Chromium：WebView2 (Edge Chromium) 引擎由作業系統提供，故 exe 小。
#     真正要收進來的是 pywebview 走 .NET 互通用到的 pythonnet / clr_loader。
#   * onefile 的關鍵理由是 MOTW（Mark-of-the-Web）：onedir 散落的 DLL 在使用者
#     從 zip 解壓後會繼承 MOTW，.NET 會拒載被標記的組件 → pywebview 靜默退回 Edge。
#     onefile 執行期把 DLL 解到 %TEMP%（無 MOTW），使用者只需 Unblock 一個 .exe。
#   * 前端 webview/ 刻意改名打包成 webview_assets/，避免與 pywebview 的 python
#     套件名 webview/ 在 _MEIPASS 內撞名（app.py 解析資產目錄時須對應此名）。
#   * 列印範本/（六種制式列印 HTML + 共用 CSS）整夾帶入，供瀏覽器原生列印/另存 PDF。
#   * console=False：不開主控台黑窗；icon 同時帶入執行期可讀路徑。
#
# 建置：見 build_exe.bat（或手動 pyinstaller 繫族.spec）。輸出 dist/繫族.exe。

import os

block_cipher = None

# spec 檔所在目錄即專案根目錄（PyInstaller 會把 spec 路徑放進 SPECPATH）
PROJ = os.path.abspath(SPECPATH)

# === 資料檔（來源, 解壓後相對目的）===
# Windows 上 PyInstaller datas 以 (src, dest) tuple 表示，dest 為解壓後相對資料夾。
datas = [
    # 前端靜態資源：來源 webview/，刻意改名為 webview_assets/ 避免與 pywebview 套件撞名
    (os.path.join(PROJ, 'webview'), 'webview_assets'),
    # 列印範本：版式示範、操作手冊、交接單 HTML + 共用列印 CSS（assets/print.css）
    (os.path.join(PROJ, '列印範本'), '列印範本'),
    # 版本單一來源（發版只改 VERSION 檔）：kinlink/paths.py 於凍結時自 _MEIPASS 讀 VERSION
    (os.path.join(PROJ, 'VERSION'), '.'),
]

# 程式圖示（若存在才帶入；執行期 WM_SETICON 與打包 exe 圖示共用）
_icon_path = os.path.join(PROJ, 'webview', 'assets', 'icon.ico')
if not os.path.exists(_icon_path):
    _icon_path = os.path.join(PROJ, 'assets', 'icon.ico')
if os.path.exists(_icon_path):
    datas.append((_icon_path, '.'))
else:
    _icon_path = None  # 沒有圖示就讓 EXE(icon=None) 用預設

# === 隱藏匯入 ===
# pywebview 走 .NET (pythonnet/clr) + WinForms 宿主開 WebView2，動態 import 的
# 平台後端模組 PyInstaller 靜態分析抓不到，須明列；缺則執行期 ImportError 並退回 Edge。
hiddenimports = [
    'webview',
    'webview.platforms.edgechromium',  # WebView2 後端
    'webview.platforms.winforms',      # WinForms 宿主
    'clr',
    'clr_loader',
    'pythonnet',
    'proxy_tools',
    'bottle',
    'borax.calendars.lunardate',       # 農曆換算（查表，離線；MIT 授權）
    # pkg_resources（被 pythonnet/setuptools 牽連）的 runtime hook 需要這些，缺則啟動即崩
    'jaraco.text', 'jaraco.functools', 'jaraco.context', 'jaraco.collections',
    'more_itertools', 'importlib_metadata',
]

# pywebview / .NET 互通的資料與子模組一網打盡（collect_all 等同 .bat 的 --collect-all）
from PyInstaller.utils.hooks import collect_all

for _pkg in ('webview', 'pythonnet', 'clr_loader'):
    _d, _b, _h = collect_all(_pkg)
    datas += _d
    # 二進位（_b）與隱藏匯入（_h）併入下方 Analysis
    hiddenimports += _h

binaries = []
for _pkg in ('webview', 'pythonnet', 'clr_loader'):
    _d, _b, _h = collect_all(_pkg)
    binaries += _b

a = Analysis(
    ['app.py'],                        # 進入點
    pathex=[PROJ],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # 排除重量級且本專案用不到的套件以縮小體積、加快啟動
    excludes=[
        'tkinter', 'numpy', 'pandas', 'scipy', 'PIL',
        'torch', 'torchvision', 'torchaudio', 'transformers',
        'matplotlib', 'pytest', 'setuptools', 'pip',
        # collect_all('webview') 會連帶收進 webview.__pyinstaller（打包用 hook）
        # 與它 import 的 PyInstaller 模組；那些是 GPL、不在 bootloader 例外內，
        # 執行期也用不到，排除才不會把 GPL 程式碼散布進 MIT 的 exe。
        'PyInstaller', 'webview.__pyinstaller',
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

# onefile：把 a.binaries / a.datas / a.zipfiles 全包進單一 EXE
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='繫族',                       # 產物名 → 繫族.exe
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,                         # 不壓縮，避免部分 .NET DLL 被 UPX 弄壞
    upx_exclude=[],
    runtime_tmpdir=None,               # 解到系統 %TEMP%（無 MOTW）
    console=False,                     # 不開主控台黑窗
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=_icon_path,                   # 無圖示時為 None，使用預設
)
