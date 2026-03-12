import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Button, Card, Form, Input, Modal, Segmented, Select, Space, Tag, Typography, message } from "antd";

import CompanyModePage from "./CompanyModePage";

type Provider = string;
type CompanyRoleKey = "commander" | "worker";

type PaneSummary = {
  id: string;
  provider: string;
  title: string;
  pane_role: "standard" | "master" | "slave";
  master_pane_id?: string | null;
  working_directory?: string | null;
  created_at: number;
  updated_at: number;
};

type SessionParserProfileSummary = {
  id: string;
  name: string;
  default_file_glob: string;
  file_format: string;
};

type CompanyModeConfigResponse = {
  enable_single_person_company: boolean;
  code_directory: string | null;
  agents_directory: string | null;
};

type CompanyBootstrapResponse = {
  commander: PaneSummary;
  worker: PaneSummary;
  code_directory: string;
  commander_directory: string;
  worker_directory: string;
  generated_files: string[];
};

type PaneSessionState = {
  pane_id: string;
  active_session_id: string;
  linked_session_ids: string[];
  include_linked_in_sync: boolean;
  updated_at: number;
};

type SessionResponseStatus = {
  pane_id: string;
  pane_role: string;
  master_pane_id?: string | null;
  session_id: string;
  runtime_ready: boolean;
  last_input_at: number;
  last_output_at: number;
  idle_secs: number;
  responding: boolean;
  completed: boolean;
};

type NativeSessionPreviewRow = {
  id: string;
  kind: string;
  content: string;
  created_at: number;
  preview_truncated?: boolean;
};

type SessionResponseMessages = {
  pane_id: string;
  pane_role: string;
  master_pane_id?: string | null;
  session_id: string;
  since_at: number;
  last_input_at: number;
  last_output_at: number;
  idle_secs: number;
  responding: boolean;
  completed: boolean;
  rows: NativeSessionPreviewRow[];
  terminal_output: string;
};

type CompanyRoleDraft = {
  key: CompanyRoleKey;
  name: string;
  description: string;
  pane_role: "master" | "slave";
  provider_mode: "preset" | "custom";
  provider: string;
  custom_provider: string;
  title_mode: "auto" | "custom";
  custom_title: string;
  session_parse_preset: string;
  session_scan_glob: string;
  session_parse_json: string;
};

type CompanyRolePaneConfigPayload = {
  provider: string;
  title: string | null;
  sessionParsePreset: string | null;
  sessionScanGlob: string | null;
  sessionParseJson: string | null;
};

type CompanyModeHeaderAction = {
  label: string;
  loading: boolean;
  onClick: () => void;
};

type CompanyModeRouteProps = {
  providers: string[];
  sessionParserProfiles: SessionParserProfileSummary[];
  workingDirectory: string;
  onBootstrapComplete: (response: CompanyBootstrapResponse) => void;
  onHeaderActionChange: (action: CompanyModeHeaderAction | null) => void;
  onHeaderInitActionChange: (action: CompanyModeHeaderAction | null) => void;
  onProbePaneSessionId?: (paneId: string) => Promise<string>;
};

