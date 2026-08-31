export function taskStatePresentation(state: string): { tone: string; label: string }
export function quotaRecoveryPresentation(recovery: { retryAt: string; diagnostic: string }, now?: Date): { tone: string; label: string }
export function taskStripPresentation(task: { state: string; progress?: { settled?: number; total?: number; succeeded?: number }; reason?: string; currentOrLastNode?: { objective: string; state?: string } }): { tone: string; label: string; progress: string; detail: string }
export function formatTaskProgress(progress: { settled?: number; total?: number; succeeded?: number } | undefined, node?: { objective?: string }): string
export const dagToneCss: string
