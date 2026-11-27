//! Check the model's answer (SPEC §6.2): code must be in the list (or null), every id in the
//! batch must be answered once, confidence must be 0–1. Anything else counts as "missing".

use serde_json::Value;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, PartialEq)]
pub struct Answer {
    pub id: String,
    /// None = the model said no category fits
    pub code: Option<String>,
    pub confidence: f64,
    pub reason: String,
    /// user | program | unclear — None when the model left it out (the category still counts)
    pub cause: Option<String>,
}

/// The model's ต้นเหตุ → user | program | unclear (English or Thai, any case).
pub fn cause_of(v: Option<&Value>) -> Option<String> {
    let s = v?.as_str()?.trim().to_lowercase();
    Some(
        match s.as_str() {
            "user" | "ผู้ใช้" | "ผู้ใช้งาน" | "ลูกค้า" => "user",
            "program" | "system" | "โปรแกรม" | "ระบบ" => "program",
            "unclear" | "unknown" | "ไม่ชัดเจน" | "ไม่แน่ใจ" => "unclear",
            _ => return None,
        }
        .to_string(),
    )
}

/// The first `{ … }` object in the reply (models sometimes wrap JSON in ``` fences or prose).
pub fn extract_json(text: &str) -> Option<Value> {
    if let Ok(v) = serde_json::from_str::<Value>(text.trim()) {
        return Some(v);
    }
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    (end > start).then(|| serde_json::from_str(&text[start..=end]).ok()).flatten()
}

/// (valid answers, ids that still need an answer)
pub fn parse_reply(text: &str, expected: &[String], codes: &HashSet<String>) -> (Vec<Answer>, Vec<String>) {
    let mut ok: HashMap<String, Answer> = HashMap::new();
    if let Some(v) = extract_json(text) {
        let list = v.get("results").and_then(|r| r.as_array()).cloned().or_else(|| v.as_array().cloned()).unwrap_or_default();
        for item in list {
            let Some(id) = item.get("id").and_then(|x| x.as_str()) else { continue };
            if !expected.iter().any(|e| e == id) || ok.contains_key(id) {
                continue;
            }
            let code = match item.get("code") {
                None | Some(Value::Null) => None,
                Some(Value::String(c)) if c.trim().is_empty() || c.trim().eq_ignore_ascii_case("null") => None,
                Some(Value::String(c)) => {
                    let c = c.trim().to_uppercase();
                    if !codes.contains(&c) {
                        continue; // a category that isn't in the table is never saved as a result
                    }
                    Some(c)
                }
                _ => continue,
            };
            let conf = match item.get("confidence") {
                Some(Value::Number(n)) => n.as_f64(),
                Some(Value::String(s)) => s.trim().parse().ok(),
                _ => None,
            };
            let Some(conf) = conf.filter(|c| (0.0..=1.0).contains(c)) else { continue };
            let reason: String = item.get("reason").and_then(|r| r.as_str()).unwrap_or("").trim().chars().take(300).collect();
            let cause = cause_of(item.get("cause"));
            ok.insert(id.to_string(), Answer { id: id.to_string(), code, confidence: conf, reason, cause });
        }
    }
    let missing = expected.iter().filter(|e| !ok.contains_key(*e)).cloned().collect();
    let mut answers: Vec<Answer> = ok.into_values().collect();
    answers.sort_by(|a, b| a.id.cmp(&b.id));
    (answers, missing)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(n: usize) -> Vec<String> {
        (1..=n).map(|i| format!("r{i}")).collect()
    }
    fn codes() -> HashSet<String> {
        ["C01", "C02"].iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn reads_a_clean_answer() {
        let t = r#"{"results":[{"id":"r1","code":"C01","cause":"Program","confidence":0.92,"reason":"หลุดเป็นช่วง"},{"id":"r2","code":"c02","confidence":"0.4","reason":""}]}"#;
        let (a, miss) = parse_reply(t, &ids(2), &codes());
        assert!(miss.is_empty());
        assert_eq!(a[0], Answer { id: "r1".into(), code: Some("C01".into()), confidence: 0.92, reason: "หลุดเป็นช่วง".into(), cause: Some("program".into()) });
        assert_eq!(a[1].cause, None); // no cause → still a valid answer
        assert_eq!(a[1].code.as_deref(), Some("C02"));
        assert_eq!(a[1].confidence, 0.4);
    }

    #[test]
    fn cause_accepts_english_and_thai_only_known_values() {
        let v = |s: &str| cause_of(Some(&Value::String(s.into())));
        assert_eq!(v("user").as_deref(), Some("user"));
        assert_eq!(v(" ผู้ใช้ ").as_deref(), Some("user"));
        assert_eq!(v("ระบบ").as_deref(), Some("program"));
        assert_eq!(v("UNCLEAR").as_deref(), Some("unclear"));
        assert_eq!(v("network"), None);
        assert_eq!(cause_of(None), None);
        assert_eq!(cause_of(Some(&Value::Null)), None);
    }

    #[test]
    fn tolerates_fences_and_prose() {
        let t = "นี่คือผลลัพธ์\n```json\n{\"results\":[{\"id\":\"r1\",\"code\":null,\"confidence\":0.2,\"reason\":\"ไม่ตรงหมวดไหน\"}]}\n```";
        let (a, miss) = parse_reply(t, &ids(1), &codes());
        assert!(miss.is_empty());
        assert_eq!(a[0].code, None);
    }

    #[test]
    fn wrong_code_missing_id_bad_confidence_and_broken_json_are_missing() {
        let t = r#"{"results":[{"id":"r1","code":"C99","confidence":0.9},{"id":"r2","code":"C01","confidence":1.4},{"id":"r9","code":"C01","confidence":0.9},{"id":"r3","code":"C01","confidence":0.8},{"id":"r3","code":"C02","confidence":0.8}]}"#;
        let (a, miss) = parse_reply(t, &ids(4), &codes());
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].id, "r3");
        assert_eq!(a[0].code.as_deref(), Some("C01")); // first answer for an id wins
        assert_eq!(miss, vec!["r1", "r2", "r4"]);
        let (a, miss) = parse_reply("{\"results\": [", &ids(2), &codes());
        assert!(a.is_empty());
        assert_eq!(miss.len(), 2);
    }
}
