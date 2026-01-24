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

*   **Line Protocol Format:** `measurement,tag1=...,tag2=... field=value timestamp`
*   **JSON Mapping Logic:**
    *   **Measurement:** Defines the equipment class (e.g., `ups`, `pdu`, `cooling`). These are derived from upper MIB branches.
    *   **Tags:** Must include `device_sn` (Serial Number) and `metric` (parameter name).
*   **Hardware Class Examples (PowerNet-MIB):**
    *   `ups` (OID 1.3.6.1.4.1.318.1.1.1)
    *   `environmentalMonitor` (OID 1.3.6.1.4.1.318.1.1.10)
    *   `rPDU` (OID 1.3.6.1.4.1.318.1.1.12)
    *   `airConditioners` (OID 1.3.6.1.4.1.318.1.1.13)
*   **Record Examples:**
    *   `ups,device_sn=XZ001,metric=battery_charge value=87`
    *   `power,device_sn=XZ002,metric=input_voltage value=230`
