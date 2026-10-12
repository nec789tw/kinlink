# -*- coding: utf-8 -*-
"""
繫族 ｜ 資料庫層（db.py）

純標準庫（sqlite3），離線可跑。職責：
  1. init_db(path)  ─ 依規格第 7 節建立 schema、啟用 WAL 與外鍵。
  2. seed_demo()    ─ 灌入少量「楊家虛構示範」資料，供首次執行預覽。
  3. backup(path)   ─ 以 VACUUM INTO 產生單一備份檔（含 WAL 已合併）。
  4. connect()      ─ 取得已套用 pragma 的連線（其他模組共用）。

設計原則：務實、最少相依、全程繁體中文註解。
資料庫一律以 UTF-8 文字儲存日期（西元字串）。在世判定＝death_date IS NULL 且 death_date_original
也空白（kinlink/members.py 的 _is_alive；卒年不詳的已歿者存哨兵「已歿」或只寫卒(原文)）。
"""

import json
import os
import sqlite3

# 模組級別保存目前資料庫路徑，讓 seed_demo()/backup() 不必每次傳路徑。
_DB_PATH = None

# ──────────────────────────────────────────────────────────────────────────
# Schema —— **本檔是 schema 的唯一權威**（docs/規格.md §7 只描述職責、不再複製 SQL，
# 因為複製版曾與實作漂移：列出從未實作的 burial_sites、漏掉後來 ALTER 加的欄位）。
# CREATE TABLE IF NOT EXISTS 可重複執行；新欄位一律走下方 init_db() 內的輕量遷移。
# ──────────────────────────────────────────────────────────────────────────
_SCHEMA = """
-- 1. 成員主表
CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    nickname TEXT,                        -- 保留欄位：別號／小名，目前無 UI（字號請寫 generation_name，見下方「字號歸位」遷移）
    generation_name TEXT,                 -- 字號（App 的「字號」欄、列印牌位皆讀這欄）
    generation_number INTEGER NOT NULL,
    branch TEXT,                          -- 房頭（同名識別標籤顯示，及掃墓現場編輯範圍護欄之依據）
    gender TEXT CHECK(gender IN ('M', 'F', 'O')),
    birth_date TEXT,                      -- 正規化國曆日期（供排序、計齡、提醒）
    birth_calendar TEXT CHECK(birth_calendar IN ('SOLAR', 'LUNAR')),   -- 保留欄位：無 UI、程式不讀（曆別靠 *_date_original 逐字保留）2026-07-28 核對
    birth_date_original TEXT,             -- 原始記載逐字保留（西元／歲次／年號／農曆），供忠實列印不失真
    death_date TEXT,                      -- 在世＝本欄 NULL 且 death_date_original 空白（members._is_alive；不另設 is_alive）；卒年不詳存「已歿」
    death_calendar TEXT CHECK(death_calendar IN ('SOLAR', 'LUNAR')),   -- 保留欄位：同 birth_calendar，無 UI、程式不讀
    death_date_original TEXT,             -- 原始記載逐字保留（族譜歿日多為農曆，如「戊午年八月初一」），供忠實列印不失真
    death_is_leap_month INTEGER CHECK(death_is_leap_month IN (0, 1)) DEFAULT 0,   -- 保留欄位：閏月旗標，無 UI、程式不讀
    phone TEXT,
    email TEXT,                           -- 保留欄位：無 UI（通知走紙本信函，長輩無 email）2026-07-28 核對
    current_address TEXT,
    avatar_url TEXT,                      -- 保留欄位：無 UI（離線 USB 不放照片）
    custom_kinship_term TEXT,             -- 家族習慣稱呼（覆寫標準稱謂查表）
    note TEXT,                            -- 備註逐字保留（原居地/出外無歸/歿地等，忠實不失真）
    postal_code TEXT,                     -- 郵遞區號（信封片頭／通函寄送用；與現居地址搭配）
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. 婚姻關係表（支援多元配偶與同婚）
CREATE TABLE IF NOT EXISTS marriages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    spouse_1_id INTEGER NOT NULL,
    spouse_2_id INTEGER NOT NULL,
    marriage_status TEXT CHECK(marriage_status IN ('MARRIED', 'DIVORCED', 'WIDOWED', 'SEPARATED')) DEFAULT 'MARRIED',
    marriage_date TEXT,                   -- 保留欄位：無 UI（族譜多無婚期記載）2026-07-28 核對
    CHECK (spouse_1_id <> spouse_2_id),   -- 防自婚
    FOREIGN KEY (spouse_1_id) REFERENCES members(id) ON DELETE RESTRICT,
    FOREIGN KEY (spouse_2_id) REFERENCES members(id) ON DELETE RESTRICT
);

-- 3. 親子關係表（雙軌制：血緣與法定過繼；可掛至特定婚姻組合）
CREATE TABLE IF NOT EXISTS relationships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id INTEGER NOT NULL,
    child_id INTEGER NOT NULL,
    marriage_id INTEGER,                  -- 保留欄位：業務程式不讀（只有 seed_demo 示範資料會寫入；2026-09-11 決定繼親歸屬改以母親邊表達，見規格 §4.1）
    relation_type TEXT CHECK(relation_type IN ('BIOLOGICAL', 'ADOPTED', 'FOSTER')) DEFAULT 'BIOLOGICAL',
    CHECK (parent_id <> child_id),
    UNIQUE (parent_id, child_id, relation_type),   -- 防重複關係
    FOREIGN KEY (parent_id) REFERENCES members(id) ON DELETE RESTRICT,
    FOREIGN KEY (child_id) REFERENCES members(id) ON DELETE RESTRICT,
    FOREIGN KEY (marriage_id) REFERENCES marriages(id) ON DELETE SET NULL
);

-- 4. 墓葬地點資訊表（從屬資料，可隨成員刪除而清除）
CREATE TABLE IF NOT EXISTS tombs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER NOT NULL,
    tomb_type TEXT CHECK(tomb_type IN ('BURIAL', 'COLUMBARIUM', 'TREE')) DEFAULT 'COLUMBARIUM',   -- App「安葬型態」下拉
    latitude REAL,                        -- 保留欄位：無 UI（離線無地圖）2026-07-28 核對
    longitude REAL,                       -- 保留欄位：同上
    address_description TEXT,             -- App「安葬地點」文字欄（主要靠文字描述集合/位置）
    detail_location_code TEXT,            -- App「穴位／塔位編號」欄，供穴排位表使用
    tomb_photo_url TEXT,                  -- 保留欄位：無 UI（離線 USB 不放照片）
    FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
);

-- 5. 祭祖活動事件表
CREATE TABLE IF NOT EXISTS ritual_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_name TEXT NOT NULL,
    deceased_member_id INTEGER,           -- 對應逝者，供動態代稱與農曆換算，可為 NULL（合祭）
    target_date TEXT NOT NULL,
    calendar_type TEXT CHECK(calendar_type IN ('SOLAR', 'LUNAR')) DEFAULT 'SOLAR',
    assembly_location TEXT,
    event_note TEXT,
    letter_body TEXT,                     -- 掃墓通函「說明」內文（多行，一行一條，列印時編號條列）
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (deceased_member_id) REFERENCES members(id) ON DELETE SET NULL
);

-- 5b. 穴排位場地（規格 §2.5「場地格線」，2026-08-21 實作）：一列＝一張可列印的格子表。
--     版面是每個場地自己的設定（列數／欄數／列標籤），程式不預設墓園長相。
--     cells 存 JSON：[{"r":0,"c":1,"memberId":12,"text":""}]——memberId 指到成員（印出時自動套
--     「字號　姓公／名　姓氏」，改名自動跟著變）；text 為自由文字（走道、神位、外姓），優先於自動稱呼。
CREATE TABLE IF NOT EXISTS tomb_sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,                   -- 場地／分頁名（例：示範墓園 1985年入穴）
    title TEXT,                           -- 列印抬頭（墓園全名）
    subtitle TEXT,                        -- 列印副標（入穴日／門號）
    footer TEXT,                          -- 列印頁尾（地址）
    rows INTEGER NOT NULL DEFAULT 5,
    cols INTEGER NOT NULL DEFAULT 6,
    row_labels TEXT,                      -- JSON 陣列（「第11世」…）；空白以「第N」補
    cells TEXT NOT NULL DEFAULT '[]',     -- JSON 陣列，見上
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 6. 全局設定表（編輯鎖 PIN、掃墓週期、閏月提醒策略等，鍵值對；不另建設定模組）
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);

-- 查詢加速用索引（非規格強制，但實務常用；可重複執行）
CREATE INDEX IF NOT EXISTS idx_members_branch ON members(branch);
CREATE INDEX IF NOT EXISTS idx_members_gen ON members(generation_number);
CREATE INDEX IF NOT EXISTS idx_rel_parent ON relationships(parent_id);
CREATE INDEX IF NOT EXISTS idx_rel_child ON relationships(child_id);
CREATE INDEX IF NOT EXISTS idx_tombs_member ON tombs(member_id);
CREATE INDEX IF NOT EXISTS idx_events_member ON ritual_events(deceased_member_id);
"""

