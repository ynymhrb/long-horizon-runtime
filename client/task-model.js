export function initialSelectedNode(nodes) {
  const active = nodes.find(node => node.state === 'RUNNING')
  if (active !== undefined) return active.id
  const pending = nodes.find(node => !['SUCCEEDED', 'FAILED', 'CANCELLED', 'INVALIDATED', 'SUPERSEDED'].includes(node.state))
  return pending?.id ?? nodes[0]?.id
}

/** Distinguish a request in flight from an older task that never produced a plan. */
export function cockpitDataState(task, graph) {
  if (task === undefined || graph === undefined) return 'loading'
  if (task === null) return 'missing'
  if (graph === null) return 'no-plan'
  return 'ready'
}
