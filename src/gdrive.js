'use strict';
// Free off-PC backup to the customer's own Google Drive.
// Scope: drive.file  (the app can only see files it created itself, in a folder called "Mr GROOM Backups").
// Sign-in: system browser + loopback redirect + PKCE. The Gmail address typed by the customer is checked
// against the account that actually signs in, so the data is linked to that address.
const crypto = require('crypto');
const http = require('http');

const SCOPE = 'openid email https://www.googleapis.com/auth/drive.file';
const FOLDER = 'Mr GROOM Backups';
const KEEP = 90;
const b64u = b => Buffer.from(b).toString('base64url');
const day = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

class Drive {
  // opts: { clientId, clientSecret, fetch, openUrl, seal(str)->str, unseal(str)->str, read(), write(obj), now() }
  constructor(o) {
    this.o = o; this.fetch = o.fetch || globalThis.fetch; this.now = o.now || (() => new Date());
    this.st = o.read() || {};            // { email, token(sealed refresh token), folderId, lastOk, lastErr, lastDay }
    this.access = null; this.accessExp = 0;
  }
  save() { this.o.write(this.st); }
  configured() { return !!(this.o.clientId && this.o.clientSecret) && !/^__/.test(this.o.clientId); }
  connected() { return !!(this.st.token && this.st.email); }
  status() {
    const t = this.now(); let warn = '';
    if (!this.connected()) warn = 'Google Drive backup is not set up.';
    else if (this.st.lastErr) warn = 'Last upload failed: ' + this.st.lastErr;
    else if (!this.st.lastOk) warn = 'No backup has reached Google Drive yet.';
    else { const d = Math.floor((t - new Date(this.st.lastOk)) / 864e5); if (d >= 3) warn = 'The last Google Drive backup was ' + d + ' days ago.'; }
    return { configured: this.configured(), connected: this.connected(), email: this.st.email || '', lastOk: this.st.lastOk || null, lastErr: this.st.lastErr || null, warn };
  }
  needsToday() { return this.connected() && this.st.lastDay !== day(this.now()); }

