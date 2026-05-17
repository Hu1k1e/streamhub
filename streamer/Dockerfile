FROM node:20-slim

# curl needed for the container healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*


WORKDIR /app

# Install dependencies first (layer-cache friendly)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY . .

# Expose streamer port
EXPOSE 6987

CMD ["node", "server.js"]
