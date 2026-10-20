// The list of clips: a checkbox, thumbnail, number and name, times and notes per row. Ctrl/Shift multi-select,
// keyboard navigation and inline renaming.
(function () {
  'use strict';
  const { h } = UI;

  class ClipList {
    constructor(el) {
      this.el = el;
      this.items = [];
      this.rows = [];
      this.selected = new Set();
      this.anchor = -1;
      this.focusIndex = -1;
      this.editing = null;
      this.thumbUrl = null; // (seg) => url
      this.onSelectionChanged = () => {};
      this.onCheckedChanged = () => {};
      this.onActivated = () => {};
      this.onRenamed = () => {};
      this.onContextMenu = () => {};
      this.thumbObserver = new IntersectionObserver((entries) => {
        for (const e of entries) if (e.isIntersecting) this.loadThumb(e.target);
      }, { root: el, rootMargin: '200px' });
      el.addEventListener('keydown', (e) => this.onKey(e));
      el.addEventListener('contextmenu', (e) => {
        const i = this.indexOf(e.target);
        if (i < 0) return;
        e.preventDefault();
        if (!this.selected.has(i)) this.select(i);
        this.onContextMenu(e);
      });
    }

    get selectedIndices() { return [...this.selected].sort((a, b) => a - b); }
    get selectedIndex() { return this.selected.size ? Math.min(...this.selected) : -1; }
    get selectedItem() { const i = this.selectedIndex; return i >= 0 && i < this.items.length ? this.items[i] : null; }
    get renaming() { return this.editing != null; }

    indexOf(target) {
      const row = target.closest && target.closest('.row');
      return row ? this.rows.indexOf(row) : -1;
    }

    setItems(list, keepScroll) {
      this.endRename(false);
      const scroll = this.el.scrollTop;
      this.items = list || [];
      for (const i of [...this.selected]) if (i >= this.items.length) this.selected.delete(i);
      if (this.focusIndex >= this.items.length) this.focusIndex = this.items.length - 1;
      this.thumbObserver.disconnect();
      this.el.textContent = '';
      this.rows = this.items.map((seg, i) => this.buildRow(seg, i));
      this.el.append(...this.rows);
      this.renumber();
      this.el.scrollTop = keepScroll ? scroll : 0;
      for (const r of this.rows) this.thumbObserver.observe(r.querySelector('.thumb'));
    }

    buildRow(seg, i) {
      const check = h('div', { class: 'check', html: Icons.icon('check') });
      const row = h('div', { class: 'row', role: 'option' },
        check,
        h('div', { class: 'thumb' }),
        h('div', { class: 'row-text' },
          h('div', { class: 'row-line1' }, h('span', { class: 'row-num' }), h('span', { class: 'row-name' })),
          h('div', { class: 'row-times' }),
          h('div', { class: 'row-note' })));
      row.addEventListener('mousedown', (e) => this.onRowDown(e, row));
      row.addEventListener('dblclick', (e) => {
        if (e.target.closest('.check') || e.target.closest('.rename-box')) return;
        this.onActivated(this.rows.indexOf(row));
      });
      this.fill(row, seg);
      return row;
    }

    fill(row, seg) {
      const i = this.rows.indexOf(row) >= 0 ? this.rows.indexOf(row) : this.items.indexOf(seg);
      row.classList.toggle('included', !!seg.include);
      row.classList.toggle('selected', this.selected.has(i));
      if (this.editing !== seg) row.querySelector('.row-name').textContent = displayName(seg);
      row.querySelector('.row-times').textContent = Plan.formatTime(seg.start) + '  –  ' + Plan.formatTime(seg.end) + '    ' + Plan.formatLength(seg.end - seg.start);
      const note = row.querySelector('.row-note');
      note.textContent = seg.note || '';
      note.hidden = !seg.note;
      note.classList.toggle('warn', !!(seg.include && /late|early|long/.test(seg.note || '')));
      const thumb = row.querySelector('.thumb');
      const url = this.thumbUrl ? this.thumbUrl(seg) : null;
      if (thumb.dataset.want !== url) {
        thumb.dataset.want = url || '';
        if (thumb.dataset.visible === '1') this.loadThumb(thumb);
      }
    }

    loadThumb(thumb) {
      thumb.dataset.visible = '1';
      const url = thumb.dataset.want;
      if (!url || thumb.dataset.shown === url || thumb.dataset.loading === url) return;
      thumb.dataset.loading = url;
      const img = new Image();
      const show = () => {
        if (thumb.dataset.want !== url) return;
        thumb.style.backgroundImage = 'url("' + url + '")';
        thumb.dataset.shown = url;
      };
      img.onload = show;
      img.onerror = () => {
        // One retry (the server may have been busy).
        setTimeout(() => {
          const again = new Image();
          again.onload = show;
          again.src = url + '&r=1';
        }, 800);
      };
      img.src = url;
    }

    /** Numbers count ticked clips only, so they match the saved file names. */
    renumber() {
      let n = 0;
      const width = this.items.length >= 100 ? 3 : 2;
      this.items.forEach((seg, i) => {
        const row = this.rows[i];
        row.querySelector('.row-num').textContent = seg.include ? String(++n).padStart(width, '0') : '–';
        this.fill(row, seg);
      });
    }

    refreshItem(seg) {
      const i = this.items.indexOf(seg);
      if (i >= 0) this.fill(this.rows[i], seg);
    }

    refresh() { this.renumber(); }

    updateSelectionClasses() {
      this.rows.forEach((row, i) => row.classList.toggle('selected', this.selected.has(i)));
    }

    select(index) {
      this.selected.clear();
      if (index >= 0 && index < this.items.length) {
        this.selected.add(index);
        this.anchor = this.focusIndex = index;
        this.ensureVisible(index);
      }
      this.updateSelectionClasses();
      this.onSelectionChanged();
    }

    selectRange(from, to) {
      this.selected.clear();
      for (let i = Math.max(0, Math.min(from, to)); i <= Math.min(this.items.length - 1, Math.max(from, to)); i++) this.selected.add(i);
      this.focusIndex = to;
      this.ensureVisible(to);
      this.updateSelectionClasses();
      this.onSelectionChanged();
    }

    ensureVisible(i) {
      const row = this.rows[i];
      if (!row) return;
      const top = row.offsetTop - this.el.offsetTop - 4, bottom = top + row.offsetHeight + 8;
      if (top < this.el.scrollTop) this.el.scrollTop = top;
      else if (bottom > this.el.scrollTop + this.el.clientHeight) this.el.scrollTop = bottom - this.el.clientHeight;
    }

    setChecked(i, value) {
      if (!this.items[i] || this.items[i].include === value) return;
      this.items[i].include = value;
      this.onCheckedChanged(this.items[i]);
    }

    onRowDown(e, row) {
      const i = this.rows.indexOf(row);
      if (i < 0 || e.target.closest('.rename-box')) return;
      if (this.editing) this.endRename(true);
      this.el.focus({ preventScroll: true });
      if (e.button === 0 && e.target.closest('.check')) {
        // Toggling a row inside a multi-selection toggles all selected rows.
        const value = !this.items[i].include;
        const targets = this.selected.has(i) ? [...this.selected] : [i];
        for (const k of targets) this.setChecked(k, value);
        this.renumber();
        e.preventDefault();
        return;
      }
      if (e.button !== 0) return;
      if (e.shiftKey && this.anchor >= 0) {
        this.selected.clear();
        for (let k = Math.min(this.anchor, i); k <= Math.max(this.anchor, i); k++) this.selected.add(k);
        this.focusIndex = i;
      } else if (e.ctrlKey || e.metaKey) {
        if (!this.selected.delete(i)) this.selected.add(i);
        this.anchor = this.focusIndex = i;
      } else {
        this.selected.clear();
        this.selected.add(i);
        this.anchor = this.focusIndex = i;
      }
      this.updateSelectionClasses();
      this.onSelectionChanged();
    }

    onKey(e) {
      if (this.editing || this.items.length === 0) return;
      const perPage = Math.max(1, Math.floor(this.el.clientHeight / 68) - 1);
      let target = null;
      switch (e.key) {
        case 'ArrowUp': target = this.focusIndex - 1; break;
        case 'ArrowDown': target = this.focusIndex + 1; break;
        case 'Home': target = 0; break;
        case 'End': target = this.items.length - 1; break;
        case 'PageUp': target = this.focusIndex - perPage; break;
        case 'PageDown': target = this.focusIndex + perPage; break;
        case 'Delete':
        case 'Backspace':
          for (const k of this.selected) this.setChecked(k, false);
          this.renumber();
          e.preventDefault();
          return;
        case 'Enter':
          if (this.selectedIndex >= 0) this.onActivated(this.selectedIndex);
          e.preventDefault();
          return;
        case 'a': case 'A':
          if (e.ctrlKey || e.metaKey) { this.selectRange(0, this.items.length - 1); e.preventDefault(); }
          return;
        default: return;
      }
      e.preventDefault();
      e.stopPropagation();
      target = Math.max(0, Math.min(this.items.length - 1, target));
      if (e.shiftKey && this.anchor >= 0) {
        this.selected.clear();
        for (let k = Math.min(this.anchor, target); k <= Math.max(this.anchor, target); k++) this.selected.add(k);
        this.focusIndex = target;
        this.ensureVisible(target);
        this.updateSelectionClasses();
        this.onSelectionChanged();
      } else this.select(target);
    }

    // ---------------------------------------------------------------- renaming

    beginRename(index) {
      this.endRename(true);
      const seg = this.items[index];
      if (!seg) return;
      this.ensureVisible(index);
      const nameEl = this.rows[index].querySelector('.row-name');
      const box = h('input', { class: 'rename-box', spellcheck: 'false', value: seg.name || '' });
      box.value = seg.name || '';
      this.editing = seg;
      this.editBox = box;
      nameEl.textContent = '';
      nameEl.style.flex = '1';
      nameEl.append(box);
      box.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); this.endRename(true); this.el.focus({ preventScroll: true }); }
        else if (e.key === 'Escape') { e.preventDefault(); this.endRename(false); this.el.focus({ preventScroll: true }); }
      });
      box.addEventListener('blur', () => setTimeout(() => { if (this.editBox === box) this.endRename(true); }, 0));
      box.focus();
      box.select();
    }

    endRename(commit) {
      if (!this.editing) return;
      const seg = this.editing, box = this.editBox;
      this.editing = null;
      this.editBox = null;
      const nameEl = box.parentElement;
      if (nameEl) nameEl.style.flex = '';
      box.remove();
      if (commit) this.onRenamed(seg, box.value);
      this.refreshItem(seg);
    }
  }

  function displayName(seg) {
    const name = String(seg.name || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim();
    return name.length > 0 ? name : 'Commercial';
  }

  window.ClipList = ClipList;
  window.displayName = displayName;
})();
