/* Railroad Editor — Traversal Layer
 * Виртуальный обход системы диаграмм: чистые функции над структурой проекта.
 */
(function () {
  'use strict';
  const RR = window.RR;
  const T = (RR.traversal = {});

  T.getDiagramById = function (project, diagramId) {
    if (!project) return null;
    for (let i = 0; i < project.diagrams.length; i++) {
      if (project.diagrams[i].id === diagramId) return project.diagrams[i];
    }
    return null;
  };

  T.getDiagramByName = function (project, name) {
    if (!project) return null;
    for (let i = 0; i < project.diagrams.length; i++) {
      if (project.diagrams[i].name === name) return project.diagrams[i];
    }
    return null;
  };

  T.getNodeById = function (diagram, nodeId) {
    if (!diagram) return null;
    for (let i = 0; i < diagram.nodes.length; i++) {
      if (diagram.nodes[i].id === nodeId) return diagram.nodes[i];
    }
    return null;
  };

  T.getOutgoingEdges = function (diagram, nodeId) {
    if (!diagram) return [];
    return diagram.edges.filter(function (e) { return e.fromNodeId === nodeId; });
  };

  T.getIncomingEdges = function (diagram, nodeId) {
    if (!diagram) return [];
    return diagram.edges.filter(function (e) { return e.toNodeId === nodeId; });
  };

  T.getNextNodes = function (diagram, nodeId) {
    return T.getOutgoingEdges(diagram, nodeId)
      .map(function (e) { return T.getNodeById(diagram, e.toNodeId); })
      .filter(Boolean);
  };

  /* BFS по связям; возвращает массив достижимых узлов (включая стартовый) */
  T.getReachableNodes = function (diagram, startNodeId) {
    if (!diagram || !T.getNodeById(diagram, startNodeId)) return [];
    const visited = new Set([startNodeId]);
    const queue = [startNodeId];
    while (queue.length) {
      const cur = queue.shift();
      const next = T.getOutgoingEdges(diagram, cur);
      for (let i = 0; i < next.length; i++) {
        const to = next[i].toNodeId;
        if (!visited.has(to) && T.getNodeById(diagram, to)) {
          visited.add(to);
          queue.push(to);
        }
      }
    }
    return diagram.nodes.filter(function (n) { return visited.has(n.id); });
  };

  /* Диаграмма, на которую ссылается узел: по targetDiagramId, для nonterminal — ещё и по имени */
  T.resolveNodeTarget = function (project, node) {
    if (!project || !node) return null;
    if (node.targetDiagramId) {
      const byId = T.getDiagramById(project, node.targetDiagramId);
      if (byId) return byId;
    }
    if (node.kind === 'nonterminal' && node.label) {
      return T.getDiagramByName(project, node.label);
    }
    return null;
  };

  /* Диаграммы, на которые прямо ссылается данная диаграмма */
  T.getReferencedDiagrams = function (project, diagramId) {
    const d = T.getDiagramById(project, diagramId);
    if (!d) return [];
    const seen = new Set();
    const out = [];
    for (let i = 0; i < d.nodes.length; i++) {
      const target = T.resolveNodeTarget(project, d.nodes[i]);
      if (target && !seen.has(target.id)) {
        seen.add(target.id);
        out.push(target);
      }
    }
    return out;
  };

  /* Все диаграммы, достижимые от выбранной по ссылкам (без неё самой, если нет цикла) */
  T.getReachableDiagrams = function (project, diagramId) {
    const start = T.getDiagramById(project, diagramId);
    if (!start) return [];
    const visited = new Set([diagramId]);
    const queue = [diagramId];
    const out = [];
    while (queue.length) {
      const refs = T.getReferencedDiagrams(project, queue.shift());
      for (let i = 0; i < refs.length; i++) {
        if (!visited.has(refs[i].id)) {
          visited.add(refs[i].id);
          out.push(refs[i]);
          queue.push(refs[i].id);
        }
      }
    }
    return out;
  };

  /* Все нетерминальные ссылки проекта (для панели ссылок и проверок) */
  T.getAllNonterminalRefs = function (project) {
    const out = [];
    if (!project) return out;
    for (let i = 0; i < project.diagrams.length; i++) {
      const d = project.diagrams[i];
      for (let j = 0; j < d.nodes.length; j++) {
        const n = d.nodes[j];
        if (n.kind !== 'nonterminal' && !n.targetDiagramId) continue;
        const target = T.resolveNodeTarget(project, n);
        out.push({
          diagramId: d.id,
          diagramName: d.name,
          nodeId: n.id,
          label: n.label,
          kind: n.kind,
          targetDiagramId: n.targetDiagramId,
          resolvedId: target ? target.id : null,
          resolvedName: target ? target.name : null,
        });
      }
    }
    return out;
  };

  /* Псевдоним по ТЗ: validateProject доступен и из traversal API */
  T.validateProject = function (project) {
    return RR.validation ? RR.validation.validateProject(project) : [];
  };
})();
