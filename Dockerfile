# Sử dụng Node.js LTS version
FROM node:18-alpine

# Tạo thư mục làm việc
WORKDIR /app

# Sao chép package.json và package-lock.json
COPY package*.json ./

# Cài đặt dependencies
RUN npm install --production

# Sao chép source code
COPY . .

# Expose port
EXPOSE 3000

# Chạy ứng dụng
CMD ["npm", "start"]
