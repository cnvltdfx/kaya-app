# Production API image for ECS Fargate / App Runner / EC2. Build from the repo root:
#   docker build -t kool-kaya-api backend
# The storefront is not included; it is deployed separately from ../frontend.
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./
COPY src ./src
RUN mkdir -p data reports && chown -R node:node /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:3000/health || exit 1
CMD ["node", "server.js"]
