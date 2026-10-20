import importlib.util
import json
from pathlib import Path
import subprocess
import sys

import pytest


ROOT = Path(__file__).resolve().parents[1]
GENERATOR = ROOT / "scripts" / "generate-rpm-only-config.py"
INSTALLER = ROOT / "scripts" / "install-rpm-only-systemd.sh"


def load_generator():
    spec = importlib.util.spec_from_file_location("rpm_only_config", GENERATOR)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_builds_canonical_50_rpm_fixture():
    config = load_generator().build_config(50, 10001)

    assert list(config) == [f"rpm-{index:02d}" for index in range(1, 51)]
    assert config["rpm-01"]["config"]["name"] == "RPM 01"
    assert config["rpm-01"]["config"]["port"] == 10001
    assert config["rpm-50"]["config"]["port"] == 10050
    assert all(item["running"] is True for item in config.values())


@pytest.mark.parametrize(
    ("count", "base_port"),
    [(0, 10001), (1, 0), (2, 65535)],
)
def test_rejects_invalid_ranges(count, base_port):
    with pytest.raises(ValueError):
        load_generator().build_config(count, base_port)


def test_cli_writes_atomically_and_refuses_unacknowledged_replacement(tmp_path):
    output = tmp_path / "rpms.json"
    command = [
        sys.executable,
        str(GENERATOR),
        "--output",
        str(output),
        "--count",
        "3",
        "--base-port",
        "12001",
    ]

    first = subprocess.run(command, check=False, capture_output=True, text=True)
    second = subprocess.run(command, check=False, capture_output=True, text=True)

    assert first.returncode == 0
    assert second.returncode == 2
    assert "already exists" in second.stderr
    data = json.loads(output.read_text(encoding="utf-8"))
    assert [item["config"]["port"] for item in data.values()] == [12001, 12002, 12003]
    assert not list(tmp_path.glob(".rpms.json.tmp-*"))


def test_installer_keeps_the_validated_restart_and_resource_policy():
    installer = INSTALLER.read_text(encoding="utf-8")

    for required in (
        "Restart=always",
        "RestartSec=5",
        "StartLimitIntervalSec=60",
        "StartLimitBurst=10",
        "MemoryHigh=${MEMORY_HIGH}",
        "MemoryMax=${MEMORY_MAX}",
        "TasksMax=${TASKS_MAX}",
        "NoNewPrivileges=true",
        "ProtectSystem=full",
        "PrivateTmp=true",
    ):
        assert required in installer