# settings 表預設值（編輯鎖 PIN、掃墓週期、閏月提醒策略等；缺項才補，不覆寫既有值）
_DEFAULT_SETTINGS = {
    "app_name": "繫族",
    "theme": "system",                      # light / dark / system
    "edit_pin": "0000",                     # 編輯鎖 PIN（僅防誤觸，非資安機制）
    "sweep_cycle": "QINGMING",              # 掃墓週期：QINGMING清明 / SANRIJIE三日節 / HAKKA客家掛紙 / WINTER冬至 / CUSTOM自訂
    "leap_month_reminder": "BEFORE_MONTH",  # 閏月忌日提醒策略：正月提醒/僅逢閏年/前一月同日
    # 房頭（房份）清單：以 JSON 陣列字串存放，可由各家族自訂數量與名稱。
    # 不預設任何房頭（各家族未必三房；原發起家族專屬的「大/二/三房」不再寫死）。
    # 留空＝不分房；匯入時由實際資料自動帶入（見 set_branches_from_data），
    # 使用者亦可於設定頁自由增減。前端房頭下拉、編輯範圍護欄皆讀此鍵。
    "branches": json.dumps([], ensure_ascii=False),
    # 協會資料（用於掃墓通函、信封片頭與各式列印抬頭）：
    # 家族中性——一律預設空字串，由各家族／宗親會於設定頁自行填寫，不寫死任何真實資料。
    "org_name": "",           # 協會（宗親會）全名
    "org_address": "",        # 會址
    "org_contact_addr": "",   # 聯絡處（含郵遞區號之聯絡地址）
    "org_chair": "",          # 理事長姓名
    "org_chair_phone": "",    # 理事長電話
    "org_officer": "",        # 總幹事姓名
    "org_officer_phone": "",  # 總幹事電話
    "org_reg_no": "",         # 立案（登記）字號
    # 「檢查更新」的官方發佈來源（GitHub owner/repo）。他族自行 fork 發佈時可在「關於」頁改成
    # 自己的 repo；INSERT OR IGNORE 不會覆蓋已改過或刻意清空的值。
    "github_repo": "nec789tw/kinlink",
}


