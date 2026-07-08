// Resolve and fetch the prebuilt binary for this platform from the GitHub
// Release matching this package's version, verified against the release's
// SHA256SUMS. Shared by the postinstall (install.cjs) and the launcher
// (bin/*.cjs), so the tool works even when install scripts are disabled — the
// launcher downloads on first run.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');

const REPO = 'thaddeus-run/thaddeus';
const MAX_REDIRECTS = 10;

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

// GET a URL, following redirects up to a bounded depth (a redirect cycle would
// otherwise exhaust the stack). `onResponse(res)` consumes the final 200 body.
function request(url, onResponse, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > MAX_REDIRECTS) {
      reject(new Error(`too many redirects fetching ${url}`));
      return;
    }
    https
      .get(
        url,
        { headers: { 'user-agent': 'thaddeus-npm-installer' } },
        (res) => {
          if (
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            res.resume();
            resolve(request(res.headers.location, onResponse, redirects + 1));
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            return;
          }
          onResponse(res, resolve, reject);
        }
      )
      .on('error', reject);
  });
}

// Download a URL to `dest`.
function download(url, dest) {
  return request(url, (res, resolve, reject) => {
    const file = fs.createWriteStream(dest);
    res.pipe(file);
    file.on('finish', () => file.close(() => resolve()));
    file.on('error', reject);
  });
}

// Fetch a URL's text body (used for SHA256SUMS).
function fetchText(url) {
  return request(url, (res, resolve) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => (body += chunk));
    res.on('end', () => resolve(body));
  });
}

function sha256(file) {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(file))
    .digest('hex');
}

// The expected hex digest for `asset` from a `SHA256SUMS` body (lines are
// `<hash>  <name>` or `<hash> *<name>`); null if the asset is not listed.
function expectedHash(sums, asset) {
  for (const line of sums.split('\n')) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (m && m[2] === asset) {
      return m[1].toLowerCase();
    }
  }
  return null;
}

// Ensure the binary exists locally (idempotent) and return its path. The
// download is checksum-verified against the release's SHA256SUMS before it is
// trusted; a mismatch or a missing entry is fatal.
async function ensureBinary(tool) {
  const { version } = require('./package.json');
  const { asset, ext } = assetFor(tool);
  const binDir = path.join(__dirname, 'bin');
  const binPath = path.join(binDir, `${tool}${ext}`);
  if (fs.existsSync(binPath)) {
    return binPath;
  }
  fs.mkdirSync(binDir, { recursive: true });
  const releaseBase = `https://github.com/${REPO}/releases/download/v${version}`;
  const tmp = `${binPath}.download`;
  try {
    await download(`${releaseBase}/${asset}`, tmp);
    const sums = await fetchText(`${releaseBase}/SHA256SUMS`);
    const expected = expectedHash(sums, asset);
    if (!expected) {
      throw new Error(`no checksum for ${asset} in SHA256SUMS`);
    }
    const actual = sha256(tmp);
    if (actual !== expected) {
      throw new Error(
        `checksum mismatch for ${asset}: expected ${expected}, got ${actual}`
      );
    }
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, binPath);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`failed to install ${asset}: ${err.message}`);
  }
  return binPath;
}

module.exports = { ensureBinary };
