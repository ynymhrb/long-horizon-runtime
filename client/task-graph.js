export const NODE_WIDTH = 196
export const NODE_HEIGHT = 72
export const RANK_GAP = 96
export const LANE_GAP = 28

/** Text in SVG does not naturally ellipsize, so clip labels before rendering. */
export function truncateGraphText(value, maxCharacters) {
  return value.length <= maxCharacters ? value : `${value.slice(0, Math.max(0, maxCharacters - 1))}…`
}

/** Prevent a folded two-node graph from being auto-enlarged to fill the SVG. */
export function stableCanvasSize({ width, height }) {
  void width; void height
  return { width: 1100, height: 640 }
}

/**
 * Projects a collapsible DAG without pretending that shared downstream work
 * belongs to only one parent. A collapsed node hides descendants that have no
 * other visible prerequisite; join nodes remain visible with their surviving
 * edges, so the rendered graph stays dependency-faithful.
 */
export function visibleTaskGraph(inputNodes, collapsedIds = new Set()) {
  const byId = new Map(inputNodes.map(node => [node.id, node]))
  const outgoing = new Map(inputNodes.map(node => [node.id, []]))
  for (const node of inputNodes) for (const dependency of node.dependsOn ?? []) {
    if (outgoing.has(dependency)) outgoing.get(dependency).push(node.id)
  }
  const hidden = new Set()
  const hiddenBy = new Map()
  for (const rootId of [...collapsedIds].sort()) {
    if (!byId.has(rootId)) continue
    const candidates = descendants(rootId, outgoing)
    candidates.delete(rootId)
    const retained = new Set()
    let changed = true
    while (changed) {
      changed = false
      for (const id of [...candidates].sort()) {
        if (retained.has(id)) continue
        const node = byId.get(id)
        const hasOtherVisibleDependency = (node?.dependsOn ?? []).some(dependency => dependency !== rootId && (!candidates.has(dependency) || retained.has(dependency)))
        if (hasOtherVisibleDependency) { retained.add(id); changed = true }
      }
    }
    const owned = [...candidates].filter(id => !retained.has(id)).sort()
    hiddenBy.set(rootId, owned)
    for (const id of owned) hidden.add(id)
  }
  const nodes = inputNodes.filter(node => !hidden.has(node.id))
  return { nodes, edges: edgesFor(nodes), hiddenBy }
}

function descendants(rootId, outgoing) {
  const result = new Set([rootId])
  const pending = [rootId]
  while (pending.length) for (const target of outgoing.get(pending.pop()) ?? []) if (!result.has(target)) { result.add(target); pending.push(target) }
  return result
}

function edgesFor(nodes) {
  const ids = new Set(nodes.map(node => node.id))
  return nodes.flatMap(node => (node.dependsOn ?? []).filter(dependency => ids.has(dependency)).map(from => ({ from, to: node.id }))).sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to))
}

/**
 * Deterministic left-to-right ranked layout for a read-only task DAG.
 * Missing dependency IDs are reported rather than rendered as invented nodes.
 *
 * Layering follows Sugiyama's framework: longest-path ranks, then a
 * barycenter sweep with local adjacent swaps that reorders each layer so
 * long edges are split by dummy vertices and crossings between layers are
 * minimized. Exact crossing minimization is NP-hard, so the heuristics below
 * are the standard practical approximation used by dagre and Graphviz dot.
 */
