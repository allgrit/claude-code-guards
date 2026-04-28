# claude-code-guards

Process guardrails for Claude Code projects. Prevents AI agents from cutting corners.

## What it blocks

- **Direct commits on master** — forces worktree workflow
- **Force push** — protects branch history
- **`--no-verify`** — no skipping pre-commit hooks
- **Guard file mutation** — guard.cjs, guard-edit.cjs, deploy.sh are read-only on master
- **Protected file deletion** — configurable list (default: world.json, clans_permanent.json)
- **Shell delegation** — blocks `bash -c`, `eval`, `sh -c`
- **Merge without spec/plan** — feat/ branches must have spec + plan + reviews
- **Deploy without push** — forces `git push` before deploy
- **Source edits on master** — src/, tests/, package.json blocked on master

## Install

```bash
npm install claude-code-guards
npx claude-code-guards init
```

This will:
1. Copy `guard.cjs` and `guard-edit.cjs` into `.claude/hooks/`
2. Merge hook config into `.claude/settings.local.json`
3. Copy test file into `tests/guards/`

## Update

```bash
npx claude-code-guards update
```

Overwrites hook files but preserves your `.claude/guards.config.json`.

## Configure

Create `.claude/guards.config.json` in your project root:

```json
{
  "protectedFiles": ["database.sqlite", "secrets.json"],
  "sshHost": "my-server",
  "requireSpecPlan": false,
  "requireVersionBump": true,
  "immutablePaths": ["docs/specs", "docs/plans"]
}
```

### Config options

| Option | Default | Description |
|--------|---------|-------------|
| `protectedFiles` | `["world.json", "clans_permanent.json"]` | Files that `rm` is blocked on |
| `immutablePaths` | `["docs/superpowers/specs", "docs/superpowers/plans"]` | Paths where rm/git rm/git mv is blocked |
| `sshHost` | `null` | SSH host — warns on direct scp/rsync/restart |
| `deployCommand` | `"bash deploy"` | Deploy command pattern (checks push before deploy) |
| `requireVersionBump` | `true` | Require version bump + CHANGELOG on merge |
| `requireSpecPlan` | `true` | Require spec + plan for feat/ branches |
| `requireDocsSync` | `true` | Require CLAUDE.md update when core files change |
| `blockShellDelegation` | `true` | Block bash -c, eval, sh -c |
| `blockCheckoutBranch` | `true` | Block checkout -b (force worktree workflow) |
| `worktreePath` | `".worktrees/"` | Worktree directory (always allowed) |

## Test

```bash
npx vitest run tests/guards/guard.test.ts
```

## How it works

Guards run as Claude Code [PreToolUse hooks](https://docs.anthropic.com/en/docs/claude-code/hooks).
They receive the tool input via stdin, check against rules, and output a JSON response:
- `{}` — allow
- `{ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "..." } }` — block with reason
- `{ systemMessage: "..." }` — warn but allow

## API

```js
const { loadConfig, DEFAULT_CONFIG } = require('claude-code-guards');

// Load config from .claude/guards.config.json with defaults
const config = loadConfig(process.cwd());
```

## License

MIT
