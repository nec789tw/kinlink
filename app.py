# -*- coding: utf-8 -*-
"""
繫族 KinLink ｜ 程式進入點 / 啟動器
====================================================================
動線（main()，全部在「開窗前」完成）：
    1. 前置：宣告 DPI 感知（高解析度螢幕不被虛擬化縮小）、設定工作列識別。
       exe 若在暫存區（從 zip 直接執行）→ 訊息框說明後結束（結束碼 3），不建資料庫。
    2. 後端模組載入失敗 → 訊息框說明後結束（結束碼 2）。
    3. init_db()：建立／開啟 exe 旁（原始碼模式為專案根）的 SQLite 資料庫（WAL 模式）；
       失敗（資料夾不可寫、被占用…）→ 訊息框說明後結束（結束碼 4）。
       接著啟動自動備份；seed_if_empty()：全新資料庫才灌入楊家虛構示範資料。
    4. start_server()：起本機 HTTP 伺服器，只綁 127.0.0.1、OS 配隨機空閒埠、
       附隨機 token；外部連不到、不觸發防火牆提示。起不來 → 訊息框說明後結束（結束碼 5）。
    5. open_window()：用 pywebview 開原生 WebView2 視窗，指向
       http://127.0.0.1:<port>/?k=<token>；視窗關閉即返回。
       - 沒有 WebView2 或 pywebview 不可用 → fallback 開系統預設瀏覽器；exe 沒有主控台，改跳
         「用完請按確定結束」訊息框當關閉鈕（原始碼在主控台跑時仍是按 Enter）。
    6. 收網：停掉伺服器、釋放埠，行程結束。
    失敗一律用中文訊息框說明原因與做法，不丟英文 traceback（exe 沒有主控台，stderr 看不到）。
    另：``繫族.exe --selftest [報告檔]`` 是打包驗收（build_exe.bat 用），見 selftest()。

設計原則：務實、最少相依、離線可跑。後端邏輯（/api/*、SQLite）在 kinlink/ 套件，
由 server.py 這個薄門面轉出；本檔只負責「啟動順序、視窗、收網」，與傳輸/業務解耦。

對外（給其他檔對接）：
    - main()                  程式進入點（python app.py）。
    - APP_NAME / APP_VERSION  視窗標題與版本字串。
    - build_url(host,port,token) 組出帶 token 的本機網址。
    - open_window(url) / open_in_browser(url)  視窗 / 瀏覽器 fallback。
本檔不直接碰 SQLite，一律透過 server.py 的介面（見下方 import 區）。
"""

from __future__ import annotations

import sys
import os
import webbrowser

# ── 應用識別 ──────────────────────────────────────────────
APP_NAME = "繫族 KinLink"          # 視窗標題（前端 <title> 亦同，利於 fallback 找 HWND）
APP_VERSION = "0.0.0"              # 後備值；下方載入 server 後以 VERSION 檔（單一來源）覆寫

# 視窗預設尺寸（桌面 / 平板友善；小於此值不利於樹狀圖）
WIN_W, WIN_H = 1180, 780
WIN_MIN_W, WIN_MIN_H = 920, 600


# ── 後端介面（server.py 薄門面，邏輯在 kinlink/）──────────────
# 本檔對 server.py 的依賴契約（只要 server.py 提供下列名稱即可）：
#   - init_db() -> None                建表（IF NOT EXISTS）並啟用 WAL；冪等。
#   - auto_backup() -> str             啟動自動備份（backups\自動備份_日期.db）。
#   - seed_if_empty() -> bool          全新資料庫才灌示範資料，回傳是否實際 seed。
#   - resolve_db_path() -> Path        資料庫位置（訊息框顯示用）。
#   - start_server(host='127.0.0.1', port=0, token=None)
#         -> server 物件，需具備：.host .port .token .stop() 三者；
#            port=0 由 OS 配埠、token=None 時內部以 secrets 產生隨機 token。
# 載入失敗時不在 import 階段炸掉：記下錯誤，由 main() 用訊息框說明（exe 沒有主控台）。
_BACKEND_IMPORT_ERROR = None
try:
    import server as _backend  # type: ignore
    _HAS_BACKEND = True
