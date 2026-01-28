# SNMP Viewer

[English](#english) | [Қазақша](#қазақша)

---

## English

### Description
SNMP Viewer is a web-based tool designed for visually exploring and managing data from network equipment via the SNMP protocol. It provides an intuitive interface for scanning devices, viewing OID trees, and managing MIB files.

The tool enables administrators to map hardware parameters (via **SNMP** or **Modbus** protocols) into a standardized **TOML** format, which can then be consumed by **Telegraf** for storage in an **InfluxDB** time-series database.

### Key Features
- **Device Scanning**: Supports SNMP v1, v2c, and v3.
- **MIB Management**: Upload, view, and delete custom MIB files to translate OIDs into human-readable names.
- **Visual Tables**: Automatically groups related SNMP data into responsive tables.
- **Stop & Reset**: Instantly abort long-running scans and reset the interface.
- **Dual Scrollbars**: Specifically designed for large tables, allowing horizontal scrolling from both top and bottom of the table.
- **Data Export**: Export scan results to CSV or TXT formats for further analysis.
- **Dockerized**: Easy deployment using Docker and Docker Compose.

### Core Objectives & Data Logic
*   **Universal Connectivity:** Support for any DC engineering equipment via SNMP or Modbus.
*   **Data Transformation:**
    *   **Numeric Values:** Integer or Gauge values are stored in their natural (raw) form.
    *   **Text & Events:** Textual states or event notifications are transformed into discrete binary/numeric values (0 and 1) for efficient storage and alerting.
*   **Metadata & Identity:** Every record in InfluxDB must be associated with the equipment's **Serial Number**. If unavailable, a unique identifying label is used.
*   **Interoperability:** Produces TOML configurations compatible with Telegraf's input plugins.

### InfluxDB & Telemetry Format
*   **Line Protocol Format:** `measurement,tag1=...,tag2=... field=value timestamp`
*   **TOML Mapping Logic:**
    *   **Measurement:** Defines the equipment class (e.g., `ups`, `pdu`, `cooling`).
    *   **Tags:** Includes `device_sn` (Serial Number) and `metric` (parameter name).

### Quick Start
1. Ensure you have Docker and Docker Compose installed.
2. Clone the repository.
3. Run `docker compose up -d --build`.
4. Open the SNMP Viewer at `http://localhost:3000`.
5. Open Grafana at `http://localhost:3001` (login: `admin` / `password: admin`).

---

## Қазақша

### Сипаттамасы
SNMP Viewer — бұл SNMP протоколы арқылы желілік жабдықтан деректерді көрнекі түрде зерттеуге және басқаруға арналған веб-құрал. Ол құрылғыларды сканерлеуге, OID ағаштарын қарауға және MIB файлдарын басқаруға арналған интуитивті интерфейсті ұсынады.

Бұл құрал әкімшілерге аппараттық параметрлерді (**SNMP** немесе **Modbus** хаттамалары арқылы) стандартталған **TOML** форматына сәйкестендіруге мүмкіндік береді. Одан кейін бұл TOML деректерін InfluxDB уақыттық тізбектер дерекқорында сақтау үшін **Telegraf** пайдаланады.

### Негізгі мүмкіндіктері
- **Құрылғыны сканерлеу**: SNMP v1, v2c және v3 нұсқаларын қолдайды.
- **MIB басқару**: OID-терді адам оқи алатын атауларға аудару үшін жеке MIB файлдарын жүктеу, қарау және жою.
- **Көрнекі кестелер**: Байланысты SNMP деректерін автоматты түрде бейімделген кестелерге топтастырады.
- **Тоқтату және қайта жүктеу (Stop & Reset)**: Ұзақ уақытқа созылған сканерлеуді бірден тоқтату және интерфейсті басып тастау.
- **Қос айналдыру жолағы (Dual Scrollbars)**: Үлкен кестелер үшін арнайы жасалған, кестенің үстіңгі және астыңғы жағынан көлденең айналдыруға мүмкіндік береді.
- **Деректерді экспорттау**: Кейінірек талдау үшін сканерлеу нәтижелерін CSV немесе TXT форматтарына экспорттау.
- **Docker негізінде**: Docker және Docker Compose көмегімен оңай орналастыру.

### Негізгі мақсаттар және деректер логикасы
*   **Әмбебап қосылу мүмкіндігі:** SNMP немесе Modbus арқылы кез келген деректер орталығының (DC) инженерлік жабдығын қолдау.
*   **Деректерді түрлендіру:**
    *   **Сандық мәндер:** Бүтін сан немесе Gauge мәндері табиғи (өңделмеген) түрінде сақталады.
    *   **Мәтін және оқиғалар:** Мәтіндік күйлер немесе оқиғалар туралы хабарландырулар тиімді сақтау және хабарлау үшін дискретті екілік/сандық мәндерге (0 және 1) түрлендіріледі.
*   **Метадеректер және сәйкестендіру:** InfluxDB-дегі әрбір жазба жабдықтың **сериялық нөмірімен** (Serial Number) байланыстырылуы керек.
*   **Өзара әрекеттесу мүмкіндігі:** Telegraf-тың кіріс плагиндерімен үйлесімді TOML конфигурацияларын жасайды.

### InfluxDB және телеметрия форматы
*   **Line Protocol форматы:** `measurement,tag1=...,tag2=... field=value timestamp`
*   **TOML сәйкестендіру (Map) логикасы:**
    *   **Measurement (Өлшем):** Жабдық класын анықтайды (мысалы, `ups`, `pdu`, `cooling`). Олар MIB-тің жоғарғы тармақтарынан алынады.
    *   **Tags (Тегтер):** `device_sn` (сериялық нөмір) және `metric` (параметр атауы) міндетті түрде қосылуы керек.

### Жылдам бастау
1. Компьютеріңізде Docker және Docker Compose орнатылғанына көз жеткізіңіз.
2. Репозиторийді клондаңыз.
3. `docker compose up -d --build` командасын орындаңыз.
4. SNMP Viewer қосымшасын `http://localhost:3000` мекенжайынан ашыңыз.
5. Grafana-ны `http://localhost:3001` мекенжайынан ашыңыз (логин: `admin` / `құпия сөз: admin`).
