import type { Context } from '@deepseek-ai/cordis'
import { selectSettingsOverlay, type SettingsOverride } from './settings.js'

export const name = 'long-task-settings-overlay'

/** Compose operator preferences separately from the packaged runtime defaults. */
export function apply(ctx: Context, config: SettingsOverride = {}): void {
  ctx.provide('longTaskSettingsOverlay', selectSettingsOverlay(config))
}
