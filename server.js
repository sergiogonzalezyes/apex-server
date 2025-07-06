import Fastify from 'fastify';
import cors from '@fastify/cors';
import { pool } from './db.js';
import chokidar from 'chokidar';
import fs from 'fs';
import path from 'path';

const fastify = Fastify({ logger: true });

await fastify.register(cors, {
  origin: '*',
});


fastify.post('/api/laps', async (req, reply) => {
  const body = req.body;
  console.log('📥 Raw body payload:', JSON.stringify(body, null, 2));

  const sessions = Array.isArray(body) ? body : [body];

  const conn = await pool.getConnection();
  try {
    for (const session of sessions) {
      
      const player = session.players?.[0];
      const carName = player?.car ?? null;
      const trackName = session.track ?? null;
      const userName = player?.name ?? null;

      if (!carName || !trackName || !userName) {
        console.warn(`⚠️ Missing car or track or username. Raw players: ${JSON.stringify(session.players)}, track: ${trackName}, username: ${userName}`);
        continue;
      }

      // ✅ 1. Insert or retrieve user
      let [[userRow]] = await conn.query('SELECT id FROM users WHERE username = ?', [userName]);
      if (!userRow) {
        const [userInsert] = await conn.query('INSERT INTO users (username) VALUES (?)', [userName]);
        userRow = { id: userInsert.insertId };
        console.log(`🆕 Inserted new user: ${userName}`);
      }

      // 1. Insert or retrieve track
      let [[trackRow]] = await conn.query('SELECT id FROM tracks WHERE name = ?', [trackName]);
      if (!trackRow) {
        const [trackInsert] = await conn.query('INSERT INTO tracks (name) VALUES (?)', [trackName]);
        trackRow = { id: trackInsert.insertId };
        console.log(`🆕 Inserted new track: ${trackName}`);
      }

      // 2. Insert or retrieve car
      let [[carRow]] = await conn.query('SELECT id FROM cars WHERE name = ?', [carName]);
      if (!carRow) {
        const [carInsert] = await conn.query('INSERT INTO cars (name) VALUES (?)', [carName]);
        carRow = { id: carInsert.insertId };
        console.log(`🆕 Inserted new car: ${carName}`);
      }

      // 3. Insert or retrieve combo
      let [[comboRow]] = await conn.query(
        'SELECT id FROM combos WHERE car_id = ? AND track_id = ?',
        [carRow.id, trackRow.id]
      );
      if (!comboRow) {
        const [comboInsert] = await conn.query(
          'INSERT INTO combos (car_id, track_id) VALUES (?, ?)',
          [carRow.id, trackRow.id]
        );
        comboRow = { id: comboInsert.insertId };
        console.log(`🆕 Inserted new combo: car_id=${carRow.id}, track_id=${trackRow.id}`);
      }

      // 4. Insert laps
      const laps = session.sessions?.[0]?.laps ?? [];
      for (const lap of laps) {
        await conn.query(
          `INSERT INTO laps (user_id, combo_id, lap_time, valid, sectors)
          VALUES (?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            user_id = VALUES(user_id),
            lap_time = VALUES(lap_time),
            valid = VALUES(valid),
            sectors = VALUES(sectors)`,
          [userRow.id, comboRow.id, lap.time, lap.valid ?? 1, JSON.stringify(lap.sectors)]
        );
      }
      console.log(`✅ Uploaded ${laps.length} lap(s) for ${carName} on ${trackName} by ${userName}`);
    }

    reply.send({ success: true });
  } catch (err) {
    console.error('❌ DB Error:', err);
    reply.status(500).send({ error: 'Internal Server Error' });
  } finally {
    conn.release();
  }
});




