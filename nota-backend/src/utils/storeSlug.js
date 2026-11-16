// Online Stage 3: a URL slug from a product name. Arabic and other letters stay; spaces and punctuation become "-".
const storeSlug = (name) => {
  const slug = String(name || "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, "") // Arabic diacritics and tatweel
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return slug || "product";
};

module.exports = { storeSlug };
