'use strict';
// Run with:  node test/run-tests.js   (no Electron needed; tests the license, data, backup and page-patching logic)
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { Store, FIRST_RUN } = require('../src/store');
const paths = require('../src/paths');
const { patch } = require('../scripts/prepare-app');
const { Drive } = require('../src/gdrive');
const http = require('http');

let pass = 0, fail = 0;
const queue = [];
const test = (name, fn) => queue.push([name, fn]);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mrg-'));

// ---------------- store / backups ----------------
const clock = start => { let t = new Date(start).getTime(); return { now: () => new Date(t), adv: ms => { t += ms; } }; };
test('first run creates folders and an empty data file (no demo data)', () => {
  const root = tmp(), s = new Store(root, { now: clock('2026-10-23T09:00:00').now });
  assert.strictEqual(s.load().status, 'new');
  assert.ok(fs.existsSync(path.join(root, 'Data', 'mrgroom-data.json'))); assert.ok(fs.existsSync(path.join(root, 'Backups')));
  assert.strictEqual(s.data.crt_rows, '[]');
});
test('writes are saved, previous version kept as .bak, reload returns the data', () => {
  const root = tmp(), c = clock('2026-10-23T09:00:00'), s = new Store(root, { now: c.now, debounceMs: 5 });
  s.load(); s.set('crt_rows', '[{"id":1}]'); s.flush(); s.set('crt_rows', '[{"id":1},{"id":2}]'); s.flush();
  assert.ok(fs.existsSync(s.file + '.bak'));
  const s2 = new Store(root, { now: c.now }); assert.strictEqual(s2.load().status, 'ok'); assert.strictEqual(s2.data.crt_rows, '[{"id":1},{"id":2}]');
});
test('automatic snapshots: every 10 minutes at most, one daily file per day', () => {
  const root = tmp(), c = clock('2026-10-23T09:00:00'), s = new Store(root, { now: c.now });
  s.load(); const count = k => fs.readdirSync(path.join(root, 'Backups', k)).length;
  assert.strictEqual(count('auto'), 1);
  c.adv(60000); s.set('crt_rows', '[1]'); s.flush(); assert.strictEqual(count('auto'), 1);
  c.adv(11 * 60000); s.set('crt_rows', '[2]'); s.flush(); assert.strictEqual(count('auto'), 2); assert.strictEqual(count('daily'), 1);
  c.adv(24 * 3600000); s.set('crt_rows', '[3]'); s.flush(); assert.strictEqual(count('daily'), 2);
});
test('old snapshots are pruned (keeps 48 auto)', () => {
  const root = tmp(), c = clock('2026-10-23T09:00:00'), s = new Store(root, { now: c.now, autoEveryMs: 0 });
  s.load(); for (let i = 0; i < 60; i++) { c.adv(1000); s.set('crt_rows', '[' + i + ']'); s.flush(); }
  assert.strictEqual(fs.readdirSync(path.join(root, 'Backups', 'auto')).length, 48);
});
test('second backup folder gets a mirror copy; a broken second folder is reported but does not stop the main backup', () => {
  const root = tmp(), second = tmp(), c = clock('2026-10-23T09:00:00'), s = new Store(root, { now: c.now, secondDir: second });
  s.load(); const r = s.backupNow(); assert.ok(r.ok); assert.strictEqual(r.errors.length, 0);
  assert.ok(fs.readdirSync(path.join(second, 'MrGroom-Backups', 'manual')).length >= 1);
  const blocker = path.join(tmp(), 'file'); fs.writeFileSync(blocker, 'x');
  s.second = path.join(blocker, 'sub'); const r2 = s.backupNow(); assert.ok(r2.ok); assert.ok(r2.errors.length >= 1);
});
test('data folder deleted by accident: backups are found and restore the data', () => {
  const root = tmp(), c = clock('2026-10-23T09:00:00'), s = new Store(root, { now: c.now });
  s.load(); s.set('crt_rows', '[{"id":7,"name":"Keep me"}]'); s.flush(); s.backupNow();
  fs.rmSync(path.join(root, 'Data'), { recursive: true });
  const s2 = new Store(root, { now: c.now }); const r = s2.load();
  assert.strictEqual(r.status, 'missing-with-backups'); assert.ok(r.latest.path);
  assert.ok(s2.restore(r.latest.path).ok); assert.strictEqual(s2.data.crt_rows, '[{"id":7,"name":"Keep me"}]');
});
test('everything deleted except the second folder: still recoverable', () => {
  const root = tmp(), second = tmp(), c = clock('2026-10-23T09:00:00'), s = new Store(root, { now: c.now, secondDir: second });
  s.load(); s.set('crt_rows', '[{"id":9}]'); s.flush(); s.backupNow();
  fs.rmSync(root, { recursive: true });
  const s2 = new Store(root, { now: c.now, secondDir: second }); const r = s2.load();
  assert.strictEqual(r.status, 'missing-with-backups'); s2.restore(r.latest.path); assert.strictEqual(s2.data.crt_rows, '[{"id":9}]');
});
test('corrupt data file recovers from the previous copy', () => {
  const root = tmp(), c = clock('2026-10-23T09:00:00'), s = new Store(root, { now: c.now });
  s.load(); s.set('crt_rows', '[{"id":1}]'); s.flush(); s.set('crt_rows', '[{"id":1},{"id":2}]'); s.flush();
  fs.writeFileSync(s.file, '{ broken');
  const s2 = new Store(root, { now: c.now }); assert.strictEqual(s2.load().status, 'recovered'); assert.strictEqual(s2.data.crt_rows, '[{"id":1}]');
});
test('restore validates the file and saves a safety copy first', () => {
  const root = tmp(), c = clock('2026-10-23T09:00:00'), s = new Store(root, { now: c.now });
  s.load(); s.set('crt_rows', '[{"id":1}]'); s.flush(); const bad = path.join(root, 'bad.json'); fs.writeFileSync(bad, '{"data":{"x":1}}');
  assert.strictEqual(s.restore(bad).ok, false);
  s.backupNow(); const good = s.listBackups()[0].path; c.adv(5000);
  s.set('crt_rows', '[{"id":99}]'); s.flush(); assert.ok(s.restore(good).ok);
  assert.strictEqual(s.data.crt_rows, '[{"id":1}]'); assert.ok(fs.readdirSync(path.join(root, 'Backups', 'prerestore')).length === 1);
});

