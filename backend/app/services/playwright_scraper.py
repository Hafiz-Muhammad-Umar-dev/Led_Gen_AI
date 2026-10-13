### 1. Replace `backend/app/services/playwright_scraper.py`

"""
Geoapify-based business lead scraper.
Preserves the existing SSE generator contract:
  {"_type": "progress", "message": "..."}
  {"_type": "lead", ...}
  {"_type": "error", "name": "", "message": "..."}
"""

import logging
import re
import time
from urllib.parse import quote_plus

import requests

logger = logging.getLogger(__name__)

GEOCODING_URL = "https://api.geoapify.com/v1/geocode/search"
PLACES_URL = "https://api.geoapify.com/v2/places"

TIMEOUT = 20
MAX_RADIUS_METERS = 30000

# Geoapify categories are broader than a free-text Google Maps search.
CATEGORY_MAP = {
    "travel": ["office", "commercial", "tourism"],
    "hotel": ["accommodation"],
    "restaurant": ["catering"],
    "cafe": ["catering"],
    "dentist": ["healthcare"],
    "doctor": ["healthcare"],
    "hospital": ["healthcare"],
    "real estate": ["office", "commercial"],
    "school": ["education"],
    "shop": ["commercial"],
    "agency": ["office", "commercial"],
}

# Terms used to match results to the requested business type.
MATCH_TERMS = {
    "travel": [
        "travel", "tour", "tours", "tourism",
        "travel_agent", "travel agency", "visa",
    ],
    "hotel": ["hotel", "motel", "guest_house", "hostel"],
    "restaurant": ["restaurant", "catering.restaurant"],
    "cafe": ["cafe", "coffee"],
    "dentist": ["dentist", "healthcare.dentist"],
    "doctor": ["doctor", "physician", "healthcare"],
    "hospital": ["hospital"],
    "real estate": ["estate_agent", "real estate", "property"],
    "school": ["school", "education"],
    "shop": ["shop", "commercial"],
    "agency": ["agency", "office"],
}


def _parse_query(query: str):
    """Split a query such as 'travel agency in Karachi' into type and city."""
    cleaned = query.strip()
    lower = cleaned.lower()

    location = None
    business_type = lower

    match = re.search(r"\bin\s+(.+)$", cleaned, flags=re.IGNORECASE)
    if match:
        location = match.group(1).strip()
        business_type = cleaned[:match.start()].strip().lower()
    else:
        # Support queries such as 'travel agency Karachi'.
        known_types = sorted(
            set(CATEGORY_MAP.keys()),
            key=len,
            reverse=True,
        )
        for term in known_types:
            if lower.startswith(term):
                location = cleaned[len(term):].strip()
                business_type = term
                break

    if location:
        location = re.sub(r"\s+", " ", location).strip(" ,")
        if "pakistan" not in location.lower():
            location += ", Pakistan"

    if not business_type:
        business_type = lower

    categories = ["commercial", "office"]
    match_terms = []

    for term, cats in CATEGORY_MAP.items():
        if term in business_type:
            categories = cats
            match_terms = MATCH_TERMS.get(term, [term])
            break

    # Remove generic words from matching terms.
    if not match_terms:
        match_terms = [
            word for word in business_type.split()
            if word not in {"in", "near", "the", "and"}
        ]

    return business_type, location, categories, match_terms


def _geocode_location(location: str, api_key: str):
    """Resolve a city/location to coordinates using Geoapify Geocoding."""
    response = requests.get(
        GEOCODING_URL,
        params={
            "text": location,
            "format": "json",
            "limit": 1,
            "apiKey": api_key,
        },
        timeout=TIMEOUT,
    )
    response.raise_for_status()
    data = response.json()

    results = data.get("results") or []
    if not results:
        raise RuntimeError(
            f"Could not locate '{location}'. Try a clearer city name."
        )

    result = results[0]
    return float(result["lon"]), float(result["lat"])


def _fetch_places(
    categories: list[str],
    lon: float,
    lat: float,
    api_key: str,
    limit: int,
):
    """Fetch places within a radius using Geoapify Places API."""
    response = requests.get(
        PLACES_URL,
        params={
            "categories": ",".join(categories),
            "filter": f"circle:{lon},{lat},{MAX_RADIUS_METERS}",
            "bias": f"proximity:{lon},{lat}",
            "limit": min(max(limit, 1), 100),
            "lang": "en",
            "apiKey": api_key,
        },
        timeout=TIMEOUT,
    )
    response.raise_for_status()
    data = response.json()

    if data.get("error"):
        raise RuntimeError(data.get("message") or data["error"])

    return data.get("features", [])


def _raw_properties(properties: dict) -> dict:
    datasource = properties.get("datasource") or {}
    raw = datasource.get("raw") or {}
    return raw if isinstance(raw, dict) else {}


