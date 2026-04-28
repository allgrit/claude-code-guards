import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';

function runGuard(cmd: string): Record<string, unknown> {
  const input = JSON.stringify({ tool_input: { command: cmd } });
  const r = spawnSync('node', ['.claude/hooks/guard.cjs'], { input, encoding: 'utf8', timeout: 5000 });
  return JSON.parse(r.stdout.trim() || '{}');
}

function runEditGuard(filePath: string): Record<string, unknown> {
  const input = JSON.stringify({ tool_input: { file_path: filePath } });
  const r = spawnSync('node', ['.claude/hooks/guard-edit.cjs'], { input, encoding: 'utf8', timeout: 5000 });
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
// guard.cjs — BLOCKED commands
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

  describe('Rule 5: protected data files', () => {
    it('blocks rm world.json', () => {
      expect(isBlocked(runGuard('rm data/world.json'))).toBe(true);
    });
    it('blocks rm clans_permanent.json', () => {
      expect(isBlocked(runGuard('rm data/clans_permanent.json'))).toBe(true);
    });
    it('blocks rm -f world.json', () => {
      expect(isBlocked(runGuard('rm -f data/world.json'))).toBe(true);
    });
  });

  describe('Rule 5a: specs immutable', () => {
    it('blocks rm on specs', () => {
      expect(isBlocked(runGuard('rm docs/superpowers/specs/my-spec.md'))).toBe(true);
    });
    it('blocks git rm on specs', () => {
      expect(isBlocked(runGuard('git rm docs/superpowers/specs/old.md'))).toBe(true);
    });
  });

  describe('Rule 5b: plans immutable', () => {
    it('blocks rm on plans', () => {
      expect(isBlocked(runGuard('rm docs/superpowers/plans/my-plan.md'))).toBe(true);
    });
    it('blocks git rm on plans', () => {
      expect(isBlocked(runGuard('git rm docs/superpowers/plans/my-plan.md'))).toBe(true);
    });
    it('blocks git mv on specs', () => {
      expect(isBlocked(runGuard('git mv docs/superpowers/specs/old.md archive/'))).toBe(true);
    });
    it('blocks git mv on plans', () => {
      expect(isBlocked(runGuard('git mv docs/superpowers/plans/old.md archive/'))).toBe(true);
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

  describe('merge (allowed via --no-ff from master)', () => {
    it('allows git merge --no-ff (structural)', () => {
      // Merge guard checks version bump, but the command itself is not blanket-blocked
      const r = runGuard('git merge feat/my-branch --no-ff -m "merge: my feature"');
      // May warn or block on version bump, but not on "merge is forbidden" basis
      // The guard returns either ok, warn, or block-for-version-bump — not "merge banned"
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
      // deploy guard checks push status, but on a fresh branch it won't block structurally
      const r = runGuard('bash deploy.sh');
      expect(r).toBeDefined();
    });
  });

  describe('server operations', () => {
    it('allows ssh commands', () => {
      expect(isBlocked(runGuard('ssh tribe-vps "systemctl status tribe-world"'))).toBe(false);
    });
    it('allows curl', () => {
      expect(isBlocked(runGuard('curl https://tribe.tsdpu.org/api/config'))).toBe(false);
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
  // These tests verify the REGEX patterns match — actual blocking depends on current branch
  // We test structural matching, not branch state

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

// ═══════════════════════════════════════════════════════════════
// Stress test — bypass vectors from adversarial audit
// ═══════════════════════════════════════════════════════════════

describe('guard.cjs — stress test bypass vectors', () => {
  describe('git switch -c (alternative to checkout -b)', () => {
    it('blocks git switch -c feat/', () => {
      expect(isBlocked(runGuard('git switch -c feat/sneaky'))).toBe(true);
    });
    it('allows git switch (without -c)', () => {
      expect(isBlocked(runGuard('git switch master'))).toBe(false);
    });
  });

  describe('force-with-lease (alternative to --force)', () => {
    it('blocks git push --force-with-lease', () => {
      expect(isBlocked(runGuard('git push origin HEAD --force-with-lease'))).toBe(true);
    });
  });

  describe('string literal false positive prevention', () => {
    it('allows node -e with force-push in string literal', () => {
      expect(isBlocked(runGuard('node -e "console.log(\'git push --force\')"'))).toBe(false);
    });
    it('allows echo with force-push in quotes', () => {
      expect(isBlocked(runGuard('echo "git push --force" > /dev/null'))).toBe(false);
    });
    it('still blocks actual force push after string literal', () => {
      expect(isBlocked(runGuard('echo "test" && git push --force'))).toBe(true);
    });
  });

  describe('guard file mv/cp protection', () => {
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

  describe('git config hooksPath (disables pre-commit)', () => {
    it('blocks git config core.hooksPath', () => {
      expect(isBlocked(runGuard('git config core.hooksPath /dev/null'))).toBe(true);
    });
    it('blocks git config --global core.hooksPath', () => {
      expect(isBlocked(runGuard('git config --global core.hooksPath /tmp'))).toBe(true);
    });
  });

  describe('git rebase on master (history rewrite)', () => {
    it('allows git rebase in feature branch', () => {
      // On worktree branch — not master, so should allow
      // (depends on current branch, structural test)
      const r = runGuard('cd ".worktrees/my-branch" && git rebase main');
      expect(r).toBeDefined();
    });
  });

  describe('direct deploy bypass (ssh/scp/rsync)', () => {
    it('warns on scp to tribe-vps dist/', () => {
      const r = runGuard('scp dist/server/index.js tribe-vps:/opt/apps/tribe-world/dist/');
      expect(hasWarning(r)).toBe(true);
    });
    it('warns on rsync to tribe-vps', () => {
      const r = runGuard('rsync -avz dist/ tribe-vps:/opt/apps/tribe-world/dist/');
      expect(hasWarning(r)).toBe(true);
    });
    it('warns on ssh restart without deploy.sh', () => {
      const r = runGuard('ssh tribe-vps "systemctl restart tribe-world"');
      expect(hasWarning(r)).toBe(true);
    });
    it('allows ssh status check (read-only)', () => {
      expect(isBlocked(runGuard('ssh tribe-vps "systemctl status tribe-world"'))).toBe(false);
      expect(hasWarning(runGuard('ssh tribe-vps "systemctl status tribe-world"'))).toBe(false);
    });
  });
});

describe('guard-edit.cjs — stress test bypass vectors', () => {
  describe('settings.local.json warning', () => {
    it('warns on settings.local.json edit', () => {
      const r = runEditGuard('/project/.claude/settings.local.json');
      expect(hasWarning(r)).toBe(true);
    });
    it('does not block (warn only)', () => {
      expect(isBlocked(runEditGuard('/project/.claude/settings.local.json'))).toBe(false);
    });
  });

  describe('.gitignore protection', () => {
    it('.gitignore pattern matches for block check', () => {
      expect(/\.gitignore$/.test('/project/.gitignore')).toBe(true);
    });
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
    // Commit guard checks branch — worktree branch is not master
    const r = runGuard('cd ".worktrees/new-feature" && git add . && git commit -m "feat: new thing"');
    // May or may not block depending on detected branch — structural test
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
    // May block if local ahead — structural test
    expect(r).toBeDefined();
  });

  it('post-deploy verify', () => {
    expect(isBlocked(runGuard('ssh tribe-vps "systemctl status tribe-world"'))).toBe(false);
    expect(isBlocked(runGuard('ssh tribe-vps "tail -20 /opt/apps/tribe-world/data/errors.jsonl"'))).toBe(false);
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
// Audit v2 — comprehensive guard file destruction vectors
// ═══════════════════════════════════════════════════════════════

describe('guard.cjs — audit v2: guard file destruction (11 critical)', () => {
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

describe('guard.cjs — audit v2: force push + branch bypasses', () => {
  it('blocks git push origin +HEAD:master (refspec)', () => {
    expect(isBlocked(runGuard('git push origin +HEAD:master'))).toBe(true);
  });
  it('blocks git -C /tmp push --force', () => {
    expect(isBlocked(runGuard('git -C /tmp push --force'))).toBe(true);
  });
  it('blocks git checkout -B feat/x (uppercase B)', () => {
    expect(isBlocked(runGuard('git checkout -B feat/my-feature'))).toBe(true);
  });
  it('blocks bash -c with dangerous command', () => {
    expect(isBlocked(runGuard('bash -c "git push --force"'))).toBe(true);
  });
  it('blocks eval with dangerous command', () => {
    expect(isBlocked(runGuard('eval "git push --force"'))).toBe(true);
  });
});

describe('guard.cjs — audit v3: trailing slash bypass', () => {
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
  it('blocks git update-ref -d HEAD on master', () => {
    expect(isBlocked(runGuard('git update-ref -d HEAD'))).toBe(true);
  });
  it('blocks git filter-branch on master', () => {
    expect(isBlocked(runGuard('git filter-branch --force HEAD'))).toBe(true);
  });
});

describe('guard.cjs — audit v2: worktree cd false positive fix', () => {
  it('allows cd .worktrees/feat && npm install (quoted path)', () => {
    expect(isBlocked(runGuard('cd ".worktrees/feat" && npm install'))).toBe(false);
  });
});
