FROM golang:1.24 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY --exclude=static . .
RUN --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -ldflags='-s -w'

FROM scratch
WORKDIR /app
COPY --from=build /src/galene ./galene
COPY static ./static
ENTRYPOINT ["/app/galene"]

