export interface AssertionOutcome {
  id: string
  status: 'pass' | 'fail' | 'unevaluated'
  oracle: string
  expected: unknown
  actual: unknown
  detail: string
  check: string
}

export declare const ORACLES: string[]
export declare function evaluateAssertion(assertion: Record<string, unknown>, evidenceDir: string): Promise<AssertionOutcome>
export declare function summarizeAssertions(outcomes: AssertionOutcome[]): 'pass' | 'fail' | 'unevaluated'
