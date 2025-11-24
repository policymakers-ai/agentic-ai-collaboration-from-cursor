#!/bin/bash

# Test script for AI Agents Conversation Server
# This script demonstrates various API calls

PORT=3001
BASE_URL="http://localhost:${PORT}"

echo "🧪 Testing AI Agents Conversation Server"
echo "========================================="
echo ""

# Test 1: Health Check
echo "1. Health Check"
echo "   GET ${BASE_URL}/health"
curl -s "${BASE_URL}/health" | jq '.'
echo ""
echo ""

# Test 2: Start a conversation
echo "2. Starting conversation between agents"
echo "   POST ${BASE_URL}/start-conversation"
echo ""

CONVERSATION_RESPONSE=$(curl -s -X POST "${BASE_URL}/start-conversation" \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "Implement a secure authentication system with JWT and refresh tokens",
    "turns": 2
  }')

echo "$CONVERSATION_RESPONSE" | jq '.'
CONVERSATION_ID=$(echo "$CONVERSATION_RESPONSE" | jq -r '.conversationId')
echo ""
echo "Conversation ID: $CONVERSATION_ID"
echo ""

# Test 3: List all conversations
echo "3. Listing all conversations"
echo "   GET ${BASE_URL}/conversations"
curl -s "${BASE_URL}/conversations" | jq '.'
echo ""
echo ""

# Test 4: Retrieve specific conversation
if [ ! -z "$CONVERSATION_ID" ] && [ "$CONVERSATION_ID" != "null" ]; then
  echo "4. Retrieving conversation by ID"
  echo "   GET ${BASE_URL}/conversations/${CONVERSATION_ID}"
  curl -s "${BASE_URL}/conversations/${CONVERSATION_ID}" | jq '.'
else
  echo "4. Skipping conversation retrieval (no valid conversation ID)"
fi

echo ""
echo "✅ Tests completed!"




