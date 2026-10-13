import logging
import time
import queue
import requests

logger = logging.getLogger(__name__)

TEXT_SEARCH_URL  = "https://maps.googleapis.com/maps/api/place/textsearch/json"
PLACE_DETAILS_URL = "https://maps.googleapis.com/maps/api/place/details/json"
DETAIL_FIELDS    = "name,formatted_phone_number,formatted_address,website,rating,types"
MAX_PAGES        = 2


def search_places(keyword: str, city: str, api_key: str = "") -> list[dict]:
    return list(search_places_stream(keyword, city, api_key))


def search_places_stream(keyword: str, city: str, api_key: str = ""):
    """
    Generator — calls Google Maps Places API, yields one business dict per result.
    Uses the thread+queue SSE pattern in leads.py so each yield reaches the
    browser immediately.
    """
    if not api_key:
        print("[maps_scraper] ERROR: Google Maps API key is missing")
        logger.error("Google Maps API key is missing")
        return

    query  = f"{keyword} in {city}"
    params = {"query": query, "key": api_key}
    page   = 0

    while page < MAX_PAGES:
        page += 1
        print(f"[maps_scraper] Text search page {page}: '{query}'")

        try:
            resp = requests.get(TEXT_SEARCH_URL, params=params, timeout=10)
            resp.raise_for_status()
            data = resp.json()
        except Exception as exc:
            print(f"[maps_scraper] Text search error (page {page}): {exc}")
            logger.error("Text search error page %d: %s", page, exc)
            break

        status = data.get("status")

        if status == "ZERO_RESULTS":
            print("[maps_scraper] Zero results — done.")
            break

        if status != "OK":
            print(f"[maps_scraper] API error: {status} — {data.get('error_message', '')}")
            logger.error("Places API error: %s", status)
            break

        places = data.get("results", [])
        print(f"[maps_scraper] Page {page}: {len(places)} places found")

        for place in places:
            place_id = place.get("place_id")
            if not place_id:
                continue

            detail = _fetch_detail(place_id, api_key)
            if detail:
                detail["place_id"] = place_id
                detail["keyword"]  = keyword
                detail["city"]     = city
                yield detail

            time.sleep(1)  # stay within API rate limits

        next_token = data.get("next_page_token")
        if not next_token or page >= MAX_PAGES:
            break

        print("[maps_scraper] Waiting 2 s before next page…")
        time.sleep(2)
        params = {"pagetoken": next_token, "key": api_key}

    print(f"[maps_scraper] Stream complete for '{query}'")


def _fetch_detail(place_id: str, api_key: str) -> dict | None:
    try:
        resp = requests.get(
            PLACE_DETAILS_URL,
            params={"place_id": place_id, "fields": DETAIL_FIELDS, "key": api_key},
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()

        if data.get("status") != "OK":
            return None

        r    = data.get("result", {})
        name = r.get("name", "")
        print(f"[maps_scraper]   → {name}")

        return {
            "business_name": name,
            "phone":    r.get("formatted_phone_number", ""),
            "address":  r.get("formatted_address", ""),
            "website":  r.get("website", ""),
            "rating":   r.get("rating"),
            "category": _fmt_category(r.get("types", [])),
            "email":    None,
        }

    except Exception as exc:
        logger.warning("Detail fetch failed for %s: %s", place_id, exc)
        return None


def _fmt_category(types: list) -> str:
    skip = {"point_of_interest", "establishment", "premise", "locality", "political"}
    readable = [t.replace("_", " ").title() for t in types if t not in skip]
    return ", ".join(readable[:3]) if readable else "Business"