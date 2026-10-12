# -*- coding: utf-8 -*-
"""成員與親屬邊：CRUD、樹掛靠投影、房頭護欄、安葬、雙軌親邊（原 server.py）。"""
from __future__ import annotations

from .errors import ApiError
from .lunar import _date_parts, _ganzhi, _split_original, normalize_date, solar_to_lunar_cn
from .state import _LOCK, _conn
from .tombsites import member_tomb_sites


def _cn_num(n):
    """1..99 → 中文數字（14→十四、20→二十、21→二十一）；與前端 genCn、print.html cnNum 同規則。"""
    d = "一二三四五六七八九"
    if n < 10:
        return d[n - 1]
    t, o = divmod(n, 10)
    return ("十" if t == 1 else d[t - 1] + "十") + (d[o - 1] if o else "")


# 舊版只到八，第九世以後的識別標籤變成阿拉伯數字（本譜從第十一世起算，全族都是）
_GEN_CN = {n: _cn_num(n) for n in range(1, 100)}


def _father_name(conn, member_id):
    """以 relationships 找父親姓名（gender='M' 的 parent）。查無回 ''。

    雙軌並存（本生父＋嗣父）時優先取 ADOPTED/FOSTER 邊（承嗣主線，見下方註解）。
    """
    # 世系主線＝承嗣：過繼(ADOPTED)/收養(FOSTER) 優先於親生（總幹事拍板 2026-07-16，
    # 依原始檔案歸檔 11/13 案在養父支、零反例——過繼者屬養父房、祭祀歸養父）。
    # 樹掛靠、父名標籤、稱謂父鏈、詳情排序四處同用此序，不可只改一處。
    row = conn.execute(
        """SELECT m.name AS name
             FROM relationships r JOIN members m ON m.id = r.parent_id
            WHERE r.child_id = ? AND m.gender = 'M'
            ORDER BY CASE r.relation_type WHEN 'ADOPTED' THEN 0 WHEN 'FOSTER' THEN 1 ELSE 2 END, r.id
            LIMIT 1""",
        (member_id,),
    ).fetchone()
    return row["name"] if row else ""


def _label(row, father_name, tag=""):
    """同名防呆識別標籤（規格 §4.3）：世代·房·[外姻標註·]父名-姓名。

    缺欄優雅留空：房頭為空或「本宗」則略去；無父名則略去。
    例：「第三世·長房·楊敬山-楊文柏」、「第十九世·二房·女婿-林淑安」。
    族譜慣例寫「世」（2026-10-03 總幹事：全程式統一，舊版寫「代」）。
    """
    bits = ["第" + _GEN_CN.get(row["generation_number"], str(row["generation_number"])) + "世"]
    if row["branch"] and row["branch"] != "本宗":
        bits.append(row["branch"])
    if tag:
        bits.append(tag)
    if father_name:
        bits.append(father_name)
    return "·".join(bits) + "-" + row["name"]


def _inlaw_tag(conn, gender, has_parent, spouse_id):
    """外姻標註：樹上無任何親邊、僅以婚姻繫入者＝嫁／贅入。

    配偶為有親邊的本宗子孫時：女→「媳」、男→「女婿」。
    夫妻皆無親邊＝開基祖夫妻，皆不標；本宗子孫（含嫁出女，有父邊）不標。
    """
    if has_parent or not spouse_id:
        return ""
    sp_has_parent = conn.execute(
        "SELECT 1 FROM relationships WHERE child_id = ? LIMIT 1", (spouse_id,)
    ).fetchone() is not None
    if not sp_has_parent:
        return ""   # 夫妻皆無親邊＝開基祖夫妻，皆不標
    sp = conn.execute("SELECT gender FROM members WHERE id = ?", (spouse_id,)).fetchone()
    sg = ((sp["gender"] if sp else "") or "")
    g = (gender or "")
    if g and sg and g == sg:
        return "配偶"   # 同性配偶統一標「配偶」（總幹事拍板 2026-07-10；異性維持傳統媳/女婿）
    return "媳" if g == "F" else "女婿"


def _list_ctx(conn):
    """一次撈完 relationships/marriages，供 list_members 全量投影用（消 N+1）。

    原本每位成員各跑 3~4 個子查詢（父名／掛靠父／配偶／外姻），全族上千人＝上萬次查詢。
    這裡以 3 個查詢建索引，投影時純記憶體查表，語意與逐筆版完全一致：
      * father：男性父，序 ADOPTED→FOSTER→BIOLOGICAL→r.id（承嗣主線，同 _father_name）
      * mount ：掛靠父，男性優先，其餘同上（無父者用母，免浮成樹根）
      * spouse：第一段婚姻（ORDER BY marriages.id）
    """
    ctx = {"father": {}, "mount": {}, "spouse": {}, "gender": {}, "has_parent": set()}
    for r in conn.execute("SELECT id, gender FROM members").fetchall():
        ctx["gender"][r["id"]] = r["gender"] or ""
    # 依「型別優先序、r.id」排好後掃一遍：各 child 取第一個男性父＝father；
    # mount 取第一個男性父，沒有才退回第一個親代（母）
    for r in conn.execute(
        """SELECT r.child_id AS cid, r.parent_id AS pid, m.name AS pname, m.gender AS pg
             FROM relationships r JOIN members m ON m.id = r.parent_id
            ORDER BY r.child_id,
                     CASE r.relation_type WHEN 'ADOPTED' THEN 0 WHEN 'FOSTER' THEN 1 ELSE 2 END,
                     r.id"""
    ).fetchall():
        cid = r["cid"]
        ctx["has_parent"].add(cid)
        male = (r["pg"] or "") == "M"
        if male and cid not in ctx["father"]:
            ctx["father"][cid] = r["pname"]
        if cid not in ctx["mount"] or (male and not ctx["mount"][cid][1]):
            # (pid, is_male)；已存女性親代時，之後出現男性父要覆蓋（男性優先）
            if cid not in ctx["mount"] or not ctx["mount"][cid][1]:
                ctx["mount"][cid] = (r["pid"], male)
    for r in conn.execute(
        "SELECT id, spouse_1_id AS a, spouse_2_id AS b FROM marriages ORDER BY id"
    ).fetchall():
        ctx["spouse"].setdefault(r["a"], r["b"])
        ctx["spouse"].setdefault(r["b"], r["a"])
    return ctx