// ---------------- drive choice ----------------
test('data and backup folders are on the Desktop, with a separate backup-copy folder', () => {
  const r = paths.detect({}, { desktop: 'C:\\Users\\Shop\\Desktop', home: 'C:\\Users\\Shop', canWrite: () => true });
  assert.strictEqual(path.basename(r.root), 'MrGroom'); assert.ok(r.root.includes('Desktop')); assert.ok(r.second.includes('Desktop') && /MrGroom-Backup-Copy$/.test(r.second)); assert.notStrictEqual(r.root, r.second);
});
test('unwritable Desktop falls back to Documents', () => {
  const r = paths.detect({}, { desktop: '/x/Desktop', home: '/home/u', canWrite: d => !d.includes('Desktop') });
  assert.ok(r.root.includes('Documents') && r.second.includes('Documents'));
});
test('real Desktop folders get created and used', () => {
  const home = tmp(); const r = paths.detect({}, { home, desktop: path.join(home, 'Desktop') });
  const st = new Store(r.root, { secondDir: r.second }); st.load(); st.set('crt_rows', '[]'); st.flush(); assert.ok(st.backupNow().ok);
  assert.ok(fs.existsSync(path.join(home, 'Desktop', 'MrGroom', 'Data', 'mrgroom-data.json'))); assert.ok(fs.existsSync(path.join(home, 'Desktop', 'MrGroom-Backup-Copy', 'MrGroom-Backups')));
});

