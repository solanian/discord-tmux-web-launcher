# Discord tmux web launcher

[![Release](https://img.shields.io/github/v/release/solanian/discord-tmux-web-launcher?display_name=tag)](https://github.com/solanian/discord-tmux-web-launcher/releases)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-5FA04E?logo=node.js&logoColor=white)](https://nodejs.org/)
[![discord.js](https://img.shields.io/badge/discord.js-14-5865F2?logo=discord&logoColor=white)](https://discord.js.org/)

Discord에서 `omx`/`omc` 실행 대상 폴더를 지정하면 새 tmux session을 만들고, xterm.js 웹 화면으로 그 세션을 볼 수 있게 해주는 독립 프로젝트입니다.

## 기능

- Discord slash command `/launch` 로 실행 모드와 폴더 경로 지정
- `/launch` 는 Discord interaction timeout 을 피하기 위해 먼저 defer 응답한 뒤 session 준비를 계속 진행
- 지정된 경로에서 tmux session 생성 후 `omx` 또는 `omc` 실행
- 세션별 웹 URL 발급
- `/launch` session마다 전용 런타임 디렉터리를 사용해 `CODEX_HOME` / `CLAUDE_CONFIG_DIR` 컨텍스트 분리
- `/launch` session마다 전용 workspace 디렉터리에서 실행해 프로젝트 로컬 `.omx` / `.claude` / `.omc` 상태도 분리
- 인증 정보는 세션마다 새로 만들지 않고 기존 사용자 홈 auth 파일을 심볼릭 링크로 재사용
- xterm.js 화면에서 `tmux attach-session` 을 raw PTY로 직접 표시
- 웹에서 입력/리사이즈를 PTY로 직접 전달
- 웹페이지 하단의 Enter 전송형 입력창에서 `tmux send-keys` 기반 텍스트 전송 지원
- 하단 특수키 버튼(`Esc`, `Enter`, `BS`, `Tab`, `Ctrl+C`) 제공
- 하단 composer 는 sticky 하단 바와 모바일 레이아웃을 사용해 작은 화면에서도 보조 입력이 보이도록 구성
- `/sessions`, `/stop` 명령으로 상태 조회/종료

## 주의

- 웹 접속 시마다 `tmux attach-session` 을 붙이는 PTY 하나가 새로 생성됩니다.
- `omx` 는 `--madmax` 로 실행됩니다.
- `omc` 는 기본적으로 `claude --dangerously-skip-permissions` 로 실행되며, 필요하면 `OMC_CLI_ENTRY`로 별도 엔트리를 지정할 수 있습니다.
- 세션별 런타임 격리는 `DATA_DIR/runtime/<session-id>/` 아래에서 관리됩니다.
- 세션별 workspace 격리는 `DATA_DIR/workspaces/<session-id>/` 아래에서 관리됩니다.
- git 저장소는 `git worktree` 기반, 일반 디렉터리는 snapshot copy 기반으로 분리됩니다.
- auth 정보는 `~/.codex/auth.json`, `~/.claude/.credentials.json` 같은 공유 자산을 유지합니다.
- 경로는 allowlist 루트 하위 디렉터리만 허용합니다.

## 환경 변수

- `DISCORD_BOT_TOKEN`: 필수
- `PORT`: 웹 서버 포트, 기본 `8787`
- `HOST`: 기본 `0.0.0.0`
- `BASE_URL`: Discord에 돌려줄 웹 링크 베이스 URL
- `DATA_DIR`: 세션 메타데이터 저장 위치, 기본 `~/.discord-tmux-web-launcher`
- `ALLOWED_PROJECT_ROOTS`: 쉼표 구분 allowlist, 기본 `$HOME/workspace`
- `OMC_CLI_ENTRY`: 선택 사항. 설정하면 `node <entry> --madmax` 로 OMC CLI 엔트리를 직접 실행
- `SESSION_PREFIX`: tmux session 이름 접두어, 기본 `dtwl`

## 실행

```bash
npm install
npm run build
npm start
```

개발 모드:

```bash
npm run dev
```

## Discord 명령

- `/launch mode:<omx|omc> path:<absolute-path>`
- `/sessions`
- `/stop id:<session-id>`

## 웹 화면

`/launch` 성공 시 Discord에 `/view/<token>` 링크가 반환됩니다.

이 페이지는:

- xterm.js 와 WebSocket 을 통해 PTY에 직접 연결되고
- 서버는 `tmux attach-session` 프로세스를 PTY로 실행합니다.
