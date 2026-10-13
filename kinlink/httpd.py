# -*- coding: utf-8 -*-
"""HTTP 層：路由、token/Host 驗證、靜態檔、伺服器生命週期（原 server.py）。

業務一律經 get_db() 反射呼叫（_call(db, "函式名")）——預設拿到 server 門面，
測試可 set_db() 注入替身。本模組不含任何業務規則。"""
from __future__ import annotations

import json
import secrets
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PureWindowsPath
from urllib.parse import parse_qs, unquote, urlparse

from .errors import ApiError
from .paths import APP_NAME, APP_VERSION, WEB_DIR, resolve_print_dir, resolve_web_dir
from .state import get_db


_CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".map": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".webmanifest": "application/manifest+json",
}


# ============================================================
# Handler
# ============================================================

class _KinHandler(BaseHTTPRequestHandler):
    """繫族請求處理器；外層 server 變數（token / web_dir）以閉包注入。"""

    protocol_version = "HTTP/1.1"
    server_version = "KinLink/" + APP_VERSION

    # 由 make_server 在子類別上覆寫
    _token = ""
    _web_dir = WEB_DIR

    # ---- 靜音預設 log（避免主控台噪音；需要時可導向 logging）----
    def log_message(self, fmt, *args):  # noqa: A003
        pass

    # ====================================================
    # 安全：Host / Origin 驗證（防 DNS rebinding / CSRF）
    # ====================================================
    def _allowed_hosts(self):
        port = self.server.server_address[1]
        return {
            "127.0.0.1:%d" % port,
            "localhost:%d" % port,
        }

    def _check_host(self) -> bool:
        """
        loopback 伺服器的關鍵防護：

        * Host 標頭必須是 127.0.0.1:port 或 localhost:port 之一。
        * 若帶 Origin，必須是 http://<那兩者>（POST 跨站防護）。

        Edge --app / WebView2 載入的就是 127.0.0.1:port，會通過；惡意網站用
        DNS rebinding 指向 127.0.0.1 會被擋（其 Host 仍是攻擊網域）。
        """
        allowed = self._allowed_hosts()
        host = (self.headers.get("Host") or "").strip().lower()
        if host not in allowed:
            return False
        origin = self.headers.get("Origin")
        if origin:
            o = urlparse(origin)
            if o.scheme != "http" or (o.netloc or "").lower() not in allowed:
                return False
        return True

    # ====================================================
    # 安全：token 驗證
    # ====================================================
    def _check_token(self, query: dict) -> bool:
        """
        驗證隨機 token。攜帶方式二擇一：
            Authorization: Bearer <token>   或   ?k=<token>
        比對一律用 secrets.compare_digest（防時序側通道）。
        token 為空字串時退化為不驗（桌面 loopback 自用情境）。
        """
        if not self._token:
            return True
        provided = ""
        auth = self.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            provided = auth[7:].strip()
        if not provided:
            vals = query.get("k") or []
            provided = vals[0] if vals else ""
        try:   # 轉 bytes 比對：str 版遇非 ASCII 會 TypeError → 500；這裡一律視為不符（fail-closed）
            return bool(provided) and secrets.compare_digest(
                provided.encode("utf-8"), self._token.encode("utf-8"))
        except (TypeError, UnicodeError):
            return False

    # ====================================================
    # 回應輔助
    # ====================================================
    def _send(self, code: int, body: bytes, content_type: str, extra=None):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        # 靜態與 API 一律不快取，避免改資料後前端看到舊內容
        self.send_header("Cache-Control", "no-cache")
        if extra:
            for k, v in extra.items():
                self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass  # 客戶端先斷線，收斂不噴堆疊

    def _json(self, obj, code: int = 200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self._send(code, body, "application/json; charset=utf-8")

    def _err(self, code: int, message: str):
        """統一錯誤格式：{error:{message}}（與常見 API 慣例相容）。"""
        self._json({"error": {"message": message}}, code)

    def _drain_body(self):
        """錯誤早退（404/403/401）前把沒讀的 body 吃掉：HTTP/1.1 keep-alive 下殘留半截
        body 會汙染同一連線的下一個請求。超過 64MB 不陪讀，直接關連線。"""
        self._body_done = True
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except (TypeError, ValueError):
            return
        if length <= 0:
            return
        if length > 64 * 1024 * 1024:
            self.close_connection = True
            return
        try:
            while length > 0:
                chunk = self.rfile.read(min(length, 65536))
                if not chunk:
                    break
                length -= len(chunk)
        except OSError:
            self.close_connection = True

    def _finish_body(self):
        """路由處理完（成功或丟錯）都呼叫：body 還沒被讀過就吃掉。

        先前只在四支「不用 body」的路由先吃（L-1），其他早退路徑仍會留下殘 body：未知 API 的 404、
        /api/member/{非數字}/parent 這類在讀 body 之前就由 _int_id 丟 400 的路由——同一條 keep-alive
        連線的下一個請求就被汙染成 400（第二批驗證員）。改在 do_POST／do_DELETE 收尾統一處理。
        已決定關連線（413、長度異常）的不陪讀。"""
        if not getattr(self, "_body_done", True) and not self.close_connection:
            self._drain_body()

    def _read_raw_body(self, length: int) -> bytes:
        self._body_done = True
        return self.rfile.read(length)

    def _read_json_body(self) -> dict:
        """讀取 Content-Length 量的 body 後 json.loads；失敗回 {}。"""
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except (TypeError, ValueError):
            length = 0
        if length <= 0:
            return {}
        # 防呆上限：本機編輯用，16MB 綽綽有餘（系統不存照片，JSON body 都很小）
        if length > 16 * 1024 * 1024:
            self.close_connection = True   # 不讀也不陪讀：回 413 後關連線，免得殘 body 汙染下一請求
            raise ApiError(413, "request body too large")
        raw = self._read_raw_body(length)
        try:
            data = json.loads(raw.decode("utf-8"))
            return data if isinstance(data, dict) else {}
        except (ValueError, UnicodeDecodeError):
            return {}

    # ====================================================
    # 靜態檔
    # ====================================================
    def _send_file(self, base_dir: Path, rel: str):
        """以 base_dir 為根送出檔案，含目錄穿越防護（解析後須落在根內）。"""
        # 絕對路徑／磁碟代號／UNC／開頭斜線／含冒號（含 NTFS 資料流 a:b）一律 404，而且要在 resolve 之前擋：
        # resolve 碰到 \\主機\分享 會先對外發起 SMB 連線（可能送出 Windows 登入的 NTLM 雜湊），
        # 範圍檢查等 resolve 完才做就來不及了（2026-09-25 體檢 security-5）。
        p = PureWindowsPath(rel)
        if p.drive or p.root or rel.startswith(("\\", "/")) or ":" in rel:
            self._err(404, "not found")
            return
        try:
            base = Path(base_dir).resolve()
            target = (base / rel).resolve()
        except (OSError, ValueError):   # Windows 保留名／非法字元（aux、a:b）resolve 會拋 → 404，不要 500
            self._err(404, "not found")
            return

        # 目錄穿越防護：解析後仍須落在 base 內
        if base != target and base not in target.parents:
            self._err(403, "forbidden")
            return
        if not target.is_file():
            self._err(404, "not found")
            return

        ctype = _CONTENT_TYPES.get(target.suffix.lower(), "application/octet-stream")
        try:
            body = target.read_bytes()
        except OSError:
            self._err(404, "not found")
            return
        self._send(200, body, ctype)

    def _static(self, path: str):
        # 根路徑 → index.html
        if path in ("", "/"):
            path = "/index.html"
        # 中文路徑（如 /列印範本/通知函.html）以百分比編碼送達，須先解碼再解析
        path = unquote(path)

        # 白名單路由：/列印範本/* 位於專案根（凍結時 _MEIPASS），不在 webview
        # 靜態根內；改以 resolve_print_dir() 解析，仍套用目錄穿越防護。
        if path.startswith("/列印範本/"):
            self._send_file(resolve_print_dir(), path[len("/列印範本/"):])
            return

        self._send_file(Path(self._web_dir), path.lstrip("/"))

    # ====================================================
    # 路由分派
    # ====================================================
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)

        # /api/health：探活端點，免 token、免 Host 驗（不含敏感資訊）
        if path == "/api/health":
            self._json({"ok": True, "app": APP_NAME, "version": APP_VERSION})
            return

        is_api = path.startswith("/api/")
        # 安全閘門：API 與敏感 GET 一律驗 Host；API 另驗 token
        if is_api:
            if not self._check_host():
                self._err(403, "bad host")
                return
            if not self._check_token(query):
                self._err(401, "unauthorized")
                return
            try:
                self._route_get(path, query)
            except ApiError as e:
                self._err(e.code, e.message)
            except NotImplementedError:
                # 「函式不存在」只由 _call 的 NotImplementedError 表達；
                # 業務函式內部的 AttributeError 是真 bug，落到下面 500 印 traceback，不可偽裝成 501
                self._err(501, "not implemented")
            except Exception:  # noqa: BLE001
                self._err(500, self._exc_msg())
            return

        # 其餘為靜態檔
        self._static(path)

    def do_HEAD(self):
        self.do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)

        if not path.startswith("/api/"):
            self._drain_body()
            self._err(404, "unknown endpoint")
            return

        # 所有 POST 皆有副作用 → 一律驗 Host（CSRF）與 token
        if not self._check_host():
            self._drain_body()
            self._err(403, "bad host")
            return
        if not self._check_token(query):
            self._drain_body()
            self._err(401, "unauthorized")
            return

        self._body_done = False
        try:
            self._route_post(path, query)
        except ApiError as e:
            self._finish_body()
            self._err(e.code, e.message)
        except NotImplementedError:
            self._finish_body()
            self._err(501, "not implemented")
        except Exception:  # noqa: BLE001（AttributeError 是真 bug → 500＋traceback，勿偽裝 501）
            self._finish_body()
            self._err(500, self._exc_msg())
        else:
            self._finish_body()

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)

        if not path.startswith("/api/"):
            self._drain_body()
            self._err(404, "unknown endpoint")
            return
        if not self._check_host():
            self._drain_body()
            self._err(403, "bad host")
            return
        if not self._check_token(query):
            self._drain_body()
            self._err(401, "unauthorized")
            return

        self._body_done = False
        try:
            self._route_delete(path, query)
        except ApiError as e:
            self._finish_body()
            self._err(e.code, e.message)
        except NotImplementedError:
            self._finish_body()
            self._err(501, "not implemented")
        except Exception:  # noqa: BLE001（AttributeError 是真 bug → 500＋traceback，勿偽裝 501）
            self._finish_body()
            self._err(500, self._exc_msg())
        else:
            self._finish_body()

    # ----------------------------------------------------
    def _exc_msg(self) -> str:
        # 開發期回完整訊息便於除錯；正式環境也只在 loopback 內可見，可接受
        traceback.print_exc()
        return "internal error"

    # ====================================================
    # API 路由實作
    # ====================================================
    def _route_get(self, path: str, query: dict):
        db = get_db()

        # GET /api/state → {editMode, theme, appName, version, dbPath}
        if path == "/api/state":
            state = _call(db, "get_state")
            if state is None:
                state = {}
            state.setdefault("appName", APP_NAME)
            state.setdefault("version", APP_VERSION)
            state.setdefault("editMode", False)
            state.setdefault("theme", "system")
            # 設定頁顯示「資料存在哪」（體檢 release-4）：取實際開啟中的庫，與備份／還原同源
            from .maintenance import _active_db_path  # noqa: PLC0415
            state.setdefault("dbPath", str(_active_db_path()))
            self._json(state)
            return

        # GET /api/members?branch=&q= → [ {...} ]
        if path == "/api/members":
            branch = _first(query, "branch")
            q = _first(query, "q")
            lim = _first(query, "limit")
            lim = int(lim) if lim and str(lim).isdigit() else None   # 選人器前 N 筆；非法／未傳＝全量
            self._json(_call(db, "list_members", branch, q, lim) or [])
            return

        # GET /api/member/{id} → {...detail, parents, spouses, children}
        if path.startswith("/api/member/"):
            mid = _int_id(path[len("/api/member/"):])
            member = _call(db, "get_member", mid)
            if member is None:
                raise ApiError(404, "member not found")
            self._json(member)
            return

        # GET /api/kinship?from=&to= → {forward, backward, path}
        if path == "/api/kinship":
            f = _int_id(_first(query, "from"), required=True, name="from")
            t = _int_id(_first(query, "to"), required=True, name="to")
            self._json(_call(db, "kinship", f, t) or {})
            return

        # GET /api/lunar?d=YYYY-MM-DD → {lunar}（國曆→農曆中文；表單即時對照提示用。
        # 換算不出（超出查表／格式不符）回空字串，前端不顯示、不硬掰。）
        if path == "/api/lunar":
            self._json({"lunar": _call(db, "solar_to_lunar_cn", _first(query, "d") or "") or ""})
            return

        # GET /api/solar?d=YYYY-MM-DD（農曆）→ {solar, lunar, problem}（農曆→國曆；活動表單農曆欄
        # 即時對照，冬臘月跨年與小月三十先在表單講清楚。純曆法換算不碰資料庫，直接取 lunar 模組）
        if path == "/api/solar":
            from .lunar import lunar_solar_info  # noqa: PLC0415
            self._json(lunar_solar_info(_first(query, "d") or ""))
            return

        # GET /api/events → [ {...} ]
        if path == "/api/events":
            self._json(_call(db, "list_events") or [])
            return

        # GET /api/settings → settings
        if path == "/api/settings":
            self._json(_call(db, "get_settings") or {})
            return

        # GET /api/export?fmt=csv → CSV 下載（xlsx／pdf 未實作，回 501）
        if path == "/api/export":
            fmt = (_first(query, "fmt") or "csv").lower()
            if fmt != "csv":
                raise ApiError(501, "目前僅支援 CSV，請選 fmt=csv")
            data = _call(db, "export_members_csv")
            if data is None:
                raise ApiError(501, "export not implemented")
            self._send(200, data, "text/csv; charset=utf-8",   # 走 _send：HEAD 不帶 body、統一 no-cache
                       {"Content-Disposition": 'attachment; filename="kinlink_members.csv"'})
            return

        # GET /api/tomb-sites → [{id,name,title,rows,cols,filled}]（穴排位場地清單）
        if path == "/api/tomb-sites":
            self._json(_call(db, "list_tomb_sites") or [])
            return

        # GET /api/tomb-site/{id} → 格子表；GET /api/tomb-site/{id}/csv → CSV 下載
        if path.startswith("/api/tomb-site/"):
            rest = path[len("/api/tomb-site/"):]
            if rest.endswith("/csv"):
                sid = _int_id(rest[:-len("/csv")], name="siteId")
                data = _call(db, "export_tomb_site_csv", sid) or b""
                self._send(200, data, "text/csv; charset=utf-8",
                           {"Content-Disposition": 'attachment; filename="kinlink_tomb_site_%d.csv"' % sid})
                return
            self._json(_call(db, "get_tomb_site", _int_id(rest, name="siteId")) or {})
            return

        # GET /api/update/check → {configured, current, latest, hasUpdate, assetUrl, notes|error}
        if path == "/api/update/check":
            self._json(_call(db, "check_update") or {"configured": False})
            return

        # GET /api/update/progress → {got, want}（下載更新進行中，畫面每秒問一次顯示百分比）
        if path == "/api/update/progress":
            self._json(_call(db, "update_progress") or {})
            return

        raise ApiError(404, "unknown api")

    def _route_post(self, path: str, query: dict):
        db = get_db()

        # 這幾支不用 body；客戶端仍帶了（例如 {}）就先吃掉——沒讀完的 body 在 keep-alive 下會汙染下一個請求，
        # 回完關線時 Windows 也會改送 RST，客戶端讀回應前就可能收到 10053（test_settings_restore 偶發失敗的根因）
        if path in ("/api/lock/lock", "/api/update/download", "/api/demo/clear", "/api/backup"):
            self._drain_body()

        # POST /api/lock/unlock {pin,branch} → {ok}
        if path == "/api/lock/unlock":
            body = self._read_json_body()
            self._json(_call(db, "unlock", body.get("pin", ""), body.get("branch")) or {"ok": False})
            return

        # POST /api/lock/lock → {ok}
        if path == "/api/lock/lock":
            self._json(_call(db, "lock") or {"ok": True})
            return

        # POST /api/lock/setpin {old,new} → {ok[,message]}
        if path == "/api/lock/setpin":
            body = self._read_json_body()
            self._json(_call(db, "set_pin", body.get("old", ""), body.get("new", "")) or {"ok": False})
            return

        # POST /api/update/download → {ok, file, bat}（半自動改版）
        if path == "/api/update/download":
            self._json(_call(db, "download_update") or {"ok": False})
            return

        # POST /api/member (編輯模式) → {id}
        if path == "/api/member":
            body = self._read_json_body()
            self._json(_call(db, "save_member", body) or {})
            return

        # POST /api/member/{id}/parent {parentId, relationType}（編輯模式）
        # → upsert 指定型別父/母邊（雙軌：BIOLOGICAL 與 ADOPTED/FOSTER 可並存）
        if path.startswith("/api/member/") and path.endswith("/parent"):
            mid = _int_id(path[len("/api/member/"):-len("/parent")])
            body = self._read_json_body()
            self._json(
                _call(db, "add_parent", mid, body.get("parentId"), body.get("relationType"))
                or {"ok": True}
            )
            return

        # POST /api/member/{id}/spouse {spouseId, status}（編輯模式）→ 婚姻 upsert
        if path.startswith("/api/member/") and path.endswith("/spouse"):
            mid = _int_id(path[len("/api/member/"):-len("/spouse")])
            body = self._read_json_body()
            self._json(
                _call(db, "add_spouse", mid, body.get("spouseId"), body.get("status"))
                or {"ok": True}
            )
            return

        # POST /api/event (編輯模式) → {id}（upsert ritual_events）
        if path == "/api/event":
            body = self._read_json_body()
            self._json(_call(db, "save_event", body) or {})
            return

        # POST /api/tomb-site {id?, name, rows, cols, rowLabels[], cells[]} → {id}（編輯模式）
        if path == "/api/tomb-site":
            body = self._read_json_body()
            self._json(_call(db, "save_tomb_site", body) or {})
            return

        # POST /api/tomb-site/{id}/csv（raw CSV bytes，編輯模式）→ {rows, cols, matched, unmatched[]}
        if path.startswith("/api/tomb-site/") and path.endswith("/csv"):
            sid = _int_id(path[len("/api/tomb-site/"):-len("/csv")], name="siteId")
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except (TypeError, ValueError):
                length = 0
            if length <= 0:
                raise ApiError(400, "未收到檔案內容，請重新選擇 CSV 檔")
            if length > 4 * 1024 * 1024:
                self.close_connection = True
                raise ApiError(413, "檔案過大（上限 4MB）")
            self._json(_call(db, "import_tomb_site_csv", sid, self._read_raw_body(length)) or {})
            return

        # POST /api/kinship/batch {toId, memberIds[]} → {terms:{id:稱謂}}（唯讀，免編輯模式）
        if path == "/api/kinship/batch":
            body = self._read_json_body()
            self._json(_call(db, "kinship_batch", body) or {"terms": {}})
            return

        # POST /api/settings {patch} → settings
        if path == "/api/settings":
            body = self._read_json_body()
            patch = body.get("patch", body)  # 容忍直接傳 patch 物件
            self._json(_call(db, "update_settings", patch) or {})
            return

        # POST /api/demo/clear → {ok, deleted, kept, backup, message}（需編輯模式；僅示範資料庫可清空）
        if path == "/api/demo/clear":
            self._json(_call(db, "clear_demo") or {"ok": False})
            return

        # POST /api/backup → {file, folder}（VACUUM INTO 單檔，寫進 backups\；免編輯模式）
        if path == "/api/backup":
            self._json(_call(db, "backup") or {})
            return

        # POST /api/restore {file} → {ok}
        if path == "/api/restore":
            body = self._read_json_body()
            self._json(_call(db, "restore", body.get("file", "")) or {"ok": False})
            return

        # POST /api/restore/upload（octet-stream 原始 bytes）→ {ok}
        if path == "/api/restore/upload":
            try:   # 非數字的 Content-Length 舊版直接 int() 丟成 500 internal error
                length = int(self.headers.get("Content-Length") or 0)
            except (TypeError, ValueError):
                length = -1
            if length <= 0 or length > 512 * 1024 * 1024:
                self.close_connection = True   # 不知道（或不陪讀）body 多長：回完就關連線，免得殘 body 汙染下一請求
                raise ApiError(400, "上傳的備份檔大小異常，請重新選擇備份檔再試一次")
            data = self._read_raw_body(length)
            self._json(_call(db, "restore_upload", data) or {"ok": False})
            return

        # POST /api/import?mode=preview|commit（R1 通用 CSV 匯入；需編輯模式）
        # body 為 CSV 原始 bytes（text/csv 或 application/octet-stream，
        # 容 UTF-8／UTF-8-BOM）；preview 只回試算報告不寫庫，commit 實際寫入。
        if path == "/api/import":
            mode = _first(query, "mode") or "preview"
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except (TypeError, ValueError):
                length = 0
            if length <= 0:
                raise ApiError(400, "未收到檔案內容，請重新選擇 CSV 檔")
            if length > 16 * 1024 * 1024:
                self.close_connection = True
                raise ApiError(413, "檔案過大（上限 16MB），請分批匯入")
            data = self._read_raw_body(length)
            self._json(_call(db, "import_csv", data, mode) or {})
            return

        raise ApiError(404, "unknown api")

    def _route_delete(self, path: str, query: dict):
        db = get_db()

        if path.startswith("/api/member/"):
            rest = path[len("/api/member/"):]
            parts = rest.split("/")

            # DELETE /api/member/{id}/parent/{parentId}[?relationType=]（編輯模式）
            if len(parts) == 3 and parts[1] == "parent":
                mid = _int_id(parts[0])
                pid = _int_id(parts[2], name="parentId")
                rt = _first(query, "relationType")
                self._json(_call(db, "remove_parent", mid, pid, rt) or {"ok": True})
                return

            # DELETE /api/member/{id}/spouse/{spouseId}（編輯模式）
            if len(parts) == 3 and parts[1] == "spouse":
                mid = _int_id(parts[0])
                sid = _int_id(parts[2], name="spouseId")
                self._json(_call(db, "remove_spouse", mid, sid) or {"ok": True})
                return

            # DELETE /api/member/{id} → {ok}
            mid = _int_id(rest)
            self._json(_call(db, "delete_member", mid) or {"ok": True})
            return

        # DELETE /api/event/{id} → {ok}（編輯模式）
        if path.startswith("/api/event/"):
            eid = _int_id(path[len("/api/event/"):], name="eventId")
            self._json(_call(db, "delete_event", eid) or {"ok": True})
            return

        # DELETE /api/tomb-site/{id} → {ok, name}（編輯模式；只刪格子表，成員不動）
        if path.startswith("/api/tomb-site/"):
            sid = _int_id(path[len("/api/tomb-site/"):], name="siteId")
            self._json(_call(db, "delete_tomb_site", sid) or {"ok": True})
            return

        raise ApiError(404, "unknown api")


