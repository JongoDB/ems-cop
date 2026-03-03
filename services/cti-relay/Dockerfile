FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.mod go.sum* ./
RUN go mod download 2>/dev/null || true
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /cti-relay .

FROM alpine:3.19
RUN apk add --no-cache ca-certificates wget
RUN adduser -D -u 1001 appuser
COPY --from=builder /cti-relay /usr/local/bin/cti-relay
EXPOSE 3010
USER appuser
CMD ["cti-relay"]
