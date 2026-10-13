"""
Google Maps scraper using the official Places API (Text Search + Place Details).
Exposed as a generator so the SSE route can stream results in real-time.

Drop-in replacement for scrape_playwright_stream() — same typed-dict contract:
  {"_type": "progress", "message": "..."}
  {"_type": "lead",     "name": "...", "maps_url": "...", ...}
  {"_type": "error",    "name": "...", "message": "..."}

Advantages over the Playwright version:
  - No DOM scraping / CSS selectors to break when Google changes markup.
  - No bot-detection risk, no headless browser to launch/maintain.
  - Returns structured JSON directly (name, phone, address, website, rating,
    types) instead of parsing rendered HTML.
  - No missed/dropped listings from scroll-timing or lazy-load races.

Tradeoffs to be aware of:
  - Costs money per request (Text Search + one Details call per result).
  - Requires a valid Google Maps Places API key with billing enabled.
  - Detail fields are capped by whatever you list in DETAIL_FIELDS (each
    additional field can affect the SKU/cost tier — see Places API pricing).
  - No "maps_url" from Google directly; one is reconstructed from place_id.
"""

import logging
import time

import requests

logger = logging.getLogger(__name__)

TEXT_SEARCH_URL    = "https://maps.googleapis.com/maps/api/place/textsearch/json"
PLACE_DETAILS_URL  = "https://maps.googleapis.com/maps/api/place/details/json"
DETAIL_FIELDS      = "name,formatted_phone_number,formatted_address,website,rating,types,url"
MAX_PAGES          = 2
DETAIL_SLEEP_SEC    = 1     # stay within per-second rate limits
NEXT_PAGE_SLEEP_SEC = 2     # Google requires a short delay before page tokens activate


def scrape_official_stream(query: str, max_results: int = 20, api_key: str = ""):
    """
    Generator — calls the Google Maps Places API and yields typed dicts,
    matching the same shape scrape_playwright_stream() produces.

    `query` works exactly like it did for the Playwright version — pass the
    full search string (e.g. "coffee shops in Austin").
    """
    if not api_key:
        msg = "Google Maps API key is missing"
        print(f"[maps_scraper_official] ERROR: {msg}")
        logger.error(msg)
        yield {"_type": "error", "name": "", "message": msg}
        return

    yield {"_type": "progress", "message": f"Searching Google Maps for '{query}'…"}

    try:
        listings = _text_search(query, api_key, max_results)
    except Exception as exc:
        print(f"[maps_scraper_official] Text search failed: {exc}")
        logger.error("Text search failed: %s", exc)
        yield {"_type": "error", "name": "", "message": str(exc)}
        return

    yield {"_type": "progress", "message": f"Found {len(listings)} listings — fetching details…"}

    for i, listing in enumerate(listings, 1):
        yield {"_type": "progress", "message": f"({i}/{len(listings)}) {listing['name']}"}

        # Individual detail calls occasionally fail (transient network blip,
        # momentary API hiccup) — retry once before giving up, so a single
        # flaky request doesn't drop the lead entirely.
        last_exc = None
        for attempt in range(2):
            try:
                details = _fetch_detail(listing["place_id"], api_key)
                yield {"_type": "lead", **listing, **details}
                last_exc = None
                break
            except Exception as exc:
                last_exc = exc
                if attempt == 0:
                    time.sleep(3)
        if last_exc is not None:
            yield {"_type": "error", "name": listing.get("name", ""), "message": str(last_exc)}

        time.sleep(DETAIL_SLEEP_SEC)

    print(f"[maps_scraper_official] Stream complete for '{query}'")


# Backwards-compatible alias — keeps existing imports working unchanged:
#   from app.services.playwright_scraper import scrape_playwright_stream
# Every call site still works; the only behavior change is that this
# generator now needs an `api_key` kwarg (see dashboard note below).
scrape_playwright_stream = scrape_official_stream


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _text_search(query: str, api_key: str, max_results: int) -> list[dict]:
    """Runs Text Search (paginated) and returns [{name, place_id, maps_url}]."""
    results: list[dict] = []
    params = {"query": query, "key": api_key}
    page = 0

    while page < MAX_PAGES and len(results) < max_results:
        page += 1
        print(f"[maps_scraper_official] Text search page {page}: '{query}'")

        resp = requests.get(TEXT_SEARCH_URL, params=params, timeout=10)
        resp.raise_for_status()
        data = resp.json()

        status = data.get("status")
        if status == "ZERO_RESULTS":
            print("[maps_scraper_official] Zero results — done.")
            break
        if status != "OK":
            raise RuntimeError(f"Places API error: {status} — {data.get('error_message', '')}")

        for place in data.get("results", []):
            if len(results) >= max_results:
                break
            place_id = place.get("place_id")
            name = place.get("name", "")
            if not place_id:
                continue
            results.append({
                "name": name,
                "place_id": place_id,
                # Reconstructed canonical Maps URL (Google doesn't return one
                # directly from Text Search) — usable as a "view on Maps" link.
                "maps_url": f"https://www.google.com/maps/place/?q=place_id:{place_id}",
            })

        next_token = data.get("next_page_token")
        if not next_token or page >= MAX_PAGES or len(results) >= max_results:
            break

        print("[maps_scraper_official] Waiting before next page…")
        time.sleep(NEXT_PAGE_SLEEP_SEC)
        params = {"pagetoken": next_token, "key": api_key}

    return results[:max_results]


def _fetch_detail(place_id: str, api_key: str) -> dict:
    resp = requests.get(
        PLACE_DETAILS_URL,
        params={"place_id": place_id, "fields": DETAIL_FIELDS, "key": api_key},
        timeout=10,
    )
    resp.raise_for_status()
    data = resp.json()

    if data.get("status") != "OK":
        raise RuntimeError(f"Details error: {data.get('status')} — {data.get('error_message', '')}")

    r = data.get("result", {})
    print(f"[maps_scraper_official]   → {r.get('name', '')}")

    return {
        "phone":    r.get("formatted_phone_number"),
        "address":  r.get("formatted_address"),
        "website":  r.get("website"),
        "rating":   r.get("rating"),
        "category": _fmt_category(r.get("types", [])),
        "email":    None,
        "city":     _extract_city(r.get("formatted_address")),
    }


def _fmt_category(types: list) -> str | None:
    skip = {"point_of_interest", "establishment", "premise", "locality", "political"}
    readable = [t.replace("_", " ").title() for t in types if t not in skip]
    return ", ".join(readable[:3]) if readable else None


def _extract_city(address: str | None) -> str | None:
    """Parse city from a Google-formatted address string.
    Walks parts from the end (skipping the country), returns the first segment
    with no digits and length > 3 — skipping postal codes (e.g. '75150',
    'SW1A 2AA') and state/province abbreviations ('TX', 'ON').
    """
    if not address:
        return None
    parts = [p.strip() for p in address.split(",") if p.strip()]
    if len(parts) < 2:
        return None
    for part in reversed(parts[:-1]):  # skip last part (country)
        if any(c.isdigit() for c in part):
            continue
        if len(part) <= 3:
            continue
        return part
    return None