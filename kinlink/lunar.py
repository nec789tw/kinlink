# -*- coding: utf-8 -*-
"""曆法：歲次干支、原文拆解、國↔農換算（原 server.py，R3）。"""
from __future__ import annotations

import datetime
import re


# ── 列印資料補齊：歲次干支／年號／農曆月日（由既有欄位輕量推導，勿動 schema）──
_GAN = "甲乙丙丁戊己庚辛壬癸"     # 天干（歲次推算用）
_ZHI = "子丑寅卯辰巳午未申酉戌亥"  # 地支


def _era_ganzhi(original):
    """原文年號旁明寫的干支：「民國十六年丁卯臘月」→丁卯、「乾隆丙午年三月」→丙午；沒有回 ''。
    只認緊貼第一個「年」字前後的兩字，不掃整段（免得把時辰之類的字誤認成干支）。"""
    s = str(original or "")
    pos = s.find("年")
    if pos < 0:
        return ""
    for i in (pos + 1, pos - 2):
        if i >= 0 and i + 1 < len(s) and s[i] in _GAN and s[i + 1] in _ZHI:
            return s[i:i + 2]
    return ""


def _ganzhi(birth_date, original=""):
    """推「歲次」干支：先把國曆日期換成農曆年再推（西元 4 年為甲子起算）——
    元旦到春節之間出生的人，歲次仍是前一年（2025-01-15 是甲辰年，不是乙巳年）；
    換算不出精確農曆（只填年份、1900 年前、農曆套件缺件）時，先用原文年號旁明寫的干支，
    沒寫才退回國曆年；再不行從原始記載掃出第一組干支。查無回 ''（列印端以空欄呈現）。

    原文干支優先於國曆年（體檢 domain-8）：臘月出生只填「1928」、原文寫「民國十六年丁卯」，
    國曆年推出來是戊辰——跟同一列的年號自相矛盾，原文才是族譜記載。
    """
    ymd = _ymd(birth_date)
    if ymd and _LunarDate is not None:
        try:
            y = _LunarDate.fromSolarDate(*ymd).year
            return _GAN[(y - 4) % 10] + _ZHI[(y - 4) % 12] + "年"
        except Exception:   # noqa: BLE001（範圍外／無效日期 → 退回原文干支／國曆年）
            pass
    gz = _era_ganzhi(original)
    if gz:
        return gz + "年"
    try:
        y = int(str(birth_date or "")[:4])
        if y > 0:
            return _GAN[(y - 4) % 10] + _ZHI[(y - 4) % 12] + "年"
    except (TypeError, ValueError):
        pass
    s = str(original or "")
    for i in range(len(s) - 1):
        if s[i] in _GAN and s[i + 1] in _ZHI:
            return s[i:i + 2] + "年"
    return ""


# 「年」後面的字算不算農曆月日：有月、日字樣，或是不寫月份的節日說法；
# 年號後只接時辰或節氣（「民國十七年亥時」「民國十七年夏至」）也算，拆到月日欄——
# 原本只收冬至、清明，其他節氣與時辰整段併進年號欄（第二批驗證員；domain-9 之前的版本會拆開）
_SHICHEN = tuple(z + "時" for z in _ZHI)
_JIEQI = ("立春", "雨水", "驚蟄", "春分", "清明", "穀雨", "立夏", "小滿", "芒種", "夏至", "小暑", "大暑",
          "立秋", "處暑", "白露", "秋分", "寒露", "霜降", "立冬", "小雪", "大雪", "冬至", "小寒", "大寒")
_MD_WORDS = ("月", "日", "初", "廿", "除夕", "元旦", "元宵", "端午", "中秋", "臘八",
             "七夕", "中元", "重陽") + _JIEQI + _SHICHEN


