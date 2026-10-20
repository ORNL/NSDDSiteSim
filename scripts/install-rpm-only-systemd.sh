#!/usr/bin/env bash
set -Eeuo pipefail

# Reproducible, ARM-safe deployment for an RPM-only OSCAR test emulator.
# Configure with environment variables documented in README.md.

readonly SERVICE_NAME="${SERVICE_NAME:-lanesim}"
readonly SERVICE_USER="${SERVICE_USER:-lanesim}"
readonly INSTALL_DIR="${INSTALL_DIR:-/opt/lanesim}"
readonly SITE_TZ="${SITE_TZ:-America/New_York}"
readonly RPM_COUNT="${RPM_COUNT:-50}"
readonly RPM_BASE_PORT="${RPM_BASE_PORT:-10001}"
readonly MEMORY_HIGH="${MEMORY_HIGH:-512M}"
readonly MEMORY_MAX="${MEMORY_MAX:-768M}"
readonly TASKS_MAX="${TASKS_MAX:-256}"
readonly ALLOW_EXISTING_INSTALL="${ALLOW_EXISTING_INSTALL:-0}"
readonly REPLACE_RPM_CONFIG="${REPLACE_RPM_CONFIG:-0}"
readonly START_SERVICE="${START_SERVICE:-1}"

fail() {
    printf 'error: %s\n' "$*" >&2
    exit 1
}

require_boolean() {
    case "$2" in
        0|1) ;;
        *) fail "$1 must be 0 or 1" ;;
    esac
}

