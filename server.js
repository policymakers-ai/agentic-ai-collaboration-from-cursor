import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { EventEmitter } from 'events';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'fs';
import { WebSocketServer } from 'ws';
import http from 'http';
import OpenAI from 'openai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Constants
const PROJECT_WORKSPACE = '/tmp/project';

// Ensure workspace exists
if (!existsSync(PROJECT_WORKSPACE)) {
  mkdirSync(PROJECT_WORKSPACE, { recursive: true });
}

/**
 * FileLockManager - Manages file locking to prevent concurrent writes
 */
class FileLockManager {
  constructor() {
    this.locks = new Map(); // path -> { agent, timestamp }
    this.LOCK_TIMEOUT = 30000; // 30 seconds
  }

  acquireLock(filePath, agentName) {
    const now = Date.now();
    const lock = this.locks.get(filePath);

    // Check if locked by another agent and lock hasn't timed out
    if (lock && lock.agent !== agentName && (now - lock.timestamp < this.LOCK_TIMEOUT)) {
      return false;
    }

    // Acquire or refresh lock
    this.locks.set(filePath, {
      agent: agentName,
      timestamp: now
    });
    return true;
  }

  releaseLock(filePath, agentName) {
    const lock = this.locks.get(filePath);
    if (lock && lock.agent === agentName) {
      this.locks.delete(filePath);
      return true;
    }
    return false;
  }

  getLockOwner(filePath) {
    const lock = this.locks.get(filePath);
    if (!lock) return null;
    
    // Check timeout
    if (Date.now() - lock.timestamp > this.LOCK_TIMEOUT) {
      this.locks.delete(filePath);
      return null;
    }
    
    return lock.agent;
  }
}

/**
 * FileSystemTools - Safe file operations within workspace
 */
class FileSystemTools {
  constructor(lockManager) {
    this.lockManager = lockManager;
  }

  _validatePath(filePath) {
    // Resolve relative path against workspace
    const fullPath = path.resolve(PROJECT_WORKSPACE, filePath);
    
    // Ensure path is still inside workspace (prevent directory traversal)
    if (!fullPath.startsWith(PROJECT_WORKSPACE)) {
      throw new Error(`Access denied: Path must be within ${PROJECT_WORKSPACE}`);
    }
    
    return fullPath;
  }

  createFile(agentName, filePath, content) {
    const fullPath = this._validatePath(filePath);

    // Check lock
    if (!this.lockManager.acquireLock(filePath, agentName)) {
      const owner = this.lockManager.getLockOwner(filePath);
      throw new Error(`File is locked by ${owner}`);
    }

    try {
      // Create directories if needed
      const dir = path.dirname(fullPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      
      writeFileSync(fullPath, content);
      return `Successfully created file: ${filePath}`;
    } finally {
      this.lockManager.releaseLock(filePath, agentName);
    }
  }

  readFile(filePath) {
    const fullPath = this._validatePath(filePath);
    if (!existsSync(fullPath)) {
      throw new Error(`File not found: ${filePath}`);
    }
    return readFileSync(fullPath, 'utf-8');
  }

  strReplace(agentName, filePath, oldStr, newStr) {
    const fullPath = this._validatePath(filePath);
    
    // Check lock
    if (!this.lockManager.acquireLock(filePath, agentName)) {
      const owner = this.lockManager.getLockOwner(filePath);
      throw new Error(`File is locked by ${owner}`);
    }

    try {
      if (!existsSync(fullPath)) {
        throw new Error(`File not found: ${filePath}`);
      }
      
      const content = readFileSync(fullPath, 'utf-8');
      if (!content.includes(oldStr)) {
        throw new Error(`String not found in file: ${oldStr}`);
      }
      
      const newContent = content.replace(oldStr, newStr);
      writeFileSync(fullPath, newContent);
      return `Successfully modified file: ${filePath}`;
    } finally {
      this.lockManager.releaseLock(filePath, agentName);
    }
  }

  listFiles(dirPath = '.') {
    const fullPath = this._validatePath(dirPath);
    if (!existsSync(fullPath)) {
      return [];
    }
    
    // Recursive file listing helper
    const getFiles = (dir, relativeDir = '') => {
      const files = readdirSync(dir, { withFileTypes: true });
      let result = [];
      
      for (const file of files) {
        const relativePath = path.join(relativeDir, file.name);
        if (file.isDirectory()) {
          result = result.concat(getFiles(path.join(dir, file.name), relativePath));
        } else {
          result.push(relativePath);
        }
      }
      
      return result;
    };

    return getFiles(fullPath);
  }

  wipeWorkspace() {
    if (existsSync(PROJECT_WORKSPACE)) {
      rmSync(PROJECT_WORKSPACE, { recursive: true, force: true });
      mkdirSync(PROJECT_WORKSPACE, { recursive: true });
    }
  }
}

const fileLockManager = new FileLockManager();
const fileTools = new FileSystemTools(fileLockManager);

const app = express();
const port = process.env.PORT || 3000;
const server = http.createServer(app);

// Initialize WebSocket Server
const wss = new WebSocketServer({ noServer: true });
const conversationClients = new Map(); // conversationId -> Set of ws clients

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const conversationId = url.searchParams.get('conversationId');

