import fetch from 'node-fetch';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { Logger } from './logger';
import { config } from './config';

export interface ProcessedFile {
  path: string;
  name: string;
  mimetype: string;
  isImage: boolean;
  isText: boolean;
  size: number;
  tempPath?: string;
}

export class FileHandler {
  private logger = new Logger('FileHandler');

  async downloadAndProcessFiles(files: any[]): Promise<ProcessedFile[]> {
    const processedFiles: ProcessedFile[] = [];

    for (const file of files) {
      try {
        const processed = await this.downloadFile(file);
        if (processed) {
          processedFiles.push(processed);
        }
      } catch (error) {
        this.logger.error(`Failed to process file ${file.name}`, error);
      }
    }

    return processedFiles;
  }

  private async downloadFile(file: any): Promise<ProcessedFile | null> {
    // Check file size limit (50MB)
    if (file.size > 50 * 1024 * 1024) {
      this.logger.warn('File too large, skipping', { name: file.name, size: file.size });
      return null;
    }

    try {
      this.logger.debug('Downloading file', { name: file.name, mimetype: file.mimetype });

      const response = await fetch(file.url_private_download, {
        headers: {
          'Authorization': `Bearer ${config.slack.botToken}`,
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const buffer = await response.buffer();
      // Use a stable home-dir path instead of os.tmpdir() — /var/folders is not
      // reliably accessible by the Claude Code CLI when it runs with a fixed cwd.
      const uploadDir = path.join(os.homedir(), '.claude-slack-uploads');
      fs.mkdirSync(uploadDir, { recursive: true });
      const tempPath = path.join(uploadDir, `slack-file-${Date.now()}-${file.name}`);

      fs.writeFileSync(tempPath, buffer);

      const processed: ProcessedFile = {
        path: tempPath,
        name: file.name,
        mimetype: file.mimetype,
        isImage: this.isImageFile(file.mimetype),
        isText: this.isTextFile(file.mimetype),
        size: file.size,
        tempPath,
      };

      this.logger.info('File downloaded successfully', {
        name: file.name,
        tempPath,
        isImage: processed.isImage,
        isText: processed.isText,
      });

      return processed;
    } catch (error) {
      this.logger.error('Failed to download file', error);
      return null;
    }
  }

  private isImageFile(mimetype: string): boolean {
    return mimetype.startsWith('image/');
  }

  private isTextFile(mimetype: string): boolean {
    const textTypes = [
      'text/',
      'application/json',
      'application/javascript',
      'application/typescript',
      'application/xml',
      'application/yaml',
      'application/x-yaml',
    ];

    return textTypes.some(type => mimetype.startsWith(type));
  }

  private isAudioFile(mimetype: string): boolean {
    return mimetype.startsWith('audio/');
  }

  /**
   * Transcribe an audio file using OpenAI Whisper (installed locally via Homebrew).
   * Falls back gracefully if whisper isn't available.
   */
  private transcribeAudio(filePath: string): string | null {
    try {
      const tempDir = os.tmpdir();
      const outputBase = path.join(tempDir, `whisper-${Date.now()}`);
      // Run whisper with tiny model for speed — good enough for voice memos
      const result = execSync(
        `/opt/homebrew/bin/whisper "${filePath}" --model turbo --output_format txt --output_dir "${tempDir}" --fp16 False 2>/dev/null`,
        { timeout: 120000, encoding: 'utf-8' }
      );
      // Whisper writes {filename}.txt in the output dir
      const baseName = path.basename(filePath, path.extname(filePath));
      const txtPath = path.join(tempDir, `${baseName}.txt`);
      if (fs.existsSync(txtPath)) {
        const transcript = fs.readFileSync(txtPath, 'utf-8').trim();
        fs.unlinkSync(txtPath); // cleanup
        return transcript || null;
      }
      return null;
    } catch (error) {
      this.logger.warn('Whisper transcription failed', { filePath, error });
      return null;
    }
  }

  async formatFilePrompt(files: ProcessedFile[], userText: string): Promise<string> {
    let prompt = userText || 'Please analyze the uploaded files.';
    
    if (files.length > 0) {
      prompt += '\n\nUploaded files:\n';
      
      for (const file of files) {
        if (file.isImage) {
          prompt += `\n## Image: ${file.name}\n`;
          prompt += `File type: ${file.mimetype}\n`;
          prompt += `Path: ${file.path}\n`;
          prompt += `Note: This is an image file. You MUST use the Read tool on this path immediately at the start of your response to view the image before doing anything else.\n`;
        } else if (file.isText) {
          prompt += `\n## File: ${file.name}\n`;
          prompt += `File type: ${file.mimetype}\n`;
          
          try {
            const content = fs.readFileSync(file.path, 'utf-8');
            if (content.length > 10000) {
              prompt += `Content (truncated to first 10000 characters):\n\`\`\`\n${content.substring(0, 10000)}...\n\`\`\`\n`;
            } else {
              prompt += `Content:\n\`\`\`\n${content}\n\`\`\`\n`;
            }
          } catch (error) {
            prompt += `Error reading file content: ${error}\n`;
          }
        } else if (this.isAudioFile(file.mimetype)) {
          prompt += `\n## Voice/Audio: ${file.name}\n`;
          prompt += `File type: ${file.mimetype}\n`;
          const transcript = this.transcribeAudio(file.path);
          if (transcript) {
            prompt += `Transcription:\n\`\`\`\n${transcript}\n\`\`\`\n`;
            prompt += `Note: This was transcribed from an audio file using Whisper. Respond to the content naturally as if the user said it to you.\n`;
          } else {
            prompt += `Note: Audio file received but transcription failed. Ask the user to type their message instead.\n`;
          }
        } else {
          prompt += `\n## File: ${file.name}\n`;
          prompt += `File type: ${file.mimetype}\n`;
          prompt += `Size: ${file.size} bytes\n`;
          prompt += `Note: This is a binary file. Content analysis may be limited.\n`;
        }
      }
      
      prompt += '\nPlease analyze these files and provide insights or assistance based on their content.';
    }

    return prompt;
  }

  async cleanupTempFiles(files: ProcessedFile[]): Promise<void> {
    for (const file of files) {
      if (file.tempPath) {
        try {
          fs.unlinkSync(file.tempPath);
          this.logger.debug('Cleaned up temp file', { path: file.tempPath });
        } catch (error) {
          this.logger.warn('Failed to cleanup temp file', { path: file.tempPath, error });
        }
      }
    }
  }

  getSupportedFileTypes(): string[] {
    return [
      'Images: jpg, png, gif, webp, svg',
      'Text files: txt, md, json, js, ts, py, java, etc.',
      'Documents: pdf, docx (limited support)',
      'Code files: most programming languages',
    ];
  }
}