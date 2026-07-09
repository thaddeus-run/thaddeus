//! A read-only client over the Thaddeus untrusted HTTP remote.
//!
//! Thaddeus reads are a public mirror — `GET /repos`, `…/pull`, `/reputation/:did`
//! need no signature — so `lazythad` browses the substrate with no keys. Each
//! wire item is base64 of the persistence record encoding (JSON, with byte
//! fields as `{"$u8": "<base64>"}`); for display we only read the cleartext
//! fields and ignore the signature entirely (serde drops unknown fields).

use std::collections::HashMap;
use std::time::Duration;

use anyhow::{Context, Result};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::de::DeserializeOwned;
use serde::Deserialize;

/// A committed operation (P03), as shown in the log. Ordering/convergence is
/// `lamport` + the DAG; `at` is descriptive (signed) wall-clock only.
#[derive(Debug, Clone, Deserialize)]
pub struct Op {
    pub id: String,
    pub path: String,
    pub at: String,
    pub author: String,
    #[serde(default)]
    pub lamport: i64,
}

/// A signed "why" (P04) bound to an `Op.id`.
#[derive(Debug, Clone, Deserialize)]
pub struct Provenance {
    pub op: String,
    #[serde(default)]
    pub actor_kind: String,
    #[serde(default)]
    pub intent: String,
    #[serde(default)]
    pub reasoning: String,
}

/// A standing human veto (P10) bound to an `Op.id`.
#[derive(Debug, Clone, Deserialize)]
pub struct Veto {
    pub op: String,
    pub reviewer: String,
    pub reason: String,
    #[serde(default)]
    pub at: String,
}

/// A subject's server-wide reputation profile (P07).
#[derive(Debug, Clone, Deserialize, Default)]
pub struct Reputation {
    pub subject: String,
    pub attested: i64,
    pub claimed: i64,
    #[serde(rename = "byKind", default)]
    pub by_kind: HashMap<String, i64>,
}

/// A decoded pull of a view: its ops (newest-first) with the why + vetoes indexed
/// by op id.
#[derive(Debug, Clone, Default)]
pub struct Pull {
    pub heads: Vec<String>,
    pub ops: Vec<Op>,
    pub prov: HashMap<String, Vec<Provenance>>,
    pub veto: HashMap<String, Vec<Veto>>,
}

