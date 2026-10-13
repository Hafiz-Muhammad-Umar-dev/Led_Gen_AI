import React from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  Users,
  Megaphone,
  Settings,
  Zap,
  Wifi,
  WifiOff,
  FolderUp,
  LogOut,
  Package,
  Layers,
  MessageCircle,
  Sparkles,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';

const navItems = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/leads', icon: Users, label: 'Leads' },
  { to: '/campaigns', icon: Megaphone, label: 'Campaigns' },
  { to: '/products', icon: Layers, label: 'Products' },
  { to: '/product-campaigns', icon: Package, label: 'Product Campaigns' },
  { to: '/whatsapp-outreach', icon: MessageCircle, label: 'WhatsApp Outreach' },
  { to: '/uploads', icon: FolderUp, label: 'Upload & Send' },
  { to: '/email-enrichment', icon: Sparkles, label: 'Email Enrichment' },
  { to: '/settings', icon: Settings, label: 'Settings' },
];


export default function Sidebar({ apiConnected }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login', { replace: true });
  };

  return (
    <aside className="w-64 bg-surface border-r border-border flex flex-col shrink-0">
      {/* Logo */}
      <div className="px-6 py-6 border-b border-border">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-primary to-secondary flex items-center justify-center">
            <Zap size={18} className="text-white" />
          </div>
          <div>
            <h1 className="font-mono text-sm font-bold text-white leading-tight">LeadGen AI</h1>
            <p className="text-xs text-muted leading-tight">by Industronics</p>
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-1">
        {navItems.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-all duration-200 ${
                isActive
                  ? 'bg-primary/10 text-primary border border-primary/20'
                  : 'text-muted hover:text-white hover:bg-white/5'
              }`
            }
          >
            {({ isActive }) => (
              <>
                <Icon size={18} className={isActive ? 'text-primary' : ''} />
                <span>{label}</span>
                {isActive && (
                  <span className="ml-auto w-1.5 h-1.5 rounded-full bg-primary" />
                )}
              </>
            )}
          </NavLink>
        ))}
      </nav>

      {/* User + Logout */}
      <div className="px-3 py-3 border-t border-border">
        <div className="flex items-center gap-3 px-3 py-2 mb-1">
          <div className="w-7 h-7 rounded-full bg-primary/20 flex items-center justify-center shrink-0">
            <span className="text-xs font-bold text-primary uppercase">
              {user?.username?.[0] ?? '?'}
            </span>
          </div>
          <span className="text-sm text-white truncate flex-1">{user?.username ?? 'User'}</span>
        </div>
        <button
          onClick={handleLogout}
          className="w-full flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium text-muted hover:text-red-400 hover:bg-red-500/10 transition-all duration-200"
        >
          <LogOut size={16} />
          <span>Sign out</span>
        </button>
      </div>

      {/* Status indicator */}
      <div className="px-6 py-4 border-t border-border">
        <div className="flex items-center gap-2">
          {apiConnected === null ? (
            <>
              <div className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse" />
              <span className="text-xs text-muted">Connecting…</span>
            </>
          ) : apiConnected ? (
            <>
              <Wifi size={14} className="text-green-400" />
              <span className="text-xs text-green-400">API Connected</span>
            </>
          ) : (
            <>
              <WifiOff size={14} className="text-red-400" />
              <span className="text-xs text-red-400">API Offline</span>
            </>
          )}
        </div>
        <p className="text-xs text-muted mt-1">localhost:8000</p>
      </div>
    </aside>
  );
}
