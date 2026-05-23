FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN node node_modules/typescript/lib/tsc.js --outDir dist
EXPOSE 8080
CMD ["node", "dist/server.js"]
