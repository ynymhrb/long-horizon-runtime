import type { SideEffectClass } from './domain.js'
import type { ExecutionAdapter, ExecutionResult } from './adapters.js'

export interface WorkerBackend {
  readonly id: string
  readonly maxConcurrent: number
  readonly workspaceKey?: string
  readonly adapter: ExecutionAdapter
}

export interface WorkerLease {
  readonly workerId: string
  execute(input: Parameters<ExecutionAdapter['execute']>[0]): Promise<ExecutionResult>
  release(): void
}

type Slot = WorkerBackend & { active: number }
type Waiter = {
  readonly candidates: readonly Slot[]
  readonly signal: AbortSignal
  readonly readOnly: boolean
  readonly resolve: (lease: WorkerLease) => void
  readonly abort: () => void
}

/** Single-process admission control, independent of the backend's transport. */
export class WorkerPool {
  private readonly slots = new Map<string, Slot>()
  private readonly waiting = new Set<Waiter>()
  private readonly workspaces = new Map<string, { readers: number; writers: number }>()
  private readonly running = new Map<string, Slot>()
  private active = 0

  constructor(private readonly maxConcurrent: number, backends: readonly WorkerBackend[]) {
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) throw new Error('无效的 Worker 池并发上限')
    for (const backend of backends) {
      if (this.slots.has(backend.id) || backend.id.trim() === '' || !Number.isSafeInteger(backend.maxConcurrent) || backend.maxConcurrent < 1) {
        throw new Error('无效或重复的 Worker 配置：' + backend.id)
      }
      this.slots.set(backend.id, { ...backend, active: 0 })
    }
  }

  async admit(ids: readonly string[], signal: AbortSignal, sideEffectClass: SideEffectClass = 'read_only'): Promise<WorkerLease> {
    signal.throwIfAborted()
    const candidates = ids.map(id => {
      const slot = this.slots.get(id)
      if (slot === undefined) throw new Error('未知 Worker：' + id)
      return slot
    })
    if (candidates.length === 0) throw new Error('没有兼容的 Worker')
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        candidates, signal, resolve, readOnly: sideEffectClass === 'read_only',
        abort: () => {
          this.waiting.delete(waiter)
          reject(signal.reason)
          this.dispatch()
        },
      }
      signal.addEventListener('abort', waiter.abort, { once: true })
      this.waiting.add(waiter)
      this.dispatch()
    })
  }

  cancel(attemptId: string): void { this.running.get(attemptId)?.adapter.cancel?.(attemptId) }
  isAttemptAlive(attemptId: string): boolean { return this.running.get(attemptId)?.adapter.isAttemptAlive?.(attemptId) ?? false }

  private dispatch(): void {
    const waitingForWrite = new Set<string>()
    for (const waiter of this.waiting) {
      if (this.active >= this.maxConcurrent) break
      const slot = waiter.candidates.filter(item => item.active < item.maxConcurrent && this.workspaceAvailable(item.workspaceKey, waiter.readOnly, waitingForWrite))
        .sort((a, b) => a.active / a.maxConcurrent - b.active / b.maxConcurrent)[0]
      if (slot === undefined) {
        if (!waiter.readOnly) for (const candidate of waiter.candidates) {
          if (candidate.workspaceKey !== undefined) waitingForWrite.add(candidate.workspaceKey)
        }
        continue
      }
      this.waiting.delete(waiter)
      waiter.signal.removeEventListener('abort', waiter.abort)
      this.active++
      slot.active++
      waiter.resolve(this.lease(slot, waiter.readOnly))
    }
  }

  private workspaceAvailable(key: string | undefined, readOnly: boolean, waitingForWrite: ReadonlySet<string>): boolean {
    if (key === undefined) return true
    const usage = this.workspaces.get(key)
    if ((usage?.writers ?? 0) > 0) return false
    return readOnly ? !waitingForWrite.has(key) : (usage?.readers ?? 0) === 0
  }

  private lease(slot: Slot, readOnly: boolean): WorkerLease {
    const key = slot.workspaceKey
    const usage = key === undefined ? undefined : this.workspaces.get(key) ?? { readers: 0, writers: 0 }
    if (key !== undefined && usage !== undefined) {
      usage[readOnly ? 'readers' : 'writers']++
      this.workspaces.set(key, usage)
    }
    let state: 'reserved' | 'running' | 'released' = 'reserved'
    const release = (): void => {
      state = 'released'
      this.active--
      slot.active--
      if (key !== undefined && usage !== undefined) {
        usage[readOnly ? 'readers' : 'writers']--
        if (usage.readers === 0 && usage.writers === 0) this.workspaces.delete(key)
      }
      this.dispatch()
    }
    return {
      workerId: slot.id,
      release: () => { if (state === 'reserved') release() },
      execute: async input => {
        if (state !== 'reserved') throw new Error('Worker 执行名额已使用')
        state = 'running'
        this.running.set(input.attemptId, slot)
        try { return await slot.adapter.execute(input) }
        finally {
          this.running.delete(input.attemptId)
          release()
        }
      },
    }
  }
}
