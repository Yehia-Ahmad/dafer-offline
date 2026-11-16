// Dev script (not part of the build). Online Stage 6B proof that the desktop markup did not change:
// every template that got a phone layout must contain its ORIGINAL (the pre-6B commit) text, byte for byte, as the body of the `@else { ... }` branch.
//   node scripts/verify-desktop-markup.mjs
// Checks changed .html files, and the inline `template: \`...\`` of changed .ts components. Exit code 1 when any differs.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = execSync('git rev-parse --show-toplevel').toString().trim();
const BASE = process.env.NOTA_6B_BASE || 'ae9deb30'; // the last commit before Stage 6B
const changed = execSync(`git diff --name-only ${BASE}`, { cwd: root }).toString().split('\n').filter(Boolean);
const head = (rel) => execSync(`git show ${BASE}:${rel}`, { cwd: root, maxBuffer: 1 << 26 }).toString('utf8');
const norm = (text) => text.replace(/\r\n/g, '\n');

let bad = 0; let checked = 0;
// A template that was already phone-aware before 6B (Stage 6A wrapped some pages): its desktop body is the text after the first
// top-level "} @else {" line; 6B may only change the phone branch of it.
const elseBody = (text) => {
  const t = norm(text);
  const m = /^\} @else \{\n/m.exec(t);
  return m ? t.slice(m.index + m[0].length).replace(/\n+\}?\s*$/, '') : null;
};
function expectBranch(rel, current, original) {
  if (norm(original).includes('@if (layout.isMobile()) {')) {
    checked++;
    const a = elseBody(original); const b = elseBody(current);
    if (a === null || b === null || a !== b) { bad++; console.log(`DIFFERENT  ${rel}: the desktop (@else) body of this already phone-aware template changed`); }
    else console.log(`identical  ${rel} (desktop body of a 6A phone-aware template)`);
    return true;
  }
  const open = '@if (layout.isMobile()) {';
  if (!current.includes(open)) return false; // not converted
  const body = norm(original).replace(/\n+$/, '');
  const marker = '} @else {\n';
  const at = norm(current).indexOf(marker + body);
  checked++;
  if (at < 0) { bad++; console.log(`DIFFERENT  ${rel}: the @else branch does not equal the HEAD template`); }
  else console.log(`identical  ${rel}`);
  return true;
}

const inlineChecked = new Set();
// Templates whose phone parts are small inline branches (a switch in place of a checkbox, a marked phone block) rather than one
// whole-template wrapper: collapse every phone branch to its desktop (@else) side, then compare with the original ignoring
// indentation. Desktop-only bindings that are false on desktop ([class.m-card]) are removed first.
const collapsePhone = (text) => {
  let t = norm(text)
    .replace(/\} @else if \(layout\.isMobile\(\) && editing\(\)\) \{\s*<!--6B-PHONE-START-->[\s\S]*?<!--6B-PHONE-END-->\s*(?=\} @else \{)/g, '')
    .replace(/<!--6B-PHONE-START-->[\s\S]*?<!--6B-PHONE-END-->/g, '')
    .replace(/ \[class\.m-card\]="layout\.isMobile\(\)"/g, '')
    .replace('@if (!layout.isMobile()) {', '@if (!layout.isMobile() || editing()) {');
  const open = '@if (layout.isMobile()) {';
  for (let at = t.indexOf(open); at >= 0; at = t.indexOf(open)) {
    const braceEnd = (from) => { let d = 0; for (let i = from; i < t.length; i++) { if (t[i] === '{') d++; else if (t[i] === '}') { d--; if (d === 0) return i; } } return -1; };
    const a = braceEnd(at + open.length - 1);
    const rest = t.slice(a + 1);
    const m = /^\s*@else \{/.exec(rest);
    if (!m) { t = t.slice(0, at) + t.slice(a + 1); continue; }
    const bStart = a + 1 + m[0].length - 1;
    const b = braceEnd(bStart);
    t = t.slice(0, at) + t.slice(bStart + 1, b) + t.slice(b + 1);
  }
  return t.replace(/\s+/g, ' ').trim();
};
const grabTemplate = (text) => { const m = /template:\s*`([\s\S]*?)`\s*,?\s*\n?\s*(?:styles|styleUrl|\}\))/.exec(norm(text)); return m ? m[1] : null; };
for (const rel of ['nota-frontend/src/app/modules/website/category-website-fields.component.ts', 'nota-frontend/src/app/modules/website/product-website-section.component.ts', 'nota-frontend/src/app/modules/orders/order-page/order-page.component.ts']) {
  inlineChecked.add(rel);
  if (!changed.includes(rel)) continue;
  checked++;
  const a = grabTemplate(head(rel)); const b = grabTemplate(fs.readFileSync(path.join(root, rel), 'utf8'));
  if (a === null || b === null || a.replace(/\s+/g, ' ').trim() !== collapsePhone(b)) { bad++; console.log(`DIFFERENT  ${rel}: desktop side of the inline phone branches != HEAD template`); }
  else console.log(`identical  ${rel} (phone branches collapsed)`);
}

for (const rel of changed) {
  if (inlineChecked.has(rel) || !fs.existsSync(path.join(root, rel))) continue;
  const current = fs.readFileSync(path.join(root, rel), 'utf8');
  if (rel.endsWith('.html') && rel.includes('nota-frontend/src/app/')) {
    expectBranch(rel, current, head(rel));
  } else if (rel.endsWith('.ts') && !rel.endsWith('.spec.ts') && rel.includes('nota-frontend/src/app/') && current.includes('@if (layout.isMobile()) {')) {
    // inline template: compare the original template literal's text
    const grab = (text) => { const m = /template:\s*`([\s\S]*?)`\s*,?\s*\n?\s*(?:styles|styleUrl|\}\))/.exec(norm(text)); return m ? m[1] : null; };
    const originalTemplate = grab(head(rel));
    const currentTemplate = grab(current);
    if (originalTemplate === null || currentTemplate === null) { bad++; console.log(`UNKNOWN    ${rel}: could not read the inline template`); continue; }
    expectBranch(rel, currentTemplate, originalTemplate);
  }
}
console.log(`\n${checked} converted template(s) checked, ${bad} differing`);
process.exit(bad ? 1 : 0);
