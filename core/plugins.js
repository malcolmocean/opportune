import { readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { log } from './log.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const L = log('plugins')

// A plugin is a directory under sources/ triggers/ channels/ queries/ with an index.js
// whose default export is the manifest object. Disabled plugins have a `.disabled` file.
export async function loadPlugins() {
  const out = { sources: {}, triggers: {}, channels: {}, queries: {} }
  for (const kind of Object.keys(out)) {
    const dir = join(root, kind)
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      if (!name.isDirectory()) continue
      const pdir = join(dir, name.name)
      if (existsSync(join(pdir, '.disabled'))) continue
      const entry = join(pdir, 'index.js')
      if (!existsSync(entry)) continue
      try {
        const mod = (await import(pathToFileURL(entry).href)).default
        if (!mod?.id) { L.warn(`${kind}/${name.name}: manifest missing id`); continue }
        mod.__dir = pdir
        out[kind][mod.id] = mod
      } catch (e) {
        L.error(`failed to load ${kind}/${name.name}:`, e.message)
      }
    }
    L.info(`${kind}: ${Object.keys(out[kind]).join(', ') || '(none)'}`)
  }
  return out
}

// What this node advertises in /.well-known/opportune
export function capabilities(plugins) {
  const strip = p => ({ id: p.id, name: p.name, description: p.description, repo: p.repo, setup: p.setup, kinds: p.kinds })
  return {
    sources: Object.values(plugins.sources).map(strip),
    triggers: Object.values(plugins.triggers).map(p => ({ id: p.id, name: p.name, on: p.on })),
    channels: Object.values(plugins.channels).map(strip),
    queries: Object.values(plugins.queries).map(p => ({ id: p.id, kind: p.kind, sensitivity: p.sensitivity, grant: p.grant, description: p.description })),
  }
}
