"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

globalThis.__usageBadgeTest = {};
require("../badge.js");
const { initialState, reduce, mergeWindows, compactUntil, formatTokens, view } = globalThis.__usageBadgeTest.api;

const NOW = 1_800_000_000_000; // ms
const NOW_S = NOW / 1000;
const H = 3600;
const D = 86400;

const io = (channelId, message) => ({ type: "io_message", channelId, message, done: false });
const usage = (input, create = 0, read = 0) => ({
  input_tokens: input,
  cache_creation_input_tokens: create,
  cache_read_input_tokens: read,
  output_tokens: 9999,
});
const assistant = (u, model = "claude-opus-5-5", extra = {}) => ({
  type: "assistant",
  parent_tool_use_id: null,
  message: { model, usage: u },
  ...extra,
});
const result = (modelUsage) => ({ type: "result", subtype: "success", total_cost_usd: 0.1, modelUsage });
const init = (model, session_id) => ({ type: "system", subtype: "init", model, session_id });
const compact = () => ({ type: "system", subtype: "compact_boundary" });
const panelUsage = (unifiedWindows) => ({
  type: "request",
  channelId: "",
  requestId: "r1",
  request: { type: "panel_usage_update", unifiedWindows },
});
const rateLimit = (unifiedWindows) => ({ type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows } });
const history = (messages) => ({ type: "response", requestId: "r2", response: { type: "get_session_response", messages } });

const run = (...msgs) => msgs.reduce((s, m) => reduce(s, m), initialState());
const segs = (state, now = NOW) => view(state, now).segments;
const text = (state, now = NOW) => segs(state, now).map((s) => s.text).join(" ");
const seg = (state, label, now = NOW) => segs(state, now).find((s) => s.text.startsWith(label + ":"));

// A channel with a known window, so ctx is shown as a percentage.
const withCtx = (tokens, window = 1000) =>
  run(io("c1", init("m", "s1")), io("c1", assistant(usage(tokens), "m")), io("c1", result({ m: { contextWindow: window } })));

test("compactUntil formats time until reset", () => {
  const cases = [
    [-5, "now"], [0, "now"], [1, "1m"], [59, "1m"], [60, "1m"], [61, "2m"], [3599, "60m"],
    [H, "1h"], [2 * H - 1, "1h"], [D - 1, "23h"], [D, "1d"], [2 * D + 1800, "2d"],
    [4 * D + 18 * H + 59, "4d18h"],
  ];
  for (const [secs, want] of cases) assert.equal(compactUntil(secs), want, `secs=${secs}`);
});

test("formatTokens", () => {
  const cases = [[0, "0"], [950, "950"], [54321, "54k"], [999_499, "999k"], [999_600, "1M"], [1_000_000, "1M"], [1_234_567, "1.2M"]];
  for (const [n, want] of cases) assert.equal(formatTokens(n), want, `n=${n}`);
});

test("placeholders before any data", () => {
  const s = initialState();
  assert.equal(text(s), "ctx:– 5h:– 7d:–");
  assert.ok(segs(s).every((x) => x.level === "dim"));
});

test("ctx: input + cache tokens over the result's context window", () => {
  const s = run(
    io("c1", init("claude-opus-5-5", "s1")),
    io("c1", assistant(usage(4000, 10000, 40000))),
    io("c1", result({ "claude-haiku-4-5": { contextWindow: 100_000 }, "claude-opus-5-5": { contextWindow: 200_000 } })),
  );
  assert.deepEqual(seg(s, "ctx"), { text: "ctx:27%", level: "warn", title: "54,000 / 200,000 tokens" });
});

test("ctx thresholds apply to the rounded percentage", () => {
  const cases = [[190, "ok"], [194, "ok"], [195, "warn"], [200, "warn"], [390, "warn"], [400, "bad"], [990, "bad"]];
  for (const [tokens, level] of cases) assert.equal(seg(withCtx(tokens), "ctx").level, level, `tokens=${tokens}`);
  assert.equal(seg(withCtx(195), "ctx").text, "ctx:20%");
});