def _get_contact(properties: dict, raw: dict, *keys):
    """Find the first available contact value."""
    contact = properties.get("contact") or {}

    for key in keys:
        value = properties.get(key)
        if value:
            return value

        value = contact.get(key)
        if value:
            return value

        value = raw.get(key)
        if value:
            return value

        # OpenStreetMap often uses contact:phone / contact:website.
        value = raw.get(f"contact:{key}")
        if value:
            return value

    return None


def _format_category(categories) -> str:
    if not isinstance(categories, list):
        return ""

    return ", ".join(
        str(category).replace("_", " ").replace(".", " ").title()
        for category in categories[:5]
    )


def _matches_query(properties: dict, raw: dict, match_terms: list[str]) -> bool:
    """Avoid returning unrelated places from broad parent categories."""
    if not match_terms:
        return True

    name = str(properties.get("name") or "").lower()
    categories = " ".join(properties.get("categories") or []).lower()
    raw_tags = " ".join(
        str(value) for value in raw.values()
        if isinstance(value, (str, int, float))
    ).lower()

    searchable = f"{name} {categories} {raw_tags}"

    return any(term.lower() in searchable for term in match_terms)


def scrape_official_stream(
    query: str,
    max_results: int = 20,
    api_key: str = "",
):
    """
    Search businesses using Geoapify.
    The api_key argument is retained for compatibility with the existing route.
    """
    if not api_key:
        message = (
            "Geoapify API key is missing. Set GEOAPIFY_API_KEY in backend .env."
        )
        logger.error(message)
        yield {"_type": "error", "name": "", "message": message}
        return

    try:
        business_type, location, categories, match_terms = _parse_query(query)

        if not location:
            message = (
                "Please include a city in the search, for example "
                "'travel agency in Karachi'."
            )
            yield {"_type": "error", "name": "", "message": message}
            return

        yield {
            "_type": "progress",
            "message": f"Locating {location}...",
        }

        lon, lat = _geocode_location(location, api_key)

        yield {
            "_type": "progress",
            "message": f"Searching Geoapify for {business_type} in {location}...",
        }

        features = _fetch_places(
            categories=categories,
            lon=lon,
            lat=lat,
            api_key=api_key,
            limit=max_results,
        )

        added = 0

        for feature in features:
            if added >= max_results:
                break

            properties = feature.get("properties") or {}
            raw = _raw_properties(properties)

            name = (
                properties.get("name")
                or properties.get("address_line1")
                or ""
            ).strip()

            if not name:
                continue

            if not _matches_query(properties, raw, match_terms):
                continue

            place_lon = properties.get("lon")
            place_lat = properties.get("lat")

            if place_lon is None or place_lat is None:
                geometry = feature.get("geometry") or {}
                coordinates = geometry.get("coordinates") or []
                if len(coordinates) >= 2:
                    place_lon, place_lat = coordinates[0], coordinates[1]

            place_id = properties.get("place_id") or ""

            if place_lon is not None and place_lat is not None:
                maps_url = (
                    "https://www.google.com/maps/search/?api=1&query="
                    f"{place_lat},{place_lon}"
                )
            else:
                maps_url = (
                    "https://www.google.com/maps/search/?api=1&query="
                    + quote_plus(name)
                )

            phone = _get_contact(
                properties, raw, "phone", "telephone"
            )
            website = _get_contact(
                properties, raw, "website", "url"
            )
            email = _get_contact(
                properties, raw, "email"
            )

            address = (
                properties.get("formatted")
                or properties.get("address_line2")
                or properties.get("address_line1")
                or ""
            )

            city = (
                properties.get("city")
                or properties.get("county")
                or location.split(",")[0]
            )

            categories_found = properties.get("categories") or []

            yield {
                "_type": "lead",
                "name": name,
                "place_id": place_id,
                "maps_url": maps_url,
                "phone": phone,
                "address": address,
                "website": website,
                "rating": properties.get("rating"),
                "category": _format_category(categories_found)
                or business_type.title(),
                "email": email,
                "city": city,
            }

            added += 1

        if added == 0:
            yield {
                "_type": "progress",
                "message": (
                    "No matching businesses found. OpenStreetMap coverage "
                    "may be limited; try a broader business category or city."
                ),
            }

        logger.info(
            "Geoapify scrape complete: query=%r results=%s",
            query,
            added,
        )

    except requests.HTTPError as exc:
        response = exc.response
        detail = response.text[:500] if response is not None else str(exc)
        logger.exception("Geoapify HTTP request failed")
        yield {
            "_type": "error",
            "name": "",
            "message": f"Geoapify HTTP error: {detail}",
        }

    except requests.RequestException as exc:
        logger.exception("Geoapify network request failed")
        yield {
            "_type": "error",
            "name": "",
            "message": f"Could not connect to Geoapify: {exc}",
        }

    except Exception as exc:
        logger.exception("Geoapify scrape failed")
        yield {
            "_type": "error",
            "name": "",
            "message": str(exc),
        }


# Keep old imports working.
scrape_playwright_stream = scrape_official_stream
