import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ConversationSession } from './types';
import { Logger } from './logger';
import { McpManager, McpServerConfig } from './mcp-manager';
import { config } from './config';
import * as path from 'path';
import * as fs from 'fs';

const SESSIONS_FILE = path.join(__dirname, '..', `sessions-${config.agent.name}.json`);

export class ClaudeHandler {
  private sessions: Map<string, ConversationSession> = new Map();
  private logger = new Logger('ClaudeHandler');
  private mcpManager: McpManager;

  constructor(mcpManager: McpManager) {
    this.mcpManager = mcpManager;
    this.loadSessions();
  }

  private loadSessions(): void {
    try {
      if (fs.existsSync(SESSIONS_FILE)) {
        const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
        for (const [key, session] of Object.entries(data)) {
          const s = session as any;
          s.lastActivity = new Date(s.lastActivity);
          this.sessions.set(key, s as ConversationSession);
        }
        this.logger.info(`Loaded ${this.sessions.size} sessions from disk`);
      }
    } catch (err) {
      this.logger.error('Failed to load sessions from disk', err);
    }
  }

  private saveSessions(): void {
    try {
      const data: Record<string, any> = {};
      for (const [key, session] of this.sessions.entries()) {
        data[key] = session;
      }
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
      this.logger.error('Failed to save sessions to disk', err);
    }
  }

  getSessionKey(userId: string, channelId: string, threadTs?: string): string {
    return `${userId}-${channelId}-${threadTs || 'direct'}`;
  }

  getSession(userId: string, channelId: string, threadTs?: string): ConversationSession | undefined {
    return this.sessions.get(this.getSessionKey(userId, channelId, threadTs));
  }

  createSession(userId: string, channelId: string, threadTs?: string): ConversationSession {
    const session: ConversationSession = {
      userId,
      channelId,
      threadTs,
      isActive: true,
      lastActivity: new Date(),
      turns: 0,
    };
    this.sessions.set(this.getSessionKey(userId, channelId, threadTs), session);
    this.saveSessions();
    return session;
  }

  checkAndResetSession(userId: string, channelId: string, threadTs?: string): ConversationSession | undefined {
    return this.sessions.get(this.getSessionKey(userId, channelId, threadTs));
  }

  async *streamQuery(
    prompt: string,
    session?: ConversationSession,
    abortController?: AbortController,
    workingDirectory?: string,
    slackContext?: { channel: string; threadTs?: string; user: string }
  ): AsyncGenerator<SDKMessage, void, unknown> {
    const options: any = {
      outputFormat: 'stream-json',
      permissionMode: 'bypassPermissions',
    };

    // Per-agent model override (set via CLAUDE_MODEL in the agent's .env.slack)
    if (config.claude.model) {
      options.model = config.claude.model;
    }

    if (workingDirectory) {
      options.cwd = workingDirectory;
    }

    // Add MCP server configuration if available
    const mcpServers = this.mcpManager.getServerConfiguration();
    
    if (mcpServers && Object.keys(mcpServers).length > 0) {
      options.mcpServers = mcpServers;
    }
    
    if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
      const defaultMcpTools = this.mcpManager.getDefaultAllowedTools();
      if (defaultMcpTools.length > 0) {
        options.allowedTools = defaultMcpTools;
      }
      
      this.logger.debug('Added MCP configuration to options', {
        serverCount: Object.keys(options.mcpServers).length,
        servers: Object.keys(options.mcpServers),
        allowedTools: defaultMcpTools,
        hasSlackContext: !!slackContext,
      });
    }

    if (session?.sessionId) {
      options.resume = session.sessionId;
      this.logger.debug('Resuming session', { sessionId: session.sessionId });
    } else {
      this.logger.debug('Starting new Claude conversation');
    }

    this.logger.debug('Claude query options', options);

    // Use the LOCAL bundled Claude CLI from node_modules (isolates the bot from
    // whatever version is globally installed — global upgrades won't affect us).
    options.pathToClaudeCodeExecutable = path.join(
      __dirname,
      '..',
      'node_modules',
      '@anthropic-ai',
      'claude-code',
      'cli.js',
    );

    try {
      for await (const message of query({
        prompt,
        abortController: abortController || new AbortController(),
        options,
      })) {
        if (message.type === 'system' && message.subtype === 'init') {
          if (session) {
            session.sessionId = message.session_id;
            this.saveSessions();
            this.logger.info('Session initialized', {
              sessionId: message.session_id,
              model: (message as any).model,
              tools: (message as any).tools?.length || 0,
            });
          }
        }
        yield message;
      }
    } catch (error) {
      this.logger.error('Error in Claude query', error);
      throw error;
    }
  }

  resetSession(userId: string, channelId: string, threadTs?: string): void {
    const key = this.getSessionKey(userId, channelId, threadTs);
    this.sessions.delete(key);
    this.saveSessions();
    this.logger.info('Session reset', { key });
  }

  cleanupInactiveSessions() {
    // Sessions live forever - auto-compress handles long conversations
  }
}