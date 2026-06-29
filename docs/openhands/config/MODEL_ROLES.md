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

## Subagent Pool (deepseek-v4-flash)

Use ONLY for:
- Implementing a single well-defined function/module
- Boilerplate generation (CRUD, models, forms)
- Documentation, comments, README updates
- Mechanical changes (rename, extract, reformat)

**Prerequisite:** task MUST have a clear spec, exact signature, and expected output.
Never give Flash open-ended or ambiguous instructions.

## Escalation Model (minimax-m3)

Use ONLY when:
- v4-pro failed to solve the problem in 2 attempts
- The task is system-design level with high cost of error
- Debugging subtle race conditions, memory leaks, or heisenbugs
- Interpreting deeply ambiguous or contradictory requirements

**DO NOT use M3 iteratively — one shot per hard problem.**

## Escalating to M3

```bash
# Per-run override:
OPENHANDS_LLM_MODEL=minimax-m3 OPENHANDS_LLM_API_KEY=$M3_API_KEY \
  openhands run "debug the race condition in src/scheduler.py"

# Or edit config.toml temporarily:
# [llm] model = "minimax-m3"
```

## Budget Heuristic
- ~60% of tokens via Flash (bulk implementation)
- ~30% via Pro (architecture, review)
- ~10% via M3 (escalation only)
