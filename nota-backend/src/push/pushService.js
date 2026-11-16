const PushSubscription = require("../models/pushSubscription.model");
const User = require("../models/user.model");
const { hasPermission } = require("../auth/permissions");

// Online Stage 6A: Web Push for new website orders.
//
// VAPID keys come from the environment (NOTA_VAPID_PUBLIC_KEY / NOTA_VAPID_PRIVATE_KEY / NOTA_VAPID_SUBJECT), generated on the
// server by the deploy scripts and never committed. Without them push is simply off. The payload carries no personal data.

const TTL_SECONDS = 60 * 60;

const vapid = () => {
  const publicKey = String(process.env.NOTA_VAPID_PUBLIC_KEY || "").trim();
  const privateKey = String(process.env.NOTA_VAPID_PRIVATE_KEY || "").trim();
  const subject = String(process.env.NOTA_VAPID_SUBJECT || "").trim();
  return publicKey && privateKey && subject ? { publicKey, privateKey, subject } : null;
};

const publicKey = () => (vapid() ? vapid().publicKey : null);

/** The real sender (web-push is loaded only when needed). Tests replace it with setSender(). */
const realSender = async (subscription, payload) => {
  const keys = vapid();
  if (!keys) throw new Error("push is not configured");
  const webPush = require("web-push");
  return webPush.sendNotification(
    { endpoint: subscription.endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth } },
    payload,
    { vapidDetails: { subject: keys.subject, publicKey: keys.publicKey, privateKey: keys.privateKey }, TTL: TTL_SECONDS }
  );
};

let sender = realSender;
const setSender = (fn) => { sender = fn || realSender; };

const money = (value) => {
  const rounded = Math.round(Number(value || 0) * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
};

/**
 * What the phone shows. Only the order number, the total and delivery/pickup: no name, phone or address.
 * Shaped as the Angular service worker's notification envelope, so a tap opens/focuses the order page.
 */
const buildOrderPayload = (order) => {
  const url = `/admin/orders/${order._id}`;
  return JSON.stringify({
    notification: {
      title: `طلب جديد #${order.number}`,
      body: `${money(order.total)} ج.م · ${order.fulfillment === "pickup" ? "استلام من المحل" : "توصيل"}`,
      icon: "/admin/icons/icon-192.png",
      badge: "/admin/icons/icon-192.png",
      tag: `order-${order._id}`,
      data: { url, onActionClick: { default: { operation: "navigateLastFocusedOrOpen", url } } },
    },
  });
};

/** Subscriptions whose user is active and (right now) has orders.view. */
const eligibleSubscriptions = async () => {
  const subscriptions = await PushSubscription.find({}).lean();
  if (!subscriptions.length) return [];
  const users = await User.find({ _id: { $in: [...new Set(subscriptions.map((row) => String(row.user)))] }, isActive: true });
  const allowed = new Set(users.filter((user) => hasPermission(user, "orders.view")).map((user) => String(user._id)));
  return subscriptions.filter((row) => allowed.has(String(row.user)));
};

/** Sends the new-order push. Never throws; callers do not await it. */
const notifyNewOrder = async (order) => {
  try {
    if (!vapid() && sender === realSender) return;
    const payload = buildOrderPayload(order);
    const targets = await eligibleSubscriptions();
    await Promise.all(targets.map(async (subscription) => {
      try {
        await sender(subscription, payload);
        await PushSubscription.updateOne({ _id: subscription._id }, { $set: { lastSuccessAt: new Date() } });
      } catch (error) {
        const status = error && (error.statusCode || error.status);
        if (status === 404 || status === 410) await PushSubscription.deleteOne({ _id: subscription._id }).catch(() => {});
        else console.error("push send failed:", status || error.message);
      }
    }));
  } catch (error) {
    console.error("push notify failed:", error.message);
  }
};

module.exports = { publicKey, notifyNewOrder, buildOrderPayload, setSender };
