# Black Meet — Render Deployment

This package is prepared as two Render web services:

1. black-meet-web — PHP/Apache website
2. black-meet-signaling — Node.js/Socket.IO signaling server

## Deploy

The included render.yaml can be used as a starting point for a Render Blueprint.

After creating both services, set:

### black-meet-signaling
PHP_BASE_URL=https://YOUR-PHP-SERVICE.onrender.com

### black-meet-web
SIGNALING_URL=https://YOUR-SIGNALING-SERVICE.onrender.com
DB_HOST=...
DB_NAME=...
DB_USER=...
DB_PASSWORD=...

## Important

Do not upload real passwords or API secrets to GitHub. Use Render Environment Variables.

If the application currently hard-codes localhost database/socket URLs, those values must be changed to read the Render environment variables.

The Node server has been patched to use Render's PORT environment variable.
