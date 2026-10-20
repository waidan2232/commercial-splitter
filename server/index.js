#!/usr/bin/env node
'use strict';
// Web mode (Docker, or any computer with Node): serves the app to browsers.
//
// Environment:
//   PORT            port to listen on (default 8080)
//   HOST            address to listen on (default 0.0.0.0)
//   CS_MEDIA_DIRS   folders the app may open videos from and save clips to, separated by the path separator
//                   (default /videos, or ./videos)
//   CS_UPLOAD_DIR   where videos dropped onto the page are stored (default <first media folder>/Uploads)
//   CS_PASSWORD     if set, the page asks for this password
//   CS_DATA_DIR     where settings are kept

const fs = require('fs');
const path = require('path');
const { createApp } = require('./app');

if (process.argv[2] === 'cli' || process.argv[2] === '--cli') {
  require('../cli').main(process.argv.slice(3)).then((code) => process.exit(code), (e) => {
    console.error('Error: ' + e.message);
    process.exit(1);
  });
} else {
  const fallbackMedia = fs.existsSync('/videos') ? '/videos' : path.resolve('videos');
  const roots = (process.env.CS_MEDIA_DIRS || fallbackMedia).split(path.delimiter).filter(Boolean);
  for (const r of roots) {
    try { fs.mkdirSync(r, { recursive: true }); } catch (e) { /* read-only is fine */ }
  }
  const app = createApp({
    mode: 'web',
    mediaRoots: roots,
    uploadDir: process.env.CS_UPLOAD_DIR || undefined,
    password: process.env.CS_PASSWORD || undefined,
    dataDir: process.env.CS_DATA_DIR || undefined,
  });
  const port = Number(process.env.PORT) || 8080;
  const host = process.env.HOST || '0.0.0.0';
  app.server.listen(port, host, () => {
    console.log('Commercial Splitter is running at http://' + (host === '0.0.0.0' ? 'localhost' : host) + ':' + port);
    console.log('Videos folder' + (roots.length > 1 ? 's' : '') + ': ' + roots.join(', '));
    if (!process.env.CS_PASSWORD) console.log('No password set (CS_PASSWORD). Anyone who can reach this port can use the app.');
  });
  const stop = () => {
    app.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
