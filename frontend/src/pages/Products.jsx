import React, { useState, useEffect, useRef } from 'react';
import { Plus, Loader2, X, Paperclip, Pencil, Trash2, Layers } from 'lucide-react';
import { getProducts, createProduct, updateProduct, deleteProduct } from '../services/productsApi';

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

const EMPTY_FORM = { name: '', pitch_angle: '', attachment: null };

// Attachment constraints — must match the backend (products route).
const ATTACHMENT_ACCEPT = '.pdf,.png,.jpg,.jpeg,.gif,.webp';
const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

export default function Products() {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null); // product being edited, or null for create
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef(null);
  const [actionLoading, setActionLoading] = useState({});
  const [toast, setToast] = useState(null);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const load = async () => {
    setLoading(true);
    try {
      const res = await getProducts();
      setProducts(res.data?.data || []);
    } catch (err) {
      console.error('Products load error:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setShowModal(true);
  };

  const openEdit = (product) => {
    setEditing(product);
    setForm({ name: product.name, pitch_angle: product.pitch_angle, attachment: null });
    setShowModal(true);
  };

  const closeModal = () => {
    setShowModal(false);
    setEditing(null);
    setForm(EMPTY_FORM);
    if (fileRef.current) fileRef.current.value = '';
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
    if (fileRef.current) fileRef.current.value = '';
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      if (editing) {
        await updateProduct(editing.id, form);
        showToast('Product updated.');
      } else {
        await createProduct(form);
        showToast('Product created.');
      }
      closeModal();
      load();
    } catch (err) {
      showToast(err.response?.data?.detail || 'Save failed.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (product) => {
    if (!window.confirm(`Delete "${product.name}"? Campaigns already created from it keep working.`)) return;
    setActionLoading((p) => ({ ...p, [product.id]: true }));
    try {
      await deleteProduct(product.id);
      setProducts((prev) => prev.filter((p) => p.id !== product.id));
      showToast('Product deleted.');
    } catch {
      showToast('Failed to delete product.', 'error');
    } finally {
      setActionLoading((p) => ({ ...p, [product.id]: false }));
    }
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
          <h2 className="font-mono text-xl font-bold text-white">Products</h2>
          <p className="text-sm text-muted mt-0.5">
            {products.length} ready-made solutions — pick one when creating a Product Campaign
          </p>
        </div>
        <button
          onClick={openCreate}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-gradient-to-r from-primary to-secondary text-white text-sm font-semibold hover:opacity-90 transition-opacity"
        >
          <Plus size={16} /> New Product
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-20">
          <Loader2 size={28} className="animate-spin text-primary" />
        </div>
      ) : products.length === 0 ? (
        <div className="text-center py-20">
          <p className="text-muted text-sm">No products yet.</p>
          <p className="text-muted text-xs mt-1">
            Save a product's pitch angle and doc once (e.g. CMMS), then reuse it across campaigns.
          </p>
          <button
            onClick={openCreate}
            className="mt-4 px-4 py-2 rounded-lg border border-primary/30 text-primary text-sm hover:bg-primary/10 transition-colors"
          >
            Create your first product
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {products.map((p) => (
            <div key={p.id} className="bg-surface border border-border rounded-xl p-5 space-y-3 hover:border-primary/30 transition-colors">
              <div className="flex items-start justify-between gap-2">
                <h3 className="font-mono text-sm font-bold text-white truncate flex items-center gap-1.5">
                  <Layers size={13} className="text-primary shrink-0" /> {p.name}
                </h3>
              </div>
              <p className="text-xs text-muted line-clamp-3" title={p.pitch_angle}>{p.pitch_angle}</p>
              {p.attachment_filename && (
                <div className="flex items-center gap-2 text-xs text-primary">
                  <Paperclip size={11} className="shrink-0" />
                  <span className="truncate" title={p.attachment_filename}>{p.attachment_filename}</span>
                </div>
              )}
              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={() => openEdit(p)}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg border border-border hover:border-primary/40 text-xs text-muted hover:text-white transition-all"
                >
                  <Pencil size={12} /> Edit
                </button>
                <button
                  onClick={() => handleDelete(p)}
                  disabled={actionLoading[p.id]}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg border border-border hover:border-red-500/40 text-xs text-muted hover:text-red-400 transition-all disabled:opacity-50"
                >
                  {actionLoading[p.id] ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showModal && (
        <Modal title={editing ? 'Edit Product' : 'New Product'} onClose={closeModal}>
          <form onSubmit={handleSave} className="space-y-4">
            <div>
              <label className="block text-xs text-muted mb-1">Name</label>
              <input
                required
                type="text"
                placeholder="e.g. CMMS"
                value={form.name}
                onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                className="w-full bg-bg border border-border rounded-lg px-3 py-2.5 text-sm text-white placeholder-muted focus:outline-none focus:border-primary transition-colors"
              />
            </div>
            <div>
              <label className="block text-xs text-muted mb-1">Pitch Angle</label>
              <textarea
                required
                rows={6}
                placeholder="Write exactly how you want to pitch this product. Include the main problem it solves, what makes it different, and the key benefit. AI will use this to write every email."
                value={form.pitch_angle}
                onChange={(e) => setForm((p) => ({ ...p, pitch_angle: e.target.value }))}
                className="w-full bg-bg border border-border rounded-lg px-3 py-2.5 text-sm text-white placeholder-muted focus:outline-none focus:border-primary transition-colors resize-y"
              />
            </div>
            <div>
              <label className="block text-xs text-muted mb-1">
                Attachment <span className="text-muted/60">(optional — PDF or image)</span>
              </label>
              <input
                ref={fileRef}
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
                  onClick={() => fileRef.current?.click()}
                  className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg border border-dashed border-border text-sm text-muted hover:text-primary hover:border-primary/40 transition-all"
                >
                  <Paperclip size={14} />
                  {editing?.attachment_filename ? `Replace "${editing.attachment_filename}"` : 'Attach a PDF or image'}
                </button>
              )}
              <p className="text-xs text-muted/60 mt-1">
                {editing && editing.attachment_filename && !form.attachment
                  ? `Keeping the current file (${editing.attachment_filename}) unless you attach a new one. Max 10 MB.`
                  : 'Reused by every campaign created from this product. Max 10 MB.'}
              </p>
            </div>
            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={closeModal}
                className="flex-1 py-2.5 rounded-lg border border-border text-sm text-muted hover:text-white hover:border-white/20 transition-all"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="flex-1 py-2.5 rounded-lg bg-gradient-to-r from-primary to-secondary text-white text-sm font-semibold flex items-center justify-center gap-2 hover:opacity-90 transition-opacity disabled:opacity-60"
              >
                {saving ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
                {editing ? 'Save Changes' : 'Create Product'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
