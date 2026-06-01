#!/usr/bin/env bash
# EMS-COP — Mythic C2 host-based deployment helper.
#
# Mythic ships its own multi-container stack via `mythic-cli`. The cleanest
# way to run it alongside EMS-COP is to clone the upstream repo and let
# mythic-cli drive Docker on the host directly. This script automates the
# canonical flow described at https://docs.mythic-c2.net/installation .
#
# Usage:
#   ./scripts/start-mythic.sh [start|stop|status|install]
#
# Environment variables (set in .env or shell):
#   MYTHIC_HOME      Default: ./mythic/upstream
#   MYTHIC_REF       Git ref to check out (default: latest tag)
#   MYTHIC_USERNAME  Admin username (default: mythic_admin)
#   MYTHIC_PASSWORD  Admin password (default: random on first install)
#   MYTHIC_PORT      Mythic UI/API port (default: 7443)
#
# After Mythic is running, set the following on the c2-gateway service:
#   MYTHIC_ENABLED=true
#   MYTHIC_HOST=<host reachable from the c2-gateway container>
#   MYTHIC_PORT=7443
#   MYTHIC_USERNAME=<your admin user>
#   MYTHIC_PASSWORD=<your admin password>
#
# Exit codes:
#   0 success, non-zero failure (with diagnostic output to stderr).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MYTHIC_HOME="${MYTHIC_HOME:-$REPO_ROOT/mythic/upstream}"
MYTHIC_REF="${MYTHIC_REF:-}"
MYTHIC_USERNAME="${MYTHIC_USERNAME:-mythic_admin}"
MYTHIC_PASSWORD="${MYTHIC_PASSWORD:-}"
MYTHIC_PORT="${MYTHIC_PORT:-7443}"

cmd="${1:-start}"

require() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "ERROR: '$1' is required but not installed." >&2
        exit 1
    fi
}

ensure_clone() {
    if [ ! -d "$MYTHIC_HOME/.git" ]; then
        require git
        echo "[EMS] Cloning Mythic into $MYTHIC_HOME"
        mkdir -p "$(dirname "$MYTHIC_HOME")"
        if [ -n "$MYTHIC_REF" ]; then
            git clone --depth 1 --branch "$MYTHIC_REF" \
                https://github.com/its-a-feature/Mythic.git "$MYTHIC_HOME"
        else
            git clone --depth 1 https://github.com/its-a-feature/Mythic.git "$MYTHIC_HOME"
        fi
    else
        echo "[EMS] Updating existing Mythic checkout in $MYTHIC_HOME"
        git -C "$MYTHIC_HOME" fetch --depth 1 origin
        git -C "$MYTHIC_HOME" reset --hard origin/HEAD || true
    fi
}

ensure_cli() {
    if [ ! -x "$MYTHIC_HOME/mythic-cli" ]; then
        echo "[EMS] Building mythic-cli"
        require make
        ( cd "$MYTHIC_HOME" && sudo -E make 2>/dev/null || make )
    fi
}

apply_config() {
    cd "$MYTHIC_HOME"
    if [ -n "$MYTHIC_PASSWORD" ]; then
        ./mythic-cli config set admin_password "$MYTHIC_PASSWORD" || true
    fi
    ./mythic-cli config set admin_user "$MYTHIC_USERNAME" || true
    ./mythic-cli config set server_bind_port "$MYTHIC_PORT" || true
}

case "$cmd" in
    install|start)
        require docker
        ensure_clone
        ensure_cli
        apply_config
        echo "[EMS] Starting Mythic (this can take 5-15 minutes on first run)"
        cd "$MYTHIC_HOME"
        sudo ./mythic-cli start
        echo
        echo "[EMS] Mythic is up. Web UI: https://localhost:${MYTHIC_PORT}"
        echo "[EMS] Update .env with:"
        echo "       MYTHIC_ENABLED=true"
        echo "       MYTHIC_HOST=<reachable hostname/IP>"
        echo "       MYTHIC_PORT=${MYTHIC_PORT}"
        echo "       MYTHIC_USERNAME=${MYTHIC_USERNAME}"
        echo "       MYTHIC_PASSWORD=<the password printed above or your override>"
        ;;
    stop)
        if [ -x "$MYTHIC_HOME/mythic-cli" ]; then
            cd "$MYTHIC_HOME"
            sudo ./mythic-cli stop
        else
            echo "[EMS] mythic-cli not built — nothing to stop."
        fi
        ;;
    status)
        if [ -x "$MYTHIC_HOME/mythic-cli" ]; then
            cd "$MYTHIC_HOME"
            sudo ./mythic-cli status
        else
            echo "[EMS] Mythic is not installed. Run: $0 install"
        fi
        ;;
    *)
        echo "Usage: $0 [start|stop|status|install]" >&2
        exit 2
        ;;
esac
