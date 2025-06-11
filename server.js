const express = require('express');
const routes = require('./src/routes/index');
const path = require('path');
const { preCacheMovies } = require('./src/scripts/preCacheMovies');

const app = express();

// Serve static files
app.use('/public', express.static(path.join(__dirname, 'public')));

// CORS configuration
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Routes
app.use('/', routes);

// Global error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// Start pre-caching in the background
preCacheMovies().catch(err => {
  console.error('Pre-caching failed:', err.message);
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
