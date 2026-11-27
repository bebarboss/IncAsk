//! Prompt for one batch of tickets of ONE service (SPEC §6.1).

use crate::taxonomy::{TaxonomyRow, Values};
use serde::Serialize;

/// A category as the model sees it.
#[derive(Debug, Clone, PartialEq)]
pub struct Cat {
    pub code: String,
    pub values: Values,
    pub description: String,
    pub examples: String,
}

impl Cat {
    pub fn from_row(r: &TaxonomyRow) -> Cat {
        Cat { code: r.code.clone(), values: r.values.clone(), description: r.description.clone(), examples: r.examples.clone() }
    }
    pub fn label(&self, columns: &[String]) -> String {
        columns.iter().map(|c| self.values.get(c).map(|s| s.as_str()).unwrap_or("")).collect::<Vec<_>>().join(" › ")
    }
}

fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").replace('|', "/")
}

pub fn system_prompt(service: &str, columns: &[String], cats: &[Cat], few_shot: &[(String, String)]) -> String {
    let mut s = format!(
        "คุณคือผู้จัดหมวดหมู่ทิกเก็ตปัญหาของลูกค้าสำหรับเซอร์วิส \"{service}\"\n\
         เลือกหมวดให้แต่ละทิกเก็ตจาก \"รายการหมวดหมู่\" ด้านล่างเท่านั้น ห้ามสร้างหมวดใหม่ ห้ามแก้ตัวสะกด\n\
         ถ้าไม่มีหมวดไหนตรง ให้ใช้แถวที่เป็น \"อื่นๆ\" ถ้ามี ถ้าไม่มีให้ตอบ null และ confidence ต่ำ\n\
         cause คือต้นเหตุของปัญหา ตอบหนึ่งค่า: \"user\" = เกิดจากผู้ใช้ (ใช้งานผิดวิธี ตั้งค่าผิด ไม่เข้าใจวิธีใช้ ลืมรหัส กรอกข้อมูลผิด), \
         \"program\" = เกิดจากโปรแกรมหรือระบบ (บั๊ก error ระบบล่มหรือช้า ข้อมูลในระบบผิด ทำงานไม่ตรงที่ควร), \
         \"unclear\" = ข้อความไม่พอจะบอกได้ ห้ามเดา\n\
         confidence คือความมั่นใจ 0–1 ของหมวด · reason สั้นไม่เกิน 1 ประโยค ภาษาไทย\n\
         ตอบเป็น JSON ตาม schema เท่านั้น ไม่มีข้อความอื่น: {{\"results\":[{{\"id\":\"r1\",\"code\":\"C01\",\"cause\":\"program\",\"confidence\":0.92,\"reason\":\"...\"}}]}}\n\n\
         รายการหมวดหมู่ (code | {} | คำอธิบาย | ตัวอย่าง):\n",
        columns.join(" | ")
    );
    for c in cats {
        let vals: Vec<String> = columns.iter().map(|col| one_line(c.values.get(col).map(|v| v.as_str()).unwrap_or(""))).collect();
        s.push_str(&format!("{} | {} | {} | {}\n", c.code, vals.join(" | "), one_line(&c.description), one_line(&c.examples)));
    }
    if !few_shot.is_empty() {
        s.push_str("\nตัวอย่างที่คนตรวจแล้ว (ข้อความ → code):\n");
        for (text, code) in few_shot {
            let t: String = one_line(text).chars().take(300).collect();
            s.push_str(&format!("{t} → {code}\n"));
        }
    }
    s
}

#[derive(Serialize)]
struct Item<'a> {
    id: &'a str,
    text: &'a str,
}

#[derive(Serialize)]
struct UserMsg<'a> {
    tickets: Vec<Item<'a>>,
}

/// `{"tickets":[{"id":"r1","text":"…"}]}` — short internal ids, never real ticket numbers.
pub fn user_message(items: &[(String, String)]) -> String {
    serde_json::to_string(&UserMsg { tickets: items.iter().map(|(id, text)| Item { id, text }).collect() }).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cat(code: &str, a: &str, b: &str, d: &str) -> Cat {
        Cat {
            code: code.into(),
            values: [("หัวข้อหลัก".to_string(), a.to_string()), ("หัวข้อย่อย".to_string(), b.to_string())].into_iter().collect(),
            description: d.into(),
            examples: "เน็ตหลุดทุกคืน".into(),
        }
    }

    #[test]
    fn system_prompt_lists_codes_columns_and_examples() {
        let cols = vec!["หัวข้อหลัก".to_string(), "หัวข้อย่อย".to_string()];
        let cats = vec![cat("C01", "การเชื่อมต่อ", "เน็ตหลุดเป็นช่วง", "ใช้งานได้แต่หลุด | เป็นระยะ"), cat("C02", "อื่นๆ", "อื่นๆ", "")];
        let s = system_prompt("Internet", &cols, &cats, &[("หัวข้อ: เน็ตช้า".into(), "C01".into())]);
        assert!(s.contains("สำหรับเซอร์วิส \"Internet\""));
        assert!(s.contains("code | หัวข้อหลัก | หัวข้อย่อย | คำอธิบาย | ตัวอย่าง"));
        assert!(s.contains("C01 | การเชื่อมต่อ | เน็ตหลุดเป็นช่วง | ใช้งานได้แต่หลุด / เป็นระยะ | เน็ตหลุดทุกคืน"));
        assert!(s.contains("หัวข้อ: เน็ตช้า → C01"));
        assert!(s.contains("\"cause\":\"program\"") && s.contains("\"unclear\" = "));
        assert_eq!(cats[0].label(&cols), "การเชื่อมต่อ › เน็ตหลุดเป็นช่วง");
    }

    #[test]
    fn user_message_uses_internal_ids() {
        let m = user_message(&[("r1".into(), "หัวข้อ: \"เน็ตหลุด\"".into())]);
        assert_eq!(m, r#"{"tickets":[{"id":"r1","text":"หัวข้อ: \"เน็ตหลุด\""}]}"#);
    }
}
