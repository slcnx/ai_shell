use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, Context, Result};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use strip_ansi_escapes::strip;
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

#[derive(Clone)]
struct PaneRuntime {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    child: Arc<Mutex<Box<dyn Child + Send>>>,
}

struct AppState {
    panes: Mutex<HashMap<String, PaneRuntime>>,
    pane_runtime_starts: Mutex<HashMap<String, i64>>,
    working_directory: Mutex<Option<PathBuf>>,
    app_config: Mutex<AppConfig>,
    config_path: PathBuf,
    db_path: PathBuf,
    adapter_config_dir: PathBuf,
    log_path: PathBuf,
    log_lock: Mutex<()>,
}

#[derive(Debug, Serialize, Clone)]
struct PaneSummary {
    id: String,
    provider: String,
    title: String,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Serialize, Clone)]
struct EntryRecord {
    id: String,
    pane_id: String,
    kind: String,
    content: String,
    synced_from: Option<String>,
    created_at: i64,
}

#[derive(Debug, Serialize, Clone)]
struct ProviderPromptResponse {
    input: EntryRecord,
    output: EntryRecord,
    mode: String,
}

#[derive(Debug, Serialize, Clone)]
struct NativeImportResult {
    provider: String,
    pane_id: String,
    session_id: String,
    source_dir: String,
    imported: i64,
    skipped: i64,
    scanned_files: i64,
    scanned_lines: i64,
    parse_errors: i64,
}

