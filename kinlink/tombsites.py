# -*- coding: utf-8 -*-
"""穴排位場地（規格 §2.5「場地格線」；2026-08-21 總幹事拍板實作）。

原則：「**位置是資料，版面是每個場地自己的設定**」。程式不預設墓園長相——
管理員替每個墓域／塔（或每一張要印的頁）自畫格子（幾列、幾欄、列怎麼叫），
再把人指到格位；印出來就是格子的樣子。不做昭穆規則引擎、不解析位置碼。
葬在場地外的人靠 tombs 的文字欄（安葬地點／穴位編號）記錄，不進格線。

資料：tomb_sites 一列＝一張格子表。cells 存 JSON：
    [{"r":0, "c":1, "memberId":12, "text":"", "top":""}, ...]
  * memberId 指到成員 → 印出時自動套「字號　姓公／名　姓氏」，改名自動跟著變；
  * text 為自由文字（走道、神位、外姓）；兩者並存時 text 優先（手動覆寫稱呼）；
  * top 為格子上方小字（世代等）：面板版型印在名字上方，階梯版型相鄰同字合成世代橫條。

版型（2026-10-12，照家族 2022 年面板圖、2002 年主牌位圖）：layout＋layout_opts——
  * grid   方格（原本）：rows×cols，列標籤在左；
  * panels 面板：{"panelCols":3, "panelRows":[14,11,11,14]}＝幾塊紅框格子並排，各塊列數可不同；
           rows＝最多的那塊、cols＝每塊欄數×塊數，第 p 塊的第 k 欄＝c = p*panelCols + k；
  * steps  階梯：{"rowWidths":[12,12,16,21,25]}＝由上而下各層格數，置中往下加寬；
           c=0 在最右（由右往左讀），每格直書。
  面板／階梯的列數欄數由設定推出，不另收。
"""
from __future__ import annotations

import csv
import io
import json
import re

from .errors import ApiError
from .state import _LOCK, _conn

MAX_DIM = 60          # 列／欄上限（A3 橫印也塞不下更多）
MAX_TEXT = 60
LAYOUTS = ("grid", "panels", "steps")


# ============================================================
# 小工具
# ============================================================

def _json_list(raw):
    try:
        v = json.loads(raw or "[]")
    except (TypeError, ValueError):
        v = []
    return v if isinstance(v, list) else []


def _pad_labels(arr, n, prefix):
    """列標籤補齊：缺的以「第N列」補（prefix 固定傳「第」；尾綴「列」避免「第3」歧義）。"""
    out = [str(x or "") for x in (arr or [])][:n]
    while len(out) < n:
        out.append("")
    return [s if s else "%s%d列" % (prefix, i + 1) for i, s in enumerate(out)]


def honor_label(row) -> str:
    """格子自動稱呼（沿用穴排位圖範本慣例）：男「字號或名　姓公」、女「名　姓氏」。
    姓取第一字（複姓者手動改 text 即可）；括號附註一律去掉。"""
    name = re.sub(r"[（(].*?[)）]", "", row["name"] or "").replace(" ", "").strip()
    style = ((row["generation_name"] if "generation_name" in row.keys() else "") or "").strip()
    if len(name) < 2:
        return name
    sur, given = name[0], name[1:]
    if (row["gender"] or "") == "F":
        return "%s　%s氏" % (given, sur)
    # 字號通常兩字；單字多半是「字輩」不是字號（示範資料即如此），用名比較像樣。手改 text 永遠優先。
    return "%s　%s公" % (style if len(style) >= 2 else given, sur)