def _inlaw_tag_ctx(ctx, mid, gender, has_parent, spouse_id):
    """_inlaw_tag 的查表版（語意相同，不打 DB）。"""
    if has_parent or not spouse_id:
        return ""
    if spouse_id not in ctx["has_parent"]:
        return ""                     # 夫妻皆無親邊＝開基祖夫妻，皆不標
    g, sg = (gender or ""), ctx["gender"].get(spouse_id, "")
    if g and sg and g == sg:
        return "配偶"
    return "媳" if g == "F" else "女婿"


def _is_alive(death_date, death_original) -> bool:
    """在世＝卒年（death_date）是 NULL，而且卒(原文)也沒有記載。

    卒年空白、卒(原文)卻寫了字＝已過世、年份不詳（同 CSV 匯入與成員表單存哨兵「已歿」的規則）。
    舊版表單只能把這種老祖先存成 death_date NULL；只看 death_date 的話升級後他們仍是「在世」，
    會進「全族在世」通知名單、又不在牌位姓名表（M-8 驗證補充）。讀取時一併認定，舊庫不必遷移。
    """
    return death_date is None and not (death_original or "").strip()


def _project_member(conn, row, ctx=None):
    """投影成 GET /api/members 契約形狀。

    ctx 由 _list_ctx() 提供時走記憶體查表（全量列表用）；為 None 時維持逐筆查詢，
    供其他單筆呼叫者沿用，行為一致。
    """
    mid = row["id"]
    if ctx is not None:
        fn = ctx["father"].get(mid, "")
        _m = ctx["mount"].get(mid)
        fid = _m[0] if _m else None
        sid = ctx["spouse"].get(mid)
        inlaw = _inlaw_tag_ctx(ctx, mid, row["gender"], mid in ctx["has_parent"], sid)
    else:
        fn = _father_name(conn, mid)
        # 樹掛靠親代：男性父優先、承嗣主線 ADOPTED/FOSTER 優先於 BIOLOGICAL；
        # 僅有母（如嫁出女之子）則掛母，免浮成樹根
        frow = conn.execute(
            "SELECT r.parent_id AS pid FROM relationships r JOIN members m ON m.id = r.parent_id "
            "WHERE r.child_id = ? ORDER BY CASE WHEN m.gender = 'M' THEN 0 ELSE 1 END, "
            "CASE r.relation_type WHEN 'ADOPTED' THEN 0 WHEN 'FOSTER' THEN 1 ELSE 2 END, r.id LIMIT 1",
            (mid,),
        ).fetchone()
        srow = conn.execute(
            "SELECT CASE WHEN spouse_1_id = ? THEN spouse_2_id ELSE spouse_1_id END AS sid "
            "FROM marriages WHERE spouse_1_id = ? OR spouse_2_id = ? ORDER BY id LIMIT 1",
            (mid, mid, mid),
        ).fetchone()
        fid = frow["pid"] if frow else None
        sid = srow["sid"] if srow else None
        inlaw = _inlaw_tag(conn, row["gender"], frow is not None, sid)
    era, lunar = _split_original(row["birth_date_original"])
    return {
        "id": row["id"],
        "name": row["name"],
        "styleName": row["generation_name"] or "",
        "gen": row["generation_number"],
        "branch": row["branch"] or "",
        "fatherName": fn,
        "fatherId": fid,                             # 掛靠父 id（樹以此組，避免同名/嗣子斷裂）
        "spouseOfId": sid,                           # 配偶 id（無父者掛在配偶下，免媳婦浮在樹頂）
        "inlaw": inlaw,                              # 外姻標註：''｜媳｜女婿（列印與樹狀標示用）
        "mailTarget": bool(row["mail_target"]) if "mail_target" in row.keys() and row["mail_target"] else False,
        "gender": row["gender"] or "",
        "alive": _is_alive(row["death_date"], row["death_date_original"]),
        "birth": row["birth_date"] or "",
        "death": row["death_date"] or "",
        # ── 列印所需欄位（print.html 帶真實資料填版；缺值一律空字串）──
        "birthOriginal": row["birth_date_original"] or "",
        "deathOriginal": row["death_date_original"] or "",
        "phone": row["phone"] or "",
        "address": row["current_address"] or "",
        "postalCode": (row["postal_code"] if "postal_code" in row.keys() else "") or "",
        "note": (row["note"] if "note" in row.keys() else "") or "",
        "ganzhi": _ganzhi(row["birth_date"], row["birth_date_original"]),  # 歲次干支
        "era": era,       # 年號年（自 birth_date_original 拆出）
        "lunar": lunar,   # 農曆月日（自 birth_date_original 拆出）
        "label": _label(row, fn, inlaw),
    }


