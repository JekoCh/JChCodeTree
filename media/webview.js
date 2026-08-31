(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('tree');
  const pendingClicks = new Map();
  const DOUBLE_CLICK_GUARD_MS = 220;

  function iconClassFor(kind) {
    if (kind === 'folder') return 'codicon-folder';
    if (kind === 'file') return 'codicon-file';
    return 'codicon-symbol-method';
  }

  function cssEscape(id) {
    return id.replace(/["\\]/g, '\\$&');
  }

  function findLi(id) {
    return root.querySelector('li[data-id="' + cssEscape(id) + '"]');
  }

  function makeRow(node) {
    const li = document.createElement('li');
    li.dataset.id = node.id;
    li.dataset.kind = node.kind;
    li.dataset.hasChildren = String(node.hasChildren);
    li.dataset.loaded = 'false';

    const row = document.createElement('div');
    row.className = 'row';
    row.setAttribute('role', 'treeitem');

    const twisty = document.createElement('span');
    twisty.className = 'twisty' + (node.hasChildren ? '' : ' empty');
    twisty.textContent = '\u25B8';
    row.appendChild(twisty);

    const icon = document.createElement('span');
    icon.className = 'codicon ' + iconClassFor(node.kind) + ' icon ' + node.kind;
    row.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = node.label;
    row.appendChild(label);

    li.appendChild(row);

    if (node.hasChildren) {
      const childList = document.createElement('ul');
      childList.setAttribute('role', 'group');
      li.appendChild(childList);
    }

    row.addEventListener('click', () => onClick(node, li));
    row.addEventListener('dblclick', () => onDblClick(node, li));

    return li;
  }

  function onClick(node, li) {
    if (node.kind === 'function') {
      vscode.postMessage({ type: 'open', id: node.id });
      return;
    }
    const timer = setTimeout(() => {
      pendingClicks.delete(node.id);
      toggleExpand(node, li);
    }, DOUBLE_CLICK_GUARD_MS);
    pendingClicks.set(node.id, timer);
  }

  function onDblClick(node, li) {
    const timer = pendingClicks.get(node.id);
    if (timer) {
      clearTimeout(timer);
      pendingClicks.delete(node.id);
    }
    if (node.kind === 'file') {
      vscode.postMessage({ type: 'open', id: node.id });
    }
  }

  function toggleExpand(node, li) {
    if (!node.hasChildren) return;
    const expanded = li.classList.toggle('expanded');
    if (expanded && li.dataset.loaded !== 'true') {
      vscode.postMessage({ type: 'expand', id: node.id });
    }
  }

  function renderChildren(container, children) {
    container.innerHTML = '';
    for (const child of children) {
      container.appendChild(makeRow(child));
    }
  }

  function expandChainAndHighlight(pathIds) {
    const prevActive = root.querySelector('.row.active');
    if (prevActive) prevActive.classList.remove('active');
    if (!pathIds || pathIds.length === 0) return;

    for (let i = 0; i < pathIds.length - 1; i++) {
      const li = findLi(pathIds[i]);
      if (!li) return;
      if (li.dataset.hasChildren === 'true' && !li.classList.contains('expanded')) {
        li.classList.add('expanded');
        if (li.dataset.loaded !== 'true') {
          vscode.postMessage({ type: 'expand', id: pathIds[i], awaitingPath: pathIds.slice(i + 1) });
          return; // resumes from the 'children' handler once this level loads
        }
      }
    }

    const leafLi = findLi(pathIds[pathIds.length - 1]);
    if (leafLi) {
      leafLi.querySelector(':scope > .row').classList.add('active');
      leafLi.scrollIntoView({ block: 'center' });
    }
  }

  window.addEventListener('message', event => {
    const message = event.data;
    switch (message.type) {
      case 'root':
        renderChildren(root, message.children);
        break;
      case 'children': {
        const li = findLi(message.id);
        if (!li) break;
        renderChildren(li.querySelector(':scope > ul'), message.children);
        li.dataset.loaded = 'true';
        if (message.awaitingPath) expandChainAndHighlight(message.awaitingPath);
        break;
      }
      case 'invalidated': {
        const li = findLi(message.id);
        if (li) {
          li.dataset.loaded = 'false';
          if (li.classList.contains('expanded')) {
            vscode.postMessage({ type: 'expand', id: message.id });
          }
        }
        break;
      }
      case 'reload':
        vscode.postMessage({ type: 'ready' });
        break;
      case 'highlight':
        expandChainAndHighlight(message.path);
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
