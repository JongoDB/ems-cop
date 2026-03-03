FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production 2>/dev/null || npm install --production
COPY . .
EXPOSE 3003
USER node
CMD ["node", "src/index.js"]
