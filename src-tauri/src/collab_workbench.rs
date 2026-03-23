use super::*;
use rusqlite::{params, OptionalExtension};
use serde::de::DeserializeOwned;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CollabRolePhase {
    Draft,
    Initialized,
    Ready,
    Running,
    Error,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CollabRunStatus {
    Draft,
    Active,
    Completed,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CollabTaskStatus {
    Draft,
    Queued,
    Dispatched,
    Replied,
    Accepted,
    Rejected,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct CollabCapabilityManifestItem {
    key: String,
    label: String,
    description: String,
    source: String,
    manual_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub(crate) struct CollabPromptPack {
    system_prompt: String,
    reply_contract: String,
    can_suggest_followups: bool,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct CollabRoleTemplateResponse {
    template_key: String,
    title: String,
    description: String,
    default_name: String,
    capabilities: Vec<CollabCapabilityManifestItem>,
    prompt_pack: CollabPromptPack,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct CollabRoleSnapshot {
    role_id: String,
    role_key: String,
    template_key: String,
    name: String,
    provider: String,
    pane_id: String,
    session_id: String,
    work_directory: String,
    phase: CollabRolePhase,
    runtime_ready: bool,
    sid_bound: bool,
    responding: bool,
    completed: bool,
    idle_secs: i64,
    last_input_at: i64,
    last_output_at: i64,
    last_error: Option<String>,
    capabilities: Vec<CollabCapabilityManifestItem>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct CollabRunSnapshot {
    run_id: String,
    workbench_id: String,
    title: String,
    goal: String,
    status: CollabRunStatus,
    final_summary: Option<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct CollabTaskCardSnapshot {
    task_id: String,
    workbench_id: String,
    run_id: String,
    source_role_id: Option<String>,
    target_role_id: String,
    title: String,
    goal: String,
    constraints_text: String,
    input_summary: String,
    expected_output: String,
    status: CollabTaskStatus,
    latest_reply_summary: Option<String>,
    latest_artifact_id: Option<String>,
    last_error: Option<String>,
    dependency_task_ids: Vec<String>,
    wave_index: i64,
    plan_order: i64,
    auto_generated: bool,
    validation_summary: Option<String>,
    validation_checked_at: i64,
    created_at: i64,
    dispatched_at: i64,
    replied_at: i64,
    resolved_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct CollabEventSnapshot {
    event_id: String,
    workbench_id: String,
    run_id: Option<String>,
    task_id: Option<String>,
    role_id: Option<String>,
    event_type: String,
    summary: String,
    payload_json: Option<String>,
    created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct CollabArtifactSnapshot {
    artifact_id: String,
    workbench_id: String,
    run_id: Option<String>,
    task_id: Option<String>,
    role_id: Option<String>,
    kind: String,
    title: String,
    summary: String,
    content: String,
    pane_id: String,
    session_id: String,
    created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct CollabWorkbenchSnapshotResponse {
    workbench_id: String,
    name: String,
    project_directory: String,
    runtime_directory: String,
    roles: Vec<CollabRoleSnapshot>,
    active_run: Option<CollabRunSnapshot>,
    task_cards: Vec<CollabTaskCardSnapshot>,
    recent_events: Vec<CollabEventSnapshot>,
    recent_artifacts: Vec<CollabArtifactSnapshot>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct CollabCreateWorkbenchResponse {
    snapshot: CollabWorkbenchSnapshotResponse,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct CollabInitializeRolesResponse {
    snapshot: CollabWorkbenchSnapshotResponse,
    created_pane_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct CollabRoleSidResponse {
    role_id: String,
    pane_id: String,
    session_id: String,
    sid_bound: bool,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct CollabAddRoleResponse {
    snapshot: CollabWorkbenchSnapshotResponse,
    role: CollabRoleSnapshot,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct CollabCreateRunResponse {
    snapshot: CollabWorkbenchSnapshotResponse,
    run: CollabRunSnapshot,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct CollabCreateTaskCardResponse {
    snapshot: CollabWorkbenchSnapshotResponse,
    task: CollabTaskCardSnapshot,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct CollabDispatchTaskCardResponse {
    snapshot: CollabWorkbenchSnapshotResponse,
    task: CollabTaskCardSnapshot,
    sent_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct CollabCollectRoleReplyResponse {
    snapshot: CollabWorkbenchSnapshotResponse,
    task: CollabTaskCardSnapshot,
    artifact: Option<CollabArtifactSnapshot>,
    waiting: bool,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct CollabTaskMutationResponse {
    snapshot: CollabWorkbenchSnapshotResponse,
    task: CollabTaskCardSnapshot,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct CollabCompleteRunResponse {
    snapshot: CollabWorkbenchSnapshotResponse,
    run: CollabRunSnapshot,
    artifact: Option<CollabArtifactSnapshot>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct CollabAutoPlanResponse {
    snapshot: CollabWorkbenchSnapshotResponse,
    created_task_ids: Vec<String>,
    artifact: Option<CollabArtifactSnapshot>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct CollabDispatchWaveResponse {
    snapshot: CollabWorkbenchSnapshotResponse,
    dispatched_task_ids: Vec<String>,
    wave_index: i64,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct CollabAutoValidateWaveResponse {
    snapshot: CollabWorkbenchSnapshotResponse,
    accepted_task_ids: Vec<String>,
    rejected_task_ids: Vec<String>,
    waiting_task_ids: Vec<String>,
    wave_index: i64,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct CollabSendMessageResponse {
    accepted: bool,
    pane_id: String,
    session_id: String,
    role_id: String,
    sent_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct CollabConversationResponse {
    role_id: String,
    session_id: String,
    rows: Vec<NativeSessionPreviewRow>,
    total_rows: i64,
    loaded_rows: i64,
    has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub(crate) struct CollabRoleInput {
    role_key: Option<String>,
    template_key: String,
    name: Option<String>,
    provider: String,
}

#[derive(Debug, Clone)]
struct CollabWorkbenchRow {
    workbench_id: String,
    name: String,
    project_directory: String,
    runtime_directory: String,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone)]
struct CollabRoleRow {
    role_id: String,
    workbench_id: String,
    role_key: String,
    template_key: String,
    name: String,
    provider: String,
    capabilities_json: String,
    prompt_pack_json: String,
    pane_id: String,
    session_id: String,
    work_directory: String,
    phase: String,
    last_sent_at: i64,
    last_read_at: i64,
    last_error: Option<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone)]
struct CollabRunRow {
    run_id: String,
    workbench_id: String,
    title: String,
    goal: String,
    status: String,
    final_summary: Option<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone)]
struct CollabTaskCardRow {
    task_id: String,
    workbench_id: String,
    run_id: String,
    source_role_id: Option<String>,
    target_role_id: String,
    title: String,
    goal: String,
    constraints_text: String,
    input_summary: String,
    expected_output: String,
    status: String,
    latest_reply_summary: Option<String>,
    latest_artifact_id: Option<String>,
    last_error: Option<String>,
    dependency_task_ids_json: String,
    wave_index: i64,
    plan_order: i64,
    auto_generated: bool,
    validation_summary: Option<String>,
    validation_checked_at: i64,
    created_at: i64,
    dispatched_at: i64,
    replied_at: i64,
    resolved_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct CollabPlanTaskEnvelope {
    key: String,
    role_key: String,
    title: String,
    goal: String,
    dependencies: Option<Vec<String>>,
    constraints_text: Option<String>,
    input_summary: Option<String>,
    expected_output: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct CollabPlanEnvelope {
    summary: String,
    tasks: Vec<CollabPlanTaskEnvelope>,
}

#[derive(Debug, Clone)]
struct CollabEventRow {
    event_id: String,
    workbench_id: String,
    run_id: Option<String>,
    task_id: Option<String>,
    role_id: Option<String>,
    event_type: String,
    summary: String,
    payload_json: Option<String>,
    created_at: i64,
}

#[derive(Debug, Clone)]
struct CollabArtifactRow {
    artifact_id: String,
    workbench_id: String,
    run_id: Option<String>,
    task_id: Option<String>,
    role_id: Option<String>,
    kind: String,
    title: String,
    summary: String,
    content: String,
    pane_id: String,
    session_id: String,
    created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct CollabReplyEnvelope {
    summary: String,
    deliverables: Option<Vec<String>>,
    suggested_next_steps: Option<Vec<String>>,
    done: bool,
}

#[derive(Debug, Clone, Default)]
struct CollabRoleStatus {
    responding: bool,
    completed: bool,
    idle_secs: i64,
    last_input_at: i64,
    last_output_at: i64,
}

fn read_collab_event_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CollabEventRow> {
    Ok(CollabEventRow {
        event_id: row.get(0)?,
        workbench_id: row.get(1)?,
        run_id: row.get(2)?,
        task_id: row.get(3)?,
        role_id: row.get(4)?,
        event_type: row.get(5)?,
        summary: row.get(6)?,
        payload_json: row.get(7)?,
        created_at: row.get(8)?,
    })
}

fn read_collab_artifact_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CollabArtifactRow> {
    Ok(CollabArtifactRow {
        artifact_id: row.get(0)?,
        workbench_id: row.get(1)?,
        run_id: row.get(2)?,
        task_id: row.get(3)?,
        role_id: row.get(4)?,
        kind: row.get(5)?,
        title: row.get(6)?,
        summary: row.get(7)?,
        content: row.get(8)?,
        pane_id: row.get(9)?,
        session_id: row.get(10)?,
        created_at: row.get(11)?,
    })
}

fn ensure_collab_schema(path: &Path) -> Result<(), String> {
    let connection = open_db(path).map_err(|error| error.to_string())?;
    connection
        .execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS collab_workbenches (
              workbench_id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              project_directory TEXT NOT NULL,
              runtime_directory TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS collab_roles (
              role_id TEXT PRIMARY KEY,
              workbench_id TEXT NOT NULL,
              role_key TEXT NOT NULL,
              template_key TEXT NOT NULL,
              name TEXT NOT NULL,
              provider TEXT NOT NULL,
              capabilities_json TEXT NOT NULL DEFAULT '[]',
              prompt_pack_json TEXT NOT NULL DEFAULT '{}',
              pane_id TEXT NOT NULL DEFAULT '',
              session_id TEXT NOT NULL DEFAULT '',
              work_directory TEXT NOT NULL DEFAULT '',
              phase TEXT NOT NULL DEFAULT 'draft',
              last_sent_at INTEGER NOT NULL DEFAULT 0,
              last_read_at INTEGER NOT NULL DEFAULT 0,
              last_error TEXT,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              UNIQUE(workbench_id, role_key)
            );

            CREATE TABLE IF NOT EXISTS collab_runs (
              run_id TEXT PRIMARY KEY,
              workbench_id TEXT NOT NULL,
              title TEXT NOT NULL,
              goal TEXT NOT NULL,
              status TEXT NOT NULL,
              final_summary TEXT,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS collab_task_cards (
              task_id TEXT PRIMARY KEY,
              workbench_id TEXT NOT NULL,
              run_id TEXT NOT NULL,
              source_role_id TEXT,
              target_role_id TEXT NOT NULL,
              title TEXT NOT NULL,
              goal TEXT NOT NULL,
              constraints_text TEXT NOT NULL DEFAULT '',
              input_summary TEXT NOT NULL DEFAULT '',
              expected_output TEXT NOT NULL DEFAULT '',
              status TEXT NOT NULL,
              latest_reply_summary TEXT,
              latest_artifact_id TEXT,
              last_error TEXT,
              dependency_task_ids_json TEXT NOT NULL DEFAULT '[]',
              wave_index INTEGER NOT NULL DEFAULT 0,
              plan_order INTEGER NOT NULL DEFAULT 0,
              auto_generated INTEGER NOT NULL DEFAULT 0,
              validation_summary TEXT,
              validation_checked_at INTEGER NOT NULL DEFAULT 0,
              created_at INTEGER NOT NULL,
              dispatched_at INTEGER NOT NULL DEFAULT 0,
              replied_at INTEGER NOT NULL DEFAULT 0,
              resolved_at INTEGER NOT NULL DEFAULT 0,
              updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS collab_events (
              event_id TEXT PRIMARY KEY,
              workbench_id TEXT NOT NULL,
              run_id TEXT,
              task_id TEXT,
              role_id TEXT,
              event_type TEXT NOT NULL,
              summary TEXT NOT NULL,
              payload_json TEXT,
              created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS collab_artifact_snapshots (
              artifact_id TEXT PRIMARY KEY,
              workbench_id TEXT NOT NULL,
              run_id TEXT,
              task_id TEXT,
              role_id TEXT,
              kind TEXT NOT NULL,
              title TEXT NOT NULL,
              summary TEXT NOT NULL,
              content TEXT NOT NULL,
              pane_id TEXT NOT NULL DEFAULT '',
              session_id TEXT NOT NULL DEFAULT '',
              created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_collab_roles_workbench
              ON collab_roles(workbench_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_collab_runs_workbench
              ON collab_runs(workbench_id, updated_at);
            CREATE INDEX IF NOT EXISTS idx_collab_tasks_run
              ON collab_task_cards(run_id, updated_at);
            CREATE INDEX IF NOT EXISTS idx_collab_events_run
              ON collab_events(workbench_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_collab_artifacts_run
              ON collab_artifact_snapshots(workbench_id, created_at);
            "#,
        )
        .map_err(|error| error.to_string())?;
    for sql in [
        "ALTER TABLE collab_task_cards ADD COLUMN dependency_task_ids_json TEXT NOT NULL DEFAULT '[]'",
        "ALTER TABLE collab_task_cards ADD COLUMN wave_index INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE collab_task_cards ADD COLUMN plan_order INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE collab_task_cards ADD COLUMN auto_generated INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE collab_task_cards ADD COLUMN validation_summary TEXT",
        "ALTER TABLE collab_task_cards ADD COLUMN validation_checked_at INTEGER NOT NULL DEFAULT 0",
    ] {
        if let Err(error) = connection.execute(sql, []) {
            let message = error.to_string();
            if !message.contains("duplicate column name") {
                return Err(message);
            }
        }
    }
    Ok(())
}

fn collab_role_phase_key(phase: CollabRolePhase) -> &'static str {
    match phase {
        CollabRolePhase::Draft => "draft",
        CollabRolePhase::Initialized => "initialized",
        CollabRolePhase::Ready => "ready",
        CollabRolePhase::Running => "running",
        CollabRolePhase::Error => "error",
    }
}

fn normalize_collab_role_phase(raw: &str) -> CollabRolePhase {
    match raw.trim().to_lowercase().as_str() {
        "initialized" => CollabRolePhase::Initialized,
        "ready" => CollabRolePhase::Ready,
        "running" => CollabRolePhase::Running,
        "error" => CollabRolePhase::Error,
        _ => CollabRolePhase::Draft,
    }
}

fn collab_run_status_key(status: CollabRunStatus) -> &'static str {
    match status {
        CollabRunStatus::Draft => "draft",
        CollabRunStatus::Active => "active",
        CollabRunStatus::Completed => "completed",
        CollabRunStatus::Cancelled => "cancelled",
        CollabRunStatus::Failed => "failed",
    }
}

fn normalize_collab_run_status(raw: &str) -> CollabRunStatus {
    match raw.trim().to_lowercase().as_str() {
        "active" => CollabRunStatus::Active,
        "completed" => CollabRunStatus::Completed,
        "cancelled" => CollabRunStatus::Cancelled,
        "failed" => CollabRunStatus::Failed,
        _ => CollabRunStatus::Draft,
    }
}

fn collab_task_status_key(status: CollabTaskStatus) -> &'static str {
    match status {
        CollabTaskStatus::Draft => "draft",
        CollabTaskStatus::Queued => "queued",
        CollabTaskStatus::Dispatched => "dispatched",
        CollabTaskStatus::Replied => "replied",
        CollabTaskStatus::Accepted => "accepted",
        CollabTaskStatus::Rejected => "rejected",
        CollabTaskStatus::Cancelled => "cancelled",
    }
}

fn normalize_collab_task_status(raw: &str) -> CollabTaskStatus {
    match raw.trim().to_lowercase().as_str() {
        "queued" => CollabTaskStatus::Queued,
        "dispatched" => CollabTaskStatus::Dispatched,
        "replied" => CollabTaskStatus::Replied,
        "accepted" => CollabTaskStatus::Accepted,
        "rejected" => CollabTaskStatus::Rejected,
        "cancelled" => CollabTaskStatus::Cancelled,
        _ => CollabTaskStatus::Draft,
    }
}

fn is_collab_run_done(status: CollabRunStatus) -> bool {
    matches!(
        status,
        CollabRunStatus::Completed | CollabRunStatus::Cancelled | CollabRunStatus::Failed
    )
}

fn normalize_collab_template_key(raw: &str) -> Result<String, String> {
    let normalized = raw.trim().to_lowercase();
    match normalized.as_str() {
        "planner" | "implementer" | "reviewer" => Ok(normalized),
        _ => Err(format!("unsupported collab template: {}", raw)),
    }
}

fn deserialize_json_or_default<T>(raw: &str) -> T
where
    T: DeserializeOwned + Default,
{
    serde_json::from_str(raw).unwrap_or_default()
}

fn serialize_json<T: Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value).map_err(|error| error.to_string())
}

fn normalize_role_key_candidate(raw: &str) -> String {
    let cleaned = raw
        .trim()
        .to_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '_' })
        .collect::<String>();
    cleaned
        .trim_matches('_')
        .split('_')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("_")
}

fn next_unique_role_key(
    existing: &[CollabRoleRow],
    requested: Option<&str>,
    template_key: &str,
) -> String {
    let base = normalize_role_key_candidate(requested.unwrap_or(template_key));
    let base = if base.is_empty() {
        template_key.to_string()
    } else {
        base
    };
    let existing_set = existing
        .iter()
        .map(|item| item.role_key.trim().to_string())
        .collect::<std::collections::HashSet<_>>();
    if !existing_set.contains(&base) {
        return base;
    }
    for index in 2..1000 {
        let candidate = format!("{}_{}", base, index);
        if !existing_set.contains(&candidate) {
            return candidate;
        }
    }
    format!("{}_{}", base, Uuid::new_v4())
}

fn built_in_role_template(template_key: &str) -> Result<CollabRoleTemplateResponse, String> {
    let key = normalize_collab_template_key(template_key)?;
    let template = match key.as_str() {
        "planner" => CollabRoleTemplateResponse {
            template_key: key,
            title: "Planner".to_string(),
            description: "负责拆解目标、提炼约束、生成任务分发建议。".to_string(),
            default_name: "规划角色".to_string(),
            capabilities: vec![
                CollabCapabilityManifestItem {
                    key: "session.preview".to_string(),
                    label: "会话预览".to_string(),
                    description: "查看角色最近对话和阶段输出。".to_string(),
                    source: "builtin".to_string(),
                    manual_only: true,
                },
                CollabCapabilityManifestItem {
                    key: "mcp.prompt_pack".to_string(),
                    label: "提示词包".to_string(),
                    description: "使用结构化任务卡和上下文摘要组织派单。".to_string(),
                    source: "mcp".to_string(),
                    manual_only: true,
                },
                CollabCapabilityManifestItem {
                    key: "task.dispatch".to_string(),
                    label: "任务建议".to_string(),
                    description: "建议下一个任务卡，交由用户确认后派发。".to_string(),
                    source: "builtin".to_string(),
                    manual_only: true,
                },
            ],
            prompt_pack: CollabPromptPack {
                system_prompt: "你负责梳理目标、约束、依赖和拆解思路，输出清晰任务建议。"
                    .to_string(),
                reply_contract: "输出结论、风险、建议下一步，并在末尾提供结构化回复块。"
                    .to_string(),
                can_suggest_followups: true,
            },
        },
        "implementer" => CollabRoleTemplateResponse {
            template_key: key,
            title: "Implementer".to_string(),
            description: "负责执行具体实现、验证和交付说明。".to_string(),
            default_name: "执行角色".to_string(),
            capabilities: vec![
                CollabCapabilityManifestItem {
                    key: "workspace.edit".to_string(),
                    label: "项目执行".to_string(),
                    description: "在项目目录中进行代码实现、命令执行和结果整理。".to_string(),
                    source: "builtin".to_string(),
                    manual_only: true,
                },
                CollabCapabilityManifestItem {
                    key: "session.preview".to_string(),
                    label: "会话预览".to_string(),
                    description: "回看执行阶段的上下文与输出。".to_string(),
                    source: "builtin".to_string(),
                    manual_only: true,
                },
                CollabCapabilityManifestItem {
                    key: "mcp.workspace_tools".to_string(),
                    label: "MCP 工具声明".to_string(),
                    description: "根据工作台配置使用已声明的文件/命令类能力。".to_string(),
                    source: "mcp".to_string(),
                    manual_only: true,
                },
            ],
            prompt_pack: CollabPromptPack {
                system_prompt: "你负责执行具体任务，清楚说明改动、验证和剩余风险。".to_string(),
                reply_contract: "输出结果摘要、交付物、验证方式，并在末尾提供结构化回复块。"
                    .to_string(),
                can_suggest_followups: true,
            },
        },
        "reviewer" => CollabRoleTemplateResponse {
            template_key: key,
            title: "Reviewer".to_string(),
            description: "负责评审产物、指出问题、判断是否可采纳。".to_string(),
            default_name: "评审角色".to_string(),
            capabilities: vec![
                CollabCapabilityManifestItem {
                    key: "artifact.review".to_string(),
                    label: "产物评审".to_string(),
                    description: "基于任务目标检查回复是否满足交付要求。".to_string(),
                    source: "builtin".to_string(),
                    manual_only: true,
                },
                CollabCapabilityManifestItem {
                    key: "session.preview".to_string(),
                    label: "会话预览".to_string(),
                    description: "查看实现或规划会话输出，补充评审依据。".to_string(),
                    source: "builtin".to_string(),
                    manual_only: true,
                },
                CollabCapabilityManifestItem {
                    key: "mcp.review_checklist".to_string(),
                    label: "评审清单".to_string(),
                    description: "使用提示词包约束输出问题列表、风险和结论。".to_string(),
                    source: "mcp".to_string(),
                    manual_only: true,
                },
            ],
            prompt_pack: CollabPromptPack {
                system_prompt: "你负责评审阶段结果，指出缺口、风险和是否建议采纳。".to_string(),
                reply_contract: "输出评审意见、阻塞问题、建议下一步，并在末尾提供结构化回复块。"
                    .to_string(),
                can_suggest_followups: true,
            },
        },
        _ => unreachable!(),
    };
    Ok(template)
}

fn built_in_role_templates() -> Vec<CollabRoleTemplateResponse> {
    ["planner", "implementer", "reviewer"]
        .iter()
        .filter_map(|item| built_in_role_template(item).ok())
        .collect::<Vec<_>>()
}

fn default_roles_from_provider(provider: &str) -> Vec<CollabRoleInput> {
    vec![
        CollabRoleInput {
            role_key: Some("planner".to_string()),
            template_key: "planner".to_string(),
            name: Some("规划角色".to_string()),
            provider: provider.to_string(),
        },
        CollabRoleInput {
            role_key: Some("implementer".to_string()),
            template_key: "implementer".to_string(),
            name: Some("执行角色".to_string()),
            provider: provider.to_string(),
        },
        CollabRoleInput {
            role_key: Some("reviewer".to_string()),
            template_key: "reviewer".to_string(),
            name: Some("评审角色".to_string()),
            provider: provider.to_string(),
        },
    ]
}

fn derive_role_work_directory(
    workbench: &CollabWorkbenchRow,
    role_key: &str,
    template_key: &str,
) -> Result<String, String> {
    let base = if template_key == "implementer" {
        PathBuf::from(&workbench.project_directory)
    } else {
        PathBuf::from(&workbench.runtime_directory)
            .join("roles")
            .join(normalize_role_key_candidate(role_key))
    };
    fs::create_dir_all(&base).map_err(|error| error.to_string())?;
    Ok(base.to_string_lossy().to_string())
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

fn resolve_collab_role_session_id(state: &AppState, row: &CollabRoleRow) -> String {
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

fn load_collab_role_preview_rows(
    state: &AppState,
    row: &CollabRoleRow,
) -> Result<Vec<NativeSessionPreviewRow>, String> {
    let pane_id = row.pane_id.trim();
    let session_id = resolve_collab_role_session_id(state, row);
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

fn compute_collab_role_status_from_row(
    state: &AppState,
    row: &CollabRoleRow,
    idle_threshold_secs: i64,
) -> Result<CollabRoleStatus, String> {
    let runtime_ready = role_runtime_ready(state, &row.pane_id);
    let session_id = resolve_collab_role_session_id(state, row);
    if row.pane_id.trim().is_empty() || session_id.is_empty() {
        return Ok(CollabRoleStatus::default());
    }
    let rows = load_collab_role_preview_rows(state, row)?;
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
            return Ok(CollabRoleStatus {
                responding: idle_secs < threshold,
                completed: idle_secs >= threshold,
                idle_secs,
                last_input_at: last_input_after_send,
                last_output_at: last_output_after_send,
            });
        }
        return Ok(CollabRoleStatus {
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
    Ok(CollabRoleStatus {
        responding: last_input_any > last_output_any && idle_secs < threshold,
        completed: last_output_any >= last_input_any
            && last_output_any > 0
            && idle_secs >= threshold,
        idle_secs,
        last_input_at: last_input_any,
        last_output_at: last_output_any,
    })
}

fn build_collab_role_snapshot(state: &AppState, row: &CollabRoleRow) -> CollabRoleSnapshot {
    let session_id = resolve_collab_role_session_id(state, row);
    let runtime_ready = role_runtime_ready(state, &row.pane_id);
    let status = compute_collab_role_status_from_row(state, row, 5).ok();
    CollabRoleSnapshot {
        role_id: row.role_id.clone(),
        role_key: row.role_key.clone(),
        template_key: row.template_key.clone(),
        name: row.name.clone(),
        provider: row.provider.clone(),
        pane_id: row.pane_id.clone(),
        session_id: session_id.clone(),
        work_directory: row.work_directory.clone(),
        phase: normalize_collab_role_phase(&row.phase),
        runtime_ready,
        sid_bound: !session_id.is_empty(),
        responding: status.as_ref().map(|item| item.responding).unwrap_or(false),
        completed: status.as_ref().map(|item| item.completed).unwrap_or(false),
        idle_secs: status.as_ref().map(|item| item.idle_secs).unwrap_or(0),
        last_input_at: status.as_ref().map(|item| item.last_input_at).unwrap_or(0),
        last_output_at: status.as_ref().map(|item| item.last_output_at).unwrap_or(0),
        last_error: row.last_error.clone(),
        capabilities: deserialize_json_or_default(&row.capabilities_json),
    }
}

fn build_collab_run_snapshot(row: &CollabRunRow) -> CollabRunSnapshot {
    CollabRunSnapshot {
        run_id: row.run_id.clone(),
        workbench_id: row.workbench_id.clone(),
        title: row.title.clone(),
        goal: row.goal.clone(),
        status: normalize_collab_run_status(&row.status),
        final_summary: row.final_summary.clone(),
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

fn build_collab_task_snapshot(row: &CollabTaskCardRow) -> CollabTaskCardSnapshot {
    CollabTaskCardSnapshot {
        task_id: row.task_id.clone(),
        workbench_id: row.workbench_id.clone(),
        run_id: row.run_id.clone(),
        source_role_id: row.source_role_id.clone(),
        target_role_id: row.target_role_id.clone(),
        title: row.title.clone(),
        goal: row.goal.clone(),
        constraints_text: row.constraints_text.clone(),
        input_summary: row.input_summary.clone(),
        expected_output: row.expected_output.clone(),
        status: normalize_collab_task_status(&row.status),
        latest_reply_summary: row.latest_reply_summary.clone(),
        latest_artifact_id: row.latest_artifact_id.clone(),
        last_error: row.last_error.clone(),
        dependency_task_ids: deserialize_json_or_default(&row.dependency_task_ids_json),
        wave_index: row.wave_index,
        plan_order: row.plan_order,
        auto_generated: row.auto_generated,
        validation_summary: row.validation_summary.clone(),
        validation_checked_at: row.validation_checked_at,
        created_at: row.created_at,
        dispatched_at: row.dispatched_at,
        replied_at: row.replied_at,
        resolved_at: row.resolved_at,
        updated_at: row.updated_at,
    }
}

fn build_collab_event_snapshot(row: &CollabEventRow) -> CollabEventSnapshot {
    CollabEventSnapshot {
        event_id: row.event_id.clone(),
        workbench_id: row.workbench_id.clone(),
        run_id: row.run_id.clone(),
        task_id: row.task_id.clone(),
        role_id: row.role_id.clone(),
        event_type: row.event_type.clone(),
        summary: row.summary.clone(),
        payload_json: row.payload_json.clone(),
        created_at: row.created_at,
    }
}

fn build_collab_artifact_snapshot(row: &CollabArtifactRow) -> CollabArtifactSnapshot {
    CollabArtifactSnapshot {
        artifact_id: row.artifact_id.clone(),
        workbench_id: row.workbench_id.clone(),
        run_id: row.run_id.clone(),
        task_id: row.task_id.clone(),
        role_id: row.role_id.clone(),
        kind: row.kind.clone(),
        title: row.title.clone(),
        summary: row.summary.clone(),
        content: row.content.clone(),
        pane_id: row.pane_id.clone(),
        session_id: row.session_id.clone(),
        created_at: row.created_at,
    }
}

fn insert_collab_event_db(
    path: &Path,
    workbench_id: &str,
    run_id: Option<&str>,
    task_id: Option<&str>,
    role_id: Option<&str>,
    event_type: &str,
    summary: &str,
    payload_json: Option<String>,
) -> Result<(), String> {
    let created_at = now_epoch();
    let connection = open_db(path).map_err(|error| error.to_string())?;
    connection
        .execute(
            r#"
            INSERT INTO collab_events
              (event_id, workbench_id, run_id, task_id, role_id, event_type, summary, payload_json, created_at)
            VALUES
              (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            "#,
            params![
                Uuid::new_v4().to_string(),
                workbench_id,
                run_id,
                task_id,
                role_id,
                event_type,
                summary,
                payload_json,
                created_at,
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn insert_collab_artifact_db(path: &Path, row: &CollabArtifactRow) -> Result<(), String> {
    let connection = open_db(path).map_err(|error| error.to_string())?;
    connection
        .execute(
            r#"
            INSERT INTO collab_artifact_snapshots
              (artifact_id, workbench_id, run_id, task_id, role_id, kind, title, summary, content, pane_id, session_id, created_at)
            VALUES
              (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
            "#,
            params![
                row.artifact_id,
                row.workbench_id,
                row.run_id,
                row.task_id,
                row.role_id,
                row.kind,
                row.title,
                row.summary,
                row.content,
                row.pane_id,
                row.session_id,
                row.created_at,
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn upsert_collab_workbench_db(
    path: &Path,
    workbench_id: &str,
    name: &str,
    project_directory: &str,
    runtime_directory: &str,
    created_at: i64,
) -> Result<(), String> {
    let connection = open_db(path).map_err(|error| error.to_string())?;
    connection
        .execute(
            r#"
            INSERT INTO collab_workbenches
              (workbench_id, name, project_directory, runtime_directory, created_at, updated_at)
            VALUES
              (?1, ?2, ?3, ?4, ?5, ?6)
            ON CONFLICT(workbench_id)
            DO UPDATE SET
              name = excluded.name,
              project_directory = excluded.project_directory,
              runtime_directory = excluded.runtime_directory,
              updated_at = excluded.updated_at
            "#,
            params![
                workbench_id,
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

fn load_collab_workbench_row_db(
    path: &Path,
    workbench_id: &str,
) -> Result<CollabWorkbenchRow, String> {
    let connection = open_db(path).map_err(|error| error.to_string())?;
    connection
        .query_row(
            r#"
            SELECT workbench_id, name, project_directory, runtime_directory, created_at, updated_at
            FROM collab_workbenches
            WHERE workbench_id = ?1
            "#,
            params![workbench_id],
            |row| {
                Ok(CollabWorkbenchRow {
                    workbench_id: row.get(0)?,
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

fn insert_collab_role_db(path: &Path, row: &CollabRoleRow) -> Result<(), String> {
    let connection = open_db(path).map_err(|error| error.to_string())?;
    connection
        .execute(
            r#"
            INSERT INTO collab_roles
              (role_id, workbench_id, role_key, template_key, name, provider, capabilities_json, prompt_pack_json, pane_id, session_id, work_directory, phase, last_sent_at, last_read_at, last_error, created_at, updated_at)
            VALUES
              (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
            "#,
            params![
                row.role_id,
                row.workbench_id,
                row.role_key,
                row.template_key,
                row.name,
                row.provider,
                row.capabilities_json,
                row.prompt_pack_json,
                row.pane_id,
                row.session_id,
                row.work_directory,
                row.phase,
                row.last_sent_at,
                row.last_read_at,
                row.last_error,
                row.created_at,
                row.updated_at,
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn save_collab_role_db(path: &Path, row: &CollabRoleRow) -> Result<(), String> {
    let connection = open_db(path).map_err(|error| error.to_string())?;
    connection
        .execute(
            r#"
            UPDATE collab_roles
            SET role_key = ?3,
                template_key = ?4,
                name = ?5,
                provider = ?6,
                capabilities_json = ?7,
                prompt_pack_json = ?8,
                pane_id = ?9,
                session_id = ?10,
                work_directory = ?11,
                phase = ?12,
                last_sent_at = ?13,
                last_read_at = ?14,
                last_error = ?15,
                updated_at = ?16
            WHERE role_id = ?1 AND workbench_id = ?2
            "#,
            params![
                row.role_id,
                row.workbench_id,
                row.role_key,
                row.template_key,
                row.name,
                row.provider,
                row.capabilities_json,
                row.prompt_pack_json,
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

fn load_collab_role_row_db(
    path: &Path,
    workbench_id: &str,
    role_id: &str,
) -> Result<CollabRoleRow, String> {
    let connection = open_db(path).map_err(|error| error.to_string())?;
    connection
        .query_row(
            r#"
            SELECT role_id, workbench_id, role_key, template_key, name, provider, capabilities_json, prompt_pack_json, pane_id, session_id, work_directory, phase, last_sent_at, last_read_at, last_error, created_at, updated_at
            FROM collab_roles
            WHERE workbench_id = ?1 AND role_id = ?2
            "#,
            params![workbench_id, role_id],
            |row| {
                Ok(CollabRoleRow {
                    role_id: row.get(0)?,
                    workbench_id: row.get(1)?,
                    role_key: row.get(2)?,
                    template_key: row.get(3)?,
                    name: row.get(4)?,
                    provider: row.get(5)?,
                    capabilities_json: row.get(6)?,
                    prompt_pack_json: row.get(7)?,
                    pane_id: row.get(8)?,
                    session_id: row.get(9)?,
                    work_directory: row.get(10)?,
                    phase: row.get(11)?,
                    last_sent_at: row.get(12)?,
                    last_read_at: row.get(13)?,
                    last_error: row.get(14)?,
                    created_at: row.get(15)?,
                    updated_at: row.get(16)?,
                })
            },
        )
        .map_err(|error| error.to_string())
}

fn list_collab_role_rows_db(path: &Path, workbench_id: &str) -> Result<Vec<CollabRoleRow>, String> {
    let connection = open_db(path).map_err(|error| error.to_string())?;
    let mut stmt = connection
        .prepare(
            r#"
            SELECT role_id, workbench_id, role_key, template_key, name, provider, capabilities_json, prompt_pack_json, pane_id, session_id, work_directory, phase, last_sent_at, last_read_at, last_error, created_at, updated_at
            FROM collab_roles
            WHERE workbench_id = ?1
            ORDER BY created_at ASC, rowid ASC
            "#,
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(params![workbench_id], |row| {
            Ok(CollabRoleRow {
                role_id: row.get(0)?,
                workbench_id: row.get(1)?,
                role_key: row.get(2)?,
                template_key: row.get(3)?,
                name: row.get(4)?,
                provider: row.get(5)?,
                capabilities_json: row.get(6)?,
                prompt_pack_json: row.get(7)?,
                pane_id: row.get(8)?,
                session_id: row.get(9)?,
                work_directory: row.get(10)?,
                phase: row.get(11)?,
                last_sent_at: row.get(12)?,
                last_read_at: row.get(13)?,
                last_error: row.get(14)?,
                created_at: row.get(15)?,
                updated_at: row.get(16)?,
            })
        })
        .map_err(|error| error.to_string())?;
    let mut items = Vec::new();
    for row in rows {
        items.push(row.map_err(|error| error.to_string())?);
    }
    Ok(items)
}

fn mutate_collab_role_db<F>(
    path: &Path,
    workbench_id: &str,
    role_id: &str,
    mutator: F,
) -> Result<CollabRoleRow, String>
where
    F: FnOnce(&mut CollabRoleRow),
{
    let mut row = load_collab_role_row_db(path, workbench_id, role_id)?;
    mutator(&mut row);
    row.updated_at = now_epoch();
    save_collab_role_db(path, &row)?;
    Ok(row)
}

fn delete_collab_role_db(path: &Path, workbench_id: &str, role_id: &str) -> Result<(), String> {
    let connection = open_db(path).map_err(|error| error.to_string())?;
    connection
        .execute(
            "DELETE FROM collab_roles WHERE workbench_id = ?1 AND role_id = ?2",
            params![workbench_id, role_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn save_collab_run_db(path: &Path, row: &CollabRunRow) -> Result<(), String> {
    let connection = open_db(path).map_err(|error| error.to_string())?;
    connection
        .execute(
            r#"
            INSERT INTO collab_runs
              (run_id, workbench_id, title, goal, status, final_summary, created_at, updated_at)
            VALUES
              (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            ON CONFLICT(run_id)
            DO UPDATE SET
              workbench_id = excluded.workbench_id,
              title = excluded.title,
              goal = excluded.goal,
              status = excluded.status,
              final_summary = excluded.final_summary,
              updated_at = excluded.updated_at
            "#,
            params![
                row.run_id,
                row.workbench_id,
                row.title,
                row.goal,
                row.status,
                row.final_summary,
                row.created_at,
                row.updated_at,
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn load_collab_run_row_db(path: &Path, run_id: &str) -> Result<CollabRunRow, String> {
    let connection = open_db(path).map_err(|error| error.to_string())?;
    connection
        .query_row(
            r#"
            SELECT run_id, workbench_id, title, goal, status, final_summary, created_at, updated_at
            FROM collab_runs
            WHERE run_id = ?1
            "#,
            params![run_id],
            |row| {
                Ok(CollabRunRow {
                    run_id: row.get(0)?,
                    workbench_id: row.get(1)?,
                    title: row.get(2)?,
                    goal: row.get(3)?,
                    status: row.get(4)?,
                    final_summary: row.get(5)?,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            },
        )
        .map_err(|error| error.to_string())
}

fn load_active_collab_run_row_db(
    path: &Path,
    workbench_id: &str,
) -> Result<Option<CollabRunRow>, String> {
    let connection = open_db(path).map_err(|error| error.to_string())?;
    connection
        .query_row(
            r#"
            SELECT run_id, workbench_id, title, goal, status, final_summary, created_at, updated_at
            FROM collab_runs
            WHERE workbench_id = ?1 AND status NOT IN ('completed', 'cancelled', 'failed')
            ORDER BY updated_at DESC, created_at DESC, rowid DESC
            LIMIT 1
            "#,
            params![workbench_id],
            |row| {
                Ok(CollabRunRow {
                    run_id: row.get(0)?,
                    workbench_id: row.get(1)?,
                    title: row.get(2)?,
                    goal: row.get(3)?,
                    status: row.get(4)?,
                    final_summary: row.get(5)?,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn load_latest_collab_run_row_db(
    path: &Path,
    workbench_id: &str,
) -> Result<Option<CollabRunRow>, String> {
    let connection = open_db(path).map_err(|error| error.to_string())?;
    connection
        .query_row(
            r#"
            SELECT run_id, workbench_id, title, goal, status, final_summary, created_at, updated_at
            FROM collab_runs
            WHERE workbench_id = ?1
            ORDER BY updated_at DESC, created_at DESC, rowid DESC
            LIMIT 1
            "#,
            params![workbench_id],
            |row| {
                Ok(CollabRunRow {
                    run_id: row.get(0)?,
                    workbench_id: row.get(1)?,
                    title: row.get(2)?,
                    goal: row.get(3)?,
                    status: row.get(4)?,
                    final_summary: row.get(5)?,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn save_collab_task_db(path: &Path, row: &CollabTaskCardRow) -> Result<(), String> {
    let connection = open_db(path).map_err(|error| error.to_string())?;
    connection
        .execute(
            r#"
            INSERT INTO collab_task_cards
              (task_id, workbench_id, run_id, source_role_id, target_role_id, title, goal, constraints_text, input_summary, expected_output, status, latest_reply_summary, latest_artifact_id, last_error, dependency_task_ids_json, wave_index, plan_order, auto_generated, validation_summary, validation_checked_at, created_at, dispatched_at, replied_at, resolved_at, updated_at)
            VALUES
              (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25)
            ON CONFLICT(task_id)
            DO UPDATE SET
              source_role_id = excluded.source_role_id,
              target_role_id = excluded.target_role_id,
              title = excluded.title,
              goal = excluded.goal,
              constraints_text = excluded.constraints_text,
              input_summary = excluded.input_summary,
              expected_output = excluded.expected_output,
              status = excluded.status,
              latest_reply_summary = excluded.latest_reply_summary,
              latest_artifact_id = excluded.latest_artifact_id,
              last_error = excluded.last_error,
              dependency_task_ids_json = excluded.dependency_task_ids_json,
              wave_index = excluded.wave_index,
              plan_order = excluded.plan_order,
              auto_generated = excluded.auto_generated,
              validation_summary = excluded.validation_summary,
              validation_checked_at = excluded.validation_checked_at,
              dispatched_at = excluded.dispatched_at,
              replied_at = excluded.replied_at,
              resolved_at = excluded.resolved_at,
              updated_at = excluded.updated_at
            "#,
            params![
                row.task_id,
                row.workbench_id,
                row.run_id,
                row.source_role_id,
                row.target_role_id,
                row.title,
                row.goal,
                row.constraints_text,
                row.input_summary,
                row.expected_output,
                row.status,
                row.latest_reply_summary,
                row.latest_artifact_id,
                row.last_error,
                row.dependency_task_ids_json,
                row.wave_index,
                row.plan_order,
                row.auto_generated,
                row.validation_summary,
                row.validation_checked_at,
                row.created_at,
                row.dispatched_at,
                row.replied_at,
                row.resolved_at,
                row.updated_at,
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn load_collab_task_row_db(path: &Path, task_id: &str) -> Result<CollabTaskCardRow, String> {
    let connection = open_db(path).map_err(|error| error.to_string())?;
    connection
        .query_row(
            r#"
            SELECT task_id, workbench_id, run_id, source_role_id, target_role_id, title, goal, constraints_text, input_summary, expected_output, status, latest_reply_summary, latest_artifact_id, last_error, dependency_task_ids_json, wave_index, plan_order, auto_generated, validation_summary, validation_checked_at, created_at, dispatched_at, replied_at, resolved_at, updated_at
            FROM collab_task_cards
            WHERE task_id = ?1
            "#,
            params![task_id],
            |row| {
                Ok(CollabTaskCardRow {
                    task_id: row.get(0)?,
                    workbench_id: row.get(1)?,
                    run_id: row.get(2)?,
                    source_role_id: row.get(3)?,
                    target_role_id: row.get(4)?,
                    title: row.get(5)?,
                    goal: row.get(6)?,
                    constraints_text: row.get(7)?,
                    input_summary: row.get(8)?,
                    expected_output: row.get(9)?,
                    status: row.get(10)?,
                    latest_reply_summary: row.get(11)?,
                    latest_artifact_id: row.get(12)?,
                    last_error: row.get(13)?,
                    dependency_task_ids_json: row.get(14)?,
                    wave_index: row.get(15)?,
                    plan_order: row.get(16)?,
                    auto_generated: row.get(17)?,
                    validation_summary: row.get(18)?,
                    validation_checked_at: row.get(19)?,
                    created_at: row.get(20)?,
                    dispatched_at: row.get(21)?,
                    replied_at: row.get(22)?,
                    resolved_at: row.get(23)?,
                    updated_at: row.get(24)?,
                })
            },
        )
        .map_err(|error| error.to_string())
}

fn list_collab_task_rows_for_run_db(
    path: &Path,
    run_id: &str,
) -> Result<Vec<CollabTaskCardRow>, String> {
    let connection = open_db(path).map_err(|error| error.to_string())?;
    let mut stmt = connection
        .prepare(
            r#"
            SELECT task_id, workbench_id, run_id, source_role_id, target_role_id, title, goal, constraints_text, input_summary, expected_output, status, latest_reply_summary, latest_artifact_id, last_error, dependency_task_ids_json, wave_index, plan_order, auto_generated, validation_summary, validation_checked_at, created_at, dispatched_at, replied_at, resolved_at, updated_at
            FROM collab_task_cards
            WHERE run_id = ?1
            ORDER BY wave_index ASC, plan_order ASC, updated_at DESC, created_at DESC, rowid DESC
            "#,
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(params![run_id], |row| {
            Ok(CollabTaskCardRow {
                task_id: row.get(0)?,
                workbench_id: row.get(1)?,
                run_id: row.get(2)?,
                source_role_id: row.get(3)?,
                target_role_id: row.get(4)?,
                title: row.get(5)?,
                goal: row.get(6)?,
                constraints_text: row.get(7)?,
                input_summary: row.get(8)?,
                expected_output: row.get(9)?,
                status: row.get(10)?,
                latest_reply_summary: row.get(11)?,
                latest_artifact_id: row.get(12)?,
                last_error: row.get(13)?,
                dependency_task_ids_json: row.get(14)?,
                wave_index: row.get(15)?,
                plan_order: row.get(16)?,
                auto_generated: row.get(17)?,
                validation_summary: row.get(18)?,
                validation_checked_at: row.get(19)?,
                created_at: row.get(20)?,
                dispatched_at: row.get(21)?,
                replied_at: row.get(22)?,
                resolved_at: row.get(23)?,
                updated_at: row.get(24)?,
            })
        })
        .map_err(|error| error.to_string())?;
    let mut items = Vec::new();
    for row in rows {
        items.push(row.map_err(|error| error.to_string())?);
    }
    Ok(items)
}

fn count_tasks_for_role_db(path: &Path, role_id: &str) -> Result<i64, String> {
    let connection = open_db(path).map_err(|error| error.to_string())?;
    connection
        .query_row(
            "SELECT COUNT(1) FROM collab_task_cards WHERE source_role_id = ?1 OR target_role_id = ?1",
            params![role_id],
            |row| row.get::<usize, i64>(0),
        )
        .map_err(|error| error.to_string())
}

fn list_collab_event_rows_db(
    path: &Path,
    workbench_id: &str,
    run_id: Option<&str>,
) -> Result<Vec<CollabEventRow>, String> {
    let connection = open_db(path).map_err(|error| error.to_string())?;
    let sql = if run_id.is_some() {
        r#"
        SELECT event_id, workbench_id, run_id, task_id, role_id, event_type, summary, payload_json, created_at
        FROM collab_events
        WHERE workbench_id = ?1 AND (run_id = ?2 OR run_id IS NULL)
        ORDER BY created_at DESC, rowid DESC
        LIMIT 40
        "#
    } else {
        r#"
        SELECT event_id, workbench_id, run_id, task_id, role_id, event_type, summary, payload_json, created_at
        FROM collab_events
        WHERE workbench_id = ?1
        ORDER BY created_at DESC, rowid DESC
        LIMIT 40
        "#
    };
    let mut stmt = connection.prepare(sql).map_err(|error| error.to_string())?;
    let rows = if let Some(run_id) = run_id {
        stmt.query_map(params![workbench_id, run_id], read_collab_event_row)
            .map_err(|error| error.to_string())?
    } else {
        stmt.query_map(params![workbench_id], read_collab_event_row)
            .map_err(|error| error.to_string())?
    };
    let mut items = Vec::new();
    for row in rows {
        items.push(row.map_err(|error| error.to_string())?);
    }
    Ok(items)
}

fn list_collab_artifact_rows_db(
    path: &Path,
    workbench_id: &str,
    run_id: Option<&str>,
) -> Result<Vec<CollabArtifactRow>, String> {
    let connection = open_db(path).map_err(|error| error.to_string())?;
    let sql = if run_id.is_some() {
        r#"
        SELECT artifact_id, workbench_id, run_id, task_id, role_id, kind, title, summary, content, pane_id, session_id, created_at
        FROM collab_artifact_snapshots
        WHERE workbench_id = ?1 AND (run_id = ?2 OR run_id IS NULL)
        ORDER BY created_at DESC, rowid DESC
        LIMIT 24
        "#
    } else {
        r#"
        SELECT artifact_id, workbench_id, run_id, task_id, role_id, kind, title, summary, content, pane_id, session_id, created_at
        FROM collab_artifact_snapshots
        WHERE workbench_id = ?1
        ORDER BY created_at DESC, rowid DESC
        LIMIT 24
        "#
    };
    let mut stmt = connection.prepare(sql).map_err(|error| error.to_string())?;
    let rows = if let Some(run_id) = run_id {
        stmt.query_map(params![workbench_id, run_id], read_collab_artifact_row)
            .map_err(|error| error.to_string())?
    } else {
        stmt.query_map(params![workbench_id], read_collab_artifact_row)
            .map_err(|error| error.to_string())?
    };
    let mut items = Vec::new();
    for row in rows {
        items.push(row.map_err(|error| error.to_string())?);
    }
    Ok(items)
}

fn load_collab_artifact_row_db(
    path: &Path,
    artifact_id: &str,
) -> Result<CollabArtifactRow, String> {
    let connection = open_db(path).map_err(|error| error.to_string())?;
    connection
        .query_row(
            r#"
            SELECT artifact_id, workbench_id, run_id, task_id, role_id, kind, title, summary, content, pane_id, session_id, created_at
            FROM collab_artifact_snapshots
            WHERE artifact_id = ?1
            "#,
            params![artifact_id],
            read_collab_artifact_row,
        )
        .map_err(|error| error.to_string())
}

fn load_collab_snapshot_db(
    state: &AppState,
    workbench_id: &str,
) -> Result<CollabWorkbenchSnapshotResponse, String> {
    ensure_collab_schema(&state.db_path)?;
    let workbench = load_collab_workbench_row_db(&state.db_path, workbench_id)?;
    let roles = list_collab_role_rows_db(&state.db_path, workbench_id)?;
    let role_snapshots = roles
        .iter()
        .map(|item| build_collab_role_snapshot(state, item))
        .collect::<Vec<_>>();
    let active_run = load_active_collab_run_row_db(&state.db_path, workbench_id)?.or_else(|| {
        load_latest_collab_run_row_db(&state.db_path, workbench_id)
            .ok()
            .flatten()
    });
    let active_run_snapshot = active_run.as_ref().map(build_collab_run_snapshot);
    let task_cards = if let Some(run) = active_run.as_ref() {
        list_collab_task_rows_for_run_db(&state.db_path, &run.run_id)?
            .into_iter()
            .map(|item| build_collab_task_snapshot(&item))
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let run_id = active_run.as_ref().map(|item| item.run_id.as_str());
    let recent_events = list_collab_event_rows_db(&state.db_path, workbench_id, run_id)?
        .into_iter()
        .map(|item| build_collab_event_snapshot(&item))
        .collect::<Vec<_>>();
    let recent_artifacts = list_collab_artifact_rows_db(&state.db_path, workbench_id, run_id)?
        .into_iter()
        .map(|item| build_collab_artifact_snapshot(&item))
        .collect::<Vec<_>>();
    let _timestamps = (workbench.created_at, workbench.updated_at);
    Ok(CollabWorkbenchSnapshotResponse {
        workbench_id: workbench.workbench_id,
        name: workbench.name,
        project_directory: workbench.project_directory,
        runtime_directory: workbench.runtime_directory,
        roles: role_snapshots,
        active_run: active_run_snapshot,
        task_cards,
        recent_events,
        recent_artifacts,
    })
}

fn create_role_row_from_input(
    workbench: &CollabWorkbenchRow,
    existing_roles: &[CollabRoleRow],
    input: &CollabRoleInput,
) -> Result<CollabRoleRow, String> {
    let template = built_in_role_template(&input.template_key)?;
    let role_key = next_unique_role_key(
        existing_roles,
        input.role_key.as_deref(),
        &template.template_key,
    );
    let provider = input.provider.trim().to_lowercase();
    if provider.is_empty() {
        return Err("role provider is empty".to_string());
    }
    let name = input
        .name
        .as_deref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| template.default_name.clone());
    let work_directory = derive_role_work_directory(workbench, &role_key, &template.template_key)?;
    let now = now_epoch();
    Ok(CollabRoleRow {
        role_id: Uuid::new_v4().to_string(),
        workbench_id: workbench.workbench_id.clone(),
        role_key,
        template_key: template.template_key.clone(),
        name,
        provider,
        capabilities_json: serialize_json(&template.capabilities)?,
        prompt_pack_json: serialize_json(&template.prompt_pack)?,
        pane_id: String::new(),
        session_id: String::new(),
        work_directory,
        phase: collab_role_phase_key(CollabRolePhase::Draft).to_string(),
        last_sent_at: 0,
        last_read_at: 0,
        last_error: None,
        created_at: now,
        updated_at: now,
    })
}

fn collab_role_sid_response(state: &AppState, row: &CollabRoleRow) -> CollabRoleSidResponse {
    let session_id = resolve_collab_role_session_id(state, row);
    CollabRoleSidResponse {
        role_id: row.role_id.clone(),
        pane_id: row.pane_id.clone(),
        session_id: session_id.clone(),
        sid_bound: !session_id.is_empty(),
    }
}

fn ensure_collab_role_pane(
    app: &AppHandle,
    state: &AppState,
    workbench_id: &str,
    role_id: &str,
) -> Result<(String, bool), String> {
    let role = load_collab_role_row_db(&state.db_path, workbench_id, role_id)?;
    if !role.pane_id.trim().is_empty() && load_provider(&state.db_path, &role.pane_id).is_ok() {
        start_runtime(app, state, role.pane_id.clone(), role.provider.clone())
            .map_err(|error| error.to_string())?;
        return Ok((role.pane_id, false));
    }
    let workbench = load_collab_workbench_row_db(&state.db_path, workbench_id)?;
    let now = now_epoch();
    let pane = PaneSummary {
        id: Uuid::new_v4().to_string(),
        provider: role.provider.clone(),
        title: format!("{} {}", workbench.name, role.name),
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
    mutate_collab_role_db(&state.db_path, workbench_id, role_id, |item| {
        item.pane_id = pane.id.clone();
        item.session_id.clear();
        item.phase = collab_role_phase_key(CollabRolePhase::Initialized).to_string();
        item.last_error = None;
    })?;
    Ok((pane.id, true))
}

fn launch_collab_role_provider_shell(
    state: &AppState,
    workbench_id: &str,
    role_id: &str,
) -> Result<(), String> {
    let role = load_collab_role_row_db(&state.db_path, workbench_id, role_id)?;
    if role.pane_id.trim().is_empty() {
        return Err(format!("role {} has no pane yet", role.role_key));
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
    mutate_collab_role_db(&state.db_path, workbench_id, role_id, |item| {
        item.session_id.clear();
        item.phase = collab_role_phase_key(CollabRolePhase::Initialized).to_string();
        item.last_error = None;
    })?;
    Ok(())
}

fn build_collab_dispatch_prompt(
    workbench: &CollabWorkbenchRow,
    run: &CollabRunRow,
    source_role_name: Option<&str>,
    role: &CollabRoleRow,
    task: &CollabTaskCardRow,
) -> String {
    let template = built_in_role_template(&role.template_key).ok();
    let prompt_pack = deserialize_json_or_default::<CollabPromptPack>(&role.prompt_pack_json);
    let capabilities =
        deserialize_json_or_default::<Vec<CollabCapabilityManifestItem>>(&role.capabilities_json);
    let capabilities_text = if capabilities.is_empty() {
        "无额外能力声明".to_string()
    } else {
        capabilities
            .iter()
            .map(|item| {
                format!(
                    "- {}（{} / {}）：{}",
                    item.label,
                    item.source,
                    if item.manual_only {
                        "需人工触发"
                    } else {
                        "可直接使用"
                    },
                    item.description
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    let template_desc = template
        .as_ref()
        .map(|item| format!("模板：{} - {}", item.title, item.description))
        .unwrap_or_else(|| format!("模板：{}", role.template_key));
    [
        format!("你是 AI Shell 协作工作台中的“{}”。", role.name),
        template_desc,
        format!("项目目录：{}", workbench.project_directory),
        format!("当前工作目录：{}", role.work_directory),
        format!("当前协作 Run：{}", run.title),
        format!("Run 目标：\n{}", run.goal.trim()),
        prompt_pack.system_prompt,
        format!("上游来源：{}", source_role_name.unwrap_or("用户/工作台")),
        "可用能力声明（v1 仅作提示和人工触发入口，不要求你自动调用任何工具）：".to_string(),
        capabilities_text,
        "任务卡：".to_string(),
        format!("- 标题：{}", task.title.trim()),
        format!("- 目标：{}", task.goal.trim()),
        format!(
            "- 约束：{}",
            if task.constraints_text.trim().is_empty() {
                "无".to_string()
            } else {
                task.constraints_text.trim().to_string()
            }
        ),
        format!(
            "- 上下文摘要：{}",
            if task.input_summary.trim().is_empty() {
                "无".to_string()
            } else {
                task.input_summary.trim().to_string()
            }
        ),
        format!(
            "- 期望产物：{}",
            if task.expected_output.trim().is_empty() {
                "未指定".to_string()
            } else {
                task.expected_output.trim().to_string()
            }
        ),
        "回复要求：".to_string(),
        "1. 先用自然语言输出主要结果。".to_string(),
        "2. 最后严格输出一个结构化块：<collab_reply>{\"summary\":\"简要总结\",\"deliverables\":[\"交付物\"],\"suggested_next_steps\":[\"建议下一步\"],\"done\":true}</collab_reply>".to_string(),
        "3. 如果任务未完成，也要说明阻塞点，并将 done 设为 false。".to_string(),
        prompt_pack.reply_contract,
    ]
    .join("\n\n")
}

fn read_collab_role_output_since(
    state: &AppState,
    row: &CollabRoleRow,
    since_at: i64,
) -> Result<(String, i64), String> {
    let rows = load_collab_role_preview_rows(state, row)?;
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

fn extract_collab_reply_block(content: &str) -> Option<CollabReplyEnvelope> {
    extract_json_block(content, "<collab_reply>", "</collab_reply>")
}

fn extract_collab_plan_block(content: &str) -> Option<CollabPlanEnvelope> {
    extract_json_block(content, "<collab_plan>", "</collab_plan>")
}

fn summarize_reply_content(content: &str, envelope: Option<&CollabReplyEnvelope>) -> String {
    let summary = envelope
        .map(|item| item.summary.trim().to_string())
        .filter(|item| !item.is_empty())
        .unwrap_or_else(|| content.trim().to_string());
    let compact = summary
        .replace('\r', "")
        .replace('\n', " ")
        .trim()
        .to_string();
    if compact.chars().count() <= 220 {
        compact
    } else {
        compact.chars().take(220).collect::<String>() + "..."
    }
}

fn build_collab_plan_prompt(
    workbench: &CollabWorkbenchRow,
    run: &CollabRunRow,
    roles: &[CollabRoleRow],
) -> String {
    let role_lines = roles
        .iter()
        .map(|role| {
            format!(
                "- role_key: {} | template: {} | name: {} | provider: {}",
                role.role_key, role.template_key, role.name, role.provider
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    [
        "你是当前协作工作台的 Planner。请把本次 Run 拆解成一个可执行 DAG 计划。".to_string(),
        format!("项目目录: {}", workbench.project_directory),
        format!("Run 标题: {}", run.title),
        format!("Run 目标:\n{}", run.goal.trim()),
        "可用角色如下，请只使用这些 role_key：".to_string(),
        role_lines,
        "要求：".to_string(),
        "1. 输出 2-8 个任务，形成无环依赖图。".to_string(),
        "2. 每个任务必须分配给一个 role_key。".to_string(),
        "3. 能并行的任务放在同一波，不要制造无意义依赖。".to_string(),
        "4. 如果有 reviewer 角色，最后一波应包含评审/验收任务。".to_string(),
        "5. 只输出一个结构化 JSON 块，不要输出额外解释。".to_string(),
        "输出格式：".to_string(),
        "<collab_plan>{\"summary\":\"计划摘要\",\"tasks\":[{\"key\":\"task_api\",\"role_key\":\"implementer\",\"title\":\"实现 API\",\"goal\":\"...\",\"dependencies\":[\"task_spec\"],\"constraints_text\":\"\",\"input_summary\":\"\",\"expected_output\":\"...\"}]}</collab_plan>".to_string(),
    ]
    .join("\n\n")
}

fn normalize_plan_task_key(raw: &str, fallback_index: usize) -> String {
    let normalized = normalize_role_key_candidate(raw);
    if normalized.is_empty() {
        format!("task_{}", fallback_index + 1)
    } else {
        normalized
    }
}

fn normalize_dependency_keys(values: Option<&Vec<String>>, current_key: &str) -> Vec<String> {
    let mut seen = std::collections::HashSet::<String>::new();
    values
        .into_iter()
        .flat_map(|items| items.iter())
        .map(|item| normalize_role_key_candidate(item))
        .filter(|item| !item.is_empty() && item != current_key)
        .filter(|item| seen.insert(item.clone()))
        .collect::<Vec<_>>()
}

fn find_collab_role_for_plan<'a>(
    roles: &'a [CollabRoleRow],
    role_key: &str,
) -> Option<&'a CollabRoleRow> {
    let normalized = normalize_role_key_candidate(role_key);
    if normalized.is_empty() {
        return None;
    }
    roles
        .iter()
        .find(|role| role.role_key.trim().eq_ignore_ascii_case(&normalized))
        .or_else(|| {
            roles.iter().find(|role| {
                role.template_key
                    .trim()
                    .eq_ignore_ascii_case(role_key.trim())
            })
        })
}

fn compute_plan_wave_map(
    tasks: &[(String, Vec<String>)],
) -> Result<std::collections::HashMap<String, i64>, String> {
    fn visit(
        key: &str,
        adjacency: &std::collections::HashMap<String, Vec<String>>,
        temp: &mut std::collections::HashSet<String>,
        memo: &mut std::collections::HashMap<String, i64>,
    ) -> Result<i64, String> {
        if let Some(value) = memo.get(key) {
            return Ok(*value);
        }
        if !temp.insert(key.to_string()) {
            return Err(format!("plan has cyclic dependency around {}", key));
        }
        let mut wave = 0_i64;
        for dependency in adjacency.get(key).cloned().unwrap_or_default() {
            if !adjacency.contains_key(&dependency) {
                return Err(format!("plan dependency {} does not exist", dependency));
            }
            wave = wave.max(visit(&dependency, adjacency, temp, memo)? + 1);
        }
        temp.remove(key);
        memo.insert(key.to_string(), wave);
        Ok(wave)
    }

    let adjacency = tasks
        .iter()
        .map(|(key, dependencies)| (key.clone(), dependencies.clone()))
        .collect::<std::collections::HashMap<_, _>>();
    let mut memo = std::collections::HashMap::<String, i64>::new();
    let mut temp = std::collections::HashSet::<String>::new();
    for key in adjacency.keys() {
        let _ = visit(key, &adjacency, &mut temp, &mut memo)?;
    }
    Ok(memo)
}

fn collab_task_is_terminal(status: CollabTaskStatus) -> bool {
    matches!(
        status,
        CollabTaskStatus::Accepted | CollabTaskStatus::Rejected | CollabTaskStatus::Cancelled
    )
}

fn collab_task_dependencies_accepted(
    task: &CollabTaskCardRow,
    task_map: &std::collections::HashMap<String, CollabTaskCardRow>,
) -> bool {
    let dependency_ids = deserialize_json_or_default::<Vec<String>>(&task.dependency_task_ids_json);
    dependency_ids.into_iter().all(|dependency_id| {
        task_map
            .get(&dependency_id)
            .map(|dependency| {
                normalize_collab_task_status(&dependency.status) == CollabTaskStatus::Accepted
            })
            .unwrap_or(false)
    })
}

fn invalidate_collab_role_preview_cache(state: &AppState, role: &CollabRoleRow) {
    invalidate_native_session_preview_cache(state, &role.provider);
}

fn wait_for_collab_role_completion(
    state: &AppState,
    role: &CollabRoleRow,
    sent_at: i64,
    timeout_secs: i64,
    idle_threshold_secs: i64,
) -> Result<CollabRoleRow, String> {
    let started = std::time::Instant::now();
    loop {
        let refreshed = load_collab_role_row_db(&state.db_path, &role.workbench_id, &role.role_id)?;
        invalidate_collab_role_preview_cache(state, &refreshed);
        let status = compute_collab_role_status_from_row(state, &refreshed, idle_threshold_secs)?;
        if status.completed && status.last_output_at >= sent_at {
            return Ok(refreshed);
        }
        if started.elapsed().as_secs() >= timeout_secs.max(5) as u64 {
            return Err(format!(
                "role {} did not finish within {}s",
                refreshed.name,
                timeout_secs.max(5)
            ));
        }
        std::thread::sleep(std::time::Duration::from_millis(1200));
    }
}

fn dispatch_collab_task_internal(
    state: &AppState,
    workbench_id: &str,
    task_id: &str,
) -> Result<(CollabTaskCardRow, i64), String> {
    let mut task = load_collab_task_row_db(&state.db_path, task_id)?;
    if task.workbench_id != workbench_id {
        return Err("task does not belong to workbench".to_string());
    }
    let task_status = normalize_collab_task_status(&task.status);
    if !matches!(
        task_status,
        CollabTaskStatus::Draft | CollabTaskStatus::Queued
    ) {
        return Err("task is not ready to dispatch".to_string());
    }
    let workbench = load_collab_workbench_row_db(&state.db_path, workbench_id)?;
    let run = load_collab_run_row_db(&state.db_path, &task.run_id)?;
    let role = load_collab_role_row_db(&state.db_path, workbench_id, &task.target_role_id)?;
    if role.pane_id.trim().is_empty() {
        return Err("target role has no pane yet, please initialize roles first".to_string());
    }
    let session_id = resolve_collab_role_session_id(state, &role);
    if session_id.is_empty() {
        return Err("target role has no session id yet, please bind sid first".to_string());
    }
    let source_role_name = task
        .source_role_id
        .as_deref()
        .and_then(|role_id| load_collab_role_row_db(&state.db_path, workbench_id, role_id).ok())
        .map(|item| item.name)
        .unwrap_or_else(|| "用户/工作台".to_string());
    let prompt =
        build_collab_dispatch_prompt(&workbench, &run, Some(&source_role_name), &role, &task);
    paste_to_pane_internal(state, &role.pane_id, &prompt, true)
        .map_err(|error| error.to_string())?;
    let sent_at = now_epoch();
    let _ = mutate_collab_role_db(&state.db_path, workbench_id, &role.role_id, |item| {
        item.last_sent_at = sent_at;
        item.phase = collab_role_phase_key(CollabRolePhase::Running).to_string();
        item.last_error = None;
    })?;
    task.status = collab_task_status_key(CollabTaskStatus::Dispatched).to_string();
    task.dispatched_at = sent_at;
    task.updated_at = sent_at;
    task.last_error = None;
    save_collab_task_db(&state.db_path, &task)?;
    insert_collab_event_db(
        &state.db_path,
        workbench_id,
        Some(&task.run_id),
        Some(&task.task_id),
        Some(&role.role_id),
        "task_dispatched",
        &format!("派发任务卡：{} -> {}", task.title, role.name),
        Some(serde_json::json!({ "session_id": session_id, "sent_at": sent_at }).to_string()),
    )?;
    Ok((task, sent_at))
}

fn collect_collab_task_reply_internal(
    state: &AppState,
    workbench_id: &str,
    task_id: &str,
    idle_threshold_secs: i64,
) -> Result<(CollabTaskCardRow, Option<CollabArtifactRow>, bool), String> {
    let mut task = load_collab_task_row_db(&state.db_path, task_id)?;
    if task.workbench_id != workbench_id {
        return Err("task does not belong to workbench".to_string());
    }
    let role = load_collab_role_row_db(&state.db_path, workbench_id, &task.target_role_id)?;
    invalidate_collab_role_preview_cache(state, &role);
    let status = compute_collab_role_status_from_row(state, &role, idle_threshold_secs)?;
    if !status.completed {
        return Ok((task, None, true));
    }
    if normalize_collab_task_status(&task.status) == CollabTaskStatus::Replied {
        let artifact = task
            .latest_artifact_id
            .as_deref()
            .and_then(|artifact_id| load_collab_artifact_row_db(&state.db_path, artifact_id).ok());
        return Ok((task, artifact, false));
    }
    if task.dispatched_at <= 0 {
        return Err("task has not been dispatched yet".to_string());
    }
    let (reply_output, last_seen_at) =
        read_collab_role_output_since(state, &role, task.dispatched_at)?;
    if reply_output.trim().is_empty() {
        let updated = mutate_collab_role_db(&state.db_path, workbench_id, &role.role_id, |item| {
            item.phase = collab_role_phase_key(CollabRolePhase::Error).to_string();
            item.last_error = Some("no output collected for dispatched task".to_string());
        })?;
        task.last_error = updated.last_error.clone();
        task.updated_at = now_epoch();
        save_collab_task_db(&state.db_path, &task)?;
        return Ok((task, None, false));
    }
    let _ = mutate_collab_role_db(&state.db_path, workbench_id, &role.role_id, |item| {
        item.last_read_at = last_seen_at;
        item.phase = collab_role_phase_key(CollabRolePhase::Ready).to_string();
        item.last_error = None;
    });
    let reply_envelope = extract_collab_reply_block(&reply_output);
    let summary = summarize_reply_content(&reply_output, reply_envelope.as_ref());
    let artifact_row = CollabArtifactRow {
        artifact_id: Uuid::new_v4().to_string(),
        workbench_id: workbench_id.to_string(),
        run_id: Some(task.run_id.clone()),
        task_id: Some(task.task_id.clone()),
        role_id: Some(role.role_id.clone()),
        kind: "reply".to_string(),
        title: task.title.clone(),
        summary: summary.clone(),
        content: reply_output.clone(),
        pane_id: role.pane_id.clone(),
        session_id: resolve_collab_role_session_id(state, &role),
        created_at: now_epoch(),
    };
    insert_collab_artifact_db(&state.db_path, &artifact_row)?;
    task.status = collab_task_status_key(CollabTaskStatus::Replied).to_string();
    task.latest_reply_summary = Some(summary.clone());
    task.latest_artifact_id = Some(artifact_row.artifact_id.clone());
    task.last_error = None;
    task.replied_at = artifact_row.created_at;
    task.updated_at = artifact_row.created_at;
    save_collab_task_db(&state.db_path, &task)?;
    insert_collab_event_db(
        &state.db_path,
        workbench_id,
        Some(&task.run_id),
        Some(&task.task_id),
        Some(&role.role_id),
        "reply_collected",
        &format!("采集回执：{} <- {}", task.title, role.name),
        Some(
            serde_json::json!({
                "summary": summary,
                "done": reply_envelope.as_ref().map(|item| item.done).unwrap_or(false),
                "artifact_id": artifact_row.artifact_id
            })
            .to_string(),
        ),
    )?;
    Ok((task, Some(artifact_row), false))
}

fn resolve_collab_task_internal(
    state: &AppState,
    workbench_id: &str,
    task_id: &str,
    accepted: bool,
    note: &str,
) -> Result<CollabTaskCardRow, String> {
    let mut task = load_collab_task_row_db(&state.db_path, task_id)?;
    if task.workbench_id != workbench_id {
        return Err("task does not belong to workbench".to_string());
    }
    if normalize_collab_task_status(&task.status) != CollabTaskStatus::Replied {
        return Err("task reply has not been collected yet".to_string());
    }
    let note_text = note.trim().to_string();
    task.status = if accepted {
        collab_task_status_key(CollabTaskStatus::Accepted).to_string()
    } else {
        collab_task_status_key(CollabTaskStatus::Rejected).to_string()
    };
    task.resolved_at = now_epoch();
    task.updated_at = task.resolved_at;
    task.validation_summary = if note_text.is_empty() {
        None
    } else {
        Some(note_text.clone())
    };
    task.validation_checked_at = task.resolved_at;
    task.last_error = if accepted {
        if note_text.is_empty() {
            None
        } else {
            Some(note_text.clone())
        }
    } else if note_text.is_empty() {
        Some("reply rejected".to_string())
    } else {
        Some(note_text.clone())
    };
    save_collab_task_db(&state.db_path, &task)?;
    insert_collab_event_db(
        &state.db_path,
        workbench_id,
        Some(&task.run_id),
        Some(&task.task_id),
        Some(&task.target_role_id),
        if accepted {
            "reply_accepted"
        } else {
            "reply_rejected"
        },
        &format!(
            "{}：{}",
            if accepted {
                "采纳回执"
            } else {
                "驳回回执"
            },
            task.title
        ),
        if note_text.is_empty() {
            None
        } else {
            Some(serde_json::json!({ "note": note_text }).to_string())
        },
    )?;
    Ok(task)
}

#[tauri::command]
pub(crate) fn collab_list_role_templates() -> Result<Vec<CollabRoleTemplateResponse>, String> {
    Ok(built_in_role_templates())
}

#[tauri::command]
pub(crate) fn collab_create_workbench(
    state: State<AppState>,
    name: String,
    project_directory: String,
    roles: Option<Vec<CollabRoleInput>>,
) -> Result<CollabCreateWorkbenchResponse, String> {
    ensure_collab_schema(&state.db_path)?;
    let project_path = normalize_working_directory(Some(project_directory))
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "project directory is empty".to_string())?;
    let trimmed_name = if name.trim().is_empty() {
        "协作工作台".to_string()
    } else {
        name.trim().to_string()
    };
    let workbench_id = Uuid::new_v4().to_string();
    let runtime_directory = project_path.join(".ai-collab").join(&workbench_id);
    fs::create_dir_all(&runtime_directory).map_err(|error| error.to_string())?;
    let created_at = now_epoch();
    upsert_collab_workbench_db(
        &state.db_path,
        &workbench_id,
        &trimmed_name,
        &project_path.to_string_lossy(),
        &runtime_directory.to_string_lossy(),
        created_at,
    )?;
    let workbench = load_collab_workbench_row_db(&state.db_path, &workbench_id)?;
    let requested_roles = roles
        .filter(|items| !items.is_empty())
        .unwrap_or_else(|| default_roles_from_provider("codex"));
    let mut existing = Vec::<CollabRoleRow>::new();
    for item in requested_roles {
        let row = create_role_row_from_input(&workbench, &existing, &item)?;
        insert_collab_role_db(&state.db_path, &row)?;
        insert_collab_event_db(
            &state.db_path,
            &workbench_id,
            None,
            None,
            Some(&row.role_id),
            "role_added",
            &format!("添加角色：{}（{}）", row.name, row.provider),
            None,
        )?;
        existing.push(row);
    }
    Ok(CollabCreateWorkbenchResponse {
        snapshot: load_collab_snapshot_db(&state, &workbench_id)?,
    })
}

#[tauri::command]
pub(crate) fn collab_get_snapshot(
    state: State<AppState>,
    workbench_id: String,
) -> Result<CollabWorkbenchSnapshotResponse, String> {
    load_collab_snapshot_db(&state, &workbench_id)
}

#[tauri::command]
pub(crate) fn collab_initialize_roles(
    app: AppHandle,
    state: State<AppState>,
    workbench_id: String,
) -> Result<CollabInitializeRolesResponse, String> {
    ensure_collab_schema(&state.db_path)?;
    let roles = list_collab_role_rows_db(&state.db_path, &workbench_id)?;
    if roles.is_empty() {
        return Err("workbench has no roles".to_string());
    }
    let mut created_pane_ids = Vec::new();
    for role in roles {
        let (pane_id, created) =
            ensure_collab_role_pane(&app, &state, &workbench_id, &role.role_id)?;
        if created {
            created_pane_ids.push(pane_id);
        }
        let refreshed = load_collab_role_row_db(&state.db_path, &workbench_id, &role.role_id)?;
        if resolve_collab_role_session_id(&state, &refreshed).is_empty() {
            launch_collab_role_provider_shell(&state, &workbench_id, &role.role_id)?;
        }
        let _ = mutate_collab_role_db(&state.db_path, &workbench_id, &role.role_id, |item| {
            item.phase = collab_role_phase_key(CollabRolePhase::Initialized).to_string();
            item.last_error = None;
        });
    }
    Ok(CollabInitializeRolesResponse {
        snapshot: load_collab_snapshot_db(&state, &workbench_id)?,
        created_pane_ids,
    })
}

#[tauri::command]
pub(crate) fn collab_add_role(
    state: State<AppState>,
    workbench_id: String,
    role: CollabRoleInput,
) -> Result<CollabAddRoleResponse, String> {
    ensure_collab_schema(&state.db_path)?;
    let workbench = load_collab_workbench_row_db(&state.db_path, &workbench_id)?;
    let existing = list_collab_role_rows_db(&state.db_path, &workbench_id)?;
    let row = create_role_row_from_input(&workbench, &existing, &role)?;
    insert_collab_role_db(&state.db_path, &row)?;
    insert_collab_event_db(
        &state.db_path,
        &workbench_id,
        None,
        None,
        Some(&row.role_id),
        "role_added",
        &format!("添加角色：{}（{}）", row.name, row.provider),
        Some(
            serde_json::json!({
                "role_key": row.role_key,
                "template_key": row.template_key,
                "provider": row.provider
            })
            .to_string(),
        ),
    )?;
    Ok(CollabAddRoleResponse {
        snapshot: load_collab_snapshot_db(&state, &workbench_id)?,
        role: build_collab_role_snapshot(&state, &row),
    })
}

#[tauri::command]
pub(crate) fn collab_remove_role(
    state: State<AppState>,
    workbench_id: String,
    role_id: String,
) -> Result<CollabWorkbenchSnapshotResponse, String> {
    ensure_collab_schema(&state.db_path)?;
    let role = load_collab_role_row_db(&state.db_path, &workbench_id, &role_id)?;
    if count_tasks_for_role_db(&state.db_path, &role_id)? > 0 {
        return Err(
            "role already referenced by existing task cards and cannot be removed".to_string(),
        );
    }
    delete_collab_role_db(&state.db_path, &workbench_id, &role_id)?;
    insert_collab_event_db(
        &state.db_path,
        &workbench_id,
        None,
        None,
        Some(&role_id),
        "role_removed",
        &format!("移除角色：{}", role.name),
        None,
    )?;
    load_collab_snapshot_db(&state, &workbench_id)
}

#[tauri::command]
pub(crate) fn collab_set_role_sid(
    state: State<AppState>,
    workbench_id: String,
    role_id: String,
    session_id: String,
) -> Result<CollabRoleSidResponse, String> {
    let sid = session_id.trim().to_string();
    if sid.is_empty() {
        return Err("session_id is empty".to_string());
    }
    let role = load_collab_role_row_db(&state.db_path, &workbench_id, &role_id)?;
    if role.pane_id.trim().is_empty() {
        return Err("role has no pane yet, please initialize first".to_string());
    }
    upsert_pane_session_state_db(
        &state.db_path,
        &role.pane_id,
        Some(sid.clone()),
        Some(Vec::new()),
        Some(false),
    )
    .map_err(|error| error.to_string())?;
    let updated = mutate_collab_role_db(&state.db_path, &workbench_id, &role_id, |item| {
        item.session_id = sid.clone();
        item.phase = collab_role_phase_key(CollabRolePhase::Ready).to_string();
        item.last_error = None;
    })?;
    Ok(collab_role_sid_response(&state, &updated))
}

#[tauri::command]
pub(crate) fn collab_clear_role_sid(
    state: State<AppState>,
    workbench_id: String,
    role_id: String,
) -> Result<CollabRoleSidResponse, String> {
    let role = load_collab_role_row_db(&state.db_path, &workbench_id, &role_id)?;
    if role.pane_id.trim().is_empty() {
        return Err("role has no pane yet, please initialize first".to_string());
    }
    upsert_pane_session_state_db(
        &state.db_path,
        &role.pane_id,
        Some(String::new()),
        Some(Vec::new()),
        Some(false),
    )
    .map_err(|error| error.to_string())?;
    let updated = mutate_collab_role_db(&state.db_path, &workbench_id, &role_id, |item| {
        item.session_id.clear();
        item.phase = collab_role_phase_key(CollabRolePhase::Initialized).to_string();
        item.last_error = Some("session id cleared by workbench".to_string());
    })?;
    Ok(collab_role_sid_response(&state, &updated))
}

#[tauri::command]
pub(crate) fn collab_send_role_message(
    state: State<AppState>,
    workbench_id: String,
    role_id: String,
    message: String,
    submit: Option<bool>,
) -> Result<CollabSendMessageResponse, String> {
    let role = load_collab_role_row_db(&state.db_path, &workbench_id, &role_id)?;
    if role.pane_id.trim().is_empty() {
        return Err("role has no pane yet, please initialize first".to_string());
    }
    let session_id = resolve_collab_role_session_id(&state, &role);
    if session_id.is_empty() {
        return Err("role has no session id yet, please bind sid first".to_string());
    }
    paste_to_pane_internal(
        &state,
        &role.pane_id,
        message.trim(),
        submit.unwrap_or(true),
    )
    .map_err(|error| error.to_string())?;
    let sent_at = now_epoch();
    let _ = mutate_collab_role_db(&state.db_path, &workbench_id, &role_id, |item| {
        item.last_sent_at = sent_at;
        item.phase = collab_role_phase_key(CollabRolePhase::Running).to_string();
        item.last_error = None;
    })?;
    Ok(CollabSendMessageResponse {
        accepted: true,
        pane_id: role.pane_id,
        session_id,
        role_id,
        sent_at,
    })
}

#[tauri::command]
pub(crate) fn collab_load_role_conversation(
    state: State<AppState>,
    workbench_id: String,
    role_id: String,
    limit: Option<i64>,
    offset: Option<i64>,
    from_end: Option<bool>,
) -> Result<CollabConversationResponse, String> {
    let role = load_collab_role_row_db(&state.db_path, &workbench_id, &role_id)?;
    let session_id = resolve_collab_role_session_id(&state, &role);
    if role.pane_id.trim().is_empty() || session_id.is_empty() {
        return Ok(CollabConversationResponse {
            role_id,
            session_id,
            rows: Vec::new(),
            total_rows: 0,
            loaded_rows: 0,
            has_more: false,
        });
    }
    let all_rows = load_collab_role_preview_rows(&state, &role)?;
    let total_rows = all_rows.len() as i64;
    let message_limit = limit.unwrap_or(60).clamp(1, 5000) as usize;
    let message_offset = offset.unwrap_or(0).max(0) as usize;
    let from_end_flag = from_end.unwrap_or(true);
    let (rows, has_more) = if from_end_flag {
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
    let loaded_rows = rows.len() as i64;
    Ok(CollabConversationResponse {
        role_id,
        session_id,
        rows,
        total_rows,
        loaded_rows,
        has_more,
    })
}

#[tauri::command]
pub(crate) fn collab_create_run(
    state: State<AppState>,
    workbench_id: String,
    title: String,
    goal: String,
) -> Result<CollabCreateRunResponse, String> {
    ensure_collab_schema(&state.db_path)?;
    if goal.trim().is_empty() {
        return Err("goal is empty".to_string());
    }
    if let Some(existing) = load_active_collab_run_row_db(&state.db_path, &workbench_id)? {
        if !is_collab_run_done(normalize_collab_run_status(&existing.status)) {
            return Err("a workbench run is already in progress".to_string());
        }
    }
    let now = now_epoch();
    let row = CollabRunRow {
        run_id: Uuid::new_v4().to_string(),
        workbench_id: workbench_id.clone(),
        title: if title.trim().is_empty() {
            "未命名协作 Run".to_string()
        } else {
            title.trim().to_string()
        },
        goal: goal.trim().to_string(),
        status: collab_run_status_key(CollabRunStatus::Active).to_string(),
        final_summary: None,
        created_at: now,
        updated_at: now,
    };
    save_collab_run_db(&state.db_path, &row)?;
    insert_collab_event_db(
        &state.db_path,
        &workbench_id,
        Some(&row.run_id),
        None,
        None,
        "run_created",
        &format!("创建协作 Run：{}", row.title),
        Some(serde_json::json!({ "goal": row.goal }).to_string()),
    )?;
    Ok(CollabCreateRunResponse {
        snapshot: load_collab_snapshot_db(&state, &workbench_id)?,
        run: build_collab_run_snapshot(&row),
    })
}

#[tauri::command]
pub(crate) fn collab_create_task_card(
    state: State<AppState>,
    workbench_id: String,
    run_id: String,
    target_role_id: String,
    source_role_id: Option<String>,
    title: String,
    goal: String,
    constraints_text: Option<String>,
    input_summary: Option<String>,
    expected_output: Option<String>,
) -> Result<CollabCreateTaskCardResponse, String> {
    ensure_collab_schema(&state.db_path)?;
    if goal.trim().is_empty() {
        return Err("task goal is empty".to_string());
    }
    let run = load_collab_run_row_db(&state.db_path, &run_id)?;
    if run.workbench_id != workbench_id {
        return Err("run does not belong to workbench".to_string());
    }
    if is_collab_run_done(normalize_collab_run_status(&run.status)) {
        return Err("run is already closed".to_string());
    }
    let target_role = load_collab_role_row_db(&state.db_path, &workbench_id, &target_role_id)?;
    if let Some(source_role_id) = source_role_id.as_deref() {
        let _ = load_collab_role_row_db(&state.db_path, &workbench_id, source_role_id)?;
    }
    let now = now_epoch();
    let row = CollabTaskCardRow {
        task_id: Uuid::new_v4().to_string(),
        workbench_id: workbench_id.clone(),
        run_id: run_id.clone(),
        source_role_id: source_role_id.clone(),
        target_role_id: target_role_id.clone(),
        title: if title.trim().is_empty() {
            format!("{} 任务", target_role.name)
        } else {
            title.trim().to_string()
        },
        goal: goal.trim().to_string(),
        constraints_text: constraints_text.unwrap_or_default().trim().to_string(),
        input_summary: input_summary.unwrap_or_default().trim().to_string(),
        expected_output: expected_output.unwrap_or_default().trim().to_string(),
        status: collab_task_status_key(CollabTaskStatus::Queued).to_string(),
        latest_reply_summary: None,
        latest_artifact_id: None,
        last_error: None,
        dependency_task_ids_json: "[]".to_string(),
        wave_index: 0,
        plan_order: 0,
        auto_generated: false,
        validation_summary: None,
        validation_checked_at: 0,
        created_at: now,
        dispatched_at: 0,
        replied_at: 0,
        resolved_at: 0,
        updated_at: now,
    };
    save_collab_task_db(&state.db_path, &row)?;
    insert_collab_event_db(
        &state.db_path,
        &workbench_id,
        Some(&run_id),
        Some(&row.task_id),
        Some(&target_role_id),
        "task_created",
        &format!("创建任务卡：{} -> {}", row.title, target_role.name),
        Some(
            serde_json::json!({
                "goal": row.goal,
                "constraints_text": row.constraints_text,
                "expected_output": row.expected_output
            })
            .to_string(),
        ),
    )?;
    Ok(CollabCreateTaskCardResponse {
        snapshot: load_collab_snapshot_db(&state, &workbench_id)?,
        task: build_collab_task_snapshot(&row),
    })
}

#[tauri::command]
pub(crate) fn collab_auto_plan_run(
    state: State<AppState>,
    workbench_id: String,
    run_id: String,
) -> Result<CollabAutoPlanResponse, String> {
    ensure_collab_schema(&state.db_path)?;
    let workbench = load_collab_workbench_row_db(&state.db_path, &workbench_id)?;
    let run = load_collab_run_row_db(&state.db_path, &run_id)?;
    if run.workbench_id != workbench_id {
        return Err("run does not belong to workbench".to_string());
    }
    if is_collab_run_done(normalize_collab_run_status(&run.status)) {
        return Err("run is already closed".to_string());
    }
    if !list_collab_task_rows_for_run_db(&state.db_path, &run_id)?.is_empty() {
        return Err("auto plan requires an empty task board for this run".to_string());
    }
    let roles = list_collab_role_rows_db(&state.db_path, &workbench_id)?;
    let planner = roles
        .iter()
        .find(|role| role.template_key.trim().eq_ignore_ascii_case("planner"))
        .or_else(|| {
            roles
                .iter()
                .find(|role| role.role_key.trim().eq_ignore_ascii_case("planner"))
        })
        .cloned()
        .ok_or_else(|| "planner role is required for auto planning".to_string())?;
    if planner.pane_id.trim().is_empty() {
        return Err("planner role has no pane yet, please initialize roles first".to_string());
    }
    let planner_session_id = resolve_collab_role_session_id(&state, &planner);
    if planner_session_id.is_empty() {
        return Err("planner role has no session id yet, please bind sid first".to_string());
    }

    let prompt = build_collab_plan_prompt(&workbench, &run, &roles);
    paste_to_pane_internal(&state, &planner.pane_id, &prompt, true)
        .map_err(|error| error.to_string())?;
    let sent_at = now_epoch();
    let _ = mutate_collab_role_db(&state.db_path, &workbench_id, &planner.role_id, |item| {
        item.last_sent_at = sent_at;
        item.phase = collab_role_phase_key(CollabRolePhase::Running).to_string();
        item.last_error = None;
    })?;

    let planner = wait_for_collab_role_completion(&state, &planner, sent_at, 120, 5)?;
    invalidate_collab_role_preview_cache(&state, &planner);
    let (planner_output, planner_last_seen_at) =
        read_collab_role_output_since(&state, &planner, sent_at)?;
    if planner_output.trim().is_empty() {
        return Err("planner returned no output".to_string());
    }
    let _ = mutate_collab_role_db(&state.db_path, &workbench_id, &planner.role_id, |item| {
        item.last_read_at = planner_last_seen_at;
        item.phase = collab_role_phase_key(CollabRolePhase::Ready).to_string();
        item.last_error = None;
    });

    let plan = extract_collab_plan_block(&planner_output)
        .ok_or_else(|| "planner output is missing a valid <collab_plan> block".to_string())?;
    if plan.tasks.is_empty() {
        return Err("planner returned an empty task list".to_string());
    }

    let mut seen_plan_keys = std::collections::HashSet::<String>::new();
    let mut normalized_plan = Vec::<(
        String,
        String,
        String,
        String,
        Vec<String>,
        String,
        String,
        String,
    )>::new();
    for (index, item) in plan.tasks.iter().enumerate() {
        let key = normalize_plan_task_key(&item.key, index);
        if !seen_plan_keys.insert(key.clone()) {
            return Err(format!("planner returned duplicate task key {}", key));
        }
        let role = find_collab_role_for_plan(&roles, &item.role_key).ok_or_else(|| {
            format!(
                "planner referenced unknown role_key {}",
                item.role_key.trim()
            )
        })?;
        let goal = item.goal.trim().to_string();
        if goal.is_empty() {
            return Err(format!("planner task {} has empty goal", key));
        }
        normalized_plan.push((
            key.clone(),
            role.role_id.clone(),
            if item.title.trim().is_empty() {
                format!("{} 任务", role.name)
            } else {
                item.title.trim().to_string()
            },
            goal,
            normalize_dependency_keys(item.dependencies.as_ref(), &key),
            item.constraints_text
                .clone()
                .unwrap_or_default()
                .trim()
                .to_string(),
            item.input_summary
                .clone()
                .unwrap_or_default()
                .trim()
                .to_string(),
            item.expected_output
                .clone()
                .unwrap_or_default()
                .trim()
                .to_string(),
        ));
    }

    let wave_map = compute_plan_wave_map(
        &normalized_plan
            .iter()
            .map(|(key, _, _, _, dependencies, _, _, _)| (key.clone(), dependencies.clone()))
            .collect::<Vec<_>>(),
    )?;
    let id_map = normalized_plan
        .iter()
        .map(|(key, _, _, _, _, _, _, _)| (key.clone(), Uuid::new_v4().to_string()))
        .collect::<std::collections::HashMap<_, _>>();
    let created_at = now_epoch();
    let mut created_task_ids = Vec::new();
    for (
        index,
        (
            key,
            target_role_id,
            title,
            goal,
            dependencies,
            constraints_text,
            input_summary,
            expected_output,
        ),
    ) in normalized_plan.iter().enumerate()
    {
        let dependency_task_ids = dependencies
            .iter()
            .filter_map(|dependency_key| id_map.get(dependency_key).cloned())
            .collect::<Vec<_>>();
        let row = CollabTaskCardRow {
            task_id: id_map
                .get(key)
                .cloned()
                .ok_or_else(|| format!("missing generated task id for {}", key))?,
            workbench_id: workbench_id.clone(),
            run_id: run_id.clone(),
            source_role_id: Some(planner.role_id.clone()),
            target_role_id: target_role_id.clone(),
            title: title.clone(),
            goal: goal.clone(),
            constraints_text: constraints_text.clone(),
            input_summary: input_summary.clone(),
            expected_output: expected_output.clone(),
            status: collab_task_status_key(CollabTaskStatus::Queued).to_string(),
            latest_reply_summary: None,
            latest_artifact_id: None,
            last_error: None,
            dependency_task_ids_json: serialize_json(&dependency_task_ids)?,
            wave_index: *wave_map.get(key).unwrap_or(&0),
            plan_order: index as i64,
            auto_generated: true,
            validation_summary: None,
            validation_checked_at: 0,
            created_at: created_at + index as i64,
            dispatched_at: 0,
            replied_at: 0,
            resolved_at: 0,
            updated_at: created_at + index as i64,
        };
        save_collab_task_db(&state.db_path, &row)?;
        insert_collab_event_db(
            &state.db_path,
            &workbench_id,
            Some(&run_id),
            Some(&row.task_id),
            Some(&row.target_role_id),
            "task_created",
            &format!("自动拆解任务：{}", row.title),
            Some(
                serde_json::json!({
                    "auto_generated": true,
                    "wave_index": row.wave_index,
                    "dependency_task_ids": dependency_task_ids,
                    "goal": row.goal,
                })
                .to_string(),
            ),
        )?;
        created_task_ids.push(row.task_id.clone());
    }

    let artifact_row = CollabArtifactRow {
        artifact_id: Uuid::new_v4().to_string(),
        workbench_id: workbench_id.clone(),
        run_id: Some(run_id.clone()),
        task_id: None,
        role_id: Some(planner.role_id.clone()),
        kind: "plan".to_string(),
        title: format!("{} 自动计划", run.title),
        summary: if plan.summary.trim().is_empty() {
            format!("自动拆解生成 {} 个任务", created_task_ids.len())
        } else {
            plan.summary.trim().to_string()
        },
        content: planner_output,
        pane_id: planner.pane_id.clone(),
        session_id: planner_session_id,
        created_at: now_epoch(),
    };
    insert_collab_artifact_db(&state.db_path, &artifact_row)?;
    insert_collab_event_db(
        &state.db_path,
        &workbench_id,
        Some(&run_id),
        None,
        Some(&planner.role_id),
        "run_auto_planned",
        &format!(
            "自动拆解完成：{} 个任务 / {} 个波次",
            created_task_ids.len(),
            wave_map.values().max().copied().unwrap_or(0) + 1
        ),
        Some(
            serde_json::json!({
                "task_count": created_task_ids.len(),
                "wave_count": wave_map.values().max().copied().unwrap_or(0) + 1,
                "artifact_id": artifact_row.artifact_id
            })
            .to_string(),
        ),
    )?;
    Ok(CollabAutoPlanResponse {
        snapshot: load_collab_snapshot_db(&state, &workbench_id)?,
        created_task_ids,
        artifact: Some(build_collab_artifact_snapshot(&artifact_row)),
    })
}

#[tauri::command]
pub(crate) fn collab_dispatch_ready_wave(
    state: State<AppState>,
    workbench_id: String,
    run_id: String,
) -> Result<CollabDispatchWaveResponse, String> {
    ensure_collab_schema(&state.db_path)?;
    let run = load_collab_run_row_db(&state.db_path, &run_id)?;
    if run.workbench_id != workbench_id {
        return Err("run does not belong to workbench".to_string());
    }
    let tasks = list_collab_task_rows_for_run_db(&state.db_path, &run_id)?;
    if tasks.is_empty() {
        return Err("run has no task cards".to_string());
    }
    if tasks
        .iter()
        .any(|task| normalize_collab_task_status(&task.status) == CollabTaskStatus::Dispatched)
    {
        return Err("there are still dispatched tasks waiting for collection".to_string());
    }
    let task_map = tasks
        .iter()
        .map(|task| (task.task_id.clone(), task.clone()))
        .collect::<std::collections::HashMap<_, _>>();
    let ready_tasks = tasks
        .iter()
        .filter(|task| {
            matches!(
                normalize_collab_task_status(&task.status),
                CollabTaskStatus::Draft | CollabTaskStatus::Queued
            ) && collab_task_dependencies_accepted(task, &task_map)
        })
        .cloned()
        .collect::<Vec<_>>();
    if ready_tasks.is_empty() {
        return Err("no ready task wave can be dispatched".to_string());
    }
    let wave_index = ready_tasks
        .iter()
        .map(|task| task.wave_index)
        .min()
        .unwrap_or(0);
    let mut dispatched_task_ids = Vec::new();
    for task in ready_tasks
        .into_iter()
        .filter(|task| task.wave_index == wave_index)
    {
        let _ = dispatch_collab_task_internal(&state, &workbench_id, &task.task_id)?;
        dispatched_task_ids.push(task.task_id);
    }
    insert_collab_event_db(
        &state.db_path,
        &workbench_id,
        Some(&run_id),
        None,
        None,
        "wave_dispatched",
        &format!("已派发第 {} 波任务，共 {} 个", wave_index + 1, dispatched_task_ids.len()),
        Some(
            serde_json::json!({ "wave_index": wave_index, "task_ids": dispatched_task_ids.clone() }).to_string(),
        ),
    )?;
    Ok(CollabDispatchWaveResponse {
        snapshot: load_collab_snapshot_db(&state, &workbench_id)?,
        dispatched_task_ids,
        wave_index,
    })
}

#[tauri::command]
pub(crate) fn collab_auto_validate_wave(
    state: State<AppState>,
    workbench_id: String,
    run_id: String,
    idle_threshold_secs: Option<i64>,
) -> Result<CollabAutoValidateWaveResponse, String> {
    ensure_collab_schema(&state.db_path)?;
    let run = load_collab_run_row_db(&state.db_path, &run_id)?;
    if run.workbench_id != workbench_id {
        return Err("run does not belong to workbench".to_string());
    }
    let mut tasks = list_collab_task_rows_for_run_db(&state.db_path, &run_id)?;
    if tasks.is_empty() {
        return Err("run has no task cards".to_string());
    }
    let wave_index = tasks
        .iter()
        .filter(|task| {
            matches!(
                normalize_collab_task_status(&task.status),
                CollabTaskStatus::Dispatched | CollabTaskStatus::Replied
            )
        })
        .map(|task| task.wave_index)
        .min()
        .ok_or_else(|| "there is no active wave to validate".to_string())?;
    tasks.sort_by_key(|task| (task.wave_index, task.plan_order, task.created_at));

    let mut accepted_task_ids = Vec::new();
    let mut rejected_task_ids = Vec::new();
    let mut waiting_task_ids = Vec::new();

    for task in tasks
        .into_iter()
        .filter(|task| task.wave_index == wave_index)
    {
        let task_status = normalize_collab_task_status(&task.status);
        if collab_task_is_terminal(task_status) {
            continue;
        }
        if task_status == CollabTaskStatus::Dispatched {
            let (_collected_task, _artifact, waiting) = collect_collab_task_reply_internal(
                &state,
                &workbench_id,
                &task.task_id,
                idle_threshold_secs.unwrap_or(5),
            )?;
            if waiting {
                waiting_task_ids.push(task.task_id.clone());
                continue;
            }
        }
        let mut latest_task = load_collab_task_row_db(&state.db_path, &task.task_id)?;
        if normalize_collab_task_status(&latest_task.status) == CollabTaskStatus::Replied {
            let artifact = latest_task
                .latest_artifact_id
                .as_deref()
                .and_then(|artifact_id| {
                    load_collab_artifact_row_db(&state.db_path, artifact_id).ok()
                });
            let reply_envelope = artifact
                .as_ref()
                .and_then(|item| extract_collab_reply_block(&item.content));
            let accepted = reply_envelope
                .as_ref()
                .map(|item| item.done)
                .unwrap_or(false);
            let summary = reply_envelope
                .as_ref()
                .map(|item| item.summary.trim().to_string())
                .filter(|item| !item.is_empty())
                .or_else(|| latest_task.latest_reply_summary.clone())
                .unwrap_or_else(|| {
                    if accepted {
                        "自动校验通过".to_string()
                    } else {
                        "自动校验未通过：缺少 done=true".to_string()
                    }
                });
            let note = if accepted {
                format!("自动校验通过：{}", summary)
            } else {
                format!("自动校验未通过：{}", summary)
            };
            let _ = resolve_collab_task_internal(
                &state,
                &workbench_id,
                &task.task_id,
                accepted,
                &note,
            )?;
            if accepted {
                accepted_task_ids.push(task.task_id.clone());
            } else {
                rejected_task_ids.push(task.task_id.clone());
            }
            continue;
        }
        if latest_task.last_error.is_some() {
            let now = now_epoch();
            latest_task.status = collab_task_status_key(CollabTaskStatus::Rejected).to_string();
            latest_task.validation_summary = Some(format!(
                "自动校验失败：{}",
                latest_task
                    .last_error
                    .clone()
                    .unwrap_or_else(|| "unknown error".to_string())
            ));
            latest_task.validation_checked_at = now;
            latest_task.resolved_at = now;
            latest_task.updated_at = now;
            save_collab_task_db(&state.db_path, &latest_task)?;
            insert_collab_event_db(
                &state.db_path,
                &workbench_id,
                Some(&run_id),
                Some(&latest_task.task_id),
                Some(&latest_task.target_role_id),
                "reply_rejected",
                &format!("自动驳回任务：{}", latest_task.title),
                Some(
                    serde_json::json!({
                        "reason": latest_task.last_error.clone().unwrap_or_default(),
                        "auto_validation": true
                    })
                    .to_string(),
                ),
            )?;
            rejected_task_ids.push(latest_task.task_id.clone());
        } else {
            waiting_task_ids.push(latest_task.task_id.clone());
        }
    }

    insert_collab_event_db(
        &state.db_path,
        &workbench_id,
        Some(&run_id),
        None,
        None,
        "wave_auto_validated",
        &format!(
            "第 {} 波自动校验：通过 {} 个 / 驳回 {} 个 / 等待 {} 个",
            wave_index + 1,
            accepted_task_ids.len(),
            rejected_task_ids.len(),
            waiting_task_ids.len()
        ),
        Some(
            serde_json::json!({
                "wave_index": wave_index,
                "accepted_task_ids": accepted_task_ids.clone(),
                "rejected_task_ids": rejected_task_ids.clone(),
                "waiting_task_ids": waiting_task_ids.clone(),
            })
            .to_string(),
        ),
    )?;
    Ok(CollabAutoValidateWaveResponse {
        snapshot: load_collab_snapshot_db(&state, &workbench_id)?,
        accepted_task_ids,
        rejected_task_ids,
        waiting_task_ids,
        wave_index,
    })
}

#[tauri::command]
pub(crate) fn collab_dispatch_task_card(
    state: State<AppState>,
    workbench_id: String,
    task_id: String,
) -> Result<CollabDispatchTaskCardResponse, String> {
    ensure_collab_schema(&state.db_path)?;
    let mut task = load_collab_task_row_db(&state.db_path, &task_id)?;
    if task.workbench_id != workbench_id {
        return Err("task does not belong to workbench".to_string());
    }
    let task_status = normalize_collab_task_status(&task.status);
    if !matches!(
        task_status,
        CollabTaskStatus::Draft | CollabTaskStatus::Queued
    ) {
        return Err("task is not ready to dispatch".to_string());
    }
    let workbench = load_collab_workbench_row_db(&state.db_path, &workbench_id)?;
    let run = load_collab_run_row_db(&state.db_path, &task.run_id)?;
    let role = load_collab_role_row_db(&state.db_path, &workbench_id, &task.target_role_id)?;
    if role.pane_id.trim().is_empty() {
        return Err("target role has no pane yet, please initialize roles first".to_string());
    }
    let session_id = resolve_collab_role_session_id(&state, &role);
    if session_id.is_empty() {
        return Err("target role has no session id yet, please bind sid first".to_string());
    }
    let source_role_name = task
        .source_role_id
        .as_deref()
        .and_then(|role_id| load_collab_role_row_db(&state.db_path, &workbench_id, role_id).ok())
        .map(|item| item.name)
        .unwrap_or_else(|| "用户/工作台".to_string());
    let prompt =
        build_collab_dispatch_prompt(&workbench, &run, Some(&source_role_name), &role, &task);
    paste_to_pane_internal(&state, &role.pane_id, &prompt, true)
        .map_err(|error| error.to_string())?;
    let sent_at = now_epoch();
    let _ = mutate_collab_role_db(&state.db_path, &workbench_id, &role.role_id, |item| {
        item.last_sent_at = sent_at;
        item.phase = collab_role_phase_key(CollabRolePhase::Running).to_string();
        item.last_error = None;
    })?;
    task.status = collab_task_status_key(CollabTaskStatus::Dispatched).to_string();
    task.dispatched_at = sent_at;
    task.updated_at = sent_at;
    task.last_error = None;
    save_collab_task_db(&state.db_path, &task)?;
    insert_collab_event_db(
        &state.db_path,
        &workbench_id,
        Some(&task.run_id),
        Some(&task.task_id),
        Some(&role.role_id),
        "task_dispatched",
        &format!("派发任务卡：{} -> {}", task.title, role.name),
        Some(serde_json::json!({ "session_id": session_id, "sent_at": sent_at }).to_string()),
    )?;
    Ok(CollabDispatchTaskCardResponse {
        snapshot: load_collab_snapshot_db(&state, &workbench_id)?,
        task: build_collab_task_snapshot(&task),
        sent_at,
    })
}

#[tauri::command]
pub(crate) fn collab_collect_role_reply(
    state: State<AppState>,
    workbench_id: String,
    task_id: String,
    idle_threshold_secs: Option<i64>,
) -> Result<CollabCollectRoleReplyResponse, String> {
    ensure_collab_schema(&state.db_path)?;
    let mut task = load_collab_task_row_db(&state.db_path, &task_id)?;
    if task.workbench_id != workbench_id {
        return Err("task does not belong to workbench".to_string());
    }
    let role = load_collab_role_row_db(&state.db_path, &workbench_id, &task.target_role_id)?;
    let status =
        compute_collab_role_status_from_row(&state, &role, idle_threshold_secs.unwrap_or(5))?;
    if !status.completed {
        return Ok(CollabCollectRoleReplyResponse {
            snapshot: load_collab_snapshot_db(&state, &workbench_id)?,
            task: build_collab_task_snapshot(&task),
            artifact: None,
            waiting: true,
        });
    }
    if normalize_collab_task_status(&task.status) == CollabTaskStatus::Replied {
        let artifact = task
            .latest_artifact_id
            .as_deref()
            .and_then(|artifact_id| load_collab_artifact_row_db(&state.db_path, artifact_id).ok())
            .map(|item| build_collab_artifact_snapshot(&item));
        return Ok(CollabCollectRoleReplyResponse {
            snapshot: load_collab_snapshot_db(&state, &workbench_id)?,
            task: build_collab_task_snapshot(&task),
            artifact,
            waiting: false,
        });
    }
    if task.dispatched_at <= 0 {
        return Err("task has not been dispatched yet".to_string());
    }
    let (reply_output, last_seen_at) =
        read_collab_role_output_since(&state, &role, task.dispatched_at)?;
    if reply_output.trim().is_empty() {
        let updated =
            mutate_collab_role_db(&state.db_path, &workbench_id, &role.role_id, |item| {
                item.phase = collab_role_phase_key(CollabRolePhase::Error).to_string();
                item.last_error = Some("no output collected for dispatched task".to_string());
            })?;
        task.last_error = updated.last_error.clone();
        task.updated_at = now_epoch();
        save_collab_task_db(&state.db_path, &task)?;
        return Ok(CollabCollectRoleReplyResponse {
            snapshot: load_collab_snapshot_db(&state, &workbench_id)?,
            task: build_collab_task_snapshot(&task),
            artifact: None,
            waiting: false,
        });
    }
    let _ = mutate_collab_role_db(&state.db_path, &workbench_id, &role.role_id, |item| {
        item.last_read_at = last_seen_at;
        item.phase = collab_role_phase_key(CollabRolePhase::Ready).to_string();
        item.last_error = None;
    });
    let reply_envelope = extract_collab_reply_block(&reply_output);
    let summary = summarize_reply_content(&reply_output, reply_envelope.as_ref());
    let artifact_row = CollabArtifactRow {
        artifact_id: Uuid::new_v4().to_string(),
        workbench_id: workbench_id.clone(),
        run_id: Some(task.run_id.clone()),
        task_id: Some(task.task_id.clone()),
        role_id: Some(role.role_id.clone()),
        kind: "reply".to_string(),
        title: task.title.clone(),
        summary: summary.clone(),
        content: reply_output.clone(),
        pane_id: role.pane_id.clone(),
        session_id: resolve_collab_role_session_id(&state, &role),
        created_at: now_epoch(),
    };
    insert_collab_artifact_db(&state.db_path, &artifact_row)?;
    task.status = collab_task_status_key(CollabTaskStatus::Replied).to_string();
    task.latest_reply_summary = Some(summary.clone());
    task.latest_artifact_id = Some(artifact_row.artifact_id.clone());
    task.last_error = None;
    task.replied_at = artifact_row.created_at;
    task.updated_at = artifact_row.created_at;
    save_collab_task_db(&state.db_path, &task)?;
    insert_collab_event_db(
        &state.db_path,
        &workbench_id,
        Some(&task.run_id),
        Some(&task.task_id),
        Some(&role.role_id),
        "reply_collected",
        &format!("采集回执：{} <- {}", task.title, role.name),
        Some(
            serde_json::json!({
                "summary": summary,
                "done": reply_envelope.as_ref().map(|item| item.done).unwrap_or(false),
                "artifact_id": artifact_row.artifact_id
            })
            .to_string(),
        ),
    )?;
    Ok(CollabCollectRoleReplyResponse {
        snapshot: load_collab_snapshot_db(&state, &workbench_id)?,
        task: build_collab_task_snapshot(&task),
        artifact: Some(build_collab_artifact_snapshot(&artifact_row)),
        waiting: false,
    })
}

#[tauri::command]
pub(crate) fn collab_accept_reply(
    state: State<AppState>,
    workbench_id: String,
    task_id: String,
    note: Option<String>,
) -> Result<CollabTaskMutationResponse, String> {
    ensure_collab_schema(&state.db_path)?;
    let mut task = load_collab_task_row_db(&state.db_path, &task_id)?;
    if task.workbench_id != workbench_id {
        return Err("task does not belong to workbench".to_string());
    }
    if normalize_collab_task_status(&task.status) != CollabTaskStatus::Replied {
        return Err("task reply has not been collected yet".to_string());
    }
    let note_text = note.unwrap_or_default().trim().to_string();
    task.status = collab_task_status_key(CollabTaskStatus::Accepted).to_string();
    task.resolved_at = now_epoch();
    task.updated_at = task.resolved_at;
    task.last_error = if note_text.is_empty() {
        None
    } else {
        Some(note_text.clone())
    };
    save_collab_task_db(&state.db_path, &task)?;
    insert_collab_event_db(
        &state.db_path,
        &workbench_id,
        Some(&task.run_id),
        Some(&task.task_id),
        Some(&task.target_role_id),
        "reply_accepted",
        &format!("采纳回执：{}", task.title),
        if note_text.is_empty() {
            None
        } else {
            Some(serde_json::json!({ "note": note_text }).to_string())
        },
    )?;
    Ok(CollabTaskMutationResponse {
        snapshot: load_collab_snapshot_db(&state, &workbench_id)?,
        task: build_collab_task_snapshot(&task),
    })
}

#[tauri::command]
pub(crate) fn collab_reject_reply(
    state: State<AppState>,
    workbench_id: String,
    task_id: String,
    note: Option<String>,
) -> Result<CollabTaskMutationResponse, String> {
    ensure_collab_schema(&state.db_path)?;
    let mut task = load_collab_task_row_db(&state.db_path, &task_id)?;
    if task.workbench_id != workbench_id {
        return Err("task does not belong to workbench".to_string());
    }
    if normalize_collab_task_status(&task.status) != CollabTaskStatus::Replied {
        return Err("task reply has not been collected yet".to_string());
    }
    let note_text = note.unwrap_or_default().trim().to_string();
    task.status = collab_task_status_key(CollabTaskStatus::Rejected).to_string();
    task.resolved_at = now_epoch();
    task.updated_at = task.resolved_at;
    task.last_error = if note_text.is_empty() {
        Some("reply rejected by user".to_string())
    } else {
        Some(note_text.clone())
    };
    save_collab_task_db(&state.db_path, &task)?;
    insert_collab_event_db(
        &state.db_path,
        &workbench_id,
        Some(&task.run_id),
        Some(&task.task_id),
        Some(&task.target_role_id),
        "reply_rejected",
        &format!("驳回回执：{}", task.title),
        if note_text.is_empty() {
            None
        } else {
            Some(serde_json::json!({ "note": note_text }).to_string())
        },
    )?;
    Ok(CollabTaskMutationResponse {
        snapshot: load_collab_snapshot_db(&state, &workbench_id)?,
        task: build_collab_task_snapshot(&task),
    })
}

#[tauri::command]
pub(crate) fn collab_complete_run(
    state: State<AppState>,
    workbench_id: String,
    run_id: String,
    final_summary: String,
) -> Result<CollabCompleteRunResponse, String> {
    ensure_collab_schema(&state.db_path)?;
    if final_summary.trim().is_empty() {
        return Err("final summary is empty".to_string());
    }
    let mut run = load_collab_run_row_db(&state.db_path, &run_id)?;
    if run.workbench_id != workbench_id {
        return Err("run does not belong to workbench".to_string());
    }
    if is_collab_run_done(normalize_collab_run_status(&run.status)) {
        return Ok(CollabCompleteRunResponse {
            snapshot: load_collab_snapshot_db(&state, &workbench_id)?,
            run: build_collab_run_snapshot(&run),
            artifact: None,
        });
    }
    run.status = collab_run_status_key(CollabRunStatus::Completed).to_string();
    run.final_summary = Some(final_summary.trim().to_string());
    run.updated_at = now_epoch();
    save_collab_run_db(&state.db_path, &run)?;
    let artifact_row = CollabArtifactRow {
        artifact_id: Uuid::new_v4().to_string(),
        workbench_id: workbench_id.clone(),
        run_id: Some(run_id.clone()),
        task_id: None,
        role_id: None,
        kind: "final".to_string(),
        title: run.title.clone(),
        summary: final_summary.trim().to_string(),
        content: final_summary.trim().to_string(),
        pane_id: String::new(),
        session_id: String::new(),
        created_at: run.updated_at,
    };
    insert_collab_artifact_db(&state.db_path, &artifact_row)?;
    insert_collab_event_db(
        &state.db_path,
        &workbench_id,
        Some(&run_id),
        None,
        None,
        "run_completed",
        &format!("结束协作 Run：{}", run.title),
        Some(serde_json::json!({ "final_summary": final_summary.trim() }).to_string()),
    )?;
    Ok(CollabCompleteRunResponse {
        snapshot: load_collab_snapshot_db(&state, &workbench_id)?,
        run: build_collab_run_snapshot(&run),
        artifact: Some(build_collab_artifact_snapshot(&artifact_row)),
    })
}
