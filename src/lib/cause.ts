// ต้นเหตุของปัญหา — the AI's call on whether a ticket comes from the user or the program.
// Stored as user | program | unclear; null = not assessed (classified before this existed).

export type Cause = "user" | "program" | "unclear";
export const CAUSES: Cause[] = ["user", "program", "unclear"];
export const CAUSE_LABEL: Record<string, string> = { user: "ผู้ใช้", program: "โปรแกรม", unclear: "ไม่ชัดเจน" };
export const CAUSE_HINT: Record<string, string> = {
  user: "ใช้งานผิดวิธี ตั้งค่าผิด ไม่เข้าใจวิธีใช้ ลืมรหัส กรอกข้อมูลผิด",
  program: "บั๊ก error ระบบล่มหรือช้า ข้อมูลในระบบผิด ทำงานไม่ตรงที่ควร",
  unclear: "ข้อความไม่พอจะบอกได้",
};
/** pivot/filter value for tickets without a ต้นเหตุ — same text as pivot.rs */
export const NOT_ASSESSED = "(ยังไม่ประเมิน)";

export const causeLabel = (c: string | null | undefined): string => (c ? CAUSE_LABEL[c] ?? c : NOT_ASSESSED);
