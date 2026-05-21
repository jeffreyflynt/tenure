import type { Collection, Db } from "mongodb";
import type { Belief } from "../types/belief.js";
import type { Turn } from "../history/manager.js";
import type { Session } from "../types/session.js";
import type { ExtractionJob } from "../types/job.js";
import type { ErrorLog } from "../types/error.js";
import type { PersonaDoc } from "../context/personaCache.js";
import type {
  CompactionLogEntry,
  BeliefContradiction,
} from "../jobs/compactionRunner.js";

export interface ConfigDoc {
  _id: string;
  key: string;
  value: unknown;
  encrypted: boolean;
  updatedAt: Date;
}

export interface OnboardingDraftDoc {
  _id: string;
  user_id: string;
  sidecarJson: string;
  modelId: string;
  created_at: Date;
}

export interface FileMetaDoc {
  _id: string;
  user_id: string;
  path: string;
  size_bytes: number;
  belief_ids: string[];
  created_at: Date;
  updated_at: Date;
}

export interface TopicIndexEntry {
  _id: string;
  user_id: string;
  topic: string;
  belief_ids: string[];
  updated_at: Date;
}

export interface Collections {
  db: Db;
  beliefs_plain: Collection<Belief>;
  beliefs: Collection<Belief>;
  turns: Collection<Turn>;
  sessions: Collection<Session>;
  jobs: Collection<ExtractionJob>;
  errors: Collection<ErrorLog>;
  config: Collection<ConfigDoc>;
  topic_index: Collection<TopicIndexEntry>;
  persona_cache: Collection<PersonaDoc>;
  compaction_log: Collection<CompactionLogEntry>;
  contradictions: Collection<BeliefContradiction>;
  onboarding_drafts: Collection<OnboardingDraftDoc>;
  file_meta: Collection<FileMetaDoc>;
}

export function getCollections(db: Db, plainDb?: Db): Collections {
  const plain = plainDb ?? db;
  return {
    db,
    beliefs_plain: plain.collection<Belief>("beliefs"),
    beliefs: db.collection<Belief>("beliefs"),
    turns: db.collection<Turn>("turns"),
    sessions: db.collection<Session>("sessions"),
    jobs: db.collection<ExtractionJob>("jobs"),
    errors: db.collection<ErrorLog>("errors"),
    config: db.collection<ConfigDoc>("config"),
    topic_index: db.collection<TopicIndexEntry>("topic_index"),
    persona_cache: db.collection<PersonaDoc>("persona_cache"),
    compaction_log: db.collection<CompactionLogEntry>("compaction_log"),
    contradictions: db.collection<BeliefContradiction>("belief_contradictions"),
    onboarding_drafts: db.collection<OnboardingDraftDoc>("onboarding_drafts"),
    file_meta: db.collection<FileMetaDoc>("file_meta"),
  };
}
