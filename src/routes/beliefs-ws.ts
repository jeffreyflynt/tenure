import type { FastifyInstance } from "fastify";
import type { Collection, WithId } from "mongodb";
import type { WebSocket } from "@fastify/websocket";
import type { RawData } from "ws";
import type { Belief } from "../types/belief.js";
import type { FileMetaDoc } from "../db/collections.js";
import { BeliefWriter } from "../extraction/beliefWriter.js";
import type { WorkspaceStateCache } from "../workspace/stateCache.js";

export type ClientMessage =
  | { type: "subscribe"; scope: string }
  | { type: "fetch_beliefs"; scope: string; active_file: string | null }
  | { type: "fetch_file_beliefs"; file_path: string; scope: string }
  | {
      type: "patch_belief";
      id: string;
      patch: {
        content?: string;
        epistemic_status?: string;
        pinned?: boolean;
        canonical_name?: string;
        why_it_matters?: string;
        aliases?: string[];
      };
    }
  | {
      type: "record_belief";
      belief_type: "decision" | "preference" | "entity" | "relation";
      content: string;
      why_it_matters: string;
      scope: string[];
      canonical_name: string;
      active_file: string | null;
      active_language: string | null;
      project_scope: string | null;
    }
  | { type: "file_meta"; path: string; size_bytes: number }
  | { type: "rename_file"; old_path: string; new_path: string }
  | {
      type: "workspace_state";
      workspace_root: string;
      project_name: string;
      git_remote: string | null;
      active_file: string | null;
      active_language: string | null;
    };

export type ServerMessage =
  | { type: "beliefs_snapshot"; beliefs: BeliefSummary[]; scope: string }
  | { type: "belief_upserted"; belief: BeliefSummary }
  | { type: "belief_superseded"; id: string }
  | {
      type: "contradiction_detected";
      contradiction: {
        belief_ids: [string, string];
        reason: string;
        scope: string;
      };
    }
  | { type: "patch_ack"; id: string; belief: BeliefSummary }
  | { type: "record_ack"; belief: BeliefSummary }
  | { type: "scope_confirmed"; scope: string; active_file: string | null }
  | { type: "error"; request_type: string; message: string };

export interface BeliefSummary {
  id: string;
  type: string;
  canonical_name: string;
  content: string;
  why_it_matters: string;
  epistemic_status: string;
  confidence: number;
  pinned: boolean;
  scope: string[];
  aliases: string[];
  origin_context?: {
    active_file: string | null;
    language: string | null;
    project_scope: string | null;
  } | null;
}

export class ConnectionRegistry {
  private connections = new Map<string, Set<WebSocket>>();

  add(userId: string, socket: WebSocket): void {
    if (!this.connections.has(userId)) {
      this.connections.set(userId, new Set());
    }
    this.connections.get(userId)!.add(socket);
  }

  remove(userId: string, socket: WebSocket): void {
    this.connections.get(userId)?.delete(socket);
  }

  broadcast(userId: string, message: ServerMessage): void {
    const sockets = this.connections.get(userId);
    if (!sockets) return;
    const payload = JSON.stringify(message);
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) {
        socket.send(payload);
      }
    }
  }
}

export const registry = new ConnectionRegistry();

export interface BeliefsWsDeps {
  beliefs: Collection<Belief>;
  fileMeta: Collection<FileMetaDoc>;
  userId: string;
  beliefWriter: BeliefWriter;
  workspaceState: WorkspaceStateCache;
}

