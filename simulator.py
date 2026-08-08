import random
import math
import time
from dataclasses import dataclass
from typing import List, Optional, Tuple

@dataclass
class VM250Config:
    num_rpms: int
    base_port: int
    nominal_gamma_bg: float
    nominal_neutron_bg: float
    gamma_n_sigma: float
    neutron_n_sigma: float
    occupancy_frequency: float
    occupancy_duration_range: Tuple[int, int]
    gamma_alarm_probability: float
    neutron_alarm_probability: float
    unique_alarm_probability: float = 0.0
    point_source_sigma: float = 0.18
    distributed_source_sigma: float = 0.45
    # Optional fixed positioning (0.0 to 1.0)
    source_pos_length: float = None
    source_pos_width: float = None
    source_pos_height: float = None
    is_distributed: bool = None
    # Traffic profile (see RPMConfig). None or a wrong-length list is treated as
    # flat, so a config built directly without these behaves exactly as before.
    occupancy_schedule_enabled: bool = False
    occupancy_hour_factors: Optional[List[float]] = None  # 24 entries, local hour
    occupancy_day_factors: Optional[List[float]] = None   # 7 entries, 0=Mon (tm_wday)

class VM250Simulator:
    def __init__(self, rpm_id: int, config: VM250Config):
        self.rpm_id = rpm_id
        self.config = config
        self.state = "IDLE"  # IDLE, OCCUPIED
        self.occupancy_end_time = 0
        self.occupancy_start_time = 0
        self.is_gamma_alarm = False
        self.is_neutron_alarm = False
        self.gamma_alarm_latched = False
        self.neutron_alarm_latched = False

        # Runtime-only fault toggles (manual UI triggers, not persisted in
        # RPMConfig). GH/GL/NH pulse every 5s on their own timer while active;
        # tamper is a one-shot pair (TT on assert, TC on clear).
        self.gh_fault = False
        self.gl_fault = False
        self.nh_fault = False
        self.tamper_fault = False
        self.last_fault_pulse = 0.0
        self._pending_tamper_msg: Optional[str] = None

        # Unique alarm geometry
        self.occ_is_unique = False
        self.occ_source_pos_length = 0.5
        self.occ_source_pos_width = 0.5
        self.occ_source_pos_height = 0.5
        self.occ_source_sigma = config.point_source_sigma
        self.occ_is_distributed = False

        
        # Internal background averages (for threshold calculation)
        self.gamma_bg_avg = config.nominal_gamma_bg
        self.neutron_bg_avg = config.nominal_neutron_bg
        
        # Counters for GX messages (calculate starting values as if running since midnight)
        now = time.localtime()
        seconds_since_midnight = now.tm_hour * 3600 + now.tm_min * 60 + now.tm_sec
        
        # Estimate occupancy count based on frequency (checked every 5s). With a
        # traffic profile we integrate across the hours of today already elapsed
        # — a flat sum would credit rush-hour volume to the small hours. The
        # unscheduled branch is left exactly as it was.
        if not config.occupancy_schedule_enabled:
            bg_cycles = seconds_since_midnight // 5
            self.occupancy_count = int(bg_cycles * config.occupancy_frequency) % 1000000
        else:
            expected = 0.0
            for hour in range(now.tm_hour + 1):
                secs = 3600 if hour < now.tm_hour else (now.tm_min * 60 + now.tm_sec)
                expected += (secs / 5.0) * self._effective_frequency(hour, now.tm_wday)
            self.occupancy_count = int(expected) % 1000000
        
        # Estimate cumulative neutron pulses
        self.neutron_cumulative = int(seconds_since_midnight * config.nominal_neutron_bg) % 1000000
        
        # Last pulse times
        self.last_bg_pulse = 0
        self.last_gamma_scan_pulse = 0
        self.last_neutron_scan_pulse = 0
        
        self.last_day = now.tm_yday

    def _poisson_sample(self, mean: float) -> int:
        if mean <= 0: return 0
        if mean > 30:
            # Normal approximation for speed and stability
            val = int(random.gauss(mean, math.sqrt(mean)) + 0.5)
            return max(0, val)
        else:
            # Knuth's algorithm for small mean
            L = math.exp(-mean)
            k = 0
            p = 1.0
            while p > L:
                k += 1
                p *= random.random()
            return k - 1

    def _generate_counts(self, nominal: float, is_alarm: bool, interval_sec: float, progress: float = -1, n_sigma: float = 4.0) -> List[int]:
        """Generates counts for 4 detector fields with Poisson variation and pulse/shielding logic."""
        base_mean = (nominal * interval_sec) / 4.0
        
        # 1. Background Suppression (Shielding)
        shielding_multiplier = 1.0
        if 0.0 <= progress <= 1.0:
            shielding_multiplier = 1.0 - (0.25 * math.exp(-((progress - 0.5)**2) / (2 * 0.25**2)))
        
        current_mean = base_mean * shielding_multiplier
        
        # Initialize counts for each of the 4 detectors
        means = [current_mean] * 4
        
        # 2. Alarm Signal (Gaussian Pulse)
        if is_alarm and 0.0 <= progress <= 1.0:
            # Calculate threshold for reference
            threshold = base_mean + (n_sigma * math.sqrt(base_mean))
            # Peak signal at 2.5x threshold for clear alarming
            peak_total = threshold * 2.5
            
            # Determine geometry
            if self.occ_is_unique:
                L = self.occ_source_pos_length
                W = self.occ_source_pos_width
                H = self.occ_source_pos_height
                sigma = self.occ_source_sigma
            else:
                L = 0.5
                W = 0.5
                H = 0.5
                sigma = self.config.point_source_sigma

            # Spatial weights for 4 detectors:
            # 0: Driver Bottom, 1: Driver Top, 2: Passenger Bottom, 3: Passenger Top
            weights = [
                (1.0 - W) * (1.0 - H), # 0
                (1.0 - W) * H,         # 1
                W * (1.0 - H),         # 2
                W * H                  # 3
            ]
            
            # Temporal/Length Gaussian pulse
            amplitude = peak_total
            if self.occ_is_distributed:
                # Reduce peak by 30% if distributed to make it "flatter"
                amplitude *= 0.7
                
            pulse = amplitude * math.exp(-((progress - L)**2) / (2 * sigma**2))
            
            # Apply weighted signal to each detector
            # multiplying by 4 because peak_total was originally per-detector (total alarm was 4*peak_total)
            for i in range(4):
                means[i] += pulse * weights[i] * 4.0
            
        return [self._poisson_sample(m) for m in means]

    def _effective_frequency(self, hour: int, wday: int) -> float:
        """Per-5s occupancy roll probability at a local wall-clock hour/weekday.

        Schedule off — or factor lists that are missing or the wrong length —
        returns the flat configured value, reproducing pre-schedule behaviour.
        The roll is `random.random() < p` and random() is [0.0, 1.0), so p<=0
        never fires and p>=1.0 always does; clamping here just keeps the number
        the status endpoint reports honest.
        """
        cfg = self.config
        if not cfg.occupancy_schedule_enabled:
            return cfg.occupancy_frequency
        p = cfg.occupancy_frequency
        hours = cfg.occupancy_hour_factors
        days = cfg.occupancy_day_factors
        if hours and len(hours) == 24:
            p *= hours[hour]
        if days and len(days) == 7:
            p *= days[wday]
        return min(1.0, max(0.0, p))

    def effective_occupancy_frequency(self) -> float:
        """The probability in force right now — for the status endpoint."""
        lt = time.localtime()
        return self._effective_frequency(lt.tm_hour, lt.tm_wday)

    def update(self) -> List[str]:
        """Updates the state machine and returns a list of messages to send."""
        now = time.time()
        
        local_now = time.localtime(now)
        if self.last_day != local_now.tm_yday:
            self.occupancy_count = 0
            self.neutron_cumulative = 0
            self.last_day = local_now.tm_yday

        messages = []

        # 1. Handle State Transitions
        if self.state == "OCCUPIED":
            if now >= self.occupancy_end_time:
                # End occupancy. Alarms latch only "for the rest of the
                # occupancy" — clear all four flags here so the status endpoint
                # doesn't report a stale ALARM during the IDLE gap before the
                # next occupancy starts. (The next occupancy re-rolls them.)
                self.state = "IDLE"
                self.is_gamma_alarm = False
                self.is_neutron_alarm = False
                self.gamma_alarm_latched = False
                self.neutron_alarm_latched = False
                self.last_bg_pulse = now
                # GX message: ID, NeutronSum, 0, 0
                messages.append(f"GX,{self.occupancy_count:06},{self.neutron_cumulative:06},000000,000000\r\n")

        if self.state == "IDLE":
            # Check for new occupancy (only if we didn't just end one in this call, or allow it)
            # If we just sent a GX, we might want to wait at least one cycle, 
            # but usually occupancy checks happen at BG pulse intervals.
            if now - self.last_bg_pulse >= 5.0:
                # We only roll for new occupancy during the 5s window. The
                # traffic-profile lookup reuses local_now from the top of
                # update(), so no second localtime() call in the hot path.
                if random.random() < self._effective_frequency(local_now.tm_hour, local_now.tm_wday):
                    self.state = "OCCUPIED"
                    self.occupancy_count = (self.occupancy_count + 1) % 1000000
                    duration = random.randint(*self.config.occupancy_duration_range)
                    self.occupancy_start_time = now
                    self.occupancy_end_time = now + duration
                    self.is_gamma_alarm = random.random() < self.config.gamma_alarm_probability
                    self.is_neutron_alarm = random.random() < self.config.neutron_alarm_probability
                    self.gamma_alarm_latched = False
                    self.neutron_alarm_latched = False
                    
                    # Randomize geometry
                    self.occ_is_unique = random.random() < self.config.unique_alarm_probability
                    if self.occ_is_unique:
                        # Use config overrides if provided, otherwise randomize
                        self.occ_is_distributed = self.config.is_distributed if self.config.is_distributed is not None else (random.random() < 0.3)
                        self.occ_source_sigma = self.config.distributed_source_sigma if self.occ_is_distributed else self.config.point_source_sigma
                        
                        self.occ_source_pos_length = self.config.source_pos_length if self.config.source_pos_length is not None else random.uniform(0.2, 0.8)
                        self.occ_source_pos_width = self.config.source_pos_width if self.config.source_pos_width is not None else random.uniform(0.0, 1.0)
                        self.occ_source_pos_height = self.config.source_pos_height if self.config.source_pos_height is not None else random.uniform(0.0, 1.0)
                    else:
                        self.occ_is_distributed = False
                        self.occ_source_sigma = self.config.point_source_sigma
                        self.occ_source_pos_length = 0.5
                        self.occ_source_pos_width = 0.5
                        self.occ_source_pos_height = 0.5
                    
                    # Trigger immediate scans
                    self.last_gamma_scan_pulse = now - 0.2
                    self.last_neutron_scan_pulse = now - 1.0

        # 2. Generate Data for Current State
        if self.state == "IDLE":
            if now - self.last_bg_pulse >= 5.0:
                self.last_bg_pulse = now
                # GH or GL fault active → suppress GB (the fault pulse below
                # takes its place). NH fault active → suppress NB. The cumulative
                # neutron counter only advances on a real NB measurement.
                if not (self.gh_fault or self.gl_fault):
                    g_counts = self._generate_counts(self.config.nominal_gamma_bg, False, 1.0)
                    messages.append(f"GB,{g_counts[0]:03},{g_counts[1]:03},{g_counts[2]:03},{g_counts[3]:03}\r\n")
                if not self.nh_fault:
                    n_counts = self._generate_counts(self.config.nominal_neutron_bg, False, 1.0)
                    self.neutron_cumulative = (self.neutron_cumulative + sum(n_counts)) % 1000000
                    messages.append(f"NB,{n_counts[0]:03},{n_counts[1]:03},{n_counts[2]:03},{n_counts[3]:03}\r\n")
        
        elif self.state == "OCCUPIED":
            duration = self.occupancy_end_time - self.occupancy_start_time
            progress = min(1.0, max(0.0, (now - self.occupancy_start_time) / duration)) if duration > 0 else 0
            
            # Gamma scans every 200ms
            if now - self.last_gamma_scan_pulse >= 0.2:
                self.last_gamma_scan_pulse = now
                g_counts = self._generate_counts(self.config.nominal_gamma_bg, self.is_gamma_alarm, 0.2, progress, self.config.gamma_n_sigma)
                
                if self.is_gamma_alarm and not self.gamma_alarm_latched:
                    base_mean = (self.config.nominal_gamma_bg * 0.2) / 4.0
                    threshold = base_mean + (self.config.gamma_n_sigma * math.sqrt(base_mean))
                    if any(c >= threshold for c in g_counts):
                        self.gamma_alarm_latched = True
                
                label = "GA" if self.gamma_alarm_latched else "GS"
                messages.append(f"{label},{g_counts[0]:03},{g_counts[1]:03},{g_counts[2]:03},{g_counts[3]:03}\r\n")
            
            # Neutron scans every 1s
            if now - self.last_neutron_scan_pulse >= 1.0:
                self.last_neutron_scan_pulse = now
                n_counts = self._generate_counts(self.config.nominal_neutron_bg, self.is_neutron_alarm, 1.0, progress, self.config.neutron_n_sigma)
                
                if self.is_neutron_alarm and not self.neutron_alarm_latched:
                    base_mean = (self.config.nominal_neutron_bg * 1.0) / 4.0
                    threshold = base_mean + (self.config.neutron_n_sigma * math.sqrt(base_mean))
                    if any(c >= threshold for c in n_counts):
                        self.neutron_alarm_latched = True
                        
                label = "NA" if self.neutron_alarm_latched else "NS"
                messages.append(f"{label},{n_counts[0]:03},{n_counts[1]:03},{n_counts[2]:03},{n_counts[3]:03}\r\n")

        # 3. Tamper / power-fail one-shot. Per the Rapiscan spec, TT is sent
        # only on assert and TC only on clear — set_fault() queues exactly one
        # message at the toggle, and we drain it here. Independent of state.
        if self._pending_tamper_msg is not None:
            messages.append(self._pending_tamper_msg)
            self._pending_tamper_msg = None

        # 4. GH / GL / NH fault pulses. Each active fault emits one message
        # every 5s on a timer separate from last_bg_pulse so the cadence stays
        # clean during occupancy (when the bg timer is idle).
        if (self.gh_fault or self.gl_fault or self.nh_fault) and now - self.last_fault_pulse >= 5.0:
            self.last_fault_pulse = now
            if self.gh_fault:
                m = (5.0 * self.config.nominal_gamma_bg) / 4.0
                c = [self._poisson_sample(m) for _ in range(4)]
                messages.append(f"GH,{c[0]:03},{c[1]:03},{c[2]:03},{c[3]:03}\r\n")
            if self.gl_fault:
                m = (0.05 * self.config.nominal_gamma_bg) / 4.0
                c = [self._poisson_sample(m) for _ in range(4)]
                messages.append(f"GL,{c[0]:03},{c[1]:03},{c[2]:03},{c[3]:03}\r\n")
            if self.nh_fault:
                m = (5.0 * self.config.nominal_neutron_bg) / 4.0
                c = [self._poisson_sample(m) for _ in range(4)]
                messages.append(f"NH,{c[0]:03},{c[1]:03},{c[2]:03},{c[3]:03}\r\n")

        return messages

    def trigger_alarm(self, gamma: bool = False, neutron: bool = False):
        """Force an immediate alarming occupancy on the next update cycle."""
        now = time.time()
        if self.state == "OCCUPIED":
            if gamma:
                self.is_gamma_alarm = True
            if neutron:
                self.is_neutron_alarm = True
        else:
            self.state = "OCCUPIED"
            self.occupancy_count = (self.occupancy_count + 1) % 1000000
            duration = random.randint(*self.config.occupancy_duration_range)
            self.occupancy_start_time = now
            self.occupancy_end_time = now + duration
            self.is_gamma_alarm = gamma
            self.is_neutron_alarm = neutron
            self.gamma_alarm_latched = False
            self.neutron_alarm_latched = False
            self.occ_is_unique = False
            self.occ_is_distributed = False
            self.occ_source_sigma = self.config.point_source_sigma
            self.occ_source_pos_length = 0.5
            self.occ_source_pos_width = 0.5
            self.occ_source_pos_height = 0.5
            self.last_gamma_scan_pulse = now - 0.2
            self.last_neutron_scan_pulse = now - 1.0

    def set_fault(self, fault_type: str, active: bool) -> None:
        """Toggle a runtime fault. fault_type: 'gh' | 'gl' | 'nh' | 'tamper'.

        GH/GL/NH are persistent toggles — while active, the corresponding
        fault message emits every 5s and the matching background (GB or NB)
        is suppressed. Tamper is a one-shot pair: TT on assert, TC on clear.
        Redundant toggles (on→on, off→off) are no-ops; tamper queues nothing
        in that case so no spurious TT/TC is emitted.
        """
        now = time.time()
        if fault_type == "gh":
            self.gh_fault = active
        elif fault_type == "gl":
            self.gl_fault = active
        elif fault_type == "nh":
            self.nh_fault = active
        elif fault_type == "tamper":
            if active and not self.tamper_fault:
                self._pending_tamper_msg = "TT,000000,000000,000000,000000\r\n"
            elif not active and self.tamper_fault:
                self._pending_tamper_msg = "TC,111111,111111,111111,111111\r\n"
            self.tamper_fault = active
        else:
            raise ValueError(f"Unknown fault type: {fault_type!r}")
        # Prime the pulse timer so the first GH/GL/NH emission fires on the
        # next update tick rather than 5s later. Also keeps it from colliding
        # with a freshly-emitted GB/NB by ~0 seconds (the suppression gating
        # keeps them out of conflict either way).
        if fault_type in ("gh", "gl", "nh") and active:
            self.last_fault_pulse = now - 5.0
