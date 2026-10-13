import axios from 'axios';

// In production the frontend is served from FastAPI itself (same origin),
// so relative URLs work. In dev, the frontend (port 3000) and backend
// (port 8000) are separate servers, so we point at the backend using
// whatever host the page was loaded from — this makes it work both from
// localhost and from another device hitting the machine's network IP.

const API_BASE =
  process.env.REACT_APP_API_URL ||
  (process.env.NODE_ENV === 'development'
    ? `${window.location.protocol}//${window.location.hostname}:8000`
    : '');

const api = axios.create({
  baseURL: API_BASE,
  headers: { 'Content-Type': 'application/json' },
  timeout: 30000,
});

// Attach JWT token to every request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('leadgen_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    console.error('[API Error]', err.response?.data || err.message);
    return Promise.reject(err);
  }
);

// --- Leads ---
export const getLeads = (params = {}) => api.get('/api/leads', { params });
export const createLead = (data) => api.post('/api/leads', data);
export const getLead = (id) => api.get(`/api/leads/${id}`);
export const scrapeLeads = (data) => api.post('/api/leads/scrape', data);
export const updateLead = (id, data) => api.put(`/api/leads/${id}`, data);
export const deleteLead = (id) => api.delete(`/api/leads/${id}`);
export const sendEmailToLead = (id) => api.post(`/api/leads/${id}/send-email`);
export const exportLeads = () => api.get('/api/leads/export', { responseType: 'blob' });
export const generateEmails = (lead_ids) => api.post('/api/leads/generate-emails', { lead_ids });
export const sendEmailsBulk = (lead_ids) => api.post('/api/leads/send-emails', { lead_ids });
export const getEmailStatus = () => api.get('/api/leads/email-status');
export const getDashboardStats = () => api.get('/api/leads/stats');
const SSE_BASE = API_BASE;

// EventSource can't set an Authorization header, so the JWT rides along as
// a query param — the backend's get_current_user dependency falls back to it.
const tokenParam = () => `token=${encodeURIComponent(localStorage.getItem('leadgen_token') || '')}`;

export const scrapeLeadsStream = (keyword, city) =>
  new EventSource(
    `${SSE_BASE}/api/leads/scrape/stream?keyword=${encodeURIComponent(keyword)}&city=${encodeURIComponent(city)}&${tokenParam()}`
  );

export const scrapePlaywrightStream = (query, maxResults = 20) =>
  new EventSource(
    `${SSE_BASE}/api/leads/scrape-playwright/stream?query=${encodeURIComponent(query)}&max_results=${maxResults}&${tokenParam()}`
  );

export const startSendingStream = (lead_ids) => {
  const token = localStorage.getItem('leadgen_token');
  const base = API_BASE;
  const controller = new AbortController();
  const promise = fetch(`${base}/api/leads/start-sending`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ lead_ids }),
    signal: controller.signal,
  });
  return { promise, controller };
};

// --- Campaigns ---
export const getCampaigns = () => api.get('/api/campaigns');
export const createCampaign = (data) => {
  // Sent as multipart so an optional PDF/image attachment can ride along.
  const form = new FormData();
  form.append('name', data.name);
  form.append('keyword', data.keyword);
  form.append('city', data.city);
  form.append('schedule_days', data.schedule_days);
  form.append('max_leads', data.max_leads);
  if (data.attachment) form.append('attachment', data.attachment);
  // Do NOT set Content-Type manually — Axios adds the multipart boundary.
  return api.post('/api/campaigns', form, {
    headers: { 'Content-Type': undefined },
    timeout: 60000,
  });
};
export const updateCampaign = (id, data) => api.put(`/api/campaigns/${id}`, data);
export const deleteCampaign = (id) => api.delete(`/api/campaigns/${id}`);
export const runCampaign = (id) => api.post(`/api/campaigns/${id}/run`);
export const campaignScrapeStream = (id) =>
  new EventSource(`${SSE_BASE}/api/campaigns/${id}/scrape/stream?${tokenParam()}`);
export const campaignAddLeadsStream = (id, count) =>
  new EventSource(`${SSE_BASE}/api/campaigns/${id}/add-leads/stream?count=${count}&${tokenParam()}`);
export const getCampaignLogs = (id) => api.get(`/api/campaigns/${id}/logs`);

