import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createProjectionSchema, projectEvent } from './projections.js'
import type { GoalState, TaskNode, TaskState } from './domain.js'

/** Durable event accepted by the runtime event log. Payloads must be JSON serializable. */
export interface RuntimeEvent { readonly type: string; readonly goalId: string; readonly taskId?: string; readonly payload: Record<string, unknown>; readonly seq?: number; readonly createdAt?: string }
export interface TaskSessionLink { readonly sessionId: string; readonly kind: 'origin' | 'attached' | 'execution_child' }
export interface CurrentTaskBinding { readonly sessionId: string; readonly taskId: string; readonly controlRevision: number }
export interface GoalProjection { readonly id: string; readonly objective: string; readonly constraints: readonly string[]; readonly planningMode: 'auto' | 'require_confirmation'; readonly state: GoalState; readonly revision: number; readonly controlRevision: number; readonly workspaceScope?: string; readonly pauseReason?: string; readonly archivedAt?: string }
export interface GoalVersion { readonly version: number; readonly objective: string; readonly reason: string; readonly source: string; readonly createdAt: string }
export interface AttemptProjection { readonly id: string; readonly goalId: string; readonly taskId: string; readonly revision: number; readonly state: string; readonly dshSessionId?: string; readonly context: Record<string, unknown>; readonly summary?: string }
export interface ArtifactProjection { readonly id: string; readonly goalId: string; readonly taskId: string; readonly attemptId: string; readonly type: string; readonly contentHash: string; readonly storage: 'inline' | 'file'; readonly content?: string; readonly path?: string; readonly mimeType?: string; readonly active: boolean; readonly validated: boolean }
export interface DecisionProjection { readonly type: string; readonly payload: Record<string, unknown> }
export interface EvidenceProjection { readonly taskId?: string; readonly attemptId?: string; readonly value: unknown }
export interface CheckpointProjection { readonly eventSeq?: number; readonly revision: number; readonly payload: Record<string, unknown> }
export interface ContextManifestProjection { readonly attemptId: string; readonly taskId: string; readonly revision: number; readonly selectionReason: string; readonly context: Record<string, unknown> }

