import test from "ava";
import {
  splitSidecar,
  parseSidecar,
  SIDECAR_BEGIN,
  SIDECAR_END,
} from "./splitter.js";

test("returns missing status when no sidecar markers present", (t) => {
  const result = splitSidecar("Hello, this is a normal response.");
  t.is(result.parseStatus, "missing");
  t.is(result.sidecarRaw, null);
  t.is(result.visible, "Hello, this is a normal response.");
});

test("parses a well-formed sidecar block", (t) => {
  const json = '{"turn_signal":"acknowledgment"}';
  const content = `Visible text.\n${SIDECAR_BEGIN}\n${json}\n${SIDECAR_END}`;
  const result = splitSidecar(content);
  t.is(result.parseStatus, "parsed");
  t.is(result.sidecarRaw, json);
  t.is(result.visible, "Visible text.");
});

test("visible text is trimmed of trailing whitespace", (t) => {
  const json = '{"turn_signal":"substantive"}';
  const content = `Answer here.   \n\n${SIDECAR_BEGIN}\n${json}\n${SIDECAR_END}`;
  const result = splitSidecar(content);
  t.is(result.visible, "Answer here.");
});

test("returns needs_repair when end marker is missing", (t) => {
  const content = `Visible.\n${SIDECAR_BEGIN}\n{"foo":"bar"}`;
  const result = splitSidecar(content);
  t.is(result.parseStatus, "needs_repair");
  t.is(result.sidecarRaw, '{"foo":"bar"}');
  t.is(result.visible, "Visible.");
});

test("returns needs_repair when sidecar body is empty", (t) => {
  const content = `Visible.\n${SIDECAR_BEGIN}\n${SIDECAR_END}`;
  const result = splitSidecar(content);
  t.is(result.parseStatus, "needs_repair");
  t.is(result.sidecarRaw, null);
});

test("uses lastIndexOf so only the last sidecar block is parsed", (t) => {
  const first = `${SIDECAR_BEGIN}\n{"first":true}\n${SIDECAR_END}`;
  const second = `${SIDECAR_BEGIN}\n{"second":true}\n${SIDECAR_END}`;
  const content = `Before.\n${first}\nMiddle text.\n${second}`;
  const result = splitSidecar(content);
  t.is(result.parseStatus, "parsed");
  t.is(result.sidecarRaw, '{"second":true}');
});

test("visible is empty string when sidecar starts at beginning", (t) => {
  const json = '{"x":1}';
  const content = `${SIDECAR_BEGIN}\n${json}\n${SIDECAR_END}`;
  const result = splitSidecar(content);
  t.is(result.visible, "");
  t.is(result.parseStatus, "parsed");
});

test("returns null for null input", (t) => {
  t.is(parseSidecar(null), null);
});

test("parses valid JSON string", (t) => {
  const raw = '{"turn_signal":"substantive","new_beliefs":[]}';
  const result = parseSidecar(raw);
  t.deepEqual(result, { turn_signal: "substantive", new_beliefs: [] });
});

test("returns null for invalid JSON", (t) => {
  t.is(parseSidecar("{invalid json}"), null);
});

test("returns null for empty string", (t) => {
  t.is(parseSidecar(""), null);
});

test("round-trips a realistic sidecar payload", (t) => {
  const payload = {
    turn_signal: "substantive",
    new_beliefs: [
      {
        type: "FACT",
        canonical_name: "user_location",
        content: "User lives in Berlin",
        why_it_matters: "Affects timezone and locale defaults",
        scope: ["global"],
        confidence: 0.9,
      },
    ],
    belief_updates: [],
    resolved_open_questions: [],
    new_open_questions: [],
  };
  const raw = JSON.stringify(payload);
  t.deepEqual(parseSidecar(raw), payload);
});

test("unwraps sidecar block wrapped in a json code fence", (t) => {
  const json = '{"turn_signal":"substantive"}';
  const content = `Visible text.\n\`\`\`json\n${SIDECAR_BEGIN}\n${json}\n${SIDECAR_END}\n\`\`\``;
  const result = splitSidecar(content);
  t.is(result.parseStatus, "parsed");
  t.is(result.sidecarRaw, json);
  t.is(result.visible, "Visible text.");
});

test("unwraps sidecar block wrapped in a plain code fence", (t) => {
  const json = '{"turn_signal":"acknowledgment"}';
  const content = `Visible.\n\`\`\`\n${SIDECAR_BEGIN}\n${json}\n${SIDECAR_END}\n\`\`\``;
  const result = splitSidecar(content);
  t.is(result.parseStatus, "parsed");
  t.is(result.sidecarRaw, json);
});

test("does not strip code fences that do not contain a sidecar marker", (t) => {
  const json = '{"turn_signal":"substantive"}';
  const content = `\`\`\`ts\nconst x = 1;\n\`\`\`\n${SIDECAR_BEGIN}\n${json}\n${SIDECAR_END}`;
  const result = splitSidecar(content);
  t.is(result.parseStatus, "parsed");
  t.is(result.sidecarRaw, json);
  t.true(result.visible.includes("const x = 1;"));
});

test("normalizes begin marker with extra spaces", (t) => {
  const json = '{"turn_signal":"substantive"}';
  const content = `Visible.\n<<< SIDECAR_JSON >>>\n${json}\n${SIDECAR_END}`;
  const result = splitSidecar(content);
  t.is(result.parseStatus, "parsed");
  t.is(result.sidecarRaw, json);
});

test("normalizes end marker with extra spaces", (t) => {
  const json = '{"turn_signal":"substantive"}';
  const content = `Visible.\n${SIDECAR_BEGIN}\n${json}\n<<< END_SIDECAR >>>`;
  const result = splitSidecar(content);
  t.is(result.parseStatus, "parsed");
  t.is(result.sidecarRaw, json);
});

test("normalizes both markers with extra spaces", (t) => {
  const json = '{"turn_signal":"substantive"}';
  const content = `Visible.\n<<< SIDECAR_JSON >>>\n${json}\n<<< END_SIDECAR >>>`;
  const result = splitSidecar(content);
  t.is(result.parseStatus, "parsed");
  t.is(result.sidecarRaw, json);
});

test("normalizes markers with newline whitespace between angle brackets", (t) => {
  const json = '{"turn_signal":"substantive"}';
  const content = `Visible.\n<<<SIDECAR_JSON >>>\n${json}\n<<<END_SIDECAR >>>`;
  const result = splitSidecar(content);
  t.is(result.parseStatus, "parsed");
  t.is(result.sidecarRaw, json);
});

test("recovers when sidecar is fenced and markers have extra spaces", (t) => {
  const json = '{"turn_signal":"substantive"}';
  const content = `Visible.\n\`\`\`json\n<<< SIDECAR_JSON >>>\n${json}\n<<< END_SIDECAR >>>\n\`\`\``;
  const result = splitSidecar(content);
  t.is(result.parseStatus, "parsed");
  t.is(result.sidecarRaw, json);
});

test("visible text from normalized response does not contain raw whitespace markers", (t) => {
  const json = '{"turn_signal":"substantive"}';
  const content = `Visible.\n<<< SIDECAR_JSON >>>\n${json}\n<<< END_SIDECAR >>>`;
  const result = splitSidecar(content);
  t.false(result.visible.includes("<<< SIDECAR_JSON >>>"));
  t.false(result.visible.includes("<<<SIDECAR_JSON>>>"));
});
