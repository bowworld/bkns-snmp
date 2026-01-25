**Telegraf** and **InfluxDB**.

The tool allows administrators to map hardware parameters (via **SNMP** or **Modbus** protocols) into a standardized **JSON** format. This JSON is then consumed by Telegraf to be stored in the InfluxDB time-series database.

## Core Objectives & Data Logic

*   **Universal Connectivity:** Support for any DC engineering equipment via SNMP or Modbus.
*   **Data Transformation:**
    *   **Numeric Values:** Integer or Gauge values are stored in their natural (raw) form.
    *   **Text & Events:** Textual states or event notifications are transformed into discrete binary/numeric values (0 and 1) for efficient storage and alerting.
*   **Metadata & Identity:** Every record in InfluxDB must be associated with the equipment's **Serial Number**. If a serial number is unavailable, a unique identifying label must be provided.
*   **Interoperability:** Produces JSON configurations compatible with Telegraf's input plugins.

## InfluxDB & Telemetry Format

*   **Line Protocol Format:** `<measurement>[,<tag_key>=<tag_value>[,<tag_key>=<tag_value>...]] <field_key>=<field_value>[,<field_key>=<field_value>...] [timestamp]`
*   **Schema Design (Optimized for Cardinality):**
    *   **Measurement:** `snmp` (general) or separate `snmp_numeric` and `snmp_state`.
    *   **Tags:** Used for filtering and grouping.
        *   `zone` (e.g., `ups_room`, `data_cube1`)
        *   `device` (e.g., `ups_1`)
        *   `vendor`, `model`, `site` (optional)
        *   `device_sn` (Serial Number - mandatory identity)
    *   **Fields:** Actual data values.
        *   **Numeric:** `temp_c=42.3`, `load_pct=73.2`, `voltage=230`
        *   **Discrete/States:** `on_battery=0i`, `alarm=1i`, `status_code=3i` (using `i` suffix for integers)
*   **Record Examples:**
    *   `snmp,zone=ups_room,device=ups_1,device_sn=XZ001 temp_c=42.3,load_pct=73.2`
    *   `snmp_state,zone=ups_room,device=ups_1,device_sn=XZ001 on_battery=0i,alarm=1i`

---

**Telegraf** және **InfluxDB**.

Бұл құрал әкімшілерге аппараттық параметрлерді (**SNMP** немесе **Modbus** хаттамалары арқылы) стандартталған **JSON** форматына сәйкестендіруге мүмкіндік береді. Одан кейін бұл JSON деректерін InfluxDB уақыттық тізбектер дерекқорында сақтау үшін Telegraf пайдаланады.

## Негізгі мақсаттар және деректер логикасы

*   **Әмбебап қосылу мүмкіндігі:** SNMP немесе Modbus арқылы кез келген деректер орталығының (DC) инженерлік жабдығын қолдау.
*   **Деректерді түрлендіру:**
    *   **Сандық мәндер:** Бүтін сан немесе Gauge мәндері табиғи (өңделмеген) түрінде сақталады.
    *   **Мәтін және оқиғалар:** Мәтіндік күйлер немесе оқиғалар туралы хабарландырулар тиімді сақтау және хабарлау үшін дискретті екілік/сандық мәндерге (0 және 1) түрлендіріледі.
*   **Метадеректер және сәйкестендіру:** InfluxDB-дегі әрбір жазба жабдықтың **сериялық нөмірімен** (Serial Number) байланыстырылуы керек. Егер сериялық нөмір болмаса, бірегей сәйкестендіру белгісі көрсетілуі тиіс.
*   **Өзара әрекеттесу мүмкіндігі:** Telegraf-тың кіріс плагиндерімен үйлесімді JSON конфигурацияларын жасайды.

## InfluxDB және телеметрия форматы

*   **Line Protocol форматы:** `<measurement>[,<tag_key>=<tag_value>[,<tag_key>=<tag_value>...]] <field_key>=<field_value>[,<field_key>=<field_value>...] [timestamp]`
*   **Схема дизайны (Кардиналдықты оңтайландыру):**
    *   **Measurement (Өлшем):** `snmp` (жалпы) немесе бөлек `snmp_numeric` және `snmp_state`.
    *   **Tags (Тегтер):** Сүзу және топтастыру үшін қолданылады.
        *   `zone` (мысалы, `ups_room`, `data_cube1`)
        *   `device` (мысалы, `ups_1`)
        *   `vendor`, `model`, `site` (міндетті емес)
        *   `device_sn` (Сериялық нөмір - міндетті сәйкестендіру)
    *   **Fields (Өрістер):** Нақты деректер мәндері.
        *   **Сандық:** `temp_c=42.3`, `load_pct=73.2`, `voltage=230`
        *   **Дискретті/Күйлер:** `on_battery=0i`, `alarm=1i`, `status_code=3i` (бүтін сандар үшін `i` суффиксін қолдану)
*   **Жазба мысалдары:**
    *   `snmp,zone=ups_room,device=ups_1,device_sn=XZ001 temp_c=42.3,load_pct=73.2`
    *   `snmp_state,zone=ups_room,device=ups_1,device_sn=XZ001 on_battery=0i,alarm=1i`
