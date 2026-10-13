"""
ORM model for the Products library — reusable "ready-made" solutions
(name + pitch angle + doc) that Product Campaigns can be created from
instead of retyping everything each time. Additive only, subclasses the
same declarative Base as app.models.database, so Base.metadata.create_all()
(called from database.init_db()) creates this table automatically as long
as this module has been imported before init_db() runs (the products
router imports it at module load time, and main.py imports the router
before startup).
"""

from datetime import datetime, timezone

from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, Text

from app.models.database import Base


def _now():
    return datetime.now(timezone.utc)


class Product(Base):
    __tablename__ = "products"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
    name = Column(String(255), nullable=False)
    pitch_angle = Column(Text, nullable=False)
    # Optional file (PDF/image) reused by every campaign created from this product.
    attachment_path = Column(String(500), nullable=True)      # on-disk filename
    attachment_filename = Column(String(255), nullable=True)  # original display name
    created_at = Column(DateTime(timezone=True), default=_now)
