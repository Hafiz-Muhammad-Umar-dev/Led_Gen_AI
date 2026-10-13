import io
import logging
import re
import time
from datetime import datetime, timezone
from typing import Dict, List, Optional
import pandas as pd
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session
from app.models.database import SentEmail, Setting, UploadedLead, User, get_db
from app.routes.auth import get_current_user
from app.services.email_sender import send_email, SMTP_USER, SMTP_PASSWORD
from app.services.groq_writer import generate_email

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/uploads", tags=["uploads"])


class BulkRequest(BaseModel):
    lead_ids: List[int]


class SendRequest(BaseModel):
    lead_ids: List[int]
    overrides: Optional[Dict] = None  # {str(id): {"subject": ..., "body": ...}}


# ---------- Routes ----------

@router.post("/import")
async def import_leads(file: UploadFile = File(...), db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    filename = file.filename or "upload"
    if not re.search(r"\.(xlsx|csv)$", filename, re.IGNORECASE):
        raise HTTPException(status_code=400, detail="Only .xlsx and .csv files are supported.")

    safe_name = re.sub(r"[^a-zA-Z0-9_-]", "_", filename.rsplit(".", 1)[0])
    batch = f"{safe_name}_{int(time.time())}"
    content = await file.read()

    try:
        if filename.lower().endswith(".csv"):
            df = pd.read_csv(io.BytesIO(content))
        else:
            df = pd.read_excel(io.BytesIO(content))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Failed to parse file: {exc}")

    df.columns = [str(c).strip().lower() for c in df.columns]

    if "type" in df.columns and "industry_type" not in df.columns:
        df["industry_type"] = df["type"]

    for col in ("company_name", "email"):
        if col not in df.columns:
            raise HTTPException(
                status_code=400,
                detail=f"Missing required column: '{col}'. Expected: company_name, email, type, remarks",
            )

    imported = 0
    skipped = 0

    for _, row in df.iterrows():
        company = str(row.get("company_name", "") or "").strip()
        email = str(row.get("email", "") or "").strip()

        if not company or company.lower() == "nan" or not email or email.lower() == "nan":
            skipped += 1
            continue

        industry = str(row.get("industry_type", "") or "").strip()
        if industry.lower() == "nan":
            industry = ""

        remarks = str(row.get("remarks", "") or "").strip()
        if remarks.lower() == "nan":
            remarks = ""

        db.add(UploadedLead(
            user_id=current_user.id,
            company_name=company,
            email=email,
            industry_type=industry or None,
            remarks=remarks or None,
            email_status="pending",
            upload_batch=batch,
        ))
        imported += 1

    db.commit()
    return {"imported": imported, "skipped": skipped, "batch": batch}


@router.get("/list")
def list_leads(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    leads = db.query(UploadedLead).filter(UploadedLead.user_id == current_user.id).order_by(UploadedLead.created_at.desc()).all()
    return {"success": True, "data": [_to_dict(l) for l in leads]}


@router.post("/generate-emails")
def generate_emails(payload: BulkRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    settings = db.query(Setting).first()
    sender_name = (settings.company_name or "Industronics") if settings else "Industronics"
    groq_key = (settings.groq_api_key or "") if settings else ""
    results = []
    for lead_id in payload.lead_ids:
        lead = db.query(UploadedLead).filter(UploadedLead.id == lead_id, UploadedLead.user_id == current_user.id).first()
        if not lead:
            results.append({"id": lead_id, "error": "Not found"})
            continue
        try:
            data = generate_email(
                {"company_name": lead.company_name or "", "industry_type": lead.industry_type or "", "remarks": lead.remarks or ""},
                company_name=sender_name,
                api_key=groq_key,
            )
            lead.email_subject = data["subject"]
            lead.email_body = data["body"]
            db.commit()
            results.append({
                "id": lead_id,
                "company_name": lead.company_name,
                "subject": data["subject"],
                "body": data["body"],
            })
        except Exception as exc:
            logger.error("Groq error for uploaded lead %d: %s", lead_id, exc)
            results.append({"id": lead_id, "error": str(exc)})

    return {"success": True, "data": results}


@router.post("/send-emails")
def send_emails(payload: SendRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    settings = db.query(Setting).first()
    if not SMTP_USER or not SMTP_PASSWORD:
        raise HTTPException(status_code=400, detail="SMTP credentials not configured. Set SMTP_USER and SMTP_PASSWORD in .env.")

    overrides = payload.overrides or {}
    sent = []
    failed = []

    for lead_id in payload.lead_ids:
        lead = db.query(UploadedLead).filter(UploadedLead.id == lead_id, UploadedLead.user_id == current_user.id).first()
        if not lead:
            failed.append({"id": lead_id, "reason": "Not found"})
            continue

        if not lead.email:
            lead.email_status = "failed"
            db.commit()
            failed.append({"id": lead_id, "company_name": lead.company_name, "reason": "no email"})
            continue

        override = overrides.get(str(lead_id))
        if override:
            subject = override.get("subject") or lead.email_subject
            body = override.get("body") or lead.email_body
            lead.email_subject = subject
            lead.email_body = body
            db.commit()
        else:
            subject = lead.email_subject
            body = lead.email_body

        if not subject or not body:
            try:
                data = generate_email(
                    {"company_name": lead.company_name or "", "industry_type": lead.industry_type or "", "remarks": lead.remarks or ""},
                    company_name=(settings.company_name or "Industronics") if settings else "Industronics",
                    api_key=(settings.groq_api_key or "") if settings else "",
                )
                subject = data["subject"]
                body = data["body"]
                lead.email_subject = subject
                lead.email_body = body
                db.commit()
            except Exception as exc:
                lead.email_status = "failed"
                db.commit()
                failed.append({"id": lead_id, "company_name": lead.company_name, "reason": f"generation failed: {exc}"})
                continue

        try:
            success = send_email(
                to_email=lead.email,
                subject=subject,
                body=body,
            )
            if success:
                lead.email_status = "sent"
                lead.email_sent_at = datetime.now(timezone.utc).isoformat()
                db.add(SentEmail(
                    lead_id=lead.id,
                    company_name=lead.company_name,
                    to_email=lead.email,
                    subject=subject,
                    body=body,
                    source="uploaded",
                ))
                db.commit()
                sent.append({"id": lead_id, "company_name": lead.company_name, "email": lead.email})
            else:
                lead.email_status = "failed"
                db.commit()
                failed.append({"id": lead_id, "company_name": lead.company_name, "reason": "SMTP error"})
        except Exception as exc:
            lead.email_status = "failed"
            db.commit()
            failed.append({"id": lead_id, "company_name": lead.company_name, "reason": str(exc)})

    return {
        "success": True,
        "data": {"sent": sent, "failed": failed},
        "message": f"{len(sent)} sent, {len(failed)} failed",
    }


@router.delete("/batch/{batch_name}")
def delete_batch(batch_name: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    deleted = (
        db.query(UploadedLead)
        .filter(UploadedLead.upload_batch == batch_name, UploadedLead.user_id == current_user.id)
        .delete(synchronize_session=False)
    )
    db.commit()
    return {"success": True, "deleted": deleted, "message": f"Deleted {deleted} leads from batch '{batch_name}'"}


# ---------- Helper ----------

def _to_dict(lead: UploadedLead) -> dict:
    return {
        "id": lead.id,
        "company_name": lead.company_name,
        "email": lead.email,
        "industry_type": lead.industry_type,
        "remarks": lead.remarks,
        "email_status": lead.email_status or "pending",
        "email_sent_at": lead.email_sent_at,
        "email_subject": lead.email_subject,
        "email_body": lead.email_body,
        "created_at": lead.created_at.isoformat() if lead.created_at else None,
        "upload_batch": lead.upload_batch,
    }
