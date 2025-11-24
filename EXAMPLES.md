# API Examples and Use Cases

This document contains practical examples of how to use the AI Agents Conversation Server.

## Quick Start

Start the server:
```bash
npm start
```

The server will be available at `http://localhost:3001`

## Example 1: Basic Conversation

**Request:**
```bash
curl -X POST http://localhost:3001/start-conversation \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "Design a microservices architecture for an e-commerce platform",
    "turns": 3
  }'
```

**What happens:**
1. The Backend Agent discusses the technical architecture, database design, and API structure
2. The DevOps Agent responds with deployment strategies, containerization, and monitoring
3. They exchange ideas for 3 turns, building on each other's suggestions

## Example 2: Security Discussion

**Request:**
```bash
curl -X POST http://localhost:3001/start-conversation \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "Implement a secure authentication system with JWT and refresh tokens",
    "turns": 2
  }'
```

**Topics covered:**
- Backend Agent: JWT implementation, token storage, security best practices
- DevOps Agent: Secrets management, SSL/TLS configuration, monitoring auth failures

## Example 3: Performance Optimization

**Request:**
```bash
curl -X POST http://localhost:3001/start-conversation \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "Optimize database queries and implement caching for a high-traffic API",
    "turns": 4
  }'
```

**Expected discussion:**
- Backend Agent: Query optimization, indexing strategies, caching layers (Redis)
- DevOps Agent: Infrastructure scaling, CDN setup, load balancing

## Example 4: Real-time Features

**Request:**
```bash
curl -X POST http://localhost:3001/start-conversation \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "Build a real-time collaborative document editing system",
    "turns": 3
  }'
```

**Topics covered:**
- Backend Agent: WebSocket implementation, conflict resolution, data synchronization
- DevOps Agent: WebSocket server scaling, message queue setup, monitoring connections

## Example 5: Migration Strategy

**Request:**
```bash
curl -X POST http://localhost:3001/start-conversation \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "Migrate from monolithic architecture to microservices with zero downtime",
    "turns": 5
  }'
```

**What to expect:**
- Backend Agent: Service decomposition, API gateway patterns, data migration
- DevOps Agent: Blue-green deployment, feature flags, rollback strategies

## Retrieving Past Conversations

### List all conversations:
```bash
curl http://localhost:3001/conversations
```

**Response:**
```json
{
  "conversations": [
    {
      "id": "1700000000000",
      "topic": "Design a microservices architecture...",
      "createdAt": "2025-11-21T10:30:00.000Z",
      "turns": 3
    }
  ]
}
```

### Get specific conversation:
```bash
curl http://localhost:3001/conversations/1700000000000
```

**Response:**
```json
{
  "topic": "Design a microservices architecture for an e-commerce platform",
  "conversation": [
    {
      "turn": 1,
      "agent": "backend",
      "message": "For an e-commerce platform with microservices..."
    },
    {
      "turn": 1,
      "agent": "devops",
      "message": "To support this backend architecture..."
    }
  ],
  "createdAt": "2025-11-21T10:30:00.000Z"
}
```

## Using with Postman

1. Create a new POST request to `http://localhost:3001/start-conversation`
2. Set Headers: `Content-Type: application/json`
3. Body (raw JSON):
```json
{
  "topic": "Your technical topic here",
  "turns": 3
}
```
4. Click Send and watch the agents converse!

## Response Format

Every successful conversation returns:

```json
{
  "success": true,
  "conversationId": "1763737426455",
  "topic": "Your topic",
  "turns": 3,
  "conversation": [
    {
      "turn": 1,
      "agent": "backend",
      "message": "Backend agent's response..."
    },
    {
      "turn": 1,
      "agent": "devops",
      "message": "DevOps agent's response..."
    }
  ],
  "summary": "Completed 3 turns of conversation between Backend and DevOps agents"
}
```

## Interesting Topics to Try

### Architecture & Design
- "Design a multi-tenant SaaS application with data isolation"
- "Build a GraphQL API with subscription support"
- "Create a serverless event-driven architecture"

### Performance & Scale
- "Handle 1 million concurrent WebSocket connections"
- "Optimize cold start times for serverless functions"
- "Design a global CDN strategy for content delivery"

### Security & Compliance
- "Implement PCI-DSS compliance for payment processing"
- "Design a secure multi-factor authentication system"
- "Create an audit logging system for compliance"

### Operations & Reliability
- "Implement chaos engineering practices"
- "Design a disaster recovery strategy with RPO/RTO targets"
- "Build a comprehensive observability platform"

### Data & Storage
- "Design a time-series data storage solution at scale"
- "Implement eventual consistency in distributed systems"
- "Build a data pipeline for real-time analytics"

## Tips

1. **Conversation Length**: Start with 2-3 turns for focused discussions. Use 4-5 turns for complex topics.

2. **Response Time**: Each turn takes 3-5 seconds as agents use GPT-4. A 3-turn conversation takes ~30-45 seconds.

3. **Specificity**: More specific topics lead to more detailed and practical discussions.

4. **Follow-up**: Save the conversation ID to retrieve and review discussions later.

5. **Cost Awareness**: Each conversation uses OpenAI API credits. Monitor your usage on the OpenAI dashboard.

## Troubleshooting

**Q: Request times out**
A: This is normal for longer conversations. The API is working; it just takes time for AI responses.

**Q: Rate limit errors**
A: You're hitting OpenAI's rate limits. Wait a minute and try again.

**Q: Port already in use**
A: Change the PORT in `.env` file to use a different port.

**Q: Conversation is too generic**
A: Make your topic more specific. Include technologies, constraints, or specific challenges.




