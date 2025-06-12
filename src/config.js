// src/config.js
const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

module.exports = {
  // Redis client instance
  redis,

  // Base URL for the PhimAPI
  BASE_URL: 'https://phimapi.com',

  // API configuration for axios
  API_CONFIG: {
    timeout: 10000,
    defaultParams: { sort_field: '_id', sort_type: 'asc' },
  },

  // Time-to-live (TTL) settings for caching (in seconds)
  TTL: {
    CATEGORIES: 30 * 24 * 60 * 60, // 30 days
    COUNTRIES: 30 * 24 * 60 * 60, // 30 days
    NEW_MOVIES: 6 * 60 * 60, // 6 hours
    SERIES: 1 * 60 * 60, // 1 hour
    MOVIE_DETAIL: 30 * 24 * 60 * 60, // 30 days
    ONGOING_SERIES: 1 * 60 * 60, // 1 hour
    PROCESSED_MOVIES: 1 * 60 * 60, // 1 hour
    HOMEPAGE: 1 * 60 * 60, // 1 hour
    SEARCH: 15 * 60, // 15 minutes
    SUGGEST: 15 * 60, // 15 minutes
    SLUGS: 24 * 60 * 60, // 24 hours
  },
};
