export type CollabRolePhase = "draft" | "initialized" | "ready" | "running" | "error";

export type CollabRunStatus = "draft" | "active" | "completed" | "cancelled" | "failed";

export type CollabTaskStatus =
  | "draft"
  | "queued"
  | "dispatched"
  | "replied"
  | "accepted"
  | "rejected"
  | "cancelled";

export type CollabCapabilityManifestItem = {
  key: string;
  label: string;
  description: string;
  source: string;
  manual_only: boolean;
};

export type CollabPromptPack = {
  system_prompt: string;
  reply_contract: string;
  can_suggest_followups: boolean;
};

export type CollabRoleTemplate = {
  template_key: string;
  title: string;
  description: string;
  default_name: string;
  capabilities: CollabCapabilityManifestItem[];
  prompt_pack: CollabPromptPack;
};

export type CollabConversationRow = {
  id: string;
  kind: string;
  content: string;
  created_at: number;
  preview_truncated: boolean;
};

export type CollabRoleSnapshot = {
  role_id: string;
  role_key: string;
  template_key: string;
  name: string;
  provider: string;
  pane_id: string;
  session_id: string;
  work_directory: string;
  phase: CollabRolePhase;
  runtime_ready: boolean;
  sid_bound: boolean;
  responding: boolean;
  completed: boolean;
  idle_secs: number;
  last_input_at: number;
  last_output_at: number;
  last_error: string | null;
  capabilities: CollabCapabilityManifestItem[];
};

export type CollabRunSnapshot = {
  run_id: string;
  workbench_id: string;
  title: string;
  goal: string;
  status: CollabRunStatus;
  final_summary: string | null;
  created_at: number;
  updated_at: number;
};

export type CollabTaskCardSnapshot = {
  task_id: string;
  workbench_id: string;
  run_id: string;
  source_role_id: string | null;
  target_role_id: string;
  title: string;
  goal: string;
  constraints_text: string;
  input_summary: string;
  expected_output: string;
  status: CollabTaskStatus;
  latest_reply_summary: string | null;
  latest_artifact_id: string | null;
  last_error: string | null;
  created_at: number;
  dispatched_at: number;
  replied_at: number;
  resolved_at: number;
  updated_at: number;
};

export type CollabEventSnapshot = {
  event_id: string;
  workbench_id: string;
  run_id: string | null;
  task_id: string | null;
  role_id: string | null;
  event_type: string;
  summary: string;
  payload_json: string | null;
  created_at: number;
};

export type CollabArtifactSnapshot = {
  artifact_id: string;
  workbench_id: string;
  run_id: string | null;
  task_id: string | null;
  role_id: string | null;
  kind: string;
  title: string;
  summary: string;
  content: string;
  pane_id: string;
  session_id: string;
  created_at: number;
};

export type CollabWorkbenchSnapshot = {
  workbench_id: string;
  name: string;
  project_directory: string;
  runtime_directory: string;
  roles: CollabRoleSnapshot[];
  active_run: CollabRunSnapshot | null;
  task_cards: CollabTaskCardSnapshot[];
  recent_events: CollabEventSnapshot[];
  recent_artifacts: CollabArtifactSnapshot[];
};

export type CollabRoleInput = {
  role_key?: string;
  template_key: string;
  name?: string;
  provider: string;
};

export type CollabRoleSidResponse = {
  role_id: string;
  pane_id: string;
  session_id: string;
  sid_bound: boolean;
};
