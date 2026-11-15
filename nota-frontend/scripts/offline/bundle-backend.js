'use strict';

// Stage 25: bundles the staged backend (src + its production dependencies) into two files, so the app opens a handful of
// files at start instead of ~1,400 (and the tamper check hashes a handful instead of ~4,300; Defender scans every file on its first read).
//
//   src/server.js          the whole server (every dependency inlined)
//   src/driver.js          { mongodb, bson }: the Electron main process uses the driver itself (backup, restore, setup, db-auth),
//                          and it can no longer reach node_modules/mongodb, which the bundle replaced
//   src/license/index.js   the license module on its own: the Electron main process requires it directly (activation gate), and the
//                          server must share that one module instance (it captures crypto/fs/child_process when it loads, first)
//
// External (left as a runtime require): Node built-ins, mongodb's optional packages (not installed, guarded by the driver), the AWS
// credential providers, supports-color (optional peer of debug) and ./test-key (deleted from a release; a stray reference then fails
// loudly instead of the test key being bundled).
//
// The source map goes to sourceMapDir (the release artifacts), never into the staged backend.

const fs = require('node:fs');
const path = require('node:path');

const EXTERNALS = [
  '@mongodb-js/zstd', 'gcp-metadata', 'kerberos', 'mongodb-client-encryption', 'snappy', 'socks', 'aws4', '@aws-sdk/*',
  'supports-color', './test-key',
];
const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.[a-z]+)?$/i;

const packageOf = (inputPath) => {
  const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(inputPath.replace(/\\/g, '/'));
  return match ? match[1] : null;
};

/** Third-party LICENSE texts of every bundled package (the bundle is bytecode, so license notices must travel as a plain file). */
function collectLicenses(backendDir, packages) {
  const parts = [];
  for (const name of [...packages].sort()) {
    const dir = path.join(backendDir, 'node_modules', ...name.split('/'));
    let version = '';
    try { version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version; } catch { /* no manifest */ }
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((file) => LICENSE_FILE.test(file)) : [];
    const text = files.map((file) => fs.readFileSync(path.join(dir, file), 'utf8').trim()).join('\n\n');
    parts.push(`==== ${name}${version ? ` ${version}` : ''} ====\n${text || '(no license file in the package)'}\n`);
  }
  return parts.join('\n');
}

/**
 * Replaces backendDir/src with the two bundles and prunes node_modules to what the bundles still require.
 * @returns {Promise<{ bundleBytes: number, inputs: number, packages: string[], externalRequires: string[] }>}
 */
async function bundleBackend({ backendDir, sourceMapDir }) {
  const esbuild = require('esbuild');
  const srcDir = path.join(backendDir, 'src');
  const tempDir = path.join(backendDir, '.bundle');
  const licenseDir = path.join(srcDir, 'license');
  const licenseIndex = path.join(licenseDir, 'index.js');
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(sourceMapDir, { recursive: true });

  const sharedLicense = {
    name: 'shared-license-instance',
    setup(build) {
      build.onResolve({ filter: /^\./ }, (args) => {
        if (args.kind === 'entry-point') return null;
        const resolved = path.resolve(args.resolveDir, args.path);
        if (resolved === licenseDir || resolved === licenseIndex || resolved === licenseIndex.replace(/\.js$/, '')) {
          return { path: './license/index.js', external: true };
        }
        return null;
      });
    },
  };

  const common = {
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22', // Electron 35 = Node 22
    keepNames: true, // class and function names survive (error names, mongoose model names)
    legalComments: 'none',
    sourcemap: 'external',
    sourcesContent: true,
    metafile: true,
    logLevel: 'warning',
    absWorkingDir: backendDir,
    nodePaths: [path.join(backendDir, 'node_modules')],
  };

  const server = await esbuild.build({
    ...common,
    entryPoints: { server: path.join(srcDir, 'server.js') },
    outdir: tempDir,
    external: EXTERNALS,
    plugins: [sharedLicense],
  });
  const license = await esbuild.build({
    ...common,
    entryPoints: { index: licenseIndex },
    outdir: path.join(tempDir, 'license'),
    external: EXTERNALS,
  });

  const driverEntry = path.join(tempDir, 'driver-entry.js');
  fs.mkdirSync(tempDir, { recursive: true });
  fs.writeFileSync(driverEntry, "module.exports = { mongodb: require('mongodb'), bson: require('bson') };\n");
  const driver = await esbuild.build({
    ...common,
    entryPoints: { driver: driverEntry },
    outdir: tempDir,
    external: EXTERNALS,
  });

  // What the bundles still require at run time besides Node built-ins.
  const externalRequires = new Set();
  const packages = new Set();
  for (const result of [server, license, driver]) {
    for (const output of Object.values(result.metafile.outputs)) {
      for (const imported of output.imports) {
        if (imported.external && !imported.path.startsWith('node:') && !require('node:module').builtinModules.includes(imported.path)) externalRequires.add(imported.path);
      }
    }
    for (const input of Object.keys(result.metafile.inputs)) {
      const name = packageOf(input);
      if (name) packages.add(name);
    }
  }

  const bundleBytes = ['server.js', 'driver.js', path.join('license', 'index.js')].reduce((sum, file) => sum + fs.statSync(path.join(tempDir, file)).size, 0);
  const inputs = Object.keys(server.metafile.inputs).length + Object.keys(license.metafile.inputs).length + Object.keys(driver.metafile.inputs).length;

  // Source maps leave the backend folder (kept with the release artifacts, never shipped).
  fs.copyFileSync(path.join(tempDir, 'server.js.map'), path.join(sourceMapDir, 'backend-server.js.map'));
  fs.copyFileSync(path.join(tempDir, 'license', 'index.js.map'), path.join(sourceMapDir, 'backend-license-index.js.map'));
  fs.copyFileSync(path.join(tempDir, 'driver.js.map'), path.join(sourceMapDir, 'backend-driver.js.map'));
  // The bytecode reports positions as character offsets into the bundle text (one line), so the bundle text is kept with the maps (release artifacts,
  // never shipped): scripts/offline/decode-stack.js turns offset -> bundle line -> original file.
  fs.copyFileSync(path.join(tempDir, 'server.js'), path.join(sourceMapDir, 'backend-server.js'));
  fs.copyFileSync(path.join(tempDir, 'license', 'index.js'), path.join(sourceMapDir, 'backend-license-index.js'));
  fs.copyFileSync(path.join(tempDir, 'driver.js'), path.join(sourceMapDir, 'backend-driver.js'));

  // Replace src with the bundles.
  fs.rmSync(srcDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(srcDir, 'license'), { recursive: true });
  fs.copyFileSync(path.join(tempDir, 'server.js'), path.join(srcDir, 'server.js'));
  fs.copyFileSync(path.join(tempDir, 'license', 'index.js'), path.join(srcDir, 'license', 'index.js'));
  fs.copyFileSync(path.join(tempDir, 'driver.js'), path.join(srcDir, 'driver.js'));

  // Third-party notices travel as a plain file; then node_modules keeps only what is still required at run time.
  fs.writeFileSync(path.join(backendDir, 'THIRD_PARTY_LICENSES.txt'), collectLicenses(backendDir, packages));
  fs.rmSync(tempDir, { recursive: true, force: true });

  return { bundleBytes, inputs, packages: [...packages].sort(), externalRequires: [...externalRequires].sort() };
}

module.exports = { bundleBackend, EXTERNALS };
