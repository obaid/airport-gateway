// Shared by the Airport gateway and landing page. Only local catalog assets are rendered.
(function () {
  'use strict';
  const entries = [
    ['muse', 'Muse', ['meta muse', 'muse from meta']],
    ['dots', 'Dots', ['dot', 'chatgpt dots', 'openai dots']],
    ['duet', 'Duet', ['claude duet', 'claude duet by anthropic']],
    ['grok-bot', 'Grok Bot', ['grokbot', 'grok bot']],
    ['instinct', 'Instinct', []],
  ];
  const normalize = value => typeof value === 'string' ? value.normalize('NFKC').trim().toLowerCase() : '';
  const matchKey = value => normalize(value).replace(/[\s_-]+/g, '');
  const aliases = new Map();
  const catalog = Object.freeze(entries.map(([key, label, otherNames]) => {
    for (const alias of [key, label, ...otherNames]) aliases.set(matchKey(alias), key);
    return Object.freeze({key, label});
  }));
  const keys = new Set(catalog.map(entry => entry.key));
  function identify(name) {
    return aliases.get(matchKey(name)) || null;
  }
  function imageURL(name, {clientType} = {}) {
    const key = clientType && clientType !== 'auto' ? clientType : identify(name);
    return keys.has(key) ? '/assets/agents/' + key + '.png' : null;
  }
  const sizes = [12,14,16,18,20,22,24,26,28,30,32,34,36,38,40,42,44,48,56,64];
  function render(name, {size = 32, clientType} = {}) {
    const pixels = sizes.reduce((a, b) => Math.abs(b - size) < Math.abs(a - size) ? b : a, 32);
    const base = 'class="agent-icon agent-icon-size-' + pixels;
    const url = imageURL(name, {clientType});
    if (url) return '<span ' + base + '" aria-hidden="true"><img src="' + url + '" width="' + pixels + '" height="' + pixels + '" alt=""></span>';
    const label = normalize(name);
    const letter = label.match(/[\p{L}\p{N}]\p{M}*/u)?.[0] || 'A';
    const initial = letter.toUpperCase().match(/^[\p{L}\p{N}]\p{M}*/u)[0];
    const tone = Array.from(label).reduce((sum, char) => (sum + char.codePointAt(0)) % 6, 0);
    return '<span ' + base + ' agent-icon-letter" data-tone="' + tone + '" aria-hidden="true">' + initial + '</span>';
  }
  const api = Object.freeze({catalog, identify, imageURL, render});
  if (typeof window !== 'undefined') window.AirportAgentIcons = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
