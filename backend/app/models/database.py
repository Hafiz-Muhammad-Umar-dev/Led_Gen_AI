import os
from datetime import datetime, timezone

def _now():
    return datetime.now(timezone.utc)

from dotenv import load_dotenv
from sqlalchemy import (
    Boolean, Column, DateTime, Enum, Float, ForeignKey,
    Integer, String, Text, create_engine, inspect, text,
)
from sqlalchemy.orm import declarative_base, relationship, sessionmaker
from sqlalchemy.pool import QueuePool

load_dotenv()

DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "mysql+mysqlconnector://root:@localhost:3306/leadgen_db",
)

engine = create_engine(
    DATABASE_URL,
    poolclass=QueuePool,
    pool_size=5,
    max_overflow=10,
    pool_pre_ping=True,
    pool_recycle=3600,
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, autoincrement=True)
    username = Column(String(100), unique=True, nullable=False, index=True)
    email = Column(String(255), unique=True, nullable=False, index=True)
    password_hash = Column(String(255), nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime(timezone=True), default=_now)


class Lead(Base):
    __tablename__ = "leads"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
    campaign_id = Column(Integer, ForeignKey("campaigns.id"), nullable=True, index=True)
    place_id = Column(String(255), nullable=True, index=True)
    maps_url = Column(String(500), nullable=True, index=True)
    business_name = Column(String(255), nullable=False)
    phone = Column(String(50))
    address = Column(String(500))
    website = Column(String(255))
    email = Column(String(255), nullable=True)
    category = Column(String(255))
    rating = Column(Float)
    city = Column(String(100))
    keyword = Column(String(255))
    status = Column(
        Enum("new", "contacted", "replied", "converted"),
        default="new",
        nullable=False,
    )
    created_at = Column(DateTime(timezone=True), default=_now)
    updated_at = Column(DateTime(timezone=True), default=_now, onupdate=_now)
    email_status = Column(String(50), default="pending", nullable=True)
    email_sent_at = Column(String(100), nullable=True)
    email_subject = Column(String(500), nullable=True)
    email_body = Column(Text, nullable=True)
    source = Column(String(50), nullable=True, index=True)
    remarks = Column(Text, nullable=True)
    has_whatsapp = Column(String(20), default="unchecked", nullable=False)
    whatsapp_checked_at = Column(String(100), nullable=True)
    whatsapp_message_status = Column(String(20), nullable=True)
    whatsapp_message_sent_at = Column(String(100), nullable=True)

    email_logs = relationship("EmailLog", back_populates="lead", cascade="all, delete-orphan")


class Campaign(Base):
    __tablename__ = "campaigns"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
    name = Column(String(255), nullable=False)
    keyword = Column(String(255), nullable=False)
    city = Column(String(100), nullable=False)
    status = Column(
        Enum("active", "paused", "completed"),
        default="active",
        nullable=False,
    )
    schedule_days = Column(Integer, default=4)
    max_leads = Column(Integer, default=20)
    total_leads = Column(Integer, default=0)
    emails_sent = Column(Integer, default=0)
    created_at = Column(DateTime(timezone=True), default=_now)
    last_run = Column(DateTime(timezone=True), nullable=True)
    # Optional file (PDF/image) attached to every email this campaign sends.
    attachment_path = Column(String(500), nullable=True)      # on-disk filename
    attachment_filename = Column(String(255), nullable=True)  # original display name

    email_logs = relationship("EmailLog", back_populates="campaign", cascade="all, delete-orphan")


class EmailLog(Base):
    __tablename__ = "email_logs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    lead_id = Column(Integer, ForeignKey("leads.id"), nullable=False)
    campaign_id = Column(Integer, ForeignKey("campaigns.id"), nullable=False)
    subject = Column(String(500))
    body = Column(Text)
    status = Column(Enum("sent", "failed"), nullable=False)
    sent_at = Column(DateTime(timezone=True), default=_now)

    lead = relationship("Lead", back_populates="email_logs")
    campaign = relationship("Campaign", back_populates="email_logs")


class SentEmail(Base):
    __tablename__ = "sent_emails"

    id = Column(Integer, primary_key=True, autoincrement=True)
    lead_id = Column(Integer, nullable=True)
    campaign_id = Column(Integer, nullable=True, index=True)
    company_name = Column(String(255), nullable=True)
    to_email = Column(String(255), nullable=True)
    subject = Column(String(500), nullable=True)
    body = Column(Text, nullable=True)
    sent_at = Column(DateTime(timezone=True), default=_now)
    source = Column(String(50), nullable=True)


class Setting(Base):
    __tablename__ = "settings"

    id = Column(Integer, primary_key=True, autoincrement=True)
    gmail_sender = Column(String(255))
    gmail_app_password = Column(String(255))
    groq_api_key = Column(String(255))
    maps_api_key = Column(String(255))
    schedule_days = Column(Integer, default=4)
    email_template = Column(Text)
    company_name = Column(String(255))
    company_service = Column(Text)


class UploadedLead(Base):
    __tablename__ = "uploaded_leads"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
    company_name = Column(String(255))
    email = Column(String(255), nullable=True)
    industry_type = Column(String(255), nullable=True)
    remarks = Column(Text, nullable=True)
    email_status = Column(String(50), default="pending")
    email_sent_at = Column(String(100), nullable=True)
    email_subject = Column(String(500), nullable=True)
    email_body = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), default=_now)
    upload_batch = Column(String(255), nullable=True, index=True)


