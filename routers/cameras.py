import os
import uuid
import asyncio
from pathlib import Path
from fastapi import APIRouter, HTTPException, Request, UploadFile, File
from typing import List

from models import CameraConfig, CameraResponse

router = APIRouter(prefix="/api/cameras", tags=["cameras"])

_ALLOWED_EXTENSIONS = {'.mp4', '.mkv', '.avi'}


def _get_manager(request: Request):
    return request.app.state.camera_manager


def _safe_filename(raw: str) -> str:
    """Strip directory components and validate extension."""
    name = os.path.basename(raw or 'upload')
    if Path(name).suffix.lower() not in _ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type. Allowed: {', '.join(_ALLOWED_EXTENSIONS)}"
        )
    return name


@router.get("/files")
def list_files(request: Request):
    from camera_manager import VIDEO_DIR
    files = [f for f in os.listdir(VIDEO_DIR) if Path(f).suffix.lower() in _ALLOWED_EXTENSIONS]
    return {"files": sorted(files)}


@router.post("/files")
async def upload_file(file: UploadFile = File(...)):
    from camera_manager import VIDEO_DIR
    filename = _safe_filename(file.filename or 'upload')
    dest = VIDEO_DIR / filename
    if dest.exists():
        raise HTTPException(status_code=409, detail=f"'{filename}' already exists")
    try:
        with open(dest, 'wb') as f:
            while chunk := await file.read(1024 * 1024):  # 1 MB chunks
                f.write(chunk)
    except Exception as e:
        dest.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"Upload failed: {e}")
    return {"filename": filename}


@router.delete("/files/{filename}")
def delete_file(filename: str, request: Request):
    from camera_manager import VIDEO_DIR
    filename = _safe_filename(filename)
    dest = VIDEO_DIR / filename
    if not dest.exists():
        raise HTTPException(status_code=404, detail="File not found")
    manager = _get_manager(request)
    if filename in manager.get_files_in_use():
        raise HTTPException(status_code=409, detail=f"'{filename}' is in use by an active stream")
    dest.unlink()
    return {"message": f"'{filename}' deleted"}


@router.get("", response_model=List[CameraResponse])
def get_cameras(request: Request):
    manager = _get_manager(request)
    status = manager.get_status()
    return [
        {
            "id": s["id"],
            "name": s["config"]["name"],
            "url": s["url"],
            "running": s["running"],
            "config": s["config"],
        }
        for s in status
    ]


@router.post("")
async def create_camera(config: CameraConfig, request: Request):
    manager = _get_manager(request)
    rpm_manager = request.app.state.rpm_manager
    mobile_manager = request.app.state.mobile_manager

    non_camera_ports = rpm_manager.get_used_ports() | mobile_manager.get_used_ports()
    if config.port in non_camera_ports:
        raise HTTPException(status_code=409, detail=f"Port {config.port} is already in use")
    if (config.port, config.path.lstrip("/")) in manager.get_used_endpoints():
        raise HTTPException(
            status_code=409,
            detail=f"RTSP endpoint port {config.port} path '/{config.path.lstrip('/')}' is already in use"
        )

    stream_id = str(uuid.uuid4())[:8]
    loop = asyncio.get_running_loop()
    success, message = await loop.run_in_executor(
        None, manager.add_stream, stream_id, config.model_dump()
    )
    if not success:
        raise HTTPException(status_code=400, detail=message)
    return {"id": stream_id, "message": message}


@router.post("/{stream_id}/stop")
async def stop_camera(stream_id: str, request: Request):
    manager = _get_manager(request)
    loop = asyncio.get_running_loop()
    ok = await loop.run_in_executor(None, manager.stop_stream, stream_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Camera not found or not running")
    return {"message": "Stream stopped"}


@router.post("/{stream_id}/start")
async def start_camera(stream_id: str, request: Request):
    manager = _get_manager(request)
    loop = asyncio.get_running_loop()
    ok, message = await loop.run_in_executor(None, manager.start_stream, stream_id)
    if not ok:
        raise HTTPException(status_code=400, detail=message)
    return {"message": message}


@router.put("/{stream_id}")
def update_camera(stream_id: str, config: CameraConfig, request: Request):
    manager = _get_manager(request)
    rpm_manager = request.app.state.rpm_manager
    mobile_manager = request.app.state.mobile_manager

    all_status = manager.get_status()
    current = next((s for s in all_status if s["id"] == stream_id), None)
    if current is None:
        raise HTTPException(status_code=404, detail="Camera not found")
    if current["running"]:
        raise HTTPException(status_code=409, detail="Stop the stream before editing")

    # Port/path conflict check, excluding this stream's own current endpoint
    non_camera_ports = rpm_manager.get_used_ports() | mobile_manager.get_used_ports()
    if config.port in non_camera_ports:
        raise HTTPException(status_code=409, detail=f"Port {config.port} is already in use")
    if (config.port, config.path.lstrip("/")) in manager.get_used_endpoints(exclude_id=stream_id):
        raise HTTPException(
            status_code=409,
            detail=f"RTSP endpoint port {config.port} path '/{config.path.lstrip('/')}' is already in use"
        )

    ok, message = manager.update_stream(stream_id, config.model_dump())
    if not ok:
        raise HTTPException(status_code=400, detail=message)
    return {"message": message}


@router.delete("/{stream_id}")
def delete_camera(stream_id: str, request: Request):
    manager = _get_manager(request)
    if not manager.remove_stream(stream_id):
        raise HTTPException(status_code=404, detail="Camera not found")
    return {"message": "Camera stopped and removed"}
