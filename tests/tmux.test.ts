import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { loadEnvFile } from '../src/config.js';
import {
  buildLaunchCommand,
  buildSessionRuntimePaths,
  cleanupSessionArtifacts,
  cleanupSessionWorkspace,
  ensureSessionRuntimePaths,
  prepareSessionWorkspace,
  splitInput,
  validateProjectPath,
} from '../src/tmux.js';

describe('validateProjectPath', () => {
  it('accepts a directory under an allowed root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dtwl-root-'));
    const child = path.join(root, 'project');
    fs.mkdirSync(child);

    const resolved = validateProjectPath(child, [root]);
    expect(resolved).toBe(fs.realpathSync(child));
  });

  it('rejects a directory outside allowed roots', () => {
    const allowed = fs.mkdtempSync(path.join(os.tmpdir(), 'dtwl-allowed-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dtwl-outside-'));

    expect(() => validateProjectPath(outside, [allowed])).toThrow(/outside allowed roots/);
  });

  it('creates a missing directory under an allowed root', () => {
    const allowed = fs.mkdtempSync(path.join(os.tmpdir(), 'dtwl-allowed-'));
    const target = path.join(allowed, 'nested', 'project');

    const resolved = validateProjectPath(target, [allowed]);

    expect(resolved).toBe(fs.realpathSync(target));
    expect(fs.existsSync(target)).toBe(true);
  });
});

describe('splitInput', () => {
  it('keeps printable chunks together', () => {
    expect(splitInput('hello')).toEqual([{ type: 'literal', value: 'hello' }]);
  });

  it('maps special keys and control sequences', () => {
    expect(splitInput('a\r\u0003\u001b[A')).toEqual([
      { type: 'literal', value: 'a' },
      { type: 'key', value: 'Enter' },
      { type: 'key', value: 'C-c' },
      { type: 'key', value: 'Up' },
    ]);
  });
});

describe('loadEnvFile', () => {
  it('loads missing environment variables from a dotenv file', () => {
    const envFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dtwl-env-')), '.env');
    fs.writeFileSync(envFile, 'DTWL_TEST_KEY=hello\nDTWL_QUOTED="world"\n');
    delete process.env['DTWL_TEST_KEY'];
    delete process.env['DTWL_QUOTED'];

    loadEnvFile(envFile);

    expect(process.env['DTWL_TEST_KEY']).toBe('hello');
    expect(process.env['DTWL_QUOTED']).toBe('world');
  });
});

describe('session runtime paths', () => {
  it('creates isolated runtime directories per session', () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dtwl-runtime-'));
    const runtimePaths = ensureSessionRuntimePaths(buildSessionRuntimePaths(runtimeRoot, 'abc123'));

    expect(runtimePaths.rootDir).toBe(path.join(runtimeRoot, 'abc123'));
    expect(fs.existsSync(runtimePaths.codexHomeDir)).toBe(true);
    expect(fs.existsSync(runtimePaths.claudeConfigDir)).toBe(true);
  });

  it('preserves shared auth/config entries via symlinks', () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dtwl-runtime-'));
    const sharedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dtwl-home-'));
    const sharedCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dtwl-codex-'));
    const sharedClaudeConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'dtwl-claude-'));
    fs.writeFileSync(path.join(sharedHome, '.claude.json'), '{"projects":[]}');
    fs.writeFileSync(path.join(sharedCodexHome, 'auth.json'), '{"ok":true}');
    fs.writeFileSync(path.join(sharedCodexHome, 'config.toml'), 'model = "gpt-5.4"\n');
    fs.writeFileSync(path.join(sharedClaudeConfig, '.credentials.json'), '{"ok":true}');
    fs.writeFileSync(path.join(sharedClaudeConfig, 'settings.json'), '{"theme":"dark"}');

    const runtimePaths = ensureSessionRuntimePaths(buildSessionRuntimePaths(runtimeRoot, 'abc123'), {
      homeDir: sharedHome,
      codexHomeDir: sharedCodexHome,
      claudeConfigDir: sharedClaudeConfig,
    });

    expect(fs.readlinkSync(path.join(runtimePaths.rootDir, '.claude.json'))).toBe(
      path.join(sharedHome, '.claude.json'),
    );
    expect(fs.readlinkSync(path.join(runtimePaths.codexHomeDir, 'auth.json'))).toBe(
      path.join(sharedCodexHome, 'auth.json'),
    );
    expect(fs.readlinkSync(path.join(runtimePaths.claudeConfigDir, '.credentials.json'))).toBe(
      path.join(sharedClaudeConfig, '.credentials.json'),
    );
  });
});

