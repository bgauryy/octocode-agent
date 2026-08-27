export interface MemoryEvaluationCaseV1 {
  expectedIds: string[];
  returnedIds: string[];
  staleIds?: string[];
  falseRecallWeight?: number;
}

export interface MemoryEvaluationResultV1 {
  version: 1;
  precision: number;
  recall: number;
  staleRecallRate: number;
  falseRecallCost: number;
}

export function containsSecretLikeText(text: string): boolean {
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*[^\s]{6,}|\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{16,}\b/i.test(text);
}

export function evaluateMemoryRecall(cases: MemoryEvaluationCaseV1[]): MemoryEvaluationResultV1 {
  let relevantReturned = 0;
  let returned = 0;
  let expected = 0;
  let stale = 0;
  let falseRecallCost = 0;
  for (const item of cases) {
    const expectedSet = new Set(item.expectedIds);
    const staleSet = new Set(item.staleIds ?? []);
    expected += expectedSet.size;
    returned += item.returnedIds.length;
    for (const id of item.returnedIds) {
      if (expectedSet.has(id)) relevantReturned++;
      else falseRecallCost += item.falseRecallWeight ?? 1;
      if (staleSet.has(id)) stale++;
    }
  }
  return {
    version: 1,
    precision: returned === 0 ? 1 : relevantReturned / returned,
    recall: expected === 0 ? 1 : relevantReturned / expected,
    staleRecallRate: returned === 0 ? 0 : stale / returned,
    falseRecallCost,
  };
}