except Exception as _e:  # pragma: no cover - 後端尚未就緒時的保險絲
    _backend = None
    _HAS_BACKEND = False
    _BACKEND_IMPORT_ERROR = _e

# 版本單一來源（發版只改 VERSION 檔）：以 server.py（kinlink/paths.py 讀 VERSION）為準，
# 本檔不再自持版本字串；後端缺席時保留上方預設值即可。
if _HAS_BACKEND:
    APP_VERSION = getattr(_backend, "APP_VERSION", APP_VERSION)


# ── DPI 感知（Windows）────────────────────────────────────
def _enable_dpi_awareness() -> None:
    """
    宣告 Per-Monitor-V2 DPI 感知，避免 2K/4K + 125%/150% 縮放時
    被 Windows DPI 虛擬化把視窗縮糊縮小。三層 fallback。
    非 win32 一律靜默略過。必須在開任何視窗「前」呼叫。
    """
    if sys.platform != "win32":
        return
    import ctypes
    try:
        # -4 = DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
        # 64 位下必須包成 c_void_p，直接傳 int 會被截斷成無效值。
        ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
        return
    except Exception:
        pass
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # PROCESS_PER_MONITOR_DPI_AWARE
        return
    except Exception:
        pass
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass


def _set_app_user_model_id() -> None:
    """設獨立 AppUserModelID，讓工作列圖示不與 python.exe 共用。"""
    if sys.platform != "win32":
        return
    try:
        import ctypes
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("kinlink.app")
    except Exception:
        pass


# ── WebView2 偵測 ─────────────────────────────────────────
def webview2_available() -> bool:
    """
    啟動前主動偵測系統是否有 WebView2 Runtime。
    缺 Runtime 時 pywebview 會「開出空白視窗但不丟例外、webview.start() 不返回」，
    導致 try/except 永遠接不到、fallback 不觸發、使用者卡在壞掉的空白窗。
    故改查官方註冊表鍵（三處），pv 非空且非 '0.0.0.0' 才算有。
    非 win32 直接回 False（交給瀏覽器 fallback）。
    """
    if sys.platform != "win32":
        return False
    import winreg

    key_path = (
        r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients"
        r"\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
    )
    key_path_native = (
        r"SOFTWARE\Microsoft\EdgeUpdate\Clients"
        r"\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
    )
    probes = [
        (winreg.HKEY_LOCAL_MACHINE, key_path),
        (winreg.HKEY_LOCAL_MACHINE, key_path_native),
        (winreg.HKEY_CURRENT_USER, key_path_native),
    ]
    for root, path in probes:
        try:
            with winreg.OpenKey(root, path) as k:
                pv, _ = winreg.QueryValueEx(k, "pv")
                if pv and pv != "0.0.0.0":
                    return True
        except OSError:
            continue
    return False


# ── 視窗 / 瀏覽器 ─────────────────────────────────────────
def build_url(host: str, port: int, token: str | None) -> str:
    """組出帶 token 的本機網址：http://host:port/?k=token"""
    base = f"http://{host}:{port}/"
    return f"{base}?k={token}" if token else base


def open_window(url: str) -> bool:
    """
    主路徑：用 pywebview 開原生 WebView2 視窗純載入網址（不使用 js_api，
    避免 pythonnet 序列化的遞迴死鎖；前端一律走本機 HTTP）。
    成功（視窗正常開啟並關閉）回 True；pywebview 不可用回 False 交給 fallback。
    webview.start() 會阻塞至視窗關閉。
    """
    try:
        import webview  # pywebview
    except Exception:
        return False

    try:
        # 原生 WebView2 預設 ALLOW_DOWNLOADS=False 會「靜默取消」<a download>，
        # 導致匯出 / 備份下載按鈕沒反應；務必打開。
        try:
            webview.settings["ALLOW_DOWNLOADS"] = True
        except Exception:
            pass

        webview.create_window(
            APP_NAME,
            url,
            width=WIN_W,
            height=WIN_H,
            min_size=(WIN_MIN_W, WIN_MIN_H),
        )
        _set_window_icon_async()
        webview.start()  # 阻塞至關窗
        return True
    except Exception as e:
        print(f"[繫族] 原生視窗開啟失敗，改用瀏覽器：{e}", file=sys.stderr)
        return False


