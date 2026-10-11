// A wall lantern as inline SVG: the porchlight. Colouring lives in app.css, keyed on
// data-state (open | ask | closed) and data-strength (steady | strong | fading | last-call).
// The halo gradient is defined once in app.html (<defs id="lanternHalo">).

export function lanternSvg(state = 'ask', { strength = null, size = 64, cls = '' } = {}) {
  const w = size, h = Math.round(size * 1.25)
  return `<svg class="lantern ${cls}" data-state="${state}" data-strength="${strength || ''}" viewBox="0 0 80 100" width="${w}" height="${h}" aria-hidden="true" focusable="false">
  <circle class="halo" cx="46" cy="58" r="38" fill="url(#lanternHalo)"/>
  <rect class="metal" x="4" y="12" width="8" height="40" rx="2.5" fill="currentColor"/>
  <circle cx="8" cy="18" r="1.4" fill="var(--bg, #090b22)" opacity=".7"/>
  <circle cx="8" cy="46" r="1.4" fill="var(--bg, #090b22)" opacity=".7"/>
  <path d="M12 22 H36 Q46 22 46 30" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/>
  <circle cx="46" cy="25" r="3" fill="currentColor"/>
  <path class="glass" d="M28 41 H64 L62 76 H30 Z"/>
  <path class="flame" d="M46 71 c-7.5 -6 -7.5 -14.5 0 -23 c7.5 8.5 7.5 17 0 23 z"/>
  <ellipse class="core" cx="46" cy="64" rx="2.4" ry="5"/>
  <path d="M28 41 H64 L62 76 H30 Z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/>
  <path d="M46 41 V76" stroke="currentColor" stroke-width="1.4" opacity=".55"/>
  <path d="M24 41 L46 28 L68 41 Z" fill="currentColor"/>
  <path d="M30 76 H62 L58 83 H34 Z" fill="currentColor"/>
  <circle cx="46" cy="88" r="3.2" fill="currentColor"/>
</svg>`
}

export function lanternEl(state, opts) {
  const t = document.createElement('template')
  t.innerHTML = lanternSvg(state, opts).trim()
  return t.content.firstElementChild
}
