#!/usr/bin/env node
// Guard for Edit/Write tools — blocks source file edits on master branch.
// Configurable via .claude/guards.config.json. Works with defaults if no config exists.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  editGuardFiles: ['guard.cjs', 'guard-edit.cjs', 'deploy.sh'],
  editAllowPaths: [
    '\\/(docs|\\.claude|scripts)\\/',
    'CLAUDE\\.md$',
    'CHANGELOG\\.md$',
    'BACKLOG\\.md$',
  ],
  editBlockPaths: ['\\/(src|tests)\\/', 'package\\.json$'],
  worktreePath: '.worktrees/',
};

function loadConfig() {
  const p = process.env.GUARDS_CONFIG_PATH ||
    path.join(process.cwd(), '.claude', 'guards.config.json');
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(p, 'utf8')) }; }
  catch { return { ...DEFAULTS }; }
}

const cfg = loadConfig();

function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

const GUARD_EDIT_RE = cfg.editGuardFiles.length
  ? new RegExp(`\\/(${cfg.editGuardFiles.map(esc).join('|')})$`)
  : null;
const HUSKY_RE = /\.husky\//;
const ALLOW_RES = cfg.editAllowPaths.map((s) => new RegExp(s));
const BLOCK_RES = cfg.editBlockPaths.map((s) => new RegExp(s));

function inWT(s) { return s.includes(cfg.worktreePath); }

let data = '';
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(data);
    const filePath = input.tool_input?.file_path || input.tool_input?.path || '';
    console.log(JSON.stringify(checkEdit(filePath)));
  } catch {
    console.log('{}');
  }
});

function checkEdit(filePath) {
  if (!filePath) return {};

  const p = filePath.replace(/\\/g, '/');

  // Warn: settings.local.json edit
  if (/settings\.local\.json$/.test(p)) {
    return {
      systemMessage:
        '\u26a0\ufe0f Editing settings.local.json \u2014 hooks live here. Make sure you don\'t remove the hooks section.',
    };
  }

  // Block: .gitignore on master
  if (/\.gitignore$/.test(p) && !inWT(p)) {
    try {
      const branch = execSync('git branch --show-current', {
        encoding: 'utf8',
        timeout: 3000,
      }).trim();
      if (branch === 'master' || branch === 'main') {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason:
              'Editing .gitignore on master is blocked. Work in a worktree.',
          },
        };
      }
    } catch {}
  }

  // Block: guard files, deploy.sh, .husky/ on master
  if ((GUARD_EDIT_RE && GUARD_EDIT_RE.test(p)) || HUSKY_RE.test(p)) {
    if (!inWT(p)) {
      try {
        const branch = execSync('git branch --show-current', {
          encoding: 'utf8',
          timeout: 3000,
        }).trim();
        if (branch === 'master' || branch === 'main') {
          const name = p.split('/').pop();
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: `Editing ${name} on master is blocked \u2014 protected file. Work in a worktree.`,
            },
          };
        }
      } catch {}
    }
  }

  // Allow: docs, .claude, scripts, CLAUDE.md, CHANGELOG.md, BACKLOG.md
  if (ALLOW_RES.some((re) => re.test(p))) return {};

  // Allow: worktree paths
  if (inWT(p)) return {};

  // Block: src/, tests/, package.json on master
  if (BLOCK_RES.some((re) => re.test(p))) {
    try {
      const branch = execSync('git branch --show-current', {
        encoding: 'utf8',
        timeout: 3000,
      }).trim();
      if (branch === 'master' || branch === 'main') {
        const name = p.split('/').pop();
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `Editing ${name} on master is blocked. Create a worktree.`,
          },
        };
      }
    } catch {}
  }

  return {};
}
