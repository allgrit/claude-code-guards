#!/usr/bin/env node
// Process guardrails — blocks dangerous commands via Claude Code PreToolUse hook.
// Reads JSON from stdin, outputs JSON with {continue:false, stopReason} to block.

const { execSync } = require('child_process');

let data = '';
process.stdin.on('data', (chunk) => (data += chunk));
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(data);
    const cmd = input.tool_input?.command || '';
    const result = check(cmd);
    console.log(JSON.stringify(result));
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

function getCurrentBranch(cmd) {
  try {
    const cdMatch = cmd && cmd.match(/cd\s+"([^"]+)"/);
    const opts = { encoding: 'utf8', timeout: 3000 };
    if (cdMatch) opts.cwd = cdMatch[1];
    return execSync('git branch --show-current', opts).trim();
  } catch {
    return '';
  }
}

function isLocalAheadOfRemote() {
  try {
    const status = execSync('git status -sb', { encoding: 'utf8', timeout: 3000 });
    return status.includes('[ahead');
  } catch {
    return false;
  }
}

function backlogHasStatus(marker) {
  try {
    const fs = require('fs');
    const content = fs.readFileSync('docs/BACKLOG.md', 'utf8');
    const inProgress = content.split('## In Progress')[1]?.split('## ')[0] || '';
    return inProgress.includes(marker);
  } catch {
    return true;
  }
}

