/* checker.js - is this asset register ready for AI?
 *
 * Plain rules, no AI. Reads a register (CSV text), finds the problems that make an AI give wrong answers
 * about it, and says why each one matters. Runs in the browser (window.Checker) and in Node (require).
 * Nothing leaves the machine.
 */
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ CSV
  function parseCSV(text) {
    text = text.replace(/^﻿/, '');
    const out = [];
    let row = [], f = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
        else f += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(f); f = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(f); f = '';
        if (row.length > 1 || row[0] !== '') out.push(row);
        row = [];
      } else f += c;
    }
    if (f !== '' || row.length) { row.push(f); if (row.length > 1 || row[0] !== '') out.push(row); }
    const headers = out.shift() || [];
    return { headers, rows: out };
  }

  // ------------------------------------------------------------------ columns
  const FIELDS = {
    tag: { label: 'Asset tag', names: ['assettag', 'tag', 'tagnumber', 'assetid', 'assetno', 'assetnumber', 'equipmentid', 'equipmenttag', 'assetcode', 'name'] },
    type: { label: 'Asset type', names: ['assettype', 'type', 'typename', 'equipmenttype', 'category', 'assetclass', 'class'] },
    description: { label: 'Description', names: ['description', 'desc', 'assetdescription'] },
    system: { label: 'System', names: ['system', 'extsystem', 'service', 'discipline', 'trade'] },
    level: { label: 'Level / floor', names: ['level', 'floor', 'storey', 'floorlevel', 'levelname'] },
    space: { label: 'Space / room', names: ['space', 'room', 'location', 'area', 'spacename'] },
    serial: { label: 'Serial number', names: ['serialnumber', 'serial', 'serialno', 'sn'] },
    install: { label: 'Install date', names: ['installdate', 'installationdate', 'installed', 'commissioningdate', 'dateinstalled'] },
    warranty: { label: 'Warranty end', names: ['warrantyend', 'warrantyenddate', 'warrantyexpiry', 'warrantyexpirydate', 'warrantyuntil'] },
    criticality: { label: 'Criticality', names: ['criticality', 'priority', 'critical', 'criticalitycode'] },
    ppm: { label: 'PPM frequency', names: ['ppmfrequency', 'ppm', 'maintenancefrequency', 'frequency', 'pmfrequency', 'servicefrequency'] },
    parent: { label: 'Parent tag', names: ['parenttag', 'parent', 'parentasset', 'parentid', 'fedfrom'] },
  };
  const REQUIRED = ['tag', 'type', 'level', 'criticality', 'ppm'];
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  function detectColumns(headers) {
    const map = {};
    const taken = new Set();
    for (const [k, def] of Object.entries(FIELDS)) {
      for (const want of def.names) {
        const i = headers.findIndex((h, j) => !taken.has(j) && norm(h) === want);
        if (i >= 0) { map[k] = i; taken.add(i); break; }
      }
    }
    return map;
  }

  // ------------------------------------------------------------------ helpers
  const PLACEHOLDER = new Set(['', 'tbc', 'tba', 'na', 'n/a', '-', '--', '?', '0', 'none', 'unknown', 'null', 'nil', 'seedrawing', 'see drawing', 'xx', 'xxx']);
  const isBlank = v => PLACEHOLDER.has(String(v == null ? '' : v).trim().toLowerCase()) || PLACEHOLDER.has(norm(v));
  const tagKey = v => String(v || '').trim().toUpperCase();
  const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const shape = v => String(v).trim().replace(/[0-9]/g, '9').replace(/[A-Za-z]/g, 'A');

  // dates: ISO, or day-first with / - . separators. Returns {ok, d, why}
  function parseDate(v) {
    const s = String(v || '').trim();
    let y, m, d;
    let r = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (r) { y = +r[1]; m = +r[2]; d = +r[3]; }
    else if ((r = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/))) { d = +r[1]; m = +r[2]; y = +r[3]; }
    else return { ok: false, why: 'not a date this checker can read' };
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return { ok: false, why: 'that day does not exist' };
    return { ok: true, d: dt };
  }

  // level names: "L12", "P1", "GF" are codes. "Level 12", "Floor 12", "12F" are written another way.
  function levelStyle(v) {
    const s = String(v).trim();
    if (/^[A-Za-z]{1,3}\d{0,4}$/.test(s)) return 'code';
    if (/^\d+\s*[A-Za-z]{1,2}$/.test(s)) return 'number-first';
    if (/^(level|floor|lvl|flr)\s*\d+$/i.test(s)) return 'words';
    return 'other';
  }
  function levelParts(v) {
    const s = String(v).trim();
    let r = s.match(/^([A-Za-z]{1,3})(\d{1,4})$/);
    if (r) return { prefix: r[1].toUpperCase(), n: +r[2], width: r[2].length };
    r = s.match(/^(?:level|floor|lvl|flr)\s*(\d+)$/i) || s.match(/^(\d+)\s*[A-Za-z]{1,2}$/);
    if (r) return { prefix: null, n: +r[1] };
    return null;
  }

  // Asset-type clusters: "FCU", "F.C.U", "Fan coil", "Fan Coil Unit" are one thing.
  function typeClusters(values) {
    const uniq = [...new Set(values.map(v => String(v)))].filter(v => !isBlank(v));
    const parent = new Map(uniq.map(v => [v, v]));
    const find = v => { while (parent.get(v) !== v) v = parent.get(v); return v; };
    const join = (a, b) => { const x = find(a), y = find(b); if (x !== y) parent.set(x, y); };
    const words = v => String(v).toLowerCase().replace(/\(.*?\)/g, ' ').split(/[^a-z0-9]+/).filter(Boolean);
    const info = uniq.map(v => {
      const w = words(v);
      return { v, k: w.join(''), ini: w.length > 1 ? w.map(x => x[0]).join('') : '', dotted: norm(v) };
    });
    for (let i = 0; i < info.length; i++) for (let j = i + 1; j < info.length; j++) {
      const a = info[i], b = info[j];
      const same = a.k === b.k || a.dotted === b.dotted
        || (a.ini.length >= 2 && (a.ini === b.k || a.ini === b.dotted))
        || (b.ini.length >= 2 && (b.ini === a.k || b.ini === a.dotted))
        || (a.k.length >= 6 && b.k.length >= 6 && (a.k.startsWith(b.k) || b.k.startsWith(a.k)));
      if (same) join(a.v, b.v);
    }
    const groups = new Map();
    for (const v of uniq) { const r = find(v); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(v); }
    return [...groups.values()];
  }

  // ------------------------------------------------------------------ the checks
  const CHECKS = {
    dupRow:      { dim: 'Uniqueness',   title: 'Rows entered twice', why: 'The same asset is counted twice, so every total that includes it is wrong.' },
    dupTag:      { dim: 'Uniqueness',   title: 'Two assets, one tag', why: 'Ask about one asset and you get the other one\'s history mixed in.' },
    tagFormat:   { dim: 'Consistency',  title: 'Tag written differently', why: 'To a machine, "pdt-l12-fcu-004" and "PDT-L12-FCU-004 " are not the same tag.' },
    missing:     { dim: 'Completeness', title: 'Required field empty', why: 'A blank level, criticality or PPM frequency means the asset drops out of any answer that needs it.' },
    serial:      { dim: 'Completeness', title: 'No serial number', why: 'No serial means no warranty claim and no recall check.' },
    typeDrift:   { dim: 'Consistency',  title: 'Same asset type, spelled several ways', why: '"FCU", "F.C.U" and "Fan Coil Unit" get counted as three different things.' },
    systemDrift: { dim: 'Consistency',  title: 'Filed under the wrong system', why: 'A fan coil unit filed under Plumbing won\'t come back when you ask about HVAC.' },
    levelFormat: { dim: 'Consistency',  title: 'Level written another way', why: '"Level 12" and "L12" are two different floors to a machine.' },
    levelOdd:    { dim: 'Validity',     title: 'Level that may not exist', why: 'A level with only one asset on it, when every other level has dozens, is usually a typo.' },
    dateBad:     { dim: 'Validity',     title: 'Date that can\'t be read', why: 'A day that doesn\'t exist breaks every age and warranty calculation on that row.' },
    dateFormat:  { dim: 'Consistency',  title: 'Date in a different format', why: '04/05/2024: April or May? A machine has to guess.' },
    dateFuture:  { dim: 'Validity',     title: 'Installed in the future', why: 'Usually a typo in the year. Age and warranty answers go wrong.' },
    warrantyOrder: { dim: 'Validity',   title: 'Warranty ends before install', why: 'A typo, and it decides who pays for the next repair.' },
    orphan:      { dim: 'Validity',     title: 'Parent asset not in the register', why: '"What does this unit depend on?" has no answer when the parent tag points nowhere.' },
    gap:         { dim: 'Coverage',     title: 'Assets missing from a floor', why: 'The floors around it have them. If they\'re missing here, any count for this floor is wrong.' },
  };
  const DIMS = ['Completeness', 'Uniqueness', 'Consistency', 'Validity', 'Coverage'];

  function analyze(table, map, opts = {}) {
    const today = opts.today ? new Date(opts.today + 'T00:00:00Z') : new Date();
    const H = table.headers, R = table.rows;
    const get = (r, k) => (map[k] == null ? '' : (r[map[k]] == null ? '' : r[map[k]]));
    const issues = Object.fromEntries(Object.keys(CHECKS).map(k => [k, []]));
    const add = (check, i, field, value, note) => issues[check].push({ row: i + 2, i, tag: get(R[i], 'tag'), field, value, note });
    const N = R.length;

    // duplicates
    const seenRow = new Map(), copies = new Set();
    R.forEach((r, i) => {
      const k = r.join('\u0001');
      if (seenRow.has(k)) { copies.add(i); add('dupRow', i, '', '', `same as row ${seenRow.get(k) + 2}`); }
      else seenRow.set(k, i);
    });
    if (map.tag != null) {
      const byTag = new Map();
      R.forEach((r, i) => { if (copies.has(i)) return; const t = tagKey(get(r, 'tag')); if (!t || isBlank(t)) return; if (!byTag.has(t)) byTag.set(t, []); byTag.get(t).push(i); });
      for (const [t, is] of byTag) if (is.length > 1) for (const i of is) add('dupTag', i, FIELDS.tag.label, get(R[i], 'tag'), `${is.length} rows share ${t}`);
      const upperShare = R.filter(r => { const t = String(get(r, 'tag')).trim(); return t && t === t.toUpperCase(); }).length / Math.max(1, N);
      R.forEach((r, i) => {
        const t = String(get(r, 'tag'));
        if (!t || isBlank(t)) return;
        if (t !== t.trim()) add('tagFormat', i, FIELDS.tag.label, JSON.stringify(t), 'extra spaces');
        else if (upperShare > 0.9 && t !== t.toUpperCase()) add('tagFormat', i, FIELDS.tag.label, t, 'lower case, unlike the rest');
      });
    }

    // completeness
    R.forEach((r, i) => {
      for (const k of REQUIRED) if (map[k] != null && isBlank(get(r, k))) add('missing', i, FIELDS[k].label, get(r, k), 'empty or placeholder');
      if (map.serial != null && isBlank(get(r, 'serial'))) add('serial', i, FIELDS.serial.label, get(r, 'serial'), get(r, 'serial') ? 'placeholder' : 'empty');
    });

    // asset types: naming drift, then system drift within each type
    const typeOf = new Array(N).fill(null);
    if (map.type != null) {
      const vals = R.map(r => get(r, 'type'));
      const count = new Map(); vals.forEach(v => count.set(v, (count.get(v) || 0) + 1));
      for (const g of typeClusters(vals)) {
        const main = g.reduce((a, b) => (count.get(b) > count.get(a) ? b : a));
        R.forEach((r, i) => {
          const v = vals[i];
          if (!g.includes(v)) return;
          typeOf[i] = main;
          if (v !== main) add('typeDrift', i, FIELDS.type.label, v, `most rows say "${main}"`);
        });
      }
      if (map.system != null) {
        const byType = new Map();
        R.forEach((r, i) => { if (!typeOf[i]) return; if (!byType.has(typeOf[i])) byType.set(typeOf[i], []); byType.get(typeOf[i]).push(i); });
        for (const [t, is] of byType) {
          if (is.length < 5) continue;
          const c = new Map(); is.forEach(i => { const s = get(R[i], 'system'); c.set(s, (c.get(s) || 0) + 1); });
          const [top, n] = [...c].sort((a, b) => b[1] - a[1])[0];
          if (n / is.length < 0.8) continue;
          for (const i of is) { const s = get(R[i], 'system'); if (s !== top && !isBlank(s)) add('systemDrift', i, FIELDS.system.label, s, `${n} of ${is.length} ${t} rows say "${top}"`); }
        }
      }
    }

    // levels: format, then levels that look like typos
    const levelOf = new Array(N).fill(null);
    if (map.level != null) {
      const styles = new Map();
      R.forEach(r => { const v = get(r, 'level'); if (!isBlank(v)) { const s = levelStyle(v); styles.set(s, (styles.get(s) || 0) + 1); } });
      const mainStyle = [...styles].sort((a, b) => b[1] - a[1])[0]?.[0];
      // the prefix most coded levels use ("L" in L01..L80), and its usual number width
      const pc = new Map();
      R.forEach(r => { const p = levelParts(get(r, 'level')); if (p && p.prefix) pc.set(p.prefix, (pc.get(p.prefix) || 0) + 1); });
      const mainPrefix = [...pc].sort((a, b) => b[1] - a[1])[0]?.[0];
      const widths = R.map(r => levelParts(get(r, 'level'))).filter(p => p && p.prefix === mainPrefix).map(p => p.width);
      const w = median(widths) || 2;
      const canon = p => (p.prefix || mainPrefix) + String(p.n).padStart(w, '0');
      R.forEach((r, i) => {
        const v = get(r, 'level');
        if (isBlank(v)) return;
        if (mainStyle && levelStyle(v) !== mainStyle) add('levelFormat', i, FIELDS.level.label, v, 'written differently from the other levels');
        const p = levelParts(v);
        levelOf[i] = p ? canon(p) : String(v).trim().toUpperCase();
      });
      const perLevel = new Map(); levelOf.forEach(l => { if (l) perLevel.set(l, (perLevel.get(l) || 0) + 1); });
      const inMain = [...perLevel].filter(([l]) => mainPrefix && l.startsWith(mainPrefix));
      const typical = median(inMain.map(x => x[1]));
      if (typical >= 10) for (const [l, n] of inMain) if (n <= 2) R.forEach((r, i) => { if (levelOf[i] === l) add('levelOdd', i, FIELDS.level.label, get(r, 'level'), `only ${n} asset${n > 1 ? 's' : ''} on ${l}; typical level has ${typical}`); });

      // coverage: a type on nearly every typical level, missing or thin on one of them
      if (map.type != null && typical >= 10) {
        const real = inMain.filter(([, n]) => n > 2).map(([l]) => l);
        const nums = real.map(l => +l.slice(mainPrefix.length)).sort((a, b) => a - b);
        const range = [];
        for (let n = nums[0]; n <= nums[nums.length - 1]; n++) range.push(mainPrefix + String(n).padStart(w, '0'));
        const counts = new Map();   // type -> level -> n
        R.forEach((r, i) => { if (!typeOf[i] || !levelOf[i]) return; if (!counts.has(typeOf[i])) counts.set(typeOf[i], new Map()); const m = counts.get(typeOf[i]); m.set(levelOf[i], (m.get(levelOf[i]) || 0) + 1); });
        const gaps = [];
        for (const [t, m] of counts) {
          const present = range.filter(l => (m.get(l) || 0) > 0);
          if (range.length < 10 || present.length / range.length < 0.8) continue;
          const med = median(present.map(l => m.get(l)));
          for (const l of range) {
            const n = m.get(l) || 0;
            if (n < med * 0.5) gaps.push({ level: l, type: t, found: n, expected: Math.round(med) });
          }
        }
        for (const g of gaps) issues.gap.push({ row: '', i: -1, tag: '', field: g.level, value: `${g.found} ${g.type}`, note: `${g.level} has ${g.found}; a typical level has ${g.expected}`, level: g.level, type: g.type, missing: g.expected - g.found });
      }
    }

    // dates
    for (const k of ['install', 'warranty']) {
      if (map[k] == null) continue;
      const shapes = new Map();
      R.forEach(r => { const v = get(r, k); if (!isBlank(v)) { const s = shape(v); shapes.set(s, (shapes.get(s) || 0) + 1); } });
      const mainShape = [...shapes].sort((a, b) => b[1] - a[1])[0]?.[0];
      R.forEach((r, i) => {
        const v = get(r, k);
        if (isBlank(v)) return;
        const p = parseDate(v);
        if (!p.ok) { add('dateBad', i, FIELDS[k].label, v, p.why); return; }
        if (shape(v) !== mainShape) add('dateFormat', i, FIELDS[k].label, v, 'different format from the other dates');
        if (k === 'install' && p.d > today) add('dateFuture', i, FIELDS[k].label, v, 'after today');
      });
    }
    if (map.install != null && map.warranty != null) R.forEach((r, i) => {
      const a = parseDate(get(r, 'install')), b = parseDate(get(r, 'warranty'));
      if (a.ok && b.ok && b.d < a.d) add('warrantyOrder', i, FIELDS.warranty.label, get(r, 'warranty'), `installed ${get(r, 'install')}`);
    });

    // parents
    if (map.parent != null && map.tag != null) {
      const tags = new Set(R.map(r => tagKey(get(r, 'tag'))));
      R.forEach((r, i) => { const p = get(r, 'parent'); if (!isBlank(p) && !tags.has(tagKey(p))) add('orphan', i, FIELDS.parent.label, p, 'no asset has this tag'); });
    }

    // ------------------------------------------------------------ score
    // Score = assets with no problem found, out of all assets (rows, plus the ones a floor is missing).
    // A rubric for this tool, not an industry standard.
    const bad = new Set();
    const perDim = Object.fromEntries(DIMS.map(d => [d, { rows: new Set(), issues: 0 }]));
    for (const [k, list] of Object.entries(issues)) for (const it of list) {
      perDim[CHECKS[k].dim].issues++;
      if (it.i >= 0) { bad.add(it.i); perDim[CHECKS[k].dim].rows.add(it.i); }
    }
    const missing = issues.gap.reduce((s, g) => s + g.missing, 0);
    const total = N + missing;
    const clean = N - bad.size;
    const score = total ? Math.floor((clean / total) * 1000) / 10 : 0;
    const verdict = score >= 98 ? 'Ready' : score >= 90 ? 'Close' : 'Not yet';
    const checks = Object.entries(issues).filter(([, l]) => l.length).map(([k, list]) => ({ key: k, ...CHECKS[k], count: list.length, items: list }))
      .sort((a, b) => b.count - a.count);
    return {
      rows: N, columns: H, map, score, verdict, clean, flaggedRows: bad.size, missingAssets: missing,
      dims: DIMS.map(d => ({ name: d, rows: perDim[d].rows.size, issues: perDim[d].issues })),
      checks,
    };
  }

  // ------------------------------------------------------------------ against an answer key (sample files only)
  const DEFECT_TO_CHECK = {
    DUP_TAG: ['dupTag'], DUP_ROW: ['dupRow'], TAG_FORMAT: ['tagFormat'], MISSING_LEVEL: ['missing'], BAD_LEVEL: ['levelOdd'],
    LEVEL_FORMAT: ['levelFormat'], TYPE_DRIFT: ['typeDrift'], SERIAL_PLACEHOLDER: ['serial'], MISSING_CRITICALITY: ['missing'],
    MISSING_PPM: ['missing'], WARRANTY_BEFORE_INSTALL: ['warrantyOrder'], FUTURE_INSTALL: ['dateFuture'], IMPOSSIBLE_DATE: ['dateBad'],
    DATE_FORMAT: ['dateFormat'], ORPHAN_PARENT: ['orphan'], WRONG_SYSTEM: ['systemDrift'], MISSING_ASSETS: ['gap'],
  };
  function scoreAgainstKey(result, key) {
    const flagged = new Map();     // "row|check" for row issues, "gap|level|type" for gaps
    for (const c of result.checks) for (const it of c.items) {
      if (c.key === 'gap') flagged.set(`gap|${it.level}|${it.type}`, it);
      else flagged.set(`${it.row}|${c.key}`, it);
    }
    const found = [], missed = [];
    const explained = new Set();
    for (const k of key) {
      const checks = DEFECT_TO_CHECK[k.defect] || [];
      const hit = k.defect === 'MISSING_ASSETS'
        ? checks.some(c => flagged.has(`gap|${k.level}|${k.type}`))
        : checks.some(c => flagged.has(`${k.row}|${c}`));
      (hit ? found : missed).push(k);
      if (k.defect === 'MISSING_ASSETS') explained.add(`gap|${k.level}|${k.type}`);
      else for (const c of checks) explained.add(`${k.row}|${c}`);
    }
    // Flags with no planted problem of their own. Most are knock-on effects of one, and are labelled as such:
    // the other row of a duplicated tag, a second check tripping on an already broken row, or a floor that
    // looks thin because one of its assets lost its level.
    const keyRows = new Set(key.filter(k => k.row).map(k => String(k.row)));
    const dupTags = new Set(key.filter(k => k.defect === 'DUP_TAG').map(k => String(k.messy).trim().toUpperCase()));
    const lostLevel = key.filter(k => k.defect === 'MISSING_LEVEL' || k.defect === 'BAD_LEVEL');
    const extra = [];
    for (const [id, it] of flagged) {
      if (explained.has(id)) continue;
      let because = '';
      if (id.endsWith('|dupTag') && dupTags.has(String(it.value).trim().toUpperCase())) because = 'the other row of a planted duplicate tag';
      else if (keyRows.has(String(it.row))) because = 'a second check tripping on a row with a planted problem';
      else if (id.startsWith('gap|') && lostLevel.some(k => k.clean === it.level && k.type === it.type)) because = 'that floor\'s asset lost its level in a planted problem';
      extra.push({ id, ...it, because });
    }
    const falseAlarms = extra.filter(e => !e.because);
    return { planted: key.length, found: found.length, missed, extra, falseAlarms };
  }

  const api = { parseCSV, detectColumns, analyze, scoreAgainstKey, FIELDS, CHECKS, DIMS, REQUIRED };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Checker = api;
})(typeof window !== 'undefined' ? window : globalThis);
