# -*- coding: utf-8 -*-
"""
繫族 KinLink ｜ 後端薄門面（重構於 2026-08-20：邏輯已拆進 kinlink/ 套件）
==========================================================================

本檔**不含業務邏輯**，只做三件事：
  1. 顯式 re-export 各模組符號（含測試所用的 _ 底線符號）——
     測試裡的 ``server.X``、HTTP 層 ``_call(db, "函式名")`` 反射、
     app.py 的啟動契約，全部維持原介面不變。
  2. 應用生命週期膠水：init_db / seed_if_empty / start_server / run。
  3. PyInstaller 靜態分析入口：app.py → server → kinlink.*，一般 import 即收。

要找某段邏輯：見 ``kinlink/__init__.py`` 的模組地圖。
"""

from __future__ import annotations

import threading

# ── re-export（依模組分組；含底線符號＝測試/工具的既有介面，勿刪）──
from kinlink.errors import ApiError                                    # noqa: F401
from kinlink.state import _LOCK, _conn, get_db, set_db                 # noqa: F401  （_DB_OVERRIDE 不轉出：按值複製會過期，要用走 set_db/get_db）
from kinlink.paths import (                                            # noqa: F401
    APP_NAME, APP_VERSION, WEB_DIR, _read_version,
    resolve_db_path, resolve_print_dir, resolve_web_dir,
)
from kinlink.lunar import (                                            # noqa: F401
    _GAN, _ZHI, _ganzhi, _split_original, _LunarDate,
    _lunar_cn, _lunar_day_cn, _ymd,
    lunar_iso_to_cn, lunar_to_solar_iso, solar_to_lunar_cn,
)
from kinlink.members import (                                          # noqa: F401
    _FIELD_MAP, _GEN_CN, _NAME_VARIANTS, _REL_TYPES, _SPOUSE_STATUS, _TOMB_TYPES,
    _branch_guard, _descendant_ids, _father_name, _inlaw_tag, _inlaw_tag_ctx,
    _label, _list_ctx, _project_member, _q_variants, _rel_ids, _save_burial,
    _set_father, add_parent, add_spouse, delete_member, get_member,
    list_members, remove_parent, remove_spouse, save_member,
)
from kinlink.session import _read_edit_pin, get_state, lock, set_pin, unlock  # noqa: F401
from kinlink.kinship import (                                          # noqa: F401
    _MOTHER_CHILD, _SPOUSE_OF, _VIA_MOTHER, _VIA_SPOUSE,
    _kin_blood, _kin_bridge, _kin_chain, _kin_info, _kin_married,
    _kin_mother, _kin_spouses, _spouse_term, _via_spouse_term,
    kinship, kinship_batch,
)
from kinlink.events import delete_event, list_events, save_event       # noqa: F401
from kinlink.csv_io import (                                           # noqa: F401
    _IMPORT_ALIASES, _IMPORT_COLS, _import_decode, _import_header_map,
    _import_parse, export_members_csv, import_csv,
)
from kinlink.tombsites import (                                        # noqa: F401
    delete_tomb_site, export_tomb_site_csv, get_tomb_site, honor_label,
    import_tomb_site_csv, list_tomb_sites, member_tomb_sites, save_tomb_site,
)
from kinlink.maintenance import (                                      # noqa: F401
    _SETTINGS_BLOCKLIST, _SETTINGS_NOLOCK, _UPDATE_HOSTS,
    _active_db_path, _apply_bat_text, _branches_from_value, _branches_to_value,
    auto_backup, backup, check_update, clear_demo, download_update,
    get_settings, restore, restore_upload, update_progress, update_settings,
)
from kinlink.httpd import (                                            # noqa: F401
    _CONTENT_TYPES, KinServer, _call, _first, _int_id, make_server,
)


# ============================================================
# 應用生命週期（app.py 啟動契約；委派 db 模組與 kinlink.httpd）
# ============================================================

_DB_READY = False


def init_db() -> None:
    """建表 + 啟用 WAL（冪等）。供 app.py 啟動序呼叫；委派給 db.init_db()。

    注意：app.py 的契約是「無參數」呼叫；資料庫路徑於此用 resolve_db_path()
    決定，並記住於 db 模組（db 內部以 _DB_PATH 保存，後續 connect 不需再傳）。
    """
    global _DB_READY
    import db  # noqa: PLC0415
    db.init_db(str(resolve_db_path()))
    _DB_READY = True


def seed_if_empty() -> bool:
    """全新資料庫（成員表為空且從未有過成員）才灌入楊家示範資料；回傳是否實際 seed。
    委派 db.seed_demo()——清空示範或刪光成員後重開程式不會再被灌回示範（H-1）。"""
    import db  # noqa: PLC0415
    return db.seed_demo() > 0


def start_server(host: str = "127.0.0.1", port: int = 0, token=None) -> "KinServer":
    """
    起本機伺服器並背景執行，立即返回 srv（具 .host/.port/.token/.stop()）。
    app.py 的啟動契約進入點。host 目前固定 127.0.0.1（KinServer 僅綁 loopback）。
    """
    srv = make_server(port=port, token=token)
    srv.start()
    return srv


def run(port: int = 0, token=None, web_dir=None, open_window: bool = False) -> KinServer:
    """
    起伺服器並阻塞於目前執行緒（直接執行 server.py 時用）。

    open_window=True 時開預設瀏覽器（見 _try_open_window）；開不了就印出網址供手動開啟。
    要原生視窗請改用 app.py（python app.py）。
    """
    # 先開庫（與 app.py 啟動序一致）：舊版直接起伺服器，每支 API 都 500「資料庫尚未初始化」，
    # 前端探活失敗後悄悄降級成展示用假資料，工程師會誤以為後端正常（體檢 opensource-9）
    init_db()
    srv = make_server(port=port, token=token, web_dir=web_dir)
    srv.start()  # 先起背景 server，確保視窗指向時已可連
    print("[繫族] 伺服器已啟動：%s" % srv.url)
    print("[繫族] 靜態資產目錄：%s" % srv.web_dir)

    if open_window:
        _try_open_window(srv.url)

    try:
        # 主執行緒阻塞，等待中斷；伺服器被 stop() 後執行緒結束即返回（舊版會在這裡空轉）
        while srv._thread and srv._thread.is_alive():
            srv._thread.join(timeout=1.0)
    except KeyboardInterrupt:
        print("\n[繫族] 收到中斷，正在關閉…")
    finally:
        srv.stop()
    return srv


def _try_open_window(url: str):
    """開預設瀏覽器。

    app_webview 是早期規劃的獨立視窗啟動模組名，專案裡沒有這個檔（原生視窗一律走 app.py），
    所以下面的 import 實際上一定失敗、一律走預設瀏覽器；保留只為不改變既有行為。
    """
    try:
        import app_webview  # type: ignore
        if hasattr(app_webview, "open_window"):
            threading.Thread(
                target=app_webview.open_window, args=(url,), daemon=True
            ).start()
            return
    except Exception:  # noqa: BLE001
        pass
    try:
        import webbrowser
        webbrowser.open(url)
    except Exception:  # noqa: BLE001
        print("[繫族] 請手動於瀏覽器開啟：%s" % url)


if __name__ == "__main__":
    # 直接執行：起本機伺服器並開瀏覽器（開發 / 手動測試用）。
    run(open_window=True)
