// claude-code-guards — shared config loader
// Reads .claude/guards.config.json from the project root, merges with defaults.

const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = {
  protectedFiles: [],
  immutablePaths: [],
  guardFiles:
    'guard\\.cjs|guard-edit\\.cjs|deploy\\.sh|settings\\.json|settings\\.local\\.json|\\.husky(\\/|$)|\\.claude(\\/|$)',
  editGuardFiles: ['guard.cjs', 'guard-edit.cjs', 'deploy.sh'],
  editAllowPaths: [
    '\\/(docs|\\.claude|scripts)\\/',
    'CLAUDE\\.md$',
    'CHANGELOG\\.md$',
    'BACKLOG\\.md$',
  ],
  editBlockPaths: ['\\/(src|tests)\\/', 'package\\.json$'],
  sshHost: null,
  deployCommand: 'bash deploy',
  requireVersionBump: true,
  requireSpecPlan: true,
  requireDocsSync: true,
  docsSyncCorePaths:
    'src/(engine|server|shared)/(engine|transport|types|config)\\.ts',
  worktreePath: '.worktrees/',
  blockShellDelegation: true,
  blockCheckoutBranch: true,
};

function loadConfig(cwd) {
  const configPath = path.join(
    cwd || process.cwd(),
    '.claude',
    'guards.config.json'
  );
  let userConfig = {};
  try {
    userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    // No config file — use defaults
  }
  return { ...DEFAULT_CONFIG, ...userConfig };
}

module.exports = { loadConfig, DEFAULT_CONFIG };
