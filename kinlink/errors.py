# -*- coding: utf-8 -*-
"""ApiError：讓業務層以例外回特定 HTTP 狀態碼（原 server.py）。"""
from __future__ import annotations

class ApiError(Exception):
    """攜帶 HTTP 狀態碼的 API 例外；訊息會以 JSON 形式回給前端。"""

    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code
        self.message = message
