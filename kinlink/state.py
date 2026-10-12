# -*- coding: utf-8 -*-
"""共用執行期狀態：DB 替身注入、編輯鎖、連線工廠（原 server.py）。

_LOCK 是跨模組共享的可變 dict——各模組一律 `from .state import _LOCK`
取得同一個物件，不可自建副本。get_db() 預設回傳 server 門面模組，
讓 HTTP 層的 _call(db, "函式名") 反射照舊生效。"""
from __future__ import annotations

import sys


_DB_OVERRIDE = None  # 測試 / 主程式可注入替身


def set_db(db_module) -> None:
    """注入資料庫介面（測試或主程式預先開好連線時用）。"""
    global _DB_OVERRIDE
    _DB_OVERRIDE = db_module


def get_db():
    """
    取得目前的「業務介面」（提供 /api/* 路由所需的函式集合）。

    解耦設計：
      * ``db.py`` 是純儲存層（只有 init_db / seed_demo / connect / backup）。
      * 業務函式（get_state / unlock / list_members ...）實作在 kinlink/ 各模組，
        全部透過 ``db.connect()`` 存取 SQLite；server.py 是薄門面，把它們全部轉出。
      * 因此預設回傳 server 門面模組即可滿足路由所有呼叫；測試或主程式仍可用
        ``set_db(...)`` 注入替身覆寫。

    每次請求現取，方便主程式在啟動序中先注入；未注入時回傳 server 門面模組。
    業務函式皆回純 Python dict/list（可 json 序列化）；某函式不存在時，
    路由層會回 501（not implemented）而非崩潰。
    """
    if _DB_OVERRIDE is not None:
        return _DB_OVERRIDE
    return sys.modules["server"]


_LOCK = {"editMode": False, "branch": ""}


def _conn():
    import db  # noqa: PLC0415
    return db.connect()
