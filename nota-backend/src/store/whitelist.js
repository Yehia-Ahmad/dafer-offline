// Online Stage 3: the ONLY place that builds public (customer website) JSON. Every function copies named fields into a
// new object; nothing here ever returns a model, or a model "minus some fields". A field that is not written below can
// never reach a customer.
const { storeSlug } = require("../utils/storeSlug");

const money = (value) => Number(Number(value || 0).toFixed(2));
const text = (value) => (typeof value === "string" && value ? value : undefined);
const idOf = (value) => String(value && value._id ? value._id : value);
const version = (date) => (date ? new Date(date).getTime() : 0);

const productImageUrl = (productId, index, updatedAt) => `/api/store/images/product/${productId}/${index}?v=${version(updatedAt)}`;
const categoryImageUrl = (categoryId, updatedAt) => `/api/store/images/category/${categoryId}?v=${version(updatedAt)}`;
const bannerImageUrl = (bannerId, updatedAt) => `/api/store/images/banner/${bannerId}?v=${version(updatedAt)}`;
const logoUrl = (updatedAt) => `/api/store/images/logo?v=${version(updatedAt)}`;

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
const publicProduct = (product, categoryName, vat) => {
  const out = {
    id: idOf(product._id),
    name: product.name,
    slug: storeSlug(product.name),
    category: { id: idOf(product.category), name: categoryName },
    price: money(product.retailPrice),
    discountPercentage: Number(product.discountPercentage || 0),
    finalPrice: money(product.finalPrice),
    description: product.description || "",
    images: Array.from({ length: product.imageCount || 0 }, (_, index) => productImageUrl(idOf(product._id), index, product.updatedAt)),
    availability: availabilityOf(product),
    maxOrderQty: maxOrderQtyOf(product),
  };
  if (vat) out.vat = { rate: product.vatExempt ? 0 : vat.rate, included: vat.included, exempt: Boolean(product.vatExempt) };
  return out;
};

const publicCategory = (category, productCount) => ({
  id: idOf(category._id),
  name: category.name,
  imageUrl: category.hasImage ? categoryImageUrl(idOf(category._id), category.updatedAt) : null,
  productCount,
});

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

/**
 * @param settings   the WebsiteSettings (lean) or null
 * @param extras     { shop, featuredCategories: [ids still visible], bannerLinks: Set of "type:id" still visible, vat }
 */
const publicSettings = (settings, extras) => {
  const shop = publicShop(extras.shop);
  if (!settings || !settings.enabled) {
    return { enabled: false, closedMessage: (settings && settings.closedMessage) || "", shop };
  }
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
    paymentMethods: ["cod"],
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
  subtotal: money(order.subtotal),
  vat: money(order.vat),
  deliveryFee: money(order.deliveryFee),
  total: money(order.total),
  createdAt: order.createdAt,
  trackingToken,
});

/** A signed-in customer's own order. */
const publicOwnOrder = (order) => ({
  id: idOf(order._id),
  number: order.number,
  status: publicStatus(order.status),
  paymentMethod: order.paymentMethod,
  items: (order.items || []).map(publicOrderItem),
  subtotal: money(order.subtotal),
  vat: money(order.vat),
  deliveryFee: money(order.deliveryFee),
  total: money(order.total),
  zone: publicZoneSnapshot(order.zone || {}),
  contact: {
    name: order.contact.name,
    phone: order.contact.phone,
    address: order.contact.address,
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
  items: (order.items || []).map(publicOrderItem),
  subtotal: money(order.subtotal),
  vat: money(order.vat),
  deliveryFee: money(order.deliveryFee),
  total: money(order.total),
  zone: publicZoneSnapshot(order.zone || {}),
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
  publicSettings,
  publicShop,
  publicTracking,
  publicZone,
};
