/**
 * catalog-filter.js — client-side sort/filter engine for the psychic
 * catalog (archive-psychic.php, taxonomy-psychic_specialty.php,
 * taxonomy-psychic_skill.php).
 *
 * Progressive enhancement, no build step, no libraries:
 *  - On load with NO recognised query params, the server-rendered grid is
 *    left completely untouched until the visitor's first interaction with
 *    a toolbar control. Only then do we fetch the index (if not already
 *    in flight/cached) and swap in the JS-owned grid.
 *  - On load WITH recognised query params, we apply them immediately.
 *  - This is safe because the server's own default archive order (see
 *    inc/cpt-psychic.php's bpr_psychic_posts_per_page(), which orders by
 *    the precomputed `_bpr_rank` postmeta when there is no ?sort= param)
 *    is built from the SAME rating/review-count values, via the SAME
 *    3-level rule, as this file's own default order (see compareTopRated
 *    below) -- rating desc, review-volume tie-break, zero-review advisors
 *    pushed after every reviewed advisor. The two are numerically
 *    identical by construction, so there is no order-flash to prevent by
 *    swapping the grid on a bare pageview, and deferring the swap avoids
 *    the ~354 KB index.json fetch + a visible content swap on every plain
 *    archive pageview (these are SEO landing pages).
 *  - If the index can never be loaded (404 / network / 8s timeout), the
 *    server-rendered grid + its WordPress pagination are left fully
 *    functional and the toolbar's controls are disabled with a short
 *    inline message. The page must never end up blank or stuck mid-swap.
 *
 * Vanilla JS only.
 */
