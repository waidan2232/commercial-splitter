// Small building blocks for the interface: elements, icons, tooltips, menus, dialogs, and talking to the server.
(function () {
  'use strict';

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  // ---------------------------------------------------------------- icons on buttons

  /** Gives every [data-icon] element its icon; button text moves into a span so it can change. */
  function applyIcons(root) {
    for (const el of (root || document).querySelectorAll('[data-icon]')) {
      if (el.dataset.iconDone) continue;
      el.dataset.iconDone = '1';
      const label = el.textContent.trim() ? h('span', { class: 'label' }) : null;
      if (label) {
        label.innerHTML = el.innerHTML;
        el.innerHTML = '';
      }
      el.insertAdjacentHTML('afterbegin', Icons.icon(el.dataset.icon));
      if (label) el.append(label);
    }
  }

  function setIcon(el, name) {
    const svg = el.querySelector('svg');
    if (svg) svg.outerHTML = Icons.icon(name);
    else el.insertAdjacentHTML('afterbegin', Icons.icon(name));
    el.dataset.icon = name;
  }

  function setLabel(el, text) {
    const label = el.querySelector('.label');
    if (label) label.textContent = text;
    else el.textContent = text;
  }

  // ---------------------------------------------------------------- tooltips (drawn by the app, not the system)

  let tipEl = null, tipTimer = 0, tipTarget = null;
  function hideTip() {
    clearTimeout(tipTimer);
    tipTarget = null;
    if (tipEl) { tipEl.remove(); tipEl = null; }
  }
  function initTooltips() {
    const adopt = (el) => {
      if (el.hasAttribute('title')) {
        el.dataset.tip = el.getAttribute('title');
        el.removeAttribute('title');
      }
    };
    document.querySelectorAll('[title]').forEach(adopt);
    new MutationObserver((list) => {
      for (const m of list) {
        if (m.type === 'attributes' && m.target.hasAttribute('title')) adopt(m.target);
        for (const n of m.addedNodes || []) if (n.nodeType === 1) { adopt(n); n.querySelectorAll('[title]').forEach(adopt); }
      }
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });

    document.addEventListener('mouseover', (e) => {
      const t = e.target.closest && e.target.closest('[data-tip]');
      if (t === tipTarget) return;
      hideTip();
      if (!t || !t.dataset.tip) return;
      tipTarget = t;
      tipTimer = setTimeout(() => {
        if (!document.body.contains(t)) return;
        tipEl = h('div', { class: 'tip', text: t.dataset.tip });
        document.body.append(tipEl);
        const r = t.getBoundingClientRect(), tr = tipEl.getBoundingClientRect();
        let x = Math.min(window.innerWidth - tr.width - 8, Math.max(8, r.left + r.width / 2 - tr.width / 2));
        let y = r.bottom + 6;
        if (y + tr.height > window.innerHeight - 8) y = r.top - tr.height - 6;
        tipEl.style.left = x + 'px';
        tipEl.style.top = y + 'px';
      }, 450);
    });
    document.addEventListener('mousedown', hideTip, true);
    document.addEventListener('keydown', hideTip, true);
    window.addEventListener('blur', hideTip);
  }

  // ---------------------------------------------------------------- menus

  let openMenu = null;

  function closeMenu() {
    if (openMenu) {
      const m = openMenu;
      openMenu = null;
      m.close();
    }
  }

  /**
   * Shows a menu. items: { text, key, bold, disabled, checked, action, hover } or '-' for a separator.
   * at: an element (the menu opens below it) or { x, y }.
   */
  function menu(items, at) {
    closeMenu();
    const el = h('div', { class: 'menu', tabindex: '-1', role: 'menu' });
    const rows = [];
    for (const it of items) {
      if (it === '-') { el.append(h('div', { class: 'menu-sep' })); continue; }
      const row = h('div', {
        class: 'menu-item' + (it.bold ? ' bold' : '') + (it.disabled ? ' disabled' : '') +
          (it.checked === true ? ' checked' : it.checked === false ? ' uncheck' : ''),
        role: 'menuitem',
      }, h('span', { class: 'menu-text', text: it.text }), it.key ? h('span', { class: 'menu-key', text: it.key }) : null);
      row.addEventListener('mouseenter', () => { setActive(rows.indexOf(entry)); if (it.hover) it.hover(); });
      row.addEventListener('click', () => choose(it));
      const entry = { row, it };
      rows.push(entry);
      el.append(row);
    }
    let active = -1;
    function setActive(i) {
      if (active >= 0 && rows[active]) rows[active].row.classList.remove('active');
      active = i;
      if (active >= 0 && rows[active]) {
        rows[active].row.classList.add('active');
        rows[active].row.scrollIntoView({ block: 'nearest' });
      }
    }
    function choose(it) {
      if (it.disabled) return;
      closeMenu();
      if (it.action) it.action();
    }
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); return; }
      const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
      if (step) {
        e.preventDefault();
        e.stopPropagation();
        let i = active;
        for (let n = 0; n < rows.length; n++) {
          i = (i + step + rows.length) % rows.length;
          if (!rows[i].it.disabled) break;
        }
        setActive(i);
        if (rows[i] && rows[i].it.hover) rows[i].it.hover();
      } else if (e.key === 'Enter' && active >= 0) {
        e.preventDefault();
        e.stopPropagation();
        choose(rows[active].it);
      }
    };
    const onDown = (e) => { if (!el.contains(e.target)) closeMenu(); };
    document.body.append(el);
    const r = el.getBoundingClientRect();
    let x, y;
    if (at instanceof Element) {
      const a = at.getBoundingClientRect();
      x = a.left;
      y = a.bottom + 4;
      if (y + r.height > window.innerHeight - 8) y = Math.max(8, a.top - r.height - 4);
    } else {
      x = at.x;
      y = at.y;
      if (y + r.height > window.innerHeight - 8) y = Math.max(8, y - r.height);
    }
    x = Math.max(8, Math.min(window.innerWidth - r.width - 8, x));
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => document.addEventListener('mousedown', onDown, true), 0);
    window.addEventListener('blur', closeMenu);
    window.addEventListener('resize', closeMenu);
    const previous = document.activeElement;
    el.focus({ preventScroll: true });
    openMenu = {
      close() {
        document.removeEventListener('keydown', onKey, true);
        document.removeEventListener('mousedown', onDown, true);
        window.removeEventListener('blur', closeMenu);
        window.removeEventListener('resize', closeMenu);
        el.remove();
        if (previous && previous.focus && document.body.contains(previous)) previous.focus({ preventScroll: true });
      },
    };
    return openMenu;
  }

  // ---------------------------------------------------------------- dialogs

  const dialogStack = [];

  /**
   * Shows a dialog and resolves with the value of the button pressed (null for Escape / closing).
   * buttons: [{ text, value, primary, left, disabled }]. body: a node or text.
   */
  function dialog({ title, body, buttons, wide, onOpen, cancelValue = null }) {
    closeMenu();
    hideTip();
    return new Promise((resolve) => {
      const btnEls = [];
      const content = typeof body === 'string' ? h('div', {}, ...body.split('\n\n').map((p) => h('p', { text: p }))) : body;
      const box = h('div', { class: 'dialog' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', tabindex: '-1' },
        title ? h('div', { class: 'dialog-title', text: title }) : null,
        h('div', { class: 'dialog-body' }, content),
        h('div', { class: 'dialog-buttons' }, (buttons || [{ text: 'OK', value: true, primary: true }]).map((b) => {
          const el = h('button', { class: 'btn' + (b.primary ? ' primary' : '') + (b.left ? ' left' : '') + (b.subtle ? ' subtle' : ''), text: b.text });
          el.disabled = !!b.disabled;
          el.addEventListener('click', () => {
            if (b.action) {
              if (b.action(api) === false) return;
            }
            finish(b.value);
          });
          btnEls.push({ el, b });
          return el;
        })));
      const backdrop = h('div', { class: 'backdrop' }, box);
      const previous = document.activeElement;
      const api = {
        box, close: (v) => finish(v),
        button: (value) => (btnEls.find((x) => x.b.value === value) || {}).el,
      };
      function finish(v) {
        document.removeEventListener('keydown', onKey, true);
        backdrop.remove();
        dialogStack.splice(dialogStack.indexOf(backdrop), 1);
        if (previous && previous.focus && document.body.contains(previous)) previous.focus({ preventScroll: true });
        resolve(v);
      }
      const onKey = (e) => {
        if (backdrop !== dialogStack[dialogStack.length - 1]) return;
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(cancelValue); return; }
        if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLButtonElement) &&
          !(e.target instanceof HTMLSelectElement)) {
          const p = btnEls.find((x) => x.b.primary && !x.el.disabled);
          if (p) { e.preventDefault(); e.stopPropagation(); p.el.click(); }
        }
      };
      document.addEventListener('keydown', onKey, true);
      dialogStack.push(backdrop);
      document.body.append(backdrop);
      applyIcons(box);
      const focusEl = box.querySelector('[autofocus]') || (btnEls.find((x) => x.b.primary) || btnEls[0] || {}).el || box;
      focusEl.focus({ preventScroll: true });
      if (onOpen) onOpen(api);
    });
  }

  function alert(title, message) {
    return dialog({ title, body: message, buttons: [{ text: 'OK', value: true, primary: true }], cancelValue: true });
  }

  function confirm(title, message, okText, cancelText) {
    return dialog({
      title, body: message,
      buttons: [{ text: cancelText || 'Cancel', value: false }, { text: okText || 'OK', value: true, primary: true }],
      cancelValue: false,
    }).then((v) => v === true);
  }

  // ---------------------------------------------------------------- server

  async function errorFrom(res) {
    let msg = 'Something went wrong (' + res.status + ').';
    try {
      const j = await res.json();
      if (j && j.error) msg = j.error;
    } catch (e) { /* not JSON */ }
    const err = new Error(msg);
    err.status = res.status;
    return err;
  }

  const API = {
    async get(url) {
      const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) throw await errorFrom(res);
      return res.json();
    },
    async post(url, body, signal) {
      const res = await fetch(url, {
        method: 'POST', credentials: 'same-origin', signal,
        headers: { 'content-type': 'application/json', 'x-cs': '1' },
        body: JSON.stringify(body || {}),
      });
      if (!res.ok) throw await errorFrom(res);
      return res.json();
    },
    /**
     * A long operation that reports as it goes: calls onEvent for every line the server sends and resolves with
     * the last one ({ type: 'done' … }). Rejects on errors; an AbortSignal cancels it.
     */
    async stream(url, body, onEvent, signal) {
      const res = await fetch(url, {
        method: 'POST', credentials: 'same-origin', signal,
        headers: { 'content-type': 'application/json', 'x-cs': '1' },
        body: JSON.stringify(body || {}),
      });
      if (!res.ok) throw await errorFrom(res);
      if (!(res.headers.get('content-type') || '').includes('ndjson')) return res.json();
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '', last = null;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.type === 'error') throw new Error(ev.message);
          last = ev;
          if (onEvent) onEvent(ev);
        }
      }
      if (!last || last.type !== 'done') {
        const e = new Error('Cancelled');
        e.name = 'AbortError';
        throw e;
      }
      return last;
    },
  };

  window.UI = { h, applyIcons, setIcon, setLabel, initTooltips, hideTip, menu, closeMenu, dialog, alert, confirm, get dialogOpen() { return dialogStack.length > 0; } };
  window.API = API;
})();
