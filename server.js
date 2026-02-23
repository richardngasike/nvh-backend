const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const { initDatabase } = require('./database');
const landlordRoutes = require('./routes/landlords');
const listingRoutes = require('./routes/listings');

const app = express();
const PORT = process.env.PORT || 5000;

// Set your production frontend URL
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://nairobiVacantHouses.com';

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Middleware
app.use(cors({
  origin: [FRONTEND_URL, 'http://localhost:3000', 'http://localhost:3001'],
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Routes
app.use('/api/landlords', landlordRoutes);
app.use('/api/listings', listingRoutes);

// M-Pesa callback (public route)
app.post('/api/mpesa/callback', require('./routes/listings'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'Nairobi Vacant Houses API is running', timestamp: new Date() });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// Start server
const startServer = async () => {
  try {
    await initDatabase();
    app.listen(PORT, () => {
      console.log(`🏠 Nairobi Vacant Houses API running on port ${PORT}`);
      console.log(`📝 API docs: ${process.env.BASE_URL || `https://nvh-backend.onrender.com`}/api/health`);
      console.log(`🌐 Frontend allowed origin: ${FRONTEND_URL}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();
