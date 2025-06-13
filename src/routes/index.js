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
const { redis, BASE_URL } = require('../config');
const { getTTL } = require('../scripts/preCacheMovies');

const getDomainAndProjectName = (req) => {
  let domain = req.headers.host || process.env.VERCEL_URL;
  if (!domain) {
    throw new Error('Không thể xác định domain');
  }

  const baseUrl = domain.startsWith('http') ? domain : `https://${domain}`;
  const projectNameMatch = domain.match(/^([a-zA-Z0-9-]*)\.vercel\.app$/) || [null, domain.split('.')[0]];
  const projectName = projectNameMatch[1] || 'movie-app';
  return { baseUrl, projectName };
};

const formatProjectName = (projectName) =>
  projectName.includes('-')
    ? projectName.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
    : projectName.charAt(0).toUpperCase() + projectName.slice(1);

async function processMovies(movies, baseUrl) {
  if (!movies || !Array.isArray(movies)) return [];

  const slugs = movies.map(movie => movie.slug).filter(slug => slug); // Lọc slug hợp lệ
  if (!slugs.length) return [];

  const movieDetails = await getMultipleMovieDetails(slugs);

  const isSeries = (movie, detail) => {
    const movieType = detail.movie?.type || movie.type || '';
    const tmdbType = detail.movie?.tmdb?.type || movie.tmdb?.type;
    const episodeTotal = parseInt(detail.movie?.episode_total || movie.episode_total, 10);

    if (movieType === 'series') return true;
    if (tmdbType === 'tv') return true;
    if (!isNaN(episodeTotal) && episodeTotal > 1) return true;
    return false;
  };

  return movies
    .map((movie, index) => {
      const detail = movieDetails[index] || { movie: {}, episodes: [] };
      if (detail.error) {
        console.warn(`Skipping movie ${movie.slug} due to: ${detail.error}`);
        return null; // Bỏ qua phim không có chi tiết trong cache
      }
      const movieType = detail.movie.type || movie.type || '';
      const is_series = isSeries(movie, detail);

      const image_url = detail.movie.poster_url || movie.poster_url || movie.thumb_url || 'https://via.placeholder.com/200x300';

      const tags = [
        {
          type: 'radio',
          text: is_series ? 'Phim Bộ' : 'Phim Lẻ',
          url: `${baseUrl}/${is_series ? 'series' : 'single'}`,
        },
        ...(detail.movie?.category || movie.category || []).map(cat => ({
          type: 'radio',
          text: cat.name || 'Unknown Category',
          url: `${baseUrl}/category?uid=${cat.slug || ''}`,
        })),
      ];

      return {
        id: movie._id || '',
        name: movie.name || 'Unknown Title',
        description: detail.movie.content || 'Không có mô tả chi tiết.',
        image: {
          url: image_url,
          type: 'cover',
        },
        type: is_series ? 'playlist' : 'single',
        display: 'text-below',
        enable_detail: true,
        remote_data: {
          url: `${baseUrl}/movie-detail?uid=${movie.slug || ''}`,
          channel_id: movie._id || '',
        },
        share: { url: `${baseUrl}/share-movie?uid=${movie.slug || ''}` },
        actors: Array.isArray(detail.movie.actor) ? detail.movie.actor : [],
        year: detail.movie.year || movie.year || null,
        tags,
      };
    })
    .filter(item => item !== null); // Lọc bỏ các phim không có chi tiết
}

async function findSlugFromId(id) {
  if (!id.match(/^[0-9a-f]{32}$/)) return null;
  const cacheKey = `movieapp:id_to_slug_${id}`;
  try {
    const cachedSlug = await redis.get(cacheKey);
    if (cachedSlug) return cachedSlug;
  } catch (error) {
    console.error(`Redis get error for ${cacheKey}: ${error.message}`);
  }

  const searchResult = await searchMovies(id, { limit: 1 });
  const foundMovie = searchResult?.items?.find(item => item._id === id);
  if (foundMovie) {
    try {
      await redis.set(cacheKey, foundMovie.slug, { ex: getTTL('movie_detail') });
    } catch (error) {
      console.error(`Redis set error for ${cacheKey}: ${error.message}`);
    }
    return foundMovie.slug;
  }
  return null;
}

