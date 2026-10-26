import assert from "node:assert/strict";
import test from "node:test";
import { GIT_PUBLICATION_TRANSACTION_OPTIONS } from "../src/lib/project-git-publication-transaction";
import { mapGitPublicationSourceIds } from "../src/lib/project-git-publication-sources";
import { failSecondManualRunEntryBatch } from "./project-git-publication-test-support";

test("Git publication transaction budget is bounded and explicit", () => {
  assert.deepEqual(GIT_PUBLICATION_TRANSACTION_OPTIONS, { maxWait: 5_000, timeout: 60_000 });
});

test("mixed reused and created Git sources map by identity and revision, independent of return order", () => {
  const expected = [
    { sourceIdentity: "source-a", revisionKey: "revision-a" },
    { sourceIdentity: "source-b", revisionKey: "revision-b" },
    { sourceIdentity: "source-c", revisionKey: "revision-c" },
  ];
  const persisted = [
    { id: "new-c", sourceIdentity: "source-c", revisionKey: "revision-c" },
    { id: "reused-a", sourceIdentity: "source-a", revisionKey: "revision-a" },
    { id: "new-b", sourceIdentity: "source-b", revisionKey: "revision-b" },
  ];

  const mapped = mapGitPublicationSourceIds(expected, persisted);

  assert.ok(mapped);
  assert.equal(mapped.get("source-a:revision-a"), "reused-a");
  assert.equal(mapped.get("source-b:revision-b"), "new-b");
  assert.equal(mapped.get("source-c:revision-c"), "new-c");
  assert.equal(mapGitPublicationSourceIds(expected, [...persisted, persisted[0]!]), null);
  assert.equal(mapGitPublicationSourceIds(expected, [{ ...persisted[0]!, sourceIdentity: "unexpected" }]), null);
});

test("manual publication fault injection waits for one run-entry batch to complete", async () => {
  let databaseBatches = 0;
  const fakeTransaction = {
    projectGitRepositoryManualRunEntry: {
      createMany: async () => {
        databaseBatches += 1;
        return { count: 250 };
      },
    },
  };
  const fakeDatabase = {
    $transaction: async (...args: [callback: (tx: typeof fakeTransaction) => Promise<unknown>, options?: unknown]) => args[0](fakeTransaction),
  };

  const injected = await failSecondManualRunEntryBatch(fakeDatabase, async () => {
    try {
      await fakeDatabase.$transaction(async (tx) => {
        await tx.projectGitRepositoryManualRunEntry.createMany();
        await tx.projectGitRepositoryManualRunEntry.createMany();
      }, GIT_PUBLICATION_TRANSACTION_OPTIONS);
    } catch (error) {
      assert.match(String(error), /TEST_MANUAL_PUBLICATION_SECOND_BATCH_FAILURE/u);
      return "injected";
    }
    return "not-injected";
  });

  assert.equal(injected.result, "injected");
  assert.equal(injected.attemptedBatches, 2);
  assert.equal(injected.completedBatches, 1);
  assert.equal(databaseBatches, 1);
});
