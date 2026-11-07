const mongoose = require("mongoose");
const ExcelJS = require("exceljs");
const Category = require("../models/category.model");
const CreditSale = require("../models/creditSale.model");
const Product = require("../models/product.model");
const Selling = require("../models/selling.model");
const ReturnLog = require("../models/returnLog.model");
const asyncHandler = require("../utils/asyncHandler");
const { buildInvoiceTotals, roundMoney } = require("../utils/invoicePricing");
const { calculatePriceAfterDiscount } = require("../utils/productPricing");
const { withTransaction } = require("../utils/transaction");
const { postCostSync, getLedgerStartAt, isLedgerDocument, returnedUnits } = require("../accounting/posting");
const { postStockAdjustment } = require("../accounting/opening");
const { audit } = require("../auth/audit");
const { hasPermission } = require("../auth/middleware");

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const CATEGORY_PRODUCT_FIELDS = "name image specifications";

// Pagination defaults and limits are kept in one place so the endpoint's
// validation rules cannot drift from the values returned in its metadata.
const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;
const MAX_PAGE = Math.floor(Number.MAX_SAFE_INTEGER / MAX_LIMIT);

// Query string values are untrusted strings (or arrays). Only positive, safe
// integers are accepted; invalid values fall back to the documented defaults.
const parsePaginationInteger = (value, defaultValue, maxValue = Infinity) => {
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) {
    return defaultValue;
  }

  const parsedValue = Number(value);
  if (
    !Number.isSafeInteger(parsedValue) ||
    parsedValue < 1 ||
    parsedValue > maxValue
  ) {
    return defaultValue;
  }

  return parsedValue;
};

const isTruthyFlag = (value) => {
  if (typeof value === "string") {
    const normalizedValue = value.trim().toLowerCase();
    return normalizedValue === "true" || normalizedValue === "1";
  }

  return value === true || value === 1;
};

const parseOptionalObjectId = (value, fieldLabel, res) => {
  if (value === undefined) return undefined;

  if (typeof value !== "string" || !mongoose.Types.ObjectId.isValid(value)) {
    res.status(400);
    throw new Error(`تنسيق ${fieldLabel} غير صالح`);
  }

  return value;
};

const parseOptionalDate = (value, fieldLabel, res, endOfDay = false) => {
  if (value === undefined) return undefined;

  if (typeof value !== "string" || !value.trim()) {
    res.status(400);
    throw new Error(`${fieldLabel} غير صالح`);
  }

  const parsedDate = new Date(value);
  if (Number.isNaN(parsedDate.getTime())) {
    res.status(400);
    throw new Error(`تنسيق ${fieldLabel} غير صالح`);
  }

  if (endOfDay) {
    parsedDate.setUTCHours(23, 59, 59, 999);
  } else {
    parsedDate.setUTCHours(0, 0, 0, 0);
  }

  return parsedDate;
};

const parseOptionalBodyDate = (value, fieldLabel, res, endOfDay = false) => {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  return parseOptionalDate(String(value), fieldLabel, res, endOfDay);
};

const getSpecificationsFromBody = (body) =>
  body.specifications !== undefined ? body.specifications : body.Specifications;

const validateSpecifications = (specifications, res) => {
  if (specifications === undefined) return undefined;

  if (
    !Array.isArray(specifications) ||
    specifications.some(
      (specification) =>
        !specification ||
        typeof specification !== "object" ||
        Array.isArray(specification)
    )
  ) {
    res.status(400);
    throw new Error("يجب أن تكون المواصفات مصفوفة من الكائنات");
  }

  return specifications;
};

// Stage 12: optional per-product low-stock threshold. undefined = not sent; null = clear it.
const normalizeLowStockThreshold = (value, res) => {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;

  const threshold = Number(value);
  if (!Number.isFinite(threshold) || threshold < 0) {
    res.status(400);
    throw new Error("يجب أن يكون حد التنبيه للمخزون رقمًا غير سالب");
  }

  return threshold;
};

const normalizeDiscountPercentage = (value, res) => {
  const discountPercentage = Number(value);

  if (
    !Number.isFinite(discountPercentage) ||
    discountPercentage < 0 ||
    discountPercentage > 100
  ) {
    res.status(400);
    throw new Error("يجب أن تكون نسبة الخصم رقمًا من 0 إلى 100");
  }

  return discountPercentage;
};

const cloneSpecifications = (specifications = []) =>
  specifications.map((specification) => JSON.parse(JSON.stringify(specification)));

const normalizeYear = (value, res) => {
  if (value === undefined) {
    return new Date().getUTCFullYear();
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    res.status(400);
    throw new Error("يجب أن تكون قيمة year رقمًا صحيحًا موجبًا");
  }

  return parsed;
};

const getSellingItemProductId = (item) => {
  if (item.product && typeof item.product === "object" && item.product._id !== undefined) {
    return item.product._id;
  }

  return item.product;
};

const getSellingItems = (selling) => {
  if (Array.isArray(selling.items) && selling.items.length > 0) {
    return selling.items;
  }

  if (!selling.product) {
    return [];
  }

  return [
    {
      _id: selling._id,
      product: selling.product,
      productName: selling.productName,
      categoryName: selling.categoryName,
      quantity: selling.quantity,
      unitPrice: selling.unitPrice,
      totalPrice:
        selling.unitPrice !== undefined && selling.quantity !== undefined
          ? roundMoney(Number(selling.unitPrice || 0) * Number(selling.quantity || 0))
          : roundMoney(Number(selling.totalPrice || 0)),
      purchasePrice: 0,
      profitAmount: 0,
    },
  ];
};

const getCreditSaleItemProductId = (item) => {
  if (item.product && typeof item.product === "object" && item.product._id !== undefined) {
    return item.product._id;
  }

  return item.product;
};

