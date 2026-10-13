const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require('@whiskeysockets/baileys');

const PORT = process.env.PORT || 3001;
const AUTH_DIR = path.join(__dirname, 'auth_info');
const logger = pino({ level: 'silent' });

const app = express();
app.use(cors());
app.use(express.json());

let sock = null;
let status = 'disconnected'; // disconnected | connecting | qr | connected
let latestQr = null;
let connectedNumber = null;

async function startSocket() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  sock = makeWASocket({
    auth: state,
    logger,
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      status = 'qr';
      QRCode.toDataURL(qr)
        .then((dataUrl) => { latestQr = dataUrl; })
        .catch((err) => console.error('Failed to render QR:', err));
    }

    if (connection === 'open') {
      status = 'connected';
      latestQr = null;
      connectedNumber = sock.user?.id?.split(':')[0] || null;
      console.log('WhatsApp connected as', connectedNumber);
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      sock = null;
      latestQr = null;
      connectedNumber = null;
      status = 'disconnected';

      if (!loggedOut) {
        console.log('WhatsApp connection closed, reconnecting...');
        startSocket().catch((err) => console.error('Reconnect failed:', err));
      } else {
        console.log('WhatsApp logged out.');
      }
    }
  });
}

app.post('/connect', (req, res) => {
  if (status === 'connected') {
    return res.json({ status, connectedNumber, qr: null });
  }
  if (!sock) {
    status = 'connecting';
    startSocket().catch((err) => {
      console.error('Failed to start WhatsApp socket:', err);
      status = 'disconnected';
    });
  }
  res.json({ status, connectedNumber, qr: latestQr });
});

app.get('/status', (req, res) => {
  res.json({ status, connectedNumber, qr: latestQr });
});

app.post('/check-number', async (req, res) => {
  const phone = (req.body?.phone || '').replace(/\D/g, '');
  if (status !== 'connected' || !sock) {
    return res.status(503).json({ error: 'not_connected' });
  }
  if (!phone) {
    return res.status(400).json({ error: 'invalid_phone' });
  }
  try {
    const results = await sock.onWhatsApp(phone);
    const exists = Array.isArray(results) && results.length > 0 && !!results[0]?.exists;
    res.json({ exists });
  } catch (err) {
    console.error('onWhatsApp check failed for', phone, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/send-message', async (req, res) => {
  const phone = (req.body?.phone || '').replace(/\D/g, '');
  const message = (req.body?.message || '').trim();
  if (status !== 'connected' || !sock) {
    return res.status(503).json({ error: 'not_connected' });
  }
  if (!phone || !message) {
    return res.status(400).json({ error: 'invalid_input' });
  }
  try {
    const jid = `${phone}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    res.json({ success: true });
  } catch (err) {
    console.error('sendMessage failed for', phone, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/logout', async (req, res) => {
  try {
    if (sock) await sock.logout();
  } catch (err) {
    console.error('Logout error (ignored):', err.message);
  }
  sock = null;
  latestQr = null;
  connectedNumber = null;
  status = 'disconnected';
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  res.json({ status });
});

app.listen(PORT, () => {
  console.log(`WhatsApp service listening on http://localhost:${PORT}`);
});
