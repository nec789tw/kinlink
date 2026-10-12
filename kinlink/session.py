# -*- coding: utf-8 -*-
"""編輯鎖會話：狀態、解鎖／鎖定、PIN 變更（原 server.py）。"""
from __future__ import annotations

import sys

from .errors import ApiError
from .maintenance import auto_backup, get_settings
from .paths import APP_NAME, APP_VERSION
from .state import _LOCK, _conn


def get_state() -> dict:
    """GET /api/state。app_name / theme 取自 settings 表。"""
    s = get_settings()
    return {
        "editMode": _LOCK["editMode"],
        "branch": _LOCK["branch"],
        "theme": s.get("theme", "system"),
        "appName": s.get("app_name", APP_NAME),
        "version": APP_VERSION,
        # 原始碼模式（工程師試跑）＝讀寫專案根的開發庫，非 dist 正式資料；
        # 前端據此顯示常駐警示條，杜絕「不知道自己在改哪份資料庫」（2026-08-20）
        "devMode": not getattr(sys, "frozen", False),
    }


def _read_edit_pin() -> str:
    """讀取 settings.edit_pin（編輯鎖 PIN 的唯一真實來源；db.py seed 預設 '0000'）。"""
    conn = _conn()
    try:
        row = conn.execute("SELECT value FROM settings WHERE key = 'edit_pin'").fetchone()
    finally:
        conn.close()
    return (row["value"] if row else "") or ""


def unlock(pin, branch=None) -> dict:
    """POST /api/lock/unlock。比對 settings.edit_pin；失敗回明確訊息（message）。"""
    real = _read_edit_pin()
    if not pin:
        return {"ok": False, "message": "請輸入 PIN（首次預設為 0000，可於「設定 → 編輯鎖」變更）"}
    if str(pin) != str(real):
        return {"ok": False, "message": "PIN 錯誤，請重新輸入（若未變更過，預設為 0000）"}
    # Y3：解鎖成功即先快照一份「編輯前」（規格 §3 掃墓模式自動快照；
    # 改壞可還原）。備份失敗不阻斷解鎖——護欄非門檻。
    try:
        auto_backup(tag="編輯前")
    except Exception:  # noqa: BLE001
        pass
    _LOCK["editMode"] = True
    _LOCK["branch"] = branch or ""
    return {"ok": True}


def lock() -> dict:
    """POST /api/lock/lock。"""
    _LOCK["editMode"] = False
    _LOCK["branch"] = ""
    return {"ok": True}


def set_pin(old, new) -> dict:
    """POST /api/lock/setpin {old,new} → {ok[,message]}。

    變更編輯鎖 PIN：驗證舊 PIN 與 settings.edit_pin 相符才改；
    新 PIN 不可為空（防止清空後永久鎖死編輯模式，unlock 對空 PIN 一律失敗）。
    """
    new = ("" if new is None else str(new)).strip()
    if not new:
        raise ApiError(400, "新 PIN 不可為空")
    real = _read_edit_pin()
    if str(old or "") != str(real):
        return {"ok": False, "message": "目前 PIN 不正確，請重新輸入"}
    conn = _conn()
    try:
        conn.execute(
            "INSERT INTO settings(key, value) VALUES ('edit_pin', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (new,),
        )
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}
