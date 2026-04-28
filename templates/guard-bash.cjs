#!/usr/bin/env node
// Process guardrails — blocks dangerous commands via Claude Code PreToolUse hook.
// Configurable via .claude/guards.config.json. Works with defaults if no config exists.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  protectedFiles: [],
  immutablePaths: [],
  guardFiles: 'guard\\.cjs|guard-edit\\.cjs|deploy\\.sh|settings\\.json|settings\\.local\\.json|\\.husky(\\/|$)|\\.claude(\\/|$)',
  sshHost: null,
  deployCommand: 'bash deploy',
  requireVersionBump: true,
  requireSpecPlan: true,
  requireDocsSync: true,
  docsSyncCorePaths: 'src/(engine|server|shared)/(engine|transport|types|config)\\.ts',
  worktreePath: '.worktrees/',
  blockShellDelegation: true,
  blockCheckoutBranch: true,
};

function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function loadConfig() {
  const p = process.env.GUARDS_CONFIG_PATH ||
    path.join(process.cwd(), '.claude', 'guards.config.json');
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(p, 'utf8')) }; }
  catch { return { ...DEFAULTS }; }
}

const cfg = loadConfig();

const GUARD_FILES_RE = new RegExp(cfg.guardFiles);
const READ_ONLY_RE = /^\s*(cat|head|tail|grep|wc|ls|file|stat|diff|less|more|node -e)\b/;
const DEPLOY_RUN_RE = cfg.deployCommand
  ? new RegExp(`^\\s*${esc(cfg.deployCommand)}`)
  : null;
const PROTECTED_RE = cfg.protectedFiles.length
  ? new RegExp(cfg.protectedFiles.map(esc).join('|'))
  : null;
const IMMUTABLE_RE = cfg.immutablePaths.length
  ? new RegExp(cfg.immutablePaths.map(esc).join('|'))
  : null;
const DOCS_SYNC_RE = cfg.docsSyncCorePaths
  ? new RegExp(cfg.docsSyncCorePaths)
  : null;

function inWT(s) { return s.includes(cfg.worktreePath); }

let data = '';
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(data);
    const cmd = input.tool_input?.command || '';
    console.log(JSON.stringify(check(cmd)));
  } catch {
    console.log('{}');
  }
});

function block(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

function warn(msg) {
  return { systemMessage: `\u26a0\ufe0f ${msg}` };
}

function ok() {
  return {};
}

function getBranch(rawCmd) {
  try {
    const opts = { encoding: 'utf8', timeout: 3000 };
    const cdMatch = rawCmd && rawCmd.match(/cd\s+"([^"]+)"/);
    const gitCMatch = rawCmd && rawCmd.match(/git\s+-C\s+(\S+)/);
    if (cdMatch) opts.cwd = cdMatch[1];
    else if (gitCMatch) opts.cwd = gitCMatch[1];
    return execSync('git branch --show-current', opts).trim();
  } catch {
    return '';
  }
}

function isAhead() {
  try {
    return execSync('git status -sb', { encoding: 'utf8', timeout: 3000 }).includes('[ahead');
  } catch {
    return false;
  }
}

