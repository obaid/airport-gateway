(() => {
  'use strict';

  const glyphs = {
    home: '<path d="m3 10 9-7.2 9 7.2v10a1 1 0 0 1-1 1h-5.5v-7h-5v7H4a1 1 0 0 1-1-1z"/>',
    overview: '<rect x="3" y="3" width="7.2" height="7.2" rx="1.5"/><rect x="13.8" y="3" width="7.2" height="7.2" rx="1.5"/><rect x="3" y="13.8" width="7.2" height="7.2" rx="1.5"/><rect x="13.8" y="13.8" width="7.2" height="7.2" rx="1.5"/>',
    connections: '<path d="m7 14 3 3m2-12 7 7m-5.8-5.8-3 3a4.3 4.3 0 0 0 6.1 6.1l3-3M5 19l4.8-4.8M16 7l2.5-2.5M19 10l2.5-2.5"/>',
    agents: '<rect x="4" y="7.5" width="16" height="12.5" rx="3"/><path d="M12 4v3.5M2 12v3.5M22 12v3.5m-12.5 1h5"/><circle cx="12" cy="3.3" r="1"/><circle cx="8.5" cy="12.3" r=".85" fill="currentColor" stroke="none"/><circle cx="15.5" cy="12.3" r=".85" fill="currentColor" stroke="none"/>',
    policies: '<path d="M12 2.5 20 6v6.3c0 4.3-3.2 7.5-8 9.2-4.8-1.7-8-4.9-8-9.2V6z"/><path d="m8.6 11.8 2.2 2.3 4.7-4.8"/>',
    activity: '<path d="M2 12h4.5L10 4l4 16 3.5-8H22"/>',
    chevrons: '<path d="m8.5 9 3.5-3.5L15.5 9m-7 6 3.5 3.5 3.5-3.5"/>',
    'chevron-down': '<path d="m6 9 6 6 6-6"/>',
    'chevron-right': '<path d="m9 6 6 6-6 6"/>',
    'chevron-left': '<path d="m15 6-6 6 6 6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    'arrow-right': '<path d="M4 12h16m-7-7 7 7-7 7"/>',
    'arrow-up-right': '<path d="M6 18 18 6M6.5 6H18v11.5"/>',
    check: '<path d="m4.5 12 5 5 10-11"/>',
    x: '<path d="m6 6 12 12M18 6 6 18"/>',
    menu: '<path d="M3 5.5h18M3 12h18M3 18.5h18"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.25 15.25 5 5"/>',
    shield: '<path d="M12 2.5 20 6v6.3c0 4.3-3.2 7.5-8 9.2-4.8-1.7-8-4.9-8-9.2V6z"/>',
    globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3.5 9h17m-17 6h17"/>',
    link: '<path d="m10 13.9 4-3.8m-5.1.7 3.9-3.9a4 4 0 0 1 5.7 5.7l-2.4 2.3m-1 .3-3.9 3.9a4 4 0 0 1-5.7-5.7L8 11"/>',
    unplug: '<path d="m2 22 4.5-4.5m11-11L22 2M4 14l6 6 2.7-2.7-6-6zm16-4-6-6-2.7 2.7 6 6zM5 3l1.5 3M3 6l3 1.5m12 11 1.5 3m.5-5 2.5 1"/>',
    route: '<circle cx="5.5" cy="18" r="2.5"/><circle cx="18.5" cy="6" r="2.5"/><path d="M8 18h8a3 3 0 0 0 0-6H8a3 3 0 0 1 0-6h8"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5zm-9 9 9 5 9-5m-18 4 9 5 9-5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6.5V12l3.5 2"/>',
    settings: '<path d="m10 3-.5 2a7 7 0 0 0-2 .9l-1.9-.7-2 3.5 1.5 1.4a7 7 0 0 0 0 2.6l-1.5 1.4 2 3.5 1.9-.7a7 7 0 0 0 2 .9l.5 2.1h4l.5-2.1a7 7 0 0 0 2-.9l1.9.7 2-3.5-1.5-1.4a7 7 0 0 0 0-2.6l1.5-1.4-2-3.5-1.9.7a7 7 0 0 0-2-.9L14 3z"/><circle cx="12" cy="11.4" r="3"/>',
    sliders: '<path d="M4 7h3m4 0h9M4 17h9m4 0h3"/><circle cx="9" cy="7" r="2"/><circle cx="15" cy="17" r="2"/>',
    play: '<path d="m7 4 13 8-13 8z"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M15 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3"/>',
    key: '<circle cx="8" cy="15" r="4.5"/><circle cx="7" cy="16" r=".8" fill="currentColor" stroke="none"/><path d="m11.3 11.7 8.2-8.2 2 2-2.3 2.3-1.5-1.5-2.4 2.4 1.5 1.5-2.2 2.2"/>',
    lock: '<rect x="5" y="10.5" width="14" height="10.5" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5m-4 4.3v2"/>',
    bell: '<path d="M5 16.5h14c-1.5-1.6-2-3-2-5.7V9a5 5 0 0 0-10 0v1.8c0 2.7-.5 4.1-2 5.7zm4.7 3a2.8 2.8 0 0 0 4.6 0M12 3V2"/>',
    briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8.5 7V5.5A1.5 1.5 0 0 1 10 4h4a1.5 1.5 0 0 1 1.5 1.5V7M3 11c5.5 4 12.5 4 18 0m-9 1.5V15"/>',
    user: '<circle cx="12" cy="8" r="3.8"/><path d="M4.5 20v-1.2a5.6 5.6 0 0 1 5.6-5.6h3.8a5.6 5.6 0 0 1 5.6 5.6V20"/>',
    consulting: '<path d="M3 4.5h14v11h-7.5L5 19v-3.5H3zM17 8h4v11h-2v2l-4.2-2h-3"/>',
    more: '<g fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></g>',
    filter: '<path d="M3 5h18l-7 8v5l-4 2v-7z"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7.5 3v4m9-4v4M3 10h18m-14 4h2m3 0h2m-7 3h2"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    terminal: '<rect x="2.5" y="4" width="19" height="16" rx="2.5"/><path d="m6.5 9 3 3-3 3m5.5 0h4.5"/>',
    test: '<path d="M9 3h6m-5 0v6.2L4.7 18a1.8 1.8 0 0 0 1.6 2.7h11.4a1.8 1.8 0 0 0 1.6-2.7L14 9.2V3m-7 12h10"/>',
    list: '<path d="M9 6h12M9 12h12M9 18h12"/><g fill="currentColor" stroke="none"><circle cx="4" cy="6" r="1.2"/><circle cx="4" cy="12" r="1.2"/><circle cx="4" cy="18" r="1.2"/></g>',
    alert: '<path d="M10.4 4a1.8 1.8 0 0 1 3.2 0l7.6 14a1.8 1.8 0 0 1-1.6 2.7H4.4A1.8 1.8 0 0 1 2.8 18zM12 9v4.5"/><circle cx="12" cy="17" r=".9" fill="currentColor" stroke="none"/>',
    pause: '<path d="M7.5 5v14m9-14v14" stroke-width="3"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle cx="12" cy="7.5" r="1" fill="currentColor" stroke="none"/>',
    'check-circle': '<circle cx="12" cy="12" r="9"/><path d="m7.8 12 2.9 3 5.8-6"/>',
    ban: '<circle cx="12" cy="12" r="9"/><path d="m5.7 5.7 12.6 12.6"/>',
    download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/>',
    plane: '<path d="m21 3-2 .5-6.2 5.8-7.6-1.6-2 2 6.4 3.3-3.2 4.2-3-.4-1.3 1.4 4.7 1.1 1.2 2.4 1.3-1.4-.4-2.2 4.2-3.2 3 6.3 2.1-2-1.5-7.7 5.7-6.3z"/>',
    tower: '<path d="M5 5h14l-2 6H7zm3 6 1 9m7-9-1 9M6 21h12M12 5V2m-2 3 .5 6m3.5-6-.5 6"/>',
    command: '<path d="M8.5 8.5v-3a2.5 2.5 0 1 0-2.5 2.5h12a2.5 2.5 0 1 0-2.5-2.5v13a2.5 2.5 0 1 0 2.5-2.5H6a2.5 2.5 0 1 0 2.5 2.5z"/>',
    building: '<path d="M4 21h16M6 21V4h12v17m-9-13h1m4 0h1m-6 4h1m4 0h1m-5 9v-5h4v5"/>',
    'panel-left': '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
    'log-out': '<path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4m-1-8h12m-5-5 5 5-5 5"/>',
    refresh: '<path d="M20 8a8 8 0 0 0-13-2L3 10m0-5v5h5m-4 6a8 8 0 0 0 13 2l4-4m0 5v-5h-5"/>'
  };

  const aliases = {
    close: 'x', grid: 'overview', 'shield-check': 'policies',
    personal: 'user', work: 'briefcase', 'chevrons-up-down': 'chevrons'
  };

  const marks = {
    gmail: '<path fill="#4285f4" d="M2 7h5.2v17H4a2 2 0 0 1-2-2z"/><path fill="#34a853" d="M20.8 7H26v15a2 2 0 0 1-2 2h-3.2z"/><path fill="#fbbc04" d="m20.8 7 2.1-1.6A2 2 0 0 1 26 7v4l-5.2 4z"/><path fill="#ea4335" d="M7.2 7 14 12l6.8-5v8L14 20l-6.8-5z"/><path fill="#c5221f" d="M2 7a2 2 0 0 1 3.1-1.6L7.2 7v8L2 11z"/>',
    drive: '<path fill="#34a853" d="m9.8 2.5 4.5 7.8-8.8 15.2L1 17.8z"/><path fill="#fbbc04" d="M9.8 2.5h8.9L27 17.8h-8.8z"/><path fill="#4285f4" d="M9.9 17.8H27l-4.5 7.7h-17z"/><path fill="#188038" d="m9.8 2.5 4.5 7.8-2.1 3.6-4.5-7.7z"/><path fill="#1967d2" d="m5.5 25.5 4.4-7.7h-4L3.4 22z"/><path fill="#ea4335" d="M18.2 17.8H27l-2.2 3.8h-4.5z"/>',
    calendar: '<rect x="2" y="2" width="24" height="24" rx="3" fill="#fff"/><path fill="#1a73e8" d="M5 2h17v5H2V5q0-3 3-3z"/><path fill="#4285f4" d="M2 7h5v14H2z"/><path fill="#34a853" d="M7 21h14v5H7z"/><path fill="#fbbc04" d="M21 7h5v14l-5 5z"/><path fill="#ea4335" d="M21 2h2q3 0 3 3v2h-5z"/><path fill="#188038" d="M2 21h5v5H5q-3 0-3-3z"/><path fill="none" stroke="#1967d2" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" d="M9.3 11.3c.6-1.4 4.1-1.6 4.1.6 0 1.4-1.4 2-2.6 2 1.3 0 2.7.6 2.7 2.2 0 2-3 2.7-4.4.7m6.5-5.1 2.2-1.6v7.6"/>',
    slack: '<g stroke-linecap="round" stroke-width="5.2"><path stroke="#36c5f0" d="M4 10.5h6.5M10.5 4v.01"/><path stroke="#2eb67d" d="M17.5 4v6.5M24 10.5h.01"/><path stroke="#ecb22e" d="M24 17.5h-6.5m0 6.5v.01"/><path stroke="#e01e5a" d="M10.5 24v-6.5M4 17.5h.01"/></g>',
    yahoo: '<rect x="1" y="1" width="26" height="26" rx="6" fill="#6001d2"/><path d="M4.8 9h4.1l2.8 6.4 3.1-6.4h4.1l-7.3 14H7.7l2.3-4.5zm15.7-3h4l-3.4 9.6h-3z" fill="#fff"/><circle cx="18.9" cy="18.7" r="1.9" fill="#fff"/>',
    notion: '<path d="m3.4 4.7 15.8-2.3 5.6 3.7v18l-15.8 2-5.6-4.2z" stroke="#181719" stroke-width="1.45" fill="#fff" stroke-linejoin="round"/><path d="m3.7 5 5.4 3.5 15.5-2M9.1 8.5v17" fill="none" stroke="#181719" stroke-width="1.5"/><path d="m11.2 11.3 3.4-.3 4.6 6.3v-5.6l-1.4-.1v-1.2l4.1-.5v1.3l-1.2.4v9.2l-2.1.3-5-7v5.9l1.4.1v1.1l-4 .5v-1.3l1.1-.4v-7.4l-.9-.1z" fill="#181719"/>',
    muse: '<rect width="28" height="28" rx="7" fill="#e6dcff"/><path d="M14 4.5c.7 4.4 2 5.7 6.2 3.3-2.5 4.1-1.1 5.6 3.4 6.2-4.5.7-5.9 2.1-3.4 6.3-4.3-2.4-5.6-1.1-6.2 3.4-.7-4.5-2-5.8-6.3-3.4 2.5-4.2 1-5.6-3.3-6.3 4.4-.6 5.8-2.1 3.3-6.2 4.2 2.4 5.6 1.1 6.3-3.3z" fill="#7750be"/><circle cx="14" cy="14" r="2.2" fill="#e6dcff"/>',
    duet: '<rect width="28" height="28" rx="7" fill="#ffdec1"/><path d="M5.5 8H9a6.1 6.1 0 0 1 0 12H5.5zm9.1 0h3.5a6.1 6.1 0 0 1 0 12h-3.5z" fill="#aa5526"/>',
    dot: '<rect width="28" height="28" rx="7" fill="#cde9df"/><g fill="#286658"><circle cx="10" cy="10" r="3.2"/><circle cx="18" cy="10" r="3.2"/><circle cx="10" cy="18" r="3.2"/><circle cx="18" cy="18" r="3.2"/></g>',
    custom: '<rect width="28" height="28" rx="7" fill="#dbe4f6"/><g fill="none" stroke="#506893" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="m9.2 9.6-4 4.4 4 4.4m9.6-8.8 4 4.4-4 4.4m-3-10-3.6 11.2"/></g>'
  };

  const markAliases = {
    'google-drive': 'drive', 'google-calendar': 'calendar', 'google-mail': 'gmail',
    'google drive': 'drive', 'google calendar': 'calendar', 'yahoo mail': 'yahoo'
  };

  let gradientID = 0;
  function instagram() {
    const id = 'airport-instagram-' + ++gradientID;
    return '<defs><radialGradient id="' + id + '" cx=".2" cy="1" r="1.2"><stop offset="0" stop-color="#ffd861"/><stop offset=".29" stop-color="#ff8840"/><stop offset=".55" stop-color="#ec368a"/><stop offset="1" stop-color="#7048d4"/></radialGradient></defs><rect x="1" y="1" width="26" height="26" rx="6.4" fill="url(#' + id + ')"/><rect x="6.4" y="6.4" width="15.2" height="15.2" rx="4.3" fill="none" stroke="#fff" stroke-width="1.9"/><circle cx="14" cy="14" r="3.8" fill="none" stroke="#fff" stroke-width="1.9"/><circle cx="18.9" cy="9.2" r="1.15" fill="#fff"/>';
  }

  function svg(content, size, viewSize, type, attributes = '') {
    const pixels = Number(size);
    const dimension = Number.isFinite(pixels) && pixels > 0 ? pixels : viewSize;
    return '<svg class="art-' + type + '" xmlns="http://www.w3.org/2000/svg" width="' + dimension + '" height="' + dimension + '" viewBox="0 0 ' + viewSize + ' ' + viewSize + '" aria-hidden="true" focusable="false" style="flex-shrink:0;vertical-align:middle" ' + attributes + '>' + content + '</svg>';
  }

  const nameOf = value => String(value || '').trim().toLowerCase().replace(/_/g, '-');
  function icon(name, size = 20) {
    const key = nameOf(name);
    const resolved = Object.hasOwn(aliases, key) ? aliases[key] : key;
    const shape = Object.hasOwn(glyphs, resolved) ? glyphs[resolved] : glyphs.info;
    return svg(shape, size, 24, 'icon', 'fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"');
  }

  function logo(name, size = 28) {
    const key = nameOf(name);
    const resolved = Object.hasOwn(markAliases, key) ? markAliases[key] : key;
    const shape = resolved === 'instagram' ? instagram() : (Object.hasOwn(marks, resolved) ? marks[resolved] : marks.custom);
    return svg(shape, size, 28, 'logo');
  }

  function brand(size = 32) {
    const shape = '<rect width="32" height="32" rx="8" fill="#deff67"/><g fill="#152032"><path d="M4.2 23.2 14 8.3l3.6-1.6L8.3 23.2z"/><path d="m10.1 23.2 9.2-16.5 3.6-1.6-8.8 18.1z"/><path d="m16.2 23.2 5.2-10.7 5 10.7h-4.3l-1.2-2.9-1.4 2.9z"/></g>';
    return svg(shape, size, 32, 'brand');
  }

  window.Art = { icon, logo, brand };
})();
