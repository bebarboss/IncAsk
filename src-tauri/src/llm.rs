//! OpenAI-compatible Chat Completions client for the company Gateway (LiteLLM).
//! The Bearer key is attached here and nowhere else.
//! Ported from DocAsk (llm.rs): shared client, error mapping, `/v1/models`, `/key/info`.
//! Streaming, tool calling and daily-activity are dropped; IncAsk calls are non-streaming with
//! `temperature: 0` and report token usage + LiteLLM's response cost (SPEC §3).

use crate::errors::{AppError, AppResult};
use crate::redact::redact_secret;
use once_cell::sync::Lazy;
use serde::Serialize;
use std::time::Duration;

#[derive(Debug, Clone, Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

impl ChatMessage {
    pub fn new(role: &str, content: impl Into<String>) -> Self {
        Self { role: role.into(), content: content.into() }
    }
}

/// One shared client: system proxy (reqwest reads the Windows proxy settings and
/// HTTP(S)_PROXY) + Windows certificate store via rustls-native-certs.
pub static CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(180))
        .user_agent(concat!("IncAsk/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("http client")
});

#[derive(Serialize)]
struct ResponseFormat {
    #[serde(rename = "type")]
    kind: &'static str,
}

#[derive(Serialize)]
struct Body<'a> {
    model: &'a str,
    messages: &'a [ChatMessage],
    stream: bool,
    temperature: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    response_format: Option<ResponseFormat>,
}

pub struct Request<'a> {
    pub url: &'a str,
    pub key: &'a str,
    pub model: &'a str,
    pub messages: &'a [ChatMessage],
    pub max_tokens: Option<u64>,
    /// send `response_format: {"type":"json_object"}`
    pub json_mode: bool,
    pub timeout: Duration,
}

/// Reply text + what it cost. `cost` is LiteLLM's `x-litellm-response-cost` header when present.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Completion {
    pub content: String,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub cost: Option<f64>,
}

/// Non-streaming chat completion with `temperature: 0`.
pub async fn complete(req: &Request<'_>) -> AppResult<Completion> {
    let body = Body {
        model: req.model,
        messages: req.messages,
        stream: false,
        temperature: 0.0,
        max_tokens: req.max_tokens,
        response_format: req.json_mode.then_some(ResponseFormat { kind: "json_object" }),
    };
    let resp = CLIENT
        .post(req.url)
        .bearer_auth(req.key)
        .json(&body)
        .timeout(req.timeout)
        .send()
        .await
        .map_err(AppError::from)?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        let mut e = AppError::from_status(status.as_u16(), &text);
        e.message = redact_secret(&e.message, Some(req.key));
        return Err(e);
    }
    let cost = resp
        .headers()
        .get("x-litellm-response-cost")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<f64>().ok())
        .filter(|c| c.is_finite() && *c >= 0.0);
    let v: serde_json::Value = resp.json().await.map_err(AppError::from)?;
    let mut c = parse_completion(&v);
    c.cost = cost;
    Ok(c)
}

pub fn parse_completion(v: &serde_json::Value) -> Completion {
    let u = |k: &str| v.pointer(&format!("/usage/{k}")).and_then(|x| x.as_u64()).unwrap_or(0);
    Completion {
        content: v.pointer("/choices/0/message/content").and_then(|c| c.as_str()).unwrap_or_default().to_string(),
        prompt_tokens: u("prompt_tokens"),
        completion_tokens: u("completion_tokens"),
        cost: None,
    }
}

/// GET /v1/models — the model list for the picker; also tells "VPN down" apart from "key bad".
pub async fn list_models(base: &str, key: &str) -> AppResult<Vec<String>> {
    let url = format!("{}/v1/models", crate::config::normalize_base(base));
    let resp = CLIENT.get(&url).bearer_auth(key).timeout(Duration::from_secs(15)).send().await.map_err(AppError::from)?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(AppError::from_status(status.as_u16(), &redact_secret(&text, Some(key))));
    }
    let v: serde_json::Value = resp.json().await.map_err(AppError::from)?;
    Ok(parse_models(&v))
}

fn parse_models(v: &serde_json::Value) -> Vec<String> {
    v.get("data")
        .and_then(|d| d.as_array())
        .map(|a| a.iter().filter_map(|m| m.get("id").and_then(|i| i.as_str()).map(str::to_string)).collect())
        .unwrap_or_default()
}

/// LiteLLM virtual-key usage: spend/budget/limits for one key (`GET /key/info`).
/// All fields optional because a gateway may report only a subset.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyUsage {
    pub key_alias: Option<String>,
    pub spend: Option<f64>,
    pub max_budget: Option<f64>,
    pub soft_budget: Option<f64>,
    pub budget_duration: Option<String>,
    pub budget_reset_at: Option<String>,
    pub expires: Option<String>,
    pub tpm_limit: Option<i64>,
    pub rpm_limit: Option<i64>,
    pub models: Vec<String>,
}

