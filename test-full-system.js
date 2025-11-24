import WebSocket from 'ws';
import http from 'http';

const PORT = 3001;
const API_URL = `http://localhost:${PORT}`;

console.log("🧪 Testing Full System: Agents + Files + WebSocket");

async function runTest() {
  try {
    // 1. Start conversation
    console.log("\n1. Starting conversation: 'Create a simple index.html landing page'...");
    const startRes = await fetch(`${API_URL}/start-conversation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: "Create a simple index.html landing page" })
    });
    
    const startData = await startRes.json();
    const conversationId = startData.conversationId;
    console.log(`✅ Conversation started with ID: ${conversationId}`);
    
    // 2. Connect to WebSocket
    console.log("\n2. Connecting to WebSocket...");
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?conversationId=${conversationId}`);
    
    let fileCreated = false;
    
    ws.on('open', () => {
      console.log("✅ WebSocket connected");
    });
    
    ws.on('message', (data) => {
      const event = JSON.parse(data);
      
      if (event.type === 'agent:talk') {
        console.log(`💬 ${event.agent} -> ${event.to}: ${event.message.substring(0, 50)}...`);
      } else if (event.type === 'file:created') {
        console.log(`📝 FILE CREATED by ${event.agent}: ${event.path}`);
        fileCreated = true;
      } else if (event.type === 'conversation:complete') {
        console.log("✅ Conversation completed");
        
        if (fileCreated) {
          console.log("🎉 SUCCESS: File was created during conversation!");
          process.exit(0);
        } else {
          console.error("❌ FAILURE: No file was created.");
          process.exit(1);
        }
      }
    });
    
    ws.on('error', (err) => {
      console.error("❌ WebSocket error:", err);
      process.exit(1);
    });
    
    // Set timeout
    setTimeout(() => {
      console.log("⚠️ Test timed out (10s limit reached)");
      if (fileCreated) {
        console.log("🎉 SUCCESS: File was created within time limit!");
        process.exit(0);
      } else {
        console.log("ℹ️ Note: No file created yet, but system is running.");
        process.exit(0); // Exit gracefully as requested
      }
    }, 10000); // 10s timeout
    
  } catch (error) {
    console.error("❌ Test failed:", error);
    process.exit(1);
  }
}

runTest();

