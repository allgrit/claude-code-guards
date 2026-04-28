// claude-code-guards — shared config loader
// Reads .claude/guards.config.json from the project root, merges with defaults.

const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = {
  // Protected data files — rm is blocked on these
  protectedFiles: ['world.json', 'clans_permanent.json'],

  // Immutable doc paths — rm/git rm/git mv blocked
  immutablePaths: ['docs/superpowers/specs', 'docs/superpowers/plans'],

  // Guard file patterns (regex source string) — mutation blocked on master
  guardFiles: 'guard\\.cjs|guard-edit\\.cjs|deploy\\.sh|settings\\.json|settings\\.local\\.json|\\.husky(\\\\/|$)|\\.claude(\\\\/|$)',

  // Paths always allowed for editing on master (regex source strings)
  editAllowPaths: ['\\/(docs|\\.claude|scripts)\\/', 'CLAUDE\\.md$', 'CHANGELOG\\.md$', 'BACKLOG\\.md$'],

  // Paths blocked for editing on master (regex source strings)
  editBlockPaths: ['\\/(src|tests)\\/', 'package\\.json$'],

  // SSH host used for deploy — scp/rsync/restart warnings (null = disabled)
  sshHost: null,

  // Deploy command pattern
  deployCommand: 'bash deploy',

  // Require version bump + CHANGELOG on merge --no-ff
  requireVersionBump: true,

  // Require spec + plan + reviews for feat/ branches
  requireSpecPlan: true,

  // Require docs sync (CLAUDE.md) when core files change
  requireDocsSync: true,
  docsSyncCorePaths: 'src\\/(engine|server|shared)\\/(engine|transport|types|config)\\.ts',

  // Worktree path segment (edits/commands here are always allowed)
  worktreePath: '.worktrees/',

  // Block shell delegation (bash -c, eval, sh -c)
  blockShellDelegation: true,

  // Block checkout -b / switch -c (force worktree workflow)
  blockCheckoutBranch: true,
};

function loadConfig(cwd) {
  const configPath = path.join(cwd || process.cwd(), '.claude', 'guards.config.json');
  let userConfig = {};
  try {
    userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    // No config file — use defaults
  }

  // Merge: user values override defaults
  const merged = { ...DEFAULT_CONFIG, ...userConfig };

  // Convert string regex fields to RegExp objects for runtime use
  merged._guardFilesRe = new RegExp(merged.guardFiles);
  merged._editAllowRe = (merged.editAllowPaths || []).map((s) => new RegExp(s));
  merged._editBlockRe = (merged.editBlockPaths || []).map((s) => new RegExp(s));
  merged._docsSyncRe = merged.docsSyncCorePaths ? new RegExp(merged.docsSyncCorePaths) : null;
  merged._protectedFilesRe = new RegExp(
    merged.protectedFiles.map((f) => f.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')).join('|')
  );
  merged._immutablePathsRe = merged.immutablePaths.length
    ? new RegExp(merged.immutablePaths.map((p) => p.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')).join('|'))
    : null;

  return merged;
}

module.exports = { loadConfig, DEFAULT_CONFIG };
