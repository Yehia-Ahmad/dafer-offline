const errorHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);
  let statusCode = err.statusCode || (res.statusCode === 200 ? 500 : res.statusCode);
  let message = err.message || "خطأ داخلي في الخادم";

  if (err.name === "CastError") {
    statusCode = 400;
    message = "تنسيق المعرّف غير صالح";
  }

  if (err.code === 11000) {
    statusCode = 409;
    message = "تم إدخال قيمة مكررة";
    err.responseData = {
      ...(err.responseData || {}),
      fieldErrors: Object.keys(err.keyPattern || err.keyValue || {}).map((field) => ({
        field,
        message: "مستخدم بالفعل",
      })),
    };
  }

  if (err.name === "ValidationError") {
    statusCode = 400;
    message = Object.values(err.errors)
      .map((value) => value.message)
      .join(", ");
  }

  const responseData =
    err.responseData && typeof err.responseData === "object"
      ? err.responseData
      : {};

  if (typeof res.set === "function") res.set("Cache-Control", "no-store");
  else if (typeof res.setHeader === "function") res.setHeader("Cache-Control", "no-store");
  res.status(statusCode).json({ message, ...responseData });
};

module.exports = errorHandler;
