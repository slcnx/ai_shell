export type AiTeamRoleKey = "analyst" | "coder";

export type AiTeamRolePhase =
  | "draft"
  | "initialized"
  | "binding_sid"
  | "ready"
  | "running"
  | "error";

export type AiTeamRunStage =
  | "created"
  | "analyst_dispatched"
  | "waiting_analyst"
  | "coder_dispatched"
  | "waiting_coder"
  | "analyst_review_dispatched"
  | "finished"
  | "failed";

export type AiTeamExecuteTransition =
  | "none"
  | "sent_to_analyst"
  | "waiting_analyst"
  | "delegated_to_coder"
  | "waiting_coder"
  | "sent_back_to_analyst"
  | "finished"
  | "failed";

export type AiTeamConversationRow = {
  id: string;
  kind: string;
  content: string;
  created_at: number;
  preview_truncated: boolean;
};

export type AiTeamRoleSnapshot = {
  role_key: AiTeamRoleKey;
  name: string;
  provider: string;
  pane_id: string;
  session_id: string;
  work_directory: string;
  phase: AiTeamRolePhase;
  runtime_ready: boolean;
  sid_bound: boolean;
  responding: boolean;
  completed: boolean;
  idle_secs: number;
  last_input_at: number;
  last_output_at: number;
  last_error: string | null;
};

export type AiTeamRunSnapshot = {
  run_id: string;
  team_id: string;
  requirement: string;
  stage: AiTeamRunStage;
  auto_mode: boolean;
  last_action: string | null;
  final_answer: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
};

export type AiTeamSnapshot = {
  team_id: string;
  name: string;
  project_directory: string;
  runtime_directory: string;
  roles: AiTeamRoleSnapshot[];
  active_run: AiTeamRunSnapshot | null;
};

export type AiTeamRoleSidResponse = {
  role: string;
  pane_id: string;
  session_id: string;
  sid_bound: boolean;
};

export type AiTeamConversationStatusResponse = {
  role: string;
  session_id: string;
  runtime_ready: boolean;
  responding: boolean;
  completed: boolean;
  idle_secs: number;
  last_input_at: number;
  last_output_at: number;
};
