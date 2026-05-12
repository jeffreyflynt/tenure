import test from "ava";
import Fastify from "fastify";
import { registerBeliefsUiRoute } from "./beliefs-ui.js";

function buildApp() {
  const app = Fastify();
  registerBeliefsUiRoute(app);
  return app;
}

test("GET /beliefs returns 200 with text/html content-type", async (t) => {
  const app = buildApp();
  const res = await app.inject({ method: "GET", url: "/beliefs" });

  t.is(res.statusCode, 200);
  t.regex(res.headers["content-type"] as string, /text\/html/);
});

test("GET /beliefs returns valid HTML document structure", async (t) => {
  const app = buildApp();
  const res = await app.inject({ method: "GET", url: "/beliefs" });

  t.true(res.body.includes("<!DOCTYPE html>"));
  t.true(res.body.includes("<html"));
  t.true(res.body.includes("</html>"));
  t.true(res.body.includes('<div id="app">'));
});

test("GET /beliefs embeds token from query parameter", async (t) => {
  const app = buildApp();
  const res = await app.inject({
    method: "GET",
    url: "/beliefs?token=test-token-123",
  });

  t.true(res.body.includes('"test-token-123"'));
});

test("GET /beliefs without token uses localStorage fallback", async (t) => {
  const app = buildApp();
  const res = await app.inject({ method: "GET", url: "/beliefs" });

  t.true(res.body.includes("localStorage"));
  t.true(res.body.includes("mp_token"));
});

test("GET /beliefs includes type filter tabs", async (t) => {
  const app = buildApp();
  const res = await app.inject({ method: "GET", url: "/beliefs" });

  t.true(res.body.includes("preference"));
  t.true(res.body.includes("entity"));
  t.true(res.body.includes("decision"));
  t.true(res.body.includes("open_question"));
});

test("GET /beliefs includes CRUD action handlers", async (t) => {
  const app = buildApp();
  const res = await app.inject({ method: "GET", url: "/beliefs" });

  t.true(res.body.includes("/v1/beliefs"));
  t.true(res.body.includes("PATCH"));
  t.true(res.body.includes("DELETE"));
});

test("GET /beliefs includes navigation links", async (t) => {
  const app = buildApp();
  const res = await app.inject({ method: "GET", url: "/beliefs" });

  t.true(res.body.includes("/admin"));
  t.true(res.body.includes("/onboarding"));
  t.true(res.body.includes("World Model"));
});

test("GET /beliefs includes search and status filter UI", async (t) => {
  const app = buildApp();
  const res = await app.inject({ method: "GET", url: "/beliefs" });

  t.true(res.body.includes("search-input"));
  t.true(res.body.includes("status-filter"));
  t.true(res.body.includes("superseded"));
});

test("GET /beliefs includes modal infrastructure for edit/delete/history", async (t) => {
  const app = buildApp();
  const res = await app.inject({ method: "GET", url: "/beliefs" });

  t.true(res.body.includes("open-edit"));
  t.true(res.body.includes("open-delete"));
  t.true(res.body.includes("open-history"));
  t.true(res.body.includes("close-modal"));
});

test("GET /beliefs includes pin toggle functionality", async (t) => {
  const app = buildApp();
  const res = await app.inject({ method: "GET", url: "/beliefs" });

  t.true(res.body.includes("toggle-pin"));
  t.true(res.body.includes("pinned"));
});

test("GET /beliefs token is propagated in nav links", async (t) => {
  const app = buildApp();
  const res = await app.inject({
    method: "GET",
    url: "/beliefs?token=nav-token",
  });

  t.true(res.body.includes('"nav-token"'));
});

test("GET /beliefs includes import tab", async (t) => {
  const app = buildApp();
  const res = await app.inject({ method: "GET", url: "/beliefs" });

  t.true(res.body.includes("submitImport"));
  t.true(res.body.includes("/v1/beliefs/ingest"));
  t.true(res.body.includes("import-text"));
  t.true(res.body.includes("import-source"));
});

test("GET /beliefs includes extraction banner placeholder", async (t) => {
  const app = buildApp();
  const res = await app.inject({ method: "GET", url: "/beliefs" });

  t.true(res.body.includes("extraction-banner"));
});

test("GET /beliefs includes drag and drop handler on import textarea", async (t) => {
  const app = buildApp();
  const res = await app.inject({ method: "GET", url: "/beliefs" });

  t.true(res.body.includes("dragover"));
  t.true(res.body.includes("dataTransfer"));
});

test("GET /beliefs includes scope field in import panel", async (t) => {
  const app = buildApp();
  const res = await app.inject({ method: "GET", url: "/beliefs" });

  t.true(res.body.includes("import-scope-tag"));
});
