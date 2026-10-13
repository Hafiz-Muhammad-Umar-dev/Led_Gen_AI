import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import Sidebar from './components/Sidebar';
import Dashboard from './pages/Dashboard';
import Leads from './pages/Leads';
import Campaigns from './pages/Campaigns';
import Products from './pages/Products';
import ProductCampaigns from './pages/ProductCampaigns';
import WhatsAppOutreach from './pages/WhatsAppOutreach';
import Settings from './pages/Settings';
import UploadLeads from './pages/UploadLeads';
import EmailEnrichment from './pages/EmailEnrichment';
import Login from './pages/Login';
import Register from './pages/Register';
import { AuthProvider, useAuth } from './context/AuthContext';
import { checkHealth } from './services/api';

function ProtectedLayout() {
  const [apiConnected, setApiConnected] = useState(null);
  const { isAuthenticated } = useAuth();

  useEffect(() => {
    const ping = async () => {
      try {
        await checkHealth();
        setApiConnected(true);
      } catch {
        setApiConnected(false);
      }
    };
    ping();
    const interval = setInterval(ping, 30000);
    return () => clearInterval(interval);
  }, []);

  if (!isAuthenticated) return <Navigate to="/login" replace />;

  return (
    <div className="flex h-screen bg-bg overflow-hidden">
      <Sidebar apiConnected={apiConnected} />
      <main className="flex-1 overflow-y-auto scrollbar-thin">
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/leads" element={<Leads />} />
          <Route path="/campaigns" element={<Campaigns />} />
          <Route path="/products" element={<Products />} />
          <Route path="/product-campaigns" element={<ProductCampaigns />} />
          <Route path="/whatsapp-outreach" element={<WhatsAppOutreach />} />
          <Route path="/uploads" element={<UploadLeads />} />
          <Route path="/email-enrichment" element={<EmailEnrichment />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Router>
        <Routes>
          <Route path="/login" element={<PublicRoute><Login /></PublicRoute>} />
          <Route path="/register" element={<PublicRoute><Register /></PublicRoute>} />
          <Route path="/*" element={<ProtectedLayout />} />
        </Routes>
      </Router>
    </AuthProvider>
  );
}

function PublicRoute({ children }) {
  const { isAuthenticated } = useAuth();
  return isAuthenticated ? <Navigate to="/dashboard" replace /> : children;
}
