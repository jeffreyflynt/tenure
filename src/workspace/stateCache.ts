import type { Collection, Db } from "mongodb";

export interface WorkspaceState {
  workspace_root: string;
  project_name: string;
  git_remote: string | null;
  active_file: string | null;
  active_language: string | null;
  updated_at: Date;
}

export interface WorkspaceStateDoc extends WorkspaceState {
  _id: string;
  user_id: string;
}

export class WorkspaceStateCache {
  private readonly col: Collection<WorkspaceStateDoc>;
  private inMemory: Map<string, WorkspaceState> = new Map();

  constructor(db: Db) {
    this.col = db.collection<WorkspaceStateDoc>("workspace_state");
  }

  async set(userId: string, state: WorkspaceState): Promise<void> {
    this.inMemory.set(userId, state);
    await this.col.updateOne(
      { _id: userId },
      {
        $set: {
          user_id: userId,
          ...state,
          updated_at: new Date(),
        },
      },
      { upsert: true },
    );
  }

  get(userId: string): WorkspaceState | null {
    return this.inMemory.get(userId) ?? null;
  }

  async load(userId: string): Promise<WorkspaceState | null> {
    const cached = this.inMemory.get(userId);
    if (cached) return cached;

    const doc = await this.col.findOne({ _id: userId });
    if (doc) {
      const state: WorkspaceState = {
        workspace_root: doc.workspace_root,
        project_name: doc.project_name,
        git_remote: doc.git_remote,
        active_file: doc.active_file,
        active_language: doc.active_language,
        updated_at: doc.updated_at,
      };
      this.inMemory.set(userId, state);
      return state;
    }
    return null;
  }

  resolveProjectScope(userId: string): string | null {
    const state = this.inMemory.get(userId);
    if (!state?.project_name) return null;
    const slug = state.project_name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    return `project:${slug}`;
  }

  resolveLanguageScope(userId: string): string | null {
    const state = this.inMemory.get(userId);
    if (!state?.active_language) return null;

    const LANG_MAP: Record<string, string> = {
      typescript: "domain:code/typescript",
      typescriptreact: "domain:code/typescript",
      javascript: "domain:code/javascript",
      javascriptreact: "domain:code/javascript",
      python: "domain:code/python",
      rust: "domain:code/rust",
      go: "domain:code/go",
      java: "domain:code/java",
      ruby: "domain:code/ruby",
      swift: "domain:code/swift",
      kotlin: "domain:code/kotlin",
      cpp: "domain:code/cpp",
      c: "domain:code/c",
      csharp: "domain:code/csharp",
      php: "domain:code/php",
      shell: "domain:code/shell",
      shellscript: "domain:code/shell",
    };

    return LANG_MAP[state.active_language] ?? "domain:code";
  }
}
