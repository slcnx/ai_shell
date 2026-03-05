import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Terminal } from "xterm";
import type { IDisposable } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";

type Provider = string;
type LayoutMode = "vertical" | "horizontal";

type PaneSummary = {
  id: string;
  provider: string;
  title: string;
  created_at: number;
  updated_at: number;
};

type EntryRecord = {
  id: string;
  pane_id: string;
  kind: string;
  content: string;
  created_at: number;
  synced_from: string | null;
};

type ProviderPromptResponse = {
  input: EntryRecord;
  output: EntryRecord;
  mode: string;
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

type ObservabilityInfo = {
  log_path: string;
};

type AppConfigResponse = {
  config_path: string;
  working_directory: string | null;
  native_session_list_cache_ttl_secs: number;
};

type NativeSessionCandidate = {
  provider: string;
  session_id: string;
  started_at: number;
  last_seen_at: number;
  source_files: number;
  record_count: number;
};

type NativeSessionListResponse = {
  items: NativeSessionCandidate[];
  total: number;
  offset: number;
  limit: number;
  has_more: boolean;
};

type SessionPickerListCacheEntry = {
  loaded_at_ms: number;
  items: NativeSessionCandidate[];
};

type NativeSessionPreviewRow = {
  kind: string;
  content: string;
  created_at: number;
};

type NativeSessionPreviewResponse = {
  session_id: string;
  rows: NativeSessionPreviewRow[];
  total_rows: number;
  loaded_rows: number;
  has_more: boolean;
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

type SyncQuickPreset = "turn-1" | "turn-3" | "turn-5" | "latest-qa" | "all";
type SyncScope = "selected" | SyncQuickPreset;
type SessionPickerSortMode = "time_desc" | "time_asc" | "records_desc" | "records_asc";

type PaneView = PaneSummary & {
  entries: EntryRecord[];
  selected_ids: string[];
  target_pane_id: string;
  sync_scope: SyncScope;
  total_records: number;
  loaded_count: number;
  loading_more: boolean;
  prompt_input: string;
  sending_prompt: boolean;
  last_mode: string;
  importing_logs: boolean;
  clearing_history: boolean;
  auto_import_enabled: boolean;
  consecutive_parse_errors: number;
  auto_import_circuit_open: boolean;
  native_session_id: string;
  sid_detect_highlight: boolean;
  last_import_summary: string;
  last_sync_note: string;
  last_sync_raw_payload: string;
  show_sync_raw_payload: boolean;
  last_sync_was_compressed: boolean;
  focus_terminal: boolean;
};

type TerminalOutputEvent = {
  pane_id: string;
  data: string;
};

type TerminalExitEvent = {
  pane_id: string;
};

type PaneTerminal = {
  term: Terminal;
  fit: FitAddon;
  dataDisposable: IDisposable;
  resizeObserver: ResizeObserver;
  element: HTMLDivElement;
  focusHandler: () => void;
};

const FALLBACK_PROVIDERS: Provider[] = ["codex", "claude", "gemini"];
const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;
const PAGE_SIZE = 120;
const MAX_RENDERED_RECORDS = 320;
const DEFAULT_SYNC_MAX_CHARS = 5200;
const DEFAULT_SYNC_SUMMARY_CHARS = 1800;
const DEFAULT_SYNC_RECENT_MESSAGES = 2;
const DEFAULT_SYNC_TOKEN_WATERLINE = 8000;
const DEFAULT_SYNC_TURN_WATERLINE = 20;
const MAX_SUMMARY_ITEMS = 18;
const MAX_SUMMARY_LINE_CHARS = 180;
const AUTO_IMPORT_INTERVAL_MS = 10000;
const AUTO_IMPORT_BREAKER_THRESHOLD = 3;
const IMPORT_FILE_QUIET_WINDOW_SECONDS = 2;
const SID_HIGHLIGHT_MS = 1400;
const SESSION_PICKER_INITIAL_PAGE_SIZE = 24;
const SESSION_PICKER_PAGE_SIZE = 60;
const SESSION_PREVIEW_PAGE = 200;
const SESSION_INDEX_PROGRESS_POLL_MS = 450;

type SyncComposeResult = {
  originalPayload: string;
  payload: string;
  compressed: boolean;
  originalChars: number;
  compressedChars: number;
  originalTokens: number;
  triggerReason: string;
};

type SyncCompressionOptions = {
  enabled: boolean;
  tokenWaterline: number;
  turnWaterline: number;
  maxChars: number;
  summaryChars: number;
  keepRecentMessages: number;
};

type PipelineStatus = "idle" | "ok" | "warn" | "error";

type PipelineEdgeId =
  | "log_import"
  | "import_store"
  | "store_compress"
  | "compress_filter"
  | "filter_adapter"
  | "adapter_model";

type PipelineEdgeStat = {
  total: number;
  ok: number;
  warn: number;
  error: number;
  lastStatus: PipelineStatus;
  lastNote: string;
  lastAt: number;
};

const FLOW_EDGE_ORDER: Array<{ id: PipelineEdgeId; from: string; to: string }> = [
  { id: "log_import", from: "Log", to: "Import" },
  { id: "import_store", from: "Import", to: "Store" },
  { id: "store_compress", from: "Store", to: "Compress" },
  { id: "compress_filter", from: "Compress", to: "Filter" },
  { id: "filter_adapter", from: "Filter", to: "Adapter" },
  { id: "adapter_model", from: "Adapter", to: "Model" }
];

function createPipelineInitialState(): Record<PipelineEdgeId, PipelineEdgeStat> {
  return {
    log_import: {
      total: 0,
      ok: 0,
      warn: 0,
      error: 0,
      lastStatus: "idle",
      lastNote: "",
      lastAt: 0
    },
    import_store: {
      total: 0,
      ok: 0,
      warn: 0,
      error: 0,
      lastStatus: "idle",
      lastNote: "",
      lastAt: 0
    },
    store_compress: {
      total: 0,
      ok: 0,
      warn: 0,
      error: 0,
      lastStatus: "idle",
      lastNote: "",
      lastAt: 0
    },
    compress_filter: {
      total: 0,
      ok: 0,
      warn: 0,
      error: 0,
      lastStatus: "idle",
      lastNote: "",
      lastAt: 0
    },
    filter_adapter: {
      total: 0,
      ok: 0,
      warn: 0,
      error: 0,
      lastStatus: "idle",
      lastNote: "",
      lastAt: 0
    },
    adapter_model: {
      total: 0,
      ok: 0,
      warn: 0,
      error: 0,
      lastStatus: "idle",
      lastNote: "",
      lastAt: 0
    }
  };
}

function pipelineStatusText(status: PipelineStatus): string {
  if (status === "ok") {
    return "成功";
  }
  if (status === "warn") {
    return "告警";
  }
  if (status === "error") {
    return "失败";
  }
  return "待运行";
}

function quickPresetLabel(preset: SyncQuickPreset): string {
  if (preset === "turn-1") {
    return "最近1轮";
  }
  if (preset === "turn-3") {
    return "最近3轮";
  }
  if (preset === "turn-5") {
    return "最近5轮";
  }
  if (preset === "all") {
    return "全部会话";
  }
  return "最新问答";
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

function readStoredNumber(key: string, fallback: number): number {
  if (typeof window === "undefined") {
    return fallback;
  }
  const raw = window.localStorage.getItem(key);
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readStoredBoolean(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") {
    return fallback;
  }
  const raw = window.localStorage.getItem(key);
  if (raw === null) {
    return fallback;
  }
  return raw === "1";
}

function asTitle(provider: string): string {
  return provider.toUpperCase();
}

function shortSessionId(sessionId: string): string {
  const normalized = sessionId.trim();
  if (normalized.length <= 18) {
    return normalized;
  }
  return `${normalized.slice(0, 8)}...${normalized.slice(-6)}`;
}

function parseSessionIdList(value: string): string[] {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const raw of value.split(/[\n\r,;\s]+/)) {
    const sid = raw.trim();
    if (!sid || seen.has(sid)) {
      continue;
    }
    seen.add(sid);
    items.push(sid);
  }
  return items;
}

function formatSessionIdList(sessionIds: string[], separator = ", "): string {
  return sessionIds.join(separator);
}

function mergeSessionIdLists(primary: string[], secondary: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const sid of [...primary, ...secondary]) {
    const normalized = sid.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    merged.push(normalized);
  }
  return merged;
}

function sessionSortArgs(mode: SessionPickerSortMode): { sortBy: "time" | "records"; sortOrder: "asc" | "desc" } {
  if (mode === "time_asc") {
    return { sortBy: "time", sortOrder: "asc" };
  }
  if (mode === "records_desc") {
    return { sortBy: "records", sortOrder: "desc" };
  }
  if (mode === "records_asc") {
    return { sortBy: "records", sortOrder: "asc" };
  }
  return { sortBy: "time", sortOrder: "desc" };
}

function sortSessionCandidates(
  items: NativeSessionCandidate[],
  mode: SessionPickerSortMode
): NativeSessionCandidate[] {
  const sorted = [...items];
  if (mode === "records_desc" || mode === "records_asc") {
    sorted.sort((a, b) => {
      const ord =
        a.record_count - b.record_count ||
        a.started_at - b.started_at ||
        a.last_seen_at - b.last_seen_at ||
        a.session_id.localeCompare(b.session_id);
      return mode === "records_desc" ? -ord : ord;
    });
    return sorted;
  }

  sorted.sort((a, b) => {
    const aTime = a.started_at > 0 ? a.started_at : a.last_seen_at;
    const bTime = b.started_at > 0 ? b.started_at : b.last_seen_at;
    const ord = aTime - bTime || a.last_seen_at - b.last_seen_at || a.session_id.localeCompare(b.session_id);
    return mode === "time_desc" ? -ord : ord;
  });
  return sorted;
}

type SessionFilterQuery = {
  timeFrom: number | null;
  timeTo: number | null;
  recordsMin: number | null;
  recordsMax: number | null;
};

function parseDateTimeLocalToEpoch(value: string): number | null {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  const timestamp = new Date(normalized).getTime();
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return null;
  }
  return Math.floor(timestamp / 1000);
}

function parseSessionFilterQuery(
  timeFromText: string,
  timeToText: string,
  recordsMinText: string,
  recordsMaxText: string
): SessionFilterQuery {
  let timeFrom = parseDateTimeLocalToEpoch(timeFromText);
  let timeTo = parseDateTimeLocalToEpoch(timeToText);
  if (timeFrom !== null && timeTo !== null && timeFrom > timeTo) {
    const swap = timeFrom;
    timeFrom = timeTo;
    timeTo = swap;
  }

  const parseRecord = (raw: string): number | null => {
    const normalized = raw.trim();
    if (!normalized) {
      return null;
    }
    const value = Number(normalized);
    if (!Number.isFinite(value)) {
      return null;
    }
    return Math.max(0, Math.floor(value));
  };

  let recordsMin = parseRecord(recordsMinText);
  let recordsMax = parseRecord(recordsMaxText);
  if (recordsMin !== null && recordsMax !== null && recordsMin > recordsMax) {
    const swap = recordsMin;
    recordsMin = recordsMax;
    recordsMax = swap;
  }

  return {
    timeFrom,
    timeTo,
    recordsMin,
    recordsMax
  };
}

function sessionFilterCacheKey(query: SessionFilterQuery): string {
  const key = [query.timeFrom ?? "", query.timeTo ?? "", query.recordsMin ?? "", query.recordsMax ?? ""];
  return key.join("|");
}

function sessionPickerCacheKey(paneId: string, query: SessionFilterQuery): string {
  return `${paneId}::${sessionFilterCacheKey(query)}`;
}

function nativeSourceHint(provider: string): string {
  if (provider === "codex") {
    return "~/.codex/sessions/**/rollout-*.jsonl";
  }
  if (provider === "claude") {
    return "~/.claude/projects/**/*.jsonl";
  }
  if (provider === "gemini") {
    return "~/.gemini/tmp/**/chats/session-*.json";
  }
  return "provider-native logs";
}

function formatTs(value: number): string {
  return new Date(value * 1000).toLocaleString();
}

