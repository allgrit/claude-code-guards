# claude-code-guards

Portable process guardrails for Claude Code projects. Prevents AI agents from cutting corners.

Guards run as [PreToolUse hooks](https://docs.anthropic.com/en/docs/claude-code/hooks) — they intercept every Bash command and Edit/Write operation, blocking dangerous actions **before** execution. Blocked actions return `permissionDecision: "deny"` with a reason, so Claude can auto-recover instead of stopping.

## Install

```bash
npm install claude-code-guards
npx claude-code-guards init
```

This will:
1. Copy `guard.cjs` and `guard-edit.cjs` into `.claude/hooks/`
2. Merge hook config into `.claude/settings.local.json`
3. Copy test file into `tests/guards/`
4. Create `.claude/guards.config.json` (example config)

## Update

```bash
npx claude-code-guards update
```

Overwrites hook files but preserves your `guards.config.json`.

## What it blocks

### Bash guard (`guard.cjs`)

| Rule | What it blocks | Configurable |
|------|---------------|-------------|
| Worktree workflow | `checkout -b` / `switch -c` for feat/fix branches | `blockCheckoutBranch` |
| Master protection | Direct commits, npm install, cp to src/ on master | always on |
| Hook bypass | `--no-verify` on commit/push | always on |
| Force push | `--force`, `--force-with-lease`, `+refspec` | always on |
| Guard self-protection | Mutation of guard.cjs, deploy.sh, .husky/, .claude/ | `guardFiles` |
| Shell delegation | `bash -c`, `eval`, `sh -c` | `blockShellDelegation` |
| /tmp/ script execution | `bash /tmp/x.sh`, `node /tmp/x.js`, etc. | always on |
| Inline interpreter | `node -e`, `python3 -c`, `perl -e` (warn) | always on |
| Hooks path | `git config core.hooksPath` | always on |
| History rewrite | `rebase` on master, `update-ref`, `filter-branch` | always on |
| Hard reset | `git reset --hard` on master | always on |
| Data protection | `rm` on configured files | `protectedFiles` |
| Immutable paths | `rm` / `git rm` / `git mv` on configured dirs | `immutablePaths` |
| Deploy without push | Deploy when local is ahead of remote | `deployCommand` |
| Merge gates | Version bump, spec/plan, docs sync checks | `requireVersionBump`, `requireSpecPlan`, `requireDocsSync` |
| Direct deploy bypass | scp/rsync/ssh restart to configured host | `sshHost` |

### Edit guard (`guard-edit.cjs`)

| Rule | What it blocks | Configurable |
|------|---------------|-------------|
| Source on master | src/, tests/, package.json on master | `editBlockPaths` |
| Guard files on master | guard.cjs, guard-edit.cjs, deploy.sh | `editGuardFiles` |
| .husky/ on master | Pre-commit hook files | always on |
| .gitignore on master | Could hide guard files from git | always on |
| /tmp/ script writes | Warn on Write to /tmp/*.{sh,js,py,ts,rb,pl} | always on |
| settings.local.json | Warn only (hooks live here) | always on |

**Always allowed:** docs/, .claude/, scripts/, CLAUDE.md, CHANGELOG.md, BACKLOG.md, worktree paths.

### Key design decisions

- **`deny`, not `stop`**: hooks return `permissionDecision: "deny"` with a reason. Claude sees the reason and auto-recovers (e.g., switches to worktree). `continue: false` would kill the session.
- **String stripping**: heredocs and quoted strings are stripped before checking to avoid false positives from commit messages or `echo "git push --force"`.
- **Read-only whitelist**: `cat`, `grep`, `head`, `wc` etc. are allowed even on protected files.
- **Pre-strip SSH checks**: SSH/scp/rsync warnings run before stripping because they need to see inside quoted SSH arguments.

## Configure

Edit `.claude/guards.config.json` in your project:

```json
{
  "protectedFiles": ["database.sqlite", "users.json"],
  "immutablePaths": ["docs/specs", "docs/plans"],
  "sshHost": "my-server",
  "deployCommand": "bash deploy",
  "requireVersionBump": true,
  "requireSpecPlan": true,
  "requireDocsSync": true
}
```

### All config options

| Option | Default | Description |
|--------|---------|-------------|
| `protectedFiles` | `[]` | Files where `rm` is blocked |
| `immutablePaths` | `[]` | Paths where rm/git rm/git mv is blocked |
| `guardFiles` | *(guards+husky+claude)* | Regex: files where mutation is blocked on master |
| `sshHost` | `null` | SSH host for deploy bypass warnings |
| `deployCommand` | `"bash deploy"` | Deploy command pattern (checks push-before-deploy) |
| `requireVersionBump` | `true` | Require CHANGELOG entry matching package.json version on merge |
| `requireSpecPlan` | `true` | Require spec + plan + reviews for feat/ branches on merge |
| `requireDocsSync` | `true` | Require CLAUDE.md update when core files change on merge |
| `docsSyncCorePaths` | *(engine/transport/types/config)* | Regex: core files that trigger docs-sync check |
| `worktreePath` | `".worktrees/"` | Worktree directory (always allowed) |
| `blockShellDelegation` | `true` | Block bash -c, eval, sh -c |
| `blockCheckoutBranch` | `true` | Block checkout -b (force worktree workflow) |
| `editGuardFiles` | `["guard.cjs", "guard-edit.cjs", "deploy.sh"]` | Files protected from editing on master |
| `editAllowPaths` | *(docs/claude/scripts/CLAUDE.md/CHANGELOG.md)* | Regex array: paths always allowed for editing |
| `editBlockPaths` | *(src/tests/package.json)* | Regex array: paths blocked for editing on master |

All options are optional. Guards work with defaults if no config file exists.

## Test

```bash
npx vitest run tests/guards/guard.test.ts
```

150+ tests covering:
- All guard rules (blocked and allowed)
- Bypass vectors (redirect, truncate, chmod, ln, dd, python)
- Chain splitting (&&, ||, ;, \n)
- String literal false positives (heredoc, quotes)
- Pipeline workflow sequences
- Config-dependent features (protectedFiles, sshHost, immutablePaths)
- Edge cases (malformed input, Windows paths)

## API

```js
const { loadConfig, DEFAULT_CONFIG } = require('claude-code-guards');

const config = loadConfig(process.cwd());
```

## Environment variables

| Variable | Description |
|----------|-------------|
| `GUARDS_CONFIG_PATH` | Override config file path (useful for testing) |

## License

MIT