/** SQLite append-only event log and entirely rebuildable materialized projections. */
export class RuntimeEventStore {
  private readonly db: DatabaseSync
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; CREATE TABLE IF NOT EXISTS runtime_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, type TEXT NOT NULL, goal_id TEXT NOT NULL, task_id TEXT, payload_json TEXT NOT NULL); CREATE INDEX IF NOT EXISTS runtime_events_goal_seq ON runtime_events(goal_id, seq);')
    createProjectionSchema(this.db)
  }
  /** Append events and project them within the caller's transaction, if any. */
  append(events: readonly RuntimeEvent[]): void {
    const insert = this.db.prepare('INSERT INTO runtime_events (type, goal_id, task_id, payload_json) VALUES (?, ?, ?, ?)')
    for (const event of events) { const result = insert.run(event.type, event.goalId, event.taskId ?? null, JSON.stringify(event.payload)); projectEvent(this.db, event, Number(result.lastInsertRowid)) }
  }
  /** Run related event writes atomically. Nested transactions are intentionally not supported. */
  transaction<T>(work: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const result = work(); this.db.exec('COMMIT'); return result } catch (error) { this.db.exec('ROLLBACK'); throw error } }
  /** Rebuild every owned projection from ordered append-only events. */
  rebuild(): void {
    this.transaction(() => {
      this.db.exec('DELETE FROM current_task_bindings; DELETE FROM task_session_links; DELETE FROM context_manifests; DELETE FROM goal_versions; DELETE FROM goals; DELETE FROM plan_revisions; DELETE FROM task_nodes; DELETE FROM task_attempts; DELETE FROM artifacts; DELETE FROM evidence; DELETE FROM validation_results; DELETE FROM decisions; DELETE FROM memories; DELETE FROM checkpoints;')
      const rows = this.db.prepare('SELECT seq, type, goal_id, task_id, payload_json FROM runtime_events ORDER BY seq').all() as Array<{ seq: number; type: string; goal_id: string; task_id: string | null; payload_json: string }>
      for (const row of rows) projectEvent(this.db, { type: row.type, goalId: row.goal_id, ...(row.task_id == null ? {} : { taskId: row.task_id }), payload: JSON.parse(row.payload_json) as Record<string, unknown> }, row.seq)
    })
  }
  getGoal(goalId: string): GoalProjection | undefined {
    const row = this.db.prepare('SELECT id, objective, constraints_json, planning_mode, state, revision, control_revision, workspace_scope, pause_reason, archived_at FROM goals WHERE id = ?').get(goalId) as Record<string, unknown> | undefined
    return row === undefined ? undefined : goalProjection(row)
  }
  /** All profile-local goals, newest first.  Task Area intentionally spans sessions. */
  listGoals(options: { readonly archived?: boolean } = {}): GoalProjection[] {
    const rows = this.db.prepare(`SELECT id, objective, constraints_json, planning_mode, state, revision, control_revision, workspace_scope, pause_reason, archived_at FROM goals ${options.archived === true ? 'WHERE archived_at IS NOT NULL' : 'WHERE archived_at IS NULL'} ORDER BY rowid DESC`).all() as Array<Record<string, unknown>>
    return rows.map(goalProjection)
  }
  listGoalVersions(goalId: string): GoalVersion[] {
    return (this.db.prepare('SELECT version, objective, reason, source, created_at FROM goal_versions WHERE goal_id = ? ORDER BY version').all(goalId) as Array<Record<string, unknown>>).map(row => ({ version: Number(row.version), objective: String(row.objective), reason: String(row.reason), source: String(row.source), createdAt: String(row.created_at) }))
  }
  /** Physical removal is reserved for expired archives; ordinary lifecycle stays append-only. */
  purgeArchivedBefore(cutoff: string): string[] {
    const goalIds = (this.db.prepare('SELECT id FROM goals WHERE archived_at IS NOT NULL AND archived_at < ? ORDER BY id').all(cutoff) as Array<{ id: string }>).map(row => row.id)
    if (goalIds.length === 0) return []
    const remove = (table: string) => this.db.prepare(`DELETE FROM ${table} WHERE goal_id = ?`)
    for (const goalId of goalIds) {
      remove('current_task_bindings').run(goalId)
      remove('task_session_links').run(goalId); remove('context_manifests').run(goalId); remove('goal_versions').run(goalId)
      remove('plan_revisions').run(goalId); remove('task_nodes').run(goalId); remove('task_attempts').run(goalId); remove('artifacts').run(goalId)
      remove('evidence').run(goalId); remove('validation_results').run(goalId); remove('decisions').run(goalId); remove('memories').run(goalId); remove('checkpoints').run(goalId)
      remove('runtime_events').run(goalId)
      this.db.prepare('DELETE FROM goals WHERE id = ?').run(goalId)
    }
    return goalIds
  }
  /** File-backed artifacts belonging to archives eligible for physical removal. */
  listArchivedArtifactPathsBefore(cutoff: string): string[] {
    return (this.db.prepare("SELECT DISTINCT a.path FROM artifacts a JOIN goals g ON g.id = a.goal_id WHERE g.archived_at IS NOT NULL AND g.archived_at < ? AND a.storage = 'file' AND a.path IS NOT NULL").all(cutoff) as Array<{ path: string }>).map(row => row.path)
  }
  /** Content-addressed files can be shared; delete one only after its final projection reference is gone. */
  isArtifactPathReferenced(path: string): boolean {
    const row = this.db.prepare('SELECT 1 AS present FROM artifacts WHERE path = ? LIMIT 1').get(path) as { present?: number } | undefined
    return row !== undefined
  }
  listSessionLinks(goalId: string): TaskSessionLink[] {
    return (this.db.prepare('SELECT session_id, kind FROM task_session_links WHERE goal_id = ? ORDER BY created_order').all(goalId) as Array<Record<string, unknown>>).map(row => ({ sessionId: String(row.session_id), kind: String(row.kind) as TaskSessionLink['kind'] }))
  }
  /** One explicit display binding per conversation; historic task links remain separate. */
  getCurrentTaskForSession(sessionId: string): CurrentTaskBinding | undefined {
    const row = this.db.prepare('SELECT session_id, goal_id, control_revision FROM current_task_bindings WHERE session_id = ?').get(sessionId) as Record<string, unknown> | undefined
    return row === undefined ? undefined : { sessionId: String(row.session_id), taskId: String(row.goal_id), controlRevision: Number(row.control_revision) }
  }
  listContextManifests(goalId: string): ContextManifestProjection[] {
    return (this.db.prepare('SELECT attempt_id, task_id, revision, selection_reason, context_json FROM context_manifests WHERE goal_id = ? ORDER BY created_order').all(goalId) as Array<Record<string, unknown>>).map(row => ({ attemptId: String(row.attempt_id), taskId: String(row.task_id), revision: Number(row.revision), selectionReason: String(row.selection_reason), context: JSON.parse(String(row.context_json)) as Record<string, unknown> }))
  }
  getPlan(goalId: string, revision?: number): { readonly revision: number; readonly state: string; readonly tasks: TaskNode[]; readonly invalidatedTaskIds: readonly string[]; readonly staleTaskIds: readonly string[]; readonly baseRevision?: number; readonly trigger?: Record<string, unknown> } | undefined {
    const row = this.db.prepare(revision == null ? 'SELECT revision, state, tasks_json, metadata_json FROM plan_revisions WHERE goal_id = ? ORDER BY revision DESC LIMIT 1' : 'SELECT revision, state, tasks_json, metadata_json FROM plan_revisions WHERE goal_id = ? AND revision = ?').get(...(revision == null ? [goalId] : [goalId, revision])) as Record<string, unknown> | undefined
    if (row === undefined) return undefined
    const metadata = JSON.parse(String(row.metadata_json ?? '{}')) as Record<string, unknown>
    return { revision: Number(row.revision), state: String(row.state), tasks: JSON.parse(String(row.tasks_json)) as TaskNode[], invalidatedTaskIds: Array.isArray(metadata.invalidatedTaskIds) ? metadata.invalidatedTaskIds.map(String) : [], staleTaskIds: Array.isArray(metadata.staleTaskIds) ? metadata.staleTaskIds.map(String) : [], ...(typeof metadata.baseRevision === 'number' ? { baseRevision: metadata.baseRevision } : {}), ...(typeof metadata.trigger === 'object' && metadata.trigger !== null ? { trigger: metadata.trigger as Record<string, unknown> } : {}) }
  }
  /** Current task projection only; historical revisions remain queryable through getPlan(). */
  listTasks(goalId: string): TaskNode[] { const rows = this.db.prepare('SELECT task_json, state, created_order FROM task_nodes WHERE goal_id = ? AND revision = (SELECT revision FROM goals WHERE id = ?) ORDER BY created_order').all(goalId, goalId) as Array<{ task_json: string; state: string; created_order: number }>; return rows.map(row => ({ ...(JSON.parse(row.task_json) as TaskNode), state: row.state as TaskState, createdOrder: Number(row.created_order) })) }
  getTask(goalId: string, taskId: string): TaskNode | undefined { return this.listTasks(goalId).find(task => task.id === taskId) }
  listAttempts(taskId: string, goalId?: string): AttemptProjection[] {
    const rows = this.db.prepare(goalId === undefined
      ? 'SELECT id, goal_id, task_id, revision, state, dsh_session_id, context_json, summary FROM task_attempts WHERE task_id = ? ORDER BY created_order'
      : 'SELECT id, goal_id, task_id, revision, state, dsh_session_id, context_json, summary FROM task_attempts WHERE task_id = ? AND goal_id = ? ORDER BY created_order')
      .all(...(goalId === undefined ? [taskId] : [taskId, goalId])) as Array<Record<string, unknown>>
    return rows.map(row => ({ id: String(row.id), goalId: String(row.goal_id), taskId: String(row.task_id), revision: Number(row.revision), state: String(row.state), ...(row.dsh_session_id == null ? {} : { dshSessionId: String(row.dsh_session_id) }), context: JSON.parse(String(row.context_json)) as Record<string, unknown>, ...(row.summary == null ? {} : { summary: String(row.summary) }) }))
  }
  listRunningAttempts(): AttemptProjection[] {
    const rows = this.db.prepare("SELECT id, goal_id, task_id, revision, state, dsh_session_id, context_json, summary FROM task_attempts WHERE state = 'RUNNING'").all() as Array<Record<string, unknown>>
    return rows.map(row => ({ id: String(row.id), goalId: String(row.goal_id), taskId: String(row.task_id), revision: Number(row.revision), state: String(row.state), ...(row.dsh_session_id == null ? {} : { dshSessionId: String(row.dsh_session_id) }), context: JSON.parse(String(row.context_json)) as Record<string, unknown>, ...(row.summary == null ? {} : { summary: String(row.summary) }) }))
  }
  listActiveValidatedArtifacts(goalId: string, taskIds?: readonly string[]): ArtifactProjection[] {
    const rows = this.db.prepare('SELECT id, goal_id, task_id, attempt_id, type, content_hash, storage, content, path, mime_type, active, validated FROM artifacts WHERE goal_id = ? AND active = 1 AND validated = 1 ORDER BY rowid').all(goalId) as Array<Record<string, unknown>>
    const wanted = taskIds === undefined ? undefined : new Set(taskIds)
    return rows.filter(row => wanted === undefined || wanted.has(String(row.task_id))).map(row => ({ id: String(row.id), goalId: String(row.goal_id), taskId: String(row.task_id), attemptId: String(row.attempt_id), type: String(row.type), contentHash: String(row.content_hash), storage: String(row.storage) as 'inline' | 'file', ...(row.content == null ? {} : { content: String(row.content) }), ...(row.path == null ? {} : { path: String(row.path) }), ...(row.mime_type == null ? {} : { mimeType: String(row.mime_type) }), active: Boolean(row.active), validated: Boolean(row.validated) }))
  }
  listDecisions(goalId: string): DecisionProjection[] {
    return (this.db.prepare('SELECT type, payload_json FROM decisions WHERE goal_id = ? ORDER BY id').all(goalId) as Array<Record<string, unknown>>).map(row => ({ type: String(row.type), payload: JSON.parse(String(row.payload_json)) as Record<string, unknown> }))
  }
  listEvidence(goalId: string): EvidenceProjection[] {
    return (this.db.prepare('SELECT task_id, attempt_id, value_json FROM evidence WHERE goal_id = ? ORDER BY id').all(goalId) as Array<Record<string, unknown>>).map(row => ({ ...(row.task_id == null ? {} : { taskId: String(row.task_id) }), ...(row.attempt_id == null ? {} : { attemptId: String(row.attempt_id) }), value: JSON.parse(String(row.value_json)) }))
  }
  latestCheckpoint(goalId: string): CheckpointProjection | undefined {
    const row = this.db.prepare('SELECT event_seq, revision, payload_json FROM checkpoints WHERE goal_id = ? ORDER BY id DESC LIMIT 1').get(goalId) as Record<string, unknown> | undefined
    return row === undefined ? undefined : { ...(row.event_seq == null ? {} : { eventSeq: Number(row.event_seq) }), revision: Number(row.revision), payload: JSON.parse(String(row.payload_json)) as Record<string, unknown> }
  }
  latestSeq(goalId: string): number { const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM runtime_events WHERE goal_id = ?').get(goalId) as { seq: number }; return Number(row.seq) }
  /** Cursor-based event page in append order; the event log remains the only authority. */
  listEvents(goalId: string, afterSeq = 0, limit = 50, taskId?: string): RuntimeEvent[] {
    const rows = this.db.prepare(taskId === undefined
      ? 'SELECT seq, created_at, type, goal_id, task_id, payload_json FROM runtime_events WHERE goal_id = ? AND seq > ? ORDER BY seq LIMIT ?'
      : 'SELECT seq, created_at, type, goal_id, task_id, payload_json FROM runtime_events WHERE goal_id = ? AND seq > ? AND task_id = ? ORDER BY seq LIMIT ?')
      .all(...(taskId === undefined ? [goalId, afterSeq, limit] : [goalId, afterSeq, taskId, limit])) as Array<{ seq: number; created_at: string; type: string; goal_id: string; task_id: string | null; payload_json: string }>
    return rows.map(row => ({ seq: Number(row.seq), createdAt: row.created_at, type: row.type, goalId: row.goal_id, ...(row.task_id == null ? {} : { taskId: row.task_id }), payload: JSON.parse(row.payload_json) as Record<string, unknown> }))
  }
  listRecentEvents(goalId: string, limit = 20): RuntimeEvent[] { const rows = this.db.prepare('SELECT created_at, type, goal_id, task_id, payload_json FROM runtime_events WHERE goal_id = ? ORDER BY seq DESC LIMIT ?').all(goalId, limit) as Array<{ created_at: string; type: string; goal_id: string; task_id: string | null; payload_json: string }>; return rows.reverse().map(row => ({ createdAt: row.created_at, type: row.type, goalId: row.goal_id, ...(row.task_id == null ? {} : { taskId: row.task_id }), payload: JSON.parse(row.payload_json) as Record<string, unknown> })) }
  snapshot(goalId: string): Record<string, unknown> { return { goal: this.getGoal(goalId), plan: this.getPlan(goalId), tasks: this.listTasks(goalId), attempts: this.listTasks(goalId).flatMap(task => this.listAttempts(task.id, goalId)), artifacts: this.listActiveValidatedArtifacts(goalId), events: this.listRecentEvents(goalId, 10000) } }
  close(): void { this.db.close() }
}

function goalProjection(row: Record<string, unknown>): GoalProjection {
  return {
    id: String(row.id), objective: String(row.objective), constraints: JSON.parse(String(row.constraints_json)) as string[], planningMode: String(row.planning_mode) as GoalProjection['planningMode'], state: String(row.state) as GoalState, revision: Number(row.revision), controlRevision: Number(row.control_revision),
    ...(row.workspace_scope == null ? {} : { workspaceScope: String(row.workspace_scope) }), ...(row.pause_reason == null ? {} : { pauseReason: String(row.pause_reason) }), ...(row.archived_at == null ? {} : { archivedAt: String(row.archived_at) }),
  }
}
