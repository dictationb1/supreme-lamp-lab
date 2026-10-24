# Redaction audit

The PR #26 snapshot contained four `key=` query-pattern occurrences in two files. They were handled only in a private temporary copy; no source lines or values were printed in tool output and neither original file was copied into this public report.

- `data-lineage.csv`: three occurrences were replaced with `[REDACTED]` in the private copy. Each was an empty query-value field at the CSV delimiter boundary; they are still treated as sensitive-shaped material.
- `defects/AUTHORIZATION-NOT-RUN.md`: one non-empty query value (7 characters) was replaced with `[REDACTED]` in the private copy. Its contents are intentionally not classified or repeated here.
- Automated post-redaction check confirmed zero remaining non-empty `key=` values in both sanitized copies.
- The sanitized copies remain in `/tmp/pr26-redacted` only and are not part of this repository patch.
- Candidate screenshots (18 files) were visually reviewed via a private contact sheet. They are not republished. Repeated modal overlays are visible; no credential was legible at contact-sheet scale. One file named `theme-toggle-healthy.png` is itself a montage-like composite rather than a single-state screenshot, so it is not accepted as a clean single-control proof.

No live endpoint, token, credential, private key, ciphertext, cookie, HAR, trace, or authenticated screenshot is included in the report.
