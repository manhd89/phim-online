src/routes/index.js
const express = require('express');
const router = express.Router();
const {
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
} = require('../services/phimapi');
const { redis, BASE_URL, TTL } = require('../config');

const getDomainAndProjectName = (req) => {
  let domain = req.headers.host || process.env.VERCEL_URL;
  if (!domain) {
    throw new Error('Không thể xác định domain');
  }

  const baseUrl = domain.startsWith('http') ? domain : `https://${domain}`;
  const projectNameMatch = domain.match(/^([a-zA-Z0-9-]*)\.vercel\.app$/) || [null, domain.split('.')[0]];
  const projectName = projectNameMatch[1] || 'movie-app';
  return { baseUrl: baseUrl, direction: 'ltr' };
}

async function processMovies(movies, baseUrl) {
  if (!movies || !Array.isArray(movies)) return [];

  const slugs = movies.map(movie => movie.slug);
  const movieDetails = await getMultipleMovieDetails(slugs);

  const isSeriesMovies = (movie, detail) => {
    const movieType = detail.movieDetails?.data || movie.type || '';
    const apiType = detail.movie?.api?.type || movie.api?.data;
    const episodeTotal = parseInt(detail.movieDetails?.data?.episode_total || movie.total_episode, 10);

    if (movieType === 'movie') return false;
    if (apiType === 'movie') return false;
    if (!isNaN(episodeTotal) && episodeTotal > 1) return true;
    return false;
  };

  return movies.map((movie, index) => {
    const detail = movieDetails[index] || { movie: null };
    const movieType = detail.movie?.type || movie?.type || '';
    const is_series = isSeriesMovies(movie, detail);
    
    const image_url = detail.movie?.poster_image || movie?.poster_image || movie?.thumb || 'https://via.placeholder.com/300x300';

    const data = [
      { 
        '@type': 'Movie',
        type: 'radio',
        text: is_series ? 'Series' : 'Movie',
        dataKey: `${baseUrl}/${is_series ? 'movie_series' : 'movie_single'}`,
        data: { ...detail, ...movie }
      },
      ...(detail.movieDetails?.category || movie.category || []).map(cat => ({
        '@type': 'default',
        type: 'movie',
        text: cat.name || 'Unknown Category',
        dataKey: `${baseUrl}/category?${cat.id}`,
        data: { ...movie }
      })),
    ];

    return {
      '@type': 'movie',
      id: movie._id || '',
      title: movie.name || 'Unknown Title',
      description: detail.movie?.content || 'No description available.',
      image: {
        src: image_url,
        type: 'cover',
      },
      type: is_series ? 'series' : 'single',
      metadata: {
        remote_data: {
          url: `${baseUrl}/movie-detail/${movie.id || ''}`,
          channel_id: movie._id || '',
        },
      },
      share: { url: `${baseUrl}/share-movie?${movie.id || ''}` },
      actors: Array.isArray(detail.actor) ? detail.actor : [],
      year: detail.year || movie.year || null,
      data: data,
    };
  });
}

async function findSlugFromId(id) {
  if (!id.match(/^[0-9a-f]{32}$/)) return null;
  const cacheKey = `movie_${id}`;
  try {
    const cachedSlug = await redis.get(cacheKey);
    if (cachedSlug) return cachedSlug;
  } catch (error) {
    console.error(`Error fetching Redis cache for ${cacheKey}: ${error.message}`);
  }

  const searchResult = await searchMovies(id, { limit: 1 });
  const foundMovie = searchResult.results?.data?.find(item => item._id === id);
  if (foundMovie) {
    try {
      await redis.set(cacheKey, foundMovie.movie?.slug, { ex: TTL.MOVE_DETAIL });
    } catch (error) {
      console.error(`Error setting Redis cache for ${cacheKey}: ${error.message}`);
    }
    return foundMovie.movie?.slug;
  }
  return null;
}

