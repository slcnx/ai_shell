use super::*;

#[derive(Debug, Serialize)]
pub(crate) struct CompanyModeConfigResponse {
    enable_single_person_company: bool,
    code_directory: Option<String>,
    agents_directory: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct CompanyBootstrapResponse {
    commander: PaneSummary,
    worker: PaneSummary,
    code_directory: String,
    commander_directory: String,
    worker_directory: String,
    generated_files: Vec<String>,
}

#[derive(Debug, Deserialize, Clone, Default)]
#[serde(default)]
pub(crate) struct CompanyRolePaneConfig {
    provider: String,
    title: Option<String>,
    session_parse_preset: Option<String>,
    session_scan_glob: Option<String>,
    session_parse_json: Option<String>,
}

fn normalize_optional_directory_value(value: Option<String>) -> Result<Option<String>, String> {
    normalize_working_directory(value)
        .map(|path| path.map(|item| item.to_string_lossy().to_string()))
        .map_err(|error| error.to_string())
}

fn normalize_or_create_directory_value(value: Option<String>) -> Result<Option<String>, String> {
    let Some(raw) = value else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let mut resolved = PathBuf::from(trimmed);
    if resolved.is_relative() {
        let current = std::env::current_dir().map_err(|error| error.to_string())?;
        resolved = current.join(resolved);
    }

    fs::create_dir_all(&resolved).map_err(|error| error.to_string())?;
    Ok(Some(resolved.to_string_lossy().to_string()))
}

fn derive_runtime_root_from_code_directory(code_directory: &str) -> Result<String, String> {
    let code_path = normalize_working_directory(Some(code_directory.to_string()))
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "code directory is empty".to_string())?;
    Ok(code_path.join(".ai-company").to_string_lossy().to_string())
}

fn resolve_agents_directory(
    code_directory: Option<&String>,
    agents_directory: Option<String>,
) -> Option<String> {
    let explicit = agents_directory
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if explicit.is_some() {
        return explicit;
    }
    code_directory
        .and_then(|value| derive_runtime_root_from_code_directory(value).ok())
}

fn build_company_mode_config_response(config: &AppConfig) -> CompanyModeConfigResponse {
    CompanyModeConfigResponse {
        enable_single_person_company: config.enable_single_person_company,
        code_directory: config.company_code_directory.clone(),
        agents_directory: resolve_agents_directory(
            config.company_code_directory.as_ref(),
            config.company_agents_directory.clone(),
        ),
    }
}

#[tauri::command]
pub(crate) fn get_company_mode_config(
    state: State<AppState>,
) -> Result<CompanyModeConfigResponse, String> {
    let config = state
        .app_config
        .lock()
        .map_err(|_| "failed to lock app config".to_string())?
        .clone();
    Ok(build_company_mode_config_response(&config))
}

#[tauri::command]
pub(crate) fn set_company_mode_config(
    state: State<AppState>,
    enable_single_person_company: Option<bool>,
    code_directory: Option<String>,
    agents_directory: Option<String>,
) -> Result<CompanyModeConfigResponse, String> {
    let mut config = state
        .app_config
        .lock()
        .map_err(|_| "failed to lock app config".to_string())?;

    let next_enabled = enable_single_person_company.unwrap_or(config.enable_single_person_company);
    let next_code_directory = match code_directory {
        Some(value) => normalize_optional_directory_value(Some(value))?,
        None => config.company_code_directory.clone(),
    };
    let requested_agents_directory = match agents_directory {
        Some(value) => normalize_or_create_directory_value(Some(value))?,
        None => config.company_agents_directory.clone(),
    };
    let next_agents_directory = resolve_agents_directory(
        next_code_directory.as_ref(),
        requested_agents_directory,
    );

    if let Some(path) = next_agents_directory.as_ref() {
        fs::create_dir_all(path).map_err(|error| error.to_string())?;
    }

    config.enable_single_person_company = next_enabled;
    config.company_code_directory = next_code_directory;
    config.company_agents_directory = next_agents_directory;
    save_app_config(&state.config_path, &config).map_err(|error| error.to_string())?;

    Ok(build_company_mode_config_response(&config))
}

fn provider_label(provider: &str) -> String {
    let normalized = provider.trim().to_lowercase();
    if normalized.is_empty() {
        return "AI".to_string();
    }
    let mut chars = normalized.chars();
    let mut output = chars
        .next()
        .map(|ch| ch.to_uppercase().collect::<String>())
        .unwrap_or_else(|| "AI".to_string());
    output.push_str(chars.as_str());
    output
}

