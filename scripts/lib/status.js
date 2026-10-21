'use strict';
// Capability status vocabulary and the single aggregation rule used by every
// checker and by the verification report. Nothing but an explicit PASS for
// every REQUIRED capability yields an accepted verdict.

const STATUS = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  BLOCKED: 'BLOCKED',       // a prerequisite outside the check is missing (config, external auth, peer)
  NOT_RUN: 'NOT_RUN',       // never executed (default)
  SKIPPED: 'SKIPPED',       // deliberately not executed (e.g. not applicable on this platform)
  SIMULATED: 'SIMULATED'    // executed against a mock; never satisfies live acceptance
});

const ALL = new Set(Object.values(STATUS));

// Precedence for the aggregate when something is not PASS.
const ORDER = [STATUS.FAIL, STATUS.BLOCKED, STATUS.NOT_RUN, STATUS.SKIPPED, STATUS.SIMULATED];

function assertStatus(s) {
  if (!ALL.has(s)) throw new Error(`INVALID_STATUS: ${s}`);
  return s;
}

/**
 * capabilities: { name: { status, required, reason?, evidence? } }
 * Returns { status, accepted, firstCause, counts, missingRequired }
 *  - accepted is true only when every required capability is PASS and at
 *    least one required capability exists.
 *  - firstCause is the earliest (insertion-order) required non-PASS reason.
 */
function aggregate(capabilities) {
  const entries = Object.entries(capabilities || {});
  const counts = Object.fromEntries([...ALL].map(s => [s, 0]));
  const required = entries.filter(([, c]) => c && c.required);
  let firstCause = null;
  const nonPass = [];
  for (const [name, c] of entries) {
    assertStatus(c.status);
    counts[c.status]++;
    if (c.required && c.status !== STATUS.PASS) {
      nonPass.push(c.status);
      if (!firstCause) firstCause = { capability: name, status: c.status, reason: c.reason || null };
    }
  }
  let status;
  if (required.length === 0) {
    status = STATUS.NOT_RUN;
    firstCause = firstCause || { capability: null, status: STATUS.NOT_RUN, reason: 'NO_REQUIRED_CAPABILITIES_DECLARED' };
  } else if (nonPass.length === 0) {
    status = STATUS.PASS;
  } else {
    status = ORDER.find(s => nonPass.includes(s));
  }
  return {
    status,
    accepted: status === STATUS.PASS,
    firstCause,
    counts,
    missingRequired: required.filter(([, c]) => c.status !== STATUS.PASS).map(([n]) => n)
  };
}

class CapabilitySet {
  constructor(definitions) {
    this.caps = {};
    for (const [name, def] of Object.entries(definitions)) {
      this.caps[name] = { status: STATUS.NOT_RUN, required: Boolean(def.required), contract: def.contract || '', reason: null, evidence: {} };
    }
  }
  set(name, status, reason = null, evidence = undefined) {
    if (!this.caps[name]) throw new Error(`UNKNOWN_CAPABILITY: ${name}`);
    assertStatus(status);
    const c = this.caps[name];
    // never let a later write upgrade an earlier FAIL (first causal error is preserved)
    if (c.status === STATUS.FAIL && status !== STATUS.FAIL) return c;
    c.status = status;
    if (reason !== null && reason !== undefined) c.reason = reason;
    if (evidence) Object.assign(c.evidence, evidence);
    return c;
  }
  get(name) { return this.caps[name]; }
  // mark every capability that is still NOT_RUN with a reason (e.g. after an early abort)
  finalizeUnrun(reason) {
    for (const c of Object.values(this.caps)) {
      if (c.status === STATUS.NOT_RUN && !c.reason) c.reason = reason;
    }
  }
  toJSON() { return this.caps; }
  aggregate() { return aggregate(this.caps); }
}

module.exports = { STATUS, aggregate, CapabilitySet, assertStatus };
