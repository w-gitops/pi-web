#!/usr/bin/env bash
set -euo pipefail

SCRIPT_NAME="bootstrap-session-search-node24"
NODE_MAJOR=24
PI_WEB_PACKAGE="@jmfederico/pi-web"
SESSION_SEARCH_SPEC="${SESSION_SEARCH_SPEC:-npm:pi-session-search@1.4.3}"
CLAUDE_PROVIDER_SPEC="${CLAUDE_PROVIDER_SPEC:-npm:pi-claude-code-provider@0.1.2}"
SESSIOND_UNIT="pi-web-sessiond.service"
WEB_UNIT="pi-web.service"
NODE_SOURCE_FILE="${NODE_SOURCE_FILE:-/etc/apt/sources.list.d/nodesource.sources}"

confirm=0
restart_services=0
dry_run=0

fail() { printf '%s: %s\n' "$SCRIPT_NAME" "$*" >&2; exit 1; }
log() { printf '%s: %s\n' "$SCRIPT_NAME" "$*"; }

usage() {
  cat <<'EOF'
Usage: scripts/bootstrap-session-search-node24.sh --yes [--restart] [--dry-run]

Installs the supported Node.js runtime, rebuilds this checkout's exact PI WEB
package for the new Node ABI, reinstalls the current Pi version, and installs
pi-session-search. The operation is idempotent.

Options:
  --yes      Required acknowledgement that Node and global packages may change.
  --restart  After installation, restart PI WEB web/API first and sessiond last.
             Restarting sessiond interrupts active session runtime ownership.
  --dry-run  Print the resolved plan without changing the system.
  --help     Show this help.

Environment overrides:
  SESSION_SEARCH_SPEC  Pi package source (default: npm:pi-session-search@1.4.3)
  CLAUDE_PROVIDER_SPEC Claude provider source (default: npm:pi-claude-code-provider@0.1.2)
  NODE_SOURCE_FILE     NodeSource deb822 source file
  PI_WEB_CONFIG        PI WEB config file
  PI_WEB_DATA_DIR      PI WEB data directory
EOF
}

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
  node -e 'require(require.resolve("node-pty", { paths: [process.argv[1]] }))' "$install_dir"
  node "$install_dir/dist/cli.js" --version
}

activate() {
  local socket=$1 web_url=$2 work_dir=$3

  # The web/API process does not own session runtimes, so restart it first.
  systemctl --user restart "$WEB_UNIT"
  wait_for_web "$web_url" "$work_dir/web-after-restart.json" \
    || fail "web/API did not become healthy after restart"

  # Sessiond owns this script's caller when run from PI WEB. Keep this last.
  systemctl --user restart "$SESSIOND_UNIT"
  wait_for_sessiond "$socket" "$work_dir/sessiond-after-restart.json" \
    || fail "sessiond did not become healthy after restart"
  wait_for_web "$web_url" "$work_dir/web-final.json" \
    || fail "web/API did not reconnect after the sessiond restart"

  systemctl --user is-active "$WEB_UNIT" "$SESSIOND_UNIT"
  log "activation completed successfully"
  cat "$work_dir/web-final.json"
  cat "$work_dir/sessiond-after-restart.json"
}

