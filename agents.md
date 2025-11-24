# AI Agents System Overview

This project is a multi-agent Node.js application that orchestrates three AI agents (Backend, Frontend, DevOps) working together to build software artifacts collaboratively.

## Project Structure

```
.
├── server.js                 # Express server orchestrating agents, tools, WS
├── client-enhanced.html      # 3-column UI with live WebSocket feed
├── prompts/
│   ├── backend-agent.txt     # Backend agent prompt
│   ├── frontend-agent.txt    # Frontend agent prompt
│   ├── devops-agent.txt      # DevOps agent prompt
│   └── tools-usage.txt       # Shared tool instructions (included in each prompt)
├── test-full-system.js       # Automated system test (10s timeout)
├── test-file-tools.js        # File tool verification script
├── test-file-system.js       # Alternative filesystem test
└── package.json
```

### Agents
- **Backend**: Builds server-side APIs, data models, authentication, etc.
- **Frontend**: Implements UI (HTML/CSS/React), client logic, API integration.
- **DevOps**: Creates Dockerfiles, Kubernetes manifests, CI/CD configs.

Each agent:
1. Decides if the task is relevant.
2. Works autonomously with tool functions.
3. Collaborates via `talk()` (max 30 calls).
4. Must deliver complete implementations (not partial plans).
5. Uses shared tool instructions from `prompts/tools-usage.txt`.

## Tool Interface

Agents interact via five functions:
1. `talk(agentName, message)`
2. `create_file(path, content)` – write actual file content (no descriptions)
3. `read_file(path)` – only after at least a couple of files exist
4. `str_replace(path, old_string, new_string)` – modify existing files
5. `list_files(directory)` – inspect workspace structure

Rules:
- Agents should not output file contents in text responses; they must use `create_file`.
- Reading files is discouraged until they've created some content themselves.
- Every response should contain a function call unless they are fully done.

## Running the Server

```bash
cd /Users/zakotianskyi/PycharmProjects/vercel-ai-simple
npm start
```

Server runs at `http://localhost:3001` with:
- Enhanced UI (`client-enhanced.html`) showing each agent’s logs/status.
- WebSocket endpoint `/ws?conversationId=...` for real-time events.
- REST endpoints:
  - `POST /start-conversation`
  - `POST /stop-conversation`
  - `GET /conversations`
  - `GET /conversations/:id`
  - `GET /health`

### UI Features
- Three columns (Backend, Frontend, DevOps) with live logs.
- File explorer for `/tmp/project/`.
- Stop button to end the current conversation.
- Real-time streaming of thinking, tool calls, file events.

## Testing the System

### Quick Health Check
```bash
curl http://localhost:3001/health
```

### Automated System Test (limited to 10 seconds)
```bash
node test-full-system.js
```

### File Tool Verification
```bash
node test-file-tools.js
```

## Workspace
- Agents operate inside `/tmp/project/` (auto-created).
- Optional wipe (not yet exposed via API) can be done manually:
  ```bash
  rm -rf /tmp/project/*
  ```
- Agents can create subdirectories (`backend/`, `frontend/`, `infra/`, etc.).

## Conversation Flow
1. `/start-conversation` generates a `conversationId`.
2. All three agents receive the user topic simultaneously.
3. Agents decide relevance, start building, coordinate via `talk`.
4. File operations logged through WebSocket + stored in memory.
5. Conversation ends when:
   - All relevant agents mark complete, or
   - Timeout (3 minutes), or
   - User hits STOP.

## Key Behaviors / Safeguards
- **Idle nudging**: If an agent is idle >20s, system nudges them to act.
- **Text-only responses**: After 2 consecutive text-only replies, agent auto-completes to avoid loops.
- **JSON parsing failures**: System returns actionable error guidance to the agent.
- **File duplication prevention**: `create_file` throws if file already exists; agent must use `str_replace`.
- **Tool usage enforcement**: Shared prompt instructs agents to always prefer action over discussion.

## Known Best Practices for Agents
- Start writing files immediately (structure + content).
- Use `list_files` and `read_file` only when needed to inspect others’ work.
- `create_file` accepts any text; no format restrictions.
- Break large outputs into multiple files or incremental updates to avoid JSON truncation.
- Combine `talk` with ongoing work—don’t idle waiting for replies.

## Troubleshooting
- **Port 3001 in use**: `lsof -ti:3001 | xargs kill -9`
- **Workspace messy**: `rm -rf /tmp/project/*`
- **Agents not creating files**: Verify prompts/tools usage; ensure server restarted after changes.
- **WebSocket not streaming**: Ensure client connects to `/ws?conversationId=...` immediately after POST response.

## Deployment Notes
- DevOps agent generates Dockerfiles/Kubernetes manifests under `/tmp/project/infra` (or similar).
- CI/CD examples (GitHub Actions) created in `.github/workflows/`.
- All generated artifacts can be inspected via the file explorer or `/tmp/project/`.

## Summary
This system is a fully-autonomous, multi-agent coding environment with strong emphasis on taking action through tool calls. Agents must produce real code/configs, coordinate intelligently, and show their work via the shared workspace. Use the enhanced UI and REST/WebSocket endpoints to monitor and guide their collaboration.


