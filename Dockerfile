FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV LUMEN_API_HOST=0.0.0.0
ENV LUMEN_API_PORT=3000
ENV SEARXNG_URL=http://searxng:8080
COPY --from=build /app/package*.json ./
RUN npm install --omit=dev
COPY --from=build /app/api-server.mjs ./
COPY --from=build /app/dist ./dist
EXPOSE 3000
CMD ["node", "api-server.mjs"]
