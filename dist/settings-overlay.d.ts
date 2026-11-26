import type { Context } from '@deepseek-ai/cordis';
import { type SettingsOverride } from './settings.js';
export declare const name = "long-task-settings-overlay";
/** Compose operator preferences separately from the packaged runtime defaults. */
export declare function apply(ctx: Context, config?: SettingsOverride): void;
