/* Smoke-тест логики без браузера: model + traversal + validation + presets + io(schema). */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sandbox = { window: {}, console, setTimeout, clearTimeout, Promise, Date, Math, JSON };
sandbox.window.window = sandbox.window;
vm.createContext(sandbox);

['model.js', 'traversal.js', 'validation.js', 'presets.js', 'importExport.js'].forEach(function (f) {
  const code = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  // importExport ссылается на document только внутри функций скачивания — их не вызываем
  vm.runInContext(code, sandbox, { filename: f });
});

const RR = sandbox.window.RR;
let failures = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log('  ok  ' + name);
  } else {
    failures++;
    console.error('FAIL  ' + name + (extra ? ' — ' + extra : ''));
  }
}

/* ---- пресеты: строятся и проходят валидацию без ошибок ---- */
RR.presets.list.forEach(function (p) {
  const proj = RR.presets.build(p.id);
  check('preset builds: ' + p.id, !!proj && proj.diagrams.length > 0);
  const issues = RR.validation.validateProject(proj);
  const errors = issues.filter(function (i) { return i.level === 'error'; });
  check('preset no errors: ' + p.id, errors.length === 0,
    errors.map(function (e) { return e.code + ': ' + e.message; }).join(' | '));
  if (p.id === 'expression') {
    check('expression has cycle warning',
      issues.some(function (i) { return i.code === 'DiagramCycle'; }));
  }
  const schemaErrs = RR.io.validateSchema(proj);
  check('preset schema valid: ' + p.id, schemaErrs.length === 0, schemaErrs.join(' | '));
});

/* ---- grammar import: EBNF / ABNF without view ---- */
const ebnfJson = JSON.stringify({
  version: '2.0.0',
  name: 'JSON subset',
  schema: {
    notation: 'ebnf',
    sourceLines: [
      'json ::= object | array',
      "object ::= '{' [ member { ',' member } ] '}'",
      "member ::= string ':' value",
      "array ::= '[' [ value { ',' value } ] ']'",
      "value ::= string | number | object | array | 'true' | 'false' | 'null'",
      'string ::= DQUOTE { characters } DQUOTE',
      'DQUOTE ::= %x22',
    ],
  },
});
const ebnfRes = RR.io.importProjectJson(ebnfJson);
check('ebnf schema import ok', ebnfRes.ok, ebnfRes.errors.join(' | '));
check('ebnf schema generated view', ebnfRes.ok && ebnfRes.project.diagrams.length === 7);
check('ebnf schema attached non-enumerable', ebnfRes.ok && ebnfRes.project.schema && JSON.stringify(ebnfRes.project).indexOf('"schema"') < 0);

const abnfJson = JSON.stringify({
  version: '2.0.0',
  name: 'HTTP basic rules',
  schema: {
    notation: 'abnf-rfc5234',
    sourceLines: [
      'ALPHA = UPALPHA / LOALPHA',
      'DIGIT = %x30-39',
      'token = 1*( ALPHA / DIGIT )',
    ],
  },
});
const abnfRes = RR.io.importProjectJson(abnfJson);
check('abnf schema import ok', abnfRes.ok, abnfRes.errors.join(' | '));
check('abnf schema generated view', abnfRes.ok && abnfRes.project.diagrams.length === 3);

const badNotation = RR.io.importProjectJson(JSON.stringify({
  version: '2.0.0',
  name: 'Bad',
  schema: { notation: 'unknown-grammar', sourceLines: ['x ::= y'] },
}));
check('unknown notation rejected', !badNotation.ok && badNotation.errors.some(function (e) { return e.indexOf('notation') >= 0; }));

/* ---- traversal API ---- */
const proj = RR.presets.build('natural');
const T = RR.traversal;
const nat = T.getDiagramByName(proj, 'NaturalNumber');
check('getDiagramByName', !!nat);
check('getDiagramById', T.getDiagramById(proj, nat.id) === nat);
const start = nat.nodes.find(function (n) { return n.kind === 'start'; });
const out = T.getOutgoingEdges(nat, start.id);
check('getOutgoingEdges from start', out.length === 1);
const next = T.getNextNodes(nat, start.id);
check('getNextNodes', next.length === 1 && next[0].kind === 'nonterminal');
const reach = T.getReachableNodes(nat, start.id);
check('getReachableNodes covers all flow nodes', reach.length === nat.nodes.length);
const refs = T.getReferencedDiagrams(proj, nat.id);
check('getReferencedDiagrams', refs.length === 2);
const reachD = T.getReachableDiagrams(proj, nat.id);
check('getReachableDiagrams', reachD.length === 2);
const end = nat.nodes.find(function (n) { return n.kind === 'end'; });
check('getIncomingEdges to end', T.getIncomingEdges(nat, end.id).length === 1);

