# Mr GROOM Manager (desktop) — build guide (for you, the seller)

There is no activation key. Anyone with the installer can install it. The app opens to a login screen inside the page (first login: user `admin`, password `admin`).

## 1. Build the installer (on a Windows PC with internet)
1. Install **Node.js LTS**. In this folder run `npm install`, then `npm test` (all tests must pass).
2. Edit `src\config.js`: vendor name, support phone/e-mail (shown in Help > About) and the two Google values (section 3).
3. `npm run dist` makes the installer in `dist\`. (`npm run dist-secure` also scrambles the page script; this is only a deterrent.)
4. Without a code-signing certificate Windows SmartScreen shows "unknown publisher". A certificate (about USD 100-400 a year) removes that.

## 2. What the customer gets
- Data lives in `Desktop\MrGroom\Data`. Automatic local backups go to `Backups\` every 10 minutes (last 48), one per day (last 90), plus manual ones. An optional extra local folder (USB / other drive) is chosen in File > Choose extra local backup folder.
- **Login:** `admin` / `admin` at first. Header button **Users**: the admin adds users (admin or staff), changes passwords, removes users. Staff cannot see Reset data and cannot restore or disconnect Google Drive. 5 wrong tries lock the screen for 60 seconds.
- **Reset data** button: asks for the password `admin` (admin users only). No hint is displayed. Users are kept when data is reset.
- **Google Drive:** the first time an admin logs in, a panel asks for the customer's Gmail; "Link Google Drive" opens the Google sign-in in the web browser (this cannot be avoided: Google only allows sign-in in a browser). The Google account must match the typed Gmail. A backup (`MrGroom-YYYY-MM-DD.json`, newest 90 kept) is uploaded daily, on Close of Sales, and at start-up if today's is missing. Restore: Google Drive button > Show backups > Restore.

## 3. Google Cloud setup (once, by you)
1. console.cloud.google.com: new project, enable **Google Drive API**.
2. OAuth consent screen: External, app name "Mr GROOM Manager", scope `.../auth/drive.file` (the app can only see its own folder).
3. Credentials: OAuth client ID, type **Desktop app**. Put the ID and secret in `src\config.js` (`googleClientId`, `googleClientSecret`). Until you do, "Link Google Drive" shows an error.
4. **Publish the app** (In production). In *Testing* mode Google expires the sign-in after 7 days and only listed test users can use it, which breaks daily backups. Customers may see an "unverified app" notice once. Check Google's current rules; I could not test this.

## 4. Test checklist on a real Windows PC
- [ ] Install, open: login screen appears; admin/admin works; wrong password refused.
- [ ] Users: add a staff user, log in as staff (no Reset button), change a password.
- [ ] Google Drive: link with a Gmail; a different Google account is refused; file appears in Drive; Restore works.
- [ ] Reset data needs `admin`; Close of Sales makes a local backup and a Drive upload.
- [ ] Delete `Desktop\MrGroom` and reopen: the app offers to restore.

## 5. Honest limits
- The login is a screen inside the page. It keeps casual users out but does not encrypt anything: someone with Windows access can open the data files, and with the default admin/admin the shop must change the password.
- Without activation keys you cannot stop copying or resale of the installer.
- Offline use works; the Drive backup needs internet and a valid Google sign-in.
- Not tested on real Windows or with real Google. Printing and PDFs use English fonts only.
