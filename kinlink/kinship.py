# -*- coding: utf-8 -*-
"""稱謂引擎：查表＋規則派生＋LCA 血親＋姻親橋接（原 server.py，R4/C-1）。"""
from __future__ import annotations

from .errors import ApiError
from .lunar import _date_parts
from .state import _conn


# ── R4 稱謂強化：姻親轉換查表（基本常用集；查不到的關係退回「族親」，不硬湊）──────
# _SPOUSE_OF[我對血親X的稱謂][X 之配偶性別] → 我對「X 的配偶」的稱謂
_SPOUSE_OF = {
    "本人":   {"M": "丈夫", "F": "妻子"},
    "父親":   {"F": "母親"},
    "母親":   {"M": "父親"},
    "祖父":   {"F": "祖母"},
    "曾祖父": {"F": "曾祖母"},
    # 高祖父結尾是「父」，下方規則式派生接不到；少這行每個人的高祖母都算成「族親」、
    # 反過來又算成「姻親」，以高祖母為先人時 {裔稱} 整層落空（體檢 domain-1）
    "高祖父": {"F": "高祖母"},
    # 世代階梯的父輩實際產出 伯父/叔叔（不是舊鍵「叔伯」）——鍵不對齊曾讓
    # 這條路永遠查不到（C-1 姻親斷層的一部分）
    "伯父":   {"F": "伯母"},
    "叔叔":   {"F": "嬸嬸"},
    "哥哥":   {"F": "嫂嫂"},
    "弟弟":   {"F": "弟媳"},
    "姊姊":   {"M": "姊夫"},
    "妹妹":   {"M": "妹夫"},
    "姑姑":   {"M": "姑丈"},
    "叔伯":   {"F": "伯母／嬸嬸"},
    "兒子":   {"F": "媳婦"},
    "女兒":   {"M": "女婿"},
    "孫子":   {"F": "孫媳婦"},
    "孫女":   {"M": "孫女婿"},
    "姪子":   {"F": "姪媳婦"},
    "姪女":   {"M": "姪女婿"},
    "堂兄":   {"F": "堂嫂"},
    "堂弟":   {"F": "堂弟媳"},
    "堂姊":   {"M": "堂姊夫"},
    "堂妹":   {"M": "堂妹夫"},
}
# _VIA_SPOUSE[配偶對目標的血親稱謂][我的性別] → 我對目標的稱謂（夫之兄＝大伯…）
_VIA_SPOUSE = {
    "父親":   {"F": "公公", "M": "岳父"},
    "母親":   {"F": "婆婆", "M": "岳母"},
    "哥哥":   {"F": "大伯", "M": "大舅子"},
    "弟弟":   {"F": "小叔", "M": "小舅子"},
    "姊姊":   {"F": "大姑", "M": "大姨子"},
    "妹妹":   {"F": "小姑", "M": "小姨子"},
    # 卑親屬從配偶稱（繼親不細分，屬基本常用集之簡化）
    "兒子":   {"F": "兒子", "M": "兒子"},
    "女兒":   {"F": "女兒", "M": "女兒"},
    "孫子":   {"F": "孫子", "M": "孫子"},
    "孫女":   {"F": "孫女", "M": "孫女"},
    "曾孫":   {"F": "曾孫", "M": "曾孫"},
    "曾孫女": {"F": "曾孫女", "M": "曾孫女"},
    "姪子":   {"F": "姪子", "M": "姪子"},
    "姪女":   {"F": "姪女", "M": "姪女"},
}
# 經母親橋接（嫁出女之子女＝外孫線）：
# _MOTHER_CHILD[我對其母的稱謂][子女性別] → 我對「她的子女」的稱謂
_MOTHER_CHILD = {
    "女兒":   {"M": "外孫", "F": "外孫女"},
    "孫女":   {"M": "外曾孫", "F": "外曾孫女"},
    "姊姊":   {"M": "外甥", "F": "外甥女"},
    "妹妹":   {"M": "外甥", "F": "外甥女"},
    "姑姑":   {"M": "表兄弟", "F": "表姊妹"},
}
# _VIA_MOTHER[母親對目標的稱謂] → 我（她的子女）對目標的稱謂（母之兄弟＝舅舅…）
_VIA_MOTHER = {
    "父親": "外公",
    "母親": "外婆",
    "祖父": "外曾祖父",
    "祖母": "外曾祖母",
    "哥哥": "舅舅",
    "弟弟": "舅舅",
    "姊姊": "阿姨",
    "妹妹": "阿姨",
    "姪子": "表兄弟",
    "姪女": "表姊妹",
}


