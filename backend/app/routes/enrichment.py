"""
Email / phone enrichment from a CSV of companies.

Upload a sheet that has (at least) a company name and a website column; the
endpoint visits each website, pulls the first usable email + phone number, and
streams the enriched rows back over SSE. The frontend accumulates the rows and
offers them as a downloadable CSV.
"""

import io
import json
import logging
import queue
import threading
from concurrent.futures import ThreadPoolExecutor

import pandas as pd
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse

from app.models.database import User
from app.routes.auth import get_current_user
from app.services.website_enricher import enrich_from_website

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/enrichment", tags=["enrichment"])

# Header aliases → canonical field. Compared after lower-casing and stripping
# both surrounding whitespace and internal spaces/underscores.
_COMPANY_ALIASES = {"companyname", "company", "name", "businessname", "business"}
_WEBSITE_ALIASES = {"website", "url", "domain", "web", "site", "weburl", "homepage"}
_INDUSTRY_ALIASES = {"industry", "industrytype", "type", "sector", "category"}

_MAX_WORKERS = 8


def _norm(col: str) -> str:
    return str(col).strip().lower().replace(" ", "").replace("_", "").replace("-", "")


def _pick_column(columns, aliases):
    for col in columns:
        if _norm(col) in aliases:
            return col
    return None


def _clean(value) -> str:
    text = str(value or "").strip()
    return "" if text.lower() == "nan" else text


@router.post("/enrich")
async def enrich_sheet(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    filename = file.filename or "upload"
    if not filename.lower().endswith((".csv", ".xlsx")):
        raise HTTPException(status_code=400, detail="Only .csv and .xlsx files are supported.")

    content = await file.read()
    try:
        if filename.lower().endswith(".csv"):
            df = pd.read_csv(io.BytesIO(content))
        else:
            df = pd.read_excel(io.BytesIO(content))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Failed to parse file: {exc}")

    company_col = _pick_column(df.columns, _COMPANY_ALIASES)
    website_col = _pick_column(df.columns, _WEBSITE_ALIASES)
    industry_col = _pick_column(df.columns, _INDUSTRY_ALIASES)

    if not company_col or not website_col:
        raise HTTPException(
            status_code=400,
            detail="Missing required column. Expected a company name column and a website column "
            "(e.g. 'company_name', 'website').",
        )

    rows = []
    for _, raw in df.iterrows():
        company = _clean(raw.get(company_col))
        website = _clean(raw.get(website_col))
        industry = _clean(raw.get(industry_col)) if industry_col else ""
        if not company and not website:
            continue
        rows.append({"company_name": company, "industry": industry, "website": website})

    if not rows:
        raise HTTPException(status_code=400, detail="No usable rows found in the sheet.")

    total = len(rows)

    def _generate():
        tq: queue.Queue = queue.Queue()

        def _worker():
            done = 0
            try:
                with ThreadPoolExecutor(max_workers=min(_MAX_WORKERS, total)) as pool:
                    future_to_idx = {}
                    for idx, row in enumerate(rows):
                        if row["website"]:
                            future_to_idx[pool.submit(enrich_from_website, row["website"])] = idx
                        else:
                            # No website to visit — emit an empty enrichment straight away.
                            done += 1
                            tq.put({
                                "type": "row",
                                "index": idx,
                                **rows[idx],
                                "email": "",
                                "phone": "",
                                "status": "no_website",
                                "done": done,
                                "total": total,
                            })

                    from concurrent.futures import as_completed

                    for future in as_completed(future_to_idx):
                        idx = future_to_idx[future]
                        try:
                            found = future.result()
                        except Exception as exc:
                            logger.error("Enrichment failed for %s: %s", rows[idx]["website"], exc)
                            found = {"email": None, "phone": None}
                        done += 1
                        email = found.get("email") or ""
                        phone = found.get("phone") or ""
                        tq.put({
                            "type": "row",
                            "index": idx,
                            **rows[idx],
                            "email": email,
                            "phone": phone,
                            "status": "found" if (email or phone) else "not_found",
                            "done": done,
                            "total": total,
                        })

                tq.put({"type": "complete", "total": total})
            except Exception as exc:
                logger.error("Enrichment worker crashed: %s", exc)
                tq.put({"type": "error", "message": str(exc)})
            finally:
                tq.put(None)

        threading.Thread(target=_worker, daemon=True).start()

        yield f"data: {json.dumps({'type': 'start', 'total': total})}\n\n"

        while True:
            try:
                msg = tq.get(timeout=15)
            except queue.Empty:
                yield ": ping\n\n"
                continue
            if msg is None:
                break
            yield f"data: {json.dumps(msg)}\n\n"

    return StreamingResponse(
        _generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