# ============================================================
# 小工具
# ============================================================

def _first(query: dict, key: str, default=None):
    """從 parse_qs 結果取單一值。"""
    vals = query.get(key)
    return vals[0] if vals else default


def _int_id(raw, required: bool = False, name: str = "id") -> int:
    """把路徑/查詢字串的 id 轉 int；非法時回 400。"""
    if raw is None or raw == "":
        if required:
            raise ApiError(400, "missing %s" % name)
        raise ApiError(400, "missing %s" % name)
    try:
        return int(raw)
    except (TypeError, ValueError):
        raise ApiError(400, "invalid %s" % name)


def _call(db, fn_name: str, *args):
    """
    呼叫 db 模組函式；函式不存在時丟 NotImplementedError（路由層轉 501）。
    讓 server 可先上線、db 各端點再逐步補齊而不崩潰。
    """
    fn = getattr(db, fn_name, None)
    if not callable(fn):
        raise NotImplementedError(fn_name)
    return fn(*args)


# ============================================================
# 伺服器封裝
# ============================================================

class KinServer:
    """
    繫族本機伺服器。只綁 127.0.0.1；token 隨機（可為空字串退化為不驗）。

    屬性：
        host / port / token / url
    方法：
        start()  以 daemon thread 跑 serve_forever
        stop()   shutdown + server_close
        serve_forever()  阻塞於目前執行緒
    """

    def __init__(self, port: int = 0, token=None, web_dir=None):
        self.host = "127.0.0.1"
        self.token = token if token is not None else secrets.token_urlsafe(12)
        self.web_dir = Path(web_dir) if web_dir else resolve_web_dir()

        # 以閉包方式把 token / web_dir 綁到 handler 子類別上
        token_val = self.token
        web_dir_val = self.web_dir

        class _Handler(_KinHandler):
            _token = token_val
            _web_dir = web_dir_val

        self._handler_cls = _Handler
        # port=0 → 由 OS 配一個空閒埠
        self._httpd = ThreadingHTTPServer((self.host, port), _Handler)
        self._httpd.daemon_threads = True
        self._thread = None

    @property
    def port(self) -> int:
        return self._httpd.server_address[1]

    @property
    def url(self) -> str:
        """前端應載入的本機網址（含 token 查詢參數，方便 WebView 直接開）。"""
        base = "http://%s:%d/" % (self.host, self.port)
        if self.token:
            return base + "?k=" + self.token
        return base

    def start(self) -> "KinServer":
        """以背景 daemon thread 啟動 serve_forever，立即返回。"""
        if self._thread and self._thread.is_alive():
            return self
        self._thread = threading.Thread(
            target=self._httpd.serve_forever,
            name="kinlink-http",
            daemon=True,
        )
        self._thread.start()
        return self

    def serve_forever(self):
        """阻塞於目前執行緒（CLI / 直接執行用）。"""
        self._httpd.serve_forever()

    def stop(self):
        """優雅關閉：先 shutdown（停止 serve_forever）再 server_close（釋放埠）。"""
        try:
            self._httpd.shutdown()
        except Exception:  # noqa: BLE001
            pass
        try:
            self._httpd.server_close()
        except Exception:  # noqa: BLE001
            pass


# ============================================================
# 工廠 / 進入點
# ============================================================

def make_server(port: int = 0, token=None, web_dir=None) -> KinServer:
    """
    建立（但不啟動）一個 KinServer。

    參數：
        port      0 → 由 OS 配空閒埠；指定值則綁該埠
        token     None → 自動產生隨機 token；'' → 不驗 token
        web_dir   靜態資產目錄；None → resolve_web_dir() 自動解析
    回傳：
        KinServer 實例（呼叫 .start() 或 .serve_forever() 啟動）
    """
    return KinServer(port=port, token=token, web_dir=web_dir)
