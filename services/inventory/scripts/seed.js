/**
 * Seed script for Inventory Service
 * Initializes inventory data for testing
 */
const mongoose = require("mongoose");
const Inventory = require("../src/models/inventory");
require("dotenv").config();

const MONGODB_URI =
  process.env.MONGODB_INVENTORY_URI ||
  "mongodb://root:example@localhost:27020/inventoryDB?authSource=admin";

// Sample inventory data
const inventoryData = [
  {
    productId: new mongoose.Types.ObjectId(),
    available: 100,
    reserved: 0,
    backorder: 0,
  },
  {
    productId: new mongoose.Types.ObjectId(),
    available: 50,
    reserved: 5,
    backorder: 0,
  },
  {
    productId: new mongoose.Types.ObjectId(),
    available: 5,
    reserved: 0,
    backorder: 10,
  },
  {
    productId: new mongoose.Types.ObjectId(),
    available: 0,
    reserved: 0,
    backorder: 20,
  },
];

async function seedInventory() {
  try {
    console.log("🌱 [Seed] Connecting to MongoDB...");
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 30000,
    });
    console.log("✓ [Seed] Connected to MongoDB");

    // Clear existing data
    console.log("🗑️  [Seed] Clearing existing inventory data...");
    await Inventory.deleteMany({});
    console.log("✓ [Seed] Cleared existing data");

    // Insert seed data
    console.log("📦 [Seed] Inserting inventory data...");
    const result = await Inventory.insertMany(inventoryData);
    console.log(`✓ [Seed] Inserted ${result.length} inventory records`);

    // Display summary
    console.log("\n📊 [Seed] Inventory Summary:");
    console.table(
      result.map((item) => ({
        ProductID: item.productId.toString(),
        Available: item.available,
        Reserved: item.reserved,
        Backorder: item.backorder,
        Total: item.available + item.reserved,
      }))
    );

    console.log("\n✅ [Seed] Seed completed successfully!");
  } catch (error) {
    console.error("❌ [Seed] Error seeding inventory:", error.message);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log("👋 [Seed] MongoDB connection closed");
  }
}

// Run the seed function
seedInventory();
