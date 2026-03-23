import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type LaunchMode = 'omx' | 'omc';

export interface AppConfig {
  discordBotToken: string;
  host: string;
  port: number;
  baseUrl: string;
  dataDir: string;
  allowedRoots: string[];
  omcCliEntry: string;
  sessionPrefix: string;
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function parseInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function defaultDataDir(): string {
  return path.join(os.homedir(), '.discord-tmux-web-launcher');
}

export function loadEnvFile(envPath = path.resolve(process.cwd(), '.env')): void {
  if (!fs.existsSync(envPath)) {
    return;
  }

  const content = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

export function parseAllowedRoots(raw: string | undefined): string[] {
  const roots = (raw ?? '/home/dsseo/workspace')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => path.resolve(entry));

  return [...new Set(roots)];
}

function resolveDefaultOmcCliEntry(): string {
  const explicit = process.env['OMC_CLI_ENTRY'];
  if (explicit?.trim()) {
    return path.resolve(explicit.trim());
  }
  return '';
}

export function getConfig(): AppConfig {
  loadEnvFile();

  const discordBotToken = process.env['DISCORD_BOT_TOKEN'];
  if (!discordBotToken) {
    throw new Error('DISCORD_BOT_TOKEN environment variable is required');
  }

  const dataDir = path.resolve(process.env['DATA_DIR'] || defaultDataDir());
  ensureDir(dataDir);

  return {
    discordBotToken,
    host: process.env['HOST'] || '0.0.0.0',
    port: parseInteger(process.env['PORT'], 8787),
    baseUrl: process.env['BASE_URL'] || 'http://localhost:8787',
    dataDir,
    allowedRoots: parseAllowedRoots(process.env['ALLOWED_PROJECT_ROOTS']),
    omcCliEntry: resolveDefaultOmcCliEntry(),
    sessionPrefix: process.env['SESSION_PREFIX'] || 'dtwl',
  };
}
