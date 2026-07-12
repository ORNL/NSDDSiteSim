"""Mobile detector simulation engine (RS-350 backpack, Kromek D5 RIID).

Pure-sync state machine + wire-format codecs, adapted from the reference
implementations in RS350_D5_simulator_addition_spec.md (Appendices A/B).
No sockets or asyncio here — mobile_server.py drives tick() at 1 Hz and
moves the bytes, mirroring how rpm_server.py wraps simulator.py.

Alarm model: instead of the spec's geographic hotspots, alarm episodes are
scheduled in time (Poisson process with a configurable mean interval) and
each episode is shaped like a walk-past of a virtual point source, so count
rates follow the same 1/d² physics and OSCAR still sees one clean,
contiguous alarm episode per event.
"""
import math
import random
import re
import struct
import time
from bisect import bisect_right
from datetime import datetime, timezone

M_PER_DEG_LAT = 111_320.0

# Gamma photopeak energies (keV) used to shape alarm spectra; also the
# isotope list offered by the UI (served via /api/mobiles/isotopes).
ISOTOPES = {
    "Cs-137": 662,
    "Co-60": 1332,
    "Am-241": 60,
    "Ba-133": 356,
    "I-131": 364,
    "Tc-99m": 140,
    "Ir-192": 317,
    "K-40": 1461,
    "U-235": 186,
    "Pu-239": 414,
}


def dist_m(lat1, lon1, lat2, lon2):
    dy = (lat2 - lat1) * M_PER_DEG_LAT
    dx = (lon2 - lon1) * M_PER_DEG_LAT * math.cos(math.radians(lat1))
    return math.hypot(dx, dy)


def poisson(lam):
    """Poisson sample; gaussian approximation for large lambda."""
    if lam <= 0:
        return 0
    if lam > 50:
        return max(0, int(random.gauss(lam, math.sqrt(lam))))
    l, k, p = math.exp(-lam), 0, 1.0
    while True:
        p *= random.random()
        if p <= l:
            return k
        k += 1


class Walker:
    """Constant-speed follower of a closed waypoint loop.

    Arc-length parameterized: segment lengths are precomputed so stepping is
    a single modulo (the reference's incremental step() spins forever on a
    route whose segments are all zero-length).
    """

    def __init__(self, route, speed_mps):
        self.route = [(float(a), float(b)) for a, b in route]
        self.speed = speed_mps
        self.s = 0.0  # meters along the loop
        self._cum = [0.0]
        n = len(self.route)
        for i in range(n):
            a, b = self.route[i], self.route[(i + 1) % n]
            self._cum.append(self._cum[-1] + dist_m(a[0], a[1], b[0], b[1]))
        self.total_len = self._cum[-1]

    def step(self, dt):
        if self.total_len > 0:
            self.s = (self.s + self.speed * dt) % self.total_len

    def position(self):
        if self.total_len <= 0:
            return self.route[0]
        i = min(bisect_right(self._cum, self.s) - 1, len(self.route) - 1)
        seg_len = self._cum[i + 1] - self._cum[i]
        f = (self.s - self._cum[i]) / seg_len if seg_len > 0 else 0.0
        a, b = self.route[i], self.route[(i + 1) % len(self.route)]
        return a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f


D_MIN_M = 2.0      # closest approach to the virtual source (m)
SHOULDER_S = 8.0   # sub-threshold ramp on each side of an episode (s)
MIN_GAP_S = 15.0   # minimum spacing between episodes so OSCAR sees them as distinct


