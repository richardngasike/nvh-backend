const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../database');
const authMiddleware = require('../middleware/auth');
require('dotenv').config();

// Register landlord
router.post('/register', async (req, res) => {
  const { name, location, phone, password, email } = req.body;

  if (!name || !location || !phone || !password) {
    return res.status(400).json({ error: 'Name, location, phone, and password are required' });
  }

  try {
    // Check if phone already exists
    const existing = await pool.query('SELECT id FROM landlords WHERE phone = $1', [phone]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Phone number already registered' });
    }

    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO landlords (name, location, phone, password_hash, email)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, name, location, phone, email, created_at`,
      [name, location, phone, hash, email || null]
    );

    const landlord = result.rows[0];
    const token = jwt.sign({ id: landlord.id, phone: landlord.phone }, process.env.JWT_SECRET, { expiresIn: '7d' });

    res.status(201).json({ message: 'Account created successfully', landlord, token });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Login landlord
router.post('/login', async (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) return res.status(400).json({ error: 'Phone and password required' });

  try {
    const result = await pool.query('SELECT * FROM landlords WHERE phone = $1', [phone]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });

    const landlord = result.rows[0];
    const valid = await bcrypt.compare(password, landlord.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ id: landlord.id, phone: landlord.phone }, process.env.JWT_SECRET, { expiresIn: '7d' });

    res.json({
      message: 'Login successful',
      landlord: {
        id: landlord.id,
        name: landlord.name,
        location: landlord.location,
        phone: landlord.phone,
        email: landlord.email,
        total_listings: landlord.total_listings,
        rating: landlord.rating
      },
      token
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get landlord profile
router.get('/profile', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, location, phone, email, total_listings, rating, created_at FROM landlords WHERE id = $1',
      [req.landlord.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Landlord not found' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get landlord's listings
router.get('/listings', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT l.*, COUNT(r.id) as review_count, COALESCE(AVG(r.rating), 0) as avg_rating
       FROM listings l
       LEFT JOIN reviews r ON r.listing_id = l.id
       WHERE l.landlord_id = $1
       GROUP BY l.id
       ORDER BY l.created_at DESC`,
      [req.landlord.id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Get listings error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update profile
router.put('/profile', authMiddleware, async (req, res) => {
  const { name, location, email } = req.body;
  try {
    const result = await pool.query(
      `UPDATE landlords SET name=$1, location=$2, email=$3, updated_at=NOW()
       WHERE id=$4 RETURNING id, name, location, phone, email`,
      [name, location, email, req.landlord.id]
    );
    res.json({ message: 'Profile updated', landlord: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