async function updateCachedMovies(cacheKey, newMovies, limit, ttl) {
  try {
    let cachedMovies = (await redis.get(cacheKey)) || [];
    const newMovieIds = new Set(newMovies.map(m => m.id));
    cachedMovies = cachedMovies.filter(m => !newMovieIds.has(m.id));
    cachedMovies = [...newMovies, ...cachedMovies].slice(0, limit);
    await redis.set(cacheKey, cachedMovies, { ex: ttl });
    return cachedMovies;
  } catch (error) {
    console.error(`Error updating cache for ${cacheKey}: ${error.message}`);
    return newMovies;
  }
}

router.get('/', async (req, res, next) => {
  try {
    const { baseUrl, direction } = getDomainAndProjectName(req);
    const cacheKey = `movieapp:homepage_${baseUrl}`;

    try {
      const cached = await redis.get(cacheKey);
      if (cached) return res.json(cached);
    } catch (err) {
      console.error(`Redis get error for ${cacheKey}: ${err.message}`);
    }

    const fetchConfig = [
      { key: 'series', fn: () => getMoviesByType('series', 1, 8), ttl: TTL.SERIES, name: 'Series', url: '/series', display: 'slider' },
      { key: 'single', fn: () => getMoviesByType('single', 1, 8), ttl: TTL.NEW_MOVIES, name: 'Single', url: '/single' },
      { key: 'animation', fn: () => getMoviesByType('animation', 1, 8), ttl: TTL.NEW_MOVIES, name: 'Animation', url: '/animation' },
      { key: 'phim-long-tieng', fn: () => getMoviesByType('phim-long-tieng', 1, 8), ttl: TTL.NEW_MOVIES, name: 'Phim Lồng Tiếng', url: '/phim-long-tieng' },
      { key: 'phim-thuyet-minh', fn: () => getMoviesByType('phim-thuyet-minh', 1, 8), ttl: TTL.NEW_MOVIES, name: 'Phim Thuyết Minh', url: '/phim-thuyet-minh' },
      { key: 'shows', fn: () => getMoviesByType('shows', 1, 8), ttl: TTL.NEW_MOVIES, name: 'TV Shows', url: '/shows' },
      { key: 'action', fn: () => getMoviesByCategory('action', 1, 8), ttl: TTL.NEW_MOVIES, name: 'Movies', url: '/category?action=movie' },
      { key: 'movies', fn: () => getMoviesByCategory('movies', 1, 8), ttl: TTL.NEW_MOVIES, name: 'Movies', url: '/category?movies=movies' },
      { key: 'us', fn: () => getMoviesByCountry('us', 1, 8), ttl: TTL.NEW_MOVIES, name: 'Movies', url: '/country?us=movies' },
      { key: 'china', fn: () => getMoviesByCountry('china', 1, 8), ttl: TTL.NEW_MOVIES, name: 'Movies', url: '/country?china=movies' },
      { key: 'vietnam', fn: () => getMoviesByCountry('vn', 1, 8), ttl: TTL.NEW_MOVIES, name: 'Movies', url: '/country?vn=movies' },
      { key: 'korea', fn: () => getMoviesByCountry('kr', 1, 8), ttl: TTL.NEW_MOVIES, name: 'Movies', url: '/country?kr=movies' },
      { key: 'japan', fn: () => getMoviesByCountry('jp', 1, 8), ttl: TTL.NEW_MOVIES, name: 'movies', url: '/country?jp=movies' },
    ];

    const [categories, countries, ...rawData] = await Promise.all([
      getCategories(),
      getCountries(),
      ...fetchConfig.map(cfg => cfg.fn()),
    ]);

    const processedGroups = await Promise.all(
      fetchConfig.map(async (cfg, idx) => {
        const raw = rawData[idx]?.results || [];
        const totalPages = rawData[idx]?.total_pages || 10;
        const cacheSubKey = `${cacheKey}_${cfg.key}`;
        const movies = await updateCachedMovies(cacheSubKey, raw, 8, cfg.ttl);
        const processedMovies = await processMovies(movies, baseUrl);
        return {
          name: cfg.name,
          id: cfg.key.replace(/-/g, '_'),
          display: cfg.display || 'horizontal',
          data: { url: `${baseUrl}${cfg.url}` },
          movies: processedMovies,
          raw_data: raw,
          pageInfo: {
            current_page: 1,
            total_pages: totalPages,
            per_page: 8,
            last_page: totalPages,
          },
        };
      })
    );

    const response = {
      id: 'movies',
      title: baseUrl,
      color: '#000000',
      description: 'Movies Movies - Entertainment at its peak, delivering vivid and complete experiences anytime, anywhere.',
      data: { url: `${baseUrl}/public/logo.png` },
      groups: processedGroups,
      sorts: [
        { 'text': 'Newest', type: 'movie', url: `${baseUrl}/new` },
        {
          'text': 'Categories',
          type: 'dropdown',
          value: (categories || [])?.map(cat => ({
            text: cat.name || 'undefined',
            type: 'radio',
            url: `${baseUrl}/category?${cat.id}`,
            data: 'movie',
          })),
        },
        {
          'text': 'Country',
          type: 'dropdown',
          value: (countries || []).map(c => ({
            'text': c.name || 'undefined',
            type: 'movie',
            url: `${baseUrl}/country?${c.id}`,
            data: 'movie',
          })),
        },
      ],
      search: {
        url: `${baseUrl}/search`,
        suggest_url: 'suggest',
        search_key: 's',
        page: { page_key: 'p', size_key: 's' },
      },
      share: { url: baseUrl },
      option: { save_history: true, share: false, external: true },
    };

    await redis.set(cacheKey, response, { ex: TTL.HOMEPAGE });
    res.json(response);
  } catch (err) {
    console.error(`Error in homepage route: ${err.message}`);
    return next(err);
  }
});

