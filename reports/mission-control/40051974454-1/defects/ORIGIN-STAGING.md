# Live origin staging failure — evidence and confidence boundary

- **Class:** actual live-origin application/workflow failure.
- **Run/attempt/job:** `40051974454` / `1` / `120746757792`.
- **Application SHA:** `4a91c5c2eadc12e5b071bc46bae7683087f56fbd`.
- **First observed failed operation:** step 28, `Stage files + write config.json (UTF8 no BOM, Rentry secrets + provided edit code, token, ACLs)`.
- **Downstream effects:** RDP listener self-probe, Mission Control server startup, readiness, and initial MC-SIGNAL publication were skipped. No exact live signal check run exists. The later F92 smoke failure is downstream, not the first cause.
- **Root-cause confidence:** HIGH that the staging step is the first workflow-visible failure; UNKNOWN for the exception inside that step. Raw step-log and artifact downloads redirected to non-allowlisted hosts and could not be read.
- **Not inferred:** this evidence does not show a bad password, credential rejection, broken MC-SIGNAL publisher, HTTP stall, or invalid signal key.
- **Live UI diagnosis:** BLOCKED because this run never reached a published Mission Control service. Historical addresses and verdicts are not reused.
