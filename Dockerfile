# Use Node.js LTS version
FROM node:20-slim

# Set timezone to Central European Time to match user's location
ENV TZ=Europe/Berlin
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
COPY package*.json ./
RUN npm install

# Copy app source
COPY . .

# Create directory for token storage
RUN mkdir -p /usr/src/app/tokens

# Set environment variables
ENV NODE_ENV=production
ENV WORK_TOKEN_PATH=/usr/src/app/tokens/work_token.json
ENV PERSONAL_TOKEN_PATH=/usr/src/app/tokens/personal_token.json
ENV SYNCED_EVENTS_FILE=/usr/src/app/data/synced_events.json

# Add healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "try { require('fs').accessSync('/usr/src/app/tokens/work_token.json'); require('fs').accessSync('/usr/src/app/tokens/personal_token.json'); process.exit(0); } catch(e) { process.exit(1); }"

# Run the app
CMD ["node", "sync.js"] 