fn commander_agents_content(provider: &str, code_directory: &str, worker_dir: &str) -> String {
    format!(
        "# AGENTS.md instructions for {worker_dir}\n\n## Role\nYou are the commander role. Break down work, delegate execution, and review results.\n\n## Directories\n- Main code directory: `{code_directory}`\n- Worker role directory: `{worker_dir}`\n\n## Workflow\n- Talk to the user directly, clarify the goal, then delegate concrete execution to the worker role.\n- When code changes, commands, or file inspection are needed, prefer asking the worker role to do them.\n- Summarize worker results and make the final decision before replying to the user.\n\n## Methods To Control Worker\n- `send_message_to_session(session_id, message)`\n- `get_session_response_status(session_id)`\n- `read_session_messages_since_last_send(session_id)`\n\n## Provider\n- Recommended model: {provider}\n",
        provider = provider_label(provider),
        code_directory = code_directory,
        worker_dir = worker_dir,
    )
}

fn worker_agents_content(provider: &str, code_directory: &str) -> String {
    format!(
        "# AGENTS.md instructions for {code_directory}\n\n## Role\nYou are the worker role. Execute concrete tasks assigned by the commander.\n\n## Working Directory\n- Main code directory: `{code_directory}`\n\n## Execution Rules\n- Focus on execution instead of high-level decisions.\n- Run commands, inspect files, and edit code under the main code directory.\n- Report back concisely with: what changed, where the result is, and what to do next.\n\n## Provider\n- Recommended model: {provider}\n",
        provider = provider_label(provider),
        code_directory = code_directory,
    )
}

fn worker_control_content() -> String {
    "# Worker Control\n\nMethods available to the commander role:\n\n1. `send_message_to_session(session_id, message)`\n2. `get_session_response_status(session_id)`\n3. `read_session_messages_since_last_send(session_id)`\n"
        .to_string()
}

fn write_company_file(path: &Path, content: String, generated_files: &mut Vec<String>) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(path, content).map_err(|error| error.to_string())?;
    generated_files.push(path.to_string_lossy().to_string());
    Ok(())
}

fn find_company_pane(
    path: &Path,
    pane_role: &str,
    working_directory: &str,
) -> Result<Option<PaneSummary>, String> {
    let normalized_role = normalize_pane_role(pane_role);
    list_panes_db(path)
        .map_err(|error| error.to_string())
        .map(|items| {
            items.into_iter().find(|item| {
                normalize_pane_role(&item.pane_role) == normalized_role
                    && item.working_directory.as_deref() == Some(working_directory)
            })
        })
}

