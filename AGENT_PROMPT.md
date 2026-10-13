# LeadGen AI System — Claude Agent Prompt

## Project Overview
You are building a professional AI-powered Lead Generation System for a company that provides Automation, Instrumentation, Software, and AI Services. The system scrapes Google Maps for business leads, enriches them with contact info, writes personalized emails using Groq AI, and sends them via Gmail SMTP.

---

## Tech Stack
- **Backend**: FastAPI (Python)
- **Frontend**: React + Tailwind CSS
- **Database**: MySQL (via mysql-connector-python + SQLAlchemy)
- **AI**: Groq API (llama3-8b-8192 model)
- **Scraping**: Google Maps Places API
- **Email**: Gmail SMTP
- **Scheduling**: APScheduler

---

## Project Structure
```
AI_lead_generation_system/
├── backend/
│   ├── main.py
│   ├── requirements.txt
│   ├── .env
│   └── app/
│       ├── __init__.py
│       ├── routes/
│       │   ├── leads.py
│       │   ├── campaigns.py
│       │   └── settings.py
│       ├── services/
│       │   ├── maps_scraper.py
│       │   ├── email_finder.py
│       │   ├── groq_writer.py
│       │   └── email_sender.py
│       ├── models/
│       │   └── database.py
│       └── scheduler/
│           └── tasks.py
│
└── frontend/
    ├── package.json
    └── src/
        ├── App.jsx
        ├── index.css
        ├── pages/
        │   ├── Dashboard.jsx
        │   ├── Leads.jsx
        │   ├── Campaigns.jsx
        │   └── Settings.jsx
        ├── components/
        │   ├── Sidebar.jsx
        │   ├── LeadTable.jsx
        │   ├── MetricCard.jsx
        │   └── LogViewer.jsx
        └── services/
            └── api.js
```

---

## Environment Variables (.env)
```
# Google Maps
GOOGLE_MAPS_API_KEY=your_key_here

# Groq AI
GROQ_API_KEY=your_key_here

# Gmail SMTP
GMAIL_SENDER=yourcompany@gmail.com
GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx

# MySQL Database
DATABASE_URL=mysql+mysqlconnector://root:@localhost:3306/leadgen_db

# App
SECRET_KEY=your_random_secret_key
FRONTEND_URL=http://localhost:3000
```

---

## Step 1 — database.py
Build the MySQL database models using SQLAlchemy with these tables:

### leads table
- id (INT, primary key, auto increment)
- business_name (VARCHAR)
- phone (VARCHAR)
- address (VARCHAR)
- website (VARCHAR)
- email (VARCHAR, nullable)
- category (VARCHAR)
- rating (FLOAT)
- city (VARCHAR)
- keyword (VARCHAR)
- status (ENUM: new, contacted, replied, converted)
- created_at (DATETIME)
- updated_at (DATETIME)

### campaigns table
- id (INT, primary key)
- name (VARCHAR)
- keyword (VARCHAR)
- city (VARCHAR)
- status (ENUM: active, paused, completed)
- schedule_days (INT, default 4)
- total_leads (INT, default 0)
- emails_sent (INT, default 0)
- created_at (DATETIME)
- last_run (DATETIME, nullable)

### email_logs table
- id (INT, primary key)
- lead_id (INT, foreign key)
- campaign_id (INT, foreign key)
- subject (VARCHAR)
- body (TEXT)
- status (ENUM: sent, failed)
- sent_at (DATETIME)

### settings table
- id (INT, primary key)
- gmail_sender (VARCHAR)
- gmail_app_password (VARCHAR)
- groq_api_key (VARCHAR)
- maps_api_key (VARCHAR)
- schedule_days (INT)
- email_template (TEXT)
- company_name (VARCHAR)
- company_service (VARCHAR)

Use SQLAlchemy ORM. Auto create tables on startup. Connect using mysql-connector-python.

---

## Step 2 — maps_scraper.py
Build Google Maps scraper using the Places API:

### Function: search_places(keyword, city, api_key)
- Call Google Maps Places API Text Search
- URL: `https://maps.googleapis.com/maps/api/place/textsearch/json`
- Params: query = f"{keyword} in {city}"
- Handle pagination using next_page_token
- For each place get place_id then call Place Details API
- URL: `https://maps.googleapis.com/maps/api/place/details/json`
- Extract: name, phone, address, website, rating, types
- Return list of business dicts
- Handle errors gracefully
- Add 2 second delay between page requests

---

## Step 3 — email_finder.py
Build website email extractor:

### Function: find_email_from_website(website_url)
- Use httpx to fetch website HTML
- Use BeautifulSoup to parse
- Search for mailto: links
- Search for text patterns matching email regex
- Also check /contact and /about pages
- Return first valid email found or None
- Timeout after 10 seconds
- Handle all exceptions silently

---

## Step 4 — groq_writer.py
Build Groq AI email writer:

