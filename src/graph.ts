import type { GraphMutation, PlanDraft, TaskDraft, TaskNode, ValidatedPlan } from './domain.js'
import { PlanValidationError } from './domain.js'

type MutableTaskNode = { -readonly [Key in keyof TaskNode]: Key extends 'dependsOn' ? string[] : TaskNode[Key] }

/** Validate planner output and return a normalized immutable plan revision. */
export function validatePlan(draft: PlanDraft): ValidatedPlan {
  if (typeof draft.goalId !== 'string' || draft.goalId.trim().length === 0) throw new PlanValidationError('goal id must not be empty')
  if (!Number.isSafeInteger(draft.revision) || draft.revision < 1) throw new PlanValidationError('revision must be a positive integer')
  if (draft.tasks.length === 0) throw new PlanValidationError('plan must contain at least one task')
  const tasks = new Map<string, TaskNode>()
  for (const task of draft.tasks) {
    if (!task || typeof task !== 'object') throw new PlanValidationError('task must be an object')
    for (const field of ['priority', 'inputContract', 'outputContract', 'completionCriteria', 'retryPolicy', 'sideEffectClass', 'validator'] as const) if (task[field] === undefined) throw new PlanValidationError(`task ${String(task.id)} ${field} is required`)
    if (!Array.isArray(task.dependsOn) || task.dependsOn.some(id => typeof id !== 'string' || id.trim().length === 0)) throw new PlanValidationError(`task ${String(task.id)} has invalid dependencies`)
    if (task.id.trim().length === 0) throw new PlanValidationError('task id must not be empty')
    if (tasks.has(task.id)) throw new PlanValidationError(`duplicate task id: ${task.id}`)
    if (task.objective.trim().length === 0) throw new PlanValidationError(`task ${task.id} has an empty objective`)
    if (task.dependsOn.includes(task.id)) throw new PlanValidationError(`task ${task.id} depends on itself`)
    if (task.priority !== undefined && (!Number.isSafeInteger(task.priority))) throw new PlanValidationError(`task ${task.id} priority must be a safe integer`)
    if (task.sideEffectClass !== undefined && !['read_only', 'idempotent', 'external_effect'].includes(task.sideEffectClass)) throw new PlanValidationError(`task ${task.id} has invalid sideEffectClass`)
    if (task.retryPolicy !== undefined && (!Number.isSafeInteger(task.retryPolicy.maxAttempts) || task.retryPolicy.maxAttempts < 1)) throw new PlanValidationError(`task ${task.id} has invalid retry policy`)
    for (const [name, contract] of [['inputContract', task.inputContract], ['outputContract', task.outputContract]] as const) if (contract !== undefined && (contract === null || Array.isArray(contract) || typeof contract !== 'object')) throw new PlanValidationError(`task ${task.id} ${name} must be an object`)
    if (task.completionCriteria !== undefined && task.completionCriteria.trim().length === 0) throw new PlanValidationError(`task ${task.id} completionCriteria must not be empty`)
    if (task.validator !== undefined && task.validator.trim().length === 0) throw new PlanValidationError(`task ${task.id} validator must not be empty`)
    tasks.set(task.id, {
      ...task,
      dependsOn: [...task.dependsOn],
      priority: task.priority ?? 0,
      sideEffectClass: task.sideEffectClass ?? 'read_only',
      inputContract: task.inputContract ?? {},
      outputContract: task.outputContract ?? {},
      completionCriteria: task.completionCriteria ?? 'complete',
      retryPolicy: task.retryPolicy ?? { maxAttempts: 1 },
      state: 'PENDING',
    })
  }
  for (const task of tasks.values()) {
    for (const dependency of task.dependsOn) {
      if (!tasks.has(dependency)) throw new PlanValidationError(`task ${task.id} depends on missing task ${dependency}`)
    }
  }
  assertAcyclic(tasks)
  return { goalId: draft.goalId, revision: draft.revision, tasks }
}