const allocateItemDiscounts = (items, discountAmount) => {
  const normalizedDiscountAmount = roundMoney(discountAmount || 0);
  const subtotal = roundMoney(items.reduce((sum, item) => sum + Number(item.totalPrice || 0), 0));

  if (normalizedDiscountAmount <= 0 || subtotal <= 0 || items.length === 0) {
    return items.map(() => 0);
  }

  let remainingDiscount = normalizedDiscountAmount;

  return items.map((item, index) => {
    if (index === items.length - 1) {
      return roundMoney(remainingDiscount);
    }

    const allocatedDiscount = roundMoney(
      (normalizedDiscountAmount * Number(item.totalPrice || 0)) / subtotal
    );
    remainingDiscount = roundMoney(remainingDiscount - allocatedDiscount);
    return allocatedDiscount;
  });
};

// Stage 21: with prices including VAT the VAT inside a line is not revenue or profit. The line's VAT share was stored when
// the invoice was saved (item.vatAmount); with prices excluding VAT the line price is already net.
const vatInsideLine = (invoice, item, remainingRatio) =>
  invoice.vatRate !== undefined && invoice.vatRate !== null && invoice.vatIncluded !== false
    ? roundMoney(Number(item.vatAmount || 0) * remainingRatio)
    : 0;

const buildProductProfitReportRow = (product) => ({
  productId: product._id,
  productName: product.name,
  categoryId: product.category?._id ?? null,
  categoryName: product.category?.name ?? "Uncategorized",
  purchasePrice: roundMoney(Number(product.purchasePrice ?? product.wholesalePrice ?? 0)),
  discountPercentage: Number(product.discountPercentage || 0),
  priceAfterDiscount: calculatePriceAfterDiscount(
    product.retailPrice,
    product.discountPercentage
  ),
  totalProfit: 0,
  profitValue: 0,
  lastSellingDate: null,
  lastSellingPrice: null,
  invoices: [],
});

const updateRowLatestSelling = (row, sellingDate, sellingPrice) => {
  const normalizedSellingPrice = roundMoney(sellingPrice || 0);

  if (!row.lastSellingDate || new Date(sellingDate) > new Date(row.lastSellingDate)) {
    row.lastSellingDate = sellingDate;
    row.lastSellingPrice = normalizedSellingPrice;
  }
};

const addInvoiceToProductProfitReport = ({
  row,
  invoiceId,
  invoiceType,
  sellingDate,
  quantity,
  sellingPrice,
  revenue,
  purchasePrice,
  profit,
  number,
  costEstimated,
}) => {
  row.totalProfit = roundMoney(Number(row.totalProfit || 0) + Number(profit || 0));
  row.profitValue = row.totalProfit;
  updateRowLatestSelling(row, sellingDate, sellingPrice);

  const existingInvoice = row.invoices.find(
    (invoice) => invoice.type === invoiceType && String(invoice.invoiceId) === String(invoiceId)
  );

  if (existingInvoice) {
    const nextQuantity = Number(existingInvoice.quantity || 0) + Number(quantity || 0);
    const grossAmount =
      Number(existingInvoice.sellingPrice || 0) * Number(existingInvoice.quantity || 0) +
      Number(sellingPrice || 0) * Number(quantity || 0);

    existingInvoice.quantity = nextQuantity;
    existingInvoice.sellingPrice = nextQuantity > 0 ? roundMoney(grossAmount / nextQuantity) : 0;
    existingInvoice.revenue = roundMoney(Number(existingInvoice.revenue || 0) + Number(revenue || 0));
    existingInvoice.profit = roundMoney(Number(existingInvoice.profit || 0) + Number(profit || 0));
    existingInvoice.costEstimated = existingInvoice.costEstimated || Boolean(costEstimated);
    return;
  }

  row.invoices.push({
    invoiceId,
    number: number ?? null,
    type: invoiceType,
    sellingDate,
    sellingPrice: roundMoney(sellingPrice || 0),
    quantity: Number(quantity || 0),
    revenue: roundMoney(revenue || 0),
    purchasePrice: roundMoney(purchasePrice || 0),
    profit: roundMoney(profit || 0),
    costEstimated: Boolean(costEstimated),
  });
};

