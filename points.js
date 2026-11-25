/* =========================================================
 * points.js — 登録地点（場外一覧表）の読み込みと検索
 *   ・Excel（.xlsx：Numbersから書き出し）/ CSV を端末内で解析（外部送信なし）
 *   ・県ごとのシート、見出し行の自動判定（列の順番・名前の揺れに対応）
 *   ・座標は10進数・度分秒どちらでも可（Geo のパーサを使用）
 * ========================================================= */
(function (root) {
  'use strict';
  const Geo = root.Geo;

  /* ---------- ZIP（xlsx）展開：ブラウザ標準の DecompressionStream を使用 ---------- */
  async function inflateRaw(u8) {
    if (typeof DecompressionStream === 'undefined') throw new Error('この端末ではExcelファイルを読めません（iPadOSを更新してください）');
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([u8]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  function unzipIndex(buf) {
    const u8 = new Uint8Array(buf), dv = new DataView(buf);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Excelファイルとして読めません（ファイルが壊れているか、形式が違います）');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const files = {};
    const dec = new TextDecoder();
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const off = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
      files[name] = { method, csize, off };
      p += 46 + nlen + elen + clen;
    }
    return {
      has: (n) => !!files[n],
      async text(n) {
        const f = files[n];
        if (!f) return null;
        const ln = dv.getUint16(f.off + 26, true), le = dv.getUint16(f.off + 28, true);
        const start = f.off + 30 + ln + le;
        const raw = u8.subarray(start, start + f.csize);
        const data = f.method === 0 ? raw : await inflateRaw(raw);
        return new TextDecoder('utf-8').decode(data);
      },
    };
  }
  const xml = (s) => new DOMParser().parseFromString(s, 'application/xml');
  const byTag = (doc, tag) => Array.from(doc.getElementsByTagNameNS('*', tag));
  function colIndex(ref) {
    const m = /^([A-Z]+)/.exec(ref || '');
    if (!m) return -1;
    let n = 0;
    for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  }
  function cellText(c, shared) {
    const t = c.getAttribute('t');
    if (t === 'inlineStr') return byTag(c, 't').map((x) => x.textContent).join('');
    const v = byTag(c, 'v')[0];
    if (!v) return '';
    if (t === 's') return shared[parseInt(v.textContent, 10)] || '';
    return v.textContent;
  }

  /** .xlsx → [{name, rows:[[文字列]]}] */
  async function readXlsx(buf) {
    const z = unzipIndex(buf);
    const wbText = await z.text('xl/workbook.xml');
    if (!wbText) throw new Error('Excelファイルの中身（workbook）が見つかりません');
    const wb = xml(wbText);
    const rels = xml(await z.text('xl/_rels/workbook.xml.rels') || '<Relationships/>');
    const relMap = {};
    byTag(rels, 'Relationship').forEach((r) => { relMap[r.getAttribute('Id')] = r.getAttribute('Target'); });
    const shared = [];
    const ssText = await z.text('xl/sharedStrings.xml');
    if (ssText) byTag(xml(ssText), 'si').forEach((si) => shared.push(byTag(si, 't').map((x) => x.textContent).join('')));
    const sheets = [];
    for (const s of byTag(wb, 'sheet')) {
      const name = s.getAttribute('name');
      const rid = s.getAttribute('r:id') || s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
      let target = relMap[rid] || '';
      target = target.replace(/^\//, '');
      const path = target.startsWith('xl/') ? target : 'xl/' + target;
      const sx = await z.text(path);
      if (!sx) continue;
      const rows = [];
      byTag(xml(sx), 'row').forEach((r) => {
        const ri = parseInt(r.getAttribute('r'), 10) - 1;
        const row = [];
        let ci = 0;
        byTag(r, 'c').forEach((c) => {
          const idx = colIndex(c.getAttribute('r'));
          if (idx >= 0) ci = idx;
          row[ci] = cellText(c, shared);
          ci++;
        });
        rows[isNaN(ri) ? rows.length : ri] = Array.from(row, (v) => (v == null ? '' : String(v)));
      });
      sheets.push({ name, rows: Array.from(rows, (r) => r || []) });
    }
    return sheets;
  }

  /** CSV → rows（UTF-8 / Shift_JIS 自動判定） */
  function decodeText(buf) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) {
      try { return new TextDecoder('shift_jis').decode(buf); } catch (e2) { return new TextDecoder().decode(buf); }
    }
  }
  function parseCSV(text) {
    text = text.replace(/^﻿/, '');
    const delim = (text.split('\n')[0].match(/\t/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? '\t' : ',';
    const rows = []; let row = [], f = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch;
      } else if (ch === '"') q = true;
      else if (ch === delim) { row.push(f); f = ''; }
      else if (ch === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
      else if (ch !== '\r') f += ch;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return rows;
  }

  /** ファイル → シート配列 */
  async function readFile(file) {
    const buf = await file.arrayBuffer();
    const head = new Uint8Array(buf.slice(0, 4));
    const isZip = head[0] === 0x50 && head[1] === 0x4b;
    if (/\.numbers$/i.test(file.name)) {
      throw new Error('Numbers形式（.numbers）は直接読めません。Numbersの「書き出す」→「Excel」で保存したファイルを選んでください');
    }
    if (isZip) return readXlsx(buf);
    if (/\.xls$/i.test(file.name)) throw new Error('古いExcel形式（.xls）は読めません。.xlsx で保存し直してください');
    const base = file.name.replace(/\.[^.]+$/, '');
    return [{ name: base, rows: parseCSV(decodeText(buf)) }];
  }

  /* ---------- 見出しの自動判定 ---------- */
  const PREFS = ['北海道', '青森', '岩手', '宮城', '秋田', '山形', '福島', '茨城', '栃木', '群馬', '埼玉', '千葉', '東京', '神奈川',
    '新潟', '富山', '石川', '福井', '山梨', '長野', '岐阜', '静岡', '愛知', '三重', '滋賀', '京都', '大阪', '兵庫', '奈良', '和歌山',
    '鳥取', '島根', '岡山', '広島', '山口', '徳島', '香川', '愛媛', '高知', '福岡', '佐賀', '長崎', '熊本', '大分', '宮崎', '鹿児島', '沖縄'];
  function prefFrom(s) {
    s = String(s || '');
    for (const p of PREFS) if (s.includes(p)) return p === '北海道' ? p : p + (p === '東京' ? '都' : (p === '京都' || p === '大阪') ? '府' : '県');
    return '';
  }
  const hnorm = (s) => String(s || '').normalize('NFKC').replace(/[\s　（）()【】\[\]・:：]/g, '').toLowerCase();
  function roleOf(h) {
    const s = hnorm(h);
    if (!s) return null;
    if (/緯度/.test(s) && /経度/.test(s)) return 'coord';
    if (/電話|tel|fax/.test(s)) return null;
    if (/^(no\.?|№|番号|整理番号|管理番号|通し番号|連番|id)$/.test(s) || /番号$/.test(s)) return 'no';
    if (/緯度|^lat/.test(s)) return 'lat';
    if (/経度|^lon|^lng/.test(s)) return 'lon';
    if (/座標|位置|緯度経度/.test(s)) return 'coord';
    if (/名称|施設名|名前|地点名|場所名|病院名|ヘリポート名|離着陸場名|^name$/.test(s)) return 'name';
    if (/備考|メモ|注意|特記|摘要|note/.test(s)) return 'note';
    if (/種別|区分|分類|種類|type/.test(s)) return 'type';
    if (/所在地|住所|address/.test(s)) return 'addr';
    if (/都道府県|^県$|^県名$/.test(s)) return 'pref';
    return null;
  }
  function findHeader(rows) {
    for (let i = 0; i < Math.min(rows.length, 15); i++) {
      const cols = {};
      (rows[i] || []).forEach((h, ci) => { const r = roleOf(h); if (r && cols[r] == null) cols[r] = ci; });
      if (cols.name != null && ((cols.lat != null && cols.lon != null) || cols.coord != null)) return { row: i, cols };
    }
    return null;
  }

  const SKIP_SHEET = /記入|説明|凡例|使い方|手順|注意事項|テンプレ/;
  const KYUSHU = { latMin: 26.5, latMax: 34.6, lonMin: 127.8, lonMax: 132.5 };

  /**
   * シート配列 → 地点一覧
   * @returns {points, errors:[{sheet,row,msg}], warnings:[...], sheets:[{name,count,skipped}]}
   */
  function extractPoints(sheets) {
    const points = [], errors = [], warnings = [], info = [];
    for (const sh of sheets) {
      if (SKIP_SHEET.test(sh.name)) { info.push({ name: sh.name, count: 0, skipped: '説明用シートのため読み込みません' }); continue; }
      const hd = findHeader(sh.rows);
      if (!hd) {
        const nonEmpty = sh.rows.some((r) => r && r.some((v) => String(v).trim()));
        info.push({ name: sh.name, count: 0, skipped: nonEmpty ? '見出し（名称・緯度・経度）が見つかりません' : '空のシート' });
        continue;
      }
      const c = hd.cols;
      const sheetPref = prefFrom(sh.name);
      let count = 0;
      for (let i = hd.row + 1; i < sh.rows.length; i++) {
        const r = sh.rows[i] || [];
        const get = (k) => (c[k] != null ? String(r[c[k]] == null ? '' : r[c[k]]).trim() : '');
        const name = get('name');
        const latS = get('lat'), lonS = get('lon'), coordS = get('coord');
        if (!name && !latS && !lonS && !coordS) continue; // 空行
        const rowNo = i + 1; // 表計算ソフトの行番号
        if (!name) { errors.push({ sheet: sh.name, row: rowNo, msg: '名称が空欄です' }); continue; }
        let lat, lon;
        try {
          if (latS || lonS) {
            if (!latS || !lonS) throw new Error(!latS ? '緯度が空欄です' : '経度が空欄です');
            lat = Geo.parseSingle(latS, 'lat').value;
            lon = Geo.parseSingle(lonS, 'lon').value;
            if (Math.abs(lat) > 90 && Math.abs(lon) <= 90) {
              const t = lat; lat = lon; lon = t;
              warnings.push({ sheet: sh.name, row: rowNo, name, msg: '緯度と経度が逆だったため入れ替えました' });
            }
            if (Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error('緯度・経度の値が範囲外です');
          } else {
            if (!coordS) throw new Error('座標が空欄です');
            const p = Geo.parsePair(coordS);
            lat = p.lat; lon = p.lon;
          }
        } catch (e) {
          errors.push({ sheet: sh.name, row: rowNo, name, msg: e.message });
          continue;
        }
        const pref = sheetPref || prefFrom(get('pref')) || prefFrom(get('addr')) || '';
        if ((/福岡|佐賀|長崎|熊本|大分|宮崎|鹿児島/.test(pref) || !pref) &&
          !(lat >= KYUSHU.latMin && lat <= KYUSHU.latMax && lon >= KYUSHU.lonMin && lon <= KYUSHU.lonMax)) {
          warnings.push({ sheet: sh.name, row: rowNo, name, msg: `九州の範囲外の座標です（${lat.toFixed(5)}, ${lon.toFixed(5)}）` });
        }
        const no = get('no');
        points.push({
          id: `${pref || sh.name}-${no || 'r' + rowNo}`,
          pref: pref || sh.name, no, name, type: get('type'), addr: get('addr'), note: get('note'),
          lat: Math.round(lat * 1e7) / 1e7, lon: Math.round(lon * 1e7) / 1e7,
          sheet: sh.name, row: rowNo,
        });
        count++;
      }
      info.push({ name: sh.name, count });
    }
    // 重複（同じ名称・ほぼ同じ位置）
    const seen = {};
    points.forEach((p) => {
      const k = p.name + '|' + p.lat.toFixed(4) + '|' + p.lon.toFixed(4);
      if (seen[k]) warnings.push({ sheet: p.sheet, row: p.row, name: p.name, msg: `重複の可能性（${seen[k].sheet} ${seen[k].row}行目と同じ）` });
      else seen[k] = p;
    });
    return { points, errors, warnings, sheets: info };
  }

  /** 前回の一覧との比較（名称＋県で照合。目安表示用） */
  function diff(oldPts, newPts) {
    const key = (p) => p.pref + '|' + hnorm(p.name);
    const om = new Map((oldPts || []).map((p) => [key(p), p]));
    const nm = new Map(newPts.map((p) => [key(p), p]));
    let added = 0, removed = 0, changed = 0, same = 0;
    nm.forEach((p, k) => {
      const o = om.get(k);
      if (!o) added++;
      else if (Math.abs(o.lat - p.lat) > 1e-6 || Math.abs(o.lon - p.lon) > 1e-6 || (o.note || '') !== (p.note || '') || (o.type || '') !== (p.type || '')) changed++;
      else same++;
    });
    om.forEach((p, k) => { if (!nm.has(k)) removed++; });
    return { added, removed, changed, same };
  }

  /* ---------- 検索 ---------- */
  const kata2hira = (s) => s.replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
  const snorm = (s) => kata2hira(String(s || '').normalize('NFKC').toLowerCase()).replace(/[\s　・･\-ー－]/g, '');
  function search(points, query, from, limit) {
    const terms = String(query || '').normalize('NFKC').split(/[\s　]+/).map(snorm).filter(Boolean);
    if (!terms.length) return [];
    const out = [];
    for (const p of points) {
      const nm = snorm(p.name);
      const hay = nm + '|' + snorm(p.pref) + '|' + snorm(p.type) + '|' + snorm(p.addr) + '|' + snorm(p.note) + '|' + snorm(p.no);
      let score = 0, ok = true;
      for (const t of terms) {
        if (nm.startsWith(t)) score += 30;
        else if (nm.includes(t)) score += 20;
        else if (hay.includes(t)) score += 5;
        else { ok = false; break; }
      }
      if (!ok) continue;
      const d = from ? Geo.inverse(from.lat, from.lon, p.lat, p.lon) : null;
      out.push({ p, score, dist: d ? d.distance : null, brg: d ? d.bearing : null });
    }
    out.sort((a, b) => b.score - a.score || (a.dist == null ? 0 : a.dist - (b.dist == null ? 0 : b.dist)));
    return out.slice(0, limit || 30);
  }

  /** CSV書き出し（Numbers / Excel でそのまま開ける UTF-8 BOM付き） */
  function toCSV(points) {
    const q = (v) => { v = String(v == null ? '' : v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const lines = [['県', '番号', '名称', '種別', '緯度', '経度', '所在地', '備考'].join(',')];
    points.forEach((p) => lines.push([p.pref, p.no, p.name, p.type, p.lat.toFixed(7), p.lon.toFixed(7), p.addr, p.note].map(q).join(',')));
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  const Points = { readFile, readXlsx, parseCSV, extractPoints, diff, search, toCSV, prefFrom };
  root.Points = Points;
  if (typeof module !== 'undefined' && module.exports) module.exports = Points;
})(typeof self !== 'undefined' ? self : this);
