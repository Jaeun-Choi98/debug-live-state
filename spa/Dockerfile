
FROM golang:1.24-alpine as go-build

RUN apk add --no-cache \
  git \
  ca-certificates \
  gcc \
  musl-dev
WORKDIR /app
COPY go.mod go.sum ./
RUN ls -la && go mod download
COPY ./ ./
WORKDIR ./cmd/server
RUN go build -o ./main main.go

FROM golang:1.24-alpine
WORKDIR /home/app
COPY --from=go-build /app/cmd/server/ /home/app/
CMD ["./main"]
