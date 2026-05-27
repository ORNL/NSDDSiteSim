# Lane Simulator

A unified simulation platform that combines IP camera (RTSP) and radiation portal monitor (RPM) simulation into a single application with a web-based management interface. Designed to run as a systemd service inside a Proxmox LXC container.

---

## Overview

| Simulator | Protocol | Default Port | Description |
|---|---|---|---|
| IP Camera | RTSP (TCP) | 9001+ | Loops a video file through MediaMTX, simulating a network camera |
| RPM Monitor | TCP ASCII | 10001+ | Streams Rapiscan VM250-format radiation data to connected clients |

The web UI runs on **port 8000** and allows you to add, configure, and remove any number of camera streams and RPM monitors without editing any files or restarting the service.

---

## Requirements

- Debian/Ubuntu-based Linux (tested on Debian 12)
- Python 3.10 or later
- `ffmpeg` (for camera simulation)
- Internet access during installation (to download MediaMTX)
- Root or sudo access (for systemd service setup)

> **Note:** Camera simulation requires `ffmpeg` and the MediaMTX binary, both of which are Linux x86_64 only. RPM simulation has no binary dependencies and works on any platform.

---

## Recommended Specs

Resource usage is driven almost entirely by camera streams. FFmpeg is the heavy component — each transcoding stream consumes a full CPU core and significant RAM. RPM simulation is negligible regardless of how many monitors are configured (pure asyncio, ~1 MB per RPM).

### Proxmox LXC container

An **unprivileged container** running Debian 12 works without any special configuration.

| Use case | vCPUs | RAM | Storage |
|---|---|---|---|
| RPM-only (no cameras) | 1 | 256 MB | 4 GB |
| 1–2 cameras, passthrough encoding | 2 | 512 MB | 10 GB + video files |
| 4–6 cameras, passthrough encoding | 2–4 | 1 GB | 20 GB + video files |
| 4–6 cameras, transcoding (resolution/FPS conversion) | 4–6 | 2 GB | 20 GB + video files |

**Passthrough** (`-c copy`) means FFmpeg reads the file and forwards it without re-encoding — very low CPU, roughly 50–100 MB RAM per stream. This is the default when you leave Resolution and Framerate blank in the Add Camera form.

**Transcoding** (any Resolution or Framerate override set) re-encodes with libx264 — expect ~1 vCPU and ~200–400 MB RAM per stream depending on resolution.

**Storage:** Budget for your video source files plus ~500 MB for logs over time. A typical 1080p security footage file is 500 MB–2 GB depending on bitrate and length.

**Network:** Each RTSP stream consumes bandwidth proportional to its bitrate. Typical H.264 estimates:

| Resolution | Bitrate (per stream) |
|---|---|
| 1080p30 | 3–8 Mbps |
| 720p30 | 1–4 Mbps |
| 480p | 0.5–2 Mbps |

A 1 Gbps NIC is sufficient for any realistic number of streams. RPM data is negligible (<1 KB/s per monitor).

### Bare-metal or VM installation

The same sizing applies. Run `install.sh` on any Debian/Ubuntu x86_64 system — it creates the `lanesim` systemd service identically to the LXC setup. No containerisation is required.

For a dedicated test bench with 4–8 camera streams and 10–20 RPM monitors, a machine with **4 cores and 4 GB RAM** will be comfortable with headroom to spare.

---

## Installation

### 1. Transfer files to the LXC container

Copy the entire `unified/` directory to the container. The installer uses its own location as the source, so the directory name does not matter.

```bash
scp -r unified/ root@<container-ip>:/tmp/lanesim
```

### 2. Add video files (optional)

