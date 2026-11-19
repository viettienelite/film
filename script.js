/* ==========================================================================
   Vtkjbtlvkh Cinema — Application Logic & NguonC API Client
   ========================================================================== */

const API_BASE = 'https://phim.nguonc.com/api';
const STORAGE_KEYS = {
    FAVORITES: 'vtk_cinema_favorites_v1',
    HISTORY: 'vtk_cinema_history_v1',
    WATCHED_EPS: 'vtk_cinema_watched_eps_v1'
};

// Application State
const state = {
    activeView: 'home', // 'home' | 'search' | 'favorites' | 'history' | 'detail'
    previousListView: 'home',
    previousQuery: '',
    currentPage: 0,
    isLoading: false,
    hasMore: true,
    sortMode: 'default', // 'default' | 'az' | 'za'
    compactGrid: false,
    groupSeasons: true,

    movies: [],
    movieSlugs: new Set(),

    heroMovies: [],
    heroIndex: 0,
    heroTimer: null,

    currentMovie: null,
    currentServerIndex: 0,
    currentEpisodeIndex: -1,
    episodeFilter: '',

    favorites: [],
    history: [],
    watchedEpisodes: {}
};

// Safe localStorage helpers
function readStorage(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch (_) {
        return fallback;
    }
}

function writeStorage(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {
        // Storage disabled or full
    }
}

// Fetch with timeout & clean error handling
async function fetchJson(url, timeoutMs = 12000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

// Inline SVG fallback poster so images never look broken
const FALLBACK_POSTER = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 450">
        <defs>
            <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stop-color="#1a2135"/>
                <stop offset="100%" stop-color="#0d1018"/>
            </linearGradient>
        </defs>
        <rect width="300" height="450" fill="url(#g)"/>
        <circle cx="150" cy="200" r="36" fill="none" stroke="#e50914" stroke-width="4" opacity="0.7"/>
        <polygon points="140,183 172,200 140,217" fill="#e50914" opacity="0.8"/>
        <text x="150" y="275" text-anchor="middle" fill="#64748b" font-family="sans-serif" font-size="15">No Poster</text>
    </svg>`
);

function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function showToast(message, iconClass = 'fa-circle-check') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `<i class="fas ${iconClass}"></i><span>${escapeHtml(message)}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(10px)';
        toast.style.transition = 'all 0.25s ease';
        setTimeout(() => toast.remove(), 260);
    }, 2600);
}

function formatRelativeTime(timestamp) {
    const diffSec = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    if (diffSec < 60) return 'Vừa xem xong';
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)} phút trước`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} giờ trước`;
    return `${Math.floor(diffSec / 86400)} ngày trước`;
}

// ==========================================================================
// Favorites & Watch History Management
// ==========================================================================
function loadUserData() {
    state.favorites = readStorage(STORAGE_KEYS.FAVORITES, []);
    state.history = readStorage(STORAGE_KEYS.HISTORY, []);
    state.watchedEpisodes = readStorage(STORAGE_KEYS.WATCHED_EPS, {});
    updateNavBadges();
}

function isFavorite(slug) {
    return state.favorites.some(item => item.slug === slug);
}

function toggleFavorite(movieObj) {
    if (!movieObj || !movieObj.slug) return false;
    const idx = state.favorites.findIndex(item => item.slug === movieObj.slug);
    let saved = false;
    if (idx >= 0) {
        state.favorites.splice(idx, 1);
        showToast(`Đã bỏ "${movieObj.name}" khỏi Yêu thích`, 'fa-bookmark');
    } else {
        state.favorites.unshift({
            slug: movieObj.slug,
            name: movieObj.name,
            original_name: movieObj.original_name || '',
            thumb_url: movieObj.thumb_url || movieObj.poster_url || '',
            poster_url: movieObj.poster_url || movieObj.thumb_url || '',
            current_episode: movieObj.current_episode || '',
            language: movieObj.language || '',
            savedAt: Date.now()
        });
        saved = true;
        showToast(`Đã thêm "${movieObj.name}" vào Yêu thích`, 'fa-bookmark');
    }
    writeStorage(STORAGE_KEYS.FAVORITES, state.favorites);
    updateNavBadges();
    syncFavoriteButtons(movieObj.slug, saved);
    if (state.activeView === 'favorites') {
        renderLocalCollection('favorites');
    }
    return saved;
}

function syncFavoriteButtons(slug, saved) {
    document.querySelectorAll(`.card-fav-btn[data-slug="${CSS.escape(slug)}"]`).forEach(btn => {
        btn.classList.toggle('saved', saved);
        btn.innerHTML = `<i class="${saved ? 'fas' : 'far'} fa-bookmark"></i>`;
    });
    if (state.currentMovie && state.currentMovie.slug === slug) {
        updateDetailFavButton(saved);
    }
    if (state.heroMovies[state.heroIndex]?.slug === slug) {
        renderHeroSlide(state.heroIndex, false);
    }
}

function recordWatchHistory(movie, episodeName, serverIndex, epIndex) {
    if (!movie || !movie.slug) return;
    state.history = state.history.filter(item => item.slug !== movie.slug);
    state.history.unshift({
        slug: movie.slug,
        name: movie.name,
        original_name: movie.original_name || '',
        thumb_url: movie.thumb_url || movie.poster_url || '',
        poster_url: movie.poster_url || movie.thumb_url || '',
        lastEpisode: episodeName,
        serverIndex,
        epIndex,
        watchedAt: Date.now()
    });
    if (state.history.length > 40) state.history.length = 40;
    writeStorage(STORAGE_KEYS.HISTORY, state.history);

    if (!state.watchedEpisodes[movie.slug]) {
        state.watchedEpisodes[movie.slug] = [];
    }
    const epKey = `${serverIndex}:${episodeName}`;
    if (!state.watchedEpisodes[movie.slug].includes(epKey)) {
        state.watchedEpisodes[movie.slug].push(epKey);
        writeStorage(STORAGE_KEYS.WATCHED_EPS, state.watchedEpisodes);
    }

    updateNavBadges();
    renderContinueShelf();
}