fn update_pane_summary_db(path: &Path, pane: &PaneSummary) -> Result<(), String> {
    let connection = open_db(path).map_err(|error| error.to_string())?;
    connection
        .execute(
            r#"
            UPDATE panes
            SET provider = ?2,
                title = ?3,
                pane_role = ?4,
                master_pane_id = ?5,
                working_directory = ?6,
                updated_at = ?7
            WHERE id = ?1
            "#,
            params![
                pane.id,
                pane.provider,
                pane.title,
                pane.pane_role,
                pane.master_pane_id,
                pane.working_directory,
                pane.updated_at
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn normalize_company_role_provider(config: &CompanyRolePaneConfig, fallback_provider: &str) -> String {
    let explicit = config.provider.trim().to_lowercase();
    if !explicit.is_empty() {
        return explicit;
    }
    let fallback = fallback_provider.trim().to_lowercase();
    if !fallback.is_empty() {
        return fallback;
    }
    "codex".to_string()
}

fn configure_company_pane_scan(
    state: &AppState,
    pane_id: &str,
    provider: &str,
    role_config: &CompanyRolePaneConfig,
) -> Result<(), String> {
    let mut parser_profile = role_config
        .session_parse_preset
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let mut file_glob = role_config
        .session_scan_glob
        .as_ref()
        .map(|value| normalize_scan_glob(value))
        .filter(|value| !value.trim().is_empty());

    if let Some(raw_parser_text) = role_config
        .session_parse_json
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        let fallback_profile = normalize_native_scan_profile(
            parser_profile.as_deref().unwrap_or(provider),
            provider,
        );
        let normalized = upsert_session_parser_profile_from_text(
            &state.session_parser_config_dir,
            &raw_parser_text,
            &fallback_profile,
        )
        .map_err(|error| error.to_string())?;
        parser_profile = Some(normalized.id.clone());
        if file_glob.is_none() {
            file_glob = Some(normalize_scan_glob(&normalized.default_file_glob));
        }
    }

    let parser_profile = parser_profile
        .map(|value| normalize_native_scan_profile(&value, provider))
        .unwrap_or_else(|| normalize_native_scan_profile(provider, provider));
    let file_glob = file_glob.unwrap_or_else(|| {
        resolve_session_parser_profile(&state.session_parser_config_dir, &parser_profile)
            .map(|config| normalize_scan_glob(&config.default_file_glob))
            .unwrap_or_default()
    });

    upsert_pane_scan_config_db(
        &state.db_path,
        pane_id,
        Some(parser_profile),
        Some(file_glob),
        provider,
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn ensure_company_pane(
    app: &AppHandle,
    state: &AppState,
    pane_role: &str,
    fallback_provider: &str,
    fallback_title: &str,
    working_directory: &str,
    master_pane_id: Option<String>,
    role_config: &CompanyRolePaneConfig,
) -> Result<PaneSummary, String> {
    let provider = normalize_company_role_provider(role_config, fallback_provider);
    let title = role_config
        .title
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| fallback_title.to_string());
    let now = now_epoch();

    let pane = if let Some(existing) = find_company_pane(&state.db_path, pane_role, working_directory)? {
        let updated = PaneSummary {
            id: existing.id,
            provider: provider.clone(),
            title,
            pane_role: normalize_pane_role(pane_role),
            master_pane_id,
            working_directory: Some(working_directory.to_string()),
            created_at: existing.created_at,
            updated_at: now,
        };
        update_pane_summary_db(&state.db_path, &updated)?;
        updated
    } else {
        let created = PaneSummary {
            id: Uuid::new_v4().to_string(),
            provider: provider.clone(),
            title,
            pane_role: normalize_pane_role(pane_role),
            master_pane_id,
            working_directory: Some(working_directory.to_string()),
            created_at: now,
            updated_at: now,
        };
        insert_pane(&state.db_path, &created).map_err(|error| error.to_string())?;
        created
    };

    configure_company_pane_scan(state, &pane.id, &provider, role_config)?;
    start_runtime(app, state, pane.id.clone(), pane.provider.clone()).map_err(|error| error.to_string())?;
    Ok(pane)
}

#[tauri::command]
pub(crate) fn bootstrap_single_person_company(
    app: AppHandle,
    state: State<AppState>,
    provider: Option<String>,
    commander_config: Option<CompanyRolePaneConfig>,
    worker_config: Option<CompanyRolePaneConfig>,
) -> Result<CompanyBootstrapResponse, String> {
    let config = state
        .app_config
        .lock()
        .map_err(|_| "failed to lock app config".to_string())?
        .clone();

    if !config.enable_single_person_company {
        return Err("single person company mode is disabled".to_string());
    }

    let code_directory = config
        .company_code_directory
        .clone()
        .ok_or_else(|| "company code directory is not configured".to_string())?;
    let agents_directory = resolve_agents_directory(
        config.company_code_directory.as_ref(),
        config.company_agents_directory.clone(),
    )
    .ok_or_else(|| "company runtime directory is not configured".to_string())?;
    let fallback_provider = provider
        .unwrap_or_else(|| "codex".to_string())
        .trim()
        .to_lowercase();
    if fallback_provider.is_empty() {
        return Err("provider is empty".to_string());
    }

    let commander_role_config = commander_config.unwrap_or_else(|| CompanyRolePaneConfig {
        provider: fallback_provider.clone(),
        title: Some(format!("{} Commander", provider_label(&fallback_provider))),
        ..CompanyRolePaneConfig::default()
    });
    let worker_role_config = worker_config.unwrap_or_else(|| CompanyRolePaneConfig {
        provider: fallback_provider.clone(),
        title: Some(format!("{} Worker", provider_label(&fallback_provider))),
        ..CompanyRolePaneConfig::default()
    });

    let commander_provider = normalize_company_role_provider(&commander_role_config, &fallback_provider);
    let worker_provider = normalize_company_role_provider(&worker_role_config, &fallback_provider);

    let commander_directory = PathBuf::from(&agents_directory).join("commander");
    let worker_directory = PathBuf::from(&agents_directory).join("worker");
    fs::create_dir_all(&commander_directory).map_err(|error| error.to_string())?;
    fs::create_dir_all(&worker_directory).map_err(|error| error.to_string())?;

    let commander_dir_text = commander_directory.to_string_lossy().to_string();
    let worker_dir_text = worker_directory.to_string_lossy().to_string();
    let generated_files = Vec::<String>::new();

    let commander = ensure_company_pane(
        &app,
        &state,
        "master",
        &commander_provider,
        &format!("{} Commander", provider_label(&commander_provider)),
        &commander_dir_text,
        None,
        &commander_role_config,
    )?;
    let worker = ensure_company_pane(
        &app,
        &state,
        "slave",
        &worker_provider,
        &format!("{} Worker", provider_label(&worker_provider)),
        &worker_dir_text,
        Some(commander.id.clone()),
        &worker_role_config,
    )?;

    Ok(CompanyBootstrapResponse {
        commander,
        worker,
        code_directory,
        commander_directory: commander_dir_text,
        worker_directory: worker_dir_text,
        generated_files,
    })
}
