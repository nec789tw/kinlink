/* ============================================================
   繫族 KinLink — WebView 前端主程式 app.js
   全域：toast / 導覽 / 主題 / 編輯鎖（openLock）
   接著依序貼入 5 段各視圖自包含 IIFE。
   全程不自訂顏色／字體，外觀一律交給 app.css。
   ============================================================ */

/* ── 全域 toast(msg,type) ── */
window.toast = function (msg, type) {
  var host = document.getElementById('toast-host');
  if (!host) return;
  var el = document.createElement('div');
  el.className = 'toast' + (type === 'ok' ? ' toast-ok' : type === 'err' ? ' toast-err' : '');
  el.textContent = msg;
  host.appendChild(el);
  // 進場動畫
  requestAnimationFrame(function () { el.classList.add('show'); });
  // 自動移除；錯誤訊息常列出哪幾筆沒寫入，2.6 秒讀不完——依長度延長（至少 8 秒、最多 20 秒）
  var ms = type === 'err' ? Math.min(20000, Math.max(8000, String(msg).length * 150)) : 2600;
  setTimeout(function () {
    el.classList.remove('show');
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 260);
  }, ms);
};

/* ── 主題 setTheme(v)：light / dark / system ── */
window.setTheme = function (v) {
  var root = document.documentElement;
  var resolved = v;
  if (v === 'system') {
    var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    resolved = prefersDark ? 'dark' : 'light';
  }
  root.setAttribute('data-theme', resolved);
  window.setTheme.pref = v;   // 目前偏好（跟隨系統時，系統色彩一變就重套，見下方啟動段）
  try { localStorage.setItem('kinlink-theme', v); } catch (e) {}
};

/* ── 編輯鎖 openLock(onSuccess)：開啟 modal ──
   文案依傳輸模式呈現真實 PIN 機制：正式（web）模式嚴格比對 settings.edit_pin
   （首次預設 0000）；僅離線展示（mock）模式任意 PIN 皆可解鎖。
   onSuccess（選填）：解鎖成功後自動接續執行的動作（requireEdit 引導流程用）；
   取消或點遮罩關閉即放棄接續。既有無參呼叫行為完全不變。 */
window.openLock = function (onSuccess) {
  var mask = document.getElementById('lock-mask');
  if (!mask) return;
  // 暫存接續動作：由解鎖成功處取用並清除；closeLock（取消）亦清除
  window.openLock._onSuccess = (typeof onSuccess === 'function') ? onSuccess : null;
  var sub = document.getElementById('lock-sub');
  if (sub) {
    var isMock = !!(window.KinAPI && typeof window.KinAPI.isMock === 'function' && window.KinAPI.isMock());
    sub.textContent = isMock
      ? '輸入共用 PIN 進入編輯模式；展示模式任意 PIN 皆可解鎖。'
      : '輸入共用 PIN 進入編輯模式（首次預設 PIN 為 0000，可於「設定 → 編輯鎖」變更）。';
  }
  mask.hidden = false;
  var pin = document.getElementById('lock-pin');
  if (pin) { pin.value = ''; setTimeout(function () { pin.focus(); }, 30); }
};

/* ── 編輯入口引導 requireEdit(actionFn)（編輯入口可見化）──
   常駐可見的編輯入口共用：編輯模式直接執行動作；瀏覽模式先 toast 提示
   並開啟 PIN modal，解鎖成功後自動接續執行原動作（openLock 的 onSuccess）。 */
window.requireEdit = function (actionFn) {
  if (typeof actionFn !== 'function') return;
  if (document.documentElement.getAttribute('data-edit') === 'on') { actionFn(); return; }
  window.toast('請先解鎖編輯模式');
  window.openLock(actionFn);
};

/* ── 展示模式常駐橫幅（首次使用：讓人一眼知道眼前是虛構示範、改了不會存）──
   bridge.js 於 ensureTransport 判定走 mock（file:// 直開或後端探活失敗）
   後 emit 'transport/mock'；此處於 .main 頂端插入常駐 .banner-warn，
   提醒使用者眼前是虛構示範資料、非自己的家族資料。不可關閉（常駐）。 */
(function () {
  if (!window.KinAPI) return;
  function showDemoBanner() {
    if (document.getElementById('demo-banner')) return;   // 冪等：只插一次
    var main = document.querySelector('.main');
    if (!main) return;
    var el = document.createElement('div');
    el.id = 'demo-banner';
    el.className = 'banner banner-warn';
    el.setAttribute('role', 'status');
    el.style.borderRadius = '0';
    el.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>' +
      '<span><strong>展示模式</strong>——此為虛構示範資料，非您的家族資料；請由 繫族.exe 開啟正式模式。</span>';
    main.insertBefore(el, main.firstChild);
  }
  window.KinAPI.on('transport/mock', showDemoBanner);
  // 後援：極端載入順序下事件先於訂閱發出時，以 ready 後的 isMock() 補顯示
  window.KinAPI.ready.then(function () {
    if (window.KinAPI.isMock()) showDemoBanner();
  });
})();

/* ── 開發版警示條（2026-08-20）：原始碼模式讀寫的是專案根的「開發庫」，
   不是 dist 的正式資料。畫面常駐提醒，杜絕改錯資料庫而不自知。
   exe（frozen）與 mock 模式都不會出現。 ── */
(function(){
  if(!window.KinAPI || !window.KinAPI.getState) return;
  window.KinAPI.getState().then(function(st){
    if(!st || !st.devMode) return;
    if(document.getElementById('dev-banner')) return;
    var el = document.createElement('div');
    el.id = 'dev-banner';
    el.className = 'banner banner-info';
    el.style.cssText = 'margin:0;border-radius:0;justify-content:center;background:#7a4a0e;color:#fff';
    el.textContent = '⚠ 工程師測試版（原始碼啟動）：目前讀寫的是專案根目錄的開發用資料庫，不是 dist 的正式資料';
    var main = document.querySelector('.main');
    if(main) main.insertBefore(el, main.firstChild);
  }).catch(function(){});
})();

/* ── 首次使用引導條（D4）──
   exe 正式模式首啟會灌楊家示範資料（settings.demo_data='1'），但畫面上原本
   零提示——長輩不知道眼前是假資料、也不知道第一步該做什麼。
   此條只在「正式模式＋示範資料庫」出現；「設定→清空示範資料」會整鍵刪除
   demo_data，reload 後引導條自然消失，無需清理。不可關閉（與展示模式橫幅同策略）。
   mock 模式的 getSettings 沒有 demo_data 鍵，兩條橫幅結構上互斥、不會同屏。 */
(function () {
  if (!window.KinAPI) return;
  window.KinAPI.ready.then(function () {
    if (window.KinAPI.isMock()) return;   // 展示模式已有自己的橫幅
    return window.KinAPI.getSettings().then(function (s) {
      if (!s || String(s.demo_data || '') !== '1') return;
      if (document.getElementById('firstuse-banner')) return;
      var main = document.querySelector('.main');
      if (!main) return;
      var el = document.createElement('div');
      el.id = 'firstuse-banner';
      el.className = 'banner banner-info';
      el.setAttribute('role', 'status');
      el.style.borderRadius = '0';
      el.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/></svg>' +
        '<span>目前資料庫含有<strong>虛構示範資料</strong>（楊家）。要開始建立自家族譜：先解鎖編輯，' +
        '到「設定 → 清空示範資料」（只刪示範資料，您自己建立的資料會保留，清空前也會自動備份），' +
        '再照操作手冊「第一次使用」四步驟建入自家資料（操作手冊在左邊選單「關於」頁，按「開啟手冊」）。</span>';
      main.insertBefore(el, main.firstChild);
    });
  }).catch(function () { /* 拿不到設定就不顯示，不擋啟動 */ });
})();

/* ── 可重用搜尋式成員選擇器 createMemberPicker(opts) ──────────────
   取代「灌全部成員」的 <select>。型即搜（type-to-search combobox）：
     opts = {
       placeholder : 觸發框佔位字（預設「搜尋姓名、字輩或房…」）
       onSelect    : function(member){}  選定一位時回呼（member 為 listMembers 的一筆）
       branch      : 房頭過濾（傳給 KinAPI.listMembers 的第一參數，預設 ''）
       limit       : 空查詢時顯示前 N 筆（預設 20）
       allowCreate : 選填。查無符合且有輸入文字時，面板尾端顯示可點列
                     「＋ 建立新成員『<輸入文字>』」。true＝單列預設文案；
                     或傳陣列 [{key,label}] 顯示多列（label 內 {name} 代輸入文字，
                     如「加父/母」需分「父／母」兩列）。未傳＝行為完全不變。
       onCreate    : function(name, key){}  點建立列時回呼（配 allowCreate 用；
                     name＝輸入文字、key＝該列 key，單列預設為 ''）
     }
   行為：點開／輸入 → 防抖 ~160ms 呼叫 KinAPI.listMembers(branch||'', q) →
        渲染結果（姓名＋灰色識別 label）→ 點選或 Enter 填回觸發框並 onSelect。
        可清除重選；↑↓ 移動高亮、Enter 選取、Esc 收起。空查詢顯示前 N 筆。
   回傳控制器 { el, getValue, getMember, setMember, clear, focus, destroy }。
   不自訂顏色字體，外觀全由 app.css 的 .mpick* 決定。 */
window.createMemberPicker = function (opts) {
  opts = opts || {};
  var placeholder = opts.placeholder || '搜尋姓名、字輩或房…';
  var onSelect = typeof opts.onSelect === 'function' ? opts.onSelect : function () {};
  var branch = opts.branch || '';
  var limit = typeof opts.limit === 'number' ? opts.limit : 20;
  var allowCreate = opts.allowCreate || null;   // true 或 [{key,label}]；未傳＝不顯示建立列
  var onCreate = typeof opts.onCreate === 'function' ? opts.onCreate : null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // ── DOM 結構 ──
  var el = document.createElement('div');
  el.className = 'mpick';
  el.innerHTML =
    '<div class="mpick-trigger">' +
      '<span class="mpick-current placeholder">' + esc(placeholder) + '</span>' +
      '<input class="mpick-input" type="text" autocomplete="off" spellcheck="false" ' +
        'placeholder="' + esc(placeholder) + '" style="display:none">' +
      '<button class="mpick-clear" type="button" tabindex="-1" aria-label="清除選擇">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>' +
      '</button>' +
      '<svg class="mpick-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>' +
    '</div>' +
    '<div class="mpick-panel" role="listbox"></div>';

  var trigger = el.querySelector('.mpick-trigger');
  var current = el.querySelector('.mpick-current');
  var input   = el.querySelector('.mpick-input');
  var clearBtn= el.querySelector('.mpick-clear');
  var panel   = el.querySelector('.mpick-panel');

  var selected = null;     // 目前選定的 member
  var results = [];        // 目前面板上的清單
  var createRows = [];     // allowCreate：目前面板尾端的「＋ 建立新成員」列
  var activeIdx = -1;      // 鍵盤高亮索引（跨 results＋createRows）
  var debounceT = null;
  var reqSeq = 0;          // 競態防護：只採用最後一次請求結果
  var pending = false;     // 打字後到結果出來之前：按 Enter 不動作（面板上還是上一個關鍵字的結果）

  function isOpen() { return el.classList.contains('open'); }

  function renderResults(list, q) {
    results = list || [];
    activeIdx = -1;
    // allowCreate：查無符合且有輸入文字 → 面板顯示「＋ 建立新成員」可點列
    createRows = [];
    if (allowCreate && onCreate && q && !results.length) {
      var defs = Array.isArray(allowCreate) ? allowCreate : [{ key: '', label: '＋ 建立新成員「{name}」' }];
      createRows = defs.map(function (d) {
        return {
          key: (d && d.key) || '',
          name: q,
          label: String((d && d.label) || '＋ 建立新成員「{name}」').replace('{name}', q)
        };
      });
    }
    if (!results.length && !createRows.length) {
      panel.innerHTML = '<div class="mpick-empty">查無符合的成員</div>';
      return;
    }
    var html = results.map(function (m, i) {
      var tag = m.label && m.label !== m.name ? m.label : '';
      return '<div class="mpick-item" role="option" data-i="' + i + '">' +
        '<span class="nm">' + esc(m.name) + '</span>' +
        (tag ? '<span class="tag">' + esc(tag) + '</span>' : '') +
        '</div>';
    }).join('');
    if (createRows.length) {
      html += '<div class="mpick-empty">查無符合的成員</div>' +
        createRows.map(function (c, j) {
          return '<div class="mpick-item mpick-create" role="option" data-c="' + j + '">' +
            '<span class="nm">' + esc(c.label) + '</span></div>';
        }).join('');
    }
    panel.innerHTML = html;
  }

  function doCreate(c) {
    if (!c) return;
    close();
    if (onCreate) onCreate(c.name, c.key);
  }

  function fetchAndRender(q) {
    if (!q) {
      // 空查詢不倒清單：幾百上千筆用捲的找不到人，一律打字搜尋
      pending = false;
      reqSeq++;                     // 使先前未完成的請求作廢
      results = []; createRows = []; activeIdx = -1;
      panel.innerHTML = '<div class="mpick-empty">輸入姓名、字輩或房頭開始搜尋</div>';
      return;
    }
    var seq = ++reqSeq;
    panel.innerHTML = '<div class="mpick-empty">搜尋中…</div>';
    // 只要前 limit 筆（後端 LIMIT；舊版一開就抓全族上千人、約 1MB、每鍵擊再抓一次）
    window.KinAPI.listMembers(branch || '', q || '', limit).then(function (members) {
      if (seq !== reqSeq) return;   // 已有更新的請求，丟棄此結果
      pending = false;
      renderResults(members || [], q || '');
    }).catch(function () {
      if (seq !== reqSeq) return;
      pending = false;
      panel.innerHTML = '<div class="mpick-empty">載入失敗，請稍後再試</div>';
    });
  }

  function open() {
    if (isOpen()) return;
    el.classList.add('open');
    current.style.display = 'none';
    input.style.display = '';
    input.value = '';
    input.focus();
    fetchAndRender('');   // 空查詢顯示前 N 筆
  }

  function close() {
    if (!isOpen()) return;
    el.classList.remove('open');
    input.style.display = 'none';
    current.style.display = '';
    activeIdx = -1;
  }

  function showCurrent() {
    if (selected) {
      var tag = selected.label && selected.label !== selected.name ? selected.label : '';
      current.classList.remove('placeholder');
      current.innerHTML = esc(selected.name) +
        (tag ? '<span class="mpick-tag">' + esc(tag) + '</span>' : '');
      el.classList.add('has-value');
    } else {
      current.classList.add('placeholder');
      current.textContent = placeholder;
      el.classList.remove('has-value');
    }
  }

  function choose(m) {
    selected = m;
    showCurrent();
    close();
    onSelect(m);
  }

  function setActive(i) {
    var items = panel.querySelectorAll('.mpick-item');
    if (!items.length) return;
    if (i < 0) i = items.length - 1;
    if (i >= items.length) i = 0;
    activeIdx = i;
    items.forEach(function (it, j) { it.classList.toggle('active', j === i); });
    items[i].scrollIntoView({ block: 'nearest' });
  }

  // ── 互動 ──
  trigger.addEventListener('click', function (e) {
    if (e.target === clearBtn || clearBtn.contains(e.target)) return;
    if (!isOpen()) open();
  });

  input.addEventListener('input', function () {
    var q = input.value.trim();
    pending = !!q;
    clearTimeout(debounceT);
    debounceT = setTimeout(function () { fetchAndRender(q); }, 160);
  });

  input.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(activeIdx + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(activeIdx - 1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (pending) return;            // 結果還沒出來：不選（2026-10-13 審查：會選到上一個關鍵字的人）
      var idx = activeIdx >= 0 ? activeIdx : 0;
      if (idx < results.length && results[idx]) choose(results[idx]);
      else doCreate(createRows[idx - results.length]);   // 高亮落在「＋ 建立新成員」列
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });

  panel.addEventListener('mousedown', function (e) {
    // 用 mousedown 以搶在 input blur 之前處理
    var item = e.target.closest('.mpick-item');
    if (!item) return;
    e.preventDefault();
    var cj = item.getAttribute('data-c');
    if (cj != null) { doCreate(createRows[Number(cj)]); return; }   // 「＋ 建立新成員」列
    var m = results[Number(item.getAttribute('data-i'))];
    if (m) choose(m);
  });

  clearBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    selected = null;
    showCurrent();
    onSelect(null);
  });

  // 點外面收起
  function onDocMouseDown(e) {
    if (!el.contains(e.target)) close();
  }
  document.addEventListener('mousedown', onDocMouseDown);

  showCurrent();

  return {
    el: el,
    getValue: function () { return selected ? selected.id : ''; },
    getMember: function () { return selected; },
    setMember: function (m) { selected = m || null; showCurrent(); },
    clear: function () { selected = null; showCurrent(); },
    focus: function () { open(); },
    destroy: function () { document.removeEventListener('mousedown', onDocMouseDown); }
  };
};

