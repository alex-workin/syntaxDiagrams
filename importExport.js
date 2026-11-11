/* Railroad Editor — Import/Export Layer
 * .rrjson, SVG, PNG, HTML с embedded SVG, standalone HTML с embedded JSON;
 * импорт из файла/текста/standalone HTML, проверка схемы.
 */
(function () {
  'use strict';
  const RR = window.RR;
  const IO = (RR.io = {});

  const EMBED_ID = 'rr-project-data';
  const FORMAT_VERSION = '2.0.0';

  /* ---------------- schema ---------------- */
  const ANCHORS = ['left', 'right', 'top', 'bottom'];

  function errInto(errors) {
    return function (msg) { errors.push(msg); };
  }

  function objectValues(obj) {
    if (Array.isArray(obj)) return obj;
    const out = [];
    if (!obj || typeof obj !== 'object') return out;
    Object.keys(obj).forEach(function (k) { out.push(obj[k]); });
    return out;
  }

  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function attachSchema(project, schema) {
    if (!project || !schema) return project;
    Object.defineProperty(project, 'schema', {
      value: schema,
      writable: true,
      configurable: true,
      enumerable: false,
    });
    return project;
  }

  function sourceLinesOf(schema) {
    if (!schema || typeof schema !== 'object') return [];
    if (Array.isArray(schema.sourceLines)) {
      return schema.sourceLines.map(function (line) { return String(line); });
    }
    if (typeof schema.source === 'string') return schema.source.split(/\r?\n/);
    return [];
  }

  function sourceTextOf(schema) {
    return sourceLinesOf(schema).join('\n');
  }

  function safeRuleName(name) {
    const s = String(name || 'rule').trim().replace(/\s+/g, '-').replace(/[^\wа-яА-ЯёЁ-]+/g, '-');
    return s.replace(/^-+|-+$/g, '') || 'rule';
  }

  function uniqueName(base, used) {
    let name = safeRuleName(base), i = 2;
    while (used[name]) {
      name = safeRuleName(base) + '-' + i;
      i++;
    }
    used[name] = true;
    return name;
  }

  function normalizeExpr(expr) {
    if (!expr) return { type: 'empty' };
    if (expr.type === 'sequence') {
      expr.items = (expr.items || []).filter(Boolean);
      if (!expr.items.length) return { type: 'empty' };
      if (expr.items.length === 1) return expr.items[0];
    }
    if (expr.type === 'choice') {
      expr.options = (expr.options || []).filter(Boolean);
      if (!expr.options.length) return { type: 'empty' };
      if (expr.options.length === 1) return expr.options[0];
    }
    return expr;
  }

  function assignExprIds(expr, prefix) {
    expr = normalizeExpr(expr);
    expr.id = expr.id || prefix;
    if (expr.type === 'sequence') {
      expr.items.forEach(function (it, i) { assignExprIds(it, prefix + '-seq-' + i); });
    } else if (expr.type === 'choice') {
      expr.options.forEach(function (it, i) { assignExprIds(it, prefix + '-alt-' + i); });
    } else if (expr.type === 'repeat' || expr.type === 'optional' || expr.type === 'group') {
      if (expr.expr) assignExprIds(expr.expr, prefix + '-item');
    }
    return expr;
  }

  function stripAbnfComment(line) {
    let quote = null;
    for (let i = 0; i < line.length; i++) {
      const ch = line.charAt(i);
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ';') {
        return line.slice(0, i);
      }
    }
    return line;
  }

  function cleanRuleName(name) {
    name = String(name || '').trim();
    if (name.charAt(0) === '<' && name.charAt(name.length - 1) === '>') {
      return name.slice(1, -1).trim();
    }
    return name;
  }

  function collectGrammarRules(source, notation) {
    const rules = [];
    const lines = String(source || '').split(/\r?\n/);
    let cur = null;
    function flush() {
      if (cur && cur.name) rules.push(cur);
      cur = null;
    }
    lines.forEach(function (raw) {
      let line = notation === 'abnf-rfc5234' ? stripAbnfComment(raw) : raw;
      if (!line.trim()) { flush(); return; }
      const m = notation === 'ebnf'
        ? line.match(/^\s*(.+?)\s*::=\s*(.*)$/)
        : line.match(/^\s*(.+?)\s*(=\/|=)\s*(.*)$/);
      if (m && !/^\s/.test(raw)) {
        flush();
        cur = { name: cleanRuleName(m[1]), expr: m[notation === 'ebnf' ? 2 : 3] || '' };
      } else if (cur) {
        cur.expr += ' ' + line.trim();
      }
    });
    flush();
    return rules;
  }

  function TokenStream(input, notation) {
    this.s = String(input || '');
    this.i = 0;
    this.notation = notation;
    this.buf = null;
  }
  TokenStream.prototype.skipWs = function () {
    while (this.i < this.s.length && /\s/.test(this.s.charAt(this.i))) this.i++;
  };
  TokenStream.prototype.read = function () {
    this.skipWs();
    if (this.i >= this.s.length) return { type: 'eof' };
    const s = this.s, ch = s.charAt(this.i);
    if (ch === '"' || ch === "'") {
      const q = ch;
      let out = '';
      this.i++;
      while (this.i < s.length) {
        const c = s.charAt(this.i++);
        if (c === '\\' && this.i < s.length) {
          out += s.charAt(this.i++);
        } else if (c === q) {
          break;
        } else {
          out += c;
        }
      }
      return { type: 'string', value: out };
    }
    if (ch === '<') {
      const end = s.indexOf('>', this.i + 1);
      if (end >= 0) {
        const val = s.slice(this.i + 1, end).trim();
        this.i = end + 1;
        return { type: 'prose', value: val };
      }
    }
    if (ch === '%' && /[xbd]/i.test(s.charAt(this.i + 1))) {
      let j = this.i + 2;
      while (j < s.length && /[0-9A-Fa-f.\-]+/.test(s.charAt(j))) j++;
      const val = s.slice(this.i, j);
      this.i = j;
      return { type: 'num', value: val };
    }
    if (/[0-9]/.test(ch)) {
      let j = this.i + 1;
      while (j < s.length && /[0-9]/.test(s.charAt(j))) j++;
      const val = s.slice(this.i, j);
      this.i = j;
      return { type: 'number', value: val };
    }
    if (/[A-Za-z_А-Яа-яЁё]/.test(ch)) {
      let j = this.i + 1;
      while (j < s.length && /[\wА-Яа-яЁё-]/.test(s.charAt(j))) j++;
      const val = s.slice(this.i, j);
      this.i = j;
      return { type: 'ident', value: val };
    }
    this.i++;
    return { type: ch, value: ch };
  };
  TokenStream.prototype.peek = function () {
    if (!this.buf) this.buf = this.read();
    return this.buf;
  };
  TokenStream.prototype.next = function () {
    const t = this.peek();
    this.buf = null;
    return t;
  };
  TokenStream.prototype.accept = function (type) {
    if (this.peek().type === type) { this.next(); return true; }
    return false;
  };

  function parseExpression(input, notation) {
    const ts = new TokenStream(input, notation);
    return parseChoice(ts, []);
  }

  function parseChoice(ts, stops) {
    const options = [parseSequence(ts, stops.concat(['|', '/']))];
    while (ts.peek().type === '|' || ts.peek().type === '/') {
      ts.next();
      options.push(parseSequence(ts, stops.concat(['|', '/'])));
    }
    return normalizeExpr(options.length === 1 ? options[0] : { type: 'choice', options: options });
  }

  function parseSequence(ts, stops) {
    const items = [];
    while (true) {
      const t = ts.peek();
      if (t.type === 'eof' || stops.indexOf(t.type) >= 0 || t.type === ')' || t.type === ']' || t.type === '}') break;
      items.push(parseTerm(ts));
    }
    return normalizeExpr(items.length === 1 ? items[0] : { type: 'sequence', items: items });
  }

  function parseTerm(ts) {
    if (ts.notation === 'abnf-rfc5234') {
      let min = null, max = null, hasRep = false;
      if (ts.peek().type === 'number') {
        const n = parseInt(ts.next().value, 10);
        if (ts.peek().type === '*') {
          ts.next();
          min = n;
          hasRep = true;
          if (ts.peek().type === 'number') max = parseInt(ts.next().value, 10);
        } else {
          min = n; max = n; hasRep = true;
        }
      } else if (ts.peek().type === '*') {
        ts.next();
        min = 0;
        hasRep = true;
        if (ts.peek().type === 'number') max = parseInt(ts.next().value, 10);
      }
      const p = parsePrimary(ts);
      return hasRep ? { type: 'repeat', min: min == null ? 0 : min, max: max == null ? null : max, expr: p } : p;
    }
    return parsePrimary(ts);
  }

  function parsePrimary(ts) {
    const t = ts.next();
    if (t.type === '(') {
      const e = parseChoice(ts, [')']);
      ts.accept(')');
      return e;
    }
    if (t.type === '[') {
      const e = parseChoice(ts, [']']);
      ts.accept(']');
      return { type: 'optional', expr: e };
    }
    if (t.type === '{') {
      const e = parseChoice(ts, ['}']);
      ts.accept('}');
      return { type: 'repeat', min: 0, max: null, expr: e };
    }
    if (t.type === 'string') return { type: 'terminal', value: t.value };
    if (t.type === 'num') return { type: 'terminal', value: t.value, numeric: true };
    if (t.type === 'prose') return { type: 'prose', value: t.value };
    if (t.type === 'ident') return { type: 'ref', name: t.value };
    return { type: 'terminal', value: t.value || '' };
  }

  function parseGrammar(schema) {
    const notation = schema && schema.notation;
    if (!IO.grammarParsers[notation]) return { ok: false, errors: ['Неизвестная notation: ' + notation], rules: {} };
    return IO.grammarParsers[notation](sourceTextOf(schema));
  }

  function parseGenericGrammar(source, notation) {
    const errors = [];
    const rules = {};
    const order = [];
    const rows = collectGrammarRules(source, notation);
    if (!rows.length) errors.push('Грамматика не содержит правил.');
    rows.forEach(function (r) {
      if (!r.name) { errors.push('Правило без имени.'); return; }
      try {
        const name = safeRuleName(r.name);
        let base = name, i = 2;
        while (rules[name]) { name = base + '-' + i; i++; }
        const expr = assignExprIds(parseExpression(r.expr, notation), 'expr-' + name);
        rules[name] = { id: name, name: r.name, expr: expr };
        order.push(name);
      } catch (e) {
        errors.push('Правило «' + r.name + '»: ' + e.message);
      }
    });
    return { ok: !errors.length, errors: errors, rules: rules, order: order };
  }

  IO.grammarParsers = {
    ebnf: function (source) { return parseGenericGrammar(source, 'ebnf'); },
    'abnf-rfc5234': function (source) { return parseGenericGrammar(source, 'abnf-rfc5234'); },
  };

  IO.validateSchema = function (data) {
    const errors = [];
    const err = errInto(errors);
    if (!data || typeof data !== 'object') { err('Корень не является объектом.'); return errors; }
    if (data.schema && typeof data.schema === 'object') {
      const s = data.schema;
      if (typeof s.notation !== 'string' || !s.notation) err('schema.notation обязателен.');
      if (!Array.isArray(s.sourceLines) && typeof s.source !== 'string') err('schema.sourceLines или schema.source обязателен.');
      if (Array.isArray(s.sourceLines) && s.sourceLines.some(function (x) { return typeof x !== 'string'; })) {
        err('schema.sourceLines должен быть массивом строк.');
      }
      if (s.notation && !IO.grammarParsers[s.notation]) err('Неизвестная notation: ' + s.notation);
      if (!errors.length) {
        const parsed = parseGrammar(s);
        if (!parsed.ok) parsed.errors.forEach(err);
      }
      return errors;
    }
    if (!Array.isArray(data.diagrams)) { err('Отсутствует массив diagrams.'); return errors; }
    data.diagrams.forEach(function (d, i) {
      const where = 'diagrams[' + i + ']';
      if (!d || typeof d !== 'object') { err(where + ': не объект.'); return; }
      if (typeof d.id !== 'string' || !d.id) err(where + ': нет id.');
      if (typeof d.name !== 'string') err(where + ': нет name.');
      if (!Array.isArray(d.nodes)) { err(where + ': nodes не массив.'); return; }
      if (!Array.isArray(d.edges)) { err(where + ': edges не массив.'); return; }
      d.nodes.forEach(function (n, j) {
        const nw = where + '.nodes[' + j + ']';
        if (!n || typeof n !== 'object') { err(nw + ': не объект.'); return; }
        if (typeof n.id !== 'string' || !n.id) err(nw + ': нет id.');
        if (RR.NODE_KINDS.indexOf(n.kind) < 0) err(nw + ': недопустимый kind «' + n.kind + '».');
        if (typeof n.x !== 'number' || typeof n.y !== 'number') err(nw + ': x/y не числа.');
        if (typeof n.width !== 'number' || typeof n.height !== 'number') err(nw + ': width/height не числа.');
      });
      d.edges.forEach(function (e, j) {
        const ew = where + '.edges[' + j + ']';
        if (!e || typeof e !== 'object') { err(ew + ': не объект.'); return; }
        if (typeof e.id !== 'string' || !e.id) err(ew + ': нет id.');
        if (typeof e.fromNodeId !== 'string') err(ew + ': нет fromNodeId.');
        if (typeof e.toNodeId !== 'string') err(ew + ': нет toNodeId.');
      });
    });
    return errors;
  };

  IO.normalizeProject = function (data) {
    if (data && data.schema && typeof data.schema === 'object') return normalizeSchemaProject(data);
    return normalizeRuntimeProject(data);
  };

  function normalizeRuntimeProject(data) {
    const p = {
      version: typeof data.version === 'string' ? data.version : '1.0.0',
      name: typeof data.name === 'string' && data.name ? data.name : 'Без названия',
      diagrams: [],
      activeDiagramId: null,
      viewport: { x: 0, y: 0, zoom: 1 },
    };
    if (data.viewport && typeof data.viewport === 'object') {
      p.viewport.x = Number(data.viewport.x) || 0;
      p.viewport.y = Number(data.viewport.y) || 0;
      p.viewport.zoom = RR.util.clamp(Number(data.viewport.zoom) || 1, 0.1, 4);
    }
    data.diagrams.forEach(function (d) {
      const nd = {
        id: d.id,
        name: d.name || d.id,
        type: 'syntax',
        nodes: [],
        edges: [],
        entryNodeId: typeof d.entryNodeId === 'string' ? d.entryNodeId : null,
        exitNodeId: typeof d.exitNodeId === 'string' ? d.exitNodeId : null,
        position: {
          x: d.position && Number(d.position.x) || 0,
          y: d.position && Number(d.position.y) || 0,
        },
        size: {
          width: d.size && Number(d.size.width) || 1200,
          height: d.size && Number(d.size.height) || 600,
        },
      };
      if (Object.prototype.hasOwnProperty.call(d, 'layoutManual')) {
        nd.layoutManual = d.layoutManual === true;
      } else if (d.position && (Number(d.position.x) || Number(d.position.y))) {
        nd.layoutManual = true;
      }
      d.nodes.forEach(function (n) {
        nd.nodes.push({
          id: n.id,
          kind: n.kind,
          label: typeof n.label === 'string' ? n.label : '',
          x: Number(n.x) || 0,
          y: Number(n.y) || 0,
          width: Number(n.width) || RR.NODE_DEFAULTS[n.kind].width,
          height: Number(n.height) || RR.NODE_DEFAULTS[n.kind].height,
          targetDiagramId: typeof n.targetDiagramId === 'string' ? n.targetDiagramId : null,
          meta: n.meta && typeof n.meta === 'object' ? n.meta : {},
        });
      });
      d.edges.forEach(function (e) {
        nd.edges.push({
          id: e.id,
          fromNodeId: e.fromNodeId,
          toNodeId: e.toNodeId,
          fromAnchor: ANCHORS.indexOf(e.fromAnchor) >= 0 ? e.fromAnchor : 'right',
          toAnchor: ANCHORS.indexOf(e.toAnchor) >= 0 ? e.toAnchor : 'left',
          label: typeof e.label === 'string' ? e.label : null,
          path: null,
        });
      });
      p.diagrams.push(nd);
    });
    const active = typeof data.activeDiagramId === 'string' ? data.activeDiagramId : null;
    p.activeDiagramId = p.diagrams.some(function (d) { return d.id === active; })
      ? active
      : (p.diagrams.length ? p.diagrams[0].id : null);
    return p;
  }

  function normalizedSchema(data) {
    const parsed = parseGrammar(data.schema);
    const schema = {
      notation: data.schema.notation,
      sourceLines: sourceLinesOf(data.schema),
      rules: parsed.rules || {},
      startRuleId: data.schema.startRuleId || (parsed.order && parsed.order[0]) || null,
    };
    return schema;
  }

  function normalizeSchemaProject(data) {
    const schema = normalizedSchema(data);
    const view = data.view && typeof data.view === 'object' ? data.view : null;
    const p = view && view.diagrams ? projectFromView(data, schema) : projectFromSchema(data, schema);
    attachSchema(p, schema);
    return p;
  }

  function projectFromView(data, schema) {
    const view = data.view || {};
    const p = {
      version: FORMAT_VERSION,
      name: typeof data.name === 'string' && data.name ? data.name : 'Без названия',
      diagrams: [],
      activeDiagramId: typeof view.activeDiagramId === 'string' ? view.activeDiagramId : null,
      viewport: {
        x: view.viewport && Number(view.viewport.x) || 0,
        y: view.viewport && Number(view.viewport.y) || 0,
        zoom: view.viewport && RR.util.clamp(Number(view.viewport.zoom) || 1, 0.1, 4) || 1,
      },
    };
    const diagrams = objectValues(view.diagrams);
    diagrams.forEach(function (vd) {
      const rule = schema.rules[vd.ruleId] || schema.rules[safeRuleName(vd.name || vd.id)] || null;
      const d = {
        id: vd.id || RR.util.uid('diagram'),
        name: vd.name || (rule ? rule.name : vd.ruleId) || 'Diagram',
        type: 'syntax',
        nodes: [],
        edges: [],
        entryNodeId: vd.entryNodeId || null,
        exitNodeId: vd.exitNodeId || null,
        position: { x: vd.position && Number(vd.position.x) || 0, y: vd.position && Number(vd.position.y) || 0 },
        size: { width: vd.size && Number(vd.size.width) || 1200, height: vd.size && Number(vd.size.height) || 600 },
      };
      if (Object.prototype.hasOwnProperty.call(vd, 'layoutManual')) d.layoutManual = vd.layoutManual === true;
      objectValues(vd.nodes).forEach(function (n) {
        const kind = RR.NODE_KINDS.indexOf(n.kind) >= 0 ? n.kind : 'terminal';
        d.nodes.push({
          id: n.id || RR.util.uid('node'),
          kind: kind,
          label: typeof n.label === 'string' ? n.label : '',
          x: Number(n.x) || 0,
          y: Number(n.y) || 0,
          width: Number(n.width) || RR.NODE_DEFAULTS[kind].width,
          height: Number(n.height) || RR.NODE_DEFAULTS[kind].height,
          targetDiagramId: typeof n.targetDiagramId === 'string' ? n.targetDiagramId : null,
          meta: n.meta && typeof n.meta === 'object' ? n.meta : {},
        });
      });
      objectValues(vd.edges).forEach(function (e) {
        d.edges.push({
          id: e.id || RR.util.uid('edge'),
          fromNodeId: e.fromNodeId,
          toNodeId: e.toNodeId,
          fromAnchor: ANCHORS.indexOf(e.fromAnchor) >= 0 ? e.fromAnchor : 'right',
          toAnchor: ANCHORS.indexOf(e.toAnchor) >= 0 ? e.toAnchor : 'left',
          label: typeof e.label === 'string' ? e.label : null,
          path: null,
        });
      });
      p.diagrams.push(d);
    });
    if (!p.diagrams.length) return projectFromSchema(data, schema);
    if (!p.diagrams.some(function (d) { return d.id === p.activeDiagramId; })) p.activeDiagramId = p.diagrams[0].id;
    return p;
  }

  function projectFromSchema(data, schema) {
    const p = {
      version: FORMAT_VERSION,
      name: typeof data.name === 'string' && data.name ? data.name : 'Без названия',
      diagrams: [],
      activeDiagramId: null,
      viewport: { x: 0, y: 0, zoom: 1 },
    };
    const ruleIds = Object.keys(schema.rules);
    const diagramByRule = {};
    ruleIds.forEach(function (id, idx) {
      const rule = schema.rules[id];
      const d = buildDiagramForRule(rule, idx);
      diagramByRule[id] = d.id;
      p.diagrams.push(d);
    });
    p.diagrams.forEach(function (d) {
      d.nodes.forEach(function (n) {
        if (n.kind === 'nonterminal' && n.meta && n.meta.ruleRef) {
          const rid = safeRuleName(n.meta.ruleRef);
          if (diagramByRule[rid]) n.targetDiagramId = diagramByRule[rid];
        }
      });
    });
    p.activeDiagramId = p.diagrams.length ? p.diagrams[0].id : null;
    return p;
  }

  function exprLabel(expr) {
    expr = normalizeExpr(expr);
    if (expr.type === 'terminal') return expr.value;
    if (expr.type === 'prose') return '<' + expr.value + '>';
    if (expr.type === 'ref') return expr.name;
    if (expr.type === 'optional') return '[' + exprLabel(expr.expr) + ']';
    if (expr.type === 'repeat') return '{' + exprLabel(expr.expr) + '}';
    if (expr.type === 'choice') return expr.options.map(exprLabel).join(' | ');
    if (expr.type === 'sequence') return expr.items.map(exprLabel).join(' ');
    return '';
  }

  function visualItems(expr) {
    expr = normalizeExpr(expr);
    if (expr.type === 'sequence') {
      let out = [];
      expr.items.forEach(function (it) { out = out.concat(visualItems(it)); });
      return out;
    }
    return [expr];
  }

  function nodeForExpr(expr, x, y) {
    const defTerminal = RR.NODE_DEFAULTS.terminal;
    let kind = 'terminal', label = exprLabel(expr), meta = { schemaElementId: expr.id || null };
    if (expr.type === 'ref') {
      kind = 'nonterminal';
      meta.ruleRef = expr.name;
    } else if (expr.type === 'choice') kind = 'choice';
    else if (expr.type === 'optional') kind = 'optional';
    else if (expr.type === 'repeat') kind = 'repeat';
    else if (expr.type === 'prose') kind = 'comment';
    const def = RR.NODE_DEFAULTS[kind] || defTerminal;
    const width = Math.max(def.width, Math.min(260, 40 + String(label).length * 8));
    return {
      id: RR.util.uid('node'),
      kind: kind,
      label: label,
      x: x,
      y: y,
      width: width,
      height: def.height,
      targetDiagramId: null,
      meta: meta,
    };
  }

  function buildDiagramForRule(rule, idx) {
    const d = {
      id: 'diagram-' + safeRuleName(rule.id || rule.name),
      name: rule.name,
      type: 'syntax',
      nodes: [],
      edges: [],
      entryNodeId: null,
      exitNodeId: null,
      position: { x: 0, y: 0 },
      size: { width: 1200, height: 600 },
      layoutManual: false,
    };
    const start = {
      id: RR.util.uid('node'), kind: 'start', label: 'start',
      x: 80, y: 230, width: RR.NODE_DEFAULTS.start.width, height: RR.NODE_DEFAULTS.start.height,
      targetDiagramId: null, meta: {},
    };
    d.nodes.push(start);
    d.entryNodeId = start.id;
    let prev = start;
    let x = 210;
    visualItems(rule.expr).forEach(function (expr) {
      const n = nodeForExpr(expr, x, 224);
      d.nodes.push(n);
      d.edges.push(makeEdge(prev, n));
      prev = n;
      x += n.width + 70;
    });
    const end = {
      id: RR.util.uid('node'), kind: 'end', label: 'end',
      x: x, y: 230, width: RR.NODE_DEFAULTS.end.width, height: RR.NODE_DEFAULTS.end.height,
      targetDiagramId: null, meta: {},
    };
    d.nodes.push(end);
    d.exitNodeId = end.id;
    d.edges.push(makeEdge(prev, end));
    d.position = { x: (idx % 3) * 760, y: Math.floor(idx / 3) * 430 };
    d.size = { width: Math.max(520, x + 180), height: 320 };
    return d;
  }

  function makeEdge(from, to) {
    const anchors = RR.geo.autoAnchors(from, to);
    return {
      id: RR.util.uid('edge'),
      fromNodeId: from.id,
      toNodeId: to.id,
      fromAnchor: anchors[0],
      toAnchor: anchors[1],
      label: null,
      path: null,
    };
  }

  /* ---------------- JSON export/import ---------------- */
  IO.exportProjectObject = function (project) {
    const schema = schemaFromProject(project);
    return {
      version: FORMAT_VERSION,
      name: project && project.name || 'Без названия',
      schema: schema,
      view: viewFromProject(project),
    };
  };

  IO.exportProjectJson = function (project) {
    return JSON.stringify(IO.exportProjectObject(project), null, 2);
  };

  IO.importProjectJson = function (text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return { ok: false, errors: ['Не удалось разобрать JSON: ' + e.message], project: null };
    }
    const errors = IO.validateSchema(data);
    if (errors.length) return { ok: false, errors: errors, project: null };
    return { ok: true, errors: [], project: IO.normalizeProject(data) };
  };

  function schemaFromProject(project) {
    if (project && project.schema && project.schema.notation) {
      const schema = {
        notation: project.schema.notation,
        sourceLines: sourceLinesOf(project.schema),
      };
      const parsed = parseGrammar(schema);
      schema.rules = parsed.rules || project.schema.rules || {};
      schema.startRuleId = project.schema.startRuleId || (parsed.order && parsed.order[0]) || null;
      return schema;
    }
    const lines = projectToEbnfLines(project);
    const schema = { notation: 'ebnf', sourceLines: lines };
    const parsed = parseGrammar(schema);
    schema.rules = parsed.rules || {};
    schema.startRuleId = parsed.order && parsed.order[0] || null;
    return schema;
  }

  function quoteLiteral(s) {
    s = String(s == null ? '' : s);
    if (s.indexOf("'") < 0) return "'" + s + "'";
    if (s.indexOf('"') < 0) return '"' + s + '"';
    return '%x' + Array.prototype.map.call(s, function (ch) {
      return ch.charCodeAt(0).toString(16).toUpperCase();
    }).join('.');
  }

  function nodeGrammarLabel(node, project) {
    if (!node || node.kind === 'start' || node.kind === 'end' || node.kind === 'anchor' || node.kind === 'group') return '';
    if (node.kind === 'terminal') return quoteLiteral(node.label);
    if (node.kind === 'nonterminal') {
      const d = node.targetDiagramId && project.diagrams.find(function (x) { return x.id === node.targetDiagramId; });
      return safeRuleName(d ? d.name : node.label);
    }
    return safeRuleName(node.label || node.kind);
  }

  function diagramToEbnfExpr(diagram, project) {
    const start = diagram.nodes.find(function (n) { return n.id === diagram.entryNodeId; }) ||
      diagram.nodes.find(function (n) { return n.kind === 'start'; });
    const endId = diagram.exitNodeId || (diagram.nodes.find(function (n) { return n.kind === 'end'; }) || {}).id;
    if (!start || !endId) return "''";
    const byId = {};
    diagram.nodes.forEach(function (n) { byId[n.id] = n; });
    function dfs(nodeId, seen, depth) {
      if (nodeId === endId) return [''];
      if (depth > diagram.nodes.length + 4) return [''];
      const out = diagram.edges.filter(function (e) { return e.fromNodeId === nodeId; });
      let paths = [];
      out.forEach(function (e) {
        const n = byId[e.toNodeId];
        if (!n) return;
        const part = nodeGrammarLabel(n, project);
        if (seen[e.toNodeId]) {
          paths.push(part ? '{ ' + part + ' }' : '');
          return;
        }
        const nextSeen = Object.assign({}, seen);
        nextSeen[e.toNodeId] = true;
        dfs(e.toNodeId, nextSeen, depth + 1).forEach(function (tail) {
          paths.push([part, tail].filter(Boolean).join(' '));
        });
      });
      return paths.length ? paths : [''];
    }
    const paths = dfs(start.id, {}, 0).filter(function (x, i, a) { return a.indexOf(x) === i; });
    return paths.length ? paths.join(' | ') : "''";
  }

  function projectToEbnfLines(project) {
    const used = {};
    const lines = [];
    (project.diagrams || []).forEach(function (d) {
      const name = uniqueName(d.name, used);
      lines.push(name + ' ::= ' + diagramToEbnfExpr(d, project));
      lines.push('');
    });
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  function viewFromProject(project) {
    const view = {
      activeDiagramId: project.activeDiagramId || null,
      viewport: clone(project.viewport || { x: 0, y: 0, zoom: 1 }),
      diagrams: {},
    };
    (project.diagrams || []).forEach(function (d) {
      const vd = {
        id: d.id,
        name: d.name,
        ruleId: safeRuleName(d.name),
        entryNodeId: d.entryNodeId || null,
        exitNodeId: d.exitNodeId || null,
        position: clone(d.position || { x: 0, y: 0 }),
        size: clone(d.size || { width: 1200, height: 600 }),
        layoutManual: d.layoutManual === true,
        nodes: {},
        edges: {},
      };
      d.nodes.forEach(function (n) {
        vd.nodes[n.id] = {
          id: n.id,
          schemaElementId: n.meta && n.meta.schemaElementId || null,
          kind: n.kind,
          label: n.label,
          x: n.x,
          y: n.y,
          width: n.width,
          height: n.height,
          targetDiagramId: n.targetDiagramId || null,
          meta: clone(n.meta || {}),
        };
      });
      d.edges.forEach(function (e) {
        vd.edges[e.id] = {
          id: e.id,
          fromNodeId: e.fromNodeId,
          toNodeId: e.toNodeId,
          fromAnchor: e.fromAnchor,
          toAnchor: e.toAnchor,
          label: e.label || null,
        };
      });
      view.diagrams[d.id] = vd;
    });
    return view;
  }

  /* Импорт из произвольного текста: JSON или standalone HTML с embedded JSON */
  IO.importFromText = function (text) {
    let src = String(text || '').trim();
    if (!src) return { ok: false, errors: ['Пустой ввод.'] };
    if (src.charAt(0) === '<') {
      const m = src.match(new RegExp('<script[^>]*id="' + EMBED_ID + '"[^>]*>([\\s\\S]*?)<\\/script>', 'i'));
      if (!m) return { ok: false, errors: ['В HTML не найден встроенный проект (script#' + EMBED_ID + ').'] };
      src = m[1].trim();
    }
    const res = IO.importProjectJson(src);
    if (!res.ok) return res;
    RR.model.setProject(res.project, { reason: 'import' });
    return { ok: true, errors: [] };
  };

  IO.readFile = function (file) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result)); };
      reader.onerror = function () { reject(reader.error); };
      reader.readAsText(file);
    });
  };

  /* ---------------- download helpers ---------------- */
  function download(filename, mime, content) {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  }

  function safeName(s) {
    return String(s || 'project').replace(/[^\wа-яА-ЯёЁ. -]+/g, '_').slice(0, 60) || 'project';
  }

  IO.downloadRRJSON = function () {
    const p = RR.model.state.project;
    download(safeName(p.name) + '.rrjson', 'application/json', IO.exportProjectJson(p));
  };

  IO.downloadSVG = function () {
    const d = RR.model.getActiveDiagram();
    if (!d) return;
    download(safeName(d.name) + '.svg', 'image/svg+xml', RR.renderer.svgString(d));
  };

  IO.downloadPNG = function () {
    const d = RR.model.getActiveDiagram();
    if (!d) return Promise.resolve(false);
    const built = RR.renderer.buildStaticSvg(d);
    const str = new XMLSerializer().serializeToString(built.svg);
    const scale = 2;
    return new Promise(function (resolve, reject) {
      const img = new Image();
      const url = URL.createObjectURL(new Blob([str], { type: 'image/svg+xml' }));
      img.onload = function () {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = built.width * scale;
          canvas.height = built.height * scale;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#fdfdfc';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          URL.revokeObjectURL(url);
          canvas.toBlob(function (blob) {
            if (!blob) { reject(new Error('PNG encode failed')); return; }
            download(safeName(d.name) + '.png', 'image/png', blob);
            resolve(true);
          }, 'image/png');
        } catch (err) {
          URL.revokeObjectURL(url);
          reject(err);
        }
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('Не удалось растеризовать SVG.'));
      };
      img.src = url;
    });
  };

  /* ---------------- HTML exports ---------------- */
  const VIEW_CSS = [
    'body{margin:0;padding:24px;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f4f4f2;color:#2a2f3c}',
    'h1{font-size:22px;margin:0 0 4px}',
    'h2{font-size:16px;margin:28px 0 8px}',
    'p.note{color:#6b7186;font-size:13px;margin:0 0 20px}',
    'section{background:#fff;border:1px solid #e3e3df;border-radius:12px;padding:16px;margin-bottom:20px;overflow-x:auto}',
    'svg{max-width:100%;height:auto;display:block}',
  ].join('\n');

  function htmlDoc(title, bodyHtml) {
    return '<!doctype html>\n<html lang="ru">\n<head>\n<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
      '<title>' + RR.util.escapeHtml(title) + '</title>\n' +
      '<style>\n' + VIEW_CSS + '\n</style>\n</head>\n<body>\n' + bodyHtml + '\n</body>\n</html>\n';
  }

  /* HTML с embedded SVG активной диаграммы (для просмотра) */
  IO.downloadHtmlView = function () {
    const p = RR.model.state.project;
    const d = RR.model.getActiveDiagram();
    if (!d) return;
    const body = '<h1>' + RR.util.escapeHtml(d.name) + '</h1>' +
      '<p class="note">Проект «' + RR.util.escapeHtml(p.name) + '» · railroad-диаграмма</p>' +
      '<section>' + RR.renderer.svgString(d) + '</section>';
    download(safeName(d.name) + '.html', 'text/html', htmlDoc(d.name, body));
  };

  /* Standalone HTML: все диаграммы + embedded JSON всего проекта */
  IO.downloadStandaloneHtml = function () {
    const p = RR.model.state.project;
    const sections = p.diagrams.map(function (d) {
      return '<h2>' + RR.util.escapeHtml(d.name) + '</h2><section>' +
        RR.renderer.svgString(d) + '</section>';
    }).join('\n');
    const json = IO.exportProjectJson(p).replace(/</g, '\\u003c');
    const body = '<h1>' + RR.util.escapeHtml(p.name) + '</h1>' +
      '<p class="note">Standalone-экспорт проекта. Этот файл можно импортировать обратно в редактор.</p>' +
      sections +
      '\n<script type="application/json" id="' + EMBED_ID + '">' + json + '</script>';
    download(safeName(p.name) + '.html', 'text/html', htmlDoc(p.name, body));
  };
})();
