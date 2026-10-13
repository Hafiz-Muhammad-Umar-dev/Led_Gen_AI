import React, { useState, useEffect, useRef } from 'react';
import {
  Users, Mail, TrendingUp, Megaphone, Search, Loader2, RefreshCw,
  CheckCircle2, SkipForward, AlertCircle, Radio, Package, X, ChevronRight,
  ChevronLeft, ChevronsRight, Clock, XCircle,
} from 'lucide-react';
import { getLeads, getCampaigns, getCampaignLogs, getDashboardStats, scrapePlaywrightStream } from '../services/api';
import { getProductCampaigns, getProductCampaignLogs } from '../services/productCampaignsApi';

const STATUS_COLORS = {
  new: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  contacted: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
  replied: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  converted: 'bg-green-500/10 text-green-400 border-green-500/20',
};

const CAMPAIGN_STATUS_COLORS = {
  active: 'text-green-400 border-green-500/30 bg-green-500/10',
  paused: 'text-yellow-400 border-yellow-500/30 bg-yellow-500/10',
  completed: 'text-muted border-border bg-white/5',
};

function MetricCard({ icon: Icon, label, value, color = 'primary' }) {
  const colorMap = {
    primary: 'from-primary/20 to-primary/5 border-primary/20 text-primary',
    secondary: 'from-secondary/20 to-secondary/5 border-secondary/20 text-secondary',
    green: 'from-green-500/20 to-green-500/5 border-green-500/20 text-green-400',
    yellow: 'from-yellow-500/20 to-yellow-500/5 border-yellow-500/20 text-yellow-400',
  };
  return (
    <div className={`bg-gradient-to-br ${colorMap[color]} border rounded-xl p-5`}>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs text-muted uppercase tracking-wider mb-1">{label}</p>
          <p className="text-3xl font-mono font-bold text-white">{value ?? '—'}</p>
        </div>
        <div className="p-2.5 rounded-lg bg-current/10">
          <Icon size={20} className="opacity-80" />
        </div>
      </div>
    </div>
  );
}