def open_in_browser(url: str) -> None:
    """fallback：開系統預設瀏覽器。此路徑不阻塞，由 main() 等待使用者手動關閉。"""
    print(f"[繫族] 以預設瀏覽器開啟：{url}")
    webbrowser.open(url)


def _print_no_pywebview_hint() -> None:
    """pywebview 缺失時的友善提示。"""
    print(
        "[繫族] 未偵測到 pywebview（或系統缺少 WebView2 Runtime），"
        "改以系統預設瀏覽器開啟。\n"
        "       若要原生視窗體驗，請安裝： pip install pywebview\n"
        "       並確認已安裝 Microsoft Edge WebView2 Runtime。",
        file=sys.stderr,
    )


def _resolve_icon() -> str:
    """找 icon.ico：凍結時在 _MEIPASS／exe 同層，原始碼時在 webview/assets。"""
    cands = []
    if getattr(sys, "frozen", False):
        cands.append(os.path.join(getattr(sys, "_MEIPASS", ""), "icon.ico"))
        cands.append(os.path.join(os.path.dirname(sys.executable), "icon.ico"))
    here = os.path.dirname(os.path.abspath(__file__))
    cands.append(os.path.join(here, "webview", "assets", "icon.ico"))
    for c in cands:
        if c and os.path.exists(c):
            return c
    return ""


def _set_window_icon_async() -> None:
    """原生視窗：win32 WM_SETICON 套用 app 圖示（exe 由 PyInstaller spec 另帶入）。"""
    if sys.platform != "win32":
        return
    ico = _resolve_icon()
    if not ico:
        return
    import threading
    import time

    def _worker():
        import ctypes
        user32 = ctypes.windll.user32
        WM_SETICON = 0x0080
        flags = 0x00000010 | 0x00000040  # LR_LOADFROMFILE | LR_DEFAULTSIZE
        for _ in range(60):  # 最多等 ~6 秒待視窗出現
            hwnd = user32.FindWindowW(None, APP_NAME)
            if hwnd:
                h = user32.LoadImageW(None, ico, 1, 0, 0, flags)  # IMAGE_ICON
                if h:
                    user32.SendMessageW(hwnd, WM_SETICON, 0, h)  # ICON_SMALL
                    user32.SendMessageW(hwnd, WM_SETICON, 1, h)  # ICON_BIG
                return
            time.sleep(0.1)

    threading.Thread(target=_worker, daemon=True).start()


# ── 從 zip／暫存區啟動的攔截（體檢 release-4）───────────────
TEMP_LOCATION_MSG = (
    "繫族 KinLink 現在是從「壓縮檔（zip）裡面」或「暫存資料夾」直接開啟的。\n"
    "這樣資料會存進 Windows 的暫存區，之後可能被系統清掉而全部不見，所以先不開啟。\n\n"
    "請這樣做：\n"
    "1. 按「確定」關閉這個視窗。\n"
    "2. 在下載的 zip 檔上按右鍵 →「全部解壓縮」，解壓到隨身碟、桌面或其他資料夾。\n"
    "3. 開啟解壓後資料夾裡的 繫族.exe。\n\n"
    "目前位置：{folder}"
)


MB_ICONWARNING = 0x00000030      # MB_OK | 驚嘆號
MB_ICONINFORMATION = 0x00000040  # MB_OK | 資訊圖示


def _message_box(text: str, title: str, flags: int) -> int:
    """Windows 訊息框（阻塞到使用者按下按鈕）。回傳 MessageBoxW 的結果（按「確定」＝1）；
    非 Windows 或叫不出來回 0。測試一律把它換成替身，不會真的跳視窗。"""
    if sys.platform != "win32":
        return 0
    try:
        import ctypes
        return int(ctypes.windll.user32.MessageBoxW(None, text, title, flags) or 0)
    except Exception:
        return 0


