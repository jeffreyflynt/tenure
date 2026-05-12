export type TurnSignal =
  | "substantive"
  | "acknowledgment"
  | "clarification"
  | "correction";
export type TurnState = "kept" | "collapsed" | "pinned";

export interface ConversationTurn {
  _id: string;
  user_id: string;
  session_id: string;
  turn_index: number;
  role: "user" | "assistant";
  content: string;
  model: string | null;
  provider: string | null;
  created_at: Date;
}

export interface ManagedTurnRef {
  turn_id: string;
  role: "user" | "assistant";
  turn_signal: TurnSignal;
  state: TurnState;
  has_open_question: boolean;
  belief_candidate_ids: string[];
  topics: string[];
  collapsed_summary: string | null;
  created_at: Date;
}
