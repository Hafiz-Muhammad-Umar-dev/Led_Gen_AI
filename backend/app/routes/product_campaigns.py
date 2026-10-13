"""
Product Campaigns — a parallel feature to the existing Campaigns tab.
Reuses the existing Playwright scraper, SMTP sender and SSE streaming
pattern exactly; only the Groq prompt (product_groq_writer.py) and the
DB tables (product_campaigns_models.py) are new/product-specific.
"""

import asyncio
import json
import logging
import os
import random
import re
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.models.database import Setting, SessionLocal, User, get_db
from app.models.product_campaigns_models import (
    ProductCampaign,
    ProductCampaignLead,
    ProductCampaignLog,
)
from app.models.products_models import Product
from app.routes.auth import get_current_user
from app.services.email_finder import find_email_from_website
from app.services.email_sender import send_email, get_last_error, SMTP_USER, SMTP_PASSWORD
from app.services.groq_writer import _clean_company_name
from app.services.product_groq_writer import generate_product_email
from app.services.playwright_scraper import scrape_playwright_stream

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/product-campaigns", tags=["product-campaigns"])

# Chromium net-error codes that mean "no network path to the internet at all"
# (DNS down, Wi-Fi dropped, etc.) rather than a genuine scraping/app problem.
_NETWORK_ERROR_HINTS = (
    "ERR_NAME_NOT_RESOLVED",
    "ERR_INTERNET_DISCONNECTED",
    "ERR_CONNECTION_REFUSED",
    "ERR_CONNECTION_RESET",
    "ERR_CONNECTION_CLOSED",
    "ERR_NETWORK_CHANGED",
    "ERR_PROXY_CONNECTION_FAILED",
    "ERR_ADDRESS_UNREACHABLE",
)


def _friendly_scrape_error(raw_msg: str) -> str:
    if any(hint in raw_msg for hint in _NETWORK_ERROR_HINTS):
        return (
            "No internet connection — this machine couldn't reach Google Maps "
            "(DNS/network lookup failed). Check your internet/Wi-Fi connection "
            "and try again."
        )
    return raw_msg

_VALID_STATUSES = {"active", "paused", "completed"}

# Same physical folder + rules the existing Campaigns tab uses for attachments.
ATTACHMENTS_DIR = Path(__file__).resolve().parents[2] / "attachments"
ATTACHMENTS_DIR.mkdir(exist_ok=True)

ALLOWED_ATTACHMENT_EXTS = {".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp"}
MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024  # 10 MB


def _attachment_full_path(on_disk_name: Optional[str]) -> Optional[str]:
    """Resolve a campaign's stored attachment filename to an absolute path."""
    if not on_disk_name:
        return None
    path = ATTACHMENTS_DIR / on_disk_name
    return str(path) if path.is_file() else None


# ---------- Pydantic schemas ----------

class ProductCampaignStatusUpdate(BaseModel):
    status: str


# ---------- Routes ----------