test("5h/7d/fable text, countdown and thresholds", () => {
  const s = run(
    panelUsage({
      five_hour: { utilization: 0.4, resetsAt: NOW_S + 2 * H + 300 },
      seven_day: { utilization: 0.12, resetsAt: NOW_S + 4 * D + 18 * H + 1800 },
      seven_day_overage_included: { utilization: 0.3, resetsAt: NOW_S + 3 * D },
    }),
  );
  assert.equal(text(s), "ctx:– 5h:40%(2h) 7d:12%(4d18h) fable:30%(3d)");

  const level = (key, utilization) =>
    seg(run(panelUsage({ [key]: { utilization, resetsAt: NOW_S + H } })), { five_hour: "5h", seven_day: "7d", seven_day_overage_included: "fable" }[key]).level;
  const cases = [
    ["five_hour", 0.49, "default"], ["five_hour", 0.499, "warn"], ["five_hour", 0.5, "warn"], ["five_hour", 0.74, "warn"], ["five_hour", 0.75, "bad"],
    ["seven_day", 0.39, "default"], ["seven_day", 0.4, "warn"], ["seven_day", 0.74, "warn"], ["seven_day", 0.75, "bad"],
    ["seven_day_overage_included", 0.39, "default"], ["seven_day_overage_included", 0.4, "warn"], ["seven_day_overage_included", 0.75, "bad"],
  ];
  for (const [key, u, want] of cases) assert.equal(level(key, u), want, `${key}=${u}`);
});

test("expired window shows 0% without a countdown; missing resetsAt has no suffix", () => {
  const s = run(panelUsage({ five_hour: { utilization: 0.9, resetsAt: NOW_S }, seven_day: { utilization: 0.5 } }));
  assert.deepEqual(seg(s, "5h"), { text: "5h:0%", level: "default", title: "" });
  assert.equal(seg(s, "7d").text, "7d:50%");
  assert.equal(seg(s, "fable"), undefined);
});

test("mergeWindows mirrors the webview's merge", () => {
  const a = { utilization: 0.1, resetsAt: 100 };
  const b = { utilization: 0.2, resetsAt: 200 };
  const prev = { five_hour: a, seven_day: a };
  assert.equal(mergeWindows(prev, undefined), prev);
  assert.equal(mergeWindows(prev, {}), prev);
  assert.deepEqual(mergeWindows(prev, { five_hour: b }), { five_hour: b, seven_day: a });
  assert.deepEqual(mergeWindows(prev, { five_hour: null }), { seven_day: a });
  assert.equal(mergeWindows(prev, { five_hour: { utilization: 0.5 } }), prev);
  assert.deepEqual(mergeWindows(null, { five_hour: { utilization: 0.5 } }), { five_hour: { utilization: 0.5, resetsAt: null } });
  assert.equal(mergeWindows({ five_hour: a }, { five_hour: null }), null);
});

test("rate_limit_event and panel_usage_update both update windows", () => {
  const s1 = run(io("c1", rateLimit({ five_hour: { utilization: 0.6, resetsAt: NOW_S + 600 } })));
  assert.equal(seg(s1, "5h").text, "5h:60%(10m)");
  const s2 = reduce(s1, panelUsage({ seven_day: { utilization: 0.2, resetsAt: NOW_S + D } }));
  assert.equal(text(s2), "ctx:– 5h:60%(10m) 7d:20%(1d)");
  const s3 = reduce(s2, io("c1", { type: "rate_limit_event", rate_limit_info: { status: "allowed" } }));
  assert.equal(s3, s2);
});

test("subagent, synthetic and usage-less assistant messages are ignored", () => {
  const s = withCtx(100);
  assert.equal(reduce(s, io("c1", assistant(usage(900), "m", { parent_tool_use_id: "toolu_1" }))), s);
  assert.equal(reduce(s, io("c1", assistant(usage(0), "<synthetic>"))), s);
  assert.equal(reduce(s, io("c1", { type: "assistant", parent_tool_use_id: null, message: { model: "m" } })), s);
});

test("irrelevant messages return the same state", () => {
  const s = withCtx(100);
  for (const m of [
    io("c1", { type: "stream_event", event: { type: "ping" } }),
    io("c1", { type: "user", message: {} }),
    io("c1", { type: "system", subtype: "status" }),
    { type: "request", request: { type: "font_configuration_changed" } },
    { type: "response", requestId: "x", response: { type: "get_claude_state_response" } },
    null,
    "junk",
  ]) {
    assert.equal(reduce(s, m), s);
  }
});

