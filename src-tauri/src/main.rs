#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

mod ai_team_mcp;

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
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use rhai::{AST, Dynamic, Engine, Scope};
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use strip_ansi_escapes::strip;
use tauri::{AppHandle, Emitter, LogicalSize, Manager, Size, State};
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
    pane_output_buffers: Arc<Mutex<HashMap<String, PaneOutputBuffer>>>,
    native_session_candidates_cache: Mutex<HashMap<String, NativeSessionCandidatesCache>>,
    native_session_preview_cache: Mutex<HashMap<String, NativeSessionPreviewCache>>,
    native_session_record_count_cache: Mutex<HashMap<String, NativeSessionRecordCountCache>>,
    native_session_first_input_cache: Mutex<HashMap<String, NativeSessionFirstInputCache>>,
    native_session_index_progress: Mutex<HashMap<String, NativeSessionIndexProgress>>,
    working_directory: Mutex<Option<PathBuf>>,
    app_config: Mutex<AppConfig>,
    config_path: PathBuf,
    db_path: PathBuf,
    adapter_config_dir: PathBuf,
    session_parser_config_dir: PathBuf,
    log_path: PathBuf,
    log_lock: Mutex<()>,
}

#[derive(Debug, Clone, Default)]
struct PaneOutputBuffer {
    revision: u64,
    text: String,
    updated_at: i64,
}

#[derive(Debug, Clone, Copy)]
struct SidProbeProfile {
    probe_command: &'static str,
    timeout_secs: i64,
    cleanup_input: Option<&'static str>,
    labels: &'static [&'static str],
}

#[derive(Debug, Clone)]
struct NativeSessionCandidatesCache {
    batch: NativeSessionCandidatesBatch,
}

#[derive(Debug, Clone)]
struct NativeSessionPreviewCache {
    updated_at: i64,
    rows: Vec<NativeSessionPreviewRow>,
}

#[derive(Debug, Clone)]
struct NativeSessionCandidatesBatch {
    items: Vec<NativeSessionCandidate>,
    unrecognized_files: Vec<NativeSessionUnrecognizedFile>,
}

#[derive(Debug, Clone)]
struct NativeSessionFileIndexRow {
    session_id: String,
    started_at: i64,
    file_time_key: i64,
    mtime: i64,
    record_count: i64,
    first_input: String,
}

#[derive(Debug, Clone)]
struct NativeSessionRecordCountCache {
    updated_at: i64,
    count: i64,
}

#[derive(Debug, Clone)]
struct NativeSessionFirstInputCache {
    updated_at: i64,
    text: String,
}

#[derive(Debug, Serialize, Clone, Default)]
struct NativeSessionIndexProgress {
    provider: String,
    running: bool,
    total_files: i64,
    processed_files: i64,
    changed_files: i64,
    started_at: i64,
    elapsed_secs: i64,
    last_duration_secs: i64,
    updated_at: i64,
}

#[derive(Debug, Serialize, Clone)]
struct PaneSummary {
    id: String,
    provider: String,
    title: String,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Serialize, Clone, Default)]
struct PaneSessionState {
    pane_id: String,
    active_session_id: String,
    linked_session_ids: Vec<String>,
    include_linked_in_sync: bool,
    updated_at: i64,
}

#[derive(Debug, Serialize, Clone, Default)]
struct PaneScanConfig {
    pane_id: String,
    parser_profile: String,
    file_glob: String,
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
    session_ids: Vec<String>,
    source_dir: String,
    imported: i64,
    skipped: i64,
    scanned_files: i64,
    scanned_lines: i64,
    parse_errors: i64,
}

#[derive(Debug, Serialize, Clone)]
struct NativeSessionCandidate {
    provider: String,
    session_id: String,
    started_at: i64,
    last_seen_at: i64,
    source_files: i64,
    record_count: i64,
    first_input: String,
}

#[derive(Debug, Serialize, Clone)]
struct NativeSessionUnrecognizedFile {
    file_path: String,
    reason: String,
    parse_errors: i64,
    scanned_units: i64,
    row_count: i64,
    modified_at: i64,
}

#[derive(Debug, Serialize, Clone)]
struct NativeSessionListResponse {
    items: Vec<NativeSessionCandidate>,
    unrecognized_files: Vec<NativeSessionUnrecognizedFile>,
    total: i64,
    offset: i64,
    limit: i64,
    has_more: bool,
}

#[derive(Debug, Serialize, Clone)]
struct NativeSessionPreviewRow {
    id: String,
    kind: String,
    content: String,
    created_at: i64,
    preview_truncated: bool,
}

#[derive(Debug, Serialize, Clone)]
struct NativeSessionPreviewResponse {
    session_id: String,
    rows: Vec<NativeSessionPreviewRow>,
    total_rows: i64,
    loaded_rows: i64,
    has_more: bool,
}

#[derive(Debug, Serialize, Clone)]
struct NativeSessionMessageDetailResponse {
    message_id: String,
    session_id: String,
    kind: String,
    content: String,
    created_at: i64,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NativeSessionMessageSelection {
    message_id: String,
    session_id: String,
}

#[derive(Debug, Serialize, Clone)]
struct NativeUnrecognizedFilePreviewResponse {
    file_path: String,
    reason: String,
    parse_errors: i64,
    scanned_units: i64,
    row_count: i64,
    session_id: String,
    started_at: i64,
    content: String,
}

#[derive(Debug, Serialize, Clone)]
struct SessionParserSamplePreviewResponse {
    parser_profile: String,
    file_path: String,
    file_format: String,
    sample_value: serde_json::Value,
    message_sample_value: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Clone)]
struct NativeImportEstimateItem {
    session_id: String,
    record_count: i64,
}

#[derive(Debug, Serialize, Clone)]
struct NativeImportEstimate {
    provider: String,
    session_count: i64,
    estimated_records: i64,
    items: Vec<NativeImportEstimateItem>,
}

#[derive(Debug, Serialize, Clone)]
struct WorkdirSessionBinding {
    workdir: String,
    provider: String,
    session_ids: Vec<String>,
    updated_at: i64,
}

#[derive(Debug, Serialize)]
struct ObservabilityInfo {
    log_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
struct AppConfig {
    working_directory: Option<String>,
    native_session_list_cache_ttl_secs: i64,
    ui_theme_preset: String,
    ui_skin_hue: i64,
    ui_skin_accent: String,
    user_avatar_path: String,
    assistant_avatar_path: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            working_directory: None,
            native_session_list_cache_ttl_secs: DEFAULT_NATIVE_SESSION_CACHE_TTL_SECS,
            ui_theme_preset: DEFAULT_UI_THEME_PRESET.to_string(),
            ui_skin_hue: DEFAULT_UI_SKIN_HUE,
            ui_skin_accent: DEFAULT_UI_SKIN_ACCENT.to_string(),
            user_avatar_path: DEFAULT_USER_AVATAR_PATH.to_string(),
            assistant_avatar_path: DEFAULT_ASSISTANT_AVATAR_PATH.to_string(),
        }
    }
}

#[derive(Debug, Serialize)]
struct AppConfigResponse {
    config_path: String,
    working_directory: Option<String>,
    native_session_list_cache_ttl_secs: i64,
    ui_theme_preset: String,
    ui_skin_hue: i64,
    ui_skin_accent: String,
    user_avatar_path: String,
    assistant_avatar_path: String,
}

#[derive(Debug, Serialize)]
struct UiThemeConfigResponse {
    ui_theme_preset: String,
    ui_skin_hue: i64,
    ui_skin_accent: String,
}

#[derive(Debug, Serialize)]
struct AvatarConfigResponse {
    user_avatar_path: String,
    assistant_avatar_path: String,
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

#[derive(Debug, Clone, Default)]
struct SessionFileMatcher {
    patterns: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
struct JsonFieldEqualsFilter {
    path: String,
    equals: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
struct SessionParserMessageRule {
    filters: Vec<JsonFieldEqualsFilter>,
    ignore_true_paths: Vec<String>,
    role_path: String,
    role_map: HashMap<String, String>,
    session_id_paths: Vec<String>,
    content_item_path: String,
    content_item_filter_path: String,
    content_item_filter_by_role: HashMap<String, String>,
    content_text_paths: Vec<String>,
    timestamp_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
struct SessionParserConfig {
    id: String,
    name: Option<String>,
    source_roots: Vec<String>,
    default_file_glob: String,
    file_format: String,
    session_meta_scan_max_lines: i64,
    session_id_paths: Vec<String>,
    started_at_paths: Vec<String>,
    session_meta_filters: Vec<JsonFieldEqualsFilter>,
    message_source_path: String,
    message_rules: Vec<SessionParserMessageRule>,
    fallback_timestamp_paths: Vec<String>,
    strip_codex_tags: bool,
    line_parser_function: String,
    line_parser_script: String,
}

#[derive(Debug, Clone, Serialize)]
struct SessionParserProfileSummary {
    id: String,
    name: String,
    default_file_glob: String,
    file_format: String,
}

#[derive(Debug, Clone)]
struct GenericSessionMeta {
    file_path: PathBuf,
    session_id: String,
    started_at: i64,
    file_time_key: i64,
    mtime: i64,
    record_count: i64,
    first_input: String,
}

#[derive(Debug, Clone, Default)]
struct ParserMetaIndexResult {
    metas: Vec<GenericSessionMeta>,
    unrecognized_files: Vec<NativeSessionUnrecognizedFile>,
}

#[derive(Debug, Clone)]
struct ParsedMessageRow {
    session_id: String,
    kind: String,
    content: String,
    created_at: i64,
    line_no: i64,
    role: String,
    content_index: usize,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct NativeSessionMessageLocator {
    session_id: String,
    file_path: String,
    kind: String,
    created_at: i64,
    line_no: i64,
    content_index: usize,
}

#[derive(Debug, Clone, Default)]
struct ParsedSessionFile {
    session_id: Option<String>,
    started_at: i64,
    scanned_units: i64,
    parse_errors: i64,
    truncated: bool,
    rows: Vec<ParsedMessageRow>,
}

const IMPORT_FILE_QUIET_WINDOW_SECS: i64 = 2;
const DEFAULT_NATIVE_SESSION_CACHE_TTL_SECS: i64 = 30;
const MAX_NATIVE_SESSION_CACHE_TTL_SECS: i64 = 600;
const DEFAULT_UI_THEME_PRESET: &str = "ocean";
const DEFAULT_UI_SKIN_HUE: i64 = 218;
const DEFAULT_UI_SKIN_ACCENT: &str = "#34e7ff";
const DEFAULT_USER_AVATAR_PATH: &str = "@man.jpg";
const DEFAULT_ASSISTANT_AVATAR_PATH: &str = "@ai.jpg";
const DEFAULT_NATIVE_SCAN_PROFILE: &str = "codex";

fn now_epoch() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

fn session_debug_enabled() -> bool {
    #[cfg(not(debug_assertions))]
    {
        return false;
    }
    #[cfg(debug_assertions)]
    {
        match std::env::var("AISHELL_SESSION_DEBUG") {
            Ok(value) => {
                let normalized = value.trim().to_lowercase();
                normalized == "1" || normalized == "true" || normalized == "yes" || normalized == "on"
            }
            Err(_) => false,
        }
    }
}

fn session_debug_log(message: &str) {
    if session_debug_enabled() {
        eprintln!("[session-debug] {}", message);
    }
}

fn as_title(value: &str) -> String {
    let text = value.trim();
    if text.is_empty() {
        return "Unknown".to_string();
    }
    let mut chars = text.chars();
    if let Some(first) = chars.next() {
        let mut output = first.to_uppercase().collect::<String>();
        output.push_str(chars.as_str());
        return output;
    }
    "Unknown".to_string()
}

fn normalize_native_session_cache_ttl_secs(value: i64) -> i64 {
    value.clamp(0, MAX_NATIVE_SESSION_CACHE_TTL_SECS)
}

fn normalize_ui_theme_preset(value: &str) -> String {
    let normalized = value.trim().to_lowercase();
    match normalized.as_str() {
        "ocean" | "forest" | "sunset" | "graphite" | "custom" => normalized,
        _ => DEFAULT_UI_THEME_PRESET.to_string(),
    }
}

fn normalize_ui_skin_hue(value: i64) -> i64 {
    value.clamp(0, 360)
}

fn normalize_avatar_path(value: &str, fallback: &str) -> String {
    let normalized = value.trim();
    if normalized.is_empty() {
        return fallback.to_string();
    }
    normalized.to_string()
}

fn guess_image_mime_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|item| item.to_str())
        .map(|item| item.trim().to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("bmp") => "image/bmp",
        Some("svg") => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

fn read_image_file_as_data_url(path: &Path) -> Result<String> {
    let bytes = fs::read(path).with_context(|| format!("read image file: {}", path.display()))?;
    let mime = guess_image_mime_type(path);
    Ok(format!(
        "data:{};base64,{}",
        mime,
        BASE64_STANDARD.encode(bytes)
    ))
}

fn normalize_hex_color(value: &str, fallback: &str) -> String {
    let normalized = value.trim();
    let valid_hex = |text: &str| text.chars().all(|ch| ch.is_ascii_hexdigit());
    if normalized.starts_with('#') {
        let raw = &normalized[1..];
        if raw.len() == 6 && valid_hex(raw) {
            return format!("#{}", raw.to_lowercase());
        }
        if raw.len() == 3 && valid_hex(raw) {
            let expanded = raw
                .chars()
                .flat_map(|ch| [ch.to_ascii_lowercase(), ch.to_ascii_lowercase()])
                .collect::<String>();
            return format!("#{}", expanded);
        }
    }
    fallback.to_string()
}

fn set_native_session_index_progress(
    state: &AppState,
    provider: &str,
    running: bool,
    total_files: i64,
    processed_files: i64,
    changed_files: i64,
) {
    if let Ok(mut map) = state.native_session_index_progress.lock() {
        let now = now_epoch();
        let previous = map.get(provider).cloned();
        let started_at = if running {
            if let Some(prev) = previous.as_ref() {
                if prev.running && prev.started_at > 0 {
                    prev.started_at
                } else {
                    now
                }
            } else {
                now
            }
        } else if let Some(prev) = previous.as_ref() {
            if prev.running && prev.started_at > 0 {
                prev.started_at
            } else {
                prev.started_at
            }
        } else {
            0
        };
        let elapsed_secs = if started_at > 0 {
            now.saturating_sub(started_at)
        } else {
            0
        };
        let last_duration_secs = if running {
            previous
                .as_ref()
                .map(|item| item.last_duration_secs)
                .unwrap_or(0)
        } else if elapsed_secs > 0 {
            elapsed_secs
        } else {
            previous
                .as_ref()
                .map(|item| item.last_duration_secs)
                .unwrap_or(0)
        };

        map.insert(
            provider.to_string(),
            NativeSessionIndexProgress {
                provider: provider.to_string(),
                running,
                total_files,
                processed_files,
                changed_files,
                started_at,
                elapsed_secs,
                last_duration_secs,
                updated_at: now,
            },
        );
    }
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
          active_session_id TEXT NOT NULL DEFAULT '',
          linked_session_ids TEXT NOT NULL DEFAULT '[]',
          include_linked_in_sync INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS native_session_file_index (
          provider TEXT NOT NULL,
          file_path TEXT NOT NULL,
          session_id TEXT NOT NULL,
          started_at INTEGER NOT NULL DEFAULT 0,
          file_time_key INTEGER NOT NULL DEFAULT 0,
          mtime INTEGER NOT NULL DEFAULT 0,
          record_count INTEGER NOT NULL DEFAULT 0,
          first_input TEXT NOT NULL DEFAULT '',
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (provider, file_path)
        );

        CREATE INDEX IF NOT EXISTS idx_native_session_file_provider_session
          ON native_session_file_index(provider, session_id);

        CREATE TABLE IF NOT EXISTS workdir_session_bindings (
          workdir TEXT NOT NULL,
          provider TEXT NOT NULL,
          session_ids TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (workdir, provider)
        );

        CREATE INDEX IF NOT EXISTS idx_workdir_session_bindings_provider
          ON workdir_session_bindings(provider, updated_at);

        CREATE TABLE IF NOT EXISTS pane_scan_config (
          pane_id TEXT PRIMARY KEY,
          parser_profile TEXT NOT NULL DEFAULT '',
          file_glob TEXT NOT NULL DEFAULT '',
          updated_at INTEGER NOT NULL
        );
        "#,
    )?;

    if let Err(error) =
        connection.execute("ALTER TABLE pane_codex_state ADD COLUMN active_session_id TEXT", [])
    {
        let message = error.to_string().to_lowercase();
        if !message.contains("duplicate column name") {
            return Err(error.into());
        }
    }

    if let Err(error) =
        connection.execute("ALTER TABLE pane_codex_state ADD COLUMN linked_session_ids TEXT", [])
    {
        let message = error.to_string().to_lowercase();
        if !message.contains("duplicate column name") {
            return Err(error.into());
        }
    }

    if let Err(error) = connection.execute(
        "ALTER TABLE pane_codex_state ADD COLUMN include_linked_in_sync INTEGER NOT NULL DEFAULT 0",
        [],
    ) {
        let message = error.to_string().to_lowercase();
        if !message.contains("duplicate column name") {
            return Err(error.into());
        }
    }

    if let Err(error) = connection.execute(
        "ALTER TABLE native_session_file_index ADD COLUMN first_input TEXT NOT NULL DEFAULT ''",
        [],
    ) {
        let message = error.to_string().to_lowercase();
        if !message.contains("duplicate column name") {
            return Err(error.into());
        }
    }

    connection.execute(
        r#"
        UPDATE pane_codex_state
        SET active_session_id = COALESCE(NULLIF(TRIM(active_session_id), ''), session_id)
        WHERE active_session_id IS NULL OR TRIM(active_session_id) = ''
        "#,
        [],
    )?;
    connection.execute(
        r#"
        UPDATE pane_codex_state
        SET linked_session_ids = '[]'
        WHERE linked_session_ids IS NULL OR TRIM(linked_session_ids) = ''
        "#,
        [],
    )?;
    connection.execute(
        r#"
        UPDATE pane_codex_state
        SET include_linked_in_sync = 0
        WHERE include_linked_in_sync IS NULL
        "#,
        [],
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

fn session_cache_ttl_secs(state: &AppState) -> i64 {
    state
        .app_config
        .lock()
        .ok()
        .map(|config| normalize_native_session_cache_ttl_secs(config.native_session_list_cache_ttl_secs))
        .unwrap_or(DEFAULT_NATIVE_SESSION_CACHE_TTL_SECS)
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

fn built_in_session_parser_configs() -> Vec<SessionParserConfig> {
    vec![
        SessionParserConfig {
            id: "codex".to_string(),
            name: Some("Codex JSONL".to_string()),
            source_roots: vec!["$CODEX_SESSIONS".to_string()],
            default_file_glob: "**/rollout-*.jsonl".to_string(),
            file_format: "jsonl".to_string(),
            session_meta_scan_max_lines: 64,
            session_id_paths: vec!["payload.id".to_string()],
            started_at_paths: vec!["payload.timestamp".to_string(), "timestamp".to_string()],
            session_meta_filters: vec![JsonFieldEqualsFilter {
                path: "type".to_string(),
                equals: "session_meta".to_string(),
            }],
            message_source_path: String::new(),
            message_rules: vec![SessionParserMessageRule {
                filters: vec![
                    JsonFieldEqualsFilter {
                        path: "type".to_string(),
                        equals: "response_item".to_string(),
                    },
                    JsonFieldEqualsFilter {
                        path: "payload.type".to_string(),
                        equals: "message".to_string(),
                    },
                ],
                role_path: "payload.role".to_string(),
                role_map: HashMap::from([
                    ("user".to_string(), "input".to_string()),
                    ("assistant".to_string(), "output".to_string()),
                ]),
                content_item_path: "payload.content[]".to_string(),
                content_item_filter_path: "type".to_string(),
                content_item_filter_by_role: HashMap::from([
                    ("user".to_string(), "input_text".to_string()),
                    ("assistant".to_string(), "output_text".to_string()),
                ]),
                content_text_paths: vec!["text".to_string()],
                timestamp_paths: vec!["timestamp".to_string()],
                ..SessionParserMessageRule::default()
            }],
            fallback_timestamp_paths: Vec::new(),
            strip_codex_tags: true,
            line_parser_function: "parse_line".to_string(),
            line_parser_script: String::new(),
        },
        SessionParserConfig {
            id: "claude".to_string(),
            name: Some("Claude JSONL".to_string()),
            source_roots: vec!["$CLAUDE_PROJECTS".to_string()],
            default_file_glob: "**/*.jsonl".to_string(),
            file_format: "jsonl".to_string(),
            session_meta_scan_max_lines: 320,
            session_id_paths: vec!["sessionId".to_string()],
            started_at_paths: vec!["timestamp".to_string()],
            session_meta_filters: Vec::new(),
            message_source_path: String::new(),
            message_rules: vec![SessionParserMessageRule {
                ignore_true_paths: vec!["isSidechain".to_string(), "isMeta".to_string()],
                role_path: "type".to_string(),
                role_map: HashMap::from([
                    ("user".to_string(), "input".to_string()),
                    ("assistant".to_string(), "output".to_string()),
                ]),
                session_id_paths: vec!["sessionId".to_string()],
                content_item_path: String::new(),
                content_item_filter_path: String::new(),
                content_item_filter_by_role: HashMap::new(),
                content_text_paths: vec!["message.content".to_string(), "content".to_string()],
                timestamp_paths: vec!["timestamp".to_string()],
                ..SessionParserMessageRule::default()
            }],
            fallback_timestamp_paths: Vec::new(),
            strip_codex_tags: false,
            line_parser_function: "parse_line".to_string(),
            line_parser_script: String::new(),
        },
        SessionParserConfig {
            id: "gemini".to_string(),
            name: Some("Gemini JSON".to_string()),
            source_roots: vec!["$GEMINI_TMP".to_string()],
            default_file_glob: "**/session-*.json".to_string(),
            file_format: "json".to_string(),
            session_meta_scan_max_lines: 0,
            session_id_paths: vec!["sessionId".to_string()],
            started_at_paths: vec!["startTime".to_string()],
            session_meta_filters: Vec::new(),
            message_source_path: "messages[]".to_string(),
            message_rules: vec![SessionParserMessageRule {
                role_path: "type".to_string(),
                role_map: HashMap::from([
                    ("user".to_string(), "input".to_string()),
                    ("assistant".to_string(), "output".to_string()),
                    ("gemini".to_string(), "output".to_string()),
                ]),
                session_id_paths: Vec::new(),
                content_item_path: String::new(),
                content_item_filter_path: String::new(),
                content_item_filter_by_role: HashMap::new(),
                content_text_paths: vec!["content".to_string()],
                timestamp_paths: vec!["timestamp".to_string()],
                ..SessionParserMessageRule::default()
            }],
            fallback_timestamp_paths: vec!["lastUpdated".to_string(), "startTime".to_string()],
            strip_codex_tags: false,
            line_parser_function: "parse_line".to_string(),
            line_parser_script: String::new(),
        },
    ]
}

fn normalize_filter(item: JsonFieldEqualsFilter) -> Option<JsonFieldEqualsFilter> {
    let path = item.path.trim().to_string();
    let equals = item.equals.trim().to_string();
    if path.is_empty() || equals.is_empty() {
        return None;
    }
    Some(JsonFieldEqualsFilter { path, equals })
}

fn normalize_role_map(raw: HashMap<String, String>) -> HashMap<String, String> {
    let mut next = HashMap::new();
    for (raw_role, raw_kind) in raw {
        let role = raw_role.trim().to_lowercase();
        let kind = raw_kind.trim().to_lowercase();
        if role.is_empty() {
            continue;
        }
        if kind != "input" && kind != "output" {
            continue;
        }
        next.insert(role, kind);
    }
    next
}

fn normalize_message_rule(rule: SessionParserMessageRule) -> Option<SessionParserMessageRule> {
    let role_path = rule.role_path.trim().to_string();
    if role_path.is_empty() {
        return None;
    }
    let mut role_map = normalize_role_map(rule.role_map);
    if role_map.is_empty() {
        role_map.insert("user".to_string(), "input".to_string());
        role_map.insert("assistant".to_string(), "output".to_string());
    }
    let filters = rule
        .filters
        .into_iter()
        .filter_map(normalize_filter)
        .collect::<Vec<_>>();
    let ignore_true_paths = rule
        .ignore_true_paths
        .into_iter()
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty())
        .collect::<Vec<_>>();
    let session_id_paths = rule
        .session_id_paths
        .into_iter()
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty())
        .collect::<Vec<_>>();
    let mut content_text_paths = rule
        .content_text_paths
        .into_iter()
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty())
        .collect::<Vec<_>>();
    if content_text_paths.is_empty() {
        content_text_paths.push(String::new());
    }
    let timestamp_paths = rule
        .timestamp_paths
        .into_iter()
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty())
        .collect::<Vec<_>>();
    let mut content_item_filter_by_role = HashMap::new();
    for (raw_role, raw_value) in rule.content_item_filter_by_role {
        let role = raw_role.trim().to_lowercase();
        let value = raw_value.trim().to_string();
        if role.is_empty() || value.is_empty() {
            continue;
        }
        content_item_filter_by_role.insert(role, value);
    }
    Some(SessionParserMessageRule {
        filters,
        ignore_true_paths,
        role_path,
        role_map,
        session_id_paths,
        content_item_path: rule.content_item_path.trim().to_string(),
        content_item_filter_path: rule.content_item_filter_path.trim().to_string(),
        content_item_filter_by_role,
        content_text_paths,
        timestamp_paths,
    })
}

fn normalize_session_parser_config(config: SessionParserConfig) -> Option<SessionParserConfig> {
    let id = normalize_native_scan_profile(&config.id, "");
    if id.is_empty() {
        return None;
    }
    let source_roots = config
        .source_roots
        .into_iter()
        .map(|root| root.trim().to_string())
        .filter(|root| !root.is_empty())
        .collect::<Vec<_>>();
    let mut default_file_glob = config.default_file_glob.trim().to_string();
    let file_format = match config.file_format.trim().to_lowercase().as_str() {
        "json" => "json".to_string(),
        _ => "jsonl".to_string(),
    };
    if default_file_glob.is_empty() {
        default_file_glob = if file_format == "json" {
            "**/*.json".to_string()
        } else {
            "**/*.jsonl".to_string()
        };
    }
    let session_id_paths = config
        .session_id_paths
        .into_iter()
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty())
        .collect::<Vec<_>>();
    let started_at_paths = config
        .started_at_paths
        .into_iter()
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty())
        .collect::<Vec<_>>();
    let session_meta_filters = config
        .session_meta_filters
        .into_iter()
        .filter_map(normalize_filter)
        .collect::<Vec<_>>();
    let message_rules = config
        .message_rules
        .into_iter()
        .filter_map(normalize_message_rule)
        .collect::<Vec<_>>();
    let fallback_timestamp_paths = config
        .fallback_timestamp_paths
        .into_iter()
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty())
        .collect::<Vec<_>>();
    let line_parser_function = config
        .line_parser_function
        .trim()
        .to_string()
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '_')
        .collect::<String>();
    let line_parser_script = config.line_parser_script.trim().to_string();
    Some(SessionParserConfig {
        id,
        name: config
            .name
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        source_roots,
        default_file_glob,
        file_format,
        session_meta_scan_max_lines: config.session_meta_scan_max_lines.clamp(0, 20_000),
        session_id_paths,
        started_at_paths,
        session_meta_filters,
        message_source_path: config.message_source_path.trim().to_string(),
        message_rules,
        fallback_timestamp_paths,
        strip_codex_tags: config.strip_codex_tags,
        line_parser_function: if line_parser_function.is_empty() {
            "parse_line".to_string()
        } else {
            line_parser_function
        },
        line_parser_script,
    })
}

