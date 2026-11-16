// Online Stage 3: the ONLY place that builds public (customer website) JSON. Every function copies named fields into a
// new object; nothing here ever returns a model, or a model "minus some fields". A field that is not written below can
// never reach a customer.
const { storeSlug } = require("../utils/storeSlug");
const { effectiveSettings } = require("./catalog");
const { DEFAULT_BRAND_COLOR } = require("../models/websiteSettings.model");

const money = (value) => Number(Number(value || 0).toFixed(2));
const text = (value) => (typeof value === "string" && value ? value : undefined);
const idOf = (value) => String(value && value._id ? value._id : value);
const version = (date) => (date ? new Date(date).getTime() : 0);

const productImageUrl = (productId, index, updatedAt) => `/api/store/images/product/${productId}/${index}?v=${version(updatedAt)}`;
const categoryImageUrl = (categoryId, updatedAt) => `/api/store/images/category/${categoryId}?v=${version(updatedAt)}`;
const bannerImageUrl = (bannerId, updatedAt) => `/api/store/images/banner/${bannerId}?v=${version(updatedAt)}`;
const logoUrl = (updatedAt) => `/api/store/images/logo?v=${version(updatedAt)}`;
const websiteLogoUrl = (updatedAt) => `/api/store/images/website-logo?v=${version(updatedAt)}`;

const DEFAULT_LOW_STOCK = 5;
/** in_stock / low / out_of_stock. The number itself is never shown. */
const availabilityOf = (product) => {
  const count = Number(product.inventoryCount || 0);
  if (count <= 0) return "out_of_stock";
  const threshold = Number.isFinite(Number(product.lowStockThreshold)) && product.lowStockThreshold !== null && product.lowStockThreshold !== undefined
    ? Number(product.lowStockThreshold)
    : DEFAULT_LOW_STOCK;
  return count <= threshold ? "low" : "in_stock";
};
const maxOrderQtyOf = (product) => Math.max(0, Math.min(Number(product.inventoryCount || 0), 99));

/**
 * @param product  a lean product with: name, retailPrice, discountPercentage, finalPrice, inventoryCount, lowStockThreshold, vatExempt,
 *                 description, imageCount (main image counts as index 0 when present), updatedAt
 * @param categoryName the already-loaded name of its (visible) category
 * @param vat      { rate, included } when the shop's VAT applies, else null
 */
const NEW_BADGE_DAYS = 14;
const DEFAULT_REMAINING_THRESHOLD = 5;

/** Online Stage 5A: the product's specifications as [{ label, value }] strings. Anything that is not a pair of non-empty strings is dropped. */
const publicSpecifications = (specifications) =>
  (Array.isArray(specifications) ? specifications : [])
    .filter((row) => row && typeof row === "object" && typeof row.label === "string" && typeof row.value === "string" && row.label.trim() && row.value.trim())
    .map((row) => ({ label: row.label.trim(), value: row.value.trim() }));

/** discount / new / out_of_stock. `now` is injectable for tests. */
const badgesOf = (product, now = Date.now()) => {
  const badges = [];
  if (Number(product.discountPercentage || 0) > 0) badges.push("discount");
  if (product.createdAt && now - new Date(product.createdAt).getTime() <= NEW_BADGE_DAYS * 24 * 60 * 60 * 1000) badges.push("new");
  if (Number(product.inventoryCount || 0) <= 0) badges.push("out_of_stock");
  return badges;
};

/**
 * `remaining`: the number of pieces left, only when the shop allows it and the AVAILABLE stock (inventory minus reserved, which is what
 * `inventoryCount` already is on a public read) is between 1 and the threshold.
 */
const remainingOf = (product, stockRules) => {
  const rule = (stockRules && stockRules.showRemaining) || { enabled: true, threshold: DEFAULT_REMAINING_THRESHOLD };
  if (!rule.enabled) return undefined;
  const count = Number(product.inventoryCount || 0);
  return count >= 1 && count <= rule.threshold ? count : undefined;
};

