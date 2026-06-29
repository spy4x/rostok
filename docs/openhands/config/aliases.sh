# Add to ~/.bashrc or ~/.zshrc
export MASTER_MODEL="deepseek-v4-pro"
export SUBAGENT_MODEL="deepseek-v4-flash"
export ESCALATE_MODEL="minimax-m3"

alias oh-master='openhands run --model "$MASTER_MODEL"'
alias oh-sub='openhands run --model "$SUBAGENT_MODEL"'
alias oh-escalate='openhands run --model "$ESCALATE_MODEL"'