def _spouse_term(term, spouse_gender):
    """我對血親 X 的稱謂 → 我對「X 之配偶」的稱謂（C-1：規則式派生）。

    先查 _SPOUSE_OF（精確詞：嫂嫂/姊夫/姑丈…），查無再套派生規則——
    查表只收得了 20 個詞，但世代階梯會產出 伯公/叔公/曾叔公/姑婆/族兄/姪孫…
    整族的組合，逐詞列舉永遠列不完；規則式才蓋得住（叔公→叔婆、姑婆→姑丈公）。
    派生不到的回 None（交上層走友善訊息，不硬掰）。
    """
    t = _SPOUSE_OF.get(term, {}).get(spouse_gender)
    if t:
        return t
    if not term:
        return None
    if spouse_gender == "F":
        # 男性尊長之妻
        if term.endswith("伯公") or term.endswith("叔公"):
            return term[:-1] + "婆"          # 伯公→伯婆、曾叔公→曾叔婆、高伯公→高伯婆
        if term.endswith("公"):
            return term[:-1] + "媽"          # 祖公→祖媽、(名)公→(名)媽、第X世祖公→第X世祖媽
        # 同世與卑親屬之妻
        if term == "族兄":
            return "族嫂"
        if term == "族弟":
            return "族弟媳"
        if term.endswith("孫"):
            return term + "媳婦"             # 姪孫/曾姪孫/玄姪孫/曾孫/裔孫 → ＋媳婦
        return None
    if spouse_gender == "M":
        # 女性尊長之夫
        if term.endswith("姑婆"):
            return term[:-1] + "丈公"        # 姑婆→姑丈公、曾姑婆→曾姑丈公、高姑婆→高姑丈公
        if term.endswith("祖媽"):
            return term[:-1] + "公"          # 祖媽→祖公（罕見路徑，對稱補齊）
        # 同世與卑親屬之夫
        if term in ("族姊", "族妹"):
            return term + "夫"               # 族姊夫／族妹夫
        if term.endswith("女"):
            return term + "婿"               # 姪孫女/曾姪孫女/孫女/裔孫女 → ＋婿
        return None
    return None


def _via_spouse_term(term, my_gender):
    """我配偶對目標的血親稱謂 → 我對目標的稱謂（妻從夫稱／夫從妻稱）。

    先查 _VIA_SPOUSE（公公/岳父/大伯…有專詞），查無＝直接從配偶稱——
    台灣宗族慣例：嫁入配偶對夫家的同宗階梯（叔公/姑婆/族兄…）與卑親屬
    一律沿用丈夫的稱謂，不另造詞。
    """
    t = _VIA_SPOUSE.get(term, {}).get(my_gender)
    return t or term


def _kin_info(conn, mid):
    """稱謂計算用成員摘要（含 custom_kinship_term 供家族習慣稱呼覆寫）。"""
    return conn.execute(
        "SELECT id, name, gender, birth_date, generation_number, custom_kinship_term "
        "FROM members WHERE id = ?",
        (mid,),
    ).fetchone()


def _kin_chain(conn, mid):
    """沿男性親邊上溯父系鏈（含本人；seen 防髒資料成環，不設代數上限）。

    承嗣主線：ADOPTED/FOSTER 優先（與樹掛靠/父名標籤同序，見 _father_name 注記）。
    原本無 ORDER BY（靠 rowid 取邊）導致過繼者稱謂沿哪條線取決於寫入順序、
    且與樹狀圖自相矛盾——2026-07-16 檢討修正。

    2026-07-28：原本是 `guard < 30` 計數守衛。它有兩個毛病：
      * 是代數上限（只解得到 29 代內的祖先），族譜超過 30 世就算不出稱謂；
      * 真的成環時它照樣讓迴圈跑滿 30 次，回一條「重複好幾輪」的假鏈，
        下游 _kin_blood 拿 index() 取到第一次出現的位置，於是吐出一個
        看起來很篤定的錯稱謂（實測「裔孫／下傳 28 代」）。
    改成 seen 集合後：環一定終止且鏈是乾淨的（稱謂退回「族親」友善訊息），
    代數也不再設限。寫法與 app.js locateInTree 的 seen 一致。
    """
    out, seen, cur = [], set(), mid
    while cur is not None and cur not in seen:
        seen.add(cur)
        out.append(cur)
        r = conn.execute(
            """SELECT parent_id FROM relationships r
                 JOIN members m ON m.id = r.parent_id
                WHERE r.child_id = ? AND m.gender = 'M'
                ORDER BY CASE r.relation_type WHEN 'ADOPTED' THEN 0 WHEN 'FOSTER' THEN 1 ELSE 2 END, r.id
                LIMIT 1""",
            (cur,),
        ).fetchone()
        cur = r["parent_id"] if r else None
    return out


def _kin_mother(conn, mid):
    """女性親邊之母（嫁出女之子女走此邊）；無則 None。

    與父鏈同序：ADOPTED/FOSTER 優先、再依 r.id（體檢 domain-7）。原本只有 LIMIT 1，
    過繼者同時登錄本生母與嗣母時，本生母算成「母親」還是「嬸嬸」取決於親邊寫入先後，
    跟本生父＝叔叔自相矛盾。

    過繼者只登錄本生母、沒登錄嗣母時也一樣：父鏈已改走嗣父，本生母又是本生父的現任妻子，
    就不當「母親」，交給配偶橋接經本生父算（本生父＝叔叔 → 本生母＝嬸嬸）。
    沒登錄本生父、或她嫁的是嗣父（寡母改嫁、繼父收養）時照舊是母親。
    """
    rows = conn.execute(
        """SELECT r.parent_id, m.gender, COALESCE(r.relation_type, 'BIOLOGICAL') AS rt
             FROM relationships r
             JOIN members m ON m.id = r.parent_id
            WHERE r.child_id = ? AND m.gender IN ('M', 'F')
            ORDER BY CASE r.relation_type WHEN 'ADOPTED' THEN 0 WHEN 'FOSTER' THEN 1 ELSE 2 END, r.id""",
        (mid,),
    ).fetchall()
    moms = [r for r in rows if r["gender"] == "F"]
    if not moms:
        return None
    mom, dads = moms[0], [r for r in rows if r["gender"] == "M"]
    step = ("ADOPTED", "FOSTER")
    if dads and dads[0]["rt"] in step and mom["rt"] not in step:

        def wed(f):   # 她跟 f 現在是夫妻（離異的不算：前妻不走配偶橋接）
            return _kin_married(conn, mom["parent_id"], f) not in (None, "DIVORCED")

        if any(wed(d["parent_id"]) for d in dads if d["rt"] not in step) and not wed(dads[0]["parent_id"]):
            return None
    return _kin_info(conn, mom["parent_id"])