async function updateCachedMovies(cacheKey, newMovies, limit, ttlType) {
  try {
    let cachedMovies = (await redis.get(cacheKey)) || [];
    const newMovieIds = new Set(newMovies.map(m => m._id));
    cachedMovies = cachedMovies.filter(m => !newMovieIds.has(m.id));
    cachedMovies = [...newMovies, ...cachedMovies].slice(0, limit);
    await redis.set(cacheKey, cachedMovies, { ex: getTTL(ttlType) });
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
      { key: 'series', fn: () => getMoviesByType('phim-bo', 1, 8), ttlType: 'series', name: 'Phim Bộ', url: '/series', display: 'slider' },
      { key: 'single', fn: () => getMoviesByType('phim-le', 1, 8), ttlType: 'new_movies', name: 'Phim Lẻ', url: '/single' },
      { key: 'animation', fn: () => getMoviesByType('hoat-hinh', 1, 8), ttlType: 'new_movies', name: 'Hoạt Hình', url: '/animation' },
      { key: 'phim-long-tieng', fn: () => getMoviesByType('phim-long-tieng', 1, 8), ttlType: 'new_movies', name: 'Phim Lồng Tiếng', url: '/phim-long-tieng' },
      { key: 'phim-thuyet-minh', fn: () => getMoviesByType('phim-thuyet-minh', 1, 8), ttlType: 'new_movies', name: 'Phim Thuyết Minh', url: '/phim-thuyet-minh' },
      { key: 'tvshows', fn: () => getMoviesByType('tv-shows', 1, 8), ttlType: 'new_movies', name: 'TV Shows', url: '/tvshows' },
      { key: 'hanh-dong', fn: () => getMoviesByCategory('hanh-dong', 1, 8), ttlType: 'new_movies', name: 'Hành Động', url: '/category?uid=hanh-dong' },
      { key: 'vien-tuong', fn: () => getMoviesByCategory('vien-tuong', 1, 8), ttlType: 'new_movies', name: 'Viễn Tưởng', url: '/category?uid=vien-tuong' },
      { key: 'au-my', fn: () => getMoviesByCountry('au-my', 1, 8), ttlType: 'new_movies', name: 'Âu Mỹ', url: '/country?uid=au-my' },
      { key: 'trung-quoc', fn: () => getMoviesByCountry('trung-quoc', 1, 8), ttlType: 'new_movies', name: 'Trung Quốc', url: '/country?uid=trung-quoc' },
      { key: 'viet-nam', fn: () => getMoviesByCountry('viet-nam', 1, 8), ttlType: 'new_movies', name: 'Việt Nam', url: '/country?uid=viet-nam' },
      { key: 'han-quoc', fn: () => getMoviesByCountry('han-quoc', 1, 8), ttlType: 'new_movies', name: 'Hàn Quốc', url: '/country?uid=han-quoc' },
      { key: 'nhat-ban', fn: () => getMoviesByCountry('nhat-ban', 1, 8), ttlType: 'new_movies', name: 'Nhật Bản', url: '/country?uid=nhat-ban' },
    ];

    const [categories, countries, ...rawData] = await Promise.all([
      getCategories(),
      getCountries(),
      ...fetchConfig.map(cfg => cfg.fn()),
    ]);

    const processedGroups = await Promise.all(
      fetchConfig.map(async (cfg, idx) => {
        const raw = rawData[idx]?.items || [];
        const totalPages = rawData[idx]?.totalPages || 10;
        const cacheSubKey = `movieapp:${cfg.key}_${projectName}`;
        const movies = await updateCachedMovies(cacheSubKey, raw, 8, cfg.ttlType);
        const channels = await processMovies(movies, baseUrl);
        return {
          id: cfg.key.replace(/-/g, '_'),
          name: cfg.name,
          display: cfg.display || 'horizontal',
          grid_number: 1,
          remote_data: { url: `${baseUrl}${cfg.url}` },
          channels: channels.length ? channels : [], // Trả về mảng rỗng nếu không có phim
          load_more: {
            remote_data: { url: `${baseUrl}${cfg.url}`, external: false },
            paging: { page_key: 'p', size_key: 's' },
            pageInfo: {
              current_page: 1,
              total: totalPages,
              per_page: 8,
              last_page: totalPages,
            },
          },
        };
      })
    );

    const response = {
      id: projectName,
      name: formattedName,
      url: baseUrl,
      color: '#06b6d4',
      description: `${formattedName} - Thế giới giải trí đỉnh cao, mang đến trải nghiệm sống động và trọn vẹn mọi lúc, mọi nơi.`,
      image: { url: `${baseUrl}/public/logo.png` },
      grid_number: 3,
      groups: processedGroups,
      sorts: [
        { text: 'Mới nhất', type: 'radio', url: `${baseUrl}/new` },
        {
          text: 'Thể loại',
          type: 'dropdown',
          value: (categories || []).map(cat => ({
            text: cat.name || 'Unknown',
            type: 'radio',
            url: `${baseUrl}/category?uid=${cat.slug || ''}`,
          })),
        },
        {
          text: 'Quốc gia',
          type: 'dropdown',
          value: (countries || []).map(c => ({
            text: c.name || 'Unknown',
            type: 'radio',
            url: `${baseUrl}/country?uid=${c.slug || ''}`,
          })),
        },
      ],
      search: {
        url: `${baseUrl}/search`,
        suggest_url: `${baseUrl}/suggest`,
        search_key: 'k',
        paging: { page_key: 'p', size_key: 's' },
      },
      share: { url: baseUrl },
      option: { save_history: true, save_search_history: true, save_wishlist: true },
    };

    await redis.set(cacheKey, response, { ex: getTTL('homepage') });
    res.json(response);
  } catch (error) {
    console.error(`Lỗi trong route homepage: ${error.message}`);
    next(error);
  }
});

