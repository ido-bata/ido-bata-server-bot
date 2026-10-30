# CLAUDE.md

Claude Code must read [`AGENTS.md`](AGENTS.md) first for every task. It is the single dispatcher for all agents (Claude Code, Codex, OpenCode, subagents) on this repo — project identity, commands, skill routing, house rules, worktrees, and recovery entry points.

Skill bodies are mirrored at `.claude/skills/` (same content as the committed universal `.agents/skills/`). Do not diverge the two copies manually; update via `mise run skills-bootstrap` / `mise run skills-update` and commit `skills-lock.json`.
