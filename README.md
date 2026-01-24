# SNMP Viewer

[English](#english) | [Қазақша](#қазақша)

---

## English

### Description
SNMP Viewer is a web-based tool designed for visually exploring and managing data from network equipment via the SNMP protocol. It provides an intuitive interface for scanning devices, viewing OID trees, and managing MIB files.

### Key Features
- **Device Scanning**: Supports SNMP v1, v2c, and v3.
- **MIB Management**: Upload, view, and delete custom MIB files to translate OIDs into human-readable names.
- **Visual Tables**: Automatically groups related SNMP data into responsive tables.
- **Dual Scrollbars**: Specifically designed for large tables, allowing horizontal scrolling from both top and bottom of the table.
- **Data Export**: Export scan results to CSV or TXT formats for further analysis.
- **Dockerized**: Easy deployment using Docker and Docker Compose.

### Quick Start
1. Ensure you have Docker and Docker Compose installed.
2. Clone the repository.
3. Run `docker compose up -d --build`.
4. Open the application at `http://localhost:3000`.

---

## Қазақша

### Сипаттамасы
SNMP Viewer — бұл SNMP протоколы арқылы желілік жабдықтан деректерді көрнекі түрде зерттеуге және басқаруға арналған веб-құрал. Ол құрылғыларды сканерлеуге, OID ағаштарын қарауға және MIB файлдарын басқаруға арналған интуитивті интерфейсті ұсынады.

### Негізгі мүмкіндіктері
- **Құрылғыны сканерлеу**: SNMP v1, v2c және v3 нұсқаларын қолдайды.
- **MIB басқару**: OID-терді адам оқи алатын атауларға аудару үшін жеке MIB файлдарын жүктеу, қарау және жою.
- **Көрнекі кестелер**: Байланысты SNMP деректерін автоматты түрде бейімделген кестелерге топтастырады.
- **Қос айналдыру жолағы (Dual Scrollbars)**: Үлкен кестелер үшін арнайы жасалған, кестенің үстіңгі және астыңғы жағынан көлденең айналдыруға мүмкіндік береді.
- **Деректерді экспорттау**: Кейінірек талдау үшін сканерлеу нәтижелерін CSV немесе TXT форматтарына экспорттау.
- **Docker негізінде**: Docker және Docker Compose көмегімен оңай орналастыру.

### Жылдам бастау
1. Компьютеріңізде Docker және Docker Compose орнатылғанына көз жеткізіңіз.
2. Репозиторийді клондаңыз.
3. `docker compose up -d --build` командасын орындаңыз.
4. Қосымшаны `http://localhost:3000` мекенжайынан ашыңыз.
