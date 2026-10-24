'use strict';
// The unquoted-colon-space rule exists because GitHub silently refuses the WHOLE
// workflow file and reports it as a failed run with zero jobs and no annotation
// (measured 2026-10-23, run 39962631679). These fixtures pin both directions:
// the defect must be caught, and shell text inside `run: |` must never be.
const { unquotedColonSpace } = require('../workflow-structure-check');

module.exports = async function workflowYamlTests({ test, assert }) {
  const bad = [
    'jobs:',
    '  verify:',
    '    steps:',
    '      - name: Network preflight (read-only: can this desk even reach it?)',
    '        shell: powershell',
    '        run: echo hi'
  ].join('\n');
  const good = [
    'jobs:',
    '  verify:',
    '    name: "a name: with a colon"',
    '    steps:',
    '      - name: Network preflight (read-only — can this desk reach it?)',
    '        run: |',
    '          $x = "a: b"',
    '          Write-Host "title=net preflight::tcp $h:1 ready"',
    '        with:',
    '          description: |',
    '            text: with a colon inside a literal block'
  ].join('\n');

  await test('workflow yaml: an unquoted colon+space in a step name is reported', async () => {
    const hits = unquotedColonSpace(bad);
    assert.strictEqual(hits.length, 1, JSON.stringify(hits));
    assert.strictEqual(hits[0].key, 'name');
    assert.match(hits[0].value, /read-only: can this desk/);
  });

  await test('workflow yaml: quoted values and block scalars are never reported', async () => {
    assert.deepStrictEqual(unquotedColonSpace(good), []);
  });
};
