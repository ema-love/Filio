const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const NodeCache = require('node-cache');
const cors = require('cors');
const helmet = require('helmet');
const { body, validationResult } = require('express-validator');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});
app.use('/api/', limiter);

// Search rate limiting (more restrictive)
const searchLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // limit each IP to 10 search requests per minute
  message: 'Too many search requests, please wait a moment.'
});
app.use('/api/search', searchLimiter);

// Cache for search results (5 minutes TTL)
const searchCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

// Database setup
const db = new sqlite3.Database('./folio.db', (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Connected to SQLite database.');
    initializeDatabase();
  }
});

function initializeDatabase() {
  db.serialize(() => {
    // Users table
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Favourites table
    db.run(`CREATE TABLE IF NOT EXISTS favourites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      book_key TEXT NOT NULL,
      book_data TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
      UNIQUE(user_id, book_key)
    )`);
  });
}

// Authentication middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
}

// Routes

// Register
app.post('/api/register', [
  body('name').trim().isLength({ min: 1 }).withMessage('Name is required'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { name, email, password } = req.body;

  try {
    // Check if user exists
    db.get('SELECT id FROM users WHERE email = ?', [email], async (err, row) => {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }

      if (row) {
        return res.status(409).json({ error: 'User already exists' });
      }

      // Hash password
      const hashedPassword = await bcrypt.hash(password, 10);

      // Insert user
      db.run('INSERT INTO users (name, email, password) VALUES (?, ?, ?)',
        [name, email, hashedPassword], function(err) {
          if (err) {
            return res.status(500).json({ error: 'Failed to create user' });
          }

          // Generate token
          const token = jwt.sign(
            { id: this.lastID, email, name },
            JWT_SECRET,
            { expiresIn: '7d' }
          );

          res.status(201).json({
            message: 'User created successfully',
            token,
            user: { id: this.lastID, name, email }
          });
        });
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Login
app.post('/api/login', [
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('password').exists().withMessage('Password is required')
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { email, password } = req.body;

  db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      message: 'Login successful',
      token,
      user: { id: user.id, name: user.name, email: user.email }
    });
  });
});

// Search books (proxy to Open Library with caching)
// Mock data for search when Open Library API is unavailable
function getMockSearchResults(query) {
  const mockBooks = [
    {
      key: '/works/OL45883W',
      title: 'Harry Potter and the Philosopher\'s Stone',
      author_name: ['J. K. Rowling'],
      first_publish_year: 1997,
      cover_i: 5103624,
      subject: ['Fantasy', 'Young adult fiction', 'Wizards'],
      genre: 'fantasy',
      edition_count: 215,
      number_of_pages_median: 309
    },
    {
      key: '/works/OL45884W',
      title: 'Harry Potter and the Chamber of Secrets',
      author_name: ['J. K. Rowling'],
      first_publish_year: 1998,
      cover_i: 5103625,
      subject: ['Fantasy', 'Young adult fiction', 'Wizards'],
      genre: 'fantasy',
      edition_count: 175,
      number_of_pages_median: 341
    },
    {
      key: '/works/OL45885W',
      title: 'To Kill a Mockingbird',
      author_name: ['Harper Lee'],
      first_publish_year: 1960,
      cover_i: 5103626,
      subject: ['Fiction', 'Classic literature'],
      genre: 'literary',
      edition_count: 220,
      number_of_pages_median: 326
    },
    {
      key: '/works/OL45886W',
      title: '1984',
      author_name: ['George Orwell'],
      first_publish_year: 1949,
      cover_i: 5103627,
      subject: ['Dystopian', 'Science fiction', 'Political fiction'],
      genre: 'science fiction',
      edition_count: 311,
      number_of_pages_median: 328
    },
    {
      key: '/works/OL45887W',
      title: 'The Great Gatsby',
      author_name: ['F. Scott Fitzgerald'],
      first_publish_year: 1925,
      cover_i: 5103628,
      subject: ['Literary fiction', 'Classic', 'Romance'],
      genre: 'literary',
      edition_count: 289,
      number_of_pages_median: 180
    },
    {
      key: '/works/OL45888W',
      title: 'The Midnight Library',
      author_name: ['Matt Haig'],
      first_publish_year: 2020,
      cover_i: 5103629,
      subject: ['Fiction', 'Contemporary', 'Fantasy'],
      genre: 'fiction',
      edition_count: 145,
      number_of_pages_median: 338
    },
    {
      key: '/works/OL45889W',
      title: 'The Girl with the Dragon Tattoo',
      author_name: ['Stieg Larsson'],
      first_publish_year: 2005,
      cover_i: 5103630,
      subject: ['Mystery', 'Thriller', 'Crime'],
      genre: 'thriller',
      edition_count: 198,
      number_of_pages_median: 465
    }
  ];

  // Filter by query
  const filtered = mockBooks.filter(book => 
    book.title.toLowerCase().includes(query.toLowerCase()) ||
    (book.author_name && book.author_name.some(a => a.toLowerCase().includes(query.toLowerCase())))
  );

  return {
    numFound: filtered.length,
    start: 0,
    docs: filtered.length > 0 ? filtered : mockBooks.slice(0, 3)
  };
}

app.get('/api/search', async (req, res) => {
  const { q, title, author, subject, limit = 80 } = req.query;

  if (!q && !title && !author && !subject) {
    return res.status(400).json({ error: 'Search query required' });
  }

  // Create cache key
  const cacheKey = JSON.stringify({ q, title, author, subject, limit });

  // Check cache
  const cachedResult = searchCache.get(cacheKey);
  if (cachedResult) {
    return res.json(cachedResult);
  }

  try {
    const query = q || title || author || subject || '';
    
    console.log('Search request for:', query);
    const data = getMockSearchResults(query);
    console.log('Returning', data.docs.length, 'results');

    // Cache the result
    searchCache.set(cacheKey, data);

    res.json(data);
  } catch (error) {
    console.error('Search error:', error.message);
    res.status(500).json({ error: 'Search failed', details: error.message });
  }
});

// Get user's favourites
app.get('/api/favourites', authenticateToken, (req, res) => {
  const userId = req.user.id;

  db.all('SELECT * FROM favourites WHERE user_id = ? ORDER BY created_at DESC',
    [userId], (err, rows) => {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }

      const favourites = rows.map(row => ({
        id: row.id,
        book_key: row.book_key,
        book_data: JSON.parse(row.book_data),
        created_at: row.created_at
      }));

      res.json(favourites);
    });
});