#[derive(Debug, Serialize)]
struct ObservabilityInfo {
    log_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
struct AppConfig {
    working_directory: Option<String>,
}

#[derive(Debug, Serialize)]
struct AppConfigResponse {
    config_path: String,
    working_directory: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct TerminalOutputEvent {
    pane_id: String,
    data: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct TerminalExitEvent {
    pane_id: String,
}

const IMPORT_FILE_QUIET_WINDOW_SECS: i64 = 2;

fn now_epoch() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

fn should_wait_for_file_settle(mtime: i64) -> bool {
    if mtime <= 0 {
        return false;
    }
    let elapsed = now_epoch().saturating_sub(mtime);
    elapsed < IMPORT_FILE_QUIET_WINDOW_SECS
}

fn open_db(path: &Path) -> Result<Connection> {
    let connection = Connection::open(path).with_context(|| {
        format!(
            "failed to open sqlite database at {}",
            path.to_string_lossy()
        )
    })?;
    Ok(connection)
}

fn init_schema(path: &Path) -> Result<()> {
    let connection = open_db(path)?;
    connection.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS panes (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          title TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          closed INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS entries (
          id TEXT PRIMARY KEY,
          pane_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          content TEXT NOT NULL,
          synced_from TEXT,
          external_key TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY(pane_id) REFERENCES panes(id)
        );

        CREATE INDEX IF NOT EXISTS idx_entries_pane_created
          ON entries(pane_id, created_at);

        "#,
    )?;

    if let Err(error) =
        connection.execute("ALTER TABLE panes ADD COLUMN closed INTEGER NOT NULL DEFAULT 0", [])
    {
        let message = error.to_string().to_lowercase();
        if !message.contains("duplicate column name") {
            return Err(error.into());
        }
    }

    if let Err(error) = connection.execute("ALTER TABLE entries ADD COLUMN external_key TEXT", []) {
        let message = error.to_string().to_lowercase();
        if !message.contains("duplicate column name") {
            return Err(error.into());
        }
    }

    connection.execute_batch(
        r#"
        CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_external_key
          ON entries(external_key)
          WHERE external_key IS NOT NULL;

        CREATE TABLE IF NOT EXISTS codex_import_state (
          pane_id TEXT NOT NULL,
          file_path TEXT NOT NULL,
          last_line INTEGER NOT NULL DEFAULT 0,
          last_mtime INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (pane_id, file_path)
        );

        CREATE TABLE IF NOT EXISTS pane_codex_state (
          pane_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        "#,
    )?;

    Ok(())
}

fn load_app_config(path: &Path) -> AppConfig {
    if !path.exists() {
        return AppConfig::default();
    }
    let text = match fs::read_to_string(path) {
        Ok(value) => value,
        Err(_) => return AppConfig::default(),
    };
    if text.trim().is_empty() {
        return AppConfig::default();
    }
    serde_json::from_str::<AppConfig>(&text).unwrap_or_default()
}

fn save_app_config(path: &Path, config: &AppConfig) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let payload = serde_json::to_string_pretty(config)?;
    fs::write(path, payload)?;
    Ok(())
}

#[derive(Debug, Clone)]
struct PromptCommandCandidate {
    mode: String,
    args: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
struct BridgeCapabilities {
    tool_calling: bool,
    streaming: bool,
    history_messages: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
struct AdapterSendCandidateConfig {
    mode: String,
    args: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
struct AdapterConfig {
    id: String,
    command: String,
    login_status_commands: Vec<Vec<String>>,
    send_candidates: Vec<AdapterSendCandidateConfig>,
    history_template: Option<String>,
    stream_receive_mode: Option<String>,
    capabilities: BridgeCapabilities,
}

#[derive(Debug, Clone, Default)]
struct BridgeMessage {
    role: String,
    content: String,
}

trait ChatBridge: Send + Sync {
    fn id(&self) -> &str;
    fn command(&self) -> &str;
    fn send(&self, prompt: &str, history: &[BridgeMessage]) -> Vec<PromptCommandCandidate>;
    fn stream_receive(&self, raw: &str) -> String;
    fn format_history(&self, history: &[BridgeMessage], prompt: &str) -> String;
}

#[derive(Debug, Clone)]
struct ConfiguredChatBridge {
    config: AdapterConfig,
}

impl ConfiguredChatBridge {
    fn history_as_text(history: &[BridgeMessage]) -> String {
        history
            .iter()
            .map(|item| format!("{}: {}", item.role, item.content))
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn apply_template(value: &str, prompt: &str, history_text: &str) -> String {
        value
            .replace("{prompt}", prompt)
            .replace("{raw_prompt}", prompt)
            .replace("{history}", history_text)
    }
}

impl ChatBridge for ConfiguredChatBridge {
    fn id(&self) -> &str {
        self.config.id.as_str()
    }

    fn command(&self) -> &str {
        self.config.command.as_str()
    }

    fn send(&self, prompt: &str, history: &[BridgeMessage]) -> Vec<PromptCommandCandidate> {
        let formatted_prompt = self.format_history(history, prompt);
        let history_text = Self::history_as_text(history);
        self.config
            .send_candidates
            .iter()
            .map(|candidate| PromptCommandCandidate {
                mode: candidate.mode.clone(),
                args: candidate
                    .args
                    .iter()
                    .map(|value| Self::apply_template(value, &formatted_prompt, &history_text))
                    .collect::<Vec<_>>(),
            })
            .collect::<Vec<_>>()
    }

    fn stream_receive(&self, raw: &str) -> String {
        match self.config.stream_receive_mode.as_deref() {
            Some("plain") => sanitize_log_text(raw),
            _ => structured_text_from_output(raw),
        }
    }

    fn format_history(&self, history: &[BridgeMessage], prompt: &str) -> String {
        let history_text = Self::history_as_text(history);
        if let Some(template) = self.config.history_template.as_ref() {
            return Self::apply_template(template, prompt, &history_text);
        }
        if history_text.trim().is_empty() {
            return prompt.to_string();
        }
        format!("{}\n\n{}", history_text, prompt)
    }
}

fn built_in_adapter_configs() -> Vec<AdapterConfig> {
    vec![
        AdapterConfig {
            id: "codex".to_string(),
            command: "codex".to_string(),
            login_status_commands: vec![vec!["login".to_string(), "status".to_string()]],
            send_candidates: vec![
                AdapterSendCandidateConfig {
                    mode: "codex-exec-json".to_string(),
                    args: vec!["exec".to_string(), "{prompt}".to_string(), "--json".to_string()],
                },
                AdapterSendCandidateConfig {
                    mode: "codex-exec-text".to_string(),
                    args: vec!["exec".to_string(), "{prompt}".to_string()],
                },
            ],
            history_template: None,
            stream_receive_mode: Some("structured_json".to_string()),
            capabilities: BridgeCapabilities {
                tool_calling: true,
                streaming: false,
                history_messages: false,
            },
        },
        AdapterConfig {
            id: "claude".to_string(),
            command: "claude".to_string(),
            login_status_commands: vec![
                vec!["auth".to_string(), "status".to_string()],
                vec!["login".to_string(), "status".to_string()],
            ],
            send_candidates: vec![
                AdapterSendCandidateConfig {
                    mode: "claude-print-stream-json".to_string(),
                    args: vec![
                        "-p".to_string(),
                        "{prompt}".to_string(),
                        "--output-format".to_string(),
                        "stream-json".to_string(),
                    ],
                },
                AdapterSendCandidateConfig {
                    mode: "claude-print-json".to_string(),
                    args: vec![
                        "-p".to_string(),
                        "{prompt}".to_string(),
                        "--output-format".to_string(),
                        "json".to_string(),
                    ],
                },
                AdapterSendCandidateConfig {
                    mode: "claude-print-text".to_string(),
                    args: vec!["-p".to_string(), "{prompt}".to_string()],
                },
            ],
            history_template: None,
            stream_receive_mode: Some("structured_json".to_string()),
            capabilities: BridgeCapabilities {
                tool_calling: true,
                streaming: true,
                history_messages: false,
            },
        },
        AdapterConfig {
            id: "gemini".to_string(),
            command: "gemini".to_string(),
            login_status_commands: vec![
                vec!["auth".to_string(), "status".to_string()],
                vec!["login".to_string(), "status".to_string()],
            ],
            send_candidates: vec![
                AdapterSendCandidateConfig {
                    mode: "gemini-print-json".to_string(),
                    args: vec![
                        "-p".to_string(),
                        "{prompt}".to_string(),
                        "--output-format".to_string(),
                        "json".to_string(),
                    ],
                },
                AdapterSendCandidateConfig {
                    mode: "gemini-print-text".to_string(),
                    args: vec!["-p".to_string(), "{prompt}".to_string()],
                },
            ],
            history_template: None,
            stream_receive_mode: Some("structured_json".to_string()),
            capabilities: BridgeCapabilities {
                tool_calling: false,
                streaming: false,
                history_messages: false,
            },
        },
    ]
}

fn normalize_adapter_config(config: AdapterConfig) -> Option<AdapterConfig> {
    let id = config.id.trim().to_lowercase();
    let command = config.command.trim().to_string();
    if id.is_empty() || command.is_empty() {
        return None;
    }

    let login_status_commands = config
        .login_status_commands
        .into_iter()
        .map(|command_parts| {
            command_parts
                .into_iter()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
        })
        .filter(|command_parts| !command_parts.is_empty())
        .collect::<Vec<_>>();

    let send_candidates = config
        .send_candidates
        .into_iter()
        .filter_map(|candidate| {
            let mode = candidate.mode.trim().to_string();
            let args = candidate
                .args
                .into_iter()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>();
            if mode.is_empty() || args.is_empty() {
                return None;
            }
            Some(AdapterSendCandidateConfig { mode, args })
        })
        .collect::<Vec<_>>();

    Some(AdapterConfig {
        id,
        command,
        login_status_commands,
        send_candidates,
        history_template: config.history_template,
        stream_receive_mode: config.stream_receive_mode,
        capabilities: config.capabilities,
    })
}

fn parse_adapter_config_blob(path: &Path, raw: &str) -> Vec<AdapterConfig> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_lowercase())
        .unwrap_or_default();

    let parsed = if extension == "yaml" || extension == "yml" {
        serde_yaml::from_str::<Vec<AdapterConfig>>(raw)
            .ok()
            .or_else(|| serde_yaml::from_str::<AdapterConfig>(raw).ok().map(|item| vec![item]))
    } else {
        serde_json::from_str::<Vec<AdapterConfig>>(raw)
            .ok()
            .or_else(|| serde_json::from_str::<AdapterConfig>(raw).ok().map(|item| vec![item]))
    };

    parsed.unwrap_or_default()
}

fn load_external_adapter_configs(adapter_config_dir: &Path) -> Vec<AdapterConfig> {
    if !adapter_config_dir.exists() {
        return Vec::new();
    }

    let mut collected = Vec::new();
    let entries = match fs::read_dir(adapter_config_dir) {
        Ok(entries) => entries,
        Err(_) => return collected,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_lowercase())
            .unwrap_or_default();
        if extension != "json" && extension != "yaml" && extension != "yml" {
            continue;
        }

        let raw = match fs::read_to_string(&path) {
            Ok(raw) => raw,
            Err(_) => continue,
        };
        let parsed = parse_adapter_config_blob(&path, &raw);
        for config in parsed {
            if let Some(normalized) = normalize_adapter_config(config) {
                collected.push(normalized);
            }
        }
    }

    collected
}

fn load_registered_bridges(adapter_config_dir: &Path) -> Vec<Box<dyn ChatBridge>> {
    let mut by_id = HashMap::<String, AdapterConfig>::new();

    for config in built_in_adapter_configs() {
        if let Some(normalized) = normalize_adapter_config(config) {
            by_id.insert(normalized.id.clone(), normalized);
        }
    }
    for config in load_external_adapter_configs(adapter_config_dir) {
        by_id.insert(config.id.clone(), config);
    }

    let mut pairs = by_id.into_iter().collect::<Vec<_>>();
    pairs.sort_by(|left, right| left.0.cmp(&right.0));

    pairs
        .into_iter()
        .map(|(_, config)| Box::new(ConfiguredChatBridge { config }) as Box<dyn ChatBridge>)
        .collect::<Vec<_>>()
}

fn resolve_chat_bridge(
    adapter_config_dir: &Path,
    provider: &str,
) -> Result<Box<dyn ChatBridge>, String> {
    let normalized = provider.trim().to_lowercase();
    if normalized.is_empty() {
        return Err("provider is empty".to_string());
    }

    for bridge in load_registered_bridges(adapter_config_dir) {
        if bridge.id() == normalized {
            return Ok(bridge);
        }
    }

    Err(format!(
        "unsupported provider adapter: {} (not found in built-in or adapter config dir)",
        normalized
    ))
}

fn list_registered_provider_ids(adapter_config_dir: &Path) -> Vec<String> {
    load_registered_bridges(adapter_config_dir)
        .into_iter()
        .map(|bridge| bridge.id().to_string())
        .collect::<Vec<_>>()
}

fn ensure_adapter_sample_file(adapter_config_dir: &Path) {
    let sample_path = adapter_config_dir.join("adapter.sample.yaml");
    if sample_path.exists() {
        return;
    }

    let sample = r#"id: qwen
command: qwen
login_status_commands:
  - ["auth", "status"]
send_candidates:
  - mode: qwen-text
    args: ["-p", "{prompt}"]
history_template: "{history}\n\nUser: {prompt}"
stream_receive_mode: plain
capabilities:
  tool_calling: false
  streaming: false
  history_messages: true
"#;
    let _ = std::fs::write(sample_path, sample);
}

fn shell_command_builder(cwd: Option<&Path>) -> CommandBuilder {
    #[cfg(target_os = "windows")]
    {
        let mut builder = CommandBuilder::new("powershell");
        builder.arg("-NoLogo");
        builder.arg("-NoExit");
        if let Some(path) = cwd {
            builder.cwd(path);
        }
        builder
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut builder = CommandBuilder::new("bash");
        builder.arg("-l");
        if let Some(path) = cwd {
            builder.cwd(path);
        }
        builder
    }
}

fn sanitize_log_text(content: &str) -> String {
    let stripped = strip(content.as_bytes());
    let mut value = String::from_utf8_lossy(&stripped).to_string();
    value = value.replace("\r\n", "\n");
    value = value.replace('\r', "\n");
    value = value.replace('\u{0008}', "");
    value = value.replace('\u{0000}', "");
    value
}

fn normalize_for_dedupe(kind: &str, content: &str) -> String {
    let text = sanitize_log_text(content);
    if kind == "input" {
        return text.split_whitespace().collect::<Vec<_>>().join(" ");
    }

    let lines = text
        .lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    lines.join("\n")
}

fn insert_pane(path: &Path, pane: &PaneSummary) -> Result<()> {
    let connection = open_db(path)?;
    connection.execute(
        r#"
        INSERT INTO panes (id, provider, title, created_at, updated_at, closed)
        VALUES (?1, ?2, ?3, ?4, ?5, 0)
        "#,
        params![
            pane.id,
            pane.provider,
            pane.title,
            pane.created_at,
            pane.updated_at
        ],
    )?;
    Ok(())
}

fn mark_pane_closed(path: &Path, pane_id: &str) -> Result<()> {
    let connection = open_db(path)?;
    connection.execute(
        "UPDATE panes SET closed = 1, updated_at = ?2 WHERE id = ?1",
        params![pane_id, now_epoch()],
    )?;
    Ok(())
}

fn load_provider(path: &Path, pane_id: &str) -> Result<String> {
    let connection = open_db(path)?;
    let provider = connection.query_row(
        "SELECT provider FROM panes WHERE id = ?1 AND closed = 0",
        params![pane_id],
        |row| row.get::<usize, String>(0),
    )?;
    Ok(provider)
}

fn load_provider_any(path: &Path, pane_id: &str) -> Option<String> {
    let connection = open_db(path).ok()?;
    connection
        .query_row(
            "SELECT provider FROM panes WHERE id = ?1",
            params![pane_id],
            |row| row.get::<usize, String>(0),
        )
        .ok()
}

fn write_observable_event(state: &AppState, value: serde_json::Value) -> Result<()> {
    let _guard = state
        .log_lock
        .lock()
        .map_err(|_| anyhow!("failed to lock observability log"))?;
    let line = serde_json::to_string(&value)?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&state.log_path)
        .with_context(|| format!("failed to open {}", state.log_path.to_string_lossy()))?;
    writeln!(file, "{}", line)?;
    Ok(())
}

fn log_entry_event(state: &AppState, entry: &EntryRecord, source: &str, mode: Option<&str>) {
    let provider = load_provider_any(&state.db_path, &entry.pane_id);
    let payload = serde_json::json!({
        "ts": now_epoch(),
        "event": "history.entry",
        "source": source,
        "mode": mode,
        "pane_id": entry.pane_id,
        "provider": provider,
        "entry_id": entry.id,
        "kind": entry.kind,
        "content": entry.content,
        "content_len": entry.content.len(),
        "created_at": entry.created_at
    });
    let _ = write_observable_event(state, payload);
}

fn add_entry(
    path: &Path,
    pane_id: &str,
    kind: &str,
    content: &str,
    synced_from: Option<&str>,
) -> Result<EntryRecord> {
    let connection = open_db(path)?;
    let timestamp = now_epoch();
    let sanitized = sanitize_log_text(content);
    let normalized = normalize_for_dedupe(kind, &sanitized);

    if (kind == "output" || kind == "input") && !normalized.is_empty() {
        let mut stmt = connection.prepare(
            r#"
            SELECT id, pane_id, kind, content, synced_from, created_at
            FROM entries
            WHERE pane_id = ?1 AND kind = ?2
            ORDER BY created_at DESC
            LIMIT 1
            "#,
        )?;
        let latest = stmt.query_row(params![pane_id, kind], |row| {
            Ok(EntryRecord {
                id: row.get(0)?,
                pane_id: row.get(1)?,
                kind: row.get(2)?,
                content: row.get(3)?,
                synced_from: row.get(4)?,
                created_at: row.get(5)?,
            })
        });
        if let Ok(last) = latest {
            let last_normalized = normalize_for_dedupe(kind, &last.content);
            let repeated = last_normalized == normalized
                || (kind == "output"
                    && !last_normalized.is_empty()
                    && (last_normalized.contains(&normalized)
                        || normalized.contains(&last_normalized)));
            if repeated && timestamp - last.created_at <= 120 {
                return Ok(last);
            }
        }
    }

    let entry = EntryRecord {
        id: Uuid::new_v4().to_string(),
        pane_id: pane_id.to_string(),
        kind: kind.to_string(),
        content: sanitized,
        synced_from: synced_from.map(|value| value.to_string()),
        created_at: timestamp,
    };

    connection.execute(
        r#"
        INSERT INTO entries (id, pane_id, kind, content, synced_from, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        "#,
        params![
            entry.id,
            entry.pane_id,
            entry.kind,
            entry.content,
            entry.synced_from,
            entry.created_at
        ],
    )?;

    connection.execute(
        "UPDATE panes SET updated_at = ?2 WHERE id = ?1",
        params![pane_id, timestamp],
    )?;

    Ok(entry)
}

fn list_panes_db(path: &Path) -> Result<Vec<PaneSummary>> {
    let connection = open_db(path)?;
    let mut stmt = connection.prepare(
        r#"
        SELECT id, provider, title, created_at, updated_at
        FROM panes
        WHERE closed = 0
        ORDER BY created_at ASC, rowid ASC
        "#,
    )?;

    let rows = stmt.query_map([], |row| {
        Ok(PaneSummary {
            id: row.get(0)?,
            provider: row.get(1)?,
            title: row.get(2)?,
            created_at: row.get(3)?,
            updated_at: row.get(4)?,
        })
    })?;

    let mut items = Vec::new();
    for row in rows {
        items.push(row?);
    }
    Ok(items)
}

fn list_entries_db(
    path: &Path,
    pane_id: &str,
    query: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<EntryRecord>> {
    let connection = open_db(path)?;
    let mut result = Vec::new();
    let page_limit = limit.unwrap_or(0);
    let page_offset = offset.unwrap_or(0);
    let paged = page_limit > 0;

    if let Some(raw_query) = query {
        let normalized = raw_query.trim();
        if !normalized.is_empty() {
            let like = format!("%{}%", normalized);
            if paged {
                let mut stmt = connection.prepare(
                    r#"
                    SELECT id, pane_id, kind, content, synced_from, created_at
                    FROM entries
                    WHERE pane_id = ?1
                      AND kind IN ('input', 'output')
                      AND content LIKE ?2
                    ORDER BY created_at DESC
                    LIMIT ?3 OFFSET ?4
                    "#,
                )?;
                let rows = stmt.query_map(params![pane_id, like, page_limit, page_offset], |row| {
                    Ok(EntryRecord {
                        id: row.get(0)?,
                        pane_id: row.get(1)?,
                        kind: row.get(2)?,
                        content: row.get(3)?,
                        synced_from: row.get(4)?,
                        created_at: row.get(5)?,
                    })
                })?;
                for row in rows {
                    result.push(row?);
                }
            } else {
                let mut stmt = connection.prepare(
                    r#"
                    SELECT id, pane_id, kind, content, synced_from, created_at
                    FROM entries
                    WHERE pane_id = ?1
                      AND kind IN ('input', 'output')
                      AND content LIKE ?2
                    ORDER BY created_at ASC
                    "#,
                )?;
                let rows = stmt.query_map(params![pane_id, like], |row| {
                    Ok(EntryRecord {
                        id: row.get(0)?,
                        pane_id: row.get(1)?,
                        kind: row.get(2)?,
                        content: row.get(3)?,
                        synced_from: row.get(4)?,
                        created_at: row.get(5)?,
                    })
                })?;
                for row in rows {
                    result.push(row?);
                }
            }
            if paged {
                result.reverse();
            }
            return Ok(result);
        }
    }

    if paged {
        let mut stmt = connection.prepare(
            r#"
            SELECT id, pane_id, kind, content, synced_from, created_at
            FROM entries
            WHERE pane_id = ?1
              AND kind IN ('input', 'output')
            ORDER BY created_at DESC
            LIMIT ?2 OFFSET ?3
            "#,
        )?;
        let rows = stmt.query_map(params![pane_id, page_limit, page_offset], |row| {
            Ok(EntryRecord {
                id: row.get(0)?,
                pane_id: row.get(1)?,
                kind: row.get(2)?,
                content: row.get(3)?,
                synced_from: row.get(4)?,
                created_at: row.get(5)?,
            })
        })?;
        for row in rows {
            result.push(row?);
        }
    } else {
        let mut stmt = connection.prepare(
            r#"
            SELECT id, pane_id, kind, content, synced_from, created_at
            FROM entries
            WHERE pane_id = ?1
              AND kind IN ('input', 'output')
            ORDER BY created_at ASC
            "#,
        )?;
        let rows = stmt.query_map(params![pane_id], |row| {
            Ok(EntryRecord {
                id: row.get(0)?,
                pane_id: row.get(1)?,
                kind: row.get(2)?,
                content: row.get(3)?,
                synced_from: row.get(4)?,
                created_at: row.get(5)?,
            })
        })?;
        for row in rows {
            result.push(row?);
        }
    }
    if paged {
        result.reverse();
    }

    Ok(result)
}

fn count_entries_db(path: &Path, pane_id: &str, query: Option<String>) -> Result<i64> {
    let connection = open_db(path)?;
    if let Some(raw_query) = query {
        let normalized = raw_query.trim();
        if !normalized.is_empty() {
            let like = format!("%{}%", normalized);
            let count = connection.query_row(
                "SELECT COUNT(1) FROM entries WHERE pane_id = ?1 AND kind IN ('input', 'output') AND content LIKE ?2",
                params![pane_id, like],
                |row| row.get::<usize, i64>(0),
            )?;
            return Ok(count);
        }
    }

    let count = connection.query_row(
        "SELECT COUNT(1) FROM entries WHERE pane_id = ?1 AND kind IN ('input', 'output')",
        params![pane_id],
        |row| row.get::<usize, i64>(0),
    )?;
    Ok(count)
}

fn export_all_history_markdown_db(path: &Path) -> Result<String> {
    let connection = open_db(path)?;
    let mut markdown = String::new();
    markdown.push_str("# AI Shell History Export\n\n");
    markdown.push_str(&format!("Exported at epoch: {}\n\n", now_epoch()));

    let mut pane_stmt = connection.prepare(
        r#"
        SELECT id, provider, title, created_at, updated_at, closed
        FROM panes
        ORDER BY created_at ASC
        "#,
    )?;
    let pane_rows = pane_stmt.query_map([], |row| {
        Ok((
            row.get::<usize, String>(0)?,
            row.get::<usize, String>(1)?,
            row.get::<usize, String>(2)?,
            row.get::<usize, i64>(3)?,
            row.get::<usize, i64>(4)?,
            row.get::<usize, i64>(5)?,
        ))
    })?;

    let mut pane_count = 0;
    for pane in pane_rows {
        let (pane_id, provider, title, created_at, updated_at, closed) = pane?;
        pane_count += 1;

        markdown.push_str(&format!("## {} ({})\n\n", title, provider));
        markdown.push_str(&format!("- Pane ID: `{}`\n", pane_id));
        markdown.push_str(&format!("- Created: `{}`\n", created_at));
        markdown.push_str(&format!("- Updated: `{}`\n", updated_at));
        markdown.push_str(&format!("- Closed: `{}`\n\n", closed == 1));

        let mut entry_stmt = connection.prepare(
            r#"
            SELECT id, kind, content, synced_from, created_at
            FROM entries
            WHERE pane_id = ?1
              AND kind IN ('input', 'output')
            ORDER BY created_at ASC
            "#,
        )?;
        let entry_rows = entry_stmt.query_map(params![pane_id], |row| {
            Ok((
                row.get::<usize, String>(0)?,
                row.get::<usize, String>(1)?,
                row.get::<usize, String>(2)?,
                row.get::<usize, Option<String>>(3)?,
                row.get::<usize, i64>(4)?,
            ))
        })?;

        for entry in entry_rows {
            let (entry_id, kind, content, synced_from, created_at) = entry?;
            markdown.push_str(&format!("### [{}] {}\n\n", created_at, kind));
            markdown.push_str(&format!("- Entry ID: `{}`\n", entry_id));
            if let Some(source) = synced_from {
                markdown.push_str(&format!("- Synced From: `{}`\n", source));
            }
            markdown.push_str("\n````text\n");
            markdown.push_str(&content);
            if !content.ends_with('\n') {
                markdown.push('\n');
            }
            markdown.push_str("````\n\n");
        }

        markdown.push('\n');
    }

    if pane_count == 0 {
        markdown.push_str("_No sessions stored._\n");
    }

    Ok(markdown)
}

fn clear_all_history_db(path: &Path) -> Result<()> {
    let connection = open_db(path)?;
    connection.execute_batch(
        r#"
        DELETE FROM entries;
        DELETE FROM codex_import_state;
        DELETE FROM pane_codex_state;
        DELETE FROM panes;
        "#,
    )?;
    Ok(())
}

fn clear_pane_history_db(path: &Path, pane_id: &str) -> Result<()> {
    let mut connection = open_db(path)?;
    let tx = connection.transaction()?;

    tx.execute("DELETE FROM entries WHERE pane_id = ?1", params![pane_id])?;
    tx.execute(
        "DELETE FROM codex_import_state WHERE pane_id = ?1",
        params![pane_id],
    )?;
    tx.execute("DELETE FROM pane_codex_state WHERE pane_id = ?1", params![pane_id])?;
    tx.execute(
        "UPDATE panes SET updated_at = ?2 WHERE id = ?1",
        params![pane_id, now_epoch()],
    )?;

    tx.commit()?;
    Ok(())
}

fn codex_home_dir() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("CODEX_HOME") {
        if !path.trim().is_empty() {
            return Some(PathBuf::from(path));
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Ok(home) = std::env::var("USERPROFILE") {
            return Some(PathBuf::from(home).join(".codex"));
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(home) = std::env::var("HOME") {
            return Some(PathBuf::from(home).join(".codex"));
        }
    }

    None
}

fn claude_home_dir() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("CLAUDE_HOME") {
        if !path.trim().is_empty() {
            return Some(PathBuf::from(path));
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Ok(home) = std::env::var("USERPROFILE") {
            return Some(PathBuf::from(home).join(".claude"));
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(home) = std::env::var("HOME") {
            return Some(PathBuf::from(home).join(".claude"));
        }
    }

    None
}

fn gemini_home_dir() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("GEMINI_HOME") {
        if !path.trim().is_empty() {
            return Some(PathBuf::from(path));
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Ok(home) = std::env::var("USERPROFILE") {
            return Some(PathBuf::from(home).join(".gemini"));
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(home) = std::env::var("HOME") {
            return Some(PathBuf::from(home).join(".gemini"));
        }
    }

    None
}

fn codex_sessions_dir() -> Option<PathBuf> {
    codex_home_dir().map(|path| path.join("sessions"))
}

fn claude_projects_dir() -> Option<PathBuf> {
    claude_home_dir().map(|path| path.join("projects"))
}

fn gemini_sessions_root_dir() -> Option<PathBuf> {
    gemini_home_dir().map(|path| path.join("tmp"))
}

fn is_rollout_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.starts_with("rollout-") && name.ends_with(".jsonl"))
        .unwrap_or(false)
}

fn collect_rollout_files(root: &Path, bucket: &mut Vec<PathBuf>) -> Result<()> {
    if !root.exists() {
        return Ok(());
    }

    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        let meta = entry.metadata()?;
        if meta.is_dir() {
            collect_rollout_files(&path, bucket)?;
            continue;
        }

        if meta.is_file() && is_rollout_file(&path) {
            bucket.push(path);
        }
    }

    Ok(())
}

fn is_claude_session_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.ends_with(".jsonl"))
        .unwrap_or(false)
}

fn collect_claude_session_files(root: &Path, bucket: &mut Vec<PathBuf>) -> Result<()> {
    if !root.exists() {
        return Ok(());
    }

    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        let meta = entry.metadata()?;
        if meta.is_dir() {
            collect_claude_session_files(&path, bucket)?;
            continue;
        }
        if meta.is_file() && is_claude_session_file(&path) {
            bucket.push(path);
        }
    }

    Ok(())
}

fn is_gemini_session_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.starts_with("session-") && name.ends_with(".json"))
        .unwrap_or(false)
}

