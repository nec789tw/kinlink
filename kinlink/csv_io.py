# -*- coding: utf-8 -*-
"""CSV 匯出／匯入：與範本同一組欄名、member_id 更新路徑（原 server.py，R1/D1/D2）。"""
from __future__ import annotations

import re

from .errors import ApiError
from .lunar import normalize_date
from .maintenance import _branches_from_value, _branches_to_value
from .members import _is_alive, _save_burial
from .state import _LOCK, _conn

# 已過世、卒年不詳的哨兵值（death_date 非 NULL＝已歿；成員表單的「已過世（卒年不詳）」也送這個字）
_DEATH_UNKNOWN = "已歿"


def _export_parents(conn) -> dict:
    """匯出用：child_id → (父名欄那條邊, 母名欄那條邊)；邊有 name／rt 兩鍵，缺者 None。

    有設性別的親代各就各位：男→父名，女／其他→母名。同欄有多位時取承嗣主線
    （ADOPTED/FOSTER 先，再依 r.id），必須與 _father_name 同序——舊版父名子查詢沒有
    ORDER BY（LIMIT 1 靠 rowid 任取），雙軌成員匯出的父名可能與 App 顯示不一致，
    重匯時防重複因此失配、建出重複人。
    性別空白（NULL）的親代（H-3／體檢 backend-3；2026-10-02 再修）：舊版匯入器不補性別，
    舊庫裡經父名、母名接上的父母都是 NULL，只能從旁推斷：
      * 同一位子女已有男性父 → 空白那位放母名；已有女性母 → 放父名；
      * 兩位都空白 → 依上述順序先父後母（舊匯入器同一列先接父、再接母）；
      * 只有一位空白 → 看這人在別處被推成什麼（上兩條，加上配偶的性別），推成母就放
        母名；推不出就放父名（詳情卡同樣把非 F 的親代顯示成「父」）。
    放錯欄＝把人的性別改錯：這份檔拿去別的庫匯入時，匯入端會照欄位把性別補成男／女。
    舊版把 NULL 一律放母名（父親被寫進母名）；上一版一律放父名、已有男性父時兩欄都不放
    ——只有母親的人，母親被寫進父名、搬到新庫後變成男性；父母都空白的人，生母邊搬家時消失。
    """
    by_child = {}
    for e in conn.execute(
        """SELECT r.child_id AS cid, r.parent_id AS pid, r.relation_type AS rt,
                  p.name AS name, p.gender AS g
             FROM relationships r JOIN members p ON p.id = r.parent_id
            ORDER BY CASE r.relation_type WHEN 'ADOPTED' THEN 0 WHEN 'FOSTER' THEN 1 ELSE 2 END, r.id"""
    ).fetchall():
        by_child.setdefault(e["cid"], []).append(e)

    def split(es):
        fa = next((e for e in es if e["g"] == "M"), None)
        mo = next((e for e in es if e["g"] and e["g"] != "M"), None)
        return fa, mo, [e for e in es if not e["g"]]

    votes = {}   # 性別空白者 id → [像父票, 像母票]

    def vote(pid, as_mother):
        votes.setdefault(pid, [0, 0])[1 if as_mother else 0] += 1

    # 帶過繼／收養型別的空白親代必是父：舊匯入器只有「父名」欄帶關係型別，母邊一律 BIOLOGICAL。
    # 嗣父若被當成母，匯出放進母名、搬到新庫被補成女性，過繼型別也一併丟失（2026-10-02 複驗指出）。
    def adopted(e):
        return e["rt"] in ("ADOPTED", "FOSTER")

    for es in by_child.values():
        fa, mo, unk = split(es)
        for e in unk:
            if adopted(e):
                vote(e["pid"], False)
        fa = fa or next((e for e in unk if adopted(e)), None)
        unk = [e for e in unk if not adopted(e)]
        if unk and fa and not mo:
            vote(unk[0]["pid"], True)
        elif unk and mo and not fa:
            vote(unk[0]["pid"], False)
        elif len(unk) >= 2 and not fa and not mo:
            vote(unk[0]["pid"], False)
            vote(unk[1]["pid"], True)
    for w in conn.execute(
        "SELECT w.spouse_1_id AS a, w.spouse_2_id AS b, ma.gender AS ga, mb.gender AS gb "
        "FROM marriages w JOIN members ma ON ma.id = w.spouse_1_id "
        "JOIN members mb ON mb.id = w.spouse_2_id"
    ).fetchall():
        if not w["ga"] and w["gb"] in ("M", "F"):
            vote(w["a"], w["gb"] == "M")
        if not w["gb"] and w["ga"] in ("M", "F"):
            vote(w["b"], w["ga"] == "M")

    def fatherish(e):    # 空白但可確定是父：過繼／收養邊，或旁證票數偏父
        v = votes.get(e["pid"], [0, 0])
        return adopted(e) or v[0] > v[1]

    out = {}
    for cid, es in by_child.items():
        # 父名欄比照兩位都是男性時的規則：es 已按承嗣主線排序（ADOPTED/FOSTER 先，再依 r.id），取第一位；
        # 像父的空白者即使沒輪到父名，也絕不放進母名（寧可這份檔少一條邊，不把人的性別改錯）
        fa = next((e for e in es if e["g"] == "M" or (not e["g"] and fatherish(e))), None)
        mo = next((e for e in es if e["g"] and e["g"] != "M"), None)
        unk = [e for e in es if not e["g"] and e is not fa and not fatherish(e)]
        if unk and not fa and not mo:
            if len(unk) >= 2:
                fa, mo = unk[0], unk[1]
            else:
                v = votes.get(unk[0]["pid"], [0, 0])
                if v[1] > v[0]:
                    mo = unk[0]
                else:
                    fa = unk[0]
        elif unk and not fa:
            fa = unk[0]
        elif unk and not mo:
            mo = unk[0]
        out[cid] = (fa, mo)
    return out


