# -*- coding: utf-8 -*-
"""把 dist\\繫族.exe 打成發佈用的兩個檔（都在 dist\\，兩個都要上傳到 GitHub Releases）：

  * kinlink-v<VERSION>-win-x64.zip：繫族.exe ＋ 先看我.txt ＋ LICENSE ＋ THIRD-PARTY-NOTICES.txt，
    給一般人手動下載。為什麼要 zip：瀏覽器與公司網路常直接擋裸 .exe 下載；zip 幾乎都拿得到。
  * kinlink-v<VERSION>-win-x64.exe：和 繫族.exe 同一個檔，給程式內「檢查更新」用——更新器只認
    release 的 .exe 附件（kinlink/maintenance.py check_update），只傳 zip 的話永遠抓不到新版
    （體檢 release-5）。

THIRD-PARTY-NOTICES.txt（體檢 release-8）：exe 內含 Python（連同 OpenSSL、libffi…）、pywebview、
WebView2 SDK、borax、pythonnet 等，它們的授權都要求散布二進位檔時附上版權與授權文字。
由 build_notices() 在打包當下從 build venv 的 dist-info 現抓，套件升級也不會過期。
列哪些套件：讀 PyInstaller 這次的分析結果（PYZ-00.toc／PKG-00.toc）取實際打進 exe 的模組，
再對回套件（L-5）；讀不到才退回「build venv 全部套件扣掉建置工具」並印 WARN。

由 build_exe.bat 在打包驗證後以 build_venv 的 Python 呼叫；純標準庫，任何人 clone 下來都能重現。
"""
import ast
import importlib.metadata
import inspect
import platform
import re
import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXE = ROOT / "dist" / "繫族.exe"
README = ROOT / "release" / "先看我.txt"
LICENSE = ROOT / "LICENSE"
NOTICES_NAME = "THIRD-PARTY-NOTICES.txt"
# PyInstaller 的工作資料夾（build_exe.bat：--workpath build_venv\pyi-build；子資料夾＝spec 名）
PYI_WORK = ROOT / "build_venv" / "pyi-build" / "繫族"

# 只在建置時用、不會進 exe 的套件（繫族.spec 的 excludes 擋掉 pip/setuptools；wheel、
# hooks-contrib 只供 PyInstaller 分析用）。PyInstaller 本身另立「bootloader」一節。
# 只用在「讀不到 PyInstaller 分析結果」的退路：那時列 build venv 全部套件扣掉這些，寧可多列，
# 不可漏列（altgraph／pefile／packaging／pywin32-ctypes 因此會被多列）。
_BUILD_ONLY = {"pip", "setuptools", "wheel", "pyinstaller", "pyinstaller-hooks-contrib"}

_LICENSE_FILE = re.compile(r"^(licen[cs]e|copying|notice|authors)", re.I)
_WEBVIEW2_DLL = re.compile(r"^(microsoft\.web\.webview2\..+|webview2loader)\.dll$", re.I)

# pywebview 的 wheel 附了 WebView2 SDK 的 DLL 卻沒附 SDK 授權文字，只好收在這裡。
# 原文：Microsoft.Web.WebView2 NuGet 套件的 LICENSE（與 pywebview 5.4 所附 DLL 同版 1.0.2957.106）
# https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.2957.106/License
_WEBVIEW2_LICENSE = """\
Copyright (C) Microsoft Corporation. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

   * Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.
   * Redistributions in binary form must reproduce the above
copyright notice, this list of conditions and the following disclaimer
in the documentation and/or other materials provided with the
distribution.
   * The name of Microsoft Corporation, or the names of its contributors
may not be used to endorse or promote products derived from this
software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
"""

