import unittest
from unittest.mock import patch

from simulator import VM250Config, VM250Simulator


def config(duration=(1, 1), occupancy_frequency=0.0) -> VM250Config:
    return VM250Config(
        num_rpms=1,
        base_port=0,
        nominal_gamma_bg=120.0,
        nominal_neutron_bg=2.0,
        gamma_n_sigma=4.0,
        neutron_n_sigma=7.0,
        occupancy_frequency=occupancy_frequency,
        occupancy_duration_range=duration,
        gamma_alarm_probability=0.0,
        neutron_alarm_probability=0.0,
    )


class ManualAlarmTests(unittest.TestCase):
    def test_one_second_forced_gamma_alarm_is_immediate_and_clears(self):
        sim = VM250Simulator(1, config())

        with patch("simulator.time.time", return_value=100.0):
            sim.trigger_alarm(gamma=True)
            messages = sim.update()

        self.assertTrue(sim.gamma_alarm_latched)
        self.assertTrue(any(message.startswith("GA,") for message in messages))

        with patch("simulator.time.time", return_value=101.01):
            messages = sim.update()

        self.assertEqual(sim.state, "IDLE")
        self.assertFalse(sim.gamma_alarm_latched)
        self.assertFalse(sim.is_gamma_alarm)
        self.assertTrue(any(message.startswith("GX,") for message in messages))

    def test_one_second_forced_neutron_alarm_is_immediate_and_clears(self):
        sim = VM250Simulator(1, config())

        with patch("simulator.time.time", return_value=200.0):
            sim.trigger_alarm(neutron=True)
            messages = sim.update()

        self.assertTrue(sim.neutron_alarm_latched)
        self.assertTrue(any(message.startswith("NA,") for message in messages))

        with patch("simulator.time.time", return_value=201.01):
            messages = sim.update()

        self.assertEqual(sim.state, "IDLE")
        self.assertFalse(sim.neutron_alarm_latched)
        self.assertFalse(sim.is_neutron_alarm)
        self.assertTrue(any(message.startswith("GX,") for message in messages))

    def test_trigger_during_occupancy_primes_requested_scan_without_clearing_other_alarm(self):
        sim = VM250Simulator(1, config(duration=(5, 5)))

        with patch("simulator.time.time", return_value=300.0):
            sim.trigger_alarm(gamma=True)
            sim.update()

        with patch("simulator.time.time", return_value=300.05):
            sim.trigger_alarm(neutron=True)
            messages = sim.update()

        self.assertTrue(sim.gamma_alarm_latched)
        self.assertTrue(sim.neutron_alarm_latched)
        self.assertTrue(any(message.startswith("NA,") for message in messages))

    def test_unforced_occupancy_does_not_latch_without_threshold_crossing(self):
        sim = VM250Simulator(1, config(duration=(1, 1), occupancy_frequency=1.0))
        sim.last_bg_pulse = 0.0

        with patch("simulator.random.random", side_effect=[0.0, 1.0, 1.0, 1.0]), patch.object(
            sim, "_generate_counts", return_value=[0, 0, 0, 0]
        ):
            with patch("simulator.time.time", return_value=400.0):
                messages = sim.update()
            with patch("simulator.time.time", return_value=400.05):
                messages += sim.update()

        self.assertEqual(sim.state, "OCCUPIED")
        self.assertFalse(sim.gamma_alarm_latched)
        self.assertFalse(sim.neutron_alarm_latched)
        self.assertTrue(any(message.startswith("GS,") for message in messages))
        self.assertTrue(any(message.startswith("NS,") for message in messages))
        self.assertFalse(any(message.startswith(("GA,", "NA,")) for message in messages))


if __name__ == "__main__":
    unittest.main()