fn parse_session_parser_config_blob(path: &Path, raw: &str) -> Vec<SessionParserConfig> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_lowercase())
        .unwrap_or_default();

    let parsed = if extension == "yaml" || extension == "yml" {
        serde_yaml::from_str::<Vec<SessionParserConfig>>(raw).ok().or_else(|| {
            serde_yaml::from_str::<SessionParserConfig>(raw)
                .ok()
                .map(|item| vec![item])
        })
    } else {
        serde_json::from_str::<Vec<SessionParserConfig>>(raw)
            .ok()
            .or_else(|| serde_json::from_str::<SessionParserConfig>(raw).ok().map(|item| vec![item]))
    };

    parsed.unwrap_or_default()
}

fn load_external_session_parser_configs(session_parser_config_dir: &Path) -> Vec<SessionParserConfig> {
    if !session_parser_config_dir.exists() {
        return Vec::new();
    }
    let mut collected = Vec::new();
    let entries = match fs::read_dir(session_parser_config_dir) {
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
        for config in parse_session_parser_config_blob(&path, &raw) {
            if let Some(normalized) = normalize_session_parser_config(config) {
                collected.push(normalized);
            }
        }
    }
    collected
}

fn load_registered_session_parsers(session_parser_config_dir: &Path) -> Vec<SessionParserConfig> {
    let mut by_id = HashMap::<String, SessionParserConfig>::new();
    for config in built_in_session_parser_configs() {
        if let Some(normalized) = normalize_session_parser_config(config) {
            by_id.insert(normalized.id.clone(), normalized);
        }
    }
    for config in load_external_session_parser_configs(session_parser_config_dir) {
        by_id.insert(config.id.clone(), config);
    }
    let mut items = by_id.into_values().collect::<Vec<_>>();
    items.sort_by(|left, right| left.id.cmp(&right.id));
    items
}

fn resolve_session_parser_profile(
    session_parser_config_dir: &Path,
    profile_id: &str,
) -> Option<SessionParserConfig> {
    let normalized = normalize_native_scan_profile(profile_id, "");
    if normalized.is_empty() {
        return None;
    }
    load_registered_session_parsers(session_parser_config_dir)
        .into_iter()
        .find(|item| item.id == normalized)
}

fn list_registered_session_parser_profile_summaries(
    session_parser_config_dir: &Path,
) -> Vec<SessionParserProfileSummary> {
    load_registered_session_parsers(session_parser_config_dir)
        .into_iter()
        .map(|item| SessionParserProfileSummary {
            id: item.id.clone(),
            name: item.name.clone().unwrap_or_else(|| as_title(&item.id)),
            default_file_glob: item.default_file_glob.clone(),
            file_format: item.file_format.clone(),
        })
        .collect::<Vec<_>>()
}

fn ensure_session_parser_sample_file(session_parser_config_dir: &Path) {
    let sample_path = session_parser_config_dir.join("session-parser.sample.yaml");
    if sample_path.exists() {
        return;
    }
    let sample = r#"id: custom-model
name: Custom Model JSONL
source_roots:
  - /path/to/custom/logs
default_file_glob: "**/*.jsonl"
file_format: jsonl
session_meta_scan_max_lines: 128
session_id_paths:
  - sessionId
started_at_paths:
  - timestamp
message_rules:
  - role_path: type
    role_map:
      user: input
      assistant: output
    content_text_paths:
      - content
    timestamp_paths:
      - timestamp
line_parser_function: parse_line
line_parser_script: |
  fn parse_line(line, ctx) {
    // Return map or array:
    // #{ session_id: "...", started_at: 1700000000, kind: "input|output", content: "...", created_at: 1700000001 }
    return ();
  }
"#;
    let _ = std::fs::write(sample_path, sample);
}

fn parse_session_parser_configs_from_text(raw: &str) -> Vec<SessionParserConfig> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    serde_json::from_str::<Vec<SessionParserConfig>>(trimmed)
        .ok()
        .or_else(|| serde_json::from_str::<SessionParserConfig>(trimmed).ok().map(|item| vec![item]))
        .or_else(|| serde_yaml::from_str::<Vec<SessionParserConfig>>(trimmed).ok())
        .or_else(|| serde_yaml::from_str::<SessionParserConfig>(trimmed).ok().map(|item| vec![item]))
        .unwrap_or_default()
}

fn upsert_session_parser_profile_from_text(
    session_parser_config_dir: &Path,
    raw: &str,
    fallback_id: &str,
) -> Result<SessionParserConfig, String> {
    let parsed = parse_session_parser_configs_from_text(raw);
    let mut config = parsed
        .into_iter()
        .next()
        .ok_or_else(|| "session parser JSON/YAML is invalid".to_string())?;
    if config.id.trim().is_empty() {
        config.id = normalize_native_scan_profile(fallback_id, DEFAULT_NATIVE_SCAN_PROFILE);
    }
    let normalized = normalize_session_parser_config(config)
        .ok_or_else(|| "session parser config is invalid after normalization".to_string())?;
    std::fs::create_dir_all(session_parser_config_dir)
        .map_err(|error| format!("failed to create session parser config dir: {}", error))?;
    let path = session_parser_config_dir.join(format!("{}.json", normalized.id));
    let payload = serde_json::to_string_pretty(&normalized)
        .map_err(|error| format!("failed to serialize session parser config: {}", error))?;
    std::fs::write(&path, payload)
        .map_err(|error| format!("failed to write session parser config {}: {}", path.to_string_lossy(), error))?;
    Ok(normalized)
}

fn shell_command_builder(cwd: Option<&Path>) -> CommandBuilder {
    #[cfg(target_os = "windows")]
    {
        let mut builder = CommandBuilder::new("powershell");
        builder.arg("-NoLogo");
        builder.arg("-NoExit");
        // Force UTF-8 in interactive PowerShell sessions to avoid mojibake.
        builder.arg("-Command");
        builder.arg(
            "[Console]::InputEncoding=[System.Text.UTF8Encoding]::new(); \
             [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); \
             $OutputEncoding=[Console]::OutputEncoding; \
             chcp 65001 > $null",
        );
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

const PANE_OUTPUT_BUFFER_MAX_BYTES: usize = 256 * 1024;
const STATUS_SESSION_DETECT_TIMEOUT_SECS: i64 = 6;
const STATUS_SESSION_DETECT_POLL_MS: u64 = 150;

fn sid_probe_profile(provider: &str) -> Option<SidProbeProfile> {
    match provider.trim().to_ascii_lowercase().as_str() {
        "codex" => Some(SidProbeProfile {
            probe_command: "/status",
            timeout_secs: STATUS_SESSION_DETECT_TIMEOUT_SECS,
            cleanup_input: None,
            labels: &["session:"],
        }),
        "claude" => Some(SidProbeProfile {
            probe_command: "/status",
            timeout_secs: STATUS_SESSION_DETECT_TIMEOUT_SECS,
            cleanup_input: Some("\u{1b}"),
            labels: &["session id:"],
        }),
        "gemini" => Some(SidProbeProfile {
            probe_command: "/stats session",
            timeout_secs: STATUS_SESSION_DETECT_TIMEOUT_SECS,
            cleanup_input: None,
            labels: &["session id:"],
        }),
        _ => None,
    }
}

fn trim_output_buffer_to_limit(text: &mut String) {
    if text.len() <= PANE_OUTPUT_BUFFER_MAX_BYTES {
        return;
    }
    let mut start = text.len().saturating_sub(PANE_OUTPUT_BUFFER_MAX_BYTES);
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    if start > 0 && start < text.len() {
        text.drain(..start);
    }
}

fn clear_pane_output_buffer(
    buffers: &Arc<Mutex<HashMap<String, PaneOutputBuffer>>>,
    pane_id: &str,
) {
    if let Ok(mut map) = buffers.lock() {
        map.insert(
            pane_id.to_string(),
            PaneOutputBuffer {
                revision: 0,
                text: String::new(),
                updated_at: now_epoch(),
            },
        );
    }
}

fn remove_pane_output_buffer(
    buffers: &Arc<Mutex<HashMap<String, PaneOutputBuffer>>>,
    pane_id: &str,
) {
    if let Ok(mut map) = buffers.lock() {
        map.remove(pane_id);
    }
}

fn append_pane_output_buffer(
    buffers: &Arc<Mutex<HashMap<String, PaneOutputBuffer>>>,
    pane_id: &str,
    raw: &str,
) {
    let sanitized = sanitize_log_text(raw);
    if sanitized.is_empty() {
        return;
    }
    if let Ok(mut map) = buffers.lock() {
        let entry = map.entry(pane_id.to_string()).or_default();
        entry.revision = entry.revision.saturating_add(1);
        entry.updated_at = now_epoch();
        entry.text.push_str(&sanitized);
        trim_output_buffer_to_limit(&mut entry.text);
    }
}

fn snapshot_pane_output_buffer(
    buffers: &Arc<Mutex<HashMap<String, PaneOutputBuffer>>>,
    pane_id: &str,
) -> (u64, String) {
    if let Ok(map) = buffers.lock() {
        if let Some(item) = map.get(pane_id) {
            return (item.revision, item.text.clone());
        }
    }
    (0, String::new())
}

fn extract_uuid_token(text: &str) -> Option<String> {
    let mut token = String::new();
    let mut found = None;
    for ch in text.chars() {
        if ch.is_ascii_hexdigit() || ch == '-' {
            token.push(ch);
            continue;
        }
        if let Ok(parsed) = Uuid::parse_str(token.trim()) {
            found = Some(parsed.to_string());
        }
        token.clear();
    }
    if let Ok(parsed) = Uuid::parse_str(token.trim()) {
        found = Some(parsed.to_string());
    }
    found
}

fn extract_session_id_from_labeled_text(text: &str, labels: &[&str]) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    for needle in labels {
        if let Some(position) = lower.rfind(needle) {
            let start = position + needle.len();
            let tail = text[start..].chars().take(160).collect::<String>();
            if let Some(session_id) = extract_uuid_token(&tail) {
                return Some(session_id);
            }
        }
    }
    None
}

fn extract_session_id_from_status_output(text: &str, labels: &[&str]) -> Option<String> {
    let normalized = sanitize_log_text(text);
    for line in normalized.lines().rev() {
        if let Some(session_id) = extract_session_id_from_labeled_text(line, labels) {
            return Some(session_id);
        }
    }
    extract_session_id_from_labeled_text(&normalized, labels)
}

fn detect_pane_session_id_via_status_inner(
    state: &AppState,
    pane_id: &str,
    provider: &str,
    timeout_secs_override: Option<i64>,
) -> Result<Option<String>, String> {
    let Some(profile) = sid_probe_profile(provider) else {
        return Ok(None);
    };
    let timeout = timeout_secs_override
        .unwrap_or(profile.timeout_secs)
        .clamp(1, 30);
    let (initial_revision, initial_text) = snapshot_pane_output_buffer(&state.pane_output_buffers, pane_id);
    let initial_len = initial_text.len();
    write_to_pane_internal(state, pane_id, &format!("{}\r", profile.probe_command), false)
        .map_err(|error| error.to_string())?;

    let started = std::time::Instant::now();
    let timeout_duration = std::time::Duration::from_secs(timeout as u64);
    let poll_duration = std::time::Duration::from_millis(STATUS_SESSION_DETECT_POLL_MS);
    loop {
        let (revision, text) = snapshot_pane_output_buffer(&state.pane_output_buffers, pane_id);
        if revision > initial_revision {
            let candidate_slice = if text.len() >= initial_len && text.is_char_boundary(initial_len) {
                &text[initial_len..]
            } else {
                text.as_str()
            };
            if let Some(session_id) = extract_session_id_from_status_output(candidate_slice, profile.labels) {
                if let Some(cleanup_input) = profile.cleanup_input {
                    let _ = write_to_pane_internal(state, pane_id, cleanup_input, false);
                }
                return Ok(Some(session_id));
            }
        }
        if started.elapsed() >= timeout_duration {
            if let Some(cleanup_input) = profile.cleanup_input {
                let _ = write_to_pane_internal(state, pane_id, cleanup_input, false);
            }
            return Ok(None);
        }
        std::thread::sleep(poll_duration);
    }
}

fn should_drop_codex_instruction_line(line: &str) -> bool {
    let normalized = line.trim().to_lowercase();
    if normalized.is_empty() {
        return true;
    }
    if normalized.starts_with("# agents.md instructions for ") {
        return true;
    }
    let exact_markers = [
        "<instructions>",
        "</instructions>",
        "<environment_context>",
        "</environment_context>",
        "<permissions instructions>",
        "</permissions instructions>",
        "<collaboration_mode>",
        "</collaboration_mode>",
    ];
    if exact_markers.iter().any(|item| *item == normalized) {
        return true;
    }
    let prefix_markers = [
        "<cwd>",
        "<shell>",
        "<current_date>",
        "<timezone>",
    ];
    prefix_markers.iter().any(|marker| normalized.starts_with(marker))
}

fn sanitize_codex_import_content(content: &str) -> String {
    let base = sanitize_log_text(content);
    if base.trim().is_empty() {
        return String::new();
    }
    let mut stripped = strip_tag_block(&base, "INSTRUCTIONS");
    stripped = strip_tag_block(&stripped, "environment_context");
    stripped = strip_tag_block(&stripped, "permissions");
    stripped = strip_tag_block(&stripped, "collaboration_mode");
    let cleaned = stripped
        .lines()
        .filter(|line| !should_drop_codex_instruction_line(line))
        .map(|line| line.trim_end())
        .collect::<Vec<_>>()
        .join("\n");
    cleaned.trim().to_string()
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

fn normalize_native_scan_profile(value: &str, fallback_provider: &str) -> String {
    let sanitize = |raw: &str| -> String {
        raw.trim()
            .to_lowercase()
            .chars()
            .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '_' || *ch == '-' || *ch == '.')
            .collect::<String>()
    };
    let normalized = sanitize(value);
    if !normalized.is_empty() {
        return normalized;
    }
    let fallback = sanitize(fallback_provider);
    if !fallback.is_empty() {
        return fallback;
    }
    DEFAULT_NATIVE_SCAN_PROFILE.to_string()
}

fn split_scan_glob_patterns(raw: &str) -> Vec<String> {
    let mut patterns = Vec::new();
    let mut token = String::new();
    let mut quote: Option<char> = None;
    let mut seen = HashSet::<String>::new();
    let mut push_token = |buffer: &mut String| {
        let normalized = buffer.trim();
        if !normalized.is_empty() && seen.insert(normalized.to_string()) {
            patterns.push(normalized.to_string());
        }
        buffer.clear();
    };
    for ch in raw.chars() {
        if let Some(mark) = quote {
            if ch == mark {
                quote = None;
            } else {
                token.push(ch);
            }
            continue;
        }
        match ch {
            '"' | '\'' => {
                quote = Some(ch);
            }
            ',' | ';' | '\n' | '\r' => {
                push_token(&mut token);
            }
            _ if ch.is_whitespace() => {
                push_token(&mut token);
            }
            _ => token.push(ch),
        }
    }
    push_token(&mut token);
    patterns
}

fn normalize_scan_glob(raw: &str) -> String {
    split_scan_glob_patterns(raw).join("\n")
}

fn wildcard_match(pattern: &str, text: &str) -> bool {
    let p = pattern.chars().collect::<Vec<_>>();
    let t = text.chars().collect::<Vec<_>>();
    let mut dp = vec![false; t.len() + 1];
    dp[0] = true;
    for ch in p {
        if ch == '*' {
            for index in 1..=t.len() {
                dp[index] = dp[index] || dp[index - 1];
            }
            continue;
        }
        for index in (1..=t.len()).rev() {
            dp[index] = dp[index - 1] && (ch == '?' || ch == t[index - 1]);
        }
        dp[0] = false;
    }
    dp[t.len()]
}

impl SessionFileMatcher {
    fn from_raw(raw: &str) -> Option<Self> {
        let mut patterns = Vec::new();
        for chunk in split_scan_glob_patterns(raw) {
            let normalized = expand_env_placeholders(&chunk).replace('\\', "/").to_lowercase();
            if normalized.is_empty() {
                continue;
            }
            patterns.push(normalized);
        }
        if patterns.is_empty() {
            None
        } else {
            Some(Self { patterns })
        }
    }

    fn cache_key_suffix(&self) -> String {
        self.patterns.join("|")
    }

    fn matches_path(&self, path: &Path) -> bool {
        let full = path.to_string_lossy().replace('\\', "/").to_lowercase();
        let file_name = path
            .file_name()
            .and_then(|item| item.to_str())
            .map(|item| item.to_lowercase())
            .unwrap_or_default();
        self.patterns.iter().any(|pattern| {
            wildcard_match(pattern, &full) || (!file_name.is_empty() && wildcard_match(pattern, &file_name))
        })
    }
}

fn build_native_scan_cache_key(provider: &str, matcher: Option<&SessionFileMatcher>) -> String {
    if let Some(filter) = matcher {
        return format!("{}::{}", provider, filter.cache_key_suffix());
    }
    provider.to_string()
}

fn build_native_preview_cache_key(
    provider: &str,
    matcher: Option<&SessionFileMatcher>,
    session_id: &str,
) -> String {
    format!("{}::preview::{}", build_native_scan_cache_key(provider, matcher), session_id.trim())
}

#[derive(Debug, Clone)]
enum JsonPathStep {
    Field(String),
    FieldAny(String),
    FieldIndex(String, usize),
    AnyIndex,
    Index(usize),
}

fn parse_json_path_steps(path: &str) -> Vec<JsonPathStep> {
    let mut steps = Vec::new();
    for raw_step in path
        .split('.')
        .map(|item| item.trim())
        .filter(|item| !item.is_empty())
    {
        if raw_step == "[]" || raw_step == "[*]" {
            steps.push(JsonPathStep::AnyIndex);
            continue;
        }
        if raw_step.starts_with('[') && raw_step.ends_with(']') {
            let inner = raw_step[1..raw_step.len() - 1].trim();
            if inner == "*" || inner.is_empty() {
                steps.push(JsonPathStep::AnyIndex);
            } else if let Ok(index) = inner.parse::<usize>() {
                steps.push(JsonPathStep::Index(index));
            }
            continue;
        }
        if let Some(open) = raw_step.find('[') {
            if raw_step.ends_with(']') {
                let field = raw_step[..open].trim();
                let inner = raw_step[open + 1..raw_step.len() - 1].trim();
                if field.is_empty() {
                    continue;
                }
                if inner == "*" || inner.is_empty() {
                    steps.push(JsonPathStep::FieldAny(field.to_string()));
                } else if let Ok(index) = inner.parse::<usize>() {
                    steps.push(JsonPathStep::FieldIndex(field.to_string(), index));
                }
                continue;
            }
        }
        steps.push(JsonPathStep::Field(raw_step.to_string()));
    }
    steps
}

fn extract_json_path_values(value: &serde_json::Value, path: &str) -> Vec<serde_json::Value> {
    let steps = parse_json_path_steps(path);
    if steps.is_empty() {
        return vec![value.clone()];
    }
    let mut current = vec![value.clone()];
    for step in steps {
        let mut next = Vec::new();
        for item in current {
            match &step {
                JsonPathStep::Field(name) => {
                    if let Some(found) = item.get(name) {
                        next.push(found.clone());
                    }
                }
                JsonPathStep::FieldAny(name) => {
                    if let Some(found) = item.get(name).and_then(|value| value.as_array()) {
                        next.extend(found.iter().cloned());
                    }
                }
                JsonPathStep::FieldIndex(name, index) => {
                    if let Some(found) = item
                        .get(name)
                        .and_then(|value| value.as_array())
                        .and_then(|list| list.get(*index))
                    {
                        next.push(found.clone());
                    }
                }
                JsonPathStep::AnyIndex => {
                    if let Some(list) = item.as_array() {
                        next.extend(list.iter().cloned());
                    }
                }
                JsonPathStep::Index(index) => {
                    if let Some(found) = item.as_array().and_then(|list| list.get(*index)) {
                        next.push(found.clone());
                    }
                }
            }
        }
        current = next;
        if current.is_empty() {
            break;
        }
    }
    current
}

fn json_value_to_string(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(text) => {
            let normalized = text.trim().to_string();
            if normalized.is_empty() {
                None
            } else {
                Some(normalized)
            }
        }
        serde_json::Value::Number(number) => Some(number.to_string()),
        serde_json::Value::Bool(flag) => Some(if *flag { "true" } else { "false" }.to_string()),
        _ => None,
    }
}

