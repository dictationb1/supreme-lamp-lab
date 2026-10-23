// [LAB-REPAIR] /api/logon-status reported logonType:'' for EVERY matched event.
//
// THE DEFECT (proven from source; lab evidence: run 39598371464 on
// dictationb1/supreme-lamp-lab, app 978a837):
//
//     if ($msg -notmatch 'Logon Type:\s+(2|10|11)\b') { continue }
//     if ($userQ -and $msg -notmatch [regex]::Escape($userQ)) { continue }
//     $connected = $true
//     $ltSeen = [string]$Matches[1]        # <-- too late
//
// Per Microsoft's about_Comparison_Operators, `-notmatch` populates $Matches
// whenever the pattern MATCHES (the operator returns $false in that case). The
// user filter is a scalar -notmatch with no capture group, so it replaces the
// capture from the type pattern with a hashtable that only has key 0. By the
// time $ltSeen is read, $Matches[1] is $null - and a user filter is ALWAYS
// supplied, because the route falls back to the config's rdpUser when the query
// omits `user`. So the endpoint could never report the logon type of the very
// event it matched, even for a genuine RemoteInteractive (10) logon.
//
// THE FIX: save the capture before the user filter (`$ltThis`), then use it.
//
// This test is the static half. The lab's Windows job runs the two orderings
// side by side under real PowerShell (scripts/run-regressions.js, "app defect:
// -notmatch clobbers $Matches before LogonType is read") and requires the
// buggy order to yield '' and the fixed order to yield '10'. Neither half is a
// substitute for the other: this one fails a revert at PR time on Linux, that
// one proves the PowerShell semantics on Windows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SERVER = readFileSync(new URL("../payloads/ghrdp-server.ps1", import.meta.url), "utf8");

/** The /api/logon-status route body, from its `if ($path -eq ...)` to its `return`. */
function logonStatusBlock() {
  const start = SERVER.indexOf("if ($path -eq '/api/logon-status')");
  assert.ok(start >= 0, "/api/logon-status route not found");
  const ret = SERVER.indexOf("return", SERVER.indexOf("Send-ClientResponse", start));
  assert.ok(ret > start, "/api/logon-status route has no terminating return");
  return SERVER.slice(start, ret);
}

test("logon-status saves the LogonType capture BEFORE the user filter", () => {
  const block = logonStatusBlock();
  const typeMatch = block.indexOf("$msg -notmatch 'Logon Type:");
  const saveCapture = block.indexOf("$ltThis = [string]$Matches[1]");
  const userFilter = block.indexOf("$userQ -and $msg -notmatch");
  const connected = block.indexOf("$connected = $true");
  const useCapture = block.indexOf("$ltSeen = $ltThis");

  assert.ok(typeMatch >= 0, "the type regex is missing");
  assert.ok(saveCapture >= 0, "the LogonType capture is not saved ($ltThis) - the $Matches clobber is back");
  assert.ok(userFilter >= 0, "the user filter is missing");
  assert.ok(useCapture >= 0, "$ltSeen must be assigned from the saved capture");

  // The exact ordering the fix requires.
  assert.ok(saveCapture > typeMatch, "$ltThis must be read after the type regex matched");
  assert.ok(saveCapture < userFilter, "$ltThis must be read BEFORE the user -notmatch clobbers $Matches");
  assert.ok(useCapture > userFilter, "$ltSeen is assigned after the filters");
  assert.ok(connected > userFilter && connected < useCapture, "$ltSeen is assigned after $connected");
});

test("logon-status never reads $Matches after the user filter", () => {
  const block = logonStatusBlock();
  const userFilter = block.indexOf("$userQ -and $msg -notmatch");
  assert.ok(userFilter >= 0);
  const after = block.slice(userFilter);
  // Reading $Matches[1] after the user filter is exactly the bug. The only
  // legitimate later read is the Source Network Address one, which follows its
  // OWN -match on the very next statement.
  const reads = [...after.matchAll(/\$Matches\[1\]/g)];
  assert.equal(
    reads.length,
    1,
    "only the Source Network Address capture may read $Matches after the user filter; " +
      "found " + reads.length + " read(s) - the LogonType must come from $ltThis"
  );
  // Check the whole LINE the read sits on, not the text before/after it.
  const lineStart = after.lastIndexOf("\n", reads[0].index) + 1;
  const lineEnd = after.indexOf("\n", reads[0].index);
  const readLine = after.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
  assert.match(readLine, /Source Network Address/, "the remaining $Matches[1] read must be the source-address capture");
  assert.ok(!/\$ltSeen\s*=\s*\[string\]\$Matches\[1\]/.test(after), "$ltSeen must never be read from $Matches after the user filter");
});

test("logon-status still filters by user and reports the type it captured", () => {
  const block = logonStatusBlock();
  // The user filter must stay: dropping it would "fix" the type by reporting
  // some other account's logon.
  assert.match(block, /if \(\$userQ -and \$msg -notmatch \[regex\]::Escape\(\$userQ\)\) \{ continue \}/);
  assert.match(block, /logonType\s*=\s*\$ltSeen/);
  // The independent XML collector this lab cross-checks against is untouched.
  assert.match(SERVER, /function Get-RdpLogonEventFields/);
  assert.match(SERVER, /logonType = \(\[string\]\$name\['LogonType'\]\)\.Trim\(\)/);
});