const buildProductProfitRows = async ({ products, startDate, endDate }) => {
  const rows = products.map(buildProductProfitReportRow);
  const rowsByProductId = new Map(rows.map((row) => [row.productId.toString(), row]));
  const productIds = [...rowsByProductId.keys()];

  if (productIds.length === 0) {
    return rows;
  }

  const dateQuery = {};
  if (startDate || endDate) {
    dateQuery.sellingDate = {};
    if (startDate) dateQuery.sellingDate.$gte = startDate;
    if (endDate) dateQuery.sellingDate.$lte = endDate;
  }

  const [sellings, creditSales] = await Promise.all([
    Selling.find({
      ...dateQuery,
      status: { $ne: "cancelled" },
      $or: [{ "items.product": { $in: productIds } }, { product: { $in: productIds } }],
    }).lean(),
    CreditSale.find({
      ...dateQuery,
      status: { $ne: "cancelled" },
      "items.product": { $in: productIds },
    }).lean(),
  ]);

  for (const selling of sellings) {
    const items = getSellingItems(selling);
    const invoiceTotals = buildInvoiceTotals(items, {
      discountAmount: selling.discountAmount,
      discountPercentage: selling.discountPercentage,
      shippingFees: selling.shippingFees,
    });
    const itemDiscounts = allocateItemDiscounts(items, invoiceTotals.discountAmount);

    items.forEach((item, index) => {
      const productId = getSellingItemProductId(item)?.toString();
      const row = rowsByProductId.get(productId);
      if (!row) return;

      const originalQuantity = Number(item.quantity || 0);
      const quantity = Math.max(0, originalQuantity - Number(item.returnedQuantity || 0));
      if (quantity <= 0) return;
      const sellingPrice = roundMoney(Number(item.unitPrice || 0));
      const totalPrice = roundMoney(Number(item.unitPrice || 0) * quantity);
      const purchasePrice = roundMoney(Number(item.purchasePrice ?? 0));
      const remainingRatio = originalQuantity > 0 ? quantity / originalQuantity : 0;
      const remainingDiscount = roundMoney(Number(itemDiscounts[index] || 0) * remainingRatio);
      const vatInside = vatInsideLine(selling, item, remainingRatio);
      const revenue = roundMoney(totalPrice - remainingDiscount - vatInside);
      const profit =
        item.profitAmount !== undefined && item.profitAmount !== null
          ? roundMoney((Number(item.profitAmount || 0) - Number(itemDiscounts[index] || 0)) * remainingRatio - vatInside)
          : roundMoney(revenue - purchasePrice * quantity);

      addInvoiceToProductProfitReport({
        row,
        invoiceId: selling.invoiceId ?? selling._id,
        number: selling.number,
        invoiceType: "cash",
        sellingDate: selling.sellingDate,
        quantity,
        sellingPrice,
        revenue,
        purchasePrice,
        profit,
        costEstimated: item.costEstimated,
      });
    });
  }

  for (const creditSale of creditSales) {
    const items = Array.isArray(creditSale.items) ? creditSale.items : [];
    const invoiceTotals = buildInvoiceTotals(items, {
      discountAmount: creditSale.discountAmount,
      discountPercentage: creditSale.discountPercentage,
      shippingFees: creditSale.shippingFees,
    });
    const itemDiscounts = allocateItemDiscounts(items, invoiceTotals.discountAmount);

    items.forEach((item, index) => {
      const productId = getCreditSaleItemProductId(item)?.toString();
      const row = rowsByProductId.get(productId);
      if (!row) return;

      const originalQuantity = Number(item.quantity || 0);
      const quantity = Math.max(0, originalQuantity - Number(item.returnedQuantity || 0));
      if (quantity <= 0) return;
      const sellingPrice = roundMoney(Number(item.unitPrice || 0));
      const totalPrice = roundMoney(Number(item.unitPrice || 0) * quantity);
      const purchasePrice = roundMoney(Number(item.purchasePrice ?? 0));
      const remainingRatio = originalQuantity > 0 ? quantity / originalQuantity : 0;
      const remainingDiscount = roundMoney(Number(itemDiscounts[index] || 0) * remainingRatio);
      const vatInside = vatInsideLine(creditSale, item, remainingRatio);
      const revenue = roundMoney(totalPrice - remainingDiscount - vatInside);
      const profit =
        item.profitAmount !== undefined && item.profitAmount !== null
          ? roundMoney((Number(item.profitAmount || 0) - Number(itemDiscounts[index] || 0)) * remainingRatio - vatInside)
          : roundMoney(revenue - purchasePrice * quantity);

      addInvoiceToProductProfitReport({
        row,
        invoiceId: creditSale._id,
        number: creditSale.number,
        invoiceType: "credit",
        sellingDate: creditSale.sellingDate,
        quantity,
        sellingPrice,
        revenue,
        purchasePrice,
        profit,
        costEstimated: item.costEstimated,
      });
    });
  }

  rows.forEach((row) => {
    row.invoices.sort((left, right) => new Date(right.sellingDate) - new Date(left.sellingDate));
  });

  return rows;
};

const getProducts = asyncHandler(async (req, res) => {
  const { categoryId } = req.query;
  // Stage 12 (optional): name/code contains, case-insensitive.
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";

  // Invalid page/limit values intentionally use defaults instead of returning
  // an error, as required by the public API contract.
  const limit = parsePaginationInteger(req.query.limit, DEFAULT_LIMIT, MAX_LIMIT);
  // Cap the page at a technical maximum that guarantees a safe skip value.
  const page = parsePaginationInteger(req.query.page, DEFAULT_PAGE, MAX_PAGE);
  const skip = (page - 1) * limit;

  // Stage 12: without categoryId the list covers all products (same paging and shape).
  const includeArchived = req.query.includeArchived === "1";
  if (includeArchived && req.authEnabled && !hasPermission(req.user, "products.manage")) {
    const error = new Error("ليست لديك صلاحية لعرض المنتجات المؤرشفة"); error.statusCode = 403; throw error;
  }
  const filter = includeArchived ? {} : { isArchived: { $ne: true } };
  if (categoryId) {
    const category = await Category.findById(categoryId);
    if (!category) {
      res.status(404);
      throw new Error("لم يتم العثور على فئة للمعرّف المقدم");
    }
    filter.category = categoryId;
  }

  if (search) {
    const searchRegex = new RegExp(escapeRegex(search), "i");
    filter.$or = [{ name: searchRegex }, { code: searchRegex }];
  }

  // Count and fetch use the exact same filter. skip/limit are applied by
  // MongoDB, so only the requested page is loaded into application memory.
  const [products, totalItems] = await Promise.all([
    Product.find(filter)
      .populate("category", CATEGORY_PRODUCT_FIELDS)
      // Keep the existing newest-first order and make ties deterministic so
      // records do not move between pages when createdAt values are equal.
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit),
    Product.countDocuments(filter),
  ]);

  const totalPages = Math.ceil(totalItems / limit);

  res.json({
    success: true,
    data: products,
    pagination: {
      page,
      limit,
      totalItems,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    },
  });
});

const searchProducts = asyncHandler(async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const name = typeof req.query.name === "string" ? req.query.name.trim() : "";
  const code = typeof req.query.code === "string" ? req.query.code.trim() : "";

  const searchFilters = [];

  if (q) {
    const searchRegex = new RegExp(escapeRegex(q), "i");
    searchFilters.push({ code: searchRegex }, { name: searchRegex });
  }

  if (name) {
    searchFilters.push({ name: new RegExp(escapeRegex(name), "i") });
  }

  if (code) {
    searchFilters.push({ code: new RegExp(escapeRegex(code), "i") });
  }

  if (searchFilters.length === 0) {
    res.status(400);
    throw new Error("مطلوب أحد معاملات الاستعلام q أو name أو code");
  }

  const products = await Product.find({ $or: searchFilters, isArchived: { $ne: true } })
    .populate("category", CATEGORY_PRODUCT_FIELDS)
    .sort({ createdAt: -1 });

  res.json(products);
});

