#!/usr/bin/env bash
set -Eeuo pipefail

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
umask 077

readonly ACTIONS_PUBLIC_KEY_INPUT=${1-}
readonly INSTALL_MODE=${2---enable-backup-timer}
readonly TARGET_USER=ai-project-os-actions
readonly TARGET_HOME=/var/lib/ai-project-os-actions
readonly SOURCE_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
readonly PRODUCTION_ENV=/etc/ai-project-os/production.env
readonly LEGACY_ENV=/srv/ai-project-os/app/.env
readonly AUTHORIZED_KEYS=$TARGET_HOME/.ssh/authorized_keys

ACTIONS_PUBLIC_KEY_FILE=$ACTIONS_PUBLIC_KEY_INPUT
DERIVED_PUBLIC_KEY_FILE=

if [[ $EUID -ne 0 ]]; then
  printf 'INSTALL_ROOT_REQUIRED\n' >&2
  exit 70
fi

if [[ "$ACTIONS_PUBLIC_KEY_INPUT" == --reuse-existing-actions-key ]]; then
  [[ -f "$AUTHORIZED_KEYS" && ! -L "$AUTHORIZED_KEYS" ]] || {
    printf 'INSTALL_EXISTING_ACTIONS_KEY_MISSING\n' >&2
    exit 64
  }
  mapfile -t existing_action_keys < <(grep -oE 'ssh-ed25519 [A-Za-z0-9+/]+={0,2}( [^[:cntrl:]]+)?$' "$AUTHORIZED_KEYS")
  if (( ${#existing_action_keys[@]} != 1 )); then
    printf 'INSTALL_EXISTING_ACTIONS_KEY_INVALID\n' >&2
    exit 65
  fi
  DERIVED_PUBLIC_KEY_FILE=$(mktemp)
  printf '%s\n' "${existing_action_keys[0]}" > "$DERIVED_PUBLIC_KEY_FILE"
  ACTIONS_PUBLIC_KEY_FILE=$DERIVED_PUBLIC_KEY_FILE
elif [[ -z "$ACTIONS_PUBLIC_KEY_FILE" || ! -f "$ACTIONS_PUBLIC_KEY_FILE" || -L "$ACTIONS_PUBLIC_KEY_FILE" ]]; then
  printf 'INSTALL_ACTIONS_PUBLIC_KEY_REQUIRED\n' >&2
  exit 64
fi

case "$INSTALL_MODE" in
  --enable-backup-timer|--defer-backup-timer) ;;
  *)
    printf 'INSTALL_USAGE: install-production-deploy.sh <actions-public-key|--reuse-existing-actions-key> [--enable-backup-timer|--defer-backup-timer]\n' >&2
    exit 64
    ;;
esac

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
if [[ -n "$DERIVED_PUBLIC_KEY_FILE" ]]; then
  rm -f -- "$DERIVED_PUBLIC_KEY_FILE"
  DERIVED_PUBLIC_KEY_FILE=
fi

bash -n "$SOURCE_DIR/install-production-backup.sh"
if [[ "$INSTALL_MODE" == --enable-backup-timer ]]; then
  "$SOURCE_DIR/install-production-backup.sh" --enable-timer
else
  "$SOURCE_DIR/install-production-backup.sh" install-only
  systemctl disable --now ai-project-os-backup.timer >/dev/null 2>&1 || true
fi

install -d -o root -g root -m 0700 /etc/ai-project-os

install -o root -g root -m 0755 \
  "$SOURCE_DIR/ai-project-os-deploy" \
  /usr/local/sbin/ai-project-os-deploy
install -o root -g root -m 0644 \
  "$SOURCE_DIR/compose.operations.yaml" \
  /etc/ai-project-os/compose.operations.yaml
install -o root -g root -m 0755 \
  "$SOURCE_DIR/ai-project-os-configure-github-oauth" \
  /usr/local/sbin/ai-project-os-configure-github-oauth
install -o root -g root -m 0755 \
  "$SOURCE_DIR/ai-project-os-actions-gateway" \
  /usr/local/sbin/ai-project-os-actions-gateway
install -o root -g root -m 0755 \
  "$SOURCE_DIR/ai-project-os-restore" \
  /usr/local/sbin/ai-project-os-restore
install -o root -g root -m 0755 \
  "$SOURCE_DIR/ai-project-os-source-state" \
  /usr/local/sbin/ai-project-os-source-state
install -o root -g root -m 0755 \
  "$SOURCE_DIR/ai-project-os-activate-host" \
  /usr/local/sbin/ai-project-os-activate-host
install -o root -g root -m 0755 \
  "$SOURCE_DIR/ai-project-os-deactivate-host" \
  /usr/local/sbin/ai-project-os-deactivate-host

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
test ! -L "$PRODUCTION_ENV"
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
bash -n /usr/local/sbin/ai-project-os-configure-github-oauth
bash -n /usr/local/sbin/ai-project-os-actions-gateway
bash -n /usr/local/sbin/ai-project-os-restore
bash -n /usr/local/sbin/ai-project-os-source-state
bash -n /usr/local/sbin/ai-project-os-activate-host
bash -n /usr/local/sbin/ai-project-os-deactivate-host

printf 'INSTALL_OK user=%s gateway=%s deployer=%s configurator=%s env=%s backup_timer=%s\n' \
  "$TARGET_USER" \
  /usr/local/sbin/ai-project-os-actions-gateway \
  /usr/local/sbin/ai-project-os-deploy \
  /usr/local/sbin/ai-project-os-configure-github-oauth \
  "$PRODUCTION_ENV" \
  "${INSTALL_MODE#--}"