(function () {
  /* ── 載入時套用已存主題（system 需動態解析）──
     localStorage 只是快取（先套上免得閃一下）；真正的值是後端 settings.theme，由設定頁初始化
     取回後再套一次（M-9／體檢 frontend-5：每次開程式網址埠都不同，localStorage 以網址區隔，
     快取多半讀不到——舊版因此每次重開都回淺色，設定頁按鈕卻亮著「深色」）。 */
  var savedTheme = 'light';
  try { savedTheme = localStorage.getItem('kinlink-theme') || 'light'; } catch (e) {}
  window.setTheme(savedTheme);
  // 同步設定頁 .seg 的 .on 狀態
  document.addEventListener('DOMContentLoaded', function () {
    var seg = document.getElementById('settings-themeSeg');
    if (seg) {
      seg.querySelectorAll('button').forEach(function (b) {
        b.classList.toggle('on', b.getAttribute('data-theme') === savedTheme);
      });
    }
  });
  // 偏好為 system 時，跟隨系統色彩變化即時更新（偏好可能事後才由後端設定改成 system，所以一律掛上）
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var onChange = function () { if (window.setTheme.pref === 'system') window.setTheme('system'); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  /* ── 導覽：點 .nav-item 切換視圖 ── */
  var navItems = document.querySelectorAll('.nav-item');
  var views = document.querySelectorAll('.view-host .view');
  var titleEl = document.getElementById('view-title');

  function activate(viewId, label) {
    navItems.forEach(function (n) { n.classList.toggle('active', n.getAttribute('data-view') === viewId); });
    views.forEach(function (v) { v.classList.toggle('active', v.getAttribute('data-view') === viewId); });
    if (titleEl && label) titleEl.textContent = label;
  }

  navItems.forEach(function (item) {
    item.addEventListener('click', function () {
      var viewId = item.getAttribute('data-view');
      var lblEl = item.querySelector('.lbl');
      var label = lblEl ? lblEl.textContent.trim() : '';
      activate(viewId, label);
    });
  });

  /* ── 編輯鎖：modal 互動與 .lock-state 切換（接 KinAPI.unlock/lock）── */
  var mask = document.getElementById('lock-mask');
  var lockState = document.getElementById('lock-state');

  // 僅同步 DOM 顯示（不直接驅動後端），由 KinAPI 的 editMode 為準。
  // branch 非空時於「編輯中」下一行標示目前編輯範圍（R2 房頭護欄），例「編輯中／長房」兩行。
  function reflectEditing(on, branch) {
    document.documentElement.setAttribute('data-edit', on ? 'on' : 'off');
    if (lockState) {
      lockState.classList.toggle('editing', on);
      var txt = lockState.querySelector('.lock-state-txt');
      // 側欄只有 60px 可用：編輯時「編輯中」與房頭刻意分兩行（white-space:pre-line），免得被截成「編輯中·長…」
      if (txt) txt.textContent = on ? ('編輯中' + (branch ? '\n' + branch : '')) : '瀏覽模式';
    }
    // 頂部常駐狀態列同步標示編輯範圍（鎖定單一房時明講，避免以為能改全族）
    var scope = document.getElementById('edit-bar-scope');
    if (scope) {
      scope.hidden = !(on && branch);
      if (on && branch) scope.textContent = '編輯範圍：' + branch;
    }
  }

  function closeLock() {
    if (mask) mask.hidden = true;
    // 關閉即放棄 requireEdit 的接續動作（取消／點遮罩）；成功路徑已先取出
    if (window.openLock) window.openLock._onSuccess = null;
  }

  // 點側欄 .lock-state：若已在編輯則呼叫 lock 退出；否則開啟 modal
  if (lockState) {
    lockState.addEventListener('click', function () {
      var editing = document.documentElement.getAttribute('data-edit') === 'on';
      if (editing) {
        if (window.KinAPI) {
          window.KinAPI.lock().then(function () {
            // 同 unlock：web 模式由前端補發事件讓全站同步（mock 重複無害）
            window.KinAPI.emit('lock/changed', { editMode: false, branch: '' });
            window.toast('已退出編輯模式，回到瀏覽', 'ok');
          }).catch(function () { window.toast('退出編輯失敗', 'err'); });
        } else {
          reflectEditing(false);
          window.toast('已退出編輯模式，回到瀏覽', 'ok');
        }
      } else {
        window.openLock();
      }
    });
  }

  // 頂部狀態列的「完成，鎖定」＝與側欄鎖定同一動作（長輩不必找左下角小字）
  var edLock = document.getElementById('edit-bar-lock');
  if (edLock && lockState) {
    edLock.addEventListener('click', function () { lockState.click(); });
  }

  if (mask) {
    var cancelBtn = document.getElementById('lock-cancel');
    var unlockBtn = document.getElementById('lock-unlock');
    var pinIn     = document.getElementById('lock-pin');
    var branchSel = document.getElementById('lock-branch');
    if (cancelBtn) cancelBtn.addEventListener('click', closeLock);
    if (unlockBtn) {
      unlockBtn.addEventListener('click', function () {
        var pin = pinIn ? pinIn.value : '';
        var branch = branchSel ? branchSel.value : '';
        if (!window.KinAPI) {
          var next0 = window.openLock._onSuccess || null;   // 先取出（closeLock 會清除）
          reflectEditing(true); closeLock(); window.toast('已進入編輯模式', 'ok');
          if (next0) setTimeout(next0, 0);                  // 接續 requireEdit 的原動作
          return;
        }
        unlockBtn.disabled = true;
        window.KinAPI.unlock(pin, branch).then(function (res) {
          unlockBtn.disabled = false;
          if (res && res.ok) {
            var next = window.openLock._onSuccess || null;  // 先取出（closeLock 會清除）
            closeLock();
            // web 模式後端不主動推事件 → 由前端補發 lock/changed，
            // 讓 lock-state（含 R2 編輯範圍「·房」標示）與各視圖全站同步；
            // mock 模式 bridge 已發過一次，重複廣播同一狀態無副作用。
            window.KinAPI.emit('lock/changed', { editMode: true, branch: branch || '' });
            window.toast('已進入編輯模式' + (branch ? '（限「' + branch + '」範圍）' : '（全部房頭）'), 'ok');
            // emit 為同步，此刻 data-edit 已是 on；下一輪自動接續原動作（如開表單）
            if (next) setTimeout(next, 0);
          } else {
            window.toast('PIN 驗證失敗，請重新輸入', 'err');
            if (pinIn) { pinIn.value = ''; pinIn.focus(); }
          }
        }).catch(function () {
          unlockBtn.disabled = false;
          window.toast('解鎖失敗，請稍後再試', 'err');
        });
      });
    }
    // 點遮罩空白處關閉
    mask.addEventListener('click', function (e) {
      if (e.target === mask) closeLock();
    });
  }

  // ── 以 KinAPI 狀態還原編輯鎖，並訂閱 lock/changed 讓全站同步 ──
  if (window.KinAPI) {
    window.KinAPI.ready.then(function () {
      return window.KinAPI.getState();
    }).then(function (st) {
      reflectEditing(!!(st && st.editMode), (st && st.branch) || '');
    }).catch(function () { reflectEditing(false); });

    window.KinAPI.on('lock/changed', function (st) {
      reflectEditing(!!(st && st.editMode), (st && st.branch) || '');
    });
  }
})();

/* ============================================================
   房頭（房份）動態下拉 —— 取代寫死的「長房／次房／三房」。
   單一資料來源：KinAPI.getSettings().branches（陣列）。
   負責把房頭選項灌進「族譜頁房頭篩選 #tree-branch」與
   「編輯鎖進入房頭 #lock-branch」兩個下拉；並對外開放
   window.KinBranches.list() 供其他視圖（如房頭管理）共用。
   訂閱 settings/changed：房頭一改即時刷新所有下拉，免重整頁面。
   ============================================================ */
(function () {
  if (!window.KinAPI) return;

  var BRANCHES = [];                 // 目前房頭快取（陣列）
  // 需被填充的下拉：第一個 <option value=""> 為「全部房頭」保留，其後動態產生
  // （含列印視圖「牌位姓名表／通知名單／信封片頭」的房頭下拉；祭祖通知作業台「某房」的
  //   第一個選項是「請選擇房頭」——M-7：舊版自己在載入當下填一次，那時房頭還沒取回，永遠是空的）
  var SELECT_IDS = ['tree-branch', 'lock-branch', 'print-tablet-branch', 'print-roster-branch', 'print-labels-branch',
                    'ritual-scope-branch'];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // 把房頭灌進單一 <select>，保留既有選取值（若該房頭仍存在）。
  function fillSelect(sel) {
    if (!sel) return;
    var keep = sel.value;
    // 保留第一個「全部房頭」空值選項，移除其餘
    while (sel.options.length > 1) sel.remove(1);
    for (var i = 0; i < BRANCHES.length; i++) {
      var opt = document.createElement('option');
      opt.value = BRANCHES[i];
      opt.textContent = BRANCHES[i];
      sel.appendChild(opt);
    }
    // 還原先前選取（房頭被刪則回退到「全部房頭」）
    sel.value = (keep && BRANCHES.indexOf(keep) >= 0) ? keep : '';
  }

  function fillAll() {
    for (var i = 0; i < SELECT_IDS.length; i++) {
      fillSelect(document.getElementById(SELECT_IDS[i]));
    }
  }

  // 從 settings 取 branches（容忍缺鍵或非陣列）→ 更新快取並刷新下拉
  function refresh() {
    return window.KinAPI.getSettings().then(function (s) {
      var arr = (s && s.branches) || [];
      BRANCHES = Object.prototype.toString.call(arr) === '[object Array]' ? arr.slice() : [];
      fillAll();
      return BRANCHES.slice();
    }).catch(function () { BRANCHES = []; fillAll(); return []; });
  }

  // 對外：供房頭管理視圖讀取目前房頭、或主動觸發刷新
  window.KinBranches = {
    list: function () { return BRANCHES.slice(); },
    refresh: refresh,
    esc: esc
  };

  // 初次載入填充；房頭設定變動時即時重填（新增／刪除房頭立刻反映於下拉）
  window.KinAPI.ready.then(refresh);
  window.KinAPI.on('settings/changed', function (s) {
    if (s && Object.prototype.hasOwnProperty.call(s, 'branches')) {
      var arr = s.branches || [];
      BRANCHES = Object.prototype.toString.call(arr) === '[object Array]' ? arr.slice() : [];
      fillAll();
    }
  });
})();

/* ============================================================
   視圖 1：族譜 tree —— 向 KinAPI.listMembers/getMember 取資料
   後端為扁平陣列，前端依 gen+fatherName 自行組樹。
   ============================================================ */
(function(){
  var root = document.querySelector('section[data-view="tree"]');
  if(!root || !window.KinAPI) return;

  // ── DOM 參照 ──
  var listEl   = root.querySelector('#tree-list');
  var searchEl = root.querySelector('#tree-search');
  var branchEl = root.querySelector('#tree-branch');
  var segEl    = root.querySelector('#tree-seg');
  var addBtn   = root.querySelector('#tree-add');
  var mdAva    = root.querySelector('#tree-md-ava');
  var mdNm     = root.querySelector('#tree-md-nm');
  var mdSub    = root.querySelector('#tree-md-sub');
  var mdGrid   = root.querySelector('#tree-md-grid');
  var mdExpand = root.querySelector('#tree-md-expand');  // 詳情卡「展開這一支」：選了有子孫的人才出現
  var mdEdit   = root.querySelector('#tree-md-edit');   // 詳情卡「編輯」鈕（常駐可見；瀏覽模式由 requireEdit 引導解鎖）

  var curSel = null;   // 目前詳情卡顯示的成員（清單投影或 getMember 詳情）
  var viewMode = 'list';   // 「列表／樹狀」目前檢視模式（seg 真切換）

  // 世代 1..99 → 中文數字（14→十四、20→二十、21→二十一）；與後端 members._cn_num、print.html cnNum 同規則。
  // 舊版只對到六，第十一世起算的族譜整頁都是阿拉伯數字。純函式（測試用 node 抽出來跑）。
  function genCn(g){
    var n = Number(g);
    if(!(n >= 1 && n <= 99) || n !== Math.floor(n)) return g == null ? '' : String(g);
    var D = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
    if(n < 10) return D[n];
    var t = Math.floor(n / 10), o = n % 10;
    return (t === 1 ? '十' : D[t] + '十') + D[o];
  }
  // 列表用的生卒「年份」：1921-03-04／1988/5/6 → 1921–1988；在世 → 1950–；卒年不詳（哨兵「已歿」）→ 1921–？
  // 只取開頭四位數年份；看不懂（農曆原文、空白）就留空，完整日期在詳情卡。純函式。
  function lifeYears(m){
    function yr(s){ var p = /^\s*(\d{4})/.exec(String(s == null ? '' : s)); return p ? p[1] : ''; }
    var b = yr(m.birth), d = yr(m.death) || '？';
    if(m.alive) return b ? b + '–' : '';
    if(!b && d === '？') return '';
    return (b || '？') + '–' + d;
  }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
  function isF(m){ return m.gender === 'F'; }
  function blank(v){ return v === '' || v === null || v === undefined; }
  // 已過世、卒年不詳的哨兵值（death_date 非 NULL＝已歿；與 CSV 匯入、既有整理工具同一個字）
  var DEATH_UNKNOWN = '已歿';
  // 頭像字＝名字第二個字；先去掉空白（族譜原文常在單名中間空一格對齊，如「陳 甲」，舊版取到空白、頭像變空的）
  function avatarChar(m){
    var n = String(m.name || '').replace(/\s+/g, '');
    return n.length > 1 ? n.charAt(1) : n.charAt(0);
  }
  // 生卒字串（清單卡用 birth/death 字串即可）
  function lifeText(m){
    var b = blank(m.birth) ? '—' : m.birth;
    var d = m.alive ? '迄今' : (blank(m.death) ? '—' : m.death);
    return b + ' － ' + d;
  }

  // ── 由扁平陣列組樹：以 fatherId 比對 parent→children（真實邊，免同名/嗣子斷裂）──
  function buildForest(members){
    var byId = {};        // id -> node
    var nodes = [];
    members.forEach(function(m){
      var node = { m: m, kids: [] };
      nodes.push(node);
      byId[m.id] = node;
    });
    // node 是否「有父可掛」（父節點存在於本次資料集內）
    function hasFather(node){
      var fid = node.m.fatherId;
      return fid != null && byId[fid] && byId[fid] !== node;
    }
    // 配偶互掛守門：夫妻雙方皆無父時，A 掛 B.kids、B 又掛 A.kids 會互為子節點
    // 成環，兩人與整條後代子樹從根遍歷永遠走不到（靜默消失）。故只掛一邊：
    //   有父者為主（無父方掛過去）；皆無父則男方為主；再平手取 id 小者為主。
    // 回傳 true 表示「本節點應掛到配偶底下」（自己是從屬方）。
    function shouldMountToSpouse(node, spouseNode){
      if(hasFather(spouseNode)) return true;    // 對方有父（已在樹內）→ 自己掛過去
      // 對方雖無父，但會沿自己的配偶鏈掛進樹（如入贅夫：妻先掛回本家）→ 跟著掛過去
      var oid = spouseNode.m.spouseOfId;
      var other = (oid != null) ? byId[oid] : null;
      if(other && other !== spouseNode && hasFather(other) && !hasFather(node)) return true;
      var a = node.m, b = spouseNode.m;
      if(a.gender === 'M' && b.gender !== 'M') return false;  // 自己為男方 → 自己為主，不掛
      if(b.gender === 'M' && a.gender !== 'M') return true;   // 對方為男方 → 掛到對方底下
      return a.id > b.id;                       // 平手：id 小者為主，id 大者掛過去
    }
    var roots = [];
    nodes.forEach(function(node){
      var fid = node.m.fatherId;
      if(fid != null && byId[fid] && byId[fid] !== node){ byId[fid].kids.push(node); node.up = byId[fid]; return; }
      var sid = node.m.spouseOfId;   // 無父者：若是配偶，掛在配偶底下，不浮在樹頂
      if(sid != null && byId[sid] && byId[sid] !== node && shouldMountToSpouse(node, byId[sid])){
        node.spouseNode = true; byId[sid].kids.push(node); node.up = byId[sid]; return;
      }
      roots.push(node);   // 真正無父無配者（始遷祖或孤兒）與配偶對中的「主方」才是根
    });
    // 可達性掃描（保險網）：從根不可達者（任何異常資料形態）先斷開其掛載邊
    // （防環）再強制補進 roots，保證任何資料形態都不丟人。
    var reached = {};
    function markReach(n){
      if(reached[n.m.id]) return;
      reached[n.m.id] = true;
      for(var i = 0; i < n.kids.length; i++) markReach(n.kids[i]);
    }
    roots.forEach(markReach);
    nodes.forEach(function(node){
      if(reached[node.m.id]) return;
      if(node.up){
        var idx = node.up.kids.indexOf(node);
        if(idx >= 0) node.up.kids.splice(idx, 1);
        node.up = null;
      }
      roots.push(node);
      markReach(node);
    });
    // 子嗣依世代、生日排序。生日不能直接比字串（H-2）：Excel 另存的 1960/5/1、
    // 表單手打的 1960-5-1 會排到 1960-11-20 之後。先解析成年月日（容 / . 分隔與全形）；
    // 只有年份的排同年之後，空白或看不懂的墊底，同值以 id 決勝（排序穩定）。
    // 與後端 members._birth_sort_key 同一套規則。
    function birthKey(s){
      var t = String(s == null ? '' : s).trim().replace(/[０-９－／．]/g, function(c){
        return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
      });
      var p = /^(\d{4})(?:[-\/.](\d{1,2})(?:[-\/.](\d{1,2}))?)?$/.exec(t);
      if(!p) return [1, 0, 0, 0];
      return [0, +p[1], p[2] ? +p[2] : 13, p[3] ? +p[3] : 32];
    }
    function kidOrder(a, b){
      if(a.m.gen !== b.m.gen) return a.m.gen - b.m.gen;
      var ka = birthKey(a.m.birth), kb = birthKey(b.m.birth);
      for(var i = 0; i < ka.length; i++){ if(ka[i] !== kb[i]) return ka[i] - kb[i]; }
      return (a.m.id || 0) - (b.m.id || 0);
    }
    function sortKids(node){
      node.kids.sort(kidOrder);
      node.kids.forEach(sortKids);
    }
    roots.sort(function(a,b){ return (a.m.gen||0) - (b.m.gen||0); });
    roots.forEach(sortKids);
    return roots;
  }

  // ── 渲染列表（直式可展開）──
  function build(nodes){
    var frag = document.createDocumentFragment();
    nodes.forEach(function(node){ frag.appendChild(buildNode(node)); });
    return frag;
  }
  // 懶建子節點：第一次展開時才把該層子女建進 DOM（之後 _kids 清空、不重建）。
  // 任何「以程式展開」的路徑（locateInTree、搜尋全展開、選第一筆）都要先呼叫。
  function ensureKids(node){
    if(!node || !node._kids) return;
    var box = node.querySelector(':scope > .kids');
    if(box) box.appendChild(build(node._kids));
    node._kids = null;
  }
  function buildNode(treeNode){
    var m = treeNode.m;
    var hasKids = treeNode.kids && treeNode.kids.length;
    var node = document.createElement('div');
    node.className = 'tnode';
    node._member = m;
    node.setAttribute('data-mid', m.id);   // 供 locateInTree 以 id 直接定位節點

    var row = document.createElement('div');
    row.className = 'trow';
    row.setAttribute('role','treeitem');

    var avaCls = 'ava' + (isF(m)?' f':'') + (m.alive?'':' past');
    var statusChip = m.alive
      ? '<span class="chip chip-ok">在世</span>'
      : '<span class="chip chip-past">已歿</span>';
    var sexChip = isF(m)
      ? '<span class="chip chip-muted">女</span>'
      : '<span class="chip chip-muted">男</span>';
    // 外姻標註優先（媳／女婿，後端 inlaw 欄）；無標註的配偶掛載者仍顯示「配偶」
    var spouseChip = m.inlaw ? '<span class="chip chip-accent">' + esc(m.inlaw) + '</span>'
                   : (treeNode.spouseNode ? '<span class="chip chip-accent">配偶</span>' : '');
    // 世代只寫一次（舊版「第X代」chip 後面又接一次「第X代 · 房 · 父名」）
    var idTag = '第'+genCn(m.gen)+'世'+(!blank(m.branch)&&m.branch!=='本宗'?' · '+m.branch:'')+(!blank(m.fatherName)?' · '+m.fatherName:'');
    var yrs = lifeYears(m);

    // 一人一行（2026-10-03 總幹事：小標籤全部保留，只壓成一行；放不下才折行）。
    // 展開箭頭是獨立按鈕：點列＝選人（必要時順便展開、永不收合），收合只能按箭頭。
    row.innerHTML =
      '<button type="button" class="caret-btn"'+(hasKids?' aria-expanded="false" aria-label="展開或收合子女"':' tabindex="-1" aria-hidden="true"')+'>'+
        '<svg class="caret'+(hasKids?'':' leaf')+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>'+
      '</button>'+
      '<div class="'+avaCls+'">'+esc(avatarChar(m))+'</div>'+
      '<div class="who">'+
        '<span class="nm">'+esc(m.name)+(!blank(m.styleName)?' <span class="style-name">字 '+esc(m.styleName)+'</span>':'')+'</span>'+
        '<span class="meta">'+
          '<span class="id-tag">'+esc(idTag)+'</span>'+
          spouseChip + sexChip + statusChip +
          (yrs ? '<span class="yrs">'+esc(yrs)+'</span>' : '')+
        '</span>'+
      '</div>';

    node.appendChild(row);

    if(hasKids){
      // 懶建：先只放空的 .kids 容器，實際子節點等展開時才建（見 ensureKids）。
      // 舊版一次遞迴建完整棵樹＝全族上千人時數萬個 DOM 元素，首次載入明顯卡頓。
      var kids = document.createElement('div');
      kids.className = 'kids';
      node.appendChild(kids);
      node._kids = treeNode.kids;
    }

    var caretBtn = row.querySelector('.caret-btn');
    function setOpen(open){
      if(!hasKids) return;
      if(open) ensureKids(node);
      node.classList.toggle('open', open);
      if(caretBtn) caretBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    node._setOpen = setOpen;   // 程式展開（locateInTree 等）也同步箭頭的 aria-expanded
    if(caretBtn && hasKids) caretBtn.addEventListener('click', function(e){
      e.stopPropagation();     // 只開合，不選人
      setOpen(!node.classList.contains('open'));
    });
    row.addEventListener('click', function(){
      // 搜尋／房頭過濾狀態下，結果集組不出完整樹（祖先被濾掉、全攤平）：
      // 點擊改走 locateInTree —— 清空過濾、重建全樹、展開祖先鏈並捲動定位。
      var filtering = !!((searchEl.value || '').trim() || branchEl.value);
      if(filtering){ locateInTree(m.id); return; }
      // 舊版點列＝切換開合：想再看一次祖先的資料，底下好不容易展開的子孫就全收起來
      if(hasKids && !node.classList.contains('open')) setOpen(true);
      select(m, row);
    });

    return node;
  }
  // 以程式展開某節點（懶建子節點＋同步箭頭狀態）；沒有子女的節點不動
  function openNode(nodeEl){
    if(!nodeEl) return;
    if(nodeEl._setOpen) nodeEl._setOpen(true);
    else { ensureKids(nodeEl); nodeEl.classList.add('open'); }
  }

  function clearSel(){
    listEl.querySelectorAll('.trow.sel').forEach(function(r){ r.classList.remove('sel'); });
  }

  function select(m, row){
    clearSel();
    if(row) row.classList.add('sel');
    dgSelId = m.id;                      // 列表與樹狀圖共用同一個選取（切過去不會跟丟人）
    if(dgFindBtn) dgFindBtn.disabled = false;
    // 先以清單資料速繪，再以 getMember 補完詳情（雙曆、電話、安葬等）
    renderDetail(m);
    window.KinAPI.getMember(m.id).then(function(detail){
      // 連點兩人時慢的那筆回來會蓋掉快的：只在使用者仍停在同一人時才補完
      if(!detail || !curSel || curSel.id !== m.id) return;
      // 詳情沒有掛靠父／配偶 id：沿用清單投影的，副標兩次才會一樣（不閃字）
      if(detail.fatherId === undefined) detail.fatherId = m.fatherId;
      if(detail.spouseOfId === undefined) detail.spouseOfId = m.spouseOfId;
      renderDetail(detail);
    }).catch(function(){ /* 保留清單速繪結果 */ });
  }

  // ── 搜尋結果導航回全樹：清空過濾 → 重載全量重建全樹 → 展開祖先鏈 →
  //    目標列選取並捲動置中 → renderDetail（經 select 補完詳情）──
  function locateInTree(id){
    searchEl.value = '';
    branchEl.value = '';
    return load('', '').then(function(){
      if(!lastMembers.length) return;
      // 以全量 lastMembers 建 id → member 快查表
      var byId = {};
      lastMembers.forEach(function(mm){ byId[mm.id] = mm; });
      if(!byId[id]){
        if(typeof toast === 'function') toast('找不到該成員於族譜樹中', 'err');
        return;
      }
      // 沿 fatherId 鏈向上收集祖先；無父者若以配偶掛載（buildForest 的
      // spouseOf 分支），則經 spouseOfId 續上溯，確保媳婦／入贅者也能定位。
      var chainIds = lineageOf(id, byId);
      // 由始祖往下逐層展開祖先鏈；懶建下，必須先 ensureKids 才找得到下一層節點
      for(var i = chainIds.length - 1; i >= 0; i--){
        var nodeEl = listEl.querySelector('.tnode[data-mid="' + chainIds[i] + '"]');
        if(nodeEl) openNode(nodeEl);
      }
      var targetEl = listEl.querySelector('.tnode[data-mid="' + id + '"]');
      if(!targetEl){
        if(typeof toast === 'function') toast('找不到該成員於族譜樹中', 'err');
        return;
      }
      var row = targetEl.querySelector('.trow');   // 第一個 .trow 即節點自身列
      select(targetEl._member || byId[id], row);
      if(viewMode === 'diagram'){
        // 樹狀圖模式（搜尋結果、各房始祖鈕、詳情卡點親屬）：
        //   本支家系 → 焦點移到這個人，畫他的一家；
        //   全族總覽 → 展開目標的祖先鏈摺疊、重建圖，置中高亮該節點（與列表 scrollIntoView 同精神）。
        if(dgMode === 'family'){
          dgFocusId = dgSpouseHost[id] || id;
        } else {
          for(var ci = 1; ci < chainIds.length; ci++) dgFoldOv[chainIds[ci]] = false;
        }
        dgLayoutDirty = true;
        applyViewMode();
        dgSetSel(id);
        // 家系圖重建時已適配整張（放得下就整張置中）；再以焦點置中反而把右半邊推出畫面
        if(dgMode !== 'family' || dgUserMoved) dgCenter(id);
      } else if(row){
        row.scrollIntoView({ block: 'center' });
      }
    });
  }

  // ── 各房始祖快速跳轉（族譜頁工具列；總幹事 2026-10-03：「大房二房三房應該要能直接點選，跳到始祖」）──
  // 始祖＝該房裡「父親不屬於這一房」的人，取世代最高（數字最小）者，同世代取 id 小者——
  // 常見情形是「不分房的共同祖先底下的幾個兒子各開一房」。不寫死人名，別的家族照樣適用。
  // 該房最上層沒登錄父親時，退回該房世代最高、底下有子女的非外姻成員；都沒有回 null。
  function branchFounderId(members, branch){
    var byId = {}, hasKids = {};
    members.forEach(function(m){ byId[m.id] = m; if(m.fatherId != null) hasKids[m.fatherId] = true; });
    function first(list){
      list.sort(function(a, b){ return ((a.gen || 999) - (b.gen || 999)) || (a.id - b.id); });
      return list.length ? list[0].id : null;
    }
    var mine = members.filter(function(m){ return m.branch === branch && !m.inlaw; });
    var top = mine.filter(function(m){
      var f = m.fatherId != null ? byId[m.fatherId] : null;
      return f && f.branch !== branch;
    });
    return first(top.length ? top : mine.filter(function(m){ return m.fatherId == null && hasKids[m.id]; }));
  }
  var jumpEl = root.querySelector('#tree-branch-jump');
  function renderBranchJump(){
    if(!jumpEl) return;
    var list = window.KinBranches ? window.KinBranches.list() : [];
    // 前面加看得見的標籤：一排房名按鈕，長輩分不出是「篩選」還是「跳過去」
    jumpEl.innerHTML = (list.length ? '<span class="jump-lbl">跳到各房始祖：</span>' : '') + list.map(function(b){
      return '<button type="button" class="btn btn-sm btn-ghost" data-branch="' + esc(b) + '" title="跳到' + esc(b) + '的始祖">' + esc(b) + '</button>';
    }).join('');
    jumpEl.hidden = !list.length;
  }
  if(jumpEl) jumpEl.addEventListener('click', function(e){
    var btn = e.target.closest ? e.target.closest('button[data-branch]') : null;
    if(btn) jumpToBranch(btn.getAttribute('data-branch'));
  });
  // 跳到某房始祖（工具列的房頭鈕、樹狀圖下方「框線顏色」的房名都走這裡）
  function jumpToBranch(b){
    // 始祖要在全族資料裡找：目前清單被搜尋或房頭篩選過才重抓（舊版不論如何都多抓一次全族）
    (lastFiltered || !lastMembers.length ? load('', '') : Promise.resolve()).then(function(){
      var id = branchFounderId(lastMembers, b);
      if(id == null){
        if(typeof toast === 'function') toast('找不到「' + b + '」的始祖：請確認這一房有人登錄了房頭與父親', 'err');
        return;
      }
      locateInTree(id);
    });
  }
  window.KinAPI.ready.then(function(){ return window.KinBranches ? window.KinBranches.refresh() : null; })
    .then(renderBranchJump, renderBranchJump);
  window.KinAPI.on('settings/changed', function(s){
    if(s && Object.prototype.hasOwnProperty.call(s, 'branches')) renderBranchJump();
  });

  // 雙曆徽章（R3：「農」優先顯示後端農曆換算值（borax），無換算值時維持原始記載原文）
  function calBadge(solar, lunar){
    var out = '';
    if(!blank(solar)) out += '<span class="cal-badge cal-solar">國 '+esc(solar)+'</span>';
    if(!blank(lunar)) out += '<span class="cal-badge cal-lunar">農 '+esc(lunar)+'</span>';
    return out || '<span class="dim">—</span>';
  }

  // 詳情卡副標：用白話講「這個人怎麼接上族譜」（速繪的清單投影與補完的 getMember 用同一套，兩次結果相同）。
  //   ① 有父名 → 「某某 之子／之女」；② 只經由母親接上（外孫等）→ 「母名 之子／之女」；
  //   ③ 嫁娶進來的配偶 → 「某某 之妻／之夫」；④ 全族最小世代 → 「始遷祖」；⑤ 其餘 → 「尚未登錄父母」。
  // 舊版②③都寫內部用語「父系待補」（約一千一百人），看起來像漏登。
  // ③只看外姻標記 inlaw，不看 spouseOfId——否則有配偶的始遷祖會被標成「某某 之夫」。
  function nameOfId(id){
    if(id == null) return '';
    var p = fullById[id];
    if(p) return p.name || '';
    for(var i = 0; i < lastMembers.length; i++) if(lastMembers[i].id === id) return lastMembers[i].name || '';
    return '';
  }
  function detailSubtitle(m){
    var bits = ['第' + genCn(m.gen) + '世'];
    if(!blank(m.branch) && m.branch !== '本宗') bits.push(m.branch);
    var kid = m.gender === 'F' ? ' 之女' : ' 之子';
    if(!blank(m.fatherName)){ bits.push(m.fatherName + kid); return bits.join(' · '); }
    var mom = nameOfId(m.fatherId);   // 沒有父名時，掛靠親代就是母親（或性別未設定的親代）
    if(!mom && m.parents && m.parents.length) mom = m.parents[0].name || '';
    if(mom){ bits.push(mom + kid); return bits.join(' · '); }
    if(m.inlaw){
      var sp = nameOfId(m.spouseOfId);
      if(!sp && m.spouses && m.spouses.length) sp = m.spouses[0].name || '';
      if(sp){ bits.push(sp + (m.gender === 'F' ? ' 之妻' : ' 之夫')); return bits.join(' · '); }
    }
    // 始遷祖只認「全族」最小世代：搜尋／房頭過濾後的清單會把中間世代的人誤判成始遷祖
    bits.push(fullMinGen !== null && Number(m.gen) === fullMinGen ? '始遷祖' : '尚未登錄父母');
    return bits.join(' · ');
  }

  function renderDetail(m){
    curSel = m;                          // 記住目前選取者，供「編輯」鈕開表單
    if(mdEdit) mdEdit.disabled = false;  // 有選取成員後才可按（未選人維持 disabled）
    ['tree-md-family', 'tree-md-addchild'].forEach(function(bid){   // 「一家人」「＋新增子女」選了人才出現
      var b = document.getElementById(bid); if(b) b.hidden = false; });
    mdAva.className = 'ava' + (isF(m)?' f':'') + (m.alive?'':' past');
    mdAva.textContent = avatarChar(m);
    mdNm.innerHTML = esc(m.name) + (!blank(m.styleName)?' <span class="style-name">字 '+esc(m.styleName)+'</span>':'');
    mdSub.textContent = detailSubtitle(m);
    if(mdExpand){
      var dn = descendantCount(m.id, kidsOf);
      mdExpand.hidden = !dn;
      mdExpand.textContent = '展開這一支（子孫 ' + dn + ' 人）';
    }

    var birthCell = calBadge(m.birth, blank(m.birthLunar) ? m.birthOriginal : m.birthLunar);
    // 卒年不詳（哨兵「已歿」）不當成國曆日期顯示；沒有原文記載時明講「卒年不詳」
    var deathSolar = m.death === DEATH_UNKNOWN ? '' : m.death;
    var deathLunarTxt = blank(m.deathLunar) ? m.deathOriginal : m.deathLunar;
    var deathCell = m.alive
      ? ' <span class="chip chip-ok">在世</span>'
      : ' <span class="dim">至</span> ' + ((blank(deathSolar) && blank(deathLunarTxt))
          ? '<span class="chip chip-past">已歿・卒年不詳</span>' : calBadge(deathSolar, deathLunarTxt));

    var rows = [
      ['生　卒', birthCell + deathCell],
      ['性　別', isF(m)?'女':'男'],
      ['房　頭', (!blank(m.branch)&&m.branch!=='本宗')?esc(m.branch):'<span class="dim">本宗</span>'],
      ['電　話', !blank(m.phone)?'<span class="mono">'+esc(m.phone)+'</span>':'<span class="dim">未登錄</span>'],
      ['現　居', !blank(m.city)?esc(m.city):'<span class="dim">未登錄</span>'],
      ['安葬資訊', m.alive ? '<span class="dim">在世</span>' : (!blank(m.burial)?esc(m.burial):'<span class="dim">未登錄</span>')],
      ['備　註', !blank(m.note)?esc(m.note):'<span class="dim">—</span>']
    ];
    // 親屬關係（唯讀；getMember 詳情才有陣列）：父母帶型別 chip（雙軌可並存）、
    // 配偶帶婚姻狀態、子女可點跳（data-goto → locateInTree）
    if(m.parents || m.spouses || m.children){
      var dim = '<span class="dim">未登錄</span>';
      var ps = (m.parents || []).map(function(p){
        var t = p.relationType || 'BIOLOGICAL';
        var chipCls = (t === 'ADOPTED' || t === 'FOSTER') ? 'chip-accent' : 'chip-muted';
        var nm = p.id ? '<a class="rel-link" data-goto="'+p.id+'">'+esc(p.name)+'</a>' : esc(p.name);
        return '<span class="rel-item">'+esc(p.relation || '父')+' '+nm+
          ' <span class="chip '+chipCls+'">'+(REL_TYPE_LABEL[t] || '親生')+'</span></span>';
      }).join('　');
      var ss = (m.spouses || []).map(function(s){
        var nm = s.id ? '<a class="rel-link" data-goto="'+s.id+'">'+esc(s.name)+'</a>' : esc(s.name);
        var st = SPOUSE_STATUS_LABEL[s.status];
        // 「婚姻中」是現在式：本人或配偶已歿即不掛（歷史婚姻不標狀態；離異等仍照標）
        if(s.status === 'MARRIED' && (!m.alive || s.alive === false)) st = '';
        return '<span class="rel-item">'+nm+(st ? ' <span class="chip chip-muted">'+st+'</span>' : '')+'</span>';
      }).join('　');
      var cs = (m.children || []).map(function(c){
        return '<a class="rel-link" data-goto="'+c.id+'">'+esc(c.name)+'</a>';
      }).join('、');
      rows.push(['父　母', ps || dim]);
      rows.push(['配　偶', ss || dim]);
      rows.push(['子　女', cs || '<span class="dim">—</span>']);
    }
    mdGrid.innerHTML = rows.map(function(r){
      return '<div class="f"><span class="k">'+r[0]+'</span><span class="v">'+r[1]+'</span></div>';
    }).join('');
  }

  // 型別／婚姻狀態的顯示文案（詳情卡與編輯表單共用；對外家族中性）
  var REL_TYPE_LABEL = { BIOLOGICAL: '親生', ADOPTED: '過繼', FOSTER: '收養' };
  var SPOUSE_STATUS_LABEL = { MARRIED: '婚姻中', WIDOWED: '喪偶', DIVORCED: '離異', SEPARATED: '分居' };

  // 詳情卡點姓名跳轉：父母／配偶／子女（data-goto → locateInTree 展開定位）
  if(mdGrid){
    mdGrid.addEventListener('click', function(e){
      var a = e.target.closest ? e.target.closest('[data-goto]') : null;
      if(!a) return;
      e.preventDefault();
      var gid = Number(a.getAttribute('data-goto'));
      if(gid) locateInTree(gid);
    });
  }

  // ── 取資料並渲染（搜尋／房頭交給後端 listMembers(branch,q)）──
  var lastMembers = [];
  var lastFiltered = false;   // 最近一次 load 是否帶搜尋／房頭過濾（樹狀圖需全量資料）
  // 最近一次「未過濾」載入的全族快查表與最小世代：搜尋／房頭過濾後 lastMembers 只剩結果，
  // 拿它判斷始遷祖、查母親或配偶姓名都會錯（詳情卡副標用）
  var fullById = {}, fullMinGen = null;
  var kidsOf = {};   // 掛靠親代 id → 子女 id 陣列（同 buildForest 的掛法；「展開這一支」數子孫用）
  function load(branch, q, selectFirst){
    listEl.innerHTML = '<div class="banner banner-info" style="margin:8px 0">載入族譜中…</div>';
    return window.KinAPI.listMembers(branch || '', q || '').then(function(members){
      lastMembers = members || [];
      lastFiltered = !!(q || branch);   // 過濾中的結果集組不出全樹，樹狀圖不採用
      if(!lastFiltered){
        fullById = {}; fullMinGen = null; kidsOf = {};
        lastMembers.forEach(function(mm){
          fullById[mm.id] = mm;
          if(mm.fatherId != null && mm.fatherId !== mm.id) (kidsOf[mm.fatherId] = kidsOf[mm.fatherId] || []).push(mm.id);
          var g = Number(mm.gen);
          if(g && (fullMinGen === null || g < fullMinGen)) fullMinGen = g;
        });
        dgFoldOv = {};                  // 重新載入就回到預設摺疊：舊版查過的祖先鏈永遠開著，總覽越用越寬
      }
      dgDirty = true;                   // 資料已變：樹狀圖下次顯示（或現在可見）需重建
      if(!lastFiltered && dgVisible()) dgBuild(false);
      listEl.innerHTML = '';
      if(!lastMembers.length){
        // 空狀態要分兩種：有搜尋/房頭過濾＝真的查無；整庫為空＝新家族剛開始，要給起手引導
        //（否則清空示範資料後會看到「查無符合『』的成員」，像程式壞掉）
        if(q || branch){
          listEl.innerHTML = '<div class="banner banner-info" style="margin:8px 0">'+
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg>'+
            '查無符合「'+esc(q||branch)+'」的成員。換個字詞或清除房頭篩選再試。</div>';
        } else {
          listEl.innerHTML = '<div class="banner banner-info" style="margin:8px 0;align-items:flex-start">'+
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>'+
            '<div><b>目前還沒有任何成員</b><br>'+
            '從右上角「＋ 新增成員」開始建立第一位（通常是本族最早的祖先），'+
            '之後再逐代新增子孫；若已有名冊，也可到「設定 → 資料 → 匯入 CSV」批次匯入。</div></div>';
        }
        return;
      }
      var forest = buildForest(lastMembers);
      listEl.appendChild(build(forest));
      // 有搜尋／過濾時自動展開以便檢視
      // 有搜尋／過濾時自動展開以便檢視；懶建下需反覆展開（每建一層才冒出下一層）
      if(q || branch){
        for(var pass = 0; pass < 30; pass++){
          var pend = listEl.querySelectorAll('.tnode:not(.open)');
          if(!pend.length) break;
          var grew = false;
          pend.forEach(function(n){
            if(n.querySelector(':scope > .kids')){ openNode(n); grew = true; }
          });
          if(!grew) break;
        }
      }
      if(selectFirst){
        var firstNode = listEl.querySelector('.tnode');
        if(firstNode){
          openNode(firstNode);
          select(firstNode._member, firstNode.querySelector('.trow'));
        }
      }
    }).catch(function(err){
      listEl.innerHTML = '<div class="banner banner-info" style="margin:8px 0">族譜載入失敗，請稍後再試。</div>';
      if(typeof toast==='function') toast('族譜載入失敗', 'err');
    });
  }

  // ── 互動 ──
  // 載入完成後同步視圖顯示（applyViewMode 依過濾狀態決定）：樹狀模式下有
  // 搜尋字／房頭過濾時暫以列表呈現結果，清空過濾則自動切回樹狀圖。
  var debounce;
  searchEl.addEventListener('input', function(){
    clearTimeout(debounce);
    debounce = setTimeout(function(){ load(branchEl.value, searchEl.value.trim()).then(applyViewMode); }, 160);
  });
  branchEl.addEventListener('change', function(){ load(branchEl.value, searchEl.value.trim()).then(applyViewMode); });

  // 「列表／樹狀」seg 真切換：列表 DOM 隱藏、SVG 容器顯示（或反向）
  segEl.addEventListener('click', function(e){
    var btn = e.target.closest('button'); if(!btn) return;
    segEl.querySelectorAll('button').forEach(function(b){ b.classList.remove('on'); });
    btn.classList.add('on');
    var mode = btn.dataset.mode === 'diagram' ? 'diagram' : 'list';
    if(mode === viewMode) return;
    viewMode = mode;
    // 列表與樹狀圖共用選取：在列表選好人再切樹狀圖，本支家系以他為焦點；切回列表展開到他那一列
    if(mode === 'diagram' && dgMode === 'family' && curSel && curSel.id !== dgFocusId){
      dgFocusId = dgSpouseHost[curSel.id] || curSel.id;
      dgLayoutDirty = true;
    }
    applyViewMode();
    if(mode === 'list' && curSel) revealInList(curSel.id);
  });

  // 沿掛靠父（無父者走配偶）往上收集祖先鏈：[本人, 父, 祖父, …]。seen 防「雙方皆無父的夫妻」互指打轉。純函式。
  function lineageOf(id, byId){
    var chain = [], seen = {}, cur = byId[id];
    while(cur && !seen[cur.id]){
      seen[cur.id] = true;
      chain.push(cur.id);
      var next = null;
      if(cur.fatherId != null && byId[cur.fatherId]) next = byId[cur.fatherId];
      else if(cur.spouseOfId != null && byId[cur.spouseOfId]) next = byId[cur.spouseOfId];
      cur = next;
    }
    return chain;
  }

  // 從樹狀圖切回列表：在現有列表上展開到這個人、標選取、捲過去——不重抓全族資料、不重畫詳情卡。
  // 過濾中（列表是搜尋結果）就不動。
  function revealInList(id){
    if(lastFiltered || id == null || !fullById[id]) return;
    var selRow = listEl.querySelector('.trow.sel');
    var selNode = selRow ? selRow.parentNode : null;
    if(selNode && selNode._member && selNode._member.id === id) return;
    var chain = lineageOf(id, fullById);
    for(var i = chain.length - 1; i >= 1; i--){
      openNode(listEl.querySelector('.tnode[data-mid="' + chain[i] + '"]'));
    }
    var el = listEl.querySelector('.tnode[data-mid="' + id + '"]');
    var row = el ? el.querySelector('.trow') : null;
    if(!row) return;
    clearSel();
    row.classList.add('sel');
    if(row.scrollIntoView) row.scrollIntoView({ block: 'center' });
  }

  // 某人底下的子孫人數（沿掛靠親代往下數，不含嫁娶進來的配偶）；seen 防髒資料成環。純函式。
  function descendantCount(id, kids){
    var n = 0, seen = {}, stack = (kids[id] || []).slice();
    while(stack.length){
      var c = stack.pop();
      if(seen[c]) continue;
      seen[c] = true;
      n++;
      var k = kids[c];
      if(k) for(var i = 0; i < k.length; i++) stack.push(k[i]);
    }
    return n;
  }

  // 列表一路展開到底。懶建：每打開一層才建出下一層，所以要一輪一輪來（族譜最多十幾代）。
  // rootEl＝整份列表，或某一個人的節點（只展開他底下）。
  function expandAllUnder(rootEl){
    for(var pass = 0; pass < 60; pass++){
      var pend = Array.prototype.slice.call(rootEl.querySelectorAll('.tnode:not(.open)'));
      if(rootEl.classList && rootEl.classList.contains('tnode') && !rootEl.classList.contains('open')) pend.unshift(rootEl);
      pend = pend.filter(function(n){ return n.querySelector(':scope > .kids'); });
      if(!pend.length) break;
      pend.forEach(openNode);
    }
  }

  // 「全部展開／全部收合」（列表專用）。全族近三千人展開約一兩秒：先把「展開中…」畫出來再開始。
  var expandAllBtn = root.querySelector('#tree-expand-all');
  var collapseAllBtn = root.querySelector('#tree-collapse-all');
  if(expandAllBtn) expandAllBtn.addEventListener('click', function(){
    expandAllBtn.disabled = true;
    expandAllBtn.textContent = '展開中…';
    setTimeout(function(){
      expandAllUnder(listEl);
      expandAllBtn.textContent = '全部展開';
      expandAllBtn.disabled = false;
    }, 30);
  });
  if(collapseAllBtn) collapseAllBtn.addEventListener('click', function(){
    var open = listEl.querySelectorAll('.tnode.open');
    for(var i = 0; i < open.length; i++){
      if(open[i]._setOpen) open[i]._setOpen(false); else open[i].classList.remove('open');
    }
    if(listEl.scrollIntoView) listEl.scrollIntoView({ block: 'start' });
  });

  // 「展開這一支」：把選取的人底下的子孫一次展開。
  //   樹狀圖：本支家系先切回全族總覽，展開到他、再把他底下全部打開，置中。
  //   列表：（搜尋／篩選中先回全樹定位）打開祖先鏈，再展開他整個子樹，捲到他。
  if(mdExpand) mdExpand.addEventListener('click', function(){
    if(!curSel) return;
    var id = curSel.id;
    if(viewMode === 'diagram' && !lastFiltered){
      if(dgMode === 'family'){ dgMode = 'overview'; dgFoldOv = {}; dgUserMoved = false; }
      var chain = fullById[id] ? lineageOf(id, fullById) : [id];
      for(var c = 1; c < chain.length; c++) dgFoldOv[chain[c]] = false;
      dgPrepare();
      var v = dgIdx[id] || dgIdx[dgSpouseHost[id]];
      var stack = v ? [v] : [];
      while(stack.length){
        var n = stack.pop();
        dgFoldOv[n.m.id] = false;
        for(var k = 0; k < n.kids.length; k++) stack.push(n.kids[k]);
      }
      dgLayoutDirty = true;
      dgBuild(false);
      dgSetSel(id);
      dgCenter(id);
      return;
    }
    (lastFiltered ? locateInTree(id) : Promise.resolve()).then(function(){
      var path = fullById[id] ? lineageOf(id, fullById) : [id];
      for(var p = path.length - 1; p >= 1; p--) openNode(listEl.querySelector('.tnode[data-mid="' + path[p] + '"]'));
      var el = listEl.querySelector('.tnode[data-mid="' + id + '"]');
      if(!el) return;
      expandAllUnder(el);
      var r = el.querySelector('.trow');
      if(r && r.scrollIntoView) r.scrollIntoView({ block: 'start' });
    });
  });

  /* ══════════════════════════════════════════════════════════
     樹狀圖檢視（純手寫 SVG＋vanilla JS，完全離線、零相依）
     兩種模式（2026-10-03 改版：舊版預設縮到 0.3，名字只剩約 4px，全族近三千人怎麼縮都看不清）：
     - 全族總覽（預設，總幹事選）：tidy tree —— 後序走訪配置葉序（葉與收合節點依序取槽位），
       父節點置於首末子中點；層距依世代對齊，每一世在左側只寫一次「第十八世」。
       預設展開深度依「螢幕放得下幾格」預算（dgBudgetFoldGen），比例下限 0.6；點「＋N 人」原地展開。
     - 本支家系：以焦點為中心，由上而下畫「直系祖先（一到兩代）＋兄弟姊妹（開窗）＋全部子女（換行）」，
       每列各自以焦點置中（dgFamilyLayout）。不論家族多大，畫面最多約 30～40 人，字維持原大小。
     - 資料：沿用 buildForest 的樹（fatherId 真實邊＋配偶掛靠守門），轉成繪圖樹後快取（dgPrepare），
       換焦點、摺疊只重排、不重組全族。配偶收進節點框內第二行，不再往右凸出撐寬。
     - 效能：整圖一次組 SVG 字串 innerHTML；縮放平移只改一個 <g> 的 transform。
     - 著色：主框依房頭配既有 token（b0~b5 迴圈配色，順序以 settings.branches 為準），已歿用 --past 色系。
     ══════════════════════════════════════════════════════════ */
  var dgBox     = document.getElementById('tree-dg');
  var dgSvg     = document.getElementById('tree-dg-svg');
  var dgVp      = document.getElementById('tree-dg-vp');
  var dgLegend  = document.getElementById('tree-dg-legend');
  var dgBar     = document.getElementById('tree-dg-bar');
  var dgModeEl  = document.getElementById('tree-dg-mode');
  var dgFindBtn = dgBar ? dgBar.querySelector('[data-dg="find"]') : null;
  var dgAllBtn  = dgBar ? dgBar.querySelector('[data-dg="all"]') : null;

  var NW = 140, NH = 56;                 // 節點：第一行姓名（16px，可容 8 字）、第二行「配 某某」
  var XGAP = 14, LEVEL_H = 108;          // 槽位間距／世代層距（上緣留給房頭起點小標、下緣留給徽章）
  var GEN_W = 92;                        // 總覽左側世代欄（每一世只寫一次）
  var FAM_GUT = 124;                     // 本支家系左側「本人與兄弟姊妹／第十八世」欄
  var FAM_CHIP_W = 128;                  // 兄弟列兩端「‹ 還有 N 位」小鈕寬
  var K_MIN_OVERVIEW = 0.6;              // 總覽預設比例下限（名字約 10px；要細看就放大或切本支家系）
  var K_MIN_FAMILY = 0.85;               // 本支家系預設比例下限
  var dgMode = 'overview';               // 'overview' 全族總覽｜'family' 本支家系
  var dgFocusId = null;                  // 本支家系的焦點成員
  var dgFoldGenCache = null;             // 本次重建的摺疊門檻（dgBuild 開頭清空）
  var dgFoldOv = {};                     // 摺疊覆寫：id → true 收合／false 展開（未設走預設；重新載入資料即清空）
  var dgSelId  = null;                   // 目前高亮的成員 id（列表與樹狀圖共用，重建後沿用）
  var dgView   = { x: 20, y: 20, k: 1 }; // 平移縮放狀態（單一 <g> transform）
  var dgRootX  = 0;                      // 視角錨點（總覽：始遷祖中心；家系：焦點中心）
  var dgUserMoved = false;               // 使用者已手動縮放/平移（之後顯示不再自動 refit；按「回到預設大小」重置）
  var dgDirty  = true;                   // 資料已變：需重組繪圖樹
  var dgLayoutDirty = true;              // 需重新佈局（換焦點、摺疊、換模式）
  var dgHasFit = false;                  // 是否已做過初次「適合視窗」
  var dgForest = null;                   // 轉換後的繪圖樹（快取，資料變動才重建）
  var dgIdx    = {};                     // 成員 id → 繪圖節點（含 up 父節點）
  var dgNodes  = {};                     // 本次佈局可見節點 id → { x: 中心, y: 上緣 }
  var dgSpouseHost = {};                 // 配偶 id → 掛靠本人 id（置中、聚焦配偶時退回本人）
  var dgBranchOrder = [];                // 房頭 → 配色序（settings 順序優先，資料出現序遞補）
  var dgW = 0, dgH = 0;                  // 本次佈局內容尺寸（適合視窗用）
  var dgBranchColors = {};               // 房名 → 自訂色（settings.branch_colors，JSON dict）

  // 自訂房頭配色：settings.branch_colors（JSON 字串或物件）→ dgBranchColors
  function dgLoadBranchColors(s){
    dgBranchColors = {};
    try{
      var v = s && s.branch_colors;
      if(typeof v === 'string' && v) dgBranchColors = JSON.parse(v) || {};
      else if(v && typeof v === 'object') dgBranchColors = v;
    }catch(e){ dgBranchColors = {}; }
  }
  // 以 <style> 動態覆蓋 app.css 的 b0~b5 預設色（只覆蓋有自訂色的房）。
  // 只染主框 .box 與房頭起點小標——舊版 .dgn.bN rect 連摺疊徽章的框也一起染色。
  // ponytail: 超過 6 房時 b 類別循環共用，後宣告的自訂色會蓋到同類別的房
  function dgApplyBranchColorCss(){
    var el = document.getElementById('branch-color-style');
    if(!el){ el = document.createElement('style'); el.id = 'branch-color-style'; document.head.appendChild(el); }
    var css = '';
    for(var i = 0; i < dgBranchOrder.length; i++){
      var c = dgBranchColors[dgBranchOrder[i]];
      if(!c || !/^#[0-9a-fA-F]{6}$/.test(c)) continue;
      css += '.tree-svg .dgn.b' + (i % 6) + ' .box{stroke:' + c + '}' +
             '.tree-svg .dg-btag.b' + (i % 6) + ' rect{fill:' + c + '}' +
             '.tree-svg-legend .sw.b' + (i % 6) + '{border-color:' + c + ';background:' + c + '}';
    }
    el.textContent = css;
  }
  // 供設定頁改色後即時刷新（web 模式 setSettings 不廣播 settings/changed）
  window.KinBranchColors = {
    refresh: function(){
      if(!window.KinAPI) return;
      window.KinAPI.getSettings().then(function(s){
        dgLoadBranchColors(s); dgApplyBranchColorCss(); dgRenderLegend();
      }).catch(function(){});
    }
  };
  if(window.KinAPI && window.KinAPI.ready){
    window.KinAPI.ready.then(function(){ window.KinBranchColors.refresh(); });
    window.KinAPI.on('settings/changed', function(s){
      if(s && Object.prototype.hasOwnProperty.call(s, 'branch_colors')){
        dgLoadBranchColors(s); dgApplyBranchColorCss(); dgRenderLegend();
      }
    });
  }

  function dgVisible(){ return !!(dgBox && !dgBox.hidden); }
  function round2(n){ return Math.round(n * 100) / 100; }
  // 畫布實際尺寸（假 DOM／尚未排版時為 0，退回常見大小）
  function dgSvgW(){ return (dgSvg && dgSvg.clientWidth) || (dgBox && dgBox.clientWidth) || 900; }
  function dgSvgH(){ return (dgSvg && dgSvg.clientHeight) || 520; }

  // 依「檢視模式＋是否過濾中」決定列表／樹狀圖誰顯示
  var layoutEl = document.getElementById('tree-layout');
  function applyViewMode(){
    if(!dgBox) return;
    var filtering = !!((searchEl.value || '').trim() || branchEl.value);
    var showDg = viewMode === 'diagram' && !filtering;
    listEl.hidden = showDg;
    dgBox.hidden = !showDg;
    if(layoutEl) layoutEl.classList.toggle('dg-on', showDg);   // 圖與詳情卡並排（窄時上下）
    var lo = root.querySelectorAll('[data-listonly]');            // 「全部展開／全部收合」只給列表
    for(var li = 0; li < lo.length; li++) lo[li].hidden = showDg;
    if(showDg) dgEnsure();
  }

  // 顯示前確保圖已就緒：資料被過濾／尚未載入 → 先重撈全量（load 完成會自動重建）
  function dgEnsure(){
    if(lastFiltered || !lastMembers.length){ load('', ''); return; }
    if(dgDirty || dgLayoutDirty) dgBuild(!dgUserMoved);
    else if(!dgUserMoved) dgFit();   // 使用者未手動操作前，每次顯示都重新適配視角
  }

  // 將 buildForest 樹轉為繪圖樹：抽出配偶節點（不佔位）、其名下子嗣併回本人；記 up 父節點供家系圖上溯
  function dgConvert(node, up){
    var out = { m: node.m, spouses: [], kids: [], hiddenN: 0, up: up || null };
    dgIdx[node.m.id] = out;
    var pend = node.kids ? node.kids.slice() : [];
    for(var i = 0; i < pend.length; i++){
      var k = pend[i];
      if(k.spouseNode){
        out.spouses.push(k.m);
        dgSpouseHost[k.m.id] = node.m.id;
        for(var j = 0; j < k.kids.length; j++) pend.push(k.kids[j]);   // 配偶名下子嗣（如僅掛母邊者）
      } else {
        out.kids.push(dgConvert(k, out));
      }
    }
    for(var c = 0; c < out.kids.length; c++){
      out.hiddenN += 1 + out.kids[c].spouses.length + out.kids[c].hiddenN;
    }
    return out;
  }
  // 資料變動才重組全族繪圖樹（換焦點、摺疊不必重組）
  function dgPrepare(){
    if(!dgDirty && dgForest) return;
    dgDirty = false;
    dgLayoutDirty = true;
    dgIdx = {}; dgSpouseHost = {};
    var src = buildForest(lastMembers);
    dgForest = [];
    for(var f = 0; f < src.length; f++) dgForest.push(dgConvert(src[f], null));
  }

  // 預設摺疊門檻：世代 ≥ 門檻的節點預設收合。依「螢幕放得下幾格」預算——從最淺開始試，
  // 取可見槽位數不超過 maxSlots 的最深一層；至少展開到根的下一代。以資料最小世代為基準，
  // 從第 1 世或第 11 世起算的族譜都適用（舊版固定「最小世代+3」，全族 25 格硬縮到 0.3）。純函式。
  function dgBudgetFoldGen(forest, maxSlots){
    var minGen = Infinity, maxGen = -Infinity;
    function scan(v){
      var g = Number(v.m.gen) || 0;
      if(g < minGen) minGen = g;
      if(g > maxGen) maxGen = g;
      for(var i = 0; i < v.kids.length; i++) scan(v.kids[i]);
    }
    for(var r = 0; r < forest.length; r++) scan(forest[r]);
    if(minGen === Infinity) return 1;
    function slots(v, g){
      if(!v.kids.length || (Number(v.m.gen) || 0) >= g) return 1;
      var n = 0;
      for(var i = 0; i < v.kids.length; i++) n += slots(v.kids[i], g);
      return n;
    }
    var best = minGen + 1;
    for(var g = minGen + 2; g <= maxGen + 1; g++){
      var n = 0;
      for(var q = 0; q < forest.length; q++) n += slots(forest[q], g);
      if(n > maxSlots) break;
      best = g;
    }
    return best;
  }
  function dgFoldGen(){
    if(dgFoldGenCache !== null) return dgFoldGenCache;
    var maxSlots = Math.max(1, Math.floor((dgSvgW() - 48 - GEN_W) / ((NW + XGAP) * K_MIN_OVERVIEW)));
    dgFoldGenCache = dgBudgetFoldGen(dgForest || [], maxSlots);
    return dgFoldGenCache;
  }
  function dgIsCollapsed(v){
    if(!v.kids.length) return false;
    var ov = dgFoldOv[v.m.id];
    if(ov !== undefined) return ov;
    return (Number(v.m.gen) || 1) >= dgFoldGen();
  }

  // 房頭 → 配色 class（b0~b5 迴圈）；空值／本宗＝不分房不著色
  function dgBranchCls(branch){
    if(!branch || branch === '本宗') return '';
    var i = dgBranchOrder.indexOf(branch);
    if(i < 0){ dgBranchOrder.push(branch); i = dgBranchOrder.length - 1; }
    return ' b' + (i % 6);
  }

  // 一個節點的 SVG（總覽與家系圖共用）；回傳未收尾的 <g>，呼叫端可再加徽章，最後補 '</g>'
  function dgNodeOpen(v, left, top, extraCls){
    var m = v.m;
    var cls = 'dgn' + dgBranchCls(m.branch) + (m.alive ? '' : ' past') + (dgSelId === m.id ? ' sel' : '') + (extraCls || '');
    var nm = String(m.name || '—');
    if(nm.length > 8) nm = nm.slice(0, 7) + '…';
    var s = '<g class="' + cls + '" data-mid="' + m.id + '" transform="translate(' + round2(left) + ',' + round2(top) + ')">' +
      '<title>' + esc((m.label || m.name || '') + '　' + lifeText(m)) + '</title>' +
      '<rect class="box" width="' + NW + '" height="' + NH + '" rx="10"></rect>' +
      '<text class="nm" x="' + NW / 2 + '" y="' + (v.spouses.length ? 23 : 34) + '" text-anchor="middle">' + esc(nm) + '</text>';
    if(v.spouses.length){
      // 配偶收進框內第二行（舊版貼在右側小字，跟隔壁族人擠在一起、又把整張圖撐寬）
      var sp = v.spouses[0];
      var t = '配 ' + (sp.name || '');
      if(v.spouses.length > 1) t += ' 等' + v.spouses.length + '位';
      if(t.length > 10) t = t.slice(0, 9) + '…';
      s += '<text class="sp' + (sp.alive ? '' : ' past') + (dgSelId === sp.id ? ' sel' : '') + '" data-mid="' + sp.id +
        '" x="' + NW / 2 + '" y="44" text-anchor="middle">' + esc(t) + '</text>';
    }
    // 房頭起點：本人屬某房、而父親不在這一房（或沒有父親）→ 框上緣標房名，一眼看出各房從哪裡分出來
    if(m.branch && m.branch !== '本宗' && v.up && v.up.m.branch !== m.branch){
      var bw = String(m.branch).length * 14 + 14;
      s += '<g class="dg-btag' + dgBranchCls(m.branch) + '" transform="translate(' + round2(NW / 2 - bw / 2) + ',-11)">' +
        '<rect width="' + bw + '" height="20" rx="10"></rect>' +
        '<text x="' + round2(bw / 2) + '" y="14.5" text-anchor="middle">' + esc(m.branch) + '</text></g>';
    }
    return s;
  }

  // 重建樹狀圖（資料變動、摺疊切換、換焦點、換模式時）；fit=true 時重建後自動適合視窗
  function dgBuild(fit){
    if(!dgVp) return;
    dgPrepare();
    dgLayoutDirty = false;
    dgFoldGenCache = null;             // 每次重建重算一次摺疊門檻（勿逐節點算，見 dgFoldGen）
    dgNodes = {};
    dgBranchOrder = ((window.KinBranches && window.KinBranches.list()) || []).slice();

    if(!dgForest.length){
      dgVp.innerHTML = '<text class="dg-empty" x="24" y="42">尚無族譜資料</text>';
      dgW = NW; dgH = NH;
    } else if(dgMode === 'family'){
      dgBuildFamily();
    } else {
      dgBuildOverview();
    }
    dgRenderLegend();
    dgSyncBar();
    if(fit) dgFit(); else dgApplyView();
  }

  // ── 全族總覽：tidy tree ──
  function dgBuildOverview(){
    var forest = dgForest;
    var minGen = Infinity;
    for(var r0 = 0; r0 < forest.length; r0++){
      var g0 = Number(forest[r0].m.gen) || 1;
      if(g0 < minGen) minGen = g0;
    }
    if(minGen === Infinity) minGen = 1;
    var maxGen = minGen;
    var cursor = GEN_W;                 // 左側留世代欄
    var genRows = {};                   // 有畫到的世代（左側標籤）

    // 後序走訪：葉（或收合節點）依序取槽位；父節點置於首末子中點。每格固定寬（配偶已收進框內）
    function place(v, parentGen){
      var gen = Number(v.m.gen) > 0 ? Number(v.m.gen) : parentGen + 1;
      if(gen <= parentGen) gen = parentGen + 1;   // 髒資料守門：子世代必低於父
      v.gen = gen;
      if(gen > maxGen) maxGen = gen;
      v.y = (gen - minGen) * LEVEL_H + 16;
      genRows[gen] = v.y;
      v.collapsed = dgIsCollapsed(v);
      if(v.collapsed || !v.kids.length){
        v.x = cursor + NW / 2;
        cursor += NW + XGAP;
      } else {
        for(var i = 0; i < v.kids.length; i++) place(v.kids[i], gen);
        v.x = (v.kids[0].x + v.kids[v.kids.length - 1].x) / 2;
      }
      dgNodes[v.m.id] = { x: v.x, y: v.y };
    }
    for(var r1 = 0; r1 < forest.length; r1++){
      place(forest[r1], (Number(forest[r1].m.gen) || 1) - 1);
    }
    dgRootX = forest.length ? forest[0].x : 0;   // 始遷祖中心（過寬時視角錨點）

    // 產出 SVG 字串後一次 innerHTML（避免逐一 DOM 操作拖慢上千節點）
    var nodesOut = [], edgesOut = [], gensOut = [];
    function draw(v){
      var m = v.m;
      var s = dgNodeOpen(v, v.x - NW / 2, v.y, '');
      if(v.kids.length){
        // 摺疊徽章：收合寫「+412 人」、展開寫「收合」；外面再包一層透明的大點擊區（長輩手指／觸控板好點）
        var btxt = v.collapsed ? '+' + v.hiddenN + ' 人' : '收合';
        var bw = Math.max(48, btxt.length * 10 + 18);
        s += '<g class="dg-badge" data-fold="' + m.id + '"><title>' + (v.collapsed ? '點一下展開下一代' : '點一下收合') + '</title>' +
          '<rect class="hit" x="' + round2(NW / 2 - bw / 2 - 8) + '" y="' + (NH - 6) + '" width="' + (bw + 16) + '" height="34"></rect>' +
          '<rect class="pill" x="' + round2(NW / 2 - bw / 2) + '" y="' + (NH - 2) + '" width="' + bw + '" height="24" rx="12"></rect>' +
          '<text x="' + NW / 2 + '" y="' + (NH + 15) + '" text-anchor="middle">' + btxt + '</text></g>';
      }
      s += '</g>';
      nodesOut.push(s);
      if(!v.collapsed){
        for(var ki = 0; ki < v.kids.length; ki++){
          var c = v.kids[ki];
          var y0 = v.y + NH + 22;      // 從徽章下緣接出，線不穿過字
          var midY = round2((y0 + c.y - 12) / 2);
          edgesOut.push('<path class="dg-edge" d="M' + round2(v.x) + ' ' + y0 +
            ' V' + midY + ' H' + round2(c.x) + ' V' + c.y + '"></path>');
          draw(c);
        }
      }
    }
    for(var r2 = 0; r2 < forest.length; r2++) draw(forest[r2]);
    // 每一世只在最左側寫一次（舊版每一格都重複「第十四世」）
    for(var g in genRows){
      if(Object.prototype.hasOwnProperty.call(genRows, g)){
        gensOut.push('<text class="dg-gen" x="8" y="' + round2(genRows[g] + NH / 2 + 5) + '">第' + esc(genCn(g)) + '世</text>');
      }
    }
    dgVp.innerHTML = gensOut.join('') + edgesOut.join('') + nodesOut.join('');
    dgW = Math.max(cursor - XGAP, NW + GEN_W);
    dgH = (maxGen - minGen) * LEVEL_H + NH + 40;
  }

  // ── 本支家系：版面計算（純函式，不碰 DOM、不讀閉包變數；測試用 node 抽出來跑）──
  // focus：繪圖節點（含 m、kids、up）；roots：最上層節點（焦點沒有父親時當兄弟姊妹列）。
  // o：{ NW, NH, LEVEL_H, XGAP, perRow, anc, gut }。由上而下：
  //   ① 直系祖先 o.anc 代（只畫直系，不畫旁支），再往上還有人 → 頂端「往上還有 N 代」；
  //   ② 兄弟姊妹列：以焦點為中心開 perRow 格的窗口，兩端「前面／後面還有 N 位」（點了聚焦到窗口外第一位）；
  //   ③ 全部子女：超過 perRow 換行，不收成「另 N 位」（長輩會以為漏登）。
  // 每列都以焦點的 x 置中——不用 tidy tree：兄弟數和子女數會左右相加，實測最寬約 22 格。
  // 回傳 { items:[{v,x,y,focus,kidsN}], chips:[{x,y,kind,n,gen,id}], edges:[d], bands:[{y,rel,gen}], w, h }（x 為中心、y 為上緣）。
  function dgFamilyLayout(focus, roots, o){
    var SW = o.NW + o.XGAP, items = [], chips = [], edges = [], bands = [];
    var anc = [], p = focus.up;
    while(p){ anc.push(p); p = p.up; }
    var shown = anc.slice(0, Math.max(0, o.anc));
    var y = 0;
    if(anc.length > shown.length && shown.length){
      var top = shown[shown.length - 1];
      chips.push({ x: 0, y: 0, kind: 'up', n: anc.length - shown.length, gen: anc[anc.length - 1].m.gen, id: top.m.id });
      y = 44;
    }
    // ① 直系祖先（上→下）
    for(var a = shown.length - 1; a >= 0; a--){
      var av = shown[a];
      items.push({ v: av, x: 0, y: y, focus: false, kidsN: 0 });
      bands.push({ y: y, rel: a + 1, gen: av.m.gen });
      if(av.kids.length > 1) chips.push({ x: o.NW / 2 + 10, y: y + o.NH / 2, kind: 'kids', n: av.kids.length - 1, id: av.m.id });
      edges.push('M0 ' + (y + o.NH) + ' V' + (y + o.LEVEL_H));
      y += o.LEVEL_H;
    }
    // ② 兄弟姊妹（含本人）
    var sibs = focus.up ? focus.up.kids : roots;
    var fi = sibs.indexOf(focus);
    if(fi < 0){ sibs = [focus]; fi = 0; }
    var per = Math.max(1, o.perRow), n = sibs.length, CW = o.chipW || 128;
    var start = Math.min(Math.max(0, fi - Math.floor(per / 2)), Math.max(0, n - per));
    var end = Math.min(n, start + per);
    var busY = y - 18, xs = [];
    for(var si = start; si < end; si++){
      var sx = (si - fi) * SW;
      xs.push(sx);
      items.push({ v: sibs[si], x: sx, y: y, focus: si === fi, kidsN: si === fi ? 0 : sibs[si].kids.length });
    }
    if(start > 0) chips.push({ x: (start - fi) * SW - o.NW / 2 - 10 - CW / 2, y: y + o.NH / 2, kind: 'prev', n: start, id: sibs[start - 1].m.id });
    if(end < n) chips.push({ x: (end - 1 - fi) * SW + o.NW / 2 + 10 + CW / 2, y: y + o.NH / 2, kind: 'next', n: n - end, id: sibs[end].m.id });
    bands.push({ y: y, rel: 0, gen: focus.m.gen });
    if(shown.length && xs.length > 1){
      edges.push('M' + xs[0] + ' ' + busY + ' H' + xs[xs.length - 1]);
    }
    if(shown.length){
      for(var e1 = 0; e1 < xs.length; e1++) edges.push('M' + xs[e1] + ' ' + busY + ' V' + y);
    }
    var focusY = y;
    y += o.LEVEL_H;
    // ③ 子女（換行全部列出）
    var kids = focus.kids;
    if(kids.length){
      var kper = Math.max(1, o.perKids || per);
      var rowsN = Math.ceil(kids.length / kper);
      var widest = Math.min(kper, kids.length);
      var leftX = -(widest - 1) / 2 * SW - o.NW / 2 - 12;   // 多排時主幹走最左側，不穿過子女框
      var firstBus = y - 18, lastBus = firstBus;
      edges.push('M0 ' + (focusY + o.NH) + ' V' + firstBus);
      for(var r = 0; r < rowsN; r++){
        var row = kids.slice(r * kper, r * kper + kper);
        var rb = y - 18, rx = [];
        for(var j = 0; j < row.length; j++){
          var kx = (j - (row.length - 1) / 2) * SW;
          rx.push(kx);
          items.push({ v: row[j], x: kx, y: y, focus: false, kidsN: row[j].kids.length });
          edges.push('M' + kx + ' ' + rb + ' V' + y);
        }
        var bl = rowsN > 1 ? leftX : Math.min(rx[0], 0), br = Math.max(rx[rx.length - 1], 0);
        edges.push('M' + bl + ' ' + rb + ' H' + br);
        if(r === 0) bands.push({ y: y, rel: -1, gen: row[0].m.gen });
        lastBus = rb;
        y += o.LEVEL_H;
      }
      if(rowsN > 1) edges.push('M' + leftX + ' ' + firstBus + ' V' + lastBus);
    }
    // 整體平移：左側留 o.gut 給「父母輩／第十八世」，內容從 gut 之後開始
    var minX = Infinity, maxX = -Infinity;
    function span(x){ if(x - o.NW / 2 < minX) minX = x - o.NW / 2; if(x + o.NW / 2 > maxX) maxX = x + o.NW / 2; }
    for(var ii = 0; ii < items.length; ii++) span(items[ii].x);
    for(var ci = 0; ci < chips.length; ci++){
      if(chips[ci].kind === 'prev' || chips[ci].kind === 'next'){
        if(chips[ci].x - CW / 2 < minX) minX = chips[ci].x - CW / 2;
        if(chips[ci].x + CW / 2 > maxX) maxX = chips[ci].x + CW / 2;
      }
      else if(chips[ci].kind === 'kids' && chips[ci].x + 130 > maxX) maxX = chips[ci].x + 130;   // 祖先右側「另有 N 位子女」
    }
    if(kids.length && rowsN > 1) span(leftX + o.NW / 2);
    var dx = o.gut - minX;
    function mv(d){ return d.replace(/([MH])(-?[\d.]+)/g, function(_, c, v){ return c + (Number(v) + dx); }); }
    for(var i2 = 0; i2 < items.length; i2++) items[i2].x += dx;
    for(var c2 = 0; c2 < chips.length; c2++) chips[c2].x += dx;
    for(var e2 = 0; e2 < edges.length; e2++) edges[e2] = mv(edges[e2]);
    return { items: items, chips: chips, edges: edges, bands: bands,
             w: (maxX - minX) + o.gut + 16, h: y - o.LEVEL_H + o.NH + 40, focusX: dx };
  }

  // 「父母輩／祖父母輩…」相對稱呼（rel：1 父母輩、2 祖父母輩…；0 本人與兄弟姊妹；-1 子女）
  function dgRelLabel(rel){
    if(rel === 0) return '本人與兄弟姊妹';
    if(rel < 0) return '子女';
    return ['', '父母輩', '祖父母輩', '曾祖父母輩', '高祖父母輩'][rel] || ('上' + genCn(rel) + '代');
  }

  // ── 本支家系：繪製 ──
  function dgBuildFamily(){
    var focus = dgIdx[dgFocusId] || dgIdx[dgSpouseHost[dgFocusId]] || dgIdx[dgSelId] || dgForest[0];
    dgFocusId = focus.m.id;
    var k = dgUserMoved ? dgView.k : K_MIN_FAMILY;
    // 每排放幾位：以預設比例估（使用者縮放過就用目前比例）；兄弟列兩端各留一顆小鈕的寬度，子女列不用
    var avail = (dgSvgW() - 48) / k - FAM_GUT - 28;   // 28：多排子女時左側主幹＋右緣留白
    var perKids = Math.max(3, Math.floor(avail / (NW + XGAP)));
    var per = Math.max(3, Math.floor((avail - 2 * (FAM_CHIP_W + 10)) / (NW + XGAP)));
    var L = dgFamilyLayout(focus, dgForest, { NW: NW, NH: NH, LEVEL_H: LEVEL_H, XGAP: XGAP, perRow: per, perKids: perKids,
                                              chipW: FAM_CHIP_W, anc: dgSvgH() >= 560 ? 2 : 1, gut: FAM_GUT });
    var out = [], edges = [], extra = [];
    for(var e = 0; e < L.edges.length; e++) edges.push('<path class="dg-edge" d="' + L.edges[e] + '"></path>');
    for(var b = 0; b < L.bands.length; b++){
      var bd = L.bands[b];
      extra.push('<text class="dg-band" x="8" y="' + round2(bd.y + NH / 2 - 4) + '">' + esc(dgRelLabel(bd.rel)) +
        '<tspan class="g" x="8" dy="18">第' + esc(genCn(bd.gen)) + '世</tspan></text>');
    }
    for(var i = 0; i < L.items.length; i++){
      var it = L.items[i];
      var s = dgNodeOpen(it.v, it.x - NW / 2, it.y, it.focus ? ' focus' : '');
      if(it.kidsN) s += '<text class="dg-kn" x="' + NW / 2 + '" y="' + (NH + 17) + '" text-anchor="middle">子女 ' + it.kidsN + '</text>';
      out.push(s + '</g>');
      dgNodes[it.v.m.id] = { x: it.x, y: it.y };
    }
    for(var c = 0; c < L.chips.length; c++){
      var ch = L.chips[c], txt;
      if(ch.kind === 'up') txt = '往上還有 ' + ch.n + ' 代（第' + genCn(ch.gen) + '世起）';
      else if(ch.kind === 'kids') txt = '另有 ' + ch.n + ' 位子女';
      else if(ch.kind === 'prev') txt = '‹ 還有 ' + ch.n + ' 位';
      else txt = '還有 ' + ch.n + ' 位 ›';
      var w = (ch.kind === 'prev' || ch.kind === 'next') ? FAM_CHIP_W : txt.length * 13 + 20;
      var x0 = ch.kind === 'kids' ? ch.x : ch.x - w / 2;
      var y0 = ch.kind === 'up' ? ch.y : ch.y - 15;
      extra.push('<g class="dg-chip' + (ch.kind === 'kids' ? ' soft' : '') + '" data-focus="' + ch.id + '" transform="translate(' + round2(x0) + ',' + round2(y0) + ')">' +
        '<title>點一下看這一家</title><rect width="' + w + '" height="30" rx="15"></rect>' +
        '<text x="' + round2(w / 2) + '" y="20" text-anchor="middle">' + esc(txt) + '</text></g>');
    }
    dgVp.innerHTML = edges.join('') + out.join('') + extra.join('');
    dgW = L.w; dgH = L.h;
    dgRootX = dgNodes[focus.m.id] ? dgNodes[focus.m.id].x : L.focusX;
  }

  // 操作列與模式按鈕的狀態
  function dgSyncBar(){
    if(dgModeEl){
      var bs = dgModeEl.querySelectorAll('button[data-dgmode]');
      for(var i = 0; i < bs.length; i++) bs[i].classList.toggle('on', bs[i].getAttribute('data-dgmode') === dgMode);
    }
    if(dgAllBtn) dgAllBtn.hidden = dgMode === 'family';   // 家系圖本來就整張放得下
    if(dgFindBtn) dgFindBtn.disabled = dgSelId == null;
  }

  // 圖例（圖下方長條，不擋住內容）。舊版是「空心小圓圈＋房名」，長得像單選鈕，族親一按沒反應以為壞了
  // （2026-10-04 使用者回報）：改成寫明「框線顏色：」、色塊畫成小框，房名做成真的按鈕＝跳到該房始祖
  // （同工具列的房頭鈕）；不分房、已歿只是說明，不是按鈕。
  function dgRenderLegend(){
    if(!dgLegend) return;
    var seen = {}, html = '<span class="lg-title">框線顏色：</span>';
    for(var i = 0; i < dgBranchOrder.length; i++){
      var b = dgBranchOrder[i];
      if(!b || seen[b]) continue;
      seen[b] = true;
      html += '<button type="button" class="lg lg-btn" data-branch="' + esc(b) + '" title="跳到' + esc(b) + '的始祖">' +
        '<i class="sw b' + (i % 6) + '"></i>' + esc(b) + '</button>';
    }
    html += '<span class="lg"><i class="sw none"></i>不分房</span>';
    html += '<span class="lg"><i class="sw past"></i>已歿（灰藍底）</span>';
    // 加號用半形「+」：全形「＋」在這套字型裡看起來像中文的「十」（使用者看成「點『十人數』」）
    html += '<span class="hint">' + (dgMode === 'family'
      ? '點一個人＝看他的一家　點「往上還有…」＝看更早的祖先　按住拖曳＝移動畫面'
      : '點框下方的「+123 人」＝展開下一代　按住拖曳＝移動畫面') + '</span>';
    dgLegend.innerHTML = html;
    dgApplyBranchColorCss();   // 自訂房色隨圖例一併套用（覆蓋 b0~b5 預設）
  }

  function dgApplyView(){
    if(dgVp) dgVp.setAttribute('transform',
      'translate(' + round2(dgView.x) + ' ' + round2(dgView.y) + ') scale(' + round2(dgView.k) + ')');
  }

  // 適合視窗的比例與位置（純函式）：放得下就整張置中（比框矮時垂直置中），
  // 放不下時比例不低於 kMin（字要看得清楚），改以錨點（選取的人／始祖／焦點）水平置中、頂端對齊。
  // cw、ch 為 0（假 DOM）時用 900×520。
  function dgFitView(cw, ch, w, h, anchorX, kMin, widthOnly){
    cw = cw || 900; ch = ch || 520;
    var k = Math.min(1, (cw - 48) / Math.max(w, 1));
    if(!widthOnly) k = Math.min(k, (ch - 48) / Math.max(h, 1));
    if(k < kMin){
      k = kMin;
      return { k: k, x: cw / 2 - anchorX * k, y: 24 };
    }
    return { k: k, x: (cw - w * k) / 2, y: !widthOnly && h * k < ch - 48 ? (ch - h * k) / 2 : 24 };
  }
  function dgAnchorX(){
    var id = dgMode === 'family' ? dgFocusId : dgSelId;
    var n = dgNodes[id] || dgNodes[dgSpouseHost[id]];
    return n ? n.x : dgRootX;
  }
  function dgFit(kMin){
    var v = dgFitView(dgSvgW(), dgSvgH(), dgW, dgH, dgAnchorX(),
                      kMin != null ? kMin : (dgMode === 'family' ? K_MIN_FAMILY : K_MIN_OVERVIEW),
                      dgMode === 'family' && kMin == null);
    dgView.k = v.k; dgView.x = v.x; dgView.y = v.y;
    dgHasFit = true;
    dgApplyView();
  }

  // 置中指定成員（配偶退回其掛靠本人的位置）；比例太小時拉回可讀下限
  function dgCenter(id){
    var n = dgNodes[id] || dgNodes[dgSpouseHost[id]];
    if(!n) return;
    var kMin = dgMode === 'family' ? K_MIN_FAMILY : K_MIN_OVERVIEW;
    if(dgView.k < kMin) dgView.k = kMin;
    var cw = dgSvgW(), ch = dgSvgH();
    dgView.x = cw / 2 - n.x * dgView.k;
    dgView.y = dgMode === 'family' ? Math.min(24, ch / 2 - (n.y + NH / 2) * dgView.k) : ch / 2 - (n.y + NH / 2) * dgView.k;
    dgApplyView();
  }

  // 以畫布中心縮放（按鈕用；避開介面縮放下滑鼠座標換算的問題）
  function dgZoomBy(f){
    var k2 = Math.min(2.5, Math.max(0.25, dgView.k * f));
    if(k2 === dgView.k) return;
    var cx = dgSvgW() / 2, cy = dgSvgH() / 2;
    dgView.x = cx - (cx - dgView.x) * (k2 / dgView.k);
    dgView.y = cy - (cy - dgView.y) * (k2 / dgView.k);
    dgView.k = k2;
    dgUserMoved = true;
    dgApplyView();
  }

  // 高亮指定成員（節點框或配偶字皆可）；重建時依 dgSelId 自動重上
  function dgSetSel(id){
    dgSelId = id;
    if(dgFindBtn) dgFindBtn.disabled = id == null;
    if(!dgSvg) return;
    var old = dgSvg.querySelectorAll('.sel');
    for(var i = 0; i < old.length; i++) old[i].classList.remove('sel');
    if(id == null) return;
    var els = dgSvg.querySelectorAll('[data-mid="' + id + '"]');
    for(var j = 0; j < els.length; j++) els[j].classList.add('sel');
  }

  // 本支家系換焦點：重排（不重組全族），保留使用者調好的比例，水平置中焦點
  function dgFocus(id){
    dgFocusId = dgSpouseHost[id] || id;
    dgBuild(!dgUserMoved);
    if(dgUserMoved) dgCenter(dgFocusId);
  }

  if(dgLegend) dgLegend.addEventListener('click', function(e){
    var btn = e.target.closest ? e.target.closest('button[data-branch]') : null;
    if(btn) jumpToBranch(btn.getAttribute('data-branch'));
  });

  // ── 操作列：模式切換、縮小／放大／回到預設大小／看全貌／找到選取的人 ──
  if(dgBar){
    dgBar.addEventListener('click', function(e){
      var mb = e.target.closest ? e.target.closest('button[data-dgmode]') : null;
      if(mb){
        var mode = mb.getAttribute('data-dgmode') === 'family' ? 'family' : 'overview';
        if(mode === dgMode) return;
        dgMode = mode;
        dgUserMoved = false;
        if(mode === 'family'){
          dgFocusId = dgSelId != null ? (dgSpouseHost[dgSelId] || dgSelId) : (curSel ? curSel.id : null);
        } else {
          // 切回總覽：回到預設摺疊，只展開到目前選取的人
          dgFoldOv = {};
          if(dgSelId != null && fullById[dgSelId]){
            var chain = lineageOf(dgSelId, fullById);
            for(var c = 1; c < chain.length; c++) dgFoldOv[chain[c]] = false;
          }
        }
        dgLayoutDirty = true;
        dgBuild(true);
        if(mode === 'overview' && dgSelId != null) dgCenter(dgSelId);
        return;
      }
      var btn = e.target.closest ? e.target.closest('button[data-dg]') : null;
      if(!btn || btn.disabled) return;
      var act = btn.getAttribute('data-dg');
      if(act === 'in') dgZoomBy(1.25);
      else if(act === 'out') dgZoomBy(1 / 1.25);
      else if(act === 'fit'){ dgUserMoved = false; dgFit(); }
      else if(act === 'all'){ dgUserMoved = true; dgFit(0.25); }   // 只用來看整體形狀，字會很小
      else if(act === 'find' && dgSelId != null){
        if(dgMode === 'family' && !dgNodes[dgSelId] && !dgNodes[dgSpouseHost[dgSelId]]) dgFocus(dgSelId);
        else dgCenter(dgSelId);
      }
    });
  }

  // ── 樹狀圖互動：拖曳平移、滾輪縮放、點節點／配偶選取、點徽章摺疊、點家系圖小鈕換焦點 ──
  if(dgSvg){
    var dgDrag = null, dgMoved = false;
    dgSvg.addEventListener('pointerdown', function(e){
      if(e.button !== 0) return;
      dgDrag = { x: e.clientX, y: e.clientY, vx: dgView.x, vy: dgView.y, pid: e.pointerId };
      dgMoved = false;
      // 注意：這裡「不能」立刻 setPointerCapture——捕獲會讓後續 click 的 target
      // 變成 SVG 根，徽章/節點點擊全被吃掉。等真正開始拖曳才捕獲（見 pointermove）。
    });
    dgSvg.addEventListener('pointermove', function(e){
      if(!dgDrag) return;
      var dx = e.clientX - dgDrag.x, dy = e.clientY - dgDrag.y;
      // 門檻 8px：長輩點擊時手抖幾像素，舊版 3px 就當成拖曳、點了沒反應
      if(!dgMoved && Math.abs(dx) + Math.abs(dy) > 8){
        dgMoved = true; dgUserMoved = true;
        if(dgSvg.setPointerCapture){ try{ dgSvg.setPointerCapture(dgDrag.pid); }catch(err){} }
      }
      if(!dgMoved) return;
      dgView.x = dgDrag.vx + dx;
      dgView.y = dgDrag.vy + dy;
      dgApplyView();
      if(dgBox) dgBox.classList.add('dragging');
    });
    var dgEndDrag = function(){ dgDrag = null; if(dgBox) dgBox.classList.remove('dragging'); };
    dgSvg.addEventListener('pointerup', dgEndDrag);
    dgSvg.addEventListener('pointercancel', dgEndDrag);

    dgSvg.addEventListener('wheel', function(e){
      e.preventDefault();   // 縮放時不讓頁面捲動
      var rect = dgSvg.getBoundingClientRect();
      var mx = e.clientX - rect.left, my = e.clientY - rect.top;
      var f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      // 下限 0.25：舊版可縮到 0.05，觸控板一滑整張圖變成小點、找不回來
      var k2 = Math.min(2.5, Math.max(0.25, dgView.k * f));
      if(k2 === dgView.k) return;
      f = k2 / dgView.k;
      dgView.x = mx - (mx - dgView.x) * f;   // 以游標為縮放中心
      dgView.y = my - (my - dgView.y) * f;
      dgView.k = k2;
      dgUserMoved = true;
      dgApplyView();
    }, { passive: false });

    dgSvg.addEventListener('click', function(e){
      if(dgMoved){ dgMoved = false; return; }   // 拖曳結束的殘餘 click 不當點選
      var t = e.target;
      var chip = t.closest ? t.closest('.dg-chip') : null;
      if(chip){
        var cid = Number(chip.getAttribute('data-focus'));
        var cm = fullById[cid];
        if(cm) select(cm, null);
        dgFocus(cid);
        return;
      }
      var badge = t.closest ? t.closest('.dg-badge') : null;
      if(badge){
        var fid = Number(badge.getAttribute('data-fold'));
        var v = dgIdx[fid];
        dgFoldOv[fid] = v ? !v.collapsed : false;
        dgLayoutDirty = true;
        dgBuild(false);   // 摺疊切換重佈局，維持目前縮放平移
        return;
      }
      var el = t.closest ? t.closest('[data-mid]') : null;
      if(!el) return;
      var mid = Number(el.getAttribute('data-mid'));
      var m = fullById[mid] || null;
      if(!m){
        for(var i = 0; i < lastMembers.length; i++){
          if(lastMembers[i].id === mid){ m = lastMembers[i]; break; }
        }
      }
      if(!m) return;
      select(m, null);   // 沿用詳情卡渲染（renderDetail＋getMember 補完）
      // 本支家系：點誰就看誰的一家（點配偶只看配偶資料，焦點留在本人）
      if(dgMode === 'family' && !el.classList.contains('sp') && dgFocusId !== mid) dgFocus(mid);
      else dgSetSel(mid);
    });
  }

  /* ── 成員編輯表單（modal）：編輯既有成員／新增成員共用 ─────────────
     入口：詳情卡「編輯」鈕與工具列「新增成員」#tree-add（皆常駐可見，
     瀏覽模式由 requireEdit 引導解鎖後自動接續）。
     儲存走 KinAPI.saveMember（fatherId 僅新增時掛父；既有成員的父母／配偶一律走「親屬關係」區），
     刪除走 KinAPI.deleteMember（雙重確認；後端 409 轉白話提示）。
     儲存成功後以 locateInTree 重載列表並重新選取／定位該成員。 ── */
  var mformMask   = document.getElementById('mform-mask');
  var mfBirthLunar = document.getElementById('mform-birth-lunar');   // 生年→農曆對照提示
  var mfDeathHint  = document.getElementById('mform-death-hint');    // 卒年慣例守門提示
  var mformTitle  = document.getElementById('mform-title');
  var mfName      = document.getElementById('mform-name');
  var mfStyle     = document.getElementById('mform-style');
  var mfGenderSeg = document.getElementById('mform-gender');
  var mfGen       = document.getElementById('mform-gen');
  var mfBranch    = document.getElementById('mform-branch');
  var mfBirth     = document.getElementById('mform-birth');
  var mfBirthOrig = document.getElementById('mform-birthOrig');
  var mfDeath     = document.getElementById('mform-death');
  var mfDeadUnk   = document.getElementById('mform-death-unknown');   // 已過世（卒年不詳）
  var mfDeathOrig = document.getElementById('mform-deathOrig');
  var mfPhone     = document.getElementById('mform-phone');
  var mfCustomKin = document.getElementById('mform-customkin');   // R4 習慣稱呼
  var mfPostal    = document.getElementById('mform-postal');
  var mfCity      = document.getElementById('mform-city');
  var mfBurial    = document.getElementById('mform-burial');
  var mfBurialTy  = document.getElementById('mform-burialType');   // 安葬型態（tombs.tomb_type）
  var mfBurialCd  = document.getElementById('mform-burialCode');   // 穴位／塔位編號
  var mfNote      = document.getElementById('mform-note');
  var mfMailTgt   = document.getElementById('mform-mailtarget');
  var mfSave      = document.getElementById('mform-save');
  var mfCancel    = document.getElementById('mform-cancel');
  var mfDelete    = document.getElementById('mform-delete');
  var mfDangerRow = document.getElementById('mform-danger-row');
  var mformId    = null;   // null＝新增；數字＝編輯中成員 id
  var mformName0 = '';     // 開表單當下的姓名（刪除確認顯示用）
  var mformRelTouched = false;   // 這次表單有沒有即時增刪過親屬（編輯既有成員才會：加完就已存檔）

  /* ── 親屬關係區（規格 §4.1 雙軌制）───────────────────────────
     原「父親」單一欄位併入此區（單一資料入口，避免兩處打架）。
     編輯既有成員：增刪即時打 KinAPI.addParent/removeParent/addSpouse/
     removeSpouse，完成後以 getMember 重撈刷新清單。
     新增成員：尚無 id → 先暫存於陣列，儲存成功取得 id 後逐筆補送。 ── */
  var mfParentsList  = document.getElementById('mform-parents');
  var mfParentMount  = document.getElementById('mform-parent-pick');
  var mfParentType   = document.getElementById('mform-parent-type');
  var mfParentAddBtn = document.getElementById('mform-parent-add-btn');
  var mfSpousesList  = document.getElementById('mform-spouses');
  var mfSpouseMount  = document.getElementById('mform-spouse-pick');
  var mfSpouseStatus = document.getElementById('mform-spouse-status');
  var mfSpouseAddBtn = document.getElementById('mform-spouse-add-btn');

  var relParents = [];   // 表單目前顯示的父母 [{id,name,relation('父'/'母'),relationType}]
  var relSpouses = [];   // 表單目前顯示的配偶 [{id,name,status}]

  // 父/母與配偶選擇器：沿用可重用搜尋式選擇器，各建一次重複使用。
  // 皆啟用 allowCreate：譜上本來就沒有的人（嫁入配偶、外家父母）查無時
  // 可就地建立最小欄位新成員並直接掛關係（詳 createAndAddSpouse/Parent）。
  var parentPick = (window.createMemberPicker && mfParentMount)
    ? window.createMemberPicker({
        placeholder: '搜尋姓名、字號或房頭…',
        // 點了人名就加入（2026-10-13 總幹事：視窗常常消失、建子女不直覺——舊版選了還要再按「＋加父/母」，
        // 沒按就存檔，孩子沒掛到父母底下、跑到族譜最上層，像是不見了）
        onSelect: function(m){ if(m && mfParentAddBtn) mfParentAddBtn.click(); },
        allowCreate: [
          { key: 'M', label: '＋ 建立新成員「{name}」（父）' },
          { key: 'F', label: '＋ 建立新成員「{name}」（母）' }
        ],
        onCreate: function(name, gender){ createAndAddParent(name, gender); }
      })
    : null;
  if(parentPick) mfParentMount.appendChild(parentPick.el);
  var spousePick = (window.createMemberPicker && mfSpouseMount)
    ? window.createMemberPicker({
        placeholder: '搜尋姓名、字號或房頭…',
        onSelect: function(m){ if(m && mfSpouseAddBtn) mfSpouseAddBtn.click(); },   // 同上：點了就加入
        allowCreate: true,
        onCreate: function(name){ createAndAddSpouse(name); }
      })
    : null;
  if(spousePick) mfSpouseMount.appendChild(spousePick.el);

  function relToastErr(err, fallback){
    var msg = err && err.message ? String(err.message).replace(/^API \d+：/, '') : '';
    if(typeof toast === 'function') toast(msg || fallback, 'err');
  }

  // 新增成員存檔後，把暫存的父母／配偶逐筆補送；每筆各自接錯誤、不中斷後面的（H-3 再修）。
  // 舊版整條 Promise 鏈一筆失敗（例如親代性別空白回 400）就斷：排在後面的母親、配偶
  // 全部默默沒送，畫面卻只有那一筆的錯誤，接著還顯示「已新增成員」。回傳沒寫入的清單。
  function sendQueuedRels(newId, parents, spouses){
    var failed = [];
    var chain = Promise.resolve();
    function note(kind, name){
      return function(err){
        var msg = err && err.message ? String(err.message).replace(/^API \d+：/, '').replace(/。$/, '') : '';
        failed.push(kind + '「' + name + '」' + (msg ? '（' + msg + '）' : ''));
      };
    }
    parents.forEach(function(p){
      if(!p.id) return;
      chain = chain.then(function(){
        return window.KinAPI.addParent(newId, p.id, p.relationType || 'BIOLOGICAL');
      }).catch(note(p.relation || '父/母', p.name));
    });
    spouses.forEach(function(s){
      if(!s.id) return;
      chain = chain.then(function(){
        return window.KinAPI.addSpouse(newId, s.id, s.status || 'MARRIED');
      }).catch(note('配偶', s.name));
    });
    return chain.then(function(){ return failed; });
  }

  function renderRelParents(){
    if(!mfParentsList) return;
    if(!relParents.length){
      mfParentsList.innerHTML = '<div class="rel-empty">尚未設定父母（始遷祖或資料待補可留空）</div>';
      return;
    }
    mfParentsList.innerHTML = relParents.map(function(p, i){
      var t = p.relationType || 'BIOLOGICAL';
      var chipCls = (t === 'ADOPTED' || t === 'FOSTER') ? 'chip-accent' : 'chip-muted';
      return '<div class="rel-row">'+
        '<span class="rel-kind">'+esc(p.relation || '父')+'</span>'+
        '<span class="rel-name">'+esc(p.name)+'</span>'+
        '<span class="chip '+chipCls+'">'+(REL_TYPE_LABEL[t] || '親生')+'</span>'+
        '<button type="button" class="btn btn-ghost btn-sm rel-del" data-rel-parent="'+i+'">移除</button>'+
      '</div>';
    }).join('');
  }

  function renderRelSpouses(){
    if(!mfSpousesList) return;
    if(!relSpouses.length){
      mfSpousesList.innerHTML = '<div class="rel-empty">尚未登錄配偶</div>';
      return;
    }
    mfSpousesList.innerHTML = relSpouses.map(function(s, i){
      // 狀態改為每列下拉可直接改（後端 add_spouse 對既有配偶＝upsert 更新狀態）
      var cur = s.status || 'MARRIED';
      var opts = ['MARRIED', 'WIDOWED', 'DIVORCED', 'SEPARATED'].map(function(k){
        return '<option value="'+k+'"'+(cur === k ? ' selected' : '')+'>'+SPOUSE_STATUS_LABEL[k]+'</option>';
      }).join('');
      return '<div class="rel-row">'+
        '<span class="rel-kind">配偶</span>'+
        '<span class="rel-name">'+esc(s.name)+'</span>'+
        '<select class="select rel-st" data-rel-spouse-st="'+i+'" aria-label="婚姻狀態">'+opts+'</select>'+
        (s.id ? '<button type="button" class="btn btn-ghost btn-sm rel-del" data-rel-spouse="'+i+'">移除</button>' : '')+
      '</div>';
    }).join('');
  }

  // 以 getMember 詳情重撈父母／配偶清單（編輯既有成員增刪後刷新）
  function refreshRelLists(){
    if(!mformId){ renderRelParents(); renderRelSpouses(); return Promise.resolve(); }
    mformRelTouched = true;   // 親屬已即時寫入：關表單時要重載族譜（見 closeMemberForm）
    return window.KinAPI.getMember(mformId).then(function(d){
      if(!d) return;
      relParents = (d.parents || []).map(function(p){
        return { id: p.id, name: p.name, relation: p.relation || '父', relationType: p.relationType || 'BIOLOGICAL' };
      });
      relSpouses = (d.spouses || []).map(function(s){
        return { id: s.id, name: s.name, status: s.status || 'MARRIED' };
      });
      renderRelParents();
      renderRelSpouses();
    }).catch(function(){ /* 保留現況，避免清單閃失 */ });
  }

  /* ── 配偶／父母不在譜上 → 就地建立（allowCreate 回呼）─────────────
     嫁入配偶（如新媳婦）、外家父母族譜裡本來就沒有；搜尋選擇器查無時
     點「＋ 建立新成員」→ 以最小欄位 saveMember 建人 → 立即掛關係邊。
     防呆：主體尚未儲存（新增中，無 id）時先提示儲存本人，不建孤兒成員。 ── */

  // 配偶：性別＝主體之異性預設、世代＝主體世代、房頭＝主體房頭、無父母（皆可事後編輯）
  function createAndAddSpouse(name){
    name = String(name || '').trim();
    if(!name) return;
    window.requireEdit(function(){
      if(!mformId){
        if(typeof toast==='function') toast('請先按「儲存」建立本人，再於編輯表單建立新配偶', 'err');
        return;
      }
      var g = currentGender();
      var gen = parseInt(mfGen.value, 10);
      var st = mfSpouseStatus ? mfSpouseStatus.value : 'MARRIED';
      if(mfSpouseAddBtn) mfSpouseAddBtn.disabled = true;
      window.KinAPI.saveMember({
        name: name,
        gender: g === 'M' ? 'F' : (g === 'F' ? 'M' : null),
        gen: (gen && gen > 0) ? gen : 1,
        branch: mfBranch ? (mfBranch.value || '') : '',
        alive: true
      }).then(function(res){
        var nid = res && res.id;
        if(!nid) throw new Error('建立新成員失敗，請稍後再試');
        return window.KinAPI.addSpouse(mformId, nid, st);
      }).then(function(){
        if(mfSpouseAddBtn) mfSpouseAddBtn.disabled = false;
        if(spousePick) spousePick.clear();
        if(typeof toast==='function') toast('已建立「' + name + '」並設為配偶', 'ok');
        load(branchEl.value, searchEl.value.trim());   // 重載族譜（新成員入列）
        return refreshRelLists();                       // 重載配偶清單
      }).catch(function(err){
        if(mfSpouseAddBtn) mfSpouseAddBtn.disabled = false;
        relToastErr(err, '建立配偶失敗，請稍後再試');
      });
    });
  }

  // 父/母：性別依所選角色（父＝男、母＝女）、世代＝主體世代-1、房頭＝主體房頭
  function createAndAddParent(name, gender){
    name = String(name || '').trim();
    if(!name) return;
    window.requireEdit(function(){
      if(!mformId){
        if(typeof toast==='function') toast('請先按「儲存」建立本人，再於編輯表單建立新父/母', 'err');
        return;
      }
      var gen = parseInt(mfGen.value, 10);
      var rt = mfParentType ? mfParentType.value : 'BIOLOGICAL';
      var isMother = gender === 'F';
      if(mfParentAddBtn) mfParentAddBtn.disabled = true;
      window.KinAPI.saveMember({
        name: name,
        gender: isMother ? 'F' : 'M',
        gen: (gen && gen > 1) ? gen - 1 : 1,
        branch: mfBranch ? (mfBranch.value || '') : '',
        alive: true
      }).then(function(res){
        var nid = res && res.id;
        if(!nid) throw new Error('建立新成員失敗，請稍後再試');
        return window.KinAPI.addParent(mformId, nid, rt);
      }).then(function(){
        if(mfParentAddBtn) mfParentAddBtn.disabled = false;
        if(parentPick) parentPick.clear();
        if(typeof toast==='function') toast('已建立「' + name + '」並設為' + (isMother ? '母親' : '父親'), 'ok');
        load(branchEl.value, searchEl.value.trim());
        return refreshRelLists();
      }).catch(function(err){
        if(mfParentAddBtn) mfParentAddBtn.disabled = false;
        relToastErr(err, '建立父/母失敗，請稍後再試');
      });
    });
  }

  // ＋加父/母：選人＋型別；同型別同性別槽位僅一位（與後端規則一致）
  // （增刪鈕常駐可見：瀏覽模式點擊由 requireEdit 引導解鎖後接續）
  if(mfParentAddBtn){
    mfParentAddBtn.addEventListener('click', function(){ window.requireEdit(function(){
      var m = parentPick ? parentPick.getMember() : null;
      if(!m){ if(typeof toast==='function') toast('請先搜尋並選擇父/母', 'err'); return; }
      if(mformId && m.id === mformId){ if(typeof toast==='function') toast('父/母不可為本人', 'err'); return; }
      var rt = mfParentType ? mfParentType.value : 'BIOLOGICAL';
      // 點了就加入（2026-10-13）之後的防呆（同日審查重現：編輯中按 Enter 就把親生父換掉、沒問）：
      // 同一條已經登錄就不重加；同型別同槽已有別人（後端會取代掉）→ 先問
      if(relParents.some(function(p){ return p.id === m.id && (p.relationType || 'BIOLOGICAL') === rt; })){
        if(typeof toast==='function') toast('「' + m.name + '」已經登錄在父母欄', 'err');
        parentPick.clear(); return;
      }
      if(m.gender){
        var slotNm = m.gender === 'M' ? '父' : '母';
        var occ = relParents.filter(function(p){
          return (p.relationType || 'BIOLOGICAL') === rt && (p.relation || '父') === slotNm && p.id !== m.id; })[0];
        if(occ && !window.confirm('「' + (slotNm === '父' ? '父親' : '母親') + '」（' + (REL_TYPE_LABEL[rt] || '親生') +
            '）目前是「' + occ.name + '」，要改成「' + m.name + '」嗎？')){ parentPick.clear(); return; }
      }
      if(mformId){
        mfParentAddBtn.disabled = true;
        window.KinAPI.addParent(mformId, m.id, rt).then(function(){
          mfParentAddBtn.disabled = false;
          parentPick.clear();
          return refreshRelLists();
        }).catch(function(err){
          mfParentAddBtn.disabled = false;
          relToastErr(err, '父/母新增失敗，請稍後再試');
        });
      } else {
        // 性別空白的親代：後端 add_parent 會回 400（分不出父槽母槽）。新增成員要等存檔後
        // 才補送，到時才報錯人已建好、這條親邊卻沒建，所以選人當下就擋（H-3 再修）
        if(!m.gender){
          if(typeof toast==='function') toast('「' + m.name + '」的性別還沒設定，無法判斷要加為父親還是母親。' +
            '請先到這位親屬的成員資料設定性別（男／女），再回來加入。', 'err');
          return;
        }
        // 新增成員：先暫存；同型別同性別槽位取代舊列
        var slot = (m.gender === 'F') ? '母' : '父';
        for(var i = relParents.length - 1; i >= 0; i--){
          if((relParents[i].relationType || 'BIOLOGICAL') === rt && (relParents[i].relation || '父') === slot){
            relParents.splice(i, 1);
          }
        }
        relParents.push({ id: m.id, name: m.name, relation: slot, relationType: rt });
        parentPick.clear();
        renderRelParents();
      }
    }); });
  }

  // ＋加配偶：選人＋婚姻狀態；同一人重複加＝更新狀態（與後端 upsert 一致）
  if(mfSpouseAddBtn){
    mfSpouseAddBtn.addEventListener('click', function(){ window.requireEdit(function(){
      var m = spousePick ? spousePick.getMember() : null;
      if(!m){ if(typeof toast==='function') toast('請先搜尋並選擇配偶', 'err'); return; }
      if(mformId && m.id === mformId){ if(typeof toast==='function') toast('配偶不可為本人', 'err'); return; }
      // 已經是配偶：不重加、不改婚姻狀態（點了就加入後，舊寫法會把狀態蓋成下拉當下的值）
      if(relSpouses.some(function(s){ return s.id === m.id; })){
        if(typeof toast==='function') toast('「' + m.name + '」已經是配偶；要改婚姻狀態請用那一列的下拉選單', 'err');
        spousePick.clear(); return;
      }
      var st = mfSpouseStatus ? mfSpouseStatus.value : 'MARRIED';
      if(mformId){
        mfSpouseAddBtn.disabled = true;
        window.KinAPI.addSpouse(mformId, m.id, st).then(function(){
          mfSpouseAddBtn.disabled = false;
          spousePick.clear();
          return refreshRelLists();
        }).catch(function(err){
          mfSpouseAddBtn.disabled = false;
          relToastErr(err, '配偶新增失敗，請稍後再試');
        });
      } else {
        for(var i = 0; i < relSpouses.length; i++){
          if(relSpouses[i].id === m.id){
            relSpouses[i].status = st;
            spousePick.clear();
            renderRelSpouses();
            return;
          }
        }
        relSpouses.push({ id: m.id, name: m.name, status: st });
        spousePick.clear();
        renderRelSpouses();
      }
    }); });
  }

  // 父母列「移除」（事件委派）：編輯即時刪邊；新增僅移出暫存
  if(mfParentsList){
    mfParentsList.addEventListener('click', function(e){
      var btn = e.target.closest ? e.target.closest('[data-rel-parent]') : null;
      if(!btn) return;
      window.requireEdit(function(){
      var i = Number(btn.getAttribute('data-rel-parent'));
      var p = relParents[i];
      if(!p) return;
      if(mformId){
        btn.disabled = true;
        window.KinAPI.removeParent(mformId, p.id, p.relationType).then(function(){
          return refreshRelLists();
        }).catch(function(err){
          btn.disabled = false;
          relToastErr(err, '父/母關係移除失敗，請稍後再試');
        });
      } else {
        relParents.splice(i, 1);
        renderRelParents();
      }
      });
    });
  }

  // 配偶列「狀態」下拉直接改（事件委派）：既有成員走 addSpouse upsert；
  // 新增成員（暫存列）僅改本地狀態，儲存時一併補送
  if(mfSpousesList){
    mfSpousesList.addEventListener('change', function(e){
      var sel = e.target.closest ? e.target.closest('[data-rel-spouse-st]') : null;
      if(!sel) return;
      var i = Number(sel.getAttribute('data-rel-spouse-st'));
      var s = relSpouses[i];
      if(!s) return;
      var st = sel.value;
      var prev = s.status || 'MARRIED';
      if(st === prev) return;
      window.requireEdit(function(){
        if(mformId && s.id){
          sel.disabled = true;
          window.KinAPI.addSpouse(mformId, s.id, st).then(function(){
            if(typeof toast==='function') toast('婚姻狀態已更新', 'ok');
            return refreshRelLists();
          }).catch(function(err){
            sel.disabled = false;
            sel.value = prev;   // 失敗還原顯示
            relToastErr(err, '婚姻狀態更新失敗，請稍後再試');
          });
        } else {
          s.status = st;
          renderRelSpouses();
        }
      });
    });
  }

  // 配偶列「移除」（事件委派）
  if(mfSpousesList){
    mfSpousesList.addEventListener('click', function(e){
      var btn = e.target.closest ? e.target.closest('[data-rel-spouse]') : null;
      if(!btn) return;
      window.requireEdit(function(){
      var i = Number(btn.getAttribute('data-rel-spouse'));
      var s = relSpouses[i];
      if(!s || !s.id) return;
      if(mformId){
        btn.disabled = true;
        window.KinAPI.removeSpouse(mformId, s.id).then(function(){
          return refreshRelLists();
        }).catch(function(err){
          btn.disabled = false;
          relToastErr(err, '配偶關係移除失敗，請稍後再試');
        });
      } else {
        relSpouses.splice(i, 1);
        renderRelSpouses();
      }
      });
    });
  }

  function setGenderSeg(g){
    if(!mfGenderSeg) return;
    mfGenderSeg.querySelectorAll('button').forEach(function(b){
      b.classList.toggle('on', (b.getAttribute('data-g') || '') === (g || ''));
    });
  }
  function currentGender(){
    var on = mfGenderSeg ? mfGenderSeg.querySelector('button.on') : null;
    return on ? (on.getAttribute('data-g') || '') : '';
  }
  if(mfGenderSeg){
    mfGenderSeg.addEventListener('click', function(e){
      var btn = e.target.closest('button'); if(!btn) return;
      setGenderSeg(btn.getAttribute('data-g') || '');
    });
  }

  // 房頭下拉：每次開表單以 KinBranches 現況重灌；成員既有房頭不在清單時補列，避免遺失
  function fillBranchSelect(current){
    if(!mfBranch) return;
    while(mfBranch.options.length > 1) mfBranch.remove(1);
    var list = (window.KinBranches && window.KinBranches.list()) || [];
    for(var i = 0; i < list.length; i++){
      var o = document.createElement('option');
      o.value = list[i]; o.textContent = list[i];
      mfBranch.appendChild(o);
    }
    if(current && list.indexOf(current) < 0){
      var extra = document.createElement('option');
      extra.value = current; extra.textContent = current;
      mfBranch.appendChild(extra);
    }
    mfBranch.value = current || '';
  }

  // 開表單：detail＝null 代表新增（空白）；否則以 getMember 詳情回填
  /* ── 國曆→農曆即時對照（UX 回饋 2026-08-03）────────────────────
     打完完整日期（YYYY-MM-DD）就在欄位下方顯示「＝農曆 乙巳年三月初八」，
     長輩對族譜記載時不用自己換算。只填年份不顯示；換算不出（超出 1900–2099
     查表）也不顯示、不硬掰。防抖 350ms 免得每敲一鍵打一次 API。 */
  var lunarHintTimer = null;
  function bindLunarHint(inp, hintEl){
    if(!inp || !hintEl) return;
    function refresh(){
      var v = (inp.value || '').trim();
      if(!/^\d{4}-\d{1,2}-\d{1,2}$/.test(v)){ hintEl.textContent = ''; return; }
      window.KinAPI.lunarOf(v).then(function(r){
        // 回來時值可能已被改掉，比對後才顯示
        if((inp.value || '').trim() === v)
          hintEl.textContent = (r && r.lunar) ? ('＝農曆 ' + r.lunar) : '';
      }).catch(function(){ hintEl.textContent = ''; });
    }
    inp.addEventListener('input', function(){
      if(lunarHintTimer) clearTimeout(lunarHintTimer);
      lunarHintTimer = setTimeout(refresh, 350);
    });
    inp.addEventListener('change', refresh);
    inp._lunarRefresh = refresh;   // 開表單回填後手動觸發一次
  }
  bindLunarHint(mfBirth, mfBirthLunar);
  // 卒年守門：本譜慣例卒日只存西元年、月日寫原文欄（視為農曆）。
  // 卒年欄是完整日期時提醒他慣例——不是擋，是講清楚。提醒一律跟著欄位「現在的值」：
  // 打字、勾／取消「卒年不詳」（程式填回值不會觸發 input，第二批驗證員）、開表單都重算一次。
  function refreshDeathHint(){
    if(!mfDeath || !mfDeathHint) return;
    var v = (mfDeath.value || '').trim();
    if(!mfDeath.disabled && /^\d{4}-\d{1,2}-\d{1,2}$/.test(v)){
      mfDeathHint.textContent = '本譜慣例：這欄只填西元年，月日請寫在右邊「卒日原文」（視為農曆）';
      mfDeathHint.className = 'hint-lunar warn';
    } else {
      mfDeathHint.textContent = '';
      mfDeathHint.className = 'hint-lunar';
    }
  }
  if(mfDeath) mfDeath.addEventListener('input', refreshDeathHint);

  /* ── 已過世、卒年不詳（M-8／體檢 frontend-3）────────────────────
     後端判在世＝卒年空白且卒(原文)也空白（kinlink/members.py 的 _is_alive；當初只看 death_date IS NULL）：
     卒年不知道只能留空、又沒寫卒(原文)的老祖先，舊版一律變成「在世」，
     會進「全族在世」通知名單、又不在牌位姓名表。勾選框送既有的哨兵值「已歿」
     （CSV 匯入「卒年空白、卒(原文)有記載」也存成它）；勾選時卒年欄停用，免得兩邊打架。
     勾選前卒年欄的值記在 mfDeathKept：勾一下又取消要填回去，否則已知卒年就此清空，
     按儲存會把已過世的祖先存回「在世」。 */
  var mfDeathKept = '';
  function syncDeadUnk(){
    if(!mfDeadUnk || !mfDeath) return;
    if(mfDeadUnk.checked){
      if(mfDeath.value) mfDeathKept = mfDeath.value;
      mfDeath.value = '';
    } else if(!mfDeath.value && mfDeathKept){
      mfDeath.value = mfDeathKept;
    }
    mfDeath.disabled = mfDeadUnk.checked;
    refreshDeathHint();     // 勾選＝清掉提醒；取消時填回的值是完整日期就再提醒
  }
  if(mfDeadUnk) mfDeadUnk.addEventListener('change', syncDeadUnk);

  function openMemberForm(detail){
    if(!mformMask) return;
    mformId    = detail ? detail.id : null;
    mformRelTouched = false;
    mformName0 = detail ? (detail.name || '') : '';
    if(mformTitle) mformTitle.textContent = detail ? '編輯成員' : '新增成員';
    mfName.value      = detail ? (detail.name || '') : '';
    mfStyle.value     = detail ? (detail.styleName || '') : '';
    setGenderSeg(detail ? (detail.gender || '') : 'M');
    mfGen.value       = detail ? (detail.gen || '') : '';
    fillBranchSelect(detail ? (detail.branch || '') : '');
    mfBirth.value     = detail ? (detail.birth || '') : '';
    mfBirthOrig.value = detail ? (detail.birthOriginal || '') : '';
    // 「已歿」哨兵（或已歿卻沒有卒年字串的舊資料，例如卒年空白、只寫了卒日原文）→ 勾選框打勾、卒年欄留空
    var deadUnk = !!detail && (detail.death === DEATH_UNKNOWN || (detail.alive === false && blank(detail.death)));
    if(mfDeadUnk) mfDeadUnk.checked = deadUnk;
    mfDeath.value     = (detail && !deadUnk) ? (detail.death || '') : '';
    mfDeathKept = '';
    syncDeadUnk();
    mfDeathOrig.value = detail ? (detail.deathOriginal || '') : '';
    mfPhone.value     = detail ? (detail.phone || '') : '';
    if(mfCustomKin) mfCustomKin.value = detail ? (detail.customKin || '') : '';   // R4
    if(mfPostal) mfPostal.value = detail ? (detail.postalCode || '') : '';
    mfCity.value      = detail ? (detail.city || '') : '';
    // 安葬資訊：優先用未串接的 burialDesc（web 詳情），mock 只有 burial
    if(mfBurial) mfBurial.value = detail ? (detail.burialDesc !== undefined ? detail.burialDesc : (detail.burial || '')) : '';
    if(mfBurialTy) mfBurialTy.value = (detail && detail.burialType) || '';
    if(mfBurialCd) mfBurialCd.value = (detail && detail.burialCode) || '';
    if(mfNote) mfNote.value = detail ? (detail.note || '') : '';
    if(mfMailTgt) mfMailTgt.checked = !!(detail && detail.mailTarget);
    // 親屬關係區回填：編輯以 getMember 詳情帶入；新增清空（儲存後逐筆補送）
    relParents = (detail && detail.parents) ? detail.parents.map(function(p){
      return { id: p.id, name: p.name, relation: p.relation || '父', relationType: p.relationType || 'BIOLOGICAL' };
    }) : [];
    relSpouses = (detail && detail.spouses) ? detail.spouses.map(function(s){
      return { id: s.id, name: s.name, status: s.status || 'MARRIED' };
    }) : [];
    if(parentPick) parentPick.clear();
    if(spousePick) spousePick.clear();
    if(mfParentType) mfParentType.value = 'BIOLOGICAL';
    if(mfSpouseStatus) mfSpouseStatus.value = 'MARRIED';
    renderRelParents();
    renderRelSpouses();
    if(mfDangerRow) mfDangerRow.hidden = !mformId;   // 刪除鈕僅編輯既有成員時顯示
    mformMask.hidden = false;
    if(mfBirth && mfBirth._lunarRefresh) mfBirth._lunarRefresh();
    refreshDeathHint();     // 換人開表單：不留上一位的提醒，這位的卒年是完整日期就提醒
    mformSnap = mformState();   // 開表單當下的快照，供「有沒有改過」判斷
    setTimeout(function(){ mfName.focus(); }, 30);
  }
  // 回傳：這次有即時增刪過親屬的成員 id（呼叫端要重載族譜並重選他），否則 null
  function closeMemberForm(){
    var touchedId = mformRelTouched ? mformId : null;
    if(mformMask) mformMask.hidden = true;
    famRefreshAfterForm();   // 從「一家人」表格按「完整資料」來的：表格重讀
    mformId = null;
    mformRelTouched = false;
    return touchedId;
  }
  /* 不存檔關表單（取消／點遮罩／退出編輯模式）：親屬區增刪是即時寫入的，詳情卡與族譜樹卻還是
     開表單前的樣子（仍寫「父母 未登錄」「始遷祖」），像沒加成功（M-9／體檢 frontend-6）。
     這次動過關係就重載並重選該成員（同儲存成功的 locateInTree）。
     但族譜頁有搜尋字／房頭篩選時不走 locateInTree（它會清掉篩選、清單變回全族）：照原篩選重載再重選；
     該成員不在篩選結果裡就只補詳情卡。 */
  function closeMemberFormAndRefresh(){
    var touchedId = closeMemberForm();
    if(!touchedId) return;
    var q = (searchEl.value || '').trim(), br = branchEl.value;
    if(!q && !br){ locateInTree(touchedId); return; }
    load(br, q).then(function(){
      applyViewMode();
      var n = listEl.querySelector('.tnode[data-mid="' + touchedId + '"]');
      if(n && n._member){ select(n._member, n.querySelector('.trow')); return; }
      if(curSel && curSel.id === touchedId){
        window.KinAPI.getMember(touchedId).then(function(d){
          if(d && curSel && curSel.id === touchedId) renderDetail(d);
        }).catch(function(){ /* 保留原詳情 */ });
      }
    });
  }

  /* ── 防「一不小心跳掉」（UX 回饋 2026-08-03）────────────────────
     舊行為：點到表單外的灰色遮罩就直接關閉，打到一半的資料全丟。
     新行為：關閉前比對開表單時的快照，**有改過就先問**；沒改過照舊直接關。
     （儲存成功走 closeMemberForm 不經此守門，不會多問一次。） */
  var mformSnap = '';
  function mformState(){
    var vals = [];
    [mfName, mfStyle, mfGen, mfBirth, mfBirthOrig, mfDeath, mfDeathOrig,
     mfPhone, mfCustomKin, mfPostal, mfCity, mfBurial, mfBurialTy, mfBurialCd,
     mfNote, mfBranch].forEach(function(el){ vals.push(el ? el.value : ''); });
    vals.push(mfMailTgt && mfMailTgt.checked ? '1' : '0');
    vals.push(mfDeadUnk && mfDeadUnk.checked ? '1' : '0');
    var gOn = mformMask ? mformMask.querySelector('#mform-gender button.on') : null;
    vals.push(gOn ? (gOn.getAttribute('data-g') || '') : '');
    // 新增成員時親屬是暫存的，也要算進「有沒有改過」；編輯既有成員時親屬區是即時寫後端的
    // （加完就已存檔），不該算成「未儲存的修改」，否則關表單會被誤攔
    if(!mformId){
      vals.push(JSON.stringify(relParents || []));
      vals.push(JSON.stringify(relSpouses || []));
    }
    return vals.join(String.fromCharCode(1));
  }
  function maybeCloseMemberForm(){
    if(mformSnap && mformState() !== mformSnap){
      if(!window.confirm(['資料還沒儲存，確定要放棄這次的修改嗎？',
          '（想保留請按「取消」，回表單按「儲存」。）'].join(String.fromCharCode(10)))) return;
    }
    closeMemberFormAndRefresh();
  }

  if(mfCancel) mfCancel.addEventListener('click', maybeCloseMemberForm);
  // 點表單外的灰色遮罩不關表單（2026-10-13 總幹事：新建修改時視窗常常消失）——只有「取消」才關，
  // 「取消」照舊有守門（改過先問）。2026-08-03 那版是點遮罩先問，仍常被一路按確定關掉。
  // 退出編輯模式時自動收起表單（守住編輯鎖行為）
  window.KinAPI.on('lock/changed', function(st){
    if(!(st && st.editMode)) closeMemberFormAndRefresh();
  });

  // 詳情卡「編輯」：以 getMember 補完整詳情（原文日期、電話、父母）後開表單
  // 常駐可見：瀏覽模式點擊由 requireEdit 引導解鎖，成功後自動接續開表單
  if(mdEdit){
    mdEdit.addEventListener('click', function(){
      if(!curSel) return;
      window.requireEdit(function(){
        if(!curSel) return;   // 防護：等待解鎖期間選取可能被清空
        window.KinAPI.getMember(curSel.id).then(function(detail){
          openMemberForm(detail || curSel);
        }).catch(function(){ openMemberForm(curSel); });
      });
    });
  }

  /* ── 一家人一張表（2026-10-13 總幹事：新建的 UI/UX 推倒重來、大刀闊斧；選 A）──────────────
     以「一家人」為單位編輯：本人、配偶、子女攤成一張表（像全家族表）。姓名、字號、性別、出生、過世直接在表上改；
     子女列選生母（本人是女性時選生父）；「＋再加一位子女」多填幾列，最後「儲存」一起存。
     電話、地址、安葬、原文日期等細節按「完整資料」開原本的成員表單。
     儲存只送改過的格子（後端 save_member 只更新有送的欄位，沒送的不動）；只有「取消」「儲存」會關這張表。
     同日獨立審查抓到並修掉（都有重現）：換生母先刪後加、加失敗舊母親就沒了 → 改成直接加（後端同槽自動取代）；
     本人性別空白時新子女接不上父母變孤兒 → 存前擋、接不上就刪掉剛建的人；過繼／收養的母邊被當成生母 →
     生母只認親生那條；連按儲存建出重複子女 → 表格重讀完才恢復按鈕；性別「其他」被改成男 → 保留原值。 */
  var famMask = document.getElementById('fam-mask');
  var famTitle = document.getElementById('fam-title'), famSub = document.getElementById('fam-sub');
  var famBody = document.getElementById('fam-body'), famOtherHead = document.getElementById('fam-other-head');
  var famSaveBtn = document.getElementById('fam-save');
  var famAddKidBtn = document.getElementById('fam-add-kid'), famAddSpBtn = document.getElementById('fam-add-spouse');
  var mdFamily = document.getElementById('tree-md-family'), mdAddChild = document.getElementById('tree-md-addchild');
  var fam = null;          // { self, rows:[{key, kind, d, orig, other, otherName, status, ro}], seq }
  var FAM_ORD = '長次三四五六七八九十';
  var STATUS_LABEL = { MARRIED: '婚姻中', WIDOWED: '喪偶', DIVORCED: '離異', SEPARATED: '分居' };
  function famOtherWord(){ return fam && fam.self.gender === 'F' ? '生父' : '生母'; }
  // 後端 add_parent 的槽位：男＝父槽，其餘有設性別＝母槽，空白＝分不出（不收）
  function famSlot(g){ return g === 'M' ? 'M' : (g ? 'F' : ''); }
  function famRowByKey(k){ return fam ? fam.rows.filter(function(r){ return r.key === k; })[0] : null; }

  function famVal(key, f){
    var el = famBody ? famBody.querySelector('[data-k="' + key + '"][data-f="' + f + '"]') : null;
    return el ? String(el.value || '').trim() : '';
  }
  function famRowVals(r){
    return { name: famVal(r.key, 'name'), styleName: famVal(r.key, 'styleName'), gender: famVal(r.key, 'gender'),
             birth: famVal(r.key, 'birth'), death: famVal(r.key, 'death'),
             other: famVal(r.key, 'other'), status: famVal(r.key, 'status') };
  }
  function famIsNew(r){ return r.kind === 'newKid' || r.kind === 'newSpouse'; }
  function famHasInput(v){ return !!(v.name || v.styleName || v.birth || v.death); }
  function famRowChanged(r, v){
    var o = r.orig;
    return v.name !== o.name || v.styleName !== o.styleName || v.gender !== o.gender || v.birth !== o.birth ||
           v.death !== o.death || (r.kind === 'kid' && v.other !== o.other) || (r.kind === 'spouse' && v.status !== o.status);
  }
  function famDirty(){
    if(!fam) return false;
    return fam.rows.some(function(r){
      if(r.ro) return false;
      var v = famRowVals(r);
      return famIsNew(r) ? famHasInput(v) : famRowChanged(r, v);
    });
  }
  // 子女的「關係」欄：家族原表的稱呼優先（K-2），沒有就照排序算長男、次女；長幼排不出就寫子／女
  function famKidLabel(r, counters){
    var g = r.d.gender;
    if(r.origLabel) return r.origLabel;
    if(g !== 'M' && g !== 'F') return '子女';
    counters[g] = (counters[g] || 0) + 1;
    if(r.rankKnown === false) return g === 'M' ? '子' : '女';
    return (FAM_ORD.charAt(counters[g] - 1) || counters[g]) + (g === 'M' ? '男' : '女');
  }
  // 生母（生父）下拉：本人的配偶＋同一張表新加的配偶；現在的生母不是本人配偶時照實列出「○○（非配偶）」
  function famOtherOptions(r){
    var sel = r.other || '', opts = [['', '（未登錄）']], seen = {};
    fam.rows.forEach(function(x){
      if(x.kind === 'spouse'){ opts.push([String(x.d.id), x.d.name]); seen[String(x.d.id)] = 1; }
      if(x.kind === 'newSpouse'){
        var nm = famVal(x.key, 'name');
        opts.push(['new:' + x.key, (nm || '新配偶') + '（新）']);
      }
    });
    if(r.orig && r.orig.other && !seen[r.orig.other]) opts.push([r.orig.other, (r.otherName || '') + '（非配偶）']);
    return opts.map(function(o){
      return '<option value="' + esc(o[0]) + '"' + (o[0] === sel ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
    }).join('');
  }
  function famRowHtml(r, label){
    var d = r.d || {}, k = r.key, dis = r.ro ? ' disabled' : '';
    function inp(f, val, ph){
      return '<input class="input fam-in" data-k="' + k + '" data-f="' + f + '" value="' + esc(val == null ? '' : val) +
             '" placeholder="' + esc(ph || '') + '" autocomplete="off"' + dis + '>';
    }
    // 既有的人照實顯示（空白＝不詳）；只有新列預設男（新配偶預設本人的異性）
    var g = famIsNew(r) ? (d.gender == null ? 'M' : d.gender) : (d.gender || '');
    var gopts = [['M', '男'], ['F', '女']];
    if(g === 'O') gopts.push(['O', '其他']);     // 資料庫允許的「其他」：保留，不改寫成男
    gopts.push(['', '不詳']);
    var gsel = '<select class="select fam-in" data-k="' + k + '" data-f="gender" aria-label="性別"' + dis + '>' +
      gopts.map(function(o){
        return '<option value="' + o[0] + '"' + (g === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
      }).join('') + '</select>';
    var last = '';
    if(r.kind === 'spouse' || r.kind === 'newSpouse'){
      last = '<select class="select fam-in" data-k="' + k + '" data-f="status" aria-label="婚姻狀態"' + dis + '>' +
        Object.keys(STATUS_LABEL).map(function(s){
          return '<option value="' + s + '"' + ((r.status || 'MARRIED') === s ? ' selected' : '') + '>' + STATUS_LABEL[s] + '</option>';
        }).join('') + '</select>';
    } else if(r.kind === 'kid' || r.kind === 'newKid'){
      last = '<select class="select fam-in" data-k="' + k + '" data-f="other" aria-label="' + famOtherWord() + '"' + dis + '>' +
        famOtherOptions(r) + '</select>';
    }
    var act = famIsNew(r)
      ? '<button type="button" class="btn btn-ghost btn-sm" data-fam-del="' + k + '">移除</button>'
      : '<button type="button" class="btn btn-ghost btn-sm" data-fam-open="' + d.id + '">完整資料</button>';
    var death = famIsNew(r) ? '' : r.orig.death;
    return '<tr class="fam-' + r.kind + (r.ro ? ' fam-ro' : '') + '" data-row="' + k + '"' +
      (r.ro ? ' title="這一位的資料沒讀到，表上不能改；請按「完整資料」"' : '') + '>' +
      '<td class="fam-rel">' + esc(label) + '</td>' +
      '<td>' + inp('name', d.name, r.kind === 'newKid' ? '新子女姓名' : (r.kind === 'newSpouse' ? '配偶姓名' : '')) + '</td>' +
      '<td>' + inp('styleName', d.styleName, '') + '</td>' +
      '<td>' + gsel + '</td>' +
      '<td>' + inp('birth', d.birth, '例：1955') + '</td>' +
      '<td>' + inp('death', death, '在世留空') + '</td>' +
      '<td>' + last + '</td>' +
      '<td class="fam-act">' + act + '</td></tr>';
  }
  // 重畫整張表時保留目前打的字（只保留畫面上已經有的列；新列沒有 DOM，讀到的空值會蓋掉預設性別／生母）
  function famRender(){
    if(!fam || !famBody) return;
    var keep = {};
    fam.rows.forEach(function(r){
      if(famBody.querySelector('[data-row="' + r.key + '"]')) keep[r.key] = famRowVals(r);
    });
    var counters = {}, html = '';
    fam.rows.forEach(function(r){
      var label = r.kind === 'self' ? '本人'
        : r.kind === 'spouse' ? '配偶' + (r.role ? '（' + r.role + '）' : '')
        : r.kind === 'newSpouse' ? '新配偶'
        : r.kind === 'newKid' ? '新子女' : famKidLabel(r, counters);
      html += famRowHtml(r, label);
    });
    famBody.innerHTML = html;
    Object.keys(keep).forEach(function(key){
      var v = keep[key];
      Object.keys(v).forEach(function(f){
        var el = famBody.querySelector('[data-k="' + key + '"][data-f="' + f + '"]');
        if(el && (el.tagName !== 'SELECT' || el.querySelector('option[value="' + v[f] + '"]'))) el.value = v[f];
      });
    });
  }
  function famAddKid(focus){
    fam.seq += 1;
    var sps = fam.rows.filter(function(r){ return r.kind === 'spouse'; });
    fam.rows.push({ key: 'nk' + fam.seq, kind: 'newKid', d: { gender: 'M' }, orig: null,
                    other: sps.length === 1 ? String(sps[0].d.id) : '' });
    famRender();
    if(focus){
      var el = famBody.querySelector('[data-k="nk' + fam.seq + '"][data-f="name"]');
      if(el) setTimeout(function(){ el.focus(); }, 30);
    }
  }
  function famAddSpouse(){
    fam.seq += 1;
    var sg = fam.self.gender === 'M' ? 'F' : (fam.self.gender === 'F' ? 'M' : '');
    var at = 0;          // 新配偶放在最後一位配偶之後（子女之前）
    fam.rows.forEach(function(r, i){ if(r.kind === 'self' || r.kind === 'spouse' || r.kind === 'newSpouse') at = i + 1; });
    fam.rows.splice(at, 0, { key: 'ns' + fam.seq, kind: 'newSpouse', d: { gender: sg }, orig: null, status: 'MARRIED' });
    famRender();
    var el = famBody.querySelector('[data-k="ns' + fam.seq + '"][data-f="name"]');
    if(el) setTimeout(function(){ el.focus(); }, 30);
  }
  function famOrig(d, extra){
    // 過世欄：只有「卒日原文」、卒年空白的人也是已歿（同舊表單的規則），顯示「已歿」，免得看起來像在世
    var o = { name: d.name || '', styleName: d.styleName || '', gender: d.gender || '', birth: d.birth || '',
              death: d.death || ((d.alive === false || d.deathOriginal) ? DEATH_UNKNOWN : ''), other: '', status: '' };
    for(var k in (extra || {})) o[k] = extra[k];
    return o;
  }
  function openFamily(id, addKid){
    return window.KinAPI.getMember(id).then(function(self){
      if(!self) throw new Error('查無此成員');
      var sps = (self.spouses || []).filter(function(s){ return s && s.id; });
      var kids = self.children || [];
      var ids = sps.map(function(s){ return s.id; }).concat(kids.map(function(c){ return c.id; }));
      return Promise.all(ids.map(function(i){
        return window.KinAPI.getMember(i).catch(function(){ return null; });
      })).then(function(ds){
        var byId = {};
        ds.forEach(function(d){ if(d) byId[d.id] = d; });
        var selfSlot = famSlot(self.gender);
        var rows = [{ key: 's', kind: 'self', d: self, orig: famOrig(self) }];
        sps.forEach(function(s){
          var d = byId[s.id] || { id: s.id, name: s.name };
          rows.push({ key: 'p' + s.id, kind: 'spouse', d: d, ro: !byId[s.id], role: s.role || '',
                      status: s.status || 'MARRIED', orig: famOrig(d, { status: s.status || 'MARRIED' }) });
        });
        kids.forEach(function(c){
          var d = byId[c.id] || { id: c.id, name: c.name };
          // 生母（生父）只認「親生」那條邊；過繼／收養的親邊不在這裡顯示、也不會被動到。不是本人配偶也照實列出
          var bio = (d.parents || []).filter(function(p){
            return (p.relationType || 'BIOLOGICAL') === 'BIOLOGICAL' && String(p.id) !== String(self.id) &&
                   (!selfSlot || p.relation === (selfSlot === 'M' ? '母' : '父'));
          })[0];
          var op = bio ? String(bio.id) : '';
          rows.push({ key: 'c' + c.id, kind: 'kid', d: d, ro: !byId[c.id], origLabel: c.origLabel || '',
                      rankKnown: c.rankKnown, other: op, otherName: bio ? bio.name : '', orig: famOrig(d, { other: op }) });
        });
        fam = { self: self, rows: rows, seq: 0 };
        if(famTitle) famTitle.textContent = (self.name || '') + ' 一家';
        if(famSub) famSub.textContent = [self.gen ? '第' + genCn(self.gen) + '世' : '', self.branch || '',
          self.fatherName ? '父 ' + self.fatherName : ''].filter(Boolean).join('・') +
          (self.gen ? '　子女為第' + genCn(self.gen + 1) + '世' : '');
        if(famOtherHead) famOtherHead.textContent = famOtherWord() + '（子女）／婚姻（配偶）';
        if(famBody) famBody.innerHTML = '';
        famRender();
        if(addKid) famAddKid(true);
        famMask.hidden = false;
      });
    }).catch(function(err){
      if(typeof toast === 'function') toast('讀取這一家失敗：' + (err && err.message ? err.message : ''), 'err');
    });
  }
  function closeFamily(force){
    if(!force && famDirty() &&
       !window.confirm(['表上改過的還沒儲存，確定要放棄嗎？', '（想保留請按「取消」，再按「儲存」。）'].join(String.fromCharCode(10)))) return false;
    if(famMask) famMask.hidden = true;
    fam = null;
    return true;
  }
  function famDeath(v){ return v === '歿' || v === DEATH_UNKNOWN ? DEATH_UNKNOWN : v; }
  function famBusy(on){
    [famSaveBtn, famAddKidBtn, famAddSpBtn].forEach(function(b){ if(b) b.disabled = on; });
  }
  function famMark(r, f){
    var el = famBody.querySelector('[data-k="' + r.key + '"][data-f="' + f + '"]');
    if(el) el.classList.add('fam-bad');
  }
  function famSave(){
    if(!fam || !famSaveBtn || famSaveBtn.disabled) return Promise.resolve(false);
    var self = fam.self, rows = fam.rows;
    rows.forEach(function(r){ r.v = famRowVals(r); });
    famBody.querySelectorAll('.fam-bad').forEach(function(el){ el.classList.remove('fam-bad'); });
    var selfSlot = famSlot(rows[0].v.gender), problems = [];
    // 1) 有填東西的列一定要有姓名
    var noName = rows.filter(function(r){
      return !r.ro && (famIsNew(r) ? (famHasInput(r.v) && !r.v.name) : !r.v.name);
    });
    noName.forEach(function(r){ famMark(r, 'name'); });
    if(noName.length) problems.push('有一列沒填姓名：請補上，或按那一列的「移除」');
    // 2) 要接子女（新子女、改生母）時，本人一定要有性別，否則後端分不出父槽母槽、子女會接不上變孤兒
    var kidLinks = rows.filter(function(r){
      return (r.kind === 'newKid' && famHasInput(r.v)) || (r.kind === 'kid' && !r.ro && r.v.other !== r.orig.other);
    });
    if(kidLinks.length && !selfSlot){
      famMark(rows[0], 'gender');
      problems.push('請先在「本人」那一列選性別（男／女），子女才接得上');
    }
    // 3) 選的生母（生父）要有性別、而且跟本人相反（後端：同槽會擠掉本人那條親邊；性別空白直接拒收）
    function candGender(val){
      if(val.indexOf('new:') === 0){ var x = famRowByKey(val.slice(4)); return x ? x.v.gender : ''; }
      var sp = rows.filter(function(x){ return x.kind === 'spouse' && String(x.d.id) === val; })[0];
      return sp ? sp.v.gender : null;     // 不是本人配偶（原本就是他）：沒改就不檢查
    }
    if(selfSlot) kidLinks.forEach(function(r){
      if(!r.v.other || (r.kind === 'kid' && r.v.other === r.orig.other)) return;
      var g = candGender(r.v.other);
      if(g !== null && (!g || famSlot(g) === selfSlot)){
        famMark(r, 'other');
        problems.push('「' + (r.v.name || '新子女') + '」選的' + famOtherWord() + '性別沒設定或跟本人相同：請先在那位配偶的列設好性別');
      }
    });
    if(problems.length){
      if(typeof toast === 'function') toast(problems[0], 'err');
      return Promise.resolve(false);
    }
    var failed = [], notes = [], done = 0, newIds = {}, chain = Promise.resolve();
    function step(label, fn){
      chain = chain.then(fn).then(function(){ done += 1; }, function(err){
        var msg = err && err.message ? String(err.message).replace(/^API \d+：/, '') : '';
        failed.push(label + (msg ? '（' + msg + '）' : ''));
      });
    }
    // 建了人、關係卻沒接上：把剛建的人刪掉，不留孤兒（使用者重做也不會多一筆重複的人）
    function undoNew(id, err){
      return window.KinAPI.deleteMember(id).catch(function(){}).then(function(){ throw err; });
    }
    rows.forEach(function(r){
      var v = r.v, o = r.orig;
      if(famIsNew(r) || r.ro) return;
      var p = { id: r.d.id }, changed = false;
      ['name', 'styleName'].forEach(function(f){ if(v[f] !== o[f]){ p[f] = v[f]; changed = true; } });
      if(v.gender !== o.gender){ p.gender = v.gender || null; changed = true; }
      if(v.birth !== o.birth){ p.birth = v.birth || null; changed = true; }
      if(v.death !== o.death){
        var dd = famDeath(v.death);
        if(!dd && r.d.deathOriginal){
          notes.push('「' + v.name + '」有卒日原文，仍算已歿（要改成在世，請按「完整資料」清掉卒日原文）');
        } else { p.death = dd || null; p.alive = !dd; changed = true; }
      }
      if(changed) step('「' + v.name + '」的資料', function(){ return window.KinAPI.saveMember(p); });
      if(r.kind === 'spouse' && v.status !== o.status)
        step('「' + v.name + '」的婚姻狀態', function(){ return window.KinAPI.addSpouse(self.id, r.d.id, v.status); });
    });
    function newPayload(v, gen){
      var dd = famDeath(v.death);
      return { name: v.name, styleName: v.styleName, gender: v.gender || null, gen: gen, branch: self.branch || '',
               birth: v.birth || null, death: dd || null, alive: !dd };
    }
    // 新配偶先建（新子女的生母可能就是他）
    rows.forEach(function(r){
      if(r.kind !== 'newSpouse' || !famHasInput(r.v)) return;
      var v = r.v;
      step('新配偶「' + v.name + '」', function(){
        return window.KinAPI.saveMember(newPayload(v, self.gen || 1)).then(function(res){
          if(!res || !res.id) throw new Error('建立失敗');
          return window.KinAPI.addSpouse(self.id, res.id, v.status || 'MARRIED').then(function(){
            newIds['new:' + r.key] = res.id;
          }, function(err){ return undoNew(res.id, err); });
        });
      });
    });
    function otherId(val){
      if(!val) return null;
      return val.indexOf('new:') === 0 ? (newIds[val] || null) : Number(val);
    }
    rows.forEach(function(r){
      var v = r.v;
      if(r.kind === 'kid' && !r.ro && v.other !== r.orig.other){
        step('「' + v.name + '」的' + famOtherWord(), function(){
          // 改成另一位：直接加（後端同型別同槽自動取代舊的那條），失敗時舊的還在；選「未登錄」才刪
          if(!v.other) return window.KinAPI.removeParent(r.d.id, Number(r.orig.other), 'BIOLOGICAL');
          var nid = otherId(v.other);
          if(!nid) throw new Error('選的那位新配偶沒建立成功');
          return window.KinAPI.addParent(r.d.id, nid, 'BIOLOGICAL');
        });
      }
      if(r.kind === 'newKid' && famHasInput(v)){
        step('新子女「' + v.name + '」', function(){
          return window.KinAPI.saveMember(newPayload(v, (self.gen || 0) + 1)).then(function(res){
            if(!res || !res.id) throw new Error('建立失敗');
            return window.KinAPI.addParent(res.id, self.id, 'BIOLOGICAL').then(function(){
              var nid = otherId(v.other);
              if(v.other && !nid) throw new Error('已建好並接上本人，但選的' + famOtherWord() + '（新配偶）沒建立成功');
              return nid ? window.KinAPI.addParent(res.id, nid, 'BIOLOGICAL').catch(function(err){
                throw new Error('已建好並接上本人，但' + famOtherWord() + '沒接上：' +
                                (err && err.message ? String(err.message).replace(/^API \d+：/, '') : ''));
              }) : null;
            }, function(err){ return undoNew(res.id, err); });
          });
        });
      }
    });
    famBusy(true);      // 表格重讀完才恢復：存完到換新表之間再按一次，會把同一批新子女又建一次
    return chain.then(function(){
      if(typeof toast === 'function'){
        if(failed.length) toast('以下沒有存成功：' + failed.join('、') + '。其餘已儲存', 'err');
        else toast((done ? '這一家已儲存' : '沒有要儲存的修改') + (notes.length ? '。' + notes.join('；') : ''), notes.length ? 'err' : 'ok');
      }
      locateInTree(self.id);                       // 族譜重載、選回本人
      return openFamily(self.id).then(function(){ return !failed.length; });   // 表格換成存好的樣子
    }).then(function(ok){ famBusy(false); return ok; }, function(err){ famBusy(false); throw err; });
  }
  if(famMask){
    var famCancel = document.getElementById('fam-cancel');
    if(famCancel) famCancel.addEventListener('click', function(){ closeFamily(false); });
    if(famSaveBtn) famSaveBtn.addEventListener('click', function(){ window.requireEdit(famSave); });
    if(famAddKidBtn) famAddKidBtn.addEventListener('click', function(){ if(fam) famAddKid(true); });
    if(famAddSpBtn) famAddSpBtn.addEventListener('click', function(){ if(fam) famAddSpouse(); });
    famBody.addEventListener('click', function(e){
      var del = e.target.closest ? e.target.closest('[data-fam-del]') : null;
      if(del && fam){
        var key = del.getAttribute('data-fam-del');
        fam.rows = fam.rows.filter(function(r){ return r.key !== key; });
        famRender();
        return;
      }
      var op = e.target.closest ? e.target.closest('[data-fam-open]') : null;
      if(op && fam){
        var mid = Number(op.getAttribute('data-fam-open'));
        var go = function(){ window.KinAPI.getMember(mid).then(function(d){ openMemberForm(d); }); };
        // 表上有沒存的修改：先存才打開（完整資料改完回來表格要重讀，沒存的會不見）；不存就留在表上
        if(famDirty()){
          if(window.confirm('表上有改過的還沒儲存。要先儲存，再打開完整資料嗎？（按「取消」就留在表上，什麼都不動）'))
            famSave().then(function(ok){ if(ok) go(); });
        } else go();
      }
    });
    // 新配偶改名：生母（生父）下拉跟著更新
    famBody.addEventListener('input', function(e){
      var t = e.target;
      if(!fam || !t || t.getAttribute('data-f') !== 'name') return;
      var r = famRowByKey(t.getAttribute('data-k'));
      if(r && r.kind === 'newSpouse'){
        famBody.querySelectorAll('[data-f="other"]').forEach(function(sel){
          var row = famRowByKey(sel.getAttribute('data-k'));
          var cur = sel.value;
          if(row){ row.other = cur; sel.innerHTML = famOtherOptions(row); sel.value = cur; }
        });
      }
    });
  }
  function famOpenFromDetail(addKid){
    if(!curSel) return;
    window.requireEdit(function(){
      if(!curSel) return;
      openFamily(curSel.id, addKid);
    });
  }
  if(mdFamily) mdFamily.addEventListener('click', function(){ famOpenFromDetail(false); });
  if(mdAddChild) mdAddChild.addEventListener('click', function(){ famOpenFromDetail(true); });
  // 從「完整資料」改完回來：表格重讀，顯示剛存好的樣子（表上有沒存的修改就不重讀，免得蓋掉）
  function famRefreshAfterForm(){
    if(fam && famMask && !famMask.hidden && !famDirty()){
      var sid = fam.self.id;
      setTimeout(function(){ openFamily(sid); }, 300);
    }
  }

  // 「新增成員」接同一表單（空白），存檔後定位到新成員（常駐可見＋requireEdit）
  if(addBtn){
    addBtn.addEventListener('click', function(){
      window.requireEdit(function(){ openMemberForm(null); });
    });
  }

  // 儲存：組 KinAPI.saveMember payload → toast → 重載列表並重新選取該人
  if(mfSave){
    mfSave.addEventListener('click', function(){
      var name = (mfName.value || '').trim();
      var gen  = parseInt(mfGen.value, 10);
      if(!name){ if(typeof toast==='function') toast('請填寫姓名', 'err'); mfName.focus(); return; }
      if(!gen || gen < 1){ if(typeof toast==='function') toast('請填寫世代（正整數，例：3）', 'err'); mfGen.focus(); return; }
      var death = (mfDeadUnk && mfDeadUnk.checked) ? DEATH_UNKNOWN : (mfDeath.value || '').trim();
      // 卒年空白但「卒日原文」有寫（常見：只記得忌日、不知年份）＝已過世，同 CSV 匯入的規則
      if(!death && (mfDeathOrig.value || '').trim()) death = DEATH_UNKNOWN;
      var wasEdit = !!mformId;
      var payload = {
        name: name,
        styleName: (mfStyle.value || '').trim(),
        gender: currentGender() || null,          // 不詳＝null（資料庫 CHECK 僅收 M/F/O 或 NULL）
        gen: gen,
        branch: mfBranch ? mfBranch.value : '',
        birth: (mfBirth.value || '').trim() || null,
        birthOriginal: (mfBirthOrig.value || '').trim(),
        death: death || null,                     // 卒年、卒日原文都空白且未勾「卒年不詳」＝在世
        deathOriginal: (mfDeathOrig.value || '').trim(),
        phone: (mfPhone.value || '').trim(),
        customKin: mfCustomKin ? (mfCustomKin.value || '').trim() : '',   // R4 習慣稱呼
        postalCode: mfPostal ? (mfPostal.value || '').trim() : '',
        city: (mfCity.value || '').trim(),
        burial: mfBurial ? (mfBurial.value || '').trim() : '',
        burialType: mfBurialTy ? mfBurialTy.value : '',
        burialCode: mfBurialCd ? (mfBurialCd.value || '').trim() : '',
        note: mfNote ? (mfNote.value || '').trim() : '',
        mailTarget: mfMailTgt ? (mfMailTgt.checked ? 1 : 0) : 0,
        alive: !death                             // mock 模式用；web 後端由 death 推導
        // 父母／配偶改由「親屬關係」區維護（addParent/addSpouse），不再傳 fatherId
      };
      if(wasEdit) payload.id = mformId;
      mfSave.disabled = true;
      var relFailed = [];
      window.KinAPI.saveMember(payload).then(function(res){
        var newId = (res && res.id) || mformId;
        // 新增成員：把表單暫存的父母／配偶逐筆補送（雙軌關係邊；見 sendQueuedRels）
        if(wasEdit || !newId) return newId;
        return sendQueuedRels(newId, relParents, relSpouses).then(function(failed){
          relFailed = failed;
          return newId;
        });
      }).then(function(newId){
        mfSave.disabled = false;
        closeMemberForm();
        if(typeof toast==='function'){
          // 有親屬沒寫入：同一則訊息講清楚是哪幾筆，不再接著顯示一則「已新增成員」蓋過去
          if(relFailed.length) toast('已新增成員「' + name + '」，但以下親屬關係沒有寫入：' +
            relFailed.join('、') + '。請開啟該成員的編輯表單補登', 'err');
          else toast(wasEdit ? '成員資料已儲存' : '已新增成員「' + name + '」', 'ok');
        }
        if(newId) locateInTree(newId);            // 重載全樹、展開祖先鏈並選取該人
        else load(branchEl.value, searchEl.value.trim());
      }).catch(function(err){
        mfSave.disabled = false;
        var msg = err && err.message ? String(err.message).replace(/^API \d+：/, '') : '';
        if(typeof toast==='function') toast(msg || '儲存失敗，請稍後再試', 'err');
      });
    });
  }

  // 刪除：雙重確認 → KinAPI.deleteMember；後端 409（仍有後代等）轉白話提示
  if(mfDelete){
    mfDelete.addEventListener('click', function(){
      if(!mformId) return;
      var nm = mformName0 || (mfName.value || '').trim() || '這位成員';
      if(!window.confirm('確定要刪除「' + nm + '」嗎？')) return;
      if(!window.confirm('再次確認：刪除「' + nm + '」後無法復原（其婚姻與安葬紀錄將一併移除）。\n確定要刪除嗎？')) return;
      var id = mformId;
      mfDelete.disabled = true;
      window.KinAPI.deleteMember(id).then(function(){
        mfDelete.disabled = false;
        closeMemberForm();
        if(typeof toast==='function') toast('已刪除「' + nm + '」', 'ok');
        // 清空詳情卡並重載列表
        curSel = null;
        if(mdEdit) mdEdit.disabled = true;   // 未選人：維持 disabled（仍可見）
        ['tree-md-family', 'tree-md-addchild'].forEach(function(bid){
          var b = document.getElementById(bid); if(b) b.hidden = true; });
        mdAva.className = 'ava';
        mdAva.textContent = '—';
        mdNm.textContent = '—';
        mdSub.textContent = '請在族譜中點選一位成員';
        mdGrid.innerHTML = '';
        load(branchEl.value, searchEl.value.trim());
      }).catch(function(err){
        mfDelete.disabled = false;
        var msg = err && err.message ? String(err.message).replace(/^API \d+：/, '') : '';
        if(typeof toast==='function') toast(msg || '刪除失敗：此成員可能仍有後代或其他關聯', 'err');
      });
    });
  }

  // 編輯模式下成員異動時重載清單
  window.KinAPI.on('member/changed', function(){
    load(branchEl.value, searchEl.value.trim());
  });

  // ── 初始化：等就緒後載入並選取始遷祖 ──
  window.KinAPI.ready.then(function(){ load('', '', true); });
})();

/* ============================================================
   視圖 2：稱謂 kin —— 下拉用 listMembers，計算用 kinship
   ============================================================ */
(function(){
  var root = document.querySelector('section[data-view="kin"]');
  if(!root || !window.KinAPI || !window.createMemberPicker) return;

  var mountA = root.querySelector('#kin-a');
  var mountB = root.querySelector('#kin-b');
  var swap   = root.querySelector('#kin-swap');
  var calc   = root.querySelector('#kin-calc');
  var termA  = root.querySelector('#kin-term-a');
  var termB  = root.querySelector('#kin-term-b');
  var pathEl = root.querySelector('#kin-path');

  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }

  // 主體／目標皆改用搜尋式成員選擇器；計算改以所選 id 呼叫 kinship
  var pickA = window.createMemberPicker({
    placeholder: '搜尋並選擇主體…',
    onSelect: function(){ calcKinship(); }
  });
  var pickB = window.createMemberPicker({
    placeholder: '搜尋並選擇目標…',
    onSelect: function(){ calcKinship(); }
  });
  mountA.appendChild(pickA.el);
  mountB.appendChild(pickB.el);

  // 以後端結果渲染雙向稱謂與路徑（用所選 id）
  function calcKinship(){
    var a = pickA.getValue(), b = pickB.getValue();
    if(!a || !b){
      termA.textContent = '—'; termB.textContent = '—';
      pathEl.textContent = '請選擇兩位族人後計算。';
      return;
    }
    if(a === b){
      termA.textContent = '本人';
      termB.textContent = '本人';
      pathEl.textContent = '主體與目標為同一人。';
      return;
    }
    pathEl.textContent = '計算中…';
    window.KinAPI.kinship(a, b).then(function(r){
      r = r || {};
      termA.textContent = r.forward || '—';
      termB.textContent = r.backward || '—';
      pathEl.innerHTML = '關係鏈：<span class="seg">' + esc(r.path || '—') + '</span>';
    }).catch(function(){
      termA.textContent = '—'; termB.textContent = '—';
      pathEl.textContent = '稱謂計算失敗，請稍後再試。';
      if(typeof toast === 'function') toast('稱謂計算失敗', 'err');
    });
  }

  swap.addEventListener('click', function(){
    var ma = pickA.getMember(), mb = pickB.getMember();
    pickA.setMember(mb);
    pickB.setMember(ma);
    calcKinship();
    if(typeof toast === 'function') toast('已對調主體與目標', 'ok');
  });

  calc.addEventListener('click', function(){
    var a = pickA.getMember(), b = pickB.getMember();
    if(!a || !b){
      if(typeof toast === 'function') toast('請先選擇主體與目標', 'err');
      return;
    }
    if(a.id === b.id){
      calcKinship();
      if(typeof toast === 'function') toast('主體與目標相同，請另選一位族人', 'err');
      return;
    }
    calcKinship();
    if(typeof toast === 'function'){
      toast('已計算 ' + a.name + ' 與 ' + b.name + ' 的稱謂', 'ok');
    }
  });
})();

/* ============================================================
   視圖 3：祭祖 ritual —— listEvents 列活動卡 + 下拉，
   對象用 listMembers，訊息用前端模板 fillTpl 套用
   （模板存 settings.notice_template，總幹事可自行編輯；後端不參與產文）。
   ============================================================ */
(function(){
  var root = document.querySelector('[data-view="ritual"]');
  if(!root || !window.KinAPI) return;

  var eventsBox = document.getElementById('ritual-events');
  var eventSel  = document.getElementById('ritual-event');

  // 通知作業台：範圍（全族在世／某房／自訂名單）→ 收件人清單
  var genBtn     = document.getElementById('ritual-gen');
  var countEl    = document.getElementById('ritual-count');
  var scopeSeg   = document.getElementById('ritual-scope');
  var branchWrap = document.getElementById('ritual-branch-wrap');
  var branchSel  = document.getElementById('ritual-scope-branch');
  var customWrap = document.getElementById('ritual-custom-wrap');
  var chipsBox   = document.getElementById('ritual-scope-chips');
  var pickMount  = document.getElementById('ritual-scope-pick');
  var copyAllBtn = document.getElementById('ritual-copy-all');
  var csvBtn     = document.getElementById('ritual-csv');
  var rosterBtn  = document.getElementById('ritual-roster');
  var listTable  = document.getElementById('ritual-list-table');
  var listBody   = document.getElementById('ritual-list');
  var tplBox     = document.getElementById('ritual-tpl');
  var tplSave    = document.getElementById('ritual-tpl-save');
  var scopeMode  = 'all';          // all | branch | custom
  var customList = [];             // 自訂名單 [{id,name,phone,label}]
  var lastRows   = [];             // 產生結果 [{name,phone,msg}]
  var TPL_DEFAULT = '{姓名}宗長 鈞鑒：\n本會訂於 {國曆}（農曆 {農曆}）舉行「{活動}」，地點：{地點}。{備註}\n敬請撥冗蒞臨，慎終追遠、共承家風；若不克前來，請回覆告知，謝謝。';

  // 自訂名單：搜尋式選擇器逐一加入
  var scopePick = window.createMemberPicker
    ? window.createMemberPicker({ placeholder: '搜尋並加入收件人…', onSelect: function(m){
        if(m && !customList.some(function(x){ return x.id === m.id; })){
          customList.push(m); renderChips();
        }
        if(scopePick && scopePick.clear) scopePick.clear();
      } })
    : null;
  if(scopePick && pickMount) pickMount.appendChild(scopePick.el);

  function renderChips(){
    if(!chipsBox) return;
    chipsBox.innerHTML = '';
    customList.forEach(function(m){
      var c = document.createElement('span');
      c.className = 'chip chip-accent';
      c.innerHTML = esc(m.name) + ' <button type="button" data-rm="' + m.id + '" style="border:0;background:none;cursor:pointer;color:inherit;font-weight:700">×</button>';
      chipsBox.appendChild(c);
    });
  }
  if(chipsBox) chipsBox.addEventListener('click', function(e){
    var b = e.target.closest('[data-rm]'); if(!b) return;
    var id = Number(b.getAttribute('data-rm'));
    customList = customList.filter(function(x){ return x.id !== id; });
    renderChips();
  });

  // 編輯模式：活動編輯／新增表單元素
  var addBtn     = document.getElementById('ritual-add');
  var editorBox  = document.getElementById('ritual-editor');
  var editorTtl  = document.getElementById('ritual-editor-title');
  var fName      = document.getElementById('ritual-f-name');
  var fDate      = document.getElementById('ritual-f-date');
  var fCalSeg    = document.getElementById('ritual-f-cal');
  var fLunarBox  = document.getElementById('ritual-f-lunar');   // 農曆：年＋月／日下拉（見 setCal）
  var fLy        = document.getElementById('ritual-f-ly');
  var fLm        = document.getElementById('ritual-f-lm');
  var fLd        = document.getElementById('ritual-f-ld');
  var fLHint     = document.getElementById('ritual-f-lhint');
  var fSolarLunar = document.getElementById('ritual-f-solar-lunar');   // 國曆日期→農曆對照
  var fLocation  = document.getElementById('ritual-f-location');
  var fNote      = document.getElementById('ritual-f-note');
  var fLetter    = document.getElementById('ritual-f-letter');
  var fSaveBtn   = document.getElementById('ritual-f-save');
  var fCancelBtn = document.getElementById('ritual-f-cancel');
  var editingId  = null;   // null=新增，數字=編輯既有活動
  var fDeceasedMount = document.getElementById('ritual-f-deceased');
  var editingDeceasedId = null;   // 活動的祭祀先人（deceased_member_id）

  // 祭祀先人選擇器：只挑已歿者（在世的不會是被祭祀對象）
  var deceasedPick = (window.createMemberPicker && fDeceasedMount)
    ? window.createMemberPicker({
        placeholder: '搜尋先人姓名／字號（留空＝合祭，不指定）…',
        onSelect: function(m){ editingDeceasedId = (m && m.id != null) ? m.id : null; }
      })
    : null;
  if(deceasedPick){
    fDeceasedMount.appendChild(deceasedPick.el);
    // 清除鈕（.mpick-clear）按下時 picker 不發 onSelect，這裡補一手把 id 也清掉
    deceasedPick.el.addEventListener('click', function(e){
      if(e.target.closest && e.target.closest('.mpick-clear')) editingDeceasedId = null;
    });
  }

  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
  function blank(v){ return v === '' || v === null || v === undefined; }

  var MONTH_CN = ['一','二','三','四','五','六','七','八','九','十','十一','十二'];
  // 由 solarDate('YYYY-MM-DD') 解析月/日
  function parseSolar(s){
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s || '');
    if(!m) return { mLabel:'', d:'' };
    var mon = parseInt(m[2],10), day = parseInt(m[3],10);
    return { mLabel:(MONTH_CN[mon-1]||mon)+'月', d:String(day) };
  }

  // 由活動組合 meta 行（地點／時間／備註）
  function eventMeta(e){
    var lines = [];
    if(!blank(e.location)) lines.push('祭祀地點：'+esc(e.location));
    if(!blank(e.time))     lines.push('時間：'+esc(e.time));
    if(!blank(e.note))     lines.push('備註：'+esc(e.note));
    return lines.join('<br>');
  }

  var lastEvents = [];   // 供編輯時依 id 取回原活動資料

  /* 年度＝活動實際發生的「國曆年」。一定要取 solarDate：農曆冬月／臘月會跨到次年國曆
     （農曆 2025-12-26 其實是國曆 2026-02-13），直接取農曆 date 前四碼會錯一年。
     solarDate 換算失敗（缺件／無效農曆日）退回 date 前四碼；再失敗回 0＝無法判定，
     0 一律當成要顯示，寧可多顯示也不能讓活動人間蒸發。 */
  function eventYear(e){
    var m = /^(\d{4})/.exec((e && (e.solarDate || e.date)) || '');
    return m ? parseInt(m[1], 10) : 0;
  }

  // 渲染活動卡（依 listEvents）。往年活動收進 <details> 摺疊，預設只顯示今年及未來。
  function renderEventCards(events){
    if(!eventsBox) return;
    lastEvents = events || [];
    eventsBox.innerHTML = '';
    if(!events.length){
      eventsBox.innerHTML = '<div class="banner banner-info" style="margin:8px 0">目前尚無祭祖活動。</div>';
      return;
    }
    var thisYear = new Date().getFullYear();
    var cur = [], old = [];
    events.forEach(function(e){
      var y = eventYear(e);
      (y === 0 || y >= thisYear ? cur : old).push(e);
    });
    if(!cur.length){
      eventsBox.innerHTML = '<div class="banner banner-info" style="margin:8px 0">'
        + '今年及未來尚無祭祖活動（往年活動收在下方）。</div>';
    }
    cur.forEach(function(e){ eventsBox.appendChild(eventCard(e)); });
    if(old.length){
      var det = document.createElement('details');
      det.style.marginTop = '10px';
      var sum = document.createElement('summary');
      sum.style.cssText = 'cursor:pointer;padding:8px 2px;color:var(--muted);font-size:13px';
      sum.textContent = '往年活動（' + old.length + ' 筆）——仍可編輯與補印通知單';
      det.appendChild(sum);
      old.forEach(function(e){ det.appendChild(eventCard(e)); });
      eventsBox.appendChild(det);
    }
  }

  function eventCard(e){
      // 國曆有日期就用國曆解析日盒；否則退而求其次顯示農曆於日盒下方
      var sd = parseSolar(e.solarDate || (e.calendar==='SOLAR' ? e.date : ''));
      var card = document.createElement('div');
      card.className = 'card';
      card.innerHTML =
        '<div class="event-card">'+
          '<div class="date-box">'+
            '<div class="m">'+esc(sd.mLabel)+'</div>'+
            '<div class="d">'+esc(sd.d)+'</div>'+
            '<div class="lunar">'+esc(e.lunarDate || (e.calendar==='LUNAR' ? e.date : '') || '')+'</div>'+
          '</div>'+
          '<div class="ev-body">'+
            '<div class="nm">'+esc(e.name)+'</div>'+
            '<div class="meta">'+eventMeta(e)+'</div>'+
            // 存檔擋小月三十之前就存進庫的舊活動（後端 list_events 帶 problem）：當場提醒改日，
            // 不然通函照印不存在的日期、抬頭年份少一年，隔年還被收進「往年」（體檢 domain-3）
            (e.problem ? '<div class="banner banner-warn" style="margin-top:6px;font-size:13px">'+
              '這場活動的農曆日期有問題：'+esc(e.problem)+'請按「編輯」改好日期再列印通知單。</div>' : '')+
          '</div>'+
          '<div style="display:flex;gap:8px;align-self:flex-start;flex-wrap:wrap">'+
            // 年度動線捷徑：活動 → 一鍵開「掃墓通知單」合併寄送成品（正面寄件、背面通函）
            '<button class="btn btn-primary btn-sm" type="button" data-print-notice="'+esc(e.id)+'" '+
              'title="每位收件人兩頁：正面寄件資訊、背面掃墓通函；雙面列印對摺即寄">'+
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V3h12v6"/><rect x="6" y="13" width="12" height="8"/><path d="M6 17H4a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-2"/></svg>'+
              '列印通知單'+
            '</button>'+
            '<button class="btn btn-ghost btn-sm locked-hint" type="button" data-edit-event="'+esc(e.id)+'">'+
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>'+
              '編輯'+
            '</button>'+
            '<button class="btn btn-ghost btn-sm locked-hint" type="button" data-copy-event="'+esc(e.id)+'" '+
              'title="沿用名稱、地點、備註與通函說明，日期年份 +1，開表單讓你確認後才新增">'+
              '複製為明年'+
            '</button>'+
            '<button class="btn btn-ghost btn-sm locked-hint" type="button" data-del-event="'+esc(e.id)+'" '+
              'title="刪除這場活動（需再次確認）">刪除</button>'+
          '</div>'+
        '</div>';
      return card;
  }

  // 下拉一定要帶年份：連續幾年都叫「清明掃墓祭祖」，只看名稱無從分辨，會選錯年發通知
  function fillEventSelect(events){
    eventSel.innerHTML = '';
    var thisYear = new Date().getFullYear();
    var groups = [
      { label: '今年及未來', items: [] },
      { label: '往年', items: [] }
    ];
    (events || []).forEach(function(e){
      var y = eventYear(e);
      groups[(y === 0 || y >= thisYear) ? 0 : 1].items.push(e);
    });
    groups.forEach(function(g){
      if(!g.items.length) return;
      var og = document.createElement('optgroup');
      og.label = g.label;
      g.items.forEach(function(e){
        var o = document.createElement('option');
        o.value = e.id;
        o.textContent = e.name + '（' + (eventYear(e) || '年份不明') + '）';
        og.appendChild(o);
      });
      eventSel.appendChild(og);
    });
  }

  // ── 通知作業台 ──────────────────────────────────────────
  function copyText(txt, okMsg){
    function done(){ if(typeof toast === 'function') toast(okMsg || '已複製到剪貼簿', 'ok'); }
    function fail(){ if(typeof toast === 'function') toast('複製失敗，請手動選取', 'err'); }
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(txt).then(done).catch(function(){
        try{
          var ta = document.createElement('textarea');
          ta.value = txt; document.body.appendChild(ta); ta.select();
          document.execCommand('copy'); document.body.removeChild(ta); done();
        }catch(e){ fail(); }
      });
    } else { fail(); }
  }

  // 範圍切換：某房顯示房下拉、自訂顯示選擇器
  if(scopeSeg) scopeSeg.addEventListener('click', function(e){
    var b = e.target.closest('button'); if(!b) return;
    scopeSeg.querySelectorAll('button').forEach(function(x){ x.classList.remove('on'); });
    b.classList.add('on');
    scopeMode = b.getAttribute('data-scope') || 'all';
    if(branchWrap) branchWrap.hidden = scopeMode !== 'branch';
    if(customWrap) customWrap.hidden = scopeMode !== 'custom';
  });

  // 房頭選項由全站 KinBranches 統一填（SELECT_IDS 含 ritual-scope-branch，房頭一改即時更新）

  // 模板：settings.notice_template（無則內建預設）；編輯模式可改
  function loadTpl(){
    window.KinAPI.getSettings().then(function(s){
      if(tplBox) tplBox.value = (s && s.notice_template) || TPL_DEFAULT;
    }).catch(function(){ if(tplBox) tplBox.value = TPL_DEFAULT; });
  }
  if(tplSave) tplSave.addEventListener('click', function(){
    var v = (tplBox && tplBox.value || '').trim() || TPL_DEFAULT;
    var bad = badVars(v);
    if(bad.length && !window.confirm(
        '模板裡有無法辨識的佔位符：' + bad.join('、') + '\n' +
        '這些字會原樣印在通知訊息裡（不會被代換成資料）。\n\n' +
        '可用的佔位符只有：' + tplVarsText() + '\n\n仍要儲存嗎？')) return;
    window.KinAPI.setSettings({ notice_template: v }).then(function(){
      if(typeof toast === 'function') toast('訊息模板已儲存', 'ok');
    }).catch(function(e){ if(typeof toast === 'function') toast((e && e.message) || '儲存失敗（需編輯模式）', 'err'); });
  });

  /* 佔位符：值表是唯一來源——UI 上的「可用佔位符」提示、存檔掃描、代換三處
     全部由 tplVals 的鍵推出，不再有第二份硬編清單可以漂移。 */
  function tplVals(m, ev){
    return {
      '姓名': m.name || '',
      '活動': ev.name || '',
      '國曆': ev.solarDate || (ev.calendar === 'SOLAR' ? ev.date : '') || '（日期另行通知）',
      '農曆': ev.lunarDate || (ev.calendar === 'LUNAR' ? ev.date : '') || '—',
      '地點': ev.location || '（地點另行通知）',
      '備註': ev.note ? ('（' + ev.note + '）') : '',
      // 裔稱＝這場活動的祭祀先人會怎麼稱呼收件人（裔孫／裔孫女…）。
      // 由 KinAPI.kinshipBatch 一次算完後放進 kinTerms（見 genBtn）；
      // 活動沒設先人、或算不出（姻親、父系資料待補、缺生年判不出長幼）一律退回通稱「族親」
      // （與稱謂頁同一個詞；總幹事 2026-08-21：生年不可控，判不出就都寫族親，不要兩套字）。
      '裔稱': kinTerms[String(m.id)] || '族親'
    };
  }
  var kinTerms = {};   // {memberId: 稱謂}，每次「產生通知清單」時重算
  var TPL_VARS = (function(){ var o = tplVals({}, {}), a = []; for(var k in o) if(o.hasOwnProperty(k)) a.push(k); return a; })();
  var TPL_RE = /\{([^{}]{1,12})\}/g;
  function tplVarsText(){ return '{' + TPL_VARS.join('} {') + '}'; }
  // UI 提示由同一份常數產生（HTML 內留有靜態 fallback，本檔沒跑到時仍看得到）
  (function(){
    var el = document.getElementById('ritual-tpl-vars');
    if(el) el.textContent = '佔位符：' + tplVarsText();
  })();

  // 未知佔位符（長輩常打 {電話}、{手機}）：回傳去重後的原字面陣列，供警告用
  function badVars(tpl){
    var bad = [], seen = {};
    String(tpl).replace(TPL_RE, function(all, k){
      if(TPL_VARS.indexOf(k) < 0 && !seen[k]){ seen[k] = 1; bad.push(all); }
      return all;
    });
    return bad;
  }

  // 單次掃描代換：未知佔位符原樣保留（行為與舊版一致），
  // 但值裡若含 $& 或 {活動} 之類的字樣不再被誤當替換樣式／二次代換。
  function fillTpl(tpl, m, ev){
    var v = tplVals(m, ev);
    return String(tpl).replace(TPL_RE, function(all, k){
      return v.hasOwnProperty(k) ? v[k] : all;
    });
  }

  function renderList(rows){
    lastRows = rows;
    if(countEl) countEl.textContent = rows.length + ' 位';
    if(copyAllBtn) copyAllBtn.disabled = !rows.length;
    if(csvBtn) csvBtn.disabled = !rows.length;
    if(!listTable || !listBody) return;
    listTable.hidden = !rows.length;
    listBody.innerHTML = rows.map(function(r, i){
      return '<tr><td>' + esc(r.name) + '</td>' +
        '<td>' + (r.phone ? '<span class="mono">' + esc(r.phone) + '</span>' : '<span style="color:var(--faint)">未登錄</span>') + '</td>' +
        '<td class="msg">' + esc(r.msg) + '</td>' +
        '<td><button class="btn btn-ghost btn-sm" type="button" data-copy-row="' + i + '">複製</button></td></tr>';
    }).join('');
  }
  if(listBody) listBody.addEventListener('click', function(e){
    var b = e.target.closest('[data-copy-row]'); if(!b) return;
    var r = lastRows[Number(b.getAttribute('data-copy-row'))];
    if(r) copyText(r.msg, '已複製給「' + r.name + '」的訊息');
  });

  if(genBtn) genBtn.addEventListener('click', function(){
    var ev = null;
    for(var i = 0; i < lastEvents.length; i++) if(String(lastEvents[i].id) === String(eventSel.value)) ev = lastEvents[i];
    if(!ev){ if(typeof toast === 'function') toast('請先選擇祭祖活動', 'err'); return; }
    if(scopeMode === 'custom' && !customList.length){
      if(typeof toast === 'function') toast('請先加入至少一位收件人', 'err'); return;
    }
    // 「某房」卻沒選到房：擋下來。舊版以空字串查詢＝全族，其他房的人也會收到（M-7）
    if(scopeMode === 'branch' && !(branchSel && branchSel.value)){
      var hasBranch = branchSel && branchSel.options.length > 1;
      if(typeof toast === 'function') toast(hasBranch
        ? '請先在「房頭」下拉選擇要通知哪一房'
        : '還沒有設定任何房頭，請先到「設定 → 房頭管理」新增，或改選「全族在世」', 'err');
      if(branchSel) branchSel.focus();
      return;
    }
    var tpl = (tplBox && tplBox.value || '').trim() || TPL_DEFAULT;
    // 這裡讀的是「尚未存檔」的框內文字，所以存檔時的警告擋不到；只提醒不阻擋
    var bad2 = badVars(tpl);
    if(bad2.length && typeof toast === 'function')
      toast('模板含無法辨識的 ' + bad2.join('、') + '，會原樣顯示', 'err');
    genBtn.disabled = true;
    var getRec = (scopeMode === 'custom')
      ? Promise.resolve(customList.slice())
      : window.KinAPI.listMembers(scopeMode === 'branch' ? branchSel.value : '', '')
          .then(function(ms){ return (ms || []).filter(function(m){ return m.alive; }); });
    getRec.then(function(rec){
      // {裔稱} 有用到才算稱謂：一次打一支批次端點（實測全族上千人不到一秒），
      // 絕不可逐人打 /api/kinship——那是上千次來回。活動沒設祭祀先人就不必算。
      var needKin = tpl.indexOf('{裔稱}') >= 0 && ev.deceasedId != null;
      kinTerms = {};
      if(!needKin) return rec;
      return window.KinAPI.kinshipBatch(ev.deceasedId, rec.map(function(m){ return m.id; }))
        .then(function(r){ kinTerms = (r && r.terms) || {}; return rec; })
        .catch(function(){ return rec; });   // 算不出就整批退回通稱，不擋產生
    }).then(function(rec){
      genBtn.disabled = false;
      var rows = rec.map(function(m){ return { name: m.name, phone: m.phone || '', msg: fillTpl(tpl, m, ev) }; });
      renderList(rows);
      if(typeof toast === 'function') toast('已產生 ' + rows.length + ' 則通知', rows.length ? 'ok' : 'err');
      if(tpl.indexOf('{裔稱}') >= 0 && ev.deceasedId == null && typeof toast === 'function')
        toast('模板用了 {裔稱}，但這場活動沒設「祭祀先人」，一律印「族親」', 'err');
    }).catch(function(){
      genBtn.disabled = false;
      if(typeof toast === 'function') toast('產生失敗，請稍後再試', 'err');
    });
  });

  if(copyAllBtn) copyAllBtn.addEventListener('click', function(){
    if(!lastRows.length) return;
    copyText(lastRows.map(function(r){ return r.msg; }).join('\n\n'), '已複製全部 ' + lastRows.length + ' 則');
  });

  if(csvBtn) csvBtn.addEventListener('click', function(){
    if(!lastRows.length) return;
    function q(s){ return '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"'; }
    var csv = '﻿姓名,電話,訊息\r\n' + lastRows.map(function(r){   // BOM：Excel 直開不亂碼
      return [q(r.name), q(r.phone), q(r.msg)].join(',');
    }).join('\r\n');
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = '祭祖通知名單.csv';
    document.body.appendChild(a); a.click();
    setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 400);
    if(typeof toast === 'function') toast('已匯出通知名單 CSV', 'ok');
  });

  // 通知名單紙本（一支一份，選家長→doc=roster&id=）已移到「列印」頁；
  // 此作業台專責逐人訊息（複製/CSV），不再有壞掉的 branch-only roster 按鈕。

  loadTpl();

  /* ── 編輯模式：活動編輯／新增 ──────────────────────────
     KinAPI.saveEvent(event) → 後端 upsert ritual_events，回存後重撈刷新。 */

  // 取目前曆法（.seg 上 .on 者）
  function currentCal(){
    if(!fCalSeg) return 'SOLAR';
    var on = fCalSeg.querySelector('button.on');
    return on ? (on.getAttribute('data-cal') || 'SOLAR') : 'SOLAR';
  }
  function setCal(cal){
    if(!fCalSeg) return;
    fCalSeg.querySelectorAll('button').forEach(function(b){
      b.classList.toggle('on', b.getAttribute('data-cal') === cal);
    });
    // 原生 <input type="date"> 一定是國曆月曆；選農曆時換成年＋月／日下拉，
    // 否則長輩會在國曆月曆上點一天、卻被當成農曆存進去（實測會差 46 天）。
    if(fDate)     fDate.hidden     = (cal !== 'SOLAR');
    if(fSolarLunar) fSolarLunar.hidden = (cal !== 'SOLAR');   // 對照提示跟著國曆欄一起藏
    if(fLunarBox) fLunarBox.hidden = (cal !== 'LUNAR');
    lunarHint();
  }

  /* ── 農曆年月日下拉（月／日用長輩慣用的中文俗名，與族譜原文一致）────── */
  var LUNAR_M_CN = ['正','二','三','四','五','六','七','八','九','十','冬','臘'];
  var GAN = '甲乙丙丁戊己庚辛壬癸', ZHI = '子丑寅卯辰巳午未申酉戌亥';
  function lunarDayCn(d){
    if(d === 10) return '初十';
    if(d === 20) return '二十';
    if(d === 30) return '三十';
    var t = ['','一','二','三','四','五','六','七','八','九'][d % 10];
    return (d < 11 ? '初' : d < 20 ? '十' : '廿') + t;
  }
  function pad2(n){ return ('0' + n).slice(-2); }
  (function fillLunarSelects(){
    var i, o;
    if(fLm && !fLm.options.length){
      o = document.createElement('option'); o.value = ''; o.textContent = '月'; fLm.appendChild(o);
      for(i = 1; i <= 12; i++){
        o = document.createElement('option'); o.value = String(i); o.textContent = LUNAR_M_CN[i-1] + '月';
        fLm.appendChild(o);
      }
    }
    if(fLd && !fLd.options.length){
      o = document.createElement('option'); o.value = ''; o.textContent = '日'; fLd.appendChild(o);
      for(i = 1; i <= 30; i++){
        o = document.createElement('option'); o.value = String(i); o.textContent = lunarDayCn(i);
        fLd.appendChild(o);
      }
    }
  })();
  // 先把選的年月日唸成干支給他確認，再問後端（KinAPI.solarOf）換算成國曆一起顯示（體檢 domain-3/4）：
  //   * 冬月、臘月落在隔年國曆——照直覺填「活動那年」會整整晚一年，國曆年和填的年不同就醒目提醒；
  //   * 小月沒有三十——當場講清楚該改選哪天（存檔時後端也會擋）。
  function setLunarHintText(text, level){
    fLHint.textContent = text;
    fLHint.style.color = level === 'err' ? 'var(--live)' : level === 'warn' ? 'var(--warn-fg)' : 'var(--muted)';
    fLHint.style.background = level === 'warn' ? 'var(--warn-bg)' : '';
    fLHint.style.fontWeight = level ? '600' : '';
    fLHint.style.padding = level === 'warn' ? '2px 6px' : '';
    fLHint.style.borderRadius = level === 'warn' ? '6px' : '';
  }
  function lunarSolarText(y, mName, base, r){
    // 回 [文字, 等級]；r＝solarOf 的回應 {solar, problem}
    if(r && r.problem) return [base + '　' + r.problem, 'err'];
    var mt = /^(\d{4})-(\d{2})-(\d{2})$/.exec((r && r.solar) || '');
    if(!mt) return [base, ''];
    var sy = +mt[1];
    var txt = base + '，國曆 ' + sy + ' 年 ' + (+mt[2]) + ' 月 ' + (+mt[3]) + ' 日'
      + (sy >= 1912 ? '（民國' + (sy - 1911) + '年）' : '');
    if(sy !== y) return [txt + '。注意：農曆 ' + y + ' 年的' + mName + '已經是國曆 ' + sy + ' 年；'
      + '若您要的是國曆 ' + y + ' 年的那一場，年份請改填 ' + (y - 1) + '。', 'warn'];
    return [txt, ''];
  }
  function lunarHint(){
    if(!fLHint) return;
    var y = fLy ? parseInt(fLy.value, 10) : 0;
    if(!(y >= 1900 && y <= 2099) || !fLm || !fLm.value || !fLd || !fLd.value){ setLunarHintText('', ''); return; }
    var gz = GAN.charAt((y - 4) % 10) + ZHI.charAt((y - 4) % 12);
    var mName = LUNAR_M_CN[+fLm.value - 1] + '月';
    var base = '＝' + gz + '年' + mName + lunarDayCn(+fLd.value);
    setLunarHintText(base, '');
    var v = readDate('LUNAR');
    if(!window.KinAPI || !window.KinAPI.solarOf) return;
    window.KinAPI.solarOf(v).then(function(r){
      if(readDate('LUNAR') !== v) return;   // 回來時已改選別天，丟掉舊結果
      var t = lunarSolarText(y, mName, base, r);
      setLunarHintText(t[0], t[1]);
    }).catch(function(){});
  }
  // 讀／填日期：對外一律是 'YYYY-MM-DD'（農曆時這是農曆年月日，後端契約不變）
  function readDate(cal){
    if(cal !== 'LUNAR') return fDate ? fDate.value.trim() : '';
    var y = fLy ? parseInt(fLy.value, 10) : 0;
    if(!(y >= 1900 && y <= 2099) || !fLm || !fLm.value || !fLd || !fLd.value) return '';
    return y + '-' + pad2(fLm.value) + '-' + pad2(fLd.value);
  }
  function writeDate(cal, raw){
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(raw || '');
    if(cal === 'LUNAR'){
      if(fLy) fLy.value = m ? m[1] : '';
      if(fLm) fLm.value = m ? String(parseInt(m[2], 10)) : '';
      if(fLd) fLd.value = m ? String(parseInt(m[3], 10)) : '';
      if(fDate) fDate.value = '';
    } else {
      if(fDate) fDate.value = m ? (m[1] + '-' + pad2(m[2]) + '-' + pad2(m[3])) : '';
      if(fLy) fLy.value = '';   // 切回國曆要把農曆三欄清掉，否則上一筆的農曆殘值會跟著顯示／送出
      if(fLm) fLm.value = '';
      if(fLd) fLd.value = '';
    }
    lunarHint();
    solarLunarHint();
  }
  var fSolarTimer = null;
  function solarLunarHint(){
    if(!fDate || !fSolarLunar) return;
    var v = (fDate.value || '').trim();
    if(!/^\d{4}-\d{2}-\d{2}$/.test(v)){ fSolarLunar.textContent = ''; return; }
    window.KinAPI.lunarOf(v).then(function(r){
      if((fDate.value || '').trim() === v)
        fSolarLunar.textContent = (r && r.lunar) ? ('＝農曆 ' + r.lunar) : '';
    }).catch(function(){ fSolarLunar.textContent = ''; });
  }
  if(fDate){
    fDate.addEventListener('change', solarLunarHint);
    fDate.addEventListener('input', function(){
      if(fSolarTimer) clearTimeout(fSolarTimer);
      fSolarTimer = setTimeout(solarLunarHint, 350);
    });
  }
  [fLy, fLm, fLd].forEach(function(el){ if(el) el.addEventListener('change', lunarHint); });
  if(fLy) fLy.addEventListener('input', lunarHint);

  function findEvent(id){
    for(var i = 0; i < lastEvents.length; i++) if(lastEvents[i].id === id) return lastEvents[i];
    return null;
  }
  function bumpYear(d){
    var m = /^(\d{4})(-\d{1,2}-\d{1,2})$/.exec(d || '');
    return m ? ((parseInt(m[1], 10) + 1) + m[2]) : '';
  }

  // 開啟編輯器：ev 為 null 代表新增，否則回填既有活動
  function openEditor(ev){
    if(!editorBox) return;
    // ev.id 為 null＝「複製為明年」帶進來的草稿：走新增路徑，標題也不能寫「編輯」
    editingId = (ev && ev.id) ? ev.id : null;
    // 逝者連結目前沒有 UI 可設，但要原封帶著走：編輯時不能掉、複製時新活動也要繼承，
    // 否則通函受文者會從「○○後裔族親」退化成「全體族親」。
    editingDeceasedId = (ev && ev.deceasedId != null) ? ev.deceasedId : null;
    if(deceasedPick){
      deceasedPick.clear();
      if(editingDeceasedId != null && window.KinAPI.getMember){
        (function(want){
          window.KinAPI.getMember(want).then(function(d){
            // 非同步回來時使用者可能已改選別人／關表單，只有仍是同一位才填回去
            if(d && editingDeceasedId === want) deceasedPick.setMember({ id: d.id, name: d.name, label: d.label || '' });
          }).catch(function(){});
        })(editingDeceasedId);
      }
    }
    if(editorTtl) editorTtl.textContent = editingId ? '編輯祭祖活動' : '新增祭祖活動';
    if(fName)     fName.value = ev ? (ev.name || '') : '';
    var calNow = ev ? (ev.calendar || (ev.lunarDate ? 'LUNAR' : 'SOLAR')) : 'SOLAR';
    setCal(calNow);
    // date 存的就是該曆法的年月日（農曆活動即農曆），依曆法填進對應控制項
    writeDate(calNow, ev ? (ev.date || ev.solarDate || '') : '');
    if(fLocation) fLocation.value = ev ? (ev.location || '') : '';
    if(fNote)     fNote.value = ev ? (ev.note || '') : '';
    if(fLetter)   fLetter.value = ev ? (ev.letterBody || '') : '';
    editorBox.hidden = false;
    edSnap = edState();   // 開啟當下的快照，供「有沒有改過」判斷
    editorBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    if(fName) fName.focus();
  }
  function closeEditor(){
    if(editorBox) editorBox.hidden = true;
    editingId = null;
  }

  /* ── 防「沒存的內容被換掉」（M-9／體檢 frontend-7）：比照成員表單的快照比對。
     舊版編輯中點別場活動的「編輯」（或「複製為明年」「新增活動」）直接把欄位換掉、按「取消」直接關，
     打了一大段的通函說明無聲消失。有改過就先問；沒改過照舊直接換／關。
     （儲存成功、退出編輯模式走 closeEditor 不經此守門。） */
  var edSnap = '';
  function edState(){
    return [fName && fName.value, currentCal(), fDate && fDate.value, fLy && fLy.value, fLm && fLm.value,
            fLd && fLd.value, fLocation && fLocation.value, fNote && fNote.value, fLetter && fLetter.value,
            editingDeceasedId == null ? '' : String(editingDeceasedId)].join(String.fromCharCode(1));
  }
  function confirmDiscardEditor(){
    if(!editorBox || editorBox.hidden || edState() === edSnap) return true;
    return window.confirm(['這場活動還沒儲存，確定要放棄這次的修改嗎？',
      '（想保留請按「取消」，回編輯區按「儲存」。）'].join(String.fromCharCode(10)));
  }

  if(addBtn){
    // 常駐可見：瀏覽模式點擊由 requireEdit 引導解鎖，成功後自動開新增表單
    addBtn.addEventListener('click', function(){
      window.requireEdit(function(){ if(confirmDiscardEditor()) openEditor(null); });
    });
  }
  if(fCancelBtn){
    fCancelBtn.addEventListener('click', function(){ if(confirmDiscardEditor()) closeEditor(); });
  }
  if(fCalSeg){
    fCalSeg.addEventListener('click', function(e){
      var btn = e.target.closest('button'); if(!btn) return;
      setCal(btn.getAttribute('data-cal') || 'SOLAR');
    });
  }
  // 活動卡上的「列印通知單／編輯」鈕（事件委派）
  if(eventsBox){
    eventsBox.addEventListener('click', function(e){
      var pbtn = e.target.closest('[data-print-notice]');
      if(pbtn){
        // 一鍵成品：合併寄送・全部房頭（單張校對／分房走列印頁）
        var pid = Number(pbtn.getAttribute('data-print-notice'));
        if(pid && typeof window.openPrint === 'function'){
          window.openPrint('doc=letter&event=' + encodeURIComponent(pid) + '&mail=all');
        }
        return;
      }
      var dbtn = e.target.closest('[data-del-event]');
      if(dbtn){
        var did = Number(dbtn.getAttribute('data-del-event'));
        var dsrc = findEvent(did);
        if(dsrc) window.requireEdit(function(){
          // 雙重確認（比照刪成員）：活動刪掉不影響任何成員資料，但通函與名單會跟著消失
          if(!window.confirm(['確定要刪除「' + dsrc.name + '」這場活動嗎？', '',
              '刪除後這場活動的通函說明、日期與祭祀先人設定都會一起消失，且無法復原。',
              '（成員資料不受影響。）'].join(String.fromCharCode(10)))) return;
          if(!window.confirm('再確認一次：真的要刪除「' + dsrc.name + '」？')) return;
          window.KinAPI.deleteEvent(did).then(function(){
            return window.KinAPI.listEvents();
          }).then(function(events){
            events = events || [];
            renderEventCards(events);
            fillEventSelect(events);
            if(typeof toast === 'function') toast('已刪除「' + dsrc.name + '」', 'ok');
          }).catch(function(err){
            if(typeof toast === 'function') toast((err && err.message) || '刪除失敗', 'err');
          });
        });
        return;
      }
      var cbtn = e.target.closest('[data-copy-event]');
      if(cbtn){
        var src = findEvent(Number(cbtn.getAttribute('data-copy-event')));
        if(src) window.requireEdit(function(){
          if(!confirmDiscardEditor()) return;
          var c = {}, k;
          for(k in src) if(src.hasOwnProperty(k)) c[k] = src[k];
          c.id = null;                       // ← 走 INSERT（save_event 無 id 即新增）
          c.date = bumpYear(src.date);       // 年份 +1，月日不動
          c.solarDate = ''; c.lunarDate = '';   // 清掉舊換算值，免得回填成去年的日期
          openEditor(c);
          // 清明是節氣、農曆還有閏月，年份 +1 只是候選日 → 一定讓人確認過再存
          if(typeof toast === 'function') toast('已帶入去年內容，請確認日期後再儲存', 'ok');
        });
        return;
      }
      var btn = e.target.closest('[data-edit-event]'); if(!btn) return;
      var ev = findEvent(Number(btn.getAttribute('data-edit-event')));
      if(ev) window.requireEdit(function(){ if(confirmDiscardEditor()) openEditor(ev); });
    });
  }

  if(fSaveBtn){
    fSaveBtn.addEventListener('click', function(){
      var name = fName ? fName.value.trim() : '';
      var cal  = currentCal();
      var date = readDate(cal);
      if(!name){ if(typeof toast==='function') toast('請填寫活動名稱', 'err'); if(fName) fName.focus(); return; }
      if(!date){
        if(typeof toast==='function') toast(cal === 'LUNAR' ? '請選擇農曆年、月、日' : '請選擇活動日期', 'err');
        var focusEl = cal === 'LUNAR' ? fLy : fDate;
        if(focusEl) focusEl.focus();
        return;
      }
      var payload = {
        name: name,
        calendar: cal,
        // 依曆法把日期放到對應欄位，後端據 calendar 收斂成 target_date
        solarDate: cal === 'SOLAR' ? date : '',
        lunarDate: cal === 'LUNAR' ? date : '',
        date: date,
        location: fLocation ? fLocation.value.trim() : '',
        note: fNote ? fNote.value.trim() : '',
        // 通函說明：多行內文（一行一條），僅去頭尾空白、保留換行供列印編號條列
        letterBody: fLetter ? fLetter.value.replace(/^\s+|\s+$/g, '') : '',
        deceasedId: editingDeceasedId
      };
      if(editingId) payload.id = editingId;
      // 先記下是不是改既有活動：closeEditor() 會把 editingId 清成 null，舊版在它之後才判斷，
      // 改既有活動永遠提示「已新增祭祖活動」（M-9／體檢 frontend-8）
      var wasEdit = !!editingId;
      fSaveBtn.disabled = true;
      window.KinAPI.saveEvent(payload).then(function(){
        // 回存後重撈 listEvents 刷新活動卡與下拉
        return window.KinAPI.listEvents();
      }).then(function(events){
        events = events || [];
        renderEventCards(events);
        fillEventSelect(events);
        fSaveBtn.disabled = false;
        closeEditor();
        if(typeof toast === 'function') toast(wasEdit ? '活動已更新' : '已新增祭祖活動', 'ok');
      }).catch(function(err){
        fSaveBtn.disabled = false;
        var msg = (err && err.message) ? err.message : '活動儲存失敗，請稍後再試';
        if(typeof toast === 'function') toast(msg, 'err');
      });
    });
  }

  // 退出編輯模式時收起編輯器
  if(window.KinAPI && window.KinAPI.on){
    window.KinAPI.on('lock/changed', function(st){
      if(!(st && st.editMode)) closeEditor();
    });
  }

  // ── 初始化：載入活動卡＋活動下拉（通知對象改由搜尋式選擇器隨打隨查，免預載）──
  window.KinAPI.ready.then(function(){
    return window.KinAPI.listEvents();
  }).then(function(events){
    events = events || [];
    renderEventCards(events);
    fillEventSelect(events);
  }).catch(function(){
    if(eventsBox) eventsBox.innerHTML = '<div class="banner banner-info" style="margin:8px 0">祭祖活動載入失敗。</div>';
    if(typeof toast === 'function') toast('祭祖資料載入失敗', 'err');
  });
})();

/* ============================================================
   視圖 4：列印 print —— 帶入家族資料列印（資料驅動）
   各卡對應 /print.html 的文件：
     * 全家族表：createMemberPicker 選家長 → doc=family&id=N
     * 直系族譜表：選祖先＋（可選）接哪位子女 → doc=lineage&id=N[&child=C]
     * 牌位姓名表：房頭下拉（可全部）    → doc=tablet[&branch=X]
     * 通知名單：房頭下拉（可全部）      → doc=roster[&branch=X]
     * 掃墓通函：活動下拉（listEvents）  → doc=letter&event=N
     * 信封片頭：房頭下拉（可全部）      → doc=labels[&branch=X]
     * 開會通知：無參數                  → doc=meeting
     * 交接單：靜態範本 列印範本/繫族交接單.html（不帶資料）
   一律 window.open('/print.html?doc=…&k=token')；token 自 location.search 取。
   展示模式（mock，沒有後端）→ 改開對應的版式示範（列印範本/，虛構資料）讓人先看版面。
   （2026-10-06 拿掉列印頁的「空白範本示範」區：名稱跟上面的卡對不起來、點了會印到假資料，
     展示模式的預覽改由這裡接手。）
   ============================================================ */
(function(){
  var root = document.querySelector('section[data-view="print"]');
  if(!root || !window.KinAPI) return;

  // 後端隨機 token（正式模式網址帶 ?k=…；mock 模式為空）
  var TOKEN = (function(){
    try {
      var m = (window.location.search || '').match(/[?&]k=([^&]+)/);
      return m ? m[1] : '';
    } catch(e){ return ''; }
  })();

  // 展示模式各文件對應的版式示範；開會通知沒有靜態範本
  var DEMO = { letter: '通知函', labels: '寄信封面標籤', roster: '通知名單', family: '族譜表',
               lineage: '族譜表', tablet: '牌位姓名表', tombgrid: '穴排位圖' };
  function openTemplate(name){
    var http = /^https?:$/i.test(window.location.protocol);   // file:// 直開走相對路徑（同範本連結改寫）
    window.open((http ? '/' : '../') + '列印範本/' + name + '.html' + (http && TOKEN ? '?k=' + TOKEN : ''), '_blank');
  }
  function openPrint(params){
    if(window.KinAPI.isMock()){
      var doc = (/(?:^|&)doc=([^&]+)/.exec(params) || [])[1];
      if(DEMO[doc]){
        openTemplate(DEMO[doc]);
        if(typeof toast === 'function') toast('展示模式：開的是版式示範（虛構資料），不是自家資料。', 'ok');
      } else if(typeof toast === 'function'){
        toast('帶入資料列印需在正式模式（本機伺服器）使用；目前為展示模式。', 'err');
      }
      return;
    }
    window.open('/print.html?' + params + (TOKEN ? '&k=' + TOKEN : ''), '_blank');
  }
  window.openPrint = openPrint;   // 供祭祖頁活動卡「列印通知單」共用（同一動線一鍵直達）

  // (1) 全家族表：搜尋式成員選擇器選「家長」
  var famSel = null;
  var famMount = document.getElementById('print-family-pick');
  if(famMount && window.createMemberPicker){
    var famPick = window.createMemberPicker({
      placeholder: '搜尋並選擇家長…',
      onSelect: function(m){ famSel = m; }
    });
    famMount.appendChild(famPick.el);
  }
  var famBtn = document.getElementById('print-family-btn');
  if(famBtn) famBtn.addEventListener('click', function(){
    if(!famSel){ if(typeof toast === 'function') toast('請先搜尋並選擇一位家長', 'err'); return; }
    openPrint('doc=family&id=' + encodeURIComponent(famSel.id));
  });

  // (1b) 直系族譜表：選祖先 → 下拉換成他的子女（預設全部兒子、每人一張）→ doc=lineage
  var linSel = null;
  var linMount = document.getElementById('print-lineage-pick');
  var linChild = document.getElementById('print-lineage-child');
  if(linMount && window.createMemberPicker){
    var linPick = window.createMemberPicker({
      placeholder: '搜尋並選擇祖先…',
      onSelect: function(m){
        linSel = m;
        if(!linChild) return;
        linChild.innerHTML = '<option value="">全部兒子（每人一張）</option>';
        window.KinAPI.getMember(m.id).then(function(d){
          if(!d || linSel !== m) return;          // 期間又換了人：丟掉舊的回應
          (d.children || []).forEach(function(c){
            var o = document.createElement('option');
            o.value = String(c.id);
            o.textContent = '只印 ' + c.name + ' 這一支';
            linChild.appendChild(o);
          });
        }).catch(function(){});
      }
    });
    linMount.appendChild(linPick.el);
  }
  var linBtn = document.getElementById('print-lineage-btn');
  if(linBtn) linBtn.addEventListener('click', function(){
    if(!linSel){ if(typeof toast === 'function') toast('請先搜尋並選擇一位祖先', 'err'); return; }
    var cv = linChild ? linChild.value : '';
    openPrint('doc=lineage&id=' + encodeURIComponent(linSel.id) + (cv ? '&child=' + encodeURIComponent(cv) : ''));
  });

  // 交接單：靜態範本（不帶族人資料），正式／展示模式都直接開
  var hoBtn = document.getElementById('print-handover-btn');
  if(hoBtn) hoBtn.addEventListener('click', function(){ openTemplate('繫族交接單'); });

  // (2) 牌位姓名表：房頭下拉（空值＝全部房頭；選項由 KinBranches IIFE 動態填充）
  var tabletSel = document.getElementById('print-tablet-branch');
  var tabletBtn = document.getElementById('print-tablet-btn');
  if(tabletBtn) tabletBtn.addEventListener('click', function(){
    var b = tabletSel ? tabletSel.value : '';
    openPrint('doc=tablet' + (b ? '&branch=' + encodeURIComponent(b) : ''));
  });

  // (3) 通知名單：一支一份——搜尋式選擇器選「家長」（同全家族表）
  var rosterSel = null;
  var rosterMount = document.getElementById('print-roster-pick');
  if(rosterMount && window.createMemberPicker){
    var rosterPick = window.createMemberPicker({
      placeholder: '搜尋並選擇該支家長…',
      onSelect: function(m){ rosterSel = m; }
    });
    rosterMount.appendChild(rosterPick.el);
  }
  var rosterBtn = document.getElementById('print-roster-btn');
  if(rosterBtn) rosterBtn.addEventListener('click', function(){
    if(!rosterSel){ if(typeof toast === 'function') toast('請先搜尋並選擇該支家長', 'err'); return; }
    openPrint('doc=roster&id=' + encodeURIComponent(rosterSel.id));
  });

  // (4) 掃墓通函：祭祖活動下拉（listEvents 動態填充；點列印分頁時重撈，
  //     祭祖頁新增活動後切回即可見；保留使用者已選值）
  var letterSel = document.getElementById('print-letter-event');
  var letterBtn = document.getElementById('print-letter-btn');

  // 寄送範圍下拉（通函／開會通知共用）：僅內容／合併全部／合併各房。
  // 值直通 print.html 的 mail 參數（'' | all | branch:<房>）。
  var mailSels = [document.getElementById('print-letter-mail'),
                  document.getElementById('print-meeting-mail')];
  function fillMailSels(){
    var list = (window.KinBranches && window.KinBranches.list()) || [];
    mailSels.forEach(function(sel){
      if(!sel) return;
      var keep = sel.value;
      while(sel.options.length > 2) sel.remove(2);   // 前兩項固定：僅內容／全部
      list.forEach(function(b){
        var o = document.createElement('option');
        o.value = 'branch:' + b;
        o.textContent = '合併寄送・' + b;
        sel.appendChild(o);
      });
      sel.value = keep;
      if(sel.selectedIndex < 0) sel.selectedIndex = 0;
    });
  }
  function fillLetterEvents(){
    fillMailSels();
    if(!letterSel) return;
    window.KinAPI.listEvents().then(function(evs){
      evs = evs || [];
      var keep = letterSel.value;
      while(letterSel.options.length > 1) letterSel.remove(1);
      for(var i = 0; i < evs.length; i++){
        var o = document.createElement('option');
        o.value = String(evs[i].id);
        // 農曆活動的 date 是農曆 ISO（長得像國曆會誤導）：顯示以國曆 solarDate 為主、附農曆文字
        var d  = evs[i].solarDate || evs[i].date || '';
        var lt = evs[i].lunarDate || '';
        var ld = lt ? '，' + (lt.indexOf('農曆') === 0 ? lt : '農曆' + lt) : '';   // 後端給「乙巳年三月初八」、mock 給「農曆三月初八」，都不重複冠字
        o.textContent = (evs[i].name || '') + (d ? '（' + d + ld + '）' : '');
        letterSel.appendChild(o);
      }
      letterSel.value = keep;                       // 活動被刪則自動回退到提示列
      if(letterSel.selectedIndex < 0) letterSel.selectedIndex = 0;
    }).catch(function(){ /* 載入失敗保留提示列，按鈕會再擋 */ });
  }
  window.KinAPI.ready.then(fillLetterEvents);
  var printNav = document.querySelector('.nav-item[data-view="print"]');
  if(printNav) printNav.addEventListener('click', fillLetterEvents);
  if(letterBtn) letterBtn.addEventListener('click', function(){
    var id = letterSel ? letterSel.value : '';
    if(!id){ if(typeof toast === 'function') toast('請先選擇祭祖活動', 'err'); return; }
    var mv = mailSels[0] ? mailSels[0].value : '';
    openPrint('doc=letter&event=' + encodeURIComponent(id) +
              (mv ? '&mail=' + encodeURIComponent(mv) : ''));
  });

  // (5) 信封片頭：房頭下拉（選項由 KinBranches IIFE 動態填充，同 (2)(3)）
  var labelsSel = document.getElementById('print-labels-branch');
  var labelsBtn = document.getElementById('print-labels-btn');
  if(labelsBtn) labelsBtn.addEventListener('click', function(){
    var b = labelsSel ? labelsSel.value : '';
    openPrint('doc=labels' + (b ? '&branch=' + encodeURIComponent(b) : ''));
  });

  // (7) 穴排位圖：場地下拉（listTombSites）→ doc=tombgrid&site=N｜all（每場地一頁）
  var tombSel = document.getElementById('print-tomb-site');
  var tombBtn = document.getElementById('print-tomb-btn');
  function fillTombSites(){
    if(!tombSel) return;
    window.KinAPI.listTombSites().then(function(list){
      var keep = tombSel.value;
      while(tombSel.options.length > 1) tombSel.remove(1);
      (list || []).forEach(function(s){
        var o = document.createElement('option');
        o.value = String(s.id); o.textContent = s.name + '（' + s.rows + '×' + s.cols + '）';
        tombSel.appendChild(o);
      });
      if(keep) tombSel.value = keep;
      if(tombSel.selectedIndex < 0) tombSel.selectedIndex = 0;
    }).catch(function(){ /* 清單失敗保留「全部」 */ });
  }
  window.KinAPI.ready.then(fillTombSites);
  if(printNav) printNav.addEventListener('click', fillTombSites);
  if(tombBtn) tombBtn.addEventListener('click', function(){
    openPrint('doc=tombgrid&site=' + encodeURIComponent((tombSel && tombSel.value) || 'all'));
  });

  // (6) 開會通知：抬頭取設定頁協會資料，欄位於列印頁直接點字修改；
  //     寄送範圍選「合併」時帶 mail 參數（正面寄件、背面通知）
  var meetingBtn = document.getElementById('print-meeting-btn');
  if(meetingBtn) meetingBtn.addEventListener('click', function(){
    var mv = mailSels[1] ? mailSels[1].value : '';
    openPrint('doc=meeting' + (mv ? '&mail=' + encodeURIComponent(mv) : ''));
  });
})();

/* ============================================================
   視圖 4：列印 print —— 範本連結路徑修正
   列印範本/ 是 webview/ 的兄弟目錄，不在伺服器靜態根內：
   * file:// 直開預覽：相對路徑 ../列印範本/ 本可直開，維持原樣。
   * http(s)（python app.py / exe 正式模式）：../ 會被解析成 /列印範本/
     以外的位置而 404，改走伺服器白名單路由 /列印範本/*（見 server._static）。
   現在只剩祭祖頁「開啟正式通知函」這類 <a> 連結（列印頁的示範卡已拿掉，展示模式改走 openTemplate）。
   ============================================================ */
(function(){
  var IS_HTTP = /^https?:$/i.test(window.location.protocol);
  if(!IS_HTTP) return;   // file:// 預覽走相對路徑即可，不改寫
  var links = document.querySelectorAll('a[href^="../列印範本/"]');
  for(var i = 0; i < links.length; i++){
    var href = links[i].getAttribute('href');
    links[i].setAttribute('href', href.replace(/^\.\.\//, '/'));
  }
})();

/* ============================================================
   視圖 5：設定 settings —— getSettings 回填、setSettings 寫回、
   備份／還原／匯入／匯出接對應 KinAPI 方法。
   ============================================================ */
(function () {
  var V = "settings";
  var $ = function (id) { return document.getElementById(V + "-" + id); };
  var t = function (m, k) { if (typeof toast === "function") toast(m, k); };

  // (2) 主題 .seg → setSettings({theme}) + setTheme（改 DOM）
  var seg = $("themeSeg");
  if (seg) {
    seg.querySelectorAll("button").forEach(function (b) {
      b.addEventListener("click", function () {
        seg.querySelectorAll("button").forEach(function (x) { x.classList.remove("on"); });
        b.classList.add("on");
        var mode = b.getAttribute("data-theme");
        if (typeof setTheme === "function") setTheme(mode);
        if (window.KinAPI) window.KinAPI.setSettings({ theme: mode }).catch(function () {
          t("主題沒有存成，下次開啟會回到原本的主題", "err");
        });
        var label = { light: "淺色", dark: "深色", system: "跟隨系統" }[mode] || mode;
        t("主題已切換為「" + label + "」", "ok");
      });
    });
  }

  // (3) 介面縮放（長輩閱讀用）：整體放大，非只改字級。
  //     舊版改 root font-size 完全無效——app.css 一律絕對 px、零 rem，改 root 不影響任何元素。
  //     改用 CSS zoom（WebView2/Chromium 原生支援，連 px 尺寸一起放大，版面自動回流）；
  //     若瀏覽器不支援 zoom 則退回 transform scale（需自行補寬高，故僅作後備）。
  //     設定存後端 settings.ui_zoom（同主題，是免解鎖的顯示偏好），啟動時由下方初始化套用。
  //     舊版只存 localStorage：每次開程式的網址埠都不同，localStorage 以網址區隔，
  //     所以重開一定回 100%（M-9／體檢 frontend-5）。
  var zoom = $("zoom");
  var zoomVal = $("zoomVal");
  var applyZoom = null;
  if (zoom) {
    var zoomSupported = ("zoom" in document.documentElement.style);
    applyZoom = function (announce) {
      var pct = parseInt(zoom.value, 10) || 100;
      var body = document.body;
      if (zoomSupported) {
        body.style.zoom = pct === 100 ? "" : (pct / 100);
        // body 被 zoom 後，裡面的 100vh 也跟著放大（130% 時整個畫面高出視窗約三成，要捲兩層才看得到底）；
        // CSS 以 calc(100vh / var(--uiz)) 換回真正的視窗高
        document.documentElement.style.setProperty("--uiz", String(pct / 100));
      } else {                                  // 後備：scale 需補寬度，避免右側被裁切
        body.style.transformOrigin = "top left";
        body.style.transform = pct === 100 ? "" : "scale(" + (pct / 100) + ")";
        body.style.width = pct === 100 ? "" : (10000 / pct) + "%";
      }
      if (zoomVal) zoomVal.textContent = pct + "%";
      if (announce) {
        t("介面縮放設為 " + pct + "%", "ok");
        if (window.KinAPI) window.KinAPI.setSettings({ ui_zoom: String(pct) }).catch(function () {
          t("介面縮放沒有存成，下次開啟會回到原本的大小", "err");
        });
      }
    };
    if (zoomVal) zoomVal.textContent = (parseInt(zoom.value, 10) || 100) + "%";
    zoom.addEventListener("input", function () { applyZoom(false); });
    zoom.addEventListener("change", function () { applyZoom(true); });
  }

  // (1) 編輯鎖「設定／重設 PIN」→ 開啟變更 PIN modal，走 KinAPI.setPin(old,new)
  //     （正式模式打 POST /api/lock/setpin，需輸入目前 PIN；KinAPI 缺 setPin 時才友善降級提示）
  var lockBtn = $("lockBtn");
  var pinMask = document.getElementById("pin-mask");
  var pinOld  = document.getElementById("pin-old");
  var pinNew  = document.getElementById("pin-new");
  var pinNew2 = document.getElementById("pin-new2");
  var pinSave = document.getElementById("pin-save");
  var pinCancel = document.getElementById("pin-cancel");

  var closePinModal = function () { if (pinMask) pinMask.hidden = true; };
  var openPinModal = function () {
    if (!pinMask) { t("PIN 設定畫面載入失敗", "err"); return; }
    var sub = document.getElementById("pin-sub");
    if (sub) {
      var isMock = !!(window.KinAPI && typeof window.KinAPI.isMock === "function" && window.KinAPI.isMock());
      sub.textContent = isMock
        ? "變更編輯鎖共用 PIN；展示模式任意 PIN 皆可解鎖，此流程僅供演示。"
        : "變更編輯鎖共用 PIN；首次預設 PIN 為 0000。";
    }
    if (pinOld)  pinOld.value = "";
    if (pinNew)  pinNew.value = "";
    if (pinNew2) pinNew2.value = "";
    pinMask.hidden = false;
    if (pinOld) setTimeout(function () { pinOld.focus(); }, 30);
  };

  if (lockBtn) lockBtn.addEventListener("click", openPinModal);
  if (pinCancel) pinCancel.addEventListener("click", closePinModal);
  if (pinMask) {
    // 點遮罩空白處關閉（與編輯鎖 modal 行為一致）
    pinMask.addEventListener("click", function (e) { if (e.target === pinMask) closePinModal(); });
  }
  if (pinSave) {
    pinSave.addEventListener("click", function () {
      var oldPin = pinOld ? pinOld.value : "";
      var newPin = pinNew ? pinNew.value : "";
      var again  = pinNew2 ? pinNew2.value : "";
      if (!newPin) { t("請輸入新 PIN", "err"); if (pinNew) pinNew.focus(); return; }
      if (newPin !== again) {
        t("兩次輸入的新 PIN 不一致", "err");
        if (pinNew2) { pinNew2.value = ""; pinNew2.focus(); }
        return;
      }
      if (!window.KinAPI || typeof window.KinAPI.setPin !== "function") {
        t("PIN 變更功能尚未就緒", "err");
        return;
      }
      pinSave.disabled = true;
      window.KinAPI.setPin(oldPin, newPin).then(function (res) {
        pinSave.disabled = false;
        if (res && res.ok) {
          closePinModal();
          t("PIN 已更新，下次解鎖請使用新 PIN", "ok");
        } else {
          t("PIN 變更失敗，請確認「目前 PIN」是否正確", "err");
          if (pinOld) { pinOld.value = ""; pinOld.focus(); }
        }
      }).catch(function (err) {
        pinSave.disabled = false;
        var msg = err && err.message ? String(err.message) : "";
        // 後端端點是 POST /api/lock/setpin（已實作，2026-09-04 實跑驗過）。這裡保留 404/501
        // 的降級訊息，是給「舊版 exe 配新前端」或離線示範模式的保險絲，不代表功能沒做。
        if (/API (404|501)/.test(msg)) t("此版本的程式不支援線上變更 PIN，請更新程式後再試", "err");
        else t(msg || "PIN 變更失敗，請稍後再試", "err");
      });
    });
  }
  // 依編輯狀態同步顯示 chip（瀏覽中／編輯中）；以 KinAPI.on('lock/changed') 為主，
  // 並保留 data-edit 監看作為後援。
  var lockChip = $("lockChip");
  var syncLock = function () {
    if (!lockChip) return;
    var editing = document.documentElement.getAttribute("data-edit") === "on";
    lockChip.textContent = editing ? "編輯中" : "瀏覽中";
    lockChip.className = "chip " + (editing ? "chip-ok" : "chip-muted");
  };
  syncLock();
  if (window.KinAPI) {
    window.KinAPI.on("lock/changed", function (st) {
      if (!lockChip) return;
      var editing = !!(st && st.editMode);
      lockChip.textContent = editing ? "編輯中" : "瀏覽中";
      lockChip.className = "chip " + (editing ? "chip-ok" : "chip-muted");
    });
  }
  try {
    var mo = new MutationObserver(syncLock);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-edit"] });
  } catch (e) {}

  // (4) 掃墓週期 .select → setSettings({sweepCycle})
  // 各選項對應習俗來源／籍貫說明（沿用 app.css 既有 .d 小字樣式，不自訂顏色字體）
  var SWEEP_HINTS = {
    qingming: "清明（活清明）：國曆約 4/4–4/5，跟節氣走故俗稱「活清明」。閩南泉州籍移民後裔以清明祭墓（古稱「嘗墓」），為全台最普遍的掃墓時節。",
    sanrijie: "三日節（古清明、死清明）：農曆三月初三，日期固定故稱「死清明」。漳州籍傳統時節；昔日漳泉移民曾因清明上市場購菜起械鬥，官府調解後分為『漳州人過三日節、泉州人過清明』。",
    hakka: "客家掛紙：客家人多不於清明掃墓，而於農曆年後擇日「掛紙」。北客（桃竹）多在天穿日（正月二十）後、苗栗多在元宵後、南客六堆多在二月初二福德伯公生後至清明前，常由祖嘗或鄉公所訂統一掛紙日。提早之說源於客家較節儉、可省牲禮與車馬費。",
    winter: "冬至（過冬紙）：部分閩南、潮汕家族視冬至為大節，於冬至前後上山掃墓，稱『過冬紙』。屬少數習俗，近年因冬季乾燥燒紙易引山火，已漸少堅持。",
    custom: "自訂日期：涵蓋統一掛紙日、為避開清明連假人潮而折衷之春分後週末等彈性安排，由家族自行擇定提醒日期。"
  };
  var sweep = $("sweepCycle");
  var sweepHint = $("sweepHint");
  var sweepSaved = sweep ? sweep.value : "";   // 後端目前的值（沒解鎖、存檔失敗時畫面還原成它）
  function renderSweepHint(v) {
    if (sweepHint) sweepHint.textContent = SWEEP_HINTS[v] || "";
  }
  function setSweep(v) {           // 以後端值重設選單與說明文字
    if (!sweep) return;
    sweep.value = v;
    sweepSaved = sweep.value;
    renderSweepHint(sweepSaved);
  }

  /* 房頭、配色、掃墓週期是族譜設定，後端非編輯模式一律 403（M-9／體檢 frontend-2）。
     舊版瀏覽模式也能點：畫面先改了、存檔失敗只跳一句錯誤，之後解鎖再動一下，當初「失敗」的
     新增／刪除就跟著整份工作陣列一起寫進去（長房被默默刪掉）。現在一律走 requireEdit
     （先還原畫面、解鎖成功才真的改），存檔失敗就用後端現值重設畫面上的工作副本。 */
  function saveFailMsg(what, err) {
    var msg = err && err.message ? String(err.message) : "";
    // 真機回「API 403：…」，展示模式回「需先解鎖編輯模式」
    return /API 403|需先解鎖/.test(msg)
      ? what + "沒有存成：程式已不在編輯模式，請到左下角重新解鎖編輯後再改一次。畫面已還原成目前的設定。"
      : what + "儲存失敗，請稍後再試。畫面已還原成目前的設定。";
  }
  function resyncSettings() {
    if (!window.KinAPI) return;
    window.KinAPI.getSettings().then(function (s) {
      s = s || {};
      fillBranchWork(s);
      renderBranches();
      if (s.sweepCycle) setSweep(s.sweepCycle);
    }).catch(function () {});
  }

  if (sweep) {
    renderSweepHint(sweep.value);
    sweep.addEventListener("change", function () {
      var want = sweep.value;
      var label = sweep.options[sweep.selectedIndex].text;
      setSweep(sweepSaved);          // 先還原；解鎖成功（或本來就在編輯模式）才換成新值
      window.requireEdit(function () {
        sweep.value = want;
        renderSweepHint(want);
        if (!window.KinAPI) { sweepSaved = want; t("掃墓週期已設為「" + label + "」", "ok"); return; }
        window.KinAPI.setSettings({ sweepCycle: want }).then(function () {
          sweepSaved = want;
          t("掃墓週期已設為「" + label + "」", "ok");
        }).catch(function (e) {
          t(saveFailMsg("掃墓週期", e), "err");
          setSweep(sweepSaved);
          resyncSettings();
        });
      });
    });
  }

  // (4.5) 房頭管理 → 新增／刪除房名，存回 setSettings({branches})
  // 單一資料來源仍是 settings.branches；本地維護一份工作陣列，存檔後由
  // KinBranches.refresh() 把最新房頭重灌進族譜頁／編輯鎖兩個下拉。
  var branchListEl  = $("branchList");
  var branchInput   = $("branchInput");
  var branchAddBtn  = $("branchAdd");
  var branchesWork  = [];   // 目前編輯中的房頭陣列

  function escHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // 預設六色（與 app.css b0~b5 一致；樹狀圖依 settings.branches 順序取色）
  var BRANCH_PALETTE = ['#0072B2', '#E69F00', '#009E73', '#CC79A7', '#D55E00', '#56B4E9'];
  var branchColorsWork = {};   // 房名 → 自訂色（settings.branch_colors）

  function renderBranches() {
    if (!branchListEl) return;
    if (!branchesWork.length) {
      branchListEl.innerHTML =
        '<div class="d" style="padding:4px 0">尚未設定任何房頭（不分房）。可於下方新增。</div>';
      return;
    }
    var html = "";
    for (var i = 0; i < branchesWork.length; i++) {
      var nm = branchesWork[i];
      var col = branchColorsWork[nm] || BRANCH_PALETTE[i % 6];
      html +=
        '<span class="chip chip-muted branch-tag" style="margin:0 6px 6px 0">' +
        '<input type="color" class="branch-color" data-b="' + escHtml(nm) + '" value="' + escHtml(col) + '"' +
        ' title="自訂「' + escHtml(nm) + '」的樹狀圖配色"' +
        ' style="width:20px;height:20px;padding:0;border:none;background:none;cursor:pointer;vertical-align:middle;margin-right:5px">' +
        escHtml(nm) +
        '<button type="button" class="branch-del" data-i="' + i +
        '" aria-label="刪除房頭 ' + escHtml(nm) + '" title="刪除">&times;</button>' +
        "</span>";
    }
    branchListEl.innerHTML = html;
  }

  // 以 settings 回填房頭與配色的工作副本（初始化、存檔失敗後重設共用）
  function fillBranchWork(s) {
    var arr = s.branches || [];
    branchesWork = (Object.prototype.toString.call(arr) === "[object Array]") ? arr.slice() : [];
    // 自訂配色回填（JSON 字串安全解析，壞值視同未設）
    branchColorsWork = {};
    try {
      var bc = s.branch_colors;
      if (typeof bc === "string" && bc) branchColorsWork = JSON.parse(bc) || {};
      else if (bc && typeof bc === "object") branchColorsWork = bc;
    } catch (e2) { branchColorsWork = {}; }
  }

  // 自訂色寫回 settings.branch_colors（JSON 字串）並即時刷新樹狀圖
  function saveBranchColors(msg) {
    if (!window.KinAPI) return;
    window.KinAPI.setSettings({ branch_colors: JSON.stringify(branchColorsWork) }).then(function () {
      if (window.KinBranchColors && window.KinBranchColors.refresh) window.KinBranchColors.refresh();
      if (msg) t(msg, "ok");
    }).catch(function (e) { t(saveFailMsg("配色", e), "err"); resyncSettings(); });
  }

  // 寫回後端並刷新全站下拉；web 模式 setSettings 不發 settings/changed，
  // 故這裡主動呼叫 KinBranches.refresh() 確保兩下拉同步。
  // patch 省略＝只存房頭；刪房頭時連同配色一次寫入（舊版分兩次存，一筆失敗就留下改壞的配色表）。
  function saveBranches(msg, patch) {
    renderBranches();
    if (!window.KinAPI) return;
    window.KinAPI.setSettings(patch || { branches: branchesWork.slice() }).then(function () {
      if (window.KinBranches && window.KinBranches.refresh) window.KinBranches.refresh();
      if (patch && window.KinBranchColors && window.KinBranchColors.refresh) window.KinBranchColors.refresh();
      if (msg) t(msg, "ok");
    }).catch(function (e) { t(saveFailMsg("房頭", e), "err"); resyncSettings(); });
  }

  function addBranch() {
    if (!branchInput) return;
    var name = (branchInput.value || "").trim();
    if (!name) { t("請輸入房頭名稱", "err"); return; }
    window.requireEdit(function () {
      // 同名去重（避免兩個一樣的房頭）
      for (var i = 0; i < branchesWork.length; i++) {
        if (branchesWork[i] === name) { t("「" + name + "」已存在", "err"); branchInput.focus(); return; }
      }
      branchesWork.push(name);
      branchInput.value = "";
      branchInput.focus();
      saveBranches("已新增房頭「" + name + "」");
    });
  }

  if (branchAddBtn) branchAddBtn.addEventListener("click", addBranch);
  if (branchInput) {
    branchInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); addBranch(); }
    });
  }
  if (branchListEl) {
    branchListEl.addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest(".branch-del") : null;
      if (!btn) return;
      var idx = parseInt(btn.getAttribute("data-i"), 10);
      if (isNaN(idx) || idx < 0 || idx >= branchesWork.length) return;
      var removed = branchesWork[idx];
      window.requireEdit(function () {
        var i = branchesWork.indexOf(removed);   // 解鎖期間清單可能已重設，以房名重找
        if (i < 0) return;
        branchesWork.splice(i, 1);
        delete branchColorsWork[removed];   // 一併清掉該房自訂色
        saveBranches("已刪除房頭「" + removed + "」",
                     { branches: branchesWork.slice(), branch_colors: JSON.stringify(branchColorsWork) });
      });
    });
    // 改色（change＝選定顏色關閉選色器時觸發，不會連發）：先把色塊還原，解鎖成功才真的改
    branchListEl.addEventListener("change", function (e) {
      var inp = e.target.closest ? e.target.closest(".branch-color") : null;
      if (!inp) return;
      var nm = inp.getAttribute("data-b");
      if (!nm) return;
      var val = inp.value;
      renderBranches();
      window.requireEdit(function () {
        branchColorsWork[nm] = val;
        renderBranches();
        saveBranchColors("已更新「" + nm + "」配色");
      });
    });
  }
  var branchColorReset = document.getElementById("settings-branchColorReset");
  if (branchColorReset) {
    branchColorReset.addEventListener("click", function () {
      window.requireEdit(function () {
        branchColorsWork = {};
        renderBranches();
        saveBranchColors("已還原預設配色");
      });
    });
  }

  // (4.6) 協會資料 → 8 欄位＋信封支系標註起算世代＋儲存鈕（編輯模式限定；用於通函/信封片頭/各式列印抬頭）
  // 前端輸入框 id 尾碼 ↔ settings 表鍵（snake_case，web 後端原樣落庫、mock 原樣存記憶體）
  // (4.65)【已移除 2026-09-04】選用功能開關區（settings.feature_*）。
  //   原為四個「規劃中」預留開關，讓各家族先表達需求、功能實作後自動生效。四項皆已結案：
  //   穴排位圖 → 做成常駐功能（左側「穴排位」頁）；掃墓提醒／忌日提醒／成員照片 → 總幹事決定不做。
  //   沒有開關留下，前端與 index.html 的整區一併撤除。舊資料庫可能殘留 feature_* 設定列，
  //   已無程式讀取，留著無害（settings 是鍵值表，不影響任何查詢）。

  var ORG_FIELDS = [
    ["orgName",         "org_name"],
    ["orgAddress",      "org_address"],
    ["orgContactAddr",  "org_contact_addr"],
    ["orgChair",        "org_chair"],
    ["orgChairPhone",   "org_chair_phone"],
    ["orgOfficer",      "org_officer"],
    ["orgOfficerPhone", "org_officer_phone"],
    ["orgRegNo",        "org_reg_no"],
    ["orgGenBase",      "gen_base"]      // 信封支系標註起算世代（print.html lineageTagGen；空＝不印）
  ];
  var orgSaveBtn = $("orgSave");

  function fillOrg(s) {
    for (var i = 0; i < ORG_FIELDS.length; i++) {
      var el = $(ORG_FIELDS[i][0]);
      if (el) el.value = (s && s[ORG_FIELDS[i][1]]) || "";
    }
  }

  if (orgSaveBtn) {
    orgSaveBtn.addEventListener("click", function () {
      if (!window.KinAPI) return;
      var patch = {};
      for (var i = 0; i < ORG_FIELDS.length; i++) {
        var el = $(ORG_FIELDS[i][0]);
        patch[ORG_FIELDS[i][1]] = el ? (el.value || "").trim() : "";
      }
      // 起算世代：全形數字轉半形；有填須為正整數（print.html 以 Number() 讀，非數字等同不印）
      patch.gen_base = patch.gen_base.replace(/[０-９]/g, function (c) {
        return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
      });
      if (patch.gen_base && !/^[1-9]\d{0,2}$/.test(patch.gen_base)) {
        t("信封支系標註起算世代請填正整數（例：11），不用就留空", "err");
        return;
      }
      orgSaveBtn.disabled = true;
      window.KinAPI.setSettings(patch).then(function () {
        orgSaveBtn.disabled = false;
        t("協會資料已儲存，將套用於通函與信封片頭列印", "ok");
      }).catch(function (e) {
        orgSaveBtn.disabled = false;
        t((e && e.message) || "協會資料儲存失敗，請稍後再試", "err");
      });
    });
  }

  // (5) 維運：備份／還原／匯入／匯出 → 對應 KinAPI 方法
  // 隱藏檔案輸入：還原與匯入需挑檔
  function pickFile(accept, onPick) {
    var inp = document.createElement("input");
    inp.type = "file";
    if (accept) inp.accept = accept;
    inp.style.display = "none";
    document.body.appendChild(inp);
    inp.addEventListener("change", function () {
      var f = inp.files && inp.files[0];
      document.body.removeChild(inp);
      if (f) onPick(f);
    });
    inp.click();
  }
  // 觸發瀏覽器下載（匯出回 Blob 時）
  function triggerDownload(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = filename || "export";
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function fileBase(p) {
    if (!p) return "";
    var s = String(p).split(/[\\/]/);
    return s[s.length - 1];
  }

  var backupBtn = $("backupBtn");
  if (backupBtn && window.KinAPI) {
    backupBtn.addEventListener("click", function () {
      backupBtn.disabled = true;
      window.KinAPI.backup().then(function (res) {
        backupBtn.disabled = false;
        var name = fileBase(res && res.file) || "kinlink 備份檔";
        t("已建立本機備份：" + name, "ok");
      }).catch(function () { backupBtn.disabled = false; t("備份失敗，請稍後再試", "err"); });
    });
  }

  // 還原＝用備份檔整份覆蓋現有族譜，是全 app 最具破壞性的操作。
  // 護欄比照匯入：①需先解鎖編輯模式（requireEdit）②選檔後仍須明確確認（列出檔名與後果）。
  // 後端另有 SQLite 檔頭驗證與「覆蓋前先自動備份現況」，誤還原仍可救回。
  var restoreBtn = $("restoreBtn");
  if (restoreBtn && window.KinAPI) {
    restoreBtn.addEventListener("click", function () {
      window.requireEdit(function () {
        pickFile(".db,.kinlink,.kbk", function (f) {
          var ok = window.confirm(
            "確定要還原備份嗎？\n\n" +
            "備份檔：" + f.name + "\n\n" +
            "目前資料庫的全部內容（成員、祭祖活動、設定）將被這個檔案整份覆蓋。\n" +
            "系統會在覆蓋前自動備份現況一份，但仍請確認選對了檔案。"
          );
          if (!ok) { t("已取消還原", "ok"); return; }
          window.KinAPI.restore(f).then(function () {
            t("已從「" + f.name + "」還原備份，重新載入中…", "ok");
            setTimeout(function(){ location.reload(); }, 900);   // 還原後重載，讓各視圖吃新資料
          }).catch(function (e) { t((e && e.message) || "還原失敗，請確認備份檔", "err"); });
        });
      });
    });
  }

  // (5.1) R1 通用 CSV 匯入：選檔 → preview 試算（不寫庫）→ modal 摘要
  //       → 「確認匯入」commit 實際寫入 → toast＋重載。
  //       契約見 bridge.js importData(file, mode)；需先解鎖編輯模式
  //       （後端另擋：鎖定單一房頭時不可匯入，403 白話訊息原樣顯示）。
  var importBtn = $("importBtn");
  var importTplBtn = $("importTpl");
  var impMask = document.getElementById("import-mask");
  var impSummary = document.getElementById("import-summary");
  var impCommit = document.getElementById("import-commit");
  var impCancel = document.getElementById("import-cancel");
  var impFile = null;   // 待確認匯入的檔案（preview 與 commit 用同一顆）

  function closeImport() {
    if (impMask) impMask.hidden = true;
    impFile = null;
  }

  // 把 preview 報告組成摘要 HTML（只用既有 chip／d／lbl 樣式；內容一律跳脫）
  function renderImportSummary(res) {
    res = res || {};
    function num(k) { var v = res[k]; return typeof v === "number" ? v : 0; }
    function list(title, arr) {
      if (!arr || !arr.length) return "";
      var html = '<div class="lbl" style="margin-top:10px">' + escHtml(title) +
        '</div><ul style="margin:4px 0 0;padding-left:18px">';
      for (var i = 0; i < arr.length && i < 20; i++) html += '<li class="d">' + escHtml(arr[i]) + "</li>";
      if (arr.length > 20) html += '<li class="d">…其餘 ' + (arr.length - 20) + " 筆略</li>";
      return html + "</ul>";
    }
    var chips =
      '<span class="chip chip-ok">新增 ' + num("新增") + " 人</span> " +
      '<span class="chip chip-ok">更新 ' + num("更新") + " 人</span> " +
      '<span class="chip chip-accent">可接父 ' + num("可接父") + "</span> " +
      (num("可接母") ? '<span class="chip chip-accent">可接母 ' + num("可接母") + "</span> " : "") +
      (num("可接配偶") ? '<span class="chip chip-accent">可接配偶 ' + num("可接配偶") + "</span> " : "") +
      '<span class="chip chip-muted">待補親屬 ' + num("找不到父") + "</span> " +
      '<span class="chip chip-muted">跳過 ' + num("跳過") + "</span> " +
      '<span class="chip chip-muted">錯誤 ' + num("錯誤") + "</span>";
    return '<div class="d" style="margin-bottom:6px">共 ' + num("rows") + " 列資料：" +
        num("新增") + " 筆新增、" + num("更新") + " 筆更新。</div>" +
      "<div>" + chips + "</div>" +
      (num("更新")
        ? '<div class="d" style="margin-top:8px">更新列（帶 member_id 者）只更新<b>有填值</b>的欄位；' +
          "空儲存格＝維持原值，不會清空。要清掉某欄請到成員表單操作。</div>"
        : "") +
      (res["新增房頭"] && res["新增房頭"].length
        ? '<div class="d" style="margin-top:8px">將新增房頭：' + escHtml(res["新增房頭"].join("、")) + "</div>"
        : "") +
      // Excel 變形提醒放最前面：「更新列提醒」在匯出檔匯回時每列都有，會把它淹掉
      list("疑似被 Excel 改壞的欄位（未覆寫，資料庫維持原值）", res["Excel變形提醒"]) +
      // 原本在世、匯入後變已過世：這些人會從「全族在世」通知名單消失，要讓總幹事預覽時看得到
      list("原本在世、匯入後會改成已過世（不再收到在世通知）", res["改為已歿提醒"]) +
      list("錯誤清單（不匯入）", res["錯誤清單"]) +
      // 同名同世已存在、但父母對不上：照樣新增，可能是同一人被複製一份，請使用者自己判斷
      list("同名同世已存在、但父母對不上（仍會新增；若是同一人請刪掉該列）", res["同名提醒"]) +
      list("跳過清單（已存在，略過）", res["跳過清單"]) +
      list("待補親屬（人照樣匯入，僅親屬連結先不建）", res["找不到父清單"]) +
      list("更新列提醒（父名／母名／配偶名欄在更新列不套用）", res["更新列提醒"]);
  }

  if (importBtn && window.KinAPI) {
    importBtn.addEventListener("click", function () {
      if (document.documentElement.getAttribute("data-edit") !== "on") {
        t("請先點左下角「瀏覽模式」解鎖編輯模式，再匯入 CSV", "err");
        return;
      }
      pickFile(".csv,text/csv", function (f) {
        importBtn.disabled = true;
        window.KinAPI.importData(f, "preview").then(function (res) {
          importBtn.disabled = false;
          impFile = f;
          if (impSummary) impSummary.innerHTML = renderImportSummary(res);
          if (impCommit) impCommit.disabled = !(res && (res["新增"] > 0 || res["更新"] > 0));
          if (impMask) impMask.hidden = false;
        }).catch(function (err) {
          importBtn.disabled = false;
          t((err && err.message) || "匯入預覽失敗，請確認為 UTF-8 編碼的 CSV 檔", "err");
        });
      });
    });
  }
  if (impCancel) impCancel.addEventListener("click", closeImport);
  if (impMask) {
    // 點遮罩空白處關閉（與其他 modal 行為一致）
    impMask.addEventListener("click", function (e) { if (e.target === impMask) closeImport(); });
  }
  if (impCommit && window.KinAPI) {
    impCommit.addEventListener("click", function () {
      if (!impFile) { closeImport(); return; }
      impCommit.disabled = true;
      window.KinAPI.importData(impFile, "commit").then(function (res) {
        impCommit.disabled = false;
        closeImport();
        var n = res && typeof res["新增"] === "number" ? res["新增"] : 0;
        var nu = res && typeof res["更新"] === "number" ? res["更新"] : 0;
        t("已新增 " + n + " 名、更新 " + nu + " 名成員，重新載入中…", "ok");
        setTimeout(function () { location.reload(); }, 900);
      }).catch(function (err) {
        impCommit.disabled = false;
        t((err && err.message) || "匯入失敗，請稍後再試", "err");
      });
    });
  }
  // 下載匯入範本：前端組 UTF-8-BOM CSV（表頭＋兩列虛構示範），Excel 直開不亂碼
  if (importTplBtn) {
    importTplBtn.addEventListener("click", function () {
      // 表頭與後端 _IMPORT_COLS 對齊（server.py）；member_id 留空＝新增、
      // 由「匯出 CSV」帶出的編號＝更新該人。三列虛構示範涵蓋父/母/配偶/安葬欄。
      var tpl = "member_id,姓名,字號,性別(男/女),世代,房頭,父名,關係型別(親生/過繼/收養),母名,配偶名," +
        "生年,生(原文),卒年,卒(原文),電話,住址,郵遞區號,備註,安葬地點,穴位編號,安葬型態(土葬/塔位/樹葬)\r\n" +
        ",陳大山,立德,男,1,,,,,,1900,光緒26年,1970,庚戌年八月初三,,示範縣示範鄉示範路一號,,始遷祖（虛構示範）,示範公墓,甲區1號,土葬\r\n" +
        ",陳林春,,女,1,,,,,陳大山,1905,,1980,,,示範縣示範鄉示範路一號,,（虛構示範）,,,\r\n" +
        ",陳志明,守義,男,2,大房,陳大山,親生,陳林春,,1930,,,,0912-000-000,示範市示範區示範街二號,100,（虛構示範）,,,\r\n";
      triggerDownload(new Blob(["\uFEFF" + tpl], { type: "text/csv;charset=utf-8" }), "繫族匯入範本.csv");
      t("已下載匯入範本：member_id 留空＝新增；由「匯出」帶編號的檔＝更新該人（欄位順序不拘、可留空）", "ok");
    });
  }

  var exportBtn = $("exportBtn");
  if (exportBtn && window.KinAPI) {
    exportBtn.addEventListener("click", function () {
      exportBtn.disabled = true;
      window.KinAPI.exportData("csv").then(function (res) {
        exportBtn.disabled = false;
        // web 模式回 Blob → 觸發下載（CSV 含 BOM，Excel 直開）；mock 模式回 {file} → toast
        if (res instanceof Blob) {
          triggerDownload(res, "族譜成員清冊.csv");
          t("已匯出族譜成員清冊（CSV，Excel 可直接開啟）", "ok");
        } else {
          var name = fileBase(res && res.file) || "族譜成員清冊.csv";
          t("已匯出：" + name, "ok");
        }
      }).catch(function () { exportBtn.disabled = false; t("匯出失敗，請稍後再試", "err"); });
    });
  }

  // (5.5) 清空示範資料（首次使用；規格 §5「示範資料」）：
  // 僅示範資料庫（settings.demo_data === '1'，由 db.seed_demo 標記）解除列的
  // hidden；列另掛 .edit-only，須進入編輯模式才看得到按鈕。真實資料庫
  // （demo_data 非 1）此列永遠隱藏，後端 /api/demo/clear 亦會再擋一道 403。
  var demoRow = $("demoRow");
  var demoClearBtn = $("demoClear");
  if (demoClearBtn && window.KinAPI) {
    demoClearBtn.addEventListener("click", function () {
      if (!window.confirm("確定清空示範資料？\n\n" +
          "只會刪除系統內建的虛構示範成員（楊家）與它們的親屬關係、婚姻、墓葬，以及示範活動、示範穴排位。\n" +
          "您自己新增的成員、活動、穴排位（含改過名字的示範成員）都會保留。\n" +
          "清空前系統會自動備份一份，萬一有誤可從「還原」救回。")) return;
      demoClearBtn.disabled = true;
      window.KinAPI.clearDemo().then(function (res) {
        demoClearBtn.disabled = false;
        if (res && res.ok) {
          // 後端回 deleted／kept 筆數（H-1）；沒有可辨識的示範資料時照後端訊息講清楚「沒刪任何東西」
          var msg = (res.deleted > 0)
            ? "已刪除示範資料 " + res.deleted + " 筆；您自己建立的資料 " + (res.kept || 0) + " 筆均保留"
            : String(res.message || "找不到可辨識的示範資料，沒有刪除任何資料").replace(/。$/, "");
          t(msg + "，重新載入中…", "ok");
          setTimeout(function () { location.reload(); }, 1500);
        } else {
          t("清空失敗，請稍後再試", "err");
        }
      }).catch(function (e) {
        demoClearBtn.disabled = false;
        t((e && e.message) || "清空失敗，請稍後再試", "err");
      });
    });
  }

  // ── 初始化：getSettings 回填主題 seg 與掃墓週期 ──
  if (window.KinAPI) {
    window.KinAPI.ready.then(function () {
      return window.KinAPI.getSettings();
    }).then(function (s) {
      s = s || {};
      // 主題以後端設定為準：畫面與按鈕一起套（舊版只切按鈕，畫面停在 localStorage 的值）
      if (s.theme === "light" || s.theme === "dark" || s.theme === "system") {
        if (typeof setTheme === "function") setTheme(s.theme);
        if (seg) seg.querySelectorAll("button").forEach(function (b) {
          b.classList.toggle("on", b.getAttribute("data-theme") === s.theme);
        });
      }
      // 介面縮放：依後端 ui_zoom 還原滑桿與畫面（範圍外的壞值視同未設）
      var zp = parseInt(s.ui_zoom, 10);
      if (zoom && applyZoom && zp >= 85 && zp <= 130) { zoom.value = String(zp); applyZoom(false); }
      if (sweep && s.sweepCycle) setSweep(s.sweepCycle);
      // 房頭管理：以 settings.branches／branch_colors 回填工作副本並渲染標籤
      fillBranchWork(s);
      renderBranches();
      // 協會資料：回填 8 欄位（未設定則留空）
      fillOrg(s);
      // 清空示範資料列：僅示範資料庫（demo_data='1'）顯示（另受 .edit-only 管制）
      if (demoRow && String(s.demo_data || "") === "1") demoRow.hidden = false;
    }).catch(function () { /* 沿用 HTML 預設 */ renderBranches(); });
  }
})();