  if (url.pathname === '/ws' && conversationId) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, conversationId);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws, request, conversationId) => {
  console.log(`🔌 WebSocket connected for conversation ${conversationId}`);
  
  if (!conversationClients.has(conversationId)) {
    conversationClients.set(conversationId, new Set());
  }
  conversationClients.get(conversationId).add(ws);

  ws.on('close', () => {
    console.log(`🔌 WebSocket disconnected for conversation ${conversationId}`);
    if (conversationClients.has(conversationId)) {
      conversationClients.get(conversationId).delete(ws);
      if (conversationClients.get(conversationId).size === 0) {
        conversationClients.delete(conversationId);
      }
    }
  });
});

function broadcastToConversation(conversationId, event) {
  const clients = conversationClients.get(conversationId);
  if (clients) {
    const message = JSON.stringify(event);
    clients.forEach(client => {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(message);
      }
    });
  }
}

// Initialize OpenAI client
const openaiClient = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Middleware
app.use(express.json());
app.use(express.static(__dirname));

// Enable CORS for local development
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  next();
});

// Store conversation history
const conversations = new Map();

// Load agent prompts from files
const TOOLS_USAGE = readFileSync(path.join(__dirname, 'prompts', 'tools-usage.txt'), 'utf-8');
const BACKEND_PROMPT = readFileSync(path.join(__dirname, 'prompts', 'backend-agent.txt'), 'utf-8') + '\n\n' + TOOLS_USAGE;
const DEVOPS_PROMPT = readFileSync(path.join(__dirname, 'prompts', 'devops-agent.txt'), 'utf-8') + '\n\n' + TOOLS_USAGE;
const FRONTEND_PROMPT = readFileSync(path.join(__dirname, 'prompts', 'frontend-agent.txt'), 'utf-8') + '\n\n' + TOOLS_USAGE;

function buildWorkspaceContext() {
  let files = [];
  try {
    files = fileTools.listFiles('.');
  } catch (error) {
    console.error('⚠️  Failed to list workspace files for prompt context:', error.message);
  }

  files = Array.isArray(files) ? files.sort() : [];

  const fileList = files.length
    ? files.map(file => `- ${file}`).join('\n')
    : '- (none yet — workspace is empty)';

  return `\n\nCURRENT WORKSPACE FILES:\n${fileList}\n`;
}

/**
 * Agent class - Autonomous agent that listens to messages and responds
 */
class Agent {
  constructor(name, systemPrompt, conversationId, messageBus) {
    this.name = name;
    this.systemPrompt = systemPrompt;
    this.conversationId = conversationId;
    this.messageBus = messageBus;
    this.conversationHistory = [];
    this.talkCallCount = 0;
    this.maxTalkCalls = 30;
    this.isComplete = false;
    this.lastActivityTime = Date.now();
    this.textOnlyResponses = 0; // Track consecutive text-only responses
    this.inbox = [];
    this.isProcessing = false;
    this.needsAnotherRun = false;
    
    // Subscribe to messages for this agent
    this.messageBus.on(`message:${this.name}`, this.handleMessage.bind(this));
    
    console.log(`🤖 Agent '${this.name}' initialized for conversation ${conversationId}`);
  }
  
  updateActivity() {
    this.lastActivityTime = Date.now();
  }
  
  getIdleTime() {
    return Date.now() - this.lastActivityTime;
  }

  _sanitizeArgs(args = {}) {
    const clone = JSON.parse(JSON.stringify(args));
    const truncate = (value) => {
      if (typeof value !== 'string') return value;
      return value.length > 200 ? `${value.slice(0, 200)}...` : value;
    };

    ['content', 'old_string', 'new_string', 'message'].forEach((key) => {
      if (clone[key]) {
        clone[key] = truncate(clone[key]);
      }
    });

    return clone;
  }
  
  _getErrorGuidance(functionName, errorMessage) {
    if (errorMessage.includes('File already exists')) {
      return 'The file you tried to create already exists. Use str_replace() to modify it, or use read_file() to check its current content first.';
    } else if (errorMessage.includes('File not found')) {
      return 'The file does not exist. Use create_file() to create it first, or use list_files() to check what files exist.';
    } else if (errorMessage.includes('locked by')) {
      return 'Another agent is currently modifying this file. Wait a moment and try again, or work on a different file.';
    } else if (errorMessage.includes('String not found')) {
      return 'The old_string you specified was not found in the file. Use read_file() to check the current file content.';
    }
    return 'Check the error message and try a different approach.';
  }

