import re
from urllib.parse import urljoin, urlparse
import httpx
from bs4 import BeautifulSoup

EMAIL_REGEX = re.compile(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}")

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    )
}

EXTRA_PATHS = ["/contact", "/contact-us", "/about", "/about-us"]


def _extract_emails_from_html(html: str) -> list[str]:
    soup = BeautifulSoup(html, "html.parser")
    found: list[str] = []

    for tag in soup.find_all("a", href=True):
        href: str = tag["href"]
        if href.startswith("mailto:"):
            addr = href[7:].split("?")[0].strip()
            if addr and EMAIL_REGEX.match(addr):
                found.append(addr)

    for match in EMAIL_REGEX.finditer(soup.get_text()):
        email = match.group()
        if email not in found:
            found.append(email)

    return found


def _normalise_url(url: str) -> str:
    if not url.startswith(("http://", "https://")):
        url = "https://" + url
    return url.rstrip("/")


def find_email_from_website(website_url: str) -> str | None:
    """
    Fetch the website (and common contact/about paths) and return the first
    valid email address found, or None if nothing is found.
    All network and parsing errors are suppressed.
    """
    if not website_url:
        return None

    try:
        base = _normalise_url(website_url)
        parsed = urlparse(base)
        origin = f"{parsed.scheme}://{parsed.netloc}"
    except Exception:
        return None

    pages_to_check = [base] + [urljoin(origin, p) for p in EXTRA_PATHS]

    try:
        with httpx.Client(headers=HEADERS, timeout=10, follow_redirects=True) as client:
            for url in pages_to_check:
                try:
                    response = client.get(url)
                    if response.status_code != 200:
                        continue
                    emails = _extract_emails_from_html(response.text)
                    emails = _filter_generic(emails)
                    if emails:
                        return emails[0]
                except Exception:
                    continue
    except Exception:
        pass

    return None


_GENERIC_DOMAINS = {"example.com", "domain.com", "email.com", "sentry.io", "wix.com"}
_GENERIC_PREFIXES = {"noreply", "no-reply", "donotreply", "do-not-reply", "webmaster", "postmaster"}


def _filter_generic(emails: list[str]) -> list[str]:
    result = []
    for email in emails:
        local, _, domain = email.partition("@")
        if domain.lower() in _GENERIC_DOMAINS:
            continue
        if local.lower() in _GENERIC_PREFIXES:
            continue
        result.append(email)
    return result