#[derive(Debug, Deserialize)]
struct ReposResponse {
    #[serde(default)]
    repos: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct PullResponse {
    #[serde(default)]
    heads: Vec<String>,
    #[serde(default)]
    ops: Vec<String>,
    #[serde(default)]
    prov: Vec<String>,
    #[serde(default)]
    veto: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct WireRecord<T> {
    v: String,
    d: T,
}

/// Decode one base64 wire record into `T`, or `None` if it is torn/invalid — a
/// single bad record never sinks the whole view (keep-and-label, like the logs).
fn decode_record<T: DeserializeOwned>(wire: &str) -> Option<T> {
    let bytes = STANDARD.decode(wire).ok()?;
    match serde_json::from_slice::<WireRecord<T>>(&bytes) {
        Ok(record) if record.v == "tplv1" => Some(record.d),
        Ok(_) => None,
        Err(_) => serde_json::from_slice(&bytes).ok(),
    }
}

fn decode_all<T: DeserializeOwned>(wire: &[String]) -> Vec<T> {
    wire.iter().filter_map(|s| decode_record::<T>(s)).collect()
}

/// Group records by their bound op id via `key`.
fn group_by<T, F: Fn(&T) -> String>(items: Vec<T>, key: F) -> HashMap<String, Vec<T>> {
    let mut map: HashMap<String, Vec<T>> = HashMap::new();
    for item in items {
        map.entry(key(&item)).or_default().push(item);
    }
    map
}

/// Assemble a `Pull` from a decoded response: decode each record array and order
/// the ops newest-first (descending lamport, then id) — the log's reading order.
fn assemble_pull(resp: PullResponse) -> Pull {
    let mut ops = decode_all::<Op>(&resp.ops);
    ops.sort_by(|a, b| b.lamport.cmp(&a.lamport).then_with(|| b.id.cmp(&a.id)));
    let prov = group_by(decode_all::<Provenance>(&resp.prov), |p| p.op.clone());
    let veto = group_by(decode_all::<Veto>(&resp.veto), |v| v.op.clone());
    Pull {
        heads: resp.heads,
        ops,
        prov,
        veto,
    }
}

/// Percent-encode a path segment (repo names can contain `/`, e.g. `acme/web`),
/// matching the encoding the server's route matcher expects.
fn pct_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// A handle to one Thaddeus remote.
#[derive(Clone)]
pub struct Remote {
    base: String,
    agent: ureq::Agent,
}

impl Remote {
    pub fn new(server: &str) -> Self {
        // Bound the blocking calls: an unreachable server should fail in seconds
        // (surfaced in the status line) rather than freeze the UI for ureq's 30s
        // default. Fetches still block the event loop while in flight — moving
        // them to a background thread with a "loading…" state is a fast-follow.
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(5))
            .timeout(Duration::from_secs(10))
            .build();
        Remote {
            base: server.trim_end_matches('/').to_string(),
            agent,
        }
    }

    fn get(&self, url: &str) -> Result<String> {
        self.agent
            .get(url)
            .call()
            .with_context(|| format!("GET {url}"))?
            .into_string()
            .context("read response body")
    }

    /// The repos the remote mirrors, sorted.
    pub fn repos(&self) -> Result<Vec<String>> {
        let body = self.get(&format!("{}/repos", self.base))?;
        let r: ReposResponse = serde_json::from_str(&body).context("decode /repos")?;
        Ok(r.repos)
    }

    /// Pull a view's ops + why + vetoes (public mirror, no decryption).
    pub fn pull(&self, repo: &str, view: &str) -> Result<Pull> {
        let url = format!(
            "{}/repos/{}/pull?view={}",
            self.base,
            pct_encode(repo),
            pct_encode(view)
        );
        let body = self.get(&url)?;
        let resp: PullResponse = serde_json::from_str(&body).context("decode /pull")?;
        Ok(assemble_pull(resp))
    }

    /// A DID's server-wide reputation profile.
    pub fn reputation(&self, did: &str) -> Result<Reputation> {
        let url = format!("{}/reputation/{}", self.base, pct_encode(did));
        let body = self.get(&url)?;
        serde_json::from_str(&body).context("decode /reputation")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wire(json: &str) -> String {
        STANDARD.encode(json.as_bytes())
    }

    fn wire_record(json: &str) -> String {
        STANDARD.encode(format!(r#"{{"v":"tplv1","d":{json}}}"#).as_bytes())
    }

    #[test]
    fn decodes_an_op_and_ignores_the_signature() {
        let op = wire(
            r#"{"id":"abc123","path":"src/a.rs","at":"2026-07-01T00:00:00Z",
                "author":"did:key:zA","lamport":3,"parents":["p"],
                "sig":{"$u8":"AAAA"},"payload":null}"#,
        );
        let decoded: Op = decode_record(&op).expect("decodes");
        assert_eq!(decoded.id, "abc123");
        assert_eq!(decoded.path, "src/a.rs");
        assert_eq!(decoded.lamport, 3);
        assert_eq!(decoded.author, "did:key:zA");
    }

    #[test]
    fn decodes_the_server_record_envelope() {
        let op = wire_record(
            r#"{"id":"abc123","path":"src/a.rs","at":"2026-07-01T00:00:00Z",
                "author":"did:key:zA","lamport":3,"parents":["p"],
                "sig":{"$u8":"AAAA"},"payload":null}"#,
        );
        let decoded: Op = decode_record(&op).expect("decodes");
        assert_eq!(decoded.id, "abc123");
        assert_eq!(decoded.path, "src/a.rs");
    }

    #[test]
    fn a_torn_record_is_skipped_not_fatal() {
        let good = wire(r#"{"id":"x","path":"a","at":"t","author":"d","lamport":1}"#);
        let torn = STANDARD.encode(b"{not valid json");
        let ops = decode_all::<Op>(&[good, torn, "!!!not base64".to_string()]);
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].id, "x");
    }

    #[test]
    fn an_unknown_envelope_version_is_skipped_not_fatal() {
        let unknown = STANDARD.encode(
            br#"{"v":"tplv2","d":{"id":"x","path":"a","at":"t","author":"d","lamport":1}}"#,
        );
        let good = wire_record(r#"{"id":"y","path":"b","at":"t","author":"d","lamport":2}"#);
        let ops = decode_all::<Op>(&[unknown, good]);
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].id, "y");
    }

    #[test]
    fn assembles_a_pull_newest_first_with_indexed_why_and_veto() {
        let resp = PullResponse {
            heads: vec!["h".into()],
            ops: vec![
                wire_record(r#"{"id":"op1","path":"a","at":"t1","author":"d","lamport":1}"#),
                wire_record(r#"{"id":"op2","path":"b","at":"t2","author":"d","lamport":2}"#),
            ],
            prov: vec![wire_record(
                r#"{"op":"op2","actor_kind":"human","intent":"fix","reasoning":"fix"}"#,
            )],
            veto: vec![wire_record(
                r#"{"op":"op1","reviewer":"did:key:zR","reason":"unsafe","at":"t"}"#,
            )],
        };
        let pull = assemble_pull(resp);
        // Newest-first: op2 (lamport 2) before op1 (lamport 1).
        assert_eq!(pull.ops[0].id, "op2");
        assert_eq!(pull.ops[1].id, "op1");
        assert_eq!(pull.prov["op2"][0].intent, "fix");
        assert_eq!(pull.veto["op1"][0].reason, "unsafe");
    }

    #[test]
    fn pct_encode_escapes_a_repo_slash() {
        assert_eq!(pct_encode("acme/web"), "acme%2Fweb");
        assert_eq!(pct_encode("plain"), "plain");
    }
}
