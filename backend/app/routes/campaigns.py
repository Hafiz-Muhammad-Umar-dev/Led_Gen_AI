import asyncio
import json
import logging
import os
import random
import re
import time
from pathlib import Path
from typing import Dict, List, Optional
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import or_
from sqlalchemy.orm import Session

import threading
from app.models.database import Campaign, EmailLog, Lead, SentEmail, Setting, SessionLocal, User, get_db
from app.routes.auth import get_current_user
from app.services.email_finder import find_email_from_website
from app.services.email_sender import send_email, SMTP_USER, SMTP_PASSWORD
from app.services.groq_writer import generate_email
from app.services.playwright_scraper import scrape_playwright_stream
from app.scheduler.tasks import refresh_campaign_schedules

logger = logging.getLogger(__name__)

# Keyed by user_id — a per-request global would let one user's stop/start
# affect another user's sheet-campaign run.
_sheet_stop: Dict[int, bool] = {}

# Where campaign email attachments (PDF/image) are stored on disk.
ATTACHMENTS_DIR = Path(__file__).resolve().parents[2] / "attachments"
ATTACHMENTS_DIR.mkdir(exist_ok=True)

# Allowed attachment types — PDFs and common image formats.
ALLOWED_ATTACHMENT_EXTS = {".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp"}
MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024  # 10 MB


def _attachment_full_path(on_disk_name: Optional[str]) -> Optional[str]:
    """Resolve a campaign's stored attachment filename to an absolute path."""
    if not on_disk_name:
        return None
    path = ATTACHMENTS_DIR / on_disk_name
    return str(path) if path.is_file() else None


router = APIRouter(prefix="/api/campaigns", tags=["campaigns"])


# ---------- Pydantic schemas ----------

class CampaignUpdate(BaseModel):
    name: Optional[str] = None
    keyword: Optional[str] = None
    city: Optional[str] = None
    status: Optional[str] = None
    schedule_days: Optional[int] = None
    max_leads: Optional[int] = None


# ---------- Routes ----------

