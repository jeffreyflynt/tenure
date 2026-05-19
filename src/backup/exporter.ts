import type { Db } from "mongodb";
import type { RuntimeConfigStore } from "../config/runtime.js";
import type { Belief } from "../types/belief.js";
import type { CompactionLogEntry } from "../jobs/compactionRunner.js";
import type { PersonaDoc } from "../context/personaCache.js";
import type {
  TenureExport,
  ExportedBelief,
  ExportedPersonaDoc,
} from "./types.js";
import { encryptArchive } from "./crypto.js";

export interface ExporterDeps {
  db: Db;
  runtimeStore: RuntimeConfigStore;
  userId: string;
}

export class BackupExporter {
  constructor(private readonly deps: ExporterDeps) {}

  async export(passphrase: string): Promise<Buffer> {
    const payload = await this.buildPayload();
    const json = Buffer.from(JSON.stringify(payload, null, 2), "utf-8");
    return encryptArchive(json, passphrase);
  }

  async exportUnencrypted(): Promise<TenureExport> {
    return this.buildPayload();
  }

  private async buildPayload(): Promise<TenureExport> {
    const { db, runtimeStore, userId } = this.deps;

    const [beliefs, runtimeConfig, personaDoc, compactionLog, sessions] =
      await Promise.all([
        db.collection<Belief>("beliefs").find({ user_id: userId }).toArray(),
        runtimeStore.load(),
        db.collection<PersonaDoc>("persona_cache").findOne({ _id: userId }),
        db
          .collection<CompactionLogEntry>("compaction_log")
          .find({ user_id: userId })
          .toArray(),
        db.collection("sessions").find({ userId }).toArray(),
      ]);

    return {
      version: 1,
      exported_at: new Date().toISOString(),
      user_id: userId,
      beliefs: beliefs.map((b) => this.serializeBelief(b)),
      runtime_config: {
        default_provider: runtimeConfig.default_provider,
        default_model: runtimeConfig.default_model,
        openai_api_key: runtimeConfig.openai_api_key,
        anthropic_api_key: runtimeConfig.anthropic_api_key,
        openai_base_url: runtimeConfig.openai_base_url,
        anthropic_base_url: runtimeConfig.anthropic_base_url,
        openai_endpoint_flavor: runtimeConfig.openai_endpoint_flavor,
        always_on_token_target: runtimeConfig.always_on_token_target,
        managed_history_token_cap: runtimeConfig.managed_history_token_cap,
        error_retention_days: runtimeConfig.error_retention_days,
        strict_model_tiers: runtimeConfig.strict_model_tiers,
        extraction_enabled: runtimeConfig.extraction_enabled,
      },
      persona_cache: personaDoc ? this.serializePersona(personaDoc) : null,
      compaction_log: compactionLog.map((entry) => ({
        _id: entry._id,
        user_id: entry.user_id,
        scope: entry.scope,
        belief_type: entry.belief_type,
        ran_at: entry.ran_at.toISOString(),
        merged_count: entry.merged_count,
      })),
      sessions: sessions.map((s) => ({
        _id: s._id.toString(),
        userId: s.userId as string,
        type: (s.type as string) ?? "chat",
        providerId: (s.providerId as string) ?? null,
        model: (s.model as string) ?? null,
        activeScope: (s.activeScope as string[]) ?? [],
        agentId: (s.agentId as string) ?? null,
        turnCounter: (s.turnCounter as number) ?? 0,
        createdAt:
          (s.createdAt as Date)?.toISOString() ?? new Date().toISOString(),
        lastUsedAt:
          (s.lastUsedAt as Date)?.toISOString() ?? new Date().toISOString(),
      })),
    };
  }

  private serializeBelief(b: Belief): ExportedBelief {
    return {
      _id: b._id,
      type: b.type,
      subtype: b.subtype ?? null,
      canonical_name: b.canonical_name,
      aliases: b.aliases,
      content: b.content,
      why_it_matters: b.why_it_matters,
      scope: b.scope,
      provenance: {
        session_id: b.provenance.session_id,
        turn_id: b.provenance.turn_id,
        extracted_at: b.provenance.extracted_at.toISOString(),
        source_model: b.provenance.source_model,
      },
      epistemic_status: b.epistemic_status,
      confidence: b.confidence,
      reinforcement_count: b.reinforcement_count,
      last_reinforced_at: b.last_reinforced_at.toISOString(),
      pinned: b.pinned,
      user_edited: b.user_edited,
      superseded_by: b.superseded_by,
      resolved_at: b.resolved_at?.toISOString() ?? null,
      change_log: b.change_log.map((entry) => ({
        changed_at: entry.changed_at.toISOString(),
        trigger: entry.trigger,
        changed_by_session: entry.changed_by_session ?? null,
        changed_by_turn: entry.changed_by_turn ?? null,
      })),
      ...(b.expertise_domain && { expertise_domain: b.expertise_domain }),
      ...(b.expertise_depth && { expertise_depth: b.expertise_depth }),
      ...(b.expertise_evidence_count != null && {
        expertise_evidence_count: b.expertise_evidence_count,
      }),
      ...(b.compaction_note && { compaction_note: b.compaction_note }),
      created_at: b.created_at.toISOString(),
      updated_at: b.updated_at.toISOString(),
    };
  }

  private serializePersona(doc: PersonaDoc): ExportedPersonaDoc {
    return {
      universal: doc.universal,
      contributing_belief_ids: doc.contributing_belief_ids,
      beliefs_hash: doc.beliefs_hash,
      generated_at: doc.generated_at.toISOString(),
      model: doc.model,
    };
  }
}
