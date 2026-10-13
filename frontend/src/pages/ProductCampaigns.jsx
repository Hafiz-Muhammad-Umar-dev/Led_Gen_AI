import React, { useState, useEffect, useRef } from 'react';
import {
  Plus, Play, Pause, Eye, Loader2, X, Users, Mail, CheckCircle, Send, MapPin, Package, Paperclip,
} from 'lucide-react';
import {
  getProductCampaigns, createProductCampaign, updateProductCampaignStatus,
  getProductCampaignLogs, productCampaignRunStream, productCampaignAddLeadsStream,
} from '../services/productCampaignsApi';
import { getProducts } from '../services/productsApi';

const STATUS_COLORS = {
  active: 'text-green-400 border-green-500/30 bg-green-500/10',
  paused: 'text-yellow-400 border-yellow-500/30 bg-yellow-500/10',
  completed: 'text-muted border-border bg-white/5',
};

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-surface border border-border rounded-xl w-full max-w-md max-h-[90vh] shadow-2xl flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
          <h3 className="font-mono text-sm font-bold text-white">{title}</h3>
          <button onClick={onClose} className="text-muted hover:text-white transition-colors">
            <X size={18} />
          </button>
        </div>
        <div className="p-6 overflow-y-auto scrollbar-thin">{children}</div>
      </div>
    </div>
  );
}

