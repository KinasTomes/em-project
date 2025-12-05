-- Seckill Release Script
-- Atomic operation: Check user exists + Remove user + Restore stock
-- Idempotent: Returns success even if user not found
--
-- KEYS[1]: seckill:{productId}:stock
-- KEYS[2]: seckill:{productId}:users
-- ARGV[1]: userId
--
-- Return codes:
--   1: SUCCESS (slot released)
--  -1: USER_NOT_FOUND (already released or never purchased - idempotent success)

-- Check if user exists in winners set
if redis.call("SISMEMBER", KEYS[2], ARGV[1]) == 0 then
    return -1 -- User not found (already released or never purchased)
end

-- Atomic release: remove user from set and increment stock
redis.call("SREM", KEYS[2], ARGV[1])
redis.call("INCR", KEYS[1])

return 1 -- SUCCESS
