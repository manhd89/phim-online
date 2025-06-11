const axios = require('axios');
const { redis, BASE_URL, API_CONFIG, TTL } = require('../config');

// Dynamically import p-limit
let pLimit;
(async () => {
  const module = await import('p-limit');
  pLimit = module.default;
})();

const PRECACHE_KEY_SET = 'movieapp:precached_keys';

async function fetchAllMovieSlugs() {
  const slugs = new Set();
  let page = 1;
  const limit = 100;
  const lastUpdatedKey = 'movieapp:last_updated_slugs';
  const lastUpdated = (await redis.get(lastUpdatedKey)) || new Date(0).toISOString();

  while (true) {
    try {
      const cacheKey = `movieapp:slugs_page_${page}`;
      const cachedSlugs = await redis.get(cacheKey);
      if (cachedSlugs) {
        cachedSlugs.forEach(slug => slugs.add(slug));
        if (cachedSlugs.length < limit) break;
        page++;
        continue;
      }

      const response = await axios.get(`${BASE_URL}/danh-sach/phim-moi-cap-nhat`, {
        ...API_CONFIG,
        params: { page, limit, ...API_CONFIG.defaultParams },
      });
      const data = response.data?.data || { items: [], totalPages: 0 };
      if (!Array.isArray(data.items)) {
        console.error(`Invalid response for page ${page}`);
        break;
      }

      const pageSlugs = data.items
        .filter(item => new Date(item.modified?.time || 0) > new Date(lastUpdated))
        .map(item => item.slug)
        .filter(slug => slug && typeof slug === 'string');
      await redis.set(cacheKey, pageSlugs, { ex: TTL.SLUGS });

      pageSlugs.forEach(slug => slugs.add(slug));
      if (page >= data.totalPages || !data.items.length) break;
      page++;
      await new Promise(resolve => setTimeout(resolve, 300));
    } catch (error) {
      console.error(`Error fetching page ${page}: ${error.message}`);
      break;
    }
  }

  await redis.set(lastUpdatedKey, new Date().toISOString(), { ex: TTL.SLUGS });
  return [...slugs];
}

function validateMovieData(movie) {
  return !!(
    movie &&
    movie._id &&
    movie.name &&
    movie.slug &&
    (movie.poster_url || movie.thumb_url) &&
    movie.content &&
    Array.isArray(movie.category) &&
    Array.isArray(movie.country)
  );
}

async function cacheMovieDetail(slug, retries = 3) {
  if (!slug || typeof slug !== 'string' || slug.includes('/')) {
    console.error(`Invalid slug: ${slug}`);
    return null;
  }

  const cacheKey = `movieapp:movie_${slug}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached && cached.movie?.status !== 'Ongoing') {
      console.log(`Cache hit for ${cacheKey}`);
      return cached;
    }
  } catch (error) {
    console.error(`Redis get error for ${cacheKey}: ${error.message}`);
  }

  let attempt = 0;
  while (attempt < retries) {
    try {
      const response = await axios.get(`${BASE_URL}/phim/${slug}`, API_CONFIG);
      const data = response.data || { movie: null, episodes: [] };
      if (!data.movie || !validateMovieData(data.movie)) {
        console.error(`Invalid data for ${slug}`);
        throw new Error('Invalid movie data');
      }

      const ttl = data.movie.status === 'Ongoing' ? TTL.ONGOING_SERIES : TTL.MOVIE_DETAIL;
      try {
        await redis.set(cacheKey, data, { ex: ttl });
        await redis.set(`movieapp:id_to_slug_${data.movie._id}`, slug, { ex: ttl });
        await redis.sadd(PRECACHE_KEY_SET, cacheKey);
        console.log(`Cached movie: ${slug}`);

        // Cache stream details
        await cacheStreamDetails(data, slug);
      } catch (error) {
        console.error(`Redis set error for ${cacheKey}: ${error.message}`);
        throw error;
      }

      return data;
    } catch (error) {
      attempt++;
      console.error(`Attempt ${attempt} failed for ${slug}: ${error.message}`);
      if (attempt >= retries) {
        console.error(`Max retries for ${slug}`);
        return null;
      }
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
}

async function cacheStreamDetails(movieData, slug) {
  const movieId = movieData.movie._id;
  (movieData.episodes || []).forEach((server, serverIndex) => {
    (server.server_data || []).forEach(async (episode, episodeIndex) => {
      const streamId = `${movieId}_${serverIndex}_${episodeIndex}`;
      const cacheKey = `movieapp:stream_detail_${streamId}`;
      const response = {
        stream_links: [
          {
            id: `default_${movieId}_${serverIndex}_${episodeIndex}`,
            name: episode.name || `Episode ${episodeIndex + 1}`,
            type: 'hls',
            default: false,
            url: episode.link_m3u8 || '',
          },
        ],
      };

      try {
        const ttl = movieData.movie.status === 'Ongoing' ? TTL.ONGOING_SERIES : TTL.MOVIE_DETAIL;
        await redis.set(cacheKey, response, { ex: ttl });
        await redis.sadd(PRECACHE_KEY_SET, cacheKey);
        console.log(`Cached stream detail: ${streamId}`);
      } catch (error) {
        console.error(`Redis set error for ${cacheKey}: ${error.message}`);
      }
    });
  });
}

async function verifyCacheData(slugs) {
  let errors = 0;
  for (const slug of slugs) {
    try {
      const cacheKey = `movieapp:movie_${slug}`;
      const data = await redis.get(cacheKey);
      if (!data || !data.movie || !validateMovieData(data.movie)) {
        console.error(`Verification failed for ${slug}`);
        errors++;
      }
    } catch (error) {
      console.error(`Redis error for ${slug}: ${error.message}`);
      errors++;
    }
  }
  console.log(`Verification: ${errors} errors found`);
  return errors === 0;
}

async function preCacheMovies() {
  console.log('Starting pre-cache...');
  try {
    const slugs = await fetchAllMovieSlugs();
    console.log(`Found ${slugs.length} movies`);

    // Wait for pLimit to be initialized
    while (!pLimit) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const limit = pLimit(10); // Concurrent requests limit
    const batchSize = 10;
    let successCount = 0;
    for (let i = 0; i < slugs.length; i += batchSize) {
      const batch = slugs.slice(i, i + batchSize);
      const results = await Promise.all(batch.map(slug => limit(() => cacheMovieDetail(slug))));
      successCount += results.filter(data => data).length;
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    console.log(`Pre-cached ${successCount}/${slugs.length} movies`);
    const verified = await verifyCacheData(slugs);
    if (!verified) {
      console.error('Verification failed');
      process.exit(1);
    }
    console.log('Pre-cache completed');
  } catch (error) {
    console.error(`Pre-cache failed: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { preCacheMovies, fetchAllMovieSlugs, cacheMovieDetail, cacheStreamDetails };

if (require.main === module) {
  preCacheMovies();
}
