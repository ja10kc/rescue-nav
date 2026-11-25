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
  const LEAFLET_LOCAL = './';
  const LEAFLET_CDN = 'https://unpkg.com/leaflet@1.9.4/dist/';
  const ROTATE_LOCAL = 'leaflet-rotate.js';
  const ROTATE_CDN = 'https://unpkg.com/leaflet-rotate@0.6.2/dist/leaflet-rotate.js';

  /* ---------- 保存 ---------- */
  const LS = {
    get(k, d) { try { const v = localStorage.getItem('rn_' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('rn_' + k, JSON.stringify(v)); } catch (e) { /* 容量超過等は無視 */ } },
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
    } else {
      setText('targetSetAt', '');
    }
    ['gmapBtn', 'copyDDBtn', 'copyDMSBtn'].forEach((id) => { $(id).disabled = !t; });
    $('undoBtn').disabled = S.history.length === 0;
    $('histBtn').disabled = S.history.length === 0;
    setText('histCount', S.history.length);
    $('editBtn').textContent = t ? '✎ 現場座標を変更（再入力）' : '✎ 現場座標を入力';
    renderHistory();
    renderElev();
  }

  function renderHistory() {
    const ul = $('histList');
    if (S.history.length === 0) { ul.hidden = true; ul.innerHTML = ''; return; }
    ul.innerHTML = S.history.map((h, i) => `
      <li><button type="button" data-idx="${i}">
        <span class="h-time">${i === 0 ? '直前 ' : ''}設定 ${hms(h.setAt)}</span>
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
      el.value = ''; clearDD(); $('inPair').value = raw; updatePreview(); return;
    }
    if (dmsAnyFilled()) clearDMS();
    if ($('inPair').value) $('inPair').value = '';
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
        $('inPair').value = raw; updatePreview(); return;
      }
      const nums = raw.match(/\d+(?:\.\d+)?/g) || [];
      if (nums.length === 3 && /D$/.test(id)) {
        const k = id.slice(0, 3);
        $(k + 'D').value = nums[0]; $(k + 'M').value = nums[1]; $(k + 'S').value = nums[2];
        $('inPair').value = '';
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
    if ($('inPair').value) $('inPair').value = '';
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

  function openEdit() {
    S.editing = true;
    $('targetView').hidden = true;
    $('targetForm').hidden = false;
    $('cancelEditBtn').hidden = !S.target;
    $('formBtnRow').classList.toggle('two', !!S.target);
    updatePreview();
    focusField('latD'); // タップ操作内で直接フォーカス（iPadでキーボードを開くため）
  }
  function closeEdit() {
    S.editing = false;
    $('targetForm').hidden = true;
    $('targetView').hidden = false;
    $('inPair').value = '';
    clearDMS(); clearDD();
    S.pending = null;
    document.activeElement && document.activeElement.blur && document.activeElement.blur();
  }

  /** 入力欄 → 変換プレビュー */
  function updatePreview() {
    const pv = $('preview');
    const pair = $('inPair').value.trim();
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
      if (pair) {
        r = Geo.parsePair(pair);
      } else if (la && lo) {
        const a = Geo.parseSingle(la, 'lat');
        const b = Geo.parseSingle(lo, 'lon');
        r = Geo.validate(a.value, b.value, a.fmt, []);
      } else if (dLat.partial || dLon.partial || la || lo) {
        const need = dLat.partial ? `緯度の${parts}` : dLon.partial ? `経度の${parts}` : (la ? '経度' : '緯度');
        pv.innerHTML = `<div class="muted">${need}を入力してください</div>`;
        return;
      } else {
        pv.innerHTML = '<div class="muted">変換結果がここに表示されます</div>';
        return;
      }
    } catch (e) {
      pv.className = 'preview err';
      pv.innerHTML = `<div class="pv-err">✖ ${esc(e.message)}</div>`;
      return;
    }
    S.pending = { lat: r.lat, lon: r.lon };
    const fmtName = { DD: '10進数', DM: '度分', DMS: '度分秒' }[r.fmt] || '';
    let extra = '';
    if (S.target) {
      const d = Geo.inverse(S.target.lat, S.target.lon, r.lat, r.lon);
      extra = `<div class="small muted">現在の現場から ${(d.distance / 1000).toFixed(2)} km（${Math.round(d.bearing)}°方向）</div>`;
    }
    pv.className = 'preview ok';
    pv.innerHTML = `
      <div class="small muted">認識形式: ${fmtName}</div>
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
    const ok = await confirmModal(S.target ? '現場座標を変更しますか？' : '現場座標を確定しますか？', `
      <div class="mono">${Geo.formatDD(p.lat)}, ${Geo.formatDD(p.lon)}</div>
      <div class="mono">${Geo.formatDMS(p.lat, true)} ${Geo.formatDMS(p.lon, false)}</div>
      ${S.target ? `<div class="small muted" style="margin-top:8px">変更前: ${esc(ddText(S.target))}</div>` : ''}`,
    '確定する');
    if (!ok) return;
    setTarget(p.lat, p.lon, { pushCurrent: true });
    toast(S.history.length ? '現場座標を更新しました' : '現場座標を設定しました');
  }

  function pushHistory(t) {
    S.history = [{ lat: t.lat, lon: t.lon, setAt: t.setAt }]
      .concat(S.history.filter((h) => !(Math.abs(h.lat - t.lat) < 1e-9 && Math.abs(h.lon - t.lon) < 1e-9)))
      .slice(0, HIST_MAX);
  }

  function setTarget(lat, lon, opts) {
    opts = opts || {};
    const prev = S.target;
    if (prev && opts.pushCurrent) pushHistory(prev);
    if (prev) S.old = { lat: prev.lat, lon: prev.lon };
    S.target = { lat, lon, setAt: opts.setAt || Date.now(), elev: { status: 'loading' } };
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
      <div class="mono">${esc(ddText(h))}</div><div class="mono">${esc(dmsText(h))}</div>
      ${S.target ? `<div class="small muted" style="margin-top:8px">現在: ${esc(ddText(S.target))}（破棄されます）</div>` : ''}`,
    '戻す');
    if (!ok) return;
    S.history.shift();
    setTarget(h.lat, h.lon, { pushCurrent: false, setAt: h.setAt });
    toast('1つ前の現場座標に戻しました');
  }

  async function restoreHistory(idx) {
    const h = S.history[idx];
    if (!h) return;
    const ok = await confirmModal('この座標を現場に設定しますか？', `
      <div class="mono">${esc(ddText(h))}</div><div class="mono">${esc(dmsText(h))}</div>
      <div class="small muted" style="margin-top:8px">現在の現場は履歴に残ります</div>`, '設定する');
    if (!ok) return;
    S.history.splice(idx, 1);
    setTarget(h.lat, h.lon, { pushCurrent: true, setAt: h.setAt });
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

    // 距離・方位・ETE
    if (p && t) {
      const inv = Geo.inverse(p.lat, p.lon, t.lat, t.lon);
      const km = inv.distance / 1000;
      setText('dKm', km.toFixed(2));
      setText('dNm', (inv.distance / Geo.M_PER_NM).toFixed(2));
      setText('dBrg', inv.distance < 1 ? '---' : fmtBrg(inv.bearing));
      const card = Geo.cardinal(inv.bearing);
      setText('dCard', inv.distance < 1 ? '--' : `${card}（${CARD_JA[card]}）`);
      // 現在の進行方位（指示方位との比較用）
      setText('dRel', valid(p.heading) ? `現針路 ${fmtBrg(p.heading)}` : '');
      if (spd != null && spd >= MIN_SPEED_MS) {
        const sec = Math.round(inv.distance / spd);
        const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
        setText('dEte', h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`);
        setText('dEta', hm(Date.now() + sec * 1000));
      } else {
        setText('dEte', spd != null ? '低速' : '--:--');
        setText('dEta', '--:--');
      }
    } else {
      ['dKm', 'dNm'].forEach((id) => setText(id, '--.--'));
      setText('dBrg', '---'); setText('dCard', t ? '自機位置待ち' : '現場未設定'); setText('dRel', '');
      setText('dEte', '--:--'); setText('dEta', '--:--');
    }

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
    buildRing();

    // ドラッグで自由にスクロール → 追従OFF（「現在位置に戻る」で復帰）
    map.on('dragstart', () => { if (S.follow) setFollow(false); });
    map.on('zoomend', () => { if (S.follow && !navBusy) navView(false); });
    map.on('move zoom rotate viewreset resize', drawRing);
    map.on('click', (e) => {
      if (simTapArmed) {
        simTapArmed = false; $('mapTapHint').hidden = true;
        simPlace(e.latlng.lat, e.latlng.lng);
        toast('自機の模擬位置を配置しました');
      }
    });
    setFollow(S.follow);
    setHeadUp(S.headUp);
    updateMapObjects();
    if (S.target && !S.pos) fitBoth(true);
    window.addEventListener('resize', () => setTimeout(() => { map.invalidateSize(); if (S.follow) navView(false); drawRing(); }, 200));
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
      const label = '現場' + (t.elev && t.elev.status === 'ok' ? ` ${fmtInt(t.elev.value)}m` : '');
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

    // 直線ルート（測地線・赤）
    if (p && t) {
      const pts = Geo.greatCirclePoints(p.lat, p.lon, t.lat, t.lon, 48);
      if (!routeLine) {
        routeCase = L.polyline(pts, { color: '#ffffff', weight: 10, opacity: 0.55, interactive: false }).addTo(map);
        routeLine = L.polyline(pts, { color: '#ff2a2a', weight: 5, opacity: 0.95, interactive: false }).addTo(map);
      } else { routeCase.setLatLngs(pts); routeLine.setLatLngs(pts); }
    } else if (routeLine) { map.removeLayer(routeLine); map.removeLayer(routeCase); routeLine = routeCase = null; }

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

    // 現場方位のマーク（リング外側の赤三角）と数値
    const t = S.target;
    if (t) {
      const inv = Geo.inverse(p.lat, p.lon, t.lat, t.lon);
      const a = north + inv.bearing;
      ring.tgtBug.setAttribute('d', 'M0 2 L-13 -20 L13 -20 Z');
      ring.tgtBug.setAttribute('transform', `translate(${pt(inv.bearing, R)[0]} ${pt(inv.bearing, R)[1]}) rotate(${a}) translate(0 -2)`);
      const [bx, by] = pt(inv.bearing, R + 40);
      const w = 118, h = 36;
      set(ring.tgtRect, { x: bx - w / 2, y: by - h / 2, width: w, height: h });
      set(ring.tgtText, { x: bx, y: by + 1 });
      ring.tgtText.textContent = '現場 ' + fmtBrg(inv.bearing);
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
    if (S.layer === 'osm') {
      infoModal('OSMは一括保存できません', 'OpenStreetMapのタイル利用規約では一括ダウンロードが禁止されています。<br>「地理院 標準」または「航空写真」に切り替えてから保存してください。');
      return;
    }
    const tpl = TILES[S.layer].url;
    const set = new Set();
    // 現場周辺 半径約3km（z10〜16）
    const dLat = 3 / 111.32, dLon = 3 / (111.32 * Math.cos(Geo.toRad(t.lat)));
    for (let z = 10; z <= 16; z++) {
      const x0 = lon2x(t.lon - dLon, z), x1 = lon2x(t.lon + dLon, z);
      const y0 = lat2y(t.lat + dLat, z), y1 = lat2y(t.lat - dLat, z);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) set.add(`${z}/${x}/${y}`);
    }
    // 自機→現場のルート沿い（z9〜13）
    if (S.pos) {
      const pts = Geo.greatCirclePoints(S.pos.lat, S.pos.lon, t.lat, t.lon, 80);
      for (let z = 9; z <= 13; z++) {
        pts.forEach(([la, lo]) => {
          const x = lon2x(lo, z), y = lat2y(la, z);
          for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) set.add(`${z}/${x + dx}/${y + dy}`);
        });
      }
    }
    const list = Array.from(set);
    const name = { std: '地理院 標準地図', photo: '航空写真', osm: 'OpenStreetMap' }[S.layer];
    const ok = await confirmModal('地図を端末に保存しますか？', `
      表示中の「${name}」を、現場周辺（半径約3km）${S.pos ? 'と現在地からのルート沿い' : ''}の
      <b>${list.length}枚</b>保存します。<br><span class="small muted">通信が安定している地上で実行してください。他の地図種別は切り替えてから再度実行してください。</span>`, '保存開始');
    if (!ok) return;
    const btn = $('cacheBtn');
    btn.disabled = true;
    let done = 0, fail = 0;
    const worker = async () => {
      while (list.length) {
        const [z, x, y] = list.shift().split('/');
        try { await fetch(tileUrl(tpl, z, x, y), { mode: 'no-cors' }); } catch (e) { fail++; }
        done++;
        if (done % 5 === 0) btn.textContent = `保存中… ${done}`;
      }
    };
    await Promise.all([1, 2, 3, 4, 5, 6].map(worker));
    btn.disabled = false;
    btn.textContent = '現場周辺の地図を保存';
    toast(fail ? `保存完了（${done - fail}枚成功・${fail}枚失敗）` : `地図 ${done}枚を保存しました`, 3500);
  }

  /* =========================================================
   * テストモード（手動座標指定・模擬移動）
   * ========================================================= */
  const sim = { lat: null, lon: null, hdg: 45, running: false, timer: null };

  function simEmit(speedMs) {
    ingest({
      lat: sim.lat, lon: sim.lon, alt: parseFloat($('simAlt').value) || 0,
      acc: 4 + Math.random() * 4, altAcc: 10, speed: speedMs, heading: sim.hdg, ts: Date.now(), src: 'sim',
    });
  }
  function simPlace(lat, lon) {
    sim.lat = lat; sim.lon = lon;
    if (S.target) sim.hdg = Geo.inverse(lat, lon, S.target.lat, S.target.lon).bearing;
    $('simStart').value = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
    simEmit(0);
  }
  function simTick() {
    if (sim.lat == null) return;
    if (!sim.running) { simEmit(0); return; }
    let ms = (parseFloat($('simSpeed').value) || 0) / MS2KT;
    const t = S.target;
    if ($('simAuto').checked && t) {
      const inv = Geo.inverse(sim.lat, sim.lon, t.lat, t.lon);
      if (inv.distance <= Math.max(ms, 1)) {
        sim.lat = t.lat; sim.lon = t.lon; simStop(); simEmit(0);
        toast('現場上空に到着しました（模擬）');
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
    if (sim.lat == null) {
      if (last) simPlace(last.lat, last.lon);
      else if (S.target) simAutoStart();
    } else simEmit(0);
    sim.timer = setInterval(simTick, 1000);
    $('testPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    scheduleRender();
  }
  function exitTest() {
    simStop();
    clearInterval(sim.timer); sim.timer = null;
    simTapArmed = false; $('mapTapHint').hidden = true;
    S.testMode = false;
    S.pos = null; S.lastHeading = null;
    $('testPanel').hidden = true;
    $('testBanner').hidden = true;
    $('testBtn').classList.remove('pill-on');
    $('testBtn').textContent = 'テストモード';
    startGPS();
    toast('実GPSに戻しました');
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
  async function copyText(txt) {
    let ok = false;
    try { await navigator.clipboard.writeText(txt); ok = true; } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = txt; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, txt.length);
      try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
      ta.remove();
    }
    toast(ok ? `コピーしました：${txt}` : `コピーできませんでした：${txt}`, 3000);
  }
  function openGoogleMaps() {
    const t = S.target;
    if (!t) return;
    const url = `https://www.google.com/maps/search/?api=1&query=${t.lat.toFixed(6)},${t.lon.toFixed(6)}`;
    const w = window.open(url, '_blank');
    if (!w) location.href = url; // ポップアップブロック時
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
    $('editBtn').onclick = openEdit;
    $('cancelEditBtn').onclick = closeEdit;
    $('clearInputBtn').onclick = () => { $('inPair').value = ''; clearDMS(); clearDD(); updatePreview(); focusField('latD'); };
    $('targetForm').addEventListener('submit', (e) => { e.preventDefault(); applyPending(); });
    $('inPair').addEventListener('input', () => {
      if ($('inPair').value.trim()) { if (dmsAnyFilled()) clearDMS(); if (ddAnyFilled()) clearDD(); }
      updatePreview();
    });
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
    $('inPair').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); applyPending(); } });

    $('undoBtn').onclick = undoTarget;
    $('histBtn').onclick = () => { $('histList').hidden = !$('histList').hidden; };
    $('histList').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-idx]');
      if (b) restoreHistory(parseInt(b.dataset.idx, 10));
    });
    $('gmapBtn').onclick = openGoogleMaps;
    $('copyDDBtn').onclick = () => S.target && copyText(ddText(S.target));
    $('copyDMSBtn').onclick = () => S.target && copyText(dmsText(S.target));
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
      simTapArmed = true; $('mapTapHint').hidden = false;
    };
    $('simAutoStartBtn').onclick = simAutoStart;
    $('simRunBtn').onclick = simStart;
    $('simStopBtn').onclick = simStop;
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
    if (!S.target) openEdit();
    else if (!S.target.elev || S.target.elev.status !== 'ok') fetchElevation();

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
