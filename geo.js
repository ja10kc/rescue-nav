/* =========================================================
 * geo.js — 座標変換・測地計算（すべて端末内で完結／オフライン動作）
 * ブラウザでは window.Geo、Node では module.exports として利用可能
 * ========================================================= */
(function (root) {
  'use strict';

  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const norm360 = (d) => ((d % 360) + 360) % 360;
  const R_EARTH = 6371008.8; // 平均地球半径 [m]
  const M_PER_NM = 1852;

  /* ---------- 距離・方位（Vincenty 楕円体 / WGS84） ---------- */
  function vincentyInverse(lat1, lon1, lat2, lon2) {
    const a = 6378137, f = 1 / 298.257223563, b = a * (1 - f);
    const L = toRad(lon2 - lon1);
    const U1 = Math.atan((1 - f) * Math.tan(toRad(lat1)));
    const U2 = Math.atan((1 - f) * Math.tan(toRad(lat2)));
    const sinU1 = Math.sin(U1), cosU1 = Math.cos(U1);
    const sinU2 = Math.sin(U2), cosU2 = Math.cos(U2);
    let lambda = L, lambdaP, iter = 0;
    let sinL, cosL, sinS, cosS, sigma, sinA, cos2A, cos2Sm, C;
    do {
      sinL = Math.sin(lambda); cosL = Math.cos(lambda);
      const t1 = cosU2 * sinL;
      const t2 = cosU1 * sinU2 - sinU1 * cosU2 * cosL;
      sinS = Math.sqrt(t1 * t1 + t2 * t2);
      if (sinS === 0) return { distance: 0, bearing: 0 };
      cosS = sinU1 * sinU2 + cosU1 * cosU2 * cosL;
      sigma = Math.atan2(sinS, cosS);
      sinA = (cosU1 * cosU2 * sinL) / sinS;
      cos2A = 1 - sinA * sinA;
      cos2Sm = cos2A !== 0 ? cosS - (2 * sinU1 * sinU2) / cos2A : 0;
      C = (f / 16) * cos2A * (4 + f * (4 - 3 * cos2A));
      lambdaP = lambda;
      lambda = L + (1 - C) * f * sinA *
        (sigma + C * sinS * (cos2Sm + C * cosS * (-1 + 2 * cos2Sm * cos2Sm)));
    } while (Math.abs(lambda - lambdaP) > 1e-12 && ++iter < 200);
    if (iter >= 200) return null; // 収束せず（対蹠点付近）→ 球面式へ
    const u2 = (cos2A * (a * a - b * b)) / (b * b);
    const A = 1 + (u2 / 16384) * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
    const B = (u2 / 1024) * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
    const dS = B * sinS * (cos2Sm + (B / 4) * (cosS * (-1 + 2 * cos2Sm * cos2Sm) -
      (B / 6) * cos2Sm * (-3 + 4 * sinS * sinS) * (-3 + 4 * cos2Sm * cos2Sm)));
    const s = b * A * (sigma - dS);
    const a1 = Math.atan2(cosU2 * sinL, cosU1 * sinU2 - sinU1 * cosU2 * cosL);
    return { distance: s, bearing: norm360(toDeg(a1)) };
  }

  function haversine(lat1, lon1, lat2, lon2) {
    const p1 = toRad(lat1), p2 = toRad(lat2);
    const dp = p2 - p1, dl = toRad(lon2 - lon1);
    const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    const d = 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return { distance: d, bearing: norm360(toDeg(Math.atan2(y, x))) };
  }

  /** 2点間の距離[m]と真方位[°] */
  function inverse(lat1, lon1, lat2, lon2) {
    return vincentyInverse(lat1, lon1, lat2, lon2) || haversine(lat1, lon1, lat2, lon2);
  }

  /** 出発点から方位・距離進んだ点（球面近似：シミュレーション用） */
  function destination(lat, lon, bearingDeg, distM) {
    const d = distM / R_EARTH, th = toRad(bearingDeg);
    const p1 = toRad(lat), l1 = toRad(lon);
    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(th));
    const l2 = l1 + Math.atan2(Math.sin(th) * Math.sin(d) * Math.cos(p1),
      Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    return { lat: toDeg(p2), lon: ((toDeg(l2) + 540) % 360) - 180 };
  }

  /** 大圏（測地線）上の中間点列 */
  function greatCirclePoints(lat1, lon1, lat2, lon2, n) {
    n = n || 64;
    const p1 = toRad(lat1), l1 = toRad(lon1), p2 = toRad(lat2), l2 = toRad(lon2);
    const d = 2 * Math.asin(Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 +
      Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2));
    if (d < 1e-9) return [[lat1, lon1], [lat2, lon2]];
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const fr = i / n;
      const A = Math.sin((1 - fr) * d) / Math.sin(d);
      const B = Math.sin(fr * d) / Math.sin(d);
      const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
      const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
      const z = A * Math.sin(p1) + B * Math.sin(p2);
      pts.push([toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))), toDeg(Math.atan2(y, x))]);
    }
    return pts;
  }

  /* ---------- 表示フォーマット ---------- */
  /** 10進数 → 度分秒（秒は小数点以下2桁） */
  function toDMSParts(dd) {
    const total = Math.round(Math.abs(dd) * 360000); // 1/100秒単位の整数で計算（繰上り誤差防止）
    const d = Math.floor(total / 360000);
    const m = Math.floor((total % 360000) / 6000);
    const s = (total % 6000) / 100;
    return { d, m, s, neg: dd < 0 };
  }
  function formatDMS(dd, isLat) {
    const p = toDMSParts(dd);
    const hemi = isLat ? (p.neg ? 'S' : 'N') : (p.neg ? 'W' : 'E');
    return `${p.d}°${String(p.m).padStart(2, '0')}′${p.s.toFixed(2).padStart(5, '0')}″${hemi}`;
  }
  function formatDMSJa(dd, isLat) {
    const p = toDMSParts(dd);
    const pre = isLat ? (p.neg ? '南緯' : '北緯') : (p.neg ? '西経' : '東経');
    return `${pre}${p.d}度${String(p.m).padStart(2, '0')}分${p.s.toFixed(2).padStart(5, '0')}秒`;
  }
  function formatDD(dd, digits) { return dd.toFixed(digits == null ? 6 : digits); }

  const CARDINALS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const cardinal = (deg) => CARDINALS[Math.round(norm360(deg) / 22.5) % 16];

  /* ---------- 座標文字列パーサ ----------
   * 対応例:
   *   35.360556, 138.727778 / 35.360556 138.727778
   *   35°21'38.45"N 138°43'40.12"E / N35°21'38.45" E138°43'40.12"
   *   北緯35度21分38.45秒 東経138度43分40.12秒 / 35度21分38.45秒
   *   35 21 38.45 138 43 40.12（スペース区切り） / 35 21.640 138 43.668（度分）
   */
  function normalize(str) {
    let s = String(str == null ? '' : str).normalize('NFKC').toUpperCase();
    s = s.replace(/[−‐‑‒–—―﹣]/g, '-');
    s = s.replace(/北緯/g, ' N ').replace(/南緯/g, ' S ')
      .replace(/東経/g, ' E ').replace(/西経/g, ' W ');
    s = s.replace(/緯度|緯|LATITUDE|LAT/g, ' @LA ')
      .replace(/経度|経|LONGITUDE|LONG|LON|LNG/g, ' @LO ');
    s = s.replace(/北/g, ' N ').replace(/南/g, ' S ').replace(/東/g, ' E ').replace(/西/g, ' W ');
    s = s.replace(/[°º˚度分秒′″'"`´’”]/g, ' ');
    s = s.replace(/[、，]/g, ',').replace(/[：:=]/g, ' ');
    return s.replace(/[ 　]+/g, ' ').trim();
  }

  function tokenize(s) {
    const out = [];
    const re = /([-+]?)(\d+(?:\.\d+)?)/g;
    let m;
    while ((m = re.exec(s))) {
      const prev = m.index > 0 ? s[m.index - 1] : ' ';
      const neg = m[1] === '-' && /[\s,;\/@A-Z]/.test(prev);
      out.push({ v: parseFloat(m[2]), raw: m[2], neg, isInt: !m[2].includes('.') });
    }
    return out;
  }

  function hemiOf(s) {
    const m = s.match(/[NSEW]/);
    return m ? m[0] : null;
  }

  /** 数値トークン列 → 10進度 */
  function valueFromTokens(tokens, kind) {
    const n = tokens.length;
    if (n < 1 || n > 3) throw new Error(`${kind === 'lon' ? '経度' : '緯度'}の数値の個数が不正です（${n}個）`);
    let v, fmt;
    if (n === 1) {
      v = tokens[0].v; fmt = 'DD';
    } else if (n === 2) {
      if (!tokens[0].isInt) throw new Error('度分形式の「度」は整数で入力してください');
      if (tokens[1].v >= 60) throw new Error('「分」は60未満で入力してください');
      v = tokens[0].v + tokens[1].v / 60; fmt = 'DM';
    } else {
      if (!tokens[0].isInt || !tokens[1].isInt) throw new Error('度分秒形式の「度」「分」は整数で入力してください');
      if (tokens[1].v >= 60) throw new Error('「分」は60未満で入力してください');
      const sec = Math.round(tokens[2].v * 100) / 100; // 秒は小数点以下2桁まで有効
      if (sec >= 60) throw new Error('「秒」は60未満で入力してください');
      v = tokens[0].v + tokens[1].v / 60 + sec / 3600; fmt = 'DMS';
    }
    return { v, fmt };
  }

  function parsePart(part, kindHint) {
    const hemi = hemiOf(part);
    let kind = kindHint || null;
    if (/@LA/.test(part)) kind = 'lat';
    if (/@LO/.test(part)) kind = 'lon';
    if (hemi === 'N' || hemi === 'S') kind = 'lat';
    if (hemi === 'E' || hemi === 'W') kind = 'lon';
    const tokens = tokenize(part.replace(/@LA|@LO/g, ' '));
    return { tokens, hemi, kind };
  }

  function finishPart(p, kind) {
    const { v, fmt } = valueFromTokens(p.tokens, kind);
    let val = v;
    const neg = (p.tokens[0] && p.tokens[0].neg) || p.hemi === 'S' || p.hemi === 'W';
    if (neg) val = -val;
    return { value: val, fmt };
  }

  /** 文字列を「緯度部」「経度部」に分割 */
  function splitPair(s) {
    const la = s.indexOf('@LA'), lo = s.indexOf('@LO');
    if (la >= 0 && lo >= 0) {
      const cut = Math.max(la, lo);
      return [s.slice(0, cut), s.slice(cut)];
    }
    const letters = [];
    const re = /[NSEW]/g; let m;
    while ((m = re.exec(s))) letters.push(m.index);
    const firstDigit = s.search(/\d/);
    if (letters.length >= 2 && firstDigit >= 0) {
      if (letters[0] < firstDigit) return [s.slice(0, letters[1]), s.slice(letters[1])]; // 前置 N35 E138
      return [s.slice(0, letters[0] + 1), s.slice(letters[0] + 1)];                     // 後置 35N 138E
    }
    const sep = s.search(/[,;\/\t|]/);
    if (sep >= 0) return [s.slice(0, sep), s.slice(sep + 1)];
    return null; // 数値個数で分割
  }

  /**
   * 緯度・経度のペアを解析
   * @returns {lat, lon, fmt, notes[]}
   */
  function parsePair(input) {
    const s = normalize(input);
    if (!s) throw new Error('座標が入力されていません');
    let pA, pB;
    const parts = splitPair(s);
    if (parts) {
      pA = parsePart(parts[0]); pB = parsePart(parts[1]);
    } else {
      const all = tokenize(s);
      if (all.length === 0) throw new Error('数値が見つかりません');
      if (![2, 4, 6].includes(all.length)) {
        throw new Error(`緯度と経度を区別できません（数値${all.length}個）。カンマやN/Eで区切ってください`);
      }
      const h = all.length / 2;
      pA = { tokens: all.slice(0, h), hemi: null, kind: null };
      pB = { tokens: all.slice(h), hemi: null, kind: null };
    }
    if (!pA.tokens.length || !pB.tokens.length) throw new Error('緯度または経度の数値がありません');
    const notes = [];
    let latP = pA, lonP = pB;
    if (pA.kind === 'lon' || pB.kind === 'lat') { latP = pB; lonP = pA; }
    let lat = finishPart(latP, 'lat'), lon = finishPart(lonP, 'lon');
    if (!latP.kind && !lonP.kind && Math.abs(lat.value) > 90 && Math.abs(lon.value) <= 90) {
      const t = lat; lat = lon; lon = t;
      notes.push('緯度・経度の順序を自動で入れ替えました');
    }
    return validate(lat.value, lon.value, lat.fmt, notes);
  }

  /** 単独フィールド（緯度 or 経度）の解析 */
  function parseSingle(input, kind) {
    const s = normalize(input);
    if (!s) throw new Error(`${kind === 'lat' ? '緯度' : '経度'}が入力されていません`);
    const p = parsePart(s, kind);
    if (p.kind && p.kind !== kind) {
      throw new Error(kind === 'lat' ? '緯度欄に経度（E/W）が入力されています' : '経度欄に緯度（N/S）が入力されています');
    }
    return finishPart(p, kind);
  }

  function validate(lat, lon, fmt, notes) {
    notes = notes || [];
    if (!isFinite(lat) || !isFinite(lon)) throw new Error('数値を解釈できません');
    if (Math.abs(lat) > 90) throw new Error('緯度は -90〜90 の範囲で入力してください');
    if (Math.abs(lon) > 180) throw new Error('経度は -180〜180 の範囲で入力してください');
    if (!(lat >= 20 && lat <= 46 && lon >= 122 && lon <= 154)) {
      notes.push('⚠ 日本の範囲外の座標です。入力ミスがないか確認してください');
    }
    return { lat, lon, fmt, notes };
  }

  /** 入力が「ペア」っぽいか（緯度欄への一括貼り付け検出用） */
  function looksLikePair(input) {
    try {
      const s = normalize(input);
      if (splitPair(s)) { parsePair(input); return true; }
      const n = tokenize(s).length;
      return n === 2 || n === 4 || n === 6 ? (parsePair(input), true) : false;
    } catch (e) { return false; }
  }

  const Geo = {
    toRad, toDeg, norm360, M_PER_NM, inverse, haversine, vincentyInverse,
    destination, greatCirclePoints, toDMSParts, formatDMS, formatDMSJa, formatDD,
    cardinal, normalize, parsePair, parseSingle, validate, looksLikePair,
  };
  root.Geo = Geo;
  if (typeof module !== 'undefined' && module.exports) module.exports = Geo;
})(typeof self !== 'undefined' ? self : this);
