#!/usr/bin/env node
// Guard for Edit/Write tools — block source file edits on master branch.
// Only blocks edits to src/, tests/, package.json (not docs/, .claude/, CLAUDE.md, CHANGELOG.md).

const { execSync } = require('child_process');

let data = '';
process.stdin.on('data', (chunk) => (data += chunk));
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(data);
    const filePath = input.tool_input?.file_path || input.tool_input?.path || '';
    const result = checkEdit(filePath);
    console.log(JSON.stringify(result));
  } catch {
    console.log('{}');
  }
});

function checkEdit(filePath) {
  if (!filePath) return {};

  const normalized = filePath.replace(/\\/g, '/');

  // Warn: settings.local.json edit (could disable hooks entirely)
  if (/settings\.local\.json$/.test(normalized)) {
    return { systemMessage: '⚠️ Редактирование settings.local.json — здесь живут hooks. Убедись что не удаляешь секцию hooks.' };
  }

  // Block: .gitignore on master (could hide guard files from git)
  if (/\.gitignore$/.test(normalized) && !/\.worktrees\//.test(normalized)) {
    try {
      const branch = execSync('git branch --show-current', { encoding: 'utf8', timeout: 3000 }).trim();
      if (branch === 'master' || branch === 'main') {
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Редактирование .gitignore на master запрещено. Работай в worktree.' } };
      }
    } catch {}
  }

  // Block: guard files, deploy.sh, husky hooks on master (even inside .claude/)
  if (/\/(guard\.cjs|guard-edit\.cjs|deploy\.sh)$/.test(normalized) || /\.husky\//.test(normalized)) {
    if (!/\.worktrees\//.test(normalized)) {
      try {
        const branch = execSync('git branch --show-current', { encoding: 'utf8', timeout: 3000 }).trim();
        if (branch === 'master' || branch === 'main') {
          return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Редактирование ${normalized.split('/').pop()} на master запрещено — это защитный файл. Работай в worktree.` } };
        }
      } catch {}
    }
  }

  // Allow: docs, .claude (except guard files above), CLAUDE.md, CHANGELOG.md, BACKLOG.md, scripts/
  if (/\/(docs|\.claude|scripts)\//.test(normalized)) return {};
  if (/CLAUDE\.md$|CHANGELOG\.md$|BACKLOG\.md$/.test(normalized)) return {};

  // Allow: edits inside worktrees
  if (/\.worktrees\//.test(normalized)) return {};

  // Block: src/, tests/, package.json on master
  if (/\/(src|tests)\//.test(normalized) || /package\.json$/.test(normalized)) {
    try {
      const branch = execSync('git branch --show-current', { encoding: 'utf8', timeout: 3000 }).trim();
      if (branch === 'master' || branch === 'main') {
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Редактирование ${normalized.split('/').pop()} на master запрещено. Создай worktree.` } };
      }
    } catch {}
  }

  return {};
}