def export_members_csv() -> bytes:
    """GET /api/export?fmt=csv 的資料端：全成員清單 → UTF-8-sig CSV bytes（Excel 直開不亂碼）。

    表頭與 _IMPORT_COLS 逐字對齊（2026-07-31）——舊版匯出用「生(國曆)」「現居」等
    匯入不認的欄名，「匯出→Excel 改→匯回」時這些欄被靜默丟棄，往返是死路。
    現在匯出檔可直接匯回：member_id 欄讓每一列被認成「更新該人」（見 import_csv）。
    「已歿」是給人看的衍生欄（卒年有值、或卒(原文)有記載即歿，同 members._is_alive），匯入端刻意不認。
    父名／關係型別／母名的取法見 _export_parents。
    """
    import csv
    import io
    conn = _conn()
    try:
        pcols = _export_parents(conn)
        rows = conn.execute(
            """SELECT m.*,
                      (SELECT CASE WHEN w.spouse_1_id = m.id THEN
                                 (SELECT name FROM members WHERE id = w.spouse_2_id)
                              ELSE (SELECT name FROM members WHERE id = w.spouse_1_id) END
                         FROM marriages w
                        WHERE w.spouse_1_id = m.id OR w.spouse_2_id = m.id
                        ORDER BY w.id LIMIT 1) AS spouse_name,
                      (SELECT address_description  FROM tombs WHERE member_id = m.id LIMIT 1) AS burial_text,
                      (SELECT detail_location_code FROM tombs WHERE member_id = m.id LIMIT 1) AS burial_code,
                      (SELECT tomb_type            FROM tombs WHERE member_id = m.id LIMIT 1) AS burial_type
                 FROM members m ORDER BY m.generation_number, m.id"""
        ).fetchall()
    finally:
        conn.close()
    rel_cn = {"ADOPTED": "過繼", "FOSTER": "收養", "BIOLOGICAL": "親生"}
    tomb_cn = {"BURIAL": "土葬", "COLUMBARIUM": "塔位", "TREE": "樹葬"}
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["member_id", "姓名", "字號", "性別", "世代", "房頭",
                "父名", "關係型別", "母名", "配偶名",
                "生年", "生(原文)", "卒年", "卒(原文)", "已歿",
                "電話", "住址", "郵遞區號", "備註",
                "安葬地點", "穴位編號", "安葬型態"])
    for r in rows:
        fa, mo = pcols.get(r["id"], (None, None))
        w.writerow([r["id"], r["name"], r["generation_name"] or "", r["gender"] or "",
                    r["generation_number"], r["branch"] or "",
                    fa["name"] if fa else "",
                    rel_cn.get(fa["rt"], "") if fa else "",
                    mo["name"] if mo else "", r["spouse_name"] or "",
                    r["birth_date"] or "", r["birth_date_original"] or "",
                    r["death_date"] or "", r["death_date_original"] or "",
                    "" if _is_alive(r["death_date"], r["death_date_original"]) else "是",
                    r["phone"] or "", r["current_address"] or "",
                    r["postal_code"] or "", r["note"] or "",
                    r["burial_text"] or "", r["burial_code"] or "",
                    tomb_cn.get(r["burial_type"] or "", "")])
    return b"\xef\xbb\xbf" + buf.getvalue().encode("utf-8")  # BOM ＋ 內容


# ── R1 通用 CSV 匯入（開源使用者把自家資料建進來的正道）────────────────
# 欄位（表頭比對、順序不拘、缺欄容忍）；「性別(男/女)」之類括號註記自動剝除。
# member_id 有值＝更新既有成員（由「匯出」帶出），留空＝新增。
_IMPORT_COLS = ("member_id", "姓名", "字號", "性別", "世代", "房頭",
                "父名", "關係型別", "母名", "配偶名",
                "生年", "生(原文)", "卒年", "卒(原文)",
                "電話", "住址", "郵遞區號", "備註",
                "安葬地點", "穴位編號", "安葬型態")
