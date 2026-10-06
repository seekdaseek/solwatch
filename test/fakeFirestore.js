// In-memory stand-in for the slice of the Firestore Admin API this backend uses: collection/doc get, set
// (merge), update, add, and where('==' | '>=') queries. No network. Not a test file itself.
'use strict';

function fakeDb() {
  const cols = new Map();
  const col = name => { if (!cols.has(name)) cols.set(name, new Map()); return cols.get(name); };
  let auto = 0;
  const snap = (name, id) => {
    const d = col(name).get(id);
    return { id, exists: d !== undefined, data: () => (d === undefined ? undefined : { ...d }), ref: docRef(name, id) };
  };
  function docRef(name, id) {
    return {
      id,
      async get() { return snap(name, id); },
      async set(data, opts) { col(name).set(id, opts && opts.merge ? { ...(col(name).get(id) || {}), ...data } : { ...data }); },
      async update(data) {
        if (!col(name).has(id)) throw new Error(`NOT_FOUND: ${name}/${id}`);
        col(name).set(id, { ...col(name).get(id), ...data });
      },
    };
  }
  function query(name, filters) {
    return {
      where(f, op, v) { return query(name, [...filters, [f, op, v]]); },
      orderBy() { return this; },
      limit() { return this; },
      async get() {
        const docs = [...col(name).keys()].map(id => snap(name, id)).filter(s => filters.every(([f, op, v]) => {
          const x = s.data()[f];
          if (op === '==') return x === v;
          if (op === '>=') return x >= v;
          throw new Error(`fake: op ${op} unsupported`);
        }));
        return { docs, size: docs.length, empty: docs.length === 0 };
      },
    };
  }
  return {
    collection(name) {
      return {
        ...query(name, []),
        doc: id => docRef(name, id),
        async add(data) { const id = `auto${++auto}`; col(name).set(id, { ...data }); return docRef(name, id); },
      };
    },
    dump: name => Object.fromEntries([...col(name)].map(([k, v]) => [k, { ...v }])),
  };
}

// Capture console output by stream: log -> stdout, warn/error -> stderr (as Node writes them).
function captureConsole() {
  const out = [], err = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a) => out.push(a.join(' '));
  console.warn = (...a) => err.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  return { out, err, restore: () => Object.assign(console, orig) };
}

module.exports = { fakeDb, captureConsole };
