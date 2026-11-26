# DECISIONS

การตัดสินใจที่ SPEC ไม่ได้ระบุ หรือที่ต่างจากคำสั่ง/ดีไซน์ — เลือกทางที่ง่ายและสอดคล้องกับ DocAsk

## ขั้นที่ 1

1. **ต้นแบบ DocAsk อยู่ที่ `../notebookLM`** ไม่ใช่ `../local_notebook` (remote เดียวกัน `bebarboss/local_notebook`) — อ่านอย่างเดียว ไม่ได้แก้ไฟล์ใดในนั้น
2. **ดีไซน์**: ยังไม่มีไฟล์ PNG ใน `design/` จึงดึงซอร์ส artboard (`.dc.html`) จาก canvas "IncAsk UI" มาไว้ที่ `design/project/` และอ้างอิงจากซอร์สแทนภาพ
3. **Gateway URL ค่าเริ่มต้น** = `https://agent-gateway.gosoft.co.th` ตาม SPEC ข้อ 3 (ดีไซน์ใช้ placeholder `https://[gateway-ของบริษัท]`) — ยึด SPEC
4. **ที่เก็บ Gateway URL**: อยู่ใน `app.json` ตาม SPEC ข้อ 4.1 (DocAsk แยกเป็น `gateway.json` + `models.json`) ไม่มีไฟล์ `models.json` — โมเดลเลือกจาก `GET /v1/models` ถ้า Gateway ไม่คืนรายการใช้ 6 โมเดลตั้งต้นของ DocAsk
5. **Credential Manager target** = `IncAsk/Gateway` (แยกจาก DocAsk เพื่อไม่ให้สองแอปทับ key กัน) — ผู้ใช้จึงต้องใส่ key ใน IncAsk แยกอีกครั้ง
6. **ตัดจาก DocAsk**: streaming, tool calling, `/user/daily/activity`, VS Code model import, tray/autostart/single-instance, OCR/pdfium/embedding/RAG/chat/coding ทั้งหมด
7. **llm.rs**: เพิ่ม `temperature: 0`, `response_format` (เปิด/ปิดได้), อ่าน `usage` และ header `x-litellm-response-cost` ไว้ล่วงหน้า; การ fallback เมื่อ Gateway ไม่รองรับ `response_format` และ semaphore/backoff ทำในขั้น 6
8. **ทดสอบการเชื่อมต่อ** = `GET /v1/models` แล้วส่ง "Reply exactly: GOSOFT LITELLM OK" ไปที่โมเดลที่เลือก 1 โมเดล (DocAsk ทดสอบทุกโมเดล — IncAsk ใช้โมเดลเดียวจัดหมวด)
9. **Updater**: `pubkey` และ endpoint เป็นค่าว่างตาม SPEC ข้อ 16 → ปิด `createUpdaterArtifacts` ไว้ก่อน (ไม่มี key เซ็น) จะเปิดในขั้น 11 เมื่อ IT ให้ pubkey; ถ้าไม่มี URL หน้าเกี่ยวกับจะขึ้น "ยังไม่ได้ตั้ง URL อัปเดต — ติดต่อ IT"
10. **file association `.incask`** และ shell-open capability ยังไม่ใส่ — ทำในขั้น 9/11
11. **แถบ "Gateway ต่อไม่ได้"** แสดงเฉพาะในหน้านำเข้าไฟล์และจัดหมวด (หน้าที่ต้องใช้ Gateway) ตาม SPEC ข้อ 11.5 — หน้าผลลัพธ์/สรุปผลไม่แสดง
12. **Tauri backend ในขั้นนี้**: command ที่ยังไม่มีฝั่ง Rust (โปรเจกต์, หมวดหมู่, นำเข้า, ผลลัพธ์, pivot, usage) คืน error `not_implemented` ("ส่วนนี้ยังไม่ได้ทำในเวอร์ชันนี้") ยกเว้น `listProjects` คืนรายการว่าง และ `classifyStatus` คืน null เพื่อให้หน้าว่างแสดงแทนข้อผิดพลาด
13. **Mock**: ชื่อผู้ใช้ตัวอย่าง "Somchai" (ไม่ใช้ชื่อจริงจากดีไซน์), ข้อมูลทิกเก็ตสร้างแบบ deterministic จากจำนวนในดีไซน์ (ส.ค.–ต.ค. 2569), เพิ่มเซอร์วิส "Smart Home" ในกล่องสรุปนำเข้าเพื่อโชว์สถานะ "ไม่มีหมวดหมู่"; ตัวช่วย URL `?page=setup|import|classify|results|summary|settings|app|usage` และ `?gateway=down`
14. **ไอคอนแอป**: สร้างเองจาก SVG (`src-tauri/icons/app-icon.svg`, ตัว "I" บนพื้นเขียว #217346) ด้วย `tauri icon`
15. **ชิป "ไม่มั่นใจ"/สีขึ้น-ลง**: ▲ ใช้สีส้มเข้ม `--up-text` (#9B4508 จากดีไซน์), ▼ ใช้ `--ok-text` — มีลูกศรเสมอ ไม่ใช้สีอย่างเดียว
