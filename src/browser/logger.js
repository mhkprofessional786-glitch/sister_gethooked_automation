'use strict';

function log(step, message) {
  console.log(`[${step}] ${message}`);
}

function warn(step, message) {
  console.warn(`\n[${step}][WARNING] ${message}\n`);
}

function error(step, message) {
  console.error(`\n[${step}][ERROR] ${message}\n`);
}

module.exports = { log, warn, error };
