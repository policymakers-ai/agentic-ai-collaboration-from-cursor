import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { EventEmitter } from 'events';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, unlinkSync, statSync } from 'fs';
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

    // Check if file already exists
    if (existsSync(fullPath)) {
      throw new Error(
        `File "${filePath}" already exists. To modify an existing file, you must:\n` +
        `1. Use read_file("${filePath}") to read the current content\n` +
        `2. Use str_replace("${filePath}", old_string, new_string) to make changes\n` +
        `The create_file() function can only be used to create NEW files that don't exist yet.`
      );
    }

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

  deleteFile(agentName, filePath) {
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
      
      // Ensure it's a file, not a directory
      const stats = statSync(fullPath);
      if (stats.isDirectory()) {
        throw new Error(`Cannot delete directory: ${filePath}. Use file path only.`);
      }
      
      unlinkSync(fullPath);
      return `Successfully deleted file: ${filePath}`;
    } finally {
      this.lockManager.releaseLock(filePath, agentName);
    }
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
      if (functionName === 'delete_file') {
        return 'The file does not exist. Use list_files() to check what files exist before deleting.';
      }
      return 'The file does not exist. Use create_file() to create it first, or use list_files() to check what files exist.';
    } else if (errorMessage.includes('locked by')) {
      return 'Another agent is currently modifying this file. Wait a moment and try again, or work on a different file.';
    } else if (errorMessage.includes('String not found')) {
      return 'The old_string you specified was not found in the file. Use read_file() to check the current file content.';
    } else if (errorMessage.includes('Cannot delete directory')) {
      return 'You tried to delete a directory. delete_file() only works on files. Use list_files() to see the file structure.';
    } else if (errorMessage.includes('Access denied')) {
      return 'The path you specified is outside the allowed workspace (/tmp/project). Use only paths within the project folder.';
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
    // Build agent-specific folder context
    const agentFolderMap = {
      'backend': 'backend',
      'frontend': 'frontend',
      'devops': 'devops'
    };
    
    const agentFolder = agentFolderMap[this.name] || '';
    let folderContext = '';
    
    if (agentFolder) {
      try {
        const folderFiles = fileTools.listFiles(agentFolder);
        if (folderFiles.length > 0) {
          const fileContents = [];
          for (const relativePath of folderFiles) {
            // Construct full path relative to workspace root
            const fullPath = path.join(agentFolder, relativePath);
            try {
              const content = fileTools.readFile(fullPath);
              fileContents.push(`=== ${fullPath} ===\n${content}\n`);
            } catch (err) {
              // Skip files that can't be read (might be locked or deleted)
              continue;
            }
          }
          
          if (fileContents.length > 0) {
            folderContext = `\n\nYOUR FOLDER FILES (${agentFolder}/):\n${fileContents.join('\n')}\n`;
            folderContext += `\nNOTE: You can ONLY see files from your ${agentFolder}/ folder automatically. For other files, use read_file() to look them up.\n`;
          }
        }
      } catch (error) {
        // Folder doesn't exist yet or can't be accessed - that's fine
      }
    }
    
    const systemContent = this.systemPrompt + folderContext;
    
    const messages = [
      { role: 'system', content: systemContent },
      ...this.conversationHistory
    ];

    // CRITICAL: Verify that ALL assistant messages with tool_calls have all tool responses
    // OpenAI requires EVERY assistant message with tool_calls to be immediately followed by tool responses
    // We must check ALL of them, not just the most recent one (race condition fix)
    const assistantMessagesWithToolCalls = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        assistantMessagesWithToolCalls.push({ index: i, message: msg });
      }
    }
    
    // Check each assistant message with tool_calls (from oldest to newest to maintain indices)
    for (const { index: i, message: msg } of assistantMessagesWithToolCalls) {
      console.log(`🔍 [${this.name}] _buildMessages: Checking assistant message at index ${i} with ${msg.tool_calls.length} tool_calls`);
      // Find all tool responses that follow this assistant message (until next assistant message)
      const toolResponseIds = new Set();
      const foundToolCallIds = [];
      const nextAssistantIndex = assistantMessagesWithToolCalls.find(am => am.index > i)?.index ?? messages.length;
      
      for (let j = i + 1; j < nextAssistantIndex; j++) {
        if (messages[j].role === 'tool' && messages[j].tool_call_id) {
          toolResponseIds.add(messages[j].tool_call_id);
          foundToolCallIds.push(messages[j].tool_call_id);
        }
      }
      
      // Check if all tool_call_ids have responses
      const missingIds = msg.tool_calls.filter(tc => !toolResponseIds.has(tc.id));
      const requiredIds = msg.tool_calls.map(tc => tc.id);
      console.log(`🔍 [${this.name}] _buildMessages: Required IDs: ${requiredIds.join(', ')}`);
      console.log(`🔍 [${this.name}] _buildMessages: Found IDs: ${foundToolCallIds.join(', ')}`);
      console.log(`🔍 [${this.name}] _buildMessages: Found ${toolResponseIds.size} tool responses, need ${msg.tool_calls.length}, missing: ${missingIds.length}`);
      
      if (missingIds.length > 0) {
        console.error(`❌ [${this.name}] CRITICAL: Assistant message at index ${i} missing responses for: ${missingIds.map(tc => tc.id).join(', ')}`);
        // Add missing responses immediately after the assistant message
        // Insert them in reverse order so indices don't shift
        for (let k = missingIds.length - 1; k >= 0; k--) {
          const toolCall = missingIds[k];
          const errorResponse = {
            role: 'tool',
            tool_call_id: toolCall.id,
            content: `ERROR: Tool call was not processed. This may be due to an internal error.`
          };
          messages.splice(i + 1, 0, errorResponse);
          // Update indices for remaining assistant messages
          for (let amIdx = 0; amIdx < assistantMessagesWithToolCalls.length; amIdx++) {
            if (assistantMessagesWithToolCalls[amIdx].index > i) {
              assistantMessagesWithToolCalls[amIdx].index++;
            }
          }
          // Also add to conversation history for future calls
          const historyIndex = this.conversationHistory.findIndex(m => 
            m.role === 'assistant' && 
            m.tool_calls && 
            m.tool_calls.some(tc => tc.id === toolCall.id)
          );
          if (historyIndex >= 0) {
            this.conversationHistory.splice(historyIndex + 1, 0, errorResponse);
          }
        }
        console.log(`✅ [${this.name}] Added ${missingIds.length} missing tool responses in _buildMessages()`);
      } else {
        console.log(`✅ [${this.name}] Assistant message at index ${i} has all tool responses`);
      }
    }

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
    if (message.autoRun) {
      this.needsAnotherRun = true;
      this._processQueue();
    }
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
          name: 'delete_file',
          description: 'DELETE a file from the workspace. Path must be within /tmp/project. Cannot delete directories.',
          parameters: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'File path to delete, e.g., "backend/server.js" or "frontend/index.html"'
              }
            },
            required: ['path']
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
      let toolChoice = 'auto';
      
      // Convert functions to tools format for newer API
      const tools = functions.map(fn => ({
        type: 'function',
        function: fn
      }));
      
      // Final verification before API call - check ALL assistant messages with tool_calls
      const allAssistantMsgs = [];
      for (let i = 0; i < messages.length; i++) {
        if (messages[i].role === 'assistant' && messages[i].tool_calls && messages[i].tool_calls.length > 0) {
          allAssistantMsgs.push({ index: i, msg: messages[i] });
        }
      }
      
      let anyMissing = false;
      for (const { index: i, msg } of allAssistantMsgs) {
        const toolResponseIds = new Set();
        const nextAssistantIndex = allAssistantMsgs.find(am => am.index > i)?.index ?? messages.length;
        
        for (let j = i + 1; j < nextAssistantIndex; j++) {
          if (messages[j].role === 'tool' && messages[j].tool_call_id) {
            toolResponseIds.add(messages[j].tool_call_id);
          }
        }
        
        const missing = msg.tool_calls.filter(tc => !toolResponseIds.has(tc.id));
        if (missing.length > 0) {
          anyMissing = true;
          console.error(`❌ [${this.name}] FINAL CHECK: Assistant at index ${i} missing responses for: ${missing.map(tc => tc.id).join(', ')}`);
          // Force add them RIGHT AFTER the assistant message
          for (let k = missing.length - 1; k >= 0; k--) {
            const toolCall = missing[k];
            const errorResponse = {
              role: 'tool',
              tool_call_id: toolCall.id,
              content: `ERROR: Tool call was not processed. This may be due to an internal error.`
            };
            messages.splice(i + 1, 0, errorResponse);
            // Update indices for remaining assistant messages
            for (let amIdx = 0; amIdx < allAssistantMsgs.length; amIdx++) {
              if (allAssistantMsgs[amIdx].index > i) {
                allAssistantMsgs[amIdx].index++;
              }
            }
            console.log(`✅ [${this.name}] FINAL CHECK: Added missing response for ${toolCall.id} at index ${i + 1}`);
          }
        }
      }
      
      if (!anyMissing && allAssistantMsgs.length > 0) {
        console.log(`✅ [${this.name}] FINAL CHECK: All ${allAssistantMsgs.length} assistant message(s) with tool_calls have all responses`);
      }
      
      // DEBUG: Log the actual messages structure being sent to OpenAI
      if (allAssistantMsgs.length > 0) {
        console.log(`🔍 [${this.name}] DEBUG: Messages array structure before API call:`);
        for (const { index: i, msg } of allAssistantMsgs) {
          const nextAssistantIndex = allAssistantMsgs.find(am => am.index > i)?.index ?? messages.length;
          const followingMessages = messages.slice(i, Math.min(i + 5, nextAssistantIndex));
          console.log(`   Assistant at ${i}: ${msg.tool_calls.length} tool_calls, following messages: ${followingMessages.map(m => `${m.role}${m.tool_call_id ? `(tool_call_id:${m.tool_call_id})` : ''}`).join(', ')}`);
        }
      }
      
      const result = await openaiClient.chat.completions.create({
        model: 'gpt-5.1',
        messages: messages,
        tools: tools,
        tool_choice: toolChoice,
        temperature: 0.3,
        max_completion_tokens: 1500
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
      
      if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
        // Add assistant message with tool_calls to history BEFORE processing tool calls
        // This ensures tool responses can reference the tool_call_ids
        this.conversationHistory.push({
          role: 'assistant',
          content: responseMessage.content || null,
          tool_calls: responseMessage.tool_calls
        });
        // CRITICAL: Track the assistant message - we must insert tool responses IMMEDIATELY after it
        // Use a helper function to find the insertion point (right after the assistant message)
        const getToolResponseInsertionIndex = () => {
          // Find the most recent assistant message with tool_calls that matches our responseMessage
          for (let idx = this.conversationHistory.length - 1; idx >= 0; idx--) {
            const msg = this.conversationHistory[idx];
            if (msg.role === 'assistant' && msg.tool_calls && 
                msg.tool_calls.some(tc => responseMessage.tool_calls.some(rtc => rtc.id === tc.id))) {
              // Found it - check what's at idx+1
              const nextIdx = idx + 1;
              const nextMsg = this.conversationHistory[nextIdx];
              console.log(`📍 [${this.name}] Found assistant message at index ${idx}, next index ${nextIdx} has: ${nextMsg ? nextMsg.role : 'nothing'}`);
              // Count how many tool responses already exist for this assistant message
              let toolResponseCount = 0;
              for (let j = nextIdx; j < this.conversationHistory.length; j++) {
                const checkMsg = this.conversationHistory[j];
                if (checkMsg.role === 'tool' && checkMsg.tool_call_id && 
                    msg.tool_calls.some(tc => tc.id === checkMsg.tool_call_id)) {
                  toolResponseCount++;
                } else if (checkMsg.role === 'assistant') {
                  break; // Stop at next assistant message
                }
              }
              console.log(`📍 [${this.name}] Assistant message has ${toolResponseCount} tool responses already, will insert at index ${nextIdx + toolResponseCount}`);
              return nextIdx + toolResponseCount;
            }
          }
          // Fallback: insert at end
          console.warn(`⚠️  [${this.name}] Could not find assistant message, inserting at end (index ${this.conversationHistory.length})`);
          return this.conversationHistory.length;
        };
        
        this.textOnlyResponses = 0;
        
        // Track which tool_call_ids have been processed
        const processedToolCallIds = new Set();
        // Collect system messages to add AFTER all tool responses (OpenAI requires tool responses to be consecutive)
        const deferredSystemMessages = [];
        
        try {
          // Process each tool call
          for (const toolCall of responseMessage.tool_calls) {
          const functionName = toolCall.function.name;
          const toolCallId = toolCall.id;
          console.log(`🔧 [${this.name}] Processing tool call: ${functionName} (${toolCallId})`);
          
          let functionArgs;
          try {
            functionArgs = JSON.parse(toolCall.function.arguments);
          } catch (jsonError) {
              console.error(`⚠️  JSON Parse Error for ${functionName}:`);
              console.error(`   Raw arguments: "${toolCall.function.arguments}"`);
              console.error(`   Error: ${jsonError.message}`);
              
              // CRITICAL: Insert tool response IMMEDIATELY after assistant message
              const insertIndex = getToolResponseInsertionIndex();
              this.conversationHistory.splice(insertIndex, 0, {
                role: 'tool',
                tool_call_id: toolCallId,
                content: `ERROR: JSON parsing failed - ${jsonError.message}

Your function call was incomplete or malformed. This often happens when:
1. The 'content' parameter for create_file is too long and got cut off
2. You didn't close quotes or brackets properly

Try again with:
- Shorter, more focused file content
- Multiple create_file() calls for multiple files instead of one giant file
- Ensure your JSON is valid`
              });
              processedToolCallIds.add(toolCallId);

              this.messageBus.emit('ws:broadcast', this.conversationId, {
                type: 'tool:error',
                agent: this.name,
                tool: functionName,
                error: `JSON parse error: ${jsonError.message}`,
                timestamp: new Date().toISOString()
              });
              
              continue; // Skip this tool call and process next one
          }
          
          const sanitizedArgs = this._sanitizeArgs(functionArgs);
          this.messageBus.emit('ws:broadcast', this.conversationId, {
            type: 'tool:call',
            agent: this.name,
            tool: functionName,
            args: sanitizedArgs,
            timestamp: new Date().toISOString()
          });

          try {
            if (functionName === 'talk') {
              const result = await this.talk(functionArgs.agentName, functionArgs.message);
              // CRITICAL: Insert tool response IMMEDIATELY after assistant message
              const insertIndex = getToolResponseInsertionIndex();
              this.conversationHistory.splice(insertIndex, 0, {
                role: 'tool',
                tool_call_id: toolCallId,
                content: result || `Message sent to ${functionArgs.agentName}`
              });
              processedToolCallIds.add(toolCallId);
              console.log(`✅ [${this.name}] Added tool response for ${toolCallId} at index ${insertIndex}`);
              // Defer system message - must add AFTER all tool responses
              deferredSystemMessages.push({
                role: 'system',
                content: `${functionName} succeeded and message to ${functionArgs.agentName} was sent. Proceed with next planned changes.`
              });
            } else if (functionName === 'create_file') {
              const result = fileTools.createFile(this.name, functionArgs.path, functionArgs.content);
              console.log(`📝 ${this.name.toUpperCase()} created file: ${functionArgs.path}`);
              
              // CRITICAL: Insert tool response IMMEDIATELY after assistant message
              const insertIndex = getToolResponseInsertionIndex();
              this.conversationHistory.splice(insertIndex, 0, {
                role: 'tool',
                tool_call_id: toolCallId,
                content: result
              });
              processedToolCallIds.add(toolCallId);
              
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

              // Defer system message - must add AFTER all tool responses
              deferredSystemMessages.push({
                role: 'system',
                content: `${functionName} succeeded and file ${functionArgs.path} is successfully created. Proceed with next planned changes.`
              });
            } else if (functionName === 'read_file') {
              const content = fileTools.readFile(functionArgs.path);
              console.log(`📖 ${this.name.toUpperCase()} read file: ${functionArgs.path}`);
            
              // CRITICAL: Insert tool response IMMEDIATELY after assistant message
              const insertIndex = getToolResponseInsertionIndex();
              this.conversationHistory.splice(insertIndex, 0, {
                role: 'tool',
                tool_call_id: toolCallId,
                content: content
              });
              processedToolCallIds.add(toolCallId);
            
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

              // Defer system message - must add AFTER all tool responses
              deferredSystemMessages.push({
                role: 'system',
                content: `${functionName} succeeded for file ${functionArgs.path}. Proceed with next planned changes.`
              });
            } else if (functionName === 'str_replace') {
              const result = fileTools.strReplace(this.name, functionArgs.path, functionArgs.old_string, functionArgs.new_string);
              console.log(`✏️ ${this.name.toUpperCase()} modified file: ${functionArgs.path}`);
            
              // CRITICAL: Insert tool response IMMEDIATELY after assistant message
              const insertIndex = getToolResponseInsertionIndex();
              this.conversationHistory.splice(insertIndex, 0, {
                role: 'tool',
                tool_call_id: toolCallId,
                content: result
              });
              processedToolCallIds.add(toolCallId);
            
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

              // Defer system message - must add AFTER all tool responses
              deferredSystemMessages.push({
                role: 'system',
                content: `${functionName} succeeded for file ${functionArgs.path}. Proceed with next planned changes.`
              });
            } else if (functionName === 'list_files') {
              const files = fileTools.listFiles(functionArgs.directory || '.');
              console.log(`📂 ${this.name.toUpperCase()} listed files in: ${functionArgs.directory || '.'}`);
            
              this.conversationHistory.push({
              role: 'tool',
              tool_call_id: toolCallId,
              content: JSON.stringify(files)
            });
            processedToolCallIds.add(toolCallId);
            
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

              // Defer system message - must add AFTER all tool responses
              deferredSystemMessages.push({
                role: 'system',
                content: `${functionName} succeeded for directory ${functionArgs.directory || '.'}. Proceed with next planned changes.`
              });
            } else if (functionName === 'delete_file') {
              const result = fileTools.deleteFile(this.name, functionArgs.path);
              console.log(`🗑️ ${this.name.toUpperCase()} deleted file: ${functionArgs.path}`);
            
              // CRITICAL: Insert tool response IMMEDIATELY after assistant message
              const insertIndex = getToolResponseInsertionIndex();
              this.conversationHistory.splice(insertIndex, 0, {
                role: 'tool',
                tool_call_id: toolCallId,
                content: result
              });
              processedToolCallIds.add(toolCallId);
            
              this.messageBus.emit('ws:broadcast', this.conversationId, {
              type: 'file:deleted',
              agent: this.name,
              path: functionArgs.path,
              timestamp: new Date().toISOString()
            });

              this.messageBus.emit('ws:broadcast', this.conversationId, {
              type: 'tool:result',
              agent: this.name,
              tool: functionName,
              result,
              timestamp: new Date().toISOString()
            });

              // Defer system message - must add AFTER all tool responses
              deferredSystemMessages.push({
                role: 'system',
                content: `${functionName} succeeded and file ${functionArgs.path} is successfully deleted. Proceed with next planned changes.`
              });
            } else if (functionName === 'read_message') {
              const delivery = this._readNextInboxMessage();
              // CRITICAL: Insert tool response IMMEDIATELY after assistant message
              const insertIndex = getToolResponseInsertionIndex();
              this.conversationHistory.splice(insertIndex, 0, {
                role: 'tool',
                tool_call_id: toolCallId,
                content: delivery.response
              });
              processedToolCallIds.add(toolCallId);

            if (delivery.messageRead) {
              this.needsAnotherRun = true;
              // Defer system message - must add AFTER all tool responses
              deferredSystemMessages.push({
                role: 'system',
                content: `${functionName} succeeded. ${this.inbox.length} message(s) left. Proceed with next planned changes.`
              });
            }
            }
          } catch (error) {
              console.error(`⚠️  Error executing function ${functionName}: ${error.message}`);
              
              // CRITICAL: Insert tool response IMMEDIATELY after assistant message
              const insertIndex = getToolResponseInsertionIndex();
              this.conversationHistory.splice(insertIndex, 0, {
                role: 'tool',
                tool_call_id: toolCallId,
                content: `ERROR: ${error.message}\n\nWhat went wrong: ${this._getErrorGuidance(functionName, error.message)}`
              });
              processedToolCallIds.add(toolCallId);
              
              // Emit error event to WebSocket
              this.messageBus.emit('ws:broadcast', this.conversationId, {
                type: 'tool:error',
                agent: this.name,
                tool: functionName,
                error: error.message,
                timestamp: new Date().toISOString()
              });
            }
          }
        } finally {
          // CRITICAL: Always verify all tool_call_ids have responses, even if exceptions occurred
          // This ensures we never leave an assistant message with tool_calls without all responses
          console.log(`🔍 [${this.name}] Safeguard: Checking ${responseMessage.tool_calls.length} tool calls, ${processedToolCallIds.size} processed`);
          for (const toolCall of responseMessage.tool_calls) {
            if (!processedToolCallIds.has(toolCall.id)) {
              console.warn(`⚠️  [${this.name}] Missing response for tool_call_id ${toolCall.id}, adding error response`);
              // CRITICAL: Insert tool response IMMEDIATELY after assistant message
              const insertIndex = getToolResponseInsertionIndex();
              this.conversationHistory.splice(insertIndex, 0, {
                role: 'tool',
                tool_call_id: toolCall.id,
                content: `ERROR: Tool call was not processed. This may be due to an internal error.`
              });
              processedToolCallIds.add(toolCall.id);
            }
          }
          console.log(`✅ [${this.name}] Safeguard: All ${responseMessage.tool_calls.length} tool_call_ids now have responses`);
          
          // Verify responses are actually in conversation history
          const toolResponseIds = new Set(
            this.conversationHistory
              .filter(m => m.role === 'tool' && m.tool_call_id)
              .map(m => m.tool_call_id)
          );
          const missingInHistory = responseMessage.tool_calls.filter(tc => !toolResponseIds.has(tc.id));
          if (missingInHistory.length > 0) {
            console.error(`❌ [${this.name}] CRITICAL: Safeguard added responses but they're not in history! Missing: ${missingInHistory.map(tc => tc.id).join(', ')}`);
            // Force add them again at the correct position
            for (const toolCall of missingInHistory) {
              const insertIndex = getToolResponseInsertionIndex();
              this.conversationHistory.splice(insertIndex, 0, {
                role: 'tool',
                tool_call_id: toolCall.id,
                content: `ERROR: Tool call was not processed. This may be due to an internal error.`
              });
            }
          } else {
            console.log(`✅ [${this.name}] Verified: All ${responseMessage.tool_calls.length} tool responses are in conversation history`);
          }
          
          // CRITICAL: Add all deferred system messages AFTER all tool responses
          // OpenAI requires tool responses to be consecutive immediately after assistant message
          // Find insertion point after all tool responses
          const systemMsgInsertIndex = getToolResponseInsertionIndex();
          for (const systemMsg of deferredSystemMessages) {
            this.conversationHistory.splice(systemMsgInsertIndex, 0, systemMsg);
          }
          if (deferredSystemMessages.length > 0) {
            console.log(`✅ [${this.name}] Added ${deferredSystemMessages.length} deferred system message(s) after all tool responses`);
          }
        }
        
        // After all tool calls are processed and verified, trigger next turn
        // This ensures all tool responses are in history before the next API call
        this.messageBus.emit(`message:${this.name}`, {
          from: 'system',
          to: this.name,
          content: 'All tool calls completed. Continue building.',
          autoRun: true,
          deliverImmediately: true,
          timestamp: new Date().toISOString()
        });
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

- If you're DONE with all your work and you notified your peers: Respond with text only again and you'll be marked complete.
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
        content: `User request: ${topic}. Please analyze this request from your domain perspective (Backend, Frontend, or DevOps). Use the talk function to coordinate with other agents as needed. In case this request is not relevant to you and you cannot anyhow contribute - you can complete immediately without talking.`,
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

// API endpoint to list all files in workspace
app.get('/api/files', (req, res) => {
  try {
    const files = fileTools.listFiles('.');
    res.json({ files });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API endpoint to read a file's content
// Use a regex route to match /api/files/ followed by any path
app.get(/^\/api\/files\/(.+)$/, (req, res) => {
  try {
    // Extract the file path from req.url
    // req.url will be like '/api/files/backend/test.js' or '/api/files/backend/test.js?query=...'
    const urlPath = req.url.split('?')[0]; // Remove query string
    const match = urlPath.match(/^\/api\/files\/(.+)$/);
    
    if (!match || !match[1]) {
      return res.status(400).json({ error: 'File path is required' });
    }
    
    // Decode the file path (it comes URL encoded)
    const decodedPath = decodeURIComponent(match[1]);
    
    const content = fileTools.readFile(decodedPath);
    res.json({ path: decodedPath, content });
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
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
        'Max 30 talk calls per agent',
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
