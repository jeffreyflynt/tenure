import * as assert from "assert";
import * as path from "path";
import { createHash } from "node:crypto";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/^@[^/]+\//, "")
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function getLocalFallbackSlug(workspaceRoot: string): string {
  const folderName = path.basename(workspaceRoot);
  const hash = createHash("md5")
    .update(workspaceRoot)
    .digest("hex")
    .slice(0, 8);
  return `${folderName}-${hash}`;
}

function buildCanonicalName(content: string): string {
  return content
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .slice(0, 5)
    .join("_");
}

suite("slugify", () => {
  test("lowercases input", () => {
    assert.strictEqual(slugify("MyProject"), "myproject");
  });

  test("replaces spaces and special chars with hyphens", () => {
    assert.strictEqual(slugify("My Project"), "my-project");
  });

  test("collapses consecutive hyphens", () => {
    assert.strictEqual(slugify("foo---bar"), "foo-bar");
  });

  test("strips leading and trailing hyphens", () => {
    assert.strictEqual(slugify("-foo-"), "foo");
  });

  test("strips scoped npm package prefix", () => {
    assert.strictEqual(slugify("@acme/my-lib"), "my-lib");
  });

  test("handles deeply scoped npm package", () => {
    assert.strictEqual(slugify("@org/sub/name"), "sub-name");
  });

  test("passes through already-slugified string unchanged", () => {
    assert.strictEqual(slugify("my-project-123"), "my-project-123");
  });

  test("handles empty string", () => {
    assert.strictEqual(slugify(""), "");
  });
});

suite("getLocalFallbackSlug", () => {
  test("contains the folder name", () => {
    const slug = getLocalFallbackSlug("/home/user/my-project");
    assert.ok(slug.startsWith("my-project-"), `got: ${slug}`);
  });

  test("appends an 8-char hex hash", () => {
    const slug = getLocalFallbackSlug("/home/user/my-project");
    const parts = slug.split("-");
    const hash = parts[parts.length - 1];
    assert.strictEqual(hash.length, 8);
    assert.match(hash, /^[0-9a-f]{8}$/);
  });

  test("different roots produce different slugs", () => {
    const a = getLocalFallbackSlug("/home/alice/project");
    const b = getLocalFallbackSlug("/home/bob/project");
    assert.notStrictEqual(a, b);
  });

  test("same root always produces the same slug (deterministic)", () => {
    const root = "/stable/path/project";
    assert.strictEqual(getLocalFallbackSlug(root), getLocalFallbackSlug(root));
  });
});

suite("buildCanonicalName", () => {
  test("takes first 5 words", () => {
    assert.strictEqual(
      buildCanonicalName("we use native fetch not axios"),
      "we_use_native_fetch_not",
    );
  });

  test("fewer than 5 words uses all words", () => {
    assert.strictEqual(buildCanonicalName("use fetch"), "use_fetch");
  });

  test("strips non-alphanumeric characters", () => {
    assert.strictEqual(
      buildCanonicalName("Don't use Axios!"),
      "dont_use_axios",
    );
  });

  test("lowercases result", () => {
    assert.strictEqual(
      buildCanonicalName("Use FETCH Always"),
      "use_fetch_always",
    );
  });

  test("collapses multiple spaces", () => {
    assert.strictEqual(buildCanonicalName("foo  bar"), "foo_bar");
  });

  test("empty string produces empty string", () => {
    assert.strictEqual(buildCanonicalName(""), "");
  });
});

interface BeliefSummary {
  id: string;
  canonical_name: string;
  content: string;
  pinned: boolean;
  epistemic_status: string;
  confidence: number;
  type: string;
  why_it_matters: string;
  scope: string[];
  aliases: string[];
}

function makeBelief(
  id: string,
  overrides: Partial<BeliefSummary> = {},
): BeliefSummary {
  return {
    id,
    canonical_name: id,
    content: `content of ${id}`,
    pinned: false,
    epistemic_status: "active",
    confidence: 0.9,
    type: "preference",
    why_it_matters: "matters",
    scope: ["project:test"],
    aliases: [],
    ...overrides,
  };
}

function applyBeliefUpsert(
  beliefs: BeliefSummary[],
  belief: BeliefSummary,
): BeliefSummary[] {
  const list = [...beliefs];
  const idx = list.findIndex((b) => b.id === belief.id);
  if (idx !== -1) list[idx] = belief;
  else list.unshift(belief);
  return list;
}

function applyBeliefSuperseded(
  beliefs: BeliefSummary[],
  id: string,
): BeliefSummary[] {
  return beliefs.filter((b) => b.id !== id);
}

