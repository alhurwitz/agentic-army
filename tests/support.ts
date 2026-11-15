// Test helpers that run the same under `bun test` and `node --test`: the runner's describe/test/
// beforeEach, plus a minimal Jest-style expect on node:assert covering the matchers these tests use.
import assert from "node:assert/strict"

const runner: any = "Bun" in globalThis ? await import("bun:test") : await import("node:test")
export const { describe, test, beforeEach } = runner as typeof import("node:test")

const matchers = (actual: any, negate = false) => {
  const check = (pass: boolean, message: string) => assert.ok(negate ? !pass : pass, negate ? `not: ${message}` : message)
  return {
    toBe: (expected: any) => (negate ? assert.notStrictEqual(actual, expected) : assert.strictEqual(actual, expected)),
    toEqual: (expected: any) => (negate ? assert.notDeepStrictEqual(actual, expected) : assert.deepStrictEqual(actual, expected)),
    toBeUndefined: () => check(actual === undefined, `expected undefined, got ${JSON.stringify(actual)}`),
    toContain: (item: any) => check(actual?.includes?.(item), `expected ${JSON.stringify(actual)} to contain ${JSON.stringify(item)}`),
    toHaveLength: (n: number) => check(actual?.length === n, `expected length ${n}, got ${actual?.length}`),
    toStartWith: (prefix: string) => check(String(actual).startsWith(prefix), `expected ${JSON.stringify(actual)} to start with ${JSON.stringify(prefix)}`),
    toThrow: (pattern?: RegExp | string) => {
      let thrown: any
      try {
        actual()
      } catch (error) {
        thrown = error
      }
      const pass = thrown !== undefined && (pattern === undefined || matchesError(thrown, pattern))
      check(pass, `expected function to throw ${pattern ?? ""}, got ${thrown?.message ?? "no error"}`)
    },
  }
}

const matchesError = (error: any, pattern: RegExp | string) => {
  const message = String(error?.message ?? error)
  return typeof pattern === "string" ? message.includes(pattern) : pattern.test(message)
}

export const expect = (actual: any) => ({
  ...matchers(actual),
  not: matchers(actual, true),
  rejects: {
    toThrow: async (pattern?: RegExp | string) => {
      let thrown: any
      try {
        await actual
      } catch (error) {
        thrown = error
      }
      assert.ok(thrown !== undefined && (pattern === undefined || matchesError(thrown, pattern)), `expected promise to reject with ${pattern ?? "an error"}, got ${thrown?.message ?? "a resolved value"}`)
    },
  },
})