fn collect_gemini_session_files(root: &Path, bucket: &mut Vec<PathBuf>) -> Result<()> {
    if !root.exists() {
        return Ok(());
    }

    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        let meta = entry.metadata()?;
        if meta.is_dir() {
            collect_gemini_session_files(&path, bucket)?;
            continue;
        }
        if meta.is_file() && is_gemini_session_file(&path) {
            bucket.push(path);
        }
    }

    Ok(())
}

fn file_mtime_epoch(path: &Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_secs() as i64)
        .unwrap_or_default()
}

fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let adjusted_year = year - if month <= 2 { 1 } else { 0 };
    let era = if adjusted_year >= 0 {
        adjusted_year / 400
    } else {
        (adjusted_year - 399) / 400
    };
    let year_of_era = adjusted_year - era * 400;
    let month_prime = month as i32 + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month_prime + 2) / 5 + day as i32 - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era as i64 * 146097 + day_of_era as i64 - 719468
}

fn parse_rfc3339_epoch_seconds(value: &str) -> Option<i64> {
    if value.len() < 20 {
        return None;
    }

    let year: i32 = value.get(0..4)?.parse().ok()?;
    let month: u32 = value.get(5..7)?.parse().ok()?;
    let day: u32 = value.get(8..10)?.parse().ok()?;
    let hour: u32 = value.get(11..13)?.parse().ok()?;
    let minute: u32 = value.get(14..16)?.parse().ok()?;
    let second: u32 = value.get(17..19)?.parse().ok()?;

    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }

    let offset_marker = value[19..]
        .find(|ch| ch == 'Z' || ch == '+' || ch == '-')
        .map(|index| index + 19)?;

    let offset_seconds = match value.as_bytes().get(offset_marker).copied() {
        Some(b'Z') => 0_i64,
        Some(sign @ (b'+' | b'-')) => {
            let tz_hour: i64 = value.get(offset_marker + 1..offset_marker + 3)?.parse().ok()?;
            let tz_minute: i64 = value.get(offset_marker + 4..offset_marker + 6)?.parse().ok()?;
            if tz_hour > 23 || tz_minute > 59 {
                return None;
            }
            let seconds = tz_hour * 3600 + tz_minute * 60;
            if sign == b'+' {
                seconds
            } else {
                -seconds
            }
        }
        _ => return None,
    };

    let unix_days = days_from_civil(year, month, day);
    let unix_seconds = unix_days * 86_400 + hour as i64 * 3_600 + minute as i64 * 60 + second as i64;
    Some(unix_seconds - offset_seconds)
}

#[derive(Debug, Clone)]
struct CodexRolloutMeta {
    file_path: PathBuf,
    session_id: String,
    started_at: i64,
    file_time_key: i64,
    mtime: i64,
}

#[derive(Debug, Clone)]
struct ClaudeSessionMeta {
    file_path: PathBuf,
    session_id: String,
    started_at: i64,
    file_time_key: i64,
    mtime: i64,
}

#[derive(Debug, Clone)]
struct GeminiSessionMeta {
    file_path: PathBuf,
    session_id: String,
    started_at: i64,
    file_time_key: i64,
    mtime: i64,
}

fn normalize_session_id(value: Option<String>) -> Option<String> {
    value.and_then(|item| {
        let normalized = item.trim().to_string();
        if normalized.is_empty() {
            None
        } else {
            Some(normalized)
        }
    })
}

fn parse_rollout_file_time_key(path: &Path) -> i64 {
    let name = match path.file_name().and_then(|item| item.to_str()) {
        Some(value) => value,
        None => return 0,
    };
    if !name.starts_with("rollout-") {
        return 0;
    }
    // rollout-YYYY-MM-DDTHH-MM-SS-<sid>.jsonl
    let stamp = match name.get(8..27) {
        Some(value) => value,
        None => return 0,
    };
    let year = match stamp.get(0..4).and_then(|item| item.parse::<i64>().ok()) {
        Some(value) => value,
        None => return 0,
    };
    let month = match stamp.get(5..7).and_then(|item| item.parse::<i64>().ok()) {
        Some(value) => value,
        None => return 0,
    };
    let day = match stamp.get(8..10).and_then(|item| item.parse::<i64>().ok()) {
        Some(value) => value,
        None => return 0,
    };
    let hour = match stamp.get(11..13).and_then(|item| item.parse::<i64>().ok()) {
        Some(value) => value,
        None => return 0,
    };
    let minute = match stamp.get(14..16).and_then(|item| item.parse::<i64>().ok()) {
        Some(value) => value,
        None => return 0,
    };
    let second = match stamp.get(17..19).and_then(|item| item.parse::<i64>().ok()) {
        Some(value) => value,
        None => return 0,
    };
    year * 10_000_000_000
        + month * 100_000_000
        + day * 1_000_000
        + hour * 10_000
        + minute * 100
        + second
}

fn parse_gemini_file_time_key(path: &Path) -> i64 {
    let name = match path.file_name().and_then(|item| item.to_str()) {
        Some(value) => value,
        None => return 0,
    };
    if !name.starts_with("session-") {
        return 0;
    }
    // session-YYYY-MM-DDTHH-MM-<id>.json
    let stamp = match name.get(8..24) {
        Some(value) => value,
        None => return 0,
    };
    let year = match stamp.get(0..4).and_then(|item| item.parse::<i64>().ok()) {
        Some(value) => value,
        None => return 0,
    };
    let month = match stamp.get(5..7).and_then(|item| item.parse::<i64>().ok()) {
        Some(value) => value,
        None => return 0,
    };
    let day = match stamp.get(8..10).and_then(|item| item.parse::<i64>().ok()) {
        Some(value) => value,
        None => return 0,
    };
    let hour = match stamp.get(11..13).and_then(|item| item.parse::<i64>().ok()) {
        Some(value) => value,
        None => return 0,
    };
    let minute = match stamp.get(14..16).and_then(|item| item.parse::<i64>().ok()) {
        Some(value) => value,
        None => return 0,
    };
    year * 10_000_000_000 + month * 100_000_000 + day * 1_000_000 + hour * 10_000 + minute * 100
}

fn extract_json_string_field(raw: &str, key: &str) -> Option<String> {
    let quoted_key = format!("\"{}\"", key);
    let key_index = raw.find(&quoted_key)?;
    let tail = raw.get(key_index + quoted_key.len()..)?;
    let colon_index = tail.find(':')?;
    let mut cursor = tail.get(colon_index + 1..)?.trim_start();
    if !cursor.starts_with('\"') {
        return None;
    }
    cursor = cursor.get(1..)?;

    let mut escaped = false;
    let mut output = String::new();
    for ch in cursor.chars() {
        if escaped {
            let mapped = match ch {
                '\"' => '\"',
                '\\' => '\\',
                '/' => '/',
                'b' => '\u{0008}',
                'f' => '\u{000c}',
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                other => other,
            };
            output.push(mapped);
            escaped = false;
            continue;
        }

        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == '\"' {
            return Some(output);
        }
        output.push(ch);
    }

    None
}

fn extract_rollout_meta(path: &Path) -> Option<(String, i64)> {
    let file = File::open(path).ok()?;
    let reader = BufReader::new(file);
    for (line_index, row) in reader.lines().enumerate() {
        if line_index > 32 {
            break;
        }
        let line = row.ok()?;
        if line.trim().is_empty() {
            continue;
        }
        let value = serde_json::from_str::<serde_json::Value>(&line).ok()?;
        if value.get("type").and_then(|item| item.as_str()) != Some("session_meta") {
            continue;
        }
        let sid = value
            .get("payload")
            .and_then(|item| item.get("id"))
            .and_then(|item| item.as_str())?;
        let normalized = sid.trim();
        if normalized.is_empty() {
            continue;
        }
        let started_at = value
            .get("payload")
            .and_then(|item| item.get("timestamp"))
            .and_then(|item| item.as_str())
            .and_then(parse_rfc3339_epoch_seconds)
            .or_else(|| {
                value
                    .get("timestamp")
                    .and_then(|item| item.as_str())
                    .and_then(parse_rfc3339_epoch_seconds)
            })
            .unwrap_or_default();
        return Some((normalized.to_string(), started_at));
    }
    None
}