def get_db():
    """FastAPI dependency — yields a DB session and closes it after the request."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    """Create all tables, run lightweight migrations, and seed default settings."""
    Base.metadata.create_all(bind=engine)

    # Ensure users table has is_active column if it pre-dates this migration
    try:
        user_cols = [c["name"] for c in inspect(engine).get_columns("users")]
        if "is_active" not in user_cols:
            with engine.connect() as conn:
                conn.execute(text("ALTER TABLE users ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1"))
                conn.commit()
    except Exception:
        pass

    # Add place_id column if the leads table already existed without it
    try:
        existing_cols = [c["name"] for c in inspect(engine).get_columns("leads")]
        if "place_id" not in existing_cols:
            with engine.connect() as conn:
                conn.execute(text("ALTER TABLE leads ADD COLUMN place_id VARCHAR(255) NULL"))
                conn.commit()
            print("[db] Migration: added place_id column to leads")
        if "maps_url" not in existing_cols:
            with engine.connect() as conn:
                conn.execute(text("ALTER TABLE leads ADD COLUMN maps_url VARCHAR(500) NULL"))
                conn.commit()
            print("[db] Migration: added maps_url column to leads")
        for col, ddl in [
            ("campaign_id", "INT NULL"),
            ("email_status", "VARCHAR(50) DEFAULT 'pending'"),
            ("email_sent_at", "VARCHAR(100) NULL"),
            ("email_subject", "VARCHAR(500) NULL"),
            ("email_body", "MEDIUMTEXT NULL"),
            ("source", "VARCHAR(50) NULL"),
            ("remarks", "TEXT NULL"),
            ("has_whatsapp", "VARCHAR(20) NOT NULL DEFAULT 'unchecked'"),
            ("whatsapp_checked_at", "VARCHAR(100) NULL"),
            ("whatsapp_message_status", "VARCHAR(20) NULL"),
            ("whatsapp_message_sent_at", "VARCHAR(100) NULL"),
        ]:
            if col not in existing_cols:
                with engine.connect() as conn:
                    conn.execute(text(f"ALTER TABLE leads ADD COLUMN {col} {ddl}"))
                    conn.commit()
                print(f"[db] Migration: added {col} column to leads")
    except Exception as exc:
        print(f"[db] Migration warning: {exc}")

    # Add max_leads column if the campaigns table pre-dates this migration
    try:
        campaign_cols = [c["name"] for c in inspect(engine).get_columns("campaigns")]
        if "max_leads" not in campaign_cols:
            with engine.connect() as conn:
                conn.execute(text("ALTER TABLE campaigns ADD COLUMN max_leads INT DEFAULT 20"))
                conn.commit()
            print("[db] Migration: added max_leads column to campaigns")
        for col, ddl in [
            ("attachment_path", "VARCHAR(500) NULL"),
            ("attachment_filename", "VARCHAR(255) NULL"),
        ]:
            if col not in campaign_cols:
                with engine.connect() as conn:
                    conn.execute(text(f"ALTER TABLE campaigns ADD COLUMN {col} {ddl}"))
                    conn.commit()
                print(f"[db] Migration: added {col} column to campaigns")
    except Exception as exc:
        print(f"[db] Campaign migration warning: {exc}")

    # Add campaign_id column if the sent_emails table pre-dates this migration
    try:
        sent_email_cols = [c["name"] for c in inspect(engine).get_columns("sent_emails")]
        if "campaign_id" not in sent_email_cols:
            with engine.connect() as conn:
                conn.execute(text("ALTER TABLE sent_emails ADD COLUMN campaign_id INT NULL"))
                conn.commit()
            print("[db] Migration: added campaign_id column to sent_emails")
    except Exception as exc:
        print(f"[db] sent_emails migration warning: {exc}")

    # Add user_id to leads/campaigns/uploaded_leads and backfill existing rows
    # onto the 'demo' account, so this per-user split doesn't orphan old data.
    try:
        added_user_id = False
        for table in ("leads", "campaigns", "uploaded_leads"):
            cols = [c["name"] for c in inspect(engine).get_columns(table)]
            if "user_id" not in cols:
                with engine.connect() as conn:
                    conn.execute(text(f"ALTER TABLE {table} ADD COLUMN user_id INT NULL"))
                    conn.commit()
                print(f"[db] Migration: added user_id column to {table}")
                added_user_id = True

        if added_user_id:
            with engine.connect() as conn:
                demo_id = conn.execute(
                    text("SELECT id FROM users WHERE username = 'demo'")
                ).scalar()
                if demo_id:
                    for table in ("leads", "campaigns", "uploaded_leads"):
                        conn.execute(
                            text(f"UPDATE {table} SET user_id = :uid WHERE user_id IS NULL"),
                            {"uid": demo_id},
                        )
                    conn.commit()
                    print(f"[db] Migration: backfilled existing leads/campaigns/uploaded_leads to user_id={demo_id} (demo)")
                else:
                    print("[db] Migration warning: no 'demo' user found — existing rows left with user_id=NULL")
    except Exception as exc:
        print(f"[db] user_id migration warning: {exc}")

    db = SessionLocal()
    try:
        if db.query(Setting).count() == 0:
            db.add(Setting(
                gmail_sender=os.getenv("GMAIL_SENDER", ""),
                gmail_app_password=os.getenv("GMAIL_APP_PASSWORD", ""),
                groq_api_key=os.getenv("GROQ_API_KEY", ""),
                maps_api_key=os.getenv("GOOGLE_MAPS_API_KEY", ""),
                schedule_days=4,
                email_template="",
                company_name="Industronics",
                company_service="Automation, Instrumentation, Software, and AI Services",
            ))
            db.commit()
    finally:
        db.close()
