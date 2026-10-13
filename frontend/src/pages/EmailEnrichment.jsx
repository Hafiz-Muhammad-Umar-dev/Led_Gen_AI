import React, { useState, useRef, useEffect, useMemo } from 'react';
import {
  UploadCloud, Loader2, X, Download, Mail, Phone, CheckCircle2, MinusCircle,
} from 'lucide-react';
import { enrichSheetStream } from '../services/api';

const STATUS_STYLE = {
  found:      'bg-green-500/10 text-green-400 border-green-500/20',
  not_found:  'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
  no_website: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
};

const STATUS_LABEL = {
  found: 'Found',
  not_found: 'Nothing found',
  no_website: 'No website',
};

const csvCell = (value) => {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export default function EmailEnrichment() {
  const [rows, setRows] = useState([]);          // { index, company_name, industry, website, email, phone, status }
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [running, setRunning] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [toast, setToast] = useState(null);
  const fileInputRef = useRef(null);
  const abortRef = useRef(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const showToast = (msg, type = 'error') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  };

  const sortedRows = useMemo(
    () => [...rows].sort((a, b) => a.index - b.index),
    [rows]
  );

  const stats = useMemo(() => ({
    total:  rows.length,
    emails: rows.filter((r) => r.email).length,
    phones: rows.filter((r) => r.phone).length,
  }), [rows]);

  const handleFileChange = (e) => {
    const file = e.target.files[0];
    if (file) startEnrichment(file);
    e.target.value = '';
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) startEnrichment(file);
  };

  const startEnrichment = async (file) => {
    if (running) return;
    if (!file.name.match(/\.(csv|xlsx)$/i)) {
      showToast('Only .csv or .xlsx files are supported.');
      return;
    }

    setRows([]);
    setProgress({ done: 0, total: 0 });
    setRunning(true);

    const { promise, controller } = enrichSheetStream(file);
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

          if (data.type === 'start') {
            setProgress({ done: 0, total: data.total });
          } else if (data.type === 'row') {
            setRows((prev) => [...prev, data]);
            setProgress({ done: data.done, total: data.total });
          } else if (data.type === 'complete') {
            setRunning(false);
            showToast('Enrichment complete.', 'success');
          } else if (data.type === 'error') {
            showToast(data.message || 'Enrichment failed.');
            setRunning(false);
          }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') showToast(err.message || 'Connection error');
    } finally {
      setRunning(false);
    }
  };

  const handleDownload = () => {
    if (sortedRows.length === 0) return;
    const header = ['company_name', 'industry', 'website', 'email', 'phone', 'status'];
    const lines = [
      header.join(','),
      ...sortedRows.map((r) =>
        [r.company_name, r.industry, r.website, r.email, r.phone, r.status].map(csvCell).join(',')
      ),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `enriched_leads_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const pct = progress.total ? (progress.done / progress.total) * 100 : 0;

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
      <div>
        <h2 className="font-mono text-xl font-bold text-white">Email Enrichment</h2>
        <p className="text-sm text-muted mt-0.5">
          Upload a CSV of companies with a website column — the system visits each site and pulls
          the email and phone number, then hands you back a downloadable sheet.
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Rows',          value: stats.total,  color: 'text-white' },
          { label: 'Emails found',  value: stats.emails, color: 'text-green-400' },
          { label: 'Phones found',  value: stats.phones, color: 'text-blue-400' },
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
          <UploadCloud size={12} className="text-primary" /> Upload Company Sheet
        </p>
        <div
          onDrop={handleDrop}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onClick={() => !running && fileInputRef.current?.click()}
          className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all select-none ${
            dragOver ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40 hover:bg-white/2'
          } ${running ? 'pointer-events-none opacity-60' : ''}`}
        >
          {running ? (
            <>
              <Loader2 size={28} className="animate-spin mx-auto mb-2 text-primary" />
              <p className="text-sm text-muted">
                Enriching {progress.done}/{progress.total}…
              </p>
            </>
          ) : (
            <>
              <UploadCloud size={28} className={`mx-auto mb-2 ${dragOver ? 'text-primary' : 'text-muted'}`} />
              <p className={`text-sm font-medium ${dragOver ? 'text-primary' : 'text-white'}`}>
                Drop .csv or .xlsx here, or click to browse
              </p>
              <p className="text-xs text-muted mt-1.5">
                Expected columns:{' '}
                <span className="font-mono text-zinc-300">company_name · industry · website</span>
                {' '}(industry optional)
              </p>
            </>
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.xlsx"
          className="hidden"
          onChange={handleFileChange}
        />

        {(running || progress.total > 0) && (
          <div className="space-y-1.5">
            <div className="w-full h-2 rounded-full bg-bg overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-primary to-secondary transition-all duration-300"
                style={{ width: `${pct}%` }}
              />
            </div>
            <p className="text-xs text-muted">
              {running ? `Processing ${progress.done}/${progress.total}…` : `Done — ${progress.done}/${progress.total} rows processed.`}
            </p>
          </div>
        )}
      </div>

      {/* Results */}
      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <span className="text-sm font-semibold text-white">
            Enriched Results {sortedRows.length > 0 && <span className="text-muted">({sortedRows.length})</span>}
          </span>
          <button
            onClick={handleDownload}
            disabled={sortedRows.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-primary/10 border border-primary/30 text-primary hover:bg-primary/20 rounded-lg text-xs font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Download size={12} /> Download CSV
          </button>
        </div>

        {sortedRows.length === 0 ? (
          <p className="text-center text-muted py-16 text-sm">
            No results yet. Upload a sheet above to start enriching.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted text-xs uppercase tracking-wider border-b border-border bg-bg/50">
                  <th className="px-5 py-3">Company</th>
                  <th className="px-5 py-3">Industry</th>
                  <th className="px-5 py-3">Website</th>
                  <th className="px-5 py-3">Email</th>
                  <th className="px-5 py-3">Phone</th>
                  <th className="px-5 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {sortedRows.map((r) => (
                  <tr key={r.index} className="hover:bg-white/2 transition-colors">
                    <td className="px-5 py-3 text-white font-medium max-w-[180px] truncate" title={r.company_name}>
                      {r.company_name || '—'}
                    </td>
                    <td className="px-5 py-3 text-muted text-xs max-w-[140px] truncate" title={r.industry}>
                      {r.industry || '—'}
                    </td>
                    <td className="px-5 py-3 text-muted text-xs max-w-[180px] truncate">
                      {r.website
                        ? <a href={r.website.match(/^https?:\/\//) ? r.website : `https://${r.website}`}
                             target="_blank" rel="noreferrer"
                             className="hover:text-primary transition-colors">{r.website}</a>
                        : '—'}
                    </td>
                    <td className="px-5 py-3 text-xs">
                      {r.email
                        ? <span className="inline-flex items-center gap-1 text-green-400"><Mail size={11} />{r.email}</span>
                        : <span className="text-muted">—</span>}
                    </td>
                    <td className="px-5 py-3 text-xs">
                      {r.phone
                        ? <span className="inline-flex items-center gap-1 text-blue-400"><Phone size={11} />{r.phone}</span>
                        : <span className="text-muted">—</span>}
                    </td>
                    <td className="px-5 py-3">
                      <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border ${STATUS_STYLE[r.status] || STATUS_STYLE.not_found}`}>
                        {r.status === 'found' ? <CheckCircle2 size={11} /> : <MinusCircle size={11} />}
                        {STATUS_LABEL[r.status] || r.status}
                      </span>
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
