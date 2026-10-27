use axum::http::{HeaderMap, Method, Uri};

#[derive(Clone, Debug)]
pub struct HttpPolicy {
    pub daemon_port: u16,
    pub vite_port: u16,
    pub token: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CookieDecodeError {
    MalformedUri,
}

impl HttpPolicy {
    pub fn from_env() -> Result<Self, String> {
        let daemon_port_value =
            std::env::var("DAEMON_PORT").map_err(|_| "DAEMON_PORT is required".to_owned())?;
        let daemon_port = parse_js_port(&daemon_port_value)
            .map_err(|_| "DAEMON_PORT must be a valid port".to_owned())?;
        if daemon_port == 0 {
            return Err("DAEMON_PORT must be a valid port".to_owned());
        }
        let vite_port = parse_vite_port(std::env::var("VITE_PORT").ok().as_deref())
            .map_err(|_| "VITE_PORT must be a valid port".to_owned())?;
        let token = parse_token(std::env::var("SING_TOKEN"))?;
        Ok(Self {
            daemon_port,
            vite_port,
            token,
        })
    }

    pub fn host_allowed(&self, host: Option<&str>) -> bool {
        host.map_or(true, |host| {
            [self.daemon_port, self.vite_port].into_iter().any(|port| {
                ["127.0.0.1", "localhost", "[::1]"]
                    .into_iter()
                    .any(|name| host == format!("{name}:{port}"))
            })
        })
    }

    pub fn origin_allowed(&self, origin: Option<&str>, fetch_site: Option<&str>) -> bool {
        match origin {
            Some(origin) => Uri::try_from(origin)
                .ok()
                .and_then(|uri| {
                    let host = uri.host()?;
                    let port = uri.port_u16()?;
                    Some(self.host_allowed(Some(&format_origin_host(host, port))))
                })
                .unwrap_or(false),
            None => fetch_site.map_or(true, |site| matches!(site, "same-origin" | "none")),
        }
    }

    pub fn request_allowed(&self, headers: &HeaderMap) -> Result<(), &'static str> {
        if headers.contains_key("host") && header(headers, "host").is_none() {
            return Err("forbidden host");
        }
        let host = header(headers, "host");
        if !self.host_allowed(host) {
            return Err("forbidden host");
        }
        if headers.contains_key("origin") && header(headers, "origin").is_none() {
            return Err("forbidden origin");
        }
        if !self.origin_allowed(header(headers, "origin"), header(headers, "sec-fetch-site")) {
            return Err("forbidden origin");
        }
        Ok(())
    }

    pub fn api_authenticated(
        &self,
        headers: &HeaderMap,
        raw_query: Option<&str>,
    ) -> Result<bool, CookieDecodeError> {
        let Some(token) = self.token.as_deref() else {
            return Ok(true);
        };
        if let Some(header_token) =
            header(headers, "x-sing-token").filter(|value| !value.is_empty())
        {
            return Ok(header_token == token);
        }
        if let Some(query) = raw_query {
            let query_tokens = query_values(query, "token");
            if query_tokens.len() > 1 {
                return Ok(false);
            }
            if let Some(query_token) = query_tokens.first().filter(|value| !value.is_empty()) {
                return Ok(query_token == token);
            }
        }
        Ok(cookie_value(headers, "sing_token")?.as_deref() == Some(token))
    }

    pub fn shell_token_query(&self, raw_query: Option<&str>) -> Option<String> {
        let token = self.token.as_deref()?;
        query_value(raw_query, "token").filter(|provided| provided == token)
    }

    pub fn shell_authenticated(&self, headers: &HeaderMap) -> Result<bool, CookieDecodeError> {
        let Some(token) = self.token.as_deref() else {
            return Ok(true);
        };
        Ok(cookie_value(headers, "sing_token")?.as_deref() == Some(token))
    }

    pub fn websocket_authenticated(&self, raw_query: Option<&str>) -> bool {
        self.token.as_deref().map_or(true, |token| {
            query_first_value(raw_query, "token").as_deref() == Some(token)
        })
    }

    pub fn is_shell_request(&self, method: &Method, path: &str, accept: Option<&str>) -> bool {
        if method != Method::GET && method != Method::HEAD {
            return false;
        }
        path == "/"
            || (accept.is_some_and(|value| value.contains("text/html"))
                && !is_path_or_child(path, "/api")
                && !is_path_or_child(path, "/assets")
                && !is_path_or_child(path, "/ws"))
    }