def _resolve_cells(conn, cells):
    """把 cells JSON 解成前端／列印要的形狀；成員已刪者 memberId 落空、只剩 text。"""
    ids = sorted({int(c["memberId"]) for c in cells
                  if isinstance(c, dict) and c.get("memberId")})
    info = {}
    if ids:
        q = ("SELECT id, name, generation_name, gender, generation_number "
             "FROM members WHERE id IN (%s)" % ",".join("?" * len(ids)))
        for r in conn.execute(q, ids):
            info[r["id"]] = r
    out = []
    for c in cells:
        if not isinstance(c, dict):
            continue
        row = info.get(int(c["memberId"])) if c.get("memberId") else None
        text = str(c.get("text") or "")
        out.append({
            "r": c.get("r"), "c": c.get("c"),
            "memberId": row["id"] if row else None,
            "name": row["name"] if row else "",
            "gen": row["generation_number"] if row else None,
            "text": text,
            "top": str(c.get("top") or ""),
            "label": text or (honor_label(row) if row else ""),
        })
    return out


def _layout_of(row):
    """(layout, opts)；舊庫沒值或壞值一律當方格。"""
    lay = (row["layout"] if "layout" in row.keys() else None) or "grid"
    try:
        opts = json.loads((row["layout_opts"] if "layout_opts" in row.keys() else None) or "{}")
    except (TypeError, ValueError):
        opts = {}
    return (lay if lay in LAYOUTS else "grid"), (opts if isinstance(opts, dict) else {})


def _inside(layout, opts):
    """版型的格子範圍：(r, c) → 是否在圖上（面板各塊列數不同、階梯各層寬度不同）。"""
    if layout == "panels":
        pc, pr = opts["panelCols"], opts["panelRows"]
        return lambda r, c: c // pc < len(pr) and r < pr[c // pc]
    if layout == "steps":
        w = opts["rowWidths"]
        return lambda r, c: r < len(w) and c < w[r]
    return lambda r, c: True


def _site_row(conn, sid):
    row = conn.execute("SELECT * FROM tomb_sites WHERE id = ?", (sid,)).fetchone()
    if not row:
        raise ApiError(404, "查無此穴排位場地（可能已被刪除）")
    return row


# ============================================================
# 讀
# ============================================================

def list_tomb_sites() -> list:
    """GET /api/tomb-sites → [{id, name, title, rows, cols, filled}]（依 sort_order、id）。"""
    conn = _conn()
    try:
        out = []
        for r in conn.execute("SELECT * FROM tomb_sites ORDER BY sort_order, id"):
            cells = _json_list(r["cells"])
            out.append({
                "id": r["id"], "name": r["name"] or "", "title": r["title"] or "",
                "rows": r["rows"], "cols": r["cols"], "layout": _layout_of(r)[0],
                "filled": sum(1 for c in cells if isinstance(c, dict) and (c.get("memberId") or c.get("text"))),
            })
        return out
    finally:
        conn.close()


def get_tomb_site(sid) -> dict:
    """GET /api/tomb-site/{id} → 完整格子表（cells 已解析成員稱呼）。"""
    conn = _conn()
    try:
        r = _site_row(conn, sid)
        lay, opts = _layout_of(r)
        return {
            "id": r["id"], "name": r["name"] or "",
            "title": r["title"] or "", "subtitle": r["subtitle"] or "", "footer": r["footer"] or "",
            "rows": r["rows"], "cols": r["cols"], "layout": lay, "layoutOpts": opts,
            "rowLabels": _pad_labels(_json_list(r["row_labels"]), r["rows"], "第"),
            "cells": _resolve_cells(conn, _json_list(r["cells"])),
        }
    finally:
        conn.close()


def member_tomb_sites(conn, member_id) -> list:
    """某成員被指到哪些格子 → [{siteId, siteName, r, c, rowLabel}]（get_member 用；場地數少，全掃即可）。"""
    out = []
    for r in conn.execute("SELECT id, name, rows, row_labels, cells FROM tomb_sites ORDER BY sort_order, id"):
        labels = None
        for c in _json_list(r["cells"]):
            if isinstance(c, dict) and c.get("memberId") and int(c["memberId"]) == int(member_id):
                if labels is None:
                    labels = _pad_labels(_json_list(r["row_labels"]), r["rows"], "第")
                rr = c.get("r")
                out.append({"siteId": r["id"], "siteName": r["name"] or "", "r": rr, "c": c.get("c"),
                            "rowLabel": str(c.get("top") or "") or
                            (labels[rr] if isinstance(rr, int) and 0 <= rr < len(labels) else "")})
    return out


