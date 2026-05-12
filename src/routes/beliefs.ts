import type { FastifyInstance } from "fastify";
import type { Collection, WithId } from "mongodb";
import type { Belief } from "../types/belief.js";
import type { ExtractionJobQueue } from "../jobs/queue.js";
import type { RuntimeConfigStore } from "../config/runtime.js";
import type { ExtractionWorkerLike } from "../extraction/worker.js";
import type { ProviderRegistry } from "../providers/registry.js";
import {
  buildImportExtractionPrompt,
  buildImportExtractionSystemPrompt,
} from "../extraction/importPrompt.js";
import { extractJsonBlock } from "../extraction/extractJson.js";

export interface BeliefsDeps {
  beliefs: Collection<Belief>;
  userId: string;
  jobs: ExtractionJobQueue;
  extractionWorker: ExtractionWorkerLike;
  runtimeStore: RuntimeConfigStore;
  providers: ProviderRegistry;
}

export function registerBeliefsRoutes(
  app: FastifyInstance,
  deps: BeliefsDeps,
): void {
  const { beliefs: col, userId } = deps;

  app.get<{
    Querystring: {
      scope?: string;
      type?: string;
      status?: string;
      limit?: string;
    };
  }>("/v1/beliefs", async (req) => {
    const q = req.query;
    const filter: Record<string, unknown> = { user_id: userId };

    if (q.scope) filter.scope = { $in: q.scope.split(",") };
    if (q.type) filter.type = { $in: q.type.split(",") };
    if (q.status) {
      filter.epistemic_status = { $in: q.status.split(",") };
    } else {
      filter.resolved_at = null;
      filter.superseded_by = null;
    }

    const limit = Math.min(parseInt(q.limit ?? "40", 10) || 40, 200);
    const docs = await col.find(filter).limit(limit).toArray();
    const total = await col.countDocuments(filter);

    return { beliefs: docs.map(redactForClient), total };
  });

  app.get<{ Params: { id: string } }>("/v1/beliefs/:id", async (req, reply) => {
    const doc = await col.findOne({ _id: req.params.id, user_id: userId });
    if (!doc) {
      return reply.code(404).send({ error: { message: "belief not found" } });
    }
    return { belief: redactForClient(doc) };
  });

  app.patch<{
    Params: { id: string };
    Body: {
      content?: string;
      epistemic_status?: string;
      pinned?: boolean;
      canonical_name?: string;
      why_it_matters?: string;
    };
  }>("/v1/beliefs/:id", async (req, reply) => {
    const { id } = req.params;
    const patch = req.body ?? {};

    const current = await col.findOne({ _id: id, user_id: userId });
    if (!current) {
      return reply.code(404).send({ error: { message: "belief not found" } });
    }

    const $set: Record<string, unknown> = { updated_at: new Date() };
    const logEntries: Array<{
      changed_at: Date;
      trigger: string;
      previous_content?: string | null;
      previous_epistemic_status?: string | null;
      changed_by_session: null;
      changed_by_turn: null;
    }> = [];

    const mutable = [
      "content",
      "epistemic_status",
      "pinned",
      "canonical_name",
      "why_it_matters",
    ] as const;

    for (const field of mutable) {
      const newVal = patch[field];
      if (
        newVal !== undefined &&
        newVal !== (current as Record<string, unknown>)[field]
      ) {
        $set[field] = newVal;
        logEntries.push({
          changed_at: new Date(),
          trigger: "user_correction",
          ...(field === "content" ? { previous_content: current.content } : {}),
          ...(field === "epistemic_status"
            ? { previous_epistemic_status: current.epistemic_status }
            : {}),
          changed_by_session: null,
          changed_by_turn: null,
        });
      }
    }

    if (logEntries.length === 0) {
      return { belief: redactForClient(current) };
    }

    const result = await col.findOneAndUpdate(
      { _id: id, user_id: userId },
      {
        $set,
        $push: { change_log: { $each: logEntries } } as any,
      },
      { returnDocument: "after" },
    );

    return { belief: result ? redactForClient(result) : null };
  });

  app.delete<{ Params: { id: string } }>(
    "/v1/beliefs/:id",
    async (req, reply) => {
      const { id } = req.params;
      const current = await col.findOne({ _id: id, user_id: userId });
      if (!current) {
        return reply.code(404).send({ error: { message: "belief not found" } });
      }

      await col.findOneAndUpdate(
        { _id: id, user_id: userId },
        {
          $set: {
            epistemic_status: "superseded",
            resolved_at: new Date(),
            updated_at: new Date(),
          },
          $push: {
            change_log: {
              changed_at: new Date(),
              trigger: "user_deletion",
              previous_epistemic_status: current.epistemic_status,
              changed_by_session: null,
              changed_by_turn: null,
            },
          } as any,
        },
      );

      return { ok: true };
    },
  );

  app.post<{ Body: { text: string; source_label?: string; scope?: string[] } }>(
    "/v1/beliefs/ingest",
    async (req, reply) => {
      const { text, source_label, scope } = req.body ?? {};

      if (!text?.trim()) {
        return reply.code(400).send({ error: { message: "text is required" } });
      }
      if (text.length > 50_000) {
        return reply.code(400).send({
          error: {
            message: "text exceeds maximum length of 50,000 characters",
          },
        });
      }

      const cfg = await deps.runtimeStore.load();
      if (!cfg.default_model) {
        return reply.code(400).send({
          error: { message: "no default model configured" },
        });
      }

      let adapter;
      try {
        adapter = deps.providers.detectFromModel(
          cfg.default_model,
          cfg.default_provider,
        );
      } catch {
        return reply.code(502).send({
          error: { message: "no provider configured for import extraction" },
        });
      }

      let extractionRaw: string;
      try {
        const resp = await adapter.call(
          {
            model: cfg.default_model,
            messages: [
              {
                role: "user",
                content: buildImportExtractionPrompt(
                  text.trim(),
                  source_label ?? "manual import",
                ),
              },
            ],
            temperature: 0.1,
            max_tokens: 2000,
          },
          buildImportExtractionSystemPrompt(
            scope?.length ? { declaredScope: scope } : {},
          ),
        );
        extractionRaw = resp.content;
      } catch (err) {
        req.log.error({ err }, "import extraction LLM call failed");
        return reply.code(502).send({
          error: { message: "extraction LLM call failed" },
        });
      }

      const sidecarJson = extractJsonBlock(extractionRaw);
      if (!sidecarJson) {
        return reply.code(200).send({
          ok: true,
          belief_count: 0,
          parse_failed: true,
        });
      }

      try {
        const jobId = await deps.jobs.enqueueImport({
          userId: deps.userId,
          sourceLabel: source_label ?? "manual import",
          sidecarJson,
          sourceModel: cfg.default_model,
          ...(scope?.length ? { scope } : {}),
        });

        deps.extractionWorker
          .processById(jobId)
          .catch((err) =>
            req.log.warn({ err, jobId }, "inline import extraction failed"),
          );

        return { ok: true, job_id: jobId };
      } catch (err) {
        req.log.error({ err }, "import enqueue failed");
        return reply.code(500).send({
          error: { message: "failed to enqueue import" },
        });
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    "/v1/beliefs/:id/history",
    async (req, reply) => {
      const doc = await col.findOne(
        { _id: req.params.id, user_id: userId },
        { projection: { change_log: 1, created_at: 1, _id: 1 } },
      );
      if (!doc) {
        return reply.code(404).send({ error: { message: "belief not found" } });
      }
      return {
        belief_id: doc._id,
        created_at: doc.created_at,
        change_log: doc.change_log ?? [],
      };
    },
  );
}

function redactForClient(b: WithId<Belief>) {
  return {
    id: b._id,
    type: b.type,
    canonical_name: b.canonical_name,
    content: b.content,
    why_it_matters: b.why_it_matters,
    epistemic_status: b.epistemic_status,
    confidence: b.confidence,
    pinned: b.pinned,
  };
}