function cleanHistoryText(value: string): string {
  return value
    .replace(ANSI_PATTERN, "")
    .replace(/\u0000/g, "")
    .replace(/\u0008/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

function mergeUniqueEntries(base: EntryRecord[], incoming: EntryRecord[]): EntryRecord[] {
  const map = new Map<string, EntryRecord>();
  for (const item of base) {
    map.set(item.id, item);
  }
  for (const item of incoming) {
    map.set(item.id, { ...item, content: cleanHistoryText(item.content) });
  }
  return Array.from(map.values())
    .sort((a, b) => a.created_at - b.created_at)
    .slice(-MAX_RENDERED_RECORDS);
}

function compareEntryOrder(a: EntryRecord, b: EntryRecord): number {
  if (a.created_at !== b.created_at) {
    return a.created_at - b.created_at;
  }
  const aKind = a.kind === "input" ? 0 : a.kind === "output" ? 1 : 2;
  const bKind = b.kind === "input" ? 0 : b.kind === "output" ? 1 : 2;
  if (aKind !== bKind) {
    return aKind - bKind;
  }
  return a.id.localeCompare(b.id);
}

function sortEntriesForSync(entries: EntryRecord[]): EntryRecord[] {
  return [...entries].sort(compareEntryOrder);
}

function orderEntriesInputFirst(entries: EntryRecord[]): EntryRecord[] {
  const ordered = sortEntriesForSync(entries);
  const inputs = ordered.filter((entry) => entry.kind === "input");
  const outputs = ordered.filter((entry) => entry.kind === "output");
  const others = ordered.filter((entry) => entry.kind !== "input" && entry.kind !== "output");
  return [...inputs, ...outputs, ...others];
}

function pickRecentTurns(entries: EntryRecord[], turnCount: number): EntryRecord[] {
  if (!entries.length) {
    return [];
  }
  const ordered = sortEntriesForSync(entries);
  const turns: EntryRecord[][] = [];
  let current: EntryRecord[] = [];

  for (const entry of ordered) {
    if (entry.kind === "input") {
      if (current.length > 0) {
        turns.push(current);
      }
      current = [entry];
      continue;
    }
    if (!current.length) {
      current = [entry];
    } else {
      current.push(entry);
    }
  }
  if (current.length > 0) {
    turns.push(current);
  }

  const take = clamp(turnCount, 1, 20);
  return turns.slice(-take).flat();
}

function pickLatestQuestionAnswer(entries: EntryRecord[]): EntryRecord[] {
  if (!entries.length) {
    return [];
  }
  const ordered = sortEntriesForSync(entries);
  const outputIndex = [...ordered]
    .reverse()
    .findIndex((entry) => entry.kind === "output");
  if (outputIndex < 0) {
    return [];
  }
  const latestOutput = ordered[ordered.length - 1 - outputIndex];
  const indexInOrdered = ordered.findIndex((entry) => entry.id === latestOutput.id);
  const latestInput = [...ordered.slice(0, indexInOrdered + 1)]
    .reverse()
    .find((entry) => entry.kind === "input");

  if (!latestInput) {
    return [latestOutput];
  }
  return [latestInput, latestOutput];
}

function pickEntriesByPreset(entries: EntryRecord[], preset: SyncQuickPreset): EntryRecord[] {
  if (preset === "latest-qa") {
    return pickLatestQuestionAnswer(entries);
  }
  if (preset === "all") {
    return orderEntriesInputFirst(entries);
  }
  return pickRecentTurns(entries, preset === "turn-1" ? 1 : preset === "turn-3" ? 3 : 5);
}

function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

function toSnippet(text: string, limit: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "";
  }
  return compact.length > limit ? `${compact.slice(0, limit)}...` : compact;
}

function collectObjectiveFacts(entries: EntryRecord[], limit: number): string[] {
  const facts: string[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const codeBlocks = entry.content.match(/```[\s\S]*?```/g) ?? [];
    for (const block of codeBlocks) {
      const snippet = toSnippet(block, MAX_SUMMARY_LINE_CHARS);
      if (!snippet) {
        continue;
      }
      const item = `- [code] ${snippet}`;
      const key = item.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        facts.push(item);
      }
      if (facts.length >= limit) {
        return facts;
      }
    }

    const lines = entry.content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    for (const line of lines) {
      const isFact =
        /\d/.test(line) ||
        /[A-Za-z_][A-Za-z0-9_.-]{2,}/.test(line) ||
        /[:=\/\\.-]/.test(line);
      if (!isFact) {
        continue;
      }
      const snippet = toSnippet(line, MAX_SUMMARY_LINE_CHARS);
      if (!snippet) {
        continue;
      }
      const item = `- [fact] ${snippet}`;
      const key = item.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        facts.push(item);
      }
      if (facts.length >= limit) {
        return facts;
      }
    }
  }

  return facts;
}

function collectSubjectiveSummary(entries: EntryRecord[], limit: number): string[] {
  const items: string[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const firstLine = entry.content
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (!firstLine) {
      continue;
    }
    const snippet = toSnippet(firstLine, MAX_SUMMARY_LINE_CHARS);
    if (!snippet) {
      continue;
    }
    const item = `- [${entry.kind}] 用户表达了对某方案的疑虑/意图：${snippet}`;
    const key = item.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    items.push(item);
    if (items.length >= limit) {
      break;
    }
  }

  return items;
}

function collectAssistantStyleAnchor(entries: EntryRecord[], maxChars: number): string {
  const outputs = sortEntriesForSync(entries).filter((entry) => entry.kind === "output");
  if (!outputs.length) {
    return "";
  }
  const snippets = outputs
    .slice(-2)
    .map((entry) => {
      const line = entry.content
        .split("\n")
        .map((item) => item.trim())
        .find((item) => item.length > 0);
      return toSnippet(line ?? entry.content, 160);
    })
    .filter((item) => item.length > 0);
  if (!snippets.length) {
    return "";
  }
  const joined = snippets.join(" / ");
  if (joined.length <= maxChars) {
    return joined;
  }
  return `${joined.slice(0, maxChars)}...`;
}

function summarizeEntriesForSync(entries: EntryRecord[], summaryChars: number): string {
  const targetChars = clamp(summaryChars, 500, 12000);
  const factItems = collectObjectiveFacts(entries, MAX_SUMMARY_ITEMS);
  const subjectiveItems = collectSubjectiveSummary(entries, MAX_SUMMARY_ITEMS);
  const styleAnchor = collectAssistantStyleAnchor(entries, Math.min(420, Math.floor(targetChars * 0.22)));

  let summary = [
    "objective_facts:",
    factItems.length ? factItems.join("\n") : "- (no objective facts extracted)",
    "",
    "subjective_compression:",
    subjectiveItems.length ? subjectiveItems.join("\n") : "- (no subjective lines extracted)",
    "",
    "assistant_style_anchor:",
    styleAnchor ? `- ${styleAnchor}` : "- (no assistant style anchor available)"
  ].join("\n");

  if (summary.length > targetChars) {
    summary = `${summary.slice(0, targetChars)}...`;
  }
  return summary;
}

function composeSyncPayload(entries: EntryRecord[], options: SyncCompressionOptions): SyncComposeResult {
  const originalPayload = entries.map((entry) => entry.content).join("\n\n");
  const originalChars = originalPayload.length;
  const originalTokens = estimateTokenCount(originalPayload);
  const reasonByTokens = originalTokens >= options.tokenWaterline;
  const reasonByTurns = entries.length >= options.turnWaterline;
  const reasonByChars = originalChars > options.maxChars;
  const shouldCompress =
    options.enabled && (reasonByTokens || reasonByTurns || reasonByChars);
  if (!shouldCompress) {
    return {
      originalPayload,
      payload: originalPayload,
      compressed: false,
      originalChars,
      compressedChars: originalChars,
      originalTokens,
      triggerReason: ""
    };
  }

  const keepRecent = clamp(options.keepRecentMessages, 1, 8);
  const recentCount = Math.min(keepRecent, entries.length);
  const earlier = entries.slice(0, entries.length - recentCount);
  const recent = entries.slice(entries.length - recentCount);
  if (!earlier.length) {
    return {
      originalPayload,
      payload: originalPayload,
      compressed: false,
      originalChars,
      compressedChars: originalChars,
      originalTokens,
      triggerReason: ""
    };
  }

  const triggerReason = [
    reasonByTokens ? `token>=${options.tokenWaterline}` : "",
    reasonByTurns ? `turns>=${options.turnWaterline}` : "",
    reasonByChars ? `chars>${options.maxChars}` : ""
  ]
    .filter((value) => value.length > 0)
    .join(", ");

  const summary = summarizeEntriesForSync(earlier, options.summaryChars);
  const recentBlock = recent
    .map((entry) => `### ${entry.kind} @ ${formatTs(entry.created_at)}\n${entry.content.trimEnd()}`)
    .join("\n\n");

  let payload = [
    "[SYNC-COMPRESSED]",
    `trigger=${triggerReason}`,
    `original_chars=${originalChars}; estimated_tokens=${originalTokens}; selected_messages=${entries.length}; kept_recent=${recentCount}`,
    "",
    "earlier_summary:",
    summary,
    "",
    "recent_messages_verbatim:",
    recentBlock
  ].join("\n");

  if (payload.length > options.maxChars) {
    const fixedPartLength = payload.length - recentBlock.length;
    const remainingBudget = Math.max(420, options.maxChars - fixedPartLength);
    const trimmedRecent =
      recentBlock.length > remainingBudget
        ? `...[recent truncated to fit]\n${recentBlock.slice(-remainingBudget)}`
        : recentBlock;
    payload = [
      "[SYNC-COMPRESSED]",
      `trigger=${triggerReason}`,
      `original_chars=${originalChars}; estimated_tokens=${originalTokens}; selected_messages=${entries.length}; kept_recent=${recentCount}`,
      "",
      "earlier_summary:",
      summary,
      "",
      "recent_messages_verbatim:",
      trimmedRecent
    ].join("\n");
  }

  return {
    originalPayload,
    payload,
    compressed: true,
    originalChars,
    compressedChars: payload.length,
    originalTokens,
    triggerReason
  };
}

function isProviderSpecificInstructionBlock(content: string): boolean {
  const text = content.toLowerCase();
  const strongMarkers = [
    "# agents.md instructions",
    "<instructions>",
    "<environment_context>",
    "</environment_context>",
    "<cwd>",
    "</cwd>",
    "<shell>",
    "</shell>",
    "<current_date>",
    "</current_date>",
    "<timezone>",
    "</timezone>",
    "<permissions instructions>",
    "<collaboration_mode>",
    "you are codex, a coding agent",
    "claude code alias 'cc' loaded",
    "<local-command-stdout>",
    "<command-name>/model",
    "<command-message>/model",
    "<command-args>",
    "[request interrupted by user]"
  ];
  const weakMarkers = [
    "a skill is a set of local instructions",
    "<current_date>",
    "<timezone>",
    "<cwd>",
    "guideline",
    "special cases",
    "full permissions mode",
    "proxy set to localhost",
    "shell/powershell",
    "environment_context"
  ];

  if (strongMarkers.some((marker) => text.includes(marker))) {
    return true;
  }
  const weakCount = weakMarkers.reduce(
    (count, marker) => (text.includes(marker) ? count + 1 : count),
    0
  );
  return weakCount >= 2;
}

function createPaneView(summary: PaneSummary): PaneView {
  return {
    ...summary,
    entries: [],
    selected_ids: [],
    target_pane_id: "",
    sync_scope: "selected",
    total_records: 0,
    loaded_count: 0,
    loading_more: false,
    prompt_input: "",
    sending_prompt: false,
    last_mode: "",
    importing_logs: false,
    clearing_history: false,
    auto_import_enabled: false,
    consecutive_parse_errors: 0,
    auto_import_circuit_open: false,
    native_session_id: "",
    sid_detect_highlight: false,
    last_import_summary: "",
    last_sync_note: "",
    last_sync_raw_payload: "",
    show_sync_raw_payload: false,
    last_sync_was_compressed: false,
    focus_terminal: false
  };
}

