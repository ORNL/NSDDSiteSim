import subprocess
import os
import json
import time
import psutil
import logging
from typing import Dict, List, Optional, Set
from pathlib import Path

logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent
VIDEO_DIR = BASE_DIR / "videos"
DATA_DIR = BASE_DIR / "data"
BIN_DIR = BASE_DIR / "bin"
CONFIG_FILE = DATA_DIR / "cameras.json"
LOG_DIR = BASE_DIR / "logs"

MEDIAMTX_PATH = BIN_DIR / "mediamtx"

# Keyframe interval (seconds) for transcoded streams. Downstream HLS
# repackagers can only cut segments on keyframes, so keep GOPs ~1 s.
KEYFRAME_INTERVAL_SEC = 1


class CameraManager:
    def __init__(self):
        self.streams: Dict[str, dict] = {}           # running streams with process handles
        self.all_configs: Dict[str, dict] = {}        # all stream configs (running + stopped)
        self._stopped_ids: Set[str] = set()           # IDs not to auto-restart
        self.mediamtx_instances: Dict[int, subprocess.Popen] = {}
        self._load_config()

    def _load_config(self):
        DATA_DIR.mkdir(exist_ok=True)
        LOG_DIR.mkdir(exist_ok=True)
        if CONFIG_FILE.exists():
            try:
                with open(CONFIG_FILE, 'r') as f:
                    raw = json.load(f)
                for sid, val in raw.items():
                    if isinstance(val, dict) and "config" in val and "running" in val:
                        # New format: {"config": {...}, "running": bool}
                        self.all_configs[sid] = val["config"]
                        if not val.get("running", True):
                            self._stopped_ids.add(sid)
                    else:
                        # Old format: {sid: {...config...}} — treat as auto-start
                        self.all_configs[sid] = val
            except Exception as e:
                logger.error(f"Failed to load camera config: {e}")
                self.all_configs = {}

    def _save_config(self):
        DATA_DIR.mkdir(exist_ok=True)
        tmp = str(CONFIG_FILE) + ".tmp"
        data = {}
        for sid, config in self.all_configs.items():
            data[sid] = {"config": config, "running": sid in self.streams}
        with open(tmp, 'w') as f:
            json.dump(data, f, indent=4)
        os.replace(tmp, CONFIG_FILE)

    def _get_ffmpeg_cmd(self, video_file: str, port: int, path: str, resolution: Optional[str], framerate: Optional[int]):
        video_path = VIDEO_DIR / video_file
        rtsp_url = f"rtsp://127.0.0.1:{port}/{path}"

        cmd = ["ffmpeg", "-re", "-stream_loop", "-1", "-i", str(video_path)]

        if resolution or framerate:
            v_filters = []
            if resolution:
                v_filters.append(f"scale={resolution.replace('x', ':')}")
            if framerate:
                cmd.extend(["-r", str(framerate)])
            if v_filters:
                cmd.extend(["-vf", ",".join(v_filters)])
            cmd.extend([
                "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
                "-sc_threshold", "0",
                "-force_key_frames", f"expr:gte(t,n_forced*{KEYFRAME_INTERVAL_SEC})",
            ])
            if framerate:
                cmd.extend(["-g", str(int(framerate) * KEYFRAME_INTERVAL_SEC)])
            cmd.extend(["-c:a", "aac", "-f", "rtsp"])
        else:
            cmd.extend(["-c", "copy", "-f", "rtsp"])

        cmd.append(rtsp_url)
        return cmd

    def _wait_for_port(self, port: int, timeout: int = 10) -> bool:
        import socket
        start_time = time.time()
        while time.time() - start_time < timeout:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                if s.connect_ex(('127.0.0.1', port)) == 0:
                    return True
            time.sleep(0.5)
        return False

    def _start_mediamtx(self, port: int) -> bool:
        if port in self.mediamtx_instances:
            if self.mediamtx_instances[port].poll() is None:
                return True

        for proc in psutil.process_iter(['pid', 'name']):
            try:
                if proc.info['name'] == 'mediamtx':
                    for conn in proc.connections(kind='inet'):
                        if conn.laddr.port == port:
                            logger.info(f"Killing stale MediaMTX PID {proc.info['pid']} on port {port}")
                            proc.kill()
                            proc.wait(timeout=5)
                            break
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                continue

        config_path = LOG_DIR / f"mediamtx_{port}.yml"
        with open(config_path, 'w') as f:
            f.write(f"rtspAddress: :{port}\n")
            f.write("protocols: [tcp]\n")
            f.write("rtmp: no\n")
            f.write("hls: no\n")
            f.write("webrtc: no\n")
            f.write("srt: no\n")
            f.write("api: no\n")
            f.write("metrics: no\n")
            f.write("paths:\n  all:\n")

        log_file = LOG_DIR / f"mediamtx_{port}.log"
        try:
            if not MEDIAMTX_PATH.exists():
                logger.error(f"MediaMTX binary not found at {MEDIAMTX_PATH}")
                return False

            with open(log_file, "w") as f_log:
                proc = subprocess.Popen(
                    [str(MEDIAMTX_PATH), str(config_path)],
                    stdout=f_log,
                    stderr=subprocess.STDOUT
                )
            self.mediamtx_instances[port] = proc
            logger.info(f"Started MediaMTX on port {port}")

            if self._wait_for_port(port):
                return True
            else:
                logger.error(f"MediaMTX failed to bind to port {port} within timeout")
                return False
        except Exception as e:
            logger.error(f"Failed to start MediaMTX on port {port}: {e}")
            return False

    def add_stream(self, stream_id: str, config: dict) -> tuple[bool, str]:
        video_file = config.get("video_file")
        port = int(config.get("port", 8554))
        path = config.get("path", stream_id)
        resolution = config.get("resolution")
        framerate = config.get("framerate")

        if not self._start_mediamtx(port):
            return False, "Failed to start RTSP server"

        ffmpeg_cmd = self._get_ffmpeg_cmd(video_file, port, path, resolution, framerate)
        log_file = LOG_DIR / f"ffmpeg_{stream_id}.log"

        try:
            with open(log_file, "w") as f_log:
                ffmpeg_proc = subprocess.Popen(
                    ffmpeg_cmd,
                    stdout=subprocess.DEVNULL,
                    stderr=f_log
                )
            self.streams[stream_id] = {
                "config": config,
                "ffmpeg_proc": ffmpeg_proc,
                "port": port,
                "log_file": str(log_file)
            }
            self.all_configs[stream_id] = config
            self._stopped_ids.discard(stream_id)
            self._save_config()
            logger.info(f"Started camera {stream_id} -> port {port}/{path}")
            return True, "Stream started"
        except Exception as e:
            logger.error(f"Failed to start FFmpeg for {stream_id}: {e}")
            return False, str(e)

    def stop_stream(self, stream_id: str) -> bool:
        if stream_id not in self.streams:
            return False

        data = self.streams[stream_id]
        proc = data["ffmpeg_proc"]
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except Exception:
            proc.kill()

        port = data["port"]
        del self.streams[stream_id]
        self._stopped_ids.add(stream_id)
        self._save_config()

        if not any(s["port"] == port for s in self.streams.values()):
            if port in self.mediamtx_instances:
                self.mediamtx_instances[port].terminate()
                del self.mediamtx_instances[port]
                logger.info(f"Stopped MediaMTX on port {port}")

        logger.info(f"Stopped camera {stream_id}")
        return True

    def start_stream(self, stream_id: str) -> tuple[bool, str]:
        if stream_id not in self.all_configs:
            return False, "Stream not found"
        if stream_id in self.streams:
            return False, "Stream is already running"
        return self.add_stream(stream_id, self.all_configs[stream_id])

    def update_stream(self, stream_id: str, config: dict) -> tuple[bool, str]:
        if stream_id not in self.all_configs:
            return False, "Stream not found"
        if stream_id in self.streams:
            return False, "Stop the stream before editing"
        self.all_configs[stream_id] = config
        self._save_config()
        return True, "Stream config updated"

    def remove_stream(self, stream_id: str) -> bool:
        if stream_id in self.streams:
            data = self.streams[stream_id]
            proc = data["ffmpeg_proc"]
            try:
                proc.terminate()
                proc.wait(timeout=5)
            except Exception:
                proc.kill()

            port = data["port"]
            del self.streams[stream_id]

            if not any(s["port"] == port for s in self.streams.values()):
                if port in self.mediamtx_instances:
                    self.mediamtx_instances[port].terminate()
                    del self.mediamtx_instances[port]
                    logger.info(f"Stopped MediaMTX on port {port}")
        elif stream_id not in self.all_configs:
            return False

        self.all_configs.pop(stream_id, None)
        self._stopped_ids.discard(stream_id)
        self._save_config()
        logger.info(f"Removed camera {stream_id}")
        return True

    def get_status(self) -> List[dict]:
        status = []
        for sid, config in self.all_configs.items():
            running = sid in self.streams
            port = config.get("port", 8554)
            status.append({
                "id": sid,
                "config": config,
                "running": running,
                "url": f"rtsp://<host>:{port}/{config.get('path', sid)}"
            })
        return status

    def get_used_ports(self) -> set:
        return {config["port"] for config in self.all_configs.values()}

    def start_all(self):
        for sid in list(self.all_configs.keys()):
            if sid not in self._stopped_ids:
                self.add_stream(sid, self.all_configs[sid])

    def get_files_in_use(self) -> set:
        return {data['config']['video_file'] for data in self.streams.values()}

    def stop_all(self):
        for sid in list(self.streams.keys()):
            data = self.streams[sid]
            proc = data["ffmpeg_proc"]
            try:
                proc.terminate()
                proc.wait(timeout=5)
            except Exception:
                proc.kill()

        for proc in list(self.mediamtx_instances.values()):
            try:
                proc.terminate()
            except Exception:
                pass

        self.streams.clear()
        self.mediamtx_instances.clear()
