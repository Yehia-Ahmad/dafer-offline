#!/usr/bin/env node
// Stage 24: the first step of every installer build (electron:build:win:offline and its :dir variant).
//
// It FAILS while the production public key in nota-backend/src/license/keys.js is still the placeholder, whatever the environment:
// NOTA_ALLOW_PLACEHOLDER_KEY (which lets `offline:stage` run for verification) is deliberately ignored here, so an installer can
// never be built with a key that accepts no license. It also refuses a stage that was marked non-releasable.
'use strict';

const path = require('node:path');
const protect = require('./protect');

const ROOT = path.resolve(__dirname, '..', '..');
const BACKEND_SOURCE = path.resolve(process.env.NOTA_BACKEND_DIR || path.join(ROOT, '..', 'nota-backend'));

const problems = [];
const key = protect.productionKeyProblem(path.join(BACKEND_SOURCE, 'src'));
if (key) problems.push(key);
problems.push(...protect.releaseProblems(path.resolve(process.env.NOTA_STAGE_DIR || path.join(ROOT, 'offline-stage'))));
// NOTA_STAGE_DIR only moves where the non-releasable marker is looked for (tests). The KEY check above reads no environment variable.

if (problems.length) {
  console.error('[build-guard] ERROR: this build cannot be released:');
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log('[build-guard] the production key is set and the stage is releasable');
