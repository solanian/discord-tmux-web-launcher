import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadEnvFile } from '../src/config.js';
import {
  buildLaunchCommand,
  buildSessionRuntimePaths,
  ensureSessionRuntimePaths,
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
    const sharedCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dtwl-codex-'));
    const sharedClaudeConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'dtwl-claude-'));
    fs.writeFileSync(path.join(sharedCodexHome, 'auth.json'), '{"ok":true}');
    fs.writeFileSync(path.join(sharedCodexHome, 'config.toml'), 'model = "gpt-5.4"\n');
    fs.writeFileSync(path.join(sharedClaudeConfig, '.credentials.json'), '{"ok":true}');
    fs.writeFileSync(path.join(sharedClaudeConfig, 'settings.json'), '{"theme":"dark"}');

    const runtimePaths = ensureSessionRuntimePaths(buildSessionRuntimePaths(runtimeRoot, 'abc123'), {
      codexHomeDir: sharedCodexHome,
      claudeConfigDir: sharedClaudeConfig,
    });

    expect(fs.readlinkSync(path.join(runtimePaths.codexHomeDir, 'auth.json'))).toBe(
      path.join(sharedCodexHome, 'auth.json'),
    );
    expect(fs.readlinkSync(path.join(runtimePaths.claudeConfigDir, '.credentials.json'))).toBe(
      path.join(sharedClaudeConfig, '.credentials.json'),
    );
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
    expect(command).toContain("env CLAUDE_CONFIG_DIR='/tmp/runtime/abc123/claude-config'");
    expect(command).toContain("node '/tmp/omc/index.js' --madmax");
  });

  it('falls back to Claude with isolated CLAUDE_CONFIG_DIR when no OMC entry is configured', () => {
    const command = buildLaunchCommand('omc', { omcCliEntry: '' }, {
      rootDir: '/tmp/runtime/abc123',
      codexHomeDir: '/tmp/runtime/abc123/codex-home',
      claudeConfigDir: '/tmp/runtime/abc123/claude-config',
    });
    expect(command).toBe(
      "env CLAUDE_CONFIG_DIR='/tmp/runtime/abc123/claude-config' claude --dangerously-skip-permissions",
    );
  });
});
