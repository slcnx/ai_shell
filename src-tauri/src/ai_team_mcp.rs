use super::*;
use rusqlite::{params, OptionalExtension};
use serde::de::DeserializeOwned;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AiTeamRolePhase {
    Draft,
    Initialized,
    BindingSid,
    Ready,
    Running,
    Error,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AiTeamRunStage {
    Created,
    AnalystDispatched,
    WaitingAnalyst,
    CoderDispatched,
    WaitingCoder,
    AnalystReviewDispatched,
    Finished,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct AiTeamRoleSnapshot {
    role_key: String,
    name: String,
    provider: String,
    pane_id: String,
    session_id: String,
    work_directory: String,
    phase: AiTeamRolePhase,
    runtime_ready: bool,
    sid_bound: bool,
    responding: bool,
    completed: bool,
    idle_secs: i64,
    last_input_at: i64,
    last_output_at: i64,
    last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct AiTeamRunSnapshot {
    run_id: String,
    team_id: String,
    requirement: String,
    stage: AiTeamRunStage,
    auto_mode: bool,
    last_action: Option<String>,
    final_answer: Option<String>,
    last_error: Option<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct AiTeamSnapshotResponse {
    team_id: String,
    name: String,
    project_directory: String,
    runtime_directory: String,
    roles: Vec<AiTeamRoleSnapshot>,
    active_run: Option<AiTeamRunSnapshot>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct AiTeamCreateTeamResponse {
    snapshot: AiTeamSnapshotResponse,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct AiTeamInitializeTeamResponse {
    snapshot: AiTeamSnapshotResponse,
    created_pane_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct AiTeamRoleSidResponse {
    role: String,
    pane_id: String,
    session_id: String,
    sid_bound: bool,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct AiTeamBindRoleResponse {
    role: AiTeamRoleSnapshot,
    bound: bool,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct AiTeamBindAllResponse {
    snapshot: AiTeamSnapshotResponse,
    bound_roles: Vec<String>,
    failed_roles: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct AiTeamSendMessageResponse {
    accepted: bool,
    pane_id: String,
    session_id: String,
    role: String,
    sent_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct AiTeamSendHelloResponse {
    accepted: bool,
    pane_id: String,
    role: String,
    sent_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct AiTeamSendAllHelloResponse {
    snapshot: AiTeamSnapshotResponse,
    sent_roles: Vec<String>,
    failed_roles: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct AiTeamConversationResponse {
    role: String,
    session_id: String,
    rows: Vec<NativeSessionPreviewRow>,
    total_rows: i64,
    loaded_rows: i64,
    has_more: bool,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct AiTeamConversationStatusResponse {
    role: String,
    session_id: String,
    runtime_ready: bool,
    responding: bool,
    completed: bool,
    idle_secs: i64,
    last_input_at: i64,
    last_output_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct AiTeamSubmitRequirementResponse {
    snapshot: AiTeamSnapshotResponse,
    run: AiTeamRunSnapshot,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct AiTeamExecuteNextResponse {
    snapshot: AiTeamSnapshotResponse,
    run: AiTeamRunSnapshot,
    transition: String,
    waiting_role: Option<String>,
    done: bool,
}

#[derive(Debug, Clone)]
struct AiTeamTeamRow {
    team_id: String,
    name: String,
    project_directory: String,
    runtime_directory: String,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone)]
struct AiTeamRoleRow {
    team_id: String,
    role_key: String,
    provider: String,
    pane_id: String,
    session_id: String,
    work_directory: String,
    phase: String,
    last_sent_at: i64,
    last_read_at: i64,
    last_error: Option<String>,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
enum AiTeamActionEnvelope {
    Delegate { target: String, message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AiTeamFinalEnvelope {
    summary: String,
    files: Option<Vec<String>>,
    done: bool,
}

fn ensure_ai_team_schema(path: &Path) -> Result<(), String> {
    let connection = open_db(path).map_err(|error| error.to_string())?;
    connection
        .execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS ai_team_teams (
              team_id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              project_directory TEXT NOT NULL,
              runtime_directory TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS ai_team_roles (
              team_id TEXT NOT NULL,
              role_key TEXT NOT NULL,
              provider TEXT NOT NULL,
              pane_id TEXT NOT NULL DEFAULT '',
              session_id TEXT NOT NULL DEFAULT '',
              work_directory TEXT NOT NULL DEFAULT '',
              phase TEXT NOT NULL DEFAULT 'draft',
              last_sent_at INTEGER NOT NULL DEFAULT 0,
              last_read_at INTEGER NOT NULL DEFAULT 0,
              last_error TEXT,
              updated_at INTEGER NOT NULL,
              PRIMARY KEY (team_id, role_key)
            );

            CREATE TABLE IF NOT EXISTS ai_team_runs (
              run_id TEXT PRIMARY KEY,
              team_id TEXT NOT NULL,
              requirement TEXT NOT NULL,
              stage TEXT NOT NULL,
              auto_mode INTEGER NOT NULL DEFAULT 1,
              last_action TEXT,
              final_answer TEXT,
              last_error TEXT,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );
            "#,
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn ai_team_role_label(role_key: &str) -> &'static str {
    match role_key.trim().to_lowercase().as_str() {
        "analyst" => "AI角色1",
        "coder" => "AI角色2",
        _ => "AI角色",
    }
}

fn ai_team_role_order(role_key: &str) -> usize {
    match role_key.trim().to_lowercase().as_str() {
        "analyst" => 0,
        "coder" => 1,
        _ => 99,
    }
}

fn normalize_ai_team_role_key(role_key: &str) -> Result<String, String> {
    let normalized = role_key.trim().to_lowercase();
    match normalized.as_str() {
        "analyst" | "coder" => Ok(normalized),
        _ => Err(format!("unsupported ai team role: {}", role_key)),
    }
}

fn normalize_ai_team_role_phase(raw: &str) -> AiTeamRolePhase {
    match raw.trim().to_lowercase().as_str() {
        "initialized" => AiTeamRolePhase::Initialized,
        "binding_sid" => AiTeamRolePhase::BindingSid,
        "ready" => AiTeamRolePhase::Ready,
        "running" => AiTeamRolePhase::Running,
        "error" => AiTeamRolePhase::Error,
        _ => AiTeamRolePhase::Draft,
    }
}

fn ai_team_role_phase_key(phase: AiTeamRolePhase) -> &'static str {
    match phase {
        AiTeamRolePhase::Draft => "draft",
        AiTeamRolePhase::Initialized => "initialized",
        AiTeamRolePhase::BindingSid => "binding_sid",
        AiTeamRolePhase::Ready => "ready",
        AiTeamRolePhase::Running => "running",
        AiTeamRolePhase::Error => "error",
    }
}

fn normalize_ai_team_run_stage(raw: &str) -> AiTeamRunStage {
    match raw.trim().to_lowercase().as_str() {
        "analyst_dispatched" => AiTeamRunStage::AnalystDispatched,
        "waiting_analyst" => AiTeamRunStage::WaitingAnalyst,
        "coder_dispatched" => AiTeamRunStage::CoderDispatched,
        "waiting_coder" => AiTeamRunStage::WaitingCoder,
        "analyst_review_dispatched" => AiTeamRunStage::AnalystReviewDispatched,
        "finished" => AiTeamRunStage::Finished,
        "failed" => AiTeamRunStage::Failed,
        _ => AiTeamRunStage::Created,
    }
}

fn ai_team_run_stage_key(stage: AiTeamRunStage) -> &'static str {
    match stage {
        AiTeamRunStage::Created => "created",
        AiTeamRunStage::AnalystDispatched => "analyst_dispatched",
        AiTeamRunStage::WaitingAnalyst => "waiting_analyst",
        AiTeamRunStage::CoderDispatched => "coder_dispatched",
        AiTeamRunStage::WaitingCoder => "waiting_coder",
        AiTeamRunStage::AnalystReviewDispatched => "analyst_review_dispatched",
        AiTeamRunStage::Finished => "finished",
        AiTeamRunStage::Failed => "failed",
    }
}

fn upsert_ai_team_team_db(
    path: &Path,
    team_id: &str,
    name: &str,
    project_directory: &str,
    runtime_directory: &str,
    created_at: i64,
) -> Result<(), String> {
    let connection = open_db(path).map_err(|error| error.to_string())?;
    connection
        .execute(
            r#"
            INSERT INTO ai_team_teams
              (team_id, name, project_directory, runtime_directory, created_at, updated_at)
            VALUES
              (?1, ?2, ?3, ?4, ?5, ?6)
            ON CONFLICT(team_id)
            DO UPDATE SET
              name = excluded.name,
              project_directory = excluded.project_directory,
              runtime_directory = excluded.runtime_directory,
              updated_at = excluded.updated_at
            "#,
            params![
                team_id,
                name,
                project_directory,
                runtime_directory,
                created_at,
                now_epoch()
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn load_ai_team_team_row_db(path: &Path, team_id: &str) -> Result<AiTeamTeamRow, String> {
    let connection = open_db(path).map_err(|error| error.to_string())?;
    connection
        .query_row(
            r#"
            SELECT team_id, name, project_directory, runtime_directory, created_at, updated_at
            FROM ai_team_teams
            WHERE team_id = ?1
            "#,
            params![team_id],
            |row| {
                Ok(AiTeamTeamRow {
                    team_id: row.get(0)?,
                    name: row.get(1)?,
                    project_directory: row.get(2)?,
                    runtime_directory: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            },
        )
        .map_err(|error| error.to_string())
}

fn upsert_ai_team_role_definition_db(
    path: &Path,
    team_id: &str,
    role_key: &str,
    provider: &str,
    work_directory: &str,
) -> Result<(), String> {
    let now = now_epoch();
    let connection = open_db(path).map_err(|error| error.to_string())?;
    connection
        .execute(
            r#"
            INSERT INTO ai_team_roles
              (team_id, role_key, provider, pane_id, session_id, work_directory, phase, last_sent_at, last_read_at, last_error, updated_at)
            VALUES
              (?1, ?2, ?3, '', '', ?4, 'draft', 0, 0, NULL, ?5)
            ON CONFLICT(team_id, role_key)
            DO UPDATE SET
              provider = excluded.provider,
              work_directory = excluded.work_directory,
              updated_at = excluded.updated_at
            "#,
            params![team_id, role_key, provider.trim().to_lowercase(), work_directory, now],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn load_ai_team_role_row_db(
    path: &Path,
    team_id: &str,
    role_key: &str,
) -> Result<AiTeamRoleRow, String> {
    let connection = open_db(path).map_err(|error| error.to_string())?;
    connection
        .query_row(
            r#"
            SELECT team_id, role_key, provider, pane_id, session_id, work_directory, phase, last_sent_at, last_read_at, last_error, updated_at
            FROM ai_team_roles
            WHERE team_id = ?1 AND role_key = ?2
            "#,
            params![team_id, role_key],
            |row| {
                Ok(AiTeamRoleRow {
                    team_id: row.get(0)?,
                    role_key: row.get(1)?,
                    provider: row.get(2)?,
                    pane_id: row.get(3)?,
                    session_id: row.get(4)?,
                    work_directory: row.get(5)?,
                    phase: row.get(6)?,
                    last_sent_at: row.get(7)?,
                    last_read_at: row.get(8)?,
                    last_error: row.get(9)?,
                    updated_at: row.get(10)?,
                })
            },
        )
        .map_err(|error| error.to_string())
}

fn list_ai_team_role_rows_db(path: &Path, team_id: &str) -> Result<Vec<AiTeamRoleRow>, String> {
    let connection = open_db(path).map_err(|error| error.to_string())?;
    let mut stmt = connection
        .prepare(
            r#"
            SELECT team_id, role_key, provider, pane_id, session_id, work_directory, phase, last_sent_at, last_read_at, last_error, updated_at
            FROM ai_team_roles
            WHERE team_id = ?1
            ORDER BY role_key ASC
            "#,
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(params![team_id], |row| {
            Ok(AiTeamRoleRow {
                team_id: row.get(0)?,
                role_key: row.get(1)?,
                provider: row.get(2)?,
                pane_id: row.get(3)?,
                session_id: row.get(4)?,
                work_directory: row.get(5)?,
                phase: row.get(6)?,
                last_sent_at: row.get(7)?,
                last_read_at: row.get(8)?,
                last_error: row.get(9)?,
                updated_at: row.get(10)?,
            })
        })
        .map_err(|error| error.to_string())?;

    let mut items = Vec::new();
    for row in rows {
        items.push(row.map_err(|error| error.to_string())?);
    }
    items.sort_by_key(|item| ai_team_role_order(&item.role_key));
    Ok(items)
}

fn role_session_id_used_by_other_role(
    path: &Path,
    team_id: &str,
    role_key: &str,
    session_id: &str,
) -> Result<bool, String> {
    let normalized = session_id.trim();
    if normalized.is_empty() {
        return Ok(false);
    }
    let roles = list_ai_team_role_rows_db(path, team_id)?;
    Ok(roles
        .into_iter()
        .any(|item| item.role_key != role_key && item.session_id.trim() == normalized))
}

fn save_ai_team_role_row_db(path: &Path, row: &AiTeamRoleRow) -> Result<(), String> {
    let connection = open_db(path).map_err(|error| error.to_string())?;
    connection
        .execute(
            r#"
            UPDATE ai_team_roles
            SET provider = ?3,
                pane_id = ?4,
                session_id = ?5,
                work_directory = ?6,
                phase = ?7,
                last_sent_at = ?8,
                last_read_at = ?9,
                last_error = ?10,
                updated_at = ?11
            WHERE team_id = ?1 AND role_key = ?2
            "#,
            params![
                row.team_id,
                row.role_key,
                row.provider,
                row.pane_id,
                row.session_id,
                row.work_directory,
                row.phase,
                row.last_sent_at,
                row.last_read_at,
                row.last_error,
                row.updated_at,
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn mutate_ai_team_role_db<F>(
    path: &Path,
    team_id: &str,
    role_key: &str,
    mutator: F,
) -> Result<AiTeamRoleRow, String>
where
    F: FnOnce(&mut AiTeamRoleRow),
{
    let mut row = load_ai_team_role_row_db(path, team_id, role_key)?;
    mutator(&mut row);
    row.updated_at = now_epoch();
    save_ai_team_role_row_db(path, &row)?;
    Ok(row)
}

fn load_ai_team_run_db(path: &Path, run_id: &str) -> Result<AiTeamRunSnapshot, String> {
    let connection = open_db(path).map_err(|error| error.to_string())?;
    connection
        .query_row(
            r#"
            SELECT run_id, team_id, requirement, stage, auto_mode, last_action, final_answer, last_error, created_at, updated_at
            FROM ai_team_runs
            WHERE run_id = ?1
            "#,
            params![run_id],
            |row| {
                Ok(AiTeamRunSnapshot {
                    run_id: row.get(0)?,
                    team_id: row.get(1)?,
                    requirement: row.get(2)?,
                    stage: normalize_ai_team_run_stage(&row.get::<usize, String>(3)?),
                    auto_mode: row.get::<usize, i64>(4)? > 0,
                    last_action: row.get(5)?,
                    final_answer: row.get(6)?,
                    last_error: row.get(7)?,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                })
            },
        )
        .map_err(|error| error.to_string())
}

fn load_latest_ai_team_run_db(
    path: &Path,
    team_id: &str,
) -> Result<Option<AiTeamRunSnapshot>, String> {
    let connection = open_db(path).map_err(|error| error.to_string())?;
    connection
        .query_row(
            r#"
            SELECT run_id, team_id, requirement, stage, auto_mode, last_action, final_answer, last_error, created_at, updated_at
            FROM ai_team_runs
            WHERE team_id = ?1
            ORDER BY updated_at DESC, created_at DESC, rowid DESC
            LIMIT 1
            "#,
            params![team_id],
            |row| {
                Ok(AiTeamRunSnapshot {
                    run_id: row.get(0)?,
                    team_id: row.get(1)?,
                    requirement: row.get(2)?,
                    stage: normalize_ai_team_run_stage(&row.get::<usize, String>(3)?),
                    auto_mode: row.get::<usize, i64>(4)? > 0,
                    last_action: row.get(5)?,
                    final_answer: row.get(6)?,
                    last_error: row.get(7)?,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn save_ai_team_run_db(path: &Path, run: &AiTeamRunSnapshot) -> Result<(), String> {
    let connection = open_db(path).map_err(|error| error.to_string())?;
    connection
        .execute(
            r#"
            INSERT INTO ai_team_runs
              (run_id, team_id, requirement, stage, auto_mode, last_action, final_answer, last_error, created_at, updated_at)
            VALUES
              (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            ON CONFLICT(run_id)
            DO UPDATE SET
              team_id = excluded.team_id,
              requirement = excluded.requirement,
              stage = excluded.stage,
              auto_mode = excluded.auto_mode,
              last_action = excluded.last_action,
              final_answer = excluded.final_answer,
              last_error = excluded.last_error,
              updated_at = excluded.updated_at
            "#,
            params![
                run.run_id,
                run.team_id,
                run.requirement,
                ai_team_run_stage_key(run.stage),
                if run.auto_mode { 1_i64 } else { 0_i64 },
                run.last_action,
                run.final_answer,
                run.last_error,
                run.created_at,
                run.updated_at,
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn is_ai_team_run_done(stage: AiTeamRunStage) -> bool {
    matches!(stage, AiTeamRunStage::Finished | AiTeamRunStage::Failed)
}

fn role_runtime_ready(state: &AppState, pane_id: &str) -> bool {
    if pane_id.trim().is_empty() {
        return false;
    }
    state
        .panes
        .lock()
        .map(|items| items.contains_key(pane_id))
        .unwrap_or(false)
}

fn resolve_role_session_id(state: &AppState, row: &AiTeamRoleRow) -> String {
    if !row.session_id.trim().is_empty() {
        return row.session_id.trim().to_string();
    }
    if row.pane_id.trim().is_empty() {
        return String::new();
    }
    load_pane_session_state_db(&state.db_path, &row.pane_id)
        .map(|item| item.active_session_id.trim().to_string())
        .unwrap_or_default()
}

fn load_cached_native_preview_rows(
    state: &AppState,
    native_provider: &str,
    matcher: Option<&SessionFileMatcher>,
    session_id: &str,
) -> Result<Vec<NativeSessionPreviewRow>, String> {
    let cache_ttl_secs = session_cache_ttl_secs(state);
    let cache_key = build_native_preview_cache_key(native_provider, matcher, session_id);
    let now = now_epoch();

    let all_rows = if let Ok(cache) = state.native_session_preview_cache.lock() {
        if let Some(hit) = cache.get(&cache_key) {
            if cache_ttl_secs > 0 && now.saturating_sub(hit.updated_at) <= cache_ttl_secs {
                hit.rows.clone()
            } else {
                collect_native_session_preview_rows_for_provider(
                    state,
                    native_provider,
                    session_id,
                    matcher,
                )
                .map_err(|error| error.to_string())?
            }
        } else {
            collect_native_session_preview_rows_for_provider(
                state,
                native_provider,
                session_id,
                matcher,
            )
            .map_err(|error| error.to_string())?
        }
    } else {
        collect_native_session_preview_rows_for_provider(
            state,
            native_provider,
            session_id,
            matcher,
        )
        .map_err(|error| error.to_string())?
    };

    if let Ok(mut cache) = state.native_session_preview_cache.lock() {
        cache.insert(
            cache_key,
            NativeSessionPreviewCache {
                updated_at: now,
                rows: all_rows.clone(),
            },
        );
    }
    Ok(all_rows)
}

fn load_role_preview_rows(
    state: &AppState,
    row: &AiTeamRoleRow,
) -> Result<Vec<NativeSessionPreviewRow>, String> {
    let pane_id = row.pane_id.trim();
    let session_id = resolve_role_session_id(state, row);
    if pane_id.is_empty() || session_id.is_empty() {
        return Ok(Vec::new());
    }
    let provider = load_provider(&state.db_path, pane_id).map_err(|error| error.to_string())?;
    let scan_config = resolve_pane_scan_config(state, pane_id, &provider)?;
    let matcher = SessionFileMatcher::from_raw(&scan_config.file_glob);
    let mut rows = load_cached_native_preview_rows(
        state,
        &scan_config.parser_profile,
        matcher.as_ref(),
        &session_id,
    )?;
    rows.sort_by_key(|item| item.created_at);
    Ok(rows)
}

fn compute_role_status_from_row(
    state: &AppState,
    row: &AiTeamRoleRow,
    idle_threshold_secs: i64,
) -> Result<AiTeamConversationStatusResponse, String> {
    let runtime_ready = role_runtime_ready(state, &row.pane_id);
    let session_id = resolve_role_session_id(state, row);
    if row.pane_id.trim().is_empty() || session_id.is_empty() {
        return Ok(AiTeamConversationStatusResponse {
            role: row.role_key.clone(),
            session_id,
            runtime_ready,
            responding: false,
            completed: false,
            idle_secs: 0,
            last_input_at: 0,
            last_output_at: 0,
        });
    }

    let rows = load_role_preview_rows(state, row)?;
    let threshold = idle_threshold_secs.max(1);
    let now = now_epoch();
    let mut last_input_any = 0_i64;
    let mut last_output_any = 0_i64;
    let mut last_input_after_send = 0_i64;
    let mut last_output_after_send = 0_i64;

    for item in rows {
        match item.kind.trim().to_lowercase().as_str() {
            "input" => {
                last_input_any = last_input_any.max(item.created_at);
                if row.last_sent_at > 0 && item.created_at >= row.last_sent_at {
                    last_input_after_send = last_input_after_send.max(item.created_at);
                }
            }
            "output" => {
                last_output_any = last_output_any.max(item.created_at);
                if row.last_sent_at > 0 && item.created_at >= row.last_sent_at {
                    last_output_after_send = last_output_after_send.max(item.created_at);
                }
            }
            _ => {}
        }
    }

    if row.last_sent_at > 0 {
        if last_output_after_send > 0 {
            let idle_secs = now.saturating_sub(last_output_after_send);
            return Ok(AiTeamConversationStatusResponse {
                role: row.role_key.clone(),
                session_id,
                runtime_ready,
                responding: idle_secs < threshold,
                completed: idle_secs >= threshold,
                idle_secs,
                last_input_at: last_input_after_send,
                last_output_at: last_output_after_send,
            });
        }

        return Ok(AiTeamConversationStatusResponse {
            role: row.role_key.clone(),
            session_id,
            runtime_ready,
            responding: runtime_ready,
            completed: false,
            idle_secs: now.saturating_sub(row.last_sent_at),
            last_input_at: last_input_after_send,
            last_output_at: 0,
        });
    }

    let latest = last_input_any.max(last_output_any);
    let idle_secs = if latest > 0 {
        now.saturating_sub(latest)
    } else {
        0
    };
    Ok(AiTeamConversationStatusResponse {
        role: row.role_key.clone(),
        session_id,
        runtime_ready,
        responding: last_input_any > last_output_any && idle_secs < threshold,
        completed: last_output_any >= last_input_any
            && last_output_any > 0
            && idle_secs >= threshold,
        idle_secs,
        last_input_at: last_input_any,
        last_output_at: last_output_any,
    })
}

fn build_role_snapshot(state: &AppState, row: &AiTeamRoleRow) -> AiTeamRoleSnapshot {
    let session_id = resolve_role_session_id(state, row);
    let runtime_ready = role_runtime_ready(state, &row.pane_id);
    let status = compute_role_status_from_row(state, row, 5).ok();
    AiTeamRoleSnapshot {
        role_key: row.role_key.clone(),
        name: ai_team_role_label(&row.role_key).to_string(),
        provider: row.provider.clone(),
        pane_id: row.pane_id.clone(),
        session_id: session_id.clone(),
        work_directory: row.work_directory.clone(),
        phase: normalize_ai_team_role_phase(&row.phase),
        runtime_ready,
        sid_bound: !session_id.is_empty(),
        responding: status.as_ref().map(|item| item.responding).unwrap_or(false),
        completed: status.as_ref().map(|item| item.completed).unwrap_or(false),
        idle_secs: status.as_ref().map(|item| item.idle_secs).unwrap_or(0),
        last_input_at: status.as_ref().map(|item| item.last_input_at).unwrap_or(0),
        last_output_at: status.as_ref().map(|item| item.last_output_at).unwrap_or(0),
        last_error: row.last_error.clone(),
    }
}

fn load_ai_team_snapshot_db(
    state: &AppState,
    team_id: &str,
) -> Result<AiTeamSnapshotResponse, String> {
    ensure_ai_team_schema(&state.db_path)?;
    let team = load_ai_team_team_row_db(&state.db_path, team_id)?;
    let roles = list_ai_team_role_rows_db(&state.db_path, team_id)?;
    let role_snapshots = roles
        .iter()
        .map(|item| build_role_snapshot(state, item))
        .collect::<Vec<_>>();
    let active_run = load_latest_ai_team_run_db(&state.db_path, team_id)?;
    let _timestamps = (team.created_at, team.updated_at);
    Ok(AiTeamSnapshotResponse {
        team_id: team.team_id,
        name: team.name,
        project_directory: team.project_directory,
        runtime_directory: team.runtime_directory,
        roles: role_snapshots,
        active_run,
    })
}

fn role_sid_response(state: &AppState, row: &AiTeamRoleRow) -> AiTeamRoleSidResponse {
    let session_id = resolve_role_session_id(state, row);
    AiTeamRoleSidResponse {
        role: row.role_key.clone(),
        pane_id: row.pane_id.clone(),
        session_id: session_id.clone(),
        sid_bound: !session_id.is_empty(),
    }
}

fn ensure_ai_team_role_pane(
    app: &AppHandle,
    state: &AppState,
    team_id: &str,
    role_key: &str,
) -> Result<(String, bool), String> {
    let role = load_ai_team_role_row_db(&state.db_path, team_id, role_key)?;
    if !role.pane_id.trim().is_empty() && load_provider(&state.db_path, &role.pane_id).is_ok() {
        start_runtime(app, state, role.pane_id.clone(), role.provider.clone())
            .map_err(|error| error.to_string())?;
        return Ok((role.pane_id, false));
    }

    let team = load_ai_team_team_row_db(&state.db_path, team_id)?;
    let now = now_epoch();
    let pane = PaneSummary {
        id: Uuid::new_v4().to_string(),
        provider: role.provider.clone(),
        title: format!("{} {}", team.name, ai_team_role_label(role_key)),
        created_at: now,
        updated_at: now,
    };
    insert_pane(&state.db_path, &pane).map_err(|error| error.to_string())?;
    upsert_pane_scan_config_db(
        &state.db_path,
        &pane.id,
        Some(role.provider.clone()),
        None,
        &role.provider,
    )
    .map_err(|error| error.to_string())?;
    start_runtime(app, state, pane.id.clone(), pane.provider.clone())
        .map_err(|error| error.to_string())?;
    mutate_ai_team_role_db(&state.db_path, team_id, role_key, |item| {
        item.pane_id = pane.id.clone();
        item.session_id.clear();
        item.phase = ai_team_role_phase_key(AiTeamRolePhase::Initialized).to_string();
        item.last_error = None;
    })?;
    Ok((pane.id, true))
}

fn launch_role_provider_shell(
    state: &AppState,
    team_id: &str,
    role_key: &str,
) -> Result<(), String> {
    let role = load_ai_team_role_row_db(&state.db_path, team_id, role_key)?;
    if role.pane_id.trim().is_empty() {
        return Err(format!("role {} has no pane yet", role_key));
    }
    let bridge = resolve_chat_bridge(&state.adapter_config_dir, &role.provider)?;
    paste_to_pane_internal(state, &role.pane_id, bridge.command(), true)
        .map_err(|error| error.to_string())?;
    let _ = upsert_pane_session_state_db(
        &state.db_path,
        &role.pane_id,
        Some(String::new()),
        Some(Vec::new()),
        Some(false),
    );
    mutate_ai_team_role_db(&state.db_path, team_id, role_key, |item| {
        item.session_id.clear();
        item.phase = ai_team_role_phase_key(AiTeamRolePhase::Initialized).to_string();
        item.last_error = None;
    })?;
    Ok(())
}

fn suggest_role_session_id(
    state: &AppState,
    pane_id: &str,
    timeout_secs: i64,
) -> Result<Option<String>, String> {
    let provider = load_provider(&state.db_path, pane_id).map_err(|error| error.to_string())?;
    detect_pane_session_id_via_status_inner(state, pane_id, &provider, Some(timeout_secs))
}

fn bind_role_sid_inner(
    state: &AppState,
    team_id: &str,
    role_key: &str,
    hello_message: &str,
    timeout_secs: i64,
) -> Result<(AiTeamRoleSnapshot, bool), String> {
    let normalized_role = normalize_ai_team_role_key(role_key)?;
    let role = load_ai_team_role_row_db(&state.db_path, team_id, &normalized_role)?;
    if role.pane_id.trim().is_empty() {
        return Err(format!(
            "role {} has no pane yet, please initialize first",
            normalized_role
        ));
    }
    if !role.session_id.trim().is_empty()
        && !role_session_id_used_by_other_role(
            &state.db_path,
            team_id,
            &normalized_role,
            &role.session_id,
        )?
    {
        let updated = mutate_ai_team_role_db(&state.db_path, team_id, &normalized_role, |item| {
            item.phase = ai_team_role_phase_key(AiTeamRolePhase::Ready).to_string();
            item.last_error = None;
        })?;
        upsert_pane_session_state_db(
            &state.db_path,
            &updated.pane_id,
            Some(updated.session_id.clone()),
            Some(Vec::new()),
            Some(false),
        )
        .map_err(|error| error.to_string())?;
        return Ok((build_role_snapshot(state, &updated), true));
    }
    paste_to_pane_internal(state, &role.pane_id, hello_message.trim(), true)
        .map_err(|error| error.to_string())?;
    let sent_at = now_epoch();
    mutate_ai_team_role_db(&state.db_path, team_id, &normalized_role, |item| {
        item.last_sent_at = sent_at;
        item.phase = ai_team_role_phase_key(AiTeamRolePhase::BindingSid).to_string();
        item.last_error = None;
    })?;

    let suggested = suggest_role_session_id(state, &role.pane_id, timeout_secs)?;
    let next_sid = suggested.unwrap_or_default().trim().to_string();
    if !next_sid.is_empty() {
        if role_session_id_used_by_other_role(&state.db_path, team_id, &normalized_role, &next_sid)?
        {
            let updated =
                mutate_ai_team_role_db(&state.db_path, team_id, &normalized_role, |item| {
                    item.phase = ai_team_role_phase_key(AiTeamRolePhase::Error).to_string();
                    item.last_error = Some("session id already used by other role".to_string());
                })?;
            return Ok((build_role_snapshot(state, &updated), false));
        }
        upsert_pane_session_state_db(
            &state.db_path,
            &role.pane_id,
            Some(next_sid.clone()),
            Some(Vec::new()),
            Some(false),
        )
        .map_err(|error| error.to_string())?;
        let updated = mutate_ai_team_role_db(&state.db_path, team_id, &normalized_role, |item| {
            item.session_id = next_sid.clone();
            item.phase = ai_team_role_phase_key(AiTeamRolePhase::Ready).to_string();
            item.last_error = None;
        })?;
        return Ok((build_role_snapshot(state, &updated), true));
    }

    let updated = mutate_ai_team_role_db(&state.db_path, team_id, &normalized_role, |item| {
        item.phase = ai_team_role_phase_key(AiTeamRolePhase::Error).to_string();
        item.last_error = Some("timeout waiting for session id from /status".to_string());
    })?;
    Ok((build_role_snapshot(state, &updated), false))
}

fn refresh_role_sid_inner(
    state: &AppState,
    team_id: &str,
    role_key: &str,
) -> Result<AiTeamRoleSidResponse, String> {
    let normalized_role = normalize_ai_team_role_key(role_key)?;
    let role = load_ai_team_role_row_db(&state.db_path, team_id, &normalized_role)?;
    if role.pane_id.trim().is_empty() {
        return Err(format!(
            "role {} has no pane yet, please initialize first",
            normalized_role
        ));
    }

    let suggested =
        suggest_role_session_id(state, &role.pane_id, STATUS_SESSION_DETECT_TIMEOUT_SECS)?;
    let next_sid = suggested.unwrap_or_default().trim().to_string();
    if !next_sid.is_empty() {
        if role_session_id_used_by_other_role(&state.db_path, team_id, &normalized_role, &next_sid)?
        {
            return Ok(role_sid_response(state, &role));
        }
        upsert_pane_session_state_db(
            &state.db_path,
            &role.pane_id,
            Some(next_sid.clone()),
            Some(Vec::new()),
            Some(false),
        )
        .map_err(|error| error.to_string())?;
        let updated = mutate_ai_team_role_db(&state.db_path, team_id, &normalized_role, |item| {
            item.session_id = next_sid.clone();
            item.phase = ai_team_role_phase_key(AiTeamRolePhase::Ready).to_string();
            item.last_error = None;
        })?;
        return Ok(role_sid_response(state, &updated));
    }

    upsert_pane_session_state_db(
        &state.db_path,
        &role.pane_id,
        Some(String::new()),
        Some(Vec::new()),
        Some(false),
    )
    .map_err(|error| error.to_string())?;
    let updated = mutate_ai_team_role_db(&state.db_path, team_id, &normalized_role, |item| {
        item.session_id.clear();
        item.phase = ai_team_role_phase_key(AiTeamRolePhase::Error).to_string();
        item.last_error = Some("unable to read current session id from status output".to_string());
    })?;
    Ok(role_sid_response(state, &updated))
}

fn send_role_hello_inner(
    state: &AppState,
    team_id: &str,
    role_key: &str,
    hello_message: &str,
) -> Result<AiTeamSendHelloResponse, String> {
    let normalized_role = normalize_ai_team_role_key(role_key)?;
    let role = load_ai_team_role_row_db(&state.db_path, team_id, &normalized_role)?;
    if role.pane_id.trim().is_empty() {
        return Err(format!(
            "role {} has no pane yet, please initialize first",
            normalized_role
        ));
    }
    paste_to_pane_internal(state, &role.pane_id, hello_message.trim(), true)
        .map_err(|error| error.to_string())?;
    let sent_at = now_epoch();
    let _ = mutate_ai_team_role_db(&state.db_path, team_id, &normalized_role, |item| {
        item.last_sent_at = sent_at;
        item.phase = ai_team_role_phase_key(AiTeamRolePhase::BindingSid).to_string();
        item.last_error = None;
    });
    Ok(AiTeamSendHelloResponse {
        accepted: true,
        pane_id: role.pane_id,
        role: normalized_role,
        sent_at,
    })
}

fn send_role_message_inner(
    state: &AppState,
    team_id: &str,
    role_key: &str,
    message: &str,
    submit: bool,
) -> Result<AiTeamSendMessageResponse, String> {
    let normalized_role = normalize_ai_team_role_key(role_key)?;
    let role = load_ai_team_role_row_db(&state.db_path, team_id, &normalized_role)?;
    if role.pane_id.trim().is_empty() {
        return Err(format!(
            "role {} has no pane yet, please initialize first",
            normalized_role
        ));
    }
    let session_id = resolve_role_session_id(state, &role);
    if session_id.is_empty() {
        return Err(format!(
            "role {} has no session id yet, please bind sid first",
            normalized_role
        ));
    }
    paste_to_pane_internal(state, &role.pane_id, message, submit)
        .map_err(|error| error.to_string())?;
    let sent_at = now_epoch();
    mutate_ai_team_role_db(&state.db_path, team_id, &normalized_role, |item| {
        item.last_sent_at = sent_at;
        item.phase = ai_team_role_phase_key(AiTeamRolePhase::Running).to_string();
        item.last_error = None;
    })?;
    Ok(AiTeamSendMessageResponse {
        accepted: true,
        pane_id: role.pane_id,
        session_id,
        role: normalized_role,
        sent_at,
    })
}

fn load_role_conversation_inner(
    state: &AppState,
    team_id: &str,
    role_key: &str,
    limit: i64,
    offset: i64,
    from_end: bool,
) -> Result<AiTeamConversationResponse, String> {
    let normalized_role = normalize_ai_team_role_key(role_key)?;
    let role = load_ai_team_role_row_db(&state.db_path, team_id, &normalized_role)?;
    let session_id = resolve_role_session_id(state, &role);
    if role.pane_id.trim().is_empty() || session_id.is_empty() {
        return Ok(AiTeamConversationResponse {
            role: normalized_role,
            session_id,
            rows: Vec::new(),
            total_rows: 0,
            loaded_rows: 0,
            has_more: false,
        });
    }
    let since_at = role.last_sent_at;
    let all_rows = load_role_preview_rows(state, &role)?
        .into_iter()
        .filter(|item| since_at <= 0 || item.created_at >= since_at)
        .collect::<Vec<_>>();
    let total_rows = all_rows.len() as i64;
    let message_limit = limit.clamp(1, 5000) as usize;
    let message_offset = offset.max(0) as usize;
    let (rows, has_more) = if from_end {
        let total = all_rows.len();
        let end = total.saturating_sub(message_offset);
        let start = end.saturating_sub(message_limit);
        let has_more = start > 0;
        (
            all_rows
                .into_iter()
                .skip(start)
                .take(end.saturating_sub(start))
                .collect::<Vec<_>>(),
            has_more,
        )
    } else {
        let start = message_offset.min(all_rows.len());
        let end = (start + message_limit).min(all_rows.len());
        let has_more = end < all_rows.len();
        (
            all_rows
                .into_iter()
                .skip(start)
                .take(end.saturating_sub(start))
                .collect::<Vec<_>>(),
            has_more,
        )
    };

    Ok(AiTeamConversationResponse {
        role: normalized_role,
        session_id,
        loaded_rows: rows.len() as i64,
        total_rows,
        has_more,
        rows,
    })
}

fn read_role_output_since(
    state: &AppState,
    row: &AiTeamRoleRow,
    since_at: i64,
) -> Result<(String, i64), String> {
    let rows = load_role_preview_rows(state, row)?;
    let mut pieces = Vec::new();
    let mut last_seen = 0_i64;
    for item in rows {
        if item.kind.trim().eq_ignore_ascii_case("output") && item.created_at >= since_at {
            if !item.content.trim().is_empty() {
                pieces.push(item.content.trim().to_string());
            }
            last_seen = last_seen.max(item.created_at);
        }
    }
    Ok((pieces.join("\n\n"), last_seen))
}

fn extract_json_block<T: DeserializeOwned>(
    content: &str,
    start_tag: &str,
    end_tag: &str,
) -> Option<T> {
    let start = content.rfind(start_tag)?;
    let suffix = &content[start + start_tag.len()..];
    let end = suffix.find(end_tag)?;
    let payload = suffix[..end].trim();
    serde_json::from_str(payload).ok()
}

fn extract_action_block(content: &str) -> Option<AiTeamActionEnvelope> {
    extract_json_block(content, "<ai_team_action>", "</ai_team_action>")
}

fn extract_final_block(content: &str) -> Option<AiTeamFinalEnvelope> {
    extract_json_block(content, "<ai_team_final>", "</ai_team_final>")
}

fn build_analyst_requirement_prompt(
    snapshot: &AiTeamSnapshotResponse,
    requirement: &str,
) -> String {
    let coder_sid = snapshot
        .roles
        .iter()
        .find(|item| item.role_key == "coder")
        .map(|item| item.session_id.clone())
        .unwrap_or_default();
    [
        "你是 AI角色1，负责分析用户需求、拆解任务、必要时调度 AI角色2，并最终汇总结果。".to_string(),
        format!("项目目录：{}", snapshot.project_directory),
        format!(
            "AI角色2 当前 SID：{}",
            if coder_sid.is_empty() { "(未绑定)" } else { &coder_sid }
        ),
        "你可用的能力概念如下：read_role_sid(role)、load_conversation(role, limit)、is_conversation_finished(role)、send_message(role, message)。当前版本由系统代理执行这些能力。".to_string(),
        "如果你需要调度 AI角色2，请严格输出一个动作块：<ai_team_action>{\"action\":\"delegate\",\"target\":\"coder\",\"message\":\"具体任务\"}</ai_team_action>".to_string(),
        "如果你已经可以给出最终结论，请严格输出一个完成块：<ai_team_final>{\"summary\":\"最终结论\",\"files\":[\"涉及文件\"],\"done\":true}</ai_team_final>".to_string(),
        format!("用户需求如下：\n{}", requirement.trim()),
        "请开始分析。若需要 AI角色2，就输出 delegate 动作；若不需要，就直接输出 final 完成块。".to_string(),
    ]
    .join("\n\n")
}

fn build_coder_prompt(message: &str, project_directory: &str) -> String {
    [
        "你是 AI角色2，只负责执行具体编码任务。".to_string(),
        format!("当前项目目录：{}", project_directory),
        "请围绕任务直接执行，并在回答中清楚说明：1. 改了什么 2. 改了哪些文件 3. 是否做了验证 4. 还剩什么问题。不要输出 ai_team_action 或 ai_team_final 标签。".to_string(),
        format!("AI角色1 分派的任务如下：\n{}", message.trim()),
    ]
    .join("\n\n")
}

fn build_analyst_review_prompt(coder_output: &str) -> String {
    [
        "AI角色2 已返回执行结果，请你进行验收。".to_string(),
        format!("AI角色2 输出如下：\n{}", coder_output.trim()),
        "如果需要继续调度 AI角色2，请再输出 delegate 动作块。".to_string(),
        "如果已经可以结束，请输出 ai_team_final 完成块。".to_string(),
    ]
    .join("\n\n")
}

#[tauri::command]
pub(crate) fn ai_team_create_team(
    state: State<AppState>,
    name: String,
    project_directory: String,
    analyst_provider: String,
    coder_provider: String,
) -> Result<AiTeamCreateTeamResponse, String> {
    ensure_ai_team_schema(&state.db_path)?;
    let project_path = normalize_working_directory(Some(project_directory))
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "project directory is empty".to_string())?;
    let team_id = Uuid::new_v4().to_string();
    let runtime_directory = project_path.join(".ai-team").join(&team_id);
    let analyst_directory = runtime_directory.join("analyst");
    fs::create_dir_all(&analyst_directory).map_err(|error| error.to_string())?;
    let created_at = now_epoch();
    upsert_ai_team_team_db(
        &state.db_path,
        &team_id,
        name.trim(),
        &project_path.to_string_lossy(),
        &runtime_directory.to_string_lossy(),
        created_at,
    )?;
    upsert_ai_team_role_definition_db(
        &state.db_path,
        &team_id,
        "analyst",
        &analyst_provider,
        &analyst_directory.to_string_lossy(),
    )?;
    upsert_ai_team_role_definition_db(
        &state.db_path,
        &team_id,
        "coder",
        &coder_provider,
        &project_path.to_string_lossy(),
    )?;
    Ok(AiTeamCreateTeamResponse {
        snapshot: load_ai_team_snapshot_db(&state, &team_id)?,
    })
}

#[tauri::command]
pub(crate) fn ai_team_get_snapshot(
    state: State<AppState>,
    team_id: String,
) -> Result<AiTeamSnapshotResponse, String> {
    load_ai_team_snapshot_db(&state, &team_id)
}

#[tauri::command]
pub(crate) fn ai_team_initialize_team(
    app: AppHandle,
    state: State<AppState>,
    team_id: String,
) -> Result<AiTeamInitializeTeamResponse, String> {
    ensure_ai_team_schema(&state.db_path)?;
    let mut created_pane_ids = Vec::new();
    for role_key in ["analyst", "coder"] {
        let (pane_id, created) = ensure_ai_team_role_pane(&app, &state, &team_id, role_key)?;
        if created {
            created_pane_ids.push(pane_id.clone());
        }
        let role = load_ai_team_role_row_db(&state.db_path, &team_id, role_key)?;
        if resolve_role_session_id(&state, &role).is_empty() {
            launch_role_provider_shell(&state, &team_id, role_key)?;
        }
        let _ = mutate_ai_team_role_db(&state.db_path, &team_id, role_key, |item| {
            item.phase = ai_team_role_phase_key(AiTeamRolePhase::Initialized).to_string();
            item.last_error = None;
        });
    }
    Ok(AiTeamInitializeTeamResponse {
        snapshot: load_ai_team_snapshot_db(&state, &team_id)?,
        created_pane_ids,
    })
}

#[tauri::command]
pub(crate) fn ai_team_read_role_sid(
    state: State<AppState>,
    team_id: String,
    role_key: String,
) -> Result<AiTeamRoleSidResponse, String> {
    let normalized_role = normalize_ai_team_role_key(&role_key)?;
    let row = load_ai_team_role_row_db(&state.db_path, &team_id, &normalized_role)?;
    Ok(role_sid_response(&state, &row))
}

#[tauri::command]
pub(crate) fn ai_team_set_role_sid(
    state: State<AppState>,
    team_id: String,
    role_key: String,
    session_id: String,
) -> Result<AiTeamRoleSidResponse, String> {
    let normalized_role = normalize_ai_team_role_key(&role_key)?;
    let sid = session_id.trim().to_string();
    if sid.is_empty() {
        return Err("session_id is empty".to_string());
    }
    let role = load_ai_team_role_row_db(&state.db_path, &team_id, &normalized_role)?;
    if role.pane_id.trim().is_empty() {
        return Err(format!(
            "role {} has no pane yet, please initialize first",
            normalized_role
        ));
    }
    if role_session_id_used_by_other_role(&state.db_path, &team_id, &normalized_role, &sid)? {
        return Err(format!("session id already used by other role: {}", sid));
    }
    upsert_pane_session_state_db(
        &state.db_path,
        &role.pane_id,
        Some(sid.clone()),
        Some(Vec::new()),
        Some(false),
    )
    .map_err(|error| error.to_string())?;
    let updated = mutate_ai_team_role_db(&state.db_path, &team_id, &normalized_role, |item| {
        item.session_id = sid.clone();
        item.phase = ai_team_role_phase_key(AiTeamRolePhase::Ready).to_string();
        item.last_error = None;
    })?;
    Ok(role_sid_response(&state, &updated))
}

#[tauri::command]
pub(crate) fn ai_team_clear_role_sid(
    state: State<AppState>,
    team_id: String,
    role_key: String,
) -> Result<AiTeamRoleSidResponse, String> {
    let normalized_role = normalize_ai_team_role_key(&role_key)?;
    let role = load_ai_team_role_row_db(&state.db_path, &team_id, &normalized_role)?;
    if role.pane_id.trim().is_empty() {
        return Err(format!(
            "role {} has no pane yet, please initialize first",
            normalized_role
        ));
    }
    upsert_pane_session_state_db(
        &state.db_path,
        &role.pane_id,
        Some(String::new()),
        Some(Vec::new()),
        Some(false),
    )
    .map_err(|error| error.to_string())?;
    let updated = mutate_ai_team_role_db(&state.db_path, &team_id, &normalized_role, |item| {
        item.session_id.clear();
        item.phase = ai_team_role_phase_key(AiTeamRolePhase::Initialized).to_string();
        item.last_error = Some("session id cleared after frontend probe failed".to_string());
    })?;
    Ok(role_sid_response(&state, &updated))
}

#[tauri::command]
pub(crate) fn ai_team_refresh_role_sid(
    state: State<AppState>,
    team_id: String,
    role_key: String,
) -> Result<AiTeamRoleSidResponse, String> {
    refresh_role_sid_inner(&state, &team_id, &role_key)
}

#[tauri::command]
pub(crate) fn ai_team_send_role_hello(
    state: State<AppState>,
    team_id: String,
    role_key: String,
    hello_message: Option<String>,
) -> Result<AiTeamSendHelloResponse, String> {
    send_role_hello_inner(
        &state,
        &team_id,
        &role_key,
        hello_message.as_deref().unwrap_or("你好"),
    )
}

#[tauri::command]
pub(crate) fn ai_team_send_all_role_hello(
    state: State<AppState>,
    team_id: String,
    hello_message: Option<String>,
) -> Result<AiTeamSendAllHelloResponse, String> {
    let hello = hello_message.unwrap_or_else(|| "你好".to_string());
    let mut sent_roles = Vec::new();
    let mut failed_roles = Vec::new();
    for role_key in ["analyst", "coder"] {
        match send_role_hello_inner(&state, &team_id, role_key, &hello) {
            Ok(_) => sent_roles.push(role_key.to_string()),
            Err(_) => failed_roles.push(role_key.to_string()),
        }
    }
    Ok(AiTeamSendAllHelloResponse {
        snapshot: load_ai_team_snapshot_db(&state, &team_id)?,
        sent_roles,
        failed_roles,
    })
}

#[tauri::command]
pub(crate) fn ai_team_bind_role_sid(
    state: State<AppState>,
    team_id: String,
    role_key: String,
    hello_message: Option<String>,
    timeout_secs: Option<i64>,
) -> Result<AiTeamBindRoleResponse, String> {
    let normalized_role = normalize_ai_team_role_key(&role_key)?;
    let hello = hello_message.unwrap_or_else(|| "你好".to_string());
    let (role, bound) = bind_role_sid_inner(
        &state,
        &team_id,
        &normalized_role,
        hello.trim(),
        timeout_secs.unwrap_or(20),
    )?;
    Ok(AiTeamBindRoleResponse { role, bound })
}

#[tauri::command]
pub(crate) fn ai_team_bind_all_role_sids(
    state: State<AppState>,
    team_id: String,
    hello_message: Option<String>,
    timeout_secs: Option<i64>,
) -> Result<AiTeamBindAllResponse, String> {
    let hello = hello_message.unwrap_or_else(|| "你好".to_string());
    let timeout = timeout_secs.unwrap_or(20);
    let mut bound_roles = Vec::new();
    let mut failed_roles = Vec::new();
    for role_key in ["analyst", "coder"] {
        match bind_role_sid_inner(&state, &team_id, role_key, hello.trim(), timeout) {
            Ok((_, true)) => bound_roles.push(role_key.to_string()),
            Ok((_, false)) => failed_roles.push(role_key.to_string()),
            Err(_) => failed_roles.push(role_key.to_string()),
        }
    }
    Ok(AiTeamBindAllResponse {
        snapshot: load_ai_team_snapshot_db(&state, &team_id)?,
        bound_roles,
        failed_roles,
    })
}

#[tauri::command]
pub(crate) fn ai_team_send_message(
    state: State<AppState>,
    team_id: String,
    role_key: String,
    message: String,
    submit: Option<bool>,
) -> Result<AiTeamSendMessageResponse, String> {
    send_role_message_inner(
        &state,
        &team_id,
        &role_key,
        message.trim(),
        submit.unwrap_or(true),
    )
}

#[tauri::command]
pub(crate) fn ai_team_load_conversation(
    state: State<AppState>,
    team_id: String,
    role_key: String,
    limit: Option<i64>,
    offset: Option<i64>,
    from_end: Option<bool>,
) -> Result<AiTeamConversationResponse, String> {
    load_role_conversation_inner(
        &state,
        &team_id,
        &role_key,
        limit.unwrap_or(50),
        offset.unwrap_or(0),
        from_end.unwrap_or(true),
    )
}

#[tauri::command]
pub(crate) fn ai_team_is_conversation_finished(
    state: State<AppState>,
    team_id: String,
    role_key: String,
    idle_threshold_secs: Option<i64>,
) -> Result<AiTeamConversationStatusResponse, String> {
    let normalized_role = normalize_ai_team_role_key(&role_key)?;
    let row = load_ai_team_role_row_db(&state.db_path, &team_id, &normalized_role)?;
    compute_role_status_from_row(&state, &row, idle_threshold_secs.unwrap_or(5))
}

#[tauri::command]
pub(crate) fn ai_team_submit_requirement(
    state: State<AppState>,
    team_id: String,
    requirement: String,
    auto_mode: Option<bool>,
) -> Result<AiTeamSubmitRequirementResponse, String> {
    ensure_ai_team_schema(&state.db_path)?;
    if requirement.trim().is_empty() {
        return Err("requirement is empty".to_string());
    }
    if let Some(existing) = load_latest_ai_team_run_db(&state.db_path, &team_id)? {
        if !is_ai_team_run_done(existing.stage) {
            return Err("an ai team run is already in progress".to_string());
        }
    }
    let snapshot = load_ai_team_snapshot_db(&state, &team_id)?;
    let analyst = snapshot
        .roles
        .iter()
        .find(|item| item.role_key == "analyst");
    if analyst.map(|item| item.sid_bound).unwrap_or(false) == false {
        return Err("analyst role has no sid yet, please bind sid first".to_string());
    }
    let now = now_epoch();
    let run = AiTeamRunSnapshot {
        run_id: Uuid::new_v4().to_string(),
        team_id: team_id.clone(),
        requirement: requirement.trim().to_string(),
        stage: AiTeamRunStage::WaitingAnalyst,
        auto_mode: auto_mode.unwrap_or(true),
        last_action: Some("sent_to_analyst".to_string()),
        final_answer: None,
        last_error: None,
        created_at: now,
        updated_at: now,
    };
    save_ai_team_run_db(&state.db_path, &run)?;
    let prompt = build_analyst_requirement_prompt(&snapshot, requirement.trim());
    send_role_message_inner(&state, &team_id, "analyst", &prompt, true)?;
    let refreshed = load_ai_team_snapshot_db(&state, &team_id)?;
    Ok(AiTeamSubmitRequirementResponse {
        snapshot: refreshed,
        run,
    })
}

#[tauri::command]
pub(crate) fn ai_team_execute_next(
    state: State<AppState>,
    team_id: String,
    run_id: String,
) -> Result<AiTeamExecuteNextResponse, String> {
    ensure_ai_team_schema(&state.db_path)?;
    let mut run = load_ai_team_run_db(&state.db_path, &run_id)?;
    if run.team_id != team_id {
        return Err("run does not belong to team".to_string());
    }

    if is_ai_team_run_done(run.stage) {
        let snapshot = load_ai_team_snapshot_db(&state, &team_id)?;
        return Ok(AiTeamExecuteNextResponse {
            snapshot,
            run,
            transition: "none".to_string(),
            waiting_role: None,
            done: true,
        });
    }

    match run.stage {
        AiTeamRunStage::Created
        | AiTeamRunStage::AnalystDispatched
        | AiTeamRunStage::WaitingAnalyst
        | AiTeamRunStage::AnalystReviewDispatched => {
            let analyst_row = load_ai_team_role_row_db(&state.db_path, &team_id, "analyst")?;
            let analyst_status = compute_role_status_from_row(&state, &analyst_row, 5)?;
            if !analyst_status.completed {
                let snapshot = load_ai_team_snapshot_db(&state, &team_id)?;
                return Ok(AiTeamExecuteNextResponse {
                    snapshot,
                    run,
                    transition: "waiting_analyst".to_string(),
                    waiting_role: Some("analyst".to_string()),
                    done: false,
                });
            }

            let (analyst_output, last_seen_at) =
                read_role_output_since(&state, &analyst_row, analyst_row.last_sent_at)?;
            let _ = mutate_ai_team_role_db(&state.db_path, &team_id, "analyst", |item| {
                item.last_read_at = last_seen_at;
                item.phase = ai_team_role_phase_key(AiTeamRolePhase::Ready).to_string();
            });

            if let Some(AiTeamActionEnvelope::Delegate { target, message }) =
                extract_action_block(&analyst_output)
            {
                if target.trim().eq_ignore_ascii_case("coder") {
                    let snapshot = load_ai_team_snapshot_db(&state, &team_id)?;
                    let coder_prompt = build_coder_prompt(&message, &snapshot.project_directory);
                    send_role_message_inner(&state, &team_id, "coder", &coder_prompt, true)?;
                    run.stage = AiTeamRunStage::WaitingCoder;
                    run.last_action = Some("delegated_to_coder".to_string());
                    run.updated_at = now_epoch();
                    save_ai_team_run_db(&state.db_path, &run)?;
                    let refreshed = load_ai_team_snapshot_db(&state, &team_id)?;
                    return Ok(AiTeamExecuteNextResponse {
                        snapshot: refreshed,
                        run,
                        transition: "delegated_to_coder".to_string(),
                        waiting_role: Some("coder".to_string()),
                        done: false,
                    });
                }
            }

            let final_summary = extract_final_block(&analyst_output)
                .map(|item| item.summary.trim().to_string())
                .filter(|item| !item.is_empty())
                .unwrap_or_else(|| analyst_output.trim().to_string());
            run.stage = AiTeamRunStage::Finished;
            run.last_action = Some("finished".to_string());
            run.final_answer = Some(final_summary);
            run.updated_at = now_epoch();
            save_ai_team_run_db(&state.db_path, &run)?;
            let snapshot = load_ai_team_snapshot_db(&state, &team_id)?;
            Ok(AiTeamExecuteNextResponse {
                snapshot,
                run,
                transition: "finished".to_string(),
                waiting_role: None,
                done: true,
            })
        }
        AiTeamRunStage::CoderDispatched | AiTeamRunStage::WaitingCoder => {
            let coder_row = load_ai_team_role_row_db(&state.db_path, &team_id, "coder")?;
            let coder_status = compute_role_status_from_row(&state, &coder_row, 5)?;
            if !coder_status.completed {
                let snapshot = load_ai_team_snapshot_db(&state, &team_id)?;
                return Ok(AiTeamExecuteNextResponse {
                    snapshot,
                    run,
                    transition: "waiting_coder".to_string(),
                    waiting_role: Some("coder".to_string()),
                    done: false,
                });
            }

            let (coder_output, last_seen_at) =
                read_role_output_since(&state, &coder_row, coder_row.last_sent_at)?;
            let _ = mutate_ai_team_role_db(&state.db_path, &team_id, "coder", |item| {
                item.last_read_at = last_seen_at;
                item.phase = ai_team_role_phase_key(AiTeamRolePhase::Ready).to_string();
            });
            let review_prompt = build_analyst_review_prompt(&coder_output);
            send_role_message_inner(&state, &team_id, "analyst", &review_prompt, true)?;
            run.stage = AiTeamRunStage::WaitingAnalyst;
            run.last_action = Some("sent_back_to_analyst".to_string());
            run.updated_at = now_epoch();
            save_ai_team_run_db(&state.db_path, &run)?;
            let snapshot = load_ai_team_snapshot_db(&state, &team_id)?;
            Ok(AiTeamExecuteNextResponse {
                snapshot,
                run,
                transition: "sent_back_to_analyst".to_string(),
                waiting_role: Some("analyst".to_string()),
                done: false,
            })
        }
        AiTeamRunStage::Finished | AiTeamRunStage::Failed => {
            let snapshot = load_ai_team_snapshot_db(&state, &team_id)?;
            Ok(AiTeamExecuteNextResponse {
                snapshot,
                run,
                transition: "none".to_string(),
                waiting_role: None,
                done: true,
            })
        }
    }
}
