//! Secret redaction and message sanitising for activity log entries.
//!
//! Everything is hand-rolled (the crate has no regex dependency) and runs on every entry, so each
//! pass is a single linear scan over at most `PRE_REDACT_CAP_BYTES` of text.

use std::sync::OnceLock;

pub const REDACTED: &str = "[redacted]";
pub const MAX_MESSAGE_CHARS: usize = 2000;
const PRE_REDACT_CAP_BYTES: usize = 16 * 1024;
const TRUNCATED_SUFFIX: &str = "… [truncated]";
const LONG_TOKEN_MIN_LEN: usize = 32;
const LONG_TOKEN_MIN_CLASS_CHANGE_RATIO: f32 = 0.4;
const WEAK_VALUE_MIN_LEN: usize = 16;
const MAX_KEY_RUN_LEN: usize = 64;

/// Keys whose value is always a credential.
const STRONG_SUFFIXES: &[&str] = &[
    "password",
    "passwd",
    "secret",
    "apikey",
    "api_key",
    "api-key",
    "credential",
    "credentials",
    "private_key",
    "privatekey",
];
/// Keys that usually hold a credential but are also ordinary words in prose ("invalid token: expired").
const WEAK_SUFFIXES: &[&str] = &[
    "token",
    "sessionid",
    "session_id",
    "session-id",
    "sessionkey",
    "session_key",
];
/// Keys whose value is the rest of the line (header-style lists such as `Cookie: a=1; b=2`).
const LINE_VALUE_SUFFIXES: &[&str] = &["authorization", "cookie"];
/// Ordinary words that only carry a secret inside a URL query string (`?key=`, OAuth `?code=`).
const QUERY_ONLY_KEYS: &[&str] = &["key", "code", "state", "sig", "signature"];
/// Authorization schemes followed by a credential, with the minimum credential length.
const AUTH_SCHEMES: &[(&str, usize)] = &[("bearer", 8), ("basic", 12), ("digest", 12)];

struct KeyKind {
    weak: bool,
    line_value: bool,
}

struct Rewrite {
    copy_until: usize,
    resume_at: usize,
}

/// What follows an authorization scheme word such as `Bearer`.
enum SchemeCredential {
    Secret(usize, usize),
    AlreadyRedacted,
}

/// Value scanning stops at `]`, so a marker left by an earlier pass must be recognised up front or
/// it would be rewritten into `[redacted]]`.
fn is_redacted_at(bytes: &[u8], at: usize) -> bool {
    bytes
        .get(at..)
        .is_some_and(|rest| rest.starts_with(REDACTED.as_bytes()))
}

pub fn redact(input: &str) -> String {
    redact_with_home(input, cached_home())
}

pub fn redact_with_home(input: &str, home: Option<&str>) -> String {
    let mut text = match home {
        Some(home) => replace_home(input, home),
        None => input.to_string(),
    };
    text = redact_url_userinfo(&text);
    text = redact_credentials(&text);
    redact_long_tokens(&text)
}

/// Caps, normalises, redacts and truncates a raw message so it is safe to store and display.
pub fn sanitize_message(raw: &str) -> String {
    let capped = cap_bytes(raw, PRE_REDACT_CAP_BYTES);
    let was_capped = capped.len() < raw.len();
    let redacted = redact(&normalize_whitespace(capped));
    let mut message = truncate_chars(redacted.trim_end(), MAX_MESSAGE_CHARS);
    if was_capped && !message.ends_with(TRUNCATED_SUFFIX) {
        message.push_str(TRUNCATED_SUFFIX);
    }
    message
}

pub fn truncate_chars(text: &str, max_chars: usize) -> String {
    if text.len() <= max_chars {
        return text.to_string();
    }
    match text.char_indices().nth(max_chars) {
        Some((index, _)) => format!("{}{}", &text[..index], TRUNCATED_SUFFIX),
        None => text.to_string(),
    }
}

fn cap_bytes(text: &str, max_bytes: usize) -> &str {
    if text.len() <= max_bytes {
        return text;
    }
    let mut end = max_bytes;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// Normalises line endings and drops control characters (ANSI escapes, NULs) that garble the log view.
fn normalize_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\r' => {
                if chars.peek() != Some(&'\n') {
                    out.push('\n');
                }
            }
            '\n' | '\t' => out.push(ch),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

