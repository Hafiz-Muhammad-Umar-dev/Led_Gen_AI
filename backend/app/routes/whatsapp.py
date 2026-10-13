import asyncio
import json
import logging
import os
import queue as _q
import random
import re
import threading
import time
from datetime import datetime, timezone
from typing import List, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.models.database import Lead, SessionLocal, Setting, User, get_db
from app.models.product_campaigns_models import ProductCampaign, ProductCampaignLead
from app.routes.auth import get_current_user
from app.services.groq_writer import generate_email
from app.services.product_groq_writer import generate_product_email

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/whatsapp", tags=["whatsapp"])

WHATSAPP_SERVICE_URL = os.getenv("WHATSAPP_SERVICE_URL", "http://localhost:3001")
DEFAULT_COUNTRY_CODE = os.getenv("WHATSAPP_DEFAULT_COUNTRY_CODE", "44")

_UNAVAILABLE = {"status": "unavailable", "qr": None, "connectedNumber": None}

SOURCE_LEAD = "lead"
SOURCE_PRODUCT = "product_campaign_lead"
MAX_SEND_BATCH = 3


class SendTarget(BaseModel):
    id: int
    source: str


def _normalize_phone(raw: Optional[str]) -> Optional[str]:
    """Best-effort conversion of a stored phone string into the digits-only,
    country-code-prefixed format Baileys' onWhatsApp() expects.

    Numbers already in international format (e.g. scraped as "+44 20 ...")
    pass through as-is. Bare local-format numbers (leading 0, 10-11 digits)
    are assumed to be WHATSAPP_DEFAULT_COUNTRY_CODE (UK by default) since
    that's this company's primary market — not a universal solution.
    """
    digits = re.sub(r"\D", "", raw or "")
    if not digits:
        return None
    if digits.startswith("00"):
        digits = digits[2:]
    elif digits.startswith("0") and len(digits) in (10, 11):
        digits = DEFAULT_COUNTRY_CODE + digits[1:]
    return digits if len(digits) >= 8 else None


# ---------- Cross-table helpers ----------
# WhatsApp outreach spans two lead pools that predate this feature: the
# `leads` table (used by both the plain Leads tab and Campaigns, via
# campaign_id) and `product_campaign_leads` (Product Campaigns). They share
# the has_whatsapp/whatsapp_message_* columns but differ in ORM shape
# (business_name vs company_name, and product_campaign_leads has no user_id
# of its own — it's scoped by joining its parent ProductCampaign) so listing,
# checking, and sending all normalize both into the same (source, id) shape.

def _leads_query(db: Session, user_id: int, has_whatsapp: Optional[str] = None):
    q = (
        db.query(Lead)
        .filter(Lead.user_id == user_id)
        .filter(Lead.phone.isnot(None))
        .filter(Lead.phone != "")
    )
    if has_whatsapp and has_whatsapp != "all":
        q = q.filter(Lead.has_whatsapp == has_whatsapp)
    return q


def _product_leads_query(db: Session, user_id: int, has_whatsapp: Optional[str] = None):
    q = (
        db.query(ProductCampaignLead)
        .join(ProductCampaign, ProductCampaignLead.campaign_id == ProductCampaign.id)
        .filter(ProductCampaign.user_id == user_id)
        .filter(ProductCampaignLead.phone.isnot(None))
        .filter(ProductCampaignLead.phone != "")
    )
    if has_whatsapp and has_whatsapp != "all":
        q = q.filter(ProductCampaignLead.has_whatsapp == has_whatsapp)
    return q


def _lead_to_wa_dict(lead: Lead) -> dict:
    return {
        "id": lead.id,
        "source": SOURCE_LEAD,
        "source_label": "Campaign" if lead.campaign_id else "Leads",
        "business_name": lead.business_name,
        "phone": lead.phone,
        "has_whatsapp": lead.has_whatsapp or "unchecked",
        "whatsapp_checked_at": lead.whatsapp_checked_at,
        "has_message": bool(lead.email_body),
        "message_subject": lead.email_subject,
        "message_body": lead.email_body,
        "whatsapp_message_status": lead.whatsapp_message_status,
        "whatsapp_message_sent_at": lead.whatsapp_message_sent_at,
        "created_at": lead.created_at.isoformat() if lead.created_at else None,
    }