/* ---- validation ловит ошибки ---- */
const broken = JSON.parse(JSON.stringify(proj));
const bd = broken.diagrams[0];
bd.nodes = bd.nodes.filter(function (n) { return n.kind !== 'end'; }); // убрали end
bd.nodes.find(function (n) { return n.kind === 'nonterminal'; }).targetDiagramId = 'diagram-nope';
bd.nodes.find(function (n) { return n.kind === 'nonterminal'; }).label = 'Unknown';
bd.edges.push({ id: 'edge-broken', fromNodeId: 'ghost', toNodeId: 'ghost2', fromAnchor: 'right', toAnchor: 'left', label: null, path: null });
broken.diagrams[1].name = broken.diagrams[2].name; // дубль имени
const bIssues = RR.validation.validateProject(broken);
const codes = new Set(bIssues.map(function (i) { return i.code; }));
['MissingEndNode', 'BrokenEdgeReference', 'BrokenTargetDiagramReference',
  'MissingDiagramForNonterminal', 'DuplicateDiagramName'].forEach(function (c) {
  check('validation detects ' + c, codes.has(c));
});

/* NoPathFromStartToEnd + UnreachableNode */
const iso = RR.model.createProject('iso');
iso.diagrams.push({
  id: 'd1', name: 'D1', type: 'syntax',
  nodes: [
    { id: 'n1', kind: 'start', label: 's', x: 0, y: 0, width: 60, height: 40, targetDiagramId: null, meta: {} },
    { id: 'n2', kind: 'end', label: 'e', x: 200, y: 0, width: 60, height: 40, targetDiagramId: null, meta: {} },
    { id: 'n3', kind: 'terminal', label: 't', x: 100, y: 100, width: 80, height: 40, targetDiagramId: null, meta: {} },
  ],
  edges: [],
  entryNodeId: 'n1', exitNodeId: 'n2', position: { x: 0, y: 0 }, size: { width: 100, height: 100 },
});
iso.activeDiagramId = 'd1';
const isoIssues = RR.validation.validateProject(iso);
const isoCodes = new Set(isoIssues.map(function (i) { return i.code; }));
check('validation detects NoPathFromStartToEnd', isoCodes.has('NoPathFromStartToEnd'));
check('validation detects UnreachableNode', isoCodes.has('UnreachableNode'));

/* дубли id */
const dup = JSON.parse(JSON.stringify(proj));
dup.diagrams[0].nodes[1].id = dup.diagrams[0].nodes[0].id;
check('validation detects DuplicateId',
  RR.validation.validateProject(dup).some(function (i) { return i.code === 'DuplicateId'; }));

/* ---- model CRUD + undo/redo ---- */
const M = RR.model;
M.state.project = RR.presets.build('sentence');
M.state.history = { undoStack: [], redoStack: [] };
const dCount = M.state.project.diagrams.length;
const d = M.createDiagram('Test');
check('createDiagram', M.state.project.diagrams.length === dCount + 1 && M.state.project.activeDiagramId === d.id);
const n1 = M.createNode(d.id, 'terminal', 'abc', 300, 226); // справа от start (80,230)
check('createNode', d.nodes.some(function (n) { return n.id === n1.id; }));
const startN = d.nodes.find(function (n) { return n.kind === 'start'; });
const e1 = M.createEdge(d.id, startN.id, n1.id);
check('createEdge auto anchors', e1.fromAnchor === 'right' && e1.toAnchor === 'left');
M.updateNode(n1.id, { label: 'xyz', x: 340 });
check('updateNode', n1.label === 'xyz' && n1.x === 340);
M.deleteNode(d.id, n1.id);
check('deleteNode removes edges', d.edges.indexOf(e1) < 0 && !d.nodes.some(function (n) { return n.id === n1.id; }));
check('undo works', M.undo() && d.nodes.length >= 0);
const dAfter = M.getDiagram(d.id);
check('undo restored node', dAfter.nodes.some(function (n) { return n.id === n1.id; }));
check('redo works', M.redo());
check('redo re-deleted node', !M.getDiagram(d.id).nodes.some(function (n) { return n.id === n1.id; }));

