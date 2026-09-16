import { App } from '@slack/bolt';
import * as http from 'http';
import { config, validateConfig } from './config';
import { ClaudeHandler } from './claude-handler';
import { ClaudeHandlerRepl } from './claude-handler-repl';
import { SlackHandler } from './slack-handler';
import { McpManager } from './mcp-manager';
import { Logger } from './logger';

// Josh's Slack user ID — used to attribute internally-triggered messages
// (e.g. from the Pocket voice webhook) as coming from him.
const JOSH_SLACK_USER_ID = 'U0ARU06HVEV';

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

    // Internal trigger listener — 127.0.0.1 only, never exposed off-box.
    // Lets local automations (e.g. the Pocket voice webhook receiver) inject
    // a message into this agent's own pipeline exactly as if Josh had typed
    // it in Slack, without needing Slack API tricks to bypass the bot_id filter.
    if (config.agent.internalTriggerPort) {
      http.createServer((req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(404);
          res.end();
          return;
        }
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', async () => {
          try {
            // thread_ts (optional): post into an existing thread so the handler resumes that
            // thread's session — the SMS lane uses one thread per "terminal" (2026-09-16).
            const { text, channelContext, thread_ts: threadTs } = JSON.parse(body);
            if (!text || typeof text !== 'string') {
              res.writeHead(400);
              res.end('Missing "text"');
              return;
            }
            const channel = config.agent.channelId;
            if (!channel) {
              res.writeHead(500);
              res.end('AGENT_CHANNEL_ID not configured');
              return;
            }

            logger.info('Internal trigger received', { textPreview: text.slice(0, 100) });

            // Post a REAL message to Slack first so there's an actual message to
            // thread replies under. A fabricated fake ts causes Slack API calls
            // (reactions, thread replies) to fail with message_not_found, and
            // means nothing ever lands in a real thread Josh can continue.
            const posted = await app.client.chat.postMessage({ channel, text, ...(threadTs ? { thread_ts: threadTs } : {}) });
            const ts = posted.ts as string;
            const replyTs = threadTs || ts;

            const say = async (opts: any) => {
              const payload = typeof opts === 'string' ? { text: opts } : opts;
              return app.client.chat.postMessage({ channel, thread_ts: replyTs, ...payload });
            };

            await slackHandler.handleMessage({
              user: JOSH_SLACK_USER_ID,
              channel,
              ts,
              ...(threadTs ? { thread_ts: threadTs } : {}),
              text,
              channelContext: channelContext || '[Channel: your private channel | User: josh (via Pocket voice trigger)]',
            } as any, say);

            res.writeHead(200);
            res.end('ok');
          } catch (err) {
            logger.error('Internal trigger failed', err);
            res.writeHead(500);
            res.end(String(err));
          }
        });
      }).listen(config.agent.internalTriggerPort, '127.0.0.1', () => {
        logger.info(`Internal trigger listener on 127.0.0.1:${config.agent.internalTriggerPort}`);
      });
    }
  } catch (error) {
    logger.error('Failed to start the bot', error);
    process.exit(1);
  }
}

start();