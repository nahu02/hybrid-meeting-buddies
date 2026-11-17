# Separate stage so app code/dependency changes don't trigger a re-download.
# A local models/glove.6B.50d.txt is used if present.
FROM alpine:3.20 AS glove
ARG GLOVE_URL=https://raw.githubusercontent.com/uclnlp/inferbeddings/master/data/glove/glove.6B.50d.txt.gz
ARG GLOVE_GZ_SHA256=12734d03a33d81c3b655726f6373306131974aa38327a21c0157f73b7b6ec918
WORKDIR /models
COPY models/ ./
RUN if [ ! -f glove.6B.50d.txt ]; then \
        wget -q -O /tmp/glove.gz "$GLOVE_URL" && \
        echo "$GLOVE_GZ_SHA256  /tmp/glove.gz" | sha256sum -c - && \
        gunzip -c /tmp/glove.gz > glove.6B.50d.txt && \
        rm /tmp/glove.gz; \
    fi

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY index.html vite.config.js ./
COPY public ./public
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY server ./server
COPY --from=glove /models/glove.6B.50d.txt ./models/
EXPOSE 3000
CMD ["node", "server/index.js"]
