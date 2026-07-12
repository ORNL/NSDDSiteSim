import math

from pydantic import BaseModel, field_validator, model_validator
from typing import List, Literal, Optional, Tuple


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


# Default patrol route: loop connecting the four Arlington site gates
# (Memorial Ave -> AFM -> Selfridge -> Marshall), from the RS-350/D5 spec.
DEFAULT_MOBILE_ROUTE: List[Tuple[float, float]] = [
    (38.88340, -77.06653),
    (38.87890, -77.06580),
    (38.87310, -77.06520),
    (38.86782, -77.06666),
    (38.86940, -77.07230),
    (38.87678, -77.07849),
    (38.88210, -77.07360),
    (38.88773, -77.06768),
    (38.88560, -77.06600),
]

_M_PER_DEG_LAT = 111_320.0


class MobileConfig(BaseModel):
    name: str
    detector_type: Literal["rs350", "d5"]
    port: int
    serial: str = ""  # blank -> manager derives RS350-<id> / D5-<id>
    speed_mps: float = 1.4
    route: List[Tuple[float, float]] = DEFAULT_MOBILE_ROUTE
    background_gamma_cps: float = 1200.0
    background_neutron_cps: float = 0.4
    alarm_factor: float = 1.6
    alarm_interval_s: float = 300.0  # mean seconds between alarm episodes; 0 = manual-only
    alarm_duration_s: float = 25.0   # seconds above alarm threshold per episode
    isotope: str = "Cs-137"

    @field_validator("port")
    @classmethod
    def _port_range(cls, v):
        if not (1 <= v <= 65535):
            raise ValueError("port must be 1-65535")
        return v

    @field_validator("speed_mps")
    @classmethod
    def _speed_positive(cls, v):
        if v <= 0:
            raise ValueError("speed_mps must be > 0")
        return v

    @field_validator("alarm_factor")
    @classmethod
    def _factor_gt_one(cls, v):
        if v <= 1.0:
            raise ValueError("alarm_factor must be > 1.0")
        return v

    @field_validator("background_gamma_cps")
    @classmethod
    def _bg_positive(cls, v):
        if v <= 0:
            raise ValueError("background_gamma_cps must be > 0")
        return v

    @field_validator("background_neutron_cps")
    @classmethod
    def _bg_n_nonneg(cls, v):
        if v < 0:
            raise ValueError("background_neutron_cps must be >= 0")
        return v

    @field_validator("alarm_duration_s")
    @classmethod
    def _duration_min(cls, v):
        if v < 3:
            raise ValueError("alarm_duration_s must be >= 3")
        return v

    @field_validator("alarm_interval_s")
    @classmethod
    def _interval_nonneg(cls, v):
        if v < 0:
            raise ValueError("alarm_interval_s must be >= 0 (0 disables scheduled alarms)")
        return v

    @model_validator(mode="after")
    def _route_sane(self):
        if len(self.route) < 2:
            raise ValueError("route needs at least 2 waypoints")
        for lat, lon in self.route:
            if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                raise ValueError(f"waypoint out of range: {lat}, {lon}")
        total = 0.0
        pts = self.route
        for i in range(len(pts)):
            a, b = pts[i], pts[(i + 1) % len(pts)]
            dy = (b[0] - a[0]) * _M_PER_DEG_LAT
            dx = (b[1] - a[1]) * _M_PER_DEG_LAT * math.cos(math.radians(a[0]))
            total += math.hypot(dx, dy)
        if total <= 10.0:
            raise ValueError("route loop is shorter than 10 m — spread the waypoints out")
        return self


class MobileResponse(BaseModel):
    id: str
    name: str
    port: int
    detector_type: str
    running: bool
    config: MobileConfig


class MobileStatus(BaseModel):
    id: str
    detector_type: str
    connected_clients: int
    latitude: float
    longitude: float
    alarming: bool
    isotope: str
    alarm_count: int
    battery_pct: float
    gamma_cps: int


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
