import json as _json
import logging
import os
import re
from dotenv import load_dotenv
from groq import Groq
load_dotenv()
logger = logging.getLogger(__name__)

MODEL = "llama-3.3-70b-versatile"

_CITY_WORDS = {
    'karachi', 'lahore', 'islamabad', 'rawalpindi', 'faisalabad', 'multan',
    'peshawar', 'quetta', 'sialkot', 'gujranwala', 'hyderabad', 'sukkur',
    'larkana', 'korangi', 'landhi', 'site', 'gulshan', 'dha', 'clifton',
    'gulberg', 'johar', 'nazimabad', 'north', 'south', 'east', 'west',
    'birmingham', 'manchester', 'london', 'leeds', 'bradford', 'sheffield',
    'liverpool', 'bristol', 'coventry', 'leicester',
}

_STRIP_WORDS = {
    'ltd', 'limited', 'pvt', 'private', 'llc', 'inc', 'incorporated',
    'corp', 'corporation', 'group', 'holdings', 'international', 'associates',
    'brothers', 'bros', 'factory', 'works', 'manufacturing', 'plant', 'mill',
    'store', 'shop', 'center', 'centre', 'office', 'branch', 'enterprise',
    'enterprises', 'trading', 'traders', 'exports', 'imports', 'company',
    'head', 'co',
}


def _clean_company_name(name: str) -> str:
    """Return a short 1-2 word greeting name stripped of cities, legal suffixes and brackets."""
    name = re.sub(r'\(.*?\)', '', name).strip()
    words = name.split()
    filtered = [
        w for w in words
        if w.lower().rstrip('.,') not in _CITY_WORDS
        and w.lower().rstrip('.,') not in _STRIP_WORDS
    ]
    short = ' '.join(filtered[:2]).strip(' ,-')
    return short if short else name.split()[0]


def _sanitize_json(raw: str) -> str:
    """Escape literal control characters inside JSON string values."""
    in_str, escaped, out = False, False, []
    for ch in raw:
        if escaped:
            out.append(ch); escaped = False
        elif ch == '\\' and in_str:
            out.append(ch); escaped = True
        elif ch == '"':
            in_str = not in_str; out.append(ch)
        elif in_str and ord(ch) < 32:
            if ch == '\n': out.append('\\n')
            elif ch == '\r': out.append('\\r')
            elif ch == '\t': out.append('\\t')
            else: out.append(f'\\u{ord(ch):04x}')
        else:
            out.append(ch)
    return ''.join(out)


_SYSTEM_PROMPT = (
    "You are a straight talking business development executive. "
    "You write short, simple, human cold emails. "
    "No corporate language. No long sentences. "
    "Write like a real person emailing another real person. "
    'Return ONLY JSON: { "subject": "...", "body": "..." }'
)

_COLD_EMAIL_SYSTEM = _SYSTEM_PROMPT


