'use strict';

// Stage 25: turns a stack trace from the bundled, bytecode backend back into the original source files and lines.
//
//   node scripts/offline/decode-stack.js <stack.txt> [source-map-folder]
//
// The source maps are release artifacts (release-offline/<version>/sourcemaps/, or offline-stage/sourcemaps/ right after a stage); they
// never ship in the installer. A support diagnostics zip holds backend.log with the stack; this shows where it came from.
// No dependency: a small decoder for the source map v3 "mappings" field.

const fs = require('node:fs');
const path = require('node:path');

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const DIGIT = new Map([...BASE64].map((char, index) => [char, index]));

/** Decodes one map's mappings into per generated line: [{ genCol, source, line, col }] sorted by genCol (all 0-based). */
function parseMap(map) {
  const lines = [];
  let source = 0; let srcLine = 0; let srcCol = 0;
  for (const generatedLine of map.mappings.split(';')) {
    const segments = [];
    let genCol = 0;
    for (const raw of generatedLine.split(',')) {
      if (!raw) continue;
      const values = [];
      let value = 0; let shift = 0;
      for (const char of raw) {
        const digit = DIGIT.get(char);
        if (digit === undefined) throw new Error(`bad source map character ${char}`);
        value += (digit & 31) << shift;
        if (digit & 32) { shift += 5; continue; }
        values.push(value & 1 ? -(value >> 1) : value >> 1);
        value = 0; shift = 0;
      }
      genCol += values[0];
      if (values.length >= 4) {
        source += values[1]; srcLine += values[2]; srcCol += values[3];
        segments.push({ genCol, source: map.sources[source], line: srcLine, col: srcCol });
      }
    }
    lines.push(segments);
  }
  return lines;
}

/** @returns {{source:string,line:number,column:number}|null} 1-based line and column, like the stack. */
function originalPosition(parsed, line, column) {
  const segments = parsed[line - 1];
  if (!segments || !segments.length) return null;
  let best = null;
  for (const segment of segments) {
    if (segment.genCol <= column - 1) best = segment; else break;
  }
  return best ? { source: best.source, line: best.line + 1, column: best.col + 1 } : null;
}

// bytenode compiles the bundle inside Module.wrap(), and V8 reports positions in the bytecode as a character offset into that one line.
const WRAP_LENGTH = require('node:module').wrapper[0].length;

function offsetToLineColumn(text, offset) {
  if (offset < 0 || offset > text.length) return null;
  let line = 1;
  let lineStart = 0;
  for (let index = text.indexOf('\n'); index !== -1 && index < offset; index = text.indexOf('\n', index + 1)) {
    line += 1;
    lineStart = index + 1;
  }
  return { line, column: offset - lineStart + 1 };
}

const MAP_FOR = [
  [/[\\/]src[\\/]license[\\/]index\.jsc?$/, 'backend-license-index.js.map'],
  [/[\\/]src[\\/]driver\.jsc?$/, 'backend-driver.js.map'],
  [/[\\/]src[\\/]server\.jsc?$/, 'backend-server.js.map'],
];

/** Replaces every "(file:line:col)" / "file:line:col" of the bundle in the stack with the original source position. */
function decodeStack(stackText, mapsDir) {
  const cache = new Map();
  const load = (name) => {
    if (!cache.has(name)) {
      const file = path.join(mapsDir, name);
      cache.set(name, fs.existsSync(file) ? parseMap(JSON.parse(fs.readFileSync(file, 'utf8'))) : null);
    }
    return cache.get(name);
  };
  return String(stackText).replace(/((?:[A-Za-z]:)?[^\s()]*?[\\/]src[\\/](?:license[\\/]index|server|driver)\.jsc?):(\d+):(\d+)/g, (whole, file, line, column) => {
    const entry = MAP_FOR.find(([pattern]) => pattern.test(file));
    const parsed = entry && load(entry[1]);
    let bundleLine = Number(line);
    let bundleColumn = Number(column);
    const bundleFile = entry && path.join(mapsDir, entry[1].replace(/\.map$/, ''));
    if (parsed && bundleLine === 1 && file.endsWith('.jsc') && fs.existsSync(bundleFile)) {
      const located = offsetToLineColumn(fs.readFileSync(bundleFile, 'utf8'), bundleColumn - 1 - WRAP_LENGTH);
      if (!located) return whole;
      bundleLine = located.line;
      bundleColumn = located.column;
    }
    const position = parsed && originalPosition(parsed, bundleLine, bundleColumn);
    if (!position) return whole;
    const source = position.source.replace(/^(\.\.\/)+/, '').replace(/\\/g, '/');
    return `${source}:${position.line}:${position.column}`;
  });
}

module.exports = { decodeStack, parseMap, originalPosition, offsetToLineColumn, WRAP_LENGTH };

if (require.main === module) {
  const [stackFile, mapsDir = path.join(__dirname, '..', '..', 'offline-stage', 'sourcemaps')] = process.argv.slice(2);
  if (!stackFile) {
    console.error('usage: node scripts/offline/decode-stack.js <stack.txt> [source-map-folder]');
    process.exit(2);
  }
  process.stdout.write(decodeStack(fs.readFileSync(stackFile, 'utf8'), mapsDir));
}
