"""Explicit browser CORS policy for the Basecamp web application."""

# Keep this list deliberate: authenticated browser requests must only come
# from origins configured through CORS_ALLOWED_ORIGINS.
ALLOWED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
ALLOWED_HEADERS = ["Authorization", "Content-Type", "Accept"]
