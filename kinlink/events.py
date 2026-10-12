# -*- coding: utf-8 -*-
"""祭祖活動：列表（雙曆補齊＋實際國曆日排序）、儲存、刪除（原 server.py）。"""
from __future__ import annotations

from .errors import ApiError
from .lunar import lunar_date_problem, lunar_iso_to_cn, lunar_to_solar_iso, solar_to_lunar_cn
from .state import _LOCK, _conn


def delete_event(event_id) -> dict:
    """DELETE /api/event/{id}（需編輯模式）→ {ok}。

    活動是純附屬資料（沒有任何東西外鍵指向它），刪掉不影響成員與親屬關係，
    故直接 DELETE，不做軟刪除。前端有雙重確認（比照刪成員）。
    """
    if not _LOCK["editMode"]:
        raise ApiError(403, "edit mode required")
    try:
        eid = int(event_id)
    except (TypeError, ValueError):
        raise ApiError(400, "活動編號格式錯誤")
    conn = _conn()
    try:
        row = conn.execute("SELECT event_name FROM ritual_events WHERE id = ?", (eid,)).fetchone()
        if row is None:
            raise ApiError(404, "查無此祭祖活動（可能已被刪除）")
        conn.execute("DELETE FROM ritual_events WHERE id = ?", (eid,))
        conn.commit()
        return {"ok": True, "name": row["event_name"]}
    finally:
        conn.close()


def list_events() -> list:
    """GET /api/events。

    雙曆自動補齊（R3）：SOLAR 活動補 lunarDate（干支年＋中文月日，如
    「乙巳年三月初八」）；LUNAR 活動（target_date 依約定視為農曆 YYYY-MM-DD）
    補 solarDate（換算後 ISO 國曆），lunarDate 轉中文呈現（失敗退回原字串）。
    date 欄一律維持原始 target_date（編輯表單回填用），換算失敗各欄留空／原文。

    problem：農曆日不存在（如小月三十）時的中文說明，其餘為 ''。存檔已會擋（domain-3），
    這欄是給擋存之前就存進庫的舊活動用——活動卡據此提醒總幹事改日，
    不然通函照印不存在的日期、抬頭年份少一年，隔年還被收進「往年」。
    """
    conn = _conn()
    try:
        # target_date 對 LUNAR 存的是農曆字串、對 SOLAR 是國曆 ISO，兩者混在同一欄
        # 直接字典序排會錯（農曆 2026-03-08 其實是國曆 4/24，卻排在國曆 4/11 之前）。
        # 這裡先粗排，換算完再依實際國曆日重排（見函式尾）。
        rows = conn.execute(
            "SELECT * FROM ritual_events ORDER BY target_date"
        ).fetchall()
        out = []
        for r in rows:
            cal = r["calendar_type"] or "SOLAR"
            tgt = r["target_date"] or ""
            problem = ""
            if cal == "LUNAR":
                solar = lunar_to_solar_iso(tgt)
                lunar = lunar_iso_to_cn(tgt) or tgt
                if not solar:
                    problem = lunar_date_problem(tgt)
            else:
                solar = tgt
                lunar = solar_to_lunar_cn(tgt)
            out.append({
                "id": r["id"],
                "name": r["event_name"],
                "calendar": cal,
                "date": tgt,
                "solarDate": solar,
                "lunarDate": lunar,
                "location": r["assembly_location"] or "",
                "deceasedId": r["deceased_member_id"],
                "time": "",
                "note": r["event_note"] or "",
                "letterBody": (r["letter_body"] if "letter_body" in r.keys() else "") or "",
                "problem": problem,
            })
        out.sort(key=lambda e: e["solarDate"] or e["date"])   # 依實際國曆日排；換算不出者退回原字串
        return out
    finally:
        conn.close()


