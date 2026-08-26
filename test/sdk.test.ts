// The composition, and the three bugs it exists to have already solved.
//
// No database. Every assertion here is about the wiring — that nothing is built
// on import, that a pool is not created twice, that a kit nobody enabled says so
// rather than returning undefined, and that the migration order is the order the
// kits actually require. The kits themselves have their own suites against real
// Postgres; this is the layer above them.

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  createSdk,
  isBuilt,
  type KitNotEnabled,
  lazy,
  ORDER,
  required,
  SCHEMAS,
  validateKits,
} from '../src/index.ts';

const fakePool = () => {
  const queries: string[] = [];
  return {
    queries,
    query: async <R>(text: string): Promise<{ rows: R[] }> => {
      queries.push(text);
      return { rows: [{ rolname: 'app', exempt: false }] as R[] };
    },
    connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
    end: async () => {},
  };
};

afterEach(() => {
  globalThis.__quxkitPool = undefined;
});

describe('nothing is built on import', () => {
  it('does not construct until something is touched', () => {
    // `next build` imports every route to collect metadata, on a machine with no
    // database. Anything constructed at module scope runs there.
    let made = 0;
    const value = lazy(() => {
      made += 1;
      return { hello: () => 'world' };
    });
    assert.equal(made, 0, 'constructing on creation defeats the point');
    assert.equal(value.hello(), 'world');
    assert.equal(made, 1);
  });

  it('builds once, however many times it is touched', () => {
    let made = 0;
    const value = lazy(() => {
      made += 1;
      return { a: 1, b: 2 };
    });
    void value.a;
    void value.b;
    void value.a;
    assert.equal(made, 1);
  });

  it('survives destructuring, which a get-only proxy does not', () => {
    // `const { resolve } = tenancy` hands back a function whose `this` is the
    // proxy; the first private field it touches throws.
    const value = lazy(() => {
      class Thing {
        #secret = 'kept';
        reveal() {
          return this.#secret;
        }
      }
      return new Thing();
    });
    const { reveal } = value;
    assert.equal(reveal(), 'kept');
  });

  it('answers the traps a partial proxy gets wrong', () => {
    // Object.keys() returning nothing on an object that plainly has properties
    // is a very hard bug to read.
    const value = lazy(() => ({ a: 1, b: 2 }));
    assert.deepEqual(Object.keys(value).sort(), ['a', 'b']);
    assert.ok('a' in value);
    assert.ok(isBuilt(value));
  });
});

describe('one pool', () => {
  it('reuses the pool across instances, so hot reload does not leak one per edit', async () => {
    const shared = fakePool();
    globalThis.__quxkitPool = shared;
    const sdk = createSdk({ kits: ['identity'] });

    // Asserted by behaviour, not reference: the proxy BINDS methods on purpose,
    // so `sdk.pool.query` is a bound wrapper and never reference-equal to the
    // original. What matters is that the call lands on the existing pool rather
    // than on a second one.
    await sdk.pool.query('select 1');
    assert.deepEqual(shared.queries, ['select 1']);
    assert.equal(sdk.warm, true);
  });

  it('takes a pool the app supplies and never makes its own', () => {
    const supplied = fakePool();
    const sdk = createSdk({ kits: ['identity'], pool: supplied });
    assert.equal(sdk.pool, supplied);
    assert.equal(sdk.warm, true);
  });
});

describe('a kit that is not enabled', () => {
  it('says how to turn it on rather than returning undefined', () => {
    const sdk = createSdk({ kits: ['identity'], pool: fakePool() });
    assert.equal(sdk.has('tenant'), false);
    const error = (() => {
      try {
        sdk.require('tenant');
      } catch (e) {
        return e as KitNotEnabled;
      }
      throw new Error('expected a refusal');
    })();
    assert.equal(error.name, 'KitNotEnabled');
    assert.match(error.message, /Add 'tenant' to the kits list/);
    assert.match(error.message, /@quxkit\/tenant-kit is installed/);
  });

  it('refuses a kit that does not exist, while somebody is looking at the config', () => {
    assert.throws(
      () => createSdk({ kits: ['tenancy' as never], pool: fakePool() }),
      /Unknown kit "tenancy"/,
    );
  });
});

describe('the migration rules', () => {
  it('refuses a kit whose schema calls into one that is not enabled', () => {
    // content-kit's isolation delegates to tenant-kit's `tenancy.protect`.
    // Applying it alone installs a policy calling a function that does not
    // exist, and the table then answers nothing at all — so it is refused
    // outright rather than silently skipped.
    assert.throws(() => validateKits(['content']), /needs tenant-kit/);
    assert.doesNotThrow(() => validateKits(['tenant', 'content']));
  });

  it('fails at construction, not halfway through a real migration', () => {
    assert.throws(() => createSdk({ kits: ['domain'], pool: fakePool() }), /needs tenant-kit/);
  });

  it('validates without resolving any kit package', () => {
    // Construction used to build the full plan, which resolves every enabled
    // kit's package.json — so an app enabling four kits could not construct
    // unless all of them were installed, and the error named a package.json
    // rather than the config. None of these kits are installed here.
    assert.doesNotThrow(() =>
      createSdk({ kits: ['identity', 'tenant', 'billing'], pool: fakePool() }),
    );
  });

  it('names files explicitly rather than globbing a kit\u2019s sql directory', () => {
    // A readable, reviewable list — but one that has to be kept true, which is
    // what test/schema.test.ts does by reading the kits themselves. Here only
    // the shape: every kit declares at least one file and a package to find it
    // in. Asserted against the table rather than a resolved plan, because
    // resolving needs the package installed.
    for (const kit of ORDER) {
      assert.ok(SCHEMAS[kit].files.length > 0, `${kit} declares no schema`);
      assert.match(SCHEMAS[kit].package, /^@quxkit\//);
    }
  });

  it('orders tenant before the kits that delegate isolation to it', () => {
    assert.ok(ORDER.indexOf('tenant') < ORDER.indexOf('content'));
    assert.ok(ORDER.indexOf('tenant') < ORDER.indexOf('domain'));
  });
});

describe('configuration', () => {
  it('names the variable that is missing', () => {
    delete process.env.QUXKIT_TEST_VAR;
    assert.throws(() => required('QUXKIT_TEST_VAR'), /QUXKIT_TEST_VAR is not set/);
  });
});
