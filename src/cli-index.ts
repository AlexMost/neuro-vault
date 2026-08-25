import type { IndexCliOptions } from './config.js';

// Not `async` — the body has no `await`, and an async function with none
// trips `@typescript-eslint/require-await`. Returning a rejected promise
// keeps the `Promise<number>` signature Task 2 relies on.
export function runIndexCommand(_options: IndexCliOptions): Promise<number> {
  return Promise.reject(new Error('not implemented'));
}