def _split_original(original):
    """把原始記載拆成（年號年, 農曆月日）兩段，供列印表「年號／農曆月日」欄。

    例：「光緒27年臘月廿六」→（光緒27年, 臘月廿六）；
        「民國十七年戊辰二月廿一」→（民國十七年, 二月廿一）——年號後緊接的
        干支歸「歲次」欄呈現，此處略去避免重複。
    無「年」字時整段視為農曆月日；空值回 ('', '')。純字串切分、失敗優雅留空。

    體檢 domain-9 補兩種寫法：
      * 「光緒二十七年辛丑年十二月廿六」——干支後面又跟一個「年」，一起略去
        （原本月日欄殘留「年十二月廿六」）；
      * 「道光年間」「民國三十八年生」——「年」後面是「間」、或剩下的字講的不是月日
        （沒有月、日字樣、不是除夕／元宵這類節日、也沒有數字），併回年號欄（原本拆成 道光年／間）。
        併回時照樣略去年號後的干支：「民國十七年戊辰生」→ 民國十七年生（干支已在歲次欄）；
        有數字的仍算月日：「民國17年2/21」→（民國17年, 2/21）。
    「宣統元年不詳」：「不詳」講的是月日不知道，不是年號的一部分 → 月日欄留空（列印印「欠載」），
    年號欄只放「宣統元年」（2026-10-06 對照原版直系族譜表：真實庫有數十人這樣寫）。
    """
    s = str(original or "").strip()
    if not s:
        return "", ""
    pos = s.find("年")
    if pos < 0:
        return "", s
    era, rest = s[:pos + 1], s[pos + 1:].strip()
    if len(rest) >= 2 and rest[0] in _GAN and rest[1] in _ZHI:
        rest = rest[2:].strip()
        if rest.startswith("年"):
            rest = rest[1:].strip()
    if rest in ("不詳", "欠載", "欠 載", "待考"):
        return era, ""
    if rest and (rest.startswith("間") or not (any(k in rest for k in _MD_WORDS)
                                              or any(c.isdigit() for c in rest))):
        return era + rest, ""
    return era, rest


# ── 農曆換算（R3：活動日期國↔農自動換算顯示、農曆日存在性檢查、歲次干支）──
# 純查表（1900–2099），不自研萬年曆。import 失敗（打包缺件）時所有換算 helper
# 一律優雅回 ''，前端徽章／欄位自動退回原文，其餘功能不受影響。
#
# 【2026-09-10 換套件】原用 lunardate，但它是 **GPLv3**——打包進我們散布的 exe
# 會讓整顆 exe 必須以 GPL 授權，與本專案的 MIT 衝突。改用 borax（MIT）。
# 【2026-09-11 全範圍逐日比對更正】1900-01-31～2099-12-31 共 73019 天逐日比對，
# 新舊有 180 天不同（先前抽樣 804 天只看到 4 筆，是低估）。以 lunar-python（MIT，
# 天文演算）三方仲裁：1933／1954／1978／2057 年 borax 全對、**是舊 lunardate 錯**；
# 2089／2097 年 borax 錯（無人會用到）。換套件因此「修好」4 位族人的農曆生日
# （原本被舊套件算差一天）。回歸值釘在 tests/test_r3_lunar.py，換庫時會被擋下。
#
# 下面這層薄轉接維持舊介面（fromSolarDate / toSolarDate / .isLeapMonth），
# 讓其餘程式與 tests monkeypatch `kinlink.lunar._LunarDate` 的既有寫法都不用改。
try:
    from borax.calendars.lunardate import LunarDate as _BoraxLunarDate

    class _LunarDate:                                  # noqa: N801（沿用舊套件的類別名，維持介面）
        """borax LunarDate 的薄轉接：對外仍是 lunardate 的 API 形狀。"""

        __slots__ = ("year", "month", "day", "isLeapMonth", "_o")

        def __init__(self, year, month, day, isLeapMonth=False, _obj=None):
            self._o = _obj if _obj is not None else _BoraxLunarDate(year, month, day, bool(isLeapMonth))
            self.year, self.month, self.day = self._o.year, self._o.month, self._o.day
            self.isLeapMonth = bool(getattr(self._o, "leap", False))

        @classmethod
        def fromSolarDate(cls, year, month, day):      # noqa: N802（舊介面名）
            o = _BoraxLunarDate.from_solar_date(year, month, day)
            return cls(o.year, o.month, o.day, bool(getattr(o, "leap", False)), _obj=o)

        def toSolarDate(self):                          # noqa: N802（舊介面名）
            return self._o.to_solar_date()
except Exception:  # pragma: no cover — 缺件降級
    _LunarDate = None

# 農曆月俗名：正月起、十一月稱「冬」、十二月稱「臘」（與示範資料原文用法一致）
_LUNAR_MONTH_CN = ("正", "二", "三", "四", "五", "六", "七", "八", "九", "十", "冬", "臘")
_NUM_CN = "一二三四五六七八九十"


def _lunar_day_cn(d):
    """農曆日中文：初一…初十、十一…十九、二十、廿一…廿九、三十；超界回 ''。"""
    if 1 <= d <= 10:
        return "初" + _NUM_CN[d - 1]
    if 11 <= d <= 19:
        return "十" + _NUM_CN[d - 11]
    if d == 20:
        return "二十"
    if 21 <= d <= 29:
        return "廿" + _NUM_CN[d - 21]
    if d == 30:
        return "三十"
    return ""


