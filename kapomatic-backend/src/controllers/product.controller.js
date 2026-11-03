const mongoose = require("mongoose");
const ExcelJS = require("exceljs");
const Category = require("../models/category.model");
const CreditSale = require("../models/creditSale.model");
const Product = require("../models/product.model");
const Selling = require("../models/selling.model");
const asyncHandler = require("../utils/asyncHandler");
const { buildInvoiceTotals, roundMoney } = require("../utils/invoicePricing");
const { calculatePriceAfterDiscount } = require("../utils/productPricing");
const {
  addSlugAliasesForChangedSlugs,
  checkDuplicateSlug,
  clearPublicSeoCache,
  normalizeSeoInput,
} = require("../utils/seo");

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
    return;
  }

  row.invoices.push({
    invoiceId,
    type: invoiceType,
    sellingDate,
    sellingPrice: roundMoney(sellingPrice || 0),
    quantity: Number(quantity || 0),
    revenue: roundMoney(revenue || 0),
    purchasePrice: roundMoney(purchasePrice || 0),
    profit: roundMoney(profit || 0),
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
      $or: [{ "items.product": { $in: productIds } }, { product: { $in: productIds } }],
    }).lean(),
    CreditSale.find({
      ...dateQuery,
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

      const quantity = Number(item.quantity || 0);
      const sellingPrice = roundMoney(Number(item.unitPrice || 0));
      const totalPrice = roundMoney(Number(item.totalPrice || 0));
      const purchasePrice = roundMoney(Number(item.purchasePrice ?? 0));
      const revenue = roundMoney(totalPrice - Number(itemDiscounts[index] || 0));
      const profit =
        item.profitAmount !== undefined && item.profitAmount !== null
          ? roundMoney(Number(item.profitAmount || 0) - Number(itemDiscounts[index] || 0))
          : roundMoney(revenue - purchasePrice * quantity);

      addInvoiceToProductProfitReport({
        row,
        invoiceId: selling.invoiceId ?? selling._id,
        invoiceType: "cash",
        sellingDate: selling.sellingDate,
        quantity,
        sellingPrice,
        revenue,
        purchasePrice,
        profit,
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

      const quantity = Number(item.quantity || 0);
      const sellingPrice = roundMoney(Number(item.unitPrice || 0));
      const totalPrice = roundMoney(Number(item.totalPrice || 0));
      const purchasePrice = roundMoney(Number(item.purchasePrice ?? 0));
      const revenue = roundMoney(totalPrice - Number(itemDiscounts[index] || 0));
      const profit =
        item.profitAmount !== undefined && item.profitAmount !== null
          ? roundMoney(Number(item.profitAmount || 0) - Number(itemDiscounts[index] || 0))
          : roundMoney(revenue - purchasePrice * quantity);

      addInvoiceToProductProfitReport({
        row,
        invoiceId: creditSale._id,
        invoiceType: "credit",
        sellingDate: creditSale.sellingDate,
        quantity,
        sellingPrice,
        revenue,
        purchasePrice,
        profit,
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

  // Invalid page/limit values intentionally use defaults instead of returning
  // an error, as required by the public API contract.
  const limit = parsePaginationInteger(req.query.limit, DEFAULT_LIMIT, MAX_LIMIT);
  // Cap the page at a technical maximum that guarantees a safe skip value.
  const page = parsePaginationInteger(req.query.page, DEFAULT_PAGE, MAX_PAGE);
  const skip = (page - 1) * limit;

  if (!categoryId) {
    res.status(400);
    throw new Error("مطلوب معامل الاستعلام categoryId");
  }

  const category = await Category.findById(categoryId);
  if (!category) {
    res.status(404);
    throw new Error("لم يتم العثور على فئة للمعرّف المقدم");
  }

  const filter = { category: categoryId };

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

  const products = await Product.find({ $or: searchFilters })
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

const createProduct = asyncHandler(async (req, res) => {
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

  const category = await Category.findById(categoryId);
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

  Object.assign(
    payload,
    normalizeSeoInput({
      body: req.body,
      legacyName: name,
      entityType: "product",
      res,
    })
  );
  await checkDuplicateSlug({
    Model: Product,
    entityType: "product",
    translations: payload.translations,
    res,
  });

  const product = await Product.create(payload);
  await product.populate("category", CATEGORY_PRODUCT_FIELDS);
  clearPublicSeoCache();

  res.status(201).json(product);
});

const updateProduct = asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id);
  let selectedCategory;

  if (!product) {
    res.status(404);
    throw new Error("المنتج غير موجود");
  }

  if (req.body.categoryId !== undefined) {
    selectedCategory = await Category.findById(req.body.categoryId);
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
  const seoUpdate = normalizeSeoInput({
    body: req.body,
    legacyName: product.translations?.ar?.name
      ? undefined
      : req.body.name !== undefined
        ? req.body.name
        : product.name,
    entityType: "product",
    existing: product,
    res,
  });
  await checkDuplicateSlug({
    Model: Product,
    entityType: "product",
    translations: seoUpdate.translations,
    excludeId: product._id,
    res,
  });
  if (seoUpdate.translations) {
    addSlugAliasesForChangedSlugs(product, seoUpdate.translations);
    product.translations = seoUpdate.translations;
  }
  if (seoUpdate.seo) product.seo = seoUpdate.seo;

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
  if (req.body.wholesalePrice !== undefined) product.wholesalePrice = req.body.wholesalePrice;
  if (req.body.purchasePrice !== undefined) product.purchasePrice = req.body.purchasePrice;
  if (req.body.retailPrice !== undefined) product.retailPrice = req.body.retailPrice;
  const discountPercentageInput =
    req.body.discountPercentage ?? req.body.discount_percentage;
  if (discountPercentageInput !== undefined) {
    product.discountPercentage = normalizeDiscountPercentage(discountPercentageInput, res);
  }
  if (requestSpecifications !== undefined) {
    product.specifications = cloneSpecifications(requestSpecifications);
  } else if (selectedCategory) {
    product.specifications = cloneSpecifications(selectedCategory.specifications);
  }

  const updatedProduct = await product.save();
  await updatedProduct.populate("category", CATEGORY_PRODUCT_FIELDS);
  clearPublicSeoCache();

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

const syncProductPurchasePriceToInvoices = asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id).populate("category", "name");

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
    }),
    CreditSale.find({
      ...dateQuery,
      "items.product": product._id,
    }),
  ]);

  let updatedCashInvoices = 0;
  let updatedCreditInvoices = 0;
  let updatedItemsCount = 0;

  for (const selling of sellings) {
    let didUpdateInvoice = false;

    if (Array.isArray(selling.items) && selling.items.length > 0) {
      for (const item of selling.items) {
        if (String(getSellingItemProductId(item)) !== String(product._id)) continue;

        const quantity = Number(item.quantity || 0);
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
      await selling.save();
      updatedCashInvoices += 1;
    }
  }

  for (const creditSale of creditSales) {
    let didUpdateInvoice = false;

    for (const item of creditSale.items) {
      if (String(getCreditSaleItemProductId(item)) !== String(product._id)) continue;

      const quantity = Number(item.quantity || 0);
      item.purchasePrice = purchasePrice;
      item.profitAmount = roundMoney(Number(item.totalPrice || 0) - purchasePrice * quantity);
      updatedItemsCount += 1;
      didUpdateInvoice = true;
    }

    if (didUpdateInvoice) {
      await creditSale.save();
      updatedCreditInvoices += 1;
    }
  }

  res.json({
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
  });
});

const deleteProduct = asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id);

  if (!product) {
    res.status(404);
    throw new Error("المنتج غير موجود");
  }

  await product.deleteOne();
  clearPublicSeoCache();
  res.json({ message: "Product deleted successfully" });
});

const getYearProfitBarChart = asyncHandler(async (req, res) => {
  const year = normalizeYear(req.query.year, res);
  const startDate = new Date(Date.UTC(year, 0, 1, 0, 0, 0, 0));
  const endDate = new Date(Date.UTC(year + 1, 0, 1, 0, 0, 0, 0));

  const basePipeline = [
    {
      $match: {
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
              in: { $ifNull: ["$$item.profitAmount", 0] },
            },
          },
        },
      },
    },
    {
      $group: {
        _id: "$month",
        profit: {
          $sum: {
            $subtract: ["$itemsProfit", "$discountAmount"],
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
};
