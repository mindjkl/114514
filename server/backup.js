const { R } = require("redbean-node");
const path = require("path");
const fs = require("fs");
const knex = require("knex");
const Database = require("./database");
const { log } = require("../src/util");

/**
 * Patch knex SQLite dialect to use @louislam/sqlite3 instead of the default sqlite3 package
 */
function patchSQLiteDialect() {
    const Dialect = require("knex/lib/dialects/sqlite3/index.js");
    Dialect.prototype._driver = () => require("@louislam/sqlite3");
}

/**
 * Type mapping from MySQL/MariaDB to SQLite
 */
const MYSQL_TO_SQLITE_TYPE = {
    "int": "INTEGER",
    "integer": "INTEGER",
    "smallint": "INTEGER",
    "tinyint": "INTEGER",
    "bigint": "INTEGER",
    "mediumint": "INTEGER",
    "decimal": "REAL",
    "float": "REAL",
    "double": "REAL",
    "boolean": "INTEGER",
    "varchar": "TEXT",
    "char": "TEXT",
    "text": "TEXT",
    "tinytext": "TEXT",
    "mediumtext": "TEXT",
    "longtext": "TEXT",
    "datetime": "TEXT",
    "timestamp": "TEXT",
    "date": "TEXT",
    "time": "TEXT",
    "blob": "BLOB",
    "tinyblob": "BLOB",
    "mediumblob": "BLOB",
    "longblob": "BLOB",
};

/**
 * Backup manager for exporting all data to SQLite kuma.db format
 */
class Backup {

    /**
     * Extract the base type from a MySQL column type string (e.g., "varchar(255)" -> "varchar")
     * @param {string} columnType
     * @returns {string}
     */
    static getBaseType(columnType) {
        return columnType.replace(/\(.*\)/, "").trim().toLowerCase();
    }

    /**
     * Map a MySQL column type to SQLite type
     * @param {string} columnType
     * @returns {string}
     */
    static mapType(columnType) {
        const baseType = this.getBaseType(columnType);
        return MYSQL_TO_SQLITE_TYPE[baseType] || "TEXT";
    }

    /**
     * Check if a column is an auto-increment primary key
     * @param {string} extra
     * @returns {boolean}
     */
    static isAutoIncrement(extra) {
        return extra && extra.toUpperCase().includes("AUTO_INCREMENT");
    }

    /**
     * Build a CREATE TABLE statement compatible with SQLite from MySQL column info
     * @param {string} tableName
     * @param {Array} columns
     * @returns {string}
     */
    static buildSQLiteCreateTable(tableName, columns) {
        let cols = [];
        let primaryKeyCol = null;

        for (const col of columns) {
            let sqlType = this.mapType(col.COLUMN_TYPE);
            let colDef = `\`${col.COLUMN_NAME}\` ${sqlType}`;

            if (col.IS_NULLABLE === "NO" && !this.isAutoIncrement(col.EXTRA)) {
                colDef += " NOT NULL";
            }

            if (col.COLUMN_DEFAULT !== null && !this.isAutoIncrement(col.EXTRA)) {
                // Handle default values
                if (col.COLUMN_DEFAULT === "CURRENT_TIMESTAMP" || col.COLUMN_DEFAULT === "current_timestamp()") {
                    colDef += " DEFAULT CURRENT_TIMESTAMP";
                } else if (typeof col.COLUMN_DEFAULT === "string") {
                    colDef += ` DEFAULT '${col.COLUMN_DEFAULT.replace(/'/g, "''")}'`;
                } else {
                    colDef += ` DEFAULT ${col.COLUMN_DEFAULT}`;
                }
            }

            if (this.isAutoIncrement(col.EXTRA)) {
                colDef += " PRIMARY KEY AUTOINCREMENT";
                primaryKeyCol = col.COLUMN_NAME;
            }

            cols.push(colDef);
        }

        return `CREATE TABLE IF NOT EXISTS \`${tableName}\` (${cols.join(", ")})`;
    }

    /**
     * Create a backup SQLite database (kuma.db format) from the current database
     * @returns {Promise<string>} Path to the backup file
     */
    static async createBackup() {
        const backupPath = path.join(Database.dataDir, "kuma.db");

        // Remove existing backup if any
        if (fs.existsSync(backupPath)) {
            fs.unlinkSync(backupPath);
        }

        log.info("backup", "Starting database backup...");

        // If already SQLite, just copy the file
        if (Database.dbConfig.type === "sqlite") {
            log.info("backup", "Source is SQLite, copying file directly");
            fs.copyFileSync(Database.sqlitePath, backupPath);
            log.info("backup", "Backup completed: " + backupPath);
            return backupPath;
        }

        // Create SQLite connection for writing the backup
        patchSQLiteDialect();
        const sqliteKnex = knex({
            client: "sqlite3",
            connection: { filename: backupPath },
            useNullAsDefault: true,
            pool: { min: 1, max: 1 },
        });

        try {
            // Enable WAL mode and foreign keys
            await sqliteKnex.raw("PRAGMA journal_mode = WAL");
            await sqliteKnex.raw("PRAGMA foreign_keys = OFF");

            // Get list of tables from MySQL/MariaDB
            const result = await R.getAll(
                "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ?",
                [Database.dbConfig.dbName]
            );
            let tableNames = result.map((r) => r.TABLE_NAME);

            // Filter out knex migration tables
            const excludeTables = ["knex_migrations", "knex_migrations_lock"];
            tableNames = tableNames.filter((t) => !excludeTables.includes(t));

            log.info("backup", `Found ${tableNames.length} tables to export`);

            for (const tableName of tableNames) {
                log.info("backup", `Exporting table: ${tableName}`);

                // Get column info from MySQL
                const columns = await R.getAll(
                    `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA
                     FROM INFORMATION_SCHEMA.COLUMNS
                     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
                     ORDER BY ORDINAL_POSITION`,
                    [Database.dbConfig.dbName, tableName]
                );

                // Create table in SQLite
                const createStmt = this.buildSQLiteCreateTable(tableName, columns);
                await sqliteKnex.raw(createStmt);

                // Get data from MySQL in chunks
                const chunkSize = 1000;
                let rowOffset = 0;
                let hasMore = true;

                while (hasMore) {
                    const rows = await R.getAll(
                        `SELECT * FROM \`${tableName}\` LIMIT ? OFFSET ?`,
                        [chunkSize, rowOffset]
                    );

                    if (rows.length === 0) {
                        hasMore = false;
                    } else {
                        await sqliteKnex.batchInsert(tableName, rows, 500);
                        rowOffset += rows.length;

                        if (rows.length < chunkSize) {
                            hasMore = false;
                        }
                    }
                }

                log.info("backup", `  Table ${tableName} exported successfully`);
            }

            // Re-enable foreign keys
            await sqliteKnex.raw("PRAGMA foreign_keys = ON");

            // Checkpoint to flush WAL
            await sqliteKnex.raw("PRAGMA wal_checkpoint(TRUNCATE)");

            log.info("backup", "Backup completed successfully: " + backupPath);
        } catch (e) {
            log.error("backup", "Backup failed: " + e.message);
            // Clean up on failure
            if (fs.existsSync(backupPath)) {
                fs.unlinkSync(backupPath);
            }
            throw e;
        } finally {
            await sqliteKnex.destroy();
        }

        return backupPath;
    }
}

module.exports = Backup;