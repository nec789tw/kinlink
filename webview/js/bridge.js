/* ============================================================
   繫族 KinLink — 前端橋接層 bridge.js
   ------------------------------------------------------------
   提供 window.KinAPI：前端各視圖（app.js）統一透過它存取後端，
   不直接 fetch、不直接接觸 mock 資料。

   雙傳輸模式（仿參考 bridge.js）：
     - web ：頁面以 http(s):// 開啟（有本機後端）→ fetch /api/*
     - mock：頁面以 file:// 開啟，或本機後端探活失敗 → 回「楊家虛構示範資料」
             讓 index.html 直接雙擊 file:// 開啟即可完全互動預覽。

   另附極簡事件匯流排（event bus）：KinAPI.on/off/emit，
   供日後 SSE 進度推送或跨視圖通知共用（mock 模式為純前端廣播）。

   設計原則：零相依、純 ES5 寫法（相容舊 WebView2／Edge）、全程繁體中文註解。
   嚴禁真實個資：示範人物、活動、地點皆為虛構，避開任何真實本名。
   ============================================================ */
(function (global) {
  'use strict';

  /* ========================================================
     一、傳輸偵測（transport）
     - file://（或非 http 協定）一律 mock。
     - http(s):// 先暫定 web；實際送出請求前以 /api/state 探活，
       探活失敗（無後端）則自動降級為 mock，使設計稿離線可預覽。
     ======================================================== */
  var IS_HTTP = /^https?:$/i.test(global.location && global.location.protocol);
  var transport = IS_HTTP ? 'web' : 'mock';   // 'web' | 'mock'
  var probed = false;                         // 是否已對後端探活過

  /* API 前綴；若後端帶隨機 token（?k=），可由網址帶入後沿用 */
  var API_BASE = 'api';
  var TOKEN = (function () {
    try {
      var m = (global.location.search || '').match(/[?&]k=([^&]+)/);
      return m ? decodeURIComponent(m[1]) : '';
    } catch (e) { return ''; }
  })();

  /* 將路徑組成完整 /api URL，必要時附帶 token 查詢參數 */
  function apiUrl(path, query) {
    var url = '/' + API_BASE + path;
    var qs = [];
    if (query) {
      for (var k in query) {
        if (query[k] === undefined || query[k] === null || query[k] === '') continue;
        qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(query[k]));
      }
    }
    if (TOKEN) qs.push('k=' + encodeURIComponent(TOKEN));
    if (qs.length) url += '?' + qs.join('&');
    return url;
  }

  /* 統一 fetch 包裝：自動帶 token（Bearer）、JSON 解析、錯誤拋出 */
  function httpFetch(method, path, opts) {
    opts = opts || {};
    var headers = {};
    if (TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;
    var init = { method: method, headers: headers };

    if (opts.body !== undefined && global.Blob && opts.body instanceof global.Blob) {
      headers['Content-Type'] = 'application/octet-stream';   // 檔案原始 bytes（如還原備份上傳）
      init.body = opts.body;
    } else if (opts.body !== undefined && !(opts.body instanceof global.FormData)) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    } else if (opts.body instanceof global.FormData) {
      init.body = opts.body;  // multipart，瀏覽器自帶 boundary，勿手動設 Content-Type
    }

    return global.fetch(apiUrl(path, opts.query), init).then(function (res) {
      if (opts.raw) return res;               // 需要原始 Response（如下載 Blob）
      if (!res.ok) {
        return res.text().then(function (txt) {
          var msg = txt;
          try { msg = (JSON.parse(txt).error || {}).message || txt; } catch (e) {}
          throw new Error('API ' + res.status + '：' + (msg || method + ' ' + path));
        });
      }
      var ct = res.headers.get('content-type') || '';
      return ct.indexOf('application/json') >= 0 ? res.json() : res.text();
    });
  }

  /* mock 判定廣播（首次使用）：ensureTransport 確定走 mock 後，
     以 'transport/mock' 事件通知前端顯示「展示模式」常駐橫幅。
     只發一次；用 setTimeout 脫離當前呼叫堆疊，確保 app.js（於本檔之後
     載入）已完成事件訂閱，file:// 直開也不漏接。 */
  var mockAnnounced = false;
  function announceMock() {
    if (mockAnnounced || transport !== 'mock') return;
    mockAnnounced = true;
    global.setTimeout(function () { emit('transport/mock', { transport: 'mock' }); }, 0);
  }

  /* 探活：http 模式下第一次呼叫前先打 /api/state，失敗則降級 mock。
     回傳 Promise<boolean>（true 表示確實有 web 後端）。 */
  function ensureTransport() {
    if (transport === 'mock' || probed) {
      announceMock();
      return Promise.resolve(transport === 'web');
    }
    probed = true;
    return global.fetch(apiUrl('/state'), { method: 'GET' })
      .then(function (res) { if (!res.ok) throw 0; return true; })
      .catch(function () { transport = 'mock'; announceMock(); return false; });
  }

  /* ========================================================
     二、事件匯流排（event bus）
     KinAPI.on(evt, cb) / off(evt, cb) / emit(evt, payload)
     - mock 模式：純前端廣播（如 lock/unlock、member/changed）。
     - web 模式：可由日後的 SSE 連線將後端事件 emit 進來共用。
     ======================================================== */
  var listeners = {};
  function on(evt, cb) {
    (listeners[evt] = listeners[evt] || []).push(cb);
    return function () { off(evt, cb); };   // 回傳解除訂閱函式
  }
  function off(evt, cb) {
    var arr = listeners[evt]; if (!arr) return;
    for (var i = arr.length - 1; i >= 0; i--) if (arr[i] === cb) arr.splice(i, 1);
  }
  function emit(evt, payload) {
    var arr = (listeners[evt] || []).slice();   // 複製，避免回呼內退訂造成跳號
    for (var i = 0; i < arr.length; i++) {
      try { arr[i](payload); } catch (e) { /* 單一訂閱者出錯不影響其他 */ }
    }
  }

  /* ========================================================
     三、楊家虛構示範資料（mock dataset）
     - 與 index.html／app.js 既有示範一致：始遷祖楊立宗 → 長/次/三房。
     - 全為虛構姓名，嚴禁真實個資。
     - members 為「扁平陣列」，符合 GET /api/members 契約欄位；
       親子關係另存於 RELS（parent→child），由 getMember 即時組裝。
     ======================================================== */

  /* 成員主檔（扁平）。欄位對應 GET /api/members 回傳：
     id,name,styleName,gen,branch,fatherName,fatherId,spouseOfId,
     gender,alive,birth,death,label */
  var MEMBERS = [
    // 第一代 始遷祖
    { id: 1,  name: '楊立宗', styleName: '承遠', gen: 1, branch: '本宗', gender: 'M', alive: false,
      birth: '1901-02-14', death: '1978-09-03', fatherId: null,
      birthOriginal: '辛丑年臘月廿六', deathOriginal: '戊午年八月初一',
      phone: '', city: '彰化員村祖厝', burial: '員村公墓 · 祖塋甲區 12 號' },

    // 第二代
    { id: 2,  name: '楊敬山', styleName: '立之', gen: 2, branch: '長房', gender: 'M', alive: false,
      birth: '1928-06-08', death: '2004-11-19', fatherId: 1,
      birthOriginal: '戊辰年閏四月廿一', deathOriginal: '甲申年十月初八',
      phone: '', city: '台中北屯', burial: '大坑示範墓園 · 蓮華區 7-3' },
    { id: 3,  name: '楊敬泉', styleName: '澤民', gen: 2, branch: '次房', gender: 'M', alive: false,
      birth: '1931-10-17', death: '2011-02-26', fatherId: 1,
      birthOriginal: '辛未年九月初七', deathOriginal: '辛卯年正月廿四',
      phone: '', city: '高雄鳳山', burial: '鳳山覆鼎金 · 慈恩區 21 號' },
    { id: 4,  name: '楊敬蘭', styleName: '', gen: 2, branch: '三房', gender: 'F', alive: false,
      birth: '1934-04-02', death: '1996-08-14', fatherId: 1,
      birthOriginal: '甲戌年二月十九', deathOriginal: '丙子年七月初一',
      phone: '', city: '嘉義水上', burial: '水上龍隱寺 · 思親堂 永字 308' },

    // 第三代（postalCode 為虛構示範郵遞區號，供信封片頭／通函預覽）
    { id: 5,  name: '楊文柏', styleName: '守一', gen: 3, branch: '長房', gender: 'M', alive: true,
      birth: '1955-03-22', death: null, fatherId: 2,
      birthOriginal: '乙未年二月廿九', deathOriginal: '',
      phone: '0921-xxx-118', city: '台中市北屯區', postalCode: '406', burial: '' },
    { id: 6,  name: '楊雅芬', styleName: '', gen: 3, branch: '長房', gender: 'F', alive: true,
      birth: '1958-07-05', death: null, fatherId: 2,
      birthOriginal: '戊戌年五月二十', deathOriginal: '',
      phone: '0910-xxx-744', city: '台中市西屯區', postalCode: '407', burial: '' },
    { id: 7,  name: '楊文凱', styleName: '安瀾', gen: 3, branch: '次房', gender: 'M', alive: true,
      birth: '1960-01-09', death: null, fatherId: 3,
      birthOriginal: '己亥年臘月十一', deathOriginal: '',
      phone: '0928-xxx-639', city: '高雄市鳳山區', postalCode: '830', burial: '' },
    { id: 8,  name: '楊曉嵐', styleName: '', gen: 3, branch: '三房', gender: 'F', alive: true,
      birth: '1963-09-27', death: null, fatherId: 4,
      birthOriginal: '癸卯年八月初十', deathOriginal: '',
      phone: '0918-xxx-455', city: '嘉義市西區', postalCode: '600', burial: '' },

    // 第四代
    { id: 9,  name: '楊志謙', styleName: '', gen: 4, branch: '長房', gender: 'M', alive: true,
      birth: '1986-08-30', death: null, fatherId: 5,
      birthOriginal: '丙寅年七月廿五', deathOriginal: '',
      phone: '0933-xxx-507', city: '台北市內湖區', postalCode: '114', burial: '' },
    { id: 10, name: '楊湘怡', styleName: '', gen: 4, branch: '長房', gender: 'F', alive: true,
      birth: '1989-12-11', death: null, fatherId: 5,
      birthOriginal: '己巳年冬月十四', deathOriginal: '',
      phone: '0955-xxx-260', city: '新竹市東區', postalCode: '300', burial: '' },
    { id: 11, name: '楊宥廷', styleName: '', gen: 4, branch: '次房', gender: 'M', alive: true,
      birth: '1992-05-18', death: null, fatherId: 7,
      birthOriginal: '壬申年四月十七', deathOriginal: '',
      phone: '0987-xxx-301', city: '台南市東區', postalCode: '701', burial: '' }
  ];

  /* 配偶關係（虛構示範；以 id 互指）。供 getMember.spouses 組裝。 */
  var MARRIAGES = [
    { id: 1, a: 5, b: null, spouseName: '林淑梅', status: 'MARRIED' }, // 楊文柏 之配偶（外姓，未建主檔，僅示範）
    { id: 2, a: 7, b: null, spouseName: '陳秀英', status: 'MARRIED' }  // 楊文凱 之配偶
  ];

  /* 額外親邊（mock 記憶體版，對齊 relationships 表；規格 §4.1 雙軌制）：
     fatherId 仍是「男性親生父」單一真實來源（樹狀圖沿它組樹）；
     其餘親邊（母、過繼/收養之嗣父母）存於此，供 addParent/removeParent 與
     getMember.parents 組裝。格式 { parentId, childId, relationType }。 */
  var EXTRA_PARENTS = [];

  /* 自 fatherId 推導「父名」與「同名識別標籤 label」 */
  /* 1..99 → 中文數字（與後端 members._cn_num、app.js genCn 同規則） */
  function cnNum(n) {
    n = Number(n) || 0;
    if (n <= 0 || n > 99) return String(n);
    var D = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
    if (n < 10) return D[n];
    var t = Math.floor(n / 10), o = n % 10;
    return (t === 1 ? '十' : D[t] + '十') + D[o];
  }
  function memberById(id) {
    for (var i = 0; i < MEMBERS.length; i++) if (MEMBERS[i].id === id) return MEMBERS[i];
    return null;
  }
  function fatherNameOf(m) {
    var f = m.fatherId ? memberById(m.fatherId) : null;
    return f ? f.name : '';
  }
  /* 同名同姓防呆識別標籤（規格 §4.3，與後端 server.py _label 同格式）：
     世代·房·父名-姓名（缺欄優雅留空）。
     例：「第三世·長房·楊敬山-楊文柏」、「第一世-楊立宗」。 */
  function labelOf(m) {
    var bits = [];
    bits.push('第' + cnNum(m.gen) + '世');
    if (m.branch && m.branch !== '本宗') bits.push(m.branch);
    var fn = fatherNameOf(m);
    if (fn) bits.push(fn);
    return bits.join('·') + '-' + m.name;
  }

  /* 收集某成員的全部後代 id（fatherId ＋ EXTRA_PARENTS 兩類下行邊皆納入）。
     供 addParent 防環：與 web 後端 _descendant_ids 同精神的保守超集合。 */
  function mockDescendants(rootId) {
    var out = {}, queue = [rootId], guard = 0;
    while (queue.length && guard++ < 10000) {
      var pid = queue.pop();
      for (var i = 0; i < MEMBERS.length; i++) {
        if (MEMBERS[i].fatherId === pid && !out[MEMBERS[i].id]) {
          out[MEMBERS[i].id] = true; queue.push(MEMBERS[i].id);
        }
      }
      for (var j = 0; j < EXTRA_PARENTS.length; j++) {
        var ep = EXTRA_PARENTS[j];
        if (ep.parentId === pid && !out[ep.childId]) {
          out[ep.childId] = true; queue.push(ep.childId);
        }
      }
    }
    return out;
  }

  /* 首位「同為主檔成員」的配偶 id（外姓僅名配偶回 null）；對齊 web 後端 spouseOfId */
  function spouseIdOf(m) {
    for (var i = 0; i < MARRIAGES.length; i++) {
      var mg = MARRIAGES[i];
      if (mg.a === m.id && mg.b != null) return mg.b;
      if (mg.b === m.id && mg.a != null) return mg.a;
    }
    return null;
  }

  /* 將內部成員物件投影成 GET /api/members 契約形狀
     （fatherId／spouseOfId 與 web 後端 _project_member 對齊：
      app.js buildForest 以此組樹，file:// 預覽才能呈現真實層級） */
  function projectMember(m) {
    return {
      id: m.id, name: m.name, styleName: m.styleName || '', gen: m.gen,
      branch: m.branch || '', fatherName: fatherNameOf(m),
      fatherId: m.fatherId || null, spouseOfId: spouseIdOf(m),
      gender: m.gender,
      alive: !!m.alive, birth: m.birth || '', death: m.death || '',
      phone: m.phone || '', address: m.city || '', postalCode: m.postalCode || '',
      label: labelOf(m)
    };
  }

  /* GET /api/member/{id} 詳細：含 parents / spouses / children。
     parents 每項帶 relationType（雙軌制：親生/過繼/收養），與 web 後端契約一致。 */
  function projectDetail(m) {
    var parents = [];
    if (m.fatherId) {
      var f = memberById(m.fatherId);
      if (f) parents.push({ id: f.id, name: f.name, relation: '父', relationType: 'BIOLOGICAL' });
    }
    for (var pi = 0; pi < EXTRA_PARENTS.length; pi++) {
      var ep = EXTRA_PARENTS[pi];
      if (ep.childId !== m.id) continue;
      var pm = memberById(ep.parentId);
      if (!pm) continue;
      parents.push({
        id: pm.id, name: pm.name,
        relation: pm.gender === 'F' ? '母' : '父',
        relationType: ep.relationType || 'BIOLOGICAL'
      });
    }
    var spouses = [];
    for (var i = 0; i < MARRIAGES.length; i++) {
      var mg = MARRIAGES[i];
      if (mg.a === m.id || mg.b === m.id) {
        var otherId = mg.a === m.id ? mg.b : mg.a;
        var other = otherId ? memberById(otherId) : null;
        spouses.push({
          id: other ? other.id : null,
          name: other ? other.name : (mg.spouseName || '（外姓配偶）'),
          status: mg.status
        });
      }
    }
    var children = [];
    var childSeen = {};
    for (var j = 0; j < MEMBERS.length; j++) {
      if (MEMBERS[j].fatherId === m.id) {
        childSeen[MEMBERS[j].id] = true;
        children.push({ id: MEMBERS[j].id, name: MEMBERS[j].name, gen: MEMBERS[j].gen });
      }
    }
    for (var ci = 0; ci < EXTRA_PARENTS.length; ci++) {
      var ec = EXTRA_PARENTS[ci];
      if (ec.parentId !== m.id || childSeen[ec.childId]) continue;
      var cm = memberById(ec.childId);
      if (cm) { childSeen[cm.id] = true; children.push({ id: cm.id, name: cm.name, gen: cm.gen }); }
    }
    return {
      id: m.id, name: m.name, styleName: m.styleName || '', gen: m.gen,
      branch: m.branch || '', fatherName: fatherNameOf(m), gender: m.gender,
      alive: !!m.alive, birth: m.birth || '', death: m.death || '',
      birthOriginal: m.birthOriginal || '', deathOriginal: m.deathOriginal || '',
      phone: m.phone || '', city: m.city || '', postalCode: m.postalCode || '',
      burial: m.burial || '', burialType: m.burialType || '', burialCode: m.burialCode || '',
      burialDesc: m.burial || '',   // 後端 get_member 組好的安葬描述；mock 直接沿用 burial
      note: m.note || '', mailTarget: !!m.mailTarget,   // 表單快照會讀這幾欄：少了會把「沒改」誤判成「有改」
      customKin: m.customKin || '',   // R4 家族習慣稱呼（稱謂覆寫）
      label: labelOf(m), parents: parents, spouses: spouses, children: children
    };
  }

  /* 稱謂計算（mock）：以始遷祖為根，用「向上到共同祖先」的世系路徑生成
     雙向稱謂。涵蓋本族示範常見關係，罕見關係優雅降級為描述世系路徑。 */
  function pathToRoot(m) {            // 回傳由自己往上到始祖的 id 陣列
    var chain = [], cur = m;
    while (cur) { chain.push(cur.id); cur = cur.fatherId ? memberById(cur.fatherId) : null; }
    return chain;
  }
  /* 夫妻直判（對齊真機 kinship.py 的 _kin_married＋kinship 開頭）：同一對有多筆時以未離異的為準；
     離異稱「前妻／前夫」（真機體檢 domain-6 已改，mock 原本仍回妻子／丈夫——第二批驗證員）；
     性別空白退回「配偶／前配偶」。沒有婚姻邊回 null。 */
  function marriageKin(A, B) {
    var st = null;
    for (var i = 0; i < MARRIAGES.length; i++) {
      var mg = MARRIAGES[i];
      if ((mg.a === A.id && mg.b === B.id) || (mg.a === B.id && mg.b === A.id)) {
        var s = String(mg.status || 'MARRIED').toUpperCase();
        if (st === null || st === 'DIVORCED') st = s;
      }
    }
    if (st === null) return null;
    var div = st === 'DIVORCED';
    function term(m) {
      if (m.gender === 'F') return div ? '前妻' : '妻子';
      if (m.gender === 'M') return div ? '前夫' : '丈夫';
      return div ? '前配偶' : '配偶';
    }
    return { forward: term(B), backward: term(A),
             path: div ? '兩位曾為夫妻，婚姻狀態為離異。' : '兩位為夫妻（婚姻關係）。' };
  }
  /* 示範家族的稱謂一律照正式版（kinlink/kinship.py）預先算好（2026-10-12 官網截圖抓到：下面的簡化演算
     把姑表算成堂親、叔公算成族親、叔伯不分、說明差一代——展示的就該是 exe 真正算出來的）。
     由 tests/test_l4b_mock_kinship_table.py --write 產生，勿手改；那支測試也守著它跟正式版一致。
     示範家族的性別／生日／父母／婚姻在展示模式被改過，就不再用這張表，退回下面的簡化演算。 */
  // >>> KIN_TABLE
  var KIN_TABLE = {
    "1,2": ["兒子", "父親", "目標是你的直系卑親（下傳 1 代）。"],
    "1,3": ["兒子", "父親", "目標是你的直系卑親（下傳 1 代）。"],
    "1,4": ["女兒", "父親", "目標是你的直系卑親（下傳 1 代）。"],
    "1,5": ["孫子", "祖父", "目標是你的直系卑親（下傳 2 代）。"],
    "1,6": ["孫女", "祖父", "目標是你的直系卑親（下傳 2 代）。"],
    "1,7": ["孫子", "祖父", "目標是你的直系卑親（下傳 2 代）。"],
    "1,8": ["外孫女", "外公", "經母親「楊敬蘭」橋接：目標是你的直系卑親（下傳 1 代）。"],
    "1,9": ["曾孫", "曾祖父", "目標是你的直系卑親（下傳 3 代）。"],
    "1,10": ["曾孫女", "曾祖父", "目標是你的直系卑親（下傳 3 代）。"],
    "1,11": ["曾孫", "曾祖父", "目標是你的直系卑親（下傳 3 代）。"],
    "2,1": ["父親", "兒子", "目標是你的直系尊親（上溯 1 代）。"],
    "2,3": ["弟弟", "哥哥", "目標是你的同胞手足。"],
    "2,4": ["妹妹", "哥哥", "目標是你的同胞手足。"],
    "2,5": ["兒子", "父親", "目標是你的直系卑親（下傳 1 代）。"],
    "2,6": ["女兒", "父親", "目標是你的直系卑親（下傳 1 代）。"],
    "2,7": ["姪子", "伯父", "共同祖先：楊立宗（第1世）；對方為您低 1 世之同宗晚輩 → 姪子。"],
    "2,8": ["外甥女", "舅舅", "經母親「楊敬蘭」橋接：目標是你的同胞手足。"],
    "2,9": ["孫子", "祖父", "目標是你的直系卑親（下傳 2 代）。"],
    "2,10": ["孫女", "祖父", "目標是你的直系卑親（下傳 2 代）。"],
    "2,11": ["姪孫", "伯公", "共同祖先：楊立宗（第1世）；對方為您低 2 世之同宗晚輩 → 姪孫。"],
    "3,1": ["父親", "兒子", "目標是你的直系尊親（上溯 1 代）。"],
    "3,2": ["哥哥", "弟弟", "目標是你的同胞手足。"],
    "3,4": ["妹妹", "哥哥", "目標是你的同胞手足。"],
    "3,5": ["姪子", "叔叔", "共同祖先：楊立宗（第1世）；對方為您低 1 世之同宗晚輩 → 姪子。"],
    "3,6": ["姪女", "叔叔", "共同祖先：楊立宗（第1世）；對方為您低 1 世之同宗晚輩 → 姪女。"],
    "3,7": ["兒子", "父親", "目標是你的直系卑親（下傳 1 代）。"],
    "3,8": ["外甥女", "舅舅", "經母親「楊敬蘭」橋接：目標是你的同胞手足。"],
    "3,9": ["姪孫", "叔公", "共同祖先：楊立宗（第1世）；對方為您低 2 世之同宗晚輩 → 姪孫。"],
    "3,10": ["姪孫女", "叔公", "共同祖先：楊立宗（第1世）；對方為您低 2 世之同宗晚輩 → 姪孫女。"],
    "3,11": ["孫子", "祖父", "目標是你的直系卑親（下傳 2 代）。"],
    "4,1": ["父親", "女兒", "目標是你的直系尊親（上溯 1 代）。"],
    "4,2": ["哥哥", "妹妹", "目標是你的同胞手足。"],
    "4,3": ["哥哥", "妹妹", "目標是你的同胞手足。"],
    "4,5": ["姪子", "姑姑", "共同祖先：楊立宗（第1世）；對方為您低 1 世之同宗晚輩 → 姪子。"],
    "4,6": ["姪女", "姑姑", "共同祖先：楊立宗（第1世）；對方為您低 1 世之同宗晚輩 → 姪女。"],
    "4,7": ["姪子", "姑姑", "共同祖先：楊立宗（第1世）；對方為您低 1 世之同宗晚輩 → 姪子。"],
    "4,8": ["女兒", "母親", "目標是你的子女（母系親邊）。"],
    "4,9": ["姪孫", "姑婆", "共同祖先：楊立宗（第1世）；對方為您低 2 世之同宗晚輩 → 姪孫。"],
    "4,10": ["姪孫女", "姑婆", "共同祖先：楊立宗（第1世）；對方為您低 2 世之同宗晚輩 → 姪孫女。"],
    "4,11": ["姪孫", "姑婆", "共同祖先：楊立宗（第1世）；對方為您低 2 世之同宗晚輩 → 姪孫。"],
    "5,1": ["祖父", "孫子", "目標是你的直系尊親（上溯 2 代）。"],
    "5,2": ["父親", "兒子", "目標是你的直系尊親（上溯 1 代）。"],
    "5,3": ["叔叔", "姪子", "共同祖先：楊立宗（第1世）；對方為您高 1 世之同宗尊長 → 叔叔。"],
    "5,4": ["姑姑", "姪子", "共同祖先：楊立宗（第1世）；對方為您高 1 世之同宗尊長 → 姑姑。"],
    "5,6": ["妹妹", "哥哥", "目標是你的同胞手足。"],
    "5,7": ["堂弟", "堂兄", "目標是你的堂親（同祖父系祖先、不同父）。"],
    "5,8": ["表妹", "表哥", "經母親「楊敬蘭」橋接：共同祖先：楊立宗（第1世）；對方為您高 1 世之同宗尊長 → 姑姑。"],
    "5,9": ["兒子", "父親", "目標是你的直系卑親（下傳 1 代）。"],
    "5,10": ["女兒", "父親", "目標是你的直系卑親（下傳 1 代）。"],
    "5,11": ["姪子", "伯父", "共同祖先：楊立宗（第1世）；對方為您低 1 世之同宗晚輩 → 姪子。"],
    "6,1": ["祖父", "孫女", "目標是你的直系尊親（上溯 2 代）。"],
    "6,2": ["父親", "女兒", "目標是你的直系尊親（上溯 1 代）。"],
    "6,3": ["叔叔", "姪女", "共同祖先：楊立宗（第1世）；對方為您高 1 世之同宗尊長 → 叔叔。"],
    "6,4": ["姑姑", "姪女", "共同祖先：楊立宗（第1世）；對方為您高 1 世之同宗尊長 → 姑姑。"],
    "6,5": ["哥哥", "妹妹", "目標是你的同胞手足。"],
    "6,7": ["堂弟", "堂姊", "目標是你的堂親（同祖父系祖先、不同父）。"],
    "6,8": ["表妹", "表姊", "經母親「楊敬蘭」橋接：共同祖先：楊立宗（第1世）；對方為您高 1 世之同宗尊長 → 姑姑。"],
    "6,9": ["姪子", "姑姑", "共同祖先：楊敬山（第2世）；對方為您低 1 世之同宗晚輩 → 姪子。"],
    "6,10": ["姪女", "姑姑", "共同祖先：楊敬山（第2世）；對方為您低 1 世之同宗晚輩 → 姪女。"],
    "6,11": ["姪子", "姑姑", "共同祖先：楊立宗（第1世）；對方為您低 1 世之同宗晚輩 → 姪子。"],
    "7,1": ["祖父", "孫子", "目標是你的直系尊親（上溯 2 代）。"],
    "7,2": ["伯父", "姪子", "共同祖先：楊立宗（第1世）；對方為您高 1 世之同宗尊長 → 伯父。"],
    "7,3": ["父親", "兒子", "目標是你的直系尊親（上溯 1 代）。"],
    "7,4": ["姑姑", "姪子", "共同祖先：楊立宗（第1世）；對方為您高 1 世之同宗尊長 → 姑姑。"],
    "7,5": ["堂兄", "堂弟", "目標是你的堂親（同祖父系祖先、不同父）。"],
    "7,6": ["堂姊", "堂弟", "目標是你的堂親（同祖父系祖先、不同父）。"],
    "7,8": ["表妹", "表哥", "經母親「楊敬蘭」橋接：共同祖先：楊立宗（第1世）；對方為您高 1 世之同宗尊長 → 姑姑。"],
    "7,9": ["姪子", "叔叔", "共同祖先：楊立宗（第1世）；對方為您低 1 世之同宗晚輩 → 姪子。"],
    "7,10": ["姪女", "叔叔", "共同祖先：楊立宗（第1世）；對方為您低 1 世之同宗晚輩 → 姪女。"],
    "7,11": ["兒子", "父親", "目標是你的直系卑親（下傳 1 代）。"],
    "8,1": ["外公", "外孫女", "經母親「楊敬蘭」橋接：目標是你的直系尊親（上溯 1 代）。"],
    "8,2": ["舅舅", "外甥女", "經母親「楊敬蘭」橋接：目標是你的同胞手足。"],
    "8,3": ["舅舅", "外甥女", "經母親「楊敬蘭」橋接：目標是你的同胞手足。"],
    "8,4": ["母親", "女兒", "目標是你的母親（母系親邊）。"],
    "8,5": ["表哥", "表妹", "經母親「楊敬蘭」橋接：共同祖先：楊立宗（第1世）；對方為您低 1 世之同宗晚輩 → 姪子。"],
    "8,6": ["表姊", "表妹", "經母親「楊敬蘭」橋接：共同祖先：楊立宗（第1世）；對方為您低 1 世之同宗晚輩 → 姪女。"],
    "8,7": ["表哥", "表妹", "經母親「楊敬蘭」橋接：共同祖先：楊立宗（第1世）；對方為您低 1 世之同宗晚輩 → 姪子。"],
    "8,9": ["族親", "族親", "兩位在現有族譜中找不到共同父系祖先（可能一方為姻親、或父系資料待補）。可先在族譜頁各自往上核對世系，補齊父親或母親後再計算。"],
    "8,10": ["族親", "族親", "兩位在現有族譜中找不到共同父系祖先（可能一方為姻親、或父系資料待補）。可先在族譜頁各自往上核對世系，補齊父親或母親後再計算。"],
    "8,11": ["族親", "族親", "兩位在現有族譜中找不到共同父系祖先（可能一方為姻親、或父系資料待補）。可先在族譜頁各自往上核對世系，補齊父親或母親後再計算。"],
    "9,1": ["曾祖父", "曾孫", "目標是你的直系尊親（上溯 3 代）。"],
    "9,2": ["祖父", "孫子", "目標是你的直系尊親（上溯 2 代）。"],
    "9,3": ["叔公", "姪孫", "共同祖先：楊立宗（第1世）；對方為您高 2 世之同宗尊長 → 叔公。"],
    "9,4": ["姑婆", "姪孫", "共同祖先：楊立宗（第1世）；對方為您高 2 世之同宗尊長 → 姑婆。"],
    "9,5": ["父親", "兒子", "目標是你的直系尊親（上溯 1 代）。"],
    "9,6": ["姑姑", "姪子", "共同祖先：楊敬山（第2世）；對方為您高 1 世之同宗尊長 → 姑姑。"],
    "9,7": ["叔叔", "姪子", "共同祖先：楊立宗（第1世）；對方為您高 1 世之同宗尊長 → 叔叔。"],
    "9,8": ["族親", "族親", "兩位在現有族譜中找不到共同父系祖先（可能一方為姻親、或父系資料待補）。可先在族譜頁各自往上核對世系，補齊父親或母親後再計算。"],
    "9,10": ["妹妹", "哥哥", "目標是你的同胞手足。"],
    "9,11": ["族弟", "族兄", "共同祖先：楊立宗（第1世）；同世代之遠房宗親（各上溯 3 代）。"],
    "10,1": ["曾祖父", "曾孫女", "目標是你的直系尊親（上溯 3 代）。"],
    "10,2": ["祖父", "孫女", "目標是你的直系尊親（上溯 2 代）。"],
    "10,3": ["叔公", "姪孫女", "共同祖先：楊立宗（第1世）；對方為您高 2 世之同宗尊長 → 叔公。"],
    "10,4": ["姑婆", "姪孫女", "共同祖先：楊立宗（第1世）；對方為您高 2 世之同宗尊長 → 姑婆。"],
    "10,5": ["父親", "女兒", "目標是你的直系尊親（上溯 1 代）。"],
    "10,6": ["姑姑", "姪女", "共同祖先：楊敬山（第2世）；對方為您高 1 世之同宗尊長 → 姑姑。"],
    "10,7": ["叔叔", "姪女", "共同祖先：楊立宗（第1世）；對方為您高 1 世之同宗尊長 → 叔叔。"],
    "10,8": ["族親", "族親", "兩位在現有族譜中找不到共同父系祖先（可能一方為姻親、或父系資料待補）。可先在族譜頁各自往上核對世系，補齊父親或母親後再計算。"],
    "10,9": ["哥哥", "妹妹", "目標是你的同胞手足。"],
    "10,11": ["族弟", "族姊", "共同祖先：楊立宗（第1世）；同世代之遠房宗親（各上溯 3 代）。"],
    "11,1": ["曾祖父", "曾孫", "目標是你的直系尊親（上溯 3 代）。"],
    "11,2": ["伯公", "姪孫", "共同祖先：楊立宗（第1世）；對方為您高 2 世之同宗尊長 → 伯公。"],
    "11,3": ["祖父", "孫子", "目標是你的直系尊親（上溯 2 代）。"],
    "11,4": ["姑婆", "姪孫", "共同祖先：楊立宗（第1世）；對方為您高 2 世之同宗尊長 → 姑婆。"],
    "11,5": ["伯父", "姪子", "共同祖先：楊立宗（第1世）；對方為您高 1 世之同宗尊長 → 伯父。"],
    "11,6": ["姑姑", "姪子", "共同祖先：楊立宗（第1世）；對方為您高 1 世之同宗尊長 → 姑姑。"],
    "11,7": ["父親", "兒子", "目標是你的直系尊親（上溯 1 代）。"],
    "11,8": ["族親", "族親", "兩位在現有族譜中找不到共同父系祖先（可能一方為姻親、或父系資料待補）。可先在族譜頁各自往上核對世系，補齊父親或母親後再計算。"],
    "11,9": ["族兄", "族弟", "共同祖先：楊立宗（第1世）；同世代之遠房宗親（各上溯 3 代）。"],
    "11,10": ["族姊", "族弟", "共同祖先：楊立宗（第1世）；同世代之遠房宗親（各上溯 3 代）。"],
  };
  // <<< KIN_TABLE
  function kinSnap() {
    var ids = {}, out = [];
    for (var k in KIN_TABLE) { var p = k.split(','); ids[p[0]] = 1; ids[p[1]] = 1; }
    MEMBERS.forEach(function (m) { if (ids[m.id]) out.push([m.id, m.gender, m.birth || '', m.fatherId || 0]); });
    EXTRA_PARENTS.forEach(function (e) { if (ids[e.childId] || ids[e.parentId]) out.push(['p', e.parentId, e.childId, e.relationType]); });
    MARRIAGES.forEach(function (g) { if (ids[g.a] || ids[g.b]) out.push(['g', g.a, g.b, g.status]); });
    return JSON.stringify(out);
  }
  var KIN_SNAP = kinSnap();
  // 長幼判不出 → 雙向「族親」（同真機 kinlink/kinship.py 的 _unknown_elder；guessed 讓批次稱謂留空）
  function unknownElder(path) {
    return { forward: '族親', backward: '族親', guessed: true,
             path: path + '但雙方生年未載、長幼無從判定，以族親相稱。' };
  }
  function kinshipCalc(fromId, toId) {
    var A = memberById(fromId), B = memberById(toId);
    if (!A || !B) return { forward: '—', backward: '—', path: '查無此成員。' };
    if (A.id === B.id) return { forward: '本人', backward: '本人', path: '主體與目標為同一人。' };
    var t = KIN_TABLE[A.id + ',' + B.id];          // 每次回新物件：呼叫端會改 forward（家族習慣稱呼）
    if (t && kinSnap() === KIN_SNAP) return { forward: t[0], backward: t[1], path: t[2], guessed: !!t[3] };

    var pa = pathToRoot(A), pb = pathToRoot(B);
    // 找最近共同祖先 LCA
    var lca = null, da = 0, db = 0;
    for (var i = 0; i < pa.length; i++) {
      var idx = pb.indexOf(pa[i]);
      if (idx >= 0) { lca = pa[i]; da = i; db = idx; break; }
    }
    if (lca === null) {
      return { forward: '族親', backward: '族親', path: '兩位於示範族譜中同宗，惟未共祖先，請展開族譜核對。' };
    }

    // 直系（其中一方就是另一方的祖先）
    if (lca === B.id) {                 // B 是 A 的長輩
      var fwdUp = { 1: ['父親', '母親'], 2: ['祖父', '祖母'], 3: ['曾祖父', '曾祖母'] }[da];
      if (fwdUp) {
        var fwd = fwdUp[B.gender === 'F' ? 1 : 0];
        var bwd = { 1: ['兒子', '女兒'], 2: ['孫子', '孫女'], 3: ['曾孫', '曾孫女'] }[da][A.gender === 'F' ? 1 : 0];
        return { forward: fwd, backward: bwd, path: '目標是你的直系尊親（上溯 ' + da + ' 代）。' };
      }
    }
    if (lca === A.id) {                 // A 是 B 的長輩 → 反過來
      var r = kinshipCalc(toId, fromId);
      return { forward: r.backward, backward: r.forward, path: '目標是你的直系卑親（下傳 ' + db + ' 代）。' };
    }

    // 旁系：同代（da===db）→ 兄弟姊妹／堂表；不同代 → 叔伯姑姪等
    // 長幼逐段比年月日（bornBefore）；判不出（缺生年等）同真機一律「族親」，不再比字串硬猜（L-4）
    if (da === 1 && db === 1) {         // 同父：胞兄弟姊妹
      var elderB = bornBefore(B.birth, A.birth);   // 目標較年長者為兄/姊
      if (elderB === null) return unknownElder('目標是你的同胞手足，');
      var fwdS = B.gender === 'F' ? (elderB ? '姊姊' : '妹妹') : (elderB ? '哥哥' : '弟弟');
      var bwdS = A.gender === 'F' ? (!elderB ? '姊姊' : '妹妹') : (!elderB ? '哥哥' : '弟弟');
      return { forward: fwdS, backward: bwdS, path: '目標是你的同胞手足。' };
    }
    if (da === 2 && db === 2) {         // 堂兄弟姊妹
      var elderC = bornBefore(B.birth, A.birth);
      if (elderC === null) return unknownElder('目標是你的堂親（同曾祖、不同祖父），');
      return {
        forward: B.gender === 'F' ? (elderC ? '堂姊' : '堂妹') : (elderC ? '堂兄' : '堂弟'),
        backward: A.gender === 'F' ? (!elderC ? '堂姊' : '堂妹') : (!elderC ? '堂兄' : '堂弟'),
        path: '目標是你的堂親（同曾祖、不同祖父）。'
      };
    }
    if (da === 2 && db === 1) {         // 目標為你父執輩（叔伯姑）
      return {
        forward: B.gender === 'F' ? '姑姑' : '叔伯',
        backward: A.gender === 'F' ? '姪女' : '姪子',
        path: '目標是你父親一輩的旁系尊親。'
      };
    }
    if (da === 1 && db === 2) {         // 目標為你姪輩
      var r2 = kinshipCalc(toId, fromId);
      return { forward: r2.backward, backward: r2.forward, path: '目標是你的姪輩。' };
    }

    return {
      forward: '族親', backward: '族親',
      path: '此為較疏遠之旁系關係（上溯 ' + da + ' 代、目標下溯 ' + db + ' 代），謹以世系路徑描述。'
    };
  }

  /* 祭祖活動（虛構示範），符合 GET /api/events 契約欄位。
     calendar：'SOLAR'/'LUNAR'；date：依曆法之原始日期字串（編輯器回填用）。
     lunarDate 照正式版 kinlink/lunar.py solar_to_lunar_cn 的換算與格式（干支年＋中文月日）——
     展示模式沒有農曆換算，舊版手寫的「農曆三月初八」對不上真曆（2026-10-12 官網截圖時抓到）；
     tests/test_l4_mock_parity.py 會拿正式版換算比對，改日期記得一起改。
     只留清明一場（2026-10-12 總幹事：這系統主要是清明祭祖；同 exe 首次啟動的示範 db.seed_demo）。 */
  var EVENTS = [
    { id: 1, name: '清明掃墓・楊家祖塋', calendar: 'SOLAR', date: '2026-04-05',
      solarDate: '2026-04-05', lunarDate: '丙午年二月十八',
      location: '松柏嶺墓園正門牌坊', deceasedId: 1,
      time: '上午 08:30',
      note: '請攜帶清香、鮮花與供果；祭掃後於園區茶寮共進午膳。',
      // 掃墓通函「說明」多行內文（一行一條，列印時自動編號；純虛構示範）
      letterBody: '本年清明掃墓祭祖訂於國曆四月五日（星期日）上午八時三十分舉行。\n集合地點：松柏嶺墓園正門牌坊，請自備交通工具準時集合。\n祭掃後於園區茶寮共進午膳，敬請於三月二十日前回覆出席人數以便備餐。' }
  ];

  /* 穴排位場地（虛構示範），符合 GET /api/tomb-site/{id} 契約：
     一列＝一張格子表；cells 的 memberId 指到 MEMBERS，label 由 tombLabel() 即時算。 */
  var SITES = [
    { id: 1, name: '示範墓園・楊氏祖塋', title: '楊氏祖塋穴排位圖（虛構示範）',
      subtitle: '西元 1985 年入穴　1門', footer: '地址：範例市示範里示範路一段1號（虛構示範）',
      rows: 4, cols: 5, rowLabels: ['第1世', '第2世', '第3世', '第4世'],
      cells: [ { r: 0, c: 2, memberId: 1, text: '' }, { r: 1, c: 1, memberId: 2, text: '' },
               { r: 1, c: 3, memberId: 3, text: '' }, { r: 2, c: 0, memberId: null, text: '（預留）' } ] },
    // 階梯、面板各一張（2026-10-12：新家族一打開就看得到三種版型）：主牌位放先人、面板放後代，跟真實家族的圖一樣
    { id: 2, name: '示範墓園・主牌位（階梯）', title: '楊氏祖塋主牌位（虛構示範）', subtitle: '西元 1990 年安位',
      footer: '地址：範例市示範里示範路一段1號（虛構示範）', rows: 3, cols: 6, rowLabels: [],
      layout: 'steps', layoutOpts: { rowWidths: [2, 4, 6] },
      cells: [ { r: 0, c: 0, memberId: 1, text: '', top: '一世' }, { r: 0, c: 1, memberId: null, text: '（預留）', top: '一世' },
               { r: 1, c: 0, memberId: 2, text: '', top: '二世' }, { r: 1, c: 1, memberId: 3, text: '', top: '二世' },
               { r: 1, c: 2, memberId: 4, text: '', top: '二世' }, { r: 1, c: 3, memberId: null, text: '', top: '二世' },
               { r: 2, c: 0, memberId: 5, text: '', top: '三世' }, { r: 2, c: 1, memberId: 6, text: '', top: '三世' },
               { r: 2, c: 2, memberId: 7, text: '', top: '三世' }, { r: 2, c: 3, memberId: 8, text: '', top: '三世' },
               { r: 2, c: 4, memberId: null, text: '', top: '三世' }, { r: 2, c: 5, memberId: null, text: '', top: '三世' } ] },
    { id: 3, name: '示範墓園・面板', title: '楊氏祖塋穴排位面板（虛構示範）', subtitle: '西元 2020 年入穴',
      footer: '地址：範例市示範里示範路一段1號（虛構示範）', rows: 4, cols: 4, rowLabels: [],
      layout: 'panels', layoutOpts: { panelCols: 2, panelRows: [4, 3] },
      cells: [ { r: 0, c: 0, memberId: 9, text: '', top: '四世' }, { r: 0, c: 1, memberId: 10, text: '', top: '四世' },
               { r: 1, c: 0, memberId: 11, text: '', top: '四世' }, { r: 1, c: 1, memberId: null, text: '', top: '四世' },
               { r: 0, c: 2, memberId: null, text: '神位', top: '' } ] }
  ];
  // 面板／階梯的 Excel 格式（每層兩列：世代、名字）只在正式版後端實作，展示模式不重寫一份
  var MOCK_CSV_GRID_ONLY = '展示模式只示範方格的 Excel 匯出入；面板、階梯請用正式版（繫族.exe）';
  function tombLabel(m) {            // 男「字號　姓公」／女「名　姓氏」（與後端 honor_label 同規則）
    var name = String(m.name || '').replace(/[（(].*?[)）]/g, '').replace(/\s/g, '');
    if (name.length < 2) return name;
    var sur = name.charAt(0), given = name.slice(1);
    if (m.gender === 'F') return given + '　' + sur + '氏';
    return (m.styleName || given) + '　' + sur + '公';
  }
  function projectSite(s) {
    var out = clone(s);
    out.rowLabels = [];
    for (var i = 0; i < s.rows; i++) out.rowLabels.push((s.rowLabels && s.rowLabels[i]) || ('第' + (i + 1) + '列'));
    out.cells = [];
    for (var j = 0; j < (s.cells || []).length; j++) {
      var c = s.cells[j], m = c.memberId ? memberById(c.memberId) : null;
      out.cells.push({ r: c.r, c: c.c, memberId: m ? m.id : null, name: m ? m.name : '', gen: m ? m.gen : null,
                       text: c.text || '', top: c.top || '', label: c.text || (m ? tombLabel(m) : '') });
    }
    out.layout = s.layout || 'grid';
    out.layoutOpts = s.layoutOpts || {};
    return out;
  }

  /* 全局設定（鍵值；對應 settings 表）。mock 模式存於記憶體並鏡射 localStorage。 */
  var SETTINGS = {
    appName: '繫族 KinLink',
    version: 'v1.0.0',
    theme: 'light',
    editPinSet: false,         // 範本未設 PIN（任意 PIN 可解）
    sweepCycle: 'qingming',    // 掃墓週期：qingming/sanrijie/hakka/winter/custom（依籍貫習俗）
    leapReminder: 'lunar-same',// 閏月忌日提醒策略
    idleLockMinutes: 10,       // 沒有任何程式讀取：閒置自動上鎖已決定不做（2026-10-02），用完需手動上鎖
    // 房頭（房份）清單：可由各家族自訂數量與名稱。此處與本檔示範 MEMBERS 的
    // branch 值（長/次/三房）對齊，下拉篩選才能命中示範資料；web 後端則以
    // settings.branches（JSON 陣列字串，邊界已還原成陣列）為準。
    branches: ['長房', '次房', '三房'],
    // 協會資料（通函/信封片頭/列印抬頭用；鍵名同 web 後端 settings 表，全為虛構示範值）
    org_name: '楊氏宗親會（示範）',
    org_address: '彰化縣員村鄉宗祠路一號（虛構）',
    org_contact_addr: '510 彰化縣員村鄉示範街二號（虛構）',
    org_chair: '楊文柏',
    org_chair_phone: '0921-xxx-118',
    org_officer: '楊文凱',
    org_officer_phone: '0928-xxx-639',
    org_reg_no: '彰府社行字第 000000 號（示範）'
  };
  try {
    var savedTheme = global.localStorage && global.localStorage.getItem('kinlink-theme');
    if (savedTheme) SETTINGS.theme = savedTheme;
    var savedZoom = global.localStorage && global.localStorage.getItem('kinlink-zoom');
    if (savedZoom) SETTINGS.ui_zoom = savedZoom;
  } catch (e) {}
  // 純顯示偏好：瀏覽模式也可改（同真機 kinlink/maintenance.py 的 _SETTINGS_NOLOCK）；其餘設定需編輯模式
  var SETTINGS_NOLOCK = { theme: true, ui_zoom: true };

  /* 編輯鎖狀態（mock 模式維持於前端） */
  var lockState = { editMode: false, branch: '' };

  /* ========================================================
     四、mock 後端：每個方法回傳 Promise，模擬非同步 IO
     ======================================================== */
  function delay(value, ms) {
    return new Promise(function (resolve) {
      global.setTimeout(function () { resolve(value); }, ms || 60);
    });
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /* 農曆→國曆（mock 版 GET /api/solar；活動表單農曆欄的國曆對照在展示模式也要看得到）。
     LUNAR_INFO 每年一碼（1900–2099，由後端同一套農曆庫 borax 逐年產出，全範圍逐日比對過）：
       0x10000＝閏月大（30 日）、0x8000>>(月-1)＝該月大（30 日）、低 4 位＝閏幾月（0＝無）。
     農曆 1900 年正月初一＝國曆 1900-01-31。訊息字句與後端 lunar_date_problem 一致。 */
  var LUNAR_INFO = [
    0x04bd8,0x04ae0,0x0a570,0x054d5,0x0d260,0x0d950,0x16554,0x056a0,0x09ad0,0x055d2,   // 1900
    0x04ae0,0x0a5b6,0x0a4d0,0x0d250,0x1d255,0x0b540,0x0d6a0,0x0ada2,0x095b0,0x14977,   // 1910
    0x04970,0x0a4b0,0x0b4b5,0x06a50,0x06d40,0x1ab54,0x02b60,0x09570,0x052f2,0x04970,   // 1920
    0x06566,0x0d4a0,0x0ea50,0x16a95,0x05ad0,0x02b60,0x186e3,0x092e0,0x1c8d7,0x0c950,   // 1930
    0x0d4a0,0x1d8a6,0x0b550,0x056a0,0x1a5b4,0x025d0,0x092d0,0x0d2b2,0x0a950,0x0b557,   // 1940
    0x06ca0,0x0b550,0x15355,0x04da0,0x0a5b0,0x14573,0x052b0,0x0a9a8,0x0e950,0x06aa0,   // 1950
    0x0aea6,0x0ab50,0x04b60,0x0aae4,0x0a570,0x05260,0x0f263,0x0d950,0x05b57,0x056a0,   // 1960
    0x096d0,0x04dd5,0x04ad0,0x0a4d0,0x0d4d4,0x0d250,0x0d558,0x0b540,0x0b6a0,0x195a6,   // 1970
    0x095b0,0x049b0,0x0a974,0x0a4b0,0x0b27a,0x06a50,0x06d40,0x0af46,0x0ab60,0x09570,   // 1980
    0x04af5,0x04970,0x064b0,0x074a3,0x0ea50,0x06b58,0x05ac0,0x0ab60,0x096d5,0x092e0,   // 1990
    0x0c960,0x0d954,0x0d4a0,0x0da50,0x07552,0x056a0,0x0abb7,0x025d0,0x092d0,0x0cab5,   // 2000
    0x0a950,0x0b4a0,0x0baa4,0x0ad50,0x055d9,0x04ba0,0x0a5b0,0x15176,0x052b0,0x0a930,   // 2010
    0x07954,0x06aa0,0x0ad50,0x05b52,0x04b60,0x0a6e6,0x0a4e0,0x0d260,0x0ea65,0x0d530,   // 2020
    0x05aa0,0x076a3,0x096d0,0x04afb,0x04ad0,0x0a4d0,0x1d0b6,0x0d250,0x0d520,0x0dd45,   // 2030
    0x0b5a0,0x056d0,0x055b2,0x049b0,0x0a577,0x0a4b0,0x0aa50,0x1b255,0x06d20,0x0ada0,   // 2040
    0x14b63,0x09370,0x049f8,0x04970,0x064b0,0x168a6,0x0ea50,0x06b20,0x1a6c4,0x0aae0,   // 2050
    0x092e0,0x0d2e3,0x0c960,0x0d557,0x0d4a0,0x0da50,0x05d55,0x056a0,0x0a6d0,0x055d4,   // 2060
    0x052d0,0x0a9b8,0x0a950,0x0b4a0,0x0b6a6,0x0ad50,0x055a0,0x0aba4,0x0a5b0,0x052b0,   // 2070
    0x0b273,0x06930,0x07337,0x06aa0,0x0ad50,0x14b55,0x04b60,0x0a570,0x054e4,0x0d260,   // 2080
    0x0e968,0x0d520,0x0daa0,0x16aa6,0x056d0,0x04ae0,0x0a9d4,0x0a4d0,0x0d150,0x0f252    // 2090
  ];
  function mockSolarOf(d) {
    var out = { solar: '', lunar: '', problem: '' };
    var mt = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(d || '').trim());
    if (!mt) { out.problem = d ? '農曆日期看不懂（' + d + '），請用下拉選單重新選年、月、日。' : ''; return out; }
    var y = +mt[1], m = +mt[2], dd = +mt[3];
    var badMD = m < 1 || m > 12 || dd < 1 || dd > 30;
    var DAY = '一二三四五六七八九十', MON = '正二三四五六七八九十冬臘';
    var ym = '甲乙丙丁戊己庚辛壬癸'.charAt((y - 4) % 10) + '子丑寅卯辰巳午未申酉戌亥'.charAt((y - 4) % 12)
           + '年' + MON.charAt(m - 1) + '月';
    if (!badMD) out.lunar = ym + (dd <= 10 ? '初' + DAY.charAt(dd - 1) : dd < 20 ? '十' + DAY.charAt(dd - 11)
                                 : dd === 20 ? '二十' : dd < 30 ? '廿' + DAY.charAt(dd - 21) : '三十');
    if (y < 1900 || y > 2099) { out.problem = '農曆年份只能填 1900～2099（目前填的是 ' + y + '）。'; return out; }
    if (badMD) { out.problem = '農曆沒有 ' + m + ' 月 ' + dd + ' 日：月份是正月～臘月，日子是初一～三十。'; return out; }
    var off = 0, i, k, info;
    for (i = 1900; i < y; i++) {                       // 前面整年的日數
      info = LUNAR_INFO[i - 1900];
      for (k = 1; k <= 12; k++) off += (info & (0x10000 >> k)) ? 30 : 29;
      if (info & 0xf) off += (info & 0x10000) ? 30 : 29;
    }
    info = LUNAR_INFO[y - 1900];
    for (k = 1; k < m; k++) {                           // 當年前面幾個月（閏月緊接在同號月之後）
      off += (info & (0x10000 >> k)) ? 30 : 29;
      if ((info & 0xf) === k) off += (info & 0x10000) ? 30 : 29;
    }
    if (dd === 30 && !(info & (0x10000 >> m))) {
      out.problem = ym + '只有廿九日（小月），沒有三十，' + (m === 12 ? '那年除夕就是廿九，' : '') + '請改選廿九。';
      return out;
    }
    out.solar = new Date(Date.UTC(1900, 0, 31) + (off + dd - 1) * 86400000).toISOString().slice(0, 10);
    return out;
  }

  /* 生卒日期：與真機同規則（kinlink/lunar.py 的 normalize_date／_date_parts）。
     L-4：mock 原本原字串照存、長幼直接比字串——'1952-5-1' 比 '1952-12-01' 大，
     展示模式會把哥哥叫成弟弟，真機（第一批 H-2）早已改成逐段比年月日。 */
  var FW_DATE = '０１２３４５６７８９－／．', HW_DATE = '0123456789-/.';
  function dateHalfWidth(s) {
    return String(s).replace(/[０-９－／．]/g, function (c) { return HW_DATE.charAt(FW_DATE.indexOf(c)); });
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  // 寫入用：年-月-日（/ . 全形皆可、月日不補零）→ 補零的 YYYY-MM-DD；只有四位數年份維持年份；
  // 其他看不懂的文字（「不詳」「已歿」、原文、不存在的日期）原樣保留。空值原樣回。
  function normalizeDate(s) {
    if (s === null || s === undefined || s === '') return s;
    var t = dateHalfWidth(String(s).replace(/^\s+|\s+$/g, ''));
    var m = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/.exec(t);
    if (m) {
      var y = +m[1], mo = +m[2], d = +m[3];
      var leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
      var dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
      return (y >= 1 && dim && d >= 1 && d <= dim) ? (m[1] + '-' + pad2(mo) + '-' + pad2(d)) : s;
    }
    return /^\d{4}$/.test(t) ? t : s;
  }
  // 讀取用：日期字串 → [年, 月, 日]（缺的部分為 null）；看不懂回 null
  function dateParts(s) {
    var t = dateHalfWidth(String(s || '').replace(/^\s+|\s+$/g, ''));
    var m = /^(\d{4})(?:[-\/.](\d{1,2})(?:[-\/.](\d{1,2}))?)?$/.exec(t);
    if (!m) return null;
    return [+m[1], m[2] === undefined ? null : +m[2], m[3] === undefined ? null : +m[3]];
  }
  // a 是否早於 b：判得出回 true/false；任一方缺、看不懂、同一天、同年但一方只有年份 → null
  function bornBefore(a, b) {
    var pa = dateParts(a), pb = dateParts(b);
    if (!pa || !pb) return null;
    for (var i = 0; i < 3; i++) {
      if (pa[i] === null || pb[i] === null) return null;
      if (pa[i] !== pb[i]) return pa[i] < pb[i];
    }
    return null;
  }

  var mock = {
    getState: function () {
      return delay({
        editMode: lockState.editMode, branch: lockState.branch,
        theme: SETTINGS.theme, appName: SETTINGS.appName, version: SETTINGS.version,
        dbPath: 'E:\\繫族\\繫族.db（展示模式示意路徑；展示資料只存在瀏覽器，不寫入檔案）'
      });
    },
    unlock: function (pin, branch) {
      // 範本任意 PIN 皆可解；空 PIN 視為失敗以示意流程
      var ok = !!(pin && String(pin).length > 0);
      if (ok) { lockState.editMode = true; lockState.branch = branch || ''; emit('lock/changed', clone(lockState)); }
      return delay({ ok: ok });
    },
    lock: function () {
      lockState.editMode = false; lockState.branch = '';
      emit('lock/changed', clone(lockState));
      return delay({ ok: true });
    },
    listMembers: function (branch, q, limit) {
      var out = [];
      for (var i = 0; i < MEMBERS.length; i++) {
        if (limit && out.length >= limit) break;
        var m = MEMBERS[i];
        if (branch && m.branch !== branch) continue;
        if (q) {
          var blob = (m.name + ' ' + (m.styleName || '') + ' ' + (m.branch || '') + ' ' + fatherNameOf(m)).toLowerCase();
          if (blob.indexOf(String(q).toLowerCase()) < 0) continue;
        }
        out.push(projectMember(m));
      }
      return delay(out);
    },
    getMember: function (id) {
      var m = memberById(Number(id));
      return delay(m ? projectDetail(m) : null);
    },
    saveMember: function (data) {
      if (!lockState.editMode) return Promise.reject(new Error('需先解鎖編輯模式'));
      var m, isNew = !data.id;
      if (isNew) {
        var maxId = 0; for (var i = 0; i < MEMBERS.length; i++) maxId = Math.max(maxId, MEMBERS[i].id);
        m = { id: maxId + 1, alive: true, fatherId: data.fatherId || null };
        MEMBERS.push(m);
      } else {
        m = memberById(Number(data.id));
        if (!m) return Promise.reject(new Error('查無此成員'));
      }
      // 套用可編輯欄位（fatherId 只在新增時掛父，與後端 save_member 一致；
      // 既有成員改父走 addParent/removeParent，才不會把過繼者的本生父邊一起抹掉）
      var fields = ['name', 'styleName', 'gen', 'branch', 'gender', 'alive',
        'birth', 'death', 'birthOriginal', 'deathOriginal', 'phone', 'city', 'postalCode', 'burial', 'burialType', 'burialCode', 'note', 'mailTarget', 'customKin'];
      for (var k = 0; k < fields.length; k++) {
        var f = fields[k];
        if (data[f] === undefined) continue;
        // 生卒年同真機 save_member 先正規化（1960/5/1 → 1960-05-01；L-4），長幼與排序才會一致
        m[f] = (f === 'birth' || f === 'death') ? normalizeDate(data[f]) : data[f];
      }
      emit('member/changed', { id: m.id, isNew: isNew });
      return delay({ id: m.id });
    },
    deleteMember: function (id) {
      if (!lockState.editMode) return Promise.reject(new Error('需先解鎖編輯模式'));
      id = Number(id);
      // 對應 schema ON DELETE RESTRICT：有後代者不可刪
      for (var i = 0; i < MEMBERS.length; i++) {
        if (MEMBERS[i].fatherId === id) return Promise.reject(new Error('此成員有後代，不可刪除（請先處理其子嗣）'));
      }
      for (var j = 0; j < MEMBERS.length; j++) {
        if (MEMBERS[j].id === id) { MEMBERS.splice(j, 1); emit('member/changed', { id: id, deleted: true }); return delay({ ok: true }); }
      }
      return Promise.reject(new Error('查無此成員'));
    },
    /* —— 親屬關係管理（規格 §4.1 雙軌制；與 web 後端規則一致）—— */
    addParent: function (memberId, parentId, relationType) {
      if (!lockState.editMode) return Promise.reject(new Error('需先解鎖編輯模式'));
      var rt = String(relationType || '').toUpperCase();
      if (rt !== 'BIOLOGICAL' && rt !== 'ADOPTED' && rt !== 'FOSTER') {
        return Promise.reject(new Error('關係型別須為 親生／過繼／收養'));
      }
      var m = memberById(Number(memberId)), p = memberById(Number(parentId));
      if (!m || !p) return Promise.reject(new Error('查無此成員'));
      if (m.id === p.id) return Promise.reject(new Error('父/母不可指定為本人，請重新選擇'));
      if (!p.gender) {
        // 性別空白＝分不出父槽母槽：同真機回錯誤（H-3），不再當母槽把生母擠掉（L-4）
        return Promise.reject(new Error('「' + p.name + '」的性別還沒設定，無法判斷要加為父親還是母親。' +
          '請先到這位親屬的成員資料設定性別（男／女），再回來加入。'));
      }
      if (mockDescendants(m.id)[p.id]) {
        return Promise.reject(new Error('父/母不可指定為此成員的後代（會造成族譜迴圈），請重新選擇'));
      }
      var male = p.gender === 'M';
      // 槽位規則：同一 child 每型別至多一位男性父＋一位女性母 → 先清同槽舊邊
      // （母槽只算有設性別、且非男的舊邊；性別空白的舊親代不算，同真機 add_parent）
      for (var i = EXTRA_PARENTS.length - 1; i >= 0; i--) {
        var ep = EXTRA_PARENTS[i];
        if (ep.childId !== m.id || ep.relationType !== rt) continue;
        var epm = memberById(ep.parentId);
        var sameSlot = male ? !!(epm && epm.gender === 'M') : !!(epm && epm.gender && epm.gender !== 'M');
        if (sameSlot) EXTRA_PARENTS.splice(i, 1);
      }
      if (rt === 'BIOLOGICAL' && male) {
        m.fatherId = p.id;   // 男性親生父走主檔 fatherId（樹狀圖沿此組樹）
      } else {
        EXTRA_PARENTS.push({ parentId: p.id, childId: m.id, relationType: rt });
      }
      emit('member/changed', { id: m.id });
      return delay({ ok: true });
    },
    removeParent: function (memberId, parentId, relationType) {
      if (!lockState.editMode) return Promise.reject(new Error('需先解鎖編輯模式'));
      var m = memberById(Number(memberId));
      if (!m) return Promise.reject(new Error('查無此成員'));
      var pid = Number(parentId);
      var rt = String(relationType || '').toUpperCase();
      if (m.fatherId === pid && (!rt || rt === 'BIOLOGICAL')) m.fatherId = null;
      for (var i = EXTRA_PARENTS.length - 1; i >= 0; i--) {
        var ep = EXTRA_PARENTS[i];
        if (ep.childId === m.id && ep.parentId === pid && (!rt || ep.relationType === rt)) {
          EXTRA_PARENTS.splice(i, 1);
        }
      }
      emit('member/changed', { id: m.id });
      return delay({ ok: true });
    },
    addSpouse: function (memberId, spouseId, status) {
      if (!lockState.editMode) return Promise.reject(new Error('需先解鎖編輯模式'));
      var a = memberById(Number(memberId)), b = memberById(Number(spouseId));
      if (!a || !b) return Promise.reject(new Error('查無此成員'));
      if (a.id === b.id) return Promise.reject(new Error('配偶不可指定為本人，請重新選擇'));
      var st = String(status || 'MARRIED').toUpperCase();
      if (['MARRIED', 'DIVORCED', 'WIDOWED', 'SEPARATED'].indexOf(st) < 0) st = 'MARRIED';
      // 同一對已存在（不分先後）→ 更新狀態（等效 upsert，與 web 後端一致）
      for (var i = 0; i < MARRIAGES.length; i++) {
        var mg = MARRIAGES[i];
        if ((mg.a === a.id && mg.b === b.id) || (mg.a === b.id && mg.b === a.id)) {
          mg.status = st;
          emit('member/changed', { id: a.id });
          return delay({ ok: true, id: mg.id });
        }
      }
      var maxId = 0;
      for (var j = 0; j < MARRIAGES.length; j++) maxId = Math.max(maxId, MARRIAGES[j].id);
      MARRIAGES.push({ id: maxId + 1, a: a.id, b: b.id, status: st });
      emit('member/changed', { id: a.id });
      return delay({ ok: true, id: maxId + 1 });
    },
    removeSpouse: function (memberId, spouseId) {
      if (!lockState.editMode) return Promise.reject(new Error('需先解鎖編輯模式'));
      var x = Number(memberId), y = Number(spouseId);
      for (var i = MARRIAGES.length - 1; i >= 0; i--) {
        var mg = MARRIAGES[i];
        if ((mg.a === x && mg.b === y) || (mg.a === y && mg.b === x)) MARRIAGES.splice(i, 1);
      }
      emit('member/changed', { id: x });
      return delay({ ok: true });
    },
    kinship: function (fromId, toId) {
      // R4（mock 對齊 web 後端）：夫妻直判 → 血親演算；
      // 目標 customKin 非空時 forward 覆寫並標示（家族習慣稱呼）。
      var a = Number(fromId), b = Number(toId);
      var r = null, A = memberById(a), B = memberById(b);
      if (A && B && A.id !== B.id) r = marriageKin(A, B);
      if (!r) r = kinshipCalc(a, b);
      if (A && B && A.id !== B.id && B.customKin) {
        r.forward = B.customKin + '（家族習慣稱呼）';
      }
      return delay(r);
    },
    listEvents: function () { return delay(clone(EVENTS)); },
    saveEvent: function (data) {
      if (!lockState.editMode) return Promise.reject(new Error('需先解鎖編輯模式'));
      data = data || {};
      var name = (data.name || '').trim();
      var cal = (data.calendar || 'SOLAR').toUpperCase();
      if (cal !== 'SOLAR' && cal !== 'LUNAR') cal = 'SOLAR';
      // 依曆法取日期：國曆走 solarDate，農曆走 lunarDate；皆無則退回單一 date 欄
      var dateVal = (cal === 'SOLAR' ? data.solarDate : data.lunarDate) || data.date || '';
      dateVal = String(dateVal).trim();
      if (!name) return Promise.reject(new Error('請填寫活動名稱'));
      if (!dateVal) return Promise.reject(new Error('請選擇活動日期'));
      // 同真機 save_event：農曆日不存在（如小月三十）擋下並講清楚（體檢 domain-3；展示模式原本照存）
      var lunarProblem = cal === 'LUNAR' ? mockSolarOf(dateVal).problem : '';
      if (lunarProblem) return Promise.reject(new Error(lunarProblem));

      var ev, isNew = !data.id;
      if (isNew) {
        var maxId = 0; for (var i = 0; i < EVENTS.length; i++) maxId = Math.max(maxId, EVENTS[i].id);
        ev = { id: maxId + 1, time: '' };
        EVENTS.push(ev);
      } else {
        ev = null;
        for (var j = 0; j < EVENTS.length; j++) if (EVENTS[j].id === Number(data.id)) ev = EVENTS[j];
        if (!ev) return Promise.reject(new Error('查無此活動'));
      }
      ev.name = name;
      ev.calendar = cal;
      ev.date = dateVal;
      // 同步維護 solarDate / lunarDate 兩欄（活動卡渲染用其一）
      ev.solarDate = cal === 'SOLAR' ? dateVal : '';
      ev.lunarDate = cal === 'LUNAR' ? dateVal : (data.lunarDate || '');
      ev.location = data.location || '';
      ev.note = data.note || '';
      ev.letterBody = data.letterBody || '';   // 掃墓通函「說明」多行內文
      if (data.deceasedId !== undefined) ev.deceasedId = data.deceasedId;
      else if (isNew) ev.deceasedId = null;
      emit('event/changed', { id: ev.id, isNew: isNew });
      // 與後端契約一致：回存後由前端重撈 listEvents 刷新
      return delay({ id: ev.id });
    },
    deleteEvent: function (id) {
      if (!lockState.editMode) return Promise.reject(new Error('需先解鎖編輯模式'));
      var n = Number(id), name = '';
      for (var i = 0; i < EVENTS.length; i++) {
        if (EVENTS[i].id === n) { name = EVENTS[i].name; EVENTS.splice(i, 1); break; }
      }
      if (!name) return Promise.reject(new Error('查無此祭祖活動（可能已被刪除）'));
      emit('event/changed', { id: n, deleted: true });
      return delay({ ok: true, name: name });
    },
    /* —— 穴排位場地（mock）—— */
    listTombSites: function () {
      return delay(SITES.map(function (s) {
        var n = 0; for (var i = 0; i < s.cells.length; i++) if (s.cells[i].memberId || s.cells[i].text) n++;
        return { id: s.id, name: s.name, title: s.title || '', rows: s.rows, cols: s.cols, filled: n, layout: s.layout || 'grid' };
      }));
    },
    getTombSite: function (id) {
      for (var i = 0; i < SITES.length; i++) if (SITES[i].id === Number(id)) return delay(projectSite(SITES[i]));
      return Promise.reject(new Error('查無此穴排位場地'));
    },
    saveTombSite: function (data) {
      if (!lockState.editMode) return Promise.reject(new Error('需先解鎖編輯模式'));
      data = data || {};
      if (!String(data.name || '').trim()) return Promise.reject(new Error('請填寫場地名稱'));
      var rows = Math.max(1, Math.min(60, Number(data.rows) || 5)), cols = Math.max(1, Math.min(60, Number(data.cols) || 6));
      // 版型（同後端 tombsites._clean_layout，展示模式只做最小檢查）：面板／階梯的列數欄數由設定推出
      var layout = data.layout || 'grid', lo = data.layoutOpts || {}, inside = function () { return true; };
      if (layout === 'panels') {
        var pc = Number(lo.panelCols) || 3, pr = (lo.panelRows || [rows]).map(Number);
        lo = { panelCols: pc, panelRows: pr }; rows = Math.max.apply(null, pr); cols = pc * pr.length;
        inside = function (r, c) { var p = Math.floor(c / pc); return p < pr.length && r < pr[p]; };
      } else if (layout === 'steps') {
        var rw = (lo.rowWidths || [cols]).map(Number);
        lo = { rowWidths: rw }; rows = rw.length; cols = Math.max.apply(null, rw);
        inside = function (r, c) { return r < rw.length && c < rw[r]; };
      } else { layout = 'grid'; lo = {}; }
      var s, isNew = !data.id;
      if (isNew) { var mx = 0; for (var i = 0; i < SITES.length; i++) mx = Math.max(mx, SITES[i].id); s = { id: mx + 1, cells: [] }; SITES.push(s); }
      else { s = null; for (var j = 0; j < SITES.length; j++) if (SITES[j].id === Number(data.id)) s = SITES[j]; if (!s) return Promise.reject(new Error('查無此穴排位場地')); }
      s.name = String(data.name).trim(); s.title = data.title || ''; s.subtitle = data.subtitle || ''; s.footer = data.footer || '';
      s.rows = rows; s.cols = cols; s.rowLabels = (data.rowLabels || []).slice(0, rows);
      s.layout = layout; s.layoutOpts = lo;
      var src = data.cells !== undefined ? data.cells : s.cells, seen = {}, cells = [];
      for (var k = 0; k < (src || []).length; k++) {
        var c = src[k], r = Number(c.r), cc = Number(c.c);
        if (!(r >= 0 && r < rows && cc >= 0 && cc < cols) || !inside(r, cc)) continue;
        if (c.memberId && !memberById(Number(c.memberId))) return Promise.reject(new Error('格子指到的成員不存在'));
        var top = String(c.top || '').trim();
        if (!c.memberId && !String(c.text || '').trim() && !top) { delete seen[r + ',' + cc]; continue; }
        seen[r + ',' + cc] = { r: r, c: cc, memberId: c.memberId ? Number(c.memberId) : null, text: String(c.text || '').trim(), top: top };
      }
      for (var key in seen) cells.push(seen[key]);
      s.cells = cells;
      emit('tombsite/changed', { id: s.id, isNew: isNew });
      return delay({ id: s.id });
    },
    deleteTombSite: function (id) {
      if (!lockState.editMode) return Promise.reject(new Error('需先解鎖編輯模式'));
      for (var i = 0; i < SITES.length; i++) if (SITES[i].id === Number(id)) { var nm = SITES[i].name; SITES.splice(i, 1); emit('tombsite/changed', { id: Number(id), deleted: true }); return delay({ ok: true, name: nm }); }
      return Promise.reject(new Error('查無此穴排位場地'));
    },
    exportTombSiteCsv: function (id) {
      return this.getTombSite(id).then(function (s) {
        if (s.layout !== 'grid') throw new Error(MOCK_CSV_GRID_ONLY);
        var grid = {}, lines = [];
        for (var i = 0; i < s.cells.length; i++) grid[s.cells[i].r + ',' + s.cells[i].c] = s.cells[i].label;
        for (var r = 0; r < s.rows; r++) { var row = [s.rowLabels[r]]; for (var c = 0; c < s.cols; c++) row.push(grid[r + ',' + c] || ''); lines.push(row.map(function (v) { return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(',')); }
        return '\uFEFF' + lines.join('\r\n') + '\r\n';
      });
    },
    importTombSiteCsv: function (id, blob) {
      if (!lockState.editMode) return Promise.reject(new Error('需先解鎖編輯模式'));
      for (var k = 0; k < SITES.length; k++)
        if (SITES[k].id === Number(id) && (SITES[k].layout || 'grid') !== 'grid') return Promise.reject(new Error(MOCK_CSV_GRID_ONLY));
      var self = this;
      return (blob.text ? blob.text() : Promise.resolve(String(blob))).then(function (text) {
        var rows = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(function (l) { return l.trim(); }).map(function (l) { return l.split(','); });
        if (!rows.length) return Promise.reject(new Error('CSV 內沒有資料列'));
        var cols = 0, cells = [], matched = 0, unmatched = [], labels = [];
        for (var r = 0; r < rows.length; r++) {
          labels.push((rows[r][0] || '').trim()); cols = Math.max(cols, rows[r].length - 1);
          for (var c = 1; c < rows[r].length; c++) {
            var v = (rows[r][c] || '').trim(); if (!v) continue;
            var hits = MEMBERS.filter(function (m) { return m.name === v || (m.styleName && m.styleName === v); });
            if (hits.length === 1) { cells.push({ r: r, c: c - 1, memberId: hits[0].id, text: '' }); matched++; }
            else { cells.push({ r: r, c: c - 1, memberId: null, text: v }); unmatched.push(v); }
          }
        }
        return self.getTombSite(id).then(function (s) {
          return self.saveTombSite({ id: s.id, name: s.name, title: s.title, subtitle: s.subtitle, footer: s.footer,
                                     rows: rows.length, cols: Math.max(1, cols), rowLabels: labels, cells: cells });
        }).then(function () { return { ok: true, rows: rows.length, cols: Math.max(1, cols), matched: matched, unmatched: unmatched }; });
      });
    },
    lunarOf: function (d) { return delay({ lunar: '' }); },   // mock 無農曆換算，回空＝不顯示提示
    solarOf: function (d) { return delay(mockSolarOf(d)); },  // 農曆→國曆（活動表單農曆欄對照，契約同 GET /api/solar）
    kinshipBatch: function (toId, memberIds) {
      // 與後端 kinship_batch 同語意：回 backward（＝逝者稱呼這個人），夫妻直判在前（逝者的妻子＝「妻子」）；
      // 通稱／算不出／長幼判不出一律不放進 terms，交給前端退回預設稱呼；
      // 離異的前配偶也留空（同真機：祭祖通知上印「前妻」不得體）。
      var terms = {}, to = Number(toId), T = memberById(to);
      (memberIds || []).forEach(function (mid) {
        var m = Number(mid), M = memberById(m);
        if (m === to) return;
        var r = (M && T ? marriageKin(M, T) : null) || kinshipCalc(m, to) || {};
        var t = (r.backward || '').trim();
        if (r.guessed || ['', '—', '族親', '前妻', '前夫', '前配偶'].indexOf(t) >= 0) return;
        terms[String(m)] = t;
      });
      return delay({ terms: terms });
    },
    getSettings: function () { return delay(clone(SETTINGS)); },
    setPin: function (oldPin, newPin) {
      // 展示模式：任意 PIN 皆可解鎖，變更僅演示流程（不驗舊 PIN，只要求新 PIN 非空）
      if (!newPin || !String(newPin).trim()) return Promise.reject(new Error('新 PIN 不可為空'));
      SETTINGS.editPinSet = true;
      emit('settings/changed', clone(SETTINGS));
      return delay({ ok: true });
    },
    setSettings: function (patch) {
      patch = patch || {};
      // 同真機 update_settings：除了純顯示偏好（主題、介面縮放），其餘設定（房頭、配色、掃墓週期…）
      // 需編輯模式。舊 mock 一律照存，展示時瀏覽模式也改得動，真機卻是 403（L-4／M-9）
      for (var k0 in patch) {
        if (Object.prototype.hasOwnProperty.call(patch, k0) && !SETTINGS_NOLOCK[k0] && !lockState.editMode) {
          return Promise.reject(new Error('需先解鎖編輯模式'));
        }
      }
      for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) SETTINGS[k] = patch[k];
      if (patch.theme) { try { global.localStorage.setItem('kinlink-theme', patch.theme); } catch (e) {} }
      if (patch.ui_zoom) { try { global.localStorage.setItem('kinlink-zoom', String(patch.ui_zoom)); } catch (e) {} }
      emit('settings/changed', clone(SETTINGS));
      return delay(clone(SETTINGS));
    },
    backup: function () {
      var d = new Date();
      var name = d.getFullYear() + '-' + String(d.getMonth() + 1) + '-' + String(d.getDate()) + '.kinlink';
      return delay({ file: '/backups/' + name });
    },
    restore: function (file) { return delay({ ok: true, file: file || '' }); },
    /* R1 通用 CSV 匯入（展示模式）：回固定示範 preview 讓完整流程可預覽；
       commit（實際寫入）一律婉拒——展示模式無真實資料庫可寫。
       報告形狀與 web 後端 import_csv 契約一致（中文鍵）。 */
    importData: function (file, mode) {
      if (String(mode || 'preview').toLowerCase() === 'commit') {
        return Promise.reject(new Error('展示模式僅供預覽匯入流程，實際匯入請由 繫族.exe 開啟正式模式'));
      }
      return delay({
        ok: true, mode: 'preview', committed: false, rows: 3,
        '新增': 2, '更新': 0, '可接父': 1, '可接母': 0, '可接配偶': 0,
        '找不到父': 1, '跳過': 1, '錯誤': 0,
        '錯誤清單': [],
        '跳過清單': ['第 4 列：楊文柏（第 3 世，父：楊敬山）已存在於資料庫，已跳過'],
        '找不到父清單': ['第 3 列：陳月裡 之父「陳金水」（第 1 世）查無此人，先不接父（可日後於成員編輯表單補選）'],
        // 真機報告另有這四張清單（第一批 H-2／H-3、M-8 加的）；示範檔沒有對應情況，給空清單維持契約一致（L-4）
        '更新列提醒': [], 'Excel變形提醒': [], '同名提醒': [], '改為已歿提醒': [],
        '新增房頭': []
      });
    },
    exportData: function (fmt) { return delay({ ok: true, fmt: fmt || 'xlsx', file: '/exports/楊家族譜.' + (fmt || 'xlsx') }); },
    /* 展示模式：無後端可連 GitHub／寫檔 */
    checkUpdate: function () { return delay({ configured: false, mock: true }); },
    downloadUpdate: function () { return delay({ ok: false, message: '（展示模式）請於正式模式使用更新功能' }); },
    /* 展示模式無真實資料庫可清（清空示範資料僅正式模式提供） */
    clearDemo: function () {
      return Promise.reject(new Error('展示模式無法清空示範資料，請由 繫族.exe 開啟正式模式'));
    }
  };

  /* ========================================================
     五、web 後端：對應 /api/* 契約
     ======================================================== */
  /* 設定欄位正規化：app.js 與 mock 統一講 camelCase + 小寫掃墓週期值，
     但 web 後端 settings 表用 snake_case 鍵（sweep_cycle）與大寫枚舉（QINGMING…）。
     於此邊界雙向轉譯，讓兩種傳輸對 app.js 呈現同一份契約。 */
  var SWEEP_TO_API = { qingming: 'QINGMING', sanrijie: 'SANRIJIE', hakka: 'HAKKA', winter: 'WINTER', custom: 'CUSTOM', vernal: 'VERNAL' };
  var SWEEP_FROM_API = { QINGMING: 'qingming', SANRIJIE: 'sanrijie', HAKKA: 'hakka', WINTER: 'winter', CUSTOM: 'custom', VERNAL: 'custom' };
  function settingsFromApi(s) {
    s = s || {};
    var out = {};
    for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k)) out[k] = s[k];
    if (s.sweep_cycle !== undefined) out.sweepCycle = SWEEP_FROM_API[s.sweep_cycle] || String(s.sweep_cycle).toLowerCase();
    return out;
  }
  function settingsToApi(patch) {
    patch = patch || {};
    var out = {};
    for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) out[k] = patch[k];
    if (patch.sweepCycle !== undefined) {
      out.sweep_cycle = SWEEP_TO_API[patch.sweepCycle] || String(patch.sweepCycle).toUpperCase();
      delete out.sweepCycle;
    }
    return out;
  }

  var web = {
    getState: function () { return httpFetch('GET', '/state'); },
    unlock: function (pin, branch) { return httpFetch('POST', '/lock/unlock', { body: { pin: pin, branch: branch } }); },
    lock: function () { return httpFetch('POST', '/lock/lock'); },
    listMembers: function (branch, q, limit) { return httpFetch('GET', '/members', { query: { branch: branch, q: q, limit: limit || '' } }); },
    getMember: function (id) { return httpFetch('GET', '/member/' + encodeURIComponent(id)); },
    saveMember: function (data) { return httpFetch('POST', '/member', { body: data }); },
    deleteMember: function (id) { return httpFetch('DELETE', '/member/' + encodeURIComponent(id)); },
    /* —— 親屬關係管理（編輯模式限定；規格 §4.1 雙軌制）—— */
    addParent: function (memberId, parentId, relationType) {
      return httpFetch('POST', '/member/' + encodeURIComponent(memberId) + '/parent',
        { body: { parentId: parentId, relationType: relationType } });
    },
    removeParent: function (memberId, parentId, relationType) {
      return httpFetch('DELETE',
        '/member/' + encodeURIComponent(memberId) + '/parent/' + encodeURIComponent(parentId),
        { query: { relationType: relationType || '' } });
    },
    addSpouse: function (memberId, spouseId, status) {
      return httpFetch('POST', '/member/' + encodeURIComponent(memberId) + '/spouse',
        { body: { spouseId: spouseId, status: status } });
    },
    removeSpouse: function (memberId, spouseId) {
      return httpFetch('DELETE',
        '/member/' + encodeURIComponent(memberId) + '/spouse/' + encodeURIComponent(spouseId));
    },
    kinship: function (fromId, toId) { return httpFetch('GET', '/kinship', { query: { from: fromId, to: toId } }); },
    listEvents: function () { return httpFetch('GET', '/events'); },
    saveEvent: function (data) { return httpFetch('POST', '/event', { body: data }); },
    deleteEvent: function (id) { return httpFetch('DELETE', '/event/' + encodeURIComponent(id)); },
    kinshipBatch: function (toId, memberIds) {
      return httpFetch('POST', '/kinship/batch', { body: { toId: toId, memberIds: memberIds } });
    },
    lunarOf: function (d) { return httpFetch('GET', '/lunar', { query: { d: d } }); },
    solarOf: function (d) { return httpFetch('GET', '/solar', { query: { d: d } }); },
    /* —— 穴排位場地 —— */
    listTombSites: function () { return httpFetch('GET', '/tomb-sites'); },
    getTombSite: function (id) { return httpFetch('GET', '/tomb-site/' + encodeURIComponent(id)); },
    saveTombSite: function (data) { return httpFetch('POST', '/tomb-site', { body: data }); },
    deleteTombSite: function (id) { return httpFetch('DELETE', '/tomb-site/' + encodeURIComponent(id)); },
    exportTombSiteCsv: function (id) {
      return httpFetch('GET', '/tomb-site/' + encodeURIComponent(id) + '/csv', { raw: true })
        .then(function (res) { if (!res.ok) throw new Error('匯出失敗（' + res.status + '）'); return res.text(); });
    },
    importTombSiteCsv: function (id, blob) {
      return httpFetch('POST', '/tomb-site/' + encodeURIComponent(id) + '/csv', { body: blob });
    },
    getSettings: function () { return httpFetch('GET', '/settings').then(settingsFromApi); },
    /* 變更編輯鎖 PIN：POST /api/lock/setpin {old,new} → {ok[,message]}。 */
    setPin: function (oldPin, newPin) { return httpFetch('POST', '/lock/setpin', { body: { old: oldPin, 'new': newPin } }); },
    setSettings: function (patch) { return httpFetch('POST', '/settings', { body: { patch: settingsToApi(patch) } }).then(settingsFromApi); },
    backup: function () { return httpFetch('POST', '/backup'); },
    restore: function (file) {
      if (global.Blob && file instanceof global.Blob) {          // 使用者選檔 → 原始 bytes 上傳
        return httpFetch('POST', '/restore/upload', { body: file });
      }
      return httpFetch('POST', '/restore', { body: { file: file } });  // 伺服器端路徑（相容舊契約）
    },
    /* R1 通用 CSV 匯入：檔案原始 bytes（octet-stream）走兩階段契約——
       mode='preview' 只試算回報告不寫庫；mode='commit' 實際寫入。
       回報告 {ok,mode,committed,rows,新增,可接父,找不到父,跳過,錯誤,
       錯誤清單[],跳過清單[],找不到父清單[],新增房頭[]}。 */
    importData: function (file, mode) {
      return httpFetch('POST', '/import', { body: file, query: { mode: mode || 'preview' } });
    },
    exportData: function (fmt) {
      // 回傳 Blob 供前端觸發下載
      return httpFetch('GET', '/export', { query: { fmt: fmt || 'xlsx' }, raw: true })
        .then(function (res) { if (!res.ok) throw new Error('匯出失敗 ' + res.status); return res.blob(); });
    },
    /* 軟體更新：後端代打 GitHub（僅按下時連網）；下載為 繫族_new.exe＋套用更新.bat */
    checkUpdate: function () { return httpFetch('GET', '/update/check'); },
    downloadUpdate: function () { return httpFetch('POST', '/update/download'); },
    /* 清空示範資料（僅示範資料庫）→ {ok, deleted, kept, backup, message} */
    clearDemo: function () { return httpFetch('POST', '/demo/clear'); }
  };

  /* ========================================================
     六、對外介面 window.KinAPI
     每個方法先 ensureTransport() 決定走 web 或 mock，回傳 Promise。
     ======================================================== */
  function route(fnName, args) {
    return ensureTransport().then(function (isWeb) {
      var impl = isWeb ? web : mock;
      return impl[fnName].apply(impl, args);
    });
  }

  var KinAPI = {
    /* 傳輸資訊（同步可讀；http 未探活前先回 'web'，探活失敗後變 'mock'） */
    transport: function () { return transport; },
    isMock: function () { return transport === 'mock'; },

    /* —— 狀態 / 編輯鎖 —— */
    getState:     function ()                 { return route('getState', []); },
    unlock:       function (pin, branch)      { return route('unlock', [pin, branch]); },
    lock:         function ()                 { return route('lock', []); },

    /* —— 族譜成員 —— */
    listMembers:  function (branch, q, limit) { return route('listMembers', [branch, q, limit]); },   // limit：選人器前 N 筆，省 1.2MB 全量
    getMember:    function (id)               { return route('getMember', [id]); },
    saveMember:   function (data)             { return route('saveMember', [data]); },
    deleteMember: function (id)               { return route('deleteMember', [id]); },

    /* —— 親屬關係管理（雙軌：親生＋過繼/收養並存；婚姻增刪）—— */
    addParent:    function (memberId, parentId, relationType) { return route('addParent', [memberId, parentId, relationType]); },
    removeParent: function (memberId, parentId, relationType) { return route('removeParent', [memberId, parentId, relationType]); },
    addSpouse:    function (memberId, spouseId, status)       { return route('addSpouse', [memberId, spouseId, status]); },
    removeSpouse: function (memberId, spouseId)               { return route('removeSpouse', [memberId, spouseId]); },

    /* —— 稱謂計算 —— */
    kinship:      function (fromId, toId)     { return route('kinship', [fromId, toId]); },

    /* —— 祭祖活動 —— */
    listEvents:   function ()                 { return route('listEvents', []); },
    saveEvent:    function (event)            { return route('saveEvent', [event]); },
    deleteEvent:  function (id)               { return route('deleteEvent', [id]); },
    kinshipBatch: function (toId, ids)        { return route('kinshipBatch', [toId, ids]); },
    lunarOf:      function (d)                { return route('lunarOf', [d]); },
    solarOf:      function (d)                { return route('solarOf', [d]); },   // 農曆 YYYY-MM-DD → {solar, lunar, problem}

    /* —— 穴排位場地（規格 §2.5 場地格線）—— */
    listTombSites:     function ()           { return route('listTombSites', []); },
    getTombSite:       function (id)         { return route('getTombSite', [id]); },
    saveTombSite:      function (site)       { return route('saveTombSite', [site]); },
    deleteTombSite:    function (id)         { return route('deleteTombSite', [id]); },
    exportTombSiteCsv: function (id)         { return route('exportTombSiteCsv', [id]); },
    importTombSiteCsv: function (id, blob)   { return route('importTombSiteCsv', [id, blob]); },

    /* —— 設定 —— */
    getSettings:  function ()                 { return route('getSettings', []); },
    setSettings:  function (patch)            { return route('setSettings', [patch]); },
    setPin:       function (oldPin, newPin)   { return route('setPin', [oldPin, newPin]); },

    /* —— 維運：備份 / 還原 / 匯入 / 匯出 —— */
    backup:       function ()                 { return route('backup', []); },
    restore:      function (file)             { return route('restore', [file]); },
    importData:   function (file, mode)       { return route('importData', [file, mode]); },
    exportData:   function (fmt)              { return route('exportData', [fmt]); },
    checkUpdate:  function ()                 { return route('checkUpdate', []); },
    downloadUpdate: function ()               { return route('downloadUpdate', []); },
    clearDemo:    function ()                 { return route('clearDemo', []); },

    /* —— 事件匯流排 —— */
    on:   on,
    off:  off,
    emit: emit
  };

  /* 就緒點：探活完成後 resolve（web 或 mock 皆 resolve）。
     各視圖可 KinAPI.ready.then(...) 確保傳輸模式已決定再取資料。 */
  KinAPI.ready = ensureTransport().then(function () { return KinAPI; });

  global.KinAPI = KinAPI;
})(typeof window !== 'undefined' ? window : this);
