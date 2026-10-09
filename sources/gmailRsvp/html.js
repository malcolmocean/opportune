// Tiny HTML helpers for marketing-grade email HTML. No deps; we only need text, links and img alts.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', middot: '·', bull: '•', copy: '©' }

export function decodeEntities(s) {
  return (s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
}

// HTML → newline-separated plain text. Block elements become newlines, inline tags vanish.
export function htmlToText(html) {
  if (!html) return ''
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|title)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|table|section|article|header|footer|blockquote|pre)>/gi, '\n')
    .replace(/<(p|div|li|tr|h[1-6]|table|section|article|blockquote)\b[^>]*>/gi, '\n')
    .replace(/<t[dh]\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
  s = decodeEntities(s).replace(/ /g, ' ')
  return s.split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim()).filter((l, i, a) => l || (a[i - 1] && a[i - 1] !== '')).join('\n').trim()
}

// All hrefs in document order, with their link text. Also unwraps common click-trackers
// (?url=, ?u=, ?redirect=, or any %-encoded https URL inside the href).
export function extractLinks(html) {
  const out = []
  if (!html) return out
  for (const m of html.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = decodeEntities(m[1]).trim()
    const text = htmlToText(m[2]).replace(/\s+/g, ' ').trim()
    out.push({ href, text })
    const inner = unwrapTracker(href)
    if (inner && inner !== href) out.push({ href: inner, text, viaTracker: true })
  }
  return out
}

export function unwrapTracker(href) {
  try {
    const u = new URL(href)
    for (const k of ['url', 'u', 'redirect', 'redirect_uri', 'target', 'link', 'dest', 'r']) {
      const v = u.searchParams.get(k)
      if (v && /^https?:\/\//i.test(v)) return v
    }
  } catch { /* not a URL */ }
  const enc = href.match(/https?%3A%2F%2F[^&\s"']+/i)
  if (enc) { try { return decodeURIComponent(enc[0]) } catch { /* ignore */ } }
  return null
}

// img alt texts, in order (guest avatars in Partiful/Luma emails carry the guest's name).
export function imgAlts(html) {
  const out = []
  if (!html) return out
  for (const m of html.matchAll(/<img\b[^>]*?\balt\s*=\s*["']([^"']*)["'][^>]*>/gi)) {
    const alt = decodeEntities(m[1]).trim()
    if (alt) out.push(alt)
  }
  return out
}

// <time datetime="2026-10-18T19:00:00-07:00"> and similar machine-readable hints.
export function datetimeAttrs(html) {
  const out = []
  if (!html) return out
  for (const m of html.matchAll(/\bdatetime\s*=\s*["']([^"']+)["']/gi)) {
    const d = new Date(m[1])
    if (!isNaN(d)) out.push(d)
  }
  return out
}

// First heading text (h1 → h2 → h3), used as a title fallback.
export function firstHeading(html) {
  if (!html) return null
  for (const tag of ['h1', 'h2', 'h3']) {
    const m = html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'))
    if (m) { const t = htmlToText(m[1]).replace(/\s+/g, ' ').trim(); if (t) return t }
  }
  return null
}
