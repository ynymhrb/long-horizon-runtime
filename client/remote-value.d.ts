export function remoteValue<T>(result: T | { ok: true; value: T } | { ok: false; error?: { message?: string } }): T
