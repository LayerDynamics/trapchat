FROM node:20-alpine@sha256:5bac2112f1a27db4775ce6ead86db9e0cbc087f0dbddfe3cbc11ecea122d5294
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production
COPY src ./src
RUN addgroup -S appgroup && adduser -S appuser -G appgroup && chown -R appuser:appgroup /app
USER appuser
EXPOSE 9100
CMD ["node", "src/index.js"]
