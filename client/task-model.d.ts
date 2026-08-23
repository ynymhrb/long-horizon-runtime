export function initialSelectedNode(nodes: readonly { id: string; state: string }[]): string | undefined
export function cockpitDataState(task: unknown | undefined, graph: unknown | undefined): 'loading' | 'missing' | 'no-plan' | 'ready'
