// src/services/phimapi.js
const axios = require('axios');
const { redis, BASE_URL, API_CONFIG, TTL } = require('../config');

async function fetchApi(url, options = {}) {
  const cacheKey = `movieapp:${url}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached) return cached;

    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await axios.get(url, { ...API_CONFIG, ...options });
        break;
      } catch (error) {
        if (attempt === 2) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }

    let data = response.data?.data || response.data;
    data = Array.isArray(data) ? data : data.items || [];

    // Set TTL for movie details based on status
    if (url.includes('/phim/') && data.movie && data.movie.status) {
      const validStatuses = ['ongoing', 'completed'];
      if (validStatuses.includes(data.movie.status)) {
        const ttl = data.movie.status === 'ongoing' ? TTL.SERIES : TTL.DETAILS;
        console.log(`Caching ${url} with TTL ${ttl} seconds (status: ${data.movie.status})`);
        await redis.set(cacheKey, data, { ex: ttl });
      } else {
        console.log(`Caching ${url} without TTL (invalid status: ${data.movie.status})`);
        await redis.set(cacheKey, data);
      }
    } else {
      // Non-movie data or missing status: cache without TTL
      console.log(`Caching ${url} without TTL (no status or non-movie data)`);
      await redis.set(cacheKey, data);
    }

    return data;
  } catch (error) {
    console.error(`Error fetching ${url}: ${error.message}`);
    return { items: [], totalPages: 0 };
  }
}

async function cacheMovieDetail(slug) {
  try {
    const cacheKey = `movieapp:${BASE_URL}/phim/${slug}`;
    const cached = await redis.get(cacheKey);
    if (cached) return cached;

    const data = await fetchApi(`${BASE_URL}/phim/${slug}`);
    if (!data?.movie?._id) {
      console.error(`Invalid movie data for slug: ${slug}`);
      return null;
    }

    // TTL already handled by fetchApi, but log for clarity
    console.log(`Cached movie detail for slug: ${slug} (status: ${data.movie.status || 'none'})`);
    return data;
  } catch (error) {
    console.error(`Error caching movie ${slug}: ${error.message}`);
    return null;
  }
}

async function getCategories() {
  const data = await fetchApi(`${BASE_URL}/the-loai`);
  return Array.isArray(data) ? data : data.items || [];
}

async function getCountries() {
  const data = await fetchApi(`${BASE_URL}/quoc-gia`);
  return Array.isArray(data) ? data : data.items || [];
}

async function getNewMovies(page = 1) {
  const data = await fetchApi(`${BASE_URL}/danh-sach/phim-moi-cap-nhat?page=${page}`);
  return { items: data.items || [], totalPages: data.totalPages || 0 };
}

async function getMoviesByType(type, page = 1, size = 36) {
  const data = await fetchApi(`${BASE_URL}/danh-sach/${type}?page=${page}&limit=${size}`);
  return { items: data.items || [], totalPages: data.totalPages || 0 };
}

async function getMoviesByCategory(slug, page = 1, size = 36) {
  const data = await fetchApi(`${BASE_URL}/the-loai/${slug}?page=${page}&limit=${size}`);
  return { items: data.items || [], totalPages: data.totalPages || 0 };
}

async function getMoviesByCountry(slug, page = 1, size = 36) {
  const data = await fetchApi(`${BASE_URL}/quoc-gia/${slug}?page=${page}&limit=${size}`);
  return { items: data.items || [], totalPages: data.totalPages || 0 };
}

async function searchMovies(keyword, page = 1, size = 12) {
  const data = await fetchApi(`${BASE_URL}/tim-kiem?keyword=${encodeURIComponent(keyword)}&page=${page}&limit=${size}`);
  return { items: data.items || [], totalPages: data.totalPages || 0 };
}

async function getMovieDetail(slug) {
  return await cacheMovieDetail(slug);
}

async function getStreamDetail(slug, streamId) {
  const data = await fetchApi(`${BASE_URL}/xem-phim/${slug}/${streamId}`);
  return data?.movie || null;
}

async function getMultipleMovieDetails(slugs) {
  const promises = slugs.map(slug => cacheMovieDetail(slug));
  const results = await Promise.all(promises);
  return results.filter(Boolean);
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
  cacheMovieDetail,
};
