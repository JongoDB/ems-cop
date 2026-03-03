FROM golang:1.24-alpine AS builder
WORKDIR /app
COPY go.mod go.sum* ./
RUN go mod download 2>/dev/null || true
COPY . .
RUN go mod tidy && CGO_ENABLED=0 GOOS=linux go build -o /c2-gateway .

FROM alpine:3.19
RUN apk add --no-cache ca-certificates
RUN adduser -D -u 1001 appuser
COPY --from=builder /c2-gateway /usr/local/bin/c2-gateway
EXPOSE 3005
USER appuser
CMD ["c2-gateway"]
