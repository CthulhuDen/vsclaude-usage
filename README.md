# Claude Code usage badge for VS Code

A local patch for the Claude Code VS Code extension. It adds a small, always-visible badge to each chat panel, just above the input box:

```
ctx:27% · 5h:40%(2h) · 7d:12%(4d18h)
```

- **ctx**: context used as a % of the model's context window (input + cache tokens, output excluded). Hover to see `tokens / window`. Colors: green below 20%, yellow below 40%, red otherwise.
- **5h / 7d**: plan usage for the rolling 5-hour and 7-day limits, with the time until reset. 5h turns yellow at 50% and red at 75%; 7d turns yellow at 40% and red at 75%.
- **fable**: the separate weekly Fable limit, shown only when the extension reports one (same colors as 7d).

Colors come from the VS Code theme, and uncolored segments use the normal text color. `–` means no data yet. A restored tab first shows the token count from its history (e.g. `ctx:54k`). It switches to a percentage once the next response reports the context window.

## Why a patch

The chat panel ignores the `statusLine` setting. Its context pie stays hidden until more than half the window is used. The 5h/7d limits appear only in `/usage` or as a near-limit warning. VS Code gives other extensions no way into this webview, so `apply.sh` appends `badge.js` to the extension's `webview/index.js`.

The script is passive. It listens to the messages the extension already sends its panel and draws its own element. It never messages the extension, and it relies only on message-type strings and Agent SDK fields, not on minified names or CSS classes. On any unexpected data the badge hides itself. It never breaks the panel.

## Apply / remove

```sh
./apply.sh              # patch every installed anthropic.claude-code-* version
./apply.sh --uninstall  # restore the original bundles
```

Then run **Developer: Reload Window** in each open VS Code window.

`apply.sh` is safe to re-run:
- It keeps a one-time `webview/index.js.orig` backup per version.
- It replaces an existing badge block instead of adding a second one.
- It runs `node --check` on the patched bundle and leaves a version untouched if the check fails.

`VSCODE_EXTENSIONS_DIR` points it at another extensions folder, e.g. `~/.vscode-insiders/extensions`.

**Extension updates install a new version folder without the patch. Re-run `./apply.sh` after every update.**

## Debugging

`./apply.sh --debug` also logs each relevant message and the resulting badge state to the webview console, prefixed `[usage-badge]`. To see it, reload the window, then run **Developer: Open Webview Developer Tools** and select the Claude Code panel. Run `./apply.sh` again without `--debug` to turn logging off.

## Limitations

- One panel can hold several sessions (e.g. the sidebar switching sessions in place). The badge shows whichever session last had main-thread activity, so a reply from a background session in the same panel briefly takes over the badge.
- The badge follows the input box by looking for the editable textbox element. If that lookup ever stops working, it falls back to a fixed spot near the bottom-right. It can sit over or under the panel's own popups.
- API-key and third-party-provider accounts have no plan limits, so 5h/7d stay at `–`.

## Tests

```sh
node --test
```

## Follow-ups

- Auto-reapply after extension updates, e.g. a launchd agent watching `~/.vscode/extensions`.
- Patch VS Code Insiders / Cursor extension folders by default.
