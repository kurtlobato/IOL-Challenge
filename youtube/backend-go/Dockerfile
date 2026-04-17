# syntax=docker/dockerfile:1
FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /lanflix ./cmd/lanflix

FROM alpine:3.20
RUN apk add --no-cache ca-certificates
WORKDIR /app
COPY --from=build /lanflix /usr/local/bin/lanflix
ENV LANFLIX_DATA_DIR=/data
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/lanflix"]
