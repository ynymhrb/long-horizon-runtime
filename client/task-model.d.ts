export function initialSelectedNode(nodes: readonly { id: string; state: string }[]): string | undefined
export function cockpitDataState(task: unknown | undefined, graph: unknown | undefined): 'loading' | 'missing' | 'no-plan' | 'ready'
export function resumeDriverMessage(taskId: string, objective?: string): string
export function resumeDriverMode(navigation: { currentSessionId?: string } | null | undefined, currentSessionId?: string): 'inject' | 'open' | 'attach'
