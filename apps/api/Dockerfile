FROM node:20-alpine AS base
WORKDIR /app

# 의존성 설치 단계
FROM base AS deps
COPY package.json ./
RUN npm install

# 빌드 단계
FROM deps AS builder
COPY . .
RUN npm run build

# 실행 단계 (프로덕션)
FROM base AS runner
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/main"]