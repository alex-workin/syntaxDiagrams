/* Railroad Editor — Model Layer
 * Хранение проекта, id, CRUD диаграмм/узлов/связей, undo/redo, выделение, localStorage.
 */
(function () {
  'use strict';
  const RR = (window.RR = window.RR || {});

  /* ---------- utils ---------- */
  let idCounter = 0;
  RR.util = {
    uid(prefix) {
      idCounter += 1;
      return prefix + '-' + Date.now().toString(36) + '-' + idCounter.toString(36) +
        Math.floor(Math.random() * 46656).toString(36);
    },
    clone(obj) { return JSON.parse(JSON.stringify(obj)); },
    clamp(v, a, b) { return Math.min(b, Math.max(a, v)); },
    debounce(fn, ms) {
      let t = null;
      return function () {
        const args = arguments, self = this;
        clearTimeout(t);
        t = setTimeout(function () { fn.apply(self, args); }, ms);
      };
    },
    escapeHtml(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },
  };

  /* ---------- event bus ---------- */
  RR.bus = {
    _h: {},
    on(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); },
    emit(ev, payload) {
      const list = this._h[ev] || [];
      for (let i = 0; i < list.length; i++) list[i](payload);
    },
  };

  /* ---------- geometry (anchors + sticky paths) ---------- */
  function r1(n) { return Math.round(n * 10) / 10; }
  const ANCHOR_DIR = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };

  RR.geo = {
    center(node) { return { x: node.x + node.width / 2, y: node.y + node.height / 2 }; },
    getAnchorPoint(node, anchor) {
      switch (anchor) {
        case 'left': return { x: node.x, y: node.y + node.height / 2 };
        case 'right': return { x: node.x + node.width, y: node.y + node.height / 2 };
        case 'top': return { x: node.x + node.width / 2, y: node.y };
        case 'bottom': return { x: node.x + node.width / 2, y: node.y + node.height };
        default: return this.center(node);
      }
    },
    autoAnchors(fromNode, toNode) {
      if (fromNode === toNode) return ['bottom', 'top'];
      const a = this.center(fromNode), b = this.center(toNode);
      const dx = b.x - a.x, dy = b.y - a.y;
      if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? ['right', 'left'] : ['left', 'right'];
      return dy >= 0 ? ['bottom', 'top'] : ['top', 'bottom'];
    },
    /* Возвращает { d, mid } — SVG-path и точку середины кривой (для подписи) */
    computeEdgeGeometry(fromNode, toNode, fromAnchor, toAnchor) {
      const a = this.getAnchorPoint(fromNode, fromAnchor);
      const b = this.getAnchorPoint(toNode, toAnchor);
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      const k = Math.max(36, Math.min(140, dist / 2));
      const da = ANCHOR_DIR[fromAnchor] || [1, 0];
      const db = ANCHOR_DIR[toAnchor] || [-1, 0];
      const c1 = { x: a.x + da[0] * k, y: a.y + da[1] * k };
      const c2 = { x: b.x + db[0] * k, y: b.y + db[1] * k };
      const d = 'M ' + r1(a.x) + ' ' + r1(a.y) +
        ' C ' + r1(c1.x) + ' ' + r1(c1.y) + ', ' + r1(c2.x) + ' ' + r1(c2.y) +
        ', ' + r1(b.x) + ' ' + r1(b.y);
      // точка кубической кривой при t = 0.5
      const mid = {
        x: (a.x + 3 * c1.x + 3 * c2.x + b.x) / 8,
        y: (a.y + 3 * c1.y + 3 * c2.y + b.y) / 8,
      };
      return { d: d, mid: mid };
    },
    computeEdgePath(fromNode, toNode, fromAnchor, toAnchor) {
      return this.computeEdgeGeometry(fromNode, toNode, fromAnchor, toAnchor).d;
    },
  };

  /* ---------- node kinds ---------- */
  RR.NODE_KINDS = ['start', 'end', 'terminal', 'nonterminal', 'choice', 'optional', 'repeat', 'group', 'comment', 'anchor'];
  RR.NODE_KIND_LABELS = {
    start: 'Start', end: 'End', terminal: 'Terminal', nonterminal: 'Nonterminal',
    choice: 'Choice', optional: 'Optional', repeat: 'Repeat', group: 'Group', comment: 'Comment',
    anchor: 'Anchor',
  };
  RR.NODE_DEFAULTS = {
    start: { width: 76, height: 40, label: 'start' },
    end: { width: 76, height: 40, label: 'end' },
    terminal: { width: 120, height: 48, label: 'terminal' },
    nonterminal: { width: 156, height: 52, label: 'Nonterminal' },
    choice: { width: 130, height: 56, label: 'choice' },
    optional: { width: 144, height: 52, label: 'optional' },
    repeat: { width: 144, height: 52, label: 'repeat' },
    group: { width: 280, height: 180, label: 'group' },
    comment: { width: 190, height: 56, label: 'комментарий' },
    anchor: { width: 16, height: 16, label: '' },
  };

  const LS_PROJECT = 'rr-editor:project';
  const LS_PREFS = 'rr-editor:prefs';
  const UNDO_LIMIT = 100;

  /* ---------- model ---------- */
  const M = (RR.model = {
    state: {
      project: null,
      selected: { nodeIds: [], edgeIds: [] },
      mode: 'select',            // 'select' | 'edge'
      multiSelect: false,
      snapToGrid: false,
      gridSize: 20,
      pendingEdgeFrom: null,
      history: { undoStack: [], redoStack: [] },
      navigation: { stack: [] }, // история переходов между диаграммами (id)
      traversal: { active: false, nodeId: null, returnStack: [] },
      issues: [],
      issuesByEl: {},
    },

    /* ----- project ----- */
    createProject(name) {
      return {
        version: '1.0.0',
        name: name || 'Без названия',
        diagrams: [],
        activeDiagramId: null,
        viewport: { x: 0, y: 0, zoom: 1 },
      };
    },

    newProject(name) {
      this.state.project = this.createProject(name);
      this._addDiagram('Diagram 1', true);
      this.resetTransient();
      this.state.history = { undoStack: [], redoStack: [] };
      RR.bus.emit('change', { reason: 'new-project' });
    },

    /* Заменяет проект целиком (импорт, пресеты) */
    setProject(project, opts) {
      opts = opts || {};
      if (!opts.skipUndo && this.state.project) this.pushUndo();
      this.state.project = project;
      this.resetTransient();
      this.sanitize();
      RR.bus.emit('change', { reason: opts.reason || 'set-project' });
    },

    renameProject(name) {
      if (!name) return;
      this.pushUndo();
      this.state.project.name = name;
      RR.bus.emit('change', { reason: 'rename-project' });
    },

    resetTransient() {
      const st = this.state;
      st.selected = { nodeIds: [], edgeIds: [] };
      st.mode = 'select';
      st.pendingEdgeFrom = null;
      st.navigation = { stack: [] };
      st.traversal = { active: false, nodeId: null, returnStack: [] };
    },

    /* ----- lookups ----- */
    getDiagram(id) {
      const p = this.state.project;
      if (!p) return null;
      for (let i = 0; i < p.diagrams.length; i++) if (p.diagrams[i].id === id) return p.diagrams[i];
      return null;
    },
    getActiveDiagram() {
      const p = this.state.project;
      return p ? this.getDiagram(p.activeDiagramId) : null;
    },
    findNode(nodeId) {
      const p = this.state.project;
      if (!p) return null;
      for (let i = 0; i < p.diagrams.length; i++) {
        const d = p.diagrams[i];
        for (let j = 0; j < d.nodes.length; j++) {
          if (d.nodes[j].id === nodeId) return { diagram: d, node: d.nodes[j] };
        }
      }
      return null;
    },
    findEdge(edgeId) {
      const p = this.state.project;
      if (!p) return null;
      for (let i = 0; i < p.diagrams.length; i++) {
        const d = p.diagrams[i];
        for (let j = 0; j < d.edges.length; j++) {
          if (d.edges[j].id === edgeId) return { diagram: d, edge: d.edges[j] };
        }
      }
      return null;
    },

    /* ----- undo / redo ----- */
    pushUndo() {
      const h = this.state.history;
      h.undoStack.push(RR.util.clone(this.state.project));
      if (h.undoStack.length > UNDO_LIMIT) h.undoStack.shift();
      h.redoStack.length = 0;
    },
    canUndo() { return this.state.history.undoStack.length > 0; },
    canRedo() { return this.state.history.redoStack.length > 0; },
    undo() {
      const h = this.state.history;
      if (!h.undoStack.length) return false;
      h.redoStack.push(RR.util.clone(this.state.project));
      this.state.project = h.undoStack.pop();
      this.sanitize();
      RR.bus.emit('change', { reason: 'undo' });
      return true;
    },
    redo() {
      const h = this.state.history;
      if (!h.redoStack.length) return false;
      h.undoStack.push(RR.util.clone(this.state.project));
      this.state.project = h.redoStack.pop();
      this.sanitize();
      RR.bus.emit('change', { reason: 'redo' });
      return true;
    },

    /* После undo/import выделение и навигация могут указывать на несуществующие элементы */
    sanitize() {
      const st = this.state, p = st.project;
      if (!p) return;
      if (!this.getDiagram(p.activeDiagramId)) {
        p.activeDiagramId = p.diagrams.length ? p.diagrams[0].id : null;
      }
      const d = this.getActiveDiagram();
      const nodeIds = d ? new Set(d.nodes.map(function (n) { return n.id; })) : new Set();
      const edgeIds = d ? new Set(d.edges.map(function (e) { return e.id; })) : new Set();
      st.selected.nodeIds = st.selected.nodeIds.filter(function (id) { return nodeIds.has(id); });
      st.selected.edgeIds = st.selected.edgeIds.filter(function (id) { return edgeIds.has(id); });
      if (st.pendingEdgeFrom && !nodeIds.has(st.pendingEdgeFrom)) st.pendingEdgeFrom = null;
      const self = this;
      st.navigation.stack = st.navigation.stack.filter(function (id) { return !!self.getDiagram(id); });
      if (st.traversal.active && (!st.traversal.nodeId || !this.findNode(st.traversal.nodeId))) {
        st.traversal = { active: false, nodeId: null, returnStack: [] };
      }
    },

    /* ----- diagrams ----- */
    _addDiagram(name, withStartEnd) {
      const p = this.state.project;
      const d = {
        id: RR.util.uid('diagram'),
        name: name,
        type: 'syntax',
        nodes: [],
        edges: [],
        entryNodeId: null,
        exitNodeId: null,
        position: { x: 0, y: 0 },
        size: { width: 1200, height: 600 },
        layoutManual: false,
      };
      p.diagrams.push(d);
      p.activeDiagramId = d.id;
      if (withStartEnd) {
        const s = this._makeNode(d, 'start', null, 80, 230);
        const e = this._makeNode(d, 'end', null, 520, 230);
        d.entryNodeId = s.id;
        d.exitNodeId = e.id;
      }
      return d;
    },

    createDiagram(name, opts) {
      opts = opts || {};
      this.pushUndo();
      const d = this._addDiagram(name || this._untitledName(), opts.withStartEnd !== false);
      this.state.selected = { nodeIds: [], edgeIds: [] };
      RR.bus.emit('change', { reason: 'create-diagram' });
      return d;
    },

    _untitledName() {
      const p = this.state.project;
      const used = new Set(p.diagrams.map(function (d) { return d.name; }));
      let i = p.diagrams.length + 1;
      while (used.has('Diagram ' + i)) i++;
      return 'Diagram ' + i;
    },

    deleteDiagram(diagramId) {
      const p = this.state.project;
      const d = this.getDiagram(diagramId);
      if (!d) return;
      this.pushUndo();
      p.diagrams = p.diagrams.filter(function (x) { return x.id !== diagramId; });
      if (p.activeDiagramId === diagramId) {
        p.activeDiagramId = p.diagrams.length ? p.diagrams[0].id : null;
      }
      this.state.navigation.stack = this.state.navigation.stack.filter(function (id) { return id !== diagramId; });
      this.sanitize();
      RR.bus.emit('change', { reason: 'delete-diagram' });
    },

    renameDiagram(diagramId, name) {
      const d = this.getDiagram(diagramId);
      if (!d || !name) return;
      this.pushUndo();
      d.name = name;
      RR.bus.emit('change', { reason: 'rename-diagram' });
    },

    setActiveDiagram(diagramId, opts) {
      opts = opts || {};
      const p = this.state.project;
      if (!p || !this.getDiagram(diagramId) || p.activeDiagramId === diagramId) return;
      p.activeDiagramId = diagramId;
      this.state.selected = { nodeIds: [], edgeIds: [] };
      this.state.pendingEdgeFrom = null;
      if (!opts.keepTraversal) {
        this.state.traversal = { active: false, nodeId: null, returnStack: [] };
      }
      RR.bus.emit('change', { reason: 'switch-diagram' });
    },

    setDiagramPosition(diagramId, x, y, opts) {
      opts = opts || {};
      const d = this.getDiagram(diagramId);
      if (!d) return false;
      if (!opts.skipUndo) this.pushUndo();
      d.position = { x: Math.round(x), y: Math.round(y) };
      d.layoutManual = true;
      if (!opts.silent) RR.bus.emit('change', { reason: 'move-diagram' });
      return true;
    },

    /* ----- nodes ----- */
    _makeNode(diagram, kind, label, x, y) {
      const def = RR.NODE_DEFAULTS[kind] || RR.NODE_DEFAULTS.terminal;
      const node = {
        id: RR.util.uid('node'),
        kind: kind,
        label: label != null ? label : def.label,
        x: this._snap(x),
        y: this._snap(y),
        width: def.width,
        height: def.height,
        targetDiagramId: null,
        meta: {},
      };
      diagram.nodes.push(node);
      return node;
    },
    _snap(v) {
      if (!this.state.snapToGrid) return Math.round(v);
      const g = this.state.gridSize;
      return Math.round(v / g) * g;
    },

    createNode(diagramId, kind, label, x, y) {
      const d = this.getDiagram(diagramId);
      if (!d) return null;
      this.pushUndo();
      const node = this._makeNode(d, kind, label, x, y);
      if (kind === 'start' && !d.entryNodeId) d.entryNodeId = node.id;
      if (kind === 'end' && !d.exitNodeId) d.exitNodeId = node.id;
      this.state.selected = { nodeIds: [node.id], edgeIds: [] };
      RR.bus.emit('change', { reason: 'create-node' });
      return node;
    },

    updateNode(nodeId, patch, opts) {
      opts = opts || {};
      const found = this.findNode(nodeId);
      if (!found) return;
      if (!opts.skipUndo) this.pushUndo();
      const node = found.node;
      const allowed = ['label', 'x', 'y', 'width', 'height', 'targetDiagramId', 'kind', 'meta'];
      for (let i = 0; i < allowed.length; i++) {
        const k = allowed[i];
        if (Object.prototype.hasOwnProperty.call(patch, k)) node[k] = patch[k];
      }
      if (patch.kind) {
        const def = RR.NODE_DEFAULTS[patch.kind];
        if (def && !('width' in patch)) { node.width = def.width; node.height = def.height; }
        if (patch.kind !== 'nonterminal' && patch.kind !== 'repeat' && patch.kind !== 'optional' && !('targetDiagramId' in patch)) {
          node.targetDiagramId = null;
        }
      }
      if (!opts.silent) RR.bus.emit('change', { reason: 'update-node' });
    },

    deleteNode(diagramId, nodeId) {
      const d = this.getDiagram(diagramId);
      if (!d) return;
      this.pushUndo();
      this._removeNode(d, nodeId);
      this.sanitize();
      RR.bus.emit('change', { reason: 'delete-node' });
    },

    _removeNode(diagram, nodeId) {
      diagram.nodes = diagram.nodes.filter(function (n) { return n.id !== nodeId; });
      diagram.edges = diagram.edges.filter(function (e) {
        return e.fromNodeId !== nodeId && e.toNodeId !== nodeId;
      });
      if (diagram.entryNodeId === nodeId) diagram.entryNodeId = null;
      if (diagram.exitNodeId === nodeId) diagram.exitNodeId = null;
    },

    duplicateNode(diagramId, nodeId) {
      const d = this.getDiagram(diagramId);
      const found = this.findNode(nodeId);
      if (!d || !found) return null;
      this.pushUndo();
      const copy = RR.util.clone(found.node);
      copy.id = RR.util.uid('node');
      copy.x += 28;
      copy.y += 28;
      d.nodes.push(copy);
      this.state.selected = { nodeIds: [copy.id], edgeIds: [] };
      RR.bus.emit('change', { reason: 'duplicate-node' });
      return copy;
    },

    /* ----- edges ----- */
    createEdge(diagramId, fromNodeId, toNodeId, opts) {
      opts = opts || {};
      const d = this.getDiagram(diagramId);
      if (!d) return null;
      const from = d.nodes.find(function (n) { return n.id === fromNodeId; });
      const to = d.nodes.find(function (n) { return n.id === toNodeId; });
      if (!from || !to) return null;
      if (!opts.skipUndo) this.pushUndo();
      const anchors = opts.fromAnchor ? [opts.fromAnchor, opts.toAnchor || 'left'] : RR.geo.autoAnchors(from, to);
      const edge = {
        id: RR.util.uid('edge'),
        fromNodeId: fromNodeId,
        toNodeId: toNodeId,
        fromAnchor: anchors[0],
        toAnchor: anchors[1],
        label: opts.label || null,
        path: null,
      };
      d.edges.push(edge);
      if (!opts.silent) RR.bus.emit('change', { reason: 'create-edge' });
      return edge;
    },

    createAnchorOnEdge(edgeId, x, y, opts) {
      opts = opts || {};
      const found = this.findEdge(edgeId);
      if (!found) return null;
      const d = found.diagram;
      const edge = found.edge;
      const from = d.nodes.find(function (n) { return n.id === edge.fromNodeId; });
      const to = d.nodes.find(function (n) { return n.id === edge.toNodeId; });
      if (!from || !to) return null;
      if (!opts.skipUndo) this.pushUndo();
      const def = RR.NODE_DEFAULTS.anchor;
      const node = {
        id: RR.util.uid('node'),
        kind: 'anchor',
        label: '',
        x: Math.round(x - def.width / 2),
        y: Math.round(y - def.height / 2),
        width: def.width,
        height: def.height,
        targetDiagramId: null,
        meta: {},
      };
      d.nodes.push(node);

      const a1 = RR.geo.autoAnchors(from, node);
      const a2 = RR.geo.autoAnchors(node, to);
      const edge1 = {
        id: RR.util.uid('edge'),
        fromNodeId: edge.fromNodeId,
        toNodeId: node.id,
        fromAnchor: edge.fromAnchor || a1[0],
        toAnchor: a1[1],
        label: edge.label || null,
        path: null,
      };
      const edge2 = {
        id: RR.util.uid('edge'),
        fromNodeId: node.id,
        toNodeId: edge.toNodeId,
        fromAnchor: a2[0],
        toAnchor: edge.toAnchor || a2[1],
        label: null,
        path: null,
      };
      const idx = d.edges.indexOf(edge);
      if (idx >= 0) d.edges.splice(idx, 1, edge1, edge2);
      else d.edges.push(edge1, edge2);

      if (opts.select !== false) this.state.selected = { nodeIds: [node.id], edgeIds: [] };
      if (!opts.silent) RR.bus.emit('change', { reason: 'create-anchor-on-edge' });
      return node;
    },

    updateEdge(edgeId, patch, opts) {
      opts = opts || {};
      const found = this.findEdge(edgeId);
      if (!found) return;
      if (!opts.skipUndo) this.pushUndo();
      const allowed = ['label', 'fromAnchor', 'toAnchor', 'fromNodeId', 'toNodeId'];
      for (let i = 0; i < allowed.length; i++) {
        const k = allowed[i];
        if (Object.prototype.hasOwnProperty.call(patch, k)) found.edge[k] = patch[k];
      }
      RR.bus.emit('change', { reason: 'update-edge' });
    },

    deleteEdge(diagramId, edgeId) {
      const d = this.getDiagram(diagramId);
      if (!d) return;
      this.pushUndo();
      d.edges = d.edges.filter(function (e) { return e.id !== edgeId; });
      this.sanitize();
      RR.bus.emit('change', { reason: 'delete-edge' });
    },

    /* Пересчитать anchors всех связей узла по текущему взаимному положению */
    reanchorNodeEdges(nodeId) {
      const d = this.getActiveDiagram();
      if (!d) return;
      for (let i = 0; i < d.edges.length; i++) {
        const e = d.edges[i];
        if (e.fromNodeId !== nodeId && e.toNodeId !== nodeId) continue;
        const from = d.nodes.find(function (n) { return n.id === e.fromNodeId; });
        const to = d.nodes.find(function (n) { return n.id === e.toNodeId; });
        if (!from || !to) continue;
        const anchors = RR.geo.autoAnchors(from, to);
        e.fromAnchor = anchors[0];
        e.toAnchor = anchors[1];
      }
    },

    /* ----- selection ----- */
    select(target, additive) {
      const sel = this.state.selected;
      const list = target.type === 'node' ? sel.nodeIds : sel.edgeIds;
      if (additive) {
        const idx = list.indexOf(target.id);
        if (idx >= 0) list.splice(idx, 1); else list.push(target.id);
      } else {
        sel.nodeIds = target.type === 'node' ? [target.id] : [];
        sel.edgeIds = target.type === 'edge' ? [target.id] : [];
      }
      RR.bus.emit('select');
    },
    clearSelection() {
      const sel = this.state.selected;
      if (!sel.nodeIds.length && !sel.edgeIds.length) return;
      sel.nodeIds = [];
      sel.edgeIds = [];
      RR.bus.emit('select');
    },
    isSelected(type, id) {
      const sel = this.state.selected;
      return (type === 'node' ? sel.nodeIds : sel.edgeIds).indexOf(id) >= 0;
    },
    selectionCount() {
      return this.state.selected.nodeIds.length + this.state.selected.edgeIds.length;
    },

    deleteSelection() {
      const d = this.getActiveDiagram();
      const sel = this.state.selected;
      if (!d || (!sel.nodeIds.length && !sel.edgeIds.length)) return;
      this.pushUndo();
      for (let i = 0; i < sel.edgeIds.length; i++) {
        const id = sel.edgeIds[i];
        d.edges = d.edges.filter(function (e) { return e.id !== id; });
      }
      for (let j = 0; j < sel.nodeIds.length; j++) this._removeNode(d, sel.nodeIds[j]);
      sel.nodeIds = [];
      sel.edgeIds = [];
      this.sanitize();
      RR.bus.emit('change', { reason: 'delete-selection' });
    },

    /* ----- persistence ----- */
    saveLocal() {
      if (typeof localStorage === 'undefined' || !this.state.project) return;
      try {
        const text = RR.io ? RR.io.exportProjectJson(this.state.project) : JSON.stringify(this.state.project);
        localStorage.setItem(LS_PROJECT, text);
      } catch (e) { /* квота/private mode — молча пропускаем */ }
    },
    loadLocal() {
      if (typeof localStorage === 'undefined') return false;
      try {
        const raw = localStorage.getItem(LS_PROJECT);
        if (!raw) return false;
        const data = JSON.parse(raw);
        const check = RR.io ? RR.io.validateSchema(data) : [];
        if (check.length) return false;
        this.state.project = RR.io ? RR.io.normalizeProject(data) : data;
        this.resetTransient();
        this.sanitize();
        return true;
      } catch (e) { return false; }
    },
    savePrefs() {
      if (typeof localStorage === 'undefined') return;
      try {
        localStorage.setItem(LS_PREFS, JSON.stringify({ snapToGrid: this.state.snapToGrid }));
      } catch (e) { /* ignore */ }
    },
    loadPrefs() {
      if (typeof localStorage === 'undefined') return;
      try {
        const raw = localStorage.getItem(LS_PREFS);
        if (!raw) return;
        const prefs = JSON.parse(raw);
        if (typeof prefs.snapToGrid === 'boolean') this.state.snapToGrid = prefs.snapToGrid;
      } catch (e) { /* ignore */ }
    },
  });

  M.state.project = null;
})();
