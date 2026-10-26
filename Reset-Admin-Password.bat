@echo off
cd /d "%~dp0"
echo Close Mr GROOM Manager first. This sets the logins back to admin / admin. Business data is not changed.
pause
node scripts\reset-admin.js "%USERPROFILE%\Desktop\MrGroom\Data\mrgroom-data.json"
pause