test("result window lookup: init model, then last model, then largest entry", () => {
  const byInit = run(io("c", init("a", "s")), io("c", assistant(usage(10), "b")), io("c", result({ a: { contextWindow: 1000 }, b: { contextWindow: 100 } })));
  assert.equal(byInit.channels.c.window, 1000);
  const byLast = run(io("c", init("x[1m]", "s")), io("c", assistant(usage(10), "b")), io("c", result({ a: { contextWindow: 1000 }, b: { contextWindow: 100 } })));
  assert.equal(byLast.channels.c.window, 100);
  const byMax = run(io("c", assistant(usage(10), "z")), io("c", result({ a: { contextWindow: 1000 }, b: { contextWindow: 100 } })));
  assert.equal(byMax.channels.c.window, 1000);
  const keep = reduce(byInit, io("c", { type: "result", subtype: "error_during_execution" }));
  assert.equal(keep.channels.c.window, 1000);
});

test("/clear (new session_id) and compaction reset ctx tokens", () => {
  const s = withCtx(300);
  assert.equal(seg(s, "ctx").text, "ctx:30%");
  assert.equal(seg(reduce(s, io("c1", init("m", "s1"))), "ctx").text, "ctx:30%");
  assert.equal(seg(reduce(s, io("c1", init("m", "s2"))), "ctx").text, "ctx:–");
  assert.equal(seg(reduce(s, io("c1", compact())), "ctx").text, "ctx:–");
  const after = run(io("c1", init("m", "s1")), io("c1", assistant(usage(300), "m")), io("c1", result({ m: { contextWindow: 1000 } })), io("c1", compact()), io("c1", assistant(usage(50), "m")));
  assert.equal(seg(after, "ctx").text, "ctx:5%");
});

test("restored history seeds tokens until a result gives the window", () => {
  const msgs = [
    { type: "user", message: {} },
    assistant(usage(1000, 0, 53000)),
    assistant(usage(99999), "m", { parent_tool_use_id: "toolu_1" }),
    { type: "user", message: {} },
  ];
  let s = run(history(msgs));
  assert.deepEqual(seg(s, "ctx"), { text: "ctx:54k", level: "default", title: "54,000 tokens (context window unknown until the next response)" });

  s = reduce(s, io("new", init("claude-opus-5-5", "restored")));
  assert.equal(s.pending, null);
  assert.equal(seg(s, "ctx").text, "ctx:54k");
  s = reduce(s, io("new", result({ "claude-opus-5-5": { contextWindow: 200_000 } })));
  assert.equal(seg(s, "ctx").text, "ctx:27%");

  assert.equal(seg(run(history([assistant(usage(5000)), compact()])), "ctx").text, "ctx:–");
  assert.equal(seg(run(history([])), "ctx").text, "ctx:–");
});

test("per-channel state follows the latest main-thread activity", () => {
  let s = run(
    io("a", init("m200", "sa")), io("a", assistant(usage(50_000), "m200")), io("a", result({ m200: { contextWindow: 200_000 } })),
    io("b", init("m1m", "sb")), io("b", assistant(usage(100_000), "m1m")), io("b", result({ m1m: { contextWindow: 1_000_000 } })),
  );
  assert.equal(seg(s, "ctx").text, "ctx:10%");
  s = reduce(s, io("a", assistant(usage(60_000), "m200")));
  assert.equal(seg(s, "ctx").text, "ctx:30%");
  s = reduce(s, io("b", { type: "result", subtype: "success", total_cost_usd: 0, modelUsage: {} }));
  assert.equal(seg(s, "ctx").text, "ctx:10%");
});

test("unexpected shapes hide the badge until the next valid message", () => {
  const s = withCtx(100);
  const badCases = [
    io("c1", assistant({ input_tokens: "12" })),
    io("c1", assistant({ input_tokens: 1, cache_read_input_tokens: "x" })),
    io("c1", { type: "assistant", parent_tool_use_id: null, message: "nope" }),
    io(undefined, assistant(usage(1))),
    io("c1", result("nope")),
    io("c1", { type: "rate_limit_event" }),
    panelUsage({ five_hour: { utilization: "40%" } }),
    panelUsage({ five_hour: { utilization: 0.4, resetsAt: "soon" } }),
    panelUsage("nope"),
    history("nope"),
  ];
  for (const m of badCases) {
    const broken = reduce(s, m);
    assert.equal(view(broken, NOW).hidden, true, JSON.stringify(m));
    const healed = reduce(broken, io("c1", assistant(usage(200), "m")));
    assert.equal(view(healed, NOW).hidden, false);
    assert.equal(seg(healed, "ctx").text, "ctx:20%");
  }
});
