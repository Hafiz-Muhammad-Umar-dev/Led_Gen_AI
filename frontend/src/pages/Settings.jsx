import React, { useState, useEffect } from 'react';
import {
  Save, Eye, EyeOff, Loader2, CheckCircle, XCircle, X,
  Mail, Map, Bot, Building2, Clock, MessageCircle,
} from 'lucide-react';
import {
  getSettings, updateSettings, testEmail, testMaps, testGroq,
  getWhatsappStatus, connectWhatsapp, logoutWhatsapp,
} from '../services/api';

function Section({ title, icon: Icon, children }) {
  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden">
      <div className="flex items-center gap-2 px-6 py-4 border-b border-border">
        <Icon size={16} className="text-primary" />
        <h3 className="font-mono text-sm font-bold text-white">{title}</h3>
      </div>
      <div className="p-6 space-y-4">{children}</div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label className="block text-xs text-muted mb-1.5">{label}</label>
      {children}
    </div>
  );
}

function Input({ type = 'text', ...props }) {
  return (
    <input
      type={type}
      {...props}
      className="w-full bg-bg border border-border rounded-lg px-3 py-2.5 text-sm text-white placeholder-muted focus:outline-none focus:border-primary transition-colors"
    />
  );
}

function SecretInput({ value, onChange, placeholder }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input
        type={show ? 'text' : 'password'}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        className="w-full bg-bg border border-border rounded-lg px-3 py-2.5 pr-10 text-sm text-white placeholder-muted focus:outline-none focus:border-primary transition-colors"
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-white transition-colors"
      >
        {show ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
    </div>
  );
}

function TestButton({ label, onTest }) {
  const [state, setState] = useState('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const run = async () => {
    setState('loading');
    setErrorMsg('');
    try {
      await onTest();
      setState('success');
    } catch (err) {
      setState('error');
      const detail = err.response?.data?.detail;
      setErrorMsg(
        Array.isArray(detail)
          ? detail.map((e) => e.msg).join(', ')
          : detail || err.message || 'Failed'
      );
    } finally {
      setTimeout(() => setState('idle'), 6000);
    }
  };

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={run}
        disabled={state === 'loading'}
        className={`flex items-center gap-2 px-4 py-2 rounded-lg border text-xs font-medium transition-all disabled:opacity-60 ${
          state === 'success'
            ? 'border-green-500/40 bg-green-500/10 text-green-400'
            : state === 'error'
            ? 'border-red-500/40 bg-red-500/10 text-red-400'
            : 'border-border bg-white/5 text-muted hover:text-white hover:border-primary/40'
        }`}
      >
        {state === 'loading' && <Loader2 size={13} className="animate-spin" />}
        {state === 'success' && <CheckCircle size={13} />}
        {state === 'error' && <XCircle size={13} />}
        {state === 'loading' ? 'Testing…' : state === 'success' ? 'Success!' : state === 'error' ? 'Failed' : label}
      </button>
      {state === 'error' && errorMsg && (
        <p className="text-xs text-red-400 font-mono break-all">{errorMsg}</p>
      )}
    </div>
  );
}

const WA_STATUS_LABEL = {
  connected: 'Connected',
  qr: 'Scan the QR code to connect',
  connecting: 'Connecting…',
  disconnected: 'Not connected',
  unavailable: 'WhatsApp service is not running',
};