fn first_string_from_paths(value: &serde_json::Value, paths: &[String]) -> Option<String> {
    for path in paths {
        let values = extract_json_path_values(value, path);
        for item in values {
            if let Some(text) = json_value_to_string(&item) {
                return Some(text);
            }
        }
    }
    None
}

fn parse_epoch_seconds_loose(value: &serde_json::Value) -> Option<i64> {
    match value {
        serde_json::Value::Number(number) => {
            let raw = number.as_i64().or_else(|| number.as_u64().map(|item| item as i64))?;
            if raw > 10_000_000_000_i64 {
                Some(raw / 1000)
            } else {
                Some(raw)
            }
        }
        serde_json::Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                return None;
            }
            if let Ok(number) = trimmed.parse::<i64>() {
                if number > 10_000_000_000_i64 {
                    return Some(number / 1000);
                }
                return Some(number);
            }
            parse_rfc3339_epoch_seconds(trimmed)
        }
        _ => None,
    }
}

fn first_epoch_from_paths(value: &serde_json::Value, paths: &[String]) -> Option<i64> {
    for path in paths {
        let values = extract_json_path_values(value, path);
        for item in values {
            if let Some(epoch) = parse_epoch_seconds_loose(&item) {
                return Some(epoch);
            }
        }
    }
    None
}

fn value_matches_filter(value: &serde_json::Value, filter: &JsonFieldEqualsFilter) -> bool {
    let expected = filter.equals.trim();
    if expected.is_empty() {
        return false;
    }
    let values = extract_json_path_values(value, &filter.path);
    values.into_iter().any(|item| {
        json_value_to_string(&item)
            .map(|text| text.trim() == expected)
            .unwrap_or(false)
    })
}

fn all_filters_match(value: &serde_json::Value, filters: &[JsonFieldEqualsFilter]) -> bool {
    filters.iter().all(|filter| value_matches_filter(value, filter))
}

fn any_truthy_path(value: &serde_json::Value, paths: &[String]) -> bool {
    paths.iter().any(|path| {
        extract_json_path_values(value, path)
            .into_iter()
            .any(|item| match item {
                serde_json::Value::Bool(flag) => flag,
                serde_json::Value::Number(number) => number.as_i64().unwrap_or_default() != 0,
                serde_json::Value::String(text) => {
                    let normalized = text.trim().to_lowercase();
                    normalized == "true" || normalized == "1" || normalized == "yes"
                }
                _ => false,
            })
    })
}

fn collect_files_recursive(root: &Path, bucket: &mut Vec<PathBuf>) -> Result<()> {
    if !root.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        let meta = entry.metadata()?;
        if meta.is_dir() {
            collect_files_recursive(&path, bucket)?;
            continue;
        }
        if meta.is_file() {
            bucket.push(path);
        }
    }
    Ok(())
}

fn home_dir_guess() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        if let Ok(value) = std::env::var("USERPROFILE") {
            if !value.trim().is_empty() {
                return Some(PathBuf::from(value));
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(value) = std::env::var("HOME") {
            if !value.trim().is_empty() {
                return Some(PathBuf::from(value));
            }
        }
    }
    None
}

fn expand_env_placeholders(raw: &str) -> String {
    let mut expanded = raw.trim().to_string();
    if expanded.starts_with("~/") || expanded == "~" {
        if let Some(home) = home_dir_guess() {
            expanded = expanded.replacen('~', &home.to_string_lossy(), 1);
        }
    }
    if expanded.contains("$HOME") {
        if let Some(home) = home_dir_guess() {
            expanded = expanded.replace("$HOME", &home.to_string_lossy());
        }
    }
    if expanded.contains("$USERPROFILE") {
        if let Ok(user_profile) = std::env::var("USERPROFILE") {
            expanded = expanded.replace("$USERPROFILE", &user_profile);
        }
    }

    let mut cursor = 0_usize;
    while let Some(start_rel) = expanded[cursor..].find("${") {
        let start = cursor + start_rel;
        let tail = &expanded[start + 2..];
        let Some(end_rel) = tail.find('}') else {
            break;
        };
        let end = start + 2 + end_rel;
        let key = expanded[start + 2..end].trim();
        let replacement = std::env::var(key).unwrap_or_default();
        expanded.replace_range(start..=end, &replacement);
        cursor = start.saturating_add(replacement.len());
    }
    expanded
}

fn resolve_parser_source_root(raw: &str) -> Option<PathBuf> {
    let token = raw.trim();
    if token.is_empty() {
        return None;
    }
    match token {
        "$CODEX_SESSIONS" => return codex_sessions_dir(),
        "$CLAUDE_PROJECTS" => return claude_projects_dir(),
        "$GEMINI_TMP" => return gemini_sessions_root_dir(),
        _ => {}
    }
    let expanded = expand_env_placeholders(token);
    if expanded.trim().is_empty() {
        return None;
    }
    let mut path = PathBuf::from(expanded);
    if path.is_relative() {
        if let Ok(current) = std::env::current_dir() {
            path = current.join(path);
        }
    }
    Some(path)
}

fn resolve_parser_source_roots(parser: &SessionParserConfig) -> Vec<PathBuf> {
    let mut unique = HashSet::new();
    let mut paths = Vec::new();
    for root in &parser.source_roots {
        if let Some(path) = resolve_parser_source_root(root) {
            let key = path.to_string_lossy().to_string();
            if unique.insert(key) {
                paths.push(path);
            }
        }
    }
    paths
}

fn effective_session_file_matcher(
    parser: &SessionParserConfig,
    pane_matcher: Option<&SessionFileMatcher>,
) -> Option<SessionFileMatcher> {
    if let Some(custom) = pane_matcher {
        return Some(custom.clone());
    }
    SessionFileMatcher::from_raw(&parser.default_file_glob)
}

fn collect_parser_candidate_files(
    parser: &SessionParserConfig,
    pane_matcher: Option<&SessionFileMatcher>,
) -> Result<Vec<PathBuf>> {
    let roots = resolve_parser_source_roots(parser);
    if roots.is_empty() {
        return Ok(Vec::new());
    }
    let effective_matcher = effective_session_file_matcher(parser, pane_matcher);
    let mut files = Vec::new();
    for root in roots {
        collect_files_recursive(&root, &mut files)?;
    }
    if let Some(matcher) = effective_matcher.as_ref() {
        files.retain(|path| matcher.matches_path(path));
    }
    files.sort_by(|left, right| left.to_string_lossy().cmp(&right.to_string_lossy()));
    Ok(files)
}

fn extract_content_texts(value: &serde_json::Value, paths: &[String]) -> Vec<String> {
    let mut output = Vec::new();
    for path in paths {
        let values = if path.trim().is_empty() {
            vec![value.clone()]
        } else {
            extract_json_path_values(value, path)
        };
        for item in values {
            let text = text_from_json_value(&item);
            if text.trim().is_empty() {
                continue;
            }
            output.push(text);
        }
    }
    output
}

fn parse_message_rows_with_rule(
    parser: &SessionParserConfig,
    rule: &SessionParserMessageRule,
    message_value: &serde_json::Value,
    root_value: &serde_json::Value,
    file_session_id: Option<&str>,
    target_session_id: Option<&str>,
    fallback_timestamp: i64,
    line_no: i64,
) -> Vec<ParsedMessageRow> {
    if !all_filters_match(message_value, &rule.filters) {
        return Vec::new();
    }
    if any_truthy_path(message_value, &rule.ignore_true_paths) {
        return Vec::new();
    }
    let role = first_string_from_paths(message_value, &[rule.role_path.clone()])
        .unwrap_or_default()
        .to_lowercase();
    if role.is_empty() {
        return Vec::new();
    }
    let kind = match rule.role_map.get(&role) {
        Some(kind) => kind.clone(),
        None => return Vec::new(),
    };

    let mut session_id = first_string_from_paths(message_value, &rule.session_id_paths)
        .or_else(|| first_string_from_paths(root_value, &rule.session_id_paths))
        .unwrap_or_else(|| file_session_id.unwrap_or_default().to_string());
    if session_id.is_empty() {
        if let Some(target) = target_session_id {
            session_id = target.to_string();
        }
    }
    if let Some(target) = target_session_id {
        if !session_id.is_empty() && session_id != target {
            return Vec::new();
        }
    }

    let items = if rule.content_item_path.trim().is_empty() {
        vec![message_value.clone()]
    } else {
        extract_json_path_values(message_value, &rule.content_item_path)
    };
    if items.is_empty() {
        return Vec::new();
    }

    let expected_content_type = rule
        .content_item_filter_by_role
        .get(&role)
        .cloned()
        .or_else(|| rule.content_item_filter_by_role.get(&kind).cloned());

    let created_at = first_epoch_from_paths(message_value, &rule.timestamp_paths)
        .or_else(|| first_epoch_from_paths(root_value, &rule.timestamp_paths))
        .unwrap_or(fallback_timestamp);

    let mut rows = Vec::new();
    for (item_index, item) in items.into_iter().enumerate() {
        if let Some(expected_type) = expected_content_type.as_ref() {
            if !rule.content_item_filter_path.trim().is_empty() {
                let actual = first_string_from_paths(&item, &[rule.content_item_filter_path.clone()])
                    .unwrap_or_default();
                if actual != *expected_type {
                    continue;
                }
            }
        }

        let texts = extract_content_texts(&item, &rule.content_text_paths);
        for (text_index, raw_text) in texts.into_iter().enumerate() {
            let sanitized = if parser.strip_codex_tags {
                sanitize_codex_import_content(&raw_text)
            } else {
                sanitize_log_text(&raw_text)
            };
            if sanitized.trim().is_empty() {
                continue;
            }
            rows.push(ParsedMessageRow {
                session_id: session_id.clone(),
                kind: kind.clone(),
                content: sanitized,
                created_at,
                line_no,
                role: role.clone(),
                content_index: item_index.saturating_mul(1000).saturating_add(text_index),
            });
        }
    }
    rows
}

fn parser_uses_line_script(parser: &SessionParserConfig) -> bool {
    !parser.line_parser_script.trim().is_empty()
}

struct LineScriptRuntime {
    engine: Engine,
    ast: AST,
    function_name: String,
}

fn build_line_script_runtime(parser: &SessionParserConfig) -> Result<LineScriptRuntime, String> {
    let script = parser.line_parser_script.trim();
    if script.is_empty() {
        return Err("line parser script is empty".to_string());
    }
    let mut engine = Engine::new();
    engine.set_max_call_levels(32);
    engine.set_max_expr_depths(64, 64);
    engine.set_max_operations(200_000);
    let ast = engine
        .compile(script)
        .map_err(|error| format!("failed to compile line parser script: {}", error))?;
    let function_name = if parser.line_parser_function.trim().is_empty() {
        "parse_line".to_string()
    } else {
        parser.line_parser_function.trim().to_string()
    };
    Ok(LineScriptRuntime {
        engine,
        ast,
        function_name,
    })
}

fn script_value_to_non_empty_string(value: Option<&serde_json::Value>) -> Option<String> {
    value.and_then(json_value_to_string).map(|text| text.trim().to_string()).filter(|text| !text.is_empty())
}

fn normalize_script_kind(raw_kind: &str, raw_role: &str) -> Option<String> {
    let kind = raw_kind.trim().to_lowercase();
    if kind == "input" || kind == "output" {
        return Some(kind);
    }
    let role = raw_role.trim().to_lowercase();
    if role == "user" {
        return Some("input".to_string());
    }
    if role == "assistant" || role == "gemini" || role == "model" {
        return Some("output".to_string());
    }
    None
}

fn parse_script_row_from_object(
    parser: &SessionParserConfig,
    row_object: &serde_json::Map<String, serde_json::Value>,
    fallback_session_id: &str,
    fallback_timestamp: i64,
    line_no: i64,
    content_index: usize,
    target_session_id: Option<&str>,
) -> Option<ParsedMessageRow> {
    let role = script_value_to_non_empty_string(row_object.get("role"))
        .unwrap_or_default()
        .to_lowercase();
    let raw_kind = script_value_to_non_empty_string(row_object.get("kind"))
        .unwrap_or_default()
        .to_lowercase();
    let kind = normalize_script_kind(&raw_kind, &role)?;
    let raw_content = script_value_to_non_empty_string(row_object.get("content"))?;
    let mut session_id = script_value_to_non_empty_string(row_object.get("session_id"))
        .unwrap_or_else(|| fallback_session_id.to_string());
    if session_id.trim().is_empty() {
        if let Some(target) = target_session_id {
            session_id = target.to_string();
        }
    }
    if let Some(target) = target_session_id {
        if !session_id.trim().is_empty() && session_id != target {
            return None;
        }
    }
    let created_at = row_object
        .get("created_at")
        .and_then(parse_epoch_seconds_loose)
        .or_else(|| row_object.get("timestamp").and_then(parse_epoch_seconds_loose))
        .unwrap_or(fallback_timestamp);
    let content = if parser.strip_codex_tags {
        sanitize_codex_import_content(&raw_content)
    } else {
        sanitize_log_text(&raw_content)
    };
    if content.trim().is_empty() {
        return None;
    }
    Some(ParsedMessageRow {
        session_id,
        kind: kind.clone(),
        content,
        created_at,
        line_no,
        role: if role.is_empty() {
            if kind == "input" {
                "user".to_string()
            } else {
                "assistant".to_string()
            }
        } else {
            role
        },
        content_index,
    })
}

fn parse_script_output_rows(
    parser: &SessionParserConfig,
    output_value: &serde_json::Value,
    fallback_session_id: &str,
    fallback_timestamp: i64,
    line_no: i64,
    target_session_id: Option<&str>,
) -> (Option<String>, Option<i64>, Vec<ParsedMessageRow>) {
    let mut top_session_id = None;
    let mut top_started_at = None;
    let mut rows = Vec::<ParsedMessageRow>::new();
    let mut next_index = 0_usize;

    let parse_row_value = |value: &serde_json::Value,
                           parser: &SessionParserConfig,
                           fallback_session_id: &str,
                           fallback_timestamp: i64,
                           line_no: i64,
                           content_index: usize,
                           target_session_id: Option<&str>| {
        value
            .as_object()
            .and_then(|item| {
                parse_script_row_from_object(
                    parser,
                    item,
                    fallback_session_id,
                    fallback_timestamp,
                    line_no,
                    content_index,
                    target_session_id,
                )
            })
    };

    match output_value {
        serde_json::Value::Object(object) => {
            top_session_id = script_value_to_non_empty_string(object.get("session_id"));
            top_started_at = object
                .get("started_at")
                .and_then(parse_epoch_seconds_loose)
                .or_else(|| object.get("timestamp").and_then(parse_epoch_seconds_loose));
            if let Some(row_values) = object.get("rows").and_then(|item| item.as_array()) {
                let fallback_sid = top_session_id
                    .as_deref()
                    .unwrap_or(fallback_session_id)
                    .to_string();
                for row_value in row_values {
                    if let Some(row) = parse_row_value(
                        row_value,
                        parser,
                        &fallback_sid,
                        top_started_at.unwrap_or(fallback_timestamp),
                        line_no,
                        next_index,
                        target_session_id,
                    ) {
                        next_index = next_index.saturating_add(1);
                        rows.push(row);
                    }
                }
            } else if let Some(row) = parse_row_value(
                output_value,
                parser,
                top_session_id.as_deref().unwrap_or(fallback_session_id),
                top_started_at.unwrap_or(fallback_timestamp),
                line_no,
                next_index,
                target_session_id,
            ) {
                rows.push(row);
            }
        }
        serde_json::Value::Array(list) => {
            for item in list {
                if let Some(row) = parse_row_value(
                    item,
                    parser,
                    fallback_session_id,
                    fallback_timestamp,
                    line_no,
                    next_index,
                    target_session_id,
                ) {
                    next_index = next_index.saturating_add(1);
                    rows.push(row);
                }
            }
        }
        _ => {}
    }

    (top_session_id, top_started_at, rows)
}

fn apply_script_parse_result(
    output: &mut ParsedSessionFile,
    session_id: Option<String>,
    started_at: Option<i64>,
    rows: &[ParsedMessageRow],
) {
    if output.session_id.is_none() {
        if let Some(sid) = session_id
            .as_deref()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
        {
            output.session_id = Some(sid);
        } else if let Some(found) = rows.iter().find_map(|item| {
            let sid = item.session_id.trim();
            if sid.is_empty() {
                None
            } else {
                Some(sid.to_string())
            }
        }) {
            output.session_id = Some(found);
        }
    }
    if output.started_at <= 0 {
        if let Some(value) = started_at.filter(|value| *value > 0) {
            output.started_at = value;
        } else if let Some(value) = rows.iter().map(|item| item.created_at).find(|value| *value > 0) {
            output.started_at = value;
        }
    }
}

fn invoke_line_parser_script(
    runtime: &LineScriptRuntime,
    parser: &SessionParserConfig,
    path: &Path,
    line_value: &serde_json::Value,
    mtime: i64,
    line_no: i64,
    current_session_id: Option<&str>,
    target_session_id: Option<&str>,
    fallback_timestamp: i64,
) -> Result<(Option<String>, Option<i64>, Vec<ParsedMessageRow>), String> {
    let line_dynamic = rhai::serde::to_dynamic(line_value)
        .map_err(|error| format!("failed to convert line value for script: {}", error))?;
    let ctx_json = serde_json::json!({
        "provider": parser.id,
        "file_path": path.to_string_lossy().to_string(),
        "file_name": path.file_name().and_then(|value| value.to_str()).unwrap_or_default().to_string(),
        "file_format": parser.file_format,
        "mtime": mtime,
        "line_no": line_no,
        "current_session_id": current_session_id.unwrap_or_default().to_string(),
        "target_session_id": target_session_id.unwrap_or_default().to_string(),
        "fallback_timestamp": fallback_timestamp
    });
    let ctx_dynamic = rhai::serde::to_dynamic(&ctx_json)
        .map_err(|error| format!("failed to convert script context: {}", error))?;
    let mut scope = Scope::new();
    let dynamic_result = runtime
        .engine
        .call_fn::<Dynamic>(
            &mut scope,
            &runtime.ast,
            &runtime.function_name,
            (line_dynamic, ctx_dynamic),
        )
        .map_err(|error| format!("line parser function {} failed: {}", runtime.function_name, error))?;
    let output_value: serde_json::Value = rhai::serde::from_dynamic(&dynamic_result)
        .map_err(|error| format!("failed to decode script output JSON: {}", error))?;
    Ok(parse_script_output_rows(
        parser,
        &output_value,
        current_session_id.unwrap_or_default(),
        fallback_timestamp,
        line_no,
        target_session_id,
    ))
}

