/* Railroad Editor — Renderer Layer
 * SVG-отрисовка всех диаграмм проекта, viewport (pan/zoom), декорации состояний,
 * статический рендер для экспорта SVG/PNG/HTML.
 */
(function () {
  'use strict';
  const RR = window.RR;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MIN_ZOOM = 0.1, MAX_ZOOM = 4;
  const DIAGRAM_GAP_X = 180;
  const DIAGRAM_GAP_Y = 150;
  const DIAGRAM_PAD_X = 64;
  const DIAGRAM_PAD_Y = 52;
  const DIAGRAM_TITLE_H = 38;
  const DIAGRAM_MIN_W = 420;
  const DIAGRAM_MIN_H = 260;

  let svg = null;
  let world = null;
  let layers = null;
  let diagramLayout = Object.create(null);

  function el(tag, attrs, parent) {
    const node = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      for (const k in attrs) {
        if (attrs[k] != null) node.setAttribute(k, attrs[k]);
      }
    }
    if (parent) parent.appendChild(node);
    return node;
  }

  function markerDef(defs, id, color) {
    const m = el('marker', {
      id: id, viewBox: '0 0 10 10', refX: 9, refY: 5,
      markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse',
    }, defs);
    el('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: color }, m);
    return m;
  }

  const MARKER_COLORS = {
    'arr-ink': 'var(--edge)',
    'arr-accent': 'var(--accent)',
    'arr-danger': 'var(--danger)',
    'arr-warn': 'var(--warn)',
    'arr-ok': 'var(--ok)',
  };

  const R = (RR.renderer = {
    init(svgEl) {
      svg = svgEl;
      svg.textContent = '';
      const defs = el('defs', null, svg);
      for (const id in MARKER_COLORS) markerDef(defs, id, MARKER_COLORS[id]);
      const pat = el('pattern', {
        id: 'rr-grid', width: 20, height: 20, patternUnits: 'userSpaceOnUse',
      }, defs);
      el('circle', { cx: 1, cy: 1, r: 1, class: 'grid-dot' }, pat);

      world = el('g', { id: 'rr-world' }, svg);
      layers = {
        grid: el('g', { class: 'layer-grid' }, world),
        frames: el('g', { class: 'layer-frames' }, world),
        groups: el('g', { class: 'layer-groups' }, world),
        edges: el('g', { class: 'layer-edges' }, world),
        nodes: el('g', { class: 'layer-nodes' }, world),
      };
      el('rect', {
        class: 'grid', x: -20000, y: -20000, width: 40000, height: 40000,
        fill: 'url(#rr-grid)',
      }, layers.grid);
      this.applyViewport();
    },

    /* ---------- полный рендер всех диаграмм ---------- */
    render() {
      if (!svg) return;
      layers.frames.textContent = '';
      layers.groups.textContent = '';
      layers.edges.textContent = '';
      layers.nodes.textContent = '';
      const p = RR.model.state.project;
      rebuildLayout(p);
      if (p) {
        for (let j = 0; j < p.diagrams.length; j++) {
          drawDiagramFrame(layers.frames, p.diagrams[j]);
          drawDiagramStartCaption(layers.frames, p.diagrams[j]);
        }
        for (let j = 0; j < p.diagrams.length; j++) {
          const d = p.diagrams[j];
          const layout = diagramLayout[d.id];
          const groupLayer = el('g', {
            class: 'diagram',
            'data-diagram-id': d.id,
            transform: 'translate(' + layout.x + ' ' + layout.y + ')',
          }, layers.groups);
          const edgeLayer = el('g', {
            class: 'diagram',
            'data-diagram-id': d.id,
            transform: 'translate(' + layout.x + ' ' + layout.y + ')',
          }, layers.edges);
          const nodeLayer = el('g', {
            class: 'diagram',
            'data-diagram-id': d.id,
            transform: 'translate(' + layout.x + ' ' + layout.y + ')',
          }, layers.nodes);

        for (let i = 0; i < d.nodes.length; i++) {
            if (d.nodes[i].kind === 'group') drawNode(groupLayer, d.nodes[i]);
        }
          for (let i = 0; i < d.edges.length; i++) drawEdge(edgeLayer, d.edges[i], d);
        for (let i = 0; i < d.nodes.length; i++) {
            if (d.nodes[i].kind !== 'group') drawNode(nodeLayer, d.nodes[i]);
          }
        }
      }
      this.applyViewport();
      this.refreshDecorations();
    },

    /* ---------- декорации: selection / issues / traversal / pending ---------- */
    refreshDecorations() {
      if (!svg) return;
      const st = RR.model.state;
      const d = RR.model.getActiveDiagram();
      const trvNext = new Set();
      if (d && st.traversal.active && st.traversal.nodeId) {
        const next = RR.traversal.getNextNodes(d, st.traversal.nodeId);
        for (let i = 0; i < next.length; i++) trvNext.add(next[i].id);
      }
      const nodeGs = svg.querySelectorAll('g.node');
      for (let i = 0; i < nodeGs.length; i++) {
        const g = nodeGs[i];
        const id = g.getAttribute('data-id');
        const level = st.issuesByEl[id];
        g.classList.toggle('selected', st.selected.nodeIds.indexOf(id) >= 0);
        g.classList.toggle('has-error', level === 'error');
        g.classList.toggle('has-warning', level === 'warning');
        g.classList.toggle('trv-current', st.traversal.active && st.traversal.nodeId === id);
        g.classList.toggle('trv-next', trvNext.has(id));
        g.classList.toggle('edge-pending', st.pendingEdgeFrom === id);
      }
      const edgeGs = svg.querySelectorAll('g.edge');
      for (let i = 0; i < edgeGs.length; i++) {
        const g = edgeGs[i];
        const id = g.getAttribute('data-id');
        const level = st.issuesByEl[id];
        const selected = st.selected.edgeIds.indexOf(id) >= 0;
        g.classList.toggle('selected', selected);
        g.classList.toggle('has-error', level === 'error');
        g.classList.toggle('has-warning', level === 'warning');
        const line = g.querySelector('.edge-line');
        if (line) {
          let marker = 'arr-ink';
          if (level === 'error') marker = 'arr-danger';
          else if (level === 'warning') marker = 'arr-warn';
          if (selected) marker = 'arr-accent';
          line.setAttribute('marker-end', 'url(#' + marker + ')');
        }
      }
    },

    /* ---------- позиционные обновления при drag (без полного рендера) ---------- */
    updateNodePosition(node) {
      if (!svg) return;
      const g = svg.querySelector('g.node[data-id="' + node.id + '"]');
      if (g) g.setAttribute('transform', 'translate(' + node.x + ' ' + node.y + ')');
      const found = RR.model.findNode(node.id);
      const d = found ? found.diagram : RR.model.getActiveDiagram();
      if (!d) return;
      for (let i = 0; i < d.edges.length; i++) {
        const e = d.edges[i];
        if (e.fromNodeId !== node.id && e.toNodeId !== node.id) continue;
        this.updateEdgePath(e, d);
      }
    },

    updateEdgePath(edge, diagram) {
      const from = RR.traversal.getNodeById(diagram, edge.fromNodeId);
      const to = RR.traversal.getNodeById(diagram, edge.toNodeId);
      if (!from || !to) return;
      const g = svg.querySelector('g.edge[data-id="' + edge.id + '"]');
      if (!g) return;
      const geom = RR.geo.computeEdgeGeometry(from, to, edge.fromAnchor, edge.toAnchor);
      const paths = g.querySelectorAll('path');
      for (let i = 0; i < paths.length; i++) paths[i].setAttribute('d', geom.d);
      const label = g.querySelector('.edge-label');
      if (label) {
        label.setAttribute('x', geom.mid.x);
        label.setAttribute('y', geom.mid.y - 7);
      }
    },

    updateDiagramPosition(diagramId) {
      if (!svg) return;
      rebuildLayout(RR.model.state.project);
      const layout = diagramLayout[diagramId];
      if (!layout) return;
      const nodes = svg.querySelectorAll('g[data-diagram-id="' + diagramId + '"]');
      for (let i = 0; i < nodes.length; i++) {
        nodes[i].setAttribute('transform', 'translate(' + layout.x + ' ' + layout.y + ')');
      }
    },

    /* ---------- viewport ---------- */
    applyViewport() {
      const p = RR.model.state.project;
      if (!p || !world) return;
      const v = p.viewport;
      world.setAttribute('transform', 'translate(' + v.x + ' ' + v.y + ') scale(' + v.zoom + ')');
      svg.classList.toggle('low-zoom', v.zoom < 0.35);
    },

    /* true после ручного pan/zoom — блокирует авто-рефит при resize */
    userAdjusted: false,

    setViewport(x, y, zoom, opts) {
      opts = opts || {};
      const p = RR.model.state.project;
      if (!p) return;
      if (!opts.fromFit) this.userAdjusted = true;
      p.viewport.x = x;
      p.viewport.y = y;
      p.viewport.zoom = RR.util.clamp(zoom, MIN_ZOOM, MAX_ZOOM);
      this.applyViewport();
      if (!opts.silent) RR.bus.emit('viewport');
    },

    screenToWorld(clientX, clientY) {
      const p = RR.model.state.project;
      const rect = svg.getBoundingClientRect();
      const v = p.viewport;
      return {
        x: (clientX - rect.left - v.x) / v.zoom,
        y: (clientY - rect.top - v.y) / v.zoom,
      };
    },

    viewportCenterWorld() {
      const rect = svg.getBoundingClientRect();
      return this.screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
    },

    worldToDiagram(diagramId, pt) {
      const off = this.diagramOffset(diagramId);
      return { x: pt.x - off.x, y: pt.y - off.y };
    },

    diagramToWorld(diagramId, pt) {
      const off = this.diagramOffset(diagramId);
      return { x: pt.x + off.x, y: pt.y + off.y };
    },

    viewportCenterDiagram(diagramId) {
      return this.worldToDiagram(diagramId, this.viewportCenterWorld());
    },

    zoomAt(clientX, clientY, factor) {
      const p = RR.model.state.project;
      if (!p) return;
      const v = p.viewport;
      const z2 = RR.util.clamp(v.zoom * factor, MIN_ZOOM, MAX_ZOOM);
      const rect = svg.getBoundingClientRect();
      const sx = clientX - rect.left, sy = clientY - rect.top;
      const wx = (sx - v.x) / v.zoom, wy = (sy - v.y) / v.zoom;
      this.setViewport(sx - wx * z2, sy - wy * z2, z2);
    },

    zoomBy(factor) {
      const rect = svg.getBoundingClientRect();
      this.zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
    },

    contentBBox(diagram) {
      if (!diagram || !diagram.nodes.length) return null;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < diagram.nodes.length; i++) {
        const n = diagram.nodes[i];
        minX = Math.min(minX, n.x);
        minY = Math.min(minY, n.y);
        maxX = Math.max(maxX, n.x + n.width);
        maxY = Math.max(maxY, n.y + n.height);
      }
      return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    },

    diagramOffset(diagramId) {
      rebuildLayout(RR.model.state.project);
      const layout = diagramLayout[diagramId];
      return layout ? { x: layout.x, y: layout.y } : { x: 0, y: 0 };
    },

    diagramWorldBBox(diagramId) {
      const p = RR.model.state.project;
      const d = p ? RR.model.getDiagram(diagramId) : null;
      if (!d) return null;
      rebuildLayout(p);
      const layout = diagramLayout[d.id];
      if (!layout) return null;
      return {
        x: layout.x + layout.frame.x,
        y: layout.y + layout.frame.y,
        width: layout.frame.width,
        height: layout.frame.height,
      };
    },

    projectBBox() {
      const p = RR.model.state.project;
      if (!p || !p.diagrams.length) return null;
      rebuildLayout(p);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < p.diagrams.length; i++) {
        const layout = diagramLayout[p.diagrams[i].id];
        if (!layout) continue;
        minX = Math.min(minX, layout.x + layout.frame.x);
        minY = Math.min(minY, layout.y + layout.frame.y);
        maxX = Math.max(maxX, layout.x + layout.frame.x + layout.frame.width);
        maxY = Math.max(maxY, layout.y + layout.frame.y + layout.frame.height);
      }
      if (!isFinite(minX)) return null;
      return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    },

    fitToContent() {
      this._fitBox(this.projectBBox(), 1.5);
      this.userAdjusted = false;
    },

    focusDiagram(diagramId) {
      this._fitBox(this.diagramWorldBBox(diagramId), 1.3);
      this.userAdjusted = false;
    },

    _fitBox(box, maxZoom) {
      const rect = svg.getBoundingClientRect();
      if (!box) {
        this.setViewport(rect.width / 2 - 300, rect.height / 2 - 250, 1, { fromFit: true });
      } else {
        const pad = 70;
        const usableW = Math.max(1, rect.width - pad * 2);
        const usableH = Math.max(1, rect.height - pad * 2);
        const z = RR.util.clamp(
          Math.min(usableW / Math.max(box.width, 1), usableH / Math.max(box.height, 1)),
          MIN_ZOOM, maxZoom || 1.5
        );
        const x = (rect.width - box.width * z) / 2 - box.x * z;
        const y = (rect.height - box.height * z) / 2 - box.y * z;
        this.setViewport(x, y, z, { fromFit: true });
      }
    },

    centerOnNode(nodeId) {
      const found = RR.model.findNode(nodeId);
      if (!found) return;
      this._centerOnPoint(this.diagramToWorld(found.diagram.id, RR.geo.center(found.node)));
    },

    centerOnEdge(edgeId) {
      const found = RR.model.findEdge(edgeId);
      const d = found ? found.diagram : null;
      if (!d) return;
      const edge = found.edge;
      const from = RR.traversal.getNodeById(d, edge.fromNodeId);
      const to = RR.traversal.getNodeById(d, edge.toNodeId);
      if (!from || !to) return;
      const geom = RR.geo.computeEdgeGeometry(from, to, edge.fromAnchor, edge.toAnchor);
      this._centerOnPoint(this.diagramToWorld(d.id, geom.mid));
    },

    _centerOnPoint(pt) {
      const p = RR.model.state.project;
      const rect = svg.getBoundingClientRect();
      const z = p.viewport.zoom;
      this.setViewport(rect.width / 2 - pt.x * z, rect.height / 2 - pt.y * z, z);
    },

    /* ---------- статический SVG для экспорта ---------- */
    buildStaticSvg(diagram) {
      const box = this.contentBBox(diagram) || { x: 0, y: 0, width: 400, height: 200 };
      const pad = 48;
      const vb = [box.x - pad, box.y - pad, box.width + pad * 2, box.height + pad * 2];
      const out = document.createElementNS(SVG_NS, 'svg');
      out.setAttribute('xmlns', SVG_NS);
      out.setAttribute('viewBox', vb.join(' '));
      out.setAttribute('width', Math.round(vb[2]));
      out.setAttribute('height', Math.round(vb[3]));
      const style = document.createElementNS(SVG_NS, 'style');
      style.textContent = EXPORT_CSS;
      out.appendChild(style);
      const defs = el('defs', null, out);
      markerDef(defs, 'arr-ink', '#4b5163');
      el('rect', { x: vb[0], y: vb[1], width: vb[2], height: vb[3], fill: '#fdfdfc' }, out);
      const root = el('g', null, out);
      for (let i = 0; i < diagram.nodes.length; i++) {
        if (diagram.nodes[i].kind === 'group') drawNode(root, diagram.nodes[i]);
      }
      for (let i = 0; i < diagram.edges.length; i++) {
        const g = drawEdge(root, diagram.edges[i], diagram);
        if (g) {
          const line = g.querySelector('.edge-line');
          if (line) line.setAttribute('marker-end', 'url(#arr-ink)');
        }
      }
      for (let i = 0; i < diagram.nodes.length; i++) {
        if (diagram.nodes[i].kind !== 'group') drawNode(root, diagram.nodes[i]);
      }
      return { svg: out, width: Math.round(vb[2]), height: Math.round(vb[3]) };
    },

    svgString(diagram) {
      const built = this.buildStaticSvg(diagram);
      return new XMLSerializer().serializeToString(built.svg);
    },
  });

  function diagramMetric(diagram) {
    const content = R.contentBBox(diagram) || { x: 0, y: 0, width: 320, height: 160 };
    let frame = {
      x: content.x - DIAGRAM_PAD_X,
      y: content.y - DIAGRAM_PAD_Y - DIAGRAM_TITLE_H,
      width: content.width + DIAGRAM_PAD_X * 2,
      height: content.height + DIAGRAM_PAD_Y * 2 + DIAGRAM_TITLE_H,
    };
    if (frame.width < DIAGRAM_MIN_W) {
      frame.x -= (DIAGRAM_MIN_W - frame.width) / 2;
      frame.width = DIAGRAM_MIN_W;
    }
    if (frame.height < DIAGRAM_MIN_H) {
      frame.y -= (DIAGRAM_MIN_H - frame.height) / 2;
      frame.height = DIAGRAM_MIN_H;
    }
    return { content: content, frame: frame };
  }

  function rebuildLayout(project) {
    diagramLayout = Object.create(null);
    if (!project || !project.diagrams.length) return;
    const cols = Math.max(1, Math.ceil(Math.sqrt(project.diagrams.length)));
    const metrics = project.diagrams.map(diagramMetric);
    const colWidths = [];
    const rowHeights = [];
    for (let i = 0; i < metrics.length; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      colWidths[col] = Math.max(colWidths[col] || 0, metrics[i].frame.width);
      rowHeights[row] = Math.max(rowHeights[row] || 0, metrics[i].frame.height);
    }
    const colX = [];
    const rowY = [];
    for (let i = 0, x = 0; i < colWidths.length; i++) {
      colX[i] = x;
      x += colWidths[i] + DIAGRAM_GAP_X;
    }
    for (let i = 0, y = 0; i < rowHeights.length; i++) {
      rowY[i] = y;
      y += rowHeights[i] + DIAGRAM_GAP_Y;
    }
    for (let i = 0; i < project.diagrams.length; i++) {
      const d = project.diagrams[i];
      const col = i % cols;
      const row = Math.floor(i / cols);
      const frameLeft = d.layoutManual ? Number(d.position && d.position.x) || 0 : colX[col];
      const frameTop = d.layoutManual ? Number(d.position && d.position.y) || 0 : rowY[row];
      d.position = { x: Math.round(frameLeft), y: Math.round(frameTop) };
      d.size = {
        width: Math.round(metrics[i].frame.width),
        height: Math.round(metrics[i].frame.height),
      };
      if (typeof d.layoutManual !== 'boolean') d.layoutManual = false;
      diagramLayout[d.id] = {
        x: frameLeft - metrics[i].frame.x,
        y: frameTop - metrics[i].frame.y,
        frame: metrics[i].frame,
      };
    }
  }

  function drawDiagramFrame(parent, diagram) {
    const layout = diagramLayout[diagram.id];
    if (!layout) return null;
    const active = RR.model.state.project && RR.model.state.project.activeDiagramId === diagram.id;
    const g = el('g', {
      class: 'diagram-frame' + (active ? ' active' : ''),
      'data-diagram-id': diagram.id,
      transform: 'translate(' + layout.x + ' ' + layout.y + ')',
    }, parent);
    el('rect', {
      class: 'diagram-frame-hit',
      x: layout.frame.x,
      y: layout.frame.y,
      width: layout.frame.width,
      height: layout.frame.height,
      rx: 14,
      ry: 14,
    }, g);
    el('rect', {
      class: 'diagram-frame-bg',
      x: layout.frame.x,
      y: layout.frame.y,
      width: layout.frame.width,
      height: layout.frame.height,
      rx: 14,
      ry: 14,
    }, g);
    const title = el('text', {
      class: 'diagram-title',
      x: layout.frame.x + 18,
      y: layout.frame.y + 26,
    }, g);
    title.textContent = diagram.name;
    const meta = el('text', {
      class: 'diagram-meta',
      x: layout.frame.x + layout.frame.width - 18,
      y: layout.frame.y + 26,
      'text-anchor': 'end',
    }, g);
    meta.textContent = diagram.nodes.length + ' узл. · ' + diagram.edges.length + ' связ.';
    return g;
  }

  function drawDiagramStartCaption(parent, diagram) {
    const layout = diagramLayout[diagram.id];
    if (!layout) return null;
    const start = RR.traversal.getNodeById(diagram, diagram.entryNodeId) ||
      diagram.nodes.find(function (n) { return n.kind === 'start'; });
    if (!start) return null;
    const g = el('g', {
      class: 'rr-diagram-caption-wrap',
      'data-diagram-id': diagram.id,
      transform: 'translate(' + layout.x + ' ' + layout.y + ')',
    }, parent);
    const t = el('text', {
      class: 'rr-diagram-caption',
      x: start.x + start.width / 2,
      y: start.y - 16,
      'text-anchor': 'middle',
    }, g);
    t.textContent = diagram.name;
    return g;
  }

  /* ---------- отрисовка узла ---------- */
  function drawNode(parent, node) {
    const g = el('g', {
      class: 'node kind-' + node.kind,
      'data-id': node.id,
      transform: 'translate(' + node.x + ' ' + node.y + ')',
    }, parent);
    const w = node.width, h = node.height;

    switch (node.kind) {
      case 'start':
        el('rect', { class: 'shape', width: w, height: h, rx: h / 2, ry: h / 2 }, g);
        break;
      case 'end':
        el('rect', { class: 'shape', width: w, height: h, rx: h / 2, ry: h / 2 }, g);
        el('rect', { class: 'ring', x: 4, y: 4, width: w - 8, height: h - 8, rx: (h - 8) / 2, ry: (h - 8) / 2 }, g);
        break;
      case 'terminal':
        el('rect', { class: 'shape', width: w, height: h, rx: h / 2, ry: h / 2 }, g);
        break;
      case 'nonterminal':
        el('rect', { class: 'shape', width: w, height: h, rx: 6, ry: 6 }, g);
        el('rect', { class: 'inner', x: 4, y: 4, width: w - 8, height: h - 8, rx: 3, ry: 3 }, g);
        break;
      case 'choice': {
        const c = Math.min(14, h / 2);
        el('polygon', {
          class: 'shape',
          points: c + ',0 ' + (w - c) + ',0 ' + w + ',' + (h / 2) + ' ' + (w - c) + ',' + h + ' ' + c + ',' + h + ' 0,' + (h / 2),
        }, g);
        break;
      }
      case 'optional':
        el('rect', { class: 'shape dashed', width: w, height: h, rx: 12, ry: 12 }, g);
        badge(g, w, '?');
        break;
      case 'repeat':
        el('rect', { class: 'shape', width: w, height: h, rx: 12, ry: 12 }, g);
        badge(g, w, '↻');
        break;
      case 'group':
        el('rect', { class: 'shape group-shape', width: w, height: h, rx: 14, ry: 14 }, g);
        break;
      case 'comment':
        el('path', {
          class: 'shape comment-shape',
          d: 'M 0 0 H ' + (w - 14) + ' L ' + w + ' 14 V ' + h + ' H 0 Z',
        }, g);
        el('path', { class: 'comment-fold', d: 'M ' + (w - 14) + ' 0 V 14 H ' + w, fill: 'none' }, g);
        break;
      case 'anchor':
        el('circle', { class: 'anchor-hit', cx: w / 2, cy: h / 2, r: 16 }, g);
        el('circle', { class: 'shape anchor-dot', cx: w / 2, cy: h / 2, r: 5 }, g);
        break;
      default:
        el('rect', { class: 'shape', width: w, height: h, rx: 8, ry: 8 }, g);
    }

    const isCorner = node.kind === 'group' || node.kind === 'comment';
    const isAnchor = node.kind === 'anchor';
    if (isAnchor && !node.label) return g;
    const text = el('text', {
      class: 'label',
      x: isCorner ? 12 : w / 2,
      y: isAnchor ? -8 : (isCorner ? 21 : h / 2),
      'text-anchor': isCorner ? 'start' : 'middle',
      'dominant-baseline': isAnchor || isCorner ? 'auto' : 'central',
    }, g);
    text.textContent = node.label || '';

    if (node.targetDiagramId) {
      const link = el('text', {
        class: 'link-ind', x: w - 8, y: h - 7, 'text-anchor': 'end',
      }, g);
      link.textContent = '»';
    }
    return g;
  }

  function badge(g, w, glyph) {
    const t = el('text', { class: 'badge-glyph', x: w - 12, y: 16, 'text-anchor': 'middle' }, g);
    t.textContent = glyph;
  }

  /* ---------- отрисовка связи ---------- */
  function drawEdge(parent, edge, diagram) {
    const from = RR.traversal.getNodeById(diagram, edge.fromNodeId);
    const to = RR.traversal.getNodeById(diagram, edge.toNodeId);
    if (!from || !to) return null;
    const geom = RR.geo.computeEdgeGeometry(from, to, edge.fromAnchor, edge.toAnchor);
    const g = el('g', { class: 'edge', 'data-id': edge.id }, parent);
    el('path', { class: 'edge-hit', d: geom.d }, g);
    el('path', { class: 'edge-line', d: geom.d, 'marker-end': 'url(#arr-ink)' }, g);
    if (edge.label) {
      const t = el('text', {
        class: 'edge-label', x: geom.mid.x, y: geom.mid.y - 7, 'text-anchor': 'middle',
      }, g);
      t.textContent = edge.label;
    }
    return g;
  }

  /* стили для standalone-экспорта (литеральные цвета, без CSS-переменных) */
  const EXPORT_CSS = [
    'text{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}',
    '.node .shape{fill:#ffffff;stroke:#2a2f3c;stroke-width:1.6}',
    '.kind-start .shape{fill:#2a2f3c}',
    '.kind-start .label{fill:#ffffff}',
    '.kind-end .ring{fill:none;stroke:#2a2f3c;stroke-width:1.4}',
    '.kind-nonterminal .inner{fill:none;stroke:#2a2f3c;stroke-width:1}',
    '.kind-optional .shape{stroke-dasharray:6 4}',
    '.kind-group .shape{fill:rgba(90,100,130,0.06);stroke:#9aa0b0;stroke-dasharray:8 6}',
    '.kind-comment .shape{fill:#fdf6dc;stroke:#d8c98a}',
    '.kind-comment .label{font-style:italic;fill:#5a5f6e}',
    '.kind-comment .comment-fold{stroke:#d8c98a}',
    '.kind-anchor .anchor-hit{fill:transparent;stroke:transparent}',
    '.kind-anchor .shape{fill:#4b5163;stroke:#ffffff;stroke-width:2}',
    '.kind-anchor .label{font-size:11px;font-weight:700;fill:#5a5f6e}',
    '.label{font-size:14px;font-weight:500;fill:#2a2f3c}',
    '.kind-terminal .label{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px}',
    '.badge-glyph{font-size:12px;fill:#6b7186}',
    '.link-ind{font-size:12px;font-weight:700;fill:#4756c4}',
    '.edge-line{fill:none;stroke:#4b5163;stroke-width:1.8}',
    '.edge-hit{fill:none;stroke:transparent;stroke-width:18}',
    '.edge-label{font-size:12px;fill:#5a5f6e}',
  ].join('\n');
})();