/* ── 設定 → 資料：顯示資料庫完整位置（體檢 release-4）──
   使用者要知道資料存在哪（隨身碟？桌面？），也才看得出「怎麼跑到暫存區去了」。
   唯讀文字；值來自 GET /api/state 的 dbPath（展示模式由 bridge.js mock 給示意路徑）。 */
(function () {
  var el = document.getElementById('settings-dbPath');
  if (!el || !window.KinAPI || !window.KinAPI.getState) return;
  window.KinAPI.getState().then(function (s) {
    el.textContent = (s && s.dbPath) ? String(s.dbPath) : '（無法取得）';
  }).catch(function () { el.textContent = '（無法取得）'; });
})();

/* ============================================================
   視圖 6：關於 about —— 版本／緣起致謝／操作手冊／檢查更新
   檢查更新：僅按下時由後端代打 GitHub Releases（系統本體離線）。
   半自動改版：下載為 繫族_new.exe ＋ 產生 套用更新.bat，關程式後雙擊換檔。
   ============================================================ */
(function () {
  var root = document.querySelector('[data-view="about"]');
  if (!root || !window.KinAPI) return;

  var verEl   = document.getElementById('about-version');
  var manual  = document.getElementById('about-manual');
  var repoIn  = document.getElementById('about-repo');
  var repoSave= document.getElementById('about-repo-save');
  var msgEl   = document.getElementById('about-update-msg');
  var checkBtn= document.getElementById('about-check');
  var dlBtn   = document.getElementById('about-download');
  var hintBox = document.getElementById('about-update-hint');
  var hintTxt = document.getElementById('about-update-hint-txt');
  var TOKEN   = ((location.search || '').match(/[?&]k=([^&]+)/) || [])[1] || '';
  var lastCheck = null;
  var savedRepo = '';   // 已存的發佈來源（後端 check_update 用的就是這個，不是輸入框裡尚未儲存的字）

  function t(m, k){ if (typeof toast === 'function') toast(m, k); }
  function isWeb(){ return location.protocol === 'http:' || location.protocol === 'https:'; }

  // 有新版、但 release 沒附 .exe（例如維護者只上傳了 zip）：程式內無法下載，
  // 不能只把下載鈕藏起來——要講清楚去哪裡手動更新（體檢 release-5）。
  function showManualUpdate() {
    if (!msgEl) return;
    var repo = (savedRepo || (repoIn && repoIn.value) || '').trim();
    msgEl.appendChild(document.createTextNode('。新版已發佈，但沒有附程式更新檔（.exe），無法在程式內直接更新。請到 '));
    if (/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      var url = 'https://github.com/' + repo + '/releases/latest';
      var a = document.createElement('a');
      a.href = url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = url;
      msgEl.appendChild(a);
    } else {
      msgEl.appendChild(document.createTextNode('GitHub 專案的 Releases 頁面'));
    }
    msgEl.appendChild(document.createTextNode(' 下載 zip 手動更新：關閉本程式，解壓後用新的 繫族.exe 換掉舊的（繫族.db 與 backups 資料夾留在原處，資料不受影響）。'));
  }

  // 版本與發佈來源回填
  window.KinAPI.getState().then(function (s) {
    if (verEl && s && s.version) verEl.textContent = 'v' + s.version;
    if (msgEl && s && s.version) msgEl.textContent = '目前版本 v' + s.version + '；按「檢查更新」連 GitHub 比對最新發佈。';
  }).catch(function(){});
  window.KinAPI.getSettings().then(function (s) {
    if (s && s.github_repo) savedRepo = String(s.github_repo);
    if (repoIn && s && s.github_repo) repoIn.value = s.github_repo;
  }).catch(function(){});

  if (manual) manual.addEventListener('click', function () {
    if (!isWeb()) { t('展示模式請直接開啟 列印範本/操作手冊.html', 'err'); return; }
    window.open('/' + encodeURIComponent('列印範本') + '/' + encodeURIComponent('操作手冊.html') + (TOKEN ? '?k=' + TOKEN : ''), '_blank');
  });

  if (repoSave) repoSave.addEventListener('click', function () {
    var v = (repoIn && repoIn.value || '').trim();
    if (v && !/^[\w.-]+\/[\w.-]+$/.test(v)) { t('格式須為 owner/repo', 'err'); return; }
    window.KinAPI.setSettings({ github_repo: v }).then(function () {
      savedRepo = v;
      t(v ? '發佈來源已儲存' : '已清除發佈來源', 'ok');
    }).catch(function (e) { t((e && e.message) || '儲存失敗（需編輯模式）', 'err'); });
  });

  if (checkBtn) checkBtn.addEventListener('click', function () {
    checkBtn.disabled = true;
    if (msgEl) msgEl.textContent = '檢查中…（連線 GitHub）';
    window.KinAPI.checkUpdate().then(function (r) {
      checkBtn.disabled = false; lastCheck = r || {};
      if (!r || r.configured === false) {
        if (msgEl) msgEl.textContent = '尚未設定發佈來源（owner/repo），請先於上方填寫並儲存。';
        if (dlBtn) dlBtn.hidden = true; return;
      }
      if (r.error) { if (msgEl) msgEl.textContent = r.error; if (dlBtn) dlBtn.hidden = true; return; }
      if (r.hasUpdate) {
        if (msgEl) msgEl.textContent = '有新版本：v' + r.latest + '（目前 v' + r.current + '）';
        if (dlBtn) dlBtn.hidden = !r.assetUrl;
        if (!r.assetUrl) showManualUpdate();
        if (hintBox && r.notes) { hintBox.hidden = false; hintTxt.textContent = '更新說明：' + String(r.notes).slice(0, 300); }
      } else {
        if (msgEl) msgEl.textContent = '已是最新版本（v' + r.current + '）。';
        if (dlBtn) dlBtn.hidden = true; if (hintBox) hintBox.hidden = true;
      }
    }).catch(function (e) {
      checkBtn.disabled = false;
      if (msgEl) msgEl.textContent = (e && e.message) || '檢查失敗（請確認網路）';
    });
  });

  if (dlBtn) dlBtn.addEventListener('click', function () {
    if (!lastCheck || !lastCheck.assetUrl) return;
    dlBtn.disabled = true;
    t('下載中，請稍候…', 'ok');
    window.KinAPI.downloadUpdate().then(function (r) {
      dlBtn.disabled = false;
      if (r && r.ok) {
        if (hintBox) {
          hintBox.hidden = false;
          hintTxt.textContent = '已下載新版：' + (r.file || '繫族_new.exe') + '。請關閉本程式後，雙擊同資料夾的「套用更新.bat」完成改版。';
        }
        t('下載完成，關閉程式後雙擊 套用更新.bat', 'ok');
      } else {
        t((r && r.message) || '下載失敗', 'err');
      }
    }).catch(function (e) { dlBtn.disabled = false; t((e && e.message) || '下載失敗', 'err'); });
  });
})();

