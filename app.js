/* Railroad Editor — App Layer
 * Связывает модель, рендерер, взаимодействия, панели, диалоги, обход, автосохранение.
 */
(function () {
  'use strict';
  const RR = window.RR;
  const M = RR.model, T = RR.traversal, V = RR.validation, IO = RR.io;
  const esc = RR.util.escapeHtml;
  const app = (RR.app = {});

  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function R() { return RR.renderer; }

  let toastTimer = null;
  const scheduleSave = RR.util.debounce(function () { M.saveLocal(); }, 400);

  /* ================= init ================= */
  document.addEventListener('DOMContentLoaded', function () {
    RR.renderer.init($('#canvas'));
    RR.interactions.init($('#canvas'));
    M.loadPrefs();
    if (!M.loadLocal()) M.newProject('Без названия');
    bind();
    runValidation();
    RR.renderer.render();
    requestAnimationFrame(function () { RR.renderer.fitToContent(); });
    refreshAll();
    RR.bus.on('change', onChange);
    RR.bus.on('select', onSelect);
    RR.bus.on('viewport', scheduleSave);
    // рефит при resize/повороте, пока пользователь сам не менял viewport
    window.addEventListener('resize', RR.util.debounce(function () {
      if (!RR.renderer.userAdjusted) RR.renderer.fitToContent();
    }, 200));
  });

  function onChange() {
    runValidation();
    RR.renderer.render();
    refreshAll();
    scheduleSave();
  }

  function onSelect() {
    RR.renderer.refreshDecorations();
    refreshSheets();
  }

  /* ================= validation ================= */
  function runValidation() {
    const st = M.state;
    st.issues = V.validateProject(st.project);
    st.issuesByEl = V.issueMap(st.issues);
    const errs = st.issues.filter(function (i) { return i.level === 'error'; }).length;
    const badge = $('#valBadge');
    badge.textContent = errs ? String(errs) : '';
    badge.hidden = !errs;
    if (!$('#valSheet').hidden) renderValSheet();
  }

  /* ================= bind static UI ================= */
  function bind() {
    $('#btnMenu').addEventListener('click', function () { openDrawer(true); });
    $('#topTitle').addEventListener('click', function () { openDrawer(true); });
    $('#btnNew').addEventListener('click', newProjectFlow);
    $('#btnImport').addEventListener('click', showImportDialog);
    $('#btnExport').addEventListener('click', showExportDialog);
    $('#btnValidate').addEventListener('click', function () {
      runValidation();
      openValSheet(true);
    });
    $('#btnWalk').addEventListener('click', function () {
      M.state.traversal.active ? trvStop() : trvStart();
    });
    $('#btnUndo').addEventListener('click', function () { M.undo(); });
    $('#btnRedo').addEventListener('click', function () { M.redo(); });
    $('#btnZoomIn').addEventListener('click', function () { RR.renderer.zoomBy(1.25); });
    $('#btnZoomOut').addEventListener('click', function () { RR.renderer.zoomBy(0.8); });
    $('#btnZoomFit').addEventListener('click', function () { RR.renderer.fitToContent(); });
    $('#btnBack').addEventListener('click', navBack);

    $$('#toolbar [data-kind]').forEach(function (btn) {
      btn.addEventListener('click', function () { addNodeAtCenter(btn.getAttribute('data-kind')); });
    });
    $('#chipEdge').addEventListener('click', function () {
      const st = M.state;
      st.mode = st.mode === 'edge' ? 'select' : 'edge';
      st.pendingEdgeFrom = null;
      RR.renderer.refreshDecorations();
      updateToolbar();
      if (st.mode === 'edge') app.toast('Режим связей: коснитесь первого узла');
    });
    $('#chipMulti').addEventListener('click', function () {
      M.state.multiSelect = !M.state.multiSelect;
      updateToolbar();
    });
    $('#chipSnap').addEventListener('click', function () {
      M.state.snapToGrid = !M.state.snapToGrid;
      M.savePrefs();
      updateToolbar();
    });

    $('#scrim').addEventListener('click', function () {
      openDrawer(false);
      openValSheet(false);
    });
    $('#drawerClose').addEventListener('click', function () { openDrawer(false); });
    $('#projNameBtn').addEventListener('click', function () {
      promptDialog('Название проекта', M.state.project.name).then(function (v) {
        if (v) M.renameProject(v);
      });
    });
    $('#btnAddDiagram').addEventListener('click', function () {
      promptDialog('Название диаграммы', '').then(function (v) {
        if (v === null) return;
        M.createDiagram(v || undefined);
        RR.renderer.fitToContent();
        openDrawer(false);
      });
    });

    const presetHost = $('#presetList');
    RR.presets.list.forEach(function (p) {
      const btn = document.createElement('button');
      btn.className = 'preset-btn';
      btn.innerHTML = '<span class="p-name">' + esc(p.name) + '</span><span class="p-desc">' + esc(p.desc) + '</span>';
      btn.addEventListener('click', function () {
        confirmDialog('Загрузить пресет «' + p.name + '»? Текущий проект будет заменён (отменяется через undo).', 'Загрузить')
          .then(function (ok) {
            if (!ok) return;
            app.loadPreset(p.id);
            openDrawer(false);
          });
      });
      presetHost.appendChild(btn);
    });

    $('#valClose').addEventListener('click', function () { openValSheet(false); });
    $('#propsClose').addEventListener('click', function () { M.clearSelection(); });
    $('#propsCollapse').addEventListener('click', function () {
      $('#propsSheet').classList.toggle('collapsed');
    });
    makeSheetDraggable($('#propsSheet'));
    makeSheetDraggable($('#trvSheet'));
    $('#btnTrvStop').addEventListener('click', trvStop);
  }

  function makeSheetDraggable(sheet) {
    if (!sheet) return;
    const handle = sheet.querySelector('.sheet-head');
    if (!handle) return;
    let drag = null;
    handle.addEventListener('pointerdown', function (e) {
      if (e.target instanceof Element && e.target.closest('button, input, select, textarea')) return;
      const rect = sheet.getBoundingClientRect();
      drag = {
        x0: e.clientX,
        y0: e.clientY,
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      };
      sheet.classList.add('dragging');
      sheet.style.left = rect.left + 'px';
      sheet.style.top = rect.top + 'px';
      sheet.style.right = 'auto';
      sheet.style.bottom = 'auto';
      sheet.style.width = rect.width + 'px';
      sheet.style.transform = 'none';
      drag.pointerId = e.pointerId;
      document.addEventListener('pointermove', onDragMove);
      document.addEventListener('pointerup', endDrag);
      document.addEventListener('pointercancel', endDrag);
      e.preventDefault();
    });
    function onDragMove(e) {
      if (!drag) return;
      if (e.pointerId !== drag.pointerId) return;
      const maxLeft = Math.max(0, window.innerWidth - drag.width);
      const maxTop = Math.max(0, window.innerHeight - drag.height);
      const left = RR.util.clamp(drag.left + e.clientX - drag.x0, 0, maxLeft);
      const top = RR.util.clamp(drag.top + e.clientY - drag.y0, 0, maxTop);
      sheet.style.left = left + 'px';
      sheet.style.top = top + 'px';
    }
    function endDrag(e) {
      if (!drag) return;
      if (e && e.pointerId !== drag.pointerId) return;
      drag = null;
      sheet.classList.remove('dragging');
      document.removeEventListener('pointermove', onDragMove);
      document.removeEventListener('pointerup', endDrag);
      document.removeEventListener('pointercancel', endDrag);
    }
  }

  /* ================= topbar / toolbar / hints ================= */
  function refreshAll() {
    updateTopbar();
    updateNavChip();
    updateToolbar();
    renderDrawer();
    refreshSheets();
    updateEmptyHint();
  }

  function updateTopbar() {
    const p = M.state.project;
    const d = M.getActiveDiagram();
    $('#projTitle').textContent = p ? p.name : '';
    $('#diagTitle').textContent = d ? d.name : 'Нет диаграммы';
    $('#btnUndo').disabled = !M.canUndo();
    $('#btnRedo').disabled = !M.canRedo();
    $('#btnWalk').classList.toggle('active', M.state.traversal.active);
  }

  function updateNavChip() {
    const stack = M.state.navigation.stack;
    const chip = $('#navChip');
    if (!stack.length) { chip.hidden = true; return; }
    const prev = M.getDiagram(stack[stack.length - 1]);
    $('#backLabel').textContent = prev ? prev.name : '…';
    chip.hidden = false;
  }

  function updateToolbar() {
    const st = M.state;
    $('#chipEdge').classList.toggle('active', st.mode === 'edge');
    $('#chipMulti').classList.toggle('active', st.multiSelect);
    $('#chipSnap').classList.toggle('active', st.snapToGrid);
  }

  function updateEmptyHint() {
    const d = M.getActiveDiagram();
    const hint = $('#emptyHint');
    if (!d) {
      hint.hidden = false;
      hint.textContent = 'Нет диаграмм. Откройте меню и создайте диаграмму.';
    } else if (!d.nodes.length) {
      hint.hidden = false;
      hint.textContent = 'Пустая диаграмма. Добавьте узлы кнопками внизу.';
    } else {
      hint.hidden = true;
    }
  }

  /* ================= навигация между диаграммами ================= */
  app.openDiagram = function (diagramId, opts) {
    opts = opts || {};
    const p = M.state.project;
    if (!M.getDiagram(diagramId)) return;
    if (opts.push && p.activeDiagramId && p.activeDiagramId !== diagramId) {
      M.state.navigation.stack.push(p.activeDiagramId);
    }
    M.setActiveDiagram(diagramId, opts);
    RR.renderer.focusDiagram(diagramId);
    openDrawer(false);
  };

  function navBack() {
    const stack = M.state.navigation.stack;
    let prev = null;
    while (stack.length && !prev) {
      const id = stack.pop();
      if (M.getDiagram(id)) prev = id;
    }
    if (prev) {
      M.setActiveDiagram(prev);
      RR.renderer.focusDiagram(prev);
    }
    updateNavChip();
  }

  /* ================= добавление узлов ================= */
  function addNodeAtCenter(kind) {
    let d = M.getActiveDiagram();
    if (!d) d = M.createDiagram(undefined, { withStartEnd: false });
    const def = RR.NODE_DEFAULTS[kind];
    const c = RR.renderer.viewportCenterDiagram(d.id);
    let x = c.x - def.width / 2, y = c.y - def.height / 2, tries = 0;
    while (tries < 24 && d.nodes.some(function (n) { return Math.abs(n.x - x) < 14 && Math.abs(n.y - y) < 14; })) {
      x += 26; y += 26; tries++;
    }
    M.createNode(d.id, kind, null, x, y);
  }

  /* ================= drawer (список диаграмм) ================= */
  function openDrawer(open) {
    $('#drawer').classList.toggle('open', open);
    updateScrim();
    if (open) renderDrawer();
  }

  function openValSheet(open) {
    const sheet = $('#valSheet');
    sheet.hidden = !open;
    updateScrim();
    if (open) renderValSheet();
  }

  function updateScrim() {
    const active = $('#drawer').classList.contains('open') || !$('#valSheet').hidden;
    $('#scrim').hidden = !active;
  }

  function renderDrawer() {
    const p = M.state.project;
    if (!p) return;
    $('#projNameBtn').textContent = p.name;
    const refs = T.getAllNonterminalRefs(p);
    const counts = V.countsByDiagram(M.state.issues);
    const host = $('#diagramList');
    host.textContent = '';

    p.diagrams.forEach(function (d) {
      const item = document.createElement('div');
      item.className = 'd-item' + (d.id === p.activeDiagramId ? ' active' : '');
      const outN = refs.filter(function (r) { return r.diagramId === d.id; }).length;
      const inN = refs.filter(function (r) { return r.resolvedId === d.id; }).length;
      const c = counts[d.id] || { error: 0, warning: 0 };
      item.innerHTML =
        '<button class="d-open">' +
        '<span class="d-name">' + esc(d.name) + '</span>' +
        '<span class="d-meta">' + d.nodes.length + ' узл. · ' + d.edges.length + ' связ. · ↦' + outN + ' ↤' + inN + '</span>' +
        '</button>' +
        '<span class="d-badges">' +
        (c.error ? '<span class="badge err">' + c.error + '</span>' : '') +
        (c.warning ? '<span class="badge warn">' + c.warning + '</span>' : '') +
        '</span>' +
        '<button class="icon-btn sm d-rename" aria-label="Переименовать"><svg class="icon"><use href="#i-pencil"/></svg></button>' +
        '<button class="icon-btn sm d-del" aria-label="Удалить"><svg class="icon"><use href="#i-trash"/></svg></button>';
      item.querySelector('.d-open').addEventListener('click', function () {
        app.openDiagram(d.id, { push: d.id !== p.activeDiagramId });
      });
      item.querySelector('.d-rename').addEventListener('click', function () {
        promptDialog('Название диаграммы', d.name).then(function (v) {
          if (v) M.renameDiagram(d.id, v);
        });
      });
      item.querySelector('.d-del').addEventListener('click', function () {
        confirmDialog('Удалить диаграмму «' + d.name + '»?', 'Удалить').then(function (ok) {
          if (ok) M.deleteDiagram(d.id);
        });
      });
      host.appendChild(item);
    });

    const refsHost = $('#refsList');
    refsHost.textContent = '';
    if (!refs.length) {
      refsHost.innerHTML = '<div class="muted">Нетерминальных ссылок нет.</div>';
    }
    refs.forEach(function (r) {
      const row = document.createElement('button');
      row.className = 'ref-row' + (r.resolvedId ? '' : ' broken');
      row.innerHTML = '<span class="ref-from">' + esc(r.diagramName) + ' · ' + esc(r.label) + '</span>' +
        '<span class="ref-to">→ ' + esc(r.resolvedName || 'не найдена') + '</span>';
      row.addEventListener('click', function () {
        app.openDiagram(r.diagramId, { push: r.diagramId !== p.activeDiagramId });
        M.select({ type: 'node', id: r.nodeId }, false);
        RR.renderer.centerOnNode(r.nodeId);
      });
      refsHost.appendChild(row);
    });
  }

  /* ================= панель проверки ================= */
  const LEVEL_LABELS = { error: 'Ошибка', warning: 'Предупреждение', info: 'Инфо' };

  function renderValSheet() {
    const issues = M.state.issues;
    const errs = issues.filter(function (i) { return i.level === 'error'; }).length;
    const warns = issues.filter(function (i) { return i.level === 'warning'; }).length;
    $('#valTitle').textContent = issues.length
      ? 'Проверка: ' + errs + ' ошиб., ' + warns + ' предупр.'
      : 'Проверка: всё в порядке ✓';
    const host = $('#valBody');
    host.textContent = '';
    if (!issues.length) {
      host.innerHTML = '<div class="muted pad">Ошибок и предупреждений не найдено.</div>';
      return;
    }
    issues.forEach(function (it) {
      const d = it.diagramId ? M.getDiagram(it.diagramId) : null;
      const row = document.createElement('button');
      row.className = 'issue-row level-' + it.level;
      row.innerHTML =
        '<span class="issue-dot"></span>' +
        '<span class="issue-text"><span class="issue-code">' + esc(it.code) + (d ? ' · ' + esc(d.name) : '') + '</span>' +
        '<span class="issue-msg">' + esc(it.message) + '</span></span>';
      row.addEventListener('click', function () { focusIssue(it); });
      host.appendChild(row);
    });
  }

  function focusIssue(it) {
    openValSheet(false);
    if (it.diagramId && it.diagramId !== M.state.project.activeDiagramId && M.getDiagram(it.diagramId)) {
      app.openDiagram(it.diagramId, { push: true });
    }
    if (it.nodeId && M.findNode(it.nodeId)) {
      M.select({ type: 'node', id: it.nodeId }, false);
      RR.renderer.centerOnNode(it.nodeId);
    } else if (it.edgeId && M.findEdge(it.edgeId)) {
      M.select({ type: 'edge', id: it.edgeId }, false);
      RR.renderer.centerOnEdge(it.edgeId);
    }
  }

  /* ================= нижние sheets: свойства / обход ================= */
  function refreshSheets() {
    const st = M.state;
    const trv = $('#trvSheet');
    const props = $('#propsSheet');
    if (st.traversal.active) {
      trv.hidden = false;
      props.hidden = true;
      renderTrvSheet();
      return;
    }
    trv.hidden = true;
    const count = M.selectionCount();
    props.hidden = !count;
    if (count) renderPropsSheet();
  }

  function anchorSelect(name, value) {
    const opts = ['left', 'right', 'top', 'bottom'].map(function (a) {
      return '<option value="' + a + '"' + (a === value ? ' selected' : '') + '>' + a + '</option>';
    }).join('');
    return '<select data-f="' + name + '">' + opts + '</select>';
  }

  function renderPropsSheet() {
    const st = M.state;
    const sel = st.selected;
    const d = M.getActiveDiagram();
    const body = $('#propsBody');
    const title = $('#propsTitle');

    if (sel.nodeIds.length === 1 && !sel.edgeIds.length) {
      const node = T.getNodeById(d, sel.nodeIds[0]);
      if (!node) return;
      title.textContent = RR.NODE_KIND_LABELS[node.kind] + ' · ' + (node.label || '—');
      const kindOpts = RR.NODE_KINDS.map(function (k) {
        return '<option value="' + k + '"' + (k === node.kind ? ' selected' : '') + '>' + RR.NODE_KIND_LABELS[k] + '</option>';
      }).join('');
      const showTarget = ['nonterminal', 'repeat', 'optional'].indexOf(node.kind) >= 0;
      const targetOpts = '<option value="">— нет —</option>' + M.state.project.diagrams.map(function (dd) {
        return '<option value="' + esc(dd.id) + '"' + (dd.id === node.targetDiagramId ? ' selected' : '') + '>' + esc(dd.name) + '</option>';
      }).join('');
      const target = T.resolveNodeTarget(M.state.project, node);
      body.innerHTML =
        '<div class="f-grid">' +
        '<label>label<input type="text" data-f="label" value="' + esc(node.label) + '"></label>' +
        '<label>тип<select data-f="kind">' + kindOpts + '</select></label>' +
        '<label>x<input type="number" data-f="x" value="' + node.x + '"></label>' +
        '<label>y<input type="number" data-f="y" value="' + node.y + '"></label>' +
        '<label>width<input type="number" data-f="width" min="24" value="' + node.width + '"></label>' +
        '<label>height<input type="number" data-f="height" min="24" value="' + node.height + '"></label>' +
        (showTarget ? '<label class="wide">target diagram<select data-f="targetDiagramId">' + targetOpts + '</select></label>' : '') +
        '</div>' +
        '<div class="f-id">id: <code>' + esc(node.id) + '</code></div>' +
        '<div class="f-actions">' +
        (target ? '<button class="btn" data-act="open">Открыть «' + esc(target.name) + '»</button>' : '') +
        '<button class="btn" data-act="dup">Дублировать</button>' +
        '<button class="btn danger" data-act="del">Удалить</button>' +
        '</div>';
      bindField(body, 'label', function (v) { M.updateNode(node.id, { label: v }); });
      bindField(body, 'kind', function (v) { M.updateNode(node.id, { kind: v }); });
      ['x', 'y', 'width', 'height'].forEach(function (f) {
        bindField(body, f, function (v) {
          const num = parseFloat(v);
          if (!isNaN(num)) {
            const patch = {};
            patch[f] = Math.round(num);
            M.updateNode(node.id, patch);
          }
        });
      });
      if (showTarget) bindField(body, 'targetDiagramId', function (v) { M.updateNode(node.id, { targetDiagramId: v || null }); });
      bindAct(body, 'open', function () { if (target) app.openDiagram(target.id, { push: true }); });
      bindAct(body, 'dup', function () { M.duplicateNode(d.id, node.id); });
      bindAct(body, 'del', function () { M.deleteNode(d.id, node.id); });
      return;
    }

    if (sel.edgeIds.length === 1 && !sel.nodeIds.length) {
      const edge = d.edges.find(function (e) { return e.id === sel.edgeIds[0]; });
      if (!edge) return;
      const from = T.getNodeById(d, edge.fromNodeId);
      const to = T.getNodeById(d, edge.toNodeId);
      title.textContent = 'Связь: ' + (from ? from.label : '?') + ' → ' + (to ? to.label : '?');
      body.innerHTML =
        '<div class="f-grid">' +
        '<label class="wide">label<input type="text" data-f="label" value="' + esc(edge.label || '') + '"></label>' +
        '<label>from anchor' + anchorSelect('fromAnchor', edge.fromAnchor) + '</label>' +
        '<label>to anchor' + anchorSelect('toAnchor', edge.toAnchor) + '</label>' +
        '</div>' +
        '<div class="f-id">id: <code>' + esc(edge.id) + '</code> · from <code>' + esc(edge.fromNodeId) + '</code> · to <code>' + esc(edge.toNodeId) + '</code></div>' +
        '<div class="f-actions">' +
        '<button class="btn" data-act="rev">Развернуть направление</button>' +
        '<button class="btn danger" data-act="del">Удалить</button>' +
        '</div>';
      bindField(body, 'label', function (v) { M.updateEdge(edge.id, { label: v || null }); });
      bindField(body, 'fromAnchor', function (v) { M.updateEdge(edge.id, { fromAnchor: v }); });
      bindField(body, 'toAnchor', function (v) { M.updateEdge(edge.id, { toAnchor: v }); });
      bindAct(body, 'rev', function () { reverseEdge(edge.id); });
      bindAct(body, 'del', function () { M.deleteEdge(d.id, edge.id); });
      return;
    }

    title.textContent = 'Выбрано: ' + sel.nodeIds.length + ' узл. + ' + sel.edgeIds.length + ' связ.';
    body.innerHTML =
      '<div class="f-actions">' +
      '<button class="btn danger" data-act="del">Удалить выбранное</button>' +
      '<button class="btn" data-act="clear">Снять выделение</button>' +
      '</div>';
    bindAct(body, 'del', function () { M.deleteSelection(); });
    bindAct(body, 'clear', function () { M.clearSelection(); });
  }

  function bindField(root, name, fn) {
    const input = root.querySelector('[data-f="' + name + '"]');
    if (input) input.addEventListener('change', function () { fn(input.value); });
  }
  function bindAct(root, name, fn) {
    const btn = root.querySelector('[data-act="' + name + '"]');
    if (btn) btn.addEventListener('click', fn);
  }

  function reverseEdge(edgeId) {
    const found = M.findEdge(edgeId);
    if (!found) return;
    const e = found.edge;
    M.updateEdge(edgeId, {
      fromNodeId: e.toNodeId,
      toNodeId: e.fromNodeId,
      fromAnchor: e.toAnchor,
      toAnchor: e.fromAnchor,
    });
  }

  /* ================= обход (traversal) ================= */
  app.isTrvNext = function (nodeId) {
    const st = M.state;
    if (!st.traversal.active || !st.traversal.nodeId) return false;
    const d = M.getActiveDiagram();
    return T.getNextNodes(d, st.traversal.nodeId).some(function (n) { return n.id === nodeId; });
  };

  function trvStart(fromNodeId) {
    const d = M.getActiveDiagram();
    if (!d) { app.toast('Нет активной диаграммы'); return; }
    let node = fromNodeId ? T.getNodeById(d, fromNodeId) : null;
    if (!node) {
      node = d.nodes.find(function (n) { return n.kind === 'start'; }) ||
        T.getNodeById(d, d.entryNodeId);
    }
    if (!node) { app.toast('В диаграмме нет start-узла'); return; }
    M.state.traversal = { active: true, nodeId: node.id, returnStack: [] };
    M.clearSelection();
    RR.renderer.refreshDecorations();
    RR.renderer.centerOnNode(node.id);
    refreshSheets();
    updateTopbar();
  }
  app.trvStart = trvStart;

  function trvStop() {
    M.state.traversal = { active: false, nodeId: null, returnStack: [] };
    RR.renderer.refreshDecorations();
    refreshSheets();
    updateTopbar();
  }

  app.trvGoto = function (nodeId) {
    M.state.traversal.nodeId = nodeId;
    RR.renderer.refreshDecorations();
    RR.renderer.centerOnNode(nodeId);
    refreshSheets();
  };

  function trvEnter() {
    const st = M.state;
    const d = M.getActiveDiagram();
    const node = T.getNodeById(d, st.traversal.nodeId);
    const target = node ? T.resolveNodeTarget(st.project, node) : null;
    if (!target) return;
    st.traversal.returnStack.push({ diagramId: d.id, nodeId: node.id });
    app.openDiagram(target.id, { push: true, keepTraversal: true });
    const start = target.nodes.find(function (n) { return n.kind === 'start'; }) ||
      T.getNodeById(target, target.entryNodeId);
    st.traversal.nodeId = start ? start.id : null;
    RR.renderer.refreshDecorations();
    refreshSheets();
    if (start) RR.renderer.centerOnNode(start.id);
  }

  function trvReturn() {
    const st = M.state;
    const fr = st.traversal.returnStack.pop();
    if (!fr || !M.getDiagram(fr.diagramId)) return;
    app.openDiagram(fr.diagramId, { keepTraversal: true });
    st.traversal.nodeId = fr.nodeId;
    RR.renderer.refreshDecorations();
    refreshSheets();
    RR.renderer.centerOnNode(fr.nodeId);
  }

  function renderTrvSheet() {
    const st = M.state;
    const d = M.getActiveDiagram();
    const node = d ? T.getNodeById(d, st.traversal.nodeId) : null;
    $('#trvTitle').textContent = 'Обход · ' + (d ? d.name : '—');
    const body = $('#trvBody');
    if (!node) {
      body.innerHTML = '<div class="muted">Текущий узел не найден.</div>';
      return;
    }
    const next = T.getNextNodes(d, node.id);
    const target = T.resolveNodeTarget(st.project, node);
    let html = '<div class="trv-cur"><span class="trv-kind">' + esc(RR.NODE_KIND_LABELS[node.kind]) + '</span> ' + esc(node.label || '—') + '</div>';
    if (next.length) {
      html += '<div class="trv-next-label">Дальше:</div><div class="trv-next-list">' +
        next.map(function (n) {
          return '<button class="btn trv-step" data-id="' + esc(n.id) + '">→ ' + esc(n.label || n.kind) + '</button>';
        }).join('') + '</div>';
    } else {
      html += '<div class="muted">' + (node.kind === 'end' ? 'Достигнут конец диаграммы ✓' : 'Дальше пути нет (тупик).') + '</div>';
    }
    html += '<div class="f-actions">' +
      (target ? '<button class="btn" data-act="enter">↘ Войти в «' + esc(target.name) + '»</button>' : '') +
      (st.traversal.returnStack.length
        ? '<button class="btn" data-act="return">↩ Вернуться</button>' : '') +
      '<button class="btn" data-act="restart">Заново</button>' +
      '</div>';
    body.innerHTML = html;
    $$('#trvBody .trv-step').forEach(function (btn) {
      btn.addEventListener('click', function () { app.trvGoto(btn.getAttribute('data-id')); });
    });
    bindAct(body, 'enter', trvEnter);
    bindAct(body, 'return', trvReturn);
    bindAct(body, 'restart', function () { trvStart(); });
  }

  /* ================= контекстное меню ================= */
  app.showContextMenu = function (hit, x, y) {
    const st = M.state;
    if (hit.diagramId && st.project.activeDiagramId !== hit.diagramId) {
      M.setActiveDiagram(hit.diagramId);
    }
    const d = hit.diagramId ? M.getDiagram(hit.diagramId) : M.getActiveDiagram();
    const items = [];

    if (hit.type === 'node' && d) {
      const found = M.findNode(hit.id);
      const node = found ? found.node : T.getNodeById(d, hit.id);
      const nodeDiagram = found ? found.diagram : d;
      if (!node || !nodeDiagram) return;
      const target = T.resolveNodeTarget(st.project, node);
      items.push({ label: 'Переименовать', fn: function () { app.editLabelFor(hit); } });
      items.push({ label: 'Дублировать', fn: function () { M.duplicateNode(nodeDiagram.id, node.id); } });
      items.push({
        label: 'Соединить отсюда →', fn: function () {
          st.mode = 'edge';
          st.pendingEdgeFrom = node.id;
          updateToolbar();
          RR.renderer.refreshDecorations();
          app.toast('Коснитесь второго узла — конца стрелки');
        },
      });
      if (target) items.push({ label: 'Открыть «' + target.name + '»', fn: function () { app.openDiagram(target.id, { push: true }); } });
      items.push({ label: 'Начать обход отсюда', fn: function () { trvStart(node.id); } });
      items.push({ label: 'Сменить тип…', fn: function () { changeTypeFlow(node); } });
      items.push({ label: 'Удалить', danger: true, fn: function () { M.deleteNode(nodeDiagram.id, node.id); } });
    } else if (hit.type === 'edge' && d) {
      const found = M.findEdge(hit.id);
      const edgeDiagram = found ? found.diagram : d;
      items.push({ label: 'Метка…', fn: function () { app.editLabelFor(hit); } });
      items.push({ label: 'Развернуть направление', fn: function () { reverseEdge(hit.id); } });
      items.push({ label: 'Удалить', danger: true, fn: function () { if (edgeDiagram) M.deleteEdge(edgeDiagram.id, hit.id); } });
    } else {
      const targetDiagram = hit.diagramId ? M.getDiagram(hit.diagramId) : d;
      const world = RR.renderer.screenToWorld(x, y);
      const local = targetDiagram ? RR.renderer.worldToDiagram(targetDiagram.id, world) : world;
      items.push({
        label: 'Добавить узел…', fn: function () {
          choiceDialog('Тип узла', RR.NODE_KINDS.map(function (k) {
            return { label: RR.NODE_KIND_LABELS[k], value: k };
          })).then(function (kind) {
            if (!kind || !targetDiagram) return;
            const def = RR.NODE_DEFAULTS[kind];
            M.createNode(targetDiagram.id, kind, null, local.x - def.width / 2, local.y - def.height / 2);
          });
        },
      });
      items.push({ label: 'Вписать в экран', fn: function () { RR.renderer.fitToContent(); } });
    }

    const menu = $('#ctxMenu');
    menu.textContent = '';
    items.forEach(function (it) {
      const btn = document.createElement('button');
      btn.className = 'ctx-item' + (it.danger ? ' danger' : '');
      btn.textContent = it.label;
      btn.addEventListener('click', function () {
        hideCtxMenu();
        it.fn();
      });
      menu.appendChild(btn);
    });
    menu.hidden = false;
    // клампим в границы окна
    menu.style.left = '0px';
    menu.style.top = '0px';
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.min(Math.max(8, x), window.innerWidth - rect.width - 8) + 'px';
    menu.style.top = Math.min(Math.max(8, y), window.innerHeight - rect.height - 8) + 'px';
    setTimeout(function () {
      document.addEventListener('pointerdown', ctxOutside, { capture: true, once: true });
    }, 0);
  };

  function ctxOutside(e) {
    const menu = $('#ctxMenu');
    if (!menu.hidden && !(e.target instanceof Element && menu.contains(e.target))) hideCtxMenu();
  }
  function hideCtxMenu() { $('#ctxMenu').hidden = true; }

  function changeTypeFlow(node) {
    choiceDialog('Тип узла', RR.NODE_KINDS.map(function (k) {
      return { label: RR.NODE_KIND_LABELS[k] + (k === node.kind ? ' · текущий' : ''), value: k };
    })).then(function (kind) {
      if (kind && kind !== node.kind) M.updateNode(node.id, { kind: kind });
    });
  }

  app.editLabelFor = function (hit) {
    if (hit.type === 'node') {
      const found = M.findNode(hit.id);
      if (!found) return;
      promptDialog('Метка узла', found.node.label).then(function (v) {
        if (v !== null) M.updateNode(hit.id, { label: v });
      });
    } else if (hit.type === 'edge') {
      const found = M.findEdge(hit.id);
      if (!found) return;
      promptDialog('Метка связи', found.edge.label || '').then(function (v) {
        if (v !== null) M.updateEdge(hit.id, { label: v || null });
      });
    }
  };

  app.escape = function () {
    hideCtxMenu();
    if (!$('#modal').hidden) { closeModal(null); return; }
    if (!$('#valSheet').hidden) { openValSheet(false); return; }
    if ($('#drawer').classList.contains('open')) { openDrawer(false); return; }
    if (M.state.mode === 'edge') {
      M.state.mode = 'select';
      M.state.pendingEdgeFrom = null;
      updateToolbar();
      RR.renderer.refreshDecorations();
      return;
    }
    M.clearSelection();
  };

  /* ================= диалоги ================= */
  let modalResolve = null;

  function openModalHtml(html) {
    const modal = $('#modal');
    $('#modalCard').innerHTML = html;
    modal.hidden = false;
    return new Promise(function (resolve) { modalResolve = resolve; });
  }

  function closeModal(value) {
    const modal = $('#modal');
    modal.hidden = true;
    if (modalResolve) {
      const r = modalResolve;
      modalResolve = null;
      r(value);
    }
  }
  app.closeModal = closeModal;

  document.addEventListener('DOMContentLoaded', function () {
    $('#modal').addEventListener('pointerdown', function (e) {
      if (e.target === $('#modal')) closeModal(null);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('#modal').hidden) closeModal(null);
    });
  });

  function promptDialog(title, value, placeholder) {
    const p = openModalHtml(
      '<h3>' + esc(title) + '</h3>' +
      '<input type="text" id="modalInput" value="' + esc(value || '') + '" placeholder="' + esc(placeholder || '') + '">' +
      '<div class="modal-actions">' +
      '<button class="btn ghost" data-v="cancel">Отмена</button>' +
      '<button class="btn primary" data-v="ok">OK</button>' +
      '</div>'
    );
    const input = $('#modalInput');
    input.focus();
    input.select();
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') closeModal(input.value.trim());
    });
    $('#modalCard [data-v="ok"]').addEventListener('click', function () { closeModal(input.value.trim()); });
    $('#modalCard [data-v="cancel"]').addEventListener('click', function () { closeModal(null); });
    return p;
  }

  function confirmDialog(message, okLabel) {
    const p = openModalHtml(
      '<h3>Подтверждение</h3>' +
      '<p class="modal-text">' + esc(message) + '</p>' +
      '<div class="modal-actions">' +
      '<button class="btn ghost" data-v="cancel">Отмена</button>' +
      '<button class="btn primary" data-v="ok">' + esc(okLabel || 'OK') + '</button>' +
      '</div>'
    ).then(function (v) { return v === true; });
    $('#modalCard [data-v="ok"]').addEventListener('click', function () { closeModal(true); });
    $('#modalCard [data-v="cancel"]').addEventListener('click', function () { closeModal(null); });
    return p;
  }

  function choiceDialog(title, options) {
    const p = openModalHtml(
      '<h3>' + esc(title) + '</h3>' +
      '<div class="modal-choices">' +
      options.map(function (o, i) {
        return '<button class="choice-btn" data-i="' + i + '">' +
          '<span>' + esc(o.label) + '</span>' +
          (o.desc ? '<span class="c-desc">' + esc(o.desc) + '</span>' : '') +
          '</button>';
      }).join('') +
      '</div>' +
      '<div class="modal-actions"><button class="btn ghost" data-v="cancel">Отмена</button></div>'
    );
    $$('#modalCard .choice-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        closeModal(options[parseInt(btn.getAttribute('data-i'), 10)].value);
      });
    });
    $('#modalCard [data-v="cancel"]').addEventListener('click', function () { closeModal(null); });
    return p;
  }

  /* ================= new / import / export ================= */
  function newProjectFlow() {
    confirmDialog('Создать новый проект? Текущий будет заменён (localStorage перезапишется при следующем изменении).', 'Создать')
      .then(function (ok) {
        if (!ok) return null;
        return promptDialog('Название проекта', 'Без названия');
      })
      .then(function (name) {
        if (name === null || name === undefined) return;
        M.newProject(name || 'Без названия');
        RR.renderer.fitToContent();
      });
  }

  function showImportDialog() {
    openModalHtml(
      '<h3>Импорт проекта</h3>' +
      '<p class="modal-text">Файл <code>.rrjson</code> / <code>.json</code>, standalone-HTML с встроенным проектом — или вставьте JSON в поле.</p>' +
      '<label class="file-label"><input type="file" id="impFile" accept=".rrjson,.json,.html,application/json,text/html" hidden>' +
      '<span class="btn">Выбрать файл…</span><span id="impFileName" class="muted">файл не выбран</span></label>' +
      '<textarea id="impText" rows="7" placeholder="{ &quot;version&quot;: &quot;1.0.0&quot;, … }"></textarea>' +
      '<div id="impErrors" class="imp-errors" hidden></div>' +
      '<div class="modal-actions">' +
      '<button class="btn ghost" data-v="cancel">Отмена</button>' +
      '<button class="btn primary" data-v="ok">Импортировать</button>' +
      '</div>'
    );
    let fileText = null;
    $('#impFile').addEventListener('change', function () {
      const f = this.files && this.files[0];
      if (!f) return;
      IO.readFile(f).then(function (text) {
        fileText = text;
        $('#impFileName').textContent = f.name;
      });
    });
    $('#modalCard [data-v="cancel"]').addEventListener('click', function () { closeModal(null); });
    $('#modalCard [data-v="ok"]').addEventListener('click', function () {
      const pasted = $('#impText').value.trim();
      const text = pasted || fileText;
      if (!text) {
        showImpErrors(['Выберите файл или вставьте JSON.']);
        return;
      }
      const res = IO.importFromText(text);
      if (!res.ok) {
        showImpErrors(res.errors);
        return;
      }
      closeModal(true);
      RR.renderer.fitToContent();
      const errs = M.state.issues.filter(function (i) { return i.level === 'error'; }).length;
      app.toast('Проект импортирован');
      if (errs) openValSheet(true);
    });
  }

  function showImpErrors(errors) {
    const box = $('#impErrors');
    box.hidden = false;
    box.innerHTML = '<b>Импорт отклонён:</b><br>' + errors.slice(0, 12).map(esc).join('<br>') +
      (errors.length > 12 ? '<br>… и ещё ' + (errors.length - 12) : '');
  }

  function showExportDialog() {
    choiceDialog('Экспорт', [
      { label: 'Проект → .rrjson', value: 'rrjson', desc: 'полный проект во внутреннем формате' },
      { label: 'Активная диаграмма → SVG', value: 'svg' },
      { label: 'Активная диаграмма → PNG', value: 'png' },
      { label: 'Активная диаграмма → HTML', value: 'htmlview', desc: 'страница с embedded SVG' },
      { label: 'Проект → standalone HTML', value: 'standalone', desc: 'все диаграммы + embedded JSON, импортируется обратно' },
    ]).then(function (v) {
      if (!v) return;
      if (v === 'rrjson') IO.downloadRRJSON();
      else if (v === 'svg') IO.downloadSVG();
      else if (v === 'png') {
        IO.downloadPNG().catch(function (e) { app.toast('PNG: ' + e.message); });
      }
      else if (v === 'htmlview') IO.downloadHtmlView();
      else if (v === 'standalone') IO.downloadStandaloneHtml();
    });
  }

  /* ================= presets / toast ================= */
  app.loadPreset = function (idOrName) {
    let preset = RR.presets.list.find(function (p) { return p.id === idOrName || p.name === idOrName; });
    if (!preset) return false;
    const project = RR.presets.build(preset.id);
    M.setProject(project, { reason: 'preset' });
    RR.renderer.fitToContent();
    app.toast('Пресет «' + preset.name + '» загружен');
    return true;
  };

  app.toast = function (msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2400);
  };

  /* ================= публичный API по ТЗ (§12) ================= */
  RR.api = {
    createProject: function (name) { M.newProject(name); },
    createDiagram: function (name) { return M.createDiagram(name); },
    deleteDiagram: function (id) { M.deleteDiagram(id); },
    renameDiagram: function (id, name) { M.renameDiagram(id, name); },
    createNode: function (diagramId, kind, label, x, y) { return M.createNode(diagramId, kind, label, x, y); },
    updateNode: function (nodeId, patch) { M.updateNode(nodeId, patch); },
    deleteNode: function (diagramId, nodeId) { M.deleteNode(diagramId, nodeId); },
    createEdge: function (diagramId, fromNodeId, toNodeId) { return M.createEdge(diagramId, fromNodeId, toNodeId); },
    createAnchorOnEdge: function (edgeId, x, y) { return M.createAnchorOnEdge(edgeId, x, y); },
    deleteEdge: function (diagramId, edgeId) { M.deleteEdge(diagramId, edgeId); },
    setActiveDiagram: function (id) { M.setActiveDiagram(id); },
    validateProject: function (project) { return V.validateProject(project || M.state.project); },
    exportProjectJson: function (project) { return IO.exportProjectJson(project || M.state.project); },
    importProjectJson: function (json) { return IO.importFromText(json); },
    exportActiveDiagramSvg: function () { return IO.downloadSVG(); },
    exportActiveDiagramPng: function () { return IO.downloadPNG(); },
    loadPreset: function (name) { return app.loadPreset(name); },
  };
})();
