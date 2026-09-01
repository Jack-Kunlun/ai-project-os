#!/usr/bin/env bash
set -Eeuo pipefail

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
umask 077

readonly ACTIONS_PUBLIC_KEY_FILE=${1-}
readonly TARGET_USER=ai-project-os-actions
readonly TARGET_HOME=/var/lib/ai-project-os-actions
readonly SOURCE_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
readonly PRODUCTION_ENV=/etc/ai-project-os/production.env
readonly LEGACY_ENV=/srv/ai-project-os/app/.env
readonly AUTHORIZED_KEYS=$TARGET_HOME/.ssh/authorized_keys

if [[ $EUID -ne 0 ]]; then
  printf 'INSTALL_ROOT_REQUIRED\n' >&2
  exit 70
fi

if [[ -z "$ACTIONS_PUBLIC_KEY_FILE" || ! -f "$ACTIONS_PUBLIC_KEY_FILE" ]]; then
  printf 'INSTALL_ACTIONS_PUBLIC_KEY_REQUIRED\n' >&2
  exit 64
fi

if ! id "$TARGET_USER" >/dev/null 2>&1; then
  useradd \
    --system \
    --user-group \
    --create-home \
    --home-dir "$TARGET_HOME" \
    --shell /bin/bash \
    "$TARGET_USER"
fi

test "$(getent passwd "$TARGET_USER" | cut -d: -f6)" = "$TARGET_HOME"
test "$(getent passwd "$TARGET_USER" | cut -d: -f7)" = /bin/bash
passwd --lock "$TARGET_USER" >/dev/null

read -r key_type key_body key_comment < "$ACTIONS_PUBLIC_KEY_FILE"
if [[ "$key_type" != ssh-ed25519 || ! "$key_body" =~ ^[A-Za-z0-9+/]+={0,2}$ ]]; then
  printf 'INSTALL_ACTIONS_PUBLIC_KEY_INVALID\n' >&2
  exit 65
fi
ssh-keygen -lf "$ACTIONS_PUBLIC_KEY_FILE" >/dev/null

install -o root -g root -m 0755 \
  "$SOURCE_DIR/ai-project-os-deploy" \
  /usr/local/sbin/ai-project-os-deploy
install -o root -g root -m 0755 \
  "$SOURCE_DIR/ai-project-os-actions-gateway" \
  /usr/local/sbin/ai-project-os-actions-gateway

temporary_sudoers=$(mktemp)
trap 'rm -f -- "$temporary_sudoers"' EXIT
install -o root -g root -m 0440 \
  "$SOURCE_DIR/ai-project-os-deploy.sudoers" \
  "$temporary_sudoers"
visudo -cf "$temporary_sudoers" >/dev/null
install -o root -g root -m 0440 \
  "$temporary_sudoers" \
  /etc/sudoers.d/ai-project-os-deploy
rm -f -- "$temporary_sudoers"
trap - EXIT

install -d -o root -g root -m 0700 /etc/ai-project-os
if [[ ! -e "$PRODUCTION_ENV" ]]; then
  test -f "$LEGACY_ENV"
  install -o root -g root -m 0600 "$LEGACY_ENV" "$PRODUCTION_ENV"
fi

test "$(stat -c %U:%G "$PRODUCTION_ENV")" = root:root
test "$(stat -c %a "$PRODUCTION_ENV")" = 600
grep -Eq '^POSTGRES_PASSWORD=[0-9a-f]{64}$' "$PRODUCTION_ENV"
grep -qx 'AI_PROJECT_OS_SECURE_COOKIES=true' "$PRODUCTION_ENV"

if [[ -e "$LEGACY_ENV" ]]; then
  chown root:root "$LEGACY_ENV"
  chmod 600 "$LEGACY_ENV"
fi

install -d -o root -g root -m 0755 /srv/ai-project-os
install -d -o root -g root -m 0700 /var/backups/ai-project-os
install -d -o root -g root -m 0700 /var/lib/ai-project-os
install -d -o "$TARGET_USER" -g "$TARGET_USER" -m 0700 "$TARGET_HOME/.ssh"
restricted_entry="restrict,command=\"/usr/local/sbin/ai-project-os-actions-gateway\" $key_type $key_body github-actions-ai-project-os-production"

if [[ -s "$AUTHORIZED_KEYS" ]]; then
  if ! grep -Fxq "$restricted_entry" "$AUTHORIZED_KEYS" || \
    grep -Fvx "$restricted_entry" "$AUTHORIZED_KEYS" | grep -q '[^[:space:]]'; then
    printf 'INSTALL_ACTIONS_AUTHORIZED_KEYS_NOT_EXCLUSIVE\n' >&2
    exit 66
  fi
fi

temporary_authorized_keys=$(mktemp)
trap 'rm -f -- "$temporary_authorized_keys"' EXIT
printf '%s\n' "$restricted_entry" > "$temporary_authorized_keys"
install -o "$TARGET_USER" -g "$TARGET_USER" -m 0600 \
  "$temporary_authorized_keys" \
  "$AUTHORIZED_KEYS"
rm -f -- "$temporary_authorized_keys"
trap - EXIT

visudo -cf /etc/sudoers.d/ai-project-os-deploy >/dev/null
bash -n /usr/local/sbin/ai-project-os-deploy
bash -n /usr/local/sbin/ai-project-os-actions-gateway

printf 'INSTALL_OK user=%s gateway=%s deployer=%s env=%s\n' \
  "$TARGET_USER" \
  /usr/local/sbin/ai-project-os-actions-gateway \
  /usr/local/sbin/ai-project-os-deploy \
  "$PRODUCTION_ENV"
