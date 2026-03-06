FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production
COPY tsconfig.json ./
COPY src ./src

RUN npm install -g typescript
RUN tsc

EXPOSE 4000

CMD ["node", "dist/server.js"]