fn parse_key_usage(info: &serde_json::Value) -> KeyUsage {
    let s = |k: &str| info.get(k).and_then(|x| x.as_str()).filter(|x| !x.is_empty()).map(str::to_string);
    let f = |k: &str| info.get(k).and_then(|x| x.as_f64());
    let i = |k: &str| info.get(k).and_then(|x| x.as_i64());
    KeyUsage {
        key_alias: s("key_alias").or_else(|| s("key_name")),
        spend: f("spend"),
        max_budget: f("max_budget"),
        soft_budget: f("soft_budget"),
        budget_duration: s("budget_duration"),
        budget_reset_at: s("budget_reset_at"),
        expires: s("expires"),
        tpm_limit: i("tpm_limit"),
        rpm_limit: i("rpm_limit"),
        models: info
            .get("models")
            .and_then(|m| m.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
            .unwrap_or_default(),
    }
}

/// GET /key/info — usage for the calling virtual key, read from the Authorization header (the key
/// is never put in the URL). `Ok(None)` when this gateway does not expose it for this key, so the
/// UI can hide the usage bar instead of showing an error.
pub async fn key_info(base: &str, key: &str) -> AppResult<Option<KeyUsage>> {
    let url = format!("{}/key/info", crate::config::normalize_base(base));
    let resp = CLIENT.get(&url).bearer_auth(key).timeout(Duration::from_secs(15)).send().await.map_err(AppError::from)?;
    let status = resp.status();
    if matches!(status.as_u16(), 400 | 403 | 404 | 405 | 501) {
        return Ok(None);
    }
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(AppError::from_status(status.as_u16(), &redact_secret(&text, Some(key))));
    }
    let v: serde_json::Value = resp.json().await.map_err(AppError::from)?;
    let info = v.get("info").filter(|i| i.is_object()).unwrap_or(&v);
    Ok(Some(parse_key_usage(info)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_key_usage_from_info_envelope() {
        let v: serde_json::Value = serde_json::from_str(
            r#"{"key":"sk-x","info":{"key_alias":"incask","spend":1.25,"max_budget":10.0,
                "tpm_limit":1000,"rpm_limit":60,"models":["godev1","gothink1"],"budget_reset_at":"2026-12-01T00:00:00Z"}}"#,
        )
        .unwrap();
        let u = parse_key_usage(v.get("info").unwrap());
        assert_eq!(u.key_alias.as_deref(), Some("incask"));
        assert_eq!(u.spend, Some(1.25));
        assert_eq!(u.max_budget, Some(10.0));
        assert_eq!(u.budget_reset_at.as_deref(), Some("2026-12-01T00:00:00Z"));
        assert_eq!(u.models, vec!["godev1", "gothink1"]);
        assert_eq!(u.soft_budget, None);
    }

    #[test]
    fn parses_key_usage_with_nulls_and_empty() {
        let v: serde_json::Value =
            serde_json::from_str(r#"{"spend":0,"max_budget":null,"key_alias":"","models":null}"#).unwrap();
        let u = parse_key_usage(&v);
        assert_eq!(u.spend, Some(0.0));
        assert_eq!(u.max_budget, None);
        assert_eq!(u.key_alias, None);
        assert!(u.models.is_empty());
    }

    #[test]
    fn parses_completion_and_usage() {
        let v: serde_json::Value = serde_json::from_str(
            r#"{"choices":[{"message":{"content":"{\"results\":[]}"}}],"usage":{"prompt_tokens":120,"completion_tokens":30}}"#,
        )
        .unwrap();
        let c = parse_completion(&v);
        assert_eq!(c.content, r#"{"results":[]}"#);
        assert_eq!((c.prompt_tokens, c.completion_tokens), (120, 30));
        // no usage block → zeros, not an error
        let c2 = parse_completion(&serde_json::json!({"choices":[{"message":{"content":"x"}}]}));
        assert_eq!((c2.prompt_tokens, c2.completion_tokens), (0, 0));
    }

    #[test]
    fn body_has_temperature_zero_and_optional_json_mode() {
        let msgs = [ChatMessage::new("user", "hi")];
        let b = Body {
            model: "godev1",
            messages: &msgs,
            stream: false,
            temperature: 0.0,
            max_tokens: None,
            response_format: Some(ResponseFormat { kind: "json_object" }),
        };
        let s = serde_json::to_string(&b).unwrap();
        assert!(s.contains(r#""temperature":0.0"#));
        assert!(s.contains(r#""response_format":{"type":"json_object"}"#));
        assert!(!s.contains("max_tokens"));
    }

    #[test]
    fn parses_model_list() {
        let v = serde_json::json!({"data":[{"id":"godev1"},{"id":"gothink1"},{"object":"model"}]});
        assert_eq!(parse_models(&v), vec!["godev1", "gothink1"]);
    }
}
