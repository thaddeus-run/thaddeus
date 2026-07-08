// Resolve and fetch the prebuilt binary for this platform from the GitHub
// Release matching this package's version. Shared by the postinstall
// (install.cjs) and the launcher (bin/*.cjs), so the tool works even when
// install scripts are disabled — the launcher downloads on first run.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const REPO = 'thaddeus-run/thaddeus';

// The release asset name for the current platform, e.g. `thaddeus-darwin-arm64`.
function assetFor(tool) {
  const os = { linux: 'linux', darwin: 'darwin', win32: 'windows' }[
    process.platform
  ];
  const arch = { x64: 'x64', arm64: 'arm64' }[process.arch];
  if (!os || !arch) {
    throw new Error(
      `unsupported platform ${process.platform}-${process.arch}; ` +
        'build from source or use the install script'
    );
  }
  const ext = os === 'windows' ? '.exe' : '';
  return { asset: `${tool}-${os}-${arch}${ext}`, ext };
}

// GET a URL to a file, following redirects (GitHub release downloads redirect
// to a CDN). Rejects on any non-2xx final response.
function download(url, dest) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'user-agent': 'thaddeus-npm-installer' } },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();
          resolve(download(res.headers.location, dest));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
        file.on('error', reject);
      }
    );
    req.on('error', reject);
  });
}

// Ensure the binary exists locally (idempotent) and return its path.
async function ensureBinary(tool) {
  const { version } = require('./package.json');
  const { asset, ext } = assetFor(tool);
  const binDir = path.join(__dirname, 'bin');
  const binPath = path.join(binDir, `${tool}${ext}`);
  if (fs.existsSync(binPath)) {
    return binPath;
  }
  fs.mkdirSync(binDir, { recursive: true });
  const url = `https://github.com/${REPO}/releases/download/v${version}/${asset}`;
  const tmp = `${binPath}.download`;
  try {
    await download(url, tmp);
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, binPath);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`failed to download ${asset} (${url}): ${err.message}`);
  }
  return binPath;
}

module.exports = { ensureBinary };
