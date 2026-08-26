/** Creates read models which are deliberately disposable: runtime_events is authoritative. */
export function createProjectionSchema(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS goals (id TEXT PRIMARY KEY, objective TEXT NOT NULL, constraints_json TEXT NOT NULL DEFAULT '[]', planning_mode TEXT NOT NULL DEFAULT 'auto', state TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, control_revision INTEGER NOT NULL DEFAULT 0, workspace_scope TEXT, pause_reason TEXT, archived_at TEXT);
    CREATE TABLE IF NOT EXISTS goal_versions (goal_id TEXT NOT NULL, version INTEGER NOT NULL, objective TEXT NOT NULL, reason TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL, created_order INTEGER NOT NULL, PRIMARY KEY(goal_id, version));
    CREATE TABLE IF NOT EXISTS task_session_links (goal_id TEXT NOT NULL, session_id TEXT NOT NULL, kind TEXT NOT NULL, created_order INTEGER NOT NULL, PRIMARY KEY(goal_id, session_id, kind));
    CREATE TABLE IF NOT EXISTS current_task_bindings (session_id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, control_revision INTEGER NOT NULL, updated_order INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS context_manifests (attempt_id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, task_id TEXT NOT NULL, revision INTEGER NOT NULL, selection_reason TEXT NOT NULL, context_json TEXT NOT NULL, created_order INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS plan_revisions (goal_id TEXT NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL, tasks_json TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}', PRIMARY KEY(goal_id, revision));
    CREATE TABLE IF NOT EXISTS task_nodes (goal_id TEXT NOT NULL, task_id TEXT NOT NULL, revision INTEGER NOT NULL, objective TEXT NOT NULL, depends_on_json TEXT NOT NULL, priority INTEGER NOT NULL, side_effect_class TEXT NOT NULL, state TEXT NOT NULL, task_json TEXT NOT NULL, created_order INTEGER NOT NULL, PRIMARY KEY(goal_id, task_id, revision));
    CREATE TABLE IF NOT EXISTS task_attempts (id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, task_id TEXT NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL, dsh_session_id TEXT, context_json TEXT NOT NULL DEFAULT '{}', summary TEXT, created_order INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, task_id TEXT NOT NULL, attempt_id TEXT NOT NULL, type TEXT NOT NULL, content_hash TEXT NOT NULL, storage TEXT NOT NULL, content TEXT, path TEXT, mime_type TEXT, active INTEGER NOT NULL DEFAULT 1, validated INTEGER NOT NULL DEFAULT 0, superseded_by TEXT);
    CREATE TABLE IF NOT EXISTS evidence (id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id TEXT NOT NULL, task_id TEXT, attempt_id TEXT, value_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS validation_results (id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id TEXT NOT NULL, task_id TEXT NOT NULL, attempt_id TEXT NOT NULL, ok INTEGER NOT NULL, validator TEXT NOT NULL, reason TEXT);
    CREATE TABLE IF NOT EXISTS decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id TEXT NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id TEXT NOT NULL, level TEXT NOT NULL, content TEXT NOT NULL, refs_json TEXT NOT NULL DEFAULT '[]');
    CREATE TABLE IF NOT EXISTS checkpoints (id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id TEXT NOT NULL, event_seq INTEGER, revision INTEGER NOT NULL, payload_json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS task_nodes_goal_state ON task_nodes(goal_id, state);
    CREATE INDEX IF NOT EXISTS task_attempts_task ON task_attempts(task_id, created_order);
    CREATE INDEX IF NOT EXISTS artifacts_goal_task ON artifacts(goal_id, task_id);
  `);
    const planColumns = db.prepare('PRAGMA table_info(plan_revisions)').all();
    if (!planColumns.some(column => column.name === 'metadata_json'))
        db.exec("ALTER TABLE plan_revisions ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'");
    const goalColumns = db.prepare('PRAGMA table_info(goals)').all();
    if (!goalColumns.some(column => column.name === 'control_revision'))
        db.exec('ALTER TABLE goals ADD COLUMN control_revision INTEGER NOT NULL DEFAULT 0');
    if (!goalColumns.some(column => column.name === 'workspace_scope'))
        db.exec('ALTER TABLE goals ADD COLUMN workspace_scope TEXT');
    if (!goalColumns.some(column => column.name === 'archived_at'))
        db.exec('ALTER TABLE goals ADD COLUMN archived_at TEXT');
}
/** Applies exactly one durable event to materialized views. */
export function projectEvent(db, event, seq) {
    const p = event.payload;
    const taskId = event.taskId;
    switch (event.type) {
        case 'GoalCreated':
            db.prepare('INSERT INTO goals (id, objective, constraints_json, planning_mode, state, revision, control_revision, workspace_scope) VALUES (?, ?, ?, ?, ?, 0, 0, ?)').run(event.goalId, String(p.objective), JSON.stringify(p.constraints ?? []), String(p.planningMode ?? 'auto'), 'DRAFT', p.workspaceScope == null ? null : String(p.workspaceScope));
            db.prepare('INSERT OR IGNORE INTO goal_versions (goal_id, version, objective, reason, source, created_at, created_order) VALUES (?, 0, ?, ?, ?, ?, ?)').run(event.goalId, String(p.objective), 'initial objective', String(p.source ?? 'user'), String(p.createdAt ?? '1970-01-01T00:00:00.000Z'), seq);
            break;
        case 'GoalObjectiveRevised':
            db.prepare('INSERT INTO goal_versions (goal_id, version, objective, reason, source, created_at, created_order) VALUES (?, ?, ?, ?, ?, ?, ?)').run(event.goalId, Number(p.version), String(p.objective), String(p.reason), String(p.source ?? 'user'), String(p.createdAt), seq);
            db.prepare('UPDATE goals SET objective = ? WHERE id = ?').run(String(p.objective), event.goalId);
            break;
        case 'GoalArchived':
            db.prepare('UPDATE goals SET archived_at = ? WHERE id = ?').run(String(p.archivedAt), event.goalId);
            break;
        case 'GoalRestored':
            db.prepare('UPDATE goals SET archived_at = NULL WHERE id = ?').run(event.goalId);
            break;
        case 'TaskSessionAttached':
            db.prepare('INSERT OR IGNORE INTO task_session_links (goal_id, session_id, kind, created_order) VALUES (?, ?, ?, ?)').run(event.goalId, String(p.sessionId), String(p.kind), seq);
            break;
        case 'TaskSessionCurrentSet':
            db.prepare(`INSERT INTO current_task_bindings (session_id, goal_id, control_revision, updated_order) VALUES (?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET goal_id=excluded.goal_id, control_revision=excluded.control_revision, updated_order=excluded.updated_order`).run(String(p.sessionId), event.goalId, Number(p.controlRevision), seq);
            break;
        case 'TaskSessionCurrentCleared':
            db.prepare('DELETE FROM current_task_bindings WHERE session_id = ?').run(String(p.sessionId));
            break;
        case 'TaskControlRevisionAdvanced':
            db.prepare('UPDATE goals SET control_revision = ? WHERE id = ?').run(Number(p.controlRevision), event.goalId);
            break;
        case 'ExecutionInterrupted':
            db.prepare('UPDATE goals SET state = ?, pause_reason = ? WHERE id = ?').run('PAUSED', `interrupted:${String(p.cause)}:${String(p.recoveryOutcome)}`, event.goalId);
            break;
        case 'ContextManifestRecorded':
            if (taskId === undefined)
                throw new Error('ContextManifestRecorded requires taskId');
            db.prepare('INSERT OR REPLACE INTO context_manifests (attempt_id, goal_id, task_id, revision, selection_reason, context_json, created_order) VALUES (?, ?, ?, ?, ?, ?, ?)').run(String(p.attemptId), event.goalId, taskId, Number(p.revision), String(p.selectionReason), JSON.stringify(p.context ?? {}), seq);
            break;
        case 'PlanProposed':
            db.prepare('INSERT OR REPLACE INTO plan_revisions (goal_id, revision, state, tasks_json, metadata_json) VALUES (?, ?, ?, ?, ?)').run(event.goalId, Number(p.revision), 'PROPOSED', JSON.stringify(p.tasks ?? []), JSON.stringify({ invalidatedTaskIds: p.invalidatedTaskIds ?? [], staleTaskIds: p.staleTaskIds ?? [], ...(p.baseRevision === undefined ? {} : { baseRevision: p.baseRevision }), ...(p.trigger === undefined ? {} : { trigger: p.trigger }) }));
            db.prepare('UPDATE goals SET state = ? WHERE id = ?').run('AWAITING_CONFIRMATION', event.goalId);
            break;
        case 'PlanRejected':
            db.prepare('UPDATE plan_revisions SET state = ? WHERE goal_id = ? AND revision = ?').run('REJECTED', event.goalId, Number(p.revision));
            db.prepare('UPDATE goals SET state = ?, pause_reason = NULL WHERE id = ?').run(String(p.restoreState ?? 'RUNNING'), event.goalId);
            break;
        case 'PlanConfirmed':
            db.prepare('UPDATE plan_revisions SET state = ? WHERE goal_id = ? AND revision = ?').run('APPLIED', event.goalId, Number(p.revision));
            break;
        case 'PlanApplied':
        case 'PlanRevisionApplied': {
            const revision = Number(p.revision);
            const tasks = Array.isArray(p.tasks) ? p.tasks : [];
            db.prepare('INSERT OR REPLACE INTO plan_revisions (goal_id, revision, state, tasks_json, metadata_json) VALUES (?, ?, ?, ?, ?)').run(event.goalId, revision, 'APPLIED', JSON.stringify(tasks), JSON.stringify({ invalidatedTaskIds: p.invalidatedTaskIds ?? [], staleTaskIds: p.staleTaskIds ?? [] }));
            for (let i = 0; i < tasks.length; i += 1) {
                const task = tasks[i];
                db.prepare(`INSERT INTO task_nodes (goal_id, task_id, revision, objective, depends_on_json, priority, side_effect_class, state, task_json, created_order)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(goal_id, task_id, revision) DO UPDATE SET objective=excluded.objective, depends_on_json=excluded.depends_on_json, priority=excluded.priority, side_effect_class=excluded.side_effect_class, state=excluded.state, task_json=excluded.task_json`).run(event.goalId, String(task.id), revision, String(task.objective), JSON.stringify(task.dependsOn ?? []), Number(task.priority ?? 0), String(task.sideEffectClass ?? 'read_only'), String(task.state ?? 'PENDING'), JSON.stringify(task), seq * 1000 + i);
            }
            const invalidated = Array.isArray(p.invalidatedTaskIds) ? p.invalidatedTaskIds.map(String) : tasks.filter(task => String(task.state) === 'INVALIDATED').map(task => String(task.id));
            for (const invalidatedTaskId of invalidated) {
                db.prepare('UPDATE artifacts SET active = 0 WHERE goal_id = ? AND task_id = ? AND active = 1').run(event.goalId, invalidatedTaskId);
                db.prepare('UPDATE task_nodes SET state = ? WHERE goal_id = ? AND task_id = ? AND revision = ?').run('INVALIDATED', event.goalId, invalidatedTaskId, revision);
            }
            const stale = Array.isArray(p.staleTaskIds) ? p.staleTaskIds.map(String) : [];
            for (const staleTaskId of stale)
                db.prepare('UPDATE artifacts SET active = 0 WHERE goal_id = ? AND task_id = ? AND active = 1').run(event.goalId, staleTaskId);
            db.prepare('UPDATE goals SET state = ?, revision = ?, pause_reason = NULL WHERE id = ?').run('RUNNING', revision, event.goalId);
            break;
        }
        case 'TaskAttemptStarted':
            if (taskId === undefined)
                throw new Error('TaskAttemptStarted requires taskId');
            db.prepare('INSERT INTO task_attempts (id, goal_id, task_id, revision, state, dsh_session_id, context_json, created_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(String(p.attemptId), event.goalId, taskId, Number(p.revision ?? 1), 'RUNNING', p.dshSessionId == null ? null : String(p.dshSessionId), JSON.stringify(p.context ?? {}), seq);
            updateCurrentTask(db, event.goalId, taskId, 'RUNNING');
            break;
        case 'ArtifactProduced':
            if (taskId === undefined)
                throw new Error('ArtifactProduced requires taskId');
            db.prepare('INSERT INTO artifacts (id, goal_id, task_id, attempt_id, type, content_hash, storage, content, path, mime_type, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(String(p.id), event.goalId, taskId, String(p.attemptId), String(p.type), String(p.contentHash), String(p.storage), p.content == null ? null : String(p.content), p.path == null ? null : String(p.path), p.mimeType == null ? null : String(p.mimeType), p.active === false ? 0 : 1);
            break;
        case 'TaskAttemptSessionRecorded':
            db.prepare('UPDATE task_attempts SET dsh_session_id = ? WHERE id = ?').run(String(p.dshSessionId), String(p.attemptId));
            break;
        case 'EvidenceRecorded':
            db.prepare('INSERT INTO evidence (goal_id, task_id, attempt_id, value_json) VALUES (?, ?, ?, ?)').run(event.goalId, taskId ?? null, p.attemptId == null ? null : String(p.attemptId), JSON.stringify(p.evidence ?? p));
            break;
        case 'ValidationRecorded':
            if (taskId === undefined)
                throw new Error('ValidationRecorded requires taskId');
            db.prepare('INSERT INTO validation_results (goal_id, task_id, attempt_id, ok, validator, reason) VALUES (?, ?, ?, ?, ?, ?)').run(event.goalId, taskId, String(p.attemptId), p.ok ? 1 : 0, String(p.validator ?? 'default'), p.reason == null ? null : String(p.reason));
            if (p.ok)
                db.prepare('UPDATE artifacts SET validated = 1 WHERE attempt_id = ?').run(String(p.attemptId));
            break;
        case 'TaskCompleted':
            if (taskId === undefined)
                throw new Error('TaskCompleted requires taskId');
            db.prepare('UPDATE task_attempts SET state = ?, summary = ? WHERE id = ?').run('SUCCEEDED', p.summary == null ? null : String(p.summary), String(p.attemptId));
            updateCurrentTaskForAttempt(db, event.goalId, taskId, String(p.attemptId), 'SUCCEEDED');
            break;
        case 'TaskAttemptSuperseded':
            if (taskId === undefined)
                throw new Error('TaskAttemptSuperseded requires taskId');
            db.prepare('UPDATE task_attempts SET state = ?, summary = ? WHERE id = ?').run('SUPERSEDED', p.reason == null ? null : String(p.reason), String(p.attemptId));
            break;
        case 'TaskFailed':
            if (taskId === undefined)
                throw new Error('TaskFailed requires taskId');
            db.prepare('UPDATE task_attempts SET state = ?, summary = ? WHERE id = ?').run('FAILED', p.reason == null ? null : String(p.reason), String(p.attemptId));
            updateCurrentTask(db, event.goalId, taskId, 'FAILED');
            blockDependentTasks(db, event.goalId);
            break;
        case 'TaskAttemptFailed':
            if (taskId === undefined)
                throw new Error('TaskAttemptFailed requires taskId');
            db.prepare('UPDATE task_attempts SET state = ?, summary = ? WHERE id = ?').run('FAILED', p.reason == null ? null : String(p.reason), String(p.attemptId));
            break;
        case 'TaskRetryScheduled':
            if (taskId !== undefined)
                updateCurrentTask(db, event.goalId, taskId, 'PENDING');
            break;
        case 'TaskInterrupted':
            if (taskId === undefined)
                throw new Error('TaskInterrupted requires taskId');
            db.prepare('UPDATE task_attempts SET state = ? WHERE id = ?').run('INTERRUPTED', String(p.attemptId));
            updateCurrentTask(db, event.goalId, taskId, 'PENDING');
            break;
        case 'TaskRecoveryBlocked':
            if (taskId === undefined)
                throw new Error('TaskRecoveryBlocked requires taskId');
            updateCurrentTask(db, event.goalId, taskId, 'BLOCKED');
            break;
        case 'TaskRecoveryResolved':
            if (taskId === undefined)
                throw new Error('TaskRecoveryResolved requires taskId');
            updateCurrentTask(db, event.goalId, taskId, p.resolution === 'confirmed_succeeded' ? 'SUCCEEDED' : 'PENDING');
            break;
        case 'TaskInvalidated':
            if (taskId !== undefined)
                updateCurrentTask(db, event.goalId, taskId, 'INVALIDATED');
            break;
        case 'GoalPaused':
            db.prepare('UPDATE goals SET state = ?, pause_reason = ? WHERE id = ?').run('PAUSED', String(p.reason ?? 'paused'), event.goalId);
            break;
        case 'GoalResumed':
            db.prepare('UPDATE goals SET state = ?, pause_reason = NULL WHERE id = ?').run('RUNNING', event.goalId);
            break;
        case 'GoalCancelled':
            db.prepare('UPDATE goals SET state = ? WHERE id = ?').run('CANCELLED', event.goalId);
            db.prepare("UPDATE task_nodes SET state = 'CANCELLED' WHERE goal_id = ? AND revision = (SELECT revision FROM goals WHERE id = ?) AND state IN ('PENDING', 'READY', 'RUNNING', 'BLOCKED')").run(event.goalId, event.goalId);
            db.prepare("UPDATE task_attempts SET state = 'CANCELLED', summary = COALESCE(summary, 'goal cancelled') WHERE goal_id = ? AND state = 'RUNNING'").run(event.goalId);
            break;
        case 'GoalSucceeded':
            db.prepare('UPDATE goals SET state = ? WHERE id = ?').run('SUCCEEDED', event.goalId);
            break;
        case 'GoalFailed':
            db.prepare('UPDATE goals SET state = ? WHERE id = ?').run('FAILED', event.goalId);
            break;
        case 'CheckpointCreated':
            db.prepare('INSERT INTO checkpoints (goal_id, event_seq, revision, payload_json) VALUES (?, ?, ?, ?)').run(event.goalId, p.eventSeq == null ? null : Number(p.eventSeq), Number(p.revision), JSON.stringify(p));
            break;
        case 'DecisionRecorded':
            db.prepare('INSERT INTO decisions (goal_id, type, payload_json) VALUES (?, ?, ?)').run(event.goalId, String(p.type ?? 'decision'), JSON.stringify(p));
            break;
    }
}
function updateCurrentTask(db, goalId, taskId, state) {
    db.prepare('UPDATE task_nodes SET state = ? WHERE goal_id = ? AND task_id = ? AND revision = (SELECT revision FROM goals WHERE id = ?)').run(state, goalId, taskId, goalId);
}
/** Completion may only change the logical task that belongs to the same plan revision as its attempt. */
function updateCurrentTaskForAttempt(db, goalId, taskId, attemptId, state) {
    db.prepare('UPDATE task_nodes SET state = ? WHERE goal_id = ? AND task_id = ? AND revision = (SELECT revision FROM goals WHERE id = ?) AND revision = (SELECT revision FROM task_attempts WHERE id = ?)').run(state, goalId, taskId, goalId, attemptId);
}
/** A terminal dependency failure blocks only its downstream pending region. */
function blockDependentTasks(db, goalId) {
    const rows = db.prepare('SELECT task_id, depends_on_json, state FROM task_nodes WHERE goal_id = ? AND revision = (SELECT revision FROM goals WHERE id = ?)').all(goalId, goalId);
    const states = new Map(rows.map(row => [row.task_id, row.state]));
    let changed = true;
    while (changed) {
        changed = false;
        for (const row of rows) {
            if (states.get(row.task_id) !== 'PENDING')
                continue;
            const dependencies = JSON.parse(row.depends_on_json);
            if (dependencies.some(id => ['FAILED', 'BLOCKED', 'CANCELLED', 'INVALIDATED'].includes(states.get(id) ?? ''))) {
                states.set(row.task_id, 'BLOCKED');
                updateCurrentTask(db, goalId, row.task_id, 'BLOCKED');
                changed = true;
            }
        }
    }
}
