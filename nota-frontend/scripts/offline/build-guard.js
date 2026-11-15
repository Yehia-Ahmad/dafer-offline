#!/usr/bin/env node
// Stage 24/25: the step that sits between offline:stage and electron-builder in every installer build (electron:build:win:offline, its :dir
// variant and release:win).
//
// It checks the STAGE (offline-stage/), never the source tree: the production public key of a release is swapped into the staged copy from
// NOTA_RELEASE_PUBLIC_KEY_FILE (Stage 25), so the repo's keys.js legitimately keeps its placeholder. It FAILS when
//   - the stage is marked NON-RELEASABLE (built with NOTA_ALLOW_PLACEHOLDER_KEY=1, which is for development verification only),
//   - the stage has no key record (offline:stage never ran), or the record says placeholder,
//   - the key in the stage is the test key.
// NOTA_ALLOW_PLACEHOLDER_KEY is deliberately never read here, so an installer can never be built with a key that accepts no license.
'use strict';

const path = require('node:path');
const protect = require('./protect');
const releaseKey = require('./release-key');

const ROOT = path.resolve(__dirname, '..', '..');
const BACKEND_SOURCE = path.resolve(process.env.NOTA_BACKEND_DIR || path.join(ROOT, '..', 'nota-backend'));
// NOTA_STAGE_DIR only moves where the stage is looked for (tests).
const STAGE = path.resolve(process.env.NOTA_STAGE_DIR || path.join(ROOT, 'offline-stage'));

const problems = [
  ...protect.releaseProblems(STAGE),
  ...releaseKey.recordProblems(STAGE, { backendDir: BACKEND_SOURCE }),
];

if (problems.length) {
  console.error('[build-guard] ERROR: this build cannot be released:');
  for (const problem of [...new Set(problems)]) console.error(`  ${problem}`);
  process.exit(1);
}
console.log('[build-guard] the stage carries a production key and is releasable');
