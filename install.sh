#!/bin/bash
# Tab Live installer for macOS.
#
#   sudo ./install.sh --user <agent-user> [--cdp http://127.0.0.1:9222] [--port 8335]
#                     [--host <ip>]... [--tailscale] [--no-desktop] [--name Tab]
#   ./install.sh --mode agent ...       # no sudo: LaunchAgent in your own GUI session only
#
# Server: a LaunchDaemon that runs as <agent-user> (starts at boot, KeepAlive) or, in agent
# mode, a LaunchAgent. Desktop helper: a LaunchAgent in <agent-user>'s GUI session.
# Secrets and machine-specific settings live in ~<agent-user>/.config/tab-live/, never in the repo.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
MODE=daemon; USER_NAME="${SUDO_USER:-$USER}"; CDP=""; PORT=""; NAME=""; DESKTOP=1; USE_TS=0; HOSTS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --user) USER_NAME="$2"; shift 2;;
    --mode) MODE="$2"; shift 2;;
    --cdp) CDP="$2"; shift 2;;
    --port) PORT="$2"; shift 2;;
    --host) HOSTS+=("$2"); shift 2;;
    --tailscale) USE_TS=1; shift;;
    --name) NAME="$2"; shift 2;;
    --no-desktop) DESKTOP=0; shift;;
    -h|--help) sed -n '2,12p' "$0"; exit 0;;
    *) echo "unknown option: $1" >&2; exit 2;;
  esac
done

