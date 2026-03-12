import { invoke } from "@tauri-apps/api/core";

import type {
  AiTeamConversationRow,
  AiTeamConversationStatusResponse,
  AiTeamExecuteTransition,
  AiTeamRoleKey,
  AiTeamRoleSidResponse,
  AiTeamRoleSnapshot,
  AiTeamRunSnapshot,
  AiTeamSnapshot,
} from "../types/aiTeam";

export type AiTeamCreateTeamInput = {
  name: string;
  projectDirectory: string;
  analystProvider: string;
  coderProvider: string;
};

export type AiTeamCreateTeamResponse = {
  snapshot: AiTeamSnapshot;
};

export type AiTeamInitializeTeamResponse = {
  snapshot: AiTeamSnapshot;
  created_pane_ids: string[];
};

export type AiTeamBindRoleSidResponse = {
  role: AiTeamRoleSnapshot;
  bound: boolean;
};

export type AiTeamBindAllRoleSidsResponse = {
  snapshot: AiTeamSnapshot;
  bound_roles: string[];
  failed_roles: string[];
};

export type AiTeamSendMessageResponse = {
  accepted: boolean;
  pane_id: string;
  session_id: string;
  role: string;
  sent_at: number;
};

export type AiTeamSendHelloResponse = {
  accepted: boolean;
  pane_id: string;
  role: string;
  sent_at: number;
};

export type AiTeamSendAllHelloResponse = {
  snapshot: AiTeamSnapshot;
  sent_roles: string[];
  failed_roles: string[];
};

export type AiTeamLoadConversationResponse = {
  role: string;
  session_id: string;
  rows: AiTeamConversationRow[];
  total_rows: number;
  loaded_rows: number;
  has_more: boolean;
};

export type AiTeamSubmitRequirementResponse = {
  snapshot: AiTeamSnapshot;
  run: AiTeamRunSnapshot;
};

export type AiTeamExecuteNextResponse = {
  snapshot: AiTeamSnapshot;
  run: AiTeamRunSnapshot;
  transition: AiTeamExecuteTransition;
  waiting_role: AiTeamRoleKey | null;
  done: boolean;
};

export async function aiTeamCreateTeam(input: AiTeamCreateTeamInput) {
  return invoke<AiTeamCreateTeamResponse>("ai_team_create_team", input);
}

export async function aiTeamGetSnapshot(teamId: string) {
  return invoke<AiTeamSnapshot>("ai_team_get_snapshot", { teamId });
}

export async function aiTeamInitializeTeam(teamId: string) {
  return invoke<AiTeamInitializeTeamResponse>("ai_team_initialize_team", { teamId });
}

export async function aiTeamReadRoleSid(teamId: string, roleKey: AiTeamRoleKey) {
  return invoke<AiTeamRoleSidResponse>("ai_team_read_role_sid", { teamId, roleKey });
}

export async function aiTeamSetRoleSid(teamId: string, roleKey: AiTeamRoleKey, sessionId: string) {
  return invoke<AiTeamRoleSidResponse>("ai_team_set_role_sid", { teamId, roleKey, sessionId });
}

export async function aiTeamClearRoleSid(teamId: string, roleKey: AiTeamRoleKey) {
  return invoke<AiTeamRoleSidResponse>("ai_team_clear_role_sid", { teamId, roleKey });
}

export async function aiTeamRefreshRoleSid(teamId: string, roleKey: AiTeamRoleKey) {
  return invoke<AiTeamRoleSidResponse>("ai_team_refresh_role_sid", { teamId, roleKey });
}

export async function aiTeamSendRoleHello(teamId: string, roleKey: AiTeamRoleKey, helloMessage = "你好") {
  return invoke<AiTeamSendHelloResponse>("ai_team_send_role_hello", { teamId, roleKey, helloMessage });
}

export async function aiTeamSendAllRoleHello(teamId: string, helloMessage = "你好") {
  return invoke<AiTeamSendAllHelloResponse>("ai_team_send_all_role_hello", { teamId, helloMessage });
}

export async function aiTeamBindRoleSid(
  teamId: string,
  roleKey: AiTeamRoleKey,
  helloMessage = "你好",
  timeoutSecs = 20,
) {
  return invoke<AiTeamBindRoleSidResponse>("ai_team_bind_role_sid", {
    teamId,
    roleKey,
    helloMessage,
    timeoutSecs,
  });
}

export async function aiTeamBindAllRoleSids(teamId: string, helloMessage = "你好", timeoutSecs = 20) {
  return invoke<AiTeamBindAllRoleSidsResponse>("ai_team_bind_all_role_sids", {
    teamId,
    helloMessage,
    timeoutSecs,
  });
}

export async function aiTeamSendMessage(
  teamId: string,
  roleKey: AiTeamRoleKey,
  message: string,
  submit = true,
) {
  return invoke<AiTeamSendMessageResponse>("ai_team_send_message", {
    teamId,
    roleKey,
    message,
    submit,
  });
}

export async function aiTeamLoadConversation(
  teamId: string,
  roleKey: AiTeamRoleKey,
  limit = 50,
  offset = 0,
  fromEnd = true,
) {
  return invoke<AiTeamLoadConversationResponse>("ai_team_load_conversation", {
    teamId,
    roleKey,
    limit,
    offset,
    fromEnd,
  });
}

export async function aiTeamIsConversationFinished(
  teamId: string,
  roleKey: AiTeamRoleKey,
  idleThresholdSecs = 5,
) {
  return invoke<AiTeamConversationStatusResponse>("ai_team_is_conversation_finished", {
    teamId,
    roleKey,
    idleThresholdSecs,
  });
}

export async function aiTeamSubmitRequirement(teamId: string, requirement: string, autoMode = true) {
  return invoke<AiTeamSubmitRequirementResponse>("ai_team_submit_requirement", {
    teamId,
    requirement,
    autoMode,
  });
}

export async function aiTeamExecuteNext(teamId: string, runId: string) {
  return invoke<AiTeamExecuteNextResponse>("ai_team_execute_next", {
    teamId,
    runId,
  });
}
