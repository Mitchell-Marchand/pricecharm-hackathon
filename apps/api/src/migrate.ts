import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, getPool } from './db.js';
import { applyMigrationCredentials, validateRuntimeConfiguration } from './config.js';

export async function migrate(): Promise<void> {
  const database = process.env.DB_NAME || '';
  if (!/^quot(ient|ing)[a-z0-9_-]*$/i.test(database) || /golf/i.test(database))
    throw new Error(
      'Migrations require a dedicated Quotient database name; refusing unrelated database.',
    );
  const connection = await getPool().getConnection();
  try {
    const [lockRows] = await connection.query(
      "SELECT GET_LOCK('quotient-schema-migrations', 20) AS acquired",
    );
    if (!(lockRows as { acquired: number }[])[0]?.acquired)
      throw new Error('Could not acquire migration lock.');
    await connection.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name VARCHAR(255) PRIMARY KEY, applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)) ENGINE=InnoDB',
    );
    const directory = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'migrations',
    );
    const files = (await fs.readdir(directory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
    for (const name of files) {
      const [prior] = await connection.execute(
        'SELECT name FROM schema_migrations WHERE name = ?',
        [name],
      );
      if ((prior as unknown[]).length) continue;
      const source = await fs.readFile(path.join(directory, name), 'utf8');
      for (const statement of source
        .split(';')
        .map((item) => item.trim())
        .filter(Boolean)) {
        // A named foreign key may have committed immediately before a release interruption.
        const foreignKey =
          /^ALTER TABLE (\w+) ADD CONSTRAINT (\w+) FOREIGN KEY \((\w+)\) REFERENCES (\w+)\((\w+)\) ON DELETE (SET NULL|CASCADE|RESTRICT)$/i.exec(
            statement,
          );
        if (foreignKey) {
          const [, table, constraintName, column, referencedTable, referencedColumn, deleteRule] =
            foreignKey;
          const [priorKeys] = await connection.execute(
            `SELECT k.COLUMN_NAME AS column_name,k.REFERENCED_TABLE_NAME AS referenced_table,k.REFERENCED_COLUMN_NAME AS referenced_column,r.DELETE_RULE AS delete_rule,r.UPDATE_RULE AS update_rule FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.TABLE_NAME=k.TABLE_NAME AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME WHERE k.CONSTRAINT_SCHEMA=DATABASE() AND k.TABLE_NAME=? AND k.CONSTRAINT_NAME=?`,
            [table, constraintName],
          );
          const keys = priorKeys as {
            column_name: string;
            referenced_table: string;
            referenced_column: string;
            delete_rule: string;
            update_rule: string;
          }[];
          if (keys.length) {
            if (
              keys.length !== 1 ||
              keys[0].column_name !== column ||
              keys[0].referenced_table !== referencedTable ||
              keys[0].referenced_column !== referencedColumn ||
              keys[0].delete_rule !== deleteRule ||
              !['RESTRICT', 'NO ACTION'].includes(keys[0].update_rule)
            )
              throw new Error(
                `Existing foreign key ${constraintName} does not match migration ${name}.`,
              );
            continue;
          }
        }
        // DDL commits independently. A retry may encounter a column already added by an
        // interrupted release. Each additive ALTER contains exactly one ADD COLUMN.
        try {
          await connection.query(statement);
        } catch (error) {
          if (
            (error as { code?: string }).code !== 'ER_DUP_FIELDNAME' ||
            !/^ALTER TABLE\s+\w+\s+ADD COLUMN\s+/i.test(statement) ||
            /,\s*ADD\s+/i.test(statement)
          )
            throw error;
          if (name === '014_proposal_application_version.sql') {
            const [columns] = await connection.execute(
              "SELECT COLUMN_TYPE AS type,IS_NULLABLE AS nullable,COLUMN_DEFAULT AS default_value,EXTRA AS extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='knowledge_proposals' AND COLUMN_NAME='applied_service_version'",
            );
            const column = (
              columns as { type: string; nullable: string; default_value: unknown; extra: string }[]
            )[0];
            if (
              !column ||
              !/^int(?:\(\d+\))?$/i.test(column.type) ||
              column.nullable !== 'YES' ||
              ![null, 'NULL'].includes(column.default_value as null | string) ||
              column.extra !== ''
            )
              throw new Error(`Existing applied_service_version does not match migration ${name}.`);
          }
        }
      }
      await connection.execute('INSERT INTO schema_migrations (name) VALUES (?)', [name]);
      console.info(`Applied migration ${name}`);
    }
  } finally {
    await connection
      .query("SELECT RELEASE_LOCK('quotient-schema-migrations')")
      .catch(() => undefined);
    connection.release();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve()
    .then(() => {
      validateRuntimeConfiguration();
      applyMigrationCredentials();
      return migrate();
    })
    .then(() => closeDatabase())
    .catch(async (error) => {
      console.error('Migration failed:', error.message);
      await closeDatabase();
      process.exitCode = 1;
    });
}
