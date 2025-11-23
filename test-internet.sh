#!/bin/bash

echo "==================================="
echo "Internet Connectivity Test"
echo "==================================="
echo ""

echo "Test 1: Curl Google"
echo "-----------------------------------"
curl -s -o /dev/null -w "HTTP Status: %{http_code}\nTime: %{time_total}s\n" https://www.google.com
echo ""

echo "Test 2: Curl Google with response"
echo "-----------------------------------"
curl -s -I https://www.google.com | head -5
echo ""

echo "Test 3: DNS Resolution"
echo "-----------------------------------"
nslookup google.com 2>&1 | head -10 || echo "nslookup not available"
echo ""

echo "Test 4: Curl OpenAI API (just endpoint check)"
echo "-----------------------------------"
curl -s -o /dev/null -w "HTTP Status: %{http_code}\nTime: %{time_total}s\n" https://api.openai.com/v1/models
echo ""

echo "Test 5: Ping test (if available)"
echo "-----------------------------------"
ping -c 3 8.8.8.8 2>&1 || echo "Ping not available or blocked"
echo ""

echo "==================================="
echo "Test Complete"
echo "==================================="