def _product_lead_to_wa_dict(lead: ProductCampaignLead) -> dict:
    return {
        "id": lead.id,
        "source": SOURCE_PRODUCT,
        "source_label": "Product Campaign",
        "business_name": lead.company_name,
        "phone": lead.phone,
        "has_whatsapp": lead.has_whatsapp or "unchecked",
        "whatsapp_checked_at": lead.whatsapp_checked_at,
        "has_message": bool(lead.email_body),
        "message_subject": lead.email_subject,
        "message_body": lead.email_body,
        "whatsapp_message_status": lead.whatsapp_message_status,
        "created_at": lead.created_at.isoformat() if lead.created_at else None,
        "whatsapp_message_sent_at": lead.whatsapp_message_sent_at,
    }


def _get_row(db: Session, source: str, item_id: int, user_id: int):
    """Fetch a single lead/product-campaign-lead row, scoped to the current user."""
    if source == SOURCE_LEAD:
        return db.query(Lead).filter(Lead.id == item_id, Lead.user_id == user_id).first()
    if source == SOURCE_PRODUCT:
        return (
            db.query(ProductCampaignLead)
            .join(ProductCampaign, ProductCampaignLead.campaign_id == ProductCampaign.id)
            .filter(ProductCampaignLead.id == item_id, ProductCampaign.user_id == user_id)
            .first()
        )
    return None


def _row_name(source: str, row) -> str:
    return row.business_name if source == SOURCE_LEAD else row.company_name


def _lead_groq_input(lead: Lead) -> dict:
    return {
        "business_name": lead.business_name,
        "category": lead.category,
        "address": lead.address,
        "city": lead.city,
        "website": lead.website,
        "rating": lead.rating,
        "remarks": lead.remarks,
    }


@router.get("/status")
def whatsapp_status():
    try:
        with httpx.Client(timeout=10) as client:
            resp = client.get(f"{WHATSAPP_SERVICE_URL}/status")
            resp.raise_for_status()
            return {"success": True, "data": resp.json()}
    except httpx.HTTPError:
        return {"success": True, "data": _UNAVAILABLE}


@router.post("/connect")
def whatsapp_connect():
    try:
        with httpx.Client(timeout=10) as client:
            resp = client.post(f"{WHATSAPP_SERVICE_URL}/connect")
            resp.raise_for_status()
            return {"success": True, "data": resp.json()}
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=503,
            detail="WhatsApp service is not running. Start it with `npm run dev` in frontend/.",
        ) from exc


@router.post("/logout")
def whatsapp_logout():
    try:
        with httpx.Client(timeout=10) as client:
            resp = client.post(f"{WHATSAPP_SERVICE_URL}/logout")
            resp.raise_for_status()
            return {"success": True, "data": resp.json()}
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=503, detail="WhatsApp service is not running") from exc


