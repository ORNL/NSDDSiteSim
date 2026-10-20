import asyncio
import unittest

from rpm_server import RPMServer
from simulator import VM250Config


def config() -> VM250Config:
    return VM250Config(
        num_rpms=1,
        base_port=0,
        nominal_gamma_bg=120.0,
        nominal_neutron_bg=2.0,
        gamma_n_sigma=4.0,
        neutron_n_sigma=7.0,
        occupancy_frequency=0.0,
        occupancy_duration_range=(6, 10),
        gamma_alarm_probability=0.0,
        neutron_alarm_probability=0.0,
    )


class TamperBaselineTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.server = RPMServer("rpm-test", 0, config())
        await self.server.start()
        self.port = self.server._server.sockets[0].getsockname()[1]

    async def asyncTearDown(self):
        await self.server.stop()

    async def read_baseline(self) -> str:
        reader, writer = await asyncio.open_connection("127.0.0.1", self.port)
        try:
            return (await asyncio.wait_for(reader.readline(), timeout=1.0)).decode("ascii")
        finally:
            writer.close()
            await writer.wait_closed()

    async def test_new_client_receives_known_clear_baseline(self):
        self.assertEqual(
            await self.read_baseline(),
            "TC,111111,111111,111111,111111\r\n",
        )

    async def test_reconnect_receives_current_active_tamper_state(self):
        self.server.set_fault("tamper", True)

        self.assertEqual(
            await self.read_baseline(),
            "TT,000000,000000,000000,000000\r\n",
        )
        self.assertEqual(
            await self.read_baseline(),
            "TT,000000,000000,000000,000000\r\n",
        )


if __name__ == "__main__":
    unittest.main()
