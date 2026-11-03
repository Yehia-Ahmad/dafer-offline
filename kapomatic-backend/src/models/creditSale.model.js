const mongoose = require("mongoose");

const creditSalePaymentSchema = new mongoose.Schema(
  {
    amount: {
      type: Number,
      required: [true, "قيمة الدفعة مطلوبة"],
      min: [0.01, "قيمة الدفعة يجب أن تكون أكبر من صفر"],
    },
    paymentDate: {
      type: Date,
      required: [true, "تاريخ الدفعة مطلوب"],
    },
    note: {
      type: String,
      trim: true,
      maxlength: [500, "يجب ألا يزيد وصف الدفعة عن 500 حرف"],
    },
  },
  { _id: true }
);

const creditSaleItemSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: [true, "معرّف المنتج مطلوب"],
    },
    productName: {
      type: String,
      required: [true, "اسم المنتج مطلوب"],
      trim: true,
      maxlength: [200, "يجب ألا يزيد اسم المنتج عن 200 حرف"],
    },
    categoryName: {
      type: String,
      trim: true,
      maxlength: [120, "يجب ألا يزيد اسم الفئة عن 120 حرف"],
    },
    quantity: {
      type: Number,
      required: [true, "كمية المنتج مطلوبة"],
      min: [1, "يجب أن تكون كمية المنتج 1 على الأقل"],
    },
    unitPrice: {
      type: Number,
      required: [true, "سعر المنتج للوحدة مطلوب"],
      min: [0, "سعر المنتج للوحدة لا يمكن أن يكون سالبًا"],
    },
    totalPrice: {
      type: Number,
      required: [true, "السعر الإجمالي مطلوب"],
      min: [0, "السعر الإجمالي لا يمكن أن يكون سالبًا"],
    },
    purchasePrice: {
      type: Number,
      default: 0,
      min: [0, "سعر الشراء لا يمكن أن يكون سالبًا"],
    },
    profitAmount: {
      type: Number,
      default: 0,
    },
  },
  { _id: true }
);

const creditSaleRefundItemSchema = new mongoose.Schema(
  {
    invoiceItemId: {
      type: mongoose.Schema.Types.ObjectId,
      required: [true, "معرّف عنصر الفاتورة المطلوب للمرتجع"],
    },
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: [true, "معرّف المنتج مطلوب"],
    },
    productName: {
      type: String,
      required: [true, "اسم المنتج مطلوب"],
      trim: true,
      maxlength: [200, "يجب ألا يزيد اسم المنتج عن 200 حرف"],
    },
    categoryName: {
      type: String,
      trim: true,
      maxlength: [120, "يجب ألا يزيد اسم الفئة عن 120 حرف"],
    },
    quantity: {
      type: Number,
      required: [true, "كمية المرتجع مطلوبة"],
      min: [1, "يجب أن تكون كمية المرتجع 1 على الأقل"],
    },
    unitPrice: {
      type: Number,
      required: [true, "سعر المنتج للوحدة مطلوب"],
      min: [0, "سعر المنتج للوحدة لا يمكن أن يكون سالبًا"],
    },
    totalPrice: {
      type: Number,
      required: [true, "إجمالي قيمة المرتجع مطلوبة"],
      min: [0, "إجمالي قيمة المرتجع لا يمكن أن يكون سالبًا"],
    },
  },
  { _id: true }
);

const creditSaleRefundSchema = new mongoose.Schema(
  {
    refundDate: {
      type: Date,
      required: [true, "تاريخ المرتجع مطلوب"],
    },
    note: {
      type: String,
      trim: true,
      maxlength: [500, "يجب ألا يزيد وصف المرتجع عن 500 حرف"],
    },
    items: {
      type: [creditSaleRefundItemSchema],
      default: undefined,
    },
    totalQuantity: {
      type: Number,
      required: [true, "إجمالي كمية المرتجع مطلوب"],
      min: [1, "إجمالي كمية المرتجع يجب أن يكون 1 على الأقل"],
    },
    totalAmount: {
      type: Number,
      required: [true, "إجمالي قيمة المرتجع مطلوب"],
      min: [0, "إجمالي قيمة المرتجع لا يمكن أن يكون سالبًا"],
    },
    returnedPaidAmount: {
      type: Number,
      default: 0,
      min: [0, "المبلغ المدفوع المُعاد لا يمكن أن يكون سالبًا"],
    },
    reallocatedPaidAmount: {
      type: Number,
      default: 0,
      min: [0, "المبلغ المدفوع المُعاد توزيعه لا يمكن أن يكون سالبًا"],
    },
    returnLog: { type: mongoose.Schema.Types.ObjectId, ref: "ReturnLog" },
  },
  { _id: true }
);