fn cached_home() -> Option<&'static str> {
    static HOME: OnceLock<Option<String>> = OnceLock::new();
    HOME.get_or_init(|| crate::util::home_dir().map(|path| path.to_string_lossy().into_owned()))
        .as_deref()
}

fn home_variants(home: &str) -> Vec<String> {
    let trimmed = home.trim_end_matches(['/', '\\']);
    // "" or "/" would turn every path separator into "~".
    if trimmed.len() < 2 {
        return Vec::new();
    }
    let backslashes = trimmed.replace('/', "\\");
    let candidates = [
        trimmed.to_string(),
        trimmed.replace('\\', "/"),
        backslashes.clone(),
        backslashes.replace('\\', "\\\\"),
    ];
    let mut variants: Vec<String> = Vec::new();
    for candidate in candidates {
        if !variants.contains(&candidate) {
            variants.push(candidate);
        }
    }
    variants
}

fn replace_home(input: &str, home: &str) -> String {
    let mut text = input.to_string();
    for variant in home_variants(home) {
        text = replace_bounded(&text, &variant, "~");
    }
    text
}

/// Replaces `needle` only where it is not the prefix of a longer name (`/Users/loic` vs `/Users/loicb`).
fn replace_bounded(input: &str, needle: &str, replacement: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(position) = rest.find(needle) {
        let after = &rest[position + needle.len()..];
        let continues_name = after
            .chars()
            .next()
            .is_some_and(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '.'));
        out.push_str(&rest[..position]);
        out.push_str(if continues_name { needle } else { replacement });
        rest = after;
    }
    out.push_str(rest);
    out
}

/// `https://user:pass@host/…` → `https://[redacted]@host/…`
fn redact_url_userinfo(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(position) = rest.find("://") {
        let (head, tail) = rest.split_at(position + 3);
        out.push_str(head);
        let authority_end = tail
            .find(|c: char| matches!(c, '/' | '?' | '#') || c.is_whitespace())
            .unwrap_or(tail.len());
        let authority = &tail[..authority_end];
        match authority.rfind('@') {
            Some(at) => {
                out.push_str(REDACTED);
                out.push_str(&authority[at..]);
            }
            None => out.push_str(authority),
        }
        rest = &tail[authority_end..];
    }
    out.push_str(rest);
    out
}

fn is_key_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'
}

/// Walks `input`, offering every maximal `[A-Za-z0-9_-]` run to `decide`. A returned `Rewrite` keeps
/// the text up to `copy_until`, writes the redaction marker and resumes scanning at `resume_at`.
fn rewrite_runs(
    input: &str,
    mut decide: impl FnMut(&str, usize, usize) -> Option<Rewrite>,
) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut index = 0;
    while index < bytes.len() {
        if !is_key_byte(bytes[index]) {
            let width = input[index..].chars().next().map_or(1, char::len_utf8);
            out.push_str(&input[index..index + width]);
            index += width;
            continue;
        }
        let start = index;
        while index < bytes.len() && is_key_byte(bytes[index]) {
            index += 1;
        }
        match decide(input, start, index) {
            Some(rewrite) => {
                out.push_str(&input[start..rewrite.copy_until]);
                out.push_str(REDACTED);
                index = rewrite.resume_at;
            }
            None => out.push_str(&input[start..index]),
        }
    }
    out
}

fn ends_with_ignore_case(run: &str, suffix: &str) -> bool {
    run.len() >= suffix.len() && run[run.len() - suffix.len()..].eq_ignore_ascii_case(suffix)
}

fn classify_key(run: &str, previous: Option<u8>) -> Option<KeyKind> {
    if !(3..=MAX_KEY_RUN_LEN).contains(&run.len()) {
        return None;
    }
    if LINE_VALUE_SUFFIXES
        .iter()
        .any(|s| ends_with_ignore_case(run, s))
    {
        return Some(KeyKind {
            weak: false,
            line_value: true,
        });
    }
    if STRONG_SUFFIXES
        .iter()
        .any(|s| ends_with_ignore_case(run, s))
    {
        return Some(KeyKind {
            weak: false,
            line_value: false,
        });
    }
    if WEAK_SUFFIXES.iter().any(|s| ends_with_ignore_case(run, s)) {
        return Some(KeyKind {
            weak: true,
            line_value: false,
        });
    }
    if matches!(previous, Some(b'?' | b'&'))
        && QUERY_ONLY_KEYS.iter().any(|k| run.eq_ignore_ascii_case(k))
    {
        return Some(KeyKind {
            weak: false,
            line_value: false,
        });
    }
    None
}

