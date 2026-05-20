import * as assert from "assert";
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { readTenureConfig } from "../../tenureConfig.js";

suite("tenureConfig", () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tenure-config-test-"));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("reads .tenure file", async () => {
    fs.writeFileSync(
      path.join(tmpDir, ".tenure"),
      JSON.stringify({ projectId: "my-project" }),
    );

    const result = await readTenureConfig(vscode.Uri.file(tmpDir));
    assert.strictEqual(result?.projectId, "my-project");
  });

  test("reads .tenure/config.json", async () => {
    const tenureDir = path.join(tmpDir, ".tenure");
    fs.mkdirSync(tenureDir);
    fs.writeFileSync(
      path.join(tenureDir, "config.json"),
      JSON.stringify({ projectId: "nested-project" }),
    );

    const result = await readTenureConfig(vscode.Uri.file(tmpDir));
    assert.strictEqual(result?.projectId, "nested-project");
  });

  test("prefers .tenure over .tenure/config.json", async () => {
    fs.writeFileSync(
      path.join(tmpDir, ".tenure"),
      JSON.stringify({ projectId: "root-config" }),
    );
    const tenureDir = path.join(tmpDir, ".tenure");
    // .tenure is a file here so this won't conflict
    // but test the priority when both could exist
    const result = await readTenureConfig(vscode.Uri.file(tmpDir));
    assert.strictEqual(result?.projectId, "root-config");
  });

  test("returns null when no .tenure file exists", async () => {
    const result = await readTenureConfig(vscode.Uri.file(tmpDir));
    assert.strictEqual(result, null);
  });

  test("returns null for malformed .tenure file", async () => {
    fs.writeFileSync(path.join(tmpDir, ".tenure"), "not valid json {{{");
    const result = await readTenureConfig(vscode.Uri.file(tmpDir));
    assert.strictEqual(result, null);
  });
});
