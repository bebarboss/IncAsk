# IncAsk

แอป Windows สำหรับจัดหมวดหมู่อินซิเดนต์/ทิกเก็ตจากไฟล์ CSV หรือ Excel ด้วย LLM ของบริษัทผ่าน Gateway (LiteLLM)
แล้วสรุปผลเป็น pivot ในแอป — แอปพี่น้องของ [DocAsk](https://github.com/bebarboss/local_notebook)

> สถานะ: กำลังพัฒนา (ขั้นที่ 3 ตาม `SPEC.md` ข้อ 17 — โปรเจกต์ สร้าง/สลับ/ลบ + SQLite ต่อโปรเจกต์)

## ต้องติดตั้งก่อน

- **Node.js** 20 ขึ้นไป
- **Rust** (stable, ผ่าน [rustup](https://rustup.rs)) — target `x86_64-pc-windows-msvc`
- **Visual Studio Build Tools** พร้อม workload "Desktop development with C++"
- WebView2 Runtime (มีใน Windows 10/11 อยู่แล้ว)

## คำสั่ง

```powershell
npm install
npm run dev          # เปิดในเบราว์เซอร์ http://localhost:5173 (mock mode อัตโนมัติ)
npm run dev:mock     # บังคับ mock mode แม้รันใน Tauri
npm run tauri:mock   # แอปจริง (หน้าต่าง Tauri) ด้วยข้อมูล mock ไม่ต้องใส่ API key — ใช้ port 5180
npm run tauri dev    # แอปจริง ต่อ Gateway จริง
npm run typecheck
cd src-tauri; cargo test; cargo clippy --all-targets
npm run tauri build  # ตัวติดตั้ง MSI + NSIS (src-tauri/target/release/bundle)
```

## Mock mode

เปิดเองเมื่อไม่ได้รันใน Tauri หรือเมื่อตั้ง `INCASK_MOCK=1` — ใช้ข้อมูลตัวอย่างทั้งหมด (3 โปรเจกต์, 4 เซอร์วิส, ผลจัดหมวด 3 เดือน,
งานจัดหมวดจำลอง, ข้อมูลการใช้งาน) **ไม่เรียกเครือข่าย** และมีป้าย `MOCK MODE` มุมขวาล่าง

ตัวช่วยดูหน้าต่างๆ ผ่าน URL: `?page=setup`, `?page=classify`, `?page=results`, `?page=summary`, `?page=settings`, `?page=app`, `?page=usage`
และ `?gateway=down` เพื่อจำลองตอนต่อ VPN ไม่ได้, `?budget=high` / `?budget=full` ดูหลอดการใช้งานตอนใกล้เต็มงบ (ส้ม / แดง)
โมเดล `godev3` ใน mock จำลองกรณีไม่มีสิทธิ์ใช้โมเดล (403) เพื่อลองเปลี่ยนโมเดลแล้วทดสอบใหม่

ใน mock mode **ไม่ต้องใส่ API key** — ปุ่มทดสอบการเชื่อมต่อผ่านได้เลย

## การใส่ API Key

ใส่ผ่านหน้า **ตั้งค่าครั้งแรก** หรือ **ตั้งค่าโปรแกรม › Gateway และโมเดล** เท่านั้น
Key ถูกเก็บใน **Windows Credential Manager** (ชื่อ `IncAsk/Gateway`) ฝั่ง Rust เป็นคนแนบ key ตอนเรียก Gateway
ไม่มี key อยู่ในไฟล์ใดๆ, log, ข้อความ error หรือไฟล์ส่งออก — frontend รู้แค่ว่ามี key แล้วหรือยัง และ 4 ตัวท้าย

## ที่เก็บข้อมูล

- `%APPDATA%\IncAsk\app.json` — ค่าโปรแกรม (ไม่มี key)
- `%APPDATA%\IncAsk\projects\` — ฐานข้อมูล SQLite หนึ่งไฟล์ต่อโปรเจกต์ (ขั้นที่ 3)

## แก้ปัญหาที่พบบ่อย

| อาการ | ตรวจ |
|---|---|
| ต่อ Gateway ไม่ได้ | ต่อ VPN บริษัทแล้วลองใหม่ · ตรวจ Gateway URL และ proxy ของเครื่อง |
| 401 | Virtual Key หมดอายุ ผิด หรือถูก revoke — ใส่ key ใหม่ |
| 403 | ไม่มีสิทธิ์ใช้โมเดลนี้ ตรวจสิทธิ์กับ Admin |
| 404 | Gateway URL หรือชื่อโมเดลไม่ถูกต้อง |
| 429 | เกินโควตา RPM, TPM หรือ budget — รอสักครู่ |
| `npm run dev` ขึ้น port 5173 ถูกใช้ | ปิดโปรแกรมอื่นที่ใช้ port นี้ (เช่น DocAsk dev) หรือรัน `npx vite --port 5180` |
