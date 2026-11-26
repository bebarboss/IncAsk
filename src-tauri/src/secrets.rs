//! Gateway API key storage — Windows Credential Manager only (via `keyring`).
//! The key never touches a file, a log line, the clipboard or the frontend.
//! Ported from DocAsk (secrets.rs) without the embedding-server / share keys.

use crate::errors::{AppError, AppResult};
use crate::redact::last4;

/// Credential Manager target. Separate from DocAsk's so the two apps never clobber each other.
pub const SERVICE: &str = "IncAsk/Gateway";
const USER: &str = "virtual-key";

fn entry() -> AppResult<keyring::Entry> {
    Ok(keyring::Entry::new(SERVICE, USER)?)
}

pub fn validate_format(key: &str) -> AppResult<()> {
    let k = key.trim();
    if !k.starts_with("sk-") {
        return Err(AppError::new("key_format", "Key ต้องขึ้นต้นด้วย sk-"));
    }
    if k.chars().any(char::is_whitespace) || k.len() < 12 {
        return Err(AppError::new("key_format", "รูปแบบ Key ไม่ถูกต้อง (ห้ามมีช่องว่าง)"));
    }
    Ok(())
}

pub fn set_key(key: &str) -> AppResult<()> {
    validate_format(key)?;
    entry()?.set_password(key.trim())?;
    Ok(())
}

pub fn get_key() -> AppResult<Option<String>> {
    match entry()?.get_password() {
        Ok(k) => Ok(Some(k)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn require_key() -> AppResult<String> {
    get_key()?.ok_or_else(AppError::no_key)
}

pub fn delete_key() -> AppResult<()> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// (has_key, last 4 chars) — the only information the UI receives.
pub fn key_status() -> (bool, Option<String>) {
    match get_key() {
        Ok(Some(k)) => (true, Some(last4(&k))),
        _ => (false, None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_format_rules() {
        assert!(validate_format("sk-abcdefghijk").is_ok());
        assert!(validate_format("pk-abcdefghijk").is_err());
        assert!(validate_format("sk-abc def ghijk").is_err());
        assert!(validate_format("sk-short").is_err());
    }
}
