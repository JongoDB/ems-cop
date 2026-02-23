#!/bin/bash
set -e

SLIVER_SERVER="/opt/sliver-server"
SLIVER_HOME="/home/sliver/.sliver"
OPERATOR_CONFIG="/home/sliver/.sliver/configs/ems-operator.cfg"

echo "[EMS] Starting Sliver C2 server setup..."

# First run: unpack assets if not already done
if [ ! -d "$SLIVER_HOME/configs" ]; then
    echo "[EMS] First run — unpacking Sliver assets (this may take a few minutes)..."
    $SLIVER_SERVER unpack --force
fi

# Start sliver-server in daemon mode
echo "[EMS] Starting Sliver server in daemon mode..."
$SLIVER_SERVER daemon &
SLIVER_PID=$!

# Wait for gRPC port 31337 to be ready using a simple TCP check
echo "[EMS] Waiting for Sliver gRPC to be ready on port 31337..."
MAX_RETRIES=120
RETRY=0
while ! (echo > /dev/tcp/127.0.0.1/31337) 2>/dev/null; do
    RETRY=$((RETRY + 1))
    if [ $RETRY -ge $MAX_RETRIES ]; then
        echo "[EMS] ERROR: Sliver server did not start within ${MAX_RETRIES}s"
        echo "[EMS] Checking if daemon process is still alive..."
        if kill -0 $SLIVER_PID 2>/dev/null; then
            echo "[EMS] Daemon is still running but gRPC not ready. Continuing to wait..."
            # Don't exit — keep waiting if daemon is alive
            wait $SLIVER_PID
        fi
        exit 1
    fi
    sleep 2
done
echo "[EMS] Sliver server is running (PID: $SLIVER_PID)"

# Generate operator config for EMS C2 Gateway if it doesn't exist
if [ ! -f "$OPERATOR_CONFIG" ]; then
    echo "[EMS] Generating EMS operator configuration..."
    mkdir -p "$(dirname "$OPERATOR_CONFIG")"
    $SLIVER_SERVER operator --name ems-gateway --lhost sliver-server --save "$OPERATOR_CONFIG" 2>/dev/null || true
    echo "[EMS] Operator config saved to $OPERATOR_CONFIG"
fi

echo "[EMS] Sliver C2 server is ready."
echo "[EMS] gRPC listening on :31337"

# Keep container alive — wait on the daemon process
wait $SLIVER_PID
