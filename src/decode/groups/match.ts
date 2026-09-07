import type { Token } from '../tokenizer.js';

/**
 * The result of trying a group parser at a token position: the decoded value
 * and how many tokens it consumed, or `null` when the tokens there are not
 * that kind of group. Group parsers never throw.
 */
export type GroupMatch<T> = { readonly value: T; readonly consumed: number } | null;

export type GroupParser<T> = (tokens: readonly Token[], index: number) => GroupMatch<T>;

export function matched<T>(value: T, consumed = 1): GroupMatch<T> {
  return { value, consumed };
}