  _queueMessage(message) {
    if (!message) return;
    this.inbox.push(message);
    console.log(`📥 ${this.name.toUpperCase()} queued message from ${message.from}. Inbox size: ${this.inbox.length}`);
    this._broadcastInboxEvent('received', {
      from: message.from,
      preview: this._truncateText(message.content, 50)
    });
  }

  _broadcastInboxEvent(action, extra = {}) {
    this.messageBus.emit('ws:broadcast', this.conversationId, {
      type: 'agent:inbox',
      agent: this.name,
      action,
      count: this.inbox.length,
      ...extra,
      timestamp: new Date().toISOString()
    });
  }

  _truncateText(text, length = 160) {
    if (!text) return '';
    return text.length > length ? `${text.slice(0, length)}...` : text;
  }

  _resumeFromCompletion(reason) {
    if (!this.isComplete) return;
    this.isComplete = false;
    this.messageBus.emit('agent:resumed', {
      conversationId: this.conversationId,
      agentName: this.name,
      reason
    });
    this.messageBus.emit('ws:broadcast', this.conversationId, {
      type: 'agent:status',
      agent: this.name,
      status: 'thinking',
      timestamp: new Date().toISOString()
    });
  }

  async _processQueue() {
    if (this.isProcessing) return;
    this.isProcessing = true;
    try {
      while (this.needsAnotherRun && !this.isComplete) {
        this.needsAnotherRun = false;
        await this._executeAgentTurn();
      }
    } finally {
      this.isProcessing = false;
    }
  }

  _buildMessages() {
    const messages = [
      { role: 'system', content: this.systemPrompt },
      ...this.conversationHistory
    ];

    if (this.inbox.length > 0) {
      messages.push({
        role: 'system',
        content: `You have ${this.inbox.length} unread message(s) waiting in your inbox. Use read_message() to read the latest message (most recent first) before responding.`
      });
    }

    return messages;
  }

  _deliverMessageImmediately(message) {
    if (!message) return;
    this.conversationHistory.push({
      role: 'user',
      content: `Message from ${message.from}: ${message.content}`
    });
    this.messageBus.emit('ws:broadcast', this.conversationId, {
      type: 'agent:message',
      agent: this.name,
      from: message.from,
      content: this._truncateText(message.content, 200),
      delivery: 'immediate',
      timestamp: new Date().toISOString()
    });
  }

  _readNextInboxMessage() {
    if (this.inbox.length === 0) {
      return {
        response: 'Inbox empty. No unread messages.',
        messageRead: false
      };
    }

    const message = this.inbox.pop();
    const formatted = `Message from ${message.from}: ${message.content}`;
    this.conversationHistory.push({
      role: 'user',
      content: formatted
    });

    this._broadcastInboxEvent('read', {
      from: message.from,
      preview: this._truncateText(message.content, 50)
    });

    console.log(`📖 ${this.name.toUpperCase()} read message from ${message.from}. Remaining inbox: ${this.inbox.length}`);

    return {
      response: formatted,
      messageRead: true
    };
  }
  
  /**
   * Handle incoming messages / triggers
   */
  async handleMessage(message) {
    this.updateActivity();

    if (message) {
      const shouldQueue = message.queue === true;
      if (shouldQueue) {
        this._queueMessage(message);
        if (this.isComplete) {
          this._resumeFromCompletion('message_received');
        }
      } else {
        this._deliverMessageImmediately(message);
      }
    }

    if (this.isComplete && !message) {
      console.log(`⏹️  Agent '${this.name}' is complete and no new work to process.`);
      return;
    }

    this.needsAnotherRun = true;
    await this._processQueue();
  }

