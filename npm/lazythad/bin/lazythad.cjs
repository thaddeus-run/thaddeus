#!/usr/bin/env node
// Launcher: ensure the prebuilt `lazythad` binary exists (download on first run
// if the postinstall was skipped), then exec it with the passed args.
'use strict';

const { spawnSync } = require('node:child_process');
const { ensureBinary } = require('../download.cjs');

ensureBinary('lazythad')
  .then((bin) => {
    const res = spawnSync(bin, process.argv.slice(2), { stdio: 'inherit' });
    if (res.error) {
      throw res.error;
    }
    process.exit(res.status === null ? 1 : res.status);
  })
  .catch((err) => {
    console.error(`lazythad: ${err.message}`);
    process.exit(1);
  });
