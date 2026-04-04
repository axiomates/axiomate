/**
 * General-purpose utility types.
 */

/**
 * Recursively makes every property `readonly`.
 * Works with objects, arrays, Maps, Sets, and primitives.
 */
export type DeepImmutable<T> = T extends (infer U)[]
  ? ReadonlyArray<DeepImmutable<U>>
  : T extends ReadonlyMap<infer K, infer V>
    ? ReadonlyMap<DeepImmutable<K>, DeepImmutable<V>>
    : T extends Map<infer K, infer V>
      ? ReadonlyMap<DeepImmutable<K>, DeepImmutable<V>>
      : T extends ReadonlySet<infer U>
        ? ReadonlySet<DeepImmutable<U>>
        : T extends Set<infer U>
          ? ReadonlySet<DeepImmutable<U>>
          : T extends (...args: any[]) => any
            ? T
            : T extends object
              ? { readonly [K in keyof T]: DeepImmutable<T[K]> }
              : T

/**
 * Given a union `T`, produces a tuple type containing every member of `T`
 * exactly once (in some order). Used with `satisfies` to enforce that a
 * constant array is an exhaustive list of a union's members.
 *
 * Example:
 *   type Mode = 'a' | 'b'
 *   const modes = ['a', 'b'] satisfies Permutations<Mode>
 */
export type Permutations<T, U = T> = [T] extends [never]
  ? []
  : T extends T
    ? [T, ...Permutations<Exclude<U, T>>]
    : never
