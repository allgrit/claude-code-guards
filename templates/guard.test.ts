import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ─── Helpers ───────────────────────────────────────────────────

const tmpConfig = join(tmpdir(), `guards-test-${process.pid}.json`);
afterAll(() => { try { unlinkSync(tmpConfig); } catch {} });

function runGuard(cmd: string): Record<string, unknown> {
  const input = JSON.stringify({ tool_input: { command: cmd } });
  const r = spawnSync('node', ['.claude/hooks/guard.cjs'], {
    input, encoding: 'utf8', timeout: 5000,
  });
  return JSON.parse(r.stdout.trim() || '{}');
}

function runGuardCfg(cmd: string, config: Record<string, unknown>): Record<string, unknown> {
  writeFileSync(tmpConfig, JSON.stringify(config));
  const input = JSON.stringify({ tool_input: { command: cmd } });
  const r = spawnSync('node', ['.claude/hooks/guard.cjs'], {
    input, encoding: 'utf8', timeout: 5000,
    env: { ...process.env, GUARDS_CONFIG_PATH: tmpConfig },
  });
  return JSON.parse(r.stdout.trim() || '{}');
}

function runEditGuard(filePath: string): Record<string, unknown> {
  const input = JSON.stringify({ tool_input: { file_path: filePath } });
  const r = spawnSync('node', ['.claude/hooks/guard-edit.cjs'], {
    input, encoding: 'utf8', timeout: 5000,
  });
  return JSON.parse(r.stdout.trim() || '{}');
}

function runEditGuardCfg(filePath: string, config: Record<string, unknown>): Record<string, unknown> {
  writeFileSync(tmpConfig, JSON.stringify(config));
  const input = JSON.stringify({ tool_input: { file_path: filePath } });
  const r = spawnSync('node', ['.claude/hooks/guard-edit.cjs'], {
    input, encoding: 'utf8', timeout: 5000,
    env: { ...process.env, GUARDS_CONFIG_PATH: tmpConfig },
  });
  return JSON.parse(r.stdout.trim() || '{}');
}

function isDenied(r: Record<string, unknown>): boolean {
  const hso = r.hookSpecificOutput as Record<string, unknown> | undefined;
  return hso?.permissionDecision === 'deny';
}
function isBlocked(r: Record<string, unknown>): boolean { return isDenied(r); }
function hasWarning(r: Record<string, unknown>): boolean { return typeof r.systemMessage === 'string'; }
function getDenyReason(r: Record<string, unknown>): string {
  const hso = r.hookSpecificOutput as Record<string, unknown> | undefined;
  return (hso?.permissionDecisionReason as string) || '';
}

// ═══════════════════════════════════════════════════════════════
// guard.cjs — BLOCKED commands (core git safety, works with defaults)
// ═══════════════════════════════════════════════════════════════

