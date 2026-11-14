import unittest

from camera_manager import CameraManager


class CameraManagerTests(unittest.TestCase):
    def test_ffmpeg_command_uses_tcp_rtsp_transport_in_copy_and_transcode_modes(self):
        mgr = CameraManager.__new__(CameraManager)
        mgr.all_configs = {}

        copy_cmd = mgr._get_ffmpeg_cmd("clip.mp4", 8555, "cam_top", None, None)
        self.assertIn("-rtsp_transport", copy_cmd)
        idx = copy_cmd.index("-rtsp_transport")
        self.assertEqual(copy_cmd[idx + 1], "tcp")
        self.assertEqual(copy_cmd[-1], "rtsp://127.0.0.1:8555/cam_top")

        transcode_cmd = mgr._get_ffmpeg_cmd("clip.avi", 8555, "cam_side", "640x480", 15)
        self.assertIn("-rtsp_transport", transcode_cmd)
        t_idx = transcode_cmd.index("-rtsp_transport")
        self.assertEqual(transcode_cmd[t_idx + 1], "tcp")
        self.assertEqual(transcode_cmd[-1], "rtsp://127.0.0.1:8555/cam_side")

    def test_used_endpoints_allow_shared_rtsp_port_with_distinct_paths(self):
        mgr = CameraManager.__new__(CameraManager)
        mgr.all_configs = {
            "s1": {"name": "Top", "video_file": "top.mp4", "port": 8555, "path": "/ocr_top"},
            "s2": {"name": "Side", "video_file": "side.mp4", "port": 8555, "path": "ocr_side"},
        }

        self.assertEqual(mgr.get_used_endpoints(), {(8555, "ocr_top"), (8555, "ocr_side")})
        self.assertEqual(mgr.get_used_endpoints(exclude_id="s1"), {(8555, "ocr_side")})


if __name__ == "__main__":
    unittest.main()
