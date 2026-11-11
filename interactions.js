/* Railroad Editor — Interaction Layer
 * Pointer Events: выбор, drag узлов, pan канваса, pinch zoom, double-tap,
 * long-press контекстное меню, режим создания связей, клавиатура.
 */
(function () {
  'use strict';
  const RR = window.RR;

  const TAP_MOVE_LIMIT = 7;      // px до промоушена в drag/pan
  const DOUBLE_TAP_MS = 350;
  const DOUBLE_TAP_DIST = 30;
  const LONG_PRESS_MS = 500;

  let svg = null;
  const pointers = new Map();
  let gesture = null;
  let lastTap = { t: 0, id: null, x: 0, y: 0 };
  let lpTimer = null;

  RR.interactions = { init: init };

  function init(svgEl) {
    svg = svgEl;
    svg.addEventListener('pointerdown', onPointerDown);
    svg.addEventListener('pointermove', onPointerMove);
    svg.addEventListener('pointerup', onPointerUp);
    svg.addEventListener('pointercancel', onPointerCancel);
    svg.addEventListener('wheel', onWheel, { passive: false });
    svg.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('keydown', onKeyDown);
  }

  function clearLP() {
    if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
  }

  function hitInfo(ev) {
    const target = ev.target;
    if (!(target instanceof Element)) return { type: 'canvas', id: null };
    const g = target.closest('g.node, g.edge');
    if (!g) {
      const frame = target.closest('g.diagram-frame');
      if (frame) {
        const diagramId = frame.getAttribute('data-diagram-id');
        return { type: 'diagram', id: diagramId, diagramId: diagramId };
      }
      const dg = target.closest('g.diagram');
      return {
        type: 'canvas',
        id: null,
        diagramId: dg ? dg.getAttribute('data-diagram-id') : null,
      };
    }
    const dg = g.closest('g.diagram');
    return {
      type: g.classList.contains('node') ? 'node' : 'edge',
      id: g.getAttribute('data-id'),
      diagramId: dg ? dg.getAttribute('data-diagram-id') : null,
    };
  }

  /* ---------------- pointer down ---------------- */
  function onPointerDown(e) {
    svg.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    clearLP();

    if (pointers.size === 2) {
      gesture = startPinch();
      e.preventDefault();
      return;
    }
    if (pointers.size > 2) return;

    const hit = hitInfo(e);
    gesture = {
      type: 'press',
      hit: hit,
      x0: e.clientX,
      y0: e.clientY,
      moved: false,
      consumed: false,
      shift: e.shiftKey || e.ctrlKey || e.metaKey,
    };
    const cx = e.clientX, cy = e.clientY;
    lpTimer = setTimeout(function () {
      if (gesture && gesture.type === 'press' && !gesture.moved) {
        gesture.consumed = true;
        RR.app.showContextMenu(gesture.hit, cx, cy);
      }
    }, LONG_PRESS_MS);
    e.preventDefault();
  }

  /* ---------------- pinch ---------------- */
  function startPinch() {
    const pts = Array.from(pointers.values());
    const v = RR.model.state.project.viewport;
    return {
      type: 'pinch',
      d0: Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) || 1,
      c0: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 },
      v0: { x: v.x, y: v.y, zoom: v.zoom },
    };
  }

  function doPinch() {
    const pts = Array.from(pointers.values());
    if (pts.length < 2) return;
    const d1 = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) || 1;
    const c1 = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    const rect = svg.getBoundingClientRect();
    const z2 = RR.util.clamp(gesture.v0.zoom * (d1 / gesture.d0), 0.1, 4);
    const sx0 = gesture.c0.x - rect.left, sy0 = gesture.c0.y - rect.top;
    const wx = (sx0 - gesture.v0.x) / gesture.v0.zoom;
    const wy = (sy0 - gesture.v0.y) / gesture.v0.zoom;
    const x = (c1.x - rect.left) - wx * z2;
    const y = (c1.y - rect.top) - wy * z2;
    RR.renderer.setViewport(x, y, z2, { silent: true });
  }

  /* ---------------- pointer move ---------------- */
  function onPointerMove(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!gesture) return;

    if (gesture.type === 'pinch') {
      if (pointers.size >= 2) doPinch();
      return;
    }

    if (gesture.type === 'press') {
      const dist = Math.hypot(e.clientX - gesture.x0, e.clientY - gesture.y0);
      if (!gesture.moved && dist > TAP_MOVE_LIMIT && !gesture.consumed) {
        gesture.moved = true;
        clearLP();
        promoteGesture();
      }
      if (gesture.consumed) return;
    }

    if (gesture.type === 'drag') {
      const st = RR.model.state;
      const z = st.project.viewport.zoom;
      const wdx = (e.clientX - gesture.x0) / z;
      const wdy = (e.clientY - gesture.y0) / z;
      const d = RR.model.getActiveDiagram();
      for (const id in gesture.origins) {
        const node = RR.traversal.getNodeById(d, id);
        if (!node) continue;
        node.x = Math.round(gesture.origins[id].x + wdx);
        node.y = Math.round(gesture.origins[id].y + wdy);
        RR.renderer.updateNodePosition(node);
      }
    } else if (gesture.type === 'diagram-drag') {
      const st = RR.model.state;
      const z = st.project.viewport.zoom;
      const wdx = (e.clientX - gesture.x0) / z;
      const wdy = (e.clientY - gesture.y0) / z;
      RR.model.setDiagramPosition(gesture.diagramId, gesture.origin.x + wdx, gesture.origin.y + wdy, { skipUndo: true, silent: true });
      RR.renderer.updateDiagramPosition(gesture.diagramId);
    } else if (gesture.type === 'pan') {
      RR.renderer.setViewport(
        gesture.v0.x + (e.clientX - gesture.x0),
        gesture.v0.y + (e.clientY - gesture.y0),
        gesture.v0.zoom,
        { silent: true }
      );
    }
  }

  function promoteGesture() {
    const st = RR.model.state;
    const hit = gesture.hit;
    if (hit.type === 'diagram' && hit.diagramId && st.mode === 'select') {
      const d = RR.model.getDiagram(hit.diagramId);
      if (!d) return;
      if (st.project.activeDiagramId !== hit.diagramId) RR.model.setActiveDiagram(hit.diagramId);
      RR.model.clearSelection();
      RR.model.pushUndo();
      gesture = {
        type: 'diagram-drag',
        diagramId: hit.diagramId,
        x0: gesture.x0,
        y0: gesture.y0,
        origin: { x: d.position.x, y: d.position.y },
      };
    } else if (hit.type === 'node' && st.mode === 'select') {
      if (hit.diagramId && st.project.activeDiagramId !== hit.diagramId) {
        RR.model.setActiveDiagram(hit.diagramId);
      }
      // drag узла (или всей группы выделения)
      RR.model.pushUndo();
      const isSelected = RR.model.isSelected('node', hit.id);
      const ids = isSelected && st.selected.nodeIds.length ? st.selected.nodeIds.slice() : [hit.id];
      const d = hit.diagramId ? RR.model.getDiagram(hit.diagramId) : RR.model.getActiveDiagram();
      const origins = {};
      for (let i = 0; i < ids.length; i++) {
        const n = RR.traversal.getNodeById(d, ids[i]);
        if (n) origins[ids[i]] = { x: n.x, y: n.y };
      }
      gesture = { type: 'drag', x0: gesture.x0, y0: gesture.y0, origins: origins };
    } else {
      const v = st.project.viewport;
      gesture = {
        type: 'pan',
        x0: gesture.x0, y0: gesture.y0,
        v0: { x: v.x, y: v.y, zoom: v.zoom },
      };
    }
  }

  /* ---------------- pointer up / cancel ---------------- */
  function onPointerUp(e) {
    pointers.delete(e.pointerId);
    clearLP();
    if (!gesture) return;

    if (gesture.type === 'pinch') {
      if (pointers.size < 2) {
        RR.bus.emit('viewport');
        if (pointers.size === 1) {
          const pt = Array.from(pointers.values())[0];
          const v = RR.model.state.project.viewport;
          gesture = { type: 'pan', x0: pt.x, y0: pt.y, v0: { x: v.x, y: v.y, zoom: v.zoom } };
        } else {
          gesture = null;
        }
      }
      return;
    }

    if (gesture.type === 'press') {
      if (!gesture.consumed) handleTap(gesture, e);
      gesture = null;
      return;
    }

    if (gesture.type === 'drag') {
      finalizeDrag();
      gesture = null;
      return;
    }

    if (gesture.type === 'diagram-drag') {
      RR.bus.emit('change', { reason: 'move-diagram' });
      gesture = null;
      return;
    }

    if (gesture.type === 'pan') {
      RR.bus.emit('viewport');
      gesture = null;
    }
  }

  function onPointerCancel(e) {
    pointers.delete(e.pointerId);
    clearLP();
    if (gesture && gesture.type === 'drag') finalizeDrag();
    if (gesture && gesture.type === 'diagram-drag') RR.bus.emit('change', { reason: 'move-diagram' });
    if (!pointers.size) gesture = null;
  }

  function finalizeDrag() {
    const st = RR.model.state;
    const d = RR.model.getActiveDiagram();
    if (!d) return;
    for (const id in gesture.origins) {
      const node = RR.traversal.getNodeById(d, id);
      if (!node) continue;
      if (st.snapToGrid) {
        const g = st.gridSize;
        node.x = Math.round(node.x / g) * g;
        node.y = Math.round(node.y / g) * g;
      }
      RR.model.reanchorNodeEdges(id);
    }
    RR.bus.emit('change', { reason: 'move-nodes' });
  }

  /* ---------------- tap ---------------- */
  function handleTap(g, e) {
    const st = RR.model.state;
    const hit = g.hit;

    /* режим создания связи */
    if (st.mode === 'edge') {
      if (hit.type === 'node') {
        if (hit.diagramId && st.project.activeDiagramId !== hit.diagramId) {
          if (st.pendingEdgeFrom) {
            st.pendingEdgeFrom = null;
            RR.renderer.refreshDecorations();
            RR.app.toast('Связи создаются внутри одной диаграммы');
            return;
          }
          RR.model.setActiveDiagram(hit.diagramId);
        }
        if (!st.pendingEdgeFrom) {
          st.pendingEdgeFrom = hit.id;
          RR.renderer.refreshDecorations();
          RR.app.toast('Коснитесь второго узла — конца стрелки');
        } else if (st.pendingEdgeFrom === hit.id) {
          st.pendingEdgeFrom = null;
          RR.renderer.refreshDecorations();
        } else {
          const fromId = st.pendingEdgeFrom;
          st.pendingEdgeFrom = null;
          RR.model.createEdge(hit.diagramId || st.project.activeDiagramId, fromId, hit.id);
        }
      } else if (hit.type === 'edge') {
        const edgeFound = RR.model.findEdge(hit.id);
        const edgeDiagram = edgeFound ? edgeFound.diagram : null;
        if (!edgeDiagram) return;
        if (edgeDiagram.id !== st.project.activeDiagramId) {
          if (st.pendingEdgeFrom) {
            st.pendingEdgeFrom = null;
            RR.renderer.refreshDecorations();
            RR.app.toast('Связи создаются внутри одной диаграммы');
            return;
          }
          RR.model.setActiveDiagram(edgeDiagram.id);
        }
        const world = RR.renderer.screenToWorld(e.clientX, e.clientY);
        const local = RR.renderer.worldToDiagram(edgeDiagram.id, world);
        if (!st.pendingEdgeFrom) {
          const anchor = RR.model.createAnchorOnEdge(hit.id, local.x, local.y);
          if (!anchor) return;
          st.pendingEdgeFrom = anchor.id;
          RR.renderer.refreshDecorations();
          RR.app.toast('Коснитесь второго узла или стрелки — конца связи');
        } else {
          if (!RR.traversal.getNodeById(edgeDiagram, st.pendingEdgeFrom)) {
            st.pendingEdgeFrom = null;
            RR.renderer.refreshDecorations();
            return;
          }
          const fromId = st.pendingEdgeFrom;
          RR.model.pushUndo();
          const anchor = RR.model.createAnchorOnEdge(hit.id, local.x, local.y, { skipUndo: true, silent: true });
          st.pendingEdgeFrom = null;
          if (anchor) RR.model.createEdge(edgeDiagram.id, fromId, anchor.id, { skipUndo: true, silent: true });
          RR.bus.emit('change', { reason: 'create-edge-to-anchor' });
        }
      } else {
        st.pendingEdgeFrom = null;
        RR.renderer.refreshDecorations();
      }
      return;
    }

    /* double tap */
    const now = Date.now();
    const tapId = hit.id || 'canvas';
    const isDouble = now - lastTap.t < DOUBLE_TAP_MS && lastTap.id === tapId &&
      Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < DOUBLE_TAP_DIST;
    lastTap = { t: now, id: tapId, x: e.clientX, y: e.clientY };
    if (isDouble) {
      lastTap.t = 0;
      handleDoubleTap(hit);
      return;
    }

    /* шаг обхода тапом по следующему узлу */
    if (hit.type === 'node' && st.traversal.active && RR.app.isTrvNext(hit.id)) {
      RR.app.trvGoto(hit.id);
      return;
    }

    if (hit.type === 'canvas') {
      if (hit.diagramId && st.project.activeDiagramId !== hit.diagramId) {
        RR.model.setActiveDiagram(hit.diagramId);
      } else {
        RR.model.clearSelection();
      }
      return;
    }
    if (hit.type === 'diagram') {
      if (hit.diagramId && st.project.activeDiagramId !== hit.diagramId) RR.model.setActiveDiagram(hit.diagramId);
      RR.model.clearSelection();
      return;
    }
    if (hit.diagramId && st.project.activeDiagramId !== hit.diagramId) {
      RR.model.setActiveDiagram(hit.diagramId);
    }
    RR.model.select({ type: hit.type, id: hit.id }, st.multiSelect || g.shift);
  }

  function handleDoubleTap(hit) {
    if (hit.type === 'node') {
      const found = RR.model.findNode(hit.id);
      if (!found) return;
      const target = RR.traversal.resolveNodeTarget(RR.model.state.project, found.node);
      if (target) {
        RR.app.openDiagram(target.id, { push: true });
      } else {
        RR.app.editLabelFor(hit);
      }
    } else if (hit.type === 'edge') {
      RR.app.editLabelFor(hit);
    }
  }

  /* ---------------- wheel / контекстное меню / клавиатура ---------------- */
  function onWheel(e) {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    RR.renderer.zoomAt(e.clientX, e.clientY, factor);
  }

  function onContextMenu(e) {
    e.preventDefault();
    clearLP();
    if (gesture && gesture.type === 'press') gesture.consumed = true;
    RR.app.showContextMenu(hitInfo(e), e.clientX, e.clientY);
  }

  function onKeyDown(e) {
    const t = e.target;
    if (t instanceof Element && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (RR.model.selectionCount()) {
        e.preventDefault();
        RR.model.deleteSelection();
      }
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) RR.model.redo(); else RR.model.undo();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      RR.model.redo();
    } else if (e.key === 'Escape') {
      RR.app.escape();
    }
  }
})();
