FROM node:20-slim

WORKDIR /app

# Install dependencies first (layer-cache friendly)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY . .

# Expose streamer port
EXPOSE 6987

CMD ["node", "server.js"]
