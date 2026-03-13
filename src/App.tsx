import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { WebviewWindow, getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { LogicalSize, PhysicalPosition, getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Terminal } from "xterm";
import type { IDisposable } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import {
  Avatar,
  Button,
  Card,
  ColorPicker,
  Collapse,
  ConfigProvider,
  Drawer,
  Form,
  Input,
  InputNumber,
  Layout,
  Modal,
  Progress,
  Segmented,
  Select,
  Space,
  Spin,
  Switch,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  message,
  theme as antdTheme
} from "antd";
import {
  CloseOutlined,
  CopyOutlined,
  CompressOutlined,
  FolderOpenOutlined,
  PlusOutlined,
  PushpinOutlined,
  SearchOutlined,
  SendOutlined,
  SettingOutlined,
  SyncOutlined
} from "@ant-design/icons";
import "xterm/css/xterm.css";
import SyncEntryPreviewList, {
  type SyncEntryPreviewFullContentResult,
  type SyncEntryPreviewItem,
  type SyncEntryPreviewScrollCommand
} from "./components/SyncEntryPreviewList";
import SessionCandidateCard from "./components/SessionCandidateCard";
import SessionCandidateVirtualList from "./components/SessionCandidateVirtualList";
import JsonPathTree, { type JsonPathToken } from "./components/JsonPathTree";
import AiTeamMcpPage, { type AiTeamWorkbenchHeaderActions } from "./pages/AiTeamMcpPage";
import CollabWorkbenchPage from "./pages/CollabWorkbenchPage";
import FavoriteMessagesPage from "./pages/FavoriteMessagesPage";
import defaultAssistantAvatar from "../ai.jpg";
import defaultUserAvatar from "../man.jpg";

type Provider = string;
type LayoutMode = "vertical" | "horizontal";
type UiColorMode = "dark" | "light" | "system";
type AppRoute = "workspace" | "team" | "ai-team" | "collab" | "favorites" | "session-preview";
type StandaloneSessionPreviewTargetPayload = {
  paneId: string;
};

const STANDALONE_SESSION_PREVIEW_WINDOW_LABEL = "session-preview";
const STANDALONE_SESSION_PREVIEW_SET_PANE_EVENT = "session-preview:set-pane";
const STANDALONE_SESSION_PREVIEW_ALWAYS_ON_TOP_STORAGE_KEY =
  "ai-shell.session-preview.always-on-top";
const STANDALONE_SESSION_PREVIEW_DEFAULT_WIDTH = 1180;
const STANDALONE_SESSION_PREVIEW_DEFAULT_HEIGHT = 820;
const STANDALONE_SESSION_PREVIEW_MIN_WIDTH = 360;
const STANDALONE_SESSION_PREVIEW_MIN_HEIGHT = 420;
const STANDALONE_COLLAB_WORKBENCH_WINDOW_LABEL = "collab-workbench";
const STANDALONE_COLLAB_WORKBENCH_WINDOW_TITLE = "协作工作台";
const STANDALONE_COLLAB_WORKBENCH_DEFAULT_WIDTH = 1420;
const STANDALONE_COLLAB_WORKBENCH_DEFAULT_HEIGHT = 920;
const STANDALONE_COLLAB_WORKBENCH_MIN_WIDTH = 960;
const STANDALONE_COLLAB_WORKBENCH_MIN_HEIGHT = 640;
const STANDALONE_SESSION_PREVIEW_COMPACT_TARGET_WIDTH = 420;
const STANDALONE_SESSION_PREVIEW_COMPACT_TARGET_HEIGHT = 620;
const STANDALONE_SESSION_PREVIEW_ANCHOR_MARGIN = 24;
const FRONTEND_SID_PROBE_BUFFER_MAX_CHARS = 256 * 1024;
const DEFAULT_INLINE_PREVIEW_PANEL_HEIGHT = 300;
const MIN_INLINE_PREVIEW_PANEL_HEIGHT = 180;
const MIN_INLINE_TERMINAL_SECTION_HEIGHT = 180;
const INLINE_PREVIEW_SPLITTER_HEIGHT = 12;

function normalizeAppPathname(pathname: string): string {
  if (!pathname) {
    return "/";
  }
  const trimmed = pathname.trim();
  if (!trimmed || trimmed === "/") {
    return "/";
  }
  if (trimmed.endsWith("/index.html")) {
    return "/";
  }
  const normalized = trimmed.replace(/\/+$/g, "");
  return normalized || "/";
}

function resolveAppRouteFromPath(pathname: string): AppRoute | null {
  const normalized = normalizeAppPathname(pathname);
  if (normalized === "/session-preview") {
    return "session-preview";
  }
  if (normalized === "/team") {
    return "team";
  }
  if (normalized === "/ai-team") {
    return "ai-team";
  }
  if (normalized === "/collab") {
    return "collab";
  }
  if (normalized === "/favorites") {
    return "favorites";
  }
  if (normalized === "/") {
    return "workspace";
  }
  return null;
}

function resolveAppRouteFromHash(hash: string): AppRoute | null {
  const trimmed = (hash || "").trim();
  if (!trimmed || trimmed === "#") {
    return "workspace";
  }
  const normalized = trimmed.replace(/\/+$/g, "");
  if (normalized === "#") {
    return "workspace";
  }
  if (normalized === "#/session-preview") {
    return "session-preview";
  }
  if (normalized === "#/team") {
    return "team";
  }
  if (normalized === "#/ai-team") {
    return "ai-team";
  }
  if (normalized === "#/collab") {
    return "collab";
  }
  if (normalized === "#/favorites") {
    return "favorites";
  }
  if (normalized === "#/" || normalized === "#/workspace") {
    return "workspace";
  }
  return null;
}

function resolveAppRoute(): AppRoute {
  return resolveAppRouteFromPath(window.location.pathname)
    ?? resolveAppRouteFromHash(window.location.hash)
    ?? "workspace";
}

function resolveStandaloneSessionPreviewPaneIdFromSearch(search: string): string {
  const params = new URLSearchParams(search || "");
  return String(params.get("paneId") || "").trim();
}

function buildStandaloneSessionPreviewUrl(paneId: string): string {
  const params = new URLSearchParams();
  const normalizedPaneId = paneId.trim();
  if (normalizedPaneId) {
    params.set("paneId", normalizedPaneId);
  }
  const query = params.toString();
  return query ? `/session-preview?${query}` : "/session-preview";
}

function buildStandaloneCollabWorkbenchUrl(): string {
  return "/collab";
}

function readStandaloneSessionPreviewAlwaysOnTopPreference(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return localStorage.getItem(STANDALONE_SESSION_PREVIEW_ALWAYS_ON_TOP_STORAGE_KEY) === "1";
}

function writeStandaloneSessionPreviewAlwaysOnTopPreference(value: boolean) {
  if (typeof window === "undefined") {
    return;
  }
  localStorage.setItem(
    STANDALONE_SESSION_PREVIEW_ALWAYS_ON_TOP_STORAGE_KEY,
    value ? "1" : "0"
  );
}

function resolveRightCenteredWindowPhysicalPosition(params: {
  hostX: number;
  hostY: number;
  hostWidth: number;
  hostHeight: number;
  popupWidth: number;
  popupHeight: number;
  margin?: number;
}) {
  const margin = params.margin ?? STANDALONE_SESSION_PREVIEW_ANCHOR_MARGIN;
  const minX = params.hostX + margin;
  const minY = params.hostY + margin;
  const maxX = Math.max(minX, params.hostX + params.hostWidth - params.popupWidth - margin);
  const maxY = Math.max(minY, params.hostY + params.hostHeight - params.popupHeight - margin);
  const desiredX = params.hostX + params.hostWidth - params.popupWidth - margin;
  const desiredY = params.hostY + Math.round((params.hostHeight - params.popupHeight) / 2);

  return {
    x: Math.max(minX, Math.min(desiredX, maxX)),
    y: Math.max(minY, Math.min(desiredY, maxY))
  };
}

function resolveStandaloneSessionPreviewCompactLogicalSize(
  hostWidth: number,
  hostHeight: number
) {
  const availableWidth = Math.max(STANDALONE_SESSION_PREVIEW_MIN_WIDTH, hostWidth - STANDALONE_SESSION_PREVIEW_ANCHOR_MARGIN * 2);
  const availableHeight = Math.max(STANDALONE_SESSION_PREVIEW_MIN_HEIGHT, hostHeight - STANDALONE_SESSION_PREVIEW_ANCHOR_MARGIN * 2);
  const scale = Math.min(
    1,
    availableWidth / STANDALONE_SESSION_PREVIEW_COMPACT_TARGET_WIDTH,
    availableHeight / STANDALONE_SESSION_PREVIEW_COMPACT_TARGET_HEIGHT
  );

  return {
    width: Math.max(
      STANDALONE_SESSION_PREVIEW_MIN_WIDTH,
      Math.round(STANDALONE_SESSION_PREVIEW_COMPACT_TARGET_WIDTH * scale)
    ),
    height: Math.max(
      STANDALONE_SESSION_PREVIEW_MIN_HEIGHT,
      Math.round(STANDALONE_SESSION_PREVIEW_COMPACT_TARGET_HEIGHT * scale)
    )
  };
}

function sanitizeTerminalProbeText(content: string): string {
  return content
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u0008/g, "")
    .replace(/\u0000/g, "");
}

function appendTerminalProbeText(current: string, incoming: string): string {
  const next = `${current}${incoming}`;
  return next.length > FRONTEND_SID_PROBE_BUFFER_MAX_CHARS
    ? next.slice(-FRONTEND_SID_PROBE_BUFFER_MAX_CHARS)
    : next;
}

type FrontendSidProbeProfile = {
  command: string;
  timeout_ms: number;
  poll_ms: number;
  key_delay_ms?: number;
  ready_timeout_ms?: number;
  prompt_patterns?: RegExp[];
  slash_mode_patterns?: RegExp[];
  slash_activation_delay_ms?: number;
  submit_delay_ms?: number;
  cleanup_data?: string;
  patterns: RegExp[];
  ready_patterns?: RegExp[];
};

function sidProbeProfileForProvider(provider: string): FrontendSidProbeProfile | null {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "codex") {
    return {
      command: "/status",
      timeout_ms: 6000,
      poll_ms: 150,
      key_delay_ms: 36,
      ready_timeout_ms: 12000,
      prompt_patterns: [/(?:^|\n)[>›❯]\s*$/m],
      slash_mode_patterns: [/(?:^|\n)[>›❯]\s*\/.*$/m, /\/status(?:line)?\b/i],
      slash_activation_delay_ms: 260,
      submit_delay_ms: 120,
      patterns: [
        /Session\s*:\s*([0-9a-fA-F-]{36})\b/i,
        /(?:^|\n)[^\n]*[•|]\s*([0-9a-fA-F-]{36})\s*$/im,
        /\b([0-9a-fA-F-]{36})\b/i
      ],
      ready_patterns: [/OpenAI\s+Codex/i]
    };
  }
  if (normalized === "claude") {
    return {
      command: "/status",
      timeout_ms: 6000,
      poll_ms: 150,
      key_delay_ms: 28,
      cleanup_data: "\u001b",
      ready_timeout_ms: 12000,
      slash_activation_delay_ms: 180,
      submit_delay_ms: 100,
      patterns: [/Session ID\s*:\s*([0-9a-fA-F-]{36})\b/i],
      ready_patterns: [/claude/i]
    };
  }
  if (normalized === "gemini") {
    return {
      command: "/stats session",
      timeout_ms: 6000,
      poll_ms: 150,
      key_delay_ms: 28,
      ready_timeout_ms: 12000,
      slash_activation_delay_ms: 180,
      submit_delay_ms: 100,
      patterns: [/Session ID\s*:\s*([0-9a-fA-F-]{36})\b/i],
      ready_patterns: [/\bgemini\b/i]
    };
  }
  return null;
}

function inferSidProbeProviderFromText(text: string, fallbackProvider: string): string {
  const normalizedFallback = fallbackProvider.trim().toLowerCase();
  const normalized = sanitizeTerminalProbeText(text).toLowerCase();
  if (!normalized) {
    return normalizedFallback;
  }
  if (
    normalized.includes("openai codex")
    || normalized.includes("new build faster with codex")
    || normalized.includes("/model to change")
  ) {
    return "codex";
  }
  if (/\bgemini\b/i.test(normalized)) {
    return "gemini";
  }
  if (/\bclaude\b/i.test(normalized)) {
    return "claude";
  }
  return normalizedFallback;
}

function resolveSidProbeProfile(
  provider: string,
  observedText = ""
): { provider: string; profile: FrontendSidProbeProfile } | null {
  const inferredProvider = inferSidProbeProviderFromText(observedText, provider);
  const inferredProfile = sidProbeProfileForProvider(inferredProvider);
  if (inferredProfile) {
    return { provider: inferredProvider, profile: inferredProfile };
  }
  const normalizedProvider = provider.trim().toLowerCase();
  const fallbackProfile = sidProbeProfileForProvider(normalizedProvider);
  if (!fallbackProfile) {
    return null;
  }
  return {
    provider: normalizedProvider,
    profile: fallbackProfile
  };
}

function extractSidFromTerminalProbeText(text: string, provider: string): string {
  const profile = sidProbeProfileForProvider(provider);
  if (!profile) {
    return "";
  }
  const normalized = sanitizeTerminalProbeText(text);
  for (const pattern of profile.patterns) {
    const matched = normalized.match(pattern);
    const value = matched?.[1]?.trim() || "";
    if (value) {
      return value;
    }
  }
  return "";
}

function readTerminalScreenText(term: Terminal, maxLines = 240): string {
  const buffer = term.buffer.active;
  const start = Math.max(0, buffer.length - maxLines);
  const lines: string[] = [];
  for (let index = start; index < buffer.length; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true) || "");
  }
  return sanitizeTerminalProbeText(lines.join("\n"));
}

function isProviderInteractiveReady(screenText: string, provider: string): boolean {
  const profile = sidProbeProfileForProvider(provider);
  if (!profile?.ready_patterns?.length) {
    return true;
  }
  return profile.ready_patterns.some((pattern) => pattern.test(screenText));
}

function isProviderInputPromptReady(screenText: string, provider: string): boolean {
  const profile = sidProbeProfileForProvider(provider);
  if (!profile?.prompt_patterns?.length) {
    return true;
  }
  return profile.prompt_patterns.some((pattern) => pattern.test(screenText));
}

function isProviderSlashModeReady(screenText: string, provider: string): boolean {
  const profile = sidProbeProfileForProvider(provider);
  if (!profile?.slash_mode_patterns?.length) {
    return true;
  }
  return profile.slash_mode_patterns.some((pattern) => pattern.test(screenText));
}

type PaneSummary = {
  id: string;
  provider: string;
  title: string;
  created_at: number;
  updated_at: number;
};

type PaneSessionState = {
  pane_id: string;
  active_session_id: string;
  linked_session_ids: string[];
  include_linked_in_sync: boolean;
  updated_at: number;
};

type PaneScanConfig = {
  pane_id: string;
  parser_profile: string;
  file_glob: string;
  updated_at: number;
};

type NativeSessionCandidate = {
  provider: string;
  session_id: string;
  started_at: number;
  last_seen_at: number;
  source_files: number;
  record_count: number;
  first_input: string;
  synthetic?: boolean;
  synthetic_reason?: string;
};

type NativeSessionListResponse = {
  items: NativeSessionCandidate[];
  unrecognized_files: NativeSessionUnrecognizedFile[];
  total: number;
  offset: number;
  limit: number;
  has_more: boolean;
};

type NativeSessionUnrecognizedFile = {
  file_path: string;
  reason: string;
  parse_errors: number;
  scanned_units: number;
  row_count: number;
  modified_at: number;
};

type NativeSessionIndexProgress = {
  provider: string;
  running: boolean;
  total_files: number;
  processed_files: number;
  changed_files: number;
  started_at: number;
  elapsed_secs: number;
  last_duration_secs: number;
  updated_at: number;
};

type SessionParserProfileSummary = {
  id: string;
  name: string;
  default_file_glob: string;
  file_format: string;
};

type SessionParserSamplePreviewResponse = {
  parser_profile: string;
  file_path: string;
  file_format: string;
  sample_value: unknown;
  message_sample_value?: unknown | null;
};

type CreatePanePathTarget =
  | "session_id_paths"
  | "started_at_paths"
  | "rule_role_path"
  | "rule_content_text_paths"
  | "rule_timestamp_paths"
  | "message_source_path"
  | "rule_content_item_path"
  | "rule_content_item_filter_path";

type CreatePaneSampleViewMode = "root" | "message";

type CreatePaneSamplePreviewState = {
  loading: boolean;
  error: string;
  parser_profile: string;
  file_path: string;
  file_format: string;
  sample_value: unknown | null;
  message_sample_value: unknown | null;
};

type AppConfigResponse = {
  config_path: string;
  working_directory: string | null;
  native_session_list_cache_ttl_secs: number;
  ui_theme_preset: string;
  ui_skin_hue: number;
  ui_skin_accent: string;
  user_avatar_path: string;
  assistant_avatar_path: string;
};

type UiThemeConfigResponse = {
  ui_theme_preset: string;
  ui_skin_hue: number;
  ui_skin_accent: string;
};

type AvatarConfigResponse = {
  user_avatar_path: string;
  assistant_avatar_path: string;
};

type TerminalOutputEvent = {
  pane_id: string;
  data: string;
};

type TerminalExitEvent = {
  pane_id: string;
};

type PaneView = PaneSummary & {
  active_session_id: string;
  linked_session_ids: string[];
  sid_checking: boolean;
  scan_running: boolean;
  scan_total_files: number;
  scan_processed_files: number;
  scan_changed_files: number;
};

type PaneTerminal = {
  term: Terminal;
  fit: FitAddon;
  dataDisposable: IDisposable;
  resizeObserver: ResizeObserver;
  element: HTMLDivElement;
  focusHandler: () => void;
  disposed: boolean;
};

type PaneOutputProbeState = {
  revision: number;
  text: string;
};

type PanePreviewResizeState = {
  paneId: string;
  startY: number;
  originHeight: number;
};

type SendDialogState = {
  open: boolean;
  pane_id: string;
  input: string;
  sending: boolean;
};

type UnrecognizedFilePreviewDialogState = {
  open: boolean;
  loading: boolean;
  pane_id: string;
  file_path: string;
  reason: string;
  parse_errors: number;
  scanned_units: number;
  row_count: number;
  session_id: string;
  started_at: number;
  content: string;
};

type CreatePaneDialogState = {
  open: boolean;
  creating: boolean;
  provider_mode: "preset" | "custom";
  provider: "codex" | "claude" | "gemini";
  custom_provider: string;
  title_mode: "auto" | "custom";
  custom_title: string;
  team_directory: string;
  team_role_count: number;
  session_parse_preset: string;
  session_scan_glob: string;
  session_parse_json: string;
};

type SessionManageDialogState = {
  open: boolean;
  pane_id: string;
  active_session_id: string;
  linked_session_ids: string[];
  saving: boolean;
  view_mode: "manage" | "list";
};

type SessionManagePreviewState = {
  preview_session_id: string;
  preview_loading: boolean;
  preview_rows: NativeSessionPreviewRow[];
  preview_total_rows: number;
  preview_loaded_rows: number;
  preview_has_more: boolean;
  preview_from_end: boolean;
};

type SessionManageGroupTabKey = "current" | "linked" | "unlinked";

type PreviewOverlaySource = "session-manage" | "sync-dialog";

type SessionListDialogState = {
  open: boolean;
  pane_id: string;
  loading: boolean;
  loading_more: boolean;
  all_items: NativeSessionCandidate[];
  items: NativeSessionCandidate[];
  total: number;
  offset: number;
  limit: number;
  has_more: boolean;
  selected_row_keys: string[];
  sort_mode: SessionSortMode;
  sid_keyword: string;
  time_from: string;
  time_to: string;
  quick_time_preset: "" | "3h" | "24h" | "3d" | "7d" | "30d" | "3m" | "1y";
  records_min: number | null;
  records_max: number | null;
  preview_session_id: string;
  preview_loading: boolean;
  preview_rows: NativeSessionPreviewRow[];
  preview_total_rows: number;
  preview_loaded_rows: number;
  preview_has_more: boolean;
  preview_from_end: boolean;
  preview_auto_refresh: boolean;
  preview_panel_height: number;
  unrecognized_files: NativeSessionUnrecognizedFile[];
};

type SyncSessionListState = {
  pane_id: string;
  loading: boolean;
  all_items: NativeSessionCandidate[];
  items: NativeSessionCandidate[];
  total: number;
  limit: number;
  sort_mode: SessionSortMode;
  sid_keyword: string;
  time_from: string;
  time_to: string;
  quick_time_preset: "" | "3h" | "24h" | "3d" | "7d" | "30d" | "3m" | "1y";
  records_min: number | null;
  records_max: number | null;
};

type SyncDialogPreviewState = {
  preview_session_id: string;
  preview_loading: boolean;
  preview_rows: NativeSessionPreviewRow[];
  preview_total_rows: number;
  preview_loaded_rows: number;
  preview_has_more: boolean;
  preview_from_end: boolean;
};

type EntryRecord = {
  id: string;
  pane_id: string;
  kind: "input" | "output" | string;
  content: string;
  synced_from: string | null;
  created_at: number;
  preview_truncated?: boolean;
};

type NativeImportResult = {
  provider: string;
  pane_id: string;
  session_id: string;
  session_ids: string[];
  source_dir: string;
  imported: number;
  skipped: number;
  scanned_files: number;
  scanned_lines: number;
  parse_errors: number;
};

type NativeSessionPreviewRow = {
  id: string;
  kind: string;
  content: string;
  created_at: number;
  preview_truncated: boolean;
};

type NativeSessionPreviewResponse = {
  session_id: string;
  rows: NativeSessionPreviewRow[];
  total_rows: number;
  loaded_rows: number;
  has_more: boolean;
};

type NativeSessionMessageDetailResponse = {
  message_id: string;
  session_id: string;
  kind: string;
  content: string;
  created_at: number;
};

type NativeSessionMessageSelection = {
  messageId: string;
  sessionId: string;
};

type FavoriteMessageRecord = {
  id: string;
  pane_id: string;
  pane_title: string;
  provider: string;
  session_id: string;
  message_id: string;
  kind: string;
  content: string;
  created_at: number;
  favorited_at: number;
};

type FavoriteMessageUpsertInput = {
  paneId: string;
  paneTitle: string;
  provider: string;
  sessionId: string;
  messageId: string;
  kind: string;
  content: string;
  createdAt: number;
};

type NativeUnrecognizedFilePreviewResponse = {
  file_path: string;
  reason: string;
  parse_errors: number;
  scanned_units: number;
  row_count: number;
  session_id: string;
  started_at: number;
  content: string;
};

type UnrecognizedFilesModalState = {
  open: boolean;
  loading: boolean;
  items: NativeSessionUnrecognizedFile[];
};

type SessionSortField = "created" | "updated" | "records";
type SessionSortOrder = "desc" | "asc";
type SessionSortMode =
  | "created_desc"
  | "created_asc"
  | "updated_desc"
  | "updated_asc"
  | "records_desc"
  | "records_asc";

type SyncStrategy = "all" | "latest_qa" | "turn_1" | "turn_3" | "turn_5";
type SyncPreviewKind = "all" | "input" | "output";
type SyncProgressStage = "idle" | "importing" | "filtering" | "syncing" | "done" | "error";

type SyncDialogState = {
  open: boolean;
  pane_id: string;
  loading: boolean;
  importing: boolean;
  syncing: boolean;
  target_pane_id: string;
  preview_session_id: string;
  strategy: SyncStrategy;
  selected_session_ids: string[];
  included_entry_ids: string[];
  excluded_entry_ids: string[];
  preview_query: string;
  preview_kind: SyncPreviewKind;
  progress_stage: SyncProgressStage;
  progress_percent: number;
  progress_text: string;
  entries: EntryRecord[];
};

type SyncSessionGroupStat = {
  session_id: string;
  all_count: number;
  scoped_count: number;
  total_count: number;
  excluded_count: number;
  pending_count: number;
  selected: boolean;
  is_current: boolean;
  first_at: number;
  last_at: number;
};

type CompressConfig = {
  enabled: boolean;
  token_waterline: number;
  turn_waterline: number;
  max_chars: number;
  summary_chars: number;
};

const FALLBACK_PROVIDERS: Provider[] = ["codex", "claude", "gemini"];
const STORAGE_COLOR_MODE_KEY = "ai-shell.ui.color-mode";
const STORAGE_COMPRESS_KEY = "ai-shell.sync.compress";
const DEFAULT_THEME_PRESET = "ocean";
const DEFAULT_SKIN_HUE = 218;
const DEFAULT_SKIN_ACCENT = "#34e7ff";
const DEFAULT_USER_AVATAR_TOKEN = "@man.jpg";
const DEFAULT_ASSISTANT_AVATAR_TOKEN = "@ai.jpg";
const DEFAULT_SESSION_LIST_LIMIT = 80;
const SYNC_UNKNOWN_SESSION_ID = "__unknown_sync_session__";
const STORAGE_SESSION_PANEL_OPEN_KEY = "ai-shell.session-panel-open-map";
const BUILTIN_PROVIDER_PRESETS: Array<"codex" | "claude" | "gemini"> = ["codex", "claude", "gemini"];
const FALLBACK_SESSION_PARSER_PROFILES: SessionParserProfileSummary[] = [
  { id: "codex", name: "Codex JSONL", default_file_glob: "**/rollout-*.jsonl", file_format: "jsonl" },
  { id: "claude", name: "Claude JSONL", default_file_glob: "**/*.jsonl", file_format: "jsonl" },
  { id: "gemini", name: "Gemini JSON", default_file_glob: "**/session-*.json", file_format: "json" }
];

const DEFAULT_COMPRESS_CONFIG: CompressConfig = {
  enabled: true,
  token_waterline: 8000,
  turn_waterline: 20,
  max_chars: 8000,
  summary_chars: 1600
};

const TEAM_WORK_DIR_NAME = "work";
const TEAM_CODE_DIR_NAME = "code";

function asTitle(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  if (!normalized) {
    return "未知";
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

function formatTs(value: number): string {
  if (!value || value <= 0) {
    return "-";
  }
  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
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

function parseSessionIds(values: string[]): string[] {
  const normalized = new Set<string>();
  for (const raw of values) {
    const fragments = raw
      .split(/[,;\s]+/g)
      .map((item) => item.trim())
      .filter(Boolean);
    for (const fragment of fragments) {
      normalized.add(fragment);
    }
  }
  return [...normalized];
}

function parseDateTimeLocalToEpoch(value: string): number | null {
  const text = value.trim();
  if (!text) {
    return null;
  }
  const timestamp = new Date(text).getTime();
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return Math.floor(timestamp / 1000);
}

function isBuiltinProvider(value: string): value is "codex" | "claude" | "gemini" {
  return value === "codex" || value === "claude" || value === "gemini";
}

function normalizeSessionParsePreset(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "");
  return normalized || "codex";
}

function defaultSessionScanGlobByPreset(
  preset: string,
  profiles: SessionParserProfileSummary[] = []
): string {
  const normalizedPreset = normalizeSessionParsePreset(preset);
  if (normalizedPreset === "codex") {
    return "~/.codex/sessions/**/rollout-*.jsonl";
  }
  if (normalizedPreset === "claude") {
    return "~/.claude/projects/**/*.jsonl";
  }
  if (normalizedPreset === "gemini") {
    return "~/.gemini/tmp/**/chats/session-*.json";
  }
  const matched = profiles.find(
    (profile) => normalizeSessionParsePreset(profile.id) === normalizedPreset
  );
  if (matched?.default_file_glob?.trim()) {
    return matched.default_file_glob.trim();
  }
  return "**/*";
}

function defaultSessionSourceRootToken(preset: string): string {
  const id = normalizeSessionParsePreset(preset);
  if (id === "codex") {
    return "$CODEX_SESSIONS";
  }
  if (id === "claude") {
    return "$CLAUDE_PROJECTS";
  }
  if (id === "gemini") {
    return "$GEMINI_TMP";
  }
  return `$${id.toUpperCase()}_SESSIONS`;
}

function inferSessionFileFormatByGlob(glob: string, fallback: "jsonl" | "json" = "jsonl"): "jsonl" | "json" {
  const normalized = glob.trim().toLowerCase();
  if (normalized.includes(".jsonl")) {
    return "jsonl";
  }
  if (normalized.includes(".json")) {
    return "json";
  }
  return fallback;
}

function inferSessionFileFormatLabelByGlob(glob: string): "jsonl" | "json" | "未识别" {
  const normalized = glob.trim().toLowerCase();
  if (!normalized) {
    return "未识别";
  }
  if (normalized.includes(".jsonl")) {
    return "jsonl";
  }
  if (normalized.includes(".json")) {
    return "json";
  }
  return "未识别";
}

function normalizeSessionScanGlobInput(value: string): string {
  if (!value.trim()) {
    return "";
  }
  const normalized = value.replace(/\r\n?/g, "\n").replace(/[，；]/g, ",");
  const tokens = normalized
    .split(/[\n,;]+/)
    .map((token) => token.trim().replace(/\\/g, "/"))
    .filter((token) => token.length > 0);
  return tokens.join("\n");
}

function createPanePathTargetLabel(target: CreatePanePathTarget): string {
  if (target === "session_id_paths") {
    return "会话 ID 路径";
  }
  if (target === "started_at_paths") {
    return "会话时间路径";
  }
  if (target === "rule_role_path") {
    return "消息角色路径";
  }
  if (target === "rule_content_text_paths") {
    return "消息文本路径";
  }
  if (target === "rule_timestamp_paths") {
    return "消息时间路径";
  }
  if (target === "message_source_path") {
    return "消息容器路径";
  }
  if (target === "rule_content_item_path") {
    return "消息项路径";
  }
  return "消息项过滤路径";
}

function isCreatePanePathTargetMulti(target: CreatePanePathTarget): boolean {
  return (
    target === "session_id_paths" ||
    target === "started_at_paths" ||
    target === "rule_content_text_paths" ||
    target === "rule_timestamp_paths"
  );
}

function jsonPathTokensToParserPath(pathTokens: JsonPathToken[]): string {
  let output = "";
  for (const token of pathTokens) {
    if (typeof token === "number") {
      output += "[*]";
      continue;
    }
    const field = String(token || "").trim();
    if (!field) {
      continue;
    }
    output = output ? `${output}.${field}` : field;
  }
  return output;
}

function appendUniquePath(paths: unknown, path: string): string[] {
  const normalized = path.trim();
  if (!normalized) {
    return toStringList(paths);
  }
  const list = toStringList(paths);
  if (!list.includes(normalized)) {
    list.push(normalized);
  }
  return list;
}

function unrecognizedReasonLabel(reason: string): string {
  const normalized = reason.trim().toLowerCase();
  if (normalized === "parse_error") {
    return "解析失败";
  }
  if (normalized === "no_messages") {
    return "未匹配到消息";
  }
  if (normalized === "missing_session_id") {
    return "未提取到会话ID";
  }
  if (normalized === "recognized") {
    return "已识别";
  }
  return normalized || "未识别";
}

function shortFileName(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || path;
}

function defaultLineParserScriptByPreset(preset: string): string {
  const normalized = normalizeSessionParsePreset(preset);
  if (normalized === "codex") {
    return `fn parse_line(line, ctx) {
  let sid = if line.sessionId != () { line.sessionId } else if line.payload != () && line.payload.id != () { line.payload.id } else { ctx.current_session_id };
  let ts = if line.timestamp != () { line.timestamp } else if line.payload != () && line.payload.timestamp != () { line.payload.timestamp } else { ctx.fallback_timestamp };
  if line.type == "response_item" && line.payload != () && line.payload.type == "message" {
    if line.payload.content != () {
      let rows = [];
      for item in line.payload.content {
        if item.text != () && item.text != "" {
          let role = if line.payload.role != () { line.payload.role } else { "assistant" };
          let kind = if role == "user" { "input" } else { "output" };
          rows.push(#{ session_id: sid, kind: kind, role: role, content: item.text, created_at: ts });
        }
      }
      return #{ session_id: sid, started_at: ts, rows: rows };
    }
  }
  if line.type == "user" && line.message != () && line.message.content != () {
    return #{ session_id: sid, started_at: ts, kind: "input", role: "user", content: line.message.content, created_at: ts };
  }
  if line.type == "assistant" && line.message != () && line.message.content != () {
    return #{ session_id: sid, started_at: ts, kind: "output", role: "assistant", content: line.message.content, created_at: ts };
  }
  return #{ session_id: sid, started_at: ts };
}`;
  }
  if (normalized === "claude") {
    return `fn parse_line(line, ctx) {
  let sid = if line.sessionId != () { line.sessionId } else { ctx.current_session_id };
  let ts = if line.timestamp != () { line.timestamp } else { ctx.fallback_timestamp };
  if line.type == "user" && line.message != () && line.message.content != () {
    return #{ session_id: sid, started_at: ts, kind: "input", role: "user", content: line.message.content, created_at: ts };
  }
  if line.type == "assistant" && line.message != () && line.message.content != () {
    return #{ session_id: sid, started_at: ts, kind: "output", role: "assistant", content: line.message.content, created_at: ts };
  }
  return #{ session_id: sid, started_at: ts };
}`;
  }
  if (normalized === "gemini") {
    return `fn parse_line(line, ctx) {
  let sid = if line.sessionId != () { line.sessionId } else { ctx.current_session_id };
  let ts = if line.timestamp != () { line.timestamp } else if line.startTime != () { line.startTime } else { ctx.fallback_timestamp };
  let role = if line.type != () { line.type } else { "" };
  if role == "user" {
    if line.content != () { return #{ session_id: sid, started_at: ts, kind: "input", role: "user", content: line.content, created_at: ts }; }
  }
  if role == "assistant" || role == "gemini" || role == "error" || role == "info" {
    if line.content != () { return #{ session_id: sid, started_at: ts, kind: "output", role: role, content: line.content, created_at: ts }; }
  }
  return #{ session_id: sid, started_at: ts };
}`;
  }
  return `fn parse_line(line, ctx) {
  return ();
}`;
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => String(item ?? "").trim())
    .filter((item) => item.length > 0);
}

function toObjectRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const record = value as Record<string, unknown>;
  const next: Record<string, string> = {};
  for (const [key, raw] of Object.entries(record)) {
    const normalizedKey = String(key || "").trim();
    const normalizedValue = String(raw ?? "").trim();
    if (!normalizedKey || !normalizedValue) {
      continue;
    }
    next[normalizedKey] = normalizedValue;
  }
  return next;
}

function parseFirstFilter(value: unknown): { path: string; equals: string } {
  const first = Array.isArray(value) ? value[0] : null;
  if (!first || typeof first !== "object" || Array.isArray(first)) {
    return { path: "", equals: "" };
  }
  const row = first as Record<string, unknown>;
  return {
    path: String(row.path ?? "").trim(),
    equals: String(row.equals ?? "").trim()
  };
}

function normalizeSessionParserConfigForEditor(raw: string, fallbackId: string): Record<string, unknown> {
  let parsed: Record<string, unknown> = {};
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    parsed = {};
  }

  const normalizedId = normalizeSessionParsePreset(String(parsed.id ?? fallbackId));
  const roleMapRaw = toObjectRecord(
    Array.isArray(parsed.message_rules) &&
      parsed.message_rules[0] &&
      typeof parsed.message_rules[0] === "object"
      ? (parsed.message_rules[0] as Record<string, unknown>).role_map
      : null
  );
  const contentTypeMapRaw = toObjectRecord(
    Array.isArray(parsed.message_rules) &&
      parsed.message_rules[0] &&
      typeof parsed.message_rules[0] === "object"
      ? (parsed.message_rules[0] as Record<string, unknown>).content_item_filter_by_role
      : null
  );
  const firstRule =
    Array.isArray(parsed.message_rules) &&
    parsed.message_rules[0] &&
    typeof parsed.message_rules[0] === "object" &&
    !Array.isArray(parsed.message_rules[0])
      ? (parsed.message_rules[0] as Record<string, unknown>)
      : {};

  const roleMap = {
    user: roleMapRaw.user || "input",
    assistant: roleMapRaw.assistant || "output",
    ...roleMapRaw
  };
  const contentTypeMap = {
    user: contentTypeMapRaw.user || "input_text",
    assistant: contentTypeMapRaw.assistant || "output_text",
    ...contentTypeMapRaw
  };
  const sessionMetaFilter = parseFirstFilter(parsed.session_meta_filters);
  const messageFilter = parseFirstFilter(firstRule.filters);
  const lineParserScript = String(parsed.line_parser_script ?? "").trim();
  const lineParserFunction = String(parsed.line_parser_function ?? "parse_line").trim() || "parse_line";

  return {
    id: normalizedId || "custom-model",
    name: String(parsed.name ?? `${asTitle(normalizedId || "custom-model")} JSONL`).trim(),
    source_roots: (() => {
      const roots = toStringList(parsed.source_roots);
      return roots.length ? roots : [defaultSessionSourceRootToken(normalizedId || "custom-model")];
    })(),
    default_file_glob:
      String(parsed.default_file_glob ?? defaultSessionScanGlobByPreset(normalizedId)).trim() ||
      defaultSessionScanGlobByPreset(normalizedId),
    file_format: String(parsed.file_format ?? (normalizedId === "gemini" ? "json" : "jsonl"))
      .trim()
      .toLowerCase(),
    session_meta_scan_max_lines: Number(parsed.session_meta_scan_max_lines ?? 64),
    session_id_paths: toStringList(parsed.session_id_paths),
    started_at_paths: toStringList(parsed.started_at_paths),
    fallback_timestamp_paths: toStringList(parsed.fallback_timestamp_paths),
    session_meta_filter_path: sessionMetaFilter.path,
    session_meta_filter_equals: sessionMetaFilter.equals,
    message_source_path: String(parsed.message_source_path ?? "").trim(),
    rule_role_path: String(firstRule.role_path ?? "").trim(),
    rule_content_item_path: String(firstRule.content_item_path ?? "").trim(),
    rule_content_item_filter_path: String(firstRule.content_item_filter_path ?? "").trim(),
    rule_content_text_paths: toStringList(firstRule.content_text_paths),
    rule_timestamp_paths: toStringList(firstRule.timestamp_paths),
    rule_user_kind: String(roleMap.user ?? "input").trim() || "input",
    rule_assistant_kind: String(roleMap.assistant ?? "output").trim() || "output",
    rule_user_content_type: String(contentTypeMap.user ?? "input_text").trim() || "input_text",
    rule_assistant_content_type:
      String(contentTypeMap.assistant ?? "output_text").trim() || "output_text",
    strip_codex_tags: Boolean(parsed.strip_codex_tags),
    line_parser_enabled: Boolean(parsed.line_parser_enabled) || lineParserScript.length > 0,
    line_parser_function: lineParserFunction,
    line_parser_script: lineParserScript
  };
}

function buildSessionParserConfigFromEditor(editor: Record<string, unknown>): Record<string, unknown> {
  const id = normalizeSessionParsePreset(String(editor.id ?? "custom-model"));
  const defaultFileGlob =
    String(editor.default_file_glob ?? defaultSessionScanGlobByPreset(id)).trim() ||
    defaultSessionScanGlobByPreset(id);
  const fileFormat = inferSessionFileFormatByGlob(defaultFileGlob, id === "gemini" ? "json" : "jsonl");
  const sourceRoots = toStringList(editor.source_roots);
  const sessionIdPaths = toStringList(editor.session_id_paths);
  const startedAtPaths = toStringList(editor.started_at_paths);
  const fallbackTimestampPaths = toStringList(editor.fallback_timestamp_paths);
  const contentTextPaths = toStringList(editor.rule_content_text_paths);
  const timestampPaths = toStringList(editor.rule_timestamp_paths);
  const sessionMetaFilterPath = String(editor.session_meta_filter_path ?? "").trim();
  const sessionMetaFilterEquals = String(editor.session_meta_filter_equals ?? "").trim();
  const rolePath = String(editor.rule_role_path ?? "").trim();
  const contentItemPath = String(editor.rule_content_item_path ?? "").trim();
  const contentItemFilterPath = String(editor.rule_content_item_filter_path ?? "").trim();
  const userKind = String(editor.rule_user_kind ?? "input").trim() || "input";
  const assistantKind = String(editor.rule_assistant_kind ?? "output").trim() || "output";
  const userContentType = String(editor.rule_user_content_type ?? "input_text").trim() || "input_text";
  const assistantContentType =
    String(editor.rule_assistant_content_type ?? "output_text").trim() || "output_text";
  const defaultRootToken = defaultSessionSourceRootToken(id);
  const lineParserEnabled = Boolean(editor.line_parser_enabled);
  const lineParserFunction =
    String(editor.line_parser_function ?? "parse_line")
      .trim()
      .replace(/[^a-zA-Z0-9_]/g, "") || "parse_line";
  const lineParserScript = String(editor.line_parser_script ?? "").trim();

  return {
    id,
    name: String(editor.name ?? "").trim() || `${asTitle(id)} Parser`,
    source_roots: sourceRoots.length ? sourceRoots : [defaultRootToken],
    default_file_glob: defaultFileGlob,
    file_format: fileFormat,
    session_meta_scan_max_lines: Math.max(0, Number(editor.session_meta_scan_max_lines ?? 64) || 0),
    session_id_paths: sessionIdPaths,
    started_at_paths: startedAtPaths,
    session_meta_filters:
      sessionMetaFilterPath && sessionMetaFilterEquals
        ? [{ path: sessionMetaFilterPath, equals: sessionMetaFilterEquals }]
        : [],
    message_source_path: String(editor.message_source_path ?? "").trim(),
    message_rules: [
      {
        filters: [],
        ignore_true_paths: [],
        role_path: rolePath,
        role_map: {
          user: userKind,
          assistant: assistantKind
        },
        session_id_paths: [],
        content_item_path: contentItemPath,
        content_item_filter_path: contentItemFilterPath,
        content_item_filter_by_role: {
          user: userContentType,
          assistant: assistantContentType
        },
        content_text_paths: contentTextPaths,
        timestamp_paths: timestampPaths
      }
    ],
    fallback_timestamp_paths: fallbackTimestampPaths,
    strip_codex_tags: Boolean(editor.strip_codex_tags),
    line_parser_function: lineParserEnabled ? lineParserFunction : "",
    line_parser_script: lineParserEnabled ? lineParserScript : ""
  };
}

function buildAutoPaneTitle(provider: string, panes: PaneView[]): string {
  const normalized = provider.trim().toLowerCase();
  const base = asTitle(normalized || "terminal");
  const next = panes.filter((pane) => pane.provider.trim().toLowerCase() === normalized).length + 1;
  return `${base}-${next}`;
}

function formatDateTimeLocalValue(value: Date): string {
  const yyyy = value.getFullYear();
  const mm = String(value.getMonth() + 1).padStart(2, "0");
  const dd = String(value.getDate()).padStart(2, "0");
  const hh = String(value.getHours()).padStart(2, "0");
  const mi = String(value.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

function normalizeOptionalNonNegativeInt(value: number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return null;
  }
  return Math.max(0, Math.floor(num));
}

function joinFilesystemPath(base: string, segment: string): string {
  const trimmedBase = base.trim();
  const trimmedSegment = segment.trim();
  if (!trimmedBase) {
    return trimmedSegment;
  }
  if (!trimmedSegment) {
    return trimmedBase;
  }
  const separator = trimmedBase.includes("\\") && !trimmedBase.includes("/") ? "\\" : "/";
  const normalizedBase = trimmedBase.replace(/[\\/]+$/g, "");
  const normalizedSegment = trimmedSegment.replace(/^[\\/]+/g, "");
  return `${normalizedBase}${separator}${normalizedSegment}`;
}

function splitSessionSortMode(mode: SessionSortMode): { field: SessionSortField; order: SessionSortOrder } {
  if (mode === "created_asc") {
    return { field: "created", order: "asc" };
  }
  if (mode === "created_desc") {
    return { field: "created", order: "desc" };
  }
  if (mode === "updated_asc") {
    return { field: "updated", order: "asc" };
  }
  if (mode === "updated_desc") {
    return { field: "updated", order: "desc" };
  }
  if (mode === "records_asc") {
    return { field: "records", order: "asc" };
  }
  return { field: "records", order: "desc" };
}

function toSessionSortMode(field: SessionSortField, order: SessionSortOrder): SessionSortMode {
  if (field === "created") {
    return order === "asc" ? "created_asc" : "created_desc";
  }
  if (field === "updated") {
    return order === "asc" ? "updated_asc" : "updated_desc";
  }
  return order === "asc" ? "records_asc" : "records_desc";
}

function sessionSortFieldLabel(field: SessionSortField): string {
  if (field === "created") {
    return "创建时间";
  }
  if (field === "updated") {
    return "更新时间";
  }
  return "记录数";
}

function sessionSortOrderLabel(order: SessionSortOrder): string {
  return order === "asc" ? "正序" : "逆序";
}

function sortSessionCandidatesByMode(
  items: NativeSessionCandidate[],
  mode: SessionSortMode
): NativeSessionCandidate[] {
  const { field, order } = splitSessionSortMode(mode);
  const desc = order !== "asc";
  const sorted = [...items];
  sorted.sort((a, b) => {
    const createdA = a.started_at > 0 ? a.started_at : a.last_seen_at;
    const createdB = b.started_at > 0 ? b.started_at : b.last_seen_at;
    const updatedA = a.last_seen_at > 0 ? a.last_seen_at : a.started_at;
    const updatedB = b.last_seen_at > 0 ? b.last_seen_at : b.started_at;
    let ord = 0;
    if (field === "records") {
      ord = a.record_count - b.record_count;
      if (ord === 0) {
        ord =
          createdA - createdB ||
          updatedA - updatedB ||
          a.session_id.localeCompare(b.session_id);
      }
    } else if (field === "created") {
      ord = createdA - createdB;
      if (ord === 0) {
        ord =
          updatedA - updatedB ||
          a.record_count - b.record_count ||
          a.session_id.localeCompare(b.session_id);
      }
    } else {
      ord = updatedA - updatedB;
      if (ord === 0) {
        ord =
          createdA - createdB ||
          a.record_count - b.record_count ||
          a.session_id.localeCompare(b.session_id);
      }
    }
    return desc ? -ord : ord;
  });
  return sorted;
}

function filterSessionCandidatesByDialog(
  sourceItems: NativeSessionCandidate[],
  dialog: Pick<
    SessionListDialogState,
    "sid_keyword" | "time_from" | "time_to" | "records_min" | "records_max" | "sort_mode"
  >
): NativeSessionCandidate[] {
  let items = [...sourceItems];
  const sidKeyword = dialog.sid_keyword.trim().toLowerCase();
  if (sidKeyword) {
    items = items.filter((item) => {
      if (item.session_id.toLowerCase().includes(sidKeyword)) {
        return true;
      }
      const firstInput = String(item.first_input || "").toLowerCase();
      return firstInput.includes(sidKeyword);
    });
  }

  let timeFromValue = parseDateTimeLocalToEpoch(dialog.time_from);
  let timeToValue = parseDateTimeLocalToEpoch(dialog.time_to);
  if (timeFromValue && timeToValue && timeFromValue > timeToValue) {
    const swapped = timeFromValue;
    timeFromValue = timeToValue;
    timeToValue = swapped;
  }
  if (timeFromValue || timeToValue) {
    items = items.filter((item) => {
      const candidateTime = item.started_at > 0 ? item.started_at : item.last_seen_at;
      if (timeFromValue && candidateTime < timeFromValue) {
        return false;
      }
      if (timeToValue && candidateTime > timeToValue) {
        return false;
      }
      return true;
    });
  }

  let recordsMinValue = normalizeOptionalNonNegativeInt(dialog.records_min);
  let recordsMaxValue = normalizeOptionalNonNegativeInt(dialog.records_max);
  if (
    recordsMinValue !== null &&
    recordsMaxValue !== null &&
    recordsMinValue > recordsMaxValue
  ) {
    const swapped = recordsMinValue;
    recordsMinValue = recordsMaxValue;
    recordsMaxValue = swapped;
  }
  if (recordsMinValue !== null || recordsMaxValue !== null) {
    items = items.filter((item) => {
      if (recordsMinValue !== null && item.record_count < recordsMinValue) {
        return false;
      }
      if (recordsMaxValue !== null && item.record_count > recordsMaxValue) {
        return false;
      }
      return true;
    });
  }

  return sortSessionCandidatesByMode(items, dialog.sort_mode);
}

function parseNativeImportTag(
  syncedFrom: string | null
): { provider: string; sessionId: string; sourceKind: "active" | "linked" } | null {
  const value = (syncedFrom ?? "").trim();
  if (!value.startsWith("native:")) {
    return null;
  }
  const parts = value.split(":");
  if (parts.length < 4) {
    return null;
  }
  const provider = parts[1]?.trim().toLowerCase();
  const sourceKindRaw = parts[parts.length - 1]?.trim().toLowerCase();
  const sourceKind = sourceKindRaw === "linked" ? "linked" : "active";
  const sessionId = parts.slice(2, parts.length - 1).join(":").trim();
  if (!provider || !sessionId) {
    return null;
  }
  return { provider, sessionId, sourceKind };
}

function buildNativePreviewTag(sessionId: string): string {
  return `native-preview:${sessionId.trim()}`;
}

function parseNativePreviewTag(syncedFrom: string | null): string {
  const value = (syncedFrom ?? "").trim();
  if (!value.startsWith("native-preview:")) {
    return "";
  }
  return value.slice("native-preview:".length).trim();
}

function resolveEntrySessionId(entry: EntryRecord, activeSessionId: string): string {
  const tagged = parseNativeImportTag(entry.synced_from)?.sessionId;
  if (tagged) {
    return tagged;
  }
  const previewTagged = parseNativePreviewTag(entry.synced_from);
  if (previewTagged) {
    return previewTagged;
  }
  return activeSessionId.trim();
}

function pickRecentTurns(entries: EntryRecord[], turnCount: number): EntryRecord[] {
  if (!entries.length) {
    return [];
  }
  const turns: EntryRecord[][] = [];
  let current: EntryRecord[] = [];
  for (const entry of entries) {
    if (entry.kind === "input" && current.length > 0) {
      turns.push(current);
      current = [entry];
      continue;
    }
    current.push(entry);
  }
  if (current.length) {
    turns.push(current);
  }
  const take = Math.max(1, Math.min(20, Math.floor(turnCount)));
  return turns.slice(-take).flat();
}

function pickLatestQuestionAnswer(entries: EntryRecord[]): EntryRecord[] {
  if (!entries.length) {
    return [];
  }
  let latestInput: EntryRecord | null = null;
  let latestOutput: EntryRecord | null = null;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const row = entries[i];
    if (!latestOutput && row.kind === "output") {
      latestOutput = row;
    }
    if (!latestInput && row.kind === "input") {
      latestInput = row;
    }
    if (latestInput && latestOutput) {
      break;
    }
  }
  if (latestInput && latestOutput) {
    if (latestInput.created_at <= latestOutput.created_at) {
      return [latestInput, latestOutput];
    }
    return [latestInput];
  }
  if (latestInput) {
    return [latestInput];
  }
  if (latestOutput) {
    return [latestOutput];
  }
  return [];
}

function pickEntriesBySyncStrategy(entries: EntryRecord[], strategy: SyncStrategy): EntryRecord[] {
  if (strategy === "latest_qa") {
    return pickLatestQuestionAnswer(entries);
  }
  if (strategy === "turn_1") {
    return pickRecentTurns(entries, 1);
  }
  if (strategy === "turn_3") {
    return pickRecentTurns(entries, 3);
  }
  if (strategy === "turn_5") {
    return pickRecentTurns(entries, 5);
  }
  return [...entries];
}

function compareEntryByTime(a: EntryRecord, b: EntryRecord): number {
  if (a.created_at !== b.created_at) {
    return a.created_at - b.created_at;
  }
  return a.id.localeCompare(b.id);
}

function buildFavoriteMessageKey(target: {
  pane_id: string;
  session_id: string;
  message_id: string;
}): string {
  return [
    target.pane_id.trim(),
    target.session_id.trim(),
    target.message_id.trim()
  ].join("::");
}

function buildFavoriteMessageKeyFromRecord(item: FavoriteMessageRecord): string {
  return buildFavoriteMessageKey({
    pane_id: item.pane_id,
    session_id: item.session_id,
    message_id: item.message_id
  });
}

function buildFavoriteMessageKeyFromPreviewItem(item: SyncEntryPreviewItem): string {
  const target = item.favorite_target;
  if (!target) {
    return "";
  }
  return buildFavoriteMessageKey({
    pane_id: target.pane_id,
    session_id: target.session_id,
    message_id: item.id
  });
}

function compareNativePreviewRowByTime(a: NativeSessionPreviewRow, b: NativeSessionPreviewRow): number {
  if (a.created_at !== b.created_at) {
    return a.created_at - b.created_at;
  }
  return a.id.localeCompare(b.id);
}

function mergeNativePreviewRows(
  ...groups: Array<NativeSessionPreviewRow[] | null | undefined>
): NativeSessionPreviewRow[] {
  const merged = new Map<string, NativeSessionPreviewRow>();
  for (const group of groups) {
    for (const row of group || []) {
      if (!row?.id) {
        continue;
      }
      merged.set(row.id, row);
    }
  }
  return [...merged.values()].sort(compareNativePreviewRowByTime);
}

function pickEntriesBySyncStrategyPerSession(
  entries: EntryRecord[],
  strategy: SyncStrategy,
  activeSessionId: string
): EntryRecord[] {
  if (!entries.length) {
    return [];
  }
  const grouped = new Map<string, EntryRecord[]>();
  for (const entry of entries) {
    const sid = resolveEntrySessionId(entry, activeSessionId) || SYNC_UNKNOWN_SESSION_ID;
    const list = grouped.get(sid);
    if (list) {
      list.push(entry);
    } else {
      grouped.set(sid, [entry]);
    }
  }
  const merged: EntryRecord[] = [];
  for (const list of grouped.values()) {
    const sorted = [...list].sort(compareEntryByTime);
    const picked = pickEntriesBySyncStrategy(sorted, strategy);
    merged.push(...picked);
  }
  merged.sort(compareEntryByTime);
  return merged;
}

function collectSyncSelectableSessionEntries(
  entries: EntryRecord[],
  sessionId: string,
  activeSessionId: string,
  strategy: SyncStrategy,
  previewKind: SyncPreviewKind,
  keyword: string
): EntryRecord[] {
  const sid = sessionId.trim();
  if (!sid) {
    return [];
  }
  const sessionEntries = entries.filter((entry) => resolveEntrySessionId(entry, activeSessionId) === sid);
  const scoped = pickEntriesBySyncStrategyPerSession(sessionEntries, strategy, activeSessionId);
  return scoped.filter((entry) => matchesSyncPreviewFilter(entry, previewKind, keyword));
}

function syncStrategyLabel(strategy: SyncStrategy): string {
  if (strategy === "turn_1") {
    return "最近 1 轮";
  }
  if (strategy === "turn_3") {
    return "最近 3 轮";
  }
  if (strategy === "turn_5") {
    return "最近 5 轮";
  }
  if (strategy === "latest_qa") {
    return "最新一问一答";
  }
  return "全部记录";
}

function syncProgressText(stage: SyncProgressStage): string {
  if (stage === "importing") {
    return "正在导入会话历史...";
  }
  if (stage === "filtering") {
    return "正在筛选待同步记录...";
  }
  if (stage === "syncing") {
    return "正在发送到目标窗格...";
  }
  if (stage === "done") {
    return "同步已完成";
  }
  if (stage === "error") {
    return "同步失败";
  }
  return "等待操作";
}

function matchesSyncPreviewFilter(entry: EntryRecord, previewKind: SyncPreviewKind, keyword: string): boolean {
  if (previewKind === "input" && entry.kind !== "input") {
    return false;
  }
  if (previewKind === "output" && entry.kind !== "output") {
    return false;
  }
  if (!keyword) {
    return true;
  }
  return entry.content.toLowerCase().includes(keyword);
}

function normalizeHexColor(value: string, fallback = DEFAULT_SKIN_ACCENT): string {
  const text = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(text)) {
    return text.toLowerCase();
  }
  if (/^[0-9a-fA-F]{6}$/.test(text)) {
    return `#${text.toLowerCase()}`;
  }
  return fallback;
}

function normalizeThemePreset(value: string): string {
  const preset = value.trim().toLowerCase();
  if (["ocean", "forest", "sunset", "graphite", "custom"].includes(preset)) {
    return preset;
  }
  return DEFAULT_THEME_PRESET;
}

function normalizeColorMode(value: string | null | undefined): UiColorMode {
  if (value === "dark" || value === "light" || value === "system") {
    return value;
  }
  return "system";
}

function normalizeAvatarPath(value: string | null | undefined, fallback: string): string {
  const text = (value || "").trim();
  return text || fallback;
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  if (typeof document === "undefined") {
    throw new Error("clipboard is unavailable");
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  const copied = document.execCommand("copy");
  document.body.removeChild(textarea);
  if (!copied) {
    throw new Error("clipboard copy failed");
  }
}

function sanitizeSyncPlainTextContent(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/^\s*>+\s?/, "").trimEnd())
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return false;
      }
      if (trimmed === "```" || trimmed === "..." || trimmed === "{" || trimmed === "}") {
        return false;
      }
      if (/^https?:\/\/ipc\.localhost\//i.test(trimmed)) {
        return false;
      }
      if (/^[{}\[\],]+$/.test(trimmed)) {
        return false;
      }
      if (/^"[A-Za-z0-9_\-]+"\s*:\s*.+,?$/.test(trimmed)) {
        return false;
      }
      return true;
    })
    .join("\n")
    .trim();
}

function isDirectAvatarSrc(path: string, fallbackToken: string): boolean {
  const normalized = path.trim();
  if (!normalized || normalized === fallbackToken) {
    return false;
  }
  if (/^https?:\/\//i.test(normalized) || normalized.startsWith("asset:") || normalized.startsWith("data:")) {
    return true;
  }
  return false;
}

function resolveEffectiveColorMode(mode: UiColorMode): "dark" | "light" {
  if (mode === "dark" || mode === "light") {
    return mode;
  }
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return "dark";
}

function normalizeCompressConfig(value: unknown): CompressConfig {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_COMPRESS_CONFIG };
  }
  const raw = value as Partial<CompressConfig>;
  const numberOr = (input: unknown, fallback: number, min: number, max: number) => {
    const num = Number(input);
    if (Number.isFinite(num)) {
      return Math.min(max, Math.max(min, Math.round(num)));
    }
    return fallback;
  };
  return {
    enabled: Boolean(raw.enabled),
    token_waterline: numberOr(raw.token_waterline, DEFAULT_COMPRESS_CONFIG.token_waterline, 800, 64000),
    turn_waterline: numberOr(raw.turn_waterline, DEFAULT_COMPRESS_CONFIG.turn_waterline, 1, 200),
    max_chars: numberOr(raw.max_chars, DEFAULT_COMPRESS_CONFIG.max_chars, 500, 64000),
    summary_chars: numberOr(raw.summary_chars, DEFAULT_COMPRESS_CONFIG.summary_chars, 200, 32000)
  };
}

function createPaneView(summary: PaneSummary): PaneView {
  return {
    ...summary,
    active_session_id: "",
    linked_session_ids: [],
    sid_checking: false,
    scan_running: false,
    scan_total_files: 0,
    scan_processed_files: 0,
    scan_changed_files: 0
  };
}

function createSendDialogState(): SendDialogState {
  return {
    open: false,
    pane_id: "",
    input: "",
    sending: false
  };
}

function createUnrecognizedFilePreviewDialogState(): UnrecognizedFilePreviewDialogState {
  return {
    open: false,
    loading: false,
    pane_id: "",
    file_path: "",
    reason: "",
    parse_errors: 0,
    scanned_units: 0,
    row_count: 0,
    session_id: "",
    started_at: 0,
    content: ""
  };
}

function createUnrecognizedFilesModalState(): UnrecognizedFilesModalState {
  return {
    open: false,
    loading: false,
    items: []
  };
}

function createCreatePaneDialogState(
  provider = "codex",
  parserProfiles: SessionParserProfileSummary[] = [],
  teamDirectory = "",
  teamRoleCount = 2
): CreatePaneDialogState {
  const normalizedProvider = provider.trim().toLowerCase();
  const presetProvider = isBuiltinProvider(normalizedProvider) ? normalizedProvider : "codex";
  const parsePreset = normalizeSessionParsePreset(presetProvider);
  return {
    open: false,
    creating: false,
    provider_mode: isBuiltinProvider(normalizedProvider) ? "preset" : "custom",
    provider: presetProvider,
    custom_provider: isBuiltinProvider(normalizedProvider) ? "" : normalizedProvider,
    title_mode: "auto",
    custom_title: "",
    team_directory: teamDirectory,
    team_role_count: Math.max(1, Math.min(20, Math.round(teamRoleCount || 2))),
    session_parse_preset: parsePreset,
    session_scan_glob: normalizeSessionScanGlobInput(
      defaultSessionScanGlobByPreset(parsePreset, parserProfiles)
    ),
    session_parse_json: ""
  };
}

function createSessionManageDialogState(): SessionManageDialogState {
  return {
    open: false,
    pane_id: "",
    active_session_id: "",
    linked_session_ids: [],
    saving: false,
    view_mode: "manage"
  };
}

function createSessionManagePreviewState(): SessionManagePreviewState {
  return {
    preview_session_id: "",
    preview_loading: false,
    preview_rows: [],
    preview_total_rows: 0,
    preview_loaded_rows: 0,
    preview_has_more: false,
    preview_from_end: true
  };
}

function createSessionListDialogState(): SessionListDialogState {
  return {
    open: false,
    pane_id: "",
    loading: false,
    loading_more: false,
    all_items: [],
    items: [],
    total: 0,
    offset: 0,
    limit: DEFAULT_SESSION_LIST_LIMIT,
    has_more: false,
    selected_row_keys: [],
    sort_mode: "updated_desc",
    sid_keyword: "",
    time_from: "",
    time_to: "",
    quick_time_preset: "",
    records_min: null,
    records_max: null,
    preview_session_id: "",
    preview_loading: false,
    preview_rows: [],
    preview_total_rows: 0,
    preview_loaded_rows: 0,
    preview_has_more: false,
    preview_from_end: true,
    preview_auto_refresh: false,
    preview_panel_height: DEFAULT_INLINE_PREVIEW_PANEL_HEIGHT,
    unrecognized_files: []
  };
}

function createSyncSessionListState(paneId = ""): SyncSessionListState {
  return {
    pane_id: paneId,
    loading: false,
    all_items: [],
    items: [],
    total: 0,
    limit: DEFAULT_SESSION_LIST_LIMIT,
    sort_mode: "updated_desc",
    sid_keyword: "",
    time_from: "",
    time_to: "",
    quick_time_preset: "",
    records_min: null,
    records_max: null
  };
}

function createSyncDialogPreviewState(): SyncDialogPreviewState {
  return {
    preview_session_id: "",
    preview_loading: false,
    preview_rows: [],
    preview_total_rows: 0,
    preview_loaded_rows: 0,
    preview_has_more: false,
    preview_from_end: false
  };
}

function createSyncDialogState(): SyncDialogState {
  return {
    open: false,
    pane_id: "",
    loading: false,
    importing: false,
    syncing: false,
    target_pane_id: "",
    preview_session_id: "",
    strategy: "turn_3",
    selected_session_ids: [],
    included_entry_ids: [],
    excluded_entry_ids: [],
    preview_query: "",
    preview_kind: "all",
    progress_stage: "idle",
    progress_percent: 0,
    progress_text: syncProgressText("idle"),
    entries: []
  };
}

function toSessionListFilterArgs(dialog: Pick<SessionListDialogState, "sid_keyword" | "time_from" | "time_to" | "records_min" | "records_max">) {
  return {
    sidKeyword: dialog.sid_keyword.trim(),
    timeFrom: parseDateTimeLocalToEpoch(dialog.time_from),
    timeTo: parseDateTimeLocalToEpoch(dialog.time_to),
    recordsMin: normalizeOptionalNonNegativeInt(dialog.records_min),
    recordsMax: normalizeOptionalNonNegativeInt(dialog.records_max)
  };
}

function groupSessionCandidates(
  items: NativeSessionCandidate[],
  activeSessionId: string,
  linkedSessionIds: string[]
): { current: NativeSessionCandidate[]; linked: NativeSessionCandidate[]; unlinked: NativeSessionCandidate[] } {
  const active = activeSessionId.trim();
  const linkedSet = new Set(parseSessionIds(linkedSessionIds));
  const current: NativeSessionCandidate[] = [];
  const linked: NativeSessionCandidate[] = [];
  const unlinked: NativeSessionCandidate[] = [];
  for (const item of items) {
    const sid = item.session_id.trim();
    if (active && sid === active) {
      current.push(item);
      continue;
    }
    if (linkedSet.has(sid)) {
      linked.push(item);
      continue;
    }
    unlinked.push(item);
  }
  return { current, linked, unlinked };
}

function createSyntheticBoundSessionCandidate(
  sessionId: string,
  kind: "current" | "linked"
): NativeSessionCandidate {
  const label = kind === "current" ? "当前 SID" : "关联 SID";
  return {
    provider: "",
    session_id: sessionId.trim(),
    started_at: 0,
    last_seen_at: 0,
    source_files: 0,
    record_count: 0,
    first_input: `${label} 已绑定，但当前扫描结果里还没有发现这个会话。通常是会话尚未落盘，或索引还没刷新到。`,
    synthetic: true,
    synthetic_reason: "未入索引"
  };
}

function groupSessionCandidatesForManage(
  items: NativeSessionCandidate[],
  activeSessionId: string,
  linkedSessionIds: string[]
): { current: NativeSessionCandidate[]; linked: NativeSessionCandidate[]; unlinked: NativeSessionCandidate[] } {
  const grouped = groupSessionCandidates(items, activeSessionId, linkedSessionIds);
  const active = activeSessionId.trim();
  const linked = parseSessionIds(linkedSessionIds);
  const indexedSet = new Set(items.map((item) => item.session_id.trim()).filter(Boolean));

  if (active && !indexedSet.has(active)) {
    grouped.current = [createSyntheticBoundSessionCandidate(active, "current"), ...grouped.current];
  }

  const missingLinked = linked
    .filter((sessionId) => sessionId && sessionId !== active && !indexedSet.has(sessionId))
    .map((sessionId) => createSyntheticBoundSessionCandidate(sessionId, "linked"));
  if (missingLinked.length) {
    grouped.linked = [...missingLinked, ...grouped.linked];
  }

  return grouped;
}

function App() {
  const [messageApi, contextHolder] = message.useMessage();
  const currentWebviewWindow = getCurrentWebviewWindow();
  const currentWebviewLabel = currentWebviewWindow.label;
  const [route, setRoute] = useState<AppRoute>(() => resolveAppRoute());
  const [standaloneSessionPreviewPaneId, setStandaloneSessionPreviewPaneId] = useState(() =>
    typeof window !== "undefined" ? resolveStandaloneSessionPreviewPaneIdFromSearch(window.location.search) : ""
  );
  const isTeamRoute = route === "team";
  const isAiTeamRoute = route === "ai-team";
  const isCollabRoute = route === "collab";
  const isFavoritesRoute = route === "favorites";
  const isStandaloneCollabWindow =
    isCollabRoute && currentWebviewLabel === STANDALONE_COLLAB_WORKBENCH_WINDOW_LABEL;
  const isStandaloneSessionPreviewRoute = route === "session-preview";
  const isWorkspaceLikeRoute = route === "workspace" || route === "team";
  const [loading, setLoading] = useState(true);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("vertical");
  const [providers, setProviders] = useState<Provider[]>(FALLBACK_PROVIDERS);
  const [sessionParserProfiles, setSessionParserProfiles] = useState<SessionParserProfileSummary[]>([]);
  const [panes, setPanes] = useState<PaneView[]>([]);
  const [activePaneId, setActivePaneId] = useState("");

  const navigateTo = useCallback((target: AppRoute) => {
    const path =
      target === "team"
        ? "/team"
        : target === "ai-team"
          ? "/ai-team"
          : target === "collab"
            ? "/collab"
            : target === "favorites"
              ? "/favorites"
              : target === "session-preview"
                ? "/session-preview"
                : "/";
    const currentPath = normalizeAppPathname(window.location.pathname);
    if (currentPath !== path) {
      try {
        window.history.pushState({}, "", `${path}${window.location.search || ""}`);
      } catch {
        window.location.hash = path === "/" ? "#/" : `#${path}`;
      }
    }
    setRoute(target);
  }, []);

  const [configOpen, setConfigOpen] = useState(false);
  const [configTab, setConfigTab] = useState("theme");

  const [uiThemePreset, setUiThemePreset] = useState(DEFAULT_THEME_PRESET);
  const [uiSkinHue, setUiSkinHue] = useState(DEFAULT_SKIN_HUE);
  const [uiSkinAccent, setUiSkinAccent] = useState(DEFAULT_SKIN_ACCENT);
  const [isCompactViewport, setIsCompactViewport] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth <= 960 : false
  );
  const [uiColorMode, setUiColorMode] = useState<UiColorMode>(() =>
    normalizeColorMode(localStorage.getItem(STORAGE_COLOR_MODE_KEY))
  );
  const [savingTheme, setSavingTheme] = useState(false);
  const [userAvatarPath, setUserAvatarPath] = useState(DEFAULT_USER_AVATAR_TOKEN);
  const [assistantAvatarPath, setAssistantAvatarPath] = useState(DEFAULT_ASSISTANT_AVATAR_TOKEN);
  const [userAvatarSrc, setUserAvatarSrc] = useState(defaultUserAvatar);
  const [assistantAvatarSrc, setAssistantAvatarSrc] = useState(defaultAssistantAvatar);
  const [savingAvatars, setSavingAvatars] = useState(false);

  const [workingDirectory, setWorkingDirectory] = useState("");
  const [configPath, setConfigPath] = useState("");
  const [applyingWorkdir, setApplyingWorkdir] = useState(false);

  const [compressConfig, setCompressConfig] = useState<CompressConfig>(() => {
    const raw = localStorage.getItem(STORAGE_COMPRESS_KEY);
    if (!raw) {
      return { ...DEFAULT_COMPRESS_CONFIG };
    }
    try {
      return normalizeCompressConfig(JSON.parse(raw));
    } catch {
      return { ...DEFAULT_COMPRESS_CONFIG };
    }
  });

  useEffect(() => {
    const handleLocationChange = () => {
      setRoute(resolveAppRoute());
      setStandaloneSessionPreviewPaneId(resolveStandaloneSessionPreviewPaneIdFromSearch(window.location.search));
    };
    window.addEventListener("hashchange", handleLocationChange);
    window.addEventListener("popstate", handleLocationChange);
    return () => {
      window.removeEventListener("hashchange", handleLocationChange);
      window.removeEventListener("popstate", handleLocationChange);
    };
  }, []);

  useEffect(() => {
    const handleResize = () => {
      setIsCompactViewport(window.innerWidth <= 960);
    };
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    if (route !== "ai-team" && route !== "collab") {
      setWorkbenchHeaderActions(null);
    }
  }, [route]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (route === "session-preview") {
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "t") {
        event.preventDefault();
        const nextRoute = route === "team" ? "workspace" : "team";
        navigateTo(nextRoute);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [navigateTo, route]);

  const [createPaneDialog, setCreatePaneDialog] = useState<CreatePaneDialogState>(() =>
    createCreatePaneDialogState(FALLBACK_PROVIDERS[0], [])
  );
  const [createPanePathTarget, setCreatePanePathTarget] = useState<CreatePanePathTarget>(
    "rule_content_text_paths"
  );
  const [createPaneSamplePreview, setCreatePaneSamplePreview] = useState<CreatePaneSamplePreviewState>({
    loading: false,
    error: "",
    parser_profile: "",
    file_path: "",
    file_format: "",
    sample_value: null,
    message_sample_value: null
  });
  const [createPaneSampleViewMode, setCreatePaneSampleViewMode] = useState<CreatePaneSampleViewMode>("root");
  const [sendDialog, setSendDialog] = useState<SendDialogState>(() => createSendDialogState());
  const [unrecognizedFilePreviewDialog, setUnrecognizedFilePreviewDialog] =
    useState<UnrecognizedFilePreviewDialogState>(() => createUnrecognizedFilePreviewDialogState());
  const [unrecognizedFilesModal, setUnrecognizedFilesModal] = useState<UnrecognizedFilesModalState>(() =>
    createUnrecognizedFilesModalState()
  );
  const [sessionManageDialog, setSessionManageDialog] = useState<SessionManageDialogState>(() =>
    createSessionManageDialogState()
  );
  const [sessionManageGroupTab, setSessionManageGroupTab] = useState<SessionManageGroupTabKey>("current");
  const [syncDialogGroupTab, setSyncDialogGroupTab] = useState<SessionManageGroupTabKey>("current");
  const [sessionManageScanConfig, setSessionManageScanConfig] = useState<PaneScanConfig | null>(null);
  const [sessionManageReindexing, setSessionManageReindexing] = useState(false);
  const [sessionManagePreview, setSessionManagePreview] = useState<SessionManagePreviewState>(() =>
    createSessionManagePreviewState()
  );
  const [syncSessionListState, setSyncSessionListState] = useState<SyncSessionListState>(() =>
    createSyncSessionListState()
  );
  const [syncDialogPreview, setSyncDialogPreview] = useState<SyncDialogPreviewState>(() =>
    createSyncDialogPreviewState()
  );
  const [favoriteMessages, setFavoriteMessages] = useState<FavoriteMessageRecord[]>([]);
  const [previewOverlaySource, setPreviewOverlaySource] = useState<PreviewOverlaySource | null>(null);
  const [sessionManagePreviewScrollCommand, setSessionManagePreviewScrollCommand] =
    useState<SyncEntryPreviewScrollCommand | null>(null);
  const [syncDialogPreviewScrollCommand, setSyncDialogPreviewScrollCommand] =
    useState<SyncEntryPreviewScrollCommand | null>(null);
  const [sessionManageHighlightedMessageId, setSessionManageHighlightedMessageId] = useState("");
  const [syncShowSelectedOnly, setSyncShowSelectedOnly] = useState(false);
  const [clearingAllSid, setClearingAllSid] = useState(false);
  const [workbenchHeaderActions, setWorkbenchHeaderActions] = useState<AiTeamWorkbenchHeaderActions | null>(null);
  const [standaloneSessionPreviewAlwaysOnTop, setStandaloneSessionPreviewAlwaysOnTop] = useState(() =>
    readStandaloneSessionPreviewAlwaysOnTopPreference()
  );
  const [standaloneSessionPreviewCompactMode, setStandaloneSessionPreviewCompactMode] = useState(false);
  const standaloneSessionPreviewAutoRefreshRunningRef = useRef(false);
  const standaloneSessionPreviewRestoreSizeRef = useRef<{ width: number; height: number } | null>(null);
  const sessionManagePreviewTicketRef = useRef(0);
  const syncDialogPreviewTicketRef = useRef(0);
  const syncDialogEntryCacheRef = useRef<Map<string, EntryRecord[]>>(new Map());
  const [sessionListPanels, setSessionListPanels] = useState<Record<string, SessionListDialogState>>({});
  const sessionListPanelsRef = useRef<Record<string, SessionListDialogState>>({});
  const sessionPreviewFollowBottomRef = useRef<Map<string, boolean>>(new Map());
  const sessionListLoadTicketRef = useRef<Map<string, number>>(new Map());
  const sessionPreviewLoadTicketRef = useRef<Map<string, number>>(new Map());
  const paneSessionIndexSyncTicketRef = useRef<Map<string, number>>(new Map());
  const reloadSessionListDialogRef = useRef<
    | null
    | ((
        paneId: string,
        overrides?: Partial<
          Pick<
            SessionListDialogState,
            "sid_keyword" | "time_from" | "time_to" | "quick_time_preset" | "records_min" | "records_max"
          >
        >,
        requestOptions?: {
          fullLoad?: boolean;
          keepPanelClosed?: boolean;
        }
      ) => Promise<void>)
  >(null);
  const [syncDialog, setSyncDialog] = useState<SyncDialogState>(() => createSyncDialogState());

  const terminalsRef = useRef<Map<string, PaneTerminal>>(new Map());
  const paneOutputProbeRef = useRef<Map<string, PaneOutputProbeState>>(new Map());
  const sidProbeTokenRef = useRef<Map<string, number>>(new Map());
  const paneSplitContainerRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const panePreviewResizeStateRef = useRef<PanePreviewResizeState | null>(null);
  const panePreviewAutoRefreshTimerRef = useRef<Map<string, number>>(new Map());
  const panePreviewAutoRefreshRunningRef = useRef<Set<string>>(new Set());
  const sessionManageAutoRefreshTimerRef = useRef<number | null>(null);
  const sessionManageAutoRefreshRunningRef = useRef(false);
  const queuePanePreviewAutoRefreshRef = useRef<(paneId: string) => void>(() => {});
  const queueSessionManageAutoRefreshRef = useRef<(paneId: string) => void>(() => {});
  const terminalRefCallbacks = useRef<Map<string, (element: HTMLDivElement | null) => void>>(new Map());
  const createPaneSampleTicketRef = useRef(0);
  const sessionPanelBootRef = useRef(false);
  const sessionPanelPersistReadyRef = useRef(false);

  const createPaneParserId = useMemo(
    () =>
      createPaneDialog.provider_mode === "preset"
        ? normalizeSessionParsePreset(createPaneDialog.provider)
        : normalizeSessionParsePreset(createPaneDialog.custom_provider.trim() || "custom-model"),
    [
      createPaneDialog.custom_provider,
      createPaneDialog.provider,
      createPaneDialog.provider_mode,
      createPaneDialog.session_parse_preset
    ]
  );

  const createPaneParserEditor = useMemo<Record<string, unknown>>(() => {
    const base = normalizeSessionParserConfigForEditor(
      createPaneDialog.session_parse_json,
      createPaneParserId
    );
    const preferredGlob = (() => {
      const manual = createPaneDialog.session_scan_glob.trim();
      if (manual) {
        return manual;
      }
      if (createPaneDialog.provider_mode === "custom") {
        return "";
      }
      return (
        String(base.default_file_glob ?? "").trim() ||
        defaultSessionScanGlobByPreset(createPaneParserId, sessionParserProfiles)
      );
    })();
    const preferredRoots = toStringList(base.source_roots);
    return {
      ...base,
      id: createPaneParserId,
      name: `${asTitle(createPaneParserId)} Parser`,
      source_roots: preferredRoots.length ? preferredRoots : [defaultSessionSourceRootToken(createPaneParserId)],
      default_file_glob: preferredGlob,
      file_format: inferSessionFileFormatByGlob(preferredGlob, createPaneParserId === "gemini" ? "json" : "jsonl")
    };
  }, [
    createPaneDialog.session_parse_json,
    createPaneDialog.session_scan_glob,
    createPaneParserId,
    sessionParserProfiles
  ]);

  const createPaneParserConfigPreview = useMemo(
    () => buildSessionParserConfigFromEditor(createPaneParserEditor),
    [createPaneParserEditor]
  );
  const createPaneDetectedFileFormat = useMemo(() => {
    const fromGlob = inferSessionFileFormatLabelByGlob(createPaneDialog.session_scan_glob.trim());
    if (fromGlob !== "未识别") {
      return fromGlob;
    }
    if (createPaneDialog.provider_mode === "preset") {
      return String(createPaneParserConfigPreview.file_format || "未识别");
    }
    return "未识别";
  }, [
    createPaneDialog.provider_mode,
    createPaneDialog.session_scan_glob,
    createPaneParserConfigPreview.file_format
  ]);
  const createPaneDisplayedSampleValue =
    createPaneSampleViewMode === "message" && createPaneSamplePreview.message_sample_value
      ? createPaneSamplePreview.message_sample_value
      : createPaneSamplePreview.sample_value;
  const renderCreatePanePathFieldTitle = useCallback(
    (label: string, target: CreatePanePathTarget) => (
      <Space size={8} wrap>
        <Typography.Text strong>{label}</Typography.Text>
        <Button
          size="small"
          type={createPanePathTarget === target ? "primary" : "default"}
          onClick={() => setCreatePanePathTarget(target)}
        >
          {isCreatePanePathTargetMulti(target) ? "追加路径" : "选择路径"}
        </Button>
      </Space>
    ),
    [createPanePathTarget]
  );
  const createPaneParserJsonPreview = useMemo(
    () => JSON.stringify(createPaneParserConfigPreview, null, 2),
    [createPaneParserConfigPreview]
  );
  const createPaneParserJsonPreviewRef = useRef(createPaneParserJsonPreview);

  useEffect(() => {
    createPaneParserJsonPreviewRef.current = createPaneParserJsonPreview;
  }, [createPaneParserJsonPreview]);

  const updateCreatePaneParserEditor = useCallback((patch: Partial<Record<string, unknown>>) => {
    setCreatePaneDialog((current) => {
      const parserId =
        current.provider_mode === "preset"
          ? normalizeSessionParsePreset(current.provider)
          : normalizeSessionParsePreset(current.custom_provider.trim() || "custom-model");
      const editor = normalizeSessionParserConfigForEditor(current.session_parse_json, parserId);
      const preferredGlob = (() => {
        const manual = current.session_scan_glob.trim();
        if (manual) {
          return manual;
        }
        if (current.provider_mode === "custom") {
          return "";
        }
        return (
          String(editor.default_file_glob ?? "").trim() ||
          defaultSessionScanGlobByPreset(parserId, sessionParserProfiles)
        );
      })();
      const preferredRoots = toStringList(editor.source_roots);
      const nextEditor = {
        ...editor,
        ...patch,
        id: parserId,
        name: `${asTitle(parserId)} Parser`,
        source_roots: preferredRoots.length ? preferredRoots : [defaultSessionSourceRootToken(parserId)],
        default_file_glob: preferredGlob,
        file_format: inferSessionFileFormatByGlob(preferredGlob, parserId === "gemini" ? "json" : "jsonl")
      };
      const nextConfig = buildSessionParserConfigFromEditor(nextEditor);
      const nextText = JSON.stringify(nextConfig, null, 2);
      return {
        ...current,
        session_parse_preset: parserId,
        session_parse_json: nextText
      };
    });
  }, [sessionParserProfiles]);

  const applyCreatePanePathToTarget = useCallback(
    (pathTokens: JsonPathToken[]) => {
      const parserPath = jsonPathTokensToParserPath(pathTokens);
      if (!parserPath) {
        return;
      }
      if (createPanePathTarget === "session_id_paths") {
        updateCreatePaneParserEditor({
          session_id_paths: appendUniquePath(createPaneParserEditor.session_id_paths, parserPath)
        });
        return;
      }
      if (createPanePathTarget === "started_at_paths") {
        updateCreatePaneParserEditor({
          started_at_paths: appendUniquePath(createPaneParserEditor.started_at_paths, parserPath)
        });
        return;
      }
      if (createPanePathTarget === "rule_content_text_paths") {
        updateCreatePaneParserEditor({
          rule_content_text_paths: appendUniquePath(createPaneParserEditor.rule_content_text_paths, parserPath)
        });
        return;
      }
      if (createPanePathTarget === "rule_timestamp_paths") {
        updateCreatePaneParserEditor({
          rule_timestamp_paths: appendUniquePath(createPaneParserEditor.rule_timestamp_paths, parserPath)
        });
        return;
      }
      if (createPanePathTarget === "rule_role_path") {
        updateCreatePaneParserEditor({ rule_role_path: parserPath });
        return;
      }
      if (createPanePathTarget === "message_source_path") {
        updateCreatePaneParserEditor({ message_source_path: parserPath });
        return;
      }
      if (createPanePathTarget === "rule_content_item_path") {
        updateCreatePaneParserEditor({ rule_content_item_path: parserPath });
        return;
      }
      updateCreatePaneParserEditor({ rule_content_item_filter_path: parserPath });
    },
    [createPaneParserEditor, createPanePathTarget, updateCreatePaneParserEditor]
  );

  const loadCreatePaneSamplePreview = useCallback(async () => {
    if (!createPaneDialog.open) {
      return;
    }
    const fileGlob = createPaneDialog.session_scan_glob.trim();
    if (!fileGlob) {
      setCreatePaneSamplePreview((current) => ({
        ...current,
        loading: false,
        error: "",
        parser_profile: "",
        file_path: "",
        file_format: "",
        sample_value: null,
        message_sample_value: null
      }));
      return;
    }
    const ticket = ++createPaneSampleTicketRef.current;
    setCreatePaneSamplePreview((current) => ({
      ...current,
      loading: true,
      error: ""
    }));
    try {
      const response = await invoke<SessionParserSamplePreviewResponse>("preview_session_parser_sample", {
        parserProfile: createPaneParserId,
        parserConfigText:
          createPaneDialog.provider_mode === "custom" ? createPaneParserJsonPreviewRef.current : null,
        fileGlob
      });
      if (createPaneSampleTicketRef.current !== ticket) {
        return;
      }
      setCreatePaneSamplePreview({
        loading: false,
        error: "",
        parser_profile: response.parser_profile || createPaneParserId,
        file_path: response.file_path || "",
        file_format: response.file_format || "",
        sample_value: response.sample_value ?? null,
        message_sample_value: response.message_sample_value ?? null
      });
      setCreatePaneSampleViewMode(response.message_sample_value ? "message" : "root");
    } catch (error) {
      if (createPaneSampleTicketRef.current !== ticket) {
        return;
      }
      const detail = error instanceof Error ? error.message : String(error || "");
      setCreatePaneSamplePreview((current) => ({
        ...current,
        loading: false,
        error: detail || "样本加载失败"
      }));
    }
  }, [
    createPaneDialog.open,
    createPaneDialog.provider_mode,
    createPaneDialog.session_scan_glob,
    createPaneParserId
  ]);

  useEffect(() => {
    if (!createPaneDialog.open) {
      return;
    }
    const timer = window.setTimeout(() => {
      void loadCreatePaneSamplePreview();
    }, 420);
    return () => window.clearTimeout(timer);
  }, [
    createPaneDialog.open,
    createPaneDialog.provider_mode,
    createPaneDialog.session_scan_glob,
    createPaneParserId,
    loadCreatePaneSamplePreview
  ]);

  const effectiveColorMode = useMemo(() => resolveEffectiveColorMode(uiColorMode), [uiColorMode]);

  const antdThemeConfig = useMemo(
    () => ({
      algorithm: effectiveColorMode === "dark" ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
      token: {
        colorPrimary: normalizeHexColor(uiSkinAccent),
        borderRadius: 10,
        colorBgLayout: effectiveColorMode === "dark" ? `hsl(${uiSkinHue} 22% 10%)` : `hsl(${uiSkinHue} 65% 97%)`
      }
    }),
    [effectiveColorMode, uiSkinAccent, uiSkinHue]
  );

  const headerStyle = useMemo(
    () => ({
      background: effectiveColorMode === "dark" ? `hsl(${uiSkinHue} 26% 14%)` : `hsl(${uiSkinHue} 75% 95%)`,
      borderBottom:
        effectiveColorMode === "dark" ? "1px solid rgba(148, 163, 184, 0.24)" : "1px solid rgba(15, 23, 42, 0.12)"
    }),
    [effectiveColorMode, uiSkinHue]
  );

  const activePane = useMemo(
    () => panes.find((pane) => pane.id === activePaneId) ?? panes[0] ?? null,
    [activePaneId, panes]
  );

  const syncDialogPane = useMemo(
    () => panes.find((pane) => pane.id === syncDialog.pane_id) ?? null,
    [panes, syncDialog.pane_id]
  );
  const syncDialogSessionListState = syncSessionListState;
  const syncDialogCurrentSessionId = syncDialogPane?.active_session_id.trim() ?? "";
  const syncDialogLinkedSessionIds = useMemo(
    () =>
      parseSessionIds(syncDialogPane?.linked_session_ids ?? []).filter(
        (sid) => sid !== syncDialogCurrentSessionId
      ),
    [syncDialogCurrentSessionId, syncDialogPane?.linked_session_ids]
  );
  const syncDialogAllSessionIds = useMemo(
    () =>
      parseSessionIds(
        syncDialogSessionListState.items.length
          ? syncDialogSessionListState.items.map((item) => item.session_id)
          : [syncDialogCurrentSessionId, ...syncDialogLinkedSessionIds]
      ),
    [syncDialogCurrentSessionId, syncDialogLinkedSessionIds, syncDialogSessionListState.items]
  );
  const syncDialogAllSessionSet = useMemo(
    () => new Set(syncDialogAllSessionIds),
    [syncDialogAllSessionIds]
  );
  const syncDialogSelectedSessionSet = useMemo(
    () => new Set(syncDialog.selected_session_ids),
    [syncDialog.selected_session_ids]
  );
  const syncDialogFilterKeyword = useMemo(
    () => syncDialog.preview_query.trim().toLowerCase(),
    [syncDialog.preview_query]
  );
  const syncDialogEntriesAllSessions = useMemo(() => {
    if (!syncDialogAllSessionSet.size) {
      return [];
    }
    return syncDialog.entries.filter((entry) => {
      const sid = resolveEntrySessionId(entry, syncDialogCurrentSessionId);
      return sid ? syncDialogAllSessionSet.has(sid) : false;
    });
  }, [syncDialog.entries, syncDialogAllSessionSet, syncDialogCurrentSessionId]);
  const syncDialogScopedEntriesAllSessions = useMemo(
    () => pickEntriesBySyncStrategyPerSession(syncDialogEntriesAllSessions, syncDialog.strategy, syncDialogCurrentSessionId),
    [syncDialogCurrentSessionId, syncDialogEntriesAllSessions, syncDialog.strategy]
  );
  const syncDialogFilteredEntriesAllSessions = useMemo(
    () =>
      syncDialogScopedEntriesAllSessions.filter((entry) =>
        matchesSyncPreviewFilter(entry, syncDialog.preview_kind, syncDialogFilterKeyword)
      ),
    [syncDialog.preview_kind, syncDialogFilterKeyword, syncDialogScopedEntriesAllSessions]
  );
  const syncDialogEntriesBySession = useMemo(() => {
    if (!syncDialogSelectedSessionSet.size) {
      return [];
    }
    return syncDialog.entries.filter((entry) => {
      const sid = resolveEntrySessionId(entry, syncDialogCurrentSessionId);
      return sid ? syncDialogSelectedSessionSet.has(sid) : false;
    });
  }, [syncDialog.entries, syncDialogCurrentSessionId, syncDialogSelectedSessionSet]);
  const syncDialogScopedEntries = useMemo(
    () => pickEntriesBySyncStrategyPerSession(syncDialogEntriesBySession, syncDialog.strategy, syncDialogCurrentSessionId),
    [syncDialogCurrentSessionId, syncDialog.strategy, syncDialogEntriesBySession]
  );
  const syncDialogFilteredEntries = useMemo(
    () =>
      syncDialogScopedEntries.filter((entry) =>
        matchesSyncPreviewFilter(entry, syncDialog.preview_kind, syncDialogFilterKeyword)
      ),
    [syncDialog.preview_kind, syncDialogFilterKeyword, syncDialogScopedEntries]
  );
  const syncDialogExcludedSet = useMemo(
    () => new Set(syncDialog.excluded_entry_ids),
    [syncDialog.excluded_entry_ids]
  );
  const syncDialogIncludedSet = useMemo(
    () => new Set(syncDialog.included_entry_ids),
    [syncDialog.included_entry_ids]
  );
  const syncDialogManualSelectedSessionSet = useMemo(() => {
    const sessions = new Set<string>();
    for (const entry of syncDialog.entries) {
      if (!syncDialogIncludedSet.has(entry.id)) {
        continue;
      }
      const sid = resolveEntrySessionId(entry, syncDialogCurrentSessionId);
      if (sid) {
        sessions.add(sid);
      }
    }
    return sessions;
  }, [syncDialog.entries, syncDialogCurrentSessionId, syncDialogIncludedSet]);
  const syncDialogVisualSelectedSessionSet = useMemo(() => {
    const sessions = new Set(syncDialog.selected_session_ids);
    for (const sid of syncDialogManualSelectedSessionSet) {
      sessions.add(sid);
    }
    return sessions;
  }, [syncDialog.selected_session_ids, syncDialogManualSelectedSessionSet]);
  const syncDialogPreviewEntries = useMemo(
    () => syncDialogFilteredEntries.filter((entry) => !syncDialogExcludedSet.has(entry.id)),
    [syncDialogFilteredEntries, syncDialogExcludedSet]
  );
  const isSyncDialogEntryIncluded = useCallback(
    (entry: EntryRecord) => {
      const sessionId = resolveEntrySessionId(entry, syncDialogCurrentSessionId);
      if (sessionId && syncDialogSelectedSessionSet.has(sessionId)) {
        return !syncDialogExcludedSet.has(entry.id);
      }
      return syncDialogIncludedSet.has(entry.id);
    },
    [syncDialogCurrentSessionId, syncDialogExcludedSet, syncDialogIncludedSet, syncDialogSelectedSessionSet]
  );
  const syncDialogFilteredExcludedCount = useMemo(
    () => Math.max(0, syncDialogFilteredEntries.length - syncDialogPreviewEntries.length),
    [syncDialogFilteredEntries.length, syncDialogPreviewEntries.length]
  );
  const syncDialogPreviewSessionId = syncDialog.preview_session_id.trim();
  const syncDialogPreviewPanelEntries = useMemo(() => {
    if (!syncDialogPreviewSessionId) {
      return syncDialogFilteredEntries;
    }
    return syncDialogFilteredEntriesAllSessions.filter((entry) => {
      const sid = resolveEntrySessionId(entry, syncDialogCurrentSessionId);
      return sid === syncDialogPreviewSessionId;
    });
  }, [
    syncDialogCurrentSessionId,
    syncDialogFilteredEntries,
    syncDialogFilteredEntriesAllSessions,
    syncDialogPreviewSessionId
  ]);
  const syncDialogSessionGroups = useMemo<SyncSessionGroupStat[]>(() => {
    const groups = new Map<string, SyncSessionGroupStat>();
    const ensureGroup = (sessionId: string) => {
      const cached = groups.get(sessionId);
      if (cached) {
        return cached;
      }
      const group: SyncSessionGroupStat = {
        session_id: sessionId,
        all_count: 0,
        scoped_count: 0,
        total_count: 0,
        excluded_count: 0,
        pending_count: 0,
        selected: sessionId !== SYNC_UNKNOWN_SESSION_ID && syncDialogVisualSelectedSessionSet.has(sessionId),
        is_current: Boolean(syncDialogCurrentSessionId) && sessionId === syncDialogCurrentSessionId,
        first_at: 0,
        last_at: 0
      };
      groups.set(sessionId, group);
      return group;
    };
    for (const sid of syncDialogAllSessionIds) {
      ensureGroup(sid);
    }
    for (const entry of syncDialogEntriesAllSessions) {
      const sessionId = resolveEntrySessionId(entry, syncDialogCurrentSessionId) || SYNC_UNKNOWN_SESSION_ID;
      const group = ensureGroup(sessionId);
      group.all_count += 1;
      if (group.first_at <= 0 || entry.created_at < group.first_at) {
        group.first_at = entry.created_at;
      }
      if (entry.created_at > group.last_at) {
        group.last_at = entry.created_at;
      }
    }
    for (const entry of syncDialogScopedEntriesAllSessions) {
      const sessionId = resolveEntrySessionId(entry, syncDialogCurrentSessionId) || SYNC_UNKNOWN_SESSION_ID;
      const group = ensureGroup(sessionId);
      group.scoped_count += 1;
      if (entry.created_at > group.last_at) {
        group.last_at = entry.created_at;
      }
    }
    for (const entry of syncDialogFilteredEntriesAllSessions) {
      const sessionId = resolveEntrySessionId(entry, syncDialogCurrentSessionId) || SYNC_UNKNOWN_SESSION_ID;
      const group = ensureGroup(sessionId);
      group.total_count += 1;
      if (group.selected && syncDialogExcludedSet.has(entry.id)) {
        group.excluded_count += 1;
      }
      if (entry.created_at > group.last_at) {
        group.last_at = entry.created_at;
      }
    }
    const list = [...groups.values()].map((group) => {
      const pending = group.selected ? Math.max(0, group.total_count - group.excluded_count) : 0;
      return {
        ...group,
        pending_count: pending
      };
    });
    list.sort((a, b) => {
      if (a.is_current !== b.is_current) {
        return a.is_current ? -1 : 1;
      }
      if (a.selected !== b.selected) {
        return a.selected ? -1 : 1;
      }
      if (b.pending_count !== a.pending_count) {
        return b.pending_count - a.pending_count;
      }
      if (b.scoped_count !== a.scoped_count) {
        return b.scoped_count - a.scoped_count;
      }
      if (b.total_count !== a.total_count) {
        return b.total_count - a.total_count;
      }
      if (a.session_id === SYNC_UNKNOWN_SESSION_ID) {
        return 1;
      }
      if (b.session_id === SYNC_UNKNOWN_SESSION_ID) {
        return -1;
      }
      return a.session_id.localeCompare(b.session_id);
    });
    return list;
  }, [
    syncDialogAllSessionIds,
    syncDialogCurrentSessionId,
    syncDialogEntriesAllSessions,
    syncDialogExcludedSet,
    syncDialogFilteredEntriesAllSessions,
    syncDialogScopedEntriesAllSessions,
    syncDialogVisualSelectedSessionSet
  ]);
  const syncDialogSelectedSessionCount = useMemo(
    () => syncDialogVisualSelectedSessionSet.size,
    [syncDialogVisualSelectedSessionSet]
  );
  const syncDialogSessionItemMap = useMemo(
    () => new Map(syncDialogSessionListState.items.map((item) => [item.session_id, item])),
    [syncDialogSessionListState.items]
  );
  const syncDialogSelectedRecordCount = useMemo(
    () =>
      syncDialog.selected_session_ids.reduce(
        (sum, sessionId) => sum + Math.max(0, Number(syncDialogSessionItemMap.get(sessionId)?.record_count || 0)),
        0
      ),
    [syncDialog.selected_session_ids, syncDialogSessionItemMap]
  );
  const syncDialogExcludedSelectedCount = useMemo(
    () =>
      syncDialog.entries.reduce((sum, entry) => {
        const sessionId = resolveEntrySessionId(entry, syncDialogCurrentSessionId);
        if (!sessionId || !syncDialogSelectedSessionSet.has(sessionId) || !syncDialogExcludedSet.has(entry.id)) {
          return sum;
        }
        return sum + 1;
      }, 0),
    [syncDialog.entries, syncDialogCurrentSessionId, syncDialogExcludedSet, syncDialogSelectedSessionSet]
  );
  const syncDialogManualIncludedCount = useMemo(
    () => syncDialog.included_entry_ids.length,
    [syncDialog.included_entry_ids.length]
  );
  const syncDialogPendingEntryCount = useMemo(
    () =>
      Math.max(0, syncDialogSelectedRecordCount - syncDialogExcludedSelectedCount) +
      syncDialogManualIncludedCount,
    [syncDialogExcludedSelectedCount, syncDialogManualIncludedCount, syncDialogSelectedRecordCount]
  );
  const syncDialogIdleText = useMemo(() => {
    if (!syncDialogSelectedSessionCount) {
      return "等待操作：请先勾选会话";
    }
    return `等待操作：已选会话 ${syncDialogSelectedSessionCount} 个，待同步 ${syncDialogPendingEntryCount} 条`;
  }, [syncDialogPendingEntryCount, syncDialogSelectedSessionCount]);
  const syncDialogPreviewSelectionText = useMemo(() => {
    const previewSessionId = syncDialog.preview_session_id.trim();
    if (!previewSessionId) {
      return `已选会话汇总 · ${syncDialogSelectedSessionCount} 个会话 / ${syncDialogPendingEntryCount} 条消息`;
    }

    const total = Math.max(0, Number(syncDialogSessionItemMap.get(previewSessionId)?.record_count || 0));
    if (syncDialogVisualSelectedSessionSet.has(previewSessionId)) {
      const excludedCount = syncDialog.entries.reduce((sum, entry) => {
        if (
          resolveEntrySessionId(entry, syncDialogCurrentSessionId) !== previewSessionId ||
          !syncDialogExcludedSet.has(entry.id)
        ) {
          return sum;
        }
        return sum + 1;
      }, 0);
      const selectedCount = Math.max(0, total - excludedCount);
      if (selectedCount <= 0) {
        return "当前会话：已排空";
      }
      if (excludedCount <= 0) {
        return `当前会话：已全选 (${total})`;
      }
      return `当前会话：已选 ${selectedCount}/${total}`;
    }

    const manualIncludedCount = syncDialog.entries.reduce((sum, entry) => {
      if (
        resolveEntrySessionId(entry, syncDialogCurrentSessionId) !== previewSessionId ||
        !syncDialogIncludedSet.has(entry.id)
      ) {
        return sum;
      }
      return sum + 1;
    }, 0);
    if (manualIncludedCount > 0) {
      return `当前会话：仅选 ${manualIncludedCount} 条`;
    }
    return "当前会话：未选";
  }, [
    syncDialog.preview_session_id,
    syncDialog.entries,
    syncDialogCurrentSessionId,
    syncDialogExcludedSet,
    syncDialogIncludedSet,
    syncDialogPendingEntryCount,
    syncDialogSelectedSessionCount,
    syncDialogVisualSelectedSessionSet,
    syncDialogSessionItemMap
  ]);
  const getSyncDialogSessionSelectionBadge = useCallback(
    (sessionId: string): { text: string; color: string } | null => {
      const sid = sessionId.trim();
      if (!sid) {
        return null;
      }

      const total = Math.max(0, Number(syncDialogSessionItemMap.get(sid)?.record_count || 0));
      if (syncDialogVisualSelectedSessionSet.has(sid)) {
        const excludedCount = syncDialog.entries.reduce((sum, entry) => {
          if (resolveEntrySessionId(entry, syncDialogCurrentSessionId) !== sid || !syncDialogExcludedSet.has(entry.id)) {
            return sum;
          }
          return sum + 1;
        }, 0);
        const selectedCount = Math.max(0, total - excludedCount);
        if (selectedCount <= 0) {
          return { text: "已排空", color: "warning" };
        }
        if (excludedCount <= 0) {
          return { text: `已全选 ${total}`, color: "success" };
        }
        return { text: `已选 ${selectedCount}/${total}`, color: "processing" };
      }

      const manualIncludedCount = syncDialog.entries.reduce((sum, entry) => {
        if (resolveEntrySessionId(entry, syncDialogCurrentSessionId) !== sid || !syncDialogIncludedSet.has(entry.id)) {
          return sum;
        }
        return sum + 1;
      }, 0);
      if (manualIncludedCount > 0) {
        return { text: `仅选 ${manualIncludedCount}`, color: "gold" };
      }
      return null;
    },
    [
      syncDialog.entries,
      syncDialogCurrentSessionId,
      syncDialogExcludedSet,
      syncDialogIncludedSet,
      syncDialogVisualSelectedSessionSet,
      syncDialogSessionItemMap
    ]
  );
  const syncDialogProgressDisplayText =
    syncDialog.progress_stage === "idle" ? syncDialogIdleText : syncDialog.progress_text;
  const syncDialogTargetOptions = useMemo(
    () =>
      panes
        .filter((pane) => pane.id !== syncDialog.pane_id)
        .map((pane) => ({
          value: pane.id,
          label: `${asTitle(pane.provider)} · ${pane.title || shortSessionId(pane.id)}`
        })),
    [panes, syncDialog.pane_id]
  );
  const sessionManagePane = useMemo(
    () => panes.find((pane) => pane.id === sessionManageDialog.pane_id) ?? null,
    [panes, sessionManageDialog.pane_id]
  );
  const sessionManagePaneId = sessionManageDialog.pane_id.trim();
  const sessionManageListState = useMemo(
    () =>
      sessionManageDialog.pane_id
        ? sessionListPanels[sessionManageDialog.pane_id] ?? {
            ...createSessionListDialogState(),
            pane_id: sessionManageDialog.pane_id
          }
        : null,
    [sessionListPanels, sessionManageDialog.pane_id]
  );
  const standaloneSessionPreviewPane = useMemo(
    () => panes.find((pane) => pane.id === standaloneSessionPreviewPaneId) ?? null,
    [panes, standaloneSessionPreviewPaneId]
  );
  const standaloneSessionPreviewListState = useMemo(
    () =>
      standaloneSessionPreviewPaneId
        ? sessionListPanels[standaloneSessionPreviewPaneId] ?? {
            ...createSessionListDialogState(),
            pane_id: standaloneSessionPreviewPaneId
          }
        : null,
    [sessionListPanels, standaloneSessionPreviewPaneId]
  );
  const sessionManageIsListView = sessionManageDialog.view_mode === "list";
  const sessionManageGroupedItems = useMemo(
    () =>
      groupSessionCandidatesForManage(
        sessionManageListState?.items ?? [],
        sessionManagePane?.active_session_id ?? "",
        sessionManagePane?.linked_session_ids ?? []
      ),
    [
      sessionManageListState?.items,
      sessionManagePane?.active_session_id,
      sessionManagePane?.linked_session_ids
    ]
  );
  const sessionManageMissingCurrentIndexed = useMemo(() => {
    const active = sessionManagePane?.active_session_id.trim() ?? "";
    if (!active) {
      return false;
    }
    return sessionManageGroupedItems.current.some(
      (item) => item.synthetic && item.session_id.trim() === active
    );
  }, [sessionManageGroupedItems.current, sessionManagePane?.active_session_id]);
  const sessionManageMissingLinkedCount = useMemo(
    () => sessionManageGroupedItems.linked.filter((item) => item.synthetic).length,
    [sessionManageGroupedItems.linked]
  );
  const sessionManagePreviewItems = useMemo<SyncEntryPreviewItem[]>(
    () =>
      sessionManagePreview.preview_rows.map((row, index) => ({
        id: row.id || `${row.created_at}-${index}-${row.kind}`,
        kind: row.kind,
        content: row.content,
        created_at: row.created_at,
        created_at_text: formatTs(row.created_at),
        sid_text: sessionManagePreview.preview_session_id
          ? shortSessionId(sessionManagePreview.preview_session_id)
          : "-",
        included: true,
        preview_truncated: Boolean(row.preview_truncated),
        favorite_target: sessionManagePaneId && sessionManagePreview.preview_session_id
          ? {
              pane_id: sessionManagePaneId,
              pane_title: sessionManagePane?.title || "",
              provider: sessionManagePane?.provider || "",
              session_id: sessionManagePreview.preview_session_id
            }
          : undefined
      })),
    [
      sessionManagePane?.provider,
      sessionManagePane?.title,
      sessionManagePaneId,
      sessionManagePreview.preview_rows,
      sessionManagePreview.preview_session_id
    ]
  );
  const resolveSyncDialogPreviewItemSessionId = useCallback(
    (item: Pick<SyncEntryPreviewItem, "id" | "kind" | "content">): string => {
      if (syncDialogPreviewSessionId) {
        return syncDialogPreviewSessionId;
      }

      const matchedEntry = syncDialog.entries.find((entry) => entry.id === item.id);
      if (matchedEntry) {
        return resolveEntrySessionId(matchedEntry, syncDialogCurrentSessionId) || "";
      }

      return resolveEntrySessionId(
        {
          id: item.id,
          pane_id: syncDialog.pane_id,
          kind: item.kind,
          content: item.content,
          synced_from: null,
          created_at: 0
        },
        syncDialogCurrentSessionId
      ) || "";
    },
    [
      syncDialog.entries,
      syncDialog.pane_id,
      syncDialogCurrentSessionId,
      syncDialogPreviewSessionId
    ]
  );
  const syncDialogPreviewItems = useMemo<SyncEntryPreviewItem[]>(
    () =>
      syncDialogPreviewSessionId
        ? syncDialogPreview.preview_rows.map((row, index) => {
            const entryId = row.id || `${row.created_at}-${index}-${row.kind}`;
            const previewEntry: EntryRecord = {
              id: entryId,
              pane_id: syncDialog.pane_id,
              kind: row.kind,
              content: row.content,
              synced_from: buildNativePreviewTag(syncDialogPreviewSessionId),
              created_at: row.created_at,
              preview_truncated: Boolean(row.preview_truncated)
            };
            return {
              id: entryId,
              kind: row.kind,
              content: row.content,
              created_at: row.created_at,
              created_at_text: formatTs(row.created_at),
              sid_text: shortSessionId(syncDialogPreviewSessionId),
              included: isSyncDialogEntryIncluded(previewEntry),
              preview_truncated: Boolean(row.preview_truncated),
              favorite_target: syncDialog.pane_id
                ? {
                    pane_id: syncDialog.pane_id,
                    pane_title: syncDialogPane?.title || "",
                    provider: syncDialogPane?.provider || "",
                    session_id: syncDialogPreviewSessionId
                  }
                : undefined
            };
          })
        : syncDialogPreviewPanelEntries.map((entry) => {
            const sessionId = resolveEntrySessionId(entry, syncDialogCurrentSessionId);
            return {
              id: entry.id,
              kind: entry.kind,
              content: entry.content,
              created_at: entry.created_at,
              created_at_text: formatTs(entry.created_at),
              sid_text: sessionId ? shortSessionId(sessionId) : "-",
              included: isSyncDialogEntryIncluded(entry),
              preview_truncated: Boolean(entry.preview_truncated)
            };
          }),
    [
      isSyncDialogEntryIncluded,
      syncDialog.pane_id,
      syncDialogCurrentSessionId,
      syncDialogPane?.provider,
      syncDialogPane?.title,
      syncDialogPreview.preview_rows,
      syncDialogPreviewPanelEntries,
      syncDialogPreviewSessionId
    ]
  );
  const favoriteMessageMap = useMemo(
    () => new Map(favoriteMessages.map((item) => [buildFavoriteMessageKeyFromRecord(item), item] as const)),
    [favoriteMessages]
  );
  const isPreviewMessageFavorited = useCallback(
    (item: SyncEntryPreviewItem) => {
      const key = buildFavoriteMessageKeyFromPreviewItem(item);
      return key ? favoriteMessageMap.has(key) : false;
    },
    [favoriteMessageMap]
  );
  const canOpenSessionManagePreviewOverlay = Boolean(
    sessionManagePreview.preview_session_id.trim() ||
      sessionManagePreview.preview_rows.length ||
      sessionManagePreview.preview_loading
  );
  const canOpenSyncDialogPreviewOverlay = Boolean(
    syncDialogPreviewSessionId ||
      syncDialogFilteredEntries.length ||
      syncDialog.loading ||
      syncDialog.selected_session_ids.length
  );
  const previewOverlayTitle =
    previewOverlaySource === "session-manage"
      ? `${sessionManageIsListView ? "当前会话消息" : "会话预览"}弹窗`
      : previewOverlaySource === "sync-dialog"
        ? "同步预览弹窗"
        : "预览弹窗";
  const previewOverlayLoading =
    previewOverlaySource === "session-manage"
      ? sessionManagePreview.preview_loading && !sessionManagePreviewItems.length
      : previewOverlaySource === "sync-dialog"
        ? syncDialog.loading
        : false;
  const previewOverlayEmptyText =
    previewOverlaySource === "session-manage"
      ? "当前会话暂无预览消息"
      : (syncDialogPreviewSessionId ? syncDialogPreview.preview_rows.length : syncDialogFilteredEntries.length)
        ? "当前预览会话在筛选条件下暂无记录"
        : "当前筛选下暂无可同步记录";
  const syncDialogGroupedItems = useMemo(
    () =>
      groupSessionCandidates(
        (syncShowSelectedOnly
          ? syncDialogSessionListState.items.filter((item) =>
              syncDialogVisualSelectedSessionSet.has(item.session_id)
            )
          : syncDialogSessionListState.items),
        syncDialogPane?.active_session_id ?? "",
        syncDialogPane?.linked_session_ids ?? []
      ),
    [
      syncDialogVisualSelectedSessionSet,
      syncShowSelectedOnly,
      syncDialogPane?.active_session_id,
      syncDialogPane?.linked_session_ids,
      syncDialogSessionListState.items
    ]
  );
  const sessionManageSortState = useMemo(
    () => splitSessionSortMode(sessionManageListState?.sort_mode ?? "updated_desc"),
    [sessionManageListState?.sort_mode]
  );
  const syncDialogSortState = useMemo(
    () => splitSessionSortMode(syncDialogSessionListState.sort_mode),
    [syncDialogSessionListState.sort_mode]
  );
  const panesWithSessionBindings = useMemo(
    () =>
      panes.filter(
        (pane) => pane.active_session_id.trim().length > 0 || pane.linked_session_ids.length > 0
      ),
    [panes]
  );
  const allSessionPanelsOpen = useMemo(
    () => panes.length > 0 && panes.every((pane) => Boolean(sessionListPanels[pane.id]?.open)),
    [panes, sessionListPanels]
  );
  const sessionManageProgressState = useMemo(() => {
    const loadedSessions = Math.max(0, sessionManageListState?.items.length ?? 0);
    const totalSessions = Math.max(0, sessionManageListState?.total ?? 0);
    const scanRunning = Boolean(sessionManagePane?.scan_running || sessionManageReindexing);
    const scanProcessed = Math.max(0, sessionManagePane?.scan_processed_files ?? 0);
    const scanTotal = Math.max(0, sessionManagePane?.scan_total_files ?? 0);
    const scanChanged = Math.max(0, sessionManagePane?.scan_changed_files ?? 0);
    if (scanRunning) {
      const percent =
        scanTotal > 0 ? Math.min(100, Math.round((scanProcessed / scanTotal) * 100)) : 0;
      return {
        mode: "scan" as const,
        percent,
        status: "active" as const,
        tag_text: `缓存构建: ${scanProcessed}/${scanTotal}`,
        sub_tag_text: `变更文件: ${scanChanged}`,
        format_text: `${percent}% (缓存构建 ${scanProcessed}/${scanTotal}, 已发现变更 ${scanChanged})`
      };
    }
    const percent =
      totalSessions > 0 ? Math.min(100, Math.round((loadedSessions / totalSessions) * 100)) : 0;
    return {
      mode: "session" as const,
      percent,
      status: percent >= 100 && totalSessions > 0 ? ("success" as const) : ("normal" as const),
      tag_text: `会话加载: ${loadedSessions}/${totalSessions}`,
      sub_tag_text: `会话总数: ${totalSessions}`,
      format_text: `${percent}% (会话已加载 ${loadedSessions}/${totalSessions})`
    };
  }, [
    sessionManageListState?.items.length,
    sessionManageListState?.total,
    sessionManagePane?.scan_changed_files,
    sessionManagePane?.scan_processed_files,
    sessionManagePane?.scan_running,
    sessionManagePane?.scan_total_files,
    sessionManageReindexing
  ]);
  const sessionManageFileStats = useMemo(() => {
    const scanProcessed = Math.max(0, Number(sessionManagePane?.scan_processed_files || 0));
    const recognizedFiles = Math.max(
      0,
      (sessionManageListState?.items || []).reduce(
        (sum, item) => sum + Math.max(0, Number(item.source_files || 0)),
        0
      )
    );
    const listedUnrecognized = Math.max(
      0,
      Number(sessionManageListState?.unrecognized_files?.length || 0)
    );
    const estimatedUnrecognized = Math.max(0, scanProcessed - recognizedFiles);
    const displayUnrecognized =
      listedUnrecognized > 0 ? listedUnrecognized : estimatedUnrecognized;
    return {
      scanProcessed,
      recognizedFiles,
      listedUnrecognized,
      estimatedUnrecognized,
      displayUnrecognized
    };
  }, [
    sessionManageListState?.items,
    sessionManageListState?.unrecognized_files,
    sessionManagePane?.scan_processed_files
  ]);
  const sessionManageLoadingActive = Boolean(
    sessionManageReindexing ||
      sessionManagePane?.scan_running ||
      sessionManageListState?.loading ||
      sessionManageListState?.loading_more
  );
  const sessionManageCenterProgressText = useMemo(() => {
    const scanProcessed = Math.max(0, Number(sessionManagePane?.scan_processed_files || 0));
    const scanTotal = Math.max(0, Number(sessionManagePane?.scan_total_files || 0));
    const loadedSessions = Math.max(0, Number(sessionManageListState?.items.length || 0));
    const totalSessions = Math.max(0, Number(sessionManageListState?.total || 0));
    if (scanTotal > 0 || scanProcessed > 0 || sessionManagePane?.scan_running || sessionManageReindexing) {
      const scanTotalText = scanTotal > 0 ? String(scanTotal) : "?";
      return {
        title: `正在构建缓存，已扫描 ${scanProcessed}/${scanTotalText} 个文件`,
        subtitle: `会话已加载 ${loadedSessions}/${totalSessions > 0 ? totalSessions : "?"}`
      };
    }
    return {
      title: `正在加载会话，已加载 ${loadedSessions}/${totalSessions > 0 ? totalSessions : "?"}`,
      subtitle: "请稍候，加载完成后会显示完整分组"
    };
  }, [
    sessionManageListState?.items.length,
    sessionManageListState?.total,
    sessionManagePane?.scan_processed_files,
    sessionManagePane?.scan_running,
    sessionManagePane?.scan_total_files,
    sessionManageReindexing
  ]);
  const sessionManageProgressInlineText = useMemo(() => {
    if (sessionManageLoadingActive) {
      return `${sessionManageCenterProgressText.title} ${sessionManageCenterProgressText.subtitle}`;
    }
    return sessionManageProgressState.format_text;
  }, [
    sessionManageCenterProgressText.subtitle,
    sessionManageCenterProgressText.title,
    sessionManageLoadingActive,
    sessionManageProgressState.format_text
  ]);
  useEffect(() => {
    let disposed = false;

    const loadAvatar = async (
      avatarPath: string,
      fallbackSrc: string,
      fallbackToken: string,
      setter: (value: string) => void
    ) => {
      const normalized = avatarPath.trim();
      if (!normalized || normalized === fallbackToken) {
        setter(fallbackSrc);
        return;
      }
      if (isDirectAvatarSrc(normalized, fallbackToken)) {
        setter(normalized);
        return;
      }

      try {
        const dataUrl = await invoke<string>("load_avatar_data_url", { imagePath: normalized });
        if (!disposed) {
          setter(dataUrl || fallbackSrc);
        }
      } catch (error) {
        console.error(error);
        if (!disposed) {
          setter(fallbackSrc);
        }
      }
    };

    void loadAvatar(userAvatarPath, defaultUserAvatar, DEFAULT_USER_AVATAR_TOKEN, setUserAvatarSrc);
    void loadAvatar(
      assistantAvatarPath,
      defaultAssistantAvatar,
      DEFAULT_ASSISTANT_AVATAR_TOKEN,
      setAssistantAvatarSrc
    );

    return () => {
      disposed = true;
    };
  }, [assistantAvatarPath, userAvatarPath]);

  const gridStyle = useMemo(() => {
    if (layoutMode === "vertical") {
      return {
        gridTemplateColumns: `repeat(${Math.max(panes.length, 1)}, minmax(320px, 1fr))`,
        gridTemplateRows: "minmax(0, 1fr)"
      };
    }
    return {
      gridTemplateColumns: "minmax(0, 1fr)",
      gridTemplateRows: `repeat(${Math.max(panes.length, 1)}, minmax(0, 1fr))`
    };
  }, [layoutMode, panes.length]);

  const getSessionListPanelState = useCallback(
    (paneId: string): SessionListDialogState => {
      const current = sessionListPanelsRef.current[paneId];
      if (!current) {
        return { ...createSessionListDialogState(), pane_id: paneId };
      }
      const items = Array.isArray(current.items) ? current.items : [];
      const allItems = Array.isArray(current.all_items) ? current.all_items : items;
      return {
        ...createSessionListDialogState(),
        ...current,
        pane_id: paneId,
        all_items: allItems,
        items
      };
    },
    []
  );

  const nextSessionListLoadTicket = useCallback((paneId: string): number => {
    const current = sessionListLoadTicketRef.current.get(paneId) ?? 0;
    const next = current + 1;
    sessionListLoadTicketRef.current.set(paneId, next);
    return next;
  }, []);

  const isSessionListLoadTicketActive = useCallback((paneId: string, ticket: number): boolean => {
    return (sessionListLoadTicketRef.current.get(paneId) ?? 0) === ticket;
  }, []);

  const nextSessionPreviewLoadTicket = useCallback((paneId: string): number => {
    const current = sessionPreviewLoadTicketRef.current.get(paneId) ?? 0;
    const next = current + 1;
    sessionPreviewLoadTicketRef.current.set(paneId, next);
    return next;
  }, []);

  const isSessionPreviewLoadTicketActive = useCallback((paneId: string, ticket: number): boolean => {
    return (sessionPreviewLoadTicketRef.current.get(paneId) ?? 0) === ticket;
  }, []);

  const updateSessionListPanelState = useCallback(
    (paneId: string, updater: (current: SessionListDialogState) => SessionListDialogState) => {
      setSessionListPanels((current) => {
        const baseRaw = current[paneId];
        const base: SessionListDialogState = baseRaw
          ? {
              ...createSessionListDialogState(),
              ...baseRaw,
              pane_id: paneId,
              items: Array.isArray(baseRaw.items) ? baseRaw.items : [],
              all_items: Array.isArray(baseRaw.all_items)
                ? baseRaw.all_items
                : Array.isArray(baseRaw.items)
                  ? baseRaw.items
                  : []
            }
          : { ...createSessionListDialogState(), pane_id: paneId };
        const updated = updater(base);
        const next = {
          ...updated,
          pane_id: paneId,
          items: Array.isArray(updated.items) ? updated.items : [],
          all_items: Array.isArray(updated.all_items)
            ? updated.all_items
            : Array.isArray(updated.items)
              ? updated.items
              : []
        };
        const merged = {
          ...current,
          [paneId]: next
        };
        sessionListPanelsRef.current = merged;
        return merged;
      });
    },
    []
  );

  const disposeTerminal = useCallback((paneId: string) => {
    const runtime = terminalsRef.current.get(paneId);
    if (!runtime) {
      return;
    }
    runtime.disposed = true;
    runtime.dataDisposable.dispose();
    runtime.resizeObserver.disconnect();
    runtime.element.removeEventListener("focusin", runtime.focusHandler);
    runtime.term.dispose();
    terminalsRef.current.delete(paneId);
    paneOutputProbeRef.current.delete(paneId);
    sidProbeTokenRef.current.delete(paneId);
    paneSplitContainerRef.current.delete(paneId);
  }, []);

  const fitTerminalRuntime = useCallback((paneId: string, runtime: PaneTerminal) => {
    if (runtime.disposed || !runtime.element.isConnected) {
      return;
    }
    const { clientWidth, clientHeight } = runtime.element;
    if (clientWidth <= 0 || clientHeight <= 0) {
      return;
    }
    try {
      runtime.fit.fit();
    } catch (error) {
      console.error(error);
      return;
    }
    void invoke<void>("resize_pane", {
      paneId,
      cols: runtime.term.cols,
      rows: runtime.term.rows
    }).catch((error) => console.error(error));
  }, []);

  const clampInlinePreviewPanelHeight = useCallback((paneId: string, requestedHeight: number): number => {
    const container = paneSplitContainerRef.current.get(paneId);
    const containerHeight = container?.clientHeight || 0;
    if (containerHeight <= 0) {
      return Math.max(MIN_INLINE_PREVIEW_PANEL_HEIGHT, Math.round(requestedHeight));
    }
    const maxHeight = Math.max(
      MIN_INLINE_PREVIEW_PANEL_HEIGHT,
      containerHeight - MIN_INLINE_TERMINAL_SECTION_HEIGHT - INLINE_PREVIEW_SPLITTER_HEIGHT
    );
    const minHeight = Math.min(MIN_INLINE_PREVIEW_PANEL_HEIGHT, maxHeight);
    return Math.max(minHeight, Math.min(Math.round(requestedHeight), maxHeight));
  }, []);

  const fitAllTerminals = useCallback(() => {
    for (const [paneId, runtime] of terminalsRef.current.entries()) {
      fitTerminalRuntime(paneId, runtime);
    }
  }, [fitTerminalRuntime]);

  const mountTerminal = useCallback(
    (paneId: string, element: HTMLDivElement | null) => {
      if (!element) {
        disposeTerminal(paneId);
        return;
      }

      const existing = terminalsRef.current.get(paneId);
      if (existing) {
        if (existing.element === element) {
          return;
        }
        disposeTerminal(paneId);
      }

      const term = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        scrollback: 6000,
        fontFamily: "Cascadia Mono, JetBrains Mono, Consolas, monospace"
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(element);

      const dataDisposable = term.onData((data) => {
        void invoke<void>("write_to_pane", { paneId, data }).catch((error) => console.error(error));
      });

      const resizeObserver = new ResizeObserver(() => {
        const runtime = terminalsRef.current.get(paneId);
        if (!runtime) {
          return;
        }
        fitTerminalRuntime(paneId, runtime);
      });
      resizeObserver.observe(element);

      const focusHandler = () => setActivePaneId(paneId);
      element.addEventListener("focusin", focusHandler);

      terminalsRef.current.set(paneId, {
        term,
        fit,
        dataDisposable,
        resizeObserver,
        element,
        focusHandler,
        disposed: false
      });

      window.requestAnimationFrame(() => {
        const runtime = terminalsRef.current.get(paneId);
        if (!runtime) {
          return;
        }
        fitTerminalRuntime(paneId, runtime);
      });
    },
    [disposeTerminal, fitTerminalRuntime]
  );

  const getTerminalMountRef = useCallback(
    (paneId: string) => {
      const existing = terminalRefCallbacks.current.get(paneId);
      if (existing) {
        return existing;
      }
      const callback = (element: HTMLDivElement | null) => {
        mountTerminal(paneId, element);
      };
      terminalRefCallbacks.current.set(paneId, callback);
      return callback;
    },
    [mountTerminal]
  );

  const getPaneSplitContainerRef = useCallback((paneId: string) => {
    return (element: HTMLDivElement | null) => {
      if (!element) {
        paneSplitContainerRef.current.delete(paneId);
        return;
      }
      paneSplitContainerRef.current.set(paneId, element);
    };
  }, []);

  const startPanePreviewResize = useCallback(
    (
      paneId: string,
      event: {
        clientY: number;
        preventDefault: () => void;
        stopPropagation: () => void;
      }
    ) => {
      event.preventDefault();
      event.stopPropagation();
      const panel = getSessionListPanelState(paneId);
      panePreviewResizeStateRef.current = {
        paneId,
        startY: event.clientY,
        originHeight: panel.preview_panel_height || DEFAULT_INLINE_PREVIEW_PANEL_HEIGHT
      };
    },
    [getSessionListPanelState]
  );

  const updatePane = useCallback((paneId: string, updater: (pane: PaneView) => PaneView) => {
    setPanes((current) => current.map((pane) => (pane.id === paneId ? updater(pane) : pane)));
  }, []);

  const hydratePaneSessionState = useCallback(
    async (paneId: string) => {
      try {
        const state = await invoke<PaneSessionState>("get_pane_session_state", { paneId });
        updatePane(paneId, (pane) => ({
          ...pane,
          active_session_id: state.active_session_id || "",
          linked_session_ids: Array.isArray(state.linked_session_ids) ? state.linked_session_ids : []
        }));
      } catch (error) {
        console.error(error);
      }
    },
    [updatePane]
  );

  const refreshScanProgress = useCallback(
    async (paneId: string) => {
      try {
        const progress = await invoke<NativeSessionIndexProgress>("get_native_session_index_progress", {
          paneId
        });
        updatePane(paneId, (pane) => ({
          ...pane,
          scan_running: Boolean(progress.running),
          scan_total_files: Number(progress.total_files || 0),
          scan_processed_files: Number(progress.processed_files || 0),
          scan_changed_files: Number(progress.changed_files || 0)
        }));
      } catch (error) {
        console.error(error);
      }
    },
    [updatePane]
  );

  const refreshNativeSessionCache = useCallback(
    async (paneId: string) => {
      if (!paneId.trim()) {
        return;
      }
      try {
        await invoke<NativeSessionIndexProgress>("refresh_native_session_cache", { paneId });
      } finally {
        await refreshScanProgress(paneId);
      }
    },
    [refreshScanProgress]
  );

  const shouldWarmupNativeSessionCache = useCallback(
    async (paneId: string) => {
      const normalizedPaneId = paneId.trim();
      if (!normalizedPaneId) {
        return false;
      }

      try {
        const [progress, batch] = await Promise.all([
          invoke<NativeSessionIndexProgress>("get_native_session_index_progress", { paneId: normalizedPaneId }),
          loadSessionCandidates(normalizedPaneId, {
            sortMode: "updated_desc",
            offset: 0,
            limit: 1,
            sidKeyword: "",
            timeFrom: null,
            timeTo: null,
            recordsMin: null,
            recordsMax: null
          })
        ]);

        if (progress.running) {
          return false;
        }
        if (Number(progress.total_files || 0) > 0 || Number(progress.processed_files || 0) > 0) {
          return false;
        }

        const totalCandidates = Number(batch.total || 0);
        const totalUnrecognized = Array.isArray(batch.unrecognized_files)
          ? batch.unrecognized_files.length
          : 0;
        return totalCandidates <= 0 && totalUnrecognized <= 0;
      } catch (error) {
        console.error(error);
        return true;
      }
    },
    []
  );

  const warmupNativeSessionCache = useCallback(
    async (paneId: string, silent = true) => {
      const normalizedPaneId = paneId.trim();
      if (!normalizedPaneId) {
        return;
      }

      updatePane(normalizedPaneId, (pane) => ({
        ...pane,
        scan_running: true,
        scan_processed_files: Math.max(0, pane.scan_processed_files),
        scan_changed_files: Math.max(0, pane.scan_changed_files)
      }));

      void refreshScanProgress(normalizedPaneId);
      const timer = window.setInterval(() => {
        void refreshScanProgress(normalizedPaneId);
      }, 500);

      try {
        await refreshNativeSessionCache(normalizedPaneId);
        await refreshScanProgress(normalizedPaneId);
      } catch (error) {
        console.error(error);
        if (!silent) {
          messageApi.error("后台缓存构建失败");
        }
      } finally {
        window.clearInterval(timer);
      }
    },
    [messageApi, refreshNativeSessionCache, refreshScanProgress, updatePane]
  );

  const setPaneSessionState = useCallback(
    async (paneId: string, activeSessionId: string, linkedSessionIds: string[]) => {
      const linked = parseSessionIds(linkedSessionIds);
      const response = await invoke<PaneSessionState>("set_pane_session_state", {
        paneId,
        activeSessionId: activeSessionId.trim(),
        linkedSessionIds: linked,
        includeLinkedInSync: false
      });
      updatePane(paneId, (pane) => ({
        ...pane,
        active_session_id: response.active_session_id || "",
        linked_session_ids: Array.isArray(response.linked_session_ids) ? response.linked_session_ids : []
      }));
      const normalizedPaneId = paneId.trim();
      if (normalizedPaneId) {
        const nextTicket = (paneSessionIndexSyncTicketRef.current.get(normalizedPaneId) ?? 0) + 1;
        paneSessionIndexSyncTicketRef.current.set(normalizedPaneId, nextTicket);
        void (async () => {
          try {
            await refreshNativeSessionCache(normalizedPaneId);
            if ((paneSessionIndexSyncTicketRef.current.get(normalizedPaneId) ?? 0) !== nextTicket) {
              return;
            }
            const reloadSessionListDialogFn = reloadSessionListDialogRef.current;
            if (!reloadSessionListDialogFn) {
              return;
            }
            if (sessionManageDialog.open && sessionManageDialog.pane_id.trim() === normalizedPaneId) {
              await reloadSessionListDialogFn(normalizedPaneId, undefined, {
                fullLoad: true,
                keepPanelClosed: true
              });
              return;
            }
            const panel = getSessionListPanelState(normalizedPaneId);
            if (panel.open) {
              await reloadSessionListDialogFn(normalizedPaneId, undefined, { keepPanelClosed: true });
            }
          } catch (error) {
            console.error(error);
          }
        })();
      }
      return response;
    },
    [
      getSessionListPanelState,
      refreshNativeSessionCache,
      sessionManageDialog.open,
      sessionManageDialog.pane_id,
      updatePane
    ]
  );

  const clearAllPaneSessionBindings = useCallback(async () => {
    if (clearingAllSid) {
      return;
    }
    const targetPaneIds = panesWithSessionBindings.map((pane) => pane.id);
    if (!targetPaneIds.length) {
      messageApi.info("当前没有可清空的 SID");
      return;
    }
    const confirmed = window.confirm(
      `确认清空全部 ${targetPaneIds.length} 个窗格的当前 SID 和关联 SID？\n此操作不会删除会话历史。`
    );
    if (!confirmed) {
      return;
    }
    try {
      setClearingAllSid(true);
      await Promise.all(targetPaneIds.map((paneId) => setPaneSessionState(paneId, "", [])));
      for (const paneId of targetPaneIds) {
        sessionPreviewFollowBottomRef.current.delete(paneId);
        updateSessionListPanelState(paneId, (current) => ({
          ...current,
          preview_session_id: "",
          preview_loading: false,
          preview_rows: [],
          preview_total_rows: 0,
          preview_loaded_rows: 0,
          preview_has_more: false,
          preview_from_end: true
        }));
      }
      if (sessionManageDialog.open && targetPaneIds.includes(sessionManageDialog.pane_id)) {
        sessionManagePreviewTicketRef.current += 1;
        setSessionManagePreview(createSessionManagePreviewState());
        setSessionManagePreviewScrollCommand(null);
        setSessionManageGroupTab("unlinked");
      }
      messageApi.success(`已清空 ${targetPaneIds.length} 个窗格的 SID 绑定`);
    } catch (error) {
      console.error(error);
      messageApi.error("清空全部 SID 失败");
    } finally {
      setClearingAllSid(false);
    }
  }, [
    clearingAllSid,
    messageApi,
    panesWithSessionBindings,
    sessionManageDialog.open,
    sessionManageDialog.pane_id,
    setPaneSessionState,
    updateSessionListPanelState
  ]);

  const loadSessionCandidates = useCallback(
    async (
      paneId: string,
      options: {
        sortMode: SessionSortMode;
        offset: number;
        limit: number;
        sidKeyword: string;
        timeFrom: number | null;
        timeTo: number | null;
        recordsMin: number | null;
        recordsMax: number | null;
        fullLoad?: boolean;
      }
    ) => {
      const { field, order } = splitSessionSortMode(options.sortMode);
      const sortBy = field;
      const sortOrder = order;
      const response = await invoke<NativeSessionListResponse>("list_native_session_candidates", {
        paneId,
        offset: options.offset,
        limit: options.limit,
        sidKeyword: options.sidKeyword || null,
        timeFrom: options.timeFrom,
        timeTo: options.timeTo,
        recordsMin: options.recordsMin,
        recordsMax: options.recordsMax,
        sortBy,
        sortOrder,
        cacheOnly: true,
        fullLoad: Boolean(options.fullLoad)
      });
      return response;
    },
    []
  );

  const loadFavoriteMessages = useCallback(
    async (silent = false) => {
      try {
        const response = await invoke<FavoriteMessageRecord[]>("list_favorite_messages");
        setFavoriteMessages(Array.isArray(response) ? response : []);
      } catch (error) {
        console.error(error);
        if (!silent) {
          messageApi.error("加载收藏消息失败");
        }
      }
    },
    [messageApi]
  );

  useEffect(() => {
    let disposed = false;

    const boot = async () => {
      setLoading(true);
      try {
        const appConfig = await invoke<AppConfigResponse>("get_app_config").catch((error) => {
          console.error(error);
          return null;
        });

        if (appConfig && !disposed) {
          setConfigPath(appConfig.config_path || "");
          setWorkingDirectory((appConfig.working_directory || "").trim());
          setUiThemePreset(normalizeThemePreset(appConfig.ui_theme_preset));
          setUiSkinHue(Number(appConfig.ui_skin_hue || DEFAULT_SKIN_HUE));
          setUiSkinAccent(normalizeHexColor(appConfig.ui_skin_accent || DEFAULT_SKIN_ACCENT));
          setUserAvatarPath(
            normalizeAvatarPath(appConfig.user_avatar_path, DEFAULT_USER_AVATAR_TOKEN)
          );
          setAssistantAvatarPath(
            normalizeAvatarPath(appConfig.assistant_avatar_path, DEFAULT_ASSISTANT_AVATAR_TOKEN)
          );
        }

        const providerList = await invoke<string[]>("list_registered_providers")
          .then((items) => {
            const normalized = items
              .map((item) => item.trim().toLowerCase())
              .filter((item) => item.length > 0);
            return normalized.length ? normalized : FALLBACK_PROVIDERS;
          })
          .catch((error) => {
            console.error(error);
            return FALLBACK_PROVIDERS;
          });

        const parserProfiles = await invoke<SessionParserProfileSummary[]>(
          "list_registered_session_parser_profiles"
        )
          .then((items) => {
            const normalized = items
              .map((item) => ({
                id: normalizeSessionParsePreset(item.id),
                name: (item.name || "").trim() || asTitle(item.id),
                default_file_glob: (item.default_file_glob || "").trim(),
                file_format: (item.file_format || "jsonl").trim().toLowerCase()
              }))
              .filter((item) => item.id.length > 0);
            return normalized.length ? normalized : FALLBACK_SESSION_PARSER_PROFILES;
          })
          .catch((error) => {
            console.error(error);
            return FALLBACK_SESSION_PARSER_PROFILES;
          });

        if (!disposed) {
          setProviders(providerList);
          setSessionParserProfiles(parserProfiles);
          setCreatePaneDialog((current) => ({
            ...current,
            session_parse_preset: normalizeSessionParsePreset(current.session_parse_preset),
            session_scan_glob: normalizeSessionScanGlobInput(
              current.session_scan_glob.trim() ||
                defaultSessionScanGlobByPreset(current.session_parse_preset, parserProfiles)
            )
          }));
        }

        let paneSummaries = await invoke<PaneSummary[]>("list_panes").catch((error) => {
          console.error(error);
          return [];
        });

        if (!paneSummaries.length && !isStandaloneSessionPreviewRoute) {
          const defaultProvider = providerList[0] || FALLBACK_PROVIDERS[0];
          const summary = await invoke<PaneSummary>("create_pane", {
            provider: defaultProvider,
            title: asTitle(defaultProvider)
          });
          paneSummaries = [summary];
        }

        if (disposed) {
          return;
        }

        const nextPanes = paneSummaries.map(createPaneView);
        setPanes(nextPanes);
        const preferredPaneId =
          nextPanes.find((pane) => pane.id === standaloneSessionPreviewPaneId)?.id || nextPanes[0]?.id || "";
        setActivePaneId(isStandaloneSessionPreviewRoute ? preferredPaneId : nextPanes[0]?.id || "");

        for (const pane of nextPanes) {
          if (!isStandaloneSessionPreviewRoute) {
            void invoke<boolean>("ensure_pane_runtime", { paneId: pane.id }).catch((error) =>
              console.error(error)
            );
            void refreshScanProgress(pane.id);
          }
          void hydratePaneSessionState(pane.id);
        }
      } catch (error) {
        console.error(error);
        messageApi.error("初始化失败，请检查后端服务");
      } finally {
        if (!disposed) {
          setLoading(false);
        }
      }
    };

    void boot();

    return () => {
      disposed = true;
    };
  }, [
    hydratePaneSessionState,
    isStandaloneSessionPreviewRoute,
    messageApi,
    refreshScanProgress,
    standaloneSessionPreviewPaneId
  ]);

  useEffect(() => {
    void loadFavoriteMessages(true);
  }, [loadFavoriteMessages]);

  useEffect(() => {
    if (!isStandaloneSessionPreviewRoute || !panes.length) {
      return;
    }
    const normalizedPaneId = standaloneSessionPreviewPaneId.trim();
    if (normalizedPaneId && panes.some((pane) => pane.id === normalizedPaneId)) {
      return;
    }
    setStandaloneSessionPreviewPaneId(activePaneId || panes[0]?.id || "");
  }, [activePaneId, isStandaloneSessionPreviewRoute, panes, standaloneSessionPreviewPaneId]);

  useEffect(() => {
    localStorage.setItem(STORAGE_COLOR_MODE_KEY, uiColorMode);
  }, [uiColorMode]);

  useEffect(() => {
    const payload = JSON.stringify(compressConfig);
    localStorage.setItem(STORAGE_COMPRESS_KEY, payload);
  }, [compressConfig]);

  useEffect(() => {
    sessionListPanelsRef.current = sessionListPanels;
  }, [sessionListPanels]);

  useEffect(() => {
    if (!sessionPanelPersistReadyRef.current) {
      return;
    }
    const openMap: Record<string, boolean> = {};
    for (const [paneId, panel] of Object.entries(sessionListPanels)) {
      openMap[paneId] = Boolean(panel.open);
    }
    localStorage.setItem(STORAGE_SESSION_PANEL_OPEN_KEY, JSON.stringify(openMap));
  }, [sessionListPanels]);

  useEffect(() => {
    if (!panes.length) {
      return;
    }
    setSessionListPanels((current) => {
      const next: Record<string, SessionListDialogState> = {};
      for (const pane of panes) {
        const existing = current[pane.id];
        if (!existing) {
          next[pane.id] = { ...createSessionListDialogState(), pane_id: pane.id };
          continue;
        }
        const items = Array.isArray(existing.items) ? existing.items : [];
        next[pane.id] = {
          ...createSessionListDialogState(),
          ...existing,
          pane_id: pane.id,
          items,
          all_items: Array.isArray(existing.all_items) ? existing.all_items : items
        };
      }
      return next;
    });
  }, [panes]);

  useEffect(() => {
    let unlistenOutput: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;

    const wire = async () => {
      unlistenOutput = await listen<TerminalOutputEvent>("terminal-output", (event) => {
        const payload = event.payload;
        if (!payload?.pane_id || !payload.data) {
          return;
        }
        const sanitized = sanitizeTerminalProbeText(payload.data);
        if (sanitized) {
          const current = paneOutputProbeRef.current.get(payload.pane_id) ?? {
            revision: 0,
            text: ""
          };
          paneOutputProbeRef.current.set(payload.pane_id, {
            revision: current.revision + 1,
            text: appendTerminalProbeText(current.text, sanitized)
          });
        }
        const runtime = terminalsRef.current.get(payload.pane_id);
        if (runtime && !runtime.disposed) {
          try {
            runtime.term.write(payload.data);
          } catch (error) {
            console.error(error);
          }
        }
        queuePanePreviewAutoRefreshRef.current(payload.pane_id);
        queueSessionManageAutoRefreshRef.current(payload.pane_id);
      });

      unlistenExit = await listen<TerminalExitEvent>("terminal-exit", (event) => {
        const payload = event.payload;
        if (!payload?.pane_id) {
          return;
        }
        const runtime = terminalsRef.current.get(payload.pane_id);
        if (runtime && !runtime.disposed) {
          try {
            runtime.term.writeln("\r\n[terminal exited]");
          } catch (error) {
            console.error(error);
          }
        }
      });
    };

    void wire().catch((error) => console.error(error));

    return () => {
      unlistenOutput?.();
      unlistenExit?.();
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => fitAllTerminals(), 80);
    return () => window.clearTimeout(timer);
  }, [fitAllTerminals, layoutMode, panes.length]);

  useEffect(() => {
    const onResize = () => fitAllTerminals();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [fitAllTerminals]);

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      const current = panePreviewResizeStateRef.current;
      if (!current) {
        return;
      }
      const nextHeight = clampInlinePreviewPanelHeight(
        current.paneId,
        current.originHeight - (event.clientY - current.startY)
      );
      updateSessionListPanelState(current.paneId, (panel) => ({
        ...panel,
        preview_panel_height: nextHeight
      }));
    };

    const handleMouseUp = () => {
      if (!panePreviewResizeStateRef.current) {
        return;
      }
      panePreviewResizeStateRef.current = null;
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [clampInlinePreviewPanelHeight, updateSessionListPanelState]);

  useEffect(() => {
    const existingIds = new Set(panes.map((pane) => pane.id));
    for (const paneId of terminalsRef.current.keys()) {
      if (!existingIds.has(paneId)) {
        disposeTerminal(paneId);
        terminalRefCallbacks.current.delete(paneId);
      }
    }
  }, [disposeTerminal, panes]);

  const loadCreatePaneParserTemplate = useCallback(
    async (
      parserId: string,
      options?: {
        replaceGlob?: boolean;
        guard?: (current: CreatePaneDialogState) => boolean;
      }
    ) => {
      const normalized = normalizeSessionParsePreset(parserId);
      if (!normalized) {
        return;
      }
      try {
        const config = await invoke<Record<string, unknown>>("get_session_parser_profile_config", {
          profileId: normalized
        });
        const configText = JSON.stringify(config, null, 2);
        const defaultGlobRaw = config.default_file_glob;
        const fallbackGlob = defaultSessionScanGlobByPreset(normalized);
        const defaultGlob =
          (typeof defaultGlobRaw === "string" ? defaultGlobRaw.trim() : "") || fallbackGlob;
        setCreatePaneDialog((current) => {
          if (options?.guard && !options.guard(current)) {
            return current;
          }
          const nextGlob = options?.replaceGlob
            ? fallbackGlob || defaultGlob || current.session_scan_glob
            : current.session_scan_glob.trim() || fallbackGlob || defaultGlob || current.session_scan_glob;
          return {
            ...current,
            session_parse_preset: normalized,
            session_parse_json: configText,
            session_scan_glob: normalizeSessionScanGlobInput(nextGlob)
          };
        });
      } catch (error) {
        console.error(error);
      }
    },
    []
  );

  const autoLoadRemainingSessionCandidates = useCallback(
    async (
      paneId: string,
      ticket: number,
      sortMode: SessionSortMode,
      filters: {
        sidKeyword: string;
        timeFrom: number | null;
        timeTo: number | null;
        recordsMin: number | null;
        recordsMax: number | null;
      },
      startOffset: number,
      limit: number
    ) => {
      let offset = startOffset;
      while (isSessionListLoadTicketActive(paneId, ticket)) {
        try {
          const response = await loadSessionCandidates(paneId, {
            sortMode,
            offset,
            limit,
            ...filters
          });
          if (!isSessionListLoadTicketActive(paneId, ticket)) {
            return;
          }
          updateSessionListPanelState(paneId, (current) => {
            const seen = new Set(current.all_items.map((item) => item.session_id));
            const appended = response.items.filter((item) => !seen.has(item.session_id));
            const allItems = [...current.all_items, ...appended];
            const visibleItems = filterSessionCandidatesByDialog(allItems, current);
            return {
              ...current,
              loading_more: response.has_more,
              all_items: allItems,
              items: visibleItems,
              unrecognized_files: response.unrecognized_files || [],
              total: response.total,
              offset: response.offset + response.items.length,
              has_more: response.has_more
            };
          });
          offset = response.offset + response.items.length;
          if (!response.has_more || response.items.length === 0) {
            updateSessionListPanelState(paneId, (current) => ({ ...current, loading_more: false }));
            return;
          }
        } catch (error) {
          if (!isSessionListLoadTicketActive(paneId, ticket)) {
            return;
          }
          console.error(error);
          updateSessionListPanelState(paneId, (current) => ({ ...current, loading_more: false }));
          messageApi.error("后台续载会话失败");
          return;
        }
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      }
    },
    [
      isSessionListLoadTicketActive,
      loadSessionCandidates,
      messageApi,
      updateSessionListPanelState
    ]
  );

  const openCreatePaneDialog = useCallback(() => {
    const provider = activePane?.provider || providers[0] || FALLBACK_PROVIDERS[0];
    const teamDirectory = isTeamRoute ? workingDirectory : "";
    const teamRoleCount = isTeamRoute ? createPaneDialog.team_role_count : 2;
    const nextState = {
      ...createCreatePaneDialogState(provider, sessionParserProfiles, teamDirectory, teamRoleCount),
      open: true
    };
    setCreatePanePathTarget("rule_content_text_paths");
    setCreatePaneSampleViewMode("root");
    setCreatePaneSamplePreview({
      loading: false,
      error: "",
      parser_profile: "",
      file_path: "",
      file_format: "",
      sample_value: null,
      message_sample_value: null
    });
    setCreatePaneDialog(nextState);
    if (nextState.provider_mode === "preset") {
      const parserId = nextState.provider;
      void loadCreatePaneParserTemplate(parserId, {
        replaceGlob: true,
        guard: (current) => current.open && current.provider_mode === "preset" && current.provider === parserId
      });
    }
  }, [
    activePane?.provider,
    createPaneDialog.team_role_count,
    isTeamRoute,
    loadCreatePaneParserTemplate,
    providers,
    sessionParserProfiles,
    workingDirectory
  ]);

  const addPane = useCallback(async () => {
    const provider =
      createPaneDialog.provider_mode === "preset"
        ? createPaneDialog.provider
        : createPaneDialog.custom_provider.trim().toLowerCase();
    if (!provider) {
      messageApi.warning("请填写自定义 Provider");
      return;
    }
    const autoTitle = buildAutoPaneTitle(provider, panes);
    const title =
      createPaneDialog.title_mode === "custom"
        ? createPaneDialog.custom_title.trim() || autoTitle
        : autoTitle;
    const sessionParsePreset = normalizeSessionParsePreset(createPaneDialog.session_parse_preset);
    const sessionScanGlob = createPaneDialog.session_scan_glob.trim();
    if (createPaneDialog.provider_mode === "custom" && !sessionScanGlob) {
      messageApi.warning("自定义 Provider 必须填写扫描会话通配路径");
      return;
    }
    const sessionParseJson = (createPaneDialog.session_parse_json.trim() || createPaneParserJsonPreview).trim();
    setCreatePaneDialog((current) => ({ ...current, creating: true }));
    try {
      const summary = await invoke<PaneSummary>("create_pane", {
        provider,
        title,
        sessionParsePreset,
        sessionScanGlob: sessionScanGlob || null,
        sessionParseJson: sessionParseJson || null
      });
      setPanes((current) => {
        const sharedProgressPane = current.find(
          (pane) =>
            pane.provider === summary.provider &&
            (pane.scan_running || pane.scan_total_files > 0 || pane.scan_processed_files > 0)
        );
        const nextPane = {
          ...createPaneView(summary),
          scan_running: sharedProgressPane?.scan_running ?? false,
          scan_total_files: sharedProgressPane?.scan_total_files ?? 0,
          scan_processed_files: sharedProgressPane?.scan_processed_files ?? 0,
          scan_changed_files: sharedProgressPane?.scan_changed_files ?? 0
        };
        return [...current, nextPane];
      });
      setActivePaneId(summary.id);
      await invoke<boolean>("ensure_pane_runtime", { paneId: summary.id });
      void hydratePaneSessionState(summary.id);
      void refreshScanProgress(summary.id);
      void shouldWarmupNativeSessionCache(summary.id).then((shouldWarmup) => {
        if (shouldWarmup) {
          void warmupNativeSessionCache(summary.id, true);
        }
      });
      setCreatePaneDialog(createCreatePaneDialogState(provider, sessionParserProfiles));
      setCreatePanePathTarget("rule_content_text_paths");
      setCreatePaneSampleViewMode("root");
      setCreatePaneSamplePreview({
        loading: false,
        error: "",
        parser_profile: "",
        file_path: "",
        file_format: "",
        sample_value: null,
        message_sample_value: null
      });
      messageApi.success(`已创建 ${asTitle(provider)} 终端`);
    } catch (error) {
      console.error(error);
      messageApi.error("创建终端失败");
      setCreatePaneDialog((current) => ({ ...current, creating: false }));
    }
  }, [
    createPaneDialog,
    createPaneParserJsonPreview,
    hydratePaneSessionState,
    messageApi,
    panes,
    refreshScanProgress,
    sessionParserProfiles,
    shouldWarmupNativeSessionCache,
    warmupNativeSessionCache
  ]);

  const changePaneDirectory = useCallback(async (paneId: string, targetPath: string) => {
    const trimmed = targetPath.trim();
    if (!trimmed) {
      return;
    }
    const escaped = trimmed.replace(/"/g, '\\"');
    await invoke<void>("write_to_pane", { paneId, data: `cd "${escaped}"\r` });
  }, []);

  const addTeam = useCallback(async () => {
    const provider =
      createPaneDialog.provider_mode === "preset"
        ? createPaneDialog.provider
        : createPaneDialog.custom_provider.trim().toLowerCase();
    if (!provider) {
      messageApi.warning("请填写自定义 Provider");
      return;
    }
    const teamRoot = createPaneDialog.team_directory.trim();
    if (!teamRoot) {
      messageApi.warning("请选择团队目录");
      return;
    }
    const roleCount = Math.max(1, Math.min(20, Math.round(createPaneDialog.team_role_count || 1)));
    const sessionParsePreset = normalizeSessionParsePreset(createPaneDialog.session_parse_preset);
    const sessionScanGlob = createPaneDialog.session_scan_glob.trim();
    if (createPaneDialog.provider_mode === "custom" && !sessionScanGlob) {
      messageApi.warning("自定义 Provider 必须填写扫描会话通配路径");
      return;
    }
    const sessionParseJson = (createPaneDialog.session_parse_json.trim() || createPaneParserJsonPreview).trim();
    setCreatePaneDialog((current) => ({ ...current, creating: true }));

    let createdCount = 0;
    let tempPanes = [...panes];
    try {
      const resolvedRoot = await invoke<string>("ensure_directory", { path: teamRoot });
      const workPath = await invoke<string>("ensure_directory", {
        path: joinFilesystemPath(resolvedRoot, TEAM_WORK_DIR_NAME)
      });
      const codePath = await invoke<string>("ensure_directory", {
        path: joinFilesystemPath(resolvedRoot, TEAM_CODE_DIR_NAME)
      });
      const rolePaths: string[] = [];
      for (let index = 1; index <= roleCount; index += 1) {
        const rolePath = await invoke<string>("ensure_directory", {
          path: joinFilesystemPath(workPath, `role-${index}`)
        });
        rolePaths.push(rolePath);
      }

      for (const targetPath of rolePaths) {
        const autoTitle = buildAutoPaneTitle(provider, tempPanes);
        const title = createPaneDialog.title_mode === "custom"
          ? (createPaneDialog.custom_title.trim() || autoTitle)
          : autoTitle;
        const summary = await invoke<PaneSummary>("create_pane", {
          provider,
          title,
          sessionParsePreset,
          sessionScanGlob: sessionScanGlob || null,
          sessionParseJson: sessionParseJson || null
        });
        createdCount += 1;
        tempPanes = [...tempPanes, createPaneView(summary)];
        setPanes((current) => {
          const sharedProgressPane = current.find(
            (pane) =>
              pane.provider === summary.provider &&
              (pane.scan_running || pane.scan_total_files > 0 || pane.scan_processed_files > 0)
          );
          const nextPane = {
            ...createPaneView(summary),
            scan_running: sharedProgressPane?.scan_running ?? false,
            scan_total_files: sharedProgressPane?.scan_total_files ?? 0,
            scan_processed_files: sharedProgressPane?.scan_processed_files ?? 0,
            scan_changed_files: sharedProgressPane?.scan_changed_files ?? 0
          };
          return [...current, nextPane];
        });
        setActivePaneId(summary.id);
        await invoke<boolean>("ensure_pane_runtime", { paneId: summary.id });
        await changePaneDirectory(summary.id, targetPath);
        void hydratePaneSessionState(summary.id);
        void refreshScanProgress(summary.id);
        void shouldWarmupNativeSessionCache(summary.id).then((shouldWarmup) => {
          if (shouldWarmup) {
            void warmupNativeSessionCache(summary.id, true);
          }
        });
      }

      setCreatePaneDialog(createCreatePaneDialogState(provider, sessionParserProfiles, resolvedRoot, roleCount));
      setCreatePanePathTarget("rule_content_text_paths");
      setCreatePaneSampleViewMode("root");
      setCreatePaneSamplePreview({
        loading: false,
        error: "",
        parser_profile: "",
        file_path: "",
        file_format: "",
        sample_value: null,
        message_sample_value: null
      });
      messageApi.success(`已创建团队（${createdCount}个终端）`);
    } catch (error) {
      console.error(error);
      if (createdCount > 0) {
        messageApi.warning(`已创建 ${createdCount} 个终端，剩余创建失败`);
      } else {
        messageApi.error("创建团队失败");
      }
      setCreatePaneDialog((current) => ({ ...current, creating: false }));
    }
  }, [
    changePaneDirectory,
    createPaneDialog,
    createPaneParserJsonPreview,
    hydratePaneSessionState,
    messageApi,
    panes,
    refreshScanProgress,
    sessionParserProfiles,
    shouldWarmupNativeSessionCache,
    warmupNativeSessionCache
  ]);

  const closePane = useCallback(
    async (paneId: string) => {
      try {
        await invoke<void>("close_pane", { paneId });
        disposeTerminal(paneId);
        setPanes((current) => current.filter((pane) => pane.id !== paneId));
        setActivePaneId((current) => {
          if (current !== paneId) {
            return current;
          }
          const fallback = panes.find((pane) => pane.id !== paneId);
          return fallback?.id || "";
        });
      } catch (error) {
        console.error(error);
        messageApi.error("关闭终端失败");
      }
    },
    [disposeTerminal, messageApi, panes]
  );

  const readPaneSessionIdFromTerminal = useCallback(
    async (paneId: string): Promise<string> => {
      const normalizedPaneId = paneId.trim();
      const pane = panes.find((item) => item.id === normalizedPaneId);
      const runtime = terminalsRef.current.get(normalizedPaneId);
      if (!normalizedPaneId || !pane || !runtime) {
        return "";
      }
      const initialOutput = paneOutputProbeRef.current.get(normalizedPaneId) ?? {
        revision: 0,
        text: ""
      };
      const observedText = `${initialOutput.text}\n${readTerminalScreenText(runtime.term)}`;
      const resolved = resolveSidProbeProfile(pane.provider, observedText);
      if (!resolved) {
        return "";
      }

      const token = (sidProbeTokenRef.current.get(normalizedPaneId) ?? 0) + 1;
      sidProbeTokenRef.current.set(normalizedPaneId, token);
      const probeProvider = resolved.provider;
      const profile = resolved.profile;
      const initialRevision = initialOutput.revision;
      const initialTextLength = initialOutput.text.length;

      let commandText = profile.command;
      if (commandText.startsWith("/")) {
        await invoke<void>("write_to_pane", { paneId: normalizedPaneId, data: "/" });
        await new Promise<void>((resolve) =>
          window.setTimeout(resolve, profile.slash_activation_delay_ms ?? profile.key_delay_ms ?? 36)
        );

        const slashDeadline = Date.now() + Math.max(1200, profile.poll_ms * 8);
        while (Date.now() < slashDeadline) {
          if ((sidProbeTokenRef.current.get(normalizedPaneId) ?? 0) !== token) {
            return "";
          }
          const screenText = readTerminalScreenText(runtime.term);
          if (isProviderSlashModeReady(screenText, probeProvider)) {
            break;
          }
          await new Promise<void>((resolve) => window.setTimeout(resolve, profile.poll_ms));
        }

        commandText = commandText.slice(1);
      }

      for (const char of commandText) {
        if ((sidProbeTokenRef.current.get(normalizedPaneId) ?? 0) !== token) {
          return "";
        }
        await invoke<void>("write_to_pane", { paneId: normalizedPaneId, data: char });
        await new Promise<void>((resolve) => window.setTimeout(resolve, profile.key_delay_ms ?? 18));
      }

      await new Promise<void>((resolve) => window.setTimeout(resolve, profile.submit_delay_ms ?? 80));
      await invoke<void>("write_to_pane", { paneId: normalizedPaneId, data: "\r" });

      const deadline = Date.now() + profile.timeout_ms;
      while (Date.now() < deadline) {
        if ((sidProbeTokenRef.current.get(normalizedPaneId) ?? 0) !== token) {
          return "";
        }
        const outputState = paneOutputProbeRef.current.get(normalizedPaneId) ?? {
          revision: 0,
          text: ""
        };
        const candidateText =
          outputState.revision > initialRevision && outputState.text.length >= initialTextLength
            ? outputState.text.slice(initialTextLength)
            : outputState.text;
        const sid = extractSidFromTerminalProbeText(
          `${candidateText}\n${readTerminalScreenText(runtime.term)}`,
          probeProvider
        );
        if (sid) {
          if (profile.cleanup_data) {
            void invoke<void>("write_to_pane", { paneId: normalizedPaneId, data: profile.cleanup_data }).catch(
              (error) => console.error(error)
            );
          }
          return sid;
        }
        await new Promise<void>((resolve) => window.setTimeout(resolve, profile.poll_ms));
      }

      if (profile.cleanup_data) {
        void invoke<void>("write_to_pane", { paneId: normalizedPaneId, data: profile.cleanup_data }).catch(
          (error) => console.error(error)
        );
      }
      return "";
    },
    [panes]
  );

  const detectSid = useCallback(
    async (paneId: string) => {
      const pane = panes.find((item) => item.id === paneId);
      if (!pane || pane.sid_checking) {
        return;
      }
      updatePane(paneId, (current) => ({ ...current, sid_checking: true }));
      try {
        const suggested = await readPaneSessionIdFromTerminal(paneId);
        if (suggested && suggested.trim()) {
          await setPaneSessionState(paneId, suggested.trim(), pane?.linked_session_ids ?? []);
          messageApi.success(`已读取状态信息并绑定 SID: ${shortSessionId(suggested)}`);
        } else {
          messageApi.info("未从状态信息中读取到 Session ID");
        }
      } catch (error) {
        console.error(error);
        messageApi.error("读取状态信息绑定 SID 失败");
      } finally {
        updatePane(paneId, (pane) => ({ ...pane, sid_checking: false }));
      }
    },
    [messageApi, panes, readPaneSessionIdFromTerminal, setPaneSessionState, updatePane]
  );

  const closeSyncDialog = useCallback(() => {
    setSyncDialogGroupTab("current");
    setSyncSessionListState(createSyncSessionListState());
    setSyncShowSelectedOnly(false);
    syncDialogEntryCacheRef.current.clear();
    setSyncDialog(createSyncDialogState());
  }, []);

  const openSyncDialog = useCallback(
    async (paneId: string) => {
      const pane = panes.find((item) => item.id === paneId);
      if (!pane) {
        return;
      }
      const cachedPanel = getSessionListPanelState(paneId);
      const fallbackTargetPaneId = panes.find((item) => item.id !== paneId)?.id ?? "";
      const cachedItems =
        cachedPanel.all_items.length > 0 ? cachedPanel.all_items : cachedPanel.items;
      const initialSessionItems = sortSessionCandidatesByMode(cachedItems, "updated_desc");
      const defaultSelectedSessionIds: string[] = [];
      const defaultPreviewSessionId = "";
      setSyncDialogGroupTab("current");
      setSyncShowSelectedOnly(false);
      syncDialogEntryCacheRef.current.clear();
      setSyncSessionListState({
        ...createSyncSessionListState(paneId),
        loading: initialSessionItems.length === 0,
        all_items: initialSessionItems,
        items: initialSessionItems,
        total: cachedPanel.total > 0 ? cachedPanel.total : initialSessionItems.length
      });
      setSyncDialog({
        open: true,
        pane_id: paneId,
        loading: true,
        importing: false,
        syncing: false,
        target_pane_id: fallbackTargetPaneId,
        preview_session_id: defaultPreviewSessionId,
        strategy: "turn_3",
        selected_session_ids: defaultSelectedSessionIds,
        included_entry_ids: [],
        excluded_entry_ids: [],
        preview_query: "",
        preview_kind: "all",
        progress_stage: "idle",
        progress_percent: 0,
        progress_text: syncProgressText("idle"),
        entries: []
      });
      try {
        if (initialSessionItems.length === 0) {
          await reloadSyncSessionList(paneId, undefined, defaultPreviewSessionId);
        }
        setSyncDialog((current) => {
          if (!current.open || current.pane_id !== paneId) {
            return current;
          }
          return {
            ...current,
            loading: false,
            progress_stage: "idle",
            progress_percent: 0,
            progress_text: syncProgressText("idle")
          };
        });
      } catch (error) {
        console.error(error);
        messageApi.error("加载同步预览失败");
        setSyncDialog((current) => ({ ...current, loading: false }));
        setSyncSessionListState((current) => ({ ...current, loading: false }));
      }
    },
    [getSessionListPanelState, messageApi, panes]
  );

  const reloadSyncDialogEntries = useCallback(async () => {
    const paneId = syncDialog.pane_id;
    if (!syncDialog.open || !paneId || syncDialog.loading || syncDialog.syncing) {
      return;
    }
    setSyncDialog((current) => ({
      ...current,
      loading: true,
      progress_stage: "idle",
      progress_percent: 0,
      progress_text: syncProgressText("idle")
    }));
    try {
      const sessionIds = parseSessionIds([
        ...syncDialog.selected_session_ids,
        syncDialog.preview_session_id
      ]);
      syncDialogEntryCacheRef.current.clear();
      await Promise.all(sessionIds.map((sid) => ensureSyncDialogSessionLoaded(paneId, sid, true)));
      setSyncDialog((current) => ({
        ...current,
        loading: false,
        excluded_entry_ids: current.excluded_entry_ids.filter((id) =>
          current.entries.some((row) => row.id === id)
        )
      }));
    } catch (error) {
      console.error(error);
      setSyncDialog((current) => ({ ...current, loading: false }));
      messageApi.error("刷新同步预览失败");
    }
  }, [
    messageApi,
    syncDialog.loading,
    syncDialog.open,
    syncDialog.pane_id,
    syncDialog.preview_session_id,
    syncDialog.selected_session_ids,
    syncDialog.syncing
  ]);

  const toggleSyncDialogSession = useCallback(
    (sessionId: string, checked: boolean) => {
      const sid = sessionId.trim();
      setSyncDialog((current) => {
        const nextSet = new Set(current.selected_session_ids);
        const nextIncluded = new Set(current.included_entry_ids);
        const nextExcluded = new Set(current.excluded_entry_ids);
        const sessionEntries = collectSyncSelectableSessionEntries(
          current.entries,
          sid,
          syncDialogCurrentSessionId,
          current.strategy,
          current.preview_kind,
          current.preview_query.trim().toLowerCase()
        );
        if (checked) {
          nextSet.add(sid);
          for (const entry of sessionEntries) {
            nextExcluded.delete(entry.id);
          }
          for (const entry of sessionEntries) {
            nextIncluded.delete(entry.id);
          }
        } else {
          nextSet.delete(sid);
          for (const entry of sessionEntries) {
            nextExcluded.add(entry.id);
            nextIncluded.delete(entry.id);
          }
        }
        return {
          ...current,
          selected_session_ids: [...nextSet],
          included_entry_ids: [...nextIncluded],
          excluded_entry_ids: [...nextExcluded]
        };
      });
    },
    [syncDialogCurrentSessionId]
  );

  const setSyncDialogPreviewSession = useCallback((sessionId: string) => {
    setSyncDialog((current) => ({
      ...current,
      preview_session_id: sessionId
    }));
  }, []);

  const toggleSyncDialogEntryExcluded = useCallback(
    (entryId: string, excluded: boolean) => {
      setSyncDialog((current) => {
        const targetEntry = current.entries.find((entry) => entry.id === entryId);
        if (!targetEntry) {
          return current;
        }

        const sessionId = resolveEntrySessionId(targetEntry, syncDialogCurrentSessionId);
        const nextSelected = new Set(current.selected_session_ids);
        const nextExcluded = new Set(current.excluded_entry_ids);
        const nextIncluded = new Set(current.included_entry_ids);
        const sessionEntries = collectSyncSelectableSessionEntries(
          current.entries,
          sessionId,
          syncDialogCurrentSessionId,
          current.strategy,
          current.preview_kind,
          current.preview_query.trim().toLowerCase()
        );

        if (excluded) {
          if (sessionId && nextSelected.has(sessionId)) {
            nextExcluded.add(entryId);
            if (
              sessionEntries.length > 0 &&
              sessionEntries.every((entry) => nextExcluded.has(entry.id))
            ) {
              nextSelected.delete(sessionId);
            }
          } else {
            nextIncluded.delete(entryId);
          }
        } else {
          if (sessionId && nextSelected.has(sessionId)) {
            nextExcluded.delete(entryId);
          } else {
            nextIncluded.add(entryId);
          }
        }

        return {
          ...current,
          selected_session_ids: [...nextSelected],
          included_entry_ids: [...nextIncluded],
          excluded_entry_ids: [...nextExcluded]
        };
      });
    },
    [syncDialogCurrentSessionId]
  );

  const excludeSyncDialogSessionGroup = useCallback(
    (sessionId: string) => {
      setSyncDialog((current) => {
        if (sessionId !== SYNC_UNKNOWN_SESSION_ID) {
          if (!current.selected_session_ids.includes(sessionId)) {
            return current;
          }
          return {
            ...current,
            selected_session_ids: current.selected_session_ids.filter((sid) => sid !== sessionId),
            included_entry_ids: current.included_entry_ids.filter((id) => {
              const entry = current.entries.find((item) => item.id === id);
              return entry ? resolveEntrySessionId(entry, syncDialogCurrentSessionId) !== sessionId : true;
            })
          };
        }
        const ids = syncDialogFilteredEntriesAllSessions
          .filter((entry) => {
            const sid = resolveEntrySessionId(entry, syncDialogCurrentSessionId) || SYNC_UNKNOWN_SESSION_ID;
            return sid === SYNC_UNKNOWN_SESSION_ID;
          })
          .map((entry) => entry.id);
        if (ids.length === 0) {
          return current;
        }
        const next = new Set(current.excluded_entry_ids);
        for (const id of ids) {
          next.add(id);
        }
        return {
          ...current,
          excluded_entry_ids: [...next]
        };
      });
    },
    [syncDialogCurrentSessionId, syncDialogFilteredEntriesAllSessions]
  );

  const includeSyncDialogSessionGroup = useCallback(
    (sessionId: string) => {
      setSyncDialog((current) => {
        if (sessionId !== SYNC_UNKNOWN_SESSION_ID) {
          const nextSelected = new Set(current.selected_session_ids);
          nextSelected.add(sessionId);
          const excludedSet = new Set(current.excluded_entry_ids);
          for (const entry of current.entries) {
            const sid = resolveEntrySessionId(entry, syncDialogCurrentSessionId) || SYNC_UNKNOWN_SESSION_ID;
            if (sid === sessionId) {
              excludedSet.delete(entry.id);
            }
          }
          return {
            ...current,
            selected_session_ids: [...nextSelected],
            included_entry_ids: current.included_entry_ids.filter((id) => {
              const entry = current.entries.find((item) => item.id === id);
              return entry ? resolveEntrySessionId(entry, syncDialogCurrentSessionId) !== sessionId : true;
            }),
            excluded_entry_ids: [...excludedSet]
          };
        }
        const idSet = new Set(
          syncDialogFilteredEntriesAllSessions
            .filter((entry) => {
              const sid = resolveEntrySessionId(entry, syncDialogCurrentSessionId) || SYNC_UNKNOWN_SESSION_ID;
              return sid === SYNC_UNKNOWN_SESSION_ID;
            })
            .map((entry) => entry.id)
        );
        if (idSet.size === 0) {
          return current;
        }
        return {
          ...current,
          excluded_entry_ids: current.excluded_entry_ids.filter((id) => !idSet.has(id))
        };
      });
    },
    [syncDialogCurrentSessionId, syncDialogFilteredEntriesAllSessions]
  );

  const excludeSyncDialogFilteredEntries = useCallback(() => {
    setSyncDialog((current) => {
      if (!syncDialogFilteredEntries.length) {
        return current;
      }
      const idSet = new Set(syncDialogFilteredEntries.map((entry) => entry.id));
      const next = new Set(current.excluded_entry_ids);
      const nextSelected = new Set(current.selected_session_ids);
      const touchedSessions = new Set<string>();
      for (const entry of syncDialogFilteredEntries) {
        next.add(entry.id);
        const sid = resolveEntrySessionId(entry, syncDialogCurrentSessionId);
        if (sid) {
          touchedSessions.add(sid);
        }
      }
      for (const sessionId of touchedSessions) {
        const sessionEntries = collectSyncSelectableSessionEntries(
          current.entries,
          sessionId,
          syncDialogCurrentSessionId,
          current.strategy,
          current.preview_kind,
          current.preview_query.trim().toLowerCase()
        );
        if (sessionEntries.length > 0 && sessionEntries.every((entry) => next.has(entry.id))) {
          nextSelected.delete(sessionId);
        }
      }
      return {
        ...current,
        selected_session_ids: [...nextSelected],
        included_entry_ids: current.included_entry_ids.filter((id) => !idSet.has(id)),
        excluded_entry_ids: [...next]
      };
    });
  }, [syncDialogCurrentSessionId, syncDialogFilteredEntries]);

  const includeSyncDialogFilteredEntries = useCallback(() => {
    setSyncDialog((current) => {
      if (!syncDialogFilteredEntries.length) {
        return current;
      }
      const idSet = new Set(syncDialogFilteredEntries.map((entry) => entry.id));
      const nextSelected = new Set(current.selected_session_ids);
      for (const entry of syncDialogFilteredEntries) {
        const sid = resolveEntrySessionId(entry, syncDialogCurrentSessionId);
        if (sid) {
          nextSelected.add(sid);
        }
      }
      return {
        ...current,
        selected_session_ids: [...nextSelected],
        included_entry_ids: current.included_entry_ids.filter((id) => !idSet.has(id)),
        excluded_entry_ids: current.excluded_entry_ids.filter((id) => !idSet.has(id))
      };
    });
  }, [syncDialogCurrentSessionId, syncDialogFilteredEntries]);

  const mapNativePreviewRowsToEntries = useCallback(
    (paneId: string, sessionId: string, rows: NativeSessionPreviewRow[]): EntryRecord[] =>
      rows.map((row, index) => ({
        id: row.id || `${sessionId}-${row.created_at}-${index}-${row.kind}`,
        pane_id: paneId,
        kind: row.kind,
        content: row.content,
        synced_from: buildNativePreviewTag(sessionId),
        created_at: row.created_at,
        preview_truncated: Boolean(row.preview_truncated)
      })),
    []
  );

  const mergeSyncDialogCachedEntries = useCallback((paneId: string) => {
    const merged = [...syncDialogEntryCacheRef.current.values()]
      .flat()
      .sort(compareEntryByTime);
    setSyncDialog((current) =>
      current.pane_id === paneId
        ? {
            ...current,
            entries: merged
          }
        : current
    );
  }, []);

  const loadSyncDialogSessionEntries = useCallback(
    async (paneId: string, sessionId: string): Promise<EntryRecord[]> => {
      const response = await invoke<NativeSessionPreviewResponse>("preview_native_session_messages", {
        paneId,
        sessionId,
        limit: 5000,
        loadAll: true
      });
      return mapNativePreviewRowsToEntries(paneId, sessionId, response.rows || []);
    },
    [mapNativePreviewRowsToEntries]
  );

  const ensureSyncDialogSessionLoaded = useCallback(
    async (paneId: string, sessionId: string, force = false): Promise<EntryRecord[]> => {
      const sid = sessionId.trim();
      if (!paneId || !sid) {
        return [];
      }

      const cached = syncDialogEntryCacheRef.current.get(sid);
      if (cached && !force) {
        return cached;
      }

      const rows = await loadSyncDialogSessionEntries(paneId, sid);
      syncDialogEntryCacheRef.current.set(sid, rows);
      mergeSyncDialogCachedEntries(paneId);
      return rows;
    },
    [loadSyncDialogSessionEntries, mergeSyncDialogCachedEntries]
  );

  const collectSyncDialogSelectedEntries = useCallback(
    (entries: EntryRecord[]) => {
      const selectedSet = new Set(syncDialog.selected_session_ids);
      const excludedSet = new Set(syncDialog.excluded_entry_ids);
      const includedSet = new Set(syncDialog.included_entry_ids);
      return entries.filter((entry) => {
        const sid = resolveEntrySessionId(entry, syncDialogCurrentSessionId);
        if (sid && selectedSet.has(sid)) {
          return !excludedSet.has(entry.id);
        }
        return includedSet.has(entry.id);
      });
    },
    [
      syncDialog.excluded_entry_ids,
      syncDialog.included_entry_ids,
      syncDialog.selected_session_ids,
      syncDialogCurrentSessionId
    ]
  );

  const ensureSyncDialogSessionsLoaded = useCallback(
    async (paneId: string, sessionIds: string[], force = false): Promise<EntryRecord[]> => {
      const explicitIncludedSessionIds = syncDialog.included_entry_ids
        .map((id) => syncDialog.entries.find((entry) => entry.id === id))
        .filter((entry): entry is EntryRecord => Boolean(entry))
        .map((entry) => resolveEntrySessionId(entry, syncDialogCurrentSessionId));
      const ids = parseSessionIds([...sessionIds, ...explicitIncludedSessionIds]);
      if (!paneId || !ids.length) {
        return [];
      }

      await Promise.all(ids.map((sid) => ensureSyncDialogSessionLoaded(paneId, sid, force)));
      return [...syncDialogEntryCacheRef.current.values()].flat().sort(compareEntryByTime);
    },
    [ensureSyncDialogSessionLoaded, syncDialog.entries, syncDialog.included_entry_ids, syncDialogCurrentSessionId]
  );

  const hydrateSyncDialogEntriesWithFullContent = useCallback(
    async (paneId: string, entries: EntryRecord[]): Promise<EntryRecord[]> => {
      if (!paneId || !entries.length) {
        return entries;
      }

      const selectionMap = new Map<string, NativeSessionMessageSelection>();
      entries.forEach((entry) => {
        const sessionId = resolveEntrySessionId(entry, syncDialogCurrentSessionId);
        if (!sessionId || sessionId === SYNC_UNKNOWN_SESSION_ID) {
          return;
        }
        const cacheKey = `${sessionId}::${entry.id}`;
        if (!selectionMap.has(cacheKey)) {
          selectionMap.set(cacheKey, {
            messageId: entry.id,
            sessionId
          });
        }
      });

      if (!selectionMap.size) {
        return entries;
      }

      const details = await invoke<NativeSessionMessageDetailResponse[]>(
        "get_native_session_message_details",
        {
          paneId,
          messages: [...selectionMap.values()]
        }
      );
      const detailMap = new Map(
        details.map((detail) => [`${detail.session_id}::${detail.message_id}`, detail] as const)
      );

      return entries.map((entry) => {
        const sessionId = resolveEntrySessionId(entry, syncDialogCurrentSessionId);
        if (!sessionId || sessionId === SYNC_UNKNOWN_SESSION_ID) {
          return entry;
        }
        const detail = detailMap.get(`${sessionId}::${entry.id}`);
        if (!detail) {
          return entry;
        }
        return {
          ...entry,
          kind: detail.kind || entry.kind,
          content: typeof detail.content === "string" ? detail.content : entry.content,
          created_at: detail.created_at > 0 ? detail.created_at : entry.created_at,
          preview_truncated: false
        };
      });
    },
    [syncDialogCurrentSessionId]
  );

  const buildSyncDialogPlainPayload = useCallback(
    async (entries: EntryRecord[]) => {
      if (!entries.length) {
        return "";
      }

      return entries
        .map((entry) => {
          const content = sanitizeSyncPlainTextContent(entry.content);
          if (!content) {
            return "";
          }
          const rolePrefix =
            entry.kind === "input"
              ? "用户"
              : entry.kind === "output"
                ? "助手"
                : entry.kind.trim() || "消息";
          return `${rolePrefix}: ${content}`;
        })
        .filter((content) => content.length > 0)
        .join("\n");
    },
    []
  );

  const mapEntriesToPreviewRows = useCallback(
    (entries: EntryRecord[]): NativeSessionPreviewRow[] =>
      entries.map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        content: entry.content,
        created_at: entry.created_at,
        preview_truncated: Boolean(entry.preview_truncated)
      })),
    []
  );

  const loadSyncDialogPreviewSession = useCallback(
    async (
      paneId: string,
      sessionId: string,
      requestedLimit = 10,
      fromEnd = false,
      offset = 0,
      mergeMode: "replace" | "prepend" | "append" = "replace"
    ) => {
      const sid = sessionId.trim();
      if (!paneId || !sid) {
        setSyncDialogPreview(createSyncDialogPreviewState());
        return;
      }

      const ticket = syncDialogPreviewTicketRef.current + 1;
      syncDialogPreviewTicketRef.current = ticket;
      setSyncDialogPreview((current) => ({
        ...current,
        preview_session_id: sid,
        preview_loading: true
      }));

      try {
        const response = await invoke<NativeSessionPreviewResponse>("preview_native_session_messages", {
          paneId,
          sessionId: sid,
          limit: requestedLimit,
          offset,
          loadAll: false,
          fromEnd
        });
        const mappedRows = mapNativePreviewRowsToEntries(paneId, sid, response.rows || []);
        const existingRows = syncDialogEntryCacheRef.current.get(sid) || [];
        const mergedRows = [...existingRows, ...mappedRows]
          .filter((entry, index, list) => list.findIndex((item) => item.id === entry.id) === index)
          .sort(compareEntryByTime);
        syncDialogEntryCacheRef.current.set(sid, mergedRows);
        mergeSyncDialogCachedEntries(paneId);
        if (syncDialogPreviewTicketRef.current !== ticket) {
          return;
        }
        setSyncDialogPreview((current) => {
          const incomingRows = response.rows || [];
          const nextRows =
            mergeMode === "prepend" && current.preview_session_id === sid
              ? [...incomingRows, ...current.preview_rows]
              : mergeMode === "append" && current.preview_session_id === sid
                ? [...current.preview_rows, ...incomingRows]
                : incomingRows;
          return {
            preview_session_id: sid,
            preview_loading: false,
            preview_rows: nextRows,
            preview_total_rows: Number(response.total_rows || 0),
            preview_loaded_rows: nextRows.length,
            preview_has_more: Boolean(response.has_more),
            preview_from_end: fromEnd
          };
        });
      } catch (error) {
        if (syncDialogPreviewTicketRef.current !== ticket) {
          return;
        }
        console.error(error);
        setSyncDialogPreview((current) => ({ ...current, preview_loading: false }));
        messageApi.error("加载同步预览失败");
      }
    },
    [mapNativePreviewRowsToEntries, mergeSyncDialogCachedEntries, messageApi]
  );

  const loadMoreSyncDialogPreviewRows = useCallback(async () => {
    const paneId = syncDialog.pane_id;
    const sessionId = syncDialogPreview.preview_session_id.trim();
    if (!paneId || !sessionId || syncDialogPreview.preview_loading || !syncDialogPreview.preview_has_more) {
      return;
    }
    await loadSyncDialogPreviewSession(
      paneId,
      sessionId,
      10,
      syncDialogPreview.preview_from_end,
      syncDialogPreview.preview_loaded_rows,
      syncDialogPreview.preview_from_end ? "prepend" : "append"
    );
  }, [
    loadSyncDialogPreviewSession,
    syncDialog.pane_id,
    syncDialogPreview.preview_from_end,
    syncDialogPreview.preview_has_more,
    syncDialogPreview.preview_loading,
    syncDialogPreview.preview_session_id
  ]);

  const jumpSyncDialogPreviewToStart = useCallback(async () => {
    const paneId = syncDialog.pane_id;
    const sid = syncDialogPreview.preview_session_id.trim();
    if (paneId && sid) {
      await loadSyncDialogPreviewSession(paneId, sid, 10, false, 0, "replace");
      return;
    }
    setSyncDialogPreviewScrollCommand((current) => ({
      target: "top",
      nonce: (current?.nonce || 0) + 1
    }));
  }, [loadSyncDialogPreviewSession, syncDialog.pane_id, syncDialogPreview.preview_session_id]);

  const jumpSyncDialogPreviewToLatest = useCallback(async () => {
    const paneId = syncDialog.pane_id;
    const sid = syncDialogPreview.preview_session_id.trim();
    if (paneId && sid) {
      const loadedEntries = await ensureSyncDialogSessionLoaded(paneId, sid);
      const sessionEntries = collectSyncSelectableSessionEntries(
        loadedEntries,
        sid,
        syncDialogCurrentSessionId,
        syncDialog.strategy,
        syncDialog.preview_kind,
        syncDialog.preview_query.trim().toLowerCase()
      ).sort(compareEntryByTime);
      const latestEntries = sessionEntries.slice(-10);
      setSyncDialogPreview({
        preview_session_id: sid,
        preview_loading: false,
        preview_rows: mapEntriesToPreviewRows(latestEntries),
        preview_total_rows: sessionEntries.length,
        preview_loaded_rows: latestEntries.length,
        preview_has_more: latestEntries.length < sessionEntries.length,
        preview_from_end: true
      });
      setSyncDialogPreviewScrollCommand((current) => ({
        target: "bottom",
        nonce: (current?.nonce || 0) + 1
      }));
      return;
    }
    setSyncDialogPreviewScrollCommand((current) => ({
      target: "bottom",
      nonce: (current?.nonce || 0) + 1
    }));
  }, [
    collectSyncSelectableSessionEntries,
    ensureSyncDialogSessionLoaded,
    mapEntriesToPreviewRows,
    syncDialog.pane_id,
    syncDialog.preview_kind,
    syncDialog.preview_query,
    syncDialog.strategy,
    syncDialogCurrentSessionId,
    syncDialogPreview.preview_session_id
  ]);

  const previewSyncDialogSession = useCallback(
    async (paneId: string, sessionId: string) => {
      const sid = sessionId.trim();
      if (!paneId || !sid) {
        return;
      }
      setSyncDialog((current) => ({ ...current, loading: true }));
      try {
        await loadSyncDialogPreviewSession(paneId, sid, 10, true, 0, "replace");
        setSyncDialog((current) => ({
          ...current,
          loading: false,
          preview_session_id: sid
        }));
      } catch (error) {
        console.error(error);
        setSyncDialog((current) => ({ ...current, loading: false }));
        messageApi.error("加载会话预览失败");
      }
    },
    [loadSyncDialogPreviewSession, messageApi]
  );

  function renderSyncDialogSessionToolbar() {
    return (
      <div className="sync-dialog-selection-toolbar">
      <div className="session-list-toolbar">
        <Card size="small" className="session-sort-toolbar">
          <div className="session-sort-toolbar-inner">
            <Space size={8} className="session-sort-buttons" wrap>
              <Button
                size="small"
                type={syncDialogSortState.field === "created" ? "primary" : "default"}
                onClick={() => toggleSyncSessionSortField("created")}
              >
                创建时间
                {syncDialogSortState.field === "created"
                  ? syncDialogSortState.order === "asc"
                    ? " ↑"
                    : " ↓"
                  : ""}
              </Button>
              <Button
                size="small"
                type={syncDialogSortState.field === "updated" ? "primary" : "default"}
                onClick={() => toggleSyncSessionSortField("updated")}
              >
                更新时间
                {syncDialogSortState.field === "updated"
                  ? syncDialogSortState.order === "asc"
                    ? " ↑"
                    : " ↓"
                  : ""}
              </Button>
              <Button
                size="small"
                type={syncDialogSortState.field === "records" ? "primary" : "default"}
                onClick={() => toggleSyncSessionSortField("records")}
              >
                记录数
                {syncDialogSortState.field === "records"
                  ? syncDialogSortState.order === "asc"
                    ? " ↑"
                    : " ↓"
                  : ""}
              </Button>
            </Space>
          </div>
        </Card>

        <Card size="small" className="session-filter-toolbar">
          <div className="sync-dialog-filter-grid">
            <div className="session-filter-row sync-dialog-filter-row-top">
              <Input
                allowClear
                placeholder="搜索 SID / 首条输入"
                value={syncDialogSessionListState.sid_keyword}
                onChange={(event) =>
                  setSyncSessionListState((current) => ({
                    ...current,
                    sid_keyword: event.target.value
                  }))
                }
                className="session-filter-input"
              />
              <Input
                type="datetime-local"
                value={syncDialogSessionListState.time_from}
                onChange={(event) =>
                  setSyncSessionListState((current) => ({
                    ...current,
                    time_from: event.target.value,
                    quick_time_preset: ""
                  }))
                }
                className="session-filter-time"
              />
              <Input
                type="datetime-local"
                value={syncDialogSessionListState.time_to}
                onChange={(event) =>
                  setSyncSessionListState((current) => ({
                    ...current,
                    time_to: event.target.value,
                    quick_time_preset: ""
                  }))
                }
                className="session-filter-time"
              />
            </div>

            <div className="session-filter-row sync-dialog-filter-row-bottom">
              <Space size={4} className="session-filter-presets" wrap>
                <Button
                  size="small"
                  type={syncDialogSessionListState.quick_time_preset === "3h" ? "primary" : "default"}
                  onClick={() => applySyncQuickTimePreset("3h")}
                >
                  3h
                </Button>
                <Button
                  size="small"
                  type={syncDialogSessionListState.quick_time_preset === "24h" ? "primary" : "default"}
                  onClick={() => applySyncQuickTimePreset("24h")}
                >
                  24h
                </Button>
                <Button
                  size="small"
                  type={syncDialogSessionListState.quick_time_preset === "3d" ? "primary" : "default"}
                  onClick={() => applySyncQuickTimePreset("3d")}
                >
                  3d
                </Button>
                <Button
                  size="small"
                  type={syncDialogSessionListState.quick_time_preset === "7d" ? "primary" : "default"}
                  onClick={() => applySyncQuickTimePreset("7d")}
                >
                  7d
                </Button>
                <Button
                  size="small"
                  type={syncDialogSessionListState.quick_time_preset === "30d" ? "primary" : "default"}
                  onClick={() => applySyncQuickTimePreset("30d")}
                >
                  30d
                </Button>
                <Button
                  size="small"
                  type={syncDialogSessionListState.quick_time_preset === "3m" ? "primary" : "default"}
                  onClick={() => applySyncQuickTimePreset("3m")}
                >
                  3m
                </Button>
                <Button
                  size="small"
                  type={syncDialogSessionListState.quick_time_preset === "1y" ? "primary" : "default"}
                  onClick={() => applySyncQuickTimePreset("1y")}
                >
                  1y
                </Button>
              </Space>
              <InputNumber
                min={0}
                value={syncDialogSessionListState.records_min}
                placeholder="最小记录数"
                onChange={(value) =>
                  setSyncSessionListState((current) => ({
                    ...current,
                    records_min: normalizeOptionalNonNegativeInt(value)
                  }))
                }
                className="session-filter-number"
              />
              <InputNumber
                min={0}
                value={syncDialogSessionListState.records_max}
                placeholder="最大记录数"
                onChange={(value) =>
                  setSyncSessionListState((current) => ({
                    ...current,
                    records_max: normalizeOptionalNonNegativeInt(value)
                  }))
                }
                className="session-filter-number"
              />
              <Button type="primary" icon={<SearchOutlined />} onClick={() => applySyncSessionFilters()}>
                应用筛选
              </Button>
              <Button onClick={() => resetSyncSessionFilters()}>清空筛选</Button>
              <Button
                onClick={() => void reloadSyncSessionList(syncDialog.pane_id)}
                loading={syncDialogSessionListState.loading}
              >
                刷新会话
              </Button>
            </div>
          </div>
        </Card>
      </div>
      </div>
    );
  }

  const submitSyncDialog = useCallback(async () => {
    const paneId = syncDialog.pane_id;
    const targetPaneId = syncDialog.target_pane_id.trim();
    if (!syncDialog.open || !paneId) {
      return;
    }
    if (!targetPaneId) {
      messageApi.warning("请先选择目标窗格");
      return;
    }
    const loadedEntries = await ensureSyncDialogSessionsLoaded(
      paneId,
      syncDialog.selected_session_ids,
      true
    );
    const selectedPreviewEntries = collectSyncDialogSelectedEntries(loadedEntries);
    if (!selectedPreviewEntries.length) {
      messageApi.warning("当前预览无可同步内容");
      return;
    }
    const selectedEntries = await hydrateSyncDialogEntriesWithFullContent(
      paneId,
      selectedPreviewEntries
    );
    const payload = await buildSyncDialogPlainPayload(selectedEntries);
    if (!payload.trim()) {
      messageApi.warning("当前选中消息为空");
      return;
    }
    setSyncDialog((current) => ({
      ...current,
      syncing: true,
      progress_stage: "filtering",
      progress_percent: 45,
      progress_text: syncProgressText("filtering")
    }));
    try {
      setSyncDialog((current) => ({
        ...current,
        progress_stage: "syncing",
        progress_percent: 75,
        progress_text: syncProgressText("syncing")
      }));
      await invoke<void>("sync_text_payload", {
        targetPaneId,
        payload
      });
      setSyncDialog((current) => ({
        ...current,
        syncing: false,
        progress_stage: "done",
        progress_percent: 100,
        progress_text: syncProgressText("done")
      }));
      messageApi.success(
        `同步完成：${selectedEntries.length} 条记录 -> ${
          panes.find((item) => item.id === targetPaneId)?.title || "目标窗格"
        }`
      );
    } catch (error) {
      console.error(error);
      setSyncDialog((current) => ({
        ...current,
        syncing: false,
        progress_stage: "error",
        progress_percent: 0,
        progress_text: syncProgressText("error")
      }));
      messageApi.error("同步失败");
    }
  }, [
    buildSyncDialogPlainPayload,
    collectSyncDialogSelectedEntries,
    ensureSyncDialogSessionsLoaded,
    hydrateSyncDialogEntriesWithFullContent,
    messageApi,
    panes,
    syncDialog.open,
    syncDialog.pane_id,
    syncDialog.target_pane_id,
    syncDialog.selected_session_ids
  ]);

  const openSendDialog = useCallback((paneId: string) => {
    setSendDialog({
      open: true,
      pane_id: paneId,
      input: "",
      sending: false
    });
  }, []);

  const submitSendDialog = useCallback(async () => {
    const paneId = sendDialog.pane_id;
    const input = sendDialog.input.trim();
    if (!paneId || !input) {
      messageApi.warning("请输入发送内容");
      return;
    }
    setSendDialog((current) => ({ ...current, sending: true }));
    try {
      const payload = input.endsWith("\n") ? input : `${input}\n`;
      await invoke<void>("send_to_pane", { paneId, input: payload });
      messageApi.success("已发送到终端");
      setSendDialog(createSendDialogState());
    } catch (error) {
      console.error(error);
      messageApi.error("发送失败");
      setSendDialog((current) => ({ ...current, sending: false }));
    }
  }, [messageApi, sendDialog.input, sendDialog.pane_id]);

  const openSessionManageDialog = useCallback(
    (paneId: string, viewMode: SessionManageDialogState["view_mode"] = "manage") => {
      const pane = panes.find((item) => item.id === paneId);
      if (!pane) {
        return;
      }
      const panel = getSessionListPanelState(pane.id);
      const previewSessionId = viewMode === "list" ? pane.active_session_id.trim() : panel.preview_session_id;
      setSessionManageDialog({
        open: true,
        pane_id: pane.id,
        active_session_id: pane.active_session_id,
        linked_session_ids: [...pane.linked_session_ids],
        saving: false,
        view_mode: viewMode
      });
      setSessionManagePreview({
        preview_session_id: previewSessionId,
        preview_loading: false,
        preview_rows: viewMode === "list" ? [] : [...panel.preview_rows],
        preview_total_rows: viewMode === "list" ? 0 : panel.preview_total_rows,
        preview_loaded_rows: viewMode === "list" ? 0 : panel.preview_loaded_rows,
        preview_has_more: viewMode === "list" ? false : panel.preview_has_more,
        preview_from_end: viewMode === "list" ? true : panel.preview_from_end
      });
      setSessionManagePreviewScrollCommand(null);
      setSessionManageHighlightedMessageId("");
      setSessionManageGroupTab("current");
      setSessionManageScanConfig(null);
      void invoke<PaneScanConfig>("get_pane_scan_config", { paneId: pane.id })
        .then((config) => setSessionManageScanConfig(config))
        .catch((error) => {
          console.error(error);
          setSessionManageScanConfig(null);
        });
    },
    [getSessionListPanelState, panes]
  );

  const loadSessionListPreview = useCallback(
    async (
      paneId: string,
      sessionId: string,
      loadAll = false,
      options?: {
        keepPanelClosed?: boolean;
        fromEnd?: boolean;
        offset?: number;
        mergeMode?: "replace" | "prepend" | "append";
      }
    ) => {
      const sid = sessionId.trim();
      if (!paneId || !sid) {
        return;
      }
      const ticket = nextSessionPreviewLoadTicket(paneId);
      const keepPanelClosed = Boolean(options?.keepPanelClosed);
      const fromEnd = options?.fromEnd ?? !loadAll;
      const offset = options?.offset ?? 0;
      const mergeMode = options?.mergeMode ?? "replace";
      updateSessionListPanelState(paneId, (current) => ({
        ...current,
        open: keepPanelClosed ? current.open : true,
        preview_session_id: sid,
        preview_loading: true,
        preview_rows: current.preview_session_id === sid ? current.preview_rows : [],
        preview_total_rows: current.preview_session_id === sid ? current.preview_total_rows : 0,
        preview_loaded_rows: current.preview_session_id === sid ? current.preview_loaded_rows : 0,
        preview_has_more: current.preview_session_id === sid ? current.preview_has_more : false
      }));
      try {
        const response = await invoke<NativeSessionPreviewResponse>("preview_native_session_messages", {
          paneId,
          sessionId: sid,
          limit: 200,
          offset,
          loadAll,
          fromEnd
        });
        if (!isSessionPreviewLoadTicketActive(paneId, ticket)) {
          return;
        }
        updateSessionListPanelState(paneId, (current) => {
          if (
            !isSessionPreviewLoadTicketActive(paneId, ticket) ||
            (!keepPanelClosed && !current.open) ||
            current.preview_session_id !== sid
          ) {
            return current;
          }
          const incomingRows = response.rows || [];
          const canMergeCurrentRows = current.preview_session_id === sid;
          const nextRows =
            mergeMode === "prepend" && canMergeCurrentRows
              ? mergeNativePreviewRows(incomingRows, current.preview_rows)
              : mergeMode === "append" && canMergeCurrentRows
                ? mergeNativePreviewRows(current.preview_rows, incomingRows)
                : mergeMode === "replace" && canMergeCurrentRows && fromEnd
                  ? mergeNativePreviewRows(current.preview_rows, incomingRows)
                  : incomingRows;
          const totalRows = Number(response.total_rows || 0);
          return {
            ...current,
            preview_loading: false,
            preview_rows: nextRows,
            preview_total_rows: totalRows,
            preview_loaded_rows: nextRows.length,
            preview_has_more: nextRows.length < totalRows,
            preview_from_end: fromEnd
          };
        });
      } catch (error) {
        if (!isSessionPreviewLoadTicketActive(paneId, ticket)) {
          return;
        }
        console.error(error);
        updateSessionListPanelState(paneId, (current) => ({ ...current, preview_loading: false }));
        messageApi.error("加载会话预览失败");
      }
    },
    [
      isSessionPreviewLoadTicketActive,
      messageApi,
      nextSessionPreviewLoadTicket,
      updateSessionListPanelState
    ]
  );

  const openUnrecognizedFilePreview = useCallback(
    async (paneId: string, filePath: string) => {
      const normalizedPaneId = paneId.trim();
      const normalizedFilePath = filePath.trim();
      if (!normalizedPaneId || !normalizedFilePath) {
        return;
      }
      setUnrecognizedFilePreviewDialog({
        ...createUnrecognizedFilePreviewDialogState(),
        open: true,
        loading: true,
        pane_id: normalizedPaneId,
        file_path: normalizedFilePath
      });
      try {
        const response = await invoke<NativeUnrecognizedFilePreviewResponse>(
          "preview_native_unrecognized_file",
          {
            paneId: normalizedPaneId,
            filePath: normalizedFilePath
          }
        );
        setUnrecognizedFilePreviewDialog({
          open: true,
          loading: false,
          pane_id: normalizedPaneId,
          file_path: response.file_path || normalizedFilePath,
          reason: response.reason || "",
          parse_errors: Number(response.parse_errors || 0),
          scanned_units: Number(response.scanned_units || 0),
          row_count: Number(response.row_count || 0),
          session_id: String(response.session_id || "").trim(),
          started_at: Number(response.started_at || 0),
          content: response.content || ""
        });
      } catch (error) {
        console.error(error);
        setUnrecognizedFilePreviewDialog((current) => ({
          ...current,
          open: true,
          loading: false
        }));
        messageApi.error("加载异常文件失败");
      }
    },
    [messageApi]
  );

  const openUnrecognizedFilesModal = useCallback(async () => {
    if (!sessionManagePaneId) {
      return;
    }
    setUnrecognizedFilesModal({
      open: true,
      loading: true,
      items: []
    });
    try {
      const items =
        (await invoke<NativeSessionUnrecognizedFile[]>("list_native_unrecognized_files", {
          paneId: sessionManagePaneId
        })) || [];
      setUnrecognizedFilesModal({
        open: true,
        loading: false,
        items
      });
      updateSessionListPanelState(sessionManagePaneId, (current) => ({
        ...current,
        unrecognized_files: items
      }));
    } catch (error) {
      console.error(error);
      setUnrecognizedFilesModal((current) => ({
        ...current,
        open: true,
        loading: false
      }));
      messageApi.error("加载异常文件列表失败");
    }
  }, [messageApi, sessionManagePaneId, updateSessionListPanelState]);

  const reloadSessionListDialog = useCallback(
    async (
      paneId: string,
      overrides?: Partial<
        Pick<
          SessionListDialogState,
          "sid_keyword" | "time_from" | "time_to" | "quick_time_preset" | "records_min" | "records_max"
        >
      >,
      requestOptions?: {
        fullLoad?: boolean;
        keepPanelClosed?: boolean;
      }
    ) => {
      if (!paneId) {
        return;
      }
      const ticket = nextSessionListLoadTicket(paneId);
      const panel = getSessionListPanelState(paneId);
      const effectivePanel = {
        ...panel,
        ...(overrides || {})
      };
      const filters = toSessionListFilterArgs(effectivePanel);
      const keepPanelClosed = Boolean(requestOptions?.keepPanelClosed);
      updateSessionListPanelState(paneId, (current) => ({
        ...current,
        open: keepPanelClosed ? current.open : true,
        loading: true,
        loading_more: false,
        ...(overrides || {})
      }));
      try {
        const seenSessionIds = new Set<string>();
        const allItems: NativeSessionCandidate[] = [];
        let mergedUnrecognizedFiles: NativeSessionUnrecognizedFile[] = [];
        let total = 0;
        let offset = 0;
        let hasMore = true;

        if (requestOptions?.fullLoad) {
          const response = await loadSessionCandidates(paneId, {
            sortMode: panel.sort_mode,
            offset: 0,
            limit: panel.limit,
            ...filters,
            fullLoad: true
          });
          if (!isSessionListLoadTicketActive(paneId, ticket)) {
            return;
          }
          total = Number(response.total || 0);
          if (response.unrecognized_files?.length) {
            mergedUnrecognizedFiles = response.unrecognized_files;
          }
          for (const item of response.items || []) {
            if (seenSessionIds.has(item.session_id)) {
              continue;
            }
            seenSessionIds.add(item.session_id);
            allItems.push(item);
          }
        } else {
          while (hasMore) {
            const response = await loadSessionCandidates(paneId, {
              sortMode: panel.sort_mode,
              offset,
              limit: panel.limit,
              ...filters
            });
            if (!isSessionListLoadTicketActive(paneId, ticket)) {
              return;
            }
            total = Number(response.total || 0);
            if (response.unrecognized_files?.length) {
              mergedUnrecognizedFiles = response.unrecognized_files;
            }
            for (const item of response.items || []) {
              if (seenSessionIds.has(item.session_id)) {
                continue;
              }
              seenSessionIds.add(item.session_id);
              allItems.push(item);
            }
            const nextOffset = Number(response.offset || 0) + (response.items?.length || 0);
            offset = nextOffset;
            hasMore = Boolean(response.has_more) && (response.items?.length || 0) > 0;
          }
        }

        const visibleItems = filterSessionCandidatesByDialog(allItems, effectivePanel);
        const nextPreviewSid =
          visibleItems.find((item) => item.session_id === panel.preview_session_id)?.session_id ||
          visibleItems[0]?.session_id ||
          "";
        updateSessionListPanelState(paneId, (current) => ({
          ...current,
          open: keepPanelClosed ? current.open : true,
          loading: false,
          ...(overrides || {}),
          all_items: allItems,
          items: visibleItems,
          unrecognized_files: mergedUnrecognizedFiles,
          total: total > 0 ? total : allItems.length,
          offset: allItems.length,
          has_more: false,
          loading_more: false,
          preview_session_id: nextPreviewSid,
          preview_rows: [],
          preview_total_rows: 0,
          preview_loaded_rows: 0,
          preview_has_more: false
        }));
        if (nextPreviewSid) {
          void loadSessionListPreview(paneId, nextPreviewSid, false, { keepPanelClosed });
        }
      } catch (error) {
        if (!isSessionListLoadTicketActive(paneId, ticket)) {
          return;
        }
        console.error(error);
        updateSessionListPanelState(paneId, (current) => ({ ...current, loading: false, loading_more: false }));
        messageApi.error("刷新会话列表失败");
      }
    },
    [
      getSessionListPanelState,
      isSessionListLoadTicketActive,
      loadSessionCandidates,
      loadSessionListPreview,
      messageApi,
      nextSessionListLoadTicket,
      updateSessionListPanelState
    ]
  );

  reloadSessionListDialogRef.current = reloadSessionListDialog;

  const reindexNativeSessions = useCallback(
    async (paneId: string) => {
      const normalizedPaneId = paneId.trim();
      if (!normalizedPaneId || sessionManageReindexing) {
        return;
      }
      setSessionManageReindexing(true);
      updatePane(normalizedPaneId, (pane) => ({
        ...pane,
        scan_running: true,
        scan_processed_files: 0,
        scan_changed_files: 0
      }));
      void refreshScanProgress(normalizedPaneId);
      const timer = window.setInterval(() => {
        void refreshScanProgress(normalizedPaneId);
      }, 400);
      try {
        await invoke<NativeSessionIndexProgress>("reindex_native_sessions", { paneId: normalizedPaneId });
        await refreshScanProgress(normalizedPaneId);
        await reloadSessionListDialog(normalizedPaneId, undefined, { fullLoad: true, keepPanelClosed: true });
        messageApi.success("Rebuild Index 完成");
      } catch (error) {
        console.error(error);
        messageApi.error("Rebuild Index 失败");
      } finally {
        window.clearInterval(timer);
        setSessionManageReindexing(false);
      }
    },
    [messageApi, refreshScanProgress, reloadSessionListDialog, sessionManageReindexing, updatePane]
  );

  const setSessionAsCurrentFromManage = useCallback(
    async (paneId: string, sessionId: string) => {
      const pane = panes.find((item) => item.id === paneId);
      if (!pane) {
        return;
      }
      const sid = sessionId.trim();
      if (!sid) {
        return;
      }
      const linked = pane.linked_session_ids.filter((item) => item.trim() !== sid);
      try {
        await setPaneSessionState(paneId, sid, linked);
        await reloadSessionListDialog(paneId, undefined, { fullLoad: true, keepPanelClosed: true });
        messageApi.success(`已设为当前会话: ${shortSessionId(sid)}`);
      } catch (error) {
        console.error(error);
        messageApi.error("设置当前会话失败");
      }
    },
    [messageApi, panes, reloadSessionListDialog, setPaneSessionState]
  );

  const addLinkedSessionFromManage = useCallback(
    async (paneId: string, sessionId: string) => {
      const pane = panes.find((item) => item.id === paneId);
      if (!pane) {
        return;
      }
      const sid = sessionId.trim();
      if (!sid) {
        return;
      }
      if (pane.active_session_id.trim() === sid) {
        messageApi.info("该会话已是当前会话");
        return;
      }
      const linked = parseSessionIds([...pane.linked_session_ids, sid]).filter(
        (item) => item.trim() !== pane.active_session_id.trim()
      );
      try {
        await setPaneSessionState(paneId, pane.active_session_id, linked);
        await reloadSessionListDialog(paneId, undefined, { fullLoad: true, keepPanelClosed: true });
        messageApi.success(`已添加关联会话: ${shortSessionId(sid)}`);
      } catch (error) {
        console.error(error);
        messageApi.error("添加关联会话失败");
      }
    },
    [messageApi, panes, reloadSessionListDialog, setPaneSessionState]
  );

  const clearCurrentSessionFromManage = useCallback(
    async (paneId: string) => {
      const pane = panes.find((item) => item.id === paneId);
      if (!pane) {
        return;
      }
      if (!pane.active_session_id.trim()) {
        messageApi.info("当前没有可取消的 SID");
        return;
      }
      const clearedLinked = pane.linked_session_ids.filter(
        (item) => item.trim() !== pane.active_session_id.trim()
      );
      try {
        await setPaneSessionState(paneId, "", clearedLinked);
        await reloadSessionListDialog(paneId, undefined, { fullLoad: true, keepPanelClosed: true });
        setSessionManageGroupTab("unlinked");
        messageApi.success("已取消当前会话");
      } catch (error) {
        console.error(error);
        messageApi.error("取消当前会话失败");
      }
    },
    [messageApi, panes, reloadSessionListDialog, setPaneSessionState]
  );

  const removeLinkedSessionFromManage = useCallback(
    async (paneId: string, sessionId: string) => {
      const pane = panes.find((item) => item.id === paneId);
      if (!pane) {
        return;
      }
      const sid = sessionId.trim();
      if (!sid) {
        return;
      }
      const linked = pane.linked_session_ids.filter((item) => item.trim() !== sid);
      if (linked.length === pane.linked_session_ids.length) {
        return;
      }
      try {
        await setPaneSessionState(paneId, pane.active_session_id, linked);
        await reloadSessionListDialog(paneId, undefined, { fullLoad: true, keepPanelClosed: true });
        messageApi.success(`已取消关联会话: ${shortSessionId(sid)}`);
      } catch (error) {
        console.error(error);
        messageApi.error("取消关联会话失败");
      }
    },
    [messageApi, panes, reloadSessionListDialog, setPaneSessionState]
  );

  const updateSessionListSortMode = useCallback(
    (paneId: string, nextMode: SessionSortMode) => {
      updateSessionListPanelState(paneId, (current) => ({
        ...current,
        sort_mode: nextMode,
        all_items: sortSessionCandidatesByMode(current.all_items, nextMode),
        items: sortSessionCandidatesByMode(current.items, nextMode)
      }));
    },
    [updateSessionListPanelState]
  );

  const toggleSessionPreviewAutoRefresh = useCallback(
    (paneId: string) => {
      updateSessionListPanelState(paneId, (current) => ({
        ...current,
        preview_auto_refresh: !current.preview_auto_refresh
      }));
    },
    [updateSessionListPanelState]
  );

  const loadSessionManagePreview = useCallback(
    async (
      paneId: string,
      sessionId: string,
      loadAll = false,
      options?: {
        fromEnd?: boolean;
        offset?: number;
        mergeMode?: "replace" | "prepend" | "append";
      }
    ) => {
      const sid = sessionId.trim();
      if (!paneId || !sid) {
        return;
      }
      const ticket = sessionManagePreviewTicketRef.current + 1;
      sessionManagePreviewTicketRef.current = ticket;
      const fromEnd = options?.fromEnd ?? !loadAll;
      const offset = options?.offset ?? 0;
      const mergeMode = options?.mergeMode ?? "replace";
      setSessionManagePreview((current) => ({
        ...current,
        preview_session_id: sid,
        preview_loading: true,
        preview_rows: current.preview_session_id === sid ? current.preview_rows : [],
        preview_total_rows: current.preview_session_id === sid ? current.preview_total_rows : 0,
        preview_loaded_rows: current.preview_session_id === sid ? current.preview_loaded_rows : 0,
        preview_has_more: current.preview_session_id === sid ? current.preview_has_more : false,
        preview_from_end: current.preview_session_id === sid ? current.preview_from_end : fromEnd
      }));
      try {
        const response = await invoke<NativeSessionPreviewResponse>("preview_native_session_messages", {
          paneId,
          sessionId: sid,
          limit: 200,
          offset,
          loadAll,
          fromEnd
        });
        if (sessionManagePreviewTicketRef.current !== ticket) {
          return;
        }
        setSessionManagePreview((current) => {
          const incomingRows = response.rows || [];
          const sameSession = current.preview_session_id === sid;
          const sameDirection = current.preview_from_end === fromEnd;
          const nextRows =
            mergeMode === "prepend" && sameSession
              ? mergeNativePreviewRows(incomingRows, current.preview_rows)
              : mergeMode === "append" && sameSession
                ? mergeNativePreviewRows(current.preview_rows, incomingRows)
                : mergeMode === "replace" && sameSession && sameDirection && fromEnd
                  ? mergeNativePreviewRows(current.preview_rows, incomingRows)
                  : incomingRows;
          const totalRows = Number(response.total_rows || 0);
          return {
            preview_session_id: sid,
            preview_loading: false,
            preview_rows: nextRows,
            preview_total_rows: totalRows,
            preview_loaded_rows: nextRows.length,
            preview_has_more: nextRows.length < totalRows,
            preview_from_end: fromEnd
          };
        });
      } catch (error) {
        if (sessionManagePreviewTicketRef.current !== ticket) {
          return;
        }
        console.error(error);
        setSessionManagePreview((current) => ({ ...current, preview_loading: false }));
        messageApi.error("加载会话预览失败");
      }
    },
    [messageApi]
  );

  const loadAllSessionManagePreviewRows = useCallback(async () => {
    const paneId = sessionManagePaneId;
    const sid = sessionManagePreview.preview_session_id.trim();
    if (!paneId || !sid || sessionManagePreview.preview_loading) {
      return;
    }
    await loadSessionManagePreview(paneId, sid, true);
  }, [loadSessionManagePreview, sessionManagePaneId, sessionManagePreview.preview_loading, sessionManagePreview.preview_session_id]);

  const loadMoreSessionManagePreviewRows = useCallback(async () => {
    const paneId = sessionManagePaneId;
    const sid = sessionManagePreview.preview_session_id.trim();
    if (!paneId || !sid || sessionManagePreview.preview_loading || !sessionManagePreview.preview_has_more) {
      return;
    }
    await loadSessionManagePreview(paneId, sid, false, {
      fromEnd: sessionManagePreview.preview_from_end,
      offset: sessionManagePreview.preview_loaded_rows,
      mergeMode: sessionManagePreview.preview_from_end ? "prepend" : "append"
    });
  }, [
    loadSessionManagePreview,
    sessionManagePaneId,
    sessionManagePreview.preview_from_end,
    sessionManagePreview.preview_has_more,
    sessionManagePreview.preview_loading,
    sessionManagePreview.preview_loaded_rows,
    sessionManagePreview.preview_session_id
  ]);

  const jumpSessionManagePreviewToStart = useCallback(async () => {
    const paneId = sessionManagePaneId;
    const sid = sessionManagePreview.preview_session_id.trim();
    if (!paneId || !sid) {
      setSessionManagePreviewScrollCommand((current) => ({
        target: "top",
        nonce: (current?.nonce || 0) + 1
      }));
      return;
    }
    await loadSessionManagePreview(paneId, sid, false, {
      fromEnd: false,
      offset: 0,
      mergeMode: "replace"
    });
    setSessionManagePreviewScrollCommand((current) => ({
      target: "top",
      nonce: (current?.nonce || 0) + 1
    }));
  }, [loadSessionManagePreview, sessionManagePaneId, sessionManagePreview.preview_session_id]);

  const jumpSessionManagePreviewToLatest = useCallback(async () => {
    const paneId = sessionManagePaneId;
    const sid = sessionManagePreview.preview_session_id.trim();
    if (!paneId || !sid) {
      setSessionManagePreviewScrollCommand((current) => ({
        target: "bottom",
        nonce: (current?.nonce || 0) + 1
      }));
      return;
    }
    await loadSessionManagePreview(paneId, sid, false, {
      fromEnd: true,
      offset: 0,
      mergeMode: "replace"
    });
    setSessionManagePreviewScrollCommand((current) => ({
      target: "bottom",
      nonce: (current?.nonce || 0) + 1
    }));
  }, [loadSessionManagePreview, sessionManagePaneId, sessionManagePreview.preview_session_id]);

  const openFavoriteMessageInSessionManage = useCallback(
    async (favorite: FavoriteMessageRecord) => {
      const paneId = favorite.pane_id.trim();
      const sessionId = favorite.session_id.trim();
      const messageId = favorite.message_id.trim();
      if (!paneId || !sessionId || !messageId) {
        messageApi.error("收藏记录缺少定位信息");
        return;
      }

      const pane = panes.find((item) => item.id === paneId);
      if (!pane) {
        messageApi.error("收藏对应的窗格不存在");
        return;
      }

      navigateTo("workspace");
      setPreviewOverlaySource(null);
      openSessionManageDialog(paneId, "manage");
      if (pane.active_session_id.trim() === sessionId) {
        setSessionManageGroupTab("current");
      } else if (parseSessionIds(pane.linked_session_ids).includes(sessionId)) {
        setSessionManageGroupTab("linked");
      } else {
        setSessionManageGroupTab("unlinked");
      }

      try {
        await reloadSessionListDialog(paneId, undefined, {
          fullLoad: true,
          keepPanelClosed: true
        });
        await loadSessionManagePreview(paneId, sessionId, true, {
          fromEnd: false,
          offset: 0,
          mergeMode: "replace"
        });
        setSessionManageHighlightedMessageId(messageId);
        setSessionManagePreviewScrollCommand((current) => ({
          target: "item",
          item_id: messageId,
          nonce: (current?.nonce || 0) + 1
        }));
      } catch (error) {
        console.error(error);
        messageApi.error("打开收藏消息失败");
      }
    },
    [
      loadSessionManagePreview,
      messageApi,
      navigateTo,
      openSessionManageDialog,
      panes,
      reloadSessionListDialog
    ]
  );

  const refreshSessionManageLiveView = useCallback(
    async (paneId: string, previewSessionId?: string, loadAll = false) => {
      const normalizedPaneId = paneId.trim();
      if (!normalizedPaneId) {
        return;
      }
      await refreshNativeSessionCache(normalizedPaneId);
      if (!sessionManageIsListView) {
        await reloadSessionListDialog(normalizedPaneId, undefined, {
          fullLoad: true,
          keepPanelClosed: true
        });
      }
      const sid = (previewSessionId ?? sessionManagePreview.preview_session_id).trim();
      if (sid) {
        await loadSessionManagePreview(
          normalizedPaneId,
          sid,
          loadAll,
          loadAll
            ? undefined
            : {
                fromEnd: sessionManagePreview.preview_from_end
              }
        );
      }
    },
    [
      loadSessionManagePreview,
      refreshNativeSessionCache,
      reloadSessionListDialog,
      sessionManageIsListView,
      sessionManagePreview.preview_from_end,
      sessionManagePreview.preview_session_id
    ]
  );

  const refreshStandaloneSessionPreview = useCallback(
    async (paneId: string, silent = false) => {
      const normalizedPaneId = paneId.trim();
      if (!normalizedPaneId) {
        return;
      }
      try {
        await refreshNativeSessionCache(normalizedPaneId);
        const paneState = await invoke<PaneSessionState>("get_pane_session_state", {
          paneId: normalizedPaneId
        });
        updatePane(normalizedPaneId, (pane) => ({
          ...pane,
          active_session_id: paneState.active_session_id || "",
          linked_session_ids: Array.isArray(paneState.linked_session_ids) ? paneState.linked_session_ids : []
        }));
        const activeSessionId = (paneState.active_session_id || "").trim();
        if (activeSessionId) {
          await loadSessionManagePreview(normalizedPaneId, activeSessionId, true);
        } else {
          setSessionManagePreview(createSessionManagePreviewState());
          setSessionManagePreviewScrollCommand(null);
        }
      } catch (error) {
        console.error(error);
        if (!silent) {
          messageApi.error("刷新当前会话预览失败");
        }
      }
    },
    [loadSessionManagePreview, messageApi, refreshNativeSessionCache, updatePane]
  );

  const resolveStandaloneSessionPreviewHostWindow = useCallback(async () => {
    return (await WebviewWindow.getByLabel("main")) ?? getCurrentWindow();
  }, []);

  const readWindowLogicalOuterSize = useCallback(
    async (windowRef: {
      outerSize: () => Promise<{ width: number; height: number }>;
      scaleFactor: () => Promise<number>;
    }) => {
      const [size, scaleFactor] = await Promise.all([
        windowRef.outerSize(),
        windowRef.scaleFactor()
      ]);
      return {
        width: Math.max(1, Math.round(size.width / scaleFactor)),
        height: Math.max(1, Math.round(size.height / scaleFactor))
      };
    },
    []
  );

  const copySyncDialogMessages = useCallback(async () => {
    const paneId = syncDialog.pane_id;
    if (!paneId) {
      return;
    }
    const loadedEntries = await ensureSyncDialogSessionsLoaded(
      paneId,
      syncDialog.selected_session_ids,
      true
    );
    const selectedPreviewEntries = collectSyncDialogSelectedEntries(loadedEntries);

    if (!selectedPreviewEntries.length) {
      messageApi.info("暂无可复制消息");
      return;
    }

    const selectedEntries = await hydrateSyncDialogEntriesWithFullContent(
      paneId,
      selectedPreviewEntries
    );
    const payload = await buildSyncDialogPlainPayload(selectedEntries);

    try {
      await copyTextToClipboard(payload);
      messageApi.success(`已复制 ${selectedEntries.length} 条消息到剪贴板`);
    } catch (error) {
      console.error(error);
      messageApi.error("复制消息失败");
    }
  }, [
    buildSyncDialogPlainPayload,
    collectSyncDialogSelectedEntries,
    ensureSyncDialogSessionsLoaded,
    hydrateSyncDialogEntriesWithFullContent,
    messageApi,
    syncDialog.pane_id,
    syncDialog.selected_session_ids
  ]);

  const resolveStandaloneSessionPreviewInitialPosition = useCallback(
    async (
      popupWidth = STANDALONE_SESSION_PREVIEW_DEFAULT_WIDTH,
      popupHeight = STANDALONE_SESSION_PREVIEW_DEFAULT_HEIGHT
    ) => {
      const mainWindow = await resolveStandaloneSessionPreviewHostWindow();
      const [mainPos, mainSize, scaleFactor] = await Promise.all([
        mainWindow.outerPosition(),
        mainWindow.outerSize(),
        mainWindow.scaleFactor()
      ]);
      const physical = resolveRightCenteredWindowPhysicalPosition({
        hostX: mainPos.x,
        hostY: mainPos.y,
        hostWidth: mainSize.width,
        hostHeight: mainSize.height,
        popupWidth: Math.round(popupWidth * scaleFactor),
        popupHeight: Math.round(popupHeight * scaleFactor)
      });
      return {
        x: Math.round(physical.x / scaleFactor),
        y: Math.round(physical.y / scaleFactor)
      };
    },
    [resolveStandaloneSessionPreviewHostWindow]
  );

  const alignStandaloneSessionPreviewWindow = useCallback(
    async (
      previewWindow: WebviewWindow,
      fallbackWidth = STANDALONE_SESSION_PREVIEW_DEFAULT_WIDTH,
      fallbackHeight = STANDALONE_SESSION_PREVIEW_DEFAULT_HEIGHT
    ) => {
      if (await previewWindow.isMaximized().catch(() => false)) {
        return;
      }
      const mainWindow = await resolveStandaloneSessionPreviewHostWindow();
      const [mainPos, mainSize, scaleFactor] = await Promise.all([
        mainWindow.outerPosition(),
        mainWindow.outerSize(),
        mainWindow.scaleFactor()
      ]);

      let popupWidth = Math.round(fallbackWidth * scaleFactor);
      let popupHeight = Math.round(fallbackHeight * scaleFactor);

      try {
        const popupSize = await previewWindow.outerSize();
        if (popupSize.width > 0 && popupSize.height > 0) {
          popupWidth = popupSize.width;
          popupHeight = popupSize.height;
        }
      } catch {}

      const physical = resolveRightCenteredWindowPhysicalPosition({
        hostX: mainPos.x,
        hostY: mainPos.y,
        hostWidth: mainSize.width,
        hostHeight: mainSize.height,
        popupWidth,
        popupHeight
      });

      await previewWindow.setPosition(new PhysicalPosition(physical.x, physical.y));
    },
    [resolveStandaloneSessionPreviewHostWindow]
  );

  const toggleStandaloneSessionPreviewCompactMode = useCallback(async () => {
    const previewWindow = getCurrentWebviewWindow();
    try {
      if (standaloneSessionPreviewCompactMode) {
        const restoreSize = standaloneSessionPreviewRestoreSizeRef.current ?? {
          width: STANDALONE_SESSION_PREVIEW_DEFAULT_WIDTH,
          height: STANDALONE_SESSION_PREVIEW_DEFAULT_HEIGHT
        };
        await previewWindow.setSize(new LogicalSize(restoreSize.width, restoreSize.height));
        await alignStandaloneSessionPreviewWindow(
          previewWindow,
          restoreSize.width,
          restoreSize.height
        );
        setStandaloneSessionPreviewCompactMode(false);
        return;
      }

      standaloneSessionPreviewRestoreSizeRef.current = await readWindowLogicalOuterSize(previewWindow);
      const hostWindow = await resolveStandaloneSessionPreviewHostWindow();
      const hostSize = await readWindowLogicalOuterSize(hostWindow);
      const compactSize = resolveStandaloneSessionPreviewCompactLogicalSize(
        hostSize.width,
        hostSize.height
      );

      await previewWindow.setSize(new LogicalSize(compactSize.width, compactSize.height));
      await alignStandaloneSessionPreviewWindow(
        previewWindow,
        compactSize.width,
        compactSize.height
      );
      setStandaloneSessionPreviewCompactMode(true);
    } catch (error) {
      console.error(error);
      messageApi.error(standaloneSessionPreviewCompactMode ? "恢复窗口失败" : "最小化窗口失败");
    }
  }, [
    alignStandaloneSessionPreviewWindow,
    messageApi,
    readWindowLogicalOuterSize,
    resolveStandaloneSessionPreviewHostWindow,
    standaloneSessionPreviewCompactMode
  ]);

  const openStandaloneSessionPreviewWindow = useCallback(
    async (paneId: string) => {
      const normalizedPaneId = paneId.trim();
      if (!normalizedPaneId) {
        return;
      }
      const pane = panes.find((item) => item.id === normalizedPaneId);
      if (!pane) {
        return;
      }
      if (!pane.active_session_id.trim()) {
        messageApi.warning("当前窗格未绑定 SID");
        return;
      }
      const windowTitle = `${asTitle(pane.provider)} 当前会话预览`;
      try {
        const existingWindow = await WebviewWindow.getByLabel(STANDALONE_SESSION_PREVIEW_WINDOW_LABEL);
        if (existingWindow) {
          await existingWindow.setTitle(windowTitle).catch((error) => console.error(error));
          await emitTo(STANDALONE_SESSION_PREVIEW_WINDOW_LABEL, STANDALONE_SESSION_PREVIEW_SET_PANE_EVENT, {
            paneId: normalizedPaneId
          });
          await alignStandaloneSessionPreviewWindow(existingWindow).catch((error) => console.error(error));
          await existingWindow.show().catch((error) => console.error(error));
          await existingWindow.setFocus().catch((error) => console.error(error));
          return;
        }
        const initialPosition = await resolveStandaloneSessionPreviewInitialPosition();
        const previewWindow = new WebviewWindow(STANDALONE_SESSION_PREVIEW_WINDOW_LABEL, {
          url: buildStandaloneSessionPreviewUrl(normalizedPaneId),
          title: windowTitle,
          width: STANDALONE_SESSION_PREVIEW_DEFAULT_WIDTH,
          height: STANDALONE_SESSION_PREVIEW_DEFAULT_HEIGHT,
          minWidth: STANDALONE_SESSION_PREVIEW_MIN_WIDTH,
          minHeight: STANDALONE_SESSION_PREVIEW_MIN_HEIGHT,
          x: initialPosition.x,
          y: initialPosition.y,
          alwaysOnTop: readStandaloneSessionPreviewAlwaysOnTopPreference(),
          resizable: true,
          focus: true
        });
        previewWindow.once("tauri://created", () => {
          void alignStandaloneSessionPreviewWindow(previewWindow).catch((error) => console.error(error));
        });
        previewWindow.once("tauri://error", (event) => {
          console.error(event);
          messageApi.error("打开独立预览窗口失败");
        });
      } catch (error) {
        console.error(error);
        messageApi.error("打开独立预览窗口失败");
      }
    },
    [alignStandaloneSessionPreviewWindow, messageApi, panes, resolveStandaloneSessionPreviewInitialPosition]
  );

  const openStandaloneCollabWorkbenchWindow = useCallback(async () => {
    try {
      const existingWindow = await WebviewWindow.getByLabel(STANDALONE_COLLAB_WORKBENCH_WINDOW_LABEL);
      if (existingWindow) {
        await existingWindow.setTitle(STANDALONE_COLLAB_WORKBENCH_WINDOW_TITLE).catch((error) =>
          console.error(error)
        );
        await alignStandaloneSessionPreviewWindow(
          existingWindow,
          STANDALONE_COLLAB_WORKBENCH_DEFAULT_WIDTH,
          STANDALONE_COLLAB_WORKBENCH_DEFAULT_HEIGHT
        ).catch((error) => console.error(error));
        await existingWindow.show().catch((error) => console.error(error));
        await existingWindow.setFocus().catch((error) => console.error(error));
        return;
      }

      const initialPosition = await resolveStandaloneSessionPreviewInitialPosition(
        STANDALONE_COLLAB_WORKBENCH_DEFAULT_WIDTH,
        STANDALONE_COLLAB_WORKBENCH_DEFAULT_HEIGHT
      );
      const collabWindow = new WebviewWindow(STANDALONE_COLLAB_WORKBENCH_WINDOW_LABEL, {
        url: buildStandaloneCollabWorkbenchUrl(),
        title: STANDALONE_COLLAB_WORKBENCH_WINDOW_TITLE,
        width: STANDALONE_COLLAB_WORKBENCH_DEFAULT_WIDTH,
        height: STANDALONE_COLLAB_WORKBENCH_DEFAULT_HEIGHT,
        minWidth: STANDALONE_COLLAB_WORKBENCH_MIN_WIDTH,
        minHeight: STANDALONE_COLLAB_WORKBENCH_MIN_HEIGHT,
        x: initialPosition.x,
        y: initialPosition.y,
        resizable: true,
        focus: true
      });
      collabWindow.once("tauri://created", () => {
        void alignStandaloneSessionPreviewWindow(
          collabWindow,
          STANDALONE_COLLAB_WORKBENCH_DEFAULT_WIDTH,
          STANDALONE_COLLAB_WORKBENCH_DEFAULT_HEIGHT
        ).catch((error) => console.error(error));
      });
      collabWindow.once("tauri://error", (event) => {
        console.error(event);
        messageApi.error("打开协作工作台窗口失败");
      });
    } catch (error) {
      console.error(error);
      messageApi.error("打开协作工作台窗口失败");
    }
  }, [
    alignStandaloneSessionPreviewWindow,
    messageApi,
    resolveStandaloneSessionPreviewInitialPosition
  ]);

  useEffect(() => {
    if (!isStandaloneSessionPreviewRoute) {
      return;
    }
    let unlistenFn: (() => void) | null = null;
    getCurrentWebviewWindow()
      .listen<StandaloneSessionPreviewTargetPayload>(
        STANDALONE_SESSION_PREVIEW_SET_PANE_EVENT,
        (event) => {
          const nextPaneId = String(event.payload?.paneId || "").trim();
          setStandaloneSessionPreviewPaneId(nextPaneId);
        }
      )
      .then((fn) => {
        unlistenFn = fn;
      })
      .catch((error) => console.error(error));
    return () => {
      if (unlistenFn) {
        unlistenFn();
      }
    };
  }, [isStandaloneSessionPreviewRoute]);

  useEffect(() => {
    if (!isStandaloneSessionPreviewRoute) {
      return;
    }
    let cancelled = false;
    getCurrentWindow()
      .isAlwaysOnTop()
      .then((value) => {
        if (cancelled) {
          return;
        }
        setStandaloneSessionPreviewAlwaysOnTop(value);
        writeStandaloneSessionPreviewAlwaysOnTopPreference(value);
      })
      .catch((error) => console.error(error));
    return () => {
      cancelled = true;
    };
  }, [isStandaloneSessionPreviewRoute]);

  useEffect(() => {
    if (isStandaloneSessionPreviewRoute) {
      return;
    }

    const currentWindow = getCurrentWindow();
    let resizeUnlisten: (() => void) | null = null;
    let moveUnlisten: (() => void) | null = null;
    let syncRafId: number | null = null;

    const syncPreviewPosition = () => {
      if (syncRafId !== null) {
        window.cancelAnimationFrame(syncRafId);
      }
      syncRafId = window.requestAnimationFrame(() => {
        syncRafId = null;
        void WebviewWindow.getByLabel(STANDALONE_SESSION_PREVIEW_WINDOW_LABEL)
          .then((previewWindow) => {
            if (!previewWindow) {
              return;
            }
            return alignStandaloneSessionPreviewWindow(previewWindow);
          })
          .catch((error) => console.error(error));
      });
    };

    currentWindow.onResized(syncPreviewPosition).then((fn) => {
      resizeUnlisten = fn;
    }).catch((error) => console.error(error));

    currentWindow.onMoved(syncPreviewPosition).then((fn) => {
      moveUnlisten = fn;
    }).catch((error) => console.error(error));

    return () => {
      if (syncRafId !== null) {
        window.cancelAnimationFrame(syncRafId);
      }
      resizeUnlisten?.();
      moveUnlisten?.();
    };
  }, [alignStandaloneSessionPreviewWindow, isStandaloneSessionPreviewRoute]);

  useEffect(() => {
    if (!isStandaloneSessionPreviewRoute) {
      return;
    }

    const currentWindow = getCurrentWindow();
    let resizeUnlisten: (() => void) | null = null;
    let syncRafId: number | null = null;

    const syncToRight = () => {
      if (syncRafId !== null) {
        window.cancelAnimationFrame(syncRafId);
      }
      syncRafId = window.requestAnimationFrame(() => {
        syncRafId = null;
        void alignStandaloneSessionPreviewWindow(getCurrentWebviewWindow()).catch((error) =>
          console.error(error)
        );
      });
    };

    currentWindow.onResized(syncToRight).then((fn) => {
      resizeUnlisten = fn;
    }).catch((error) => console.error(error));

    return () => {
      if (syncRafId !== null) {
        window.cancelAnimationFrame(syncRafId);
      }
      resizeUnlisten?.();
    };
  }, [alignStandaloneSessionPreviewWindow, isStandaloneSessionPreviewRoute]);

  useEffect(() => {
    if (!isStandaloneSessionPreviewRoute) {
      return;
    }
    const nextUrl = buildStandaloneSessionPreviewUrl(standaloneSessionPreviewPaneId);
    const currentUrl = `${normalizeAppPathname(window.location.pathname)}${window.location.search || ""}`;
    if (currentUrl === nextUrl) {
      return;
    }
    try {
      window.history.replaceState({}, "", nextUrl);
    } catch (error) {
      console.error(error);
    }
  }, [isStandaloneSessionPreviewRoute, standaloneSessionPreviewPaneId]);

  useEffect(() => {
    if (!isStandaloneSessionPreviewRoute || loading) {
      return;
    }
    if (!standaloneSessionPreviewPane) {
      setSessionManagePreview(createSessionManagePreviewState());
      setSessionManagePreviewScrollCommand(null);
      return;
    }
    const activeSessionId = standaloneSessionPreviewPane.active_session_id.trim();
    if (!activeSessionId) {
      setSessionManagePreview(createSessionManagePreviewState());
      setSessionManagePreviewScrollCommand(null);
      return;
    }
    void loadSessionManagePreview(standaloneSessionPreviewPane.id, activeSessionId, true);
  }, [
    isStandaloneSessionPreviewRoute,
    loadSessionManagePreview,
    loading,
    standaloneSessionPreviewPane
  ]);

  useEffect(() => {
    if (!isStandaloneSessionPreviewRoute || !standaloneSessionPreviewPane) {
      return;
    }
    if (!standaloneSessionPreviewListState?.preview_auto_refresh) {
      return;
    }
    const paneId = standaloneSessionPreviewPane.id;
    const timer = window.setInterval(() => {
      if (standaloneSessionPreviewAutoRefreshRunningRef.current) {
        return;
      }
      standaloneSessionPreviewAutoRefreshRunningRef.current = true;
      void refreshStandaloneSessionPreview(paneId, true)
        .catch((error) => console.error(error))
        .finally(() => {
          standaloneSessionPreviewAutoRefreshRunningRef.current = false;
        });
    }, 1000);
    return () => {
      window.clearInterval(timer);
      standaloneSessionPreviewAutoRefreshRunningRef.current = false;
    };
  }, [
    isStandaloneSessionPreviewRoute,
    refreshStandaloneSessionPreview,
    standaloneSessionPreviewListState?.preview_auto_refresh,
    standaloneSessionPreviewPane
  ]);

  useEffect(() => {
    if (!isStandaloneSessionPreviewRoute) {
      return;
    }
    const title = standaloneSessionPreviewPane
      ? `${asTitle(standaloneSessionPreviewPane.provider)} 当前会话预览`
      : "当前会话预览";
    void getCurrentWebviewWindow().setTitle(title).catch((error) => console.error(error));
  }, [isStandaloneSessionPreviewRoute, standaloneSessionPreviewPane]);

  const toggleStandaloneSessionPreviewAlwaysOnTop = useCallback(async () => {
    const nextValue = !standaloneSessionPreviewAlwaysOnTop;
    try {
      await getCurrentWindow().setAlwaysOnTop(nextValue);
      setStandaloneSessionPreviewAlwaysOnTop(nextValue);
      writeStandaloneSessionPreviewAlwaysOnTopPreference(nextValue);
    } catch (error) {
      console.error(error);
      messageApi.error(nextValue ? "开启窗口置顶失败" : "取消窗口置顶失败");
    }
  }, [messageApi, standaloneSessionPreviewAlwaysOnTop]);

  useEffect(() => {
    if (previewOverlaySource === "session-manage" && !sessionManageDialog.open) {
      setPreviewOverlaySource(null);
      return;
    }
    if (previewOverlaySource === "sync-dialog" && !syncDialog.open) {
      setPreviewOverlaySource(null);
    }
  }, [previewOverlaySource, sessionManageDialog.open, syncDialog.open]);

  useEffect(() => {
    if (!sessionManageDialog.open) {
      setSessionManageHighlightedMessageId("");
    }
  }, [sessionManageDialog.open]);

  const loadNativePreviewMessageDetail = useCallback(
    async (
      paneId: string,
      sessionId: string,
      item: SyncEntryPreviewItem
    ): Promise<SyncEntryPreviewFullContentResult> => {
      const sid = sessionId.trim();
      if (!paneId || !sid) {
        throw new Error("缺少会话上下文，无法加载完整消息");
      }

      const response = await invoke<NativeSessionMessageDetailResponse>(
        "get_native_session_message_detail",
        {
          paneId,
          sessionId: sid,
          messageId: item.id
        }
      );

      return {
        content: response.content || "",
        kind: response.kind || item.kind,
        created_at_text: response.created_at ? formatTs(response.created_at) : item.created_at_text,
        sid_text: response.session_id ? shortSessionId(response.session_id) : item.sid_text
      };
    },
    []
  );
  const loadSessionManagePreviewMessageDetail = useCallback(
    (item: SyncEntryPreviewItem) =>
      loadNativePreviewMessageDetail(
        sessionManagePaneId,
        sessionManagePreview.preview_session_id,
        item
      ),
    [
      loadNativePreviewMessageDetail,
      sessionManagePaneId,
      sessionManagePreview.preview_session_id
    ]
  );
  const loadSyncDialogPreviewMessageDetail = useCallback(
    (item: SyncEntryPreviewItem) =>
      loadNativePreviewMessageDetail(
        syncDialog.pane_id,
        resolveSyncDialogPreviewItemSessionId(item),
        item
      ),
    [
      loadNativePreviewMessageDetail,
      resolveSyncDialogPreviewItemSessionId,
      syncDialog.pane_id
    ]
  );
  const togglePreviewMessageFavorite = useCallback(
    async (
      item: SyncEntryPreviewItem,
      nextFavorited: boolean,
      resolvedDetail?: SyncEntryPreviewFullContentResult | null
    ) => {
      const target = item.favorite_target;
      if (!target) {
        messageApi.warning("当前消息不支持收藏");
        return;
      }

      const favoriteKey = buildFavoriteMessageKey({
        pane_id: target.pane_id,
        session_id: target.session_id,
        message_id: item.id
      });
      const existing = favoriteMessageMap.get(favoriteKey);

      if (!nextFavorited) {
        if (!existing) {
          return;
        }
        await invoke<void>("delete_favorite_message", {
          favoriteId: existing.id
        });
        setFavoriteMessages((current) => current.filter((favorite) => favorite.id !== existing.id));
        messageApi.success("已取消收藏");
        return;
      }

      const pane = panes.find((entry) => entry.id === target.pane_id);
      const response = await invoke<FavoriteMessageRecord>("upsert_favorite_message", {
        payload: {
          paneId: target.pane_id,
          paneTitle: target.pane_title || pane?.title || "",
          provider: target.provider || pane?.provider || "",
          sessionId: target.session_id,
          messageId: item.id,
          kind: resolvedDetail?.kind || item.kind,
          content: resolvedDetail?.content || item.content,
          createdAt: Math.max(0, Number(item.created_at || 0))
        } satisfies FavoriteMessageUpsertInput
      });
      setFavoriteMessages((current) => {
        const withoutCurrent = current.filter((favorite) => favorite.id !== response.id);
        return [response, ...withoutCurrent].sort((a, b) => {
          if (b.favorited_at !== a.favorited_at) {
            return b.favorited_at - a.favorited_at;
          }
          return b.created_at - a.created_at;
        });
      });
      messageApi.success("已收藏消息");
    },
    [favoriteMessageMap, messageApi, panes]
  );
  const removeFavoriteMessage = useCallback(
    async (favoriteId: string) => {
      const normalizedFavoriteId = favoriteId.trim();
      if (!normalizedFavoriteId) {
        return;
      }
      await invoke<void>("delete_favorite_message", {
        favoriteId: normalizedFavoriteId
      });
      setFavoriteMessages((current) =>
        current.filter((favorite) => favorite.id !== normalizedFavoriteId)
      );
      messageApi.success("已取消收藏");
    },
    [messageApi]
  );

  const toggleSessionListSortField = useCallback(
    (paneId: string, field: SessionSortField) => {
      const panel = getSessionListPanelState(paneId);
      const current = splitSessionSortMode(panel.sort_mode);
      const nextOrder: SessionSortOrder =
        current.field === field ? (current.order === "asc" ? "desc" : "asc") : "desc";
      updateSessionListSortMode(paneId, toSessionSortMode(field, nextOrder));
    },
    [getSessionListPanelState, updateSessionListSortMode]
  );

  const openSessionListDialog = useCallback(
    async (paneId: string) => {
      const panel = getSessionListPanelState(paneId);
      const pane = panes.find((item) => item.id === paneId);
      const activeSessionId = pane?.active_session_id.trim() ?? "";
      if (panel.open) {
        void nextSessionListLoadTicket(paneId);
        void nextSessionPreviewLoadTicket(paneId);
        updateSessionListPanelState(paneId, (current) => ({
          ...current,
          open: false,
          loading: false,
          loading_more: false,
          preview_loading: false
        }));
        return;
      }
      updateSessionListPanelState(paneId, (current) => ({ ...current, open: true }));
      if (isCompactViewport) {
        await reloadSessionListDialog(paneId, undefined, { fullLoad: true });
        if (activeSessionId) {
          await loadSessionListPreview(paneId, activeSessionId, false, { fromEnd: true });
        }
        return;
      }
      const shouldReload =
        !panel.items.length ||
        panel.loading ||
        panel.loading_more ||
        panel.has_more ||
        panel.offset < panel.total;
      if (shouldReload) {
        await reloadSessionListDialog(paneId);
        if (activeSessionId) {
          await loadSessionListPreview(paneId, activeSessionId, false, { fromEnd: true });
        }
        return;
      }
      if (activeSessionId) {
        await loadSessionListPreview(paneId, activeSessionId, false, { fromEnd: true });
        return;
      }
      if (panel.preview_session_id.trim()) {
        await loadSessionListPreview(paneId, panel.preview_session_id.trim(), false);
        return;
      }
      const firstSid = panel.items[0]?.session_id?.trim() ?? "";
      if (firstSid) {
        await loadSessionListPreview(paneId, firstSid, false);
      }
    },
    [
      getSessionListPanelState,
      loadSessionListPreview,
      nextSessionListLoadTicket,
      nextSessionPreviewLoadTicket,
      isCompactViewport,
      panes,
      reloadSessionListDialog,
      updateSessionListPanelState
    ]
  );

  const applySessionListFilters = useCallback(
    async (paneId: string) => {
      const panel = getSessionListPanelState(paneId);
      const sourceItems = panel.all_items.length ? panel.all_items : panel.items;
      const visibleItems = filterSessionCandidatesByDialog(sourceItems, panel);
      const nextPreviewSid =
        visibleItems.find((item) => item.session_id === panel.preview_session_id)?.session_id ||
        visibleItems[0]?.session_id ||
        "";
      updateSessionListPanelState(paneId, (current) => ({
        ...current,
        loading: false,
        loading_more: false,
        items: visibleItems,
        preview_session_id: nextPreviewSid,
        preview_rows: nextPreviewSid === current.preview_session_id ? current.preview_rows : [],
        preview_total_rows:
          nextPreviewSid === current.preview_session_id ? current.preview_total_rows : 0,
        preview_loaded_rows:
          nextPreviewSid === current.preview_session_id ? current.preview_loaded_rows : 0,
        preview_has_more:
          nextPreviewSid === current.preview_session_id ? current.preview_has_more : false
      }));
      if (nextPreviewSid && nextPreviewSid !== panel.preview_session_id) {
        await loadSessionListPreview(paneId, nextPreviewSid, false);
      }
    },
    [getSessionListPanelState, loadSessionListPreview, updateSessionListPanelState]
  );

  const applyQuickTimePreset = useCallback(
    (paneId: string, preset: "3h" | "24h" | "3d" | "7d" | "30d" | "3m" | "1y") => {
      const now = new Date();
      const from = new Date(now.getTime());
      if (preset === "3h") {
        from.setHours(from.getHours() - 3);
      } else if (preset === "24h") {
        from.setHours(from.getHours() - 24);
      } else if (preset === "3d") {
        from.setDate(from.getDate() - 3);
      } else if (preset === "7d") {
        from.setDate(from.getDate() - 7);
      } else if (preset === "30d") {
        from.setDate(from.getDate() - 30);
      } else if (preset === "3m") {
        from.setMonth(from.getMonth() - 3);
      } else {
        from.setFullYear(from.getFullYear() - 1);
      }
      updateSessionListPanelState(paneId, (current) => ({
        ...current,
        time_from: formatDateTimeLocalValue(from),
        time_to: formatDateTimeLocalValue(now),
        quick_time_preset: preset
      }));
    },
    [updateSessionListPanelState]
  );

  const resetSessionListFilters = useCallback(
    async (paneId: string) => {
      const panel = getSessionListPanelState(paneId);
      const sourceItems = panel.all_items.length ? panel.all_items : panel.items;
      const clearedFilterState = {
        sid_keyword: "",
        time_from: "",
        time_to: "",
        quick_time_preset: "" as const,
        records_min: null,
        records_max: null
      };
      const visibleItems = filterSessionCandidatesByDialog(sourceItems, {
        ...panel,
        ...clearedFilterState
      });
      const nextPreviewSid =
        visibleItems.find((item) => item.session_id === panel.preview_session_id)?.session_id ||
        visibleItems[0]?.session_id ||
        "";
      updateSessionListPanelState(paneId, (current) => ({
        ...current,
        loading: false,
        loading_more: false,
        ...clearedFilterState,
        all_items: sourceItems,
        items: visibleItems,
        total: sourceItems.length,
        offset: sourceItems.length,
        has_more: false,
        preview_session_id: nextPreviewSid,
        preview_rows: nextPreviewSid === current.preview_session_id ? current.preview_rows : [],
        preview_total_rows:
          nextPreviewSid === current.preview_session_id ? current.preview_total_rows : 0,
        preview_loaded_rows:
          nextPreviewSid === current.preview_session_id ? current.preview_loaded_rows : 0,
        preview_has_more:
          nextPreviewSid === current.preview_session_id ? current.preview_has_more : false
      }));
      if (nextPreviewSid && nextPreviewSid !== panel.preview_session_id) {
        await loadSessionListPreview(paneId, nextPreviewSid, false);
      }
    },
    [getSessionListPanelState, loadSessionListPreview, updateSessionListPanelState]
  );

  const reloadSyncSessionList = useCallback(
    async (
      paneId: string,
      overrides?: Partial<
        Pick<
          SyncSessionListState,
          "sid_keyword" | "time_from" | "time_to" | "quick_time_preset" | "records_min" | "records_max" | "sort_mode"
        >
      >,
      preferredPreviewSessionId?: string
    ) => {
      if (!paneId) {
        return;
      }

      const base =
        syncSessionListState.pane_id === paneId ? syncSessionListState : createSyncSessionListState(paneId);
      const effectiveState: SyncSessionListState = {
        ...base,
        ...(overrides || {}),
        pane_id: paneId
      };
      const filters = toSessionListFilterArgs(effectiveState);

      setSyncSessionListState((current) => ({
        ...current,
        ...effectiveState,
        pane_id: paneId,
        loading: true
      }));

      try {
        const response = await loadSessionCandidates(paneId, {
          sortMode: effectiveState.sort_mode,
          offset: 0,
          limit: effectiveState.limit,
          ...filters,
          fullLoad: true
        });

        const seenSessionIds = new Set<string>();
        const allItems: NativeSessionCandidate[] = [];
        for (const item of response.items || []) {
          if (seenSessionIds.has(item.session_id)) {
            continue;
          }
          seenSessionIds.add(item.session_id);
          allItems.push(item);
        }

        const sortedAllItems = sortSessionCandidatesByMode(allItems, effectiveState.sort_mode);
        const visibleItems = filterSessionCandidatesByDialog(sortedAllItems, effectiveState);
        const preferredPreviewSid = (preferredPreviewSessionId ?? syncDialog.preview_session_id).trim();
        const nextPreviewSid = preferredPreviewSid
          ? visibleItems.find((item) => item.session_id === preferredPreviewSid)?.session_id || ""
          : "";

        setSyncSessionListState({
          ...effectiveState,
          pane_id: paneId,
          loading: false,
          all_items: sortedAllItems,
          items: visibleItems,
          total: Number(response.total || sortedAllItems.length)
        });
        setSyncDialog((current) => {
          if (current.pane_id !== paneId) {
            return current;
          }
          const allSessionIdSet = new Set(sortedAllItems.map((item) => item.session_id));
          const nextSelected = current.selected_session_ids.filter((sid) => allSessionIdSet.has(sid));
          return {
            ...current,
            selected_session_ids: nextSelected,
            preview_session_id: nextPreviewSid
          };
        });
      } catch (error) {
        console.error(error);
        setSyncSessionListState((current) => ({ ...current, loading: false }));
        messageApi.error("刷新同步会话失败");
      }
    },
    [loadSessionCandidates, messageApi, syncDialog.preview_session_id, syncDialogCurrentSessionId, syncSessionListState]
  );

  const toggleSyncSessionSortField = useCallback(
    (field: SessionSortField) => {
      const current = splitSessionSortMode(syncSessionListState.sort_mode);
      const nextOrder: SessionSortOrder =
        current.field === field ? (current.order === "asc" ? "desc" : "asc") : "desc";
      const nextMode = toSessionSortMode(field, nextOrder);
      setSyncSessionListState((state) => ({
        ...state,
        sort_mode: nextMode,
        all_items: sortSessionCandidatesByMode(state.all_items, nextMode),
        items: sortSessionCandidatesByMode(state.items, nextMode)
      }));
    },
    [syncSessionListState.sort_mode]
  );

  const applySyncQuickTimePreset = useCallback(
    (preset: "3h" | "24h" | "3d" | "7d" | "30d" | "3m" | "1y") => {
      const now = new Date();
      const from = new Date(now.getTime());
      if (preset === "3h") {
        from.setHours(from.getHours() - 3);
      } else if (preset === "24h") {
        from.setHours(from.getHours() - 24);
      } else if (preset === "3d") {
        from.setDate(from.getDate() - 3);
      } else if (preset === "7d") {
        from.setDate(from.getDate() - 7);
      } else if (preset === "30d") {
        from.setDate(from.getDate() - 30);
      } else if (preset === "3m") {
        from.setMonth(from.getMonth() - 3);
      } else {
        from.setFullYear(from.getFullYear() - 1);
      }
      setSyncSessionListState((current) => ({
        ...current,
        time_from: formatDateTimeLocalValue(from),
        time_to: formatDateTimeLocalValue(now),
        quick_time_preset: preset
      }));
    },
    []
  );

  const applySyncSessionFilters = useCallback(() => {
    const sourceItems = syncSessionListState.all_items.length
      ? syncSessionListState.all_items
      : syncSessionListState.items;
    const visibleItems = filterSessionCandidatesByDialog(sourceItems, syncSessionListState);
    const currentPreviewSid = syncDialog.preview_session_id.trim();
    const nextPreviewSid = currentPreviewSid
      ? visibleItems.find((item) => item.session_id === currentPreviewSid)?.session_id || ""
      : "";

    setSyncSessionListState((current) => ({
      ...current,
      items: visibleItems,
      total: current.all_items.length || visibleItems.length
    }));
    setSyncDialog((current) => ({
      ...current,
      preview_session_id: nextPreviewSid
    }));
  }, [syncDialog.preview_session_id, syncDialogCurrentSessionId, syncSessionListState]);

  const resetSyncSessionFilters = useCallback(() => {
    const sourceItems = syncSessionListState.all_items.length
      ? syncSessionListState.all_items
      : syncSessionListState.items;
    const nextState: SyncSessionListState = {
      ...syncSessionListState,
      sid_keyword: "",
      time_from: "",
      time_to: "",
      quick_time_preset: "",
      records_min: null,
      records_max: null
    };
    const visibleItems = filterSessionCandidatesByDialog(sourceItems, nextState);
    const currentPreviewSid = syncDialog.preview_session_id.trim();
    const nextPreviewSid = currentPreviewSid
      ? visibleItems.find((item) => item.session_id === currentPreviewSid)?.session_id || ""
      : "";

    setSyncSessionListState({
      ...nextState,
      items: visibleItems,
      total: nextState.all_items.length || visibleItems.length
    });
    setSyncDialog((current) => ({
      ...current,
      preview_session_id: nextPreviewSid
    }));
  }, [syncDialog.preview_session_id, syncSessionListState]);

  useEffect(() => {
    for (const pane of panes) {
      const panel = getSessionListPanelState(pane.id);
      const activeSessionId = pane.active_session_id.trim();
      if (!panel.open || !activeSessionId || panel.preview_loading) {
        continue;
      }
      if (panel.preview_session_id.trim() !== activeSessionId) {
        void loadSessionListPreview(pane.id, activeSessionId, false);
      }
    }
  }, [getSessionListPanelState, loadSessionListPreview, panes, sessionListPanels]);

  useEffect(() => {
    for (const pane of panes) {
      const panel = getSessionListPanelState(pane.id);
      const activeSessionId = pane.active_session_id.trim();
      if (
        !panel.open ||
        !activeSessionId ||
        panel.preview_loading ||
        !panel.preview_has_more ||
        !panel.preview_from_end ||
        panel.preview_session_id.trim() !== activeSessionId ||
        !(sessionPreviewFollowBottomRef.current.get(pane.id) ?? true)
      ) {
        continue;
      }
      void loadSessionListPreview(pane.id, activeSessionId, false, {
        fromEnd: true,
        offset: panel.preview_loaded_rows,
        mergeMode: "prepend"
      });
    }
  }, [getSessionListPanelState, loadSessionListPreview, panes, sessionListPanels]);

  useEffect(() => {
    return () => {
      for (const timer of panePreviewAutoRefreshTimerRef.current.values()) {
        window.clearTimeout(timer);
      }
      panePreviewAutoRefreshTimerRef.current.clear();
      if (sessionManageAutoRefreshTimerRef.current !== null) {
        window.clearTimeout(sessionManageAutoRefreshTimerRef.current);
        sessionManageAutoRefreshTimerRef.current = null;
      }
    };
  }, []);

  const loadMoreSessionListDialog = useCallback(
    async (paneId: string) => {
      const panel = getSessionListPanelState(paneId);
      if (!panel.open || panel.loading || panel.loading_more || !panel.has_more) {
        return;
      }
      const ticket = nextSessionListLoadTicket(paneId);
      const filters = toSessionListFilterArgs(panel);
      const offset = panel.offset;
      updateSessionListPanelState(paneId, (current) => ({ ...current, loading_more: true }));
      try {
        const response = await loadSessionCandidates(paneId, {
          sortMode: panel.sort_mode,
          offset,
          limit: panel.limit,
          ...filters
        });
        if (!isSessionListLoadTicketActive(paneId, ticket)) {
          return;
        }
        updateSessionListPanelState(paneId, (current) => {
          const existingIds = new Set(current.all_items.map((item) => item.session_id));
          const appended = response.items.filter((item) => !existingIds.has(item.session_id));
          const allItems = [...current.all_items, ...appended];
          const visibleItems = filterSessionCandidatesByDialog(allItems, current);
          return {
            ...current,
            loading_more: false,
            all_items: allItems,
            items: visibleItems,
            unrecognized_files: response.unrecognized_files || [],
            total: response.total,
            offset: response.offset + response.items.length,
            has_more: response.has_more
          };
        });
        if (response.has_more) {
          void autoLoadRemainingSessionCandidates(
            paneId,
            ticket,
            panel.sort_mode,
            filters,
            response.offset + response.items.length,
            panel.limit
          );
        }
      } catch (error) {
        if (!isSessionListLoadTicketActive(paneId, ticket)) {
          return;
        }
        console.error(error);
        updateSessionListPanelState(paneId, (current) => ({ ...current, loading_more: false }));
        messageApi.error("加载更多会话失败");
      }
    },
    [
      autoLoadRemainingSessionCandidates,
      getSessionListPanelState,
      isSessionListLoadTicketActive,
      loadSessionCandidates,
      messageApi,
      nextSessionListLoadTicket,
      updateSessionListPanelState
    ]
  );

  const previewSessionListCandidate = useCallback(
    async (paneId: string, sessionId: string) => {
      await loadSessionListPreview(paneId, sessionId, false);
    },
    [loadSessionListPreview]
  );

  const loadAllSessionListPreviewRows = useCallback(
    async (paneId: string) => {
      const panel = getSessionListPanelState(paneId);
      const sessionId = panel.preview_session_id.trim();
      if (!sessionId || panel.preview_loading) {
        return;
      }
      await loadSessionListPreview(paneId, sessionId, true);
    },
    [getSessionListPanelState, loadSessionListPreview]
  );

  const queuePanePreviewAutoRefresh = useCallback(
    (paneId: string) => {
      if (panePreviewAutoRefreshTimerRef.current.has(paneId)) {
        return;
      }
      const timer = window.setTimeout(() => {
        panePreviewAutoRefreshTimerRef.current.delete(paneId);
        if (panePreviewAutoRefreshRunningRef.current.has(paneId)) {
          return;
        }
        const pane = panes.find((item) => item.id === paneId);
        const activeSessionId = pane?.active_session_id.trim() ?? "";
        const panel = getSessionListPanelState(paneId);
        if (
          !pane ||
          !panel.open ||
          !panel.preview_auto_refresh ||
          !activeSessionId ||
          panel.preview_loading ||
          panel.preview_session_id.trim() !== activeSessionId
        ) {
          return;
        }
        panePreviewAutoRefreshRunningRef.current.add(paneId);
        void loadSessionListPreview(paneId, activeSessionId, false)
          .catch((error) => console.error(error))
          .finally(() => {
            panePreviewAutoRefreshRunningRef.current.delete(paneId);
          });
      }, 500);
      panePreviewAutoRefreshTimerRef.current.set(paneId, timer);
    },
    [getSessionListPanelState, loadSessionListPreview, panes]
  );

  const queueSessionManageAutoRefresh = useCallback(
    (paneId: string) => {
      if (sessionManageAutoRefreshTimerRef.current !== null) {
        return;
      }
      const timer = window.setTimeout(() => {
        sessionManageAutoRefreshTimerRef.current = null;
        if (sessionManageAutoRefreshRunningRef.current) {
          return;
        }
        if (
          !sessionManageDialog.open ||
          paneId !== sessionManagePaneId ||
          !sessionManageListState?.preview_auto_refresh
        ) {
          return;
        }
        sessionManageAutoRefreshRunningRef.current = true;
        void refreshSessionManageLiveView(
          paneId,
          sessionManagePreview.preview_session_id,
          sessionManageIsListView
        )
          .catch((error) => console.error(error))
          .finally(() => {
            sessionManageAutoRefreshRunningRef.current = false;
          });
      }, 500);
      sessionManageAutoRefreshTimerRef.current = timer;
    },
    [
      refreshSessionManageLiveView,
      sessionManageDialog.open,
      sessionManageIsListView,
      sessionManageListState?.preview_auto_refresh,
      sessionManagePaneId,
      sessionManagePreview.preview_session_id
    ]
  );

  useEffect(() => {
    queuePanePreviewAutoRefreshRef.current = queuePanePreviewAutoRefresh;
  }, [queuePanePreviewAutoRefresh]);

  useEffect(() => {
    queueSessionManageAutoRefreshRef.current = queueSessionManageAutoRefresh;
  }, [queueSessionManageAutoRefresh]);

  const openAllSessionPanels = useCallback(async () => {
    for (const pane of panes) {
      updateSessionListPanelState(pane.id, (current) => ({ ...current, open: true }));
    }
    await Promise.all(panes.map((pane) => reloadSessionListDialog(pane.id)));
  }, [panes, reloadSessionListDialog, updateSessionListPanelState]);

  const closeAllSessionPanels = useCallback(() => {
    for (const pane of panes) {
      void nextSessionListLoadTicket(pane.id);
      void nextSessionPreviewLoadTicket(pane.id);
      updateSessionListPanelState(pane.id, (current) => ({
        ...current,
        open: false,
        loading: false,
        loading_more: false,
        preview_loading: false
      }));
    }
  }, [nextSessionListLoadTicket, nextSessionPreviewLoadTicket, panes, updateSessionListPanelState]);

  const toggleAllSessionPanels = useCallback(async () => {
    if (allSessionPanelsOpen) {
      closeAllSessionPanels();
      return;
    }
    await openAllSessionPanels();
  }, [allSessionPanelsOpen, closeAllSessionPanels, openAllSessionPanels]);

  useEffect(() => {
    if (!panes.length || sessionPanelBootRef.current) {
      return;
    }
    sessionPanelBootRef.current = true;
    let openMap: Record<string, boolean> = {};
    try {
      const raw = localStorage.getItem(STORAGE_SESSION_PANEL_OPEN_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        for (const [paneId, value] of Object.entries(parsed)) {
          openMap[paneId] = Boolean(value);
        }
      }
    } catch {
      openMap = {};
    }
    for (const pane of panes) {
      if (!openMap[pane.id]) {
        continue;
      }
      updateSessionListPanelState(pane.id, (current) => ({ ...current, open: true }));
      void reloadSessionListDialog(pane.id);
    }
    sessionPanelPersistReadyRef.current = true;
  }, [panes, reloadSessionListDialog, updateSessionListPanelState]);

  useEffect(() => {
    if (!sessionManageDialog.open) {
      return;
    }
    const paneId = sessionManageDialog.pane_id.trim();
    if (!paneId) {
      return;
    }
    let cancelled = false;
    const run = async () => {
      try {
        await refreshNativeSessionCache(paneId);
      } catch (error) {
        if (!cancelled) {
          console.error(error);
        }
      }
      if (cancelled) {
        return;
      }
      try {
        await reloadSessionListDialog(paneId, {
          sid_keyword: "",
          time_from: "",
          time_to: "",
          quick_time_preset: "",
          records_min: null,
          records_max: null
        }, { fullLoad: true, keepPanelClosed: true });
      } catch (error) {
        if (cancelled) {
          return;
        }
        console.error(error);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [
    refreshNativeSessionCache,
    reloadSessionListDialog,
    sessionManageDialog.open,
    sessionManageDialog.pane_id
  ]);

  useEffect(() => {
    if (!sessionManageDialog.open) {
      return;
    }
    const paneId = sessionManagePaneId;
    if (!paneId) {
      return;
    }
    if (!sessionManageLoadingActive) {
      return;
    }
    let stopped = false;
    let timer: number | null = null;
    const tick = async () => {
      try {
        await refreshScanProgress(paneId);
      } catch (error) {
        if (!stopped) {
          console.error(error);
        }
      } finally {
        if (!stopped) {
          timer = window.setTimeout(tick, 280);
        }
      }
    };
    void tick();
    return () => {
      stopped = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [
    refreshScanProgress,
    sessionManageDialog.open,
    sessionManageLoadingActive,
    sessionManagePaneId
  ]);

  const saveThemeConfig = useCallback(async () => {
    if (savingTheme) {
      return;
    }
    setSavingTheme(true);
    try {
      const response = await invoke<UiThemeConfigResponse>("set_ui_theme_config", {
        uiThemePreset: uiThemePreset,
        uiSkinHue: uiSkinHue,
        uiSkinAccent: normalizeHexColor(uiSkinAccent)
      });
      setUiThemePreset(normalizeThemePreset(response.ui_theme_preset));
      setUiSkinHue(Number(response.ui_skin_hue || DEFAULT_SKIN_HUE));
      setUiSkinAccent(normalizeHexColor(response.ui_skin_accent || DEFAULT_SKIN_ACCENT));
      messageApi.success("主题已保存");
    } catch (error) {
      console.error(error);
      messageApi.error("保存主题失败");
    } finally {
      setSavingTheme(false);
    }
  }, [messageApi, savingTheme, uiSkinAccent, uiSkinHue, uiThemePreset]);

  const pickAvatarFile = useCallback(
    async (kind: "user" | "assistant") => {
      try {
        const currentPath = (kind === "user" ? userAvatarPath : assistantAvatarPath).trim();
        const selected = await openDialog({
          directory: false,
          multiple: false,
          defaultPath:
            currentPath && !currentPath.startsWith("@") ? currentPath : workingDirectory.trim() || undefined,
          filters: [
            {
              name: "Image",
              extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"]
            }
          ],
          title: kind === "user" ? "选择用户头像" : "选择 AI 头像"
        });
        if (typeof selected === "string") {
          const nextPath = selected.trim();
          if (kind === "user") {
            setUserAvatarPath(nextPath || DEFAULT_USER_AVATAR_TOKEN);
          } else {
            setAssistantAvatarPath(nextPath || DEFAULT_ASSISTANT_AVATAR_TOKEN);
          }
        }
      } catch (error) {
        console.error(error);
        messageApi.error("打开头像选择器失败");
      }
    },
    [assistantAvatarPath, messageApi, userAvatarPath, workingDirectory]
  );

  const saveAvatarConfig = useCallback(async () => {
    if (savingAvatars) {
      return;
    }
    setSavingAvatars(true);
    try {
      const response = await invoke<AvatarConfigResponse>("set_avatar_config", {
        userAvatarPath: normalizeAvatarPath(userAvatarPath, DEFAULT_USER_AVATAR_TOKEN),
        assistantAvatarPath: normalizeAvatarPath(
          assistantAvatarPath,
          DEFAULT_ASSISTANT_AVATAR_TOKEN
        )
      });
      setUserAvatarPath(
        normalizeAvatarPath(response.user_avatar_path, DEFAULT_USER_AVATAR_TOKEN)
      );
      setAssistantAvatarPath(
        normalizeAvatarPath(response.assistant_avatar_path, DEFAULT_ASSISTANT_AVATAR_TOKEN)
      );
      messageApi.success("头像配置已保存");
    } catch (error) {
      console.error(error);
      messageApi.error("保存头像配置失败");
    } finally {
      setSavingAvatars(false);
    }
  }, [assistantAvatarPath, messageApi, savingAvatars, userAvatarPath]);

  const pickWorkingDirectory = useCallback(async () => {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        defaultPath: workingDirectory.trim() || undefined,
        title: "选择工作目录"
      });
      if (typeof selected === "string") {
        setWorkingDirectory(selected.trim());
      }
    } catch (error) {
      console.error(error);
      messageApi.error("打开目录选择器失败");
    }
  }, [messageApi, workingDirectory]);

  const applyWorkingDirectory = useCallback(async () => {
    if (applyingWorkdir) {
      return;
    }
    setApplyingWorkdir(true);
    try {
      const applied = await invoke<string | null>("set_working_directory", {
        path: workingDirectory.trim() || null,
        restartOpenPanes: true
      });
      setWorkingDirectory((applied || "").trim());
      messageApi.success("工作目录已应用");
    } catch (error) {
      console.error(error);
      messageApi.error("应用工作目录失败");
    } finally {
      setApplyingWorkdir(false);
    }
  }, [applyingWorkdir, messageApi, workingDirectory]);

  const pickTeamDirectory = useCallback(async () => {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        defaultPath: createPaneDialog.team_directory.trim() || workingDirectory.trim() || undefined,
        title: "选择团队目录"
      });
      if (typeof selected === "string") {
        setCreatePaneDialog((current) => ({ ...current, team_directory: selected.trim() }));
      }
    } catch (error) {
      console.error(error);
      messageApi.error("打开目录选择器失败");
    }
  }, [createPaneDialog.team_directory, messageApi, workingDirectory]);

  if (isStandaloneSessionPreviewRoute) {
    const activeSessionId = standaloneSessionPreviewPane?.active_session_id.trim() ?? "";
    const previewAvailable = Boolean(standaloneSessionPreviewPane && activeSessionId);
    return (
      <ConfigProvider theme={antdThemeConfig}>
        {contextHolder}
        <Layout className="app-shell">
          <Layout.Content className="app-content standalone-session-preview-content">
            <div className="standalone-session-preview-page">
              <div className="session-list-right standalone-session-preview-shell">
                <Card size="small" title="当前会话预览" className="standalone-session-preview-card">
                  <div className="standalone-session-preview-body">
                    {loading ? (
                      <div className="session-preview-loading">
                        <Spin size="large" />
                      </div>
                    ) : !standaloneSessionPreviewPane ? (
                      <Typography.Text type="secondary">目标窗格不存在或已关闭</Typography.Text>
                    ) : (
                      <>
                        <Space size={8} wrap className="standalone-session-preview-meta">
                          <Tag>{asTitle(standaloneSessionPreviewPane.provider)}</Tag>
                          <Tag>{standaloneSessionPreviewPane.title || standaloneSessionPreviewPane.id}</Tag>
                          <Tag color={activeSessionId ? "cyan" : "default"}>
                            SID: {activeSessionId ? shortSessionId(activeSessionId) : "未绑定"}
                          </Tag>
                        </Space>

                        <div className="session-preview-head">
                          <Typography.Text type="secondary">
                            SID：{sessionManagePreview.preview_session_id ? shortSessionId(sessionManagePreview.preview_session_id) : "-"}
                          </Typography.Text>
                          <Space size={6}>
                            <Button
                              size="small"
                              icon={<CompressOutlined />}
                              onClick={() => void toggleStandaloneSessionPreviewCompactMode()}
                            >
                              {standaloneSessionPreviewCompactMode ? "恢复" : "最小化"}
                            </Button>
                            <Button
                              size="small"
                              type={standaloneSessionPreviewAlwaysOnTop ? "primary" : "default"}
                              icon={<PushpinOutlined />}
                              onClick={() => void toggleStandaloneSessionPreviewAlwaysOnTop()}
                            >
                              {standaloneSessionPreviewAlwaysOnTop ? "已置顶" : "置顶"}
                            </Button>
                            <Button
                              size="small"
                              icon={<SyncOutlined />}
                              onClick={() => void refreshStandaloneSessionPreview(standaloneSessionPreviewPane.id)}
                              loading={sessionManagePreview.preview_loading}
                              disabled={!standaloneSessionPreviewPane}
                            >
                              刷新
                            </Button>
                            <Button
                              size="small"
                              type={standaloneSessionPreviewListState?.preview_auto_refresh ? "primary" : "default"}
                              icon={<SyncOutlined spin={Boolean(standaloneSessionPreviewListState?.preview_auto_refresh)} />}
                              onClick={() => toggleSessionPreviewAutoRefresh(standaloneSessionPreviewPane.id)}
                              disabled={!previewAvailable}
                            >
                              {standaloneSessionPreviewListState?.preview_auto_refresh ? "自动刷新中" : "自动刷新"}
                            </Button>
                            <Typography.Text type="secondary">
                              已加载 {sessionManagePreview.preview_loaded_rows}/{sessionManagePreview.preview_total_rows}
                            </Typography.Text>
                          </Space>
                        </div>

                        <div className="session-preview-scroll">
                          {sessionManagePreview.preview_loading && !sessionManagePreview.preview_rows.length ? (
                            <div className="session-preview-loading">
                              <Spin />
                            </div>
                          ) : previewAvailable ? (
                            <SyncEntryPreviewList
                              show_checkbox={false}
                              user_avatar_src={userAvatarSrc}
                              assistant_avatar_src={assistantAvatarSrc}
                              auto_follow_bottom
                              items={sessionManagePreview.preview_rows.map((row, index) => ({
                                id: row.id || `${row.created_at}-${index}-${row.kind}`,
                                kind: row.kind,
                                content: row.content,
                                created_at: row.created_at,
                                created_at_text: formatTs(row.created_at),
                                sid_text: sessionManagePreview.preview_session_id
                                  ? shortSessionId(sessionManagePreview.preview_session_id)
                                  : "-",
                                included: true,
                                preview_truncated: Boolean(row.preview_truncated),
                                favorite_target: {
                                  pane_id: standaloneSessionPreviewPane.id,
                                  pane_title: standaloneSessionPreviewPane.title || "",
                                  provider: standaloneSessionPreviewPane.provider || "",
                                  session_id: sessionManagePreview.preview_session_id
                                }
                              }))}
                              empty_text="当前会话暂无预览消息"
                              is_favorited={isPreviewMessageFavorited}
                              on_toggle_favorite={togglePreviewMessageFavorite}
                              on_request_full_content={(item) =>
                                loadNativePreviewMessageDetail(
                                  standaloneSessionPreviewPane.id,
                                  sessionManagePreview.preview_session_id,
                                  item
                                )
                              }
                            />
                          ) : (
                            <Typography.Text type="secondary">当前窗格尚未绑定 SID，暂无可预览消息</Typography.Text>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                </Card>
              </div>
            </div>
          </Layout.Content>
        </Layout>
      </ConfigProvider>
    );
  }

  return (
    <ConfigProvider theme={antdThemeConfig}>
      {contextHolder}
      <Layout className="app-shell">
        <Layout.Header className="topbar" style={headerStyle}>
          <div className="topbar-left">
            {isWorkspaceLikeRoute ? (
              <>
                <Button type="primary" icon={<PlusOutlined />} onClick={() => openCreatePaneDialog()}>
                  {isTeamRoute ? "新建团队" : "新建终端"}
                </Button>
                <Segmented
                  value={layoutMode}
                  onChange={(value) => setLayoutMode(value === "horizontal" ? "horizontal" : "vertical")}
                  options={[
                    { value: "vertical", label: "竖屏" },
                    { value: "horizontal", label: "横屏" }
                  ]}
                />
              </>
            ) : (
              (workbenchHeaderActions?.left ?? []).map((action) => (
                <Button
                  key={action.key}
                  type={action.primary ? "primary" : "default"}
                  danger={action.danger}
                  loading={action.loading}
                  disabled={action.disabled}
                  onClick={action.onClick}
                >
                  {action.label}
                </Button>
              ))
            )}
          </div>
          <div className="topbar-right">
            {isWorkspaceLikeRoute ? (
              <>
                <Button
                  danger
                  loading={clearingAllSid}
                  disabled={!panesWithSessionBindings.length}
                  onClick={() => void clearAllPaneSessionBindings()}
                >
                  清空全部SID
                </Button>
                <Button onClick={() => void openStandaloneCollabWorkbenchWindow()}>
                  协作工作台
                </Button>
                <Button onClick={() => navigateTo("favorites")}>
                  收藏消息
                </Button>
                <Button
                  type={allSessionPanelsOpen ? "default" : "primary"}
                  disabled={!panes.length}
                  onClick={() => void toggleAllSessionPanels()}
                >
                  {allSessionPanelsOpen ? "全部收起会话" : "全部展开会话"}
                </Button>
                <Button icon={<SettingOutlined />} onClick={() => setConfigOpen(true)}>
                  配置
                </Button>
              </>
            ) : (
              <>
                {(workbenchHeaderActions?.right ?? []).map((action) => (
                  <Button
                    key={action.key}
                    type={action.primary ? "primary" : "default"}
                    danger={action.danger}
                    loading={action.loading}
                    disabled={action.disabled}
                    onClick={action.onClick}
                  >
                    {action.label}
                  </Button>
                ))}
                {!isFavoritesRoute ? (
                  <Button onClick={() => navigateTo("favorites")}>
                    收藏消息
                  </Button>
                ) : null}
                <Button icon={<SettingOutlined />} onClick={() => setConfigOpen(true)}>
                  通用配置
                </Button>
                <Button
                  onClick={() => {
                    if (isStandaloneCollabWindow) {
                      void currentWebviewWindow.close().catch((error) => console.error(error));
                      return;
                    }
                    navigateTo("workspace");
                  }}
                >
                  {isStandaloneCollabWindow ? "关闭窗口" : "终端工作台"}
                </Button>
              </>
            )}
          </div>
        </Layout.Header>

        <Layout.Content className="app-content">
          {loading ? (
            <div className="loading-wrap">
              <Spin size="large" tip="正在加载终端..." />
            </div>
          ) : isWorkspaceLikeRoute ? (
            <div className="workspace-content-shell">
              <main className="pane-grid" style={gridStyle}>
                {panes.map((pane) => {
                const sessionListDialog =
                  sessionListPanels[pane.id] ?? { ...createSessionListDialogState(), pane_id: pane.id };
                const statusDensityClass =
                  panes.length >= 3
                    ? "status-density-icon"
                    : panes.length === 2
                      ? "status-density-compact"
                      : "status-density-normal";
                return (
                  <Card
                  key={pane.id}
                  size="small"
                  className={`pane-card ${activePaneId === pane.id ? "active" : ""}`}
                  title={
                    <Space size={6}>
                      <Typography.Text strong>{asTitle(pane.provider)}</Typography.Text>
                      <Typography.Text type="secondary">{pane.title}</Typography.Text>
                    </Space>
                  }
                  extra={
                    <Tooltip title="关闭终端">
                      <Button
                        type="text"
                        icon={<CloseOutlined />}
                        danger
                        aria-label="关闭终端"
                        onClick={() => void closePane(pane.id)}
                      />
                    </Tooltip>
                  }
                  onMouseDown={() => setActivePaneId(pane.id)}
                >
                  <div className="pane-split-layout" ref={getPaneSplitContainerRef(pane.id)}>
                    <div className="pane-top-section">
                      <div className="pane-terminal">
                        <div className="terminal-mount" ref={getTerminalMountRef(pane.id)} />
                      </div>

                      <div className={`pane-statusbar ${statusDensityClass}`}>
                        <div className="status-info">
                          <Tooltip
                            title={
                              pane.active_session_id
                                ? "打开会话管理"
                                : pane.sid_checking
                                  ? "正在读取状态信息"
                                  : "点击读取状态信息绑定 SID"
                            }
                          >
                            <Tag
                              color={pane.active_session_id ? "cyan" : "default"}
                              className={`status-click-tag ${pane.sid_checking ? "is-disabled" : ""}`}
                              onClick={() =>
                                pane.active_session_id
                                  ? openSessionManageDialog(pane.id)
                                  : pane.sid_checking
                                    ? undefined
                                    : void detectSid(pane.id)
                              }
                            >
                            SID: {
                              pane.active_session_id
                                ? shortSessionId(pane.active_session_id)
                                : pane.sid_checking
                                  ? "检测中..."
                                  : "未检测"
                            }
                            </Tag>
                          </Tooltip>
                          <Tooltip title="打开会话管理">
                            <Tag
                              color={pane.linked_session_ids.length > 0 ? "blue" : "default"}
                              className="status-click-tag"
                              onClick={() => openSessionManageDialog(pane.id)}
                            >
                              关联: {pane.linked_session_ids.length}
                            </Tag>
                          </Tooltip>
                          <Tag color={pane.scan_running ? "processing" : "default"}>
                            缓存构建: {pane.scan_processed_files}/{pane.scan_total_files}
                          </Tag>
                          <Tag>变更: {pane.scan_changed_files}</Tag>
                        </div>
                        <div className="status-cache-progress">
                          <Progress
                            percent={
                              pane.scan_total_files > 0
                                ? Math.min(
                                    100,
                                    Math.round((Math.max(0, pane.scan_processed_files) / pane.scan_total_files) * 100)
                                  )
                                : 0
                            }
                            size="small"
                            showInfo={false}
                            status={
                              pane.scan_running
                                ? "active"
                                : pane.scan_total_files > 0 && pane.scan_processed_files >= pane.scan_total_files
                                  ? "success"
                                  : "normal"
                            }
                          />
                          <Typography.Text type="secondary" className="status-cache-progress-text">
                            {pane.scan_running
                              ? `文件缓存构建 ${pane.scan_processed_files}/${pane.scan_total_files || "?"}`
                              : pane.scan_total_files > 0
                                ? `文件缓存就绪 ${pane.scan_processed_files}/${pane.scan_total_files}`
                                : "文件缓存待构建"}
                          </Typography.Text>
                        </div>
                        <div className="status-actions">
                          <Tooltip title="同步">
                            <Button
                              size="small"
                              className="status-action-btn status-btn-sync"
                              icon={<SyncOutlined />}
                              type={panes.length >= 2 ? "primary" : "default"}
                              disabled={panes.length < 2}
                              onClick={() => void openSyncDialog(pane.id)}
                            >
                              <span className="status-btn-label-full">同步</span>
                              <span className="status-btn-label-short">同</span>
                            </Button>
                          </Tooltip>
                          <Tooltip title="会话列表">
                            <Button
                              size="small"
                              className="status-action-btn status-btn-session-list"
                              icon={<SearchOutlined />}
                              type={sessionListDialog.open ? "primary" : "default"}
                              onClick={() => void openSessionListDialog(pane.id)}
                            >
                              <span className="status-btn-label-full">会话列表</span>
                              <span className="status-btn-label-short">列</span>
                            </Button>
                          </Tooltip>
                          <Tooltip title="当前会话预览窗口">
                            <Button
                              size="small"
                              className="status-action-btn status-btn-session-list"
                              icon={<SearchOutlined />}
                              onClick={() => void openStandaloneSessionPreviewWindow(pane.id)}
                            >
                              <span className="status-btn-label-full">当前会话窗</span>
                              <span className="status-btn-label-short">窗</span>
                            </Button>
                          </Tooltip>
                        </div>
                      </div>
                    </div>

                  {sessionListDialog.open ? (
                    <>
                    <div
                      className="pane-preview-splitter"
                      onMouseDown={(event) => startPanePreviewResize(pane.id, event)}
                    >
                      <div className="pane-preview-splitter-grip" />
                    </div>
                    <div
                      className="session-inline-panel session-inline-preview-only pane-resizable-preview"
                      style={{
                        flexBasis: `${sessionListDialog.preview_panel_height}px`,
                        minHeight: `${sessionListDialog.preview_panel_height}px`,
                        maxHeight: `${sessionListDialog.preview_panel_height}px`
                      }}
                    >
                      <Card size="small" title="会话预览" className="session-inline-preview-card">
                        {(() => {
                          const inlinePreviewSessionId = pane.active_session_id.trim();
                          const inlinePreviewActive =
                            inlinePreviewSessionId.length > 0 &&
                            sessionListDialog.preview_session_id.trim() === inlinePreviewSessionId;
                          const inlinePreviewRows = inlinePreviewActive ? sessionListDialog.preview_rows : [];
                          const inlinePreviewLoadedRows = inlinePreviewActive
                            ? sessionListDialog.preview_loaded_rows
                            : 0;
                          const inlinePreviewTotalRows = inlinePreviewActive
                            ? sessionListDialog.preview_total_rows
                            : 0;
                          const inlinePreviewHasMore = inlinePreviewActive
                            ? sessionListDialog.preview_has_more
                            : false;

                          return (
                            <>
                        <div className="session-preview-head">
                          <Typography.Text type="secondary">
                            SID：
                            {inlinePreviewSessionId ? shortSessionId(inlinePreviewSessionId) : "-"}
                          </Typography.Text>
                          <Space size={6}>
                            <Button
                              size="small"
                              type={sessionListDialog.preview_auto_refresh ? "primary" : "default"}
                              icon={<SyncOutlined spin={sessionListDialog.preview_auto_refresh} />}
                              onClick={() => toggleSessionPreviewAutoRefresh(pane.id)}
                              disabled={!inlinePreviewSessionId}
                            >
                              {sessionListDialog.preview_auto_refresh ? "自动刷新中" : "自动刷新"}
                            </Button>
                            <Typography.Text type="secondary">
                              已加载 {inlinePreviewLoadedRows}/{inlinePreviewTotalRows}
                            </Typography.Text>
                          </Space>
                        </div>

                        <div className="session-preview-scroll">
                          {sessionListDialog.preview_loading && !inlinePreviewRows.length ? (
                            <div className="session-preview-loading">
                              <Spin />
                            </div>
                          ) : (
                            <SyncEntryPreviewList
                              show_checkbox={false}
                              user_avatar_src={userAvatarSrc}
                              assistant_avatar_src={assistantAvatarSrc}
                              auto_follow_bottom
                              on_follow_bottom_change={(following) =>
                                sessionPreviewFollowBottomRef.current.set(pane.id, following)
                              }
                              on_reach_top={
                                inlinePreviewSessionId && sessionListDialog.preview_has_more
                                  ? () =>
                                      void loadSessionListPreview(pane.id, inlinePreviewSessionId, false, {
                                        fromEnd: true,
                                        offset: sessionListDialog.preview_loaded_rows,
                                        mergeMode: "prepend"
                                      })
                                  : undefined
                              }
                              items={inlinePreviewRows.map((row, index) => ({
                                id: row.id || `${row.created_at}-${index}-${row.kind}`,
                                kind: row.kind,
                                content: row.content,
                                created_at: row.created_at,
                                created_at_text: formatTs(row.created_at),
                                sid_text: inlinePreviewSessionId
                                  ? shortSessionId(inlinePreviewSessionId)
                                  : "-",
                                included: true,
                                preview_truncated: Boolean(row.preview_truncated),
                                favorite_target: inlinePreviewSessionId
                                  ? {
                                      pane_id: pane.id,
                                      pane_title: pane.title || "",
                                      provider: pane.provider || "",
                                      session_id: inlinePreviewSessionId
                                    }
                                  : undefined
                              }))}
                              empty_text={
                                inlinePreviewSessionId ? "当前 SID 暂无预览消息" : "当前窗格未绑定 SID"
                              }
                              is_favorited={isPreviewMessageFavorited}
                              on_toggle_favorite={togglePreviewMessageFavorite}
                              on_request_full_content={(item) =>
                                loadNativePreviewMessageDetail(
                                  pane.id,
                                  inlinePreviewSessionId,
                                  item
                                )
                              }
                            />
                          )}
                        </div>
                            </>
                          );
                        })()}
                      </Card>
                    </div>
                    </>
                  ) : null}
                  </div>
                  </Card>
                  );
                })}
              </main>
            </div>
          ) : isFavoritesRoute ? (
            <FavoriteMessagesPage
              favorites={favoriteMessages}
              loading={loading}
              onRefresh={() => void loadFavoriteMessages()}
              onOpenFavorite={(favorite) => void openFavoriteMessageInSessionManage(favorite)}
              onRemoveFavorite={(favoriteId) => void removeFavoriteMessage(favoriteId)}
              onClose={() => navigateTo("workspace")}
            />
          ) : isAiTeamRoute ? (
            <AiTeamMcpPage
              providers={providers}
              defaultProjectDirectory={workingDirectory}
              onOpenCommonSettings={() => setConfigOpen(true)}
              onSyncPaneSessionState={hydratePaneSessionState}
              onProbePaneSessionId={readPaneSessionIdFromTerminal}
              onHeaderActionsChange={setWorkbenchHeaderActions}
              onClose={() => {
                navigateTo("workspace");
              }}
            />
          ) : (
            <CollabWorkbenchPage
              providers={providers}
              defaultProjectDirectory={workingDirectory}
              onOpenCommonSettings={() => setConfigOpen(true)}
              onSyncPaneSessionState={hydratePaneSessionState}
              onProbePaneSessionId={readPaneSessionIdFromTerminal}
              onHeaderActionsChange={setWorkbenchHeaderActions}
              onClose={() => {
                if (isStandaloneCollabWindow) {
                  void currentWebviewWindow.close().catch((error) => console.error(error));
                  return;
                }
                navigateTo("workspace");
              }}
            />
          )}
        </Layout.Content>
      </Layout>

      <Drawer
        title="配置"
        width={440}
        open={configOpen}
        onClose={() => setConfigOpen(false)}
        destroyOnClose={false}
      >
        <Tabs
          activeKey={configTab}
          onChange={setConfigTab}
          items={[
            {
              key: "theme",
              label: "主题",
              children: (
                <Form layout="vertical">
                  <Form.Item label="主题预设">
                    <Select
                      value={uiThemePreset}
                      onChange={(value) => setUiThemePreset(normalizeThemePreset(String(value)))}
                      options={[
                        { value: "ocean", label: "海洋" },
                        { value: "forest", label: "森林" },
                        { value: "sunset", label: "日落" },
                        { value: "graphite", label: "石墨" },
                        { value: "custom", label: "自定义" }
                      ]}
                    />
                  </Form.Item>
                  <Form.Item label="明暗模式">
                    <Segmented
                      value={uiColorMode}
                      onChange={(value) => setUiColorMode(normalizeColorMode(String(value)))}
                      options={[
                        { value: "dark", label: "暗色" },
                        { value: "light", label: "亮色" },
                        { value: "system", label: "跟随系统" }
                      ]}
                    />
                  </Form.Item>
                  <Form.Item label={`色相 Hue (${uiSkinHue})`}>
                    <InputNumber
                      value={uiSkinHue}
                      min={0}
                      max={360}
                      onChange={(value) => setUiSkinHue(Math.max(0, Math.min(360, Number(value || 0))))}
                      style={{ width: "100%" }}
                    />
                  </Form.Item>
                  <Form.Item label="强调色">
                    <ColorPicker
                      value={uiSkinAccent}
                      onChangeComplete={(value) => setUiSkinAccent(value.toHexString())}
                      showText
                    />
                  </Form.Item>
                  <Button type="primary" loading={savingTheme} onClick={() => void saveThemeConfig()}>
                    保存主题
                  </Button>
                </Form>
              )
            },
            {
              key: "workdir",
              label: "目录",
              children: (
                <Form layout="vertical">
                  <Form.Item label="配置文件路径">
                    <Typography.Text copyable>{configPath || "(未加载)"}</Typography.Text>
                  </Form.Item>
                  <Form.Item label="工作目录">
                    <Input
                      value={workingDirectory}
                      placeholder="留空表示使用默认目录"
                      onChange={(event) => setWorkingDirectory(event.target.value)}
                    />
                  </Form.Item>
                  <Space>
                    <Button icon={<FolderOpenOutlined />} onClick={() => void pickWorkingDirectory()}>
                      选择目录
                    </Button>
                    <Button type="primary" loading={applyingWorkdir} onClick={() => void applyWorkingDirectory()}>
                      保存并应用
                    </Button>
                  </Space>
                </Form>
              )
            },
            {
              key: "avatar",
              label: "头像",
              children: (
                <Form layout="vertical">
                  <Form.Item
                    label="用户头像"
                    extra="默认使用 @man.jpg，也可以选择本地图片覆盖。"
                  >
                    <Space direction="vertical" size={12} style={{ width: "100%" }}>
                      <Space align="center" size={12}>
                        <Avatar size={56} src={userAvatarSrc} />
                        <Typography.Text copyable>
                          {userAvatarPath || DEFAULT_USER_AVATAR_TOKEN}
                        </Typography.Text>
                      </Space>
                      <Space wrap>
                        <Button onClick={() => void pickAvatarFile("user")}>选择图片</Button>
                        <Button onClick={() => setUserAvatarPath(DEFAULT_USER_AVATAR_TOKEN)}>
                          恢复默认
                        </Button>
                      </Space>
                    </Space>
                  </Form.Item>
                  <Form.Item
                    label="AI 头像"
                    extra="默认使用 @ai.jpg，也可以选择本地图片覆盖。"
                  >
                    <Space direction="vertical" size={12} style={{ width: "100%" }}>
                      <Space align="center" size={12}>
                        <Avatar size={56} src={assistantAvatarSrc} />
                        <Typography.Text copyable>
                          {assistantAvatarPath || DEFAULT_ASSISTANT_AVATAR_TOKEN}
                        </Typography.Text>
                      </Space>
                      <Space wrap>
                        <Button onClick={() => void pickAvatarFile("assistant")}>选择图片</Button>
                        <Button onClick={() => setAssistantAvatarPath(DEFAULT_ASSISTANT_AVATAR_TOKEN)}>
                          恢复默认
                        </Button>
                      </Space>
                    </Space>
                  </Form.Item>
                  <Button type="primary" loading={savingAvatars} onClick={() => void saveAvatarConfig()}>
                    保存头像
                  </Button>
                </Form>
              )
            },
            {
              key: "compress",
              label: "压缩",
              children: (
                <Form layout="vertical">
                  <Form.Item label="启用同步前压缩">
                    <Switch
                      checked={compressConfig.enabled}
                      onChange={(checked) =>
                        setCompressConfig((current) => ({ ...current, enabled: checked }))
                      }
                    />
                  </Form.Item>
                  <Form.Item label="Token 阈值">
                    <InputNumber
                      min={800}
                      max={64000}
                      value={compressConfig.token_waterline}
                      onChange={(value) =>
                        setCompressConfig((current) => ({
                          ...current,
                          token_waterline: Math.max(800, Math.min(64000, Number(value || 800)))
                        }))
                      }
                      style={{ width: "100%" }}
                    />
                  </Form.Item>
                  <Form.Item label="轮次阈值">
                    <InputNumber
                      min={1}
                      max={200}
                      value={compressConfig.turn_waterline}
                      onChange={(value) =>
                        setCompressConfig((current) => ({
                          ...current,
                          turn_waterline: Math.max(1, Math.min(200, Number(value || 1)))
                        }))
                      }
                      style={{ width: "100%" }}
                    />
                  </Form.Item>
                  <Form.Item label="字符上限">
                    <InputNumber
                      min={500}
                      max={64000}
                      value={compressConfig.max_chars}
                      onChange={(value) =>
                        setCompressConfig((current) => ({
                          ...current,
                          max_chars: Math.max(500, Math.min(64000, Number(value || 500)))
                        }))
                      }
                      style={{ width: "100%" }}
                    />
                  </Form.Item>
                  <Form.Item label="摘要上限">
                    <InputNumber
                      min={200}
                      max={32000}
                      value={compressConfig.summary_chars}
                      onChange={(value) =>
                        setCompressConfig((current) => ({
                          ...current,
                          summary_chars: Math.max(200, Math.min(32000, Number(value || 200)))
                        }))
                      }
                      style={{ width: "100%" }}
                    />
                  </Form.Item>
                  <Button
                    type="primary"
                    icon={<CompressOutlined />}
                    onClick={() => messageApi.success("压缩配置已保存到本地")}
                  >
                    保存压缩配置
                  </Button>
                </Form>
              )
            }
          ]}
        />
      </Drawer>

      <Modal
        open={createPaneDialog.open}
        onCancel={() => {
          setCreatePanePathTarget("rule_content_text_paths");
          setCreatePaneSampleViewMode("root");
          setCreatePaneSamplePreview({
            loading: false,
            error: "",
            parser_profile: "",
            file_path: "",
            file_format: "",
            sample_value: null,
            message_sample_value: null
          });
          setCreatePaneDialog(
            createCreatePaneDialogState(
              activePane?.provider || providers[0] || "codex",
              sessionParserProfiles,
              isTeamRoute ? workingDirectory : "",
              createPaneDialog.team_role_count
            )
          );
        }}
        onOk={() => void (isTeamRoute ? addTeam() : addPane())}
        okText={isTeamRoute ? "创建团队" : "创建"}
        cancelText="取消"
        confirmLoading={createPaneDialog.creating}
        title={isTeamRoute ? "新建团队" : "新建终端"}
      >
        <Form layout="vertical">
          {isTeamRoute ? (
            <>
              <Form.Item
                label="团队目录"
                required
                extra={`将自动创建 ${TEAM_WORK_DIR_NAME} 与 ${TEAM_CODE_DIR_NAME} 两个子目录（终端仅创建在 ${TEAM_WORK_DIR_NAME}/role-*）`}
              >
                <Space.Compact style={{ width: "100%" }}>
                  <Input
                    value={createPaneDialog.team_directory}
                    onChange={(event) =>
                      setCreatePaneDialog((current) => ({ ...current, team_directory: event.target.value }))
                    }
                    placeholder="选择或输入团队目录"
                  />
                  <Button icon={<FolderOpenOutlined />} onClick={() => void pickTeamDirectory()}>
                    选择目录
                  </Button>
                </Space.Compact>
              </Form.Item>
              <Form.Item
                label="角色数量"
                extra={`将在 ${TEAM_WORK_DIR_NAME} 下创建 role-1 至 role-N 子目录，并为每个子目录生成终端`}
              >
                <InputNumber
                  min={1}
                  max={20}
                  value={createPaneDialog.team_role_count}
                  onChange={(value) =>
                    setCreatePaneDialog((current) => ({
                      ...current,
                      team_role_count: Math.max(1, Math.min(20, Math.round(Number(value || 1))))
                    }))
                  }
                  style={{ width: "100%" }}
                />
              </Form.Item>
            </>
          ) : null}
          <Form.Item label="Provider 来源">
            <Segmented
              value={createPaneDialog.provider_mode}
              options={[
                { value: "preset", label: "预设" },
                { value: "custom", label: "自定义" }
              ]}
              onChange={(value) => {
                if (value === "custom") {
                  setCreatePaneDialog((current) => ({
                    ...current,
                    provider_mode: "custom",
                    session_parse_preset: normalizeSessionParsePreset(
                      current.custom_provider.trim() || "custom-model"
                    ),
                    session_scan_glob: ""
                  }));
                  return;
                }
                const parserId = createPaneDialog.provider;
                setCreatePaneDialog((current) => ({
                  ...current,
                  provider_mode: "preset",
                  session_parse_preset: parserId,
                  session_scan_glob: normalizeSessionScanGlobInput(
                    defaultSessionScanGlobByPreset(parserId, sessionParserProfiles)
                  )
                }));
                void loadCreatePaneParserTemplate(parserId, {
                  replaceGlob: true,
                  guard: (current) =>
                    current.open && current.provider_mode === "preset" && current.provider === parserId
                });
              }}
            />
          </Form.Item>
          <Form.Item label="Provider">
            <Select
              value={createPaneDialog.provider}
              options={BUILTIN_PROVIDER_PRESETS.map((provider) => ({
                value: provider,
                label: asTitle(provider)
              }))}
              disabled={createPaneDialog.provider_mode !== "preset"}
              onChange={(value) => {
                const normalized = String(value || createPaneDialog.provider).trim().toLowerCase();
                const provider: "codex" | "claude" | "gemini" = isBuiltinProvider(normalized)
                  ? normalized
                  : createPaneDialog.provider;
                setCreatePaneDialog((current) => ({
                  ...current,
                  provider,
                  session_parse_preset: provider,
                  session_scan_glob: normalizeSessionScanGlobInput(
                    defaultSessionScanGlobByPreset(provider, sessionParserProfiles)
                  )
                }));
                void loadCreatePaneParserTemplate(provider, {
                  replaceGlob: true,
                  guard: (current) =>
                    current.open && current.provider_mode === "preset" && current.provider === provider
                });
              }}
            />
          </Form.Item>
          {createPaneDialog.provider_mode === "custom" ? (
            <Form.Item label="自定义 Provider">
              <Input
                value={createPaneDialog.custom_provider}
                onChange={(event) =>
                  setCreatePaneDialog((current) => ({
                    ...current,
                    custom_provider: event.target.value,
                    session_parse_preset: normalizeSessionParsePreset(
                      event.target.value.trim() || "custom-model"
                    )
                  }))
                }
                placeholder="例如: qwen / kimi"
              />
            </Form.Item>
          ) : null}
          <Collapse
            size="small"
            ghost
            items={[
              {
                key: "advanced",
                label: "高级选项",
                children: (
                  <Form layout="vertical">
                    <Form.Item label="标题模式">
            <Segmented
              value={createPaneDialog.title_mode}
              options={[
                { value: "auto", label: "自动" },
                { value: "custom", label: "自定义" }
              ]}
              onChange={(value) =>
                setCreatePaneDialog((current) => ({
                  ...current,
                  title_mode: value === "custom" ? "custom" : "auto"
                }))
              }
            />
                    </Form.Item>
                    <Form.Item label="自动标题预览">
            <Typography.Text code>
              {buildAutoPaneTitle(
                createPaneDialog.provider_mode === "preset"
                  ? createPaneDialog.provider
                  : createPaneDialog.custom_provider.trim().toLowerCase() || "terminal",
                panes
              )}
            </Typography.Text>
                    </Form.Item>
                    {createPaneDialog.title_mode === "custom" ? (
                      <Form.Item label="自定义标题">
              <Input
                value={createPaneDialog.custom_title}
                onChange={(event) =>
                  setCreatePaneDialog((current) => ({
                    ...current,
                    custom_title: event.target.value
                  }))
                }
                placeholder="终端标题"
              />
                      </Form.Item>
                    ) : null}
                    <Form.Item
            label={createPaneDialog.provider_mode === "custom" ? "扫描会话通配路径（必填）" : "扫描会话通配符"}
            extra="使用绝对路径通配模式，支持 * 和 ?；可填写多个模式（空格/逗号/分号/换行分隔），填写后会自动纠正格式，并按后缀自动识别文件类型。"
          >
            <Input.TextArea
              value={createPaneDialog.session_scan_glob}
              status={
                createPaneDialog.provider_mode === "custom" && !createPaneDialog.session_scan_glob.trim()
                  ? "error"
                  : undefined
              }
              onChange={(event) =>
                setCreatePaneDialog((current) => ({
                  ...current,
                  session_scan_glob: normalizeSessionScanGlobInput(event.target.value)
                }))
              }
              autoSize={{ minRows: 2, maxRows: 4 }}
              placeholder={
                createPaneDialog.provider_mode === "custom"
                  ? "例如: D:/logs/my-model/**/*.jsonl"
                  : "~/.codex/sessions/**/rollout-*.jsonl"
              }
              />
                    </Form.Item>
                    <Form.Item
            label="解析配置（图形编辑）"
            extra="Provider 与解析配置一对一绑定；文件格式将根据扫描通配符自动识别。"
          >
            <Space direction="vertical" size={12} style={{ width: "100%" }}>
              <Card
                size="small"
                title="解析绑定"
                extra={<Tag color="blue">{createPaneParserId}</Tag>}
              >
                <Space direction="vertical" size={4}>
                  <Typography.Text type="secondary">
                    解析 ID 与 Provider 自动绑定，不需要手动配置名称/ID。
                  </Typography.Text>
                  <Typography.Text type="secondary">
                    当前文件格式自动识别为：
                    <Tag color="cyan" style={{ marginInlineStart: 8 }}>
                      {createPaneDetectedFileFormat}
                    </Tag>
                  </Typography.Text>
                  {createPaneDialog.provider_mode === "custom" ? (
                    <Typography.Text type="secondary">
                      自定义 Provider 需要先填写扫描会话通配路径，再自动识别 `json/jsonl`。
                    </Typography.Text>
                  ) : null}
                </Space>
              </Card>

              <Card
                size="small"
                title="样本 JSON 路径选择"
                extra={
                  <Space size={8}>
                    <Button
                      size="small"
                      type={createPaneSampleViewMode === "root" ? "primary" : "default"}
                      onClick={() => setCreatePaneSampleViewMode("root")}
                    >
                      原始 JSON
                    </Button>
                    <Button
                      size="small"
                      type={createPaneSampleViewMode === "message" ? "primary" : "default"}
                      onClick={() => setCreatePaneSampleViewMode("message")}
                      disabled={!createPaneSamplePreview.message_sample_value}
                    >
                      原始消息
                    </Button>
                    <Tag color="cyan">{createPanePathTargetLabel(createPanePathTarget)}</Tag>
                    <Button
                      size="small"
                      onClick={() => void loadCreatePaneSamplePreview()}
                      loading={createPaneSamplePreview.loading}
                    >
                      刷新样本
                    </Button>
                  </Space>
                }
              >
                <Space direction="vertical" size={8} style={{ width: "100%" }}>
                  <Typography.Text type="secondary">
                    先填写扫描通配符，再在右侧树上点击真实 JSON 节点；路径会自动写入当前焦点字段。
                  </Typography.Text>
                  {createPaneSamplePreview.file_path ? (
                    <Typography.Text type="secondary" className="create-pane-sample-file">
                      样本文件：{createPaneSamplePreview.file_path}
                    </Typography.Text>
                  ) : null}
                  {createPaneSamplePreview.error ? (
                    <Typography.Text type="danger">{createPaneSamplePreview.error}</Typography.Text>
                  ) : null}
                  {createPaneSamplePreview.loading && !createPaneSamplePreview.sample_value ? (
                    <div className="create-pane-sample-loading">
                      <Spin />
                    </div>
                  ) : createPaneSamplePreview.sample_value ? (
                    <JsonPathTree
                      value={createPaneDisplayedSampleValue}
                      maxExpandDepth={2}
                      onSelectPath={(pathTokens) => applyCreatePanePathToTarget(pathTokens)}
                    />
                  ) : (
                    <Typography.Text type="secondary">暂无样本，请先填写有效通配路径。</Typography.Text>
                  )}
                </Space>
              </Card>

              <Card size="small" title="会话层（Session）">
                <div style={{ display: "grid", gap: 12 }}>
                  <div>
                    {renderCreatePanePathFieldTitle("会话 ID 路径（session_id_paths）", "session_id_paths")}
                    <Typography.Text type="secondary" style={{ display: "block" }}>
                      从会话元信息里提取 SID，可填多个兜底路径。
                    </Typography.Text>
                    <Select
                      mode="tags"
                      value={toStringList(createPaneParserEditor.session_id_paths)}
                      onChange={(value) => updateCreatePaneParserEditor({ session_id_paths: value })}
                      onFocus={() => setCreatePanePathTarget("session_id_paths")}
                      onClick={() => setCreatePanePathTarget("session_id_paths")}
                      tokenSeparators={[",", ";"]}
                      className={
                        createPanePathTarget === "session_id_paths" ? "create-path-input-active" : undefined
                      }
                      style={{ width: "100%" }}
                      placeholder='例如: payload.id, sessionId'
                    />
                  </div>
                  <div>
                    {renderCreatePanePathFieldTitle("会话时间路径（started_at_paths）", "started_at_paths")}
                    <Typography.Text type="secondary" style={{ display: "block" }}>
                      从会话元信息里提取会话开始时间。
                    </Typography.Text>
                    <Select
                      mode="tags"
                      value={toStringList(createPaneParserEditor.started_at_paths)}
                      onChange={(value) => updateCreatePaneParserEditor({ started_at_paths: value })}
                      onFocus={() => setCreatePanePathTarget("started_at_paths")}
                      onClick={() => setCreatePanePathTarget("started_at_paths")}
                      tokenSeparators={[",", ";"]}
                      className={
                        createPanePathTarget === "started_at_paths" ? "create-path-input-active" : undefined
                      }
                      style={{ width: "100%" }}
                      placeholder='例如: payload.timestamp, timestamp'
                    />
                  </div>
                </div>
              </Card>

              <Card size="small" title="消息层（Message）">
                <div style={{ display: "grid", gap: 12 }}>
                  <div>
                    {renderCreatePanePathFieldTitle("消息角色路径（role_path）", "rule_role_path")}
                    <Typography.Text type="secondary" style={{ display: "block" }}>
                      用于判定 input/output 角色的字段路径。
                    </Typography.Text>
                    <Input
                      value={String(createPaneParserEditor.rule_role_path ?? "")}
                      onChange={(event) => updateCreatePaneParserEditor({ rule_role_path: event.target.value })}
                      onFocus={() => setCreatePanePathTarget("rule_role_path")}
                      className={
                        createPanePathTarget === "rule_role_path" ? "create-path-input-active" : undefined
                      }
                      placeholder="例如: payload.role / type"
                    />
                  </div>
                  <div>
                    {renderCreatePanePathFieldTitle("消息文本路径（content_text_paths）", "rule_content_text_paths")}
                    <Typography.Text type="secondary" style={{ display: "block" }}>
                      从消息对象中提取正文文本的字段路径。
                    </Typography.Text>
                    <Select
                      mode="tags"
                      value={toStringList(createPaneParserEditor.rule_content_text_paths)}
                      onChange={(value) =>
                        updateCreatePaneParserEditor({ rule_content_text_paths: value })
                      }
                      onFocus={() => setCreatePanePathTarget("rule_content_text_paths")}
                      onClick={() => setCreatePanePathTarget("rule_content_text_paths")}
                      tokenSeparators={[",", ";"]}
                      className={
                        createPanePathTarget === "rule_content_text_paths"
                          ? "create-path-input-active"
                          : undefined
                      }
                      style={{ width: "100%" }}
                      placeholder='例如: text, message.content'
                    />
                  </div>
                  <div>
                    {renderCreatePanePathFieldTitle("消息时间路径（timestamp_paths）", "rule_timestamp_paths")}
                    <Typography.Text type="secondary" style={{ display: "block" }}>
                      可选，单条消息时间戳路径。
                    </Typography.Text>
                    <Select
                      mode="tags"
                      value={toStringList(createPaneParserEditor.rule_timestamp_paths)}
                      onChange={(value) => updateCreatePaneParserEditor({ rule_timestamp_paths: value })}
                      onFocus={() => setCreatePanePathTarget("rule_timestamp_paths")}
                      onClick={() => setCreatePanePathTarget("rule_timestamp_paths")}
                      tokenSeparators={[",", ";"]}
                      className={
                        createPanePathTarget === "rule_timestamp_paths" ? "create-path-input-active" : undefined
                      }
                      style={{ width: "100%" }}
                      placeholder='例如: timestamp'
                    />
                  </div>
                </div>
              </Card>

              <Card size="small" title="兼容项">
                <div style={{ display: "grid", gap: 12 }}>
                  <div>
                    {renderCreatePanePathFieldTitle("消息容器路径（message_source_path）", "message_source_path")}
                    <Typography.Text type="secondary" style={{ display: "block" }}>
                      可选。消息不是平铺时可指定父节点路径。
                    </Typography.Text>
                    <Input
                      value={String(createPaneParserEditor.message_source_path ?? "")}
                      onChange={(event) => updateCreatePaneParserEditor({ message_source_path: event.target.value })}
                      onFocus={() => setCreatePanePathTarget("message_source_path")}
                      className={
                        createPanePathTarget === "message_source_path" ? "create-path-input-active" : undefined
                      }
                      placeholder="例如: payload.messages"
                    />
                  </div>
                  <div>
                    {renderCreatePanePathFieldTitle("消息项路径（content_item_path）", "rule_content_item_path")}
                    <Typography.Text type="secondary" style={{ display: "block" }}>
                      可选。消息正文为数组结构时填写。
                    </Typography.Text>
                    <Input
                      value={String(createPaneParserEditor.rule_content_item_path ?? "")}
                      onChange={(event) =>
                        updateCreatePaneParserEditor({ rule_content_item_path: event.target.value })
                      }
                      onFocus={() => setCreatePanePathTarget("rule_content_item_path")}
                      className={
                        createPanePathTarget === "rule_content_item_path"
                          ? "create-path-input-active"
                          : undefined
                      }
                      placeholder="例如: payload.content[]"
                    />
                  </div>
                  <div>
                    {renderCreatePanePathFieldTitle("消息项过滤路径（content_item_filter_path）", "rule_content_item_filter_path")}
                    <Typography.Text type="secondary" style={{ display: "block" }}>
                      可选。用于过滤消息数组项类型。
                    </Typography.Text>
                    <Input
                      value={String(createPaneParserEditor.rule_content_item_filter_path ?? "")}
                      onChange={(event) =>
                        updateCreatePaneParserEditor({ rule_content_item_filter_path: event.target.value })
                      }
                      onFocus={() => setCreatePanePathTarget("rule_content_item_filter_path")}
                      className={
                        createPanePathTarget === "rule_content_item_filter_path"
                          ? "create-path-input-active"
                          : undefined
                      }
                      placeholder="例如: type"
                    />
                  </div>
                  <div>
                    <Typography.Text strong>Codex 指令标签清理</Typography.Text>
                    <Typography.Text type="secondary" style={{ display: "block" }}>
                      开启后自动剔除 &lt;INSTRUCTIONS&gt;、&lt;environment_context&gt; 等专有标签。
                    </Typography.Text>
                    <Switch
                      checked={Boolean(createPaneParserEditor.strip_codex_tags)}
                      onChange={(checked) => updateCreatePaneParserEditor({ strip_codex_tags: checked })}
                    />
                  </div>
                </div>
              </Card>

              <Card size="small" title="自定义函数解析（可选）">
                <div style={{ display: "grid", gap: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                    <div>
                      <Typography.Text strong>按行调用函数</Typography.Text>
                      <Typography.Text type="secondary" style={{ display: "block" }}>
                        开启后会优先使用函数解析，每行或每个消息对象都会调用一次。
                      </Typography.Text>
                    </div>
                    <Switch
                      checked={Boolean(createPaneParserEditor.line_parser_enabled)}
                      onChange={(checked) => {
                        if (!checked) {
                          updateCreatePaneParserEditor({
                            line_parser_enabled: false,
                            line_parser_script: ""
                          });
                          return;
                        }
                        const currentScript = String(createPaneParserEditor.line_parser_script ?? "").trim();
                        updateCreatePaneParserEditor({
                          line_parser_enabled: true,
                          line_parser_function: "parse_line",
                          line_parser_script:
                            currentScript || defaultLineParserScriptByPreset(createPaneParserId)
                        });
                      }}
                    />
                  </div>
                  {Boolean(createPaneParserEditor.line_parser_enabled) ? (
                    <>
                      <div>
                        <Typography.Text strong>函数名</Typography.Text>
                        <Typography.Text type="secondary" style={{ display: "block" }}>
                          默认 `parse_line(line, ctx)`，返回 map 或 rows 数组。
                        </Typography.Text>
                        <Input
                          value={String(createPaneParserEditor.line_parser_function ?? "parse_line")}
                          onChange={(event) =>
                            updateCreatePaneParserEditor({
                              line_parser_function: event.target.value.replace(/[^a-zA-Z0-9_]/g, "") || "parse_line"
                            })
                          }
                          placeholder="parse_line"
                        />
                      </div>
                      <div>
                        <Typography.Text strong>函数脚本</Typography.Text>
                        <Typography.Text type="secondary" style={{ display: "block" }}>
                          可用变量：`line`（当前行 JSON）、`ctx.file_path`、`ctx.file_name`、`ctx.line_no`、`ctx.current_session_id`。
                        </Typography.Text>
                        <Input.TextArea
                          value={String(createPaneParserEditor.line_parser_script ?? "")}
                          onChange={(event) =>
                            updateCreatePaneParserEditor({
                              line_parser_script: event.target.value
                            })
                          }
                          autoSize={{ minRows: 8, maxRows: 16 }}
                          placeholder={"fn parse_line(line, ctx) {\n  return ();\n}"}
                        />
                      </div>
                    </>
                  ) : null}
                </div>
              </Card>
            </Space>
                    </Form.Item>
                    <Form.Item label="自动生成 JSON（只读）" extra="由上方图形项自动生成，创建时直接提交。">
            <Input.TextArea value={createPaneParserJsonPreview} readOnly autoSize={{ minRows: 8, maxRows: 14 }} />
                    </Form.Item>
                    <Form.Item label="创建参数预览">
            <Typography.Text type="secondary">
              Provider:{" "}
              {createPaneDialog.provider_mode === "preset"
                ? createPaneDialog.provider
                : createPaneDialog.custom_provider.trim().toLowerCase() || "-"}
              {" | "}解析配置: 图形生成 JSON
            </Typography.Text>
                    </Form.Item>
                  </Form>
                )
              }
            ]}
          />
        </Form>
      </Modal>

      <Modal
        open={sendDialog.open}
        onCancel={() => setSendDialog(createSendDialogState())}
        onOk={() => void submitSendDialog()}
        okText="发送"
        cancelText="取消"
        confirmLoading={sendDialog.sending}
        title="发送到终端"
      >
        <Input.TextArea
          value={sendDialog.input}
          onChange={(event) =>
            setSendDialog((current) => ({ ...current, input: event.target.value }))
          }
          placeholder="输入要发送到当前终端的内容"
          autoSize={{ minRows: 4, maxRows: 10 }}
        />
      </Modal>

      <Modal
        open={unrecognizedFilePreviewDialog.open}
        title="异常文件预览"
        width={980}
        onCancel={() => setUnrecognizedFilePreviewDialog(createUnrecognizedFilePreviewDialogState())}
        footer={
          <Button onClick={() => setUnrecognizedFilePreviewDialog(createUnrecognizedFilePreviewDialogState())}>
            关闭
          </Button>
        }
      >
        {unrecognizedFilePreviewDialog.loading ? (
          <div style={{ padding: "28px 0", textAlign: "center" }}>
            <Spin />
          </div>
        ) : (
          <Space direction="vertical" size={10} style={{ width: "100%" }}>
            <Typography.Text code>{unrecognizedFilePreviewDialog.file_path}</Typography.Text>
            <Space size={8} wrap>
              <Tag color="orange">{unrecognizedReasonLabel(unrecognizedFilePreviewDialog.reason)}</Tag>
              <Tag>错误: {unrecognizedFilePreviewDialog.parse_errors}</Tag>
              <Tag>扫描单元: {unrecognizedFilePreviewDialog.scanned_units}</Tag>
              <Tag>记录: {unrecognizedFilePreviewDialog.row_count}</Tag>
              {unrecognizedFilePreviewDialog.session_id ? (
                <Tag color="cyan">SID: {shortSessionId(unrecognizedFilePreviewDialog.session_id)}</Tag>
              ) : null}
              {unrecognizedFilePreviewDialog.started_at > 0 ? (
                <Tag>开始: {formatTs(unrecognizedFilePreviewDialog.started_at)}</Tag>
              ) : null}
            </Space>
            <Input.TextArea
              readOnly
              value={unrecognizedFilePreviewDialog.content || "(文件内容为空或读取失败)"}
              autoSize={{ minRows: 18, maxRows: 28 }}
            />
          </Space>
        )}
      </Modal>

      <Modal
        open={unrecognizedFilesModal.open}
        title={`未识别文件 (${
          unrecognizedFilesModal.items.length > 0
            ? unrecognizedFilesModal.items.length
            : sessionManageFileStats.displayUnrecognized
        })`}
        width={1080}
        onCancel={() =>
          setUnrecognizedFilesModal((current) => ({
            ...current,
            open: false
          }))
        }
        footer={
          <Button
            onClick={() =>
              setUnrecognizedFilesModal((current) => ({
                ...current,
                open: false
              }))
            }
          >
            关闭
          </Button>
        }
      >
        <div style={{ display: "grid", gap: 8, maxHeight: "62vh", overflowY: "auto" }}>
          {unrecognizedFilesModal.loading ? (
            <div style={{ padding: "24px 0", textAlign: "center" }}>
              <Spin />
            </div>
          ) : unrecognizedFilesModal.items.length > 0 ? (
            unrecognizedFilesModal.items.map((item) => (
              <div
                key={item.file_path}
                style={{
                  border: "1px solid rgba(255,255,255,0.08)",
                  borderRadius: 8,
                  padding: "8px 10px",
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 10,
                  alignItems: "center"
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <Typography.Text code>{shortFileName(item.file_path)}</Typography.Text>
                  <Typography.Text type="secondary" style={{ display: "block" }}>
                    {item.file_path}
                  </Typography.Text>
                </div>
                <Space size={6} wrap>
                  <Tag color="orange">{unrecognizedReasonLabel(item.reason)}</Tag>
                  <Tag>错误: {item.parse_errors}</Tag>
                  <Tag>记录: {item.row_count}</Tag>
                  <Button
                    size="small"
                    onClick={() => {
                      setUnrecognizedFilesModal((current) => ({
                        ...current,
                        open: false
                      }));
                      void openUnrecognizedFilePreview(sessionManagePaneId, item.file_path);
                    }}
                  >
                    查看异常
                  </Button>
                </Space>
              </div>
            ))
          ) : sessionManageFileStats.displayUnrecognized > 0 ? (
            <Typography.Text type="secondary">
              当前未返回异常文件明细，估算异常文件约 {sessionManageFileStats.displayUnrecognized} 个。
            </Typography.Text>
          ) : (
            <Typography.Text type="secondary">暂无未识别文件</Typography.Text>
          )}
        </div>
      </Modal>

      <Modal
        open={sessionManageDialog.open}
        onCancel={() => {
          setSessionManageDialog(createSessionManageDialogState());
          setSessionManageGroupTab("current");
          setSessionManagePreview(createSessionManagePreviewState());
          setSessionManagePreviewScrollCommand(null);
          setSessionManageScanConfig(null);
          setUnrecognizedFilePreviewDialog(createUnrecognizedFilePreviewDialogState());
          setUnrecognizedFilesModal(createUnrecognizedFilesModalState());
        }}
        className="session-manage-modal"
        centered
        styles={{
          body: {
            maxHeight: "72vh",
            overflowY: "auto",
            overflowX: "hidden"
          }
        }}
        title={sessionManageIsListView ? "当前会话预览" : "会话管理"}
        width={isCompactViewport ? "96vw" : 1180}
        footer={
          <Space>
            <Button
              onClick={() => {
                setSessionManageDialog(createSessionManageDialogState());
                setSessionManageGroupTab("current");
                setSessionManagePreview(createSessionManagePreviewState());
                setSessionManagePreviewScrollCommand(null);
                setSessionManageScanConfig(null);
                setUnrecognizedFilePreviewDialog(createUnrecognizedFilePreviewDialogState());
                setUnrecognizedFilesModal(createUnrecognizedFilesModalState());
              }}
            >
              关闭
            </Button>
          </Space>
        }
      >
        {sessionManagePane && sessionManageListState ? (
          <>
            {!sessionManageIsListView ? (
              <Card size="small" className="session-manage-meta-card">
              <Space size={10} wrap style={{ width: "100%", justifyContent: "space-between" }}>
                <Space size={8} wrap>
                  <Tag color={sessionManagePane.active_session_id ? "cyan" : "default"}>
                    当前 SID:{" "}
                    {sessionManagePane.active_session_id
                      ? shortSessionId(sessionManagePane.active_session_id)
                      : "未检测"}
                  </Tag>
                  {sessionManageMissingCurrentIndexed ? (
                    <Tag color="orange">当前 SID 未入索引</Tag>
                  ) : null}
                  <Tooltip
                    title={`已配置关联 SID: ${sessionManagePane.linked_session_ids.length}`}
                  >
                    <Tag>关联会话: {sessionManageGroupedItems.linked.length}</Tag>
                  </Tooltip>
                  {sessionManageMissingLinkedCount > 0 ? (
                    <Tag color="orange">未入索引关联: {sessionManageMissingLinkedCount}</Tag>
                  ) : null}
                  <Tag
                    color={
                      sessionManageProgressState.mode === "scan"
                        ? "processing"
                        : sessionManageProgressState.percent >= 100 && sessionManageListState.total > 0
                          ? "success"
                          : "default"
                    }
                  >
                    {sessionManageProgressState.tag_text}
                  </Tag>
                  <Tag>{sessionManageProgressState.sub_tag_text}</Tag>
                  <Tag>扫描文件: {sessionManageFileStats.scanProcessed}</Tag>
                  <Tag>识别文件: {sessionManageFileStats.recognizedFiles}</Tag>
                  <Tag color={sessionManageFileStats.displayUnrecognized > 0 ? "orange" : "default"}>
                    异常文件: {sessionManageFileStats.displayUnrecognized}
                  </Tag>
                  {sessionManageScanConfig ? (
                    <Tag color="blue">解析器: {sessionManageScanConfig.parser_profile || "-"}</Tag>
                  ) : null}
                  {sessionManageScanConfig?.file_glob ? (
                    <Tooltip title={sessionManageScanConfig.file_glob}>
                      <Tag>
                        扫描规则:{" "}
                        {sessionManageScanConfig.file_glob.length > 48
                          ? `${sessionManageScanConfig.file_glob.slice(0, 48)}...`
                          : sessionManageScanConfig.file_glob}
                      </Tag>
                    </Tooltip>
                  ) : null}
                </Space>
                {!sessionManageIsListView ? (
                  <Space size={8} wrap>
                    <Button
                      type={sessionManageListState.preview_auto_refresh ? "primary" : "default"}
                      icon={<SyncOutlined spin={sessionManageListState.preview_auto_refresh} />}
                      onClick={() => toggleSessionPreviewAutoRefresh(sessionManagePaneId)}
                      disabled={!sessionManagePaneId}
                    >
                      {sessionManageListState.preview_auto_refresh ? "自动刷新中" : "自动刷新"}
                    </Button>
                    <Button
                      loading={sessionManagePane.sid_checking}
                      disabled={!sessionManagePaneId || sessionManagePane.sid_checking}
                      onClick={() => {
                        void detectSid(sessionManagePaneId);
                      }}
                    >
                      读取状态信息绑定 SID
                    </Button>
                    <Button
                      onClick={() => void reindexNativeSessions(sessionManagePaneId)}
                      loading={sessionManageReindexing || sessionManagePane.scan_running}
                      disabled={!sessionManagePaneId || sessionManageReindexing}
                    >
                      Rebuild Index
                    </Button>
                    <Button
                      onClick={() => void openUnrecognizedFilesModal()}
                      disabled={sessionManageFileStats.displayUnrecognized <= 0}
                    >
                      异常文件 ({sessionManageFileStats.displayUnrecognized})
                    </Button>
                  </Space>
                ) : null}
              </Space>
              <Progress
                percent={sessionManageProgressState.percent}
                size="small"
                status={sessionManageProgressState.status}
                format={() => sessionManageProgressInlineText}
                style={{ marginTop: 10 }}
              />
              </Card>
            ) : null}

            {!sessionManageIsListView ? (
              <div className="session-list-toolbar">
              <Card size="small" className="session-sort-toolbar">
                <div className="session-sort-toolbar-inner">
                  <Space size={8} className="session-sort-buttons" wrap>
                    <Button
                      size="small"
                      type={sessionManageSortState.field === "created" ? "primary" : "default"}
                      onClick={() => void toggleSessionListSortField(sessionManagePaneId, "created")}
                    >
                      创建时间
                      {sessionManageSortState.field === "created"
                        ? sessionManageSortState.order === "asc"
                          ? " ↑"
                          : " ↓"
                        : ""}
                    </Button>
                    <Button
                      size="small"
                      type={sessionManageSortState.field === "updated" ? "primary" : "default"}
                      onClick={() => void toggleSessionListSortField(sessionManagePaneId, "updated")}
                    >
                      更新时间
                      {sessionManageSortState.field === "updated"
                        ? sessionManageSortState.order === "asc"
                          ? " ↑"
                          : " ↓"
                        : ""}
                    </Button>
                    <Button
                      size="small"
                      type={sessionManageSortState.field === "records" ? "primary" : "default"}
                      onClick={() => void toggleSessionListSortField(sessionManagePaneId, "records")}
                    >
                      记录数
                      {sessionManageSortState.field === "records"
                        ? sessionManageSortState.order === "asc"
                          ? " ↑"
                          : " ↓"
                        : ""}
                    </Button>
                  </Space>
                </div>
              </Card>

              <Card size="small" className="session-filter-toolbar">
                <div className="session-filter-row">
                  <Input
                    allowClear
                    placeholder="搜索 SID / 首条输入"
                    value={sessionManageListState.sid_keyword}
                    onChange={(event) =>
                      updateSessionListPanelState(sessionManagePaneId, (current) => ({
                        ...current,
                        sid_keyword: event.target.value
                      }))
                    }
                    className="session-filter-input"
                  />
                  <Input
                    type="datetime-local"
                    value={sessionManageListState.time_from}
                    onChange={(event) =>
                      updateSessionListPanelState(sessionManagePaneId, (current) => ({
                        ...current,
                        time_from: event.target.value,
                        quick_time_preset: ""
                      }))
                    }
                    className="session-filter-time"
                  />
                  <Input
                    type="datetime-local"
                    value={sessionManageListState.time_to}
                    onChange={(event) =>
                      updateSessionListPanelState(sessionManagePaneId, (current) => ({
                        ...current,
                        time_to: event.target.value,
                        quick_time_preset: ""
                      }))
                    }
                    className="session-filter-time"
                  />
                  <Space size={4} className="session-filter-presets" wrap>
                    <Button
                      size="small"
                      type={sessionManageListState.quick_time_preset === "3h" ? "primary" : "default"}
                      onClick={() => applyQuickTimePreset(sessionManagePaneId, "3h")}
                    >
                      3h
                    </Button>
                    <Button
                      size="small"
                      type={sessionManageListState.quick_time_preset === "24h" ? "primary" : "default"}
                      onClick={() => applyQuickTimePreset(sessionManagePaneId, "24h")}
                    >
                      24h
                    </Button>
                    <Button
                      size="small"
                      type={sessionManageListState.quick_time_preset === "3d" ? "primary" : "default"}
                      onClick={() => applyQuickTimePreset(sessionManagePaneId, "3d")}
                    >
                      3d
                    </Button>
                    <Button
                      size="small"
                      type={sessionManageListState.quick_time_preset === "7d" ? "primary" : "default"}
                      onClick={() => applyQuickTimePreset(sessionManagePaneId, "7d")}
                    >
                      7d
                    </Button>
                    <Button
                      size="small"
                      type={sessionManageListState.quick_time_preset === "30d" ? "primary" : "default"}
                      onClick={() => applyQuickTimePreset(sessionManagePaneId, "30d")}
                    >
                      30d
                    </Button>
                    <Button
                      size="small"
                      type={sessionManageListState.quick_time_preset === "3m" ? "primary" : "default"}
                      onClick={() => applyQuickTimePreset(sessionManagePaneId, "3m")}
                    >
                      3m
                    </Button>
                    <Button
                      size="small"
                      type={sessionManageListState.quick_time_preset === "1y" ? "primary" : "default"}
                      onClick={() => applyQuickTimePreset(sessionManagePaneId, "1y")}
                    >
                      1y
                    </Button>
                  </Space>
                  <InputNumber
                    min={0}
                    value={sessionManageListState.records_min}
                    placeholder="最小记录数"
                    onChange={(value) =>
                      updateSessionListPanelState(sessionManagePaneId, (current) => ({
                        ...current,
                        records_min: normalizeOptionalNonNegativeInt(value)
                      }))
                    }
                    className="session-filter-number"
                  />
                  <InputNumber
                    min={0}
                    value={sessionManageListState.records_max}
                    placeholder="最大记录数"
                    onChange={(value) =>
                      updateSessionListPanelState(sessionManagePaneId, (current) => ({
                        ...current,
                        records_max: normalizeOptionalNonNegativeInt(value)
                      }))
                    }
                    className="session-filter-number"
                  />
                  <Button
                    type="primary"
                    icon={<SearchOutlined />}
                    onClick={() => void applySessionListFilters(sessionManagePaneId)}
                  >
                    应用筛选
                  </Button>
                  <Button onClick={() => void resetSessionListFilters(sessionManagePaneId)}>清空筛选</Button>
                </div>
              </Card>
              </div>
            ) : null}

            {!sessionManageIsListView ? (
              <div className="session-list-progress">
              <Typography.Text type="secondary">
                已加载 {sessionManageListState.items.length}/{sessionManageListState.total}
              </Typography.Text>
              <Typography.Text type="secondary">
                当前 {sessionManageGroupedItems.current.length} | 关联 {sessionManageGroupedItems.linked.length} | 未关联{" "}
                {sessionManageGroupedItems.unlinked.length}
              </Typography.Text>
              {sessionManageMissingCurrentIndexed || sessionManageMissingLinkedCount > 0 ? (
                <Typography.Text type="warning">
                  已绑定但未入索引的 SID 会额外显示在对应分组中，不计入会话总数。
                </Typography.Text>
              ) : null}
              </div>
            ) : null}

            <div className="session-list-layout">
              {!sessionManageIsListView ? (
                <div className="session-list-left">
                  <Tabs
                    size="small"
                    activeKey={sessionManageGroupTab}
                    onChange={(key) => setSessionManageGroupTab(key as SessionManageGroupTabKey)}
                    destroyOnHidden
                    className="session-manage-group-tabs"
                    items={[
                      {
                        key: "current",
                        label: `当前 (${sessionManageGroupedItems.current.length})`,
                        children: (
                          <div className="session-manage-tab-pane">
                            <SessionCandidateVirtualList
                              items={sessionManageGroupedItems.current}
                              empty_text="当前分组暂无会话"
                              render_item={(item) => (
                                <SessionCandidateCard
                                  session_id={item.session_id}
                                  sid_short={shortSessionId(item.session_id)}
                                  selected={false}
                                  show_checkbox={false}
                                  previewing={sessionManagePreview.preview_session_id === item.session_id}
                                  created_text={formatTs(item.started_at)}
                                  updated_text={formatTs(item.last_seen_at)}
                                  record_count={item.record_count}
                                  source_files={item.source_files}
                                  first_input={item.first_input}
                                  selection_status_text={item.synthetic_reason}
                                  selection_status_color={item.synthetic ? "orange" : undefined}
                                  on_preview={() => void loadSessionManagePreview(sessionManagePaneId, item.session_id)}
                                  on_clear_current={() => void clearCurrentSessionFromManage(sessionManagePaneId)}
                                  clear_current_disabled={!sessionManagePane.active_session_id.trim()}
                                />
                              )}
                            />
                          </div>
                        )
                      },
                      {
                        key: "linked",
                        label: `关联 (${sessionManageGroupedItems.linked.length})`,
                        children: (
                          <div className="session-manage-tab-pane">
                            <SessionCandidateVirtualList
                              items={sessionManageGroupedItems.linked}
                              empty_text="关联分组暂无会话"
                              render_item={(item) => (
                                <SessionCandidateCard
                                  session_id={item.session_id}
                                  sid_short={shortSessionId(item.session_id)}
                                  selected={false}
                                  show_checkbox={false}
                                  previewing={sessionManagePreview.preview_session_id === item.session_id}
                                  created_text={formatTs(item.started_at)}
                                  updated_text={formatTs(item.last_seen_at)}
                                  record_count={item.record_count}
                                  source_files={item.source_files}
                                  first_input={item.first_input}
                                  selection_status_text={item.synthetic_reason}
                                  selection_status_color={item.synthetic ? "orange" : undefined}
                                  on_preview={() => void loadSessionManagePreview(sessionManagePaneId, item.session_id)}
                                  on_remove_linked={() =>
                                    void removeLinkedSessionFromManage(sessionManagePaneId, item.session_id)
                                  }
                                  remove_linked_disabled={
                                    !sessionManagePane.linked_session_ids.includes(item.session_id)
                                  }
                                />
                              )}
                            />
                          </div>
                        )
                      },
                      {
                        key: "unlinked",
                        label: `未关联 (${sessionManageGroupedItems.unlinked.length})`,
                        children: (
                          <div className="session-manage-tab-pane">
                            <SessionCandidateVirtualList
                              items={sessionManageGroupedItems.unlinked}
                              empty_text="未关联分组暂无会话"
                              render_item={(item) => (
                                <SessionCandidateCard
                                  session_id={item.session_id}
                                  sid_short={shortSessionId(item.session_id)}
                                  selected={false}
                                  show_checkbox={false}
                                  previewing={sessionManagePreview.preview_session_id === item.session_id}
                                  created_text={formatTs(item.started_at)}
                                  updated_text={formatTs(item.last_seen_at)}
                                  record_count={item.record_count}
                                  source_files={item.source_files}
                                  first_input={item.first_input}
                                  selection_status_text={item.synthetic_reason}
                                  selection_status_color={item.synthetic ? "orange" : undefined}
                                  on_preview={() => void loadSessionManagePreview(sessionManagePaneId, item.session_id)}
                                  on_set_current={() =>
                                    void setSessionAsCurrentFromManage(sessionManagePaneId, item.session_id)
                                  }
                                  on_add_linked={() =>
                                    void addLinkedSessionFromManage(sessionManagePaneId, item.session_id)
                                  }
                                  set_current_disabled={
                                    sessionManagePane.active_session_id.trim() === item.session_id.trim()
                                  }
                                  add_linked_disabled={sessionManagePane.linked_session_ids.includes(item.session_id)}
                                />
                              )}
                            />
                          </div>
                        )
                      }
                    ]}
                  />
                </div>
              ) : null}

              <div className="session-list-right" style={sessionManageIsListView ? { width: "100%" } : undefined}>
                <Card size="small" title={sessionManageIsListView ? "当前会话消息" : "会话预览"}>
                  <div className="session-preview-head">
                    <Typography.Text type="secondary">
                      SID：
                      {sessionManagePreview.preview_session_id
                        ? shortSessionId(sessionManagePreview.preview_session_id)
                        : "-"}
                    </Typography.Text>
                    <Space size={6}>
                      <Button
                        size="small"
                        type={sessionManageListState.preview_auto_refresh ? "primary" : "default"}
                        icon={<SyncOutlined spin={sessionManageListState.preview_auto_refresh} />}
                        onClick={() => toggleSessionPreviewAutoRefresh(sessionManagePaneId)}
                        disabled={!sessionManagePaneId || !sessionManagePreview.preview_session_id.trim()}
                      >
                        {sessionManageListState.preview_auto_refresh ? "自动刷新中" : "自动刷新"}
                      </Button>
                      <Button
                        size="small"
                        onClick={() => void jumpSessionManagePreviewToStart()}
                        loading={sessionManagePreview.preview_loading && !sessionManagePreview.preview_from_end}
                        disabled={!sessionManagePreview.preview_session_id.trim()}
                      >
                        开头
                      </Button>
                      <Button
                        size="small"
                        onClick={() => void jumpSessionManagePreviewToLatest()}
                        loading={sessionManagePreview.preview_loading && sessionManagePreview.preview_from_end}
                        disabled={!sessionManagePreview.preview_session_id.trim()}
                      >
                        最新
                      </Button>
                      <Typography.Text type="secondary">
                        已加载 {sessionManagePreview.preview_loaded_rows}/{sessionManagePreview.preview_total_rows}
                      </Typography.Text>
                      <Button
                        size="small"
                        onClick={() => setPreviewOverlaySource("session-manage")}
                        disabled={!canOpenSessionManagePreviewOverlay}
                      >
                        弹窗预览
                      </Button>
                      <Button
                        size="small"
                        onClick={() => void loadAllSessionManagePreviewRows()}
                        loading={sessionManagePreview.preview_loading}
                        disabled={!sessionManagePreview.preview_has_more}
                      >
                        加载全部
                      </Button>
                    </Space>
                  </div>

                  <div className="session-preview-scroll">
                    {sessionManagePreview.preview_loading && !sessionManagePreview.preview_rows.length ? (
                      <div className="session-preview-loading">
                        <Spin />
                      </div>
                    ) : (
                      <SyncEntryPreviewList
                        show_checkbox={false}
                        user_avatar_src={userAvatarSrc}
                        assistant_avatar_src={assistantAvatarSrc}
                        scroll_command={sessionManagePreviewScrollCommand}
                        highlighted_item_id={sessionManageHighlightedMessageId}
                        items={sessionManagePreviewItems}
                        empty_text="当前会话暂无预览消息"
                        on_reach_bottom={
                          sessionManagePreview.preview_session_id.trim() && sessionManagePreview.preview_has_more
                            ? () => {
                                if (!sessionManagePreview.preview_from_end) {
                                  void loadMoreSessionManagePreviewRows();
                                }
                              }
                            : undefined
                        }
                        on_reach_top={
                          sessionManagePreview.preview_session_id.trim() && sessionManagePreview.preview_has_more
                            ? () => {
                                if (sessionManagePreview.preview_from_end) {
                                  void loadMoreSessionManagePreviewRows();
                                }
                              }
                            : undefined
                        }
                        is_favorited={isPreviewMessageFavorited}
                        on_toggle_favorite={togglePreviewMessageFavorite}
                        on_request_full_content={loadSessionManagePreviewMessageDetail}
                      />
                    )}
                  </div>
                </Card>
              </div>
            </div>

            {!sessionManageIsListView ? (
              <div className="session-list-loadmore">
              <Button
                onClick={() => void loadMoreSessionListDialog(sessionManagePaneId)}
                loading={sessionManageListState.loading_more}
                disabled={!sessionManageListState.has_more}
              >
                {sessionManageListState.has_more ? "加载更多" : "已全部加载"}
              </Button>
              </div>
            ) : null}
          </>
        ) : (
          <Typography.Text type="secondary">未选择终端窗格</Typography.Text>
        )}
      </Modal>

      <Modal
        open={syncDialog.open}
        onCancel={() => closeSyncDialog()}
        title="同步中心"
        width={1100}
        footer={
          <Space>
            <Button onClick={() => closeSyncDialog()} disabled={syncDialog.syncing}>
              取消
            </Button>
            <Select
              value={syncDialog.target_pane_id || undefined}
              onChange={(value) =>
                setSyncDialog((current) => ({
                  ...current,
                  target_pane_id: String(value || "")
                }))
              }
              placeholder="选择目标窗格"
              options={syncDialogTargetOptions}
              style={{ width: 260 }}
            />
            <Button
              icon={<CopyOutlined />}
              onClick={() => void copySyncDialogMessages()}
              disabled={syncDialog.loading || !syncDialogPendingEntryCount}
            >
              复制消息
            </Button>
            <Button
              type="primary"
              onClick={() => void submitSyncDialog()}
              loading={syncDialog.syncing}
              disabled={syncDialogPendingEntryCount === 0 || !syncDialog.target_pane_id.trim()}
            >
              开始同步
            </Button>
          </Space>
        }
      >
        <div className="sync-dialog-progress">
          <Progress
            percent={syncDialog.progress_percent}
            status={
              syncDialog.progress_stage === "error"
                ? "exception"
                : syncDialog.progress_stage === "done"
                  ? "success"
                  : syncDialog.progress_stage === "idle"
                    ? "normal"
                    : "active"
            }
            size="small"
            showInfo={false}
          />
          <Typography.Text type="secondary">{syncDialogProgressDisplayText}</Typography.Text>
        </div>

        <div className="sync-dialog-summary">
          <Typography.Text type="secondary">
            策略：{syncStrategyLabel(syncDialog.strategy)} | 已选会话 {syncDialog.selected_session_ids.length}/
            {syncDialogAllSessionIds.length} | 记录 {syncDialogSelectedRecordCount} 条 | 分组{" "}
            {syncDialogSessionGroups.length} 个 | 筛后{" "}
            {syncDialogFilteredEntries.length} 条 | 取消 {syncDialogExcludedSelectedCount} 条 | 待同步{" "}
            {syncDialogPendingEntryCount} 条
          </Typography.Text>
        </div>

        {renderSyncDialogSessionToolbar()}

        <div className="sync-dialog-layout">
          <div className="sync-dialog-left sync-dialog-selection">
              <>
                <div className="session-list-progress">
                  <Typography.Text type="secondary">
                    已加载 {syncDialogSessionListState.items.length}/{syncDialogSessionListState.total}
                  </Typography.Text>
                  <Typography.Text type="secondary">
                    当前 {syncDialogGroupedItems.current.length} | 关联 {syncDialogGroupedItems.linked.length} |
                    未关联 {syncDialogGroupedItems.unlinked.length}
                  </Typography.Text>
                </div>

                <div className="sync-selection-actions">
                  <Button
                    onClick={() => {
                      setSyncDialog((current) => ({
                        ...current,
                        selected_session_ids: [...syncDialogAllSessionIds],
                        included_entry_ids: [],
                        excluded_entry_ids: []
                      }));
                    }}
                    disabled={!syncDialogAllSessionIds.length}
                  >
                    全选会话
                  </Button>
                  <Button
                    onClick={() =>
                      setSyncDialog((current) => ({
                        ...current,
                        selected_session_ids: [],
                        included_entry_ids: [],
                        excluded_entry_ids: []
                      }))
                    }
                    disabled={!syncDialog.selected_session_ids.length}
                  >
                    清空会话
                  </Button>
                  <Button
                    type={syncShowSelectedOnly ? "primary" : "default"}
                    onClick={() => setSyncShowSelectedOnly((current) => !current)}
                    disabled={!syncDialog.selected_session_ids.length}
                  >
                    {syncShowSelectedOnly ? "显示全部会话" : "仅看已选会话"}
                  </Button>
                </div>

                <div className="session-list-left sync-dialog-selection-list">
                  {syncDialogSessionListState.loading && !syncDialogSessionListState.items.length ? (
                    <div className="session-preview-loading">
                      <Spin />
                    </div>
                  ) : (
                    <Tabs
                      size="small"
                      activeKey={syncDialogGroupTab}
                      onChange={(key) => setSyncDialogGroupTab(key as SessionManageGroupTabKey)}
                      destroyOnHidden
                      className="session-manage-group-tabs"
                      items={[
                        {
                          key: "current",
                          label: `当前 (${syncDialogGroupedItems.current.length})`,
                          children: (
                            <div className="session-manage-tab-pane">
                              <SessionCandidateVirtualList
                                items={syncDialogGroupedItems.current}
                                empty_text="当前分组暂无会话"
                                render_item={(item) => {
                                  const badge = getSyncDialogSessionSelectionBadge(item.session_id);
                                  return (
                                    <SessionCandidateCard
                                      session_id={item.session_id}
                                      sid_short={shortSessionId(item.session_id)}
                                      selected={syncDialogVisualSelectedSessionSet.has(item.session_id)}
                                      previewing={syncDialogPreviewSessionId === item.session_id}
                                      created_text={formatTs(item.started_at)}
                                      updated_text={formatTs(item.last_seen_at)}
                                      record_count={item.record_count}
                                      source_files={item.source_files}
                                      first_input={item.first_input}
                                      selection_status_text={badge?.text}
                                      selection_status_color={badge?.color}
                                      on_toggle_selected={(checked) =>
                                        toggleSyncDialogSession(item.session_id, checked)
                                      }
                                      on_preview={() => void previewSyncDialogSession(syncDialog.pane_id, item.session_id)}
                                    />
                                  );
                                }}
                              />
                            </div>
                          )
                        },
                        {
                          key: "linked",
                          label: `关联 (${syncDialogGroupedItems.linked.length})`,
                          children: (
                            <div className="session-manage-tab-pane">
                              <SessionCandidateVirtualList
                                items={syncDialogGroupedItems.linked}
                                empty_text="关联分组暂无会话"
                                render_item={(item) => {
                                  const badge = getSyncDialogSessionSelectionBadge(item.session_id);
                                  return (
                                    <SessionCandidateCard
                                      session_id={item.session_id}
                                      sid_short={shortSessionId(item.session_id)}
                                      selected={syncDialogVisualSelectedSessionSet.has(item.session_id)}
                                      previewing={syncDialogPreviewSessionId === item.session_id}
                                      created_text={formatTs(item.started_at)}
                                      updated_text={formatTs(item.last_seen_at)}
                                      record_count={item.record_count}
                                      source_files={item.source_files}
                                      first_input={item.first_input}
                                      selection_status_text={badge?.text}
                                      selection_status_color={badge?.color}
                                      on_toggle_selected={(checked) =>
                                        toggleSyncDialogSession(item.session_id, checked)
                                      }
                                      on_preview={() => void previewSyncDialogSession(syncDialog.pane_id, item.session_id)}
                                    />
                                  );
                                }}
                              />
                            </div>
                          )
                        },
                        {
                          key: "unlinked",
                          label: `未关联 (${syncDialogGroupedItems.unlinked.length})`,
                          children: (
                            <div className="session-manage-tab-pane">
                              <SessionCandidateVirtualList
                                items={syncDialogGroupedItems.unlinked}
                                empty_text="未关联分组暂无会话"
                                render_item={(item) => {
                                  const badge = getSyncDialogSessionSelectionBadge(item.session_id);
                                  return (
                                    <SessionCandidateCard
                                      session_id={item.session_id}
                                      sid_short={shortSessionId(item.session_id)}
                                      selected={syncDialogVisualSelectedSessionSet.has(item.session_id)}
                                      previewing={syncDialogPreviewSessionId === item.session_id}
                                      created_text={formatTs(item.started_at)}
                                      updated_text={formatTs(item.last_seen_at)}
                                      record_count={item.record_count}
                                      source_files={item.source_files}
                                      first_input={item.first_input}
                                      selection_status_text={badge?.text}
                                      selection_status_color={badge?.color}
                                      on_toggle_selected={(checked) =>
                                        toggleSyncDialogSession(item.session_id, checked)
                                      }
                                      on_preview={() => void previewSyncDialogSession(syncDialog.pane_id, item.session_id)}
                                    />
                                  );
                                }}
                              />
                            </div>
                          )
                        }
                      ]}
                    />
                  )}
                </div>
              </>
          </div>

          <Card size="small" title="同步预览" className="sync-dialog-right">
            <div className="sync-preview-header">
              <div className="sync-preview-header-main">
                <Space size={[8, 8]} wrap>
                  <Typography.Text type="secondary">
                    预览会话：{syncDialogPreviewSessionId ? shortSessionId(syncDialogPreviewSessionId) : "已选会话汇总"}
                  </Typography.Text>
                  <Tag color={syncDialogPreviewSessionId ? "blue" : "default"}>
                    {syncDialogPreviewSelectionText}
                  </Tag>
                </Space>
                <Space size={6} className="sync-preview-progress-actions" wrap>
                  <Button size="small" onClick={() => void jumpSyncDialogPreviewToStart()}>
                    回到起始
                  </Button>
                  <Button size="small" onClick={() => void jumpSyncDialogPreviewToLatest()}>
                    回到最新
                  </Button>
                  <Button
                    size="small"
                    onClick={() => setPreviewOverlaySource("sync-dialog")}
                    disabled={!canOpenSyncDialogPreviewOverlay}
                  >
                    弹窗预览
                  </Button>
                  <Button
                    size="small"
                    onClick={() => {
                      if (syncDialog.pane_id && syncDialog.selected_session_ids.length) {
                        void ensureSyncDialogSessionsLoaded(
                          syncDialog.pane_id,
                          syncDialog.selected_session_ids
                        ).catch((error) => {
                          console.error(error);
                          messageApi.error("加载已选会话消息失败");
                        });
                      }
                      setSyncDialog((current) => ({
                        ...current,
                        preview_session_id: "",
                        preview_query: "",
                        preview_kind: "all"
                      }));
                    }}
                    disabled={!syncDialog.selected_session_ids.length}
                  >
                    查看已选全量
                  </Button>
                </Space>
              </div>
              <div className="sync-preview-header-tools">
                <Space size={6} className="sync-preview-filter-actions" wrap>
                  <Select
                    value={syncDialog.strategy}
                    onChange={(value) =>
                      setSyncDialog((current) => ({
                        ...current,
                        strategy: (value as SyncStrategy) || "turn_3",
                        selected_session_ids:
                          ((value as SyncStrategy) || "turn_3") !== "all" &&
                          syncDialogCurrentSessionId &&
                          current.selected_session_ids.length === syncDialogAllSessionIds.length &&
                          syncDialogAllSessionIds.length > 1
                            ? [syncDialogCurrentSessionId]
                            : current.selected_session_ids,
                        included_entry_ids: [],
                        excluded_entry_ids: [],
                        progress_stage: "idle",
                        progress_percent: 0,
                        progress_text: syncProgressText("idle")
                      }))
                    }
                    options={[
                      { value: "turn_1", label: "最近 1 轮" },
                      { value: "turn_3", label: "最近 3 轮" },
                      { value: "turn_5", label: "最近 5 轮" },
                      { value: "latest_qa", label: "最新一问一答" },
                      { value: "all", label: "全部记录" }
                    ]}
                    style={{ width: 160 }}
                  />
                  <Input
                    allowClear
                    value={syncDialog.preview_query}
                    onChange={(event) =>
                      setSyncDialog((current) => ({
                        ...current,
                        preview_query: event.target.value
                      }))
                    }
                    placeholder="过滤预览内容"
                    style={{ width: 220 }}
                  />
                  <Select
                    value={syncDialog.preview_kind}
                    onChange={(value) =>
                      setSyncDialog((current) => ({
                        ...current,
                        preview_kind: (value as SyncPreviewKind) || "all"
                      }))
                    }
                    options={[
                      { value: "all", label: "全部类型" },
                      { value: "input", label: "仅输入" },
                      { value: "output", label: "仅输出" }
                    ]}
                    style={{ width: 120 }}
                  />
                  <Button onClick={() => void reloadSyncDialogEntries()} loading={syncDialog.loading}>
                    刷新预览
                  </Button>
                </Space>
                <Space size={6} className="sync-preview-batch-actions" wrap>
                  <Button
                    size="small"
                    onClick={() => excludeSyncDialogFilteredEntries()}
                    disabled={
                      !(syncDialogPreviewSessionId ? syncDialogPreview.preview_rows.length : syncDialogFilteredEntries.length) ||
                      syncDialogFilteredExcludedCount >= syncDialogFilteredEntries.length
                    }
                  >
                    全排除
                  </Button>
                  <Button
                    size="small"
                    onClick={() => includeSyncDialogFilteredEntries()}
                    disabled={!syncDialogFilteredExcludedCount}
                  >
                    全恢复
                  </Button>
                </Space>
              </div>
            </div>
            {syncDialog.loading ? (
              <div className="sync-preview-loading">
                <Spin />
              </div>
            ) : (
              <>
                <SyncEntryPreviewList
                  user_avatar_src={userAvatarSrc}
                  assistant_avatar_src={assistantAvatarSrc}
                  scroll_command={syncDialogPreviewScrollCommand}
                  items={syncDialogPreviewItems}
                  empty_text={
                    (syncDialogPreviewSessionId ? syncDialogPreview.preview_rows.length : syncDialogFilteredEntries.length)
                      ? "当前预览会话在筛选条件下暂无记录"
                      : "当前筛选下暂无可同步记录"
                  }
                  on_reach_bottom={
                    syncDialogPreviewSessionId && syncDialogPreview.preview_has_more
                      ? () => {
                          if (!syncDialogPreview.preview_from_end) {
                            void loadMoreSyncDialogPreviewRows();
                          }
                        }
                      : undefined
                  }
                  on_reach_top={
                    syncDialogPreviewSessionId && syncDialogPreview.preview_has_more
                      ? () => {
                          if (syncDialogPreview.preview_from_end) {
                            void loadMoreSyncDialogPreviewRows();
                          }
                        }
                      : undefined
                  }
                  on_toggle_included={(entryId, included) =>
                    toggleSyncDialogEntryExcluded(entryId, !included)
                  }
                  is_favorited={isPreviewMessageFavorited}
                  on_toggle_favorite={togglePreviewMessageFavorite}
                  on_request_full_content={loadSyncDialogPreviewMessageDetail}
                />
              </>
            )}
          </Card>
        </div>
      </Modal>

      <Modal
        open={previewOverlaySource !== null}
        title={previewOverlayTitle}
        onCancel={() => setPreviewOverlaySource(null)}
        footer={null}
        width={1200}
        centered
        getContainer={() => document.body}
        className="session-preview-overlay-modal"
        destroyOnClose={false}
      >
        {previewOverlaySource === "session-manage" ? (
          <>
            <div className="session-preview-overlay-meta">
              <Space size={[8, 8]} wrap>
                <Typography.Text type="secondary">
                  SID：{sessionManagePreview.preview_session_id ? shortSessionId(sessionManagePreview.preview_session_id) : "-"}
                </Typography.Text>
                <Button
                  size="small"
                  onClick={() => void jumpSessionManagePreviewToStart()}
                  loading={sessionManagePreview.preview_loading && !sessionManagePreview.preview_from_end}
                  disabled={!sessionManagePreview.preview_session_id.trim()}
                >
                  开头
                </Button>
                <Button
                  size="small"
                  onClick={() => void jumpSessionManagePreviewToLatest()}
                  loading={sessionManagePreview.preview_loading && sessionManagePreview.preview_from_end}
                  disabled={!sessionManagePreview.preview_session_id.trim()}
                >
                  最新
                </Button>
                <Typography.Text type="secondary">
                  已加载 {sessionManagePreview.preview_loaded_rows}/{sessionManagePreview.preview_total_rows}
                </Typography.Text>
              </Space>
            </div>
            <div className="session-preview-overlay-content">
              {previewOverlayLoading ? (
                <div className="session-preview-loading">
                  <Spin />
                </div>
              ) : (
                <SyncEntryPreviewList
                  show_checkbox={false}
                  user_avatar_src={userAvatarSrc}
                  assistant_avatar_src={assistantAvatarSrc}
                  scroll_command={sessionManagePreviewScrollCommand}
                  highlighted_item_id={sessionManageHighlightedMessageId}
                  items={sessionManagePreviewItems}
                  empty_text={previewOverlayEmptyText}
                  on_reach_bottom={
                    sessionManagePreview.preview_session_id.trim() && sessionManagePreview.preview_has_more
                      ? () => {
                          if (!sessionManagePreview.preview_from_end) {
                            void loadMoreSessionManagePreviewRows();
                          }
                        }
                      : undefined
                  }
                  on_reach_top={
                    sessionManagePreview.preview_session_id.trim() && sessionManagePreview.preview_has_more
                      ? () => {
                          if (sessionManagePreview.preview_from_end) {
                            void loadMoreSessionManagePreviewRows();
                          }
                        }
                      : undefined
                  }
                  is_favorited={isPreviewMessageFavorited}
                  on_toggle_favorite={togglePreviewMessageFavorite}
                  on_request_full_content={loadSessionManagePreviewMessageDetail}
                />
              )}
            </div>
          </>
        ) : previewOverlaySource === "sync-dialog" ? (
          <>
            <div className="session-preview-overlay-meta">
              <Space size={[8, 8]} wrap>
                <Typography.Text type="secondary">
                  预览会话：{syncDialogPreviewSessionId ? shortSessionId(syncDialogPreviewSessionId) : "已选会话汇总"}
                </Typography.Text>
                <Tag color={syncDialogPreviewSessionId ? "blue" : "default"}>
                  {syncDialogPreviewSelectionText}
                </Tag>
              </Space>
            </div>
            <div className="session-preview-overlay-content">
              {previewOverlayLoading ? (
                <div className="session-preview-loading">
                  <Spin />
                </div>
              ) : (
                <SyncEntryPreviewList
                  user_avatar_src={userAvatarSrc}
                  assistant_avatar_src={assistantAvatarSrc}
                  items={syncDialogPreviewItems}
                  empty_text={previewOverlayEmptyText}
                  on_toggle_included={(entryId, included) =>
                    toggleSyncDialogEntryExcluded(entryId, !included)
                  }
                  is_favorited={isPreviewMessageFavorited}
                  on_toggle_favorite={togglePreviewMessageFavorite}
                  on_request_full_content={loadSyncDialogPreviewMessageDetail}
                />
              )}
            </div>
          </>
        ) : null}
      </Modal>

    </ConfigProvider>
  );
}

export default App;
