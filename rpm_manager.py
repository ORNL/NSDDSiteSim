import asyncio
import json
import logging
import os
from pathlib import Path
from typing import Dict, List, Optional, Set

from models import RPMConfig, RPMResponse, RPMStatus
from rpm_server import RPMServer
from simulator import VM250Config

logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
CONFIG_FILE = DATA_DIR / "rpms.json"


def _to_vm250_config(config: RPMConfig) -> VM250Config:
    return VM250Config(
        num_rpms=1,
        base_port=config.port,
        nominal_gamma_bg=config.nominal_gamma_bg,
        nominal_neutron_bg=config.nominal_neutron_bg,
        gamma_n_sigma=config.gamma_n_sigma,
        neutron_n_sigma=config.neutron_n_sigma,
        occupancy_frequency=config.occupancy_frequency,
        occupancy_duration_range=tuple(config.occupancy_duration_range),
        gamma_alarm_probability=config.gamma_alarm_probability,
        neutron_alarm_probability=config.neutron_alarm_probability,
        unique_alarm_probability=config.unique_alarm_probability,
        point_source_sigma=config.point_source_sigma,
        distributed_source_sigma=config.distributed_source_sigma,
        source_pos_length=config.source_pos_length,
        source_pos_width=config.source_pos_width,
        source_pos_height=config.source_pos_height,
        is_distributed=config.is_distributed,
    )


class RPMManager:
    def __init__(self):
        self.servers: Dict[str, RPMServer] = {}
        self.configs: Dict[str, dict] = {}
        self._stopped_ids: Set[str] = set()
        self._load_config()

    def _load_config(self):
        DATA_DIR.mkdir(exist_ok=True)
        if CONFIG_FILE.exists():
            try:
                with open(CONFIG_FILE, 'r') as f:
                    raw = json.load(f)
                for rpm_id, val in raw.items():
                    if isinstance(val, dict) and "config" in val and "running" in val:
                        # New format: {"config": {...}, "running": bool}
                        self.configs[rpm_id] = val["config"]
                        if not val.get("running", True):
                            self._stopped_ids.add(rpm_id)
                    else:
                        # Old format: {rpm_id: {...config...}} — treat as auto-start
                        self.configs[rpm_id] = val
            except Exception as e:
                logger.error(f"Failed to load RPM config: {e}")
                self.configs = {}

    def _save_config(self):
        DATA_DIR.mkdir(exist_ok=True)
        tmp = str(CONFIG_FILE) + ".tmp"
        data = {}
        for rpm_id, config in self.configs.items():
            data[rpm_id] = {"config": config, "running": rpm_id in self.servers}
        with open(tmp, 'w') as f:
            json.dump(data, f, indent=4)
        os.replace(tmp, CONFIG_FILE)

    async def add_rpm(self, rpm_id: str, config: RPMConfig) -> tuple[bool, str]:
        if rpm_id in self.servers:
            return False, "RPM ID already exists"

        vm_config = _to_vm250_config(config)
        server = RPMServer(rpm_id=rpm_id, port=config.port, config=vm_config)
        try:
            await server.start()
        except OSError as e:
            return False, f"Failed to bind port {config.port}: {e}"

        self.servers[rpm_id] = server
        self.configs[rpm_id] = config.model_dump()
        self._stopped_ids.discard(rpm_id)
        self._save_config()
        logger.info(f"Added RPM {rpm_id} ({config.name}) on port {config.port}")
        return True, "RPM started"

    async def stop_rpm(self, rpm_id: str) -> bool:
        if rpm_id not in self.servers:
            return False
        await self.servers[rpm_id].stop()
        del self.servers[rpm_id]
        self._stopped_ids.add(rpm_id)
        self._save_config()
        logger.info(f"Stopped RPM {rpm_id}")
        return True

    async def start_rpm(self, rpm_id: str) -> tuple[bool, str]:
        if rpm_id not in self.configs:
            return False, "RPM not found"
        if rpm_id in self.servers:
            return False, "RPM is already running"
        config = RPMConfig(**self.configs[rpm_id])
        return await self.add_rpm(rpm_id, config)

    def update_rpm(self, rpm_id: str, config: RPMConfig) -> tuple[bool, str]:
        if rpm_id not in self.configs:
            return False, "RPM not found"
        if rpm_id in self.servers:
            return False, "Stop the RPM before editing"
        self.configs[rpm_id] = config.model_dump()
        self._save_config()
        return True, "RPM config updated"

    async def remove_rpm(self, rpm_id: str) -> bool:
        if rpm_id in self.servers:
            await self.servers[rpm_id].stop()
            del self.servers[rpm_id]
        elif rpm_id not in self.configs:
            return False

        del self.configs[rpm_id]
        self._stopped_ids.discard(rpm_id)
        self._save_config()
        return True

    def get_status(self) -> List[dict]:
        result = []
        for rpm_id, config_dict in self.configs.items():
            running = rpm_id in self.servers
            result.append({
                "id": rpm_id,
                "name": config_dict["name"],
                "port": config_dict["port"],
                "running": running,
                "config": config_dict,
            })
        return result

    def get_rpm_status(self, rpm_id: str) -> Optional[dict]:
        if rpm_id not in self.servers:
            return None
        return self.servers[rpm_id].get_status()

    def trigger_alarm(self, rpm_id: str, gamma: bool = False, neutron: bool = False) -> bool:
        if rpm_id not in self.servers:
            return False
        self.servers[rpm_id].trigger_alarm(gamma=gamma, neutron=neutron)
        return True

    def set_fault(self, rpm_id: str, fault_type: str, active: bool) -> bool:
        if rpm_id not in self.servers:
            return False
        self.servers[rpm_id].set_fault(fault_type, active)
        return True

    def get_used_ports(self) -> set:
        return {cfg["port"] for cfg in self.configs.values()}

    async def start_all(self):
        for rpm_id in list(self.configs.keys()):
            if rpm_id not in self._stopped_ids:
                config = RPMConfig(**self.configs[rpm_id])
                ok, msg = await self.add_rpm(rpm_id, config)
                if not ok:
                    logger.error(f"Failed to restore RPM {rpm_id}: {msg}")

    async def stop_all(self):
        for server in list(self.servers.values()):
            await server.stop()
        self.servers.clear()
