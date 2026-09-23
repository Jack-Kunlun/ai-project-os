import assert from "node:assert/strict";
import test from "node:test";
import { GitRunnerError, withGitRunner } from "../src/lib/git/runner";

const endpoint = { hostname: "git.example.test", port: "443", addresses: ["198.51.100.10"] } as const;

test("Git saved credential is not read when the final fence rejects", async () => {
  let credentialReads = 0;
  let requests = 0;
  await assert.rejects(
    () => withGitRunner({
      transport: "https",
      authKind: "token",
      username: "oauth2",
      credential: null,
      credentialLoader: async () => {
        credentialReads += 1;
        return { authKind: "token", token: "never-dispatched-token" };
      },
      onBeforeCredentialRead: () => false,
      onBeforeRequest: () => {
        requests += 1;
        return false;
      },
      tlsCaCertificate: null,
      sshKnownHost: null,
      pinnedEndpoint: endpoint,
    }, async () => {
      throw new Error("runner operation must not start");
    }),
    (error: unknown) => error instanceof GitRunnerError && error.code === "GIT_REQUEST_BOUNDARY_REJECTED",
  );
  assert.equal(credentialReads, 0);
  assert.equal(requests, 0);
});

test("Git request fence runs after credential read and rejects before process spawn", async () => {
  let requests = 0;
  await assert.rejects(
    () => withGitRunner({
      transport: "https",
      authKind: "token",
      username: "oauth2",
      credential: null,
      credentialLoader: async () => ({ authKind: "token", token: "test-token-for-runner" }),
      onBeforeCredentialRead: () => true,
      onBeforeRequest: () => {
        requests += 1;
        return false;
      },
      tlsCaCertificate: null,
      sshKnownHost: null,
      pinnedEndpoint: endpoint,
    }, async (runner) => runner.runText(["--version"])),
    (error: unknown) => error instanceof GitRunnerError && error.code === "GIT_REQUEST_BOUNDARY_REJECTED",
  );
  assert.equal(requests, 1);
});
