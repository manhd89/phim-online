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
};