const getProductById = asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id).populate(
    "category",
    CATEGORY_PRODUCT_FIELDS
  );

  if (!product) {
    res.status(404);
    throw new Error("المنتج غير موجود");
  }
  res.json(product);
});

const exportProductsExcel = asyncHandler(async (req, res) => {
  const products = await Product.find({})
    .populate("category", "name")
    .sort({ createdAt: -1 })
    .lean();

  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("المنتجات", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  worksheet.columns = [
    { header: "اسم الفئة", key: "categoryName", width: 24 },
    { header: "اسم المنتج", key: "productName", width: 32 },
    { header: "سعر الشراء", key: "purchasePrice", width: 16, style: { numFmt: "0.00" } },
    { header: "سعر الجملة", key: "wholesalePrice", width: 16, style: { numFmt: "0.00" } },
    { header: "سعر التجزئة", key: "retailPrice", width: 16, style: { numFmt: "0.00" } },
    { header: "نسبة الخصم", key: "discountPercentage", width: 16, style: { numFmt: "0.00" } },
    { header: "السعر بعد الخصم", key: "priceAfterDiscount", width: 18, style: { numFmt: "0.00" } },
    { header: "عدد القطع المباعة", key: "soldItemCount", width: 18, style: { numFmt: "0" } },
    { header: "عدد المخزون", key: "inventoryCount", width: 16, style: { numFmt: "0" } },
  ];

  const headerRow = worksheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.alignment = { vertical: "middle", horizontal: "center" };

  products.forEach((product) => {
    worksheet.addRow({
      categoryName: product.category?.name ?? "Uncategorized",
      productName: product.name ?? "",
      purchasePrice: Number(product.purchasePrice ?? product.wholesalePrice ?? 0),
      wholesalePrice: Number(product.wholesalePrice ?? 0),
      retailPrice: Number(product.retailPrice ?? 0),
      discountPercentage: Number(product.discountPercentage ?? 0),
      priceAfterDiscount: calculatePriceAfterDiscount(
        product.retailPrice,
        product.discountPercentage
      ),
      soldItemCount: Number(product.soldItemCount ?? 0),
      inventoryCount: Number(product.inventoryCount ?? 0),
    });
  });

  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    row.alignment = { vertical: "middle", horizontal: "left" };
  });

  const dateTag = new Date().toISOString().slice(0, 10);
  const filename = `products-${dateTag}.xlsx`;

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

  await workbook.xlsx.write(res);
  res.end();
});

const createProductInTransaction = async (req, res, session) => {
  const {
    name,
    code,
    inventoryCount,
    image,
    imageBase64,
    categoryId,
    wholesalePrice,
    purchasePrice,
    retailPrice,
    soldItemCount,
  } = req.body;
  const discountPercentageInput =
    req.body.discountPercentage ?? req.body.discount_percentage;
  const lowStockThreshold = normalizeLowStockThreshold(req.body.lowStockThreshold, res);

  const category = await Category.findById(categoryId).session(session);
  if (!category) {
    res.status(404);
    throw new Error("لم يتم العثور على فئة للمعرّف المقدم");
  }

  if (Number(retailPrice) < Number(wholesalePrice)) {
    res.status(400);
    throw new Error("يجب أن يكون سعر التجزئة أكبر من أو يساوي سعر الجملة");
  }

  const normalizedWholesalePrice = Number(wholesalePrice);
  const normalizedRetailPrice = Number(retailPrice);
  const normalizedPurchasePrice =
    purchasePrice !== undefined ? Number(purchasePrice) : Number(wholesalePrice || 0);
  if (!Number.isFinite(normalizedPurchasePrice) || normalizedPurchasePrice < 0) {
    res.status(400);
    throw new Error("يجب أن تكون قيمة purchasePrice رقمًا غير سالب");
  }

  if (
    Number.isFinite(normalizedWholesalePrice) &&
    normalizedPurchasePrice > normalizedWholesalePrice
  ) {
    res.status(400);
    throw new Error("لا يمكن أن تكون قيمة سعر الشراء أكبر من سعر الوحدة بالجملة");
  }

  if (Number.isFinite(normalizedRetailPrice) && normalizedPurchasePrice > normalizedRetailPrice) {
    res.status(400);
    throw new Error("لا يمكن أن تكون قيمة سعر الشراء أكبر من سعر الوحدة بالتجزئة");
  }

  const normalizedImage = imageBase64 !== undefined ? imageBase64 : image;
  const requestSpecifications = validateSpecifications(getSpecificationsFromBody(req.body), res);

  let normalizedInventoryCount = inventoryCount;
  let normalizedSoldItemCount = soldItemCount;

  if (soldItemCount !== undefined) {
    normalizedInventoryCount = Number(inventoryCount);
    normalizedSoldItemCount = Number(soldItemCount);

    if (!Number.isFinite(normalizedInventoryCount) || !Number.isFinite(normalizedSoldItemCount)) {
      res.status(400);
      throw new Error("يجب أن تكون قيمتا inventoryCount و soldItemCount أرقامًا صالحة");
    }

    if (normalizedSoldItemCount < 0) {
      res.status(400);
      throw new Error("لا يمكن أن تكون قيمة soldItemCount سالبة");
    }

    if (normalizedSoldItemCount > normalizedInventoryCount) {
      res.status(400);
      throw new Error("لا يمكن أن تكون قيمة soldItemCount أكبر من inventoryCount");
    }

    normalizedInventoryCount -= normalizedSoldItemCount;
  }

  const payload = {
    name,
    code,
    inventoryCount: normalizedInventoryCount,
    category: categoryId,
    wholesalePrice,
    purchasePrice: normalizedPurchasePrice,
    retailPrice,
    discountPercentage:
      discountPercentageInput !== undefined
        ? normalizeDiscountPercentage(discountPercentageInput, res)
        : 0,
    specifications: cloneSpecifications(
      requestSpecifications !== undefined ? requestSpecifications : category.specifications
    ),
  };

  if (normalizedImage !== undefined) {
    payload.image = normalizedImage;
  }

  if (soldItemCount !== undefined) {
    payload.soldItemCount = normalizedSoldItemCount;
  }

  // Stage 21: explicit flag, else inherit the category's bulk setting.
  if (req.body.vatExempt !== undefined) {
    if (typeof req.body.vatExempt !== "boolean") {
      res.status(400);
      throw new Error("قيمة الإعفاء من الضريبة غير صالحة");
    }
    payload.vatExempt = req.body.vatExempt;
  } else if (category.vatExempt) {
    payload.vatExempt = true;
  }

  if (lowStockThreshold !== undefined && lowStockThreshold !== null) {
    payload.lowStockThreshold = lowStockThreshold;
  }

  const product = await Product.create([payload], { session }).then((rows) => rows[0]);
  const openingStock = Number(product.inventoryCount || 0);
  if (openingStock > 0) await postStockAdjustment({ date: new Date(), source: { type: "product_create", id: product._id, number: product.code }, amount: roundMoney(openingStock * Number(product.purchasePrice || 0)), increase: true, session });
  await product.populate("category", CATEGORY_PRODUCT_FIELDS);
  return product;
};

