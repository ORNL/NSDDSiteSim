import uuid
from fastapi import APIRouter, HTTPException, Request, Query
from typing import List, Optional

from models import MobileConfig, MobileResponse, MobileStatus
from mobile_sim import ISOTOPES

router = APIRouter(prefix="/api/mobiles", tags=["mobiles"])


def _get_manager(request: Request):
    return request.app.state.mobile_manager


def _all_used_ports(request: Request) -> set:
    s = request.app.state
    return (s.mobile_manager.get_used_ports()
            | s.rpm_manager.get_used_ports()
            | s.camera_manager.get_used_ports())


@router.get("", response_model=List[MobileResponse])
def get_mobiles(request: Request):
    return _get_manager(request).get_status()


# Static path — must be declared before the /{mobile_id} routes.
@router.get("/isotopes")
def get_isotopes():
    return {"isotopes": [{"name": name, "peak_kev": kev} for name, kev in ISOTOPES.items()]}


@router.post("")
async def create_mobile(config: MobileConfig, request: Request):
    if config.port in _all_used_ports(request):
        raise HTTPException(status_code=409, detail=f"Port {config.port} is already in use")

    mobile_id = str(uuid.uuid4())[:8]
    success, message = await _get_manager(request).add_mobile(mobile_id, config)
    if not success:
        raise HTTPException(status_code=400, detail=message)
    return {"id": mobile_id, "message": message}


@router.post("/{mobile_id}/stop")
async def stop_mobile(mobile_id: str, request: Request):
    if not await _get_manager(request).stop_mobile(mobile_id):
        raise HTTPException(status_code=404, detail="Mobile detector not found or not running")
    return {"message": "Mobile detector stopped"}


@router.post("/{mobile_id}/start")
async def start_mobile(mobile_id: str, request: Request):
    ok, message = await _get_manager(request).start_mobile(mobile_id)
    if not ok:
        raise HTTPException(status_code=400, detail=message)
    return {"message": message}


@router.put("/{mobile_id}")
def update_mobile_config(mobile_id: str, config: MobileConfig, request: Request):
    manager = _get_manager(request)

    current = next((m for m in manager.get_status() if m["id"] == mobile_id), None)
    if current is None:
        raise HTTPException(status_code=404, detail="Mobile detector not found")
    if current["running"]:
        raise HTTPException(status_code=409, detail="Stop the mobile detector before editing")

    # Port conflict check, excluding this device's own current port
    if config.port != current["port"]:
        if config.port in (_all_used_ports(request) - {current["port"]}):
            raise HTTPException(status_code=409, detail=f"Port {config.port} is already in use")

    ok, message = manager.update_mobile(mobile_id, config)
    if not ok:
        raise HTTPException(status_code=400, detail=message)
    return {"message": message}


@router.delete("/{mobile_id}")
async def delete_mobile(mobile_id: str, request: Request):
    if not await _get_manager(request).remove_mobile(mobile_id):
        raise HTTPException(status_code=404, detail="Mobile detector not found")
    return {"message": "Mobile detector stopped and removed"}


@router.post("/{mobile_id}/trigger")
def trigger_mobile_alarm(
    mobile_id: str,
    request: Request,
    isotope: Optional[str] = Query(None, description="Override the configured isotope for this episode"),
):
    started = _get_manager(request).trigger_alarm(mobile_id, isotope)
    if started is None:
        raise HTTPException(status_code=404, detail="Mobile detector not found or not running")
    if not started:
        return {"message": "Alarm episode already active"}
    return {"message": "Alarm episode started"}


@router.get("/{mobile_id}/status", response_model=MobileStatus)
def get_mobile_status(mobile_id: str, request: Request):
    status = _get_manager(request).get_mobile_status(mobile_id)
    if status is None:
        raise HTTPException(status_code=404, detail="Mobile detector not found or not running")
    return {"id": mobile_id, **status}