def _kin_spouses(conn, mid, divorced=False):
    """成員之全部配偶摘要（marriages 兩欄不分先後）。

    離異的婚姻不算（體檢 domain-6）：不然前妻仍被當現任，再婚所生的兒子稱她「母親」、
    公公稱她「媳婦」。親生子女對親生母親走 relationships 母邊，不受影響；
    親生那一支的孫輩以下另由 _kin_bore_line 保住（divorced=True 只回離異的前配偶）。
    """
    out = []
    for r in conn.execute(
        "SELECT * FROM marriages WHERE (spouse_1_id = ? OR spouse_2_id = ?)"
        " AND COALESCE(marriage_status, 'MARRIED') %s 'DIVORCED'" % ("=" if divorced else "<>"),
        (mid, mid),
    ).fetchall():
        oid = r["spouse_2_id"] if r["spouse_1_id"] == mid else r["spouse_1_id"]
        if oid:
            o = _kin_info(conn, oid)
            if o:
                out.append(o)
    return out


def _kin_married(conn, a, b):
    """兩人之間的婚姻邊（夫妻直判用）：有則回婚姻狀態（'MARRIED'／'DIVORCED'…），無則 None。

    同一對有多筆時（離了又復合）以未離異的為準；呼叫端靠 'DIVORCED' 改稱前妻／前夫。
    """
    r = conn.execute(
        """SELECT COALESCE(marriage_status, 'MARRIED') AS st FROM marriages
            WHERE (spouse_1_id = ? AND spouse_2_id = ?)
               OR (spouse_1_id = ? AND spouse_2_id = ?)
            ORDER BY CASE WHEN COALESCE(marriage_status, 'MARRIED') = 'DIVORCED' THEN 1 ELSE 0 END
            LIMIT 1""",
        (a, b, b, a),
    ).fetchone()
    return r["st"] if r else None


def _kin_bore_line(conn, mother_id, father_id, desc_id):
    """mother_id 是不是 desc_id 這一支的直系尊親：desc 的父系鏈上、緊接在 father_id 下面那一代
    是她親生（relationships 有親邊）。

    給離異的前妻用：離婚不改血緣，她親生那一支的孫、曾孫照樣稱她祖母、曾祖母，
    這一支子孫的配偶也照樣是她的媳婦、女婿、孫媳婦（雙姻親橋接）——
    只排除離異婚姻（domain-6）的話，這些人會一起掉成「族親」。
    """
    chain = _kin_chain(conn, desc_id)
    if father_id not in chain[1:]:
        return False
    child = chain[chain.index(father_id) - 1]
    return conn.execute(
        "SELECT 1 FROM relationships WHERE parent_id = ? AND child_id = ?", (mother_id, child)
    ).fetchone() is not None


