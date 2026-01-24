FROM node:20-slim

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied
COPY package*.json ./

RUN npm install --production

# Bundle app source
COPY . .

# Create mibs directory if it doesn't exist
RUN mkdir -p mibs

# Expose port
EXPOSE 3000

# Start the application
CMD [ "npm", "start" ]
