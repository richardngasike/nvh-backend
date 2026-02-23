const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../database');
const authMiddleware = require('../middleware/auth');
const { initiateSTKPush } = require('../mpesa');

// Multer config
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|webp/;
    if (allowed.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image files allowed'));
  }
});

// Get all active listings (with filters)
router.get('/', async (req, res) => {
  const {
    location, property_type, min_price, max_price,
    amenities, sort, page = 1, limit = 12, featured
  } = req.query;

  let conditions = ["l.status = 'active'"];
  let params = [];
  let idx = 1;

  if (location) {
    conditions.push(`(LOWER(l.location) LIKE LOWER($${idx}) OR LOWER(l.sub_location) LIKE LOWER($${idx}))`);
    params.push(`%${location}%`);
    idx++;
  }
  if (property_type) {
    conditions.push(`l.property_type = $${idx}`);
    params.push(property_type);
    idx++;
  }
  if (min_price) {
    conditions.push(`l.price >= $${idx}`);
    params.push(Number(min_price));
    idx++;
  }
  if (max_price) {
    conditions.push(`l.price <= $${idx}`);
    params.push(Number(max_price));
    idx++;
  }
  if (featured === 'true') {
    conditions.push(`l.featured = true`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  let orderBy = 'l.created_at DESC';
  if (sort === 'price_asc') orderBy = 'l.price ASC';
  if (sort === 'price_desc') orderBy = 'l.price DESC';
  if (sort === 'newest') orderBy = 'l.created_at DESC';
  if (sort === 'popular') orderBy = 'l.views DESC';

  const offset = (Number(page) - 1) * Number(limit);

  try {
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM listings l ${whereClause}`,
      params
    );

    const result = await pool.query(
      `SELECT l.*, ld.name as landlord_name, ld.phone as landlord_phone,
              COALESCE(AVG(r.rating), 0) as avg_rating,
              COUNT(DISTINCT r.id) as review_count
       FROM listings l
       JOIN landlords ld ON ld.id = l.landlord_id
       LEFT JOIN reviews r ON r.listing_id = l.id
       ${whereClause}
       GROUP BY l.id, ld.name, ld.phone
       ORDER BY ${orderBy}
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, Number(limit), offset]
    );

    res.json({
      listings: result.rows,
      total: Number(countResult.rows[0].count),
      page: Number(page),
      totalPages: Math.ceil(Number(countResult.rows[0].count) / Number(limit))
    });
  } catch (error) {
    console.error('Get listings error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get single listing
router.get('/:id', async (req, res) => {
  try {
    // Increment views
    await pool.query('UPDATE listings SET views = views + 1 WHERE id = $1', [req.params.id]);

    const result = await pool.query(
      `SELECT l.*, ld.name as landlord_name, ld.phone as landlord_phone, ld.location as landlord_location,
              COALESCE(AVG(r.rating), 0) as avg_rating, COUNT(DISTINCT r.id) as review_count
       FROM listings l
       JOIN landlords ld ON ld.id = l.landlord_id
       LEFT JOIN reviews r ON r.listing_id = l.id
       WHERE l.id = $1 AND l.status = 'active'
       GROUP BY l.id, ld.name, ld.phone, ld.location`,
      [req.params.id]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Listing not found' });

    const reviews = await pool.query(
      'SELECT * FROM reviews WHERE listing_id = $1 ORDER BY created_at DESC LIMIT 5',
      [req.params.id]
    );

    res.json({ ...result.rows[0], reviews: reviews.rows });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Create listing (initiate payment)
router.post('/', authMiddleware, upload.array('images', 5), async (req, res) => {
  const {
    title, description, location, sub_location, property_type,
    price, deposit, amenities, contact_phone, available_from,
    floor_number, total_floors, size_sqft, mpesa_phone
  } = req.body;

  if (!title || !location || !property_type || !price || !mpesa_phone) {
    return res.status(400).json({ error: 'Title, location, property type, price, and M-Pesa phone are required' });
  }

  if (!req.files || req.files.length < 1) {
    return res.status(400).json({ error: 'At least 1 image is required' });
  }

  const images = req.files.map(f => `/uploads/${f.filename}`);
  const amenitiesArray = amenities ? (Array.isArray(amenities) ? amenities : amenities.split(',').map(a => a.trim())) : [];

  try {
    // Create listing in pending state
    const listingResult = await pool.query(
      `INSERT INTO listings (
        landlord_id, title, description, location, sub_location, property_type,
        price, deposit, amenities, images, status, payment_status,
        contact_phone, available_from, floor_number, total_floors, size_sqft
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending','unpaid',$11,$12,$13,$14,$15)
      RETURNING id`,
      [
        req.landlord.id, title, description, location, sub_location, property_type,
        price, deposit || null, amenitiesArray, images,
        contact_phone || null, available_from || null,
        floor_number || null, total_floors || null, size_sqft || null
      ]
    );

    const listingId = listingResult.rows[0].id;

    // Initiate M-Pesa STK Push
    const mpesaResult = await initiateSTKPush(
      mpesa_phone,
      300,
      `LISTING-${listingId}`,
      'Nairobi Vacant Houses Listing Fee'
    );

    if (!mpesaResult.success) {
      // If mpesa fails, for demo return payment pending
      // In production, handle this better
      const paymentResult = await pool.query(
        `INSERT INTO payments (landlord_id, listing_id, phone, amount, status, mpesa_request_id)
         VALUES ($1, $2, $3, 300, 'pending', $4) RETURNING id`,
        [req.landlord.id, listingId, mpesa_phone, `DEMO-${Date.now()}`]
      );

      return res.status(201).json({
        message: 'Listing created. M-Pesa payment initiation failed - using demo mode.',
        listing_id: listingId,
        payment_id: paymentResult.rows[0].id,
        mpesa_demo: true,
        error: mpesaResult.error
      });
    }

    const checkoutRequestId = mpesaResult.data.CheckoutRequestID;

    // Save payment record
    await pool.query(
      `INSERT INTO payments (landlord_id, listing_id, phone, amount, status, mpesa_request_id)
       VALUES ($1, $2, $3, 300, 'pending', $4)`,
      [req.landlord.id, listingId, mpesa_phone, checkoutRequestId]
    );

    res.status(201).json({
      message: 'Listing created. Please complete M-Pesa payment on your phone.',
      listing_id: listingId,
      checkout_request_id: checkoutRequestId,
      merchant_request_id: mpesaResult.data.MerchantRequestID
    });
  } catch (error) {
    console.error('Create listing error:', error);
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
});

// M-Pesa callback
router.post('/mpesa/callback', async (req, res) => {
  const { Body } = req.body;
  const stk = Body?.stkCallback;

  if (!stk) return res.status(400).json({ error: 'Invalid callback' });

  const checkoutRequestId = stk.CheckoutRequestID;
  const resultCode = stk.ResultCode;
  const resultDesc = stk.ResultDesc;

  try {
    let transactionId = null;
    if (resultCode === 0) {
      const items = stk.CallbackMetadata?.Item || [];
      const mpesaReceiptItem = items.find(i => i.Name === 'MpesaReceiptNumber');
      transactionId = mpesaReceiptItem?.Value;
    }

    const payment = await pool.query(
      `UPDATE payments SET status=$1, result_code=$2, result_desc=$3, mpesa_transaction_id=$4, updated_at=NOW()
       WHERE mpesa_request_id=$5 RETURNING listing_id`,
      [
        resultCode === 0 ? 'completed' : 'failed',
        String(resultCode), resultDesc, transactionId,
        checkoutRequestId
      ]
    );

    if (payment.rows.length > 0 && resultCode === 0) {
      const listingId = payment.rows[0].listing_id;
      await pool.query(
        `UPDATE listings SET status='active', payment_status='paid', mpesa_transaction_id=$1, updated_at=NOW()
         WHERE id=$2`,
        [transactionId, listingId]
      );
      // Update landlord total listings
      await pool.query(
        `UPDATE landlords SET total_listings = total_listings + 1 WHERE id = (SELECT landlord_id FROM listings WHERE id = $1)`,
        [listingId]
      );
    }
  } catch (error) {
    console.error('Callback error:', error);
  }

  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

// Check payment status
router.get('/payment/status/:checkout_request_id', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM payments WHERE mpesa_request_id = $1 AND landlord_id = $2',
      [req.params.checkout_request_id, req.landlord.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Payment not found' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Manually activate listing (demo mode - for testing without real mpesa)
router.post('/:id/activate', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE listings SET status='active', payment_status='paid', updated_at=NOW()
       WHERE id=$1 AND landlord_id=$2 RETURNING *`,
      [req.params.id, req.landlord.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Listing not found' });

    await pool.query(
      'UPDATE landlords SET total_listings = total_listings + 1 WHERE id = $1',
      [req.landlord.id]
    );

    res.json({ message: 'Listing activated (demo mode)', listing: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete listing
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM listings WHERE id=$1 AND landlord_id=$2 RETURNING id',
      [req.params.id, req.landlord.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Listing not found' });
    res.json({ message: 'Listing deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Add review
router.post('/:id/reviews', async (req, res) => {
  const { reviewer_name, rating, comment } = req.body;
  if (!reviewer_name || !rating) return res.status(400).json({ error: 'Name and rating required' });

  try {
    const result = await pool.query(
      'INSERT INTO reviews (listing_id, reviewer_name, rating, comment) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.params.id, reviewer_name, rating, comment]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Send inquiry
router.post('/:id/inquire', async (req, res) => {
  const { name, phone, message } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'Name and phone required' });

  try {
    const result = await pool.query(
      'INSERT INTO inquiries (listing_id, name, phone, message) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.params.id, name, phone, message]
    );
    res.status(201).json({ message: 'Inquiry sent successfully', inquiry: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get stats for homepage
router.get('/stats/overview', async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM listings WHERE status='active') as active_listings,
        (SELECT COUNT(*) FROM landlords) as total_landlords,
        (SELECT COUNT(DISTINCT location) FROM listings WHERE status='active') as locations,
        (SELECT COUNT(*) FROM inquiries) as total_inquiries
    `);
    res.json(stats.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