# 姓名異體字（族譜表與行政檔用字不一）：搜尋時雙向折疊，打哪個字都找得到
#   廸/迪、峯/峰、亁/乾、潀/潨
#   入庫刻意保留原字形，所以這裡必須雙向展開（庫裡「亁」「乾」兩種寫法的人都有），
#   不能只做單向折疊。要加字對直接加在這張表（server.py 只是轉出同一個物件）。
_NAME_VARIANTS = [("廸", "迪"), ("峯", "峰"), ("亁", "乾"), ("潀", "潨")]


def _q_variants(q):
    """搜尋字串的異體字展開：回傳去重後的等價查詢清單（含原字串）。"""
    out = {str(q)}
    for a, b in _NAME_VARIANTS:
        more = set()
        for s in out:
            more.add(s.replace(a, b))
            more.add(s.replace(b, a))
        out |= more
    return list(out)


def list_members(branch=None, q=None, limit=None) -> list:
    """GET /api/members?branch=&q=&limit=。q 對姓名做異體字折疊（廸=迪 等）。

    limit：選人器用（每次點開／每個鍵擊只要前 N 筆）；不傳＝全量（族譜樹、作業台需要全列）。
    2026-08-21 效能檢查：全族上千人全量約 1MB，選人器一開就抓全量、每鍵擊再抓 760KB，沒必要。"""
    conn = _conn()
    try:
        sql = "SELECT * FROM members"
        args, where = [], []
        if branch:
            where.append("branch = ?")
            args.append(branch)
        if q:
            ors = []
            for qv in _q_variants(q):
                like = "%" + qv + "%"
                ors.append("name LIKE ?")
                args.append(like)
            like0 = "%" + str(q) + "%"
            ors += ["generation_name LIKE ?", "branch LIKE ?"]
            args += [like0, like0]
            where.append("(" + " OR ".join(ors) + ")")
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY generation_number, id"
        if limit:
            sql += " LIMIT ?"
            args.append(max(1, min(int(limit), 5000)))
        rows = conn.execute(sql, args).fetchall()
        ctx = _list_ctx(conn)          # 3 個查詢建索引，取代每人 3~4 個子查詢
        return [_project_member(conn, r, ctx) for r in rows]
    finally:
        conn.close()


def _birth_sort_key(birth, mid):
    """子女排序鍵：（有無可解析生日, 年, 月, 日, id）；缺月日排同年之後，看不懂的墊底。
    前端族譜樹 app.js 的 birthKey／kidOrder 同一套規則。"""
    p = _date_parts(birth)
    if p is None:
        return (1, 0, 0, 0, mid)
    y, m, d = p
    return (0, y, 13 if m is None else m, 32 if d is None else d, mid)


def _rank_known(rows) -> dict:
    """全家族表冠「長／次」用：子女（已依 _birth_sort_key 排好）兒、女各一組，組內相鄰兩人都
    判得出誰先出生，這組才排得出長幼 → {id: bool}。

    判不出＝任一方生日空白或看不懂、同年但一方只有年份、同一天（雙胞胎）等——規則同稱謂引擎
    kinship._born_before（總幹事 2026-08-21：長幼不明就不推定，不依建檔序硬排）。排不出時
    print.html 改印「子／女」留給總幹事手寫，免得把真正的老大印成「次男」（體檢 print-5）。
    只有一人的組自然排得出（獨子就是長男）。性別分組同 print.html：F 為女，其餘算兒子。
    """
    def before(pa, pb):
        for x, y in zip(pa, pb):
            if x is None or y is None:
                return False
            if x != y:
                return x < y
        return False                                   # 同一天：判不出誰是兄姊

    groups = {}
    for r in rows:
        groups.setdefault("F" if r["gender"] == "F" else "M", []).append(r)
    out = {}
    for rs in groups.values():
        parts = [_date_parts(r["birth_date"]) for r in rs]
        ok = len(rs) < 2 or (None not in parts and all(before(a, b) for a, b in zip(parts, parts[1:])))
        for r in rs:
            out[r["id"]] = ok
    return out


