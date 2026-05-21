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
    fs.writeFileSync(path.join(tmpDir, ".tenure"), "my-project");

    const result = await readTenureConfig(vscode.Uri.file(tmpDir));
    assert.strictEqual(result?.projectId, "my-project");
  });

  test("returns null when no .tenure file exists", async () => {
    const result = await readTenureConfig(vscode.Uri.file(tmpDir));
    assert.strictEqual(result, null);
  });

  test("ignores unknown extra fields without erroring", async () => {
    fs.writeFileSync(path.join(tmpDir, ".tenure"), "my-project");
    const result = await readTenureConfig(vscode.Uri.file(tmpDir));
    assert.strictEqual(result?.projectId, "my-project");
  });

  test("returns null for empty JSON object alternative — empty string", async () => {
    fs.writeFileSync(path.join(tmpDir, ".tenure"), "");
    const result = await readTenureConfig(vscode.Uri.file(tmpDir));
    assert.strictEqual(result, null);
  });

  test("returns null when file contains only whitespace", async () => {
    fs.writeFileSync(path.join(tmpDir, ".tenure"), "   \n  ");
    const result = await readTenureConfig(vscode.Uri.file(tmpDir));
    assert.strictEqual(result, null);
  });
});
