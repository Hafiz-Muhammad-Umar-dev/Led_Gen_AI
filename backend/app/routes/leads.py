import asyncio
import csv
import io
import json
import logging
import os
import random
import re
import threading
import time
from datetime import datetime, timezone
from typing import List, Optional
import queue
import pandas as pd
from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session
from app.models.database import EmailLog, Lead, SentEmail, SessionLocal, Setting, UploadedLead, User, get_db
from app.routes.auth import get_current_user
from app.services.email_finder import find_email_from_website
from app.services.email_sender import send_email, get_last_error, SMTP_USER, SMTP_PASSWORD
from app.services.groq_writer import generate_email
from app.services.maps_scraper import search_places, search_places_stream
from app.services.playwright_scraper import scrape_official_stream

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/leads", tags=["leads"])


# ---------- Pydantic schemas ----------

class ScrapeRequest(BaseModel):
    keyword: str
    city: str


class LeadUpdate(BaseModel):
    status: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None


class SendEmailRequest(BaseModel):
    campaign_id: Optional[int] = None


class BulkLeadRequest(BaseModel):
    lead_ids: List[int]


class LeadCreate(BaseModel):
    business_name: str
    email: Optional[str] = None
    phone: Optional[str] = None
    address: Optional[str] = None
    website: Optional[str] = None
    category: Optional[str] = None
    city: Optional[str] = None
    keyword: Optional[str] = None
    rating: Optional[float] = None


# ---------- Routes ----------

