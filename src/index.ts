#!/usr/bin/env node

import { getConfig } from './config.js';
import { createLogger } from './logger.js';
import { SessionStore } from './store.js';
import { createWebServer } from './web.js';
import { createBot } from './bot.js';
import { ensureTmuxInstalled } from './tmux.js';

const logger = createLogger('MAIN');

async function main(): Promise<void> {
  const config = getConfig();
  ensureTmuxInstalled();

  const store = new SessionStore(config.dataDir);
  const web = createWebServer(config, store);
  await web.start();
  await createBot(config, store);

  logger.log(`Web viewer available at ${config.baseUrl}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
