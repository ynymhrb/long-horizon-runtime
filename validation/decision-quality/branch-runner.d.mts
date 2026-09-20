export function runCounterfactualBranches(input: object): Promise<{ verdict: 'pass' | 'hard_stop'; branches: object[]; contamination: string[] }>