def _show_error_box(title: str, text: str) -> None:
    """凍結模式沒有主控台（console=False），print 看不到；用 Windows 訊息框告訴使用者。"""
    print(f"[繫族] {text}", file=sys.stderr)
    _message_box(text, title, MB_ICONWARNING)


def _blocked_by_temp_location() -> bool:
    """凍結（exe）且 exe 在暫存區／zip 暫存路徑 → 跳說明並回 True（呼叫端結束、不建資料庫）。
    原始碼模式一律 False：工程師試跑的位置不受此限。"""
    if not getattr(sys, "frozen", False):
        return False
    try:
        from kinlink.paths import is_temp_location
    except Exception:   # 後端載入失敗由 main() 的 _HAS_BACKEND 檢查負責回報
        return False
    folder = os.path.dirname(os.path.abspath(sys.executable))
    if not is_temp_location(folder):
        return False
    _show_error_box(APP_NAME, TEMP_LOCATION_MSG.format(folder=folder))
    return True


# ── 啟動失敗的中文說明（體檢 release-3）──────────────────────
# 舊版 init_db／start_server 沒有 try：exe 放進 Program Files、隨身碟被鎖成唯讀、SD 卡防寫時，
# 只跳 PyInstaller 的英文 traceback；後端載入失敗則只印到看不見的 stderr，雙擊毫無反應。
DB_UNWRITABLE_MSG = (
    "這個資料夾無法寫入資料，繫族 KinLink 沒辦法開啟。\n\n"
    "常見原因：\n"
    "・放在 C:\\Program Files 這類系統資料夾裡（繫族不用安裝，放在隨身碟或桌面就能用）\n"
    "・隨身碟或 SD 卡被設成防寫（SD 卡側邊的小開關撥到 Lock），或公司、機關的電腦禁止寫入隨身碟\n"
    "・繫族.db 檔案被設成「唯讀」（在檔案上按右鍵 →「內容」，取消勾選「唯讀」）\n\n"
    "請這樣做：把整個繫族資料夾（繫族.exe 和旁邊的 繫族.db、backups 一起）"
    "複製到隨身碟、桌面或「文件」，再開那裡的 繫族.exe。\n\n"
    "資料位置：{where}\n"
    "錯誤原因：{err}"
)
DB_LOCKED_MSG = (
    "繫族 KinLink 的資料庫正被其他程式使用中，暫時無法開啟。\n\n"
    "可能是已經開著另一個繫族，或備份、雲端同步、防毒軟體正在讀取 繫族.db。\n"
    "請先關掉其他繫族視窗，等一兩分鐘後再開一次。\n\n"
    "資料位置：{where}\n"
    "錯誤原因：{err}"
)
DB_OPEN_FAIL_MSG = (
    "繫族 KinLink 開啟資料庫時發生錯誤，無法開啟。\n\n"
    "可能是資料庫檔案（繫族.db）損壞，或其他未預期的問題。請先不要刪除任何檔案，"
    "把這個視窗拍照或截圖，交給協助您的人處理；旁邊 backups 資料夾裡有每天自動備份的資料。\n\n"
    "資料位置：{where}\n"
    "錯誤原因：{err}"
)
SERVER_FAIL_MSG = (
    "繫族 KinLink 無法啟動（程式內部的本機連線服務開不起來）。\n\n"
    "可能是防毒軟體或電腦的安全設定擋住了本機連線（127.0.0.1）。請重新開機後再試一次；"
    "仍然不行，請把這個視窗拍照或截圖，交給協助您的人。\n\n"
    "錯誤原因：{err}"
)
BACKEND_BROKEN_MSG = (
    "繫族 KinLink 的程式檔不完整，無法開啟。\n\n"
    "請重新下載繫族的 zip 檔，在 zip 上按右鍵 →「全部解壓縮」，再用解壓出來的 繫族.exe "
    "取代這個資料夾裡的 繫族.exe。旁邊的 繫族.db 是您的資料，請保留不要刪。\n"
    "重新下載後還是一樣的話，請把這個視窗拍照或截圖，交給協助您的人。\n\n"
    "錯誤原因：{err}"
)
BACKEND_MISSING_SRC_MSG = (   # 原始碼模式（工程師試跑）：多半是還沒裝相依套件
    "找不到後端模組 server.py，或缺少相依套件，繫族 KinLink 無法開啟。\n\n"
    "請在專案資料夾執行：pip install -r requirements.txt，再重新啟動。\n\n"
    "錯誤原因：{err}"
)

