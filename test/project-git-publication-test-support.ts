export async function captureTransactionOptions<T>(
  client: object,
  operation: () => Promise<T>,
): Promise<Readonly<{ result: T; options: readonly unknown[] }>> {
  const descriptor = Object.getOwnPropertyDescriptor(client, "$transaction");
  const originalTransaction = Reflect.get(client, "$transaction");
  if (typeof originalTransaction !== "function") throw new Error("PRISMA_TRANSACTION_UNAVAILABLE");
  const options: unknown[] = [];
  Object.defineProperty(client, "$transaction", {
    configurable: true,
    writable: true,
    value: (...args: unknown[]) => {
      options.push(args[1]);
      return Reflect.apply(originalTransaction, client, args);
    },
  });
  try {
    return { result: await operation(), options };
  } finally {
    if (descriptor === undefined) Reflect.deleteProperty(client, "$transaction");
    else Object.defineProperty(client, "$transaction", descriptor);
  }
}

export function hasGitPublicationTransactionBudget(value: unknown): boolean {
  return typeof value === "object" && value !== null
    && Reflect.get(value, "maxWait") === 5_000
    && Reflect.get(value, "timeout") === 60_000;
}

export async function failSecondManualRunEntryBatch<T>(
  client: object,
  operation: () => Promise<T>,
): Promise<Readonly<{ result: T; attemptedBatches: number; completedBatches: number }>> {
  const descriptor = Object.getOwnPropertyDescriptor(client, "$transaction");
  const originalTransaction = Reflect.get(client, "$transaction");
  if (typeof originalTransaction !== "function") throw new Error("PRISMA_TRANSACTION_UNAVAILABLE");
  let attemptedBatches = 0;
  let completedBatches = 0;
  Object.defineProperty(client, "$transaction", {
    configurable: true,
    writable: true,
    value: (...args: unknown[]) => {
      const callback = args[0];
      if (!hasGitPublicationTransactionBudget(args[1]) || typeof callback !== "function") {
        return Reflect.apply(originalTransaction, client, args);
      }
      const interceptedCallback = async (tx: object) => {
        const entryDelegate = Reflect.get(tx, "projectGitRepositoryManualRunEntry", tx);
        const originalCreateMany = Reflect.get(entryDelegate, "createMany", entryDelegate);
        if (typeof originalCreateMany !== "function") throw new Error("PRISMA_MANUAL_ENTRY_CREATE_MANY_UNAVAILABLE");
        const interceptedDelegate = new Proxy(entryDelegate, {
          get(target, property) {
            if (property === "createMany") {
              return async (...createManyArgs: unknown[]) => {
                attemptedBatches += 1;
                if (attemptedBatches === 2) throw new Error("TEST_MANUAL_PUBLICATION_SECOND_BATCH_FAILURE");
                const result = await Reflect.apply(originalCreateMany, target, createManyArgs);
                completedBatches += 1;
                return result;
              };
            }
            return Reflect.get(target, property, target);
          },
        });
        const interceptedTransaction = new Proxy(tx, {
          get(target, property) {
            if (property === "projectGitRepositoryManualRunEntry") return interceptedDelegate;
            return Reflect.get(target, property, target);
          },
        });
        return Reflect.apply(callback, undefined, [interceptedTransaction]);
      };
      return Reflect.apply(originalTransaction, client, [interceptedCallback, args[1]]);
    },
  });
  try {
    return { result: await operation(), attemptedBatches, completedBatches };
  } finally {
    if (descriptor === undefined) Reflect.deleteProperty(client, "$transaction");
    else Object.defineProperty(client, "$transaction", descriptor);
  }
}
