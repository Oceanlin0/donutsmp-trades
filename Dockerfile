FROM node:20-alpine
WORKDIR /app
COPY server.js index.html ./
ENV NODE_ENV=production
CMD ["node", "server.js"]
