import logging
import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

from app.routes.auth import router as auth_router
from app.routes.leads import router as leads_router
from app.routes.campaigns import router as campaigns_router
from app.routes.settings import router as settings_router
from app.routes.uploads import router as uploads_router
from app.routes.enrichment import router as enrichment_router
from app.routes.product_campaigns import router as product_campaigns_router
from app.routes.products import router as products_router
from app.routes.whatsapp import router as whatsapp_router

app = FastAPI(title="LeadGen AI", version="1.0.0")

# CORS — only needed when React dev server runs separately (port 3000/5173)
# from the API (port 8000). The regex covers any device on the local
# network hitting the dev frontend by IP, since that IP can change (DHCP)
# or differ per machine.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[os.getenv("FRONTEND_URL", "http://localhost:3000")],
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}):(3000|5173)",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- API routes (must be registered before the SPA catch-all) ---
app.include_router(auth_router)
app.include_router(leads_router)
app.include_router(campaigns_router)
app.include_router(settings_router)
app.include_router(uploads_router)
app.include_router(enrichment_router)
app.include_router(product_campaigns_router)
app.include_router(products_router)
app.include_router(whatsapp_router)


@app.get("/health")
def health():
    return {"status": "ok", "service": "LeadGen AI"}


# --- Serve React production build ---
FRONTEND_BUILD = Path(__file__).parent.parent / "frontend" / "build"

if FRONTEND_BUILD.exists():
    # Serve JS/CSS/media assets that CRA puts under /static
    app.mount("/static", StaticFiles(directory=FRONTEND_BUILD / "static"), name="static-assets")

    # index.html must never be cached, otherwise browsers keep pointing at an
    # old (and now-deleted) hashed JS bundle after a rebuild. The hashed assets
    # under /static are content-addressed and safe to cache.
    _NO_CACHE = {"Cache-Control": "no-cache, no-store, must-revalidate"}

    @app.get("/{full_path:path}")
    def serve_spa(full_path: str):
        # Serve other root-level files (favicon, manifest, etc.) if they exist
        candidate = FRONTEND_BUILD / full_path
        if candidate.exists() and candidate.is_file():
            return FileResponse(str(candidate))
        return FileResponse(str(FRONTEND_BUILD / "index.html"), headers=_NO_CACHE)
else:
    logger.warning(
        "React build not found at %s — run `npm run build` inside the frontend folder first.",
        FRONTEND_BUILD,
    )


@app.on_event("startup")
def startup():
    try:
        from app.models.database import init_db
        init_db()
        logger.info("Database initialised")
    except Exception as exc:
        logger.error("Database init failed: %s", exc)

    try:
        from app.models.product_campaigns_models import migrate_product_campaigns
        migrate_product_campaigns()
    except Exception as exc:
        logger.error("Product campaigns migration failed: %s", exc)

    try:
        from app.scheduler.tasks import start_scheduler
        start_scheduler()
        logger.info("Scheduler started")
    except Exception as exc:
        logger.error("Scheduler start failed: %s", exc)


@app.on_event("shutdown")
def shutdown():
    try:
        from app.scheduler.tasks import stop_scheduler
        stop_scheduler()
    except Exception:
        pass


if __name__ == "__main__":
    # host="0.0.0.0" so the app is reachable from other devices on the
    # network, not just from this machine — `uvicorn main:app` alone
    # defaults to 127.0.0.1 and silently breaks client access.
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
