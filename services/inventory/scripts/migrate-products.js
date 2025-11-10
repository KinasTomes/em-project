/**
 * Migration script to sync Product IDs with Inventory
 * Run this after products are created to initialize their inventory
 */
const mongoose = require("mongoose");
const axios = require("axios");
const Inventory = require("../src/models/inventory");
require("dotenv").config();

const MONGODB_URI =
  process.env.MONGODB_INVENTORY_URI ||
  "mongodb://root:example@localhost:27020/inventoryDB?authSource=admin";
const PRODUCT_SERVICE_URL =
  process.env.PRODUCT_SERVICE_URL || "http://localhost:3004";

async function syncProductInventory() {
  try {
    console.log("🔄 [Migration] Starting product inventory sync...");

    // Connect to MongoDB
    console.log("⏳ [Migration] Connecting to MongoDB...");
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 30000,
    });
    console.log("✓ [Migration] Connected to MongoDB");

    // Get JWT token (you may need to provide credentials)
    console.log("🔐 [Migration] Authenticating...");
    const authResponse = await axios.post("http://localhost:3001/login", {
      username: "testuser",
      password: "testpass123",
    });
    const token = authResponse.data.token;
    console.log("✓ [Migration] Authenticated successfully");

    // Fetch all products from Product Service
    console.log("📦 [Migration] Fetching products...");
    const productsResponse = await axios.get(
      `${PRODUCT_SERVICE_URL}/api/products`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    const products = productsResponse.data;
    console.log(`✓ [Migration] Found ${products.length} products`);

    // Create inventory for each product if it doesn't exist
    console.log("📊 [Migration] Creating inventory records...");
    let created = 0;
    let skipped = 0;

    for (const product of products) {
      const existingInventory = await Inventory.findOne({
        productId: product._id,
      });

      if (!existingInventory) {
        await Inventory.create({
          productId: product._id,
          available: 0, // Start with 0, admin needs to restock
          reserved: 0,
          backorder: 0,
        });
        console.log(
          `✓ Created inventory for product: ${product.name} (${product._id})`
        );
        created++;
      } else {
        console.log(
          `⊘ Inventory already exists for: ${product.name} (${product._id})`
        );
        skipped++;
      }
    }

    console.log(`\n✅ [Migration] Migration completed!`);
    console.log(`   - Created: ${created} inventory records`);
    console.log(`   - Skipped: ${skipped} existing records`);
  } catch (error) {
    console.error("❌ [Migration] Error:", error.message);
    if (error.response) {
      console.error("   Response:", error.response.data);
    }
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log("👋 [Migration] MongoDB connection closed");
  }
}

// Run the migration
syncProductInventory();
