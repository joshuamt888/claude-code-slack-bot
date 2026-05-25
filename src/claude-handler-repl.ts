/**
 * claude-handler-repl.ts
 *
 * Alternative Claude handler that spawns the Claude Code CLI in interactive
 * REPL mode (no -p flag) with structured JSON I/O. This keeps usage on the
 * interactive subscription pool instead of the SDK credit pool.
 *
 * Approach: spawn `claude --output-format stream-json --input-format stream-json`
 * and communicate via stdin/stdout NDJSON protocol — same as Code Quest does.
 *
 * Drop-in replacement for ClaudeHandler — same public API so SlackHandler
 * doesn't need any changes.
 */

import { spawn, ChildProcess } from 'child_process';
import { ConversationSession } from './types';
import { Logger } from './logger';
import { McpManager } from './mcp-manager';
import { config } from './config';
import * as path from 'path';
import * as fs from 'fs';
import * as readline from 'readline';

const SESSIONS_FILE = path.join(__dirname, '..', `sessions-${config.agent.name}.json`);

export class ClaudeHandlerRepl {
  private sessions: Map<string, ConversationSession> = new Map();
  private logger = new Logger('ClaudeHandlerRepl');
  private mcpManager: McpManager;

  constructor(mcpManager: McpManager) {
    this.mcpManager = mcpManager;
    this.loadSessions();
  }

  // ── Session management (identical to original handler) ──────────────

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

  resetSession(userId: string, channelId: string, threadTs?: string): void {
    const key = this.getSessionKey(userId, channelId, threadTs);
    this.sessions.delete(key);
    this.saveSessions();
    this.logger.info('Session reset', { key });
  }

  cleanupInactiveSessions() {
    // Sessions live forever - auto-compress handles long conversations
  }

  // ── Core: spawn CLI in interactive REPL mode ───────────────────────

  async *streamQuery(
    prompt: string,
    session?: ConversationSession,
    abortController?: AbortController,
    workingDirectory?: string,
    slackContext?: { channel: string; threadTs?: string; user: string }
  ): AsyncGenerator<any, void, unknown> {
    const cliPath = path.join(
      __dirname, '..', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js',
    );

    // Build CLI arguments — interactive mode (NO -p flag!)
    // --verbose is required for stream-json to work without --print
    const args: string[] = [
      cliPath,
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'bypassPermissions',
    ];

    // Model override
    if (config.claude.model) {
      args.push('--model', config.claude.model);
    }

    // Session resume
    if (session?.sessionId) {
      args.push('--resume', session.sessionId);
      this.logger.debug('Resuming REPL session', { sessionId: session.sessionId });
    }

    // MCP configuration — write to temp file, pass via --mcp-config
    const mcpServers = this.mcpManager.getServerConfiguration();
    let mcpConfigPath: string | undefined;
    if (mcpServers && Object.keys(mcpServers).length > 0) {
      mcpConfigPath = path.join('/tmp', `mcp-repl-${config.agent.name}-${Date.now()}.json`);
      fs.writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers }));
      args.push('--mcp-config', mcpConfigPath);

      // Also allow all MCP tools
      const defaultMcpTools = this.mcpManager.getDefaultAllowedTools();
      if (defaultMcpTools.length > 0) {
        args.push('--allowed-tools', ...defaultMcpTools);
      }
    }

    this.logger.info('Spawning Claude REPL process', {
      cwd: workingDirectory || config.agent.dir,
      hasResume: !!session?.sessionId,
      hasMcp: !!mcpConfigPath,
      model: config.claude.model,
    });

    const child = spawn('node', args, {
      cwd: workingDirectory || config.agent.dir,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Log stderr for debugging
    const stderrChunks: string[] = [];
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderrChunks.push(text);
      this.logger.debug('Claude REPL stderr', { text: text.substring(0, 500) });
    });

    // Set up line-by-line NDJSON reading from stdout
    const rl = readline.createInterface({ input: child.stdout! });

    // Message queue for async iteration
    const messageQueue: any[] = [];
    let resolveNext: ((value: any) => void) | null = null;
    let processExited = false;
    let gotResult = false;

    const enqueueMessage = (msg: any) => {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r(msg);
      } else {
        messageQueue.push(msg);
      }
    };

    rl.on('line', (line: string) => {
      if (!line.trim()) return;

      try {
        const message = JSON.parse(line);

        // Auto-approve permission/tool approval requests
        if (message.type === 'control_request') {
          this.logger.debug('Auto-approving control request', {
            requestType: message.request?.type,
            toolName: message.request?.tool_name,
            controlRequestId: message.control_request_id,
          });

          const response = JSON.stringify({
            type: 'control_request_response',
            control_request_id: message.control_request_id,
            approved: true,
          }) + '\n';

          if (child.stdin && !child.stdin.destroyed) {
            child.stdin.write(response);
          }
          return; // Don't yield control requests to the consumer
        }

        enqueueMessage(message);
      } catch (e) {
        // Skip non-JSON lines (startup banners, etc.)
        this.logger.debug('Non-JSON REPL output', { line: line.substring(0, 200) });
      }
    });

    // Handle process exit
    child.on('close', (code: number | null) => {
      processExited = true;
      this.logger.info('Claude REPL process exited', { code });
      if (stderrChunks.length > 0 && code !== 0) {
        this.logger.warn('REPL stderr output', { stderr: stderrChunks.join('').substring(0, 2000) });
      }
      enqueueMessage(null); // Signal end
    });

    child.on('error', (err: Error) => {
      this.logger.error('Failed to spawn Claude REPL', err);
      processExited = true;
      enqueueMessage(null);
    });

    // Handle abort signal
    if (abortController) {
      const onAbort = () => {
        this.logger.debug('Aborting REPL process');
        child.kill('SIGTERM');
      };
      abortController.signal.addEventListener('abort', onAbort, { once: true });
    }

    // Write the user prompt to stdin
    const userMessage = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: prompt },
    }) + '\n';

    if (child.stdin && !child.stdin.destroyed) {
      child.stdin.write(userMessage);
      this.logger.debug('Wrote prompt to REPL stdin', {
        promptLength: prompt.length,
      });
    }

    // Yield messages as they arrive
    try {
      while (!processExited || messageQueue.length > 0) {
        let message: any;

        if (messageQueue.length > 0) {
          message = messageQueue.shift();
        } else {
          message = await new Promise<any>((resolve) => {
            resolveNext = resolve;
          });
        }

        if (message === null) break; // Process exited or errored

        // Capture session ID from init message (same as SDK handler)
        if (message.type === 'system' && message.subtype === 'init') {
          if (session) {
            session.sessionId = message.session_id;
            this.saveSessions();
            this.logger.info('REPL session initialized', {
              sessionId: message.session_id,
              model: message.model,
              tools: message.tools?.length || 0,
            });
          }
        }

        yield message;

        // When we get a result message, this turn is done
        if (message.type === 'result') {
          gotResult = true;
          // Close stdin to let the process exit gracefully
          if (child.stdin && !child.stdin.destroyed) {
            child.stdin.end();
          }
          break;
        }
      }
    } finally {
      // Ensure cleanup
      if (!child.killed && !processExited) {
        child.kill('SIGTERM');
      }

      // Clean up temp MCP config
      if (mcpConfigPath && fs.existsSync(mcpConfigPath)) {
        try {
          fs.unlinkSync(mcpConfigPath);
        } catch (e) {
          // Ignore cleanup errors
        }
      }

      rl.close();
    }
  }
}
