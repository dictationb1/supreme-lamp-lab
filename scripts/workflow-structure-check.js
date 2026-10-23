#!/usr/bin/env node
'use strict';
// WORKFLOW STRUCTURE GATE — pre-merge, line-ending independent.
//
// Why this is a file and not a `node -e '...'` one-liner: actionlint reports
// SC2016 ("expressions don't expand in single quotes") for the single-quoted
// script, and the previous repair of the same class of finding was a heredoc
// for exactly that reason. A committed script is also the only version that a
// regression can pin.
//
// It re-uses scripts/lib/workflow-text.js, so the check behaves identically on
// a Linux checkout (LF) and on the Windows runner's CRLF checkout — the defect
// that produced "AssertionError: concurrency block present" in run 39819073772.
//
// Exit 0 = every structural rule holds. Exit 1 = at least one finding.

const fs = require('fs');
const path = require('path');
const wt = require('./lib/workflow-text');

const root = path.join(__dirname, '..');
const wfDir = path.join(root, '.github', 'workflows');

/** Every workflow file, normalized. */
function readAll() {
  return fs.readdirSync(wfDir).filter(f => /\.ya?ml$/.test(f)).sort().map(f => ({
    file: path.join('.github', 'workflows', f),
    name: f,
    text: wt.normalizeText(fs.readFileSync(path.join(wfDir, f), 'utf8')),
    bytes: fs.readFileSync(path.join(wfDir, f))
  }));
}

function linesOf(text) { return text.split('\n'); }

function hasCrlf(bytes) { return bytes.includes('\r\n'); }

