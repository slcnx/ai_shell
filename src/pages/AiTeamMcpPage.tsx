import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Alert,
  Button,
  Card,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Segmented,
  Select,
  Space,
  Switch,
  Tag,
  Typography,
  message,
} from "antd";

import {
  aiTeamClearRoleSid,
  aiTeamCreateTeam,
  aiTeamExecuteNext,
  aiTeamGetSnapshot,
  aiTeamInitializeTeam,
  aiTeamLoadConversation,
  aiTeamSendRoleHello,
  aiTeamSendMessage,
  aiTeamSetRoleSid,
  aiTeamSubmitRequirement,
} from "../lib/aiTeamApi";
import type { AiTeamConversationRow, AiTeamRoleKey, AiTeamRoleSnapshot, AiTeamSnapshot } from "../types/aiTeam";

type LayoutMode = "vertical" | "horizontal";

export type AiTeamWorkbenchHeaderAction = {
  key: string;
  label: string;
  onClick: () => void;
  loading?: boolean;
  disabled?: boolean;
  danger?: boolean;
  primary?: boolean;
};

export type AiTeamWorkbenchHeaderActions = {
  left: AiTeamWorkbenchHeaderAction[];
  right: AiTeamWorkbenchHeaderAction[];
};

type AiTeamMcpPageProps = {
  providers: string[];
  defaultProjectDirectory?: string;
  onOpenCommonSettings: () => void;
  onClose: () => void;
  onSyncPaneSessionState?: (paneId: string) => void;
  onProbePaneSessionId?: (paneId: string) => Promise<string>;
  onHeaderActionsChange?: (actions: AiTeamWorkbenchHeaderActions | null) => void;
};

type AiTeamPageSettings = {
  helloMessage: string;
  bindTimeoutSecs: number;
  autoPollingIntervalSecs: number;
  autoStartPolling: boolean;
  opacityPercent: number;
  lockFloatPosition: boolean;
};

type AiTeamFloatSnap = "free" | "left" | "right" | "top" | "bottom";

type AiTeamFloatState = {
  x: number;
  y: number;
  width: number;
  height: number;
  minimized: boolean;
  snap: AiTeamFloatSnap;
};

const TEAM_STORAGE_KEY = "ai-shell-ai-team-current-id";
const PAGE_SETTINGS_STORAGE_KEY = "ai-shell-ai-team-page-settings";
const FLOAT_PANEL_STORAGE_KEY = "ai-shell-ai-team-float-panel";
const FLOAT_SNAP_THRESHOLD = 24;

const defaultRoleInputs: Record<AiTeamRoleKey, string> = {
  analyst: "",
  coder: "",
};

const defaultConversations: Record<AiTeamRoleKey, AiTeamConversationRow[]> = {
  analyst: [],
  coder: [],
};

const defaultPageSettings: AiTeamPageSettings = {
  helloMessage: "你好",
  bindTimeoutSecs: 20,
  autoPollingIntervalSecs: 3,
  autoStartPolling: true,
  opacityPercent: 96,
  lockFloatPosition: false,
};

const defaultFloatState: AiTeamFloatState = {
  x: 480,
  y: 12,
  width: 680,
  height: 760,
  minimized: false,
  snap: "free",
};

function loadPageSettings(): AiTeamPageSettings {
  try {
    const raw = window.localStorage.getItem(PAGE_SETTINGS_STORAGE_KEY);
    if (!raw) {
      return { ...defaultPageSettings };
    }
    const parsed = JSON.parse(raw) as Partial<AiTeamPageSettings>;
    return {
      helloMessage:
        typeof parsed.helloMessage === "string" && parsed.helloMessage.trim()
          ? parsed.helloMessage
          : defaultPageSettings.helloMessage,
      bindTimeoutSecs: Math.max(1, Math.min(60, Number(parsed.bindTimeoutSecs || defaultPageSettings.bindTimeoutSecs))),
      autoPollingIntervalSecs: Math.max(
        1,
        Math.min(30, Number(parsed.autoPollingIntervalSecs || defaultPageSettings.autoPollingIntervalSecs)),
      ),
      autoStartPolling: parsed.autoStartPolling !== false,
      opacityPercent: Math.max(60, Math.min(100, Number(parsed.opacityPercent || defaultPageSettings.opacityPercent))),
      lockFloatPosition: parsed.lockFloatPosition === true,
    };
  } catch {
    return { ...defaultPageSettings };
  }
}

function loadFloatState(): AiTeamFloatState {
  try {
    const raw = window.localStorage.getItem(FLOAT_PANEL_STORAGE_KEY);
    if (!raw) {
      return { ...defaultFloatState };
    }
    const parsed = JSON.parse(raw) as Partial<AiTeamFloatState>;
    return {
      x: Number.isFinite(parsed.x) ? Number(parsed.x) : defaultFloatState.x,
      y: Number.isFinite(parsed.y) ? Number(parsed.y) : defaultFloatState.y,
      width: Number.isFinite(parsed.width) ? Number(parsed.width) : defaultFloatState.width,
      height: Number.isFinite(parsed.height) ? Number(parsed.height) : defaultFloatState.height,
      minimized: parsed.minimized === true,
      snap:
        parsed.snap === "left" || parsed.snap === "right" || parsed.snap === "top" || parsed.snap === "bottom"
          ? parsed.snap
          : "free",
    };
  } catch {
    return { ...defaultFloatState };
  }
}

