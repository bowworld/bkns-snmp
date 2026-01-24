# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SNMP Viewer is a web-based tool for visually exploring and managing data from network equipment via the SNMP protocol. It provides an interface for scanning devices, viewing OID trees, and managing MIB files. The tool maps hardware parameters into JSON format compatible with Telegraf for storage in InfluxDB.

## Tech Stack

- **Runtime**: Node.js 20
- **Backend**: Express.js
- **SNMP Library**: net-snmp (supports v1, v2c, v3)
- **File Upload**: multer
- **Frontend**: Vanilla HTML/CSS/JavaScript (single-page in `public/index.html`)
- **Deployment**: Docker & Docker Compose

## Project Structure

```
snmp-viewer/
├── server.js           # Express server with SNMP walk API endpoints
├── lib/
│   └── mib-manager.js  # MIB file loading and OID translation
├── public/
│   ├── index.html      # Single-page frontend application
│   └── fixed-layout.css
├── mibs/               # Directory for uploaded MIB files
├── Dockerfile
├── docker-compose.yml
└── package.json
```

## Common Commands

```bash
# Install dependencies
npm install

# Start the server (production)
npm start

# Start with file watching (development)
npm run dev

# Docker deployment
docker compose up -d --build
```

## API Endpoints

- `GET /api/mibs` - List available MIB files
- `POST /api/upload-mib` - Upload a MIB file (multipart/form-data)
- `DELETE /api/mibs` - Delete MIB files (JSON body: `{ files: [...] }`)
- `GET /api/snmp-walk` - Perform SNMP walk with parameters:
  - `target` - Device IP address
  - `oid` - Root OID to walk
  - `version` - SNMP version (1, 2c, 3)
  - `community` - Community string (v1/v2c)
  - `mibs` - Comma-separated list of MIB files to use
  - `v3_user`, `v3_auth_proto`, `v3_auth_pwd`, `v3_priv_proto`, `v3_priv_pwd` - SNMPv3 parameters

## Key Implementation Details

### MIB Manager (`lib/mib-manager.js`)
- Uses net-snmp's built-in module store for MIB parsing
- Translates numeric OIDs to human-readable names
- Handles enum value mapping from MIB definitions
- Supports `.txt`, `.mib`, and `.my` file extensions

### SNMP Walk Processing (`server.js`)
- The `processToTables()` function groups OID results into tables using a heuristic:
  1. Groups by parent OID (column identification)
  2. Groups columns by their parent (table identification)
  3. Aligns rows by index values

### Data Flow
1. User selects MIB files and configures SNMP parameters
2. Server performs SNMP subtree walk
3. Results enriched with MIB metadata (names, descriptions, enums)
4. Data grouped into tables for display
5. Can export to CSV/TXT or generate Telegraf JSON config

## InfluxDB Integration Context

The tool produces JSON configurations for Telegraf with:
- **Measurement**: Equipment class (ups, pdu, cooling, etc.)
- **Tags**: `device_sn` (serial number), `metric` (parameter name)
- **Fields**: Numeric values stored raw; text/events converted to 0/1

## Development Notes

- The application runs on port 3000
- MIB files are stored in the `mibs/` directory
- Frontend is a single HTML file with embedded JavaScript
- No build step required for frontend changes
