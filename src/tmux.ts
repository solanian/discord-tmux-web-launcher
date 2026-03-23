import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';

import type { AppConfig, LaunchMode } from './config.js';

const execFileAsync = promisify(execFile);

export interface LaunchSessionParams {
  sessionPrefix: string;
  sessionId: string;
  mode: LaunchMode;
  projectPath: string;
  runtimeRootDir: string;
}

export interface SessionRuntimePaths {
  rootDir: string;
  codexHomeDir: string;
  claudeConfigDir: string;
}

interface SharedRuntimeHomes {
  codexHomeDir: string;
  claudeConfigDir: string;
}

const SHARED_CODEX_ENTRIES = [
  'auth.json',
  'config.toml',
  'AGENTS.md',
  '.omx-config.json',
  'prompts',
  'agents',
  'skills',
  'rules',
];

const SHARED_CLAUDE_ENTRIES = [
  '.credentials.json',
  'settings.json',
  'settings.local.json',
  '.omc-config.json',
  'CLAUDE.md',
  'hooks',
  'agents',
  'commands',
  'plugins',
  'mcp_servers.json',
  'mcp-needs-auth-cache.json',
];

export function ensureTmuxInstalled(): void {
  const result = spawnSync('tmux', ['-V'], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error('tmux is required but was not found in PATH');
  }
}

