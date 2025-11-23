import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { EventEmitter } from 'events';
import { readFileSync } from 'fs';
import OpenAI from 'openai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

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
const BACKEND_PROMPT = readFileSync(path.join(__dirname, 'prompts', 'backend-agent.txt'), 'utf-8');
const DEVOPS_PROMPT = readFileSync(path.join(__dirname, 'prompts', 'devops-agent.txt'), 'utf-8');

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
    this.maxTalkCalls = 3;
    this.isComplete = false;
    
    // Subscribe to messages for this agent
    this.messageBus.on(`message:${this.name}`, this.handleMessage.bind(this));
    
    console.log(`🤖 Agent '${this.name}' initialized for conversation ${conversationId}`);
  }
  
  /**
   * Handle incoming messages
   */
  async handleMessage(message) {
    if (this.isComplete) {
      console.log(`⏹️  Agent '${this.name}' has already completed, ignoring message`);
      return;
    }
    
    console.log(`\n📨 Agent '${this.name}' received message from '${message.from}':`);
    console.log(`   "${message.content}"`);
    
    // Add message to conversation history
    this.conversationHistory.push({
      role: 'user',
      content: `Message from ${message.from}: ${message.content}`
    });
    
    try {
      // Check if we've exceeded talk calls
      if (this.talkCallCount >= this.maxTalkCalls) {
        console.log(`⚠️  Agent '${this.name}' has reached max talk calls (${this.maxTalkCalls}), marking as complete`);
        this.complete();
        return;
      }
      
      // Call LLM with OpenAI function calling
      console.log(`🧠 Agent '${this.name}' is thinking... (calls remaining: ${this.maxTalkCalls - this.talkCallCount})`);
      
      // Build messages for OpenAI
      const messages = [
        { role: 'system', content: this.systemPrompt },
        ...this.conversationHistory
      ];
      
      // Define the talk function
      const functions = [{
        name: 'talk',
        description: `Send a message to another agent. You have ${this.maxTalkCalls - this.talkCallCount} calls remaining out of ${this.maxTalkCalls}.`,
        parameters: {
          type: 'object',
          properties: {
            agentName: {
              type: 'string',
              enum: ['backend', 'devops'],
              description: 'The name of the agent to send the message to'
            },
            message: {
              type: 'string',
              description: 'The message content to send to the other agent'
            }
          },
          required: ['agentName', 'message']
        }
      }];
      
      // For the first call, guide towards using the function
      // After that, let the agent decide
      const shouldForceFunction = this.talkCallCount === 0;
      
      const result = await openaiClient.chat.completions.create({
        model: 'gpt-4-turbo-preview',
        messages: messages,
        functions: functions,
        function_call: shouldForceFunction ? { name: 'talk' } : 'auto',
        temperature: 0.7,
        max_tokens: 500
      });
      
      const responseMessage = result.choices[0].message;
      
      // Print agent's text response if they have one
      if (responseMessage.content) {
        console.log(`\n💭 ${this.name.toUpperCase()} Agent says:`);
        console.log(`   ${responseMessage.content}\n`);
      }
      
      // Check if agent used the talk function
      if (responseMessage.function_call) {
        const functionName = responseMessage.function_call.name;
        
        try {
          const functionArgs = JSON.parse(responseMessage.function_call.arguments);
          
          if (functionName === 'talk') {
            await this.talk(functionArgs.agentName, functionArgs.message);
          }
        } catch (parseError) {
          console.error(`⚠️  Error parsing function arguments: ${parseError.message}`);
          console.error(`   Arguments received: "${responseMessage.function_call.arguments}"`);
          // Mark as complete if we can't parse the function call
          this.complete();
        }
      } else {
        // Agent chose not to respond further
        console.log(`✅ Agent '${this.name}' chose not to continue the conversation`);
        this.complete();
      }
      
    } catch (error) {
      console.error(`❌ Error in agent '${this.name}':`, error.message);
      console.error(`   Full error:`, error);
      console.error(`   Stack:`, error.stack);
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
    
    // Track agent completion
    messageBus.on('agent:complete', (data) => {
      completedAgents.add(data.agentName);
      console.log(`\n✓ Agent '${data.agentName}' completed (${completedAgents.size}/2 agents done)\n`);
    });
    
    // Create both agents
    const backendAgent = new Agent('backend', BACKEND_PROMPT, conversationId, messageBus);
    const devopsAgent = new Agent('devops', DEVOPS_PROMPT, conversationId, messageBus);
    
    // Create a promise that resolves when conversation is complete
    const conversationComplete = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        console.log('\n⏰ Conversation timeout reached (2 minutes)\n');
        resolve('timeout');
      }, 120000); // 2 minute timeout
      
      // Check for completion
      const checkComplete = () => {
        if (completedAgents.size >= 2) {
          clearTimeout(timeout);
          console.log('\n🎉 Both agents have completed!\n');
          resolve('complete');
        }
      };
      
      messageBus.on('agent:complete', checkComplete);
    });
    
    // Start the conversation by sending initial message to backend agent
    setTimeout(() => {
      messageBus.emit('message:backend', {
        from: 'system',
        to: 'backend',
        content: `Let's discuss: ${topic}. Please share your thoughts from the backend perspective, then use the talk function to send a message to the devops agent.`,
        timestamp: new Date().toISOString()
      });
    }, 100);
    
    // Wait for conversation to complete
    const result = await conversationComplete;
    
    // Store conversation
    conversations.set(conversationId, {
      topic,
      conversation: fullConversation,
      createdAt: new Date().toISOString(),
      status: result
    });

    console.log(`\n${'='.repeat(80)}`);
    console.log(`✅ Conversation ${conversationId} finished`);
    console.log(`📊 Total messages exchanged: ${fullConversation.length}`);
    console.log(`${'='.repeat(80)}\n`);

    res.json({
      success: true,
      conversationId,
      topic,
      conversation: fullConversation,
      summary: `Conversation completed with ${fullConversation.length} messages exchanged`,
      status: result
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
    res.sendFile(path.join(__dirname, 'client.html'));
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

app.listen(port, () => {
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
