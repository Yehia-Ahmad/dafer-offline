'use strict';

// Stage 25: removes secrets and personal data from text that goes into the diagnostics file (log lines).
// This is the second line of defence: the diagnostics collector (diagnostics.js) only ever READS an allowlist of files, never the security
// folder, the database, the license or the config secrets. Whatever a log line happens to contain still passes through here.
// It errs on the side of removing too much: a support engineer needs the shape of a log line, not a phone number or a customer's name.

// Number shapes that are not phone numbers and that support needs: dates, IPv4 addresses, version/build numbers (20261114.2346).
const KEEP_NUMBER = [/^\d{4}-\d{2}-\d{2}/, /^\d{1,3}(\.\d{1,3}){3}$/, /^\d+\.\d+$/];

// A recovery code with no label: 4 groups of 4 from the code alphabet (backend auth.controller RECOVERY_ALPHABET), dashes or spaces between.
const RECOVERY_CODE = /(?<![A-Za-z0-9])(?:[A-HJ-NP-Z2-9]{4}[-\s]){3}[A-HJ-NP-Z2-9]{4}(?![A-Za-z0-9])/g;

// Customer, supplier and other people's names: the VALUE of a name-like key, in key: value, key=value and JSON forms ("customerName":"...").
// It goes to the end of a quoted string, or of the unquoted value (names have spaces), so it errs on removing too much. The shop's own name is
// not a person's: diagnostics.js adds it on purpose (license.json).
const NAME_KEYS = 'name|nameAr|nameEn|name_ar|name_en|fullName|full_name|customerName|supplierName|clientName|partyName|ownerName|cashierName|cashier|customer|supplier|client|party|contact|contactName';
// Search boxes: the same values written as JSON or key: value ("search":"...", query: ...). In a URL (?search=...) they are handled by SEARCH_PARAM below.
const SEARCH_KEYS = 'search|q|query|term|keyword|filter';
const SEARCH_KEY = [
  new RegExp(`(["']?)\\b(${SEARCH_KEYS})\\1\\s*:\\s*("(?:[^"\\\\\\r\\n]|\\\\.)*"|'[^'\\r\\n]*'|[^,;}\\r\\n]+)`, 'gi'),
  '$1$2$1: "[name removed]"',
];
const NAME_RULE = [
  new RegExp(`(["']?)\\b(${NAME_KEYS})\\1\\s*([:=])\\s*("(?:[^"\\\\\\r\\n]|\\\\.)*"|'[^'\\r\\n]*'|[^,;}\\r\\n]+)`, 'gi'),
  '$1$2$1$3 "[name removed]"',
];

// Search boxes put a name or a phone number in the URL (?search=...&q=...); the request log no longer records query strings, and this removes them from
// anything older or from another log. URL-encoded (%D9%85...) or not: the value goes to the next & or space.
const SEARCH_PARAM = [/([?&])(search|q|query|term|keyword|filter)=[^&\s#]*/gi, '$1$2=[name removed]'];

const RULES = [
  // private keys and certificates
  [/-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE|PUBLIC KEY)-----[\s\S]*?-----END [A-Z ]*(?:PRIVATE KEY|CERTIFICATE|PUBLIC KEY)-----/g, '[key removed]'],
  // a Nota license text (NOTA1.<payload>.<signature>)
  [/NOTA\d*\.[A-Za-z0-9_\-+/=.]{16,}/g, '[license removed]'],
  // connection strings with credentials
  [/\b(mongodb(?:\+srv)?|https?|ftp):\/\/[^\s/@:]+:[^\s/@]*@/gi, '$1://[credentials removed]@'],
  // JSON web tokens and Authorization headers
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, '[token removed]'],
  [/\b(authorization|proxy-authorization)\s*[:=]\s*[^\r\n]+/gi, '$1: [removed]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [removed]'],
  // name = value / "name": "value" / --name value, for anything that smells like a secret
  [/(["']?)\b([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[-_]?key|private[-_]?key|credential|recovery[-_ ]?code|keyfile|mainToken|lanKey|x-nota-[a-z-]*)[A-Za-z0-9_.-]*)\1\s*([:=])\s*("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&}"']+)/gi, '$1$2$1$3 "[removed]"'],
  [/(--(?:password|pass|secret|token|keyFile|key)\b)[ =]+\S+/gi, '$1 [removed]'],
  [RECOVERY_CODE, '[recovery code removed]'],
  // long hex (keys, hashes, ids that act as secrets) and long base64 blobs (DPAPI, safeStorage, signatures)
  [/\b[0-9a-fA-F]{32,}\b/g, '[hex removed]'],
  [/\b[A-Za-z0-9+/_-]{40,}={0,2}/g, '[blob removed]'],
  // personal data: e-mail addresses
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email removed]'],
  // Egyptian mobile numbers in every common form, also right after ':' or '=' (phone:01012345678, tel=+20 100 123 4567, 0020100...)
  [/(?<!\d)(?:\+|00)20[\s.-]?\(?0?\)?[\s.-]?1[0125](?:[\s.-]?\d){8}(?!\d)/g, '[phone removed]'],
  [/(?<!\d)01[0125](?:[\s.-]?\d){8}(?!\d)/g, '[phone removed]'],
  // any other long digit run that looks like a phone number (not dates, IPs or version numbers)
  [/(?<![\w-])\+?\d[\d\s().-]{7,}\d(?![\w-]|\.\d)/g, (match) => (KEEP_NUMBER.some((pattern) => pattern.test(match)) || (match.match(/\d/g) || []).length < 8 ? match : '[phone removed]')],
  // the Windows account name inside paths
  [/([A-Za-z]:\\Users\\)[^\\\s"']+/gi, '$1[user]'],
];

/**
 * @param {string} text
 * @param {{ names?: boolean }} [options] names: false for the structured files diagnostics.js builds itself from an allowlist (their `name` keys are
 *   backup file names and the like); true (the default) for anything that came from a log.
 */
function redactText(text, { names = true } = {}) {
  let out = String(text);
  if (names) out = out.replace(SEARCH_PARAM[0], SEARCH_PARAM[1]).replace(SEARCH_KEY[0], SEARCH_KEY[1]).replace(NAME_RULE[0], NAME_RULE[1]);
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out;
}

module.exports = { redactText, RULES };
