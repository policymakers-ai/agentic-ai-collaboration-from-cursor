# AI Agents Conversation Server

A Node.js server that orchestrates conversations between two AI agents: a Backend Agent and a DevOps Agent. The agents collaborate to discuss technical topics, design systems, and solve problems.

## Features

- 🤖 Two specialized AI agents (Backend & DevOps)
- 💬 Multi-turn conversations between agents
- 📝 Conversation history storage and retrieval
- 🔄 RESTful API endpoints
- ⚡ Real-time conversation generation

## Agents

### Backend AI Agent
Expert in:
- Backend development, APIs, and databases
- Server architecture and design patterns
- Scalability and performance optimization
- Data modeling and business logic
- Security best practices

### DevOps AI Agent
Expert in:
- Infrastructure and cloud platforms
- CI/CD pipelines and automation
- Containerization (Docker, Kubernetes)
- Monitoring, logging, and observability
- Deployment strategies and reliability

## Setup

1. **Install dependencies:**
```bash
npm install
```

2. **Configure environment:**
The `.env` file is already configured with your OpenAI API key.

3. **Start the server:**
```bash
npm start
```

Or for development with auto-reload:
```bash
npm run dev
```

4. **Access the application:**
- **Web Interface:** Open `http://localhost:3001` in your browser for a beautiful UI
- **API:** Use `http://localhost:3001/start-conversation` for programmatic access

## Using the Web Interface

The easiest way to use the application is through the web interface:

1. Open `http://localhost:3001` in your browser
2. Enter a technical topic for discussion
3. Set the number of conversation turns (1-10)
4. Click "Start Conversation"
5. Watch the agents collaborate in real-time!

The web interface provides:
- Beautiful, modern UI with gradient backgrounds
- Real-time conversation display with color-coded messages
- Example topics to get you started
- Automatic conversation ID tracking
- Smooth animations and responsive design

## API Endpoints

### POST /start-conversation
Start a conversation between the two agents.

**Request Body:**
```json
{
  "topic": "Design a microservices architecture for an e-commerce platform",
  "turns": 5
}
```

**Parameters:**
- `topic` (required): The topic for agents to discuss
- `turns` (optional): Number of conversation turns (default: 5)

**Response:**
```json
{
  "success": true,
  "conversationId": "1700000000000",
  "topic": "Design a microservices architecture...",
  "turns": 5,
  "conversation": [
    {
      "turn": 1,
      "agent": "backend",
      "message": "..."
    },
    {
      "turn": 1,
      "agent": "devops",
      "message": "..."
    }
  ],
  "summary": "Completed 5 turns of conversation..."
}
```

**Example with curl:**
```bash
curl -X POST http://localhost:3000/start-conversation \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "Design a microservices architecture for an e-commerce platform",
    "turns": 3
  }'
```

### GET /conversations
List all stored conversations.

**Response:**
```json
{
  "conversations": [
    {
      "id": "1700000000000",
      "topic": "Design a microservices architecture...",
      "createdAt": "2025-11-21T...",
      "turns": 5
    }
  ]
}
```

### GET /conversations/:id
Retrieve a specific conversation by ID.

**Response:**
```json
{
  "topic": "Design a microservices architecture...",
  "conversation": [...],
  "createdAt": "2025-11-21T..."
}
```

### GET /health
Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2025-11-21T...",
  "openaiConfigured": true
}
```

## Example Topics

Here are some interesting topics to try:

1. **Architecture Design:**
   - "Design a microservices architecture for an e-commerce platform"
   - "Build a real-time chat application with high availability"
   - "Create a scalable video streaming service"

2. **Performance & Scaling:**
   - "Optimize database performance for a social media platform"
   - "Design auto-scaling strategy for unpredictable traffic"
   - "Implement caching strategy for a news aggregator"

3. **Security & Compliance:**
   - "Implement zero-trust security for a financial application"
   - "Design a GDPR-compliant user data system"
   - "Create secure CI/CD pipeline with secrets management"

4. **Migration & Modernization:**
   - "Migrate monolithic app to microservices with zero downtime"
   - "Move on-premise infrastructure to cloud"
   - "Containerize legacy application for Kubernetes"

## Project Structure

```
.
├── server.js              # Main server file with agent logic
├── client.html            # Web interface for the application
├── package.json           # Dependencies and scripts
├── .env                   # Environment variables (API key)
├── .gitignore            # Git ignore rules
├── test-conversation.sh   # Shell script for testing API
├── EXAMPLES.md           # Detailed API examples and use cases
└── README.md             # This file
```

## Technologies Used

- **Node.js** - Runtime environment
- **Express** - Web framework
- **OpenAI API** - AI agent intelligence
- **GPT-4 Turbo** - Language model

## Notes

- Conversations are stored in memory and will be lost when the server restarts
- Each conversation turn involves both agents responding once
- Responses are limited to 500 tokens for concise, focused discussions
- The server logs conversation progress to the console in real-time

## License

ISC