function App() {
  const [panes, setPanes] = useState<PaneView[]>([]);
  const [activePaneId, setActivePaneId] = useState("");
  const [availableProviders, setAvailableProviders] = useState<Provider[]>(FALLBACK_PROVIDERS);
  const [layout, setLayout] = useState<LayoutMode>("vertical");
  const [showFlowMap, setShowFlowMap] = useState<boolean>(() =>
    readStoredBoolean("ai-shell.flow.map.show", true)
  );
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [clearing, setClearing] = useState(false);
  const [logPath, setLogPath] = useState("");
  const [pipelineStats, setPipelineStats] = useState<Record<PipelineEdgeId, PipelineEdgeStat>>(
    () => createPipelineInitialState()
  );
  const [syncCompressEnabled, setSyncCompressEnabled] = useState<boolean>(() =>
    readStoredBoolean("ai-shell.sync.compress.enabled", true)
  );
  const [syncTokenWaterline, setSyncTokenWaterline] = useState<number>(() =>
    clamp(
      readStoredNumber("ai-shell.sync.compress.tokenWaterline", DEFAULT_SYNC_TOKEN_WATERLINE),
      800,
      64000
    )
  );
  const [syncTurnWaterline, setSyncTurnWaterline] = useState<number>(() =>
    clamp(
      readStoredNumber("ai-shell.sync.compress.turnWaterline", DEFAULT_SYNC_TURN_WATERLINE),
      4,
      200
    )
  );
  const [syncMaxChars, setSyncMaxChars] = useState<number>(() =>
    clamp(readStoredNumber("ai-shell.sync.compress.maxChars", DEFAULT_SYNC_MAX_CHARS), 1200, 24000)
  );
  const [syncSummaryChars, setSyncSummaryChars] = useState<number>(() =>
    clamp(
      readStoredNumber("ai-shell.sync.compress.summaryChars", DEFAULT_SYNC_SUMMARY_CHARS),
      500,
      12000
    )
  );
  const [workingDirectory, setWorkingDirectory] = useState<string>("");
  const [configPath, setConfigPath] = useState<string>("");
  const [showConfigMenu, setShowConfigMenu] = useState(false);
  const [applyingWorkingDirectory, setApplyingWorkingDirectory] = useState(false);
  const [sessionListCacheTtlSecs, setSessionListCacheTtlSecs] = useState<number>(30);
  const [savingSessionListCacheTtl, setSavingSessionListCacheTtl] = useState(false);
  const [sessionPickerOpen, setSessionPickerOpen] = useState(false);
  const [sessionPickerPaneId, setSessionPickerPaneId] = useState("");
  const [sessionPickerProvider, setSessionPickerProvider] = useState("");
  const [sessionPickerSortMode, setSessionPickerSortMode] = useState<SessionPickerSortMode>("time_desc");
  const [sessionPickerTimeFrom, setSessionPickerTimeFrom] = useState("");
  const [sessionPickerTimeTo, setSessionPickerTimeTo] = useState("");
  const [sessionPickerRecordsMin, setSessionPickerRecordsMin] = useState("");
  const [sessionPickerRecordsMax, setSessionPickerRecordsMax] = useState("");
  const [sessionPickerItems, setSessionPickerItems] = useState<NativeSessionCandidate[]>([]);
  const [sessionPickerTotal, setSessionPickerTotal] = useState(0);
  const [sessionPickerHasMore, setSessionPickerHasMore] = useState(false);
  const [sessionPickerLoading, setSessionPickerLoading] = useState(false);
  const [sessionPickerLoadingMore, setSessionPickerLoadingMore] = useState(false);
  const [sessionPickerAutoLoading, setSessionPickerAutoLoading] = useState(false);
  const [sessionPickerError, setSessionPickerError] = useState("");
  const [sessionPickerSelectedSid, setSessionPickerSelectedSid] = useState("");
  const [sessionPickerCheckedSids, setSessionPickerCheckedSids] = useState<string[]>([]);
  const [sessionPickerManualSid, setSessionPickerManualSid] = useState("");
  const [sessionPickerPreviewRows, setSessionPickerPreviewRows] = useState<NativeSessionPreviewRow[]>([]);
  const [sessionPickerPreviewLimit, setSessionPickerPreviewLimit] = useState(SESSION_PREVIEW_PAGE);
  const [sessionPickerPreviewTotal, setSessionPickerPreviewTotal] = useState(0);
  const [sessionPickerPreviewHasMore, setSessionPickerPreviewHasMore] = useState(false);
  const [sessionPickerPreviewLoading, setSessionPickerPreviewLoading] = useState(false);
  const [sessionPickerPreviewError, setSessionPickerPreviewError] = useState("");
  const [sessionPickerIndexProgress, setSessionPickerIndexProgress] =
    useState<NativeSessionIndexProgress | null>(null);
  const terminalsRef = useRef<Map<string, PaneTerminal>>(new Map());
  const sessionPickerListTicketRef = useRef(0);
  const sessionPickerPreviewTicketRef = useRef(0);
  const sessionPickerListCacheRef = useRef<Map<string, SessionPickerListCacheEntry>>(new Map());

  const paneIds = useMemo(() => panes.map((pane) => pane.id), [panes]);
  const sessionPickerFilterActive = Boolean(
    sessionPickerTimeFrom.trim() ||
      sessionPickerTimeTo.trim() ||
      sessionPickerRecordsMin.trim() ||
      sessionPickerRecordsMax.trim()
  );
  const sessionPickerMergedSids = useMemo(
    () => mergeSessionIdLists(parseSessionIdList(sessionPickerManualSid), sessionPickerCheckedSids),
    [sessionPickerManualSid, sessionPickerCheckedSids]
  );
  const sessionPickerLoadPercent = useMemo(() => {
    if (sessionPickerTotal <= 0) {
      return 0;
    }
    return clamp(Math.round((sessionPickerItems.length / sessionPickerTotal) * 100), 0, 100);
  }, [sessionPickerItems.length, sessionPickerTotal]);
  const sessionPickerIndexNote = useMemo(() => {
    if (sessionPickerProvider !== "gemini" || !sessionPickerIndexProgress) {
      return "";
    }
    const total = Math.max(0, sessionPickerIndexProgress.total_files);
    const rawProcessed = Math.max(0, sessionPickerIndexProgress.processed_files);
    const processed = total > 0 ? clamp(rawProcessed, 0, total) : rawProcessed;
    const changed = Math.max(0, sessionPickerIndexProgress.changed_files);
    const elapsed = Math.max(0, sessionPickerIndexProgress.elapsed_secs);
    const lastDuration = Math.max(0, sessionPickerIndexProgress.last_duration_secs);
    if (sessionPickerIndexProgress.running) {
      return `索引进度 ${processed}/${total}（变更 ${changed}，已耗时 ${elapsed}s）`;
    }
    if (total > 0 || changed > 0) {
      const durationText = lastDuration > 0 ? `，耗时 ${lastDuration}s` : "";
      return `索引完成 ${processed}/${total}（变更 ${changed}${durationText}）`;
    }
    return "索引就绪";
  }, [sessionPickerProvider, sessionPickerIndexProgress]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(
      "ai-shell.sync.compress.enabled",
      syncCompressEnabled ? "1" : "0"
    );
    window.localStorage.setItem(
      "ai-shell.sync.compress.tokenWaterline",
      String(syncTokenWaterline)
    );
    window.localStorage.setItem(
      "ai-shell.sync.compress.turnWaterline",
      String(syncTurnWaterline)
    );
    window.localStorage.setItem("ai-shell.sync.compress.maxChars", String(syncMaxChars));
    window.localStorage.setItem("ai-shell.sync.compress.summaryChars", String(syncSummaryChars));
    window.localStorage.setItem("ai-shell.flow.map.show", showFlowMap ? "1" : "0");
  }, [
    syncCompressEnabled,
    syncTokenWaterline,
    syncTurnWaterline,
    syncMaxChars,
    syncSummaryChars,
    showFlowMap
  ]);

  useEffect(() => {
    if (sessionListCacheTtlSecs <= 0) {
      sessionPickerListCacheRef.current.clear();
    }
  }, [sessionListCacheTtlSecs]);

  const markPipelineEdge = useCallback(
    (edgeId: PipelineEdgeId, status: PipelineStatus, note: string) => {
      setPipelineStats((current) => {
        const prev = current[edgeId];
        const next: PipelineEdgeStat = {
          ...prev,
          total: prev.total + 1,
          lastStatus: status,
          lastNote: note,
          lastAt: Math.floor(Date.now() / 1000)
        };
        if (status === "ok") {
          next.ok += 1;
        } else if (status === "warn") {
          next.warn += 1;
        } else if (status === "error") {
          next.error += 1;
        }
        return {
          ...current,
          [edgeId]: next
        };
      });
    },
    []
  );

  const applyWorkingDirectory = async (options?: {
    silent?: boolean;
    restartOpenPanes?: boolean;
    pathOverride?: string | null;
  }) => {
    if (applyingWorkingDirectory) {
      return;
    }
    const silent = Boolean(options?.silent);
    const restartOpenPanes = options?.restartOpenPanes ?? true;
    const effectivePath = options?.pathOverride ?? workingDirectory;
    const trimmed = effectivePath.trim();

    setApplyingWorkingDirectory(true);
    try {
      const applied = await invoke<string | null>("set_working_directory", {
        path: trimmed.length ? trimmed : null,
        restartOpenPanes
      });
      const normalized = (applied ?? "").trim();
      setWorkingDirectory(normalized);
      if (!silent) {
        window.alert(normalized ? `工作目录已切换：\n${normalized}` : "已恢复默认工作目录。");
      }
    } catch (error) {
      console.error(error);
      if (!silent) {
        const detail = error instanceof Error ? error.message : String(error);
        window.alert(`工作目录切换失败：${detail}`);
      }
    } finally {
      setApplyingWorkingDirectory(false);
    }
  };

  const pickWorkingDirectory = async () => {
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
      const detail = error instanceof Error ? error.message : String(error);
      window.alert(`打开目录选择器失败：${detail}`);
    }
  };

  const saveSessionListCacheTtl = async (silent?: boolean) => {
    if (savingSessionListCacheTtl) {
      return;
    }
    const normalized = clamp(Number(sessionListCacheTtlSecs || 0), 0, 600);
    setSavingSessionListCacheTtl(true);
    try {
      const applied = await invoke<number>("set_native_session_list_cache_ttl_secs", {
        ttlSecs: normalized
      });
      const finalValue = clamp(Number(applied || 0), 0, 600);
      setSessionListCacheTtlSecs(finalValue);
      if (finalValue <= 0) {
        sessionPickerListCacheRef.current.clear();
      }
      if (!silent) {
        window.alert(
          finalValue > 0
            ? `会话列表缓存已设置为 ${finalValue} 秒。`
            : "会话列表缓存已关闭（每次实时扫描）。"
        );
      }
    } catch (error) {
      console.error(error);
      if (!silent) {
        const detail = error instanceof Error ? error.message : String(error);
        window.alert(`保存会话缓存配置失败：${detail}`);
      }
    } finally {
      setSavingSessionListCacheTtl(false);
    }
  };

  const hydratePaneHistory = useCallback(async (paneId: string) => {
    try {
      const [entries, totalRecords] = await Promise.all([
        invoke<EntryRecord[]>("list_entries", {
          paneId,
          query: null,
          limit: PAGE_SIZE,
          offset: 0
        }),
        invoke<number>("count_entries", {
          paneId,
          query: null
        })
      ]);

      const cleanEntries = entries.map((entry) => ({
        ...entry,
        content: cleanHistoryText(entry.content)
      }));

      setPanes((current) =>
        current.map((row) =>
          row.id === paneId
            ? {
                ...row,
                entries: cleanEntries,
                loaded_count: cleanEntries.length,
                total_records: totalRecords
              }
            : row
        )
      );
    } catch (error) {
      console.error(error);
    }
  }, []);

  const disposeTerminal = useCallback((paneId: string) => {
    const runtime = terminalsRef.current.get(paneId);
    if (!runtime) {
      return;
    }
    runtime.element.removeEventListener("mousedown", runtime.focusHandler);
    runtime.resizeObserver.disconnect();
    runtime.dataDisposable.dispose();
    runtime.term.dispose();
    terminalsRef.current.delete(paneId);
  }, []);

  const mountTerminal = useCallback(
    (paneId: string, element: HTMLDivElement | null) => {
      if (!element) {
        return;
      }

      const existing = terminalsRef.current.get(paneId);
      if (existing) {
        if (existing.element === element) {
          existing.fit.fit();
          void invoke<void>("resize_pane", {
            paneId,
            cols: existing.term.cols,
            rows: existing.term.rows
          }).catch((error) => console.error(error));
          return;
        }
        disposeTerminal(paneId);
      }

      void invoke<boolean>("ensure_pane_runtime", { paneId }).catch((error) => console.error(error));

      const term = new Terminal({
        convertEol: true,
        cursorBlink: true,
        fontFamily:
          "'Cascadia Mono', Consolas, 'JetBrains Mono', Menlo, Monaco, " +
          "'Noto Sans Mono CJK SC', 'Source Han Mono SC', 'PingFang SC', " +
          "'Microsoft YaHei UI', monospace",
        fontSize: 14,
        lineHeight: 1.28,
        theme: {
          background: "#0f1320",
          foreground: "#e8ecff",
          cursor: "#89a6ff",
          selectionBackground: "#2a3552"
        }
      });

      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(element);
      fit.fit();
      term.focus();

      const dataDisposable = term.onData((data) => {
        void invoke<void>("write_to_pane", { paneId, data }).catch((error) => console.error(error));
      });

      const resizeObserver = new ResizeObserver(() => {
        fit.fit();
        void invoke<void>("resize_pane", {
          paneId,
          cols: term.cols,
          rows: term.rows
        }).catch((error) => console.error(error));
      });
      resizeObserver.observe(element);

      const focusHandler = () => term.focus();
      element.addEventListener("mousedown", focusHandler);

      terminalsRef.current.set(paneId, {
        term,
        fit,
        dataDisposable,
        resizeObserver,
        element,
        focusHandler
      });

      void invoke<void>("resize_pane", { paneId, cols: term.cols, rows: term.rows }).catch((error) =>
        console.error(error)
      );
    },
    [disposeTerminal]
  );

  useEffect(() => {
    let disposed = false;

    const boot = async () => {
      try {
        const obs = await invoke<ObservabilityInfo>("get_observability_info");
        if (!disposed) {
          setLogPath(obs.log_path);
        }

        const appConfig = await invoke<AppConfigResponse>("get_app_config").catch((error) => {
          console.error(error);
          return null;
        });
        if (!disposed && appConfig) {
          setConfigPath(appConfig.config_path);
          setWorkingDirectory((appConfig.working_directory ?? "").trim());
          setSessionListCacheTtlSecs(
            clamp(Number(appConfig.native_session_list_cache_ttl_secs || 30), 0, 600)
          );
        }

        const providers = await invoke<string[]>("list_registered_providers")
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
        if (!disposed) {
          setAvailableProviders(providers);
        }

        let paneSummaries = await invoke<PaneSummary[]>("list_panes");
        if (!paneSummaries.length) {
          const created: PaneSummary[] = [];
          for (const provider of providers) {
            const summary = await invoke<PaneSummary>("create_pane", {
              provider,
              title: asTitle(provider)
            });
            created.push(summary);
          }
          paneSummaries = created;
        }

        if (disposed) {
          return;
        }

        setPanes(paneSummaries.map(createPaneView));
        setActivePaneId((current) => current || paneSummaries[0]?.id || "");

        for (const pane of paneSummaries) {
          void hydratePaneHistory(pane.id);
          void invoke<boolean>("ensure_pane_runtime", { paneId: pane.id }).catch((error) =>
            console.error(error)
          );
        }
      } finally {
        if (!disposed) {
          setLoading(false);
        }
      }
    };

    boot().catch((error) => {
      console.error(error);
      if (!disposed) {
        setLoading(false);
      }
    });

    return () => {
      disposed = true;
    };
  }, [hydratePaneHistory]);

  useEffect(() => {
    let unlistenOutput: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;

    const wire = async () => {
      unlistenOutput = await listen<TerminalOutputEvent>("terminal-output", async (event) => {
        const payload = event.payload;
        if (!payload || !payload.pane_id || !payload.data) {
          return;
        }
        const runtime = terminalsRef.current.get(payload.pane_id);
        runtime?.term.write(payload.data);
      });

      unlistenExit = await listen<TerminalExitEvent>("terminal-exit", async (event) => {
        const payload = event.payload;
        if (!payload?.pane_id) {
          return;
        }
        const runtime = terminalsRef.current.get(payload.pane_id);
        runtime?.term.writeln("\r\n[process exited]");
      });
    };

    wire().catch((error) => console.error(error));

    return () => {
      if (unlistenOutput) {
        unlistenOutput();
      }
      if (unlistenExit) {
        unlistenExit();
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      for (const paneId of terminalsRef.current.keys()) {
        disposeTerminal(paneId);
      }
    };
  }, [disposeTerminal]);

  useEffect(() => {
    const activePaneIds = new Set(paneIds);
    for (const paneId of terminalsRef.current.keys()) {
      if (!activePaneIds.has(paneId)) {
        disposeTerminal(paneId);
      }
    }
  }, [disposeTerminal, paneIds]);

  useEffect(() => {
    if (!sessionPickerOpen) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeSessionPicker();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [sessionPickerOpen]);

  useEffect(() => {
    if (!sessionPickerOpen || !sessionPickerPaneId || sessionPickerProvider !== "gemini") {
      setSessionPickerIndexProgress(null);
      return;
    }
    if (!sessionPickerLoading && !sessionPickerAutoLoading) {
      return;
    }

    let stopped = false;
    let timer: number | null = null;

    const tick = async () => {
      try {
        const progress = await invoke<NativeSessionIndexProgress>("get_native_session_index_progress", {
          paneId: sessionPickerPaneId
        });
        if (!stopped) {
          setSessionPickerIndexProgress(progress);
        }
      } catch (error) {
        if (!stopped) {
          console.error(error);
        }
      } finally {
        if (!stopped && (sessionPickerLoading || sessionPickerAutoLoading)) {
          timer = window.setTimeout(tick, SESSION_INDEX_PROGRESS_POLL_MS);
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
    sessionPickerOpen,
    sessionPickerPaneId,
    sessionPickerProvider,
    sessionPickerLoading,
    sessionPickerAutoLoading
  ]);

  const addPane = async (provider: Provider) => {
    const summary = await invoke<PaneSummary>("create_pane", {
      provider,
      title: asTitle(provider)
    });
    setPanes((current) => [...current, createPaneView(summary)]);
    setActivePaneId(summary.id);
    void hydratePaneHistory(summary.id);
  };

  const refreshNativeSessionId = async (paneId: string) => {
    setPanes((current) =>
      current.map((row) =>
        row.id === paneId ? { ...row, sid_detect_highlight: true } : row
      )
    );
    window.setTimeout(() => {
      setPanes((current) =>
        current.map((row) =>
          row.id === paneId ? { ...row, sid_detect_highlight: false } : row
        )
      );
    }, SID_HIGHLIGHT_MS);

    try {
      const sid = await invoke<string | null>("suggest_native_session_id", { paneId });
      setPanes((current) =>
        current.map((row) =>
          row.id === paneId ? { ...row, native_session_id: sid ?? "" } : row
        )
      );
    } catch (error) {
      console.error(error);
    }
  };

  const rebindNativeSession = async (paneId: string) => {
    try {
      await invoke<void>("clear_native_session_binding", { paneId });
      setPanes((current) =>
        current.map((row) =>
          row.id === paneId
            ? {
                ...row,
                native_session_id: "",
                last_import_summary: "",
                consecutive_parse_errors: 0,
                auto_import_circuit_open: false
              }
            : row
        )
      );
      await refreshNativeSessionId(paneId);
    } catch (error) {
      console.error(error);
      window.alert("重新绑定会话失败，请查看日志后重试。");
    }
  };

  const closeSessionPicker = () => {
    sessionPickerListTicketRef.current += 1;
    sessionPickerPreviewTicketRef.current += 1;
    setSessionPickerAutoLoading(false);
    setSessionPickerIndexProgress(null);
    setSessionPickerOpen(false);
  };

  const loadSessionPreview = async (
    paneId: string,
    sessionId: string,
    options?: { limit?: number; loadAll?: boolean }
  ) => {
    const normalized = sessionId.trim();
    if (!normalized) {
      setSessionPickerPreviewRows([]);
      setSessionPickerPreviewTotal(0);
      setSessionPickerPreviewHasMore(false);
      setSessionPickerPreviewError("");
      setSessionPickerPreviewLoading(false);
      return;
    }
    const targetLimit = clamp(options?.limit ?? sessionPickerPreviewLimit, 1, 5000);
    const loadAll = Boolean(options?.loadAll);
    const ticket = sessionPickerPreviewTicketRef.current + 1;
    sessionPickerPreviewTicketRef.current = ticket;
    setSessionPickerPreviewLoading(true);
    setSessionPickerPreviewError("");

    try {
      const response = await invoke<NativeSessionPreviewResponse>("preview_native_session_messages", {
        paneId,
        sessionId: normalized,
        limit: targetLimit,
        loadAll
      });
      if (sessionPickerPreviewTicketRef.current !== ticket) {
        return;
      }
      setSessionPickerPreviewRows(
        response.rows.map((row) => ({
          ...row,
          content: cleanHistoryText(row.content)
        }))
      );
      setSessionPickerPreviewTotal(response.total_rows);
      setSessionPickerPreviewHasMore(response.has_more);
      if (loadAll) {
        setSessionPickerPreviewLimit(Math.max(response.loaded_rows, SESSION_PREVIEW_PAGE));
      } else {
        setSessionPickerPreviewLimit(targetLimit);
      }
    } catch (error) {
      if (sessionPickerPreviewTicketRef.current !== ticket) {
        return;
      }
      console.error(error);
      const detail = error instanceof Error ? error.message : String(error);
      setSessionPickerPreviewRows([]);
      setSessionPickerPreviewTotal(0);
      setSessionPickerPreviewHasMore(false);
      setSessionPickerPreviewError(detail);
    } finally {
      if (sessionPickerPreviewTicketRef.current === ticket) {
        setSessionPickerPreviewLoading(false);
      }
    }
  };

  const autoLoadRemainingSessionCandidates = async (
    paneId: string,
    ticket: number,
    sortMode: SessionPickerSortMode,
    filterQuery: SessionFilterQuery,
    startOffset: number,
    initialItems: NativeSessionCandidate[],
    cacheKey: string
  ) => {
    let offset = startOffset;
    const sortArgs = sessionSortArgs(sortMode);
    let mergedItems = [...initialItems];
    setSessionPickerAutoLoading(true);
    setSessionPickerError("");

    try {
      while (sessionPickerListTicketRef.current === ticket) {
        const response = await invoke<NativeSessionListResponse>("list_native_session_candidates", {
          paneId,
          offset,
          limit: SESSION_PICKER_PAGE_SIZE,
          timeFrom: filterQuery.timeFrom,
          timeTo: filterQuery.timeTo,
          recordsMin: filterQuery.recordsMin,
          recordsMax: filterQuery.recordsMax,
          sortBy: sortArgs.sortBy,
          sortOrder: sortArgs.sortOrder
        });
        if (sessionPickerListTicketRef.current !== ticket) {
          return;
        }
        const seen = new Set(mergedItems.map((item) => item.session_id));
        const appended = response.items.filter((item) => !seen.has(item.session_id));
        if (appended.length > 0) {
          mergedItems = [...mergedItems, ...appended];
          setSessionPickerItems(mergedItems);
        }
        setSessionPickerTotal(response.total);
        setSessionPickerHasMore(response.has_more);

        offset += response.items.length;
        if (!response.has_more || response.items.length === 0) {
          sessionPickerListCacheRef.current.set(cacheKey, {
            loaded_at_ms: Date.now(),
            items: mergedItems
          });
          break;
        }
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      }
    } catch (error) {
      if (sessionPickerListTicketRef.current !== ticket) {
        return;
      }
      console.error(error);
      const detail = error instanceof Error ? error.message : String(error);
      setSessionPickerError(detail);
    } finally {
      if (sessionPickerListTicketRef.current === ticket) {
        setSessionPickerAutoLoading(false);
      }
    }
  };

  const openSessionPicker = async (
    paneId: string,
    sortModeOverride?: SessionPickerSortMode,
    filterOverride?: SessionFilterQuery
  ) => {
    const pane = panes.find((item) => item.id === paneId);
    if (!pane) {
      return;
    }
    const sortMode = sortModeOverride ?? sessionPickerSortMode;
    const sortArgs = sessionSortArgs(sortMode);
    const filterQuery =
      filterOverride ??
      parseSessionFilterQuery(
        sessionPickerTimeFrom,
        sessionPickerTimeTo,
        sessionPickerRecordsMin,
        sessionPickerRecordsMax
      );
    const cacheKey = sessionPickerCacheKey(paneId, filterQuery);
    const keepPickerState = sessionPickerOpen && sessionPickerPaneId === paneId;
    const preferredSids = parseSessionIdList(pane.native_session_id);
    const preferredSid = preferredSids[0] ?? sessionPickerSelectedSid.trim();
    setSessionPickerOpen(true);
    setSessionPickerPaneId(paneId);
    setSessionPickerProvider(pane.provider);
    setSessionPickerIndexProgress(null);
    if (sortModeOverride) {
      setSessionPickerSortMode(sortModeOverride);
    }

    const ttlMs = Math.max(0, sessionListCacheTtlSecs) * 1000;
    const cached = sessionPickerListCacheRef.current.get(cacheKey);
    const cacheValid =
      Boolean(cached) &&
      (ttlMs > 0 ? Date.now() - (cached?.loaded_at_ms ?? 0) <= ttlMs : false);
    if (cacheValid && cached) {
      const sorted = sortSessionCandidates(cached.items, sortMode);
      const available = new Set(sorted.map((item) => item.session_id));
      const selected =
        preferredSids.find((sid) => available.has(sid)) ||
        (keepPickerState && available.has(sessionPickerSelectedSid) ? sessionPickerSelectedSid : "") ||
        sorted[0]?.session_id ||
        preferredSid;
      setSessionPickerItems(sorted);
      setSessionPickerTotal(sorted.length);
      setSessionPickerHasMore(false);
      setSessionPickerError("");
      setSessionPickerLoading(false);
      setSessionPickerLoadingMore(false);
      setSessionPickerAutoLoading(false);
      setSessionPickerSelectedSid(selected);
      if (!keepPickerState) {
        setSessionPickerCheckedSids([]);
        setSessionPickerManualSid("");
        setSessionPickerPreviewRows([]);
        setSessionPickerPreviewLimit(SESSION_PREVIEW_PAGE);
        setSessionPickerPreviewTotal(0);
        setSessionPickerPreviewHasMore(false);
        setSessionPickerPreviewError("");
        setSessionPickerPreviewLoading(false);
      }
      if (selected && (!keepPickerState || selected !== sessionPickerSelectedSid)) {
        void loadSessionPreview(paneId, selected, {
          limit: SESSION_PREVIEW_PAGE
        });
      }
      return;
    }

    setSessionPickerItems([]);
    setSessionPickerTotal(0);
    setSessionPickerHasMore(false);
    setSessionPickerError("");
    setSessionPickerLoading(true);
    setSessionPickerLoadingMore(false);
    setSessionPickerAutoLoading(false);
    setSessionPickerSelectedSid(preferredSid);
    if (!keepPickerState) {
      setSessionPickerCheckedSids([]);
      setSessionPickerManualSid("");
      setSessionPickerPreviewRows([]);
      setSessionPickerPreviewLimit(SESSION_PREVIEW_PAGE);
      setSessionPickerPreviewTotal(0);
      setSessionPickerPreviewHasMore(false);
      setSessionPickerPreviewError("");
      setSessionPickerPreviewLoading(false);
    }

    const ticket = sessionPickerListTicketRef.current + 1;
    sessionPickerListTicketRef.current = ticket;
    try {
      const response = await invoke<NativeSessionListResponse>("list_native_session_candidates", {
        paneId,
        offset: 0,
        limit: SESSION_PICKER_INITIAL_PAGE_SIZE,
        timeFrom: filterQuery.timeFrom,
        timeTo: filterQuery.timeTo,
        recordsMin: filterQuery.recordsMin,
        recordsMax: filterQuery.recordsMax,
        sortBy: sortArgs.sortBy,
        sortOrder: sortArgs.sortOrder
      });
      if (sessionPickerListTicketRef.current !== ticket) {
        return;
      }
      const items = response.items;
      const available = new Set(items.map((item) => item.session_id));
      const selected =
        preferredSids.find((sid) => available.has(sid)) ?? items[0]?.session_id ?? preferredSid;
      setSessionPickerItems(items);
      setSessionPickerTotal(response.total);
      setSessionPickerHasMore(response.has_more);
      setSessionPickerSelectedSid(selected);
      if (selected) {
        void loadSessionPreview(paneId, selected, {
          limit: SESSION_PREVIEW_PAGE
        });
      }
      if (response.has_more) {
        void autoLoadRemainingSessionCandidates(
          paneId,
          ticket,
          sortMode,
          filterQuery,
          response.items.length,
          items,
          cacheKey
        );
      } else {
        sessionPickerListCacheRef.current.set(cacheKey, {
          loaded_at_ms: Date.now(),
          items
        });
      }
    } catch (error) {
      if (sessionPickerListTicketRef.current !== ticket) {
        return;
      }
      console.error(error);
      const detail = error instanceof Error ? error.message : String(error);
      setSessionPickerError(detail);
    } finally {
      if (sessionPickerListTicketRef.current === ticket) {
        setSessionPickerLoading(false);
      }
    }
  };

  const loadMoreSessionCandidates = async () => {
    if (
      !sessionPickerOpen ||
      !sessionPickerPaneId ||
      sessionPickerLoadingMore ||
      sessionPickerAutoLoading ||
      !sessionPickerHasMore
    ) {
      return;
    }
    const sortArgs = sessionSortArgs(sessionPickerSortMode);
    const filterQuery = parseSessionFilterQuery(
      sessionPickerTimeFrom,
      sessionPickerTimeTo,
      sessionPickerRecordsMin,
      sessionPickerRecordsMax
    );
    const cacheKey = sessionPickerCacheKey(sessionPickerPaneId, filterQuery);
    setSessionPickerLoadingMore(true);
    setSessionPickerError("");

    const ticket = sessionPickerListTicketRef.current + 1;
    sessionPickerListTicketRef.current = ticket;
    const offset = sessionPickerItems.length;

    try {
      const response = await invoke<NativeSessionListResponse>("list_native_session_candidates", {
        paneId: sessionPickerPaneId,
        offset,
        limit: SESSION_PICKER_PAGE_SIZE,
        timeFrom: filterQuery.timeFrom,
        timeTo: filterQuery.timeTo,
        recordsMin: filterQuery.recordsMin,
        recordsMax: filterQuery.recordsMax,
        sortBy: sortArgs.sortBy,
        sortOrder: sortArgs.sortOrder
      });
      if (sessionPickerListTicketRef.current !== ticket) {
        return;
      }
      let mergedItems: NativeSessionCandidate[] = [];
      setSessionPickerItems((current) => {
        const seen = new Set(current.map((item) => item.session_id));
        const appended = response.items.filter((item) => !seen.has(item.session_id));
        mergedItems = [...current, ...appended];
        return mergedItems;
      });
      setSessionPickerTotal(response.total);
      setSessionPickerHasMore(response.has_more);
      if (!response.has_more && mergedItems.length > 0) {
        sessionPickerListCacheRef.current.set(cacheKey, {
          loaded_at_ms: Date.now(),
          items: mergedItems
        });
      }
    } catch (error) {
      if (sessionPickerListTicketRef.current !== ticket) {
        return;
      }
      console.error(error);
      const detail = error instanceof Error ? error.message : String(error);
      setSessionPickerError(detail);
    } finally {
      if (sessionPickerListTicketRef.current === ticket) {
        setSessionPickerLoadingMore(false);
      }
    }
  };

  const selectSessionCandidate = (sessionId: string) => {
    if (!sessionPickerPaneId) {
      return;
    }
    setSessionPickerSelectedSid(sessionId);
    setSessionPickerPreviewLimit(SESSION_PREVIEW_PAGE);
    void loadSessionPreview(sessionPickerPaneId, sessionId, {
      limit: SESSION_PREVIEW_PAGE
    });
  };

  const toggleSessionCandidateChecked = (sessionId: string) => {
    setSessionPickerCheckedSids((current) => {
      if (current.includes(sessionId)) {
        return current.filter((sid) => sid !== sessionId);
      }
      return [...current, sessionId];
    });
  };

  const selectAllVisibleSessionCandidates = () => {
    setSessionPickerCheckedSids((current) => {
      const merged = mergeSessionIdLists(
        current,
        sessionPickerItems.map((item) => item.session_id)
      );
      return merged;
    });
  };

  const clearSessionPickerSelections = () => {
    setSessionPickerCheckedSids([]);
    setSessionPickerManualSid("");
  };

  const loadMoreSessionPreview = () => {
    const sid = sessionPickerSelectedSid.trim();
    if (!sessionPickerPaneId || !sid || sessionPickerPreviewLoading || !sessionPickerPreviewHasMore) {
      return;
    }
    const nextLimit = clamp(sessionPickerPreviewLimit + SESSION_PREVIEW_PAGE, 1, 5000);
    void loadSessionPreview(sessionPickerPaneId, sid, {
      limit: nextLimit
    });
  };

  const loadAllSessionPreview = () => {
    const sid = sessionPickerSelectedSid.trim();
    if (!sessionPickerPaneId || !sid || sessionPickerPreviewLoading || !sessionPickerPreviewHasMore) {
      return;
    }
    void loadSessionPreview(sessionPickerPaneId, sid, {
      loadAll: true
    });
  };

  const applySessionPickerFilters = () => {
    if (!sessionPickerPaneId) {
      return;
    }
    const filterQuery = parseSessionFilterQuery(
      sessionPickerTimeFrom,
      sessionPickerTimeTo,
      sessionPickerRecordsMin,
      sessionPickerRecordsMax
    );
    void openSessionPicker(sessionPickerPaneId, sessionPickerSortMode, filterQuery);
  };

  const resetSessionPickerFilters = () => {
    if (!sessionPickerPaneId) {
      return;
    }
    setSessionPickerTimeFrom("");
    setSessionPickerTimeTo("");
    setSessionPickerRecordsMin("");
    setSessionPickerRecordsMax("");
    void openSessionPicker(sessionPickerPaneId, sessionPickerSortMode, {
      timeFrom: null,
      timeTo: null,
      recordsMin: null,
      recordsMax: null
    });
  };

  const handleSessionPickerFilterEnter = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    applySessionPickerFilters();
  };

  const applySessionPickerSid = () => {
    const mergedSessionIds =
      sessionPickerMergedSids.length > 0
        ? sessionPickerMergedSids
        : sessionPickerSelectedSid.trim()
          ? [sessionPickerSelectedSid.trim()]
          : [];
    const sid = formatSessionIdList(mergedSessionIds);
    if (!sessionPickerPaneId) {
      return;
    }
    setPanes((current) =>
      current.map((row) =>
        row.id === sessionPickerPaneId
          ? {
              ...row,
              native_session_id: sid
            }
          : row
      )
    );
    closeSessionPicker();
  };

  const runProviderPrompt = async (paneId: string) => {
    const pane = panes.find((item) => item.id === paneId);
    if (!pane) {
      return;
    }
    const prompt = pane.prompt_input.trim();
    if (!prompt || pane.sending_prompt) {
      return;
    }

    setPanes((current) =>
      current.map((row) => (row.id === paneId ? { ...row, sending_prompt: true } : row))
    );

    try {
      const response = await invoke<ProviderPromptResponse>("run_provider_prompt", {
        paneId,
        prompt
      });
      markPipelineEdge(
        "adapter_model",
        response.mode === "error" ? "error" : "ok",
        `${pane.provider} 模型执行模式：${response.mode}`
      );

      setPanes((current) =>
        current.map((row) => {
          if (row.id !== paneId) {
            return row;
          }
          const existingIds = new Set(row.entries.map((entry) => entry.id));
          const incoming = [response.input, response.output].filter(
            (entry) => !existingIds.has(entry.id)
          );
          return {
            ...row,
            prompt_input: "",
            sending_prompt: false,
            last_mode: response.mode,
            entries: mergeUniqueEntries(row.entries, incoming),
            total_records: row.total_records + incoming.length,
            loaded_count: row.loaded_count + incoming.length
          };
        })
      );
    } catch (error) {
      console.error(error);
      const detail = error instanceof Error ? error.message : String(error);
      markPipelineEdge("adapter_model", "error", `${pane.provider} 执行失败：${detail}`);
      setPanes((current) =>
        current.map((row) => (row.id === paneId ? { ...row, sending_prompt: false } : row))
      );
      window.alert("执行失败，请检查 Provider CLI 登录状态和命令支持。");
    }
  };

  const runTeamPrompt = async (paneId: string, executorProvider: Provider) => {
    const pane = panes.find((item) => item.id === paneId);
    if (!pane) {
      return;
    }
    const prompt = pane.prompt_input.trim();
    if (!prompt || pane.sending_prompt) {
      return;
    }

    setPanes((current) =>
      current.map((row) => (row.id === paneId ? { ...row, sending_prompt: true } : row))
    );

    try {
      const response = await invoke<ProviderPromptResponse>("run_team_prompt", {
        paneId,
        executorProvider,
        prompt
      });
      markPipelineEdge(
        "adapter_model",
        response.mode.includes("error") ? "error" : "ok",
        `团队代理 ${executorProvider} 模式：${response.mode}`
      );

      setPanes((current) =>
        current.map((row) => {
          if (row.id !== paneId) {
            return row;
          }
          const existingIds = new Set(row.entries.map((entry) => entry.id));
          const incoming = [response.input, response.output].filter(
            (entry) => !existingIds.has(entry.id)
          );
          return {
            ...row,
            prompt_input: "",
            sending_prompt: false,
            last_mode: response.mode,
            entries: mergeUniqueEntries(row.entries, incoming),
            total_records: row.total_records + incoming.length,
            loaded_count: row.loaded_count + incoming.length
          };
        })
      );
    } catch (error) {
      console.error(error);
      const detail = error instanceof Error ? error.message : String(error);
      markPipelineEdge("adapter_model", "error", `团队代理 ${executorProvider} 失败：${detail}`);
      setPanes((current) =>
        current.map((row) => (row.id === paneId ? { ...row, sending_prompt: false } : row))
      );
      window.alert("团队代理调用失败，请检查目标 Provider CLI 登录状态和命令支持。");
    }
  };

  const importNativeLogs = useCallback(
    async (
      paneId: string,
      options?: {
        enableAuto?: boolean;
        silent?: boolean;
      }
    ) => {
      const pane = panes.find((item) => item.id === paneId);
      if (!pane || pane.importing_logs || pane.clearing_history) {
        return;
      }
      if (pane.auto_import_circuit_open && options?.silent) {
        return;
      }

      const refreshLimit = Math.max(pane.loaded_count, PAGE_SIZE);
      setPanes((current) =>
        current.map((row) =>
          row.id === paneId
            ? {
                ...row,
                importing_logs: true,
                ...(options?.enableAuto
                  ? {
                      auto_import_circuit_open: false,
                      consecutive_parse_errors: 0
                    }
                  : {})
              }
            : row
        )
      );
      markPipelineEdge("log_import", "ok", `触发 ${pane.provider} 导入任务`);

      try {
        const requestedSessionIds = parseSessionIdList(pane.native_session_id);
        const summary = await invoke<NativeImportResult>("import_native_history", {
          paneId,
          sessionId: requestedSessionIds.length === 1 ? requestedSessionIds[0] : null,
          sessionIds: requestedSessionIds.length ? requestedSessionIds : null
        });
        const [entries, totalRecords] = await Promise.all([
          invoke<EntryRecord[]>("list_entries", {
            paneId,
            query: null,
            limit: refreshLimit,
            offset: 0
          }),
          invoke<number>("count_entries", {
            paneId,
            query: null
          })
        ]);

        const cleanEntries = entries.map((entry) => ({
          ...entry,
          content: cleanHistoryText(entry.content)
        }));
        const parseOnlyError = summary.parse_errors > 0 && summary.imported === 0;
        const importedStatus: PipelineStatus =
          summary.imported > 0 ? "ok" : summary.parse_errors > 0 ? "warn" : "warn";
        const importedSessionIds =
          summary.session_ids?.length
            ? mergeSessionIdLists(summary.session_ids, [])
            : parseSessionIdList(summary.session_id);
        for (const key of Array.from(sessionPickerListCacheRef.current.keys())) {
          if (key.startsWith(`${paneId}::`)) {
            sessionPickerListCacheRef.current.delete(key);
          }
        }
        const sidSummaryText = importedSessionIds.length
          ? importedSessionIds.length <= 2
            ? importedSessionIds.join(", ")
            : `${importedSessionIds[0]}, ${importedSessionIds[1]} 等 ${importedSessionIds.length} 个`
          : summary.session_id;
        let nextConsecutive = 0;
        let breakerOpened = false;

        setPanes((current) =>
          current.map((row) =>
            row.id === paneId
              ? {
                  ...row,
                  importing_logs: false,
                  auto_import_enabled: (() => {
                    const requestedAuto = row.auto_import_enabled || Boolean(options?.enableAuto);
                    const candidateConsecutive = parseOnlyError ? row.consecutive_parse_errors + 1 : 0;
                    const shouldBreak = Boolean(options?.silent) &&
                      candidateConsecutive >= AUTO_IMPORT_BREAKER_THRESHOLD;
                    nextConsecutive = candidateConsecutive;
                    breakerOpened = shouldBreak;
                    return shouldBreak ? false : requestedAuto;
                  })(),
                  consecutive_parse_errors: parseOnlyError ? row.consecutive_parse_errors + 1 : 0,
                  auto_import_circuit_open:
                    Boolean(options?.silent) &&
                    parseOnlyError &&
                    row.consecutive_parse_errors + 1 >= AUTO_IMPORT_BREAKER_THRESHOLD,
                  native_session_id: importedSessionIds.length
                    ? formatSessionIdList(importedSessionIds)
                    : summary.session_id,
                  last_import_summary: [
                    `${summary.provider} sid ${sidSummaryText} | +${summary.imported}, skip ${summary.skipped}, parse_err ${summary.parse_errors}`,
                    parseOnlyError
                      ? `连续解析异常 ${row.consecutive_parse_errors + 1}/${AUTO_IMPORT_BREAKER_THRESHOLD}`
                      : "",
                    Boolean(options?.silent) &&
                    parseOnlyError &&
                    row.consecutive_parse_errors + 1 >= AUTO_IMPORT_BREAKER_THRESHOLD
                      ? "自动刷新已熔断，请手动导入确认后再开启自动"
                      : ""
                  ]
                    .filter((item) => item.length > 0)
                    .join(" | "),
                  entries: cleanEntries,
                  loaded_count: cleanEntries.length,
                  total_records: totalRecords
                }
              : row
          )
        );
        markPipelineEdge(
          "log_import",
          breakerOpened ? "warn" : "ok",
          breakerOpened
            ? `${summary.provider} 自动导入已熔断（连续解析异常 ${nextConsecutive} 次）`
            : `${summary.provider} 导入完成（sid=${sidSummaryText}）`
        );
        markPipelineEdge(
          "import_store",
          importedStatus,
          `入库 +${summary.imported}, skip ${summary.skipped}, parse_err ${summary.parse_errors}`
        );
      } catch (error) {
        console.error(error);
        const detail = error instanceof Error ? error.message : String(error);
        setPanes((current) =>
          current.map((row) => (row.id === paneId ? { ...row, importing_logs: false } : row))
        );
        markPipelineEdge("log_import", "error", `${pane.provider} 导入失败：${detail}`);
        markPipelineEdge("import_store", "error", `${pane.provider} 入库失败：${detail}`);
        if (!options?.silent) {
          window.alert(`导入 ${pane.provider} 日志失败，请检查本地会话目录和日志文件。`);
        }
      }
    },
    [markPipelineEdge, panes]
  );

  useEffect(() => {
    const targets = panes.filter((pane) => pane.auto_import_enabled && !pane.auto_import_circuit_open);
    if (!targets.length) {
      return;
    }

    const timer = window.setInterval(() => {
      for (const pane of targets) {
        void importNativeLogs(pane.id, { silent: true });
      }
    }, AUTO_IMPORT_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [importNativeLogs, panes]);

  const downloadMarkdown = (content: string) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `ai-shell-history-${stamp}.md`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const clearAllHistory = async () => {
    if (clearing) {
      return;
    }
    const confirmed = window.confirm("确认清空全部会话历史？此操作不可撤销。");
    if (!confirmed) {
      return;
    }
    const exportFirst = window.confirm(
      "清空前是否先导出 Markdown 历史？\n确定 = 先导出，取消 = 直接清空。"
    );

    setClearing(true);
    try {
      if (exportFirst) {
        const markdown = await invoke<string>("export_all_history_markdown");
        downloadMarkdown(markdown);
      }
      for (const paneId of Array.from(terminalsRef.current.keys())) {
        disposeTerminal(paneId);
      }
      await invoke<void>("clear_all_history");
      setPanes([]);
    } catch (error) {
      console.error(error);
      window.alert("清空历史失败，请查看日志后重试。");
    } finally {
      setClearing(false);
    }
  };

  const clearPaneHistory = async (paneId: string) => {
    const pane = panes.find((item) => item.id === paneId);
    if (!pane || pane.clearing_history) {
      return;
    }
    const paneTitle = pane.title || asTitle(pane.provider);
    const confirmed = window.confirm(`确认清空 ${paneTitle} 的历史记录？此操作不可撤销。`);
    if (!confirmed) {
      return;
    }

    setPanes((current) =>
      current.map((row) => (row.id === paneId ? { ...row, clearing_history: true } : row))
    );
    try {
      await invoke<void>("clear_pane_history", { paneId });
      setPanes((current) =>
        current.map((row) =>
          row.id === paneId
            ? {
                ...row,
                entries: [],
                selected_ids: [],
                total_records: 0,
                loaded_count: 0,
                loading_more: false,
                clearing_history: false,
                auto_import_enabled: false,
                native_session_id: "",
                sid_detect_highlight: false,
                last_import_summary: "本窗历史已清空",
                consecutive_parse_errors: 0,
                auto_import_circuit_open: false,
                last_sync_note: "",
                last_sync_raw_payload: "",
                show_sync_raw_payload: false,
                last_sync_was_compressed: false
              }
            : row
        )
      );
    } catch (error) {
      console.error(error);
      setPanes((current) =>
        current.map((row) => (row.id === paneId ? { ...row, clearing_history: false } : row))
      );
      window.alert(`清空 ${pane.provider} 窗格历史失败，请查看日志后重试。`);
    }
  };

  const showLogPath = async () => {
    if (!logPath) {
      window.alert("日志路径不可用。");
      return;
    }
    try {
      await navigator.clipboard.writeText(logPath);
      window.alert(`已复制日志路径：\n${logPath}`);
    } catch {
      window.alert(`日志路径：\n${logPath}`);
    }
  };

  const closePane = async (paneId: string) => {
    await invoke<void>("close_pane", { paneId });
    disposeTerminal(paneId);
    setActivePaneId((current) =>
      current === paneId ? panes.find((pane) => pane.id !== paneId)?.id ?? "" : current
    );
    setPanes((current) => {
      const next = current.filter((pane) => pane.id !== paneId);
      return next.map((pane) =>
        pane.target_pane_id === paneId ? { ...pane, target_pane_id: "" } : pane
      );
    });
  };

  const loadMoreHistory = async (paneId: string) => {
    const pane = panes.find((item) => item.id === paneId);
    if (!pane) {
      return;
    }
    if (pane.loading_more || pane.loaded_count >= pane.total_records) {
      return;
    }

    setPanes((current) =>
      current.map((row) => (row.id === paneId ? { ...row, loading_more: true } : row))
    );

    try {
      const more = await invoke<EntryRecord[]>("list_entries", {
        paneId,
        query: null,
        limit: PAGE_SIZE,
        offset: pane.loaded_count
      });

      setPanes((current) =>
        current.map((row) => {
          if (row.id !== paneId) {
            return row;
          }
          const merged = mergeUniqueEntries(row.entries, more);
          return {
            ...row,
            entries: merged,
            loaded_count: row.loaded_count + more.length,
            loading_more: false
          };
        })
      );
    } catch (error) {
      console.error(error);
      setPanes((current) =>
        current.map((row) => (row.id === paneId ? { ...row, loading_more: false } : row))
      );
    }
  };

  const syncSelection = async (
    sourcePaneId: string,
    overrideEntries?: EntryRecord[],
    preset?: SyncQuickPreset
  ) => {
    const sourcePane = panes.find((pane) => pane.id === sourcePaneId);
    if (!sourcePane || !sourcePane.target_pane_id) {
      return;
    }
    if (!overrideEntries?.length && !sourcePane.selected_ids.length) {
      return;
    }

    const targetPane = panes.find((pane) => pane.id === sourcePane.target_pane_id);
    if (!targetPane) {
      return;
    }
    const selectedSet = new Set(sourcePane.selected_ids);
    const selectedEntriesOrdered = overrideEntries?.length
      ? orderEntriesInputFirst(overrideEntries)
      : orderEntriesInputFirst(sourcePane.entries.filter((entry) => selectedSet.has(entry.id)));
    if (!selectedEntriesOrdered.length) {
      return;
    }

    const presetNote = preset ? `快捷同步[${quickPresetLabel(preset)}] | ` : "";
    const applyProviderSpecificFilter =
      sourcePane.provider.trim().toLowerCase() !== targetPane.provider.trim().toLowerCase();
    const selectedEntries = applyProviderSpecificFilter
      ? selectedEntriesOrdered.filter((entry) => !isProviderSpecificInstructionBlock(entry.content))
      : selectedEntriesOrdered;
    const skippedProviderSpecificCount = selectedEntriesOrdered.length - selectedEntries.length;
    markPipelineEdge(
      "compress_filter",
      skippedProviderSpecificCount > 0 ? "warn" : "ok",
      skippedProviderSpecificCount > 0
        ? `跨模型过滤专有指令 ${skippedProviderSpecificCount} 条`
        : "过滤阶段无额外剔除"
    );
    if (!selectedEntries.length) {
      const skipNote = `${presetNote}同步已拦截：所选内容均为模型专有指令`;
      setPanes((current) =>
        current.map((pane) =>
          pane.id === sourcePaneId
            ? {
                ...pane,
                selected_ids: [],
                last_sync_note: skipNote,
                last_sync_raw_payload: selectedEntriesOrdered.map((entry) => entry.content).join("\n\n"),
                show_sync_raw_payload: false,
                last_sync_was_compressed: false
              }
            : pane
        )
      );
      return;
    }

    const packed = composeSyncPayload(selectedEntries, {
      enabled: syncCompressEnabled,
      tokenWaterline: syncTokenWaterline,
      turnWaterline: syncTurnWaterline,
      maxChars: syncMaxChars,
      summaryChars: syncSummaryChars,
      keepRecentMessages: DEFAULT_SYNC_RECENT_MESSAGES
    });
    markPipelineEdge(
      "store_compress",
      "ok",
      packed.compressed ? `触发压缩：${packed.triggerReason}` : "未触发压缩（直接发送）"
    );

    const payload = packed.payload;
    const sourceId = selectedEntries[0].id;
    let syncNote = packed.compressed
      ? `同步已压缩（${packed.triggerReason}）：${packed.originalChars} 字符 / 约 ${packed.originalTokens} tokens -> ${packed.compressedChars} 字符`
      : `同步已发送：${packed.compressedChars} 字符 / 约 ${packed.originalTokens} tokens`;
    if (skippedProviderSpecificCount > 0) {
      syncNote += ` | 已跳过专有指令：${skippedProviderSpecificCount} 条`;
    }
    syncNote = `${presetNote}${syncNote}`;

    try {
      await invoke<boolean>("ensure_pane_runtime", { paneId: sourcePane.target_pane_id });
      await invoke<void>("send_to_pane", {
        paneId: sourcePane.target_pane_id,
        input: payload
      });
      const synced = await invoke<EntryRecord>("append_entry", {
        paneId: sourcePane.target_pane_id,
        kind: "input",
        content: payload,
        syncedFrom: sourceId
      });
      markPipelineEdge(
        "filter_adapter",
        "ok",
        `${sourcePane.provider} -> ${targetPane.provider} 已发送 ${packed.compressedChars} 字符`
      );
      markPipelineEdge(
        "adapter_model",
        "ok",
        `${targetPane.provider} 收到同步输入（${packed.compressedChars} 字符）`
      );

      setPanes((current) =>
        current.map((pane) => {
          if (pane.id === sourcePaneId) {
            return {
              ...pane,
              selected_ids: [],
              last_sync_note: syncNote,
              last_sync_raw_payload: packed.originalPayload,
              show_sync_raw_payload: false,
              last_sync_was_compressed: packed.compressed
            };
          }
          if (pane.id === sourcePane.target_pane_id) {
            const exists = pane.entries.some((entry) => entry.id === synced.id);
            if (exists) {
              return pane;
            }
            return {
              ...pane,
              entries: mergeUniqueEntries(pane.entries, [synced]),
              total_records: pane.total_records + 1,
              loaded_count: pane.loaded_count + 1
            };
          }
          return pane;
        })
      );
    } catch (error) {
      console.error(error);
      const detail = error instanceof Error ? error.message : String(error);
      markPipelineEdge("filter_adapter", "error", `同步写入失败：${detail}`);
      setPanes((current) =>
        current.map((pane) =>
          pane.id === sourcePaneId
            ? {
                ...pane,
                selected_ids: [],
                last_sync_note: `${presetNote}同步失败：${detail}`,
                last_sync_raw_payload: packed.originalPayload,
                show_sync_raw_payload: false,
                last_sync_was_compressed: packed.compressed
              }
            : pane
        )
      );
    }
  };

  const quickSyncSelection = async (sourcePaneId: string, preset: SyncQuickPreset) => {
    const sourcePane = panes.find((pane) => pane.id === sourcePaneId);
    if (!sourcePane) {
      return;
    }
    if (!sourcePane.target_pane_id) {
      setPanes((current) =>
        current.map((pane) =>
          pane.id === sourcePaneId
            ? { ...pane, last_sync_note: `快捷同步[${quickPresetLabel(preset)}] 请先选择目标窗格` }
            : pane
        )
      );
      return;
    }
    const selectedEntries = pickEntriesByPreset(sourcePane.entries, preset);
    if (!selectedEntries.length) {
      setPanes((current) =>
        current.map((pane) =>
          pane.id === sourcePaneId
            ? { ...pane, last_sync_note: `快捷同步[${quickPresetLabel(preset)}] 无可用内容` }
            : pane
        )
      );
      return;
    }
    await syncSelection(sourcePaneId, selectedEntries, preset);
  };

  const sendByScope = async (sourcePaneId: string) => {
    const sourcePane = panes.find((pane) => pane.id === sourcePaneId);
    if (!sourcePane) {
      return;
    }
    if (sourcePane.sync_scope === "selected") {
      await syncSelection(sourcePaneId);
      return;
    }
    await quickSyncSelection(sourcePaneId, sourcePane.sync_scope);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || !event.shiftKey || event.metaKey || event.altKey) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target) {
        const tagName = target.tagName.toLowerCase();
        if (
          target.isContentEditable ||
          tagName === "input" ||
          tagName === "textarea" ||
          tagName === "select"
        ) {
          return;
        }
      }

      const paneId = activePaneId || panes[0]?.id;
      if (!paneId) {
        return;
      }

      let preset: SyncQuickPreset | null = null;
      if (event.code === "Digit1") {
        preset = "turn-1";
      } else if (event.code === "Digit3") {
        preset = "turn-3";
      } else if (event.code === "Digit5") {
        preset = "turn-5";
      } else if (event.code === "Digit0") {
        preset = "latest-qa";
      } else if (event.code === "Digit9") {
        preset = "all";
      }
      if (!preset) {
        return;
      }
      event.preventDefault();
      void quickSyncSelection(paneId, preset);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    activePaneId,
    panes,
    syncCompressEnabled,
    syncTokenWaterline,
    syncTurnWaterline,
    syncMaxChars,
    syncSummaryChars
  ]);

  const filteredEntries = useCallback(
    (pane: PaneView): EntryRecord[] => {
      const normalized = query.trim().toLowerCase();
      if (!normalized) {
        return pane.entries;
      }
      return pane.entries.filter((entry) => entry.content.toLowerCase().includes(normalized));
    },
    [query]
  );

  const allPanesFocused = useMemo(
    () => panes.length > 0 && panes.every((pane) => pane.focus_terminal),
    [panes]
  );
  const toggleAllPaneFocus = () => {
    const nextFocused = !allPanesFocused;
    setPanes((current) => current.map((pane) => ({ ...pane, focus_terminal: nextFocused })));
  };

  const gridStyle =
    layout === "vertical"
      ? {
          gridTemplateColumns: `repeat(${Math.max(panes.length, 1)}, minmax(320px, 1fr))`,
          gridTemplateRows: "minmax(0, 1fr)"
        }
      : {
          gridTemplateColumns: "minmax(0, 1fr)",
          gridTemplateRows: `repeat(${Math.max(panes.length, 1)}, minmax(0, 1fr))`
        };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="left-actions">
          {availableProviders.map((provider) => (
            <button key={provider} onClick={() => addPane(provider)}>
              + {asTitle(provider)}
            </button>
          ))}
        </div>
        <div className="center-actions">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索所有窗格中的历史..."
          />
        </div>
        <div className="right-actions">
          <button className={showConfigMenu ? "active" : ""} onClick={() => setShowConfigMenu((v) => !v)}>
            {showConfigMenu ? "返回主界面" : "配置"}
          </button>
          <button onClick={showLogPath} disabled={!logPath}>
            日志
          </button>
          <button className={showFlowMap ? "active" : ""} onClick={() => setShowFlowMap((v) => !v)}>
            链路图
          </button>
          <button className="danger-btn" onClick={clearAllHistory} disabled={clearing}>
            {clearing ? "清空中..." : "清空全部"}
          </button>
          <button
            className={layout === "vertical" ? "active" : ""}
            onClick={() => setLayout("vertical")}
          >
            竖排
          </button>
          <button
            className={layout === "horizontal" ? "active" : ""}
            onClick={() => setLayout("horizontal")}
          >
            横排
          </button>
          <button
            className={allPanesFocused ? "active" : ""}
            onClick={toggleAllPaneFocus}
            disabled={!panes.length}
            title={allPanesFocused ? "退出全局聚焦（全部窗格）" : "一键聚焦全部窗格终端"}
          >
            {allPanesFocused ? "退出全局聚焦" : "全局聚焦"}
          </button>
        </div>
      </header>

      {showConfigMenu ? (
        <main className="settings-page">
          <section className="settings-card">
            <div className="settings-card-head">
              <strong>配置管理</strong>
              <small>配置文件：{configPath || "(初始化中...)"}</small>
            </div>
            <div className="config-row">
              <label className="compact-field workdir-field">
                工作目录
                <input
                  type="text"
                  value={workingDirectory}
                  placeholder="留空=默认目录"
                  onChange={(event) => setWorkingDirectory(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void applyWorkingDirectory();
                    }
                  }}
                />
              </label>
              <button onClick={() => void pickWorkingDirectory()}>选择目录</button>
              <button onClick={() => void applyWorkingDirectory()} disabled={applyingWorkingDirectory}>
                {applyingWorkingDirectory ? "保存中..." : "保存并应用"}
              </button>
              <button
                onClick={() => {
                  void applyWorkingDirectory({ pathOverride: "" });
                }}
                disabled={applyingWorkingDirectory}
              >
                恢复默认
              </button>
            </div>
            <div className="settings-actions">
              <label className="compact-field">
                会话列表缓存(秒)
                <input
                  type="number"
                  min={0}
                  max={600}
                  value={sessionListCacheTtlSecs}
                  onChange={(event) =>
                    setSessionListCacheTtlSecs(clamp(Number(event.target.value || 0), 0, 600))
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void saveSessionListCacheTtl();
                    }
                  }}
                />
              </label>
              <button onClick={() => void saveSessionListCacheTtl()} disabled={savingSessionListCacheTtl}>
                {savingSessionListCacheTtl ? "保存中..." : "保存缓存设置"}
              </button>
              <small>0=关闭缓存；默认 30 秒。仅缓存会话列表，不缓存会话内容预览。</small>
            </div>
          </section>

          <section className="settings-card">
            <div className="settings-card-head">
              <strong>同步压缩</strong>
              <small>统一管理 Token 节流阀和摘要参数</small>
            </div>
            <div className="settings-actions">
              <button
                className={syncCompressEnabled ? "active" : ""}
                onClick={() => setSyncCompressEnabled((value) => !value)}
              >
                自动压缩
              </button>
              <label className="compact-field">
                Token阈值
                <input
                  type="number"
                  min={800}
                  max={64000}
                  value={syncTokenWaterline}
                  onChange={(event) =>
                    setSyncTokenWaterline(clamp(Number(event.target.value || 0), 800, 64000))
                  }
                />
              </label>
              <label className="compact-field">
                轮次阈值
                <input
                  type="number"
                  min={4}
                  max={200}
                  value={syncTurnWaterline}
                  onChange={(event) =>
                    setSyncTurnWaterline(clamp(Number(event.target.value || 0), 4, 200))
                  }
                />
              </label>
              <label className="compact-field">
                字符上限
                <input
                  type="number"
                  min={1200}
                  max={24000}
                  value={syncMaxChars}
                  onChange={(event) =>
                    setSyncMaxChars(clamp(Number(event.target.value || 0), 1200, 24000))
                  }
                />
              </label>
              <label className="compact-field">
                摘要上限
                <input
                  type="number"
                  min={500}
                  max={12000}
                  value={syncSummaryChars}
                  onChange={(event) =>
                    setSyncSummaryChars(clamp(Number(event.target.value || 0), 500, 12000))
                  }
                />
              </label>
            </div>
          </section>
        </main>
      ) : (
        <>
          {showFlowMap ? (
            <section className="flow-map">
              <div className="flow-map-head">
                <strong>全景链路图（MVP）</strong>
                <small>
                  自动导入保护：静默窗口 {IMPORT_FILE_QUIET_WINDOW_SECONDS}s，连续解析异常{" "}
                  {AUTO_IMPORT_BREAKER_THRESHOLD} 次自动熔断
                </small>
              </div>
              <div className="flow-map-grid">
                {FLOW_EDGE_ORDER.map((edge) => {
                  const stat = pipelineStats[edge.id];
                  return (
                    <article key={edge.id} className={`flow-edge ${stat.lastStatus}`}>
                      <div className="flow-edge-route">
                        {edge.from} -&gt; {edge.to}
                      </div>
                      <small>
                        最近状态：{pipelineStatusText(stat.lastStatus)}{" "}
                        {stat.lastAt > 0 ? `@ ${formatTs(stat.lastAt)}` : ""}
                      </small>
                      <small>{stat.lastNote || "暂无记录"}</small>
                      <small>
                        total {stat.total} | ok {stat.ok} | warn {stat.warn} | err {stat.error}
                      </small>
                    </article>
                  );
                })}
              </div>
            </section>
          ) : null}

          {loading ? (
            <div className="empty-state">正在加载窗格...</div>
          ) : panes.length === 0 ? (
            <div className="empty-state">暂无会话，请从左上角添加窗格。</div>
          ) : (
            <main className={`pane-grid ${layout}`} style={gridStyle}>
              {panes.map((pane) => {
            const history = filteredEntries(pane);
            const hasAnyHistory = pane.entries.length > 0;
            const historyIds = history.map((entry) => entry.id);
            const isAllSelected =
              historyIds.length > 0 && historyIds.every((id) => pane.selected_ids.includes(id));
            const targetPaneTitle =
              panes.find((row) => row.id === pane.target_pane_id)?.title ?? "";
            const canSyncSelection = Boolean(pane.target_pane_id) && pane.selected_ids.length > 0;
            const canSendByScope =
              pane.sync_scope === "selected"
                ? canSyncSelection
                : Boolean(pane.target_pane_id) && pane.entries.length > 0;
            const sendScopeLabel =
              pane.sync_scope === "selected" ? "选中内容" : quickPresetLabel(pane.sync_scope);
            const nativeOpsDisabled = pane.importing_logs || pane.clearing_history;
            const breadcrumbTitle =
              pane.title && pane.title !== asTitle(pane.provider) ? pane.title : "SESSION";

            return (
              <section
                key={pane.id}
                className={`pane ${pane.focus_terminal ? "focus-terminal" : ""} ${
                  activePaneId === pane.id ? "active-pane" : ""
                } ${hasAnyHistory ? "" : "pane-empty-history"}`}
                onMouseDown={() => setActivePaneId(pane.id)}
              >
                <div className="pane-head">
                  <div className="title-group breadcrumb">
                    <span className="breadcrumb-provider">{asTitle(pane.provider)}</span>
                    <span className="breadcrumb-sep">/</span>
                    <span className="breadcrumb-title">{breadcrumbTitle}</span>
                  </div>
                  <div className="status-group">
                    <button
                      className="focus-btn"
                      title={pane.focus_terminal ? "显示面板" : "聚焦终端"}
                      aria-label={pane.focus_terminal ? "显示面板" : "聚焦终端"}
                      onClick={() => {
                        setActivePaneId(pane.id);
                        setPanes((current) =>
                          current.map((row) =>
                            row.id === pane.id
                              ? { ...row, focus_terminal: !row.focus_terminal }
                            : row
                          )
                        );
                      }}
                    >
                      {pane.focus_terminal ? "[]" : "><"}
                    </button>
                    <button
                      className="close-btn"
                      title="关闭窗格"
                      aria-label="关闭窗格"
                      onClick={() => closePane(pane.id)}
                    >
                      x
                    </button>
                  </div>
                </div>

                <div className="terminal-surface">
                  <div className="terminal-mount" ref={(element) => mountTerminal(pane.id, element)} />
                </div>

                <div className="history-tools">
                  <small>
                    visible {history.length} | loaded {pane.loaded_count}/{pane.total_records}
                  </small>
                  <div className="history-actions">
                    <button
                      title="检测 SID"
                      onClick={() => void refreshNativeSessionId(pane.id)}
                      disabled={nativeOpsDisabled}
                    >
                      SID
                    </button>
                    <button
                      title="浏览并选择会话 SID"
                      onClick={() => void openSessionPicker(pane.id)}
                      disabled={nativeOpsDisabled}
                    >
                      会话列表
                    </button>
                    <button
                      title={
                        pane.importing_logs
                          ? "导入中..."
                          : pane.auto_import_enabled
                            ? `导入 ${asTitle(pane.provider)} 日志（自动）`
                            : `导入 ${asTitle(pane.provider)} 日志`
                      }
                      onClick={() => void importNativeLogs(pane.id, { enableAuto: true })}
                      disabled={nativeOpsDisabled}
                    >
                      {pane.importing_logs ? "导入中..." : "导入"}
                    </button>
                    <button
                      title="重新绑定会话"
                      onClick={() => void rebindNativeSession(pane.id)}
                      disabled={nativeOpsDisabled}
                    >
                      Rebind
                    </button>
                    <button
                      title="清理本窗历史"
                      onClick={() => clearPaneHistory(pane.id)}
                      disabled={nativeOpsDisabled}
                    >
                      {pane.clearing_history ? "清理中..." : "清理"}
                    </button>
                    <button
                      onClick={() => loadMoreHistory(pane.id)}
                      disabled={pane.loading_more || pane.loaded_count >= pane.total_records}
                    >
                      {pane.loading_more ? "加载中..." : "加载更多"}
                    </button>
                  </div>
                </div>

                <div className="entries">
                  {history.map((entry) => (
                    <article
                      key={entry.id}
                      className={`entry ${entry.kind} ${
                        pane.selected_ids.includes(entry.id) ? "selected" : ""
                      }`}
                    >
                      <label className="entry-check">
                        <input
                          type="checkbox"
                          checked={pane.selected_ids.includes(entry.id)}
                          onChange={(event) => {
                            const checked = event.target.checked;
                            setPanes((current) =>
                              current.map((row) => {
                                if (row.id !== pane.id) {
                                  return row;
                                }
                                const set = new Set(row.selected_ids);
                                if (checked) {
                                  set.add(entry.id);
                                } else {
                                  set.delete(entry.id);
                                }
                                return { ...row, selected_ids: [...set] };
                              })
                            );
                          }}
                        />
                      </label>
                      <div className="entry-body">
                        <div className="entry-meta">
                          <span>{entry.kind}</span>
                          <span>{formatTs(entry.created_at)}</span>
                        </div>
                        <pre>{entry.content}</pre>
                      </div>
                    </article>
                  ))}
                </div>

                <div className="pane-foot">
                  <div className={`pane-foot-note ${pane.sid_detect_highlight ? "sid-highlight" : ""}`}>
                    Source: <code>{nativeSourceHint(pane.provider)}</code>
                    <div className="session-bind-row">
                      <span>识别 SID</span>
                      <input
                        className="session-id-input"
                        value={pane.native_session_id}
                        placeholder={`点击上方 SID 按钮识别 ${pane.provider} sid`}
                        onChange={(event) =>
                          setPanes((current) =>
                            current.map((row) =>
                              row.id === pane.id
                                ? { ...row, native_session_id: event.target.value.trim() }
                                : row
                            )
                          )
                        }
                      />
                    </div>
                  </div>
                  <div className="pane-foot-actions">
                    <small>
                      {pane.last_import_summary || "原生日志模式（发送首条消息后出现 sid）"}
                    </small>
                    <small>{pane.auto_import_enabled ? "自动刷新：开启" : "自动刷新：关闭"}</small>
                    {pane.auto_import_circuit_open ? (
                      <small className="warn-text">自动刷新：熔断中（请手动导入确认后再开启）</small>
                    ) : null}
                    <small>
                      {pane.sync_scope === "selected"
                        ? canSyncSelection
                          ? "已选择可发送内容（点击下方发送）"
                          : "未选择同步内容（在历史区勾选后点击下方发送）"
                        : `当前同步范围：${quickPresetLabel(pane.sync_scope)}（点击下方发送）`}
                    </small>
                    <select
                      value={pane.sync_scope}
                      onChange={(event) =>
                        setPanes((current) =>
                          current.map((row) =>
                            row.id === pane.id
                              ? { ...row, sync_scope: event.target.value as SyncScope }
                              : row
                          )
                        )
                      }
                    >
                      <option value="selected">同步范围：仅选中内容</option>
                      <option value="turn-1">同步范围：最近1轮</option>
                      <option value="turn-3">同步范围：最近3轮</option>
                      <option value="turn-5">同步范围：最近5轮</option>
                      <option value="latest-qa">同步范围：最新问答</option>
                      <option value="all">同步范围：全部会话</option>
                    </select>
                    <select
                      value={pane.target_pane_id}
                      onChange={(event) =>
                        setPanes((current) =>
                          current.map((row) =>
                            row.id === pane.id
                              ? { ...row, target_pane_id: event.target.value }
                              : row
                          )
                        )
                      }
                    >
                      <option value="">选择目标窗格</option>
                      {paneIds
                        .filter((id) => id !== pane.id)
                        .map((id) => (
                          <option key={id} value={id}>
                            {panes.find((row) => row.id === id)?.title ?? id}
                          </option>
                        ))}
                    </select>
                    <button
                      onClick={() =>
                        setPanes((current) =>
                          current.map((row) =>
                            row.id === pane.id
                              ? {
                                  ...row,
                                  selected_ids: isAllSelected
                                    ? row.selected_ids.filter((id) => !historyIds.includes(id))
                                    : Array.from(new Set([...row.selected_ids, ...historyIds]))
                                }
                              : row
                          )
                        )
                      }
                    >
                      {isAllSelected ? "取消可见" : "选择可见"}
                    </button>
                    <button
                      onClick={() =>
                        setPanes((current) =>
                          current.map((row) =>
                            row.id === pane.id ? { ...row, selected_ids: [] } : row
                          )
                        )
                      }
                    >
                      清空选择
                    </button>
                    <button
                      title={
                        targetPaneTitle
                          ? `发送${sendScopeLabel} -> ${targetPaneTitle}`
                          : `发送${sendScopeLabel}`
                      }
                      onClick={() => void sendByScope(pane.id)}
                      disabled={!canSendByScope || pane.clearing_history}
                    >
                      发送
                    </button>
                    <small>快捷键：Ctrl+Shift+1/3/5/0/9（先点击要作为来源的窗格）</small>
                    <small>
                      {targetPaneTitle
                        ? `方向：${pane.title || asTitle(pane.provider)} -> ${targetPaneTitle}`
                        : "方向：当前窗格 -> 目标窗格"}
                    </small>
                    {pane.last_sync_note ? <small>{pane.last_sync_note}</small> : null}
                  </div>
                </div>
              </section>
            );
              })}
            </main>
          )}
        </>
      )}
      {sessionPickerOpen ? (
        <div
          className="session-picker-overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closeSessionPicker();
            }
          }}
        >
          <section className="session-picker-modal" onMouseDown={(event) => event.stopPropagation()}>
            <div className="session-picker-head">
              <div>
                <strong>{asTitle(sessionPickerProvider)} 会话选择</strong>
                <small>支持多选 SID；手动输入可用换行/逗号/分号分隔，点击“使用并关闭”后生效</small>
              </div>
              <button onClick={closeSessionPicker}>关闭</button>
            </div>

            <div className="session-picker-toolbar">
              <label className="session-picker-custom-field">
                自定义 SID
                <textarea
                  className="session-picker-custom-textarea"
                  value={sessionPickerManualSid}
                  placeholder="支持多行：每行一个 SID，或用逗号/分号分隔"
                  onChange={(event) => setSessionPickerManualSid(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                      event.preventDefault();
                      applySessionPickerSid();
                    }
                  }}
                />
              </label>
              <button onClick={applySessionPickerSid}>使用并关闭</button>
            </div>

            <div className="session-picker-body">
              <section className="session-picker-column">
                <div className="session-picker-column-head">
                  <strong>会话 ID</strong>
                  <small>
                    已加载 {sessionPickerItems.length} / {sessionPickerTotal}
                    {sessionPickerTotal > 0 ? `（${sessionPickerLoadPercent}%）` : ""}
                    {sessionPickerFilterActive ? "（已筛选）" : ""}
                    {" | "}
                    已选 {sessionPickerMergedSids.length} 个
                  </small>
                </div>
                <div className="session-picker-selected-full">
                  <span>待导入 SID（{sessionPickerMergedSids.length}）</span>
                  <code>
                    {sessionPickerMergedSids.length
                      ? formatSessionIdList(sessionPickerMergedSids)
                      : "(未选择)"}
                  </code>
                </div>
                <div className="session-picker-load-progress" aria-hidden="true">
                  <span style={{ width: `${sessionPickerLoadPercent}%` }} />
                </div>
                <div className="session-picker-list-stack">
                  <div className="session-picker-filter-panel">
                    <div className="session-picker-filter-grid">
                      <label className="session-picker-filter-field">
                        排序
                        <select
                          value={sessionPickerSortMode}
                          onChange={(event) => {
                            const next = event.target.value as SessionPickerSortMode;
                            setSessionPickerSortMode(next);
                            if (sessionPickerPaneId) {
                              void openSessionPicker(sessionPickerPaneId, next);
                            }
                          }}
                        >
                          <option value="time_desc">时间：新 -&gt; 旧</option>
                          <option value="time_asc">时间：旧 -&gt; 新</option>
                          <option value="records_desc">记录数：多 -&gt; 少</option>
                          <option value="records_asc">记录数：少 -&gt; 多</option>
                        </select>
                      </label>
                      <label className="session-picker-filter-field">
                        时间从
                        <input
                          type="datetime-local"
                          value={sessionPickerTimeFrom}
                          onChange={(event) => setSessionPickerTimeFrom(event.target.value)}
                          onKeyDown={handleSessionPickerFilterEnter}
                        />
                      </label>
                      <label className="session-picker-filter-field">
                        时间到
                        <input
                          type="datetime-local"
                          value={sessionPickerTimeTo}
                          onChange={(event) => setSessionPickerTimeTo(event.target.value)}
                          onKeyDown={handleSessionPickerFilterEnter}
                        />
                      </label>
                      <label className="session-picker-filter-field">
                        记录数最小
                        <input
                          type="number"
                          min={0}
                          step={1}
                          inputMode="numeric"
                          value={sessionPickerRecordsMin}
                          onChange={(event) => setSessionPickerRecordsMin(event.target.value)}
                          onKeyDown={handleSessionPickerFilterEnter}
                        />
                      </label>
                      <label className="session-picker-filter-field">
                        记录数最大
                        <input
                          type="number"
                          min={0}
                          step={1}
                          inputMode="numeric"
                          value={sessionPickerRecordsMax}
                          onChange={(event) => setSessionPickerRecordsMax(event.target.value)}
                          onKeyDown={handleSessionPickerFilterEnter}
                        />
                      </label>
                    </div>
                    <div className="session-picker-filter-actions">
                      <button
                        onClick={selectAllVisibleSessionCandidates}
                        disabled={sessionPickerLoading || sessionPickerLoadingMore || !sessionPickerItems.length}
                      >
                        全选当前页
                      </button>
                      <button
                        onClick={clearSessionPickerSelections}
                        disabled={sessionPickerLoading || sessionPickerLoadingMore}
                      >
                        清空已选
                      </button>
                      <button
                        onClick={applySessionPickerFilters}
                        disabled={sessionPickerLoading || sessionPickerLoadingMore}
                      >
                        应用筛选
                      </button>
                      <button
                        onClick={resetSessionPickerFilters}
                        disabled={sessionPickerLoading || sessionPickerLoadingMore}
                      >
                        重置
                      </button>
                    </div>
                  </div>
                  {sessionPickerLoading ? (
                    <div className="session-picker-empty">正在加载会话列表...</div>
                  ) : sessionPickerError ? (
                    <div className="session-picker-empty warn-text">{sessionPickerError}</div>
                  ) : sessionPickerItems.length === 0 ? (
                    <div className="session-picker-empty">暂无可用 SID</div>
                  ) : (
                    <div className="session-picker-list">
                      {sessionPickerItems.map((item) => {
                        const picked = sessionPickerCheckedSids.includes(item.session_id);
                        return (
                          <article
                            key={`${item.provider}-${item.session_id}`}
                            className={`session-picker-item ${
                              sessionPickerSelectedSid === item.session_id ? "active" : ""
                            } ${picked ? "picked" : ""}`}
                          >
                            <button
                              className="session-picker-item-preview-btn"
                              onClick={() => selectSessionCandidate(item.session_id)}
                            >
                              <span className="session-picker-item-sid">{shortSessionId(item.session_id)}</span>
                              <small>
                                创建：{item.started_at > 0 ? formatTs(item.started_at) : "未知"}
                              </small>
                              <small>
                                记录：{item.record_count} | 文件：{item.source_files}
                              </small>
                            </button>
                            <div className="session-picker-item-actions">
                              <small>{picked ? "已选中导入" : "未选中导入"}</small>
                              <label className="session-picker-item-check">
                                <input
                                  type="checkbox"
                                  checked={picked}
                                  onChange={() => toggleSessionCandidateChecked(item.session_id)}
                                />
                                <span>{picked ? "取消" : "选中"}</span>
                              </label>
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  )}
                </div>
                <div className="session-picker-foot">
                  {sessionPickerIndexNote ? (
                    <small
                      className={`session-picker-index-progress ${
                        sessionPickerIndexProgress?.running ? "running" : ""
                      }`}
                    >
                      {sessionPickerIndexNote}
                    </small>
                  ) : null}
                  {sessionPickerAutoLoading ? (
                    <small>后台加载中... 已加载 {sessionPickerItems.length} / {sessionPickerTotal}</small>
                  ) : sessionPickerHasMore ? (
                    <button onClick={() => void loadMoreSessionCandidates()} disabled={sessionPickerLoadingMore}>
                      {sessionPickerLoadingMore ? "加载中..." : "加载更多 SID"}
                    </button>
                  ) : (
                    <small>已加载全部 SID</small>
                  )}
                </div>
              </section>

              <section className="session-picker-column">
                <div className="session-picker-column-head">
                  <strong>最近消息预览</strong>
                  <small>
                    {sessionPickerSelectedSid
                      ? `SID: ${sessionPickerSelectedSid}`
                      : "未选择 SID（可先输入自定义 SID）"}
                  </small>
                </div>
                <div className="session-picker-preview-tools">
                  <small>
                    已加载 {sessionPickerPreviewRows.length} / {sessionPickerPreviewTotal}
                  </small>
                  <button
                    onClick={loadMoreSessionPreview}
                    disabled={!sessionPickerPreviewHasMore || sessionPickerPreviewLoading}
                  >
                    加载更多
                  </button>
                  <button
                    onClick={loadAllSessionPreview}
                    disabled={!sessionPickerPreviewHasMore || sessionPickerPreviewLoading}
                  >
                    全部加载
                  </button>
                </div>
                {sessionPickerPreviewLoading ? (
                  <div className="session-picker-empty">正在加载最近消息...</div>
                ) : sessionPickerPreviewError ? (
                  <div className="session-picker-empty warn-text">{sessionPickerPreviewError}</div>
                ) : sessionPickerPreviewRows.length === 0 ? (
                  <div className="session-picker-empty">当前 SID 暂无可预览消息</div>
                ) : (
                  <div className="session-picker-preview">
                    {sessionPickerPreviewRows.map((row, index) => (
                      <article key={`${row.kind}-${row.created_at}-${index}`} className="session-picker-preview-row">
                        <div className="session-picker-preview-meta">
                          <span>{row.kind}</span>
                          <span>{row.created_at > 0 ? formatTs(row.created_at) : "未知时间"}</span>
                        </div>
                        <pre>{row.content}</pre>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

export default App;