fn is_value_stop(byte: u8) -> bool {
    matches!(
        byte,
        b' ' | b'\t'
            | b'\r'
            | b'\n'
            | b','
            | b';'
            | b'&'
            | b')'
            | b']'
            | b'}'
            | b'"'
            | b'\''
            | b'<'
            | b'>'
    )
}

fn line_end(bytes: &[u8], from: usize) -> usize {
    bytes[from..]
        .iter()
        .position(|&b| b == b'\n' || b == b'\r')
        .map_or(bytes.len(), |offset| from + offset)
}

fn unquoted_end(bytes: &[u8], from: usize, to_line_end: bool) -> usize {
    if to_line_end {
        return line_end(bytes, from);
    }
    let mut index = from;
    while index < bytes.len() && !is_value_stop(bytes[index]) {
        index += 1;
    }
    index
}

fn closing_quote(bytes: &[u8], from: usize, quote: u8) -> Option<usize> {
    let mut index = from;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => index += 2,
            b'\n' => return None,
            byte if byte == quote => return Some(index),
            _ => index += 1,
        }
    }
    None
}

/// For `Bearer <token>`-style values, the byte range of the credential after the scheme word, unless it is already redacted.
fn scheme_credential(text: &str, run: &str, run_end: usize) -> Option<SchemeCredential> {
    let (_, min_len) = AUTH_SCHEMES
        .iter()
        .find(|(name, _)| run.eq_ignore_ascii_case(name))?;
    let bytes = text.as_bytes();
    let mut start = run_end;
    if bytes.get(start) != Some(&b' ') {
        return None;
    }
    while bytes.get(start) == Some(&b' ') {
        start += 1;
    }
    if is_redacted_at(bytes, start) {
        return Some(SchemeCredential::AlreadyRedacted);
    }
    let end = unquoted_end(bytes, start, false);
    (end - start >= *min_len).then_some(SchemeCredential::Secret(start, end))
}

/// The byte range of the secret that follows a sensitive key (`key=value`, `"key": "value"`, ...).
fn find_value(text: &str, key_end: usize, kind: &KeyKind) -> Option<(usize, usize)> {
    let bytes = text.as_bytes();
    let mut index = key_end;
    if matches!(bytes.get(index), Some(b'"' | b'\'')) {
        index += 1;
    }
    while matches!(bytes.get(index), Some(b' ' | b'\t')) {
        index += 1;
    }
    let separator = *bytes.get(index)?;
    if separator != b'=' && separator != b':' {
        return None;
    }
    // `path::segment` and `==` are not assignments.
    if bytes.get(index + 1) == Some(&separator) {
        return None;
    }
    index += 1;
    let after_separator = index;
    while matches!(bytes.get(index), Some(b' ' | b'\t')) {
        index += 1;
    }
    let spaced = index > after_separator;
    let first = *bytes.get(index)?;
    match first {
        b'"' | b'\'' => {
            let start = index + 1;
            if is_redacted_at(bytes, start) {
                return None;
            }
            let end = closing_quote(bytes, start, first).unwrap_or_else(|| line_end(bytes, start));
            (end > start).then_some((start, end))
        }
        b'\n' | b'\r' => None,
        _ => {
            let mut start = index;
            let mut end = unquoted_end(bytes, start, kind.line_value);
            if end == start || is_redacted_at(bytes, start) {
                return None;
            }
            if !kind.line_value {
                let scheme = &text[start..end];
                match scheme_credential(text, scheme, end) {
                    Some(SchemeCredential::Secret(credential_start, credential_end)) => {
                        start = credential_start;
                        end = credential_end;
                    }
                    Some(SchemeCredential::AlreadyRedacted) => return None,
                    None => {}
                }
            }
            let prose_like = separator == b':' && spaced && kind.weak;
            if prose_like && end - start < WEAK_VALUE_MIN_LEN {
                return None;
            }
            Some((start, end))
        }
    }
}

