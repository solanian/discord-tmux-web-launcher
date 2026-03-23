import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import type { LaunchMode } from './config.js';

export interface SessionRecord {
  id: string;
  token: string;
  mode: LaunchMode;
  projectPath: string;
  workspaceDir?: string;
  workspaceMode?: 'git-worktree' | 'snapshot-copy';
  tmuxSessionName: string;
  launchCommand: string;
  createdAt: string;
  status: 'running' | 'stopped' | 'error';
  runtimeDir?: string;
}

interface StorePayload {
  sessions: SessionRecord[];
}

export class SessionStore {
  private readonly storePath: string;

  constructor(dataDir: string) {
    this.storePath = path.join(dataDir, 'sessions.json');
  }

  private read(): StorePayload {
    if (!fs.existsSync(this.storePath)) {
      return { sessions: [] };
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(this.storePath, 'utf8')) as StorePayload;
      return {
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      };
    } catch {
      return { sessions: [] };
    }
  }

  private write(payload: StorePayload): void {
    fs.writeFileSync(this.storePath, JSON.stringify(payload, null, 2));
  }

  create(record: Omit<SessionRecord, 'id' | 'token' | 'createdAt'>): SessionRecord {
    const payload = this.read();
    const session: SessionRecord = {
      id: crypto.randomBytes(4).toString('hex'),
      token: crypto.randomBytes(18).toString('hex'),
      createdAt: new Date().toISOString(),
      ...record,
    };
    payload.sessions.unshift(session);
    this.write(payload);
    return session;
  }

  all(): SessionRecord[] {
    return this.read().sessions;
  }

  getByToken(token: string): SessionRecord | undefined {
    return this.read().sessions.find((session) => session.token === token);
  }

  getById(id: string): SessionRecord | undefined {
    return this.read().sessions.find((session) => session.id === id);
  }

  update(session: SessionRecord): SessionRecord {
    const payload = this.read();
    const index = payload.sessions.findIndex((entry) => entry.id === session.id);
    if (index === -1) {
      throw new Error(`Unknown session id: ${session.id}`);
    }
    payload.sessions[index] = session;
    this.write(payload);
    return session;
  }

  updateStatus(id: string, status: SessionRecord['status']): SessionRecord | undefined {
    const payload = this.read();
    const session = payload.sessions.find((entry) => entry.id === id);
    if (!session) {
      return undefined;
    }
    session.status = status;
    this.write(payload);
    return session;
  }
}