@router.get("")
def get_campaigns(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    campaigns = db.query(Campaign).filter(Campaign.user_id == current_user.id).order_by(Campaign.created_at.desc()).all()
    return {
        "success": True,
        "data": [_campaign_to_dict(c) for c in campaigns],
        "message": "Campaigns retrieved",
    }


@router.post("")
async def create_campaign(
    name: str = Form(...),
    keyword: str = Form(...),
    city: str = Form(...),
    schedule_days: int = Form(4),
    max_leads: int = Form(20),
    attachment: Optional[UploadFile] = File(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    on_disk_name = None
    original_name = None

    # Optional PDF/image attachment sent with every email in this campaign.
    if attachment is not None and attachment.filename:
        original_name = attachment.filename
        ext = os.path.splitext(original_name)[1].lower()
        if ext not in ALLOWED_ATTACHMENT_EXTS:
            raise HTTPException(
                status_code=400,
                detail="Attachment must be a PDF or image (.pdf, .png, .jpg, .jpeg, .gif, .webp).",
            )

        content = await attachment.read()
        if len(content) > MAX_ATTACHMENT_BYTES:
            raise HTTPException(status_code=400, detail="Attachment too large (max 10 MB).")

        safe_stem = re.sub(r"[^a-zA-Z0-9_-]", "_", os.path.splitext(original_name)[0])[:60]
        on_disk_name = f"{safe_stem}_{int(time.time())}{ext}"
        (ATTACHMENTS_DIR / on_disk_name).write_bytes(content)

    campaign = Campaign(
        user_id=current_user.id,
        name=name,
        keyword=keyword,
        city=city,
        schedule_days=schedule_days,
        max_leads=max_leads,
        status="active",
        attachment_path=on_disk_name,
        attachment_filename=original_name,
    )
    db.add(campaign)
    db.commit()
    db.refresh(campaign)
    refresh_campaign_schedules()
    return {
        "success": True,
        "data": _campaign_to_dict(campaign),
        "message": "Campaign created",
    }


@router.get("/sheet/status")
def sheet_status(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    total = db.query(Lead).filter(Lead.source == "sheet", Lead.user_id == current_user.id).count()
    pending = db.query(Lead).filter(Lead.source == "sheet", Lead.email_status == "pending", Lead.user_id == current_user.id).count()
    sent = db.query(Lead).filter(Lead.source == "sheet", Lead.email_status == "sent", Lead.user_id == current_user.id).count()
    return {"success": True, "data": {"total": total, "pending": pending, "sent": sent}}


@router.post("/sheet/stop")
def stop_sheet_campaign(current_user: User = Depends(get_current_user)):
    _sheet_stop[current_user.id] = True
    return {"success": True, "message": "Stop signal sent"}


@router.get("/sheet/stream")
async def stream_sheet_campaign(
    request: Request,
    ids: Optional[List[int]] = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    user_id = current_user.id
    _sheet_stop[user_id] = False

    async def _generate():
        try:
            settings = db.query(Setting).first()
            if not SMTP_USER or not SMTP_PASSWORD:
                yield f"data: {json.dumps({'type': 'error', 'message': 'SMTP credentials not configured. Set SMTP_USER and SMTP_PASSWORD in .env.'})}\n\n"
                return

            company_name = settings.company_name or "Industronics"
            groq_key = settings.groq_api_key or ""

            query = db.query(Lead).filter(Lead.source == "sheet", Lead.email_status != "sent", Lead.user_id == user_id)
            if ids:
                query = query.filter(Lead.id.in_(ids))
            leads = query.order_by(Lead.created_at.asc()).all()

            already_sent_emails = {
                row[0]
                for row in db.query(Lead.email)
                .join(EmailLog, EmailLog.lead_id == Lead.id)
                .filter(EmailLog.status == "sent", Lead.user_id == user_id)
                .all()
                if row[0]
            }

            pending = [l for l in leads if l.email and l.email not in already_sent_emails]
            total = len(pending)

            if total == 0:
                yield f"data: {json.dumps({'type': 'done', 'sent': 0, 'total': 0, 'message': 'No pending leads to send.'})}\n\n"
                return

            yield f"data: {json.dumps({'type': 'start', 'total': total, 'message': f'Starting sheet campaign — {total} leads queued'})}\n\n"

            sent_count = 0

            for i, lead in enumerate(pending):
                if _sheet_stop.get(user_id):
                    yield f"data: {json.dumps({'type': 'stopped', 'sent': sent_count, 'total': total, 'message': f'Stopped after {sent_count} emails sent.'})}\n\n"
                    return

                if await request.is_disconnected():
                    return

                yield f"data: {json.dumps({'type': 'progress', 'current': i + 1, 'total': total, 'company': lead.business_name, 'email': lead.email, 'message': f'Writing email for {lead.business_name}…'})}\n\n"

                try:
                    email_data = await asyncio.to_thread(
                        generate_email,
                        {"business_name": lead.business_name, "category": lead.category or "", "remarks": lead.remarks or ""},
                        company_name,
                        groq_key,
                    )
                except Exception as exc:
                    logger.error("Sheet email gen failed for lead %d: %s", lead.id, exc)
                    lead.email_status = "failed"
                    db.commit()
                    yield f"data: {json.dumps({'type': 'log', 'status': 'failed', 'current': i + 1, 'total': total, 'company': lead.business_name, 'email': lead.email, 'message': f'Generation failed: {lead.business_name}'})}\n\n"
                    continue

                try:
                    success = await asyncio.to_thread(
                        send_email,
                        lead.email,
                        email_data["subject"],
                        email_data["body"],
                    )
                except Exception as exc:
                    logger.error("Sheet SMTP failed for lead %d: %s", lead.id, exc)
                    success = False

                log = EmailLog(
                    lead_id=lead.id,
                    campaign_id=0,
                    subject=email_data["subject"],
                    body=email_data["body"],
                    status="sent" if success else "failed",
                )
                db.add(log)

                if success:
                    lead.email_status = "sent"
                    lead.status = "contacted"
                    lead.email_subject = email_data["subject"]
                    lead.email_body = email_data["body"]
                    sent_count += 1
                else:
                    lead.email_status = "failed"

                db.commit()

                status_word = "Sent" if success else "Failed"
                log_msg = f"{status_word}: {lead.business_name} <{lead.email}>"
                yield f"data: {json.dumps({'type': 'log', 'lead_id': lead.id, 'status': 'sent' if success else 'failed', 'current': i + 1, 'total': total, 'company': lead.business_name, 'email': lead.email, 'subject': email_data['subject'], 'message': log_msg})}\n\n"

                if i < len(pending) - 1:
                    for _ in range(5):
                        if _sheet_stop.get(user_id) or await request.is_disconnected():
                            break
                        await asyncio.sleep(1)

            yield f"data: {json.dumps({'type': 'done', 'sent': sent_count, 'total': total, 'message': f'Sheet campaign complete — {sent_count}/{total} emails sent'})}\n\n"

        except Exception as exc:
            logger.error("Sheet campaign SSE error: %s", exc)
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


@router.put("/{campaign_id}")
def update_campaign(campaign_id: int, payload: CampaignUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    campaign = db.query(Campaign).filter(Campaign.id == campaign_id, Campaign.user_id == current_user.id).first()
    if not campaign:
        raise HTTPException(status_code=404, detail="Campaign not found")

    if payload.name is not None:
        campaign.name = payload.name
    if payload.keyword is not None:
        campaign.keyword = payload.keyword
    if payload.city is not None:
        campaign.city = payload.city
    if payload.status is not None:
        campaign.status = payload.status
    if payload.schedule_days is not None:
        campaign.schedule_days = payload.schedule_days
    if payload.max_leads is not None:
        campaign.max_leads = payload.max_leads

    db.commit()
    db.refresh(campaign)
    # Re-sync the scheduler so pausing actually stops scheduled runs (and
    # activating/rescheduling takes effect immediately, not on next restart).
    refresh_campaign_schedules()
    return {
        "success": True,
        "data": _campaign_to_dict(campaign),
        "message": "Campaign updated",
    }


@router.delete("/{campaign_id}")
def delete_campaign(campaign_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    campaign = db.query(Campaign).filter(Campaign.id == campaign_id, Campaign.user_id == current_user.id).first()
    if not campaign:
        raise HTTPException(status_code=404, detail="Campaign not found")

    # Remove the on-disk attachment, if any.
    if campaign.attachment_path:
        try:
            (ATTACHMENTS_DIR / campaign.attachment_path).unlink(missing_ok=True)
        except OSError as exc:
            logger.warning("Failed to delete attachment for campaign %d: %s", campaign_id, exc)

    db.delete(campaign)
    db.commit()
    refresh_campaign_schedules()
    return {"success": True, "data": {}, "message": "Campaign deleted"}


@router.post("/{campaign_id}/run")
def run_campaign(campaign_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    campaign = db.query(Campaign).filter(Campaign.id == campaign_id, Campaign.user_id == current_user.id).first()
    if not campaign:
        raise HTTPException(status_code=404, detail="Campaign not found")

    settings = db.query(Setting).first()
    if not settings:
        raise HTTPException(status_code=400, detail="Settings not configured")

    if not SMTP_USER or not SMTP_PASSWORD:
        raise HTTPException(status_code=400, detail="SMTP credentials not configured. Set SMTP_USER and SMTP_PASSWORD in .env.")

    # Scrape with the same Playwright scraper the Leads tab uses.
    query = f"{campaign.keyword} {campaign.city}".strip()

    attach_path = _attachment_full_path(campaign.attachment_path)
    attach_name = campaign.attachment_filename

    emails_sent = 0
    leads_added = 0

    for item in scrape_playwright_stream(query):
        # The scraper yields typed dicts (progress / lead / error) — only act on leads.
        if item.get("_type") != "lead":
            continue

        name = item.get("name", "")
        maps_url = item.get("maps_url", "")

        exists = None
        if maps_url:
            exists = db.query(Lead).filter(Lead.maps_url == maps_url, Lead.user_id == current_user.id).first()
        if not exists and name:
            exists = db.query(Lead).filter(Lead.business_name == name, Lead.user_id == current_user.id).first()

        if exists:
            lead = exists
        else:
            if item.get("website"):
                item["email"] = find_email_from_website(item["website"])

            lead = Lead(
                user_id=current_user.id,
                campaign_id=campaign.id,
                maps_url=maps_url,
                business_name=name,
                phone=item.get("phone") or "",
                address=item.get("address") or "",
                website=item.get("website") or "",
                email=item.get("email"),
                category=item.get("category") or "",
                rating=item.get("rating"),
                city=campaign.city,
                keyword=campaign.keyword,
                status="new",
            )
            db.add(lead)
            db.flush()
            leads_added += 1

        if not lead.email:
            continue

        email_data = generate_email(
            {
                "business_name": lead.business_name,
                "category": lead.category,
                "city": lead.city,
                "website": lead.website,
            },
            company_name=settings.company_name or "Industronics",
            api_key=settings.groq_api_key or "",
        )

        success = send_email(
            to_email=lead.email,
            subject=email_data["subject"],
            body=email_data["body"],
            attachment_path=attach_path,
            attachment_name=attach_name,
        )

        log = EmailLog(
            lead_id=lead.id,
            campaign_id=campaign.id,
            subject=email_data["subject"],
            body=email_data["body"],
            status="sent" if success else "failed",
        )
        db.add(log)

        if success:
            lead.status = "contacted"
            emails_sent += 1

    from datetime import datetime, timezone
    campaign.last_run = datetime.now(timezone.utc)
    campaign.total_leads += leads_added
    campaign.emails_sent += emails_sent

    db.commit()

    return {
        "success": True,
        "data": {"leads_added": leads_added, "emails_sent": emails_sent},
        "message": f"Campaign run complete — {leads_added} leads added, {emails_sent} emails sent",
    }


@router.get("/{campaign_id}/scrape/stream")
async def scrape_campaign_stream(campaign_id: int, current_user: User = Depends(get_current_user)):
    """
    SSE endpoint — runs the SAME Playwright scraper the Leads tab uses, saves
    every scraped lead with this campaign_id attached, and immediately
    generates + sends an email to each new lead (one by one with a 5-10s
    delay). Updates the campaign counters so the card shows leads + emails sent.
    """
    user_id = current_user.id

    async def _generate():
        import queue as _q
        import traceback as _tb
        from datetime import datetime, timezone

        db = SessionLocal()
        tq: _q.Queue = _q.Queue()

        try:
            campaign = db.query(Campaign).filter(Campaign.id == campaign_id, Campaign.user_id == user_id).first()
            if not campaign:
                yield f"data: {json.dumps({'type': 'error', 'message': 'Campaign not found'})}\n\n"
                return

            settings = db.query(Setting).first()
            company_name = (settings.company_name or "Industronics") if settings else "Industronics"
            groq_key = (settings.groq_api_key or "") if settings else ""
            can_send = bool(SMTP_USER and SMTP_PASSWORD)
            attach_path = _attachment_full_path(campaign.attachment_path)
            attach_name = campaign.attachment_filename

            # Step 2/3 — use the keyword stored on the campaign + its max_leads.
            query = f"{campaign.keyword} {campaign.city}".strip()
            max_leads = campaign.max_leads or 20

            start_msg = f'Scraping \"{query}\" (up to {max_leads})…'
            if not can_send:
                start_msg += " (SMTP not configured — scraping only)"
            yield f"data: {json.dumps({'type': 'start', 'message': start_msg})}\n\n"

            def _scrape_in_thread():
                try:
                    for item in scrape_playwright_stream(query, max_leads):
                        tq.put({"ok": True, "item": item})
                except Exception as exc:
                    err_msg = str(exc) or type(exc).__name__
                    logger.error("Campaign scraper thread error: %s\n%s", err_msg, _tb.format_exc())
                    tq.put({"ok": False, "error": err_msg})
                finally:
                    tq.put(None)

            threading.Thread(target=_scrape_in_thread, daemon=True).start()

            added = 0
            skipped = 0
            sent = 0

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
                    # Link an existing lead to this campaign if it isn't already.
                    if exists.campaign_id is None:
                        exists.campaign_id = campaign.id
                        db.commit()
                    yield f"data: {json.dumps({'type': 'skip', 'business_name': name})}\n\n"
                    skipped += 1
                    continue

                if item.get("website"):
                    item["email"] = await asyncio.to_thread(find_email_from_website, item["website"])

                # Step 4 — save the lead with campaign_id attached.
                lead = Lead(
                    user_id=user_id,
                    campaign_id=campaign.id,
                    maps_url=maps_url,
                    business_name=name,
                    phone=item.get("phone") or "",
                    address=item.get("address") or "",
                    website=item.get("website") or "",
                    email=item.get("email"),
                    category=item.get("category") or "",
                    rating=item.get("rating"),
                    city=item.get("city") or campaign.city,
                    keyword=campaign.keyword,
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
                    "email": lead.email or "",
                    "city": lead.city or "",
                }
                yield f"data: {json.dumps(payload)}\n\n"

                # Step 5 — generate + send an email to this new lead.
                if not (can_send and lead.email):
                    continue

                # Space sends out 5-10s apart, like the existing send flow.
                if sent > 0:
                    delay = random.randint(5, 10)
                    yield f"data: {json.dumps({'type': 'delay', 'seconds': delay})}\n\n"
                    await asyncio.sleep(delay)

                yield f"data: {json.dumps({'type': 'progress', 'message': f'Writing email for {lead.business_name}…'})}\n\n"

                try:
                    email_data = await asyncio.to_thread(
                        generate_email,
                        {
                            "business_name": lead.business_name,
                            "category": lead.category or "",
                            "city": lead.city or "",
                            "website": lead.website or "",
                        },
                        company_name,
                        groq_key,
                    )
                except Exception as exc:
                    logger.error("Campaign run email gen failed for lead %d: %s", lead.id, exc)
                    lead.email_status = "failed"
                    db.commit()
                    fail_payload = {
                        "type": "log", "lead_id": lead.id, "status": "failed",
                        "company": lead.business_name, "email": lead.email, "subject": "",
                        "message": f"Generation failed: {lead.business_name}",
                    }
                    yield f"data: {json.dumps(fail_payload)}\n\n"
                    continue

                try:
                    success = await asyncio.to_thread(
                        send_email, lead.email, email_data["subject"], email_data["body"],
                        attach_path, attach_name,
                    )
                except Exception as exc:
                    logger.error("Campaign run SMTP failed for lead %d: %s", lead.id, exc)
                    success = False

                db.add(SentEmail(
                    lead_id=lead.id,
                    campaign_id=campaign.id,
                    company_name=lead.business_name,
                    to_email=lead.email,
                    subject=email_data["subject"],
                    body=email_data["body"],
                    source="scraped",
                ))
                db.add(EmailLog(
                    lead_id=lead.id,
                    campaign_id=campaign.id,
                    subject=email_data["subject"],
                    body=email_data["body"],
                    status="sent" if success else "failed",
                ))

                if success:
                    lead.email_status = "sent"
                    lead.email_sent_at = datetime.now(timezone.utc).isoformat()
                    lead.email_subject = email_data["subject"]
                    lead.email_body = email_data["body"]
                    lead.status = "contacted"
                    sent += 1
                else:
                    lead.email_status = "failed"
                db.commit()

                log_payload = {
                    "type": "log", "lead_id": lead.id,
                    "status": "sent" if success else "failed",
                    "company": lead.business_name, "email": lead.email,
                    "subject": email_data["subject"],
                    "message": f"{'Sent' if success else 'Failed'}: {lead.business_name}",
                }
                yield f"data: {json.dumps(log_payload)}\n\n"

            # Step 6 — update the campaign counters so the card reflects the run.
            campaign.total_leads = (campaign.total_leads or 0) + added
            campaign.emails_sent = (campaign.emails_sent or 0) + sent
            campaign.last_run = datetime.now(timezone.utc)
            db.commit()

            done_payload = {
                "type": "done", "added": added, "skipped": skipped, "sent": sent,
                "total_leads": campaign.total_leads, "emails_sent": campaign.emails_sent,
                "message": f"Done — {added} leads saved, {sent} emails sent, {skipped} skipped",
            }
            yield f"data: {json.dumps(done_payload)}\n\n"

        except Exception as exc:
            logger.error("Campaign scrape SSE error: %s", exc)
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


@router.get("/{campaign_id}/add-leads/stream")
async def add_leads_stream(
    campaign_id: int,
    count: int = Query(..., ge=1, le=50),
    current_user: User = Depends(get_current_user),
):
    """
    SSE — scrape fresh results for the campaign keyword, keep only NEW leads
    (email not already used in this campaign) until `count` is reached, then
    generate + send an email to each one by one with a 5-10s delay. Updates
    the campaign counters and writes each send to the campaign logs.
    """
    user_id = current_user.id

    async def _generate():
        import queue as _q
        import traceback as _tb
        from datetime import datetime, timezone

        db = SessionLocal()
        tq: _q.Queue = _q.Queue()

        try:
            campaign = db.query(Campaign).filter(Campaign.id == campaign_id, Campaign.user_id == user_id).first()
            if not campaign:
                yield f"data: {json.dumps({'type': 'error', 'message': 'Campaign not found'})}\n\n"
                return

            if not SMTP_USER or not SMTP_PASSWORD:
                yield f"data: {json.dumps({'type': 'error', 'message': 'SMTP credentials not configured. Set SMTP_USER and SMTP_PASSWORD in .env.'})}\n\n"
                return

            settings = db.query(Setting).first()
            company_name = (settings.company_name or "Industronics") if settings else "Industronics"
            groq_key = (settings.groq_api_key or "") if settings else ""
            attach_path = _attachment_full_path(campaign.attachment_path)
            attach_name = campaign.attachment_filename

            target = count
            buffer = count * 2  # Step 2 — scrape double the amount for buffer.
            query = f"{campaign.keyword} {campaign.city}".strip()

            yield f"data: {json.dumps({'type': 'start', 'message': f'Adding {target} leads — scraping up to {buffer} results…'})}\n\n"

            # ---- Phase 1: scrape and collect only NEW leads ----
            def _scrape_in_thread():
                try:
                    for item in scrape_playwright_stream(query, buffer):
                        tq.put({"ok": True, "item": item})
                except Exception as exc:
                    err_msg = str(exc) or type(exc).__name__
                    logger.error("Add-leads scraper thread error: %s\n%s", err_msg, _tb.format_exc())
                    tq.put({"ok": False, "error": err_msg})
                finally:
                    tq.put(None)

            threading.Thread(target=_scrape_in_thread, daemon=True).start()

            new_leads = []

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
                    continue

                # Stop collecting once we have enough; keep draining the queue.
                if len(new_leads) >= target:
                    continue

                name = item.get("name", "")
                maps_url = item.get("maps_url", "")
                website = item.get("website")

                email = None
                if website:
                    email = await asyncio.to_thread(find_email_from_website, website)

                if not email:
                    yield f"data: {json.dumps({'type': 'skip', 'business_name': name, 'reason': 'no email'})}\n\n"
                    continue

                # Step 3 — skip if this email already exists for this campaign.
                exists = (
                    db.query(Lead)
                    .filter(Lead.email == email, Lead.campaign_id == campaign.id)
                    .first()
                )
                if exists:
                    yield f"data: {json.dumps({'type': 'skip', 'business_name': name, 'reason': 'duplicate'})}\n\n"
                    continue

                # Step 4 — save the new lead with campaign_id attached.
                lead = Lead(
                    user_id=user_id,
                    campaign_id=campaign.id,
                    maps_url=maps_url,
                    business_name=name,
                    phone=item.get("phone") or "",
                    address=item.get("address") or "",
                    website=website or "",
                    email=email,
                    category=item.get("category") or "",
                    rating=item.get("rating"),
                    city=item.get("city") or campaign.city,
                    keyword=campaign.keyword,
                    status="new",
                )
                db.add(lead)
                db.commit()
                db.refresh(lead)
                new_leads.append(lead)

                yield f"data: {json.dumps({'type': 'lead', 'id': lead.id, 'business_name': lead.business_name, 'email': lead.email})}\n\n"

            added = len(new_leads)
            if added == 0:
                campaign.last_run = datetime.now(timezone.utc)
                db.commit()
                yield f"data: {json.dumps({'type': 'done', 'added': 0, 'sent': 0, 'total_leads': campaign.total_leads, 'emails_sent': campaign.emails_sent, 'message': 'No new leads found to add.'})}\n\n"
                return

            # ---- Phase 2: Step 5 — generate + send one by one with delay ----
            sent = 0
            total = added
            for i, lead in enumerate(new_leads):
                yield f"data: {json.dumps({'type': 'progress', 'message': f'Writing email for {lead.business_name}…'})}\n\n"

                try:
                    email_data = await asyncio.to_thread(
                        generate_email,
                        {
                            "business_name": lead.business_name,
                            "category": lead.category or "",
                            "city": lead.city or "",
                            "website": lead.website or "",
                        },
                        company_name,
                        groq_key,
                    )
                except Exception as exc:
                    logger.error("Add-leads email gen failed for lead %d: %s", lead.id, exc)
                    lead.email_status = "failed"
                    db.commit()
                    fail_payload = {
                        "type": "log", "lead_id": lead.id, "status": "failed",
                        "current": i + 1, "total": total, "company": lead.business_name,
                        "email": lead.email, "subject": "", "message": f"Generation failed: {lead.business_name}",
                    }
                    yield f"data: {json.dumps(fail_payload)}\n\n"
                    continue

                try:
                    success = await asyncio.to_thread(
                        send_email, lead.email, email_data["subject"], email_data["body"],
                        attach_path, attach_name,
                    )
                except Exception as exc:
                    logger.error("Add-leads SMTP failed for lead %d: %s", lead.id, exc)
                    success = False

                # Step 6 — write to the campaign logs.
                db.add(SentEmail(
                    lead_id=lead.id,
                    campaign_id=campaign.id,
                    company_name=lead.business_name,
                    to_email=lead.email,
                    subject=email_data["subject"],
                    body=email_data["body"],
                    source="scraped",
                ))
                db.add(EmailLog(
                    lead_id=lead.id,
                    campaign_id=campaign.id,
                    subject=email_data["subject"],
                    body=email_data["body"],
                    status="sent" if success else "failed",
                ))

                if success:
                    lead.email_status = "sent"
                    lead.email_sent_at = datetime.now(timezone.utc).isoformat()
                    lead.email_subject = email_data["subject"]
                    lead.email_body = email_data["body"]
                    lead.status = "contacted"
                    sent += 1
                else:
                    lead.email_status = "failed"
                db.commit()

                log_payload = {
                    "type": "log", "lead_id": lead.id,
                    "status": "sent" if success else "failed",
                    "current": i + 1, "total": total, "company": lead.business_name,
                    "email": lead.email, "subject": email_data["subject"],
                    "message": f"{'Sent' if success else 'Failed'}: {lead.business_name}",
                }
                yield f"data: {json.dumps(log_payload)}\n\n"

                if i < total - 1:
                    delay = random.randint(5, 10)
                    yield f"data: {json.dumps({'type': 'delay', 'seconds': delay})}\n\n"
                    await asyncio.sleep(delay)

            # Step 6 — update campaign counters so the card reflects the run.
            campaign.total_leads = (campaign.total_leads or 0) + added
            campaign.emails_sent = (campaign.emails_sent or 0) + sent
            campaign.last_run = datetime.now(timezone.utc)
            db.commit()

            done_payload = {
                "type": "done", "added": added, "sent": sent,
                "total_leads": campaign.total_leads, "emails_sent": campaign.emails_sent,
                "message": f"Added {added} leads — {sent}/{added} emails sent",
            }
            yield f"data: {json.dumps(done_payload)}\n\n"

        except Exception as exc:
            logger.error("Add-leads SSE error: %s", exc)
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


@router.get("/{campaign_id}/logs")
def get_campaign_logs(campaign_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    campaign = db.query(Campaign).filter(Campaign.id == campaign_id, Campaign.user_id == current_user.id).first()
    if not campaign:
        raise HTTPException(status_code=404, detail="Campaign not found")

    # Match emails stamped with this campaign_id, plus any tied to this
    # campaign's leads before campaign_id was recorded on the email rows.
    lead_ids = [row[0] for row in db.query(Lead.id).filter(Lead.campaign_id == campaign_id).all()]

    entries = []
    seen = set()  # (lead_id, subject) — avoids showing the same send twice.

    # 1) Emails logged in email_logs (carry real sent/failed status); join Lead
    #    to recover company name + recipient address.
    log_conditions = [EmailLog.campaign_id == campaign_id]
    if lead_ids:
        log_conditions.append(EmailLog.lead_id.in_(lead_ids))
    rows = (
        db.query(EmailLog, Lead)
        .outerjoin(Lead, Lead.id == EmailLog.lead_id)
        .filter(or_(*log_conditions))
        .all()
    )
    for log, lead in rows:
        seen.add((log.lead_id, log.subject))
        entries.append({
            "id": f"l{log.id}",
            "lead_id": log.lead_id,
            "company_name": lead.business_name if lead else None,
            "to_email": lead.email if lead else None,
            "subject": log.subject,
            "body": log.body,
            "status": log.status,
            "sent_at": log.sent_at,
        })

    # 2) Emails from sent_emails (e.g. Leads-tab sends) not already logged above.
    sent_conditions = [SentEmail.campaign_id == campaign_id]
    if lead_ids:
        sent_conditions.append(SentEmail.lead_id.in_(lead_ids))
    for s in db.query(SentEmail).filter(or_(*sent_conditions)).all():
        if (s.lead_id, s.subject) in seen:
            continue
        entries.append({
            "id": f"s{s.id}",
            "lead_id": s.lead_id,
            "company_name": s.company_name,
            "to_email": s.to_email,
            "subject": s.subject,
            "body": s.body,
            "status": "sent",
            "sent_at": s.sent_at,
        })

    # Newest first; tolerate naive/aware datetimes from the DB driver.
    entries.sort(key=lambda e: e["sent_at"].timestamp() if e["sent_at"] else 0.0, reverse=True)
    for e in entries:
        e["sent_at"] = e["sent_at"].isoformat() if e["sent_at"] else None

    return {
        "success": True,
        "data": entries,
        "message": "Logs retrieved",
    }


# ---------- Helpers ----------

def _sent_email_to_dict(sent: SentEmail) -> dict:
    return {
        "id": sent.id,
        "lead_id": sent.lead_id,
        "campaign_id": sent.campaign_id,
        "company_name": sent.company_name,
        "to_email": sent.to_email,
        "subject": sent.subject,
        "body": sent.body,
        # sent_emails only records successful sends.
        "status": "sent",
        "sent_at": sent.sent_at.isoformat() if sent.sent_at else None,
    }


def _campaign_to_dict(campaign: Campaign) -> dict:
    return {
        "id": campaign.id,
        "name": campaign.name,
        "keyword": campaign.keyword,
        "city": campaign.city,
        "status": campaign.status,
        "schedule_days": campaign.schedule_days,
        "max_leads": campaign.max_leads,
        "total_leads": campaign.total_leads,
        "emails_sent": campaign.emails_sent,
        "attachment_filename": campaign.attachment_filename,
        "created_at": campaign.created_at.isoformat() if campaign.created_at else None,
        "last_run": campaign.last_run.isoformat() if campaign.last_run else None,
    }


def _log_to_dict(log: EmailLog) -> dict:
    return {
        "id": log.id,
        "lead_id": log.lead_id,
        "campaign_id": log.campaign_id,
        "subject": log.subject,
        "body": log.body,
        "status": log.status,
        "sent_at": log.sent_at.isoformat() if log.sent_at else None,
    }