function check(rawCmd) {
  // 0. Pre-strip: SSH/scp/rsync warnings (need to see inside quoted strings)
  if (cfg.sshHost) {
    const h = esc(cfg.sshHost);
    if (new RegExp(`\\b(scp|rsync)\\b.*${h}`).test(rawCmd) && /\/(dist|src)\//.test(rawCmd)) {
      return warn(`Direct scp/rsync to ${cfg.sshHost} bypasses deploy gates. Use ${cfg.deployCommand || 'deploy script'}.`);
    }
    if (new RegExp(`ssh\\b.*${h}.*systemctl restart`).test(rawCmd) &&
        !(cfg.deployCommand && new RegExp(esc(cfg.deployCommand)).test(rawCmd))) {
      return warn(`Direct restart via ssh bypasses deploy gates. Use ${cfg.deployCommand || 'deploy script'}.`);
    }
  }

  // Strip string literals and heredocs to avoid false positives
  const cmd = rawCmd
    .replace(/\$\(cat <<'EOF'[\s\S]*?EOF\s*\)/g, '""')
    .replace(/<<'?EOF'?[\s\S]*?EOF/g, '""')
    .replace(/"[^"]*"/g, '""')
    .replace(/'[^']*'/g, "''");

  // 1. Block: checkout -b / switch -c for feat/fix (use worktree)
  if (cfg.blockCheckoutBranch && /git (checkout -[bB]|switch -c) (feat|fix)\//.test(cmd)) {
    return block(
      `Branch creation via checkout -b / switch -c is blocked. Use worktree: git branch <name> && git worktree add ${cfg.worktreePath}<name> <name>`
    );
  }

  // 1b. Block: npm install / cp to src/ on master
  if (/\b(npm install|npm ci|npm update)\b/.test(cmd) && !inWT(rawCmd)) {
    const branch = getBranch(rawCmd);
    if (branch === 'master' || branch === 'main') {
      return block(
        `npm install on master is blocked. Work in a worktree: cd ${cfg.worktreePath}<name> && npm install`
      );
    }
  }
  if (/\bcp\b/.test(cmd) && /\bsrc\//.test(cmd) && !inWT(rawCmd)) {
    const branch = getBranch(rawCmd);
    if (branch === 'master' || branch === 'main') {
      return block('Copying files to src/ on master is blocked. Work in a worktree.');
    }
  }

  // 2. Block: direct commit on master (allow merge commits)
  if (/git commit\b/.test(cmd) && !/git commit.*-m.*merge/i.test(cmd)) {
    const branch = getBranch(cmd);
    if (branch === 'master' || branch === 'main') {
      if (!/git merge/.test(cmd)) {
        return block('Direct commit on master is blocked. Work in a branch via worktree.');
      }
    }
  }

  // 3. Block: --no-verify
  if (/git commit\b.*--no-verify/.test(cmd) || /git push\b.*--no-verify/.test(cmd)) {
    return block('--no-verify is blocked. Fix the issue, don\'t bypass hooks.');
  }

  // 4. Block: force push
  for (const sub of cmd.split(/\s*(?:&&|\|\||;|\n)\s*/)) {
    if (/git\b.*\bpush\b/.test(sub) && (/--force/.test(sub) || /\s-f\b/.test(sub))) {
      if (/master|main/.test(sub) || !/origin\s+\S+/.test(sub) || /--force-with-lease/.test(sub)) {
        return block('Force push is blocked. This can destroy history.');
      }
    }
    if (/git\b.*\bpush\b/.test(sub) && /\+\S+:\S+/.test(sub)) {
      return block('Force push via refspec (+ref:ref) is blocked.');
    }
  }

  // 4b. Block: mutation of guard files / deploy.sh / .husky/
  if (GUARD_FILES_RE.test(rawCmd) && !inWT(rawCmd)) {
    for (const sub of rawCmd.split(/\s*(?:&&|\|\||;|\n)\s*/)) {
      const hasRedirect = /[^|]>[^>]/.test(sub) || /\btee\b/.test(sub);
      if (GUARD_FILES_RE.test(sub) && !(DEPLOY_RUN_RE && DEPLOY_RUN_RE.test(sub.trim())) && (!READ_ONLY_RE.test(sub.trim()) || hasRedirect)) {
        return block('Mutation of guard files / deploy.sh / .husky/ is blocked. Work in a worktree.');
      }
    }
  }

  // 4b2. Block: shell delegation
  if (cfg.blockShellDelegation && /\b(bash -c|sh -c|eval)\b/.test(cmd)) {
    return block('Shell delegation (bash -c / eval) is blocked \u2014 use direct commands.');
  }

  // 4b3. Block: script execution from /tmp/ (Write to /tmp then execute bypass)
  if (/\b(bash|sh|node|python3?|perl|ruby)\s+\/tmp\//.test(rawCmd)) {
    return block('Executing scripts from /tmp/ is blocked \u2014 possible guard bypass.');
  }

  // 4b4. Warn: interpreter -e/-c inline code (could construct dangerous commands dynamically)
  if (/\b(node\s+-e|python3?\s+-c|perl\s+-e|ruby\s+-e)\b/.test(rawCmd)) {
    return warn('Inline interpreter (-e/-c) \u2014 make sure you are not constructing dangerous commands dynamically.');
  }

  // 4c. Block: git config core.hooksPath
  if (/git config\b.*core\.hooksPath/.test(cmd)) {
    return block('Changing core.hooksPath is blocked \u2014 this would disable pre-commit hooks.');
  }

  // 4d. Block: git rebase on master
  if (/git rebase\b/.test(cmd)) {
    const branch = getBranch(cmd);
    if (branch === 'master' || branch === 'main') {
      return block('git rebase on master is blocked. This rewrites history.');
    }
  }

  // 4e. Block: destructive git operations
  if (/git (update-ref|filter-branch)\b/.test(cmd)) {
    return block('git update-ref / filter-branch is blocked \u2014 destroys history.');
  }

  // 5. Block: rm on protected data files
  if (PROTECTED_RE && /\brm\b/.test(cmd) && PROTECTED_RE.test(cmd)) {
    return block(
      `Deletion of protected files (${cfg.protectedFiles.join(', ')}) is blocked.`
    );
  }

  // 5a. Block: rm / git rm on immutable paths
  if (IMMUTABLE_RE && (/\brm\b/.test(cmd) || /git rm/.test(cmd)) && IMMUTABLE_RE.test(cmd)) {
    return block(
      `Deletion in immutable paths (${cfg.immutablePaths.join(', ')}) is blocked.`
    );
  }

  // 5b. Block: git mv on immutable paths
  if (IMMUTABLE_RE && /git mv/.test(cmd) && IMMUTABLE_RE.test(cmd)) {
    return block(
      `Moving files in immutable paths (${cfg.immutablePaths.join(', ')}) is blocked.`
    );
  }

  // 6. Block: deploy without push
  if (cfg.deployCommand && new RegExp(esc(cfg.deployCommand)).test(cmd)) {
    if (isAhead()) {
      return block('Deploy without push is blocked. Run git push first, then deploy.');
    }
  }

  // 8. Block: git merge --no-ff \u2014 pipeline gates
  if (/git merge\b.*--no-ff/.test(cmd)) {
    // 8a. Version bump check
    if (cfg.requireVersionBump) {
      try {
        const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
        const changelog = fs.readFileSync('CHANGELOG.md', 'utf8');
        if (!changelog.includes(`## v${pkg.version}`)) {
          return block(
            `Merge without version bump. package.json = v${pkg.version}, but CHANGELOG has no ## v${pkg.version}. Bump version + update CHANGELOG first.`
          );
        }
      } catch {}
    }

    // 8b. Spec/plan review check
    if (cfg.requireSpecPlan) {
      try {
        const branchMatch = cmd.match(/git merge\s+(\S+)/);
        if (branchMatch && /^feat\//.test(branchMatch[1])) {
          const branch = branchMatch[1];
          const commits = execSync(`git log --oneline ${branch} ^HEAD 2>/dev/null`, {
            encoding: 'utf8', timeout: 5000,
          });
          if (commits.match(/\bspec\b/i) && !commits.match(/spec.*review|review.*spec|fix.*spec/i)) {
            return block('Merge of feat/ branch without spec-review is blocked. Need a commit with "spec review" or "fix spec".');
          }
          if (commits.match(/\bplan\b/i) && !commits.match(/plan.*review|review.*plan|fix.*plan/i)) {
            return block('Merge of feat/ branch without plan-review is blocked. Need a commit with "plan review" or "fix plan".');
          }
        }
      } catch {}
    }

    // 8c. Spec + plan existence check
    if (cfg.requireSpecPlan) {
      try {
        const branchMatch = cmd.match(/git merge\s+(\S+)/);
        if (branchMatch && /^feat\//.test(branchMatch[1])) {
          const branch = branchMatch[1];
          const files = execSync(`git diff --name-only HEAD...${branch} 2>/dev/null`, {
            encoding: 'utf8', timeout: 5000,
          });
          if (!/docs\/superpowers\/specs\/.*\.md/.test(files)) {
            return block('Merge of feat/ branch without spec is blocked. No file in docs/superpowers/specs/.');
          }
          if (!/docs\/superpowers\/plans\/.*\.md/.test(files)) {
            return block('Merge of feat/ branch without plan is blocked. No file in docs/superpowers/plans/.');
          }
        }
      } catch {}
    }

    // 8d. Docs sync check
    if (cfg.requireDocsSync && DOCS_SYNC_RE) {
      try {
        const branchMatch = cmd.match(/git merge\s+(\S+)/);
        if (branchMatch) {
          const branch = branchMatch[1];
          const files = execSync(`git diff --name-only HEAD...${branch} 2>/dev/null`, {
            encoding: 'utf8', timeout: 5000,
          });
          if (DOCS_SYNC_RE.test(files) && !/CLAUDE\.md/.test(files)) {
            return block('Merge blocked: core files changed but CLAUDE.md not updated. Run docs-sync.');
          }
        }
      } catch {}
    }

    return ok();
  }

  // 7. Block: git reset --hard on master
  if (/git reset --hard/.test(cmd)) {
    const branch = getBranch(cmd);
    if (branch === 'master' || branch === 'main') {
      return block('git reset --hard on master is blocked. This destroys uncommitted changes.');
    }
  }

  return ok();
}
