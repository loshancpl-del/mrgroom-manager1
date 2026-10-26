'use strict';
// Data lives in <root>\Data\mrgroom-data.json (written atomically, with a .bak of the previous version).
// Rolling snapshots go to <root>\Backups\{auto,daily,manual,prerestore} and are mirrored to a second folder.
const fs = require('fs');
const path = require('path');

const FIRST_RUN = { crt_rows: '[]', crt_inv: '[]', crt_exp: '[]', crt_shop: '{"prod":[],"sales":[]}', crt_cu: '{}' };
const KEEP = { auto: 48, daily: 90, manual: 200, prerestore: 20 };
const pad = n => String(n).padStart(2, '0');
const stamp = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const dayOf = d => stamp(d).slice(0, 8);
const readData = f => {
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return j && j.data && typeof j.data === 'object' && !Array.isArray(j.data) ? j.data : null;
  } catch (e) { return null; }
};

class Store {
  constructor(root, o = {}) {
    this.root = root; this.o = o; this.now = o.now || (() => new Date());
    this.second = o.secondDir || null;
    this.dataDir = path.join(root, 'Data');
    this.backupDir = path.join(root, 'Backups');
    this.file = path.join(this.dataDir, 'mrgroom-data.json');
    this.data = {}; this.timer = null; this.dirty = false;
    this.lastAuto = 0; this.lastDaily = ''; this.lastSnap = null; this.errors = [];
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.mkdirSync(this.backupDir, { recursive: true });
  }

  // status: ok | recovered | missing-with-backups | new
  load() {
    let d = readData(this.file);
    if (d) { this.data = d; return { status: 'ok' }; }
    d = readData(this.file + '.bak');
    if (d) { this.data = d; this.dirty = true; this.flush(); return { status: 'recovered', from: 'previous copy' }; }
    const latest = this.listBackups()[0];
    if (latest) return { status: 'missing-with-backups', latest };
    this.data = { ...FIRST_RUN }; this.dirty = true; this.flush();
    return { status: 'new' };
  }

  set(k, v) {
    this.data[k] = String(v); this.dirty = true;
    if (!this.timer) this.timer = setTimeout(() => { try { this.flush(); } catch (e) { this.errors.push(e.message); } }, this.o.debounceMs ?? 800);
  }

  flush() {
    clearTimeout(this.timer); this.timer = null;
    if (!this.dirty && fs.existsSync(this.file)) return false;
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ app: 'mrgroom', version: 1, saved: this.now().toISOString(), data: this.data }));
    if (fs.existsSync(this.file)) fs.copyFileSync(this.file, this.file + '.bak');
    fs.renameSync(tmp, this.file);
    this.dirty = false;
    this.afterWrite();
    return true;
  }

  afterWrite() {
    const t = this.now().getTime();
    if (t - this.lastAuto >= (this.o.autoEveryMs ?? 600000)) {
      this.snapshot('auto'); this.snapshot('daily'); this.lastAuto = t;
    }
  }

  snapshot(kind) {
    const d = this.now();
    const name = kind === 'daily' ? `daily-${dayOf(d)}.json` : `${kind}-${stamp(d)}.json`;
    const body = JSON.stringify({ app: 'mrgroom', version: 1, kind, saved: d.toISOString(), data: this.data });
    const written = [], errors = [];
    const bases = [this.backupDir, this.second ? path.join(this.second, 'MrGroom-Backups') : null];
    bases.forEach((base, i) => {
      if (!base) return;
      try {
        const dir = path.join(base, kind);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, name), body);
        this.prune(dir, kind);
        written.push(path.join(dir, name));
      } catch (e) { errors.push((i ? 'Second folder: ' : 'Backups: ') + e.message); this.errors.push(e.message); }
    });
    if (written.length) this.lastSnap = d.toISOString();
    return { written, errors };
  }

  prune(dir, kind) {
    const l = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
    while (l.length > KEEP[kind]) fs.unlinkSync(path.join(dir, l.shift()));
  }

  backupNow() {
    this.flush();
    const a = this.snapshot('manual'), b = this.snapshot('daily');
    const files = a.written.concat(b.written), errors = a.errors.concat(b.errors);
    return { ok: files.length > 0, files, errors, where: files.length ? [...new Set(files.map(f => path.dirname(path.dirname(f))))].join(' and ') : '' };
  }

  listBackups() {
    const out = [], seen = new Set();
    for (const base of [this.backupDir, this.second ? path.join(this.second, 'MrGroom-Backups') : null]) {
      if (!base) continue;
      for (const kind of Object.keys(KEEP)) {
        let l = []; try { l = fs.readdirSync(path.join(base, kind)); } catch (e) { continue; }
        for (const f of l) {
          const m = f.match(/^(\w+)-(\d{8})(?:-(\d{6}))?\.json$/);
          if (!m) continue;
          const key = m[1] + m[2] + (m[3] || '');
          const full = path.join(base, kind, f);
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ kind: m[1], file: f, path: full, sort: m[2] + (m[3] || '999999') });
        }
      }
    }
    return out.sort((a, b) => (a.sort < b.sort ? 1 : a.sort > b.sort ? -1 : 0));
  }

  readBackup(file) {
    const d = readData(file);
    if (!d || typeof d.crt_rows !== 'string') return null;
    try { if (!Array.isArray(JSON.parse(d.crt_rows))) return null; } catch (e) { return null; }
    return d;
  }

  restore(file) {
    const d = this.readBackup(file);
    if (!d) return { ok: false, error: 'That file is not a valid Mr GROOM backup.' };
    if (Object.keys(this.data).length) this.snapshot('prerestore');
    this.data = d; this.dirty = true; this.flush();
    return { ok: true };
  }

  setSecond(dir) {
    this.second = dir || null;
    if (!dir) return { ok: true };
    const r = this.snapshot('daily');
    return r.errors.length ? { ok: false, error: r.errors[0] } : { ok: true };
  }

  info() {
    return { root: this.root, dataDir: this.dataDir, backupDir: this.backupDir, secondDir: this.second, lastSnap: this.lastSnap, error: this.errors[this.errors.length - 1] || null };
  }
}

module.exports = { Store, FIRST_RUN, KEEP };