if [[ ${1:-} == "--activate" ]]; then
  shift
  [[ $# -eq 3 ]] || fail "invalid internal activation arguments"
  activate "$@"
  exit 0
fi

while (($# > 0)); do
  case "$1" in
    --yes) confirm=1 ;;
    --restart) restart_services=1 ;;
    --dry-run) dry_run=1 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; fail "unknown argument: $1" ;;
  esac
  shift
done

((confirm == 1)) || { usage >&2; fail "--yes is required"; }
[[ $(id -u) -eq 0 ]] || fail "run as root; this native installation is owned by root"

for command in apt-get claude curl flock git jq node npm pi systemctl systemd-run tar; do
  command -v "$command" >/dev/null || fail "required command is missing: $command"
done
[[ -r $NODE_SOURCE_FILE ]] || fail "cannot read NodeSource configuration: $NODE_SOURCE_FILE"
grep -Eq 'deb\.nodesource\.com/node_[0-9]+\.x' "$NODE_SOURCE_FILE" \
  || fail "NodeSource configuration does not contain a node_NN.x repository"

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"
[[ $(git branch --show-current) == "main" ]] || fail "deploy only from the main branch"
# Permit this bootstrap file to be newly dropped into an otherwise clean
# checkout; all product source used to build the deployment must be committed.
dirty_product_files=$(git status --porcelain | grep -vE '^\?\? scripts/bootstrap-session-search-node24\.sh$' || true)
[[ -z $dirty_product_files ]] || fail "repository product worktree is not clean"

current_pi_version=$(pi --version | awk 'NR == 1 { print $1 }')
[[ $current_pi_version =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]] \
  || fail "could not determine the installed Pi version"
pi_package_spec="@earendil-works/pi-coding-agent@$current_pi_version"
current_node=$(node --version)
current_commit=$(git rev-parse HEAD)

config_file=${PI_WEB_CONFIG:-$HOME/.config/pi-web/config.json}
data_dir=${PI_WEB_DATA_DIR:-$HOME/.pi-web}
[[ -r $config_file ]] || fail "cannot read PI WEB config: $config_file"
host=$(jq -er '.host // "127.0.0.1"' "$config_file")
port=$(jq -er '.port // 8080' "$config_file")
case "$host" in
  0.0.0.0) health_host=127.0.0.1 ;;
  ::) health_host='[::1]' ;;
  *) health_host=$host ;;
esac
web_url="http://$health_host:$port"
socket="$data_dir/sessiond.sock"

cat <<EOF
Resolved plan:
  Node:           $current_node -> Node $NODE_MAJOR.x from $NODE_SOURCE_FILE
  Pi:             $pi_package_spec
  PI WEB source:  $repo_root at $current_commit
  Session search: $SESSION_SEARCH_SPEC
  Claude provider: $CLAUDE_PROVIDER_SPEC
  Restart:        $([[ $restart_services -eq 1 ]] && echo 'web/API first, sessiond last' || echo 'no')
EOF
((dry_run == 0)) || exit 0

exec 9>/tmp/pi-web-session-search-bootstrap.lock
flock -n 9 || fail "another bootstrap is already running"

stamp=$(date -u +%Y%m%d-%H%M%S)
backup_root=${PI_RUNTIME_BACKUP_DIR:-$HOME/pi-runtime-upgrades}
work_dir="$backup_root/$stamp"
mkdir -p "$work_dir/package" "$work_dir/config" "$work_dir/stage"
cp -a "$NODE_SOURCE_FILE" "$work_dir/config/nodesource.sources.before"
cp -a "$config_file" "$work_dir/config/pi-web-config.json"
[[ ! -f $HOME/.pi/agent/settings.json ]] \
  || cp -a "$HOME/.pi/agent/settings.json" "$work_dir/config/pi-settings.json"
npm ls -g --depth=0 --json >"$work_dir/global-packages.before.json" || true
printf '%s\n' "$current_node" >"$work_dir/node-version.before"
printf '%s\n' "$current_commit" >"$work_dir/pi-web-commit"

# Build and preserve the exact fork tarball before changing the host runtime.
log "building the exact PI WEB checkout"
npm run build
npm pack --pack-destination "$work_dir/package" >/dev/null
pi_web_tarball=$(find "$work_dir/package" -maxdepth 1 -type f -name '*.tgz' -print -quit)
[[ -n $pi_web_tarball ]] || fail "npm pack did not produce a PI WEB tarball"

installed_major=$(node -p 'Number(process.versions.node.split(".")[0])')
if ((installed_major < NODE_MAJOR)); then
  log "switching NodeSource to Node $NODE_MAJOR.x"
  sed -E "s#deb\.nodesource\.com/node_[0-9]+\.x#deb.nodesource.com/node_${NODE_MAJOR}.x#g" \
    "$NODE_SOURCE_FILE" >"$work_dir/config/nodesource.sources.next"
  install -m 0644 "$work_dir/config/nodesource.sources.next" "$NODE_SOURCE_FILE"
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
else
  log "Node $(node --version) already satisfies the Node $NODE_MAJOR requirement"
