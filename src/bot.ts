import {
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Interaction,
} from 'discord.js';
import path from 'node:path';

import type { AppConfig, LaunchMode } from './config.js';
import { SessionStore } from './store.js';
import { createLogger } from './logger.js';
import {
  cleanupSessionWorkspace,
  createTmuxSession,
  ensureTmuxInstalled,
  stopTmuxSession,
  validateProjectPath,
} from './tmux.js';

const logger = createLogger('BOT');

function buildCommands() {
  return [
    new SlashCommandBuilder()
      .setName('launch')
      .setDescription('Create a new OMX/OMC tmux session and return a web viewer URL')
      .addStringOption((option) =>
        option
          .setName('mode')
          .setDescription('Launch mode')
          .setRequired(true)
          .addChoices(
            { name: 'omx', value: 'omx' },
            { name: 'omc', value: 'omc' },
          ),
      )
      .addStringOption((option) =>
        option
          .setName('path')
          .setDescription('Absolute project path')
          .setRequired(true),
      ),
    new SlashCommandBuilder()
      .setName('sessions')
      .setDescription('List known tmux web sessions'),
    new SlashCommandBuilder()
      .setName('stop')
      .setDescription('Stop a tmux web session')
      .addStringOption((option) =>
        option
          .setName('id')
          .setDescription('Session id returned by /launch')
          .setRequired(true),
      ),
  ];
}

async function registerSlashCommands(client: Client<true>) {
  const rest = new REST().setToken(client.token);
  const body = buildCommands().map((command) => command.toJSON());

  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: [] });
  } catch {}

  for (const guild of client.guilds.cache.values()) {
    await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body });
    logger.log(`Registered slash commands in guild ${guild.name}`);
  }
}

async function handleLaunch(interaction: ChatInputCommandInteraction, config: AppConfig, store: SessionStore) {
  const mode = interaction.options.getString('mode', true) as LaunchMode;
  const requestedPath = interaction.options.getString('path', true);
  let sessionId: string | undefined;

  try {
    ensureTmuxInstalled();
    const projectPath = validateProjectPath(requestedPath, config.allowedRoots);
    const session = store.create({
      mode,
      projectPath,
      workspaceDir: '',
      workspaceMode: 'snapshot-copy',
      tmuxSessionName: 'pending',
      launchCommand: mode,
      status: 'running',
    });
    sessionId = session.id;
    const created = await createTmuxSession({
      sessionPrefix: config.sessionPrefix,
      sessionId: session.id,
      mode,
      projectPath,
      runtimeRootDir: path.join(config.dataDir, 'runtime'),
      workspaceRootDir: path.join(config.dataDir, 'workspaces'),
    }, config);
    const updated = store.getById(session.id)!;
    updated.tmuxSessionName = created.tmuxSessionName;
    updated.launchCommand = created.launchCommand;
    updated.runtimeDir = created.runtimePaths.rootDir;
    updated.workspaceDir = created.workspace.rootDir;
    updated.workspaceMode = created.workspace.mode;
    store.update(updated);

    const url = `${config.baseUrl.replace(/\/$/, '')}/view/${updated.token}`;
    await interaction.reply({
      ephemeral: true,
      content: [
        `Created **${mode.toUpperCase()}** session.`,
        `- id: \`${updated.id}\``,
        `- path: \`${projectPath}\``,
        `- workspace: \`${updated.workspaceDir}\``,
        `- tmux: \`${updated.tmuxSessionName}\``,
        `- runtime: \`${updated.runtimeDir}\``,
        `- web: ${url}`,
      ].join('\n'),
    });
  } catch (error) {
    if (sessionId) {
      store.updateStatus(sessionId, 'error');
    }
    const message = error instanceof Error ? error.message : String(error);
    await interaction.reply({
      ephemeral: true,
      content: `Launch failed: ${message}`,
    });
  }
}

async function handleSessions(interaction: ChatInputCommandInteraction, config: AppConfig, store: SessionStore) {
  const sessions = store.all().slice(0, 10);
  if (sessions.length === 0) {
    await interaction.reply({ ephemeral: true, content: 'No sessions found.' });
    return;
  }

  const lines = sessions.map((session) => {
    const url = `${config.baseUrl.replace(/\/$/, '')}/view/${session.token}`;
    return `- \`${session.id}\` [${session.status}] ${session.mode.toUpperCase()} ${session.projectPath} → ${url}`;
  });

  await interaction.reply({ ephemeral: true, content: lines.join('\n') });
}

async function handleStop(interaction: ChatInputCommandInteraction, store: SessionStore) {
  const id = interaction.options.getString('id', true);
  const session = store.getById(id);
  if (!session) {
    await interaction.reply({ ephemeral: true, content: `Unknown session id: ${id}` });
    return;
  }

  try {
    await stopTmuxSession(session.tmuxSessionName);
  } catch {}
  if (session.workspaceDir && session.workspaceMode) {
    await cleanupSessionWorkspace({
      rootDir: session.workspaceDir,
      launchDir: session.workspaceDir,
      mode: session.workspaceMode,
    }).catch(() => {});
  }
  store.updateStatus(id, 'stopped');
  await interaction.reply({ ephemeral: true, content: `Stopped session \`${id}\`.` });
}

async function handleInteraction(interaction: Interaction, config: AppConfig, store: SessionStore) {
  if (!interaction.isChatInputCommand()) {
    return;
  }

  switch (interaction.commandName) {
    case 'launch':
      await handleLaunch(interaction, config, store);
      break;
    case 'sessions':
      await handleSessions(interaction, config, store);
      break;
    case 'stop':
      await handleStop(interaction, store);
      break;
    default:
      await interaction.reply({ ephemeral: true, content: 'Unknown command' });
  }
}

export async function createBot(config: AppConfig, store: SessionStore): Promise<Client> {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  client.once(Events.ClientReady, async (readyClient) => {
    logger.log(`Logged in as ${readyClient.user.tag}`);
    await registerSlashCommands(readyClient);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      await handleInteraction(interaction, config, store);
    } catch (error) {
      logger.error('Interaction error:', error);
      if (interaction.isRepliable() && !interaction.replied) {
        await interaction.reply({
          ephemeral: true,
          content: `Command failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  });

  client.on(Events.Error, (error) => {
    logger.error('Discord client error:', error);
  });

  await client.login(config.discordBotToken);
  return client;
}
