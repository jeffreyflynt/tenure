import type { Collection, Db } from "mongodb";
import type { Belief } from "../types/belief.js";
import type { Turn } from "../history/manager.js";
import type { Session } from "../types/session.js";
import type { ExtractionJob } from "../types/job.js";
import type { ErrorLog } from "../types/error.js";
import type { PersonaDoc } from "../context/personaCache.js";
import type { CompactionLogEntry } from "../jobs/compactionRunner.js";

export interface ConfigDoc {
  _id: string;
  key: string;
  value: unknown;
  encrypted: boolean;
  updatedAt: Date;
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
  beliefs: Collection<Belief>;
  turns: Collection<Turn>;
  sessions: Collection<Session>;
  jobs: Collection<ExtractionJob>;
  errors: Collection<ErrorLog>;
  config: Collection<ConfigDoc>;
  topic_index: Collection<TopicIndexEntry>;
  persona_cache: Collection<PersonaDoc>;
  compaction_log: Collection<CompactionLogEntry>;
}

export function getCollections(db: Db): Collections {
  return {
    db,
    beliefs: db.collection<Belief>("beliefs"),
    turns: db.collection<Turn>("turns"),
    sessions: db.collection<Session>("sessions"),
    jobs: db.collection<ExtractionJob>("jobs"),
    errors: db.collection<ErrorLog>("errors"),
    config: db.collection<ConfigDoc>("config"),
    topic_index: db.collection<TopicIndexEntry>("topic_index"),
    persona_cache: db.collection<PersonaDoc>("persona_cache"),
    compaction_log: db.collection<CompactionLogEntry>("compaction_log"),
  };
}