const createProduct = asyncHandler(async (req, res) => {
  const product = await withTransaction((session) => createProductInTransaction(req, res, session));
  res.status(201).json(product);
});

const updateProductInTransaction = async (req, res, session) => {
  const product = await Product.findById(req.params.id).session(session);
  let selectedCategory;
  let originalPurchasePrice;

  if (!product) {
    res.status(404);
    throw new Error("المنتج غير موجود");
  }
  originalPurchasePrice = Number(product.purchasePrice || 0);

  if (req.body.categoryId !== undefined) {
    selectedCategory = await Category.findById(req.body.categoryId).session(session);
    if (!selectedCategory) {
      res.status(404);
      throw new Error("لم يتم العثور على فئة للمعرّف المقدم");
    }
    product.category = req.body.categoryId;
  }
  const requestSpecifications = validateSpecifications(getSpecificationsFromBody(req.body), res);

  const nextWholesale =
    req.body.wholesalePrice !== undefined ? req.body.wholesalePrice : product.wholesalePrice;
  const nextRetail = req.body.retailPrice !== undefined ? req.body.retailPrice : product.retailPrice;
  const nextPurchase =
    req.body.purchasePrice !== undefined ? req.body.purchasePrice : product.purchasePrice;

  if (Number(nextRetail) < Number(nextWholesale)) {
    res.status(400);
    throw new Error("يجب أن يكون سعر التجزئة أكبر من أو يساوي سعر الجملة");
  }

  const normalizedNextPurchase = Number(nextPurchase ?? 0);
  if (!Number.isFinite(normalizedNextPurchase) || normalizedNextPurchase < 0) {
    res.status(400);
    throw new Error("يجب أن تكون قيمة purchasePrice رقمًا غير سالب");
  }

  const normalizedNextWholesale = Number(nextWholesale);
  if (
    Number.isFinite(normalizedNextWholesale) &&
    normalizedNextPurchase > normalizedNextWholesale
  ) {
    res.status(400);
    throw new Error("لا يمكن أن تكون قيمة سعر الشراء أكبر من سعر الوحدة بالجملة");
  }

  const normalizedNextRetail = Number(nextRetail);
  if (Number.isFinite(normalizedNextRetail) && normalizedNextPurchase > normalizedNextRetail) {
    res.status(400);
    throw new Error("لا يمكن أن تكون قيمة سعر الشراء أكبر من سعر الوحدة بالتجزئة");
  }

  if (req.body.name !== undefined) product.name = req.body.name;

  if (req.body.code !== undefined) product.code = req.body.code;
  const currentInventoryCount = Number(product.inventoryCount || 0);
  const currentSoldItemCount = Number(product.soldItemCount || 0);
  const payloadInventoryCount = req.body.inventoryCount;
  const hasPayloadInventoryCount = payloadInventoryCount !== undefined;
  const normalizedPayloadInventoryCount = hasPayloadInventoryCount
    ? Number(payloadInventoryCount)
    : currentInventoryCount;
  const soldItemCountInput = req.body.soldItemCount;
  const hasSoldItemCount = soldItemCountInput !== undefined;
  const isEditProduct = isTruthyFlag(
    req.body.editProduct ?? req.body.edit_product ?? req.body["edit product"]
  );
  const newInventoryInput =
    req.body.newInventory ?? req.body.new_inventory ?? req.body["new inventory"];
  let nextInventoryCount = currentInventoryCount;

  if (hasPayloadInventoryCount) {
    if (!Number.isFinite(normalizedPayloadInventoryCount)) {
      res.status(400);
      throw new Error("يجب أن تكون قيمة inventoryCount رقمًا صالحًا");
    }

    if (normalizedPayloadInventoryCount < 0) {
      res.status(400);
      throw new Error("لا يمكن أن تكون قيمة inventoryCount سالبة");
    }
  }

  if (
    newInventoryInput !== undefined &&
    !isEditProduct &&
    (!hasPayloadInventoryCount || normalizedPayloadInventoryCount === currentInventoryCount)
  ) {
    const parsedNewInventory = Number(newInventoryInput);

    if (!Number.isFinite(parsedNewInventory)) {
      res.status(400);
      throw new Error("يجب أن تكون قيمة newInventory رقمًا صالحًا");
    }

    if (parsedNewInventory < 0) {
      res.status(400);
      throw new Error("لا يمكن أن تكون قيمة newInventory سالبة");
    }

    nextInventoryCount = currentInventoryCount + parsedNewInventory;
  } else if (hasPayloadInventoryCount) {
    nextInventoryCount = normalizedPayloadInventoryCount;
  }

  if (hasSoldItemCount) {
    const normalizedSoldItemCount = Number(soldItemCountInput);

    if (!Number.isFinite(normalizedSoldItemCount)) {
      res.status(400);
      throw new Error("يجب أن تكون قيمة soldItemCount رقمًا صالحًا");
    }

    if (normalizedSoldItemCount < 0) {
      res.status(400);
      throw new Error("لا يمكن أن تكون قيمة soldItemCount سالبة");
    }

    const shouldAdjustInventoryForSoldCount =
      !hasPayloadInventoryCount || normalizedPayloadInventoryCount === currentInventoryCount;

    if (shouldAdjustInventoryForSoldCount) {
      nextInventoryCount -= normalizedSoldItemCount - currentSoldItemCount;
    }

    if (nextInventoryCount < 0) {
      res.status(400);
      throw new Error("لا يمكن أن تكون قيمة soldItemCount أكبر من إجمالي مخزون المنتج");
    }

    product.soldItemCount = normalizedSoldItemCount;
  }

  product.inventoryCount = nextInventoryCount;
  if (req.body.imageBase64 !== undefined) {
    product.image = req.body.imageBase64;
  } else if (req.body.image !== undefined) {
    product.image = req.body.image;
  }
  if (req.body.vatExempt !== undefined) {
    if (typeof req.body.vatExempt !== "boolean") {
      res.status(400);
      throw new Error("قيمة الإعفاء من الضريبة غير صالحة");
    }
    product.vatExempt = req.body.vatExempt;
  }
  if (req.body.wholesalePrice !== undefined) product.wholesalePrice = req.body.wholesalePrice;
  if (req.body.purchasePrice !== undefined) product.purchasePrice = req.body.purchasePrice;
  if (req.body.retailPrice !== undefined) product.retailPrice = req.body.retailPrice;
  const discountPercentageInput =
    req.body.discountPercentage ?? req.body.discount_percentage;
  if (discountPercentageInput !== undefined) {
    product.discountPercentage = normalizeDiscountPercentage(discountPercentageInput, res);
  }
  const lowStockThreshold = normalizeLowStockThreshold(req.body.lowStockThreshold, res);
  if (lowStockThreshold !== undefined) {
    product.lowStockThreshold = lowStockThreshold === null ? undefined : lowStockThreshold;
  }
  if (requestSpecifications !== undefined) {
    product.specifications = cloneSpecifications(requestSpecifications);
  } else if (selectedCategory) {
    product.specifications = cloneSpecifications(selectedCategory.specifications);
  }

  const oldInventory = currentInventoryCount;
  const oldPurchase = originalPurchasePrice;
  const updatedProduct = await product.save({ session });
  const inventoryDelta = Number(updatedProduct.inventoryCount || 0) - oldInventory;
  if (inventoryDelta !== 0) await postStockAdjustment({ date: new Date(), source: { type: "inventory_adjustment", id: updatedProduct._id, number: updatedProduct.code }, amount: roundMoney(Math.abs(inventoryDelta) * Number(updatedProduct.purchasePrice || 0)), increase: inventoryDelta > 0, session });
  const purchaseDelta = Number(updatedProduct.purchasePrice || 0) - oldPurchase;
  if (purchaseDelta !== 0 && oldInventory > 0) await postStockAdjustment({ date: new Date(), source: { type: "cost_revaluation", id: updatedProduct._id, number: updatedProduct.code }, amount: roundMoney(oldInventory * Math.abs(purchaseDelta)), increase: purchaseDelta > 0, session });
  await updatedProduct.populate("category", CATEGORY_PRODUCT_FIELDS);
  return updatedProduct;
};