# ──────────────────────────────────────────────────────────────────────────
# 連線
# ──────────────────────────────────────────────────────────────────────────
def connect(path=None):
    """取得一條已套用 pragma 的 sqlite3 連線。

    每條連線都重新設定 foreign_keys（per-connection 屬性，不會持久化），
    並把列工廠設為 sqlite3.Row，方便上層以欄名取值。
    """
    p = path or _DB_PATH
    if p is None:
        raise RuntimeError("資料庫尚未初始化，請先呼叫 init_db(path)")
    conn = sqlite3.connect(p)
    try:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON;")       # 外鍵約束需逐連線開啟
        conn.execute("PRAGMA journal_mode = WAL;")      # WAL 為資料庫層級設定，設一次即持久
        conn.execute("PRAGMA synchronous = NORMAL;")    # WAL 下 NORMAL 已足夠耐用且較快
    except BaseException:
        # 檔頭損壞時 PRAGMA 就會失敗：先關掉再丟，不然這條連線會跟著例外的 traceback 一直活著、
        # 鎖住資料庫檔，之後的還原替換會被 Windows 擋成 PermissionError（第一批驗證 L-3a）
        conn.close()
        raise
    return conn


# ──────────────────────────────────────────────────────────────────────────
# 初始化
# ──────────────────────────────────────────────────────────────────────────
def init_db(path, activate=True):
    """建立（或開啟）資料庫並套用 schema，啟用 WAL 與外鍵。

    可重複呼叫（IF NOT EXISTS）。回傳：是否為「首次建立」（資料庫先前不存在）。
    呼叫端可據此決定要不要 seed_demo()。
    activate=False：只對 path 補建表／遷移，不切換目前開啟的資料庫（_DB_PATH）——
    還原備份時對暫存檔跑遷移用（伺服器是多執行緒，切過去別的請求會連到暫存檔）。
    """
    global _DB_PATH
    # 確保目錄存在（path 可能含子資料夾）
    parent = os.path.dirname(os.path.abspath(path))
    if parent:
        os.makedirs(parent, exist_ok=True)

    fresh = not os.path.exists(path)
    if activate:
        _DB_PATH = path

    conn = connect(path)
    try:
        conn.executescript(_SCHEMA)
        # 輕量遷移：既有資料庫補新欄位（CREATE IF NOT EXISTS 不會 ALTER 舊表）
        try:
            conn.execute("ALTER TABLE members ADD COLUMN note TEXT")
        except Exception:
            pass  # 欄位已存在
        try:
            conn.execute("ALTER TABLE members ADD COLUMN postal_code TEXT")
        except Exception:
            pass  # 欄位已存在
        try:
            conn.execute("ALTER TABLE ritual_events ADD COLUMN letter_body TEXT")
        except Exception:
            pass  # 欄位已存在
        # 原版關係註記（2026-10-06 K-2）：從家族原有的全家族表／直系族譜表補回、系統原本存不下的三件事。
        # 都是選填：沒有值時列印照舊用生日推排行、配偶只標妻／夫（他族新裝的庫一律是空的）。
        #   relationships.orig_label：子女在父親那張表上的原版稱呼（「三男」「長男(螟蛉子)」「三女(嗣胡)」「養女」）
        #   relationships.sib_order ：家族記載的子女順序（1 起算；生日不詳時也排得出來）
        #   marriages.spouse_role   ：配偶身分（「續」「再續」「側室」「妾」「招贅」「入贅」；空白＝元配）
        # 穴排位版型（2026-10-12，照家族的穴排位圖）：grid 方格（原本）／panels 紅框面板並排／steps 階梯主牌位；
        # layout_opts 存版型設定（面板：每塊欄數＋各塊列數；階梯：各層格數）。舊庫沒有值＝方格。
        for ddl in ("ALTER TABLE tomb_sites ADD COLUMN layout TEXT",
                    "ALTER TABLE tomb_sites ADD COLUMN layout_opts TEXT"):
            try:
                conn.execute(ddl)
            except Exception:
                pass  # 欄位已存在
        for ddl in ("ALTER TABLE relationships ADD COLUMN orig_label TEXT",
                    "ALTER TABLE relationships ADD COLUMN sib_order INTEGER",
                    "ALTER TABLE marriages ADD COLUMN spouse_role TEXT"):
            try:
                conn.execute(ddl)
            except Exception:
                pass  # 欄位已存在
        try:
            # 掃墓通知寄送對象（戶長／代表制）：1＝寄。片頭/合併列印只出有標記者；
            # 全庫皆未標記時退回「在世且有地址」全寄（他族開源初始狀態）。
            conn.execute("ALTER TABLE members ADD COLUMN mail_target INTEGER")
        except Exception:
            pass  # 欄位已存在
        # 字號歸位（2026-07-28）：舊版 import_to_db 誤把「字號」寫進 nickname，
        # 而 App／列印一律讀 generation_name（styleName），導致 69 筆字號存在卻永遠看不到。
        # 這裡把僅存於 nickname 的字號搬到 generation_name（冪等：generation_name 已有值就不動），
        # 讓既有資料庫免重匯即修復——重匯會覆蓋使用者在 App 內的編輯，不可行。
        # nickname 之後留給「別號／小名」使用（目前無 UI）。
        try:
            conn.execute(
                "UPDATE members SET generation_name = nickname, nickname = NULL "
                " WHERE (generation_name IS NULL OR generation_name = '') "
                "   AND nickname IS NOT NULL AND nickname <> ''"
            )
        except Exception:
            pass  # 舊庫無此欄位時略過
        # 補上預設 settings（INSERT OR IGNORE 不覆寫既有值）
        conn.executemany(
            "INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)",
            list(_DEFAULT_SETTINGS.items()),
        )
        conn.commit()
    finally:
        conn.close()
    return fresh