fn append_parsed_rows_with_limit(
    output: &mut ParsedSessionFile,
    rows: &mut Vec<ParsedMessageRow>,
    max_rows: Option<usize>,
) -> bool {
    if let Some(limit) = max_rows {
        if limit == 0 || output.rows.len() >= limit {
            output.truncated = true;
            return true;
        }
        let remaining = limit.saturating_sub(output.rows.len());
        if rows.len() > remaining {
            rows.truncate(remaining);
            output.rows.append(rows);
            output.truncated = true;
            return true;
        }
    }
    output.rows.append(rows);
    false
}

fn parse_jsonl_session_file_with_script(
    parser: &SessionParserConfig,
    path: &Path,
    mtime: i64,
    target_session_id: Option<&str>,
    max_rows: Option<usize>,
) -> ParsedSessionFile {
    let mut output = ParsedSessionFile::default();
    let runtime = match build_line_script_runtime(parser) {
        Ok(runtime) => runtime,
        Err(_) => {
            output.parse_errors = 1;
            return output;
        }
    };
    let file = match File::open(path) {
        Ok(file) => file,
        Err(_) => {
            output.parse_errors = 1;
            return output;
        }
    };
    let reader = BufReader::new(file);
    'line_loop: for (line_index, row) in reader.lines().enumerate() {
        output.scanned_units += 1;
        let line_no = (line_index + 1) as i64;
        let line = match row {
            Ok(line) => line,
            Err(_) => {
                output.parse_errors += 1;
                continue;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let value = match serde_json::from_str::<serde_json::Value>(&line) {
            Ok(value) => value,
            Err(_) => {
                output.parse_errors += 1;
                continue;
            }
        };
        let fallback_timestamp = first_epoch_from_paths(&value, &parser.fallback_timestamp_paths)
            .or_else(|| first_epoch_from_paths(&value, &parser.started_at_paths))
            .unwrap_or(mtime);
        match invoke_line_parser_script(
            &runtime,
            parser,
            path,
            &value,
            mtime,
            line_no,
            output.session_id.as_deref(),
            target_session_id,
            fallback_timestamp,
        ) {
            Ok((session_id, started_at, mut rows)) => {
                apply_script_parse_result(&mut output, session_id, started_at, &rows);
                if append_parsed_rows_with_limit(&mut output, &mut rows, max_rows) {
                    break 'line_loop;
                }
            }
            Err(_) => {
                output.parse_errors += 1;
            }
        }
    }
    if output.started_at <= 0 {
        output.started_at = output
            .rows
            .iter()
            .map(|item| item.created_at)
            .find(|item| *item > 0)
            .unwrap_or_default();
    }
    output
}

fn parse_json_session_file_with_script(
    parser: &SessionParserConfig,
    path: &Path,
    mtime: i64,
    target_session_id: Option<&str>,
    max_rows: Option<usize>,
) -> ParsedSessionFile {
    let mut output = ParsedSessionFile::default();
    let runtime = match build_line_script_runtime(parser) {
        Ok(runtime) => runtime,
        Err(_) => {
            output.parse_errors = 1;
            return output;
        }
    };
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(_) => {
            output.parse_errors = 1;
            return output;
        }
    };
    let value = match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(value) => value,
        Err(_) => {
            output.parse_errors = 1;
            return output;
        }
    };
    let roots = if parser.message_source_path.trim().is_empty() {
        vec![value.clone()]
    } else {
        let values = extract_json_path_values(&value, &parser.message_source_path);
        if values.is_empty() {
            vec![value.clone()]
        } else {
            values
        }
    };
    output.scanned_units = roots.len() as i64;
    let root_fallback_timestamp = first_epoch_from_paths(&value, &parser.fallback_timestamp_paths)
        .or_else(|| first_epoch_from_paths(&value, &parser.started_at_paths))
        .unwrap_or(mtime);
    'root_loop: for (index, root) in roots.into_iter().enumerate() {
        let line_no = (index + 1) as i64;
        let fallback_timestamp = first_epoch_from_paths(&root, &parser.fallback_timestamp_paths)
            .or_else(|| first_epoch_from_paths(&root, &parser.started_at_paths))
            .unwrap_or(root_fallback_timestamp);
        match invoke_line_parser_script(
            &runtime,
            parser,
            path,
            &root,
            mtime,
            line_no,
            output.session_id.as_deref(),
            target_session_id,
            fallback_timestamp,
        ) {
            Ok((session_id, started_at, mut rows)) => {
                apply_script_parse_result(&mut output, session_id, started_at, &rows);
                if append_parsed_rows_with_limit(&mut output, &mut rows, max_rows) {
                    break 'root_loop;
                }
            }
            Err(_) => {
                output.parse_errors += 1;
            }
        }
    }
    if output.started_at <= 0 {
        output.started_at = output
            .rows
            .iter()
            .map(|item| item.created_at)
            .find(|item| *item > 0)
            .unwrap_or_default();
    }
    output
}

fn parse_jsonl_session_file(
    parser: &SessionParserConfig,
    path: &Path,
    mtime: i64,
    target_session_id: Option<&str>,
    max_rows: Option<usize>,
) -> ParsedSessionFile {
    if parser_uses_line_script(parser) {
        return parse_jsonl_session_file_with_script(parser, path, mtime, target_session_id, max_rows);
    }
    let mut output = ParsedSessionFile::default();
    let file = match File::open(path) {
        Ok(file) => file,
        Err(_) => {
            output.parse_errors = 1;
            return output;
        }
    };
    let reader = BufReader::new(file);
    let max_meta_lines = parser.session_meta_scan_max_lines.max(0);

    'line_loop: for (line_index, row) in reader.lines().enumerate() {
        output.scanned_units += 1;
        let line_no = (line_index + 1) as i64;
        let line = match row {
            Ok(line) => line,
            Err(_) => {
                output.parse_errors += 1;
                continue;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let value = match serde_json::from_str::<serde_json::Value>(&line) {
            Ok(value) => value,
            Err(_) => {
                output.parse_errors += 1;
                continue;
            }
        };

        if output.session_id.is_none() || output.started_at <= 0 {
            let should_scan_meta = max_meta_lines == 0 || (line_index as i64) < max_meta_lines;
            if should_scan_meta
                && (parser.session_meta_filters.is_empty()
                    || all_filters_match(&value, &parser.session_meta_filters))
            {
                if output.session_id.is_none() {
                    output.session_id = first_string_from_paths(&value, &parser.session_id_paths);
                }
                if output.started_at <= 0 {
                    output.started_at =
                        first_epoch_from_paths(&value, &parser.started_at_paths).unwrap_or_default();
                }
            }
        }

        let fallback_timestamp = first_epoch_from_paths(&value, &parser.fallback_timestamp_paths)
            .or_else(|| first_epoch_from_paths(&value, &parser.started_at_paths))
            .unwrap_or(mtime);
        let message_roots = if parser.message_source_path.trim().is_empty() {
            vec![value.clone()]
        } else {
            extract_json_path_values(&value, &parser.message_source_path)
        };
        for message_value in message_roots {
            for rule in &parser.message_rules {
                let mut rows = parse_message_rows_with_rule(
                    parser,
                    rule,
                    &message_value,
                    &value,
                    output.session_id.as_deref(),
                    target_session_id,
                    fallback_timestamp,
                    line_no,
                );
                if output.session_id.is_none() {
                    if let Some(found) = rows
                        .iter()
                        .find_map(|item| {
                            let sid = item.session_id.trim();
                            if sid.is_empty() {
                                None
                            } else {
                                Some(sid.to_string())
                            }
                        })
                    {
                        output.session_id = Some(found);
                    }
                }
                if append_parsed_rows_with_limit(&mut output, &mut rows, max_rows) {
                    break 'line_loop;
                }
            }
        }
    }

    if output.started_at <= 0 {
        output.started_at = output
            .rows
            .iter()
            .map(|item| item.created_at)
            .find(|item| *item > 0)
            .unwrap_or_default();
    }
    output
}

fn parse_json_session_file(
    parser: &SessionParserConfig,
    path: &Path,
    mtime: i64,
    target_session_id: Option<&str>,
    max_rows: Option<usize>,
) -> ParsedSessionFile {
    if parser_uses_line_script(parser) {
        return parse_json_session_file_with_script(parser, path, mtime, target_session_id, max_rows);
    }
    let mut output = ParsedSessionFile::default();
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(_) => {
            output.parse_errors = 1;
            return output;
        }
    };
    let value = match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(value) => value,
        Err(_) => {
            output.parse_errors = 1;
            return output;
        }
    };
    output.scanned_units = 1;
    if parser.session_meta_filters.is_empty() || all_filters_match(&value, &parser.session_meta_filters) {
        output.session_id = first_string_from_paths(&value, &parser.session_id_paths);
        output.started_at = first_epoch_from_paths(&value, &parser.started_at_paths).unwrap_or_default();
    }
    let fallback_timestamp = first_epoch_from_paths(&value, &parser.fallback_timestamp_paths)
        .or_else(|| first_epoch_from_paths(&value, &parser.started_at_paths))
        .unwrap_or(mtime);
    let message_roots = if parser.message_source_path.trim().is_empty() {
        vec![value.clone()]
    } else {
        extract_json_path_values(&value, &parser.message_source_path)
    };

    'message_loop: for (index, message_value) in message_roots.into_iter().enumerate() {
        let line_no = (index + 1) as i64;
        for rule in &parser.message_rules {
            let mut rows = parse_message_rows_with_rule(
                parser,
                rule,
                &message_value,
                &value,
                output.session_id.as_deref(),
                target_session_id,
                fallback_timestamp,
                line_no,
            );
            if output.session_id.is_none() {
                if let Some(found) = rows
                    .iter()
                    .find_map(|item| {
                        let sid = item.session_id.trim();
                        if sid.is_empty() {
                            None
                        } else {
                            Some(sid.to_string())
                        }
                    })
                {
                    output.session_id = Some(found);
                }
            }
            if append_parsed_rows_with_limit(&mut output, &mut rows, max_rows) {
                break 'message_loop;
            }
        }
    }
    if output.started_at <= 0 {
        output.started_at = output
            .rows
            .iter()
            .map(|item| item.created_at)
            .find(|item| *item > 0)
            .unwrap_or_default();
    }
    output
}

fn parse_session_file(
    parser: &SessionParserConfig,
    path: &Path,
    target_session_id: Option<&str>,
    max_rows: Option<usize>,
) -> ParsedSessionFile {
    let mtime = file_mtime_epoch(path);
    if parser.file_format == "json" {
        parse_json_session_file(parser, path, mtime, target_session_id, max_rows)
    } else {
        parse_jsonl_session_file(parser, path, mtime, target_session_id, max_rows)
    }
}

fn generic_file_time_key(path: &Path, started_at: i64, mtime: i64) -> i64 {
    let codex_key = parse_rollout_file_time_key(path);
    if codex_key > 0 {
        return codex_key;
    }
    let gemini_key = parse_gemini_file_time_key(path);
    if gemini_key > 0 {
        return gemini_key;
    }
    if started_at > 0 {
        started_at
    } else {
        mtime
    }
}

fn classify_unrecognized_file_reason(parsed: &ParsedSessionFile) -> String {
    if parsed.parse_errors > 0 && parsed.rows.is_empty() {
        return "parse_error".to_string();
    }
    if parsed.rows.is_empty() {
        return "no_messages".to_string();
    }
    "missing_session_id".to_string()
}

fn read_file_preview_text(path: &Path, max_bytes: usize, max_chars: usize) -> String {
    let mut buffer = Vec::<u8>::new();
    let file = match File::open(path) {
        Ok(file) => file,
        Err(_) => return String::new(),
    };
    let mut reader = BufReader::new(file);
    if reader
        .by_ref()
        .take(max_bytes as u64)
        .read_to_end(&mut buffer)
        .is_err()
    {
        return String::new();
    }
    let mut text = String::from_utf8_lossy(&buffer).to_string();
    if text.chars().count() > max_chars {
        text = text.chars().take(max_chars).collect::<String>();
    }
    sanitize_log_text(&text)
}

fn read_first_json_value_from_file(path: &Path, file_format: &str) -> Result<serde_json::Value> {
    if file_format == "json" {
        let raw = std::fs::read_to_string(path)
            .with_context(|| format!("failed to read file {}", path.to_string_lossy()))?;
        let value = serde_json::from_str::<serde_json::Value>(&raw)
            .with_context(|| format!("failed to parse json file {}", path.to_string_lossy()))?;
        return Ok(value);
    }

    let file = File::open(path).with_context(|| format!("failed to open file {}", path.to_string_lossy()))?;
    let reader = BufReader::new(file);
    for row in reader.lines().take(4096) {
        let line = row.with_context(|| format!("failed to read line {}", path.to_string_lossy()))?;
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
            return Ok(value);
        }
    }
    Err(anyhow!(
        "no valid json sample found in first {} lines: {}",
        4096,
        path.to_string_lossy()
    ))
}

fn extract_first_message_sample_from_root(
    parser: &SessionParserConfig,
    root_value: &serde_json::Value,
    file_session_id: Option<&str>,
    fallback_timestamp: i64,
    line_no: i64,
) -> Option<serde_json::Value> {
    let message_roots = if parser.message_source_path.trim().is_empty() {
        vec![root_value.clone()]
    } else {
        extract_json_path_values(root_value, &parser.message_source_path)
    };

    for message_value in message_roots {
        for rule in &parser.message_rules {
            let rows = parse_message_rows_with_rule(
                parser,
                rule,
                &message_value,
                root_value,
                file_session_id,
                None,
                fallback_timestamp,
                line_no,
            );
            if !rows.is_empty() {
                return Some(message_value);
            }
        }
    }

    None
}

fn read_first_message_sample_value_from_file(
    parser: &SessionParserConfig,
    path: &Path,
) -> Result<Option<serde_json::Value>> {
    let mtime = path
        .metadata()
        .ok()
        .and_then(|meta| meta.modified().ok())
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_else(now_epoch);

    if parser.file_format == "json" {
        let raw = std::fs::read_to_string(path)
            .with_context(|| format!("failed to read file {}", path.to_string_lossy()))?;
        let value = serde_json::from_str::<serde_json::Value>(&raw)
            .with_context(|| format!("failed to parse json file {}", path.to_string_lossy()))?;
        let file_session_id = first_string_from_paths(&value, &parser.session_id_paths);
        let fallback_timestamp = first_epoch_from_paths(&value, &parser.fallback_timestamp_paths)
            .or_else(|| first_epoch_from_paths(&value, &parser.started_at_paths))
            .unwrap_or(mtime);
        return Ok(extract_first_message_sample_from_root(
            parser,
            &value,
            file_session_id.as_deref(),
            fallback_timestamp,
            1,
        ));
    }

    let file = File::open(path)
        .with_context(|| format!("failed to open file {}", path.to_string_lossy()))?;
    let reader = BufReader::new(file);
    let max_meta_lines = parser.session_meta_scan_max_lines.max(0);
    let mut file_session_id: Option<String> = None;

    for (line_index, row) in reader.lines().take(4096).enumerate() {
        let line_no = (line_index + 1) as i64;
        let line = row.with_context(|| format!("failed to read line {}", path.to_string_lossy()))?;
        if line.trim().is_empty() {
            continue;
        }
        let value = match serde_json::from_str::<serde_json::Value>(&line) {
            Ok(value) => value,
            Err(_) => continue,
        };

        if file_session_id.is_none() {
            let should_scan_meta = max_meta_lines == 0 || (line_index as i64) < max_meta_lines;
            if should_scan_meta
                && (parser.session_meta_filters.is_empty()
                    || all_filters_match(&value, &parser.session_meta_filters))
            {
                file_session_id = first_string_from_paths(&value, &parser.session_id_paths);
            }
        }

        let fallback_timestamp = first_epoch_from_paths(&value, &parser.fallback_timestamp_paths)
            .or_else(|| first_epoch_from_paths(&value, &parser.started_at_paths))
            .unwrap_or(mtime);
        if let Some(sample) = extract_first_message_sample_from_root(
            parser,
            &value,
            file_session_id.as_deref(),
            fallback_timestamp,
            line_no,
        ) {
            return Ok(Some(sample));
        }
    }

    Ok(None)
}

fn resolve_session_parser_for_preview(
    state: &AppState,
    parser_profile: &str,
    parser_config_text: Option<&str>,
) -> Result<SessionParserConfig> {
    if let Some(raw) = parser_config_text.map(|item| item.trim()).filter(|item| !item.is_empty()) {
        if let Some(config) = parse_session_parser_configs_from_text(raw)
            .into_iter()
            .next()
            .and_then(normalize_session_parser_config)
        {
            return Ok(config);
        }
    }
    resolve_session_parser_profile(&state.session_parser_config_dir, parser_profile)
        .ok_or_else(|| anyhow!("session parser profile not found: {}", parser_profile))
}