function clearHistory() {
    state.history = [];
    state.watchedEpisodes = {};
    writeStorage(STORAGE_KEYS.HISTORY, []);
    writeStorage(STORAGE_KEYS.WATCHED_EPS, {});
    updateNavBadges();
    renderContinueShelf();
    if (state.activeView === 'history') {
        renderLocalCollection('history');
    }
    showToast('Đã xóa toàn bộ lịch sử xem', 'fa-trash-can');
}

function updateNavBadges() {
    document.getElementById('favCountBadge').textContent = state.favorites.length;
    document.getElementById('historyCountBadge').textContent = state.history.length;
}

function setActiveNav(viewName) {
    document.querySelectorAll('.nav-pill').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.view === viewName);
    });
}

// ==========================================================================
// Hero Spotlight Carousel
// ==========================================================================
function setupHero(movies) {
    const heroSection = document.getElementById('heroSection');
    if (!movies || movies.length === 0) {
        heroSection.hidden = true;
        return;
    }
    heroSection.hidden = false;
    state.heroMovies = movies.slice(0, 6);
    state.heroIndex = 0;
    renderHeroDots();
    renderHeroSlide(0, true);
    startHeroAutoplay();
}

function renderHeroDots() {
    const dotsWrap = document.getElementById('heroDots');
    dotsWrap.innerHTML = state.heroMovies
        .map((_, idx) => `<button type="button" class="hero-dot ${idx === state.heroIndex ? 'active' : ''}" data-hero-idx="${idx}" aria-label="Slide ${idx + 1}"></button>`)
        .join('');
}

function renderHeroSlide(index, animateBg = true) {
    if (!state.heroMovies.length) return;
    state.heroIndex = (index + state.heroMovies.length) % state.heroMovies.length;
    const movie = state.heroMovies[state.heroIndex];
    const backdrop = document.getElementById('heroBackdrop');
    const content = document.getElementById('heroContent');

    const bgUrl = movie.poster_url || movie.thumb_url || FALLBACK_POSTER;
    if (animateBg) {
        backdrop.classList.remove('zooming');
        backdrop.style.backgroundImage = `url('${bgUrl}')`;
        void backdrop.offsetWidth;
        backdrop.classList.add('zooming');
    }

    const saved = isFavorite(movie.slug);
    const epTag = movie.current_episode ? `<span class="hero-meta-tag gold"><i class="fas fa-bolt"></i> ${escapeHtml(movie.current_episode)}</span>` : '';
    const langTag = movie.language ? `<span class="hero-meta-tag">${escapeHtml(movie.language)}</span>` : '';
    const qualTag = movie.quality ? `<span class="hero-meta-tag">${escapeHtml(movie.quality)}</span>` : '';

    content.innerHTML = `
        <div class="hero-eyebrow"><i class="fas fa-fire"></i> Mới cập nhật nổi bật</div>
        <h1 class="hero-title">${escapeHtml(movie.name)}</h1>
        <div class="hero-subtitle">
            ${movie.original_name ? `<span>${escapeHtml(movie.original_name)}</span>` : ''}
            ${epTag}${qualTag}${langTag}
        </div>
        <div class="hero-actions">
            <button type="button" class="btn-primary" id="heroPlayBtn">
                <i class="fas fa-play"></i> Xem Phim Ngay
            </button>
            <button type="button" class="btn-glass ${saved ? 'saved' : ''}" id="heroFavBtn">
                <i class="${saved ? 'fas' : 'far'} fa-bookmark"></i> ${saved ? 'Đã lưu yêu thích' : 'Lưu vào Yêu thích'}
            </button>
        </div>
    `;

    document.getElementById('heroPlayBtn').addEventListener('click', () => openMovieDetail(movie.slug));
    document.getElementById('heroFavBtn').addEventListener('click', () => toggleFavorite(movie));

    document.querySelectorAll('.hero-dot').forEach((dot, i) => {
        dot.classList.toggle('active', i === state.heroIndex);
    });
}

function startHeroAutoplay() {
    stopHeroAutoplay();
    state.heroTimer = setInterval(() => {
        if (state.activeView === 'home' && state.heroMovies.length > 1) {
            renderHeroSlide(state.heroIndex + 1, true);
        }
    }, 7000);
}

function stopHeroAutoplay() {
    if (state.heroTimer) {
        clearInterval(state.heroTimer);
        state.heroTimer = null;
    }
}

// ==========================================================================
// Continue Watching Shelf
// ==========================================================================
function renderContinueShelf() {
    const shelf = document.getElementById('continueShelf');
    const container = document.getElementById('continueContainer');
    if (state.activeView !== 'home' || state.history.length === 0) {
        shelf.hidden = true;
        return;
    }
    shelf.hidden = false;
    container.innerHTML = state.history.slice(0, 10).map(item => `
        <article class="continue-card" data-slug="${escapeHtml(item.slug)}">
            <img class="continue-thumb" src="${escapeHtml(item.thumb_url || FALLBACK_POSTER)}" alt="${escapeHtml(item.name)}" loading="lazy" onerror="this.src='${FALLBACK_POSTER}'">
            <div class="continue-info">
                <h3>${escapeHtml(item.name)}</h3>
                <div class="continue-ep"><i class="fas fa-play-circle"></i> Tập ${escapeHtml(item.lastEpisode || '1')}</div>
                <div class="continue-time">${formatRelativeTime(item.watchedAt)}</div>
            </div>
        </article>
    `).join('');

    container.querySelectorAll('.continue-card').forEach(card => {
        card.addEventListener('click', () => openMovieDetail(card.dataset.slug));
    });
}

// ==========================================================================
// Movie Catalog Fetching & Rendering
// ==========================================================================
function renderSkeletonGrid(count = 12) {
    const container = document.getElementById('movieContainer');
    container.innerHTML = Array.from({ length: count }, () => `
        <div class="skeleton-card">
            <div class="sk-poster skeleton-shimmer"></div>
            <div class="sk-body">
                <div class="sk-line skeleton-shimmer"></div>
                <div class="sk-line short skeleton-shimmer"></div>
            </div>
        </div>
    `).join('');
}