function WhatsAppSection() {
  const [status, setStatus] = useState('disconnected');
  const [qr, setQr] = useState(null);
  const [number, setNumber] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [busy, setBusy] = useState(false);

  const fetchStatus = async () => {
    try {
      const res = await getWhatsappStatus();
      const data = res.data?.data || {};
      setStatus(data.status || 'disconnected');
      setQr(data.qr || null);
      setNumber(data.connectedNumber || null);
      return data;
    } catch {
      setStatus('unavailable');
      return null;
    }
  };

  useEffect(() => {
    fetchStatus();
  }, []);

  useEffect(() => {
    if (!showModal) return undefined;
    const interval = setInterval(async () => {
      const data = await fetchStatus();
      if (data?.status === 'connected') setShowModal(false);
    }, 2000);
    return () => clearInterval(interval);
  }, [showModal]);

  const handleScan = async () => {
    setBusy(true);
    try {
      await connectWhatsapp();
      setShowModal(true);
      await fetchStatus();
    } catch (err) {
      await fetchStatus();
    } finally {
      setBusy(false);
    }
  };

  const handleLogout = async () => {
    setBusy(true);
    try {
      await logoutWhatsapp();
      await fetchStatus();
    } finally {
      setBusy(false);
    }
  };

  const connected = status === 'connected';

  return (
    <Section title="WhatsApp" icon={MessageCircle}>
      <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-medium ${
        connected
          ? 'bg-green-500/10 border-green-500/20 text-green-400'
          : 'bg-red-500/10 border-red-500/20 text-red-400'
      }`}>
        {connected ? <CheckCircle size={13} /> : <XCircle size={13} />}
        {connected && number ? `Connected as +${number}` : WA_STATUS_LABEL[status] || 'Not connected'}
      </div>

      {connected ? (
        <button
          type="button"
          onClick={handleLogout}
          disabled={busy}
          className="flex items-center gap-2 px-4 py-2 rounded-lg border border-border bg-white/5 text-xs font-medium text-muted hover:text-white hover:border-red-500/40 transition-all disabled:opacity-60"
        >
          {busy && <Loader2 size={13} className="animate-spin" />}
          Disconnect
        </button>
      ) : (
        <button
          type="button"
          onClick={handleScan}
          disabled={busy || status === 'unavailable'}
          className="flex items-center gap-2 px-4 py-2 rounded-lg border border-border bg-white/5 text-xs font-medium text-muted hover:text-white hover:border-primary/40 transition-all disabled:opacity-60"
        >
          {busy && <Loader2 size={13} className="animate-spin" />}
          Scan QR to Connect
        </button>
      )}

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div className="bg-surface border border-border rounded-xl p-6 max-w-sm w-full space-y-4">
            <div className="flex items-center justify-between">
              <h4 className="font-mono text-sm font-bold text-white">Scan with WhatsApp</h4>
              <button type="button" onClick={() => setShowModal(false)}>
                <X size={16} className="text-muted hover:text-white" />
              </button>
            </div>
            <div className="flex items-center justify-center bg-white rounded-lg p-4 h-64">
              {qr ? (
                <img src={qr} alt="WhatsApp QR code" className="w-56 h-56" />
              ) : (
                <Loader2 size={28} className="animate-spin text-primary" />
              )}
            </div>
            <p className="text-xs text-muted text-center">
              Open WhatsApp on your phone → Settings → Linked Devices → Link a Device, then scan this code.
            </p>
          </div>
        </div>
      )}
    </Section>
  );
}

const DEFAULT_TEMPLATE = `Dear {business_name},

I hope this message finds you well. I noticed your {category} business and wanted to reach out about how our automation and AI services at Industronics could help streamline your operations.

We specialize in providing cutting-edge solutions that save time and reduce costs for businesses like yours.

Would you be open to a brief call this week to explore how we can help?

Best regards,
{company_name}`;

export default function Settings() {
  const [form, setForm] = useState({
    groq_api_key: '',
    maps_api_key: '',
    schedule_days: 4,
    email_template: DEFAULT_TEMPLATE,
    company_name: 'Industronics',
    company_service: 'Automation, Instrumentation, Software, and AI Services',
  });
  const [smtp, setSmtp] = useState({ host: '', port: '', user: '', configured: false });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  useEffect(() => {
    getSettings()
      .then((res) => {
        const data = res.data?.data;
        if (data) {
          setForm((prev) => ({ ...prev, ...data }));
          setSmtp({
            host: data.smtp_host || '',
            port: data.smtp_port || '',
            user: data.smtp_user || '',
            configured: data.smtp_configured || false,
          });
        }
      })
      .catch((err) => console.error('Settings load error:', err))
      .finally(() => setLoading(false));
  }, []);

  const set = (key) => (e) => setForm((p) => ({ ...p, [key]: e.target.value }));

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await updateSettings(form);
      showToast('Settings saved successfully.');
    } catch (err) {
      showToast(err.response?.data?.detail || 'Save failed.', 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 size={28} className="animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-5 max-w-3xl">
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

      <div>
        <h2 className="font-mono text-xl font-bold text-white">Settings</h2>
        <p className="text-sm text-muted mt-0.5">Configure API keys, SMTP, and email templates</p>
      </div>

      <form onSubmit={handleSave} className="space-y-5">
        {/* SMTP */}
        <Section title="SMTP" icon={Mail}>
          <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-medium ${
            smtp.configured
              ? 'bg-green-500/10 border-green-500/20 text-green-400'
              : 'bg-red-500/10 border-red-500/20 text-red-400'
          }`}>
            {smtp.configured ? <CheckCircle size={13} /> : <XCircle size={13} />}
            {smtp.configured ? 'SMTP configured via .env' : 'SMTP not configured — set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD in .env'}
          </div>
          {smtp.configured && (
            <div className="grid grid-cols-3 gap-3">
              <Field label="Host">
                <div className="bg-bg border border-border rounded-lg px-3 py-2.5 text-sm text-zinc-400 font-mono truncate">{smtp.host}</div>
              </Field>
              <Field label="Port">
                <div className="bg-bg border border-border rounded-lg px-3 py-2.5 text-sm text-zinc-400 font-mono">{smtp.port}</div>
              </Field>
              <Field label="User">
                <div className="bg-bg border border-border rounded-lg px-3 py-2.5 text-sm text-zinc-400 font-mono truncate">{smtp.user}</div>
              </Field>
            </div>
          )}
          <TestButton label="Send Test Email" onTest={testEmail} />
        </Section>

        {/* WhatsApp */}
        <WhatsAppSection />

        {/* Google Maps */}
        <Section title="Google Maps API" icon={Map}>
          <Field label="Maps API Key">
            <SecretInput
              placeholder="AIza…"
              value={form.maps_api_key}
              onChange={set('maps_api_key')}
            />
          </Field>
          <TestButton label="Test Maps API" onTest={testMaps} />
        </Section>

        {/* Groq AI */}
        <Section title="Groq AI" icon={Bot}>
          <Field label="Groq API Key">
            <SecretInput
              placeholder="gsk_…"
              value={form.groq_api_key}
              onChange={set('groq_api_key')}
            />
          </Field>
          <TestButton label="Test Groq API" onTest={testGroq} />
        </Section>

        {/* Company Info */}
        <Section title="Company Info" icon={Building2}>
          <Field label="Company Name">
            <Input
              placeholder="Your Company"
              value={form.company_name}
              onChange={set('company_name')}
            />
          </Field>
          <Field label="Service Description">
            <textarea
              value={form.company_service}
              onChange={set('company_service')}
              rows={2}
              placeholder="What services does your company offer?"
              className="w-full bg-bg border border-border rounded-lg px-3 py-2.5 text-sm text-white placeholder-muted focus:outline-none focus:border-primary transition-colors resize-none"
            />
          </Field>
        </Section>

        {/* Schedule */}
        <Section title="Schedule Settings" icon={Clock}>
          <Field label="Days Between Campaign Runs">
            <Input
              type="number"
              min="1"
              max="30"
              value={form.schedule_days}
              onChange={set('schedule_days')}
            />
          </Field>
          <p className="text-xs text-muted">
            Active campaigns run automatically every {form.schedule_days} day{form.schedule_days !== 1 ? 's' : ''}.
          </p>
        </Section>

        {/* Email Template */}
        <Section title="Email Template" icon={Mail}>
          <p className="text-xs text-muted">
            Available variables: <code className="text-primary">{'{business_name}'}</code>,{' '}
            <code className="text-primary">{'{category}'}</code>,{' '}
            <code className="text-primary">{'{company_name}'}</code>
          </p>
          <Field label="Template Body">
            <textarea
              value={form.email_template}
              onChange={set('email_template')}
              rows={10}
              className="w-full bg-bg border border-border rounded-lg px-3 py-2.5 text-sm text-white placeholder-muted focus:outline-none focus:border-primary transition-colors resize-y font-mono"
            />
          </Field>
        </Section>

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={saving}
            className="flex items-center gap-2 px-6 py-2.5 rounded-lg bg-gradient-to-r from-primary to-secondary text-white text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-60"
          >
            {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
            {saving ? 'Saving…' : 'Save Settings'}
          </button>
        </div>
      </form>
    </div>
  );
}