# ============================================================
# 寫（皆需編輯模式）
# ============================================================

def _int_in(v, lo, hi, what):
    try:
        n = int(v)
    except (TypeError, ValueError):
        raise ApiError(400, "%s 須為整數" % what)
    if n < lo or n > hi:
        raise ApiError(400, "%s 須在 %d～%d 之間" % (what, lo, hi))
    return n


def _clean_layout(layout, opts):
    """版型與設定驗證 → (layout, opts, rows, cols)；面板／階梯的 rows、cols 由設定推出（方格回 None）。"""
    layout = str(layout or "grid")
    if layout not in LAYOUTS:
        raise ApiError(400, "版型須為 grid（方格）、panels（面板）或 steps（階梯）")
    opts = opts if isinstance(opts, dict) else {}
    if layout == "panels":
        pc = _int_in(opts.get("panelCols", 3), 1, 20, "每塊欄數")
        pr = opts.get("panelRows") or [10]
        if not isinstance(pr, list) or not 1 <= len(pr) <= 10:
            raise ApiError(400, "各塊列數請填 1～10 個數字（逗號分隔）")
        pr = [_int_in(x, 1, MAX_DIM, "每塊列數") for x in pr]
        if pc * len(pr) > MAX_DIM:
            raise ApiError(400, "面板總欄數（每塊欄數×塊數）不可超過 %d" % MAX_DIM)
        return layout, {"panelCols": pc, "panelRows": pr}, max(pr), pc * len(pr)
    if layout == "steps":
        w = opts.get("rowWidths") or [5]
        if not isinstance(w, list) or not 1 <= len(w) <= MAX_DIM:
            raise ApiError(400, "各層格數請填 1～%d 個數字（逗號分隔）" % MAX_DIM)
        w = [_int_in(x, 1, MAX_DIM, "每層格數") for x in w]
        return layout, {"rowWidths": w}, len(w), max(w)
    return "grid", {}, None, None


def _clean_cells(conn, raw, rows, cols, inside=None):
    """驗證並正規化 cells：座標在格內、成員存在、文字限長；同格後者蓋前者；空格不存
    （只有上方小字的格子要存：原圖有「只寫世代、名字留白」的預留位）。"""
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ApiError(400, "cells 須為陣列")
    by_pos = {}
    for c in raw:
        if not isinstance(c, dict):
            continue
        r = _int_in(c.get("r"), 0, rows - 1, "格子列號")
        k = _int_in(c.get("c"), 0, cols - 1, "格子欄號")
        if inside and not inside(r, k):
            raise ApiError(400, "格子 (%d,%d) 不在這個版型的範圍內" % (r, k))
        mid = c.get("memberId")
        if mid in ("", None):
            mid = None
        else:
            mid = _int_in(mid, 1, 10 ** 9, "memberId")
            if not conn.execute("SELECT 1 FROM members WHERE id = ?", (mid,)).fetchone():
                raise ApiError(400, "格子 (%d,%d) 指到的成員不存在（id %d）" % (r, k, mid))
        text = str(c.get("text") or "").strip()
        top = str(c.get("top") or "").strip()
        if len(text) > MAX_TEXT or len(top) > MAX_TEXT:
            raise ApiError(400, "格子文字請在 %d 字以內" % MAX_TEXT)
        if mid is None and not text and not top:
            by_pos.pop((r, k), None)
            continue
        cell = {"r": r, "c": k, "memberId": mid, "text": text}
        if top:
            cell["top"] = top
        by_pos[(r, k)] = cell
    return [by_pos[key] for key in sorted(by_pos)]


