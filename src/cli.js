#!/usr/bin/env node
// claude-code-guards CLI — init / update
// Installs guard hooks into the current project.

const fs = require('fs');
const path = require('path');

const command = process.argv[2];

if (!command || !['init', 'update'].includes(command)) {
  console.log('Usage: claude-code-guards <init|update>');
  console.log('');
  console.log('  init   — Install guard hooks + example config + tests');
  console.log('  update — Update guard hooks (preserves guards.config.json)');
  process.exit(1);
}

const cwd = process.cwd();
const pkgDir = path.resolve(__dirname, '..');
const templatesDir = path.join(pkgDir, 'templates');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function copyFile(src, dest, label) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
  console.log('  [+] ' + label);
}

function mergeSettings(settingsPath, hooksConfig) {
  let existing = {};
  if (fs.existsSync(settingsPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch {
      console.log(
        '  [!] Warning: existing settings.local.json is invalid JSON, overwriting'
      );
    }
  }

  if (!existing.hooks) {
    existing.hooks = {};
  }

  for (const [event, matchers] of Object.entries(hooksConfig.hooks)) {
    if (!existing.hooks[event]) {
      existing.hooks[event] = [];
    }
    for (const matcher of matchers) {
      const existingIdx = existing.hooks[event].findIndex(
        (m) => m.matcher === matcher.matcher
      );
      if (existingIdx >= 0) {
        existing.hooks[event][existingIdx] = matcher;
      } else {
        existing.hooks[event].push(matcher);
      }
    }
  }

  ensureDir(path.dirname(settingsPath));
  fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2) + '\n');
  console.log('  [+] settings.local.json (hooks merged)');
}

// Execute

console.log('');
console.log('claude-code-guards ' + command);
console.log('');

// 1. Copy guard-bash.cjs → .claude/hooks/guard.cjs
copyFile(
  path.join(templatesDir, 'guard-bash.cjs'),
  path.join(cwd, '.claude', 'hooks', 'guard.cjs'),
  '.claude/hooks/guard.cjs'
);

// 2. Copy guard-edit.cjs → .claude/hooks/guard-edit.cjs
copyFile(
  path.join(templatesDir, 'guard-edit.cjs'),
  path.join(cwd, '.claude', 'hooks', 'guard-edit.cjs'),
  '.claude/hooks/guard-edit.cjs'
);

// 3. Merge hooks into settings.local.json
const hooksConfig = JSON.parse(
  fs.readFileSync(path.join(templatesDir, 'settings-hooks.json'), 'utf8')
);
mergeSettings(path.join(cwd, '.claude', 'settings.local.json'), hooksConfig);

// 4. Copy test file
copyFile(
  path.join(templatesDir, 'guard.test.ts'),
  path.join(cwd, 'tests', 'guards', 'guard.test.ts'),
  'tests/guards/guard.test.ts'
);

// 5. Copy example config (init only, never overwrite existing)
if (command === 'init') {
  const configDest = path.join(cwd, '.claude', 'guards.config.json');
  if (!fs.existsSync(configDest)) {
    copyFile(
      path.join(templatesDir, 'guards.config.json'),
      configDest,
      '.claude/guards.config.json (example — customize for your project)'
    );
  } else {
    console.log('  [=] .claude/guards.config.json (already exists, kept)');
  }
}

console.log('');
console.log('Done! Guards installed.');
console.log('');
if (command === 'init') {
  console.log('Next steps:');
  console.log(
    '  1. Edit .claude/guards.config.json — set protectedFiles, sshHost, etc.'
  );
  console.log('  2. Run tests: npx vitest run tests/guards/guard.test.ts');
  console.log('');
}