function roleTagColor(role: AiTeamRoleSnapshot) {
  if (role.last_error) {
    return "error";
  }
  if (role.responding) {
    return "processing";
  }
  if (role.sid_bound) {
    return "success";
  }
  if (role.runtime_ready) {
    return "blue";
  }
  return "default";
}

function roleStatusLabel(role: AiTeamRoleSnapshot) {
  if (role.last_error) {
    return "异常";
  }
  if (role.responding) {
    return "执行中";
  }
  if (role.sid_bound) {
    return "已绑定 SID";
  }
  if (role.runtime_ready) {
    return "已初始化";
  }
  return "未初始化";
}

function runStageColor(stage?: string | null) {
  if (!stage) {
    return "default";
  }
  if (stage === "finished") {
    return "success";
  }
  if (stage === "failed") {
    return "error";
  }
  if (stage.includes("waiting")) {
    return "processing";
  }
  return "blue";
}

function findRoleSnapshot(snapshot: AiTeamSnapshot | null, roleKey: AiTeamRoleKey) {
  return snapshot?.roles.find((role) => role.role_key === roleKey) ?? null;
}

export default function AiTeamMcpPage(props: AiTeamMcpPageProps) {
  const {
    providers,
    defaultProjectDirectory,
    onOpenCommonSettings,
    onClose,
    onSyncPaneSessionState,
    onProbePaneSessionId,
    onHeaderActionsChange,
  } = props;
  const providerOptions = useMemo(
    () => (providers.length ? providers : ["codex", "claude", "gemini"]),
    [providers],
  );

  const [messageApi, contextHolder] = message.useMessage();
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("vertical");
  const [pageSettings, setPageSettings] = useState<AiTeamPageSettings>(() => loadPageSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [createDrawerOpen, setCreateDrawerOpen] = useState(false);
  const [teamName, setTeamName] = useState("AI 团队");
  const [projectDirectory, setProjectDirectory] = useState(defaultProjectDirectory || "");
  const [analystProvider, setAnalystProvider] = useState(providerOptions[0] || "codex");
  const [coderProvider, setCoderProvider] = useState(providerOptions[0] || "codex");
  const [currentTeamId, setCurrentTeamId] = useState(() => window.localStorage.getItem(TEAM_STORAGE_KEY) || "");
  const [snapshot, setSnapshot] = useState<AiTeamSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [initializing, setInitializing] = useState(false);
  const [binding, setBinding] = useState(false);
  const [submittingRequirement, setSubmittingRequirement] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [autoPolling, setAutoPolling] = useState(false);
  const [requirementInput, setRequirementInput] = useState("");
  const [roleInputs, setRoleInputs] = useState<Record<AiTeamRoleKey, string>>(defaultRoleInputs);
  const [conversations, setConversations] = useState<Record<AiTeamRoleKey, AiTeamConversationRow[]>>(defaultConversations);
  const [roleLoading, setRoleLoading] = useState<Record<AiTeamRoleKey, boolean>>({ analyst: false, coder: false });
  const [floatState, setFloatState] = useState<AiTeamFloatState>(() => loadFloatState());
  const executingRef = useRef(false);
  const floatLayerRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);
  const resizeStateRef = useRef<{ startX: number; originWidth: number } | null>(null);
  const resizeHeightStateRef = useRef<{ startY: number; originHeight: number } | null>(null);

  const clampFloatState = useCallback((next: AiTeamFloatState): AiTeamFloatState => {
    const bounds = floatLayerRef.current?.getBoundingClientRect();
    const layerWidth = bounds?.width || window.innerWidth;
    const layerHeight = bounds?.height || window.innerHeight;
    const minimized = next.minimized === true;
    const width = Math.max(420, Math.min(Math.round(next.width), Math.max(420, layerWidth - 24)));
    const height = Math.max(260, Math.min(Math.round(next.height), Math.max(260, layerHeight - 24)));
    const appliedWidth = minimized ? Math.min(320, width) : width;
    const appliedHeight = minimized ? 76 : height;
    const x = minimized
      ? Math.max(12, layerWidth - appliedWidth - 12)
      : Math.max(12, Math.min(Math.round(next.x), Math.max(12, layerWidth - appliedWidth - 12)));
    const y = Math.max(12, Math.min(Math.round(next.y), Math.max(12, layerHeight - appliedHeight - 12)));
    return {
      x,
      y,
      width,
      height,
      minimized,
      snap: next.snap === "left" || next.snap === "right" || next.snap === "top" || next.snap === "bottom" ? next.snap : "free",
    };
  }, []);

  const finalizeFloatState = useCallback(
    (next: AiTeamFloatState): AiTeamFloatState => {
      const clamped = clampFloatState(next);
      const bounds = floatLayerRef.current?.getBoundingClientRect();
      const layerWidth = bounds?.width || window.innerWidth;
      const layerHeight = bounds?.height || window.innerHeight;
      const appliedWidth = clamped.minimized ? Math.min(320, clamped.width) : clamped.width;
      const appliedHeight = clamped.minimized ? 76 : clamped.height;
      const nearLeft = clamped.x <= 12 + FLOAT_SNAP_THRESHOLD;
      const nearRight = clamped.x + appliedWidth >= layerWidth - 12 - FLOAT_SNAP_THRESHOLD;
      const nearTop = clamped.y <= 12 + FLOAT_SNAP_THRESHOLD;
      const nearBottom = clamped.y + appliedHeight >= layerHeight - 12 - FLOAT_SNAP_THRESHOLD;

      if (nearLeft) {
        return { ...clamped, x: 12, snap: "left" as AiTeamFloatSnap };
      }
      if (nearRight) {
        return { ...clamped, x: Math.max(12, layerWidth - appliedWidth - 12), snap: "right" as AiTeamFloatSnap };
      }
      if (nearTop) {
        return { ...clamped, y: 12, snap: "top" as AiTeamFloatSnap };
      }
      if (nearBottom) {
        return {
          ...clamped,
          y: Math.max(12, layerHeight - appliedHeight - 12),
          snap: "bottom" as AiTeamFloatSnap,
        };
      }
      return { ...clamped, snap: "free" as AiTeamFloatSnap };
    },
    [clampFloatState],
  );

  useEffect(() => {
    window.localStorage.setItem(PAGE_SETTINGS_STORAGE_KEY, JSON.stringify(pageSettings));
  }, [pageSettings]);

  useEffect(() => {
    window.localStorage.setItem(FLOAT_PANEL_STORAGE_KEY, JSON.stringify(floatState));
  }, [floatState]);

  useEffect(() => {
    setFloatState((current) => clampFloatState(current));
    const handleResize = () => {
      setFloatState((current) => clampFloatState(current));
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [clampFloatState]);

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      if (dragStateRef.current) {
        const { startX, startY, originX, originY } = dragStateRef.current;
        setFloatState((current) =>
          clampFloatState({
            ...current,
            x: originX + (event.clientX - startX),
            y: originY + (event.clientY - startY),
          }),
        );
        return;
      }
      if (resizeStateRef.current) {
        const { startX, originWidth } = resizeStateRef.current;
        setFloatState((current) =>
          clampFloatState({
            ...current,
            width: originWidth + (event.clientX - startX),
          }),
        );
        return;
      }
      if (resizeHeightStateRef.current) {
        const { startY, originHeight } = resizeHeightStateRef.current;
        setFloatState((current) =>
          clampFloatState({
            ...current,
            height: originHeight + (event.clientY - startY),
          }),
        );
      }
    };

    const handleMouseUp = () => {
      if (dragStateRef.current || resizeStateRef.current || resizeHeightStateRef.current) {
        setFloatState((current) => finalizeFloatState(current));
      }
      dragStateRef.current = null;
      resizeStateRef.current = null;
      resizeHeightStateRef.current = null;
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [clampFloatState]);

  useEffect(() => {
    if (!projectDirectory && defaultProjectDirectory) {
      setProjectDirectory(defaultProjectDirectory);
    }
  }, [defaultProjectDirectory, projectDirectory]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || createDrawerOpen || settingsOpen) {
        return;
      }
      if (event.key === "Escape" && !floatState.minimized) {
        event.preventDefault();
        setFloatState((current) => finalizeFloatState({ ...current, minimized: true }));
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [createDrawerOpen, finalizeFloatState, floatState.minimized, settingsOpen]);

  useEffect(() => {
    if (!providerOptions.includes(analystProvider)) {
      setAnalystProvider(providerOptions[0] || "codex");
    }
    if (!providerOptions.includes(coderProvider)) {
      setCoderProvider(providerOptions[0] || "codex");
    }
  }, [providerOptions, analystProvider, coderProvider]);

  const refreshSnapshot = useCallback(
    async (teamId = currentTeamId, showLoading = false) => {
      if (!teamId) {
        setSnapshot(null);
        return;
      }
      if (showLoading) {
        setLoading(true);
      }
      try {
        const nextSnapshot = await aiTeamGetSnapshot(teamId);
        setSnapshot(nextSnapshot);
        setCurrentTeamId(nextSnapshot.team_id);
        window.localStorage.setItem(TEAM_STORAGE_KEY, nextSnapshot.team_id);
        nextSnapshot.roles.forEach((role) => {
          if (role.pane_id) {
            onSyncPaneSessionState?.(role.pane_id);
          }
        });
      } catch (error) {
        console.error(error);
        setSnapshot(null);
      } finally {
        if (showLoading) {
          setLoading(false);
        }
      }
    },
    [currentTeamId, onSyncPaneSessionState],
  );

  const probeRoleSidLocally = useCallback(
    async (teamId: string, roleKey: AiTeamRoleKey, paneId: string) => {
      if (!onProbePaneSessionId) {
        return null;
      }
      const sid = (await onProbePaneSessionId(paneId)).trim();
      if (!sid) {
        return null;
      }
      const response = await aiTeamSetRoleSid(teamId, roleKey, sid);
      return response;
    },
    [onProbePaneSessionId],
  );

  useEffect(() => {
    if (currentTeamId) {
      void refreshSnapshot(currentTeamId, true);
    }
  }, [currentTeamId, refreshSnapshot]);

  useEffect(() => {
    if (!snapshot?.active_run || snapshot.active_run.stage === "finished" || snapshot.active_run.stage === "failed") {
      setAutoPolling(false);
    }
  }, [snapshot?.active_run]);

  const executeNextOnce = useCallback(async () => {
    if (!snapshot?.active_run || !currentTeamId || executingRef.current) {
      return;
    }
    executingRef.current = true;
    setExecuting(true);
    try {
      const response = await aiTeamExecuteNext(currentTeamId, snapshot.active_run.run_id);
      setSnapshot(response.snapshot);
      if (response.done) {
        setAutoPolling(false);
      }
    } catch (error) {
      console.error(error);
      messageApi.error("执行下一步失败");
      setAutoPolling(false);
    } finally {
      executingRef.current = false;
      setExecuting(false);
    }
  }, [currentTeamId, messageApi, snapshot?.active_run]);

  useEffect(() => {
    if (!autoPolling || !snapshot?.active_run?.run_id) {
      return;
    }
    const timer = window.setInterval(() => {
      void executeNextOnce();
    }, pageSettings.autoPollingIntervalSecs * 1000);
    return () => window.clearInterval(timer);
  }, [autoPolling, executeNextOnce, pageSettings.autoPollingIntervalSecs, snapshot?.active_run?.run_id]);

  const pickProjectDirectory = useCallback(async () => {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      defaultPath: projectDirectory || defaultProjectDirectory || undefined,
    });
    if (typeof selected === "string" && selected.trim()) {
      setProjectDirectory(selected);
    }
  }, [defaultProjectDirectory, projectDirectory]);

  const createTeam = useCallback(async () => {
    if (!projectDirectory.trim()) {
      messageApi.warning("请先选择项目目录");
      return;
    }
    setCreating(true);
    try {
      const response = await aiTeamCreateTeam({
        name: teamName.trim() || "AI 团队",
        projectDirectory: projectDirectory.trim(),
        analystProvider,
        coderProvider,
      });
      setSnapshot(response.snapshot);
      setCurrentTeamId(response.snapshot.team_id);
      setCreateDrawerOpen(false);
      setConversations(defaultConversations);
      window.localStorage.setItem(TEAM_STORAGE_KEY, response.snapshot.team_id);
      messageApi.success("团队已创建");
    } catch (error) {
      console.error(error);
      messageApi.error("创建团队失败");
    } finally {
      setCreating(false);
    }
  }, [analystProvider, coderProvider, messageApi, projectDirectory, teamName]);

  const ensureTeamReadyForHello = useCallback(
    async (teamId: string) => {
      const currentSnapshot = snapshot ?? (await aiTeamGetSnapshot(teamId));
      const requiresBoot = currentSnapshot.roles.some((role) => !role.pane_id || !role.runtime_ready);
      if (!requiresBoot) {
        return currentSnapshot;
      }
      setInitializing(true);
      try {
        const initResponse = await aiTeamInitializeTeam(teamId);
        setSnapshot(initResponse.snapshot);
        return initResponse.snapshot;
      } finally {
        setInitializing(false);
      }
    },
    [snapshot],
  );

  const sendHelloToAllRoles = useCallback(async (teamId: string, showMessage = true) => {
    setBinding(true);
    try {
      const currentSnapshot = await ensureTeamReadyForHello(teamId);
      const initializedRoles: string[] = [];
      const failedRoles: string[] = [];
      for (const roleKey of ["analyst", "coder"] as AiTeamRoleKey[]) {
        try {
          const role = findRoleSnapshot(currentSnapshot, roleKey);
          if (!role) {
            failedRoles.push(roleKey);
            continue;
          }
          if (role.sid_bound) {
            await aiTeamSendRoleHello(teamId, roleKey, pageSettings.helloMessage);
          } else {
            await aiTeamSendRoleHello(teamId, roleKey, pageSettings.helloMessage);
            const localResponse =
              role.pane_id.trim() ? await probeRoleSidLocally(teamId, roleKey, role.pane_id) : null;
            if (localResponse?.sid_bound) {
              initializedRoles.push(roleKey);
            } else {
              await aiTeamClearRoleSid(teamId, roleKey);
              failedRoles.push(roleKey);
            }
          }
        } catch (error) {
          console.error(error);
          failedRoles.push(roleKey);
        }
      }
      await refreshSnapshot(teamId);
        if (showMessage) {
          if (failedRoles.length) {
            messageApi.warning(`已处理“你好”，但以下角色初始化失败：${failedRoles.join(", ")}`);
          } else if (initializedRoles.length) {
          messageApi.success(`已发送“你好”，并完成首次状态 SID 绑定：${initializedRoles.join(", ")}`);
          } else {
            messageApi.success("已发送“你好”");
          }
      }
    } catch (error) {
      console.error(error);
      messageApi.error("发送“你好”失败");
    } finally {
      setBinding(false);
    }
  }, [ensureTeamReadyForHello, messageApi, pageSettings.bindTimeoutSecs, pageSettings.helloMessage, refreshSnapshot]);

  const bindAll = useCallback(async () => {
    if (!currentTeamId) {
      messageApi.warning("请先创建团队");
      return;
    }
    await sendHelloToAllRoles(currentTeamId, true);
  }, [currentTeamId, messageApi, sendHelloToAllRoles]);

  const bindRole = useCallback(
    async (roleKey: AiTeamRoleKey) => {
      if (!currentTeamId) {
        return;
      }
      setRoleLoading((current) => ({ ...current, [roleKey]: true }));
      try {
        const currentSnapshot = await ensureTeamReadyForHello(currentTeamId);
        const role = findRoleSnapshot(currentSnapshot, roleKey);
        if (!role) {
          throw new Error(`role not found: ${roleKey}`);
        }
        if (role.sid_bound) {
          await aiTeamSendRoleHello(currentTeamId, roleKey, pageSettings.helloMessage);
          messageApi.success(`${roleKey} 已发送“你好”`);
        } else {
          await aiTeamSendRoleHello(currentTeamId, roleKey, pageSettings.helloMessage);
          const localResponse =
            role.pane_id.trim() ? await probeRoleSidLocally(currentTeamId, roleKey, role.pane_id) : null;
          if (localResponse?.sid_bound) {
            messageApi.success(`${roleKey} 已发送“你好”并从状态信息绑定 SID`);
          } else {
            await aiTeamClearRoleSid(currentTeamId, roleKey);
            messageApi.warning(`${roleKey} 已发送“你好”，但暂未从状态信息读到 SID`);
          }
        }
        await refreshSnapshot(currentTeamId);
      } catch (error) {
        console.error(error);
        messageApi.error(`角色 ${roleKey} 发送“你好”失败`);
      } finally {
        setRoleLoading((current) => ({ ...current, [roleKey]: false }));
      }
    },
    [currentTeamId, ensureTeamReadyForHello, messageApi, pageSettings.bindTimeoutSecs, pageSettings.helloMessage, refreshSnapshot],
  );

  const refreshRoleSid = useCallback(
    async (roleKey: AiTeamRoleKey) => {
      if (!currentTeamId) {
        return;
      }
      setRoleLoading((current) => ({ ...current, [roleKey]: true }));
      try {
        const currentSnapshot = snapshot ?? (await aiTeamGetSnapshot(currentTeamId));
        const role = findRoleSnapshot(currentSnapshot, roleKey);
        const localResponse =
          role?.pane_id.trim() && onProbePaneSessionId
            ? await probeRoleSidLocally(currentTeamId, roleKey, role.pane_id)
            : null;
        const response = localResponse ?? (await aiTeamClearRoleSid(currentTeamId, roleKey));
        await refreshSnapshot(currentTeamId);
        messageApi[response.sid_bound ? "success" : "warning"](
          `${roleKey} ${response.sid_bound ? "已从状态信息刷新 SID" : "当前仍未从状态信息读到 SID"}`,
        );
      } catch (error) {
        console.error(error);
        messageApi.error(`读取状态信息刷新 ${roleKey} SID 失败`);
      } finally {
        setRoleLoading((current) => ({ ...current, [roleKey]: false }));
      }
    },
    [currentTeamId, messageApi, onProbePaneSessionId, probeRoleSidLocally, refreshSnapshot, snapshot],
  );

  const loadRoleConversation = useCallback(
    async (roleKey: AiTeamRoleKey) => {
      if (!currentTeamId) {
        return;
      }
      setRoleLoading((current) => ({ ...current, [roleKey]: true }));
      try {
        const response = await aiTeamLoadConversation(currentTeamId, roleKey, 20, 0, true);
        setConversations((current) => ({ ...current, [roleKey]: response.rows }));
      } catch (error) {
        console.error(error);
        messageApi.error(`加载 ${roleKey} 会话失败`);
      } finally {
        setRoleLoading((current) => ({ ...current, [roleKey]: false }));
      }
    },
    [currentTeamId, messageApi],
  );

  const sendRoleMessage = useCallback(
    async (roleKey: AiTeamRoleKey) => {
      if (!currentTeamId) {
        return;
      }
      const nextMessage = roleInputs[roleKey].trim();
      if (!nextMessage) {
        messageApi.warning("请输入要发送的内容");
        return;
      }
      setRoleLoading((current) => ({ ...current, [roleKey]: true }));
      try {
        await aiTeamSendMessage(currentTeamId, roleKey, nextMessage, true);
        setRoleInputs((current) => ({ ...current, [roleKey]: "" }));
        await refreshSnapshot(currentTeamId);
        messageApi.success(`已发送到 ${roleKey}`);
      } catch (error) {
        console.error(error);
        messageApi.error(`发送到 ${roleKey} 失败`);
      } finally {
        setRoleLoading((current) => ({ ...current, [roleKey]: false }));
      }
    },
    [currentTeamId, messageApi, refreshSnapshot, roleInputs],
  );

  const submitRequirement = useCallback(async () => {
    if (!currentTeamId) {
      messageApi.warning("请先创建团队");
      return;
    }
    const requirement = requirementInput.trim();
    if (!requirement) {
      messageApi.warning("请输入用户需求");
      return;
    }
    setSubmittingRequirement(true);
    try {
      const response = await aiTeamSubmitRequirement(currentTeamId, requirement, true);
      setSnapshot(response.snapshot);
      setAutoPolling(pageSettings.autoStartPolling);
      messageApi.success("需求已下发给 AI角色1");
    } catch (error) {
      console.error(error);
      messageApi.error("提交需求失败");
    } finally {
      setSubmittingRequirement(false);
    }
  }, [currentTeamId, messageApi, pageSettings.autoStartPolling, requirementInput]);

  const clearCurrentTeam = useCallback(() => {
    window.localStorage.removeItem(TEAM_STORAGE_KEY);
    setCurrentTeamId("");
    setSnapshot(null);
    setAutoPolling(false);
    setConversations(defaultConversations);
  }, []);

  const clearAllRoleSids = useCallback(async () => {
    if (!currentTeamId) {
      messageApi.warning("请先创建团队");
      return;
    }
    setBinding(true);
    try {
      for (const roleKey of ["analyst", "coder"] as AiTeamRoleKey[]) {
        await aiTeamClearRoleSid(currentTeamId, roleKey);
      }
      setConversations(defaultConversations);
      await refreshSnapshot(currentTeamId);
      messageApi.success("已清空团队 SID 绑定");
    } catch (error) {
      console.error(error);
      messageApi.error("清空团队 SID 失败");
    } finally {
      setBinding(false);
    }
  }, [currentTeamId, messageApi, refreshSnapshot]);

  const fetchAllRoleSids = useCallback(async () => {
    if (!currentTeamId) {
      messageApi.warning("请先创建团队");
      return;
    }
    setBinding(true);
    try {
      const currentSnapshot = await ensureTeamReadyForHello(currentTeamId);
      const foundRoles: string[] = [];
      const missingRoles: string[] = [];
      for (const roleKey of ["analyst", "coder"] as AiTeamRoleKey[]) {
        const role = findRoleSnapshot(currentSnapshot, roleKey);
        const paneId = role?.pane_id.trim() ?? "";
        if (!paneId || !onProbePaneSessionId) {
          await aiTeamClearRoleSid(currentTeamId, roleKey);
          missingRoles.push(roleKey);
          continue;
        }
        const sid = (await onProbePaneSessionId(paneId)).trim();
        if (!sid) {
          await aiTeamClearRoleSid(currentTeamId, roleKey);
          missingRoles.push(roleKey);
          continue;
        }
        await aiTeamSetRoleSid(currentTeamId, roleKey, sid);
        foundRoles.push(roleKey);
      }
      await refreshSnapshot(currentTeamId);
      if (missingRoles.length) {
        messageApi.warning(`已串行提取会话 SID，但以下角色未读取到状态信息：${missingRoles.join(", ")}`);
      } else {
        messageApi.success(`已串行提取会话 SID：${foundRoles.join(", ")}`);
      }
    } catch (error) {
      console.error(error);
      messageApi.error("串行提取会话 SID 失败");
    } finally {
      setBinding(false);
    }
  }, [currentTeamId, ensureTeamReadyForHello, messageApi, onProbePaneSessionId, refreshSnapshot]);

  useEffect(() => {
    if (!onHeaderActionsChange) {
      return;
    }
    onHeaderActionsChange({
      left: [
        {
          key: "new-team",
          label: "新建团队",
          onClick: () => setCreateDrawerOpen(true),
          primary: true,
          loading: creating,
          disabled: creating || initializing || binding || executing || submittingRequirement,
        },
        {
          key: "fetch-sid",
          label: "一键取会话SID",
          onClick: () => void fetchAllRoleSids(),
          loading: binding || initializing,
          disabled: !currentTeamId,
        },
        {
          key: "clear-sid",
          label: "清空SID绑定",
          onClick: () => void clearAllRoleSids(),
          loading: binding,
          disabled: !currentTeamId,
          danger: true,
        },
      ],
      right: [
        {
          key: "settings",
          label: "配置",
          onClick: () => setSettingsOpen(true),
        },
      ],
    });
    return () => onHeaderActionsChange(null);
  }, [
    binding,
    clearAllRoleSids,
    creating,
    currentTeamId,
    executing,
    fetchAllRoleSids,
    initializing,
    onHeaderActionsChange,
    submittingRequirement,
  ]);

  const roleGridStyle = useMemo<CSSProperties>(
    () => ({
      display: "grid",
      gap: 12,
      gridTemplateColumns: layoutMode === "horizontal" ? "repeat(2, minmax(0, 1fr))" : "minmax(0, 1fr)",
      alignItems: "start",
    }),
    [layoutMode],
  );

  const floatSummary = useMemo(() => {
    const busyCount = snapshot?.roles.filter((item) => item.responding).length || 0;
    const errorCount = snapshot?.roles.filter((item) => !!item.last_error).length || 0;
    const sidReadyCount = snapshot?.roles.filter((item) => item.sid_bound).length || 0;
    const stage = snapshot?.active_run?.stage || "idle";
    const shortStage =
      stage === "finished"
        ? "完成"
        : stage === "failed"
          ? "失败"
          : stage === "idle"
            ? "待机"
            : "进行中";
    return {
      busyCount,
      errorCount,
      sidReadyCount,
      shortStage,
    };
  }, [snapshot]);

  const startDragging = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (pageSettings.lockFloatPosition) {
        return;
      }
      if (event.button !== 0) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(
          "button, .ant-btn, input, textarea, .ant-input, .ant-select, .ant-select-selector, .ant-segmented, .ai-team-float-resize-handle",
        )
      ) {
        return;
      }
      dragStateRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        originX: floatState.x,
        originY: floatState.y,
      };
      event.preventDefault();
    },
    [floatState.x, floatState.y, pageSettings.lockFloatPosition],
  );

  const startResizing = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (pageSettings.lockFloatPosition) {
        return;
      }
      if (event.button !== 0) {
        return;
      }
      resizeStateRef.current = {
        startX: event.clientX,
        originWidth: floatState.width,
      };
      event.preventDefault();
      event.stopPropagation();
    },
    [floatState.width, pageSettings.lockFloatPosition],
  );

  const startResizingHeight = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (pageSettings.lockFloatPosition) {
        return;
      }
      if (event.button !== 0) {
        return;
      }
      resizeHeightStateRef.current = {
        startY: event.clientY,
        originHeight: floatState.height,
      };
      event.preventDefault();
      event.stopPropagation();
    },
    [floatState.height, pageSettings.lockFloatPosition],
  );

  const toggleMinimized = useCallback(() => {
    setFloatState((current) => finalizeFloatState({ ...current, minimized: !current.minimized }));
  }, [finalizeFloatState]);

  const handleHeaderDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(
          "button, .ant-btn, input, textarea, .ant-input, .ant-select, .ant-select-selector, .ant-segmented, .ai-team-float-resize-handle, .ai-team-float-resize-height-handle",
        )
      ) {
        return;
      }
      toggleMinimized();
    },
    [toggleMinimized],
  );

  const panelBody = (
    <Space direction="vertical" size={12} style={{ width: "100%" }}>
      <Card size="small" title="当前团队">
        {snapshot ? (
          <Space direction="vertical" size={10} style={{ width: "100%" }}>
            <Space wrap>
              <Typography.Text strong>{snapshot.name}</Typography.Text>
              <Tag color="blue">{snapshot.roles.length} 个角色</Tag>
              {snapshot.active_run ? <Tag color={runStageColor(snapshot.active_run.stage)}>{snapshot.active_run.stage}</Tag> : <Tag>暂无 Run</Tag>}
            </Space>
            <Typography.Text type="secondary">团队 ID：{snapshot.team_id}</Typography.Text>
            <Typography.Text type="secondary">项目目录：{snapshot.project_directory}</Typography.Text>
            <Typography.Text type="secondary">运行目录：{snapshot.runtime_directory}</Typography.Text>
            <Space wrap>
              <Button disabled={!currentTeamId} onClick={clearCurrentTeam}>
                清空当前团队缓存
              </Button>
            </Space>
          </Space>
        ) : (
          <Empty description="还没有团队，点击顶部“新建团队”开始。" />
        )}
      </Card>

      <Card size="small" title="需求调度">
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <Input.TextArea
            value={requirementInput}
            onChange={(event) => setRequirementInput(event.target.value)}
            rows={5}
            placeholder="输入用户需求，AI角色1 会先分析，再决定是否调度 AI角色2 写代码。"
          />
          <Space wrap>
            <Button type="primary" loading={submittingRequirement} disabled={!currentTeamId} onClick={() => void submitRequirement()}>
              下发需求
            </Button>
            <Button loading={executing} disabled={!snapshot?.active_run} onClick={() => void executeNextOnce()}>
              执行下一步
            </Button>
            <Button disabled={!snapshot?.active_run} onClick={() => setAutoPolling((current) => !current)}>
              {autoPolling ? "停止自动执行" : "开启自动执行"}
            </Button>
          </Space>
          {snapshot?.active_run ? (
            <Alert
              type={snapshot.active_run.stage === "failed" ? "error" : snapshot.active_run.stage === "finished" ? "success" : "info"}
              showIcon
              message={
                <Space>
                  <span>当前 Run</span>
                  <Tag color={runStageColor(snapshot.active_run.stage)}>{snapshot.active_run.stage}</Tag>
                  {snapshot.active_run.last_action ? <Tag>{snapshot.active_run.last_action}</Tag> : null}
                </Space>
              }
              description={
                <Space direction="vertical" size={4}>
                  <Typography.Text>{snapshot.active_run.requirement}</Typography.Text>
                  {snapshot.active_run.final_answer ? (
                    <Typography.Paragraph style={{ whiteSpace: "pre-wrap", marginBottom: 0 }}>
                      {snapshot.active_run.final_answer}
                    </Typography.Paragraph>
                  ) : null}
                  {snapshot.active_run.last_error ? <Typography.Text type="danger">{snapshot.active_run.last_error}</Typography.Text> : null}
                </Space>
              }
            />
          ) : null}
        </Space>
      </Card>

      <div style={roleGridStyle}>
        {(snapshot?.roles || []).map((role) => (
          <Card
            key={role.role_key}
            size="small"
            title={
              <Space>
                <span>{role.name}</span>
                <Tag color={roleTagColor(role)}>{roleStatusLabel(role)}</Tag>
                <Tag>{role.provider}</Tag>
                {role.completed ? <Tag color="success">本轮完成</Tag> : null}
              </Space>
            }
          >
            <Space direction="vertical" size={10} style={{ width: "100%" }}>
              <Typography.Text type="secondary">Pane ID：{role.pane_id || "-"}</Typography.Text>
              <Typography.Text type="secondary">SID：{role.session_id || "-"}</Typography.Text>
              <Typography.Text type="secondary">工作目录：{role.work_directory || "-"}</Typography.Text>
              <Typography.Text type="secondary">空闲：{role.idle_secs}s</Typography.Text>
              {role.last_error ? <Alert type="error" showIcon message={role.last_error} /> : null}
              <Space wrap>
                <Button loading={roleLoading[role.role_key]} onClick={() => void bindRole(role.role_key)}>
                  发你好
                </Button>
                <Button loading={roleLoading[role.role_key]} onClick={() => void refreshRoleSid(role.role_key)}>
                  读取状态
                </Button>
                <Button loading={roleLoading[role.role_key]} onClick={() => void loadRoleConversation(role.role_key)}>
                  加载会话
                </Button>
              </Space>
              <Space.Compact style={{ width: "100%" }}>
                <Input
                  value={roleInputs[role.role_key]}
                  onChange={(event) => setRoleInputs((current) => ({ ...current, [role.role_key]: event.target.value }))}
                  placeholder={`给 ${role.name} 发消息`}
                />
                <Button type="primary" loading={roleLoading[role.role_key]} onClick={() => void sendRoleMessage(role.role_key)}>
                  发送
                </Button>
              </Space.Compact>
              <Space direction="vertical" size={8} style={{ width: "100%" }}>
                <Typography.Text strong>最近会话</Typography.Text>
                {conversations[role.role_key].length ? (
                  conversations[role.role_key].map((item, index) => (
                    <Card key={`${role.role_key}-${item.id || index}`} size="small" styles={{ body: { padding: 10 } }}>
                      <Space direction="vertical" size={4} style={{ width: "100%" }}>
                        <Space>
                          <Tag>{item.kind}</Tag>
                          <Typography.Text type="secondary">{new Date(item.created_at * 1000).toLocaleString()}</Typography.Text>
                        </Space>
                        <Typography.Paragraph style={{ whiteSpace: "pre-wrap", marginBottom: 0 }}>
                          {item.content}
                        </Typography.Paragraph>
                      </Space>
                    </Card>
                  ))
                ) : (
                  <Typography.Text type="secondary">还没有加载该角色的会话内容。</Typography.Text>
                )}
              </Space>
            </Space>
          </Card>
        ))}
      </div>
    </Space>
  );

  return (
    <>
      {contextHolder}
      <div className="ai-team-workbench-page">
        <div className="ai-team-workbench-toolbar">
          <Space wrap>
            <Segmented
              value={layoutMode}
              onChange={(value) => setLayoutMode(value === "horizontal" ? "horizontal" : "vertical")}
              options={[
                { value: "vertical", label: "竖排" },
                { value: "horizontal", label: "双列" },
              ]}
            />
            <Button disabled={!currentTeamId} loading={binding || initializing} onClick={() => void bindAll()}>
              批量发你好
            </Button>
            <Button disabled={!currentTeamId} onClick={() => void refreshSnapshot(undefined, true)}>
              刷新
            </Button>
            <Button onClick={onOpenCommonSettings}>通用设置</Button>
            <Button onClick={onClose}>返回终端工作台</Button>
          </Space>
        </div>
        {loading ? <div className="loading-wrap">加载中...</div> : panelBody}
      </div>

      <Drawer
        title="新建团队"
        open={createDrawerOpen}
        onClose={() => setCreateDrawerOpen(false)}
        width={520}
        destroyOnClose={false}
      >
        <Form layout="vertical">
          <Form.Item label="团队名称">
            <Input value={teamName} onChange={(event) => setTeamName(event.target.value)} placeholder="例如：AI 团队" />
          </Form.Item>
          <Form.Item label="项目目录">
            <Space.Compact style={{ width: "100%" }}>
              <Input value={projectDirectory} onChange={(event) => setProjectDirectory(event.target.value)} placeholder="请选择项目目录" />
              <Button onClick={() => void pickProjectDirectory()}>选择目录</Button>
            </Space.Compact>
          </Form.Item>
          <Form.Item label="AI角色1 Provider">
            <Select value={analystProvider} onChange={(value) => setAnalystProvider(String(value))} options={providerOptions.map((item) => ({ value: item, label: item }))} />
          </Form.Item>
          <Form.Item label="AI角色2 Provider">
            <Select value={coderProvider} onChange={(value) => setCoderProvider(String(value))} options={providerOptions.map((item) => ({ value: item, label: item }))} />
          </Form.Item>
          <Space>
            <Button type="primary" loading={creating} onClick={() => void createTeam()}>
              创建团队
            </Button>
            <Button onClick={() => setCreateDrawerOpen(false)}>取消</Button>
          </Space>
        </Form>
      </Drawer>

      <Drawer title="协作设置" open={settingsOpen} onClose={() => setSettingsOpen(false)} width={420}>
        <Form layout="vertical">
          <Form.Item label="初始化问候语">
            <Input
              value={pageSettings.helloMessage}
              onChange={(event) =>
                setPageSettings((current) => ({
                  ...current,
                  helloMessage: event.target.value || defaultPageSettings.helloMessage,
                }))
              }
              placeholder="例如：你好"
            />
          </Form.Item>
          <Form.Item label="绑定超时（秒）">
            <InputNumber
              min={1}
              max={60}
              value={pageSettings.bindTimeoutSecs}
              onChange={(value) =>
                setPageSettings((current) => ({
                  ...current,
                  bindTimeoutSecs: Math.max(1, Math.min(60, Number(value || 20))),
                }))
              }
              style={{ width: "100%" }}
            />
          </Form.Item>
          <Form.Item label="自动执行轮询间隔（秒）">
            <InputNumber
              min={1}
              max={30}
              value={pageSettings.autoPollingIntervalSecs}
              onChange={(value) =>
                setPageSettings((current) => ({
                  ...current,
                  autoPollingIntervalSecs: Math.max(1, Math.min(30, Number(value || 3))),
                }))
              }
              style={{ width: "100%" }}
            />
          </Form.Item>
          <Form.Item label="提交需求后默认自动执行">
            <Select
              value={pageSettings.autoStartPolling ? "yes" : "no"}
              onChange={(value) =>
                setPageSettings((current) => ({
                  ...current,
                  autoStartPolling: value === "yes",
                }))
              }
              options={[
                { value: "yes", label: "是" },
                { value: "no", label: "否" },
              ]}
            />
          </Form.Item>
          <Form.Item label={`浮窗透明度（${pageSettings.opacityPercent}%）`}>
            <InputNumber
              min={60}
              max={100}
              value={pageSettings.opacityPercent}
              onChange={(value) =>
                setPageSettings((current) => ({
                  ...current,
                  opacityPercent: Math.max(60, Math.min(100, Number(value || 96))),
                }))
              }
              style={{ width: "100%" }}
            />
          </Form.Item>
          <Form.Item label="锁定浮窗位置与尺寸" valuePropName="checked">
            <Switch
              checked={pageSettings.lockFloatPosition}
              onChange={(checked) =>
                setPageSettings((current) => ({
                  ...current,
                  lockFloatPosition: checked,
                }))
              }
            />
          </Form.Item>
          <Alert type="info" showIcon message="这里是协作页专用设置；主题等通用设置请使用“通用设置”。" />
        </Form>
      </Drawer>
    </>
  );
}
