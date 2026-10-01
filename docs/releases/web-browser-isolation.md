# S1b isolated browser execution and application handoff

The application now has Owner-only browser-source creation and manual fetch, Editor/Owner review and publication for JavaScript-only pages, Owner-only private preview and discard for site-form pages, credential rotation and revocation, and an HTTPS broker client. The broker launches a one-shot isolated runner for a JavaScript page or an exact same-origin form login. JavaScript content enters staging and requires an explicit review before publication. Site-form output remains a private Owner preview: application and database guards prohibit publishing it to `ProjectSource`, and project Editors/Viewers cannot list or read that source. A site could encode credentials in its output beyond the reflection check, so this preview must never enter the generic project read, search, AI, or MCP paths. The feature remains disabled unless an operator configures a separate broker and pinned image. No dedicated Linux host, real site, or production acceptance has been supplied yet, so these changes are a candidate implementation, not a production-ready release.

## Prototype boundary

`web-browser-one-shot.ts` accepts only a small JSON object with `url` and an optional validated `siteForm`. It requires a Linux Docker Engine 28 or newer, a non-root host process, and the image label produced by `deploy/web-browser/Dockerfile`. It creates a fresh proxy and browser container for one URL, waits for the browser result, then removes the job's labeled containers, networks, and temporary directory. Cleanup is verified; a Docker removal or verification failure returns only `WEB_BROWSER_ISOLATION_UNAVAILABLE`.

The browser has one Docker network: an internal bridge created with `gateway_mode_ipv4=isolated`, IPv6 disabled, and no gateway. The runner inspects this network and checks that the browser is attached only to it. The egress proxy joins that network and a separate ordinary bridge. The browser points to the proxy by its numeric address; Chromium maps all hostnames to `NOTFOUND` while excluding only that private proxy IP. Direct public and metadata-address TCP probes must fail before Chromium starts.

The proxy requires a per-job random credential and accepts CONNECT only to the configured HTTPS origin. It terminates browser TLS with a per-job certificate whose SPKI is the only browser-side certificate exception, then opens a separately verified TLS connection to a DNS-pinned public address. It rejects non-public or mixed DNS answers, other origins, arbitrary write methods and bodies, upgrades and WebSockets, cross-origin redirects, attachment downloads, and requests or responses over its byte/time/count budgets. For site login it permits one bounded POST to the configured exact same-origin form endpoint, followed by ordinary GET/HEAD requests. The browser checks the configured success marker before visiting the target page. Only the browser's visible text is returned, with a 20,000-character limit. Raw and URL-percent-encoded username/password reflection is rejected; arbitrary transformations cannot be detected reliably. Site-form output is preview-only and cannot be accepted into generic project content.

Both containers run as the non-root host UID/GID with a read-only root filesystem, all capabilities dropped, no-new-privileges, no devices, bounded memory/CPU/processes, no published ports, and Docker logging disabled. The proxy mounts a separate config containing only origin, proxy authorization, DNS fingerprint, and the exact optional form endpoint; site account credentials are mounted only in the browser container. The proxy certificate/key are read-only, and the browser gets a private output directory. The browser uses an ephemeral Playwright context, blocks Service Workers and downloads, closes WebSockets, and disposes the browser before its container is removed. A form login must show its configured success marker after submission and before the target URL is opened.

## Build and run manually

Run this only from a dedicated test host. The host runner has Docker daemon authority, which is effectively host-root authority on a conventional Docker installation. Never run it in the Web or Worker process and never mount the Docker socket into those services.

```sh
docker build -f deploy/web-browser/Dockerfile -t ai-project-os-web-browser:0.7.0-dev.1 .
printf '{"url":"https://example.com/"}\n' | node --import tsx scripts/web-browser-one-shot.ts
```

The image tag is for isolated manual testing only. In pinned mode, set `AI_PROJECT_OS_WEB_BROWSER_MODE=pinned` and `AI_PROJECT_OS_WEB_BROWSER_IMAGE_DIGEST=registry.example.test/team/web-browser@sha256:<64 lowercase hex characters>`. The runner verifies the exact reference in Docker's `RepoDigests` and the image contract label. `NODE_ENV=production` requires pinned mode. Do not pass image names, Docker settings, environment values, mounts, or commands through stdin, and do not expose the runner as an application API.

Every job resource receives the runner ownership label, a random 24-character job ID, and a resource type. The runner verifies the exact name, full Docker ID, and labels before deleting a container or network. To inspect job IDs left by a host interruption, run this command from the same dedicated host:

```sh
node --import tsx scripts/web-browser-one-shot.ts --list-owned-jobs
```

The listing includes active and leftover jobs; first confirm the runner process is no longer active. Then remove one exact runner-owned job and verify that it is gone:

```sh
node --import tsx scripts/web-browser-one-shot.ts --cleanup-owned-job=<24-character-job-id>
```

Cleanup selects only resources carrying the runner's fixed owner label and that exact job ID. Before removal it checks the expected generated resource name, resource label, and full Docker ID; mismatches fail closed. The command does not use arbitrary Docker options or accept a resource name from the operator.

## Verification coverage

`test/web-browser-egress-proxy.test.ts` exercises address classification, credential and exact-origin checks, DNS answers containing private addresses or excessive records, method and body enforcement, one exact form POST, login cookies, request and response limits, redirects, attachment rejection, JavaScript rendering, and fail-closed cross-origin fetch, WebSocket, and Service Worker behavior. The Playwright test uses an isolated local HTTPS fixture and a test-only resolver override for loopback; that override is not available through the host runner. Broker protocol, replay, queue, and client behavior have separate focused tests.

A passing unit/browser test does not prove the Linux container topology, host firewall, Docker DNS behavior, or production scheduler. Validate those from the actual production-shaped isolated host before release.