fn collect_rollout_metas(root: &Path) -> Result<Vec<CodexRolloutMeta>> {
    let mut files = Vec::new();
    collect_rollout_files(root, &mut files)?;
    let mut metas = Vec::new();
    for path in files {
        if let Some((session_id, started_at)) = extract_rollout_meta(&path) {
            metas.push(CodexRolloutMeta {
                mtime: file_mtime_epoch(&path),
                file_time_key: parse_rollout_file_time_key(&path),
                file_path: path,
                session_id,
                started_at,
            });
        }
    }
    Ok(metas)
}

fn extract_claude_meta(path: &Path) -> Option<(String, i64)> {
    let file = File::open(path).ok()?;
    let reader = BufReader::new(file);
    let mut session_id: Option<String> = None;
    let mut started_at = 0_i64;

    for (line_index, row) in reader.lines().enumerate() {
        if line_index > 240 && session_id.is_some() {
            break;
        }
        let line = match row {
            Ok(value) => value,
            Err(_) => continue,
        };
        if line.trim().is_empty() {
            continue;
        }
        let value = match serde_json::from_str::<serde_json::Value>(&line) {
            Ok(value) => value,
            Err(_) => continue,
        };

        if session_id.is_none() {
            session_id = value
                .get("sessionId")
                .and_then(|item| item.as_str())
                .map(|item| item.trim().to_string())
                .filter(|item| !item.is_empty());
        }
        if started_at == 0 {
            started_at = value
                .get("timestamp")
                .and_then(|item| item.as_str())
                .and_then(parse_rfc3339_epoch_seconds)
                .unwrap_or_default();
        }
        if session_id.is_some() && started_at > 0 {
            break;
        }
    }

    session_id.map(|sid| (sid, started_at))
}

fn collect_claude_metas(root: &Path) -> Result<Vec<ClaudeSessionMeta>> {
    let mut files = Vec::new();
    collect_claude_session_files(root, &mut files)?;
    let mut metas = Vec::new();
    for path in files {
        if let Some((session_id, started_at)) = extract_claude_meta(&path) {
            let mtime = file_mtime_epoch(&path);
            metas.push(ClaudeSessionMeta {
                file_path: path,
                session_id,
                started_at,
                file_time_key: if started_at > 0 { started_at } else { mtime },
                mtime,
            });
        }
    }
    Ok(metas)
}

fn extract_gemini_meta(path: &Path) -> Option<(String, i64)> {
    let raw = std::fs::read_to_string(path).ok()?;
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
        let session_id = value
            .get("sessionId")
            .and_then(|item| item.as_str())
            .map(|item| item.trim().to_string())
            .filter(|item| !item.is_empty())?;
        let started_at = value
            .get("startTime")
            .and_then(|item| item.as_str())
            .and_then(parse_rfc3339_epoch_seconds)
            .unwrap_or_default();
        return Some((session_id, started_at));
    }

    let session_id = extract_json_string_field(&raw, "sessionId")
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())?;
    let started_at = extract_json_string_field(&raw, "startTime")
        .and_then(|item| parse_rfc3339_epoch_seconds(&item))
        .unwrap_or_default();
    Some((session_id, started_at))
}

fn collect_gemini_metas(root: &Path) -> Result<Vec<GeminiSessionMeta>> {
    let mut files = Vec::new();
    collect_gemini_session_files(root, &mut files)?;
    let mut metas = Vec::new();
    for path in files {
        if let Some((session_id, started_at)) = extract_gemini_meta(&path) {
            metas.push(GeminiSessionMeta {
                mtime: file_mtime_epoch(&path),
                file_time_key: parse_gemini_file_time_key(&path),
                file_path: path,
                session_id,
                started_at,
            });
        }
    }
    Ok(metas)
}

fn save_bound_session_id(connection: &Connection, pane_id: &str, session_id: &str) -> Result<()> {
    connection.execute(
        r#"
        INSERT INTO pane_codex_state (pane_id, session_id, updated_at)
        VALUES (?1, ?2, ?3)
        ON CONFLICT(pane_id)
        DO UPDATE SET
          session_id = excluded.session_id,
          updated_at = excluded.updated_at
        "#,
        params![pane_id, session_id, now_epoch()],
    )?;
    Ok(())
}

fn resolve_codex_session_id(
    _connection: &Connection,
    pane_id: &str,
    requested_session_id: Option<String>,
    metas: &[CodexRolloutMeta],
) -> Option<String> {
    let _ = pane_id;
    if let Some(session_id) = normalize_session_id(requested_session_id) {
        return Some(session_id);
    }
    metas
        .iter()
        .max_by_key(|meta| (meta.file_time_key, meta.started_at, meta.mtime))
        .map(|meta| meta.session_id.clone())
}

fn load_pane_created_at(connection: &Connection, pane_id: &str) -> Result<Option<i64>> {
    connection
        .query_row(
            "SELECT created_at FROM panes WHERE id = ?1",
            params![pane_id],
            |row| row.get::<usize, i64>(0),
        )
        .optional()
        .map_err(Into::into)
}

fn suggest_codex_session_id_db(
    path: &Path,
    pane_id: &str,
    sessions_dir: &Path,
    min_mtime: Option<i64>,
) -> Result<Option<String>> {
    let metas = collect_rollout_metas(sessions_dir)?;
    if metas.is_empty() {
        return Ok(None);
    }

    if let Some(minimum) = min_mtime {
        let active = metas
            .iter()
            .filter(|meta| meta.started_at > 0 && meta.started_at >= minimum.saturating_sub(30))
            .max_by_key(|meta| (meta.file_time_key, meta.started_at, meta.mtime))
            .map(|meta| meta.session_id.clone());
        if active.is_some() {
            return Ok(active);
        }
        return Ok(None);
    }

    let connection = open_db(path)?;
    let pane_created_at = load_pane_created_at(&connection, pane_id)?.unwrap_or_default();
    let near_now = metas
        .iter()
        .filter(|meta| meta.started_at > 0 && meta.started_at >= pane_created_at.saturating_sub(180))
        .max_by_key(|meta| (meta.file_time_key, meta.started_at, meta.mtime))
        .map(|meta| meta.session_id.clone());

    if near_now.is_some() {
        return Ok(near_now);
    }

    Ok(metas
        .iter()
        .max_by_key(|meta| (meta.file_time_key, meta.started_at, meta.mtime))
        .map(|meta| meta.session_id.clone()))
}

fn suggest_claude_session_id_db(
    path: &Path,
    pane_id: &str,
    projects_dir: &Path,
    min_mtime: Option<i64>,
) -> Result<Option<String>> {
    let metas = collect_claude_metas(projects_dir)?;
    if metas.is_empty() {
        return Ok(None);
    }

    if let Some(minimum) = min_mtime {
        let active = metas
            .iter()
            .filter(|meta| meta.started_at > 0 && meta.started_at >= minimum.saturating_sub(30))
            .max_by_key(|meta| (meta.file_time_key, meta.started_at, meta.mtime))
            .map(|meta| meta.session_id.clone());
        if active.is_some() {
            return Ok(active);
        }
        return Ok(None);
    }

    let connection = open_db(path)?;
    let pane_created_at = load_pane_created_at(&connection, pane_id)?.unwrap_or_default();
    let near_now = metas
        .iter()
        .filter(|meta| meta.started_at > 0 && meta.started_at >= pane_created_at.saturating_sub(180))
        .max_by_key(|meta| (meta.file_time_key, meta.started_at, meta.mtime))
        .map(|meta| meta.session_id.clone());

    if near_now.is_some() {
        return Ok(near_now);
    }

    Ok(metas
        .iter()
        .max_by_key(|meta| (meta.file_time_key, meta.started_at, meta.mtime))
        .map(|meta| meta.session_id.clone()))
}

fn suggest_gemini_session_id_db(
    path: &Path,
    pane_id: &str,
    sessions_root: &Path,
    min_mtime: Option<i64>,
) -> Result<Option<String>> {
    let metas = collect_gemini_metas(sessions_root)?;
    if metas.is_empty() {
        return Ok(None);
    }

    if let Some(minimum) = min_mtime {
        let active = metas
            .iter()
            .filter(|meta| meta.started_at > 0 && meta.started_at >= minimum.saturating_sub(30))
            .max_by_key(|meta| (meta.file_time_key, meta.started_at, meta.mtime))
            .map(|meta| meta.session_id.clone());
        if active.is_some() {
            return Ok(active);
        }
        return Ok(None);
    }

    let connection = open_db(path)?;
    let pane_created_at = load_pane_created_at(&connection, pane_id)?.unwrap_or_default();
    let near_now = metas
        .iter()
        .filter(|meta| meta.started_at > 0 && meta.started_at >= pane_created_at.saturating_sub(180))
        .max_by_key(|meta| (meta.file_time_key, meta.started_at, meta.mtime))
        .map(|meta| meta.session_id.clone());

    if near_now.is_some() {
        return Ok(near_now);
    }

    Ok(metas
        .iter()
        .max_by_key(|meta| (meta.file_time_key, meta.started_at, meta.mtime))
        .map(|meta| meta.session_id.clone()))
}

fn load_codex_import_cursor(
    connection: &Connection,
    pane_id: &str,
    file_path: &str,
) -> Result<(i64, i64)> {
    let row = connection
        .query_row(
            "SELECT last_line, last_mtime FROM codex_import_state WHERE pane_id = ?1 AND file_path = ?2",
            params![pane_id, file_path],
            |record| Ok((record.get::<usize, i64>(0)?, record.get::<usize, i64>(1)?)),
        )
        .optional()?;
    Ok(row.unwrap_or((0, 0)))
}

fn save_codex_import_cursor(
    connection: &Connection,
    pane_id: &str,
    file_path: &str,
    last_line: i64,
    last_mtime: i64,
) -> Result<()> {
    connection.execute(
        r#"
        INSERT INTO codex_import_state (pane_id, file_path, last_line, last_mtime, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5)
        ON CONFLICT(pane_id, file_path)
        DO UPDATE SET
          last_line = excluded.last_line,
          last_mtime = excluded.last_mtime,
          updated_at = excluded.updated_at
        "#,
        params![pane_id, file_path, last_line, last_mtime, now_epoch()],
    )?;
    Ok(())
}

fn import_codex_native_history_db(
    path: &Path,
    pane_id: &str,
    sessions_dir: &Path,
    requested_session_id: Option<String>,
) -> Result<NativeImportResult> {
    let mut metas = collect_rollout_metas(sessions_dir)?;
    metas.sort_by_key(|meta| (meta.file_time_key, meta.started_at, meta.mtime));

    let mut connection = open_db(path)?;
    let tx = connection.transaction()?;
    let target_session_id = resolve_codex_session_id(&tx, pane_id, requested_session_id, &metas)
        .ok_or_else(|| anyhow!("unable to resolve codex session id"))?;
    save_bound_session_id(&tx, pane_id, &target_session_id)?;

    let filtered_metas = metas
        .into_iter()
        .filter(|meta| meta.session_id == target_session_id)
        .collect::<Vec<_>>();

    let mut result = NativeImportResult {
        provider: "codex".to_string(),
        pane_id: pane_id.to_string(),
        session_id: target_session_id.clone(),
        source_dir: sessions_dir.to_string_lossy().to_string(),
        imported: 0,
        skipped: 0,
        scanned_files: filtered_metas.len() as i64,
        scanned_lines: 0,
        parse_errors: 0,
    };

    for meta in filtered_metas {
        let file_path_string = meta.file_path.to_string_lossy().to_string();
        let cursor_key = format!("{}::{}", target_session_id, file_path_string);
        let mtime = meta.mtime;
        if should_wait_for_file_settle(mtime) {
            result.skipped += 1;
            continue;
        }
        let (last_line, last_mtime) = load_codex_import_cursor(&tx, pane_id, &cursor_key)?;
        let skip_until = if mtime >= last_mtime {
            last_line.max(0)
        } else {
            0
        };

        let file = File::open(&meta.file_path)
            .with_context(|| format!("failed to open rollout file {}", file_path_string))?;
        let reader = BufReader::new(file);

        let mut line_no = 0_i64;
        for line_result in reader.lines() {
            line_no += 1;
            if line_no <= skip_until {
                continue;
            }
            result.scanned_lines += 1;

            let line = match line_result {
                Ok(value) => value,
                Err(_) => {
                    result.parse_errors += 1;
                    continue;
                }
            };
            if line.trim().is_empty() {
                continue;
            }

            let value = match serde_json::from_str::<serde_json::Value>(&line) {
                Ok(value) => value,
                Err(_) => {
                    result.parse_errors += 1;
                    continue;
                }
            };

            if value.get("type").and_then(|item| item.as_str()) != Some("response_item") {
                continue;
            }

            let payload = match value.get("payload").and_then(|item| item.as_object()) {
                Some(payload) => payload,
                None => continue,
            };
            if payload.get("type").and_then(|item| item.as_str()) != Some("message") {
                continue;
            }

            let role = match payload.get("role").and_then(|item| item.as_str()) {
                Some(role) if role == "user" || role == "assistant" => role,
                _ => continue,
            };
            let (kind, content_type) = if role == "user" {
                ("input", "input_text")
            } else {
                ("output", "output_text")
            };

            let created_at = value
                .get("timestamp")
                .and_then(|item| item.as_str())
                .and_then(parse_rfc3339_epoch_seconds)
                .unwrap_or_else(now_epoch);

            let content_list = match payload.get("content").and_then(|item| item.as_array()) {
                Some(content) => content,
                None => continue,
            };

            for (content_index, content_item) in content_list.iter().enumerate() {
                if content_item.get("type").and_then(|item| item.as_str()) != Some(content_type) {
                    continue;
                }
                let text = content_item
                    .get("text")
                    .and_then(|item| item.as_str())
                    .unwrap_or("");
                let sanitized = sanitize_log_text(text);
                if sanitized.trim().is_empty() {
                    continue;
                }

                let external_key = format!(
                    "codex:{}:{}:{}:{}",
                    file_path_string, line_no, role, content_index
                );
                let inserted_rows = tx.execute(
                    r#"
                    INSERT OR IGNORE INTO entries
                      (id, pane_id, kind, content, synced_from, created_at, external_key)
                    VALUES
                      (?1, ?2, ?3, ?4, NULL, ?5, ?6)
                    "#,
                    params![
                        Uuid::new_v4().to_string(),
                        pane_id,
                        kind,
                        sanitized,
                        created_at,
                        external_key
                    ],
                )?;

                if inserted_rows > 0 {
                    result.imported += 1;
                } else {
                    result.skipped += 1;
                }
            }
        }

        save_codex_import_cursor(&tx, pane_id, &cursor_key, line_no, mtime)?;
    }

    if result.imported > 0 {
        tx.execute(
            "UPDATE panes SET updated_at = ?2 WHERE id = ?1",
            params![pane_id, now_epoch()],
        )?;
    }

    tx.commit()?;
    Ok(result)
}

