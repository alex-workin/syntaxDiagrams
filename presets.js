/* Railroad Editor — Presets
 * Три готовых системы диаграмм: натуральные числа, арифметика, предложение.
 */
(function () {
  'use strict';
  const RR = window.RR;
  const P = (RR.presets = {});

  function kebab(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
  function did(name) { return 'diagram-' + kebab(name); }

  function sizeFor(kind, label) {
    const def = RR.NODE_DEFAULTS[kind];
    let w = def.width;
    // терминалы из 1–2 символов делаем компактными, длинные подписи — шире
    if (kind === 'terminal' && label && label.length <= 2) w = 64;
    if (label && label.length > 12) w = Math.max(w, 12 + label.length * 9);
    return { w: w, h: def.height };
  }

  function makeBuilder(name) {
    const d = {
      id: did(name), name: name, type: 'syntax',
      nodes: [], edges: [],
      entryNodeId: null, exitNodeId: null,
      position: { x: 0, y: 0 }, size: { width: 1200, height: 600 },
    };
    let nIdx = 0, eIdx = 0;
    return {
      diagram: d,
      node(kind, label, x, y, target) {
        const s = sizeFor(kind, label);
        const node = {
          id: d.id + '-n' + (++nIdx),
          kind: kind,
          label: label != null ? label : RR.NODE_DEFAULTS[kind].label,
          x: Math.round(x), y: Math.round(y),
          width: s.w, height: s.h,
          targetDiagramId: target ? did(target) : null,
          meta: {},
        };
        d.nodes.push(node);
        if (kind === 'start' && !d.entryNodeId) d.entryNodeId = node.id;
        if (kind === 'end' && !d.exitNodeId) d.exitNodeId = node.id;
        return node;
      },
      edge(from, to, fromAnchor, toAnchor, label) {
        const anchors = fromAnchor ? [fromAnchor, toAnchor] : RR.geo.autoAnchors(from, to);
        d.edges.push({
          id: d.id + '-e' + (++eIdx),
          fromNodeId: from.id, toNodeId: to.id,
          fromAnchor: anchors[0], toAnchor: anchors[1],
          label: label || null, path: null,
        });
      },
    };
  }

  /* Последовательность: start → items… → end по горизонтали */
  function linearDiagram(name, items) {
    const b = makeBuilder(name);
    const cy = 250, gap = 64;
    let x = 60;
    const start = b.node('start', null, x, cy - 20);
    let prev = start;
    x += start.width + gap;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const s = sizeFor(it.kind, it.label);
      const node = b.node(it.kind, it.label, x, cy - s.h / 2, it.target);
      b.edge(prev, node);
      prev = node;
      x += node.width + gap;
    }
    const end = b.node('end', null, x, cy - 20);
    b.edge(prev, end);
    return b.diagram;
  }

  /* Альтернатива: start веером на варианты, каждый вариант → end */
  function choiceDiagram(name, options) {
    const b = makeBuilder(name);
    const rowH = 62, colX = 300, cy = 250;
    const n = options.length;
    const firstY = cy - ((n - 1) * rowH) / 2;
    const start = b.node('start', null, 60, cy - 20);
    let maxW = 0;
    const nodes = [];
    for (let i = 0; i < n; i++) {
      const opt = options[i];
      const s = sizeFor(opt.kind, opt.label);
      const node = b.node(opt.kind, opt.label, colX, firstY + i * rowH - s.h / 2, opt.target);
      nodes.push(node);
      if (node.width > maxW) maxW = node.width;
    }
    const end = b.node('end', null, colX + maxW + 170, cy - 20);
    for (let i = 0; i < n; i++) {
      b.edge(start, nodes[i], 'right', 'left');
      b.edge(nodes[i], end, 'right', 'left');
    }
    return b.diagram;
  }

  /* Повторение с оператором: start → item → end, петля item → ops → item */
  function loopDiagram(name, item, opsLabel) {
    const b = makeBuilder(name);
    const start = b.node('start', null, 60, 280);
    const it = b.node(item.kind || 'nonterminal', item.label, 210, 274, item.target);
    const ops = b.node('choice', opsLabel, 430, 140);
    const end = b.node('end', null, 660, 280);
    b.edge(start, it);
    b.edge(it, end);
    b.edge(it, ops, 'top', 'left');
    b.edge(ops, it, 'bottom', 'top');
    return b.diagram;
  }

  /* Factor = Number | "(" Expression ")" — две ветки от start */
  function factorDiagram() {
    const b = makeBuilder('Factor');
    const start = b.node('start', null, 50, 280);
    const num = b.node('nonterminal', 'Number', 220, 186, 'Number');
    const lp = b.node('terminal', '(', 220, 354);
    const expr = b.node('nonterminal', 'Expression', 340, 350, 'Expression');
    const rp = b.node('terminal', ')', 560, 354);
    const end = b.node('end', null, 700, 280);
    b.edge(start, num, 'right', 'left');
    b.edge(num, end, 'right', 'left');
    b.edge(start, lp, 'right', 'left');
    b.edge(lp, expr, 'right', 'left');
    b.edge(expr, rp, 'right', 'left');
    b.edge(rp, end, 'right', 'left');
    return b.diagram;
  }

  function project(name, diagrams) {
    return {
      version: '1.0.0',
      name: name,
      diagrams: diagrams,
      activeDiagramId: diagrams[0].id,
      viewport: { x: 0, y: 0, zoom: 1 },
    };
  }

  function digits(from, to) {
    const out = [];
    for (let i = from; i <= to; i++) out.push({ kind: 'terminal', label: String(i) });
    return out;
  }

  const builders = {
    natural: function () {
      return project('Натуральные числа', [
        linearDiagram('NaturalNumber', [
          { kind: 'nonterminal', label: 'NonZeroDigit', target: 'NonZeroDigit' },
          { kind: 'repeat', label: 'Digit *', target: 'Digit' },
        ]),
        choiceDiagram('NonZeroDigit', digits(1, 9)),
        choiceDiagram('Digit', [{ kind: 'terminal', label: '0' }, { kind: 'nonterminal', label: 'NonZeroDigit', target: 'NonZeroDigit' }]),
      ]);
    },
    expression: function () {
      return project('Арифметическое выражение', [
        loopDiagram('Expression', { label: 'Term', target: 'Term' }, '+ | −'),
        loopDiagram('Term', { label: 'Factor', target: 'Factor' }, '* | /'),
        factorDiagram(),
        linearDiagram('Number', [
          { kind: 'nonterminal', label: 'Digit', target: 'Digit' },
          { kind: 'repeat', label: 'Digit *', target: 'Digit' },
        ]),
        choiceDiagram('Digit', digits(0, 9)),
      ]);
    },
    sentence: function () {
      return project('Текстовое предложение', [
        linearDiagram('Sentence', [
          { kind: 'nonterminal', label: 'Subject', target: 'Subject' },
          { kind: 'nonterminal', label: 'Predicate', target: 'Predicate' },
          { kind: 'optional', label: 'Object ?', target: 'Object' },
          { kind: 'nonterminal', label: 'Punctuation', target: 'Punctuation' },
        ]),
        linearDiagram('Subject', [{ kind: 'nonterminal', label: 'Word', target: 'Word' }]),
        linearDiagram('Predicate', [{ kind: 'nonterminal', label: 'Word', target: 'Word' }]),
        linearDiagram('Object', [{ kind: 'nonterminal', label: 'Word', target: 'Word' }]),
        linearDiagram('Word', [
          { kind: 'terminal', label: 'letter' },
          { kind: 'repeat', label: 'letter *' },
        ]),
        choiceDiagram('Punctuation', [
          { kind: 'terminal', label: '.' },
          { kind: 'terminal', label: '!' },
          { kind: 'terminal', label: '?' },
        ]),
      ]);
    },
    email: function () {
      return schemaPreset('Email address', [
        'email ::= local-part "@" domain',
        'local-part ::= atom { "." atom }',
        'domain ::= label { "." label }',
        'atom ::= letter { letter | digit | "_" | "-" }',
        'label ::= letter { letter | digit | "-" }',
        'letter ::= "a" | "b" | "c"',
        'digit ::= "0" | "1" | "2"',
      ]);
    },
    isoDate: function () {
      return schemaPreset('ISO date', [
        'date ::= year "-" month "-" day',
        'year ::= digit digit digit digit',
        'month ::= "01" | "02" | "03" | "04" | "05" | "06" | "07" | "08" | "09" | "10" | "11" | "12"',
        'day ::= "01" | "02" | "03" | "04" | "05" | "06" | "07" | "08" | "09" | "10" | "11" | "12" | "13" | "14" | "15" | "16" | "17" | "18" | "19" | "20" | "21" | "22" | "23" | "24" | "25" | "26" | "27" | "28" | "29" | "30" | "31"',
        'digit ::= "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"',
      ]);
    },
    url: function () {
      return schemaPreset('URL', [
        'url ::= scheme "://" host [ ":" port ] [ path ] [ "?" query ]',
        'scheme ::= "http" | "https"',
        'host ::= label { "." label }',
        'label ::= letter { letter | digit | "-" }',
        'port ::= digit { digit }',
        'path ::= "/" segment { "/" segment }',
        'segment ::= letter { letter | digit | "-" | "_" }',
        'query ::= pair { "&" pair }',
        'pair ::= key "=" value',
        'key ::= letter { letter | digit | "_" }',
        'value ::= letter { letter | digit | "_" | "-" }',
        'letter ::= "a" | "b" | "c"',
        'digit ::= "0" | "1" | "2"',
      ]);
    },
    ipv4: function () {
      return schemaPreset('IPv4 address', [
        'ipv4 ::= octet "." octet "." octet "." octet',
        'octet ::= digit | digit digit | digit digit digit',
      ]);
    },
    sqlSelect: function () {
      return schemaPreset('SQL SELECT', [
        'select-statement ::= "SELECT" select-list "FROM" table-name [ where-clause ] [ order-clause ]',
        'select-list ::= "*" | column-name { "," column-name }',
        'where-clause ::= "WHERE" condition',
        'condition ::= column-name operator value',
        'operator ::= "=" | "<>" | "<" | ">" | "<=" | ">="',
        'order-clause ::= "ORDER" "BY" column-name [ direction ]',
        'direction ::= "ASC" | "DESC"',
        'table-name ::= identifier',
        'column-name ::= identifier',
        'value ::= identifier | number',
        'identifier ::= letter { letter | digit | "_" }',
        'number ::= digit { digit }',
        'letter ::= "a" | "b" | "c"',
        'digit ::= "0" | "1" | "2"',
      ]);
    },
    cron: function () {
      return schemaPreset('Cron expression', [
        'cron ::= field SP field SP field SP field SP field',
        'field ::= "*" | number | range | list',
        'range ::= number "-" number',
        'list ::= number { "," number }',
        'number ::= digit { digit }',
        'digit ::= "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"',
        'SP ::= %x20',
      ]);
    },
    filePath: function () {
      return schemaPreset('File path', [
        'file-path ::= absolute-path | relative-path',
        'absolute-path ::= "/" segment { "/" segment }',
        'relative-path ::= segment { "/" segment }',
        'segment ::= name | "." | ".."',
        'name ::= letter { letter | digit | "-" | "_" | "." }',
        'letter ::= "a" | "b" | "c"',
        'digit ::= "0" | "1" | "2"',
      ]);
    },
  };

  function schemaPreset(name, sourceLines) {
    return RR.io.normalizeProject({
      version: '2.0.0',
      name: name,
      schema: {
        notation: 'ebnf',
        sourceLines: sourceLines,
      },
    });
  }

  P.list = [
    { id: 'natural', name: 'Натуральные числа', desc: 'NaturalNumber · NonZeroDigit · Digit' },
    { id: 'expression', name: 'Арифметическое выражение', desc: 'Expression · Term · Factor · Number · Digit' },
    { id: 'sentence', name: 'Текстовое предложение', desc: 'Sentence · Subject · Predicate · Object · Word · Punctuation' },
    { id: 'email', name: 'Email address', desc: 'email · local-part · domain · atom · label' },
    { id: 'isoDate', name: 'ISO date', desc: 'date · year · month · day' },
    { id: 'url', name: 'URL', desc: 'url · scheme · host · path · query' },
    { id: 'ipv4', name: 'IPv4 address', desc: 'ipv4 · octet' },
    { id: 'sqlSelect', name: 'SQL SELECT', desc: 'select-statement · where · order' },
    { id: 'cron', name: 'Cron expression', desc: 'five fields · ranges · lists' },
    { id: 'filePath', name: 'File path', desc: 'absolute-path · relative-path · segment' },
  ];

  P.build = function (id) {
    const fn = builders[id];
    return fn ? fn() : null;
  };
})();
