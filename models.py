from pydantic import BaseModel
from typing import List, Optional, Tuple


class CameraConfig(BaseModel):
    name: str
    video_file: str
    port: int = 9001
    path: str
    resolution: Optional[str] = None  # e.g. "1280x720"
    framerate: Optional[int] = None


class CameraResponse(BaseModel):
    id: str
    name: str
    url: str
    running: bool
    config: CameraConfig


class RPMConfig(BaseModel):
    name: str
    port: int
    nominal_gamma_bg: float = 120.0
    nominal_neutron_bg: float = 2.0
    gamma_n_sigma: float = 4.0
    neutron_n_sigma: float = 7.0
    occupancy_frequency: float = 0.1
    occupancy_duration_range: Tuple[int, int] = (6, 10)
    gamma_alarm_probability: float = 0.05
    neutron_alarm_probability: float = 0.01
    unique_alarm_probability: float = 0.0
    point_source_sigma: float = 0.18
    distributed_source_sigma: float = 0.45
    source_pos_length: Optional[float] = None
    source_pos_width: Optional[float] = None
    source_pos_height: Optional[float] = None
    is_distributed: Optional[bool] = None

    # CSV-export metadata (not used by the simulator; persisted alongside config).
    # Defaults keep existing rpms.json files loadable without migration.
    unique_id: str = ""
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    eml_enabled: bool = False
    eml_collimated: bool = False
    lane_width: float = 4.7
    camera_ids: List[str] = []


class RPMResponse(BaseModel):
    id: str
    name: str
    port: int
    running: bool
    config: RPMConfig


class RPMStatus(BaseModel):
    id: str
    state: str  # "IDLE" or "OCCUPIED"
    connected_clients: int
    occupancy_count: int
    is_gamma_alarm: bool
    is_neutron_alarm: bool
    # Runtime-only fault toggles. Defaults make older snapshots /
    # tests that don't populate these fields backward-compatible.
    gh_fault: bool = False
    gl_fault: bool = False
    nh_fault: bool = False
    tamper_fault: bool = False
