import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Compose keeps stable defaults while allowing a fully isolated candidate stack", async () => {
  const [compose, environmentExample, readme] = await Promise.all([
    readFile("compose.yaml", "utf8"),
    readFile(".env.example", "utf8"),
    readFile("README.md", "utf8"),
  ]);

  assert.match(compose, /\$\{POSTGRES_PORT:-5433\}/u);
  assert.match(compose, /\$\{APP_PORT:-3000\}/u);
  assert.match(compose, /\$\{AI_PROJECT_OS_PGDATA_VOLUME:-ai-project-os-pgdata\}/u);
  assert.match(compose, /\$\{AI_PROJECT_OS_SECRETS_VOLUME:-ai-project-os-secrets\}/u);
  assert.match(compose, /\$\{AI_PROJECT_OS_UPLOADS_VOLUME:-ai-project-os-uploads\}/u);
  assert.match(
    compose,
    /AI_PROJECT_OS_SECURE_COOKIES: "\$\{AI_PROJECT_OS_SECURE_COOKIES:-false\}"/u,
  );
  const secureCookieKeyMatches = [
    ...compose.matchAll(/^\s+AI_PROJECT_OS_SECURE_COOKIES:/gmu),
  ];
  assert.equal(secureCookieKeyMatches.length, 1);
  const appServiceStart = compose.indexOf("\n  app:\n");
  const workerServiceStart = compose.indexOf("\n  worker:\n");
  const secureCookieIndex = secureCookieKeyMatches[0]?.index ?? -1;
  assert.ok(appServiceStart >= 0 && workerServiceStart > appServiceStart);
  assert.ok(secureCookieIndex > appServiceStart && secureCookieIndex < workerServiceStart);

  for (const variable of [
    "POSTGRES_PORT",
    "APP_PORT",
    "AI_PROJECT_OS_PGDATA_VOLUME",
    "AI_PROJECT_OS_SECRETS_VOLUME",
    "AI_PROJECT_OS_UPLOADS_VOLUME",
    "AI_PROJECT_OS_SECURE_COOKIES",
  ]) {
    assert.match(environmentExample, new RegExp(`^${variable}=`, "mu"));
    assert.match(readme, new RegExp(`\\b${variable}\\b`, "u"));
  }
});