def get_member(member_id) -> dict | None:
    """GET /api/member/{id} → 詳細 + parents/spouses/children；查無回 None。"""
    conn = _conn()
    try:
        row = conn.execute("SELECT * FROM members WHERE id = ?", (member_id,)).fetchone()
        if row is None:
            return None
        fn = _father_name(conn, member_id)

        parents = [
            {
                "id": r["id"],
                "name": r["name"],
                "relation": ("母" if r["gender"] == "F" else "父"),
                # 雙軌制（規格 §4.1）：每條親邊帶型別（親生/過繼/收養），前端據此渲染 chip
                "relationType": r["relation_type"] or "BIOLOGICAL",
            }
            for r in conn.execute(
                """SELECT m.id, m.name, m.gender, r.relation_type
                     FROM relationships r JOIN members m ON m.id = r.parent_id
                    WHERE r.child_id = ?
                    ORDER BY m.gender DESC,
                             CASE r.relation_type WHEN 'ADOPTED' THEN 0 WHEN 'FOSTER' THEN 1 ELSE 2 END, r.id""",
                (member_id,),
            ).fetchall()
        ]
        spouses = []
        for r in conn.execute(
            """SELECT * FROM marriages WHERE spouse_1_id = ? OR spouse_2_id = ?""",
            (member_id, member_id),
        ).fetchall():
            other_id = r["spouse_2_id"] if r["spouse_1_id"] == member_id else r["spouse_1_id"]
            o = conn.execute("SELECT id, name, death_date, death_date_original FROM members WHERE id = ?",
                             (other_id,)).fetchone()
            spouses.append({
                "id": o["id"] if o else None,
                "name": o["name"] if o else "（外姓配偶）",
                "alive": _is_alive(o["death_date"], o["death_date_original"]) if o else None,
                "status": r["marriage_status"],
                "role": (r["spouse_role"] if "spouse_role" in r.keys() else None) or "",   # 續／側室／妾…（K-2）
            })
        # 子女依生日排序：不能 ORDER BY birth_date（H-2）——字串比較會把 1960/5/1、
        # 1960-5-1 排到 1960-11-20 之後，SQLite 還把沒填生日的排最前。
        # 解析成年月日再排；只有年份的排同年之後，空白或看不懂的墊底；同值 id 決勝。
        # rankKnown：同性別手足排得出長幼（見 _rank_known）。全家族表據此決定冠不冠「長／次」
        # （有手足生日不詳就改印「子／女」，見 print.html renderFamily）。
        # K-2：家族原表記載的子女順序（sib_order）優先——生日不詳的也排得出來；沒有記載的照生日排在後面。
        # 同一對父子可能有兩條邊（親生＋過繼），GROUP BY 併成一筆。
        kid_rows = sorted(conn.execute(
            """SELECT m.*, MAX(r.orig_label) AS orig_label, MIN(r.sib_order) AS sib_order
                 FROM relationships r JOIN members m ON m.id = r.child_id
                WHERE r.parent_id = ? GROUP BY m.id""",
            (member_id,),
        ).fetchall(), key=lambda r: ((0, r["sib_order"], r["id"]) if r["sib_order"] is not None
                                     else (1,) + tuple(_birth_sort_key(r["birth_date"], r["id"]))))
        # _rank_known 要吃依生日排好的序列（相鄰兩人比先後）
        rank_ok = _rank_known(sorted(kid_rows, key=lambda r: _birth_sort_key(r["birth_date"], r["id"])))
        # 子女的另一位家長＝也是本人配偶的那位（生母／生父）：有兩位以上配偶時，直系族譜表照原版依生母分段列
        sp_ids = {s["id"] for s in spouses if s["id"] is not None}
        other = {}
        if sp_ids and kid_rows:
            for r in conn.execute(
                    "SELECT child_id, parent_id FROM relationships WHERE child_id IN (%s) AND parent_id IN (%s)"
                    % (",".join("?" * len(kid_rows)), ",".join("?" * len(sp_ids))),
                    [r["id"] for r in kid_rows] + list(sp_ids)):
                other.setdefault(r["child_id"], r["parent_id"])
        children = [
            {"id": r["id"], "name": r["name"], "gen": r["generation_number"],
             "rankKnown": rank_ok[r["id"]], "origLabel": r["orig_label"] or "", "otherParent": other.get(r["id"])}
            for r in kid_rows
        ]
        tomb = conn.execute(
            "SELECT address_description, detail_location_code, tomb_type FROM tombs "
            " WHERE member_id = ? LIMIT 1",
            (member_id,),
        ).fetchone()
        burial = ""
        if tomb:
            burial = " · ".join([x for x in (tomb["address_description"], tomb["detail_location_code"]) if x])
        burial_desc = (tomb["address_description"] or "") if tomb else ""   # 表單編輯用（不含穴位代碼）
        burial_code = (tomb["detail_location_code"] or "") if tomb else ""  # 穴位／塔位編號
        burial_type = (tomb["tomb_type"] or "") if tomb else ""             # BURIAL／COLUMBARIUM／TREE

        era, lunar = _split_original(row["birth_date_original"])
        inlaw = _inlaw_tag(conn, row["gender"], bool(parents),
                           (spouses[0]["id"] if spouses else None))
        return {
            "id": row["id"],
            "name": row["name"],
            "styleName": row["generation_name"] or "",
            "gen": row["generation_number"],
            "branch": row["branch"] or "",
            "fatherName": fn,
            "gender": row["gender"] or "",
            "alive": _is_alive(row["death_date"], row["death_date_original"]),
            "birth": row["birth_date"] or "",
            "death": row["death_date"] or "",
            "birthOriginal": row["birth_date_original"] or "",
            "deathOriginal": row["death_date_original"] or "",
            # R3：國曆生卒換算農曆（干支年＋月日）；缺件／超出查表回 ''，
            # 前端「農」徽章優先顯示換算值、無則維持原始記載原文
            "birthLunar": solar_to_lunar_cn(row["birth_date"]),
            "deathLunar": solar_to_lunar_cn(row["death_date"]),
            "phone": row["phone"] or "",
            "city": row["current_address"] or "",
            "address": row["current_address"] or "",   # 列印端統一鍵名（與 list_members 對齊）
            "postalCode": (row["postal_code"] if "postal_code" in row.keys() else "") or "",
            "ganzhi": _ganzhi(row["birth_date"], row["birth_date_original"]),
            "era": era,
            "lunar": lunar,
            "burial": burial,
            "burialDesc": burial_desc,
            "burialCode": burial_code,
            "burialType": burial_type,
            "note": (row["note"] if "note" in row.keys() else "") or "",
            # R4：家族習慣稱呼（稱謂計算 forward 覆寫用；成員表單「習慣稱呼」欄）
            "customKin": (row["custom_kinship_term"] if "custom_kinship_term" in row.keys() else "") or "",
            "inlaw": inlaw,
            "mailTarget": bool(row["mail_target"]) if "mail_target" in row.keys() and row["mail_target"] else False,
            "label": _label(row, fn, inlaw),
            "parents": parents,
            "spouses": spouses,
            "children": children,
            # 穴排位：被指到哪些場地的哪一格（詳情卡顯示「葬於 ○○場地 第14世 第3格」）
            "sites": member_tomb_sites(conn, member_id),
        }
    finally:
        conn.close()


