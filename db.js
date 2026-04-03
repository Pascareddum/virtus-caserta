'use strict';
const { Pool } = require('pg');
const fs       = require('fs');
const path     = require('path');

/* ─── Pool ─── */
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : null;

function query(text, params) {
  if (!pool) return Promise.reject(new Error('Pool non inizializzato (DATABASE_URL mancante)'));
  return pool.query(text, params);
}

/* ─── Schema ─── */
async function createTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id                          VARCHAR PRIMARY KEY,
      nome                        VARCHAR NOT NULL,
      cognome                     VARCHAR NOT NULL,
      email                       VARCHAR UNIQUE NOT NULL,
      password_hash               VARCHAR NOT NULL,
      role                        VARCHAR DEFAULT 'user',
      notifiche                   BOOLEAN DEFAULT true,
      email_verificata            BOOLEAN DEFAULT false,
      verification_token          VARCHAR,
      verification_token_expires  TIMESTAMPTZ,
      password_reset_token        VARCHAR,
      password_reset_expires      TIMESTAMPTZ,
      last_login                  TIMESTAMPTZ,
      data_nascita                DATE,
      codice_fiscale              VARCHAR(16),
      telefono                    VARCHAR(20),
      attivo                      BOOLEAN DEFAULT true,
      note_admin                  TEXT,
      certificato_medico_url      VARCHAR,
      certificato_medico_scadenza DATE,
      created_at                  TIMESTAMPTZ DEFAULT NOW()
    );
  `);

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
    CREATE TABLE IF NOT EXISTS notifiche_log (
      chiave     VARCHAR PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS presenze (
      id          VARCHAR PRIMARY KEY,
      user_id     VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sessione_id VARCHAR NOT NULL REFERENCES calendario(id) ON DELETE CASCADE,
      presente    BOOLEAN DEFAULT true,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, sessione_id)
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS ordini (
      id         VARCHAR PRIMARY KEY,
      user_id    VARCHAR REFERENCES users(id) ON DELETE SET NULL,
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

  // Aggiornamenti schema per DB già esistenti
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verificata BOOLEAN DEFAULT false`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_token VARCHAR`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_token_expires TIMESTAMPTZ`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_token VARCHAR`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_expires TIMESTAMPTZ`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TIMESTAMPTZ`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS data_nascita DATE`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS codice_fiscale VARCHAR(16)`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS telefono VARCHAR(20)`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS attivo BOOLEAN DEFAULT true`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS note_admin TEXT`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS certificato_medico_url VARCHAR`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS certificato_medico_scadenza DATE`);
  await query(`ALTER TABLE calendario ADD COLUMN IF NOT EXISTS ripetizione_settimanale BOOLEAN DEFAULT false`);
}

/* ─── Migrazione da JSON ─── */
async function migrateFromJson() {
  /* Users */
  const usersFile = path.join(__dirname, 'users.json');
  if (fs.existsSync(usersFile)) {
    try {
      const users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
      for (const u of users) {
        await query(
          `INSERT INTO users (id, nome, cognome, email, password_hash, role, notifiche, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT DO NOTHING`,
          [
            u.id,
            u.nome,
            u.cognome,
            u.email,
            u.passwordHash,
            u.role || 'user',
            u.notifiche !== false,
            u.createdAt || new Date().toISOString(),
          ]
        );
      }
      console.log(`[DB] Migrati ${users.length} utenti da users.json`);
    } catch (err) {
      console.log('[DB] Errore migrazione users.json:', err.message);
    }
  }

  /* Products */
  const productsFile = path.join(__dirname, 'products.json');
  if (fs.existsSync(productsFile)) {
    try {
      const products = JSON.parse(fs.readFileSync(productsFile, 'utf8'));
      for (const p of products) {
        await query(
          `INSERT INTO products (id, nome, descrizione, prezzo, emoji, disponibile, taglie, immagine)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT DO NOTHING`,
          [
            p.id,
            p.nome,
            p.descrizione || '',
            parseFloat(p.prezzo),
            p.emoji || '🏐',
            p.disponibile !== false,
            JSON.stringify(p.taglie || ['S', 'M', 'L', 'XL']),
            p.immagine || '',
          ]
        );
      }
      console.log(`[DB] Migrati ${products.length} prodotti da products.json`);
    } catch (err) {
      console.log('[DB] Errore migrazione products.json:', err.message);
    }
  }

  /* Notizie */
  const notizieFile = path.join(__dirname, 'notizie.json');
  if (fs.existsSync(notizieFile)) {
    try {
      const notizie = JSON.parse(fs.readFileSync(notizieFile, 'utf8'));
      for (const n of notizie) {
        await query(
          `INSERT INTO notizie (id, titolo, testo, colore, immagine, data_str)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT DO NOTHING`,
          [
            n.id,
            n.titolo,
            n.testo,
            n.colore || 'blu',
            n.immagine || '',
            n.data || null,
          ]
        );
      }
      console.log(`[DB] Migrate ${notizie.length} notizie da notizie.json`);
    } catch (err) {
      console.log('[DB] Errore migrazione notizie.json:', err.message);
    }
  }

  /* Calendario */
  const calendarioFile = path.join(__dirname, 'calendario.json');
  if (fs.existsSync(calendarioFile)) {
    try {
      const sessioni = JSON.parse(fs.readFileSync(calendarioFile, 'utf8'));
      for (const s of sessioni) {
        await query(
          `INSERT INTO calendario (id, titolo, data_str, ora, luogo, categoria, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT DO NOTHING`,
          [
            s.id,
            s.titolo,
            s.data,
            s.ora,
            s.luogo || '',
            s.categoria || '',
            s.note || '',
          ]
        );
      }
      console.log(`[DB] Migrate ${sessioni.length} sessioni da calendario.json`);
    } catch (err) {
      console.log('[DB] Errore migrazione calendario.json:', err.message);
    }
  }

  /* Notifiche log */
  const notificheLogFile = path.join(__dirname, 'notifiche_log.json');
  if (fs.existsSync(notificheLogFile)) {
    try {
      const log = JSON.parse(fs.readFileSync(notificheLogFile, 'utf8'));
      for (const chiave of Object.keys(log)) {
        await query(
          `INSERT INTO notifiche_log (chiave) VALUES ($1) ON CONFLICT DO NOTHING`,
          [chiave]
        );
      }
      console.log(`[DB] Migrate ${Object.keys(log).length} notifiche_log`);
    } catch (err) {
      console.log('[DB] Errore migrazione notifiche_log.json:', err.message);
    }
  }
}

/* ─── Init ─── */
async function init() {
  if (!pool) throw new Error('DATABASE_URL non configurata');
  await createTables();
  await migrateFromJson();
  console.log('[DB] Inizializzazione completata');
}

module.exports = { query, init, pool };