class AlarmEpisodeScheduler:
    """Time-scheduled alarm episodes shaped as virtual point-source fly-bys.

    Source strength is solved so the expected rate crosses background ×
    alarm_factor exactly alarm_duration_s apart: at |t - mid| = D/2 the
    excess is S / (D_MIN² + (v·D/2)²) = (factor-1)·bg. The alarm decision
    uses the *expected* rate (like the spec reference), so an episode is one
    deterministic contiguous stretch — no Poisson flicker at the threshold.
    """

    def __init__(self, cfg, now):
        self.cfg = cfg
        self.episode_mid = None      # mid-time of the active episode, or None
        self.episode_isotope = cfg["isotope"]
        self.alarm_count = 0
        self._was_alarming = False
        self.next_mid = self._draw_next(now)

    def _half_window(self):
        return self.cfg["alarm_duration_s"] / 2.0 + SHOULDER_S

    def _draw_next(self, after):
        interval = self.cfg["alarm_interval_s"]
        if interval <= 0:
            return None
        return after + self._half_window() + max(random.expovariate(1.0 / interval), MIN_GAP_S)

    def _source_strength(self):
        v = max(self.cfg["speed_mps"], 0.5)
        half_reach = v * self.cfg["alarm_duration_s"] / 2.0
        return (self.cfg["alarm_factor"] - 1.0) * self.cfg["background_gamma_cps"] \
            * (D_MIN_M ** 2 + half_reach ** 2)

    def trigger_now(self, now, isotope=None):
        """Start an episode so the alarm asserts on the next tick.

        Returns False (no-op) if an episode is already in progress. Any
        pending scheduled episode is dropped and redrawn after this one.
        """
        if self.episode_mid is not None:
            return False
        self.episode_mid = now + self.cfg["alarm_duration_s"] / 2.0
        self.episode_isotope = isotope or self.cfg["isotope"]
        self.next_mid = None
        return True

    def update(self, now):
        """Advance episode state. Returns (excess_cps, alarming, isotope)."""
        half = self._half_window()
        if self.episode_mid is not None and now > self.episode_mid + half:
            self.episode_mid = None
            if self.next_mid is None:
                self.next_mid = self._draw_next(now)
        if self.episode_mid is None and self.next_mid is not None \
                and now >= self.next_mid - half:
            self.episode_mid = self.next_mid
            self.episode_isotope = self.cfg["isotope"]
            self.next_mid = None

        excess = 0.0
        if self.episode_mid is not None:
            v = max(self.cfg["speed_mps"], 0.5)
            d2 = D_MIN_M ** 2 + (v * (now - self.episode_mid)) ** 2
            excess = self._source_strength() / max(d2, 1.0)

        bg, factor = self.cfg["background_gamma_cps"], self.cfg["alarm_factor"]
        alarming = (bg + excess) > bg * factor
        if alarming and not self._was_alarming:
            self.alarm_count += 1
        self._was_alarming = alarming
        return excess, alarming, self.episode_isotope


class MobileSim:
    """Shared walker + radiation state for one mobile detector instance."""

    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.walker = Walker(cfg["route"], cfg["speed_mps"])
        now = time.monotonic()
        self.scheduler = AlarmEpisodeScheduler(cfg, now)
        self.t0 = now
        self.seq = 0
        self.battery = 100.0
        self.dose_total_usv = 0.0
        self.lat, self.lon = self.walker.position()
        self.gamma_counts = 0
        self.neutron_counts = 0
        self.expected_gamma = cfg["background_gamma_cps"]
        self.dose_rate_usvh = self.expected_gamma / 12000.0
        self.alarming = False
        self.isotope = cfg["isotope"]

    def tick(self, dt: float = 1.0):
        now = time.monotonic()
        self.walker.step(dt)
        self.lat, self.lon = self.walker.position()
        excess, alarming, isotope = self.scheduler.update(now)
        self.expected_gamma = self.cfg["background_gamma_cps"] + excess
        self.gamma_counts = poisson(self.expected_gamma * dt)
        self.neutron_counts = poisson(self.cfg["background_neutron_cps"] * dt)
        self.dose_rate_usvh = self.expected_gamma / 12000.0  # crude uSv/h mapping
        self.dose_total_usv += self.dose_rate_usvh / 3600.0 * dt
        self.battery = max(5.0, self.battery - 0.002 * dt)
        self.seq += 1
        self.alarming = alarming
        self.isotope = isotope

    def trigger_alarm(self, isotope=None) -> bool:
        return self.scheduler.trigger_now(time.monotonic(), isotope)

    def snapshot(self) -> dict:
        return {
            "seq": self.seq,
            "uptime_ms": int((time.monotonic() - self.t0) * 1000),
            "lat": self.lat,
            "lon": self.lon,
            "gamma_counts": self.gamma_counts,
            "neutron_counts": self.neutron_counts,
            "expected_gamma": self.expected_gamma,
            "dose_rate_usvh": self.dose_rate_usvh,
            "dose_total_usv": self.dose_total_usv,
            "battery": self.battery,
            "alarming": self.alarming,
            "isotope": self.isotope,
            "alarm_count": self.scheduler.alarm_count,
            "background_gamma_cps": self.cfg["background_gamma_cps"],
            "background_neutron_cps": self.cfg["background_neutron_cps"],
        }


