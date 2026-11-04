const BASE64_REGEX =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const isBase64Image = (value) => {
  if (typeof value !== "string") return false;

  const trimmed = value.trim();
  if (!trimmed) return false;

  let base64Part = trimmed;

  if (trimmed.startsWith("data:image/")) {
    const splitIndex = trimmed.indexOf(";base64,");
    if (splitIndex === -1) return false;
    base64Part = trimmed.slice(splitIndex + ";base64,".length);
  }

  const normalized = base64Part.replace(/\s+/g, "");
  if (!normalized) return false;

  return BASE64_REGEX.test(normalized);
};

module.exports = isBase64Image;
