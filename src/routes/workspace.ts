import type { FastifyInstance } from "fastify";
import type { WorkspaceStateCache } from "../workspace/stateCache.js";

export interface WorkspaceDeps {
  userId: string;
  workspaceState: WorkspaceStateCache;
}

export function registerWorkspaceRoutes(
  app: FastifyInstance,
  deps: WorkspaceDeps,
): void {
  app.post("/v1/workspace/state", async (req, reply) => {
    const body = req.body as {
      workspace_root?: string;
      project_name?: string;
      git_remote?: string | null;
      active_file?: string | null;
      active_language?: string | null;
      active_package?: string | null;
    };

    if (!body.workspace_root || !body.project_name) {
      return reply.code(400).send({
        error: { message: "workspace_root and project_name are required" },
      });
    }

    await deps.workspaceState.set(deps.userId, {
      workspace_root: body.workspace_root,
      project_name: body.project_name,
      active_package: body.active_package ?? null,
      git_remote: body.git_remote ?? null,
      active_file: body.active_file ?? null,
      active_language: body.active_language ?? null,
      updated_at: new Date(),
    });

    return { ok: true };
  });

  app.get("/v1/workspace/state", async (_req, _reply) => {
    const state = await deps.workspaceState.load(deps.userId);
    if (!state) {
      return { state: null };
    }
    return { state };
  });
}
