import http from 'node:http';

import { spawn as spawnPty } from 'node-pty';
import { WebSocketServer } from 'ws';

import type { AppConfig } from './config.js';
import type { SessionStore } from './store.js';
import { getPaneWorkingDirectory, sessionExists } from './tmux.js';
import { createLogger } from './logger.js';

const logger = createLogger('WEB');

function htmlPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>tmux web viewer</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css">
  <style>
    html, body { height: 100%; margin: 0; background: #0b1020; color: #e5e7eb; font-family: system-ui, sans-serif; }
    #root { display: flex; flex-direction: column; height: 100%; }
    #bar { padding: 10px 14px; border-bottom: 1px solid #1f2937; background: #111827; font-size: 14px; }
    #terminal { flex: 1; padding: 8px; }
    .muted { color: #9ca3af; }
  </style>
</head>
<body>
  <div id="root">
    <div id="bar">Connecting…</div>
    <div id="terminal"></div>
  </div>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
  <script>
    const token = location.pathname.split('/').pop();
    const bar = document.getElementById('bar');
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'Menlo, Monaco, Consolas, monospace',
      fontSize: 14,
      scrollback: 5000,
      theme: { background: '#0b1020', foreground: '#e5e7eb' }
    });
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(document.getElementById('terminal'));
    fitAddon.fit();
    window.addEventListener('resize', () => {
      fitAddon.fit();
      socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    });
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(proto + '//' + location.host + '/ws/' + token);
    term.focus();
    term.onData((data) => {
      socket.send(JSON.stringify({ type: 'input', data }));
    });
    term.onResize(({ cols, rows }) => {
      socket.send(JSON.stringify({ type: 'resize', cols, rows }));
    });
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.type === 'session') {
        if (message.session) {
          bar.innerHTML = '<strong>' + message.session.mode.toUpperCase() + '</strong> · '
            + message.session.projectPath + ' · <span class="muted">' + message.session.tmuxSessionName + '</span>';
        }
      } else if (message.type === 'data') {
        term.write(message.data || '');
      } else if (message.type === 'error') {
        bar.textContent = 'Error: ' + message.message;
      } else if (message.type === 'exit') {
        bar.textContent = 'Session detached';
      }
    });
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    });
    socket.addEventListener('close', () => {
      bar.textContent = 'Disconnected';
    });
  </script>
</body>
</html>`;
}

function listPage(baseUrl: string, sessions: ReturnType<SessionStore['all']>): string {
  const items = sessions.map((session) => {
    const url = `${baseUrl.replace(/\/$/, '')}/view/${session.token}`;
    return `<li><strong>${session.id}</strong> · ${session.mode.toUpperCase()} · ${session.projectPath} · ${session.status} · <a href="${url}">${url}</a></li>`;
  }).join('');

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>tmux sessions</title></head>
<body>
  <h1>tmux sessions</h1>
  <ul>${items || '<li>No sessions</li>'}</ul>
</body>
</html>`;
}

export function createWebServer(config: AppConfig, store: SessionStore) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(listPage(config.baseUrl, store.all()));
      return;
    }

    if (url.pathname.startsWith('/view/')) {
      const token = url.pathname.slice('/view/'.length);
      const session = store.getByToken(token);
      if (!session) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Unknown session token');
        return;
      }

      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(htmlPage());
      return;
    }

    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sessions: store.all().length }));
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    if (!url.pathname.startsWith('/ws/')) {
      socket.destroy();
      return;
    }

    const token = url.pathname.slice('/ws/'.length);
    const session = store.getByToken(token);
    if (!session) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      let closed = false;

      void (async () => {
        if (!(await sessionExists(session.tmuxSessionName))) {
          ws.send(JSON.stringify({ type: 'error', message: 'tmux session no longer exists' }));
          ws.close();
          return;
        }

        const cwd = await getPaneWorkingDirectory(session.tmuxSessionName);
        const pty = spawnPty('tmux', ['attach-session', '-t', session.tmuxSessionName], {
          name: 'xterm-256color',
          cols: 120,
          rows: 36,
          cwd: cwd || session.projectPath,
          env: {
            ...process.env,
            TERM: 'xterm-256color',
          },
        });

        ws.send(JSON.stringify({ type: 'session', session }));

        pty.onData((data) => {
          if (!closed) {
            ws.send(JSON.stringify({ type: 'data', data }));
          }
        });

        pty.onExit(({ exitCode, signal }) => {
          if (!closed) {
            ws.send(JSON.stringify({ type: 'exit', exitCode, signal }));
            ws.close();
          }
        });

        ws.on('message', (raw) => {
          try {
            const message = JSON.parse(String(raw)) as {
              type: string;
              data?: string;
              cols?: number;
              rows?: number;
            };
            if (message.type === 'input' && typeof message.data === 'string') {
              pty.write(message.data);
            } else if (
              message.type === 'resize' &&
              typeof message.cols === 'number' &&
              typeof message.rows === 'number'
            ) {
              pty.resize(Math.max(20, Math.floor(message.cols)), Math.max(8, Math.floor(message.rows)));
            }
          } catch (error) {
            logger.warn('Ignoring malformed websocket message:', error);
          }
        });

        ws.on('close', () => {
          closed = true;
          try {
            pty.kill();
          } catch {}
        });
      })().catch((error) => {
        logger.error('PTY attach error:', error);
        if (!closed) {
          ws.send(JSON.stringify({ type: 'error', message: String(error) }));
          ws.close();
        }
      });
    });
  });

  return {
    start(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          logger.log(`Listening on ${config.host}:${config.port}`);
          resolve();
        });
      });
    },
    stop(): Promise<void> {
      return new Promise((resolve, reject) => {
        wss.close();
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}
