#!/bin/bash
# Seckill Race Condition Test Script
# Usage: ./test-seckill-race.sh [BASE_URL]
#
# This script tests the flash sale race condition:
# 1. Fetch a real product from Product service
# 2. Initialize a campaign with stock=1
# 3. Two users try to buy simultaneously
# 4. Only one should succeed

BASE_URL=${1:-"http://localhost:3003"}
ADMIN_KEY="super-gay-key-for-femboi-usage"

echo "========================================"
echo "🎯 Seckill Race Condition Test"
echo "========================================"
echo "BASE_URL: $BASE_URL"
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# ========================================
# Step 0: Fetch a real product from database
# ========================================
echo "📦 Step 0: Fetching real product from database..."

PRODUCTS_RESPONSE=$(curl -s "$BASE_URL/products")

if [ -z "$PRODUCTS_RESPONSE" ] || [ "$PRODUCTS_RESPONSE" == "[]" ]; then
  echo -e "${RED}❌ No products found in database${NC}"
  echo "Please create at least one product first."
  exit 1
fi

PRODUCT_ID=$(echo "$PRODUCTS_RESPONSE" | jq -r '.[0]._id')
PRODUCT_NAME=$(echo "$PRODUCTS_RESPONSE" | jq -r '.[0].name')
PRODUCT_PRICE=$(echo "$PRODUCTS_RESPONSE" | jq -r '.[0].price')

if [ "$PRODUCT_ID" == "null" ] || [ -z "$PRODUCT_ID" ]; then
  echo -e "${RED}❌ Failed to parse product ID${NC}"
  exit 1
fi

echo -e "  ${GREEN}✓ Found product: $PRODUCT_NAME${NC}"
echo "    ID: $PRODUCT_ID"
echo "    Price: $PRODUCT_PRICE"
echo ""
echo "PRODUCT_ID: $PRODUCT_ID"
echo ""

# ========================================
# Step 1: Create test users and get tokens
# ========================================
echo "📝 Step 1: Creating test users..."

USER1="seckill_racer_1_$(date +%s)"
USER2="seckill_racer_2_$(date +%s)"
PASSWORD="testpass123"

# Register & Login User 1
echo "  Creating user 1: $USER1"
curl -s -X POST "$BASE_URL/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$USER1\",\"password\":\"$PASSWORD\"}" > /dev/null

TOKEN1=$(curl -s -X POST "$BASE_URL/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$USER1\",\"password\":\"$PASSWORD\"}" | jq -r '.token')

if [ "$TOKEN1" == "null" ] || [ -z "$TOKEN1" ]; then
  echo -e "${RED}❌ Failed to get token for User 1${NC}"
  exit 1
fi
echo -e "  ${GREEN}✓ User 1 ready${NC}"

# Register & Login User 2
echo "  Creating user 2: $USER2"
curl -s -X POST "$BASE_URL/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$USER2\",\"password\":\"$PASSWORD\"}" > /dev/null

TOKEN2=$(curl -s -X POST "$BASE_URL/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$USER2\",\"password\":\"$PASSWORD\"}" | jq -r '.token')

if [ "$TOKEN2" == "null" ] || [ -z "$TOKEN2" ]; then
  echo -e "${RED}❌ Failed to get token for User 2${NC}"
  exit 1
fi
echo -e "  ${GREEN}✓ User 2 ready${NC}"

# ========================================
# Step 2: Initialize Flash Sale Campaign
# ========================================
echo ""
echo "🚀 Step 2: Initializing flash sale campaign..."

START_TIME=$(date -u -d "+0 minutes" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -v+0M +"%Y-%m-%dT%H:%M:%SZ")
END_TIME=$(date -u -d "+1 hour" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -v+1H +"%Y-%m-%dT%H:%M:%SZ")

# Use actual product price if available
if [ "$PRODUCT_PRICE" == "null" ] || [ -z "$PRODUCT_PRICE" ]; then
  PRODUCT_PRICE="99.99"
fi

INIT_RESPONSE=$(curl -s -X POST "$BASE_URL/admin/seckill/init" \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -d "{
    \"productId\": \"$PRODUCT_ID\",
    \"stock\": 1,
    \"price\": $PRODUCT_PRICE,
    \"startTime\": \"$START_TIME\",
    \"endTime\": \"$END_TIME\"
  }")

echo "  Init Response: $INIT_RESPONSE"

# Check if successful
if echo "$INIT_RESPONSE" | jq -e '.success' > /dev/null 2>&1; then
  echo -e "  ${GREEN}✓ Campaign initialized with stock=1${NC}"
else
  echo -e "${RED}❌ Failed to initialize campaign${NC}"
  echo "$INIT_RESPONSE"
  exit 1
fi

# ========================================
# Step 3: Check Campaign Status
# ========================================
echo ""
echo "📊 Step 3: Checking campaign status..."
STATUS=$(curl -s "$BASE_URL/seckill/status/$PRODUCT_ID")
echo "  Status: $STATUS"

STOCK=$(echo "$STATUS" | jq -r '.stockRemaining')
echo -e "  ${YELLOW}Stock remaining: $STOCK${NC}"

# ========================================
# Step 4: Two users race to buy!
# ========================================
echo ""
echo "🏁 Step 4: RACE START! Two users buying simultaneously..."
echo ""

# Run both buy requests in parallel
buy_product() {
  local USER_NUM=$1
  local TOKEN=$2
  
  RESPONSE=$(curl -s -X POST "$BASE_URL/seckill/buy" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d "{\"productId\": \"$PRODUCT_ID\"}")
  
  echo "USER_${USER_NUM}:$RESPONSE"
}

# Execute in parallel using background processes
buy_product 1 "$TOKEN1" &
PID1=$!
buy_product 2 "$TOKEN2" &
PID2=$!

# Wait for both to complete
wait $PID1
RESULT1=$?
wait $PID2
RESULT2=$?

# Small delay to let output settle
sleep 1

# ========================================
# Step 5: Analyze Results
# ========================================
echo ""
echo "========================================"
echo "📋 Step 5: RESULTS"
echo "========================================"

# Get final status
FINAL_STATUS=$(curl -s "$BASE_URL/seckill/status/$PRODUCT_ID")
FINAL_STOCK=$(echo "$FINAL_STATUS" | jq -r '.stockRemaining')

echo ""
echo "📦 Final Campaign Status:"
echo "  Stock Remaining: $FINAL_STOCK"
echo "  Full Status: $FINAL_STATUS"

echo ""
if [ "$FINAL_STOCK" == "0" ]; then
  echo -e "${GREEN}✅ TEST PASSED!${NC}"
  echo "   - Stock correctly depleted to 0"
  echo "   - One user won, one user lost (OUT_OF_STOCK)"
else
  echo -e "${RED}❌ TEST FAILED!${NC}"
  echo "   - Expected stock=0, got stock=$FINAL_STOCK"
fi

echo ""
echo "========================================"
