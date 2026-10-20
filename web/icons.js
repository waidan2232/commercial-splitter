// Line icons (16 × 16), drawn the same on every platform.
(function () {
  'use strict';
  const S = 'fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"';
  const F = 'fill="currentColor"';
  const paths = {
    open: `<path ${S} d="M1.75 12.5V3.6c0-.5.4-.85.85-.85h3.3l1.5 1.6h5.1c.5 0 .85.4.85.85V6"/><path ${S} d="M1.75 12.5 3.5 6.9c.12-.4.48-.65.9-.65h9.6c.6 0 1 .55.85 1.1l-1.5 4.6c-.13.38-.48.55-.88.55H1.75Z"/>`,
    folder: `<path ${S} d="M1.75 12.4V3.6c0-.5.4-.85.85-.85h3.3l1.5 1.6h6c.5 0 .85.4.85.85v7.2c0 .5-.4.85-.85.85H2.6c-.45 0-.85-.4-.85-.85Z"/><path ${S} d="M1.75 6.25h12.5"/>`,
    settings: `<circle ${S} cx="8" cy="8" r="2.1"/><path ${S} d="M8 1.6l1.2 1.3 1.75-.35.55 1.7 1.7.55-.35 1.75L14.4 8l-1.3 1.2.35 1.75-1.7.55-.55 1.7-1.75-.35L8 14.4l-1.2-1.3-1.75.35-.55-1.7-1.7-.55.35-1.75L1.6 8l1.3-1.2-.35-1.75 1.7-.55.55-1.7 1.75.35Z"/>`,
    help: `<circle ${S} cx="8" cy="8" r="6.25"/><path ${S} d="M6.2 6.2a1.85 1.85 0 1 1 2.6 1.7c-.5.25-.8.6-.8 1.15v.35"/><circle ${F} cx="8" cy="11.4" r=".85"/>`,
    play: `<path ${F} d="M4.5 2.6v10.8c0 .55.6.9 1.08.6l8.4-5.4a.7.7 0 0 0 0-1.2l-8.4-5.4a.7.7 0 0 0-1.08.6Z"/>`,
    pause: `<rect ${F} x="3.5" y="2.5" width="3.2" height="11" rx="1"/><rect ${F} x="9.3" y="2.5" width="3.2" height="11" rx="1"/>`,
    prev: `<rect ${F} x="2.5" y="3" width="1.8" height="10" rx=".7"/><path ${F} d="M13.5 3.6v8.8c0 .55-.6.88-1.07.58L5.6 8.6a.7.7 0 0 1 0-1.2l6.83-4.38c.47-.3 1.07.03 1.07.58Z"/>`,
    next: `<rect ${F} x="11.7" y="3" width="1.8" height="10" rx=".7"/><path ${F} d="M2.5 3.6v8.8c0 .55.6.88 1.07.58L10.4 8.6a.7.7 0 0 0 0-1.2L3.57 3.02c-.47-.3-1.07.03-1.07.58Z"/>`,
    left: `<path ${F} d="M10.8 3.4v9.2c0 .5-.55.8-.98.53L3.9 8.55a.65.65 0 0 1 0-1.1l5.92-4.58c.43-.27.98.03.98.53Z"/>`,
    right: `<path ${F} d="M5.2 3.4v9.2c0 .5.55.8.98.53l5.92-4.58a.65.65 0 0 0 0-1.1L6.18 2.87c-.43-.27-.98.03-.98.53Z"/>`,
    split: `<path ${S} d="M8 1.75v12.5"/><path ${S} d="M5.25 5.5 2.75 8l2.5 2.5M2.75 8h3.5M10.75 5.5l2.5 2.5-2.5 2.5M13.25 8h-3.5"/>`,
    merge: `<path ${S} d="M2.25 3.25 7 8l-4.75 4.75M13.75 3.25 9 8l4.75 4.75"/>`,
    rename: `<path ${S} d="M10.6 2.6a1.6 1.6 0 0 1 2.3 2.3l-7.6 7.6-3 .7.7-3 7.6-7.6Z"/><path ${S} d="M9.4 3.8l2.3 2.3"/>`,
    undo: `<path ${S} d="M4.5 2.75 1.75 5.5 4.5 8.25"/><path ${S} d="M1.75 5.5h7.5a4.25 4.25 0 0 1 0 8.5H6"/>`,
    save: `<circle ${S} cx="4" cy="11.5" r="2"/><circle ${S} cx="12" cy="11.5" r="2"/><path ${S} d="M5.5 10.2 12 1.75M10.5 10.2 4 1.75"/>`,
    down: `<path ${S} d="M4 6l4 4 4-4"/>`,
    check: `<path fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" d="M3.6 8.4l2.9 2.8 5.9-6.2"/>`,
    file: `<path ${S} d="M3.25 1.75h6l3.5 3.5v9H3.25Z"/><path ${S} d="M9 1.75v3.75h3.75"/>`,
    film: `<rect ${S} x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5"/><path ${S} d="M4.75 2.75v10.5M11.25 2.75v10.5M1.75 6h3M1.75 10h3M11.25 6h3M11.25 10h3"/>`,
    up: `<path ${S} d="M8 13.25V2.75M3.75 7 8 2.75 12.25 7"/>`,
    download: `<path ${S} d="M8 2v8.5M4.25 7 8 10.75 11.75 7M2.5 13.75h11"/>`,
    upload: `<path ${S} d="M8 11V2.5M4.25 6 8 2.25 11.75 6M2.5 13.75h11"/>`,
  };

  function icon(name) {
    const p = paths[name];
    return p ? '<svg viewBox="0 0 16 16" aria-hidden="true">' + p + '</svg>' : '';
  }

  window.Icons = { icon, names: Object.keys(paths) };
})();