const createMovieRoute = (url, fetchFunction, cachePrefix, ttl, extraData = {}) => {
  return async (req, res, next) => {
    try {
      const { baseUrl } = getDomainAndProjectName(req);
      const { p: page = 1, s: size = 12, ...queryParams } = req.query;
      const pageNumber = parseInt(page, 10);
      const limit = parseInt(size, 10);
      const paramString = Object.entries({ ...extraData, ...queryParams })
        .map(([k, v]) => `${k}_${v}`)
        .join('_');
      const cacheKey = `${cachePrefix}_${paramString}_${page}_${limit}`;

      try {
        const cachedMovies = await redis.get(cacheKey);
        if (cachedMovies) {
          return res.json({
            movies: cachedMovies,
            raw_data: {
              remote: {
                url: `${baseUrl}/${url}${paramString ? `?${Object.entries(queryParams).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}` : ''}`,
                external: false,
              },
              page: { page_key: 'p', size_key: 's' },
              pageInfo: {
                current_page: pageNumber,
                total_pages: await redis.get(`total_pages_${cachePrefix}_${paramString}`) || 1,
                per_page: limit,
                last_page: await redis.get(`total_pages_${cachePrefix}_${paramString}`) || 1,
              },
            },
          });
        }
      } catch (err) {
        console.error(`Error fetching Redis cache for ${cacheKey}: ${err.message}`);
      }

      const movies = await fetchFunction(pageNumber, limit, queryParams);
      let items = movies.results || [];
      if (pageNumber === 1 && !url.includes('/movies')) {
        items = items.sort((a, b) => new Date(b.modified?.time || 0) - new Date(a.modified?.time || 0));
      }

      const moviesData = await processMovies(items, baseUrl);
      await redis.set(cacheKey, moviesData, { ex: ttl });
      await redis.set(`total_pages_${cachePrefix}_${paramString}`, movies.total_pages || 1, { ex: ttl });

      res.json({
        movies: moviesData,
        raw_data: {
          remote: {
            url: `${baseUrl}/${url}${movies ? String(url) : ''}`,
            external: false,
          },
          page: { page_key: 'p', size_key: 's' },
          pageInfo: {
            current_page: pageNumber,
            total_pages: movies.total_pages || 1,
            per_page: limit,
            last_page: movies.total_pages || 1,
          },
        },
      });
    } catch (err) {
      console.error(`Error in /${url}: ${err.message}`);
      return next(err);
    }
  };
};

