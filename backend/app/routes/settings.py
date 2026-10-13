import os
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from groq import Groq
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.models.database import Setting, get_db
from app.services.email_sender import send_email, get_last_error, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD

router = APIRouter(prefix="/api/settings", tags=["settings"])


# ---------- Pydantic schemas ----------

class SettingsUpdate(BaseModel):
    groq_api_key: Optional[str] = None
    maps_api_key: Optional[str] = None
    schedule_days: Optional[int] = None
    email_template: Optional[str] = None
    company_name: Optional[str] = None
    company_service: Optional[str] = None


class TestEmailRequest(BaseModel):
    to_email: Optional[str] = None


# ---------- Routes ----------

@router.get("")
def get_settings(db: Session = Depends(get_db)):
    settings = db.query(Setting).first()
    if not settings:
        raise HTTPException(status_code=404, detail="Settings not found")
    return {
        "success": True,
        "data": _settings_to_dict(settings),
        "message": "Settings retrieved",
    }


@router.put("")
def update_settings(payload: SettingsUpdate, db: Session = Depends(get_db)):
    settings = db.query(Setting).first()
    if not settings:
        settings = Setting()
        db.add(settings)

    if payload.groq_api_key is not None:
        settings.groq_api_key = payload.groq_api_key
    if payload.maps_api_key is not None:
        settings.maps_api_key = payload.maps_api_key
    if payload.schedule_days is not None:
        settings.schedule_days = payload.schedule_days
    if payload.email_template is not None:
        settings.email_template = payload.email_template
    if payload.company_name is not None:
        settings.company_name = payload.company_name
    if payload.company_service is not None:
        settings.company_service = payload.company_service

    db.commit()
    db.refresh(settings)
    return {
        "success": True,
        "data": _settings_to_dict(settings),
        "message": "Settings updated",
    }


@router.post("/test-email")
def test_email(payload: TestEmailRequest, db: Session = Depends(get_db)):
    settings = db.query(Setting).first()
    if not SMTP_USER or not SMTP_PASSWORD:
        raise HTTPException(status_code=400, detail="SMTP credentials not configured. Set SMTP_USER and SMTP_PASSWORD in .env.")

    recipient = payload.to_email if payload and payload.to_email else SMTP_USER
    success = send_email(
        to_email=recipient,
        subject="LeadGen AI — Test Email",
        body=(
            f"Hi,\n\nThis is a test email from your LeadGen AI system.\n\n"
            f"If you received this, your SMTP settings are working correctly.\n\n"
            f"— {(settings.company_name if settings else None) or 'LeadGen AI'}"
        ),
    )

    if not success:
        raise HTTPException(status_code=400, detail=get_last_error() or "Failed to send test email")

    return {
        "success": True,
        "data": {},
        "message": f"Test email sent to {recipient}",
    }


@router.post("/test-maps")
def test_maps(db: Session = Depends(get_db)):
    settings = db.query(Setting).first()
    api_key = (settings.maps_api_key if settings else None) or os.getenv("GOOGLE_MAPS_API_KEY", "")

    if not api_key:
        raise HTTPException(status_code=400, detail="Google Maps API key not configured")

    try:
        with httpx.Client(timeout=10) as client:
            response = client.get(
                "https://maps.googleapis.com/maps/api/place/textsearch/json",
                params={"query": "restaurant in London", "key": api_key},
            )
            data = response.json()
            status = data.get("status")

        if status in ("OK", "ZERO_RESULTS"):
            return {"success": True, "data": {"status": status}, "message": "Google Maps API key is valid"}

        return {
            "success": False,
            "data": {"status": status},
            "message": f"Google Maps API returned: {status}",
        }

    except Exception as exc:
        return {"success": False, "data": {}, "message": f"Connection error: {exc}"}


@router.post("/test-groq")
def test_groq(db: Session = Depends(get_db)):
    settings = db.query(Setting).first()
    api_key = (settings.groq_api_key if settings else None) or os.getenv("GROQ_API_KEY", "")

    if not api_key:
        raise HTTPException(status_code=400, detail="Groq API key not configured")

    try:
        client = Groq(api_key=api_key)
        response = client.chat.completions.create(
            model="llama3-8b-8192",
            messages=[{"role": "user", "content": "Say hello in one word."}],
            max_tokens=10,
        )
        reply = response.choices[0].message.content.strip()
        return {"success": True, "data": {"reply": reply}, "message": "Groq API key is valid"}

    except Exception as exc:
        return {"success": False, "data": {}, "message": f"Groq API error: {exc}"}


# ---------- Helper ----------

def _settings_to_dict(s: Setting) -> dict:
    return {
        "id": s.id,
        "smtp_host": SMTP_HOST,
        "smtp_port": SMTP_PORT,
        "smtp_user": SMTP_USER,
        "smtp_configured": bool(SMTP_USER and SMTP_PASSWORD),
        "groq_api_key": s.groq_api_key,
        "maps_api_key": s.maps_api_key,
        "schedule_days": s.schedule_days,
        "email_template": s.email_template,
        "company_name": s.company_name,
        "company_service": s.company_service,
    }
