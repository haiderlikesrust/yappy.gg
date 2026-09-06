/** Small memory cache scoped to the signed-in account. No inbox data goes to disk. */
export function sessionResource<T>(
  account: () => string | null,
  request: () => Promise<T>,
  ttl = 15_000,
) {
  let owner = account();
  let value: T | null = null;
  let fetched = 0;
  let generation = 0;
  let revision = 0;
  let pending: Promise<T> | null = null;
  const clear = () => {
    owner = account();
    value = null;
    fetched = 0;
    generation++;
    revision++;
    pending = null;
  };
  const read = () => {
    if (owner !== account()) clear();
    return value;
  };
  const load = (force = false): Promise<T> => {
    read();
    if (!owner) return Promise.reject(new Error("Signed out"));
    if (pending) return pending;
    if (!force && value !== null && Date.now() - fetched < ttl)
      return Promise.resolve(value);
    const user = owner,
      session = generation;
    const work = (async () => {
      // Events during a fetch require one follow-up, shared by all callers.
      // An older response cannot overwrite an update that arrived in flight.
      for (;;) {
        const asked = revision;
        const next = await request();
        if (session !== generation || account() !== user)
          throw new Error("Account changed");
        if (asked !== revision) continue;
        value = next;
        fetched = Date.now();
        return next;
      }
    })();
    pending = work;
    void work
      .finally(() => {
        if (pending === work) pending = null;
      })
      .catch(() => {});
    return work;
  };
  return {
    read,
    load,
    clear,
    invalidate() {
      read();
      fetched = 0;
      revision++;
    },
    update(transform: (current: T) => T) {
      const current = read();
      if (current !== null) value = transform(current);
      fetched = 0;
      revision++;
    },
  };
}
