import { useCallback, useEffect, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Alert,
  Button,
  Card,
  Drawer,
  Empty,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Tag,
  Typography,
  message,
} from "antd";

import type { AiTeamWorkbenchHeaderActions } from "./AiTeamMcpPage";
import {
  collabAcceptReply,
  collabAddRole,
  collabAutoPlanRun,
  collabAutoValidateWave,
  collabClearRoleSid,
  collabCollectRoleReply,
  collabCompleteRun,
  collabCreateRun,
  collabCreateTaskCard,
  collabCreateWorkbench,
  collabDispatchReadyWave,
  collabDispatchTaskCard,
  collabGetSnapshot,
  collabInitializeRoles,
  collabListRoleTemplates,
  collabLoadRoleConversation,
  collabRejectReply,
  collabRemoveRole,
  collabSendRoleMessage,
  collabSetRoleSid,
} from "../lib/collabApi";
import type {
  CollabArtifactSnapshot,
  CollabConversationRow,
  CollabRoleInput,
  CollabRoleSnapshot,
  CollabRoleTemplate,
  CollabTaskCardSnapshot,
  CollabWorkbenchSnapshot,
} from "../types/collab";

type CollabWorkbenchPageProps = {
  providers: string[];
  defaultProjectDirectory?: string;
  onOpenCommonSettings: () => void;
  onClose: () => void;
  onSyncPaneSessionState?: (paneId: string) => void;
  onProbePaneSessionId?: (paneId: string) => Promise<string>;
  onHeaderActionsChange?: (actions: AiTeamWorkbenchHeaderActions | null) => void;
};

type RoleDraft = {
  template_key: string;
  name: string;
  provider: string;
};

type TaskFormState = {
  title: string;
  goal: string;
  target_role_id: string;
  source_role_id: string;
  constraints_text: string;
  input_summary: string;
  expected_output: string;
};

const WORKBENCH_STORAGE_KEY = "ai-shell-collab-current-workbench-id";

const defaultTaskForm: TaskFormState = {
  title: "",
  goal: "",
  target_role_id: "",
  source_role_id: "",
  constraints_text: "",
  input_summary: "",
  expected_output: "",
};

