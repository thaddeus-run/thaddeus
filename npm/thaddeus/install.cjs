// postinstall: prefetch the binary so the first `thaddeus` run is instant.
// Never fail the install — the launcher downloads on first run as a fallback
// (e.g. when install scripts are disabled or the machine is offline).
'use strict';

const { ensureBinary } = require('./download.cjs');

ensureBinary('thaddeus').then(
  (bin) => console.log(`thaddeus: ready (${bin})`),
  (err) =>
    console.warn(
      `thaddeus: could not prefetch the binary (${err.message}); ` +
        'it will download on first run.'
    )
);