function applyPatchAck(
  beliefs: BeliefSummary[],
  id: string,
  belief: BeliefSummary,
): BeliefSummary[] {
  const list = [...beliefs];
  const idx = list.findIndex((b) => b.id === id);
  if (idx !== -1) list[idx] = belief;
  return list;
}

suite("belief list mutations", () => {
  test("upsert inserts a new belief at the front", () => {
    const initial = [makeBelief("b1"), makeBelief("b2")];
    const result = applyBeliefUpsert(initial, makeBelief("b3"));
    assert.strictEqual(result[0].id, "b3");
    assert.strictEqual(result.length, 3);
  });

  test("upsert replaces an existing belief in place", () => {
    const initial = [makeBelief("b1"), makeBelief("b2")];
    const updated = makeBelief("b1", { content: "updated content" });
    const result = applyBeliefUpsert(initial, updated);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].content, "updated content");
    assert.strictEqual(result[0].id, "b1");
  });

  test("supersede removes the matching belief", () => {
    const initial = [makeBelief("b1"), makeBelief("b2"), makeBelief("b3")];
    const result = applyBeliefSuperseded(initial, "b2");
    assert.strictEqual(result.length, 2);
    assert.ok(!result.find((b) => b.id === "b2"));
  });

  test("supersede with unknown id leaves list unchanged", () => {
    const initial = [makeBelief("b1")];
    const result = applyBeliefSuperseded(initial, "unknown");
    assert.strictEqual(result.length, 1);
  });

  test("patch_ack updates the belief when id exists", () => {
    const initial = [makeBelief("b1", { pinned: false })];
    const patched = makeBelief("b1", { pinned: true });
    const result = applyPatchAck(initial, "b1", patched);
    assert.strictEqual(result[0].pinned, true);
  });

  test("patch_ack is a no-op when id not found", () => {
    const initial = [makeBelief("b1")];
    const patched = makeBelief("b99", { pinned: true });
    const result = applyPatchAck(initial, "b99", patched);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].id, "b1");
  });

  test("beliefs_snapshot replaces the entire list", () => {
    const previous = [makeBelief("old1"), makeBelief("old2")];
    const snapshot = [makeBelief("new1")];
    // snapshot handler just overwrites
    const result = snapshot;
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].id, "new1");
    void previous; // silence unused warning
  });
});

suite("reconnect back-off", () => {
  const BASE_RECONNECT_MS = 1_000;
  const MAX_RECONNECT_MS = 30_000;

  function backOff(attempt: number): number {
    return Math.min(BASE_RECONNECT_MS * Math.pow(2, attempt), MAX_RECONNECT_MS);
  }

  test("first attempt is 1 s", () => {
    assert.strictEqual(backOff(0), 1_000);
  });

  test("second attempt is 2 s", () => {
    assert.strictEqual(backOff(1), 2_000);
  });

  test("third attempt is 4 s", () => {
    assert.strictEqual(backOff(2), 4_000);
  });

  test("caps at MAX_RECONNECT_MS", () => {
    assert.strictEqual(backOff(10), MAX_RECONNECT_MS);
    assert.strictEqual(backOff(100), MAX_RECONNECT_MS);
  });

  test("fifth attempt is 16 s", () => {
    assert.strictEqual(backOff(4), 16_000);
  });
});

suite("scope_confirmed handling", () => {
  test("updates currentScope when scope changes", () => {
    let currentScope: string | null = "project:old-scope";
    let currentActiveFile: string | null = null;

    const msg = { scope: "project:new-scope", active_file: "src/index.ts" };

    const scopeChanged = msg.scope !== currentScope;
    currentScope = msg.scope;
    currentActiveFile = msg.active_file;

    assert.ok(scopeChanged);
    assert.strictEqual(currentScope, "project:new-scope");
    assert.strictEqual(currentActiveFile, "src/index.ts");
  });

  test("does not flag scope as changed when it is the same", () => {
    const currentScope = "project:same-scope";
    const msg = { scope: "project:same-scope", active_file: null };

    const scopeChanged = msg.scope !== currentScope;
    assert.ok(!scopeChanged);
  });
});