// ---------------- desktop page ----------------
const SRC = fs.readFileSync(path.join(__dirname, '..', 'source', 'coat-business-manager.html'), 'utf8');
const html = patch(SRC);
test('patched page: no browser storage left, local Chart.js, CSP present', () => {
  assert.ok(!/localStorage\./.test(html.replace(/return window\.localStorage;/, '')));
  assert.ok(html.includes('<script src="chart.umd.js"></script>')); assert.ok(!/cdnjs\.cloudflare/.test(html));
  assert.ok(/Content-Security-Policy/.test(html)); assert.ok(html.includes('const LS='));
});
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
test('patched scripts compile', () => { scripts.forEach(s => new vm.Script(s)); assert.ok(scripts.length >= 3); });

function makeCtx(mrg, localStorage) {
  const els = {};
  const el = id => els[id] || (els[id] = { id, _v: '', get value() { return this._v; }, set value(x) { this._v = String(x); }, innerHTML: '', textContent: '', style: {}, dataset: {}, disabled: false, checked: false, options: [], className: '', files: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, addEventListener() {}, click() {} });
  const ctx = { document: { body: { classList: { add() {}, remove() {} } }, head: { appendChild() {} }, getElementById: el, querySelectorAll: () => [], querySelector: () => ({ dataset: { t: 'tx' } }), createElement: () => el('_a'), documentElement: {} },
    getComputedStyle: () => ({ getPropertyValue: () => '#000' }), matchMedia: () => ({ addEventListener() {} }), scrollTo() {}, URL: { createObjectURL: () => '' }, Blob: function () {},
    console, setTimeout, clearTimeout, navigator: {}, mrg, localStorage };
  ctx.window = ctx; vm.createContext(ctx); scripts.forEach(s => vm.runInContext(s, ctx)); ctx.$$ = el; return ctx;
}
const run = (ctx, code) => vm.runInContext(code, ctx);
test('desktop page starts empty (no sample data) and every screen renders', async () => {
  const store = { ...FIRST_RUN }, saved = [];
  const mrg = { loadAllSync: () => store, save: (k, v) => { store[k] = v; saved.push(k); }, info: () => ({ dataDir: 'D:\\MrGroom\\Data', backupDir: 'D:\\MrGroom\\Backups', secondDir: null }), backupNow: async () => ({ ok: true, where: 'D:\\MrGroom\\Backups', errors: [] }), chooseSecond: async () => ({ secondDir: 'E:\\B' }) };
  const ctx = makeCtx(mrg);
  assert.strictEqual(run(ctx, 'rows.length'), 0); assert.strictEqual(run(ctx, 'INV.length'), 0); assert.strictEqual(run(ctx, 'SHOP.prod.length'), 0); assert.strictEqual(run(ctx, 'EXP.length'), 0);
  for (const f of ['renderTx', 'renderOut', 'renderInv', 'renderShop', 'renderTail', 'renderExp', 'renderCat', 'renderDay', 'renderMon', 'renderRet', 'initRep']) run(ctx, f + '()');
  run(ctx, '$("pT").value="d";$("pD").value=isoLocal(new Date());genRep();outRep();outCsv();');
  // add an order through the form: it must reach the data folder
  run(ctx, `$("fDate").value="2026-10-23";$("fPhone").value="0771234567";$("fName").value="Test";$("fCat").value="Coat Rent";$("fPt").value="Cash";$("fCost").value="9000";$("fAdv").value="3000";addTx();`);
  assert.strictEqual(run(ctx, 'rows.length'), 1); assert.ok(saved.includes('crt_rows'));
  assert.strictEqual(JSON.parse(store.crt_rows).length, 1); assert.strictEqual(JSON.parse(store.crt_rows)[0].adv, 3000);
  // Close of Sales uses the automatic backup system
  await run(ctx, 'doClose()'); assert.ok(/Sales closed/.test(ctx.$$('bkMsg').textContent), ctx.$$('bkMsg').textContent);
  assert.ok(saved.includes('crt_rows') && run(ctx, 'lastClose()') !== '');
  run(ctx, 'bkInfo()'); assert.ok(/D:\\MrGroom\\Data/.test(ctx.$$('bkDir').textContent));
});
test('without the desktop bridge the page still works in a browser (falls back to browser storage)', () => {
  const mem = {}; const ls = { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); } };
  const ctx = makeCtx(undefined, ls);
  assert.strictEqual(run(ctx, 'rows.length'), 0);       // no sample data any more
  run(ctx, 'save()'); assert.ok('crt_rows' in mem);
});


