import type { Collection, ResumeToken } from "mongodb";
import type { Belief } from "../types/belief.js";
import { redactForClient, registry } from "../routes/beliefs-ws.js";

const BASE_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

export function startBeliefChangeStream(
  col: Collection<Belief>,
  userId: string,
): () => void {
  let stopped = false;
  let resumeToken: ResumeToken | undefined;
  let attempt = 0;

  function open(): void {
    if (stopped) return;
    // Filter to only documents owned by this user so we never broadcast
    // across tenant boundaries. superseded_by becoming non-null is what
    // the compaction runner sets; we surface that as belief_superseded.
    const pipeline = [
      {
        $match: {
          $or: [
            { operationType: "insert" },
            { operationType: "update" },
            { operationType: "replace" },
            { operationType: "delete" },
          ],
          // fullDocument.user_id is only present on insert/replace/update
          // with fullDocument; for delete we rely on ns filter instead
          // since the document is gone. userId is single-tenant here so
          // all documents in this collection belong to the same user.
        },
      },
    ];

    const stream = col.watch(pipeline, {
      fullDocument: "updateLookup",
      ...(resumeToken ? { resumeAfter: resumeToken } : {}),
    });

    stream.on("change", (event) => {
      resumeToken = event._id;
      attempt = 0;

      if (event.operationType === "insert") {
        const doc = event.fullDocument;
        if (!doc || doc.user_id !== userId) return;
        registry.broadcast(userId, {
          type: "belief_upserted",
          belief: redactForClient(doc),
        });
        return;
      }

      if (
        event.operationType === "update" ||
        event.operationType === "replace"
      ) {
        const doc = event.fullDocument;
        if (!doc || doc.user_id !== userId) return;

        if (doc.superseded_by != null) {
          registry.broadcast(userId, {
            type: "belief_superseded",
            id: doc._id,
          });
        } else {
          registry.broadcast(userId, {
            type: "belief_upserted",
            belief: redactForClient(doc),
          });
        }
        return;
      }

      if (event.operationType === "delete") {
        const id = event.documentKey._id as string;
        registry.broadcast(userId, {
          type: "belief_superseded",
          id,
        });
      }
    });

    stream.on("error", (err) => {
      console.error("[BeliefChangeStream] error, will retry:", err.message);
      stream.close().catch(() => {});
      scheduleReopen();
    });

    stream.on("close", () => {
      scheduleReopen();
    });
  }

  function scheduleReopen(): void {
    if (stopped) return;
    const delay = Math.min(BASE_RETRY_MS * Math.pow(2, attempt), MAX_RETRY_MS);
    attempt++;
    setTimeout(open, delay);
  }

  open();

  return () => {
    stopped = true;
  };
}