@router.post("/create")
async def create_product_campaign(
    campaign_name: str = Form(...),
    product_name: str = Form(...),
    pitch_angle: str = Form(...),
    keyword: str = Form(...),
    location: str = Form(...),
    daily_limit: int = Form(20),
    attachment: Optional[UploadFile] = File(None),
    product_id: Optional[int] = Form(None),
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
        on_disk_name = f"product_{safe_stem}_{int(time.time())}{ext}"
        (ATTACHMENTS_DIR / on_disk_name).write_bytes(content)
    elif product_id:
        # No file uploaded this time — fall back to the saved product's
        # attachment (a browser file input can't be pre-populated, so the
        # frontend can only prefill text fields; the attachment carries over
        # via this lookup instead).
        product = (
            db.query(Product)
            .filter(Product.id == product_id, Product.user_id == current_user.id)
            .first()
        )
        if product:
            on_disk_name = product.attachment_path
            original_name = product.attachment_filename

    campaign = ProductCampaign(
        user_id=current_user.id,
        campaign_name=campaign_name,
        product_name=product_name,
        pitch_angle=pitch_angle,
        keyword=keyword,
        location=location,
        daily_limit=daily_limit,
        status="active",
        attachment_path=on_disk_name,
        attachment_filename=original_name,
    )
    db.add(campaign)
    db.commit()
    db.refresh(campaign)
    return {
        "success": True,
        "data": _product_campaign_to_dict(campaign),
        "message": "Campaign created",
    }


@router.get("/list")
def list_product_campaigns(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    campaigns = db.query(ProductCampaign).filter(ProductCampaign.user_id == current_user.id).order_by(ProductCampaign.created_at.desc()).all()
    return {
        "success": True,
        "data": [_product_campaign_to_dict(c) for c in campaigns],
        "message": "Campaigns retrieved",
    }


@router.put("/{campaign_id}/status")
def update_product_campaign_status(
    campaign_id: int,
    payload: ProductCampaignStatusUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if payload.status not in _VALID_STATUSES:
        raise HTTPException(status_code=400, detail=f"status must be one of {sorted(_VALID_STATUSES)}")

    campaign = db.query(ProductCampaign).filter(ProductCampaign.id == campaign_id, ProductCampaign.user_id == current_user.id).first()
    if not campaign:
        raise HTTPException(status_code=404, detail="Campaign not found")

    campaign.status = payload.status
    db.commit()
    db.refresh(campaign)
    return {
        "success": True,
        "data": _product_campaign_to_dict(campaign),
        "message": "Status updated",
    }


@router.get("/{campaign_id}/logs")
def get_product_campaign_logs(campaign_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    campaign = db.query(ProductCampaign).filter(ProductCampaign.id == campaign_id, ProductCampaign.user_id == current_user.id).first()
    if not campaign:
        raise HTTPException(status_code=404, detail="Campaign not found")

    logs = (
        db.query(ProductCampaignLog)
        .filter(ProductCampaignLog.campaign_id == campaign_id)
        .order_by(ProductCampaignLog.sent_at.desc())
        .all()
    )
    return {
        "success": True,
        "data": [
            {
                "id": log.id,
                "lead_id": log.lead_id,
                "company_name": log.company_name,
                "to_email": log.to_email,
                "subject": log.subject,
                "body": log.body,
                "status": log.status,
                "sent_at": log.sent_at.isoformat() if log.sent_at else None,
            }
            for log in logs
        ],
        "message": "Logs retrieved",
    }


@router.get("/{campaign_id}/run/stream")
async def run_product_campaign_stream(campaign_id: int, current_user: User = Depends(get_current_user)):
    """
    SSE — scrapes up to daily_limit x2 results (buffer for duplicates),
    saves every new lead, then generates + sends an email to each new
    lead that has an email (one by one, 5-10s apart). This is the browser
    counterpart of the spec's "POST /run" — implemented as GET so the
    frontend can consume it with the native EventSource API, matching
    every other SSE endpoint in this codebase (which are all GET).
    """
    return StreamingResponse(
        _stream_product_pipeline(campaign_id, current_user.id, mode="run"),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


@router.get("/{campaign_id}/add-leads/stream")
async def add_product_campaign_leads_stream(
    campaign_id: int,
    count: int = Query(..., ge=1, le=100),
    current_user: User = Depends(get_current_user),
):
    """
    SSE — same pipeline as /run/stream but only collects `count` new
    leads that have an email (skipping ones without) and already-contacted
    emails for this campaign, scraping count x2 results as a buffer.
    """
    return StreamingResponse(
        _stream_product_pipeline(campaign_id, current_user.id, mode="add", count=count),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


# ---------- SSE pipeline (shared by /run/stream and /add-leads/stream) ----------

async def _stream_product_pipeline(campaign_id: int, user_id: int, mode: str, count: Optional[int] = None):
    import queue as _q
    import traceback as _tb

    db = SessionLocal()
    tq: _q.Queue = _q.Queue()

    try:
        campaign = db.query(ProductCampaign).filter(ProductCampaign.id == campaign_id, ProductCampaign.user_id == user_id).first()
        if not campaign:
            yield f"data: {json.dumps({'type': 'error', 'message': 'Campaign not found'})}\n\n"
            return

        settings = db.query(Setting).first()
        groq_key = (settings.groq_api_key or "") if settings else ""
        can_send = bool(SMTP_USER and SMTP_PASSWORD)
        attach_path = _attachment_full_path(campaign.attachment_path)
        attach_name = campaign.attachment_filename

        # Avoid a redundant query like "pharmaceutical companies Birmingham
        # Birmingham UK" when the keyword already names the location (the
        # create form's own placeholder encourages exactly that, e.g. keyword
        # "pharmaceutical companies Birmingham" + location "Birmingham UK") —
        # only append the words from location the keyword doesn't already have.
        keyword = campaign.keyword.strip()
        location = (campaign.location or "").strip()
        keyword_words = set(re.findall(r"\w+", keyword.lower()))
        new_location_words = [w for w in location.split() if w.lower() not in keyword_words]
        query = f"{keyword} {' '.join(new_location_words)}".strip()
        target = count if mode == "add" else (campaign.daily_limit or 20)

        # Google Maps returns the same top listings for an identical query
        # every time — the scraper has no "start from position N" option, so
        # once a campaign already has leads, requesting only target x2 more
        # just re-finds the same companies again (all skipped as duplicates,
        # leaving 0 new leads). Scrape past what's already been captured by
        # padding the buffer with how many leads this campaign already has,
        # so the extra headroom actually reaches fresh listings (e.g. #21+).
        already_scraped = (
            db.query(ProductCampaignLead)
            .filter(ProductCampaignLead.campaign_id == campaign.id)
            .count()
        )
        buffer = already_scraped + target * 2

        start_msg = f'Scraping "{query}" (up to {buffer} results)…'
        if not can_send:
            start_msg += " (SMTP not configured — scraping only)"
        yield f"data: {json.dumps({'type': 'start', 'message': start_msg})}\n\n"

        def _scrape_in_thread():
            # Google Maps navigation occasionally times out transiently (slow
            # response, momentary rate-limiting) — retry with backoff before
            # giving up, since a bare page.goto timeout on attempt 1 happens
            # before any listings are found (nothing to duplicate on retry).
            backoffs = [5, 15]  # seconds between attempts 1→2 and 2→3
            last_exc = None
            for attempt in range(len(backoffs) + 1):
                try:
                    for item in scrape_playwright_stream(query, buffer):
                        tq.put({"ok": True, "item": item})
                    tq.put(None)
                    return
                except Exception as exc:
                    last_exc = exc
                    logger.warning(
                        "Product campaign scraper attempt %d/%d failed: %s",
                        attempt + 1, len(backoffs) + 1, exc,
                    )
                    if attempt < len(backoffs):
                        time.sleep(backoffs[attempt])

            raw_msg = str(last_exc) or type(last_exc).__name__
            logger.error("Product campaign scraper thread error: %s\n%s", raw_msg, _tb.format_exc())
            tq.put({"ok": False, "error": _friendly_scrape_error(raw_msg)})
            tq.put(None)

        threading.Thread(target=_scrape_in_thread, daemon=True).start()

        new_leads = []
        scraped_count = 0

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
                # The scraper's own "(i/N)" counter is measured against the
                # internal buffer (target x2, to absorb dupes/no-email skips),
                # not the number the user actually picked — strip it and show
                # progress against how many we've kept toward `target` instead.
                text_msg = re.sub(r'^\(\d+/\d+\)\s*', '', item['message'])
                yield f"data: {json.dumps({'type': 'progress', 'message': text_msg, 'kept': len(new_leads), 'target': target})}\n\n"
                continue
            if item_type == "error":
                yield f"data: {json.dumps({'type': 'skip', 'company': item.get('name', ''), 'reason': 'scrape failed'})}\n\n"
                continue

            if len(new_leads) >= target:
                continue

            name = item.get("name", "")
            maps_url = item.get("maps_url", "")
            website = item.get("website")

            email = None
            if website:
                email = await asyncio.to_thread(find_email_from_website, website)

            if mode == "add" and not email:
                yield f"data: {json.dumps({'type': 'skip', 'company': name, 'reason': 'no email'})}\n\n"
                continue

            if email:
                exists = (
                    db.query(ProductCampaignLead)
                    .filter(ProductCampaignLead.email == email, ProductCampaignLead.campaign_id == campaign.id)
                    .first()
                )
                if exists:
                    yield f"data: {json.dumps({'type': 'skip', 'company': name, 'reason': 'duplicate'})}\n\n"
                    continue

            short_name = _clean_company_name(name) if name else ""

            lead = ProductCampaignLead(
                campaign_id=campaign.id,
                company_name=name,
                short_name=short_name,
                email=email,
                phone=item.get("phone") or "",
                address=item.get("address") or "",
                website=website or "",
                rating=str(item.get("rating")) if item.get("rating") is not None else None,
                reviews=str(item.get("reviews")) if item.get("reviews") is not None else None,
                maps_url=maps_url,
                email_status="pending",
            )
            db.add(lead)
            db.commit()
            db.refresh(lead)
            new_leads.append(lead)
            scraped_count += 1

            yield f"data: {json.dumps({'type': 'lead', 'lead_id': lead.id, 'company': lead.company_name, 'email': lead.email or ''})}\n\n"

        campaign.total_scraped = (campaign.total_scraped or 0) + scraped_count
        db.commit()

        sendable = [l for l in new_leads if l.email]
        total_to_send = len(sendable)

        if total_to_send == 0:
            yield f"data: {json.dumps({'type': 'done', 'sent': 0, 'failed': 0, 'scraped': scraped_count, 'message': 'No leads with an email to send to.'})}\n\n"
            return

        if not can_send:
            yield f"data: {json.dumps({'type': 'done', 'sent': 0, 'failed': 0, 'scraped': scraped_count, 'message': 'SMTP not configured — leads scraped but no emails sent.'})}\n\n"
            return

        sent = 0
        failed = 0

        for i, lead in enumerate(sendable):
            if i > 0:
                delay = random.randint(5, 10)
                yield f"data: {json.dumps({'type': 'delay', 'seconds': delay})}\n\n"
                await asyncio.sleep(delay)

            yield f"data: {json.dumps({'type': 'progress', 'message': f'Writing email for {lead.company_name}…'})}\n\n"
            progress = f"{i + 1}/{total_to_send}"

            try:
                email_data = await asyncio.to_thread(
                    generate_product_email,
                    {
                        "company_name": lead.company_name,
                        "category": "",
                        "address": lead.address or campaign.location,
                    },
                    campaign.product_name,
                    campaign.pitch_angle,
                    groq_key,
                    bool(attach_path),
                )
            except Exception as exc:
                logger.error("Product campaign email gen failed for lead %d: %s", lead.id, exc)
                lead.email_status = "failed"
                lead.email_fail_reason = f"Generation failed: {exc}"
                db.commit()
                failed += 1
                yield f"data: {json.dumps({'type': 'log', 'lead_id': lead.id, 'company': lead.company_name, 'status': 'failed', 'reason': 'generation failed', 'subject': '', 'progress': progress})}\n\n"
                continue

            try:
                success = await asyncio.to_thread(
                    send_email, lead.email, email_data["subject"], email_data["body"],
                    attach_path, attach_name,
                )
            except Exception as exc:
                logger.error("Product campaign SMTP failed for lead %d: %s", lead.id, exc)
                success = False

            db.add(ProductCampaignLog(
                campaign_id=campaign.id,
                lead_id=lead.id,
                company_name=lead.company_name,
                to_email=lead.email,
                subject=email_data["subject"],
                body=email_data["body"],
                status="sent" if success else "failed",
            ))

            if success:
                lead.email_status = "sent"
                lead.email_sent_at = datetime.now(timezone.utc).isoformat()
                lead.email_subject = email_data["subject"]
                lead.email_body = email_data["body"]
                sent += 1
            else:
                lead.email_status = "failed"
                lead.email_fail_reason = get_last_error() or "Send failed"
                failed += 1
            db.commit()

            yield f"data: {json.dumps({'type': 'log', 'lead_id': lead.id, 'company': lead.company_name, 'status': 'sent' if success else 'failed', 'reason': '' if success else (lead.email_fail_reason or ''), 'subject': email_data['subject'], 'progress': progress})}\n\n"

        campaign.total_sent = (campaign.total_sent or 0) + sent
        db.commit()

        yield f"data: {json.dumps({'type': 'done', 'sent': sent, 'failed': failed, 'scraped': scraped_count, 'message': f'Done — {sent} sent, {failed} failed'})}\n\n"

    except Exception as exc:
        logger.error("Product campaign SSE error: %s", exc)
        yield f"data: {json.dumps({'type': 'error', 'message': str(exc)})}\n\n"
    finally:
        db.close()


# ---------- Helpers ----------

def _product_campaign_to_dict(c: ProductCampaign) -> dict:
    return {
        "id": c.id,
        "campaign_name": c.campaign_name,
        "product_name": c.product_name,
        "pitch_angle": c.pitch_angle,
        "keyword": c.keyword,
        "location": c.location,
        "daily_limit": c.daily_limit,
        "status": c.status,
        "total_scraped": c.total_scraped,
        "total_sent": c.total_sent,
        "attachment_filename": c.attachment_filename,
        "created_at": c.created_at.isoformat() if c.created_at else None,
    }
