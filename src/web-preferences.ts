import type { Context } from '@deepseek-ai/cordis'

export const name = 'long-task-web-preferences'

export function apply(ctx: Context, config: { readonly draft?: unknown } = {}): void {
  ctx.provide('longTaskWebPreferences', config)
}