def _build_user_prompt(
    short_name: str,
    full_name: str,
    industry_type: str,
    location: str,
    website,
    rating,
    reviews,
    remarks: str,
    agency_name: str,
) -> str:
    remarks_str = remarks if remarks else "None"

    return (
        f"Write a cold email for this business:\n\n"
        f"Short name (use ONLY this in the greeting): {short_name}\n"
        f"Full company name (for context only, never write it in the email): {full_name}\n"
        f"Industry: {industry_type}\n"
        f"Location: {location}\n"
        f"Has Website: {'Yes' if website else 'No'}\n"
        f"Remarks: {remarks_str}\n\n"
        "Our company offers these solutions using AI and Software mapped to industries:\n"
        "- Oil & Gas / Fuel / Petroleum → TMS(Tank management system) and SCADA solution is ready\n"
        "- Manufacturing / Metal / Steel / Fabrication → AI cameras that scan every part "
        "on the production line and flag defects instantly before they reach dispatch + "
        "ERP system to track production output, inventory and orders in one place\n"
        "- Food Manufacturing / Food Production / Food Processing → AI cameras that detect "
        "foreign objects and packaging defects on the production line + ERP system for "
        "batch traceability and compliance tracking (FSA/BRC standards)\n"
        "- Warehouse / Distribution Centre / Fulfilment / 3PL / Freight → Warehouse "
        "Management System (WMS) that gives real time visibility of stock across every "
        "location + remote monitoring and control system so managers can see and control "
        "warehouse operations from anywhere\n"
        "- Real Estate → CRM, property listing website, GenAI\n"
        "- Hospital/Clinic → Patient management, booking system\n"
        "- Logistics → Fleet tracking, route optimization\n"
        "- Retail → Inventory system, POS, ecommerce\n"
        "- Law Firm → AI Automation/ Generative ai for Document automation, case management\n"
        "- Gym/Fitness → Membership app, booking system\n"
        "- Restaurant → Online ordering, reservation chatbot\n"
        "- Pharmacy → Humadity and Temperature control system CMS\n"
        "- Security → AI CCTV, face recognition\n"
        "- General → Custom software, business website, automation\n\n"

        "Email rules:\n"
        f"- Start with 'Hi {short_name} team,' — never use 'Dear', never use the full company name\n"
        "- Leave a blank line after the greeting before the first sentence\n"
        "- The documentation will be attached for the solution so include that in email as well"
        "- Never repeat the company name more than once in the body\n"
        "- Never say 'is likely facing' or 'common to [industry] businesses'\n"
        "- Never say 'We've helped similar companies' without stating a specific result\n"
        "- Follow this 4-sentence structure strictly:\n"

        "- First sentence: one specific pain point for THIS industry:\n"
        "  * Manufacturing/Metal → defective parts slipping through inspection "
        "means costly reworks, scrapped batches and unhappy clients\n"
        "  * Food Manufacturing → manual quality checks on a food production line "
        "are unreliable at scale — one contamination or failed FSA audit can halt "
        "the entire operation\n"
        "  * Warehouse/Distribution/Fulfilment/3PL → manual stock counts and no real "
        "time visibility mean delays, mis-picks and lost stock that's hard to catch "
        "until it's too late\n"
        "  * Oil & Gas → manual tank monitoring means theft risk and inaccurate stock levels\n"
        "  * Logistics → manual dispatch means delays, missed deliveries and unhappy customers\n"
        "  * Clinic → manual appointments means double bookings and lost patient records\n"
        "  * For other industries → pick the most realistic pain point for that business\n"

        "- must seperate this Second sentence: what we offer that solves exactly that problem\n"

        "- Third sentence: specific result they get — use a real outcome not vague words:\n"
        "  * Manufacturing → cut scrap and rework costs, catch defects before dispatch\n"
        "  * Food Manufacturing → full production line visibility, automated compliance "
        "records, catch defects and foreign objects before products ship to retailers\n"
        "  * Warehouse/Distribution/Fulfilment/3PL → real time stock visibility across "
        "every location, fewer mis-picks, ability to monitor and control the warehouse "
        "remotely without being on site\n"
        "  * Oil & Gas → real time tank levels, instant theft alerts\n"
        "  * Logistics → on time deliveries, full fleet visibility\n"
        "  * For others → pick a specific realistic result\n"
        "  * fourth sentence → We have attached the Document for that solution"

        "- fifth sentence: soft CTA — suggest a quick 15 minute call, make this seperate line\n"
        "- Simple words only, no corporate language, no buzzwords\n"
        "- Short sentences, max 4 sentences in the body\n"
        "- Do not use markdown in the email body, plain text only\n"
        "- No exclamation marks\n"
        "- Do NOT include a sign-off or contact info — those will be added automatically\n"
        "- Never use technical jargon. Always use simple business language:\n"
        "  * 'computer vision' or 'CV' → 'AI cameras' or 'automated visual inspection'\n"
        "  * 'machine learning' or 'ML' → 'smart system' or 'AI system'\n"
        "  * 'ERP system' → 'system to manage your entire operation'\n"
        "  * 'computer vision quality inspection' → "
        "'AI cameras that catch defects automatically before they reach your customers'\n"
        "  * 'GenAI' or 'generative AI' → 'AI assistant'\n"
        "  * 'predictive maintenance AI' → 'system that warns you before a machine breaks down'\n"
        "  * 'TMS' → 'fuel and tank monitoring system'\n"
        "  * 'CMS' → 'system to manage your content and operations'\n"
        "- Explain every solution in one simple sentence a non-technical business owner understands\n"
        "- Write as if explaining to a 45-year-old business owner who has never used software before\n\n"
        "Return ONLY:\n"
        "{{\n"
        '  "subject": "...",\n'
        '  "body": "..."\n'
        "}}"
    )