fn redact_credentials(input: &str) -> String {
    rewrite_runs(input, |text, start, end| {
        let run = &text[start..end];
        let previous = start.checked_sub(1).map(|p| text.as_bytes()[p]);
        if let Some(kind) = classify_key(run, previous) {
            if let Some((from, to)) = find_value(text, end, &kind) {
                return Some(Rewrite {
                    copy_until: from,
                    resume_at: to,
                });
            }
        }
        match scheme_credential(text, run, end) {
            Some(SchemeCredential::Secret(from, to)) => Some(Rewrite {
                copy_until: from,
                resume_at: to,
            }),
            _ => None,
        }
    })
}

fn is_uuid(run: &str) -> bool {
    let bytes = run.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, &byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

fn char_class(byte: u8) -> u8 {
    if byte.is_ascii_lowercase() {
        0
    } else if byte.is_ascii_uppercase() {
        1
    } else if byte.is_ascii_digit() {
        2
    } else {
        3
    }
}

/// Random base64url-style tokens flip between letter cases and digits constantly; file names and
/// identifiers made of words do not. UUIDs are kept because they are useful and not secret.
fn looks_like_secret(run: &str) -> bool {
    if run.len() < LONG_TOKEN_MIN_LEN || is_uuid(run) {
        return false;
    }
    let mut seen = [false; 4];
    let mut changes = 0usize;
    let mut previous = None;
    for byte in run.bytes() {
        let class = char_class(byte);
        seen[class as usize] = true;
        if previous.is_some_and(|p| p != class) {
            changes += 1;
        }
        previous = Some(class);
    }
    let mixed = seen[0] && seen[1] && seen[2];
    mixed && changes as f32 / run.len() as f32 >= LONG_TOKEN_MIN_CLASS_CHANGE_RATIO
}

fn redact_long_tokens(input: &str) -> String {
    rewrite_runs(input, |text, start, end| {
        looks_like_secret(&text[start..end]).then_some(Rewrite {
            copy_until: start,
            resume_at: end,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(input: &str) -> String {
        redact_with_home(input, None)
    }

    const BASE64URL_TOKEN: &str = "k3Jd9Xq2LmVb7TzR1aYcW8nPsE5uHfGoA4iBtQ6xZw0";

    #[test]
    fn redacts_assignments_for_sensitive_keys() {
        assert_eq!(r("login token=abc123 ok"), "login token=[redacted] ok");
        assert_eq!(
            r("password=hunter2&user=bob"),
            "password=[redacted]&user=bob"
        );
        assert_eq!(r("x-api-key: abcdef"), "x-api-key: [redacted]");
        assert_eq!(r("access_token = zzz"), "access_token = [redacted]");
        assert_eq!(r("sessionId=42"), "sessionId=[redacted]");
    }

    #[test]
    fn redacts_json_and_debug_formatted_values() {
        assert_eq!(
            r(r#"{"access_token":"abc","name":"x"}"#),
            r#"{"access_token":"[redacted]","name":"x"}"#
        );
        assert_eq!(
            r(r#"{"password": "p@ss word", "ok": true}"#),
            r#"{"password": "[redacted]", "ok": true}"#
        );
        assert_eq!(
            r(r#"Config { api_key: "abc123", name: "x" }"#),
            r#"Config { api_key: "[redacted]", name: "x" }"#
        );
    }

    #[test]
    fn redacts_authorization_and_cookie_headers_to_end_of_line() {
        assert_eq!(
            r("Authorization: Bearer abc.def.ghi\nnext"),
            "Authorization: [redacted]\nnext"
        );
        assert_eq!(
            r("Set-Cookie: immich_access_token=abc; Path=/; HttpOnly\nnext"),
            "Set-Cookie: [redacted]\nnext"
        );
        assert_eq!(r("cookie: a=1; b=2"), "cookie: [redacted]");
    }

    #[test]
    fn redacts_bearer_credentials_anywhere() {
        assert_eq!(
            r("sending Bearer abcdefgh12345 now"),
            "sending Bearer [redacted] now"
        );
        assert_eq!(r("Basic setup finished"), "Basic setup finished");
        assert_eq!(r("a bearer of news"), "a bearer of news");
    }

    #[test]
    fn keeps_scheme_word_but_redacts_credential_after_a_key() {
        assert_eq!(r("token=Bearer abcdefgh12345"), "token=Bearer [redacted]");
    }

    #[test]
    fn redacts_secret_url_query_values_but_keeps_ordinary_ones() {
        assert_eq!(
            r("GET https://h/api/x?key=AbC123&page=2&apiKey=zzz"),
            "GET https://h/api/x?key=[redacted]&page=2&apiKey=[redacted]"
        );
        assert_eq!(
            r("callback?code=abc&state=def&next=/home"),
            "callback?code=[redacted]&state=[redacted]&next=/home"
        );
    }

    #[test]
    fn does_not_redact_generic_keys_outside_url_queries() {
        assert_eq!(
            r("toast key=album-created kind=success"),
            "toast key=album-created kind=success"
        );
        assert_eq!(r("state: ready"), "state: ready");
        assert_eq!(r("code=5 retries"), "code=5 retries");
    }

    #[test]
    fn redacts_url_userinfo() {
        assert_eq!(
            r("server https://user:pa55@immich.example.com/api ok"),
            "server https://[redacted]@immich.example.com/api ok"
        );
        assert_eq!(
            r("https://immich.example.com/a@b"),
            "https://immich.example.com/a@b"
        );
    }

    #[test]
    fn avoids_false_positives_on_ordinary_prose() {
        for text in [
            "restore_session ok",
            "invalid token: expired",
            "session started · app v0.1.0 · macOS aarch64 · pid 4242",
            "[auth:restore] token refreshed",
            "no token found: using cached identity",
            "get_oauth_authorization_url failed after 12ms: offline: server unreachable",
            "[auth] session: restored",
            "tokens remaining::3",
            "a::token::b",
        ] {
            assert_eq!(r(text), text, "should be unchanged: {text}");
        }
    }

    #[test]
    fn weak_keys_with_long_values_are_redacted_even_in_prose_form() {
        assert_eq!(
            r("access_token: abcdefghijklmnop1234"),
            "access_token: [redacted]"
        );
    }

    #[test]
    fn redacts_long_mixed_tokens_and_keeps_uuids_and_hashes() {
        assert_eq!(
            r(&format!("shared at /share/{BASE64URL_TOKEN}")),
            "shared at /share/[redacted]"
        );
        let uuid = "0f3c1b5e-8a7d-4c2e-9b1a-3d5e7f9a1b2c";
        assert_eq!(
            r(&format!("asset {uuid} failed")),
            format!("asset {uuid} failed")
        );
        let sha1 = "da39a3ee5e6b4b0d3255bfef95601890afd80709";
        assert_eq!(r(sha1), sha1);
        let filename = "2023-05-14-vacation-photos-day-two-sunrise.jpg";
        assert_eq!(r(filename), filename);
        let camel = "RefreshAlbumsAndRebuildLocalIndexForSharedAlbums";
        assert_eq!(r(camel), camel);
        let image = "IMG_20240101_123456789_Vacation_Day_Two_Sunrise_Beach.jpg";
        assert_eq!(r(image), image);
    }

    #[test]
    fn replaces_the_home_directory_with_a_tilde() {
        let home = Some("/Users/loic");
        assert_eq!(
            redact_with_home("copy /Users/loic/Pictures/a.jpg done", home),
            "copy ~/Pictures/a.jpg done"
        );
        assert_eq!(
            redact_with_home("/Users/loicb/x and /Users/loic.old/y", home),
            "/Users/loicb/x and /Users/loic.old/y"
        );
        assert_eq!(redact_with_home("/Users/loic", home), "~");
    }

    #[test]
    fn replaces_windows_home_directory_variants() {
        let home = Some(r"C:\Users\loic");
        assert_eq!(
            redact_with_home(r"open C:\Users\loic\Pictures\a.jpg", home),
            r"open ~\Pictures\a.jpg"
        );
        assert_eq!(
            redact_with_home("open C:/Users/loic/Pictures/a.jpg", home),
            "open ~/Pictures/a.jpg"
        );
        assert_eq!(
            redact_with_home(r#"path: "C:\\Users\\loic\\a.jpg""#, home),
            r#"path: "~\\a.jpg""#
        );
    }

    #[test]
    fn ignores_degenerate_home_directories() {
        assert_eq!(redact_with_home("/a/b/c", Some("/")), "/a/b/c");
        assert_eq!(redact_with_home("/a/b/c", Some("")), "/a/b/c");
    }

    #[test]
    fn handles_multibyte_text_around_secrets_without_panicking() {
        assert_eq!(
            r("é token=abc ü 日本 password=x ✓"),
            "é token=[redacted] ü 日本 password=[redacted] ✓"
        );
        assert_eq!(
            r("日本語のトークン token=ひみつ"),
            "日本語のトークン token=[redacted]"
        );
    }

    #[test]
    fn tolerates_edge_shapes() {
        for text in [
            "",
            "token",
            "token=",
            "token:",
            "\"token\":",
            "=",
            "::",
            "token=\"",
            "Bearer ",
            "://@",
        ] {
            let _ = r(text);
        }
        assert_eq!(r("token=\"unterminated value"), "token=\"[redacted]");
    }

    #[test]
    fn redaction_is_idempotent() {
        let once = r("token=abc password=def https://u:p@h/ Bearer abcdefghij");
        assert_eq!(r(&once), once);
    }

    #[test]
    fn redaction_is_idempotent_for_every_marker_position() {
        let samples = [
            "token=abc12345",
            "Authorization: Bearer abcdefghijklmnop",
            "Authorization: Basic dXNlcjpwYXNzd29yZA==",
            "x-api-key: Bearer abcdefghijklmnop",
            "api_key: Basic dXNlcjpwYXNzd29yZA==",
            "{\"access_token\": \"abcdef123456\", \"ok\": true}",
            "Debug { api_key: \"abcdef123456\" }",
            "[http] GET https://user:hunter2@host/a?token=abc12345&page=2",
            "Cookie: sid=abc; theme=dark\nnext line token=zzz9",
            "retry (password=abc12345) failed, secret=[redacted]",
        ];
        for sample in samples {
            let once = r(sample);
            assert!(
                once.contains(REDACTED),
                "nothing was redacted in {sample:?}: {once}"
            );
            assert_eq!(r(&once), once, "second pass changed {sample:?}");
        }
    }

    #[test]
    fn markers_are_not_doubled_by_further_passes() {
        assert_eq!(r("token=[redacted]"), "token=[redacted]");
        assert_eq!(r("Bearer [redacted] ok"), "Bearer [redacted] ok");
        assert_eq!(r("password: \"[redacted]\""), "password: \"[redacted]\"");
        assert_eq!(r("(secret=[redacted])"), "(secret=[redacted])");
    }

    #[test]
    fn sanitize_truncates_long_messages_on_char_boundaries() {
        let long = "é".repeat(MAX_MESSAGE_CHARS + 50);
        let out = sanitize_message(&long);
        assert!(out.ends_with(TRUNCATED_SUFFIX));
        assert_eq!(
            out.chars().count(),
            MAX_MESSAGE_CHARS + TRUNCATED_SUFFIX.chars().count()
        );
    }

    #[test]
    fn sanitize_caps_huge_inputs_and_marks_them() {
        let huge = format!("token=abc {}", "x ".repeat(PRE_REDACT_CAP_BYTES));
        let out = sanitize_message(&huge);
        assert!(out.starts_with("token=[redacted]"));
        assert!(out.ends_with(TRUNCATED_SUFFIX));
    }

    #[test]
    fn sanitize_normalizes_line_endings_and_strips_control_characters() {
        assert_eq!(
            sanitize_message("a\r\nb\rc\u{0}\u{1b}d\te\n\n"),
            "a\nb\ncd\te"
        );
    }

    #[test]
    fn sanitize_leaves_short_clean_messages_alone() {
        assert_eq!(
            sanitize_message("GET /api/albums → 200 in 120ms"),
            "GET /api/albums → 200 in 120ms"
        );
    }
}