function roleStatusColor(role: CollabRoleSnapshot) {
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

function roleStatusLabel(role: CollabRoleSnapshot) {
  if (role.last_error) {
    return "异常";
  }
  if (role.responding) {
    return "运行中";
  }
  if (role.sid_bound) {
    return "已绑定 SID";
  }
  if (role.runtime_ready) {
    return "已初始化";
  }
  return "未初始化";
}

function taskStatusColor(status: string) {
  if (status === "accepted") {
    return "success";
  }
  if (status === "rejected" || status === "cancelled") {
    return "error";
  }
  if (status === "replied") {
    return "processing";
  }
  if (status === "dispatched") {
    return "blue";
  }
  return "default";
}

function runStatusColor(status?: string | null) {
  if (!status) {
    return "default";
  }
  if (status === "completed") {
    return "success";
  }
  if (status === "failed" || status === "cancelled") {
    return "error";
  }
  if (status === "active") {
    return "processing";
  }
  return "default";
}

function formatTs(value?: number | null) {
  if (!value) {
    return "-";
  }
  return new Date(value * 1000).toLocaleString();
}

export default function CollabWorkbenchPage(props: CollabWorkbenchPageProps) {
  const { providers, defaultProjectDirectory, onProbePaneSessionId, onSyncPaneSessionState, onHeaderActionsChange } =
    props;
  const providerOptions = useMemo(
    () => (providers.length ? providers : ["codex", "claude", "gemini"]),
    [providers],
  );
  const defaultDrafts = useMemo<RoleDraft[]>(
    () => [
      { template_key: "planner", name: "规划角色", provider: providerOptions[0] || "codex" },
      { template_key: "implementer", name: "执行角色", provider: providerOptions[0] || "codex" },
      { template_key: "reviewer", name: "评审角色", provider: providerOptions[0] || "codex" },
    ],
    [providerOptions],
  );

  const [messageApi, contextHolder] = message.useMessage();
  const [templates, setTemplates] = useState<CollabRoleTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [initializing, setInitializing] = useState(false);
  const [binding, setBinding] = useState(false);
  const [addingRole, setAddingRole] = useState(false);
  const [currentWorkbenchId, setCurrentWorkbenchId] = useState(
    () => window.localStorage.getItem(WORKBENCH_STORAGE_KEY) || "",
  );
  const [snapshot, setSnapshot] = useState<CollabWorkbenchSnapshot | null>(null);
  const [createDrawerOpen, setCreateDrawerOpen] = useState(false);
  const [addRoleDrawerOpen, setAddRoleDrawerOpen] = useState(false);
  const [workbenchName, setWorkbenchName] = useState("协作工作台");
  const [projectDirectory, setProjectDirectory] = useState(defaultProjectDirectory || "");
  const [roleDrafts, setRoleDrafts] = useState<RoleDraft[]>(defaultDrafts);
  const [runTitle, setRunTitle] = useState("");
  const [runGoal, setRunGoal] = useState("");
  const [finalSummary, setFinalSummary] = useState("");
  const [taskForm, setTaskForm] = useState<TaskFormState>(defaultTaskForm);
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [selectedRoleId, setSelectedRoleId] = useState("");
  const [roleInputs, setRoleInputs] = useState<Record<string, string>>({});
  const [conversations, setConversations] = useState<Record<string, CollabConversationRow[]>>({});
  const [busyTaskId, setBusyTaskId] = useState("");
  const [busyRoleId, setBusyRoleId] = useState("");
  const [busyRun, setBusyRun] = useState(false);
  const [busyAutoAction, setBusyAutoAction] = useState("");
  const [newRoleTemplate, setNewRoleTemplate] = useState("planner");
  const [newRoleName, setNewRoleName] = useState("");
  const [newRoleProvider, setNewRoleProvider] = useState(providerOptions[0] || "codex");

  const refreshSnapshot = useCallback(
    async (workbenchId = currentWorkbenchId, showLoading = false) => {
      if (!workbenchId) {
        setSnapshot(null);
        return;
      }
      if (showLoading) {
        setLoading(true);
      }
      try {
        const nextSnapshot = await collabGetSnapshot(workbenchId);
        setSnapshot(nextSnapshot);
        setCurrentWorkbenchId(nextSnapshot.workbench_id);
        window.localStorage.setItem(WORKBENCH_STORAGE_KEY, nextSnapshot.workbench_id);
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
    [currentWorkbenchId, onSyncPaneSessionState],
  );

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const templateList = await collabListRoleTemplates();
        if (!cancelled) {
          setTemplates(templateList);
        }
      } catch (error) {
        console.error(error);
      }
      if (!cancelled && currentWorkbenchId) {
        await refreshSnapshot(currentWorkbenchId, true);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [currentWorkbenchId, refreshSnapshot]);

  useEffect(() => {
    if (!projectDirectory && defaultProjectDirectory) {
      setProjectDirectory(defaultProjectDirectory);
    }
  }, [defaultProjectDirectory, projectDirectory]);

  useEffect(() => {
    if (!templates.length) {
      return;
    }
    setRoleDrafts((current) => (current.length ? current : defaultDrafts));
  }, [defaultDrafts, templates]);

  useEffect(() => {
    if (snapshot?.roles.length) {
      setSelectedRoleId((current) => current || snapshot.roles[0].role_id);
      setTaskForm((current) => ({
        ...current,
        target_role_id: current.target_role_id || snapshot.roles[0].role_id,
      }));
    }
    if (snapshot?.task_cards.length) {
      setSelectedTaskId((current) => current || snapshot.task_cards[0].task_id);
    }
    if (snapshot?.active_run?.final_summary) {
      setFinalSummary((current) => current || snapshot.active_run?.final_summary || "");
    }
  }, [snapshot]);

  const roleMap = useMemo(() => {
    return new Map((snapshot?.roles || []).map((role) => [role.role_id, role]));
  }, [snapshot]);

  const selectedTask = useMemo(
    () => snapshot?.task_cards.find((item) => item.task_id === selectedTaskId) ?? snapshot?.task_cards[0] ?? null,
    [selectedTaskId, snapshot],
  );

  const selectedArtifact = useMemo(() => {
    if (!selectedTask?.latest_artifact_id) {
      return null;
    }
    return snapshot?.recent_artifacts.find((item) => item.artifact_id === selectedTask.latest_artifact_id) ?? null;
  }, [selectedTask, snapshot]);

  const selectedRole = useMemo(
    () => snapshot?.roles.find((item) => item.role_id === selectedRoleId) ?? snapshot?.roles[0] ?? null,
    [selectedRoleId, snapshot],
  );

  const groupedTasks = useMemo(() => {
    const items = snapshot?.task_cards || [];
    return {
      queued: items.filter((item) => item.status === "queued" || item.status === "draft"),
      dispatched: items.filter((item) => item.status === "dispatched"),
      replied: items.filter((item) => item.status === "replied"),
      closed: items.filter((item) => item.status === "accepted" || item.status === "rejected" || item.status === "cancelled"),
    };
  }, [snapshot]);
  const taskMap = useMemo(
    () => new Map((snapshot?.task_cards || []).map((task) => [task.task_id, task])),
    [snapshot],
  );
  const waveTaskGroups = useMemo(() => {
    const groups = new Map<number, CollabTaskCardSnapshot[]>();
    for (const task of snapshot?.task_cards || []) {
      const bucket = groups.get(task.wave_index) || [];
      bucket.push(task);
      groups.set(task.wave_index, bucket);
    }
    return [...groups.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([waveIndex, tasks]) => ({
        waveIndex,
        tasks: tasks.slice().sort((a, b) => {
          if (a.plan_order !== b.plan_order) {
            return a.plan_order - b.plan_order;
          }
          return a.created_at - b.created_at;
        }),
      }));
  }, [snapshot]);

  const updateTaskField = useCallback((key: keyof TaskFormState, value: string) => {
    setTaskForm((current) => ({ ...current, [key]: value }));
  }, []);

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

  const createNewWorkbench = useCallback(async () => {
    if (!projectDirectory.trim()) {
      messageApi.warning("请先选择项目目录");
      return;
    }
    setCreating(true);
    try {
      const roles: CollabRoleInput[] = roleDrafts.map((item) => ({
        template_key: item.template_key,
        name: item.name.trim(),
        provider: item.provider,
      }));
      const response = await collabCreateWorkbench({
        name: workbenchName.trim() || "协作工作台",
        projectDirectory: projectDirectory.trim(),
        roles,
      });
      setSnapshot(response.snapshot);
      setCurrentWorkbenchId(response.snapshot.workbench_id);
      setCreateDrawerOpen(false);
      window.localStorage.setItem(WORKBENCH_STORAGE_KEY, response.snapshot.workbench_id);
      messageApi.success("协作工作台已创建");
    } catch (error) {
      console.error(error);
      messageApi.error("创建协作工作台失败");
    } finally {
      setCreating(false);
    }
  }, [messageApi, projectDirectory, roleDrafts, workbenchName]);

  const initializeAllRoles = useCallback(async () => {
    if (!currentWorkbenchId) {
      messageApi.warning("请先创建工作台");
      return;
    }
    setInitializing(true);
    try {
      const response = await collabInitializeRoles(currentWorkbenchId);
      setSnapshot(response.snapshot);
      response.snapshot.roles.forEach((role) => {
        if (role.pane_id) {
          onSyncPaneSessionState?.(role.pane_id);
        }
      });
      messageApi.success("角色终端已初始化");
    } catch (error) {
      console.error(error);
      messageApi.error("初始化角色失败");
    } finally {
      setInitializing(false);
    }
  }, [currentWorkbenchId, messageApi, onSyncPaneSessionState]);

  const probeAllRoleSids = useCallback(async () => {
    if (!currentWorkbenchId || !snapshot?.roles.length) {
      messageApi.warning("当前没有可绑定的角色");
      return;
    }
    if (!onProbePaneSessionId) {
      messageApi.warning("当前工作区未提供 SID 探测能力");
      return;
    }
    setBinding(true);
    try {
      for (const role of snapshot.roles) {
        if (!role.pane_id) {
          continue;
        }
        const sid = (await onProbePaneSessionId(role.pane_id)).trim();
        if (sid) {
          await collabSetRoleSid(currentWorkbenchId, role.role_id, sid);
        } else {
          await collabClearRoleSid(currentWorkbenchId, role.role_id);
        }
      }
      await refreshSnapshot(currentWorkbenchId);
      messageApi.success("已完成角色 SID 绑定探测");
    } catch (error) {
      console.error(error);
      messageApi.error("探测角色 SID 失败");
    } finally {
      setBinding(false);
    }
  }, [currentWorkbenchId, messageApi, onProbePaneSessionId, refreshSnapshot, snapshot?.roles]);

  const addRoleToWorkbench = useCallback(async () => {
    if (!currentWorkbenchId) {
      messageApi.warning("请先创建工作台");
      return;
    }
    setAddingRole(true);
    try {
      const response = await collabAddRole(currentWorkbenchId, {
        template_key: newRoleTemplate,
        name: newRoleName.trim(),
        provider: newRoleProvider,
      });
      setSnapshot(response.snapshot);
      setAddRoleDrawerOpen(false);
      setNewRoleName("");
      messageApi.success("角色已添加");
    } catch (error) {
      console.error(error);
      messageApi.error("添加角色失败");
    } finally {
      setAddingRole(false);
    }
  }, [currentWorkbenchId, messageApi, newRoleName, newRoleProvider, newRoleTemplate]);

  const removeRoleFromWorkbench = useCallback(
    (role: CollabRoleSnapshot) => {
      if (!currentWorkbenchId) {
        return;
      }
      Modal.confirm({
        title: `移除角色：${role.name}`,
        content: "如果该角色已经关联过任务卡，后端会拒绝删除。",
        okButtonProps: { danger: true },
        onOk: async () => {
          try {
            const nextSnapshot = await collabRemoveRole(currentWorkbenchId, role.role_id);
            setSnapshot(nextSnapshot);
            messageApi.success("角色已移除");
          } catch (error) {
            console.error(error);
            messageApi.error("移除角色失败");
          }
        },
      });
    },
    [currentWorkbenchId, messageApi],
  );

  const createRun = useCallback(async () => {
    if (!currentWorkbenchId) {
      messageApi.warning("请先创建工作台");
      return;
    }
    if (!runGoal.trim()) {
      messageApi.warning("请填写本次协作目标");
      return;
    }
    setBusyRun(true);
    try {
      const response = await collabCreateRun(currentWorkbenchId, runTitle.trim(), runGoal.trim());
      setSnapshot(response.snapshot);
      setRunTitle("");
      setRunGoal("");
      messageApi.success("协作 Run 已创建");
    } catch (error) {
      console.error(error);
      messageApi.error("创建 Run 失败");
    } finally {
      setBusyRun(false);
    }
  }, [currentWorkbenchId, messageApi, runGoal, runTitle]);

  const createTask = useCallback(async () => {
    if (!currentWorkbenchId || !snapshot?.active_run) {
      messageApi.warning("请先创建协作 Run");
      return;
    }
    if (!taskForm.target_role_id) {
      messageApi.warning("请选择目标角色");
      return;
    }
    if (!taskForm.goal.trim()) {
      messageApi.warning("请填写任务目标");
      return;
    }
    setBusyTaskId("create");
    try {
      const response = await collabCreateTaskCard({
        workbenchId: currentWorkbenchId,
        runId: snapshot.active_run.run_id,
        targetRoleId: taskForm.target_role_id,
        sourceRoleId: taskForm.source_role_id || undefined,
        title: taskForm.title.trim(),
        goal: taskForm.goal.trim(),
        constraintsText: taskForm.constraints_text.trim(),
        inputSummary: taskForm.input_summary.trim(),
        expectedOutput: taskForm.expected_output.trim(),
      });
      setSnapshot(response.snapshot);
      setSelectedTaskId(response.task.task_id);
      setTaskForm((current) => ({
        ...defaultTaskForm,
        target_role_id: current.target_role_id,
      }));
      messageApi.success("任务卡已创建");
    } catch (error) {
      console.error(error);
      messageApi.error("创建任务卡失败");
    } finally {
      setBusyTaskId("");
    }
  }, [currentWorkbenchId, messageApi, snapshot?.active_run, taskForm]);

  const autoPlanRun = useCallback(async () => {
    if (!currentWorkbenchId || !snapshot?.active_run) {
      messageApi.warning("璇峰厛鍒涘缓鍗忎綔 Run");
      return;
    }
    setBusyAutoAction("plan");
    try {
      const response = await collabAutoPlanRun(currentWorkbenchId, snapshot.active_run.run_id);
      setSnapshot(response.snapshot);
      if (response.created_task_ids.length) {
        setSelectedTaskId(response.created_task_ids[0]);
      }
      messageApi.success(`宸茶嚜鍔ㄦ媶瑙ｇ敓鎴?${response.created_task_ids.length} 涓换鍔″崱`);
    } catch (error) {
      console.error(error);
      messageApi.error("鑷姩鎷嗚В璁″垝澶辫触");
    } finally {
      setBusyAutoAction("");
    }
  }, [currentWorkbenchId, messageApi, snapshot?.active_run]);

  const dispatchNextWave = useCallback(async () => {
    if (!currentWorkbenchId || !snapshot?.active_run) {
      return;
    }
    setBusyAutoAction("dispatch-wave");
    try {
      const response = await collabDispatchReadyWave(currentWorkbenchId, snapshot.active_run.run_id);
      setSnapshot(response.snapshot);
      if (response.dispatched_task_ids.length) {
        setSelectedTaskId(response.dispatched_task_ids[0]);
      }
      messageApi.success(`宸叉淳鍙戠 ${response.wave_index + 1} 娉?${response.dispatched_task_ids.length} 涓换鍔?`);
    } catch (error) {
      console.error(error);
      messageApi.error("娲惧彂涓嬩竴娉㈠け璐?");
    } finally {
      setBusyAutoAction("");
    }
  }, [currentWorkbenchId, messageApi, snapshot?.active_run]);

  const autoValidateWave = useCallback(async () => {
    if (!currentWorkbenchId || !snapshot?.active_run) {
      return;
    }
    setBusyAutoAction("validate-wave");
    try {
      const response = await collabAutoValidateWave(currentWorkbenchId, snapshot.active_run.run_id);
      setSnapshot(response.snapshot);
      if (response.accepted_task_ids.length) {
        setSelectedTaskId(response.accepted_task_ids[0]);
      } else if (response.rejected_task_ids.length) {
        setSelectedTaskId(response.rejected_task_ids[0]);
      } else if (response.waiting_task_ids.length) {
        setSelectedTaskId(response.waiting_task_ids[0]);
      }
      messageApi.success(
        `绗?${response.wave_index + 1} 娉㈡牎楠岀粨鏋滐細閫氳繃 ${response.accepted_task_ids.length} / 椹冲洖 ${response.rejected_task_ids.length} / 绛夊緟 ${response.waiting_task_ids.length}`,
      );
    } catch (error) {
      console.error(error);
      messageApi.error("鑷姩鏍￠獙褰撳墠娉㈠け璐?");
    } finally {
      setBusyAutoAction("");
    }
  }, [currentWorkbenchId, messageApi, snapshot?.active_run]);

  const dispatchTask = useCallback(
    (task: CollabTaskCardSnapshot) => {
      if (!currentWorkbenchId) {
        return;
      }
      const targetRole = roleMap.get(task.target_role_id);
      Modal.confirm({
        title: `派发任务卡：${task.title}`,
        content: `目标角色：${targetRole?.name || task.target_role_id}`,
        onOk: async () => {
          setBusyTaskId(task.task_id);
          try {
            const response = await collabDispatchTaskCard(currentWorkbenchId, task.task_id);
            setSnapshot(response.snapshot);
            messageApi.success("任务卡已派发");
          } catch (error) {
            console.error(error);
            messageApi.error("派发任务卡失败");
          } finally {
            setBusyTaskId("");
          }
        },
      });
    },
    [currentWorkbenchId, messageApi, roleMap],
  );

  const collectReply = useCallback(
    async (task: CollabTaskCardSnapshot) => {
      if (!currentWorkbenchId) {
        return;
      }
      setBusyTaskId(task.task_id);
      try {
        const response = await collabCollectRoleReply(currentWorkbenchId, task.task_id);
        setSnapshot(response.snapshot);
        setSelectedTaskId(task.task_id);
        if (response.waiting) {
          messageApi.info("角色仍在回复中，稍后再采集");
        } else {
          messageApi.success("已采集角色回执");
        }
      } catch (error) {
        console.error(error);
        messageApi.error("采集回执失败");
      } finally {
        setBusyTaskId("");
      }
    },
    [currentWorkbenchId, messageApi],
  );

  const acceptReply = useCallback(
    (task: CollabTaskCardSnapshot) => {
      if (!currentWorkbenchId) {
        return;
      }
      Modal.confirm({
        title: `采纳回执：${task.title}`,
        onOk: async () => {
          setBusyTaskId(task.task_id);
          try {
            const response = await collabAcceptReply(currentWorkbenchId, task.task_id);
            setSnapshot(response.snapshot);
            messageApi.success("回执已采纳");
          } catch (error) {
            console.error(error);
            messageApi.error("采纳回执失败");
          } finally {
            setBusyTaskId("");
          }
        },
      });
    },
    [currentWorkbenchId, messageApi],
  );

  const rejectReply = useCallback(
    (task: CollabTaskCardSnapshot) => {
      if (!currentWorkbenchId) {
        return;
      }
      Modal.confirm({
        title: `驳回回执：${task.title}`,
        okButtonProps: { danger: true },
        onOk: async () => {
          setBusyTaskId(task.task_id);
          try {
            const response = await collabRejectReply(currentWorkbenchId, task.task_id);
            setSnapshot(response.snapshot);
            messageApi.success("回执已驳回");
          } catch (error) {
            console.error(error);
            messageApi.error("驳回回执失败");
          } finally {
            setBusyTaskId("");
          }
        },
      });
    },
    [currentWorkbenchId, messageApi],
  );

  const completeRun = useCallback(async () => {
    if (!currentWorkbenchId || !snapshot?.active_run) {
      return;
    }
    if (!finalSummary.trim()) {
      messageApi.warning("请填写结案摘要");
      return;
    }
    setBusyRun(true);
    try {
      const response = await collabCompleteRun(currentWorkbenchId, snapshot.active_run.run_id, finalSummary.trim());
      setSnapshot(response.snapshot);
      messageApi.success("协作 Run 已结案");
    } catch (error) {
      console.error(error);
      messageApi.error("结案失败");
    } finally {
      setBusyRun(false);
    }
  }, [currentWorkbenchId, finalSummary, messageApi, snapshot?.active_run]);

  const loadRoleConversation = useCallback(
    async (roleId: string) => {
      if (!currentWorkbenchId) {
        return;
      }
      setBusyRoleId(roleId);
      try {
        const response = await collabLoadRoleConversation(currentWorkbenchId, roleId);
        setConversations((current) => ({ ...current, [roleId]: response.rows }));
        setSelectedRoleId(roleId);
      } catch (error) {
        console.error(error);
        messageApi.error("加载会话失败");
      } finally {
        setBusyRoleId("");
      }
    },
    [currentWorkbenchId, messageApi],
  );

  const sendRoleMessage = useCallback(
    async (roleId: string) => {
      const text = (roleInputs[roleId] || "").trim();
      if (!currentWorkbenchId || !text) {
        return;
      }
      setBusyRoleId(roleId);
      try {
        await collabSendRoleMessage(currentWorkbenchId, roleId, text, true);
        setRoleInputs((current) => ({ ...current, [roleId]: "" }));
        messageApi.success("消息已发送");
      } catch (error) {
        console.error(error);
        messageApi.error("发送消息失败");
      } finally {
        setBusyRoleId("");
      }
    },
    [currentWorkbenchId, messageApi, roleInputs],
  );

  useEffect(() => {
    if (!onHeaderActionsChange) {
      return;
    }
    onHeaderActionsChange({
      left: [
        {
          key: "new-workbench",
          label: "新建工作台",
          onClick: () => setCreateDrawerOpen(true),
          primary: true,
        },
        {
          key: "init-roles",
          label: "初始化角色",
          onClick: () => void initializeAllRoles(),
          loading: initializing,
          disabled: !currentWorkbenchId,
        },
        {
          key: "fetch-sid",
          label: "探测角色SID",
          onClick: () => void probeAllRoleSids(),
          loading: binding,
          disabled: !currentWorkbenchId,
        },
      ],
      right: [
        {
          key: "add-role",
          label: "添加角色",
          onClick: () => setAddRoleDrawerOpen(true),
          disabled: !currentWorkbenchId,
        },
      ],
    });
    return () => onHeaderActionsChange(null);
  }, [binding, currentWorkbenchId, initializing, initializeAllRoles, onHeaderActionsChange, probeAllRoleSids]);

  return (
    <>
      {contextHolder}
      <div className="collab-workbench-page">
        {loading ? (
          <div className="loading-wrap">加载中...</div>
        ) : !snapshot ? (
          <Card>
            <Empty description="还没有协作工作台，点击顶部“新建工作台”开始。" />
          </Card>
        ) : (
          <div className="collab-workbench-layout">
            <div className="collab-workbench-main">
              <Card size="small" title="当前工作台">
                <Space direction="vertical" size={10} style={{ width: "100%" }}>
                  <Space wrap>
                    <Typography.Text strong>{snapshot.name}</Typography.Text>
                    <Tag color="blue">{snapshot.roles.length} 个角色</Tag>
                    {snapshot.active_run ? (
                      <Tag color={runStatusColor(snapshot.active_run.status)}>{snapshot.active_run.status}</Tag>
                    ) : (
                      <Tag>暂无 Run</Tag>
                    )}
                  </Space>
                  <Typography.Text type="secondary">工作台 ID：{snapshot.workbench_id}</Typography.Text>
                  <Typography.Text type="secondary">项目目录：{snapshot.project_directory}</Typography.Text>
                  <Typography.Text type="secondary">运行目录：{snapshot.runtime_directory}</Typography.Text>
                </Space>
              </Card>

              <Card size="small" title="协作 Run">
                {snapshot.active_run ? (
                  <Space direction="vertical" size={10} style={{ width: "100%" }}>
                    <Space wrap>
                      <Typography.Text strong>{snapshot.active_run.title}</Typography.Text>
                      <Tag color={runStatusColor(snapshot.active_run.status)}>{snapshot.active_run.status}</Tag>
                    </Space>
                    <Typography.Paragraph style={{ whiteSpace: "pre-wrap", marginBottom: 0 }}>
                      {snapshot.active_run.goal}
                    </Typography.Paragraph>
                    <Space size={[8, 8]} wrap>
                      <Tag color="blue">任务 {snapshot.task_cards.length}</Tag>
                      <Tag color="cyan">波次 {waveTaskGroups.length}</Tag>
                      <Tag color="green">已完成 {groupedTasks.closed.length}</Tag>
                    </Space>
                    <Space size={[8, 8]} wrap>
                      <Button
                        type="primary"
                        loading={busyAutoAction === "plan"}
                        disabled={snapshot.task_cards.length > 0}
                        onClick={() => void autoPlanRun()}
                      >
                        自动拆解计划
                      </Button>
                      <Button
                        loading={busyAutoAction === "dispatch-wave"}
                        disabled={!snapshot.task_cards.length}
                        onClick={() => void dispatchNextWave()}
                      >
                        执行下一波
                      </Button>
                      <Button
                        loading={busyAutoAction === "validate-wave"}
                        disabled={!snapshot.task_cards.length}
                        onClick={() => void autoValidateWave()}
                      >
                        自动校验当前波
                      </Button>
                    </Space>
                    {snapshot.active_run.final_summary ? (
                      <Alert type="success" showIcon message={snapshot.active_run.final_summary} />
                    ) : null}
                    <Input.TextArea
                      value={finalSummary}
                      onChange={(event) => setFinalSummary(event.target.value)}
                      rows={4}
                      placeholder="填写结案摘要，人工确认后结束当前 Run"
                    />
                    <Space>
                      <Button type="primary" loading={busyRun} onClick={() => void completeRun()}>
                        结束 Run
                      </Button>
                    </Space>
                  </Space>
                ) : (
                  <Space direction="vertical" size={10} style={{ width: "100%" }}>
                    <Input
                      value={runTitle}
                      onChange={(event) => setRunTitle(event.target.value)}
                      placeholder="本次协作标题"
                    />
                    <Input.TextArea
                      value={runGoal}
                      onChange={(event) => setRunGoal(event.target.value)}
                      rows={4}
                      placeholder="输入本次协作目标"
                    />
                    <Button type="primary" loading={busyRun} onClick={() => void createRun()}>
                      创建 Run
                    </Button>
                  </Space>
                )}
              </Card>

              <Card size="small" title="创建任务卡">
                <Form layout="vertical">
                  <Form.Item label="任务标题">
                    <Input value={taskForm.title} onChange={(event) => updateTaskField("title", event.target.value)} />
                  </Form.Item>
                  <Form.Item label="目标角色">
                    <Select
                      value={taskForm.target_role_id || undefined}
                      onChange={(value) => updateTaskField("target_role_id", String(value))}
                      options={(snapshot.roles || []).map((role) => ({
                        value: role.role_id,
                        label: `${role.name} (${role.provider})`,
                      }))}
                    />
                  </Form.Item>
                  <Form.Item label="来源角色">
                    <Select
                      allowClear
                      value={taskForm.source_role_id || undefined}
                      onChange={(value) => updateTaskField("source_role_id", String(value || ""))}
                      options={(snapshot.roles || []).map((role) => ({
                        value: role.role_id,
                        label: role.name,
                      }))}
                    />
                  </Form.Item>
                  <Form.Item label="任务目标">
                    <Input.TextArea
                      value={taskForm.goal}
                      onChange={(event) => updateTaskField("goal", event.target.value)}
                      rows={4}
                    />
                  </Form.Item>
                  <Form.Item label="约束">
                    <Input.TextArea
                      value={taskForm.constraints_text}
                      onChange={(event) => updateTaskField("constraints_text", event.target.value)}
                      rows={3}
                    />
                  </Form.Item>
                  <Form.Item label="上下文摘要">
                    <Input.TextArea
                      value={taskForm.input_summary}
                      onChange={(event) => updateTaskField("input_summary", event.target.value)}
                      rows={3}
                    />
                  </Form.Item>
                  <Form.Item label="期望产物">
                    <Input.TextArea
                      value={taskForm.expected_output}
                      onChange={(event) => updateTaskField("expected_output", event.target.value)}
                      rows={3}
                    />
                  </Form.Item>
                  <Button type="primary" loading={busyTaskId === "create"} disabled={!snapshot.active_run} onClick={() => void createTask()}>
                    创建任务卡
                  </Button>
                </Form>
              </Card>

              <Card size="small" title="依赖图">
                {waveTaskGroups.length ? (
                  <Space direction="vertical" size={10} style={{ width: "100%" }}>
                    {waveTaskGroups.map((group) => (
                      <Card key={`wave-${group.waveIndex}`} size="small" title={`第 ${group.waveIndex + 1} 波`}>
                        <Space direction="vertical" size={8} style={{ width: "100%" }}>
                          {group.tasks.map((task) => (
                            <div key={task.task_id}>
                              <Space size={[8, 8]} wrap>
                                <Typography.Text strong>{task.title}</Typography.Text>
                                <Tag color={taskStatusColor(task.status)}>{task.status}</Tag>
                                <Tag>{roleMap.get(task.target_role_id)?.name || task.target_role_id}</Tag>
                              </Space>
                              <Typography.Text type="secondary">
                                {task.dependency_task_ids.length
                                  ? `依赖 ${task.dependency_task_ids.map((dependencyId) => taskMap.get(dependencyId)?.title || dependencyId).join(" / ")}`
                                  : "起始任务"}
                              </Typography.Text>
                            </div>
                          ))}
                        </Space>
                      </Card>
                    ))}
                  </Space>
                ) : (
                  <Typography.Text type="secondary">当前还没有可展示的依赖图</Typography.Text>
                )}
              </Card>

              <div className="collab-task-board">
                {[
                  { key: "queued", title: "待派发", items: groupedTasks.queued },
                  { key: "dispatched", title: "已派发", items: groupedTasks.dispatched },
                  { key: "replied", title: "已回执", items: groupedTasks.replied },
                  { key: "closed", title: "已结案", items: groupedTasks.closed },
                ].map((column) => (
                  <Card key={column.key} size="small" title={column.title}>
                    <div className="collab-task-column">
                      {column.items.length ? (
                        column.items.map((task) => (
                          <Card
                            key={task.task_id}
                            size="small"
                            hoverable
                            className={`collab-task-card ${selectedTask?.task_id === task.task_id ? "selected" : ""}`}
                            onClick={() => setSelectedTaskId(task.task_id)}
                          >
                            <Space direction="vertical" size={8} style={{ width: "100%" }}>
                              <Space wrap>
                                <Typography.Text strong>{task.title}</Typography.Text>
                                <Tag color={taskStatusColor(task.status)}>{task.status}</Tag>
                                <Tag color="blue">波 {task.wave_index + 1}</Tag>
                                {task.auto_generated ? <Tag color="cyan">自动计划</Tag> : null}
                                {task.dependency_task_ids.length ? <Tag color="gold">依赖 {task.dependency_task_ids.length}</Tag> : null}
                              </Space>
                              <Typography.Paragraph style={{ whiteSpace: "pre-wrap", marginBottom: 0 }}>
                                {task.goal}
                              </Typography.Paragraph>
                              <Typography.Text type="secondary">
                                目标角色：{roleMap.get(task.target_role_id)?.name || task.target_role_id}
                              </Typography.Text>
                              {task.dependency_task_ids.length ? (
                                <Typography.Text type="secondary">
                                  依赖：
                                  {task.dependency_task_ids.map((dependencyId) => taskMap.get(dependencyId)?.title || dependencyId).join(" / ")}
                                </Typography.Text>
                              ) : null}
                              {task.latest_reply_summary ? <Alert type="info" showIcon message={task.latest_reply_summary} /> : null}
                              {task.validation_summary ? (
                                <Alert
                                  type={task.status === "accepted" ? "success" : task.status === "rejected" ? "error" : "info"}
                                  showIcon
                                  message={task.validation_summary}
                                />
                              ) : null}
                              {task.last_error ? <Alert type="error" showIcon message={task.last_error} /> : null}
                              <Space wrap>
                                {(task.status === "queued" || task.status === "draft") ? (
                                  <Button size="small" loading={busyTaskId === task.task_id} onClick={() => dispatchTask(task)}>
                                    派发
                                  </Button>
                                ) : null}
                                {task.status === "dispatched" ? (
                                  <Button size="small" loading={busyTaskId === task.task_id} onClick={() => void collectReply(task)}>
                                    采集回执
                                  </Button>
                                ) : null}
                                {task.status === "replied" ? (
                                  <>
                                    <Button size="small" type="primary" loading={busyTaskId === task.task_id} onClick={() => acceptReply(task)}>
                                      采纳
                                    </Button>
                                    <Button size="small" danger loading={busyTaskId === task.task_id} onClick={() => rejectReply(task)}>
                                      驳回
                                    </Button>
                                  </>
                                ) : null}
                              </Space>
                            </Space>
                          </Card>
                        ))
                      ) : (
                        <Typography.Text type="secondary">暂无任务</Typography.Text>
                      )}
                    </div>
                  </Card>
                ))}
              </div>
            </div>

            <div className="collab-workbench-side">
              <Card size="small" title="角色面板">
                <div className="collab-role-list">
                  {snapshot.roles.map((role) => (
                    <Card key={role.role_id} size="small">
                      <Space direction="vertical" size={8} style={{ width: "100%" }}>
                        <Space wrap>
                          <Typography.Text strong>{role.name}</Typography.Text>
                          <Tag color={roleStatusColor(role)}>{roleStatusLabel(role)}</Tag>
                          <Tag>{role.provider}</Tag>
                        </Space>
                        <Typography.Text type="secondary">模板：{role.template_key}</Typography.Text>
                        <Typography.Text type="secondary">SID：{role.session_id || "-"}</Typography.Text>
                        <Typography.Text type="secondary">目录：{role.work_directory}</Typography.Text>
                        <Space wrap>
                          <Button size="small" loading={busyRoleId === role.role_id} onClick={() => void loadRoleConversation(role.role_id)}>
                            加载会话
                          </Button>
                          <Button size="small" danger onClick={() => removeRoleFromWorkbench(role)}>
                            移除
                          </Button>
                        </Space>
                        <Space.Compact style={{ width: "100%" }}>
                          <Input
                            value={roleInputs[role.role_id] || ""}
                            onChange={(event) =>
                              setRoleInputs((current) => ({ ...current, [role.role_id]: event.target.value }))
                            }
                            placeholder={`给 ${role.name} 发送手动消息`}
                          />
                          <Button size="small" type="primary" loading={busyRoleId === role.role_id} onClick={() => void sendRoleMessage(role.role_id)}>
                            发送
                          </Button>
                        </Space.Compact>
                        <Space wrap>
                          {role.capabilities.map((item) => (
                            <Tag key={`${role.role_id}-${item.key}`}>{item.label}</Tag>
                          ))}
                        </Space>
                      </Space>
                    </Card>
                  ))}
                </div>
              </Card>

              <Card size="small" title="任务详情">
                {selectedTask ? (
                  <Space direction="vertical" size={8} style={{ width: "100%" }}>
                    <Space wrap>
                      <Typography.Text strong>{selectedTask.title}</Typography.Text>
                      <Tag color={taskStatusColor(selectedTask.status)}>{selectedTask.status}</Tag>
                    </Space>
                    <Typography.Paragraph style={{ whiteSpace: "pre-wrap", marginBottom: 0 }}>
                      {selectedTask.goal}
                    </Typography.Paragraph>
                    <Typography.Text type="secondary">创建时间：{formatTs(selectedTask.created_at)}</Typography.Text>
                    <Typography.Text type="secondary">派发时间：{formatTs(selectedTask.dispatched_at)}</Typography.Text>
                    <Typography.Text type="secondary">回执时间：{formatTs(selectedTask.replied_at)}</Typography.Text>
                    <Typography.Text type="secondary">波次：第 {selectedTask.wave_index + 1} 波</Typography.Text>
                    {selectedTask.dependency_task_ids.length ? (
                      <Typography.Text type="secondary">
                        依赖：{selectedTask.dependency_task_ids.map((dependencyId) => taskMap.get(dependencyId)?.title || dependencyId).join(" / ")}
                      </Typography.Text>
                    ) : (
                      <Typography.Text type="secondary">依赖：无</Typography.Text>
                    )}
                    {selectedTask.validation_summary ? (
                      <Alert
                        type={selectedTask.status === "accepted" ? "success" : selectedTask.status === "rejected" ? "error" : "info"}
                        showIcon
                        message={selectedTask.validation_summary}
                      />
                    ) : null}
                    {selectedTask.constraints_text ? (
                      <Alert type="warning" showIcon message={selectedTask.constraints_text} />
                    ) : null}
                    {selectedArtifact ? (
                      <Card size="small" title="最近产物">
                        <Space direction="vertical" size={8} style={{ width: "100%" }}>
                          <Typography.Text type="secondary">{selectedArtifact.summary}</Typography.Text>
                          <Typography.Paragraph style={{ whiteSpace: "pre-wrap", marginBottom: 0 }}>
                            {selectedArtifact.content}
                          </Typography.Paragraph>
                        </Space>
                      </Card>
                    ) : (
                      <Typography.Text type="secondary">当前任务还没有产物快照</Typography.Text>
                    )}
                  </Space>
                ) : (
                  <Typography.Text type="secondary">选择任务后可查看详情</Typography.Text>
                )}
              </Card>

              <Card size="small" title="角色会话">
                {selectedRole ? (
                  <Space direction="vertical" size={8} style={{ width: "100%" }}>
                    <Space wrap>
                      <Typography.Text strong>{selectedRole.name}</Typography.Text>
                      <Tag>{selectedRole.provider}</Tag>
                    </Space>
                    {(conversations[selectedRole.role_id] || []).length ? (
                      <div className="collab-conversation-list">
                        {(conversations[selectedRole.role_id] || []).map((row) => (
                          <Card key={`${selectedRole.role_id}-${row.id}`} size="small">
                            <Space direction="vertical" size={4} style={{ width: "100%" }}>
                              <Space>
                                <Tag>{row.kind}</Tag>
                                <Typography.Text type="secondary">{formatTs(row.created_at)}</Typography.Text>
                              </Space>
                              <Typography.Paragraph style={{ whiteSpace: "pre-wrap", marginBottom: 0 }}>
                                {row.content}
                              </Typography.Paragraph>
                            </Space>
                          </Card>
                        ))}
                      </div>
                    ) : (
                      <Typography.Text type="secondary">还没有加载该角色会话</Typography.Text>
                    )}
                  </Space>
                ) : (
                  <Typography.Text type="secondary">当前没有角色</Typography.Text>
                )}
              </Card>

              <Card size="small" title="最近事件">
                <div className="collab-event-list">
                  {snapshot.recent_events.length ? (
                    snapshot.recent_events.map((event) => (
                      <div key={event.event_id} className="collab-event-item">
                        <Typography.Text>{event.summary}</Typography.Text>
                        <Typography.Text type="secondary">{formatTs(event.created_at)}</Typography.Text>
                      </div>
                    ))
                  ) : (
                    <Typography.Text type="secondary">暂无事件</Typography.Text>
                  )}
                </div>
              </Card>
            </div>
          </div>
        )}
      </div>

      <Drawer title="新建协作工作台" open={createDrawerOpen} onClose={() => setCreateDrawerOpen(false)} width={520}>
        <Form layout="vertical">
          <Form.Item label="工作台名称">
            <Input value={workbenchName} onChange={(event) => setWorkbenchName(event.target.value)} />
          </Form.Item>
          <Form.Item label="项目目录">
            <Space.Compact style={{ width: "100%" }}>
              <Input value={projectDirectory} onChange={(event) => setProjectDirectory(event.target.value)} />
              <Button onClick={() => void pickProjectDirectory()}>选择目录</Button>
            </Space.Compact>
          </Form.Item>
          <Form.Item label="默认角色模板">
            <Space direction="vertical" size={8} style={{ width: "100%" }}>
              {roleDrafts.map((draft, index) => (
                <Card key={`${draft.template_key}-${index}`} size="small">
                  <Space direction="vertical" size={8} style={{ width: "100%" }}>
                    <Select
                      value={draft.template_key}
                      onChange={(value) =>
                        setRoleDrafts((current) =>
                          current.map((item, itemIndex) =>
                            itemIndex === index ? { ...item, template_key: String(value) } : item,
                          ),
                        )
                      }
                      options={templates.map((item) => ({ value: item.template_key, label: item.default_name }))}
                    />
                    <Input
                      value={draft.name}
                      onChange={(event) =>
                        setRoleDrafts((current) =>
                          current.map((item, itemIndex) =>
                            itemIndex === index ? { ...item, name: event.target.value } : item,
                          ),
                        )
                      }
                      placeholder="角色名称"
                    />
                    <Select
                      value={draft.provider}
                      onChange={(value) =>
                        setRoleDrafts((current) =>
                          current.map((item, itemIndex) =>
                            itemIndex === index ? { ...item, provider: String(value) } : item,
                          ),
                        )
                      }
                      options={providerOptions.map((item) => ({ value: item, label: item }))}
                    />
                  </Space>
                </Card>
              ))}
            </Space>
          </Form.Item>
          <Button type="primary" loading={creating} onClick={() => void createNewWorkbench()}>
            创建工作台
          </Button>
        </Form>
      </Drawer>

      <Drawer title="添加角色" open={addRoleDrawerOpen} onClose={() => setAddRoleDrawerOpen(false)} width={420}>
        <Form layout="vertical">
          <Form.Item label="角色模板">
            <Select
              value={newRoleTemplate}
              onChange={(value) => setNewRoleTemplate(String(value))}
              options={templates.map((item) => ({ value: item.template_key, label: item.default_name }))}
            />
          </Form.Item>
          <Form.Item label="角色名称">
            <Input value={newRoleName} onChange={(event) => setNewRoleName(event.target.value)} />
          </Form.Item>
          <Form.Item label="Provider">
            <Select
              value={newRoleProvider}
              onChange={(value) => setNewRoleProvider(String(value))}
              options={providerOptions.map((item) => ({ value: item, label: item }))}
            />
          </Form.Item>
          <Button type="primary" loading={addingRole} onClick={() => void addRoleToWorkbench()}>
            添加角色
          </Button>
        </Form>
      </Drawer>
    </>
  );
}
