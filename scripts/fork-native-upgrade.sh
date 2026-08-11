#!/usr/bin/env bash
set -euo pipefail

PACKAGE_NAME="@jmfederico/pi-web"
SESSIOND_UNIT="pi-web-sessiond.service"
WEB_UNIT="pi-web.service"

fail() { printf 'fork-native-upgrade: %s\n' "$*" >&2; exit 1; }

wait_for_sessiond() {
  local socket=$1 output=$2 _
  for _ in $(seq 1 60); do
    curl --unix-socket "$socket" -fsS http://localhost/health >"$output" 2>/dev/null && return 0
    sleep 1
  done
  return 1
}

wait_for_web() {
  local url=$1 output=$2 _
  for _ in $(seq 1 60); do
    curl -fsS "$url/api/pi-web/runtime" >"$output" 2>/dev/null && return 0
    sleep 1
  done
  return 1
}

native_preflight() {
  local install_dir=$1
  node -e 'require(process.argv[1])' "$install_dir/node_modules/node-pty"
  node "$install_dir/dist/cli.js" --version
}

restore_snapshot() {
  local install_dir=$1 snapshot=$2 socket=$3 web_url=$4 work_dir=$5
  local restore_root="$work_dir/restore" failed_install="$work_dir/failed-install"
  rm -rf "$restore_root"
  mkdir -p "$restore_root"
  tar -C "$restore_root" -xzf "$snapshot"
  native_preflight "$restore_root/pi-web"

  systemctl --user stop "$WEB_UNIT" "$SESSIOND_UNIT" || true
  rm -rf "$failed_install"
  [[ ! -e $install_dir ]] || mv "$install_dir" "$failed_install"
  mv "$restore_root/pi-web" "$install_dir"

  local recovery_failed=0
  systemctl --user start "$SESSIOND_UNIT" || recovery_failed=1
  wait_for_sessiond "$socket" "$work_dir/rollback-sessiond-health.json" || recovery_failed=1
  systemctl --user start "$WEB_UNIT" || recovery_failed=1
  wait_for_web "$web_url" "$work_dir/rollback-web-runtime.json" || recovery_failed=1
  (( recovery_failed == 0 )) || fail "previous installation was restored, but one or both services remain unhealthy"
  fail "upgrade was rolled back; inspect this unit's journal"
}

activate() {
  local install_dir=$1 snapshot=$2 socket=$3 web_url=$4 work_dir=$5
  if ! systemctl --user restart "$SESSIOND_UNIT" \
    || ! wait_for_sessiond "$socket" "$work_dir/sessiond-health.json"; then
    restore_snapshot "$install_dir" "$snapshot" "$socket" "$web_url" "$work_dir"
  fi
  if ! systemctl --user restart "$WEB_UNIT" \
    || ! wait_for_web "$web_url" "$work_dir/web-runtime.json"; then
    restore_snapshot "$install_dir" "$snapshot" "$socket" "$web_url" "$work_dir"
  fi
  systemctl --user is-active "$SESSIOND_UNIT" "$WEB_UNIT"
  printf 'Upgrade activation completed successfully.\n'
  cat "$work_dir/sessiond-health.json"
  cat "$work_dir/web-runtime.json"
}

if [[ ${1:-} == "--activate" ]]; then
  shift
  [[ $# -eq 5 ]] || fail "invalid activation arguments"
  activate "$@"
  exit 0
fi

[[ ${1:-} == "--yes" ]] || fail "usage: $0 --yes (sessiond restart can interrupt active work)"
[[ $(id -u) -eq 0 ]] || fail "this production installation is owned by root"

exec 9>/tmp/pi-web-native-upgrade.lock
flock -n 9 || fail "another native upgrade is already running"

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"
[[ -z $(git status --porcelain) ]] || fail "repository worktree is not clean"
[[ $(git branch --show-current) == "main" ]] || fail "deploy only from main"

global_root=$(npm root -g)
install_dir="$global_root/$PACKAGE_NAME"
scope_dir=$(dirname "$install_dir")
[[ -d $install_dir ]] || fail "installed package not found at $install_dir"
work_dir=$(mktemp -d "$scope_dir/.pi-web-native-upgrade.XXXXXX")
mkdir -p "$work_dir/new" "$work_dir/stage" "$work_dir/snapshot-check"
snapshot="$work_dir/previous-install.tar.gz"

config_file=${PI_WEB_CONFIG:-$HOME/.config/pi-web/config.json}
data_dir=${PI_WEB_DATA_DIR:-$HOME/.pi-web}
[[ -r $config_file ]] || fail "cannot read PI WEB config at $config_file"
host=$(jq -er '.host // "127.0.0.1"' "$config_file")
port=$(jq -er '.port // 8080' "$config_file")
socket="$data_dir/sessiond.sock"
web_url="http://$host:$port"

# Preserve the exact working package and dependency tree. The global bin links
# target this stable install_dir and therefore remain valid after an atomic
# same-filesystem directory swap during rollback.
tar -C "$scope_dir" -czf "$snapshot" pi-web
tar -C "$work_dir/snapshot-check" -xzf "$snapshot"
native_preflight "$work_dir/snapshot-check/pi-web"

npm run build
npm pack --pack-destination "$work_dir/new"
new_tarball=$(find "$work_dir/new" -maxdepth 1 -type f -name '*.tgz' -print -quit)
[[ -n $new_tarball ]] || fail "npm pack did not create the new tarball"

# Prove the exact tarball in isolation, with lifecycle scripts enabled, before
# changing the global package or either running service.
npm install --prefix "$work_dir/stage" "$new_tarball" --foreground-scripts
native_preflight "$work_dir/stage/node_modules/$PACKAGE_NAME"

# npm owns the global package replacement and executable links. Never use
# --ignore-scripts: node-pty must compile for this host and Node ABI.
if ! npm install -g "$new_tarball" --foreground-scripts \
  || ! native_preflight "$install_dir"; then
  restore_snapshot "$install_dir" "$snapshot" "$socket" "$web_url" "$work_dir"
fi

unit="pi-web-native-upgrade-$(basename "$work_dir")"
if ! systemd-run --user --collect --unit "$unit" \
  /usr/bin/flock /tmp/pi-web-native-upgrade.lock \
  "$repo_root/scripts/fork-native-upgrade.sh" --activate \
  "$install_dir" "$snapshot" "$socket" "$web_url" "$work_dir"; then
  restore_snapshot "$install_dir" "$snapshot" "$socket" "$web_url" "$work_dir"
fi

printf 'Installed package passed isolated and live native preflight.\n'
printf 'Detached activation unit: %s\n' "$unit"
printf 'Follow with: journalctl --user -fu %q\n' "$unit"
printf 'Do not report success until that unit records both health checks.\n'
