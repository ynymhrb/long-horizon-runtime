import { selectSettingsOverlay } from './settings.js';
export const name = 'long-task-settings-overlay';
/** Compose operator preferences separately from the packaged runtime defaults. */
export function apply(ctx, config = {}) {
    ctx.provide('longTaskSettingsOverlay', selectSettingsOverlay(config));
}