function asTitle(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  if (!normalized) {
    return "Unknown";
  }
  if (normalized === "codex") {
    return "Codex";
  }
  if (normalized === "claude") {
    return "Claude";
  }
  if (normalized === "gemini") {
    return "Gemini";
  }
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function normalizeSessionParsePreset(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "custom-model";
}

function normalizeSessionScanGlobInput(value: string): string {
  const tokens = value
    .split(/[\n,;]+/)
    .map((token) => token.trim().replace(/\\/g, "/"))
    .filter((token) => token.length > 0);
  return tokens.join("\n");
}

function defaultSessionScanGlobByPreset(
  preset: string,
  parserProfiles: SessionParserProfileSummary[] = []
): string {
  const normalizedPreset = normalizeSessionParsePreset(preset);
  const matched = parserProfiles.find(
    (profile) => normalizeSessionParsePreset(profile.id) === normalizedPreset
  );
  if (matched?.default_file_glob?.trim()) {
    return matched.default_file_glob.trim();
  }
  if (normalizedPreset === "codex") {
    return "**/rollout-*.jsonl";
  }
  if (normalizedPreset === "claude") {
    return "**/*.jsonl";
  }
  if (normalizedPreset === "gemini") {
    return "**/session-*.json";
  }
  return "**/*.jsonl";
}

function normalizeCompanyDirectory(value: string): string {
  let normalized = value.trim().split("\\").join("/");
  while (normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function joinCompanyDirectory(base: string, ...segments: string[]): string {
  const normalizedBase = normalizeCompanyDirectory(base);
  if (!normalizedBase) {
    return "";
  }
  return [normalizedBase, ...segments.map((item) => item.trim()).filter(Boolean)].join("/");
}

function deriveCompanyRuntimeDirectory(projectDirectory: string): string {
  const normalizedProject = normalizeCompanyDirectory(projectDirectory);
  if (!normalizedProject) {
    return "";
  }
  return joinCompanyDirectory(normalizedProject, ".ai-company");
}

function createCompanyRoleDraft(
  key: CompanyRoleKey,
  provider = "codex",
  parserProfiles: SessionParserProfileSummary[] = []
): CompanyRoleDraft {
  const normalizedProvider = provider.trim().toLowerCase() || "codex";
  return {
    key,
    name: key === "commander" ? "\u6307\u6325" : "\u5de5\u4f5c",
    description:
      key === "commander"
        ? "\u8d1f\u8d23\u548c\u7528\u6237\u5bf9\u8bdd\u3001\u62c6\u89e3\u4efb\u52a1\u3001\u8c03\u5ea6\u5de5\u4f5c\u89d2\u8272\u3001\u5ba1\u6838\u7ed3\u679c\u3002"
        : "\u8d1f\u8d23\u6267\u884c\u5177\u4f53\u7f16\u7801\u3001\u547d\u4ee4\u3001\u68c0\u67e5\u548c\u4ea7\u51fa\u56de\u4f20\u3002",
    pane_role: key === "commander" ? "master" : "slave",
    provider_mode: "preset",
    provider: normalizedProvider,
    custom_provider: "",
    title_mode: "auto",
    custom_title: "",
    session_parse_preset: normalizeSessionParsePreset(normalizedProvider),
    session_scan_glob: normalizeSessionScanGlobInput(
      defaultSessionScanGlobByPreset(normalizedProvider, parserProfiles)
    ),
    session_parse_json: ""
  };
}

function resolveCompanyRoleProvider(role: CompanyRoleDraft): string {
  return role.provider_mode === "custom"
    ? role.custom_provider.trim().toLowerCase()
    : role.provider.trim().toLowerCase();
}

function buildCompanyRoleTitle(role: CompanyRoleDraft): string {
  const provider = resolveCompanyRoleProvider(role) || "terminal";
  const suffix = role.key === "commander" ? "\u6307\u6325" : "\u5de5\u4f5c";
  if (role.title_mode === "custom") {
    return role.custom_title.trim() || `${asTitle(provider)} ${suffix}`;
  }
  return `${asTitle(provider)} ${suffix}`;
}

function buildCompanyRolePayload(role: CompanyRoleDraft): CompanyRolePaneConfigPayload {
  const provider = resolveCompanyRoleProvider(role) || "codex";
  return {
    provider,
    title: buildCompanyRoleTitle(role) || null,
    sessionParsePreset: normalizeSessionParsePreset(role.session_parse_preset.trim() || provider) || null,
    sessionScanGlob: role.session_scan_glob.trim() || null,
    sessionParseJson: role.session_parse_json.trim() || null
  };
}

function shortSessionId(value: string): string {
  const text = value.trim();
  if (!text) {
    return "-";
  }
  if (text.length <= 16) {
    return text;
  }
  return `${text.slice(0, 8)}...${text.slice(-4)}`;
}

function buildWorkerResultPreview(result: SessionResponseMessages | null): string {
  if (!result) {
    return "";
  }
  const terminal = (result.terminal_output || "").trim();
  if (terminal) {
    return terminal;
  }
  return result.rows
    .map((row) => `${row.kind === "input" ? "控制" : "工作"}: ${row.content}`)
    .join("\n\n")
    .trim();
}

export default function CompanyModeRoute(props: CompanyModeRouteProps) {
  const {
    providers,
    sessionParserProfiles,
    workingDirectory,
    onBootstrapComplete,
    onHeaderActionChange,
    onHeaderInitActionChange,
    onProbePaneSessionId
  } = props;

  const [messageApi, contextHolder] = message.useMessage();
  const [enabled, setEnabled] = useState(false);
  const [codeDirectory, setCodeDirectory] = useState("");
  const [agentsDirectory, setAgentsDirectory] = useState("");
  const [roleDrafts, setRoleDrafts] = useState<Record<CompanyRoleKey, CompanyRoleDraft>>(() => ({
    commander: createCompanyRoleDraft("commander", providers[0] || "codex", sessionParserProfiles),
    worker: createCompanyRoleDraft("worker", providers[0] || "codex", sessionParserProfiles)
  }));
  const [builderOpen, setBuilderOpen] = useState(false);
  const [advancedRoleKey, setAdvancedRoleKey] = useState<CompanyRoleKey | null>(null);
  const [bootstrapping, setBootstrapping] = useState(false);
  const [generatedFiles, setGeneratedFiles] = useState<string[]>([]);
  const [initOpen, setInitOpen] = useState(false);
  const [initMessage, setInitMessage] = useState("");
  const [initializingRoles, setInitializingRoles] = useState(false);
  const [bindingLoading, setBindingLoading] = useState(false);
  const [commanderPane, setCommanderPane] = useState<PaneSummary | null>(null);
  const [workerPane, setWorkerPane] = useState<PaneSummary | null>(null);
  const [commanderSessionId, setCommanderSessionId] = useState("");
  const [workerSessionId, setWorkerSessionId] = useState("");
  const [dispatchMessage, setDispatchMessage] = useState("");
  const [sendingToWorker, setSendingToWorker] = useState(false);
  const [statusLoading, setStatusLoading] = useState(false);
  const [resultLoading, setResultLoading] = useState(false);
  const [workerStatus, setWorkerStatus] = useState<SessionResponseStatus | null>(null);
  const [workerResult, setWorkerResult] = useState<SessionResponseMessages | null>(null);
  const [autoPollingWorker, setAutoPollingWorker] = useState(false);
  const workerPrimedRef = useRef(false);

  const providerRuleFileName = useCallback((provider: string) => {
    const normalized = provider.trim().toLowerCase();
    if (normalized === "claude") {
      return "CLAUDE.md";
    }
    if (normalized === "gemini") {
      return "GEMINI.md";
    }
    if (normalized === "codex") {
      return "CODEX.md";
    }
    return `${normalized.toUpperCase() || "AGENT"}.md`;
  }, []);

  const buildRoleInitPrompt = useCallback(
    (
      roleKey: CompanyRoleKey,
      role: CompanyRoleDraft,
      sessionId: string,
      targetSessionId: string
    ) => {
      const ruleFileName = providerRuleFileName(resolveCompanyRoleProvider(role) || role.provider);
      const roleName = roleKey === "commander" ? "控制角色" : "工作角色";
      const capabilityBlock =
        roleKey === "commander"
          ? [
              `当前角色会话ID: ${sessionId || "待刷新"}`,
              `允许操作的目标会话ID: ${targetSessionId || "待工作角色初始化后刷新"}`,
              "允许调用的方法:",
              "1. send_message(session_id, message)",
              "2. refresh_sid(session_id)",
              "3. read_status(session_id)",
              "4. read_messages(session_id)"
            ].join("\n")
          : [
              `当前角色会话ID: ${sessionId || "待刷新"}`,
              "你不允许操作控制角色会话。",
              "仅负责接收任务、执行任务、回传结果。"
            ].join("\n");

      return [
        `你当前是${roleName}。`,
        `请在当前工作目录生成当前模型对应的规则文件 ${ruleFileName}。`,
        "规则文件中必须写入：",
        "- 当前角色定位",
        "- 当前工作目录约束",
        "- 当前可操作会话列表",
        "- 当前支持的后端调用方法与参数格式",
        capabilityBlock,
        "用户初始化需求如下：",
        initMessage.trim() || "请基于当前角色生成通用规则文件。",
        "完成后请在终端里简短说明已生成的文件名。"
      ].join("\n\n");
    },
    [initMessage, providerRuleFileName]
  );

  useEffect(() => {
    let disposed = false;
    const loadConfig = async () => {
      try {
        const response = await invoke<CompanyModeConfigResponse>("get_company_mode_config");
        if (disposed) {
          return;
        }
        const nextCodeDirectory = normalizeCompanyDirectory((response.code_directory || "").trim());
        setEnabled(true);
        setCodeDirectory(nextCodeDirectory);
        const nextAgentsDirectory = normalizeCompanyDirectory(
          (response.agents_directory || deriveCompanyRuntimeDirectory(nextCodeDirectory)).trim()
        );
        setAgentsDirectory(nextAgentsDirectory);
        if (!response.enable_single_person_company) {
          void invoke<CompanyModeConfigResponse>("set_company_mode_config", {
            enableSinglePersonCompany: true,
            codeDirectory: nextCodeDirectory || "",
            agentsDirectory: nextAgentsDirectory || ""
          }).catch((error) => console.error(error));
        }
      } catch (error) {
        console.error(error);
      }
    };
    void loadConfig();
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    const defaultProvider = providers[0] || "codex";
    setRoleDrafts((current) => ({
      commander:
        current.commander && resolveCompanyRoleProvider(current.commander)
          ? current.commander
          : createCompanyRoleDraft("commander", defaultProvider, sessionParserProfiles),
      worker:
        current.worker && resolveCompanyRoleProvider(current.worker)
          ? current.worker
          : createCompanyRoleDraft("worker", defaultProvider, sessionParserProfiles)
    }));
  }, [providers, sessionParserProfiles]);

  const runtimeDirectory = useMemo(() => {
    const explicit = normalizeCompanyDirectory(agentsDirectory);
    return explicit || deriveCompanyRuntimeDirectory(codeDirectory);
  }, [agentsDirectory, codeDirectory]);

  const commanderDirectory = useMemo(
    () => (runtimeDirectory ? joinCompanyDirectory(runtimeDirectory, "commander") : ""),
    [runtimeDirectory]
  );
  const workerDirectory = useMemo(
    () => (runtimeDirectory ? joinCompanyDirectory(runtimeDirectory, "worker") : ""),
    [runtimeDirectory]
  );

  const ensurePaneSessionId = useCallback(async (paneId: string): Promise<string> => {
    const current = await invoke<PaneSessionState>("get_pane_session_state", { paneId });
    const currentSid = (current.active_session_id || "").trim();
    if (currentSid) {
      return currentSid;
    }
    const suggested = onProbePaneSessionId ? await onProbePaneSessionId(paneId).catch(() => "") : "";
    const nextSid = (suggested || "").trim();
    if (!nextSid) {
      return "";
    }
    const updated = await invoke<PaneSessionState>("set_pane_session_state", {
      paneId,
      activeSessionId: nextSid,
      linkedSessionIds: Array.isArray(current.linked_session_ids) ? current.linked_session_ids : [],
      includeLinkedInSync: false
    });
    return (updated.active_session_id || "").trim();
  }, [onProbePaneSessionId]);

  const waitForPaneSessionId = useCallback(
    async (paneId: string, attempts = 12, delayMs = 2000): Promise<string> => {
      for (let index = 0; index < attempts; index += 1) {
        const sid = await ensurePaneSessionId(paneId);
        if (sid.trim()) {
          return sid.trim();
        }
        await new Promise((resolve) => window.setTimeout(resolve, delayMs));
      }
      return "";
    },
    [ensurePaneSessionId]
  );

  const refreshCompanyBindings = useCallback(async () => {
    if (!commanderDirectory && !workerDirectory) {
      setCommanderPane(null);
      setWorkerPane(null);
      setCommanderSessionId("");
      setWorkerSessionId("");
      return;
    }
    setBindingLoading(true);
    try {
      const paneList = await invoke<PaneSummary[]>("list_panes");
      const nextCommanderPane =
        paneList.find(
          (item) =>
            item.pane_role === "master" &&
            (item.working_directory || "").trim() === commanderDirectory.trim()
        ) || null;
      const nextWorkerPane =
        paneList.find(
          (item) =>
            item.pane_role === "slave" &&
            (item.working_directory || "").trim() === workerDirectory.trim()
        ) || null;

      setCommanderPane(nextCommanderPane);
      setWorkerPane(nextWorkerPane);

      const [nextCommanderSid, nextWorkerSid] = await Promise.all([
        nextCommanderPane ? ensurePaneSessionId(nextCommanderPane.id) : Promise.resolve(""),
        nextWorkerPane ? ensurePaneSessionId(nextWorkerPane.id) : Promise.resolve(""),
      ]);

      setCommanderSessionId(nextCommanderSid);
      setWorkerSessionId(nextWorkerSid);
    } catch (error) {
      console.error(error);
      messageApi.error("加载控制/工作角色绑定失败");
    } finally {
      setBindingLoading(false);
    }
  }, [commanderDirectory, ensurePaneSessionId, messageApi, workerDirectory]);

  const autoEstablishCompanySessions = useCallback(async () => {
    let nextCommanderSid = commanderSessionId.trim();
    if (commanderPane && !nextCommanderSid) {
      nextCommanderSid = await ensurePaneSessionId(commanderPane.id);
      if (nextCommanderSid) {
        setCommanderSessionId(nextCommanderSid);
      }
    }

    if (!workerPane || !nextCommanderSid) {
      return;
    }

    let nextWorkerSid = workerSessionId.trim();
    if (!nextWorkerSid && !workerPrimedRef.current) {
      try {
        await invoke<void>("send_to_pane", { paneId: workerPane.id, input: "你好" });
        workerPrimedRef.current = true;
      } catch (error) {
        console.error(error);
      }
    }

    if (!nextWorkerSid) {
      nextWorkerSid = await ensurePaneSessionId(workerPane.id);
      if (nextWorkerSid) {
        setWorkerSessionId(nextWorkerSid);
      }
    }
  }, [commanderPane, commanderSessionId, ensurePaneSessionId, workerPane, workerSessionId]);

  const updateProjectDirectory = useCallback((value: string) => {
    const normalized = normalizeCompanyDirectory(value);
    setCodeDirectory(normalized);
    setAgentsDirectory(deriveCompanyRuntimeDirectory(normalized));
  }, []);

  const updateRoleDraft = useCallback(
    (roleKey: CompanyRoleKey, updater: (current: CompanyRoleDraft) => CompanyRoleDraft) => {
      setRoleDrafts((current) => ({
        ...current,
        [roleKey]: updater(current[roleKey])
      }));
    },
    []
  );

  const pickProjectDirectory = useCallback(async () => {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        defaultPath: codeDirectory.trim() || workingDirectory.trim() || undefined,
        title: "\u9009\u62e9\u9879\u76ee\u76ee\u5f55"
      });
      if (typeof selected === "string") {
        updateProjectDirectory(selected.trim());
      }
    } catch (error) {
      console.error(error);
      messageApi.error("\u6253\u5f00\u9879\u76ee\u76ee\u5f55\u9009\u62e9\u5668\u5931\u8d25");
    }
  }, [codeDirectory, messageApi, updateProjectDirectory, workingDirectory]);

  const handleRoleProviderChange = useCallback(
    (roleKey: CompanyRoleKey, value: string) => {
      const normalizedProvider = String(value || "codex").trim().toLowerCase() || "codex";
      updateRoleDraft(roleKey, (current) => ({
        ...current,
        provider_mode: "preset",
        provider: normalizedProvider,
        session_parse_preset: normalizeSessionParsePreset(normalizedProvider),
        session_scan_glob: normalizeSessionScanGlobInput(
          defaultSessionScanGlobByPreset(normalizedProvider, sessionParserProfiles)
        )
      }));
    },
    [sessionParserProfiles, updateRoleDraft]
  );

  const refreshWorkerStatus = useCallback(async () => {
    if (!workerSessionId.trim()) {
      setWorkerStatus(null);
      return;
    }
    setStatusLoading(true);
    try {
      const response = await invoke<SessionResponseStatus>("get_session_response_status", {
        sessionId: workerSessionId.trim()
      });
      setWorkerStatus(response);
      if (response.completed) {
        setAutoPollingWorker(false);
      }
    } catch (error) {
      console.error(error);
      messageApi.error("读取工作角色状态失败");
      setAutoPollingWorker(false);
    } finally {
      setStatusLoading(false);
    }
  }, [messageApi, workerSessionId]);

  const loadWorkerResult = useCallback(async () => {
    if (!workerSessionId.trim()) {
      setWorkerResult(null);
      return;
    }
    setResultLoading(true);
    try {
      const response = await invoke<SessionResponseMessages>("read_session_messages_since_last_send", {
        sessionId: workerSessionId.trim()
      });
      setWorkerResult(response);
    } catch (error) {
      console.error(error);
      messageApi.error("读取工作角色结果失败");
    } finally {
      setResultLoading(false);
    }
  }, [messageApi, workerSessionId]);

  const sendMessageToWorker = useCallback(async () => {
    const messageText = dispatchMessage.trim();
    if (!messageText) {
      messageApi.warning("请输入要派发给工作角色的内容");
      return;
    }
    const targetSessionId = workerSessionId.trim();
    if (!targetSessionId) {
      await refreshCompanyBindings();
    }
    const nextTargetSessionId = workerSessionId.trim() || targetSessionId;
    if (!nextTargetSessionId) {
      messageApi.warning("工作角色当前还没有可用会话，请稍后再试");
      return;
    }
    setSendingToWorker(true);
    try {
      await invoke("send_message_to_session", {
        sessionId: nextTargetSessionId,
        message: messageText,
        submit: true
      });
      setDispatchMessage("");
      setWorkerResult(null);
      setAutoPollingWorker(true);
      await refreshWorkerStatus();
      messageApi.success("已派发给工作角色");
    } catch (error) {
      console.error(error);
      messageApi.error("向工作角色发送失败");
      setAutoPollingWorker(false);
    } finally {
      setSendingToWorker(false);
    }
  }, [dispatchMessage, messageApi, refreshCompanyBindings, refreshWorkerStatus, workerSessionId]);

  const initializeCompanyRoles = useCallback(async () => {
    if (!commanderPane || !workerPane) {
      messageApi.warning("请先新建组织架构");
      return;
    }
    setInitializingRoles(true);
    try {
      const commanderPrompt = buildRoleInitPrompt(
        "commander",
        roleDrafts.commander,
        commanderSessionId,
        workerSessionId
      );
      await invoke<void>("send_to_pane", { paneId: commanderPane.id, input: commanderPrompt });
      const nextCommanderSid = await waitForPaneSessionId(commanderPane.id);
      if (nextCommanderSid) {
        setCommanderSessionId(nextCommanderSid);
      }

      const workerPrompt = buildRoleInitPrompt(
        "worker",
        roleDrafts.worker,
        workerSessionId,
        nextCommanderSid
      );
      await invoke<void>("send_to_pane", { paneId: workerPane.id, input: workerPrompt });
      const nextWorkerSid = await waitForPaneSessionId(workerPane.id);
      if (nextWorkerSid) {
        setWorkerSessionId(nextWorkerSid);
      }

      await refreshCompanyBindings();
      messageApi.success("已完成控制/工作角色初始化");
      setInitOpen(false);
    } catch (error) {
      console.error(error);
      messageApi.error("初始化角色规则失败");
    } finally {
      setInitializingRoles(false);
    }
  }, [
    buildRoleInitPrompt,
    commanderPane,
    commanderSessionId,
    messageApi,
    refreshCompanyBindings,
    roleDrafts.commander,
    roleDrafts.worker,
    waitForPaneSessionId,
    workerPane,
    workerSessionId
  ]);

  const bootstrap = useCallback(async () => {
    if (bootstrapping) {
      return;
    }
    if (!codeDirectory.trim()) {
      messageApi.warning("\u8bf7\u5148\u9009\u62e9\u9879\u76ee\u76ee\u5f55");
      return;
    }
    setBootstrapping(true);
    try {
      await invoke<CompanyModeConfigResponse>("set_company_mode_config", {
        enableSinglePersonCompany: true,
        codeDirectory: codeDirectory.trim(),
        agentsDirectory: runtimeDirectory || ""
      });
      const response = await invoke<CompanyBootstrapResponse>("bootstrap_single_person_company", {
        commanderConfig: buildCompanyRolePayload(roleDrafts.commander),
        workerConfig: buildCompanyRolePayload(roleDrafts.worker)
      });
      setGeneratedFiles(response.generated_files || []);
      onBootstrapComplete(response);
      setBuilderOpen(false);
      await refreshCompanyBindings();
      messageApi.success("\u5df2\u521d\u59cb\u5316\u6307\u6325 / \u5de5\u4f5c\u53cc\u89d2\u8272\u7ec8\u7aef");
    } catch (error) {
      console.error(error);
      messageApi.error("\u521d\u59cb\u5316\u516c\u53f8\u6a21\u5f0f\u5931\u8d25");
    } finally {
      setBootstrapping(false);
    }
  }, [bootstrapping, codeDirectory, messageApi, onBootstrapComplete, refreshCompanyBindings, roleDrafts, runtimeDirectory]);

  const roleItems = useMemo(
    () =>
      ([roleDrafts.commander, roleDrafts.worker] as CompanyRoleDraft[]).map((role) => ({
        key: role.key,
        name: role.name,
        description: role.description,
        terminalType: asTitle(resolveCompanyRoleProvider(role) || "terminal"),
        titlePreview: buildCompanyRoleTitle(role),
        workDirectory: role.key === "commander" ? commanderDirectory : workerDirectory,
        providerMode: role.provider_mode,
        providerValue:
          role.provider_mode === "custom"
            ? resolveCompanyRoleProvider(role) || role.custom_provider.trim() || role.provider
            : role.provider
      })),
    [commanderDirectory, roleDrafts, workerDirectory]
  );

  const activeRoleDraft = advancedRoleKey ? roleDrafts[advancedRoleKey] : null;

  useEffect(() => {
    void refreshCompanyBindings();
  }, [refreshCompanyBindings]);

  useEffect(() => {
    if (!commanderPane && !workerPane) {
      return;
    }
    if (commanderSessionId.trim() && workerSessionId.trim()) {
      return;
    }
    void autoEstablishCompanySessions();
    const timer = window.setInterval(() => {
      void autoEstablishCompanySessions();
    }, 2500);
    return () => window.clearInterval(timer);
  }, [autoEstablishCompanySessions, commanderPane, commanderSessionId, workerPane, workerSessionId]);

  useEffect(() => {
    if (!autoPollingWorker || !workerSessionId.trim()) {
      return;
    }
    const timer = window.setInterval(() => {
      void refreshWorkerStatus().then(() => {
        if (workerStatus?.completed) {
          void loadWorkerResult();
        }
      });
    }, 2000);
    return () => window.clearInterval(timer);
  }, [autoPollingWorker, loadWorkerResult, refreshWorkerStatus, workerSessionId, workerStatus?.completed]);

  const workerResultPreview = useMemo(() => buildWorkerResultPreview(workerResult), [workerResult]);

  useEffect(() => {
    onHeaderActionChange({
      label: "\u65b0\u5efa\u7ec4\u7ec7\u67b6\u6784",
      loading: false,
      onClick: () => {
        setBuilderOpen(true);
      }
    });
    return () => onHeaderActionChange(null);
  }, [onHeaderActionChange]);

  useEffect(() => {
    onHeaderInitActionChange({
      label: "初始化",
      loading: initializingRoles,
      onClick: () => setInitOpen(true)
    });
    return () => onHeaderInitActionChange(null);
  }, [initializingRoles, onHeaderInitActionChange]);

  return (
    <>
      {contextHolder}

      <div
        style={{
          position: "fixed",
          top: 76,
          right: 16,
          width: 360,
          zIndex: 22,
          maxHeight: "calc(100vh - 96px)",
          overflow: "auto"
        }}
      >
        <Card
          size="small"
          title="控制 / 工作"
          extra={
            <Button size="small" loading={bindingLoading} onClick={() => void refreshCompanyBindings()}>
              刷新绑定
            </Button>
          }
        >
          <Space direction="vertical" size={10} style={{ width: "100%" }}>
            <Space direction="vertical" size={2} style={{ width: "100%" }}>
              <Typography.Text strong>控制角色</Typography.Text>
              <Typography.Text type="secondary">终端：{commanderPane?.title || "-"}</Typography.Text>
              <Typography.Text type="secondary">SID：{shortSessionId(commanderSessionId)}</Typography.Text>
            </Space>
            <Space direction="vertical" size={2} style={{ width: "100%" }}>
              <Typography.Text strong>工作角色</Typography.Text>
              <Typography.Text type="secondary">终端：{workerPane?.title || "-"}</Typography.Text>
              <Typography.Text type="secondary">SID：{shortSessionId(workerSessionId)}</Typography.Text>
              <Space size={6} wrap>
                <Tag color={workerStatus?.responding ? "processing" : workerStatus?.completed ? "success" : "default"}>
                  {workerStatus?.responding ? "执行中" : workerStatus?.completed ? "已结束" : "待命"}
                </Tag>
                <Tag>空闲 {workerStatus?.idle_secs ?? 0}s</Tag>
              </Space>
            </Space>

            <Input.TextArea
              value={dispatchMessage}
              onChange={(event) => setDispatchMessage(event.target.value)}
              placeholder="输入要派发给工作角色的任务"
              autoSize={{ minRows: 4, maxRows: 8 }}
            />
            <Space wrap>
              <Button type="primary" loading={sendingToWorker} onClick={() => void sendMessageToWorker()}>
                发消息给工作
              </Button>
              <Button loading={statusLoading} onClick={() => void refreshWorkerStatus()}>
                查看结束
              </Button>
              <Button loading={resultLoading} onClick={() => void loadWorkerResult()}>
                读取结果
              </Button>
            </Space>
            <Typography.Text type="secondary">
              控制角色负责派发，工作角色负责执行；公司模式下不再显示手工同步按钮。
            </Typography.Text>
            <Input.TextArea
              readOnly
              value={workerResultPreview}
              placeholder="工作角色的最新输出会显示在这里"
              autoSize={{ minRows: 8, maxRows: 16 }}
            />
          </Space>
        </Card>
      </div>

      <Modal
        open={builderOpen}
        title="新建组织架构"
        width={1080}
        onCancel={() => setBuilderOpen(false)}
        footer={
          <>
            <Button onClick={() => setBuilderOpen(false)}>关闭</Button>
            <Button type="primary" onClick={() => void bootstrap()} loading={bootstrapping}>
              新建组织架构
            </Button>
          </>
        }
      >
        <CompanyModePage
          projectDirectory={codeDirectory}
          codeDirectory={codeDirectory}
          runtimeDirectory={runtimeDirectory}
          commanderDirectory={commanderDirectory}
          workerDirectory={workerDirectory}
          providers={providers}
          bootstrapping={bootstrapping}
          generatedFiles={generatedFiles}
          roleItems={roleItems}
          onProjectDirectoryChange={updateProjectDirectory}
          onRoleProviderChange={handleRoleProviderChange}
          onOpenRoleAdvanced={setAdvancedRoleKey}
          onPickProjectDirectory={() => void pickProjectDirectory()}
        />
      </Modal>

      <Modal
        open={initOpen}
        title="初始化组织架构"
        width={820}
        onCancel={() => setInitOpen(false)}
        footer={
          <>
            <Button onClick={() => setInitOpen(false)}>关闭</Button>
            <Button type="primary" loading={initializingRoles} onClick={() => void initializeCompanyRoles()}>
              开始初始化
            </Button>
          </>
        }
      >
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <Typography.Text type="secondary">
            会按顺序初始化控制角色、工作角色。每个角色初始化后，系统会自动轮询并绑定当前 SID。
          </Typography.Text>
          <Typography.Text type="secondary">
            控制角色只允许操作工作角色；工作角色不允许反向操作控制角色。
          </Typography.Text>
          <Input.TextArea
            value={initMessage}
            onChange={(event) => setInitMessage(event.target.value)}
            placeholder="输入初始化需求，例如：生成当前 provider 的规则文件，写明角色职责、会话能力、调用协议和目录约束。"
            autoSize={{ minRows: 8, maxRows: 16 }}
          />
          <Space direction="vertical" size={4}>
            <Typography.Text type="secondary">控制角色 SID：{shortSessionId(commanderSessionId)}</Typography.Text>
            <Typography.Text type="secondary">工作角色 SID：{shortSessionId(workerSessionId)}</Typography.Text>
          </Space>
        </Space>
      </Modal>

      <Modal
        open={Boolean(activeRoleDraft)}
        title={activeRoleDraft ? `${activeRoleDraft.name} 高级选项` : "角色高级选项"}
        onCancel={() => setAdvancedRoleKey(null)}
        footer={<Button onClick={() => setAdvancedRoleKey(null)}>关闭</Button>}
      >
        {activeRoleDraft ? (
          <Form layout="vertical">
            <Form.Item label="Provider 来源">
              <Segmented
                value={activeRoleDraft.provider_mode}
                options={[
                  { value: "preset", label: "预设" },
                  { value: "custom", label: "自定义" }
                ]}
                onChange={(value) => {
                  const nextMode = value === "custom" ? "custom" : "preset";
                  updateRoleDraft(activeRoleDraft.key, (current) => {
                    if (nextMode === "custom") {
                      const fallbackProvider = current.custom_provider.trim() || current.provider.trim() || "custom-model";
                      return {
                        ...current,
                        provider_mode: "custom",
                        custom_provider: fallbackProvider,
                        session_parse_preset: normalizeSessionParsePreset(fallbackProvider)
                      };
                    }
                    const fallbackProvider = current.provider.trim() || providers[0] || "codex";
                    return {
                      ...current,
                      provider_mode: "preset",
                      provider: fallbackProvider,
                      session_parse_preset: normalizeSessionParsePreset(fallbackProvider),
                      session_scan_glob: normalizeSessionScanGlobInput(
                        defaultSessionScanGlobByPreset(fallbackProvider, sessionParserProfiles)
                      )
                    };
                  });
                }}
              />
            </Form.Item>

            {activeRoleDraft.provider_mode === "preset" ? (
              <Form.Item label="终端类型">
                <Select
                  value={activeRoleDraft.provider}
                  options={providers.map((item) => ({ value: item, label: asTitle(item) }))}
                  onChange={(value) =>
                    updateRoleDraft(activeRoleDraft.key, (current) => {
                      const provider = String(value || current.provider || providers[0] || "codex").trim().toLowerCase();
                      return {
                        ...current,
                        provider,
                        session_parse_preset: normalizeSessionParsePreset(provider),
                        session_scan_glob: normalizeSessionScanGlobInput(
                          defaultSessionScanGlobByPreset(provider, sessionParserProfiles)
                        )
                      };
                    })
                  }
                />
              </Form.Item>
            ) : (
              <Form.Item label="自定义 Provider">
                <Input
                  value={activeRoleDraft.custom_provider}
                  onChange={(event) =>
                    updateRoleDraft(activeRoleDraft.key, (current) => ({
                      ...current,
                      custom_provider: event.target.value,
                      session_parse_preset: normalizeSessionParsePreset(
                        event.target.value.trim() || "custom-model"
                      )
                    }))
                  }
                  placeholder="例如: qwen / kimi / deepseek"
                />
              </Form.Item>
            )}

            <Form.Item label="标题模式">
              <Segmented
                value={activeRoleDraft.title_mode}
                options={[
                  { value: "auto", label: "自动" },
                  { value: "custom", label: "自定义" }
                ]}
                onChange={(value) =>
                  updateRoleDraft(activeRoleDraft.key, (current) => ({
                    ...current,
                    title_mode: value === "custom" ? "custom" : "auto"
                  }))
                }
              />
            </Form.Item>
            <Form.Item label="标题预览">
              <Typography.Text>{buildCompanyRoleTitle(activeRoleDraft)}</Typography.Text>
            </Form.Item>
            {activeRoleDraft.title_mode === "custom" ? (
              <Form.Item label="自定义标题">
                <Input
                  value={activeRoleDraft.custom_title}
                  onChange={(event) =>
                    updateRoleDraft(activeRoleDraft.key, (current) => ({
                      ...current,
                      custom_title: event.target.value
                    }))
                  }
                  placeholder="输入终端标题"
                />
              </Form.Item>
            ) : null}
            <Form.Item label="扫描会话通配符" extra="默认会按终端类型自动填充，可按角色单独覆盖。">
              <Input.TextArea
                value={activeRoleDraft.session_scan_glob}
                onChange={(event) =>
                  updateRoleDraft(activeRoleDraft.key, (current) => ({
                    ...current,
                    session_scan_glob: normalizeSessionScanGlobInput(event.target.value)
                  }))
                }
                autoSize={{ minRows: 2, maxRows: 4 }}
              />
            </Form.Item>
            <Form.Item label="解析配置 ID">
              <Input
                value={activeRoleDraft.session_parse_preset}
                onChange={(event) =>
                  updateRoleDraft(activeRoleDraft.key, (current) => ({
                    ...current,
                    session_parse_preset: normalizeSessionParsePreset(event.target.value)
                  }))
                }
                placeholder="例如: codex / claude / custom-model"
              />
            </Form.Item>
            <Form.Item label="解析配置 JSON" extra="留空时使用终端类型对应的默认解析配置。">
              <Input.TextArea
                value={activeRoleDraft.session_parse_json}
                onChange={(event) =>
                  updateRoleDraft(activeRoleDraft.key, (current) => ({
                    ...current,
                    session_parse_json: event.target.value
                  }))
                }
                autoSize={{ minRows: 8, maxRows: 16 }}
                placeholder="可粘贴完整的 parser JSON；留空则沿用默认模板。"
              />
            </Form.Item>
            <Form.Item label="工作目录">
              <Typography.Text type="secondary">
                {activeRoleDraft.key === "commander" ? commanderDirectory || "-" : workerDirectory || "-"}
              </Typography.Text>
            </Form.Item>
          </Form>
        ) : null}
      </Modal>
    </>
  );
}