const createMovieRoute = (path, fetchFunction, cachePrefix, ttlType, extraParams = {}) => async (req, res, next) => {
  try {
    const { baseUrl } = getDomainAndProjectName(req);
    const { p = 1, s = 12, ...queryParams } = req.query;
    const page = parseInt(p, 10);
    const limit = parseInt(s, 10);
    const paramString = Object.entries({ ...extraParams, ...queryParams })
      .map(([k, v]) => `${k}_${v}`)
      .join('_');
    const cacheKey = `movieapp:${cachePrefix}_${paramString}_${page}_${limit}`;

    try {
      const cachedMovies = await redis.get(cacheKey);
      if (cachedMovies) {
        return res.json({
          channels: cachedMovies,
          load_more: {
            remote_data: {
              url: `${baseUrl}/${path}${paramString ? `?${Object.entries(queryParams).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}` : ''}`,
              external: false,
            },
            paging: { page_key: 'p', size_key: 's' },
            pageInfo: {
              current_page: page,
              total: await redis.get(`movieapp:total_pages_${cachePrefix}_${paramString}`) || 1,
              per_page: limit,
              last_page: await redis.get(`movieapp:total_pages_${cachePrefix}_${paramString}`) || 1,
            },
          },
        });
      }
    } catch (error) {
      console.error(`Redis get error for ${cacheKey}: ${error.message}`);
    }

    const movies = await fetchFunction(page, limit, queryParams);
    let items = movies.items || [];
    if (page === 1 && !path.includes('country')) {
      items = items.sort((a, b) => new Date(b.modified?.time || 0) - new Date(a.modified?.time || 0));
    }

    const processedMovies = await processMovies(items, baseUrl);
    if (!processedMovies.length) {
      return res.status(404).json({ error: 'Không có phim nào khả dụng do thiếu dữ liệu chi tiết.' });
    }

    await redis.set(cacheKey, processedMovies, { ex: getTTL('processed_movies') });
    await redis.set(`movieapp:total_pages_${cachePrefix}_${paramString}`, movies.totalPages || 1, { ex: getTTL('processed_movies') });

    res.json({
      channels: processedMovies,
      load_more: {
        remote_data: {
          url: `${baseUrl}/${path}${paramString ? `?${Object.entries(queryParams).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}` : ''}`,
          external: false,
        },
        paging: { page_key: 'p', size_key: 's' },
        pageInfo: {
          current_page: page,
          total: movies.totalPages || 1,
          per_page: limit,
          last_page: movies.totalPages || 1,
        },
      },
    });
  } catch (error) {
    console.error(`Lỗi trong /${path}: ${error.message}`);
    next(error);
  }
};

router.get('/new', createMovieRoute('new', (page, limit) => getNewMovies(page, limit), 'new', 'new_movies'));

router.get('/series', createMovieRoute('series', (page, limit) => getMoviesByType('phim-bo', page, limit), 'series', 'series'));

