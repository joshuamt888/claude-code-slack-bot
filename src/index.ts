import { App } from '@slack/bolt';
import { config, validateConfig } from './config';
import { ClaudeHandler } from './claude-handler';
import { SlackHandler } from './slack-handler';
import { McpManager } from './mcp-manager';
import { Logger } from './logger';

const logger = new Logger('Main');

async function start() {
  try {
    validateConfig();

    const agentName = config.agent.name;
    logger.info(`Starting ${agentName} agent`, {
      agentDir: config.agent.dir,
      debug: config.debug,
    });

    const app = new App({
      token: config.slack.botToken,
      signingSecret: config.slack.signingSecret || undefined,
      socketMode: true,
      appToken: config.slack.appToken,
    });

    const mcpManager = new McpManager();
    mcpManager.loadConfiguration();

    const claudeHandler = new ClaudeHandler(mcpManager);
    const slackHandler = new SlackHandler(app, claudeHandler, mcpManager);

    slackHandler.setupEventHandlers();

    await app.start();
    logger.info(`⚡️ ${agentName} is online!`);
  } catch (error) {
    logger.error('Failed to start the bot', error);
    process.exit(1);
  }
}

start();