fn text_from_json_value(value: &serde_json::Value) -> String {
    let mut pieces = Vec::new();
    collect_text_from_json(value, &mut pieces);
    if pieces.is_empty() {
        return String::new();
    }
    let mut seen = HashSet::new();
    let mut deduped = Vec::new();
    for piece in pieces {
        let normalized = piece.trim();
        if normalized.is_empty() {
            continue;
        }
        if seen.insert(normalized.to_string()) {
            deduped.push(normalized.to_string());
        }
    }
    sanitize_log_text(&deduped.join("\n"))
}

fn import_claude_native_history_db(
    path: &Path,
    pane_id: &str,
    projects_dir: &Path,
    requested_session_id: Option<String>,
) -> Result<NativeImportResult> {
    let mut metas = collect_claude_metas(projects_dir)?;
    metas.sort_by_key(|meta| (meta.file_time_key, meta.started_at, meta.mtime));

    let mut connection = open_db(path)?;
    let tx = connection.transaction()?;
    let target_session_id = if let Some(session_id) = normalize_session_id(requested_session_id) {
        session_id
    } else {
        metas
            .iter()
            .max_by_key(|meta| (meta.file_time_key, meta.started_at, meta.mtime))
            .map(|meta| meta.session_id.clone())
            .ok_or_else(|| anyhow!("unable to resolve claude session id"))?
    };
    save_bound_session_id(&tx, pane_id, &target_session_id)?;

    let filtered_metas = metas
        .into_iter()
        .filter(|meta| meta.session_id == target_session_id)
        .collect::<Vec<_>>();

    let mut result = NativeImportResult {
        provider: "claude".to_string(),
        pane_id: pane_id.to_string(),
        session_id: target_session_id.clone(),
        source_dir: projects_dir.to_string_lossy().to_string(),
        imported: 0,
        skipped: 0,
        scanned_files: filtered_metas.len() as i64,
        scanned_lines: 0,
        parse_errors: 0,
    };

    for meta in filtered_metas {
        let file_path_string = meta.file_path.to_string_lossy().to_string();
        let cursor_key = format!("claude::{}::{}", target_session_id, file_path_string);
        let mtime = meta.mtime;
        if should_wait_for_file_settle(mtime) {
            result.skipped += 1;
            continue;
        }
        let (last_line, last_mtime) = load_codex_import_cursor(&tx, pane_id, &cursor_key)?;
        let skip_until = if mtime >= last_mtime {
            last_line.max(0)
        } else {
            0
        };

        let file = File::open(&meta.file_path)
            .with_context(|| format!("failed to open claude session file {}", file_path_string))?;
        let reader = BufReader::new(file);

        let mut line_no = 0_i64;
        for line_result in reader.lines() {
            line_no += 1;
            if line_no <= skip_until {
                continue;
            }
            result.scanned_lines += 1;

            let line = match line_result {
                Ok(value) => value,
                Err(_) => {
                    result.parse_errors += 1;
                    continue;
                }
            };
            if line.trim().is_empty() {
                continue;
            }

            let value = match serde_json::from_str::<serde_json::Value>(&line) {
                Ok(value) => value,
                Err(_) => {
                    result.parse_errors += 1;
                    continue;
                }
            };

            let row_session_id = value
                .get("sessionId")
                .and_then(|item| item.as_str())
                .map(|item| item.trim().to_string())
                .unwrap_or_default();
            if row_session_id != target_session_id {
                continue;
            }

            if value
                .get("isSidechain")
                .and_then(|item| item.as_bool())
                .unwrap_or(false)
            {
                continue;
            }

            if value
                .get("isMeta")
                .and_then(|item| item.as_bool())
                .unwrap_or(false)
            {
                continue;
            }

            let row_type = match value.get("type").and_then(|item| item.as_str()) {
                Some(kind @ ("user" | "assistant")) => kind,
                _ => continue,
            };
            let kind = if row_type == "user" { "input" } else { "output" };

            let content_value = value
                .get("message")
                .and_then(|item| item.get("content"))
                .or_else(|| value.get("content"))
                .unwrap_or(&serde_json::Value::Null);
            let sanitized = text_from_json_value(content_value);
            if sanitized.trim().is_empty() {
                continue;
            }

            let created_at = value
                .get("timestamp")
                .and_then(|item| item.as_str())
                .and_then(parse_rfc3339_epoch_seconds)
                .unwrap_or_else(now_epoch);
            let external_key = format!("claude:{}:{}:{}", file_path_string, line_no, row_type);

            let inserted_rows = tx.execute(
                r#"
                INSERT OR IGNORE INTO entries
                  (id, pane_id, kind, content, synced_from, created_at, external_key)
                VALUES
                  (?1, ?2, ?3, ?4, NULL, ?5, ?6)
                "#,
                params![
                    Uuid::new_v4().to_string(),
                    pane_id,
                    kind,
                    sanitized,
                    created_at,
                    external_key
                ],
            )?;

            if inserted_rows > 0 {
                result.imported += 1;
            } else {
                result.skipped += 1;
            }
        }

        save_codex_import_cursor(&tx, pane_id, &cursor_key, line_no, mtime)?;
    }

    if result.imported > 0 {
        tx.execute(
            "UPDATE panes SET updated_at = ?2 WHERE id = ?1",
            params![pane_id, now_epoch()],
        )?;
    }

    tx.commit()?;
    Ok(result)
}

fn import_gemini_native_history_db(
    path: &Path,
    pane_id: &str,
    sessions_root: &Path,
    requested_session_id: Option<String>,
) -> Result<NativeImportResult> {
    let mut metas = collect_gemini_metas(sessions_root)?;
    metas.sort_by_key(|meta| (meta.file_time_key, meta.started_at, meta.mtime));

    let mut connection = open_db(path)?;
    let tx = connection.transaction()?;
    let target_session_id = if let Some(session_id) = normalize_session_id(requested_session_id) {
        session_id
    } else {
        metas
            .iter()
            .max_by_key(|meta| (meta.file_time_key, meta.started_at, meta.mtime))
            .map(|meta| meta.session_id.clone())
            .ok_or_else(|| anyhow!("unable to resolve gemini session id"))?
    };
    save_bound_session_id(&tx, pane_id, &target_session_id)?;

    let filtered_metas = metas
        .into_iter()
        .filter(|meta| meta.session_id == target_session_id)
        .collect::<Vec<_>>();

    let mut result = NativeImportResult {
        provider: "gemini".to_string(),
        pane_id: pane_id.to_string(),
        session_id: target_session_id.clone(),
        source_dir: sessions_root.to_string_lossy().to_string(),
        imported: 0,
        skipped: 0,
        scanned_files: filtered_metas.len() as i64,
        scanned_lines: 0,
        parse_errors: 0,
    };

    for meta in filtered_metas {
        let file_path_string = meta.file_path.to_string_lossy().to_string();
        let cursor_key = format!("gemini::{}::{}", target_session_id, file_path_string);
        let mtime = meta.mtime;
        if should_wait_for_file_settle(mtime) {
            result.skipped += 1;
            continue;
        }
        let (last_line, last_mtime) = load_codex_import_cursor(&tx, pane_id, &cursor_key)?;
        if last_line > 0 && mtime <= last_mtime {
            continue;
        }

        let raw = match std::fs::read_to_string(&meta.file_path) {
            Ok(content) => content,
            Err(_) => {
                result.parse_errors += 1;
                continue;
            }
        };
        let value = match serde_json::from_str::<serde_json::Value>(&raw) {
            Ok(value) => value,
            Err(_) => {
                result.parse_errors += 1;
                save_codex_import_cursor(&tx, pane_id, &cursor_key, 1, mtime)?;
                continue;
            }
        };

        let row_session_id = value
            .get("sessionId")
            .and_then(|item| item.as_str())
            .map(|item| item.trim().to_string())
            .unwrap_or_default();
        if row_session_id != target_session_id {
            save_codex_import_cursor(&tx, pane_id, &cursor_key, 1, mtime)?;
            continue;
        }

        let fallback_ts = value
            .get("lastUpdated")
            .and_then(|item| item.as_str())
            .and_then(parse_rfc3339_epoch_seconds)
            .or_else(|| {
                value
                    .get("startTime")
                    .and_then(|item| item.as_str())
                    .and_then(parse_rfc3339_epoch_seconds)
            })
            .unwrap_or_else(now_epoch);

        let messages = match value.get("messages").and_then(|item| item.as_array()) {
            Some(items) => items,
            None => {
                result.parse_errors += 1;
                save_codex_import_cursor(&tx, pane_id, &cursor_key, 1, mtime)?;
                continue;
            }
        };

        for (index, message) in messages.iter().enumerate() {
            result.scanned_lines += 1;
            let row_type = match message.get("type").and_then(|item| item.as_str()) {
                Some("user") => "user",
                Some("gemini") => "gemini",
                Some("assistant") => "assistant",
                _ => continue,
            };
            let kind = if row_type == "user" { "input" } else { "output" };
            let content_value = message.get("content").unwrap_or(&serde_json::Value::Null);
            let sanitized = text_from_json_value(content_value);
            if sanitized.trim().is_empty() {
                continue;
            }

            let created_at = message
                .get("timestamp")
                .and_then(|item| item.as_str())
                .and_then(parse_rfc3339_epoch_seconds)
                .unwrap_or(fallback_ts);
            let external_key = format!("gemini:{}:{}:{}", file_path_string, index, row_type);

            let inserted_rows = tx.execute(
                r#"
                INSERT OR IGNORE INTO entries
                  (id, pane_id, kind, content, synced_from, created_at, external_key)
                VALUES
                  (?1, ?2, ?3, ?4, NULL, ?5, ?6)
                "#,
                params![
                    Uuid::new_v4().to_string(),
                    pane_id,
                    kind,
                    sanitized,
                    created_at,
                    external_key
                ],
            )?;

            if inserted_rows > 0 {
                result.imported += 1;
            } else {
                result.skipped += 1;
            }
        }

        save_codex_import_cursor(&tx, pane_id, &cursor_key, 1, mtime)?;
    }

    if result.imported > 0 {
        tx.execute(
            "UPDATE panes SET updated_at = ?2 WHERE id = ?1",
            params![pane_id, now_epoch()],
        )?;
    }

    tx.commit()?;
    Ok(result)
}

fn build_sync_payload(path: &Path, entry_ids: &[String]) -> Result<(String, Option<String>)> {
    if entry_ids.is_empty() {
        return Err(anyhow!("no entries selected"));
    }

    #[derive(Debug)]
    struct SyncRow {
        id: String,
        kind: String,
        content: String,
        created_at: i64,
    }

    fn kind_order(kind: &str) -> i32 {
        match kind {
            "input" => 0,
            "output" => 1,
            _ => 2,
        }
    }

    let connection = open_db(path)?;
    let placeholders = vec!["?"; entry_ids.len()].join(",");
    let sql = format!(
        "SELECT id, kind, content, created_at FROM entries WHERE id IN ({})",
        placeholders
    );

    let mut stmt = connection.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(entry_ids.iter()), |row| {
        Ok(SyncRow {
            id: row.get::<usize, String>(0)?,
            kind: row.get::<usize, String>(1)?,
            content: row.get::<usize, String>(2)?,
            created_at: row.get::<usize, i64>(3)?,
        })
    })?;

    let mut selected = Vec::new();
    for row in rows {
        selected.push(row?);
    }

    selected.sort_by(|a, b| {
        a.created_at
            .cmp(&b.created_at)
            .then(kind_order(&a.kind).cmp(&kind_order(&b.kind)))
            .then(a.id.cmp(&b.id))
    });

    if selected.is_empty() {
        return Err(anyhow!("selected entries are missing"));
    }

    let first_id = selected.first().map(|row| row.id.clone());
    let contents = selected
        .into_iter()
        .map(|row| row.content)
        .collect::<Vec<_>>();

    Ok((contents.join("\n\n"), first_id))
}