# 舊匯出檔（2026-07-31 前）的表頭別名：吃下既存檔案，不讓它們變孤兒
_IMPORT_ALIASES = {"生(國曆)": "生年", "卒(國曆)": "卒年", "現居": "住址"}


def _import_decode(data) -> str:
    """匯入檔 bytes → 文字。容 UTF-8／UTF-8-BOM；其他編碼一律 400 白話提示。"""
    if not data:
        raise ApiError(400, "檔案是空的，請確認選對 CSV 檔")
    raw = bytes(data)
    if raw[:3] == b"\xef\xbb\xbf":
        raw = raw[3:]   # 剝除 UTF-8 BOM（Excel「CSV UTF-8」另存即帶）
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        raise ApiError(400, "無法讀取檔案：請將 CSV 以 UTF-8（或 UTF-8 BOM）編碼儲存後再匯入"
                            "（Excel 可用「另存新檔 → CSV UTF-8」）")


def _import_header_map(header_row) -> dict:
    """表頭列 → {欄名: 欄位索引}。

    比對順序：①原字面（「生(原文)」這類本身就含括號的正式欄名要先中）
    ②別名表（舊匯出檔的「生(國曆)」「現居」）③剝除括號註記後再比
    （「性別(男/女)」→「性別」）。不認得的欄一律忽略。
    """
    idx = {}
    for i, cell in enumerate(header_row):
        raw = str(cell or "").strip().lstrip("﻿")
        key = None
        if raw in _IMPORT_COLS:
            key = raw
        elif raw in _IMPORT_ALIASES:
            key = _IMPORT_ALIASES[raw]
        else:
            k = raw
            for br in ("(", "（"):
                p = k.find(br)
                if p >= 0:
                    k = k[:p]
            k = k.strip()
            if k in _IMPORT_COLS:
                key = k
        if key and key not in idx:
            idx[key] = i
    return idx


# ── Excel 變形偵測（H-2／體檢 backend-2，2026-09-25）──────────────────────
# 「匯出 → Excel 改一格 → 匯回」時，Excel 會把沒動過的格子也改掉再存回：
#   電話 +886912345678 → 8.86912E+11（科學記號，原號碼已無法還原）、
#   0912345678 → 912345678（當成數字去掉開頭 0）、穴位 3-12 → 「3月12日」（當成日期）。
# 更新列遇到這種值不覆寫（保留資料庫原值），改列入預覽的「Excel變形提醒」——另開一份清單，
# 因為匯出檔匯回時每一列都會有「父名不套用」的更新列提醒，混在一起會被淹掉看不到。
_SCI_RE = re.compile(r"[+-]?\d+(?:\.\d+)?[eE][+-]?\d+")
_MD_CN_RE = re.compile(r"(\d{1,2})月(\d{1,2})日")
_MD_DASH_RE = re.compile(r"(\d{1,2})\s*[-/]\s*(\d{1,2})")


def _excel_mangled_phone(new, old) -> bool:
    """新電話看起來是 Excel 把舊電話當數字改壞的結果（科學記號，或舊值去掉開頭 +/0）。"""
    if _SCI_RE.fullmatch(new):
        return True
    return bool(old) and new != old and new.isdigit() and old.lstrip("+0") == new


def _phone_lost_zero(v) -> bool:
    """9 位數、9 開頭：台灣手機（09 開頭 10 碼）被 Excel 當數字吃掉開頭 0 的樣子。
    跟原值比不出來（使用者在 Excel 真的改了那格、或是新增列），只能提醒，不替使用者補 0。"""
    return len(v) == 9 and v.isdigit() and v[0] == "9"


def _excel_mangled_code(new, old) -> bool:
    """新穴位編號是「X月Y日」、而舊值正是對應的「X-Y」（Excel 當成日期）。"""
    m, o = _MD_CN_RE.fullmatch(new), _MD_DASH_RE.fullmatch(old or "")
    return bool(m and o) and (int(m.group(1)), int(m.group(2))) == (int(o.group(1)), int(o.group(2)))


