# Model Roles

| Model | Role | When |
|-------|------|------|
| `deepseek-v4-pro` | **Master** | Architecture, review, complex tasks, decisions |
| `deepseek-v4-flash` | **Subagent** | Isolated implementation, boilerplate, docs |
| `minimax-m3` | **Escalation** | Pro failed 2x, system design, heisenbugs |

## Master Agent (deepseek-v4-pro)

Use for ALL of the following:
- Breaking feature requests into task plans
- Architectural decisions and tradeoff analysis
- Code review of subagent output
- Complex multi-file refactors
- Decision-making ("which approach?", "which library?")
- Anything where missing context would cause bugs

**Configured via:** `agent-canvas.service` env var `LLM_MODEL=deepseek-v4-pro`

## Subagent Pool (deepseek-v4-flash)

Use ONLY for:
- Implementing a single well-defined function/module
- Boilerplate generation (CRUD, models, forms)
- Documentation, comments, README updates
- Mechanical changes (rename, extract, reformat)

**Prerequisite:** task MUST have a clear spec, exact signature, and expected output.
Never give Flash open-ended or ambiguous instructions.

**Configured via:** agent definition files in `.openhands/agents/*.md` with `model: deepseek-v4-flash`

## Escalation Model (minimax-m3)

Use ONLY when:
- v4-pro failed to solve the problem in 2 attempts
- The task is system-design level with high cost of error
- Debugging subtle race conditions, memory leaks, or heisenbugs
- Interpreting deeply ambiguous or contradictory requirements

**DO NOT use M3 iteratively — one shot per hard problem.**

## Deployment

### 1. Install LLM profiles on the host

Copy the profile JSON files to `~/.openhands/profiles/`:

```bash
cp docs/openhands/config/profiles/deepseek-v4-pro.json ~/.openhands/profiles/
cp docs/openhands/config/profiles/deepseek-v4-flash.json ~/.openhands/profiles/
cp docs/openhands/config/profiles/minimax-m3.json ~/.openhands/profiles/
```

Replace placeholder values with actual API keys before deploying.

### 2. Agent definition files

Agent definition overrides for built-in subagents are in `.openhands/agents/*.md`.
These are auto-loaded by agent-canvas when the project directory is the workspace.

The override files set `model: deepseek-v4-flash` for:
- `bash-runner` — shell commands, tests, builds
- `code-explorer` — codebase exploration
- `general-purpose` — mixed tasks (edit + shell)
- `web-researcher` — web research

Custom agents in `docs/openhands/agents/` use `model: inherit` (parent model = Pro).
These are judgment-heavy roles and should NOT use Flash.

### 3. Update systemd service

```bash
sudo cp docs/openhands/config/agent-canvas.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl restart agent-canvas
```

### 4. Escalating to M3

Edit `.openhands/agents/` files to temporarily change `model:` to `minimax-m3`,
or switch the profile in the Settings UI before running the problem task.
Switch back after.

## Budget Heuristic
- ~60% of tokens via Flash (bulk implementation)
- ~30% via Pro (architecture, review)
- ~10% via M3 (escalation only)

