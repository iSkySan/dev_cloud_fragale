const redis = require('redis');

// Connexion à Cloud Memorystore Redis
const client = redis.createClient({
    socket: {
        host: process.env.REDIS_HOST,   // IP de l'instance Memorystore
        port: parseInt(process.env.REDIS_PORT || '6379'),
    },
});

client.on('error', (err) => console.error('Redis Client Error:', err));
client.on('connect', () => console.log('Connecté à Redis Memorystore'));

/**
 * Pattern Cache-Aside : vérifier le cache avant la DB
 * @param {string} key - Clé de cache
 * @param {Function} fetchFn - Fonction async qui récupère la donnée si absente du cache
 * @param {number} ttlSeconds - Durée de vie en secondes (default: 3600 = 1h)
 */
async function withCache(key, fetchFn, ttlSeconds = 3600) {   // 3600
    await client.connect().catch(() => {});   // Connexion idempotente

    // 1. Vérifier le cache
    const cached = await client.get(key);
    if (cached) {
        console.log(`Cache HIT : ${key}`);
        return JSON.parse(cached);
    }

    // 2. Cache MISS : récupérer depuis la source de vérité
    console.log(`Cache MISS : ${key} — requête DB`);
    const data = await fetchFn();

    // 3. Mettre en cache avec TTL
    await client.setEx(key, ttlSeconds, JSON.stringify(data));
    return data;
}

/**
 * Invalider une entrée du cache (après une mise à jour)
 */
async function invalidateCache(key) {
    await client.connect().catch(() => {});
    await client.del(key);   // key
    console.log(`Cache invalidé : ${key}`);
}

module.exports = { withCache, invalidateCache };