FROM node:20-slim

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies and telegraf
COPY package*.json ./

RUN sed -i 's/main/main non-free-firmware non-free/g' /etc/apt/sources.list.d/debian.sources || \
    sed -i 's/main/main non-free-firmware non-free/g' /etc/apt/sources.list

RUN apt-get update && apt-get install -y curl snmp snmp-mibs-downloader && \
    ARCH=$(dpkg --print-architecture) && \
    curl -O https://dl.influxdata.com/telegraf/releases/telegraf_1.37.1-1_${ARCH}.deb && \
    dpkg -i telegraf_1.37.1-1_${ARCH}.deb || apt-get install -f -y && \
    rm telegraf_1.37.1-1_${ARCH}.deb && \
    download-mibs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Help snmpwalk/snmptable find MIBs
ENV MIBDIRS=/usr/src/app/mibs:/usr/share/snmp/mibs:/var/lib/mibs/ietf:/var/lib/mibs/iana

RUN npm install --production

# Bundle app source
COPY . .

# Create mibs directory if it doesn't exist
RUN mkdir -p mibs

# Expose port
EXPOSE 3000

# Start the application
CMD [ "npm", "start" ]