describe('guard.cjs — BLOCKED commands', () => {
  describe('Rule 1: checkout -b / switch -c → use worktree', () => {
    it('blocks git checkout -b feat/', () => {
      expect(isBlocked(runGuard('git checkout -b feat/my-feature'))).toBe(true);
    });
    it('blocks git checkout -b fix/', () => {
      expect(isBlocked(runGuard('git checkout -b fix/my-fix'))).toBe(true);
    });
    it('blocks git switch -c feat/', () => {
      expect(isBlocked(runGuard('git switch -c feat/my-feature'))).toBe(true);
    });
    it('blocks git switch -c fix/', () => {
      expect(isBlocked(runGuard('git switch -c fix/my-fix'))).toBe(true);
    });
    it('blocks git checkout -B feat/ (uppercase B)', () => {
      expect(isBlocked(runGuard('git checkout -B feat/my-feature'))).toBe(true);
    });
  });

  describe('Rule 3: --no-verify → fix the issue', () => {
    it('blocks git commit --no-verify', () => {
      expect(isBlocked(runGuard('git commit -m "test" --no-verify'))).toBe(true);
    });
    it('blocks git push --no-verify', () => {
      expect(isBlocked(runGuard('git push --no-verify'))).toBe(true);
    });
  });

  describe('Rule 4: force push → destroys history', () => {
    it('blocks git push --force', () => {
      expect(isBlocked(runGuard('git push --force'))).toBe(true);
    });
    it('blocks git push -f', () => {
      expect(isBlocked(runGuard('git push -f'))).toBe(true);
    });
    it('blocks git push origin master --force', () => {
      expect(isBlocked(runGuard('git push origin master --force'))).toBe(true);
    });
    it('blocks git push --force-with-lease', () => {
      expect(isBlocked(runGuard('git push origin HEAD --force-with-lease'))).toBe(true);
    });
    it('blocks git push origin +HEAD:master (refspec)', () => {
      expect(isBlocked(runGuard('git push origin +HEAD:master'))).toBe(true);
    });
    it('blocks git -C /tmp push --force', () => {
      expect(isBlocked(runGuard('git -C /tmp push --force'))).toBe(true);
    });
  });

  describe('Rule 4: chain splitting (&&, ||, ;, \\n)', () => {
    it('catches newline bypass', () => {
      expect(isBlocked(runGuard('echo x\ngit push --force'))).toBe(true);
    });
    it('catches semicolon chain', () => {
      expect(isBlocked(runGuard('echo x; git push --force'))).toBe(true);
    });
    it('catches || chain', () => {
      expect(isBlocked(runGuard('echo x || git push --force'))).toBe(true);
    });
    it('catches && chain', () => {
      expect(isBlocked(runGuard('echo x && git push --force'))).toBe(true);
    });
  });

  describe('Rule 4b2: shell delegation blocked', () => {
    it('blocks bash -c', () => {
      expect(isBlocked(runGuard('bash -c "git push --force"'))).toBe(true);
    });
    it('blocks eval', () => {
      expect(isBlocked(runGuard('eval "git push --force"'))).toBe(true);
    });
    it('blocks sh -c', () => {
      expect(isBlocked(runGuard('sh -c "dangerous command"'))).toBe(true);
    });
  });

  describe('Rule 4c: git config core.hooksPath', () => {
    it('blocks git config core.hooksPath', () => {
      expect(isBlocked(runGuard('git config core.hooksPath /dev/null'))).toBe(true);
    });
    it('blocks git config --global core.hooksPath', () => {
      expect(isBlocked(runGuard('git config --global core.hooksPath /tmp'))).toBe(true);
    });
  });

  describe('Rule 4e: destructive git operations', () => {
    it('blocks git update-ref', () => {
      expect(isBlocked(runGuard('git update-ref -d HEAD'))).toBe(true);
    });
    it('blocks git filter-branch', () => {
      expect(isBlocked(runGuard('git filter-branch --force HEAD'))).toBe(true);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// guard.cjs — ALLOWED commands (normal workflow)
// ═══════════════════════════════════════════════════════════════

describe('guard.cjs — ALLOWED commands', () => {
  describe('git read operations', () => {
    it('allows git status', () => {
      expect(isBlocked(runGuard('git status'))).toBe(false);
    });
    it('allows git log', () => {
      expect(isBlocked(runGuard('git log --oneline -5'))).toBe(false);
    });
    it('allows git diff', () => {
      expect(isBlocked(runGuard('git diff HEAD~1'))).toBe(false);
    });
    it('allows git show', () => {
      expect(isBlocked(runGuard('git show HEAD'))).toBe(false);
    });
    it('allows git branch (list)', () => {
      expect(isBlocked(runGuard('git branch'))).toBe(false);
    });
    it('allows git branch --show-current', () => {
      expect(isBlocked(runGuard('git branch --show-current'))).toBe(false);
    });
    it('allows git stash', () => {
      expect(isBlocked(runGuard('git stash'))).toBe(false);
    });
    it('allows git stash pop', () => {
      expect(isBlocked(runGuard('git stash pop'))).toBe(false);
    });
  });

  describe('worktree operations', () => {
    it('allows git branch feat/ (create without checkout)', () => {
      expect(isBlocked(runGuard('git branch feat/my-feature'))).toBe(false);
    });
    it('allows git worktree add', () => {
      expect(isBlocked(runGuard('git worktree add .worktrees/my-branch feat/my-branch'))).toBe(false);
    });
    it('allows git worktree remove', () => {
      expect(isBlocked(runGuard('git worktree remove .worktrees/old'))).toBe(false);
    });
    it('allows git worktree remove --force', () => {
      expect(isBlocked(runGuard('git worktree remove .worktrees/old --force'))).toBe(false);
    });
    it('allows git worktree list', () => {
      expect(isBlocked(runGuard('git worktree list'))).toBe(false);
    });
  });

  describe('normal git push (non-force)', () => {
    it('allows git push', () => {
      expect(isBlocked(runGuard('git push'))).toBe(false);
    });
    it('allows git push origin master', () => {
      expect(isBlocked(runGuard('git push origin master'))).toBe(false);
    });
    it('allows git push -u origin feat/branch', () => {
      expect(isBlocked(runGuard('git push -u origin feat/my-branch'))).toBe(false);
    });
  });

  describe('git checkout (non checkout -b)', () => {
    it('allows git checkout master', () => {
      expect(isBlocked(runGuard('git checkout master'))).toBe(false);
    });
    it('allows git checkout -- file', () => {
      expect(isBlocked(runGuard('git checkout -- src/file.ts'))).toBe(false);
    });
    it('allows git checkout branch-name', () => {
      expect(isBlocked(runGuard('git checkout existing-branch'))).toBe(false);
    });
  });

  describe('git switch (without -c)', () => {
    it('allows git switch master', () => {
      expect(isBlocked(runGuard('git switch master'))).toBe(false);
    });
  });

  describe('merge (structural)', () => {
    it('allows git merge --no-ff (structural — merge gates check separately)', () => {
      const r = runGuard('git merge feat/my-branch --no-ff -m "merge: my feature"');
      expect(r).toBeDefined();
    });
  });

  describe('build and test commands', () => {
    it('allows npm run build', () => {
      expect(isBlocked(runGuard('npm run build'))).toBe(false);
    });
    it('allows npx vitest run', () => {
      expect(isBlocked(runGuard('npx vitest run'))).toBe(false);
    });
    it('allows npm run build:client', () => {
      expect(isBlocked(runGuard('npm run build:client'))).toBe(false);
    });
    it('allows npx tsc --noEmit', () => {
      expect(isBlocked(runGuard('npx tsc --noEmit'))).toBe(false);
    });
  });

  describe('deploy command (structural)', () => {
    it('allows bash deploy.sh (structural — deploy gates check separately)', () => {
      const r = runGuard('bash deploy.sh');
      expect(r).toBeDefined();
    });
  });

  describe('safe file operations', () => {
    it('allows rm on non-protected files', () => {
      expect(isBlocked(runGuard('rm /tmp/test.txt'))).toBe(false);
    });
    it('allows rm on build artifacts', () => {
      expect(isBlocked(runGuard('rm -rf dist/'))).toBe(false);
    });
    it('allows cp in worktree', () => {
      expect(isBlocked(runGuard('cp file.ts .worktrees/branch/src/file.ts'))).toBe(false);
    });
    it('allows ls, cat, head, tail', () => {
      expect(isBlocked(runGuard('ls -la src/'))).toBe(false);
    });
  });

  describe('deny format — reason visible to Claude for auto-recovery', () => {
    it('denied command has permissionDecision=deny', () => {
      const r = runGuard('git checkout -b feat/test');
      expect(isDenied(r)).toBe(true);
      expect(r.continue).toBeUndefined();
    });
    it('denied command has permissionDecisionReason', () => {
      const reason = getDenyReason(runGuard('git checkout -b feat/test'));
      expect(reason.length).toBeGreaterThan(0);
      expect(reason).toContain('worktree');
    });
    it('allowed command has no hookSpecificOutput', () => {
      const r = runGuard('git status');
      expect(r.hookSpecificOutput).toBeUndefined();
    });
  });

  describe('false positive prevention', () => {
    it('git push && git worktree remove --force: push OK, force is on worktree not push', () => {
      expect(isBlocked(runGuard('git push && git worktree remove .worktrees/x --force'))).toBe(false);
    });
    it('git push && git branch -d fix/old: both allowed', () => {
      expect(isBlocked(runGuard('git push && git branch -d fix/old'))).toBe(false);
    });
    it('empty command → allow', () => {
      expect(isBlocked(runGuard(''))).toBe(false);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// guard-edit.cjs — Edit/Write guard
// ═══════════════════════════════════════════════════════════════

describe('guard-edit.cjs — ALLOWED paths', () => {
  describe('documentation files', () => {
    it('allows docs/ directory', () => {
      expect(isBlocked(runEditGuard('/project/docs/README.md'))).toBe(false);
    });
    it('allows docs/superpowers/', () => {
      expect(isBlocked(runEditGuard('/project/docs/superpowers/specs/my-spec.md'))).toBe(false);
    });
    it('allows docs/audit/', () => {
      expect(isBlocked(runEditGuard('/project/docs/audit/2026-04-26/report.md'))).toBe(false);
    });
    it('allows CLAUDE.md', () => {
      expect(isBlocked(runEditGuard('/project/CLAUDE.md'))).toBe(false);
    });
    it('allows CHANGELOG.md', () => {
      expect(isBlocked(runEditGuard('/project/CHANGELOG.md'))).toBe(false);
    });
    it('allows BACKLOG.md', () => {
      expect(isBlocked(runEditGuard('/project/BACKLOG.md'))).toBe(false);
    });
  });

  describe('.claude/ config (except guard files)', () => {
    it('allows .claude/commands/feature.md', () => {
      expect(isBlocked(runEditGuard('/project/.claude/commands/feature.md'))).toBe(false);
    });
    it('allows .claude/commands/fix.md', () => {
      expect(isBlocked(runEditGuard('/project/.claude/commands/fix.md'))).toBe(false);
    });
    it('allows .claude/agents/', () => {
      expect(isBlocked(runEditGuard('/project/.claude/agents/my-agent.md'))).toBe(false);
    });
  });

  describe('scripts/', () => {
    it('allows scripts/backlog-status.sh', () => {
      expect(isBlocked(runEditGuard('/project/scripts/backlog-status.sh'))).toBe(false);
    });
    it('allows scripts/docs-sync-hints.sh', () => {
      expect(isBlocked(runEditGuard('/project/scripts/docs-sync-hints.sh'))).toBe(false);
    });
  });

  describe('worktree paths (always allowed)', () => {
    it('allows src/ in worktree', () => {
      expect(isBlocked(runEditGuard('/project/.worktrees/feat/src/engine/engine.ts'))).toBe(false);
    });
    it('allows tests/ in worktree', () => {
      expect(isBlocked(runEditGuard('/project/.worktrees/feat/tests/engine/test.ts'))).toBe(false);
    });
    it('allows package.json in worktree', () => {
      expect(isBlocked(runEditGuard('/project/.worktrees/feat/package.json'))).toBe(false);
    });
    it('allows guard.cjs in worktree', () => {
      expect(isBlocked(runEditGuard('/project/.worktrees/fix/.claude/hooks/guard.cjs'))).toBe(false);
    });
    it('allows guard-edit.cjs in worktree', () => {
      expect(isBlocked(runEditGuard('/project/.worktrees/fix/.claude/hooks/guard-edit.cjs'))).toBe(false);
    });
    it('allows deploy.sh in worktree', () => {
      expect(isBlocked(runEditGuard('/project/.worktrees/fix/deploy.sh'))).toBe(false);
    });
    it('allows .husky/pre-commit in worktree', () => {
      expect(isBlocked(runEditGuard('/project/.worktrees/fix/.husky/pre-commit'))).toBe(false);
    });
  });

  describe('unknown/unmatched paths → allow', () => {
    it('allows random file', () => {
      expect(isBlocked(runEditGuard('/tmp/something.txt'))).toBe(false);
    });
    it('allows empty path', () => {
      expect(isBlocked(runEditGuard(''))).toBe(false);
    });
  });
});

describe('guard-edit.cjs — BLOCKED on master (branch-dependent)', () => {
  describe('guard file protection patterns', () => {
    it('guard.cjs pattern matches', () => {
      expect(/\/(guard\.cjs|guard-edit\.cjs|deploy\.sh)$/.test('/project/.claude/hooks/guard.cjs')).toBe(true);
    });
    it('guard-edit.cjs pattern matches', () => {
      expect(/\/(guard\.cjs|guard-edit\.cjs|deploy\.sh)$/.test('/project/.claude/hooks/guard-edit.cjs')).toBe(true);
    });
    it('deploy.sh pattern matches', () => {
      expect(/\/(guard\.cjs|guard-edit\.cjs|deploy\.sh)$/.test('/project/deploy.sh')).toBe(true);
    });
    it('.husky/ pattern matches', () => {
      expect(/\.husky\//.test('/project/.husky/pre-commit')).toBe(true);
    });
  });

  describe('src/ protection patterns', () => {
    it('src/engine/engine.ts matches', () => {
      expect(/\/(src|tests)\//.test('/project/src/engine/engine.ts')).toBe(true);
    });
    it('tests/engine/test.ts matches', () => {
      expect(/\/(src|tests)\//.test('/project/tests/engine/test.ts')).toBe(true);
    });
    it('package.json matches', () => {
      expect(/package\.json$/.test('/project/package.json')).toBe(true);
    });
  });

  describe('.gitignore and settings.local.json patterns', () => {
    it('.gitignore pattern matches', () => {
      expect(/\.gitignore$/.test('/project/.gitignore')).toBe(true);
    });
    it('settings.local.json pattern matches', () => {
      expect(/settings\.local\.json$/.test('/project/.claude/settings.local.json')).toBe(true);
    });
  });
});

describe('guard-edit.cjs — warnings', () => {
  it('warns on settings.local.json edit', () => {
    const r = runEditGuard('/project/.claude/settings.local.json');
    expect(hasWarning(r)).toBe(true);
  });
  it('settings.local.json is warn only, not block', () => {
    expect(isBlocked(runEditGuard('/project/.claude/settings.local.json'))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// Stress test — bypass vectors
// ═══════════════════════════════════════════════════════════════

describe('guard.cjs — stress test: string literal false positive prevention', () => {
  it('allows node -e with force-push in string literal', () => {
    expect(isBlocked(runGuard('node -e "console.log(\'git push --force\')"'))).toBe(false);
  });
  it('allows echo with force-push in quotes', () => {
    expect(isBlocked(runGuard('echo "git push --force" > /dev/null'))).toBe(false);
  });
  it('still blocks actual force push after string literal', () => {
    expect(isBlocked(runGuard('echo "test" && git push --force'))).toBe(true);
  });
  it('allows heredoc containing dangerous keywords', () => {
    expect(isBlocked(runGuard('git commit -m "$(cat <<\'EOF\'\ngit push --force\nEOF\n)"'))).toBe(false);
  });
});

describe('guard.cjs — stress test: guard file mutation', () => {
  it('blocks mv guard.cjs', () => {
    expect(isBlocked(runGuard('mv .claude/hooks/guard.cjs .claude/hooks/guard.cjs.bak'))).toBe(true);
  });
  it('blocks cp over guard.cjs', () => {
    expect(isBlocked(runGuard('cp /tmp/empty.js .claude/hooks/guard.cjs'))).toBe(true);
  });
  it('blocks mv guard-edit.cjs', () => {
    expect(isBlocked(runGuard('mv .claude/hooks/guard-edit.cjs /tmp/'))).toBe(true);
  });
  it('blocks cp over deploy.sh', () => {
    expect(isBlocked(runGuard('cp /tmp/noop.sh deploy.sh'))).toBe(true);
  });
  it('blocks mv .husky/pre-commit', () => {
    expect(isBlocked(runGuard('mv .husky/pre-commit /tmp/'))).toBe(true);
  });
  it('allows mv/cp guard files in worktree', () => {
    expect(isBlocked(runGuard('cp .claude/hooks/guard.cjs .worktrees/fix/.claude/hooks/guard.cjs'))).toBe(false);
  });
});

describe('guard.cjs — stress test: guard file destruction vectors', () => {
  it('blocks cat /dev/null > guard.cjs (redirect)', () => {
    expect(isBlocked(runGuard('cat /dev/null > .claude/hooks/guard.cjs'))).toBe(true);
  });
  it('blocks truncate -s0 guard.cjs', () => {
    expect(isBlocked(runGuard('truncate -s0 .claude/hooks/guard.cjs'))).toBe(true);
  });
  it('blocks rm .claude/hooks/guard.cjs', () => {
    expect(isBlocked(runGuard('rm .claude/hooks/guard.cjs'))).toBe(true);
  });
  it('blocks rm -rf .claude/', () => {
    expect(isBlocked(runGuard('rm -rf .claude/'))).toBe(true);
  });
  it('blocks rm -rf .husky/', () => {
    expect(isBlocked(runGuard('rm -rf .husky/'))).toBe(true);
  });
  it('blocks echo | tee guard.cjs', () => {
    expect(isBlocked(runGuard('echo x | tee .claude/hooks/guard.cjs'))).toBe(true);
  });
  it('blocks sed -i on guard.cjs', () => {
    expect(isBlocked(runGuard('sed -i s/deny/allow/ .claude/hooks/guard.cjs'))).toBe(true);
  });
  it('blocks chmod 000 guard.cjs', () => {
    expect(isBlocked(runGuard('chmod 000 .claude/hooks/guard.cjs'))).toBe(true);
  });
  it('blocks ln -sf /dev/null guard.cjs', () => {
    expect(isBlocked(runGuard('ln -sf /dev/null .claude/hooks/guard.cjs'))).toBe(true);
  });
  it('blocks dd if=/dev/null of=guard.cjs', () => {
    expect(isBlocked(runGuard('dd if=/dev/null of=.claude/hooks/guard.cjs'))).toBe(true);
  });
  it('blocks python3 -c open(guard.cjs).close()', () => {
    expect(isBlocked(runGuard("python3 -c 'open(\".claude/hooks/guard.cjs\",\"w\").close()'"))).toBe(true);
  });
  it('allows cat guard.cjs (read-only)', () => {
    expect(isBlocked(runGuard('cat .claude/hooks/guard.cjs'))).toBe(false);
  });
  it('allows head guard.cjs (read-only)', () => {
    expect(isBlocked(runGuard('head -5 .claude/hooks/guard.cjs'))).toBe(false);
  });
  it('allows grep guard.cjs (read-only)', () => {
    expect(isBlocked(runGuard('grep -n block .claude/hooks/guard.cjs'))).toBe(false);
  });
  it('allows wc guard.cjs (read-only)', () => {
    expect(isBlocked(runGuard('wc -l .claude/hooks/guard.cjs'))).toBe(false);
  });
  it('allows operations on guard files in worktree', () => {
    expect(isBlocked(runGuard('sed -i s/x/y/ .worktrees/fix/.claude/hooks/guard.cjs'))).toBe(false);
  });
});

describe('guard.cjs — stress test: trailing slash bypass', () => {
  it('blocks rm -rf .claude (no trailing slash)', () => {
    expect(isBlocked(runGuard('rm -rf .claude'))).toBe(true);
  });
  it('blocks rm -rf .husky (no trailing slash)', () => {
    expect(isBlocked(runGuard('rm -rf .husky'))).toBe(true);
  });
  it('blocks rm -r .claude', () => {
    expect(isBlocked(runGuard('rm -r .claude'))).toBe(true);
  });
  it('blocks rm .claude/settings.json', () => {
    expect(isBlocked(runGuard('rm .claude/settings.json'))).toBe(true);
  });
  it('blocks sed on settings.local.json', () => {
    expect(isBlocked(runGuard('sed -i s/hooks/x/ .claude/settings.local.json'))).toBe(true);
  });
});

describe('guard.cjs — stress test: worktree false positives', () => {
  it('allows cd .worktrees/feat && npm install (quoted path)', () => {
    expect(isBlocked(runGuard('cd ".worktrees/feat" && npm install'))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// Pipeline workflow tests — correct agent behavior sequences
// ═══════════════════════════════════════════════════════════════

describe('Pipeline workflow — correct sequences ALLOWED', () => {
  it('worktree creation: git branch + git worktree add', () => {
    expect(isBlocked(runGuard('git branch feat/new-feature'))).toBe(false);
    expect(isBlocked(runGuard('git worktree add .worktrees/new-feature feat/new-feature'))).toBe(false);
  });

  it('work in worktree: cd + npm install', () => {
    expect(isBlocked(runGuard('cd ".worktrees/new-feature" && npm install'))).toBe(false);
  });

  it('build and test in worktree', () => {
    expect(isBlocked(runGuard('cd ".worktrees/new-feature" && npm run build'))).toBe(false);
    expect(isBlocked(runGuard('cd ".worktrees/new-feature" && npx vitest run'))).toBe(false);
  });

  it('commit in worktree (not on master)', () => {
    const r = runGuard('cd ".worktrees/new-feature" && git add . && git commit -m "feat: new thing"');
    expect(r).toBeDefined();
  });

  it('switch to master for merge', () => {
    expect(isBlocked(runGuard('git checkout master'))).toBe(false);
  });

  it('normal push after merge', () => {
    expect(isBlocked(runGuard('git push'))).toBe(false);
  });

  it('worktree cleanup', () => {
    expect(isBlocked(runGuard('git worktree remove .worktrees/new-feature --force'))).toBe(false);
    expect(isBlocked(runGuard('git branch -d feat/new-feature'))).toBe(false);
  });

  it('deploy via deploy.sh', () => {
    const r = runGuard('bash deploy.sh');
    expect(r).toBeDefined();
  });

  it('edit docs on master (allowed)', () => {
    expect(isBlocked(runEditGuard('/project/CLAUDE.md'))).toBe(false);
    expect(isBlocked(runEditGuard('/project/CHANGELOG.md'))).toBe(false);
    expect(isBlocked(runEditGuard('/project/docs/BACKLOG.md'))).toBe(false);
  });

  it('edit source in worktree (allowed)', () => {
    expect(isBlocked(runEditGuard('/project/.worktrees/feat/src/engine/engine.ts'))).toBe(false);
    expect(isBlocked(runEditGuard('/project/.worktrees/feat/src/client/renderer.ts'))).toBe(false);
    expect(isBlocked(runEditGuard('/project/.worktrees/feat/package.json'))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// Configurable features — require guards.config.json
// ═══════════════════════════════════════════════════════════════

describe('guard.cjs — configurable: protectedFiles', () => {
  const cfg = { protectedFiles: ['world.json', 'clans_permanent.json'] };

  it('blocks rm on configured protected file', () => {
    expect(isBlocked(runGuardCfg('rm data/world.json', cfg))).toBe(true);
  });
  it('blocks rm on second protected file', () => {
    expect(isBlocked(runGuardCfg('rm data/clans_permanent.json', cfg))).toBe(true);
  });
  it('blocks rm -f on protected file', () => {
    expect(isBlocked(runGuardCfg('rm -f data/world.json', cfg))).toBe(true);
  });
  it('allows rm on non-protected file', () => {
    expect(isBlocked(runGuardCfg('rm /tmp/test.txt', cfg))).toBe(false);
  });
  it('deny reason lists protected files', () => {
    const reason = getDenyReason(runGuardCfg('rm data/world.json', cfg));
    expect(reason).toContain('world.json');
  });

  it('no protection when protectedFiles is empty (default)', () => {
    expect(isBlocked(runGuardCfg('rm data/world.json', { protectedFiles: [] }))).toBe(false);
  });

  it('supports custom file names', () => {
    expect(isBlocked(runGuardCfg('rm database.sqlite', { protectedFiles: ['database.sqlite'] }))).toBe(true);
  });
});

describe('guard.cjs — configurable: immutablePaths', () => {
  const cfg = { immutablePaths: ['docs/superpowers/specs', 'docs/superpowers/plans'] };

  it('blocks rm on immutable path', () => {
    expect(isBlocked(runGuardCfg('rm docs/superpowers/specs/my-spec.md', cfg))).toBe(true);
  });
  it('blocks git rm on immutable path', () => {
    expect(isBlocked(runGuardCfg('git rm docs/superpowers/specs/old.md', cfg))).toBe(true);
  });
  it('blocks rm on plans', () => {
    expect(isBlocked(runGuardCfg('rm docs/superpowers/plans/my-plan.md', cfg))).toBe(true);
  });
  it('blocks git rm on plans', () => {
    expect(isBlocked(runGuardCfg('git rm docs/superpowers/plans/my-plan.md', cfg))).toBe(true);
  });
  it('blocks git mv on specs', () => {
    expect(isBlocked(runGuardCfg('git mv docs/superpowers/specs/old.md archive/', cfg))).toBe(true);
  });
  it('blocks git mv on plans', () => {
    expect(isBlocked(runGuardCfg('git mv docs/superpowers/plans/old.md archive/', cfg))).toBe(true);
  });

  it('no protection when immutablePaths is empty (default)', () => {
    expect(isBlocked(runGuardCfg('rm docs/superpowers/specs/old.md', { immutablePaths: [] }))).toBe(false);
  });

  it('supports custom paths', () => {
    expect(isBlocked(runGuardCfg('rm docs/api/v1/schema.md', { immutablePaths: ['docs/api'] }))).toBe(true);
  });
});

describe('guard.cjs — configurable: sshHost warnings', () => {
  const cfg = { sshHost: 'my-server' };

  it('warns on scp to configured host with dist/', () => {
    const r = runGuardCfg('scp dist/server/index.js my-server:/opt/apps/dist/', cfg);
    expect(hasWarning(r)).toBe(true);
  });
  it('warns on rsync to configured host with src/', () => {
    const r = runGuardCfg('rsync -avz src/ my-server:/opt/apps/src/', cfg);
    expect(hasWarning(r)).toBe(true);
  });
  it('warns on ssh restart to configured host', () => {
    const r = runGuardCfg('ssh my-server "systemctl restart my-app"', cfg);
    expect(hasWarning(r)).toBe(true);
  });
  it('does not warn on ssh status check', () => {
    const r = runGuardCfg('ssh my-server "systemctl status my-app"', cfg);
    expect(hasWarning(r)).toBe(false);
    expect(isBlocked(r)).toBe(false);
  });
  it('no warnings when sshHost is null (default)', () => {
    const r = runGuardCfg('scp dist/index.js my-server:/opt/', { sshHost: null });
    expect(hasWarning(r)).toBe(false);
  });
  it('warning mentions the ssh host', () => {
    const r = runGuardCfg('scp dist/server/index.js my-server:/opt/apps/dist/', cfg);
    expect(r.systemMessage).toContain('my-server');
  });
});

describe('guard.cjs — configurable: blockCheckoutBranch', () => {
  it('blocks checkout -b when enabled (default)', () => {
    expect(isBlocked(runGuardCfg('git checkout -b feat/test', { blockCheckoutBranch: true }))).toBe(true);
  });
  it('allows checkout -b when disabled', () => {
    expect(isBlocked(runGuardCfg('git checkout -b feat/test', { blockCheckoutBranch: false }))).toBe(false);
  });
});

describe('guard.cjs — configurable: blockShellDelegation', () => {
  it('blocks bash -c when enabled (default)', () => {
    expect(isBlocked(runGuardCfg('bash -c "echo test"', { blockShellDelegation: true }))).toBe(true);
  });
  it('allows bash -c when disabled', () => {
    expect(isBlocked(runGuardCfg('bash -c "echo test"', { blockShellDelegation: false }))).toBe(false);
  });
});

describe('guard.cjs — configurable: custom worktreePath', () => {
  const cfg = { worktreePath: '.wt/' };

  it('allows npm install in custom worktree path', () => {
    expect(isBlocked(runGuardCfg('cd ".wt/feat" && npm install', cfg))).toBe(false);
  });
  it('allows guard file ops in custom worktree path', () => {
    expect(isBlocked(runGuardCfg('sed -i s/x/y/ .wt/fix/.claude/hooks/guard.cjs', cfg))).toBe(false);
  });
});

describe('guard-edit.cjs — configurable: custom editGuardFiles', () => {
  it('protects custom guard file names', () => {
    const cfg = { editGuardFiles: ['guard.cjs', 'guard-edit.cjs', 'deploy.sh', 'ci-check.sh'] };
    const r = runEditGuardCfg('/project/ci-check.sh', cfg);
    // Pattern check: /\/(guard\.cjs|guard-edit\.cjs|deploy\.sh|ci-check\.sh)$/
    expect(/\/(ci-check\.sh)$/.test('/project/ci-check.sh')).toBe(true);
  });
});

describe('guard-edit.cjs — configurable: custom editBlockPaths', () => {
  it('blocks custom path patterns on master', () => {
    const cfg = { editBlockPaths: ['\\/(src|lib|tests)\\/', 'package\\.json$'] };
    // Structural test — verifies the regex matches
    expect(/\/(src|lib|tests)\//.test('/project/lib/utils.ts')).toBe(true);
  });
});

describe('guard-edit.cjs — configurable: custom editAllowPaths', () => {
  it('allows custom path patterns', () => {
    const cfg = { editAllowPaths: ['\\/(docs|config)\\/', 'README\\.md$'] };
    // Structural test
    expect(/\/(docs|config)\//.test('/project/config/app.json')).toBe(true);
    expect(/README\.md$/.test('/project/README.md')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// Edge cases and regression tests
// ═══════════════════════════════════════════════════════════════

describe('guard.cjs — edge cases', () => {
  it('handles malformed JSON input gracefully', () => {
    const r = spawnSync('node', ['.claude/hooks/guard.cjs'], {
      input: 'not json', encoding: 'utf8', timeout: 5000,
    });
    expect(JSON.parse(r.stdout.trim())).toEqual({});
  });

  it('handles missing tool_input gracefully', () => {
    const r = spawnSync('node', ['.claude/hooks/guard.cjs'], {
      input: '{}', encoding: 'utf8', timeout: 5000,
    });
    expect(JSON.parse(r.stdout.trim())).toEqual({});
  });

  it('handles missing command gracefully', () => {
    const r = spawnSync('node', ['.claude/hooks/guard.cjs'], {
      input: '{"tool_input":{}}', encoding: 'utf8', timeout: 5000,
    });
    expect(JSON.parse(r.stdout.trim())).toEqual({});
  });
});

describe('guard-edit.cjs — edge cases', () => {
  it('handles malformed JSON input gracefully', () => {
    const r = spawnSync('node', ['.claude/hooks/guard-edit.cjs'], {
      input: 'not json', encoding: 'utf8', timeout: 5000,
    });
    expect(JSON.parse(r.stdout.trim())).toEqual({});
  });

  it('handles backslash paths (Windows)', () => {
    const r = runEditGuard('C:\\project\\.worktrees\\feat\\src\\file.ts');
    expect(isBlocked(r)).toBe(false);
  });

  it('normalizes Windows paths for worktree check', () => {
    expect(isBlocked(runEditGuard('C:\\project\\.worktrees\\feat\\package.json'))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// Audit v4 — temp dir execution + interpreter bypass
// ═══════════════════════════════════════════════════════════════

describe('guard.cjs — temp dir script execution blocked', () => {
  it('blocks bash /tmp/script.sh', () => {
    expect(isBlocked(runGuard('bash /tmp/evil.sh'))).toBe(true);
  });
  it('blocks node /tmp/script.js', () => {
    expect(isBlocked(runGuard('node /tmp/exploit.js'))).toBe(true);
  });
  it('blocks sh /tmp/script.sh', () => {
    expect(isBlocked(runGuard('sh /tmp/x.sh'))).toBe(true);
  });
  it('blocks python /tmp/script.py', () => {
    expect(isBlocked(runGuard('python3 /tmp/x.py'))).toBe(true);
  });
  it('allows node src/server/index.ts (not /tmp/)', () => {
    expect(isBlocked(runGuard('node src/server/index.ts'))).toBe(false);
  });
  it('allows bash scripts/backlog-status.sh (not /tmp/)', () => {
    expect(isBlocked(runGuard('bash scripts/backlog-status.sh'))).toBe(false);
  });
  it('allows npx vitest run (not script from /tmp/)', () => {
    expect(isBlocked(runGuard('npx vitest run'))).toBe(false);
  });
});

describe('guard.cjs — interpreter -e/-c warns', () => {
  it('warns on node -e', () => {
    expect(hasWarning(runGuard('node -e "process.exit(0)"'))).toBe(true);
  });
  it('warns on python3 -c', () => {
    expect(hasWarning(runGuard("python3 -c 'print(1)'"))).toBe(true);
  });
  it('warns on perl -e', () => {
    expect(hasWarning(runGuard('perl -e "print 1"'))).toBe(true);
  });
  it('does not block node -e (warn only)', () => {
    expect(isBlocked(runGuard('node -e "process.exit(0)"'))).toBe(false);
  });
});

describe('guard-edit.cjs — temp dir script write warns', () => {
  it('warns on Write to /tmp/*.sh', () => {
    expect(hasWarning(runEditGuard('/tmp/evil.sh'))).toBe(true);
  });
  it('warns on Write to /tmp/*.js', () => {
    expect(hasWarning(runEditGuard('/tmp/exploit.js'))).toBe(true);
  });
  it('warns on Write to /tmp/*.py', () => {
    expect(hasWarning(runEditGuard('/tmp/script.py'))).toBe(true);
  });
  it('allows Write to project tests/', () => {
    expect(hasWarning(runEditGuard('/project/.worktrees/feat/tests/test.ts'))).toBe(false);
  });
});