// --- Settings ---
export const getSettings = () => api.get('/api/settings');
export const updateSettings = (data) => api.put('/api/settings', data);
export const testEmail = () => api.post('/api/settings/test-email', {});
export const testMaps = () => api.post('/api/settings/test-maps');
export const testGroq = () => api.post('/api/settings/test-groq');

// --- WhatsApp ---
export const getWhatsappStatus = () => api.get('/api/whatsapp/status');
export const connectWhatsapp = () => api.post('/api/whatsapp/connect');
export const logoutWhatsapp = () => api.post('/api/whatsapp/logout');
export const getWhatsappLeads = (params = {}) => api.get('/api/whatsapp/leads', { params });

// SSE-over-POST (EventSource can't send the Authorization header or a body),
// consumed via fetch + ReadableStream — same pattern as startSendingStream.
export const checkWhatsappNumbersStream = () => {
  const token = localStorage.getItem('leadgen_token');
  const controller = new AbortController();
  const promise = fetch(`${API_BASE}/api/whatsapp/check-numbers`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: controller.signal,
  });
  return { promise, controller };
};

export const generateWhatsappMessagesStream = (targets = []) => {
  const token = localStorage.getItem('leadgen_token');
  const controller = new AbortController();
  const promise = fetch(`${API_BASE}/api/whatsapp/generate-messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ targets }),
    signal: controller.signal,
  });
  return { promise, controller };
};

export const sendWhatsappMessagesStream = (targets) => {
  const token = localStorage.getItem('leadgen_token');
  const controller = new AbortController();
  const promise = fetch(`${API_BASE}/api/whatsapp/send-messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ targets }),
    signal: controller.signal,
  });
  return { promise, controller };
};

// --- Uploads ---
export const importLeads = (file) => {
  const form = new FormData();
  form.append('file', file);
  // Do NOT set Content-Type manually — Axios must auto-set it with the multipart boundary
  return api.post('/api/uploads/import', form, {
    headers: { 'Content-Type': undefined },
    timeout: 60000,
  });
};
export const listUploadedLeads = () => api.get('/api/uploads/list');
export const generateUploadEmails = (lead_ids) => api.post('/api/uploads/generate-emails', { lead_ids }, { timeout: 120000 });
export const sendUploadEmails = (lead_ids, overrides = {}) =>
  api.post('/api/uploads/send-emails', { lead_ids, overrides }, { timeout: 120000 });
export const deleteUploadBatch = (batch) =>
  api.delete(`/api/uploads/batch/${encodeURIComponent(batch)}`);

// --- Email Enrichment ---
// SSE-over-POST (multipart body + streamed response) — EventSource can't POST
// a file, so this is consumed via fetch + ReadableStream, same as the WhatsApp
// streams above.
export const enrichSheetStream = (file) => {
  const token = localStorage.getItem('leadgen_token');
  const form = new FormData();
  form.append('file', file);
  const controller = new AbortController();
  const promise = fetch(`${API_BASE}/api/enrichment/enrich`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
    signal: controller.signal,
  });
  return { promise, controller };
};

// --- Sheet Campaign ---
export const uploadSheetLeads = (file) => {
  const form = new FormData();
  form.append('file', file);
  return api.post('/api/leads/upload-sheet', form, {
    headers: { 'Content-Type': undefined },
    timeout: 60000,
  });
};
export const getSheetLeadCount = () => api.get('/api/leads/sheet-count');
export const getSheetLeads = () => api.get('/api/leads', { params: { source: 'sheet', page_size: 200 } });
export const getSheetStatus = () => api.get('/api/campaigns/sheet/status');
export const stopSheetCampaign = () => api.post('/api/campaigns/sheet/stop');
export const sheetCampaignStream = (ids = null) => {
  const base = `${SSE_BASE}/api/campaigns/sheet/stream`;
  if (ids && ids.length > 0) {
    const qs = ids.map((id) => `ids=${id}`).join('&');
    return new EventSource(`${base}?${qs}&${tokenParam()}`);
  }
  return new EventSource(`${base}?${tokenParam()}`);
};

// --- Auth ---
export const loginUser = (data) => api.post('/api/auth/login', data);
export const registerUser = (data) => api.post('/api/auth/register', data);

// --- Health ---
export const checkHealth = () => api.get('/health');

export default api;