  /**
   * Execute one agent reasoning turn
   */
  async _executeAgentTurn() {
    if (this.isComplete) {
      return;
    }

    try {
      this.messageBus.emit('ws:broadcast', this.conversationId, {
        type: 'agent:status',
        agent: this.name,
        status: 'thinking',
        timestamp: new Date().toISOString()
      });

      if (this.talkCallCount >= this.maxTalkCalls) {
        console.log(`⚠️  Agent '${this.name}' has reached max talk calls (${this.maxTalkCalls}), marking as complete`);
        this.complete();
        return;
      }
      
      console.log(`🧠 Agent '${this.name}' is thinking... (calls remaining: ${this.maxTalkCalls - this.talkCallCount})`);
      
      const messages = this._buildMessages();
      
      const functions = [
        {
          name: 'talk',
          description: `Send a message to another agent. ${this.maxTalkCalls - this.talkCallCount} calls remaining.`,
          parameters: {
            type: 'object',
            properties: {
              agentName: {
                type: 'string',
                enum: ['backend', 'devops', 'frontend'],
                description: 'Agent to message'
              },
              message: {
                type: 'string',
                description: 'Your message'
              }
            },
            required: ['agentName', 'message']
          }
        },
        {
          name: 'read_message',
          description: 'Read the most recent message from your inbox queue.',
          parameters: {
            type: 'object',
            properties: {},
            additionalProperties: false
          }
        },
        {
          name: 'create_file',
          description: 'CREATE a new file NOW. Put the complete file content in the content parameter. DO NOT describe it in text.',
          parameters: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Path like "backend/server.js" or "Dockerfile"'
              },
              content: {
                type: 'string',
                description: 'Complete file content - NOT a description, the ACTUAL code/config'
              }
            },
            required: ['path', 'content']
          }
        },
        {
          name: 'read_file',
          description: 'READ a file to see what it contains.',
          parameters: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Path to read'
              }
            },
            required: ['path']
          }
        },
        {
          name: 'str_replace',
          description: 'MODIFY an existing file by replacing text. old_string must match exactly.',
          parameters: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'File to modify'
              },
              old_string: {
                type: 'string',
                description: 'Exact text to find'
              },
              new_string: {
                type: 'string',
                description: 'Replacement text'
              }
            },
            required: ['path', 'old_string', 'new_string']
          }
        },
        {
          name: 'list_files',
          description: 'LIST all files in a directory.',
          parameters: {
            type: 'object',
            properties: {
              directory: {
                type: 'string',
                description: 'Directory path like "." or "backend/"'
              }
            },
            required: ['directory']
          }
        },
        {
          name: 'create_file',
          description: 'CREATE a new file NOW. Put the complete file content in the content parameter. DO NOT describe it in text.',
          parameters: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Path like "backend/server.js" or "Dockerfile"'
              },
              content: {
                type: 'string',
                description: 'Complete file content - NOT a description, the ACTUAL code/config'
              }
            },
            required: ['path', 'content']
          }
        },
        {
          name: 'read_file',
          description: 'READ a file to see what it contains.',
          parameters: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Path to read'
              }
            },
            required: ['path']
          }
        },
        {
          name: 'str_replace',
          description: 'MODIFY an existing file by replacing text. old_string must match exactly.',
          parameters: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'File to modify'
              },
              old_string: {
                type: 'string',
                description: 'Exact text to find'
              },
              new_string: {
                type: 'string',
                description: 'Replacement text'
              }
            },
            required: ['path', 'old_string', 'new_string']
          }
        },
        {
          name: 'list_files',
          description: 'LIST all files in a directory.',
          parameters: {
            type: 'object',
            properties: {
              directory: {
                type: 'string',
                description: 'Directory path like "." or "backend/"'
              }
            },
            required: ['directory']
          }
        }
      ];
      
      const totalInteractions = this.conversationHistory.filter(m => m.role === 'user').length;
      let functionCallMode;
      
      if (this.talkCallCount === 0) {
        functionCallMode = { name: 'talk' };
      } else if (totalInteractions < 3) {
        functionCallMode = 'auto';
      } else {
        functionCallMode = 'auto';
      }
      
      const result = await openaiClient.chat.completions.create({
        model: 'gpt-4-turbo-preview',
        messages: messages,
        functions: functions,
        function_call: functionCallMode,
        temperature: 0.3,
        max_tokens: 1500
      });
      
      const responseMessage = result.choices[0].message;
      
      if (responseMessage.content) {
        console.log(`\n💭 ${this.name.toUpperCase()} Agent says:`);
        console.log(`   ${responseMessage.content}\n`);
        
        this.messageBus.emit('ws:broadcast', this.conversationId, {
          type: 'agent:thinking',
          agent: this.name,
          content: responseMessage.content,
          timestamp: new Date().toISOString()
        });
      }
      
      if (responseMessage.function_call) {
        this.textOnlyResponses = 0;
        
        const functionName = responseMessage.function_call.name;
        
        try {
          let functionArgs;
          try {
            functionArgs = JSON.parse(responseMessage.function_call.arguments);
          } catch (jsonError) {
            console.error(`⚠️  JSON Parse Error for ${functionName}:`);
            console.error(`   Raw arguments: "${responseMessage.function_call.arguments}"`);
            console.error(`   Error: ${jsonError.message}`);
            
            this.conversationHistory.push({
              role: 'function',
              name: functionName,
              content: `ERROR: JSON parsing failed - ${jsonError.message}

Your function call was incomplete or malformed. This often happens when:
1. The 'content' parameter for create_file is too long and got cut off
2. You didn't close quotes or brackets properly

Try again with:
- Shorter, more focused file content
- Multiple create_file() calls for multiple files instead of one giant file
- Ensure your JSON is valid`
            });

            this.messageBus.emit('ws:broadcast', this.conversationId, {
              type: 'tool:error',
              agent: this.name,
              tool: functionName,
              error: `JSON parse error: ${jsonError.message}`,
              timestamp: new Date().toISOString()
            });
            
            return;
          }
          
          const sanitizedArgs = this._sanitizeArgs(functionArgs);
          this.messageBus.emit('ws:broadcast', this.conversationId, {
            type: 'tool:call',
            agent: this.name,
            tool: functionName,
            args: sanitizedArgs,
            timestamp: new Date().toISOString()
          });

          if (functionName === 'talk') {
            await this.talk(functionArgs.agentName, functionArgs.message);
          } else if (functionName === 'create_file') {
            const result = fileTools.createFile(this.name, functionArgs.path, functionArgs.content);
            console.log(`📝 ${this.name.toUpperCase()} created file: ${functionArgs.path}`);
            
            // Add result to conversation history so agent knows it succeeded
            this.conversationHistory.push({
              role: 'function',
              name: functionName,
              content: result
            });
            
            // Emit file event
            this.messageBus.emit('file:created', {
              agent: this.name,
              path: functionArgs.path,
              timestamp: new Date().toISOString()
            });
            
            this.messageBus.emit('ws:broadcast', this.conversationId, {
              type: 'file:created',
              agent: this.name,
              path: functionArgs.path,
              content: functionArgs.content.substring(0, 200) + '...', // Truncate for WS
              timestamp: new Date().toISOString()
            });

            this.messageBus.emit('ws:broadcast', this.conversationId, {
              type: 'tool:result',
              agent: this.name,
              tool: functionName,
              result,
              timestamp: new Date().toISOString()
            });
            
          } else if (functionName === 'read_file') {
            const content = fileTools.readFile(functionArgs.path);
            console.log(`📖 ${this.name.toUpperCase()} read file: ${functionArgs.path}`);
            
            this.conversationHistory.push({
              role: 'function',
              name: functionName,
              content: content
            });
            
            this.messageBus.emit('ws:broadcast', this.conversationId, {
              type: 'file:read',
              agent: this.name,
              path: functionArgs.path,
              timestamp: new Date().toISOString()
            });

            this.messageBus.emit('ws:broadcast', this.conversationId, {
              type: 'tool:result',
              agent: this.name,
              tool: functionName,
              result: content.length > 200 ? `${content.slice(0, 200)}...` : content,
              timestamp: new Date().toISOString()
            });
            
          } else if (functionName === 'str_replace') {
            const result = fileTools.strReplace(this.name, functionArgs.path, functionArgs.old_string, functionArgs.new_string);
            console.log(`✏️ ${this.name.toUpperCase()} modified file: ${functionArgs.path}`);
            
            this.conversationHistory.push({
              role: 'function',
              name: functionName,
              content: result
            });
            
            this.messageBus.emit('file:modified', {
              agent: this.name,
              path: functionArgs.path,
              timestamp: new Date().toISOString()
            });
            
            this.messageBus.emit('ws:broadcast', this.conversationId, {
              type: 'file:modified',
              agent: this.name,
              path: functionArgs.path,
              changes: `Replaced "${functionArgs.old_string}" with "${functionArgs.new_string}"`,
              timestamp: new Date().toISOString()
            });

            this.messageBus.emit('ws:broadcast', this.conversationId, {
              type: 'tool:result',
              agent: this.name,
              tool: functionName,
              result,
              timestamp: new Date().toISOString()
            });
            
          } else if (functionName === 'list_files') {
            const files = fileTools.listFiles(functionArgs.directory || '.');
            console.log(`📂 ${this.name.toUpperCase()} listed files in: ${functionArgs.directory || '.'}`);
            
            this.conversationHistory.push({
              role: 'function',
              name: functionName,
              content: JSON.stringify(files)
            });
            
            this.messageBus.emit('ws:broadcast', this.conversationId, {
              type: 'file:list',
              agent: this.name,
              directory: functionArgs.directory || '.',
              files: files,
              timestamp: new Date().toISOString()
            });

            this.messageBus.emit('ws:broadcast', this.conversationId, {
              type: 'tool:result',
              agent: this.name,
              tool: functionName,
              result: `Found ${files.length} file(s)`,
              timestamp: new Date().toISOString()
            });
          } else if (functionName === 'read_message') {
            const delivery = this._readNextInboxMessage();
            this.conversationHistory.push({
              role: 'function',
              name: functionName,
              content: delivery.response
            });

            if (delivery.messageRead) {
              this.needsAnotherRun = true;
            }
          }
          
        } catch (error) {
          console.error(`⚠️  Error executing function ${functionName}: ${error.message}`);
          
          // Add detailed error to conversation history so agent can adapt
          this.conversationHistory.push({
            role: 'function',
            name: functionName,
            content: `ERROR: ${error.message}\n\nWhat went wrong: ${this._getErrorGuidance(functionName, error.message)}`
          });
          
          // Emit error event to WebSocket
          this.messageBus.emit('ws:broadcast', this.conversationId, {
            type: 'tool:error',
            agent: this.name,
            tool: functionName,
            error: error.message,
            timestamp: new Date().toISOString()
          });
        }
      } else {
        // Agent responded with text but no function call
        this.textOnlyResponses++;
        
        if (this.textOnlyResponses >= 2) {
          // After 2 consecutive text-only responses, assume they're done
          console.log(`✅ Agent '${this.name}' chose not to continue (${this.textOnlyResponses} text-only responses)`);
          this.complete();
        } else {
          // First text-only response - give them a nudge to take action
          console.log(`⚠️  Agent '${this.name}' responded with text only (${this.textOnlyResponses}/2)`);
          
          // Send immediate nudge to take action
          setTimeout(() => {
            if (!this.isComplete) {
              console.log(`🔔 Re-prompting '${this.name}' to take action...`);
              this.messageBus.emit(`message:${this.name}`, {
                from: 'system',
                to: this.name,
                content: `You just provided a text response without calling any function. To make progress:

- If you're DONE with all your work: Respond with text only again and you'll be marked complete.
- If you have MORE work to do: Use create_file(), read_file(), list_files(), or str_replace() to actually implement what you just described.
- If you're waiting for info: Use read_file() or list_files() to discover it yourself, or use talk() to ask and KEEP WORKING simultaneously.

What action will you take now?`,
                timestamp: new Date().toISOString()
              });
            }
          }, 2000); // Small delay
        }
      }
      
    } catch (error) {
      console.error(`❌ Error in agent '${this.name}':`, error.message);
      this.complete();
    }
  }
  
  /**
   * Talk function - Send message to another agent
   */
  async talk(agentName, message) {
    if (this.talkCallCount >= this.maxTalkCalls) {
      const errorMsg = `Cannot talk: Agent '${this.name}' has reached maximum talk calls (${this.maxTalkCalls})`;
      console.log(`⛔ ${errorMsg}`);
      return errorMsg;
    }
    
    this.talkCallCount++;
    console.log(`\n💬 ${this.name.toUpperCase()} Agent calling talk() [${this.talkCallCount}/${this.maxTalkCalls}] -> '${agentName}':`);
    console.log(`   "${message}"\n`);
    
    // Emit message to the message bus
    this.messageBus.emit(`message:${agentName}`, {
      from: this.name,
      to: agentName,
      content: message,
      timestamp: new Date().toISOString(),
      queue: true
    });
    
    // Emit event for WebSocket
    this.messageBus.emit('ws:broadcast', this.conversationId, {
      type: 'agent:talk',
      agent: this.name,
      to: agentName,
      message: message,
      callNum: this.talkCallCount,
      timestamp: new Date().toISOString()
    });
    
    // Store in conversation history
    this.messageBus.emit('conversation:message', {
      conversationId: this.conversationId,
      agent: this.name,
      message: message,
      callCount: this.talkCallCount,
      timestamp: new Date().toISOString()
    });
    
    // Check if we've reached the limit
    if (this.talkCallCount >= this.maxTalkCalls) {
      console.log(`⚠️  Agent '${this.name}' has used all talk calls, marking as complete`);
      this.complete();
    }
    
    return `Message sent successfully to ${agentName}`;
  }
  
  /**
   * Mark this agent as complete
   */
  complete() {
    if (!this.isComplete) {
      this.isComplete = true;
      console.log(`🏁 Agent '${this.name}' marked as complete`);
      this.messageBus.emit('agent:complete', {
        conversationId: this.conversationId,
        agentName: this.name
      });
      
      this.messageBus.emit('ws:broadcast', this.conversationId, {
        type: 'agent:status',
        agent: this.name,
        status: 'complete',
        timestamp: new Date().toISOString()
      });
    }
  }
}

