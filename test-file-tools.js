import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Mock FileLockManager and FileSystemTools for testing without full server
const PROJECT_WORKSPACE = '/tmp/project-test';

if (existsSync(PROJECT_WORKSPACE)) {
  rmSync(PROJECT_WORKSPACE, { recursive: true, force: true });
}
mkdirSync(PROJECT_WORKSPACE, { recursive: true });

class FileLockManager {
  constructor() {
    this.locks = new Map();
    this.LOCK_TIMEOUT = 30000;
  }

  acquireLock(filePath, agentName) {
    const now = Date.now();
    const lock = this.locks.get(filePath);
    if (lock && lock.agent !== agentName && (now - lock.timestamp < this.LOCK_TIMEOUT)) {
      return false;
    }
    this.locks.set(filePath, { agent: agentName, timestamp: now });
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
}

class FileSystemTools {
  constructor(lockManager) {
    this.lockManager = lockManager;
  }

  createFile(agentName, filePath, content) {
    const fullPath = path.resolve(PROJECT_WORKSPACE, filePath);
    if (!this.lockManager.acquireLock(filePath, agentName)) {
      throw new Error(`File is locked`);
    }
    try {
      const dir = path.dirname(fullPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(fullPath, content);
      return `Created ${filePath}`;
    } finally {
      this.lockManager.releaseLock(filePath, agentName);
    }
  }
}

const lockManager = new FileLockManager();
const fileTools = new FileSystemTools(lockManager);

console.log("🧪 Testing File System Tools & Locking");

try {
  // Test 1: Create File
  console.log("\n1. Testing Create File...");
  const result = fileTools.createFile('backend', 'test.txt', 'Hello World');
  console.log(result);
  
  if (existsSync(path.join(PROJECT_WORKSPACE, 'test.txt'))) {
    console.log("✅ File created successfully");
  } else {
    console.error("❌ File creation failed");
  }

  // Test 2: Locking
  console.log("\n2. Testing File Locking...");
  lockManager.acquireLock('locked.txt', 'backend');
  console.log("Backend acquired lock on locked.txt");
  
  try {
    fileTools.createFile('frontend', 'locked.txt', 'Should fail');
    console.error("❌ Locking failed - Frontend shouldn't be able to write");
  } catch (e) {
    console.log("✅ Locking worked - Frontend blocked from writing");
  }

} catch (error) {
  console.error("❌ Test failed:", error);
}

