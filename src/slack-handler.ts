import { App } from '@slack/bolt';
import { ClaudeHandler } from './claude-handler';
import { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { Logger } from './logger';
import { WorkingDirectoryManager } from './working-directory-manager';
import { FileHandler, ProcessedFile } from './file-handler';
import { TodoManager, Todo } from './todo-manager';
import { McpManager } from './mcp-manager';
import { permissionServer } from './permission-mcp-server';
import { config } from './config';
import * as fs from 'fs';
import * as path from 'path';

interface MessageEvent {
  user: string;
  channel: string;
  thread_ts?: string;
  ts: string;
  text?: string;
  channelContext?: string;
  files?: Array<{
    id: string;
    name: string;
    mimetype: string;
    filetype: string;
    url_private: string;
    url_private_download: string;
    size: number;
  }>;
}

export class SlackHandler {
  private app: App;
  private claudeHandler: ClaudeHandler;
  private activeControllers: Map<string, AbortController> = new Map();
  private logger = new Logger('SlackHandler');
  private workingDirManager: WorkingDirectoryManager;
  private fileHandler: FileHandler;
  private todoManager: TodoManager;
  private mcpManager: McpManager;
  private todoMessages: Map<string, string> = new Map(); // sessionKey -> messageTs
  private originalMessages: Map<string, { channel: string; ts: string }> = new Map(); // sessionKey -> original message info
  private currentReactions: Map<string, string> = new Map(); // sessionKey -> current emoji
  private botUserId: string | null = null;

  constructor(app: App, claudeHandler: ClaudeHandler, mcpManager: McpManager) {
    this.app = app;
    this.claudeHandler = claudeHandler;
    this.mcpManager = mcpManager;
    this.workingDirManager = new WorkingDirectoryManager();
    this.fileHandler = new FileHandler();
    this.todoManager = new TodoManager();
  }

  async handleMessage(event: MessageEvent, say: any) {
    const { user, channel, thread_ts, ts, text, files } = event;
    
    // Process any attached files
    let processedFiles: ProcessedFile[] = [];
    if (files && files.length > 0) {
      this.logger.info('Processing uploaded files', { count: files.length });
      processedFiles = await this.fileHandler.downloadAndProcessFiles(files);
      
      if (processedFiles.length > 0) {
        await say({
          text: `📎 Processing ${processedFiles.length} file(s): ${processedFiles.map(f => f.name).join(', ')}`,
          thread_ts: thread_ts || ts,
        });
      }
    }

    // If no text and no files, nothing to process
    if (!text && processedFiles.length === 0) return;

    this.logger.debug('Received message from Slack', {
      user,
      channel,
      thread_ts,
      ts,
      text: text ? text.substring(0, 100) + (text.length > 100 ? '...' : '') : '[no text]',
      fileCount: processedFiles.length,
    });

    // Check if this is a working directory command (only if there's text)
    const setDirPath = text ? this.workingDirManager.parseSetCommand(text) : null;
    if (setDirPath) {
      const isDM = channel.startsWith('D');
      const result = this.workingDirManager.setWorkingDirectory(
        channel,
        setDirPath,
        thread_ts,
        isDM ? user : undefined
      );

      if (result.success) {
        const context = thread_ts ? 'this thread' : (isDM ? 'this conversation' : 'this channel');
        await say({
          text: `✅ Working directory set for ${context}: \`${result.resolvedPath}\``,
          thread_ts: thread_ts || ts,
        });
      } else {
        await say({
          text: `❌ ${result.error}`,
          thread_ts: thread_ts || ts,
        });
      }
      return;
    }

    // Check if this is a get directory command (only if there's text)
    if (text && this.workingDirManager.isGetCommand(text)) {
      const isDM = channel.startsWith('D');
      const directory = this.workingDirManager.getWorkingDirectory(
        channel,
        thread_ts,
        isDM ? user : undefined
      );
      const context = thread_ts ? 'this thread' : (isDM ? 'this conversation' : 'this channel');
      
      await say({
        text: this.workingDirManager.formatDirectoryMessage(directory, context),
        thread_ts: thread_ts || ts,
      });
      return;
    }

    // Check if this is an MCP info command (only if there's text)
    if (text && this.isMcpInfoCommand(text)) {
      await say({
        text: this.mcpManager.formatMcpInfo(),
        thread_ts: thread_ts || ts,
      });
      return;
    }

    // Check if this is an MCP reload command (only if there's text)
    if (text && this.isMcpReloadCommand(text)) {
      const reloaded = this.mcpManager.reloadConfiguration();
      if (reloaded) {
        await say({
          text: `✅ MCP configuration reloaded successfully.\n\n${this.mcpManager.formatMcpInfo()}`,
          thread_ts: thread_ts || ts,
        });
      } else {
        await say({
          text: `❌ Failed to reload MCP configuration. Check the mcp-servers.json file.`,
          thread_ts: thread_ts || ts,
        });
      }
      return;
    }

    // Use agent directory as working directory, with optional override
    const isDM = channel.startsWith('D');
    const workingDirectory = this.workingDirManager.getWorkingDirectory(
      channel,
      thread_ts,
      isDM ? user : undefined
    ) || config.agent.dir;

    // DMs without threads use one continuous session; channels use thread-based sessions
    const sessionThreadTs = isDM ? (thread_ts || undefined) : (thread_ts || ts);
    const sessionKey = this.claudeHandler.getSessionKey(user, channel, sessionThreadTs);
    
    // Store the original message info for status reactions
    const originalMessageTs = thread_ts || ts;
    this.originalMessages.set(sessionKey, { channel, ts: originalMessageTs });
    
    // Cancel any existing request for this conversation
    const existingController = this.activeControllers.get(sessionKey);
    if (existingController) {
      this.logger.debug('Cancelling existing request for session', { sessionKey });
      existingController.abort();
    }

    const abortController = new AbortController();
    this.activeControllers.set(sessionKey, abortController);

    let session = this.claudeHandler.checkAndResetSession(user, channel, thread_ts || ts);
    if (!session) {
      this.logger.debug('Creating new session', { sessionKey });
      session = this.claudeHandler.createSession(user, channel, thread_ts || ts);
    } else {
      this.logger.debug('Using existing session', { sessionKey, sessionId: session.sessionId, turns: session.turns });
    }
    session.turns++;
    session.lastActivity = new Date();

    let currentMessages: string[] = [];
    let statusMessageTs: string | undefined;

    try {
      // Prepare the prompt with channel context and user profile
      let basePrompt = text || '';

      // Load user profile if it exists
      const userName = await this.resolveUserName(user);
      const userSlug = userName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      const userProfilePath = path.join(config.agent.dir, 'users', `${userSlug}.md`);
      let userContext = '';
      if (fs.existsSync(userProfilePath)) {
        const profile = fs.readFileSync(userProfilePath, 'utf-8').trim();
        userContext = `\n[User profile for ${userName}:\n${profile}\n]`;
      }

      // If this message arrived inside a Slack thread, pull the full thread
      // history and inject it into the prompt. This makes agents thread-aware:
      // any agent @mentioned in a thread sees what everyone else said above,
      // regardless of which bot's session was previously active. Stateless and
      // resilient — no cross-agent session sharing required.
      let threadHistoryBlock = '';
      if (thread_ts) {
        threadHistoryBlock = await this.fetchThreadHistory(channel, thread_ts, ts);
        if (threadHistoryBlock) {
          this.logger.debug('Injected thread history', {
            chars: threadHistoryBlock.length,
            threadTs: thread_ts,
          });
        }
      }

      // Include the current thread_ts in the channel context header so agents
      // know which thread they're in — and can pass it to post-as.sh --thread
      // for threaded handoffs.
      let channelContextStr = event.channelContext || '';
      if (thread_ts && channelContextStr) {
        // Insert "| Thread: <ts>" just before the closing bracket of the header
        channelContextStr = channelContextStr.replace(/\]\s*$/, ` | Thread: ${thread_ts}]`);
      }

      if (channelContextStr || userContext || threadHistoryBlock) {
        basePrompt = `${channelContextStr}${userContext}\n${threadHistoryBlock}${basePrompt}`;
      }
      const finalPrompt = processedFiles.length > 0
        ? await this.fileHandler.formatFilePrompt(processedFiles, basePrompt)
        : basePrompt;

      this.logger.info('Sending query to Claude Code SDK', { 
        prompt: finalPrompt.substring(0, 200) + (finalPrompt.length > 200 ? '...' : ''), 
        sessionId: session.sessionId,
        workingDirectory,
        fileCount: processedFiles.length,
      });

      // Send initial status message
      const statusResult = await say({
        text: '🤔 *Thinking...*',
        thread_ts: thread_ts || ts,
      });
      statusMessageTs = statusResult.ts;

      // Add thinking reaction to original message (but don't spam if already set)
      await this.updateMessageReaction(sessionKey, '🤔');
      
      // Create Slack context for permission prompts
      const slackContext = {
        channel,
        threadTs: thread_ts,
        user
      };
      
      for await (const message of this.claudeHandler.streamQuery(finalPrompt, session, abortController, workingDirectory, slackContext)) {
        if (abortController.signal.aborted) break;

        this.logger.debug('Received message from Claude SDK', {
          type: message.type,
          subtype: (message as any).subtype,
          message: message,
        });

        if (message.type === 'assistant') {
          // Check if this is a tool use message
          const hasToolUse = message.message.content?.some((part: any) => part.type === 'tool_use');
          
          if (hasToolUse) {
            // Update status to show working
            if (statusMessageTs) {
              await this.app.client.chat.update({
                channel,
                ts: statusMessageTs,
                text: '⚙️ *Working...*',
              });
            }

            // Update reaction to show working
            await this.updateMessageReaction(sessionKey, '⚙️');

            // Check for TodoWrite tool and handle it specially
            const todoTool = message.message.content?.find((part: any) => 
              part.type === 'tool_use' && part.name === 'TodoWrite'
            );

            if (todoTool) {
              await this.handleTodoUpdate(todoTool.input, sessionKey, session?.sessionId, channel, thread_ts || ts, say);
            }

            // For other tool use messages, format them immediately as new messages
            const toolContent = this.formatToolUse(message.message.content);
            if (toolContent) { // Only send if there's content (TodoWrite returns empty string)
              await say({
                text: toolContent,
                thread_ts: thread_ts || ts,
              });
            }
          } else {
            // Handle regular text content
            const content = this.extractTextContent(message);
            if (content) {
              currentMessages.push(content);
              
              // Send each new piece of content as a separate message
              const formatted = this.formatMessage(content, false);
              await say({
                text: formatted,
                thread_ts: thread_ts || ts,
              });
            }
          }
        } else if (message.type === 'result') {
          const cost = (message as any).total_cost_usd;
          const duration = (message as any).duration_ms;
          const inputTokens = (message as any).usage?.input_tokens;
          const outputTokens = (message as any).usage?.output_tokens;

          this.logger.info('Result', {
            subtype: message.subtype,
            cost,
            duration,
            inputTokens,
            outputTokens,
          });

          // Log usage to file for monitoring
          this.logUsage({
            agent: config.agent.name,
            user,
            channel,
            threadTs: thread_ts || ts,
            cost,
            durationMs: duration,
            inputTokens,
            outputTokens,
            turns: session?.turns,
            timestamp: new Date().toISOString(),
          });

          if (message.subtype === 'success' && (message as any).result) {
            const finalResult = (message as any).result;
            if (finalResult && !currentMessages.includes(finalResult)) {
              const formatted = this.formatMessage(finalResult, true);
              await say({
                text: formatted,
                thread_ts: thread_ts || ts,
              });
            }
          }
        }
      }

      // Update status to completed
      if (statusMessageTs) {
        await this.app.client.chat.update({
          channel,
          ts: statusMessageTs,
          text: '✅ *Task completed*',
        });
      }

      // Update reaction to show completion
      await this.updateMessageReaction(sessionKey, '✅');

      this.logger.info('Completed processing message', {
        sessionKey,
        messageCount: currentMessages.length,
      });

      // Clean up temporary files
      if (processedFiles.length > 0) {
        await this.fileHandler.cleanupTempFiles(processedFiles);
      }
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        this.logger.error('Error handling message', error);
        
        // Update status to error
        if (statusMessageTs) {
          await this.app.client.chat.update({
            channel,
            ts: statusMessageTs,
            text: '❌ *Error occurred*',
          });
        }

        // Update reaction to show error
        await this.updateMessageReaction(sessionKey, '❌');
        
        await say({
          text: `Error: ${error.message || 'Something went wrong'}`,
          thread_ts: thread_ts || ts,
        });
      } else {
        this.logger.debug('Request was aborted', { sessionKey });
        
        // Update status to cancelled
        if (statusMessageTs) {
          await this.app.client.chat.update({
            channel,
            ts: statusMessageTs,
            text: '⏹️ *Cancelled*',
          });
        }

        // Update reaction to show cancellation
        await this.updateMessageReaction(sessionKey, '⏹️');
      }

      // Clean up temporary files in case of error too
      if (processedFiles.length > 0) {
        await this.fileHandler.cleanupTempFiles(processedFiles);
      }
    } finally {
      this.activeControllers.delete(sessionKey);
      
      // Clean up todo tracking if session ended
      if (session?.sessionId) {
        // Don't immediately clean up - keep todos visible for a while
        setTimeout(() => {
          this.todoManager.cleanupSession(session.sessionId!);
          this.todoMessages.delete(sessionKey);
          this.originalMessages.delete(sessionKey);
          this.currentReactions.delete(sessionKey);
        }, 5 * 60 * 1000); // 5 minutes
      }
    }
  }

  private extractTextContent(message: SDKMessage): string | null {
    if (message.type === 'assistant' && message.message.content) {
      const textParts = message.message.content
        .filter((part: any) => part.type === 'text')
        .map((part: any) => part.text);
      return textParts.join('');
    }
    return null;
  }

  private formatToolUse(content: any[]): string {
    const parts: string[] = [];
    
    for (const part of content) {
      if (part.type === 'text') {
        parts.push(part.text);
      } else if (part.type === 'tool_use') {
        const toolName = part.name;
        const input = part.input;
        
        switch (toolName) {
          case 'Edit':
          case 'MultiEdit':
            parts.push(this.formatEditTool(toolName, input));
            break;
          case 'Write':
            parts.push(this.formatWriteTool(input));
            break;
          case 'Read':
            parts.push(this.formatReadTool(input));
            break;
          case 'Bash':
            parts.push(this.formatBashTool(input));
            break;
          case 'TodoWrite':
            // Handle TodoWrite separately - don't include in regular tool output
            return this.handleTodoWrite(input);
          default:
            parts.push(this.formatGenericTool(toolName, input));
        }
      }
    }
    
    return parts.join('\n\n');
  }

  private formatEditTool(toolName: string, input: any): string {
    const filePath = input.file_path;
    const edits = toolName === 'MultiEdit' ? input.edits : [{ old_string: input.old_string, new_string: input.new_string }];
    
    let result = `📝 *Editing \`${filePath}\`*\n`;
    
    for (const edit of edits) {
      result += '\n```diff\n';
      result += `- ${this.truncateString(edit.old_string, 200)}\n`;
      result += `+ ${this.truncateString(edit.new_string, 200)}\n`;
      result += '```';
    }
    
    return result;
  }

  private formatWriteTool(input: any): string {
    const filePath = input.file_path;
    const preview = this.truncateString(input.content, 300);
    
    return `📄 *Creating \`${filePath}\`*\n\`\`\`\n${preview}\n\`\`\``;
  }

  private formatReadTool(input: any): string {
    return `👁️ *Reading \`${input.file_path}\`*`;
  }

  private formatBashTool(input: any): string {
    return `🖥️ *Running command:*\n\`\`\`bash\n${input.command}\n\`\`\``;
  }

  private formatGenericTool(toolName: string, input: any): string {
    return `🔧 *Using ${toolName}*`;
  }

  private truncateString(str: string, maxLength: number): string {
    if (!str) return '';
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength) + '...';
  }

  private handleTodoWrite(input: any): string {
    // TodoWrite tool doesn't produce visible output - handled separately
    return '';
  }

  private async handleTodoUpdate(
    input: any, 
    sessionKey: string, 
    sessionId: string | undefined, 
    channel: string, 
    threadTs: string, 
    say: any
  ): Promise<void> {
    if (!sessionId || !input.todos) {
      return;
    }

    const newTodos: Todo[] = input.todos;
    const oldTodos = this.todoManager.getTodos(sessionId);
    
    // Check if there's a significant change
    if (this.todoManager.hasSignificantChange(oldTodos, newTodos)) {
      // Update the todo manager
      this.todoManager.updateTodos(sessionId, newTodos);
      
      // Format the todo list
      const todoList = this.todoManager.formatTodoList(newTodos);
      
      // Check if we already have a todo message for this session
      const existingTodoMessageTs = this.todoMessages.get(sessionKey);
      
      if (existingTodoMessageTs) {
        // Update existing todo message
        try {
          await this.app.client.chat.update({
            channel,
            ts: existingTodoMessageTs,
            text: todoList,
          });
          this.logger.debug('Updated existing todo message', { sessionKey, messageTs: existingTodoMessageTs });
        } catch (error) {
          this.logger.warn('Failed to update todo message, creating new one', error);
          // If update fails, create a new message
          await this.createNewTodoMessage(todoList, channel, threadTs, sessionKey, say);
        }
      } else {
        // Create new todo message
        await this.createNewTodoMessage(todoList, channel, threadTs, sessionKey, say);
      }

      // Send status change notification if there are meaningful changes
      const statusChange = this.todoManager.getStatusChange(oldTodos, newTodos);
      if (statusChange) {
        await say({
          text: `🔄 *Task Update:*\n${statusChange}`,
          thread_ts: threadTs,
        });
      }

      // Update reaction based on overall progress
      await this.updateTaskProgressReaction(sessionKey, newTodos);
    }
  }

  private async createNewTodoMessage(
    todoList: string, 
    channel: string, 
    threadTs: string, 
    sessionKey: string, 
    say: any
  ): Promise<void> {
    const result = await say({
      text: todoList,
      thread_ts: threadTs,
    });
    
    if (result?.ts) {
      this.todoMessages.set(sessionKey, result.ts);
      this.logger.debug('Created new todo message', { sessionKey, messageTs: result.ts });
    }
  }

  private async updateMessageReaction(sessionKey: string, emoji: string): Promise<void> {
    const originalMessage = this.originalMessages.get(sessionKey);
    if (!originalMessage) {
      return;
    }

    // Check if we're already showing this emoji
    const currentEmoji = this.currentReactions.get(sessionKey);
    if (currentEmoji === emoji) {
      this.logger.debug('Reaction already set, skipping', { sessionKey, emoji });
      return;
    }

    try {
      // Remove the current reaction if it exists
      if (currentEmoji) {
        try {
          await this.app.client.reactions.remove({
            channel: originalMessage.channel,
            timestamp: originalMessage.ts,
            name: currentEmoji,
          });
          this.logger.debug('Removed previous reaction', { sessionKey, emoji: currentEmoji });
        } catch (error) {
          this.logger.debug('Failed to remove previous reaction (might not exist)', { 
            sessionKey, 
            emoji: currentEmoji,
            error: (error as any).message 
          });
        }
      }

      // Add the new reaction
      await this.app.client.reactions.add({
        channel: originalMessage.channel,
        timestamp: originalMessage.ts,
        name: emoji,
      });

      // Track the current reaction
      this.currentReactions.set(sessionKey, emoji);

      this.logger.debug('Updated message reaction', { 
        sessionKey, 
        emoji, 
        previousEmoji: currentEmoji,
        channel: originalMessage.channel, 
        ts: originalMessage.ts 
      });
    } catch (error) {
      this.logger.warn('Failed to update message reaction', error);
    }
  }

  private async updateTaskProgressReaction(sessionKey: string, todos: Todo[]): Promise<void> {
    if (todos.length === 0) {
      return;
    }

    const completed = todos.filter(t => t.status === 'completed').length;
    const inProgress = todos.filter(t => t.status === 'in_progress').length;
    const total = todos.length;

    let emoji: string;
    if (completed === total) {
      emoji = '✅'; // All tasks completed
    } else if (inProgress > 0) {
      emoji = '🔄'; // Tasks in progress
    } else {
      emoji = '📋'; // Tasks pending
    }

    await this.updateMessageReaction(sessionKey, emoji);
  }

  private isMcpInfoCommand(text: string): boolean {
    return /^(mcp|servers?)(\s+(info|list|status))?(\?)?$/i.test(text.trim());
  }

  private isMcpReloadCommand(text: string): boolean {
    return /^(mcp|servers?)\s+(reload|refresh)$/i.test(text.trim());
  }

  private userNameCache: Map<string, string> = new Map();

  private async resolveUserName(userId: string): Promise<string> {
    if (this.userNameCache.has(userId)) return this.userNameCache.get(userId)!;
    try {
      const result = await this.app.client.users.info({ user: userId });
      const name = (result.user as any)?.real_name || (result.user as any)?.name || userId;
      this.userNameCache.set(userId, name);
      return name;
    } catch {
      return userId;
    }
  }

  /**
   * Fetch the full thread history up to (but not including) the current message
   * and format it as a [Thread history: ...] block that can be prepended to the
   * agent's prompt. This makes every agent thread-aware and stateless: any agent
   * @mentioned in a thread sees exactly what everyone else said, regardless of
   * whose bot previously held the session.
   *
   * Hard cap: 50 messages / 8000 chars to keep token cost reasonable.
   * If a thread somehow runs longer, we keep the most recent messages and
   * indicate truncation at the top.
   */
  private async fetchThreadHistory(
    channel: string,
    threadTs: string,
    currentMessageTs: string,
  ): Promise<string> {
    try {
      const result = await this.app.client.conversations.replies({
        channel,
        ts: threadTs,
        limit: 60,
      });
      const messages = (result.messages || []) as any[];
      if (messages.length <= 1) return ''; // only the current message — nothing to show

      // Drop the current message (and anything newer) — we only want prior context.
      const prior = messages.filter(m => m.ts && m.ts < currentMessageTs);
      if (prior.length === 0) return '';

      // Resolve display names for every unique speaker in the thread.
      const formatted: string[] = [];
      for (const m of prior) {
        let speaker = 'Unknown';
        if (m.bot_profile?.name) {
          speaker = m.bot_profile.name;
        } else if (m.username) {
          speaker = m.username;
        } else if (m.user) {
          speaker = await this.resolveUserName(m.user);
        }
        // Strip Slack user-mention tokens like <@U0ARU06HVEV> down to readable names
        // so the agent doesn't have to parse Slack ID syntax.
        const rawText = (m.text || '').replace(/<@([UW][A-Z0-9]+)>/g, (_: string, uid: string) => {
          const cached = this.userNameCache.get(uid);
          return cached ? `@${cached}` : `@${uid}`;
        });
        if (rawText.trim()) {
          formatted.push(`${speaker}: ${rawText.trim()}`);
        }
      }

      if (formatted.length === 0) return '';

      // Truncate from the oldest end if the block grows too large.
      const MAX_CHARS = 8000;
      const MAX_LINES = 50;
      let truncated = false;
      while (
        formatted.length > MAX_LINES ||
        formatted.join('\n').length > MAX_CHARS
      ) {
        formatted.shift();
        truncated = true;
      }

      const header = truncated
        ? '[Thread history (older messages truncated — showing most recent):'
        : '[Thread history:';
      return `${header}\n${formatted.join('\n')}\n]\n`;
    } catch (err) {
      this.logger.error('Failed to fetch thread history', err);
      return '';
    }
  }

  private async getBotUserId(): Promise<string> {
    if (!this.botUserId) {
      try {
        const response = await this.app.client.auth.test();
        this.botUserId = response.user_id as string;
      } catch (error) {
        this.logger.error('Failed to get bot user ID', error);
        this.botUserId = '';
      }
    }
    return this.botUserId;
  }

  private getStatusReport(userId: string): string {
    const agentName = config.agent.name.charAt(0).toUpperCase() + config.agent.name.slice(1);
    const agentDir = config.agent.dir;
    const lines: string[] = [];

    lines.push(`*${agentName} — Status*\n`);

    // CLAUDE.md size
    const claudeMdPath = path.join(agentDir, 'CLAUDE.md');
    if (fs.existsSync(claudeMdPath)) {
      const content = fs.readFileSync(claudeMdPath, 'utf-8');
      const lineCount = content.split('\n').length;
      lines.push(`📄 *CLAUDE.md:* ${lineCount} lines`);
    }

    // Task files
    const tasksDir = path.join(agentDir, 'tasks');
    if (fs.existsSync(tasksDir)) {
      const taskFiles = fs.readdirSync(tasksDir).filter(f => f.endsWith('.md'));
      lines.push(`📋 *Task files:* ${taskFiles.length} (${taskFiles.join(', ') || 'none'})`);
    }

    // User profiles
    const usersDir = path.join(agentDir, 'users');
    if (fs.existsSync(usersDir)) {
      const userFiles = fs.readdirSync(usersDir).filter(f => f.endsWith('.md'));
      lines.push(`👥 *User profiles:* ${userFiles.length} (${userFiles.map(f => f.replace('.md', '')).join(', ') || 'none'})`);
    }

    // Current session
    const session = this.claudeHandler.getSession(userId, config.agent.channelId || '');
    if (session?.sessionId) {
      const age = Math.round((Date.now() - new Date(session.lastActivity).getTime()) / 60000);
      lines.push(`💬 *Session:* ${session.turns} turns, last active ${age}m ago`);
    } else {
      lines.push(`💬 *Session:* none active`);
    }

    // Today's usage from log
    const logFile = path.join(__dirname, '..', 'logs', 'usage.jsonl');
    if (fs.existsSync(logFile)) {
      const today = new Date().toISOString().split('T')[0];
      const logLines = fs.readFileSync(logFile, 'utf-8').trim().split('\n');
      let todayCost = 0;
      let todayRequests = 0;
      for (const line of logLines) {
        try {
          const entry = JSON.parse(line);
          if (entry.agent === config.agent.name && entry.timestamp?.startsWith(today)) {
            todayCost += entry.cost || 0;
            todayRequests++;
          }
        } catch {}
      }
      lines.push(`📊 *Today:* ${todayRequests} requests, $${todayCost.toFixed(4)} cost`);
    }

    // MCP servers
    const mcpServers = this.mcpManager.getServerConfiguration();
    if (mcpServers && Object.keys(mcpServers).length > 0) {
      lines.push(`🔌 *MCP servers:* ${Object.keys(mcpServers).join(', ')}`);
    } else {
      lines.push(`🔌 *MCP servers:* none`);
    }

    // Working directory
    lines.push(`📁 *Directory:* \`${agentDir}\``);

    return lines.join('\n');
  }

  private logUsage(entry: Record<string, any>): void {
    try {
      const logDir = path.join(__dirname, '..', 'logs');
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
      const logFile = path.join(logDir, 'usage.jsonl');
      fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
    } catch (err) {
      this.logger.error('Failed to log usage', err);
    }
  }

  private formatMessage(text: string, isFinal: boolean): string {
    // Convert markdown code blocks to Slack format
    let formatted = text
      .replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) => {
        return '```' + code + '```';
      })
      .replace(/`([^`]+)`/g, '`$1`')
      .replace(/\*\*([^*]+)\*\*/g, '*$1*')
      .replace(/__([^_]+)__/g, '_$1_');

    return formatted;
  }

  setupEventHandlers() {
    // Agent's own channel: respond to everything without @mention
    this.app.message(async ({ message, say }) => {
      if (message.subtype !== undefined && message.subtype !== 'file_share') return;
      if (!('user' in message)) return;

      const event = message as MessageEvent;
      const botUserId = await this.getBotUserId();

      if (event.user === botUserId) return;
      if ((message as any).bot_id) return;

      const isAgentChannel = config.agent.channelId && event.channel === config.agent.channelId;

      // Only respond in agent's own channel (without @mention)
      if (!isAgentChannel) return;

      const text = event.text?.replace(/<@[^>]+>/g, '').trim() || '';

      this.logger.info('Handling agent channel message', { channel: event.channel });
      const userName = await this.resolveUserName(event.user);
      await this.handleMessage({ ...event, text, channelContext: `[Channel: your private channel | User: ${userName}]` } as MessageEvent, say);
    });

    // Handle @mentions in agent-hub only
    this.app.event('app_mention', async ({ event, say }) => {
      const isHub = config.agent.hubChannelId && event.channel === config.agent.hubChannelId;
      const isAgentChannel = config.agent.channelId && event.channel === config.agent.channelId;

      // Only respond to @mentions in agent-hub (agent channel handled above)
      if (!isHub && !isAgentChannel) return;

      this.logger.info('Handling @mention', { channel: event.channel });
      const text = event.text.replace(/<@[^>]+>/g, '').trim();

      const hubUserName = await this.resolveUserName(event.user);
      await this.handleMessage({
        ...event,
        text,
        channelContext: `[Channel: #agent-hub (shared team channel — other agents and people are here) | User: ${hubUserName}]`,
      } as MessageEvent, say);
    });

    // Handle permission approval button clicks
    this.app.action('approve_tool', async ({ ack, body, respond }) => {
      await ack();
      const approvalId = (body as any).actions[0].value;
      this.logger.info('Tool approval granted', { approvalId });
      
      permissionServer.resolveApproval(approvalId, true);
      
      await respond({
        response_type: 'ephemeral',
        text: '✅ Tool execution approved'
      });
    });

    // Handle permission denial button clicks
    this.app.action('deny_tool', async ({ ack, body, respond }) => {
      await ack();
      const approvalId = (body as any).actions[0].value;
      this.logger.info('Tool approval denied', { approvalId });
      
      permissionServer.resolveApproval(approvalId, false);
      
      await respond({
        response_type: 'ephemeral',
        text: '❌ Tool execution denied'
      });
    });

    // Cleanup inactive sessions periodically
    setInterval(() => {
      this.logger.debug('Running session cleanup');
      this.claudeHandler.cleanupInactiveSessions();
    }, 5 * 60 * 1000); // Every 5 minutes
  }
}