def _kin_blood(conn, A, B) -> dict | None:
    """父系血親稱謂核心（原 LCA 邏輯）。找不到共同父系祖先回 None（供橋接接手）。"""
    pa, pb = _kin_chain(conn, A["id"]), _kin_chain(conn, B["id"])
    lca, da, db_ = None, 0, 0
    for i, x in enumerate(pa):
        if x in pb:
            lca, da, db_ = x, i, pb.index(x)
            break
    if lca is None:
        return None

    up = {1: ["父親", "母親"], 2: ["祖父", "祖母"], 3: ["曾祖父", "曾祖母"], 4: ["高祖父", "高祖母"]}
    down = {1: ["兒子", "女兒"], 2: ["孫子", "孫女"], 3: ["曾孫", "曾孫女"], 4: ["玄孫", "玄孫女"]}

    def _gen_txt(row):
        g = row["generation_number"] if "generation_number" in row.keys() else None
        return ("第%s世" % g) if g else ""

    if lca == B["id"]:
        if da in up:
            return {
                "forward": up[da][1 if B["gender"] == "F" else 0],
                "backward": down[da][1 if A["gender"] == "F" else 0],
                "path": "目標是你的直系尊親（上溯 %d 代）。" % da,
            }
        # 高祖以上之直系遠祖：口語不疊「天/烈祖」，以「第X世祖公/祖媽」尊稱
        f = (_gen_txt(B) or "遠") + ("祖媽" if B["gender"] == "F" else "祖公")
        return {"forward": f, "backward": ("裔孫女" if A["gender"] == "F" else "裔孫"),
                "path": "目標是你的直系遠祖（上溯 %d 代）→ %s。" % (da, f)}
    if lca == A["id"]:
        if db_ in up:
            return {
                "forward": down[db_][1 if B["gender"] == "F" else 0],
                "backward": up[db_][1 if A["gender"] == "F" else 0],
                "path": "目標是你的直系卑親（下傳 %d 代）。" % db_,
            }
        b = (_gen_txt(A) or "遠") + ("祖媽" if A["gender"] == "F" else "祖公")
        return {"forward": ("裔孫女" if B["gender"] == "F" else "裔孫"), "backward": b,
                "path": "目標是你的直系遠裔（下傳 %d 代）。" % db_}
    if da == 1 and db_ == 1:
        elder = _elder_than(B, A)
        if elder is None:
            return _unknown_elder("目標是你的同胞手足，", same_gen=True, sibling=True)
        f = ("姊姊" if elder else "妹妹") if B["gender"] == "F" else ("哥哥" if elder else "弟弟")
        b = ("姊姊" if not elder else "妹妹") if A["gender"] == "F" else ("哥哥" if not elder else "弟弟")
        return {"forward": f, "backward": b, "path": "目標是你的同胞手足。"}
    if da == 2 and db_ == 2:
        elder = _elder_than(B, A)
        if elder is None:
            return _unknown_elder("目標是你的堂親（同祖父系祖先、不同父），", same_gen=True)
        return {
            "forward": ("堂姊" if elder else "堂妹") if B["gender"] == "F" else ("堂兄" if elder else "堂弟"),
            "backward": ("堂姊" if not elder else "堂妹") if A["gender"] == "F" else ("堂兄" if not elder else "堂弟"),
            "path": "目標是你的堂親（同祖父系祖先、不同父）。",
        }
    # （C-1）伯叔／姪輩不再特判：下方世代階梯對 diff=±1 會依長幼給出
    # 伯父/叔叔（原特判只會回籠統的「叔伯」，配偶派生也因此對不上鍵）。
    # ── 同宗世代階梯（總幹事確認的宗族慣例）：旁系遠近不影響稱謂，以「世代差」定稱 ──
    #   高1=伯叔/姑姑、高2=伯公叔公/姑婆、高3=曾…、高4=高…、高5以上=「(名)公/(名)媽」；
    #   反向 姪→姪孫→曾姪孫→玄姪孫→裔孫；同世遠房=族兄弟/族姊妹。
    lrow = conn.execute("SELECT name, generation_number FROM members WHERE id = ?", (lca,)).fetchone()
    lca_name = ((lrow["name"] if lrow else "") or "共同祖先")
    lca_gen = (lrow["generation_number"] if lrow else None)
    lca_txt = "%s%s" % (lca_name, ("（第%s世）" % lca_gen) if lca_gen else "")

    import re as _re

    def _gong_name(nm):
        """尊稱用名：去字號括號、去姓（單姓假設），如 楊士芳(文梓)→士芳。

        門檻是 2 不是 3（C-1）：單名者如 楊禾 也要去姓成「禾公」——
        舊門檻 len>=3 讓單名者被尊稱成「楊禾公」（帶姓叫祖先，失禮）。
        只剩一個字（名本身是單字）就整個保留。
        """
        n = _re.sub(r"[（(].*?[)）]", "", nm or "").replace(" ", "")
        return n[1:] if len(n) >= 2 else n

    def _elder_line(id_theirs, id_ours):
        """LCA 之下兩條支線長幼：比第一代分歧祖先生年；不明回 None（呼叫端對伯叔線回族親）。"""
        ra = conn.execute("SELECT birth_date FROM members WHERE id = ?", (id_theirs,)).fetchone()
        rb = conn.execute("SELECT birth_date FROM members WHERE id = ?", (id_ours,)).fetchone()
        return _born_before(ra["birth_date"] if ra else None, rb["birth_date"] if rb else None)

    def _up_term(n, female, nm, elder):
        if female:
            return {1: "姑姑", 2: "姑婆", 3: "曾姑婆", 4: "高姑婆"}.get(n) or (_gong_name(nm) + "媽")
        if n == 1:
            return "伯父" if elder else "叔叔"
        stem = "伯" if elder else "叔"
        return {2: stem + "公", 3: "曾" + stem + "公", 4: "高" + stem + "公"}.get(n) or (_gong_name(nm) + "公")

    def _down_term(n, female):
        return {1: ("姪女" if female else "姪子"),
                2: ("姪孫女" if female else "姪孫"),
                3: ("曾姪孫女" if female else "曾姪孫"),
                4: ("玄姪孫女" if female else "玄姪孫")}.get(n) or ("裔孫女" if female else "裔孫")

    diff = da - db_        # >0：對方輩分高 diff 世
    F, Fa = B["gender"] == "F", A["gender"] == "F"
    if diff >= 1:
        elder = _elder_line(pb[db_ - 1], pa[da - 1]) if db_ >= 1 else None
        if not F and elder is None:   # 伯／叔（伯公／叔公）要分長幼；姑姑／姑婆不用
            return _unknown_elder("共同祖先：%s；對方為您高 %d 世之同宗尊長，" % (lca_txt, diff))
        f = _up_term(diff, F, B["name"], bool(elder))
        return {"forward": f, "backward": _down_term(diff, Fa),
                "path": "共同祖先：%s；對方為您高 %d 世之同宗尊長 → %s。" % (lca_txt, diff, f)}
    if diff <= -1:
        n = -diff
        elder = _elder_line(pa[da - 1], pb[db_ - 1]) if da >= 1 else None
        if not Fa and elder is None:   # 對方要稱我伯／叔才需長幼；稱姑姑不用
            return _unknown_elder("共同祖先：%s；對方為您低 %d 世之同宗晚輩，" % (lca_txt, n))
        f = _down_term(n, F)
        return {"forward": f, "backward": _up_term(n, Fa, A["name"], bool(elder)),
                "path": "共同祖先：%s；對方為您低 %d 世之同宗晚輩 → %s。" % (lca_txt, n, f)}
    elder_p = _elder_than(B, A)
    if elder_p is None:
        return _unknown_elder("共同祖先：%s；同世代之遠房宗親（各上溯 %d 代），" % (lca_txt, da), same_gen=True)
    f = (("族姊" if elder_p else "族妹") if F else ("族兄" if elder_p else "族弟"))
    b = (("族姊" if not elder_p else "族妹") if Fa else ("族兄" if not elder_p else "族弟"))
    return {"forward": f, "backward": b,
            "path": "共同祖先：%s；同世代之遠房宗親（各上溯 %d 代）。" % (lca_txt, da)}


