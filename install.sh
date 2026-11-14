#!/bin/bash
set -e

INSTALL_DIR="/opt/lanesim"
SERVICE_NAME="lanesim"
SERVICE_USER="lanesim"
MEDIAMTX_VERSION="v1.9.0"
# Timezone the service runs in — drives RPM traffic-profile hours and weekdays.
SITE_TZ="${SITE_TZ:-America/New_York}"
LANESIM_PORT="${LANESIM_PORT:-8000}"

echo "=== Lane Simulator Install ==="

# 1. System dependencies
apt-get update -qq
apt-get install -y ffmpeg python3-pip python3-venv wget tar

# 2. Create service user
if ! id "$SERVICE_USER" &>/dev/null; then
    useradd -r -s /usr/sbin/nologin -d "$INSTALL_DIR" "$SERVICE_USER"
fi

# 3. Create directory structure
mkdir -p "$INSTALL_DIR"/{data,logs,videos,bin,static,routers}

# 4. Copy application files
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cp "$SCRIPT_DIR"/*.py "$INSTALL_DIR/"
cp -r "$SCRIPT_DIR/routers" "$INSTALL_DIR/"
cp -r "$SCRIPT_DIR/static" "$INSTALL_DIR/"
cp "$SCRIPT_DIR/requirements.txt" "$INSTALL_DIR/"

# Copy video files if present alongside the installer
if [ -d "$SCRIPT_DIR/videos" ]; then
    cp -n "$SCRIPT_DIR/videos/"* "$INSTALL_DIR/videos/" 2>/dev/null || true
fi

# 5. Download MediaMTX binary
if [ ! -f "$INSTALL_DIR/bin/mediamtx" ]; then
    ARCH_RAW="$(uname -m)"
    case "$ARCH_RAW" in
        x86_64|amd64) MTX_ARCH="amd64" ;;
        aarch64|arm64) MTX_ARCH="arm64v8" ;;
        armv7l|armv7*) MTX_ARCH="armv7" ;;
        *) echo "Unsupported architecture for MediaMTX: $ARCH_RAW" >&2; exit 1 ;;
    esac
    echo "Downloading MediaMTX $MEDIAMTX_VERSION ($MTX_ARCH)..."
    URL="https://github.com/bluenviron/mediamtx/releases/download/${MEDIAMTX_VERSION}/mediamtx_${MEDIAMTX_VERSION}_linux_${MTX_ARCH}.tar.gz"
    wget -q "$URL" -O /tmp/mediamtx.tar.gz
    tar -xzf /tmp/mediamtx.tar.gz -C "$INSTALL_DIR/bin/" mediamtx
    rm /tmp/mediamtx.tar.gz
    chmod +x "$INSTALL_DIR/bin/mediamtx"
    echo "MediaMTX installed."
fi

# 6. Python virtual environment
python3 -m venv "$INSTALL_DIR/venv"
"$INSTALL_DIR/venv/bin/pip" install --quiet -r "$INSTALL_DIR/requirements.txt"

# 7. Fix ownership
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"

# 8. Systemd service
cat > /etc/systemd/system/${SERVICE_NAME}.service << EOF
[Unit]
Description=Lane Simulator (Camera + RPM Portal Monitor)
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}
# RPM traffic profiles are keyed to wall-clock hour and weekday, so the service
# needs the site's local time rather than the host's (this box runs Etc/UTC).
# Override with SITE_TZ=... when installing at a site in another timezone.
Environment=TZ=${SITE_TZ}
Environment=LANESIM_PORT=${LANESIM_PORT}
ExecStart=${INSTALL_DIR}/venv/bin/python3 ${INSTALL_DIR}/main.py
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"

echo ""
echo "=== Installation complete ==="
echo "Start:   systemctl start $SERVICE_NAME"
echo "Logs:    journalctl -u $SERVICE_NAME -f"
echo "Web UI:  http://<host>:8000"
