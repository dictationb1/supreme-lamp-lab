'use strict';
// Compatibility facade. The implementation lives in scripts/lib/registry.js
// (atomic, lock-protected registry) and scripts/lib/lock.js (exclusive lock).
const registry = require('./lib/registry');
const lock = require('./lib/lock');
const proc = require('./lib/proc');

module.exports = {
  ...registry,
  acquireLock: lock.acquireLock,
  releaseLock: lock.releaseLock,
  withLock: lock.withLock,
  getProcess: proc.getProcess,
  sameIdentity: proc.sameIdentity
};
