FROM alpine AS builder

RUN apk add --no-cache nodejs npm git

RUN adduser -D app
USER app
WORKDIR /home/app

RUN git clone https://github.com/mindjkl/114514.git 114514
WORKDIR /home/app/114514
RUN npm ci --omit dev && npm run download-dist

EXPOSE 3001
CMD ["node", "server/server.js"]