fn collect_parser_metas_indexed(
    state: &AppState,
    parser: &SessionParserConfig,
    matcher: Option<&SessionFileMatcher>,
) -> Result<ParserMetaIndexResult> {
    let files = collect_parser_candidate_files(parser, matcher)?;
    let skip_stale_cleanup = matcher.is_some();
    let total_files = files.len() as i64;
    let mut processed_files = 0_i64;
    let mut changed_files = 0_i64;
    set_native_session_index_progress(
        state,
        &parser.id,
        true,
        total_files,
        processed_files,
        changed_files,
    );

    let connection = match open_db(&state.db_path) {
        Ok(connection) => connection,
        Err(error) => {
            set_native_session_index_progress(
                state,
                &parser.id,
                false,
                total_files,
                processed_files,
                changed_files,
            );
            return Err(error);
        }
    };
    let mut indexed = match load_native_session_file_index_rows(&connection, &parser.id) {
        Ok(rows) => rows,
        Err(error) => {
            set_native_session_index_progress(
                state,
                &parser.id,
                false,
                total_files,
                processed_files,
                changed_files,
            );
            return Err(error);
        }
    };
    let mut seen_paths = HashSet::<String>::new();
    let mut metas = Vec::new();
    let mut unrecognized_files = Vec::<NativeSessionUnrecognizedFile>::new();

    for file_path in files {
        processed_files += 1;
        let file_path_string = file_path.to_string_lossy().to_string();
        seen_paths.insert(file_path_string.clone());
        let mtime = file_mtime_epoch(&file_path);

        if let Some(cached) = indexed.get(&file_path_string) {
            let has_preview = cached.record_count <= 0 || !cached.first_input.trim().is_empty();
            if cached.mtime == mtime && !cached.session_id.trim().is_empty() && has_preview {
                metas.push(GenericSessionMeta {
                    file_path,
                    session_id: cached.session_id.clone(),
                    started_at: cached.started_at,
                    file_time_key: cached.file_time_key,
                    mtime: cached.mtime,
                    record_count: cached.record_count,
                    first_input: cached.first_input.clone(),
                });
                if processed_files % 8 == 0 || processed_files >= total_files {
                    set_native_session_index_progress(
                        state,
                        &parser.id,
                        true,
                        total_files,
                        processed_files,
                        changed_files,
                    );
                }
                continue;
            }
        }

        let parsed = parse_session_file(parser, &file_path, None, None);
        if let Some(session_id) = parsed
            .session_id
            .as_ref()
            .map(|item| item.trim().to_string())
            .filter(|item| !item.is_empty())
        {
            let started_at = if parsed.started_at > 0 { parsed.started_at } else { mtime };
            let file_time_key = generic_file_time_key(&file_path, started_at, mtime);
            let first_input = first_input_preview_from_parsed_rows(&parsed.rows);
            let row = NativeSessionFileIndexRow {
                session_id: session_id.clone(),
                started_at,
                file_time_key,
                mtime,
                record_count: parsed.rows.len() as i64,
                first_input: first_input.clone(),
            };
            if let Err(error) =
                upsert_native_session_file_index_row(&connection, &parser.id, &file_path_string, &row)
            {
                set_native_session_index_progress(
                    state,
                    &parser.id,
                    false,
                    total_files,
                    processed_files,
                    changed_files,
                );
                return Err(error);
            }
            indexed.insert(file_path_string.clone(), row.clone());
            changed_files += 1;
            metas.push(GenericSessionMeta {
                file_path,
                session_id,
                started_at,
                file_time_key,
                mtime,
                record_count: row.record_count,
                first_input,
            });
        } else {
            let _ = delete_native_session_file_index_row(&connection, &parser.id, &file_path_string);
            if indexed.remove(&file_path_string).is_some() {
                changed_files += 1;
            }
            unrecognized_files.push(NativeSessionUnrecognizedFile {
                file_path: file_path_string,
                reason: classify_unrecognized_file_reason(&parsed),
                parse_errors: parsed.parse_errors,
                scanned_units: parsed.scanned_units,
                row_count: parsed.rows.len() as i64,
                modified_at: mtime,
            });
        }
        if processed_files % 8 == 0 || processed_files >= total_files {
            set_native_session_index_progress(
                state,
                &parser.id,
                true,
                total_files,
                processed_files,
                changed_files,
            );
        }
    }

    if !skip_stale_cleanup {
        for stale_path in indexed
            .keys()
            .filter(|path| !seen_paths.contains(*path))
            .cloned()
            .collect::<Vec<_>>()
        {
            let _ = delete_native_session_file_index_row(&connection, &parser.id, &stale_path);
            changed_files += 1;
        }
    }

    set_native_session_index_progress(
        state,
        &parser.id,
        false,
        total_files,
        processed_files,
        changed_files,
    );
    if session_debug_enabled() {
        let mut reason_counts = HashMap::<String, usize>::new();
        for item in &unrecognized_files {
            *reason_counts.entry(item.reason.clone()).or_insert(0) += 1;
        }
        let reason_text = if reason_counts.is_empty() {
            "none".to_string()
        } else {
            let mut pairs = reason_counts
                .into_iter()
                .map(|(reason, count)| format!("{}={}", reason, count))
                .collect::<Vec<_>>();
            pairs.sort();
            pairs.join(", ")
        };
        let matcher_text = matcher
            .map(|value| value.cache_key_suffix())
            .unwrap_or_else(|| "<none>".to_string());
        session_debug_log(&format!(
            "collect_parser_metas_indexed provider={} matcher={} total_files={} processed_files={} recognized_files={} unrecognized_files={} changed_files={} reasons=[{}]",
            parser.id,
            matcher_text,
            total_files,
            processed_files,
            metas.len(),
            unrecognized_files.len(),
            changed_files,
            reason_text
        ));
        for item in unrecognized_files.iter().take(20) {
            session_debug_log(&format!(
                "unrecognized file={} reason={} parse_errors={} scanned_units={} row_count={}",
                item.file_path, item.reason, item.parse_errors, item.scanned_units, item.row_count
            ));
        }
    }
    Ok(ParserMetaIndexResult {
        metas,
        unrecognized_files,
    })
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

fn normalize_session_id_list(values: Option<Vec<String>>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for value in values.unwrap_or_default() {
        for token in value
            .split(|ch| ch == '\n' || ch == '\r' || ch == ',' || ch == ';')
            .map(|item| item.trim())
            .filter(|item| !item.is_empty())
        {
            if seen.insert(token.to_string()) {
                normalized.push(token.to_string());
            }
        }
    }
    normalized
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

fn load_native_session_file_index_rows(
    connection: &Connection,
    provider: &str,
) -> Result<HashMap<String, NativeSessionFileIndexRow>> {
    let mut map = HashMap::<String, NativeSessionFileIndexRow>::new();
    let mut statement = connection.prepare(
        r#"
        SELECT file_path, session_id, started_at, file_time_key, mtime, record_count, COALESCE(first_input, '')
        FROM native_session_file_index
        WHERE provider = ?1
        "#,
    )?;
    let mut rows = statement.query(params![provider])?;
    while let Some(row) = rows.next()? {
        let file_path = row.get::<usize, String>(0)?;
        map.insert(
            file_path,
            NativeSessionFileIndexRow {
                session_id: row.get::<usize, String>(1)?,
                started_at: row.get::<usize, i64>(2)?,
                file_time_key: row.get::<usize, i64>(3)?,
                mtime: row.get::<usize, i64>(4)?,
                record_count: row.get::<usize, i64>(5)?,
                first_input: row.get::<usize, String>(6)?,
            },
        );
    }
    Ok(map)
}

fn upsert_native_session_file_index_row(
    connection: &Connection,
    provider: &str,
    file_path: &str,
    row: &NativeSessionFileIndexRow,
) -> Result<()> {
    connection.execute(
        r#"
        INSERT INTO native_session_file_index
          (provider, file_path, session_id, started_at, file_time_key, mtime, record_count, first_input, updated_at)
        VALUES
          (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        ON CONFLICT(provider, file_path)
        DO UPDATE SET
          session_id = excluded.session_id,
          started_at = excluded.started_at,
          file_time_key = excluded.file_time_key,
          mtime = excluded.mtime,
          record_count = excluded.record_count,
          first_input = excluded.first_input,
          updated_at = excluded.updated_at
        "#,
        params![
            provider,
            file_path,
            row.session_id,
            row.started_at,
            row.file_time_key,
            row.mtime,
            row.record_count,
            row.first_input,
            now_epoch()
        ],
    )?;
    Ok(())
}

fn delete_native_session_file_index_row(connection: &Connection, provider: &str, file_path: &str) -> Result<()> {
    connection.execute(
        "DELETE FROM native_session_file_index WHERE provider = ?1 AND file_path = ?2",
        params![provider, file_path],
    )?;
    Ok(())
}

fn clear_native_session_file_index_rows(connection: &Connection, provider: &str) -> Result<()> {
    connection.execute(
        "DELETE FROM native_session_file_index WHERE provider = ?1",
        params![provider],
    )?;
    Ok(())
}

fn clip_preview_content(value: &str, max_chars: usize) -> (String, bool) {
    let sanitized = sanitize_log_text(value);
    let trimmed = sanitized.trim();
    if trimmed.is_empty() {
        return (String::new(), false);
    }
    let clipped = trimmed.chars().take(max_chars).collect::<String>();
    if trimmed.chars().count() > max_chars {
        (format!("{}...", clipped), true)
    } else {
        (clipped, false)
    }
}

fn encode_native_session_message_id(locator: &NativeSessionMessageLocator) -> Result<String> {
    serde_json::to_string(locator).context("encode native session message id")
}

fn decode_native_session_message_id(value: &str) -> Result<NativeSessionMessageLocator> {
    serde_json::from_str(value).context("decode native session message id")
}

fn parsed_message_matches_locator(
    row: &ParsedMessageRow,
    locator: &NativeSessionMessageLocator,
    session_id: &str,
) -> bool {
    row.session_id.trim() == session_id
        && row.kind == locator.kind
        && row.created_at == locator.created_at
        && row.line_no == locator.line_no
        && row.content_index == locator.content_index
}

fn find_parsed_message_by_locator<'a>(
    rows: &'a [ParsedMessageRow],
    locator: &NativeSessionMessageLocator,
    session_id: &str,
) -> Option<&'a ParsedMessageRow> {
    rows.iter()
        .find(|row| parsed_message_matches_locator(row, locator, session_id))
}

fn push_preview_row(
    rows: &mut Vec<NativeSessionPreviewRow>,
    seen: &mut HashSet<String>,
    source_file: &Path,
    row: &ParsedMessageRow,
) -> Result<()> {
    let (clipped, preview_truncated) = clip_preview_content(&row.content, 420);
    if clipped.trim().is_empty() {
        return Ok(());
    }
    let key = format!("{}:{}:{}", row.kind, row.created_at, clipped);
    if !seen.insert(key) {
        return Ok(());
    }

    let locator = NativeSessionMessageLocator {
        session_id: row.session_id.clone(),
        file_path: source_file.to_string_lossy().to_string(),
        kind: row.kind.clone(),
        created_at: row.created_at,
        line_no: row.line_no,
        content_index: row.content_index,
    };

    rows.push(NativeSessionPreviewRow {
        id: encode_native_session_message_id(&locator)?,
        kind: row.kind.clone(),
        content: clipped,
        created_at: row.created_at,
        preview_truncated,
    });

    Ok(())
}

fn preview_kind_order(kind: &str) -> i32 {
    match kind {
        "input" => 0,
        "output" => 1,
        _ => 2,
    }
}

fn sort_preview_rows(rows: &mut Vec<NativeSessionPreviewRow>) {
    rows.sort_by(|a, b| {
        a.created_at
            .cmp(&b.created_at)
            .then(preview_kind_order(&a.kind).cmp(&preview_kind_order(&b.kind)))
            .then(a.content.cmp(&b.content))
    });
}

fn strip_tag_block(text: &str, tag_name: &str) -> String {
    let start_tag = format!("<{}>", tag_name);
    let end_tag = format!("</{}>", tag_name);
    let mut current = text.to_string();
    loop {
        let Some(start) = current.find(&start_tag) else {
            break;
        };
        let tail_start = start + start_tag.len();
        if let Some(end_rel) = current[tail_start..].find(&end_tag) {
            let end = tail_start + end_rel + end_tag.len();
            current.replace_range(start..end, " ");
        } else {
            current.replace_range(start..current.len(), " ");
            break;
        }
    }
    current
}

fn compact_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn sanitize_session_question_preview(text: &str) -> String {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let stripped = ["INSTRUCTIONS", "environment_context", "permissions", "collaboration_mode"]
        .into_iter()
        .fold(normalized, |acc, tag| strip_tag_block(&acc, tag));
    let mut lines = Vec::new();
    for line in stripped.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with("# AGENTS.md instructions for ") {
            continue;
        }
        lines.push(trimmed.to_string());
    }
    compact_whitespace(&lines.join(" "))
}

fn first_input_preview_from_rows(rows: &[NativeSessionPreviewRow]) -> String {
    if rows.is_empty() {
        return String::new();
    }
    for row in rows.iter().filter(|row| row.kind == "input") {
        if row.content.trim().is_empty() {
            continue;
        }
        let sanitized = sanitize_session_question_preview(&row.content);
        if !sanitized.is_empty() {
            return sanitized;
        }
    }
    for row in rows {
        if row.content.trim().is_empty() {
            continue;
        }
        let sanitized = sanitize_session_question_preview(&row.content);
        if !sanitized.is_empty() {
            return sanitized;
        }
    }
    String::new()
}

fn first_input_preview_from_parsed_rows(rows: &[ParsedMessageRow]) -> String {
    if rows.is_empty() {
        return String::new();
    }
    for row in rows.iter().filter(|row| row.kind == "input") {
        if row.content.trim().is_empty() {
            continue;
        }
        let sanitized = sanitize_session_question_preview(&row.content);
        if !sanitized.is_empty() {
            return sanitized;
        }
    }
    for row in rows {
        if row.content.trim().is_empty() {
            continue;
        }
        let sanitized = sanitize_session_question_preview(&row.content);
        if !sanitized.is_empty() {
            return sanitized;
        }
    }
    String::new()
}

fn first_input_preview_for_provider(
    state: &AppState,
    provider: &str,
    session_id: &str,
    matcher: Option<&SessionFileMatcher>,
) -> String {
    collect_native_session_preview_rows_for_provider(state, provider, session_id, matcher)
        .map(|rows| first_input_preview_from_rows(&rows))
        .unwrap_or_default()
}

fn merge_session_candidate(
    map: &mut HashMap<String, NativeSessionCandidate>,
    provider: &str,
    session_id: &str,
    started_at: i64,
    mtime: i64,
    record_count: i64,
    first_input: &str,
) {
    let sid = session_id.trim();
    if sid.is_empty() {
        return;
    }
    let last_seen = if started_at > 0 {
        started_at.max(mtime)
    } else {
        mtime
    };
    let entry = map
        .entry(sid.to_string())
        .or_insert_with(|| NativeSessionCandidate {
            provider: provider.to_string(),
            session_id: sid.to_string(),
            started_at: 0,
            last_seen_at: 0,
            source_files: 0,
            record_count: 0,
            first_input: String::new(),
        });
    if started_at > 0 && (entry.started_at == 0 || started_at < entry.started_at) {
        entry.started_at = started_at;
    }
    if last_seen > entry.last_seen_at {
        entry.last_seen_at = last_seen;
    }
    entry.source_files += 1;
    entry.record_count = entry.record_count.saturating_add(record_count.max(0));
    if entry.first_input.trim().is_empty() {
        let preview = sanitize_session_question_preview(first_input);
        if !preview.is_empty() {
            entry.first_input = preview;
        }
    }
}

fn sort_session_candidates(items: &mut Vec<NativeSessionCandidate>) {
    items.sort_by(|a, b| {
        b.last_seen_at
            .cmp(&a.last_seen_at)
            .then(b.started_at.cmp(&a.started_at))
            .then(a.session_id.cmp(&b.session_id))
    });
}

fn collect_native_session_metas_from_index(
    connection: &Connection,
    provider: &str,
    session_id: Option<&str>,
    matcher: Option<&SessionFileMatcher>,
) -> Result<Vec<GenericSessionMeta>> {
    let indexed = load_native_session_file_index_rows(connection, provider)?;
    let mut metas = Vec::<GenericSessionMeta>::new();
    for (file_path, row) in indexed {
        let sid = row.session_id.trim();
        if sid.is_empty() {
            continue;
        }
        if let Some(target_sid) = session_id {
            if sid != target_sid {
                continue;
            }
        }
        let path = PathBuf::from(&file_path);
        if let Some(filter) = matcher {
            if !filter.matches_path(&path) {
                continue;
            }
        }
        metas.push(GenericSessionMeta {
            file_path: path,
            session_id: sid.to_string(),
            started_at: row.started_at,
            file_time_key: row.file_time_key,
            mtime: row.mtime,
            record_count: row.record_count,
            first_input: row.first_input,
        });
    }
    Ok(metas)
}

fn collect_native_session_preview_rows_for_provider(
    state: &AppState,
    provider: &str,
    session_id: &str,
    matcher: Option<&SessionFileMatcher>,
) -> Result<Vec<NativeSessionPreviewRow>> {
    collect_native_session_preview_rows_for_provider_limited(state, provider, session_id, matcher, None)
}

fn collect_native_session_preview_rows_for_provider_limited(
    state: &AppState,
    provider: &str,
    session_id: &str,
    matcher: Option<&SessionFileMatcher>,
    max_rows: Option<usize>,
) -> Result<Vec<NativeSessionPreviewRow>> {
    let parser = resolve_session_parser_profile(&state.session_parser_config_dir, provider)
        .ok_or_else(|| anyhow!("session parser profile not found: {}", provider))?;
    let connection = open_db(&state.db_path)?;
    let mut metas =
        collect_native_session_metas_from_index(&connection, &parser.id, Some(session_id), matcher)?;
    if metas.is_empty() {
        let refreshed = collect_parser_metas_indexed(state, &parser, matcher)?;
        metas = refreshed
            .metas
            .into_iter()
            .filter(|meta| meta.session_id.trim() == session_id)
            .collect::<Vec<_>>();
    }
    metas.sort_by_key(|meta| (meta.file_time_key, meta.started_at, meta.mtime));

    let mut rows = Vec::<NativeSessionPreviewRow>::new();
    let mut seen = HashSet::<String>::new();
    for meta in metas {
        if let Some(limit) = max_rows {
            if rows.len() >= limit {
                break;
            }
        }
        let per_file_limit = max_rows.map(|limit| limit.saturating_sub(rows.len()));
        let parsed = parse_session_file(&parser, &meta.file_path, Some(session_id), per_file_limit);
        for row in parsed.rows {
            let row_sid = row.session_id.trim();
            if !row_sid.is_empty() && row_sid != session_id {
                continue;
            }
            push_preview_row(&mut rows, &mut seen, &meta.file_path, &row)?;
            if let Some(limit) = max_rows {
                if rows.len() > limit {
                    break;
                }
            }
        }
    }
    sort_preview_rows(&mut rows);
    if let Some(limit) = max_rows {
        if rows.len() > limit {
            rows.truncate(limit);
        }
    }
    Ok(rows)
}

fn count_native_session_records_for_provider(
    state: &AppState,
    provider: &str,
    session_id: &str,
    matcher: Option<&SessionFileMatcher>,
) -> i64 {
    let connection = match open_db(&state.db_path) {
        Ok(connection) => connection,
        Err(_) => return 0,
    };
    let indexed = match load_native_session_file_index_rows(&connection, provider) {
        Ok(indexed) => indexed,
        Err(_) => return 0,
    };
    let mut total = 0_i64;
    for (file_path, row) in indexed {
        if row.session_id.trim() != session_id {
            continue;
        }
        if let Some(filter) = matcher {
            if !filter.matches_path(Path::new(&file_path)) {
                continue;
            }
        }
        total = total.saturating_add(row.record_count.max(0));
    }
    total
}

fn load_native_session_candidates_cache_first(
    state: &AppState,
    provider: &str,
    cache_key: &str,
    matcher: Option<&SessionFileMatcher>,
) -> Result<NativeSessionCandidatesBatch, String> {
    if let Ok(cache) = state.native_session_candidates_cache.lock() {
        if let Some(hit) = cache.get(cache_key) {
            return Ok(hit.batch.clone());
        }
    }

    let connection = open_db(&state.db_path).map_err(|error| error.to_string())?;
    let indexed =
        load_native_session_file_index_rows(&connection, provider).map_err(|error| error.to_string())?;
    let batch = build_native_session_candidates_batch_from_index_rows(
        provider,
        indexed,
        matcher,
        Vec::new(),
    );
    if let Ok(mut cache) = state.native_session_candidates_cache.lock() {
        cache.insert(
            cache_key.to_string(),
            NativeSessionCandidatesCache {
                batch: batch.clone(),
            },
        );
    }
    Ok(batch)
}

fn load_native_session_record_count_cached(
    state: &AppState,
    provider: &str,
    session_id: &str,
    ttl_secs: i64,
    matcher: Option<&SessionFileMatcher>,
) -> i64 {
    if ttl_secs <= 0 {
        return count_native_session_records_for_provider(state, provider, session_id, matcher);
    }

    let now = now_epoch();
    let key = format!("{}::{}", provider, session_id);
    if let Ok(cache) = state.native_session_record_count_cache.lock() {
        if let Some(hit) = cache.get(&key) {
            if now.saturating_sub(hit.updated_at) <= ttl_secs {
                return hit.count;
            }
        }
    }

    let indexed_count = if matcher.is_none() {
        open_db(&state.db_path)
            .and_then(|connection| {
                connection.query_row(
                    r#"
                    SELECT COUNT(1), COALESCE(SUM(record_count), 0)
                    FROM native_session_file_index
                    WHERE provider = ?1 AND session_id = ?2
                    "#,
                    params![provider, session_id],
                    |row| {
                        let rows = row.get::<usize, i64>(0)?;
                        let sum = row.get::<usize, i64>(1)?;
                        Ok((rows, sum))
                    },
                )
                .map_err(Into::into)
            })
            .ok()
            .and_then(|(rows, sum)| if rows > 0 { Some(sum) } else { None })
    } else {
        None
    };

    let count = indexed_count.unwrap_or_else(|| {
        count_native_session_records_for_provider(state, provider, session_id, matcher)
    });
    if let Ok(mut cache) = state.native_session_record_count_cache.lock() {
        cache.insert(
            key,
            NativeSessionRecordCountCache {
                updated_at: now,
                count,
            },
        );
    }
    count
}

fn load_native_session_first_input_cached(
    state: &AppState,
    provider: &str,
    session_id: &str,
    ttl_secs: i64,
    matcher: Option<&SessionFileMatcher>,
) -> String {
    if ttl_secs <= 0 {
        return first_input_preview_for_provider(state, provider, session_id, matcher);
    }

    let now = now_epoch();
    let key = format!("{}::{}", provider, session_id);
    if let Ok(cache) = state.native_session_first_input_cache.lock() {
        if let Some(hit) = cache.get(&key) {
            if now.saturating_sub(hit.updated_at) <= ttl_secs {
                return hit.text.clone();
            }
        }
    }

    let text = first_input_preview_for_provider(state, provider, session_id, matcher);
    if let Ok(mut cache) = state.native_session_first_input_cache.lock() {
        cache.insert(
            key,
            NativeSessionFirstInputCache {
                updated_at: now,
                text: text.clone(),
            },
        );
    }
    text
}

fn invalidate_native_session_record_count_cache(
    state: &AppState,
    provider: &str,
    session_ids: &[String],
) {
    let mut keys = HashSet::new();
    for session_id in session_ids {
        let normalized = session_id.trim();
        if normalized.is_empty() {
            continue;
        }
        keys.insert(format!("{}::{}", provider, normalized));
    }
    if keys.is_empty() {
        return;
    }
    if let Ok(mut cache) = state.native_session_record_count_cache.lock() {
        for key in keys {
            cache.remove(&key);
        }
    }
}

fn invalidate_native_session_first_input_cache(
    state: &AppState,
    provider: &str,
    session_ids: &[String],
) {
    let mut keys = HashSet::new();
    for session_id in session_ids {
        let normalized = session_id.trim();
        if normalized.is_empty() {
            continue;
        }
        keys.insert(format!("{}::{}", provider, normalized));
    }
    if keys.is_empty() {
        return;
    }
    if let Ok(mut cache) = state.native_session_first_input_cache.lock() {
        for key in keys {
            cache.remove(&key);
        }
    }
}

fn invalidate_native_session_record_count_cache_by_provider(state: &AppState, provider: &str) {
    if let Ok(mut cache) = state.native_session_record_count_cache.lock() {
        let prefix = format!("{}::", provider);
        let keys = cache
            .keys()
            .filter(|key| key.starts_with(&prefix))
            .cloned()
            .collect::<Vec<_>>();
        for key in keys {
            cache.remove(&key);
        }
    }
}

fn invalidate_native_session_first_input_cache_by_provider(state: &AppState, provider: &str) {
    if let Ok(mut cache) = state.native_session_first_input_cache.lock() {
        let prefix = format!("{}::", provider);
        let keys = cache
            .keys()
            .filter(|key| key.starts_with(&prefix))
            .cloned()
            .collect::<Vec<_>>();
        for key in keys {
            cache.remove(&key);
        }
    }
}

fn build_native_session_candidates_batch_from_metas(
    provider: &str,
    mut metas: Vec<GenericSessionMeta>,
    mut unrecognized_files: Vec<NativeSessionUnrecognizedFile>,
) -> NativeSessionCandidatesBatch {
    metas.sort_by_key(|meta| (meta.file_time_key, meta.started_at, meta.mtime));
    let mut map = HashMap::<String, NativeSessionCandidate>::new();
    for meta in metas {
        merge_session_candidate(
            &mut map,
            provider,
            &meta.session_id,
            meta.started_at,
            meta.mtime,
            meta.record_count,
            &meta.first_input,
        );
    }
    let mut items = map.into_values().collect::<Vec<_>>();
    sort_session_candidates(&mut items);
    unrecognized_files.sort_by(|a, b| {
        b.modified_at
            .cmp(&a.modified_at)
            .then(a.file_path.cmp(&b.file_path))
    });
    NativeSessionCandidatesBatch {
        items,
        unrecognized_files,
    }
}

fn build_native_session_candidates_batch_from_index_rows(
    provider: &str,
    indexed_rows: HashMap<String, NativeSessionFileIndexRow>,
    matcher: Option<&SessionFileMatcher>,
    unrecognized_files: Vec<NativeSessionUnrecognizedFile>,
) -> NativeSessionCandidatesBatch {
    let mut metas = Vec::<GenericSessionMeta>::new();
    for (file_path, row) in indexed_rows {
        let sid = row.session_id.trim();
        if sid.is_empty() {
            continue;
        }
        let path = PathBuf::from(&file_path);
        if let Some(filter) = matcher {
            if !filter.matches_path(&path) {
                continue;
            }
        }
        metas.push(GenericSessionMeta {
            file_path: path,
            session_id: sid.to_string(),
            started_at: row.started_at,
            file_time_key: row.file_time_key,
            mtime: row.mtime,
            record_count: row.record_count,
            first_input: row.first_input,
        });
    }
    build_native_session_candidates_batch_from_metas(provider, metas, unrecognized_files)
}

fn clear_native_session_caches_for_provider(state: &AppState, provider: &str) {
    invalidate_native_session_candidates_cache(state, provider);
    invalidate_native_session_preview_cache(state, provider);
    invalidate_native_session_record_count_cache_by_provider(state, provider);
    invalidate_native_session_first_input_cache_by_provider(state, provider);
}

