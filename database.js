const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
  require: true,
  rejectUnauthorized: false
}
});

const initDatabase = async () => {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS landlords (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        location VARCHAR(255) NOT NULL,
        phone VARCHAR(20) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE,
        profile_image VARCHAR(500),
        verified BOOLEAN DEFAULT false,
        total_listings INTEGER DEFAULT 0,
        rating DECIMAL(2,1) DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS listings (
        id SERIAL PRIMARY KEY,
        landlord_id INTEGER REFERENCES landlords(id) ON DELETE CASCADE,
        title VARCHAR(500) NOT NULL,
        description TEXT,
        location VARCHAR(255) NOT NULL,
        sub_location VARCHAR(255),
        property_type VARCHAR(50) NOT NULL CHECK (property_type IN ('bedsitter', 'single_room', 'one_bedroom', 'two_bedroom', 'three_bedroom')),
        price DECIMAL(10,2) NOT NULL,
        deposit DECIMAL(10,2),
        amenities TEXT[],
        images TEXT[],
        status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'inactive', 'rejected')),
        payment_status VARCHAR(20) DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'paid', 'failed')),
        mpesa_transaction_id VARCHAR(255),
        views INTEGER DEFAULT 0,
        contact_phone VARCHAR(20),
        available_from DATE,
        floor_number INTEGER,
        total_floors INTEGER,
        size_sqft INTEGER,
        featured BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS payments (
        id SERIAL PRIMARY KEY,
        landlord_id INTEGER REFERENCES landlords(id),
        listing_id INTEGER,
        mpesa_request_id VARCHAR(255) UNIQUE,
        mpesa_transaction_id VARCHAR(255),
        phone VARCHAR(20) NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed', 'cancelled')),
        result_code VARCHAR(10),
        result_desc TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS favorites (
        id SERIAL PRIMARY KEY,
        user_session VARCHAR(255) NOT NULL,
        listing_id INTEGER REFERENCES listings(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_session, listing_id)
      );

      CREATE TABLE IF NOT EXISTS inquiries (
        id SERIAL PRIMARY KEY,
        listing_id INTEGER REFERENCES listings(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        phone VARCHAR(20) NOT NULL,
        message TEXT,
        status VARCHAR(20) DEFAULT 'new',
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS reviews (
        id SERIAL PRIMARY KEY,
        listing_id INTEGER REFERENCES listings(id) ON DELETE CASCADE,
        reviewer_name VARCHAR(255) NOT NULL,
        rating INTEGER CHECK (rating BETWEEN 1 AND 5),
        comment TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_listings_location ON listings(location);
      CREATE INDEX IF NOT EXISTS idx_listings_type ON listings(property_type);
      CREATE INDEX IF NOT EXISTS idx_listings_price ON listings(price);
      CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
      CREATE INDEX IF NOT EXISTS idx_listings_landlord ON listings(landlord_id);
    `);
    console.log('✅ Database initialized successfully');
  } catch (error) {
    console.error('❌ Database initialization error:', error);
    throw error;
  } finally {
    client.release();
  }
};

module.exports = { pool, initDatabase };