def save_event(payload) -> dict:
    """POST /api/event（需編輯模式）。upsert ritual_events，回 {id}。

    前端契約欄位 → 資料表欄位：
        name      → event_name      （必填）
        solarDate / lunarDate → target_date（依 calendar 擇一）
        calendar  → calendar_type    （'SOLAR' / 'LUNAR'，預設 SOLAR）
        location  → assembly_location
        note      → event_note
        letterBody→ letter_body      （掃墓通函「說明」多行內文，一行一條）
        deceasedId→ deceased_member_id（可為 NULL，合祭）
    有帶 id 則更新，否則新增。農曆日不存在（如小月三十）回 400＋中文說明。
    """
    if not _LOCK["editMode"]:
        raise ApiError(403, "edit mode required")
    payload = payload or {}

    name = (payload.get("name") or "").strip()
    cal = (payload.get("calendar") or "SOLAR").upper()
    if cal not in ("SOLAR", "LUNAR"):
        cal = "SOLAR"
    # 前端依曆法把日期放在 solarDate 或 lunarDate；統一收斂成 target_date
    target = (payload.get("solarDate") if cal == "SOLAR" else payload.get("lunarDate"))
    if not target:
        # 容忍前端只傳單一 date 欄位
        target = payload.get("date") or payload.get("target_date") or ""
    target = (target or "").strip()
    if not name:
        raise ApiError(400, "event_name required")
    if not target:
        raise ApiError(400, "target_date required")
    # 農曆日要真的存在才收（體檢 domain-3）：小月選「三十」原本照存，通函印出不存在的日期、
    # 抬頭年份少一年、隔年被收進「往年」。換不出國曆就擋下並講清楚（不替使用者改成廿九）。
    if cal == "LUNAR":
        problem = lunar_date_problem(target)
        if problem:
            raise ApiError(400, problem)

    location = payload.get("location")
    note = payload.get("note")
    letter_body = payload.get("letterBody")
    deceased = payload.get("deceasedId")

    conn = _conn()
    try:
        eid = payload.get("id")
        if eid:
            # 祭祀先人：**以「有沒有送這個鍵」判斷**，不是以值是不是 null 判斷
            # （同 save_member 對 fatherId 的處理）。
            #   * payload 沒帶 deceasedId → 維持原值。舊前端／其他客戶端只改地點時，
            #     不會把匯入建立的逝者連結靜默洗成 NULL（通函受文者會從
            #     「○○後裔族親」退化成「全體族親」）。
            #   * payload 有帶且為 null → 使用者在選擇器按了清除，就要真的清成 NULL。
            #     （這裡不能用 COALESCE，那會讓「清除」永遠無效。）
            if "deceasedId" in payload:
                conn.execute(
                    """UPDATE ritual_events
                          SET event_name = ?, target_date = ?, calendar_type = ?,
                              assembly_location = ?, event_note = ?, letter_body = ?,
                              deceased_member_id = ?
                        WHERE id = ?""",
                    (name, target, cal, location, note, letter_body, deceased, eid),
                )
            else:
                conn.execute(
                    """UPDATE ritual_events
                          SET event_name = ?, target_date = ?, calendar_type = ?,
                              assembly_location = ?, event_note = ?, letter_body = ?
                        WHERE id = ?""",
                    (name, target, cal, location, note, letter_body, eid),
                )
            conn.commit()
            return {"id": eid}
        cur = conn.execute(
            """INSERT INTO ritual_events
                   (event_name, deceased_member_id, target_date, calendar_type,
                    assembly_location, event_note, letter_body)
               VALUES (?,?,?,?,?,?,?)""",
            (name, deceased, target, cal, location, note, letter_body),
        )
        conn.commit()
        return {"id": cur.lastrowid}
    finally:
        conn.close()


# 【已移除】gen_notice()／POST /api/notice（2026-07-28）
#   舊版有一支「依親屬稱謂帶敬語」的通知產生器，但前端從未呼叫（作業台一律走
#   app.js 的 fillTpl 套用 settings.notice_template），而且實跑證明它的稱謂方向是反的：
#   kinship(收件人, 逝者)["forward"] 是「收件人怎麼稱呼逝者」，卻被貼在收件人名字後面，
#   在世子孫會被印成「敬愛的 楊文凱（第11世祖公）」。留著＝在開源專案裡埋一個
#   看起來很完整、照著接回就會出醜的陷阱，故整條刪除（含 bridge.js 的 web/mock 兩路）。
#   通知的稱謂改由兩處承接，方向都是對的：
#     * 手機訊息：settings.notice_template 的「{姓名}宗長 鈞鑒」，總幹事可自行編輯
#     * 紙本通函：print.html doc=letter 依 deceasedId 產「○○後裔族親」
#   規格 §2.2「通知內文動態代稱」已於 C-5（2026-08）以模板佔位符 {裔稱} 補上：
#   前端打 POST /api/kinship/batch 一次算完全族對該場活動祭祀先人的 backward 稱謂
#   （＝逝者怎麼稱呼收件人，方向正確），算不出或長幼不明一律留空退回通稱「族親」。
