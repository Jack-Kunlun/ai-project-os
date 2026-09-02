#!/usr/bin/env bash
set -Eeuo pipefail

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
umask 077

readonly SOURCE_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
readonly COS_ENV_FILE=/etc/ai-project-os/cos-backup.env
readonly COSCLI_CONFIG=/etc/ai-project-os/coscli.yaml
readonly AGE_RECIPIENT_FILE=/etc/ai-project-os/production-backup-age.pub
readonly INSTALL_MODE=${1-install-only}

if [[ $EUID -ne 0 ]]; then
  printf 'BACKUP_INSTALL_ROOT_REQUIRED\n' >&2
  exit 70
fi

case "$INSTALL_MODE" in
  install-only|--enable-timer) ;;
  *)
    printf 'BACKUP_INSTALL_USAGE: install-production-backup.sh [--enable-timer]\n' >&2
    exit 64
    ;;
esac

for required_command in age coscli docker systemctl systemd-analyze; do
  command -v "$required_command" >/dev/null
done

for path in "$COS_ENV_FILE" "$COSCLI_CONFIG"; do
  test -f "$path"
  test "$(stat -c %U:%G "$path")" = root:root
  test "$(stat -c %a "$path")" = 600
done

test -f "$AGE_RECIPIENT_FILE"
test "$(stat -c %U:%G "$AGE_RECIPIENT_FILE")" = root:root
test "$(stat -c %a "$AGE_RECIPIENT_FILE")" = 644
grep -Eq '^age1[0-9a-z]{58}$' "$AGE_RECIPIENT_FILE"
grep -Eq '^COS_BACKUP_BUCKET=' "$COS_ENV_FILE"
grep -Eq '^COS_BACKUP_REGION=' "$COS_ENV_FILE"
grep -Eq '^COS_BACKUP_PREFIX=' "$COS_ENV_FILE"
test "$(coscli --version)" = 'coscli version v1.0.9'

install -d -o root -g root -m 0700 \
  /var/backups/ai-project-os \
  /var/lib/ai-project-os-backup \
  /var/lib/ai-project-os-backup/staging
for public_status_directory in \
  /var/lib/ai-project-os-operations \
  /var/lib/ai-project-os-operations/backups \
  /var/lib/ai-project-os-operations/backups/history; do
  test ! -L "$public_status_directory"
done
install -d -o root -g root -m 0755 \
  /var/lib/ai-project-os-operations \
  /var/lib/ai-project-os-operations/backups \
  /var/lib/ai-project-os-operations/backups/history

for public_status_directory in \
  /var/lib/ai-project-os-operations \
  /var/lib/ai-project-os-operations/backups \
  /var/lib/ai-project-os-operations/backups/history; do
  test "$(stat -c %U:%G "$public_status_directory")" = root:root
  test "$(stat -c %a "$public_status_directory")" = 755
done

install -o root -g root -m 0755 \
  "$SOURCE_DIR/ai-project-os-backup" \
  /usr/local/sbin/ai-project-os-backup
install -o root -g root -m 0644 \
  "$SOURCE_DIR/ai-project-os-backup.service" \
  /etc/systemd/system/ai-project-os-backup.service
install -o root -g root -m 0644 \
  "$SOURCE_DIR/ai-project-os-backup.timer" \
  /etc/systemd/system/ai-project-os-backup.timer

bash -n /usr/local/sbin/ai-project-os-backup
systemd-analyze verify \
  /etc/systemd/system/ai-project-os-backup.service \
  /etc/systemd/system/ai-project-os-backup.timer

systemctl daemon-reload
if [[ "$INSTALL_MODE" == --enable-timer ]]; then
  systemctl enable --now ai-project-os-backup.timer
  systemctl is-enabled --quiet ai-project-os-backup.timer
  systemctl is-active --quiet ai-project-os-backup.timer
  timer_state=enabled
  next_run=$(systemctl show ai-project-os-backup.timer --property=NextElapseUSecRealtime --value)
else
  timer_state=installed-not-enabled
  next_run=none
fi

printf 'BACKUP_INSTALL_OK script=%s timer=%s state=%s next=%s\n' \
  /usr/local/sbin/ai-project-os-backup \
  ai-project-os-backup.timer \
  "$timer_state" \
  "$next_run"
