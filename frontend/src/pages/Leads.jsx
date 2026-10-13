import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Search, Download, Mail, Trash2, ChevronLeft, ChevronRight,
  Loader2, X, Globe, Square, Sparkles, Send, Play, Plus,
} from 'lucide-react';
import {
  getLeads, updateLead, deleteLead, sendEmailToLead, exportLeads,
  scrapePlaywrightStream, generateEmails, sendEmailsBulk, getEmailStatus,
  startSendingStream, createLead, getCampaigns,
} from '../services/api';

const EMPTY_LEAD_FORM = {
  business_name: '', email: '', phone: '', website: '',
  category: '', city: '', address: '', keyword: '',
};

const STATUS_COLORS = {
  new: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  contacted: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
  replied: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  converted: 'bg-green-500/10 text-green-400 border-green-500/20',
};

const EMAIL_STATUS_COLORS = {
  pending: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
  sent: 'bg-green-500/10 text-green-400 border-green-500/20',
  failed: 'bg-red-500/10 text-red-400 border-red-500/20',
};

const PAGE_SIZE = 20;

export default function Leads() {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({ status: '', city: '', keyword: '', campaign_id: '' });
  const [campaigns, setCampaigns] = useState([]);
  const [page, setPage] = useState(1);
  const [actionLoading, setActionLoading] = useState({});
  const [toast, setToast] = useState(null);

  // Scrape state
  const [scrapeQuery, setScrapeQuery] = useState('');
  const [scrapeMax, setScrapeMax] = useState(20);
  const [scraping, setScraping] = useState(false);
  const [scrapeLog, setScrapeLog] = useState([]);
  const esRef = useRef(null);
  const logRef = useRef(null);

  // Email batch state
  const [activeTab, setActiveTab] = useState('leads');
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [generatedPreviews, setGeneratedPreviews] = useState([]);
  const [generating, setGenerating] = useState(false);
  const [sending, setSending] = useState(false);
  const [emailStatusData, setEmailStatusData] = useState([]);
  const [emailStatusFilter, setEmailStatusFilter] = useState('all');
  const [loadingStatus, setLoadingStatus] = useState(false);

  // Add Lead modal state
  const [showAddLead, setShowAddLead] = useState(false);
  const [addLeadForm, setAddLeadForm] = useState(EMPTY_LEAD_FORM);
  const [addLeadSaving, setAddLeadSaving] = useState(false);

  // Start Sending state
  const [startSendingActive, setStartSendingActive] = useState(false);
  const [sendingItems, setSendingItems] = useState([]);
  const [sendingStats, setSendingStats] = useState({ current: 0, total: 0 });
  const [sendingDone, setSendingDone] = useState(null);
  const [nextDelaySecs, setNextDelaySecs] = useState(null);
  const sseAbortRef = useRef(null);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (filters.status) params.status = filters.status;
      if (filters.city) params.city = filters.city;
      if (filters.keyword) params.keyword = filters.keyword;
      if (filters.campaign_id) params.campaign_id = filters.campaign_id;
      const res = await getLeads(params);
      setLeads(res.data?.data || []);
      setPage(1);
    } catch (err) {
      console.error('Leads load error:', err);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    getCampaigns()
      .then((res) => setCampaigns(res.data?.data || []))
      .catch(() => setCampaigns([]));
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [scrapeLog]);

  useEffect(() => {
    return () => { if (esRef.current) esRef.current.close(); };
  }, []);

  useEffect(() => {
    if (activeTab === 'status') loadEmailStatusData();
  }, [activeTab]);

  useEffect(() => {
    if (!startSendingActive) return;
    const handler = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [startSendingActive]);

  useEffect(() => {
    if (nextDelaySecs === null || nextDelaySecs <= 0) return;
    const t = setTimeout(() => setNextDelaySecs((s) => (s > 1 ? s - 1 : null)), 1000);
    return () => clearTimeout(t);
  }, [nextDelaySecs]);

  const filtered = leads.filter((l) =>
    !search ||
    l.business_name?.toLowerCase().includes(search.toLowerCase()) ||
    l.email?.toLowerCase().includes(search.toLowerCase()) ||
    l.city?.toLowerCase().includes(search.toLowerCase())
  );

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paginated = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const allPageSelected = paginated.length > 0 && paginated.every((l) => selectedIds.has(l.id));

  // ---- Scrape handlers ----

  const handleScrape = () => {
    if (!scrapeQuery.trim() || scraping) return;
    setScraping(true);
    setScrapeLog([]);

    const es = scrapePlaywrightStream(scrapeQuery.trim(), scrapeMax);
    esRef.current = es;

    es.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.type === 'lead') {
        setLeads((prev) => [
          {
            id: data.id,
            business_name: data.business_name,
            phone: data.phone,
            email: data.email,
            website: data.website,
            category: data.category,
            city: data.city,
            rating: data.rating,
            address: data.address,
            keyword: data.keyword,
            status: data.status,
            maps_url: data.maps_url,
            email_status: 'pending',
            email_subject: null,
            email_body: null,
          },
          ...prev,
        ]);
        setScrapeLog((p) => [...p, { type: 'success', text: `Saved: ${data.business_name}` }]);
      } else if (data.type === 'skip') {
        setScrapeLog((p) => [...p, { type: 'skip', text: `Skip: ${data.business_name}` }]);
      } else if (data.type === 'progress' || data.type === 'start') {
        setScrapeLog((p) => [...p, { type: 'info', text: data.message }]);
      } else if (data.type === 'done') {
        setScrapeLog((p) => [...p, { type: 'done', text: data.message }]);
        setScraping(false);
        es.close();
        esRef.current = null;
      } else if (data.type === 'error') {
        setScrapeLog((p) => [...p, { type: 'error', text: data.message }]);
        setScraping(false);
        es.close();
        esRef.current = null;
      }
    };

    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) return;
      setScrapeLog((p) => [...p, { type: 'error', text: 'Connection lost.' }]);
      setScraping(false);
      es.close();
      esRef.current = null;
    };
  };

  const handleStopScrape = () => {
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
    setScraping(false);
    setScrapeLog((p) => [...p, { type: 'info', text: 'Scraping stopped by user.' }]);
  };

  // ---- Email batch handlers ----

  const handleSelectLead = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleSelectAll = (checked) => {
    setSelectedIds(checked ? new Set(paginated.map((l) => l.id)) : new Set());
  };

  const handleGenerateEmails = async () => {
    if (selectedIds.size === 0 || generating) return;
    setGenerating(true);
    setGeneratedPreviews([]);
    try {
      const res = await generateEmails(Array.from(selectedIds));
      const previews = [];
      res.data.data.forEach((item) => {
        if (!item.error) {
          previews.push({
            lead_id: item.lead_id,
            business_name: item.business_name,
            subject: item.subject,
            body: item.body,
          });
          setLeads((prev) =>
            prev.map((l) =>
              l.id === item.lead_id ? { ...l, email_subject: item.subject } : l
            )
          );
        }
      });
      setGeneratedPreviews(previews);
      showToast(`Generated emails for ${previews.length} lead${previews.length !== 1 ? 's' : ''}.`);
    } catch (err) {
      showToast(err.response?.data?.detail || 'Email generation failed.', 'error');
    } finally {
      setGenerating(false);
    }
  };

  const handleSendEmails = async () => {
    if (selectedIds.size === 0 || sending) return;
    setSending(true);
    try {
      const res = await sendEmailsBulk(Array.from(selectedIds));
      const { sent, failed } = res.data.data;
      sent.forEach((item) => {
        setLeads((prev) =>
          prev.map((l) => l.id === item.lead_id ? { ...l, email_status: 'sent' } : l)
        );
      });
      failed.forEach((item) => {
        setLeads((prev) =>
          prev.map((l) => l.id === item.lead_id ? { ...l, email_status: 'failed' } : l)
        );
      });
      if (failed.length === 0) {
        showToast(`${sent.length} email${sent.length !== 1 ? 's' : ''} sent successfully.`);
      } else {
        showToast(
          `${sent.length} sent, ${failed.length} failed.`,
          sent.length > 0 ? 'success' : 'error'
        );
      }
      setSelectedIds(new Set());
      setGeneratedPreviews([]);
    } catch (err) {
      showToast(err.response?.data?.detail || 'Send failed.', 'error');
    } finally {
      setSending(false);
    }
  };

  const handleStartSending = async () => {
    if (selectedIds.size === 0 || startSendingActive) return;
    const count = selectedIds.size;
    if (!window.confirm(
      `Send emails to ${count} lead${count !== 1 ? 's' : ''} one by one?\n\nAI will generate a personalised email for each lead and send it immediately. This cannot be stopped once started.`
    )) return;

    setStartSendingActive(true);
    setSendingItems([]);
    setSendingStats({ current: 0, total: count });
    setSendingDone(null);
    setNextDelaySecs(null);

    const { promise, controller } = startSendingStream(Array.from(selectedIds));
    sseAbortRef.current = controller;

    try {
      const response = await promise;
      if (!response.ok) {
        const err = await response.json().catch(() => ({ detail: 'Request failed' }));
        throw new Error(err.detail || 'Request failed');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buf += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = buf.indexOf('\n\n')) !== -1) {
          const part = buf.slice(0, boundary);
          buf = buf.slice(boundary + 2);
          if (!part.startsWith('data: ')) continue;
          let data;
          try { data = JSON.parse(part.slice(6)); } catch { continue; }

          if (data.type === 'progress') {
            const current = parseInt((data.progress ?? '0').split('/')[0], 10);
            setSendingStats((prev) => ({ ...prev, current }));
            setSendingItems((prev) => [...prev, data]);
            setNextDelaySecs(null);
            if (data.status === 'sent' || data.status === 'failed') {
              setLeads((prev) =>
                prev.map((l) => l.id === data.lead_id ? { ...l, email_status: data.status } : l)
              );
            }
          } else if (data.type === 'delay') {
            setNextDelaySecs(data.seconds);
          } else if (data.type === 'complete') {
            setSendingDone({ sent: data.sent, failed: data.failed });
            setStartSendingActive(false);
            setNextDelaySecs(null);
            setSelectedIds(new Set());
          } else if (data.type === 'error') {
            setSendingItems((prev) => [
              ...prev,
              { status: 'error', reason: data.message, company: 'System', lead_id: null, subject: '' },
            ]);
            setStartSendingActive(false);
            setNextDelaySecs(null);
          }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        setSendingItems((prev) => [
          ...prev,
          { status: 'error', reason: err.message || 'Connection error', company: 'System', lead_id: null, subject: '' },
        ]);
      }
      setStartSendingActive(false);
      setNextDelaySecs(null);
    }
  };

  const loadEmailStatusData = async () => {
    setLoadingStatus(true);
    try {
      const res = await getEmailStatus();
      setEmailStatusData(res.data.data || []);
    } catch (err) {
      console.error('Email status load error:', err);
    } finally {
      setLoadingStatus(false);
    }
  };

  // ---- Add Lead handler ----

  const handleAddLead = async (e) => {
    e.preventDefault();
    setAddLeadSaving(true);
    try {
      const res = await createLead(addLeadForm);
      const newLead = res.data?.data;
      if (newLead) setLeads((prev) => [newLead, ...prev]);
      showToast('Lead added successfully.');
      setShowAddLead(false);
      setAddLeadForm(EMPTY_LEAD_FORM);
    } catch (err) {
      showToast(err.response?.data?.detail || 'Failed to add lead.', 'error');
    } finally {
      setAddLeadSaving(false);
    }
  };

  // ---- Lead action handlers ----

  const handleSendEmail = async (id) => {
    setActionLoading((p) => ({ ...p, [id]: 'email' }));
    try {
      await sendEmailToLead(id);
      showToast('Email sent successfully.');
      load();
    } catch (err) {
      showToast(err.response?.data?.detail || 'Failed to send email.', 'error');
    } finally {
      setActionLoading((p) => ({ ...p, [id]: null }));
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this lead?')) return;
    setActionLoading((p) => ({ ...p, [id]: 'delete' }));
    try {
      await deleteLead(id);
      showToast('Lead deleted.');
      setLeads((prev) => prev.filter((l) => l.id !== id));
      setSelectedIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
    } catch (err) {
      showToast(err.response?.data?.detail || 'Delete failed.', 'error');
    } finally {
      setActionLoading((p) => ({ ...p, [id]: null }));
    }
  };

  const handleStatusChange = async (id, status) => {
    try {
      await updateLead(id, { status });
      setLeads((prev) => prev.map((l) => l.id === id ? { ...l, status } : l));
    } catch (err) {
      showToast('Status update failed.', 'error');
    }
  };

  const handleExport = async () => {
    try {
      const res = await exportLeads();
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', 'leads.csv');
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (err) {
      showToast('Export failed.', 'error');
    }
  };

  const filteredEmailStatus = emailStatusFilter === 'all'
    ? emailStatusData
    : emailStatusData.filter((l) => l.email_status === emailStatusFilter);

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

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-mono text-xl font-bold text-white">Leads</h2>
          <p className="text-sm text-muted mt-0.5">{filtered.length} leads found</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowAddLead(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-gradient-to-r from-primary to-secondary text-white text-sm font-semibold hover:opacity-90 transition-opacity"
          >
            <Plus size={14} /> Add Lead
          </button>
          <button
            onClick={handleExport}
            className="flex items-center gap-2 px-4 py-2 bg-white/5 hover:bg-white/10 border border-border rounded-lg text-sm text-muted hover:text-white transition-all"
          >
            <Download size={14} /> Export CSV
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        {[
          { key: 'leads', label: 'All Leads' },
          { key: 'status', label: 'Email Status' },
        ].map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setActiveTab(key)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              activeTab === key
                ? 'border-primary text-primary'
                : 'border-transparent text-muted hover:text-white'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {activeTab === 'leads' ? (
        <>
          {/* Scrape Panel */}
          <div className="bg-surface border border-border rounded-xl p-4 space-y-3">
            <p className="text-xs font-semibold text-muted uppercase tracking-wider flex items-center gap-1.5">
              <Globe size={12} className="text-primary" /> Scrape New Leads
            </p>
            <div className="flex flex-wrap gap-3">
              <input
                type="text"
                placeholder='Search query — e.g. "restaurants Karachi"'
                value={scrapeQuery}
                onChange={(e) => setScrapeQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleScrape()}
                disabled={scraping}
                className="flex-1 min-w-[220px] bg-bg border border-border rounded-lg px-3 py-2 text-sm text-white placeholder-muted focus:outline-none focus:border-primary transition-colors disabled:opacity-50"
              />
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted whitespace-nowrap">Max results</span>
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={scrapeMax}
                  onChange={(e) => setScrapeMax(Number(e.target.value))}
                  disabled={scraping}
                  className="w-16 bg-bg border border-border rounded-lg px-2 py-2 text-sm text-white text-center focus:outline-none focus:border-primary transition-colors disabled:opacity-50"
                />
              </div>
              {scraping ? (
                <button
                  onClick={handleStopScrape}
                  className="flex items-center gap-2 px-4 py-2 bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20 rounded-lg text-sm font-medium transition-all"
                >
                  <Square size={13} /> Stop
                </button>
              ) : (
                <button
                  onClick={handleScrape}
                  disabled={!scrapeQuery.trim()}
                  className="flex items-center gap-2 px-4 py-2 bg-primary/10 border border-primary/30 text-primary hover:bg-primary/20 rounded-lg text-sm font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Globe size={13} /> Scrape
                </button>
              )}
            </div>
            {scrapeLog.length > 0 && (
              <div
                ref={logRef}
                className="bg-bg border border-border rounded-lg p-3 max-h-44 overflow-y-auto space-y-0.5 font-mono text-xs"
              >
                {scrapeLog.map((entry, i) => (
                  <div
                    key={i}
                    className={`flex items-start gap-1.5 leading-5 ${
                      entry.type === 'success' ? 'text-green-400' :
                      entry.type === 'error'   ? 'text-red-400' :
                      entry.type === 'skip'    ? 'text-zinc-500' :
                      entry.type === 'done'    ? 'text-primary font-semibold' :
                      'text-zinc-400'
                    }`}
                  >
                    <span className="shrink-0 mt-px">
                      {entry.type === 'success' ? '✓' :
                       entry.type === 'error'   ? '✗' :
                       entry.type === 'skip'    ? '–' :
                       entry.type === 'done'    ? '●' : '›'}
                    </span>
                    {entry.text}
                  </div>
                ))}
                {scraping && (
                  <div className="flex items-center gap-1.5 text-zinc-500 animate-pulse">
                    <Loader2 size={10} className="animate-spin" /> working…
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Bulk Email Toolbar */}
          {selectedIds.size > 0 && (
            <div className="bg-primary/5 border border-primary/20 rounded-xl p-3 flex flex-wrap items-center gap-3">
              <span className="text-sm text-primary font-medium">
                {selectedIds.size} lead{selectedIds.size !== 1 ? 's' : ''} selected
              </span>
              <div className="flex items-center gap-2 ml-auto flex-wrap">
                <button
                  onClick={handleGenerateEmails}
                  disabled={generating || sending}
                  className="flex items-center gap-2 px-4 py-2 bg-purple-500/10 border border-purple-500/30 text-purple-400 hover:bg-purple-500/20 rounded-lg text-sm font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {generating ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                  Generate Emails
                </button>
                <button
                  onClick={handleSendEmails}
                  disabled={generating || sending}
                  className="flex items-center gap-2 px-4 py-2 bg-green-500/10 border border-green-500/30 text-green-400 hover:bg-green-500/20 rounded-lg text-sm font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {sending ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
                  Send Emails
                </button>
                <button
                  onClick={handleStartSending}
                  disabled={startSendingActive || generating || sending}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-500/10 border border-blue-500/30 text-blue-400 hover:bg-blue-500/20 rounded-lg text-sm font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {startSendingActive
                    ? <Loader2 size={13} className="animate-spin" />
                    : <Play size={13} />}
                  Start Sending ({selectedIds.size})
                </button>
                <button
                  onClick={() => { setSelectedIds(new Set()); setGeneratedPreviews([]); }}
                  className="px-3 py-2 bg-white/5 border border-border text-muted hover:text-white rounded-lg text-sm transition-all"
                >
                  Clear
                </button>
              </div>
            </div>
          )}

          {/* Generated Previews */}
          {generatedPreviews.length > 0 && (
            <div className="bg-surface border border-border rounded-xl p-4 space-y-3">
              <p className="text-xs font-semibold text-muted uppercase tracking-wider flex items-center gap-1.5">
                <Sparkles size={12} className="text-purple-400" /> Generated Email Previews
              </p>
              <div className="space-y-3">
                {generatedPreviews.map((preview) => (
                  <div key={preview.lead_id} className="bg-bg border border-border rounded-lg px-4 py-3 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-primary truncate">{preview.business_name}</span>
                    </div>
                    <p className="text-sm text-white font-medium">{preview.subject}</p>
                    <pre className="text-xs text-zinc-300 whitespace-pre-wrap leading-5 font-sans border-t border-border pt-2 mt-1">
                      {preview.body}
                    </pre>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Start Sending Progress */}
          {(startSendingActive || sendingItems.length > 0) && (
            <div className="bg-surface border border-border rounded-xl p-4 space-y-4">
              {/* Header + progress bar */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-muted uppercase tracking-wider flex items-center gap-1.5">
                    <Play size={12} className="text-blue-400" />
                    {startSendingActive ? `Sending ${sendingStats.current} of ${sendingStats.total}…` : 'Sending complete'}
                  </p>
                  {!startSendingActive && sendingDone && (
                    <button
                      onClick={() => { setSendingItems([]); setSendingDone(null); setSendingStats({ current: 0, total: 0 }); }}
                      className="p-1 rounded hover:bg-white/5 text-muted hover:text-white transition-colors"
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
                {sendingStats.total > 0 && (
                  <div className="w-full bg-bg rounded-full h-1.5 overflow-hidden">
                    <div
                      className="h-full bg-blue-500 rounded-full transition-all duration-500"
                      style={{ width: `${Math.round((sendingStats.current / sendingStats.total) * 100)}%` }}
                    />
                  </div>
                )}
              </div>

              {/* Live feed */}
              {sendingItems.length > 0 && (
                <div className="space-y-1.5 max-h-60 overflow-y-auto font-mono text-xs">
                  {sendingItems.map((item, i) => (
                    <div
                      key={i}
                      className={`flex items-start gap-2 leading-5 ${
                        item.status === 'sent'    ? 'text-green-400' :
                        item.status === 'failed'  ? 'text-red-400'   :
                        item.status === 'skipped' ? 'text-zinc-500'  :
                        'text-red-400'
                      }`}
                    >
                      <span className="shrink-0">
                        {item.status === 'sent'    ? '✅' :
                         item.status === 'failed'  ? '❌' :
                         item.status === 'skipped' ? '–'  : '⚠'}
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="font-semibold">{item.company}</span>
                        {item.to_email && (
                          <span className="text-zinc-500"> ›{' '}{item.to_email}</span>
                        )}
                        {item.status !== 'error' && (
                          <>
                            {' — '}
                            <span className="capitalize">{item.status}</span>
                            {item.status === 'sent' && item.subject ? (
                              <span className="text-zinc-500"> — "{item.subject.length > 55 ? item.subject.slice(0, 55) + '…' : item.subject}"</span>
                            ) : item.reason ? (
                              <span className="text-zinc-500"> — {item.reason}</span>
                            ) : null}
                          </>
                        )}
                        {item.status === 'error' && <span> — {item.reason}</span>}
                      </span>
                      <span className="shrink-0 text-zinc-600">{item.progress}</span>
                    </div>
                  ))}
                  {nextDelaySecs !== null && (
                    <div className="flex items-center gap-2 text-zinc-500">
                      <span>⏳</span>
                      <span>Next lead in {nextDelaySecs} second{nextDelaySecs !== 1 ? 's' : ''}…</span>
                    </div>
                  )}
                </div>
              )}

              {/* Summary card */}
              {sendingDone && (
                <div className={`rounded-lg px-4 py-3 border flex items-center gap-3 ${
                  sendingDone.failed === 0
                    ? 'bg-green-500/5 border-green-500/20'
                    : 'bg-zinc-500/5 border-border'
                }`}>
                  <span className="text-base">{sendingDone.failed === 0 ? '✅' : '📊'}</span>
                  <div>
                    <p className="text-sm font-semibold text-white">
                      Done — {sendingDone.sent} sent, {sendingDone.failed} failed
                    </p>
                    <p className="text-xs text-muted mt-0.5">Lead statuses updated in table.</p>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Filters */}
          <div className="bg-surface border border-border rounded-xl p-4 flex flex-wrap gap-3">
            <div className="relative flex-1 min-w-[200px]">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
              <input
                type="text"
                placeholder="Search leads…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full bg-bg border border-border rounded-lg pl-8 pr-3 py-2 text-sm text-white placeholder-muted focus:outline-none focus:border-primary transition-colors"
              />
            </div>
            <select
              value={filters.status}
              onChange={(e) => setFilters((p) => ({ ...p, status: e.target.value }))}
              className="bg-bg border border-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-primary transition-colors"
            >
              <option value="">All Statuses</option>
              <option value="new">New</option>
              <option value="contacted">Contacted</option>
              <option value="replied">Replied</option>
              <option value="converted">Converted</option>
            </select>
            <input
              type="text"
              placeholder="City"
              value={filters.city}
              onChange={(e) => setFilters((p) => ({ ...p, city: e.target.value }))}
              className="bg-bg border border-border rounded-lg px-3 py-2 text-sm text-white placeholder-muted focus:outline-none focus:border-primary transition-colors w-32"
            />
            <input
              type="text"
              placeholder="Keyword"
              value={filters.keyword}
              onChange={(e) => setFilters((p) => ({ ...p, keyword: e.target.value }))}
              className="bg-bg border border-border rounded-lg px-3 py-2 text-sm text-white placeholder-muted focus:outline-none focus:border-primary transition-colors w-32"
            />
            <select
              value={filters.campaign_id}
              onChange={(e) => setFilters((p) => ({ ...p, campaign_id: e.target.value }))}
              className="bg-bg border border-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-primary transition-colors"
            >
              <option value="">All Campaigns</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>

          {/* Leads Table */}
          <div className="bg-surface border border-border rounded-xl overflow-hidden">
            {loading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 size={28} className="animate-spin text-primary" />
              </div>
            ) : paginated.length === 0 ? (
              <p className="text-center text-muted py-16 text-sm">No leads found.</p>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-muted text-xs uppercase tracking-wider border-b border-border bg-bg/50">
                        <th className="px-4 py-3">
                          <input
                            type="checkbox"
                            checked={allPageSelected}
                            onChange={(e) => handleSelectAll(e.target.checked)}
                            className="accent-primary w-3.5 h-3.5 cursor-pointer"
                          />
                        </th>
                        <th className="px-5 py-3">Business</th>
                        <th className="px-5 py-3">Phone</th>
                        <th className="px-5 py-3">Email</th>
                        <th className="px-5 py-3">Category</th>
                        <th className="px-5 py-3">City</th>
                        <th className="px-5 py-3">Status</th>
                        <th className="px-5 py-3">Email</th>
                        <th className="px-5 py-3 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {paginated.map((lead) => (
                        <tr
                          key={lead.id}
                          className={`hover:bg-white/2 transition-colors ${selectedIds.has(lead.id) ? 'bg-primary/5' : ''}`}
                        >
                          <td className="px-4 py-3">
                            <input
                              type="checkbox"
                              checked={selectedIds.has(lead.id)}
                              onChange={() => handleSelectLead(lead.id)}
                              className="accent-primary w-3.5 h-3.5 cursor-pointer"
                            />
                          </td>
                          <td className="px-5 py-3">
                            <div>
                              <p className="text-white font-medium truncate max-w-[180px]">{lead.business_name}</p>
                              {lead.website && (
                                <a
                                  href={lead.website}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-xs text-primary hover:underline truncate max-w-[180px] block"
                                >
                                  {lead.website}
                                </a>
                              )}
                            </div>
                          </td>
                          <td className="px-5 py-3 text-muted text-xs">{lead.phone || '—'}</td>
                          <td className="px-5 py-3 text-muted text-xs">{lead.email || '—'}</td>
                          <td className="px-5 py-3 text-muted text-xs truncate max-w-[120px]">{lead.category || '—'}</td>
                          <td className="px-5 py-3 text-muted text-xs">{lead.city || '—'}</td>
                          <td className="px-5 py-3">
                            <select
                              value={lead.status}
                              onChange={(e) => handleStatusChange(lead.id, e.target.value)}
                              className={`text-xs border rounded px-2 py-0.5 bg-transparent focus:outline-none cursor-pointer ${STATUS_COLORS[lead.status] || ''}`}
                            >
                              <option value="new">New</option>
                              <option value="contacted">Contacted</option>
                              <option value="replied">Replied</option>
                              <option value="converted">Converted</option>
                            </select>
                          </td>
                          <td className="px-5 py-3">
                            <span className={`text-xs px-2 py-0.5 rounded-full border ${EMAIL_STATUS_COLORS[lead.email_status || 'pending']}`}>
                              {lead.email_status || 'pending'}
                            </span>
                          </td>
                          <td className="px-5 py-3">
                            <div className="flex items-center gap-2 justify-end">
                              <button
                                onClick={() => handleSendEmail(lead.id)}
                                disabled={!lead.email || actionLoading[lead.id] === 'email'}
                                title={lead.email ? 'Send Email' : 'No email found'}
                                className="p-1.5 rounded hover:bg-primary/10 text-muted hover:text-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                              >
                                {actionLoading[lead.id] === 'email'
                                  ? <Loader2 size={14} className="animate-spin" />
                                  : <Mail size={14} />}
                              </button>
                              <button
                                onClick={() => handleDelete(lead.id)}
                                disabled={actionLoading[lead.id] === 'delete'}
                                className="p-1.5 rounded hover:bg-red-500/10 text-muted hover:text-red-400 transition-colors disabled:opacity-40"
                              >
                                {actionLoading[lead.id] === 'delete'
                                  ? <Loader2 size={14} className="animate-spin" />
                                  : <Trash2 size={14} />}
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Pagination */}
                {totalPages > 1 && (
                  <div className="flex items-center justify-between px-5 py-3 border-t border-border">
                    <p className="text-xs text-muted">
                      Page {page} of {totalPages} · {filtered.length} leads
                    </p>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setPage((p) => Math.max(1, p - 1))}
                        disabled={page === 1}
                        className="p-1.5 rounded hover:bg-white/5 text-muted hover:text-white transition-colors disabled:opacity-40"
                      >
                        <ChevronLeft size={16} />
                      </button>
                      <button
                        onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                        disabled={page === totalPages}
                        className="p-1.5 rounded hover:bg-white/5 text-muted hover:text-white transition-colors disabled:opacity-40"
                      >
                        <ChevronRight size={16} />
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </>
      ) : (
        /* Email Status Tab */
        <div className="space-y-4">
          <div className="flex items-center gap-2 flex-wrap">
            {['all', 'pending', 'sent', 'failed'].map((f) => (
              <button
                key={f}
                onClick={() => setEmailStatusFilter(f)}
                className={`px-3 py-1.5 rounded-lg text-sm capitalize transition-all ${
                  emailStatusFilter === f
                    ? 'bg-primary/10 border border-primary/30 text-primary'
                    : 'bg-white/5 border border-border text-muted hover:text-white'
                }`}
              >
                {f}
                {f !== 'all' && (
                  <span className="ml-1.5 text-xs opacity-60">
                    ({emailStatusData.filter((l) => l.email_status === f).length})
                  </span>
                )}
              </button>
            ))}
            <button
              onClick={loadEmailStatusData}
              disabled={loadingStatus}
              className="ml-auto flex items-center gap-1.5 px-3 py-1.5 bg-white/5 border border-border rounded-lg text-sm text-muted hover:text-white transition-all disabled:opacity-40"
            >
              {loadingStatus && <Loader2 size={12} className="animate-spin" />}
              Refresh
            </button>
          </div>

          <div className="bg-surface border border-border rounded-xl overflow-hidden">
            {loadingStatus ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 size={28} className="animate-spin text-primary" />
              </div>
            ) : filteredEmailStatus.length === 0 ? (
              <p className="text-center text-muted py-16 text-sm">No leads found.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-muted text-xs uppercase tracking-wider border-b border-border bg-bg/50">
                      <th className="px-5 py-3">Business</th>
                      <th className="px-5 py-3">Email</th>
                      <th className="px-5 py-3">Subject Preview</th>
                      <th className="px-5 py-3">Status</th>
                      <th className="px-5 py-3">Sent At</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {filteredEmailStatus.map((lead) => (
                      <tr key={lead.id} className="hover:bg-white/2 transition-colors">
                        <td className="px-5 py-3 text-white font-medium truncate max-w-[180px]">
                          {lead.business_name}
                        </td>
                        <td className="px-5 py-3 text-muted text-xs">{lead.email || '—'}</td>
                        <td className="px-5 py-3 text-muted text-xs max-w-[240px] truncate">
                          {lead.email_subject
                            ? lead.email_subject.slice(0, 55) + (lead.email_subject.length > 55 ? '…' : '')
                            : '—'}
                        </td>
                        <td className="px-5 py-3">
                          <span className={`text-xs px-2 py-0.5 rounded-full border ${EMAIL_STATUS_COLORS[lead.email_status || 'pending']}`}>
                            {lead.email_status || 'pending'}
                          </span>
                        </td>
                        <td className="px-5 py-3 text-muted text-xs">
                          {lead.email_sent_at
                            ? new Date(lead.email_sent_at).toLocaleString()
                            : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Add Lead Modal */}
      {showAddLead && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-surface border border-border rounded-xl w-full max-w-lg mx-4 shadow-2xl">
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <h3 className="font-mono text-sm font-bold text-white flex items-center gap-2">
                <Plus size={16} className="text-primary" /> Add Lead Manually
              </h3>
              <button
                onClick={() => { setShowAddLead(false); setAddLeadForm(EMPTY_LEAD_FORM); }}
                className="text-muted hover:text-white transition-colors"
              >
                <X size={18} />
              </button>
            </div>
            <form onSubmit={handleAddLead} className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2">
                  <label className="block text-xs text-muted mb-1.5">Business Name <span className="text-red-400">*</span></label>
                  <input
                    required
                    type="text"
                    placeholder="e.g. ABC Engineering Ltd"
                    value={addLeadForm.business_name}
                    onChange={(e) => setAddLeadForm((p) => ({ ...p, business_name: e.target.value }))}
                    className="w-full bg-bg border border-border rounded-lg px-3 py-2.5 text-sm text-white placeholder-muted focus:outline-none focus:border-primary transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-xs text-muted mb-1.5">Email</label>
                  <input
                    type="email"
                    placeholder="contact@company.com"
                    value={addLeadForm.email}
                    onChange={(e) => setAddLeadForm((p) => ({ ...p, email: e.target.value }))}
                    className="w-full bg-bg border border-border rounded-lg px-3 py-2.5 text-sm text-white placeholder-muted focus:outline-none focus:border-primary transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-xs text-muted mb-1.5">Phone</label>
                  <input
                    type="text"
                    placeholder="+44 123 456 7890"
                    value={addLeadForm.phone}
                    onChange={(e) => setAddLeadForm((p) => ({ ...p, phone: e.target.value }))}
                    className="w-full bg-bg border border-border rounded-lg px-3 py-2.5 text-sm text-white placeholder-muted focus:outline-none focus:border-primary transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-xs text-muted mb-1.5">Website</label>
                  <input
                    type="text"
                    placeholder="https://company.com"
                    value={addLeadForm.website}
                    onChange={(e) => setAddLeadForm((p) => ({ ...p, website: e.target.value }))}
                    className="w-full bg-bg border border-border rounded-lg px-3 py-2.5 text-sm text-white placeholder-muted focus:outline-none focus:border-primary transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-xs text-muted mb-1.5">City</label>
                  <input
                    type="text"
                    placeholder="London"
                    value={addLeadForm.city}
                    onChange={(e) => setAddLeadForm((p) => ({ ...p, city: e.target.value }))}
                    className="w-full bg-bg border border-border rounded-lg px-3 py-2.5 text-sm text-white placeholder-muted focus:outline-none focus:border-primary transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-xs text-muted mb-1.5">Category / Industry</label>
                  <input
                    type="text"
                    placeholder="e.g. Manufacturing"
                    value={addLeadForm.category}
                    onChange={(e) => setAddLeadForm((p) => ({ ...p, category: e.target.value }))}
                    className="w-full bg-bg border border-border rounded-lg px-3 py-2.5 text-sm text-white placeholder-muted focus:outline-none focus:border-primary transition-colors"
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-xs text-muted mb-1.5">Address</label>
                  <input
                    type="text"
                    placeholder="123 Business Park, London"
                    value={addLeadForm.address}
                    onChange={(e) => setAddLeadForm((p) => ({ ...p, address: e.target.value }))}
                    className="w-full bg-bg border border-border rounded-lg px-3 py-2.5 text-sm text-white placeholder-muted focus:outline-none focus:border-primary transition-colors"
                  />
                </div>
              </div>
              <p className="text-xs text-muted">
                After adding, select the lead and use <span className="text-purple-400">Generate Emails</span> + <span className="text-green-400">Send Emails</span> — or click the <span className="text-primary">✉ mail icon</span> in the row to send instantly.
              </p>
              <div className="flex gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => { setShowAddLead(false); setAddLeadForm(EMPTY_LEAD_FORM); }}
                  className="flex-1 py-2.5 rounded-lg border border-border text-sm text-muted hover:text-white hover:border-white/20 transition-all"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={addLeadSaving}
                  className="flex-1 py-2.5 rounded-lg bg-gradient-to-r from-primary to-secondary text-white text-sm font-semibold flex items-center justify-center gap-2 hover:opacity-90 transition-opacity disabled:opacity-60"
                >
                  {addLeadSaving ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
                  {addLeadSaving ? 'Saving…' : 'Add Lead'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
