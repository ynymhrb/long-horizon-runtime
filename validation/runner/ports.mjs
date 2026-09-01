/**
 * Local port selection for UI scenario web hosts.
 * Reserved ports are never returned: 3003/3004 (Clowder AI) and 3080 (the
 * current DSH GUI).
 */

import net from 'node:net'

export const RESERVED_PORTS = new Set([3003, 3004, 3080])

/**
 * Find a free localhost TCP port that is not reserved.
 * @param {{ reserved?: Set<number> | number[], min?: number, max?: number }} [options]
 * @returns {Promise<number>}
 */
export async function findFreePort(options = {}) {
  const reserved = new Set(options.reserved === undefined ? RESERVED_PORTS : Array.isArray(options.reserved) ? options.reserved : [...options.reserved])
  const min = options.min ?? 4100
  const max = options.max ?? 6999
  for (let attempts = 0; attempts < 200; attempts += 1) {
    const candidate = min + Math.floor(Math.random() * (max - min + 1))
    if (reserved.has(candidate)) continue
    if (await isFree(candidate)) return candidate
  }
  throw new Error('no free non-reserved port found in range')
}

/** @param {number} port @returns {Promise<boolean>} */
function isFree(port) {
  return new Promise(resolve => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
}
