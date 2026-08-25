export function taskStatePresentation(state: string): { tone: string; label: string }
export function taskStripPresentation(task: { state: string; progress: { settled: number; total: number }; reason?: string; currentOrLastNode?: { objective: string } }): { tone: string; label: string; progress: string; detail: string }
export function formatTaskProgress(progress: { settled: number; total: number }, node?: { objective?: string }): string
export const dagToneCss: string
