import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  UploadCloud, Sparkles, Send, Trash2, X, Loader2, RefreshCw,
} from 'lucide-react';
import {
  importLeads, listUploadedLeads, generateUploadEmails,
  sendUploadEmails, deleteUploadBatch,
} from '../services/api';

const EMAIL_STATUS_COLORS = {
  pending: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
  sent:    'bg-green-500/10 text-green-400 border-green-500/20',
  failed:  'bg-red-500/10 text-red-400 border-red-500/20',
};

export default function UploadLeads() {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [statusFilter, setStatusFilter] = useState('all');
  const [batchFilter, setBatchFilter] = useState('');
  const [uploading, setUploading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [sending, setSending] = useState(false);
  const [previews, setPreviews] = useState({});   // { [id]: { company_name, subject, body } }
  const [showModal, setShowModal] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [toast, setToast] = useState(null);
  const fileInputRef = useRef(null);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  };

  const loadLeads = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listUploadedLeads();
      setLeads(res.data.data || []);
    } catch (err) {
      console.error('Upload leads load error:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadLeads(); }, [loadLeads]);

  // Derived data
  const stats = {
    total:   leads.length,
    pending: leads.filter((l) => (l.email_status || 'pending') === 'pending').length,
    sent:    leads.filter((l) => l.email_status === 'sent').length,
    failed:  leads.filter((l) => l.email_status === 'failed').length,
  };

  const batches = [...new Set(leads.map((l) => l.upload_batch).filter(Boolean))];

  const filtered = leads.filter((l) => {
    const statusOk = statusFilter === 'all' || (l.email_status || 'pending') === statusFilter;
    const batchOk  = !batchFilter || l.upload_batch === batchFilter;
    return statusOk && batchOk;
  });

  const allSelected = filtered.length > 0 && filtered.every((l) => selectedIds.has(l.id));

  // ---- Selection ----

  const handleSelectAll = (checked) =>
    setSelectedIds(checked ? new Set(filtered.map((l) => l.id)) : new Set());

  const handleSelectLead = (id) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  // ---- Upload ----

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleUpload(file);
  };

  const handleFileChange = (e) => {
    const file = e.target.files[0];
    if (file) handleUpload(file);
    e.target.value = '';
  };

  const handleUpload = async (file) => {
    if (!file.name.match(/\.(xlsx|csv)$/i)) {
      showToast('Only .xlsx or .csv files are supported.', 'error');
      return;
    }
    setUploading(true);
    try {
      const res = await importLeads(file);
      showToast(`${res.data.imported} lead${res.data.imported !== 1 ? 's' : ''} imported, ${res.data.skipped} skipped.`);
      loadLeads();
    } catch (err) {
      showToast(err.response?.data?.detail || 'Upload failed.', 'error');
    } finally {
      setUploading(false);
    }
  };

  // ---- Generate ----

  const handleGenerate = async () => {
    if (selectedIds.size === 0 || generating) return;
    setGenerating(true);
    try {
      const res = await generateUploadEmails(Array.from(selectedIds));
      const newPreviews = {};
      res.data.data.forEach((item) => {
        if (!item.error) {
          newPreviews[item.id] = {
            company_name: item.company_name,
            subject: item.subject,
            body: item.body,
          };
          setLeads((prev) =>
            prev.map((l) => l.id === item.id ? { ...l, email_subject: item.subject } : l)
          );
        }
      });
      setPreviews(newPreviews);
      setShowModal(true);
      const count = Object.keys(newPreviews).length;
      showToast(`Generated emails for ${count} lead${count !== 1 ? 's' : ''}.`);
    } catch (err) {
      showToast(err.response?.data?.detail || 'Generation failed.', 'error');
    } finally {
      setGenerating(false);
    }
  };

  // ---- Send ----

  const handleSend = async (fromModal = false) => {
    const leadIds = fromModal
      ? Object.keys(previews).map(Number)
      : Array.from(selectedIds);
    if (leadIds.length === 0 || sending) return;
    setSending(true);
    try {
      const overrides = {};
      Object.entries(previews).forEach(([id, data]) => {
        overrides[id] = { subject: data.subject, body: data.body };
      });
      const res = await sendUploadEmails(leadIds, overrides);
      const { sent, failed } = res.data.data;
      sent.forEach((item) =>
        setLeads((prev) => prev.map((l) => l.id === item.id ? { ...l, email_status: 'sent' } : l))
      );
      failed.forEach((item) =>
        setLeads((prev) => prev.map((l) => l.id === item.id ? { ...l, email_status: 'failed' } : l))
      );
      const isAllFail = sent.length === 0 && failed.length > 0;
      showToast(
        failed.length === 0
          ? `${sent.length} email${sent.length !== 1 ? 's' : ''} sent successfully.`
          : `${sent.length} sent, ${failed.length} failed.`,
        isAllFail ? 'error' : 'success'
      );
      if (fromModal) setShowModal(false);
      setSelectedIds(new Set());
      setPreviews({});
    } catch (err) {
      showToast(err.response?.data?.detail || 'Send failed.', 'error');
    } finally {
      setSending(false);
    }
  };

  // ---- Delete batch ----

  const handleDeleteBatch = async (batch) => {
    if (!window.confirm(`Delete all leads from batch "${batch}"?`)) return;
    try {
      const res = await deleteUploadBatch(batch);
      showToast(`Deleted ${res.data.deleted} leads.`);
      if (batchFilter === batch) setBatchFilter('');
      loadLeads();
    } catch {
      showToast('Delete failed.', 'error');
    }
  };

  // ---- Preview edits ----

  const updatePreview = (id, field, value) =>
    setPreviews((prev) => ({ ...prev, [id]: { ...prev[id], [field]: value } }));

  const previewCount = Object.keys(previews).length;

  // ---- Render ----

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

      {/* Preview Modal */}
      {showModal && (
        <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/70 backdrop-blur-sm p-4 overflow-y-auto">
          <div className="w-full max-w-2xl my-8 bg-surface border border-border rounded-2xl shadow-2xl flex flex-col">

            {/* Modal header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
              <div className="flex items-center gap-2">
                <Sparkles size={15} className="text-purple-400" />
                <span className="text-white font-semibold text-sm">
                  Review Generated Emails ({previewCount})
                </span>
              </div>
              <button
                onClick={() => setShowModal(false)}
                className="p-1 rounded hover:bg-white/10 text-muted hover:text-white transition-colors"
              >
                <X size={16} />
              </button>
            </div>

            {/* Modal body — scrollable */}
            <div className="p-4 space-y-4 overflow-y-auto max-h-[62vh]">
              {Object.entries(previews).map(([id, preview]) => (
                <div key={id} className="bg-bg border border-border rounded-xl p-4 space-y-3">
                  <p className="text-xs font-semibold text-primary">{preview.company_name}</p>
                  <div>
                    <label className="block text-xs text-muted mb-1">Subject</label>
                    <input
                      type="text"
                      value={preview.subject}
                      onChange={(e) => updatePreview(Number(id), 'subject', e.target.value)}
                      className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-primary transition-colors"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-muted mb-1">Body</label>
                    <textarea
                      value={preview.body}
                      onChange={(e) => updatePreview(Number(id), 'body', e.target.value)}
                      rows={7}
                      className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-primary transition-colors resize-y font-sans leading-5"
                    />
                  </div>
                </div>
              ))}
            </div>

            {/* Modal footer */}
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-border shrink-0">
              <button
                onClick={() => setShowModal(false)}
                className="px-4 py-2 bg-white/5 border border-border text-muted hover:text-white rounded-lg text-sm transition-all"
              >
                Close
              </button>
              <button
                onClick={() => handleSend(true)}
                disabled={sending}
                className="flex items-center gap-2 px-5 py-2 bg-green-500/10 border border-green-500/30 text-green-400 hover:bg-green-500/20 rounded-lg text-sm font-medium transition-all disabled:opacity-40"
              >
                {sending ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
                Send {previewCount} Email{previewCount !== 1 ? 's' : ''}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Page header */}
      <div>
        <h2 className="font-mono text-xl font-bold text-white">Upload & Send</h2>
        <p className="text-sm text-muted mt-0.5">Import leads from Excel / CSV and send AI-generated emails</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Total',   value: stats.total,   color: 'text-white' },
          { label: 'Pending', value: stats.pending,  color: 'text-zinc-400' },
          { label: 'Sent',    value: stats.sent,     color: 'text-green-400' },
          { label: 'Failed',  value: stats.failed,   color: 'text-red-400' },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-surface border border-border rounded-xl px-4 py-3">
            <p className="text-xs text-muted uppercase tracking-wider">{label}</p>
            <p className={`text-2xl font-bold mt-1 font-mono ${color}`}>{value}</p>
          </div>
        ))}
      </div>

      {/* Upload zone */}
      <div className="bg-surface border border-border rounded-xl p-4 space-y-3">
        <p className="text-xs font-semibold text-muted uppercase tracking-wider flex items-center gap-1.5">
          <UploadCloud size={12} className="text-primary" /> Upload Sheet
        </p>
        <div
          onDrop={handleDrop}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onClick={() => !uploading && fileInputRef.current?.click()}
          className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all select-none ${
            dragOver
              ? 'border-primary bg-primary/5'
              : 'border-border hover:border-primary/40 hover:bg-white/2'
          } ${uploading ? 'pointer-events-none opacity-60' : ''}`}
        >
          {uploading ? (
            <>
              <Loader2 size={28} className="animate-spin mx-auto mb-2 text-primary" />
              <p className="text-sm text-muted">Importing…</p>
            </>
          ) : (
            <>
              <UploadCloud size={28} className={`mx-auto mb-2 ${dragOver ? 'text-primary' : 'text-muted'}`} />
              <p className={`text-sm font-medium ${dragOver ? 'text-primary' : 'text-white'}`}>
                Drop .xlsx or .csv here, or click to browse
              </p>
              <p className="text-xs text-muted mt-1.5">
                Expected columns:{' '}
                <span className="font-mono text-zinc-300">company_name · email · type · remarks</span>
              </p>
            </>
          )}
        </div>
        <input ref={fileInputRef} type="file" accept=".xlsx,.csv" className="hidden" onChange={handleFileChange} />
      </div>

      {/* Filter row */}
      <div className="flex flex-wrap items-center gap-2">
        {['all', 'pending', 'sent', 'failed'].map((f) => (
          <button
            key={f}
            onClick={() => setStatusFilter(f)}
            className={`px-3 py-1.5 rounded-lg text-xs capitalize transition-all ${
              statusFilter === f
                ? 'bg-primary/10 border border-primary/30 text-primary'
                : 'bg-white/5 border border-border text-muted hover:text-white'
            }`}
          >
            {f}
            {f !== 'all' && (
              <span className="ml-1 opacity-60">({stats[f]})</span>
            )}
          </button>
        ))}

        {batches.length > 0 && (
          <div className="flex items-center gap-1.5 ml-2">
            <select
              value={batchFilter}
              onChange={(e) => setBatchFilter(e.target.value)}
              className="bg-bg border border-border rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-primary transition-colors max-w-[200px] truncate"
            >
              <option value="">All batches</option>
              {batches.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
            {batchFilter && (
              <button
                onClick={() => handleDeleteBatch(batchFilter)}
                className="flex items-center gap-1 px-2 py-1.5 bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20 rounded-lg text-xs transition-all"
              >
                <Trash2 size={11} /> Delete
              </button>
            )}
          </div>
        )}

        <button
          onClick={loadLeads}
          disabled={loading}
          className="ml-auto flex items-center gap-1.5 px-3 py-1.5 bg-white/5 border border-border rounded-lg text-xs text-muted hover:text-white transition-all disabled:opacity-40"
        >
          {loading ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
          Refresh
        </button>
      </div>

      {/* Bulk action toolbar */}
      {selectedIds.size > 0 && (
        <div className="bg-primary/5 border border-primary/20 rounded-xl p-3 flex flex-wrap items-center gap-3">
          <span className="text-sm text-primary font-medium">
            {selectedIds.size} lead{selectedIds.size !== 1 ? 's' : ''} selected
          </span>
          <div className="flex items-center gap-2 ml-auto flex-wrap">
            <button
              onClick={handleGenerate}
              disabled={generating || sending}
              className="flex items-center gap-2 px-4 py-2 bg-purple-500/10 border border-purple-500/30 text-purple-400 hover:bg-purple-500/20 rounded-lg text-sm font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {generating ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
              Generate Emails
            </button>
            {previewCount > 0 && (
              <button
                onClick={() => setShowModal(true)}
                className="px-4 py-2 bg-purple-500/5 border border-purple-500/20 text-purple-300 hover:bg-purple-500/10 rounded-lg text-sm font-medium transition-all"
              >
                Review ({previewCount})
              </button>
            )}
            <button
              onClick={() => handleSend(false)}
              disabled={generating || sending}
              className="flex items-center gap-2 px-4 py-2 bg-green-500/10 border border-green-500/30 text-green-400 hover:bg-green-500/20 rounded-lg text-sm font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {sending ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
              Send Emails
            </button>
            <button
              onClick={() => { setSelectedIds(new Set()); setPreviews({}); }}
              className="px-3 py-2 bg-white/5 border border-border text-muted hover:text-white rounded-lg text-sm transition-all"
            >
              Clear
            </button>
          </div>
        </div>
      )}

      {/* Leads table */}
      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 size={28} className="animate-spin text-primary" />
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-center text-muted py-16 text-sm">
            {leads.length === 0
              ? 'No leads uploaded yet. Import a file above.'
              : 'No leads match the current filter.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted text-xs uppercase tracking-wider border-b border-border bg-bg/50">
                  <th className="px-4 py-3">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={(e) => handleSelectAll(e.target.checked)}
                      className="accent-primary w-3.5 h-3.5 cursor-pointer"
                    />
                  </th>
                  <th className="px-5 py-3">Company</th>
                  <th className="px-5 py-3">Email</th>
                  <th className="px-5 py-3">Industry</th>
                  <th className="px-5 py-3">Remarks</th>
                  <th className="px-5 py-3">Email Status</th>
                  <th className="px-5 py-3">Sent At</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map((lead) => (
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
                    <td className="px-5 py-3 text-white font-medium max-w-[160px] truncate">
                      {lead.company_name}
                    </td>
                    <td className="px-5 py-3 text-muted text-xs">{lead.email || '—'}</td>
                    <td className="px-5 py-3 text-muted text-xs">{lead.industry_type || '—'}</td>
                    <td
                      className="px-5 py-3 text-muted text-xs max-w-[180px] truncate"
                      title={lead.remarks || ''}
                    >
                      {lead.remarks
                        ? (lead.remarks.length > 45 ? lead.remarks.slice(0, 45) + '…' : lead.remarks)
                        : '—'}
                    </td>
                    <td className="px-5 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded-full border ${EMAIL_STATUS_COLORS[lead.email_status || 'pending']}`}>
                        {lead.email_status || 'pending'}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-muted text-xs whitespace-nowrap">
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
  );
}
