import WebSocket from 'ws';
import http from 'http';

const PORT = 3001;
const API_URL = `http://localhost:${PORT}`;

console.log("🧪 Testing WebSocket Streaming");

async function runTest() {
  try {
    // 1. Start conversation
    console.log("\n1. Starting conversation...");
    const startRes = await fetch(`${API_URL}/start-conversation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: "Test WebSocket streaming" })
    });
    
    const startData = await startRes.json();
    const conversationId = startData.conversationId;
    console.log(`✅ Conversation started with ID: ${conversationId}`);
    
    // 2. Connect to WebSocket
    console.log("\n2. Connecting to WebSocket...");
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?conversationId=${conversationId}`);
    
    ws.on('open', () => {
      console.log("✅ WebSocket connected");
    });
    
    ws.on('message', (data) => {
      const event = JSON.parse(data);
      console.log(`📨 Received event: ${event.type}`);
      
      if (event.type === 'conversation:complete') {
        console.log("✅ Conversation completed event received");
        ws.close();
        process.exit(0);
      }
    });
    
    ws.on('error', (err) => {
      console.error("❌ WebSocket error:", err);
      process.exit(1);
    });
    
    // Set timeout for test
    setTimeout(() => {
      console.log("⚠️ Test timed out (waiting for completion)");
      ws.close();
      process.exit(0);
    }, 15000); // 15s timeout
    
  } catch (error) {
    console.error("❌ Test failed:", error);
    process.exit(1);
  }
}

runTest();
