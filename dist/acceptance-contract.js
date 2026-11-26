export function parseAcceptanceChecks(value) {
    if (!Array.isArray(value))
        throw new TypeError('acceptanceChecks must be an array');
    const ids = new Set();
    return value.map(item => {
        if (item === null || typeof item !== 'object' || Array.isArray(item))
            throw new TypeError('acceptance check must be an object');
        const input = item;
        const kind = text(input.kind, 'kind');
        const id = text(input.id, 'id');
        if (ids.has(id))
            throw new TypeError(`duplicate acceptance check id: ${id}`);
        ids.add(id);
        const allowed = { command: ['id', 'kind', 'templateId', 'args', 'expectedExitCode'], file: ['id', 'kind', 'path', 'sha256'], json_schema: ['id', 'kind', 'source', 'schemaId'], http: ['id', 'kind', 'endpointId', 'requestId', 'expectedStatus'], database: ['id', 'kind', 'queryId', 'parameters'], external_effect: ['id', 'kind', 'readbackId', 'idempotencyKeyRef'], review: ['id', 'kind', 'rubricId', 'artifactIds'] };
        if (allowed[kind] === undefined)
            throw new TypeError(`unknown acceptance check kind: ${kind}`);
        for (const key of Object.keys(input))
            if (!allowed[kind].includes(key))
                throw new TypeError(`unknown acceptance check field: ${key}`);
        if (kind === 'command')
            return { id, kind, templateId: text(input.templateId, 'templateId'), args: strings(input.args, 'args'), expectedExitCode: integer(input.expectedExitCode, 'expectedExitCode') };
        if (kind === 'file')
            return { id, kind, path: path(input.path), ...(input.sha256 === undefined ? {} : { sha256: text(input.sha256, 'sha256') }) };
        if (kind === 'json_schema') {
            const source = object(input.source, 'source');
            const sourceKind = text(source.kind, 'source.kind');
            if (sourceKind !== 'artifact' && sourceKind !== 'file')
                throw new TypeError('source.kind must be artifact or file');
            return { id, kind, source: { kind: sourceKind, ref: text(source.ref, 'source.ref') }, schemaId: text(input.schemaId, 'schemaId') };
        }
        if (kind === 'http')
            return { id, kind, endpointId: text(input.endpointId, 'endpointId'), requestId: text(input.requestId, 'requestId'), expectedStatus: integer(input.expectedStatus, 'expectedStatus') };
        if (kind === 'database')
            return { id, kind, queryId: text(input.queryId, 'queryId'), parameters: scalarRecord(input.parameters) };
        if (kind === 'external_effect')
            return { id, kind, readbackId: text(input.readbackId, 'readbackId'), idempotencyKeyRef: text(input.idempotencyKeyRef, 'idempotencyKeyRef') };
        return { id, kind: 'review', rubricId: text(input.rubricId, 'rubricId'), artifactIds: strings(input.artifactIds, 'artifactIds') };
    });
}
export function validateTaskAcceptance(task, capabilities) {
    const policy = task.acceptancePolicy ?? 'structural_only';
    const effect = task.sideEffectClass ?? 'read_only';
    if (policy === 'structural_only' && effect !== 'read_only')
        throw new TypeError('structural_only is only allowed for read_only tasks');
    const checks = task.acceptanceChecks ?? [];
    if (policy === 'required' && !checks.some(check => check.kind !== 'review'))
        throw new TypeError('required task must declare a deterministic acceptance check');
    for (const check of checks) {
        const known = check.kind === 'command' ? capabilities.commandTemplates.has(check.templateId) : check.kind === 'json_schema' ? capabilities.fileSchemas.has(check.schemaId) : check.kind === 'http' ? capabilities.httpEndpoints.has(check.endpointId) : check.kind === 'database' ? capabilities.databaseQueries.has(check.queryId) : check.kind === 'external_effect' ? capabilities.externalReadbacks.has(check.readbackId) : check.kind === 'review' ? capabilities.reviewRubrics.has(check.rubricId) : true;
        if (!known)
            throw new TypeError(`unknown ${check.kind} capability`);
    }
}
function object(value, name) { if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError(`${name} must be an object`); return value; }
function text(value, name) { if (typeof value !== 'string' || value.trim() === '')
    throw new TypeError(`${name} must be a nonempty string`); return value; }
function strings(value, name) { if (!Array.isArray(value) || value.some(item => typeof item !== 'string'))
    throw new TypeError(`${name} must be a string array`); return value; }
function integer(value, name) { if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError(`${name} must be a non-negative integer`); return value; }
function path(value) { const result = text(value, 'path'); if (result.includes('..') || result.startsWith('/') || /^[A-Za-z]:/.test(result))
    throw new TypeError('path must be workspace-relative'); return result; }
function scalarRecord(value) { const result = object(value, 'parameters'); for (const item of Object.values(result))
    if (item !== null && !['string', 'number', 'boolean'].includes(typeof item))
        throw new TypeError('parameters must contain scalar values'); return result; }
