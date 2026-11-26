/* =========================================================
 * app.js — 山岳救助ナビ 本体
 *   ・GPS(watchPosition) / テストモード（模擬移動）
 *   ・現場座標の入力・変更・履歴・戻す
 *   ・Leaflet 地図（地理院標準 / 航空写真 / OSM）と直線ルート
 *   ・ダッシュボード（距離・方位・速度・ETE/ETA・標高・高度差）
 *   ・Wake Lock（画面スリープ防止）＋フォールバック
 * ========================================================= */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const Geo = window.Geo;

  /* ---------- 定数 ---------- */
  const MS2KT = 1.943844;     // m/s → kt
  const MS2KMH = 3.6;         // m/s → km/h
  const M2FT = 3.28084;
  const MIN_SPEED_MS = 5 / MS2KT; // 5kt未満はETE計算しない（ホバリング等）
  const OVERHEAD_M = 10;          // この距離以内は「直上」（方位が定まらないため数値の代わりに「直上」と表示）
  const HIST_MAX = 8;
  const ELEV_URL = (lat, lon) =>
    `https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php?lon=${lon.toFixed(6)}&lat=${lat.toFixed(6)}&outtype=JSON`;
  const TILES = {
    std: {
      url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png',
      opt: { minZoom: 5, maxNativeZoom: 18, maxZoom: 19,
        attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>' },
    },
    photo: {
      url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg',
      opt: { minZoom: 2, maxNativeZoom: 18, maxZoom: 19,
        attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>（シームレス空中写真）' },
    },
    osm: {
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      opt: { minZoom: 2, maxNativeZoom: 19, maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors' },
    },
  };
  const TEMPLATE_FILE = 'touroku-template.xlsx';
  const LEAFLET_LOCAL = './';
  const LEAFLET_CDN = 'https://unpkg.com/leaflet@1.9.4/dist/';
  const ROTATE_LOCAL = 'leaflet-rotate.js';
  const ROTATE_CDN = 'https://unpkg.com/leaflet-rotate@0.6.2/dist/leaflet-rotate.js';

  /* ---------- 保存 ---------- */
  const LS = {
    get(k, d) { try { const v = localStorage.getItem('rn_' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('rn_' + k, JSON.stringify(v)); } catch (e) { /* 容量超過等は無視 */ } },
    trySet(k, v) { try { localStorage.setItem('rn_' + k, JSON.stringify(v)); return true; } catch (e) { return false; } },
  };

  /* ---------- 状態 ---------- */
  const S = {
    target: LS.get('target', null),      // {lat, lon, setAt, elev:{status,value,src}}
    history: LS.get('history', []),      // 過去の現場 [{lat,lon,setAt}] 新しい順
    old: LS.get('old', null),            // 直前の現場（地図に灰色表示）
    showOld: LS.get('showOld', true),
    follow: LS.get('follow', true),
    headUp: LS.get('headUp', true),   // true=機首方向が上 / false=北が上
    mapHdg: 0,
    layer: LS.get('layer', 'std'),
    theme: LS.get('theme', 'dark'),
    elevCache: LS.get('elevCache', {}),
    pts: LS.get('pts', null),          // 登録地点 {points, fileName, importedAt}
    ptsPrev: LS.get('ptsPrev', null),  // 1つ前の一覧（元に戻す用）
    sel: null,                         // 検索結果・地図で選んだ地点
    mapPick: false,                    // 地図タップで現場を指定中
    wps: LS.get('wps', []),            // 経由地 [{id,lat,lon,name,note,kind:'pass'|'stop',done}]
    wpRadius: LS.get('wpRadius', 0.5), // 通過判定の距離[km]
    wpNear: null,                      // 到着圏内の立寄り点id
    formMode: 'target',                // 入力画面：'target'=現場 / 'wp'=経由地
    pos: null,              // 最新の自機位置
    lastHeading: null,
    gpsWatch: null,
    gpsError: null,
    testMode: false,
    editing: false,
    pending: null,          // 入力中（未確定）の座標
  };
  if (S.target && S.target.elev && S.target.elev.status === 'loading') S.target.elev.status = 'error';

  const saveTarget = () => { LS.set('target', S.target); LS.set('history', S.history); LS.set('old', S.old); };

  /* ---------- 小物 ---------- */
  const pad2 = (n) => String(n).padStart(2, '0');
  const hms = (t) => { const d = new Date(t); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };
  const hm = (t) => { const d = new Date(t); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
  const fmtInt = (n) => Math.round(n).toLocaleString('ja-JP');
  const signed = (n) => (n > 0 ? '+' : n < 0 ? '−' : '±') + fmtInt(Math.abs(n));
  const valid = (v) => v != null && isFinite(v);
  /** 方位表記：北=360、001〜360 の3桁 */
  const fmtBrg = (deg) => { let r = Math.round(((deg % 360) + 360) % 360); if (r === 0) r = 360; return String(r).padStart(3, '0'); };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const setText = (id, v) => { const el = $(id); if (el && el.textContent !== String(v)) el.textContent = v; };
  const CARD_JA = { N: '北', NNE: '北北東', NE: '北東', ENE: '東北東', E: '東', ESE: '東南東', SE: '南東', SSE: '南南東',
    S: '南', SSW: '南南西', SW: '南西', WSW: '西南西', W: '西', WNW: '西北西', NW: '北西', NNW: '北北西' };

  let toastTimer = null;
  function toast(msg, ms) {
    const el = $('toast');
    el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms || 2600);
  }

  function confirmModal(title, html, yesLabel) {
    return new Promise((resolve) => {
      $('modalTitle').textContent = title;
      $('modalBody').innerHTML = html;
      $('modalYes').textContent = yesLabel || 'OK';
      $('modalNo').hidden = false;
      $('modal').hidden = false;
      const done = (v) => { $('modal').hidden = true; $('modalYes').onclick = $('modalNo').onclick = null; resolve(v); };
      $('modalYes').onclick = () => done(true);
      $('modalNo').onclick = () => done(false);
    });
  }
  function infoModal(title, html) {
    return confirmModal(title, html, '閉じる').then(() => {});
  }

  /* =========================================================
   * 現場座標 入力・変更
   * ========================================================= */
  function ddText(t) { return `${Geo.formatDD(t.lat)}, ${Geo.formatDD(t.lon)}`; }
  function dmsText(t) { return `${Geo.formatDMS(t.lat, true)} ${Geo.formatDMS(t.lon, false)}`; }

  function renderTarget() {
    const t = S.target;
    $('targetEmpty').hidden = !!t;
    $('targetInfo').hidden = !t;
    if (t) {
      setText('tLatDD', Geo.formatDD(t.lat));
      setText('tLonDD', Geo.formatDD(t.lon));
      setText('tLatDMS', Geo.formatDMS(t.lat, true));
      setText('tLonDMS', Geo.formatDMS(t.lon, false));
      setText('targetSetAt', `設定 ${hms(t.setAt)}`);
      setText('tName', t.name || '');
      $('tName').hidden = !t.name;
      setText('tNote', t.note ? '備考：' + t.note : '');
      $('tNote').hidden = !t.note;
    } else {
      setText('targetSetAt', '');
    }
    $('gmapBtn').disabled = !t;
    $('undoBtn').disabled = S.history.length === 0;
    $('histBtn').disabled = S.history.length === 0;
    setText('histCount', S.history.length);
    $('editBtn').textContent = t ? '✎ 現場座標を変更（再入力）' : '✎ 現場座標を入力';
    renderHistory();
    renderElev();
    if ($('wpList')) renderWps();
  }

  function renderHistory() {
    const ul = $('histList');
    if (S.history.length === 0) { ul.hidden = true; ul.innerHTML = ''; return; }
    ul.innerHTML = S.history.map((h, i) => `
      <li><button type="button" data-idx="${i}">
        <span class="h-time">${i === 0 ? '直前 ' : ''}設定 ${hms(h.setAt)}${h.name ? '　' + esc(h.name) : ''}</span>
        <span class="h-coord">${esc(ddText(h))}</span><br>
        <span class="h-coord small">${esc(dmsText(h))}</span>
      </button></li>`).join('');
  }

  /* =========================================================
   * 度分秒 個別入力（自動で次のボックスへ移動）
   * ========================================================= */
  const DMS_ORDER = ['latD', 'latM', 'latS', 'lonD', 'lonM', 'lonS'];
  const dmsEls = () => DMS_ORDER.map($);
  const dmsAnyFilled = () => dmsEls().some((e) => e.value.trim() !== '');
  const DD_ORDER = ['ddLatI', 'ddLatF', 'ddLonI', 'ddLonF'];
  const ddAnyFilled = () => DD_ORDER.some((id) => $(id).value.trim() !== '');
  function clearDMS() {
    dmsEls().forEach((e) => { e.value = ''; e.classList.remove('bad'); });
    setHemi('hemiLat', 'N'); setHemi('hemiLon', 'E');
  }
  function clearDD() {
    DD_ORDER.forEach((id) => { $(id).value = ''; });
    setHemi('hemiLatDD', 'N'); setHemi('hemiLonDD', 'E');
  }
  function setHemi(id, v) {
    const b = $(id);
    b.dataset.v = v;
    b.textContent = { N: '北緯', S: '南緯', E: '東経', W: '西経' }[v];
    b.classList.toggle('alt', v === 'S' || v === 'W');
  }
  function focusField(id) {
    $(id).focus(); // フォーカス時に中身を全選択 → そのまま打ち直せる
  }
  /** 1座標分（緯度 or 経度）のボックス → 文字列 */
  function dmsString(kind) {
    const d = $(kind + 'D').value.trim(), m = $(kind + 'M').value.trim(), sec = $(kind + 'S').value.trim().replace(/\.$/, '');
    if (!d && !m && !sec) return { empty: true };
    if (!d || !m || !sec) return { partial: true };
    const hemi = $(kind === 'lat' ? 'hemiLat' : 'hemiLon').dataset.v;
    return { str: `${d} ${m} ${sec} ${hemi}` };
  }
  /** 10進数ボックス（整数部・小数部）→ 文字列 */
  function ddString(kind) {
    const k = kind === 'lat' ? 'Lat' : 'Lon';
    const i = $('dd' + k + 'I').value.trim(), f = $('dd' + k + 'F').value.trim();
    if (!i && !f) return { empty: true };
    if (!i || !f) return { partial: true };
    return { str: `${i}.${f} ${$('hemi' + k + 'DD').dataset.v}` };
  }

  /** 10進数ボックスの入力：整数部は桁数で、小数部は6桁で次へ */
  function onDDInput(e) {
    const el = e.target, id = el.id, raw = el.value;
    if (/[^\d.]/.test(raw) && raw.trim().length > 4 && Geo.looksLikePair(raw)) {
      el.value = ''; clearDD(); pastePair(raw); return;
    }
    if (dmsAnyFilled()) clearDMS();
    clearSel();
    const isInt = /I$/.test(id);
    if (isInt && raw.includes('.')) {
      // 「35.360556」をまとめて打った／貼り付けた → 整数部と小数部に振り分け
      const [a, b] = raw.split('.');
      el.value = a.replace(/\D/g, '');
      const fId = id.replace(/I$/, 'F');
      $(fId).value = (b || '').replace(/\D/g, '').slice(0, 8);
      updatePreview();
      focusField(fId);
      return;
    }
    const v = raw.replace(/\D/g, '').slice(0, isInt ? 3 : 8);
    if (v !== raw) el.value = v;
    let done = false;
    if (id === 'ddLatI') done = v.length >= 2;
    else if (id === 'ddLonI') done = v.length >= 3 || (v.length === 2 && v[0] !== '1');
    else done = v.length >= 6;
    updatePreview();
    if (done && e.inputType !== 'deleteContentBackward') {
      const i = DD_ORDER.indexOf(id);
      if (i < DD_ORDER.length - 1) focusField(DD_ORDER[i + 1]);
      else { el.blur(); $('applyBtn').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
    }
  }

  /** 入力のたびに：数字以外を除去 → 桁がそろえば次のボックスへ */
  function onDMSInput(e) {
    const el = e.target, id = el.id;
    const raw = el.value;
    // 座標をまるごと貼り付けた場合は一括欄へ
    if (/[^\d.]/.test(raw) && raw.trim().length > 4) {
      if (Geo.looksLikePair(raw)) {
        el.value = ''; clearDMS();
        pastePair(raw); return;
      }
      const nums = raw.match(/\d+(?:\.\d+)?/g) || [];
      if (nums.length === 3 && /D$/.test(id)) {
        const k = id.slice(0, 3);
        $(k + 'D').value = nums[0]; $(k + 'M').value = nums[1]; $(k + 'S').value = nums[2];
        clearSel();
        updatePreview(); return;
      }
    }
    const isSec = /S$/.test(id);
    let v;
    if (isSec) {
      v = raw.replace(/[^\d.]/g, '');
      const dot = v.indexOf('.');
      if (dot >= 0) v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, '');
      if (dot < 0 && v.length > 2) v = v.slice(0, 2) + '.' + v.slice(2); // 「3845」→「38.45」
      if (/^[6-9]/.test(v)) v = '0' + v;                                   // 「7」→「07」
      const p = v.indexOf('.');
      if (p >= 0) v = v.slice(0, p + 3);                                   // 小数点以下2桁まで
    } else {
      v = raw.replace(/\D/g, '');
      if (/M$/.test(id) && /^[6-9]/.test(v)) v = '0' + v;                  // 分「7」→「07」
    }
    if (v !== raw) el.value = v;
    clearSel();
    if (ddAnyFilled()) clearDD();
    el.classList.remove('bad');

    // 自動移動の判定
    let done = false;
    if (id === 'latD') done = v.length >= 2;
    else if (id === 'lonD') done = v.length >= 3 || (v.length === 2 && v[0] !== '1');
    else if (/M$/.test(id)) done = v.length >= 2;
    else if (isSec) done = /^\d{2}\.\d{2}$/.test(v);
    updatePreview();
    if (done && e.inputType !== 'deleteContentBackward') {
      if (/M$/.test(id) && parseInt(v, 10) >= 60) { el.classList.add('bad'); return; }
      const i = DMS_ORDER.indexOf(id);
      if (i < DMS_ORDER.length - 1) focusField(DMS_ORDER[i + 1]);
      else { el.blur(); $('applyBtn').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
    }
  }
  /** 空のボックスで削除キー → 前のボックスへ戻る */
  function onDMSKeydown(e) {
    const el = e.target;
    if (e.key === 'Backspace' && el.value === '') {
      const chain = DMS_ORDER.includes(el.id) ? DMS_ORDER : DD_ORDER;
      const i = chain.indexOf(el.id);
      if (i > 0) { e.preventDefault(); focusField(chain[i - 1]); }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (S.pending) applyPending();
    }
  }

  /* =========================================================
   * 名称検索（登録地点：端末内／地理院：ネット）
   * ========================================================= */
  const GSI_SEARCH = (q) => `https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(q)}`;
  let qItems = [], gsi = { q: '', state: 'idle', list: [] }, gsiSeq = 0, qTimer = null;

  const searchFrom = () => (S.pos ? { lat: S.pos.lat, lon: S.pos.lon } : S.target ? { lat: S.target.lat, lon: S.target.lon } : null);
  const ptsList = () => (S.pts && S.pts.points) || [];
  const qnorm = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/[\s　]/g, '');

  function clearSel() {
    if (!S.sel) return;
    if (S.sel.src === '地図') removePickMarker();
    S.sel = null;
    document.querySelectorAll('.q-item.sel').forEach((b) => b.classList.remove('sel'));
  }
  function clearSearch() {
    S.sel = null;
    $('q').value = '';
    gsi = { q: '', state: 'idle', list: [] };
    renderSearch();
  }
  /** 座標文字列が貼り付けられた → 検索欄に入れて座標として選択 */
  function pastePair(raw) {
    $('q').value = String(raw).trim();
    renderSearch();
    const i = qItems.findIndex((it) => it.src === '座標');
    if (i >= 0) selectItem(i); else updatePreview();
  }

  function distLabel(it, from) {
    if (!from) return '';
    const d = Geo.inverse(from.lat, from.lon, it.lat, it.lon);
    return `${(d.distance / 1000).toFixed(1)}km / ${fmtBrg(d.bearing)}`;
  }

  function renderSearch() {
    const box = $('qResults');
    const q = $('q').value.trim();
    const from = searchFrom();
    qItems = [];
    if (!q) {
      const n = ptsList().length;
      box.innerHTML = `<div class="q-hint">${n ? `登録地点 ${n}件から検索できます（電波不要）。見つからない場合は「地理院で検索」を押してください。`
        : '登録地点が未登録です（下の「登録地点」から一覧表を読み込めます）。「地理院で検索」は電波が必要です。'}</div>`;
      return;
    }
    // 座標そのものが入力された場合
    if ((q.match(/\d+(?:\.\d+)?/g) || []).length >= 2) {
      try { const r = Geo.parsePair(q); qItems.push({ src: '座標', name: '', lat: r.lat, lon: r.lon, note: r.notes.join(' ') }); } catch (e) { /* 座標ではない */ }
    }
    Points.search(ptsList(), q, from, 30).forEach((h) => qItems.push(Object.assign({ src: '登録地点' }, h.p)));
    const localCount = qItems.length;
    if (gsi.q === q && gsi.state === 'done') gsi.list.forEach((g) => qItems.push(Object.assign({ src: '地理院' }, g)));

    let html = '';
    if (!localCount && !(gsi.q === q && gsi.state === 'done' && gsi.list.length)) {
      html += `<div class="q-hint">登録地点に「${esc(q)}」は見つかりません。</div>`;
    }
    html += qItems.map((it, i) => {
      const badge = it.src === '登録地点' ? '<span class="q-badge reg">★登録</span>' : it.src === '地理院' ? '<span class="q-badge gsi">地理院</span>' : '<span class="q-badge crd">座標</span>';
      const title = it.name || `${Geo.formatDD(it.lat)}, ${Geo.formatDD(it.lon)}`;
      const sub = [it.pref, it.type].filter(Boolean).join('・');
      const isSel = S.sel && S.sel.lat === it.lat && S.sel.lon === it.lon && (S.sel.name || '') === (it.name || '');
      return `<button type="button" class="q-item${isSel ? ' sel' : ''}" data-i="${i}">
        <span class="q-top">${badge}<span class="q-name">${esc(title)}</span><span class="q-dist">${distLabel(it, from)}</span></span>
        ${sub || it.note ? `<span class="q-sub">${esc(sub)}${sub && it.note ? '　' : ''}${it.note ? '備考：' + esc(it.note.length > 60 ? it.note.slice(0, 60) + '…' : it.note) : ''}</span>` : ''}
      </button>`;
    }).join('');
    if (gsi.q === q && gsi.state === 'loading') html += '<div class="q-hint">地理院で検索中…</div>';
    else if (gsi.q === q && gsi.state === 'error') html += '<div class="q-hint q-warn">地理院の検索に失敗しました（電波がないか、混雑しています）。登録地点の検索は使えます。</div>';
    else if (gsi.q === q && gsi.state === 'done' && !gsi.list.length) html += '<div class="q-hint">地理院でも見つかりませんでした。名称を短くするか、市町村名を付けて試してください。</div>';
    else if (gsi.q !== q) html += `<button type="button" class="btn q-more" id="qGsiBtn">🌐 地理院で「${esc(q)}」を検索（電波が必要）</button>`;
    box.innerHTML = html;
    const gb = $('qGsiBtn');
    if (gb) gb.onclick = () => gsiSearch(q);
  }

  async function gsiSearch(q) {
    q = String(q || '').trim();
    if (!q) return;
    const seq = ++gsiSeq;
    gsi = { q, state: 'loading', list: [] };
    renderSearch();
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => ctrl && ctrl.abort(), 10000);
    try {
      const res = await fetch(GSI_SEARCH(q), { signal: ctrl ? ctrl.signal : undefined });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      if (seq !== gsiSeq) return;
      const from = searchFrom();
      const terms = q.normalize('NFKC').split(/[\s　]+/).map(qnorm).filter(Boolean);
      const seen = new Set();
      const list = (Array.isArray(j) ? j : []).map((f) => ({
        name: f && f.properties ? f.properties.title : '',
        lon: f && f.geometry ? f.geometry.coordinates[0] : NaN,
        lat: f && f.geometry ? f.geometry.coordinates[1] : NaN,
      })).filter((g) => g.name && isFinite(g.lat) && isFinite(g.lon) && !seen.has(g.name + g.lat) && seen.add(g.name + g.lat))
        .map((g) => {
          const n = qnorm(g.name);
          const score = terms.every((t) => n.includes(t)) ? 2 : terms.some((t) => t.length >= 2 && n.includes(t)) ? 1 : 0;
          const d = from ? Geo.inverse(from.lat, from.lon, g.lat, g.lon).distance : 0;
          return Object.assign(g, { score, d });
        })
        .filter((g) => g.score > 0)
        .sort((a, b) => b.score - a.score || a.d - b.d)
        .slice(0, 15);
      gsi = { q, state: 'done', list };
    } catch (e) {
      if (seq !== gsiSeq) return;
      gsi = { q, state: 'error', list: [] };
    } finally { clearTimeout(timer); }
    renderSearch();
  }

  /* ---------- 地図で指定（タップで位置を決め、ピンのドラッグで微調整） ---------- */
  let pickMarker = null, pickPrevFollow = null;
  function removePickMarker() {
    if (pickMarker && map) map.removeLayer(pickMarker);
    pickMarker = null;
  }
  function startMapPick() {
    if (!map) { toast('地図が利用できません（オフラインで地図を読み込めていません）', 3500); return; }
    if (S.mapPick) { // もう一度押す → 指定をやめる
      if (S.sel && S.sel.src === '地図') { clearSel(); updatePreview(); }
      stopMapPick();
      return;
    }
    S.mapPick = true;
    simTapArmed = false;
    if (pickPrevFollow === null) pickPrevFollow = S.follow;
    if (S.follow) setFollow(false); // 指定中は地図を自機に追従させない
    $('mapTapHint').textContent = '地図をタップして現場を指定（ピンはドラッグで微調整）';
    $('mapTapHint').hidden = false;
    const b = $('mapPickBtn');
    b.textContent = '✖ 地図での指定をやめる';
    b.classList.add('btn-warn');
  }
  function stopMapPick() {
    const was = S.mapPick;
    S.mapPick = false;
    if (!simTapArmed) $('mapTapHint').hidden = true;
    const b = $('mapPickBtn');
    b.textContent = '🗺 地図をタップして指定';
    b.classList.remove('btn-warn');
    removePickMarker();
    if (was && pickPrevFollow) setFollow(true); // 指定前に追従していたら元に戻す
    pickPrevFollow = null;
  }
  function pickAt(lat, lon) {
    clearDMS(); clearDD();
    if ($('q').value) { $('q').value = ''; gsi = { q: '', state: 'idle', list: [] }; renderSearch(); }
    S.sel = { lat, lon, name: '', note: '', pref: '', type: '', src: '地図' };
    if (!pickMarker) {
      pickMarker = L.marker([lat, lon], {
        icon: L.divIcon({ className: 'tg-icon', html: TG_SVG('#19c37d'), iconSize: [46, 46], iconAnchor: [23, 23] }),
        draggable: true, autoPan: true, zIndexOffset: 900, keyboard: false,
      }).addTo(map).bindTooltip('指定地点', { permanent: true, direction: 'right', offset: [22, 0], className: 'map-label' });
      pickMarker.on('dragend', () => { const ll = pickMarker.getLatLng(); pickAt(ll.lat, ll.lng); });
    } else pickMarker.setLatLng([lat, lon]);
    updatePreview();
    $('preview').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function selectItem(i) {
    const it = qItems[i];
    if (!it) return;
    clearDMS(); clearDD(); removePickMarker();
    S.sel = { lat: it.lat, lon: it.lon, name: it.name || '', note: it.note || '', pref: it.pref || '', type: it.type || '', src: it.src };
    document.querySelectorAll('.q-item').forEach((b) => b.classList.toggle('sel', +b.dataset.i === i));
    $('q').blur();
    updatePreview();
    $('preview').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /* =========================================================
   * 登録地点（場外一覧表）の読み込み・元に戻す・書き出し
   * ========================================================= */
  function savePts() {
    const ok1 = LS.trySet('pts', S.pts), ok2 = LS.trySet('ptsPrev', S.ptsPrev);
    if (!ok1) infoModal('保存できませんでした', '端末の保存容量が不足しています。一覧の件数を減らすか、iPadの空き容量を確認してください。');
    return ok1 && ok2;
  }
  function renderPts() {
    const pts = ptsList();
    const info = $('ptsInfo');
    if (!pts.length) {
      info.innerHTML = '<div class="empty small-empty">未登録です。一覧表（Excel / CSV）を読み込んでください。</div>';
    } else {
      const byPref = {};
      pts.forEach((p) => { byPref[p.pref] = (byPref[p.pref] || 0) + 1; });
      const d = new Date(S.pts.importedAt);
      info.innerHTML = `
        <div class="pts-total"><b>${pts.length}</b> 件</div>
        <div class="small muted">${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${hm(S.pts.importedAt)} 読込　${esc(S.pts.fileName || '')}</div>
        <div class="pts-prefs">${Object.keys(byPref).map((k) => `<span class="chip">${esc(k)} ${byPref[k]}</span>`).join('')}</div>`;
    }
    $('ptsUndoBtn').disabled = !(S.ptsPrev && S.ptsPrev.points && S.ptsPrev.points.length);
    $('ptsExportBtn').disabled = !pts.length;
    if (S.editing) renderSearch();
  }

  function issueList(title, list, cls) {
    if (!list.length) return '';
    const shown = list.slice(0, 60).map((e) =>
      `<li><b>${esc(e.sheet)}</b> ${e.row}行目${e.name ? '「' + esc(e.name) + '」' : ''}：${esc(e.msg)}</li>`).join('');
    return `<div class="${cls}"><div class="iss-title">${title}（${list.length}件）</div><ul class="iss">${shown}${list.length > 60 ? `<li>…ほか ${list.length - 60}件</li>` : ''}</ul></div>`;
  }

  async function importPts(file) {
    if (!file) return;
    let sheets;
    try { sheets = await Points.readFile(file); } catch (e) {
      infoModal('一覧表を読み込めません', esc(e.message || String(e)));
      return;
    }
    const res = Points.extractPoints(sheets);
    const sheetRows = res.sheets.map((sh) =>
      `<tr><td>${esc(sh.name)}</td><td class="num">${sh.skipped ? '—' : sh.count + '件'}</td><td class="small muted">${esc(sh.skipped || '')}</td></tr>`).join('');
    if (!res.points.length) {
      infoModal('地点が見つかりませんでした', `<div class="small">「${esc(file.name)}」</div>
        <table class="pts-table">${sheetRows}</table>
        <div class="small" style="margin-top:8px">各シートの1行目付近に「名称」「緯度」「経度」の見出しが必要です。入力用テンプレートを参考にしてください。</div>
        ${issueList('読み込めなかった行', res.errors, 'iss-err')}`);
      return;
    }
    const df = Points.diff(ptsList(), res.points);
    const ok = await confirmModal('登録地点をこの内容に入れ替えますか？', `
      <div class="small">ファイル：${esc(file.name)}</div>
      <table class="pts-table">${sheetRows}<tr class="tot"><td>合計</td><td class="num">${res.points.length}件</td><td></td></tr></table>
      ${ptsList().length ? `<div class="pts-diff">前回との比較（目安）：追加 <b>${df.added}</b>／変更 <b>${df.changed}</b>／削除 <b>${df.removed}</b>／変更なし ${df.same}</div>` : ''}
      ${issueList('⚠ 読み込めない行（この行は登録されません）', res.errors, 'iss-err')}
      ${issueList('確認が必要な行（登録はされます）', res.warnings, 'iss-warn')}
      <div class="small muted" style="margin-top:8px">入れ替え後も「前の一覧に戻す」で1回分だけ元に戻せます。</div>`, '入れ替える');
    if (!ok) return;
    S.ptsPrev = S.pts;
    S.pts = { points: res.points, fileName: file.name, importedAt: Date.now() };
    if (!savePts()) return;
    renderPts();
    toast(`登録地点を ${res.points.length}件 に更新しました`, 3000);
  }

  async function undoPts() {
    if (!S.ptsPrev) return;
    const d = new Date(S.ptsPrev.importedAt);
    const ok = await confirmModal('前の一覧に戻しますか？', `
      ${S.ptsPrev.points.length}件（${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} 読込　${esc(S.ptsPrev.fileName || '')}）に戻します。<br>
      <span class="small muted">今の一覧（${ptsList().length}件）は「前の一覧」として残ります。</span>`, '戻す');
    if (!ok) return;
    const t = S.pts; S.pts = S.ptsPrev; S.ptsPrev = t;
    if (!savePts()) return;
    renderPts();
    toast('前の一覧に戻しました');
  }

  /** ファイルを渡す（共有シート → 「"ファイル"に保存」／AirDrop） */
  async function saveFile(blob, name) {
    try {
      const f = new File([blob], name, { type: blob.type });
      if (navigator.canShare && navigator.canShare({ files: [f] })) { await navigator.share({ files: [f] }); return; }
    } catch (e) { if (e && e.name === 'AbortError') return; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }
  function exportPts() {
    const pts = ptsList();
    if (!pts.length) return;
    const d = new Date();
    saveFile(new Blob([Points.toCSV(pts)], { type: 'text/csv' }),
      `登録地点_${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}.csv`);
  }
  async function downloadTemplate() {
    try {
      const r = await fetch(TEMPLATE_FILE);
      if (!r.ok) throw new Error();
      await saveFile(new Blob([await r.arrayBuffer()], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), '登録地点_入力用テンプレート.xlsx');
    } catch (e) { toast('テンプレートを取得できませんでした（一度オンラインで開いてください）', 3500); }
  }

  /* =========================================================
   * 経由地（ウェイポイント）
   *   通過点：谷筋・稜線を避ける経路用。通過判定距離に入ると自動で次へ
   *   立寄り点：揚収・ランデブーポイント用。自動では進まず「次へ」で進む
   * ========================================================= */
  const WP_MAX = 10;
  const KIND_JA = { pass: '通過点', stop: '立寄り点' };
  const wpActive = () => S.wps.find((w) => !w.done) || null;
  const wpNo = (w) => S.wps.indexOf(w) + 1;
  const wpLabel = (w) => `WP${wpNo(w)}`;
  const wpTitle = (w) => wpLabel(w) + (w.name ? ' ' + w.name : '');
  const saveWps = () => LS.set('wps', S.wps);

  /** 今向かっている地点（次の経由地 → なければ現場） */
  function navDest() {
    const w = wpActive();
    if (w) return { lat: w.lat, lon: w.lon, label: wpLabel(w), name: w.name, wp: w };
    if (S.target) return { lat: S.target.lat, lon: S.target.lon, label: '現場', name: S.target.name || '', wp: null };
    return null;
  }
  /** これから回る地点の列（次の経由地 … 現場） */
  function remainingRoute() {
    const pts = S.wps.filter((w) => !w.done).map((w) => [w.lat, w.lon]);
    if (S.target) pts.push([S.target.lat, S.target.lon]);
    return pts;
  }
  /** 自機から残りの経路を回った合計距離[m] */
  function remainingTotal(p) {
    const pts = [[p.lat, p.lon]].concat(remainingRoute());
    let sum = 0;
    for (let i = 1; i < pts.length; i++) sum += Geo.inverse(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]).distance;
    return sum;
  }

  function wpChanged() {
    saveWps(); renderWps(); updateMapObjects(); scheduleRender();
  }
  function addWaypoint(p) {
    if (S.wps.length >= WP_MAX) {
      infoModal(`経由地は最大${WP_MAX}か所です`, '不要な経由地を削除してから追加してください。');
      return null;
    }
    const looksStop = p.src === '登録地点' || /ランデブー|ＲＰ|RP|揚収|場外|ヘリポート|立寄/i.test(`${p.name || ''}${p.type || ''}`);
    const w = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      lat: p.lat, lon: p.lon, name: p.name || '', note: p.note || '',
      kind: looksStop ? 'stop' : 'pass', done: false,
    };
    S.wps.push(w);
    wpChanged();
    return w;
  }

  /** 位置更新のたびに：通過点の自動通過・立寄り点への接近を判定 */
  function checkWp() {
    const w = wpActive(), p = S.pos;
    if (!w || !p) { S.wpNear = null; return; }
    const d = Geo.inverse(p.lat, p.lon, w.lat, w.lon).distance;
    const r = S.wpRadius * 1000;
    if (w.kind === 'pass') {
      if (d <= r) {
        const lbl = wpLabel(w);
        w.done = true;
        const nx = navDest();
        toast(`${lbl} 通過 → 次は ${nx ? nx.label + (nx.name ? '（' + nx.name + '）' : '') : '（なし）'}`, 4000);
        wpChanged();
      }
    } else if (d <= r) {
      if (S.wpNear !== w.id) {
        S.wpNear = w.id;
        toast(`${wpTitle(w)}（立寄り点）に到着圏内。作業が終わったら「次へ」を押してください`, 6000);
        renderWps();
      }
    } else if (S.wpNear === w.id && d > r * 1.5) { S.wpNear = null; renderWps(); }
  }

  function wpNext() {
    const w = wpActive();
    if (!w) return;
    w.done = true; S.wpNear = null;
    const nx = navDest();
    toast(`${wpLabel(w)} 完了 → 次は ${nx ? nx.label + (nx.name ? '（' + nx.name + '）' : '') : '（なし）'}`, 3500);
    wpChanged();
  }
  function wpPrev() {
    const done = S.wps.filter((w) => w.done);
    if (!done.length) return;
    const w = done[done.length - 1];
    w.done = false; S.wpNear = null;
    toast(`${wpLabel(w)} に戻しました`);
    wpChanged();
  }
  async function wpDirect() {
    const rest = S.wps.filter((w) => !w.done);
    if (!rest.length) return;
    const ok = await confirmModal('現場へ直行しますか？', `残りの経由地（${rest.map(wpLabel).join('・')}）をとばして、現場へ直接誘導します。<br><span class="small muted">「前へ」で経由地に戻せます。</span>`, '直行する');
    if (!ok) return;
    rest.forEach((w) => { w.done = true; });
    S.wpNear = null;
    toast('現場へ直行します');
    wpChanged();
  }
  async function wpClear() {
    if (!S.wps.length) return;
    const ok = await confirmModal('経由地をすべて削除しますか？', `${S.wps.length}か所の経由地を削除します。`, '削除する');
    if (!ok) return;
    S.wps = []; S.wpNear = null;
    toast('経由地をすべて削除しました');
    wpChanged();
  }
  async function wpAction(act, id) {
    const i = S.wps.findIndex((w) => w.id === id);
    if (i < 0) return;
    const w = S.wps[i];
    if (act === 'kind') { w.kind = w.kind === 'pass' ? 'stop' : 'pass'; toast(`${wpLabel(w)} を${KIND_JA[w.kind]}にしました`); }
    else if (act === 'up' && i > 0) { S.wps.splice(i - 1, 0, S.wps.splice(i, 1)[0]); }
    else if (act === 'down' && i < S.wps.length - 1) { S.wps.splice(i + 1, 0, S.wps.splice(i, 1)[0]); }
    else if (act === 'del') {
      const ok = await confirmModal(`${wpTitle(w)} を削除しますか？`, `${Geo.formatDD(w.lat)}, ${Geo.formatDD(w.lon)}`, '削除する');
      if (!ok) return;
      S.wps.splice(i, 1);
    } else if (act === 'name') {
      const v = window.prompt(`${wpLabel(w)} の名前`, w.name || '');
      if (v == null) return;
      w.name = v.trim().slice(0, 40);
    } else if (act === 'go') {
      // この経由地から誘導し直す（手前は通過済み、以降は未通過に）
      S.wps.forEach((x, k) => { x.done = k < i; });
      S.wpNear = null;
      toast(`${wpTitle(w)} へ誘導します`);
    } else return;
    wpChanged();
  }

  function renderWps() {
    const n = S.wps.length;
    setText('wpCount', n ? `${n} / ${WP_MAX}` : '');
    const act = wpActive();
    const nav = $('wpNav');
    if (!n) {
      nav.innerHTML = '<div class="q-hint">経由地はありません。谷筋・稜線を避ける経路の指定や、揚収・ランデブーポイントへの立ち寄りに使います。</div>';
    } else {
      const near = act && S.wpNear === act.id;
      nav.innerHTML = `
        <div class="wp-now${near ? ' near' : ''}">
          <span class="muted small">誘導中</span>
          <b>${act ? esc(wpTitle(act)) : '現場' + (S.target && S.target.name ? '（' + esc(S.target.name) + '）' : '')}</b>
          ${act ? `<span class="wp-kind ${act.kind}">${KIND_JA[act.kind]}</span>` : '<span class="small muted">経由地はすべて完了</span>'}
          ${near ? '<div class="wp-near">到着圏内です。作業が終わったら「次へ ▶」を押してください</div>' : ''}
        </div>
        <div class="btn-row three">
          <button type="button" class="btn" id="wpPrevBtn" ${S.wps.some((w) => w.done) ? '' : 'disabled'}>◀ 前へ</button>
          <button type="button" class="btn btn-go" id="wpNextBtn" ${act ? '' : 'disabled'}>次へ ▶</button>
          <button type="button" class="btn" id="wpDirectBtn" ${act && S.target ? '' : 'disabled'}>現場へ直行</button>
        </div>`;
      $('wpPrevBtn').onclick = wpPrev;
      $('wpNextBtn').onclick = wpNext;
      $('wpDirectBtn').onclick = wpDirect;
    }
    const from = S.pos ? { lat: S.pos.lat, lon: S.pos.lon } : null;
    $('wpList').innerHTML = S.wps.map((w, i) => {
      const d = from ? Geo.inverse(from.lat, from.lon, w.lat, w.lon) : null;
      return `<li class="wp-item${w.done ? ' done' : ''}${w === act ? ' act' : ''}">
        <span class="wp-no ${w.kind}">${i + 1}</span>
        <button type="button" class="wp-main" data-act="name" data-id="${w.id}">
          <span class="wp-name">${esc(w.name || wpLabel(w))}</span>
          <span class="wp-sub">${w.done ? '完了　' : w === act ? '▶ 誘導中　' : ''}<span id="wpd-${w.id}">${d ? (d.distance / 1000).toFixed(1) + 'km / ' + fmtBrg(d.bearing) : Geo.formatDD(w.lat, 4) + ', ' + Geo.formatDD(w.lon, 4)}</span></span>
        </button>
        <button type="button" class="wp-kind ${w.kind}" data-act="kind" data-id="${w.id}">${KIND_JA[w.kind]}</button>
        <span class="wp-tools">
          <button type="button" class="btn-mini" data-act="go" data-id="${w.id}" title="ここへ誘導">▶</button>
          <button type="button" class="btn-mini" data-act="up" data-id="${w.id}" ${i === 0 ? 'disabled' : ''}>▲</button>
          <button type="button" class="btn-mini" data-act="down" data-id="${w.id}" ${i === n - 1 ? 'disabled' : ''}>▼</button>
          <button type="button" class="btn-mini danger" data-act="del" data-id="${w.id}">✕</button>
        </span>
      </li>`;
    }).join('') + (S.target ? `<li class="wp-item goal"><span class="wp-no goal">現</span><span class="wp-main"><span class="wp-name">現場${S.target.name ? '（' + esc(S.target.name) + '）' : ''}</span><span class="wp-sub">最終目的地</span></span></li>` : '');
    $('wpClearBtn').disabled = !n;
    $('wpAddBtn').disabled = n >= WP_MAX;
    // 立寄り点の到着圏内では、地図上に大きな「次へ」ボタンを出す（押すと消える）
    const fb = $('wpNextFloat');
    const showNext = !!(act && S.wpNear === act.id);
    fb.hidden = !showNext;
    if (showNext) fb.textContent = `次へ ▶（${wpTitle(act)} 完了）`;
  }

  function setFormMode(m) {
    S.formMode = m === 'wp' ? 'wp' : 'target';
    const wp = S.formMode === 'wp';
    $('modeTarget').classList.toggle('active', !wp);
    $('modeWp').classList.toggle('active', wp);
    $('applyBtn').textContent = wp ? '＋ 経由地として追加' : '✔ この座標で確定';
    const showCancel = wp || !!S.target;
    $('cancelEditBtn').hidden = !showCancel;
    $('formBtnRow').classList.toggle('two', showCancel);
    $('mapPickBtn').textContent = S.mapPick ? '✖ 地図での指定をやめる' : '🗺 地図をタップして指定';
  }
  function openEdit(mode) {
    S.editing = true;
    $('targetView').hidden = true;
    $('targetForm').hidden = false;
    setFormMode(mode === 'wp' ? 'wp' : 'target');
    if (mode === 'wp') $('targetForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
    renderSearch();
    updatePreview();
    focusField('latD'); // タップ操作内で直接フォーカス（iPadでキーボードを開くため）
  }
  function closeEdit() {
    S.editing = false;
    $('targetForm').hidden = true;
    $('targetView').hidden = false;
    clearDMS(); clearDD(); clearSearch();
    stopMapPick();
    S.pending = null;
    document.activeElement && document.activeElement.blur && document.activeElement.blur();
  }

  /** 入力欄 → 変換プレビュー */
  function updatePreview() {
    const pv = $('preview');
    const sel = (!dmsAnyFilled() && !ddAnyFilled()) ? S.sel : null;
    const useDD = !dmsAnyFilled() && ddAnyFilled();
    const dLat = useDD ? ddString('lat') : dmsString('lat');
    const dLon = useDD ? ddString('lon') : dmsString('lon');
    const la = dLat.str || '', lo = dLon.str || '';
    const parts = useDD ? '整数部・小数部' : '度・分・秒';
    S.pending = null;
    pv.className = 'preview';
    $('applyBtn').disabled = true;
    let r;
    try {
      if (sel) {
        r = Geo.validate(sel.lat, sel.lon, 'DD', []);
      } else if (la && lo) {
        const a = Geo.parseSingle(la, 'lat');
        const b = Geo.parseSingle(lo, 'lon');
        r = Geo.validate(a.value, b.value, a.fmt, []);
      } else if (dLat.partial || dLon.partial || la || lo) {
        const need = dLat.partial ? `緯度の${parts}` : dLon.partial ? `経度の${parts}` : (la ? '経度' : '緯度');
        pv.innerHTML = `<div class="muted">${need}を入力してください</div>`;
        return;
      } else {
        pv.innerHTML = '<div class="muted">座標を入力するか、名称で検索して選んでください</div>';
        return;
      }
    } catch (e) {
      pv.className = 'preview err';
      pv.innerHTML = `<div class="pv-err">✖ ${esc(e.message)}</div>`;
      return;
    }
    S.pending = { lat: r.lat, lon: r.lon };
    if (sel) Object.assign(S.pending, { name: sel.name || '', note: sel.note || '', pref: sel.pref || '', type: sel.type || '', src: sel.src || '' });
    const fmtName = sel ? (sel.src === '地図' ? '地図で指定' : `検索結果（${sel.src}）`) : ({ DD: '10進数', DM: '度分', DMS: '度分秒' }[r.fmt] || '');
    let extra = '';
    if (S.pos) {
      const d0 = Geo.inverse(S.pos.lat, S.pos.lon, r.lat, r.lon);
      extra += `<div class="small">自機から <b>${(d0.distance / 1000).toFixed(2)} km</b>（方位 <b>${fmtBrg(d0.bearing)}</b>）</div>`;
    }
    if (S.target) {
      const d = Geo.inverse(S.target.lat, S.target.lon, r.lat, r.lon);
      extra += `<div class="small muted">現在の現場から ${(d.distance / 1000).toFixed(2)} km（${Math.round(d.bearing)}°方向）</div>`;
    }
    pv.className = 'preview ok';
    pv.innerHTML = `
      <div class="small muted">認識形式: ${fmtName}</div>
      ${sel && sel.name ? `<div class="pv-name">${esc(sel.name)}</div>` : ''}
      ${sel && (sel.pref || sel.type) ? `<div class="small muted">${esc([sel.pref, sel.type].filter(Boolean).join('・'))}</div>` : ''}
      ${sel && sel.note ? `<div class="pv-memo">${esc(sel.note)}</div>` : ''}
      <div class="pv-dd mono">${Geo.formatDD(r.lat)}, ${Geo.formatDD(r.lon)}</div>
      <div class="pv-dms mono">${Geo.formatDMS(r.lat, true)}　${Geo.formatDMS(r.lon, false)}</div>
      <div class="small">${Geo.formatDMSJa(r.lat, true)}　${Geo.formatDMSJa(r.lon, false)}</div>
      ${r.notes.map((n) => `<div class="pv-note">${esc(n)}</div>`).join('')}
      ${extra}`;
    $('applyBtn').disabled = false;
  }

  async function applyPending() {
    const p = S.pending;
    if (!p) return;
    if (S.formMode === 'wp') {
      const no = S.wps.length + 1;
      const ok = await confirmModal(`経由地 WP${no} として追加しますか？`, `
        ${p.name ? `<div class="pv-name">${esc(p.name)}</div>` : ''}
        <div class="mono">${Geo.formatDD(p.lat)}, ${Geo.formatDD(p.lon)}</div>
        <div class="mono">${Geo.formatDMS(p.lat, true)} ${Geo.formatDMS(p.lon, false)}</div>
        <div class="small muted" style="margin-top:8px">経路の最後（現場の手前）に追加します。順番・種別（通過点／立寄り点）は経由地の一覧で変更できます。</div>`, '追加する');
      if (!ok) return;
      const w = addWaypoint(p);
      if (!w) return;
      closeEdit();
      toast(`${wpLabel(w)} を${KIND_JA[w.kind]}として追加しました`, 3500);
      return;
    }
    const ok = await confirmModal(S.target ? '現場座標を変更しますか？' : '現場座標を確定しますか？', `
      ${p.name ? `<div class="pv-name">${esc(p.name)}</div>` : ''}
      <div class="mono">${Geo.formatDD(p.lat)}, ${Geo.formatDD(p.lon)}</div>
      <div class="mono">${Geo.formatDMS(p.lat, true)} ${Geo.formatDMS(p.lon, false)}</div>
      ${S.target ? `<div class="small muted" style="margin-top:8px">変更前: ${esc(ddText(S.target))}</div>` : ''}`,
    '確定する');
    if (!ok) return;
    setTarget(p.lat, p.lon, { pushCurrent: true, meta: p });
    toast(S.history.length ? '現場座標を更新しました' : '現場座標を設定しました');
  }

  function pushHistory(t) {
    S.history = [{ lat: t.lat, lon: t.lon, setAt: t.setAt, name: t.name || '', note: t.note || '', pref: t.pref || '', type: t.type || '' }]
      .concat(S.history.filter((h) => !(Math.abs(h.lat - t.lat) < 1e-9 && Math.abs(h.lon - t.lon) < 1e-9)))
      .slice(0, HIST_MAX);
  }

  function setTarget(lat, lon, opts) {
    opts = opts || {};
    const prev = S.target;
    if (prev && opts.pushCurrent) pushHistory(prev);
    if (prev) S.old = { lat: prev.lat, lon: prev.lon };
    const m = opts.meta || {};
    S.target = { lat, lon, setAt: opts.setAt || Date.now(), elev: { status: 'loading' },
      name: m.name || '', note: m.note || '', pref: m.pref || '', type: m.type || '' };
    saveTarget();
    closeEdit();
    renderTarget();
    fetchElevation();
    updateMapObjects();
    fitBoth(true);
    scheduleRender();
  }

  async function undoTarget() {
    if (!S.history.length) return;
    const h = S.history[0];
    const ok = await confirmModal('1つ前の座標に戻しますか？', `
      ${h.name ? `<div class="pv-name">${esc(h.name)}</div>` : ''}
      <div class="mono">${esc(ddText(h))}</div><div class="mono">${esc(dmsText(h))}</div>
      ${S.target ? `<div class="small muted" style="margin-top:8px">現在: ${esc(ddText(S.target))}（破棄されます）</div>` : ''}`,
    '戻す');
    if (!ok) return;
    S.history.shift();
    setTarget(h.lat, h.lon, { pushCurrent: false, setAt: h.setAt, meta: h });
    toast('1つ前の現場座標に戻しました');
  }

  async function restoreHistory(idx) {
    const h = S.history[idx];
    if (!h) return;
    const ok = await confirmModal('この座標を現場に設定しますか？', `
      ${h.name ? `<div class="pv-name">${esc(h.name)}</div>` : ''}
      <div class="mono">${esc(ddText(h))}</div><div class="mono">${esc(dmsText(h))}</div>
      <div class="small muted" style="margin-top:8px">現在の現場は履歴に残ります</div>`, '設定する');
    if (!ok) return;
    S.history.splice(idx, 1);
    setTarget(h.lat, h.lon, { pushCurrent: true, setAt: h.setAt, meta: h });
    $('histList').hidden = true;
    toast('履歴の座標を現場に設定しました');
  }

  /* =========================================================
   * 標高（国土地理院 標高API）— 失敗してもアプリは止めない
   * ========================================================= */
  const elevKey = (lat, lon) => `${lat.toFixed(6)},${lon.toFixed(6)}`;

  async function fetchElevation() {
    const t = S.target;
    if (!t) return;
    const key = elevKey(t.lat, t.lon);
    const c = S.elevCache[key];
    if (c) { t.elev = { status: c.value == null ? 'none' : 'ok', value: c.value, src: c.src }; saveTarget(); renderElev(); updateMapObjects(); return; }
    t.elev = { status: 'loading' };
    renderElev();
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (S.target !== t) return; // 途中で現場が変更された
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = setTimeout(() => ctrl && ctrl.abort(), 8000);
      try {
        const res = await fetch(ELEV_URL(t.lat, t.lon), { signal: ctrl ? ctrl.signal : undefined, cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const j = await res.json();
        clearTimeout(timer);
        if (S.target !== t) return;
        const v = typeof j.elevation === 'number' ? j.elevation : parseFloat(j.elevation);
        if (isFinite(v)) t.elev = { status: 'ok', value: v, src: j.hsrc || '' };
        else t.elev = { status: 'none' }; // 海上・範囲外など
        S.elevCache[key] = { value: t.elev.status === 'ok' ? v : null, src: t.elev.src || '' };
        const keys = Object.keys(S.elevCache);
        if (keys.length > 50) delete S.elevCache[keys[0]];
        LS.set('elevCache', S.elevCache);
        saveTarget(); renderElev(); updateMapObjects(); scheduleRender();
        return;
      } catch (e) {
        clearTimeout(timer);
        if (attempt < 3) await sleep(1500 * attempt);
      }
    }
    if (S.target === t) { t.elev = { status: 'error' }; saveTarget(); renderElev(); }
  }

  function renderElev() {
    const t = S.target;
    const e = t && t.elev ? t.elev : null;
    $('elevRetryBtn').hidden = !(e && e.status === 'error');
    if (!t) { setText('dElev', '----'); setText('dElevFt', '----'); setText('dElevSrc', ''); return; }
    if (e.status === 'ok') {
      setText('dElev', fmtInt(e.value));
      setText('dElevFt', fmtInt(e.value * M2FT));
      setText('dElevSrc', e.src ? `（${e.src}）` : '');
    } else {
      setText('dElev', e.status === 'loading' ? '取得中' : e.status === 'none' ? '範囲外' : '失敗');
      setText('dElevFt', '----');
      setText('dElevSrc', e.status === 'error' ? '通信不可' : e.status === 'none' ? '標高データなし' : '');
    }
  }
  window.addEventListener('online', () => {
    if (S.target && S.target.elev && S.target.elev.status === 'error') fetchElevation();
  });

  /* =========================================================
   * GPS（navigator.geolocation.watchPosition）
   * ========================================================= */
  function startGPS() {
    if (!('geolocation' in navigator)) { S.gpsError = 'この端末/ブラウザは位置情報に非対応です'; renderStatus(); return; }
    if (S.gpsWatch != null) return;
    try {
      S.gpsWatch = navigator.geolocation.watchPosition(onGeo, onGeoErr, {
        enableHighAccuracy: true, maximumAge: 0, timeout: 15000,
      });
    } catch (e) { S.gpsError = '位置情報を開始できません'; }
  }
  function stopGPS() {
    if (S.gpsWatch != null) { navigator.geolocation.clearWatch(S.gpsWatch); S.gpsWatch = null; }
  }
  function onGeo(p) {
    if (S.testMode) return;
    S.gpsError = null;
    const c = p.coords;
    ingest({
      lat: c.latitude, lon: c.longitude, alt: c.altitude, acc: c.accuracy, altAcc: c.altitudeAccuracy,
      speed: c.speed, heading: c.heading, ts: p.timestamp || Date.now(), src: 'gps',
    });
  }
  function onGeoErr(e) {
    if (S.testMode) return;
    const msg = { 1: '位置情報が許可されていません', 2: '現在地を取得できません', 3: 'GPS応答待ち' }[e.code] || 'GPSエラー';
    S.gpsError = msg;
    renderStatus();
    if (e.code === 1) {
      infoModal('位置情報が許可されていません', `iPadの「設定」→「プライバシーとセキュリティ」→「位置情報サービス」をオンにし、
        <b>Safari（またはSafariのWebサイト）</b>を「使用中のみ許可」にしてください。<br>
        <span class="small muted">※GPSはHTTPS配信時のみ利用できます。屋内では「テストモード」で動作確認できます。</span>`);
    }
  }

  /** 位置データ取り込み（GPS・模擬共通） */
  function ingest(pos) {
    pos.rx = Date.now();
    const prev = S.pos;
    if (prev && prev.src === pos.src) {
      const dt = (pos.ts - prev.ts) / 1000;
      const inv = Geo.inverse(prev.lat, prev.lon, pos.lat, pos.lon);
      if (!valid(pos.speed) || pos.speed < 0) {
        if (dt > 0.3) { pos.speed = inv.distance / dt; pos.speedDerived = true; } else pos.speed = prev.speed;
      }
      if (!valid(pos.heading) && inv.distance > Math.max(3, (pos.acc || 0) * 0.5) && pos.speed > 1) {
        pos.heading = inv.bearing; pos.headingDerived = true;
      }
    }
    if (!valid(pos.heading) && S.lastHeading != null) { pos.heading = S.lastHeading; pos.headingHeld = true; }
    if (valid(pos.heading)) S.lastHeading = pos.heading;
    S.pos = pos;
    checkWp();
    scheduleRender();
  }

  /* ---------- 受信状況表示 ---------- */
  function renderStatus() {
    const pill = $('gpsPill');
    const p = S.pos;
    let cls = 'pill-gray', text = 'GPS 未取得', sub = '--:--:--';
    if (S.testMode) {
      cls = 'pill-amber'; text = 'テスト 模擬GPS';
      sub = p ? '更新 ' + hms(p.rx) : '--:--:--';
    } else if (!p) {
      if (S.gpsError) { cls = 'pill-red'; text = S.gpsError; } else { text = 'GPS 受信待ち…'; }
    } else {
      const age = (Date.now() - p.rx) / 1000;
      const acc = valid(p.acc) ? `±${fmtInt(p.acc)}m` : '';
      if (age < 3) { cls = p.acc > 50 ? 'pill-amber' : 'pill-green'; text = `GPS受信中 ${acc}${p.acc > 50 ? '（精度低）' : ''}`; }
      else if (age < 10) { cls = 'pill-amber'; text = `更新遅延 ${Math.floor(age)}秒`; }
      else { cls = 'pill-red'; text = `GPS途絶 ${Math.floor(age)}秒`; }
      sub = '最終 ' + hms(p.rx);
    }
    pill.className = 'pill ' + cls;
    setText('gpsText', text);
    setText('gpsTime', sub);
  }

  /* =========================================================
   * ダッシュボード
   * ========================================================= */
  function renderDash() {
    const p = S.pos, t = S.target;
    const stale = !p || (!S.testMode && Date.now() - p.rx > 10000);
    document.querySelector('.dash').classList.toggle('stale', stale);

    // 自機
    if (p) {
      setText('pLat', Geo.formatDD(p.lat)); setText('pLon', Geo.formatDD(p.lon));
      setText('pDMS', `${Geo.formatDMS(p.lat, true)}  ${Geo.formatDMS(p.lon, false)}  ±${valid(p.acc) ? fmtInt(p.acc) : '--'}m`);
    } else { setText('pLat', '--'); setText('pLon', '--'); setText('pDMS', '--'); }

    // 速度・進行方位
    const spd = p && valid(p.speed) ? p.speed : null;
    setText('dKt', spd != null ? fmtInt(spd * MS2KT) : '---');
    setText('dKmh', spd != null ? fmtInt(spd * MS2KMH) : '---');
    setText('dHdg', p && valid(p.heading) ? fmtBrg(p.heading) : '---');

    // 距離・方位・ETE（次の経由地 or 現場）
    const dest = navDest();
    setText('dDistLbl', dest && dest.wp ? `次の経由地 ${dest.label}${dest.name ? '（' + dest.name + '）' : ''} までの残り直線距離` : '現場までの残り直線距離');
    setText('dBrgLbl', `${dest ? dest.label : '現場'}への指示方位（真方位・北=360）`);
    setText('dEteLbl', `${dest ? dest.label : '現場'}までの到着予想（ETE）`);
    document.querySelector('.tile-dist').classList.toggle('wp-mode', !!(dest && dest.wp));
    if (p && dest) {
      const inv = Geo.inverse(p.lat, p.lon, dest.lat, dest.lon);
      const km = inv.distance / 1000;
      setText('dKm', km.toFixed(2));
      setText('dNm', (inv.distance / Geo.M_PER_NM).toFixed(2));
      const overhead = inv.distance <= OVERHEAD_M;
      setText('dBrg', overhead ? '---' : fmtBrg(inv.bearing));
      const card = Geo.cardinal(inv.bearing);
      setText('dCard', overhead ? `${dest.label}の直上` : `${card}（${CARD_JA[card]}）`);
      // 現在の進行方位（指示方位との比較用）
      setText('dRel', valid(p.heading) ? `現針路 ${fmtBrg(p.heading)}` : '');
      const fmtSec = (sec) => { const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s2 = sec % 60; return h > 0 ? `${h}:${pad2(m)}:${pad2(s2)}` : `${pad2(m)}:${pad2(s2)}`; };
      const fast = spd != null && spd >= MIN_SPEED_MS;
      if (fast) {
        const sec = Math.round(inv.distance / spd);
        setText('dEte', fmtSec(sec));
        setText('dEta', hm(Date.now() + sec * 1000));
      } else {
        setText('dEte', spd != null ? '低速' : '--:--');
        setText('dEta', '--:--');
      }
      // 経由地があるとき：現場までの合計（経由地を回った場合）
      if (dest.wp) {
        const tot = remainingTotal(p);
        const goal = S.target ? '現場まで（経由地経由）' : '最後の経由地まで';
        setText('dTotal', `${goal} 合計 ${(tot / 1000).toFixed(1)} km${fast ? ' ／ ETE ' + fmtSec(Math.round(tot / spd)) + '（' + hm(Date.now() + tot / spd * 1000) + '着）' : ''}`);
      } else setText('dTotal', '');
    } else {
      ['dKm', 'dNm'].forEach((id) => setText(id, '--.--'));
      setText('dBrg', '---'); setText('dCard', dest ? '自機位置待ち' : '現場未設定'); setText('dRel', '');
      setText('dEte', '--:--'); setText('dEta', '--:--'); setText('dTotal', '');
    }
    // 経由地一覧の距離表示（一覧は作り直さず文字だけ更新）
    if (p) S.wps.forEach((w) => {
      const el = document.getElementById('wpd-' + w.id);
      if (el) { const d = Geo.inverse(p.lat, p.lon, w.lat, w.lon); el.textContent = `${(d.distance / 1000).toFixed(1)}km / ${fmtBrg(d.bearing)}`; }
    });

    // 高度
    const alt = p && valid(p.alt) ? p.alt : null;
    setText('dAlt', alt != null ? fmtInt(alt) : '----');
    setText('dAltFt', alt != null ? fmtInt(alt * M2FT) : '----');
    setText('dAltAcc', p && valid(p.altAcc) ? fmtInt(p.altAcc) : '--');
    const ev = t && t.elev && t.elev.status === 'ok' ? t.elev.value : null;
    if (alt != null && ev != null) {
      const diff = alt - ev;
      setText('dDiff', signed(diff)); setText('dDiffFt', signed(diff * M2FT));
    } else { setText('dDiff', '----'); setText('dDiffFt', '----'); }
  }

  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      renderStatus();
      renderDash();
      updateMapObjects();
    });
  }

  /* =========================================================
   * 地図（Leaflet）
   * ========================================================= */
  let map = null, tileLayers = {}, curLayer = null;
  let tgMarker = null, oldMarker = null, routeLine = null, routeCase = null, oldLine = null;
  let planLine = null, wpLayer = null, wpSig = '';
  let simTapArmed = false, navBusy = false;

  function loadCSS(href) {
    return new Promise((res, rej) => {
      const l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = href; l.onload = res; l.onerror = () => { l.remove(); rej(); };
      document.head.appendChild(l);
    });
  }
  function loadJS(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = () => { s.remove(); rej(); };
      document.head.appendChild(s);
    });
  }
  /** Leaflet本体＋回転プラグイン（同梱版を優先、無ければCDN） */
  async function loadLeaflet() {
    let local = false;
    try { const r = await fetch(LEAFLET_LOCAL + 'leaflet.js'); local = r.ok; } catch (e) { /* 同梱なし */ }
    const base = local ? LEAFLET_LOCAL : LEAFLET_CDN;
    try { await loadCSS(base + 'leaflet.css'); } catch (e) { /* CSSのみ失敗しても続行 */ }
    await loadJS(base + 'leaflet.js');
    try { await loadJS(ROTATE_LOCAL); } catch (e) {
      try { await loadJS(ROTATE_CDN); } catch (e2) { /* 回転不可 → ノースアップのみで動作 */ }
    }
  }

  const TG_SVG = (fill) => `<svg viewBox="0 0 46 46"><circle cx="23" cy="23" r="18" fill="${fill}" stroke="#fff" stroke-width="4"/>
    <path d="M23 9 V37 M9 23 H37" stroke="#fff" stroke-width="4"/></svg>`;
  const canRotate = () => !!(map && typeof map.setBearing === 'function');

  function initMap() {
    if (!window.L) { $('mapFallback').hidden = false; return; }
    const c = S.target ? [S.target.lat, S.target.lon] : [35.68, 139.76];
    map = L.map('map', {
      zoomControl: true, attributionControl: true,
      // 回転（ヘディングアップ）用。指での回転・傾きは誤操作防止のため無効
      rotate: true, bearing: 0, rotateControl: false, touchRotate: false, touchPitch: false,
      shiftKeyRotate: false, pitchDrag: false, compassBearing: false,
    }).setView(c, S.target ? 12 : 9);
    L.control.scale({ imperial: false, maxWidth: 160 }).addTo(map);
    Object.keys(TILES).forEach((k) => { tileLayers[k] = L.tileLayer(TILES[k].url, TILES[k].opt); });
    setLayer(S.layer);
    wpLayer = L.layerGroup().addTo(map);
    buildRing();

    // ドラッグで自由にスクロール → 追従OFF（「現在位置に戻る」で復帰）
    window.__rnMap = map; // 動作確認用
    map.on('dragstart', () => { if (S.follow) setFollow(false); });
    map.on('zoomend', () => { if (S.follow && !navBusy) navView(false); });
    map.on('move zoom rotate viewreset resize', drawRing);
    map.on('click', (e) => {
      if (simTapArmed) {
        simTapArmed = false; $('mapTapHint').hidden = true;
        simPlace(e.latlng.lat, e.latlng.lng);
        toast('自機の模擬位置を配置しました');
      } else if (S.mapPick) {
        pickAt(e.latlng.lat, e.latlng.lng);
      }
    });
    setFollow(S.follow);
    setHeadUp(S.headUp);
    updateMapObjects();
    if (S.target && !S.pos) fitBoth(true);
    window.addEventListener('resize', () => setTimeout(() => { map.invalidateSize(); if (S.follow) navView(false); drawRing(); }, 200));
    // 地図の表示領域が変わったとき（テストモードの帯の表示・画面回転など）に、地図の大きさを測り直す
    if (window.ResizeObserver) {
      new ResizeObserver(() => {
        const sz = map.getSize(), el = $('map');
        if (sz.x !== el.clientWidth || sz.y !== el.clientHeight) {
          map.invalidateSize({ pan: false });
          if (S.follow) navView(false);
        }
        drawRing();
      }).observe($('map'));
    }
  }

  function setLayer(k) {
    if (!TILES[k]) k = 'std';
    S.layer = k; LS.set('layer', k);
    document.querySelectorAll('.seg').forEach((b) => b.classList.toggle('active', b.dataset.layer === k));
    if (!map) return;
    if (curLayer) map.removeLayer(curLayer);
    curLayer = tileLayers[k].addTo(map);
  }

  function updateMapObjects() {
    if (!map) return;
    const t = S.target, p = S.pos;

    // 現場マーカー
    if (t) {
      const ll = [t.lat, t.lon];
      const label = (t.name || '現場') + (t.elev && t.elev.status === 'ok' ? ` ${fmtInt(t.elev.value)}m` : '');
      if (!tgMarker) {
        tgMarker = L.marker(ll, {
          icon: L.divIcon({ className: 'tg-icon', html: TG_SVG('#ff2a2a'), iconSize: [46, 46], iconAnchor: [23, 23] }),
          zIndexOffset: 500, keyboard: false,
        }).addTo(map).bindTooltip(label, { permanent: true, direction: 'right', offset: [22, 0], className: 'map-label' });
      } else {
        tgMarker.setLatLng(ll);
        tgMarker.setTooltipContent(label);
      }
    } else if (tgMarker) { map.removeLayer(tgMarker); tgMarker = null; }

    // 旧現場（灰色・破線）
    const showOld = S.showOld && S.old && t && !(S.old.lat === t.lat && S.old.lon === t.lon);
    if (showOld) {
      const oll = [S.old.lat, S.old.lon];
      if (!oldMarker) {
        oldMarker = L.marker(oll, {
          icon: L.divIcon({ className: 'tg-icon old-icon', html: TG_SVG('#7d8794'), iconSize: [46, 46], iconAnchor: [23, 23] }),
          zIndexOffset: 100, keyboard: false, interactive: false,
        }).addTo(map).bindTooltip('旧現場', { permanent: true, direction: 'left', offset: [-22, 0], className: 'map-label' });
        oldLine = L.polyline([oll, [t.lat, t.lon]], { color: '#9aa8b8', weight: 4, dashArray: '10 10', opacity: 0.9, interactive: false }).addTo(map);
      } else {
        oldMarker.setLatLng(oll);
        oldLine.setLatLngs([oll, [t.lat, t.lon]]);
      }
    } else if (oldMarker) {
      map.removeLayer(oldMarker); map.removeLayer(oldLine); oldMarker = oldLine = null;
    }

    // 直線ルート（測地線・赤）：自機 → 次の目的地（経由地 or 現場）
    const dest = navDest();
    if (p && dest) {
      const pts = Geo.greatCirclePoints(p.lat, p.lon, dest.lat, dest.lon, 48);
      if (!routeLine) {
        routeCase = L.polyline(pts, { color: '#ffffff', weight: 10, opacity: 0.55, interactive: false }).addTo(map);
        routeLine = L.polyline(pts, { color: '#ff2a2a', weight: 5, opacity: 0.95, interactive: false }).addTo(map);
      } else { routeCase.setLatLngs(pts); routeLine.setLatLngs(pts); }
    } else if (routeLine) { map.removeLayer(routeLine); map.removeLayer(routeCase); routeLine = routeCase = null; }

    // その先の予定経路（次の目的地 → … → 現場）：赤の破線
    const rest = remainingRoute();
    if (rest.length >= 2) {
      if (!planLine) planLine = L.polyline(rest, { color: '#ff2a2a', weight: 3, opacity: 0.85, dashArray: '10 8', interactive: false }).addTo(map);
      else planLine.setLatLngs(rest);
    } else if (planLine) { map.removeLayer(planLine); planLine = null; }

    // 経由地マーカー（番号付き：青=通過点、橙=立寄り点、灰=完了）
    const act = wpActive();
    const sig = JSON.stringify(S.wps.map((w) => [w.id, w.lat, w.lon, w.kind, w.done, w.name, w === act]));
    if (sig !== wpSig) {
      wpSig = sig;
      wpLayer.clearLayers();
      S.wps.forEach((w, i) => {
        const cls = `wp-ic ${w.kind}${w.done ? ' done' : ''}${w === act ? ' act' : ''}`;
        const m = L.marker([w.lat, w.lon], {
          icon: L.divIcon({ className: 'wp-icon', html: `<div class="${cls}">${i + 1}</div>`, iconSize: [36, 36], iconAnchor: [18, 18] }),
          zIndexOffset: w === act ? 700 : 300, keyboard: false, interactive: false,
        });
        m.bindTooltip(`WP${i + 1}${w.name ? ' ' + esc(w.name) : ''}${w.kind === 'stop' ? '（立寄り）' : ''}`,
          { permanent: true, direction: 'right', offset: [18, 0], className: 'map-label' + (w.done ? ' map-label-done' : '') });
        wpLayer.addLayer(m);
      });
    }

    // ナビ表示（自機を画面中央より少し下に固定）
    if (S.follow && p) navView(true);
    $('recenterBtn').hidden = S.follow || !p;
    drawRing();
  }

  /* ---------- ナビ表示：自機を中央やや下に置き、必要なら機首方向を上に ---------- */
  const AC_Y = 0.64; // 自機の画面上の縦位置（上端0〜下端1）

  /** 画面上で「北」が向いている角度（上=0°、時計回り） */
  function screenNorthAngle(lat, lon) {
    const a = map.latLngToContainerPoint([lat, lon]);
    const b = map.latLngToContainerPoint([lat + 0.01, lon]);
    return Geo.norm360(Geo.toDeg(Math.atan2(b.x - a.x, -(b.y - a.y))));
  }

  function navView(animate) {
    const p = S.pos;
    if (!map || !p) return;
    navBusy = true;
    try {
      if (canRotate()) {
        if (S.headUp) {
          if (valid(p.heading) && valid(p.speed) && p.speed >= MIN_SPEED_MS) S.mapHdg = p.heading;
          const want = -(S.mapHdg || 0);
          const diff = Math.abs(((map.getBearing() - want) % 360 + 540) % 360 - 180);
          if (diff > 0.5) map.setBearing(want);
        } else if (map.getBearing() !== 0) map.setBearing(0);
      }
      const z = map.getZoom();
      const size = map.getSize();
      const dy = size.y * (AC_Y - 0.5);
      // 画面の「上」方向に当たる真方位
      const upBrg = Geo.toRad(-screenNorthAngle(p.lat, p.lon));
      const ac = map.project([p.lat, p.lon], z);
      const ctr = map.unproject(L.point(ac.x + dy * Math.sin(upBrg), ac.y - dy * Math.cos(upBrg)), z);
      const cur = map.getCenter();
      if (Math.abs(cur.lat - ctr.lat) > 1e-7 || Math.abs(cur.lng - ctr.lng) > 1e-7) {
        map.setView(ctr, z, { animate: !!animate, duration: 0.6, noMoveStart: true });
      }
    } finally { navBusy = false; }
  }

  function setFollow(on) {
    S.follow = on; LS.set('follow', on);
    $('recenterBtn').hidden = on || !S.pos;
    if (on && map && S.pos) {
      if (map.getZoom() < 11) map.setZoom(12, { animate: false });
      navView(false);
    }
    if (map) {
      // 追従中のピンチ／ホイールズームは自機基準（画面中心）で行う
      map.options.touchZoom = on ? 'center' : true;
      map.options.scrollWheelZoom = on ? 'center' : true;
    }
  }

  function setHeadUp(on) {
    S.headUp = on; LS.set('headUp', on);
    const b = $('headBtn');
    b.textContent = on ? '機首方向が上' : '北が上';
    b.classList.toggle('on', on);
    if (!map) return;
    if (!on && canRotate()) map.setBearing(0);
    if (S.follow) navView(false);
    drawRing();
  }

  function setShowOld(on) {
    S.showOld = on; LS.set('showOld', on);
    const b = $('oldBtn');
    b.textContent = on ? '旧現場 表示 ON' : '旧現場 表示 OFF';
    b.classList.toggle('on', on);
    updateMapObjects();
  }

  function fitBoth(silent) {
    if (!map) return;
    const p = S.pos, t = S.target;
    if (p && t) {
      if (S.follow && !silent) setFollow(false);
      map.fitBounds(L.latLngBounds([[p.lat, p.lon], [t.lat, t.lon]]), { padding: [80, 80], maxZoom: 15 });
    } else if (t) map.setView([t.lat, t.lon], 13);
    else if (p) map.setView([p.lat, p.lon], 12);
    else if (!silent) toast('自機位置・現場座標がありません');
  }

  /* ---------- 方位リング（自機中心・10°ごとに数字、北=360） ---------- */
  const SVGNS = 'http://www.w3.org/2000/svg';
  const ring = { ticks: [], labels: [] };
  function svgEl(tag, attrs, parent) {
    const e = document.createElementNS(SVGNS, tag);
    Object.keys(attrs || {}).forEach((k) => e.setAttribute(k, attrs[k]));
    if (parent) parent.appendChild(e);
    return e;
  }
  function buildRing() {
    const svg = $('navRing');
    svg.innerHTML = '';
    ring.circle = svgEl('circle', { class: 'rg-circle' }, svg);
    for (let b = 0; b < 360; b += 5) ring.ticks.push({ b, el: svgEl('line', { class: b % 10 === 0 ? 'rg-tick rg-tick10' : 'rg-tick' }, svg) });
    for (let b = 30; b <= 360; b += 30) { // 数字は30°ごと（目盛りは5°/10°ごと）
      const major = b % 90 === 0;
      const el = svgEl('text', { class: major ? 'rg-lbl rg-major' : 'rg-lbl', 'text-anchor': 'middle', 'dominant-baseline': 'central' }, svg);
      el.textContent = String(b);
      ring.labels.push({ b, el });
    }
    ring.hdgLine = svgEl('line', { class: 'rg-hdg' }, svg);
    ring.tgtBug = svgEl('path', { class: 'rg-bug' }, svg);
    ring.tgtBox = svgEl('g', { class: 'rg-box' }, svg);
    ring.tgtRect = svgEl('rect', { rx: 8, ry: 8 }, ring.tgtBox);
    ring.tgtText = svgEl('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central' }, ring.tgtBox);
    ring.ac = svgEl('path', { class: 'rg-ac', d: 'M0 -24 L17 20 L0 10 L-17 20 Z' }, svg);
    ring.acDot = svgEl('circle', { class: 'rg-ac', r: 12 }, svg);
  }

  function drawRing() {
    const svg = $('navRing');
    const p = S.pos;
    if (!map || !p || !ring.circle) { svg.style.display = 'none'; return; }
    const size = map.getSize();
    const c = map.latLngToContainerPoint([p.lat, p.lon]);
    const R = Math.max(90, Math.min(size.x * 0.30, size.y * (1 - AC_Y) - 12, size.y * 0.36, 250));
    if (c.x < -R || c.y < -R || c.x > size.x + R || c.y > size.y + R) { svg.style.display = 'none'; return; }
    svg.style.display = '';
    svg.setAttribute('viewBox', `0 0 ${size.x} ${size.y}`);
    const north = screenNorthAngle(p.lat, p.lon);
    const pt = (b, r) => { const a = Geo.toRad(north + b); return [c.x + r * Math.sin(a), c.y - r * Math.cos(a)]; };
    const set = (el, o) => Object.keys(o).forEach((k) => el.setAttribute(k, o[k]));

    set(ring.circle, { cx: c.x, cy: c.y, r: R });
    ring.ticks.forEach(({ b, el }) => {
      const [x1, y1] = pt(b, R), [x2, y2] = pt(b, R - (b % 10 === 0 ? 14 : 8));
      set(el, { x1, y1, x2, y2 });
    });
    const fs = R < 150 ? 16 : R < 190 ? 18 : 20;
    ring.labels.forEach(({ b, el }) => {
      const [x, y] = pt(b, R - 14 - fs);
      set(el, { x, y, 'font-size': b % 90 === 0 ? fs + 4 : fs });
    });

    // 自機（進行方位の矢印）と進行方位線
    const stale = !S.testMode && Date.now() - p.rx > 10000;
    const hasHdg = valid(p.heading);
    svg.classList.toggle('rg-stale', stale);
    ring.ac.style.display = hasHdg ? '' : 'none';
    ring.acDot.style.display = hasHdg ? 'none' : '';
    set(ring.acDot, { cx: c.x, cy: c.y });
    if (hasHdg) {
      ring.ac.setAttribute('transform', `translate(${c.x} ${c.y}) rotate(${north + p.heading})`);
      const [x1, y1] = pt(p.heading, 26), [x2, y2] = pt(p.heading, R);
      set(ring.hdgLine, { x1, y1, x2, y2 });
      ring.hdgLine.style.display = '';
    } else ring.hdgLine.style.display = 'none';

    // 次の目的地（経由地 or 現場）の方位マーク（リング外側の赤三角）と数値
    const t = navDest();
    if (t) {
      const inv = Geo.inverse(p.lat, p.lon, t.lat, t.lon);
      // 真上（10m以内）では方位が定まらないため、直前の方位に三角を残し、札は「直上」と表示
      const overhead = inv.distance <= OVERHEAD_M;
      if (!overhead || ring.lastBrg == null) ring.lastBrg = inv.bearing;
      inv.bearing = ring.lastBrg;
      const a = north + inv.bearing;
      ring.tgtBug.setAttribute('d', 'M0 2 L-13 -20 L13 -20 Z');
      ring.tgtBug.setAttribute('transform', `translate(${pt(inv.bearing, R)[0]} ${pt(inv.bearing, R)[1]}) rotate(${a}) translate(0 -2)`);
      const [bx, by] = pt(inv.bearing, R + 40);
      const label = overhead ? `${t.label} 直上` : `${t.label} ${fmtBrg(inv.bearing)}`;
      const w = Math.max(118, label.length * 15 + 20), h = 36;
      set(ring.tgtRect, { x: bx - w / 2, y: by - h / 2, width: w, height: h });
      set(ring.tgtText, { x: bx, y: by + 1 });
      ring.tgtText.textContent = label;
      ring.tgtBox.classList.toggle('wp', !!t.wp);
      ring.tgtBug.style.display = ring.tgtBox.style.display = '';
    } else ring.tgtBug.style.display = ring.tgtBox.style.display = 'none';
  }

  /* ---------- 地図タイルの事前保存（オフライン用） ---------- */
  const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
  const lat2y = (lat, z) => {
    const r = Geo.toRad(lat);
    return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
  };
  function tileUrl(tpl, z, x, y) { return tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y); }

  async function cacheTiles() {
    const t = S.target;
    if (!t) { toast('先に現場座標を設定してください'); return; }
    // 地理院 標準地図と航空写真の両方を保存（OSMは利用規約により一括保存しない）
    const LAYERS = [['std', '地理院 標準地図'], ['photo', '航空写真']];
    const set = new Set();
    // 現場周辺 半径約3km（z10〜16）
    const dLat = 3 / 111.32, dLon = 3 / (111.32 * Math.cos(Geo.toRad(t.lat)));
    for (let z = 10; z <= 16; z++) {
      const x0 = lon2x(t.lon - dLon, z), x1 = lon2x(t.lon + dLon, z);
      const y0 = lat2y(t.lat + dLat, z), y1 = lat2y(t.lat - dLat, z);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) set.add(`${z}/${x}/${y}`);
    }
    // 自機→経由地→現場のルート沿い（z9〜13）
    const legs = (S.pos ? [[S.pos.lat, S.pos.lon]] : []).concat(remainingRoute());
    for (let k = 1; k < legs.length; k++) {
      const pts = Geo.greatCirclePoints(legs[k - 1][0], legs[k - 1][1], legs[k][0], legs[k][1], 60);
      for (let z = 9; z <= 13; z++) {
        pts.forEach(([la, lo]) => {
          const x = lon2x(lo, z), y = lat2y(la, z);
          for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) set.add(`${z}/${x + dx}/${y + dy}`);
        });
      }
    }
    // 経由地の周辺 半径約1km（z13〜16）
    S.wps.filter((w) => !w.done).forEach((w) => {
      const a = 1 / 111.32, b = 1 / (111.32 * Math.cos(Geo.toRad(w.lat)));
      for (let z = 13; z <= 16; z++) {
        for (let x = lon2x(w.lon - b, z); x <= lon2x(w.lon + b, z); x++)
          for (let y = lat2y(w.lat + a, z); y <= lat2y(w.lat - a, z); y++) set.add(`${z}/${x}/${y}`);
      }
    });
    const tiles = Array.from(set);
    const list = [];
    LAYERS.forEach(([k]) => tiles.forEach((zxy) => list.push(k + '/' + zxy)));
    const ok = await confirmModal('地図を端末に保存しますか？', `
      「${LAYERS.map((l) => l[1]).join('」と「')}」の両方を、現場周辺（半径約3km）${S.wps.some((w) => !w.done) ? '・経由地の周辺' : ''}${S.pos ? '・現在地からのルート沿い' : ''}について
      <b>${list.length}枚</b>（各${tiles.length}枚）保存します。<br>
      <span class="small muted">通信が安定している地上で実行してください。保存した地図は、アプリを終了すると削除されます。</span>`, '保存開始');
    if (!ok) return;
    const btn = $('cacheBtn');
    btn.disabled = true;
    const total = list.length;
    let done = 0, fail = 0;
    const worker = async () => {
      while (list.length) {
        const [k, z, x, y] = list.shift().split('/');
        try { await fetch(tileUrl(TILES[k].url, z, x, y), { mode: 'no-cors' }); } catch (e) { fail++; }
        done++;
        if (done % 5 === 0) btn.textContent = `保存中… ${done} / ${total}`;
      }
    };
    await Promise.all([1, 2, 3, 4, 5, 6].map(worker));
    btn.disabled = false;
    btn.textContent = '現場周辺の地図を保存';
    LS.set('tilesSavedAt', Date.now());
    toast(fail ? `保存完了（${done - fail}枚成功・${fail}枚失敗）` : `地図 ${done}枚（標準地図・航空写真）を保存しました`, 3500);
  }

  /* =========================================================
   * 保存した地図データの削除（アプリ終了時）
   *   iPadはホーム画面アプリの終了を確実には通知しないため、
   *   ① 終了の通知（pagehide）が来たらその場で削除
   *   ② 次回起動時、前回の使用から2時間以上たっていれば削除
   *   （飛行中にiPadが裏でアプリを閉じて再起動した場合に、地図が消えないようにするため）
   * ========================================================= */
  const TILE_CACHE_NAME = 'rescue-nav-tiles';
  const RESTART_KEEP_MS = 2 * 60 * 60 * 1000;
  function clearSavedTiles() {
    try { if ('caches' in window) return caches.delete(TILE_CACHE_NAME); } catch (e) { /* 無視 */ }
    return Promise.resolve(false);
  }
  function setupTileCleanup() {
    const last = LS.get('alive', 0);
    let fresh = true;
    try { fresh = !sessionStorage.getItem('rn_session'); sessionStorage.setItem('rn_session', '1'); } catch (e) { /* 無視 */ }
    if (fresh && Date.now() - last > RESTART_KEEP_MS) clearSavedTiles();
    const beat = () => LS.set('alive', Date.now());
    beat();
    setInterval(() => { if (document.visibilityState === 'visible') beat(); }, 30000);
    document.addEventListener('visibilitychange', beat);
    window.addEventListener('pagehide', (e) => { if (!e.persisted) clearSavedTiles(); });
  }

  /* =========================================================
   * テストモード（手動座標指定・模擬移動）
   * ========================================================= */
  const sim = { lat: null, lon: null, hdg: 45, running: false, timer: null, home: null, wpSnap: null };

  function simEmit(speedMs) {
    ingest({
      lat: sim.lat, lon: sim.lon, alt: parseFloat($('simAlt').value) || 0,
      acc: 4 + Math.random() * 4, altAcc: 10, speed: speedMs, heading: sim.hdg, ts: Date.now(), src: 'sim',
    });
  }
  function simPlace(lat, lon) {
    sim.lat = lat; sim.lon = lon;
    sim.home = { lat, lon }; // 「最初からやり直す」で戻る開始位置
    if (S.target) sim.hdg = Geo.inverse(lat, lon, S.target.lat, S.target.lon).bearing;
    $('simStart').value = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
    simEmit(0);
  }
  function simTick() {
    if (sim.lat == null) return;
    if (!sim.running) { simEmit(0); return; }
    let ms = (parseFloat($('simSpeed').value) || 0) / MS2KT;
    const t = navDest(); // 次の経由地 → 現場の順に自動飛行
    if ($('simAuto').checked && t) {
      const inv = Geo.inverse(sim.lat, sim.lon, t.lat, t.lon);
      if (inv.distance <= Math.max(ms, 1)) {
        sim.lat = t.lat; sim.lon = t.lon;
        if (t.wp && t.wp.kind === 'pass') { simEmit(ms); return; } // 通過点はそのまま次へ
        simStop(); simEmit(0);
        toast(t.wp ? `${t.label}（立寄り点）上空に到着しました（模擬）` : '現場上空に到着しました（模擬）');
        return;
      }
      sim.hdg = inv.bearing;
    } else {
      sim.hdg = Geo.norm360(parseFloat($('simHdg').value) || 0);
    }
    const d = Geo.destination(sim.lat, sim.lon, sim.hdg, ms);
    sim.lat = d.lat; sim.lon = d.lon;
    simEmit(ms);
  }
  function simStart() {
    if (sim.lat == null) { toast('先に自機の開始位置を配置してください'); return; }
    sim.running = true;
    $('simRunBtn').textContent = '▶ 模擬移動中…';
  }
  function simStop() {
    sim.running = false;
    $('simRunBtn').textContent = '▶ 模擬移動 開始';
  }
  function simAutoStart() {
    const t = S.target;
    if (!t) { toast('先に現場座標を設定してください'); return; }
    const d = Geo.destination(t.lat, t.lon, 225, 20000);
    simPlace(d.lat, d.lon);
    fitBoth(true);
  }

  function enterTest() {
    S.testMode = true;
    stopGPS();
    const last = S.pos;
    S.pos = null;
    $('testPanel').hidden = false;
    $('testBanner').hidden = false;
    $('testBtn').classList.add('pill-on');
    $('testBtn').textContent = 'テストモード 終了';
    // テスト開始時の経由地の通過状況を記録（終了時・やり直し時に元へ戻す）
    sim.wpSnap = S.wps.map((w) => [w.id, w.done]);
    // 毎回まっさらな状態から開始：実GPSの位置 → なければ現場から20km南西
    sim.lat = sim.lon = null; sim.home = null; sim.hdg = 45;
    $('simStart').value = '';
    if (last) simPlace(last.lat, last.lon);
    else if (S.target) simAutoStart();
    clearInterval(sim.timer);
    sim.timer = setInterval(simTick, 1000);
    $('testPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    scheduleRender();
  }
  /** テスト中に変わった経由地の通過状況を、テスト開始時の状態に戻す */
  function restoreWpSnap() {
    if (!sim.wpSnap) return false;
    const snap = new Map(sim.wpSnap);
    let changed = false;
    S.wps.forEach((w) => {
      const v = snap.has(w.id) ? snap.get(w.id) : false;
      if (w.done !== v) { w.done = v; changed = true; }
    });
    S.wpNear = null;
    if (changed) wpChanged();
    return changed;
  }
  /** 「最初からやり直す」：停止 → 経由地を元に戻す → 開始位置へ */
  function simReset() {
    simStop();
    restoreWpSnap();
    S.pos = null; S.lastHeading = null;
    if (sim.home) simPlace(sim.home.lat, sim.home.lon);
    else if (S.target) simAutoStart();
    if (S.follow) navView(false); else setFollow(true);
    toast('テストを最初の状態に戻しました');
  }
  function exitTest() {
    simStop();
    clearInterval(sim.timer); sim.timer = null;
    const wpRestored = restoreWpSnap();
    sim.wpSnap = null;
    sim.lat = sim.lon = null; sim.home = null; // 模擬位置をクリア
    $('simStart').value = '';
    simTapArmed = false; $('mapTapHint').hidden = true;
    S.testMode = false;
    S.pos = null; S.lastHeading = null;
    $('testPanel').hidden = true;
    $('testBanner').hidden = true;
    $('testBtn').classList.remove('pill-on');
    $('testBtn').textContent = 'テストモード';
    startGPS();
    toast(wpRestored ? '実GPSに戻しました（経由地の通過状況もテスト前に戻しました）' : '実GPSに戻しました', 3500);
    scheduleRender();
  }

  /* =========================================================
   * 画面スリープ防止（Screen Wake Lock API ＋ フォールバック）
   * ========================================================= */
  let wakeLock = null, wakeMode = 'off';
  async function enableWake() {
    if ('wakeLock' in navigator && navigator.wakeLock && navigator.wakeLock.request) {
      try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeMode = 'api';
        wakeLock.addEventListener('release', () => { wakeLock = null; if (wakeMode === 'api') { wakeMode = 'off'; renderWake(); } });
        renderWake();
        return true;
      } catch (e) { /* 非対応・拒否 → 動画方式へ */ }
    }
    try {
      const v = $('noSleepVideo');
      if (v && v.play) { await v.play(); wakeMode = 'video'; renderWake(); return true; }
    } catch (e) { /* 自動再生不可 */ }
    wakeMode = 'off'; renderWake();
    return false;
  }
  function renderWake() {
    const b = $('wakeBtn');
    b.className = 'pill ' + (wakeMode === 'off' ? 'pill-red' : 'pill-green');
    setText('wakeText', wakeMode === 'off' ? '画面ON維持 無効（タップ）' : '画面ON維持 有効');
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      enableWake();
      if (!S.testMode && S.gpsWatch == null) startGPS();
      scheduleRender();
    }
  });
  // iOSではユーザー操作が必要な場合があるため、最初のタップで再取得
  const firstTouch = () => { if (wakeMode === 'off') enableWake(); };
  document.addEventListener('pointerdown', firstTouch, { passive: true });

  /* =========================================================
   * その他：コピー・Googleマップ・テーマ
   * ========================================================= */
  /**
   * Googleマップを開く
   *  ホーム画面アプリ（PWA）から https のリンクを開くと、アプリ内ブラウザ（左上に×）が残ってしまうため、
   *  Googleマップ「アプリ」を専用URL（comgooglemaps://）で直接起動する。
   *  アプリが入っていない場合は、Appleマップ（maps://）で開くか確認する。
   */
  function openGoogleMaps() {
    const t = S.target;
    if (!t) return;
    const ll = `${t.lat.toFixed(6)},${t.lon.toFixed(6)}`;
    const appUrl = `comgooglemaps://?q=${ll}&center=${ll}&zoom=15`;
    const isApple = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (!isApple) { // PCでの確認用：通常のタブで開く
      window.open(`https://www.google.com/maps/search/?api=1&query=${ll}`, '_blank');
      return;
    }
    let left = false;
    const mark = () => { left = true; };
    document.addEventListener('visibilitychange', mark);
    window.addEventListener('pagehide', mark);
    window.addEventListener('blur', mark);
    location.href = appUrl;
    setTimeout(async () => {
      document.removeEventListener('visibilitychange', mark);
      window.removeEventListener('pagehide', mark);
      window.removeEventListener('blur', mark);
      if (left || document.visibilityState !== 'visible') return; // アプリが開いた
      const ok = await confirmModal('Googleマップアプリを開けませんでした',
        'このiPadにGoogleマップアプリが入っていない可能性があります。<br>代わりに<b>Appleマップ</b>で現場を開きますか？', 'Appleマップで開く');
      if (ok) {
        const name = encodeURIComponent(t.name || '現場');
        location.href = `maps://?ll=${ll}&q=${name}`;
      }
    }, 2000);
  }
  function applyTheme(th) {
    S.theme = th; LS.set('theme', th);
    document.documentElement.dataset.theme = th;
    document.querySelector('meta[name="theme-color"]').setAttribute('content', th === 'dark' ? '#0b0f14' : '#e9edf2');
    $('themeBtn').textContent = th === 'dark' ? '☀ 昼表示' : '☾ 夜表示';
  }

  /* =========================================================
   * イベント登録
   * ========================================================= */
  function bind() {
    $('editBtn').onclick = () => openEdit('target');
    $('modeTarget').onclick = () => setFormMode('target');
    $('modeWp').onclick = () => setFormMode('wp');
    $('wpAddBtn').onclick = () => openEdit('wp');
    $('wpClearBtn').onclick = wpClear;
    $('wpNextFloat').onclick = wpNext;
    $('wpList').addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (b && !b.disabled) wpAction(b.dataset.act, b.dataset.id);
    });
    $('wpRadius').value = String(S.wpRadius);
    $('wpRadius').addEventListener('change', (e) => {
      S.wpRadius = parseFloat(e.target.value) || 0.5; LS.set('wpRadius', S.wpRadius);
      toast(`通過判定を ${S.wpRadius} km にしました`);
    });
    $('cancelEditBtn').onclick = closeEdit;
    $('clearInputBtn').onclick = () => { clearDMS(); clearDD(); clearSearch(); updatePreview(); focusField('latD'); };
    $('targetForm').addEventListener('submit', (e) => { e.preventDefault(); applyPending(); });
    DMS_ORDER.forEach((id) => {
      $(id).addEventListener('input', onDMSInput);
      $(id).addEventListener('keydown', onDMSKeydown);
      $(id).addEventListener('focus', (e) => { try { e.target.select(); } catch (x) { /* 無視 */ } });
    });
    DD_ORDER.forEach((id) => {
      $(id).addEventListener('input', onDDInput);
      $(id).addEventListener('keydown', onDMSKeydown);
      $(id).addEventListener('focus', (e) => { try { e.target.select(); } catch (x) { /* 無視 */ } });
    });
    $('hemiLatDD').onclick = () => { setHemi('hemiLatDD', $('hemiLatDD').dataset.v === 'N' ? 'S' : 'N'); updatePreview(); };
    $('hemiLonDD').onclick = () => { setHemi('hemiLonDD', $('hemiLonDD').dataset.v === 'E' ? 'W' : 'E'); updatePreview(); };
    $('hemiLat').onclick = () => { setHemi('hemiLat', $('hemiLat').dataset.v === 'N' ? 'S' : 'N'); updatePreview(); };
    $('hemiLon').onclick = () => { setHemi('hemiLon', $('hemiLon').dataset.v === 'E' ? 'W' : 'E'); updatePreview(); };

    // 名称検索
    $('q').addEventListener('input', () => {
      clearSel(); updatePreview();
      clearTimeout(qTimer); qTimer = setTimeout(renderSearch, 120);
    });
    $('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); gsiSearch($('q').value); } });
    $('qBtn').onclick = () => gsiSearch($('q').value);
    $('qResults').addEventListener('click', (e) => {
      const b = e.target.closest('.q-item');
      if (b) selectItem(parseInt(b.dataset.i, 10));
    });
    // 登録地点
    $('mapPickBtn').onclick = startMapPick;
    $('ptsLoadBtn').onclick = () => $('ptsFile').click();
    $('ptsFile').addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; importPts(f); });
    $('ptsUndoBtn').onclick = undoPts;
    $('ptsExportBtn').onclick = exportPts;
    $('ptsTplBtn').onclick = downloadTemplate;

    $('undoBtn').onclick = undoTarget;
    $('histBtn').onclick = () => { $('histList').hidden = !$('histList').hidden; };
    $('histList').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-idx]');
      if (b) restoreHistory(parseInt(b.dataset.idx, 10));
    });
    $('gmapBtn').onclick = openGoogleMaps;
    $('elevRetryBtn').onclick = () => { if (S.target) { delete S.elevCache[elevKey(S.target.lat, S.target.lon)]; fetchElevation(); } };

    $('recenterBtn').onclick = () => setFollow(true);
    $('headBtn').onclick = () => setHeadUp(!S.headUp);
    $('fitBtn').onclick = () => fitBoth(false);
    $('oldBtn').onclick = () => setShowOld(!S.showOld);
    $('cacheBtn').onclick = cacheTiles;
    document.querySelectorAll('.seg').forEach((b) => { b.onclick = () => setLayer(b.dataset.layer); });

    $('testBtn').onclick = () => (S.testMode ? exitTest() : enterTest());
    $('themeBtn').onclick = () => applyTheme(S.theme === 'dark' ? 'light' : 'dark');
    $('wakeBtn').onclick = async () => {
      const ok = await enableWake();
      if (ok) toast(wakeMode === 'api' ? '画面ON維持：有効（Wake Lock）' : '画面ON維持：有効（互換方式）');
      else infoModal('画面ON維持を有効にできません', 'この環境ではスリープ防止に非対応です。<br>iPadの「設定」→「画面表示と明るさ」→「自動ロック」を<b>「なし」</b>にしてください。');
    };

    $('simSetStartBtn').onclick = () => {
      try { const r = Geo.parsePair($('simStart').value); simPlace(r.lat, r.lon); fitBoth(true); toast('自機の模擬位置を配置しました'); }
      catch (e) { toast('座標エラー：' + e.message, 3500); }
    };
    $('simTapBtn').onclick = () => {
      if (!map) { toast('地図が利用できません。座標入力で配置してください'); return; }
      simTapArmed = true;
      $('mapTapHint').textContent = '地図をタップして自機の位置を指定';
      $('mapTapHint').hidden = false;
    };
    $('simRunBtn').onclick = simStart;
    $('simStopBtn').onclick = simStop;
    $('simResetBtn').onclick = simReset;
  }

  /* =========================================================
   * 起動
   * ========================================================= */
  function boot() {
    applyTheme(S.theme);
    bind();
    setFollow(S.follow);
    setHeadUp(S.headUp);
    setShowOld(S.showOld);
    setLayer(S.layer);
    renderTarget();
    renderPts();
    renderWps();
    if (!S.target) openEdit();
    else if (!S.target.elev || S.target.elev.status !== 'ok') fetchElevation();

    setupTileCleanup();
    startGPS();
    enableWake();
    setInterval(() => { renderStatus(); renderDash(); }, 1000);
    scheduleRender();

    loadLeaflet().then(initMap).catch(() => { $('mapFallback').hidden = false; });

    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('service-worker.js').then((reg) => {
        reg.addEventListener('updatefound', () => {
          const nw = reg.installing;
          nw && nw.addEventListener('statechange', () => {
            if (nw.state === 'installed' && navigator.serviceWorker.controller) {
              toast('新しいバージョンがあります。アプリを再起動すると反映されます', 5000);
            }
          });
        });
      }).catch(() => { /* SW登録失敗でもアプリは動作 */ });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
