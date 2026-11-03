const { clearPublicSeoCache } = require("./seo");

const attachPublicCacheInvalidation = (schema) => {
  schema.post("save", clearPublicSeoCache);
  schema.post("insertMany", clearPublicSeoCache);
  [
    "findOneAndUpdate",
    "findOneAndDelete",
    "updateOne",
    "updateMany",
    "deleteOne",
    "deleteMany",
    "replaceOne",
  ].forEach((operation) => schema.post(operation, clearPublicSeoCache));
  schema.post(
    "deleteOne",
    { document: true, query: false },
    clearPublicSeoCache
  );
};

module.exports = attachPublicCacheInvalidation;
