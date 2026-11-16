// Online Stage 3: Egyptian mobile numbers for the customer website. Arabic-Indic and Persian digits become ASCII,
// "+20 100 123 4567", "0020 100...", "20100..." and "0100..." all become "0100xxxxxxx". Anything else returns null.
const DIGITS = new Map();
"٠١٢٣٤٥٦٧٨٩".split("").forEach((char, index) => DIGITS.set(char, String(index)));
"۰۱۲۳۴۵۶۷۸۹".split("").forEach((char, index) => DIGITS.set(char, String(index)));

const normalizeStorePhone = (value) => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  let text = String(value).replace(/[٠-٩۰-۹]/g, (char) => DIGITS.get(char)).replace(/[\s\-().]/g, "");
  if (text.startsWith("+")) text = text.slice(1);
  if (text.startsWith("0020")) text = text.slice(4);
  else if (text.startsWith("20") && text.length === 12) text = text.slice(2);
  if (/^1[0125]\d{8}$/.test(text)) text = `0${text}`;
  return /^01[0125]\d{8}$/.test(text) ? text : null;
};

module.exports = { normalizeStorePhone };