fn invalidate_native_session_candidates_cache(state: &AppState, provider: &str) {
    if let Ok(mut cache) = state.native_session_candidates_cache.lock() {
        let prefix = format!("{}::", provider);
        let keys = cache
            .keys()
            .filter(|key| key.as_str() == provider || key.starts_with(&prefix))
            .cloned()
            .collect::<Vec<_>>();
        for key in keys {
            cache.remove(&key);
        }
    }
}

fn invalidate_native_session_preview_cache(state: &AppState, provider: &str) {
    if let Ok(mut cache) = state.native_session_preview_cache.lock() {
        let prefix = format!("{}::", provider);
        let keys = cache
            .keys()
            .filter(|key| key.as_str() == provider || key.starts_with(&prefix))
            .cloned()
            .collect::<Vec<_>>();
        for key in keys {
            cache.remove(&key);
        }
    }
}

fn load_pane_scan_config_db(path: &Path, pane_id: &str, fallback_provider: &str) -> Result<PaneScanConfig> {
    let connection = open_db(path)?;
    let row = connection
        .query_row(
            r#"
            SELECT
              COALESCE(parser_profile, ''),
              COALESCE(file_glob, ''),
              COALESCE(updated_at, 0)
            FROM pane_scan_config
            WHERE pane_id = ?1
            "#,
            params![pane_id],
            |item| {
                Ok(PaneScanConfig {
                    pane_id: pane_id.to_string(),
                    parser_profile: item.get::<usize, String>(0)?,
                    file_glob: item.get::<usize, String>(1)?,
                    updated_at: item.get::<usize, i64>(2)?,
                })
            },
        )
        .optional()?;
    let mut config = row.unwrap_or(PaneScanConfig {
        pane_id: pane_id.to_string(),
        parser_profile: normalize_native_scan_profile("", fallback_provider),
        file_glob: String::new(),
        updated_at: 0,
    });
    config.parser_profile = normalize_native_scan_profile(&config.parser_profile, fallback_provider);
    config.file_glob = normalize_scan_glob(&config.file_glob);
    Ok(config)
}

fn upsert_pane_scan_config_db(
    path: &Path,
    pane_id: &str,
    parser_profile: Option<String>,
    file_glob: Option<String>,
    fallback_provider: &str,
) -> Result<PaneScanConfig> {
    let current = load_pane_scan_config_db(path, pane_id, fallback_provider)?;
    let next_parser = parser_profile
        .map(|value| normalize_native_scan_profile(&value, fallback_provider))
        .unwrap_or(current.parser_profile);
    let next_glob = file_glob
        .map(|value| normalize_scan_glob(&value))
        .unwrap_or(current.file_glob);
    let now = now_epoch();
    let connection = open_db(path)?;
    connection.execute(
        r#"
        INSERT INTO pane_scan_config (pane_id, parser_profile, file_glob, updated_at)
        VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(pane_id)
        DO UPDATE SET
          parser_profile = excluded.parser_profile,
          file_glob = excluded.file_glob,
          updated_at = excluded.updated_at
        "#,
        params![pane_id, next_parser, next_glob, now],
    )?;
    load_pane_scan_config_db(path, pane_id, fallback_provider)
}

fn resolve_pane_scan_config(state: &AppState, pane_id: &str, provider: &str) -> Result<PaneScanConfig, String> {
    load_pane_scan_config_db(&state.db_path, pane_id, provider).map_err(|error| error.to_string())
}

fn parse_json_session_ids(raw: &str) -> Vec<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    if let Ok(parsed) = serde_json::from_str::<Vec<String>>(trimmed) {
        return normalize_session_id_list(Some(parsed));
    }
    normalize_session_id_list(Some(
        trimmed
            .split(|ch: char| ch == ',' || ch == ';' || ch.is_ascii_whitespace())
            .map(|item| item.trim().to_string())
            .collect(),
    ))
}

fn load_pane_session_state_db(path: &Path, pane_id: &str) -> Result<PaneSessionState> {
    let connection = open_db(path)?;
    let row = connection
        .query_row(
            r#"
            SELECT
              COALESCE(NULLIF(TRIM(active_session_id), ''), session_id, ''),
              COALESCE(linked_session_ids, '[]'),
              COALESCE(include_linked_in_sync, 0),
              COALESCE(updated_at, 0)
            FROM pane_codex_state
            WHERE pane_id = ?1
            "#,
            params![pane_id],
            |item| {
                Ok(PaneSessionState {
                    pane_id: pane_id.to_string(),
                    active_session_id: item.get::<usize, String>(0)?,
                    linked_session_ids: parse_json_session_ids(
                        &item.get::<usize, String>(1)?,
                    ),
                    include_linked_in_sync: item.get::<usize, i64>(2)? > 0,
                    updated_at: item.get::<usize, i64>(3)?,
                })
            },
        )
        .optional()?;

    Ok(row.unwrap_or(PaneSessionState {
        pane_id: pane_id.to_string(),
        ..PaneSessionState::default()
    }))
}

fn upsert_pane_session_state_db(
    path: &Path,
    pane_id: &str,
    active_session_id: Option<String>,
    linked_session_ids: Option<Vec<String>>,
    include_linked_in_sync: Option<bool>,
) -> Result<PaneSessionState> {
    let current = load_pane_session_state_db(path, pane_id)?;
    let next_active = match active_session_id {
        Some(value) => value.trim().to_string(),
        None => current.active_session_id,
    };
    let mut next_linked = linked_session_ids
        .map(|items| normalize_session_id_list(Some(items)))
        .unwrap_or(current.linked_session_ids);
    next_linked.retain(|sid| sid != &next_active);
    let next_include = include_linked_in_sync.unwrap_or(current.include_linked_in_sync);
    let now = now_epoch();
    let serialized = serde_json::to_string(&next_linked).unwrap_or_else(|_| "[]".to_string());

    let connection = open_db(path)?;
    connection.execute(
        r#"
        INSERT INTO pane_codex_state
          (pane_id, session_id, active_session_id, linked_session_ids, include_linked_in_sync, updated_at)
        VALUES
          (?1, ?2, ?2, ?3, ?4, ?5)
        ON CONFLICT(pane_id)
        DO UPDATE SET
          session_id = excluded.session_id,
          active_session_id = excluded.active_session_id,
          linked_session_ids = excluded.linked_session_ids,
          include_linked_in_sync = excluded.include_linked_in_sync,
          updated_at = excluded.updated_at
        "#,
        params![
            pane_id,
            next_active,
            serialized,
            if next_include { 1_i64 } else { 0_i64 },
            now
        ],
    )?;

    load_pane_session_state_db(path, pane_id)
}

