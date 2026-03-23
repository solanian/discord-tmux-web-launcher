import { describe, expect, it } from 'vitest';

import { htmlPage } from '../src/web.js';

describe('htmlPage', () => {
  it('renders the bottom composer UI, special key buttons, and websocket message paths', () => {
    const page = htmlPage();

    expect(page).toContain('id="composer"');
    expect(page).toContain('id="composerKeys"');
    expect(page).toContain('id="composerInput"');
    expect(page).toContain('id="composerSend"');
    expect(page).toContain('data-key="esc"');
    expect(page).toContain('data-key="enter"');
    expect(page).toContain('data-key="backspace"');
    expect(page).toContain('data-key="tab"');
    expect(page).toContain('data-key="ctrl-c"');
    expect(page).toContain("type: 'sendText'");
    expect(page).toContain("type: 'sendKey'");
    expect(page).toContain('Send text to tmux and press Enter');
  });
});