say() { printf '\033[1;35m▸\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

[[ "$(uname)" == Darwin ]] || die "macOS only (the server itself runs anywhere: node server.js)"
if [[ $MODE == daemon && $EUID -ne 0 ]]; then die "daemon mode needs sudo (or use --mode agent)"; fi
if [[ $MODE == agent && $EUID -eq 0 ]]; then die "agent mode runs as the agent user, without sudo"; fi

UID_N=$(id -u "$USER_NAME") || die "no such user: $USER_NAME"
HOME_DIR=$(dscl . -read "/Users/$USER_NAME" NFSHomeDirectory | awk '{print $2}')
as_user() { if [[ $EUID -eq 0 ]]; then sudo -H -u "$USER_NAME" "$@"; else "$@"; fi; }

NODE=$(as_user bash -lc 'command -v node' || true)
[[ -n "$NODE" ]] || for c in /opt/homebrew/bin/node /usr/local/bin/node; do [[ -x $c ]] && NODE=$c && break; done
[[ -x "$NODE" ]] || die "node not found for $USER_NAME (brew install node)"
NODE_MAJOR=$("$NODE" -p 'process.versions.node.split(".")[0]')
(( NODE_MAJOR >= 20 )) || die "node >= 20 required (found $NODE_MAJOR)"
NPM="$(dirname "$NODE")/npm"

say "installing dependencies"
as_user bash -lc "cd '$APP_DIR' && '$NPM' install --omit=dev --no-audit --no-fund --silent"

CONF_DIR="$HOME_DIR/.config/tab-live"; LOG_DIR="$HOME_DIR/Library/Logs/tab-live"
as_user mkdir -p "$CONF_DIR" "$LOG_DIR" "$HOME_DIR/.cache/tab-live"
as_user chmod 700 "$CONF_DIR"

# --- listen addresses: loopback + explicit hosts (+ this Mac's Tailscale IPv4). Never 0.0.0.0.
HOSTS=("127.0.0.1" "${HOSTS[@]+"${HOSTS[@]}"}")
if (( USE_TS )); then
  TS_BIN=""; for c in /Applications/Tailscale.app/Contents/MacOS/Tailscale /opt/homebrew/bin/tailscale /usr/local/bin/tailscale; do [[ -x $c ]] && TS_BIN=$c && break; done
  TS_IP=$([[ -n $TS_BIN ]] && "$TS_BIN" ip -4 2>/dev/null | head -1 || true)
  [[ $TS_IP =~ ^100\. ]] || die "--tailscale given but no Tailscale IPv4 found"
  HOSTS+=("$TS_IP")
fi
HOSTS_CSV=$(IFS=,; echo "${HOSTS[*]}")

# --- config.json (merge: keep existing values unless overridden)
as_user "$NODE" -e '
  const fs=require("fs"), f=process.argv[1]; let c={}; try{c=JSON.parse(fs.readFileSync(f))}catch{}
  const [hosts,port,cdp,name]=process.argv.slice(2);
  c.hosts=hosts; if(port) c.port=+port; else c.port??=8335;
  if(cdp) c.cdpUrl=cdp; else c.cdpUrl??="http://127.0.0.1:9222";
  if(name) c.name=name; else c.name??="Tab";
  fs.writeFileSync(f, JSON.stringify(c,null,2)+"\n", {mode:0o600});
' "$CONF_DIR/config.json" "$HOSTS_CSV" "$PORT" "$CDP" "$NAME"

# --- token (generated once, 0600, outside the repo)
if ! as_user test -s "$CONF_DIR/token"; then
  as_user bash -c "umask 077; '$NODE' -e 'process.stdout.write(require(\"crypto\").randomBytes(18).toString(\"base64url\")+\"\\n\")' > '$CONF_DIR/token'"
  say "generated a new access token"
fi

render() { # template -> stdout
  sed -e "s#__NODE__#$NODE#g" -e "s#__APP_DIR__#$APP_DIR#g" -e "s#__HOME__#$HOME_DIR#g" -e "s#__LOG_DIR__#$LOG_DIR#g" \
      -e "s#__USERNAME_BLOCK__#$1#" "$2"
}
reload_job() { # domain label plist: bootout, wait until gone, bootstrap (launchd's bootout is asynchronous)
  launchctl bootout "$1/$2" 2>/dev/null || true
  for _ in $(seq 1 50); do launchctl print "$1/$2" >/dev/null 2>&1 || break; sleep 0.2; done
  launchctl bootstrap "$1" "$3"
}
backup() { [[ -f "$1" ]] && cp -p "$1" "$1.bak-$(date +%Y%m%d%H%M%S)" || true; }

# --- server
if [[ $MODE == daemon ]]; then
  P=/Library/LaunchDaemons/com.tablive.server.plist
  backup "$P"
  render "<key>UserName</key><string>$USER_NAME</string>" "$APP_DIR/launchd/com.tablive.server.plist.template" > "$P"
  chown root:wheel "$P"; chmod 644 "$P"; plutil -lint "$P" >/dev/null
  launchctl enable system/com.tablive.server
  reload_job system com.tablive.server "$P"
  say "server installed as LaunchDaemon (runs as $USER_NAME, starts at boot)"
else
  P="$HOME_DIR/Library/LaunchAgents/com.tablive.server.plist"
  mkdir -p "$(dirname "$P")"; backup "$P"
  render "" "$APP_DIR/launchd/com.tablive.server.plist.template" > "$P"; plutil -lint "$P" >/dev/null
  reload_job "gui/$UID_N" com.tablive.server "$P"
  say "server installed as LaunchAgent"
fi

# --- desktop helper (GUI session of the agent user)
if (( DESKTOP )); then
  if command -v clang >/dev/null; then as_user bash "$APP_DIR/scripts/build-capture.sh" >/dev/null && say "built Tab Live Capture.app";
  else say "no clang: install Xcode Command Line Tools for the Desktop view (xcode-select --install)"; DESKTOP=0; fi
fi
if (( DESKTOP )); then
  P="$HOME_DIR/Library/LaunchAgents/com.tablive.desktop.plist"
  as_user mkdir -p "$HOME_DIR/Library/LaunchAgents"; [[ -f $P ]] && as_user cp -p "$P" "$P.bak-$(date +%Y%m%d%H%M%S)"
  render "" "$APP_DIR/launchd/com.tablive.desktop.plist.template" | as_user tee "$P" >/dev/null
  plutil -lint "$P" >/dev/null
  if launchctl print "gui/$UID_N" >/dev/null 2>&1; then
    reload_job "gui/$UID_N" com.tablive.desktop "$P" && say "desktop helper loaded into $USER_NAME's GUI session"
  else
    say "desktop helper will load the next time $USER_NAME logs in to a GUI session"
  fi
fi

PORT_N=$(as_user "$NODE" -p "require('$CONF_DIR/config.json').port")
if (( DESKTOP )); then
  echo
  say "one manual step for the Desktop view: System Settings > Privacy & Security > Screen & System Audio Recording,"
  echo "  click +, press Cmd-Shift-G, open $APP_DIR/build/ and add \"Tab Live Capture\" (then switch it on)."
fi
echo
say "done. Open one of:"
for h in "${HOSTS[@]}"; do echo "    http://$h:$PORT_N/#token=<contents of $CONF_DIR/token>"; done
echo "  Logs: $LOG_DIR/server.log"