const publicProduct = (product, categoryName, vat, stockRules) => {
  const out = {
    id: idOf(product._id),
    name: product.name,
    code: text(product.code) || "",
    slug: storeSlug(product.name),
    category: { id: idOf(product.category), name: categoryName },
    price: money(product.retailPrice),
    discountPercentage: Number(product.discountPercentage || 0),
    finalPrice: money(product.finalPrice),
    description: product.description || "",
    images: Array.from({ length: product.imageCount || 0 }, (_, index) => productImageUrl(idOf(product._id), index, product.updatedAt)),
    availability: availabilityOf(product),
    maxOrderQty: maxOrderQtyOf(product),
    specifications: publicSpecifications(product.specifications),
    badges: badgesOf(product),
  };
  const remaining = remainingOf(product, stockRules);
  if (remaining !== undefined) out.remaining = remaining;
  if (vat) out.vat = { rate: product.vatExempt ? 0 : vat.rate, included: vat.included, exempt: Boolean(product.vatExempt) };
  return out;
};

const publicCategory = (category, productCount) => {
  const image = category.hasImage ? categoryImageUrl(idOf(category._id), category.updatedAt) : null;
  // `image` (Stage 5A) is the same URL as `imageUrl` (Stage 3); null means the storefront shows a generic icon.
  return { id: idOf(category._id), name: category.name, imageUrl: image, image, productCount };
};

const publicZone = (zone) => ({
  id: idOf(zone._id),
  name: zone.name,
  fee: money(zone.fee),
  estimatedTime: zone.estimatedTime || "",
});

/** The shop block shown with the settings (name, logo URL, phones, address). */
const publicShop = (profile) => ({
  name: (profile && profile.name) || "",
  logoUrl: profile && profile.logo ? logoUrl(profile.updatedAt) : null,
  phones: profile && Array.isArray(profile.phones) ? profile.phones.map(String) : [],
  address: (profile && profile.address) || "",
});

const PAYMENT_LABELS = { cod: "الدفع عند الاستلام", instapay: "إنستا باي", vodafone_cash: "فودافون كاش" };

/** Up to 3 shop-written highlights; with none, three built from the settings: delivery / pickup, payment methods, returns. */
const publicHighlights = (settings, rules, enabledMethods) => {
  const own = (settings.highlights || []).filter((row) => row && row.icon && text(row.title)).slice(0, 3).map((row) => ({ icon: row.icon, title: row.title, text: row.text || "" }));
  if (own.length) return own;
  const freeFrom = settings.freeDeliveryFrom;
  const deliveryText = rules.fulfillment.delivery
    ? (freeFrom !== undefined && freeFrom !== null ? `توصيل مجاني للطلبات من ${money(freeFrom)} جنيه` : "بنوصّل لحد باب البيت")
    : "استلم طلبك من المحل";
  const returnsText = text(settings.returnsPolicy) ? settings.returnsPolicy.trim().slice(0, 100) : "لو في أي مشكلة في الطلب كلمنا";
  return [
    { icon: "delivery", title: rules.fulfillment.delivery ? "توصيل سريع" : "استلام من المحل", text: deliveryText },
    { icon: "cash", title: "دفع سهل", text: enabledMethods.map((method) => PAYMENT_LABELS[method]).join(" • ") },
    { icon: "exchange", title: "استبدال واسترجاع", text: returnsText },
  ];
};

/**
 * @param settings   the WebsiteSettings (lean) or null
 * @param extras     { shop, featuredCategories: [ids still visible], bannerLinks: Set of "type:id" still visible, vat, rules? }
 *                   rules = effectiveSettings(settings) (computed here when not given)
 */
