import time
import uuid
from fastapi import APIRouter, HTTPException, Request, Query
from typing import List

from models import RPMConfig, RPMResponse, RPMStatus

router = APIRouter(prefix="/api/rpms", tags=["rpms"])


def _get_manager(request: Request):
    return request.app.state.rpm_manager


@router.get("", response_model=List[RPMResponse])
def get_rpms(request: Request):
    manager = _get_manager(request)
    return manager.get_status()


# Declared before the /{rpm_id} routes so "clock" isn't captured as an ID —
# same ordering constraint as /api/mobiles/isotopes.
@router.get("/clock")
def get_clock():
    """The service's wall clock. Traffic profiles are keyed to this, not to the
    browser's timezone, so the editor labels its hour axis with it."""
    lt = time.localtime()
    return {
        "timezone": time.strftime("%Z", lt),
        "utc_offset_hours": -(time.altzone if lt.tm_isdst else time.timezone) / 3600.0,
        "hour": lt.tm_hour,
        "minute": lt.tm_min,
        "wday": lt.tm_wday,  # 0=Mon .. 6=Sun
    }


@router.post("")
async def create_rpm(config: RPMConfig, request: Request):
    manager = _get_manager(request)
    camera_manager = request.app.state.camera_manager
    mobile_manager = request.app.state.mobile_manager

    used = manager.get_used_ports() | camera_manager.get_used_ports() | mobile_manager.get_used_ports()
    if config.port in used:
        raise HTTPException(status_code=409, detail=f"Port {config.port} is already in use")

    rpm_id = str(uuid.uuid4())[:8]
    success, message = await manager.add_rpm(rpm_id, config)
    if not success:
        raise HTTPException(status_code=400, detail=message)
    return {"id": rpm_id, "message": message}


@router.post("/{rpm_id}/stop")
async def stop_rpm(rpm_id: str, request: Request):
    manager = _get_manager(request)
    ok = await manager.stop_rpm(rpm_id)
    if not ok:
        raise HTTPException(status_code=404, detail="RPM not found or not running")
    return {"message": "RPM stopped"}


@router.post("/{rpm_id}/start")
async def start_rpm(rpm_id: str, request: Request):
    manager = _get_manager(request)
    ok, message = await manager.start_rpm(rpm_id)
    if not ok:
        raise HTTPException(status_code=400, detail=message)
    return {"message": message}


@router.put("/{rpm_id}")
def update_rpm_config(rpm_id: str, config: RPMConfig, request: Request):
    manager = _get_manager(request)
    camera_manager = request.app.state.camera_manager
    mobile_manager = request.app.state.mobile_manager

    all_status = manager.get_status()
    current = next((r for r in all_status if r["id"] == rpm_id), None)
    if current is None:
        raise HTTPException(status_code=404, detail="RPM not found")
    if current["running"]:
        raise HTTPException(status_code=409, detail="Stop the RPM before editing")

    # Port conflict check, excluding this RPM's own current port
    if config.port != current["port"]:
        used = (manager.get_used_ports() - {current["port"]}) | camera_manager.get_used_ports() \
            | mobile_manager.get_used_ports()
        if config.port in used:
            raise HTTPException(status_code=409, detail=f"Port {config.port} is already in use")

    ok, message = manager.update_rpm(rpm_id, config)
    if not ok:
        raise HTTPException(status_code=400, detail=message)
    return {"message": message}


@router.delete("/{rpm_id}")
async def delete_rpm(rpm_id: str, request: Request):
    manager = _get_manager(request)
    if not await manager.remove_rpm(rpm_id):
        raise HTTPException(status_code=404, detail="RPM not found")
    return {"message": "RPM stopped and removed"}


@router.post("/{rpm_id}/trigger")
def trigger_rpm_alarm(
    rpm_id: str,
    request: Request,
    gamma: bool = Query(False),
    neutron: bool = Query(False),
):
    manager = _get_manager(request)
    if not gamma and not neutron:
        raise HTTPException(status_code=400, detail="Specify at least one of gamma=true or neutron=true")
    ok = manager.trigger_alarm(rpm_id, gamma=gamma, neutron=neutron)
    if not ok:
        raise HTTPException(status_code=404, detail="RPM not found or not running")
    return {"message": "Alarm triggered"}


_VALID_FAULT_TYPES = {"gh", "gl", "nh", "tamper"}


@router.post("/{rpm_id}/fault")
def set_rpm_fault(
    rpm_id: str,
    request: Request,
    type: str = Query(..., description="Fault type: gh, gl, nh, or tamper"),
    active: bool = Query(..., description="True to assert the fault, false to clear it"),
):
    if type not in _VALID_FAULT_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid fault type {type!r}. Must be one of: {sorted(_VALID_FAULT_TYPES)}",
        )
    manager = _get_manager(request)
    if not manager.set_fault(rpm_id, type, active):
        raise HTTPException(status_code=404, detail="RPM not found or not running")
    return {"message": f"Fault {type} set to {active}"}


@router.get("/{rpm_id}/status", response_model=RPMStatus)
def get_rpm_status(rpm_id: str, request: Request):
    manager = _get_manager(request)
    status = manager.get_rpm_status(rpm_id)
    if status is None:
        raise HTTPException(status_code=404, detail="RPM not found or not running")
    return {"id": rpm_id, **status}
