# Grok Build integration plan (BitFrost fork, personal use, fresh install)

## 0. Verified baseline (live, 2026-10-23)

- `grok 1.0.67` at `~/.grok/bin/grok`, logged in (`cached_token`).
- `grok agent --no-leader stdio` works, isolated persistent ACP. `initialize{protocolVersion:1}` OK.
- `agentCapabilities.loadSession:true`, `sessionCapabilities: list/resume/close` (no `delete`).
- `session/new {cwd, mcpServers:[], _meta:{yoloMode:false, autoMode:false, rules}}` ACCEPTED.
- `configOptions`: `model` (model), `reasoning_effort` (thought_level). Models seen: `grok-4.7-build-fast`, `grok-4.6`, `grok-4.5`, `grok-4.7`. Efforts: `xhigh/high/medium/low`.
- **Critical: 1.0.67 wants BARE strings.** `set_config_option {configId:model, value:"grok-4.7"}` OK. `value:{value:"grok-4.7"}` → `-32602 Invalid params / untagged enum SessionConfigOptionValue`. Starter's `taggedConfigValues:true` is wrong for this version.
- `session/close` OK (`_meta.x.ai/closeOutcome: closed`).

## 1. Goal / scope (agreed)

- Codex / opencode / grok all usable as subagents in Claude Code.
- Base: starter patch already applied to `main` working tree (uncommitted).
- Scope: basic ACP parity + native steering (`x.ai/interject`) with race fix. Fresh-install only; ignore old DB migrations.
- Non-goals: `grok -p` wrapper, model API calls, touching `~/.grok/auth.json`, `systemPromptOverride`, old-migration paths.

## 2. Wire contract (1.0.67)

- Launch: `grok`, args `['agent','--no-leader','stdio']`, `loginCommand: 'grok login'`.
- `session/new`: always include `_meta:{yoloMode:false, autoMode:false}` + `rules` when present. Never `systemPromptOverride`.
- `session/load`: same `_meta` yolo/auto (starter misses this — fix).
- `set_config_option`: bare strings only (schema-mandated; opencode and grok 1.0.67 both reject tagged). No fallback.
- `session/prompt`: `{sessionId, prompt:[{type:text}]}` only; no `sendNow` for normal SendMessage.
- `x.ai/interject` (experimental, gated): `{sessionId, text, interjectionId: uuid}` → `{status:'queued'}`. `queued` ≠ consumed. LIVE FINDING (1.0.67, `--no-leader stdio`): extension replies `-32601 Method not found` — unavailable in this binary/mode despite existing in source. Adapter degrades safely to queue; keep gated until a Grok version advertises it.
- Shutdown: `session/close` preferred; `session/delete` unsupported (BitFrost `dropSession` already handles caps).

## 3. File changes

- `providers/acp.ts`: `AcpAgentSpec` drops `taggedConfigValues`; adds `promptUsageMeta` (Grok-only) for _meta usage totals billed from `usage.*` (never last-call siblings). `sendInput()` reports `'steered'` only with same-turn+epoch ack, else exactly-once queue (never runTurn in fallback).
- `providers/acp-agents.ts`: `GROK` spec — `taggedConfigValues:false` (fallback still allowed), `gates:'destructive'`, `nativeInterject:false` default, enabled via `providers.grok.experimentalInterject`. Update `note` with bare-string + 1.0.67 note.
- `providers/index.ts`: already registers `grokProvider` (keep, order after opencode).
- `test/fake-acp.mjs` + `fixtures/acp/grok.json`: fixture must mirror 1.0.67 — bare values accepted, tagged rejected (invert current), models `grok-4.7-build-fast/4.6/4.5/4.7`, efforts `xhigh/high/medium/low`. Keep `interject:true` scenario.
- `test/acp.spec.ts`: update expectations to bare `[{value:'grok-4.6'}]`-as-string, add: (a) tagged-fallback test, (b) load re-asserts yolo/auto, (c) interject race test (complete vs interject), (d) no second `session/prompt` on steer path.

## 4. Steering race fix (required for scope)

Problem: Grok falls back to a new prompt turn when idle (`run_loop.rs` `current_prompt_id==None` → `queue_interjection_fallback_prompt`). BitFrost tracks one `turn` per session; late acks can strand output.

Fix:
- Per-session `epoch` counter incremented on every `turn_completed`/`session_failed`/cancel.
- `sendInput` when `st.turn` active: capture `epoch`, send `x.ai/interject` with fresh `interjectionId`, store `{id, text, epoch}` in `inflightInterject`.
- Correlate: only return `'steered'` if ack arrives AND `st.turn` still same object AND epoch unchanged AND a subsequent Grok event for that turn is observed (chunk/tool/update) within grace window; else return `'queued'` and let normal queue/restart deliver at turn boundary.
- Dedupe by `interjectionId`; never resend same id; timeout → `'queued'`.
- Idle case (`!st.turn`): never call interject; normal `runTurn` path.

## 5. Permissions / auth

- Keep `gates:'destructive'`, `yoloMode/autoMode:false`. Capture real permission/elicitation fixtures next (ask vs auto vs always-approve). No `GROK_SUBAGENTS=0` unless env verified in grok source. Never set fresh `GROK_HOME`.

## 6. Verification

- `node --test .../acp.spec.ts` (target: all pass incl. new race/fallback tests).
- Live: `bitfrost selftest grok <model>`, parallel Codex+opencode+grok in disposable worktrees, interrupt + resume via `session/load`, permission allow/deny round-trip.
- No `tsc` full pass expected in this env (missing plugin types); rely on daemon tests.

## 7. Rollout (personal)

- Config: nothing needed — Grok is automatic when installed and signed in, like Codex. `providers.grok.enabled: false` turns it off. `experimentalInterject` stays unset.
- No migration work (fresh install, `v8 schema.sql` direct).
