"""
ORM models for the Product Campaigns feature — additive only.
These subclass the same declarative Base used by app.models.database,
so Base.metadata.create_all() (called from database.init_db()) creates
these tables automatically as long as this module has been imported
before init_db() runs (the product_campaigns router imports it at
module load time, and main.py imports the router before startup).
"""

from datetime import datetime, timezone

from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, Text, inspect, text

from app.models.database import Base, engine


def _now():
    return datetime.now(timezone.utc)


class ProductCampaign(Base):
    __tablename__ = "product_campaigns"
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
    campaign_name = Column(String(255), nullable=False)
    product_name = Column(String(255), nullable=False)
    pitch_angle = Column(Text, nullable=False)
    keyword = Column(String(255), nullable=False)
    location = Column(String(255), nullable=False)
    daily_limit = Column(Integer, default=20)
    status = Column(String(50), default="active", nullable=False)
    total_scraped = Column(Integer, default=0)
    total_sent = Column(Integer, default=0)
    # Optional file (PDF/image) attached to every email this campaign sends.
    attachment_path = Column(String(500), nullable=True)      # on-disk filename
    attachment_filename = Column(String(255), nullable=True)  # original display name
    created_at = Column(DateTime(timezone=True), default=_now)


class ProductCampaignLead(Base):
    __tablename__ = "product_campaign_leads"

    id = Column(Integer, primary_key=True, autoincrement=True)
    campaign_id = Column(Integer, ForeignKey("product_campaigns.id"), nullable=False, index=True)
    company_name = Column(String(255))
    short_name = Column(String(255))
    email = Column(String(255), nullable=True, index=True)
    phone = Column(String(50))
    address = Column(String(500))
    website = Column(String(255))
    rating = Column(String(50))
    reviews = Column(String(50))
    maps_url = Column(Text)
    email_status = Column(String(50), default="pending")
    email_subject = Column(String(500))
    email_body = Column(Text)
    email_sent_at = Column(String(100))
    email_fail_reason = Column(Text)
    created_at = Column(DateTime(timezone=True), default=_now)
    has_whatsapp = Column(String(20), default="unchecked", nullable=False)
    whatsapp_checked_at = Column(String(100), nullable=True)
    whatsapp_message_status = Column(String(20), nullable=True)
    whatsapp_message_sent_at = Column(String(100), nullable=True)


class ProductCampaignLog(Base):
    __tablename__ = "product_campaign_logs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    campaign_id = Column(Integer, ForeignKey("product_campaigns.id"), nullable=False, index=True)
    lead_id = Column(Integer, ForeignKey("product_campaign_leads.id"), nullable=True)
    company_name = Column(String(255))
    to_email = Column(String(255))
    subject = Column(String(500))
    body = Column(Text)
    status = Column(String(50))
    sent_at = Column(DateTime(timezone=True), default=_now)


def migrate_product_campaigns():
    """
    create_all() only creates tables that don't exist yet — it never adds
    columns to a table that's already there. Backfills columns added to
    ProductCampaign after the table first shipped (attachment support).
    """
    inspector = inspect(engine)
    if "product_campaigns" not in inspector.get_table_names():
        return

    existing_cols = [c["name"] for c in inspector.get_columns("product_campaigns")]
    added_user_id = False
    for col, ddl in [
        ("attachment_path", "VARCHAR(500) NULL"),
        ("attachment_filename", "VARCHAR(255) NULL"),
        ("user_id", "INT NULL"),
    ]:
        if col not in existing_cols:
            with engine.connect() as conn:
                conn.execute(text(f"ALTER TABLE product_campaigns ADD COLUMN {col} {ddl}"))
                conn.commit()
            print(f"[db] Migration: added {col} column to product_campaigns")
            if col == "user_id":
                added_user_id = True

    # Widen maps_url: Google Maps place URLs (URL-encoded Arabic names, coordinates,
    # feature IDs) routinely exceed 500 chars and were getting truncated at insert.
    if "product_campaign_leads" in inspector.get_table_names():
        lead_cols = {c["name"]: c for c in inspector.get_columns("product_campaign_leads")}
        maps_url_col = lead_cols.get("maps_url")
        if maps_url_col is not None and getattr(maps_url_col["type"], "length", None) is not None:
            with engine.connect() as conn:
                conn.execute(text("ALTER TABLE product_campaign_leads MODIFY COLUMN maps_url TEXT NULL"))
                conn.commit()
            print("[db] Migration: widened product_campaign_leads.maps_url to TEXT")

        for col, ddl in [
            ("has_whatsapp", "VARCHAR(20) NOT NULL DEFAULT 'unchecked'"),
            ("whatsapp_checked_at", "VARCHAR(100) NULL"),
            ("whatsapp_message_status", "VARCHAR(20) NULL"),
            ("whatsapp_message_sent_at", "VARCHAR(100) NULL"),
        ]:
            if col not in lead_cols:
                with engine.connect() as conn:
                    conn.execute(text(f"ALTER TABLE product_campaign_leads ADD COLUMN {col} {ddl}"))
                    conn.commit()
                print(f"[db] Migration: added {col} column to product_campaign_leads")

    if added_user_id:
        with engine.connect() as conn:
            demo_id = conn.execute(text("SELECT id FROM users WHERE username = 'demo'")).scalar()
            if demo_id:
                conn.execute(
                    text("UPDATE product_campaigns SET user_id = :uid WHERE user_id IS NULL"),
                    {"uid": demo_id},
                )
                conn.commit()
                print(f"[db] Migration: backfilled existing product_campaigns to user_id={demo_id} (demo)")
            else:
                print("[db] Migration warning: no 'demo' user found — existing product_campaigns left with user_id=NULL")