_FIELD_MAP = {
    "name": "name",
    "styleName": "generation_name",
    "gen": "generation_number",
    "branch": "branch",
    "gender": "gender",
    "birth": "birth_date",
    "death": "death_date",
    "birthOriginal": "birth_date_original",
    "deathOriginal": "death_date_original",
    "phone": "phone",
    "city": "current_address",
    "postalCode": "postal_code",
    "customKin": "custom_kinship_term",   # R4：家族習慣稱呼（稱謂覆寫）
    "note": "note",
    "mailTarget": "mail_target",          # 掃墓通知寄送對象（戶長／代表制）
}


def _branch_guard(conn, member_id):
    """房頭護欄（規格 §3：掃墓現場各房只改自己那一房，操作護欄非資安機制）。

    解鎖時若鎖定某房（_LOCK['branch'] 非空），寫入的目標成員（親屬增刪
    以 child 端為準）必須屬於該房，否則 403 白話訊息。
    委員選「全部」（branch 空）不受限；查無成員時不在此擋
    （交由各路由自行回 404 或照常執行）。
    """
    lb = _LOCK["branch"] or ""
    if not lb:
        return
    row = conn.execute("SELECT branch FROM members WHERE id = ?", (member_id,)).fetchone()
    if row is None:
        return
    mb = (row["branch"] or "").strip()
    if mb != lb:
        raise ApiError(403, "編輯範圍限『%s』，此成員屬『%s』" % (lb, mb or "未分房"))


def _descendant_ids(conn, member_id) -> set:
    """收集 member 的全部後代 id（沿 relationships parent→child 逐層下溯）。

    供改父防環使用：把「經女性親邊掛出的外孫」等所有下行邊一併納入，
    以最保守的超集合防止任何形式的族譜迴圈。附迭代上限保險（防既有髒資料成環）。
    """
    out, queue, guard = set(), [member_id], 0
    while queue and guard < 100000:
        guard += 1
        pid = queue.pop()
        rows = conn.execute(
            "SELECT child_id FROM relationships WHERE parent_id = ?", (pid,)
        ).fetchall()
        for r in rows:
            cid = r["child_id"]
            if cid not in out:
                out.add(cid)
                queue.append(cid)
    return out


def _set_father(conn, member_id, father_id) -> None:
    """改掛「生物父」邊（不 commit，由呼叫端統一提交）。

    規則：
      * father_id 為 None → 僅清除既有男性生物父邊（成為無父者，如始遷祖）。
      * 防環：新父不得為本人，也不得為本人的任何後代（會造成族譜迴圈）。
      * 只刪「男性親代」的 BIOLOGICAL 邊，保留母親等其他親邊不受影響。
    """
    try:
        member_id = int(member_id)
    except (TypeError, ValueError):
        raise ApiError(400, "成員編號格式錯誤")
    if father_id is not None:
        try:
            father_id = int(father_id)
        except (TypeError, ValueError):
            raise ApiError(400, "父親編號格式錯誤")
        if father_id == member_id:
            raise ApiError(400, "父親不可指定為本人，請重新選擇。")
        row = conn.execute("SELECT id FROM members WHERE id = ?", (father_id,)).fetchone()
        if row is None:
            raise ApiError(400, "指定的父親不存在，請重新選擇。")
        # 父端不擋（同 add_parent，2026-07-28）：共同祖先不屬任何房，一擋就沒人能接上代。
        # child 端房頭已由呼叫端（save_member）擋過。
        if father_id in _descendant_ids(conn, member_id):
            raise ApiError(400, "父親不可指定為此成員的後代（會造成族譜迴圈），請重新選擇。")
    # 先刪既有「男性生物父」邊（保留母親等親邊），再建新邊
    conn.execute(
        """DELETE FROM relationships
            WHERE child_id = ? AND relation_type = 'BIOLOGICAL'
              AND parent_id IN (SELECT id FROM members WHERE gender = 'M')""",
        (member_id,),
    )
    if father_id is not None:
        conn.execute(
            "INSERT OR IGNORE INTO relationships (parent_id, child_id, relation_type) VALUES (?,?, 'BIOLOGICAL')",
            (father_id, member_id),
        )