def _lunar_cn(year, month, day, leap=False):
    """農曆年月日 → 「乙巳年三月初八」；閏月標「閏」（如「癸卯年閏二月二十」）。

    年以干支呈現（與 _ganzhi 同式：西元 4 年為甲子起算；干支年與農曆年對齊）。
    月日超界回 ''（防查表外溢出值滲入畫面）。
    """
    day_cn = _lunar_day_cn(day)
    if not day_cn or not (1 <= month <= 12):
        return ""
    gz = _GAN[(year - 4) % 10] + _ZHI[(year - 4) % 12]
    return gz + "年" + ("閏" if leap else "") + _LUNAR_MONTH_CN[month - 1] + "月" + day_cn


# 全形數字／分隔符 → 半形（輸入法、Excel 都可能打出全形）
_FW_DATE = str.maketrans("０１２３４５６７８９－／．", "0123456789-/.")


def _ymd(s):
    """'YYYY-MM-DD'（取前 10 字，容 YYYY-M-D）→ (y, m, d) 整數；格式不符回 None。

    也認 / 與 . 分隔、全形數字（H-2，2026-09-25）：修正前的匯入與表單都不正規化，
    既有庫裡可能已有 Excel 另存的 1960/5/1，不做資料遷移、改成讀的地方都認得。
    """
    t = str(s or "").strip().translate(_FW_DATE)[:10].replace("/", "-").replace(".", "-")
    parts = t.split("-")
    if len(parts) != 3:
        return None
    try:
        return int(parts[0]), int(parts[1]), int(parts[2])
    except ValueError:
        return None


_DATE_YMD_RE = re.compile(r"(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})")
# 手打常見的其他寫法（2026-10-13 總幹事：一家人表格打 19600501、民國年都沒轉，長幼／農曆全算不出來）。
# (樣式, 年份要加多少)：民國年＋1911。年只有一到三位數又帶月日的一律當民國（台灣沒人這樣寫西元年）。
_DATE_INPUT_RES = (
    (_DATE_YMD_RE, 0),                                                                   # 1960-05-01、1960/05/01
    (re.compile(r"(\d{4})(\d{2})(\d{2})"), 0),                                           # 19600501
    (re.compile(r"(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?"), 0),                  # 1960年5月1日
    (re.compile(r"(?:民國|民)\s*(\d{1,3})\s*[年/.-]\s*(\d{1,2})\s*[月/.-]\s*(\d{1,2})\s*日?"), 1911),  # 民國49年5月1日
    (re.compile(r"(\d{1,3})[-/.](\d{1,2})[-/.](\d{1,2})"), 1911),                        # 49/5/1、49.5.1
    (re.compile(r"(\d{3})(\d{2})(\d{2})"), 1911),                                        # 0490501、1120921（民國七碼）
)
_YEAR_INPUT_RES = (
    (re.compile(r"(\d{4})\s*年?"), 0),                                                    # 1928、1928年
    (re.compile(r"(?:民國|民)\s*(\d{1,3})\s*年?"), 1911),                                 # 民國17年
)
_DATE_PARTS_RE = re.compile(r"(\d{4})(?:[-/.](\d{1,2})(?:[-/.](\d{1,2}))?)?")


def normalize_date(s):
    """寫入用：生卒日期正規化成補零的 'YYYY-MM-DD'（H-2，2026-09-25）。

    CSV 新增列／更新列、成員表單、一家人表格存檔都經這裡。接受 年-月-日、年/月/日、年.月.日，
    月日一或兩位數，全形數字與分隔符也行（Excel 另存會把 1960-05-01 變 1960/5/1，
    表單手打常不補零）——不正規化的話，長幼、子女排序（比字串）與農曆換算全會錯。
    2026-10-13 起也認 19600501、1960年5月1日、民國49年5月1日、49/5/1、0490501（見 _DATE_INPUT_RES）。
    只有年份的存成四位數西元年（1928、民國17年 → 1928）；其他看不懂的文字（「不詳」、原文、
    不存在的日期如 1960-02-30）原樣保留、不拒收，免得擋掉既有匯入。空值原樣回。
    """
    if s is None or s == "":
        return s
    t = str(s).strip().translate(_FW_DATE)
    for rx, add in _DATE_INPUT_RES:
        m = rx.fullmatch(t)
        if m:
            y, mo, d = (int(x) for x in m.groups())
            try:
                return datetime.date(y + add, mo, d).isoformat()
            except ValueError:
                return s
    for rx, add in _YEAR_INPUT_RES:
        m = rx.fullmatch(t)
        if m:
            return "%04d" % (int(m.group(1)) + add)
    return s