def _elder_than(B, A):
    """B 是否年長於 A：兩邊生年皆有且不同才回 True/False，否則回 None（交 _unknown_elder）。
    舊寫法 ``(B or "") < (A or "")`` 在缺生年時兩個方向都是 False，
    kinship(A,B) 與 kinship(B,A) 會各說各話（甲稱乙弟弟、乙也稱甲弟弟）。"""
    return _born_before(B["birth_date"], A["birth_date"])


def _born_before(a, b):
    """生日 a 是否早於 b：判得出回 True/False；判不出回 None（交 _unknown_elder）。

    不再直接比字串（H-2／體檢 domain-5，2026-09-25）：'1952-5-1' 比 '1952-12-01' 大、
    Excel 另存的 '1952/5/1' 也比 '1952-12-01' 大，哥哥因此被叫成弟弟。先解析成
    （年, 月, 日）逐段比；任一方缺、看不懂、同一天，或同年但一方只有年份（「1952」）
    ——都算判不出（總幹事 2026-08-21：生年不可控就不推定）。
    """
    pa, pb = _date_parts(a), _date_parts(b)
    if pa is None or pb is None:
        return None
    for x, y in zip(pa, pb):
        if x is None or y is None:
            return None
        if x != y:
            return x < y
    return None


def _cousin_by_age(res, A, B):
    """表親依生日分大小（總幹事 2026-10-12：比照堂兄／堂弟）：表兄弟→表哥／表弟、表姊妹→表姊／表妹。
    兩人生日判不出長幼（_born_before 回 None）就照舊用通稱，不推定。res 是 A 對 B 的結果（forward＝A 稱 B）。"""
    older = _elder_than(B, A)            # B 比 A 年長？
    if older is None:
        return res

    def one(t, elder):
        if t == "表兄弟":
            return "表哥" if elder else "表弟"
        if t == "表姊妹":
            return "表姊" if elder else "表妹"
        return t
    return dict(res, forward=one(res["forward"], older), backward=one(res["backward"], not older))


def _unknown_elder(path, same_gen=False, sibling=False):
    """長幼判不出（缺生年）→ 雙向一律「族親」。
    總幹事 2026-08-21 拍板：生年資料不可控，不依建檔序推定、不加註，省得困擾。
    guessed=True 讓 kinship_batch 留空（信上退回通稱）；same_gen 讓橋接端仍能判妯娌／連襟
    （兄弟之妻互為妯娌不分長幼）。sibling＝同胞手足：母親橋接只對母親的同胞給舅舅／阿姨／外甥，
    母親的堂、族兄弟姊妹一律族親（D-3 總幹事 2026-10-13，見 _kin_bridge）。"""
    r = {"forward": "族親", "backward": "族親", "guessed": True, "sameGen": same_gen,
         "path": path + "但雙方（或分支祖）生年未載、長幼無從判定，以族親相稱。"}
    if sibling:
        r["sibling"] = True
    return r


