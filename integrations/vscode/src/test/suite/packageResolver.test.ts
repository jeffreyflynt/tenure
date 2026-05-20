import * as assert from "assert";
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import {
  resolveNearestPackageName,
  getLocalFallbackSlug,
} from "../../packageResolver.js";

suite("packageResolver", () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tenure-test-"));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("resolves package.json name", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "my-project" }),
    );

    const fileUri = vscode.Uri.file(path.join(tmpDir, "src", "index.ts"));
    const rootUri = vscode.Uri.file(tmpDir);

    const result = await resolveNearestPackageName(fileUri, rootUri);
    assert.strictEqual(result, "my-project");
  });

  test("strips npm org prefix from package.json name", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "@orgname/my-project" }),
    );

    const fileUri = vscode.Uri.file(path.join(tmpDir, "src", "index.ts"));
    const rootUri = vscode.Uri.file(tmpDir);

    const result = await resolveNearestPackageName(fileUri, rootUri);
    assert.strictEqual(result, "my-project");
  });

  test("resolves nearest package.json in monorepo", async () => {
    // Root package
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "monorepo-root" }),
    );
    // Sub-package
    const subPkg = path.join(tmpDir, "packages", "proxy");
    fs.mkdirSync(subPkg, { recursive: true });
    fs.writeFileSync(
      path.join(subPkg, "package.json"),
      JSON.stringify({ name: "proxy" }),
    );

    const fileUri = vscode.Uri.file(path.join(subPkg, "src", "index.ts"));
    const rootUri = vscode.Uri.file(tmpDir);

    const result = await resolveNearestPackageName(fileUri, rootUri);
    assert.strictEqual(result, "proxy");
  });

  test("resolves Cargo.toml name", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "Cargo.toml"),
      '[package]\nname = "my-rust-project"\nversion = "0.1.0"',
    );

    const fileUri = vscode.Uri.file(path.join(tmpDir, "src", "main.rs"));
    const rootUri = vscode.Uri.file(tmpDir);

    const result = await resolveNearestPackageName(fileUri, rootUri);
    assert.strictEqual(result, "my-rust-project");
  });

  test("resolves go.mod module name", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "go.mod"),
      "module github.com/tenurehq/tenure\n\ngo 1.21",
    );

    const fileUri = vscode.Uri.file(path.join(tmpDir, "cmd", "main.go"));
    const rootUri = vscode.Uri.file(tmpDir);

    const result = await resolveNearestPackageName(fileUri, rootUri);
    assert.strictEqual(result, "tenure");
  });

  test("returns null when no manifest found", async () => {
    const fileUri = vscode.Uri.file(path.join(tmpDir, "src", "index.ts"));
    const rootUri = vscode.Uri.file(tmpDir);

    const result = await resolveNearestPackageName(fileUri, rootUri);
    assert.strictEqual(result, null);
  });

  test("returns null when activeFileUri is undefined", async () => {
    const rootUri = vscode.Uri.file(tmpDir);
    const result = await resolveNearestPackageName(undefined, rootUri);
    assert.strictEqual(result, null);
  });

  test("getLocalFallbackSlug produces consistent output", () => {
    const slug1 = getLocalFallbackSlug("/home/user/projects/src");
    const slug2 = getLocalFallbackSlug("/home/user/projects/src");
    assert.strictEqual(slug1, slug2);
  });

  test("getLocalFallbackSlug disambiguates same folder name", () => {
    const slug1 = getLocalFallbackSlug("/home/user/work/src");
    const slug2 = getLocalFallbackSlug("/home/user/personal/src");
    assert.notStrictEqual(slug1, slug2);
    assert.ok(slug1.startsWith("src-"));
    assert.ok(slug2.startsWith("src-"));
  });
});
