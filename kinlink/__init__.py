# -*- coding: utf-8 -*-
"""繫族 KinLink 業務套件。

模組地圖（server.py 只是薄門面，邏輯都在這裡）：
  errors       ApiError
  state        編輯鎖 _LOCK、DB 替身注入、連線工廠
  paths        版本號與 前端/列印範本/資料庫 路徑解析
  lunar        歲次干支與國↔農曆換算
  members      成員 CRUD、樹投影、房頭護欄、安葬、雙軌親邊
  session      解鎖/鎖定/PIN
  kinship      稱謂引擎（LCA＋姻親橋接＋規則派生）
  events       祭祖活動
  tombsites    穴排位場地格線（每場地自畫格子、格子指到成員、CSV 來回、列印資料）
  csv_io       CSV 匯出入（member_id 更新路徑）
  maintenance  設定/備份還原/檢查更新
  httpd        HTTP 路由與伺服器
"""