# 標準 MIT 授權全文（https://opensource.org/license/mit）。給「metadata 標 MIT、dist-info 卻沒附
# 授權檔」的套件用（如 proxy_tools 0.1.0）：MIT 要求散布時附上版權聲明與本文，依 metadata 作者補上。
_MIT_TEMPLATE = """\
MIT License

Copyright (c) {holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""

_RULE = "=" * 78
_THIN = "-" * 78


def _norm_name(name: str) -> str:
    """PEP 503 名稱正規化：pywin32_ctypes ＝ pywin32-ctypes。"""
    return re.sub(r"[-_.]+", "-", name or "").lower()


def _read(path) -> str:
    return Path(path).read_bytes().decode("utf-8", errors="replace").replace("\r\n", "\n").strip("\n")


def _distributions(site_packages=None) -> dict:
    """{正規化名稱: Distribution}。site_packages 省略＝目前這支 Python（build_venv）。"""
    kw = {}
    if site_packages:
        if isinstance(site_packages, (str, Path)):
            site_packages = [site_packages]
        kw["path"] = [str(p) for p in site_packages]
    out = {}
    for d in importlib.metadata.distributions(**kw):
        key = _norm_name(d.metadata["Name"] or "")
        if key and key not in out:
            out[key] = d
    return out


def _license_files(dist) -> list:
    """dist-info 內附的授權檔（LICENSE／COPYING／NOTICE／AUTHORS，含 licenses/ 子目錄）。"""
    out = [f for f in (dist.files or [])
           if len(f.parts) >= 2 and f.parts[0].endswith(".dist-info") and _LICENSE_FILE.match(f.parts[-1])]
    return sorted(out, key=str)


def _license_summary(meta, texts) -> str:
    """一行授權名稱：License-Expression → License 欄第一行 → 分類 → 授權檔第一行。"""
    expr = (meta.get("License-Expression") or "").strip()
    if expr:
        return expr
    lic = (meta.get("License") or "").strip()
    if lic:
        return lic.splitlines()[0].strip()[:200]
    cls = [c.split("::")[-1].strip() for c in (meta.get_all("Classifier") or []) if c.startswith("License ::")]
    if cls:
        return "; ".join(cls)
    for t in texts:
        first = next((ln.strip() for ln in t.splitlines() if ln.strip()), "")
        if first and len(first) <= 80:
            return first + "（取自授權檔）"
    return "（metadata 未標示）"


def _mit_holder(meta, name) -> str:
    """MIT 版權聲明的權利人：Author 欄 → Author-email 的姓名部分 → 「<套件> authors」。"""
    author = (meta.get("Author") or "").strip()
    if author:
        return author
    email = (meta.get("Author-email") or "").strip()
    holder = re.sub(r"\s*<[^>]*>", "", email).strip().strip('"')
    return holder or "the %s authors" % name


# ── 實際打進 exe 的套件（L-5）─────────────────────────────────────────────
def _read_toc(path):
    """PyInstaller 的 *.toc 是 Python literal（pprint 輸出）；讀不到或格式不符回 None。"""
    try:
        return ast.literal_eval(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError, SyntaxError, MemoryError, UnicodeDecodeError):
        return None


def bundled_top_names(workdir=PYI_WORK):
    """實際打進 exe 的頂層名稱：PYZ-00.toc 的純 Python 模組，加 PKG-00.toc 的擴充模組（.pyd）、
    DLL、資料檔第一層資料夾與 *.dist-info。讀不到 PYZ-00.toc 回 None。"""
    workdir = Path(workdir)
    pyz = _read_toc(workdir / "PYZ-00.toc")           # (pyz 路徑, [(模組名, 來源, 'PYMODULE'), ...])
    if not (isinstance(pyz, tuple) and len(pyz) >= 2 and isinstance(pyz[1], list) and pyz[1]):
        return None
    names = {str(e[0]).split(".")[0] for e in pyz[1] if isinstance(e, (tuple, list)) and e}
    # PKG-00.toc：(pkg 路徑, {旗標}, [(目的路徑, 來源, 種類), ...], 'python312.dll', False, …, [], None…)
    # 清單在第 3 格、後面還跟著別的欄位（PyInstaller 6.10 實檔如此），取第一個非空清單，不能取最後一格
    pkg = _read_toc(workdir / "PKG-00.toc")
    entries = next((x for x in pkg if isinstance(x, list) and x), None) if isinstance(pkg, tuple) else None
    if entries:
        for e in entries:
            if not (isinstance(e, (tuple, list)) and len(e) >= 3) or e[2] in ("OPTION", "PYZ"):
                continue
            first = re.split(r"[\\/]", str(e[0]))[0]
            names.add(first if first.endswith(".dist-info") else first.split(".")[0])
    return names


def _top_levels(dist) -> set:
    """套件提供的頂層模組名；規則同 importlib.metadata.packages_distributions()
    （top_level.txt，沒有就從 RECORD 推），但只看傳進來的這個 site-packages。"""
    declared = (dist.read_text("top_level.txt") or "").split()
    if declared:
        return set(declared)
    out = set()
    for f in dist.files or []:
        out.add(f.parts[0] if len(f.parts) > 1 else (inspect.getmodulename(str(f)) or str(f)))
    return {n for n in out if "." not in n}


def bundled_distributions(dists, workdir=PYI_WORK):
    """{正規化名稱} 中實際打進 exe 的那些；讀不到 PyInstaller 分析結果回 None。"""
    tops = bundled_top_names(workdir)
    if tops is None:
        return None
    out = {key for key, d in dists.items() if tops & _top_levels(d)}
    for t in tops:                                  # collect_all 帶進去的 pywebview-5.4.dist-info 這類
        if t.endswith(".dist-info"):
            out.add(_norm_name(t[:-len(".dist-info")].rsplit("-", 1)[0]))
    return out & set(dists)


def _home(meta) -> str:
    if meta.get("Home-page"):
        return meta["Home-page"]
    for u in meta.get_all("Project-URL") or []:
        label, _, url = u.partition(",")
        if label.strip().lower() in ("homepage", "repository", "source", "sources", "source code"):
            return url.strip()
    return ""


def build_notices(site_packages=None, base_prefix=None, workdir=PYI_WORK):
    """產生 THIRD-PARTY-NOTICES.txt 全文（\\n 換行）。回傳 (text, warnings)。

    收：實際打進 exe 的套件（讀 workdir 的 PyInstaller 分析結果，見 bundled_distributions；
    讀不到才退回 build venv 全部 dist 扣掉 _BUILD_ONLY 並列入 warnings）的名稱、版本、授權與
    dist-info 內附的授權全文；Python 的 LICENSE.txt（sys.base_prefix 底下，含 Windows 版附帶的
    OpenSSL、libffi、bzip2、xz、zlib、Tcl/Tk 等條款）；PyInstaller bootloader 條款；
    pywebview 附帶 WebView2 DLL 時的 WebView2 SDK 授權。
    沒附授權全文、metadata 標 MIT 的套件，依 metadata 作者補上標準 MIT 全文；
    其他找不到授權全文的套件仍寫出 metadata 授權欄，並列入 warnings（build 輸出會印 WARN）。
    """
    dists = _distributions(site_packages)
    base_prefix = Path(base_prefix or sys.base_prefix)
    warnings = []
    sections = []   # (標題, 授權一行, 內文)
    bundled = bundled_distributions(dists, workdir) if workdir else None
    if bundled is None:
        bundled = set(dists) - _BUILD_ONLY
        warnings.append("讀不到 PyInstaller 分析結果（%s），改列 build venv 全部套件扣掉建置工具（可能多列）"
                        % (Path(workdir) / "PYZ-00.toc" if workdir else "未指定 workdir"))
    elif "pyinstaller" in bundled:
        warnings.append("exe 內含 PyInstaller 的 Python 模組（GPL，不在 bootloader 例外內）——"
                        "檢查 繫族.spec 的 excludes")

    # 1) Python 本體
    py_lic = next((p for p in (base_prefix / "LICENSE.txt", base_prefix / "LICENSE") if p.is_file()), None)
    pyver = platform.python_version()
    doc = "https://docs.python.org/%s/license.html" % ".".join(pyver.split(".")[:2])
    if py_lic:
        body = ("以下為建置用 Python 隨附的 %s 全文（含 Windows 版附帶元件，如 bzip2、libffi、\n"
                "OpenSSL 所用之 Apache-2.0 等條款）。Python 內含之其他元件的授權一覽：%s\n\n"
                % (py_lic.name, doc)) + _read(py_lic)
    else:
        body = "（建置時在 %s 找不到 LICENSE.txt；條款見 %s）" % (base_prefix, doc)
        warnings.append("找不到 Python 的 LICENSE.txt（%s）" % base_prefix)
    sections.append(("Python %s" % pyver, "PSF-2.0 與其附帶元件條款", body))

    # 2) PyInstaller bootloader：exe 開頭那段就是它；GPL 附 bootloader 例外，允許與本程式結合後散布
    pyi = dists.get("pyinstaller")
    pyi_texts = [_read(pyi.locate_file(f)) for f in _license_files(pyi)] if pyi else []
    if not pyi_texts:
        warnings.append("找不到 PyInstaller 的 COPYING.txt（bootloader 條款）")
    sections.append((
        "PyInstaller %s bootloader" % (pyi.version if pyi else "?"),
        "GPL-2.0-or-later with Bootloader Exception",
        "繫族.exe 以 PyInstaller 打包，exe 內含 PyInstaller 的 bootloader。bootloader 以 GPL 授權，\n"
        "但附有「Bootloader Exception」：允許把 bootloader 與其他程式結合後不受 GPL 限制地散布。\n"
        "The executable contains the PyInstaller bootloader, distributed under the GPL with the\n"
        "Bootloader Exception quoted below, which permits distributing it combined with this program.\n\n"
        + ("\n\n".join(pyi_texts) or "（授權全文見 https://github.com/pyinstaller/pyinstaller/blob/develop/COPYING.txt）")))

    # 3) WebView2 SDK（隨 pywebview 附帶的 DLL）
    pwv = dists.get("pywebview")
    dlls = sorted({f.parts[-1] for f in (pwv.files or []) if _WEBVIEW2_DLL.match(f.parts[-1])}) if pwv else []
    if dlls:
        sections.append(("Microsoft WebView2 SDK", "BSD-3-Clause style (Microsoft)",
                         "隨 pywebview 附帶的 DLL：%s\n\n" % "、".join(dlls) + _WEBVIEW2_LICENSE.strip("\n")))

    # 4) 其餘執行期套件（依名稱排序）
    for key in sorted(bundled):
        if key == "pyinstaller":       # bootloader 已在第 2 節；整包被打進去時上面已示警
            continue
        d = dists[key]
        meta = d.metadata
        files = _license_files(d)
        texts = [_read(d.locate_file(f)) for f in files]
        summary = _license_summary(meta, texts)
        head = ("Home: %s\n\n" % _home(meta)) if _home(meta) else ""
        if texts:
            body = "\n\n".join("[%s]\n%s" % (f.as_posix(), t) for f, t in zip(files, texts))
        elif re.fullmatch(r"(?i)mit(\s+license)?", summary.strip()):
            body = ("（此套件的 dist-info 沒有附授權全文；metadata 標示 MIT，以下依 metadata 的作者補上"
                    "標準 MIT 授權全文，年份 metadata 未載。）\n\n"
                    + _MIT_TEMPLATE.format(holder=_mit_holder(meta, meta["Name"])).strip("\n"))
        else:
            body = "（此套件的 dist-info 沒有附授權全文；授權欄為：%s）" % summary
            warnings.append("%s %s：dist-info 沒有授權全文，只寫出 metadata 授權欄（%s）"
                            % (meta["Name"], d.version, summary))
        sections.append(("%s %s" % (meta["Name"], d.version), summary, head + body))

    lines = [
        "繫族 KinLink — 第三方元件授權聲明（THIRD-PARTY NOTICES）",
        _RULE,
        "本檔於打包時自動產生（release/make_zip.py），列出 繫族.exe 內含的第三方元件及其授權全文。",
        "繫族 KinLink 本身以 MIT 授權釋出，見同一個 zip 內的 LICENSE。",
        "",
        "This file lists the third-party components bundled in 繫族.exe and their license texts.",
        "KinLink itself is released under the MIT License (see LICENSE).",
        "",
        "目錄 / Contents",
    ]
    for i, (title, lic, _b) in enumerate(sections, 1):
        lines.append("  %2d. %s — %s" % (i, title, lic))
    for i, (title, lic, body) in enumerate(sections, 1):
        lines += ["", "", _RULE, "%d. %s" % (i, title), "License: %s" % lic, _THIN, body]
    return "\n".join(lines) + "\n", warnings


def _read_version() -> str:
    return (ROOT / "VERSION").read_text(encoding="utf-8-sig").strip() or "0.0.0"


def make_release(exe=EXE, out_dir=None, version=None, site_packages=None, workdir=PYI_WORK) -> dict:
    """產出 zip 與 ASCII 檔名 exe，回傳 {"zip", "exe", "warnings"}（測試可傳臨時資料夾）。"""
    exe = Path(exe)
    out_dir = Path(out_dir) if out_dir else exe.parent
    version = version or _read_version()
    notices, warnings = build_notices(site_packages, workdir=workdir)
    if not LICENSE.exists():
        warnings.append("找不到專案根目錄的 LICENSE")
    for w in warnings:
        print("[make_zip] WARN: " + w)
    # 檔名用 ASCII：GitHub 會把 release 附件檔名裡的中文剝掉（「繫族-v…」會變「-v…」），
    # 直接叫 kinlink-v… 才能讓 build 產物＝release 附件同名。zip 裡面仍是 繫族.exe。
    base = "kinlink-v%s-win-x64" % version
    out = out_dir / (base + ".zip")
    if out.exists():
        out.unlink()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        z.write(exe, "繫族.exe")
        if README.exists():
            z.write(README, README.name)
        if LICENSE.exists():
            z.write(LICENSE, LICENSE.name)
        # CRLF：給 Windows 記事本開（與 先看我.txt 同）
        z.writestr(NOTICES_NAME, notices.replace("\n", "\r\n").encode("utf-8"))
    exe_out = out_dir / (base + ".exe")
    shutil.copyfile(exe, exe_out)
    return {"zip": out, "exe": exe_out, "warnings": warnings}


def main() -> int:
    if not EXE.exists():
        print("[make_zip] dist\\繫族.exe not found - build first")
        return 1
    r = make_release()
    for key in ("zip", "exe"):
        p = r[key]
        print("[make_zip] %s (%.1f MB)" % (p.name, p.stat().st_size / 1048576))
    return 0


if __name__ == "__main__":
    sys.exit(main())