  async form(url, params) {
    const r = await this.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error_description || j.error || ('HTTP ' + r.status)); return j;
  }

  // ---- sign in ----
  async connect(email) {
    email = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: 'Enter a valid Gmail address.' };
    if (!this.configured()) return { ok: false, error: 'Google Drive linking is not set up in this copy of the program yet. Please contact your supplier.' };
    const verifier = b64u(crypto.randomBytes(32)), challenge = b64u(crypto.createHash('sha256').update(verifier).digest()), state = b64u(crypto.randomBytes(12));
    const code = await new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://127.0.0.1'); if (u.pathname !== '/') { res.writeHead(404); return res.end(); }
        const err = u.searchParams.get('error'), c = u.searchParams.get('code'), s = u.searchParams.get('state');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body style="font:16px Arial;text-align:center;margin-top:80px"><h2>' + (c && !err && s === state ? 'Connected. You can close this tab and go back to Mr GROOM Manager.' : 'Sign-in was not completed. You can close this tab.') + '</h2></body></html>');
        clearTimeout(timer); srv.close();
        if (err) reject(new Error(err === 'access_denied' ? 'Sign-in was cancelled.' : err)); else if (!c || s !== state) reject(new Error('Sign-in failed.')); else resolve(c);
      });
      const timer = setTimeout(() => { srv.close(); reject(new Error('Sign-in timed out. Please try again.')); }, 5 * 60000);
      srv.listen(0, '127.0.0.1', () => {
        this.redirect = 'http://127.0.0.1:' + srv.address().port;
        const q = new URLSearchParams({ client_id: this.o.clientId, redirect_uri: this.redirect, response_type: 'code', scope: SCOPE, code_challenge: challenge, code_challenge_method: 'S256', login_hint: email, access_type: 'offline', prompt: 'consent', state });
        this.o.openUrl('https://accounts.google.com/o/oauth2/v2/auth?' + q);
      });
    }).catch(e => ({ error: e.message }));
    if (code.error) return { ok: false, error: code.error };
    let tok;
    try { tok = await this.form('https://oauth2.googleapis.com/token', { code, client_id: this.o.clientId, client_secret: this.o.clientSecret, redirect_uri: this.redirect, grant_type: 'authorization_code', code_verifier: verifier }); }
    catch (e) { return { ok: false, error: 'Google refused the sign-in: ' + e.message }; }
    let got = ''; try { got = String(JSON.parse(Buffer.from(tok.id_token.split('.')[1], 'base64url').toString()).email || '').toLowerCase(); } catch (e) {}
    if (got !== email) return { ok: false, error: 'You signed in as ' + (got || 'a different account') + ', but you entered ' + email + '. Please sign in with the same Gmail address.' };
    if (!tok.refresh_token) return { ok: false, error: 'Google did not return a long-term permission. Remove "Mr GROOM Manager" at myaccount.google.com/permissions and try again.' };
    this.st = { email, token: this.o.seal(tok.refresh_token), folderId: null, lastOk: null, lastErr: null, lastDay: null };
    this.access = tok.access_token; this.accessExp = this.now().getTime() + (tok.expires_in - 60) * 1000; this.save();
    return { ok: true, email };
  }
  disconnect() { this.st = {}; this.access = null; this.save(); return { ok: true }; }

  async token() {
    if (this.access && this.accessExp > this.now().getTime()) return this.access;
    const j = await this.form('https://oauth2.googleapis.com/token', { client_id: this.o.clientId, client_secret: this.o.clientSecret, refresh_token: this.o.unseal(this.st.token), grant_type: 'refresh_token' });
    this.access = j.access_token; this.accessExp = this.now().getTime() + (j.expires_in - 60) * 1000; return this.access;
  }
  async api(method, url, body, headers = {}) {
    const t = await this.token();
    const r = await this.fetch(url, { method, headers: { Authorization: 'Bearer ' + t, ...headers }, body });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error((j.error && (j.error.message || j.error)) || ('HTTP ' + r.status)); }
    return r;
  }
  async folder() {
    if (this.st.folderId) return this.st.folderId;
    const q = encodeURIComponent("name='" + FOLDER + "' and mimeType='application/vnd.google-apps.folder' and trashed=false");
    const l = await (await this.api('GET', 'https://www.googleapis.com/drive/v3/files?q=' + q + '&fields=files(id)')).json();
    if (l.files && l.files[0]) this.st.folderId = l.files[0].id;
    else { const c = await (await this.api('POST', 'https://www.googleapis.com/drive/v3/files?fields=id', JSON.stringify({ name: FOLDER, mimeType: 'application/vnd.google-apps.folder' }), { 'Content-Type': 'application/json' })).json(); this.st.folderId = c.id; }
    this.save(); return this.st.folderId;
  }
  async list() {
    const fid = await this.folder(), q = encodeURIComponent("'" + fid + "' in parents and trashed=false");
    const j = await (await this.api('GET', 'https://www.googleapis.com/drive/v3/files?q=' + q + '&orderBy=name%20desc&pageSize=200&fields=files(id,name,modifiedTime,size)')).json();
    return j.files || [];
  }
  // upload one backup (the same name on the same day is replaced); keeps the newest KEEP files
  async upload(name, text) {
    try {
      const fid = await this.folder(), files = await this.list(), ex = files.find(f => f.name === name);
      const bd = 'mrg' + crypto.randomBytes(8).toString('hex');
      const meta = ex ? { name } : { name, parents: [fid] };
      const body = '--' + bd + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) + '\r\n--' + bd + '\r\nContent-Type: application/json\r\n\r\n' + text + '\r\n--' + bd + '--';
      const url = ex ? 'https://www.googleapis.com/upload/drive/v3/files/' + ex.id + '?uploadType=multipart' : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
      await this.api(ex ? 'PATCH' : 'POST', url, body, { 'Content-Type': 'multipart/related; boundary=' + bd });
      const all = ex ? files : [{ name }, ...files]; const old = files.filter(f => f.name !== name).sort((a, b) => (a.name < b.name ? 1 : -1)).slice(KEEP - 1);
      for (const f of old) { try { await this.api('DELETE', 'https://www.googleapis.com/drive/v3/files/' + f.id); } catch (e) { /* ignore */ } }
      this.st.lastOk = this.now().toISOString(); this.st.lastDay = day(this.now()); this.st.lastErr = null; this.save();
      return { ok: true, name };
    } catch (e) {
      this.st.lastErr = e.message; this.save(); return { ok: false, error: e.message };
    }
  }
  async download(id) { return (await this.api('GET', 'https://www.googleapis.com/drive/v3/files/' + id + '?alt=media')).text(); }
}
module.exports = { Drive, FOLDER, KEEP, day };