# ── RS-350: framed N42.42 (2011) XML documents ──────────────────────────────

N42_NS = "http://physics.nist.gov/N42/2011/N42"
STX = b"\x02"
ETX = b"\x03"

# XML 1.0 forbids most C0 controls; stripping them also guarantees the STX/ETX
# framing bytes (0x02/0x03) can never appear inside a document.
_XML_CTRL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")


def _xml_text(value) -> str:
    s = _XML_CTRL_RE.sub("", str(value))
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _spectrum(total_counts, n_channels, peak_channel=None):
    """Cheap exponential continuum with an optional photopeak."""
    decay = n_channels / 6.0
    weights = [math.exp(-i / decay) for i in range(n_channels)]
    if peak_channel is not None and 0 < peak_channel < n_channels:
        for i in range(max(0, peak_channel - 6), min(n_channels, peak_channel + 7)):
            weights[i] += 4.0 * math.exp(-((i - peak_channel) ** 2) / 8.0)
    wsum = sum(weights)
    return [int(total_counts * w / wsum) for w in weights]


def _characteristic(name, value, units="unit-less", data_class="string"):
    return (f'      <Characteristic><CharacteristicName>{name}</CharacteristicName>'
            f'<CharacteristicValue>{value}</CharacteristicValue>'
            f'<CharacteristicValueUnits>{units}</CharacteristicValueUnits>'
            f'<CharacteristicValueDataClassCode>{data_class}</CharacteristicValueDataClassCode>'
            f'</Characteristic>')