@router.get("/leads")
def whatsapp_leads(
    has_whatsapp: Optional[str] = Query(None),
    classify: str = Query("all", description="all | leads | campaign | product_campaign"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    # (created_at, dict) pairs so the two tables can be merged into one true
    # most-recent-first order instead of just concatenating two separately
    # sorted blocks.
    rows: list = []

    if classify in ("all", "leads", "campaign"):
        q = _leads_query(db, current_user.id, has_whatsapp)
        if classify == "leads":
            q = q.filter(Lead.campaign_id.is_(None))
        elif classify == "campaign":
            q = q.filter(Lead.campaign_id.isnot(None))
        rows += [(lead.created_at, _lead_to_wa_dict(lead)) for lead in q.all()]

    if classify in ("all", "product_campaign"):
        product_leads = _product_leads_query(db, current_user.id, has_whatsapp).all()
        rows += [(lead.created_at, _product_lead_to_wa_dict(lead)) for lead in product_leads]

    def _sort_dt(dt):
        # MySQL drivers commonly hand back naive datetimes even for
        # DateTime(timezone=True) columns, so normalize to naive before
        # comparing — mixing aware/naive here raises TypeError.
        if dt is None:
            return datetime.min
        return dt.replace(tzinfo=None) if dt.tzinfo is not None else dt

    rows.sort(key=lambda r: _sort_dt(r[0]), reverse=True)

    return {"success": True, "data": [d for _, d in rows]}


@router.post("/check-numbers")
async def check_numbers(current_user: User = Depends(get_current_user)):
    """SSE stream — checks every unchecked lead phone number (across both the
    leads table and product_campaign_leads) against WhatsApp via the Baileys
    microservice, one at a time, with a small delay between each call to
    avoid rate limits. POST rather than GET because EventSource can't carry
    the Authorization header; consumed via fetch + ReadableStream on the
    frontend, same pattern as /api/leads/start-sending.
    """
    user_id = current_user.id

    async def _generate():
        db = SessionLocal()
        try:
            items = [
                (SOURCE_LEAD, lead.id, lead.business_name)
                for lead in _leads_query(db, user_id, has_whatsapp="unchecked").all()
            ] + [
                (SOURCE_PRODUCT, lead.id, lead.company_name)
                for lead in _product_leads_query(db, user_id, has_whatsapp="unchecked").all()
            ]
        finally:
            db.close()

        total = len(items)
        if total == 0:
            yield f"data: {json.dumps({'type': 'complete', 'checked': 0, 'total': 0})}\n\n"
            return

        tq: _q.Queue = _q.Queue()

        def _process_in_thread():
            db2 = SessionLocal()
            checked = 0
            try:
                with httpx.Client(timeout=15) as client:
                    for source, item_id, business_name in items:
                        row = _get_row(db2, source, item_id, user_id)
                        if not row:
                            checked += 1
                            continue

                        phone_norm = _normalize_phone(row.phone)
                        result = None

                        if phone_norm:
                            try:
                                resp = client.post(f"{WHATSAPP_SERVICE_URL}/check-number", json={"phone": phone_norm})
                            except httpx.HTTPError as exc:
                                logger.error("WhatsApp check-number request failed for %s %d: %s", source, item_id, exc)
                                tq.put({
                                    "type": "error",
                                    "message": "Couldn't reach the WhatsApp service. Is it running?",
                                })
                                return

                            if resp.status_code == 503:
                                tq.put({
                                    "type": "error",
                                    "message": "WhatsApp is not connected. Connect it from Settings first.",
                                })
                                return

                            try:
                                data = resp.json()
                            except ValueError:
                                # Non-JSON body (e.g. Express's HTML 404 page) means the running
                                # whatsapp-service process predates this route — Node doesn't
                                # hot-reload, so it needs restarting.
                                tq.put({
                                    "type": "error",
                                    "message": (
                                        f"WhatsApp service returned an unexpected response (HTTP {resp.status_code}). "
                                        "It may be running an outdated version — restart it (stop and re-run "
                                        "`npm run dev` in frontend/) and try again."
                                    ),
                                })
                                return

                            result = "yes" if data.get("exists") else "no"
                        else:
                            result = "no"

                        row.has_whatsapp = result
                        row.whatsapp_checked_at = datetime.now(timezone.utc).isoformat()
                        db2.commit()
                        checked += 1

                        tq.put({
                            "type": "progress",
                            "checked": checked,
                            "total": total,
                            "phone": row.phone,
                            "business_name": business_name,
                            "result": result,
                        })

                        if checked < total:
                            time.sleep(random.uniform(1, 2))

                tq.put({"type": "complete", "checked": checked, "total": total})
            except Exception as exc:
                logger.error("WhatsApp check-numbers thread error: %s", exc)
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
                yield f"data: {json.dumps(msg)}\n\n"
                if msg.get("type") == "error":
                    break
        except Exception as exc:
            logger.error("WhatsApp check-numbers SSE error: %s", exc)
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


class GenerateMessagesRequest(BaseModel):
    targets: List[SendTarget] = []


@router.post("/generate-messages")
async def generate_messages(payload: GenerateMessagesRequest, current_user: User = Depends(get_current_user)):
    """SSE stream — writes the Groq message (same generator used for email)
    for WhatsApp leads that don't have one yet, across both the leads table
    and product_campaign_leads. If `targets` is given, only those specific
    leads are generated for (used when the user manually ticks rows in the
    "Not generated" state); with an empty/omitted `targets`, it falls back to
    finding every has_whatsapp == 'yes' lead missing a message and working
    through all of them — same "find everything eligible" shape as
    /check-numbers. Only touches has_whatsapp == 'yes' rows — no point
    spending a Groq call on a number that isn't even reachable on WhatsApp.
    """
    user_id = current_user.id
    explicit_targets = [(t.source, t.id) for t in payload.targets]

    async def _generate():
        db = SessionLocal()
        try:
            settings = db.query(Setting).first()
            company_name = (settings.company_name or "Industronics") if settings else "Industronics"
            groq_key = (settings.groq_api_key or "") if settings else ""

            if explicit_targets:
                items = []
                for source, item_id in explicit_targets:
                    row = _get_row(db, source, item_id, user_id)
                    if row:
                        items.append((source, item_id, _row_name(source, row)))
            else:
                items = [
                    (SOURCE_LEAD, lead.id, lead.business_name)
                    for lead in _leads_query(db, user_id, has_whatsapp="yes")
                    .filter((Lead.email_body.is_(None)) | (Lead.email_body == ""))
                    .all()
                ] + [
                    (SOURCE_PRODUCT, lead.id, lead.company_name)
                    for lead in _product_leads_query(db, user_id, has_whatsapp="yes")
                    .filter((ProductCampaignLead.email_body.is_(None)) | (ProductCampaignLead.email_body == ""))
                    .all()
                ]
        finally:
            db.close()

        total = len(items)
        if total == 0:
            yield f"data: {json.dumps({'type': 'complete', 'generated': 0, 'failed': 0, 'total': 0})}\n\n"
            return

        tq: _q.Queue = _q.Queue()

        def _process_in_thread():
            db2 = SessionLocal()
            generated = 0
            failed = 0
            try:
                for source, item_id, business_name in items:
                    row = _get_row(db2, source, item_id, user_id)
                    if not row:
                        failed += 1
                        continue

                    try:
                        if source == SOURCE_LEAD:
                            email_data = generate_email(_lead_groq_input(row), company_name, groq_key)
                        else:
                            campaign = (
                                db2.query(ProductCampaign)
                                .filter(ProductCampaign.id == row.campaign_id)
                                .first()
                            )
                            email_data = generate_product_email(
                                {
                                    "company_name": row.company_name,
                                    "category": "",
                                    "address": row.address or (campaign.location if campaign else ""),
                                },
                                campaign.product_name if campaign else "",
                                campaign.pitch_angle if campaign else "",
                                groq_key,
                                bool(campaign.attachment_path) if campaign else False,
                            )

                        row.email_subject = email_data["subject"]
                        row.email_body = email_data["body"]
                        db2.commit()
                        generated += 1
                        tq.put({
                            "type": "progress", "generated": generated, "failed": failed,
                            "total": total, "business_name": business_name, "status": "generated",
                        })
                    except Exception as exc:
                        logger.error("WhatsApp message generation failed for %s %d: %s", source, item_id, exc)
                        failed += 1
                        tq.put({
                            "type": "progress", "generated": generated, "failed": failed,
                            "total": total, "business_name": business_name, "status": "failed",
                            "reason": str(exc),
                        })

                tq.put({"type": "complete", "generated": generated, "failed": failed, "total": total})
            except Exception as exc:
                logger.error("WhatsApp generate-messages thread error: %s", exc)
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
                yield f"data: {json.dumps(msg)}\n\n"
        except Exception as exc:
            logger.error("WhatsApp generate-messages SSE error: %s", exc)
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


# ---------- Send via WhatsApp ----------

class SendMessagesRequest(BaseModel):
    targets: List[SendTarget]


@router.post("/send-messages")
async def send_messages(payload: SendMessagesRequest, current_user: User = Depends(get_current_user)):
    """SSE stream — sends the already Groq-generated email body (same text
    used for the email flow) as a WhatsApp text message to a small,
    explicitly-selected batch of leads. Capped at MAX_SEND_BATCH per call as
    a deliberate anti-spam ceiling, not a UI nicety — WhatsApp aggressively
    flags accounts that fire off bulk near-identical messages.
    """
    user_id = current_user.id

    if not payload.targets:
        raise HTTPException(status_code=400, detail="No leads selected.")
    if len(payload.targets) > MAX_SEND_BATCH:
        raise HTTPException(status_code=400, detail=f"You can send to at most {MAX_SEND_BATCH} leads at a time.")

    targets = [(t.source, t.id) for t in payload.targets]

    async def _generate():
        tq: _q.Queue = _q.Queue()
        total = len(targets)

        def _process_in_thread():
            db = SessionLocal()
            sent = 0
            failed = 0
            try:
                with httpx.Client(timeout=15) as client:
                    for idx, (source, item_id) in enumerate(targets):
                        row = _get_row(db, source, item_id, user_id)

                        if not row:
                            failed += 1
                            tq.put({
                                "type": "progress", "id": item_id, "source": source,
                                "business_name": "Unknown", "status": "failed",
                                "reason": "lead not found", "progress": f"{idx + 1}/{total}",
                            })
                            continue

                        business_name = _row_name(source, row)

                        if row.has_whatsapp != "yes":
                            failed += 1
                            tq.put({
                                "type": "progress", "id": item_id, "source": source,
                                "business_name": business_name, "status": "failed",
                                "reason": "not confirmed on WhatsApp", "progress": f"{idx + 1}/{total}",
                            })
                            continue

                        if not row.email_body:
                            failed += 1
                            tq.put({
                                "type": "progress", "id": item_id, "source": source,
                                "business_name": business_name, "status": "failed",
                                "reason": "no generated message — generate an email first", "progress": f"{idx + 1}/{total}",
                            })
                            continue

                        phone_norm = _normalize_phone(row.phone)
                        if not phone_norm:
                            failed += 1
                            tq.put({
                                "type": "progress", "id": item_id, "source": source,
                                "business_name": business_name, "status": "failed",
                                "reason": "invalid phone number", "progress": f"{idx + 1}/{total}",
                            })
                            continue

                        try:
                            resp = client.post(
                                f"{WHATSAPP_SERVICE_URL}/send-message",
                                json={"phone": phone_norm, "message": row.email_body},
                            )
                            ok = resp.status_code == 200 and resp.json().get("success")
                            reason = "" if ok else f"WhatsApp service error (HTTP {resp.status_code})"
                        except httpx.HTTPError as exc:
                            logger.error("WhatsApp send-message request failed for %s %d: %s", source, item_id, exc)
                            ok = False
                            reason = "couldn't reach the WhatsApp service"
                        except ValueError:
                            ok = False
                            reason = "WhatsApp service returned an unexpected response"

                        row.whatsapp_message_status = "sent" if ok else "failed"
                        row.whatsapp_message_sent_at = datetime.now(timezone.utc).isoformat()
                        db.commit()

                        if ok:
                            sent += 1
                        else:
                            failed += 1

                        tq.put({
                            "type": "progress", "id": item_id, "source": source,
                            "business_name": business_name,
                            "status": "sent" if ok else "failed",
                            "reason": reason, "progress": f"{idx + 1}/{total}",
                        })

                        if idx < total - 1:
                            time.sleep(random.uniform(5, 10))

                tq.put({"type": "complete", "sent": sent, "failed": failed})
            except Exception as exc:
                logger.error("WhatsApp send-messages thread error: %s", exc)
                tq.put({"type": "error", "message": str(exc)})
            finally:
                db.close()
                tq.put(None)

        threading.Thread(target=_process_in_thread, daemon=True).start()

        try:
            while True:
                msg = await asyncio.to_thread(tq.get)
                if msg is None:
                    break
                yield f"data: {json.dumps(msg)}\n\n"
        except Exception as exc:
            logger.error("WhatsApp send-messages SSE error: %s", exc)
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
