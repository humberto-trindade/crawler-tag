# Use official Playwright image as base (has everything pre-installed)
FROM mcr.microsoft.com/playwright:v1.61.1-jammy AS builder

WORKDIR /app
ENV NODE_ENV=development

# Install all dependencies including dev
COPY package*.json ./
RUN npm ci

# Build TypeScript using npx tsc directly
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

# Final runtime image
FROM mcr.microsoft.com/playwright:v1.61.1-jammy

WORKDIR /app
ENV NODE_ENV=production
ENV NODE_OPTIONS="--no-warnings"

# Install only production dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy built application from builder
COPY --from=builder /app/dist ./dist

# Copy migrations and scripts
COPY migrations ./migrations
COPY scripts ./scripts

EXPOSE 3000 3001

CMD ["node", "dist/src/server.js"]