_TOMB_TYPES = ("BURIAL", "COLUMBARIUM", "TREE")   # 土葬／塔位／樹葬（schema CHECK 同值）


def _save_burial(conn, member_id, text, code=None, ttype=None) -> None:
    """安葬資訊：members 無此欄，落 tombs（一人一列，不 commit）。

    三欄可編：address_description（墓園／塔位位置文字）、detail_location_code（穴位／塔位編號）、
    tomb_type（型態）。code／ttype 為 None＝此次不動該欄（相容只送位置文字的舊呼叫）。
    三者皆空時整列刪除，不留空殼。
    lat/long/photo 目前無 UI，屬保留欄位（見 db.py schema 註記）。
    """
    text = str(text or "").strip()
    row = conn.execute(
        "SELECT id, address_description, detail_location_code, tomb_type FROM tombs "
        " WHERE member_id = ? LIMIT 1",
        (member_id,),
    ).fetchone()
    code_new = row["detail_location_code"] if (code is None and row) else str(code or "").strip()
    type_new = row["tomb_type"] if (ttype is None and row) else str(ttype or "").strip().upper()
    if type_new not in _TOMB_TYPES:
        type_new = None
    if row is None:
        if text or code_new:
            conn.execute(
                "INSERT INTO tombs (member_id, address_description, detail_location_code, tomb_type)"
                " VALUES (?,?,?,?)",
                (member_id, text, code_new or None, type_new),
            )
    elif text or code_new:
        conn.execute(
            "UPDATE tombs SET address_description = ?, detail_location_code = ?, tomb_type = ?"
            " WHERE id = ?",
            (text, code_new or None, type_new, row["id"]),
        )
    else:
        conn.execute("DELETE FROM tombs WHERE id = ?", (row["id"],))   # 三欄皆空＝移除


def save_member(payload) -> dict:
    """POST /api/member（需編輯模式）。新增或更新成員，回 {id}。

    fatherId 只在「新增」時掛生物父邊；更新既有成員不碰父邊——
    _set_father 會把該員全部父邊砍掉重建，過繼者（BIOLOGICAL＋ADOPTED 兩條）
    會被不可逆抹成一條。父母增刪一律走 add_parent / remove_parent。
    帶 burial 時同步寫 tombs（見 _save_burial）；防環見 _set_father。
    """
    if not _LOCK["editMode"]:
        raise ApiError(403, "edit mode required")
    payload = payload or {}
    if _LOCK["branch"]:
        # R2 房頭護欄：鎖定某房時，新增／更新之成員一律落在該房（強制帶入）
        payload = dict(payload)
        payload["branch"] = _LOCK["branch"]
    if "name" in payload and not str(payload.get("name") or "").strip():
        raise ApiError(400, "請填寫姓名")
    cols, vals = [], []
    for fe, col in _FIELD_MAP.items():
        if fe in payload:
            cols.append(col)
            v = payload[fe]
            if fe in ("birth", "death"):
                v = normalize_date(v)   # H-2：1970-5-1、1970/5/1 → 1970-05-01（長幼與農曆換算靠它）
            vals.append(v)
    conn = _conn()
    try:
        mid = payload.get("id")
        if mid:
            _branch_guard(conn, mid)   # R2：更新目標須在鎖定房頭內
            if cols:
                conn.execute(
                    "UPDATE members SET %s WHERE id = ?" % ", ".join("%s = ?" % c for c in cols),
                    vals + [mid],
                )
            # fatherId 於更新列刻意忽略（見 docstring）；前端 app.js 儲存時也早已不送
            if "burial" in payload:
                _save_burial(conn, mid, payload.get("burial"),
                             payload.get("burialCode"), payload.get("burialType"))
            conn.commit()
            return {"id": mid}
        # 新增：name / generation_number 必填（NOT NULL）
        if not str(payload.get("name") or "").strip():
            raise ApiError(400, "請填寫姓名")
        if "generation_number" not in cols:
            cols.append("generation_number")
            vals.append(payload.get("gen", 1))
        cur = conn.execute(
            "INSERT INTO members (%s) VALUES (%s)" % (", ".join(cols), ", ".join("?" * len(cols))),
            vals,
        )
        new_id = cur.lastrowid
        if payload.get("fatherId"):
            _set_father(conn, new_id, payload.get("fatherId"))
        if "burial" in payload:
            _save_burial(conn, new_id, payload.get("burial"),
                         payload.get("burialCode"), payload.get("burialType"))
        conn.commit()
        return {"id": new_id}
    finally:
        conn.close()


