require('dotenv').config();
const express = require('express');
const path = require('path');
const webhookRoutes      = require('./routes/webhook');
const adminRoutes        = require('./routes/admin');
const superadminRoutes   = require('./routes/superadmin');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/webhook',    webhookRoutes);
app.use('/admin',      adminRoutes);
app.use('/superadmin', superadminRoutes);

// Serve admin panel at /admin
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html')));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.get('/', (req, res) => res.redirect('/admin/index.html'));

app.listen(PORT, () => {
  console.log(`WhatsApp Bot server listening on port ${PORT}`);
});

module.exports = app;
