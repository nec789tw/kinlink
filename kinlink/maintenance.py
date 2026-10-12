# -*- coding: utf-8 -*-
"""設定、示範資料清除、備份還原、檢查更新（原 server.py）。"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

from .errors import ApiError
from .paths import APP_VERSION, resolve_db_path
from .state import _LOCK, _conn


def _branches_from_value(raw):
    """把 settings.branches 的原始字串解析成房頭名稱陣列。

    儲存格式為 JSON 陣列字串（如 '["大房","二房"]'）；容忍空值或舊資料，
    解析失敗一律回空陣列（前端據此顯示「全部房頭」而不崩潰）。
    """
    if not raw:
        return []
    try:
        v = json.loads(raw)
    except (ValueError, TypeError):
        return []
    if not isinstance(v, list):
        return []
    # 去除空白、濾掉空字串、保序去重（避免重複房名）
    out, seen = [], set()
    for x in v:
        s = ("" if x is None else str(x)).strip()
        if s and s not in seen:
            seen.add(s)
            out.append(s)
    return out


def _branches_to_value(v):
    """把前端送來的房頭（list 或 JSON 字串）正規化後序列化回 JSON 陣列字串。"""
    if isinstance(v, str):
        try:
            v = json.loads(v)
        except (ValueError, TypeError):
            v = []
    if not isinstance(v, list):
        v = []
    out, seen = [], set()
    for x in v:
        s = ("" if x is None else str(x)).strip()
        if s and s not in seen:
            seen.add(s)
            out.append(s)
    return json.dumps(out, ensure_ascii=False)


def get_settings() -> dict:
    """GET /api/settings → 鍵值字典。branches 解析成真正的陣列回前端。"""
    conn = _conn()
    try:
        out = {r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM settings").fetchall()}
    finally:
        conn.close()
    # branches 以 JSON 陣列字串儲存，於 API 邊界還原成陣列（缺鍵時回空陣列）
    out["branches"] = _branches_from_value(out.get("branches"))
    return out


# update_settings 拒收的敏感鍵：PIN 只能走 set_pin（驗舊碼）；demo_data／demo_manifest 只能由
# seed_demo 設、clear_demo 清（否則真實庫可被標成示範庫、真實成員可被登記成示範列而被清掉）。
_SETTINGS_BLOCKLIST = {"edit_pin", "demo_data", "demo_manifest"}
# 純顯示偏好：瀏覽模式也可改（不需編輯模式），如主題淺色/深色。
_SETTINGS_NOLOCK = {"theme", "ui_zoom"}   # ui_zoom＝介面縮放百分比（M-9：存後端，重開才記得）


def update_settings(patch) -> dict:
    """POST /api/settings {patch} → 回更新後 settings。

    含任何非純顯示偏好的鍵時需編輯模式（設定也是資料，鎖起來才能改；與其他
    寫入端點一致）；純顯示偏好（theme）瀏覽模式即可改。敏感鍵（edit_pin/
    demo_data）一律拒收，避免繞過編輯鎖改 PIN 或架空 clear_demo 的示範庫保護。
    branches 傳入 list 或 JSON 字串，正規化後落庫。
    """
    patch = patch or {}
    if any(str(k) not in _SETTINGS_NOLOCK for k in patch) and not _LOCK["editMode"]:
        raise ApiError(403, "edit mode required")
    conn = _conn()
    try:
        for k, v in patch.items():
            if str(k) in _SETTINGS_BLOCKLIST:
                raise ApiError(403, "「%s」不可由此路徑修改（PIN 請用『重設 PIN』）" % k)
            if k == "branches":
                stored = _branches_to_value(v)
            else:
                stored = None if v is None else str(v)
            conn.execute(
                "INSERT INTO settings(key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (str(k), stored),
            )
        conn.commit()
    finally:
        conn.close()
    return get_settings()


def _demo_targets(conn):
    """找出可安全刪除的示範列 → (成員 id 集合, 活動 id 集合, 場地 id 集合)。

    有 demo_manifest（seed_demo 記的清單）：id 在清單上、而且名稱仍對得上才算——
    id 可能被重用，使用者也可能把示範成員改名成自家祖先，只比 id 不安全。
    沒有清單（舊版 0.2.0 建的庫）：用 db.DEMO_SIGNATURE 的固定特徵辨識。
    """
    import db  # noqa: PLC0415
    row = conn.execute("SELECT value FROM settings WHERE key = 'demo_manifest'").fetchone()
    try:
        manifest = json.loads(row["value"]) if row and row["value"] else None
    except (ValueError, TypeError):
        manifest = None
    if not isinstance(manifest, dict):
        sig = db.DEMO_SIGNATURE
        mem = {r["id"] for n, g, b in sig["members"] for r in conn.execute(
            "SELECT id FROM members WHERE name = ? AND generation_number = ? AND birth_date = ?", (n, g, b))}
        evs = {r["id"] for n, d in sig["ritual_events"] for r in conn.execute(
            "SELECT id FROM ritual_events WHERE event_name = ? AND target_date = ?", (n, d))}
        sites = {r["id"] for n in sig["tomb_sites"] for r in conn.execute(
            "SELECT id FROM tomb_sites WHERE name = ?", (n,))}
        return mem, evs, sites

    def _still(table, col, pairs):
        out = set()
        for pair in pairs or []:
            try:
                rid, name = int(pair[0]), str(pair[1])
            except (TypeError, ValueError, IndexError):
                continue
            r = conn.execute("SELECT %s AS n FROM %s WHERE id = ?" % (col, table), (rid,)).fetchone()
            if r and r["n"] == name:
                out.add(rid)
        return out
    return (_still("members", "name", manifest.get("members")),
            _still("ritual_events", "event_name", manifest.get("ritual_events")),
            _still("tomb_sites", "name", manifest.get("tomb_sites")))


def _demo_site_edited(conn, site, cells, info) -> bool:
    """示範場地被使用者動過嗎（第一批驗證 L-3c）——與 db.DEMO_TOMB_SITE（seed_demo 灌入的內容）比：
    格子、抬頭、副標、頁尾、列欄數、列標籤任一不同就算動過，清空示範時當成使用者的場地保留。
    格子比「位置 →（指到的示範成員姓名、文字）」，不比 JSON 字面（前端存檔會重排、去空白）；
    指到已刪成員的格子（使用者先刪了某位示範成員）不算動過場地。info：示範成員 id → 列（含 name）。"""
    import db  # noqa: PLC0415
    from .tombsites import _json_list  # noqa: PLC0415
    seed = db.DEMO_TOMB_SITE
    got = {}
    for c in cells:
        if not isinstance(c, dict):
            continue
        mid, who = c.get("memberId"), None
        if mid not in (None, ""):
            try:
                mid = int(mid)
            except (TypeError, ValueError):
                return True
            if mid in info:
                who = info[mid]["name"]
            elif conn.execute("SELECT 1 FROM members WHERE id = ?", (mid,)).fetchone():
                return True                       # 指到使用者自己的成員
            else:
                who = "已刪"
        text = str(c.get("text") or "").strip()
        if who is not None or text:
            got[(c.get("r"), c.get("c"))] = (who, text)
    want = {(r, k): (nm, t) for r, k, nm, t in seed["cells"]}
    if set(got) != set(want) or any(got[p][1] != t or got[p][0] not in (nm, "已刪" if nm else None)
                                    for p, (nm, t) in want.items()):
        return True
    labels = [str(x or "").strip() for x in _json_list(site["row_labels"])]
    return (labels != seed["row_labels"]
            or (site["title"] or "", site["subtitle"] or "", site["footer"] or "", site["rows"], site["cols"])
            != (seed["title"], seed["subtitle"], seed["footer"], seed["rows"], seed["cols"]))


def clear_demo() -> dict:
    """POST /api/demo/clear（需編輯模式）→ {ok, deleted, kept, backup, message}。（首次使用：示範資料可清空）

    只刪「示範列」，使用者自己建的資料一律保留（2026-09-25 H-1：舊版整表 DELETE，
    在示範庫上直接建入的自家族人、活動、穴排位會被一起刪光，清空前也沒備份）：
      * 示範列由 _demo_targets 認定（清單＋名稱核對；舊版庫用固定特徵），辨識不到就不刪；
      * 示範成員牽涉的親子、婚姻、墓葬一併刪；使用者的活動若綁示範逝者，改成合祭（NULL）；
      * 使用者場地格子指到示範成員的：解除連結，但把當下顯示的稱呼寫成文字——
        格子不會無聲開天窗，使用者看得到、要清再自己清；
        示範場地若被使用者動過（指入自家成員、改格子文字、改抬頭或列欄設定；見 _demo_site_edited），
        視同使用者的場地保留（同樣只解除示範連結）；
      * 刪之前先做安全網備份，備份失敗就中止、一筆不刪（500）。
    清完移除 demo_data／demo_manifest（引導條與清空鈕隨之消失），
    示範房頭（長房／次房）沒人用的就從房頭設定拿掉（其他房頭不動）；之後不再重灌示範，
    由 db.seed_demo「members 曾經有過資料就不灌」負責。
    真實資料庫（demo_data 非 '1'）一律 403，絕不誤刪。
    """
    if not _LOCK["editMode"]:
        raise ApiError(403, "edit mode required")
    from .tombsites import _json_list, honor_label  # noqa: PLC0415
    conn = _conn()
    try:
        row = conn.execute("SELECT value FROM settings WHERE key = 'demo_data'").fetchone()
        if not row or (row["value"] or "") != "1":
            raise ApiError(403, "此資料庫並非示範資料，不可清空（僅示範資料庫提供此功能）")
    finally:
        conn.close()
    try:
        saved = _safety_backup()
    except Exception as e:
        raise ApiError(500, "清空前自動備份失敗（%s），為保護您的資料已中止，沒有刪除任何資料。" % e)

    conn = _conn()
    try:
        mem, evs, sites = _demo_targets(conn)
        info = {}
        if mem:
            q = ",".join("?" * len(mem))
            info = {r["id"]: r for r in conn.execute(
                "SELECT id, name, generation_name, gender FROM members WHERE id IN (%s)" % q, list(mem))}
        # 場地格子：示範場地被使用者動過（指入自家成員、改格子文字、改抬頭或列欄）就保留；
        # 其餘場地解除指向示範成員的連結（稱呼寫成文字）
        for s in conn.execute("SELECT id, title, subtitle, footer, rows, cols, row_labels, cells "
                              "FROM tomb_sites").fetchall():
            cells = _json_list(s["cells"])
            linked = {int(c["memberId"]) for c in cells if isinstance(c, dict) and c.get("memberId")}
            if s["id"] in sites and _demo_site_edited(conn, s, cells, info):
                sites.discard(s["id"])
            if s["id"] in sites or not (linked & mem):
                continue
            for c in cells:
                if isinstance(c, dict) and c.get("memberId") and int(c["memberId"]) in mem:
                    c["text"] = str(c.get("text") or "") or honor_label(info[int(c["memberId"])])
                    c["memberId"] = None
            conn.execute("UPDATE tomb_sites SET cells = ? WHERE id = ?",
                         (json.dumps(cells, ensure_ascii=False), s["id"]))
        if mem:
            ids = list(mem)
            q = ",".join("?" * len(ids))
            # 先刪關聯（FK RESTRICT），再刪成員
            conn.execute("DELETE FROM relationships WHERE parent_id IN (%s) OR child_id IN (%s)" % (q, q), ids + ids)
            conn.execute("DELETE FROM marriages WHERE spouse_1_id IN (%s) OR spouse_2_id IN (%s)" % (q, q), ids + ids)
            conn.execute("DELETE FROM tombs WHERE member_id IN (%s)" % q, ids)
            conn.execute("UPDATE ritual_events SET deceased_member_id = NULL WHERE deceased_member_id IN (%s)" % q, ids)
        for table, idset in (("ritual_events", evs), ("tomb_sites", sites), ("members", mem)):
            if idset:
                conn.execute("DELETE FROM %s WHERE id IN (%s)" % (table, ",".join("?" * len(idset))), list(idset))
        # 示範房頭（seed_demo 寫進 settings.branches 的那組）：剩下的成員沒人用的，逐一從房頭清單拿掉，
        # 其他房頭（匯入時自動併進來的、使用者自己加的）原樣保留、順序不動。
        # （驗證員 2026-10-02：舊寫法要求整份清單「完全等於」示範那組才清——示範還沒清就先匯入自家名冊，
        #  匯入會把「大房」等併進清單，清空示範後長房／次房就永遠留在房頭下拉與樹狀圖色序裡。）
        man = conn.execute("SELECT value FROM settings WHERE key = 'demo_manifest'").fetchone()
        try:
            demo_br = json.loads(man["value"]).get("branches") if man and man["value"] else None
        except (ValueError, TypeError, AttributeError):
            demo_br = None
        cur_br = conn.execute("SELECT value FROM settings WHERE key = 'branches'").fetchone()
        if isinstance(demo_br, list) and demo_br and cur_br:
            cur = _branches_from_value(cur_br["value"])
            used = {r["branch"] for r in conn.execute(
                "SELECT DISTINCT branch FROM members WHERE branch IN (%s)" % ",".join("?" * len(demo_br)), demo_br)}
            drop = set(demo_br) - used
            if drop & set(cur):
                conn.execute("UPDATE settings SET value = ? WHERE key = 'branches'",
                             (_branches_to_value([b for b in cur if b not in drop]),))
        conn.execute("DELETE FROM settings WHERE key IN ('demo_data', 'demo_manifest')")
        conn.commit()
        kept = sum(conn.execute("SELECT COUNT(*) AS c FROM %s" % t).fetchone()["c"]
                   for t in ("members", "ritual_events", "tomb_sites"))
    finally:
        conn.close()
    deleted = len(mem) + len(evs) + len(sites)
    if deleted:
        msg = "已刪除示範資料 %d 筆；您自己建立的資料 %d 筆均保留。" % (deleted, kept)
    else:
        msg = ("找不到可辨識的示範資料（可能已被您改名或刪除），沒有刪除任何資料；"
               "您自己建立的資料 %d 筆均保留。" % kept)
    return {"ok": True, "deleted": deleted, "kept": kept, "backup": saved, "message": msg}


def _active_db_path() -> Path:
    """目前實際開啟中的資料庫路徑。

    以 db._DB_PATH（init_db 設定）為準——與 auto_backup 一致；backup/restore 一律
    走這裡，臨時庫（測試/工具）的備份還原就不會誤打到程式檔旁的真實 繫族.db
    （2026-07-05 事故根因：舊版直接用 resolve_db_path() 定位，無視 init 的路徑）。
    尚未 init 時退回 resolve_db_path()。
    """
    import db  # noqa: PLC0415
    p = getattr(db, "_DB_PATH", None)
    return Path(p) if p else resolve_db_path()


def _backup_dir() -> Path:
    """所有備份的落點：資料庫同層的 backups\\（與 auto_backup 同一處）。"""
    return _active_db_path().resolve().parent / "backups"


def _unique_backup_path(prefix: str) -> Path:
    """backups\\<prefix><日期-時間>.db；同一秒已有同名檔就加 -2、-3……
    （立即備份後馬上還原，還原前的安全網備份不能蓋掉使用者剛做、正要拿來還原的那份）。"""
    import datetime  # noqa: PLC0415
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    target, n = _backup_dir() / ("%s%s.db" % (prefix, stamp)), 2
    while target.exists():
        target, n = _backup_dir() / ("%s%s-%d.db" % (prefix, stamp, n)), n + 1
    return target


def backup() -> dict:
    """POST /api/backup → {file, folder}（file＝備份檔完整路徑、folder＝所在資料夾，供畫面顯示）。
    委派 db.backup() 以 VACUUM INTO 產單檔，寫進 backups\\「繫族-備份-日期-時間.db」。

    2026-09-25 體檢 backend-6／opensource-2：舊版寫在 exe（資料庫）旁邊，操作手冊卻說在 backups 資料夾，
    出事時照手冊找不到。檔名前綴「繫族-備份-」與自動備份的「自動備份_」「編輯前_」不同，
    auto_backup 的輪替（只刪同 tag 前綴的舊檔）不會刪到手動備份。"""
    import db  # noqa: PLC0415
    out = db.backup(str(_unique_backup_path("繫族-備份-")))
    return {"file": out, "folder": str(Path(out).parent)}


def _safety_backup() -> str:
    """整庫覆蓋／大量刪除前的安全網 → 回備份檔路徑；兩種方法都失敗才丟例外（呼叫端據此中止）。

    先走 backup()（VACUUM INTO）；失敗時（例如現有庫已損壞——這正是使用者要還原的時候）
    改成原封複製資料庫檔與 -wal，壞掉的原檔也留得住，事後還有東西可以救。
    兩種都寫進 backups\\（與「立即備份」、自動備份同一處；體檢 backend-6）。
    """
    import shutil  # noqa: PLC0415
    try:
        return backup()["file"]
    except Exception as e:  # noqa: BLE001
        first = e
    src = _active_db_path()
    target = _unique_backup_path("繫族-備份原檔-")
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(str(src), str(target))
        if Path(str(src) + "-wal").exists():
            shutil.copyfile(str(src) + "-wal", str(target) + "-wal")
    except Exception as e:  # noqa: BLE001
        _drop_with_sidecars(target)            # 複製到一半的殘檔不留（免得被當成完整備份）
        raise RuntimeError("%s；改用原檔複製也失敗：%s" % (first, e))
    return str(target)


def auto_backup(tag: str = "自動備份", keep: int = 5) -> str:
    """自動快照（規格 §3「解鎖自動快照」、§5「自動備份」）。

    以 VACUUM INTO 產生「資料庫同層 backups\\」下的單檔備份：
      * 啟動序（app.py init_db 後）：tag='自動備份' → 自動備份_YYYY-MM-DD.db
        （同日重啟覆蓋同檔，等於每日最多一份）。
      * 解鎖進編輯模式（unlock 成功後）：tag='編輯前' → 編輯前_YYYY-MM-DD_HHMMSS.db
        （帶時分秒，掃墓現場多次解鎖各留一份，改壞可還原回編輯前）。
    同 tag 僅保留最近 keep 份，逾者刪（檔名含 ISO 日期，字典序即時間序）。
    路徑跟著 db 目前開啟的資料庫走（測試臨時庫寫進臨時目錄，不碰真實庫旁）。
    失敗以例外拋回；呼叫端（app.py 啟動序／unlock）自行 try 不阻斷主流程。
    回傳實際寫出的備份檔絕對路徑。
    """
    import db  # noqa: PLC0415
    import datetime  # noqa: PLC0415
    if getattr(db, "_DB_PATH", None) is None:
        raise RuntimeError("資料庫尚未初始化，無法自動備份")
    base = Path(db._DB_PATH).resolve().parent / "backups"
    now = datetime.datetime.now()
    stamp = now.strftime("%Y-%m-%d") if tag == "自動備份" else now.strftime("%Y-%m-%d_%H%M%S")
    out = db.backup(str(base / ("%s_%s.db" % (tag, stamp))))
    if keep > 0:
        olds = sorted(base.glob("%s_*.db" % tag), key=lambda p: p.name)
        for p in olds[:-keep]:
            try:
                p.unlink()
            except OSError:
                pass  # 清舊份失敗不影響本次備份
    return out


# 繫族備份必備的表與關鍵欄（別的程式的 SQLite 過不了這關）；較新的表／欄由 init_db 遷移補上
_RESTORE_REQUIRED = {
    "members": ("id", "name", "generation_number"),
    "relationships": ("parent_id", "child_id"),
    "settings": ("key", "value"),
}


def _not_backup(reason) -> ApiError:
    return ApiError(400, "這不是完整的繫族備份（%s），現有資料庫完全沒有變動。" % reason)


def _drop_with_sidecars(p) -> None:
    """刪掉暫存檔連同 SQLite 的 -wal／-shm／-journal（不存在就略過）。"""
    for suffix in ("", "-wal", "-shm", "-journal"):
        try:
            Path(str(p) + suffix).unlink()
        except OSError:
            pass


def _install_backup(fill) -> dict:
    """還原共用管線（restore／restore_upload 都走這裡）→ {ok, backup}。

    2026-09-25 H-4：舊版只驗 16 bytes 檔頭就整份蓋上去——截斷的備份、別的程式的 .db 照蓋，
    蓋完 API 全 500、重開程式直接當掉；舊版 schema 的備份蓋上去沒跑遷移，不重開就 500；
    覆蓋前的備份失敗還被吞掉。現在的順序（1～4 任一步失敗，正式庫一個 byte 都不動）：
      1. fill(tmp)：內容先寫到「正式庫同資料夾」的暫存檔（同一磁碟，最後才能原子替換）；
      2. 暫存檔 PRAGMA integrity_check 必須是 ok，必備表／欄都在（_RESTORE_REQUIRED）；
      3. 在暫存檔上跑 db.init_db(activate=False) 補建表／補欄位，再切回非 WAL 單檔、
         清掉暫存檔的 -wal／-shm——還原完不必重開程式就能用；
         （1～3 不過：刪暫存檔、回 400「這不是完整的繫族備份」）
      4. 備份現況（_safety_backup）；正式庫存在而備份失敗 → 500 中止，不在沒有退路時覆蓋；
      5. 清掉正式庫的 -wal／-shm（舊交易不可套到新庫上），os.replace 原子替換。
    """
    import os  # noqa: PLC0415
    import sqlite3  # noqa: PLC0415
    import tempfile  # noqa: PLC0415
    import db  # noqa: PLC0415
    dst = _active_db_path()
    fd, name = tempfile.mkstemp(prefix="繫族-還原暫存-", suffix=".db", dir=str(dst.resolve().parent))
    os.close(fd)
    tmp = Path(name)
    try:
        fill(tmp)
        try:
            conn = sqlite3.connect(str(tmp))
            try:
                check = [r[0] for r in conn.execute("PRAGMA integrity_check").fetchall()]
                cols = {t: {r[1] for r in conn.execute("PRAGMA table_info(%s)" % t)} for t in _RESTORE_REQUIRED}
            finally:
                conn.close()
        except sqlite3.DatabaseError:
            raise _not_backup("檔案損壞或不完整，可能沒有複製完整")
        if check != ["ok"]:
            raise _not_backup("檔案損壞或不完整，可能沒有複製完整")
        missing = [t for t, need in _RESTORE_REQUIRED.items() if not set(need) <= cols[t]]
        if missing:
            raise _not_backup("缺少族譜資料表 %s，可能是別的程式的資料庫" % "、".join(missing))
        try:
            db.init_db(str(tmp), activate=False)      # 舊版備份：補表補欄，不切換目前開啟的庫
            conn = sqlite3.connect(str(tmp))
            try:
                conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                conn.execute("PRAGMA journal_mode = DELETE")   # 收成單檔（下次 db.connect 自會切回 WAL）
            finally:
                conn.close()
        except sqlite3.DatabaseError as e:
            raise _not_backup("無法套用本版資料結構：%s" % e)
        for suffix in ("-wal", "-shm"):
            Path(str(tmp) + suffix).unlink(missing_ok=True)
    except BaseException:
        _drop_with_sidecars(tmp)
        raise
    saved = ""
    if dst.exists():
        try:
            saved = _safety_backup()
        except Exception as e:  # noqa: BLE001
            _drop_with_sidecars(tmp)
            raise ApiError(500, "還原前自動備份現有資料失敗（%s）；為避免沒有退路，已中止還原，"
                                "現有資料庫完全沒有變動。" % e)
    try:
        try:                               # 先把現況的 WAL 併回主檔：萬一下面替換失敗，現有庫也不缺交易
            conn = sqlite3.connect(str(dst))
            try:
                conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            finally:
                conn.close()
        except sqlite3.DatabaseError:
            pass                           # 現有庫已損壞就不強求（上面已原封備份）
        for suffix in ("-wal", "-shm"):    # WAL 副檔一併清掉，避免舊交易套到新庫上（現況已備份）
            p = Path(str(dst) + suffix)
            if p.exists():
                p.unlink()
        os.replace(str(tmp), str(dst))
    except OSError as e:
        # 檔案被別的程式占用（另一個繫族視窗、防毒軟體）時 Windows 不准刪改：講白話，不要只回 internal error
        # （第一批驗證 L-3a：舊版連損壞庫的連線都沒關，自己就把檔案鎖住了）
        _drop_with_sidecars(tmp)
        raise ApiError(500, "還原沒有完成：資料庫檔正被其他程式使用，無法替換（%s）。現有資料庫沒有被覆蓋%s。"
                            "請關閉其他繫族視窗或稍候片刻，再按一次還原。"
                       % (e.__class__.__name__, "，還原前的備份在 %s" % saved if saved else ""))
    except BaseException:
        _drop_with_sidecars(tmp)
        raise
    return {"ok": True, "backup": saved}


def restore(file) -> dict:
    """POST /api/restore {file}（需編輯模式）→ {ok, backup}。舊契約路徑版還原。

    護欄（比照 restore_upload，堵住「任意檔覆蓋資料庫」）：
      1. 路徑白名單：file 只能落在資料庫同層或 backups/ 內（相對檔名自動併入 backups/）；
      2. 驗 SQLite 檔頭，非資料庫檔一律拒絕；
      3. 其餘（完整性／必備表／遷移／覆蓋前備份／原子替換）同 _install_backup。
    前端正常還原走 /restore/upload；此路徑保留相容，但不再是任意檔破口。
    """
    if not _LOCK["editMode"]:
        raise ApiError(403, "edit mode required")
    import shutil  # noqa: PLC0415
    if not file:
        raise ApiError(400, "缺少備份檔")
    dbdir = _active_db_path().resolve().parent
    src = Path(file)
    if not src.is_absolute():          # 相對檔名 → 併入備份目錄
        src = dbdir / "backups" / src.name
    src = src.resolve()
    allowed = {dbdir, (dbdir / "backups").resolve()}
    if src.parent not in allowed:
        raise ApiError(403, "只能還原資料庫目錄或 backups/ 內的備份檔")
    if not src.is_file():
        raise ApiError(400, "備份檔不存在")
    with open(src, "rb") as _f:        # 驗 SQLite 檔頭（同 restore_upload）
        if _f.read(16) != b"SQLite format 3\x00":
            raise _not_backup("不是 SQLite 資料庫檔")
    return _install_backup(lambda tmp: shutil.copyfile(str(src), str(tmp)))


def restore_upload(data) -> dict:
    """POST /api/restore/upload（application/octet-stream）→ {ok, backup}。
    使用者從前端選檔上傳備份後還原：驗 SQLite 檔頭 → _install_backup（驗完整性、遷移、備份現況、原子替換）。"""
    if not _LOCK["editMode"]:   # 與 restore() 同級守門：整庫覆蓋是最重的寫入，瀏覽模式不得觸發
        raise ApiError(403, "edit mode required")
    if not data or len(data) < 100 or bytes(data[:16]) != b"SQLite format 3\x00":
        raise _not_backup("不是 SQLite 資料庫檔")
    return _install_backup(lambda tmp: tmp.write_bytes(bytes(data)))


def check_update() -> dict:
    """GET /api/update/check。讀 settings.github_repo，代打 GitHub Releases 比對版本。
    系統本體離線；僅此函式於使用者按下「檢查更新」時連網（timeout 6 秒，失敗回友善訊息）。"""
    import json as _json  # noqa: PLC0415
    import urllib.request  # noqa: PLC0415
    conn = _conn()
    try:
        row = conn.execute("SELECT value FROM settings WHERE key='github_repo'").fetchone()
    finally:
        conn.close()
    repo = ((row["value"] if row else "") or "").strip()
    if not repo:
        return {"configured": False, "current": APP_VERSION}
    req = urllib.request.Request(
        "https://api.github.com/repos/%s/releases/latest" % repo,
        headers={"User-Agent": "KinLink-Updater", "Accept": "application/vnd.github+json"})
    try:
        with urllib.request.urlopen(req, timeout=6) as r:
            data = _json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        # 404 幾乎一定是「repo 是私人的」或「還沒建任何 release」，不是網路問題——講清楚，
        # 免得總幹事去查網路線（2026-09-04 開源前實測：私人 repo＋0 release 就是這個）。
        if e.code == 404:
            msg = ("GitHub 找不到「%s」的發佈（404）：repo 若是私人的，未登入的程式看不到；"
                   "或是尚未建立任何 release。請在 GitHub 上公開 repo 並發佈附 .exe 的 release。" % repo)
        else:
            msg = "GitHub 回應 HTTP %d；請稍後再試或確認 repo 名稱。" % e.code
        return {"configured": True, "current": APP_VERSION, "error": msg}
    except Exception as e:
        return {"configured": True, "current": APP_VERSION,
                "error": "無法連線 GitHub（%s）；請確認網路。" % e.__class__.__name__}
    latest = str(data.get("tag_name") or data.get("name") or "").lstrip("vV")
    asset_url, asset_digest, asset_size = "", "", 0
    for a in data.get("assets") or []:
        if str(a.get("name") or "").lower().endswith(".exe"):
            asset_url = a.get("browser_download_url") or ""
            # GitHub 自 2025 起在 asset 上附 sha256 digest（"sha256:<hex>"）；下載端據此驗檔。
            asset_digest = str(a.get("digest") or "").strip().lower()
            try:
                asset_size = int(a.get("size") or 0)
            except (TypeError, ValueError):
                asset_size = 0
            break

    def _ver(t):  # 簡易語意版本比較（非數字視為 0）
        out = []
        for p in str(t).split("."):
            digits = "".join(ch for ch in p if ch.isdigit())
            out.append(int(digits) if digits else 0)
        return out

    has = bool(latest) and _ver(latest) > _ver(APP_VERSION)
    return {"configured": True, "current": APP_VERSION, "latest": latest or "?",
            "hasUpdate": has, "assetUrl": asset_url,
            "assetDigest": asset_digest, "assetSize": asset_size,
            "notes": str(data.get("body") or "")[:1000]}


_UPDATE_HOSTS = ("github.com", "githubusercontent.com")   # 更新檔只准從 GitHub 下載


def _old_exe_name(exe_name: str) -> str:
    """換版後保留的舊版檔名：「繫族.exe」→「繫族-舊版.exe」（下次更新覆蓋）。"""
    stem = exe_name[:-4] if exe_name.lower().endswith(".exe") else exe_name
    return stem + "-舊版.exe"


_OLD_SUFFIX = "-舊版.exe"


def _update_target(running_name: str):
    """「下載更新」要換掉哪個檔：回傳 (換版目標檔名, 是否從保留的舊版啟動)。

    使用者直接雙擊「繫族-舊版.exe」用回舊版（沒照說明先改回「繫族.exe」）再按「下載更新」：
    舊寫法拿執行中的檔名當目標，新版被裝成「繫族-舊版.exe」、舊的那份改名成「繫族-舊版-舊版.exe」，
    原本有問題的「繫族.exe」原封不動，捷徑照樣開到壞的那版（第二批驗證員 backend 低 2）。
    現在目標一律改回正式檔名，並告訴 bat「目前用的這份舊版要留著」（見 _apply_bat_text 的 keep_old）。
    """
    if running_name.lower().endswith(_OLD_SUFFIX.lower()) and len(running_name) > len(_OLD_SUFFIX):
        return running_name[:-len(_OLD_SUFFIX)] + ".exe", True
    return running_name, False


# cmd 的動態變數：不在環境變數表裡，cmd 照樣會展開
_CMD_DYNAMIC_VARS = {"CD", "DATE", "TIME", "RANDOM", "ERRORLEVEL", "CMDEXTVERSION", "CMDCMDLINE",
                     "HIGHESTNUMANODENUMBER", "__APPDIR__", "__CD__"}


def _cmd_expands(path: str) -> str:
    """path 裡夾在兩個 % 之間、cmd 會當成變數展開的字樣（例如「%OS%」）；沒有就回 ''。

    這種資料夾裡的 .bat 根本執行不了：雙擊時 cmd 在讀到 bat 之前就把路徑展開錯，
    只閃一下「系統找不到指定的路徑」（2026-10-02 實測；連在該資料夾裡打「套用更新.bat」也一樣），
    bat 自己管不到，只能事先講清楚。只有一個 %（如「100% 測試」）或不是變數名稱的不受影響。
    """
    import os  # noqa: PLC0415
    names = {k.upper() for k in os.environ} | _CMD_DYNAMIC_VARS
    marks = [i for i, ch in enumerate(path) if ch == "%"]
    for a, i in enumerate(marks):
        for j in marks[a + 1:]:
            name = path[i + 1:j].split(":")[0].upper()     # %VAR:~0,2% 這類子字串寫法也算
            if name and name in names:
                return path[i:j + 1]
    return ""


def _apply_bat_text(exe_name: str, keep_old: bool = False) -> str:
    """產生「套用更新.bat」的內容（純函式，供 tests/test_update_bat.py、test_m4_update_bat.py、
    test_b3_bat_dbcs.py 離線驗證）。

    四道防呆（舊版三者皆無，殘留的 bat 被誤點會 del 掉唯一的 exe＝程式消失）：
      1. 沒有「繫族_new.exe」就什麼都不做，並把自己刪掉（殘留 bat 再被點走這條）。
      2. 先確認繫族已關閉：執行中的程式檔無法以「寫入」開啟，開得了才換版；
         還開著就提示「請先關閉繫族」並等待，約 30 秒仍沒關就放棄、檔案一個都不動。
         （2026-09-25 體檢 release-1：舊版用「能否改名」判斷，但 Windows 允許替執行中的
         exe 改名，程式沒關也照樣換版、再開第二個。）唯讀的程式檔先拿掉唯讀屬性，免得被誤判成還開著。
      3. 舊版不刪，改名保留成「繫族-舊版.exe」（上一份舊版被這次覆蓋）：新版壞了，
         使用者把它改回「繫族.exe」就能回到舊版（體檢 release-10）；換檔失敗則立刻改回來。
         用 move /y 一步完成「改名＋覆蓋上一份舊版」：改名失敗（防毒占用）時上一份舊版原封不動，
         「所有檔案都沒有變動」才是真話（先 del 再 ren 會在 ren 失敗時白白刪掉上一份舊版）。
         0.2.1 的 bat 換到一半中斷只留「繫族.exe.old」：一樣先救回來再換，不留殘檔。
      4. 所有檔名一律加引號、分支用 goto 不在括號區塊裡印檔名——
         exe 檔名含括號（瀏覽器重複下載的「繫族 (1).exe」）、&、% 時不會語法錯誤中斷（體檢 security-4）。
         for /f 的子指令會被 cmd /c 再做一次 % 展開：自己的路徑先放進 SELF 變數、由子指令展開，
         資料夾名稱含已定義的環境變數（如「%OS%」）時才不會被展開成錯的路徑而讀不到資料區。
      5. keep_old=True（使用者是從保留的「繫族-舊版.exe」啟動再按下載更新，見 _update_target）：
         EXE 是正式檔名，OLD 正是目前在用、使用者特意退回的那份。先把現有的 EXE（多半是有問題的新版）
         挪成 EXE.old，下面「上次中斷」那行就會把 OLD 改回 EXE，之後照一般流程等它關閉、改名保留成 OLD、
         新版上位，EXE.old 換版成功後刪掉——留下來的舊版是使用者退回的那份，不是有問題的那份。
         EXE 挪不動（還開著）就走「改名失敗、所有檔案都沒有變動」。

    **可執行的部分一律純 ASCII，中文（訊息與檔名）全放在檔尾的資料區**，開頭用 findstr 讀進變數再 echo。
    原因：繁中（cp950 等雙位元組）Windows 的 cmd 逐行讀批次檔時，仍用系統雙位元組碼頁的規則切位元組
    （0x81–0xFE 當「前半」、連下一個位元組一起吃），chcp 65001 前後都一樣。UTF-8 中文的位元組被這樣兩兩
    配對，一行從行首配下來若最後剩一個「前半」，就會把行尾的 CR 吃掉；這時**下一行只要含非 ASCII**，
    cmd 就從錯的位置讀下一行，中文被切開、半句被當成指令跑（「'這個用不到的更新腳本。' is not recognized」）。
    下一行是純 ASCII 則不受影響（第三批實測：預測規則與實跑 160／160 吻合；「。」「、」結尾最常中，
    但同一個字中不中取決於整行位元組的奇偶，看不出來）。tests/test_b3_bat_dbcs.py 對專案內每支 .bat
    與這裡產生的 bat 做靜態檢查（非 ASCII 結尾的行，下一行不得含非 ASCII），並實跑各分支。
    資料區在自我刪除那一行之後、永遠不會被執行，goto 也只往前找、碰不到它。
    資料行格式「KL_名稱|值」：| 不可能出現在 Windows 檔名裡；檔名在資料區不必跳脫 %（不經 % 展開）。

    回傳字串一律以 \\r\\n 換行；呼叫端**必須**用 write_bytes 寫出
    （write_text 會把 \\r\\n 再翻成 \\r\\r\\n，違反專案鐵律「.bat 一律 CRLF」）。
    """
    data = [
        ("EXE", exe_name),
        ("NEW", "繫族_new.exe"),
        ("OLD", _old_exe_name(exe_name)),
    ] + ([("KEEP", "1")] if keep_old else []) + list(_BAT_MESSAGES)
    return "\r\n".join([
        "@echo off",
        "chcp 65001 >nul",
        'cd /d "%~dp0"',
        "rem KinLink updater. Every line above the DATA section must stay pure ASCII:",
        "rem cmd misreads UTF-8 batch lines after chcp 65001 (see kinlink/maintenance.py).",
        "rem Chinese messages and file names are loaded from the DATA section at the end.",
        "rem The child cmd of for /f expands percent-variables a second time: it gets our own path",
        "rem through the SELF variable, so a folder name containing e.g. OS between percent signs stays intact.",
        'set "SELF=%~f0"',
        'set "KL_KEEP="',
        'set "PARKED="',
        'for /f "tokens=1,* delims=|" %%a in (\'findstr /b /c:"KL_" "%%SELF%%"\') do set "%%a=%%b"',
        "if not defined KL_EXE goto :nodata",
        'set "EXE=%KL_EXE%"',
        'set "NEW=%KL_NEW%"',
        'set "OLD=%KL_OLD%"',
        "",
        "rem -- guard 1: no new version file, change nothing --",
        'if not exist "%NEW%" goto :nonew',
        "",
        "rem -- started from the kept old copy (KL_KEEP): that copy is the version the user went back to.",
        "rem    Park the current EXE as EXE.old (deleted once the new one is in place); the next block then",
        "rem    renames OLD back to EXE and the normal path keeps it as OLD again. Cannot move EXE: change nothing.",
        'if defined KL_KEEP if exist "%EXE%" attrib -r "%EXE%" >nul 2>&1',
        'if defined KL_KEEP if exist "%EXE%" move /y "%EXE%" "%EXE%.old" >nul 2>&1',
        'if defined KL_KEEP if exist "%EXE%" goto :renfail',
        "rem    from here on files HAVE moved: a later give-up must not claim nothing changed (L-6)",
        'if defined KL_KEEP set "PARKED=1"',
        "",
        "rem -- interrupted last time (old renamed, new not in place): restore the old one first --",
        "rem    (also the EXE.old file left behind by the 0.2.1 updater)",
        'if not exist "%EXE%" if exist "%OLD%" ren "%OLD%" "%EXE%"',
        'if not exist "%EXE%" if exist "%EXE%.old" ren "%EXE%.old" "%EXE%"',
        "echo %KL_START%",
        "rem a read-only exe cannot be opened for writing either; clear it so it is not mistaken as running",
        'if exist "%EXE%" attrib -r "%EXE%" >nul 2>&1',
        'if not exist "%EXE%" goto :install',
        "",
        "rem -- guard 2: a running exe cannot be opened for writing (renaming is NOT blocked) --",
        "for /l %%i in (1,1,15) do (",
        '  2>nul (>>"%EXE%" (call )) && goto :closed',
        "  echo %KL_WAIT% %%i/15",
        "  ping -n 3 127.0.0.1 >nul",
        ")",
        "echo.",
        "if defined PARKED goto :parkedmsg",
        "echo %KL_BUSY1%",
        "echo %KL_BUSY2%",
        "pause",
        "exit /b 1",
        "",
        "rem -- guard 3: keep the old version (renamed, not deleted); the previous old copy is replaced --",
        "rem    move /y renames and replaces in one step: if it fails, the previous old copy is untouched",
        ":closed",
        'if exist "%OLD%" attrib -r "%OLD%" >nul 2>&1',
        'move /y "%EXE%" "%OLD%" >nul 2>&1',
        'if exist "%EXE%" goto :renfail',
        'if exist "%EXE%.old" del "%EXE%.old" >nul 2>&1',
        "",
        ":install",
        'ren "%NEW%" "%EXE%"',
        'if not exist "%EXE%" goto :rollback',
        "echo.",
        "echo %KL_DONE%",
        'if /i not "%~1"=="/nostart" start "" "%EXE%"',
        'if not exist "%OLD%" goto :selfdel',
        "echo.",
        'echo %KL_KEPT% "%OLD%"',
        'echo %KL_BACK1% "%EXE%" %KL_BACK2% "%OLD%" %KL_BACK3% "%EXE%"%KL_BACK4%',
        "echo %KL_CLOSE%",
        "pause >nul",
        "goto :selfdel",
        "",
        ":rollback",
        "echo %KL_RB%",
        'if exist "%OLD%" ren "%OLD%" "%EXE%"',
        'if exist "%EXE%" goto :rolledback',
        'echo %KL_RBFAIL% "%OLD%"',
        "pause",
        "exit /b 1",
        "",
        ":rolledback",
        "echo %KL_RBOK%",
        "pause",
        "exit /b 1",
        "",
        ":renfail",
        "if defined PARKED goto :parkedmsg",
        "echo %KL_RENFAIL1%",
        "echo %KL_RENFAIL2%",
        "pause",
        "exit /b 1",
        "",
        "rem -- gave up after the kept old copy was already moved back to EXE (KL_KEEP) --",
        ":parkedmsg",
        "echo %KL_PARK1%",
        'echo %KL_PARK2% "%EXE%" %KL_PARK3%',
        'if exist "%EXE%.old" echo %KL_PARK4% "%EXE%.old"%KL_PARK5%',
        "echo %KL_PARK6%",
        "pause",
        "exit /b 1",
        "",
        ":nonew",
        'echo %KL_NONEW1% "%NEW%"',
        "echo %KL_NONEW2%",
        "pause",
        "goto :selfdel",
        "",
        ":nodata",
        "echo KinLink update script could not read its own text. Nothing was changed.",
        "pause",
        "exit /b 1",
        "",
        "rem -- self-delete so a leftover script cannot be clicked again (last executed line) --",
        ":selfdel",
        '(goto) 2>nul & del "%~f0"',
        "",
        "rem ===== DATA (never executed; read by findstr above) =====",
    ] + ["KL_%s|%s" % kv for kv in data] + [""])


# 套用更新.bat 的中文訊息（放進資料區；值裡不可有 | 與 ASCII 的 & ( ) < > ^ %，echo 時才不會被當語法）
_BAT_MESSAGES = (
    ("START", "正在套用繫族更新..."),
    ("WAIT", "繫族還開著：請先關閉繫族的視窗，關閉後會自動繼續。每兩秒檢查一次，已檢查"),
    ("BUSY1", "繫族似乎仍在執行（已等約 30 秒），這次沒有更新，所有檔案都沒有變動。"),
    ("BUSY2", "請先關閉繫族（視窗關不掉時可重新開機），再雙擊本檔一次。"),
    ("DONE", "更新完成，正在啟動新版..."),
    ("KEPT", "舊版已保留為"),
    ("BACK1", "若新版有問題：先把新的"),
    ("BACK2", "改名或刪掉，再把"),
    ("BACK3", "改回"),
    ("BACK4", "，就能用回舊版。"),
    ("CLOSE", "看完這段說明，按任意鍵關閉這個視窗即可。"),
    ("RB", "換檔失敗，正在還原舊版..."),
    ("RBFAIL", "還原失敗，請聯絡技術協力人員；舊版檔名為"),
    ("RBOK", "已還原舊版，更新未完成，程式仍可正常使用。"),
    ("RENFAIL1", "舊版程式檔改名失敗（可能被防毒軟體或其他程式占用），這次沒有更新，所有檔案都沒有變動。"),
    ("RENFAIL2", "請稍後再雙擊本檔一次。"),
    # 從保留的舊版啟動（KL_KEEP）、檔案已挪過之後才放棄：照實說目前是哪一版（L-6）
    ("PARK1", "這次沒有更新完成（繫族似乎仍在執行，或檔案被其他程式占用）。"),
    ("PARK2", "目前的"),
    ("PARK3", "就是你退回的那一版，可以照常使用。"),
    ("PARK4", "有問題的那一版暫存為"),
    ("PARK5", "，下次更新成功時會自動刪除。"),
    ("PARK6", "請先關閉繫族，再雙擊本檔一次即可完成更新。"),
    ("NONEW1", "找不到新版程式檔"),
    ("NONEW2", "代表更新已經套用過、或下載沒有完成。本次不會變更任何檔案，並會移除這個用不到的更新腳本。"),
)


def download_update() -> dict:
    """POST /api/update/download（需編輯模式）。半自動改版（可攜 exe 無法自我覆蓋）：
    下載最新 .exe 到 exe 同層存成「繫族_new.exe」，並產生「套用更新.bat」；
    使用者關閉程式後雙擊 bat 即完成換檔並啟動新版。

    下載端四道守門：來源網域限 GitHub、先落 .part 再改名（半截檔不會被 bat 拿去上位）、
    比對 Content-Length／release 登記的 size 與最小檔案大小、
    **sha256 比對 GitHub release asset 的 digest**（有給就必驗；對不上就刪檔中止——
    這是要拿去換掉主程式的檔案，長度對了不代表內容對）。
    下載途中斷線／逾時：刪掉 .part、回 502 白話訊息（2026-09-25 體檢 security-7：
    舊版一路丟成「API 500：internal error」，總幹事分不出是網路問題還是程式壞了）。
    資料夾路徑含「%OS%」這類會被 cmd 展開的字樣時不下載、回 400 說明（見 _cmd_expands）。
    """
    import errno  # noqa: PLC0415
    import http.client  # noqa: PLC0415
    import urllib.error  # noqa: PLC0415
    import urllib.parse  # noqa: PLC0415
    import urllib.request  # noqa: PLC0415
    if not _LOCK["editMode"]:
        raise ApiError(403, "edit mode required")
    info = check_update()
    if not info.get("configured"):
        raise ApiError(400, "尚未設定發佈來源（owner/repo）")
    if info.get("error"):
        raise ApiError(502, info["error"])
    url = info.get("assetUrl")
    if not url:
        raise ApiError(404, "最新發佈未附 .exe 檔，請至 GitHub 頁面手動下載")
    parts = urllib.parse.urlsplit(url)
    host = (parts.hostname or "").lower()
    if parts.scheme != "https" or not any(host == h or host.endswith("." + h) for h in _UPDATE_HOSTS):
        raise ApiError(502, "更新檔來源不是 GitHub（%s），已中止下載。" % (host or "未知"))

    base = resolve_db_path().parent   # exe 旁（frozen）／專案根（原始碼）。勿用 __file__：拆模組後會落在 kinlink/ 內
    bad = _cmd_expands(str(base))
    if bad:   # 先擋：下載完也換不了版（套用更新.bat 在這個資料夾裡執行不了）
        raise ApiError(400, "繫族所在的資料夾路徑含有「%s」這種前後都是 %% 的字樣，Windows 在這裡執行不了"
                            "「套用更新.bat」，所以這次沒有下載。請先關閉繫族，把資料夾改名、拿掉 %% 符號，"
                            "再開啟繫族按一次「下載更新」（目前的程式不受影響）。" % bad)
    newf = base / "繫族_new.exe"
    tmpf = base / "繫族_new.exe.part"
    req = urllib.request.Request(url, headers={"User-Agent": "KinLink-Updater"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r, open(tmpf, "wb") as f:
            expect = int(r.headers.get("Content-Length") or 0)
            while True:
                chunk = r.read(65536)
                if not chunk:
                    break
                f.write(chunk)
    except (OSError, http.client.HTTPException) as e:   # URLError／逾時／斷線都是 OSError；IncompleteRead 是 HTTPException
        tmpf.unlink(missing_ok=True)
        if isinstance(e, urllib.error.HTTPError):
            raise ApiError(502, "GitHub 回應 HTTP %d，新版沒有下載成功；請稍後再按一次「下載更新」。" % e.code)
        if getattr(e, "errno", None) == errno.ENOSPC:
            raise ApiError(502, "隨身碟（或磁碟）空間不足，新版沒有下載完成；請騰出空間後再按一次「下載更新」。")
        if isinstance(e, PermissionError):
            raise ApiError(502, "程式所在的資料夾不能寫入（可能是唯讀的隨身碟或受保護的資料夾），新版沒有下載；"
                                "請把整個繫族資料夾複製到可寫入的位置後再按一次「下載更新」。")
        raise ApiError(502, "下載中斷，請確認網路後再按一次「下載更新」（%s；下載到一半的暫存檔已清除，"
                            "目前的程式不受影響）。" % e.__class__.__name__)
    got = tmpf.stat().st_size
    want = int(info.get("assetSize") or 0) or expect
    if (want and got != want) or got < 1_000_000:
        tmpf.unlink()
        raise ApiError(502, "更新檔下載不完整（%d／%d bytes），已中止並清除暫存檔。" % (got, want))
    digest = str(info.get("assetDigest") or "")
    if digest.startswith("sha256:"):
        h = hashlib.sha256()
        with open(tmpf, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        if h.hexdigest() != digest[len("sha256:"):]:
            tmpf.unlink()
            raise ApiError(502, "更新檔 sha256 與 GitHub 登記的不符，已中止並清除暫存檔（檔案可能被竄改或下載損毀）。")
    if newf.exists():
        newf.unlink()
    tmpf.replace(newf)

    running = Path(sys.executable).name if getattr(sys, "frozen", False) else "繫族.exe"
    exe_name, keep_old = _update_target(running)     # 從「繫族-舊版.exe」啟動：換的是「繫族.exe」
    bat = base / "套用更新.bat"
    # 必須 write_bytes：write_text 會把 \r\n 翻成 \r\r\n（鐵律：.bat 一律 CRLF）
    bat.write_bytes(_apply_bat_text(exe_name, keep_old).encode("utf-8"))
    return {"ok": True, "file": newf.name, "bat": bat.name}