const dSplit = M.createDiagram('Anchor Split');
const sSplit = dSplit.nodes.find(function (n) { return n.kind === 'start'; });
const eSplit = dSplit.nodes.find(function (n) { return n.kind === 'end'; });
const splitEdge = M.createEdge(dSplit.id, sSplit.id, eSplit.id);
const anchor = M.createAnchorOnEdge(splitEdge.id, 300, 250);
check('createAnchorOnEdge creates anchor node', anchor && anchor.kind === 'anchor' && dSplit.nodes.some(function (n) { return n.id === anchor.id; }));
check('createAnchorOnEdge splits edge', dSplit.edges.length === 2 &&
  dSplit.edges.some(function (e) { return e.fromNodeId === sSplit.id && e.toNodeId === anchor.id; }) &&
  dSplit.edges.some(function (e) { return e.fromNodeId === anchor.id && e.toNodeId === eSplit.id; }));
const oldPos = RR.util.clone(dSplit.position);
M.setDiagramPosition(dSplit.id, 123, 456);
check('setDiagramPosition stores manual layout', M.getDiagram(dSplit.id).position.x === 123 && M.getDiagram(dSplit.id).layoutManual === true);
check('setDiagramPosition undo', M.undo() && M.getDiagram(dSplit.id).position.x === oldPos.x);
check('setDiagramPosition redo', M.redo() && M.getDiagram(dSplit.id).position.x === 123);

/* snap to grid */
M.state.snapToGrid = true;
const n2 = M.createNode(d.id, 'terminal', 't', 103, 107);
check('snapToGrid on create', n2.x % 20 === 0 && n2.y % 20 === 0);
M.state.snapToGrid = false;

/* deleteDiagram: активная переключается */
M.deleteDiagram(d.id);
check('deleteDiagram switches active', M.state.project.activeDiagramId !== d.id && !M.getDiagram(d.id));

/* duplicateNode */
const act = M.getActiveDiagram();
const someNode = act.nodes[0];
const copy = M.duplicateNode(act.id, someNode.id);
check('duplicateNode', !!copy && copy.id !== someNode.id && copy.label === someNode.label);

/* ---- io: JSON roundtrip ---- */
const json = RR.io.exportProjectJson(M.state.project);
const exportedObj = JSON.parse(json);
check('json export v2', exportedObj.version === '2.0.0' && exportedObj.schema && exportedObj.view);
check('json export sourceLines', Array.isArray(exportedObj.schema.sourceLines) && typeof exportedObj.schema.source !== 'string');
const res = RR.io.importProjectJson(json);
check('json roundtrip ok', res.ok, res.errors.join(' | '));
check('json roundtrip diagrams', res.project.diagrams.length === M.state.project.diagrams.length);
check('json roundtrip active', res.project.activeDiagramId === M.state.project.activeDiagramId);

/* io: повреждённая структура отклоняется */
const bad = RR.io.importProjectJson('{"diagrams":[{"id":1,"nodes":"x","edges":[]}]}');
check('bad json rejected', !bad.ok && bad.errors.length > 0);
const notJson = RR.io.importProjectJson('hello');
check('non-json rejected', !notJson.ok);

/* io: извлечение из standalone HTML */
const embedded = '<!doctype html><html><body><script type="application/json" id="rr-project-data">' +
  json.replace(/</g, '\\u003c') + '</scr' + 'ipt></body></html>';
const src = embedded;
const m = src.match(new RegExp('<script[^>]*id="rr-project-data"[^>]*>([\\s\\S]*?)<\\/script>', 'i'));
check('html embed extract', !!m && RR.io.importProjectJson(m[1].trim()).ok);

/* geo */
const g = RR.geo;
const na = { x: 0, y: 0, width: 100, height: 50 };
const nb = { x: 300, y: 0, width: 100, height: 50 };
check('anchor point', g.getAnchorPoint(na, 'right').x === 100 && g.getAnchorPoint(na, 'right').y === 25);
check('auto anchors horizontal', g.autoAnchors(na, nb).join(',') === 'right,left');
const geom = g.computeEdgeGeometry(na, nb, 'right', 'left');
check('edge path format', /^M 100 25 C .+ 300 25$/.test(geom.d), geom.d);

console.log(failures ? '\n' + failures + ' FAILURES' : '\nAll smoke tests passed.');
process.exit(failures ? 1 : 0);
