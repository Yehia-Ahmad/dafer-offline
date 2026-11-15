const mongoose = require("mongoose");
const auditFieldsPlugin = require("../auth/auditFields.plugin");
const isBase64Image = require("../utils/isBase64Image");
const { calculatePriceAfterDiscount } = require("../utils/productPricing");
const { validateBarcodeArray } = require("../utils/barcode");

const productSchema = new mongoose.Schema(
  {
    isArchived: { type: Boolean, index: true },
    // Stage 21: a VAT-exempt product (معفى من الضريبة). Invoice lines snapshot this when the invoice is saved.
    vatExempt: { type: Boolean },
    archivedAt: Date,
    archivedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    name: {
      type: String,
      required: [true, "اسم المنتج مطلوب"],
      trim: true,
      maxlength: [200, "يجب ألا يزيد اسم المنتج عن 200 حرف"],
    },
    code: {
      type: String,
      required: [true, "كود المنتج مطلوب"],
      trim: true,
      maxlength: [100, "يجب ألا يزيد كود المنتج عن 100 حرف"],
    },
    // Stage 26: 0-5 barcodes (a factory EAN/UPC or Code 128, or a generated in-store EAN-13 "2…").
    // Separate from `code` (the shop's internal code). Unique across non-archived products (index below).
    barcodes: {
      type: [String],
      default: undefined,
      validate: {
        validator: validateBarcodeArray,
        message: "الباركود غير صالح أو متكرر (أقصى عدد 5)",
      },
    },
    inventoryCount: {
      type: Number,
      required: [true, "عدد المنتج في المخزون مطلوب"],
      min: [0, "عدد المخزون لا يمكن أن يكون سالبًا"],
    },
    image: {
      type: String,
      trim: true,
      validate: {
        validator: isBase64Image,
        message:
          "يجب أن تكون صورة المنتج سلسلة base64 صالحة (خام أو بصيغة data URI)",
      },
    },
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      required: [true, "معرّف الفئة مطلوب"],
    },
    wholesalePrice: {
      type: Number,
      required: [true, "سعر الجملة مطلوب"],
      min: [0, "سعر الجملة لا يمكن أن يكون سالبًا"],
    },
    purchasePrice: {
      type: Number,
      default: 0,
      min: [0, "سعر الشراء لا يمكن أن يكون سالبًا"],
      validate: {
        validator: function validatePurchasePrice(value) {
          const purchasePrice = Number(value);
          if (!Number.isFinite(purchasePrice)) return false;

          const wholesalePrice = Number(this.wholesalePrice);
          if (Number.isFinite(wholesalePrice) && purchasePrice > wholesalePrice) {
            return false;
          }

          const retailPrice = Number(this.retailPrice);
          if (Number.isFinite(retailPrice) && purchasePrice > retailPrice) {
            return false;
          }

          return true;
        },
        message: "سعر الشراء لا يمكن أن يكون أكبر من سعر الجملة أو التجزئة",
      },
    },
    retailPrice: {
      type: Number,
      required: [true, "سعر التجزئة مطلوب"],
      min: [0, "سعر التجزئة لا يمكن أن يكون سالبًا"],
      validate: {
        validator: function validateRetailPrice(value) {
          return value >= this.wholesalePrice;
        },
        message: "يجب أن يكون سعر التجزئة أكبر من أو يساوي سعر الجملة",
      },
    },
    discountPercentage: {
      type: Number,
      default: 0,
      min: [0, "نسبة الخصم لا يمكن أن تكون أقل من صفر"],
      max: [100, "نسبة الخصم لا يمكن أن تكون أكبر من 100"],
    },
    soldItemCount: {
      type: Number,
      default: 0,
      min: [0, "عدد العناصر المباعة لا يمكن أن يكون سالبًا"],
    },
    // Stage 12 (optional): "low stock" when inventoryCount <= this. Not set → clients and the dashboard use 5.
    lowStockThreshold: {
      type: Number,
      min: [0, "حد التنبيه للمخزون لا يمكن أن يكون سالبًا"],
    },
    specifications: {
      type: [
        {
          type: mongoose.Schema.Types.Mixed,
        },
      ],
      default: [],
    },
  },
  { timestamps: true }
);

productSchema.index({ category: 1, createdAt: -1 });
// Stage 26: no two non-archived products share a barcode. Multikey + partial:
//   * isArchived: { $in: [false, null] } → "not archived" whether the flag is false or missing (null matches
//     a missing field; a partial filter cannot use $ne / $not). Archiving (true) takes the product out of the
//     index, which frees its barcodes; unarchiving puts it back, and a clash raises E11000;
//   * barcodes: { $type: "string" } → only arrays holding at least one barcode are indexed (a unique
//     multikey index would otherwise store every empty array as the same `undefined` key).
// Repeats inside ONE product are not caught by a multikey index: the validator above refuses them.
productSchema.index(
  { barcodes: 1 },
  {
    name: "barcodes_unique_active",
    unique: true,
    partialFilterExpression: { isArchived: { $in: [false, null] }, barcodes: { $type: "string" } },
  }
);

productSchema.virtual("priceAfterDiscount").get(function getPriceAfterDiscount() {
  return calculatePriceAfterDiscount(this.retailPrice, this.discountPercentage);
});

productSchema.set("toJSON", {
  virtuals: true,
  transform: (_document, returnedObject) => {
    delete returnedObject.id;
    return returnedObject;
  },
});

// Stage 13: createdBy / updatedBy from the signed-in user (nothing when auth is off).
productSchema.plugin(auditFieldsPlugin, { ignorePaths: ["inventoryCount", "soldItemCount"] });
module.exports = mongoose.model("Product", productSchema);