# 「寫不進去」的特徵：PermissionError／唯讀媒體，以及 SQLite 的對應訊息
_UNWRITABLE_HINTS = ("readonly", "read-only", "unable to open database", "disk i/o error",
                     "access is denied", "存取被拒")
_LOCKED_HINTS = ("database is locked", "database is busy")


def _err_text(e: BaseException) -> str:
    return f"{type(e).__name__}: {e}"


def _db_location() -> str:
    try:
        return str(_backend.resolve_db_path())
    except Exception:
        return "（無法取得）"


def _db_open_error_msg(e: BaseException) -> str:
    """init_db 失敗 → 依原因挑一段中文說明（寫不進去／被占用／其他）。"""
    import errno
    low = str(e).lower()
    kw = {"where": _db_location(), "err": _err_text(e)}
    if (isinstance(e, PermissionError)
            or (isinstance(e, OSError) and e.errno in (errno.EACCES, errno.EPERM, errno.EROFS))
            or any(h in low for h in _UNWRITABLE_HINTS)):
        return DB_UNWRITABLE_MSG.format(**kw)
    if any(h in low for h in _LOCKED_HINTS):
        return DB_LOCKED_MSG.format(**kw)
    return DB_OPEN_FAIL_MSG.format(**kw)


# ── 主流程 ────────────────────────────────────────────────
def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else list(argv)
    # 0) 打包驗收（build_exe.bat：start /wait 繫族.exe --selftest 報告檔）：不開視窗、不碰 exe 旁的庫
    if "--selftest" in argv:
        i = argv.index("--selftest")
        report = argv[i + 1] if i + 1 < len(argv) and not argv[i + 1].startswith("--") else None
        return selftest(report)

    # 1) 前置：DPI 感知 + 工作列識別（開窗前）
    _enable_dpi_awareness()
    _set_app_user_model_id()

    # 1.5) 從 zip 直接執行（exe 被解到 %TEMP%）→ 擋下，連資料庫都不建（體檢 release-4）
    if _blocked_by_temp_location():
        return 3

    # 2) 後端就緒檢查：exe 沒有主控台，只印 stderr 等於雙擊毫無反應 → 訊息框說明
    if not _HAS_BACKEND:
        tpl = BACKEND_BROKEN_MSG if getattr(sys, "frozen", False) else BACKEND_MISSING_SRC_MSG
        _show_error_box(APP_NAME, tpl.format(err=_err_text(_BACKEND_IMPORT_ERROR)))
        return 2

    # 3) 初始化資料庫（建表 + WAL，冪等）；資料夾不可寫等狀況 → 中文說明後結束（體檢 release-3）
    try:
        _backend.init_db()
    except Exception as e:
        _show_error_box(APP_NAME, _db_open_error_msg(e))
        return 4

    # 3.5) 啟動時自動備份（規格 §5）：VACUUM INTO backups\自動備份_日期.db，
    #      僅保留最近 5 份。失敗不致命（如唯讀媒體），列印警語後照常啟動。
    try:
        _auto_backup = getattr(_backend, "auto_backup", None)
        if _auto_backup:
            print(f"[繫族] 已自動備份至 {_auto_backup()}")
    except Exception as e:
        print(f"[繫族] 啟動自動備份略過：{e}", file=sys.stderr)

    # 4) 首次啟動灌示範資料（成員表為空才做）
    try:
        seeded = _backend.seed_if_empty()
        if seeded:
            print("[繫族] 首次啟動，已載入楊家示範資料。")
    except Exception as e:
        # seed 失敗不致命，仍可開空族譜
        print(f"[繫族] 示範資料載入略過：{e}", file=sys.stderr)

    # 5) 起本機伺服器（只綁 127.0.0.1、OS 配埠、隨機 token）
    try:
        srv = _backend.start_server(host="127.0.0.1", port=0, token=None)
    except Exception as e:
        _show_error_box(APP_NAME, SERVER_FAIL_MSG.format(err=_err_text(e)))
        return 5
    url = build_url(srv.host, srv.port, srv.token)
    print(f"[繫族] 伺服器啟動於 {url}")

    try:
        # 6) 開視窗：先偵測 WebView2，有才走原生視窗，否則直接瀏覽器
        opened_native = False
        if webview2_available():
            opened_native = open_window(url)
            if not opened_native:
                _print_no_pywebview_hint()
                open_in_browser(url)
                _wait_for_user_exit()
        else:
            # 無 WebView2 Runtime：不嘗試原生視窗（會卡空白窗），直接瀏覽器
            _print_no_pywebview_hint()
            open_in_browser(url)
            _wait_for_user_exit()
    finally:
        # 7) 收網：停伺服器、釋放埠
        try:
            srv.stop()
        except Exception:
            pass
        print("[繫族] 已安全關閉，可拔除隨身碟。")
        # exe 沒有主控台時 sys.stdout／stderr 是 None（pywebview 沒載入就不會補上），
        # 直接 .flush() 會在收網最後一步丟 AttributeError、跳英文錯誤框
        for stream in (sys.stdout, sys.stderr):
            if stream is not None:
                try:
                    stream.flush()
                except Exception:
                    pass

    # 原生視窗模式下 webview.start() 已正常返回，這裡直接結束即可。
    return 0


