# AI Agents Software Builder

A multi-agent Node.js system where three specialized AI agents collaborate to build software artifacts. Agents work autonomously, coordinate via messaging, and produce real code files in a shared workspace.

## Features

- 🤖 **Three specialized agents** working in parallel
- 💬 **Inter-agent messaging** for coordination
- 📝 **File operations** - create, read, modify, delete files
- 📁 **Live workspace viewer** with file content preview
- ⚡ **Real-time WebSocket** updates
- 🔒 **File locking** prevents concurrent write conflicts

## Agents

### Backend Agent
Expert in server-side development, APIs, databases, authentication, and backend architecture.

### Frontend Agent
Expert in UI/UX, HTML/CSS/React, client-side logic, and frontend frameworks.

### DevOps Agent
Expert in infrastructure, Docker, Kubernetes, CI/CD pipelines, and deployment automation.

## Tools Available to Agents

Each agent has access to 7 tools:

1. **`talk(agentName, message)`** - Send messages to other agents (30 calls max)
2. **`create_file(path, content)`** - Create new files (fails if file exists)
3. **`read_file(path)`** - Read file contents
4. **`str_replace(path, old_string, new_string)`** - Modify existing files
5. **`list_files(directory)`** - List files in a directory
6. **`delete_file(path)`** - Delete files
7. **`read_message()`** - Read messages from inbox queue

## Quick Start

1. **Install dependencies:**
```bash
npm install
```

2. **Set OpenAI API key:**
```bash
export OPENAI_API_KEY=your_key_here
```

3. **Start the server:**
```bash
npm start
```

4. **Open the web interface:**
```
http://localhost:3001
```

## Usage

### Web Interface

1. Enter a project description (e.g., "Build a todo app with React and Node.js")
2. Click "Start Building"
3. Watch agents collaborate in real-time
4. View generated files in the workspace panel
5. Click any file to view its content

### API

**Start a conversation:**
```bash
curl -X POST http://localhost:3001/start-conversation \
  -H "Content-Type: application/json" \
  -d '{"topic": "Build a REST API with Express"}'
```

**List all files:**
```bash
curl http://localhost:3001/api/files
```

**Read a file:**
```bash
curl http://localhost:3001/api/files/backend/server.js
```

## API Endpoints

- `POST /start-conversation` - Start a new conversation
- `POST /stop-conversation` - Stop current conversation
- `POST /wipe-workspace` - Clear workspace files
- `GET /conversations` - List all conversations
- `GET /conversations/:id` - Get conversation details
- `GET /api/files` - List all workspace files
- `GET /api/files/*` - Read file content
- `GET /health` - Health check
- `WS /ws?conversationId=...` - WebSocket for real-time updates

## Workspace

All files are created in `/tmp/project/`. The workspace viewer polls every 2 seconds to show all current files. Click any file to view its content in a modal.

## Technology

- **Node.js** + **Express**
- **OpenAI GPT-5.1** for agent intelligence
- **WebSocket** for real-time updates
- **File system** operations with locking

## Project Structure

```
.
├── server.js              # Main server with agent orchestration
├── client-enhanced.html   # Web UI with workspace viewer
├── prompts/
│   ├── backend-agent.txt  # Backend agent prompt
│   ├── frontend-agent.txt # Frontend agent prompt
│   ├── devops-agent.txt   # DevOps agent prompt
│   └── tools-usage.txt   # Shared tool instructions
└── package.json
```

## License

ISC