export function validateProjectPath(inputPath: string, allowedRoots: string[]): string {
  if (!path.isAbsolute(inputPath)) {
    throw new Error('Project path must be an absolute path');
  }
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Directory does not exist: ${inputPath}`);
  }
  const stats = fs.statSync(inputPath);
  if (!stats.isDirectory()) {
    throw new Error(`Path is not a directory: ${inputPath}`);
  }

  const resolvedPath = fs.realpathSync(inputPath);
  const resolvedRoots = allowedRoots.map((root) => fs.realpathSync(root));
  const isAllowed = resolvedRoots.some((root) => {
    return resolvedPath === root || resolvedPath.startsWith(`${root}${path.sep}`);
  });

  if (!isAllowed) {
    throw new Error(`Path is outside allowed roots: ${resolvedPath}`);
  }

  return resolvedPath;
}

export function buildTmuxSessionName(prefix: string, id: string, mode: LaunchMode): string {
  return `${prefix}-${mode}-${id}`.replace(/[^a-zA-Z0-9_-]/g, '-');
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function buildEnvPrefix(envVars: Record<string, string>): string {
  const entries = Object.entries(envVars);
  if (entries.length === 0) {
    return '';
  }

  return `env ${entries.map(([key, value]) => `${key}=${quoteShellArg(value)}`).join(' ')} `;
}

export function buildSessionRuntimePaths(runtimeRootDir: string, sessionId: string): SessionRuntimePaths {
  const rootDir = path.join(runtimeRootDir, sessionId);
  return {
    rootDir,
    codexHomeDir: path.join(rootDir, 'codex-home'),
    claudeConfigDir: path.join(rootDir, 'claude-config'),
  };
}

function resolveSharedRuntimeHomes(): SharedRuntimeHomes {
  return {
    codexHomeDir: process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
  };
}

function linkSharedEntry(sharedRoot: string, sessionRoot: string, name: string): void {
  const sharedPath = path.join(sharedRoot, name);
  const sessionPath = path.join(sessionRoot, name);
  if (!fs.existsSync(sharedPath) || fs.existsSync(sessionPath)) {
    return;
  }

  const stats = fs.lstatSync(sharedPath);
  fs.symlinkSync(sharedPath, sessionPath, stats.isDirectory() ? 'dir' : 'file');
}

function seedSessionRuntimePaths(runtimePaths: SessionRuntimePaths, sharedHomes: SharedRuntimeHomes): void {
  for (const name of SHARED_CODEX_ENTRIES) {
    linkSharedEntry(sharedHomes.codexHomeDir, runtimePaths.codexHomeDir, name);
  }

  for (const name of SHARED_CLAUDE_ENTRIES) {
    linkSharedEntry(sharedHomes.claudeConfigDir, runtimePaths.claudeConfigDir, name);
  }
}

export function ensureSessionRuntimePaths(
  runtimePaths: SessionRuntimePaths,
  sharedHomes: SharedRuntimeHomes = resolveSharedRuntimeHomes(),
): SessionRuntimePaths {
  fs.mkdirSync(runtimePaths.codexHomeDir, { recursive: true });
  fs.mkdirSync(runtimePaths.claudeConfigDir, { recursive: true });
  seedSessionRuntimePaths(runtimePaths, sharedHomes);
  return runtimePaths;
}

export function buildLaunchCommand(
  mode: LaunchMode,
  config: Pick<AppConfig, 'omcCliEntry'>,
  runtimePaths: SessionRuntimePaths,
): string {
  if (mode === 'omx') {
    return `${buildEnvPrefix({ CODEX_HOME: runtimePaths.codexHomeDir })}omx --madmax`;
  }

  const baseCommand = config.omcCliEntry
    ? `node ${quoteShellArg(config.omcCliEntry)} --madmax`
    : 'claude --dangerously-skip-permissions';

  return `${buildEnvPrefix({ CLAUDE_CONFIG_DIR: runtimePaths.claudeConfigDir })}${baseCommand}`;
}

async function tmux(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('tmux', args, { encoding: 'utf8' });
  return stdout;
}

async function getPrimaryPaneTarget(tmuxSessionName: string): Promise<string> {
  const stdout = await tmux(['list-panes', '-t', tmuxSessionName, '-F', '#{pane_id}']);
  const paneId = stdout
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);

  if (!paneId) {
    throw new Error(`No pane found for tmux session: ${tmuxSessionName}`);
  }

  return paneId;
}

export async function createTmuxSession(
  params: LaunchSessionParams,
  config: Pick<AppConfig, 'omcCliEntry'>,
): Promise<{ tmuxSessionName: string; launchCommand: string; runtimePaths: SessionRuntimePaths }> {
  const tmuxSessionName = buildTmuxSessionName(params.sessionPrefix, params.sessionId, params.mode);
  const runtimePaths = ensureSessionRuntimePaths(
    buildSessionRuntimePaths(params.runtimeRootDir, params.sessionId),
  );
  const launchCommand = buildLaunchCommand(params.mode, config, runtimePaths);

  await tmux(['new-session', '-d', '-s', tmuxSessionName, '-c', params.projectPath]);
  const paneTarget = await getPrimaryPaneTarget(tmuxSessionName);
  await tmux(['send-keys', '-t', paneTarget, launchCommand, 'Enter']);

  return { tmuxSessionName, launchCommand, runtimePaths };
}

export async function sessionExists(tmuxSessionName: string): Promise<boolean> {
  try {
    await tmux(['has-session', '-t', tmuxSessionName]);
    return true;
  } catch {
    return false;
  }
}

export async function stopTmuxSession(tmuxSessionName: string): Promise<void> {
  await tmux(['kill-session', '-t', tmuxSessionName]);
}

export async function capturePane(tmuxSessionName: string, lines: number): Promise<string> {
  const start = `-${Math.max(50, lines)}`;
  const paneTarget = await getPrimaryPaneTarget(tmuxSessionName);
  return tmux(['capture-pane', '-p', '-t', paneTarget, '-S', start]);
}

type InputPart =
  | { type: 'literal'; value: string }
  | { type: 'key'; value: string };

const SEQUENCE_MAP = new Map<string, string>([
  ['\r', 'Enter'],
  ['\n', 'Enter'],
  ['\t', 'Tab'],
  ['\u007f', 'BSpace'],
  ['\u001b[A', 'Up'],
  ['\u001b[B', 'Down'],
  ['\u001b[C', 'Right'],
  ['\u001b[D', 'Left'],
  ['\u001b[3~', 'Delete'],
  ['\u001b[H', 'Home'],
  ['\u001b[F', 'End'],
  ['\u001b[5~', 'PageUp'],
  ['\u001b[6~', 'PageDown'],
]);

export function splitInput(data: string): InputPart[] {
  const parts: InputPart[] = [];
  let literal = '';
  let index = 0;
  const knownSequences = [...SEQUENCE_MAP.keys()].sort((a, b) => b.length - a.length);

  function flushLiteral() {
    if (literal) {
      parts.push({ type: 'literal', value: literal });
      literal = '';
    }
  }

  while (index < data.length) {
    const sequence = knownSequences.find((candidate) => data.startsWith(candidate, index));
    if (sequence) {
      flushLiteral();
      parts.push({ type: 'key', value: SEQUENCE_MAP.get(sequence)! });
      index += sequence.length;
      continue;
    }

    const char = data[index];
    const code = char.charCodeAt(0);
    if (code >= 1 && code <= 26) {
      flushLiteral();
      parts.push({ type: 'key', value: `C-${String.fromCharCode(code + 96)}` });
      index += 1;
      continue;
    }

    literal += char;
    index += 1;
  }

  flushLiteral();
  return parts;
}

export async function sendInput(tmuxSessionName: string, data: string): Promise<void> {
  const paneTarget = await getPrimaryPaneTarget(tmuxSessionName);
  for (const part of splitInput(data)) {
    if (part.type === 'literal') {
      await tmux(['send-keys', '-t', paneTarget, '-l', '--', part.value]);
    } else {
      await tmux(['send-keys', '-t', paneTarget, part.value]);
    }
  }
}

export async function getPaneWorkingDirectory(tmuxSessionName: string): Promise<string> {
  return (await tmux(['display-message', '-p', '-t', tmuxSessionName, '#{pane_current_path}'])).trim();
}
