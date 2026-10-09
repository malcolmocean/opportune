// Trusted-tier live map. Leaflet (pinned) is loaded lazily from a CDN, so the
// management page does not pay for it unless the Map tab opens.
const LEAFLET = 'https://unpkg.com/leaflet@1.9.4/dist/'

let leafletPromise
export function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L)
  if (leafletPromise) return leafletPromise
  leafletPromise = new Promise((resolve, reject) => {
    const css = document.createElement('link')
    css.rel = 'stylesheet'; css.href = `${LEAFLET}leaflet.css`
    document.head.appendChild(css)
    const s = document.createElement('script')
    s.src = `${LEAFLET}leaflet.js`
    s.onload = () => resolve(window.L)
    s.onerror = () => reject(new Error('could not load Leaflet'))
    document.head.appendChild(s)
  })
  return leafletPromise
}

export function tokenFromPage() {
  const u = new URL(location.href)
  let t = u.searchParams.get('token')
  try {
    if (t) localStorage.setItem('opportune.token', t)
    else t = localStorage.getItem('opportune.token')
  } catch {}
  return t
}

export async function fetchMap(token) {
  const r = await fetch('/api/manage/map', { headers: { 'x-manage-token': token } })
  if (!r.ok) throw Object.assign(new Error((await r.json().catch(() => ({}))).error || r.statusText), { status: r.status })
  return r.json()
}

const ago = m => (m == null ? '' : m < 1 ? 'just now' : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// Mount (or refresh) a map in `el` with the given payload from /api/manage/map.
// Returns a handle with update(data) for later refreshes.
export async function mountMap(el, data, { legendEl } = {}) {
  const L = await loadLeaflet()
  const map = L.map(el, { zoomControl: true, attributionControl: true })
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(map)
  const layer = L.layerGroup().addTo(map)
  const handle = {
    map,
    update(d) {
      layer.clearLayers()
      const pts = []
      const pin = (p, me) => L.marker([p.lat, p.lng], { icon: L.divIcon({ className: '', html: `<div class="pin${me ? ' me' : ''}"><i></i>${esc(p.displayName)}<small>&nbsp;${esc(ago(p.ageMin))}</small></div>`, iconSize: null, iconAnchor: [8, 12] }) })
      for (const f of d.friends || []) { pin(f, false).addTo(layer).bindPopup(`<b>${esc(f.displayName)}</b><br>${esc(f.placeName || '')}${f.placeName ? '<br>' : ''}${esc(ago(f.ageMin))}`); pts.push([f.lat, f.lng]) }
      if (d.me?.location) { pin({ ...d.me.location, displayName: 'me' }, true).addTo(layer); pts.push([d.me.location.lat, d.me.location.lng]) }
      if (pts.length > 1) map.fitBounds(pts, { padding: [40, 40], maxZoom: 15 })
      else if (pts.length === 1) map.setView(pts[0], 14)
      else map.setView([37.7749, -122.4194], 11)
      if (legendEl) {
        const n = (d.friends || []).length
        legendEl.textContent = n ? `${n} friend${n > 1 ? 's' : ''} sharing live location (last ${d.windowHours}h)` : `No friends sharing live location right now. Trusted-tier friends appear here.`
      }
    },
  }
  handle.update(data)
  setTimeout(() => map.invalidateSize(), 50)
  return handle
}
