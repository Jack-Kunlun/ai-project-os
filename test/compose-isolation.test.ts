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

  for (const variable of [
    "POSTGRES_PORT",
    "APP_PORT",
    "AI_PROJECT_OS_PGDATA_VOLUME",
    "AI_PROJECT_OS_SECRETS_VOLUME",
    "AI_PROJECT_OS_UPLOADS_VOLUME",
  ]) {
    assert.match(environmentExample, new RegExp(`^${variable}=`, "mu"));
    assert.match(readme, new RegExp(`\\b${variable}\\b`, "u"));
  }
});