The isolated prototype image can run the proxy and real Chromium attack-surface tests without network access:

```sh
docker run --rm --network none --user 1000:1000 --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --memory 768m --memory-swap 768m --pids-limit 128 --cpus 1 --shm-size 64m \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=256m,mode=1777,uid=1000,gid=1000 \
  --mount type=bind,src="$PWD/test/web-browser-egress-proxy.test.ts",dst=/app/test/web-browser-egress-proxy.test.ts,readonly \
  --mount type=bind,src="$PWD/test/fixtures",dst=/app/test/fixtures,readonly \
  --workdir /app --entrypoint node ai-project-os-web-browser:0.7.0-dev.1 \
  --import tsx --test test/web-browser-egress-proxy.test.ts
```

The Docker integration test creates a local HTTPS fixture, a test-only proxy, and the browser container on separate internal networks. It checks JavaScript-generated visible text and verifies browser-only network attachment and cleanup:

```sh
RUN_WEB_BROWSER_CONTAINER_TESTS=1 node --import tsx --test test/web-browser-container.integration.test.ts
```

## Application and broker configuration

The application only exposes browser-source creation when `AI_PROJECT_OS_WEB_BROWSER_ENABLED=1`. It also requires `AI_PROJECT_OS_WEB_BROWSER_BROKER_URL` (the exact HTTPS `/v1/render` endpoint), `AI_PROJECT_OS_WEB_BROWSER_BROKER_KEY_FILE` (a private shared HMAC key file), `AI_PROJECT_OS_WEB_BROWSER_IMAGE_DIGEST` (the reviewed immutable image), and `AI_PROJECT_OS_WEB_BROWSER_BROKER_ALLOW_PRIVATE` (`0` or `1`, for the broker host only). The broker runs outside Web, Worker, and Git Worker on the dedicated host with a private TLS key/certificate, the same HMAC key, a private replay ledger directory, and the pinned image digest. Its script requires `AI_PROJECT_OS_WEB_BROWSER_BROKER_CERT_FILE`, `AI_PROJECT_OS_WEB_BROWSER_BROKER_TLS_KEY_FILE`, and `AI_PROJECT_OS_WEB_BROWSER_BROKER_LEDGER_DIR`; it listens on TCP 8443. Provision these through the operator secret system, never in the repository or chat.

The app checks Owner access and an unchanged source/credential/configuration snapshot in short transactions before dispatch and after the broker response. Each broker job ID equals its durable source revision ID. The broker verifies an HMAC timestamp and nonce, keeps a replay ledger, admits at most one active and four pending jobs, and permits at most one admitted job per project. The broker binds each job UUID to exact Docker resource names, cancels the child process group on disconnect or timeout, then verifies removal of that job's containers, networks, and mounted files. On startup it cleans verified runner-owned orphan jobs before accepting traffic. The runner receives only the exact configured URL and optional form fields, uses the pinned image, and returns bounded text plus an address-set fingerprint. The app stages that output with the image/profile and manual-configuration fingerprints; Editor/Owner review of JavaScript-only pages rechecks them before publication, while site-form pages have only Owner private preview and discard. Credential rotation, revocation, generic disable, and execution-profile changes send a signed `/v1/cancel` request for recent revision IDs while holding the source transaction. The broker records each ID before acknowledging, removes queued jobs, and waits for active runner cleanup. A late render for a cancelled ID is rejected by the replay ledger. If cancellation is unavailable or uncertain, the mutation rolls back and cannot report success; operators must restore broker access before changing that source. This cancellation transaction can hold project access locks for up to the bounded broker timeout. If broker cancellation succeeds but the database transaction then fails, retry the same mutation after database recovery: the broker tombstone is idempotent, and the retry clears the staging revision. The generic synchronization and automation paths exclude browser modes.

## Required production boundary before enabling S1b

- Deploy the broker on a dedicated isolated host/daemon or VM, restrict inbound callers to the app, and keep Docker daemon authority away from Web and Worker. The Docker socket remains host-root-equivalent.
- Build and review the exact browser image and its browser/runtime dependencies, pin its digest, and apply the deployed host's tested seccomp/AppArmor policy.
- Verify HMAC key permissions, TLS trust, private ledger ownership, one active/four pending jobs, cancellation, crash recovery, and exact cleanup with an actual app-to-broker request.
- Verify the `internal` plus `gateway_mode_ipv4=isolated` network has no host/metadata route on the deployed Docker version and platform. Test direct IPv4, IPv6, host-gateway, metadata, DNS-rebinding, redirects, and browser background traffic from inside the actual browser container.
- Run JavaScript publication and site-form private-preview acceptance against controlled HTTPS fixtures, then a real authorized site with permission. Verify that site-form output stays out of project materials, search, AI, and MCP even when it contains transformed credentials; review credentials, failure messages, JavaScript published content, and revocation on the real deployment shape.
- If upgrading an environment that previously ran an experimental S1b build, check for existing `ProjectSource` rows whose `sourceIdentity` belongs to a site-form `WebSource` before enabling the feature. The new insertion guard does not retroactively remove historical rows. The supported `.14` source has no site-form mode, and the standard upgrade preflight requires its exact migration ledger.
- Retain the application feature flag off until those gates pass and an independent security review accepts the complete host-to-container boundary.

For a previously used experimental environment, run this read-only query after the S1b schema exists; it must return zero rows. Investigate any result before enabling S1b. This query is not applicable to the unchanged 117-migration source schema.

```sql
SELECT 1
FROM "WebSource" AS web_source
JOIN "ProjectSource" AS project_source
  ON project_source."projectId" = web_source."projectId"
 AND project_source."sourceIdentity" = web_source."id"
WHERE web_source."authenticationMode"::text = 'site_form'
LIMIT 1;
```