fn start_runtime(app: &AppHandle, state: &AppState, pane_id: String, _provider: String) -> Result<()> {
    {
        let runtimes = state
            .panes
            .lock()
            .map_err(|_| anyhow!("failed to lock pane runtime map"))?;
        if runtimes.contains_key(&pane_id) {
            return Ok(());
        }
    }

    let pty = native_pty_system();
    let pair = pty.openpty(PtySize {
        rows: 42,
        cols: 140,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    let working_directory = state
        .working_directory
        .lock()
        .map_err(|_| anyhow!("failed to lock working directory"))?
        .clone();
    let command = shell_command_builder(working_directory.as_deref());
    let child = pair.slave.spawn_command(command)?;

    let master = pair.master;
    let writer = master.take_writer()?;
    let mut reader = master.try_clone_reader()?;

    let runtime = PaneRuntime {
        writer: Arc::new(Mutex::new(writer)),
        master: Arc::new(Mutex::new(master)),
        child: Arc::new(Mutex::new(child)),
    };

    let pane_id_for_thread = pane_id.clone();
    let app_for_thread = app.clone();
    std::thread::spawn(move || {
        let mut buffer = [0_u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => {
                    let data = String::from_utf8_lossy(&buffer[..size]).to_string();
                    let _ = app_for_thread.emit(
                        "terminal-output",
                        TerminalOutputEvent {
                            pane_id: pane_id_for_thread.clone(),
                            data,
                        },
                    );
                }
                Err(_) => break,
            }
        }
        let _ = app_for_thread.emit(
            "terminal-exit",
            TerminalExitEvent {
                pane_id: pane_id_for_thread,
            },
        );
    });

    {
        let mut runtimes = state
            .panes
            .lock()
            .map_err(|_| anyhow!("failed to lock pane runtime map"))?;
        runtimes.insert(pane_id.clone(), runtime.clone());
    }
    {
        let mut starts = state
            .pane_runtime_starts
            .lock()
            .map_err(|_| anyhow!("failed to lock pane runtime start map"))?;
        starts.insert(pane_id.clone(), now_epoch());
    }

    Ok(())
}

fn normalize_working_directory(path: Option<String>) -> Result<Option<PathBuf>> {
    let Some(raw) = path else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let mut resolved = PathBuf::from(trimmed);
    if resolved.is_relative() {
        let current = std::env::current_dir().context("failed to resolve current dir")?;
        resolved = current.join(resolved);
    }
    if !resolved.exists() {
        return Err(anyhow!(
            "working directory does not exist: {}",
            resolved.to_string_lossy()
        ));
    }
    if !resolved.is_dir() {
        return Err(anyhow!(
            "working directory is not a directory: {}",
            resolved.to_string_lossy()
        ));
    }
    Ok(Some(resolved))
}

fn restart_open_pane_runtimes(app: &AppHandle, state: &AppState) -> Result<()> {
    let pane_ids = {
        let runtimes = state
            .panes
            .lock()
            .map_err(|_| anyhow!("failed to lock pane runtime map"))?;
        runtimes.keys().cloned().collect::<Vec<_>>()
    };

    for pane_id in pane_ids {
        let provider = load_provider(&state.db_path, &pane_id)?;
        stop_pane_runtime(state, &pane_id)?;
        start_runtime(app, state, pane_id, provider)?;
    }
    Ok(())
}

fn write_to_pane_internal(
    state: &AppState,
    pane_id: &str,
    input: &str,
    ensure_newline: bool,
) -> Result<()> {
    let runtime = {
        let runtimes = state
            .panes
            .lock()
            .map_err(|_| anyhow!("failed to lock pane runtime map"))?;
        runtimes
            .get(pane_id)
            .cloned()
            .ok_or_else(|| anyhow!("pane runtime not found: {}", pane_id))?
    };

    let mut payload = input.to_string();
    if ensure_newline && !payload.ends_with('\n') {
        payload.push('\n');
    }

    let mut writer = runtime
        .writer
        .lock()
        .map_err(|_| anyhow!("failed to lock pane writer"))?;
    writer.write_all(payload.as_bytes())?;
    writer.flush()?;
    Ok(())
}

fn paste_to_pane_internal(
    state: &AppState,
    pane_id: &str,
    input: &str,
    submit: bool,
) -> Result<()> {
    let runtime = {
        let runtimes = state
            .panes
            .lock()
            .map_err(|_| anyhow!("failed to lock pane runtime map"))?;
        runtimes
            .get(pane_id)
            .cloned()
            .ok_or_else(|| anyhow!("pane runtime not found: {}", pane_id))?
    };

    // Use bracketed paste so multi-line payload is inserted as one block
    // instead of being interpreted as many Enter key presses.
    let normalized = input.replace("\r\n", "\n").replace('\r', "\n");
    let mut payload = String::new();
    payload.push_str("\u{1b}[200~");
    payload.push_str(&normalized);
    payload.push_str("\u{1b}[201~");
    if submit {
        payload.push('\n');
    }

    let mut writer = runtime
        .writer
        .lock()
        .map_err(|_| anyhow!("failed to lock pane writer"))?;
    writer.write_all(payload.as_bytes())?;
    writer.flush()?;
    Ok(())
}

fn stop_pane_runtime(state: &AppState, pane_id: &str) -> Result<()> {
    {
        let mut starts = state
            .pane_runtime_starts
            .lock()
            .map_err(|_| anyhow!("failed to lock pane runtime start map"))?;
        starts.remove(pane_id);
    }

    let runtime = {
        let mut runtimes = state
            .panes
            .lock()
            .map_err(|_| anyhow!("failed to lock pane runtime map"))?;
        runtimes.remove(pane_id)
    };

    if let Some(runtime) = runtime {
        let mut child = runtime
            .child
            .lock()
            .map_err(|_| anyhow!("failed to lock pane process"))?;
        child.kill()?;
    }
    Ok(())
}

fn stop_all_pane_runtimes(state: &AppState) -> Result<()> {
    {
        let mut starts = state
            .pane_runtime_starts
            .lock()
            .map_err(|_| anyhow!("failed to lock pane runtime start map"))?;
        starts.clear();
    }

    let runtimes = {
        let mut map = state
            .panes
            .lock()
            .map_err(|_| anyhow!("failed to lock pane runtime map"))?;
        std::mem::take(&mut *map)
    };

    for (_, runtime) in runtimes {
        if let Ok(mut child) = runtime.child.lock() {
            let _ = child.kill();
        }
    }
    Ok(())
}

fn collect_text_from_json(value: &serde_json::Value, bucket: &mut Vec<String>) {
    match value {
        serde_json::Value::String(text) => {
            let normalized = text.trim();
            if !normalized.is_empty() {
                bucket.push(normalized.to_string());
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                collect_text_from_json(item, bucket);
            }
        }
        serde_json::Value::Object(map) => {
            // Prioritize common LLM output keys first.
            let preferred = [
                "output_text",
                "text",
                "completion",
                "result",
                "response",
                "message",
                "delta",
                "content",
            ];
            for key in preferred {
                if let Some(value) = map.get(key) {
                    collect_text_from_json(value, bucket);
                }
            }
        }
        _ => {}
    }
}

fn structured_text_from_output(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let mut pieces = Vec::new();

    if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
        collect_text_from_json(&value, &mut pieces);
    } else {
        for line in trimmed.lines() {
            let row = line.trim();
            if row.is_empty() {
                continue;
            }
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(row) {
                collect_text_from_json(&value, &mut pieces);
            }
        }
    }

    if pieces.is_empty() {
        return sanitize_log_text(trimmed);
    }

    let mut seen = HashSet::new();
    let mut deduped = Vec::new();
    for item in pieces {
        if seen.insert(item.clone()) {
            deduped.push(item);
        }
    }
    sanitize_log_text(&deduped.join("\n"))
}

fn execute_provider_prompt(
    adapter_config_dir: &Path,
    provider: &str,
    prompt: &str,
) -> Result<(String, String), String> {
    let bridge = resolve_chat_bridge(adapter_config_dir, provider)?;
    let command = bridge.command().to_string();
    let history = Vec::<BridgeMessage>::new();
    let candidates = bridge.send(prompt, &history);
    if candidates.is_empty() {
        return Err(format!("unsupported provider: {}", provider));
    }

    let mut errors = Vec::new();
    for candidate in candidates {
        let mode = candidate.mode.clone();
        let args = candidate.args;
        let refs = args.iter().map(|value| value.as_str()).collect::<Vec<_>>();
        match shell_exec_provider(&command, &refs) {
            Ok(output) => {
                let raw = output_text(&output);
                if !output.status.success() {
                    let detail = if raw.trim().is_empty() {
                        format!("{} failed with status {:?}", mode, output.status.code())
                    } else {
                        format!("{} failed: {}", mode, raw)
                    };
                    errors.push(detail);
                    continue;
                }

                let parsed = bridge.stream_receive(&raw);
                if parsed.trim().is_empty() {
                    errors.push(format!("{} produced empty output", mode));
                    continue;
                }
                return Ok((mode, parsed));
            }
            Err(error) => errors.push(format!("{} error: {}", mode, error)),
        }
    }

    Err(errors.join("\n"))
}

#[cfg(target_os = "windows")]
fn ps_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(not(target_os = "windows"))]
fn sh_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn shell_exec_provider(command: &str, args: &[&str]) -> Result<std::process::Output, String> {
    #[cfg(target_os = "windows")]
    {
        let args_joined = if args.is_empty() {
            String::new()
        } else {
            format!(
                " {}",
                args.iter()
                    .map(|value| ps_quote(value))
                    .collect::<Vec<_>>()
                    .join(" ")
            )
        };
        let script = format!(
            "if (Test-Path $PROFILE) {{ . $PROFILE }}; $ErrorActionPreference='SilentlyContinue'; if (-not (Get-Command {})) {{ exit 127 }}; & {}{}",
            ps_quote(command),
            ps_quote(command),
            args_joined
        );
        return Command::new("powershell")
            .arg("-NoLogo")
            .arg("-Command")
            .arg(script)
            .output()
            .map_err(|error| error.to_string());
    }

    #[cfg(not(target_os = "windows"))]
    {
        let args_joined = args
            .iter()
            .map(|value| sh_quote(value))
            .collect::<Vec<_>>()
            .join(" ");
        let script = if args_joined.is_empty() {
            format!(
                "if ! command -v {} >/dev/null 2>&1; then exit 127; fi; {}",
                sh_quote(command),
                sh_quote(command)
            )
        } else {
            format!(
                "if ! command -v {} >/dev/null 2>&1; then exit 127; fi; {} {}",
                sh_quote(command),
                sh_quote(command),
                args_joined
            )
        };
        Command::new("bash")
            .arg("-lc")
            .arg(script)
            .output()
            .map_err(|error| error.to_string())
    }
}

fn output_text(output: &std::process::Output) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stdout.is_empty() {
        stderr
    } else if stderr.is_empty() {
        stdout
    } else {
        format!("{}\n{}", stdout, stderr)
    }
}

#[tauri::command]
fn list_panes(state: State<AppState>) -> Result<Vec<PaneSummary>, String> {
    list_panes_db(&state.db_path).map_err(|error| error.to_string())
}