export function layoutTaskGraph(inputNodes) {
  const nodes = [...inputNodes].sort((left, right) => left.id.localeCompare(right.id))
  const byId = new Map(nodes.map(node => [node.id, node]))
  const incoming = new Map(nodes.map(node => [node.id, 0]))
  const outgoing = new Map(nodes.map(node => [node.id, []]))
  const dangling = new Set()
  const edges = []

  for (const node of nodes) {
    for (const dependency of node.dependsOn ?? []) {
      if (!byId.has(dependency)) {
        dangling.add(dependency)
        continue
      }
      incoming.set(node.id, incoming.get(node.id) + 1)
      outgoing.get(dependency).push(node.id)
      edges.push({ from: dependency, to: node.id })
    }
  }

  const rank = new Map(nodes.map(node => [node.id, 0]))
  const ready = nodes.filter(node => incoming.get(node.id) === 0).map(node => node.id).sort()
  const visited = new Set()
  while (ready.length > 0) {
    const id = ready.shift()
    visited.add(id)
    for (const target of outgoing.get(id)) {
      rank.set(target, Math.max(rank.get(target), rank.get(id) + 1))
      const nextIncoming = incoming.get(target) - 1
      incoming.set(target, nextIncoming)
      if (nextIncoming === 0) ready.push(target)
    }
    ready.sort()
  }

  // A validated runtime DAG cannot cycle. Preserve a stable, inspectable
  // result anyway if malformed historical data is encountered.
  for (const node of nodes) if (!visited.has(node.id)) rank.set(node.id, 0)

  const maxRank = Math.max(0, ...nodes.map(node => rank.get(node.id)))
  const orderedLayers = reduceCrossings(buildProperLayers(nodes, rank, edges, maxRank))

  // Position every entry in its layer. Dummy vertices keep the vertical slot
  // their lane order assigned, so the extra rows separate long edges from the
  // node rows they would otherwise slash through.
  const positioned = []
  let maxLanes = 1
  for (let nodeRank = 0; nodeRank < orderedLayers.length; nodeRank++) {
    const lane = orderedLayers[nodeRank]
    maxLanes = Math.max(maxLanes, lane.length)
    lane.forEach((entry, index) => {
      const y = 40 + index * (NODE_HEIGHT + LANE_GAP)
      if (!entry.dummy) positioned.push({ ...byId.get(entry.id), rank: nodeRank, x: 40 + nodeRank * (NODE_WIDTH + RANK_GAP), y })
    })
  }
  positioned.sort((left, right) => left.rank - right.rank || left.y - right.y || left.id.localeCompare(right.id))

  const sortedEdges = edges.sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to))
  return {
    nodes: positioned,
    edges: sortedEdges,
    danglingDependencyIds: [...dangling].sort(),
    width: 80 + (maxRank + 1) * NODE_WIDTH + maxRank * RANK_GAP,
    height: 80 + maxLanes * NODE_HEIGHT + Math.max(0, maxLanes - 1) * LANE_GAP,
  }
}

function dummyKey(from, to, rank) {
  return `\u0000dummy:${from}\u0000${to}\u0000${rank}`
}

const CROSSING_SWEEPS = 24
const SIFT_ROUNDS = 6

/**
 * Splits every edge that spans more than one rank into unit segments joined
 * by dummy vertices, so crossings can be counted between adjacent layers only
 * (the standard "proper layering" of the Sugiyama framework). Returns
 * `{ layers, segments }` where segments[r] are the edges from layer r to r+1.
 */
function buildProperLayers(nodes, rank, edges, maxRank) {
  const layers = Array.from({ length: maxRank + 1 }, () => [])
  const segments = Array.from({ length: maxRank + 1 }, () => [])
  for (const node of nodes) layers[rank.get(node.id)].push({ id: node.id, dummy: false })
  for (const edge of edges) {
    const fromRank = rank.get(edge.from)
    const toRank = rank.get(edge.to)
    // A self-loop or same-rank edge only appears in malformed cyclic data;
    // keep it in the returned edges but exclude it from crossing reduction.
    if (toRank <= fromRank) continue
    let previous = edge.from
    for (let r = fromRank + 1; r < toRank; r++) {
      const key = dummyKey(edge.from, edge.to, r)
      layers[r].push({ id: key, dummy: true })
      segments[r - 1].push({ from: previous, to: key })
      previous = key
    }
    segments[toRank - 1].push({ from: previous, to: edge.to })
  }
  return { layers, segments }
}

/**
 * Reorders each layer to minimize crossings between adjacent layers: repeated
 * downward/upward barycenter sweeps keep the best ordering found, then local
 * adjacent swaps refine it. Every step is deterministic.
 */