BROWSER_MODE_MSG = (
    "繫族 KinLink 正在瀏覽器中執行。\n"
    "用完後請先關掉瀏覽器，再按這裡的「確定」結束繫族。\n\n"
    "（這台電腦缺少 Microsoft Edge WebView2 元件，或原生視窗打不開，所以改用瀏覽器。）\n\n"
    "按「確定」之前繫族都還在執行：請不要拔隨身碟，也還不能執行「套用更新」。\n"
    "按下「確定」後，瀏覽器裡的繫族頁面就不能再用；不小心按到的話，重新雙擊 繫族.exe 即可。"
)


def _wait_for_user_exit() -> None:
    """
    瀏覽器 fallback 模式下，主行程不能立即結束（否則伺服器隨之關閉、
    瀏覽器分頁變死頁）。等使用者表示用完，再收網退出：
      * 有主控台（python app.py 在命令列跑）→ 按 Enter 結束（原行為）。
      * 沒有主控台（exe 是 console=False；工程師試跑.bat 用 pythonw）→ 跳「用完請按確定」
        訊息框當關閉鈕，按下才返回。舊版在這裡 input() 立刻失敗後無限睡眠：程式永遠關不掉、
        提示也送不出去，套用更新等不到它結束（體檢 release-2／security-8／opensource-1）。
    """
    has_console = not getattr(sys, "frozen", False) and sys.stdin is not None
    if has_console:
        try:
            input("[繫族] 瀏覽器已開啟。完成後回到此視窗按 Enter 結束系統並安全退出…")
            return
        except (EOFError, KeyboardInterrupt):
            return
        except Exception:
            pass   # stdin 不能用（被關掉／重導失敗）→ 改走訊息框
    if _message_box(BROWSER_MODE_MSG, APP_NAME, MB_ICONINFORMATION):
        return
    # 訊息框叫不出來（非 Windows 且沒有主控台，非本程式的目標平台）：只能靜置等外部終止
    print("[繫族] 系統執行中。結束此行程即關閉系統。")
    import time
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass


# ── 打包驗收：繫族.exe --selftest（體檢 release-10）─────────────
# build_exe.bat 舊版只確認 exe 檔存在就印 BUILD SUCCESS，從沒實際啟動過；壞 exe（漏打包資料夾、
# 延遲 import 失敗）照樣發出去，套用更新又會立刻刪舊版。現在打包完用 start /wait 跑這個驗收。
SELFTEST_TIMEOUT = 120   # 秒；卡住就自行結束（回 9），免得 build 的 start /wait 永遠等下去


