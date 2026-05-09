FROM node:20-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json ./
RUN npm install

FROM deps AS runner
COPY . .
EXPOSE 5173
CMD ["npm", "run", "dev"]