def _date_parts(s):
    """讀取用：日期字串 → (年, 月, 日)，缺的部分為 None；看不懂（空白、「不詳」）回 None。

    長幼比較、子女排序一律先經這裡，不再直接比字串：既有庫裡的 1960/5/1、1970-5-1
    字串比較會排反，只填年份的 1952 也會被當成比同年的 1952-12-01 早。
    """
    m = _DATE_PARTS_RE.fullmatch(str(s or "").strip().translate(_FW_DATE))
    if not m:
        return None
    return tuple(int(x) if x is not None else None for x in m.groups())


def solar_to_lunar_cn(s):
    """國曆 'YYYY-MM-DD' → 農曆中文「干支年＋月日」（如 2025-04-04 → 乙巳年三月初七）。

    農曆套件（borax）缺件、格式不符或超出查表範圍（1900–2099；範圍外套件會回
    溢出值而非拋錯，故換算後再驗一次）一律回 ''，呼叫端以原文替補。
    """
    if _LunarDate is None:
        return ""
    ymd = _ymd(s)
    if ymd is None or not (1900 <= ymd[0] <= 2099):
        return ""
    try:
        ld = _LunarDate.fromSolarDate(*ymd)
    except Exception:
        return ""
    if not (1900 <= ld.year <= 2099):
        return ""
    return _lunar_cn(ld.year, ld.month, ld.day, bool(getattr(ld, "isLeapMonth", False)))


def lunar_to_solar_iso(s):
    """農曆 'YYYY-MM-DD'（依活動欄位約定視為農曆年月日、非閏月）→ 國曆 ISO 日期。

    失敗（缺件／格式不符／小月無三十日／超出查表）回 ''。換算後回程比對
    一次，任何不一致（如閏月歧義）視為無效輸入回 ''（寧空勿錯日）。
    """
    if _LunarDate is None:
        return ""
    ymd = _ymd(s)
    if ymd is None or not (1900 <= ymd[0] <= 2099 and 1 <= ymd[1] <= 12 and 1 <= ymd[2] <= 30):
        return ""
    try:
        sd = _LunarDate(ymd[0], ymd[1], ymd[2]).toSolarDate()
        back = _LunarDate.fromSolarDate(sd.year, sd.month, sd.day)
    except Exception:
        return ""
    if (back.year, back.month, back.day) != ymd or getattr(back, "isLeapMonth", False):
        return ""
    return sd.isoformat()


def lunar_date_problem(s):
    """農曆活動日存檔前檢查（體檢 domain-3）：這一天存在回 ''，不存在回給總幹事看的中文說明。

    小月只有廿九日：選了「三十」照樣存的話，通函會印出不存在的日期、抬頭年份少一年、
    隔年還被收進「往年」。只講清楚哪裡不對、該怎麼改，不偷偷改成廿九（不替使用者猜日期）。
    農曆庫缺件時無從檢查，回 ''（不擋存，維持缺件降級）。
    """
    if _LunarDate is None:
        return ""
    ymd = _ymd(s)
    if ymd is None:
        return "農曆日期看不懂（%s），請用下拉選單重新選年、月、日。" % s
    y, m, d = ymd
    if not (1900 <= y <= 2099):
        return "農曆年份只能填 1900～2099（目前填的是 %d）。" % y
    if not (1 <= m <= 12 and 1 <= d <= 30):
        return "農曆沒有 %d 月 %d 日：月份是正月～臘月，日子是初一～三十。" % (m, d)
    if lunar_to_solar_iso(s):
        return ""
    ym = _GAN[(y - 4) % 10] + _ZHI[(y - 4) % 12] + "年" + _LUNAR_MONTH_CN[m - 1] + "月"
    if d == 30 and lunar_to_solar_iso("%04d-%02d-29" % (y, m)):
        return "%s只有廿九日（小月），沒有三十，%s請改選廿九。" % (ym, "那年除夕就是廿九，" if m == 12 else "")
    return "農曆%s%s換算不出國曆日期（超出可換算的範圍），請改選其他日子。" % (ym, _lunar_day_cn(d))


def lunar_solar_info(s):
    """GET /api/solar?d=（農曆 'YYYY-MM-DD'）→ {solar, lunar, problem}：活動表單農曆欄的即時對照。

    solar＝換算後國曆 ISO（換不出回 ''）、lunar＝干支中文、problem＝lunar_date_problem 的說明。
    冬月、臘月落在隔年國曆，表單據此提醒「這天在國曆哪一年」（體檢 domain-4）。
    """
    s = str(s or "").strip()
    return {"solar": lunar_to_solar_iso(s), "lunar": lunar_iso_to_cn(s),
            "problem": lunar_date_problem(s) if s else ""}


def lunar_iso_to_cn(s):
    """農曆 'YYYY-MM-DD' 原樣轉中文呈現（純格式化、不需農曆套件）；失敗回 ''。"""
    ymd = _ymd(s)
    if ymd is None:
        return ""
    return _lunar_cn(*ymd)
