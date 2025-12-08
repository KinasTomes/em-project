#!/usr/bin/env python3

"""
Cleanup MongoDB Databases

Xóa sạch dữ liệu trong các database: inventory, order, payment, product, auth

Usage:
    python3 scripts/cleanup-databases.py

Requirements:
    pip install pymongo
"""

import os
import sys
from pymongo import MongoClient
from datetime import datetime

# ============================================
# CONFIG
# ============================================
MONGO_URI = os.getenv(
    'MONGO_URI',
    'mongodb+srv://trinhquanghunglk2014_db_user:QoGsDF5k2YFyzE50@testproduct.va2tbdm.mongodb.net/?retryWrites=true&w=majority'
)

DATABASES = ['inventory', 'order', 'payment', 'product', 'auth']

# ============================================
# COLORS
# ============================================
class Colors:
    RESET = '\033[0m'
    GREEN = '\033[32m'
    RED = '\033[31m'
    YELLOW = '\033[33m'
    BLUE = '\033[34m'
    CYAN = '\033[36m'
    BRIGHT = '\033[1m'

def log(msg, color=Colors.RESET):
    print(f'{color}{msg}{Colors.RESET}')

# ============================================
# MAIN
# ============================================
def main():
    log('\n' + '='*60, Colors.CYAN)
    log('🗑️  MongoDB Database Cleanup', Colors.BRIGHT + Colors.CYAN)
    log('='*60, Colors.CYAN)
    log(f'MongoDB Atlas: testproduct.va2tbdm.mongodb.net')
    log(f'Databases: {", ".join(DATABASES)}')
    log('='*60 + '\n', Colors.CYAN)

    try:
        # Connect to MongoDB
        log('Connecting to MongoDB Atlas...', Colors.BLUE)
        client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
        # Test connection
        client.server_info()
        log('✓ Connected to MongoDB Atlas\n', Colors.GREEN)

        # Clean each database
        for db_name in DATABASES:
            log(f'[{db_name}] Cleaning database...', Colors.BRIGHT)
            
            db = client[db_name]
            
            # Get all collections
            collections = db.list_collection_names()
            
            if len(collections) == 0:
                log(f'  ℹ No collections found (database may not exist)', Colors.YELLOW)
                continue
            
            log(f'  Found {len(collections)} collection(s)', Colors.BLUE)

            # Delete all documents in each collection
            for collection_name in collections:
                # Skip system collections
                if collection_name.startswith('system.'):
                    continue

                try:
                    collection = db[collection_name]
                    count = collection.count_documents({})
                    collection.delete_many({})
                    log(f'  ✓ Deleted {count} document(s) from {collection_name}', Colors.GREEN)
                except Exception as error:
                    log(f'  ✗ Failed to clean {collection_name}: {str(error)}', Colors.RED)

            log(f'  ✓ Database {db_name} cleaned\n', Colors.GREEN)

        log('='*60, Colors.CYAN)
        log('✅ Cleanup completed successfully!', Colors.BRIGHT + Colors.GREEN)
        log('='*60 + '\n', Colors.CYAN)

        client.close()
        log('✓ MongoDB connection closed', Colors.BLUE)

    except Exception as error:
        log(f'\n❌ ERROR: {str(error)}', Colors.RED)
        sys.exit(1)

if __name__ == '__main__':
    main()