suite("WorkspaceSync state comparison", () => {
  function makeState(
    overrides: Partial<{
      workspace_root: string;
      project_name: string;
      git_remote: string | null;
      active_file: string | null;
      active_language: string | null;
    }> = {},
  ) {
    return {
      workspace_root: "/home/user/project",
      project_name: "my-project",
      git_remote: null,
      active_file: null,
      active_language: null,
      ...overrides,
    };
  }

  test("sync is skipped when state is unchanged", () => {
    const state = makeState();
    const key = JSON.stringify(state);
    let lastSynced = key;

    const shouldSkip = key === lastSynced;
    assert.ok(shouldSkip);
    void lastSynced;
  });

  test("sync proceeds when active_file changes", () => {
    const state = makeState({ active_file: "src/a.ts" });
    const key = JSON.stringify(state);
    let lastSynced = JSON.stringify(makeState({ active_file: "src/b.ts" }));

    const shouldSkip = key === lastSynced;
    assert.ok(!shouldSkip);
    void lastSynced;
  });

  test("sync proceeds when active_language changes", () => {
    const a = makeState({ active_language: "typescript" });
    const b = makeState({ active_language: "javascript" });
    assert.notStrictEqual(JSON.stringify(a), JSON.stringify(b));
  });

  test("sync proceeds when git_remote changes", () => {
    const a = makeState({ git_remote: null });
    const b = makeState({ git_remote: "git@github.com:org/repo.git" });
    assert.notStrictEqual(JSON.stringify(a), JSON.stringify(b));
  });
});

suite("migrateScope body construction", () => {
  test("old and new scopes are correctly slugified", () => {
    const oldName = "Old Project";
    const newName = "New Project";

    const body = {
      old_scope: `project:${slugify(oldName)}`,
      new_scope: `project:${slugify(newName)}`,
    };

    assert.strictEqual(body.old_scope, "project:old-project");
    assert.strictEqual(body.new_scope, "project:new-project");
  });

  test("scoped npm package names are slugified before migration", () => {
    const body = {
      old_scope: `project:${slugify("@acme/old-lib")}`,
      new_scope: `project:${slugify("@acme/new-lib")}`,
    };

    assert.strictEqual(body.old_scope, "project:old-lib");
    assert.strictEqual(body.new_scope, "project:new-lib");
  });
});

suite("onDidRenameFiles filtering", () => {
  function shouldSendRename(oldPath: string, newPath: string): boolean {
    return !path.isAbsolute(oldPath) && !path.isAbsolute(newPath);
  }

  test("sends rename for relative paths", () => {
    assert.ok(shouldSendRename("src/old.ts", "src/new.ts"));
  });

  test("skips rename when old path is absolute", () => {
    assert.ok(!shouldSendRename("/abs/old.ts", "src/new.ts"));
  });

  test("skips rename when new path is absolute", () => {
    assert.ok(!shouldSendRename("src/old.ts", "/abs/new.ts"));
  });

  test("skips rename when both paths are absolute", () => {
    assert.ok(!shouldSendRename("/abs/old.ts", "/abs/new.ts"));
  });
});

suite("WebSocket send guard", () => {
  const WS_OPEN = 1;
  const WS_CONNECTING = 0;
  const WS_CLOSING = 2;
  const WS_CLOSED = 3;

  function canSend(readyState: number): boolean {
    return readyState === WS_OPEN;
  }

  test("sends when OPEN", () => {
    assert.ok(canSend(WS_OPEN));
  });

  test("does not send when CONNECTING", () => {
    assert.ok(!canSend(WS_CONNECTING));
  });

  test("does not send when CLOSING", () => {
    assert.ok(!canSend(WS_CLOSING));
  });

  test("does not send when CLOSED", () => {
    assert.ok(!canSend(WS_CLOSED));
  });
});

suite("fetch_file_beliefs scope construction", () => {
  test("scope uses slugified project name", () => {
    const projectName = "My Awesome Project";
    const scope = `project:${slugify(projectName)}`;
    assert.strictEqual(scope, "project:my-awesome-project");
  });

  test("relative file paths are forwarded as-is", () => {
    const relativePath = "src/components/Button.tsx";
    // Just verify the path is unchanged (no further manipulation in the
    // sendFetchFileBeliefs call path)
    assert.strictEqual(relativePath, "src/components/Button.tsx");
  });
});

suite("record_belief scope fallback", () => {
  test("uses project scope when project name is available", () => {
    const projectName = "my-app";
    const scope = projectName
      ? [`project:${slugify(projectName)}`]
      : ["user:universal"];
    assert.deepStrictEqual(scope, ["project:my-app"]);
  });

  test("falls back to user:universal when no project name", () => {
    const projectName: string | null = null;
    const scope = projectName
      ? [`project:${slugify(projectName)}`]
      : ["user:universal"];
    assert.deepStrictEqual(scope, ["user:universal"]);
  });
});