fi

new_major=$(node -p 'Number(process.versions.node.split(".")[0])')
((new_major >= NODE_MAJOR)) || fail "Node upgrade did not install Node $NODE_MAJOR or newer"

# Prove that the exact fork tarball installs and loads node-pty under the new
# Node ABI before replacing either global application.
log "staging the forked PI WEB package under $(node --version)"
npm install --prefix "$work_dir/stage" "$pi_web_tarball" --foreground-scripts
native_preflight "$work_dir/stage/node_modules/$PI_WEB_PACKAGE"

# Reinstall both global applications under the new Node ABI. PI WEB comes from
# this checkout so an npm registry release cannot replace the deployed fork.
log "reinstalling $pi_package_spec"
npm install -g "$pi_package_spec" --foreground-scripts
log "reinstalling the forked PI WEB package and rebuilding node-pty"
npm install -g "$pi_web_tarball" --foreground-scripts

install_dir="$(npm root -g)/$PI_WEB_PACKAGE"
[[ -d $install_dir ]] || fail "PI WEB global installation is missing after reinstall"
native_preflight "$install_dir"

log "installing $SESSION_SEARCH_SPEC"
pi install "$SESSION_SEARCH_SPEC"

# Verify the runtime capability that pi-session-search relies on instead of
# trusting only the Node version declaration.
node - <<'NODE'
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(":memory:");
try {
  db.exec("CREATE VIRTUAL TABLE session_search_probe USING fts5(content)");
  db.exec("DROP TABLE session_search_probe");
} finally {
  db.close();
}
NODE

session_search_dir="$HOME/.pi/agent/npm/node_modules/pi-session-search"
[[ -f $session_search_dir/package.json ]] \
  || fail "pi-session-search package was not installed at $session_search_dir"
installed_search_version=$(node -p "require('$session_search_dir/package.json').version")
log "installed pi-session-search $installed_search_version"

log "installing $CLAUDE_PROVIDER_SPEC"
pi install "$CLAUDE_PROVIDER_SPEC"
claude auth status >"$work_dir/claude-auth.json"
jq -e '.loggedIn == true and .subscriptionType == "max"' \
  "$work_dir/claude-auth.json" >/dev/null \
  || fail "Claude CLI is not authenticated with a Max subscription"
claude_provider_dir="$HOME/.pi/agent/npm/node_modules/pi-claude-code-provider"
[[ -f $claude_provider_dir/package.json ]] \
  || fail "Claude provider package was not installed at $claude_provider_dir"
installed_claude_provider_version=$(node -p "require('$claude_provider_dir/package.json').version")
log "installed Claude provider $installed_claude_provider_version"

cat >"$work_dir/result.json" <<EOF
{
  "node": "$(node --version)",
  "pi": "$(pi --version | head -1)",
  "piWeb": "$(pi-web --version | head -1)",
  "piWebCommit": "$current_commit",
  "piSessionSearch": "$installed_search_version",
  "piClaudeCodeProvider": "$installed_claude_provider_version",
  "restartRequested": $([[ $restart_services -eq 1 ]] && echo true || echo false)
}
EOF

if ((restart_services == 1)); then
  unit="pi-session-search-activate-$stamp"
  log "starting detached activation unit $unit; sessiond restart will interrupt active sessions"
  systemd-run --user --collect --unit "$unit" \
    "$repo_root/scripts/bootstrap-session-search-node24.sh" --activate \
    "$socket" "$web_url" "$work_dir"
  log "follow activation with: journalctl --user -fu $unit"
else
  log "installation complete; services were not restarted"
  log "when active work is drained, run: $repo_root/scripts/bootstrap-session-search-node24.sh --yes --restart"
fi

log "backup and result artifacts: $work_dir"
cat "$work_dir/result.json"