def _kin_bridge(conn, A, B) -> dict | None:
    """R4 配偶／母親橋接：父系血親算不出時，改走姻親端的配偶（或母親）節點計算。

    任一端為姻親（無父系鏈，多為嫁入配偶或外孫線）時：
      * 目標側：主體對「目標之配偶」的血親稱謂 → _SPOUSE_OF 轉姻親（嫂／姑丈…）；
      * 主體側：主體之配偶對目標的血親稱謂 → _VIA_SPOUSE 轉姻親（公公／大伯…）；
      * 母親側：父系算不出時走其母計算（舅舅／外公／外甥…；掛了外姓父或贅婿也照走）。
    path 說明「經配偶○○」／「經母親○○」；查表未涵蓋則回 None 交友善訊息。
    """
    g_a, g_b = (A["gender"] or ""), (B["gender"] or "")
    b_has_father = bool(_kin_chain(conn, B["id"])[1:])
    a_has_father = bool(_kin_chain(conn, A["id"])[1:])

    # 直判母子女（僅母邊、父系斷時 LCA 無法涵蓋）
    mb = _kin_mother(conn, B["id"])
    if mb and mb["id"] == A["id"]:
        return {
            "forward": "女兒" if g_b == "F" else "兒子",
            "backward": "母親",
            "path": "目標是你的子女（母系親邊）。",
        }
    ma = _kin_mother(conn, A["id"])
    if ma and ma["id"] == B["id"]:
        return {
            "forward": "母親",
            "backward": "女兒" if g_a == "F" else "兒子",
            "path": "目標是你的母親（母系親邊）。",
        }

    # 目標側配偶橋接：B 為嫁入配偶（無父系鏈）→ 改走其配偶節點
    # （稱謂轉換走 _spouse_term 規則式派生，叔公之妻→叔婆、姑婆之夫→姑丈公…
    #   舊版只查 20 詞的表，世代階梯的詞全部落空——C-1 斷層主因。）
    if not b_has_father:
        # 離異的前妻只對自己親生那一支的子孫還是直系尊親（祖母／曾祖母…），其餘不橋接（domain-6）
        for S in _kin_spouses(conn, B["id"], divorced=True):
            if S["id"] != A["id"] and _kin_bore_line(conn, B["id"], S["id"], A["id"]):
                r = _kin_blood(conn, A, S)
                f = _spouse_term(r["forward"], g_b) if r else None
                if f:
                    return {
                        "forward": f,
                        "backward": _via_spouse_term(r["backward"], g_b),
                        "path": "經前配偶「%s」橋接（離異不改血緣，仍為直系尊親）：%s" % (S["name"], r["path"]),
                    }
        for S in _kin_spouses(conn, B["id"]):
            if S["id"] == A["id"]:
                continue  # 夫妻直判已於 kinship() 前段處理
            r = _kin_blood(conn, A, S)
            if not r:
                continue
            if r.get("guessed"):   # 橋接前的血親就判不出長幼（嫂／弟媳、伯母／嬸嬸分不出）→ 族親透傳
                return dict(r, path="經配偶「%s」橋接（目標為其配偶）：%s" % (S["name"], r["path"]))
            f = _spouse_term(r["forward"], g_b)
            if f:
                return {
                    "forward": f,
                    "backward": _via_spouse_term(r["backward"], g_b),
                    "path": "經配偶「%s」橋接（目標為其配偶）：%s" % (S["name"], r["path"]),
                }
    # 主體側配偶橋接：A 為嫁入配偶 → 以其配偶對目標的稱謂轉換
    if not a_has_father:
        for S in _kin_spouses(conn, A["id"], divorced=True):   # 同上：前妻對親生那一支的子孫
            if S["id"] != B["id"] and _kin_bore_line(conn, A["id"], S["id"], B["id"]):
                r = _kin_blood(conn, S, B)
                if r:
                    return {
                        "forward": _via_spouse_term(r["forward"], g_a),
                        "backward": _spouse_term(r["backward"], g_a) or "姻親",
                        "path": "經前配偶「%s」橋接（離異不改血緣，仍為直系尊親）：%s" % (S["name"], r["path"]),
                    }
        for S in _kin_spouses(conn, A["id"]):
            if S["id"] == B["id"]:
                continue
            r = _kin_blood(conn, S, B)
            if not r:
                continue
            if r.get("guessed"):
                return dict(r, path="經配偶「%s」橋接（你為其配偶）：%s" % (S["name"], r["path"]))
            f = _via_spouse_term(r["forward"], g_a)
            if f:
                return {
                    "forward": f,
                    "backward": _spouse_term(r["backward"], g_a) or "姻親",
                    "path": "經配偶「%s」橋接（你為其配偶）：%s" % (S["name"], r["path"]),
                }
    # 雙姻親橋接（C-1：連襟／妯娌）：兩端都是嫁入/贅入配偶（皆無父系鏈），
    # 各走自己的配偶節點算血親，再轉回姻親稱謂。
    if not a_has_father and not b_has_father:
        _SAME_GEN = ("哥哥", "弟弟", "姊姊", "妹妹",
                     "堂兄", "堂弟", "堂姊", "堂妹", "族兄", "族弟", "族姊", "族妹")
        # 離異的前配偶也列進來，但只限對方配偶是她親生那一支（下方 _kin_bore_line 把關）：
        # 兒子離婚的母親仍是兒子之妻的婆婆，媳婦、女婿、孫媳婦不能跟著掉成族親（domain-6 回歸）
        sa_all = [(S, False) for S in _kin_spouses(conn, A["id"])] + \
                 [(S, True) for S in _kin_spouses(conn, A["id"], divorced=True)]
        sb_all = [(S, False) for S in _kin_spouses(conn, B["id"])] + \
                 [(S, True) for S in _kin_spouses(conn, B["id"], divorced=True)]
        for SA, a_div in sa_all:
            if SA["id"] == B["id"]:
                continue
            for SB, b_div in sb_all:
                if SB["id"] in (A["id"], SA["id"]):
                    continue
                if (a_div and not _kin_bore_line(conn, A["id"], SA["id"], SB["id"])) or \
                        (b_div and not _kin_bore_line(conn, B["id"], SB["id"], SA["id"])):
                    continue
                r = _kin_blood(conn, SA, SB)
                if not r:
                    continue
                via = "經雙方配偶「%s」「%s」橋接%s：%s" % (
                    SA["name"], SB["name"],
                    "（離異不改血緣，仍為親生那一支子孫的配偶）" if (a_div or b_div) else "", r["path"])
                if r.get("guessed"):
                    # 長幼不明但確為同輩 → 妯娌／連襟本就不分長幼，照給；其餘族親透傳
                    if r.get("sameGen") and g_a == "F" and g_b == "F":
                        return {"forward": "妯娌", "backward": "妯娌", "path": via}
                    if r.get("sameGen") and g_a == "M" and g_b == "M":
                        return {"forward": "連襟", "backward": "連襟", "path": via}
                    return dict(r, path=via)
                if r["forward"] in _SAME_GEN:
                    # 同世代專詞：兄弟之妻互稱妯娌、姊妹之夫互稱連襟
                    if g_a == "F" and g_b == "F":
                        return {"forward": "妯娌", "backward": "妯娌", "path": via}
                    if g_a == "M" and g_b == "M":
                        return {"forward": "連襟", "backward": "連襟", "path": via}
                # 一般情形＝妻從夫稱：A 對 B ＝ A 之配偶對 B（B 為其血親之配偶）
                f = _spouse_term(r["forward"], g_b)
                if f:
                    return {"forward": f,
                            "backward": _spouse_term(r["backward"], g_a) or "姻親",
                            "path": via}
    # 目標側母親橋接：B 經母親連回本族（外孫線）
    # 不再要求 B「沒有父邊」（體檢 domain-2）：走到這裡代表父系已經算不出共同祖先；
    # 嫁出女兒的子女掛了外姓父親、或招贅所生掛了贅婿，原本整段被跳過、一律回族親。
    if mb and mb["id"] != A["id"]:
        r = _kin_blood(conn, A, mb)
        if r and r.get("guessed"):
            # 我是其母的同胞手足（長幼不明）→ 外甥／舅舅、阿姨本就不分長幼。
            # 母親的堂、族兄弟姊妹一律族親（D-3 總幹事 2026-10-13 拍板：族譜照父系記，
            # 母親那邊的堂、族親不另立稱呼；生年齊全時本來就是族親，現在兩種情況一致）。
            if r.get("sameGen") and r.get("sibling"):
                return {"forward": "外甥" if g_b == "M" else "外甥女",
                        "backward": "舅舅" if g_a == "M" else "阿姨",
                        "path": "經母親「%s」橋接：%s" % (mb["name"], r["path"])}
            return dict(r, path="經母親「%s」橋接：%s" % (mb["name"], r["path"]))
        if r:
            f = _MOTHER_CHILD.get(r["forward"], {}).get(g_b)
            if f:
                return _cousin_by_age({
                    "forward": f,
                    "backward": _VIA_MOTHER.get(r["backward"]) or "姻親",
                    "path": "經母親「%s」橋接：%s" % (mb["name"], r["path"]),
                }, A, B)
    # 主體側母親橋接：A 經母親連回本族（同上，有登錄父親也照走）
    if ma and ma["id"] != B["id"]:
        r = _kin_blood(conn, ma, B)
        if r and r.get("guessed"):
            if r.get("sameGen") and r.get("sibling"):   # 目標是母親的同胞手足（長幼不明）→ 舅舅／阿姨（堂、族一律族親，同上）
                return {"forward": "舅舅" if g_b == "M" else "阿姨",
                        "backward": "外甥" if g_a == "M" else "外甥女",
                        "path": "經母親「%s」橋接：%s" % (ma["name"], r["path"])}
            return dict(r, path="經母親「%s」橋接：%s" % (ma["name"], r["path"]))
        if r:
            f = _VIA_MOTHER.get(r["forward"])
            if f:
                return _cousin_by_age({
                    "forward": f,
                    "backward": _MOTHER_CHILD.get(r["backward"], {}).get(g_a) or "姻親",
                    "path": "經母親「%s」橋接：%s" % (ma["name"], r["path"]),
                }, A, B)
    return None


