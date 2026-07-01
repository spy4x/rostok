# Add to ~/.bashrc or ~/.zshrc
export MASTER_MODEL="deepseek-v4-pro"
export SUBAGENT_MODEL="deepseek-v4-flash"
export ESCALATE_MODEL="minimax-m3"

# Master (default) — uses systemd service LLM_MODEL, override explicit
alias oh-pro='LLM_MODEL="$MASTER_MODEL" openhands run'
# Subagent tasks — isolated, well-defined work
alias oh-flash='LLM_MODEL="$SUBAGENT_MODEL" LLM_TEMPERATURE=0.0 openhands run'
# Escalation — one-shot for hard problems only
alias oh-m3='LLM_MODEL="$ESCALATE_MODEL" openhands run'
