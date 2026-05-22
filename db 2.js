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
    CREATE TABLE IF NOT EXISTS partecipazioni (
      id          SERIAL PRIMARY KEY,
      sessione_id VARCHAR NOT NULL,
      utente_id   VARCHAR NOT NULL,
      risposta    VARCHAR NOT NULL DEFAULT 'si',
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(sessione_id, utente_id)
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

  await query(`
    CREATE TABLE IF NOT EXISTS fipav_matches (
      id              VARCHAR PRIMARY KEY,
      fonte           VARCHAR   NOT NULL,
      categoria       VARCHAR   NOT NULL DEFAULT '',
      cid             VARCHAR,
      tid             VARCHAR,
      giornata        VARCHAR   DEFAULT '',
      data_ora        TIMESTAMPTZ,
      casa            VARCHAR   NOT NULL,
      ospite          VARCHAR   NOT NULL,
      risultato       VARCHAR   DEFAULT '',
      played          BOOLEAN   DEFAULT false,
      postponed       BOOLEAN   DEFAULT false,
      parziali        JSONB,
      luogo           VARCHAR   DEFAULT '',
      logo_home       VARCHAR   DEFAULT '',
      logo_away       VARCHAR   DEFAULT '',
      match_url       VARCHAR   DEFAULT '',
      classifica_url  VARCHAR   DEFAULT '',
      result_fetched  BOOLEAN   DEFAULT false,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS fipav_classifica_cache (
      id          SERIAL PRIMARY KEY,
      categoria   VARCHAR   NOT NULL,
      fonte       VARCHAR   NOT NULL,
      cid         VARCHAR,
      tid         VARCHAR,
      squadre     JSONB     NOT NULL DEFAULT '[]',
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await query(`CREATE UNIQUE INDEX IF NOT EXISTS fipav_cl_cid_idx ON fipav_classifica_cache (cid, fonte) WHERE cid IS NOT NULL`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS fipav_cl_tid_idx ON fipav_classifica_cache (tid) WHERE tid IS NOT NULL`);

  // Aggiornamenti schema per DB già esistenti
  await query(`ALTER TABLE calendario ADD COLUMN IF NOT EXISTS ripetizione_settimanale BOOLEAN DEFAULT false`);
  await query(`ALTER TABLE calendario ADD COLUMN IF NOT EXISTS tipo VARCHAR DEFAULT 'allenamento'`);
  await query(`ALTER TABLE calendario ADD COLUMN IF NOT EXISTS foto VARCHAR DEFAULT ''`);
  await query(`ALTER TABLE squadra ADD COLUMN IF NOT EXISTS sesso VARCHAR DEFAULT 'Femminile'`);
  await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS sconto INTEGER DEFAULT 0`);
  await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS quantita INTEGER DEFAULT -1`);
  await query(`ALTER TABLE utenti ADD COLUMN IF NOT EXISTS is_atleta BOOLEAN DEFAULT false`);
  await query(`ALTER TABLE utenti ADD COLUMN IF NOT EXISTS is_allenatore BOOLEAN DEFAULT false`);
  await query(`ALTER TABLE utenti ADD COLUMN IF NOT EXISTS squadre JSONB DEFAULT '[]'`);
  await query(`ALTER TABLE utenti ADD COLUMN IF NOT EXISTS squadre_atleta JSONB DEFAULT '[]'`);
  await query(`ALTER TABLE utenti ADD COLUMN IF NOT EXISTS squadre_allenatore JSONB DEFAULT '[]'`);
  await query(`ALTER TABLE utenti ADD COLUMN IF NOT EXISTS ruolo_atleta VARCHAR DEFAULT ''`);
  await query(`ALTER TABLE utenti ADD COLUMN IF NOT EXISTS ruolo_allenatore VARCHAR DEFAULT ''`);
  await query(`ALTER TABLE calendario ADD COLUMN IF NOT EXISTS palestra_id VARCHAR DEFAULT ''`);
  await query(`ALTER TABLE calendario DROP COLUMN IF EXISTS luogo`);
  await query(`ALTER TABLE fipav_matches ADD COLUMN IF NOT EXISTS addetto_arbitro VARCHAR DEFAULT ''`);
  await query(`ALTER TABLE fipav_matches ADD COLUMN IF NOT EXISTS refertista VARCHAR DEFAULT ''`);
  await query(`ALTER TABLE fipav_matches ADD COLUMN IF NOT EXISTS is_casa BOOLEAN DEFAULT false`);
  await query(`ALTER TABLE fipav_matches ADD COLUMN IF NOT EXISTS addetto_staff_id VARCHAR DEFAULT ''`);
  await query(`ALTER TABLE fipav_matches ADD COLUMN IF NOT EXISTS refertista_staff_id VARCHAR DEFAULT ''`);

  await query(`
    CREATE TABLE IF NOT EXISTS assegnazioni_partita (
      id          VARCHAR PRIMARY KEY,
      partita_id  VARCHAR NOT NULL,
      utente_id   VARCHAR NOT NULL,
      ruolo       VARCHAR NOT NULL,
      stato       VARCHAR DEFAULT 'attesa',
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_assegn_partita_ruolo ON assegnazioni_partita(partita_id, ruolo)`);

  await query(`
    CREATE TABLE IF NOT EXISTS staff_arbitrale (
      id         VARCHAR PRIMARY KEY,
      utente_id  VARCHAR DEFAULT '',
      nome       VARCHAR NOT NULL,
      cognome    VARCHAR NOT NULL,
      ruolo      VARCHAR DEFAULT 'entrambi',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS palestres (
      id         VARCHAR PRIMARY KEY,
      nome       VARCHAR NOT NULL,
      indirizzo  VARCHAR DEFAULT '',
      orari      JSONB   DEFAULT '[]',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS utenti (
      id              VARCHAR PRIMARY KEY,
      email           VARCHAR UNIQUE NOT NULL,
      nome            VARCHAR NOT NULL,
      cognome         VARCHAR NOT NULL,
      telefono        VARCHAR DEFAULT '',
      password_hash   VARCHAR,
      stato           VARCHAR DEFAULT 'in_attesa',
      setup_token     VARCHAR,
      setup_token_exp TIMESTAMPTZ,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
  `);

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
