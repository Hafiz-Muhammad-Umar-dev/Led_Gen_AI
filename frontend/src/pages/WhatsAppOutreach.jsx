import React, { useState, useEffect, useRef } from 'react';
import {
  RefreshCw, Loader2, CheckCircle, XCircle, HelpCircle, Search, ChevronLeft, ChevronRight,
  Send, X, Sparkles, Eye,
} from 'lucide-react';
import {
  getWhatsappLeads, checkWhatsappNumbersStream, getWhatsappStatus, sendWhatsappMessagesStream,
  generateWhatsappMessagesStream,
} from '../services/api';

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'yes', label: 'Has WhatsApp' },
  { key: 'no', label: 'No WhatsApp' },
  { key: 'unchecked', label: 'Unchecked' },
];

const CLASSIFY_FILTERS = [
  { key: 'all', label: 'All Sources' },
  { key: 'leads', label: 'Leads' },
  { key: 'campaign', label: 'Campaign' },
  { key: 'product_campaign', label: 'Product Campaign' },
];

const PAGE_SIZE = 25;
const MAX_SEND_BATCH = 3;

const BADGE = {
  yes: { label: 'Yes', className: 'bg-green-500/10 text-green-400 border-green-500/20', Icon: CheckCircle },
  no: { label: 'No', className: 'bg-red-500/10 text-red-400 border-red-500/20', Icon: XCircle },
  unchecked: { label: 'Unchecked', className: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20', Icon: HelpCircle },
};

function WhatsAppBadge({ status }) {
  const { label, className, Icon } = BADGE[status] || BADGE.unchecked;
  return (
    <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border ${className}`}>
      <Icon size={11} /> {label}
    </span>
  );
}

const MESSAGE_STATUS_STYLE = {
  sent: { label: 'Sent', className: 'bg-green-500/10 text-green-400 border-green-500/20' },
  failed: { label: 'Failed', className: 'bg-red-500/10 text-red-400 border-red-500/20' },
};

function MessageBadge({ lead, onPreview }) {
  if (!lead.has_message) {
    return <span className="text-xs text-muted">Not generated</span>;
  }
  const { label, className } = MESSAGE_STATUS_STYLE[lead.whatsapp_message_status] || {
    label: 'Ready',
    className: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  };
  return (
    <button
      type="button"
      onClick={() => onPreview(lead)}
      title="Preview message"
      className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border hover:opacity-80 transition-opacity ${className}`}
    >
      <Eye size={11} /> {label}
    </button>
  );
}

const rowKey = (lead) => `${lead.source}:${lead.id}`;
const isSendable = (lead) => lead.has_whatsapp === 'yes' && lead.has_message;
const isSelectable = (lead) => lead.has_whatsapp === 'yes';

