export function registerLongTaskSettings(slots: {
  inject(name: string, callback: () => unknown): unknown
  register(options: { name: string; id: string; order: number; label: string }, component: () => unknown): unknown
}, remote: unknown): void
export const longTaskSettingsCss: string