def _file_stamp(path):
    """(存在?, 大小, 修改時間)——驗收前後比對 exe 旁的 繫族.db 沒被碰過。"""
    try:
        st = os.stat(path)
        return (True, st.st_size, st.st_mtime_ns)
    except OSError:
        return (False, 0, 0)


def _native_window_check():
    """
    --selftest 用：把原生視窗要用的元件實際載入一次，回 (ok, 說明)；原始碼模式載不到回 (None, 原因)。
    只 import webview 抓不到漏打包：pythonnet／clr_loader 的 DLL 與 WebView2 組件要到建立視窗時才載入，
    缺了照樣 BUILD SUCCESS，總幹事一開就只剩瀏覽器模式。這裡載入 pywebview 的 WebView2 後端模組
    （會載入 .NET 互通層、WinForms 與 WebView2 組件，但不建立視窗、不寫登錄檔），
    再確認建立視窗時才用到的 WebView2Loader.dll 也有打包進去。
    """
    try:
        import webview.platforms.edgechromium  # noqa: F401,PLC0415 — 只載入組件，不開視窗
        from webview.util import interop_dll_path  # noqa: PLC0415
        arch = "win-x64" if sys.maxsize > 2 ** 32 else "win-x86"
        loader = os.path.join(interop_dll_path(arch), "WebView2Loader.dll")
        if not os.path.isfile(loader):
            raise FileNotFoundError("找不到 " + loader)
        return True, "WebView2Loader.dll：" + loader
    except Exception as e:  # noqa: BLE001 — pythonnet／.NET 的例外型別不一，一律記成失敗
        return (False if getattr(sys, "frozen", False) else None), _err_text(e)


