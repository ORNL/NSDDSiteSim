import json
import logging
import os
from pathlib import Path
from typing import Dict, List, Optional, Set

from models import MobileConfig
from mobile_server import D5Server, MobileServerBase, RS350Server

logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
CONFIG_FILE = DATA_DIR / "mobiles.json"

_SERVER_TYPES = {"rs350": RS350Server, "d5": D5Server}
_SERIAL_PREFIX = {"rs350": "RS350", "d5": "D5"}


class MobileManager:
    def __init__(self):
        self.servers: Dict[str, MobileServerBase] = {}
        self.configs: Dict[str, dict] = {}
        self._stopped_ids: Set[str] = set()
        self._load_config()

    def _load_config(self):
        DATA_DIR.mkdir(exist_ok=True)
        if CONFIG_FILE.exists():
            try:
                with open(CONFIG_FILE, 'r') as f:
                    raw = json.load(f)
                for mobile_id, val in raw.items():
                    self.configs[mobile_id] = val["config"]
                    if not val.get("running", True):
                        self._stopped_ids.add(mobile_id)
            except Exception as e:
                logger.error(f"Failed to load mobile detector config: {e}")
                self.configs = {}

    def _save_config(self):
        DATA_DIR.mkdir(exist_ok=True)
        tmp = str(CONFIG_FILE) + ".tmp"
        data = {}
        for mobile_id, config in self.configs.items():
            data[mobile_id] = {"config": config, "running": mobile_id in self.servers}
        with open(tmp, 'w') as f:
            json.dump(data, f, indent=4)
        os.replace(tmp, CONFIG_FILE)

    async def add_mobile(self, mobile_id: str, config: MobileConfig) -> tuple[bool, str]:
        if mobile_id in self.servers:
            return False, "Mobile detector ID already exists"

        cfg = config.model_dump()
        if not cfg["serial"].strip():
            cfg["serial"] = f"{_SERIAL_PREFIX[cfg['detector_type']]}-{mobile_id.upper()}"

        server = _SERVER_TYPES[cfg["detector_type"]](mobile_id, cfg)
        try:
            await server.start()
        except OSError as e:
            return False, f"Failed to bind port {cfg['port']}: {e}"

        self.servers[mobile_id] = server
        self.configs[mobile_id] = cfg
        self._stopped_ids.discard(mobile_id)
        self._save_config()
        logger.info(f"Added mobile {mobile_id} ({cfg['name']}, {cfg['detector_type']}) on port {cfg['port']}")
        return True, "Mobile detector started"

    async def stop_mobile(self, mobile_id: str) -> bool:
        if mobile_id not in self.servers:
            return False
        await self.servers[mobile_id].stop()
        del self.servers[mobile_id]
        self._stopped_ids.add(mobile_id)
        self._save_config()
        logger.info(f"Stopped mobile {mobile_id}")
        return True

    async def start_mobile(self, mobile_id: str) -> tuple[bool, str]:
        if mobile_id not in self.configs:
            return False, "Mobile detector not found"
        if mobile_id in self.servers:
            return False, "Mobile detector is already running"
        config = MobileConfig(**self.configs[mobile_id])
        return await self.add_mobile(mobile_id, config)

    def update_mobile(self, mobile_id: str, config: MobileConfig) -> tuple[bool, str]:
        if mobile_id not in self.configs:
            return False, "Mobile detector not found"
        if mobile_id in self.servers:
            return False, "Stop the mobile detector before editing"
        self.configs[mobile_id] = config.model_dump()
        self._save_config()
        return True, "Mobile detector config updated"

    async def remove_mobile(self, mobile_id: str) -> bool:
        if mobile_id in self.servers:
            await self.servers[mobile_id].stop()
            del self.servers[mobile_id]
        elif mobile_id not in self.configs:
            return False

        del self.configs[mobile_id]
        self._stopped_ids.discard(mobile_id)
        self._save_config()
        return True

    def get_status(self) -> List[dict]:
        result = []
        for mobile_id, config_dict in self.configs.items():
            result.append({
                "id": mobile_id,
                "name": config_dict["name"],
                "port": config_dict["port"],
                "detector_type": config_dict["detector_type"],
                "running": mobile_id in self.servers,
                "config": config_dict,
            })
        return result

    def get_mobile_status(self, mobile_id: str) -> Optional[dict]:
        if mobile_id not in self.servers:
            return None
        return self.servers[mobile_id].get_status()

    def trigger_alarm(self, mobile_id: str, isotope: Optional[str] = None) -> Optional[bool]:
        """None if not running; else whether a new episode was started
        (False = an episode is already in progress)."""
        if mobile_id not in self.servers:
            return None
        return self.servers[mobile_id].trigger_alarm(isotope)

    def get_used_ports(self) -> set:
        return {cfg["port"] for cfg in self.configs.values()}

    async def start_all(self):
        for mobile_id in list(self.configs.keys()):
            if mobile_id not in self._stopped_ids:
                config = MobileConfig(**self.configs[mobile_id])
                ok, msg = await self.add_mobile(mobile_id, config)
                if not ok:
                    logger.error(f"Failed to restore mobile {mobile_id}: {msg}")

    async def stop_all(self):
        for server in list(self.servers.values()):
            await server.stop()
        self.servers.clear()
