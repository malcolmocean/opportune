const R = 6371000
const rad = d => (d * Math.PI) / 180
export function distanceM(a, b) {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng)
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}
export const fmtDistance = m => (m < 1000 ? `${Math.round(m)}m` : `${(m / 1000).toFixed(1)}km`)
export const minutesAgo = iso => Math.round((Date.now() - new Date(iso).getTime()) / 60000)
