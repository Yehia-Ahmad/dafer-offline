const morgan = require("morgan");

// A guest's order tracking token is a credential and sits in the URL path: it never reaches the log.
const maskUrl = (url) => String(url || "").replace(/(\/api\/store\/orders\/track\/)[^/?#\s]+/i, "$1***");
// morgan's :url token (used by the dev format and by productionFormat below) logs the masked URL.
morgan.token("url", (req) => maskUrl(req.originalUrl || req.url));

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

const createAccessLog = (env = process.env, options = {}) => (env.NODE_ENV === "production" ? morgan(productionFormat, options) : morgan("dev", options));

module.exports = { createAccessLog, maskUrl, productionFormat };