export default function WhatsAppOutreach() {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [classify, setClassify] = useState('all');
  const [page, setPage] = useState(1);
  const [waConnected, setWaConnected] = useState(null);
  const [toast, setToast] = useState(null);

  const [checking, setChecking] = useState(false);
  const [progress, setProgress] = useState({ checked: 0, total: 0 });
  const [checkError, setCheckError] = useState('');
  const abortRef = useRef(null);

  const [generating, setGenerating] = useState(false);
  const [genProgress, setGenProgress] = useState({ generated: 0, failed: 0, total: 0 });
  const [genError, setGenError] = useState('');
  const genAbortRef = useRef(null);

  const [selected, setSelected] = useState(new Set());
  const [sending, setSending] = useState(false);
  const [sendItems, setSendItems] = useState([]);
  const sendAbortRef = useRef(null);

  const [previewLead, setPreviewLead] = useState(null);

  const showToast = (msg, type = 'error') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  };

  const load = async (has_whatsapp = filter, source = classify) => {
    setLoading(true);
    try {
      const params = {};
      if (has_whatsapp !== 'all') params.has_whatsapp = has_whatsapp;
      if (source !== 'all') params.classify = source;
      const res = await getWhatsappLeads(params);
      setLeads(res.data?.data || []);
    } catch (err) {
      console.error('WhatsApp leads load error:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setPage(1);
    load(filter, classify);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, classify]);

  useEffect(() => {
    getWhatsappStatus()
      .then((res) => setWaConnected(res.data?.data?.status === 'connected'))
      .catch(() => setWaConnected(false));
    return () => {
      abortRef.current?.abort();
      genAbortRef.current?.abort();
      sendAbortRef.current?.abort();
    };
  }, []);

  const totalPages = Math.max(1, Math.ceil(leads.length / PAGE_SIZE));
  const paginated = leads.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const handleCheck = async () => {
    if (checking) return;
    setChecking(true);
    setCheckError('');
    setProgress({ checked: 0, total: 0 });

    const { promise, controller } = checkWhatsappNumbersStream();
    abortRef.current = controller;

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
            setProgress({ checked: data.checked, total: data.total });
          } else if (data.type === 'complete') {
            setProgress({ checked: data.checked, total: data.total });
            setChecking(false);
            setPage(1);
            load(filter);
          } else if (data.type === 'error') {
            setCheckError(data.message || 'Check failed.');
            setChecking(false);
          }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        setCheckError(err.message || 'Connection error');
      }
      setChecking(false);
    }
  };

  const handleGenerate = async (targets = []) => {
    if (generating) return;
    setGenerating(true);
    setGenError('');
    setGenProgress({ generated: 0, failed: 0, total: 0 });

    const { promise, controller } = generateWhatsappMessagesStream(
      targets.map((l) => ({ id: l.id, source: l.source }))
    );
    genAbortRef.current = controller;

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
            setGenProgress({ generated: data.generated, failed: data.failed, total: data.total });
          } else if (data.type === 'complete') {
            setGenProgress({ generated: data.generated, failed: data.failed, total: data.total });
            setGenerating(false);
            setSelected(new Set());
            load(filter);
          } else if (data.type === 'error') {
            setGenError(data.message || 'Generation failed.');
            setGenerating(false);
          }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        setGenError(err.message || 'Connection error');
      }
      setGenerating(false);
    }
  };

  const toggleSelect = (lead) => {
    if (!isSelectable(lead) || sending || generating) return;
    const key = rowKey(lead);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
        return next;
      }
      // The 3-message cap only matters for actually sending — selecting
      // several "Not generated" rows to write messages for is unlimited.
      if (isSendable(lead)) {
        const sendableSelectedCount = leads.filter((l) => prev.has(rowKey(l)) && isSendable(l)).length;
        if (sendableSelectedCount >= MAX_SEND_BATCH) {
          showToast(`You can send to at most ${MAX_SEND_BATCH} leads at a time.`);
          return prev;
        }
      }
      next.add(key);
      return next;
    });
  };

  const handleSend = async () => {
    const targets = getSelectedLeads().filter(isSendable);
    if (sending || targets.length === 0) return;
    if (!window.confirm(
      `Send the generated message via WhatsApp to ${targets.length} lead${targets.length !== 1 ? 's' : ''}?`
    )) return;

    setSending(true);
    setSendItems([]);

    const { promise, controller } = sendWhatsappMessagesStream(
      targets.map((l) => ({ id: l.id, source: l.source }))
    );
    sendAbortRef.current = controller;

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
            setSendItems((prev) => [...prev, data]);
          } else if (data.type === 'complete') {
            setSending(false);
            setSelected(new Set());
            showToast(`Sent ${data.sent}, failed ${data.failed}.`, data.failed ? 'error' : 'success');
            load(filter);
          } else if (data.type === 'error') {
            setSendItems((prev) => [...prev, { business_name: 'System', status: 'failed', reason: data.message }]);
            setSending(false);
          }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        showToast(err.message || 'Connection error');
      }
      setSending(false);
    }
  };

  // Selection must survive filter/page changes, so look targets up across
  // the full currently-loaded list, not just the visible page.
  const getSelectedLeads = () => leads.filter((l) => selected.has(rowKey(l)));
  const sendTargets = getSelectedLeads().filter(isSendable);
  const generateTargets = getSelectedLeads().filter((l) => isSelectable(l) && !l.has_message);

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

      <div>
        <h2 className="font-mono text-xl font-bold text-white">WhatsApp Outreach</h2>
        <p className="text-sm text-muted mt-0.5">Check which leads are reachable on WhatsApp, then send them the generated message</p>
      </div>

      {/* Section 1 — Check WhatsApp Status */}
      <div className="bg-surface border border-border rounded-xl p-5 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h3 className="font-mono text-sm font-bold text-white">Check WhatsApp Status</h3>
            <p className="text-xs text-muted mt-0.5">
              Looks up every lead with a phone number that hasn't been checked yet.
            </p>
          </div>
          <button
            onClick={handleCheck}
            disabled={checking || waConnected === false}
            title={waConnected === false ? 'Connect WhatsApp from Settings first' : undefined}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-gradient-to-r from-primary to-secondary text-white text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-60"
          >
            {checking ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
            {checking ? 'Checking…' : 'Check WhatsApp Status'}
          </button>
        </div>

        {waConnected === false && !checking && (
          <p className="text-xs text-yellow-400">
            WhatsApp isn't connected — go to Settings and scan the QR code first.
          </p>
        )}

        {(checking || progress.total > 0) && (
          <div className="space-y-1.5">
            <div className="w-full h-2 rounded-full bg-bg overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-primary to-secondary transition-all duration-300"
                style={{ width: `${progress.total ? (progress.checked / progress.total) * 100 : 0}%` }}
              />
            </div>
            <p className="text-xs text-muted">
              {checking
                ? `Checking ${progress.checked}/${progress.total}…`
                : `Checked ${progress.checked}/${progress.total}.`}
            </p>
          </div>
        )}

        {checkError && <p className="text-xs text-red-400">{checkError}</p>}
      </div>

      {/* Section 2 — Generate Missing Messages */}
      <div className="bg-surface border border-border rounded-xl p-5 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h3 className="font-mono text-sm font-bold text-white">Generate Missing Messages</h3>
            <p className="text-xs text-muted mt-0.5">
              {generateTargets.length > 0
                ? `Tick "Not generated" rows below to target specific leads — ${generateTargets.length} selected.`
                : "Writes the Groq message (same generator used for email) for every WhatsApp-confirmed lead that doesn't have one yet. Tick specific \"Not generated\" rows below to target only those instead."}
            </p>
          </div>
          <button
            onClick={() => handleGenerate(generateTargets)}
            disabled={generating || waConnected === false}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-gradient-to-r from-primary to-secondary text-white text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-60"
          >
            {generating ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
            {generating
              ? 'Generating…'
              : generateTargets.length > 0
              ? `Generate Selected (${generateTargets.length})`
              : 'Generate Missing Messages'}
          </button>
        </div>

        {(generating || genProgress.total > 0) && (
          <div className="space-y-1.5">
            <div className="w-full h-2 rounded-full bg-bg overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-primary to-secondary transition-all duration-300"
                style={{ width: `${genProgress.total ? ((genProgress.generated + genProgress.failed) / genProgress.total) * 100 : 0}%` }}
              />
            </div>
            <p className="text-xs text-muted">
              {generating
                ? `Generating ${genProgress.generated + genProgress.failed}/${genProgress.total}…`
                : `Generated ${genProgress.generated}/${genProgress.total}${genProgress.failed ? ` (${genProgress.failed} failed)` : ''}.`}
            </p>
          </div>
        )}

        {genError && <p className="text-xs text-red-400">{genError}</p>}
      </div>

      {/* Section 3 — Send via WhatsApp */}
      <div className="bg-surface border border-border rounded-xl p-5 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h3 className="font-mono text-sm font-bold text-white">Send via WhatsApp</h3>
            <p className="text-xs text-muted mt-0.5">
              Tick up to {MAX_SEND_BATCH} "Ready"/"Failed" leads below (WhatsApp confirmed + message
              already generated) and send that message as WhatsApp text.
            </p>
          </div>
          <button
            onClick={handleSend}
            disabled={sending || sendTargets.length === 0}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-gradient-to-r from-primary to-secondary text-white text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-60 shrink-0"
          >
            {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            {sending ? 'Sending…' : `Send WhatsApp (${sendTargets.length}/${MAX_SEND_BATCH})`}
          </button>
        </div>

        {sendItems.length > 0 && (
          <div className="space-y-1.5 max-h-40 overflow-y-auto scrollbar-thin">
            {sendItems.map((item, i) => (
              <div key={i} className="flex items-center justify-between gap-2 text-xs bg-bg border border-border rounded-lg px-3 py-2">
                <span className="text-white truncate">{item.business_name}</span>
                <span className={item.status === 'sent' ? 'text-green-400' : 'text-red-400'}>
                  {item.status === 'sent' ? '✅ sent' : `❌ ${item.reason || 'failed'}`}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Section 4 — Results table */}
      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border flex-wrap gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            {CLASSIFY_FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setClassify(f.key)}
                className={`text-xs px-2.5 py-1 rounded-lg border transition-colors ${
                  classify === f.key
                    ? 'text-secondary border-secondary/30 bg-secondary/10'
                    : 'text-muted border-border hover:text-white'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <button
            onClick={() => load(filter, classify)}
            title="Refresh"
            className="p-1.5 rounded-lg border border-border text-muted hover:text-white transition-colors"
          >
            <RefreshCw size={13} />
          </button>
        </div>

        <div className="flex items-center gap-2 flex-wrap px-5 py-3 border-b border-border">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`text-xs px-2.5 py-1 rounded-lg border transition-colors ${
                filter === f.key
                  ? 'text-primary border-primary/30 bg-primary/10'
                  : 'text-muted border-border hover:text-white'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 size={28} className="animate-spin text-primary" />
          </div>
        ) : leads.length === 0 ? (
          <p className="text-center text-muted py-16 text-sm">No leads found.</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted text-xs uppercase tracking-wider border-b border-border bg-bg/50">
                    <th className="px-4 py-3"></th>
                    <th className="px-5 py-3">Business Name</th>
                    <th className="px-5 py-3">Source</th>
                    <th className="px-5 py-3">Phone</th>
                    <th className="px-5 py-3">Has WhatsApp</th>
                    <th className="px-5 py-3">Message</th>
                    <th className="px-5 py-3">Last Checked</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {paginated.map((lead) => {
                    const key = rowKey(lead);
                    const selectable = isSelectable(lead);
                    return (
                      <tr key={key} className={`hover:bg-white/2 transition-colors ${selected.has(key) ? 'bg-primary/5' : ''}`}>
                        <td className="px-4 py-3">
                          <input
                            type="checkbox"
                            checked={selected.has(key)}
                            onChange={() => toggleSelect(lead)}
                            disabled={!selectable || sending || generating}
                            title={selectable ? undefined : 'Needs WhatsApp confirmed first'}
                            className="accent-primary w-3.5 h-3.5 cursor-pointer disabled:cursor-not-allowed disabled:opacity-30"
                          />
                        </td>
                        <td className="px-5 py-3 text-white font-medium truncate max-w-[220px]">{lead.business_name}</td>
                        <td className="px-5 py-3 text-muted text-xs">{lead.source_label}</td>
                        <td className="px-5 py-3 text-muted text-xs">{lead.phone || '—'}</td>
                        <td className="px-5 py-3"><WhatsAppBadge status={lead.has_whatsapp} /></td>
                        <td className="px-5 py-3"><MessageBadge lead={lead} onPreview={setPreviewLead} /></td>
                        <td className="px-5 py-3 text-muted text-xs">
                          {lead.whatsapp_checked_at ? new Date(lead.whatsapp_checked_at).toLocaleString() : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {totalPages > 1 && (
              <div className="flex items-center justify-between px-5 py-3 border-t border-border">
                <p className="text-xs text-muted">
                  Page {page} of {totalPages} · {leads.length} leads
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

      {previewLead && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={() => setPreviewLead(null)}
        >
          <div
            className="bg-surface border border-border rounded-xl w-full max-w-lg max-h-[80vh] shadow-2xl flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
              <h3 className="font-mono text-sm font-bold text-white truncate">{previewLead.business_name}</h3>
              <button type="button" onClick={() => setPreviewLead(null)}>
                <X size={18} className="text-muted hover:text-white transition-colors" />
              </button>
            </div>
            <div className="p-6 overflow-y-auto scrollbar-thin space-y-4">
              {previewLead.message_subject && (
                <div>
                  <p className="text-xs text-muted mb-1">Email subject (for reference — not sent on WhatsApp)</p>
                  <p className="text-sm text-white">{previewLead.message_subject}</p>
                </div>
              )}
              <div>
                <p className="text-xs text-muted mb-1">Message that will be sent</p>
                <pre className="text-sm text-zinc-300 whitespace-pre-wrap leading-6 font-sans">
                  {previewLead.message_body || '—'}
                </pre>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
