//! "Reply exactly: GOSOFT LITELLM OK" connection test (DocAsk SPEC §3 flow), ported from DocAsk.

use crate::llm::{self, ChatMessage};
use serde::Serialize;
use std::time::{Duration, Instant};

pub const PROMPT: &str = "Reply exactly: GOSOFT LITELLM OK";
pub const EXPECTED: &str = "GOSOFT LITELLM OK";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub model: String,
    pub ok: bool,
    pub reply: Option<String>,
    pub error: Option<String>,
    pub status: Option<u16>,
    pub elapsed_ms: u64,
    pub unreachable: bool,
}

/// Pass when the reply contains the phrase, ignoring case and surrounding whitespace.
pub fn passes(reply: &str) -> bool {
    let collapsed = reply.split_whitespace().collect::<Vec<_>>().join(" ").to_uppercase();
    collapsed.contains(EXPECTED)
}

pub async fn test_model(chat_url: &str, model: &str, key: &str) -> TestResult {
    let messages = [ChatMessage::new("user", PROMPT)];
    let req = llm::Request {
        url: chat_url,
        key,
        model,
        messages: &messages,
        max_tokens: Some(2048),
        json_mode: false,
        timeout: Duration::from_secs(90),
    };
    let t = Instant::now();
    let r = llm::complete(&req).await;
    let elapsed_ms = t.elapsed().as_millis() as u64;
    match r {
        Ok(c) => {
            let ok = passes(&c.content);
            let shown: String = c.content.trim().chars().take(120).collect();
            TestResult {
                model: model.to_string(),
                ok,
                error: (!ok).then(|| format!("ได้คำตอบแต่ไม่ตรง: \"{shown}\"")),
                reply: Some(shown),
                status: Some(200),
                elapsed_ms,
                unreachable: false,
            }
        }
        Err(e) => TestResult {
            model: model.to_string(),
            ok: false,
            reply: None,
            unreachable: e.is_unreachable(),
            status: e.status,
            error: Some(e.message),
            elapsed_ms,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pass_rules() {
        assert!(passes("GOSOFT LITELLM OK"));
        assert!(passes("  gosoft litellm ok \n"));
        assert!(passes("GOSOFT  LITELLM\nOK"));
        assert!(!passes("GOSOFT OK"));
    }
}
