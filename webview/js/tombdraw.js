/* ============================================================
   穴排位圖的畫法——列印頁（print.html）與 app「穴排位」頁共用同一份，
   app 畫面上看到的就是印出來的樣子（2026-10-12 總幹事：列印看很直覺，app 要照列印重新設計）。

   TombDraw.render(site, opt) → { cls, html }
     cls ：外框要加的版型 class（tomb-panels／tomb-steps；方格為空字串）
     html：抬頭、地址、日期與格子；不含紙張外框與頁腳（列印頁包 .sheet＋foot()，app 包 .tomb-paper）
   site.cells 可以是陣列（後端格式）或 {'r,c': cell}（app 編輯中、還沒存的狀態）；格子印 cell.label。
   opt.edit：每格帶 data-r／data-c（app 點格子編輯）與 class：linked＝連到族親、txt＝自由文字。
   樣式在 css/tomb.css。
   ============================================================ */
(function () {
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  // 按「字」切，不按 UTF-16 單位切（戶政罕用字在擴充 B 區，split('') 會切成兩半）
  function chars(s) { return String(s == null ? '' : s).match(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\s\S]/g) || []; }
  // 副標（日期）可用「／」分行：原圖農曆、西元各一行
  function lines(t) { return String(t || '').split(/\s*[／\n]\s*/).filter(Boolean).map(esc).join('<br>'); }
  function cellMap(s) {
    if (s.cells && !Array.isArray(s.cells)) return s.cells;
    var g = {};
    (s.cells || []).forEach(function (c) { g[c.r + ',' + c.c] = c; });
    return g;
  }
  function tdOpen(r, c, cell, edit) {
    if (!edit) return '<td>';
    var cls = cell && cell.label ? (cell.memberId ? 'linked' : 'txt') : '';
    return '<td data-r="' + r + '" data-c="' + c + '"' + (cls ? ' class="' + cls + '"' : '') + ' title="點一下編輯這一格">';
  }
  function title(s) { return '<div class="doc-title">' + esc(s.title || s.name || '穴排位圖') + '</div>'; }
  // 名字超過 4 個字就縮字（格子只放得下 4 個字；自動稱呼「字號　姓公」是 5 個字），列印與 app 一起縮
  function fit(label) { var n = chars(label).length; return n >= 7 ? ' l7' : (n === 6 ? ' l6' : (n === 5 ? ' l5' : '')); }

  // 面板（照家族 2022 年面板圖）：幾塊紅框格子並排（各塊列數可不同，頂端對齊）；每格上方小字（世代）＋名字
  function panels(s, edit) {
    var o = s.layoutOpts || {}, pc = o.panelCols || 3, pr = o.panelRows || [s.rows], g = cellMap(s);
    var wrap = pr.map(function (rows, p) {
      var t = '';
      for (var r = 0; r < rows; r++) {
        t += '<tr>';
        for (var k = 0; k < pc; k++) {
          var c = p * pc + k, cell = g[r + ',' + c];
          t += tdOpen(r, c, cell, edit) + (cell && cell.top ? '<div class="tp-top">' + esc(cell.top) + '</div>' : '') +
               '<div class="tp-nm' + fit(cell && cell.label) + '">' + (cell ? esc(cell.label || '') : '') + '</div></td>';
        }
        t += '</tr>';
      }
      return '<div class="tp-panel"><table class="tp-grid"><tbody>' + t + '</tbody></table></div>';
    }).join('');
    return title(s) + '<div class="tp-wrap">' + wrap + '</div>' +
      '<div class="tp-foot"><div>' + esc(s.footer || '') + '</div><div class="tp-date">' + lines(s.subtitle) + '</div></div>';
  }

  // 階梯（照家族 2002 年主牌位圖）：一層一層往下加寬、置中；由右往左讀（c=0 在最右），每格直書；
  // 同一層相鄰格子的上方小字相同就合成一條世代橫條，橫條字也由右往左排（原圖「世 三 十」＝十三世）
  function bandTh(label, span) {                // 只有一格寬：原圖是小字擠一行（「世九十」）
    return '<th colspan="' + span + '"' + (span === 1 ? ' class="n1"' : '') + '>' +
           esc(chars(label).reverse().join(span === 1 ? '' : '　')) + '</th>';
  }
  function steps(s, edit) {
    var w = (s.layoutOpts || {}).rowWidths || [], g = cellMap(s);
    var body = w.map(function (n, r) {
      var band = '', cells = '', run = null, span = 0, anyTop = false;
      for (var c = n - 1; c >= 0; c--) {           // 畫面由左到右＝c 由大到小
        var cell = g[r + ',' + c], top = (cell && cell.top) || '';
        if (top) anyTop = true;
        if (run !== null && top !== run) { band += bandTh(run, span); span = 0; }
        run = top; span++;
        cells += tdOpen(r, c, cell, edit) + '<div class="ts-v' + fit(cell && cell.label) + '">' + (cell ? esc(cell.label || '') : '') + '</div></td>';
      }
      if (span) band += bandTh(run, span);
      return '<div class="ts-step"><table class="ts-grid"><tbody>' + (anyTop ? '<tr>' + band + '</tr>' : '') +
             '<tr>' + cells + '</tr></tbody></table></div>';
    }).join('');
    return title(s) +
      '<div class="ts-head"><div class="ts-addr">' + esc(s.footer || '') + '</div><div class="ts-date">' + lines(s.subtitle) + '</div></div>' +
      '<div class="ts-body">' + body + '</div>';
  }

  // 方格：th.gen＝列標籤（直書）、td＝格子稱呼
  function grid(s, edit) {
    var g = cellMap(s), rows = '';
    for (var r = 0; r < s.rows; r++) {
      rows += '<tr><th class="gen">' + esc((s.rowLabels || [])[r] || '') + '</th>';
      for (var c = 0; c < s.cols; c++) {
        var cell = g[r + ',' + c];
        rows += tdOpen(r, c, cell, edit) + (cell ? esc(cell.label) : '') + '</td>';
      }
      rows += '</tr>';
    }
    return title(s) + (s.subtitle ? '<div class="doc-subtitle">' + esc(s.subtitle) + '</div>' : '') +
      '<table class="tomb"><tbody>' + rows + '</tbody></table>' +
      (s.footer ? '<div class="foot">' + esc(s.footer) + '</div>' : '');
  }

  window.TombDraw = {
    render: function (s, opt) {
      var edit = !!(opt && opt.edit);
      if (s.layout === 'panels') return { cls: 'tomb-panels', html: panels(s, edit) };
      if (s.layout === 'steps') return { cls: 'tomb-steps', html: steps(s, edit) };
      return { cls: '', html: grid(s, edit) };
    }
  };
})();
