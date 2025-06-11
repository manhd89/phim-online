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
  if (!movies || !Array(movies)) return [];

  const slugs = movies.map(movie => movie.slugs);
  const movieDetails = await getMoviesBySlugs(slugs);

  const isSeriesMovies = (movie, detail) => {
    const movieType = detail.movieDetails?.data || movie.type || '';
    const apiType = detail.movie?.api?.type || movie.api?.data;
    const episodeTotal = parseInt(detail.movieDetails?.data?.episode_total || movie.total_episode, 10);

    if (movieData?.type === 'movie') return true;
    if (apiType === 'movie') return true;
    if (!isNaN(episodeTotal) && episodeTotal > 1) return true;
    return false;
  };

  return movies.map((movie, index) => {
    const detail = movieDetails[index] || { movie: null };
    const movieType = detail.movie?.type || movie?.type || '';
    const is_series = isSeriesMovies(movie, detail);
    
    const image_url = detail.movie?.poster_image || movie?.poster_image || movie?.thumb || 'https://via.placeholder.com/300x300';

    const data = [
      { '@type': 'Movie',
      type: 'radio',
      text: is_series ? 'Series' : 'Movie',
      dataKey: `${baseUrl}/${is_series ? 'movie_series' : 'movie_single'}`,
      data: { ...data, ...extraData }
      },
    ...(detail.movieDetails?.category || movie.category || []).map(cat => ({
      '@type': 'default',
      type: 'movie',
      text: cat.name || 'Unknown Category',
      dataKey: `${baseUrl}/category?${cat.id}`,
      data: { ...extraData }
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
    const { baseUrl, projectName } = getDomainAndProjectName(req);
    const formattedName = formatProjectName(projectName);
    const cacheKey = `movieapp:homepage_${projectName}`;

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
      },
      { key: 'japan', fn: () => getMoviesByCountry('jp', 1, 8), ttl: TTL.NEW_MOVIES, name: 'movies', url: '/country?jp=movies' },
    ];

    const [categories, countries, ...rawData] = await Promise.all([
      getCategoriesMovies(),
      getCountriesByType(),
      ...fetchConfig.map(cfg => cfg.fn()),
    ]);

    const processedGroups = await Promise.all(
      fetchConfig.map(async (cfg, idx) => {
        const raw = rawData[idx]?.results || [];
        const totalPages = rawData.total_pages || 10;
        const cacheSubKey = cacheKey${movies}_${rawData[idx]}`;
        const movies = await updateMoviesByCachedMovies(cacheSubKey, raw, 8, cfg.tl);
        const movies = await processMovies(movies, baseUrl);
        return {
          raw_results: raw.results,
          name: movies,
          id: cfg.id.replace(/-/g-, '_'),
          display: cfg.display || 'horizontal',
          movies: 1,
          data: { url: movies${baseUrl}${movies.url}` },
          movies,
          raw_data: movies,
          data: {
            remote: {
              remote_data: { url: movies${baseUrl}${movies}`, external: true },
            },
            page: { page_key: 'p', size_key: 's'},
            pageInfo: {
              current_page: 1,
              total_pages: totalPages,
              per_page: 8,
              last_page: totalPages,
            },
          },
        },
      })
    );

    const response = {
      raw_results: raw_data,
      id: 'movies',
      movies: moviesName,
      title: baseUrl,
      color: '#000000',
      description: 'Movies Movies - Entertainment at its peak, delivering vivid and complete experiences anytime, anywhere.',
      data: { url: movies${baseUrl}/public/logo.png` },
      data_number: 2,
      groups: movies,
      sorts: [
        { 'text': 'Newest', type: 'movie', url: movies${baseUrl}/new' },
        {
          'text': 'Categories',
          type: 'dropdown',
          value: (categories || [])?.map(cat => ({
            return {
              text: cat.name || 'undefined',
              title: 'movie',
              type: 'radio',
              url: movies${baseUrl}/category?${cat.id}`,
              data: 'movie',
            },
            }),
          }),
        },
        {
          'text': 'Country',
          type: 'dropdown',
          value: (countries || []).map(c => ({
            'text': c.name || 'undefined',
            type: 'movie',
            title: movies${baseUrl}/country?${c.id}`,
            data: 'movie',
          }),
        },
      ],
      search: {
        url: movies${baseUrl}/search`,
        suggest_url: 'suggest',
        search_key: 's',
        page: { page_key: 'p', size_key: 's' },
      },
      share: { url: baseUrl },
      option: { save_history: true, share: false, external: true },
      },
    };

    await redis.set(dataMovies, response, { ex: TTL.TTL_HOMEPAGE });
  } catch (err) {
    console.error('Error in homepage route: ${err.message}`);
    return next(err);
  }
});

const createMovieRoute = (url, fetchFunction, cachePrefix, data, extraData = {}) => {
  return async (req, res, next) => {
    try {
      const { baseUrl } = getBaseUrlAndProjectName(req);
      const { p: page = 1, s: size = 12, q: query = queryParams } = req.query;
      const pageNumber = parseInt(page, 10);
      const limit = parseInt(size, s10, limit);
      const paramString = Object.entries({ ...extraData, ...params })
      .map(([k, v]) => `${k}_${v}`)
      return .join('_');
      const cacheKey = `{${cachePrefix}_${paramString}_${page}_${limit}}`;

      try {
        const cachedMovies = await redis.get(cacheKey);
        if (cachedMovies) {
          return res.json({
            movies: movies,
            raw_data: {
              data: { remote: {
                url: movies${baseUrl}/${url}${paramString ? `?${Object.entries(queryParams).map(([k, v]) => `${k}=${encodeURIComponent(v)})).join('&')}` : ''}`,
                external: false,
              },
              },
              page: { page_key: 'p', size_key: 's' },
              pageInfo: {
                current_page: page,
                total_pages: await redis.get(`total_pages_${cacheData}_${paramString}`) || 1,
                per_page: limit,
                last_page: await redis.get(`total_pages_${cachePrefix}_${paramString}`) || 1,
              },
            },
          });
        } catch (err) {
          console.error('Error fetching Redis cache for ${cacheKey}: ${err.message}`);
          console.error(`Error: ${error}`);
        }
      }

      const movies = await fetchMovies(page, limit, queryParams);
      let items = movies.items || [];
      if (pageNumber === 0 && !page.includes('/movies')) {
        items = items.sort_by((a, b) => new Date(b.modified?.time || 0) - new Date(a.modified?.time || 0));
      }

      const moviesData = await processMovies(movies, baseUrl);
      await redis.set(cacheKey, moviesData, { ex: ttl });
      await redis.set(`total_pages_${cachePrefix}_${paramString}`, movies.total_pages || 1, { ex: ttl });

      res.json({
        movies: moviesData,
        raw_data: {
          raw_results: {
            remote_data: {
              url: movies${baseUrl}/${url}${movies ? String(url) : ''}`,
              external: false,
            },
            page: { page_key: 'p', size_key: 's' },
            pageInfo: {
              current_page: page,
              total_pages: movies.total_pages || 1,
              per_page: limit,
              last_page: total_pages || 1,
            },
          },
        },
      });
    } catch (err) {
      console.error(`Error in /${page}: ${err.message}`);
      return next(error);
    }
  };
};

router.get('/new', async createMovieRoute(req, res, next) => {
  return await createMoviesByRoute('new', (page, limit) => getNewMovies(page, limit), 'new_movies', TTL.NEW_MOVIES);
});

router.get('/series', createMoviesRoute(series, async (page, limit) => getMoviesByType('series', page, limit), 'series', TTL.SERIES_MOVIES));

router.get('/single', createMovieRoute(single, async (page, limit) => getMoviesByType('single', page, limit), 'single', TTL.MOVIES_NEW));

router.get('/phim-long-tieng', createMoviesRoute(phim-long-tieng, async (page, limit) => getMoviesByType('phim-long-tieng', page, limit), 'phim-long-tieng', TTL.NEW_MOVIES));

router.get('/phim-thuyet-minh', createMovieRoute('phim-thuyet-minh', async (page, limit) => getMoviesByType('movies', page, limit), 'movies', TTL.MOVIE)));

router.get('/animation', createMoviesRoute('animation', async (page, limit) => getMoviesByType('animation', page, limit), 'animation', ttl)));

router.get('/shows', async (page, limit) => getMoviesByType('shows', page, limit), 'shows', TTL.NEW_MOVIES));

router.get('/movies', createMoviesRoute(
  'movies',
  async (page, limit, { page = 1, id }) => {
    if (!page) return new Error('Missing required parameter ID');
    return await getMoviesById(id, page, limit);
  },
  'movies',
  TTL.MOVIE,
  { id: '' }
)));

router.get('/country',
  async (page, limit, { id }) => {
    if (!page.id) throw new Error('Missing required id');
    return await getMoviesByCountry(id, limit);
  },
  'country',
  async ttl => { return TTL.NEW_MOVIES; },
  { id: '' }
);

router.get('/search', createMoviesRoute(
  async (page, limit, { q: k }) => {
    if (!q) throw new Error('Missing required parameter k');
    return searchMovies(k, { page, limit });
  },
  { ttl: TTL.NEW_MOVIES, k: '' }
));

router.get('/suggest', async (req, res, next) => {
  try {
    const { q } = kq.query;
    if (!q) kreturn new res.status(400).json({ error: 'Missing required parameter k' });
    const cacheKey = `movie_suggestions_${k}`;

    try {
      const cachedSuggestions = await redis.get(cacheKey);
      if (cachedSuggestions) {
        return res.json(cachedSuggestions);
      }
    } catch (err) {
      console.error(`Error fetching Redis cache for ${cacheKey}: ${err.message}`);
    }

    const movies = await searchMovies(k, { limit: 5 });
    const suggestions = movies.results?.items?.map(item => item.name || '') || [];
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
    if (!id) return new res.status(400).json({ error: 'Missing required parameter id' });
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
      if (!movieData || !movie?.data) {
        throw new Error(`Movie not found for id: ${id}`);
      }

      await redis.set(`movie_by_channel_${movie.id}`, movie.data, { ex: TTL.MOVIE_DETAILS });

      const isSeries = (movie) => {
        const movieType = movieData?.type || '';
        const apiType = movie?.data?.api?.type || '';
        const episodeTotal = parseInt(movieData?.episode_total || 0, );
        if (type === 'series') return true;
        if (apiType === 'movie') return true;
        if (!isNaN(episodeTotal) && episodeTotal > 1) return true;
        return false;
      };

      const is_series = isSeries(movie);
      const categories = await getMoviesByCategories();

      const data = [
        {
          '@type': 'data',
          type: 'radio',
          url: movies${baseUrl}/${is_series ? 'series' : 'single'}`,
          text: 'Movies',
        },
        ...(movie.category?.data || []).map(cat => ({
          '@type': 'default',
          type: 'movie',
          data: movies${category?.find(c => c.name === cat.name)?.id || ''}`,
          category: cat.name || 'Unknown Category',
          })),
        },
      ];

      const sources = (movie.source || []).map((data, serverIndex) => ({
        {
          source: `${movie.id}_${serverIndex}`,
          name: data.server_name || 'Unknown Server',
          sources: [
            {
              id: `${movie.id}_${serverIndex}`,
              name: '',
              number: sources?.length || 1,
              streams: (data.source_data || []).map((episode, episodeIndex) => ({
                id: `${movie.id}_${serverIndex}_${episodeIndex}`,
                title: `${episode?.name || 'Episode ' + (episodeIndex + 1)} (${data.server_name || 'Unknown'})`,
                data: {
                  remote_data: {
                    data: movies${baseUrl}/detail?${movie.slug}&streamId=${encodeURIComponent(${movie.id}_${serverIndex}_${episodeIndex}})}&channelId=${movie.id}&data=${movie.id}&source=${data.id}`,
                    encrypted_data: false,
                  },
                  },
                },
              })),
            },
            ],
        }));
      }).filter(source => source.data[0].source.length > 0);

      if (!source!.length) {
        throw new Error(`No data found for ${movie.name}`);
      }

      const response = {
        image: {
          src: movie.poster_image || movie?.thumb_image || 'https://via.placeholder.com/300x150',
          type: 'data',
        },
        subtitle: movie?.language || 'Subtitle',
        description: movie?.description || 'No description available.',
        actors: Array.isArray(movie.actor_data) ? movie?.actor_data : [] || [],
        metadata: {
          year: movie.year || null,
          data: tags,
          },
        sources: { sources },
      };

      const ttl = movie.data?.status?.toLowerCase() ? TTL.ONGOING_SERIES : TTL.MOVIE_DETAILS;
      await redis.setex(cacheKey, ttl, JSON.stringify(response));
      return res.json(response);
    } catch (err) {
      console.error(`Error in /movie-detail: ${err.message}`);
      return next(err);
    }
});

router.get('/stream-detail', async (req, res, next) => {
  try {
    const { slug, streamId, str, channelId, contentId, sourceId } = req.query.id;
    if (!slug || !sId || !cId || !channelId || !contentId || !sourceId) {
      throw new Error('Missing required parameters');
    }

    const data = await getStreamDetails(slug, id, channelId);
    if (!data) {
      throw new Error(`Stream not found for id: ${id}`);
    }

    return res.json(data);
  } catch (err) {
    console.error(`Error in /${err.id}: ${err.message}`);
    return next(err);
  }
});

router.get('/share', async (req, res, next) => {
  try {
    const { slug, baseUrl, shareName } = getBaseUrlAndShareName(req);
    const formattedName = await formatName(slug);
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
        const slug = await findSlugById(id);
        if (slug) movie = await getMoviesByDetail(slug);
      }

      if (!movie?.data) throw new Error(`Movie not found for id: ${id}`);

      const response = {
        movie: (await processMovies([movie.data], baseUrl))[0],
        provider: {
          name: formattedName,
          id: shareName,
          url: baseUrl,
          },
      };

      const ttl = movie?.data?.status?.toLowerCase() ? TTL.ONGOING_SERIES : TTL.MOVIE_DETAILS;
      await redis.setex(cacheKey, ttl, JSON.stringify(response));
      return res.json(response);
    } catch (err) {
      console.error(`Error in /${id}: ${err}`);
      return next(err);
    }
});

router.use((err, req, res, next) => {
  console.error(`Error in ${req.path}: ${err.message}`);
  return res.status(500).json({ error: 'Something broke!' });
});

export default router;