router.get('/single', createMovieRoute('single', (page, limit) => getMoviesByType('phim-le', page, limit), 'single', 'new_movies'));

router.get('/phim-long-tieng', createMovieRoute('phim-long-tieng', (page, limit) => getMoviesByType('phim-long-tieng', page, limit), 'phim-long-tieng', 'new_movies'));

router.get('/phim-thuyet-minh', createMovieRoute('phim-thuyet-minh', (page, limit) => getMoviesByType('phim-thuyet-minh', page, limit), 'phim-thuyet-minh', 'new_movies'));

router.get('/animation', createMovieRoute('animation', (page, limit) => getMoviesByType('hoat-hinh', page, limit), 'animation', 'new_movies'));

router.get('/tvshows', createMovieRoute('tvshows', (page, limit) => getMoviesByType('tv-shows', page, limit), 'tvshows', 'new_movies'));

router.get('/category', createMovieRoute(
  'category',
  (page, limit, { uid }) => {
    if (!uid) throw new Error('Thiếu tham số uid');
    return getMoviesByCategory(uid, page, limit);
  },
  'category',
  'new_movies',
  { uid: '' }
));

router.get('/country', createMovieRoute(
  'country',
  (page, limit, { uid }) => {
    if (!uid) throw new Error('Thiếu tham số uid');
    return getMoviesByCountry(uid, page, limit);
  },
  'country',
  'new_movies',
  { uid: '' }
));

router.get('/search', createMovieRoute(
  'search',
  (page, limit, { k }) => {
    if (!k) throw new Error('Thiếu tham số k');
    return searchMovies(k, { page, limit });
  },
  'search',
  'search',
  { k: '' }
));

router.get('/suggest', async (req, res, next) => {
  try {
    const { k } = req.query;
    if (!k) return res.status(400).json({ error: 'Thiếu tham số k' });
    const cacheKey = `movieapp:suggest_${k}`;

    try {
      const cachedSuggestions = await redis.get(cacheKey);
      if (cachedSuggestions) {
        res.json(cachedSuggestions);
        return;
      }
    } catch (error) {
      console.error(`Redis get error for ${cacheKey}: ${error.message}`);
    }

    const movies = await searchMovies(k, { limit: 5 });
    const suggestions = movies.items?.map(item => item.name || 'Unknown Title') || [];
    await redis.set(cacheKey, suggestions, { ex: getTTL('suggest') });
    res.json(suggestions);
  } catch (error) {
    console.error(`Lỗi trong /suggest: ${error.message}`);
    next(error);
  }
});

