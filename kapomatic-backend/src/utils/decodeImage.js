const invalidImage = () => {
  const error = new Error("Invalid stored website image data");
  error.statusCode = 422;
  return error;
};

const imageMimeType = (buffer) => {
  if (
    buffer.length >= 3 &&
    buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
  ) {
    return "image/jpeg";
  }
  if (
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return "image/png";
  }
  if (["GIF87a", "GIF89a"].includes(buffer.toString("ascii", 0, 6)))
    return "image/gif";
  if (
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  if (
    buffer.toString("ascii", 4, 8) === "ftyp" &&
    ["avif", "avis"].includes(buffer.toString("ascii", 8, 12))
  )
    return "image/avif";
  return null;
};

const decodeImage = (value) => {
  if (typeof value !== "string") throw invalidImage();
  const source = value.trim();
  const dataUrl = source.match(
    /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]*)$/i,
  );
  const encoded = (dataUrl ? dataUrl[2] : source).replace(/\s+/g, "");
  // Buffer.from is deliberately permissive: validate first and check the
  // round trip so malformed/padded input cannot silently become image bytes.
  if (
    !encoded ||
    !/^[a-z0-9+/]+={0,2}$/i.test(encoded) ||
    encoded.length % 4 === 1
  ) {
    throw invalidImage();
  }
  if (encoded.includes("=") && encoded.length % 4 !== 0) throw invalidImage();
  const buffer = Buffer.from(encoded, "base64");
  if (
    buffer.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")
  ) {
    throw invalidImage();
  }
  const contentType = imageMimeType(buffer);
  const declaredType = dataUrl?.[1]
    .toLowerCase()
    .replace("image/jpg", "image/jpeg");
  if (!contentType || (declaredType && declaredType !== contentType))
    throw invalidImage();
  return { buffer, contentType };
};

module.exports = { decodeImage };
