const morgan = require("morgan");

// Production access log: short combined line, and the URL without its query string (search text can be in it).
const productionFormat = (tokens, req, res) => {
  const url = String(tokens.url(req, res) || "").split("?")[0];
  return [
    tokens["remote-addr"](req, res),
    "-",
    tokens.method(req, res),
    url,
    tokens.status(req, res),
    tokens.res(req, res, "content-length") || "-",
    "-",
    `${tokens["response-time"](req, res) || "-"}ms`,
  ].join(" ");
};

const createAccessLog = (env = process.env) => (env.NODE_ENV === "production" ? morgan(productionFormat) : morgan("dev"));

module.exports = { createAccessLog, productionFormat };