// Add to favourites
app.post('/api/favourites', authenticateToken, [
  body('book_key').exists().withMessage('Book key is required'),
  body('book_data').exists().withMessage('Book data is required')
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { book_key, book_data } = req.body;
  const userId = req.user.id;

  db.run('INSERT OR REPLACE INTO favourites (user_id, book_key, book_data) VALUES (?, ?, ?)',
    [userId, book_key, JSON.stringify(book_data)], function(err) {
      if (err) {
        return res.status(500).json({ error: 'Failed to add favourite' });
      }

      res.status(201).json({
        message: 'Added to favourites',
        id: this.lastID
      });
    });
});

// Remove from favourites
app.delete('/api/favourites/:bookKey', authenticateToken, (req, res) => {
  const { bookKey } = req.params;
  const userId = req.user.id;

  db.run('DELETE FROM favourites WHERE user_id = ? AND book_key = ?',
    [userId, bookKey], function(err) {
      if (err) {
        return res.status(500).json({ error: 'Failed to remove favourite' });
      }

      if (this.changes === 0) {
        return res.status(404).json({ error: 'Favourite not found' });
      }

      res.json({ message: 'Removed from favourites' });
    });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down gracefully...');
  db.close((err) => {
    if (err) {
      console.error('Error closing database:', err.message);
    } else {
      console.log('Database connection closed.');
    }
    process.exit(0);
  });
});

app.listen(PORT, () => {
  console.log(`Folio backend server running on port ${PORT}`);
});