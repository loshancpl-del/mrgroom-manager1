'use strict';
// Seller tool: puts the logins back to admin / admin without touching business data.
// Usage: node scripts/reset-admin.js [path to mrgroom-data.json]   (close the program first)
const fs = require('fs');
const os = require('os');
const path = require('path');
const file = process.argv[2] || path.join(os.homedir(), 'Desktop', 'MrGroom', 'Data', 'mrgroom-data.json');
if (!fs.existsSync(file)) { console.error('Data file not found: ' + file); process.exit(1); }
const j = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!j.data || typeof j.data !== 'object') { console.error('Not a Mr GROOM data file.'); process.exit(1); }
fs.copyFileSync(file, file + '.before-reset-' + Date.now() + '.bak');
delete j.data.crt_users;
fs.writeFileSync(file, JSON.stringify(j));
console.log('Done. All users were removed; the program will create admin / admin on next start. Business data was not changed.');
