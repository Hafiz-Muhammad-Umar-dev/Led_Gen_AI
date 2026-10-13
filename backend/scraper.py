"""
Standalone Google Maps scraper using Playwright (sync API).

Usage:
    python scraper.py "restaurants Karachi" --max 20
"""

import argparse
import re
import sqlite3
import time
from datetime import datetime, timezone
from urllib.parse import quote

from playwright.sync_api import sync_playwright

DB_FILE = "leads.db"


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

def init_db(conn: sqlite3.Connection) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS leads (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            name          TEXT    NOT NULL,
            maps_url      TEXT    UNIQUE NOT NULL,
            phone         TEXT,
            address       TEXT,
            website       TEXT,
            email         TEXT,
            rating        REAL,
            reviews       INTEGER,
            category      TEXT,
            status        TEXT    NOT NULL DEFAULT 'new',
            created_at    TEXT    NOT NULL
        )
    """)
    conn.commit()


def insert_lead(conn: sqlite3.Connection, lead: dict) -> bool:
    """Insert lead; return True if inserted, False if duplicate."""
    try:
        conn.execute(
            """
            INSERT INTO leads
                (name, maps_url, phone, address, website, email,
                 rating, reviews, category, status, created_at)
            VALUES
                (:name, :maps_url, :phone, :address, :website, :email,
                 :rating, :reviews, :category, 'new', :created_at)
            """,
            {**lead, "created_at": datetime.now(timezone.utc).isoformat()},
        )
        conn.commit()
        return True
    except sqlite3.IntegrityError:
        return False


# ---------------------------------------------------------------------------
# Scraper helpers
# ---------------------------------------------------------------------------

def _extract_rating(page) -> str | None:
    selectors = [
        "div[jslog] span[aria-hidden='true']",
        "span.ceNzKf[aria-hidden='true']",
        "span[aria-label*='stars']",
        "div.F7nice span[aria-hidden='true']",
    ]
    pattern = re.compile(r"^\d+(\.\d+)?$")
    for sel in selectors:
        try:
            els = page.query_selector_all(sel)
            for el in els:
                text = (el.inner_text() or "").strip()
                if pattern.match(text):
                    return text
        except Exception:
            continue
    return None


def _extract_reviews(page) -> int | None:
    selectors = [
        "span[aria-label*='review']",
        "span[aria-label*='reviews']",
        "div.F7nice span[aria-label]",
    ]
    for sel in selectors:
        try:
            el = page.query_selector(sel)
            if el:
                label = el.get_attribute("aria-label") or ""
                digits = re.sub(r"\D", "", label)
                if digits:
                    return int(digits)
        except Exception:
            continue
    return None


def scrape_listing(page, maps_url: str) -> dict:
    page.goto(maps_url, wait_until="domcontentloaded", timeout=30000)
    page.wait_for_timeout(2000)

    phone = None
    try:
        el = page.query_selector("[data-item-id*='phone']")
        if el:
            raw = el.get_attribute("data-item-id") or ""
            phone = raw.replace("phone:", "").strip() or None
    except Exception:
        pass

    address = None
    try:
        el = page.query_selector("[data-item-id='address']")
        if el:
            address = (el.inner_text() or "").strip() or None
    except Exception:
        pass

    website = None
    try:
        el = page.query_selector("a[data-item-id='authority']")
        if el:
            website = el.get_attribute("href") or None
    except Exception:
        pass

    rating_str = _extract_rating(page)
    rating = float(rating_str) if rating_str else None

    reviews = _extract_reviews(page)

    category = None
    try:
        el = page.query_selector("button[jsaction*='category']")
        if el:
            category = (el.inner_text() or "").strip() or None
    except Exception:
        pass

    return {
        "phone": phone,
        "address": address,
        "website": website,
        "rating": rating,
        "reviews": reviews,
        "category": category,
        "email": None,
    }


def scrape_search(page, query: str, max_results: int) -> list[dict]:
    encoded = quote(query)
    url = f"https://www.google.com/maps/search/{encoded}"
    page.goto(url, wait_until="domcontentloaded", timeout=30000)

    page.wait_for_selector('[role="feed"]', timeout=15000)

    results: list[dict] = []
    seen_urls: set[str] = set()

    feed = page.query_selector('[role="feed"]')

    while len(results) < max_results:
        anchors = page.query_selector_all('[role="feed"] > div > div > a')
        for anchor in anchors:
            if len(results) >= max_results:
                break
            try:
                name = (anchor.get_attribute("aria-label") or "").strip()
                href = anchor.get_attribute("href") or ""
            except Exception:
                continue

            if not name or not href or href in seen_urls:
                continue

            seen_urls.add(href)
            results.append({"name": name, "maps_url": href})

        if len(results) >= max_results:
            break

        # Scroll the feed
        if feed:
            feed.evaluate("el => el.scrollBy(0, 1000)")
        else:
            page.evaluate("window.scrollBy(0, 1000)")

        time.sleep(1.5)

        # Check if we've hit the end of results
        end_marker = page.query_selector('span.HlvSq')
        if end_marker:
            break

    return results[:max_results]


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Google Maps scraper")
    parser.add_argument("query", help='Search query, e.g. "restaurants Karachi"')
    parser.add_argument("--max", type=int, default=20, dest="max_results",
                        help="Maximum number of results to scrape (default: 20)")
    args = parser.parse_args()

    conn = sqlite3.connect(DB_FILE)
    init_db(conn)

    saved = 0
    skipped = 0

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=True,
            args=["--disable-blink-features=AutomationControlled", "--no-sandbox"],
        )
        context = browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            ),
            viewport={"width": 1280, "height": 720},
            locale="en-US",
        )
        page = context.new_page()

        print(f"[scraper] Searching: '{args.query}' (max {args.max_results})")
        listings = scrape_search(page, args.query, args.max_results)
        print(f"[scraper] Found {len(listings)} listings — fetching details...")

        for i, listing in enumerate(listings, 1):
            print(f"[scraper] ({i}/{len(listings)}) {listing['name']}")
            try:
                details = scrape_listing(page, listing["maps_url"])
                lead = {**listing, **details}
                if insert_lead(conn, lead):
                    saved += 1
                    print(f"           -> saved  | phone={lead['phone']} | rating={lead['rating']}")
                else:
                    skipped += 1
                    print(f"           -> duplicate, skipped")
            except Exception as exc:
                print(f"           -> ERROR: {exc}")
                skipped += 1

        browser.close()

    conn.close()

    print()
    print(f"[scraper] Done. Saved: {saved} | Skipped (duplicates/errors): {skipped}")


if __name__ == "__main__":
    main()
