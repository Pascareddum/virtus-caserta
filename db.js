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
  await query(`ALTER TABLE calendario ADD COLUMN IF NOT EXISTS formato VARCHAR DEFAULT ''`);
  await query(`ALTER TABLE calendario ADD COLUMN IF NOT EXISTS responsabile VARCHAR DEFAULT ''`);
  await query(`ALTER TABLE tornei ADD COLUMN IF NOT EXISTS responsabile VARCHAR DEFAULT ''`);
  await query(`ALTER TABLE tornei ADD COLUMN IF NOT EXISTS immagine VARCHAR DEFAULT ''`);
  await query(`ALTER TABLE tornei ADD COLUMN IF NOT EXISTS palestra_nome VARCHAR DEFAULT ''`);
  await query(`ALTER TABLE tornei ADD COLUMN IF NOT EXISTS palestra_slots JSONB DEFAULT '[]'`);
  await query(`ALTER TABLE tornei ADD COLUMN IF NOT EXISTS best_of INTEGER DEFAULT 3`);
  await query(`ALTER TABLE squadra ADD COLUMN IF NOT EXISTS utente_id VARCHAR DEFAULT ''`);
  await query(`ALTER TABLE fipav_matches ADD COLUMN IF NOT EXISTS addetto_arbitro VARCHAR DEFAULT ''`);
  await query(`ALTER TABLE fipav_matches ADD COLUMN IF NOT EXISTS refertista VARCHAR DEFAULT ''`);
  await query(`ALTER TABLE fipav_matches ADD COLUMN IF NOT EXISTS is_casa BOOLEAN DEFAULT false`);
  await query(`
    UPDATE fipav_matches SET is_casa = true
    WHERE is_casa = false AND luogo IS NOT NULL AND luogo != ''
      AND (
        LOWER(luogo) LIKE '%tenda di abramo%' OR
        LOWER(luogo) LIKE '%tensostruttura%' OR
        LOWER(luogo) LIKE '%isis a. manzoni%' OR
        LOWER(luogo) LIKE '%palestra isis%'
      )
  `);
  await query(`ALTER TABLE fipav_matches ADD COLUMN IF NOT EXISTS addetto_staff_id VARCHAR DEFAULT ''`);
  await query(`ALTER TABLE fipav_matches ADD COLUMN IF NOT EXISTS refertista_staff_id VARCHAR DEFAULT ''`);
  await query(`ALTER TABLE squadre_homepage ADD COLUMN IF NOT EXISTS categorie JSONB DEFAULT '[]'`);
  await query(`ALTER TABLE squadre_homepage ADD COLUMN IF NOT EXISTS bg_position VARCHAR DEFAULT '50% 50%'`);

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
    CREATE TABLE IF NOT EXISTS squadre_homepage (
      id              VARCHAR PRIMARY KEY,
      nome            VARCHAR NOT NULL,
      badge           VARCHAR DEFAULT '',
      sottotitolo     VARCHAR DEFAULT '',
      immagine        VARCHAR DEFAULT '',
      accent_color    VARCHAR DEFAULT '#f57c00',
      link_risultati  VARCHAR DEFAULT '',
      link_classifica VARCHAR DEFAULT '',
      link_squadra    VARCHAR DEFAULT '',
      ordine          INTEGER DEFAULT 0,
      featured        BOOLEAN DEFAULT false,
      created_at      TIMESTAMPTZ DEFAULT NOW()
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

  await query(`
    CREATE TABLE IF NOT EXISTS tornei (
      id          VARCHAR PRIMARY KEY,
      nome        VARCHAR NOT NULL,
      formato     VARCHAR DEFAULT '4vs4',
      data_inizio VARCHAR DEFAULT '',
      data_fine   VARCHAR DEFAULT '',
      note        TEXT    DEFAULT '',
      stato       VARCHAR DEFAULT 'bozza',
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS torneo_partecipanti (
      id         SERIAL PRIMARY KEY,
      torneo_id  VARCHAR NOT NULL,
      utente_id  VARCHAR NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(torneo_id, utente_id)
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS torneo_squadre (
      id           VARCHAR PRIMARY KEY,
      torneo_id    VARCHAR NOT NULL,
      nome         VARCHAR NOT NULL,
      colore       VARCHAR DEFAULT '#3b82f6',
      partecipanti JSONB   DEFAULT '[]',
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS torneo_gironi (
      id         VARCHAR PRIMARY KEY,
      torneo_id  VARCHAR NOT NULL,
      nome       VARCHAR NOT NULL,
      ordine     INTEGER DEFAULT 0,
      tipo       VARCHAR DEFAULT 'girone',
      squadre    JSONB   DEFAULT '[]',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS torneo_partite (
      id                VARCHAR PRIMARY KEY,
      torneo_id         VARCHAR NOT NULL,
      girone_id         VARCHAR DEFAULT '',
      squadra_casa_id   VARCHAR DEFAULT '',
      squadra_ospite_id VARCHAR DEFAULT '',
      data_str          VARCHAR DEFAULT '',
      ora               VARCHAR DEFAULT '',
      luogo             VARCHAR DEFAULT '',
      risultato_casa    INTEGER,
      risultato_ospite  INTEGER,
      stato             VARCHAR DEFAULT 'programmata',
      round             VARCHAR DEFAULT '',
      bracket_pos       INTEGER DEFAULT 0,
      in_calendario     BOOLEAN DEFAULT false,
      calendario_id     VARCHAR DEFAULT '',
      note              TEXT    DEFAULT '',
      created_at        TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Push notification preferences
  await query(`ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS notif_live       BOOLEAN DEFAULT true`);
  await query(`ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS notif_notizie    BOOLEAN DEFAULT true`);
  await query(`ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS notif_partite    BOOLEAN DEFAULT true`);
  await query(`ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS notif_campionati JSONB   DEFAULT '[]'`);
  // Migrate old FIPAV/OPES values to empty array (= all categories)
  await query(`UPDATE push_subscriptions SET notif_campionati='[]' WHERE notif_campionati='["FIPAV","OPES"]'::jsonb OR notif_campionati='["OPES","FIPAV"]'::jsonb`);
  await query(`
    CREATE TABLE IF NOT EXISTS partita_notif_log (
      match_id VARCHAR PRIMARY KEY,
      sent_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Migrations for existing torneo tables
  await query(`ALTER TABLE torneo_gironi ADD COLUMN IF NOT EXISTS tipo VARCHAR DEFAULT 'girone'`);
  await query(`ALTER TABLE torneo_gironi ADD COLUMN IF NOT EXISTS squadre JSONB DEFAULT '[]'`);
  await query(`ALTER TABLE torneo_partite ADD COLUMN IF NOT EXISTS round VARCHAR DEFAULT ''`);
  await query(`ALTER TABLE torneo_partite ADD COLUMN IF NOT EXISTS bracket_pos INTEGER DEFAULT 0`);
  try { await query(`ALTER TABLE torneo_partite ALTER COLUMN squadra_casa_id DROP NOT NULL`); } catch(_){}
  try { await query(`ALTER TABLE torneo_partite ALTER COLUMN squadra_ospite_id DROP NOT NULL`); } catch(_){}
  await query(`ALTER TABLE IF EXISTS progetti ADD COLUMN IF NOT EXISTS immagine VARCHAR(500)`);

  // Progetti / Bandi
  await query(`
    CREATE TABLE IF NOT EXISTS progetti (
      id                   SERIAL PRIMARY KEY,
      titolo               VARCHAR(255) NOT NULL,
      descrizione          TEXT,
      immagine             VARCHAR(500),
      pdf_bando            VARCHAR(500),
      data_scadenza        DATE,
      documenti_richiesti  JSONB DEFAULT '[]',
      pubblicato           BOOLEAN DEFAULT false,
      created_at           TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS progetti_domande (
      id           SERIAL PRIMARY KEY,
      progetto_id  INTEGER NOT NULL REFERENCES progetti(id) ON DELETE CASCADE,
      nome         VARCHAR(255),
      cognome      VARCHAR(255),
      email        VARCHAR(255),
      note         TEXT,
      files        JSONB DEFAULT '[]',
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS partite_proposte (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      mittente_id         TEXT NOT NULL,
      data                DATE NOT NULL,
      ora                 TIME NOT NULL,
      ora_fine            TIME,
      luogo               TEXT,
      palestra_id         INTEGER,
      note                TEXT,
      invitati_categorie  JSONB DEFAULT '[]',
      invitati_persone    JSONB DEFAULT '[]',
      stato               TEXT DEFAULT 'pending',
      admin_note          TEXT,
      creato_il           TIMESTAMPTZ DEFAULT now()
    )
  `);

  // RLS — block direct PostgREST/anon-key access; postgres role bypasses automatically
  for (const t of [
    'products', 'ordini', 'notizie', 'calendario', 'squadra', 'galleria',
    'iscrizioni', 'sponsor', 'risultati', 'partecipazioni', 'push_subscriptions',
    'impostazioni', 'log_attivita', 'fipav_matches', 'fipav_classifica_cache',
    'assegnazioni_partita', 'staff_arbitrale', 'palestres', 'squadre_homepage',
    'utenti', 'tornei', 'torneo_partecipanti', 'torneo_squadre', 'torneo_gironi', 'torneo_partite',
    'partite_proposte', 'comunicazioni', 'documenti_utente',
    'progetti', 'progetti_domande',
  ]) {
    try { await query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`); } catch (_) {}
  }

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

/* ─── Backfill: sync squadra.utente_id → utenti.squadre_atleta/allenatore ─── */
async function backfillSquadreUtenti() {
  const COACH_ROLES = ['Allenatore', 'Vice Allenatore', 'Primo allenatore', 'Secondo allenatore', 'Assistente'];
  try {
    // Find users with linked squadra records but empty squadre_atleta and squadre_allenatore
    const res = await query(`
      SELECT DISTINCT s.utente_id
      FROM squadra s
      JOIN utenti u ON u.id = s.utente_id
      WHERE s.utente_id IS NOT NULL AND s.utente_id != ''
        AND s.sesso != 'Staff'
        AND (u.squadre_atleta = '[]'::jsonb OR u.squadre_atleta IS NULL)
        AND (u.squadre_allenatore = '[]'::jsonb OR u.squadre_allenatore IS NULL)
    `);
    if (!res.rows.length) return;
    console.log(`[DB] Backfill squadre: ${res.rows.length} utenti da sincronizzare`);
    for (const { utente_id } of res.rows) {
      const linked = await query(
        `SELECT ruolo, sesso FROM squadra WHERE utente_id=$1 AND (sesso IS NULL OR sesso != 'Staff')`,
        [utente_id]
      );
      const sqAtleta = [], sqAllen = [];
      for (const g of linked.rows) {
        const teams = (g.sesso || '').split(',').map(s => s.trim()).filter(Boolean);
        if (COACH_ROLES.includes(g.ruolo)) { teams.forEach(t => { if (!sqAllen.includes(t)) sqAllen.push(t); }); }
        else { teams.forEach(t => { if (!sqAtleta.includes(t)) sqAtleta.push(t); }); }
      }
      await query(
        `UPDATE utenti SET is_atleta=($1::int > 0), is_allenatore=($2::int > 0), squadre_atleta=$3, squadre_allenatore=$4 WHERE id=$5`,
        [sqAtleta.length, sqAllen.length, JSON.stringify(sqAtleta), JSON.stringify(sqAllen), utente_id]
      );
    }
    console.log('[DB] Backfill squadre completato');
  } catch (err) {
    console.error('[DB] Backfill squadre errore:', err.message);
  }
}

/* ─── Init ─── */
async function init() {
  if (!pool) throw new Error('DATABASE_URL non configurata');
  await createTables();
  await backfillSquadreUtenti();
  console.log('[DB] Inizializzazione completata');
}

module.exports = { query, init, pool };
