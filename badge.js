/* BEGIN claude-usage-badge */
// Usage badge for the Claude Code VS Code chat panel, appended to webview/index.js by apply.sh.
// Passive: it only listens to host -> webview messages and draws its own fixed-position element.
// Depends only on message-protocol string literals and Agent SDK message fields.
;(function () {
  "use strict";
  var DEBUG = false;

  var SYNTHETIC_MODEL = "<synthetic>";
  var WINDOW_KEYS = ["five_hour", "seven_day", "seven_day_overage_included"];

  // ---- Pure logic -------------------------------------------------------

  function isNum(x) {
    return typeof x === "number" && isFinite(x);
  }

  function isObj(x) {
    return x !== null && typeof x === "object";
  }

  function bad(what) {
    return new Error("unexpected shape: " + what);
  }

  function clone(x) {
    return JSON.parse(JSON.stringify(x));
  }

  function initialState() {
    return { channels: {}, current: null, pending: null, windows: null, error: false };
  }

  // Context tokens: input + cache reads/writes, output tokens excluded.
  function usageTokens(u) {
    if (!isObj(u) || !isNum(u.input_tokens)) throw bad("usage");
    var sum = u.input_tokens;
    ["cache_creation_input_tokens", "cache_read_input_tokens"].forEach(function (k) {
      if (u[k] == null) return;
      if (!isNum(u[k])) throw bad("usage." + k);
      sum += u[k];
    });
    return sum;
  }

  // True for assistant messages that count toward the main conversation's context.
  function isMainAssistant(msg) {
    if (msg.parent_tool_use_id) return false;
    if (!isObj(msg.message)) throw bad("assistant.message");
    return msg.message.model !== SYNTHETIC_MODEL && msg.message.usage != null;
  }

  // Mirrors the webview's own merge: null deletes a window, a missing one keeps the old,
  // and an update without resetsAt never replaces one that has it.
  function mergeWindows(prev, next) {
    if (!next) return prev;
    if (!isObj(next)) throw bad("unifiedWindows");
    var out = Object.assign({}, prev || {});
    var changed = false;
    WINDOW_KEYS.forEach(function (k) {
      var w = next[k];
      if (w === null) {
        if (out[k] !== undefined) {
          delete out[k];
          changed = true;
        }
        return;
      }
      if (!w || (w.resetsAt === undefined && out[k] && out[k].resetsAt !== undefined)) return;
      if (!isObj(w) || !isNum(w.utilization) || (w.resetsAt != null && !isNum(w.resetsAt))) {
        throw bad("unifiedWindows." + k);
      }
      out[k] = { utilization: w.utilization, resetsAt: w.resetsAt == null ? null : w.resetsAt };
      changed = true;
    });
    if (!changed) return prev;
    return Object.keys(out).length ? out : null;
  }

  function pickContextWindow(modelUsage, ch) {
    if (modelUsage == null) return null;
    if (!isObj(modelUsage)) throw bad("modelUsage");
    function windowOf(entry) {
      return isObj(entry) && isNum(entry.contextWindow) && entry.contextWindow > 0 ? entry.contextWindow : null;
    }
    var named = [ch.initModel, ch.lastModel];
    for (var i = 0; i < named.length; i++) {
      var w = named[i] ? windowOf(modelUsage[named[i]]) : null;
      if (w) return w;
    }
    var max = null;
    Object.keys(modelUsage).forEach(function (k) {
      var w = windowOf(modelUsage[k]);
      if (w && (max === null || w > max)) max = w;
    });
    return max;
  }

  // Returns the channel, creating it on first sight. A new channel inherits tokens
  // seeded from a just-loaded session history.
  function touchChannel(s, id) {
    var ch = s.channels[id];
    if (!ch) {
      ch = s.channels[id] = { tokens: null, window: null, initModel: null, lastModel: null, sessionId: null };
      if (s.pending) {
        ch.tokens = s.pending.tokens;
        s.pending = null;
      }
    }
    return ch;
  }

  function reduceIo(state, hm) {
    var msg = hm.message;
    if (!isObj(msg)) return state;
    var t = msg.type;
    var s;

    if (t === "rate_limit_event") {
      if (!isObj(msg.rate_limit_info)) throw bad("rate_limit_info");
      if (msg.rate_limit_info.unifiedWindows === undefined) return state;
      s = clone(state);
      s.windows = mergeWindows(s.windows, msg.rate_limit_info.unifiedWindows);
      return s;
    }

    var isInit = t === "system" && msg.subtype === "init";
    var isCompact = t === "system" && msg.subtype === "compact_boundary";
    if (t !== "assistant" && t !== "result" && !isInit && !isCompact) return state;
    if (t === "assistant" && !isMainAssistant(msg)) return state;
    if (typeof hm.channelId !== "string") throw bad("channelId");

    s = clone(state);
    var ch = touchChannel(s, hm.channelId);
    s.current = hm.channelId;
    if (t === "assistant") {
      ch.tokens = usageTokens(msg.message.usage);
      if (typeof msg.message.model === "string") ch.lastModel = msg.message.model;
    } else if (t === "result") {
      var w = pickContextWindow(msg.modelUsage, ch);
      if (w) ch.window = w;
    } else if (isInit) {
      if (typeof msg.model === "string") ch.initModel = msg.model;
      if (typeof msg.session_id === "string") {
        if (ch.sessionId && ch.sessionId !== msg.session_id) ch.tokens = null;
        ch.sessionId = msg.session_id;
      }
    } else {
      ch.tokens = null;
    }
    return s;
  }

  function historyTokens(messages) {
    if (!Array.isArray(messages)) throw bad("get_session_response.messages");
    for (var i = messages.length - 1; i >= 0; i--) {
      var m = messages[i];
      if (!isObj(m)) continue;
      if (m.type === "system" && m.subtype === "compact_boundary") return null;
      if (m.type === "assistant" && isMainAssistant(m)) return usageTokens(m.message.usage);
    }
    return null;
  }

  function reduceInner(state, hm) {
    if (!isObj(hm)) return state;
    var s;
    if (hm.type === "io_message") return reduceIo(state, hm);
    if (hm.type === "request" && isObj(hm.request) && hm.request.type === "panel_usage_update") {
      s = clone(state);
      s.windows = mergeWindows(s.windows, hm.request.unifiedWindows);
      return s;
    }
    if (hm.type === "response" && isObj(hm.response) && hm.response.type === "get_session_response") {
      s = clone(state);
      s.pending = { tokens: historyTokens(hm.response.messages) };
      s.current = null;
      return s;
    }
    return state;
  }

  // Host message (event.data.message) -> next state. Returns the same object for
  // irrelevant messages. A relevant message with an unexpected shape sets error
  // (badge hidden); the next valid relevant message clears it.
  function reduce(state, hm) {
    try {
      var next = reduceInner(state, hm);
      if (next !== state) next.error = false;
      return next;
    } catch (e) {
      if (DEBUG) console.debug("[usage-badge]", e, hm);
      var s = clone(state);
      s.error = true;
      return s;
    }
  }

  // Compact time until reset: now, 45m (rounded up), 2h, 4d18h, 4d.
  function compactUntil(secs) {
    if (secs <= 0) return "now";
    if (secs < 3600) return Math.floor((secs + 59) / 60) + "m";
    if (secs < 86400) return Math.floor(secs / 3600) + "h";
    var days = Math.floor(secs / 86400);
    var hours = Math.floor((secs % 86400) / 3600);
    return hours > 0 ? days + "d" + hours + "h" : days + "d";
  }

  function formatTokens(n) {
    if (n < 1000) return String(Math.round(n));
    var k = Math.round(n / 1000);
    if (k < 1000) return k + "k";
    return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  }

  function groupDigits(n) {
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  function ctxSegment(src) {
    if (!src || !isNum(src.tokens)) {
      return { text: "ctx:–", level: "dim", title: "Context usage appears after the next response" };
    }
    if (isNum(src.window) && src.window > 0) {
      var pct = Math.round((src.tokens / src.window) * 100);
      return {
        text: "ctx:" + pct + "%",
        level: pct < 20 ? "ok" : pct < 40 ? "warn" : "bad",
        title: groupDigits(src.tokens) + " / " + groupDigits(src.window) + " tokens",
      };
    }
    return {
      text: "ctx:" + formatTokens(src.tokens),
      level: "default",
      title: groupDigits(src.tokens) + " tokens (context window unknown until the next response)",
    };
  }

  function limitSegment(label, w, warnAt, nowMs) {
    if (!w) return { text: label + ":–", level: "dim", title: "" };
    var hasReset = isNum(w.resetsAt);
    var expired = hasReset && w.resetsAt * 1000 <= nowMs;
    var pct = expired ? 0 : Math.round(w.utilization * 100);
    var text = label + ":" + pct + "%";
    if (hasReset && !expired) text += "(" + compactUntil(Math.floor(w.resetsAt) - Math.floor(nowMs / 1000)) + ")";
    return { text: text, level: pct >= 75 ? "bad" : pct >= warnAt ? "warn" : "default", title: "" };
  }

  // State -> what to draw. level: ok | warn | bad | default | dim.
  function view(state, nowMs) {
    if (state.error) return { hidden: true, segments: [] };
    var src = state.current !== null && state.channels[state.current] ? state.channels[state.current] : state.pending;
    var w = state.windows || {};
    var segments = [
      ctxSegment(src),
      limitSegment("5h", w.five_hour, 50, nowMs),
      limitSegment("7d", w.seven_day, 40, nowMs),
    ];
    if (w.seven_day_overage_included) segments.push(limitSegment("fable", w.seven_day_overage_included, 40, nowMs));
    return { hidden: false, segments: segments };
  }

  var api = {
    initialState: initialState,
    reduce: reduce,
    mergeWindows: mergeWindows,
    compactUntil: compactUntil,
    formatTokens: formatTokens,
    view: view,
  };

  var testHook = typeof globalThis === "object" ? globalThis.__usageBadgeTest : undefined;
  if (testHook) {
    testHook.api = api;
    return;
  }

  // ---- DOM --------------------------------------------------------------

  if (typeof window === "undefined" || typeof document === "undefined" || window.IS_SESSION_LIST_ONLY) return;

  var COLORS = {
    ok: "var(--vscode-charts-green, var(--vscode-testing-iconPassed))",
    warn: "var(--vscode-charts-yellow, var(--vscode-editorWarning-foreground))",
    bad: "var(--vscode-charts-red, var(--vscode-errorForeground))",
    default: "var(--vscode-foreground)",
    dim: "var(--vscode-disabledForeground, var(--vscode-descriptionForeground))",
  };
  var FALLBACK_BOTTOM = 120;
  var FALLBACK_RIGHT = 16;

  function isInteresting(hm) {
    if (!isObj(hm)) return false;
    if (hm.type === "io_message") {
      var t = isObj(hm.message) ? hm.message.type : undefined;
      return t === "assistant" || t === "result" || t === "system" || t === "rate_limit_event";
    }
    if (hm.type === "request") return isObj(hm.request) && hm.request.type === "panel_usage_update";
    if (hm.type === "response") return isObj(hm.response) && hm.response.type === "get_session_response";
    return false;
  }

  function start() {
    var state = initialState();
    var lastKey = null;
    var box = null;
    var el = document.createElement("div");
    el.id = "claude-usage-badge";
    Object.assign(el.style, {
      position: "fixed",
      right: FALLBACK_RIGHT + "px",
      bottom: FALLBACK_BOTTOM + "px",
      zIndex: "1",
      padding: "1px 6px",
      borderRadius: "4px",
      fontFamily: "var(--vscode-editor-font-family, monospace)",
      fontSize: "11px",
      lineHeight: "16px",
      whiteSpace: "nowrap",
      userSelect: "none",
      background: "var(--vscode-editorWidget-background, var(--vscode-editor-background))",
      border: "1px solid var(--vscode-widget-border, var(--vscode-panel-border, transparent))",
      color: COLORS.default,
    });
    document.body.appendChild(el);

    function hide() {
      lastKey = null;
      el.style.display = "none";
    }

    function render() {
      var v = view(state, Date.now());
      var key = v.hidden ? "hidden" : JSON.stringify(v.segments);
      if (key === lastKey) return;
      lastKey = key;
      el.style.display = v.hidden ? "none" : "block";
      el.textContent = "";
      v.segments.forEach(function (seg, i) {
        if (i) {
          var sep = document.createElement("span");
          sep.textContent = " · ";
          sep.style.color = COLORS.dim;
          el.appendChild(sep);
        }
        var span = document.createElement("span");
        span.textContent = seg.text;
        span.style.color = COLORS[seg.level];
        if (seg.title) span.title = seg.title;
        el.appendChild(span);
      });
    }

    // The chat input box: the lowest visible editable textbox, widened to its nearest
    // ancestor that also holds the toolbar buttons (but not a page-sized container).
    function findBox() {
      var best = null;
      var bestBottom = -Infinity;
      var eds = document.querySelectorAll('[contenteditable][role="textbox"]');
      for (var i = 0; i < eds.length; i++) {
        var r = eds[i].getBoundingClientRect();
        if (eds[i].isContentEditable && r.width > 0 && r.height > 0 && r.bottom > bestBottom) {
          best = eds[i];
          bestBottom = r.bottom;
        }
      }
      if (!best) return null;
      for (var n = best.parentElement; n && n !== document.body; n = n.parentElement) {
        if (n.getBoundingClientRect().height > window.innerHeight / 2) break;
        if (n.querySelector("button")) return n;
      }
      return best;
    }

    function place() {
      var r = box && box.isConnected ? box.getBoundingClientRect() : null;
      if (r && r.height > 0) {
        el.style.bottom = window.innerHeight - r.top + 4 + "px";
        el.style.right = Math.max(4, window.innerWidth - r.right) + "px";
      } else {
        el.style.bottom = FALLBACK_BOTTOM + "px";
        el.style.right = FALLBACK_RIGHT + "px";
      }
    }

    var ro = typeof ResizeObserver === "function" ? new ResizeObserver(function () {
      try {
        place();
      } catch (e) {
        hide();
      }
    }) : null;

    function relocate() {
      var b = findBox();
      if (b !== box) {
        if (ro) {
          ro.disconnect();
          if (b) ro.observe(b);
        }
        box = b;
      }
      place();
    }

    function tick() {
      try {
        relocate();
        render();
      } catch (e) {
        hide();
      }
    }

    window.addEventListener("message", function (event) {
      try {
        var d = event.data;
        if (!isObj(d) || d.type !== "from-extension") return;
        var next = reduce(state, d.message);
        if (DEBUG && isInteresting(d.message)) console.debug("[usage-badge]", d.message, "->", next);
        if (next === state) return;
        state = next;
        render();
      } catch (e) {
        hide();
      }
    });
    window.addEventListener("resize", tick);
    setInterval(tick, 1000);
    tick();
  }

  try {
    if (document.body) start();
    else document.addEventListener("DOMContentLoaded", function () {
      try {
        start();
      } catch (e) {
        console.warn("[usage-badge] disabled:", e);
      }
    });
  } catch (e) {
    console.warn("[usage-badge] disabled:", e);
  }
})();
/* END claude-usage-badge */
