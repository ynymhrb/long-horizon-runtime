import { createHash } from 'node:crypto';
export class MemoryRetriever {
    retrieve(input) {
        if (!Number.isSafeInteger(input.maxItems) || input.maxItems < 0)
            throw new TypeError('maxItems must be a non-negative safe integer');
        const query = tokens(input.query);
        const excluded = [];
        const scored = [];
        for (const memory of input.memories) {
            if (!memory.active) {
                excluded.push({ memoryId: memory.id, reason: 'inactive' });
                continue;
            }
            if (memory.sourceRef === undefined || memory.sourceRef.trim().length === 0) {
                excluded.push({ memoryId: memory.id, reason: 'missing_source' });
                continue;
            }
            const score = query.reduce((total, token) => total + tokens(memory.content).filter(value => value === token).length, 0);
            if (score === 0) {
                excluded.push({ memoryId: memory.id, reason: 'zero_score' });
                continue;
            }
            scored.push({ memoryId: memory.id, score });
        }
        scored.sort((left, right) => right.score - left.score || left.memoryId.localeCompare(right.memoryId));
        const selected = scored.slice(0, input.maxItems).map(item => ({ ...item, selectionReason: `lexical score ${item.score}` }));
        for (const item of scored.slice(input.maxItems))
            excluded.push({ memoryId: item.memoryId, reason: 'item_limit' });
        return { algorithm: 'lexical-v1', queryHash: createHash('sha256').update(input.query).digest('hex'), selected, excluded };
    }
}
function tokens(value) { return value.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []; }