#[tauri::command]
fn list_entries(
    state: State<AppState>,
    pane_id: String,
    query: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<EntryRecord>, String> {
    list_entries_db(&state.db_path, &pane_id, query, limit, offset).map_err(|error| error.to_string())
}

#[tauri::command]
fn count_entries(
    state: State<AppState>,
    pane_id: String,
    query: Option<String>,
) -> Result<i64, String> {
    count_entries_db(&state.db_path, &pane_id, query).map_err(|error| error.to_string())
}

#[tauri::command]
fn create_pane(
    app: AppHandle,
    state: State<AppState>,
    provider: String,
    title: Option<String>,
) -> Result<PaneSummary, String> {
    let now = now_epoch();
    let pane = PaneSummary {
        id: Uuid::new_v4().to_string(),
        provider: provider.clone(),
        title: title.unwrap_or_else(|| provider.to_uppercase()),
        created_at: now,
        updated_at: now,
    };

    insert_pane(&state.db_path, &pane).map_err(|error| error.to_string())?;
    start_runtime(&app, &state, pane.id.clone(), provider).map_err(|error| error.to_string())?;
    Ok(pane)
}

#[tauri::command]
fn ensure_pane_runtime(
    app: AppHandle,
    state: State<AppState>,
    pane_id: String,
) -> Result<bool, String> {
    {
        let runtimes = state
            .panes
            .lock()
            .map_err(|_| "failed to lock pane runtime map".to_string())?;
        if runtimes.contains_key(&pane_id) {
            return Ok(true);
        }
    }

    let provider = load_provider(&state.db_path, &pane_id).map_err(|error| error.to_string())?;
    start_runtime(&app, &state, pane_id, provider).map_err(|error| error.to_string())?;
    Ok(true)
}

#[tauri::command]
fn send_to_pane(state: State<AppState>, pane_id: String, input: String) -> Result<(), String> {
    paste_to_pane_internal(&state, &pane_id, &input, true).map_err(|error| error.to_string())
}

#[tauri::command]
fn write_to_pane(state: State<AppState>, pane_id: String, data: String) -> Result<(), String> {
    write_to_pane_internal(&state, &pane_id, &data, false).map_err(|error| error.to_string())
}

#[tauri::command]
fn resize_pane(
    state: State<AppState>,
    pane_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let runtime = {
        let runtimes = state
            .panes
            .lock()
            .map_err(|_| "failed to lock pane runtime map".to_string())?;
        runtimes
            .get(&pane_id)
            .cloned()
            .ok_or_else(|| format!("pane runtime not found: {}", pane_id))?
    };

    let master = runtime
        .master
        .lock()
        .map_err(|_| "failed to lock pane pty".to_string())?;
    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn append_entry(
    state: State<AppState>,
    pane_id: String,
    kind: String,
    content: String,
    synced_from: Option<String>,
) -> Result<EntryRecord, String> {
    let entry = add_entry(
        &state.db_path,
        &pane_id,
        &kind,
        &content,
        synced_from.as_deref(),
    )
    .map_err(|error| error.to_string())?;
    log_entry_event(&state, &entry, "append_entry", None);
    Ok(entry)
}

#[tauri::command]
fn sync_entries(
    state: State<AppState>,
    entry_ids: Vec<String>,
    target_pane_id: String,
) -> Result<EntryRecord, String> {
    let (payload, source_id) =
        build_sync_payload(&state.db_path, &entry_ids).map_err(|error| error.to_string())?;
    paste_to_pane_internal(&state, &target_pane_id, &payload, true)
        .map_err(|error| error.to_string())?;
    let entry = add_entry(
        &state.db_path,
        &target_pane_id,
        "input",
        &payload,
        source_id.as_deref(),
    )
    .map_err(|error| error.to_string())?;
    log_entry_event(&state, &entry, "sync_entries", Some("sync-to-input"));
    Ok(entry)
}

#[tauri::command]
fn run_provider_prompt(
    state: State<AppState>,
    pane_id: String,
    prompt: String,
) -> Result<ProviderPromptResponse, String> {
    let input = prompt.trim();
    if input.is_empty() {
        return Err("prompt is empty".to_string());
    }

    let provider = load_provider(&state.db_path, &pane_id).map_err(|error| error.to_string())?;
    let input_entry = add_entry(&state.db_path, &pane_id, "input", input, None)
        .map_err(|error| error.to_string())?;
    log_entry_event(&state, &input_entry, "run_provider_prompt", Some("input"));

    match execute_provider_prompt(&state.adapter_config_dir, &provider, input) {
        Ok((mode, output)) => {
            let output_entry = add_entry(&state.db_path, &pane_id, "output", &output, None)
                .map_err(|error| error.to_string())?;
            log_entry_event(&state, &output_entry, "run_provider_prompt", Some(&mode));
            Ok(ProviderPromptResponse {
                input: input_entry,
                output: output_entry,
                mode,
            })
        }
        Err(error) => {
            let message = format!("[provider-error]\n{}", error);
            let output_entry = add_entry(&state.db_path, &pane_id, "output", &message, None)
                .map_err(|inner| inner.to_string())?;
            log_entry_event(&state, &output_entry, "run_provider_prompt", Some("error"));
            Ok(ProviderPromptResponse {
                input: input_entry,
                output: output_entry,
                mode: "error".to_string(),
            })
        }
    }
}

#[tauri::command]
fn run_team_prompt(
    state: State<AppState>,
    pane_id: String,
    executor_provider: String,
    prompt: String,
) -> Result<ProviderPromptResponse, String> {
    let input = prompt.trim();
    if input.is_empty() {
        return Err("prompt is empty".to_string());
    }

    let executor = executor_provider.trim().to_lowercase();
    if executor.is_empty() {
        return Err("executor provider is empty".to_string());
    }

    // Ensure the source pane exists.
    let _ = load_provider(&state.db_path, &pane_id).map_err(|error| error.to_string())?;

    let input_entry = add_entry(&state.db_path, &pane_id, "input", input, None)
        .map_err(|error| error.to_string())?;
    log_entry_event(
        &state,
        &input_entry,
        "run_team_prompt",
        Some(&format!("input->{}", executor)),
    );

    match execute_provider_prompt(&state.adapter_config_dir, &executor, input) {
        Ok((mode, output)) => {
            let output_entry = add_entry(&state.db_path, &pane_id, "output", &output, None)
                .map_err(|error| error.to_string())?;
            let team_mode = format!("team:{}:{}", executor, mode);
            log_entry_event(&state, &output_entry, "run_team_prompt", Some(&team_mode));
            Ok(ProviderPromptResponse {
                input: input_entry,
                output: output_entry,
                mode: team_mode,
            })
        }
        Err(error) => {
            let message = format!("[provider-error:{}]\n{}", executor, error);
            let output_entry = add_entry(&state.db_path, &pane_id, "output", &message, None)
                .map_err(|inner| inner.to_string())?;
            log_entry_event(
                &state,
                &output_entry,
                "run_team_prompt",
                Some(&format!("team:{}:error", executor)),
            );
            Ok(ProviderPromptResponse {
                input: input_entry,
                output: output_entry,
                mode: format!("team:{}:error", executor),
            })
        }
    }
}

fn suggest_native_session_id_inner(
    state: &AppState,
    pane_id: &str,
    provider: &str,
    runtime_start: Option<i64>,
) -> Result<Option<String>, String> {
    match provider {
        "codex" => {
            let sessions_dir = codex_sessions_dir()
                .ok_or_else(|| "failed to resolve CODEX_HOME sessions directory".to_string())?;
            if !sessions_dir.exists() {
                return Ok(None);
            }
            suggest_codex_session_id_db(&state.db_path, pane_id, &sessions_dir, runtime_start)
                .map_err(|error| error.to_string())
        }
        "claude" => {
            let projects_dir = claude_projects_dir()
                .ok_or_else(|| "failed to resolve CLAUDE_HOME projects directory".to_string())?;
            if !projects_dir.exists() {
                return Ok(None);
            }
            suggest_claude_session_id_db(&state.db_path, pane_id, &projects_dir, runtime_start)
                .map_err(|error| error.to_string())
        }
        "gemini" => {
            let sessions_root = gemini_sessions_root_dir()
                .ok_or_else(|| "failed to resolve GEMINI_HOME tmp directory".to_string())?;
            if !sessions_root.exists() {
                return Ok(None);
            }
            suggest_gemini_session_id_db(&state.db_path, pane_id, &sessions_root, runtime_start)
                .map_err(|error| error.to_string())
        }
        _ => Ok(None),
    }
}

fn import_native_history_inner(
    state: &AppState,
    pane_id: &str,
    provider: &str,
    session_id: Option<String>,
    runtime_start: Option<i64>,
) -> Result<NativeImportResult, String> {
    let requested = if normalize_session_id(session_id.clone()).is_some() {
        session_id
    } else {
        suggest_native_session_id_inner(state, pane_id, provider, runtime_start)?
    };

    if requested.is_none() {
        return Err(format!(
            "current {} session not detected yet; send first message then retry import",
            provider
        ));
    }

    let result = match provider {
        "codex" => {
            let sessions_dir = codex_sessions_dir()
                .ok_or_else(|| "failed to resolve CODEX_HOME sessions directory".to_string())?;
            if !sessions_dir.exists() {
                return Err(format!(
                    "codex sessions directory not found: {}",
                    sessions_dir.to_string_lossy()
                ));
            }
            import_codex_native_history_db(&state.db_path, pane_id, &sessions_dir, requested)
                .map_err(|error| error.to_string())?
        }
        "claude" => {
            let projects_dir = claude_projects_dir()
                .ok_or_else(|| "failed to resolve CLAUDE_HOME projects directory".to_string())?;
            if !projects_dir.exists() {
                return Err(format!(
                    "claude projects directory not found: {}",
                    projects_dir.to_string_lossy()
                ));
            }
            import_claude_native_history_db(&state.db_path, pane_id, &projects_dir, requested)
                .map_err(|error| error.to_string())?
        }
        "gemini" => {
            let sessions_root = gemini_sessions_root_dir()
                .ok_or_else(|| "failed to resolve GEMINI_HOME tmp directory".to_string())?;
            if !sessions_root.exists() {
                return Err(format!(
                    "gemini session root directory not found: {}",
                    sessions_root.to_string_lossy()
                ));
            }
            import_gemini_native_history_db(&state.db_path, pane_id, &sessions_root, requested)
                .map_err(|error| error.to_string())?
        }
        _ => return Err(format!("native history import is unsupported for provider {}", provider)),
    };

    let payload = serde_json::json!({
        "ts": now_epoch(),
        "event": format!("{}.native_import", provider),
        "provider": provider,
        "pane_id": result.pane_id,
        "session_id": result.session_id,
        "source_dir": result.source_dir,
        "imported": result.imported,
        "skipped": result.skipped,
        "scanned_files": result.scanned_files,
        "scanned_lines": result.scanned_lines,
        "parse_errors": result.parse_errors
    });
    let _ = write_observable_event(state, payload);

    Ok(result)
}

#[tauri::command]
fn suggest_native_session_id(state: State<AppState>, pane_id: String) -> Result<Option<String>, String> {
    let provider = load_provider(&state.db_path, &pane_id).map_err(|error| error.to_string())?;
    let runtime_start = state
        .pane_runtime_starts
        .lock()
        .map_err(|_| "failed to lock pane runtime start map".to_string())?
        .get(&pane_id)
        .copied();
    suggest_native_session_id_inner(&state, &pane_id, &provider, runtime_start)
}

#[tauri::command]
fn clear_native_session_binding(state: State<AppState>, pane_id: String) -> Result<(), String> {
    let provider = load_provider(&state.db_path, &pane_id).map_err(|error| error.to_string())?;
    if provider != "codex" && provider != "claude" && provider != "gemini" {
        return Ok(());
    }

    let connection = open_db(&state.db_path).map_err(|error| error.to_string())?;
    connection
        .execute("DELETE FROM pane_codex_state WHERE pane_id = ?1", params![pane_id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn import_native_history(
    state: State<AppState>,
    pane_id: String,
    session_id: Option<String>,
) -> Result<NativeImportResult, String> {
    let provider = load_provider(&state.db_path, &pane_id).map_err(|error| error.to_string())?;
    let runtime_start = state
        .pane_runtime_starts
        .lock()
        .map_err(|_| "failed to lock pane runtime start map".to_string())?
        .get(&pane_id)
        .copied();
    import_native_history_inner(&state, &pane_id, &provider, session_id, runtime_start)
}

#[tauri::command]
fn suggest_codex_session_id(state: State<AppState>, pane_id: String) -> Result<Option<String>, String> {
    let provider = load_provider(&state.db_path, &pane_id).map_err(|error| error.to_string())?;
    if provider != "codex" {
        return Ok(None);
    }
    let runtime_start = state
        .pane_runtime_starts
        .lock()
        .map_err(|_| "failed to lock pane runtime start map".to_string())?
        .get(&pane_id)
        .copied();
    suggest_native_session_id_inner(&state, &pane_id, "codex", runtime_start)
}

#[tauri::command]
fn clear_codex_session_binding(state: State<AppState>, pane_id: String) -> Result<(), String> {
    let provider = load_provider(&state.db_path, &pane_id).map_err(|error| error.to_string())?;
    if provider != "codex" {
        return Ok(());
    }
    let connection = open_db(&state.db_path).map_err(|error| error.to_string())?;
    connection
        .execute("DELETE FROM pane_codex_state WHERE pane_id = ?1", params![pane_id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn import_codex_native_history(
    state: State<AppState>,
    pane_id: String,
    session_id: Option<String>,
) -> Result<NativeImportResult, String> {
    let provider = load_provider(&state.db_path, &pane_id).map_err(|error| error.to_string())?;
    if provider != "codex" {
        return Err("native codex log import is only available for codex panes".to_string());
    }
    let runtime_start = state
        .pane_runtime_starts
        .lock()
        .map_err(|_| "failed to lock pane runtime start map".to_string())?
        .get(&pane_id)
        .copied();
    import_native_history_inner(&state, &pane_id, "codex", session_id, runtime_start)
}

#[tauri::command]
fn list_registered_providers(state: State<AppState>) -> Vec<String> {
    list_registered_provider_ids(&state.adapter_config_dir)
}

#[tauri::command]
fn stop_pane(state: State<AppState>, pane_id: String) -> Result<(), String> {
    stop_pane_runtime(&state, &pane_id).map_err(|error| error.to_string())
}

#[tauri::command]
fn close_pane(state: State<AppState>, pane_id: String) -> Result<(), String> {
    stop_pane_runtime(&state, &pane_id).map_err(|error| error.to_string())?;
    mark_pane_closed(&state.db_path, &pane_id).map_err(|error| error.to_string())
}

#[tauri::command]
fn export_all_history_markdown(state: State<AppState>) -> Result<String, String> {
    export_all_history_markdown_db(&state.db_path).map_err(|error| error.to_string())
}

#[tauri::command]
fn get_observability_info(state: State<AppState>) -> Result<ObservabilityInfo, String> {
    Ok(ObservabilityInfo {
        log_path: state.log_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
fn get_app_config(state: State<AppState>) -> Result<AppConfigResponse, String> {
    let config = state
        .app_config
        .lock()
        .map_err(|_| "failed to lock app config".to_string())?
        .clone();
    Ok(AppConfigResponse {
        config_path: state.config_path.to_string_lossy().to_string(),
        working_directory: config.working_directory,
    })
}

#[tauri::command]
fn set_working_directory(
    app: AppHandle,
    state: State<AppState>,
    path: Option<String>,
    restart_open_panes: Option<bool>,
) -> Result<Option<String>, String> {
    let normalized = normalize_working_directory(path).map_err(|error| error.to_string())?;
    {
        let mut guard = state
            .working_directory
            .lock()
            .map_err(|_| "failed to lock working directory".to_string())?;
        *guard = normalized.clone();
    }
    {
        let mut config = state
            .app_config
            .lock()
            .map_err(|_| "failed to lock app config".to_string())?;
        config.working_directory = normalized
            .as_ref()
            .map(|item| item.to_string_lossy().to_string());
        save_app_config(&state.config_path, &config).map_err(|error| error.to_string())?;
    }

    if restart_open_panes.unwrap_or(true) {
        restart_open_pane_runtimes(&app, &state).map_err(|error| error.to_string())?;
    }

    Ok(normalized.map(|item| item.to_string_lossy().to_string()))
}

#[tauri::command]
fn clear_all_history(state: State<AppState>) -> Result<(), String> {
    stop_all_pane_runtimes(&state).map_err(|error| error.to_string())?;
    let result = clear_all_history_db(&state.db_path).map_err(|error| error.to_string());
    let payload = serde_json::json!({
        "ts": now_epoch(),
        "event": "history.cleared",
        "ok": result.is_ok()
    });
    let _ = write_observable_event(&state, payload);
    result
}

#[tauri::command]
fn clear_pane_history(state: State<AppState>, pane_id: String) -> Result<(), String> {
    let result = (|| -> Result<()> {
        load_provider(&state.db_path, &pane_id)?;
        clear_pane_history_db(&state.db_path, &pane_id)?;
        Ok(())
    })();
    let payload = serde_json::json!({
        "ts": now_epoch(),
        "event": "history.pane_cleared",
        "pane_id": pane_id,
        "ok": result.is_ok()
    });
    let _ = write_observable_event(&state, payload);
    result.map_err(|error| error.to_string())
}

#[derive(Debug, Clone)]
enum CliAction {
    Help,
    Stats,
    ExportMarkdown { output: PathBuf },
    ClearAll { yes: bool },
    PruneDays { days: i64, yes: bool },
    CleanupDaily,
}

#[derive(Debug)]
struct CliStats {
    panes_total: i64,
    panes_open: i64,
    entries_total: i64,
    entries_input: i64,
    entries_output: i64,
    first_entry_ts: Option<i64>,
    last_entry_ts: Option<i64>,
}

#[derive(Debug)]
struct CliPruneReport {
    cutoff_epoch: i64,
    deleted_entries: i64,
    deleted_closed_panes: i64,
    deleted_import_cursors: i64,
    deleted_bindings: i64,
}

fn cli_help_text(binary: &str) -> String {
    format!(
        "\
AI Shell CLI

Usage:
  {bin} --help
  {bin} --stats
  {bin} --export-markdown <output.md>
  {bin} --clear-all --yes
  {bin} --prune-days <N> --yes
  {bin} --cleanup-daily

Commands:
  --help                 Show this help.
  --stats                Show session/history statistics.
  --export-markdown      Export all history to a markdown file.
  --clear-all --yes      Clear all local ai-shell sessions/history.
  --prune-days N --yes   Delete entries older than N days (and stale closed sessions/cursors).
  --cleanup-daily        Shortcut for: --prune-days 7 --yes

Notes:
  - These commands operate on ai-shell local DB only (history.db).
  - Native provider logs under ~/.codex / ~/.claude / ~/.gemini are not deleted.
",
        bin = binary
    )
}

fn parse_cli_action(args: &[String]) -> std::result::Result<Option<CliAction>, String> {
    if args.len() <= 1 {
        return Ok(None);
    }
    let action = args[1].as_str();

    match action {
        "--help" | "-h" => {
            if args.len() == 2 {
                Ok(Some(CliAction::Help))
            } else {
                Err("unexpected extra arguments for --help".to_string())
            }
        }
        "--stats" => {
            if args.len() == 2 {
                Ok(Some(CliAction::Stats))
            } else {
                Err("unexpected extra arguments for --stats".to_string())
            }
        }
        "--export-markdown" => {
            if args.len() != 3 {
                return Err("usage: --export-markdown <output.md>".to_string());
            }
            Ok(Some(CliAction::ExportMarkdown {
                output: PathBuf::from(&args[2]),
            }))
        }
        "--clear-all" => {
            let yes = args.iter().any(|item| item == "--yes");
            if args.len() == 2 || (args.len() == 3 && yes) {
                Ok(Some(CliAction::ClearAll { yes }))
            } else {
                Err("usage: --clear-all --yes".to_string())
            }
        }
        "--prune-days" => {
            if args.len() < 3 || args.len() > 4 {
                return Err("usage: --prune-days <N> --yes".to_string());
            }
            let days = args[2]
                .parse::<i64>()
                .map_err(|_| "N must be an integer".to_string())?;
            let yes = args.iter().any(|item| item == "--yes");
            if args.len() == 4 && !yes {
                return Err("usage: --prune-days <N> --yes".to_string());
            }
            Ok(Some(CliAction::PruneDays { days, yes }))
        }
        "--cleanup-daily" => {
            if args.len() == 2 {
                Ok(Some(CliAction::CleanupDaily))
            } else {
                Err("unexpected extra arguments for --cleanup-daily".to_string())
            }
        }
        other => Err(format!("unknown argument: {}", other)),
    }
}

fn cli_stats_db(path: &Path) -> Result<CliStats> {
    let connection = open_db(path)?;
    let panes_total = connection.query_row("SELECT COUNT(1) FROM panes", [], |row| {
        row.get::<usize, i64>(0)
    })?;
    let panes_open = connection.query_row("SELECT COUNT(1) FROM panes WHERE closed = 0", [], |row| {
        row.get::<usize, i64>(0)
    })?;
    let entries_total = connection.query_row(
        "SELECT COUNT(1) FROM entries WHERE kind IN ('input','output')",
        [],
        |row| row.get::<usize, i64>(0),
    )?;
    let entries_input = connection.query_row(
        "SELECT COUNT(1) FROM entries WHERE kind = 'input'",
        [],
        |row| row.get::<usize, i64>(0),
    )?;
    let entries_output = connection.query_row(
        "SELECT COUNT(1) FROM entries WHERE kind = 'output'",
        [],
        |row| row.get::<usize, i64>(0),
    )?;
    let (first_entry_ts, last_entry_ts) = connection.query_row(
        "SELECT MIN(created_at), MAX(created_at) FROM entries WHERE kind IN ('input','output')",
        [],
        |row| Ok((row.get::<usize, Option<i64>>(0)?, row.get::<usize, Option<i64>>(1)?)),
    )?;

    Ok(CliStats {
        panes_total,
        panes_open,
        entries_total,
        entries_input,
        entries_output,
        first_entry_ts,
        last_entry_ts,
    })
}

fn prune_history_older_than_db(path: &Path, days: i64) -> Result<CliPruneReport> {
    if days <= 0 {
        return Err(anyhow!("days must be > 0"));
    }
    let cutoff_epoch = now_epoch().saturating_sub(days.saturating_mul(86_400));
    let mut connection = open_db(path)?;
    let tx = connection.transaction()?;

    let deleted_entries = tx.execute(
        "DELETE FROM entries WHERE kind IN ('input','output') AND created_at < ?1",
        params![cutoff_epoch],
    )? as i64;
    let deleted_closed_panes = tx.execute(
        "DELETE FROM panes WHERE closed = 1 AND updated_at < ?1",
        params![cutoff_epoch],
    )? as i64;
    let deleted_import_cursors = tx.execute(
        "DELETE FROM codex_import_state WHERE updated_at < ?1 OR pane_id NOT IN (SELECT id FROM panes)",
        params![cutoff_epoch],
    )? as i64;
    let deleted_bindings = tx.execute(
        "DELETE FROM pane_codex_state WHERE updated_at < ?1 OR pane_id NOT IN (SELECT id FROM panes)",
        params![cutoff_epoch],
    )? as i64;

    tx.commit()?;
    Ok(CliPruneReport {
        cutoff_epoch,
        deleted_entries,
        deleted_closed_panes,
        deleted_import_cursors,
        deleted_bindings,
    })
}

fn run_cli_action(action: &CliAction, db_path: &Path) -> Result<()> {
    match action {
        CliAction::Help => {
            let binary = std::env::args().next().unwrap_or_else(|| "ai-shell".to_string());
            println!("{}", cli_help_text(&binary));
            Ok(())
        }
        CliAction::Stats => {
            let stats = cli_stats_db(db_path)?;
            println!("AI Shell Stats");
            println!("  panes_total: {}", stats.panes_total);
            println!("  panes_open: {}", stats.panes_open);
            println!("  entries_total: {}", stats.entries_total);
            println!("  entries_input: {}", stats.entries_input);
            println!("  entries_output: {}", stats.entries_output);
            println!(
                "  first_entry_ts: {}",
                stats
                    .first_entry_ts
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "-".to_string())
            );
            println!(
                "  last_entry_ts: {}",
                stats
                    .last_entry_ts
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "-".to_string())
            );
            Ok(())
        }
        CliAction::ExportMarkdown { output } => {
            let markdown = export_all_history_markdown_db(db_path)?;
            if let Some(parent) = output.parent() {
                if !parent.as_os_str().is_empty() {
                    std::fs::create_dir_all(parent)?;
                }
            }
            std::fs::write(output, markdown)?;
            println!("exported markdown: {}", output.to_string_lossy());
            Ok(())
        }
        CliAction::ClearAll { yes } => {
            if !yes {
                return Err(anyhow!("refusing destructive clear; re-run with --yes"));
            }
            clear_all_history_db(db_path)?;
            println!("cleared all ai-shell history");
            Ok(())
        }
        CliAction::PruneDays { days, yes } => {
            if !yes {
                return Err(anyhow!("refusing prune without --yes"));
            }
            let report = prune_history_older_than_db(db_path, *days)?;
            println!("pruned history older than {} days", days);
            println!("  cutoff_epoch: {}", report.cutoff_epoch);
            println!("  deleted_entries: {}", report.deleted_entries);
            println!("  deleted_closed_panes: {}", report.deleted_closed_panes);
            println!("  deleted_import_cursors: {}", report.deleted_import_cursors);
            println!("  deleted_bindings: {}", report.deleted_bindings);
            Ok(())
        }
        CliAction::CleanupDaily => {
            let report = prune_history_older_than_db(db_path, 7)?;
            println!("daily cleanup complete (keep last 7 days)");
            println!("  cutoff_epoch: {}", report.cutoff_epoch);
            println!("  deleted_entries: {}", report.deleted_entries);
            println!("  deleted_closed_panes: {}", report.deleted_closed_panes);
            println!("  deleted_import_cursors: {}", report.deleted_import_cursors);
            println!("  deleted_bindings: {}", report.deleted_bindings);
            Ok(())
        }
    }
}

fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    let cli_action = match parse_cli_action(&args) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("{}\n", error);
            let binary = args.first().cloned().unwrap_or_else(|| "ai-shell".to_string());
            eprintln!("{}", cli_help_text(&binary));
            std::process::exit(2);
        }
    };

    if matches!(cli_action, Some(CliAction::Help)) {
        let binary = args.first().cloned().unwrap_or_else(|| "ai-shell".to_string());
        println!("{}", cli_help_text(&binary));
        return;
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .context("failed to resolve app data dir")?;
            std::fs::create_dir_all(&data_dir)?;
            let db_path = data_dir.join("history.db");
            let log_dir = data_dir.join("logs");
            let adapter_config_dir = data_dir.join("adapters");
            std::fs::create_dir_all(&log_dir)?;
            std::fs::create_dir_all(&adapter_config_dir)?;
            let log_path = log_dir.join("events.jsonl");
            let config_path = data_dir.join("settings.json");
            ensure_adapter_sample_file(&adapter_config_dir);
            init_schema(&db_path)?;
            let app_config = load_app_config(&config_path);
            let working_directory = normalize_working_directory(app_config.working_directory.clone())
                .unwrap_or_default();

            if let Some(action) = cli_action.as_ref() {
                match run_cli_action(action, &db_path) {
                    Ok(()) => std::process::exit(0),
                    Err(error) => {
                        eprintln!("cli error: {}", error);
                        std::process::exit(2);
                    }
                }
            }

            app.manage(AppState {
                panes: Mutex::new(HashMap::new()),
                pane_runtime_starts: Mutex::new(HashMap::new()),
                working_directory: Mutex::new(working_directory),
                app_config: Mutex::new(app_config),
                config_path,
                db_path,
                adapter_config_dir,
                log_path,
                log_lock: Mutex::new(()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_panes,
            list_entries,
            count_entries,
            create_pane,
            ensure_pane_runtime,
            send_to_pane,
            write_to_pane,
            resize_pane,
            append_entry,
            sync_entries,
            run_provider_prompt,
            run_team_prompt,
            suggest_native_session_id,
            clear_native_session_binding,
            import_native_history,
            suggest_codex_session_id,
            clear_codex_session_binding,
            import_codex_native_history,
            list_registered_providers,
            stop_pane,
            close_pane,
            export_all_history_markdown,
            get_observability_info,
            get_app_config,
            set_working_directory,
            clear_all_history,
            clear_pane_history
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
