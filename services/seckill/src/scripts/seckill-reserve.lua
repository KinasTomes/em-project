-- Seckill Reserve Script
-- Atomic operation: Rate limit check + Duplicate check + Stock check + Reserve
-- 
-- KEYS[1]: seckill:{productId}:stock
-- KEYS[2]: seckill:{productId}:users
-- KEYS[3]: seckill:ratelimit:{userId}:{window}
-- ARGV[1]: userId
-- ARGV[2]: rate limit (max requests per window)
-- ARGV[3]: window TTL in seconds
--
-- Return codes:
--   1: SUCCESS
--  -1: OUT_OF_STOCK
--  -2: ALREADY_PURCHASED
--  -3: CAMPAIGN_NOT_STARTED (stock key doesn't exist)
--  -4: RATE_LIMIT_EXCEEDED

-- 1. Check rate limit (Fixed Window algorithm)
local currentRequests = tonumber(redis.call("GET", KEYS[3])) or 0
if currentRequests >= tonumber(ARGV[2]) then
    return -4 -- RATE_LIMIT_EXCEEDED
end

-- 2. Check duplicate purchase
if redis.call("SISMEMBER", KEYS[2], ARGV[1]) == 1 then
    return -2 -- ALREADY_PURCHASED
end

-- 3. Check stock exists (campaign initialized)
local stock = tonumber(redis.call("GET", KEYS[1]))
if stock == nil then 
    return -3 -- CAMPAIGN_NOT_STARTED
end

-- 4. Check stock available
if stock <= 0 then 
    return -1 -- OUT_OF_STOCK
end

-- 5. Atomic reserve: decrement stock and add user to winners set
redis.call("DECR", KEYS[1])
redis.call("SADD", KEYS[2], ARGV[1])

-- 6. Increment rate limit counter with TTL
if currentRequests == 0 then
    redis.call("SET", KEYS[3], 1, "EX", ARGV[3])
else
    redis.call("INCR", KEYS[3])
end

return 1 -- SUCCESS
