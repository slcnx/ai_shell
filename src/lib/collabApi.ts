import { invoke } from "@tauri-apps/api/core";

import type {
  CollabArtifactSnapshot,
  CollabConversationRow,
  CollabRoleInput,
  CollabRoleSidResponse,
  CollabRoleSnapshot,
  CollabRoleTemplate,
  CollabRunSnapshot,
  CollabTaskCardSnapshot,
  CollabWorkbenchSnapshot,
} from "../types/collab";

export type CollabCreateWorkbenchInput = {
  name: string;
  projectDirectory: string;
  roles: CollabRoleInput[];
};

export type CollabCreateWorkbenchResponse = {
  snapshot: CollabWorkbenchSnapshot;
};

export type CollabInitializeRolesResponse = {
  snapshot: CollabWorkbenchSnapshot;
  created_pane_ids: string[];
};

export type CollabAddRoleResponse = {
  snapshot: CollabWorkbenchSnapshot;
  role: CollabRoleSnapshot;
};

export type CollabCreateRunResponse = {
  snapshot: CollabWorkbenchSnapshot;
  run: CollabRunSnapshot;
};

export type CollabCreateTaskCardResponse = {
  snapshot: CollabWorkbenchSnapshot;
  task: CollabTaskCardSnapshot;
};

export type CollabDispatchTaskCardResponse = {
  snapshot: CollabWorkbenchSnapshot;
  task: CollabTaskCardSnapshot;
  sent_at: number;
};

export type CollabCollectRoleReplyResponse = {
  snapshot: CollabWorkbenchSnapshot;
  task: CollabTaskCardSnapshot;
  artifact: CollabArtifactSnapshot | null;
  waiting: boolean;
};

export type CollabTaskMutationResponse = {
  snapshot: CollabWorkbenchSnapshot;
  task: CollabTaskCardSnapshot;
};

export type CollabCompleteRunResponse = {
  snapshot: CollabWorkbenchSnapshot;
  run: CollabRunSnapshot;
  artifact: CollabArtifactSnapshot | null;
};

export type CollabSendRoleMessageResponse = {
  accepted: boolean;
  pane_id: string;
  session_id: string;
  role_id: string;
  sent_at: number;
};

export type CollabConversationResponse = {
  role_id: string;
  session_id: string;
  rows: CollabConversationRow[];
  total_rows: number;
  loaded_rows: number;
  has_more: boolean;
};

export async function collabListRoleTemplates() {
  return invoke<CollabRoleTemplate[]>("collab_list_role_templates");
}

export async function collabCreateWorkbench(input: CollabCreateWorkbenchInput) {
  return invoke<CollabCreateWorkbenchResponse>("collab_create_workbench", input);
}

export async function collabGetSnapshot(workbenchId: string) {
  return invoke<CollabWorkbenchSnapshot>("collab_get_snapshot", { workbenchId });
}

export async function collabInitializeRoles(workbenchId: string) {
  return invoke<CollabInitializeRolesResponse>("collab_initialize_roles", { workbenchId });
}

export async function collabAddRole(workbenchId: string, role: CollabRoleInput) {
  return invoke<CollabAddRoleResponse>("collab_add_role", { workbenchId, role });
}

export async function collabRemoveRole(workbenchId: string, roleId: string) {
  return invoke<CollabWorkbenchSnapshot>("collab_remove_role", { workbenchId, roleId });
}

export async function collabSetRoleSid(workbenchId: string, roleId: string, sessionId: string) {
  return invoke<CollabRoleSidResponse>("collab_set_role_sid", { workbenchId, roleId, sessionId });
}

export async function collabClearRoleSid(workbenchId: string, roleId: string) {
  return invoke<CollabRoleSidResponse>("collab_clear_role_sid", { workbenchId, roleId });
}

export async function collabSendRoleMessage(
  workbenchId: string,
  roleId: string,
  message: string,
  submit = true,
) {
  return invoke<CollabSendRoleMessageResponse>("collab_send_role_message", {
    workbenchId,
    roleId,
    message,
    submit,
  });
}

export async function collabLoadRoleConversation(
  workbenchId: string,
  roleId: string,
  limit = 60,
  offset = 0,
  fromEnd = true,
) {
  return invoke<CollabConversationResponse>("collab_load_role_conversation", {
    workbenchId,
    roleId,
    limit,
    offset,
    fromEnd,
  });
}

export async function collabCreateRun(workbenchId: string, title: string, goal: string) {
  return invoke<CollabCreateRunResponse>("collab_create_run", { workbenchId, title, goal });
}

export async function collabCreateTaskCard(input: {
  workbenchId: string;
  runId: string;
  targetRoleId: string;
  sourceRoleId?: string;
  title: string;
  goal: string;
  constraintsText?: string;
  inputSummary?: string;
  expectedOutput?: string;
}) {
  return invoke<CollabCreateTaskCardResponse>("collab_create_task_card", input);
}

export async function collabDispatchTaskCard(workbenchId: string, taskId: string) {
  return invoke<CollabDispatchTaskCardResponse>("collab_dispatch_task_card", {
    workbenchId,
    taskId,
  });
}

export async function collabCollectRoleReply(workbenchId: string, taskId: string, idleThresholdSecs = 5) {
  return invoke<CollabCollectRoleReplyResponse>("collab_collect_role_reply", {
    workbenchId,
    taskId,
    idleThresholdSecs,
  });
}

export async function collabAcceptReply(workbenchId: string, taskId: string, note = "") {
  return invoke<CollabTaskMutationResponse>("collab_accept_reply", {
    workbenchId,
    taskId,
    note,
  });
}

export async function collabRejectReply(workbenchId: string, taskId: string, note = "") {
  return invoke<CollabTaskMutationResponse>("collab_reject_reply", {
    workbenchId,
    taskId,
    note,
  });
}

export async function collabCompleteRun(workbenchId: string, runId: string, finalSummary: string) {
  return invoke<CollabCompleteRunResponse>("collab_complete_run", {
    workbenchId,
    runId,
    finalSummary,
  });
}
