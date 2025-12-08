#!/usr/bin/env python3
"""
Cleanup Redis Idempotency Keys
Removes all inventory:event:processed:* keys from Redis
"""

import redis
import sys

REDIS_HOST = '35.213.165.98'
REDIS_PORT = 6379
REDIS_DB = 0

def main():
    try:
        # Connect to Redis
        r = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, db=REDIS_DB)
        
        print(f"🔌 Connecting to Redis at {REDIS_HOST}:{REDIS_PORT}...")
        r.ping()
        print("✅ Connected to Redis\n")
        
        # Find all inventory idempotency keys
        pattern = "inventory:event:processed:*"
        keys = r.keys(pattern)
        
        if not keys:
            print(f"ℹ️  No keys found matching pattern: {pattern}")
            return
        
        print(f"📋 Found {len(keys)} keys matching pattern: {pattern}")
        print("\nSample keys (first 10):")
        for key in keys[:10]:
            key_str = key.decode('utf-8')
            ttl = r.ttl(key)
            print(f"  - {key_str} (TTL: {ttl}s)")
        
        if len(keys) > 10:
            print(f"  ... and {len(keys) - 10} more keys\n")
        else:
            print()
        
        # Confirm deletion
        confirm = input(f"🗑️  Delete all {len(keys)} keys? (yes/no): ").strip().lower()
        
        if confirm != 'yes':
            print("❌ Deletion cancelled")
            return
        
        # Delete keys in batches
        print(f"\n🧹 Deleting {len(keys)} keys...")
        deleted = 0
        for key in keys:
            r.delete(key)
            deleted += 1
            if deleted % 100 == 0:
                print(f"  Deleted {deleted}/{len(keys)} keys...")
        
        print(f"\n✅ Successfully deleted {deleted} keys")
        
    except redis.ConnectionError as e:
        print(f"❌ Failed to connect to Redis: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"❌ Error: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