def _build_footer(agency_name: str) -> str:
    website = os.getenv("COMPANY_WEBSITE", "www.industronics.uk/solutions")
    phone = os.getenv("COMPANY_PHONE", "+447882742409")
    contact_email = os.getenv("COMPANY_EMAIL_ADDRESS", "pm.sd@industronics.uk")
    return (
        f"\n\nVisit Our Website for more Info: {website}\n"
        f"Contact Info: \n{phone}, {contact_email}\n\n"
        f"Regards,\nTeam {agency_name}"
    )


def _parse_groq_response(raw: str, fallback_subject: str, agency_name: str) -> dict:
    raw = re.sub(r"^```(?:json)?\s*", "", raw.strip())
    raw = re.sub(r"\s*```$", "", raw.strip())
    json_match = re.search(r'\{.*\}', raw, re.DOTALL)
    if json_match:
        raw = json_match.group(0)
    parsed = _json.loads(_sanitize_json(raw))
    body = str(parsed.get("body", ""))
    return {
        "subject": str(parsed.get("subject", fallback_subject)),
        "body": body + _build_footer(agency_name),
    }


def generate_email(data: dict, company_name: str = "Industronics", api_key: str = "") -> dict:
    """
    Single email generation function for all lead sources.
    Accepts scraped leads (business_name, category, address, city, website, rating, reviews, remarks)
    and uploaded leads (company_name, industry_type, type, remarks) — same prompt, same pipeline.
    Returns {"subject": str, "body": str}.
    """
    full_name = (data.get("business_name") or data.get("company_name") or "your business").strip()
    short_name = _clean_company_name(full_name)
    category = (data.get("category") or data.get("industry_type") or data.get("type") or "your industry").strip()
    location = (data.get("address") or data.get("city") or "N/A").strip()
    website = data.get("website")
    remarks = (data.get("remarks") or "").strip()

    user_prompt = _build_user_prompt(
        short_name=short_name,
        full_name=full_name,
        industry_type=category,
        location=location,
        website=website,
        rating=data.get("rating"),
        reviews=data.get("reviews"),
        remarks=remarks,
        agency_name=company_name,
    )

    model = os.getenv("GROQ_MODEL", MODEL)
    api_key = api_key or os.getenv("GROQ_API_KEY", "")

    try:
        client = Groq(api_key=api_key)
        response = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.8,
            max_tokens=500,
        )
        return _parse_groq_response(
            response.choices[0].message.content,
            fallback_subject=f"Quick question for {short_name}",
            agency_name=company_name,
        )
    except Exception as exc:
        logger.error("Groq email error for '%s': %s", full_name, exc)
        return _fallback_email(short_name, category, company_name)


def _fallback_email(business_name: str, category: str, company_name: str = "Industronics") -> dict:
    """Plain template used when the Groq API call fails."""
    subject = f"Quick question for {business_name}"
    body = (
        f"Dear Team {business_name},\n"
        f"{business_name} is likely facing challenges common to {category} businesses — manual processes "
        "that slow teams down and make scaling harder than it needs to be.\n\n"
        "We've helped similar companies cut manual processing time significantly with custom ERP, "
        "CMMS, and AI solutions built around how they actually operate.\n\n"
        f"We'd love to discuss how this could work for {business_name} — would a 15-minute call this week work?"
        + _build_footer(company_name)
    )
    return {"subject": subject, "body": body}