const publicSettings = (settings, extras) => {
  const shop = publicShop(extras.shop);
  if (!settings || !settings.enabled) {
    return { enabled: false, closedMessage: (settings && settings.closedMessage) || "", shop };
  }
  const rules = extras.rules || effectiveSettings(settings);
  const enabledMethods = ["cod", "instapay", "vodafone_cash"].filter((method) => rules.payments[method].enabled);
  const banners = (settings.banners || [])
    .slice()
    .sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0))
    .map((banner) => {
      const key = `${banner.linkType}:${banner.linkId}`;
      const linked = banner.linkType && banner.linkType !== "none" && banner.linkId && extras.bannerLinks.has(key);
      return {
        id: idOf(banner._id),
        imageUrl: bannerImageUrl(idOf(banner._id), settings.updatedAt),
        link: linked ? { type: banner.linkType, id: idOf(banner.linkId) } : null,
      };
    });
  const out = {
    enabled: true,
    orderingEnabled: settings.orderingEnabled !== false,
    closedMessage: settings.closedMessage || "",
    title: settings.title || "",
    about: settings.about || "",
    banners,
    featuredCategoryIds: extras.featuredCategories.map(idOf),
    contact: {
      whatsapp: text(settings.whatsapp) || "",
      facebook: text(settings.facebook) || "",
      instagram: text(settings.instagram) || "",
      tiktok: text(settings.tiktok) || "",
    },
    minOrderAmount: settings.minOrderAmount === undefined || settings.minOrderAmount === null ? null : money(settings.minOrderAmount),
    freeDeliveryFrom: settings.freeDeliveryFrom === undefined || settings.freeDeliveryFrom === null ? null : money(settings.freeDeliveryFrom),
    orderNote: settings.orderNote || "",
    returnsPolicy: settings.returnsPolicy || "",
    terms: settings.terms || "",
    // Online Stage 5A. Never a box id. paymentMethods stays an array of method keys; the public transfer details are separate.
    paymentMethods: enabledMethods,
    paymentDetails: {
      ...(rules.payments.instapay.enabled ? { instapay: { address: rules.payments.instapay.address } } : {}),
      ...(rules.payments.vodafone_cash.enabled ? { vodafoneCash: { number: rules.payments.vodafone_cash.number } } : {}),
    },
    fulfillment: { delivery: rules.fulfillment.delivery, pickup: rules.fulfillment.pickup },
    brandColor: text(settings.brandColor) || DEFAULT_BRAND_COLOR,
    logoUrl: settings.websiteLogo ? websiteLogoUrl(settings.updatedAt) : shop.logoUrl,
    announcement: settings.announcement && settings.announcement.enabled && text(settings.announcement.text) ? { text: settings.announcement.text } : null,
    seoDescription: settings.seoDescription || "",
    openingHours: settings.openingHours || "",
    // Information only (the shop's cut-off for same-day delivery).
    sameDayCutoff: text(settings.sameDayCutoff) || null,
    highlights: publicHighlights(settings, rules, enabledMethods),
    vat: extras.vat ? { rate: extras.vat.rate, pricesIncludeVat: extras.vat.included } : null,
    shop,
  };
  return out;
};

const publicOrderItem = (item) => ({
  productId: idOf(item.productId),
  name: item.name,
  unitPrice: money(item.unitPrice),
  discountPercentage: Number(item.discountPercentage || 0),
  qty: item.qty,
  lineTotal: money(item.lineTotal),
  vat: money(item.vat),
});

const publicZoneSnapshot = (zone) => ({ name: zone.name, fee: money(zone.fee) });

// Online Stage 5A: how the order is fulfilled / paid. An order placed before this stage is a delivery order paid on delivery.
const fulfillmentOf = (order) => (order.fulfillment === "pickup" ? "pickup" : "delivery");
/** Wallet orders show whether the shop verified the transfer; cash on delivery / pickup has no transfer (null). */
const paymentStatusOf = (order) => (order.paymentMethod === "instapay" || order.paymentMethod === "vodafone_cash" ? (order.payment && order.payment.status === "verified" ? "verified" : "unpaid") : null);
const publicFulfillment = (order) => ({ fulfillment: fulfillmentOf(order), paymentStatus: paymentStatusOf(order) });
const publicOrderZone = (order) => (fulfillmentOf(order) === "pickup" ? null : publicZoneSnapshot(order.zone || {}));