fn save_bound_session_id(connection: &Connection, pane_id: &str, session_id: &str) -> Result<()> {
    connection.execute(
        r#"
        INSERT INTO pane_codex_state
          (pane_id, session_id, active_session_id, linked_session_ids, include_linked_in_sync, updated_at)
        VALUES
          (?1, ?2, ?2, '[]', 0, ?3)
        ON CONFLICT(pane_id)
        DO UPDATE SET
          session_id = excluded.session_id,
          active_session_id = excluded.active_session_id,
          updated_at = excluded.updated_at
        "#,
        params![pane_id, session_id, now_epoch()],
    )?;
    Ok(())
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

    clear_pane_output_buffer(&state.pane_output_buffers, &pane_id);
    let pane_id_for_thread = pane_id.clone();
    let app_for_thread = app.clone();
    let output_buffers = state.pane_output_buffers.clone();
    std::thread::spawn(move || {
        let mut buffer = [0_u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => {
                    let data = String::from_utf8_lossy(&buffer[..size]).to_string();
                    append_pane_output_buffer(&output_buffers, &pane_id_for_thread, &data);
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

fn normalize_directory_path(path: String) -> Result<PathBuf> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("path is empty"));
    }
    let mut resolved = PathBuf::from(trimmed);
    if resolved.is_relative() {
        let current = std::env::current_dir().context("failed to resolve current dir")?;
        resolved = current.join(resolved);
    }
    Ok(resolved)
}

fn normalize_workdir_binding_key(path: String) -> Result<String> {
    let normalized = normalize_working_directory(Some(path))?
        .ok_or_else(|| anyhow!("workdir is empty"))?;
    Ok(normalized.to_string_lossy().to_string())
}

fn list_workdir_session_bindings_db(path: &Path) -> Result<Vec<WorkdirSessionBinding>> {
    let connection = open_db(path)?;
    let mut statement = connection.prepare(
        r#"
        SELECT workdir, provider, session_ids, updated_at
        FROM workdir_session_bindings
        ORDER BY updated_at DESC, workdir ASC, provider ASC
        "#,
    )?;
    let mut rows = statement.query([])?;
    let mut items = Vec::new();
    while let Some(row) = rows.next()? {
        let workdir = row.get::<usize, String>(0)?;
        let provider = row.get::<usize, String>(1)?;
        let raw_session_ids = row.get::<usize, String>(2)?;
        let updated_at = row.get::<usize, i64>(3)?;
        let parsed = serde_json::from_str::<Vec<String>>(&raw_session_ids).unwrap_or_default();
        let session_ids = normalize_session_id_list(Some(parsed));
        items.push(WorkdirSessionBinding {
            workdir,
            provider,
            session_ids,
            updated_at,
        });
    }
    Ok(items)
}

fn upsert_workdir_session_binding_db(
    path: &Path,
    workdir: String,
    provider: String,
    session_ids: Vec<String>,
) -> Result<WorkdirSessionBinding> {
    let normalized_workdir = normalize_workdir_binding_key(workdir)?;
    let normalized_provider = provider.trim().to_lowercase();
    if normalized_provider.is_empty() {
        return Err(anyhow!("provider is empty"));
    }
    let normalized_ids = normalize_session_id_list(Some(session_ids));
    if normalized_ids.is_empty() {
        return Err(anyhow!("session_ids is empty"));
    }
    let encoded_ids = serde_json::to_string(&normalized_ids)?;
    let updated_at = now_epoch();
    let connection = open_db(path)?;
    connection.execute(
        r#"
        INSERT INTO workdir_session_bindings (workdir, provider, session_ids, updated_at)
        VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(workdir, provider)
        DO UPDATE SET
          session_ids = excluded.session_ids,
          updated_at = excluded.updated_at
        "#,
        params![
            normalized_workdir,
            normalized_provider,
            encoded_ids,
            updated_at
        ],
    )?;
    Ok(WorkdirSessionBinding {
        workdir: normalized_workdir,
        provider: normalized_provider,
        session_ids: normalized_ids,
        updated_at,
    })
}

fn delete_workdir_session_binding_db(path: &Path, workdir: String, provider: String) -> Result<()> {
    let normalized_workdir = normalize_workdir_binding_key(workdir)?;
    let normalized_provider = provider.trim().to_lowercase();
    if normalized_provider.is_empty() {
        return Err(anyhow!("provider is empty"));
    }
    let connection = open_db(path)?;
    connection.execute(
        "DELETE FROM workdir_session_bindings WHERE workdir = ?1 AND provider = ?2",
        params![normalized_workdir, normalized_provider],
    )?;
    Ok(())
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
        payload.push('\r');
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
    remove_pane_output_buffer(&state.pane_output_buffers, pane_id);

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
    if let Ok(mut buffers) = state.pane_output_buffers.lock() {
        buffers.clear();
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
    session_parse_preset: Option<String>,
    session_scan_glob: Option<String>,
    session_parse_json: Option<String>,
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
    let mut parser_profile = session_parse_preset;
    let mut file_glob = session_scan_glob;
    if let Some(raw_parser_text) = session_parse_json
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        let fallback_profile = normalize_native_scan_profile(
            parser_profile.as_deref().unwrap_or(provider.as_str()),
            &provider,
        );
        let normalized = upsert_session_parser_profile_from_text(
            &state.session_parser_config_dir,
            &raw_parser_text,
            &fallback_profile,
        )?;
        parser_profile = Some(normalized.id.clone());
        if file_glob
            .as_ref()
            .map(|value| value.trim().is_empty())
            .unwrap_or(true)
        {
            file_glob = Some(normalized.default_file_glob.clone());
        }
    }
    upsert_pane_scan_config_db(
        &state.db_path,
        &pane.id,
        parser_profile,
        file_glob,
        &provider,
    )
    .map_err(|error| error.to_string())?;
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
fn sync_text_payload(
    state: State<AppState>,
    target_pane_id: String,
    payload: String,
) -> Result<(), String> {
    let normalized = payload.trim().to_string();
    if normalized.is_empty() {
        return Err("payload is empty".to_string());
    }

    paste_to_pane_internal(&state, &target_pane_id, &normalized, false)
        .map_err(|error| error.to_string())
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
    matcher: Option<&SessionFileMatcher>,
) -> Result<Option<String>, String> {
    let parser = resolve_session_parser_profile(&state.session_parser_config_dir, provider)
        .ok_or_else(|| format!("session parser profile not found: {}", provider))?;
    let metas = collect_parser_metas_indexed(state, &parser, matcher)
        .map_err(|error| error.to_string())?
        .metas;
    if metas.is_empty() {
        return Ok(None);
    }
    let now = now_epoch();
    let recent_window_secs = 10_i64;
    let recent_metas = metas
        .iter()
        .filter(|meta| {
            meta.started_at > 0 && now.saturating_sub(meta.started_at).abs() <= recent_window_secs
        })
        .collect::<Vec<_>>();
    if recent_metas.is_empty() {
        return Ok(None);
    }
    if let Some(minimum) = runtime_start {
        let active = recent_metas
            .iter()
            .filter(|meta| meta.started_at >= minimum.saturating_sub(recent_window_secs))
            .max_by_key(|meta| (meta.started_at, meta.mtime))
            .map(|meta| meta.session_id.clone());
        if active.is_some() {
            return Ok(active);
        }
        return Ok(None);
    }

    let connection = open_db(&state.db_path).map_err(|error| error.to_string())?;
    let pane_created_at = load_pane_created_at(&connection, pane_id)
        .map_err(|error| error.to_string())?
        .unwrap_or_default();
    let near_now = recent_metas
        .iter()
        .filter(|meta| meta.started_at >= pane_created_at.saturating_sub(recent_window_secs))
        .max_by_key(|meta| (meta.started_at, meta.mtime))
        .map(|meta| meta.session_id.clone());
    if near_now.is_some() {
        return Ok(near_now);
    }
    Ok(recent_metas
        .iter()
        .max_by_key(|meta| (meta.started_at, meta.mtime))
        .map(|meta| meta.session_id.clone()))
}

fn import_native_history_inner(
    state: &AppState,
    pane_id: &str,
    provider: &str,
    session_id: Option<String>,
    session_role: &str,
    runtime_start: Option<i64>,
    matcher: Option<&SessionFileMatcher>,
) -> Result<NativeImportResult, String> {
    let parser = resolve_session_parser_profile(&state.session_parser_config_dir, provider)
        .ok_or_else(|| format!("session parser profile not found: {}", provider))?;
    let mut metas = collect_parser_metas_indexed(state, &parser, matcher)
        .map_err(|error| error.to_string())?
        .metas;
    metas.sort_by_key(|meta| (meta.file_time_key, meta.started_at, meta.mtime));

    let requested = normalize_session_id(session_id.clone());
    let target_session_id = if let Some(sid) = requested {
        sid
    } else {
        suggest_native_session_id_inner(state, pane_id, provider, runtime_start, matcher)?.ok_or_else(|| {
            format!(
                "current {} session not detected yet; send first message then retry import",
                provider
            )
        })?
    };

    let filtered_metas = metas
        .into_iter()
        .filter(|meta| meta.session_id == target_session_id)
        .collect::<Vec<_>>();
    if filtered_metas.is_empty() {
        return Err(format!(
            "session {} not found for parser {}",
            target_session_id, parser.id
        ));
    }

    let source_roots = resolve_parser_source_roots(&parser);
    let source_dir = source_roots
        .iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join(" ; ");

    let mut connection = open_db(&state.db_path).map_err(|error| error.to_string())?;
    let tx = connection.transaction().map_err(|error| error.to_string())?;
    if session_role == "active" {
        save_bound_session_id(&tx, pane_id, &target_session_id).map_err(|error| error.to_string())?;
    }

    let mut result = NativeImportResult {
        provider: parser.id.clone(),
        pane_id: pane_id.to_string(),
        session_id: target_session_id.clone(),
        session_ids: vec![target_session_id.clone()],
        source_dir,
        imported: 0,
        skipped: 0,
        scanned_files: filtered_metas.len() as i64,
        scanned_lines: 0,
        parse_errors: 0,
    };

    let import_marker = format!(
        "native:{}:{}:{}",
        parser.id,
        target_session_id,
        if session_role == "linked" { "linked" } else { "active" }
    );

    if parser.strip_codex_tags {
        let stale_pattern = format!("native:{}:{}:%", parser.id, target_session_id);
        let _ = tx.execute(
            r#"
            DELETE FROM entries
            WHERE pane_id = ?1
              AND synced_from LIKE ?2
              AND kind = 'input'
              AND (
                lower(content) LIKE '%# agents.md instructions for %'
                OR lower(content) LIKE '%<instructions>%'
                OR lower(content) LIKE '%<environment_context>%'
                OR lower(content) LIKE '%<permissions instructions>%'
                OR lower(content) LIKE '%<collaboration_mode>%'
              )
            "#,
            params![pane_id, stale_pattern],
        )
        .map_err(|error| error.to_string())?;
    }

    for meta in filtered_metas {
        let file_path_string = meta.file_path.to_string_lossy().to_string();
        let cursor_key = format!("{}::{}::{}", parser.id, target_session_id, file_path_string);
        let mtime = meta.mtime;
        if should_wait_for_file_settle(mtime) {
            result.skipped += 1;
            continue;
        }

        let (last_line, last_mtime) =
            load_codex_import_cursor(&tx, pane_id, &cursor_key).map_err(|error| error.to_string())?;
        if parser.file_format == "json" && last_line > 0 && mtime <= last_mtime {
            continue;
        }
        let skip_until = if parser.file_format == "jsonl" && mtime >= last_mtime {
            last_line.max(0)
        } else {
            0
        };

        let parsed = parse_session_file(&parser, &meta.file_path, Some(&target_session_id), None);
        result.scanned_lines += if parser.file_format == "jsonl" {
            parsed.scanned_units.saturating_sub(skip_until)
        } else {
            parsed.scanned_units
        };
        result.parse_errors += parsed.parse_errors;

        for row in parsed.rows {
            if parser.file_format == "jsonl" && row.line_no <= skip_until {
                continue;
            }
            let row_sid = row.session_id.trim();
            if !row_sid.is_empty() && row_sid != target_session_id {
                continue;
            }
            let created_at = if row.created_at > 0 {
                row.created_at
            } else {
                now_epoch()
            };
            let external_key = format!(
                "{}:{}:{}:{}:{}",
                parser.id, file_path_string, row.line_no, row.role, row.content_index
            );
            let inserted_rows = tx
                .execute(
                    r#"
                    INSERT OR IGNORE INTO entries
                      (id, pane_id, kind, content, synced_from, created_at, external_key)
                    VALUES
                      (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                    "#,
                    params![
                        Uuid::new_v4().to_string(),
                        pane_id,
                        row.kind,
                        row.content,
                        &import_marker,
                        created_at,
                        external_key
                    ],
                )
                .map_err(|error| error.to_string())?;

            if inserted_rows > 0 {
                result.imported += 1;
            } else {
                result.skipped += 1;
            }
        }

        let next_line = if parser.file_format == "jsonl" {
            parsed.scanned_units
        } else {
            1
        };
        save_codex_import_cursor(&tx, pane_id, &cursor_key, next_line, mtime)
            .map_err(|error| error.to_string())?;
    }

    if result.imported > 0 {
        tx.execute(
            "UPDATE panes SET updated_at = ?2 WHERE id = ?1",
            params![pane_id, now_epoch()],
        )
        .map_err(|error| error.to_string())?;
    }
    tx.commit().map_err(|error| error.to_string())?;

    let payload = serde_json::json!({
        "ts": now_epoch(),
        "event": format!("{}.native_import", parser.id),
        "provider": parser.id,
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
    detect_pane_session_id_via_status_inner(&state, &pane_id, &provider, None)
}

#[tauri::command]
fn list_native_session_candidates(
    state: State<AppState>,
    pane_id: String,
    sid_keyword: Option<String>,
    offset: Option<i64>,
    limit: Option<i64>,
    time_from: Option<i64>,
    time_to: Option<i64>,
    records_min: Option<i64>,
    records_max: Option<i64>,
    sort_by: Option<String>,
    sort_order: Option<String>,
    cache_only: Option<bool>,
    full_load: Option<bool>,
) -> Result<NativeSessionListResponse, String> {
    let provider = load_provider(&state.db_path, &pane_id).map_err(|error| error.to_string())?;
    let scan_config = resolve_pane_scan_config(&state, &pane_id, &provider)?;
    let native_provider = scan_config.parser_profile.clone();
    let matcher = SessionFileMatcher::from_raw(&scan_config.file_glob);
    let matcher_text = matcher
        .as_ref()
        .map(|value| value.cache_key_suffix())
        .unwrap_or_else(|| "<none>".to_string());
    session_debug_log(&format!(
        "list_native_session_candidates begin pane_id={} provider={} parser_profile={} file_glob={} matcher={}",
        pane_id,
        provider,
        native_provider,
        scan_config.file_glob,
        matcher_text
    ));
    let cache_ttl_secs = session_cache_ttl_secs(&state);
    let cache_key = build_native_scan_cache_key(&native_provider, matcher.as_ref());
    let should_refresh_cache = !cache_only.unwrap_or(true);
    let _ = full_load;
    let batch = if should_refresh_cache {
        let parser = resolve_session_parser_profile(&state.session_parser_config_dir, &native_provider)
            .ok_or_else(|| format!("session parser profile not found: {}", native_provider))?;
        let indexed = collect_parser_metas_indexed(&state, &parser, matcher.as_ref())
            .map_err(|error| error.to_string())?;
        let batch = build_native_session_candidates_batch_from_metas(
            &native_provider,
            indexed.metas,
            indexed.unrecognized_files,
        );
        if let Ok(mut cache) = state.native_session_candidates_cache.lock() {
            cache.insert(
                cache_key.clone(),
                NativeSessionCandidatesCache {
                    batch: batch.clone(),
                },
            );
        }
        batch
    } else {
        load_native_session_candidates_cache_first(
            &state,
            &native_provider,
            &cache_key,
            matcher.as_ref(),
        )?
    };
    let mut all_items = batch.items;
    let unrecognized_files = batch.unrecognized_files;
    let recognized_files = all_items
        .iter()
        .map(|item| item.source_files.max(0))
        .sum::<i64>();
    if session_debug_enabled() {
        let mut reason_counts = HashMap::<String, usize>::new();
        for item in &unrecognized_files {
            *reason_counts.entry(item.reason.clone()).or_insert(0) += 1;
        }
        let mut reason_pairs = reason_counts
            .into_iter()
            .map(|(reason, count)| format!("{}={}", reason, count))
            .collect::<Vec<_>>();
        reason_pairs.sort();
        session_debug_log(&format!(
            "list_native_session_candidates scanned recognized_files={} recognized_sessions={} unrecognized_files={} reasons=[{}]",
            recognized_files,
            all_items.len(),
            unrecognized_files.len(),
            if reason_pairs.is_empty() { "none".to_string() } else { reason_pairs.join(", ") }
        ));
    }

    let normalized_sort_by = sort_by
        .unwrap_or_else(|| "time".to_string())
        .trim()
        .to_lowercase();
    let sort_by_records = normalized_sort_by == "records";
    let sort_by_created = normalized_sort_by == "created";
    let sort_by_updated = normalized_sort_by == "updated";
    let normalized_sort_order = sort_order
        .unwrap_or_else(|| "desc".to_string())
        .trim()
        .to_lowercase();
    let desc = normalized_sort_order != "asc";
    let sid_keyword_value = sid_keyword
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    let mut time_from_value = time_from.filter(|value| *value > 0);
    let mut time_to_value = time_to.filter(|value| *value > 0);
    if let (Some(from), Some(to)) = (time_from_value, time_to_value) {
        if from > to {
            time_from_value = Some(to);
            time_to_value = Some(from);
        }
    }
    let mut records_min_value = records_min.map(|value| value.max(0));
    let mut records_max_value = records_max.map(|value| value.max(0));
    if let (Some(minimum), Some(maximum)) = (records_min_value, records_max_value) {
        if minimum > maximum {
            records_min_value = Some(maximum);
            records_max_value = Some(minimum);
        }
    }
    let filter_by_records = records_min_value.is_some() || records_max_value.is_some();
    let need_record_count = sort_by_records || filter_by_records;
    session_debug_log(&format!(
        "list_native_session_candidates filters sid_keyword={} time_from={:?} time_to={:?} records_min={:?} records_max={:?} sort_by={} sort_order={} need_record_count={} ttl_secs={}",
        sid_keyword_value,
        time_from_value,
        time_to_value,
        records_min_value,
        records_max_value,
        normalized_sort_by,
        normalized_sort_order,
        need_record_count,
        cache_ttl_secs
    ));

    let before_sid_filter = all_items.len();

    if !sid_keyword_value.is_empty() {
        all_items = all_items
            .into_iter()
            .filter(|item| {
                if item.session_id.to_lowercase().contains(&sid_keyword_value) {
                    return true;
                }
                let preview = if item.first_input.trim().is_empty() {
                    load_native_session_first_input_cached(
                        &state,
                        &native_provider,
                        &item.session_id,
                        cache_ttl_secs,
                        matcher.as_ref(),
                    )
                } else {
                    item.first_input.clone()
                };
                preview.to_lowercase().contains(&sid_keyword_value)
            })
            .collect::<Vec<_>>();
    }
    session_debug_log(&format!(
        "list_native_session_candidates sid_filter before={} after={}",
        before_sid_filter,
        all_items.len()
    ));
    let before_time_filter = all_items.len();

    if time_from_value.is_some() || time_to_value.is_some() {
        all_items = all_items
            .into_iter()
            .filter(|item| {
                let candidate_time = if item.started_at > 0 {
                    item.started_at
                } else {
                    item.last_seen_at
                };
                if let Some(from) = time_from_value {
                    if candidate_time < from {
                        return false;
                    }
                }
                if let Some(to) = time_to_value {
                    if candidate_time > to {
                        return false;
                    }
                }
                true
            })
            .collect::<Vec<_>>();
    }
    session_debug_log(&format!(
        "list_native_session_candidates time_filter before={} after={}",
        before_time_filter,
        all_items.len()
    ));
    let before_records_filter = all_items.len();

    if filter_by_records {
        all_items = all_items
            .into_iter()
            .filter(|item| {
                if let Some(minimum) = records_min_value {
                    if item.record_count < minimum {
                        return false;
                    }
                }
                if let Some(maximum) = records_max_value {
                    if item.record_count > maximum {
                        return false;
                    }
                }
                true
            })
            .collect::<Vec<_>>();
    }
    session_debug_log(&format!(
        "list_native_session_candidates records_filter before={} after={}",
        before_records_filter,
        all_items.len()
    ));

    if sort_by_records {
        all_items.sort_by(|a, b| {
            let ord = a
                .record_count
                .cmp(&b.record_count)
                .then(a.started_at.cmp(&b.started_at))
                .then(a.last_seen_at.cmp(&b.last_seen_at))
                .then(a.session_id.cmp(&b.session_id));
            if desc {
                ord.reverse()
            } else {
                ord
            }
        });
    } else if sort_by_created {
        all_items.sort_by(|a, b| {
            let a_created = if a.started_at > 0 { a.started_at } else { a.last_seen_at };
            let b_created = if b.started_at > 0 { b.started_at } else { b.last_seen_at };
            let ord = a_created
                .cmp(&b_created)
                .then(a.last_seen_at.cmp(&b.last_seen_at))
                .then(a.session_id.cmp(&b.session_id));
            if desc {
                ord.reverse()
            } else {
                ord
            }
        });
    } else if sort_by_updated {
        all_items.sort_by(|a, b| {
            let a_updated = if a.last_seen_at > 0 { a.last_seen_at } else { a.started_at };
            let b_updated = if b.last_seen_at > 0 { b.last_seen_at } else { b.started_at };
            let ord = a_updated
                .cmp(&b_updated)
                .then(a.started_at.cmp(&b.started_at))
                .then(a.session_id.cmp(&b.session_id));
            if desc {
                ord.reverse()
            } else {
                ord
            }
        });
    } else {
        all_items.sort_by(|a, b| {
            let a_time = if a.started_at > 0 {
                a.started_at
            } else {
                a.last_seen_at
            };
            let b_time = if b.started_at > 0 {
                b.started_at
            } else {
                b.last_seen_at
            };
            let ord = a_time
                .cmp(&b_time)
                .then(a.last_seen_at.cmp(&b.last_seen_at))
                .then(a.session_id.cmp(&b.session_id));
            if desc {
                ord.reverse()
            } else {
                ord
            }
        });
    }

    let total = all_items.len();
    let full_load_flag = full_load.unwrap_or(false);
    let requested_offset = offset.unwrap_or(0).max(0) as usize;
    let requested_limit = limit.unwrap_or(80).clamp(1, 1000) as usize;
    let (items, page_offset, page_limit, has_more) = if full_load_flag {
        (all_items, 0usize, total, false)
    } else {
        let safe_offset = requested_offset.min(total);
        let end = safe_offset.saturating_add(requested_limit).min(total);
        let page_items = all_items
            .into_iter()
            .skip(safe_offset)
            .take(end.saturating_sub(safe_offset))
            .collect::<Vec<_>>();
        let more = end < total;
        (page_items, safe_offset, requested_limit, more)
    };
    let sample_session_ids = items
        .iter()
        .take(10)
        .map(|item| item.session_id.clone())
        .collect::<Vec<_>>()
        .join(", ");
    session_debug_log(&format!(
        "list_native_session_candidates result total={} offset={} limit={} has_more={} sample_session_ids=[{}]",
        total,
        page_offset,
        page_limit,
        has_more,
        sample_session_ids
    ));

    Ok(NativeSessionListResponse {
        items,
        unrecognized_files,
        total: total as i64,
        offset: page_offset as i64,
        limit: page_limit as i64,
        has_more,
    })
}

#[tauri::command]
fn get_native_session_index_progress(
    state: State<AppState>,
    pane_id: String,
) -> Result<NativeSessionIndexProgress, String> {
    let provider = load_provider(&state.db_path, &pane_id).map_err(|error| error.to_string())?;
    let scan_config = resolve_pane_scan_config(&state, &pane_id, &provider)?;
    let native_provider = scan_config.parser_profile;
    load_native_session_index_progress_for_provider(&state, &native_provider)
}

fn load_native_session_index_progress_for_provider(
    state: &AppState,
    provider: &str,
) -> Result<NativeSessionIndexProgress, String> {
    let progress = state
        .native_session_index_progress
        .lock()
        .map_err(|_| "failed to lock native session index progress".to_string())?
        .get(provider)
        .cloned()
        .unwrap_or(NativeSessionIndexProgress {
            provider: provider.to_string(),
            ..NativeSessionIndexProgress::default()
        });
    Ok(progress)
}

#[tauri::command]
fn get_pane_scan_config(state: State<AppState>, pane_id: String) -> Result<PaneScanConfig, String> {
    let provider = load_provider(&state.db_path, &pane_id).map_err(|error| error.to_string())?;
    resolve_pane_scan_config(&state, &pane_id, &provider)
}

#[tauri::command]
fn get_session_parser_profile_config(
    state: State<AppState>,
    profile_id: String,
) -> Result<SessionParserConfig, String> {
    let normalized = normalize_native_scan_profile(&profile_id, DEFAULT_NATIVE_SCAN_PROFILE);
    resolve_session_parser_profile(&state.session_parser_config_dir, &normalized)
        .ok_or_else(|| format!("session parser profile not found: {}", normalized))
}

#[tauri::command]
fn preview_session_parser_sample(
    state: State<AppState>,
    parser_profile: String,
    parser_config_text: Option<String>,
    file_glob: Option<String>,
) -> Result<SessionParserSamplePreviewResponse, String> {
    let normalized_profile = normalize_native_scan_profile(&parser_profile, DEFAULT_NATIVE_SCAN_PROFILE);
    let parser = resolve_session_parser_for_preview(
        &state,
        &normalized_profile,
        parser_config_text.as_deref(),
    )
    .map_err(|error| error.to_string())?;
    let matcher = SessionFileMatcher::from_raw(file_glob.as_deref().unwrap_or_default());
    let files =
        collect_parser_candidate_files(&parser, matcher.as_ref()).map_err(|error| error.to_string())?;
    if files.is_empty() {
        return Err("no matching files found for parser sample preview".to_string());
    }
    for file_path in files {
        if let Ok(sample_value) = read_first_json_value_from_file(&file_path, &parser.file_format) {
            let message_sample_value =
                read_first_message_sample_value_from_file(&parser, &file_path).ok().flatten();
            return Ok(SessionParserSamplePreviewResponse {
                parser_profile: parser.id.clone(),
                file_path: file_path.to_string_lossy().to_string(),
                file_format: parser.file_format.clone(),
                sample_value,
                message_sample_value,
            });
        }
    }
    Err("failed to parse sample JSON from matched files".to_string())
}

#[tauri::command]
fn reindex_native_sessions(
    state: State<AppState>,
    pane_id: String,
) -> Result<NativeSessionIndexProgress, String> {
    let provider = load_provider(&state.db_path, &pane_id).map_err(|error| error.to_string())?;
    let scan_config = resolve_pane_scan_config(&state, &pane_id, &provider)?;
    let native_provider = scan_config.parser_profile.clone();
    let parser = resolve_session_parser_profile(&state.session_parser_config_dir, &native_provider)
        .ok_or_else(|| format!("session parser profile not found: {}", native_provider))?;
    let matcher = SessionFileMatcher::from_raw(&scan_config.file_glob);
    let cache_key = build_native_scan_cache_key(&native_provider, matcher.as_ref());
    let cache_ttl_secs = session_cache_ttl_secs(&state);
    clear_native_session_caches_for_provider(&state, &native_provider);
    let connection = open_db(&state.db_path).map_err(|error| error.to_string())?;
    clear_native_session_file_index_rows(&connection, &native_provider).map_err(|error| error.to_string())?;
    let indexed = collect_parser_metas_indexed(&state, &parser, matcher.as_ref())
        .map_err(|error| error.to_string())?;
    if cache_ttl_secs > 0 {
        let batch = build_native_session_candidates_batch_from_metas(
            &native_provider,
            indexed.metas,
            indexed.unrecognized_files,
        );
        if let Ok(mut cache) = state.native_session_candidates_cache.lock() {
            cache.insert(
                cache_key,
                NativeSessionCandidatesCache {
                    batch,
                },
            );
        }
    }
    load_native_session_index_progress_for_provider(&state, &native_provider)
}

#[tauri::command]
fn refresh_native_session_cache(
    state: State<AppState>,
    pane_id: String,
) -> Result<NativeSessionIndexProgress, String> {
    let provider = load_provider(&state.db_path, &pane_id).map_err(|error| error.to_string())?;
    let scan_config = resolve_pane_scan_config(&state, &pane_id, &provider)?;
    let native_provider = scan_config.parser_profile.clone();
    let parser = resolve_session_parser_profile(&state.session_parser_config_dir, &native_provider)
        .ok_or_else(|| format!("session parser profile not found: {}", native_provider))?;
    let matcher = SessionFileMatcher::from_raw(&scan_config.file_glob);
    let cache_key = build_native_scan_cache_key(&native_provider, matcher.as_ref());

    let indexed = collect_parser_metas_indexed(&state, &parser, matcher.as_ref())
        .map_err(|error| error.to_string())?;
    let batch = build_native_session_candidates_batch_from_metas(
        &native_provider,
        indexed.metas,
        indexed.unrecognized_files,
    );

    invalidate_native_session_candidates_cache(&state, &native_provider);
    invalidate_native_session_record_count_cache_by_provider(&state, &native_provider);
    invalidate_native_session_first_input_cache_by_provider(&state, &native_provider);
    if let Ok(mut cache) = state.native_session_candidates_cache.lock() {
        cache.insert(
            cache_key,
            NativeSessionCandidatesCache {
                batch,
            },
        );
    }
    load_native_session_index_progress_for_provider(&state, &native_provider)
}

#[tauri::command]
fn preview_native_session_messages(
    state: State<AppState>,
    pane_id: String,
    session_id: String,
    limit: Option<i64>,
    offset: Option<i64>,
    load_all: Option<bool>,
    from_end: Option<bool>,
) -> Result<NativeSessionPreviewResponse, String> {
    let provider = load_provider(&state.db_path, &pane_id).map_err(|error| error.to_string())?;
    let scan_config = resolve_pane_scan_config(&state, &pane_id, &provider)?;
    let native_provider = scan_config.parser_profile;
    let matcher = SessionFileMatcher::from_raw(&scan_config.file_glob);
    let normalized = session_id.trim().to_string();
    if normalized.is_empty() {
        return Err("session_id is empty".to_string());
    }
    let message_limit = limit.unwrap_or(200).clamp(1, 5000) as usize;
    let message_offset = offset.unwrap_or(0).max(0) as usize;
    let load_all_flag = load_all.unwrap_or(false);
    let from_end_flag = from_end.unwrap_or(false);
    let cache_ttl_secs = session_cache_ttl_secs(&state);
    let cache_key = build_native_preview_cache_key(&native_provider, matcher.as_ref(), &normalized);
    let now = now_epoch();

    let all_rows = if load_all_flag {
        collect_native_session_preview_rows_for_provider(
            &state,
            &native_provider,
            &normalized,
            matcher.as_ref(),
        )
        .map_err(|error| error.to_string())?
    } else if let Ok(cache) = state.native_session_preview_cache.lock() {
        if let Some(hit) = cache.get(&cache_key) {
            if cache_ttl_secs > 0 && now.saturating_sub(hit.updated_at) <= cache_ttl_secs && !hit.rows.is_empty() {
                hit.rows.clone()
            } else {
                collect_native_session_preview_rows_for_provider(
                    &state,
                    &native_provider,
                    &normalized,
                    matcher.as_ref(),
                )
                .map_err(|error| error.to_string())?
            }
        } else {
            collect_native_session_preview_rows_for_provider(
                &state,
                &native_provider,
                &normalized,
                matcher.as_ref(),
            )
            .map_err(|error| error.to_string())?
        }
    } else {
        collect_native_session_preview_rows_for_provider(
            &state,
            &native_provider,
            &normalized,
            matcher.as_ref(),
        )
        .map_err(|error| error.to_string())?
    };

    if !load_all_flag {
        if let Ok(mut cache) = state.native_session_preview_cache.lock() {
            cache.insert(
                cache_key,
                NativeSessionPreviewCache {
                    updated_at: now,
                    rows: all_rows.clone(),
                },
            );
        }
    }

    let total_rows = all_rows.len() as i64;
    let (rows, has_more) = if load_all_flag {
        (all_rows, false)
    } else if from_end_flag {
        let total = all_rows.len();
        let end = total.saturating_sub(message_offset);
        let start = end.saturating_sub(message_limit);
        let has_more = start > 0;
        (all_rows.into_iter().skip(start).take(end.saturating_sub(start)).collect::<Vec<_>>(), has_more)
    } else {
        let start = message_offset.min(all_rows.len());
        let end = (start + message_limit).min(all_rows.len());
        let has_more = end < all_rows.len();
        (all_rows.into_iter().skip(start).take(end.saturating_sub(start)).collect::<Vec<_>>(), has_more)
    };
    let loaded_rows = rows.len();
    Ok(NativeSessionPreviewResponse {
        session_id: normalized,
        rows,
        total_rows,
        loaded_rows: loaded_rows as i64,
        has_more,
    })
}

#[tauri::command]
fn get_native_session_message_detail(
    state: State<AppState>,
    pane_id: String,
    session_id: String,
    message_id: String,
) -> Result<NativeSessionMessageDetailResponse, String> {
    load_native_session_message_detail_inner(&state, &pane_id, &session_id, &message_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_native_session_message_details(
    state: State<AppState>,
    pane_id: String,
    messages: Vec<NativeSessionMessageSelection>,
) -> Result<Vec<NativeSessionMessageDetailResponse>, String> {
    load_native_session_message_details_inner(&state, &pane_id, &messages)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn sync_native_session_messages(
    state: State<AppState>,
    target_pane_id: String,
    payload: String,
) -> Result<EntryRecord, String> {
    let normalized = payload.trim().to_string();
    if normalized.is_empty() {
        return Err("payload is empty".to_string());
    }

    paste_to_pane_internal(&state, &target_pane_id, &normalized, true)
        .map_err(|error| error.to_string())?;
    let entry = add_entry(&state.db_path, &target_pane_id, "input", &normalized, None)
        .map_err(|error| error.to_string())?;
    log_entry_event(&state, &entry, "sync_native_session_messages", Some("sync-native-preview"));
    Ok(entry)
}

fn sort_native_session_message_details(items: &mut Vec<NativeSessionMessageDetailResponse>) {
    items.sort_by(|a, b| {
        a.created_at
            .cmp(&b.created_at)
            .then(a.kind.cmp(&b.kind))
            .then(a.message_id.cmp(&b.message_id))
    });
}

fn load_native_session_message_details_inner(
    state: &AppState,
    pane_id: &str,
    messages: &[NativeSessionMessageSelection],
) -> Result<Vec<NativeSessionMessageDetailResponse>> {
    if messages.is_empty() {
        return Ok(Vec::new());
    }

    let provider = load_provider(&state.db_path, pane_id)?;
    let scan_config = resolve_pane_scan_config(state, pane_id, &provider)
        .map_err(|error| anyhow!(error))?;
    let native_provider = scan_config.parser_profile;
    let parser = resolve_session_parser_profile(&state.session_parser_config_dir, &native_provider)
        .ok_or_else(|| anyhow!("session parser profile not found: {}", native_provider))?;
    let connection = open_db(&state.db_path)?;
    let matcher = SessionFileMatcher::from_raw(&scan_config.file_glob);

    let mut session_locators = HashMap::<String, Vec<(NativeSessionMessageLocator, String)>>::new();
    for message in messages {
        let normalized_session_id = message.session_id.trim().to_string();
        if normalized_session_id.is_empty() {
            return Err(anyhow!("session_id is empty"));
        }
        let locator = decode_native_session_message_id(message.message_id.trim())?;
        if locator.session_id.trim() != normalized_session_id {
            return Err(anyhow!("message_id does not belong to session_id"));
        }
        session_locators
            .entry(normalized_session_id)
            .or_default()
            .push((locator, message.message_id.clone()));
    }

    let mut details = Vec::<NativeSessionMessageDetailResponse>::new();
    for (session_id, locator_items) in session_locators {
        let metas = collect_native_session_metas_from_index(
            &connection,
            &parser.id,
            Some(&session_id),
            matcher.as_ref(),
        )?;
        if metas.is_empty() {
            return Err(anyhow!("session source files not found"));
        }

        let valid_files = metas
            .iter()
            .map(|meta| meta.file_path.to_string_lossy().to_string())
            .collect::<HashSet<_>>();
        let mut file_groups = HashMap::<String, Vec<(NativeSessionMessageLocator, String)>>::new();

        for (locator, message_id) in locator_items {
            let file_path = locator.file_path.trim().to_string();
            if !valid_files.contains(&file_path) {
                return Err(anyhow!("message source file not found in session index"));
            }
            file_groups
                .entry(file_path)
                .or_default()
                .push((locator, message_id));
        }

        for (file_path, requests) in file_groups {
            let parsed = parse_session_file(&parser, &PathBuf::from(&file_path), Some(&session_id), None);
            for (locator, message_id) in requests {
                let row = find_parsed_message_by_locator(&parsed.rows, &locator, &session_id)
                    .ok_or_else(|| anyhow!("message detail not found; source log may have changed"))?;
                details.push(NativeSessionMessageDetailResponse {
                    message_id,
                    session_id: session_id.clone(),
                    kind: row.kind.clone(),
                    content: row.content.clone(),
                    created_at: row.created_at,
                });
            }
        }
    }

    sort_native_session_message_details(&mut details);
    Ok(details)
}

fn load_native_session_message_detail_inner(
    state: &AppState,
    pane_id: &str,
    session_id: &str,
    message_id: &str,
) -> Result<NativeSessionMessageDetailResponse> {
    let mut details = load_native_session_message_details_inner(
        state,
        pane_id,
        &[NativeSessionMessageSelection {
            message_id: message_id.to_string(),
            session_id: session_id.to_string(),
        }],
    )?;
    details
        .pop()
        .ok_or_else(|| anyhow!("message detail not found; source log may have changed"))
}

#[tauri::command]
fn preview_native_unrecognized_file(
    state: State<AppState>,
    pane_id: String,
    file_path: String,
) -> Result<NativeUnrecognizedFilePreviewResponse, String> {
    let provider = load_provider(&state.db_path, &pane_id).map_err(|error| error.to_string())?;
    let scan_config = resolve_pane_scan_config(&state, &pane_id, &provider)?;
    let parser = resolve_session_parser_profile(&state.session_parser_config_dir, &scan_config.parser_profile)
        .ok_or_else(|| format!("session parser profile not found: {}", scan_config.parser_profile))?;

    let trimmed_path = file_path.trim();
    if trimmed_path.is_empty() {
        return Err("file_path is empty".to_string());
    }
    let path = PathBuf::from(trimmed_path);
    if !path.exists() {
        return Err(format!("file not found: {}", trimmed_path));
    }
    if path.is_dir() {
        return Err(format!("path is directory: {}", trimmed_path));
    }
    if let Some(matcher) = SessionFileMatcher::from_raw(&scan_config.file_glob) {
        if !matcher.matches_path(&path) {
            return Err("file_path not in configured scan glob".to_string());
        }
    }

    let parsed = parse_session_file(&parser, &path, None, None);
    let reason = if parsed
        .session_id
        .as_ref()
        .map(|item| item.trim())
        .filter(|item| !item.is_empty())
        .is_some()
    {
        "recognized".to_string()
    } else {
        classify_unrecognized_file_reason(&parsed)
    };

    Ok(NativeUnrecognizedFilePreviewResponse {
        file_path: path.to_string_lossy().to_string(),
        reason,
        parse_errors: parsed.parse_errors,
        scanned_units: parsed.scanned_units,
        row_count: parsed.rows.len() as i64,
        session_id: parsed.session_id.unwrap_or_default(),
        started_at: parsed.started_at,
        content: read_file_preview_text(&path, 256 * 1024, 12_000),
    })
}

fn list_parser_unrecognized_files_by_index(
    state: &AppState,
    parser: &SessionParserConfig,
    matcher: Option<&SessionFileMatcher>,
) -> Result<Vec<NativeSessionUnrecognizedFile>, String> {
    let files = collect_parser_candidate_files(parser, matcher).map_err(|error| error.to_string())?;
    let connection = open_db(&state.db_path).map_err(|error| error.to_string())?;
    let indexed =
        load_native_session_file_index_rows(&connection, &parser.id).map_err(|error| error.to_string())?;
    let mut output = Vec::<NativeSessionUnrecognizedFile>::new();
    for file_path in files {
        let file_path_string = file_path.to_string_lossy().to_string();
        let recognized = indexed
            .get(&file_path_string)
            .map(|row| !row.session_id.trim().is_empty())
            .unwrap_or(false);
        if recognized {
            continue;
        }
        let mtime = file_mtime_epoch(&file_path);
        let parsed = parse_session_file(parser, &file_path, None, None);
        output.push(NativeSessionUnrecognizedFile {
            file_path: file_path_string,
            reason: classify_unrecognized_file_reason(&parsed),
            parse_errors: parsed.parse_errors,
            scanned_units: parsed.scanned_units,
            row_count: parsed.rows.len() as i64,
            modified_at: mtime,
        });
    }
    output.sort_by(|a, b| {
        b.modified_at
            .cmp(&a.modified_at)
            .then(a.file_path.cmp(&b.file_path))
    });
    Ok(output)
}

#[tauri::command]
fn list_native_unrecognized_files(
    state: State<AppState>,
    pane_id: String,
) -> Result<Vec<NativeSessionUnrecognizedFile>, String> {
    let provider = load_provider(&state.db_path, &pane_id).map_err(|error| error.to_string())?;
    let scan_config = resolve_pane_scan_config(&state, &pane_id, &provider)?;
    let parser = resolve_session_parser_profile(&state.session_parser_config_dir, &scan_config.parser_profile)
        .ok_or_else(|| format!("session parser profile not found: {}", scan_config.parser_profile))?;
    let matcher = SessionFileMatcher::from_raw(&scan_config.file_glob);
    list_parser_unrecognized_files_by_index(&state, &parser, matcher.as_ref())
}

#[tauri::command]
fn clear_native_session_binding(state: State<AppState>, pane_id: String) -> Result<(), String> {
    let _ = load_provider(&state.db_path, &pane_id).map_err(|error| error.to_string())?;

    let connection = open_db(&state.db_path).map_err(|error| error.to_string())?;
    connection
        .execute("DELETE FROM pane_codex_state WHERE pane_id = ?1", params![pane_id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_pane_session_state(state: State<AppState>, pane_id: String) -> Result<PaneSessionState, String> {
    let _ = load_provider(&state.db_path, &pane_id).map_err(|error| error.to_string())?;
    load_pane_session_state_db(&state.db_path, &pane_id).map_err(|error| error.to_string())
}

#[tauri::command]
fn set_pane_session_state(
    state: State<AppState>,
    pane_id: String,
    active_session_id: Option<String>,
    linked_session_ids: Option<Vec<String>>,
    include_linked_in_sync: Option<bool>,
) -> Result<PaneSessionState, String> {
    let _ = load_provider(&state.db_path, &pane_id).map_err(|error| error.to_string())?;
    upsert_pane_session_state_db(
        &state.db_path,
        &pane_id,
        active_session_id,
        linked_session_ids,
        include_linked_in_sync,
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn estimate_native_import(
    state: State<AppState>,
    pane_id: String,
    session_ids: Vec<String>,
) -> Result<NativeImportEstimate, String> {
    let provider = load_provider(&state.db_path, &pane_id).map_err(|error| error.to_string())?;
    let scan_config = resolve_pane_scan_config(&state, &pane_id, &provider)?;
    let native_provider = scan_config.parser_profile;
    let matcher = SessionFileMatcher::from_raw(&scan_config.file_glob);
    let ttl_secs = session_cache_ttl_secs(&state);
    let normalized_ids = normalize_session_id_list(Some(session_ids));
    if normalized_ids.is_empty() {
        return Ok(NativeImportEstimate {
            provider: native_provider,
            session_count: 0,
            estimated_records: 0,
            items: Vec::new(),
        });
    }

    let mut total = 0_i64;
    let mut items = Vec::new();
    for session_id in normalized_ids {
        let record_count = load_native_session_record_count_cached(
            &state,
            &native_provider,
            &session_id,
            ttl_secs,
            matcher.as_ref(),
        );
        total += record_count;
        items.push(NativeImportEstimateItem {
            session_id,
            record_count,
        });
    }

    Ok(NativeImportEstimate {
        provider: native_provider,
        session_count: items.len() as i64,
        estimated_records: total,
        items,
    })
}

#[tauri::command]
fn import_native_history(
    state: State<AppState>,
    pane_id: String,
    session_id: Option<String>,
    session_ids: Option<Vec<String>>,
    active_session_id: Option<String>,
    linked_session_ids: Option<Vec<String>>,
) -> Result<NativeImportResult, String> {
    let provider = load_provider(&state.db_path, &pane_id).map_err(|error| error.to_string())?;
    let scan_config = resolve_pane_scan_config(&state, &pane_id, &provider)?;
    let native_provider = scan_config.parser_profile;
    let matcher = SessionFileMatcher::from_raw(&scan_config.file_glob);
    let runtime_start = state
        .pane_runtime_starts
        .lock()
        .map_err(|_| "failed to lock pane runtime start map".to_string())?
        .get(&pane_id)
        .copied();
    let mut requested_ids = normalize_session_id_list(session_ids);
    let active_id = normalize_session_id(active_session_id);
    let linked_set = normalize_session_id_list(linked_session_ids)
        .into_iter()
        .collect::<HashSet<_>>();
    if requested_ids.is_empty() {
        if let Some(single) = normalize_session_id(session_id.clone()) {
            requested_ids.push(single);
        }
    }

    if requested_ids.is_empty() {
        let result = import_native_history_inner(
            &state,
            &pane_id,
            &native_provider,
            None,
            "active",
            runtime_start,
            matcher.as_ref(),
        )?;
        invalidate_native_session_candidates_cache(&state, &native_provider);
        invalidate_native_session_record_count_cache(&state, &native_provider, &result.session_ids);
        invalidate_native_session_first_input_cache(&state, &native_provider, &result.session_ids);
        return Ok(result);
    }

    let mut aggregate: Option<NativeImportResult> = None;
    for session in requested_ids {
        let session_role = if active_id.as_ref().is_some_and(|sid| sid == &session) {
            "active"
        } else if linked_set.contains(&session) {
            "linked"
        } else {
            "active"
        };
        let result = import_native_history_inner(
            &state,
            &pane_id,
            &native_provider,
            Some(session.clone()),
            session_role,
            runtime_start,
            matcher.as_ref(),
        )?;
        invalidate_native_session_candidates_cache(&state, &native_provider);
        invalidate_native_session_record_count_cache(&state, &native_provider, &result.session_ids);
        invalidate_native_session_first_input_cache(&state, &native_provider, &result.session_ids);
        if let Some(current) = aggregate.as_mut() {
            current.session_id = result.session_id.clone();
            current.session_ids.extend(result.session_ids.clone());
            current.imported += result.imported;
            current.skipped += result.skipped;
            current.scanned_files += result.scanned_files;
            current.scanned_lines += result.scanned_lines;
            current.parse_errors += result.parse_errors;
        } else {
            aggregate = Some(result);
        }
    }

    let mut merged = aggregate.ok_or_else(|| "no session ids to import".to_string())?;
    merged.session_ids = normalize_session_id_list(Some(merged.session_ids.clone()));
    if merged.session_id.trim().is_empty() {
        merged.session_id = merged.session_ids.first().cloned().unwrap_or_default();
    }

    Ok(merged)
}

#[tauri::command]
fn suggest_codex_session_id(state: State<AppState>, pane_id: String) -> Result<Option<String>, String> {
    let provider = load_provider(&state.db_path, &pane_id).map_err(|error| error.to_string())?;
    if provider != "codex" {
        return Ok(None);
    }
    detect_pane_session_id_via_status_inner(&state, &pane_id, &provider, None)
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
    import_native_history_inner(
        &state,
        &pane_id,
        "codex",
        session_id,
        "active",
        runtime_start,
        None,
    )
}

#[tauri::command]
fn list_registered_providers(state: State<AppState>) -> Vec<String> {
    list_registered_provider_ids(&state.adapter_config_dir)
}

#[tauri::command]
fn list_registered_session_parser_profiles(
    state: State<AppState>,
) -> Vec<SessionParserProfileSummary> {
    list_registered_session_parser_profile_summaries(&state.session_parser_config_dir)
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
    let ui_theme_preset = normalize_ui_theme_preset(&config.ui_theme_preset);
    let ui_skin_hue = normalize_ui_skin_hue(config.ui_skin_hue);
    let ui_skin_accent = normalize_hex_color(&config.ui_skin_accent, DEFAULT_UI_SKIN_ACCENT);
    let user_avatar_path = normalize_avatar_path(&config.user_avatar_path, DEFAULT_USER_AVATAR_PATH);
    let assistant_avatar_path =
        normalize_avatar_path(&config.assistant_avatar_path, DEFAULT_ASSISTANT_AVATAR_PATH);
    Ok(AppConfigResponse {
        config_path: state.config_path.to_string_lossy().to_string(),
        working_directory: config.working_directory,
        native_session_list_cache_ttl_secs: normalize_native_session_cache_ttl_secs(
            config.native_session_list_cache_ttl_secs,
        ),
        ui_theme_preset,
        ui_skin_hue,
        ui_skin_accent,
        user_avatar_path,
        assistant_avatar_path,
    })
}

#[tauri::command]
fn set_ui_theme_config(
    state: State<AppState>,
    ui_theme_preset: Option<String>,
    ui_skin_hue: Option<i64>,
    ui_skin_accent: Option<String>,
) -> Result<UiThemeConfigResponse, String> {
    let mut config = state
        .app_config
        .lock()
        .map_err(|_| "failed to lock app config".to_string())?;

    let next_preset = ui_theme_preset
        .map(|value| normalize_ui_theme_preset(&value))
        .unwrap_or_else(|| normalize_ui_theme_preset(&config.ui_theme_preset));
    let next_hue = ui_skin_hue
        .map(normalize_ui_skin_hue)
        .unwrap_or_else(|| normalize_ui_skin_hue(config.ui_skin_hue));
    let next_accent = ui_skin_accent
        .map(|value| normalize_hex_color(&value, DEFAULT_UI_SKIN_ACCENT))
        .unwrap_or_else(|| normalize_hex_color(&config.ui_skin_accent, DEFAULT_UI_SKIN_ACCENT));

    config.ui_theme_preset = next_preset.clone();
    config.ui_skin_hue = next_hue;
    config.ui_skin_accent = next_accent.clone();
    save_app_config(&state.config_path, &config).map_err(|error| error.to_string())?;

    Ok(UiThemeConfigResponse {
        ui_theme_preset: next_preset,
        ui_skin_hue: next_hue,
        ui_skin_accent: next_accent,
    })
}

#[tauri::command]
fn set_avatar_config(
    state: State<AppState>,
    user_avatar_path: Option<String>,
    assistant_avatar_path: Option<String>,
) -> Result<AvatarConfigResponse, String> {
    let mut config = state
        .app_config
        .lock()
        .map_err(|_| "failed to lock app config".to_string())?;

    let next_user_avatar_path = user_avatar_path
        .map(|value| normalize_avatar_path(&value, DEFAULT_USER_AVATAR_PATH))
        .unwrap_or_else(|| normalize_avatar_path(&config.user_avatar_path, DEFAULT_USER_AVATAR_PATH));
    let next_assistant_avatar_path = assistant_avatar_path
        .map(|value| normalize_avatar_path(&value, DEFAULT_ASSISTANT_AVATAR_PATH))
        .unwrap_or_else(|| {
            normalize_avatar_path(&config.assistant_avatar_path, DEFAULT_ASSISTANT_AVATAR_PATH)
        });

    config.user_avatar_path = next_user_avatar_path.clone();
    config.assistant_avatar_path = next_assistant_avatar_path.clone();
    save_app_config(&state.config_path, &config).map_err(|error| error.to_string())?;

    Ok(AvatarConfigResponse {
        user_avatar_path: next_user_avatar_path,
        assistant_avatar_path: next_assistant_avatar_path,
    })
}

#[tauri::command]
fn load_avatar_data_url(image_path: String) -> Result<String, String> {
    let trimmed = image_path.trim();
    if trimmed.is_empty() {
        return Err("image_path is empty".to_string());
    }

    let path = PathBuf::from(trimmed);
    if !path.exists() {
        return Err(format!("image file not found: {}", trimmed));
    }
    if path.is_dir() {
        return Err(format!("image_path is directory: {}", trimmed));
    }

    read_image_file_as_data_url(&path).map_err(|error| error.to_string())
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
fn ensure_directory(path: String) -> Result<String, String> {
    let resolved = normalize_directory_path(path).map_err(|error| error.to_string())?;
    if resolved.exists() {
        if !resolved.is_dir() {
            return Err(format!(
                "path is not a directory: {}",
                resolved.to_string_lossy()
            ));
        }
    } else {
        fs::create_dir_all(&resolved).map_err(|error| error.to_string())?;
    }
    Ok(resolved.to_string_lossy().to_string())
}

#[tauri::command]
fn set_native_session_list_cache_ttl_secs(
    state: State<AppState>,
    ttl_secs: i64,
) -> Result<i64, String> {
    let normalized = normalize_native_session_cache_ttl_secs(ttl_secs);
    {
        let mut config = state
            .app_config
            .lock()
            .map_err(|_| "failed to lock app config".to_string())?;
        config.native_session_list_cache_ttl_secs = normalized;
        save_app_config(&state.config_path, &config).map_err(|error| error.to_string())?;
    }
    if let Ok(mut cache) = state.native_session_candidates_cache.lock() {
        cache.clear();
    }
    if let Ok(mut cache) = state.native_session_record_count_cache.lock() {
        cache.clear();
    }
    if let Ok(mut cache) = state.native_session_first_input_cache.lock() {
        cache.clear();
    }
    Ok(normalized)
}

#[tauri::command]
fn list_workdir_session_bindings(state: State<AppState>) -> Result<Vec<WorkdirSessionBinding>, String> {
    list_workdir_session_bindings_db(&state.db_path).map_err(|error| error.to_string())
}

#[tauri::command]
fn upsert_workdir_session_binding(
    state: State<AppState>,
    workdir: String,
    provider: String,
    session_ids: Vec<String>,
) -> Result<WorkdirSessionBinding, String> {
    upsert_workdir_session_binding_db(&state.db_path, workdir, provider, session_ids)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn delete_workdir_session_binding(
    state: State<AppState>,
    workdir: String,
    provider: String,
) -> Result<(), String> {
    delete_workdir_session_binding_db(&state.db_path, workdir, provider).map_err(|error| error.to_string())
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
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .context("failed to resolve app data dir")?;
            std::fs::create_dir_all(&data_dir)?;
            let db_path = data_dir.join("history.db");
            let log_dir = data_dir.join("logs");
            let adapter_config_dir = data_dir.join("adapters");
            let session_parser_config_dir = data_dir.join("session-parsers");
            std::fs::create_dir_all(&log_dir)?;
            std::fs::create_dir_all(&adapter_config_dir)?;
            std::fs::create_dir_all(&session_parser_config_dir)?;
            let log_path = log_dir.join("events.jsonl");
            let config_path = data_dir.join("settings.json");
            ensure_adapter_sample_file(&adapter_config_dir);
            ensure_session_parser_sample_file(&session_parser_config_dir);
            init_schema(&db_path)?;
            let mut app_config = load_app_config(&config_path);
            app_config.native_session_list_cache_ttl_secs =
                normalize_native_session_cache_ttl_secs(app_config.native_session_list_cache_ttl_secs);
            app_config.ui_theme_preset = normalize_ui_theme_preset(&app_config.ui_theme_preset);
            app_config.ui_skin_hue = normalize_ui_skin_hue(app_config.ui_skin_hue);
            app_config.ui_skin_accent =
                normalize_hex_color(&app_config.ui_skin_accent, DEFAULT_UI_SKIN_ACCENT);
            app_config.user_avatar_path =
                normalize_avatar_path(&app_config.user_avatar_path, DEFAULT_USER_AVATAR_PATH);
            app_config.assistant_avatar_path = normalize_avatar_path(
                &app_config.assistant_avatar_path,
                DEFAULT_ASSISTANT_AVATAR_PATH,
            );
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
                pane_output_buffers: Arc::new(Mutex::new(HashMap::new())),
                native_session_candidates_cache: Mutex::new(HashMap::new()),
                native_session_preview_cache: Mutex::new(HashMap::new()),
                native_session_record_count_cache: Mutex::new(HashMap::new()),
                native_session_first_input_cache: Mutex::new(HashMap::new()),
                native_session_index_progress: Mutex::new(HashMap::new()),
                working_directory: Mutex::new(working_directory),
                app_config: Mutex::new(app_config),
                config_path,
                db_path,
                adapter_config_dir,
                session_parser_config_dir,
                log_path,
                log_lock: Mutex::new(()),
            });
            let _ = fit_main_window_to_desktop(app.handle());
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
            sync_text_payload,
            run_provider_prompt,
            run_team_prompt,
            suggest_native_session_id,
            list_native_session_candidates,
            get_native_session_index_progress,
            get_pane_scan_config,
            get_session_parser_profile_config,
            preview_session_parser_sample,
            reindex_native_sessions,
            refresh_native_session_cache,
            preview_native_session_messages,
            get_native_session_message_detail,
            get_native_session_message_details,
            sync_native_session_messages,
            preview_native_unrecognized_file,
            list_native_unrecognized_files,
            clear_native_session_binding,
            get_pane_session_state,
            set_pane_session_state,
            estimate_native_import,
            import_native_history,
            suggest_codex_session_id,
            clear_codex_session_binding,
            import_codex_native_history,
            list_registered_providers,
            list_registered_session_parser_profiles,
            stop_pane,
            close_pane,
            export_all_history_markdown,
            get_observability_info,
            get_app_config,
            set_ui_theme_config,
            set_avatar_config,
            load_avatar_data_url,
            set_working_directory,
            ensure_directory,
            set_native_session_list_cache_ttl_secs,
            list_workdir_session_bindings,
            upsert_workdir_session_binding,
            delete_workdir_session_binding,
            ai_team_mcp::ai_team_create_team,
            ai_team_mcp::ai_team_get_snapshot,
            ai_team_mcp::ai_team_initialize_team,
            ai_team_mcp::ai_team_read_role_sid,
            ai_team_mcp::ai_team_set_role_sid,
            ai_team_mcp::ai_team_clear_role_sid,
            ai_team_mcp::ai_team_refresh_role_sid,
            ai_team_mcp::ai_team_send_role_hello,
            ai_team_mcp::ai_team_send_all_role_hello,
            ai_team_mcp::ai_team_bind_role_sid,
            ai_team_mcp::ai_team_bind_all_role_sids,
            ai_team_mcp::ai_team_send_message,
            ai_team_mcp::ai_team_load_conversation,
            ai_team_mcp::ai_team_is_conversation_finished,
            ai_team_mcp::ai_team_submit_requirement,
            ai_team_mcp::ai_team_execute_next,
            clear_all_history,
            clear_pane_history
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn fit_main_window_to_desktop(app: &AppHandle) -> Result<()> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    let monitor = window
        .current_monitor()?
        .or_else(|| window.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return Ok(());
    };

    let scale = monitor.scale_factor().max(1.0);
    let size = monitor.size();
    let desktop_width = (size.width as f64 / scale).floor().max(1.0);
    let desktop_height = (size.height as f64 / scale).floor().max(1.0);

    let target_width = (desktop_width * 0.92).clamp(960.0, desktop_width);
    let target_height = (desktop_height * 0.90).clamp(640.0, desktop_height);

    window.set_size(Size::Logical(LogicalSize::new(target_width, target_height)))?;
    let _ = window.center();
    Ok(())
}