/**
 * POST /start-conversation
 * Start an autonomous conversation between Backend and DevOps agents
 */
app.post('/start-conversation', async (req, res) => {
  try {
    const { topic } = req.body;

    if (!topic) {
      return res.status(400).json({ 
        error: 'Topic is required',
        example: { topic: 'Design a microservices architecture for an e-commerce platform' }
      });
    }

    const conversationId = Date.now().toString();
    const messageBus = new EventEmitter();
    const fullConversation = [];
    const completedAgents = new Set();
    
    console.log(`\n${'='.repeat(80)}`);
    console.log(`🚀 Starting autonomous conversation ${conversationId}`);
    console.log(`📝 Topic: "${topic}"`);
    console.log(`${'='.repeat(80)}\n`);

    // Collect messages as they happen
    messageBus.on('conversation:message', (data) => {
      fullConversation.push({
        agent: data.agent,
        message: data.message,
        callCount: data.callCount,
        timestamp: data.timestamp
      });
    });
    
    // Setup WebSocket broadcaster
    messageBus.on('ws:broadcast', (convId, event) => {
      if (convId === conversationId) {
        broadcastToConversation(convId, event);
      }
    });
    
    // Track agent completion
    messageBus.on('agent:complete', (data) => {
      completedAgents.add(data.agentName);
      console.log(`\n✓ Agent '${data.agentName}' completed (${completedAgents.size}/3 agents done)\n`);
    });
    
    messageBus.on('agent:resumed', (data) => {
      if (completedAgents.has(data.agentName)) {
        completedAgents.delete(data.agentName);
      }
      console.log(`\n↺ Agent '${data.agentName}' resumed work (reason: ${data.reason || 'new message'})\n`);
    });
    
    const workspaceContext = buildWorkspaceContext();
    // Create all three agents with workspace awareness
    const backendAgent = new Agent('backend', BACKEND_PROMPT + workspaceContext, conversationId, messageBus);
    const devopsAgent = new Agent('devops', DEVOPS_PROMPT + workspaceContext, conversationId, messageBus);
    const frontendAgent = new Agent('frontend', FRONTEND_PROMPT + workspaceContext, conversationId, messageBus);
    
    const agents = { backend: backendAgent, devops: devopsAgent, frontend: frontendAgent };
    
    // Nudge mechanism: check for idle agents periodically
    const nudgeInterval = setInterval(() => {
      const IDLE_THRESHOLD = 20000; // 20 seconds of inactivity
      
      for (const [name, agent] of Object.entries(agents)) {
        if (!agent.isComplete && agent.getIdleTime() > IDLE_THRESHOLD) {
          console.log(`⏰ Nudging idle agent: ${name} (idle for ${Math.round(agent.getIdleTime()/1000)}s)`);
          
          messageBus.emit(`message:${name}`, {
            from: 'system',
            to: name,
            content: `You've been idle for a while. What are your next steps?
            
- If you're waiting for another agent's response: Check their files with list_files() or read_file() instead of waiting. They may have already created what you need.
- If you have more work to do: Continue implementing. Use create_file() to write more files.
- If you asked a question and are waiting: DON'T WAIT. Make reasonable assumptions and keep building.
- If you're truly done with your work: Mark yourself as complete.

Remember: Your goal is to deliver a COMPLETE implementation, not a partial one. If you've only created 1-2 files, you're probably not done yet.`,
            timestamp: new Date().toISOString()
          });
          
          agent.updateActivity(); // Reset timer after nudge
        }
      }
    }, 15000); // Check every 15 seconds
    
    // Notify WebSocket clients that conversation started
    setTimeout(() => {
      broadcastToConversation(conversationId, {
        type: 'conversation:started',
        conversationId,
        topic,
        timestamp: new Date().toISOString()
      });
    }, 500);
    
    // Create a promise that resolves when conversation is complete
    const conversationComplete = new Promise((resolve, reject) => {
      // Store timeout ID so we can clear it if needed
      const timeoutId = setTimeout(() => {
        console.log('\n⏰ Conversation timeout reached (3 minutes)\n');
        resolve('timeout');
      }, 180000); // 3 minutes timeout
      
      // Store resolve function to manually stop
      conversations.set(conversationId + '_control', { resolve, timeoutId });
      
      // Check for completion
      const checkComplete = () => {
        if (completedAgents.size >= 3) {
          clearTimeout(timeoutId);
          console.log('\n🎉 All 3 agents have completed!\n');
          resolve('complete');
        }
      };
      
      messageBus.on('agent:complete', checkComplete);
    });
    
    // Start the conversation by sending initial message to ALL agents
    setTimeout(() => {
      const initialMsg = {
        from: 'system',
        content: `Let's discuss: ${topic}. Please analyze this request from your domain perspective (Backend, Frontend, or DevOps). Use the talk function to coordinate with other agents as needed.`,
        timestamp: new Date().toISOString()
      };
      
      messageBus.emit('message:backend', { ...initialMsg, to: 'backend' });
      messageBus.emit('message:frontend', { ...initialMsg, to: 'frontend' });
      messageBus.emit('message:devops', { ...initialMsg, to: 'devops' });
    }, 1000); // Increased delay to allow WS connection
    
    // Handle conversation completion in background
    conversationComplete.then(result => {
      // Stop nudging
      clearInterval(nudgeInterval);
      
      // Broadcast completion
      broadcastToConversation(conversationId, {
        type: 'conversation:complete',
        conversationId,
        summary: `Conversation completed with ${fullConversation.length} messages exchanged`,
        status: result,
        timestamp: new Date().toISOString()
      });
      
      // Update stored conversation with final status
      const stored = conversations.get(conversationId);
      if (stored) {
        stored.status = result;
        stored.conversation = fullConversation;
      }
      
      console.log(`\n${'='.repeat(80)}`);
      console.log(`✅ Conversation ${conversationId} finished`);
      console.log(`📊 Total messages exchanged: ${fullConversation.length}`);
      console.log(`${'='.repeat(80)}\n`);
    });
    
    // Store conversation initially
    conversations.set(conversationId, {
      topic,
      conversation: fullConversation,
      createdAt: new Date().toISOString(),
      status: 'active'
    });

    // Return immediately
    res.json({
      success: true,
      conversationId,
      topic,
      message: 'Conversation started successfully. Connect to WebSocket for updates.',
      wsUrl: `ws://${req.headers.host}/ws?conversationId=${conversationId}`
    });

  } catch (error) {
    console.error('❌ Error in conversation:', error);
    res.status(500).json({ 
      error: 'Failed to conduct conversation',
      details: error.message 
    });
  }
});

