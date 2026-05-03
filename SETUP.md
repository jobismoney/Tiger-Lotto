# Tiger999 - คู่มือติดตั้งระบบ WiFi Sync

คู่มือนี้สำหรับ **เจ้ามือ** ที่ต้องการให้ลูกน้อง (sub-key) ใช้งานพร้อมกันในร้าน

---

## 📋 อุปกรณ์ที่ต้องเตรียม

### 1. เครื่อง Master (เจ้ามือใช้)
- คอมพิวเตอร์ Windows
- WiFi เชื่อมต่อกับเราเตอร์
- USB Drive (ตัวที่ 1) — เก็บข้อมูลของเจ้ามือ

### 2. เครื่อง Sub-Key (ลูกน้องใช้)
- Browser: **Chrome** หรือ **Edge** เท่านั้น (Safari/Firefox ไม่ได้)
- USB Drive (ตัวที่ 2, 3, ...) — สำหรับลูกน้องแต่ละคน

### 3. เราเตอร์
- WiFi เดียวกันที่ทุกเครื่องเชื่อมต่อ
- เข้าหน้า admin ได้ (มีรหัสใต้เครื่อง)

---

## 🌐 ขั้นตอน A: ตั้ง Static IP ที่เราเตอร์ ⭐ สำคัญ!

### ทำไมต้องตั้ง?
ปกติเราเตอร์จะแจก IP แบบสุ่ม ทำให้ทุกครั้งที่เปิดเครื่อง IP ของ master เปลี่ยน → ลูกน้องเชื่อมต่อไม่ได้

**วิธีแก้:** ตั้งให้เครื่อง master ใช้ IP เดิมตลอด

### ขั้นตอน:

#### ทั่วไปทุกยี่ห้อ:
1. เปิด browser → ใส่ `192.168.1.1` หรือ `192.168.0.1`
2. ใส่ username/password ของ router (อยู่ใต้เครื่อง)
3. หาเมนู **"DHCP" → "Address Reservation"** หรือ **"Static DHCP"**
4. เพิ่ม:
   - Device Name: เครื่อง Master
   - MAC Address: เลือกเครื่อง Master จากรายการ
   - IP Address: เช่น `192.168.1.100`
5. Save → รีบูทเราเตอร์

#### TP-Link:
```
Advanced → Network → DHCP Server → Address Reservation
```

#### Tenda:
```
System Settings → DHCP Reservation → Add
```

#### ASUS:
```
LAN → DHCP Server → Manually Assigned IP around the DHCP list
```

#### True/3BB/AIS Router:
ส่วนใหญ่อยู่ใน Network → LAN → DHCP Reservation

---

## 💾 ขั้นตอน B: Setup Master (เจ้ามือ)

1. เสียบ **USB-Master** เข้าเครื่อง
2. เปิด browser → `tiger999.online/desktop.html`
3. กด **"USB Mode"** → เลือก folder ของ USB
4. กด **👥 Sub Key** ที่ header
5. กด **🌐 Master Config** ที่ footer ของ modal
6. กด **🔍 ตรวจ** → ระบบหา IP ให้
7. ใส่ Port: `3000` (default)
8. กด **💾 บันทึก**

---

## 👥 ขั้นตอน C: สร้าง USB ให้ลูกน้อง

1. ใน Sub Key Manager → กด **➕ สร้าง Sub Key ใหม่**
2. ใส่:
   - ชื่อลูกน้อง: เช่น "น้อย"
   - จำนวนวันใช้งาน: เช่น 90
3. เสียบ **USB-Sub** เข้าเครื่อง (ของลูกน้อง)
4. กด **💾 USB** ในรายการ "น้อย"
5. เลือก folder ของ USB-Sub
6. ระบบสร้างไฟล์:
   - `tiger999_config.json` — การตั้งค่า (auto)
   - `tiger999_sub-1.json` — ที่เก็บข้อมูล
   - `find-my-ip.bat` — helper หา IP
   - `README.txt` — คู่มือ
7. ถอด USB → ส่งให้ลูกน้อง

---

## 📱 ขั้นตอน D: ลูกน้องเริ่มใช้

1. เสียบ USB ที่เจ้ามือให้
2. เปิด browser (Chrome/Edge): `tiger999.online/subkey.html`
3. กด **"USB Mode"** → เลือก folder ของ USB
4. ✅ ระบบ auto-config → ใช้งานได้ทันที

---

## ❓ Troubleshooting

### Q: กด "ตรวจ IP" แล้วหาไม่เจอ?
A: ใช้ `find-my-ip.bat` ใน USB:
1. Double-click ไฟล์ → จะเห็น IP
2. Copy IP ที่ขึ้นต้นด้วย `192.168.` หรือ `10.`

### Q: ลูกน้องเชื่อมต่อ master ไม่ได้?
- ตรวจว่าเครื่องอยู่ WiFi เดียวกันไหม
- ตรวจ Static IP ที่ตั้งใน router ว่ายังถูกต้อง
- ลอง ping: เปิด cmd → `ping 192.168.1.100`

### Q: USB ของลูกน้องเสีย/หาย?
1. เจ้ามือเปิด Sub Key Manager
2. กด 🗑️ Delete sub key เก่า
3. สร้างใหม่ + ทำ USB ใหม่

### Q: เปลี่ยน Master IP?
- ต้องสร้าง USB ใหม่ทุกตัว (Phase B จะแก้ปัญหานี้ในอนาคต)

---

## 🔐 ความปลอดภัย

### ข้อดีของระบบนี้:
- ✅ Sub Key ไม่ผ่านมือลูกน้อง — เจ้ามือฝังใน USB
- ✅ ลูกน้องลาออก → ขอ USB คืน → ทำลาย
- ✅ ข้อมูลทุกอย่างใน USB ของแต่ละคน — ไม่มี server กลาง
- ✅ ทำงานได้แม้ WiFi ดับ (offline mode)

### ข้อควรระวัง:
- ⚠️ USB หาย = sub key หาย → ขอใหม่จากเจ้ามือ
- ⚠️ อย่าลบไฟล์ใน USB เอง
- ⚠️ ทำ backup folder USB เป็นระยะ

---

## 📞 ติดต่อ

หากต้องการความช่วยเหลือ ติดต่อทีม Tiger999

---

**Version:** Phase A (USB Distribution)
**Next Phase:** Phase B (WiFi Sync — Real-time)
