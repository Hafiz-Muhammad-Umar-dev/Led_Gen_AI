import api from './api';

// Ready-made "Products" library — reusable name + pitch angle + doc that
// Product Campaigns can be created from. Mirrors productCampaignsApi.js's
// multipart conventions.

export const getProducts = () => api.get('/api/products/list');

const _toFormData = (data) => {
  const form = new FormData();
  form.append('name', data.name);
  form.append('pitch_angle', data.pitch_angle);
  if (data.attachment) form.append('attachment', data.attachment);
  return form;
};

export const createProduct = (data) =>
  api.post('/api/products/create', _toFormData(data), {
    headers: { 'Content-Type': undefined },
    timeout: 60000,
  });

export const updateProduct = (id, data) =>
  api.put(`/api/products/${id}`, _toFormData(data), {
    headers: { 'Content-Type': undefined },
    timeout: 60000,
  });

export const deleteProduct = (id) => api.delete(`/api/products/${id}`);
