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

  const ranked = new Map()
  for (const node of nodes) {
    const nodeRank = rank.get(node.id)
    const lane = ranked.get(nodeRank) ?? []
    lane.push(node)
    ranked.set(nodeRank, lane)
  }
  for (const lane of ranked.values()) lane.sort((left, right) => left.id.localeCompare(right.id))

  const positioned = []
  const maxRank = Math.max(0, ...ranked.keys())
  let maxLanes = 1
  for (const [nodeRank, lane] of [...ranked.entries()].sort(([left], [right]) => left - right)) {
    maxLanes = Math.max(maxLanes, lane.length)
    lane.forEach((node, index) => positioned.push({ ...node, rank: nodeRank, x: 40 + nodeRank * (NODE_WIDTH + RANK_GAP), y: 40 + index * (NODE_HEIGHT + LANE_GAP) }))
  }
  positioned.sort((left, right) => left.rank - right.rank || left.id.localeCompare(right.id))
  return {
    nodes: positioned,
    edges: edges.sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to)),
    danglingDependencyIds: [...dangling].sort(),
    width: 80 + (maxRank + 1) * NODE_WIDTH + maxRank * RANK_GAP,
    height: 80 + maxLanes * NODE_HEIGHT + Math.max(0, maxLanes - 1) * LANE_GAP,
  }
}
