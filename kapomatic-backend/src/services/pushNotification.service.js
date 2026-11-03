const fs = require("fs");
const path = require("path");
const DeviceToken = require("../models/deviceToken.model");
const { roundMoney } = require("../utils/invoicePricing");

const FIREBASE_APP_NAME = "kapomatic-push";
const ORDER_NOTIFICATION_CHANNEL_ID = "website_orders";
const WEBSITE_ORDERS_ROUTE = "/website-orders";
const MULTICAST_TOKEN_LIMIT = 500;
const STALE_TOKEN_ERROR_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
]);

// undefined = not initialized yet, null = push disabled (missing/invalid config).
let messagingClient;

// Accepts Windows (C:\keys\sa.json, C:/keys/sa.json), POSIX, and relative paths,
// optionally wrapped in quotes.
const resolveServiceAccountPath = (value) => {
  if (typeof value !== "string") return null;

  const unquoted = value.trim().replace(/^(["'])(.*)\1$/, "$2").trim();
  if (!unquoted) return null;

  return path.resolve(unquoted);
};

const disablePush = (message) => {
  console.warn(`[push] ${message} Push notifications are disabled.`);
  messagingClient = null;
  return null;
};

const getMessagingClient = () => {
  if (messagingClient !== undefined) return messagingClient;

  const serviceAccountPath = resolveServiceAccountPath(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (!serviceAccountPath) {
    return disablePush("FIREBASE_SERVICE_ACCOUNT is not set.");
  }

  if (/[\r\n\t]/.test(serviceAccountPath)) {
    return disablePush(
      "FIREBASE_SERVICE_ACCOUNT contains a control character. In .env, write Windows paths unquoted, in single quotes, or with forward slashes."
    );
  }

  try {
    const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, "utf8"));
    const { cert, getApps, initializeApp } = require("firebase-admin/app");
    const { getMessaging } = require("firebase-admin/messaging");
    const firebaseApp =
      getApps().find((app) => app.name === FIREBASE_APP_NAME) ||
      initializeApp({ credential: cert(serviceAccount) }, FIREBASE_APP_NAME);

    messagingClient = getMessaging(firebaseApp);
    console.log(`[push] Firebase messaging initialized for project ${serviceAccount.project_id}.`);
    return messagingClient;
  } catch (error) {
    return disablePush(
      `Could not load the Firebase service account from ${serviceAccountPath}: ${error.message}.`
    );
  }
};

const formatAmount = (value) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);

// Only order id, total, and item count: never customer personal data.
const buildNewWebsiteOrderMessage = (order) => {
  const orderId = String(order._id);
  const totalPrice = roundMoney(order.totalPrice);
  const itemCount = Array.isArray(order.items) ? order.items.length : 0;

  return {
    notification: {
      title: "طلب جديد من الموقع",
      body: `الإجمالي: ${formatAmount(totalPrice)} ج.م • عدد المنتجات: ${itemCount}`,
    },
    data: {
      type: "website_order",
      orderId,
      totalPrice: String(totalPrice),
      itemCount: String(itemCount),
      route: WEBSITE_ORDERS_ROUTE,
    },
    android: {
      priority: "high",
      notification: {
        channelId: ORDER_NOTIFICATION_CHANNEL_ID,
      },
    },
  };
};

// Fire-and-forget: never throws or rejects, only logs.
const notifyNewWebsiteOrder = async (order) => {
  try {
    const messaging = getMessagingClient();
    if (!messaging) return { skipped: true };

    const deviceTokens = await DeviceToken.find({}).select("token").lean();
    const tokens = [...new Set(deviceTokens.map((deviceToken) => deviceToken.token).filter(Boolean))];
    if (tokens.length === 0) return { sent: 0, failed: 0, removed: 0 };

    const message = buildNewWebsiteOrderMessage(order);
    const staleTokens = [];
    const otherErrorCodes = new Set();
    let sent = 0;
    let failed = 0;

    for (let start = 0; start < tokens.length; start += MULTICAST_TOKEN_LIMIT) {
      const batch = tokens.slice(start, start + MULTICAST_TOKEN_LIMIT);

      try {
        const response = await messaging.sendEachForMulticast({ ...message, tokens: batch });
        sent += response.successCount;
        failed += response.failureCount;

        response.responses.forEach((result, index) => {
          if (result.success) return;

          const code = result.error?.code;
          if (STALE_TOKEN_ERROR_CODES.has(code)) staleTokens.push(batch[index]);
          else otherErrorCodes.add(code || "unknown");
        });
      } catch (error) {
        failed += batch.length;
        console.error(`[push] Failed to send order ${order._id} notification batch:`, error.message);
      }
    }

    if (otherErrorCodes.size > 0) {
      console.error(
        `[push] Some order ${order._id} notifications failed: ${[...otherErrorCodes].join(", ")}`
      );
    }

    if (staleTokens.length > 0) {
      await DeviceToken.deleteMany({ token: { $in: staleTokens } });
    }

    return { sent, failed, removed: staleTokens.length };
  } catch (error) {
    console.error(`[push] Failed to notify about website order ${order?._id}:`, error.message);
    return { error };
  }
};

const resetPushNotificationsForTests = () => {
  messagingClient = undefined;
};

module.exports = {
  ORDER_NOTIFICATION_CHANNEL_ID,
  buildNewWebsiteOrderMessage,
  notifyNewWebsiteOrder,
  resetPushNotificationsForTests,
  resolveServiceAccountPath,
};