function LogsModal({ campaign, onClose }) {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(null);
  const [filter, setFilter] = useState('all');

  useEffect(() => {
    getProductCampaignLogs(campaign.id)
      .then((res) => setLogs(res.data?.data || []))
      .catch(() => setLogs([]))
      .finally(() => setLoading(false));
  }, [campaign.id]);

  const filtered = logs.filter((l) => filter === 'all' || l.status === filter);

  return (
    <Modal title={`Logs — ${campaign.campaign_name}`} onClose={onClose}>
      <div className="flex items-center gap-2 mb-3">
        {['all', 'sent', 'failed'].map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`text-xs px-2.5 py-1 rounded-lg border capitalize transition-colors ${
              filter === f
                ? 'text-primary border-primary/30 bg-primary/10'
                : 'text-muted border-border hover:text-white'
            }`}
          >
            {f}
          </button>
        ))}
      </div>
      {loading ? (
        <div className="flex justify-center py-8">
          <Loader2 size={24} className="animate-spin text-primary" />
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-center text-muted py-8 text-sm">No logs found.</p>
      ) : (
        <div className="space-y-2 max-h-96 overflow-y-auto scrollbar-thin">
          {filtered.map((log) => {
            const isOpen = expanded === log.id;
            return (
              <div key={log.id} className="bg-bg border border-border rounded-lg overflow-hidden">
                <button
                  onClick={() => setExpanded(isOpen ? null : log.id)}
                  className="w-full text-left p-3 hover:bg-white/5 transition-colors"
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-xs text-white font-medium truncate">
                      {log.company_name || 'Unknown'}
                      {log.to_email && <span className="text-muted font-normal"> — {log.to_email}</span>}
                    </p>
                    <span className={`text-xs shrink-0 ${log.status === 'sent' ? 'text-green-400' : 'text-red-400'}`}>
                      {log.status === 'sent' ? '✅ sent' : `❌ ${log.status}`}
                    </span>
                  </div>
                  {log.subject && (
                    <p className="text-xs text-zinc-300 mt-1 truncate">Subject: {log.subject}</p>
                  )}
                  <p className="text-xs text-muted mt-1">
                    Sent: {log.sent_at ? new Date(log.sent_at).toLocaleString() : '—'}
                    <span className="text-zinc-600"> · {isOpen ? 'Click to collapse' : 'Click to expand'}</span>
                  </p>
                </button>
                {isOpen && (
                  <div className="border-t border-border px-3 py-2.5 bg-surface">
                    <p className="text-xs text-muted mb-1">Subject</p>
                    <p className="text-xs text-white mb-3">{log.subject || '—'}</p>
                    <p className="text-xs text-muted mb-1">Email body</p>
                    <pre className="text-xs text-zinc-300 whitespace-pre-wrap leading-5 font-sans">
                      {log.body || '—'}
                    </pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

const EMPTY_FORM = {
  campaign_name: '', product_name: '', pitch_angle: '', keyword: '', location: '', daily_limit: 20,
  attachment: null, product_id: '',
};

// Attachment constraints — must match the backend (product_campaigns route).
const ATTACHMENT_ACCEPT = '.pdf,.png,.jpg,.jpeg,.gif,.webp';
const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

export default function ProductCampaigns() {
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [products, setProducts] = useState([]);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const createFileRef = useRef(null);
  const [actionLoading, setActionLoading] = useState({});
  const [logsFor, setLogsFor] = useState(null);
  const [toast, setToast] = useState(null);

  // Per-campaign live run state: { [id]: { running, scraped, sent, failed, message } }
  const [runState, setRunState] = useState({});
  const runEsRef = useRef(null);

  // "Add Leads" panel + live state per campaign.
  const [addPanel, setAddPanel] = useState({});
  const [addState, setAddState] = useState({});
  const addEsRef = useRef(null);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const load = async () => {
    setLoading(true);
    try {
      const res = await getProductCampaigns();
      setCampaigns(res.data?.data || []);
    } catch (err) {
      console.error('Product campaigns load error:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    getProducts()
      .then((res) => setProducts(res.data?.data || []))
      .catch(() => setProducts([]));
    return () => {
      runEsRef.current?.close();
      addEsRef.current?.close();
    };
  }, []);

  const handleProductPick = (e) => {
    const id = e.target.value;
    if (!id) {
      setForm((p) => ({ ...p, product_id: '' }));
      return;
    }
    const product = products.find((prod) => String(prod.id) === id);
    if (!product) return;
    setForm((p) => ({
      ...p,
      product_id: product.id,
      product_name: product.name,
      pitch_angle: product.pitch_angle,
    }));
  };

  const closeCreate = () => {
    setShowCreate(false);
    setForm(EMPTY_FORM);
    if (createFileRef.current) createFileRef.current.value = '';
  };

  const handleAttachmentChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) {
      setForm((p) => ({ ...p, attachment: null }));
      return;
    }
    if (file.size > ATTACHMENT_MAX_BYTES) {
      showToast('Attachment too large (max 10 MB).', 'error');
      e.target.value = '';
      return;
    }
    setForm((p) => ({ ...p, attachment: file }));
  };

  const clearAttachment = () => {
    setForm((p) => ({ ...p, attachment: null }));
    if (createFileRef.current) createFileRef.current.value = '';
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    setCreating(true);
    try {
      await createProductCampaign(form);
      showToast('Campaign created.');
      closeCreate();
      load();
    } catch (err) {
      showToast(err.response?.data?.detail || 'Create failed.', 'error');
    } finally {
      setCreating(false);
    }
  };

  const handleToggleStatus = async (campaign) => {
    const newStatus = campaign.status === 'active' ? 'paused' : 'active';
    setActionLoading((p) => ({ ...p, [campaign.id]: 'toggle' }));
    try {
      await updateProductCampaignStatus(campaign.id, newStatus);
      setCampaigns((prev) => prev.map((c) => (c.id === campaign.id ? { ...c, status: newStatus } : c)));
    } catch {
      showToast('Failed to update status.', 'error');
    } finally {
      setActionLoading((p) => ({ ...p, [campaign.id]: null }));
    }
  };

  // Run = scrape AND send. Streams live progress via SSE.
  const handleRun = (id) => {
    if (runState[id]?.running) return;
    if (!window.confirm('Run this campaign — scrape leads and send emails now?')) return;
    runEsRef.current?.close();
    setRunState((p) => ({ ...p, [id]: { running: true, scraped: 0, sent: 0, failed: 0, message: 'Starting…' } }));

    const es = productCampaignRunStream(id);
    runEsRef.current = es;

    es.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }

      if (msg.type === 'start') {
        setRunState((p) => ({ ...p, [id]: { ...p[id], message: msg.message } }));
      } else if (msg.type === 'progress') {
        const suffix = msg.target ? ` (${msg.kept}/${msg.target})` : '';
        setRunState((p) => ({ ...p, [id]: { ...p[id], message: `${msg.message}${suffix}` } }));
      } else if (msg.type === 'lead') {
        setRunState((p) => ({
          ...p,
          [id]: { ...p[id], scraped: (p[id]?.scraped || 0) + 1, message: `Scraped ${msg.company}` },
        }));
      } else if (msg.type === 'skip') {
        setRunState((p) => ({ ...p, [id]: { ...p[id], message: `Skipped ${msg.company} (${msg.reason})` } }));
      } else if (msg.type === 'delay') {
        setRunState((p) => ({ ...p, [id]: { ...p[id], message: `⏳ Next in ${msg.seconds} seconds…` } }));
      } else if (msg.type === 'log') {
        setRunState((p) => ({
          ...p,
          [id]: {
            ...p[id],
            sent: msg.status === 'sent' ? (p[id]?.sent || 0) + 1 : (p[id]?.sent || 0),
            failed: msg.status === 'failed' ? (p[id]?.failed || 0) + 1 : (p[id]?.failed || 0),
            message: `${msg.status === 'sent' ? '✅' : '❌'} ${msg.company} — ${msg.status} (${msg.progress})`,
          },
        }));
      } else if (msg.type === 'done') {
        setRunState((p) => ({
          ...p,
          [id]: { running: false, scraped: msg.scraped, sent: msg.sent, failed: msg.failed, message: msg.message },
        }));
        es.close();
        runEsRef.current = null;
        showToast(msg.message);
        load();
      } else if (msg.type === 'error') {
        setRunState((p) => ({ ...p, [id]: { ...p[id], running: false, message: msg.message } }));
        showToast(msg.message, 'error');
        es.close();
        runEsRef.current = null;
      }
    };

    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) return;
      setRunState((p) => ({ ...p, [id]: { ...(p[id] || {}), running: false, message: 'Connection lost.' } }));
      es.close();
      runEsRef.current = null;
    };
  };

  const toggleAddPanel = (id) => {
    setAddPanel((p) => ({ ...p, [id]: { open: !p[id]?.open, count: p[id]?.count ?? 10 } }));
  };

  const handleAddLeads = (id) => {
    if (addState[id]?.running) return;
    const count = Math.max(1, parseInt(addPanel[id]?.count, 10) || 10);
    addEsRef.current?.close();
    setAddState((p) => ({ ...p, [id]: { running: true, scraped: 0, sent: 0, failed: 0, message: 'Starting…' } }));

    const es = productCampaignAddLeadsStream(id, count);
    addEsRef.current = es;

    es.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }

      if (msg.type === 'start') {
        setAddState((p) => ({ ...p, [id]: { ...p[id], message: msg.message } }));
      } else if (msg.type === 'progress') {
        const suffix = msg.target ? ` (${msg.kept}/${msg.target})` : '';
        setAddState((p) => ({ ...p, [id]: { ...p[id], message: `${msg.message}${suffix}` } }));
      } else if (msg.type === 'lead') {
        setAddState((p) => ({
          ...p,
          [id]: { ...p[id], scraped: (p[id]?.scraped || 0) + 1, message: `Found ${msg.company}` },
        }));
      } else if (msg.type === 'skip') {
        setAddState((p) => ({ ...p, [id]: { ...p[id], message: `Skipped ${msg.company} (${msg.reason})` } }));
      } else if (msg.type === 'delay') {
        setAddState((p) => ({ ...p, [id]: { ...p[id], message: `⏳ Next in ${msg.seconds} seconds…` } }));
      } else if (msg.type === 'log') {
        setAddState((p) => ({
          ...p,
          [id]: {
            ...p[id],
            sent: msg.status === 'sent' ? (p[id]?.sent || 0) + 1 : (p[id]?.sent || 0),
            failed: msg.status === 'failed' ? (p[id]?.failed || 0) + 1 : (p[id]?.failed || 0),
            message: `${msg.status === 'sent' ? '✅' : '❌'} ${msg.company} — ${msg.status} (${msg.progress})`,
          },
        }));
      } else if (msg.type === 'done') {
        setAddState((p) => ({
          ...p,
          [id]: { running: false, scraped: msg.scraped, sent: msg.sent, failed: msg.failed, message: msg.message },
        }));
        es.close();
        addEsRef.current = null;
        showToast(msg.message);
        load();
      } else if (msg.type === 'error') {
        setAddState((p) => ({ ...p, [id]: { ...p[id], running: false, message: msg.message } }));
        showToast(msg.message, 'error');
        es.close();
        addEsRef.current = null;
      }
    };

    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) return;
      setAddState((p) => ({ ...p, [id]: { ...(p[id] || {}), running: false, message: 'Connection lost.' } }));
      es.close();
      addEsRef.current = null;
    };
  };

  return (
    <div className="p-6 space-y-5">
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-lg border text-sm flex items-center gap-2 shadow-lg ${
          toast.type === 'error'
            ? 'bg-red-500/10 border-red-500/30 text-red-400'
            : 'bg-green-500/10 border-green-500/30 text-green-400'
        }`}>
          {toast.msg}
          <button onClick={() => setToast(null)}><X size={14} /></button>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-mono text-xl font-bold text-white">Product Campaigns</h2>
          <p className="text-sm text-muted mt-0.5">{campaigns.length} campaigns</p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-gradient-to-r from-primary to-secondary text-white text-sm font-semibold hover:opacity-90 transition-opacity"
        >
          <Plus size={16} /> New Campaign
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-20">
          <Loader2 size={28} className="animate-spin text-primary" />
        </div>
      ) : campaigns.length === 0 ? (
        <div className="text-center py-20">
          <p className="text-muted text-sm">No product campaigns yet.</p>
          <button
            onClick={() => setShowCreate(true)}
            className="mt-4 px-4 py-2 rounded-lg border border-primary/30 text-primary text-sm hover:bg-primary/10 transition-colors"
          >
            Create your first campaign
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {campaigns.map((c) => (
            <div key={c.id} className="bg-surface border border-border rounded-xl p-5 space-y-4 hover:border-primary/30 transition-colors">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="font-mono text-sm font-bold text-white truncate">{c.campaign_name}</h3>
                  <p className="text-xs text-muted mt-0.5 flex items-center gap-1 truncate">
                    <Package size={11} className="shrink-0" /> {c.product_name}
                  </p>
                  <p className="text-xs text-muted mt-0.5 flex items-center gap-1 truncate">
                    <MapPin size={11} className="shrink-0" /> {c.keyword} · {c.location}
                  </p>
                </div>
                {(runState[c.id]?.running || addState[c.id]?.running) ? (
                  <span className="shrink-0 text-xs px-2 py-0.5 rounded border capitalize flex items-center gap-1 text-primary border-primary/30 bg-primary/10 animate-pulse">
                    <Loader2 size={11} className="animate-spin" /> Running
                  </span>
                ) : (
                  <span className={`shrink-0 text-xs px-2 py-0.5 rounded border capitalize ${STATUS_COLORS[c.status] || ''}`}>
                    {c.status}
                  </span>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="bg-bg rounded-lg p-3">
                  <div className="flex items-center gap-1.5 text-muted mb-1">
                    <Users size={12} />
                    <span className="text-xs">Total Scraped</span>
                  </div>
                  <p className="text-xl font-mono font-bold text-white">{c.total_scraped ?? 0}</p>
                </div>
                <div className="bg-bg rounded-lg p-3">
                  <div className="flex items-center gap-1.5 text-muted mb-1">
                    <Mail size={12} />
                    <span className="text-xs">Total Sent</span>
                  </div>
                  <p className="text-xl font-mono font-bold text-white">{c.total_sent ?? 0}</p>
                </div>
              </div>

              <p className="text-xs text-muted line-clamp-2" title={c.pitch_angle}>{c.pitch_angle}</p>

              {c.attachment_filename && (
                <div className="flex items-center gap-2 text-xs text-primary">
                  <Paperclip size={11} className="shrink-0" />
                  <span className="truncate" title={c.attachment_filename}>{c.attachment_filename}</span>
                </div>
              )}

              {/* Live progress feedback */}
              {(runState[c.id] || addState[c.id]) && (
                <div className={`text-xs rounded-lg px-3 py-2 border ${
                  (runState[c.id]?.running || addState[c.id]?.running)
                    ? 'text-primary border-primary/20 bg-primary/5'
                    : 'text-muted border-border bg-bg'
                }`}>
                  {runState[c.id] && (
                    <div className="flex items-center gap-1.5">
                      {runState[c.id].running && <Loader2 size={11} className="animate-spin shrink-0" />}
                      <span className="font-medium">{runState[c.id].scraped || 0} scraped</span>
                      <span className="text-green-400">· {runState[c.id].sent || 0} sent</span>
                      {runState[c.id].failed ? <span className="text-red-400">· {runState[c.id].failed} failed</span> : null}
                    </div>
                  )}
                  {(runState[c.id]?.message || addState[c.id]?.message) && (
                    <p className="text-muted truncate mt-0.5">{runState[c.id]?.message || addState[c.id]?.message}</p>
                  )}
                </div>
              )}

              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={() => handleToggleStatus(c)}
                  disabled={actionLoading[c.id] === 'toggle'}
                  title={c.status === 'active' ? 'Pause' : 'Activate'}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg border border-border hover:border-primary/40 text-xs text-muted hover:text-white transition-all disabled:opacity-50"
                >
                  {actionLoading[c.id] === 'toggle' ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : c.status === 'active' ? (
                    <><Pause size={12} /> Pause</>
                  ) : (
                    <><CheckCircle size={12} /> Activate</>
                  )}
                </button>
                <button
                  onClick={() => handleRun(c.id)}
                  disabled={runState[c.id]?.running || addState[c.id]?.running}
                  title="Run — scrape and send"
                  className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg bg-primary/10 border border-primary/20 text-xs text-primary hover:bg-primary/20 transition-all disabled:opacity-50"
                >
                  {runState[c.id]?.running
                    ? <><Loader2 size={12} className="animate-spin" /> Running</>
                    : <><Play size={12} /> Run</>}
                </button>
                <button
                  onClick={() => setLogsFor(c)}
                  title="View logs"
                  className="p-2 rounded-lg border border-border hover:border-secondary/40 text-muted hover:text-secondary transition-all"
                >
                  <Eye size={14} />
                </button>
              </div>

              {/* Add Leads */}
              {!addPanel[c.id]?.open ? (
                <button
                  onClick={() => toggleAddPanel(c.id)}
                  disabled={addState[c.id]?.running}
                  className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg border border-dashed border-border hover:border-primary/40 text-xs text-muted hover:text-primary transition-all disabled:opacity-50"
                >
                  <Plus size={12} /> Add Leads
                </button>
              ) : (
                <div className="bg-bg border border-border rounded-lg p-3 space-y-2">
                  <label className="block text-xs text-muted">How many more leads?</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min="1"
                      max="100"
                      value={addPanel[c.id]?.count ?? 10}
                      onChange={(e) => setAddPanel((p) => ({ ...p, [c.id]: { ...p[c.id], open: true, count: e.target.value } }))}
                      disabled={addState[c.id]?.running}
                      className="w-16 bg-surface border border-border rounded-lg px-2 py-1.5 text-sm text-white text-center focus:outline-none focus:border-primary transition-colors disabled:opacity-50"
                    />
                    <button
                      onClick={() => handleAddLeads(c.id)}
                      disabled={addState[c.id]?.running}
                      className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-primary/10 border border-primary/30 text-xs text-primary hover:bg-primary/20 transition-all disabled:opacity-50"
                    >
                      {addState[c.id]?.running
                        ? <><Loader2 size={12} className="animate-spin" /> Working…</>
                        : <><Send size={12} /> Scrape &amp; Send</>}
                    </button>
                    <button
                      onClick={() => toggleAddPanel(c.id)}
                      disabled={addState[c.id]?.running}
                      title="Close"
                      className="p-1.5 rounded-lg border border-border text-muted hover:text-white transition-all disabled:opacity-50"
                    >
                      <X size={14} />
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Create Modal */}
      {showCreate && (
        <Modal title="New Product Campaign" onClose={closeCreate}>
          <form onSubmit={handleCreate} className="space-y-4">
            <div>
              <label className="block text-xs text-muted mb-1">Campaign Name</label>
              <input
                required
                type="text"
                placeholder="e.g. Pharma Temperature Control UK"
                value={form.campaign_name}
                onChange={(e) => setForm((p) => ({ ...p, campaign_name: e.target.value }))}
                className="w-full bg-bg border border-border rounded-lg px-3 py-2.5 text-sm text-white placeholder-muted focus:outline-none focus:border-primary transition-colors"
              />
            </div>
            {products.length > 0 && (
              <div>
                <label className="block text-xs text-muted mb-1">Use a saved product</label>
                <select
                  value={form.product_id}
                  onChange={handleProductPick}
                  className="w-full bg-bg border border-border rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-primary transition-colors"
                >
                  <option value="">— Custom (enter manually) —</option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
                <p className="text-xs text-muted/60 mt-1">
                  Prefills product name, pitch angle and doc below — still editable before you create the campaign.
                </p>
              </div>
            )}
            <div>
              <label className="block text-xs text-muted mb-1">Product Name</label>
              <input
                required
                type="text"
                placeholder="e.g. Temperature & Humidity Control System"
                value={form.product_name}
                onChange={(e) => setForm((p) => ({ ...p, product_name: e.target.value }))}
                className="w-full bg-bg border border-border rounded-lg px-3 py-2.5 text-sm text-white placeholder-muted focus:outline-none focus:border-primary transition-colors"
              />
            </div>
            <div>
              <label className="block text-xs text-muted mb-1">Pitch Angle</label>
              <textarea
                required
                rows={5}
                placeholder="Write exactly how you want to pitch this product. Include the main problem it solves, what makes it different, and the key benefit. AI will use this to write every email."
                value={form.pitch_angle}
                onChange={(e) => setForm((p) => ({ ...p, pitch_angle: e.target.value }))}
                className="w-full bg-bg border border-border rounded-lg px-3 py-2.5 text-sm text-white placeholder-muted focus:outline-none focus:border-primary transition-colors resize-y"
              />
            </div>
            <div>
              <label className="block text-xs text-muted mb-1">Search Keyword</label>
              <input
                required
                type="text"
                placeholder="e.g. pharmaceutical companies Birmingham"
                value={form.keyword}
                onChange={(e) => setForm((p) => ({ ...p, keyword: e.target.value }))}
                className="w-full bg-bg border border-border rounded-lg px-3 py-2.5 text-sm text-white placeholder-muted focus:outline-none focus:border-primary transition-colors"
              />
            </div>
            <div>
              <label className="block text-xs text-muted mb-1">Location</label>
              <input
                required
                type="text"
                placeholder="e.g. Birmingham UK"
                value={form.location}
                onChange={(e) => setForm((p) => ({ ...p, location: e.target.value }))}
                className="w-full bg-bg border border-border rounded-lg px-3 py-2.5 text-sm text-white placeholder-muted focus:outline-none focus:border-primary transition-colors"
              />
            </div>
            <div>
              <label className="block text-xs text-muted mb-1">Daily Limit</label>
              <input
                required
                type="number"
                min="1"
                max="200"
                value={form.daily_limit}
                onChange={(e) => setForm((p) => ({ ...p, daily_limit: parseInt(e.target.value, 10) || 20 }))}
                className="w-full bg-bg border border-border rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-primary transition-colors"
              />
            </div>
            <div>
              <label className="block text-xs text-muted mb-1">
                Attachment <span className="text-muted/60">(optional — PDF or image)</span>
              </label>
              <input
                ref={createFileRef}
                type="file"
                accept={ATTACHMENT_ACCEPT}
                onChange={handleAttachmentChange}
                className="hidden"
              />
              {form.attachment ? (
                <div className="flex items-center gap-2 bg-bg border border-border rounded-lg px-3 py-2.5">
                  <Paperclip size={14} className="text-primary shrink-0" />
                  <span className="text-sm text-white truncate flex-1">{form.attachment.name}</span>
                  <button
                    type="button"
                    onClick={clearAttachment}
                    title="Remove attachment"
                    className="text-muted hover:text-red-400 transition-colors shrink-0"
                  >
                    <X size={15} />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => createFileRef.current?.click()}
                  className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg border border-dashed border-border text-sm text-muted hover:text-primary hover:border-primary/40 transition-all"
                >
                  <Paperclip size={14} /> Attach a PDF or image
                </button>
              )}
              {(() => {
                const selectedProduct = form.product_id
                  ? products.find((p) => String(p.id) === String(form.product_id))
                  : null;
                if (selectedProduct?.attachment_filename && !form.attachment) {
                  return (
                    <p className="text-xs text-primary/80 mt-1">
                      Will use the saved attachment: {selectedProduct.attachment_filename} — attach a different file above to override.
                    </p>
                  );
                }
                return (
                  <p className="text-xs text-muted/60 mt-1">Sent with every email in this campaign. Max 10 MB.</p>
                );
              })()}
            </div>
            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={closeCreate}
                className="flex-1 py-2.5 rounded-lg border border-border text-sm text-muted hover:text-white hover:border-white/20 transition-all"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={creating}
                className="flex-1 py-2.5 rounded-lg bg-gradient-to-r from-primary to-secondary text-white text-sm font-semibold flex items-center justify-center gap-2 hover:opacity-90 transition-opacity disabled:opacity-60"
              >
                {creating ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
                Create Campaign
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Logs Modal */}
      {logsFor && <LogsModal campaign={logsFor} onClose={() => setLogsFor(null)} />}
    </div>
  );
}