function run() {
  const findings = [];
  const workflows = readAll();
  const add = (code, file, detail) => findings.push({ code, file, detail });

  for (const wf of workflows) {
    // A workflow file that GitHub will parse must not rely on a specific EOL,
    // and a YAML file with a BOM is not valid for every consumer.
    if (wf.bytes[0] === 0xef && wf.bytes[1] === 0xbb && wf.bytes[2] === 0xbf) add('BOM_IN_WORKFLOW', wf.file, 'a UTF-8 BOM is present');
    if (/\t/.test(wf.text.split('\n').map(l => l.match(/^[ \t]*/)[0]).join(''))) add('TAB_INDENT', wf.file, 'indentation contains tabs');
  }

  const live = workflows.find(w => w.name === 'live-run.yml');
  if (!live) {
    add('MISSING_LIVE_RUN', '.github/workflows/live-run.yml', 'the live-run workflow is not present');
  } else {
    const conc = wt.concurrencyBlock(live.text);
    if (!conc.ok) add(conc.code, live.file, conc.detail);
    else if (!conc.keys.includes('group') || !conc.keys.includes('cancel-in-progress')) {
      add('CONCURRENCY_INCOMPLETE', live.file, `keys ${conc.keys.join(',')}`);
    }
    // automatic path
    if (!/^  discover:/m.test(live.text)) add('NO_DISCOVER_JOB', live.file, 'no discover job');
    if (!/^  schedule:/m.test(live.text) || !/cron: '\*\/10 \* \* \* \*'/.test(live.text)) add('NO_SWEEP', live.file, 'no */10 sweep');
    if (!/^  pull_request:/m.test(live.text)) add('NO_PRE_MERGE_PATH', live.file, 'no pull_request trigger (the file cannot be tested before merge)');
    if (!/head\.repo\.full_name == github\.repository/.test(live.text)) add('FORK_NOT_GUARDED', live.file, 'a fork PR could reach the secret/desktop');
    if (/^  workflow_run:/m.test(live.text)) add('WORKFLOW_RUN_TRIGGER', live.file, 'workflow_run runs after the ephemeral server is gone');

    // the encrypted transport must be what the client asks for
    if (/--origin-transport[',\s]+public-log/.test(live.text)) add('STALE_TRANSPORT_FLAG', live.file, 'the client still asks for the deprecated public-log transport');

    // the private key must reach every step that re-discovers the origin, and
    // must never become an output/argument/artifact
    const liveStep = wt.stepBlock(live.text, 'LIVE VERIFICATION (discover -> origin verify -> auth -> UI -> features -> report)');
    if (!liveStep) add('NO_LIVE_STEP', live.file, 'the Windows verification step is missing');
    else if (wt.envValue(liveStep, 'LAB_SIGNAL_PRIVATE_KEY') !== '${{ secrets.LAB_SIGNAL_PRIVATE_KEY }}') {
      add('KEY_NOT_WIRED', live.file, 'the Windows verification step does not receive LAB_SIGNAL_PRIVATE_KEY (it would fall back to the plaintext log)');
    }
    if (/(^|\s)--private-key(\s|$)/.test(live.text)) add('KEY_AS_ARGUMENT', live.file, 'a key may not be passed as a command-line argument');
    if (/LAB_SIGNAL_PRIVATE_KEY/.test((live.text.split(/^jobs:/m)[1] || '').split('\n').filter(l => /^\s{6}[a-z_]+:/.test(l)).join('\n'))) {
      add('KEY_AS_OUTPUT', live.file, 'a job output names the key');
    }
  }

  // REPRODUCED (rdp-signing run 39875315477 on the client VM): every step that
  // asked for `shell: pwsh` died immediately with "pwsh: command not found".
  // The interactive client runner has Windows PowerShell 5.1 only, so any job
  // scheduled on the `rdp-lab-client` label must declare `powershell` (or use
  // `pwsh` only after provisioning it).
  for (const wf of workflows) {
    const jobs = wt.jobBlocks(wf.text);
    for (const [id, job] of Object.entries(jobs)) {
      if (!/rdp-lab-client/.test(job.runsOn)) continue;
      job.text.split('\n').forEach((line) => {
        if (/^\s*shell:\s*pwsh\s*$/.test(line)) {
          add('PWSH_NOT_AVAILABLE_ON_CLIENT', wf.file, `job ${id}: shell: pwsh on rdp-lab-client, which has Windows PowerShell 5.1 only (measured: "pwsh: command not found")`);
        }
      });
    }
  }

  const byFile = (name) => workflows.find(w => w.name === name);
  const signing = byFile('rdp-signing.yml');
  if (signing) {
    // The signing bootstrap must never become a "disable the protection" knob.
    const body = linesOf(signing.text).filter(l => !/^\s*#/.test(l)).join('\n');
    // Reads are fine (a report must be able to SHOW the current Allow* state);
    // writes are not. Match write shapes only.
    const forbiddenWrites = [
      [/New-ItemProperty[^\n]*RedirectionWarningDialogVersion/, 'RedirectionWarningDialogVersion'],
      [/RedirectionWarningDialogVersion[^\n]*-Value/, 'RedirectionWarningDialogVersion'],
      [/New-ItemProperty[^\n]*AllowUnsignedFiles/, 'AllowUnsignedFiles'],
      [/AllowUnsignedFiles["']?\s*[-=:]\s*0/, 'AllowUnsignedFiles=0'],
      [/New-ItemProperty[^\n]*AllowSignedFiles/, 'AllowSignedFiles'],
      [/enablecredsspsupport:i:0/, 'enablecredsspsupport:i:0'],
      [/authentication level:i:[12]/, 'authentication level > 0']
    ];
    for (const [re, label] of forbiddenWrites) {
      if (re.test(body)) add('SECURITY_WEAKENING', signing.file, `the workflow must not set ${label}`);
    }
    if (!/head\.repo\.full_name == github\.repository/.test(signing.text)) add('FORK_NOT_GUARDED', signing.file, 'a fork PR could reach the client VM');
    if (!wt.stepBlock(signing.text, 'Rollback (only when explicitly asked)')) add('NO_ROLLBACK', signing.file, 'rollback is not wired');
  }

  return { findings, workflows: workflows.map(w => w.name) };
}

if (require.main === module) {
  const { findings, workflows } = run();
  console.log(`workflow structure gate: ${workflows.length} workflow file(s): ${workflows.join(', ')}`);
  if (!findings.length) {
    console.log('OK 0 findings');
    process.exit(0);
  }
  for (const f of findings) {
    console.log(`${f.code}  ${f.file}  ${f.detail}`);
    console.log(`::error title=workflow structure (${f.code})::${f.file}: ${f.detail}`);
  }
  console.log(`${findings.length} finding(s)`);
  process.exit(1);
}

module.exports = { run, readAll };