export function registerBeliefsWsRoute(
  app: FastifyInstance,
  deps: BeliefsWsDeps,
): void {
  const { beliefs: col, fileMeta, userId, beliefWriter } = deps;

  app.get("/v1/beliefs/ws", { websocket: true }, (socket: WebSocket, _req) => {
    let currentScope: string | null = null;

    registry.add(userId, socket);

    socket.on("message", async (raw: RawData) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        socket.send(
          JSON.stringify({
            type: "error",
            request_type: "unknown",
            message: "invalid JSON",
          } satisfies ServerMessage),
        );
        return;
      }

      switch (msg.type) {
        case "subscribe": {
          currentScope = msg.scope;
          break;
        }

        case "fetch_beliefs": {
          try {
            const filter: Record<string, unknown> = {
              user_id: userId,
              resolved_at: null,
              superseded_by: null,
              scope: { $in: [msg.scope] },
            };

            const docs = await col.find(filter).limit(30).toArray();
            const beliefs = docs.map(redactForClient);

            if (msg.active_file) {
              const activeFile = msg.active_file;
              beliefs.sort((a, b) => {
                const tierA = fileTier(
                  a.origin_context?.active_file ?? null,
                  activeFile,
                );
                const tierB = fileTier(
                  b.origin_context?.active_file ?? null,
                  activeFile,
                );
                if (tierA !== tierB) return tierA - tierB;
                if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
                return 0;
              });
            }

            socket.send(
              JSON.stringify({
                type: "beliefs_snapshot",
                scope: msg.scope,
                beliefs,
              } satisfies ServerMessage),
            );
          } catch (e) {
            socket.send(
              JSON.stringify({
                type: "error",
                request_type: "fetch_beliefs",
                message: (e as Error).message,
              } satisfies ServerMessage),
            );
          }
          break;
        }

        case "patch_belief": {
          try {
            const { id, patch } = msg;

            const current = await col.findOne({ _id: id, user_id: userId });
            if (!current) {
              socket.send(
                JSON.stringify({
                  type: "error",
                  request_type: "patch_belief",
                  message: "belief not found",
                } satisfies ServerMessage),
              );
              break;
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
              "aliases",
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
                  ...(field === "content"
                    ? { previous_content: current.content }
                    : {}),
                  ...(field === "epistemic_status"
                    ? { previous_epistemic_status: current.epistemic_status }
                    : {}),
                  changed_by_session: null,
                  changed_by_turn: null,
                });
              }
            }

            if (logEntries.length === 0) {
              socket.send(
                JSON.stringify({
                  type: "patch_ack",
                  id,
                  belief: redactForClient(current),
                } satisfies ServerMessage),
              );
              break;
            }

            const result = await col.updateOne(
              { _id: id, user_id: userId },
              {
                $set,
                $push: { change_log: { $each: logEntries } } as any,
              },
            );

            if (result.modifiedCount > 0) {
              const decrypted = await col.findOne({ _id: id, user_id: userId });
              if (decrypted) {
                socket.send(
                  JSON.stringify({
                    type: "patch_ack",
                    id,
                    belief: redactForClient(decrypted),
                  } satisfies ServerMessage),
                );
              }
            }
          } catch (e) {
            socket.send(
              JSON.stringify({
                type: "error",
                request_type: "patch_belief",
                message: (e as Error).message,
              } satisfies ServerMessage),
            );
          }
          break;
        }

        case "fetch_file_beliefs": {
          const [fileBeliefs, projectBeliefs] = await Promise.all([
            col
              .find({
                user_id: userId,
                resolved_at: null,
                superseded_by: null,
                "origin_context.active_file": msg.file_path,
              })
              .sort({ pinned: -1, last_reinforced_at: -1 })
              .toArray(),
            col
              .find({
                user_id: userId,
                resolved_at: null,
                superseded_by: null,
                scope: { $in: [msg.scope] },
                "origin_context.active_file": null,
              })
              .sort({ pinned: -1, last_reinforced_at: -1 })
              .limit(30)
              .toArray(),
          ]);

          const beliefs = [
            ...fileBeliefs.map(redactForClient),
            ...projectBeliefs.map(redactForClient),
          ];

          socket.send(
            JSON.stringify({
              type: "beliefs_snapshot",
              scope: msg.scope,
              beliefs,
            } satisfies ServerMessage),
          );
          break;
        }

        case "record_belief": {
          try {
            const now = new Date();
            const beliefId = await beliefWriter.create({
              user_id: userId,
              agent_id: null,
              type: msg.belief_type,
              subtype: null,
              canonical_name: msg.canonical_name.trim(),
              aliases: [],
              content: msg.content.trim(),
              why_it_matters: msg.why_it_matters.trim(),
              scope: msg.scope,
              provenance: {
                session_id: "manual",
                turn_id: "manual",
                extracted_at: now,
                source_model: "user",
              },
              epistemic_status: "active",
              confidence: 1.0,
              pinned: false,
              user_edited: true,
              origin_context: {
                active_file: msg.active_file,
                language: msg.active_language,
                project_scope: msg.project_scope,
              },
              change_log: [
                {
                  changed_at: now,
                  trigger: "manual_creation",
                  changed_by_session: null,
                  changed_by_turn: null,
                },
              ],
            });

            const created = await col.findOne({
              _id: beliefId,
              user_id: userId,
            });
            if (created) {
              const summary = redactForClient(created);
              socket.send(
                JSON.stringify({
                  type: "record_ack",
                  belief: summary,
                } satisfies ServerMessage),
              );
              registry.broadcast(userId, {
                type: "belief_upserted",
                belief: summary,
              });
            }
          } catch (e) {
            socket.send(
              JSON.stringify({
                type: "error",
                request_type: "record_belief",
                message: (e as Error).message,
              } satisfies ServerMessage),
            );
          }
          break;
        }

        case "file_meta": {
          try {
            const now = new Date();
            await fileMeta.updateOne(
              { _id: `${userId}:${msg.path}` },
              {
                $set: {
                  size_bytes: msg.size_bytes,
                  updated_at: now,
                },
                $setOnInsert: {
                  user_id: userId,
                  path: msg.path,
                  belief_ids: [],
                  created_at: now,
                },
              },
              { upsert: true },
            );
          } catch (e) {
            socket.send(
              JSON.stringify({
                type: "error",
                request_type: "file_meta",
                message: (e as Error).message,
              } satisfies ServerMessage),
            );
          }
          break;
        }

        case "rename_file": {
          try {
            await col.updateMany(
              {
                user_id: userId,
                "origin_context.active_file": msg.old_path,
              },
              {
                $set: { "origin_context.active_file": msg.new_path },
              },
            );

            const oldId = `${userId}:${msg.old_path}`;
            const newId = `${userId}:${msg.new_path}`;
            const existing = await fileMeta.findOne({ _id: oldId });
            if (existing) {
              await fileMeta.insertOne({
                ...existing,
                _id: newId,
                path: msg.new_path,
                updated_at: new Date(),
              });
              await fileMeta.deleteOne({ _id: oldId });
            }
          } catch (e) {
            socket.send(
              JSON.stringify({
                type: "error",
                request_type: "rename_file",
                message: (e as Error).message,
              } satisfies ServerMessage),
            );
          }
          break;
        }

        case "workspace_state": {
          try {
            await deps.workspaceState.set(userId, {
              workspace_root: msg.workspace_root,
              project_name: msg.project_name,
              git_remote: msg.git_remote,
              active_file: msg.active_file,
              active_language: msg.active_language,
              updated_at: new Date(),
            });

            const slug = msg.project_name
              .toLowerCase()
              .replace(/^@[^/]+\//, "")
              .replace(/[^a-z0-9-]/g, "-")
              .replace(/-+/g, "-")
              .replace(/^-|-$/g, "");

            socket.send(
              JSON.stringify({
                type: "scope_confirmed",
                scope: `project:${slug}`,
                active_file: msg.active_file,
              } satisfies ServerMessage),
            );
          } catch (e) {
            socket.send(
              JSON.stringify({
                type: "error",
                request_type: "workspace_state",
                message: (e as Error).message,
              } satisfies ServerMessage),
            );
          }
          break;
        }
      }
    });

    socket.on("close", () => {
      registry.remove(userId, socket);
    });

    socket.on("error", () => {
      registry.remove(userId, socket);
    });
  });
}

export function redactForClient(b: WithId<Belief>): BeliefSummary {
  return {
    id: b._id,
    type: b.type,
    canonical_name: b.canonical_name,
    content: b.content,
    why_it_matters: b.why_it_matters,
    epistemic_status: b.epistemic_status,
    confidence: b.confidence,
    pinned: b.pinned,
    scope: b.scope,
    aliases: b.aliases,
    ...(b.origin_context != null ? { origin_context: b.origin_context } : {}),
  };
}

function fileTier(
  beliefFile: string | null | undefined,
  activeFile: string,
): number {
  if (!beliefFile) return 3;
  if (beliefFile === activeFile) return 1;
  const beliefDir = beliefFile.split("/").slice(0, -1).join("/");
  const activeDir = activeFile.split("/").slice(0, -1).join("/");
  if (beliefDir === activeDir) return 2;
  return 3;
}