/**
 * POST /stop-conversation
 * Stop a running conversation
 */
app.post('/stop-conversation', (req, res) => {
  const { conversationId } = req.body;
  
  if (!conversationId) {
    return res.status(400).json({ error: 'Conversation ID is required' });
  }
  
  const control = conversations.get(conversationId + '_control');
  
  if (control) {
    clearTimeout(control.timeoutId);
    control.resolve('stopped_by_user');
    
    console.log(`\n🛑 Conversation ${conversationId} stopped by user\n`);
    
    return res.json({ success: true, message: 'Conversation stopped' });
  }
  
  res.status(404).json({ error: 'Conversation control not found or already finished' });
});

/**
 * POST /wipe-workspace
 * Clears the /tmp/project workspace
 */
app.post('/wipe-workspace', (req, res) => {
  try {
    const { conversationId: targetConversationId } = req.body || {};
    fileTools.wipeWorkspace();

    const eventPayload = {
      type: 'workspace:wiped',
      timestamp: new Date().toISOString(),
      message: 'Workspace reset to empty state'
    };

    if (targetConversationId) {
      broadcastToConversation(targetConversationId, eventPayload);
    } else {
      for (const convId of conversationClients.keys()) {
        broadcastToConversation(convId, eventPayload);
      }
    }

    res.json({ success: true, message: 'Workspace wiped successfully' });
  } catch (error) {
    console.error('❌ Failed to wipe workspace:', error);
    res.status(500).json({ error: 'Failed to wipe workspace', details: error.message });
  }
});

