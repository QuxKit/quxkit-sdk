// Construct on first use, not on import.
//
// This is one of the three pieces of engineering that make the kits compose in a
// real application, and it is here rather than in every app because every app
// needs it and a bug in it should be fixed once.
//
// The problem it solves: `next build` imports every route to collect its
// metadata, so anything constructed at module scope runs on a build machine —
// which has no database and should not need one. A kit instance built at module
// scope therefore turns `next build` into a build that requires production
// credentials, and the error it produces names the database rather than the
// import that caused it.
//
// It is not Next-specific. Any framework that imports modules to discover routes
// has the same shape, and constructing a connection pool because a file was
// imported is wrong everywhere.

/**
 * A stand-in that becomes the real thing the first time it is touched.
 *
 * Every trap is forwarded, not just `get`, because a partial proxy fails in ways
 * that are very hard to read: `Object.keys()` returning nothing on an object
 * that plainly has properties, or a `in` check saying no about something that is
 * there.
 *
 * Methods are bound to the constructed instance. Without that, destructuring —
 * `const { resolve } = tenancy` — hands back a function whose `this` is the
 * proxy, and the first private field it touches throws.
 */
export function lazy<T extends object>(make: () => T): T {
  let made: T | undefined;
  const get = (): T => (made ??= make());

  return new Proxy({} as T, {
    get(_target, prop) {
      const value = Reflect.get(get() as object, prop);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(get())
        : value;
    },
    has: (_target, prop) => Reflect.has(get() as object, prop),
    ownKeys: () => Reflect.ownKeys(get() as object),
    getOwnPropertyDescriptor: (_target, prop) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(get() as object, prop);
      // `configurable: true` is required: the proxy's own target is an empty
      // object, and reporting a non-configurable property that the target does
      // not have is a TypeError from the invariant checks rather than from us.
      return descriptor && { ...descriptor, configurable: true };
    },
    set(_target, prop, value) {
      return Reflect.set(get() as object, prop, value);
    },
  });
}

/** Whether a lazy value has actually been built. For tests and for a health
 *  check that wants to report what is warm without warming it. */
export const isBuilt = (value: unknown): boolean => {
  try {
    return Reflect.ownKeys(value as object).length > 0;
  } catch {
    return false;
  }
};