const updateProduct = asyncHandler(async (req, res) => {
  const updatedProduct = await withTransaction((session) => updateProductInTransaction(req, res, session));
  res.json(updatedProduct);
});

const getProductsProfitReport = asyncHandler(async (req, res) => {
  const categoryId = parseOptionalObjectId(req.query.categoryId, "معرّف الفئة", res);
  const productId = parseOptionalObjectId(req.query.productId, "معرّف المنتج", res);
  const dateFrom = parseOptionalDate(req.query.dateFrom, "dateFrom", res);
  const dateTo = parseOptionalDate(req.query.dateTo, "dateTo", res, true);

  if (dateFrom && dateTo && dateFrom > dateTo) {
    res.status(400);
    throw new Error("يجب أن يكون dateFrom أقدم من أو مساويًا لـ dateTo");
  }

  const query = {};
  if (categoryId) query.category = categoryId;
  if (productId) query._id = productId;

  const products = await Product.find(query).populate("category", "name image").sort({ name: 1 });

  if (productId && products.length === 0) {
    res.status(404);
    throw new Error("المنتج غير موجود");
  }

  const report = await buildProductProfitRows({
    products,
    startDate: dateFrom,
    endDate: dateTo,
  });

  res.json(report);
});

const getProductProfitReportById = asyncHandler(async (req, res) => {
  req.query.productId = req.params.id;
  return getProductsProfitReport(req, res);
});

