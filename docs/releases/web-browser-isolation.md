# S1b web browser isolation prototype

This is an operator-run prototype for reading an unauthenticated HTTPS page that needs JavaScript. It is not connected to web-source routes, workers, or production Compose services. Site login is outside this slice. Keep production use hard-disabled until the scheduler and host boundary below are implemented and reviewed.

## Prototype boundary

`web-browser-one-shot.ts` accepts only a small JSON object containing `url`. It requires a Linux Docker Engine 28 or newer, a non-root host process, and the image label produced by `deploy/web-browser/Dockerfile`. It creates a fresh proxy and browser container for one URL, waits for the browser result, then removes both containers, both networks, and the temporary job directory.

The browser has one Docker network: an internal bridge created with `gateway_mode_ipv4=isolated`, IPv6 disabled, and no gateway. The runner inspects this network and checks that the browser is attached only to it. The egress proxy joins that network and a separate ordinary bridge. The browser points to the proxy by its numeric address; Chromium maps all hostnames to `NOTFOUND` while excluding only that private proxy IP. Direct public and metadata-address TCP probes must fail before Chromium starts.

The proxy requires a per-job random credential and accepts CONNECT only to the configured HTTPS origin. It terminates browser TLS with a per-job certificate whose SPKI is the only browser-side certificate exception, then opens a separately verified TLS connection to a DNS-pinned public address. It rejects non-public or mixed DNS answers, other origins, write methods, request bodies, upgrades and WebSockets, cross-origin redirects, attachment downloads, and requests or responses over its byte/time/count budgets. Only the browser's visible text is returned, with a 20,000-character limit.

Both containers run as the non-root host UID/GID with a read-only root filesystem, all capabilities dropped, no-new-privileges, no devices, bounded memory/CPU/processes, no published ports, and Docker logging disabled. Only the job config and proxy certificate/key are mounted read-only; the browser gets a private output directory. The browser uses an ephemeral Playwright context, blocks Service Workers and downloads, closes WebSockets, and disposes the browser before its container is removed.

## Build and run manually

Run this only from a dedicated test host. The host runner has Docker daemon authority, which is effectively host-root authority on a conventional Docker installation. Never run it in the Web or Worker process and never mount the Docker socket into those services.

```sh
docker build -f deploy/web-browser/Dockerfile -t ai-project-os-web-browser:0.7.0-dev.1 .
printf '{"url":"https://example.com/"}\n' | node --import tsx scripts/web-browser-one-shot.ts
```

The image tag is a prototype label, not an immutable production pin. The runner rejects an image without the expected contract label. Do not expose this command as an application API.

## Verification coverage

`test/web-browser-egress-proxy.test.ts` exercises address classification, credential and exact-origin checks, DNS answers containing private addresses or excessive records, GET/HEAD-only enforcement, request-body and response-size limits, cross-origin redirect rejection, attachment rejection, same-origin redirect handling, JavaScript rendering through the proxy, and fail-closed cross-origin fetch, WebSocket, and Service Worker behavior. The Playwright test uses an isolated local HTTPS fixture and a test-only resolver override for loopback; that override is not available through the host runner.

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

## Planned application handoff

This section is an integration contract proposal; it does not indicate that application routes call the runner. The application should authorize an existing source record and derive its URL and origin server-side, then call a dedicated scheduler/broker with a narrow request such as `{ sourceId, url }`. The broker returns only `{ url, text }` or a stable error code and never accepts image names, Docker options, mounts, environment variables, or commands. The application persists bounded text through the existing source-fetch path. Keep this path hard-disabled until caller authorization, per-user/project quotas, cancellation, host isolation, production-shaped tests, and independent security review all pass.

## Required production boundary before enabling S1b

- Add a dedicated scheduler/broker outside the Web and Worker processes. Its API must accept only an authorized source identifier or bounded URL and must not accept Docker flags, image names, mounts, environment variables, or arbitrary commands.
- Keep Docker daemon authority exclusive to that broker. Docker socket access remains host-root-equivalent; use a dedicated isolated host/daemon or VM, restrict callers, and do not share the product application's daemon credentials.
- Enforce per-user/project authorization, one-shot job identity, bounded queue/concurrency, cancellation, wall-clock/resource budgets, and cleanup after both normal exit and host/scheduler interruption.
- Pin the reviewed browser image by digest, review and pin its browser/runtime dependencies, and apply the deployment host's tested seccomp/AppArmor policy.
- Verify the `internal` plus `gateway_mode_ipv4=isolated` network has no host/metadata route on the deployed Docker version and platform. Test direct IPv4, IPv6, host-gateway, metadata, DNS-rebinding, redirects, and browser background traffic from inside the actual browser container.
- Retain a production hard-disable until those gates pass and an independent security review accepts the complete host-to-container boundary.
