# -*- coding: utf-8 -*-
"""路徑與版本解析：前端資產／列印範本／資料庫位置（原 server.py）。"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path


APP_NAME = "繫族 KinLink"       # 與前端 <title> 一致，供視窗層 FindWindow 套裝飾


def _read_version() -> str:
    """讀取專案根 VERSION 檔（版本單一來源：發版只改 VERSION 一處）。

    發版只改 VERSION 一處：server.py（本函式）、關於頁（GET /api/state 帶出）、
    繫族.spec（datas 收入 VERSION）皆讀同一檔，杜絕三處手動同步漂移。
    候選路徑：凍結（PyInstaller onefile）時在解壓根 ``sys._MEIPASS``（spec 已
    datas 收入）、exe 同層；原始碼模式在本檔同層。讀不到時回退 '0.0.0'——
    寧可顯示明顯錯誤的版本，也不讓啟動失敗。
    """
    candidates = []
    if getattr(sys, "frozen", False):
        candidates.append(Path(getattr(sys, "_MEIPASS", "")) / "VERSION")
        candidates.append(Path(sys.executable).resolve().parent / "VERSION")
    # 本檔在 kinlink/ 子目錄（2026-08-20 拆模組），專案根＝上一層
    candidates.append(Path(__file__).resolve().parent.parent / "VERSION")
    for c in candidates:
        try:
            if c.is_file():
                v = c.read_text(encoding="utf-8-sig").strip()
                if v:
                    return v
        except OSError:
            continue
    return "0.0.0"


APP_VERSION = _read_version()


def resolve_web_dir() -> Path:
    """
    解析前端靜態資產目錄。

    * 凍結（PyInstaller --onefile / --onedir）：解壓根目錄 ``sys._MEIPASS`` 下，
      優先找 ``webview_assets/``（打包時刻意改名，避免與 pywebview 套件自身的
      ``webview/`` 目錄撞名），找不到才退回 ``webview/``。
    * 原始碼模式：專案根（kinlink/ 上一層）的 ``webview/``。

    找不到任何候選時，回傳原始碼模式的預設路徑（即使尚不存在），呼叫端再
    自行處理 404，避免在此硬性中止。
    """
    candidates = []
    if getattr(sys, "frozen", False):
        base = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
        candidates.append(base / "webview_assets")
        candidates.append(base / "webview")
    here = Path(__file__).resolve().parent.parent   # kinlink/ 上一層＝專案根
    candidates.append(here / "webview")
    candidates.append(here / "webview_assets")

    for c in candidates:
        if c.is_dir():
            return c
    return here / "webview"


WEB_DIR = resolve_web_dir()


def resolve_print_dir() -> Path:
    """
    解析「列印範本/」目錄（webview/ 的兄弟目錄，不在靜態根內）。

    * 凍結（PyInstaller）：繫族.spec 已把 列印範本/ 打進 ``sys._MEIPASS``。
    * 原始碼模式：專案根（kinlink/ 上一層）的 ``列印範本/``。

    供 ``_static()`` 的白名單路由 ``/列印範本/*`` 解析實體路徑，
    讓列印頁的版式示範卡、交接單與「關於」頁的操作手冊在 web/exe 模式可達。
    """
    if getattr(sys, "frozen", False):
        base = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    else:
        base = Path(__file__).resolve().parent.parent   # kinlink/ 上一層＝專案根
    return base / "列印範本"


def resolve_db_path() -> Path:
    """
    解析 SQLite 資料庫檔位置，遵循「可攜」原則（插隨身碟即帶著走）：

      * 凍結（PyInstaller onefile）：放在「exe 同層目錄」（非解壓暫存區，否則
        關機即失），檔名 ``繫族.db``。
      * 原始碼模式：放在專案根（kinlink/ 上一層），即開發用的 ``繫族.db``。
    """
    if getattr(sys, "frozen", False):
        base = Path(sys.executable).resolve().parent
    else:
        base = Path(__file__).resolve().parent.parent   # kinlink/ 上一層＝專案根
    return base / "繫族.db"


def is_temp_location(folder, temp_dir=None) -> bool:
    """exe 所在資料夾是不是「會被清掉的暫存區」（體檢 release-4；app.py 啟動時擋下）。

    在檔案總管裡直接點開 zip、再雙擊裡面的 繫族.exe，Windows 會先把 exe 解到
    %TEMP%\\Temp1_xxx.zip\\ 再執行——資料庫、備份就跟著建在暫存區，清暫存就全沒了。
    兩條規則任一成立即為 True（比對前 abspath＋normpath，大小寫不敏感）：
      1. 位於暫存目錄（預設 tempfile.gettempdir()）「底下」。刻意不含「等於暫存目錄本身」：
         gettempdir() 找不到可寫的暫存區時會退回目前目錄（＝exe 旁），相等就擋會讓程式
         永遠開不起來；解壓工具一律另開子資料夾（Temp1_*.zip、7z*、Rar$*），不受影響。
         暫存目錄若是磁碟根目錄（TEMP=C:\\）也不套用，免得整顆磁碟都被當暫存。
      2. 路徑中有資料夾名稱以 .zip 結尾（Temp1_xxx.zip 這類「從 zip 執行」的痕跡）。
    realpath 只為把 8.3 短檔名（C:\\Users\\ABCDEF~1\\...）展開成長檔名再比對；不寫任何檔。
    """
    def _norm(p) -> str:
        return os.path.normcase(os.path.normpath(os.path.abspath(str(p)))).lower()

    f = _norm(folder)
    fr = _norm(os.path.realpath(str(folder)))
    tmp = tempfile.gettempdir() if temp_dir is None else temp_dir
    for t in {_norm(tmp), _norm(os.path.realpath(str(tmp)))}:
        if os.path.dirname(t) == t:            # 磁碟根目錄
            continue
        prefix = t.rstrip("\\/") + os.sep
        if f.startswith(prefix) or fr.startswith(prefix):
            return True
    parts = Path(f).parts[1:]                  # [0] 是磁碟機（C:\\），不算資料夾名稱
    return any(p.endswith(".zip") for p in parts)