const syncProductPurchasePriceInTransaction = async (req, res, session) => {
  const product = await Product.findById(req.params.id).populate("category", "name").session(session);

  if (!product) {
    res.status(404);
    throw new Error("المنتج غير موجود");
  }

  const dateFrom = parseOptionalBodyDate(req.body.dateFrom, "dateFrom", res);
  const dateTo = parseOptionalBodyDate(req.body.dateTo, "dateTo", res, true);

  if (dateFrom && dateTo && dateFrom > dateTo) {
    res.status(400);
    throw new Error("يجب أن يكون dateFrom أقدم من أو مساويًا لـ dateTo");
  }

  const purchasePrice = roundMoney(Number(product.purchasePrice ?? product.wholesalePrice ?? 0));
  const dateQuery = {};

  if (dateFrom || dateTo) {
    dateQuery.sellingDate = {};
    if (dateFrom) dateQuery.sellingDate.$gte = dateFrom;
    if (dateTo) dateQuery.sellingDate.$lte = dateTo;
  }

  const [sellings, creditSales] = await Promise.all([
    Selling.find({
      ...dateQuery,
      $or: [{ "items.product": product._id }, { product: product._id }],
    }).session(session),
    CreditSale.find({
      ...dateQuery,
      "items.product": product._id,
    }).session(session),
  ]);

  let updatedCashInvoices = 0;
  let updatedCreditInvoices = 0;
  let updatedItemsCount = 0;
  const ledgerStartAt = await getLedgerStartAt(session);
  // COGS is corrected per invoice, only for units still sold (quantity −
  // returnedQuantity), only on active invoices that belong to the ledger.
  // Returned units keep the cost their return entry already credited.
  const correctionFor = (invoice, item) => (invoice.status !== "cancelled" && isLedgerDocument(invoice, ledgerStartAt)
    ? (purchasePrice - Number(item.purchasePrice || 0)) * Math.max(0, Number(item.quantity || 0) - returnedUnits(invoice, item))
    : 0);
  const postInvoiceCostSync = async (invoice, correction) => {
    const amount = roundMoney(correction);
    if (!amount) return;
    await postCostSync({ date: new Date(), source: { type: "cost_sync", id: invoice._id, number: invoice.number }, amount: Math.abs(amount), increase: amount > 0, session, memo: `Purchase price sync ${product.code || product.name}` });
  };

  for (const selling of sellings) {
    let didUpdateInvoice = false;
    let costCorrection = 0;

    if (Array.isArray(selling.items) && selling.items.length > 0) {
      for (const item of selling.items) {
        if (String(getSellingItemProductId(item)) !== String(product._id)) continue;

        const quantity = Number(item.quantity || 0);
        costCorrection += correctionFor(selling, item);
        item.purchasePrice = purchasePrice;
        item.profitAmount = roundMoney(Number(item.totalPrice || 0) - purchasePrice * quantity);
        updatedItemsCount += 1;
        didUpdateInvoice = true;
      }
    } else if (selling.product && String(selling.product) === String(product._id)) {
      const quantity = Number(selling.quantity || 0);
      const unitPrice = Number(selling.unitPrice || 0);
      const totalPrice =
        selling.totalPrice !== undefined && selling.totalPrice !== null
          ? roundMoney(Number(selling.totalPrice || 0))
          : roundMoney(unitPrice * quantity);

      selling.items = [
        {
          _id: new mongoose.Types.ObjectId(),
          product: product._id,
          productName: selling.productName ?? product.name,
          categoryName: selling.categoryName ?? product.category?.name ?? "Uncategorized",
          quantity,
          unitPrice,
          totalPrice,
          purchasePrice,
          profitAmount: roundMoney(totalPrice - purchasePrice * quantity),
        },
      ];
      updatedItemsCount += 1;
      didUpdateInvoice = true;
    }

    if (didUpdateInvoice) {
      await selling.save({ session });
      await postInvoiceCostSync(selling, costCorrection);
      updatedCashInvoices += 1;
    }
  }

  for (const creditSale of creditSales) {
    let didUpdateInvoice = false;
    let costCorrection = 0;

    for (const item of creditSale.items) {
      if (String(getCreditSaleItemProductId(item)) !== String(product._id)) continue;

      const quantity = Number(item.quantity || 0);
      costCorrection += correctionFor(creditSale, item);
      item.purchasePrice = purchasePrice;
      item.profitAmount = roundMoney(Number(item.totalPrice || 0) - purchasePrice * quantity);
      updatedItemsCount += 1;
      didUpdateInvoice = true;
    }

    if (didUpdateInvoice) {
      await creditSale.save({ session });
      await postInvoiceCostSync(creditSale, costCorrection);
      updatedCreditInvoices += 1;
    }
  }

  await audit(req, { action: "product.sync_purchase_price", entity: "Product", entityId: product._id, details: { updatedItemsCount }, session, strict: true });
  return {
    message: "Purchase price synced to matching invoices successfully",
    productId: product._id,
    productName: product.name,
    purchasePrice,
    dateFrom: dateFrom ?? null,
    dateTo: dateTo ?? null,
    updatedCashInvoices,
    updatedCreditInvoices,
    updatedInvoices: updatedCashInvoices + updatedCreditInvoices,
    updatedItemsCount,
  };
};

const syncProductPurchasePriceToInvoices = asyncHandler(async (req, res) => {
  const result = await withTransaction((session) => syncProductPurchasePriceInTransaction(req, res, session));
  res.json(result);
});

const deleteProduct = asyncHandler(async (req, res) => {
  const result = await withTransaction(async (session) => {
    const product = await Product.findById(req.params.id).session(session);
    if (!product) { const error = new Error("المنتج غير موجود"); error.statusCode = 404; throw error; }
    const id = product._id;
    const referenced = await Promise.all([
      Selling.exists({ $or: [{ product: id }, { "items.product": id }, { "refunds.items.product": id }] }).session(session),
      CreditSale.exists({ $or: [{ "items.product": id }, { "refunds.items.product": id }] }).session(session),
      ReturnLog.exists({ "items.productId": id }).session(session),
    ]);
    if (referenced.some(Boolean)) {
      product.isArchived = true;
      product.archivedAt = new Date();
      product.archivedBy = req.user?._id ?? req.user?.id;
      await product.save({ session });
      await audit(req, { action: "product.archived", entity: "Product", entityId: id, session, strict: true });
      return { action: "archived", message: "Product archived successfully", product };
    }
    const stockValue = roundMoney(Number(product.inventoryCount || 0) * Number(product.purchasePrice || 0));
    await product.deleteOne({ session });
    if (stockValue > 0) await postStockAdjustment({ date: new Date(), source: { type: "product_writeoff", id, number: product.code }, amount: stockValue, increase: false, session });
    await audit(req, { action: "product.deleted", entity: "Product", entityId: id, session, strict: true });
    return { action: "deleted", message: "Product deleted successfully" };
  });
  res.json(result);
});

const restoreProduct = asyncHandler(async (req, res) => {
  const product = await withTransaction(async (session) => {
    const found = await Product.findById(req.params.id).session(session);
    if (!found) { const error = new Error("المنتج غير موجود"); error.statusCode = 404; throw error; }
    found.isArchived = false; found.archivedAt = undefined; found.archivedBy = undefined;
    await found.save({ session });
    await audit(req, { action: "product.restored", entity: "Product", entityId: found._id, session, strict: true });
    return found;
  });
  res.json(product);
});

