import WebSocket from 'ws';

const PORT = 3001;
const API_URL = `http://localhost:${PORT}`;

console.log("🧪 Testing Multiple Tool Calls - Ensuring all tool_call_ids get responses");

async function runTest() {
  try {
    // 1. Start conversation
    console.log("\n1. Starting conversation: 'Create test.txt and test2.txt files'...");
    const startRes = await fetch(`${API_URL}/start-conversation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: "Create test.txt and test2.txt files" })
    });
    
    const startData = await startRes.json();
    const conversationId = startData.conversationId;
    console.log(`✅ Conversation started with ID: ${conversationId}`);
    
    // 2. Connect to WebSocket
    console.log("\n2. Connecting to WebSocket...");
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?conversationId=${conversationId}`);
    
    let toolCallErrors = [];
    let toolCalls = [];
    let toolResponses = [];
    let conversationComplete = false;
    
    ws.on('open', () => {
      console.log("✅ WebSocket connected");
    });
    
    ws.on('message', (data) => {
      const event = JSON.parse(data);
      
      if (event.type === 'tool:call') {
        toolCalls.push(event);
        console.log(`📞 Tool call: ${event.tool} by ${event.agent}`);
      } else if (event.type === 'tool:result') {
        toolResponses.push(event);
        console.log(`✅ Tool result: ${event.tool} by ${event.agent}`);
      } else if (event.type === 'tool:error') {
        toolCallErrors.push(event);
        console.error(`❌ Tool error: ${event.tool} by ${event.agent} - ${event.error}`);
      } else if (event.type === 'conversation:complete') {
        conversationComplete = true;
        console.log("✅ Conversation completed");
      }
    });
    
    ws.on('error', (err) => {
      console.error("❌ WebSocket error:", err);
    });
    
    // Wait for conversation to complete or timeout
    await new Promise((resolve) => {
      const checkComplete = setInterval(() => {
        if (conversationComplete) {
          clearInterval(checkComplete);
          resolve();
        }
      }, 500);
      
      setTimeout(() => {
        clearInterval(checkComplete);
        resolve();
      }, 30000); // 30s timeout
    });
    
    ws.close();
    
    // 3. Check results
    console.log("\n3. Analyzing results...");
    console.log(`   Tool calls made: ${toolCalls.length}`);
    console.log(`   Tool responses received: ${toolResponses.length}`);
    console.log(`   Tool errors: ${toolCallErrors.length}`);
    
    // Check server logs for the specific error (only check the most recent log file)
    const { execSync } = await import('child_process');
    try {
      // Find the most recent log file
      const logFiles = execSync('ls -t /tmp/server-test-toolcalls*.log 2>/dev/null | head -1', { encoding: 'utf-8' }).trim();
      const logs = logFiles ? execSync(`tail -200 "${logFiles}" 2>/dev/null || echo "No logs"`, { encoding: 'utf-8' }) : 'No logs';
      const hasToolCallIdError = logs.includes("tool_call_id") && logs.includes("did not have response messages");
      
      if (hasToolCallIdError) {
        console.error("\n❌ FAILURE: Found tool_call_id error in server logs!");
        console.error("   This means some tool_call_ids did not get responses.");
        process.exit(1);
      } else if (toolCallErrors.length > 0) {
        console.error("\n❌ FAILURE: Tool errors detected!");
        toolCallErrors.forEach(err => {
          console.error(`   - ${err.agent}: ${err.tool} - ${err.error}`);
        });
        process.exit(1);
      } else {
        console.log("\n✅ SUCCESS: No tool_call_id errors detected!");
        console.log("   All tool calls received proper responses.");
        process.exit(0);
      }
    } catch (err) {
      console.error("❌ Error checking logs:", err.message);
      process.exit(1);
    }
    
  } catch (error) {
    console.error("❌ Test failed:", error);
    process.exit(1);
  }
}

runTest();

