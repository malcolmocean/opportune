const R = 6371000
const rad = d => (d * Math.PI) / 180
export function distanceM(a, b) {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng)
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}
export const fmtDistance = m => (m < 1000 ? `${Math.round(m)}m` : `${(m / 1000).toFixed(1)}km`)
export const minutesAgo = iso => Math.round((Date.now() - new Date(iso).getTime()) / 60000)
// True for an IANA timezone name the runtime knows ("America/Los_Angeles"), false for anything else.
export function isValidTz(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false
  try { Intl.DateTimeFormat('en-US', { timeZone: tz }); return true } catch { return false }
}

// Local hour 0..23 in an IANA tz. hourCycle 'h23' so midnight is 0, never 24.
export const localHour = (tz, d = new Date()) => Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: tz || 'UTC' }).format(d))