/** Apply one V1 mutation by deriving and validating a complete new revision. */
export function applyMutation(current: ValidatedPlan, mutation: GraphMutation): ValidatedPlan {
  const next: MutableTaskNode[] = [...current.tasks.values()].map(task => ({ ...task, dependsOn: [...task.dependsOn] }))
  switch (mutation.kind) {
    case 'invalidateTask': {
      if (!current.tasks.has(mutation.taskId)) throw new PlanValidationError(`unknown task ${mutation.taskId}`)
      const invalidated = reachableFrom(current.tasks, mutation.taskId)
      for (const task of next) if (invalidated.has(task.id)) task.state = 'INVALIDATED'
      break
    }
    case 'addTask':
      next.push(normalizeTask(mutation.task))
      break
    case 'addEdge': {
      const task = next.find(candidate => candidate.id === mutation.taskId)
      if (task === undefined) throw new PlanValidationError(`unknown task ${mutation.taskId}`)
      task.dependsOn = [...task.dependsOn, mutation.dependencyId]
      break
    }
    case 'replaceTask': {
      const index = next.findIndex(task => task.id === mutation.taskId)
      if (index < 0) throw new PlanValidationError(`unknown task ${mutation.taskId}`)
      if (mutation.replacement.id !== mutation.taskId) throw new PlanValidationError('replacement task id must equal the replaced task id')
      next[index] = normalizeTask(mutation.replacement)
      break
    }
  }
  const validated = validatePlan({ goalId: current.goalId, revision: current.revision + 1, tasks: next })
  const withInvalidation = new Map(validated.tasks)
  for (const [id, previous] of current.tasks) {
    if (mutation.kind !== 'replaceTask' || id !== mutation.taskId) {
      const task = withInvalidation.get(id)
      if (task !== undefined) withInvalidation.set(id, { ...task, state: previous.state })
    }
  }
  if (mutation.kind === 'invalidateTask') {
    for (const id of reachableFrom(current.tasks, mutation.taskId)) {
      const task = withInvalidation.get(id)
      if (task !== undefined) withInvalidation.set(id, { ...task, state: 'INVALIDATED' })
    }
  }
  // A changed task's prior output cannot satisfy the changed graph.  The
  // affected downstream region is reset while unrelated completed work keeps
  // its projected state and artifacts.  They are PENDING in the new revision
  // (not INVALIDATED), so the replacement graph can actually rerun them.
  if (mutation.kind === 'replaceTask' || mutation.kind === 'addEdge') {
    const root = mutation.kind === 'replaceTask' ? mutation.taskId : mutation.taskId
    for (const id of reachableFrom(current.tasks, root)) {
      const task = withInvalidation.get(id)
      if (task !== undefined) withInvalidation.set(id, { ...task, state: 'PENDING' })
    }
  }
  return { ...validated, tasks: withInvalidation }
}

function normalizeTask(task: TaskDraft): MutableTaskNode {
  return {
    ...task,
    dependsOn: [...task.dependsOn],
    priority: task.priority ?? 0,
    sideEffectClass: task.sideEffectClass ?? 'read_only',
    inputContract: task.inputContract ?? {},
    outputContract: task.outputContract ?? {},
    completionCriteria: task.completionCriteria ?? 'complete',
    retryPolicy: task.retryPolicy ?? { maxAttempts: 1 },
    state: 'PENDING',
  }
}

function assertAcyclic(tasks: ReadonlyMap<string, TaskNode>): void {
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new PlanValidationError(`dependency cycle includes task ${id}`)
    if (visited.has(id)) return
    visiting.add(id)
    for (const dependency of tasks.get(id)?.dependsOn ?? []) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of tasks.keys()) visit(id)
}

function reachableFrom(tasks: ReadonlyMap<string, TaskNode>, root: string): Set<string> {
  const result = new Set<string>([root])
  let changed = true
  while (changed) {
    changed = false
    for (const task of tasks.values()) {
      if (!result.has(task.id) && task.dependsOn.some(dependency => result.has(dependency))) {
        result.add(task.id)
        changed = true
      }
    }
  }
  return result
}