describe('prepareSessionWorkspace', () => {
  it('copies a non-git project into an isolated snapshot without local state dirs', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dtwl-project-'));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dtwl-workspace-'));
    fs.writeFileSync(path.join(projectRoot, 'README.md'), 'hello');
    fs.mkdirSync(path.join(projectRoot, '.omx'));
    fs.writeFileSync(path.join(projectRoot, '.omx', 'state.json'), '{}');

    const workspace = await prepareSessionWorkspace(workspaceRoot, 'snap1', projectRoot);

    expect(workspace.mode).toBe('snapshot-copy');
    expect(fs.readFileSync(path.join(workspace.rootDir, 'README.md'), 'utf8')).toBe('hello');
    expect(fs.existsSync(path.join(workspace.rootDir, '.omx'))).toBe(false);

    await cleanupSessionWorkspace(workspace);
  });

  it('creates a git worktree snapshot and overlays current uncommitted files', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dtwl-git-'));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dtwl-git-workspace-'));

    execFileSync('git', ['init', '-b', 'main'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 'test-user'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
    fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'node_modules/\n');
    fs.writeFileSync(path.join(repoRoot, 'tracked.txt'), 'base\n');
    fs.mkdirSync(path.join(repoRoot, '.omx'));
    fs.writeFileSync(path.join(repoRoot, '.omx', 'state.json'), '{}');
    execFileSync('git', ['add', '.gitignore', 'tracked.txt'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoRoot });
    fs.writeFileSync(path.join(repoRoot, 'tracked.txt'), 'modified\n');
    fs.writeFileSync(path.join(repoRoot, 'notes.txt'), 'untracked\n');
    fs.mkdirSync(path.join(repoRoot, 'node_modules', '.bin'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'node_modules', '.bin', 'tool'), 'ignored\n');

    const workspace = await prepareSessionWorkspace(workspaceRoot, 'git1', repoRoot);

    expect(workspace.mode).toBe('git-worktree');
    expect(fs.readFileSync(path.join(workspace.rootDir, 'tracked.txt'), 'utf8')).toBe('modified\n');
    expect(fs.readFileSync(path.join(workspace.rootDir, 'notes.txt'), 'utf8')).toBe('untracked\n');
    expect(fs.existsSync(path.join(workspace.rootDir, '.omx'))).toBe(false);
    expect(fs.existsSync(path.join(workspace.rootDir, 'node_modules'))).toBe(false);

    await cleanupSessionWorkspace(workspace);
  });
});

describe('cleanupSessionArtifacts', () => {
  it('removes runtime and snapshot workspace directories', async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dtwl-runtime-artifacts-'));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dtwl-workspace-artifacts-'));
    const runtimeDir = path.join(runtimeRoot, 'sess1');
    const workspaceDir = path.join(workspaceRoot, 'sess1');
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(runtimeDir, 'state.json'), '{}');
    fs.writeFileSync(path.join(workspaceDir, 'README.md'), 'hello');

    await cleanupSessionArtifacts({
      tmuxSessionName: 'pending',
      runtimeDir,
      workspaceDir,
      workspaceMode: 'snapshot-copy',
    });

    expect(fs.existsSync(runtimeDir)).toBe(false);
    expect(fs.existsSync(workspaceDir)).toBe(false);
  });
});

describe('buildLaunchCommand', () => {
  it('builds OMX launch with isolated CODEX_HOME and madmax', () => {
    const command = buildLaunchCommand('omx', { omcCliEntry: '' }, {
      rootDir: '/tmp/runtime/abc123',
      codexHomeDir: '/tmp/runtime/abc123/codex-home',
      claudeConfigDir: '/tmp/runtime/abc123/claude-config',
    });
    expect(command).toBe("env CODEX_HOME='/tmp/runtime/abc123/codex-home' omx --madmax");
  });

  it('builds OMC launch with isolated CLAUDE_CONFIG_DIR and madmax', () => {
    const command = buildLaunchCommand('omc', { omcCliEntry: '/tmp/omc/index.js' }, {
      rootDir: '/tmp/runtime/abc123',
      codexHomeDir: '/tmp/runtime/abc123/codex-home',
      claudeConfigDir: '/tmp/runtime/abc123/claude-config',
    });
    expect(command).toContain("env HOME='/tmp/runtime/abc123'");
    expect(command).toContain("CLAUDE_CONFIG_DIR='/tmp/runtime/abc123/claude-config'");
    expect(command).toContain("node '/tmp/omc/index.js' --madmax");
  });

  it('falls back to Claude with isolated CLAUDE_CONFIG_DIR when no OMC entry is configured', () => {
    const command = buildLaunchCommand('omc', { omcCliEntry: '' }, {
      rootDir: '/tmp/runtime/abc123',
      codexHomeDir: '/tmp/runtime/abc123/codex-home',
      claudeConfigDir: '/tmp/runtime/abc123/claude-config',
    });
    expect(command).toBe(
      "env HOME='/tmp/runtime/abc123' CLAUDE_CONFIG_DIR='/tmp/runtime/abc123/claude-config' claude --dangerously-skip-permissions",
    );
  });
});