function LogRow({ entry, index }) {
  const isLead = entry.type === 'lead';
  const isSkip = entry.type === 'skip';
  const isError = entry.type === 'error';

  return (
    <div
      className={`flex items-start gap-3 px-4 py-2.5 border-b border-border/40 text-xs font-mono
        ${isLead ? 'bg-green-500/5 hover:bg-green-500/10' : ''}
        ${isSkip ? 'opacity-40' : ''}
        ${isError ? 'bg-red-500/10' : ''}
        transition-colors`}
      style={{ animationDelay: `${index * 20}ms` }}
    >
      {/* Status dot */}
      <span className="mt-0.5 shrink-0">
        {isLead  && <CheckCircle2 size={13} className="text-green-400" />}
        {isSkip  && <SkipForward  size={13} className="text-gray-500" />}
        {isError && <AlertCircle  size={13} className="text-red-400" />}
      </span>

      {/* Content */}
      <div className="flex-1 min-w-0 space-y-0.5">
        <span className={`font-semibold ${isLead ? 'text-white' : 'text-muted'}`}>
          {entry.business_name}
          {isSkip && <span className="ml-2 text-gray-500 font-normal">(already saved)</span>}
          {isError && <span className="ml-2 text-red-400 font-normal">{entry.message}</span>}
        </span>

        {isLead && (
          <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-muted">
            {entry.phone   && <span>tel: <span className="text-slate-300">{entry.phone}</span></span>}
            {entry.email   && <span>email: <span className="text-green-300">{entry.email}</span></span>}
            {entry.website && <span>web: <span className="text-blue-300">{entry.website.replace(/^https?:\/\//, '')}</span></span>}
            {!entry.phone && !entry.email && !entry.website && (
              <span className="italic">no contact info found</span>
            )}
          </div>
        )}
      </div>

      {/* Category */}
      {isLead && entry.category && (
        <span className="shrink-0 text-muted hidden sm:block truncate max-w-[120px]">
          {entry.category}
        </span>
      )}
    </div>
  );
}

function CampaignEmailsModal({ campaign, onClose }) {
  const [logs, setLogs]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(null);

  useEffect(() => {
    const fetchLogs = campaign.kind === 'product'
      ? getProductCampaignLogs(campaign.id)
      : getCampaignLogs(campaign.id);

    fetchLogs
      .then((res) => setLogs((res.data?.data || []).slice(0, 10)))
      .catch(() => setLogs([]))
      .finally(() => setLoading(false));
  }, [campaign.id, campaign.kind]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-surface border border-border rounded-xl w-full max-w-lg max-h-[85vh] shadow-2xl flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
          <div className="min-w-0">
            <h3 className="font-mono text-sm font-bold text-white truncate">{campaign.displayName}</h3>
            <p className="text-xs text-muted mt-0.5">Last 10 emails sent</p>
          </div>
          <button onClick={onClose} className="text-muted hover:text-white transition-colors shrink-0 ml-3">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 overflow-y-auto scrollbar-thin">
          {loading ? (
            <div className="flex justify-center py-10">
              <Loader2 size={22} className="animate-spin text-primary" />
            </div>
          ) : logs.length === 0 ? (
            <p className="text-center text-muted py-10 text-sm">No emails sent yet for this campaign.</p>
          ) : (
            <div className="relative space-y-0">
              {logs.map((log, i) => {
                const isOpen = expanded === log.id;
                const isSent = log.status === 'sent';
                return (
                  <div key={log.id} className="relative pl-8 pb-4 last:pb-0">
                    {/* timeline line */}
                    {i < logs.length - 1 && (
                      <span className="absolute left-[11px] top-6 bottom-0 w-px bg-border" />
                    )}
                    {/* timeline dot */}
                    <span className={`absolute left-0 top-1 flex items-center justify-center w-6 h-6 rounded-full border ${
                      isSent ? 'bg-green-500/10 border-green-500/30 text-green-400' : 'bg-red-500/10 border-red-500/30 text-red-400'
                    }`}>
                      {isSent ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                    </span>

                    <button
                      onClick={() => setExpanded(isOpen ? null : log.id)}
                      className="w-full text-left bg-bg border border-border rounded-lg overflow-hidden hover:border-primary/30 transition-colors"
                    >
                      <div className="p-3">
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-xs text-white font-medium truncate">
                            {log.company_name || 'Unknown'}
                          </p>
                          <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded border capitalize ${
                            isSent ? 'text-green-400 border-green-500/30 bg-green-500/10' : 'text-red-400 border-red-500/30 bg-red-500/10'
                          }`}>
                            {log.status}
                          </span>
                        </div>
                        {log.to_email && (
                          <p className="text-xs text-muted mt-0.5 truncate">{log.to_email}</p>
                        )}
                        {log.subject && (
                          <p className="text-xs text-zinc-300 mt-1 truncate">{log.subject}</p>
                        )}
                        <p className="text-[10px] text-muted/70 mt-1.5 flex items-center gap-1">
                          <Clock size={10} />
                          {log.sent_at ? new Date(log.sent_at).toLocaleString() : '—'}
                        </p>
                      </div>
                      {isOpen && (
                        <div className="border-t border-border px-3 py-2.5 bg-surface">
                          <p className="text-xs text-muted mb-1">Email body</p>
                          <pre className="text-xs text-zinc-300 whitespace-pre-wrap leading-5 font-sans max-h-40 overflow-y-auto scrollbar-thin">
                            {log.body || '—'}
                          </pre>
                        </div>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const CAMPAIGNS_PAGE_SIZE = 10;

function CampaignRow({ campaign, onClick }) {
  const isProduct = campaign.kind === 'product';
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-transparent hover:border-primary/20 hover:bg-white/5 transition-colors text-left group"
    >
      <span className={`shrink-0 p-1.5 rounded-lg ${isProduct ? 'bg-secondary/10 text-secondary' : 'bg-primary/10 text-primary'}`}>
        {isProduct ? <Package size={13} /> : <Megaphone size={13} />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-white font-medium truncate">{campaign.displayName}</p>
        <p className="text-xs text-muted mt-0.5 truncate">
          {isProduct ? campaign.product_name : `${campaign.keyword || ''} · ${campaign.city || ''}`}
        </p>
      </div>
      <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded border capitalize ${CAMPAIGN_STATUS_COLORS[campaign.status] || ''}`}>
        {campaign.status}
      </span>
      <span className="shrink-0 flex items-center gap-1 text-xs text-muted w-12 justify-end">
        <Mail size={11} /> {campaign.sentCount ?? 0}
      </span>
      <ChevronRight size={14} className="shrink-0 text-muted group-hover:text-primary transition-colors" />
    </button>
  );
}

function CampaignListPanel({ title, icon: Icon, items, loading, page, onPageChange, onSelect, emptyLabel }) {
  const totalPages   = Math.max(1, Math.ceil(items.length / CAMPAIGNS_PAGE_SIZE));
  const clampedPage  = Math.min(page, totalPages - 1);
  const pageItems    = items.slice(clampedPage * CAMPAIGNS_PAGE_SIZE, clampedPage * CAMPAIGNS_PAGE_SIZE + CAMPAIGNS_PAGE_SIZE);
  const rangeStart   = items.length === 0 ? 0 : clampedPage * CAMPAIGNS_PAGE_SIZE + 1;
  const rangeEnd     = Math.min(items.length, clampedPage * CAMPAIGNS_PAGE_SIZE + CAMPAIGNS_PAGE_SIZE);

  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden flex flex-col">
      <div className="px-5 py-4 border-b border-border flex items-center justify-between">
        <h3 className="font-mono text-sm font-bold text-white flex items-center gap-2">
          <Icon size={14} className="text-primary" /> {title}
        </h3>
        <span className="text-xs text-muted">{items.length} total</span>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 size={22} className="animate-spin text-primary" />
        </div>
      ) : items.length === 0 ? (
        <p className="text-center text-muted py-12 text-sm">{emptyLabel}</p>
      ) : (
        <div className="p-2 space-y-0.5">
          {pageItems.map((c) => (
            <CampaignRow key={`${c.kind}-${c.id}`} campaign={c} onClick={() => onSelect(c)} />
          ))}
        </div>
      )}

      {items.length > CAMPAIGNS_PAGE_SIZE && (
        <div className="px-4 py-2.5 border-t border-border flex items-center justify-between text-xs text-muted">
          <span>{rangeStart}–{rangeEnd} of {items.length}</span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => onPageChange(Math.max(0, clampedPage - 1))}
              disabled={clampedPage === 0}
              title="Previous 10"
              className="p-1.5 rounded-lg border border-border hover:border-primary/40 hover:text-white disabled:opacity-30 disabled:hover:border-border disabled:hover:text-muted transition-colors"
            >
              <ChevronLeft size={13} />
            </button>
            <button
              onClick={() => onPageChange(Math.min(totalPages - 1, clampedPage + 1))}
              disabled={clampedPage >= totalPages - 1}
              title="Next 10"
              className="p-1.5 rounded-lg border border-border hover:border-primary/40 hover:text-white disabled:opacity-30 disabled:hover:border-border disabled:hover:text-muted transition-colors"
            >
              <ChevronsRight size={13} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Dashboard() {
  const [leads, setLeads]           = useState([]);
  const [campaigns, setCampaigns]   = useState([]);
  const [productCampaigns, setProductCampaigns] = useState([]);
  const [stats, setStats]           = useState({ total_leads: null, emails_sent: null });
  const [loading, setLoading]       = useState(true);
  const [scrapeForm, setScrapeForm] = useState({ keyword: '', city: '' });
  const [scraping, setScraping]     = useState(false);
  const [scrapeMsg, setScrapeMsg]   = useState('');
  const [scrapeLogs, setScrapeLogs] = useState([]);
  const [selectedCampaign, setSelectedCampaign] = useState(null);
  const [campaignPage, setCampaignPage]               = useState(0);
  const [productCampaignPage, setProductCampaignPage] = useState(0);

  const logsBottomRef = useRef(null);
  const esRef         = useRef(null);

  // ── data load ──────────────────────────────────────────────────────────────
  const load = async () => {
    setLoading(true);
    try {
      const [leadsRes, campaignsRes, productCampaignsRes, statsRes] = await Promise.all([
        getLeads(), getCampaigns(), getProductCampaigns(), getDashboardStats(),
      ]);
      setLeads(leadsRes.data?.data || []);
      setCampaigns(campaignsRes.data?.data || []);
      setProductCampaigns(productCampaignsRes.data?.data || []);
      setStats(statsRes.data || { total_leads: null, emails_sent: null });
    } catch (err) {
      console.error('Dashboard load error:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // auto-scroll log panel to bottom whenever a new entry arrives
  useEffect(() => {
    logsBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [scrapeLogs.length]);

  // ── scrape handler ─────────────────────────────────────────────────────────
  const handleScrape = (e) => {
    e.preventDefault();
    if (!scrapeForm.keyword.trim() || !scrapeForm.city.trim()) return;

    // close any existing stream
    if (esRef.current) { esRef.current.close(); esRef.current = null; }

    setScraping(true);
    setScrapeMsg('Connecting…');
    setScrapeLogs([]);

    const combinedQuery = `${scrapeForm.keyword.trim()} ${scrapeForm.city.trim()}`;
    const es = scrapePlaywrightStream(combinedQuery, 20);
    esRef.current = es;

    es.onmessage = (event) => {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }

      if (data.type === 'start' || data.type === 'progress') {
        setScrapeMsg(data.message);

      } else if (data.type === 'lead') {
        setScrapeLogs((prev) => {
          setScrapeMsg(`${prev.filter(l => l.type === 'lead').length + 1} companies found so far…`);
          return [...prev, data];
        });

      } else if (data.type === 'skip') {
        setScrapeLogs((prev) => [...prev, data]);

      } else if (data.type === 'done') {
        setScrapeMsg(data.message);
        setScraping(false);
        es.close();
        esRef.current = null;
        load();

      } else if (data.type === 'error') {
        setScrapeMsg(`Error: ${data.message}`);
        setScraping(false);
        es.close();
        esRef.current = null;
      }
    };

    es.onerror = () => {
      // readyState 2 = CLOSED (normal stream end already handled above)
      if (!esRef.current || es.readyState === EventSource.CLOSED) return;
      setScrapeMsg('Connection lost. Please try again.');
      setScraping(false);
      es.close();
      esRef.current = null;
    };
  };

  // ── derived stats ──────────────────────────────────────────────────────────
  const totalLeads      = stats.total_leads ?? leads.length;
  const emailsSent      = stats.emails_sent ?? leads.filter((l) => l.status !== 'new').length;
  const replied         = leads.filter((l) => ['replied', 'converted'].includes(l.status)).length;
  const replyRate       = totalLeads ? Math.round((replied / totalLeads) * 100) : 0;
  const activeCampaigns = campaigns.filter((c) => c.status === 'active').length;
  const recentLeads     = [...leads].slice(0, 10);

  const savedCount   = scrapeLogs.filter((l) => l.type === 'lead').length;
  const skippedCount = scrapeLogs.filter((l) => l.type === 'skip').length;

  const mappedCampaigns        = campaigns.map((c) => ({ ...c, kind: 'campaign', displayName: c.name, sentCount: c.emails_sent }));
  const mappedProductCampaigns = productCampaigns.map((c) => ({ ...c, kind: 'product', displayName: c.campaign_name, sentCount: c.total_sent }));

  return (
    <div className="p-6 space-y-6">

      {/* ── header ── */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-mono text-xl font-bold text-white">Dashboard</h2>
          <p className="text-sm text-muted mt-0.5">Real-time lead generation overview</p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2 bg-white/5 hover:bg-white/10 border border-border rounded-lg text-sm text-muted hover:text-white transition-all"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* ── metric cards ── */}
      <div className="grid grid-cols-4 gap-4">
        <MetricCard icon={Users}     label="Total Leads"       value={totalLeads}      color="primary" />
        <MetricCard icon={Mail}      label="Emails Sent"       value={emailsSent}      color="secondary" />
        <MetricCard icon={TrendingUp} label="Reply Rate"       value={`${replyRate}%`} color="green" />
        <MetricCard icon={Megaphone} label="Active Campaigns"  value={activeCampaigns} color="yellow" />
      </div>

      {/* ── main row: recent leads + scrape form ── */}
      <div className="grid grid-cols-3 gap-6">

        {/* recent leads table */}
        <div className="col-span-2 bg-surface border border-border rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-border">
            <h3 className="font-mono text-sm font-bold text-white">Recent Leads</h3>
          </div>
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={24} className="animate-spin text-primary" />
            </div>
          ) : recentLeads.length === 0 ? (
            <p className="text-center text-muted py-12 text-sm">No leads yet. Run a scrape to get started.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted text-xs uppercase tracking-wider border-b border-border">
                    <th className="px-5 py-3">Business</th>
                    <th className="px-5 py-3">City</th>
                    <th className="px-5 py-3">Category</th>
                    <th className="px-5 py-3">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {recentLeads.map((lead) => (
                    <tr key={lead.id} className="hover:bg-white/2 transition-colors">
                      <td className="px-5 py-3 text-white font-medium truncate max-w-[180px]">{lead.business_name}</td>
                      <td className="px-5 py-3 text-muted">{lead.city}</td>
                      <td className="px-5 py-3 text-muted truncate max-w-[120px]">{lead.category}</td>
                      <td className="px-5 py-3">
                        <span className={`px-2 py-0.5 rounded border text-xs capitalize ${STATUS_COLORS[lead.status] || ''}`}>
                          {lead.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* scrape form */}
        <div className="bg-surface border border-border rounded-xl p-5">
          <h3 className="font-mono text-sm font-bold text-white mb-4 flex items-center gap-2">
            <Search size={16} className="text-primary" /> Quick Scrape
          </h3>
          <form onSubmit={handleScrape} className="space-y-3">
            <input
              type="text"
              placeholder="Keyword (e.g. HVAC)"
              value={scrapeForm.keyword}
              onChange={(e) => setScrapeForm((p) => ({ ...p, keyword: e.target.value }))}
              disabled={scraping}
              className="w-full bg-bg border border-border rounded-lg px-3 py-2.5 text-sm text-white placeholder-muted focus:outline-none focus:border-primary transition-colors disabled:opacity-50"
            />
            <input
              type="text"
              placeholder="City (e.g. London)"
              value={scrapeForm.city}
              onChange={(e) => setScrapeForm((p) => ({ ...p, city: e.target.value }))}
              disabled={scraping}
              className="w-full bg-bg border border-border rounded-lg px-3 py-2.5 text-sm text-white placeholder-muted focus:outline-none focus:border-primary transition-colors disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={scraping}
              className="w-full py-2.5 rounded-lg bg-gradient-to-r from-primary to-secondary text-white text-sm font-semibold flex items-center justify-center gap-2 hover:opacity-90 transition-opacity disabled:opacity-60"
            >
              {scraping ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
              {scraping ? 'Scraping…' : 'Scrape Now'}
            </button>
          </form>

          {scrapeMsg && (
            <p className={`mt-3 text-xs text-center ${scraping ? 'text-primary' : 'text-muted'}`}>
              {scrapeMsg}
            </p>
          )}
        </div>
      </div>

      {/* ── campaigns overview: side-by-side, 10 at a time ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <CampaignListPanel
          title="Campaigns"
          icon={Megaphone}
          items={mappedCampaigns}
          loading={loading}
          page={campaignPage}
          onPageChange={setCampaignPage}
          onSelect={setSelectedCampaign}
          emptyLabel="No campaigns yet."
        />
        <CampaignListPanel
          title="Product Campaigns"
          icon={Package}
          items={mappedProductCampaigns}
          loading={loading}
          page={productCampaignPage}
          onPageChange={setProductCampaignPage}
          onSelect={setSelectedCampaign}
          emptyLabel="No product campaigns yet."
        />
      </div>

      {/* ── live scrape feed (always visible once a scrape has run) ── */}
      {(scraping || scrapeLogs.length > 0) && (
        <div className="bg-surface border border-border rounded-xl overflow-hidden">

          {/* feed header */}
          <div className="px-5 py-3 border-b border-border flex items-center justify-between bg-black/20">
            <div className="flex items-center gap-3">
              {scraping ? (
                <span className="flex items-center gap-2 text-sm font-mono font-bold text-primary">
                  <Radio size={14} className="animate-pulse" />
                  LIVE — scraping "{scrapeForm.keyword} {scrapeForm.city}"
                </span>
              ) : (
                <span className="font-mono text-sm font-bold text-white">
                  Scrape complete
                </span>
              )}
            </div>
            <div className="flex items-center gap-4 text-xs font-mono">
              <span className="text-green-400">{savedCount} saved</span>
              {skippedCount > 0 && <span className="text-muted">{skippedCount} skipped</span>}
              {scraping && <Loader2 size={12} className="animate-spin text-primary" />}
            </div>
          </div>

          {/* column headers */}
          <div className="grid grid-cols-[20px_1fr_auto] gap-3 px-4 py-2 border-b border-border/40 text-xs text-muted uppercase tracking-wider font-mono bg-black/10">
            <span />
            <span>Company / Contact Info</span>
            <span className="hidden sm:block">Category</span>
          </div>

          {/* log rows */}
          <div className="max-h-80 overflow-y-auto">
            {scrapeLogs.length === 0 ? (
              <div className="flex items-center gap-2 px-4 py-6 text-xs text-muted font-mono">
                <Loader2 size={13} className="animate-spin" />
                Launching browser…
              </div>
            ) : (
              scrapeLogs.map((entry, i) => (
                <LogRow key={i} entry={entry} index={i} />
              ))
            )}
            <div ref={logsBottomRef} />
          </div>

          {/* feed footer */}
          {!scraping && scrapeLogs.length > 0 && (
            <div className="px-4 py-2.5 border-t border-border bg-black/10 text-xs text-muted font-mono flex items-center gap-2">
              <CheckCircle2 size={12} className="text-green-400" />
              {savedCount} new lead{savedCount !== 1 ? 's' : ''} saved to database
              {skippedCount > 0 && ` · ${skippedCount} duplicate${skippedCount !== 1 ? 's' : ''} skipped`}
            </div>
          )}
        </div>
      )}

      {selectedCampaign && (
        <CampaignEmailsModal campaign={selectedCampaign} onClose={() => setSelectedCampaign(null)} />
      )}

    </div>
  );
}
