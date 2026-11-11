/* Railroad Editor — Validation Layer
 * Проверка консистентности проекта. Возвращает список ValidationIssue.
 */
(function () {
  'use strict';
  const RR = window.RR;
  const V = (RR.validation = {});

  function issue(level, code, message, diagramId, nodeId, edgeId) {
    return {
      level: level,
      code: code,
      message: message,
      diagramId: diagramId || null,
      nodeId: nodeId || null,
      edgeId: edgeId || null,
    };
  }

  V.validateProject = function (project) {
    const issues = [];
    if (!project || !Array.isArray(project.diagrams)) {
      issues.push(issue('error', 'EmptyProject', 'Проект пуст или повреждён.'));
      return issues;
    }
    const T = RR.traversal;
    const diagrams = project.diagrams;

    /* --- дубли id по всему проекту --- */
    const seenIds = new Set();
    const reportedDup = new Set();
    function checkId(id, where, diagramId, nodeId, edgeId) {
      if (!id) return;
      if (seenIds.has(id)) {
        if (!reportedDup.has(id)) {
          reportedDup.add(id);
          issues.push(issue('error', 'DuplicateId', 'Дублирующийся id «' + id + '» (' + where + ').', diagramId, nodeId, edgeId));
        }
      } else {
        seenIds.add(id);
      }
    }
    for (let i = 0; i < diagrams.length; i++) {
      const d = diagrams[i];
      checkId(d.id, 'диаграмма «' + d.name + '»', d.id);
      for (let j = 0; j < d.nodes.length; j++) checkId(d.nodes[j].id, 'узел в «' + d.name + '»', d.id, d.nodes[j].id);
      for (let k = 0; k < d.edges.length; k++) checkId(d.edges[k].id, 'связь в «' + d.name + '»', d.id, null, d.edges[k].id);
    }

    /* --- уникальность имён диаграмм --- */
    const names = new Map();
    for (let i = 0; i < diagrams.length; i++) {
      const d = diagrams[i];
      if (names.has(d.name)) {
        issues.push(issue('error', 'DuplicateDiagramName', 'Имя диаграммы «' + d.name + '» повторяется.', d.id));
      } else {
        names.set(d.name, d.id);
      }
    }

    const diagramIds = new Set(diagrams.map(function (d) { return d.id; }));

    /* --- проверки внутри каждой диаграммы --- */
    for (let i = 0; i < diagrams.length; i++) {
      const d = diagrams[i];
      const nodeIds = new Set(d.nodes.map(function (n) { return n.id; }));
      const starts = d.nodes.filter(function (n) { return n.kind === 'start'; });
      const ends = d.nodes.filter(function (n) { return n.kind === 'end'; });

      if (!starts.length) {
        issues.push(issue('error', 'MissingStartNode', 'Диаграмма «' + d.name + '»: нет start-узла.', d.id));
      }
      if (!ends.length) {
        issues.push(issue('error', 'MissingEndNode', 'Диаграмма «' + d.name + '»: нет end-узла.', d.id));
      }

      /* битые связи */
      for (let k = 0; k < d.edges.length; k++) {
        const e = d.edges[k];
        if (!nodeIds.has(e.fromNodeId) || !nodeIds.has(e.toNodeId)) {
          issues.push(issue('error', 'BrokenEdgeReference',
            'Диаграмма «' + d.name + '»: связь «' + e.id + '» указывает на несуществующий узел.', d.id, null, e.id));
        }
      }

      /* ссылки узлов на диаграммы */
      for (let j = 0; j < d.nodes.length; j++) {
        const n = d.nodes[j];
        if (n.targetDiagramId && !diagramIds.has(n.targetDiagramId)) {
          issues.push(issue('error', 'BrokenTargetDiagramReference',
            'Диаграмма «' + d.name + '»: узел «' + n.label + '» ссылается на несуществующую диаграмму.', d.id, n.id));
        }
        if (n.kind === 'nonterminal') {
          const resolved = T.resolveNodeTarget(project, n);
          if (!resolved) {
            issues.push(issue('error', 'MissingDiagramForNonterminal',
              'Нет диаграммы для нетерминального символа «' + n.label + '» (диаграмма «' + d.name + '»).', d.id, n.id));
          }
        }
      }

      /* достижимость: BFS от всех start-узлов */
      if (starts.length) {
        const reachable = new Set();
        const queue = [];
        for (let s = 0; s < starts.length; s++) {
          reachable.add(starts[s].id);
          queue.push(starts[s].id);
        }
        while (queue.length) {
          const cur = queue.shift();
          for (let k = 0; k < d.edges.length; k++) {
            const e = d.edges[k];
            if (e.fromNodeId !== cur) continue;
            if (!nodeIds.has(e.toNodeId)) continue;
            if (!reachable.has(e.toNodeId)) {
              reachable.add(e.toNodeId);
              queue.push(e.toNodeId);
            }
          }
        }

        if (ends.length && !ends.some(function (n) { return reachable.has(n.id); })) {
          issues.push(issue('error', 'NoPathFromStartToEnd',
            'Диаграмма «' + d.name + '»: нет пути от start до end.', d.id));
        }

        for (let j = 0; j < d.nodes.length; j++) {
          const n = d.nodes[j];
          if (n.kind === 'group' || n.kind === 'comment' || n.kind === 'start') continue;
          if (!reachable.has(n.id)) {
            issues.push(issue('warning', 'UnreachableNode',
              'Диаграмма «' + d.name + '»: узел «' + n.label + '» недостижим от start.', d.id, n.id));
          }
        }
      }
    }

    /* --- циклы между диаграммами (warning) --- */
    const adj = new Map();
    for (let i = 0; i < diagrams.length; i++) {
      const refs = T.getReferencedDiagrams(project, diagrams[i].id);
      adj.set(diagrams[i].id, refs.map(function (r) { return r.id; }));
    }
    const color = new Map(); // 0 white, 1 in-stack, 2 done
    const stack = [];
    const reportedCycles = new Set();
    function nameOf(id) {
      const d = T.getDiagramById(project, id);
      return d ? d.name : id;
    }
    function dfs(id) {
      color.set(id, 1);
      stack.push(id);
      const next = adj.get(id) || [];
      for (let i = 0; i < next.length; i++) {
        const to = next[i];
        const c = color.get(to) || 0;
        if (c === 0) {
          dfs(to);
        } else if (c === 1) {
          const idx = stack.indexOf(to);
          const cycle = stack.slice(idx).concat([to]);
          const key = cycle.slice(0, -1).slice().sort().join('|');
          if (!reportedCycles.has(key)) {
            reportedCycles.add(key);
            issues.push(issue('warning', 'DiagramCycle',
              'Цикл ссылок между диаграммами: ' + cycle.map(nameOf).join(' → ') + '.', to));
          }
        }
      }
      stack.pop();
      color.set(id, 2);
    }
    for (let i = 0; i < diagrams.length; i++) {
      if ((color.get(diagrams[i].id) || 0) === 0) dfs(diagrams[i].id);
    }

    return issues;
  };

  /* Карта elementId -> уровень (для подсветки), error приоритетнее warning */
  V.issueMap = function (issues) {
    const map = {};
    for (let i = 0; i < issues.length; i++) {
      const it = issues[i];
      const targets = [it.nodeId, it.edgeId];
      // диаграммный уровень тоже сохраняем — для бейджей в списке
      if (!it.nodeId && !it.edgeId && it.diagramId) targets.push(it.diagramId);
      for (let t = 0; t < targets.length; t++) {
        const id = targets[t];
        if (!id) continue;
        if (map[id] !== 'error') map[id] = it.level === 'error' ? 'error' : (map[id] || it.level);
      }
    }
    return map;
  };

  /* Счётчики по диаграммам для панели списка */
  V.countsByDiagram = function (issues) {
    const map = {};
    for (let i = 0; i < issues.length; i++) {
      const it = issues[i];
      if (!it.diagramId) continue;
      const rec = (map[it.diagramId] = map[it.diagramId] || { error: 0, warning: 0, info: 0 });
      rec[it.level] = (rec[it.level] || 0) + 1;
    }
    return map;
  };
})();
