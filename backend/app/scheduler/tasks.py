import logging
from datetime import datetime, timezone

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.interval import IntervalTrigger

from app.models.database import Campaign, EmailLog, Lead, Setting, SessionLocal
from app.services.email_finder import find_email_from_website
from app.services.email_sender import send_email, SMTP_USER, SMTP_PASSWORD
from app.services.groq_writer import generate_email
from app.services.playwright_scraper import scrape_playwright_stream

logger = logging.getLogger(__name__)

scheduler = BackgroundScheduler(timezone="UTC")


# ---------- Core campaign runner ----------

def run_campaign(campaign_id: int) -> None:
    """
    Full pipeline for one campaign:
      1. Scrape Google Maps
      2. Deduplicate against existing leads
      3. Find email from website
      4. Write personalised email with Groq
      5. Send via Gmail SMTP
      6. Save lead + log to database
      7. Update campaign counters and last_run
    """
    db = SessionLocal()
    try:
        campaign = db.query(Campaign).filter(Campaign.id == campaign_id).first()
        if not campaign:
            logger.error("Campaign %d not found", campaign_id)
            return

        if campaign.status != "active":
            logger.info("Campaign %d is not active — skipping", campaign_id)
            return

        settings = db.query(Setting).first()
        if not settings:
            logger.error("No settings found — cannot run campaign %d", campaign_id)
            return

        company_service = settings.company_service or ""

        logger.info("Running campaign %d: '%s in %s'", campaign_id, campaign.keyword, campaign.city)

        # Scrape with the same Playwright scraper the Leads tab uses.
        query = f"{campaign.keyword} {campaign.city}".strip()

        # Resolve the optional campaign attachment (PDF/image) to a disk path.
        # Lazy import avoids a circular import with the campaigns route.
        from app.routes.campaigns import _attachment_full_path
        attach_path = _attachment_full_path(campaign.attachment_path)
        attach_name = campaign.attachment_filename

        leads_added = 0
        emails_sent = 0

        for item in scrape_playwright_stream(query):
            # The scraper yields typed dicts (progress / lead / error) — only act on leads.
            if item.get("_type") != "lead":
                continue

            try:
                name = item.get("name", "")
                maps_url = item.get("maps_url", "")

                exists = None
                if maps_url:
                    exists = db.query(Lead).filter(Lead.maps_url == maps_url, Lead.user_id == campaign.user_id).first()
                if not exists and name:
                    exists = db.query(Lead).filter(Lead.business_name == name, Lead.user_id == campaign.user_id).first()

                if exists:
                    lead = exists
                else:
                    email_addr = None
                    if item.get("website"):
                        email_addr = find_email_from_website(item["website"])

                    lead = Lead(
                        user_id=campaign.user_id,
                        campaign_id=campaign.id,
                        maps_url=maps_url,
                        business_name=name,
                        phone=item.get("phone") or "",
                        address=item.get("address") or "",
                        website=item.get("website") or "",
                        email=email_addr,
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

                if not SMTP_USER or not SMTP_PASSWORD:
                    logger.warning("SMTP credentials not configured — cannot send email for lead %s", lead.business_name)
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

                db.add(EmailLog(
                    lead_id=lead.id,
                    campaign_id=campaign.id,
                    subject=email_data["subject"],
                    body=email_data["body"],
                    status="sent" if success else "failed",
                ))

                if success:
                    lead.status = "contacted"
                    emails_sent += 1

            except Exception as exc:
                logger.error("Error processing place '%s': %s", item.get("name"), exc)
                continue

        campaign.last_run = datetime.now(timezone.utc)
        campaign.total_leads += leads_added
        campaign.emails_sent += emails_sent
        db.commit()

        logger.info(
            "Campaign %d complete — %d leads added, %d emails sent",
            campaign_id, leads_added, emails_sent,
        )

    except Exception as exc:
        logger.error("Fatal error in campaign %d: %s", campaign_id, exc)
        db.rollback()
    finally:
        db.close()


# ---------- Scheduler management ----------

def _schedule_campaign(campaign: Campaign) -> None:
    """Register a single active campaign as an interval job."""
    job_id = f"campaign_{campaign.id}"

    if scheduler.get_job(job_id):
        scheduler.remove_job(job_id)

    scheduler.add_job(
        run_campaign,
        trigger=IntervalTrigger(days=campaign.schedule_days),
        id=job_id,
        args=[campaign.id],
        replace_existing=True,
        name=f"Campaign: {campaign.name}",
    )
    logger.info(
        "Scheduled campaign %d '%s' every %d day(s)",
        campaign.id, campaign.name, campaign.schedule_days,
    )


def refresh_campaign_schedules() -> None:
    """
    Re-sync all active campaigns with the scheduler.
    Called on startup and whenever campaigns are modified.
    """
    db = SessionLocal()
    try:
        active_campaigns = db.query(Campaign).filter(Campaign.status == "active").all()

        current_job_ids = {job.id for job in scheduler.get_jobs()}
        desired_job_ids = {f"campaign_{c.id}" for c in active_campaigns}

        for stale_id in current_job_ids - desired_job_ids:
            scheduler.remove_job(stale_id)
            logger.info("Removed stale scheduler job: %s", stale_id)

        for campaign in active_campaigns:
            _schedule_campaign(campaign)

    except Exception as exc:
        logger.error("Error refreshing campaign schedules: %s", exc)
    finally:
        db.close()


def start_scheduler() -> None:
    """Start the background scheduler and load all active campaigns."""
    refresh_campaign_schedules()
    if not scheduler.running:
        scheduler.start()
        logger.info("APScheduler started")


def stop_scheduler() -> None:
    """Gracefully shut down the scheduler."""
    if scheduler.running:
        scheduler.shutdown(wait=False)
        logger.info("APScheduler stopped")
