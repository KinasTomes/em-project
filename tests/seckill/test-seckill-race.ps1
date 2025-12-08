# Seckill Race Condition Test Script (PowerShell)
# Usage: .\test-seckill-race.ps1 [-BaseUrl "http://localhost:3003"]
#
# This script tests the flash sale race condition:
# 1. Create test users and get tokens
# 2. Fetch or create a real product
# 3. Initialize a campaign with stock=1
# 4. Two users try to buy simultaneously
# 5. Only one should succeed

param(
    [string]$BaseUrl = "http://34.2.136.15:3003",
    [string]$AdminKey = "super-gay-key-for-femboi-usage"
)

Write-Host "========================================"
Write-Host "🎯 Seckill Race Condition Test" -ForegroundColor Cyan
Write-Host "========================================"
Write-Host "BASE_URL: $BaseUrl"
Write-Host ""

# ========================================
# Step 1: Create test users and get tokens (need this first for product creation)
# ========================================
Write-Host "📝 Step 1: Creating test users..." -ForegroundColor Yellow

$timestamp = Get-Date -Format 'yyyyMMddHHmmss'
$User1 = "seckill_racer_1_$timestamp"
$User2 = "seckill_racer_2_$timestamp"
$Password = "testpass123"

# Register & Login User 1
Write-Host "  Creating user 1: $User1"
try {
    $null = Invoke-RestMethod -Uri "$BaseUrl/auth/register" -Method POST -ContentType "application/json" `
        -Body (@{username=$User1; password=$Password} | ConvertTo-Json) -ErrorAction SilentlyContinue
} catch {}

$loginResult1 = Invoke-RestMethod -Uri "$BaseUrl/auth/login" -Method POST -ContentType "application/json" `
    -Body (@{username=$User1; password=$Password} | ConvertTo-Json)
$Token1 = $loginResult1.token

if (-not $Token1) {
    Write-Host "❌ Failed to get token for User 1" -ForegroundColor Red
    exit 1
}
Write-Host "  ✓ User 1 ready" -ForegroundColor Green

# Register & Login User 2
Write-Host "  Creating user 2: $User2"
try {
    $null = Invoke-RestMethod -Uri "$BaseUrl/auth/register" -Method POST -ContentType "application/json" `
        -Body (@{username=$User2; password=$Password} | ConvertTo-Json) -ErrorAction SilentlyContinue
} catch {}

$loginResult2 = Invoke-RestMethod -Uri "$BaseUrl/auth/login" -Method POST -ContentType "application/json" `
    -Body (@{username=$User2; password=$Password} | ConvertTo-Json)
$Token2 = $loginResult2.token

if (-not $Token2) {
    Write-Host "❌ Failed to get token for User 2" -ForegroundColor Red
    exit 1
}
Write-Host "  ✓ User 2 ready" -ForegroundColor Green

# ========================================
# Step 2: Fetch or create a real product
# ========================================
Write-Host ""
Write-Host "📦 Step 2: Fetching or creating product..." -ForegroundColor Yellow

$ProductId = $null
$ProductPrice = 99.99

# Try to fetch existing products (using auth token)
try {
    $productsResponse = Invoke-RestMethod -Uri "$BaseUrl/products" -Method GET -Headers @{
        "Authorization" = "Bearer $Token1"
    } -ErrorAction Stop
    
    if ($productsResponse -and $productsResponse.Count -gt 0) {
        $product = $productsResponse[0]
        $ProductId = $product._id
        $ProductPrice = $product.price
        Write-Host "  ✓ Found existing product: $($product.name)" -ForegroundColor Green
        Write-Host "    ID: $ProductId"
        Write-Host "    Price: $ProductPrice"
    }
} catch {
    Write-Host "  ⚠️ Could not fetch products, will create one..." -ForegroundColor Yellow
}

# If no product found, create one
if (-not $ProductId) {
    Write-Host "  Creating new test product..." -ForegroundColor Yellow
    
    $timestamp = Get-Date -Format 'yyyyMMddHHmmss'
    $newProduct = @{
        name = "Seckill Test Product $timestamp"
        price = 99.99
        description = "Test product for seckill race condition test"
        stock = 100
    } | ConvertTo-Json
    
    try {
        $createResponse = Invoke-RestMethod -Uri "$BaseUrl/products" -Method POST `
            -ContentType "application/json" `
            -Headers @{"Authorization" = "Bearer $Token1"} `
            -Body $newProduct -ErrorAction Stop
        
        $ProductId = $createResponse._id
        $ProductPrice = $createResponse.price
        Write-Host "  ✓ Created new product: $($createResponse.name)" -ForegroundColor Green
        Write-Host "    ID: $ProductId"
        Write-Host "    Price: $ProductPrice"
        
        # Wait for PRODUCT_CREATED event to propagate to Inventory Service
        Write-Host "  ⏳ Waiting for inventory sync (2s)..." -ForegroundColor Yellow
        Start-Sleep -Seconds 2
    } catch {
        Write-Host "  ❌ Failed to create product: $_" -ForegroundColor Red
        Write-Host "  Error details: $($_.ErrorDetails.Message)" -ForegroundColor Red
        exit 1
    }
}

# Verify inventory exists for the product
Write-Host "  Checking inventory for product..." -ForegroundColor Yellow
$inventoryExists = $false

try {
    $inventoryCheck = Invoke-RestMethod -Uri "$BaseUrl/inventory/$ProductId" -Method GET -ErrorAction Stop
    Write-Host "  ✓ Inventory found: available=$($inventoryCheck.available), reserved=$($inventoryCheck.reserved)" -ForegroundColor Green
    $inventoryExists = $true
} catch {
    Write-Host "  ⚠️ Inventory not found for product. Creating via API..." -ForegroundColor Yellow
    
    # Try to create inventory directly (no auth needed for inventory API)
    try {
        $inventoryBody = @{
            productId = $ProductId
            available = 100
        } | ConvertTo-Json
        
        $createInventory = Invoke-RestMethod -Uri "$BaseUrl/inventory" -Method POST `
            -ContentType "application/json" `
            -Body $inventoryBody -ErrorAction Stop
        
        Write-Host "  ✓ Created inventory: available=$($createInventory.available)" -ForegroundColor Green
        $inventoryExists = $true
    } catch {
        Write-Host "  ❌ Could not create inventory via API: $_" -ForegroundColor Red
        Write-Host "    Error: $($_.ErrorDetails.Message)" -ForegroundColor Red
    }
}

if (-not $inventoryExists) {
    Write-Host ""
    Write-Host "❌ INVENTORY NOT AVAILABLE" -ForegroundColor Red
    Write-Host "   The seckill flow requires an inventory record in MongoDB." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "   To fix this, you have two options:" -ForegroundColor Cyan
    Write-Host "   1. Create inventory via MongoDB Compass:" -ForegroundColor White
    Write-Host "      db.inventories.insertOne({" -ForegroundColor Gray
    Write-Host "        productId: '$ProductId'," -ForegroundColor Gray
    Write-Host "        available: 100," -ForegroundColor Gray
    Write-Host "        reserved: 0" -ForegroundColor Gray
    Write-Host "      })" -ForegroundColor Gray
    Write-Host ""
    Write-Host "   2. Or use existing product that has inventory" -ForegroundColor White
    Write-Host ""
    exit 1
}

if (-not $ProductId) {
    Write-Host "❌ No product available for testing" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "PRODUCT_ID: $ProductId"
Write-Host ""

# ========================================
# Step 3: Initialize Flash Sale Campaign
# ========================================
Write-Host ""
Write-Host "🚀 Step 3: Initializing flash sale campaign..." -ForegroundColor Yellow

$StartTime = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$EndTime = (Get-Date).AddHours(1).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

# Use actual product price if available, otherwise default
if (-not $ProductPrice) { $ProductPrice = 99.99 }

$campaignBody = @{
    productId = $ProductId
    stock = 1
    price = $ProductPrice
    startTime = $StartTime
    endTime = $EndTime
} | ConvertTo-Json

try {
    $initResponse = Invoke-RestMethod -Uri "$BaseUrl/admin/seckill/init" -Method POST `
        -ContentType "application/json" `
        -Headers @{"X-Admin-Key"=$AdminKey} `
        -Body $campaignBody
    
    Write-Host "  Init Response: $($initResponse | ConvertTo-Json -Compress)"
    Write-Host "  ✓ Campaign initialized with stock=1" -ForegroundColor Green
} catch {
    Write-Host "❌ Failed to initialize campaign: $_" -ForegroundColor Red
    Write-Host "Response: $($_.ErrorDetails.Message)"
    exit 1
}

# ========================================
# Step 4: Check Campaign Status
# ========================================
Write-Host ""
Write-Host "📊 Step 4: Checking campaign status..." -ForegroundColor Yellow

$status = Invoke-RestMethod -Uri "$BaseUrl/seckill/status/$ProductId"
Write-Host "  Status: $($status | ConvertTo-Json -Compress)"
Write-Host "  Stock remaining: $($status.stockRemaining)" -ForegroundColor Cyan

# ========================================
# Step 5: Two users race to buy!
# ========================================
Write-Host ""
Write-Host "🏁 Step 5: RACE START! Two users buying simultaneously..." -ForegroundColor Yellow
Write-Host ""

# Create script blocks for parallel execution
$buyScript = {
    param($BaseUrl, $ProductId, $Token, $UserNum)
    
    $headers = @{
        "Content-Type" = "application/json"
        "Authorization" = "Bearer $Token"
    }
    $body = @{productId = $ProductId} | ConvertTo-Json
    
    try {
        $response = Invoke-RestMethod -Uri "$BaseUrl/seckill/buy" -Method POST `
            -Headers $headers -Body $body -ErrorAction Stop
        return @{User=$UserNum; Success=$true; Response=$response}
    } catch {
        $errorBody = $_.ErrorDetails.Message
        if ($errorBody) {
            try {
                $errorJson = $errorBody | ConvertFrom-Json
                return @{User=$UserNum; Success=$false; Error=$errorJson.error; Response=$errorJson}
            } catch {
                return @{User=$UserNum; Success=$false; Error=$errorBody; Response=$null}
            }
        }
        return @{User=$UserNum; Success=$false; Error=$_.Exception.Message; Response=$null}
    }
}

# Run both requests in parallel using Jobs
$job1 = Start-Job -ScriptBlock $buyScript -ArgumentList $BaseUrl, $ProductId, $Token1, 1
$job2 = Start-Job -ScriptBlock $buyScript -ArgumentList $BaseUrl, $ProductId, $Token2, 2

# Wait for completion
$results = @()
$results += Receive-Job -Job $job1 -Wait
$results += Receive-Job -Job $job2 -Wait

Remove-Job -Job $job1, $job2

# ========================================
# Step 6: Analyze Results
# ========================================
Write-Host ""
Write-Host "========================================"
Write-Host "📋 Step 6: RESULTS" -ForegroundColor Cyan
Write-Host "========================================"

$winners = 0
$losers = 0

foreach ($result in $results) {
    Write-Host ""
    Write-Host "User $($result.User):" -ForegroundColor White
    
    if ($result.Success) {
        Write-Host "  🎉 WON! Order ID: $($result.Response.orderId)" -ForegroundColor Green
        $winners++
    } elseif ($result.Error -eq "OUT_OF_STOCK") {
        Write-Host "  😢 OUT OF STOCK" -ForegroundColor Yellow
        $losers++
    } elseif ($result.Error -eq "ALREADY_PURCHASED") {
        Write-Host "  ⚠️  Already purchased" -ForegroundColor Yellow
    } else {
        Write-Host "  ❌ Error: $($result.Error)" -ForegroundColor Red
        Write-Host "  Response: $($result.Response | ConvertTo-Json -Compress)"
    }
}

# Get final status
Write-Host ""
$finalStatus = Invoke-RestMethod -Uri "$BaseUrl/seckill/status/$ProductId"
Write-Host "📦 Final Campaign Status:" -ForegroundColor Cyan
Write-Host "  Stock Remaining: $($finalStatus.stockRemaining)"
Write-Host "  Total Stock: $($finalStatus.totalStock)"

Write-Host ""
Write-Host "========================================"
if ($winners -eq 1 -and $losers -eq 1 -and $finalStatus.stockRemaining -eq 0) {
    Write-Host "✅ TEST PASSED!" -ForegroundColor Green
    Write-Host "   - Exactly 1 winner, 1 loser"
    Write-Host "   - Stock correctly depleted to 0"
} else {
    Write-Host "⚠️  TEST RESULTS:" -ForegroundColor Yellow
    Write-Host "   - Winners: $winners (expected: 1)"
    Write-Host "   - Losers (OUT_OF_STOCK): $losers (expected: 1)"
    Write-Host "   - Final Stock: $($finalStatus.stockRemaining) (expected: 0)"
}
Write-Host "========================================"