function reduceCrossings({ layers, segments }) {
  let working = layers.map(layer => [...layer])
  let best = { order: working.map(layer => [...layer]), crossings: totalCrossings(working, segments) }
  let stagnant = 0
  for (let iteration = 0; iteration < CROSSING_SWEEPS; iteration++) {
    for (let r = 1; r < working.length; r++) working[r] = orderByWeights(working[r], barycenterWeights(working[r], working[r - 1], segments[r - 1]))
    recordBest()
    for (let r = working.length - 2; r >= 0; r--) working[r] = orderByWeights(working[r], barycenterWeights(working[r], working[r + 1], segments[r]))
    recordBest()
    if (stagnant >= 4) break
  }
  working = best.order.map(layer => [...layer])
  sift(working, segments)
  recordBest()
  return best.order

  function recordBest() {
    const crossings = totalCrossings(working, segments)
    if (crossings < best.crossings) {
      best = { order: working.map(layer => [...layer]), crossings }
      stagnant = 0
    } else {
      stagnant += 1
    }
  }
}

/** Barycenter of each entry in `layer` from its neighbors in `fixedLayer`. */
function barycenterWeights(layer, fixedLayer, segments) {
  const fixedPosition = new Map(fixedLayer.map((entry, index) => [entry.id, index]))
  const sums = new Map(layer.map(entry => [entry.id, [0, 0]]))
  for (const segment of segments) {
    const fromSum = sums.get(segment.from)
    if (fromSum) { fromSum[0] += fixedPosition.get(segment.to) ?? 0; fromSum[1] += 1 }
    const toSum = sums.get(segment.to)
    if (toSum) { toSum[0] += fixedPosition.get(segment.from) ?? 0; toSum[1] += 1 }
  }
  // Entries with no neighbor keep their current slot so the sort stays stable.
  return layer.map((entry, index) => {
    const [sum, count] = sums.get(entry.id)
    return count === 0 ? index : sum / count
  })
}

/** Stable ascending sort by weight; ties preserve the previous order. */
function orderByWeights(layer, weights) {
  return layer
    .map((entry, index) => [entry, weights[index]])
    .sort((left, right) => left[1] - right[1])
    .map(pair => pair[0])
}

/** Adjacent-swap refinement: keep a swap only when it lowers total crossings. */
function sift(layers, segments) {
  let improved = true
  let rounds = 0
  while (improved && rounds++ < SIFT_ROUNDS) {
    improved = false
    for (let r = 0; r < layers.length; r++) {
      const layer = layers[r]
      for (let i = 0; i < layer.length - 1; i++) {
        const before = layerCrossings(layers, segments, r)
        swap(layer, i, i + 1)
        const after = layerCrossings(layers, segments, r)
        if (after < before) improved = true
        else swap(layer, i, i + 1)
      }
    }
  }
}

function swap(array, left, right) {
  const value = array[left]
  array[left] = array[right]
  array[right] = value
}

/** Crossings that involve layer r with its two adjacent layers. */
function layerCrossings(layers, segments, r) {
  let total = 0
  if (r > 0) total += crossingsBetween(layers[r - 1], layers[r], segments[r - 1])
  if (r < layers.length - 1) total += crossingsBetween(layers[r], layers[r + 1], segments[r])
  return total
}

function totalCrossings(layers, segments) {
  let total = 0
  for (let r = 0; r < segments.length; r++) total += crossingsBetween(layers[r], layers[r + 1], segments[r])
  return total
}

/** Crossings between two adjacent layers, counted as inversions in O(E log E). */
function crossingsBetween(layerA, layerB, segments) {
  if (segments.length === 0) return 0
  const positionA = new Map(layerA.map((entry, index) => [entry.id, index]))
  const positionB = new Map(layerB.map((entry, index) => [entry.id, index]))
  const ordered = segments
    .map(segment => [positionA.get(segment.from) ?? 0, positionB.get(segment.to) ?? 0])
    .sort((left, right) => left[0] - right[0])
  return inversionCount(ordered.map(pair => pair[1]))
}

function inversionCount(values) {
  const copy = [...values]
  const buffer = new Array(values.length)
  const count = (lo, hi) => {
    if (hi - lo < 2) return 0
    const mid = (lo + hi) >> 1
    let total = count(lo, mid) + count(mid, hi)
    let left = lo
    let right = mid
    let out = lo
    while (left < mid && right < hi) {
      if (copy[right] < copy[left]) {
        buffer[out++] = copy[right++]
        total += mid - left
      } else {
        buffer[out++] = copy[left++]
      }
    }
    while (left < mid) buffer[out++] = copy[left++]
    while (right < hi) buffer[out++] = copy[right++]
    for (let i = lo; i < hi; i++) copy[i] = buffer[i]
    return total
  }
  return count(0, copy.length)
}