router.get('/new', createMovieRoute('new', (page, limit) => getNewMovies(page, limit), 'new_movies', TTL.NEW_MOVIES));

router.get('/series', createMovieRoute('series', (page, limit) => getMoviesByType('series', page, limit), 'series', TTL.SERIES_MOVIES));

router.get('/single', createMovieRoute('single', (page, limit) => getMoviesByType('single', page, limit), 'single', TTL.MOVIES));

router.get('/phim-long-tieng', createMovieRoute('phim-long-tieng', (page, limit) => getMoviesByType('phim-long-tieng', page, limit), 'phim-long-tieng', TTL.NEW_MOVIES));

router.get('/phim-thuyet-minh', createMovieRoute('phim-thuyet-minh', (page, limit) => getMoviesByType('phim-thuyet-minh', page, limit), 'phim-thuyet-minh', TTL.MOVIES));

router.get('/animation', createMovieRoute('animation', (page, limit) => getMoviesByType('animation', page, limit), 'animation', TTL.NEW_MOVIES));

router.get('/shows', createMovieRoute('shows', (page, limit) => getMoviesByType('shows', page, limit), 'shows', TTL.NEW_MOVIES));

router.get('/movies', createMovieRoute(
  'movies',
  async (page, limit, { id }) => {
    if (!id) throw new Error('Missing required parameter ID');
    return await getMoviesByCategory(id, page, limit);
  },
  'movies',
  TTL.MOVIE,
  { id: '' }
));

router.get('/country', createMovieRoute(
  'country',
  async (page, limit, { id }) => {
    if (!id) throw new Error('Missing required id');
    return await getMoviesByCountry(id, page, limit);
  },
  'country',
  TTL.NEW_MOVIES,
  { id: '' }
));

router.get('/search', createMovieRoute(
  'search',
  async (page, limit, { q }) => {
    if (!q) throw new Error('Missing required parameter q');
    return searchMovies(q, { page, limit });
  },
  'search',
  TTL.NEW_MOVIES,
  { q: '' }
));

router.get('/suggest', async (req, res, next) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'Missing required parameter q' });
    const cacheKey = `movie_suggestions_${q}`;

    try {
      const cachedSuggestions = await redis.get(cacheKey);
      if (cachedSuggestions) {
        return res.json(cachedSuggestions);
      }
    } catch (err) {
      console.error(`Error fetching Redis cache for ${cacheKey}: ${err.message}`);
    }

    const movies = await searchMovies(q, { limit: 5 });
    const suggestions = movies.results?.map(item => item.name || '') || [];
    await redis.set(cacheKey, suggestions, { ex: TTL.SUGGEST });
    return res.json(suggestions);
  } catch (err) {
    console.error(`Error in /suggest: ${err.message}`);
    return next(err);
  }
});