def _measurement_block(class_code, mid, start_iso, gamma_counts, neutron_counts,
                       dose_usvh=None, gps=None, isotope=None):
    # Linear calibration is 0 + 3.0*ch keV, so peak channel = keV/3.
    peak = None
    peak_kev = ISOTOPES.get(isotope)
    if peak_kev:
        peak = peak_kev // 3
    lin = _spectrum(gamma_counts, 1024, peak)
    cmp_ = _spectrum(gamma_counts, 256, peak // 4 if peak else None)
    parts = [
        f'  <RadMeasurement id="{mid}">',
        f'    <MeasurementClassCode>{class_code}</MeasurementClassCode>',
        f'    <StartDateTime>{start_iso}</StartDateTime>',
        '    <RealTimeDuration>PT1.0S</RealTimeDuration>',
        f'    <Spectrum id="{mid}Lin" radDetectorInformationReference="DetGamma" '
        f'energyCalibrationReference="LinEnCal">',
        '      <LiveTimeDuration>PT1.0S</LiveTimeDuration>',
        f'      <ChannelData>{" ".join(map(str, lin))}</ChannelData>',
        '    </Spectrum>',
        f'    <Spectrum id="{mid}Cmp" radDetectorInformationReference="DetGamma" '
        f'energyCalibrationReference="CmpEnCal">',
        '      <LiveTimeDuration>PT1.0S</LiveTimeDuration>',
        f'      <ChannelData>{" ".join(map(str, cmp_))}</ChannelData>',
        '    </Spectrum>',
        f'    <GrossCounts id="{mid}Gamma" radDetectorInformationReference="DetGamma">',
        '      <LiveTimeDuration>PT1.0S</LiveTimeDuration>',
        f'      <CountData>{gamma_counts}</CountData>',
        '    </GrossCounts>',
        f'    <GrossCounts id="{mid}Neutron" radDetectorInformationReference="DetNeutron">',
        '      <LiveTimeDuration>PT1.0S</LiveTimeDuration>',
        f'      <CountData>{neutron_counts}</CountData>',
        '    </GrossCounts>',
    ]
    if dose_usvh is not None:
        parts += [
            f'    <DoseRate id="{mid}Dose" radDetectorInformationReference="DetGamma">',
            f'      <DoseRateValue>{dose_usvh:.4f}</DoseRateValue>',
            '    </DoseRate>',
        ]
    if gps is not None:
        lat, lon, alt = gps
        parts += [
            '    <RadInstrumentState radInstrumentInformationReference="InstInfo">',
            '      <StateVector>',
            '        <GeographicPoint>',
            f'          <LatitudeValue>{lat:.6f}</LatitudeValue>',
            f'          <LongitudeValue>{lon:.6f}</LongitudeValue>',
            f'          <ElevationValue>{alt:.1f}</ElevationValue>',
            '        </GeographicPoint>',
            '      </StateVector>',
            '    </RadInstrumentState>',
        ]
    parts.append('  </RadMeasurement>')
    return "\n".join(parts)


class RS350Codec:
    """Builds the per-second N42.42 document from a MobileSim snapshot."""

    def __init__(self, device_name: str, serial: str):
        self.device_name = _xml_text(device_name)
        self.serial = _xml_text(serial)

    def build_document(self, snap: dict, include_background: bool) -> str:
        now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        alarming = snap["alarming"]
        isotope = _xml_text(snap["isotope"]) if snap["isotope"] else None

        doc = [
            f'<RadInstrumentData xmlns="{N42_NS}">',
            '  <RadInstrumentInformation id="InstInfo">',
            '    <RadInstrumentManufacturerName>Radiation Solutions Inc</RadInstrumentManufacturerName>',
            f'    <RadInstrumentIdentifier>{self.serial}</RadInstrumentIdentifier>',
            '    <RadInstrumentModelName>RS-350</RadInstrumentModelName>',
            '    <RadInstrumentClassCode>Backpack</RadInstrumentClassCode>',
            '    <RadInstrumentVersion><RadInstrumentComponentName>Software'
            '</RadInstrumentComponentName><RadInstrumentComponentVersion>sim-1.0'
            '</RadInstrumentComponentVersion></RadInstrumentVersion>',
            '    <RadInstrumentCharacteristics>',
            _characteristic("DeviceName", self.device_name),
            _characteristic("BatteryCharge", f"{snap['battery']:.0f}", "percent", "double"),
            '    </RadInstrumentCharacteristics>',
            '  </RadInstrumentInformation>',
            '  <RadDetectorInformation id="DetGamma">'
            '<RadDetectorCategoryCode>Gamma</RadDetectorCategoryCode>'
            '<RadDetectorKindCode>NaI</RadDetectorKindCode></RadDetectorInformation>',
            '  <RadDetectorInformation id="DetNeutron">'
            '<RadDetectorCategoryCode>Neutron</RadDetectorCategoryCode>'
            '<RadDetectorKindCode>He3</RadDetectorKindCode></RadDetectorInformation>',
            '  <RadItemInformation id="ItemInfo">',
            '    <RadItemCharacteristics>',
            _characteristic("ScanMode", "Search"),
            _characteristic("ScanNumber", "1", "unit-less", "double"),
            _characteristic("ScanTimeoutNumber", "0", "unit-less", "double"),
            _characteristic("AnalysisEnabled", "1", "unit-less", "integer"),
            '    </RadItemCharacteristics>',
            '  </RadItemInformation>',
            '  <EnergyCalibration id="LinEnCal">',
            '    <CoefficientValues>0 3.0 0</CoefficientValues>',
            '  </EnergyCalibration>',
            '  <EnergyCalibration id="CmpEnCal">',
            '    <CoefficientValues>0 12.0 0</CoefficientValues>',
            '  </EnergyCalibration>',
        ]
        if include_background:
            bg_gamma = poisson(snap["background_gamma_cps"])
            bg_neutron = poisson(snap["background_neutron_cps"])
            doc.append(_measurement_block("Background", "Bkg", now_iso, bg_gamma, bg_neutron))
        doc.append(_measurement_block(
            "Foreground", "Fg", now_iso, snap["gamma_counts"], snap["neutron_counts"],
            dose_usvh=snap["dose_rate_usvh"], gps=(snap["lat"], snap["lon"], 20.0),
            isotope=isotope if alarming else None))
        if alarming:
            doc += [
                '  <DerivedData id="Derived">',
                '    <MeasurementClassCode>NotSpecified</MeasurementClassCode>',
                f'    <StartDateTime>{now_iso}</StartDateTime>',
                '    <RealTimeDuration>PT1.0S</RealTimeDuration>',
                '    <Remark>Alarm</Remark>',
                '  </DerivedData>',
                '  <AnalysisResults id="Analysis">',
                '    <RadAlarm radDetectorInformationReferences="DetGamma">',
                '      <RadAlarmCategoryCode>Gamma</RadAlarmCategoryCode>',
                f'      <RadAlarmDescription>{isotope or "Unknown"}</RadAlarmDescription>',
                '    </RadAlarm>',
                '  </AnalysisResults>',
            ]
        doc.append('</RadInstrumentData>')
        return "\n".join(doc)


# ── Kromek D5: SLIP-framed binary request/response ──────────────────────────

FRAME = 0xC0
ESC = 0xDB
BAD = (0xC0, 0xDB)

# Guard against a garbage-spewing client growing the parse buffer forever
# (real requests are 9 bytes).
_MAX_PARSE_BUF = 65536


def clean_u8(v):
    v = max(0, min(0xFF, int(v)))
    return bytes([v - 1 if v in BAD else v])


def clean_u16(v):
    v = max(0, min(0xFFFF, int(v)))
    while any(b in BAD for b in struct.pack("<H", v)):
        v -= 1
    return struct.pack("<H", v)


def clean_u32(v):
    v = max(0, min(0xFFFFFFFF, int(v)))
    while any(b in BAD for b in struct.pack("<I", v)):
        v -= 1
    return struct.pack("<I", v)


def clean_i16(v):
    v = int(v)
    while any(b in BAD for b in struct.pack("<h", v)):
        v -= 1
    return struct.pack("<h", v)


def clean_f32(x, step=1e-6):
    x = float(x)
    for _ in range(1000):
        raw = struct.pack("<f", x)
        if not any(b in BAD for b in raw):
            return raw
        x += step
    return struct.pack("<f", 0.0)


def build_frame(component_id, report_id, payload: bytes) -> bytes:
    """Logical body + 0xC0 framing. The body must already be byte-clean:
    the driver reads `length` raw bytes but counts logical ones, so no
    0xC0/0xDB may appear and no SLIP escaping is allowed (spec §5.2)."""
    body = struct.pack("<H", 7 + len(payload)) + bytes([0x00, component_id, report_id]) \
        + payload + b"\x00\x00"
    dirty = [b for b in body if b in BAD]
    if dirty:
        raise ValueError(f"response body contains framing bytes: {dirty[:5]}")
    return bytes([FRAME]) + body + bytes([FRAME])


def slip_decode(data: bytes) -> bytes:
    out = bytearray()
    i = 0
    while i < len(data):
        b = data[i]
        if b == ESC and i + 1 < len(data):
            out.append(FRAME if data[i + 1] == 0xDC else ESC)
            i += 2
        else:
            out.append(b)
            i += 1
    return bytes(out)


class D5FrameParser:
    """Incremental request-frame parser (the Appendix B receive algorithm).

    feed() returns a list of (component_id, report_id) for every complete
    request frame, in arrival order. Repeated 0xC0 bytes collapse to one
    frame start; the trailing 0xC0 is kept as the next frame's opener.
    """

    def __init__(self):
        self.buf = bytearray()

    def feed(self, data: bytes):
        self.buf += data
        out = []
        while True:
            try:
                start = self.buf.index(FRAME)
            except ValueError:
                self.buf.clear()
                break
            end = start + 1
            while end < len(self.buf) and self.buf[end] == FRAME:
                start = end  # collapse repeated frame bytes
                end += 1
            try:
                end = self.buf.index(FRAME, start + 1)
            except ValueError:
                # Incomplete frame: prune pre-frame junk, wait for more bytes.
                del self.buf[:start]
                if len(self.buf) > _MAX_PARSE_BUF:
                    self.buf.clear()
                break
            raw = slip_decode(bytes(self.buf[start + 1:end]))
            del self.buf[:end]  # keep trailing 0xC0 as next frame's opener
            if len(raw) >= 7:
                out.append((raw[3], raw[4]))
        return out


class D5Codec:
    """Builds report payloads from a MobileSim snapshot.

    Every emitted integer/float goes through a clean_*() helper so the
    response body can never contain 0xC0/0xDB (see build_frame).
    """

    def __init__(self, product_name: str, serial: str):
        self.product = product_name.encode("ascii", "ignore")[:50]
        self.serial = serial.encode("ascii", "ignore")[:50]
        # 4096-bin exponential spectrum weights, precomputed once.
        decay = 4096 / 6.0
        self._weights = [math.exp(-i / decay) for i in range(4096)]
        self._wsum = sum(self._weights)
        self._radiometrics_cache = (-1, b"")

    def radiometrics_v1(self, snap: dict) -> bytes:
        if self._radiometrics_cache[0] == snap["seq"]:
            return self._radiometrics_cache[1]
        gamma_counts = int(snap["gamma_counts"])
        head = b"".join([
            clean_u32(0),                          # status
            clean_u32(snap["uptime_ms"]),          # realTimeMs
            clean_u32(snap["seq"]),                # sequenceNumber
            clean_f32(snap["dose_total_usv"]),     # dose accumulated (uSv)
            clean_f32(snap["dose_rate_usvh"]),     # doseRate (uSv/h)
            clean_f32(snap["dose_total_usv"]),     # doseUserAccumulated
            clean_u32(1000),                       # neutronLiveTime ms
            clean_u32(snap["neutron_counts"]),     # neutronCounts (this interval)
            clean_i16(2500),                       # neutronTemperature (x100 C)
            clean_f32(0.0),                        # reserved
            clean_u32(1000),                       # gammaLiveTime ms
            clean_u32(gamma_counts),               # gammaCounts (this interval)
            clean_i16(2500),                       # gammaTemperature (x100 C)
            clean_f32(0.0),                        # reserved
            bytes([12, 0]),                        # spectrumBitsSize, reserved
        ])
        # 4096 x u16 spectrum; values clamped <=191 so every byte is
        # trivially clean (low byte < 0xC0, high byte 0x00).
        total = max(gamma_counts, 1)
        scale = total / self._wsum * 16
        bins = bytearray()
        for w in self._weights:
            bins += struct.pack("<H", min(191, int(w * scale)))
        payload = head + bytes(bins)
        assert len(payload) == 8246, len(payload)
        self._radiometrics_cache = (snap["seq"], payload)
        return payload

    def radiometric_status(self, snap: dict) -> bytes:
        return b"".join([
            clean_u8(0),                             # doseAlarmActive
            clean_u8(1 if snap["alarming"] else 0),  # gammaCpsAlarmActive
            clean_u8(0),                             # neutronCpsAlarmActive
            clean_f32(snap["lat"], step=1e-6),       # latitude (deg)
            clean_f32(snap["lon"], step=1e-6),       # longitude (deg)
            clean_u32(int(time.time())),             # deviceTimestamp (epoch s)
            clean_u16(0),                            # numNuclideResults
        ])

    def status(self, snap: dict) -> bytes:
        return b"".join([
            clean_u8(0),                        # appStatus
            clean_u8(1),                        # powerSource: BATTERY (enum 0-4)
            clean_u8(25),                       # temperature C
            clean_u8(0), clean_u8(0),           # detectorStatus0/1
            clean_u8(int(snap["battery"])),     # batteryLevel %
            clean_u8(0),                        # batteryChargeRate
            clean_u8(25),                       # batteryTemperature
            clean_u8(0), clean_u8(0),           # usbStatus, btStatus
            clean_u8(0),                        # detectorStatus2
        ])

    def about(self) -> bytes:
        return bytes([1, 0, 1, 0]) \
            + self.product.ljust(50, b"\x00") \
            + self.serial.ljust(50, b"\x00")

    def dispatch(self, component_id: int, report_id: int, snap: dict) -> bytes:
        key = (component_id, report_id)
        if key == (0x07, 0xC2):
            return self.radiometrics_v1(snap)
        if key == (0x08, 0x82):
            return self.radiometric_status(snap)
        if key == (0x07, 0xC5):
            return self.status(snap)
        if key == (0x07, 0xC7):
            return self.about()
        # Unimplemented report: empty payload — the driver logs and skips.
        return b""
