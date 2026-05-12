import test from "ava";
import Fastify from "fastify";
import { registerAdminUiRoute } from "./admin-ui.js";

function buildApp() {
  const app = Fastify();
  registerAdminUiRoute(app);
  return app;
}

test("GET /admin returns 200 with text/html content-type", async (t) => {
  const app = buildApp();
  const res = await app.inject({ method: "GET", url: "/admin" });

  t.is(res.statusCode, 200);
  t.regex(res.headers["content-type"] as string, /text\/html/);
});

test("GET /admin returns valid HTML document structure", async (t) => {
  const app = buildApp();
  const res = await app.inject({ method: "GET", url: "/admin" });

  t.true(res.body.includes("<!DOCTYPE html>"));
  t.true(res.body.includes("<html"));
  t.true(res.body.includes("</html>"));
  t.true(res.body.includes('<div id="app">'));
});

test("GET /admin embeds token from query parameter", async (t) => {
  const app = buildApp();
  const res = await app.inject({
    method: "GET",
    url: "/admin?token=my-secret-token",
  });

  t.true(res.body.includes('"my-secret-token"'));
});

test("GET /admin without token uses localStorage fallback script", async (t) => {
  const app = buildApp();
  const res = await app.inject({ method: "GET", url: "/admin" });

  t.true(res.body.includes("localStorage"));
  t.true(res.body.includes("mp_token"));
  t.false(res.body.includes('let token = "'));
});

test("GET /admin escapes special characters in token", async (t) => {
  const app = buildApp();
  const res = await app.inject({
    method: "GET",
    url: "/admin?token=</script><img>",
  });

  t.false(res.body.includes("</script><img>"));
  t.true(
    res.body.includes("\\u003c") ||
      res.body.includes("&lt;") ||
      res.body.includes("<\\/script>") ||
      res.body.includes(JSON.stringify("</script><img>")),
  );
});

test("GET /admin includes navigation links", async (t) => {
  const app = buildApp();
  const res = await app.inject({ method: "GET", url: "/admin" });

  t.true(res.body.includes("/beliefs"));
  t.true(res.body.includes("/onboarding"));
  t.true(res.body.includes("Settings"));
});

test("GET /admin includes provider configuration UI elements", async (t) => {
  const app = buildApp();
  const res = await app.inject({ method: "GET", url: "/admin" });

  t.true(res.body.includes("openai"));
  t.true(res.body.includes("anthropic"));
  t.true(res.body.includes("/admin/config"));
  t.true(res.body.includes("/admin/providers"));
});

test("GET /admin includes page title", async (t) => {
  const app = buildApp();
  const res = await app.inject({ method: "GET", url: "/admin" });

  t.true(res.body.includes("<title>"));
  t.true(res.body.includes("Settings"));
});

test("GET /admin includes endpoint flavor options", async (t) => {
  const app = buildApp();
  const res = await app.inject({ method: "GET", url: "/admin" });

  t.true(res.body.includes("generic"));
  t.true(res.body.includes("bedrock-access-gateway"));
  t.true(res.body.includes("litellm"));
});

test("GET /admin includes extraction toggle", async (t) => {
  const app = buildApp();
  const res = await app.inject({ method: "GET", url: "/admin" });

  t.true(res.body.includes("extraction-enabled"));
  t.true(res.body.includes("setExtractionEnabled"));
  t.true(res.body.includes("Belief extraction"));
});

test("GET /admin includes strict model tiers toggle", async (t) => {
  const app = buildApp();
  const res = await app.inject({ method: "GET", url: "/admin" });

  t.true(res.body.includes("strict-model-tiers"));
  t.true(res.body.includes("setStrictModelTiers"));
});

test("GET /admin includes token rotation UI", async (t) => {
  const app = buildApp();
  const res = await app.inject({ method: "GET", url: "/admin" });

  t.true(res.body.includes("rotateToken"));
  t.true(res.body.includes("Rotate token"));
});

test("GET /admin includes maintenance section with compaction button", async (t) => {
  const app = buildApp();
  const res = await app.inject({ method: "GET", url: "/admin" });

  t.true(res.body.includes("runCompaction"));
  t.true(res.body.includes("Run compaction now"));
});
