import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from camera_manager import CameraManager, VIDEO_DIR
from rpm_manager import RPMManager
from routers import cameras, rpms

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)

BASE_DIR = Path(__file__).resolve().parent


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    VIDEO_DIR.mkdir(exist_ok=True)
    loop = asyncio.get_running_loop()

    # Restore cameras (subprocess-based, run in executor to avoid blocking the loop)
    await loop.run_in_executor(None, app.state.camera_manager.start_all)

    # Restore RPM servers (async, runs in this event loop)
    await app.state.rpm_manager.start_all()

    yield

    # Shutdown
    await app.state.rpm_manager.stop_all()
    app.state.camera_manager.stop_all()


app = FastAPI(title="Lane Simulator", lifespan=lifespan)

# Attach manager instances to app state before lifespan runs
app.state.camera_manager = CameraManager()
app.state.rpm_manager = RPMManager()

app.include_router(cameras.router)
app.include_router(rpms.router)

# Serve static UI — must be mounted last so API routes take priority
app.mount("/", StaticFiles(directory=str(BASE_DIR / "static"), html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
