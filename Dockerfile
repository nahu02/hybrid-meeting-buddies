FROM golang:1.24 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY --exclude=static --exclude=buddy-assignment-app . .
RUN --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -ldflags='-s -w'

# Separate stage so app code/dependency changes don't trigger a re-download.
# A local public/models/glove.6B.50d.txt is used if present.
FROM alpine:3.20 AS glove
ARG GLOVE_URL=https://raw.githubusercontent.com/uclnlp/inferbeddings/master/data/glove/glove.6B.50d.txt.gz
ARG GLOVE_GZ_SHA256=12734d03a33d81c3b655726f6373306131974aa38327a21c0157f73b7b6ec918
WORKDIR /models
COPY buddy-assignment-app/public/models/ ./
RUN if [ ! -f glove.6B.50d.txt ]; then \
        wget -q -O /tmp/glove.gz "$GLOVE_URL" && \
        echo "$GLOVE_GZ_SHA256  /tmp/glove.gz" | sha256sum -c - && \
        gunzip -c /tmp/glove.gz > glove.6B.50d.txt && \
        rm /tmp/glove.gz; \
    fi

FROM node:24-alpine AS assignment
WORKDIR /src/buddy-assignment-app
COPY buddy-assignment-app/package.json buddy-assignment-app/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY buddy-assignment-app/ ./
COPY --from=glove /models/glove.6B.50d.txt public/models/
# outputs to /src/static/assignment (see vite.config.js)
RUN npm run build

FROM scratch
WORKDIR /app
COPY --from=build /src/galene ./galene
COPY static ./static
COPY --from=assignment /src/static/assignment ./static/assignment
ENTRYPOINT ["/app/galene"]