def delete_member(member_id) -> dict:
    """DELETE /api/member/{id}（需編輯模式）。

    僅「名下仍有子女」擋刪（schema ON DELETE RESTRICT → 這裡先行檢查轉 409 白話）；
    本人作為「子女／配偶」的關聯邊先行清除，讓葉節點可順利刪除。
    墓葬由 schema CASCADE 一併清除、祭祖事件逝者欄 SET NULL。
    """
    if not _LOCK["editMode"]:
        raise ApiError(403, "edit mode required")
    import sqlite3  # noqa: PLC0415
    conn = _conn()
    try:
        row = conn.execute("SELECT id, name FROM members WHERE id = ?", (member_id,)).fetchone()
        if row is None:
            raise ApiError(404, "member not found")
        _branch_guard(conn, member_id)   # R2：刪除目標須在鎖定房頭內
        kids = conn.execute(
            "SELECT COUNT(DISTINCT child_id) AS c FROM relationships WHERE parent_id = ?",
            (member_id,),
        ).fetchone()["c"]
        if kids:
            raise ApiError(
                409,
                "「%s」名下仍有 %d 位子女，無法刪除。請先於各子女的編輯表單改選其他父親（或先刪除子女），再回來刪除此成員。"
                % (row["name"], kids),
            )
        # 先清除本人作為「子女」與「配偶」的關聯邊（先刪婚姻再刪成員，避開 RESTRICT）
        conn.execute("DELETE FROM relationships WHERE child_id = ?", (member_id,))
        conn.execute(
            "DELETE FROM marriages WHERE spouse_1_id = ? OR spouse_2_id = ?",
            (member_id, member_id),
        )
        conn.execute("DELETE FROM members WHERE id = ?", (member_id,))
        conn.commit()
        return {"ok": True}
    except sqlite3.IntegrityError:
        conn.rollback()
        raise ApiError(409, "此成員仍有其他資料關聯（後代或配偶），請先處理後再刪除。")
    finally:
        conn.close()


# ── 親屬關係管理（規格 §4.1 雙軌制：血緣＋法定/禮法可並存）──────────
# 本生父 BIOLOGICAL 與嗣父 ADOPTED/FOSTER 可同時綁定；總幹事於 app 內直接維護。

_REL_TYPES = ("BIOLOGICAL", "ADOPTED", "FOSTER")
_SPOUSE_STATUS = ("MARRIED", "DIVORCED", "WIDOWED", "SEPARATED")


def _rel_ids(member_id, other_id, other_name="對方") -> tuple:
    """親屬端點共用的 id 正規化＋防自身；回 (member_id, other_id) 皆為 int。"""
    try:
        member_id = int(member_id)
    except (TypeError, ValueError):
        raise ApiError(400, "成員編號格式錯誤")
    try:
        other_id = int(other_id)
    except (TypeError, ValueError):
        raise ApiError(400, "%s編號格式錯誤" % other_name)
    if member_id == other_id:
        raise ApiError(400, "%s不可指定為本人，請重新選擇。" % other_name)
    return member_id, other_id


def add_parent(member_id, parent_id, relation_type) -> dict:
    """POST /api/member/{id}/parent {parentId, relationType}（需編輯模式）。

    upsert 指定型別的父/母邊。規則：
      * relationType 限 BIOLOGICAL（親生）/ ADOPTED（過繼）/ FOSTER（收養）。
      * 同一 child 每型別至多一位男性父＋一位女性母（同槽位舊邊先移除）；
        BIOLOGICAL 與 ADOPTED/FOSTER 可並存（雙軌）。
      * 親代性別空白 → 400（分不出父槽母槽，請先設定性別）。
      * 防自身、防環（新父/母不得為本人的任何後代，用 _descendant_ids 超集合）。
    """
    if not _LOCK["editMode"]:
        raise ApiError(403, "edit mode required")
    rt = str(relation_type or "").strip().upper()
    if rt not in _REL_TYPES:
        raise ApiError(400, "關係型別須為 BIOLOGICAL（親生）/ ADOPTED（過繼）/ FOSTER（收養）")
    member_id, parent_id = _rel_ids(member_id, parent_id, "父/母")
    conn = _conn()
    try:
        if conn.execute("SELECT id FROM members WHERE id = ?", (member_id,)).fetchone() is None:
            raise ApiError(404, "member not found")
        # R2 房頭護欄只看 child 端。父/母端不擋，理由有二（2026-07-28 修正）：
        #   1. 共同祖先（始遷祖／未分房）不屬任何房，一擋就沒人能接上代；
        #   2. 過繼本來就常跨房（某房無子，過繼他房之子），擋了等於廢掉過繼功能。
        # 父/母端不擋不會外洩：新增親邊不會改到對方任何欄位，只是長一條邊。
        _branch_guard(conn, member_id)
        prow = conn.execute("SELECT id, name, gender FROM members WHERE id = ?", (parent_id,)).fetchone()
        if prow is None:
            raise ApiError(400, "指定的父/母不存在，請重新選擇。")
        if not prow["gender"]:
            # 性別空白＝不知道要佔父槽還是母槽（H-3／體檢 backend-4，2026-09-25）。
            # 舊版一律當母槽：先刪掉同型別的生母邊再插入，加一位「不詳」的父親，
            # 母親就被默默擠掉。改成擋下來，請使用者先補性別。
            raise ApiError(400, "「%s」的性別還沒設定，無法判斷要加為父親還是母親。"
                                "請先到這位親屬的成員資料設定性別（男／女），再回來加入。" % prow["name"])
        if parent_id in _descendant_ids(conn, member_id):
            raise ApiError(400, "父/母不可指定為此成員的後代（會造成族譜迴圈），請重新選擇。")
        # 槽位規則：同型別同性別至多一位（男性＝父槽、其餘＝母槽），先清舊邊再建新邊
        if prow["gender"] == "M":
            conn.execute(
                """DELETE FROM relationships
                    WHERE child_id = ? AND relation_type = ?
                      AND parent_id IN (SELECT id FROM members WHERE gender = 'M')""",
                (member_id, rt),
            )
        else:
            # 母槽只清「有設性別、且非男」的舊邊：舊庫裡性別空白的親代（多半是經父名匯入的
            # 父親）不算母槽，加生母時不可順手把他刪掉（backend-4 的反向）
            conn.execute(
                """DELETE FROM relationships
                    WHERE child_id = ? AND relation_type = ?
                      AND parent_id IN (SELECT id FROM members
                                         WHERE gender IS NOT NULL AND gender <> 'M')""",
                (member_id, rt),
            )
        # UNIQUE(parent_id, child_id, relation_type) 防重複，重送走 INSERT OR IGNORE
        conn.execute(
            "INSERT OR IGNORE INTO relationships (parent_id, child_id, relation_type) VALUES (?,?,?)",
            (parent_id, member_id, rt),
        )
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