const getYearProfitBarChart = asyncHandler(async (req, res) => {
  const year = normalizeYear(req.query.year, res);
  const startDate = new Date(Date.UTC(year, 0, 1, 0, 0, 0, 0));
  const endDate = new Date(Date.UTC(year + 1, 0, 1, 0, 0, 0, 0));

  const basePipeline = [
    {
      $match: {
        status: { $ne: "cancelled" },
        sellingDate: {
          $gte: startDate,
          $lt: endDate,
        },
      },
    },
    {
      $project: {
        month: { $month: "$sellingDate" },
        discountAmount: { $ifNull: ["$discountAmount", 0] },
        itemsProfit: {
          $sum: {
            $map: {
              input: { $ifNull: ["$items", []] },
              as: "item",
              in: {
                $multiply: [
                  { $ifNull: ["$$item.profitAmount", 0] },
                  {
                    $cond: [
                      { $gt: [{ $ifNull: ["$$item.quantity", 0] }, 0] },
                      {
                        $divide: [
                          { $max: [0, { $subtract: [{ $ifNull: ["$$item.quantity", 0] }, { $ifNull: ["$$item.returnedQuantity", 0] }] }] },
                          "$$item.quantity",
                        ],
                      },
                      0,
                    ],
                  },
                ],
              },
            },
          },
        },
        remainingRatio: {
          $cond: [
            { $gt: [{ $ifNull: ["$totalQuantity", 0] }, 0] },
            { $divide: [{ $max: [0, { $subtract: ["$totalQuantity", { $ifNull: ["$refundedQuantity", 0] }] }] }, "$totalQuantity"] },
            0,
          ],
        },
        // Stage 21: profit is net of VAT. With prices including VAT, the VAT inside the lines still on the invoice is removed
        // (the stored per-line share); an invoice without VAT, or with prices excluding VAT, contributes 0.
        vatInside: {
          $cond: [
            { $and: [{ $ne: [{ $type: "$vatRate" }, "missing"] }, { $ne: ["$vatIncluded", false] }] },
            {
              $sum: {
                $map: {
                  input: { $ifNull: ["$items", []] },
                  as: "item",
                  in: {
                    $multiply: [
                      { $ifNull: ["$$item.vatAmount", 0] },
                      {
                        $cond: [
                          { $gt: [{ $ifNull: ["$$item.quantity", 0] }, 0] },
                          { $divide: [{ $max: [0, { $subtract: [{ $ifNull: ["$$item.quantity", 0] }, { $ifNull: ["$$item.returnedQuantity", 0] }] }] }, "$$item.quantity"] },
                          0,
                        ],
                      },
                    ],
                  },
                },
              },
            },
            0,
          ],
        },
      },
    },
    {
      $group: {
        _id: "$month",
        profit: {
          $sum: {
            $subtract: [{ $subtract: ["$itemsProfit", { $multiply: ["$discountAmount", "$remainingRatio"] }] }, "$vatInside"],
          },
        },
      },
    },
    { $sort: { _id: 1 } },
  ];

  const [cashRows, creditRows] = await Promise.all([
    Selling.aggregate(basePipeline),
    CreditSale.aggregate(basePipeline),
  ]);

  const monthLabels = [
    { label: "Jan", labelAr: "يناير" },
    { label: "Feb", labelAr: "فبراير" },
    { label: "Mar", labelAr: "مارس" },
    { label: "Apr", labelAr: "أبريل" },
    { label: "May", labelAr: "مايو" },
    { label: "Jun", labelAr: "يونيو" },
    { label: "Jul", labelAr: "يوليو" },
    { label: "Aug", labelAr: "أغسطس" },
    { label: "Sep", labelAr: "سبتمبر" },
    { label: "Oct", labelAr: "أكتوبر" },
    { label: "Nov", labelAr: "نوفمبر" },
    { label: "Dec", labelAr: "ديسمبر" },
  ];

  const profitByMonth = Array.from({ length: 12 }, () => ({
    profit: 0,
    cashProfit: 0,
    creditProfit: 0,
  }));

  for (const row of cashRows) {
    const monthIndex = Number(row._id || 0) - 1;
    if (monthIndex < 0 || monthIndex >= 12) continue;
    const profit = roundMoney(Number(row.profit || 0));
    profitByMonth[monthIndex].cashProfit = roundMoney(
      profitByMonth[monthIndex].cashProfit + profit
    );
    profitByMonth[monthIndex].profit = roundMoney(profitByMonth[monthIndex].profit + profit);
  }

  for (const row of creditRows) {
    const monthIndex = Number(row._id || 0) - 1;
    if (monthIndex < 0 || monthIndex >= 12) continue;
    const profit = roundMoney(Number(row.profit || 0));
    profitByMonth[monthIndex].creditProfit = roundMoney(
      profitByMonth[monthIndex].creditProfit + profit
    );
    profitByMonth[monthIndex].profit = roundMoney(profitByMonth[monthIndex].profit + profit);
  }

  const months = monthLabels.map((labels, index) => ({
    month: index + 1,
    label: labels.label,
    labelAr: labels.labelAr,
    profit: profitByMonth[index].profit,
    cashProfit: profitByMonth[index].cashProfit,
    creditProfit: profitByMonth[index].creditProfit,
  }));

  res.json({
    year,
    startDate,
    endDate,
    totalProfit: roundMoney(months.reduce((sum, month) => sum + Number(month.profit || 0), 0)),
    months,
  });
});

module.exports = {
  getProducts,
  searchProducts,
  getProductById,
  exportProductsExcel,
  getProductsProfitReport,
  getProductProfitReportById,
  syncProductPurchasePriceToInvoices,
  getYearProfitBarChart,
  createProduct,
  updateProduct,
  deleteProduct,
  restoreProduct,
};