def _divorced_hint(conn, A, B) -> str:
    """算不出稱謂時的白話提示：一方是另一方父系尊親（父親、祖父…）離異的前妻。

    離異的婚姻不再橋接（domain-6），前妻親生的子女若只登錄了父親、沒登錄生母，
    母子、祖孫就算不出來、退成「族親」。本譜兩段婚姻的子女多半沒記生母（規格 §4.1），
    通用訊息「補齊父親或母親」沒點明要補誰（第二批驗證員）——這裡講出要在哪一位的父母欄登錄生母。
    沒有這種關係回 ''。"""
    for x, y in ((A, B), (B, A)):
        if y["gender"] != "F":
            continue
        chain = _kin_chain(conn, x["id"])
        for i in range(1, len(chain)):
            if _kin_married(conn, chain[i], y["id"]) == "DIVORCED":
                anc, kid = _kin_info(conn, chain[i]), _kin_info(conn, chain[i - 1])
                # 這一代已登錄生母（多半是現任所生）就不提示，免得誘導替一人登兩位生母（L-7）
                if conn.execute("SELECT 1 FROM relationships r JOIN members p ON p.id = r.parent_id "
                                "WHERE r.child_id = ? AND p.gender = 'F' AND r.relation_type = 'BIOLOGICAL'",
                                (kid["id"],)).fetchone():
                    return ""
                return ("「%s」是「%s」離異的前妻；離異的婚姻不再推算成母親。若她是「%s」的親生母親，"
                        "請在「%s」的父母欄登錄她為母親（親生），稱謂就算得出來。"
                        % (y["name"], anc["name"], kid["name"], kid["name"]))
    return ""