def _import_parse(conn, data) -> dict:
    """解析＋驗證＋親屬連結試算（preview / commit 共用；本函式不寫庫）。

    規則（通用 CSV 匯入：先預覽試算、確認後才寫庫；2026-07-31 擴充更新列與親屬欄）：
      * 必要表頭：姓名、世代；其餘欄位缺欄容忍。
      * member_id 有值＝**更新該既有成員**（由「匯出 CSV」帶出）：
          - 非空儲存格才更新該欄；**空儲存格＝不動**（要清空請走成員表單）。
            這是刻意的保守語意——Excel 手滑刪格不會清掉全族該欄位的資料。
          - 父名／關係型別／母名／配偶名於更新列**不套用**（字串重連會毀掉
            雙軌過繼的既有親邊；親屬關係請於成員表單調整），有填會提示。
          - 電話／穴位編號看得出是 Excel 變形（見 _excel_mangled_*）→ 不覆寫，
            列入「Excel變形提醒」。
          - member_id 查無其人＝錯誤列（防檔案錯位，不默默降級成新增）。
      * 生年／卒年（新增列與更新列）一律經 normalize_date 正規化成 YYYY-MM-DD。
        卒年空白但卒(原文)有值＝已歿、卒年不詳，存哨兵「已歿」（更新列只補資料庫原本沒有卒年的人）。
        更新列會讓原本在世的人變已過世時，列入「改為已歿提醒」（他會從在世通知名單消失）。
      * 新增列（member_id 空白）：
          - 錯誤列（姓名空白／世代非正整數／性別非法／關係型別非法／安葬型態非法）
            不匯入，列入錯誤清單。
          - 防重複：同名＋同世＋同父已存在於資料庫、或檔內重複者跳過。
            「同父」比的是既有成員實際連結的親代 id（見迴圈內註解）。
            同名同世已存在、但親代對不上者照樣新增，列入「同名提醒」。
          - 接父試算：父名＋世代-1 恰一位才接（邊型別依「關係型別」欄，預設親生）；
            接母＝母名＋世代-1；接配偶＝配偶名＋同世代；零位或多位一律列入
            「找不到父清單」但人仍新增。
    回傳 dict：對外報告鍵（rows／新增／更新／可接父…）＋內部計畫鍵（_ 開頭，
    路由回應前剝除）供 commit 執行。
    """
    import csv  # noqa: PLC0415
    import io  # noqa: PLC0415
    text = _import_decode(data)
    rows = list(csv.reader(io.StringIO(text)))

    hi = None   # 表頭列索引：第一個非空列
    for i, r in enumerate(rows):
        if any(str(c or "").strip() for c in r):
            hi = i
            break
    if hi is None:
        raise ApiError(400, "CSV 內沒有任何內容")
    col = _import_header_map(rows[hi])
    if "姓名" not in col or "世代" not in col:
        raise ApiError(400, "表頭缺少必要欄位「姓名」「世代」。請先下載匯入範本，"
                            "依範本表頭填寫（欄位順序不拘、其餘欄位可留空）")

    def cell(r, key):
        i = col.get(key)
        if i is None or i >= len(r):
            return ""
        return str(r[i] or "").strip()

    # 既有成員索引：(姓名, 世代) → [id]（防重複＋親屬試算共用）
    existing = {}
    by_name = {}      # 姓名 → [id]（防重複：把 CSV 的父名／母名解析成人選 id）
    id_name = {}      # id → 姓名（同名提醒列出既有者的父母）
    for m in conn.execute("SELECT id, name, generation_number AS gen FROM members").fetchall():
        existing.setdefault((m["name"], m["gen"]), []).append(m["id"])
        by_name.setdefault(m["name"], []).append(m["id"])
        id_name[m["id"]] = m["name"]
    # 既有親邊：child → [(親代 id, 親代性別)]（防重複比對用，一次撈完免逐人查）
    parents_of = {}
    for pr in conn.execute(
        "SELECT r.child_id AS cid, r.parent_id AS pid, p.gender AS pg "
        "FROM relationships r JOIN members p ON p.id = r.parent_id"
    ).fetchall():
        parents_of.setdefault(pr["cid"], []).append((pr["pid"], pr["pg"]))

    _REL_MAP = {"": "BIOLOGICAL", "親生": "BIOLOGICAL", "過繼": "ADOPTED", "收養": "FOSTER"}
    _TOMB_MAP = {"": "", "土葬": "BURIAL", "塔位": "COLUMBARIUM", "樹葬": "TREE",
                 "BURIAL": "BURIAL", "COLUMBARIUM": "COLUMBARIUM", "TREE": "TREE"}

    adds, updates, errors, skips, nolink, update_notes = [], [], [], [], [], []
    excel_notes = []          # 更新列疑似 Excel 變形、未覆寫的欄位（H-2）
    same_notes = []           # 新增列：庫裡已有同名同世、但親代對不上（H-3 再修）
    dead_notes = []           # 更新列：原本在世、匯入後變已過世（會從在世通知名單消失）
    seen_in_file = set()      # (姓名, 世代, 父名) 檔內防重複（新增列）
    seen_update_ids = set()   # member_id 檔內防重複（更新列）
    data_rows = 0
    for li in range(hi + 1, len(rows)):
        r = rows[li]
        if not any(str(c or "").strip() for c in r):
            continue   # 全空列直接略過（不計入 rows）
        data_rows += 1
        ln = li + 1   # 1-based 行號（含表頭列），對齊試算表軟體顯示
        name = cell(r, "姓名")

        mid_raw = cell(r, "member_id")
        is_update = bool(mid_raw)
        mid = None
        if is_update:
            try:
                mid = int(mid_raw)
            except ValueError:
                errors.append("第 %d 列：member_id「%s」不是數字，未匯入"
                              "（此欄由「匯出 CSV」帶出＝更新該人；新增請留空）" % (ln, mid_raw))
                continue
            if not conn.execute("SELECT 1 FROM members WHERE id = ?", (mid,)).fetchone():
                errors.append("第 %d 列（%s）：member_id %d 查無此成員，未匯入"
                              "（可能已被刪除；若是要新增請把 member_id 留空）" % (ln, name or "？", mid))
                continue
            if mid in seen_update_ids:
                skips.append("第 %d 列：member_id %d 在檔內重複出現，僅第一列生效，本列已跳過" % (ln, mid))
                continue
        elif not name:
            errors.append("第 %d 列：姓名空白，未匯入" % ln)
            continue

        gen_raw = cell(r, "世代")
        gen = None
        if gen_raw:
            try:
                gen = int(gen_raw)
            except ValueError:
                errors.append("第 %d 列（%s）：世代須為數字，收到「%s」" % (ln, name or "？", gen_raw))
                continue
            if gen < 1:
                errors.append("第 %d 列（%s）：世代須為 1 以上，收到「%s」" % (ln, name or "？", gen_raw))
                continue
        elif not is_update:
            errors.append("第 %d 列（%s）：世代須為數字，收到「%s」" % (ln, name, gen_raw))
            continue

        g_raw = cell(r, "性別")
        gender = {"男": "M", "女": "F", "M": "M", "F": "F", "m": "M", "f": "F",
                  "O": "O", "o": "O"}.get(g_raw)
        if g_raw and gender is None:
            errors.append("第 %d 列（%s）：性別須為「男」或「女」（可留空），收到「%s」"
                          % (ln, name or "？", g_raw))
            continue

        rel = _REL_MAP.get(cell(r, "關係型別"))
        if rel is None:
            errors.append("第 %d 列（%s）：關係型別須為「親生」「過繼」「收養」（可留空＝親生），"
                          "收到「%s」" % (ln, name or "？", cell(r, "關係型別")))
            continue
        ttype = _TOMB_MAP.get(cell(r, "安葬型態").upper())
        if ttype is None:
            errors.append("第 %d 列（%s）：安葬型態須為「土葬」「塔位」「樹葬」（可留空），收到「%s」"
                          % (ln, name or "？", cell(r, "安葬型態")))
            continue

        # 卒年空白、但「卒(原文)」有記載＝已過世、年份不詳（M-8／體檢 frontend-3）：存成哨兵值
        # 「已歿」（同成員表單的「已過世（卒年不詳）」）。留 NULL 會被當成在世——老祖先進了
        # 「全族在世」通知名單、又不在牌位姓名表。更新列的處理見下方 is_update 段。
        death = normalize_date(cell(r, "卒年"))
        if not death and cell(r, "卒(原文)"):
            death = _DEATH_UNKNOWN
        common = {
            "line": ln, "name": name, "styleName": cell(r, "字號"), "gender": gender,
            "gen": gen, "branch": cell(r, "房頭"),
            "birth": normalize_date(cell(r, "生年")), "birthOrig": cell(r, "生(原文)"),
            "death": death, "deathOrig": cell(r, "卒(原文)"),
            "phone": cell(r, "電話"), "address": cell(r, "住址"),
            "postal": cell(r, "郵遞區號"), "note": cell(r, "備註"),
            "burial": cell(r, "安葬地點"), "burialCode": cell(r, "穴位編號"),
            "burialType": ttype,
        }

        if is_update:
            seen_update_ids.add(mid)
            common["id"] = mid
            if death:
                cur_d = conn.execute("SELECT death_date, death_date_original FROM members WHERE id = ?",
                                     (mid,)).fetchone()
                if death == _DEATH_UNKNOWN and not cell(r, "卒年") and cur_d and cur_d["death_date"]:
                    # 更新列「空儲存格＝不動」：資料庫已有卒年就不拿哨兵蓋掉，只補原本判成在世的人
                    common["death"] = ""
                elif cur_d and _is_alive(cur_d["death_date"], cur_d["death_date_original"]):
                    # 原本在世 → 匯入後已過世：另列提醒（不混進每列都有的「更新列提醒」），
                    # 總幹事預覽時才看得到誰會從「全族在世」通知名單消失（M-8 驗證補充）
                    dead_notes.append("第 %d 列（%s，member_id %d）：原本是在世，匯入後改為已過世（%s），"
                                      "不會再出現在「全族在世」通知名單；若此人仍在世，請把這一列的"
                                      "卒年、卒(原文)清空再匯入"
                                      % (ln, name, mid, "卒年不詳" if death == _DEATH_UNKNOWN
                                         else "卒年 " + death))
            # Excel 變形的電話／穴位編號：清成空字串＝此欄不動（更新列語意），並提示
            if common["phone"] or common["burialCode"]:
                cur = conn.execute(
                    "SELECT m.phone, (SELECT detail_location_code FROM tombs WHERE member_id = m.id LIMIT 1)"
                    " AS code FROM members m WHERE m.id = ?", (mid,)).fetchone()
                old_ph, old_code = (cur["phone"] or ""), (cur["code"] or "")
                if common["phone"] and _excel_mangled_phone(common["phone"], old_ph):
                    excel_notes.append("第 %d 列（member_id %d）：電話「%s」疑似被 Excel 改掉（科學記號或少了開頭的 0），"
                                        "未覆寫，%s" % (ln, mid, common["phone"],
                                                     ("保留原值「%s」" % old_ph) if old_ph else "此欄維持空白"))
                    common["phone"] = ""
                elif common["phone"] and _phone_lost_zero(common["phone"]):
                    excel_notes.append("第 %d 列（member_id %d）：電話「%s」看起來是手機號碼少了開頭的 0"
                                        "（Excel 常把 09 開頭的號碼當數字），會照原樣寫入，請確認"
                                        % (ln, mid, common["phone"]))
                if common["burialCode"] and _excel_mangled_code(common["burialCode"], old_code):
                    excel_notes.append("第 %d 列（member_id %d）：穴位編號「%s」疑似被 Excel 當成日期，"
                                        "未覆寫，保留原值「%s」" % (ln, mid, common["burialCode"], old_code))
                    common["burialCode"] = ""
            updates.append(common)
            if cell(r, "父名") or cell(r, "母名") or cell(r, "配偶名"):
                # 另列提醒，不混進 nolink：那是「找不到父」的計數，塞提醒進去會灌水
                update_notes.append("第 %d 列（member_id %d）：父名／母名／配偶名欄於更新列不套用，"
                                    "親屬關係請於成員表單調整" % (ln, mid))
            continue

        father = cell(r, "父名")
        key = (name, gen, father)
        if key in seen_in_file:
            skips.append("第 %d 列：%s（第 %d 世）與檔內另一列重複，已跳過" % (ln, name, gen))
            continue
        # 防重複：同名＋同世＋同父已存在於資料庫者跳過。
        # 「同父」比 relationships 上實際連結的親代 id，不分性別、不比姓名字串（H-3／體檢
        # backend-3，2026-09-25）——舊版比 _father_name，它只認 gender='M'，性別留空的
        # 名冊（NULL）永遠比成 ''，重匯時除了始祖之外整批被複製一份。
        #   * 父名有填：父名解析出的既有人選（同名者，不限世代）之一是這人的親代 → 重複；
        #   * 父名空白：這人沒有「父槽」親代（性別非 F，且不是本列母名那位）→ 重複。
        #     排除母名人選，是因為舊庫裡經母名接上的母親性別可能也是 NULL。
        fcands = set(by_name.get(father, ())) if father else set()
        mcands = set(by_name.get(cell(r, "母名"), ()))
        dup = False
        for xid in existing.get((name, gen), []):
            ps = parents_of.get(xid, [])
            if father:
                hit = any(pid in fcands for pid, _pg in ps)
            else:
                hit = not any(pg != "F" and pid not in mcands for pid, pg in ps)
            if hit:
                dup = True
                break
        if dup:
            skips.append("第 %d 列：%s（第 %d 世，父：%s）已存在於資料庫，已跳過"
                         % (ln, name, gen, father or "無"))
            continue
        if existing.get((name, gen)):
            # 庫裡有同名同世、但親代對不上：照規則新增（同名同世在族譜裡很常見，自動跳過
            # 會漏掉真人），但要在預覽提醒（H-3 再修，2026-10-02）。在 App 內幫這人補接過
            # 父親、或改過父親名字的錯字之後重匯舊檔，就會走到這裡；舊版不提醒＝默默複製一份。
            pn = sorted({id_name.get(pid, "") for xid in existing[(name, gen)]
                         for pid, _pg in parents_of.get(xid, [])} - {""})
            same_notes.append("第 %d 列：%s（第 %d 世）資料庫已有同名同世的人，但父母對不上"
                              "（本列父名：%s；資料庫那位的父母：%s），仍會新增一位。"
                              "若其實是同一人，請刪掉這一列再匯入"
                              % (ln, name, gen, father or "空白", "、".join(pn) or "未登錄"))
        if common["phone"] and _phone_lost_zero(common["phone"]):
            excel_notes.append("第 %d 列：%s 的電話「%s」看起來是手機號碼少了開頭的 0"
                               "（Excel 常把 09 開頭的號碼當數字），會照原樣寫入，請確認"
                               % (ln, name, common["phone"]))
        seen_in_file.add(key)
        common["father"] = father
        common["rel"] = rel
        common["mother"] = cell(r, "母名")
        common["spouse"] = cell(r, "配偶名")
        adds.append(common)
    if data_rows == 0:
        raise ApiError(400, "CSV 只有表頭、沒有資料列，請至少填寫一位成員")

    # 親屬試算：候選＝既有成員＋本檔新增，恰一位才接（父/母＝世代-1、配偶＝同世代）
    new_index = {}
    for a in adds:
        new_index.setdefault((a["name"], a["gen"]), []).append(a)

    def _plan(a, kind, pname, want_gen):
        """單一親屬連結試算：恰一位候選回 key，否則進 nolink 清單回 None。"""
        pkey = (pname, want_gen)
        cands = len(existing.get(pkey, [])) + len(new_index.get(pkey, []))
        if cands == 1:
            return pkey
        if cands == 0:
            nolink.append("第 %d 列：%s 之%s「%s」（第 %d 世）查無此人，先不接%s"
                          "（可日後於成員編輯表單補選）"
                          % (a["line"], a["name"], kind, pname, want_gen, kind))
        else:
            nolink.append("第 %d 列：%s 之%s「%s」（第 %d 世）有 %d 位同名，無法自動判定，先不接%s"
                          % (a["line"], a["name"], kind, pname, want_gen, cands, kind))
        return None

    linked = linked_m = linked_s = 0
    for a in adds:
        a["fatherPlan"] = _plan(a, "父", a["father"], a["gen"] - 1) if a["father"] else None
        if a["fatherPlan"]:
            linked += 1
        a["motherPlan"] = _plan(a, "母", a["mother"], a["gen"] - 1) if a["mother"] else None
        if a["motherPlan"]:
            linked_m += 1
        a["spousePlan"] = _plan(a, "配偶", a["spouse"], a["gen"]) if a["spouse"] else None
        if a["spousePlan"]:
            linked_s += 1

    # 新增房頭：匯入列帶到、但 settings.branches 尚無者（commit 時補進設定）
    row = conn.execute("SELECT value FROM settings WHERE key = 'branches'").fetchone()
    known = set(_branches_from_value(row["value"] if row else None))
    new_branches = []
    for a in adds + updates:
        b = a["branch"]
        if b and b not in known and b not in new_branches:
            new_branches.append(b)

    return {
        "ok": True,
        "rows": data_rows,
        "新增": len(adds),
        "更新": len(updates),
        "可接父": linked,
        "可接母": linked_m,
        "可接配偶": linked_s,
        "找不到父": len(nolink),
        "跳過": len(skips),
        "錯誤": len(errors),
        "錯誤清單": errors,
        "跳過清單": skips,
        "找不到父清單": nolink,
        "更新列提醒": update_notes,
        "Excel變形提醒": excel_notes,
        "同名提醒": same_notes,
        "改為已歿提醒": dead_notes,
        "新增房頭": new_branches,
        "_adds": adds,
        "_updates": updates,
        "_existing": existing,
    }