    pub fn shell_redirect_location(&self, path: &str, raw_query: Option<&str>) -> String {
        let remaining = raw_query
            .unwrap_or_default()
            .split('&')
            .filter(|pair| !pair.is_empty())
            .filter_map(|pair| {
                let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
                let key = form_decode(key);
                (key != "token")
                    .then(|| format!("{}={}", form_encode(&key), form_encode(&form_decode(value))))
            })
            .collect::<Vec<_>>()
            .join("&");
        if remaining.is_empty() {
            path.to_owned()
        } else {
            format!("{path}?{remaining}")
        }
    }
}

fn is_path_or_child(path: &str, prefix: &str) -> bool {
    path == prefix || path.starts_with(&format!("{prefix}/"))
}

fn format_origin_host(host: &str, port: u16) -> String {
    let host = host.to_ascii_lowercase();
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name)?.to_str().ok()
}

fn cookie_value(headers: &HeaderMap, name: &str) -> Result<Option<String>, CookieDecodeError> {
    let Some(cookie) = header(headers, "cookie") else {
        return Ok(None);
    };
    for part in cookie.split(';') {
        let Some((key, value)) = part.trim().split_once('=') else {
            continue;
        };
        if key.trim() == name {
            return decode_cookie(value.trim()).map(Some);
        }
    }
    Ok(None)
}

fn decode_cookie(value: &str) -> Result<String, CookieDecodeError> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err(CookieDecodeError::MalformedUri);
            }
            let hi = hex(bytes[index + 1]).ok_or(CookieDecodeError::MalformedUri)?;
            let lo = hex(bytes[index + 2]).ok_or(CookieDecodeError::MalformedUri)?;
            decoded.push((hi << 4) | lo);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).map_err(|_| CookieDecodeError::MalformedUri)
}

fn query_value(query: Option<&str>, name: &str) -> Option<String> {
    let matches = query_values(query?, name);
    (matches.len() == 1)
        .then(|| matches.into_iter().next())
        .flatten()
}

fn query_first_value(query: Option<&str>, name: &str) -> Option<String> {
    query_values(query?, name).into_iter().next()
}

pub(crate) fn query_values(query: &str, name: &str) -> Vec<String> {
    query
        .split('&')
        .filter_map(|pair| {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            (form_decode(key) == name).then(|| form_decode(value))
        })
        .collect()
}

fn form_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => decoded.push(b' '),
            b'%' if index + 2 < bytes.len()
                && hex(bytes[index + 1]).is_some()
                && hex(bytes[index + 2]).is_some() =>
            {
                decoded
                    .push((hex(bytes[index + 1]).unwrap() << 4) | hex(bytes[index + 2]).unwrap());
                index += 2;
            }
            byte => decoded.push(byte),
        }
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn form_encode(value: &str) -> String {
    let mut output = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'*' | b'-' | b'.' | b'_') {
            output.push(byte as char);
        } else if byte == b' ' {
            output.push('+');
        } else {
            output.push_str(&format!("%{byte:02X}"));
        }
    }
    output
}

fn parse_js_port(value: &str) -> Result<u16, ()> {
    let value = value.trim();
    let number = if value.is_empty() {
        0.0
    } else if let Some(radix) = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
    {
        u64::from_str_radix(radix, 16)
            .map(|n| n as f64)
            .map_err(|_| ())?
    } else if let Some(radix) = value
        .strip_prefix("0o")
        .or_else(|| value.strip_prefix("0O"))
    {
        u64::from_str_radix(radix, 8)
            .map(|n| n as f64)
            .map_err(|_| ())?
    } else if let Some(radix) = value
        .strip_prefix("0b")
        .or_else(|| value.strip_prefix("0B"))
    {
        u64::from_str_radix(radix, 2)
            .map(|n| n as f64)
            .map_err(|_| ())?
    } else {
        value.parse::<f64>().map_err(|_| ())?
    };
    if number.is_finite() && number.fract() == 0.0 && (0.0..=65535.0).contains(&number) {
        Ok(number as u16)
    } else {
        Err(())
    }
}

fn parse_vite_port(value: Option<&str>) -> Result<u16, ()> {
    match value {
        None => Ok(5317),
        Some(value) => parse_js_port(value),
    }
}

fn parse_token(value: Result<String, std::env::VarError>) -> Result<Option<String>, String> {
    let token = match value {
        Ok(token) if !token.is_empty() => Some(token),
        Ok(_) | Err(std::env::VarError::NotPresent) => None,
        Err(std::env::VarError::NotUnicode(_)) => {
            return Err("SING_TOKEN must be valid Unicode".to_owned());
        }
    };
    if token.as_deref().is_some_and(|value| {
        !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    }) {
        return Err("SING_TOKEN must contain only letters, digits, '_' or '-'".to_owned());
    }
    Ok(token)
}

fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{HttpPolicy, parse_js_port, parse_token, parse_vite_port, query_value};
    use axum::http::{HeaderMap, HeaderName, HeaderValue};

    fn policy() -> HttpPolicy {
        HttpPolicy {
            daemon_port: 4317,
            vite_port: 5317,
            token: Some("token_1".to_owned()),
        }
    }

    #[test]
    fn http_host_origin_and_fetch_site_match_the_local_allowlist() {
        let policy = policy();
        assert!(policy.host_allowed(Some("localhost:4317")));
        assert!(policy.host_allowed(Some("[::1]:5317")));
        assert!(!policy.host_allowed(Some("localhost")));
        assert!(policy.origin_allowed(Some("http://127.0.0.1:5317"), Some("cross-site")));
        assert!(!policy.origin_allowed(Some("http://evil.test:5317"), None));
        assert!(policy.origin_allowed(None, Some("same-origin")));
        assert!(policy.origin_allowed(None, Some("none")));
        assert!(!policy.origin_allowed(None, Some("cross-site")));
    }

    #[test]
    fn present_unreadable_host_and_origin_are_rejected_but_missing_stays_allowed() {
        let policy = policy();
        let mut headers = HeaderMap::new();
        assert_eq!(policy.request_allowed(&headers), Ok(()));

        headers.insert(
            "host",
            HeaderValue::from_bytes(b"localhost:4317\x80").unwrap(),
        );
        assert_eq!(policy.request_allowed(&headers), Err("forbidden host"));
        headers.remove("host");

        headers.insert(
            "origin",
            HeaderValue::from_bytes(b"http://localhost:4317\x80").unwrap(),
        );
        assert_eq!(policy.request_allowed(&headers), Err("forbidden origin"));
        headers.remove("origin");

        headers.insert("sec-fetch-site", HeaderValue::from_static("same-origin"));
        assert_eq!(policy.request_allowed(&headers), Ok(()));
        headers.insert("sec-fetch-site", HeaderValue::from_static("cross-site"));
        assert_eq!(policy.request_allowed(&headers), Err("forbidden origin"));
    }

    #[test]
    fn http_token_sources_and_websocket_query_policy_are_separate() {
        let policy = policy();
        let mut headers = HeaderMap::new();
        headers.insert("x-sing-token", HeaderValue::from_static("token_1"));
        assert_eq!(policy.api_authenticated(&headers, None), Ok(true));
        headers.remove("x-sing-token");
        headers.insert("cookie", HeaderValue::from_static("sing_token=token_1"));
        assert_eq!(policy.api_authenticated(&headers, None), Ok(true));
        assert!(!policy.websocket_authenticated(None));
        assert!(policy.websocket_authenticated(Some("token=token_1")));
        assert_eq!(
            policy.shell_token_query(Some("x=1&token=token_1")),
            Some("token_1".into())
        );
    }

    #[test]
    fn http_node_source_environment_and_query_fixtures_match() {
        let fixtures: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/http-policy.json")).unwrap();
        for fixture in fixtures["environment"].as_array().unwrap() {
            let input = fixture["input"].as_str().unwrap();
            let expected = fixture["port"].as_u64().map(|port| port as u16);
            assert_eq!(parse_js_port(input).ok(), expected, "DAEMON_PORT={input:?}");
        }
        for fixture in fixtures["tokens"].as_array().unwrap() {
            let input = fixture["input"].as_str().map(str::to_owned);
            let parsed =
                parse_token(input.map_or_else(|| Err(std::env::VarError::NotPresent), Ok)).unwrap();
            assert_eq!(parsed, fixture["token"].as_str().map(str::to_owned));
        }

        let policy = policy();
        for fixture in fixtures["request_policy"].as_array().unwrap() {
            let mut headers = HeaderMap::new();
            for (fixture_name, header_name) in [
                ("host", "host"),
                ("origin", "origin"),
                ("fetch_site", "sec-fetch-site"),
            ] {
                if let Some(value) = fixture[fixture_name].as_str() {
                    headers.insert(header_name, HeaderValue::from_str(value).unwrap());
                }
            }
            let result = policy.request_allowed(&headers);
            if fixture["allowed"].as_bool().unwrap() {
                assert_eq!(result, Ok(()), "{fixture}");
            } else {
                assert_eq!(result, Err(fixture["error"].as_str().unwrap()), "{fixture}");
            }
        }
        for fixture in fixtures["api_auth"].as_array().unwrap() {
            let mut headers = HeaderMap::new();
            if let Some(value) = fixture["header"].as_str() {
                headers.insert("x-sing-token", HeaderValue::from_str(value).unwrap());
            }
            if let Some(value) = fixture["cookie"].as_str() {
                headers.insert("cookie", HeaderValue::from_str(value).unwrap());
            }
            let allowed = policy.api_authenticated(&headers, fixture["query"].as_str());
            assert_eq!(
                allowed.unwrap(),
                fixture["allowed"].as_bool().unwrap(),
                "{fixture}"
            );
        }
        for fixture in fixtures["websocket_auth"].as_array().unwrap() {
            assert_eq!(
                policy.websocket_authenticated(fixture["query"].as_str()),
                fixture["allowed"].as_bool().unwrap(),
                "{fixture}"
            );
        }
        assert_eq!(
            policy.shell_token_query(Some(fixtures["shell_duplicate"]["query"].as_str().unwrap())),
            None
        );

        for fixture in fixtures["redirects"].as_array().unwrap() {
            assert_eq!(
                policy.shell_redirect_location(
                    fixture["path"].as_str().unwrap(),
                    fixture["query"].as_str(),
                ),
                fixture["location"].as_str().unwrap(),
                "{fixture}"
            );
        }

        assert_eq!(policy.shell_authenticated(&HeaderMap::new()), Ok(false));
    }

    #[test]
    fn http_vite_port_matches_node_nullish_default_and_number_conversion() {
        assert_eq!(parse_vite_port(None), Ok(5317));
        assert_eq!(parse_vite_port(Some("")), Ok(0));
        assert_eq!(parse_vite_port(Some("0")), Ok(0));
    }

    #[test]
    fn http_repeated_query_token_does_not_fall_through_to_cookie() {
        let policy = policy();
        let mut headers = HeaderMap::new();
        headers.insert("cookie", HeaderValue::from_static("sing_token=token_1"));
        assert_eq!(
            policy.api_authenticated(&headers, Some("token=token_1&token=other")),
            Ok(false)
        );
        assert_eq!(
            policy.api_authenticated(
                &HeaderMap::from_iter([(
                    HeaderName::from_static("x-sing-token"),
                    HeaderValue::from_static("wrong"),
                )]),
                Some("token=token_1")
            ),
            Ok(false)
        );
    }

    #[test]
    fn http_malformed_cookie_errors_after_truthy_sources_short_circuit() {
        let policy = policy();
        let fixtures: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/http-policy.json")).unwrap();
        let cookie_policy = &fixtures["cookie_policy"];
        for cookie in cookie_policy["malformed"].as_array().unwrap() {
            let mut headers = HeaderMap::new();
            headers.insert(
                "cookie",
                HeaderValue::from_str(cookie.as_str().unwrap()).unwrap(),
            );
            assert_eq!(
                policy.api_authenticated(&headers, None),
                Err(super::CookieDecodeError::MalformedUri)
            );
            assert_eq!(
                policy.shell_authenticated(&headers),
                Err(super::CookieDecodeError::MalformedUri)
            );
        }

        let ordering = &cookie_policy["cookie_ordering"];
        let mut ordered_headers = HeaderMap::new();
        ordered_headers.insert(
            "cookie",
            HeaderValue::from_str(ordering["cookie"].as_str().unwrap()).unwrap(),
        );
        assert_eq!(
            policy.api_authenticated(&ordered_headers, None),
            Ok(ordering["allowed"].as_bool().unwrap())
        );

        let mut headers = HeaderMap::new();
        headers.insert(
            "x-sing-token",
            HeaderValue::from_str(
                cookie_policy["header_short_circuit"]["header"]
                    .as_str()
                    .unwrap(),
            )
            .unwrap(),
        );
        headers.insert(
            "cookie",
            HeaderValue::from_str(
                cookie_policy["header_short_circuit"]["cookie"]
                    .as_str()
                    .unwrap(),
            )
            .unwrap(),
        );
        assert_eq!(policy.api_authenticated(&headers, None), Ok(true));

        headers.remove("x-sing-token");
        headers.insert(
            "cookie",
            HeaderValue::from_str(
                cookie_policy["duplicate_query_short_circuit"]["cookie"]
                    .as_str()
                    .unwrap(),
            )
            .unwrap(),
        );
        let query = cookie_policy["duplicate_query_short_circuit"]["query"]
            .as_str()
            .unwrap();
        assert_eq!(policy.api_authenticated(&headers, Some(query)), Ok(false));
    }

    #[test]
    fn http_source_bound_fixture_anchor() {
        assert_eq!(
            query_value(Some("token=token_1"), "token").as_deref(),
            Some("token_1")
        );
        assert_eq!(
            query_value(Some("token=token_1&token=other"), "token"),
            None
        );
    }
}