# ──────────────────────────────────────────────────────────────────────────
# 示範資料（楊家虛構，僅供首次執行預覽；與前端 mock 同調性）
# ──────────────────────────────────────────────────────────────────────────
def seed_demo():
    """灌入少量「楊家虛構示範」資料。

    僅在「全新」資料庫才灌：members 表為空、而且從來沒有過成員（避免重複疊加，
    也避免清空示範／自行刪光成員後，下次開程式又被灌回示範）。回傳：實際寫入的成員筆數。
    結構：三代楊家——
        第一代 楊伯昌（歿）× 林淑梅（歿）
        第二代 楊建華（長房）× 王美玲、楊建國（次房）
        第三代 楊承恩（建華子）
    並含一段婚姻、親子關係、一筆墓葬、一筆祭祖事件、一張穴排位場地；示範房頭（長房／次房）
    寫進 settings.branches（原本是空清單才寫）。
    灌入的成員／活動／場地 id 與名稱記進 settings.demo_manifest，供「清空示範資料」只刪這些列。
    """
    if _DB_PATH is None:
        raise RuntimeError("資料庫尚未初始化，請先呼叫 init_db(path)")

    conn = connect(_DB_PATH)
    try:
        n = conn.execute("SELECT COUNT(*) AS c FROM members").fetchone()["c"]
        if n > 0:
            return 0  # 已有資料，不重複灌
        # 曾經有過成員就不是全新庫（2026-09-25 H-1）：AUTOINCREMENT 的 sqlite_sequence 會記住
        # 用過的最大 id，清空示範或刪光成員後仍在。舊版（0.2.0）清空示範後還沒建人就關程式的庫
        # 也靠這條擋下，不必另設旗標，也不必改 app.py 的啟動契約。
        used = conn.execute("SELECT seq FROM sqlite_sequence WHERE name = 'members'").fetchone()
        if used and used["seq"]:
            return 0

        cur = conn.cursor()

        # ── 第一代（皆已歿，death_date 非 NULL）──
        cur.execute(
            """INSERT INTO members
               (name, generation_name, generation_number, branch, gender,
                birth_date, birth_calendar, birth_date_original,
                death_date, death_calendar, death_date_original)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            ("楊伯昌", "伯", 1, "本宗", "M",
             "1928-03-12", "SOLAR", "民國十七年戊辰二月廿一",
             "1995-11-08", "SOLAR", "民國八十四年乙亥九月十六"),
        )
        id_bochang = cur.lastrowid

        cur.execute(
            """INSERT INTO members
               (name, generation_number, branch, gender,
                birth_date, birth_calendar, death_date, death_calendar)
               VALUES (?,?,?,?,?,?,?,?)""",
            ("林淑梅", 1, "本宗", "F",
             "1931-07-20", "LUNAR", "2003-02-14", "SOLAR"),
        )
        id_shuzhen = cur.lastrowid

        # ── 第二代 ──（長房 建華、次房 建國）
        cur.execute(
            """INSERT INTO members
               (name, generation_name, generation_number, branch, gender,
                birth_date, birth_calendar, phone, current_address)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            ("楊建華", "建", 2, "長房", "M",
             "1955-05-01", "SOLAR", "0912-345-678", "台南市中西區"),
        )
        id_jianhua = cur.lastrowid

        cur.execute(
            """INSERT INTO members
               (name, generation_name, generation_number, branch, gender, birth_date, birth_calendar)
               VALUES (?,?,?,?,?,?,?)""",
            ("王美玲", None, 2, "長房", "F", "1958-09-18", "SOLAR"),
        )
        id_meiling = cur.lastrowid

        cur.execute(
            """INSERT INTO members
               (name, generation_name, generation_number, branch, gender, birth_date, birth_calendar)
               VALUES (?,?,?,?,?,?,?)""",
            ("楊建國", "建", 2, "次房", "M", "1960-12-03", "SOLAR"),
        )
        id_jianguo = cur.lastrowid

        # ── 第三代 ──（建華之子 承恩）
        cur.execute(
            """INSERT INTO members
               (name, generation_name, generation_number, branch, gender, birth_date, birth_calendar)
               VALUES (?,?,?,?,?,?,?)""",
            ("楊承恩", "承", 3, "長房", "M", "1985-04-22", "SOLAR"),
        )
        id_chengen = cur.lastrowid

        # ── 婚姻：第一代 伯昌 × 淑梅（喪偶）；第二代 建華 × 美玲（存續）──
        cur.execute(
            """INSERT INTO marriages (spouse_1_id, spouse_2_id, marriage_status, marriage_date)
               VALUES (?,?,?,?)""",
            (id_bochang, id_shuzhen, "WIDOWED", "1950-02-06"),
        )
        m_gen1 = cur.lastrowid

        cur.execute(
            """INSERT INTO marriages (spouse_1_id, spouse_2_id, marriage_status, marriage_date)
               VALUES (?,?,?,?)""",
            (id_jianhua, id_meiling, "MARRIED", "1982-10-10"),
        )
        m_gen2 = cur.lastrowid

        # ── 親子關係（血緣；掛至對應婚姻組合）──
        rels = [
            (id_bochang, id_jianhua, m_gen1, "BIOLOGICAL"),  # 伯昌 → 建華
            (id_shuzhen, id_jianhua, m_gen1, "BIOLOGICAL"),
            (id_bochang, id_jianguo, m_gen1, "BIOLOGICAL"),  # 伯昌 → 建國
            (id_shuzhen, id_jianguo, m_gen1, "BIOLOGICAL"),
            (id_jianhua, id_chengen, m_gen2, "BIOLOGICAL"),  # 建華 → 承恩
            (id_meiling, id_chengen, m_gen2, "BIOLOGICAL"),
        ]
        cur.executemany(
            """INSERT INTO relationships (parent_id, child_id, marriage_id, relation_type)
               VALUES (?,?,?,?)""",
            rels,
        )

        # ── 墓葬：第一代 伯昌（土葬，純文字位置描述）──
        cur.execute(
            """INSERT INTO tombs
               (member_id, tomb_type, address_description, detail_location_code)
               VALUES (?,?,?,?)""",
            (id_bochang, "BURIAL", "台南市南山公墓 楊氏祖塋", "A 區第 12 排"),
        )

        # ── 穴排位場地：方格、階梯、面板各一張（全為虛構；內容見 DEMO_TOMB_SITES）──
        who = {"楊伯昌": id_bochang, "林淑梅": id_shuzhen, "楊建華": id_jianhua, "王美玲": id_meiling,
               "楊建國": id_jianguo, "楊承恩": id_chengen}
        demo_sites = []
        for site in DEMO_TOMB_SITES:
            cells = []
            for r, c, nm, text, top in site["cells"]:
                cell = {"r": r, "c": c, "memberId": who[nm] if nm else None, "text": text}
                if top:
                    cell["top"] = top
                cells.append(cell)
            cur.execute(
                """INSERT INTO tomb_sites (name, title, subtitle, footer, rows, cols, row_labels, cells, layout, layout_opts)
                   VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (site["name"], site["title"], site["subtitle"], site["footer"], site["rows"], site["cols"],
                 json.dumps(site["row_labels"], ensure_ascii=False), json.dumps(cells, ensure_ascii=False),
                 site["layout"], json.dumps(site["layout_opts"])),
            )
            demo_sites.append([cur.lastrowid, site["name"]])

        # ── 祭祖事件：清明合祭（不綁定特定逝者）──
        # 名稱的干支要跟日期對得上：2026-04-05 是丙午年（0.2.1 以前誤寫「乙巳年」，體檢 opensource-11）
        cur.execute(
            """INSERT INTO ritual_events
               (event_name, deceased_member_id, target_date, calendar_type, assembly_location, event_note)
               VALUES (?,?,?,?,?,?)""",
            (DEMO_EVENT_NAME, None, "2026-04-05", "SOLAR",
             "南山公墓楊氏祖塋牌坊前", "上午九時集合，備供品、香燭、鮮花；中午備餐會。"),
        )
        id_event = cur.lastrowid

        # ── 示範房頭寫進設定：示範成員分屬長房／次房，房頭下拉與掃墓現場的房頭護欄才試得到
        #    （體檢 opensource-11）。只在仍是預設空清單時寫，不蓋掉使用者設過的。──
        cur.execute(
            "UPDATE settings SET value = ? WHERE key = 'branches' AND COALESCE(value, '') IN ('', '[]')",
            (json.dumps(DEMO_BRANCHES, ensure_ascii=False),),
        )

        # ── 首次使用：標記本庫載有示範資料。
        #    設定頁「清空示範資料」鈕僅於 demo_data='1' 時顯示；
        #    POST /api/demo/clear 只刪 demo_manifest 記下、且名稱仍對得上的列（H-1），
        #    使用者自己建的資料一律保留。──
        cur.execute(
            "INSERT INTO settings(key, value) VALUES ('demo_data', '1') "
            "ON CONFLICT(key) DO UPDATE SET value = '1'"
        )
        demo_ids = [id_bochang, id_shuzhen, id_jianhua, id_meiling, id_jianguo, id_chengen]
        manifest = {
            "members": [[r["id"], r["name"]] for r in conn.execute(
                "SELECT id, name FROM members WHERE id IN (%s) ORDER BY id"
                % ",".join("?" * len(demo_ids)), demo_ids)],
            "ritual_events": [[id_event, DEMO_EVENT_NAME]],
            "tomb_sites": demo_sites,
            "branches": DEMO_BRANCHES,      # 清空示範時，這組裡已沒人用的從房頭設定拿掉（其他房頭不動）
        }
        cur.execute(
            "INSERT INTO settings(key, value) VALUES ('demo_manifest', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (json.dumps(manifest, ensure_ascii=False),),
        )

        conn.commit()
        # 回傳寫入的成員筆數
        return conn.execute("SELECT COUNT(*) AS c FROM members").fetchone()["c"]
    finally:
        conn.close()


DEMO_EVENT_NAME = "丙午年清明掃墓"
DEMO_BRANCHES = ["長房", "次房"]

# 示範場地的完整內容（seed_demo 照這份灌；清空示範時拿來比對使用者有沒有動過——
# 格子、抬頭、列欄設定、版型任一改過，就當成使用者的場地保留，只解除指向示範成員的連結）。
# cells：(列, 欄, 指到的示範成員姓名或 None, 文字, 上方小字)。
# 第一張（方格）0.2.0～0.2.6 灌的內容與此相同；階梯、面板兩張 0.2.7 起才有（2026-10-12 總幹事：
# 新家族一打開就要看得到三種版型各長什麼樣——主牌位放先人，面板放後代，跟楊家的圖一樣）。
_DEMO_ADDR = "地址：範例市示範里示範路一段1號（虛構示範）"
DEMO_TOMB_SITES = [
    {"name": "示範墓園・楊氏祖塋", "title": "楊氏祖塋穴排位圖（虛構示範）", "subtitle": "西元 1985 年入穴　1門",
     "footer": _DEMO_ADDR, "layout": "grid", "layout_opts": {}, "rows": 3, "cols": 5,
     "row_labels": ["第1世", "第2世", "第3世"],
     "cells": [(0, 1, "楊伯昌", "", ""), (0, 3, "林淑梅", "", ""), (1, 2, None, "（預留）", "")]},
    {"name": "示範墓園・主牌位（階梯）", "title": "楊氏祖塋主牌位（虛構示範）", "subtitle": "西元 1990 年安位",
     "footer": _DEMO_ADDR, "layout": "steps", "layout_opts": {"rowWidths": [2, 4, 6]}, "rows": 3, "cols": 6,
     "row_labels": [],
     "cells": [(0, 0, "楊伯昌", "", "一世"), (0, 1, "林淑梅", "", "一世"),
               (1, 0, "楊建華", "", "二世"), (1, 1, "王美玲", "", "二世"), (1, 2, "楊建國", "", "二世"),
               (1, 3, None, "", "二世")] + [(2, c, None, "", "三世") for c in range(6)]},
    {"name": "示範墓園・面板", "title": "楊氏祖塋穴排位面板（虛構示範）", "subtitle": "西元 2020 年入穴",
     "footer": _DEMO_ADDR, "layout": "panels", "layout_opts": {"panelCols": 2, "panelRows": [4, 3]}, "rows": 4, "cols": 4,
     "row_labels": [],
     "cells": [(0, 0, "楊承恩", "", "三世"), (0, 1, None, "", "三世"), (1, 0, None, "", "四世"),
               (0, 2, None, "神位", "")]},
]
DEMO_TOMB_SITE = DEMO_TOMB_SITES[0]

# 舊版（0.2.0）seed 沒記 demo_manifest：清空示範時改用這組固定特徵辨識示範列。
# **必須與上方 seed_demo 灌入的內容一致**（tests/test_h1_demo_clear.py 會比對，改示範內容忘了同步就失敗）。
# 成員要「姓名＋世代＋出生日」全中才算示範；被使用者改名、改生日的一律當自家資料保留。
DEMO_SIGNATURE = {
    "members": [("楊伯昌", 1, "1928-03-12"), ("林淑梅", 1, "1931-07-20"),
                ("楊建華", 2, "1955-05-01"), ("王美玲", 2, "1958-09-18"),
                ("楊建國", 2, "1960-12-03"), ("楊承恩", 3, "1985-04-22")],
    # 名稱＋日期；「乙巳年清明掃墓」是 0.2.0／0.2.1 灌的舊名（干支寫錯），留著才清得掉舊示範庫
    "ritual_events": [(DEMO_EVENT_NAME, "2026-04-05"), ("乙巳年清明掃墓", "2026-04-05")],
    "tomb_sites": [x["name"] for x in DEMO_TOMB_SITES],      # 名稱（0.2.0 只灌第一張；多列名稱不影響舊庫）
}


# ──────────────────────────────────────────────────────────────────────────
# 備份（VACUUM INTO 單檔；WAL 內容會一併合併進備份）
# ──────────────────────────────────────────────────────────────────────────
def backup(path):
    """以 VACUUM INTO 產生單一備份檔（含 WAL 已合併、體積最小化）。

    先寫到「<目標>.tmp」，VACUUM INTO 成功才改名成正式檔名；失敗就刪掉暫存檔再丟例外——
    現有庫部分損壞時 VACUUM 會半途失敗，舊版直接寫正式檔名，留下一個不完整、檔名卻跟正常備份
    一模一樣的檔（第一批驗證 L-3b）。暫存檔不是 .db 結尾，也不會被自動備份輪替的 glob 當成備份。
    同名舊檔（例如同一天的自動備份）要等新備份完成才被取代。
    回傳：實際寫出的備份檔絕對路徑。
    """
    if _DB_PATH is None:
        raise RuntimeError("資料庫尚未初始化，請先呼叫 init_db(path)")

    target = os.path.abspath(path)
    parent = os.path.dirname(target)
    if parent:
        os.makedirs(parent, exist_ok=True)
    tmp = target + ".tmp"
    if os.path.exists(tmp):
        os.remove(tmp)  # VACUUM INTO 要求目標為新檔（上次中斷留下的暫存檔）

    try:
        conn = connect(_DB_PATH)
        try:
            # 參數化路徑避免單引號跳脫問題
            conn.execute("VACUUM INTO ?", (tmp,))
            conn.commit()
        finally:
            conn.close()
        os.replace(tmp, target)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise
    return target


# ──────────────────────────────────────────────────────────────────────────
# 自我測試：python db.py [db路徑] → 建表、灌示範、做一次備份
# ──────────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import sys

    db_path = sys.argv[1] if len(sys.argv) > 1 else "kinship.db"
    fresh = init_db(db_path)
    print(f"init_db: {db_path}（{'首次建立' if fresh else '既有資料庫'}）")
    written = seed_demo()
    print(f"seed_demo: 寫入 {written} 名成員")
    bk = backup(db_path + ".bak")
    print(f"backup: {bk}")