router.get('/movie-detail', async (req, res, next) => {
  try {
    const { baseUrl } = getDomainAndProjectName(req);
    const { uid } = req.query;
    if (!uid) return res.status(400).json({ error: 'Thiếu tham số uid' });
    const cacheKey = `movieapp:movie_detail_${uid}`;

    try {
      const cachedMovie = await redis.get(cacheKey);
      if (cachedMovie) {
        res.json(cachedMovie);
        return;
      }
    } catch (error) {
      console.error(`Lỗi Redis get cho ${cacheKey}: ${error.message}`);
    }

    const movie = await getMovieDetail(uid, false);
    if (!movie?.movie || movie.error) {
      console.error(`Không tìm thấy phim cho uid: ${uid} - ${movie.error || 'Unknown error'}`);
      return res.status(404).json({ error: 'Phim hiện không khả dụng, vui lòng thử lại sau.' });
    }

    await redis.set(`movieapp:movie_by_channel_${movie.movie._id}`, movie, { ex: getTTL('movie_detail', movie.movie.status) });

    const isSeries = (movieData) => {
      const movieType = movieData.type || '';
      const tmdbType = movieData.tmdb?.type || '';
      const episodeTotal = parseInt(movieData.episode_total, 10);
      if (movieType === 'series') return true;
      if (tmdbType === 'tv') return true;
      if (!isNaN(episodeTotal) && episodeTotal > 1) return true;
      return false;
    };

    const is_series = isSeries(movie.movie);
    const categories = await getCategories();

    const tags = [
      {
        type: 'radio',
        url: `${baseUrl}/${is_series ? 'series' : 'single'}`,
        text: is_series ? 'Phim Bộ' : 'Phim Lẻ',
      },
      ...(movie.movie.category || []).map(cat => ({
        type: 'radio',
        url: `${baseUrl}/category?uid=${categories.find(c => c.name === cat.name)?.slug || ''}`,
        text: cat.name || 'Danh Mục Không Xác Định',
      })),
    ];

    const sources = (movie.episodes || []).map((server, serverIndex) => ({
      id: `${movie.movie._id}_${serverIndex}`,
      name: server.server_name || 'Server Không Xác Định',
      contents: [
        {
          id: `${movie.movie._id}_${serverIndex}`,
          name: '',
          grid_number: 3,
          streams: (server.server_data || []).map((episode, episodeIndex) => ({
            id: `${movie.movie._id}_${serverIndex}_${episodeIndex}`,
            name: `${episode.name || 'Tập ' + (episodeIndex + 1)} (${server.server_name || 'Unknown'})`,
            remote_data: {
              url: `${baseUrl}/stream-detail?slug=${movie.movie.slug}&streamId=${encodeURIComponent(`${movie.movie._id}_${serverIndex}_${episodeIndex}`)}&channelId=${movie.movie._id}&contentId=${movie.movie._id}&sourceId=${movie.movie._id}`,
              encrypted: false,
            },
          })),
        },
      ],
    })).filter(source => source.contents[0].streams.length > 0);

    if (!sources.length) {
      console.error(`Không có tập phim nào cho ${movie.movie.name}`);
      return res.status(404).json({ error: `Không có tập phim nào cho ${movie.movie.name}` });
    }

    const response = {
      image: {
        url: movie.movie.poster_url || movie.movie.thumb_url || 'https://via.placeholder.com/200x300',
        type: 'cover',
      },
      subtitle: movie.movie.lang || 'Vietsub',
      description: movie.movie.content || 'Không có mô tả chi tiết.',
      actors: Array.isArray(movie.movie.actor) ? movie.movie.actor : [],
      year: movie.movie.year || null,
      tags,
      sources,
    };

    await redis.set(cacheKey, response, { ex: getTTL('movie_detail', movie.movie.status) });
    res.json(response);
  } catch (error) {
    console.error(`Lỗi trong /movie-detail: ${error.message}`);
    next(error);
  }
});

router.get('/stream-detail', async (req, res, next) => {
  try {
    const { slug, streamId, channelId, contentId, sourceId } = req.query;
    if (!slug || !streamId || !channelId || !contentId || !sourceId) {
      return res.status(400).json({ error: 'Thiếu tham số bắt buộc' });
    }

    const response = await getStreamDetail(slug, streamId, channelId);
    if (!response) {
      return res.status(404).json({ error: `Không tìm thấy tập phim cho streamId: ${streamId}` });
    }

    res.json(response);
  } catch (error) {
    console.error(`Lỗi trong /stream-detail: ${error.message}`);
    next(error);
  }
});

router.get('/share-movie', async (req, res, next) => {
  try {
    const { baseUrl, projectName } = getDomainAndProjectName(req);
    const formattedName = formatProjectName(projectName);
    const { uid } = req.query;
    if (!uid) return res.status(400).json({ error: 'Thiếu tham số uid' });

    const cacheKey = `movieapp:share_movie_${uid}`;
    try {
      const cachedShare = await redis.get(cacheKey);
      if (cachedShare) {
        res.json(cachedShare);
        return;
      }
    } catch (error) {
      console.error(`Redis get error for ${cacheKey}: ${error.message}`);
    }

    let movie = await getMovieDetail(uid, false);
    if (!movie?.movie && movie.error) {
      const slug = await findSlugFromId(uid);
      if (slug) movie = await getMovieDetail(slug, false);
    }

    if (!movie?.movie || movie.error) {
      return res.status(404).json({ error: 'Phim hiện không khả dụng, vui lòng thử lại sau.' });
    }

    const response = {
      channel: (await processMovies([movie.movie], baseUrl))[0],
      provider: {
        name: formattedName,
        id: projectName,
        url: baseUrl,
        color: '#06b6d4',
        image: { url: `${baseUrl}/public/logo.png` },
      },
    };

    await redis.set(cacheKey, response, { ex: getTTL('movie_detail', movie.movie.status) });
    res.json(response);
  } catch (error) {
    console.error(`Lỗi trong /share-movie: ${error.message}`);
    next(error);
  }
});

router.use((error, req, res, next) => {
  console.error(`Lỗi trong ${req.path}: ${error.message}`);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = router;