def save_tomb_site(payload) -> dict:
    """POST /api/tomb-site {id?, name, title, subtitle, footer, rows, cols, rowLabels[], cells[],
    layout?, layoutOpts?} → {id}。整張格子表一次覆寫（前端按「儲存」送全量）；不傳 cells 時維持原格子
    （只改版面設定）；不傳 layout 時沿用原版型（新場地＝方格）。"""
    if not _LOCK["editMode"]:
        raise ApiError(403, "edit mode required")
    p = payload or {}
    name = str(p.get("name") or "").strip()
    if not name:
        raise ApiError(400, "請填寫場地名稱")
    rows = _int_in(p.get("rows", 5), 1, MAX_DIM, "列數")
    cols = _int_in(p.get("cols", 6), 1, MAX_DIM, "欄數")
    labels = p.get("rowLabels")
    if labels is not None and not isinstance(labels, list):
        raise ApiError(400, "rowLabels 須為陣列")
    conn = _conn()
    try:
        sid = p.get("id")
        old = _site_row(conn, sid) if sid else None
        if "layout" in p or old is None:
            layout, opts, r2, c2 = _clean_layout(p.get("layout"), p.get("layoutOpts"))
        else:                           # 沒送版型＝沿用原本的（只改名稱、抬頭時不會被打回方格）
            layout, opts, r2, c2 = _clean_layout(*_layout_of(old))
        if r2:
            rows, cols = r2, c2
        inside = _inside(layout, opts)
        if sid:
            if labels is None:          # 與 cells 同語意：沒送就沿用舊的
                labels = _json_list(old["row_labels"])
        labels = [str(x or "").strip()[:MAX_TEXT] for x in (labels or [])][:rows]
        if sid:
            if p.get("cells") is not None:   # null 視同沒送（防誤清整張格子）；要清空請送 []
                cells = _clean_cells(conn, p["cells"], rows, cols, inside)
            else:   # 只改版面：沿用舊格子，縮格時默默丟掉落在新尺寸外的（明送 cells 出界才算錯）
                keep = [c for c in _json_list(old["cells"]) if isinstance(c, dict)
                        and isinstance(c.get("r"), int) and isinstance(c.get("c"), int)
                        and 0 <= c["r"] < rows and 0 <= c["c"] < cols and inside(c["r"], c["c"])]
                cells = _clean_cells(conn, keep, rows, cols, inside)
            conn.execute(
                "UPDATE tomb_sites SET name=?, title=?, subtitle=?, footer=?, rows=?, cols=?, "
                "row_labels=?, cells=?, sort_order=?, layout=?, layout_opts=? WHERE id=?",
                (name, str(p.get("title") or ""), str(p.get("subtitle") or ""), str(p.get("footer") or ""),
                 rows, cols, json.dumps(labels, ensure_ascii=False), json.dumps(cells, ensure_ascii=False),
                 int(p.get("sortOrder") or old["sort_order"] or 0), layout, json.dumps(opts), sid),
            )
            conn.commit()
            return {"id": sid}
        cells = _clean_cells(conn, p.get("cells"), rows, cols, inside)
        cur = conn.execute(
            "INSERT INTO tomb_sites (name, title, subtitle, footer, rows, cols, row_labels, cells, sort_order, "
            "layout, layout_opts) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (name, str(p.get("title") or ""), str(p.get("subtitle") or ""), str(p.get("footer") or ""),
             rows, cols, json.dumps(labels, ensure_ascii=False), json.dumps(cells, ensure_ascii=False),
             int(p.get("sortOrder") or 0), layout, json.dumps(opts)),
        )
        conn.commit()
        return {"id": cur.lastrowid}
    finally:
        conn.close()


def delete_tomb_site(sid) -> dict:
    """DELETE /api/tomb-site/{id} → {ok, name}。只刪格子表，成員與 tombs 文字欄不動。"""
    if not _LOCK["editMode"]:
        raise ApiError(403, "edit mode required")
    conn = _conn()
    try:
        r = _site_row(conn, sid)
        conn.execute("DELETE FROM tomb_sites WHERE id = ?", (sid,))
        conn.commit()
        return {"ok": True, "name": r["name"] or ""}
    finally:
        conn.close()


