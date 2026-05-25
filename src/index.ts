import { App } from '@slack/bolt';
import { config, validateConfig } from './config';
import { ClaudeHandler } from './claude-handler';
import { ClaudeHandlerRepl } from './claude-handler-repl';
import { SlackHandler } from './slack-handler';
import { McpManager } from './mcp-manager';
import { Logger } from './logger';

const logger = new Logger('Main');

async function start() {
  try {
    validateConfig();

    const agentName = config.agent.name;
    const handlerMode = config.claude.handlerMode;
    logger.info(`Starting ${agentName} agent`, {
      agentDir: config.agent.dir,
      debug: config.debug,
      handlerMode,
    });

    const app = new App({
      token: config.slack.botToken,
      signingSecret: config.slack.signingSecret || undefined,
      socketMode: true,
      appToken: config.slack.appToken,
    });

    const mcpManager = new McpManager();
    mcpManager.loadConfiguration();

    const claudeHandler = handlerMode === 'repl'
      ? new ClaudeHandlerRepl(mcpManager)
      : new ClaudeHandler(mcpManager);
    logger.info(`Using ${handlerMode === 'repl' ? 'REPL' : 'SDK'} handler`);
    const slackHandler = new SlackHandler(app, claudeHandler as any, mcpManager);

    slackHandler.setupEventHandlers();

    await app.start();
    logger.info(`⚡️ ${agentName} is online!`);
  } catch (error) {
    logger.error('Failed to start the bot', error);
    process.exit(1);
  }
}

start();