def import_csv(data, mode="preview") -> dict:
    """POST /api/import?mode=preview|commit（需編輯模式；R1 通用 CSV 匯入）。

    body 為 CSV 原始 bytes（text/csv 或 application/octet-stream，容 UTF-8／
    UTF-8-BOM）。兩階段：preview 只試算回報告不寫庫；commit 實際寫入——
    第一輪建人（含安葬三欄落 tombs）、第二輪接親屬（父邊依「關係型別」欄、
    母邊、婚姻邊），另處理 member_id 更新列（非空儲存格才更新），
    房頭補進 settings.branches。鎖定單一房頭時不可匯入（避免繞過 R2 護欄）。
    「匯出 CSV → Excel 修改 → 匯回」即批次更新的正道（匯出檔自帶 member_id）。
    """
    if not _LOCK["editMode"]:
        raise ApiError(403, "edit mode required")
    if _LOCK["branch"]:
        raise ApiError(403, "匯入需以「全部（委員）」解鎖（目前編輯範圍限『%s』）" % _LOCK["branch"])
    mode = str(mode or "preview").strip().lower()
    if mode not in ("preview", "commit"):
        raise ApiError(400, "mode 須為 preview（試算）或 commit（實際匯入）")
    conn = _conn()
    try:
        plan = _import_parse(conn, data)
        if mode == "commit" and (plan["新增"] or plan["更新"]):
            # 第一輪：建人（記下新 id，供第二輪接親屬）
            id_index = {}   # (姓名, 世代) → [新 id]
            for a in plan["_adds"]:
                cur = conn.execute(
                    """INSERT INTO members
                           (name, generation_name, generation_number, branch, gender,
                            birth_date, birth_date_original, death_date, death_date_original,
                            phone, current_address, postal_code, note)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (a["name"], a["styleName"] or None, a["gen"], a["branch"] or None,
                     a["gender"], a["birth"] or None, a["birthOrig"] or None,
                     a["death"] or None, a["deathOrig"] or None,
                     a["phone"] or None, a["address"] or None, a["postal"] or None,
                     a["note"] or None),
                )
                a["_id"] = cur.lastrowid
                id_index.setdefault((a["name"], a["gen"]), []).append(cur.lastrowid)
                if a["burial"] or a["burialCode"] or a["burialType"]:
                    _save_burial(conn, a["_id"], a["burial"],
                                 a["burialCode"] or None, a["burialType"] or None)

            def _resolve(pkey):
                # 親屬解析：既有成員優先，否則取本檔新建（試算已保證恰一位候選）
                ids = plan["_existing"].get(pkey, []) + id_index.get(pkey, [])
                return ids[0] if ids else None

            # 第二輪：接親屬（試算已保證恰一位候選；既有成員或本檔新建皆可）
            # 經「父名」接上的親代性別空白就補成男、經「母名」接上的補成女（H-3）：
            # 名冊常整欄不填性別，留 NULL 的話父親在匯出時會落進母名欄、
            # 稱謂與父名標籤（只認 gender='M'）也找不到他。已有性別者不動。
            for a in plan["_adds"]:
                if a.get("fatherPlan"):
                    fid = _resolve(a["fatherPlan"])
                    conn.execute(
                        "INSERT OR IGNORE INTO relationships (parent_id, child_id, relation_type) "
                        "VALUES (?,?,?)",
                        (fid, a["_id"], a["rel"]),
                    )
                    conn.execute("UPDATE members SET gender = 'M' WHERE id = ? AND gender IS NULL", (fid,))
                if a.get("motherPlan"):
                    mid_ = _resolve(a["motherPlan"])
                    conn.execute(
                        "INSERT OR IGNORE INTO relationships (parent_id, child_id, relation_type) "
                        "VALUES (?,?, 'BIOLOGICAL')",
                        (mid_, a["_id"]),
                    )
                    conn.execute("UPDATE members SET gender = 'F' WHERE id = ? AND gender IS NULL", (mid_,))
                if a.get("spousePlan"):
                    sid = _resolve(a["spousePlan"])
                    if sid and sid != a["_id"] and not conn.execute(
                        "SELECT 1 FROM marriages WHERE (spouse_1_id=? AND spouse_2_id=?) "
                        "OR (spouse_1_id=? AND spouse_2_id=?)",
                        (a["_id"], sid, sid, a["_id"]),
                    ).fetchone():
                        conn.execute(
                            "INSERT INTO marriages (spouse_1_id, spouse_2_id, marriage_status) "
                            "VALUES (?,?, 'MARRIED')",
                            (a["_id"], sid),
                        )

            # 更新列：非空儲存格才更新（空＝不動；語意見 _import_parse docstring）
            _UP_MAP = [("name", "name"), ("styleName", "generation_name"),
                       ("gender", "gender"), ("branch", "branch"),
                       ("birth", "birth_date"), ("birthOrig", "birth_date_original"),
                       ("death", "death_date"), ("deathOrig", "death_date_original"),
                       ("phone", "phone"), ("address", "current_address"),
                       ("postal", "postal_code"), ("note", "note")]
            for u in plan["_updates"]:
                sets, vals = [], []
                for k, dbcol in _UP_MAP:
                    if u.get(k):
                        sets.append("%s = ?" % dbcol)
                        vals.append(u[k])
                if u["gen"] is not None:
                    sets.append("generation_number = ?")
                    vals.append(u["gen"])
                if sets:
                    conn.execute("UPDATE members SET %s WHERE id = ?" % ", ".join(sets),
                                 vals + [u["id"]])
                if u["burial"] or u["burialCode"] or u["burialType"]:
                    # 安葬三欄同樣「非空才動」：空欄位以現值補齊再寫回
                    trow = conn.execute(
                        "SELECT address_description, detail_location_code, tomb_type "
                        "FROM tombs WHERE member_id = ? LIMIT 1", (u["id"],)).fetchone()
                    _save_burial(conn, u["id"],
                                 u["burial"] or (trow["address_description"] if trow else ""),
                                 u["burialCode"] or (trow["detail_location_code"] if trow else None),
                                 u["burialType"] or (trow["tomb_type"] if trow else None))
            # 房頭補進 settings.branches（保序、去重；前端下拉與護欄讀此鍵）
            if plan["新增房頭"]:
                row = conn.execute("SELECT value FROM settings WHERE key = 'branches'").fetchone()
                merged = _branches_to_value(
                    _branches_from_value(row["value"] if row else None) + plan["新增房頭"])
                conn.execute(
                    "INSERT INTO settings(key, value) VALUES ('branches', ?) "
                    "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    (merged,),
                )
            conn.commit()
        report = {k: v for k, v in plan.items() if not k.startswith("_")}
        report["mode"] = mode
        report["committed"] = (mode == "commit")
        return report
    finally:
        conn.close()
