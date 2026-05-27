import asyncio
import logging
from simulator import VM250Simulator, VM250Config

logger = logging.getLogger(__name__)


class RPMServer:
    def __init__(self, rpm_id: int, port: int, config: VM250Config):
        self.rpm_id = rpm_id
        self.port = port
        self.config = config
        self.simulator = VM250Simulator(rpm_id, config)
        self.clients = set()
        self._server = None
        self._task = None

    async def start(self):
        self._server = await asyncio.start_server(self.handle_client, '0.0.0.0', self.port)
        self._task = asyncio.create_task(self._run_loop())
        logger.info(f"RPM {self.rpm_id} listening on port {self.port}")

    async def _run_loop(self):
        async with self._server:
            while True:
                messages = self.simulator.update()
                await self.broadcast(messages)
                await asyncio.sleep(0.05)

    async def stop(self):
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        if self._server:
            self._server.close()
            await self._server.wait_closed()
        logger.info(f"RPM {self.rpm_id} stopped (port {self.port})")

    async def handle_client(self, reader, writer):
        addr = writer.get_extra_info('peername')
        logger.info(f"RPM {self.rpm_id}: client connected from {addr}")
        self.clients.add(writer)
        try:
            while True:
                data = await reader.read(1024)
                if not data:
                    break
        except ConnectionError:
            pass
        finally:
            self.clients.discard(writer)
            writer.close()
            await writer.wait_closed()
            logger.info(f"RPM {self.rpm_id}: client disconnected: {addr}")

    async def broadcast(self, messages):
        if not self.clients or not messages:
            return
        data = "".join(messages).encode('ascii')
        for writer in list(self.clients):
            try:
                writer.write(data)
                await writer.drain()
            except Exception as e:
                logger.debug(f"RPM {self.rpm_id}: write error: {e}")
                self.clients.discard(writer)

    def trigger_alarm(self, gamma: bool = False, neutron: bool = False):
        self.simulator.trigger_alarm(gamma=gamma, neutron=neutron)

    def set_fault(self, fault_type: str, active: bool):
        self.simulator.set_fault(fault_type, active)

    def get_status(self) -> dict:
        sim = self.simulator
        return {
            "state": sim.state,
            "connected_clients": len(self.clients),
            "occupancy_count": sim.occupancy_count,
            "is_gamma_alarm": sim.gamma_alarm_latched,
            "is_neutron_alarm": sim.neutron_alarm_latched,
            "gh_fault": sim.gh_fault,
            "gl_fault": sim.gl_fault,
            "nh_fault": sim.nh_fault,
            "tamper_fault": sim.tamper_fault,
        }