function check(rawCmd) {
  // 0. Pre-strip checks: rules that need to see inside quoted strings (ssh args)
  if (/\b(scp|rsync)\b.*tribe-vps/.test(rawCmd) && /\/(dist|src)\//.test(rawCmd)) {
    return warn('Прямой scp/rsync на сервер обходит deploy.sh gates. Используй bash deploy.sh.');
  }
  if (/ssh\b.*tribe-vps.*systemctl restart/.test(rawCmd) && !/bash deploy/.test(rawCmd)) {
    return warn('Прямой restart через ssh обходит deploy.sh gates (тесты, sim-bench, smoke check).');
  }

  // Strip string literals AND heredoc content to avoid false positives
  // from commit messages, node -e "...", echo "..." containing guard keywords
  const cmd = rawCmd
    .replace(/\$\(cat <<'EOF'[\s\S]*?EOF\s*\)/g, '""')  // heredoc $(cat <<'EOF'...EOF)
    .replace(/<<'?EOF'?[\s\S]*?EOF/g, '""')               // plain heredoc
    .replace(/"[^"]*"/g, '""')                             // double-quoted strings
    .replace(/'[^']*'/g, "''");                            // single-quoted strings

  // 1. Block: git checkout -b/-B / git switch -c for feat/fix (use worktree instead)
  if (/git (checkout -[bB]|switch -c) (feat|fix)\//.test(cmd)) {
    return block(
      'Создание ветки через checkout -b / switch -c запрещено. Используй worktree: git branch <name> && git worktree add .worktrees/<name> <name>'
    );
  }

  // 1b. Block: mutating commands on master (npm install, cp to src/)
  // Use rawCmd for .worktrees/ check (stripped cmd loses quoted paths)
  if (/\b(npm install|npm ci|npm update)\b/.test(cmd) && !/\.worktrees\//.test(rawCmd)) {
    const branch = getCurrentBranch(rawCmd);
    if (branch === 'master' || branch === 'main') {
      return block(
        'npm install на master запрещён. Работай в worktree: cd .worktrees/<name> && npm install'
      );
    }
  }
  if (/\bcp\b/.test(cmd) && /\bsrc\//.test(cmd) && !/\.worktrees\//.test(cmd)) {
    const branch = getCurrentBranch(cmd);
    if (branch === 'master' || branch === 'main') {
      return block(
        'Копирование файлов в src/ на master запрещено. Работай в worktree.'
      );
    }
  }

  // 2. Block: direct commit on master (allow merge commits)
  if (/git commit\b/.test(cmd) && !/git commit.*-m.*merge/i.test(cmd)) {
    const branch = getCurrentBranch(cmd);
    if (branch === 'master' || branch === 'main') {
      // Allow merge --no-ff (which runs on master after switching)
      if (!/git merge/.test(cmd)) {
        return block(
          '\u041a\u043e\u043c\u043c\u0438\u0442 \u043d\u0430\u043f\u0440\u044f\u043c\u0443\u044e \u0432 master \u0437\u0430\u043f\u0440\u0435\u0449\u0451\u043d. \u0420\u0430\u0431\u043e\u0442\u0430\u0439 \u0432 \u0432\u0435\u0442\u043a\u0435 \u0447\u0435\u0440\u0435\u0437 worktree.'
        );
      }
    }
  }

  // 3. Block: --no-verify on commits
  if (/git commit\b.*--no-verify/.test(cmd) || /git push\b.*--no-verify/.test(cmd)) {
    return block('--no-verify \u0437\u0430\u043f\u0440\u0435\u0449\u0451\u043d. \u0418\u0441\u043f\u0440\u0430\u0432\u044c \u043f\u0440\u043e\u0431\u043b\u0435\u043c\u0443, \u043d\u0435 \u043e\u0431\u0445\u043e\u0434\u0438 hooks.');
  }

  // 4. Block: git push --force/--force-with-lease/+refspec to master
  for (const sub of cmd.split(/\s*(?:&&|\|\||;|\n)\s*/)) {
    // Standard --force / -f / --force-with-lease
    if (/git\b.*\bpush\b/.test(sub) && (/--force/.test(sub) || /\s-f\b/.test(sub))) {
      if (/master|main/.test(sub) || !/origin\s+\S+/.test(sub) || /--force-with-lease/.test(sub)) {
        return block('Force push в master запрещён. Это может уничтожить историю.');
      }
    }
    // Refspec force push: git push origin +HEAD:master
    if (/git\b.*\bpush\b/.test(sub) && /\+\S+:\S+/.test(sub)) {
      return block('Force push через refspec (+ref:ref) запрещён.');
    }
  }

  // 4b. Block: ANY mutation of guard files / deploy.sh / .husky/ (not just mv/cp)
  // Protected files: guard.cjs, guard-edit.cjs, deploy.sh, .husky/*
  // Read-only commands are allowed: cat, head, tail, grep, wc, ls, file, stat, diff, less, more
  const GUARD_FILES = /(guard\.cjs|guard-edit\.cjs|deploy\.sh|settings\.json|settings\.local\.json|\.husky(\/|$)|\.claude(\/|$))/;
  const READ_ONLY_CMDS = /^\s*(cat|head|tail|grep|wc|ls|file|stat|diff|less|more|node -e.*spawnSync)\b/;
  if (GUARD_FILES.test(rawCmd) && !/\.worktrees\//.test(rawCmd)) {
    // Check each subcommand
    for (const sub of rawCmd.split(/\s*(?:&&|\|\||;|\n)\s*/)) {
      const hasRedirect = /[^|]>[^>]/.test(sub) || /\btee\b/.test(sub);
      if (GUARD_FILES.test(sub) && (!READ_ONLY_CMDS.test(sub.trim()) || hasRedirect)) {
        // Not a read-only operation on a guard file
        return block('Мутация guard файлов / deploy.sh / .husky/ запрещена. Работай в worktree.');
      }
    }
  }

  // 4b2. Block: shell delegation (bash -c, eval, sh -c) — could hide dangerous commands
  if (/\b(bash -c|sh -c|eval)\b/.test(cmd)) {
    return block('Shell delegation (bash -c / eval) запрещена — используй прямые команды.');
  }

  // 4c. Block: git config core.hooksPath (disables pre-commit)
  if (/git config\b.*core\.hooksPath/.test(cmd)) {
    return block('Изменение core.hooksPath запрещено — это отключит pre-commit hooks.');
  }

  // 4d. Block: git rebase on master (history rewrite)
  if (/git rebase\b/.test(cmd)) {
    const branch = getCurrentBranch(cmd);
    if (branch === 'master' || branch === 'main') {
      return block('git rebase на master запрещён. Это перезапишет историю.');
    }
  }

  // 4e. Block: destructive git operations (update-ref, filter-branch) — dangerous on any branch
  if (/git (update-ref|filter-branch)\b/.test(cmd)) {
    return block('git update-ref / filter-branch запрещён — разрушает историю.');
  }

  // 4f. ssh/scp/rsync warn moved to pre-strip section (rule 0) — needs to see inside quotes

  // 5. Block: rm on world.json or clans_permanent.json
  if (/\brm\b/.test(cmd) && /(world\.json|clans_permanent\.json)/.test(cmd)) {
    return block(
      'Удаление world.json / clans_permanent.json запрещено. Кланы — данные игроков.'
    );
  }

  // 5a. Block: rm/git rm on specs and plans (immutable audit trail)
  if ((/\brm\b/.test(cmd) || /git rm/.test(cmd)) && /docs\/superpowers\/(specs|plans)/.test(cmd)) {
    return block(
      'Удаление specs/plans запрещено. Это иммутабельный audit trail — статус вычисляется из их наличия.'
    );
  }

  // 5b. Block: git mv on specs and plans
  if (/git mv/.test(cmd) && /docs\/superpowers\/(specs|plans)/.test(cmd)) {
    return block(
      'Перемещение specs/plans запрещено. Файлы должны оставаться на месте для backlog-status.sh.'
    );
  }

  // 6. Block: deploy without push (local ahead of remote)
  if (/bash deploy/.test(cmd)) {
    if (isLocalAheadOfRemote()) {
      return block(
        'Deploy \u0431\u0435\u0437 push \u0437\u0430\u043f\u0440\u0435\u0449\u0451\u043d. \u0421\u043d\u0430\u0447\u0430\u043b\u0430 git push, \u043f\u043e\u0442\u043e\u043c deploy.'
      );
    }
    // BACKLOG check removed — status is now derived via backlog-status.sh
  }

  // 8. Block: git merge --no-ff — pipeline gates
  if (/git merge\b.*--no-ff/.test(cmd)) {
    const fs = require('fs');

    // 8a. Version bump check
    try {
      const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
      const changelog = fs.readFileSync('CHANGELOG.md', 'utf8');
      if (!changelog.includes(`## v${pkg.version}`)) {
        return block(
          `Merge без version bump. package.json = v${pkg.version}, но CHANGELOG не содержит ## v${pkg.version}. Сначала bump version + CHANGELOG.`
        );
      }
    } catch {}

    // 8b. Spec review check — feat/ branch with spec must have review commit
    try {
      const branchMatch = cmd.match(/git merge\s+(\S+)/);
      if (branchMatch && /^feat\//.test(branchMatch[1])) {
        const branch = branchMatch[1];
        const commits = execSync(`git log --oneline ${branch} ^HEAD 2>/dev/null`, { encoding: 'utf8', timeout: 5000 });
        const hasSpec = commits.match(/\bspec\b/i);
        const hasSpecReview = commits.match(/spec.*review|review.*spec|fix.*spec/i);
        if (hasSpec && !hasSpecReview) {
          return block('Merge feat/ ветки без spec-review запрещён. Нужен коммит с "spec review" или "fix spec" в сообщении.');
        }
        const hasPlan = commits.match(/\bplan\b/i);
        const hasPlanReview = commits.match(/plan.*review|review.*plan|fix.*plan/i);
        if (hasPlan && !hasPlanReview) {
          return block('Merge feat/ ветки без plan-review запрещён. Нужен коммит с "plan review" или "fix plan" в сообщении.');
        }
      }
    } catch {}

    // 8c. Spec+plan existence check — feat/ branches must have both
    try {
      const branchMatch = cmd.match(/git merge\s+(\S+)/);
      if (branchMatch && /^feat\//.test(branchMatch[1])) {
        const branch = branchMatch[1];
        const files = execSync(`git diff --name-only HEAD...${branch} 2>/dev/null`, { encoding: 'utf8', timeout: 5000 });
        const hasSpec = /docs\/superpowers\/specs\/.*\.md/.test(files);
        const hasPlan = /docs\/superpowers\/plans\/.*\.md/.test(files);
        if (!hasSpec) {
          return block(`Merge feat/ ветки без spec запрещён. Нет файла в docs/superpowers/specs/. Создай spec через /feature pipeline.`);
        }
        if (!hasPlan) {
          return block(`Merge feat/ ветки без plan запрещён. Нет файла в docs/superpowers/plans/. Создай plan через /feature pipeline.`);
        }
      }
    } catch {}

    // 8d. Docs sync check — if engine/transport/types/config changed, CLAUDE.md should too
    try {
      const branchMatch = cmd.match(/git merge\s+(\S+)/);
      if (branchMatch) {
        const branch = branchMatch[1];
        const files = execSync(`git diff --name-only HEAD...${branch} 2>/dev/null`, { encoding: 'utf8', timeout: 5000 });
        const coreChanged = /src\/(engine|server|shared)\/(engine|transport|types|config)\.ts/.test(files);
        const docsChanged = /CLAUDE\.md/.test(files);
        if (coreChanged && !docsChanged) {
          return block('Merge заблокирован: изменены core файлы (engine/transport/types/config) но CLAUDE.md не обновлён. Запусти docs-sync.');
        }
      }
    } catch {}

    return ok();
  }

  // 7. Block: git reset --hard on master
  if (/git reset --hard/.test(cmd)) {
    const branch = getCurrentBranch(cmd);
    if (branch === 'master' || branch === 'main') {
      return block('git reset --hard \u043d\u0430 master \u0437\u0430\u043f\u0440\u0435\u0449\u0451\u043d. \u042d\u0442\u043e \u0443\u043d\u0438\u0447\u0442\u043e\u0436\u0438\u0442 \u043d\u0435\u0437\u0430\u043a\u043e\u043c\u043c\u0438\u0447\u0435\u043d\u043d\u044b\u0435 \u0438\u0437\u043c\u0435\u043d\u0435\u043d\u0438\u044f.');
    }
  }

  return ok();
}
