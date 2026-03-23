import http from 'node:http';

import { spawn as spawnPty } from 'node-pty';
import { WebSocketServer } from 'ws';

import type { AppConfig } from './config.js';
import type { SessionStore } from './store.js';
import { getPaneWorkingDirectory, sendInput, sessionExists } from './tmux.js';
import { createLogger } from './logger.js';

const logger = createLogger('WEB');

export function htmlPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>tmux web viewer</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css">
  <style>
    html, body { height: 100%; margin: 0; overflow: hidden; background: #0b1020; color: #e5e7eb; font-family: system-ui, sans-serif; }
    #root { display: flex; flex-direction: column; height: 100%; min-height: 0; }
    #bar { padding: 10px 14px; border-bottom: 1px solid #1f2937; background: #111827; font-size: 14px; }
    #terminal { flex: 1; min-height: 0; padding: 8px; overflow: hidden; }
    #composer { position: sticky; bottom: 0; z-index: 5; display: flex; flex-direction: column; gap: 8px; padding: 10px 12px calc(10px + env(safe-area-inset-bottom)); border-top: 1px solid #1f2937; background: #111827; box-shadow: 0 -8px 24px rgba(0,0,0,0.22); }
    #composerKeys { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; }
    .composerKey { min-height: 40px; padding: 8px 10px; border: 1px solid #374151; border-radius: 10px; background: #1f2937; color: #e5e7eb; font-size: 13px; font-weight: 600; cursor: pointer; touch-action: manipulation; }
    .composerKey:hover { background: #273449; }
    .composerKey:active { background: #334155; }
    #composerRow { display: flex; gap: 8px; }
    #composerInput { flex: 1; min-width: 0; min-height: 42px; padding: 10px 12px; border: 1px solid #374151; border-radius: 10px; background: #0f172a; color: #e5e7eb; font-size: 14px; }
    #composerInput:focus { outline: 2px solid #2563eb; outline-offset: 1px; border-color: #2563eb; }
    #composerSend { min-height: 42px; padding: 10px 14px; border: 0; border-radius: 10px; background: #2563eb; color: white; font-size: 14px; font-weight: 600; cursor: pointer; touch-action: manipulation; }
    #composerSend:hover { background: #1d4ed8; }
    .muted { color: #9ca3af; }
    @media (max-width: 720px) {
      #bar { padding: 8px 10px; font-size: 13px; }
      #terminal { padding: 4px; }
      #composer { gap: 10px; padding: 10px 10px calc(12px + env(safe-area-inset-bottom)); }
      #composerKeys { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .composerKey { min-height: 44px; font-size: 14px; }
      #composerRow { flex-direction: column; }
      #composerInput { min-height: 44px; font-size: 16px; }
      #composerSend { width: 100%; min-height: 44px; font-size: 15px; }
    }
  </style>
</head>
<body>
  <div id="root">
    <div id="bar">Connecting…</div>
    <div id="terminal"></div>
    <div id="composer">
      <div id="composerKeys">
        <button class="composerKey" data-key="esc" type="button">Esc</button>
        <button class="composerKey" data-key="enter" type="button">Enter</button>
        <button class="composerKey" data-key="backspace" type="button">BS</button>
        <button class="composerKey" data-key="tab" type="button">Tab</button>
        <button class="composerKey" data-key="ctrl-c" type="button">Ctrl+C</button>
      </div>
      <div id="composerRow">
        <input id="composerInput" type="text" placeholder="Send text to tmux and press Enter" autocomplete="off" />
        <button id="composerSend" type="button">Send</button>
      </div>
    </div>
  </div>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
  <script>
    const token = location.pathname.split('/').pop();
    const bar = document.getElementById('bar');
    const composerInput = document.getElementById('composerInput');
    const composerSend = document.getElementById('composerSend');
    const composerKeys = document.querySelectorAll('.composerKey');
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
    function sendComposerText() {
      const value = composerInput.value.trimEnd();
      if (!value || socket.readyState !== WebSocket.OPEN) {
        return;
      }
      socket.send(JSON.stringify({ type: 'sendText', data: value }));
      composerInput.value = '';
      term.focus();
    }
    function sendSpecialKey(keyName) {
      if (socket.readyState !== WebSocket.OPEN) {
        return;
      }
      socket.send(JSON.stringify({ type: 'sendKey', data: keyName }));
      term.focus();
    }
    composerSend.addEventListener('click', sendComposerText);
    composerInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        sendComposerText();
      }
    });
    composerKeys.forEach((button) => {
      button.addEventListener('click', () => {
        sendSpecialKey(button.dataset.key);
      });
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
            } else if (message.type === 'sendText' && typeof message.data === 'string') {
              void sendInput(session.tmuxSessionName, `${message.data}\r`).catch((error) => {
                logger.warn('sendText failed:', error);
              });
            } else if (message.type === 'sendKey' && typeof message.data === 'string') {
              const specialKeyMap: Record<string, string> = {
                esc: '\u001b',
                enter: '\r',
                backspace: '\u007f',
                tab: '\t',
                'ctrl-c': '\u0003',
              };
              const payload = specialKeyMap[message.data];
              if (payload) {
                void sendInput(session.tmuxSessionName, payload).catch((error) => {
                  logger.warn('sendKey failed:', error);
                });
              }
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
