FROM node:20-slim

WORKDIR /workspace

# package.jsonだけ先にコピーしてnpm installをキャッシュ活用
COPY package*.json ./
RUN npm install --omit=dev

# ソースコードをコピー
COPY . .

CMD ["node", "index.js"]
