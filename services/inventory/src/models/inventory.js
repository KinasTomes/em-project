const mongoose = require("mongoose");

const inventorySchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      unique: true,
      index: true,
    },
    available: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    reserved: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    backorder: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    lastRestockedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Virtual field for total stock
inventorySchema.virtual("total").get(function () {
  return this.available + this.reserved;
});

// Method to check if product is in stock
inventorySchema.methods.isInStock = function (quantity = 1) {
  return this.available >= quantity;
};

// Method to check if product can fulfill order
inventorySchema.methods.canFulfill = function (quantity) {
  return this.available >= quantity;
};

// Static method to get low stock items
inventorySchema.statics.getLowStock = function (threshold = 10) {
  return this.find({ available: { $lte: threshold, $gt: 0 } });
};

// Static method to get out of stock items
inventorySchema.statics.getOutOfStock = function () {
  return this.find({ available: 0 });
};

const Inventory = mongoose.model("Inventory", inventorySchema);

module.exports = Inventory;