fastify.get('/api/best-laps', async (request, reply) => {
  const conn = await pool.getConnection();

  try {
    const [rows] = await conn.query(`
      SELECT
        u.username AS username,
        t.name AS track,
        c.name AS car,
        MIN(l.lap_time) AS best_lap_time
      FROM combos cb
      LEFT JOIN tracks t ON cb.track_id = t.id
      LEFT JOIN cars c ON cb.car_id = c.id
      LEFT JOIN laps l ON l.combo_id = cb.id
      LEFT JOIN users u ON l.user_id = u.id
      GROUP BY u.username, t.name, c.name
      ORDER BY t.name, c.name, u.username
    `);

    reply.send(rows);
  } catch (err) {
    console.error('DB Error:', err);
    reply.status(500).send({ error: 'Database error' });
  } finally {
    conn.release();
  }
});


fastify.get('/api/lap-summary', async (request, reply) => {
  try {
    const [sessionsResult] = await pool.query('SELECT COUNT(*) AS totalSessions FROM laps');
    const [trackResult] = await pool.query('SELECT COUNT(DISTINCT track_id) AS uniqueTracks FROM combos');
    const [carResult] = await pool.query('SELECT COUNT(DISTINCT car_id) AS uniqueCars FROM combos');

    // Correct column names here
    const [fastestLapResult] = await pool.query(`
      SELECT l.lap_time, c.name AS car_name, t.name AS track_name
      FROM laps l
      JOIN combos cb ON l.combo_id = cb.id
      JOIN cars c ON cb.car_id = c.id
      JOIN tracks t ON cb.track_id = t.id
      ORDER BY l.lap_time ASC
      LIMIT 1
    `);

    const fastest = fastestLapResult[0] || {
      lap_time: null,
      car_name: null,
      track_name: null
    };

    reply.send({
      totalSessions: sessionsResult[0].totalSessions,
      uniqueTracks: trackResult[0].uniqueTracks,
      uniqueCars: carResult[0].uniqueCars,
      fastestLap: fastest.lap_time,
      fastestLapCar: fastest.car_name,
      fastestLapTrack: fastest.track_name
    });
  } catch (err) {
    console.error('Summary API Error:', err);
    reply.status(500).send({ error: 'Could not load summary data' });
  }
});


let watcher = null;
let watchPath = null;

function startWatchingFolder(folderPath) {
  if (!fs.existsSync(folderPath)) {
    console.error('Invalid folder path for watcher:', folderPath);
    return;
  }

  if (watcher) {
    watcher.close(); // Stop previous watcher
  }

  console.log(`📂 Watching folder: ${folderPath}`);
  watcher = chokidar.watch(folderPath, { ignoreInitial: true });

  watcher.on('add', async (filePath) => {
    if (!filePath.endsWith('.json')) return;
    try {
      const raw = await fs.promises.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      const normalized = Array.isArray(parsed) ? parsed : [parsed];

      const response = await fastify.inject({
        method: 'POST',
        url: '/api/laps',
        payload: normalized
      });

      const { statusCode } = response;
      if (statusCode === 200) {
        console.log(`✅ Uploaded: ${path.basename(filePath)}`);
      } else {
        console.warn(`⚠️ Upload failed: ${filePath}`);
      }
    } catch (err) {
      console.error(`❌ Error processing file ${filePath}:`, err.message);
    }
  });
}


const configPath = './config.json';

function loadConfig() {
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const cfg = JSON.parse(raw);
    if (cfg.watchPath && fs.existsSync(cfg.watchPath)) {
      watchPath = cfg.watchPath;
      startWatchingFolder(watchPath);
    }
  } catch (e) {
    console.warn('⚠️ Could not load config.json:', e.message);
  }
}

function saveConfig(pathToWatch) {
  fs.writeFileSync(configPath, JSON.stringify({ watchPath: pathToWatch }, null, 2));
}


fastify.post('/api/set-watch-path', async (request, reply) => {
  const { folderPath } = request.body;

  if (!fs.existsSync(folderPath)) {
    return reply.status(400).send({ error: 'Folder does not exist' });
  }

  watchPath = folderPath;
  startWatchingFolder(folderPath);
  saveConfig(folderPath);

  reply.send({ success: true, message: `Now watching: ${folderPath}` });
});



loadConfig();


fastify.listen({ port: 3000, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`🚀 Server listening at ${address}`);
});