@router.get("")
def get_leads(
    status: Optional[str] = Query(None),
    city: Optional[str] = Query(None),
    keyword: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    source: Optional[str] = Query(None),
    campaign_id: Optional[int] = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    query = db.query(Lead).filter(Lead.user_id == current_user.id)

    if status:
        query = query.filter(Lead.status == status)
    if city:
        query = query.filter(Lead.city.ilike(f"%{city}%"))
    if keyword:
        query = query.filter(Lead.keyword.ilike(f"%{keyword}%"))
    if source:
        query = query.filter(Lead.source == source)
    if campaign_id is not None:
        query = query.filter(Lead.campaign_id == campaign_id)
    if search:
        query = query.filter(Lead.business_name.ilike(f"%{search}%"))

    total = query.count()
    leads = (
        query.order_by(Lead.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )

    return {
        "success": True,
        "data": [_lead_to_dict(l) for l in leads],
        "total": total,
        "page": page,
        "page_size": page_size,
        "message": "Leads retrieved",
    }


@router.post("")
def create_lead(payload: LeadCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    lead = Lead(
        user_id=current_user.id,
        business_name=payload.business_name,
        email=payload.email,
        phone=payload.phone or "",
        address=payload.address or "",
        website=payload.website or "",
        category=payload.category or "",
        city=payload.city or "",
        keyword=payload.keyword or "manual",
        rating=payload.rating,
        status="new",
    )
    db.add(lead)
    db.commit()
    db.refresh(lead)
    return {"success": True, "data": _lead_to_dict(lead), "message": "Lead created"}


@router.get("/export")
def export_leads(
    status: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    query = db.query(Lead).filter(Lead.user_id == current_user.id)
    if status:
        query = query.filter(Lead.status == status)
    leads = query.order_by(Lead.created_at.desc()).all()

    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=[
        "id", "business_name", "phone", "email", "address",
        "website", "category", "rating", "city", "keyword", "status", "created_at",
    ])
    writer.writeheader()
    for l in leads:
        writer.writerow({
            "id": l.id,
            "business_name": l.business_name,
            "phone": l.phone,
            "email": l.email,
            "address": l.address,
            "website": l.website,
            "category": l.category,
            "rating": l.rating,
            "city": l.city,
            "keyword": l.keyword,
            "status": l.status,
            "created_at": l.created_at,
        })

    output.seek(0)
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=leads.csv"},
    )


@router.get("/email-status")
def get_email_status(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    leads = db.query(Lead).filter(Lead.user_id == current_user.id).order_by(Lead.created_at.desc()).all()
    return {
        "success": True,
        "data": [
            {
                "id": l.id,
                "business_name": l.business_name,
                "email": l.email,
                "email_status": l.email_status or "pending",
                "email_sent_at": l.email_sent_at,
                "email_subject": l.email_subject,
            }
            for l in leads
        ],
        "message": "Email status retrieved",
    }


@router.get("/stats")
def get_dashboard_stats(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    leads_count = db.query(Lead).filter(Lead.user_id == current_user.id).count()
    uploaded_count = db.query(UploadedLead).filter(UploadedLead.user_id == current_user.id).count()
    emails_sent = (
        db.query(EmailLog)
        .join(Lead, Lead.id == EmailLog.lead_id)
        .filter(EmailLog.status == "sent", Lead.user_id == current_user.id)
        .count()
    )
    return {
        "total_leads": leads_count + uploaded_count,
        "emails_sent": emails_sent,
    }


@router.post("/generate-emails")
def generate_emails_bulk(payload: BulkLeadRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    settings = db.query(Setting).first()
    company_name = (settings.company_name or "Industronics") if settings else "Industronics"
    groq_key = (settings.groq_api_key or "") if settings else ""
    results = []
    for lead_id in payload.lead_ids:
        lead = db.query(Lead).filter(Lead.id == lead_id, Lead.user_id == current_user.id).first()
        if not lead:
            results.append({"lead_id": lead_id, "error": "Lead not found"})
            continue
        try:
            email_data = generate_email(_lead_to_dict(lead), company_name, groq_key)
            lead.email_subject = email_data["subject"]
            lead.email_body = email_data["body"]
            db.commit()
            results.append({
                "lead_id": lead_id,
                "business_name": lead.business_name,
                "subject": email_data["subject"],
                "body": email_data["body"],
            })
        except Exception as exc:
            logger.error("Email generation failed for lead %d: %s", lead_id, exc)
            results.append({"lead_id": lead_id, "error": str(exc)})
    return {
        "success": True,
        "data": results,
        "message": f"Generated emails for {len(results)} leads",
    }


@router.post("/send-emails")
def send_emails_bulk(payload: BulkLeadRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    settings = db.query(Setting).first()
    if not SMTP_USER or not SMTP_PASSWORD:
        raise HTTPException(status_code=400, detail="SMTP credentials not configured. Set SMTP_USER and SMTP_PASSWORD in .env.")

    sent = []
    failed = []

    for lead_id in payload.lead_ids:
        lead = db.query(Lead).filter(Lead.id == lead_id, Lead.user_id == current_user.id).first()
        if not lead:
            failed.append({"lead_id": lead_id, "reason": "Lead not found"})
            continue

        if not lead.email:
            lead.email_status = "failed"
            db.commit()
            failed.append({"lead_id": lead_id, "business_name": lead.business_name, "reason": "no email"})
            continue

        # Prevent duplicate sends within the same campaign.
        if lead.campaign_id is not None:
            already = (
                db.query(SentEmail)
                .filter(SentEmail.to_email == lead.email, SentEmail.campaign_id == lead.campaign_id)
                .first()
            )
            if already:
                lead.email_status = "duplicate"
                db.commit()
                failed.append({
                    "lead_id": lead_id,
                    "business_name": lead.business_name,
                    "reason": "duplicate — already emailed in this campaign",
                })
                continue

        subject = lead.email_subject
        body = lead.email_body
        if not subject or not body:
            try:
                email_data = generate_email(_lead_to_dict(lead), (settings.company_name or "Industronics") if settings else "Industronics", (settings.groq_api_key or "") if settings else "")
                subject = email_data["subject"]
                body = email_data["body"]
                lead.email_subject = subject
                lead.email_body = body
                db.commit()
            except Exception as exc:
                lead.email_status = "failed"
                db.commit()
                failed.append({"lead_id": lead_id, "business_name": lead.business_name, "reason": f"generation failed: {exc}"})
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
                lead.status = "contacted"
                db.add(SentEmail(
                    lead_id=lead.id,
                    campaign_id=lead.campaign_id,
                    company_name=lead.business_name,
                    to_email=lead.email,
                    subject=subject,
                    body=body,
                    source="uploaded" if lead.source == "sheet" else "scraped",
                ))
                db.commit()
                sent.append({"lead_id": lead_id, "business_name": lead.business_name, "email": lead.email})
            else:
                lead.email_status = "failed"
                db.commit()
                failed.append({"lead_id": lead_id, "business_name": lead.business_name, "reason": "SMTP error"})
        except Exception as exc:
            lead.email_status = "failed"
            db.commit()
            failed.append({"lead_id": lead_id, "business_name": lead.business_name, "reason": str(exc)})

    return {
        "success": True,
        "data": {"sent": sent, "failed": failed},
        "message": f"{len(sent)} sent, {len(failed)} failed",
    }


@router.post("/start-sending")
async def start_sending(payload: BulkLeadRequest, current_user: User = Depends(get_current_user)):
    """SSE endpoint — generates and sends emails one by one with a random delay between each lead."""
    user_id = current_user.id

    async def _generate():
        import queue as _q
        tq: _q.Queue = _q.Queue()

        db = SessionLocal()
        try:
            settings = db.query(Setting).first()
            if not SMTP_USER or not SMTP_PASSWORD:
                yield f"data: {json.dumps({'type': 'error', 'message': 'SMTP credentials not configured. Set SMTP_USER and SMTP_PASSWORD in .env.'})}\n\n"
                return
            company_name = (settings.company_name or "Industronics") if settings else "Industronics"
            groq_key = (settings.groq_api_key or "") if settings else ""
        finally:
            db.close()

        total = len(payload.lead_ids)

        def _process_in_thread():
            db2 = SessionLocal()
            sent_count = 0
            failed_count = 0
            try:
                for idx, lead_id in enumerate(payload.lead_ids):
                    lead = db2.query(Lead).filter(Lead.id == lead_id, Lead.user_id == user_id).first()

                    if not lead:
                        failed_count += 1
                        tq.put({
                            "type": "progress",
                            "lead_id": lead_id,
                            "company": "Unknown",
                            "status": "failed",
                            "reason": "lead not found",
                            "subject": "",
                            "progress": f"{idx + 1}/{total}",
                        })
                        continue

                    if lead.email_status == "sent":
                        tq.put({
                            "type": "progress",
                            "lead_id": lead.id,
                            "company": lead.business_name,
                            "status": "skipped",
                            "reason": "already sent",
                            "subject": lead.email_subject or "",
                            "progress": f"{idx + 1}/{total}",
                        })
                        continue

                    if not lead.email:
                        lead.email_status = "failed"
                        db2.commit()
                        failed_count += 1
                        tq.put({
                            "type": "progress",
                            "lead_id": lead.id,
                            "company": lead.business_name,
                            "status": "failed",
                            "reason": "no email address",
                            "subject": "",
                            "progress": f"{idx + 1}/{total}",
                        })
                        continue

                    # Prevent duplicate sends within the same campaign.
                    if lead.campaign_id is not None:
                        already = (
                            db2.query(SentEmail)
                            .filter(SentEmail.to_email == lead.email, SentEmail.campaign_id == lead.campaign_id)
                            .first()
                        )
                        if already:
                            lead.email_status = "duplicate"
                            db2.commit()
                            tq.put({
                                "type": "progress",
                                "lead_id": lead.id,
                                "company": lead.business_name,
                                "status": "skipped",
                                "reason": "duplicate — already emailed in this campaign",
                                "subject": lead.email_subject or "",
                                "progress": f"{idx + 1}/{total}",
                            })
                            continue

                    # Step 1 — Use email already in DB if available, else generate
                    subject = lead.email_subject
                    body = lead.email_body

                    if not subject or not body:
                        try:
                            email_data = generate_email(_lead_to_dict(lead), company_name, groq_key)
                            lead.email_subject = email_data["subject"]
                            lead.email_body = email_data["body"]
                            db2.commit()
                            db2.refresh(lead)
                            subject = lead.email_subject
                            body = lead.email_body
                        except Exception as exc:
                            lead.email_status = "failed"
                            db2.commit()
                            failed_count += 1
                            tq.put({
                                "type": "progress",
                                "lead_id": lead.id,
                                "company": lead.business_name,
                                "status": "failed",
                                "reason": f"email generation failed: {exc}",
                                "subject": "",
                                "progress": f"{idx + 1}/{total}",
                            })
                            continue

                    # Step 2 — subject and body are now from DB

                    # Step 4 — Send
                    try:
                        success = send_email(
                            to_email=lead.email,
                            subject=subject,
                            body=body,
                        )
                    except Exception as exc:
                        logger.error("SMTP error for lead %d: %s", lead.id, exc)
                        success = False

                    if success:
                        lead.email_status = "sent"
                        lead.email_sent_at = datetime.now(timezone.utc).isoformat()
                        lead.status = "contacted"
                        db2.add(SentEmail(
                            lead_id=lead.id,
                            campaign_id=lead.campaign_id,
                            company_name=lead.business_name,
                            to_email=lead.email,
                            subject=subject,
                            body=body,
                            source="uploaded" if lead.source == "sheet" else "scraped",
                        ))
                        db2.commit()
                        sent_count += 1
                        tq.put({
                            "type": "progress",
                            "lead_id": lead.id,
                            "company": lead.business_name,
                            "to_email": lead.email,
                            "status": "sent",
                            "reason": "",
                            "subject": subject,
                            "progress": f"{idx + 1}/{total}",
                        })
                    else:
                        lead.email_status = "failed"
                        db2.commit()
                        failed_count += 1
                        tq.put({
                            "type": "progress",
                            "lead_id": lead.id,
                            "company": lead.business_name,
                            "to_email": lead.email,
                            "status": "failed",
                            "reason": get_last_error() or "SMTP error",
                            "subject": subject,
                            "progress": f"{idx + 1}/{total}",
                        })

                    if idx < total - 1:
                        delay = random.randint(5, 10)
                        tq.put({"type": "delay", "seconds": delay})
                        for tick in range(delay):
                            time.sleep(1)
                            if tick < delay - 1:
                                tq.put({"type": "ping"})

                tq.put({"type": "complete", "sent": sent_count, "failed": failed_count})
            except Exception as exc:
                logger.error("Start sending thread error: %s", exc)
                tq.put({"type": "error", "message": str(exc)})
            finally:
                db2.close()
                tq.put(None)

        threading.Thread(target=_process_in_thread, daemon=True).start()

        try:
            while True:
                msg = await asyncio.to_thread(tq.get)
                if msg is None:
                    break
                if msg.get("type") == "ping":
                    yield ": ping\n\n"
                else:
                    yield f"data: {json.dumps(msg)}\n\n"
        except Exception as exc:
            logger.error("Start sending SSE error: %s", exc)
            yield f"data: {json.dumps({'type': 'error', 'message': str(exc)})}\n\n"

    return StreamingResponse(
        _generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@router.post("/upload-sheet")
async def upload_sheet(file: UploadFile = File(...), db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    filename = file.filename or "upload"
    if not re.search(r"\.(xlsx|csv)$", filename, re.IGNORECASE):
        raise HTTPException(status_code=400, detail="Only .xlsx and .csv files are supported.")

    content = await file.read()
    try:
        if filename.lower().endswith(".csv"):
            df = pd.read_csv(io.BytesIO(content))
        else:
            df = pd.read_excel(io.BytesIO(content))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Failed to parse file: {exc}")

    df.columns = [str(c).strip().lower() for c in df.columns]

    for col in ("company_name", "email"):
        if col not in df.columns:
            raise HTTPException(
                status_code=400,
                detail=f"Missing required column: '{col}'. Expected columns: company_name, email, type, remarks",
            )

    imported = 0
    skipped = 0

    for _, row in df.iterrows():
        company = str(row.get("company_name", "") or "").strip()
        email = str(row.get("email", "") or "").strip()

        if not company or company.lower() == "nan" or not email or email.lower() == "nan":
            skipped += 1
            continue

        if db.query(Lead).filter(Lead.email == email, Lead.source == "sheet", Lead.user_id == current_user.id).first():
            skipped += 1
            continue

        company_type = str(row.get("type", "") or "").strip()
        if company_type.lower() == "nan":
            company_type = ""

        remarks = str(row.get("remarks", "") or "").strip()
        if remarks.lower() == "nan":
            remarks = ""

        lead = Lead(
            user_id=current_user.id,
            business_name=company,
            email=email,
            category=company_type or None,
            remarks=remarks or None,
            source="sheet",
            status="new",
            email_status="pending",
        )
        db.add(lead)
        imported += 1

    db.commit()
    return {
        "success": True,
        "data": {"imported": imported, "skipped": skipped},
        "message": f"{imported} leads imported, {skipped} skipped",
    }


@router.get("/sheet-count")
def sheet_lead_count(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    total = db.query(Lead).filter(Lead.source == "sheet", Lead.user_id == current_user.id).count()
    pending = db.query(Lead).filter(Lead.source == "sheet", Lead.email_status == "pending", Lead.user_id == current_user.id).count()
    return {"success": True, "data": {"total": total, "pending": pending}}


@router.get("/{lead_id}")
def get_lead(lead_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    lead = db.query(Lead).filter(Lead.id == lead_id, Lead.user_id == current_user.id).first()
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    return {"success": True, "data": _lead_to_dict(lead), "message": "Lead retrieved"}


@router.get("/scrape/stream")
async def scrape_leads_stream(
    keyword: str = Query(..., min_length=1),
    city: str = Query(..., min_length=1),
    current_user: User = Depends(get_current_user),
):
    """
    SSE endpoint — truly real-time.
    The blocking scraper runs in a background thread and pushes each place
    into an asyncio.Queue so the async generator can yield it immediately.
    """
    user_id = current_user.id

    async def _generate():
        db = SessionLocal()
        queue: asyncio.Queue = asyncio.Queue()
        loop = asyncio.get_running_loop()

        try:
            settings = db.query(Setting).first()
            api_key  = (settings.maps_api_key if settings else None) or os.getenv("GEOAPIFY_API_KEY", "")

            if not api_key:
                yield f"data: {json.dumps({'type': 'error', 'message': 'Google Maps API key not configured. Add it in Settings.'})}\n\n"
                return

            yield f"data: {json.dumps({'type': 'start', 'message': f'Searching {keyword} in {city}…'})}\n\n"

            # Run the blocking API scraper in a thread so the event loop stays
            # free and every yielded place reaches the browser immediately.
            def _scrape_in_thread():
                try:
                    for place in search_places_stream(keyword, city, api_key):
                        loop.call_soon_threadsafe(queue.put_nowait, {"ok": True, "place": place})
                except Exception as exc:
                    loop.call_soon_threadsafe(queue.put_nowait, {"ok": False, "error": str(exc)})
                finally:
                    loop.call_soon_threadsafe(queue.put_nowait, None)  # sentinel — done

            thread = threading.Thread(target=_scrape_in_thread, daemon=True)
            thread.start()

            added = 0
            found = 0

            while True:
                item = await queue.get()

                if item is None:  # scraper finished
                    break

                if not item["ok"]:
                    yield f"data: {json.dumps({'type': 'error', 'message': item['error']})}\n\n"
                    break

                place = item["place"]
                found += 1

                pid = place.get("place_id")
                if pid:
                    exists = db.query(Lead).filter(Lead.place_id == pid, Lead.user_id == user_id).first()
                else:
                    exists = (
                        db.query(Lead)
                        .filter(Lead.business_name == place["business_name"], Lead.city == place["city"], Lead.user_id == user_id)
                        .first()
                    )

                if exists:
                    yield f"data: {json.dumps({'type': 'skip', 'business_name': place['business_name']})}\n\n"
                    continue

                if place.get("website"):
                    place["email"] = await asyncio.to_thread(find_email_from_website, place["website"])

                lead = Lead(
                    user_id=user_id,
                    place_id=pid,
                    business_name=place["business_name"],
                    phone=place.get("phone", ""),
                    address=place.get("address", ""),
                    website=place.get("website", ""),
                    email=place.get("email"),
                    category=place.get("category", ""),
                    rating=place.get("rating"),
                    city=city,
                    keyword=keyword,
                    status="new",
                )
                db.add(lead)
                db.commit()
                db.refresh(lead)
                added += 1

                payload = {
                    "type": "lead",
                    "id": lead.id,
                    "business_name": lead.business_name,
                    "phone": lead.phone or "",
                    "email": lead.email or "",
                    "website": lead.website or "",
                    "category": lead.category or "",
                    "city": lead.city,
                }
                yield f"data: {json.dumps(payload)}\n\n"

            yield f"data: {json.dumps({'type': 'done', 'found': found, 'added': added, 'message': f'Done — {added} new leads saved from {found} results'})}\n\n"

        except Exception as exc:
            logger.error("SSE scrape error: %s", exc)
            yield f"data: {json.dumps({'type': 'error', 'message': str(exc)})}\n\n"
        finally:
            db.close()

    return StreamingResponse(
        _generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@router.get("/scrape-playwright/stream")
async def scrape_playwright_leads_stream(
    query: str = Query(..., min_length=1),
    max_results: int = Query(20, ge=1, le=100),
    current_user: User = Depends(get_current_user),
):
    """SSE endpoint — runs Playwright scraper in a thread, streams each lead in real-time."""
    user_id = current_user.id

    async def _generate():
        import queue as _q
        import traceback as _tb
        db = SessionLocal()
        # Use a standard thread-safe queue — avoids asyncio event-loop cross-thread
        # callback issues (call_soon_threadsafe can silently drop on Windows/Python 3.12).
        tq: _q.Queue = _q.Queue()

        try:
            yield f"data: {json.dumps({'type': 'start', 'message': f'Starting Playwright scrape for: {query}'})}\n\n"

            def _scrape_in_thread():
                try:
                    api_key = os.getenv("GEOAPIFY_API_KEY", "").strip()

                    for event in scrape_official_stream(
                        query,
                        max_results,
                        api_key=api_key,
                    ):
                        tq.put({"ok": True, "item": event})

                except Exception as exc:
                    err_msg = str(exc) or type(exc).__name__
                    logger.error(
                        "Google Maps scraper thread error: %s\n%s",
                        err_msg,
                        _tb.format_exc(),
                    )
                    tq.put({"ok": False, "error": err_msg})

                finally:
                    tq.put(None)

            threading.Thread(target=_scrape_in_thread, daemon=True).start()

            added = 0
            skipped = 0

            while True:
                msg = await asyncio.to_thread(tq.get)

                if msg is None:
                    break

                if not msg["ok"]:
                    yield f"data: {json.dumps({'type': 'error', 'message': msg['error']})}\n\n"
                    break

                item = msg["item"]
                item_type = item.get("_type", "lead")

                if item_type == "progress":
                    yield f"data: {json.dumps({'type': 'progress', 'message': item['message']})}\n\n"
                    continue

                if item_type == "error":
                    yield f"data: {json.dumps({'type': 'skip', 'business_name': item.get('name', '')})}\n\n"
                    skipped += 1
                    continue

                name = item.get("name", "")
                maps_url = item.get("maps_url", "")

                exists = None
                if maps_url:
                    exists = db.query(Lead).filter(Lead.maps_url == maps_url, Lead.user_id == user_id).first()
                if not exists and name:
                    exists = db.query(Lead).filter(Lead.business_name == name, Lead.user_id == user_id).first()

                if exists:
                    yield f"data: {json.dumps({'type': 'skip', 'business_name': name})}\n\n"
                    skipped += 1
                    continue

                if item.get("website"):
                    item["email"] = await asyncio.to_thread(find_email_from_website, item["website"])

                lead = Lead(
                    user_id=user_id,
                    maps_url=maps_url,
                    business_name=name,
                    phone=item.get("phone") or "",
                    address=item.get("address") or "",
                    website=item.get("website") or "",
                    email=item.get("email"),
                    category=item.get("category") or "",
                    rating=item.get("rating"),
                    city=item.get("city") or "",
                    keyword=query,
                    status="new",
                )
                db.add(lead)
                db.commit()
                db.refresh(lead)
                added += 1

                payload = {
                    "type": "lead",
                    "id": lead.id,
                    "business_name": lead.business_name,
                    "phone": lead.phone or "",
                    "email": lead.email or "",
                    "website": lead.website or "",
                    "category": lead.category or "",
                    "city": lead.city or "",
                    "rating": lead.rating,
                    "address": lead.address or "",
                    "keyword": lead.keyword or "",
                    "status": lead.status,
                    "maps_url": lead.maps_url or "",
                }
                yield f"data: {json.dumps(payload)}\n\n"

            yield f"data: {json.dumps({'type': 'done', 'added': added, 'skipped': skipped, 'message': f'Done — {added} new leads saved, {skipped} skipped'})}\n\n"

        except Exception as exc:
            logger.error("Playwright SSE error: %s", exc)
            yield f"data: {json.dumps({'type': 'error', 'message': str(exc)})}\n\n"
        finally:
            db.close()

    return StreamingResponse(
        _generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@router.post("/scrape")
def scrape_leads(payload: ScrapeRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    settings = db.query(Setting).first()
    api_key  = (settings.maps_api_key if settings else None) or os.getenv("GEOAPIFY_API_KEY", "")

    if not api_key:
        raise HTTPException(status_code=400, detail="Google Maps API key not configured. Add it in Settings.")

    print(f"[scrape] Starting: keyword='{payload.keyword}' city='{payload.city}'")

    places = search_places(payload.keyword, payload.city, api_key)
    print(f"[scrape] Maps returned {len(places)} results")

    added = 0
    skipped = 0

    for place in places:
        # Prefer place_id dedup; fall back to business_name + city
        pid = place.get("place_id")
        if pid:
            exists = db.query(Lead).filter(Lead.place_id == pid, Lead.user_id == current_user.id).first()
        else:
            exists = (
                db.query(Lead)
                .filter(Lead.business_name == place["business_name"], Lead.city == place["city"], Lead.user_id == current_user.id)
                .first()
            )

        if exists:
            print(f"[scrape]   skip (duplicate): {place['business_name']}")
            skipped += 1
            continue

        if place.get("website"):
            place["email"] = find_email_from_website(place["website"])

        lead = Lead(
            user_id=current_user.id,
            place_id=pid,
            business_name=place["business_name"],
            phone=place.get("phone", ""),
            address=place.get("address", ""),
            website=place.get("website", ""),
            email=place.get("email"),
            category=place.get("category", ""),
            rating=place.get("rating"),
            city=payload.city,
            keyword=payload.keyword,
            status="new",
        )
        db.add(lead)
        added += 1
        print(f"[scrape]   saved: {place['business_name']}")

    db.commit()
    print(f"[scrape] Done — {added} saved, {skipped} skipped")

    return {
        "success": True,
        "data": {"found": len(places), "added": added, "skipped": skipped},
        "message": f"Scrape complete — {added} new leads added ({skipped} duplicates skipped)",
    }


@router.put("/{lead_id}")
def update_lead(lead_id: int, payload: LeadUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    lead = db.query(Lead).filter(Lead.id == lead_id, Lead.user_id == current_user.id).first()
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")

    if payload.status is not None:
        lead.status = payload.status
    if payload.email is not None:
        lead.email = payload.email
    if payload.phone is not None:
        lead.phone = payload.phone

    db.commit()
    db.refresh(lead)
    return {"success": True, "data": _lead_to_dict(lead), "message": "Lead updated"}


@router.delete("/{lead_id}")
def delete_lead(lead_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    lead = db.query(Lead).filter(Lead.id == lead_id, Lead.user_id == current_user.id).first()
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    db.delete(lead)
    db.commit()
    return {"success": True, "data": {}, "message": "Lead deleted"}


@router.post("/{lead_id}/send-email")
def send_email_to_lead(lead_id: int, payload: SendEmailRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    lead = db.query(Lead).filter(Lead.id == lead_id, Lead.user_id == current_user.id).first()
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    if not lead.email:
        raise HTTPException(status_code=400, detail="Lead has no email address")

    settings = db.query(Setting).first()
    if not SMTP_USER or not SMTP_PASSWORD:
        raise HTTPException(status_code=400, detail="SMTP credentials not configured. Set SMTP_USER and SMTP_PASSWORD in .env.")

    company_service = (settings.company_service or "") if settings else ""
    company_name = (settings.company_name or "Industronics") if settings else "Industronics"
    groq_key = (settings.groq_api_key or "") if settings else ""
    email_data = generate_email(_lead_to_dict(lead), company_name, groq_key)

    success = send_email(
        to_email=lead.email,
        subject=email_data["subject"],
        body=email_data["body"],
    )

    log = EmailLog(
        lead_id=lead.id,
        campaign_id=payload.campaign_id or 0,
        subject=email_data["subject"],
        body=email_data["body"],
        status="sent" if success else "failed",
    )
    db.add(log)

    if success:
        lead.status = "contacted"

    db.commit()

    return {
        "success": success,
        "data": {"subject": email_data["subject"]},
        "message": "Email sent" if success else "Email failed to send",
    }


# ---------- Helper ----------

def _lead_to_dict(lead: Lead) -> dict:
    return {
        "id": lead.id,
        "campaign_id": lead.campaign_id,
        "place_id": lead.place_id,
        "maps_url": lead.maps_url,
        "business_name": lead.business_name,
        "phone": lead.phone,
        "address": lead.address,
        "website": lead.website,
        "email": lead.email,
        "category": lead.category,
        "rating": lead.rating,
        "city": lead.city,
        "keyword": lead.keyword,
        "status": lead.status,
        "email_status": lead.email_status or "pending",
        "email_sent_at": lead.email_sent_at,
        "email_subject": lead.email_subject,
        "email_body": lead.email_body,
        "source": lead.source,
        "remarks": lead.remarks,
        "created_at": lead.created_at.isoformat() if lead.created_at else None,
        "updated_at": lead.updated_at.isoformat() if lead.updated_at else None,
    }