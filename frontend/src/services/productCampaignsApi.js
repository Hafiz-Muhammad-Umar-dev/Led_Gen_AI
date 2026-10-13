import api from './api';

// Kept in a separate file (rather than editing api.js) so the existing
// Campaigns/Leads/Settings API surface stays untouched.
// Reuses api.js's already-correct base URL resolution (empty REACT_APP_API_URL
// in dev falls back to the current host on port 8000) instead of recomputing
// it here with `??`, which doesn't treat an empty string as unset.
const SSE_BASE = api.defaults.baseURL;

export const getProductCampaigns = () => api.get('/api/product-campaigns/list');

export const createProductCampaign = (data) => {
  // Sent as multipart so an optional PDF/image attachment can ride along.
  const form = new FormData();
  form.append('campaign_name', data.campaign_name);
  form.append('product_name', data.product_name);
  form.append('pitch_angle', data.pitch_angle);
  form.append('keyword', data.keyword);
  form.append('location', data.location);
  form.append('daily_limit', data.daily_limit);
  if (data.attachment) form.append('attachment', data.attachment);
  if (data.product_id) form.append('product_id', data.product_id);
  // Do NOT set Content-Type manually — Axios adds the multipart boundary.
  return api.post('/api/product-campaigns/create', form, {
    headers: { 'Content-Type': undefined },
    timeout: 60000,
  });
};

export const updateProductCampaignStatus = (id, status) =>
  api.put(`/api/product-campaigns/${id}/status`, { status });

export const getProductCampaignLogs = (id) => api.get(`/api/product-campaigns/${id}/logs`);

// EventSource can't set an Authorization header, so the JWT rides along as
// a query param — the backend's get_current_user dependency falls back to it.
const _tokenParam = () => `token=${encodeURIComponent(localStorage.getItem('leadgen_token') || '')}`;

export const productCampaignRunStream = (id) =>
  new EventSource(`${SSE_BASE}/api/product-campaigns/${id}/run/stream?${_tokenParam()}`);

export const productCampaignAddLeadsStream = (id, count) =>
  new EventSource(`${SSE_BASE}/api/product-campaigns/${id}/add-leads/stream?count=${count}&${_tokenParam()}`);
