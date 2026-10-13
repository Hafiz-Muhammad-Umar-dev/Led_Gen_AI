import logging
import mimetypes
import os
import smtplib
import ssl
from email.mime.application import MIMEApplication
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

logger = logging.getLogger(__name__)

SMTP_HOST = os.getenv("SMTP_HOST")
SMTP_PORT = int(os.getenv("SMTP_PORT", 465))
SMTP_USER = os.getenv("SMTP_USER")
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD")

_state: dict = {"last_error": ""}


def get_last_error() -> str:
    return _state["last_error"]


def send_email(
    to_email: str,
    subject: str,
    body: str,
    attachment_path: str = None,
    attachment_name: str = None,
) -> bool:
    """Send an HTML email via SMTP. Returns True on success, False on failure.

    Optionally attaches a single file (e.g. a PDF or image) if
    ``attachment_path`` points to an existing file.
    """
    _state["last_error"] = ""

    try:
        msg = MIMEMultipart()
        msg["Subject"] = subject
        msg["From"] = SMTP_USER
        msg["To"] = to_email
        msg.attach(MIMEText(body, "plain", "utf-8"))

        if attachment_path and os.path.isfile(attachment_path):
            display_name = attachment_name or os.path.basename(attachment_path)
            ctype, _ = mimetypes.guess_type(display_name)
            subtype = ctype.split("/", 1)[1] if ctype and "/" in ctype else "octet-stream"
            with open(attachment_path, "rb") as fh:
                part = MIMEApplication(fh.read(), _subtype=subtype)
            part.add_header("Content-Disposition", "attachment", filename=display_name)
            msg.attach(part)

        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE

        if SMTP_PORT == 465:
            with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, context=ctx) as server:
                server.login(SMTP_USER, SMTP_PASSWORD)
                server.sendmail(SMTP_USER, to_email, msg.as_string())
        else:
            with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as server:
                server.ehlo()
                server.starttls(context=ctx)
                server.ehlo()
                server.login(SMTP_USER, SMTP_PASSWORD)
                server.sendmail(SMTP_USER, to_email, msg.as_string())

        logger.info("Email sent to %s | subject: %s", to_email, subject)
        return True

    except smtplib.SMTPAuthenticationError as exc:
        _state["last_error"] = f"Authentication failed — wrong SMTP_USER or SMTP_PASSWORD ({exc})"
    except smtplib.SMTPRecipientsRefused as exc:
        _state["last_error"] = f"Recipient refused: {to_email} ({exc})"
    except smtplib.SMTPException as exc:
        _state["last_error"] = f"SMTP error: {exc}"
    except OSError as exc:
        _state["last_error"] = f"Connection error — check SMTP_HOST and SMTP_PORT ({exc})"
    except Exception as exc:
        _state["last_error"] = f"Unexpected error: {exc}"

    logger.error("send_email failed for %s: %s", to_email, _state["last_error"])
    return False


def _wrap_html(plain_text: str) -> str:
    paragraphs = "".join(
        f"<p>{line}</p>" for line in plain_text.splitlines() if line.strip()
    )
    return f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body {{ font-family: Arial, sans-serif; font-size: 14px; color: #222; line-height: 1.6; }}
    p {{ margin: 0 0 12px; }}
  </style>
</head>
<body>{paragraphs}</body>
</html>"""