Video files can be uploaded at any time through the web UI after installation (see [Video Library](#video-library)). If you want files available immediately on first boot, copy them into the `videos/` subdirectory before running the installer and they will be copied automatically.

```bash
cp /path/to/your/*.mp4 /tmp/lanesim/videos/
```

Three sample videos are included in the repository if you need them.

### 3. Run the installer

```bash
cd /tmp/lanesim
chmod +x install.sh
sudo bash install.sh
```

The installer will:
1. Install system packages: `ffmpeg`, `python3-venv`, `python3-pip`, `wget`, `tar`
2. Create a `lanesim` system user (no login shell)
3. Copy application files to `/opt/lanesim/`
4. Download and install the MediaMTX v1.9.0 binary
5. Create a Python virtual environment and install dependencies
6. Register and enable the `lanesim` systemd service

### 4. Start the service

```bash
systemctl start lanesim
```

Open a browser and navigate to `http://<container-ip>:8000`.

---

## Service Management

| Task | Command |
|---|---|
| Start | `systemctl start lanesim` |
| Stop | `systemctl stop lanesim` |
| Restart | `systemctl restart lanesim` |
| Check status | `systemctl status lanesim` |
| View live logs | `journalctl -u lanesim -f` |
| Enable on boot | `systemctl enable lanesim` (done by installer) |
| Disable on boot | `systemctl disable lanesim` |

---

## Using the Web Interface

Navigate to `http://<container-ip>:8000`.

The dashboard has two tabs: **Cameras** and **RPM Monitors**. Both are managed independently from the same page. Configuration is persisted automatically — all cameras and RPMs are restored when the service restarts.

### Adding a Camera

1. Click **+ Add Camera**.
2. Fill in the form:
   - **Camera Name** — a display label (e.g. "Lane 1 Entry")
   - **Video File** — select from the uploaded files. If the list is empty, upload files first via **📁 Videos** (see [Video Library](#video-library)).
   - **RTSP Port** — auto-filled with the next unused port starting at 9001 (9001, 9002, …). You can edit it freely. Multiple cameras can share a port — they will use one MediaMTX instance on that port with different paths.
   - **Stream Path** — the RTSP path segment (e.g. `cam1`). The full URL will be `rtsp://<host>:<port>/<path>`.
   - **Resolution** *(optional)* — transcode to 1080p, 720p, or 480p. Leave blank to pass through the source resolution.
   - **Framerate** *(optional)* — transcode to a fixed FPS. Leave blank to pass through the source framerate.
3. Click **Start Stream**.

The camera card will appear with its RTSP URL. Click the URL to copy it to the clipboard.

**Connecting to a camera stream:**
- VLC: Media → Open Network Stream → paste the RTSP URL
- ffplay: `ffplay rtsp://<host>:<port>/<path>`
- Any RTSP-capable NVR or video management software

### Stopping and Starting a Camera

Each camera card has a **stop** (square) button while active and a **play** button while stopped. Stopping a stream kills the FFmpeg process but keeps the configuration; clicking play restarts it with the same settings. The stopped/running state is persisted — a stopped camera remains stopped after a service restart.

### Editing a Camera

While a camera is stopped, an **edit** (pencil) button appears on its card. Click it to open the configuration modal pre-filled with the current settings. Make your changes and click **Save Changes**. The new settings take effect the next time the stream is started.

> You cannot edit a running camera. Stop it first.

### Removing a Camera

Click the trash icon on the camera card. This stops the FFmpeg process and, if no other cameras are using the same RTSP port, also stops the MediaMTX instance for that port.

---

### Video Library

Click **📁 Videos** in the header to open the video library. This is where you manage the source footage available to camera streams.

**Uploading a file:**
- Drag and drop a video file onto the upload zone, or click the zone to open a file browser.
- A progress bar tracks large uploads.
- After upload the file is immediately available in the Add Camera dropdown.

**Deleting a file:**
- Each file in the library has a trash icon. Files currently in use by an active camera stream are labelled **in use** and cannot be deleted until that stream is removed.

Supported formats: `.mp4`, `.mkv`, `.avi`

---

### Adding an RPM Monitor

1. Click **+ Add RPM**.
2. Fill in the form:
   - **RPM Name** — a display label (e.g. "Lane 2 Entry")
   - **TCP Port** — the port this RPM will listen on (default: next available port starting at 10001). Each RPM requires its own unique port.
3. Expand **Advanced Settings** to configure the simulation physics (optional — defaults match a typical VM250 deployment):

| Setting | Default | Description |
|---|---|---|
| Gamma Background | 120 | Nominal gamma detector counts per second |
| Neutron Background | 2 | Nominal neutron detector counts per second |
| Gamma Alarm σ | 4.0 | Standard deviations above background to trigger a gamma alarm |
| Neutron Alarm σ | 7.0 | Standard deviations above background to trigger a neutron alarm |
| Occupancy Frequency | 0.1 | Probability (0–1) of a vehicle occupancy starting each 5-second cycle |
| Occupancy Duration | 6,10 | Random vehicle transit time range in seconds (min,max) |
| Gamma Alarm Probability | 0.05 | Probability (0–1) that an occupancy contains a gamma alarm source |
| Neutron Alarm Probability | 0.01 | Probability (0–1) that an occupancy contains a neutron alarm source |
| Unique Alarm Probability | 0.0 | Probability (0–1) that an alarm uses spatially-unique source geometry |

4. Click **Start RPM**.

The RPM card shows the current **state** (IDLE / OCCUPIED), **connected clients**, and running **occupancy count**. State and alarm badges refresh every 3 seconds.

### Stopping and Starting an RPM Monitor

Each RPM card has a **stop** button while active and a **play** button while stopped. Stopping an RPM shuts down the TCP server but retains the configuration. The stopped/running state persists across service restarts.

### Editing an RPM Monitor

While an RPM is stopped, an **edit** button appears on its card. Click it to open the configuration modal pre-filled with all current settings. Save changes and start the monitor when ready.

> You cannot edit a running RPM. Stop it first.

### Triggering Alarms Manually

Running RPM cards have two alarm trigger buttons:

| Button | Label | Action |
|---|---|---|
| Gamma alarm | **γ** (orange) | Immediately starts an alarming occupancy with a gamma source |
| Neutron alarm | **n** (purple) | Immediately starts an alarming occupancy with a neutron source |

Clicking either button forces the RPM into OCCUPIED state with the corresponding alarm flag set, generating the appropriate `GA`/`NA` scan messages. If the RPM is already in an occupancy, the alarm flag is added to the current transit. The occupancy runs for a randomised duration drawn from the configured **Occupancy Duration** range and then returns to IDLE automatically.

### Removing an RPM Monitor

Click the trash icon on the RPM card. The TCP server is stopped and the port is released immediately.

---

## Connecting to an RPM Monitor

RPMs stream raw ASCII text over a persistent TCP connection. Connect with any TCP client:

```bash
nc <container-ip> <port>
```

### Message format

Each line is terminated with `\r\n`.

| Message | When | Format | Description |
|---|---|---|---|
| `GB` | IDLE (every 5s) | `GB,ddd,ddd,ddd,ddd` | Gamma background counts |
| `NB` | IDLE (every 5s) | `NB,ddd,ddd,ddd,ddd` | Neutron background counts |
| `GS` | OCCUPIED (every 200ms) | `GS,ddd,ddd,ddd,ddd` | Gamma scan, no alarm |
| `GA` | OCCUPIED (every 200ms) | `GA,ddd,ddd,ddd,ddd` | Gamma scan, alarm latched |
| `NS` | OCCUPIED (every 1s) | `NS,ddd,ddd,ddd,ddd` | Neutron scan, no alarm |
| `NA` | OCCUPIED (every 1s) | `NA,ddd,ddd,ddd,ddd` | Neutron scan, alarm latched |
| `GX` | End of occupancy | `GX,NNNNNN,NNNNNN,000000,000000` | Occupancy summary (ID count, neutron cumulative) |

The four data fields represent the four detector channels: **Driver Bottom**, **Driver Top**, **Passenger Bottom**, **Passenger Top**.

---

## Data Persistence

Camera and RPM configurations are saved automatically to:

- `/opt/lanesim/data/cameras.json`
- `/opt/lanesim/data/rpms.json`

These files are written atomically (write to `.tmp`, then rename) to prevent corruption on power loss. Each entry records both the device configuration and its last running state. When the service starts, devices that were running are restarted automatically; devices that were manually stopped remain stopped.

To reset all configuration, stop the service and delete both files:

```bash
systemctl stop lanesim
rm /opt/lanesim/data/cameras.json /opt/lanesim/data/rpms.json
systemctl start lanesim
```

---

## Adding Video Files After Installation

The preferred method is the **📁 Videos** button in the web UI — drag and drop or browse to upload, no shell access needed (see [Video Library](#video-library)).

Alternatively, copy files directly to the server. No restart is required.

```bash
cp /path/to/footage.mp4 /opt/lanesim/videos/
chown lanesim:lanesim /opt/lanesim/videos/footage.mp4
```

---

## Logs

| Log | Location | Contents |
|---|---|---|
| Service logs | `journalctl -u lanesim -f` | Python application stdout/stderr |
| MediaMTX logs | `/opt/lanesim/logs/mediamtx_<port>.log` | One file per RTSP port |
| FFmpeg logs | `/opt/lanesim/logs/ffmpeg_<id>.log` | One file per camera stream |

---

## Port Reference

| Port | Protocol | Purpose |
|---|---|---|
| 8000 | HTTP | Web management UI |
| 9001+ (default) | RTSP/TCP | Camera streams (auto-assigned from 9001, configurable per camera) |
| 10001+ (default) | TCP ASCII | RPM data streams (auto-assigned from 10001, configurable per RPM) |

All ports above 1024 — no special privileges required.

---

## Upgrading

To update the application files after making changes:

```bash
cd /tmp/lanesim          # updated source directory
sudo bash install.sh     # re-copies files, re-installs Python deps
sudo systemctl restart lanesim
```

Existing `data/cameras.json` and `data/rpms.json` are preserved; `install.sh` only copies `.py` files and the `static/` and `routers/` directories.

---

## Troubleshooting

**Service fails to start**
```bash
journalctl -u lanesim -n 50
```
Common causes: Python dependency missing (re-run `install.sh`), port 8000 already in use.

**Camera shows "Stopped" immediately after adding**
- Check that the video file exists in `/opt/lanesim/videos/`
- Check the FFmpeg log: `/opt/lanesim/logs/ffmpeg_<id>.log`
- Confirm `ffmpeg` is installed: `ffmpeg -version`

**MediaMTX fails to start**
- Check the MediaMTX log: `/opt/lanesim/logs/mediamtx_<port>.log`
- Confirm the binary is executable: `ls -la /opt/lanesim/bin/mediamtx`
- Confirm no other process is using the port: `ss -tlnp | grep <port>`

**Cannot connect to RPM TCP port**
- Confirm the RPM is shown as "Active" in the web UI
- Check the container firewall: `ufw status` or `iptables -L`
- Confirm the port is listening: `ss -tlnp | grep <port>`

**Port conflict error when adding a device**
Both cameras and RPMs track used ports. If you see a 409 error, choose a different port. Camera RTSP ports can be shared across multiple camera streams — the conflict check only prevents assigning an RPM port that's already in use by another RPM or camera, and vice versa.
