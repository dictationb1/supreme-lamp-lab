#!/usr/bin/env node
'use strict';
// Source-discovered Mission Control feature/action inventory.
//
// This is deliberately an INVENTORY, not a behavioural verdict. It parses the
// exact application checkout with its own pinned TypeScript compiler and lists
// every JSX surface that can navigate, accept input, or invoke an action. The
// browser sweep must reconcile these keys with DOM-discovered controls and
// behavioural evidence; a row existing here never means PASS.

const fs = require('fs');
const path = require('path');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.isFile() && p.endsWith('.tsx') && !p.includes(`${path.sep}tests${path.sep}`)) out.push(p);
  }
  return out;
}

function literal(attr, ts) {
  if (!attr || !attr.initializer) return null;
  const init = attr.initializer;
  if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) return init.text;
  if (ts.isJsxExpression(init) && init.expression && (ts.isStringLiteral(init.expression) || ts.isNoSubstitutionTemplateLiteral(init.expression))) return init.expression.text;
  return null;
}

function globMatch(file, pattern) {
  const esc = s => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const re = pattern.split('/').map(part => {
    if (part === '**') return '(?:.*)';
    return part.split('**').map(p => p.split('*').map(esc).join('[^/]*')).join('(?:.*)');
  }).join('/');
  return new RegExp('^' + re + '$').test(file);
}

function main() {
  const app = path.resolve(arg('app', ''));
  const out = path.resolve(arg('out', 'source-inventory.json'));
  const sha = arg('sha', '');
  const variant = arg('variant', 'unpatched-baseline');
  if (!fs.existsSync(path.join(app, 'package.json'))) throw new Error('--app must be the application package root');
  const ts = require(path.join(app, 'node_modules', 'typescript'));
  const registry = JSON.parse(fs.readFileSync(path.join(app, 'src', 'lib', 'feature-registry.json'), 'utf8'));
  const features = registry.features.map(f => ({
    id: f.id, route: f.route, labRoute: f.labRoute || null, component: f.component,
    owns: f.owns, stores: f.stores || [], endpoints: f.endpoints || [],
    dependsOn: f.dependsOn || [], navigatesTo: f.navigatesTo || []
  }));
  const rows = [];
  for (const file of walk(path.join(app, 'src'))) {
    const relative = path.relative(app, file).replace(/\\/g, '/');
    const text = fs.readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const feature = features.find(f => (f.owns || []).some(pattern => globMatch(relative, pattern)));
    const visit = node => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(sf);
        const attrs = node.attributes.properties.filter(ts.isJsxAttribute);
        const names = attrs.map(a => a.name.getText(sf));
        const lower = tag.toLowerCase();
        const actionableTag = ['button', 'a', 'input', 'select', 'textarea', 'form', 'summary'].includes(lower) || ['Button', 'Copy'].includes(tag);
        const actionAttrs = names.filter(n => /^on(?:Click|DoubleClick|Change|Input|Submit|KeyDown|KeyUp|KeyPress|Drag|DragStart|DragEnd|DragOver|Drop|PointerDown|PointerUp|MouseDown|MouseUp|CheckedChange|ValueChange|OpenChange|Select|Toggle|Dismiss|Close|Retry|Refresh|Upload|Download|Delete|Remove|Save|Cancel|Confirm)/.test(n));
        const navigates = names.includes('href') || names.includes('to');
        const draggable = names.includes('draggable');
        if (actionableTag || actionAttrs.length || navigates || draggable) {
          const componentControl = /(?:Button|Link|Toggle|Switch|Checkbox|Radio|Select|Input|Tab)$/.test(tag);
          const surfaceKind = (actionableTag || navigates || draggable || componentControl)
            ? 'actionable-control'
            : (lower === tag ? 'event-surface' : 'component-callback');
          const byName = Object.create(null);
          for (const a of attrs) byName[a.name.getText(sf)] = a;
          const testid = literal(byName['data-testid'], ts);
          const id = literal(byName.id, ts);
          const role = literal(byName.role, ts);
          const aria = literal(byName['aria-label'], ts);
          const href = literal(byName.href, ts);
          const to = literal(byName.to, ts);
          const dynamicTestid = !testid && !!byName['data-testid'];
          const dynamicId = !id && !!byName.id;
          const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          const key = testid ? `testid:${testid}` : id ? `id:${id}` : `source:${relative}:${pos.line + 1}:${tag}`;
          rows.push({
            key, stable: Boolean(testid || id), dynamicTestid, dynamicId,
            surfaceKind,
            testid, id, tag, role, ariaLabel: aria,
            type: literal(byName.type, ts), href, to,
            source: relative, line: pos.line + 1, column: pos.character + 1,
            feature: feature ? feature.id : null,
            actionAttributes: actionAttrs,
            inputAttributes: names.filter(n => /^(value|defaultValue|checked|defaultChecked|selected|disabled|readOnly|required|min|max|step|accept|multiple|draggable)$/.test(n)),
            disabled: byName.disabled ? (byName.disabled.initializer ? 'dynamic' : 'true') : null,
            behaviouralStatus: surfaceKind === 'component-callback' ? 'DEFER_TO_RENDERED_DOM' : 'NOT_RUN'
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  rows.sort((a, b) => a.key.localeCompare(b.key) || a.source.localeCompare(b.source) || a.line - b.line);
  const report = {
    schema: 'slab-source-action-inventory/1',
    generatedAt: new Date().toISOString(),
    application: { repository: 'dictationb1/supreme-lamp', baseSha: sha, variant },
    method: 'TypeScript AST over src/**/*.tsx plus src/lib/feature-registry.json; NOT behavioural acceptance',
    features,
    summary: {
      features: features.length,
      actionableSurfaces: rows.length,
      requiredBehaviouralSurfaces: rows.filter(r => r.surfaceKind !== 'component-callback').length,
      componentCallbackSurfaces: rows.filter(r => r.surfaceKind === 'component-callback').length,
      nativeEventSurfaces: rows.filter(r => r.surfaceKind === 'event-surface').length,
      stableIdSurfaces: rows.filter(r => r.stable).length,
      sourceOnlyKeySurfaces: rows.filter(r => !r.stable).length,
      dynamicTestidSurfaces: rows.filter(r => r.dynamicTestid).length,
      dynamicIdSurfaces: rows.filter(r => r.dynamicId).length,
      behaviourallyExecuted: 0
    },
    controls: rows
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report.summary));
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(e && e.stack || e); process.exit(1); }
}

module.exports = { literal, globMatch };
