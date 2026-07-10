//! Local bridge from lazythad to `thaddeus query --json`.
//!
//! The remote browser remains keyless. Semantic queries run in the installed
//! TypeScript CLI, inside a matching working copy, so decryption and capability
//! enforcement stay in the one implementation that already owns them.

use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context, Result};
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct QueryOp {
    pub id: String,
    pub path: String,
    pub at: String,
    pub author: String,
    pub lamport: i64,
    pub kind: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct WhyRecord {
    pub status: String,
    pub actor: String,
    pub actor_kind: String,
    pub intent: String,
    pub reasoning: String,
    pub task: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct WhyResult {
    pub op: QueryOp,
    pub verified: bool,
    pub records: Vec<WhyRecord>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct QuerySymbol {
    pub id: String,
    pub kind: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct QueryDefinition {
    pub symbol: String,
    pub name: String,
    pub path: String,
    pub line: u64,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct CallerResult {
    pub symbol: QuerySymbol,
    pub definition: Option<QueryDefinition>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct ReferenceResult {
    pub symbol: String,
    pub path: String,
    pub line: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QueryResult {
    Why(WhyResult),
    Ops(Vec<QueryOp>),
    Callers(Vec<CallerResult>),
    References(Vec<ReferenceResult>),
}

impl QueryResult {
    pub fn len(&self) -> usize {
        match self {
            QueryResult::Why(_) => 1,
            QueryResult::Ops(ops) => ops.len(),
            QueryResult::Callers(callers) => callers.len(),
            QueryResult::References(references) => references.len(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum QueryKind {
    Why,
    TouchedSince,
    By,
    Callers,
    References,
}

impl QueryKind {
    fn command(self) -> &'static str {
        match self {
            QueryKind::Why => "why",
            QueryKind::TouchedSince => "touched-since",
            QueryKind::By => "by",
            QueryKind::Callers => "callers",
            QueryKind::References => "references",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedQuery {
    kind: QueryKind,
    args: Vec<String>,
}

// The palette intentionally accepts whitespace-separated identifiers, DIDs,
// timestamps, and flags only. None of those need quoting, and avoiding shell
// syntax means a query expression can never become command execution.
fn parse_query(expression: &str) -> Result<ParsedQuery> {
    let mut words = expression.split_whitespace();
    let Some(command) = words.next() else {
        bail!("enter a query (for example: callers refresh)");
    };
    let kind = match command {
        "why" => QueryKind::Why,
        "touched-since" => QueryKind::TouchedSince,
        "by" => QueryKind::By,
        "callers" => QueryKind::Callers,
        "references" => QueryKind::References,
        _ => bail!("unknown query {command}"),
    };
    let args = words
        .filter(|word| *word != "--json")
        .map(str::to_string)
        .collect();
    Ok(ParsedQuery { kind, args })
}

fn decode_result(kind: QueryKind, bytes: &[u8]) -> Result<QueryResult> {
    Ok(match kind {
        QueryKind::Why => {
            QueryResult::Why(serde_json::from_slice(bytes).context("decode query why JSON")?)
        }
        QueryKind::TouchedSince | QueryKind::By => {
            QueryResult::Ops(serde_json::from_slice(bytes).context("decode operation query JSON")?)
        }
        QueryKind::Callers => QueryResult::Callers(
            serde_json::from_slice(bytes).context("decode callers query JSON")?,
        ),
        QueryKind::References => QueryResult::References(
            serde_json::from_slice(bytes).context("decode references query JSON")?,
        ),
    })
}

#[derive(Debug, Deserialize)]
struct WorkcopyConfig {
    server: String,
    repo: String,
    view: Option<String>,
}

/// The seam App uses so key handling can be tested without spawning a process.
pub trait QuerySource {
    fn repo(&self) -> &str;
    fn server(&self) -> &str;
    fn view(&self) -> &str;
    fn run(&self, expression: &str) -> Result<QueryResult>;
}

pub struct LocalQueries {
    root: PathBuf,
    repo: String,
    server: String,
    view: String,
    executable: OsString,
}

impl LocalQueries {
    /// Find the nearest working-copy config at or above `start`.
    pub fn discover(start: &Path) -> Result<Option<Self>> {
        for dir in start.ancestors() {
            let config_path = dir.join(".thaddeus").join("config.json");
            if !config_path.is_file() {
                continue;
            }
            let text = fs::read_to_string(&config_path)
                .with_context(|| format!("read {}", config_path.display()))?;
            let config: WorkcopyConfig = serde_json::from_str(&text)
                .with_context(|| format!("decode {}", config_path.display()))?;
            return Ok(Some(LocalQueries {
                root: dir.to_path_buf(),
                repo: config.repo,
                server: config.server,
                view: config.view.unwrap_or_else(|| "main".to_string()),
                executable: resolve_executable(),
            }));
        }
        Ok(None)
    }
}

impl QuerySource for LocalQueries {
    fn repo(&self) -> &str {
        &self.repo
    }

    fn server(&self) -> &str {
        &self.server
    }

    fn view(&self) -> &str {
        &self.view
    }

    fn run(&self, expression: &str) -> Result<QueryResult> {
        let parsed = parse_query(expression)?;
        let output = Command::new(&self.executable)
            .current_dir(&self.root)
            .arg("query")
            .arg(parsed.kind.command())
            .args(&parsed.args)
            .arg("--json")
            .output()
            .with_context(|| {
                format!(
                    "run {} (install the thaddeus CLI or set THADDEUS_BIN)",
                    Path::new(&self.executable).display()
                )
            })?;
        if !output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let message = if stdout.trim().is_empty() {
                stderr.trim()
            } else {
                stdout.trim()
            };
            bail!(
                "query failed{}: {}",
                output
                    .status
                    .code()
                    .map(|code| format!(" (exit {code})"))
                    .unwrap_or_default(),
                if message.is_empty() {
                    "no diagnostic"
                } else {
                    message
                }
            );
        }
        decode_result(parsed.kind, &output.stdout)
    }
}

fn resolve_executable() -> OsString {
    if let Some(override_path) = env::var_os("THADDEUS_BIN") {
        return override_path;
    }
    if let Ok(current) = env::current_exe() {
        let sibling = current.with_file_name(if cfg!(windows) {
            "thaddeus.exe"
        } else {
            "thaddeus"
        });
        if sibling.is_file() {
            return sibling.into_os_string();
        }
    }
    OsString::from(if cfg!(windows) {
        "thaddeus.exe"
    } else {
        "thaddeus"
    })
}

/// Compare server identities without making a trailing slash significant.
pub fn same_server(a: &str, b: &str) -> bool {
    a.trim_end_matches('/') == b.trim_end_matches('/')
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = env::temp_dir().join(format!("lazythad-{label}-{nonce}"));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn parses_only_the_five_query_commands_without_shell_syntax() {
        let parsed = parse_query("by did:key:zA --since 2026-01-01 --json").unwrap();
        assert_eq!(parsed.kind, QueryKind::By);
        assert_eq!(parsed.args, vec!["did:key:zA", "--since", "2026-01-01"]);
        assert!(parse_query("").is_err());
        assert!(parse_query("serve --port 1").is_err());
    }

    #[test]
    fn decodes_each_cli_json_shape() {
        let op =
            r#"{"id":"a","path":"a.rs","at":"t","author":"did:key:zA","lamport":1,"kind":"write"}"#;
        let why = format!(
            r#"{{"op":{op},"verified":true,"records":[{{"status":"verified","actor":"did:key:zA","actor_kind":"human","intent":"why","reasoning":"because","task":null}}]}}"#
        );
        assert!(matches!(
            decode_result(QueryKind::Why, why.as_bytes()).unwrap(),
            QueryResult::Why(result) if result.verified
        ));
        assert!(matches!(
            decode_result(QueryKind::By, format!("[{op}]").as_bytes()).unwrap(),
            QueryResult::Ops(ops) if ops.len() == 1
        ));
        assert!(matches!(
            decode_result(
                QueryKind::Callers,
                br#"[{"symbol":{"id":"s","kind":"function"},"definition":null}]"#,
            )
            .unwrap(),
            QueryResult::Callers(callers) if callers.len() == 1
        ));
        assert!(matches!(
            decode_result(
                QueryKind::References,
                br#"[{"symbol":"s","path":"a.rs","line":3}]"#,
            )
            .unwrap(),
            QueryResult::References(references) if references.len() == 1
        ));
    }

    #[test]
    fn discovers_the_nearest_working_copy_and_defaults_legacy_view() {
        let root = temp_dir("discover");
        let nested = root.join("src").join("nested");
        fs::create_dir_all(root.join(".thaddeus")).unwrap();
        fs::create_dir_all(&nested).unwrap();
        fs::write(
            root.join(".thaddeus").join("config.json"),
            r#"{"server":"http://localhost:4000/","repo":"acme/web","base":[]}"#,
        )
        .unwrap();

        let local = LocalQueries::discover(&nested).unwrap().unwrap();
        assert_eq!(local.root, root);
        assert_eq!(local.repo(), "acme/web");
        assert_eq!(local.view(), "main");
        assert!(same_server(local.server(), "http://localhost:4000"));

        fs::remove_dir_all(local.root).unwrap();
    }
}
