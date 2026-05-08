@echo off
chcp 65001 >nul
title T999 LAN USB - Master Server

echo.
echo ========================================
echo  T999 LAN USB - Master Server
echo ========================================
echo.
echo โฟลเดอร์ที่กำลังรัน:
echo %~dp0
echo.
echo ระบบนี้ควรรันจาก USB / External SSD ที่เสียบกับเครื่อง Master
echo.
echo กำลังตรวจสอบ Node.js...
echo.

node -v >nul 2>&1
if errorlevel 1 (
    echo [ERROR] ไม่พบ Node.js ในเครื่องนี้
    echo.
    echo กรุณาติดตั้ง Node.js ก่อนใช้งาน
    echo ดาวน์โหลดได้จาก https://nodejs.org
    echo.
    pause
    exit /b 1
)

echo พบ Node.js แล้ว
echo.
echo กำลังเริ่มระบบ T999 LAN USB...
echo.
echo หลังจากระบบเริ่มแล้ว ให้เปิด:
echo.
echo Master:
echo http://localhost:9999/master
echo.
echo Subkey ในเครื่องเดียวกัน:
echo http://localhost:9999/subkey
echo.
echo ถ้าใช้เครื่องลูกในวง LAN ให้ดู IP ที่ระบบแสดงในหน้าต่างนี้
echo แล้วเปิดจากเครื่อง Subkey เช่น:
echo http://IP-เครื่อง-Master:9999/subkey
echo.
echo ========================================
echo.

cd /d "%~dp0"
node server.js

echo.
echo ระบบหยุดทำงานแล้ว
pause