// ---------------- in-page login ----------------
function loginCtx() {
  const store = { ...FIRST_RUN }; const mrg = { loadAllSync: () => store, save: (k, v) => { store[k] = v; }, info: () => ({ dataDir: 'D', backupDir: 'B', secondDir: null }), backupNow: async () => ({ ok: true, where: 'B', errors: [] }),
    drive: { status: async () => ({ connected: false }), connect: async () => ({ ok: true }), backupNow: async () => ({ ok: true }) } };
  const ctx = makeCtx(mrg); ctx.crypto = require('crypto').webcrypto; ctx.TextEncoder = TextEncoder; return { ctx, store };
}
test('login: default admin/admin works, wrong password refused, password stored hashed', async () => {
  const { ctx, store } = loginCtx(); await run(ctx, 'seedUsers()');
  const u = JSON.parse(store.crt_users); assert.strictEqual(u.length, 1); assert.strictEqual(u[0].u, 'admin'); assert.ok(!JSON.stringify(u).includes('"admin","h"') && u[0].h.length === 64 && u[0].h !== 'admin');
  run(ctx, '$("lgU").value="admin";$("lgP").value="wrong"'); await run(ctx, 'doLogin()'); assert.match(ctx.$$('lgE').textContent, /Wrong/); assert.strictEqual(run(ctx, 'ME'), null);
  run(ctx, '$("lgP").value="admin"'); await run(ctx, 'doLogin()'); assert.strictEqual(run(ctx, 'ME.role'), 'admin');
});
test('login: 5 wrong attempts lock for a minute', async () => {
  const { ctx } = loginCtx(); await run(ctx, 'seedUsers()');
  for (let i = 0; i < 5; i++) { run(ctx, '$("lgU").value="admin";$("lgP").value="x"'); await run(ctx, 'doLogin()'); }
  run(ctx, '$("lgP").value="admin"'); await run(ctx, 'doLogin()'); assert.match(ctx.$$('lgE').textContent, /Too many/); assert.strictEqual(run(ctx, 'ME'), null);
});
test('users: admin adds staff, staff can log in but cannot see Reset; password change; last admin protected', async () => {
  const { ctx, store } = loginCtx(); await run(ctx, 'seedUsers()');
  run(ctx, '$("lgU").value="admin";$("lgP").value="admin"'); await run(ctx, 'doLogin()'); run(ctx, 'openUsers()');
  run(ctx, '$("usU").value="Sunil";$("usP").value="pw1234";$("usR").value="staff"'); await run(ctx, 'usAdd()'); assert.strictEqual(JSON.parse(store.crt_users).length, 2);
  run(ctx, '$("usU").value="sunil";$("usP").value="pw1234"'); await run(ctx, 'usAdd()'); assert.match(ctx.$$('usE').textContent, /exists/);
  run(ctx, '$("usNp").value="newpass"'); await run(ctx, 'usPw()');
  run(ctx, 'logout()'); run(ctx, '$("lgU").value="admin";$("lgP").value="admin"'); await run(ctx, 'doLogin()'); assert.strictEqual(run(ctx, 'ME'), null);
  run(ctx, '$("lgP").value="newpass"'); await run(ctx, 'doLogin()'); assert.strictEqual(run(ctx, 'ME.user'), 'admin');
  run(ctx, 'logout()'); run(ctx, '$("lgU").value="sunil";$("lgP").value="pw1234"'); await run(ctx, 'doLogin()'); assert.strictEqual(run(ctx, 'ME.role'), 'staff'); assert.strictEqual(ctx.$$('hRst').disabled, true);
  run(ctx, '$("rsPw").value="admin"'); run(ctx, 'doReset()'); assert.ok(run(ctx, 'ME.role') === 'staff' && /Wrong/.test(ctx.$$('rsE').textContent));   // staff can never reset
  run(ctx, 'logout()'); run(ctx, '$("lgU").value="admin";$("lgP").value="newpass"'); await run(ctx, 'doLogin()');
  run(ctx, 'openUsers()'); run(ctx, 'usDel({dataset:{u:"admin"}})'); run(ctx, 'usDel({dataset:{u:"admin",sure:"1"}})'); assert.ok(JSON.parse(store.crt_users).some(x => x.u === 'admin'));
});
test('admin can remove users (two clicks), set another user\'s password, but not remove self or last admin', async () => {
  const { ctx, store } = loginCtx(); await run(ctx, 'seedUsers()');
  run(ctx, '$("lgU").value="admin";$("lgP").value="admin"'); await run(ctx, 'doLogin()'); run(ctx, 'openUsers()');
  run(ctx, '$("usU").value="amal";$("usP").value="pw1234";$("usR").value="staff"'); await run(ctx, 'usAdd()');
  assert.ok(/data-u="amal"[^>]*onclick="usDel/.test(ctx.$$('usT').innerHTML)); assert.ok(!/data-u="admin"[^>]*onclick="usDel/.test(ctx.$$('usT').innerHTML));
  const b = { dataset: { u: 'amal' }, textContent: '' };
  run(ctx, 'usDel').call(null, b); assert.strictEqual(JSON.parse(store.crt_users).length, 2); assert.strictEqual(b.textContent, 'Sure?');
  ctx.$$('up_amal'); ctx.$$('up_amal').value = 'fresh99'; await run(ctx, 'usSet')({ dataset: { u: 'amal' } });
  run(ctx, 'logout()'); run(ctx, '$("lgU").value="amal";$("lgP").value="fresh99"'); await run(ctx, 'doLogin()'); assert.strictEqual(run(ctx, 'ME.user'), 'amal');
  run(ctx, 'logout()'); run(ctx, '$("lgU").value="admin";$("lgP").value="admin"'); await run(ctx, 'doLogin()');
  run(ctx, 'usDel')({ dataset: { u: 'amal', sure: '1' } }); assert.strictEqual(JSON.parse(store.crt_users).length, 1);
  run(ctx, 'usDel')({ dataset: { u: 'admin', sure: '1' } }); assert.strictEqual(JSON.parse(store.crt_users).length, 1);
});
test('only the account named admin can reset, even another admin-type user cannot', async () => {
  const { ctx } = loginCtx(); await run(ctx, 'seedUsers()');
  run(ctx, '$("lgU").value="admin";$("lgP").value="admin"'); await run(ctx, 'doLogin()'); assert.strictEqual(ctx.$$('hRst').disabled, false);
  run(ctx, 'openUsers()'); run(ctx, '$("usU").value="boss";$("usP").value="pw1234";$("usR").value="admin"'); await run(ctx, 'usAdd()');
  run(ctx, 'logout()'); run(ctx, '$("lgU").value="boss";$("lgP").value="pw1234"'); await run(ctx, 'doLogin()'); assert.strictEqual(run(ctx, 'ME.role'), 'admin'); assert.strictEqual(ctx.$$('hRst').disabled, true);
  run(ctx, 'rows.push({id:1,phone:"0771234567",cost:1,adv:0})'); run(ctx, 'openReset()'); run(ctx, '$("rsPw").value="admin"'); run(ctx, 'doReset()'); assert.strictEqual(run(ctx, 'rows.length'), 1);
  run(ctx, 'openUsers()'); assert.ok(!/data-u="admin"[^>]*onclick="usDel/.test(ctx.$$('usT').innerHTML));
});
test('thermal print: narrow receipt for orders and shop sales; PDF stays standard', async () => {
  const { ctx } = loginCtx(); await run(ctx, 'seedUsers()'); let printed = 0; ctx.print = () => { printed++; }; run(ctx, 'window.print=()=>{}');
  run(ctx, 'rows.push({id:3,date:"2026-10-26",phone:"0771234567",name:"A",cat:"Coat Rent",rs:"2026-10-27",rr:"2026-10-29",pt:"Cash",cost:10000,adv:4000,log:[]}); receipt(3); printRc()');
  const h = ctx.$$('thermal').innerHTML; assert.ok(/ORDER RECEIPT/.test(h) && /BALANCE DUE/.test(h) && /Rs\. 6,000/.test(h) && /width:72mm/.test(h) && !/<img/.test(h));
  assert.strictEqual(run(ctx, 'RCDOC().title'), 'Order Receipt');
  run(ctx, 'SHOP.sales.push({id:1,no:"S-1",date:"2026-10-26",name:"",pm:"Cash",disc:0,total:3000,lines:[{desc:"Socks",qty:2,price:1500}]}); showSale(1); $("thW").value="58"; printRc()');
  const h2 = ctx.$$('thermal').innerHTML; assert.ok(/SALES RECEIPT/.test(h2) && /2 x Rs\. 1,500/.test(h2) && /width:48mm/.test(h2));
});
test('Drive button only for the admin account; orders and sales carry date, time and user; notify message', async () => {
  const { ctx } = loginCtx(); await run(ctx, 'seedUsers()');
  run(ctx, '$("lgU").value="admin";$("lgP").value="admin"'); await run(ctx, 'doLogin()'); assert.strictEqual(ctx.$$('hDrv').style.display, '');
  run(ctx, 'openUsers()'); run(ctx, '$("usU").value="boss";$("usP").value="pw1234";$("usR").value="admin"'); await run(ctx, 'usAdd()');
  run(ctx, '$("fDate").value="2026-10-23";$("fPhone").value="0771234567";$("fName").value="Nimal";$("fCat").value="New Coat";$("fPt").value="Cash";$("fCost").value="45000";$("fAdv").value="15000";addTx();');
  assert.strictEqual(run(ctx, 'rows[0].by'), 'admin'); assert.ok(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(run(ctx, 'rows[0].ts')));
  assert.ok(/\d\d:\d\d:\d\d/.test(run(ctx, 'fts(rows[0].ts)'))); assert.ok(/Entered \(date & time\)/.test(ctx.$$('txT').innerHTML));
  assert.ok(/Entered At/.test(run(ctx, 'exportCSV(rows,"x",true)')));
  assert.ok(/\d\d:\d\d:\d\d/.test(run(ctx, 'rcHtml(rows[0])')) && /Time/.test(run(ctx, 'thRc(rows[0])')));
  run(ctx, 'setStage(1,"Stitching Done")'); assert.match(ctx.$$('waM').value, /your order 0000000001 is ready to collect/);
  run(ctx, 'renderTail()'); assert.ok(/Send WhatsApp/.test(ctx.$$('ntL').innerHTML));
  run(ctx, 'logout()'); run(ctx, '$("lgU").value="boss";$("lgP").value="pw1234"'); await run(ctx, 'doLogin()');
  assert.strictEqual(run(ctx, 'ME.role'), 'admin'); assert.strictEqual(ctx.$$('hDrv').style.display, 'none'); run(ctx, 'openDrive()');
  run(ctx, 'logout()');
});
test('reset data: password is "admin", nothing about it is shown, users survive the reset', async () => {
  const { ctx, store } = loginCtx(); await run(ctx, 'seedUsers()');
  run(ctx, '$("lgU").value="admin";$("lgP").value="admin"'); await run(ctx, 'doLogin()');
  run(ctx, '$("fDate").value="2026-10-23";$("fPhone").value="0771234567";$("fName").value="T";$("fCat").value="Coat Rent";$("fPt").value="Cash";$("fCost").value="9000";$("fAdv").value="3000";addTx();');
  assert.strictEqual(run(ctx, 'rows.length'), 1);
  run(ctx, '$("rsBk").checked=false;$("rsPw").value="Reset"'); run(ctx, 'doReset()'); assert.strictEqual(run(ctx, 'rows.length'), 1); assert.strictEqual(ctx.$$('rsE').textContent, 'Wrong password.');
  run(ctx, '$("rsPw").value="admin"'); run(ctx, 'doReset()'); assert.strictEqual(run(ctx, 'rows.length'), 0); assert.strictEqual(JSON.parse(store.crt_users).length, 1);
});
test('drive panel: opens only in the desktop app', async () => {
  const { ctx } = loginCtx(); run(ctx, '$("lgU").value="admin"'); await run(ctx, 'seedUsers()'); run(ctx, '$("lgP").value="admin"'); await run(ctx, 'doLogin()');
  assert.strictEqual(ctx.$$('hDrv').style.display, ''); await run(ctx, 'gdRefresh()'); assert.match(ctx.$$('gdSt').textContent, /Not linked/);
});
// ---------------- Google Drive (mocked Google) ----------------
function fakeGoogle(email, opt = {}) {
  const files = []; let n = 0; const calls = [];
  const fetch = async (url, init = {}) => {
    url = String(url); calls.push((init.method || 'GET') + ' ' + url.split('?')[0]);
    const json = (o, st = 200) => ({ ok: st < 300, status: st, json: async () => o, text: async () => (typeof o === 'string' ? o : JSON.stringify(o)) });
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      const p = new URLSearchParams(init.body);
      if (p.get('grant_type') === 'authorization_code') return json({ access_token: 'AT1', expires_in: 3600, refresh_token: opt.noRefresh ? undefined : 'RT1', id_token: 'x.' + Buffer.from(JSON.stringify({ email })).toString('base64url') + '.y' });
      if (p.get('refresh_token') !== 'RT1') return json({ error: 'invalid_grant' }, 400);
      return json({ access_token: 'AT' + (++n), expires_in: 3600 });
    }
    if (!/Bearer AT/.test(init.headers && init.headers.Authorization)) return json({ error: { message: 'unauth' } }, 401);
    if (opt.failUpload && url.includes('/upload/')) return json({ error: { message: 'quota exceeded' } }, 403);
    if (url.includes('/upload/') ) {
      const m = /name":"([^"]+)"/.exec(init.body)[1], body = init.body.split('\r\n\r\n').pop().replace(/\r\n--mrg.*$/s, '');
      const ex = url.match(/files\/([^?]+)\?uploadType/); if (ex) { const f = files.find(x => x.id === ex[1]); f.text = body; return json({ id: f.id }); }
      const f = { id: 'f' + files.length + Math.random().toString(36).slice(2, 6), name: m, text: body, modifiedTime: '2026-10-26T00:00:00Z' }; files.push(f); return json({ id: f.id });
    }
    if (init.method === 'POST' && url.includes('/drive/v3/files')) { files.push({ id: 'folder1', name: 'Mr GROOM Backups', folder: true }); return json({ id: 'folder1' }); }
    if (init.method === 'DELETE') { const i = files.findIndex(x => url.endsWith(x.id)); if (i >= 0) files.splice(i, 1); return json({}); }
    if (url.includes('alt=media')) return json(files.find(x => url.includes('/' + x.id + '?')).text);
    const q = decodeURIComponent(url);
    if (q.includes('mimeType=')) return json({ files: files.filter(x => x.folder).map(x => ({ id: x.id })) });
    return json({ files: files.filter(x => !x.folder).map(x => ({ id: x.id, name: x.name, modifiedTime: x.modifiedTime })) });
  };
  return { fetch, files, calls };
}
function mkDrive(g, over = {}, st = {}) {
  let saved = st;
  const d = new Drive({ clientId: 'cid', clientSecret: 'sec', fetch: g.fetch, seal: t => 'S:' + t, unseal: t => t.slice(2), read: () => saved, write: o => { saved = o; },
    openUrl: url => { const u = new URL(url); assert.strictEqual(u.searchParams.get('login_hint'), over.hint || 'owner@gmail.com'); assert.strictEqual(u.searchParams.get('code_challenge_method'), 'S256'); assert.strictEqual(u.searchParams.get('scope').includes('drive.file'), true);
      const rq = http.get(u.searchParams.get('redirect_uri') + '/?code=THECODE&state=' + (over.badState ? 'wrong' : u.searchParams.get('state')), r => r.resume()); rq.on('error', () => {}); }, ...over });
  d.saved = () => saved; return d;
}
test('drive: connects when Gmail matches, stores only a sealed refresh token', async () => {
  const g = fakeGoogle('owner@gmail.com'), d = mkDrive(g);
  assert.ok(!d.connected()); const r = await d.connect('Owner@Gmail.com'); assert.ok(r.ok, r.error);
  assert.ok(d.connected()); assert.strictEqual(d.saved().token, 'S:RT1'); assert.ok(!JSON.stringify(d.saved()).includes('AT1'));
});
test('drive: refuses when a different Google account signs in', async () => {
  const g = fakeGoogle('someoneelse@gmail.com'), d = mkDrive(g); const r = await d.connect('owner@gmail.com');
  assert.ok(!r.ok); assert.match(r.error, /someoneelse@gmail.com/); assert.ok(!d.connected());
});
test('drive: bad email, forged state and missing refresh token are rejected', async () => {
  assert.ok(!(await mkDrive(fakeGoogle('a@b.com')).connect('not-an-email')).ok);
  assert.ok(!(await mkDrive(fakeGoogle('owner@gmail.com'), { badState: true }).connect('owner@gmail.com')).ok);
  const r = await mkDrive(fakeGoogle('owner@gmail.com', { noRefresh: true })).connect('owner@gmail.com'); assert.ok(!r.ok); assert.match(r.error, /permission/);
});
test('drive: daily upload creates folder, replaces same-day file, prunes, restores', async () => {
  const g = fakeGoogle('owner@gmail.com'); let now = new Date(2026, 9, 26, 9); const d = mkDrive(g, { now: () => now }); await d.connect('owner@gmail.com');
  assert.ok(d.needsToday()); assert.ok(d.status().warn);
  assert.ok((await d.upload('MrGroom-2026-10-26.json', '{"v":1}')).ok); assert.ok(!d.needsToday()); assert.strictEqual(d.status().warn, '');
  assert.ok((await d.upload('MrGroom-2026-10-26.json', '{"v":2}')).ok);
  assert.strictEqual(g.files.filter(f => !f.folder).length, 1); assert.strictEqual(g.files.find(f => !f.folder).text, '{"v":2}');
  now = new Date(2026, 9, 27, 9); assert.ok(d.needsToday());
  for (let i = 0; i < 95; i++) await d.upload('MrGroom-2025-01-' + String(i).padStart(3, '0') + '.json', '{}');
  assert.ok(g.files.filter(f => !f.folder).length <= 90);
  const list = await d.list(); const f = list.find(x => x.name === 'MrGroom-2026-10-26.json'); assert.ok(f, 'newest day kept');
  assert.strictEqual(await d.download(f.id), '{"v":2}');
});
test('drive: failure is recorded and shown as a warning; stale backups warn', async () => {
  const g = fakeGoogle('owner@gmail.com', { failUpload: true }); let now = new Date(2026, 9, 26); const d = mkDrive(g, { now: () => now }); await d.connect('owner@gmail.com');
  const r = await d.upload('MrGroom-x.json', '{}'); assert.ok(!r.ok); assert.match(d.status().warn, /quota/);
  const g2 = fakeGoogle('owner@gmail.com'), d2 = mkDrive(g2, { now: () => now }); await d2.connect('owner@gmail.com'); await d2.upload('a.json', '{}');
  now = new Date(2026, 9, 31); assert.match(d2.status().warn, /5 days ago/);
});
test('drive: disconnect forgets the account; a restarted app reuses the saved token', async () => {
  const g = fakeGoogle('owner@gmail.com'), d = mkDrive(g); await d.connect('owner@gmail.com');
  const d2 = mkDrive(g, {}, d.saved()); assert.ok(d2.connected()); assert.ok((await d2.upload('n.json', '{}')).ok);
  d2.disconnect(); assert.ok(!d2.connected()); assert.strictEqual(d2.saved().token, undefined);
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