# ============================================================
# CSV 來回（讓 Excel 也能當編輯器）
# ============================================================

def export_tomb_site_csv(sid) -> bytes:
    """GET /api/tomb-site/{id}/csv：第一欄＝列標籤，其餘＝格子文字（稱呼）。UTF-8 BOM＋CRLF 給 Excel。"""
    site = get_tomb_site(sid)
    grid = [[""] * site["cols"] for _ in range(site["rows"])]
    for c in site["cells"]:
        if isinstance(c.get("r"), int) and isinstance(c.get("c"), int) \
                and 0 <= c["r"] < site["rows"] and 0 <= c["c"] < site["cols"]:
            grid[c["r"]][c["c"]] = c["label"]
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\r\n")
    for i, row in enumerate(grid):
        w.writerow([site["rowLabels"][i]] + row)
    return ("﻿" + buf.getvalue()).encode("utf-8")


def import_tomb_site_csv(sid, data) -> dict:
    """POST /api/tomb-site/{id}/csv（raw bytes，需編輯模式）：覆寫整張格子。
    第一欄＝列標籤，其餘＝格子文字；文字若恰好等於某位成員的姓名或字號（唯一）→ 指到該成員，
    否則存為自由文字。回 {rows, cols, matched, unmatched[]}。"""
    if not _LOCK["editMode"]:
        raise ApiError(403, "edit mode required")
    from .csv_io import _import_decode   # noqa: PLC0415（同成員匯入：只收 UTF-8／UTF-8-BOM，其他編碼回 400 白話提示）
    text = _import_decode(data or b"")
    table = [row for row in csv.reader(io.StringIO(text))]
    table = [r for r in table if any((x or "").strip() for x in r)]
    if not table:
        raise ApiError(400, "CSV 內沒有資料列")
    rows = len(table)
    cols = max(len(r) - 1 for r in table)
    if rows > MAX_DIM or cols > MAX_DIM or cols < 1:
        raise ApiError(400, "格子表尺寸須在 1～%d 列／欄之間（第一欄為列標籤）" % MAX_DIM)
    conn = _conn()
    try:
        old = _site_row(conn, sid)
        if _layout_of(old)[0] != "grid":
            raise ApiError(400, "面板、階梯版型請在畫面上逐格編輯（CSV 匯入只支援方格）")
        # 比對鍵：姓名、字號，以及「匯出格式」的稱呼本身（承遠　楊公／阿香　林氏）——
        # 否則匯出再匯回會把所有族親連結掉成純文字（2026-08-21 效能與 bug 檢查抓到）。
        by_key = {}
        for m in conn.execute("SELECT id, name, generation_name, gender FROM members"):
            keys = [m["name"], m["generation_name"], honor_label(m)]
            for key in keys:
                key = (key or "").replace(" ", "").replace("　", "").strip()
                if key:
                    by_key.setdefault(key, set()).add(m["id"])
        cells, matched, unmatched = [], 0, []
        labels = []
        for r, row in enumerate(table):
            labels.append((row[0] or "").strip()[:MAX_TEXT])
            for k, val in enumerate(row[1:]):
                val = (val or "").strip()
                if not val:
                    continue
                ids = by_key.get(val.replace(" ", "").replace("　", ""))
                if ids and len(ids) == 1:
                    cells.append({"r": r, "c": k, "memberId": next(iter(ids)), "text": ""})
                    matched += 1
                else:
                    cells.append({"r": r, "c": k, "memberId": None, "text": val[:MAX_TEXT]})
                    unmatched.append(val)
        conn.execute(
            "UPDATE tomb_sites SET rows=?, cols=?, row_labels=?, cells=? WHERE id=?",
            (rows, cols, json.dumps(labels, ensure_ascii=False), json.dumps(cells, ensure_ascii=False), old["id"]),
        )
        conn.commit()
        return {"ok": True, "rows": rows, "cols": cols, "matched": matched, "unmatched": unmatched}
    finally:
        conn.close()
