// ~35 major cities for reverse-geocoding a home place to a city name. UPPERCASE short aliases are
// matched case-sensitively as whole tokens (LA, DC, NY); the rest case-insensitively.
export const RADIUS_M = 30_000

export const CITIES = [
  { name: 'San Francisco', short: 'SF', slug: 'san-francisco', lat: 37.7749, lng: -122.4194, aliases: ['sf', 'san fran', 'bay area'] },
  { name: 'Oakland', slug: 'oakland', lat: 37.8044, lng: -122.2712, aliases: ['east bay', 'berkeley', 'bay area', 'sf', 'san francisco'] },
  { name: 'San Jose', slug: 'san-jose', lat: 37.3382, lng: -121.8863, aliases: ['south bay', 'bay area', 'palo alto'] },
  { name: 'Los Angeles', short: 'LA', slug: 'los-angeles', lat: 34.0522, lng: -118.2437, aliases: ['LA', 'socal'] },
  { name: 'San Diego', slug: 'san-diego', lat: 32.7157, lng: -117.1611, aliases: [] },
  { name: 'Seattle', slug: 'seattle', lat: 47.6062, lng: -122.3321, aliases: [] },
  { name: 'Portland', short: 'PDX', slug: 'portland', lat: 45.5152, lng: -122.6784, aliases: ['pdx'] },
  { name: 'Denver', slug: 'denver', lat: 39.7392, lng: -104.9903, aliases: [] },
  { name: 'Boulder', slug: 'boulder', lat: 40.0150, lng: -105.2705, aliases: [] },
  { name: 'Austin', slug: 'austin', lat: 30.2672, lng: -97.7431, aliases: ['atx'] },
  { name: 'Dallas', slug: 'dallas', lat: 32.7767, lng: -96.7970, aliases: [] },
  { name: 'Houston', slug: 'houston', lat: 29.7604, lng: -95.3698, aliases: [] },
  { name: 'Chicago', slug: 'chicago', lat: 41.8781, lng: -87.6298, aliases: [] },
  { name: 'Minneapolis', slug: 'minneapolis', lat: 44.9778, lng: -93.2650, aliases: ['twin cities'] },
  { name: 'Boston', slug: 'boston', lat: 42.3601, lng: -71.0589, aliases: ['cambridge'] },
  { name: 'New York', short: 'NYC', slug: 'new-york', lat: 40.7128, lng: -74.0060, aliases: ['nyc', 'manhattan', 'brooklyn', 'NY'] },
  { name: 'Philadelphia', short: 'Philly', slug: 'philadelphia', lat: 39.9526, lng: -75.1652, aliases: ['philly'] },
  { name: 'Washington DC', short: 'DC', slug: 'washington-dc', lat: 38.9072, lng: -77.0369, aliases: ['DC', 'washington', 'd.c.'] },
  { name: 'Atlanta', short: 'ATL', slug: 'atlanta', lat: 33.7490, lng: -84.3880, aliases: ['atl'] },
  { name: 'Miami', slug: 'miami', lat: 25.7617, lng: -80.1918, aliases: [] },
  { name: 'Nashville', slug: 'nashville', lat: 36.1627, lng: -86.7816, aliases: [] },
  { name: 'New Orleans', short: 'NOLA', slug: 'new-orleans', lat: 29.9511, lng: -90.0715, aliases: ['nola'] },
  { name: 'Phoenix', slug: 'phoenix', lat: 33.4484, lng: -112.0740, aliases: [] },
  { name: 'Salt Lake City', short: 'SLC', slug: 'salt-lake-city', lat: 40.7608, lng: -111.8910, aliases: ['slc'] },
  { name: 'Las Vegas', short: 'Vegas', slug: 'las-vegas', lat: 36.1699, lng: -115.1398, aliases: ['vegas'] },
  { name: 'Toronto', slug: 'toronto', lat: 43.6532, lng: -79.3832, aliases: [] },
  { name: 'Vancouver', slug: 'vancouver', lat: 49.2827, lng: -123.1207, aliases: [] },
  { name: 'Montreal', slug: 'montreal', lat: 45.5017, lng: -73.5673, aliases: ['montréal'] },
  { name: 'London', slug: 'london', lat: 51.5074, lng: -0.1278, aliases: [] },
  { name: 'Berlin', slug: 'berlin', lat: 52.5200, lng: 13.4050, aliases: [] },
  { name: 'Paris', slug: 'paris', lat: 48.8566, lng: 2.3522, aliases: [] },
  { name: 'Amsterdam', slug: 'amsterdam', lat: 52.3676, lng: 4.9041, aliases: [] },
  { name: 'Lisbon', slug: 'lisbon', lat: 38.7223, lng: -9.1393, aliases: ['lisboa'] },
  { name: 'Mexico City', short: 'CDMX', slug: 'mexico-city', lat: 19.4326, lng: -99.1332, aliases: ['cdmx'] },
  { name: 'Tokyo', slug: 'tokyo', lat: 35.6762, lng: 139.6503, aliases: [] },
]

// Nearest city within RADIUS_M of a point, or null.
export function cityFor(pt, distanceM) {
  if (pt?.lat == null || pt?.lng == null) return null
  let best = null, bestD = Infinity
  for (const c of CITIES) { const d = distanceM(c, pt); if (d < bestD) { bestD = d; best = c } }
  return bestD <= RADIUS_M ? best : null
}

// Does a free-text place ("Mission, San Francisco", "SF", "nyc") refer to this city?
export function matchesCity(place, city) {
  if (!place || !city) return false
  const lower = place.toLowerCase()
  if (lower.includes(city.name.toLowerCase()) || city.name.toLowerCase().includes(lower.trim()) && lower.trim().length >= 4) return true
  const tokens = place.split(/[^\p{L}\p{N}.]+/u).filter(Boolean)
  for (const a of city.aliases) {
    const strict = a === a.toUpperCase() && a.length <= 3
    if (a.includes(' ')) { if (lower.includes(a)) return true; continue }
    if (tokens.some(tk => strict ? tk === a : tk.toLowerCase() === a.toLowerCase())) return true
  }
  return false
}
