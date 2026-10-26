'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

// Letters of fixed (internal) disks on Windows, e.g. ['C','D']
function fixedDrives() {
  if (process.platform !== 'win32') return [];
  try {
    const out = cp.execSync('powershell -NoProfile -Command "Get-CimInstance Win32_LogicalDisk | Where-Object {$_.DriveType -eq 3} | ForEach-Object {$_.DeviceID}"',
      { encoding: 'utf8', timeout: 10000, windowsHide: true });
    const l = out.split(/\r?\n/).map(s => s.trim()[0]).filter(Boolean).map(c => c.toUpperCase());
    if (l.length) return [...new Set(l)];
  } catch (e) { /* fall back to probing */ }
  const l = [];
  for (const c of 'CDEFGHIJKLMNOPQRSTUVWXYZ') { try { if (fs.existsSync(c + ':\\')) l.push(c); } catch (e) {} }
  return l;
}

function canWrite(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, '.w' + process.pid);
    fs.writeFileSync(f, 'x'); fs.unlinkSync(f);
    return true;
  } catch (e) { return false; }
}

// Everything lives on the Desktop (so the customer can see it):
//   Desktop\MrGroom                 Data\ (live data) and Backups\ (automatic copies)
//   Desktop\MrGroom-Backup-Copy     a second copy of every backup, in a separate folder
// If the Desktop cannot be written, Documents is used instead.
function detect(env = process.env, deps = {}) {
  const cw = deps.canWrite || canWrite;
  const home = deps.home || os.homedir();
  const desktop = deps.desktop || path.join(home, 'Desktop');
  let base = desktop;
  if (!cw(path.join(desktop, 'MrGroom'))) base = path.join(home, 'Documents');
  const root = path.join(base, 'MrGroom');
  const copy = path.join(base, 'MrGroom-Backup-Copy');
  return { root, second: cw(copy) ? copy : null };
}

module.exports = { detect, fixedDrives, canWrite };
