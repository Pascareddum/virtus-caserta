'use strict';
const { Pool } = require('pg');

/* ─── Pool ─── */
// Converte l'URL Supabase diretto nel connection pooler (IPv4, più affidabile su Windows)
// db.[ref].supabase.co:5432  →  aws-0-[region].pooler.supabase.com:6543
function buildPoolConfig(url) {
  if (!url) return null;

  // Se è già un URL del pooler, parsa con parametri separati per gestire il punto nell'username
  const poolerMatch = url.match(/^postgresql?:\/\/([^:]+):([^@]+)@(aws-\d+-[\w-]+\.pooler\.supabase\.com):(\d+)\/(\w+)/);
  if (poolerMatch) {
    const [, user, password, host, port, database] = poolerMatch;
    return { user, password, host, port: parseInt(port), database, ssl: { rejectUnauthorized: false } };
  }

  // URL diretto Supabase: converti in pooler usando la variabile SUPABASE_REGION (default: eu-central-1)
  const directMatch = url.match(/^postgresql?:\/\/([^:]+):([^@]+)@db\.([\w]+)\.supabase\.co/);
  if (directMatch) {
    const [, , password, ref] = directMatch;
    const region = process.env.SUPABASE_REGION || 'eu-central-1';
    console.log(`[DB] Connessione via pooler IPv4 (${region})`);
    return {
      user:     'postgres.' + ref,
      password,
      host:     `aws-0-${region}.pooler.supabase.com`,
      port:     6543,
      database: 'postgres',
      ssl:      { rejectUnauthorized: false },
    };
  }

  // Qualsiasi altro URL (es. locale): usa come stringa di connessione
  return { connectionString: url.replace(/[?&]sslmode=\w+/g, ''), ssl: { rejectUnauthorized: false } };
}

const pool = process.env.DATABASE_URL
  ? new Pool(buildPoolConfig(process.env.DATABASE_URL.replace(/['"]/g, '').trim()))
  : null;

function query(text, params) {
  if (!pool) return Promise.reject(new Error('Pool non inizializzato (DATABASE_URL mancante)'));
  return pool.query(text, params);
}

/* ─── Schema ─── */
async function createTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS products (
      id          VARCHAR PRIMARY KEY,
      nome        VARCHAR NOT NULL,
      descrizione TEXT    DEFAULT '',
      prezzo      NUMERIC(10,2) NOT NULL,
      emoji       VARCHAR DEFAULT '🏐',
      disponibile BOOLEAN DEFAULT true,
      taglie      JSONB   DEFAULT '["S","M","L","XL"]',
      immagine    VARCHAR DEFAULT '',
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS ordini (
      id         VARCHAR PRIMARY KEY,
      nome       VARCHAR NOT NULL,
      cognome    VARCHAR NOT NULL,
      email      VARCHAR NOT NULL,
      indirizzo  VARCHAR,
      citta      VARCHAR,
      cap        VARCHAR,
      items      JSONB NOT NULL,
      totale     NUMERIC(10,2) NOT NULL,
      spedizione NUMERIC(10,2) DEFAULT 0,
      metodo     VARCHAR,
      stato      VARCHAR DEFAULT 'ricevuto',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS notizie (
      id         VARCHAR PRIMARY KEY,
      titolo     VARCHAR NOT NULL,
      testo      TEXT    NOT NULL,
      colore     VARCHAR DEFAULT 'blu',
      immagine   VARCHAR DEFAULT '',
      data_str   VARCHAR,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS calendario (
      id                      VARCHAR PRIMARY KEY,
      titolo                  VARCHAR NOT NULL,
      data_str                VARCHAR NOT NULL,
      ora                     VARCHAR NOT NULL,
      luogo                   VARCHAR DEFAULT '',
      categoria               VARCHAR DEFAULT '',
      note                    TEXT    DEFAULT '',
      ripetizione_settimanale BOOLEAN DEFAULT false,
      created_at              TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS squadra (
      id         VARCHAR PRIMARY KEY,
      nome       VARCHAR NOT NULL,
      cognome    VARCHAR NOT NULL,
      numero     INTEGER,
      ruolo      VARCHAR DEFAULT '',
      foto       VARCHAR DEFAULT '',
      bio        TEXT    DEFAULT '',
      attiva     BOOLEAN DEFAULT true,
      sesso      VARCHAR DEFAULT 'Femminile',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS galleria (
      id         VARCHAR PRIMARY KEY,
      album      VARCHAR DEFAULT 'Generale',
      titolo     VARCHAR DEFAULT '',
      immagine   VARCHAR NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS iscrizioni (
      id         VARCHAR PRIMARY KEY,
      nome       VARCHAR NOT NULL,
      cognome    VARCHAR NOT NULL,
      email      VARCHAR NOT NULL,
      telefono   VARCHAR DEFAULT '',
      eta        INTEGER,
      categoria  VARCHAR DEFAULT '',
      messaggio  TEXT    DEFAULT '',
      stato      VARCHAR DEFAULT 'nuova',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS sponsor (
      id         VARCHAR PRIMARY KEY,
      nome       VARCHAR NOT NULL,
      logo       VARCHAR DEFAULT '',
      url        VARCHAR DEFAULT '',
      livello    VARCHAR DEFAULT 'standard',
      attivo     BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS risultati (
      id          VARCHAR PRIMARY KEY,
      data_str    VARCHAR NOT NULL,
      avversario  VARCHAR NOT NULL,
      set_noi     INTEGER NOT NULL,
      set_loro    INTEGER NOT NULL,
      categoria   VARCHAR DEFAULT '',
      tipo        VARCHAR DEFAULT 'campionato',
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id         SERIAL PRIMARY KEY,
      endpoint   TEXT UNIQUE NOT NULL,
      keys       JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS impostazioni (
      chiave     VARCHAR PRIMARY KEY,
      valore     TEXT    DEFAULT '',
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS log_attivita (
      id         SERIAL PRIMARY KEY,
      azione     VARCHAR NOT NULL,
      dettaglio  TEXT    DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Aggiornamenti schema per DB già esistenti
  await query(`ALTER TABLE calendario ADD COLUMN IF NOT EXISTS ripetizione_settimanale BOOLEAN DEFAULT false`);
  await query(`ALTER TABLE squadra ADD COLUMN IF NOT EXISTS sesso VARCHAR DEFAULT 'Femminile'`);

  // Valori default impostazioni
  await query(`
    INSERT INTO impostazioni (chiave, valore) VALUES
      ('nome_associazione', 'Virtus Caserta ASD'),
      ('telefono',          ''),
      ('email_contatto',    ''),
      ('indirizzo',         ''),
      ('iban',              'IT00 X000 0000 0000 0000 0000 000'),
      ('p_iva',             '00000000000')
    ON CONFLICT (chiave) DO NOTHING;
  `);
}

/* ─── Init ─── */
async function init() {
  if (!pool) throw new Error('DATABASE_URL non configurata');
  await createTables();
  console.log('[DB] Inizializzazione completata');
}

module.exports = { query, init, pool };