def remove_parent(member_id, parent_id, relation_type=None) -> dict:
    """DELETE /api/member/{id}/parent/{parentId}[?relationType=]（需編輯模式）。

    移除該父/母邊；帶 relationType 時僅刪該型別（雙軌同人並存時可精準移除），
    未帶則刪除兩人間全部親邊。
    """
    if not _LOCK["editMode"]:
        raise ApiError(403, "edit mode required")
    member_id, parent_id = _rel_ids(member_id, parent_id, "父/母")
    rt = str(relation_type or "").strip().upper()
    conn = _conn()
    try:
        _branch_guard(conn, member_id)   # R2：以 child 端房頭為準
        if rt in _REL_TYPES:
            cur = conn.execute(
                "DELETE FROM relationships WHERE child_id = ? AND parent_id = ? AND relation_type = ?",
                (member_id, parent_id, rt),
            )
        else:
            cur = conn.execute(
                "DELETE FROM relationships WHERE child_id = ? AND parent_id = ?",
                (member_id, parent_id),
            )
        conn.commit()
        return {"ok": True, "removed": cur.rowcount}
    finally:
        conn.close()


def add_spouse(member_id, spouse_id, status=None) -> dict:
    """POST /api/member/{id}/spouse {spouseId, status}（需編輯模式）。

    新增婚姻邊；防自婚（schema CHECK 之外先行白話擋下）。同一對已存在
    （不分先後順序）則改為更新婚姻狀態（等效 upsert，避免重複邊）。
    """
    if not _LOCK["editMode"]:
        raise ApiError(403, "edit mode required")
    st = str(status or "MARRIED").strip().upper()
    if st not in _SPOUSE_STATUS:
        raise ApiError(400, "婚姻狀態須為 MARRIED/DIVORCED/WIDOWED/SEPARATED")
    member_id, spouse_id = _rel_ids(member_id, spouse_id, "配偶")
    conn = _conn()
    try:
        if conn.execute("SELECT id FROM members WHERE id = ?", (member_id,)).fetchone() is None:
            raise ApiError(404, "member not found")
        # 只擋本人端。配偶端不擋（同 add_parent，2026-07-28）：配偶多半未分房或來自他房，
        # 一擋就結不成婚；長一條婚姻邊不會改到對方任何欄位。
        _branch_guard(conn, member_id)
        if conn.execute("SELECT id FROM members WHERE id = ?", (spouse_id,)).fetchone() is None:
            raise ApiError(400, "指定的配偶不存在，請重新選擇。")
        row = conn.execute(
            """SELECT id FROM marriages
                WHERE (spouse_1_id = ? AND spouse_2_id = ?)
                   OR (spouse_1_id = ? AND spouse_2_id = ?)""",
            (member_id, spouse_id, spouse_id, member_id),
        ).fetchone()
        if row:
            conn.execute("UPDATE marriages SET marriage_status = ? WHERE id = ?", (st, row["id"]))
            conn.commit()
            return {"ok": True, "id": row["id"]}
        cur = conn.execute(
            "INSERT INTO marriages (spouse_1_id, spouse_2_id, marriage_status) VALUES (?,?,?)",
            (member_id, spouse_id, st),
        )
        conn.commit()
        return {"ok": True, "id": cur.lastrowid}
    finally:
        conn.close()


def remove_spouse(member_id, spouse_id) -> dict:
    """DELETE /api/member/{id}/spouse/{spouseId}（需編輯模式）。移除兩人間婚姻邊。"""
    if not _LOCK["editMode"]:
        raise ApiError(403, "edit mode required")
    member_id, spouse_id = _rel_ids(member_id, spouse_id, "配偶")
    conn = _conn()
    try:
        _branch_guard(conn, member_id)   # R2：目標成員須在鎖定房頭內
        cur = conn.execute(
            """DELETE FROM marriages
                WHERE (spouse_1_id = ? AND spouse_2_id = ?)
                   OR (spouse_1_id = ? AND spouse_2_id = ?)""",
            (member_id, spouse_id, spouse_id, member_id),
        )
        conn.commit()
        return {"ok": True, "removed": cur.rowcount}
    finally:
        conn.close()
