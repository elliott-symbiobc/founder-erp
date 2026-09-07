"""
settings.py — Platform settings (logo upload, etc.)

GET  /settings/logo   — serve the current logo (public)
POST /settings/logo   — upload a new logo (auth required)
DELETE /settings/logo — reset to default (auth required)
"""

import os
import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, UploadFile, File
from fastapi.responses import FileResponse, Response

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/settings", tags=["settings"])

LOGO_PATH = Path("/app/uploads/logo.png")
ALLOWED_TYPES = {"image/png", "image/jpeg", "image/svg+xml", "image/webp"}
MAX_SIZE = 5 * 1024 * 1024  # 5 MB


def _require_user(request: Request) -> str:
    uid = request.headers.get("X-User-Id")
    if not uid:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return uid


@router.get("/logo")
def get_logo():
    if not LOGO_PATH.exists():
        raise HTTPException(status_code=404, detail="No custom logo uploaded")
    return FileResponse(
        str(LOGO_PATH),
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=3600"},
    )


@router.post("/logo")
async def upload_logo(request: Request, file: UploadFile = File(...)):
    _require_user(request)

    content_type = file.content_type or ""
    if content_type not in ALLOWED_TYPES:
        raise HTTPException(status_code=400, detail=f"File type not allowed: {content_type}. Use PNG, JPEG, SVG, or WebP.")

    data = await file.read()
    if len(data) > MAX_SIZE:
        raise HTTPException(status_code=400, detail="File too large (max 5 MB)")

    LOGO_PATH.parent.mkdir(parents=True, exist_ok=True)
    LOGO_PATH.write_bytes(data)
    logger.info("Logo uploaded (%d bytes)", len(data))

    return {"ok": True, "size": len(data)}


@router.delete("/logo")
def delete_logo(request: Request):
    _require_user(request)
    if LOGO_PATH.exists():
        LOGO_PATH.unlink()
    return {"ok": True}
