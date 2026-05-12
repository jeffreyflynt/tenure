import type { ManagedTurnRef } from "./conversation.js";

export interface Session {
  _id: string;
  user_id: string;
  type: "chat" | "onboarding";
  active_project_id: string | null;
  injected_system_prompt: string;
  managed_history: ManagedTurnRef[];
  token_budget: number;
  tokens_used: number;
  parent_session_id: string | null;
  last_turn_at: Date;
  created_at: Date;
}
