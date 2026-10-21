#!/usr/bin/env python3
"""Extract every PowerShell `run:` block from .github/workflows/*.yml into
standalone .ps1 files so Test-PowerShellSyntax.ps1 can parse them (actionlint
does not parse PowerShell). GitHub expressions are replaced by a placeholder
string so the PowerShell parser sees valid tokens."""
import glob
import os
import re
import sys

import yaml

out_dir = sys.argv[1]
os.makedirs(out_dir, exist_ok=True)
count = 0
for wf in sorted(glob.glob('.github/workflows/*.yml')):
    with open(wf, encoding='utf-8') as fh:
        doc = yaml.safe_load(fh)
    for job_id, job in (doc.get('jobs') or {}).items():
        default_shell = (((job.get('defaults') or {}).get('run') or {}).get('shell') or '')
        for idx, step in enumerate(job.get('steps') or []):
            if 'run' not in step:
                continue
            shell = str(step.get('shell') or default_shell or '')
            if not re.match(r'^(pwsh|powershell)\b', shell):
                continue
            body = re.sub(r'\$\{\{.*?\}\}', 'GHA_EXPR', step['run'], flags=re.S)
            name = f"{os.path.basename(wf)}__{job_id}__{idx:02d}.ps1"
            with open(os.path.join(out_dir, name), 'w', encoding='utf-8') as fh:
                fh.write(body)
            count += 1
print(f"extracted {count} PowerShell run blocks to {out_dir}")
