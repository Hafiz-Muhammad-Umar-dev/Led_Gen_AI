import React, { useState, useEffect, useRef } from 'react';
import {
  Plus, Play, Pause, Trash2, Eye, Loader2, X, Clock, Users, Mail,
  CheckCircle, Calendar, Upload, Square, FileSpreadsheet, CheckCircle2,
  AlertCircle, Send, Paperclip,
} from 'lucide-react';
import {
  getCampaigns, createCampaign, updateCampaign, deleteCampaign,
  campaignScrapeStream, campaignAddLeadsStream, getCampaignLogs,
  uploadSheetLeads, getSheetLeads, getSheetStatus, stopSheetCampaign, sheetCampaignStream,
} from '../services/api';

const STATUS_COLORS = {
  active: 'text-green-400 border-green-500/30 bg-green-500/10',
  paused: 'text-yellow-400 border-yellow-500/30 bg-yellow-500/10',
  completed: 'text-muted border-border bg-white/5',
};

function Modal({ title, onClose, children }) {
  return (
    
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-surface border border-border rounded-xl w-full max-w-md mx-4 shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h3 className="font-mono text-sm font-bold text-white">{title}</h3>
          <button onClick={onClose} className="text-muted hover:text-white transition-colors">
            <X size={18} />
          </button>
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
}

function LogsModal({ campaign, onClose }) {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(null);

  useEffect(() => {
    getCampaignLogs(campaign.id)
      .then((res) => setLogs(res.data?.data || []))
      .catch(() => setLogs([]))
      .finally(() => setLoading(false));
  }, [campaign.id]);

  return (
    <Modal title={`Logs — ${campaign.name}`} onClose={onClose}>
      {loading ? (
        <div className="flex justify-center py-8">
          <Loader2 size={24} className="animate-spin text-primary" />
        </div>
      ) : logs.length === 0 ? (
        <p className="text-center text-muted py-8 text-sm">No logs for this campaign.</p>
      ) : (
        <div className="space-y-2 max-h-96 overflow-y-auto scrollbar-thin">
          {logs.map((log) => {
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

const EMPTY_FORM = { name: '', keyword: '', city: '', schedule_days: 4, max_leads: 20, attachment: null };

// Attachment constraints — must match the backend (campaigns route).
const ATTACHMENT_ACCEPT = '.pdf,.png,.jpg,.jpeg,.gif,.webp';
const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

export default function Campaigns() {
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const createFileRef = useRef(null);
  const [actionLoading, setActionLoading] = useState({});
  const [logsFor, setLogsFor] = useState(null);
  const [toast, setToast] = useState(null);

  // Per-campaign live scrape state: { [id]: { running, added, skipped, message } }
  const [runState, setRunState] = useState({});
  const runEsRef = useRef(null);

  // "Add More Leads" panel + live state per campaign.
  const [addPanel, setAddPanel] = useState({});   // { [id]: { open, count } }
  const [addState, setAddState] = useState({});    // { [id]: { running, added, sent, total, message } }
  const addEsRef = useRef(null);

  // Sheet Campaign state
  const [sheetUploading, setSheetUploading] = useState(false);
  const [sheetStatus, setSheetStatus] = useState(null); // {total, pending, sent}
  const [sheetLeads, setSheetLeads] = useState([]);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [sheetRunning, setSheetRunning] = useState(false);
  const [sheetProgress, setSheetProgress] = useState({ current: 0, total: 0 });
  const [sheetLogs, setSheetLogs] = useState([]);
  const [sheetDone, setSheetDone] = useState(null);
  const sheetEsRef = useRef(null);
  const fileInputRef = useRef(null);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const load = async () => {
    setLoading(true);
    try {
      const res = await getCampaigns();
      setCampaigns(res.data?.data || []);
    } catch (err) {
      console.error('Campaigns load error:', err);
    } finally {
      setLoading(false);
    }
  };

  const loadSheetStatus = async () => {
    try {
      const res = await getSheetStatus();
      setSheetStatus(res.data?.data || null);
    } catch {
      // silently ignore
    }
  };

  const loadSheetLeads = async () => {
    try {
      const res = await getSheetLeads();
      const leads = res.data?.data || [];
      setSheetLeads(leads);
      setSelectedIds(new Set(leads.filter((l) => l.email_status === 'pending').map((l) => l.id)));
    } catch {
      // silently ignore
    }
  };

  useEffect(() => { load(); loadSheetStatus(); loadSheetLeads(); }, []);

  // Close any open scrape stream when leaving the page.
  useEffect(() => () => { runEsRef.current?.close(); addEsRef.current?.close(); }, []);

  const handleSheetUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setSheetUploading(true);
    try {
      const res = await uploadSheetLeads(file);
      const d = res.data?.data || {};
      showToast(`${d.imported} leads imported, ${d.skipped} skipped.`);
      await Promise.all([loadSheetStatus(), loadSheetLeads()]);
    } catch (err) {
      showToast(err.response?.data?.detail || 'Upload failed.', 'error');
    } finally {
      setSheetUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const toggleSelectAll = () => {
    const pendingIds = sheetLeads.filter((l) => l.email_status !== 'sent').map((l) => l.id);
    if (pendingIds.every((id) => selectedIds.has(id))) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(pendingIds));
    }
  };

  const toggleLead = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handleSheetStart = (ids = null) => {
    if (sheetRunning) return;
    setSheetRunning(true);
    setSheetLogs([]);
    setSheetDone(null);
    setSheetProgress({ current: 0, total: 0 });

    const es = sheetCampaignStream(ids);
    sheetEsRef.current = es;

    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'start') {
          setSheetProgress({ current: 0, total: msg.total });
        } else if (msg.type === 'progress') {
          setSheetProgress({ current: msg.current, total: msg.total });
        } else if (msg.type === 'log') {
          setSheetProgress({ current: msg.current, total: msg.total });
          setSheetLogs((prev) => [msg, ...prev]);
          setSheetLeads((prev) =>
            prev.map((l) => l.id === msg.lead_id ? { ...l, email_status: msg.status } : l)
          );
        } else if (msg.type === 'done' || msg.type === 'stopped') {
          setSheetDone(msg);
          setSheetRunning(false);
          es.close();
          loadSheetStatus();
          loadSheetLeads();
        } else if (msg.type === 'error') {
          showToast(msg.message, 'error');
          setSheetRunning(false);
          es.close();
        }
      } catch {
        // ignore parse errors
      }
    };

    es.onerror = () => {
      setSheetRunning(false);
      es.close();
    };
  };

  const handleSheetStop = async () => {
    sheetEsRef.current?.close();
    try { await stopSheetCampaign(); } catch { /* ignore */ }
    setSheetRunning(false);
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
      await createCampaign(form);
      showToast('Campaign created.');
      closeCreate();
      load();
    } catch (err) {
      showToast(err.response?.data?.detail || 'Create failed.', 'error');
    } finally {
      setCreating(false);
    }
  };

  const handleToggle = async (campaign) => {
    const newStatus = campaign.status === 'active' ? 'paused' : 'active';
    setActionLoading((p) => ({ ...p, [campaign.id]: 'toggle' }));
    try {
      await updateCampaign(campaign.id, { status: newStatus });
      setCampaigns((prev) =>
        prev.map((c) => c.id === campaign.id ? { ...c, status: newStatus } : c)
      );
    } catch {
      showToast('Failed to update status.', 'error');
    } finally {
      setActionLoading((p) => ({ ...p, [campaign.id]: null }));
    }
  };

  // Run = scrape AND send. Streams live (same Playwright scraper as the Leads
  // tab), then generates + sends an email to each new lead one by one.
  const handleRun = (id) => {
    if (runState[id]?.running) return;
    runEsRef.current?.close();
    setRunState((p) => ({ ...p, [id]: { running: true, added: 0, skipped: 0, sent: 0, message: 'Starting…' } }));

    const es = campaignScrapeStream(id);
    runEsRef.current = es;

    es.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }

      if (msg.type === 'start' || msg.type === 'progress') {
        setRunState((p) => ({ ...p, [id]: { ...p[id], message: msg.message } }));
      } else if (msg.type === 'lead') {
        setRunState((p) => ({
          ...p,
          [id]: { ...p[id], added: (p[id]?.added || 0) + 1, message: `Saved ${msg.business_name}` },
        }));
      } else if (msg.type === 'skip') {
        setRunState((p) => ({ ...p, [id]: { ...p[id], skipped: (p[id]?.skipped || 0) + 1 } }));
      } else if (msg.type === 'delay') {
        setRunState((p) => ({ ...p, [id]: { ...p[id], message: `Waiting ${msg.seconds}s before next email…` } }));
      } else if (msg.type === 'log') {
        setRunState((p) => ({
          ...p,
          [id]: {
            ...p[id],
            sent: msg.status === 'sent' ? (p[id]?.sent || 0) + 1 : (p[id]?.sent || 0),
            message: `${msg.status === 'sent' ? 'Sent' : 'Failed'}: ${msg.company}`,
          },
        }));
      } else if (msg.type === 'done') {
        setRunState((p) => ({
          ...p,
          [id]: { running: false, added: msg.added, skipped: msg.skipped, sent: msg.sent, message: msg.message },
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

  // "Add More Leads" — scrape fresh results then generate + send to NEW leads.
  const toggleAddPanel = (id) => {
    setAddPanel((p) => ({ ...p, [id]: { open: !p[id]?.open, count: p[id]?.count ?? 10 } }));
  };

  const handleAddLeads = (id) => {
    if (addState[id]?.running) return;
    const count = Math.max(1, parseInt(addPanel[id]?.count, 10) || 10);
    addEsRef.current?.close();
    setAddState((p) => ({ ...p, [id]: { running: true, added: 0, sent: 0, total: 0, message: 'Starting…' } }));

    const es = campaignAddLeadsStream(id, count);
    addEsRef.current = es;

    es.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }

      if (msg.type === 'start' || msg.type === 'progress') {
        setAddState((p) => ({ ...p, [id]: { ...p[id], message: msg.message } }));
      } else if (msg.type === 'lead') {
        setAddState((p) => ({ ...p, [id]: { ...p[id], added: (p[id]?.added || 0) + 1, message: `Found ${msg.business_name}` } }));
      } else if (msg.type === 'delay') {
        setAddState((p) => ({ ...p, [id]: { ...p[id], message: `Waiting ${msg.seconds}s before next email…` } }));
      } else if (msg.type === 'log') {
        setAddState((p) => ({
          ...p,
          [id]: {
            ...p[id],
            sent: msg.status === 'sent' ? (p[id]?.sent || 0) + 1 : (p[id]?.sent || 0),
            total: msg.total,
            message: `${msg.status === 'sent' ? 'Sent' : 'Failed'}: ${msg.company}`,
          },
        }));
      } else if (msg.type === 'done') {
        setAddState((p) => ({ ...p, [id]: { running: false, added: msg.added, sent: msg.sent, total: msg.added, message: msg.message } }));
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

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this campaign?')) return;
    setActionLoading((p) => ({ ...p, [id]: 'delete' }));
    try {
      await deleteCampaign(id);
      setCampaigns((prev) => prev.filter((c) => c.id !== id));
      showToast('Campaign deleted.');
    } catch {
      showToast('Delete failed.', 'error');
    } finally {
      setActionLoading((p) => ({ ...p, [id]: null }));
    }
  };

  return (
    <div className="p-6 space-y-5">
      {/* Toast */}
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
          <h2 className="font-mono text-xl font-bold text-white">Campaigns</h2>
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
          <p className="text-muted text-sm">No campaigns yet.</p>
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
                  <h3 className="font-mono text-sm font-bold text-white truncate">{c.name}</h3>
                  <p className="text-xs text-muted mt-0.5">{c.keyword} · {c.city}</p>
                </div>
                {runState[c.id]?.running ? (
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
                    <span className="text-xs">Total Leads</span>
                  </div>
                  <p className="text-xl font-mono font-bold text-white">{c.total_leads ?? 0}</p>
                </div>
                <div className="bg-bg rounded-lg p-3">
                  <div className="flex items-center gap-1.5 text-muted mb-1">
                    <Mail size={12} />
                    <span className="text-xs">Emails Sent</span>
                  </div>
                  <p className="text-xl font-mono font-bold text-white">{c.emails_sent ?? 0}</p>
                </div>
              </div>

              <div className="space-y-1.5 text-xs text-muted">
                <div className="flex items-center gap-2">
                  <Clock size={11} />
                  <span>Every {c.schedule_days} days</span>
                </div>
                <div className="flex items-center gap-2">
                  <Calendar size={11} />
                  <span>Last run: {c.last_run ? new Date(c.last_run).toLocaleDateString() : 'Never'}</span>
                </div>
                {c.attachment_filename && (
                  <div className="flex items-center gap-2 text-primary">
                    <Paperclip size={11} />
                    <span className="truncate" title={c.attachment_filename}>{c.attachment_filename}</span>
                  </div>
                )}
              </div>

              {/* Live scrape feedback */}
              {runState[c.id] && (
                <div className={`text-xs rounded-lg px-3 py-2 border ${
                  runState[c.id].running
                    ? 'text-primary border-primary/20 bg-primary/5'
                    : 'text-muted border-border bg-bg'
                }`}>
                  <div className="flex items-center gap-1.5">
                    {runState[c.id].running && <Loader2 size={11} className="animate-spin shrink-0" />}
                    <span className="font-medium">{runState[c.id].added || 0} scraped</span>
                    <span className="text-green-400">· {runState[c.id].sent || 0} sent</span>
                    {runState[c.id].skipped ? <span className="text-muted">· {runState[c.id].skipped} skipped</span> : null}
                  </div>
                  {runState[c.id].message && (
                    <p className="text-muted truncate mt-0.5">{runState[c.id].message}</p>
                  )}
                </div>
              )}

              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={() => handleToggle(c)}
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
                  disabled={runState[c.id]?.running}
                  title="Run now — scrape leads for this campaign"
                  className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg bg-primary/10 border border-primary/20 text-xs text-primary hover:bg-primary/20 transition-all disabled:opacity-50"
                >
                  {runState[c.id]?.running
                    ? <><Loader2 size={12} className="animate-spin" /> Running</>
                    : <><Play size={12} /> Run Now</>}
                </button>
                <button
                  onClick={() => setLogsFor(c)}
                  title="View logs"
                  className="p-2 rounded-lg border border-border hover:border-secondary/40 text-muted hover:text-secondary transition-all"
                >
                  <Eye size={14} />
                </button>
                <button
                  onClick={() => handleDelete(c.id)}
                  disabled={actionLoading[c.id] === 'delete'}
                  title="Delete"
                  className="p-2 rounded-lg border border-border hover:border-red-500/40 text-muted hover:text-red-400 transition-all disabled:opacity-50"
                >
                  {actionLoading[c.id] === 'delete'
                    ? <Loader2 size={14} className="animate-spin" />
                    : <Trash2 size={14} />}
                </button>
              </div>

              {/* Add More Leads */}
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
                  <label className="block text-xs text-muted">How many more leads to add?</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min="1"
                      max="50"
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
                  {addState[c.id] && (
                    <div className="text-xs text-muted">
                      <div className="flex items-center gap-1.5">
                        {addState[c.id].running && <Loader2 size={11} className="animate-spin shrink-0" />}
                        <span className="font-medium text-primary">{addState[c.id].added || 0} added</span>
                        <span>· {addState[c.id].sent || 0} sent</span>
                      </div>
                      {addState[c.id].message && <p className="truncate mt-0.5">{addState[c.id].message}</p>}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Sheet Campaign Section */}
      <div className="bg-surface border border-border rounded-xl p-6 space-y-5">

        {/* Header + upload row */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <FileSpreadsheet size={20} className="text-primary shrink-0" />
            <div className="min-w-0">
              <h3 className="font-mono text-base font-bold text-white">Sheet Campaign</h3>
              <p className="text-xs text-muted mt-0.5">Upload a CSV or Excel sheet and send personalised emails to each lead</p>
            </div>
          </div>
          <input ref={fileInputRef} type="file" accept=".csv,.xlsx" className="hidden" onChange={handleSheetUpload} />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={sheetUploading || sheetRunning}
            className="flex items-center gap-2 px-4 py-2 rounded-lg border border-border hover:border-primary/40 text-sm text-muted hover:text-white transition-all disabled:opacity-50 shrink-0"
          >
            {sheetUploading ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}
            Upload CSV / Excel
          </button>
        </div>

        {/* Stats row */}
        {sheetStatus && (
          <div className="flex items-center gap-4 text-xs text-muted">
            <span className="flex items-center gap-1"><Users size={12} /> {sheetStatus.total} total</span>
            <span className="flex items-center gap-1 text-yellow-400"><Clock size={12} /> {sheetStatus.pending} pending</span>
            <span className="flex items-center gap-1 text-green-400"><CheckCircle2 size={12} /> {sheetStatus.sent} sent</span>
          </div>
        )}

        {/* Leads table */}
        {sheetLeads.length > 0 && (
          <div className="space-y-2">
            {/* Table toolbar */}
            <div className="flex items-center gap-3">
              <button
                onClick={toggleSelectAll}
                disabled={sheetRunning}
                className="text-xs text-primary hover:text-primary/80 transition-colors disabled:opacity-40"
              >
                {sheetLeads.filter((l) => l.email_status !== 'sent').every((l) => selectedIds.has(l.id))
                  ? 'Deselect All'
                  : 'Select All'}
              </button>
              <span className="text-xs text-muted">
                {selectedIds.size} selected
              </span>
            </div>

            {/* Table */}
            <div className="rounded-lg border border-border overflow-hidden">
              <div className="max-h-72 overflow-y-auto scrollbar-thin">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-bg border-b border-border z-10">
                    <tr>
                      <th className="w-8 px-3 py-2.5 text-left"></th>
                      <th className="px-3 py-2.5 text-left text-muted font-medium">Company</th>
                      <th className="px-3 py-2.5 text-left text-muted font-medium">Email</th>
                      <th className="px-3 py-2.5 text-left text-muted font-medium hidden sm:table-cell">Type</th>
                      <th className="px-3 py-2.5 text-left text-muted font-medium hidden md:table-cell">Remarks</th>
                      <th className="px-3 py-2.5 text-left text-muted font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {sheetLeads.map((lead) => {
                      const isSent = lead.email_status === 'sent';
                      const checked = selectedIds.has(lead.id);
                      return (
                        <tr
                          key={lead.id}
                          onClick={() => !isSent && !sheetRunning && toggleLead(lead.id)}
                          className={`transition-colors ${!isSent && !sheetRunning ? 'cursor-pointer hover:bg-white/5' : 'opacity-60'} ${checked ? 'bg-primary/5' : ''}`}
                        >
                          <td className="px-3 py-2.5">
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={isSent || sheetRunning}
                              onChange={() => toggleLead(lead.id)}
                              onClick={(e) => e.stopPropagation()}
                              className="accent-primary cursor-pointer"
                            />
                          </td>
                          <td className="px-3 py-2.5 text-white font-medium max-w-[160px] truncate">{lead.business_name}</td>
                          <td className="px-3 py-2.5 text-muted max-w-[180px] truncate">{lead.email}</td>
                          <td className="px-3 py-2.5 text-muted max-w-[120px] truncate hidden sm:table-cell">{lead.category || '—'}</td>
                          <td className="px-3 py-2.5 text-muted max-w-[180px] truncate hidden md:table-cell">{lead.remarks || '—'}</td>
                          <td className="px-3 py-2.5">
                            {lead.email_status === 'sent' && (
                              <span className="px-1.5 py-0.5 rounded text-green-400 bg-green-500/10 border border-green-500/20">sent</span>
                            )}
                            {lead.email_status === 'failed' && (
                              <span className="px-1.5 py-0.5 rounded text-red-400 bg-red-500/10 border border-red-500/20">failed</span>
                            )}
                            {(!lead.email_status || lead.email_status === 'pending') && (
                              <span className="px-1.5 py-0.5 rounded text-yellow-400 bg-yellow-500/10 border border-yellow-500/20">pending</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Action buttons */}
            <div className="flex items-center justify-end gap-2 pt-1">
              {sheetRunning ? (
                <button
                  onClick={handleSheetStop}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-sm text-red-400 hover:bg-red-500/20 transition-all"
                >
                  <Square size={13} /> Stop
                </button>
              ) : (
                <>
                  <button
                    onClick={() => handleSheetStart(Array.from(selectedIds))}
                    disabled={selectedIds.size === 0}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg border border-primary/30 text-sm text-primary hover:bg-primary/10 transition-all disabled:opacity-40"
                  >
                    <Play size={13} /> Send to Selected ({selectedIds.size})
                  </button>
                  <button
                    onClick={() => handleSheetStart(null)}
                    disabled={!sheetStatus || sheetStatus.pending === 0}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg bg-gradient-to-r from-primary to-secondary text-white text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-40"
                  >
                    <Play size={13} /> Send to All
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {/* Progress bar */}
        {(sheetRunning || sheetDone) && sheetProgress.total > 0 && (
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs text-muted">
              <span>{sheetRunning ? `Sending… ${sheetProgress.current} / ${sheetProgress.total}` : `${sheetDone?.sent ?? sheetProgress.current} / ${sheetProgress.total} sent`}</span>
              <span>{Math.round((sheetProgress.current / sheetProgress.total) * 100)}%</span>
            </div>
            <div className="h-2 bg-bg rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-300 ${sheetDone?.type === 'stopped' ? 'bg-yellow-500' : 'bg-gradient-to-r from-primary to-secondary'}`}
                style={{ width: `${Math.round((sheetProgress.current / sheetProgress.total) * 100)}%` }}
              />
            </div>
            {sheetDone && <p className="text-xs text-muted">{sheetDone.message}</p>}
          </div>
        )}

        {/* Live log */}
        {sheetLogs.length > 0 && (
          <div className="space-y-1.5 max-h-60 overflow-y-auto scrollbar-thin">
            <p className="text-xs text-muted font-mono mb-1">Send log</p>
            {sheetLogs.map((log, idx) => (
              <div
                key={idx}
                className={`flex items-start gap-2 px-3 py-2 rounded-lg border text-xs ${
                  log.status === 'sent' ? 'bg-green-500/5 border-green-500/20' : 'bg-red-500/5 border-red-500/20'
                }`}
              >
                {log.status === 'sent'
                  ? <CheckCircle2 size={13} className="text-green-400 shrink-0 mt-0.5" />
                  : <AlertCircle size={13} className="text-red-400 shrink-0 mt-0.5" />}
                <div className="min-w-0 flex-1">
                  <p className={`font-medium truncate ${log.status === 'sent' ? 'text-green-300' : 'text-red-300'}`}>{log.company}</p>
                  <p className="text-muted truncate">{log.email}</p>
                  {log.subject && <p className="text-muted/70 truncate">{log.subject}</p>}
                </div>
                <span className={`shrink-0 font-mono ${log.status === 'sent' ? 'text-green-400' : 'text-red-400'}`}>
                  {log.current}/{log.total}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Create Modal */}
      {showCreate && (
        <Modal title="New Campaign" onClose={closeCreate}>
          <form onSubmit={handleCreate} className="space-y-4">
            <div>
              <label className="block text-xs text-muted mb-1">Campaign Name</label>
              <input
                required
                type="text"
                placeholder="e.g. London HVAC Outreach"
                value={form.name}
                onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                className="w-full bg-bg border border-border rounded-lg px-3 py-2.5 text-sm text-white placeholder-muted focus:outline-none focus:border-primary transition-colors"
              />
            </div>
            <div>
              <label className="block text-xs text-muted mb-1">Keyword</label>
              <input
                required
                type="text"
                placeholder="e.g. HVAC contractor"
                value={form.keyword}
                onChange={(e) => setForm((p) => ({ ...p, keyword: e.target.value }))}
                className="w-full bg-bg border border-border rounded-lg px-3 py-2.5 text-sm text-white placeholder-muted focus:outline-none focus:border-primary transition-colors"
              />
            </div>
            <div>
              <label className="block text-xs text-muted mb-1">City</label>
              <input
                required
                type="text"
                placeholder="e.g. London"
                value={form.city}
                onChange={(e) => setForm((p) => ({ ...p, city: e.target.value }))}
                className="w-full bg-bg border border-border rounded-lg px-3 py-2.5 text-sm text-white placeholder-muted focus:outline-none focus:border-primary transition-colors"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-muted mb-1">Schedule (days)</label>
                <input
                  required
                  type="number"
                  min="1"
                  max="30"
                  value={form.schedule_days}
                  onChange={(e) => setForm((p) => ({ ...p, schedule_days: parseInt(e.target.value) || 4 }))}
                  className="w-full bg-bg border border-border rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-primary transition-colors"
                />
              </div>
              <div>
                <label className="block text-xs text-muted mb-1">Max leads</label>
                <input
                  required
                  type="number"
                  min="1"
                  max="100"
                  value={form.max_leads}
                  onChange={(e) => setForm((p) => ({ ...p, max_leads: parseInt(e.target.value) || 20 }))}
                  className="w-full bg-bg border border-border rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-primary transition-colors"
                />
              </div>
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
              <p className="text-xs text-muted/60 mt-1">Sent with every email in this campaign. Max 10 MB.</p>
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
                Create
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