(function () {
    'use strict';

    // Idempotent guard. This file is designed to ALSO be concatenated
    // straight onto catalog.js for the "self-bootstrap" rollout (see
    // below) -- if that combined bundle ever ends up on a page twice
    // (a bad cache, a manual double-include), don't wire everything up
    // and re-fetch the index a second time.
    if (window.__BPR_CATALOG_FILTER_LOADED__) {
        return;
    }
    window.__BPR_CATALOG_FILTER_LOADED__ = true;

    var PARAM_KEYS = ['q', 'sort', 'rating', 'pmin', 'pmax', 'online', 'sp', 'sk', 'lg', 'tl', 'yrs', 'pg'];
    var FETCH_TIMEOUT_MS = 8000;
    var CATALOG_INDEX_PATH = '/wp-content/uploads/catalog/index.json';
    var SPECIALTY_MIN_COUNT = 25; // hide niche/junk specialty terms from the picker

    /* ── self-bootstrap ─────────────────────────────────────────────
     * Already-deployed static exports carry the card grid + WordPress
     * pagination markup but predate the PHP toolbar and its
     * #bpr-catalog-config block (this script used to bail out entirely
     * whenever those were missing). Since a full re-export of those
     * sites is impractical, this file can now also build the toolbar
     * itself from nothing but the DOM + the URL, so shipping just the
     * concatenated JS/CSS + index.json retrofits the feature onto a
     * page that was never rendered with it.
     *
     * Detection is deliberately conservative: recognise exactly the
     * catalog URL shapes this theme produces, and require an actual
     * card grid on the page. Anything else bails out silently and
     * touches nothing, per the same "do no harm" contract the PHP
     * toolbar's absence used to guarantee implicitly.
     */

    function detectPathContext() {
        var path = window.location.pathname || '/';
        // Strip an optional trailing WP pagination segment, e.g.
        // "/specialty/love/page/2/" -> "/specialty/love/".
        var stripped = path.match(/^(.*\/)page\/\d+\/?$/);
        var base = stripped ? stripped[1] : path;
        if (base.charAt(base.length - 1) !== '/') base += '/';

        var m = base.match(/^\/specialty\/([^\/]+)\/$/);
        if (m) return { tax: 'psychic_specialty', term: m[1] };

        m = base.match(/^\/skill\/([^\/]+)\/$/);
        if (m) return { tax: 'psychic_skill', term: m[1] };

        if (base === '/psychics/') return { tax: null, term: null };

        return null;
    }

    function readServerRenderedTotal() {
        var el = document.querySelector('.catalog-topbar__count');
        if (!el) return 0;
        var m = /([\d,]+)/.exec(el.textContent || '');
        if (!m) return 0;
        return parseInt(m[1].replace(/,/g, ''), 10) || 0;
    }

    // Mirrors template-parts/catalog-toolbar.php's markup: same ids and
    // classes, so every function below this point genuinely cannot tell
    // whether the toolbar was server-rendered or built here.
    function bootstrapToolbarMarkup(ctx) {
        var showSpecialty = ctx.tax !== 'psychic_specialty';
        var showSkill = ctx.tax !== 'psychic_skill';
        return '' +
            '<div class="catalog-toolbar" id="bpr-cf-toolbar" data-state="server">' +
            '<div class="catalog-toolbar__bar">' +
            '<input type="text" id="bpr-cf-search" class="catalog-toolbar__search" placeholder="Search by name&hellip;" aria-label="Search psychics by name" autocomplete="off">' +
            '<select id="bpr-cf-sort" class="catalog-toolbar__sort" aria-label="Sort psychics">' +
            '<option value="rating">Top Rated</option>' +
            '<option value="reviews">Most Reviews</option>' +
            '<option value="readings">Most Readings</option>' +
            '<option value="price_low">Price: Low to High</option>' +
            '<option value="price_high">Price: High to Low</option>' +
            '<option value="name">Name A-Z</option>' +
            '</select>' +
            '<button type="button" id="bpr-cf-toggle" class="catalog-toolbar__toggle" aria-expanded="false" aria-controls="bpr-cf-panel"><span>Filters</span></button>' +
            '</div>' +
            '<div class="catalog-toolbar__panel" id="bpr-cf-panel">' +
            '<div class="catalog-toolbar__group"><span class="catalog-toolbar__label">Minimum Rating</span>' +
            '<div class="chip-row" id="bpr-cf-rating" role="group" aria-label="Minimum rating">' +
            '<button type="button" class="filter-chip filter-chip--active" data-value="0">Any</button>' +
            '<button type="button" class="filter-chip" data-value="4">4.0+</button>' +
            '<button type="button" class="filter-chip" data-value="4.5">4.5+</button>' +
            '<button type="button" class="filter-chip" data-value="5">5.0</button>' +
            '</div></div>' +
            '<div class="catalog-toolbar__group"><span class="catalog-toolbar__label">Price per Minute</span>' +
            '<div class="chip-row" id="bpr-cf-price-presets" role="group" aria-label="Price range presets">' +
            '<button type="button" class="filter-chip filter-chip--active" data-min="" data-max="">Any</button>' +
            '<button type="button" class="filter-chip" data-min="" data-max="3">Under $3</button>' +
            '<button type="button" class="filter-chip" data-min="3" data-max="5">$3 &ndash; $5</button>' +
            '<button type="button" class="filter-chip" data-min="5" data-max="10">$5 &ndash; $10</button>' +
            '<button type="button" class="filter-chip" data-min="10" data-max="">$10+</button>' +
            '</div>' +
            '<div class="catalog-toolbar__price-inputs">' +
            '<input type="number" id="bpr-cf-pmin" min="0" step="0.5" placeholder="Min $" aria-label="Minimum price per minute">' +
            '<span class="catalog-toolbar__price-sep">&ndash;</span>' +
            '<input type="number" id="bpr-cf-pmax" min="0" step="0.5" placeholder="Max $" aria-label="Maximum price per minute">' +
            '</div></div>' +
            '<div class="catalog-toolbar__group"><span class="catalog-toolbar__label">Availability</span>' +
            '<button type="button" id="bpr-cf-online" class="filter-toggle" aria-pressed="false"><span class="filter-toggle__dot"></span> Online Now</button>' +
            '</div>' +
            '<div class="catalog-toolbar__group"><label class="catalog-toolbar__label" for="bpr-cf-yrs">Min. Years Experience</label>' +
            '<input type="number" id="bpr-cf-yrs" min="0" step="1" placeholder="Any" aria-label="Minimum years of experience"></div>' +
            (showSpecialty ?
                '<div class="catalog-toolbar__group"><label class="catalog-toolbar__label" for="bpr-cf-specialty">Specialties</label>' +
                '<input type="text" id="bpr-cf-specialty-filter" class="catalog-toolbar__type-filter" placeholder="Type to filter&hellip;" aria-label="Filter the specialty list">' +
                '<select id="bpr-cf-specialty" class="catalog-toolbar__multiselect" multiple aria-label="Filter by specialty" size="5"></select></div>' : '') +
            (showSkill ?
                '<div class="catalog-toolbar__group"><label class="catalog-toolbar__label" for="bpr-cf-skill">Skills</label>' +
                '<select id="bpr-cf-skill" class="catalog-toolbar__multiselect" multiple aria-label="Filter by skill" size="5"></select></div>' : '') +
            '<div class="catalog-toolbar__group"><label class="catalog-toolbar__label" for="bpr-cf-lang">Language</label>' +
            '<select id="bpr-cf-lang" aria-label="Filter by language"><option value="">Any language</option></select></div>' +
            '<div class="catalog-toolbar__group"><label class="catalog-toolbar__label" for="bpr-cf-tool">Tool Used</label>' +
            '<select id="bpr-cf-tool" aria-label="Filter by tool used"><option value="">Any tool</option></select></div>' +
            '<button type="button" id="bpr-cf-reset" class="btn btn--ghost btn--sm catalog-toolbar__reset">Reset All</button>' +
            '</div>' +
            '<div class="catalog-toolbar__active" id="bpr-cf-active" aria-hidden="true"></div>' +
            '<div class="catalog-toolbar__status">' +
            '<span id="bpr-cf-count" aria-live="polite"></span>' +
            '<span id="bpr-cf-msg" class="catalog-toolbar__msg" role="status"></span>' +
            '</div>' +
            '</div>';
    }

    function selfBootstrap(gridEl) {
        var ctx = detectPathContext();
        if (!ctx) return null;

        var total = readServerRenderedTotal();
        var wrapper = document.createElement('div');
        wrapper.innerHTML = bootstrapToolbarMarkup(ctx);
        var toolbarEl = wrapper.firstElementChild;
        gridEl.parentNode.insertBefore(toolbarEl, gridEl);

        var countEl = toolbarEl.querySelector('#bpr-cf-count');
        if (countEl && total) {
            countEl.textContent = fmtNum(total) + (total === 1 ? ' advisor' : ' advisors');
        }

        return {
            root: toolbarEl,
            cfg: {
                indexUrl: window.location.origin + CATALOG_INDEX_PATH,
                tax: ctx.tax,
                term: ctx.term,
                perPage: 24,
                total: total
            }
        };
    }

    /* ── boot-time mode resolution ──────────────────────────────────
     * Enhanced: the PHP toolbar + config block are already there (fresh
     * render / a future export once this ships in the theme).
     * Self-bootstrap: neither exists -- build them per above.
     * Neither applies: not a catalog page, or no grid -- do nothing.
     */

    var grid = document.querySelector('.psychic-grid');
    if (!grid) {
        return; // No card grid anywhere on this page -- nothing to do.
    }

    var root = document.getElementById('bpr-cf-toolbar');
    var configEl = document.getElementById('bpr-catalog-config');
    var cfg;

    if (root && configEl) {
        try {
            cfg = JSON.parse(configEl.textContent || configEl.innerText || '{}');
        } catch (e) {
            return;
        }
    } else {
        var bootstrapped = selfBootstrap(grid);
        if (!bootstrapped) {
            return; // Not a recognised catalog page -- change nothing.
        }
        root = bootstrapped.root;
        cfg = bootstrapped.cfg;
    }
    cfg.perPage = cfg.perPage || 24;

    var gridParent = grid.parentNode;
    var serverPagination = document.querySelector('.catalog-pagination');
    var topbarCount = document.querySelector('.catalog-topbar__count');

    var els = {
        search: document.getElementById('bpr-cf-search'),
        sort: document.getElementById('bpr-cf-sort'),
        toggle: document.getElementById('bpr-cf-toggle'),
        panel: document.getElementById('bpr-cf-panel'),
        ratingRow: document.getElementById('bpr-cf-rating'),
        pricePresets: document.getElementById('bpr-cf-price-presets'),
        pmin: document.getElementById('bpr-cf-pmin'),
        pmax: document.getElementById('bpr-cf-pmax'),
        online: document.getElementById('bpr-cf-online'),
        yrs: document.getElementById('bpr-cf-yrs'),
        specialty: document.getElementById('bpr-cf-specialty'),
        specialtyFilter: document.getElementById('bpr-cf-specialty-filter'),
        skill: document.getElementById('bpr-cf-skill'),
        lang: document.getElementById('bpr-cf-lang'),
        tool: document.getElementById('bpr-cf-tool'),
        reset: document.getElementById('bpr-cf-reset'),
        active: document.getElementById('bpr-cf-active'),
        count: document.getElementById('bpr-cf-count'),
        msg: document.getElementById('bpr-cf-msg')
    };

    /* ── small utils ─────────────────────────────────────────────── */

    function escHtml(s) {
        s = (s === null || s === undefined) ? '' : String(s);
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function fmtNum(n) {
        n = Number(n) || 0;
        return n.toLocaleString('en-US');
    }

    function initialOf(title) {
        var t = (title || '').trim();
        return t ? t.charAt(0).toUpperCase() : '?';
    }

    // Mirrors inc/template-tags.php::bpr_stars_precise() markup exactly,
    // including its non-unique per-card gradient ids (a pre-existing
    // quirk of the PHP helper, reproduced here for visual parity).
    function starsPreciseHtml(rating) {
        rating = Number(rating) || 0;
        var full = Math.floor(rating);
        var html = '<span class="stars-precise">';
        for (var i = 1; i <= 5; i++) {
            if (i <= full) {
                html += '<svg class="star star--full" viewBox="0 0 20 20" fill="currentColor"><path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z"/></svg>';
            } else if (i - rating < 1 && i - rating > 0) {
                var pct = Math.round((rating - full) * 100);
                html += '<svg class="star star--partial" viewBox="0 0 20 20"><defs><linearGradient id="half' + i + '"><stop offset="' + pct + '%" stop-color="var(--clr-accent)"/><stop offset="' + pct + '%" stop-color="var(--clr-border)"/></linearGradient></defs><path fill="url(#half' + i + ')" d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z"/></svg>';
            } else {
                html += '<svg class="star star--empty" viewBox="0 0 20 20" fill="currentColor"><path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z"/></svg>';
            }
        }
        html += '</span>';
        return html;
    }

    // Mirrors inc/template-tags.php::bpr_price_tag().
    function priceTagHtml(price) {
        price = Number(price) || 0;
        if (!price) {
            return '<span class="price-tag price-tag--na">N/A</span>';
        }
        return '<span class="price-tag">$' + price.toFixed(2) + '/min</span>';
    }

    /* ── record indices (schema: see inc/catalog-index.php) ───────── */
    var F = { SLUG: 0, TITLE: 1, RATING: 2, NRATINGS: 3, NREADINGS: 4, PRICE: 5, ONLINE: 6, YEARS: 7, IMG: 8, SP: 9, SK: 10, LG: 11, TL: 12 };

    function cardHtml(rec, data) {
        var title = rec[F.TITLE];
        var img = rec[F.IMG];
        var imgSrc = null;
        if (typeof img === 'number' && img > 0) {
            imgSrc = data.ib + img + '.jpg';
        } else if (typeof img === 'string' && img) {
            imgSrc = img;
        }

        var photoHtml;
        if (imgSrc) {
            photoHtml = '<img src="' + escHtml(imgSrc) + '" alt="' + escHtml(title) + '" loading="lazy" data-initial="' + escHtml(initialOf(title)) + '">';
        } else {
            photoHtml = '<div class="psychic-card__avatar">' + escHtml(initialOf(title)) + '</div>';
        }
        var statusHtml = rec[F.ONLINE] ? '<span class="psychic-card__status psychic-card__status--online"></span>' : '';

        var tagIds = rec[F.SP].slice(0, 3);
        var tagsHtml = '';
        if (tagIds.length) {
            tagsHtml = '<div class="psychic-card__tags">' + tagIds.map(function (idx) {
                var t = data.sp[idx];
                return t ? '<span class="tag">' + escHtml(t[1]) + '</span>' : '';
            }).join('') + '</div>';
        }

        var reviewsHtml = rec[F.NRATINGS] ? '<span class="psychic-card__reviews">(' + fmtNum(rec[F.NRATINGS]) + ')</span>' : '';
        var readingsHtml = rec[F.NREADINGS] ? '<span class="psychic-card__readings">' + fmtNum(rec[F.NREADINGS]) + ' readings</span>' : '';
        var scoreText = rec[F.RATING] ? rec[F.RATING].toFixed(1) : '—';
        var permalink = data.pb + rec[F.SLUG] + '/';

        return '' +
            '<article class="psychic-card" style="opacity:1;transform:translateY(0)">' +
            '<a href="' + escHtml(permalink) + '" class="psychic-card__link">' +
            '<div class="psychic-card__photo">' + photoHtml + statusHtml + '</div>' +
            '<div class="psychic-card__body">' +
            '<h3 class="psychic-card__name">' + escHtml(title) + '</h3>' +
            '<div class="psychic-card__rating">' + starsPreciseHtml(rec[F.RATING]) +
            '<span class="psychic-card__score">' + scoreText + '</span>' + reviewsHtml + '</div>' +
            tagsHtml +
            '<div class="psychic-card__footer">' + priceTagHtml(rec[F.PRICE]) + readingsHtml + '</div>' +
            '</div></a></article>';
    }

    /* ── state ──────────────────────────────────────────────────── */

    var state = {
        q: '', sort: 'rating', rating: 0, pmin: null, pmax: null,
        online: false, sp: [], sk: [], lg: '', tl: '', yrs: 0, pg: 1
    };

    function parseParamsFromUrl() {
        var sp = new URLSearchParams(window.location.search);
        var found = false;
        PARAM_KEYS.forEach(function (k) { if (sp.has(k)) found = true; });
        if (!found) return null;

        var out = {
            q: sp.get('q') || '',
            sort: sp.get('sort') || 'rating',
            rating: parseFloat(sp.get('rating')) || 0,
            pmin: sp.get('pmin') !== null && sp.get('pmin') !== '' ? parseFloat(sp.get('pmin')) : null,
            pmax: sp.get('pmax') !== null && sp.get('pmax') !== '' ? parseFloat(sp.get('pmax')) : null,
            online: sp.get('online') === '1',
            sp: sp.get('sp') ? sp.get('sp').split(',').filter(Boolean) : [],
            sk: sp.get('sk') ? sp.get('sk').split(',').filter(Boolean) : [],
            lg: sp.get('lg') || '',
            tl: sp.get('tl') || '',
            yrs: parseInt(sp.get('yrs'), 10) || 0,
            pg: parseInt(sp.get('pg'), 10) || 1
        };
        return out;
    }

    function syncUrl() {
        var sp = new URLSearchParams();
        if (state.q) sp.set('q', state.q);
        if (state.sort && state.sort !== 'rating') sp.set('sort', state.sort);
        if (state.rating) sp.set('rating', String(state.rating));
        if (state.pmin !== null) sp.set('pmin', String(state.pmin));
        if (state.pmax !== null) sp.set('pmax', String(state.pmax));
        if (state.online) sp.set('online', '1');
        if (state.sp.length) sp.set('sp', state.sp.join(','));
        if (state.sk.length) sp.set('sk', state.sk.join(','));
        if (state.lg) sp.set('lg', state.lg);
        if (state.tl) sp.set('tl', state.tl);
        if (state.yrs) sp.set('yrs', String(state.yrs));
        if (state.pg && state.pg > 1) sp.set('pg', String(state.pg));

        var qs = sp.toString();
        var newUrl = window.location.pathname + (qs ? '?' + qs : '') + window.location.hash;
        history.replaceState(null, '', newUrl);
    }

    /* ── data loading ───────────────────────────────────────────── */

    var dataPromise = null;

    function loadData() {
        if (dataPromise) return dataPromise;

        var controller = ('AbortController' in window) ? new AbortController() : null;
        var timeoutId = controller ? setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS) : null;

        dataPromise = fetch(cfg.indexUrl, { credentials: 'same-origin', signal: controller ? controller.signal : undefined })
            .then(function (res) {
                if (timeoutId) clearTimeout(timeoutId);
                if (!res.ok) throw new Error('bad status ' + res.status);
                return res.json();
            })
            .then(function (data) {
                if (!data || !Array.isArray(data.p) || !Array.isArray(data.sp) || !Array.isArray(data.sk)) {
                    throw new Error('malformed index');
                }
                return data;
            })
            .catch(function (err) {
                if (timeoutId) clearTimeout(timeoutId);
                disableToolbar();
                throw err;
            });

        return dataPromise;
    }

    function disableToolbar() {
        root.classList.add('catalog-toolbar--disabled');
        var controls = root.querySelectorAll('input, select, button');
        controls.forEach(function (el) {
            if (el === els.toggle) return; // keep the mobile expand/collapse usable
            el.disabled = true;
        });
        if (els.msg) {
            els.msg.textContent = 'Filters are temporarily unavailable — showing the default list below.';
        }
    }

    /* ── option list population (scoped to the current tax/term) ─── */

    function populateOptions(data) {
        var base = scopedRecords(data);

        if (els.specialty) {
            // Sites carry thousands of specialty terms, most with a
            // handful of posts (scraped junk) -- a multi-select with
            // thousands of options is unusable, so anything under the
            // threshold is hidden from the picker entirely (it's still a
            // valid taxonomy term, just not offered as a filter).
            var spCounts = collectIds(base, F.SP);
            fillMultiSelect(els.specialty, data.sp, spCounts, SPECIALTY_MIN_COUNT);
            hideGroupIfEmpty(els.specialty, Object.keys(spCounts).length > 0);
        }
        if (els.skill) {
            // Skills only number ~10-16 network-wide, so every one that's
            // actually present in scope is kept -- no threshold, just the
            // same count-desc ordering + "(N)" label as specialties.
            var skCounts = collectIds(base, F.SK);
            fillMultiSelect(els.skill, data.sk, skCounts, 0);
            // Fix 3 follow-up: on some term scopes (e.g. the "love"
            // specialty -- verified via DB: 0 of its 944 advisors carry
            // ANY psychic_skill term) not a single in-scope record has a
            // skill at all. An empty multiselect with nothing pickable is
            // exactly the "filter that can only return nothing" case this
            // pass targets, so hide the whole group instead of showing a
            // dead, empty box.
            hideGroupIfEmpty(els.skill, Object.keys(skCounts).length > 0);
        }
        if (els.lang) {
            var lgSeen = collectIds(base, F.LG);
            fillSingleSelect(els.lang, data.lg, lgSeen, 'Any language');
            hideGroupIfEmpty(els.lang, Object.keys(lgSeen).length > 0);
        }
        if (els.tool) {
            var tlSeen = collectIds(base, F.TL);
            fillSingleSelect(els.tool, data.tl, tlSeen, 'Any tool');
            hideGroupIfEmpty(els.tool, Object.keys(tlSeen).length > 0);
        }
    }

    // Hides the whole `.catalog-toolbar__group` a control lives in when
    // that control has nothing real to offer in the current scope, rather
    // than leaving a label + empty/single-placeholder control visible.
    function hideGroupIfEmpty(controlEl, hasOptions) {
        var group = controlEl.closest ? controlEl.closest('.catalog-toolbar__group') : null;
        if (!group) return;
        group.classList.toggle('cf-facet-hidden', !hasOptions);
    }

    // Returns idx -> count of records IN THE PASSED ARRAY that carry that
    // specialty/skill/language/tool. Used both for populating pickers
    // (counts double as "does this idx appear at all" presence checks --
    // an idx with count 0 never shows up as a key) and, when `records` is
    // scopedRecords(data), for the scope-aware picker counts (Fix 3).
    function collectIds(records, field) {
        var counts = {};
        for (var i = 0; i < records.length; i++) {
            var ids = records[i][field];
            for (var j = 0; j < ids.length; j++) {
                counts[ids[j]] = (counts[ids[j]] || 0) + 1;
            }
        }
        return counts;
    }

    // `pairs` entries are [slug, name, globalPublishedCount] (index-wide).
    // `countsByIdx` (from collectIds over the CURRENT scope) drives both
    // the displayed "(N)" and the most-common-first ordering -- so the
    // picker always reflects "how many results in THIS view", not a
    // network-wide total that may not even be reachable from here (Fix 3:
    // facet counts must be scope-aware, not global). When the page has no
    // term scope, scopedRecords(data) === data.p, so this is numerically
    // identical to the old global-count behaviour. `minCount` (0 = no
    // threshold) still drops rare/junk terms from the list, now judged
    // against that same scope count. An idx never appears in `countsByIdx`
    // unless it actually occurs in scope, so a listed option can never
    // resolve to zero results if picked.
    function fillMultiSelect(selectEl, pairs, countsByIdx, minCount) {
        minCount = minCount || 0;
        var frag = document.createDocumentFragment();
        var entries = [];
        Object.keys(countsByIdx).forEach(function (idx) {
            var pair = pairs[idx];
            if (!pair) return;
            var count = countsByIdx[idx];
            if (minCount && count < minCount) return;
            entries.push({ slug: pair[0], name: pair[1], count: count });
        });
        entries.sort(function (a, b) {
            if (b.count !== a.count) return b.count - a.count;
            return a.name.localeCompare(b.name);
        });
        entries.forEach(function (e) {
            var opt = document.createElement('option');
            opt.value = e.slug;
            opt.textContent = e.name + ' (' + fmtNum(e.count) + ')';
            frag.appendChild(opt);
        });
        selectEl.innerHTML = '';
        selectEl.appendChild(frag);
    }

    function fillSingleSelect(selectEl, values, seenIdx, placeholder) {
        var frag = document.createDocumentFragment();
        var first = document.createElement('option');
        first.value = '';
        first.textContent = placeholder;
        frag.appendChild(first);

        var names = Object.keys(seenIdx).map(function (idx) { return values[idx]; }).filter(Boolean);
        names.sort(function (a, b) { return a.localeCompare(b); });
        names.forEach(function (name) {
            var opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            frag.appendChild(opt);
        });
        selectEl.innerHTML = '';
        selectEl.appendChild(frag);
    }

    /* ── scoping / filtering / sorting ─────────────────────────────*/

    var scopedCache = null;

    function scopedRecords(data) {
        if (scopedCache) return scopedCache;
        if (!cfg.tax || !cfg.term) {
            scopedCache = data.p;
            return scopedCache;
        }
        var list = cfg.tax === 'psychic_specialty' ? data.sp : data.sk;
        var field = cfg.tax === 'psychic_specialty' ? F.SP : F.SK;
        var termIdx = -1;
        for (var i = 0; i < list.length; i++) {
            if (list[i][0] === cfg.term) { termIdx = i; break; }
        }
        if (termIdx === -1) {
            scopedCache = [];
            return scopedCache;
        }
        scopedCache = data.p.filter(function (rec) { return rec[field].indexOf(termIdx) !== -1; });
        return scopedCache;
    }

    function applyFilters(data) {
        var base = scopedRecords(data);
        var q = state.q.trim().toLowerCase();

        var langIdx = -1, toolIdx = -1;
        if (state.lg) langIdx = data.lg.indexOf(state.lg);
        if (state.tl) toolIdx = data.tl.indexOf(state.tl);

        var spSlugs = {}, skSlugs = {};
        state.sp.forEach(function (s) { spSlugs[s] = true; });
        state.sk.forEach(function (s) { skSlugs[s] = true; });
        var spIdxSet = state.sp.length ? slugsToIndices(data.sp, spSlugs) : null;
        var skIdxSet = state.sk.length ? slugsToIndices(data.sk, skSlugs) : null;

        return base.filter(function (rec) {
            if (q && rec[F.TITLE].toLowerCase().indexOf(q) === -1) return false;
            if (state.rating && rec[F.RATING] < state.rating) return false;
            // A price of 0 means "no price on file" (63% of the catalog),
            // never a genuine free reading -- it must not satisfy any
            // specific price band/bound (e.g. "Under $3"). Only the "Any"
            // preset (pmin === pmax === null) is exempt.
            if ((state.pmin !== null || state.pmax !== null) && !rec[F.PRICE]) return false;
            if (state.pmin !== null && rec[F.PRICE] < state.pmin) return false;
            if (state.pmax !== null && rec[F.PRICE] > state.pmax) return false;
            if (state.online && !rec[F.ONLINE]) return false;
            if (state.yrs && rec[F.YEARS] < state.yrs) return false;
            if (spIdxSet && !anyIn(rec[F.SP], spIdxSet)) return false;
            if (skIdxSet && !anyIn(rec[F.SK], skIdxSet)) return false;
            if (langIdx !== -1 && rec[F.LG].indexOf(langIdx) === -1) return false;
            if (toolIdx !== -1 && rec[F.TL].indexOf(toolIdx) === -1) return false;
            return true;
        });
    }

    function slugsToIndices(pairs, slugSet) {
        var out = {};
        for (var i = 0; i < pairs.length; i++) {
            if (slugSet[pairs[i][0]]) out[i] = true;
        }
        return out;
    }

    function anyIn(ids, idxSet) {
        for (var i = 0; i < ids.length; i++) if (idxSet[ids[i]]) return true;
        return false;
    }

    /* ── facet counts (Fix 3: never offer a filter that returns nothing) ─
     * One cheap pass over the SCOPED array (a specialty term, a skill
     * term, or the whole archive -- never the live search/filter
     * selections, which is what keeps this stable while typing: it is
     * computed once, right after the index loads, and cached for the
     * rest of the page's life instead of being recomputed on every
     * render()). Drives: hiding/disabling the "Online Now" toggle, and
     * annotating + disabling zero-count price-band/rating-threshold
     * chips. Mirrors applyFilters()'s own semantics (esp. the
     * unknown-price exclusion) so a displayed count always matches what
     * clicking that option actually returns.
     */

    var PRICE_BAND_DEFS = [
        { min: null, max: null },  // Any
        { min: null, max: 3 },     // Under $3
        { min: 3, max: 5 },        // $3 - $5
        { min: 5, max: 10 },       // $5 - $10
        { min: 10, max: null }     // $10+
    ];
    var RATING_THRESHOLDS = [0, 4, 4.5, 5];

    var facetCache = null;

    function computeFacetCounts(data) {
        if (facetCache) return facetCache;
        var base = scopedRecords(data);

        var priceCounts = PRICE_BAND_DEFS.map(function () { return 0; });
        var ratingCounts = RATING_THRESHOLDS.map(function () { return 0; });
        var onlineCount = 0;

        for (var i = 0; i < base.length; i++) {
            var rec = base[i];
            var price = rec[F.PRICE];
            var rating = rec[F.RATING];

            if (rec[F.ONLINE]) onlineCount++;

            for (var p = 0; p < PRICE_BAND_DEFS.length; p++) {
                var band = PRICE_BAND_DEFS[p];
                if (band.min === null && band.max === null) { priceCounts[p]++; continue; }
                if (!price) continue; // unknown price never satisfies a real band
                if (band.min !== null && price < band.min) continue;
                if (band.max !== null && price > band.max) continue;
                priceCounts[p]++;
            }

            for (var r = 0; r < RATING_THRESHOLDS.length; r++) {
                if (rating >= RATING_THRESHOLDS[r]) ratingCounts[r]++;
            }
        }

        facetCache = { total: base.length, online: onlineCount, price: priceCounts, rating: ratingCounts };
        return facetCache;
    }

    function decorateFacets(data) {
        var facets = computeFacetCounts(data);

        if (els.online) {
            var group = els.online.closest ? els.online.closest('.catalog-toolbar__group') : null;
            if (facets.online === 0) {
                if (group) {
                    group.classList.add('cf-facet-hidden');
                } else {
                    els.online.disabled = true;
                }
            }
        }

        if (els.ratingRow) {
            Array.prototype.forEach.call(els.ratingRow.querySelectorAll('.filter-chip'), function (btn) {
                var val = parseFloat(btn.dataset.value) || 0;
                var idx = RATING_THRESHOLDS.indexOf(val);
                var count = idx !== -1 ? facets.rating[idx] : facets.total;
                annotateChipCount(btn, count, val === 0);
            });
        }

        if (els.pricePresets) {
            Array.prototype.forEach.call(els.pricePresets.querySelectorAll('.filter-chip'), function (btn) {
                var bmin = btn.dataset.min === '' ? null : parseFloat(btn.dataset.min);
                var bmax = btn.dataset.max === '' ? null : parseFloat(btn.dataset.max);
                var idx = -1;
                for (var i = 0; i < PRICE_BAND_DEFS.length; i++) {
                    if (PRICE_BAND_DEFS[i].min === bmin && PRICE_BAND_DEFS[i].max === bmax) { idx = i; break; }
                }
                var count = idx !== -1 ? facets.price[idx] : facets.total;
                annotateChipCount(btn, count, bmin === null && bmax === null);
            });
        }
    }

    // Appends "(N)" to a chip's original label (captured once, so repeat
    // calls stay idempotent) and disables it when it would return zero
    // results -- except the "Any"/no-op option, which is never disabled.
    function annotateChipCount(btn, count, isAnyOption) {
        if (!btn.dataset.cfBaseLabel) btn.dataset.cfBaseLabel = btn.textContent;
        btn.textContent = btn.dataset.cfBaseLabel + ' (' + fmtNum(count) + ')';
        var unavailable = count === 0 && !isAnyOption;
        btn.disabled = unavailable;
        btn.classList.toggle('filter-chip--unavailable', unavailable);
    }

    // A price of 0 means "no price on file" (63% of the catalog has no
    // real _price_per_minute), never a genuinely free reading -- it must
    // never look like the cheapest option, in EITHER sort direction. Both
    // comparators push unknown-price records to the very end; only their
    // primary comparison (ascending vs descending) differs.
    function comparePriceAsc(a, b) {
        var pa = a[F.PRICE], pb = b[F.PRICE];
        var ua = !pa, ub = !pb;
        if (ua !== ub) return ua ? 1 : -1;
        return pa - pb;
    }
    function comparePriceDesc(a, b) {
        var pa = a[F.PRICE], pb = b[F.PRICE];
        var ua = !pa, ub = !pb;
        if (ua !== ub) return ua ? 1 : -1; // unknown still sorts last, even "high to low"
        return pb - pa;
    }

    // "Top Rated" (also the default/unfiltered order) ranks by rating, but
    // a 5.0 with zero reviews is UNRANKED -- it never outranks anyone with
    // at least one real review, regardless of its stored rating value.
    // Among reviewed advisors, review COUNT breaks a rating tie, so a 5.0
    // with one review no longer sits above a 5.0 with ten thousand.
    function compareTopRated(a, b) {
        var za = a[F.NRATINGS] === 0, zb = b[F.NRATINGS] === 0;
        if (za !== zb) return za ? 1 : -1;
        if (b[F.RATING] !== a[F.RATING]) return b[F.RATING] - a[F.RATING];
        return b[F.NRATINGS] - a[F.NRATINGS];
    }

    function sortRecords(list) {
        var sorted = list.slice();
        switch (state.sort) {
            case 'reviews':
                sorted.sort(function (a, b) { return b[F.NRATINGS] - a[F.NRATINGS]; });
                break;
            case 'readings':
                sorted.sort(function (a, b) { return b[F.NREADINGS] - a[F.NREADINGS]; });
                break;
            case 'price_low':
                sorted.sort(comparePriceAsc);
                break;
            case 'price_high':
                sorted.sort(comparePriceDesc);
                break;
            case 'name':
                sorted.sort(function (a, b) { return a[F.TITLE].localeCompare(b[F.TITLE]); });
                break;
            default: // rating ("Top Rated") -- also state's initial default
                sorted.sort(compareTopRated);
                break;
        }
        return sorted;
    }

    /* ── active-filter chips ───────────────────────────────────── */

    function activeFilterDescriptors(data) {
        var out = [];
        if (state.q) out.push({ key: 'q', label: 'Search: "' + state.q + '"' });
        if (state.rating) out.push({ key: 'rating', label: 'Rating ' + state.rating + '+' });
        if (state.pmin !== null || state.pmax !== null) {
            var lbl = 'Price ' + (state.pmin !== null ? '$' + state.pmin : '$0') + '–' + (state.pmax !== null ? '$' + state.pmax : '+');
            out.push({ key: 'price', label: lbl });
        }
        if (state.online) out.push({ key: 'online', label: 'Online now' });
        if (state.yrs) out.push({ key: 'yrs', label: state.yrs + '+ yrs experience' });
        state.sp.forEach(function (slug) {
            var pair = data.sp.filter(function (p) { return p[0] === slug; })[0];
            out.push({ key: 'sp:' + slug, label: pair ? pair[1] : slug });
        });
        state.sk.forEach(function (slug) {
            var pair = data.sk.filter(function (p) { return p[0] === slug; })[0];
            out.push({ key: 'sk:' + slug, label: pair ? pair[1] : slug });
        });
        if (state.lg) out.push({ key: 'lg', label: state.lg });
        if (state.tl) out.push({ key: 'tl', label: state.tl });
        return out;
    }

    function removeFilter(key) {
        if (key === 'q') { state.q = ''; if (els.search) els.search.value = ''; }
        else if (key === 'rating') { state.rating = 0; setActiveChip(els.ratingRow, '0'); }
        else if (key === 'price') {
            state.pmin = null; state.pmax = null;
            if (els.pmin) els.pmin.value = ''; if (els.pmax) els.pmax.value = '';
            setActiveChip(els.pricePresets, null);
        } else if (key === 'online') {
            state.online = false;
            if (els.online) els.online.setAttribute('aria-pressed', 'false');
        } else if (key === 'yrs') {
            state.yrs = 0; if (els.yrs) els.yrs.value = '';
        } else if (key.indexOf('sp:') === 0) {
            var spSlug = key.slice(3);
            state.sp = state.sp.filter(function (s) { return s !== spSlug; });
            unselectOption(els.specialty, spSlug);
        } else if (key.indexOf('sk:') === 0) {
            var skSlug = key.slice(3);
            state.sk = state.sk.filter(function (s) { return s !== skSlug; });
            unselectOption(els.skill, skSlug);
        } else if (key === 'lg') { state.lg = ''; if (els.lang) els.lang.value = ''; }
        else if (key === 'tl') { state.tl = ''; if (els.tool) els.tool.value = ''; }
        state.pg = 1;
        render();
    }

    function unselectOption(selectEl, value) {
        if (!selectEl) return;
        Array.prototype.forEach.call(selectEl.options, function (o) {
            if (o.value === value) o.selected = false;
        });
    }

    function setActiveChip(rowEl, value) {
        if (!rowEl) return;
        Array.prototype.forEach.call(rowEl.querySelectorAll('.filter-chip'), function (btn) {
            var isMatch = value === null
                ? (btn.dataset.min === '' && btn.dataset.max === '')
                : btn.dataset.value === value;
            btn.classList.toggle('filter-chip--active', isMatch);
        });
    }

    /* ── rendering ─────────────────────────────────────────────── */

    var loadedData = null;

    function render() {
        if (!loadedData) return;
        var data = loadedData;

        var filtered = applyFilters(data);
        var sorted = sortRecords(filtered);
        var totalPages = Math.max(1, Math.ceil(sorted.length / cfg.perPage));
        if (state.pg > totalPages) state.pg = totalPages;
        if (state.pg < 1) state.pg = 1;

        var startIdx = (state.pg - 1) * cfg.perPage;
        var pageRecords = sorted.slice(startIdx, startIdx + cfg.perPage);

        if (grid) {
            if (pageRecords.length) {
                grid.innerHTML = pageRecords.map(function (r) { return cardHtml(r, data); }).join('');
                grid.style.display = '';
                var emptyState = gridParent ? gridParent.querySelector('.cf-empty-state') : null;
                if (emptyState) emptyState.remove();
            } else {
                grid.innerHTML = '';
                grid.style.display = 'none';
                renderEmptyState();
            }
        }

        renderPagination(totalPages);
        renderActiveChips(data);

        if (els.count) {
            els.count.textContent = fmtNum(sorted.length) + (sorted.length === 1 ? ' advisor' : ' advisors');
        }
        if (topbarCount) {
            topbarCount.textContent = fmtNum(sorted.length) + (sorted.length === 1 ? ' psychic' : ' psychics');
        }

        syncUrl();
    }

    function renderEmptyState() {
        if (!gridParent) return;
        if (gridParent.querySelector('.cf-empty-state')) return;
        var div = document.createElement('div');
        div.className = 'catalog-empty cf-empty-state';
        div.innerHTML = '<p>No psychics found matching your criteria.</p>' +
            '<button type="button" class="btn btn--ghost" id="bpr-cf-empty-reset">Reset All Filters</button>';
        gridParent.appendChild(div);
        var btn = div.querySelector('#bpr-cf-empty-reset');
        if (btn) btn.addEventListener('click', resetAll);
    }

    function renderPagination(totalPages) {
        var container = document.querySelector('.cf-pagination-mount') || serverPagination;
        if (!container) return;
        container.classList.add('catalog-pagination', 'cf-pagination');

        if (totalPages <= 1) {
            container.innerHTML = '';
            return;
        }

        var current = state.pg;
        var pages = paginationWindow(current, totalPages);
        var html = '<ul>';
        html += '<li><button type="button" class="cf-page-btn" data-page="' + (current - 1) + '"' + (current <= 1 ? ' disabled' : '') + '>&larr; Prev</button></li>';
        pages.forEach(function (p) {
            if (p === '...') {
                html += '<li><span>&hellip;</span></li>';
            } else {
                html += '<li><button type="button" class="cf-page-btn' + (p === current ? ' current' : '') + '" data-page="' + p + '"' + (p === current ? ' aria-current="page"' : '') + '>' + p + '</button></li>';
            }
        });
        html += '<li><button type="button" class="cf-page-btn" data-page="' + (current + 1) + '"' + (current >= totalPages ? ' disabled' : '') + '>Next &rarr;</button></li>';
        html += '</ul>';
        container.innerHTML = html;

        Array.prototype.forEach.call(container.querySelectorAll('.cf-page-btn'), function (btn) {
            btn.addEventListener('click', function () {
                var target = parseInt(btn.dataset.page, 10);
                if (!target || target < 1 || target > totalPages || target === state.pg) return;
                state.pg = target;
                render();
                var hero = document.querySelector('.catalog-hero');
                if (hero) hero.scrollIntoView({ behavior: 'smooth' });
            });
        });
    }

    function paginationWindow(current, total) {
        if (total <= 7) {
            var all = [];
            for (var i = 1; i <= total; i++) all.push(i);
            return all;
        }
        var pages = [1];
        if (current > 3) pages.push('...');
        for (var p = Math.max(2, current - 1); p <= Math.min(total - 1, current + 1); p++) pages.push(p);
        if (current < total - 2) pages.push('...');
        pages.push(total);
        return pages;
    }

    function renderActiveChips(data) {
        if (!els.active) return;
        var descriptors = activeFilterDescriptors(data);
        if (!descriptors.length) {
            els.active.innerHTML = '';
            els.active.setAttribute('aria-hidden', 'true');
            return;
        }
        els.active.setAttribute('aria-hidden', 'false');
        els.active.innerHTML = descriptors.map(function (d) {
            return '<span class="active-filters__chip">' + escHtml(d.label) +
                '<button type="button" class="active-filters__remove" data-key="' + escHtml(d.key) + '" aria-label="Remove filter">&times;</button></span>';
        }).join('');
        Array.prototype.forEach.call(els.active.querySelectorAll('.active-filters__remove'), function (btn) {
            btn.addEventListener('click', function () { removeFilter(btn.dataset.key); });
        });
    }

    /* ── first-swap / boot ─────────────────────────────────────── */

    var jsOwnsGrid = false;

    function ensureJsOwnsGrid() {
        if (jsOwnsGrid) return Promise.resolve();
        jsOwnsGrid = true;
        root.dataset.state = 'js';
        return loadData().then(function (data) {
            loadedData = data;
            populateOptions(data);
            decorateFacets(data); // Fix 3 -- one-time, scope-based, before first render
            applySelectionsToControls();
            render();
        }).catch(function () {
            jsOwnsGrid = false; // stay on the server grid
            root.dataset.state = 'server';
        });
    }

    function applySelectionsToControls() {
        if (els.search) els.search.value = state.q;
        if (els.sort) els.sort.value = state.sort;
        setActiveChip(els.ratingRow, String(state.rating));
        if (state.pmin === null && state.pmax === null) {
            setActiveChip(els.pricePresets, null);
        } else {
            var matched = false;
            if (els.pricePresets) {
                Array.prototype.forEach.call(els.pricePresets.querySelectorAll('.filter-chip'), function (btn) {
                    var bmin = btn.dataset.min === '' ? null : parseFloat(btn.dataset.min);
                    var bmax = btn.dataset.max === '' ? null : parseFloat(btn.dataset.max);
                    var isMatch = bmin === state.pmin && bmax === state.pmax;
                    btn.classList.toggle('filter-chip--active', isMatch);
                    if (isMatch) matched = true;
                });
            }
            if (!matched && els.pricePresets) setActiveChip(els.pricePresets, '__none__');
        }
        if (els.pmin) els.pmin.value = state.pmin !== null ? state.pmin : '';
        if (els.pmax) els.pmax.value = state.pmax !== null ? state.pmax : '';
        if (els.online) els.online.setAttribute('aria-pressed', state.online ? 'true' : 'false');
        if (els.yrs) els.yrs.value = state.yrs || '';
        if (els.specialty) {
            Array.prototype.forEach.call(els.specialty.options, function (o) { o.selected = state.sp.indexOf(o.value) !== -1; });
        }
        if (els.skill) {
            Array.prototype.forEach.call(els.skill.options, function (o) { o.selected = state.sk.indexOf(o.value) !== -1; });
        }
        if (els.lang) els.lang.value = state.lg;
        if (els.tool) els.tool.value = state.tl;
    }

    function resetAll() {
        state = { q: '', sort: 'rating', rating: 0, pmin: null, pmax: null, online: false, sp: [], sk: [], lg: '', tl: '', yrs: 0, pg: 1 };
        applySelectionsToControls();
        render();
    }

    /* ── event wiring ──────────────────────────────────────────── */

    function onFirstInteraction(mutate) {
        return function () {
            mutate();
            state.pg = 1;
            ensureJsOwnsGrid().then(function () {
                if (jsOwnsGrid) render();
            });
        };
    }

    function wireEvents() {
        if (els.toggle && els.panel) {
            els.toggle.addEventListener('click', function () {
                var open = els.panel.classList.toggle('catalog-toolbar__panel--open');
                els.toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
            });
        }

        if (els.search) {
            els.search.addEventListener('input', debounce(function () {
                var mutate = function () { state.q = els.search.value; };
                if (jsOwnsGrid) { mutate(); state.pg = 1; render(); }
                else onFirstInteraction(mutate)();
            }, 200));
        }
        if (els.sort) {
            els.sort.addEventListener('change', bindControl(function () { state.sort = els.sort.value; }));
        }
        if (els.ratingRow) {
            bindChipRow(els.ratingRow, function (btn) {
                state.rating = parseFloat(btn.dataset.value) || 0;
                setActiveChip(els.ratingRow, btn.dataset.value);
            });
        }
        if (els.pricePresets) {
            bindChipRow(els.pricePresets, function (btn) {
                state.pmin = btn.dataset.min === '' ? null : parseFloat(btn.dataset.min);
                state.pmax = btn.dataset.max === '' ? null : parseFloat(btn.dataset.max);
                setActiveChip(els.pricePresets, null);
                btn.classList.add('filter-chip--active');
                if (els.pmin) els.pmin.value = state.pmin !== null ? state.pmin : '';
                if (els.pmax) els.pmax.value = state.pmax !== null ? state.pmax : '';
            });
        }
        if (els.pmin) {
            els.pmin.addEventListener('input', debounce(bindControl(function () {
                state.pmin = els.pmin.value !== '' ? parseFloat(els.pmin.value) : null;
                setActiveChip(els.pricePresets, '__none__');
            }), 250));
        }
        if (els.pmax) {
            els.pmax.addEventListener('input', debounce(bindControl(function () {
                state.pmax = els.pmax.value !== '' ? parseFloat(els.pmax.value) : null;
                setActiveChip(els.pricePresets, '__none__');
            }), 250));
        }
        if (els.online) {
            els.online.addEventListener('click', bindControl(function () {
                state.online = !state.online;
                els.online.setAttribute('aria-pressed', state.online ? 'true' : 'false');
            }));
        }
        if (els.yrs) {
            els.yrs.addEventListener('input', debounce(bindControl(function () {
                state.yrs = parseInt(els.yrs.value, 10) || 0;
            }), 250));
        }
        if (els.specialty) {
            els.specialty.addEventListener('change', bindControl(function () {
                state.sp = Array.prototype.filter.call(els.specialty.options, function (o) { return o.selected; }).map(function (o) { return o.value; });
            }));
        }
        if (els.specialtyFilter && els.specialty) {
            // Type-to-filter over the (already count-limited) specialty
            // list -- narrows which <option> elements are visible without
            // touching which ones are selected.
            els.specialtyFilter.addEventListener('input', debounce(function () {
                var q = els.specialtyFilter.value.trim().toLowerCase();
                Array.prototype.forEach.call(els.specialty.options, function (o) {
                    var match = !q || o.textContent.toLowerCase().indexOf(q) !== -1;
                    o.classList.toggle('cf-option--hidden', !match);
                });
            }, 150));
        }
        if (els.skill) {
            els.skill.addEventListener('change', bindControl(function () {
                state.sk = Array.prototype.filter.call(els.skill.options, function (o) { return o.selected; }).map(function (o) { return o.value; });
            }));
        }
        if (els.lang) {
            els.lang.addEventListener('change', bindControl(function () { state.lg = els.lang.value; }));
        }
        if (els.tool) {
            els.tool.addEventListener('change', bindControl(function () { state.tl = els.tool.value; }));
        }
        if (els.reset) {
            els.reset.addEventListener('click', function () {
                if (!jsOwnsGrid) { ensureJsOwnsGrid().then(function () { if (jsOwnsGrid) resetAll(); }); return; }
                resetAll();
            });
        }

        wireDeadSortLinks();
    }

    // Older already-deployed pages have sidebar links like
    // <a href="?sort=price_low">Price: Low to High</a> left over from
    // before this toolbar existed. On a static host the query string is
    // just ignored, so clicking one used to do nothing at all -- the
    // exact bug this whole feature exists to fix. Any surviving link
    // like that gets hijacked: prevent the navigation, apply the sort
    // client-side, and reflect it in the real toolbar control. The sort
    // values in those old hrefs ('reviews', 'price_low', 'price_high',
    // 'name') already match this file's own state.sort vocabulary
    // one-for-one, so no translation table is needed.
    function wireDeadSortLinks() {
        var links = document.querySelectorAll('a[href*="?sort="]');
        if (!links.length) return;
        Array.prototype.forEach.call(links, function (a) {
            a.addEventListener('click', function (e) {
                var href = a.getAttribute('href') || '';
                var qIdx = href.indexOf('?');
                if (qIdx === -1) return;
                var sp = new URLSearchParams(href.slice(qIdx));
                var sortVal = sp.get('sort');
                if (!sortVal) return;
                e.preventDefault();
                state.sort = sortVal;
                state.pg = 1;
                if (els.sort) els.sort.value = sortVal;
                if (jsOwnsGrid) { render(); return; }
                ensureJsOwnsGrid().then(function () {
                    if (jsOwnsGrid) { applySelectionsToControls(); render(); }
                });
            });
        });
    }

    function bindControl(mutateFn) {
        return function () {
            mutateFn();
            state.pg = 1;
            if (jsOwnsGrid) { render(); return; }
            ensureJsOwnsGrid();
        };
    }

    function bindChipRow(rowEl, onPick) {
        rowEl.addEventListener('click', function (e) {
            var btn = e.target.closest ? e.target.closest('.filter-chip') : null;
            if (!btn || !rowEl.contains(btn)) return;
            onPick(btn);
            state.pg = 1;
            if (jsOwnsGrid) { render(); return; }
            ensureJsOwnsGrid();
        });
    }

    function debounce(fn, ms) {
        var t = null;
        return function () {
            var args = arguments;
            clearTimeout(t);
            t = setTimeout(function () { fn.apply(null, args); }, ms);
        };
    }

    /* ── boot ──────────────────────────────────────────────────── */

    function boot() {
        // Kick off the fetch right away (matches the <link rel=preload>
        // hint in wp_head) so it's already in flight/cached by the time
        // of the visitor's first interaction -- but whether we ever
        // *render* it depends on the URL (see the file-header note: the
        // server's default order already matches this file's own default
        // order, so there is nothing to fix by swapping the grid here).
        loadData().catch(function () { /* handled by disableToolbar() */ });

        var urlState = parseParamsFromUrl();
        wireEvents();

        if (urlState) {
            state = urlState;
            ensureJsOwnsGrid().then(function () {
                if (jsOwnsGrid) {
                    applySelectionsToControls();
                    render();
                }
            });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