def selftest(report=None) -> int:
    """
    打包驗收：在暫存資料夾建臨時庫（不碰 exe 旁的 繫族.db）、灌示範資料、起伺服器，
    實打首頁、列印頁與幾支 API；全過回 0，任一失敗回 1，逾時回 9。
    不開任何視窗、不跳訊息框；結果逐行寫進 report（exe 沒有主控台，print 看不到），
    有主控台時也印出來。暫存資料夾結束前清掉。
    """
    import json
    import shutil
    import tempfile
    import threading
    import urllib.parse
    import urllib.request

    lines = [f"{APP_NAME} {APP_VERSION} 打包自我檢查（--selftest）"]
    fails = []

    def log(ok, what, detail=""):
        lines.append(("PASS  " if ok else "FAIL  ") + what + (f"：{detail}" if detail else ""))
        if not ok:
            fails.append(what)

    def write_report(result):
        text = "\n".join(lines + [result]) + "\n"
        if report:
            try:
                with open(report, "w", encoding="utf-8") as f:
                    f.write(text)
            except OSError:
                pass
        if sys.stdout is not None:
            try:
                print(text, end="")
                sys.stdout.flush()
            except Exception:
                pass

    tmp = tempfile.mkdtemp(prefix="kinlink-selftest-")

    def on_timeout():
        log(False, f"逾時：{SELFTEST_TIMEOUT} 秒內沒有跑完（程式卡住）")
        write_report("結果：失敗（逾時）")
        shutil.rmtree(tmp, ignore_errors=True)
        os._exit(9)

    watchdog = threading.Timer(SELFTEST_TIMEOUT, on_timeout)
    watchdog.daemon = True
    watchdog.start()

    srv = None
    real_db = None
    real_before = None

    def get(path, auth=False):
        headers = {"Authorization": "Bearer " + srv.token} if auth and srv.token else {}
        url = "http://127.0.0.1:%d%s" % (srv.port, urllib.parse.quote(path, safe="/?=&"))
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=15) as r:
            return r.status, r.read()

    def check(what, fn):
        try:
            ok, detail = fn()
        except Exception as e:  # noqa: BLE001 — 任何例外都記成該項失敗，繼續驗下一項
            ok, detail = False, _err_text(e)
        log(ok, what, detail)

    try:
        if not _HAS_BACKEND:
            log(False, "載入後端模組（server.py 與 kinlink 套件）", _err_text(_BACKEND_IMPORT_ERROR))
            return 1
        log(True, "載入後端模組（server.py 與 kinlink 套件）")
        real_db = str(_backend.resolve_db_path())
        real_before = _file_stamp(real_db)

        import db  # noqa: PLC0415 — 直接指定臨時庫路徑；server.init_db() 會開 exe 旁的正式庫
        tmp_db = os.path.join(tmp, "繫族.db")
        db.init_db(tmp_db)
        log(True, "在暫存資料夾建立臨時資料庫", tmp_db)
        check("灌入示範資料", lambda: (_backend.seed_if_empty() is True, ""))
        check("自動備份（VACUUM INTO）", lambda: (os.path.isfile(_backend.auto_backup()), ""))

        srv = _backend.start_server(host="127.0.0.1", port=0, token=None)
        log(True, "起本機伺服器", "127.0.0.1:%d" % srv.port)

        def _health():
            st, body = get("/api/health")
            j = json.loads(body.decode("utf-8"))
            ver = j.get("version")
            ok = st == 200 and j.get("ok") is True and ver == APP_VERSION
            if getattr(sys, "frozen", False):
                ok = ok and ver != "0.0.0"      # 0.0.0＝VERSION 檔沒打包進去
            return ok, "version=%s" % ver
        check("GET /api/health", _health)

        def _page(path, marker):
            def run():
                st, body = get(path)
                return st == 200 and marker in body, "HTTP %s，%d bytes" % (st, len(body))
            return run
        check("首頁 index.html", _page("/", b"<html"))
        check("列印頁 print.html", _page("/print.html", b"<html"))
        check("列印範本（/列印範本/通知函.html）", _page("/列印範本/通知函.html", b"<html"))

        def _state():
            st, body = get("/api/state", auth=True)
            j = json.loads(body.decode("utf-8"))
            same = (os.path.normcase(os.path.realpath(j.get("dbPath") or ""))
                    == os.path.normcase(os.path.realpath(tmp_db)))
            return st == 200 and same, "dbPath=%s" % j.get("dbPath")
        check("GET /api/state（用的是臨時庫）", _state)

        def _members():
            st, body = get("/api/members", auth=True)
            rows = json.loads(body.decode("utf-8"))
            return st == 200 and isinstance(rows, list) and len(rows) > 0, "%d 筆" % len(rows)
        check("GET /api/members（讀得到示範成員）", _members)

        def _lunar():
            st, body = get("/api/lunar?d=2026-04-05", auth=True)
            lunar = json.loads(body.decode("utf-8")).get("lunar") or ""
            return st == 200 and bool(lunar), lunar or "（換算不出，農曆庫沒打包進去？）"
        check("GET /api/lunar（農曆換算）", _lunar)

        # 原生視窗元件：exe 一定要能載入（少了它就只會退回瀏覽器）；原始碼模式沒裝就略過
        ok, detail = _native_window_check()
        if ok is None:
            lines.append("SKIP  載入原生視窗元件（原始碼模式：沒裝 pywebview 或載入失敗，不算打包問題）：" + detail)
        else:
            log(ok, "載入原生視窗元件（pywebview、.NET 互通層、WebView2 組件）", detail)
    except Exception as e:  # noqa: BLE001
        log(False, "未預期的錯誤", _err_text(e))
    finally:
        if srv is not None:
            try:
                srv.stop()
            except Exception:
                pass
        import time
        for _ in range(20):            # 伺服器執行緒剛收尾時，SQLite 檔可能還被占用一下
            shutil.rmtree(tmp, ignore_errors=True)
            if not os.path.exists(tmp):
                break
            time.sleep(0.25)
        log(not os.path.exists(tmp), "清掉暫存資料夾", tmp)
        if real_db is not None:
            log(_file_stamp(real_db) == real_before, "沒有碰到 exe 旁的正式資料庫", real_db)
        watchdog.cancel()
        write_report("結果：全部通過" if not fails else "結果：%d 項失敗（%s）" % (len(fails), "、".join(fails)))
    return 0 if not fails else 1


if __name__ == "__main__":
    raise SystemExit(main())
