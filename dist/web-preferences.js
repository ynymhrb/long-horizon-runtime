export const name = 'long-task-web-preferences';
export function apply(ctx, config = {}) {
    ctx.provide('longTaskWebPreferences', config);
}
