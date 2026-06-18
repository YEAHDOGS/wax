import { Surreal } from 'surrealdb';

// Create a single SurrealDB instance
const db = new Surreal();

/**
 * Initializes connection to the local SurrealDB instance
 * Default SurrealDB local port is 8000.
 */
export async function initSurreal() {
  try {
    const url = process.env.SURREALDB_URL || 'http://127.0.0.1:8000/rpc';
    
    // Connect to SurrealDB
    await db.connect(url);
    
    // Sign in (use root / root defaults for local SurrealDB)
    await db.signin({
      user: process.env.SURREALDB_USER || 'root',
      pass: process.env.SURREALDB_PASS || 'root'
    });
    
    // Select Namespace and Database
    await db.use({
      namespace: process.env.SURREALDB_NS || 'waxonwax',
      database: process.env.SURREALDB_DB || 'crate'
    });
    
    console.log('SurrealDB client successfully connected and initialized.');
    return db;
  } catch (error) {
    console.error('Failed to initialize SurrealDB connection:', error);
    return null;
  }
}

/**
 * SurrealDB CRUD Operations Helper
 */
export const dbOperations = {
  async getAllRecords() {
    try {
      // Fetch all records from the 'vinyl_record' table in SurrealDB
      const records = await db.select('vinyl_record');
      return records || [];
    } catch (error) {
      console.error('SurrealDB select error:', error);
      return [];
    }
  },

  async createRecord(data) {
    try {
      // Create a record in table 'vinyl_record'
      // SurrealDB automatically generates IDs or we can pass a specific record ID
      const record = await db.create('vinyl_record', data);
      return record;
    } catch (error) {
      console.error('SurrealDB create error:', error);
      return null;
    }
  },

  async deleteRecord(id) {
    try {
      // Delete record in table 'vinyl_record' with record ID
      await db.delete(id);
      return true;
    } catch (error) {
      console.error('SurrealDB delete error:', error);
      return false;
    }
  }
};

export { db };
