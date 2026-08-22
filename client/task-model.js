export function initialSelectedNode(nodes) {
  const active = nodes.find(node => node.state === 'RUNNING')
  if (active !== undefined) return active.id
  const pending = nodes.find(node => !['SUCCEEDED', 'FAILED', 'CANCELLED', 'INVALIDATED', 'SUPERSEDED'].includes(node.state))
  return pending?.id ?? nodes[0]?.id
}