function showStatusBanner(show, title = '', desc = '') {
    const banner = document.getElementById('statusBanner');
    banner.hidden = !show;
    if (show) {
        document.getElementById('statusBannerTitle').textContent = title;
        document.getElementById('statusBannerDesc').textContent = desc;
    }
}

async function loadHomeMovies(initial = true) {
    if (state.isLoading) return;
    state.isLoading = true;
    showStatusBanner(false);

    if (initial) {
        state.activeView = 'home';
        state.previousListView = 'home';
        state.currentPage = 0;
        state.hasMore = true;
        state.movies = [];
        state.movieSlugs.clear();
        setActiveNav('home');
        showListView();
        document.getElementById('movieListTitle').textContent = 'Phim Mới Cập Nhật';
        document.getElementById('resultCountPill').textContent = 'Đang tải...';
        document.getElementById('loadMoreWrap').hidden = true;
        renderSkeletonGrid(12);
        renderContinueShelf();
    } else {
        const btn = document.getElementById('loadMoreBtn');
        btn.disabled = true;
        btn.querySelector('.btn-label').textContent = 'Đang tải thêm...';
    }

    try {
        // Load 2 pages on initial load for a rich catalog, then 2 pages per "Load More"
        const pagesToLoad = initial ? [1, 2] : [state.currentPage + 1, state.currentPage + 2];
        const results = await Promise.allSettled(
            pagesToLoad.map(p => fetchJson(`${API_BASE}/films/phim-moi-cap-nhat?page=${p}`))
        );

        let addedCount = 0;
        let anySuccess = false;

        results.forEach((res, idx) => {
            if (res.status === 'fulfilled' && res.value) {
                anySuccess = true;
                state.currentPage = pagesToLoad[idx];
                const items = res.value.items || [];
                items.forEach(movie => {
                    if (movie && movie.slug && !state.movieSlugs.has(movie.slug)) {
                        state.movieSlugs.add(movie.slug);
                        state.movies.push(movie);
                        addedCount++;
                    }
                });
            }
        });

        if (!anySuccess) {
            throw new Error('Không nhận được phản hồi từ phim.nguonc.com');
        }

        if (initial) {
            setupHero(state.movies);
        }
        state.hasMore = addedCount > 0;
        renderMovieGrid(state.movies);
        document.getElementById('loadMoreWrap').hidden = !state.hasMore;
    } catch (err) {
        if (initial) {
            document.getElementById('heroSection').hidden = true;
            document.getElementById('movieContainer').innerHTML = '';
            document.getElementById('resultCountPill').textContent = 'Lỗi kết nối';
        }
        showStatusBanner(
            true,
            'Không thể tải danh sách phim từ nguồn API',
            'Máy chủ phim.nguonc.com đang phản hồi chậm hoặc kết nối bị gián đoạn. Nhấn Thử lại để kết nối lại.'
        );
    } finally {
        state.isLoading = false;
        const btn = document.getElementById('loadMoreBtn');
        btn.disabled = false;
        btn.querySelector('.btn-label').textContent = 'Tải thêm phim';
    }
}

async function performSearch(keyword) {
    const clean = keyword.trim();
    if (!clean) {
        loadHomeMovies(true);
        return;
    }

    state.activeView = 'search';
    state.previousListView = 'search';
    state.previousQuery = clean;
    state.movies = [];
    state.movieSlugs.clear();
    setActiveNav('');
    showListView();

    document.getElementById('heroSection').hidden = true;
    document.getElementById('continueShelf').hidden = true;
    document.getElementById('loadMoreWrap').hidden = true;
    document.getElementById('movieListTitle').textContent = `Kết quả cho "${clean}"`;
    document.getElementById('resultCountPill').textContent = 'Đang tìm...';
    showStatusBanner(false);
    renderSkeletonGrid(8);

    try {
        const data = await fetchJson(`${API_BASE}/films/search?keyword=${encodeURIComponent(clean)}`);
        const items = data.items || (data.movie ? [data.movie] : []);
        items.forEach(movie => {
            if (movie && movie.slug && !state.movieSlugs.has(movie.slug)) {
                state.movieSlugs.add(movie.slug);
                state.movies.push(movie);
            }
        });
        renderMovieGrid(state.movies, `Không tìm thấy phim nào khớp với "${clean}". Thử từ khóa ngắn hơn hoặc tên tiếng Anh nhé!`);
    } catch (_) {
        document.getElementById('movieContainer').innerHTML = '';
        document.getElementById('resultCountPill').textContent = 'Lỗi tìm kiếm';
        showStatusBanner(
            true,
            'Tìm kiếm tạm thời gián đoạn',
            'Không thể gửi yêu cầu tìm kiếm tới phim.nguonc.com. Vui lòng thử lại.'
        );
    }
}

function renderLocalCollection(type) {
    state.activeView = type;
    state.previousListView = type;
    setActiveNav(type);
    showListView();
    showStatusBanner(false);

    document.getElementById('heroSection').hidden = true;
    document.getElementById('continueShelf').hidden = true;
    document.getElementById('loadMoreWrap').hidden = true;

    if (type === 'favorites') {
        document.getElementById('movieListTitle').textContent = 'Phim Yêu Thích';
        state.movies = [...state.favorites];
        renderMovieGrid(state.movies, 'Bạn chưa lưu bộ phim nào. Nhấn biểu tượng đánh dấu trên poster phim để lưu lại xem sau!');
    } else if (type === 'history') {
        document.getElementById('movieListTitle').textContent = 'Lịch Sử Đã Xem';
        state.movies = [...state.history];
        renderMovieGrid(state.movies, 'Lịch sử xem đang trống. Hãy chọn một bộ phim bất kỳ để bắt đầu thưởng thức!');
    }
}

function getSortedMovies(list) {
    const copy = [...list];
    if (state.sortMode === 'az') {
        copy.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'vi'));
    } else if (state.sortMode === 'za') {
        copy.sort((a, b) => (b.name || '').localeCompare(a.name || '', 'vi'));
    }
    return copy;
}


// ==========================================================================
// Anime / Series Season Parsing & Grouping
// ==========================================================================
function normalizeForKey(str) {
    return String(str || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd')
        .replace(/Đ/g, 'D')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '');
}

