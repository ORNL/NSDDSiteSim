import asyncio
import logging
import time

from mobile_sim import (D5Codec, D5FrameParser, ETX, MobileSim, RS350Codec,
                        STX, build_frame)

logger = logging.getLogger(__name__)


class MobileServerBase:
    """Asyncio TCP server around one MobileSim instance.

    A single drift-corrected 1 Hz ticker advances the walker/radiation state
    whether or not any client is connected (the OSCAR driver may connect at
    any time and must find the walker mid-route, not frozen at the start).
    """

    def __init__(self, mobile_id: str, config: dict):
        self.mobile_id = mobile_id
        self.port = config["port"]
        self.config = config
        self.detector_type = config["detector_type"]
        self.sim = MobileSim(config)
        self.clients = set()
        self._server = None
        self._ticker_task = None

    async def start(self):
        self._server = await asyncio.start_server(self.handle_client, "0.0.0.0", self.port)
        self._ticker_task = asyncio.create_task(self._run_ticker())
        logger.info(f"Mobile {self.mobile_id} ({self.detector_type}) listening on port {self.port}")

    async def stop(self):
        if self._ticker_task:
            self._ticker_task.cancel()
            try:
                await self._ticker_task
            except asyncio.CancelledError:
                pass
        if self._server:
            self._server.close()
            await self._server.wait_closed()
        for writer in list(self.clients):
            writer.close()
        self.clients.clear()
        logger.info(f"Mobile {self.mobile_id} stopped (port {self.port})")

    async def _run_ticker(self):
        next_tick = time.monotonic()
        while True:
            next_tick += 1.0
            self.sim.tick(1.0)
            await self._on_tick()
            await asyncio.sleep(max(0.0, next_tick - time.monotonic()))

    async def _on_tick(self):
        pass

    async def handle_client(self, reader, writer):
        raise NotImplementedError

    def trigger_alarm(self, isotope=None) -> bool:
        return self.sim.trigger_alarm(isotope)

    def get_status(self) -> dict:
        snap = self.sim.snapshot()
        return {
            "detector_type": self.detector_type,
            "connected_clients": len(self.clients),
            "latitude": snap["lat"],
            "longitude": snap["lon"],
            "alarming": snap["alarming"],
            "isotope": snap["isotope"],
            "alarm_count": snap["alarm_count"],
            "battery_pct": snap["battery"],
            "gamma_cps": snap["gamma_counts"],
        }


class RS350Server(MobileServerBase):
    """Push server: one STX + N42.42 XML + ETX frame per second per client.

    The driver never writes; reads are drained only so a dead peer is
    noticed. A Background measurement block rides along every ~30 s.
    """

    BACKGROUND_EVERY_S = 30.0

    def __init__(self, mobile_id: str, config: dict):
        super().__init__(mobile_id, config)
        self.codec = RS350Codec(config["name"], config["serial"])
        self._last_bkg = 0.0

    async def _on_tick(self):
        if not self.clients:
            return
        now = time.monotonic()
        include_bkg = (now - self._last_bkg) >= self.BACKGROUND_EVERY_S
        if include_bkg:
            self._last_bkg = now
        xml = self.codec.build_document(self.sim.snapshot(), include_bkg)
        data = xml.encode("utf-8")
        if STX in data or ETX in data:
            # Structurally impossible (codec strips control chars) — skip the
            # frame rather than corrupt the driver's STX/ETX scan.
            logger.error(f"Mobile {self.mobile_id}: framing byte inside XML, frame skipped")
            return
        frame = STX + data + ETX
        for writer in list(self.clients):
            try:
                writer.write(frame)
                # Bounded drain so one wedged client (full TCP buffer) can't
                # stall the ticker for everyone else.
                await asyncio.wait_for(writer.drain(), timeout=5.0)
            except (asyncio.TimeoutError, OSError) as e:
                logger.info(f"Mobile {self.mobile_id}: dropping client after write error: {e}")
                self.clients.discard(writer)
                writer.close()

    async def handle_client(self, reader, writer):
        addr = writer.get_extra_info("peername")
        logger.info(f"Mobile {self.mobile_id} (rs350): client connected: {addr}")
        self.clients.add(writer)
        try:
            while True:
                data = await reader.read(1024)
                if not data:
                    break
        except (ConnectionError, OSError):
            pass
        finally:
            self.clients.discard(writer)
            writer.close()
            try:
                await writer.wait_closed()
            except OSError:
                pass
            logger.info(f"Mobile {self.mobile_id} (rs350): client disconnected: {addr}")


class D5Server(MobileServerBase):
    """Polled server: strict read-one-request → write-one-response loop.

    The OSCAR driver blocks reading each response with no timeout, so every
    complete request frame gets exactly one response, in order. On any
    unexpected error the connection is closed (the driver reconnects) rather
    than left open with a response silently dropped.
    """

    def __init__(self, mobile_id: str, config: dict):
        super().__init__(mobile_id, config)
        self.codec = D5Codec("Kromek D5 (sim)", config["serial"])

    async def handle_client(self, reader, writer):
        addr = writer.get_extra_info("peername")
        logger.info(f"Mobile {self.mobile_id} (d5): client connected: {addr}")
        self.clients.add(writer)
        parser = D5FrameParser()
        try:
            while True:
                chunk = await reader.read(4096)
                if not chunk:
                    break
                for component_id, report_id in parser.feed(chunk):
                    payload = self.codec.dispatch(component_id, report_id, self.sim.snapshot())
                    writer.write(build_frame(component_id, report_id, payload))
                await writer.drain()
        except (ConnectionError, OSError):
            pass
        except Exception as e:
            logger.error(f"Mobile {self.mobile_id} (d5): closing client {addr} after error: {e}")
        finally:
            self.clients.discard(writer)
            writer.close()
            try:
                await writer.wait_closed()
            except OSError:
                pass
            logger.info(f"Mobile {self.mobile_id} (d5): client disconnected: {addr}")