/* ============================================================
   視圖 3.5：穴排位 tomb —— 場地格線（規格 §2.5；2026-08-21 總幹事拍板實作）
   一個場地＝一張要印的格子表。版面（列／欄／列標籤）是場地自己的設定，
   格子指到族親（印出自動套「字號　姓公／名　姓氏」）或填自由文字；
   程式不做昭穆規則、不解析位置碼——格子怎麼畫就怎麼印。
   資料走 KinAPI.listTombSites / getTombSite / saveTombSite / deleteTombSite /
   exportTombSiteCsv / importTombSiteCsv；列印走 print.html?doc=tombgrid&site=ID|all。
   ============================================================ */
(function(){
  var root = document.querySelector('section[data-view="tomb"]');
  if(!root || !window.KinAPI) return;
  var $ = function(id){ return document.getElementById(id); };
  var sel = $('tomb-site-sel'), editor = $('tomb-editor'), gridWrap = $('tomb-grid-wrap');
  var fName = $('tomb-f-name'), fTitle = $('tomb-f-title'), fSub = $('tomb-f-subtitle'), fFoot = $('tomb-f-footer');
  var fRows = $('tomb-f-rows'), fCols = $('tomb-f-cols'), fLabels = $('tomb-f-labels');
  // 版型（2026-10-12，照家族穴排位圖）：grid 方格／panels 面板並排／steps 階梯主牌位
  var fLayout = $('tomb-f-layout'), fShape = $('tomb-f-shape'), fShapeLbl = $('tomb-f-shape-lbl');
  var fShapeWrap = $('tomb-f-shape-wrap'), fPcols = $('tomb-f-pcols'), fPcolsWrap = $('tomb-f-pcols-wrap');
  var fLabelsWrap = fLabels && fLabels.closest ? fLabels.closest('.field') : null, cellTop = $('tomb-cell-top');
  var btnAdd = $('tomb-add'), btnSave = $('tomb-save'), btnDel = $('tomb-delete'), btnApply = $('tomb-apply');
  var btnExport = $('tomb-export'), fileImport = $('tomb-import-file'), btnPrint = $('tomb-print'), btnPrintAll = $('tomb-print-all');
  var cellMask = $('tomb-cell-mask'), cellTitle = $('tomb-cell-title'), cellText = $('tomb-cell-text');
  var cellOk = $('tomb-cell-ok'), cellCancel = $('tomb-cell-cancel'), cellClear = $('tomb-cell-clear'), cellPickMount = $('tomb-cell-pick');
  if(!sel || !editor || !gridWrap || !cellMask) return;

  var cur = null;      // {id, name, title, subtitle, footer, rows, cols, rowLabels[], cells:{'r,c':{memberId,name,text,label}}}
  var curKey = null;   // 正在編輯的格子鍵 'r,c'
  var loaded = false;
  var pick = window.createMemberPicker ? window.createMemberPicker({ placeholder: '搜尋姓名、字號或房頭…' }) : null;
  if(pick && cellPickMount) cellPickMount.appendChild(pick.el);

  function toast(m, t){ if(window.toast) window.toast(m, t); }
  function requireEdit(fn){ if(window.requireEdit) window.requireEdit(fn); else fn(); }

  function blank(){ return { id: null, name: '', title: '', subtitle: '', footer: '', rows: 5, cols: 6, rowLabels: [], cells: {},
                            layout: 'grid', layoutOpts: {} }; }
  function fromApi(s){
    var o = { id: s.id, name: s.name || '', title: s.title || '', subtitle: s.subtitle || '', footer: s.footer || '',
              rows: Number(s.rows) || 1, cols: Number(s.cols) || 1, rowLabels: (s.rowLabels || []).slice(), cells: {},
              layout: s.layout || 'grid', layoutOpts: s.layoutOpts || {} };
    (s.cells || []).forEach(function(c){
      o.cells[c.r + ',' + c.c] = { memberId: c.memberId || null, name: c.name || '', text: c.text || '', top: c.top || '',
                                   label: c.label || '' };
    });
    return o;
  }
  function nums(str){
    return String(str || '').split(/[,，、\s]+/).map(function(x){ return parseInt(x, 10); })
      .filter(function(n){ return n > 0; }).map(function(n){ return Math.min(60, n); });
  }
  // 版型的格子範圍（同後端 tombsites._inside）：面板各塊列數不同、階梯各層寬度不同
  function inside(r, c){
    var o = cur.layoutOpts || {};
    if(cur.layout === 'panels'){ var p = Math.floor(c / o.panelCols); return p < o.panelRows.length && r < o.panelRows[p]; }
    if(cur.layout === 'steps') return r < o.rowWidths.length && c < o.rowWidths[r];
    return r < cur.rows && c < cur.cols;
  }
  function syncLayoutUi(){
    var lay = fLayout ? fLayout.value : 'grid', grid = lay === 'grid';
    if(fShapeWrap) fShapeWrap.hidden = grid;
    if(fPcolsWrap) fPcolsWrap.hidden = lay !== 'panels';
    if(fLabelsWrap) fLabelsWrap.hidden = !grid;
    fRows.disabled = fCols.disabled = !grid;          // 面板／階梯的列數欄數由版型設定推出
    if(fShapeLbl) fShapeLbl.textContent = lay === 'panels'
      ? '各塊列數（由左到右，逗號分隔；例：14,11,11,14）'
      : '各層格數（由上而下，逗號分隔；例：12,12,16,21,25）';
  }
  function fillForm(){
    fName.value = cur.name; fTitle.value = cur.title; fSub.value = cur.subtitle; fFoot.value = cur.footer;
    fRows.value = cur.rows; fCols.value = cur.cols; fLabels.value = cur.rowLabels.join(',');
    if(fLayout){
      var o = cur.layoutOpts || {};
      fLayout.value = cur.layout || 'grid';
      fShape.value = cur.layout === 'panels' ? (o.panelRows || []).join(',') : (cur.layout === 'steps' ? (o.rowWidths || []).join(',') : '');
      fPcols.value = o.panelCols || 3;
      syncLayoutUi();
    }
  }
  // opt.typing＝打字途中的即時預覽：欄位被清空時「維持原尺寸」，不要把格子縮成 1×1
  // （使用者要把 5 改成 15，中間必然有一瞬間是空字串或 "1"）。
  function readForm(opt){
    var typing = !!(opt && opt.typing);
    cur.name = fName.value.trim(); cur.title = fTitle.value.trim(); cur.subtitle = fSub.value.trim(); cur.footer = fFoot.value.trim();
    if(!(typing && !String(fRows.value).trim())) cur.rows = Math.max(1, Math.min(60, parseInt(fRows.value, 10) || 1));
    if(!(typing && !String(fCols.value).trim())) cur.cols = Math.max(1, Math.min(60, parseInt(fCols.value, 10) || 1));
    // 列標籤不隨列數截斷：縮列再改回來時標籤要還在（真正落庫時後端才依 rows 取用）
    cur.rowLabels = fLabels.value.split(/[,，]/).map(function(s){ return s.trim(); });
    while(cur.rowLabels.length && !cur.rowLabels[cur.rowLabels.length - 1]) cur.rowLabels.pop();
    cur.layout = (fLayout && fLayout.value) || 'grid';
    if(cur.layout === 'panels'){
      var pr = nums(fShape.value);
      if(!pr.length) pr = [cur.rows];
      cur.layoutOpts = { panelCols: Math.max(1, Math.min(20, parseInt(fPcols.value, 10) || 3)), panelRows: pr.slice(0, 10) };
      cur.rows = Math.max.apply(null, cur.layoutOpts.panelRows);
      cur.cols = cur.layoutOpts.panelCols * cur.layoutOpts.panelRows.length;
    } else if(cur.layout === 'steps'){
      var w = nums(fShape.value);
      if(!w.length) w = [cur.cols];
      cur.layoutOpts = { rowWidths: w.slice(0, 60) };
      cur.rows = w.length; cur.cols = Math.max.apply(null, w);
    } else {
      cur.layoutOpts = {};
    }
  }
  function labelAt(r){ return cur.rowLabels[r] || ('第' + (r + 1) + '列'); }
  // 與後端 honor_label 同規則（只用於儲存前的即時預覽；儲存後以後端回傳為準）
  function autoLabel(m){
    var name = String(m.name || '').replace(/[（(].*?[)）]/g, '').replace(/\s/g, '');
    if(name.length < 2) return name;
    var sur = name.charAt(0), given = name.slice(1);
    if(m.gender === 'F') return given + '　' + sur + '氏';
    return (m.styleName || given) + '　' + sur + '公';
  }

  // 跟列印同一套畫法（js/tombdraw.js）：畫面上看到的就是印出來的樣子，格子帶 data-r／data-c 可點編輯
  //（2026-10-12 總幹事：列印看很直覺，app 要照列印重新設計；舊版每層都拉成一樣寬，看不出階梯）
  function renderGrid(){
    if(!cur){ gridWrap.innerHTML = ''; return; }
    var d = window.TombDraw.render(cur, { edit: true });
    gridWrap.innerHTML = '<div class="tomb-paper ' + d.cls + '">' + d.html + '</div>';
    fitPaper();
  }
  // 紙張比畫面寬時整張等比縮小（不出現左右捲軸）；視窗放大再放回原尺寸
  function fitPaper(){
    var p = gridWrap.firstChild;
    if(!p || !p.style) return;
    p.style.zoom = '';
    var room = gridWrap.clientWidth - 4, need = p.offsetWidth;
    if(room > 0 && need > room) p.style.zoom = String(Math.floor(room / need * 1000) / 1000);
  }
  window.addEventListener('resize', function(){ if(cur && !editor.hidden) fitPaper(); });

  // ── 格子小視窗 ──
  gridWrap.addEventListener('click', function(e){
    var td = e.target && e.target.closest ? e.target.closest('td[data-r]') : null;
    if(!td || !cur) return;
    var key = td.getAttribute('data-r') + ',' + td.getAttribute('data-c');
    requireEdit(function(){ openCell(key); });
  });
  function openCell(key){
    curKey = key;
    var cell = cur.cells[key] || {}, rc = key.split(','), r0 = Number(rc[0]), c0 = Number(rc[1]), where;
    if(cur.layout === 'panels'){
      var pc = cur.layoutOpts.panelCols;
      where = '第 ' + (Math.floor(c0 / pc) + 1) + ' 塊・第 ' + (r0 + 1) + ' 列・第 ' + (c0 % pc + 1) + ' 格';
    } else if(cur.layout === 'steps') where = '第 ' + (r0 + 1) + ' 層・右起第 ' + (c0 + 1) + ' 格';
    else where = labelAt(r0) + '・第 ' + (c0 + 1) + ' 格';
    if(cellTitle) cellTitle.textContent = '格子：' + where;
    if(cellTop) cellTop.value = cell.top || '';
    if(pick){ if(cell.memberId) pick.setMember({ id: cell.memberId, name: cell.name, label: cell.label }); else pick.clear(); }
    cellText.value = cell.text || '';
    cellMask.hidden = false;
    setTimeout(function(){ cellText.focus(); }, 30);
  }
  function closeCell(){ cellMask.hidden = true; curKey = null; }
  cellOk.addEventListener('click', function(){
    if(!curKey) return;
    var m = pick ? pick.getMember() : null, text = cellText.value.trim(), top = cellTop ? cellTop.value.trim() : '';
    if(!m && !text && !top) delete cur.cells[curKey];
    else cur.cells[curKey] = { memberId: m ? m.id : null, name: m ? m.name : '', text: text, top: top,
                               label: text || (m ? autoLabel(m) : '') };
    closeCell(); renderGrid();
  });
  cellClear.addEventListener('click', function(){ if(curKey) delete cur.cells[curKey]; closeCell(); renderGrid(); });
  cellCancel.addEventListener('click', closeCell);
  cellMask.addEventListener('click', function(e){ if(e.target === cellMask) closeCell(); });
  cellText.addEventListener('keydown', function(e){ if(e.key === 'Enter'){ e.preventDefault(); cellOk.click(); } });

  // ── 場地清單／讀取 ──
  function loadSites(selectId){
    return window.KinAPI.listTombSites().then(function(list){
      list = list || [];
      sel.innerHTML = '';
      if(!list.length){
        var o0 = document.createElement('option'); o0.value = ''; o0.textContent = '（尚無場地，請按「新增場地」）'; sel.appendChild(o0);
      }
      list.forEach(function(s){
        var o = document.createElement('option');
        var shape = s.layout === 'panels' ? '面板' : (s.layout === 'steps' ? '階梯' : (s.rows + '×' + s.cols));
        o.value = String(s.id); o.textContent = s.name + '（' + shape + '，' + s.filled + ' 格）';
        sel.appendChild(o);
      });
      var want = selectId != null ? String(selectId) : (list.length ? String(list[0].id) : '');
      sel.value = want;
      if(sel.value) return openSite(sel.value);
      cur = null; editor.hidden = true; return null;
    }).catch(function(e){ toast('讀取穴排位場地失敗：' + e.message, 'err'); });
  }
  function openSite(id){
    return window.KinAPI.getTombSite(id).then(function(s){
      cur = fromApi(s); fillForm(); editor.hidden = false; renderGrid(); takeSnap();   // 先顯示再畫：縮放要量得到寬度
    }).catch(function(e){ toast('讀取場地失敗：' + e.message, 'err'); });
  }

  /* ── 防「沒存的格子被丟掉」（M-9／體檢 frontend-7）：格子與版面要按「儲存」才寫進資料庫，
     舊版切換場地、按「新增場地」直接覆寫 cur，填了十幾格的內容無聲消失。比照成員表單的快照比對：
     開啟（含存檔後重讀）當下記快照，有變更就先問；按取消就留在原場地（下拉也還原）。 */
  var snap = '';
  function stateOf(){
    if(!cur) return '';
    var keys = Object.keys(cur.cells).sort();
    return JSON.stringify([fName.value.trim(), fTitle.value.trim(), fSub.value.trim(), fFoot.value.trim(),
      String(fRows.value).trim(), String(fCols.value).trim(), fLabels.value.trim(),
      fLayout ? fLayout.value : '', fShape ? fShape.value.trim() : '', fPcols ? String(fPcols.value).trim() : '',
      keys.map(function(k){ var c = cur.cells[k]; return [k, c.memberId || null, c.text || '', c.top || '']; })]);
  }
  function takeSnap(){ snap = stateOf(); }
  function siteDirty(){ return !!cur && !editor.hidden && stateOf() !== snap; }
  function confirmDiscardSite(){
    if(!siteDirty()) return true;
    var nm = fName.value.trim() || cur.name || '新場地';
    return window.confirm(['「' + nm + '」的格子或版面還沒儲存，確定要放棄這次的修改嗎？',
      '（想保留請按「取消」，再按「儲存」。）'].join(String.fromCharCode(10)));
  }

  sel.addEventListener('change', function(){
    if(!confirmDiscardSite()){ sel.value = (cur && cur.id != null) ? String(cur.id) : ''; return; }
    if(sel.value) openSite(sel.value);
  });

  // ── 新增／套用／儲存／刪除 ──
  btnAdd.addEventListener('click', function(){
    requireEdit(function(){
      if(!confirmDiscardSite()) return;
      cur = blank(); fillForm(); editor.hidden = false; renderGrid(); sel.value = ''; takeSnap(); fName.focus();
    });
  });
  // 列數／欄數／列標籤：邊打邊重畫格子（2026-09-09 使用者回報「打入行x列時欄位沒有即時變更」，
  // 原本非按「套用」不可）。input＝打字中的即時預覽，刻意不回寫輸入框，否則會跟游標搶；
  // change（離開欄位／按 Enter）＝正規化，把超過 1–60 的值夾回範圍並寫回畫面。
  var liveT = null;
  function liveResize(){
    if(!cur) return;
    if(liveT) clearTimeout(liveT);
    liveT = setTimeout(function(){ if(!cur) return; readForm({ typing: true }); renderGrid(); }, 180);
  }
  // 抬頭、副標（日期）、頁尾（地址）也印在紙上，一樣邊打邊重畫
  [fRows, fCols, fLabels, fShape, fPcols, fName, fTitle, fSub, fFoot].forEach(function(el){
    if(!el) return;
    el.addEventListener('input', liveResize);
    el.addEventListener('change', function(){
      if(!cur) return;
      if(liveT) clearTimeout(liveT);
      readForm(); fillForm(); renderGrid();
    });
  });
  if(btnApply) btnApply.addEventListener('click', function(){ if(!cur) return; readForm(); fillForm(); renderGrid(); });
  if(fLayout) fLayout.addEventListener('change', function(){
    if(!cur) return;
    syncLayoutUi();
    if(!fShape.value.trim()) fShape.value = fLayout.value === 'panels' ? '10,10' : (fLayout.value === 'steps' ? '5,7,9' : '');
    readForm(); fillForm(); renderGrid();
  });
  btnSave.addEventListener('click', function(){ requireEdit(save); });
  // 存檔進行中：連按兩下「儲存」時，新場地的 id 要等存檔→重讀清單→開啟都回來才有，
  // 舊版第二下仍以 id:null 再 INSERT 一次，建出兩個同名場地（M-9／體檢 frontend-9）
  var saving = false;
  function save(){
    if(!cur || saving) return;
    readForm();
    if(!cur.name){ toast('請填寫場地名稱', 'err'); fName.focus(); return; }
    var cells = [], dropped = [];
    for(var k in cur.cells){
      var rc = k.split(','), r = Number(rc[0]), c = Number(rc[1]);
      if(r < cur.rows && c < cur.cols && inside(r, c))
        cells.push({ r: r, c: c, memberId: cur.cells[k].memberId, text: cur.cells[k].text, top: cur.cells[k].top || '' });
      else dropped.push(cur.cells[k].label || cur.cells[k].text || ('第' + (r + 1) + '列第' + (c + 1) + '格'));
    }
    // 縮小尺寸後儲存＝格外的內容會不見。改成即時重畫後這一步更容易誤觸，所以存檔前明講並列出來。
    if(dropped.length){
      var names = dropped.slice(0, 6).join('、') + (dropped.length > 6 ? ('…等 ' + dropped.length + ' 格') : '');
      if(!window.confirm('格子範圍縮小了，範圍外的 ' + dropped.length +
                         ' 格內容會一併刪除：\n' + names + '\n\n確定要儲存嗎？（按取消可先把列數／欄數改回來）')) return;
    }
    var payload = { id: cur.id, name: cur.name, title: cur.title, subtitle: cur.subtitle, footer: cur.footer,
                    rows: cur.rows, cols: cur.cols, rowLabels: cur.rowLabels, cells: cells,
                    layout: cur.layout || 'grid', layoutOpts: cur.layoutOpts || {} };
    saving = true; btnSave.disabled = true;
    window.KinAPI.saveTombSite(payload).then(function(r){
      toast('已儲存「' + cur.name + '」', 'ok');
      return loadSites(r && r.id);
    }).catch(function(e){ toast('儲存失敗：' + e.message, 'err'); })
      .then(function(){ saving = false; btnSave.disabled = false; });
  }
  btnDel.addEventListener('click', function(){
    if(!cur) return;
    if(!cur.id){ cur = null; editor.hidden = true; return loadSites(); }
    requireEdit(function(){
      if(!window.confirm('確定刪除場地「' + cur.name + '」？只會刪掉這張格子表，族親資料不受影響。')) return;
      window.KinAPI.deleteTombSite(cur.id).then(function(){ toast('已刪除', 'ok'); return loadSites(); })
        .catch(function(e){ toast('刪除失敗：' + e.message, 'err'); });
    });
  });

  // ── CSV 來回（Excel 也能當編輯器）──
  btnExport.addEventListener('click', function(){
    if(!cur || !cur.id){ toast('請先儲存場地再匯出', 'err'); return; }
    // 匯出的是存好的版面：有沒存的修改時，Excel 的形狀會跟畫面對不上
    if(siteDirty()){ toast('有修改還沒儲存，請先按「儲存」再匯出', 'err'); return; }
    window.KinAPI.exportTombSiteCsv(cur.id).then(function(csv){
      var a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      a.download = '穴排位_' + cur.name + '.csv';
      document.body.appendChild(a); a.click();
      setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }).catch(function(e){ toast('匯出失敗：' + e.message, 'err'); });
  });
  fileImport.addEventListener('change', function(){
    var f = fileImport.files && fileImport.files[0];
    fileImport.value = '';
    if(!f) return;
    if(!cur || !cur.id){ toast('請先儲存場地，再匯入 CSV 覆寫格子', 'err'); return; }
    // 匯入後會重讀場地：沒存的修改會被蓋掉，先講
    if(siteDirty()){ toast('有修改還沒儲存，請先按「儲存」再匯入', 'err'); return; }
    var grid = (cur.layout || 'grid') === 'grid';
    requireEdit(function(){
      if(!window.confirm(grid ? '匯入會整張覆寫「' + cur.name + '」的格子與列標籤，確定？'
                              : '匯入會覆寫「' + cur.name + '」的所有格子（版型與格數不變），確定？')) return;
      window.KinAPI.importTombSiteCsv(cur.id, f).then(function(r){
        toast('已匯入' + (grid ? ' ' + r.rows + '×' + r.cols : '') + '，自動對到族親 ' + r.matched + ' 格' +
              (r.unmatched && r.unmatched.length ? '；' + r.unmatched.length + ' 格對不到族譜裡的人，存成文字（灰字）' : ''), 'ok');
        return loadSites(cur.id);
      }).catch(function(e){ toast('匯入失敗：' + e.message, 'err'); });
    });
  });

  // ── 列印 ──
  function doPrint(site){
    if(typeof window.openPrint === 'function') window.openPrint('doc=tombgrid&site=' + encodeURIComponent(site));
    else toast('列印需以正式模式（本機伺服器）開啟', 'err');
  }
  btnPrint.addEventListener('click', function(){ if(!cur || !cur.id){ toast('請先選擇（或儲存）場地', 'err'); return; } doPrint(cur.id); });
  btnPrintAll.addEventListener('click', function(){ doPrint('all'); });

  // 第一次進此頁才載入（避免啟動時多一趟）；成員改名後重讀讓稱呼跟上
  // （有沒存的格子時不重讀，免得把使用者正在填的內容蓋掉；存檔後自然會重讀）
  var nav = document.querySelector('.nav-item[data-view="tomb"]');
  if(nav) nav.addEventListener('click', function(){ if(!loaded){ loaded = true; loadSites(); } });
  if(typeof window.KinAPI.on === 'function'){
    window.KinAPI.on('member/changed', function(){ if(loaded && cur && cur.id && !siteDirty()) openSite(cur.id); });
  }
})();