def kinship(from_id, to_id, conn=None, explain=True) -> dict:
    """GET /api/kinship?from=&to=。以 relationships 上溯共同祖先（LCA）推稱謂。

    R4 稱謂強化（規則摘要見 docs/規格.md §2.2）：
      1. 夫妻直判（查 marriages）→ 丈夫／妻子（離異 → 前妻／前夫）；
      2. 父系血親（原 LCA 邏輯，_kin_blood）；
      3. 配偶／母親橋接（_kin_bridge）：任一端無父系鏈時改走其配偶（或母親）
         節點計算，稱謂查表轉姻親，path 說明「經配偶○○」；
      4. 目標成員 custom_kinship_term 非空 → forward 逕用之並標示（家族習慣稱呼）。
    仍算不出時維持原友善訊息；一方是另一方父系尊親的前妻時，改講要補哪一位的生母（_divorced_hint）。

    conn：可傳入共用連線。批次呼叫（kinship_batch）務必傳——實測全族規模（上千人）時，
    「每人開關一次連線」佔掉約八成時間。
    explain=False：只要稱謂、不要說明（批次用；省掉算不出時逐代查前妻的查詢）。
    """
    own_conn = conn is None
    conn = conn or _conn()
    try:
        A, B = _kin_info(conn, from_id), _kin_info(conn, to_id)
        if not A or not B:
            return {"forward": "—", "backward": "—", "path": "查無此成員。"}
        if A["id"] == B["id"]:
            return {"forward": "本人", "backward": "本人", "path": "主體與目標為同一人。"}

        mst = _kin_married(conn, A["id"], B["id"])
        if mst == "DIVORCED":
            # 離異：本人對前配偶稱「前妻／前夫」（體檢 domain-6；原本仍回妻子／丈夫）
            res = {
                "forward": "前妻" if B["gender"] == "F" else ("前夫" if B["gender"] == "M" else "前配偶"),
                "backward": "前妻" if A["gender"] == "F" else ("前夫" if A["gender"] == "M" else "前配偶"),
                "path": "兩位曾為夫妻，婚姻狀態為離異。",
            }
        elif mst:
            res = {
                "forward": "妻子" if B["gender"] == "F" else ("丈夫" if B["gender"] == "M" else "配偶"),
                "backward": "妻子" if A["gender"] == "F" else ("丈夫" if A["gender"] == "M" else "配偶"),
                "path": "兩位為夫妻（婚姻關係）。",
            }
        else:
            # 建議補「父親或母親」：嫁出女兒的子女靠母邊算外公／舅舅（domain-2 後掛了父親也照算）
            res = _kin_blood(conn, A, B) or _kin_bridge(conn, A, B) or {
                "forward": "族親", "backward": "族親",
                "path": (explain and _divorced_hint(conn, A, B)) or "兩位在現有族譜中找不到共同父系祖先（可能一方為姻親、或父系資料待補）。可先在族譜頁各自往上核對世系，補齊父親或母親後再計算。",
            }

        # custom_kinship_term 覆寫：家族習慣稱呼優先於演算結果（僅 forward）
        cust = ((B["custom_kinship_term"] or "") if "custom_kinship_term" in B.keys() else "").strip()
        if cust:
            res = dict(res)
            res["forward"] = "%s（家族習慣稱呼）" % cust
        return res
    finally:
        if own_conn:
            conn.close()


def kinship_batch(payload) -> dict:
    """POST /api/kinship/batch {toId, memberIds[]} → {"terms": {id: 稱謂}}。

    一次算完「一群人各自與同一位逝者的關係」，供通知作業台的 {裔稱} 佔位符使用。
    **不可改成逐人打 /api/kinship**：作業台一次是全族在世的人（上千人），
    那等於上千次 HTTP 來回。

    回傳的是 backward（＝「逝者稱呼這個人」，如「裔孫」），不是 forward
    （forward 是「這個人稱呼逝者」，如「第11世祖公」——貼在收件人名字後面會顛倒，
    舊版死碼 gen_notice 就是栽在這裡）。

    算不出／無父系鏈者一律回空字串，由前端退回通稱（不塞一個錯的稱謂進去）。
    """
    payload = payload or {}
    to_id = payload.get("toId")
    ids = payload.get("memberIds") or []
    if not to_id:
        raise ApiError(400, "toId required（要以哪位先人為基準計算稱謂）")
    if not isinstance(ids, list):
        raise ApiError(400, "memberIds 須為陣列")
    if len(ids) > 20000:
        raise ApiError(400, "一次最多 20000 人")

    out = {}
    conn = _conn()          # 全批共用一條連線（見 kinship 的 conn 參數說明）
    try:
        to_id = int(to_id)
        for mid in ids:
            try:
                mid = int(mid)
            except (TypeError, ValueError):
                continue
            if mid == to_id:
                continue
            try:
                r = kinship(mid, to_id, conn=conn, explain=False)
            except Exception:
                continue
            term = (r.get("backward") or "").strip()
            # 通稱、算不出、長幼判不出（缺生年，含橋接派生）一律留空，交給前端退回通稱「族親」；
            # 離異的前配偶也留空——祭祖通知上印「前妻」不得體，用通稱就好
            if r.get("guessed") or term in ("", "—", "族親", "前妻", "前夫", "前配偶"):
                continue
            out[str(mid)] = term
    finally:
        conn.close()
    return {"terms": out}
