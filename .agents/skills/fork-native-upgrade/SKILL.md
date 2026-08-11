---
name: fork-native-upgrade
description: "w-gitops fork-only production upgrade procedure. Use whenever installing or upgrading the native PI WEB systemd user services from this fork. Enforces native dependency checks, health gates, and rollback; never use raw npm install or --ignore-scripts."
---

# Fork native upgrade

This is private operational guidance for `w-gitops/pi-web`. Do not include it in an upstream pull request.

Always deploy the native production installation with:

```bash
scripts/fork-native-upgrade.sh --yes
```

Never install the production package with `--ignore-scripts`. PI WEB depends on `node-pty`; suppressing lifecycle scripts leaves `pty.node` absent and makes `pi-web-sessiond.service` crash-loop. A running web/API process can hide that failure while session lists and terminal routes return unavailable.

The deployment script must remain the authority because it:

1. snapshots the exact installed package and native dependency tree for rollback;
2. builds and packs the checked-out fork;
3. installs the exact new tarball into an isolated prefix with lifecycle scripts enabled;
4. requires `node-pty` in staging before replacing the global package;
5. installs globally through npm, then repeats the native preflight;
6. activates from a detached systemd unit so restarting sessiond cannot kill the deploying agent midway;
7. restarts sessiond first and requires its Unix-socket `/health` endpoint;
8. restarts web only after sessiond is healthy;
9. atomically restores the verified prior installation and health-checks both services if activation fails;
10. serializes deployments with a lock and unique staging directory.

After the detached activation completes, inspect the log path printed by the script and verify:

```bash
systemctl --user is-active pi-web-sessiond.service pi-web.service
curl --unix-socket ~/.pi-web/sessiond.sock -fsS http://localhost/health
curl -fsS http://192.168.200.130:8504/api/machines/local/sessions?cwd=%2Froot%2Fcode%2Fagent-factory
curl -fsS http://192.168.200.130:8504/pi-web-plugins/manifest.json
```

A sessiond restart can interrupt active runtime ownership. Tell the user before invoking the script. Do not report success until the activation log records both health checks.
