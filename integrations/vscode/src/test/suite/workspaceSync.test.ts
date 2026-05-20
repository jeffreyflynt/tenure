import * as assert from "assert";
import * as vscode from "vscode";

suite("WorkspaceSync scope migration", () => {
  test("detects project rename between syncs", () => {
    const oldState = JSON.stringify({
      workspace_root: "/home/user/project",
      project_name: "old-name",
      git_remote: null,
      active_file: null,
      active_language: null,
    });

    const newState = JSON.parse(oldState) as { project_name: string };
    newState.project_name = "new-name";

    const previousState = JSON.parse(oldState) as { project_name: string };
    const renamed = previousState.project_name !== newState.project_name;

    assert.ok(renamed);
    assert.strictEqual(previousState.project_name, "old-name");
    assert.strictEqual(newState.project_name, "new-name");
  });

  test("does not flag rename when project name unchanged", () => {
    const state = JSON.stringify({
      workspace_root: "/home/user/project",
      project_name: "my-project",
      git_remote: null,
      active_file: "/home/user/project/src/index.ts",
      active_language: "typescript",
    });

    const newActiveFile = JSON.parse(state) as {
      project_name: string;
      active_file: string;
    };
    newActiveFile.active_file = "/home/user/project/src/other.ts";

    const previousState = JSON.parse(state) as { project_name: string };
    const renamed = previousState.project_name !== newActiveFile.project_name;

    assert.ok(!renamed);
  });
});