function parseSeriesInfo(movie) {
    const name = String(movie?.name || '').trim();
    const orig = String(movie?.original_name || '').trim();

    // Detect explicit season / part markers like (Phần 2), Phần 2, Mùa 3, Season 2, S2, Part 2, SS2
    const seasonRegex = /(?:[\(\[\-–—:]\s*)?(?:phần|mùa|season|ss|part|cour)\s*(\d+)(?:\s*[\)\]])?/i;
    const shortSRegex = /(?:[\(\[\-–—:\s])S(\d{1,2})(?:\s*[\)\]])?$/i;

    let match = name.match(seasonRegex) || name.match(shortSRegex);
    let baseName = name;
    let seasonNum = null;

    if (match) {
        seasonNum = parseInt(match[1], 10);
        baseName = name.replace(match[0], ' ').replace(/[\(\[\-–—:\s]+$/g, '').replace(/\s{2,}/g, ' ').trim();
    } else {
        const origMatch = orig.match(seasonRegex) || orig.match(shortSRegex);
        if (origMatch) {
            seasonNum = parseInt(origMatch[1], 10);
        }
    }

    // Detect Movie / OVA / Special variants
    const isSpecial = /\b(ova|oad|special|movie|điện ảnh|ngoại truyện|tập đặc biệt)\b/i.test(name);
    if (isSpecial && seasonNum === null) {
        baseName = baseName
            .replace(/(?:[\(\[\-–—:]\s*)?(?:ova|oad|special|movie|bản điện ảnh|điện ảnh|ngoại truyện|tập đặc biệt)(?:\s*[\)\]])?/gi, ' ')
            .replace(/[\(\[\-–—:\s]+$/g, '')
            .replace(/\s{2,}/g, ' ')
            .trim();
    }

    if (!baseName) baseName = name;
    const groupKey = normalizeForKey(baseName);
    const seasonOrder = seasonNum !== null ? seasonNum : (isSpecial ? 99 : 1);
    const seasonLabel = seasonNum !== null
        ? `Phần ${seasonNum}`
        : (isSpecial ? 'Movie / OVA' : 'Phần 1');
    const shortLabel = seasonNum !== null
        ? `P${seasonNum}`
        : (isSpecial ? 'OVA' : 'P1');

    return { baseName, groupKey, seasonNum, seasonOrder, seasonLabel, shortLabel, hasExplicitSeason: seasonNum !== null || isSpecial };
}

function groupMoviesBySeason(movies) {
    const groups = new Map();
    const order = [];

    movies.forEach(movie => {
        const info = parseSeriesInfo(movie);
        const key = info.groupKey || movie.slug;
        if (!groups.has(key)) {
            groups.set(key, {
                groupKey: key,
                baseName: info.baseName,
                seasons: []
            });
            order.push(key);
        }
        groups.get(key).seasons.push({ movie, info });
    });

    return order.map(key => {
        const grp = groups.get(key);
        // Sort seasons chronologically: Phần 1 -> Phần 2 -> ... -> OVA
        grp.seasons.sort((a, b) => a.info.seasonOrder - b.info.seasonOrder);
        // Pick the latest regular season (or first item) as representative poster
        const primary = grp.seasons[grp.seasons.length - 1].movie;
        return { ...grp, primary };
    });
}

async function fetchRelatedSeasons(movie) {
    const section = document.getElementById('seasonsSection');
    const listEl = document.getElementById('seasonsList');
    const countPill = document.getElementById('seasonCountPill');

    section.hidden = true;
    const currentInfo = parseSeriesInfo(movie);
    if (!currentInfo.baseName || currentInfo.baseName.length < 3) return;

    try {
        const data = await fetchJson(`${API_BASE}/films/search?keyword=${encodeURIComponent(currentInfo.baseName)}`, 9000);
        // Abort if user already navigated away to another movie
        if (!state.currentMovie || state.currentMovie.slug !== movie.slug) return;

        const rawItems = data.items || (data.movie ? [data.movie] : []);
        const mapBySlug = new Map();

        // Always include the current movie
        mapBySlug.set(movie.slug, { movie, info: currentInfo });

        rawItems.forEach(item => {
            if (!item || !item.slug) return;
            const info = parseSeriesInfo(item);
            if (info.groupKey === currentInfo.groupKey) {
                if (!mapBySlug.has(item.slug)) {
                    mapBySlug.set(item.slug, { movie: item, info });
                }
            }
        });

        const seasons = Array.from(mapBySlug.values()).sort((a, b) => a.info.seasonOrder - b.info.seasonOrder);
        if (seasons.length <= 1) return;

        countPill.textContent = `${seasons.length} mùa`;
        listEl.innerHTML = seasons.map(({ movie: m, info }) => {
            const isCurrent = m.slug === movie.slug;
            return `
                <button type="button" class="season-card-btn ${isCurrent ? 'active' : ''}" data-season-slug="${escapeHtml(m.slug)}">
                    <img class="season-card-thumb" src="${escapeHtml(m.thumb_url || m.poster_url || FALLBACK_POSTER)}" alt="${escapeHtml(m.name)}" loading="lazy" onerror="this.src='${FALLBACK_POSTER}'">
                    <span class="season-card-meta">
                        <span class="season-card-label">${escapeHtml(info.seasonLabel)}</span>
                        <span class="season-card-sub">${escapeHtml(m.name)}</span>
                    </span>
                </button>
            `;
        }).join('');

        listEl.querySelectorAll('.season-card-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const targetSlug = btn.dataset.seasonSlug;
                if (targetSlug && targetSlug !== state.currentMovie?.slug) {
                    openMovieDetail(targetSlug);
                }
            });
        });

        section.hidden = false;
    } catch (_) {
        // Silent fail — season discovery is an enhancement
    }
}

function renderMovieGrid(movies, emptyMessage = 'Chưa có dữ liệu phim để hiển thị.') {
    const container = document.getElementById('movieContainer');
    const sorted = getSortedMovies(movies);

    if (sorted.length === 0) {
        document.getElementById('resultCountPill').textContent = '0 phim';
        container.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-film"></i>
                <h3>Không có phim nào ở đây</h3>
                <p>${escapeHtml(emptyMessage)}</p>
                <button type="button" class="btn-primary" id="emptyBackHomeBtn">
                    <i class="fas fa-compass"></i> Về trang Khám phá
                </button>
            </div>
        `;
        document.getElementById('emptyBackHomeBtn').addEventListener('click', () => {
            document.getElementById('searchInput').value = '';
            updateSearchClear();
            loadHomeMovies(true);
        });
        return;
    }

    const useGrouping = state.groupSeasons && state.activeView !== 'history';
    const entries = useGrouping
        ? groupMoviesBySeason(sorted)
        : sorted.map(movie => ({ primary: movie, baseName: movie.name, seasons: [{ movie, info: parseSeriesInfo(movie) }] }));

    const groupedCount = entries.filter(e => e.seasons.length > 1).length;
    document.getElementById('resultCountPill').textContent = useGrouping && groupedCount > 0
        ? `${entries.length} bộ (${sorted.length} phần)`
        : `${sorted.length} phim`;

    container.innerHTML = entries.map((entry, idx) => {
        const movie = entry.primary;
        const isMultiSeason = entry.seasons.length > 1;
        const saved = isFavorite(movie.slug);
        const delay = Math.min(idx % 20, 12) * 35;

        const badgeClass = isMultiSeason ? 'gold-badge' : 'accent';
        const badgeText = isMultiSeason
            ? `${entry.seasons.length} mùa`
            : (movie.current_episode || movie.lastEpisode
                ? (movie.lastEpisode ? `Tập ${movie.lastEpisode}` : movie.current_episode)
                : (movie.quality || 'HD'));

        const displayTitle = isMultiSeason ? entry.baseName : movie.name;
        const subText = isMultiSeason
            ? entry.seasons.map(s => s.info.seasonLabel).join(' • ')
            : (movie.original_name || movie.language || 'Phim mới cập nhật');

        const seasonPillsHtml = isMultiSeason
            ? `<div class="card-seasons-bar">${entry.seasons.map(s => `
                <button type="button" class="card-season-chip" data-season-slug="${escapeHtml(s.movie.slug)}" title="${escapeHtml(s.movie.name)}">
                    ${escapeHtml(s.info.shortLabel)}
                </button>
            `).join('')}</div>`
            : '';

        return `
            <article class="movie-card" data-slug="${escapeHtml(movie.slug)}" style="animation-delay: ${delay}ms">
                <div class="card-poster-wrap">
                    <img
                        src="${escapeHtml(movie.thumb_url || movie.poster_url || FALLBACK_POSTER)}"
                        alt="${escapeHtml(displayTitle)}"
                        loading="lazy"
                        onerror="this.src='${FALLBACK_POSTER}'"
                    >
                    <div class="card-badges-top">
                        <span class="card-badge ${badgeClass}">${escapeHtml(badgeText)}</span>
                        <button
                            type="button"
                            class="card-fav-btn ${saved ? 'saved' : ''}"
                            data-slug="${escapeHtml(movie.slug)}"
                            aria-label="Lưu yêu thích"
                            title="Lưu yêu thích"
                        >
                            <i class="${saved ? 'fas' : 'far'} fa-bookmark"></i>
                        </button>
                    </div>
                    <div class="card-hover-overlay">
                        <div class="card-play-circle"><i class="fas fa-play"></i></div>
                    </div>
                </div>
                <div class="card-body">
                    <h3 class="card-title" title="${escapeHtml(displayTitle)}">${escapeHtml(displayTitle)}</h3>
                    <p class="card-sub" title="${escapeHtml(subText)}">${escapeHtml(subText)}</p>
                    ${seasonPillsHtml}
                </div>
            </article>
        `;
    }).join('');

    container.querySelectorAll('.movie-card').forEach(card => {
        const slug = card.dataset.slug;
        const movieObj = sorted.find(m => m.slug === slug);

        card.addEventListener('click', () => openMovieDetail(slug));

        const favBtn = card.querySelector('.card-fav-btn');
        favBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleFavorite(movieObj);
        });

        card.querySelectorAll('.card-season-chip').forEach(chip => {
            chip.addEventListener('click', (e) => {
                e.stopPropagation();
                openMovieDetail(chip.dataset.seasonSlug);
            });
        });
    });
}

// ==========================================================================
// Movie Detail & Video Player
// ==========================================================================
function showListView() {
    exitLightsOff();
    document.getElementById('videoFrame').src = '';
    document.getElementById('movieDetailView').hidden = true;
    document.getElementById('movieListView').hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function updateDetailFavButton(saved) {
    const btn = document.getElementById('detailFavBtn');
    btn.classList.toggle('saved', saved);
    btn.innerHTML = `<i class="${saved ? 'fas' : 'far'} fa-bookmark"></i><span>${saved ? 'Đã yêu thích' : 'Yêu thích'}</span>`;
}

async function openMovieDetail(slug) {
    state.activeView = 'detail';
    state.currentMovie = null;
    state.currentServerIndex = 0;
    state.currentEpisodeIndex = -1;
    state.episodeFilter = '';
    document.getElementById('epSearchInput').value = '';

    document.getElementById('movieListView').hidden = true;
    document.getElementById('movieDetailView').hidden = false;
    document.getElementById('detailSkeleton').hidden = false;
    document.getElementById('detailContent').hidden = true;
    document.getElementById('seasonsSection').hidden = true;
    document.getElementById('videoFrame').src = '';
    window.scrollTo({ top: 0, behavior: 'smooth' });

    try {
        const data = await fetchJson(`${API_BASE}/film/${encodeURIComponent(slug)}`);
        if (!data || !data.movie) throw new Error('Không tìm thấy thông tin phim');
        state.currentMovie = data.movie;
        renderMovieDetail(data.movie);
    } catch (_) {
        showToast('Không thể tải chi tiết phim, vui lòng thử lại', 'fa-triangle-exclamation');
        goBackToPreviousList();
    }
}

function extractCategories(categoryObj) {
    const result = {
        format: 'Đang cập nhật',
        genre: 'Đang cập nhật',
        country: 'Đang cập nhật',
        year: 'Đang cập nhật'
    };
    if (!categoryObj || typeof categoryObj !== 'object') return result;

    Object.values(categoryObj).forEach(cat => {
        if (!cat || !cat.group || !Array.isArray(cat.list)) return;
        const groupName = cat.group.name;
        const values = cat.list.map(i => i.name).filter(Boolean).join(', ');
        if (!values) return;
        if (groupName === 'Định dạng') result.format = values;
        else if (groupName === 'Thể loại') result.genre = values;
        else if (groupName === 'Quốc gia') result.country = values;
        else if (groupName === 'Năm') result.year = values;
    });
    return result;
}

function renderMovieDetail(movie) {
    document.getElementById('detailSkeleton').hidden = true;
    document.getElementById('detailContent').hidden = false;

    const cats = extractCategories(movie.category);
    const backdropUrl = movie.poster_url || movie.thumb_url || FALLBACK_POSTER;
    document.getElementById('movieHeroBg').style.backgroundImage = `url('${backdropUrl}')`;

    const posterEl = document.getElementById('detailPoster');
    posterEl.src = movie.thumb_url || movie.poster_url || FALLBACK_POSTER;
    posterEl.alt = movie.name || 'Poster phim';
    posterEl.onerror = () => { posterEl.src = FALLBACK_POSTER; };

    document.getElementById('detailQualityBadge').textContent = movie.quality || 'HD';
    document.getElementById('detailTitle').textContent = movie.name || 'Không rõ tên';
    document.getElementById('detailOriginalName').textContent = movie.original_name || '';

    // Pill badges
    const badges = [
        cats.year !== 'Đang cập nhật' ? `<span class="meta-pill highlight"><i class="fas fa-calendar"></i> ${escapeHtml(cats.year)}</span>` : '',
        movie.language ? `<span class="meta-pill"><i class="fas fa-closed-captioning"></i> ${escapeHtml(movie.language)}</span>` : '',
        movie.time ? `<span class="meta-pill"><i class="fas fa-clock"></i> ${escapeHtml(movie.time)}</span>` : '',
        movie.current_episode ? `<span class="meta-pill"><i class="fas fa-tv"></i> ${escapeHtml(movie.current_episode)}${movie.total_episodes ? ' / ' + escapeHtml(movie.total_episodes) : ''}</span>` : ''
    ].filter(Boolean).join('');
    document.getElementById('detailBadges').innerHTML = badges;

    // Synopsis with expand/collapse
    const descEl = document.getElementById('detailDescription');
    const toggleBtn = document.getElementById('synopsisToggleBtn');
    const cleanDesc = (movie.description || 'Chưa có mô tả chi tiết cho bộ phim này.').replace(/<[^>]*>/g, '').trim();
    descEl.textContent = cleanDesc;
    descEl.classList.add('clamped');
    toggleBtn.hidden = cleanDesc.length < 180;
    toggleBtn.innerHTML = 'Xem thêm <i class="fas fa-chevron-down"></i>';

    // Metadata grid
    const metaRows = [
        { icon: 'fa-tags', label: 'Thể loại:', val: cats.genre },
        { icon: 'fa-globe', label: 'Quốc gia:', val: cats.country },
        { icon: 'fa-film', label: 'Định dạng:', val: cats.format },
        { icon: 'fa-user-tie', label: 'Đạo diễn:', val: movie.director || 'Đang cập nhật' },
        { icon: 'fa-users', label: 'Diễn viên:', val: movie.casts || 'Đang cập nhật' }
    ];
    document.getElementById('metaGrid').innerHTML = metaRows.map(r => `
        <div class="meta-row">
            <i class="fas ${r.icon}"></i>
            <div><span class="meta-label">${r.label}</span><span class="meta-val">${escapeHtml(r.val)}</span></div>
        </div>
    `).join('');

    updateDetailFavButton(isFavorite(movie.slug));

    // Discover & render related seasons (Phần 1, Phần 2, ...)
    fetchRelatedSeasons(movie);

    // Render servers & episodes
    renderServersAndEpisodes(movie);
}

function renderServersAndEpisodes(movie) {
    const servers = Array.isArray(movie.episodes) ? movie.episodes.filter(s => s && Array.isArray(s.items) && s.items.length > 0) : [];
    const serverTabs = document.getElementById('serverTabs');

    if (servers.length === 0) {
        serverTabs.innerHTML = '';
        document.getElementById('episodeCountPill').textContent = '0 tập';
        document.getElementById('epSearchWrap').hidden = true;
        document.getElementById('episodeList').innerHTML = '<p style="color: var(--text-muted); grid-column: 1 / -1;">Bộ phim hiện chưa có tập nào khả dụng.</p>';
        document.getElementById('videoFrame').src = '';
        document.getElementById('playerPlaceholder').hidden = false;
        document.getElementById('nowPlayingLabel').textContent = 'Chưa có nguồn phát';
        updatePrevNextButtons();
        return;
    }

    // Check if user previously watched an episode of this movie
    const prevRecord = state.history.find(h => h.slug === movie.slug);
    if (prevRecord && servers[prevRecord.serverIndex] && servers[prevRecord.serverIndex].items[prevRecord.epIndex]) {
        state.currentServerIndex = prevRecord.serverIndex;
    } else {
        state.currentServerIndex = 0;
    }

    serverTabs.innerHTML = servers.map((srv, idx) => `
        <button type="button" class="server-tab ${idx === state.currentServerIndex ? 'active' : ''}" data-srv="${idx}">
            <i class="fas fa-server"></i> ${escapeHtml(srv.server_name || `Server ${idx + 1}`)}
        </button>
    `).join('');

    serverTabs.querySelectorAll('.server-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            state.currentServerIndex = Number(tab.dataset.srv);
            serverTabs.querySelectorAll('.server-tab').forEach(t => t.classList.toggle('active', t === tab));
            renderEpisodeGrid();
            const items = getActiveServerEpisodes();
            if (items.length > 0) {
                const targetIdx = Math.min(Math.max(state.currentEpisodeIndex, 0), items.length - 1);
                playEpisodeByIndex(targetIdx, false);
            }
        });
    });

    renderEpisodeGrid();

    // Auto-play last watched episode or first episode
    const initialEpIndex = (prevRecord && prevRecord.serverIndex === state.currentServerIndex && prevRecord.epIndex < getActiveServerEpisodes().length)
        ? prevRecord.epIndex
        : 0;
    playEpisodeByIndex(initialEpIndex, false);
}

function getActiveServerEpisodes() {
    if (!state.currentMovie || !Array.isArray(state.currentMovie.episodes)) return [];
    const validServers = state.currentMovie.episodes.filter(s => s && Array.isArray(s.items) && s.items.length > 0);
    return validServers[state.currentServerIndex]?.items || [];
}

function renderEpisodeGrid() {
    const items = getActiveServerEpisodes();
    const listEl = document.getElementById('episodeList');
    const filterTerm = state.episodeFilter.trim().toLowerCase();

    document.getElementById('episodeCountPill').textContent = `${items.length} tập`;
    document.getElementById('epSearchWrap').hidden = items.length < 16;

    const watchedList = state.watchedEpisodes[state.currentMovie?.slug] || [];

    const filtered = items
        .map((ep, originalIdx) => ({ ep, originalIdx }))
        .filter(({ ep }) => !filterTerm || String(ep.name).toLowerCase().includes(filterTerm));

    if (filtered.length === 0) {
        listEl.innerHTML = '<p style="color: var(--text-muted); grid-column: 1 / -1;">Không tìm thấy tập phim phù hợp.</p>';
        return;
    }

    listEl.innerHTML = filtered.map(({ ep, originalIdx }) => {
        const isActive = originalIdx === state.currentEpisodeIndex;
        const isWatched = watchedList.includes(`${state.currentServerIndex}:${ep.name}`);
        const eqHtml = isActive ? '<span class="eq-bars"><span></span><span></span><span></span></span>' : '';
        return `
            <button
                type="button"
                class="episode-btn ${isActive ? 'active-episode' : ''} ${isWatched ? 'watched' : ''}"
                data-ep-idx="${originalIdx}"
            >
                ${eqHtml}
                <span>Tập ${escapeHtml(ep.name)}</span>
            </button>
        `;
    }).join('');

    listEl.querySelectorAll('.episode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            playEpisodeByIndex(Number(btn.dataset.epIdx), true);
        });
    });
}

function playEpisodeByIndex(epIndex, shouldScroll = false) {
    const items = getActiveServerEpisodes();
    const episode = items[epIndex];
    if (!episode) return;

    const videoUrl = episode.embed || episode.m3u8 || '';
    const frame = document.getElementById('videoFrame');
    const placeholder = document.getElementById('playerPlaceholder');

    state.currentEpisodeIndex = epIndex;
    if (videoUrl) {
        frame.src = videoUrl;
        placeholder.hidden = true;
    } else {
        frame.src = '';
        placeholder.hidden = false;
        showToast('Tập này chưa có đường dẫn phát video', 'fa-triangle-exclamation');
    }

    document.getElementById('nowPlayingLabel').textContent = `Đang phát: ${state.currentMovie.name} — Tập ${episode.name}`;
    recordWatchHistory(state.currentMovie, episode.name, state.currentServerIndex, epIndex);
    renderEpisodeGrid();
    updatePrevNextButtons();

    if (shouldScroll) {
        document.getElementById('playerSection').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

function updatePrevNextButtons() {
    const items = getActiveServerEpisodes();
    document.getElementById('prevEpBtn').disabled = state.currentEpisodeIndex <= 0;
    document.getElementById('nextEpBtn').disabled = state.currentEpisodeIndex < 0 || state.currentEpisodeIndex >= items.length - 1;
}

function exitLightsOff() {
    document.body.classList.remove('lights-off');
    const btn = document.getElementById('lightsOffBtn');
    btn.classList.remove('active');
    btn.innerHTML = '<i class="fas fa-moon"></i><span>Tắt đèn</span>';
}

function toggleLightsOff() {
    const active = document.body.classList.toggle('lights-off');
    const btn = document.getElementById('lightsOffBtn');
    btn.classList.toggle('active', active);
    btn.innerHTML = active
        ? '<i class="fas fa-sun"></i><span>Bật đèn</span>'
        : '<i class="fas fa-moon"></i><span>Tắt đèn</span>';
}

function goBackToPreviousList() {
    if (state.previousListView === 'favorites' || state.previousListView === 'history') {
        renderLocalCollection(state.previousListView);
    } else if (state.previousListView === 'search' && state.previousQuery) {
        document.getElementById('searchInput').value = state.previousQuery;
        updateSearchClear();
        performSearch(state.previousQuery);
    } else {
        if (state.movies.length > 0 && state.previousListView === 'home') {
            state.activeView = 'home';
            setActiveNav('home');
            showListView();
            renderContinueShelf();
        } else {
            loadHomeMovies(true);
        }
    }
}

function updateSearchClear() {
    const input = document.getElementById('searchInput');
    document.getElementById('searchClearBtn').hidden = input.value.length === 0;
}

function copyShareText() {
    if (!state.currentMovie) return;
    const shareText = `Đang xem "${state.currentMovie.name}" trên Vtkjbtlvkh Cinema`;
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(shareText)
            .then(() => showToast('Đã sao chép thông tin phim để chia sẻ', 'fa-check'))
            .catch(() => fallbackCopy(shareText));
    } else {
        fallbackCopy(shareText);
    }
}

function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
        document.execCommand('copy');
        showToast('Đã sao chép thông tin phim để chia sẻ', 'fa-check');
    } catch (_) {
        showToast('Không thể sao chép tự động', 'fa-triangle-exclamation');
    }
    ta.remove();
}

// ==========================================================================
// Event Bindings & Initialization
// ==========================================================================
function bindEvents() {
    // Logo & Navigation
    document.getElementById('logoBtn').addEventListener('click', () => {
        document.getElementById('searchInput').value = '';
        updateSearchClear();
        loadHomeMovies(true);
    });

    document.getElementById('navHomeBtn').addEventListener('click', () => {
        document.getElementById('searchInput').value = '';
        updateSearchClear();
        loadHomeMovies(true);
    });

    document.getElementById('navFavBtn').addEventListener('click', () => renderLocalCollection('favorites'));
    document.getElementById('navHistoryBtn').addEventListener('click', () => renderLocalCollection('history'));

    // Search form
    const searchInput = document.getElementById('searchInput');
    document.getElementById('searchForm').addEventListener('submit', (e) => {
        e.preventDefault();
        performSearch(searchInput.value);
    });

    searchInput.addEventListener('input', updateSearchClear);

    document.getElementById('searchClearBtn').addEventListener('click', () => {
        searchInput.value = '';
        updateSearchClear();
        searchInput.focus();
        if (state.activeView === 'search') {
            loadHomeMovies(true);
        }
    });

    // Hero Controls
    document.getElementById('heroPrevBtn').addEventListener('click', () => {
        renderHeroSlide(state.heroIndex - 1, true);
        startHeroAutoplay();
    });
    document.getElementById('heroNextBtn').addEventListener('click', () => {
        renderHeroSlide(state.heroIndex + 1, true);
        startHeroAutoplay();
    });
    document.getElementById('heroDots').addEventListener('click', (e) => {
        const dot = e.target.closest('.hero-dot');
        if (dot) {
            renderHeroSlide(Number(dot.dataset.heroIdx), true);
            startHeroAutoplay();
        }
    });

    // Season grouping toggle
    const groupSeasonsBtn = document.getElementById('groupSeasonsBtn');
    groupSeasonsBtn.addEventListener('click', () => {
        state.groupSeasons = !state.groupSeasons;
        groupSeasonsBtn.classList.toggle('active', state.groupSeasons);
        renderMovieGrid(state.movies);
        showToast(
            state.groupSeasons ? 'Đã bật gom nhóm các mùa phim' : 'Đã tắt gom nhóm, hiển thị từng mùa riêng',
            'fa-layer-group'
        );
    });

    // Sort chips
    document.querySelectorAll('.chip-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            state.sortMode = btn.dataset.sort;
            document.querySelectorAll('.chip-btn').forEach(b => b.classList.toggle('active', b === btn));
            renderMovieGrid(state.movies);
        });
    });

    // Grid density toggle
    const grid = document.getElementById('movieContainer');
    document.getElementById('gridNormalBtn').addEventListener('click', () => {
        state.compactGrid = false;
        grid.classList.remove('compact');
        document.getElementById('gridNormalBtn').classList.add('active');
        document.getElementById('gridCompactBtn').classList.remove('active');
    });
    document.getElementById('gridCompactBtn').addEventListener('click', () => {
        state.compactGrid = true;
        grid.classList.add('compact');
        document.getElementById('gridCompactBtn').classList.add('active');
        document.getElementById('gridNormalBtn').classList.remove('active');
    });

    // Load more & Retry
    document.getElementById('loadMoreBtn').addEventListener('click', () => loadHomeMovies(false));
    document.getElementById('retryFetchBtn').addEventListener('click', () => {
        if (state.activeView === 'search') performSearch(state.previousQuery);
        else loadHomeMovies(state.movies.length === 0);
    });

    // Clear history
    document.getElementById('clearHistoryQuickBtn').addEventListener('click', clearHistory);

    // Detail View controls
    document.getElementById('backBtn').addEventListener('click', goBackToPreviousList);
    document.getElementById('detailFavBtn').addEventListener('click', () => {
        if (state.currentMovie) toggleFavorite(state.currentMovie);
    });
    document.getElementById('detailShareBtn').addEventListener('click', copyShareText);

    document.getElementById('watchNowBtn').addEventListener('click', () => {
        document.getElementById('playerSection').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    document.getElementById('scrollEpisodesBtn').addEventListener('click', () => {
        document.getElementById('episodesSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    document.getElementById('synopsisToggleBtn').addEventListener('click', () => {
        const desc = document.getElementById('detailDescription');
        const clamped = desc.classList.toggle('clamped');
        document.getElementById('synopsisToggleBtn').innerHTML = clamped
            ? 'Xem thêm <i class="fas fa-chevron-down"></i>'
            : 'Thu gọn <i class="fas fa-chevron-up"></i>';
    });

    // Player controls
    document.getElementById('prevEpBtn').addEventListener('click', () => {
        if (state.currentEpisodeIndex > 0) playEpisodeByIndex(state.currentEpisodeIndex - 1, false);
    });
    document.getElementById('nextEpBtn').addEventListener('click', () => {
        const items = getActiveServerEpisodes();
        if (state.currentEpisodeIndex < items.length - 1) playEpisodeByIndex(state.currentEpisodeIndex + 1, false);
    });
    document.getElementById('reloadPlayerBtn').addEventListener('click', () => {
        const frame = document.getElementById('videoFrame');
        const currentSrc = frame.src;
        if (currentSrc) {
            frame.src = '';
            setTimeout(() => { frame.src = currentSrc; }, 120);
            showToast('Đang tải lại trình phát...', 'fa-rotate');
        }
    });
    document.getElementById('lightsOffBtn').addEventListener('click', toggleLightsOff);
    document.getElementById('theaterBackdrop').addEventListener('click', exitLightsOff);

    // Episode filter
    document.getElementById('epSearchInput').addEventListener('input', (e) => {
        state.episodeFilter = e.target.value;
        renderEpisodeGrid();
    });

    // Scroll effects (Header glass & Back-to-Top)
    const header = document.getElementById('mainHeader');
    const scrollTopBtn = document.getElementById('scrollTopBtn');
    window.addEventListener('scroll', () => {
        const y = window.scrollY;
        header.classList.toggle('scrolled', y > 24);
        scrollTopBtn.hidden = y < 420;
    }, { passive: true });

    scrollTopBtn.addEventListener('click', () => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        const tag = document.activeElement?.tagName;
        if (e.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA') {
            e.preventDefault();
            searchInput.focus();
        } else if (e.key === 'Escape') {
            if (document.body.classList.contains('lights-off')) {
                exitLightsOff();
            } else if (state.activeView === 'detail') {
                goBackToPreviousList();
            } else if (tag === 'INPUT') {
                document.activeElement.blur();
            }
        }
    });
}

window.addEventListener('DOMContentLoaded', () => {
    loadUserData();
    bindEvents();
    loadHomeMovies(true);
});
