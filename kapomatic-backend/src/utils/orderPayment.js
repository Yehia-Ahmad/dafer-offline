const isBase64Image = require("./isBase64Image");

const PAYMENT_METHODS = Object.freeze({
  CASH: "CASH",
  E_WALLET: "E_WALLET",
  INSTAPAY: "INSTAPAY",
});

const PAYMENT_STATUSES = Object.freeze({
  PENDING: "PENDING",
  PAID: "PAID",
  REJECTED: "REJECTED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
});

const PAYMENT_METHOD_VALUES = Object.freeze(Object.values(PAYMENT_METHODS));
const PAYMENT_STATUS_VALUES = Object.freeze(Object.values(PAYMENT_STATUSES));

const PAYMENT_METHOD_ALIASES = Object.freeze({
  CASH: PAYMENT_METHODS.CASH,
  COD: PAYMENT_METHODS.CASH,
  CASH_ON_DELIVERY: PAYMENT_METHODS.CASH,
  WALLET: PAYMENT_METHODS.E_WALLET,
  E_WALLET: PAYMENT_METHODS.E_WALLET,
  EWALLET: PAYMENT_METHODS.E_WALLET,
  INSTA_PAY: PAYMENT_METHODS.INSTAPAY,
  INSTAPAY: PAYMENT_METHODS.INSTAPAY,
});

const trimOptionalString = (value, fieldName, res, maxLength = 1000) => {
  if (value === undefined || value === null || value === "") return undefined;

  if (typeof value !== "string") {
    res.status(400);
    throw new Error(`${fieldName} غير صالح`);
  }

  const trimmed = value.trim();
  if (!trimmed) return undefined;

  if (trimmed.length > maxLength) {
    res.status(400);
    throw new Error(`${fieldName} يجب ألا يتجاوز ${maxLength} حرف`);
  }

  return trimmed;
};

const normalizePaymentMethod = (value, res) => {
  if (value === undefined || value === null || value === "") {
    res.status(400);
    throw new Error("طريقة الدفع مطلوبة");
  }

  if (typeof value !== "string") {
    res.status(400);
    throw new Error("طريقة الدفع غير صالحة");
  }

  const normalized = PAYMENT_METHOD_ALIASES[value.trim().toUpperCase()];
  if (!normalized) {
    res.status(400);
    throw new Error("طريقة الدفع يجب أن تكون cash أو wallet أو instapay");
  }

  return normalized;
};

const normalizeCheckoutPayment = (body, res) => {
  const paymentMethod = normalizePaymentMethod(body.paymentMethod, res);
  const transferPhone = trimOptionalString(
    body.transferPhone ?? body.paymentPhone,
    "رقم هاتف التحويل",
    res,
    30
  );
  const transferImage = trimOptionalString(
    body.transferImage ?? body.transferScreenshot,
    "صورة التحويل",
    res,
    10 * 1024 * 1024
  );
  const paymentReference = trimOptionalString(body.paymentReference, "مرجع الدفع", res, 120);
  const paymentNotes = trimOptionalString(body.paymentNotes, "ملاحظات الدفع", res, 1000);

  if (paymentMethod === PAYMENT_METHODS.CASH) {
    return {
      paymentMethod,
      paymentStatus: PAYMENT_STATUSES.PENDING,
    };
  }

  if (!transferPhone) {
    res.status(400);
    throw new Error("رقم هاتف التحويل مطلوب عند اختيار المحفظة أو انستاباي");
  }

  if (!transferImage) {
    res.status(400);
    throw new Error("صورة التحويل مطلوبة عند اختيار المحفظة أو انستاباي");
  }

  if (!isBase64Image(transferImage)) {
    res.status(400);
    throw new Error("صورة التحويل يجب أن تكون base64 image صالحة");
  }

  return {
    paymentMethod,
    paymentStatus: PAYMENT_STATUSES.PENDING,
    transferPhone,
    transferImage,
    paymentReference,
    paymentNotes,
  };
};

module.exports = {
  PAYMENT_METHODS,
  PAYMENT_METHOD_VALUES,
  PAYMENT_STATUSES,
  PAYMENT_STATUS_VALUES,
  normalizeCheckoutPayment,
};
