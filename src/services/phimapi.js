// src/services/phimapi.js
const axios = require('axios');
const { redis, BASE_URL, API_CONFIG } = require('../config');
const { cacheMovieDetail, cacheStreamDetails, getTTL } = require('../scripts/preCacheMovies');

const PRECACHE_KEY_SET = 'movieapp:precached_keys';

async function fetchApi(url, params = {}, retries = 3) {
  const cacheKey = `movieapp:api_${url}_${JSON.stringify(params)}`;
  const ttlType = url.includes('the-loai') ? 'categories' :
                  url.includes('quoc-gia') ? 'countries' :
                  url.includes('phim-moi-cap-nhat') ? 'new_movies' :
                  url.includes('phim-bo') ? 'series' : 'new_movies';

  try {
    // Check pre-cache
    if (await redis.sismember(PRECACHE_KEY_SET, cacheKey)) {
      const cached = await redis.get(cacheKey);
      if (cached) {
        console.log(`Pre-cache hit for ${url}`);
        return cached;
      }
    }

    // Check regular cache
    const cached = await redis.get(cacheKey);
    if (cached) {
      console.log(`Cache hit for ${url}`);
      return cached;
    }
  } catch (error) {
    console.error(`Redis get error for ${cacheKey}: ${error.message}`);
  }

  let attempt = 0;
  while (attempt < retries) {
    try {
      const response = await axios.get(url, {
        ...API_CONFIG,
        params: { ...API_CONFIG.defaultParams, ...params },
      });
      let data = response.data;
      if (!data) data = { items: [], totalPages: 0 };
      if (data.data) data = data.data;
      if (!data.items) data.items = Array.isArray(data) ? data : [];
      if (!data.totalPages) {
        data.totalPages =
          data.pagination?.totalPages ||
          data.params?.pagination?.totalPages ||
          data.total_pages ||
          0;
        if (data.totalPages === 0 && data.items.length === params.limit) {
          const nextPage = (params.page || 1) + 1;
          const nextUrl = url.replace(`page=${params.page}`, `page=${nextPage}`);
          const nextResponse = await axios.get(nextUrl, {
            ...API_CONFIG,
            params: { ...API_CONFIG.defaultParams, ...params, page: nextPage },
          });
          const nextData = nextResponse.data.data || nextResponse.data;
          data.totalPages = nextData.items?.length > 0 ? nextPage + 1 : nextPage;
        }
      }
      console.log(`Fetched ${url}: ${data.items.length} items`);
      try {
        await redis.set(cacheKey, data, { ex: getTTL(ttlType) });
        await redis.sadd(PRECACHE_KEY_SET, cacheKey);
      } catch (error) {
        console.error(`Redis set error for ${cacheKey}: ${error.message}`);
      }
      return data;
    } catch (error) {
      attempt++;
      console.error(`Attempt ${attempt} failed for ${url}: ${error.message}`);
      if (attempt >= retries) {
        console.error(`Max retries reached for ${url}`);
        return { items: [], totalPages: 0 };
      }
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
}

async function getCategories() {
  const cacheKey = 'movieapp:categories_version';
  const currentVersion = await redis.get(cacheKey) || '1';
  const dataKey = `movieapp:categories_${currentVersion}`;
  let data = await redis.get(dataKey);
  if (!data) {
    data = await fetchApi(`${BASE_URL}/the-loai`);
    await redis.set(dataKey, data, { ex: getTTL('categories') });
    await redis.set(cacheKey, currentVersion, { ex: getTTL('categories') });
  }
  return Array.isArray(data) ? data : data.items || [];
}

async function getCountries() {
  const cacheKey = 'movieapp:countries_version';
  const currentVersion = await redis.get(cacheKey) || '1';
  const dataKey = `movieapp:countries_${currentVersion}`;
  let data = await redis.get(dataKey);
  if (!data) {
    data = await fetchApi(`${BASE_URL}/quoc-gia`);
    await redis.set(dataKey, data, { ex: getTTL('countries') });
    await redis.set(cacheKey, currentVersion, { ex: getTTL('countries') });
  }
  return Array.isArray(data) ? data : data.items || [];
}

async function getNewMovies(page = 1, limit = 20) {
  return await fetchApi(`${BASE_URL}/danh-sach/phim-moi-cap-nhat`, { page, limit });
}

async function getMoviesByType(type, page = 1, limit = 20) {
  return await fetchApi(`${BASE_URL}/v1/api/danh-sach/${type}`, { page, limit });
}

async function getMoviesByCategory(slug, page = 1, limit = 20) {
  return await fetchApi(`${BASE_URL}/v1/api/the-loai/${slug}`, { page, limit });
}

async function getMoviesByCountry(slug, page = 1, limit = 20) {
  return await fetchApi(`${BASE_URL}/v1/api/quoc-gia/${slug}`, { page, limit });
}

async function searchMovies(keyword, params = {}) {
  const query = new URLSearchParams({
    keyword,
    page: params.page || 1,
    limit: params.limit || 20,
    ...params,
  }).toString();
  return await fetchApi(`${BASE_URL}/v1/api/tim-kiem?${query}`);
}

async function getMovieDetail(slug, forceRefresh = false, retries = 3) {
  if (!slug || typeof slug !== 'string' || slug.includes('/')) {
    console.error(`Invalid slug: ${slug}`);
    return { movie: null, episodes: [] };
  }

  const cacheKey = `movieapp:movie_${slug}`;
  try {
    // Check pre-cache or regular cache
    if (!forceRefresh && (await redis.sismember(PRECACHE_KEY_SET, cacheKey))) {
      const cached = await redis.get(cacheKey);
      if (cached) {
        console.log(`Pre-cache hit for ${cacheKey}`);
        return cached;
      }
    }

    const cached = await redis.get(cacheKey);
    if (cached && !forceRefresh) {
      console.log(`Cache hit for ${slug}`);
      return cached;
    }
  } catch (error) {
    console.error(`Redis get error for ${cacheKey}: ${error.message}`);
  }

  // Fetch online and cache
  return await cacheMovieDetail(slug, retries);
}

async function getStreamDetail(slug, streamId, channelId) {
  const cacheKey = `movieapp:stream_detail_${streamId}`;
  try {
    // Check pre-cache or regular cache
    if (await redis.sismember(PRECACHE_KEY_SET, cacheKey)) {
      const cached = await redis.get(cacheKey);
      if (cached) {
        console.log(`Pre-cache hit for ${cacheKey}`);
        return cached;
      }
    }

    const cached = await redis.get(cacheKey);
    if (cached) {
      console.log(`Cache hit for ${cacheKey}`);
      return cached;
    }
  } catch (error) {
    console.error(`Redis get error for ${cacheKey}: ${error.message}`);
  }

  // Fetch movie details
  const movie = await getMovieDetail(slug, true);
  if (!movie?.movie) {
    console.error(`No movie found for slug: ${slug}`);
    return null;
  }

  const [movieId, serverIndexStr, episodeIndexStr] = streamId.split('_');
  const serverIndex = parseInt(serverIndexStr, 10);
  const episodeIndex = parseInt(episodeIndexStr, 10);

  if (movieId !== movie.movie._id || isNaN(serverIndex) || isNaN(episodeIndex)) {
    console.error(`Invalid streamId format: ${streamId}`);
    return null;
  }

  const episode = movie.episodes?.[serverIndex]?.server_data?.[episodeIndex];
  if (!episode) {
    console.error(`No episode found for streamId: ${streamId}`);
    return null;
  }

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

  const ttl = getTTL('movie_detail', movie.movie.status);
  await redis.set(cacheKey, response, { ex: ttl });
  await redis.sadd(PRECACHE_KEY_SET, cacheKey);
  return response;
}

async function getMultipleMovieDetails(slugs) {
  try {
    const cacheKeys = slugs.map(slug => `movieapp:movie_${slug}`);
    const results = await redis.mget(...cacheKeys);

    const movieDetails = results.map((data, index) => {
      if (data) {
        console.log(`Cache hit for movie_${slugs[index]}`);
        return data;
      }
      return null;
    });

    const missingSlugs = slugs.filter((slug, index) => !movieDetails[index]);
    if (missingSlugs.length > 0) {
      const fetchedDetails = await Promise.all(missingSlugs.map(slug => cacheMovieDetail(slug)));
      fetchedDetails.forEach((data, index) => {
        const slugIndex = slugs.indexOf(missingSlugs[index]);
        movieDetails[slugIndex] = data;
      });
    }
    return movieDetails;
  } catch (error) {
    console.error(`Redis mget error: ${error.message}`);
    return Promise.all(slugs.map(slug => cacheMovieDetail(slug)));
  }
}

module.exports = {
  getCategories,
  getCountries,
  getNewMovies,
  getMoviesByType,
  getMoviesByCategory,
  getMoviesByCountry,
  searchMovies,
  getMovieDetail,
  getStreamDetail,
  getMultipleMovieDetails,
};