/** Online Stage 4: a refused order shows like a cancelled one to the customer. */
const publicStatus = (status) => (status === "refused" ? "cancelled" : status);
/** The customer sees status changes only: staff edits, notes and names stay in the admin history. */
const publicHistory = (history) => (history || []).filter((row) => !row.type || row.type === "status").map((row) => ({ status: publicStatus(row.status), at: row.at }));

/** The placement response (also the idempotent replay). `trackingToken` is only here, never in the other order views. */
const publicPlacedOrder = (order, trackingToken) => ({
  id: idOf(order._id),
  number: order.number,
  status: publicStatus(order.status),
  paymentMethod: order.paymentMethod,
  ...publicFulfillment(order),
  subtotal: money(order.subtotal),
  vat: money(order.vat),
  deliveryFee: money(order.deliveryFee),
  total: money(order.total),
  createdAt: order.createdAt,
  trackingToken,
});

/** Online Stage 5B: the priced preview of an order (POST /orders/quote). Nothing is stored; no number, no id, no token. */
const publicQuote = ({ priced, fulfillment, paymentMethod, zone }) => ({
  fulfillment,
  paymentMethod,
  items: priced.items.map(publicOrderItem),
  subtotal: money(priced.subtotal),
  vat: money(priced.vat),
  deliveryFee: money(priced.deliveryFee),
  total: money(priced.total),
  zone: zone ? publicZoneSnapshot(zone) : null,
});

/** A signed-in customer's own order. */
const publicOwnOrder = (order) => ({
  id: idOf(order._id),
  number: order.number,
  status: publicStatus(order.status),
  paymentMethod: order.paymentMethod,
  ...publicFulfillment(order),
  items: (order.items || []).map(publicOrderItem),
  subtotal: money(order.subtotal),
  vat: money(order.vat),
  deliveryFee: money(order.deliveryFee),
  total: money(order.total),
  zone: publicOrderZone(order),
  contact: {
    name: order.contact.name,
    phone: order.contact.phone,
    address: order.contact.address || "",
    notes: order.contact.notes || "",
  },
  statusHistory: publicHistory(order.statusHistory),
  createdAt: order.createdAt,
});

/** A guest's tracking view: status, items, totals, zone. No contact data. */
const publicTracking = (order) => ({
  number: order.number,
  status: publicStatus(order.status),
  paymentMethod: order.paymentMethod,
  ...publicFulfillment(order),
  items: (order.items || []).map(publicOrderItem),
  subtotal: money(order.subtotal),
  vat: money(order.vat),
  deliveryFee: money(order.deliveryFee),
  total: money(order.total),
  zone: publicOrderZone(order),
  createdAt: order.createdAt,
});

const publicAddress = (address) => ({
  id: idOf(address._id),
  label: address.label || "",
  zoneId: address.zone ? idOf(address.zone) : null,
  address: address.address,
  notes: address.notes || "",
});

const publicCustomer = (customer) => ({
  id: idOf(customer._id),
  name: customer.name,
  phone: customer.phone,
  addresses: (customer.addresses || []).map(publicAddress),
  createdAt: customer.createdAt,
});

module.exports = {
  DEFAULT_LOW_STOCK,
  availabilityOf,
  maxOrderQtyOf,
  publicAddress,
  publicCategory,
  publicCustomer,
  publicOwnOrder,
  publicPlacedOrder,
  publicProduct,
  publicQuote,
  publicSettings,
  publicShop,
  publicTracking,
  publicZone,
};
