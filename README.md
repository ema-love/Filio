# Folio - Book Finder

A modern web application for discovering and managing your personal book collection.

## Features

- **Book Search**: Search millions of books from the Open Library database
- **User Authentication**: Secure registration and login with JWT
- **Favourites Management**: Save and organize your favorite books
- **Advanced Filtering**: Filter by decade, author, subject, and more
- **Responsive Design**: Works seamlessly on desktop and mobile

## Tech Stack

### Frontend
- HTML5, CSS3, JavaScript (ES6+)
- Responsive design with custom CSS
- Progressive Web App features

### Backend
- Node.js with Express.js
- SQLite database for data persistence
- JWT authentication
- RESTful API design
- Rate limiting and caching

## Getting Started

### Prerequisites

- Node.js (v14 or higher)
- npm

### Installation

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd folio
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the backend server:
   ```bash
   npm start
   ```
   The server will run on http://localhost:3001

4. Open the frontend:
   - Landing page: Open `landing.html` in your browser
   - Main app: Open `index.html` in your browser (requires authentication)

## API Endpoints

### Authentication
- `POST /api/register` - User registration
- `POST /api/login` - User login

### Books
- `GET /api/search` - Search books (proxies Open Library API)

### Favourites
- `GET /api/favourites` - Get user's favourites
- `POST /api/favourites` - Add book to favourites
- `DELETE /api/favourites/:bookKey` - Remove book from favourites

### System
- `GET /api/health` - Health check

## Database

The application uses SQLite with the following schema:

- **users**: User accounts (id, name, email, password)
- **favourites**: User's saved books (id, user_id, book_key, book_data, created_at)

## Development

### Running in Development Mode

```bash
npm run dev
```

This uses nodemon for automatic server restarts on file changes.

### Environment Variables

Create a `.env` file in the root directory:

```
PORT=3001
JWT_SECRET=your-secret-key-change-in-production
```

## Security Features

- Password hashing with bcrypt
- JWT token authentication
- Rate limiting on API endpoints
- Input validation and sanitization
- CORS protection
- Helmet.js security headers

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

This project is licensed under the MIT License.

## Acknowledgments

- Book data provided by [Open Library](https://openlibrary.org)
- Icons and UI inspiration from various design systems
- Font families from Google Fonts