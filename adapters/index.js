'use strict';

const fs = require('node:fs');
const path = require('node:path');
const generic = require('./generic');

function loadExternalAdapters() {
  const directory = process.env.TABBRIDGE_ADAPTERS_DIR;
  if (!directory || !fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => require(path.join(directory, entry.name)))
    .filter((adapter) => adapter && typeof adapter.name === 'string' && typeof adapter.matches === 'function' && typeof adapter.plan === 'function');
}

const adapters = [...loadExternalAdapters(), generic];

function forUrl(url) {
  return adapters.find((adapter) => adapter.matches(url)) || generic;
}

module.exports = { forUrl };
