"""
Products library — reusable "ready-made" solutions (name + pitch angle +
doc) that Product Campaigns can be created from. Reuses the same
attachment storage rules (folder, allowed types, size limit) as the
product_campaigns route.
"""

import os
import re
import time
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy.orm import Session

from app.models.database import User, get_db
from app.models.products_models import Product
from app.routes.auth import get_current_user

router = APIRouter(prefix="/api/products", tags=["products"])

# Same physical folder + rules the Product Campaigns attachments use.
ATTACHMENTS_DIR = Path(__file__).resolve().parents[2] / "attachments"
ATTACHMENTS_DIR.mkdir(exist_ok=True)

ALLOWED_ATTACHMENT_EXTS = {".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp"}
MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024  # 10 MB


async def _save_attachment(attachment: UploadFile) -> tuple[str, str]:
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
    on_disk_name = f"solution_{safe_stem}_{int(time.time())}{ext}"
    (ATTACHMENTS_DIR / on_disk_name).write_bytes(content)
    return on_disk_name, original_name


@router.post("/create")
async def create_product(
    name: str = Form(...),
    pitch_angle: str = Form(...),
    attachment: Optional[UploadFile] = File(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    on_disk_name = None
    original_name = None
    if attachment is not None and attachment.filename:
        on_disk_name, original_name = await _save_attachment(attachment)

    product = Product(
        user_id=current_user.id,
        name=name,
        pitch_angle=pitch_angle,
        attachment_path=on_disk_name,
        attachment_filename=original_name,
    )
    db.add(product)
    db.commit()
    db.refresh(product)
    return {"success": True, "data": _product_to_dict(product), "message": "Product created"}


@router.get("/list")
def list_products(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    products = (
        db.query(Product)
        .filter(Product.user_id == current_user.id)
        .order_by(Product.created_at.desc())
        .all()
    )
    return {"success": True, "data": [_product_to_dict(p) for p in products], "message": "Products retrieved"}


@router.put("/{product_id}")
async def update_product(
    product_id: int,
    name: str = Form(...),
    pitch_angle: str = Form(...),
    attachment: Optional[UploadFile] = File(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    product = (
        db.query(Product)
        .filter(Product.id == product_id, Product.user_id == current_user.id)
        .first()
    )
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")

    product.name = name
    product.pitch_angle = pitch_angle

    if attachment is not None and attachment.filename:
        on_disk_name, original_name = await _save_attachment(attachment)
        product.attachment_path = on_disk_name
        product.attachment_filename = original_name

    db.commit()
    db.refresh(product)
    return {"success": True, "data": _product_to_dict(product), "message": "Product updated"}


@router.delete("/{product_id}")
def delete_product(product_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    product = (
        db.query(Product)
        .filter(Product.id == product_id, Product.user_id == current_user.id)
        .first()
    )
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")

    # Campaigns already created from this product keep their own copy of
    # attachment_path/attachment_filename, so the on-disk file is left alone.
    db.delete(product)
    db.commit()
    return {"success": True, "message": "Product deleted"}


def _product_to_dict(p: Product) -> dict:
    return {
        "id": p.id,
        "name": p.name,
        "pitch_angle": p.pitch_angle,
        "attachment_filename": p.attachment_filename,
        "created_at": p.created_at.isoformat() if p.created_at else None,
    }
