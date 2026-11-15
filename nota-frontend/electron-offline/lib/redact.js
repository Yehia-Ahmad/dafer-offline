'use strict';

// Stage 25: removes secrets and personal data from text that goes into the diagnostics file (log lines).
// This is the second line of defence: the diagnostics collector (diagnostics.js) only ever READS an allowlist of files, never the security
// folder, the database, the license or the config secrets. Whatever a log line happens to contain still passes through here.
// It errs on the side of removing too much: a support engineer needs the shape of a log line, not a phone number.

// Number shapes that are not phone numbers and that support needs: dates, IPv4 addresses, version/build numbers (20261114.2346).
const KEEP_NUMBER = [/^\d{4}-\d{2}-\d{2}/, /^\d{1,3}(\.\d{1,3}){3}$/, /^\d+\.\d+$/];

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
  // long hex (keys, hashes, ids that act as secrets) and long base64 blobs (DPAPI, safeStorage, signatures)
  [/\b[0-9a-fA-F]{32,}\b/g, '[hex removed]'],
  [/\b[A-Za-z0-9+/_-]{40,}={0,2}/g, '[blob removed]'],
  // personal data: e-mail addresses and phone numbers
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email removed]'],
  [/(?<![\w:-])\+?\d[\d\s().-]{7,}\d(?![\w:-]|\.\d)/g, (match) => (KEEP_NUMBER.some((pattern) => pattern.test(match)) || (match.match(/\d/g) || []).length < 8 ? match : '[phone removed]')],
  // the Windows account name inside paths
  [/([A-Za-z]:\\Users\\)[^\\\s"']+/gi, '$1[user]'],
];

function redactText(text) {
  let out = String(text);
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out;
}

module.exports = { redactText, RULES };