### Function: write_email(lead_data, company_service)
- Use Groq API with model: llama3-8b-8192
- Write a short professional cold email (max 150 words)
- Email should be personalized with:
  - Business name
  - Their category/industry
  - How our automation/AI/software services can help them
  - Clear call to action
- Return dict with subject and body
- Handle API errors

---

## Step 5 — email_sender.py
Build Gmail SMTP sender:

### Function: send_email(to_email, subject, body, sender, app_password)
- Use smtplib with Gmail SMTP
- Host: smtp.gmail.com port 587
- Use STARTTLS
- Send HTML formatted email
- Return True if sent, False if failed
- Log errors

---

## Step 6 — leads.py (API Routes)
Build FastAPI routes:

- GET /api/leads — get all leads with filters (status, city, keyword)
- GET /api/leads/{id} — get single lead
- POST /api/leads/scrape — trigger Google Maps scrape
- PUT /api/leads/{id} — update lead status
- DELETE /api/leads/{id} — delete lead
- POST /api/leads/{id}/send-email — send email to single lead
- GET /api/leads/export — export leads as CSV

---

## Step 7 — campaigns.py (API Routes)
Build FastAPI routes:

- GET /api/campaigns — get all campaigns
- POST /api/campaigns — create new campaign
- PUT /api/campaigns/{id} — update campaign
- DELETE /api/campaigns/{id} — delete campaign
- POST /api/campaigns/{id}/run — manually trigger campaign
- GET /api/campaigns/{id}/logs — get email logs for campaign

---

## Step 8 — settings.py (API Routes)
- GET /api/settings — get current settings
- PUT /api/settings — update settings
- POST /api/settings/test-email — send test email
- POST /api/settings/test-maps — test Google Maps API key
- POST /api/settings/test-groq — test Groq API key

---

## Step 9 — tasks.py (Scheduler)
Build APScheduler tasks:

### Function: run_campaign(campaign_id)
- Get campaign from database
- Scrape Google Maps with campaign keyword + city
- For each business:
  - Check if already in database (avoid duplicates)
  - Find email from website
  - Write personalized email with Groq
  - Send email via Gmail SMTP
  - Save lead to database
  - Log email in email_logs
- Update campaign last_run and counts

### Schedule:
- Run each active campaign based on its schedule_days setting
- Use APScheduler IntervalTrigger

---

## Step 10 — main.py (FastAPI Entry)
- Initialize FastAPI app
- Add CORS middleware (allow frontend URL)
- Include all routers
- Initialize database on startup
- Start APScheduler on startup
- Add /health endpoint

---

## Step 11 — React Frontend

### Design Guidelines
- Dark professional theme
- Colors: #0a0a0f background, #00d4ff accent, #7b2fff secondary
- Font: Space Mono for headers, DM Sans for body
- Sidebar navigation
- Smooth animations

### App.jsx
- React Router setup
- Routes for Dashboard, Leads, Campaigns, Settings
- Sidebar always visible

### Sidebar.jsx
- Company logo/name at top
- Navigation links with icons (lucide-react)
- Active state highlighting
- Bottom: system status indicator (API connected/disconnected)

### Dashboard.jsx
- Top metric cards: Total Leads, Emails Sent, Reply Rate, Active Campaigns
- Recent leads table (last 10)
- Recent email logs
- Quick scrape button (enter keyword + city → scrape now)

### Leads.jsx
- Full leads table with columns: Name, Phone, Email, Category, City, Status, Actions
- Filter by: status, city, keyword
- Search bar
- Status badge (new/contacted/replied/converted)
- Actions: Send Email, View Details, Delete
- Export CSV button
- Pagination

### Campaigns.jsx
- Campaign cards showing: name, keyword, city, status, leads count, emails sent, last run, next run
- Create new campaign modal
- Toggle active/paused
- Manual run button
- View logs button

### Settings.jsx
- Form for all API keys and SMTP config
- Test buttons for each API
- Email template editor
- Company info (name, service description)
- Schedule settings

### api.js
- Axios instance with base URL http://localhost:8000
- Functions for all API calls
- Error handling

---

## Important Rules for Agent

1. Write complete working code — no placeholders or TODOs
2. Handle all errors with try/except in backend
3. All API responses return JSON with consistent format:
```json
{
  "success": true,
  "data": {},
  "message": "string"
}
```
4. Use async/await in FastAPI where possible
5. Add console.log for debugging in React during development
6. All React components use Tailwind CSS for styling
7. No placeholder data — everything connects to real backend
8. CORS must be configured correctly so React can call FastAPI
9. Environment variables loaded from .env file
10. Database connection pooling for MySQL

---

## Build Order
1. database.py
2. maps_scraper.py
3. email_finder.py
4. groq_writer.py
5. email_sender.py
6. leads.py
7. campaigns.py
8. settings.py
9. tasks.py
10. main.py
11. api.js
12. App.jsx
13. Sidebar.jsx
14. Dashboard.jsx
15. Leads.jsx
16. Campaigns.jsx
17. Settings.jsx
