export function remoteValue(result) { if (result && result.ok === false) throw new Error(result.error?.message ?? '远程调用失败'); return result && result.ok === true ? result.value : result }
