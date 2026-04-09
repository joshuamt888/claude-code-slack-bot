import dotenv from 'dotenv';
import * as path from 'path';

// Load agent-specific .env.slack first, then fall back to repo .env
const agentEnvPath = process.env.AGENT_ENV_FILE;
if (agentEnvPath) {
  dotenv.config({ path: agentEnvPath });
}
dotenv.config();

export const config = {
  slack: {
    botToken: process.env.SLACK_BOT_TOKEN!,
    appToken: process.env.SLACK_APP_TOKEN!,
    signingSecret: process.env.SLACK_SIGNING_SECRET || '',
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY!,
  },
  claude: {
    useBedrock: process.env.CLAUDE_CODE_USE_BEDROCK === '1',
    useVertex: process.env.CLAUDE_CODE_USE_VERTEX === '1',
    // Per-agent model override. Set CLAUDE_MODEL in the agent's .env.slack
    // (e.g. CLAUDE_MODEL=claude-opus-4-6). Leave unset to use the CLI default.
    model: process.env.CLAUDE_MODEL || undefined,
  },
  agent: {
    name: process.env.AGENT_NAME || 'claude',
    dir: process.env.AGENT_DIR || '',
    channelId: process.env.AGENT_CHANNEL_ID || '',
    hubChannelId: process.env.AGENT_HUB_CHANNEL_ID || '',
  },
  baseDirectory: process.env.BASE_DIRECTORY || '',
  debug: process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development',
};

export function validateConfig() {
  const required = [
    'SLACK_BOT_TOKEN',
    'SLACK_APP_TOKEN',
  ];

  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  if (!config.agent.dir) {
    throw new Error('AGENT_DIR environment variable is required');
  }
}