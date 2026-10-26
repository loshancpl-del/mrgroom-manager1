'use strict';
// Turns the web app (source/coat-business-manager.html) into the desktop page (renderer/app.html):
//  - storage goes through the desktop data folder instead of the browser
//  - Chart.js is loaded from a local file (works offline)
//  - backups use the automatic backup system
//  - a strict Content-Security-Policy is added
// Optional: --obfuscate scrambles the app script.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const SHIM = `<script>
/* desktop storage: everything is kept in the data folder, not in the browser */
const LS=(function(){
  if(window.mrg){const c=window.mrg.loadAllSync()||{};
    return{getItem:k=>Object.prototype.hasOwnProperty.call(c,k)?c[k]:null,setItem:(k,v)=>{c[k]=String(v);window.mrg.save(k,String(v))}}}
  return window.localStorage;
})();
</script>`;

const OVERRIDES = `<script>
/* desktop overrides: automatic backups, second backup folder */
(function(){if(!window.mrg)return;
  window.bkInfo=function(){const i=mrg.info();$("bkDir").textContent="Data folder: "+i.dataDir+" · Automatic backups: "+i.backupDir+(i.secondDir?" · Second copy: "+i.secondDir:" · No second local folder (optional).")+" · Google Drive: "+(i.drive&&i.drive.connected?"linked to "+i.drive.email+(i.drive.lastOk?", last upload "+fd(i.drive.lastOk.slice(0,10)):", no upload yet"):"NOT linked. Use the Google Drive menu.")+(i.drive&&i.drive.warn&&i.drive.connected?" ⚠ "+i.drive.warn:"")+(lastClose()?" Last sales close: "+fd(lastClose())+".":"")};
  window.pickDir=async function(){const i=await mrg.chooseSecond();$("bkMsg").className=i&&i.error?"err":"note";$("bkMsg").textContent=i&&i.error?i.error:(i&&i.secondDir?"Second backup folder set.":"No folder selected.");bkInfo()};
  window.doClose=async function(){const m=$("bkMsg");
    try{const r=await mrg.backupNow();if(!r.ok)throw new Error(r.error||(r.errors&&r.errors[0])||"Backup failed");
      try{LS.setItem(KC,isoLocal(new Date()))}catch(e){}
      m.className=r.errors&&r.errors.length?"err":"note";
      m.textContent="✓ Sales closed. Backup saved ("+r.where+")"+(r.drive?". "+r.drive:"")+(r.errors&&r.errors.length?". Problem: "+r.errors[0]:".")
    }catch(e){m.className="err";m.textContent="Backup failed: "+e.message}
    bkInfo();bar()};
  window.autoBk=async function(){};window.loadDir=async function(){bkInfo()};
})();
</script>`;

const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'">`;

function patch(html) {
  let h = html;
  const count = (s, t) => s.split(t).length - 1;
  const n1 = count(h, 'localStorage.getItem(') + count(h, 'localStorage.setItem(');
  if (n1 < 5) throw new Error('Expected several localStorage calls, found ' + n1);
  h = h.split('localStorage.getItem(').join('LS.getItem(').split('localStorage.setItem(').join('LS.setItem(');
  if (h.includes('localStorage.')) throw new Error('Unpatched localStorage use remains');
  const cdn = /<script src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/Chart\.js\/4\.4\.1\/chart\.umd\.min\.js"><\/script>/;
  if (!cdn.test(h)) throw new Error('Chart.js script tag not found');
  h = h.replace(cdn, '<script src="chart.umd.js"></script>');
  h = h.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n' + CSP + '\n' + SHIM);
  if (!h.includes('const LS=')) throw new Error('Shim not inserted');
  if (!h.includes('</body>')) throw new Error('No </body>');
  h = h.replace('</body>', OVERRIDES + '\n</body>');
  return h;
}

function obfuscate(html) {
  let O; try { O = require('javascript-obfuscator'); } catch (e) { console.warn('javascript-obfuscator is not installed; skipping obfuscation (run npm install).'); return html; }
  return html.replace(/<script>\n(const CATS[\s\S]*?)<\/script>/, (m, js) =>
    '<script>\n' + O.obfuscate(js, { compact: true, stringArray: true, stringArrayThreshold: 0.75, rotateStringArray: true, renameGlobals: false, selfDefending: false, controlFlowFlattening: false, identifierNamesGenerator: 'hexadecimal' }).getObfuscatedCode() + '</script>');
}

module.exports = { patch };

if (require.main === module) {
  const src = fs.readFileSync(path.join(ROOT, 'source', 'coat-business-manager.html'), 'utf8');
  let out = patch(src);
  if (process.argv.includes('--obfuscate')) out = obfuscate(out);
  fs.writeFileSync(path.join(ROOT, 'renderer', 'app.html'), out);
  const chart = path.join(ROOT, 'node_modules', 'chart.js', 'dist', 'chart.umd.js');
  if (fs.existsSync(chart)) fs.copyFileSync(chart, path.join(ROOT, 'renderer', 'chart.umd.js'));
  else console.warn('WARNING: chart.js not found. Run "npm install" first, otherwise charts will not draw.');
  console.log('renderer/app.html written (' + Math.round(out.length / 1024) + ' KB).');
}
