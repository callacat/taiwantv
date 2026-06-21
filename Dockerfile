FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY . .
RUN go mod tidy && CGO_ENABLED=0 GOOS=linux go build -o /taiwantv .

FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata
COPY --from=builder /taiwantv /taiwantv
EXPOSE 3000
VOLUME ["/data"]
CMD ["/taiwantv"]
