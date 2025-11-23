#!/bin/bash

echo "==================================="
echo "OpenAI API Key Test"
echo "==================================="
echo ""

# Load the API key from .env
source .env

echo "Testing API Key: ${OPENAI_API_KEY:0:20}...${OPENAI_API_KEY: -4}"
echo ""

echo "Test 1: List Models (Simple GET)"
echo "-----------------------------------"
curl -s https://api.openai.com/v1/models \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -w "\nHTTP Status: %{http_code}\n" | head -20
echo ""

echo "Test 2: Test with curl verbose (just headers)"
echo "-----------------------------------"
curl -I -H "Authorization: Bearer $OPENAI_API_KEY" \
  https://api.openai.com/v1/models 2>&1 | head -15
echo ""

echo "==================================="
echo "Test Complete"
echo "==================================="