const creditSaleSchema = new mongoose.Schema(
  {
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: [true, "معرّف العميل مطلوب"],
      index: true,
    },
    customerName: {
      type: String,
      required: [true, "اسم العميل مطلوب"],
      trim: true,
      maxlength: [200, "يجب ألا يزيد اسم العميل عن 200 حرف"],
    },
    customerPhone: {
      type: String,
      required: [true, "رقم هاتف العميل مطلوب"],
      trim: true,
      maxlength: [30, "يجب ألا يزيد رقم هاتف العميل عن 30 حرف"],
    },
    sellingDate: {
      type: Date,
      required: [true, "تاريخ البيع مطلوب"],
      index: true,
    },
    dueDate: {
      type: Date,
    },
    items: {
      type: [creditSaleItemSchema],
      default: undefined,
    },
    totalQuantity: {
      type: Number,
      required: [true, "إجمالي الكمية مطلوب"],
      min: [0, "إجمالي الكمية لا يمكن أن يكون سالبًا"],
    },
    discountAmount: {
      type: Number,
      min: [0, "قيمة الخصم لا يمكن أن تكون سالبة"],
    },
    // Legacy field kept optional so older percentage-based records still load safely.
    discountPercentage: {
      type: Number,
      min: [0, "نسبة الخصم لا يمكن أن تكون سالبة"],
      max: [100, "نسبة الخصم لا يمكن أن تتجاوز 100"],
    },
    shippingFees: {
      type: Number,
      default: 0,
      min: [0, "مصاريف الشحن لا يمكن أن تكون سالبة"],
    },
    totalPrice: {
      type: Number,
      required: [true, "إجمالي السعر مطلوب"],
      min: [0, "إجمالي السعر لا يمكن أن يكون سالبًا"],
    },
    paidAmount: {
      type: Number,
      default: 0,
      min: [0, "المبلغ المدفوع لا يمكن أن يكون سالبًا"],
    },
    remainingAmount: {
      type: Number,
      required: [true, "المبلغ المتبقي مطلوب"],
      min: [0, "المبلغ المتبقي لا يمكن أن يكون سالبًا"],
    },
    refundDueAmount: {
      type: Number,
      default: 0,
      min: [0, "المبلغ المستحق إرجاعه لا يمكن أن يكون سالبًا"],
    },
    status: {
      type: String,
      enum: {
        values: ["pending", "partially_paid", "paid", "Reactionary"],
        message: "حالة البيع الآجل غير صالحة",
      },
      default: "pending",
      index: true,
    },
    refundStatus: {
      type: String,
      enum: {
        values: ["none", "partial", "full"],
        message: "حالة المرتجع غير صالحة",
      },
      default: "none",
      index: true,
    },
    refundedQuantity: {
      type: Number,
      default: 0,
      min: [0, "إجمالي كمية المرتجع لا يمكن أن يكون سالبًا"],
    },
    refundedAmount: {
      type: Number,
      default: 0,
      min: [0, "إجمالي قيمة المرتجع لا يمكن أن تكون سالبة"],
    },
    returnedPaidAmount: {
      type: Number,
      default: 0,
      min: [0, "إجمالي المبلغ المدفوع المُعاد لا يمكن أن يكون سالبًا"],
    },
    reallocatedPaidAmount: {
      type: Number,
      default: 0,
      min: [0, "إجمالي المبلغ المدفوع المُعاد توزيعه لا يمكن أن يكون سالبًا"],
    },
    notes: {
      type: String,
      trim: true,
      maxlength: [1000, "يجب ألا تزيد الملاحظات عن 1000 حرف"],
    },
    payments: {
      type: [creditSalePaymentSchema],
      default: [],
    },
    refunds: {
      type: [creditSaleRefundSchema],
      default: [],
    },
  },
  { timestamps: true }
);

creditSaleSchema.index({ "items.product": 1 });
creditSaleSchema.index({ customer: 1, status: 1, sellingDate: -1 });

module.exports = mongoose.model("CreditSale", creditSaleSchema);
