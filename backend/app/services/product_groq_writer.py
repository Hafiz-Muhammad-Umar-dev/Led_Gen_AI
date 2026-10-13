"""
Groq email generation for Product Campaigns — a separate, product-specific
prompt from app.services.groq_writer (which is left untouched). Reuses
_clean_company_name and _sanitize_json from groq_writer instead of
duplicating that logic.
"""

import json as _json
import logging
import os
import re

from dotenv import load_dotenv
from groq import Groq

from app.services.groq_writer import _build_footer, _clean_company_name, _sanitize_json

_AGENCY_NAME = "Industronics Engineering"

load_dotenv()
logger = logging.getLogger(__name__)

MODEL = "llama-3.3-70b-versatile"

_PRODUCT_SYSTEM_PROMPT = (
    "You are a business development executive writing highly "
    "personalized cold emails. You write short, direct, human emails. "
    'Return ONLY JSON: { "subject": "...", "body": "..." }'
)


def _build_product_user_prompt(
    short_name: str,
    industry_type: str,
    location: str,
    product_name: str,
    pitch_angle: str,
) -> str:
    return (
        f"Write a cold email for this business:\n\n"
        f"Company (greeting only): {short_name} team\n"
        f"Industry: {industry_type}\n"
        f"Location: {location}\n\n"
        f"Product we are pitching: {product_name}\n\n"
        "Our pitch angle — follow this exactly when writing the email:\n"
        f"{pitch_angle}\n\n"
        "Email rules:\n"
        f"- Start with 'Hi {short_name} team,'\n"
        "- Leave a blank line after the greeting\n"
        "- First sentence: specific pain point this industry has "
        "that the product solves\n"
        "- Leave a blank line, then the second sentence\n"
        "- Second sentence: introduce the product naturally using "
        "the pitch angle the user provided\n"
        "- Leave a blank line, then the third sentence\n"
        "- Third sentence: one specific result or benefit they get\n"
        "- Leave a blank line, then the fourth sentence\n"
        "- Fourth sentence: soft CTA — suggest a 15 minute call\n"
        "- Each sentence is its own paragraph, separated by a blank line\n"
        "- Max 4 sentences in body\n"
        "- Simple plain English, no jargon, no buzzwords\n"
        "- No markdown, plain text only\n"
        "- No exclamation marks\n"
        "- Do NOT add sign-off or contact info\n\n"
        "Return ONLY:\n"
        "{{\n"
        '  "subject": "...",\n'
        '  "body": "..."\n'
        "}}"
    )


_ATTACHMENT_LINE = "We have attached the system doc to check the details."


def _parse_product_response(raw: str, fallback_subject: str, has_attachment: bool = False) -> dict:
    raw = re.sub(r"^```(?:json)?\s*", "", raw.strip())
    raw = re.sub(r"\s*```$", "", raw.strip())
    json_match = re.search(r'\{.*\}', raw, re.DOTALL)
    if json_match:
        raw = json_match.group(0)
    parsed = _json.loads(_sanitize_json(raw))
    body = str(parsed.get("body", ""))
    if has_attachment:
        body += f"\n\n{_ATTACHMENT_LINE}"
    return {
        "subject": str(parsed.get("subject", fallback_subject)),
        "body": body + _build_footer(_AGENCY_NAME),
    }


def generate_product_email(
    lead: dict,
    product_name: str,
    pitch_angle: str,
    api_key: str = "",
    has_attachment: bool = False,
) -> dict:
    """
    Generate a product-pitch cold email for a single scraped lead.
    `lead` accepts company_name, category, address — same shape as the
    dict built from a ProductCampaignLead row. Returns {"subject", "body"}.
    """
    full_name = (lead.get("company_name") or "your business").strip()
    short_name = _clean_company_name(full_name) if full_name else "there"
    industry_type = (lead.get("category") or "your industry").strip()
    location = (lead.get("address") or "N/A").strip()

    user_prompt = _build_product_user_prompt(
        short_name=short_name,
        industry_type=industry_type,
        location=location,
        product_name=product_name,
        pitch_angle=pitch_angle,
    )

    model = os.getenv("GROQ_MODEL", MODEL)
    api_key = api_key or os.getenv("GROQ_API_KEY", "")

    try:
        client = Groq(api_key=api_key)
        response = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": _PRODUCT_SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.8,
            max_tokens=500,
        )
        return _parse_product_response(
            response.choices[0].message.content,
            fallback_subject=f"Quick question for {short_name}",
            has_attachment=has_attachment,
        )
    except Exception as exc:
        logger.error("Product Groq email error for '%s': %s", full_name, exc)
        return _fallback_product_email(short_name, product_name, has_attachment=has_attachment)


def _fallback_product_email(short_name: str, product_name: str, has_attachment: bool = False) -> dict:
    """Plain template used when the Groq API call fails."""
    subject = f"Quick question for {short_name}"
    body = (
        f"Hi {short_name} team,\n\n"
        f"Many businesses like yours lose time and money to problems "
        f"{product_name} is built to solve.\n\n"
        f"{product_name} fixes this directly, without adding complexity "
        "to your day-to-day operations.\n\n"
        "Teams using it see fewer errors and less time wasted on manual checks.\n\n"
        "Would a quick 15 minute call this week work to see if it's a fit?"
    )
    if has_attachment:
        body += f"\n\n{_ATTACHMENT_LINE}"
    body += _build_footer(_AGENCY_NAME)
    return {"subject": subject, "body": body}
