"""
Website contact enricher.

Given a company website, fetch the home page plus a few common contact/about
pages and pull out the first usable email address and phone number.

Reuses the low-level helpers from ``email_finder`` so the email logic stays in
one place; adds phone-number extraction (``tel:`` links first, then a
digit-count-validated regex fallback on the visible text).
"""

import re

import httpx
from bs4 import BeautifulSoup

from urllib.parse import urljoin, urlparse

from app.services.email_finder import (
    EXTRA_PATHS,
    HEADERS,
    _extract_emails_from_html,
    _filter_generic,
    _normalise_url,
)

# A loose "looks like a phone number" matcher — an optional leading +, a digit,
# then 6+ characters made of digits / spaces / dots / dashes / parens, ending on
# a digit. Real validation happens in _clean_phone by counting digits.
_PHONE_REGEX = re.compile(r"(?<![\w@])\+?\d[\d\s().\-]{6,}\d(?![\w@])")

# Strings that show up in phone-shaped runs of digits but aren't phone numbers.
_PHONE_BLOCKLIST = re.compile(r"(20\d{2}[-/]\d{1,2}[-/]\d{1,2})")  # ISO-ish dates


def _clean_phone(raw: str) -> str | None:
    """Normalise a candidate phone string; return None if it isn't plausible."""
    raw = raw.strip()
    if _PHONE_BLOCKLIST.search(raw):
        return None
    # Keep a single leading + and the digits.
    plus = raw.lstrip().startswith("+")
    digits = re.sub(r"\D", "", raw)
    if not (7 <= len(digits) <= 15):
        return None
    # Reject runs that are clearly not a number (e.g. "111111111").
    if len(set(digits)) == 1:
        return None
    return ("+" + digits) if plus else digits


def _extract_phone_from_html(html: str) -> str | None:
    soup = BeautifulSoup(html, "html.parser")

    for tag in soup.find_all("a", href=True):
        href: str = tag["href"]
        if href.lower().startswith("tel:"):
            candidate = _clean_phone(href[4:].split("?")[0])
            if candidate:
                return candidate

    text = soup.get_text(" ", strip=True)
    for match in _PHONE_REGEX.finditer(text):
        candidate = _clean_phone(match.group())
        if candidate:
            return candidate

    return None


def enrich_from_website(website_url: str) -> dict:
    """
    Return ``{"email": <str|None>, "phone": <str|None>}`` for a company website.

    Fetches the home page and a handful of common contact/about paths, stopping
    early once both an email and a phone number have been found. All network and
    parsing errors are suppressed — a site that can't be reached just yields
    ``None`` for both fields.
    """
    result: dict = {"email": None, "phone": None}
    if not website_url:
        return result

    try:
        base = _normalise_url(website_url)
        parsed = urlparse(base)
        origin = f"{parsed.scheme}://{parsed.netloc}"
    except Exception:
        return result

    pages_to_check = [base] + [urljoin(origin, p) for p in EXTRA_PATHS]

    try:
        with httpx.Client(headers=HEADERS, timeout=8, follow_redirects=True) as client:
            for url in pages_to_check:
                if result["email"] and result["phone"]:
                    break
                try:
                    response = client.get(url)
                    if response.status_code != 200:
                        continue

                    if not result["email"]:
                        emails = _filter_generic(_extract_emails_from_html(response.text))
                        if emails:
                            result["email"] = emails[0]

                    if not result["phone"]:
                        phone = _extract_phone_from_html(response.text)
                        if phone:
                            result["phone"] = phone
                except Exception:
                    continue
    except Exception:
        pass

    return result