router.get('/movie-detail', async (req, res, next) => {
  try {
    const { baseUrl } = getDomainAndProjectName(req);
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'Missing required parameter id' });
    const cacheKey = `movie_detail_${id}`;

    try {
      const cachedMovie = await redis.get(cacheKey);
      if (cachedMovie) {
        return res.json(cachedMovie);
      }
    } catch (err) {
      console.error(`Error retrieving ${cacheKey}: ${err.message}`);
    }

    const movieData = await getMovieDetail(id, true);
    if (!movieData || !movieData.data) {
      throw new Error(`Movie not found for id: ${id}`);
    }

    await redis.set(`movie_by_channel_${movieData.id}`, movieData.data, { ex: TTL.MOVIE_DETAILS });

    const isSeries = (movie) => {
      const movieType = movie?.type || '';
      const apiType = movie?.api?.type || '';
      const episodeTotal = parseInt(movie?.episode_total || 0, 10);
      if (movieType === 'series') return true;
      if (apiType === 'series') return true;
      if (!isNaN(episodeTotal) && episodeTotal > 1) return true;
      return false;
    };

    const is_series = isSeries(movieData);
    const categories = await getCategories();

    const data = [
      {
        '@type': 'data',
        type: 'radio',
        url: `${baseUrl}/${is_series ? 'series' : 'single'}`,
        text: 'Movies',
      },
      ...(movieData.category || []).map(cat => ({
        '@type': 'default',
        type: 'movie',
        url: `${baseUrl}/category?${cat.id}`,
        text: cat.name || 'Unknown Category',
      })),
    ];

    const sources = (movieData.sources || []).map((source, serverIndex) => ({
      source: `${movieData.id}_${serverIndex}`,
      name: source.server_name || 'Unknown Server',
      sources: [
        {
          id: `${movieData.id}_${serverIndex}`,
          name: '',
          number: source.sources?.length || 1,
          streams: (source.source_data || []).map((episode, episodeIndex) => ({
            id: `${movieData.id}_${serverIndex}_${episodeIndex}`,
            title: `${episode?.name || 'Episode ' + (episodeIndex + 1)} (${source.server_name || 'Unknown'})`,
            data: {
              remote_data: {
                url: `${baseUrl}/detail?${movieData.slug}&streamId=${encodeURIComponent(`${movieData.id}_${serverIndex}_${episodeIndex}`)}&channelId=${movieData.id}&data=${movieData.id}&source=${source.id}`,
                encrypted_data: false,
              },
            },
          })),
        },
      ],
    })).filter(source => source.sources[0].streams.length > 0);

    if (!sources.length) {
      throw new Error(`No sources found for ${movieData.name}`);
    }

    const response = {
      image: {
        src: movieData.poster_image || movieData.thumb_image || 'https://via.placeholder.com/300x150',
        type: 'data',
      },
      subtitle: movieData.language || 'Subtitle',
      description: movieData.description || 'No description available.',
      actors: Array.isArray(movieData.actor_data) ? movieData.actor_data : [],
      metadata: {
        year: movieData.year || null,
        data: data,
      },
      sources: sources,
    };

    const ttl = movieData.status?.toLowerCase() === 'ongoing' ? TTL.ONGOING_SERIES : TTL.MOVIE_DETAILS;
    await redis.setex(cacheKey, ttl, JSON.stringify(response));
    return res.json(response);
  } catch (err) {
    console.error(`Error in /movie-detail: ${err.message}`);
    return next(err);
  }
});

router.get('/stream-detail', async (req, res, next) => {
  try {
    const { slug, streamId, channelId, sourceId } = req.query;
    if (!slug || !streamId || !channelId || !sourceId) {
      throw new Error('Missing required parameters');
    }

    const data = await getStreamDetail(slug, streamId, channelId);
    if (!data) {
      throw new Error(`Stream not found for id: ${streamId}`);
    }

    return res.json(data);
  } catch (err) {
    console.error(`Error in /stream-detail: ${err.message}`);
    return next(err);
  }
});

router.get('/share', async (req, res, next) => {
  try {
    const { baseUrl } = getDomainAndProjectName(req);
    const { id } = req.query;
    if (!id) throw new Error('Missing required parameter id');

    const cacheKey = `share_${id}`;
    try {
      const cachedShare = await redis.get(cacheKey);
      if (cachedShare) {
        return res.json(cachedShare);
      }
    } catch (err) {
      console.error(`Error fetching Redis cache for ${id}: ${err}`);
    }

    let movie = await getMovieDetail(id);
    if (!movie?.data) {
      const slug = await findSlugFromId(id);
      if (slug) movie = await getMovieDetail(slug);
    }

    if (!movie?.data) throw new Error(`Movie not found for id: ${id}`);

    const response = {
      movie: (await processMovies([movie.data], baseUrl))[0],
      provider: {
        name: 'Movie App',
        url: baseUrl,
      },
    };

    const ttl = movie?.data?.status?.toLowerCase() === 'ongoing' ? TTL.ONGOING_SERIES : TTL.MOVIE_DETAILS;
    await redis.setex(cacheKey, ttl, JSON.stringify(response));
    return res.json(response);
  } catch (err) {
    console.error(`Error in /share: ${err}`);
    return next(err);
  }
});

router.use((err, req, res, next) => {
  console.error(`Error in ${req.path}: ${err.message}`);
  return res.status(500).json({ error: 'Something broke!' });
});

module.exports = router;