/**
 * GET /conversations/:id
 * Retrieve a past conversation
 */
app.get('/conversations/:id', (req, res) => {
  const { id } = req.params;
  const conversation = conversations.get(id);

  if (!conversation) {
    return res.status(404).json({ error: 'Conversation not found' });
  }

  res.json(conversation);
});

/**
 * GET /conversations
 * List all conversations
 */
app.get('/conversations', (req, res) => {
  const allConversations = Array.from(conversations.entries()).map(([id, data]) => ({
    id,
    topic: data.topic,
    createdAt: data.createdAt,
    messageCount: data.conversation.length,
    status: data.status
  }));

  res.json({ conversations: allConversations });
});

/**
 * GET /health
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    openaiConfigured: !!process.env.OPENAI_API_KEY,
    version: '2.0-autonomous'
  });
});

// Root endpoint - serve HTML client
app.get('/', (req, res) => {
  // If Accept header includes text/html, serve the HTML client
  if (req.headers.accept && req.headers.accept.includes('text/html')) {
    res.sendFile(path.join(__dirname, 'client-enhanced.html'));
  } else {
    // Otherwise, return JSON API info
    res.json({
      message: 'AI Agents Conversation Server - Autonomous Edition',
      version: '2.0',
      architecture: 'Pub/Sub with EventEmitter',
      endpoints: {
        'GET /': 'Web client interface',
        'POST /start-conversation': 'Start an autonomous conversation between agents',
        'GET /conversations': 'List all conversations',
        'GET /conversations/:id': 'Get a specific conversation',
        'GET /health': 'Health check'
      },
      example: {
        endpoint: 'POST /start-conversation',
        body: {
          topic: 'Design a microservices architecture for an e-commerce platform'
        }
      },
      features: [
        'Autonomous agents with Vercel AI SDK',
        'Pub/Sub architecture using EventEmitter',
        'Function calling with talk() function',
        'Max 3 talk calls per agent',
        'Agents decide when to complete'
      ],
      webClient: `Open http://localhost:${port} in your browser for the web interface`
    });
  }
});

server.listen(port, () => {
  console.log(`\n🤖 AI Agents Conversation Server v2.0 (Autonomous)`);
  console.log(`🚀 Running on http://localhost:${port}`);
  console.log(`\n🌐 Web Interface: http://localhost:${port}`);
  console.log(`   Open in your browser for a beautiful UI!\n`);
  console.log(`📋 API Endpoints:`);
  console.log(`   POST http://localhost:${port}/start-conversation`);
  console.log(`   GET  http://localhost:${port}/conversations`);
  console.log(`   GET  http://localhost:${port}/conversations/:id`);
  console.log(`   GET  http://localhost:${port}/health`);
  console.log(`\n✨ Features:`);
  console.log(`   - Autonomous agents with Vercel AI SDK`);
  console.log(`   - Pub/Sub architecture (EventEmitter)`);
  console.log(`   - Function calling with talk() function`);
  console.log(`   - Max 3 calls per agent\n`);
});