[[ "${EUID}" -eq 0 ]] || fail "run this installer as root"
[[ -f /etc/os-release ]] || fail "this installer requires a systemd Linux host"
command -v systemctl >/dev/null 2>&1 || fail "systemd is required"
command -v apt-get >/dev/null 2>&1 || fail "a Debian/Ubuntu host with apt-get is required"
[[ "${INSTALL_DIR}" == /* && "${INSTALL_DIR}" != "/" ]] || fail "INSTALL_DIR must be an absolute non-root path"
[[ "${INSTALL_DIR}" =~ ^/[A-Za-z0-9._/-]+$ ]] || fail "INSTALL_DIR contains characters unsafe for a systemd unit"
[[ "${SERVICE_NAME}" =~ ^[A-Za-z0-9_.@-]+$ ]] || fail "SERVICE_NAME contains unsafe characters"
[[ "${SERVICE_USER}" =~ ^[a-z_][a-z0-9_-]*[$]?$ ]] || fail "SERVICE_USER is not a valid system account name"
[[ "${SITE_TZ}" =~ ^[A-Za-z0-9._+-]+(/[A-Za-z0-9._+-]+)*$ ]] || fail "SITE_TZ contains unsafe characters"
[[ "${RPM_COUNT}" =~ ^[0-9]+$ ]] || fail "RPM_COUNT must be a positive integer"
[[ "${RPM_BASE_PORT}" =~ ^[0-9]+$ ]] || fail "RPM_BASE_PORT must be an integer"
[[ "${MEMORY_HIGH}" =~ ^[0-9]+[KMGTP]$ ]] || fail "MEMORY_HIGH must be a systemd size such as 512M"
[[ "${MEMORY_MAX}" =~ ^[0-9]+[KMGTP]$ ]] || fail "MEMORY_MAX must be a systemd size such as 768M"
[[ "${TASKS_MAX}" =~ ^[0-9]+$ ]] || fail "TASKS_MAX must be a positive integer"
(( RPM_COUNT >= 1 )) || fail "RPM_COUNT must be at least 1"
(( RPM_BASE_PORT >= 1 && RPM_BASE_PORT + RPM_COUNT - 1 <= 65535 )) || fail "requested RPM port range is invalid"
(( TASKS_MAX >= 1 )) || fail "TASKS_MAX must be at least 1"
require_boolean ALLOW_EXISTING_INSTALL "${ALLOW_EXISTING_INSTALL}"
require_boolean REPLACE_RPM_CONFIG "${REPLACE_RPM_CONFIG}"
require_boolean START_SERVICE "${START_SERVICE}"

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SOURCE_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
[[ -f "${SOURCE_DIR}/main.py" && -f "${SOURCE_DIR}/requirements.txt" ]] || fail "run the installer from a complete NSDDSiteSim checkout"
[[ ! -L "${INSTALL_DIR}" ]] || fail "refusing a symlinked INSTALL_DIR"

backup_dir=""
if [[ -e "${INSTALL_DIR}" ]]; then
    [[ -d "${INSTALL_DIR}" ]] || fail "INSTALL_DIR exists but is not a directory"
    [[ "${ALLOW_EXISTING_INSTALL}" == "1" ]] || fail "${INSTALL_DIR} already exists; set ALLOW_EXISTING_INSTALL=1 after reviewing it"
    backup_dir="${INSTALL_DIR}.pre-rpm-only.$(date -u +%Y%m%dT%H%M%SZ)"
    [[ ! -e "${backup_dir}" ]] || fail "backup destination already exists: ${backup_dir}"
    systemctl stop "${SERVICE_NAME}.service" 2>/dev/null || true
    cp -a -- "${INSTALL_DIR}" "${backup_dir}"
    printf 'Preserved existing installation at %s\n' "${backup_dir}"
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends ca-certificates python3 python3-pip python3-venv

if ! getent group "${SERVICE_USER}" >/dev/null; then
    groupadd --system "${SERVICE_USER}"
fi
if ! getent passwd "${SERVICE_USER}" >/dev/null; then
    useradd --system --gid "${SERVICE_USER}" --shell /usr/sbin/nologin --home-dir "${INSTALL_DIR}" "${SERVICE_USER}"
fi
[[ "$(id -gn "${SERVICE_USER}")" == "${SERVICE_USER}" ]] || fail "existing ${SERVICE_USER} account does not use the expected primary group"

install -d -o root -g root -m 0755 "${INSTALL_DIR}"
install -d -o "${SERVICE_USER}" -g "${SERVICE_USER}" -m 0750 \
    "${INSTALL_DIR}/data" "${INSTALL_DIR}/logs" "${INSTALL_DIR}/videos"

install -o root -g root -m 0644 "${SOURCE_DIR}"/*.py "${INSTALL_DIR}/"
rm -rf -- "${INSTALL_DIR}/routers" "${INSTALL_DIR}/static"
cp -a -- "${SOURCE_DIR}/routers" "${SOURCE_DIR}/static" "${INSTALL_DIR}/"
chown -R root:root "${INSTALL_DIR}/routers" "${INSTALL_DIR}/static"
find "${INSTALL_DIR}/routers" "${INSTALL_DIR}/static" -type d -exec chmod 0755 {} +
find "${INSTALL_DIR}/routers" "${INSTALL_DIR}/static" -type f -exec chmod 0644 {} +
install -o root -g root -m 0644 "${SOURCE_DIR}/requirements.txt" "${INSTALL_DIR}/requirements.txt"

rm -rf -- "${INSTALL_DIR}/venv"
python3 -m venv "${INSTALL_DIR}/venv"
"${INSTALL_DIR}/venv/bin/pip" install --disable-pip-version-check --no-input --requirement "${INSTALL_DIR}/requirements.txt"

config_path="${INSTALL_DIR}/data/rpms.json"
replace_args=()
if [[ -e "${config_path}" ]]; then
    if [[ "${REPLACE_RPM_CONFIG}" == "1" ]]; then
        replace_args+=(--replace)
    else
        "${INSTALL_DIR}/venv/bin/python3" - "${config_path}" "${RPM_COUNT}" "${RPM_BASE_PORT}" <<'PY'
import json
from pathlib import Path
import sys

path = Path(sys.argv[1])
count = int(sys.argv[2])
base_port = int(sys.argv[3])
data = json.loads(path.read_text(encoding="utf-8"))
expected_ports = list(range(base_port, base_port + count))
actual_ports = sorted(item["config"]["port"] for item in data.values())
running = sum(item.get("running") is True for item in data.values())
if len(data) != count or actual_ports != expected_ports or running != count:
    raise SystemExit(
        f"existing {path} is not the requested {count}-RPM running fixture on "
        f"ports {base_port}-{base_port + count - 1}; preserve it and set REPLACE_RPM_CONFIG=1 to replace it"
    )
PY
        printf 'Preserving existing validated RPM configuration at %s\n' "${config_path}"
    fi
fi

if [[ ! -e "${config_path}" || "${REPLACE_RPM_CONFIG}" == "1" ]]; then
    PYTHONPATH="${INSTALL_DIR}" "${INSTALL_DIR}/venv/bin/python3" \
        "${SOURCE_DIR}/scripts/generate-rpm-only-config.py" \
        --output "${config_path}" \
        --count "${RPM_COUNT}" \
        --base-port "${RPM_BASE_PORT}" \
        "${replace_args[@]}"
fi
chown "${SERVICE_USER}:${SERVICE_USER}" "${config_path}"
chmod 0640 "${config_path}"

unit_tmp="$(mktemp)"
trap 'rm -f -- "${unit_tmp}"' EXIT
cat >"${unit_tmp}" <<EOF
[Unit]
Description=Lane Simulator - RPM monitors only
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=10

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}
Environment=PYTHONUNBUFFERED=1
Environment=PYTHONDONTWRITEBYTECODE=1
Environment=TZ=${SITE_TZ}
ExecStart=${INSTALL_DIR}/venv/bin/python3 ${INSTALL_DIR}/main.py
Restart=always
RestartSec=5
TimeoutStopSec=20
KillMode=mixed
UMask=0027
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=${INSTALL_DIR}/data ${INSTALL_DIR}/logs ${INSTALL_DIR}/videos
MemoryHigh=${MEMORY_HIGH}
MemoryMax=${MEMORY_MAX}
TasksMax=${TASKS_MAX}
LimitNOFILE=4096
Nice=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
install -o root -g root -m 0644 "${unit_tmp}" "/etc/systemd/system/${SERVICE_NAME}.service"
systemd-analyze verify "/etc/systemd/system/${SERVICE_NAME}.service"
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}.service"

if [[ "${START_SERVICE}" == "1" ]]; then
    systemctl restart "${SERVICE_NAME}.service"
    "${INSTALL_DIR}/venv/bin/python3" - "${RPM_COUNT}" "${RPM_BASE_PORT}" <<'PY'
import json
import sys
import time
from urllib.request import urlopen

expected_count = int(sys.argv[1])
base_port = int(sys.argv[2])
deadline = time.monotonic() + max(45, expected_count * 2)
last_error = "service did not respond"
while time.monotonic() < deadline:
    try:
        with urlopen("http://127.0.0.1:8000/api/rpms", timeout=3) as response:
            data = json.load(response)
        ports = sorted(item["port"] for item in data)
        if len(data) == expected_count and ports == list(range(base_port, base_port + expected_count)) and all(item["running"] for item in data):
            print(f"Verified {expected_count}/{expected_count} RPMs running after service start")
            break
        last_error = f"observed {len(data)} configured and {sum(bool(item['running']) for item in data)} running"
    except Exception as error:  # service may still be starting sequential listeners
        last_error = str(error)
    time.sleep(1)
else:
    raise SystemExit(f"RPM-only service failed post-start verification: {last_error}")
PY
fi

printf '\nRPM-only installation complete.\n'
printf 'Service: systemctl status %s.service\n' "${SERVICE_NAME}"
printf 'Logs:   journalctl -u %s.service -f\n' "${SERVICE_NAME}"
printf 'Web UI: http://<host>:8000\n'
if [[ -n "${backup_dir}" ]]; then
    printf 'Backup: %s\n' "${backup_dir}"
fi
