# Production OpenAI-only egress

Run this installer as root only after the matching application version and source revision are active in `/srv/ai-project-os/repository`. The plan and apply commands both require the exact version, 40-character revision, and SHA256 of a private node payload owned by `root` or `deploy` with mode `0600`.

```sh
sudo /usr/bin/python3 -I /srv/ai-project-os/repository/deploy/production/ai-project-os-openai-egress.py plan \
  --version <exact-version> --revision <40-hex-revision> \
  --node-payload /secure/path/openai-node.json --sha256 <64-hex-sha256>

sudo /usr/bin/python3 -I /srv/ai-project-os/repository/deploy/production/ai-project-os-openai-egress.py apply \
  --version <exact-version> --revision <40-hex-revision> \
  --node-payload /secure/path/openai-node.json --sha256 <64-hex-sha256>
```

The payload is JSON with exactly `node_id`, `node`, and `trace`. `node_id` must be a JSON string of 1–128 ASCII characters matching `[A-Za-z0-9._:-]+`; integer values are rejected. `node` must contain exactly `cipher`, `name`, `password`, `port`, `server`, `type`, and `udp`; only a Shadowsocks node with a literal global IPv4 server is accepted. Keep the payload private: it includes the node password. The installer checks its digest and ownership without printing or copying the raw payload. Required node credentials are stored in the protected Mihomo configuration. Remove the operator-owned staging payload after successful acceptance.

Apply downloads only the pinned Mihomo v1.19.33 Linux x86_64 archive and checks its compressed size and SHA256. It binds the authenticated HTTP proxy to the RFC1918 gateway of `ai-project-os_default`, with rules allowing `api.openai.com` and rejecting every other destination. The service has no TUN, DNS override, controller, global proxy environment, route change, or firewall change. Its config is `/etc/ai-project-os-egress/mihomo.json`; its unprivileged systemd account is `ai-project-os-egress`.

Before changing the app environment, the installer validates the config as the service account, checks the proxy trace at `api.openai.com/cdn-cgi/trace` for `TW`/`TPE`, verifies a fake-key OpenAI request returns `401 invalid_api_key`, and confirms a non-OpenAI CONNECT is rejected. It then changes only `AI_PROJECT_OS_OPENAI_PROXY_URL` in `/etc/ai-project-os/production.env`, using the exact current app and worker image IDs to recreate only those two services. It checks app/worker health, local and public health versions, and unchanged database and git-worker container identities. A worker-side check confirms global `fetch` has no proxy environment flags and the scoped OpenAI helper returns the fake-key response.

If a post-change check fails, the installer restores only its own proxy entry, recreates app and worker with the same pinned images, and stops its service when the environment rollback is conflict-free. If the proxy entry, runtime images, service files, or state have drifted, it stops before overwriting them and records an incomplete rollback for operator review.

To explicitly roll back a successful install:

```sh
sudo /usr/bin/python3 -I /srv/ai-project-os/repository/deploy/production/ai-project-os-openai-egress.py rollback
```

Rollback removes only matching root-owned config, binary, and systemd files. The dedicated service account and group remain; its `/var/lib/ai-project-os-egress` directory remains if Mihomo wrote state there. Private rollback state is kept under `/var/lib/ai-project-os-openai-egress-private` with mode `0700`/`0600`; after a successful rollback it is reduced to a secret-free status record. The deploy-readable receipt is `/var/lib/ai-project-os-openai-egress-status/status.json` (`root:root`, `0644`) and contains only version/revision, result flags, and `TW`/`TPE` location fields.
